// ─── Traffic report: every page-view number on the admin dashboard ─────
// dev-request 2026-10-13-statistikk-riktig-for-investorer (A2A), S1.
//
// The dashboard used to compute each card and panel with its own query and its
// own idea of a page view, a visitor and a bot, so the numbers did not add up
// and several of them counted static files, redirects and crawlers. This module
// reads the window's page views ONCE, classifies every visitor ONCE and derives
// every number from that, so by construction:
//
//   totals.views = groups.human.views + groups.ai_search.views
//                + groups.ai_crawler.views + groups.bot.views + groups.dev.views
//
// and the same holds for visitors and visits.
//
// Definitions (the labels on the dashboard must match these):
//   page view  page-view-definition.ts: a page (no file extension, not /mcp or
//              /a2a, not the offline fallback) answered 2xx or 304.
//   visitor    one session_id in the window: a salted IP hash plus the browser
//              (sessionIdFor in analytics-service.ts). Unique per IP and
//              browser over the whole window, so one person on two devices,
//              or on a phone that changes IP, counts more than once.
//   visit      a run of page views by one visitor with no gap over 30 minutes
//              (the Google Analytics session rule). Visits never cross the
//              window start: rows before the window are not read.
//   class      the visitor's client class (write-time client_class, else the
//              session_id), turned into 'scanner' when the visitor probed
//              wp-admin/.env-style paths in the window, and into 'scraper'
//              when a browser-looking visitor read pages faster than a person
//              can (isVelocityScraper). Owner traffic (is_owner = 1) is left
//              out of every number and reported on its own.
//
// Pure: takes the DB handle and the clock, no database/init import, so it runs
// in the off-thread stats worker (admin-stats-compute.ts runAdminStatsQuery)
// as well as on the main thread. Throws on SQL errors.

import type Database from "better-sqlite3";
import type { VerticalId } from "./analytics-service";
import {
  addAiAgentViews,
  AI_AGENT_TOKEN_ALTERNATION,
  aiVendorBucket,
  emptyAiAgents,
  isVelocityScraper,
  SCANNER_PATH_PATTERNS,
  SCRAPER_PRODUSENT_PAGES_PER_HOUR,
  SCRAPER_UNIQUE_PAGES_PER_10_MIN,
  storedClientClass,
  uaFromSessionId,
  type AiAgents,
  type ClientClass,
  type SessionCategory,
} from "./traffic-classifier";
import { isPagePath, isPageViewStatus, isScannerProbePath } from "./page-view-definition";
import { classifyReferralSource } from "./human-referrals";

type Db = Database.Database;

/** A visit ends after this much inactivity (Google Analytics' default). */
export const VISIT_GAP_MS = 30 * 60 * 1000;

/** Hourly series up to a week, daily beyond. */
export const HOURLY_SERIES_MAX_HOURS = 168;

/** Dashboard groups. 'bot' = search_engine, seo_bot, social, other_bot, scanner and scraper. */
export type TrafficGroup = "human" | "ai_search" | "ai_crawler" | "bot" | "dev";
export const TRAFFIC_GROUPS: readonly TrafficGroup[] = ["human", "ai_search", "ai_crawler", "bot", "dev"];

export const VISITOR_CLASSES: readonly SessionCategory[] = [
  "human", "ai_search", "ai_crawler", "search_engine", "seo_bot", "social", "dev", "other_bot", "scanner", "scraper",
];

export function groupOf(cls: SessionCategory): TrafficGroup {
  if (cls === "human" || cls === "ai_search" || cls === "ai_crawler" || cls === "dev") return cls;
  return "bot";
}

export interface Totals {
  views: number;
  visitors: number;
  visits: number;
}

export type Device = "mobile" | "tablet" | "desktop" | "unknown";

export interface SessionRow {
  /** First 8 hex chars of the salted IP hash: enough to tell rows apart, not to identify anyone. */
  id: string;
  cls: SessionCategory;
  group: TrafficGroup;
  device: Device | "bot";
  /** Named bot (non-human sessions only), e.g. "Googlebot". */
  name?: string;
  /** The stored user agent (non-human sessions whose session_id keeps the raw UA). */
  ua?: string;
  views: number;
  uniquePages: number;
  visits: number;
  firstSeen: string;
  lastSeen: string;
  /** Entry source of the session's first visit (classifyReferralSource key). */
  entrySource: string;
}

export interface TrafficReport {
  version: 1;
  window: { hours: number; from: string; to: string; vertical: VerticalId | "all" };
  /** Oldest stored page-view row; the report covers [max(from, oldest), to]. */
  coverage: { oldestRow: string | null; complete: boolean };
  totals: Totals;
  groups: Record<TrafficGroup, Totals>;
  classes: Record<SessionCategory, Totals>;
  /** Page views by AI vendor, over ai_search + ai_crawler. */
  aiVendors: { chatgpt: number; claude: number; other: number };
  /** The same AI page views split by vendor × purpose (AI_AGENT_REGISTRY). chatgpt/claude sum to aiVendors.chatgpt/claude; perplexity + google + other sum to aiVendors.other. */
  aiAgents: AiAgents;
  /**
   * Owner traffic, excluded from everything above: the _rfb_owner cookie
   * (cookieViews), our own scripts (scriptViews), and older rows that cannot
   * be told apart (unknownViews).
   */
  owner: { views: number; cookieViews: number; scriptViews: number; unknownViews: number };
  human: {
    devices: Record<Device, Totals>;
    /** Where human visits came from (entry referrer of each visit). */
    entrySources: Array<{ key: string; label: string; visits: number; visitors: number }>;
    /** External referrer hosts of human visits (own domains excluded). */
    referrers: Array<{ host: string; key: string; label: string; visits: number; visitors: number }>;
    /** Sum of human visit lengths in seconds, and visits with one page view (additive across days). */
    visitSeconds: number;
    singleViewVisits: number;
    /** Mean visit length in seconds (single-page visits count as 0). */
    avgVisitSeconds: number;
    pagesPerVisit: number;
    /** Share of visits with one page view, 0–1. */
    bounceRate: number;
    topSessions: SessionRow[];
  };
  series: {
    unit: "hour" | "day";
    /** UTC bucket starts, 'YYYY-MM-DD HH:00' or 'YYYY-MM-DD', zero-filled over the window. */
    points: Array<{ t: string; views: number; humanViews: number; aiViews: number; botViews: number; visitors: number; humanVisitors: number }>;
  };
  topPages: Array<{ path: string; views: number; humanViews: number; aiViews: number; botViews: number; visitors: number; humanVisitors: number }>;
  /** Named non-human clients (AI and bots), by views. */
  bots: Array<{ name: string; group: TrafficGroup; cls: SessionCategory; views: number; visitors: number; sampleUa: string | null }>;
  /** Raw UA samples of bots with no recognisable name. */
  otherUaSamples: Array<{ ua: string; views: number }>;
  /** Most recently active visitors of every class (up to 200). */
  recentSessions: SessionRow[];
  /**
   * Only with opts.reclassified: [session_id, class] for each session not
   * classed human here whose rows a row-by-row reader could take for a
   * person's (stored class human, or a browser-looking session_id).
   */
  reclassifiedSessions?: Array<[string, SessionCategory]>;
  /** Visitors of every class with the most page views (up to 200). */
  busiestSessions: SessionRow[];
}

// ── Small helpers ──────────────────────────────────────────────────────

function sqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function parseTs(s: string): number {
  // Stored as 'YYYY-MM-DD HH:MM:SS' (UTC). Tolerate a 'T' and a missing time.
  const iso = s.length <= 10 ? `${s}T00:00:00Z` : `${s.replace(" ", "T")}${s.endsWith("Z") ? "" : "Z"}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

/** parseTs for the row scan: the minute is parsed once per minute, the seconds by hand. */
function createTsParser(): (s: string) => number {
  let lastMinute = "";
  let lastBase = NaN;
  return (s: string) => {
    if (s.length !== 19 || s.charCodeAt(16) !== 58 /* ':' */) return parseTs(s);
    const minute = s.slice(0, 16);
    if (minute !== lastMinute) {
      lastMinute = minute;
      lastBase = parseTs(`${minute}:00`);
    }
    const sec = (s.charCodeAt(17) - 48) * 10 + (s.charCodeAt(18) - 48);
    return sec >= 0 && sec < 60 ? lastBase + sec * 1000 : parseTs(s);
  };
}

function emptyTotals(): Totals {
  return { views: 0, visitors: 0, visits: 0 };
}

function hasColumn(db: Db, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
  } catch {
    return false;
  }
}

function indexHint(db: Db, vertical?: VerticalId): string {
  const name = vertical ? "idx_analytics_page_views_vertical" : "idx_analytics_page_views_created";
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ? AND tbl_name = 'analytics_page_views'")
    .get(name) as { ok: number } | undefined;
  return row ? ` INDEXED BY ${name}` : "";
}

/** Device of a session: the human device bucket, else derived from a raw UA. */
export function deviceForSession(sessionId: string): Device {
  const rest = sessionId.includes(":") ? sessionId.split(":").slice(1).join(":") : "";
  const first = rest.includes(":") ? rest.slice(0, rest.indexOf(":")) : rest;
  if (first === "mobile" || first === "tablet" || first === "desktop") return first;
  const lower = rest.toLowerCase();
  if (lower.includes("ipad") || lower.includes("tablet")) return "tablet";
  if (lower.includes("mobile") || lower.includes("iphone") || lower.includes("android")) return "mobile";
  if (lower.includes("mozilla") || lower.includes("chrome") || lower.includes("safari") || lower.includes("firefox") || lower.includes("edg/")) return "desktop";
  return "unknown";
}

/** AI agents come from AI_AGENT_REGISTRY (one table); the rest are non-AI bots. */
const KNOWN_BOT_NAME_RE = new RegExp(`(${AI_AGENT_TOKEN_ALTERNATION}|MJ12bot|serpstatbot|Googlebot|DuckDuckBot|Applebot|Chiark|Dataprovider|BingPreview|bingbot|facebookexternalhit|facebookexternal|Twitterbot|YandexBot|PetalBot|SemrushBot|AhrefsBot|DotBot|BLEXBot|MojeekBot|SeekportBot|LinkedInBot|Slackbot|TelegramBot|WhatsApp|ImagesiftBot|Diffbot|Baiduspider|DataForSeoBot|AwarioBot)`, "i");

/** Readable name of a bot UA ("Googlebot", "facebookexternalhit", …). */
export function botNameForUA(ua: string): string {
  const known = ua.match(KNOWN_BOT_NAME_RE);
  if (known) return known[1];
  const generic = ua.match(/([A-Za-z][A-Za-z0-9_-]*(?:Bot|Crawler|Spider|bot|crawler|spider))/);
  if (generic) return generic[1];
  const slash = ua.match(/^([A-Za-z][A-Za-z0-9_.-]+)\//);
  if (slash && !/^(Mozilla|compatible)$/i.test(slash[1])) return slash[1];
  return ua.trim() ? "Ukjent" : "Tom user-agent";
}

/**
 * The raw UA kept in a session_id, or "" when the session_id holds only a
 * browser's device bucket and hash (sessionIdFor: every browser-looking UA).
 */
export function rawUaOfSession(sessionId: string): string {
  const ua = uaFromSessionId(sessionId);
  return isBucketedUa(ua) ? "" : ua;
}

function isBucketedUa(ua: string): boolean {
  // sessionIdFor: `${ipHash}:${bucket}:${hash16}` for every browser-looking UA.
  return /^(mobile|tablet|desktop):[0-9a-z]+$/i.test(ua);
}

/** Label for a non-human session whose UA is a browser's (scanners and scrapers behind a normal-looking UA). */
const BROWSER_UA_NAME: Partial<Record<SessionCategory, string>> = {
  scanner: "Skanner med nettleser-UA",
  scraper: "Skraper med nettleser-UA",
};

function sessionBotName(sessionId: string, cls: SessionCategory): string {
  const ua = uaFromSessionId(sessionId);
  if (isBucketedUa(ua)) return BROWSER_UA_NAME[cls] ?? "Nettleser-UA";
  return botNameForUA(ua);
}

function refHost(referrer: string): string {
  try {
    return new URL(referrer).hostname.replace(/^www\./, "") || "ukjent";
  } catch {
    // Never the raw string: it can carry a path or query, and hosts are kept
    // in the stored history (traffic-history-compute.ts).
    return "ukjent";
  }
}

class Interner {
  readonly values: string[] = [];
  private readonly ids = new Map<string, number>();
  id(s: string): number {
    let i = this.ids.get(s);
    if (i === undefined) {
      i = this.values.length;
      this.values.push(s);
      this.ids.set(s, i);
    }
    return i;
  }
}

// ── The report ─────────────────────────────────────────────────────────

const LIST_LIMIT = 30;
/** GET /admin/analytics/visitors takes limit ≤ 200, /pages limit ≤ 100. */
const SESSION_LIST_LIMIT = 200;
const TOP_PAGES_LIMIT = 100;

export interface TrafficReportOptions {
  /**
   * false = totals only (totals, groups, classes, aiVendors, owner, human
   * devices and visit quality): no per-row arrays are kept, and series,
   * topPages, entry sources, referrers, bots and the session lists come back
   * empty. Used by the public 60-day counters, which need only the totals.
   */
  detail?: boolean;
  /**
   * A fixed range [fromMs, toMs) instead of the trailing `hours` before
   * `nowMs` (one UTC day, ISO week or month for the stored history). Both or
   * neither.
   */
  fromMs?: number;
  toMs?: number;
  /** Length of topPages (default 100). */
  topPages?: number;
  /**
   * Also return `reclassifiedSessions`: the final class of each session whose
   * rows look like a person's one by one but which is not one in this window
   * (a scanner, a scraper, or a session whose older rows predate the
   * write-time class), for readers that classify rows one by one (the
   * umbrella table).
   */
  reclassified?: boolean;
}

export function computeTrafficReport(
  db: Db,
  hours: number,
  vertical: VerticalId | undefined,
  nowMs: number,
  opts: TrafficReportOptions = {},
): TrafficReport {
  const keepRows = opts.detail !== false;
  const ranged = opts.fromMs !== undefined && opts.toMs !== undefined;
  const fromMs = ranged ? opts.fromMs! : nowMs - hours * 3600_000;
  const endMs = ranged ? opts.toMs! : nowMs;
  const cutoff = sqliteDatetime(fromMs);
  // Live windows: (now - hours, now]. Fixed ranges: [from, to), so consecutive
  // days, weeks and months neither overlap nor leave a gap.
  const timeSql = ranged ? "created_at >= ? AND created_at < ?" : "created_at > ?";
  const tp: string[] = ranged ? [cutoff, sqliteDatetime(endMs)] : [cutoff];
  // Older and minimal (test) schemas lack some columns: read what exists.
  const has = (col: string) => hasColumn(db, "analytics_page_views", col);
  const hasVertical = has("vertical_id");
  const V = vertical && hasVertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical && hasVertical ? [vertical] : [];
  const col = (name: string) => (has(name) ? name : `NULL AS ${name}`);
  const statusCol = has("status_code") ? "status_code" : "NULL AS status_code";

  const oldestRow = ((db.prepare("SELECT MIN(created_at) AS m FROM analytics_page_views").get() as { m: string | null } | undefined)?.m) ?? null;

  // Sessions that probed scanner paths in the window (any status: the probes
  // themselves are not page views, but they tell a scanner from a person).
  // Filled during the scan below, read when the sessions are classified.
  const probeSessions = new Set<string>();

  // ── Pass 1: stream the window's page views in time order ──
  const sessions = new Interner();
  const paths = new Interner();
  const referrers = new Interner();
  // utm_source + utm_campaign of the landing, only for rows that carry one (-1 = none):
  // an AI UTM mark classifies a visit that has no referrer (classifyReferralSource).
  const utmMarks = new Interner();
  const utmOf = (u: number) => {
    if (u < 0) return undefined;
    const [utm_source, utm_campaign] = utmMarks.values[u]!.split("\u0000");
    return { utm_source, utm_campaign };
  };

  let cap = 1 << 14;
  let sIdx = new Int32Array(cap);
  let tsArr = new Float64Array(cap);
  let pIdx = new Int32Array(cap);
  let rIdx = new Int32Array(cap);
  let uIdx = new Int32Array(cap);
  let visitStart = new Uint8Array(cap);
  let n = 0;
  const grow = () => {
    cap *= 2;
    const s2 = new Int32Array(cap); s2.set(sIdx); sIdx = s2;
    const t2 = new Float64Array(cap); t2.set(tsArr); tsArr = t2;
    const p2 = new Int32Array(cap); p2.set(pIdx); pIdx = p2;
    const r2 = new Int32Array(cap); r2.set(rIdx); rIdx = r2;
    const u2 = new Int32Array(cap); u2.set(uIdx); uIdx = u2;
    const v2 = new Uint8Array(cap); v2.set(visitStart); visitStart = v2;
  };

  // Per-session state, indexed by session id.
  const sClass: Array<ClientClass> = [];
  const sLast: number[] = [];
  const sFirst: number[] = [];
  const sViews: number[] = [];
  const sVisits: number[] = [];
  const sVisitStartTs: number[] = [];
  const sVisitDurSum: number[] = [];
  const sVisitViews: number[] = [];
  const sSingleViewVisits: number[] = [];
  const sScraper: boolean[] = [];
  // Velocity tracking for browser-looking sessions only (the only ones that can turn into 'scraper').
  const velocity = new Map<number, Array<{ ts: number; p: number }>>();

  const owner = { views: 0, cookieViews: 0, scriptViews: 0, unknownViews: 0 };

  const closeVisit = (s: number) => {
    sVisitDurSum[s] += Math.max(0, sLast[s] - sVisitStartTs[s]);
    if (sVisitViews[s] === 1) sSingleViewVisits[s] += 1;
  };

  // One scan of every row in the window. The page-view rule is applied here
  // (isPagePath, memoised per path, + isPageViewStatus), not in SQL: the SQL
  // form (pageViewSql) runs string functions on every row and, with the probe
  // scan it replaces, made a 60-day report about 40 % slower.
  const rowStmt = db.prepare(`
    SELECT session_id, ${col("client_class")}, path, created_at, ${col("referrer")}, ${col("is_owner")}, ${statusCol}, ${col("utm_source")}, ${col("utm_campaign")}
    FROM analytics_page_views${indexHint(db, V ? vertical : undefined)}
    WHERE ${timeSql}${V}
    ORDER BY created_at
  `);
  // Per path: bit 1 = a page, bit 2 = a scanner probe, bit 4 = a /produsent/ page.
  const pathInfo = new Map<string, number>();
  const infoOf = (path: string): number => {
    let i = pathInfo.get(path);
    if (i === undefined) {
      i = (isPagePath(path) ? 1 : 0) | (isScannerProbePath(path) ? 2 : 0) | (path.includes("/produsent/") ? 4 : 0);
      pathInfo.set(path, i);
    }
    return i;
  };
  const produsentPath: boolean[] = [];
  const rowTs = createTsParser();

  // raw(): rows as arrays, not objects — ~1.5M rows for 60 days, so the
  // per-row allocation matters. Column order is the SELECT above.
  for (const r of rowStmt.raw(true).iterate(...tp, ...vp) as Iterable<[
    string | null, string | null, string, string, string | null, number | null, number | null, string | null, string | null,
  ]>) {
    const sid = r[0] ?? "";
    const clientClass = r[1];
    const path = r[2] ?? "";
    const info = infoOf(path);
    if (info & 2) probeSessions.add(sid);
    if (!(info & 1) || !isPageViewStatus(r[6])) continue;
    const ts = rowTs(r[3]);
    if (!Number.isFinite(ts)) continue;

    if (r[5] === 1) {
      // Owner = the _rfb_owner cookie (a person's browser) or a script UA
      // (isOwnerRequest). Since S1 the write path stores client_class 'dev' for
      // the script case; older rows can only be split when their session_id
      // still shows a non-browser UA.
      owner.views += 1;
      if (clientClass) {
        if (clientClass === "human") owner.cookieViews += 1;
        else owner.scriptViews += 1;
      } else if (storedClientClass(sid, null) !== "human") owner.scriptViews += 1;
      else owner.unknownViews += 1;
      continue;
    }

    const s = sessions.id(sid);
    if (s === sClass.length) {
      sClass.push(storedClientClass(sid, clientClass));
      sLast.push(ts); sFirst.push(ts); sViews.push(0); sVisits.push(0);
      sVisitStartTs.push(ts); sVisitDurSum.push(0); sVisitViews.push(0); sSingleViewVisits.push(0);
      sScraper.push(false);
    } else if (clientClass && clientClass !== sClass[s]) {
      // A class stored at write time (full UA) beats one recovered from the
      // session_id of an older row of the same session.
      sClass[s] = storedClientClass(sid, clientClass);
    }

    const p = paths.id(path);
    if (p === produsentPath.length) produsentPath.push((info & 4) !== 0);
    if (keepRows) {
      if (n === cap) grow();
      sIdx[n] = s;
      tsArr[n] = ts;
      pIdx[n] = p;
      const referrer = r[4];
      rIdx[n] = referrer && referrer.trim() ? referrers.id(referrer) : -1;
      uIdx[n] = r[7] || r[8] ? utmMarks.id(`${r[7] ?? ""}\u0000${r[8] ?? ""}`) : -1;
    }

    const isNewVisit = sViews[s] === 0 || ts - sLast[s] > VISIT_GAP_MS;
    if (isNewVisit) {
      if (sViews[s] > 0) closeVisit(s);
      sVisits[s] += 1;
      sVisitStartTs[s] = ts;
      sVisitViews[s] = 0;
      if (keepRows) visitStart[n] = 1;
    } else if (keepRows) {
      visitStart[n] = 0;
    }
    sVisitViews[s] += 1;
    sViews[s] += 1;
    sLast[s] = ts;
    if (keepRows) n += 1;

    // Velocity: trailing 10-minute distinct pages, trailing 60-minute distinct /produsent/ pages.
    if (sClass[s] === "human" && !sScraper[s]) {
      let q = velocity.get(s);
      if (!q) { q = []; velocity.set(s, q); }
      q.push({ ts, p });
      while (q.length && q[0].ts < ts - 3600_000) q.shift();
      const recent = new Set<number>();
      const produsent = new Set<number>();
      for (let i = q.length - 1; i >= 0; i--) {
        const e = q[i];
        if (e.ts >= ts - 600_000) recent.add(e.p);
        if (produsentPath[e.p]) produsent.add(e.p);
      }
      if (isVelocityScraper({ uniquePagesIn10Min: recent.size, produsentPagesInHour: produsent.size })) {
        sScraper[s] = true;
        velocity.delete(s);
      }
    }
  }
  for (let s = 0; s < sClass.length; s++) closeVisit(s);
  velocity.clear();

  // ── Classify sessions ──
  const sessionCount = sClass.length;
  const cls: SessionCategory[] = new Array(sessionCount);
  const ua: string[] = new Array(sessionCount);
  for (let s = 0; s < sessionCount; s++) {
    const sid = sessions.values[s];
    ua[s] = uaFromSessionId(sid);
    let c: SessionCategory = sClass[s];
    if (c === "human" && probeSessions.has(sid)) c = "scanner";
    else if (c === "human" && sScraper[s]) c = "scraper";
    cls[s] = c;
  }

  // ── Pass 2: aggregate rows by class ──
  const classes = Object.fromEntries(VISITOR_CLASSES.map((c) => [c, emptyTotals()])) as Record<SessionCategory, Totals>;
  const groups = Object.fromEntries(TRAFFIC_GROUPS.map((g) => [g, emptyTotals()])) as Record<TrafficGroup, Totals>;
  const totals = emptyTotals();
  const aiVendors = { chatgpt: 0, claude: 0, other: 0 };
  const aiAgents = emptyAiAgents();
  const devices: Record<Device, Totals> = { mobile: emptyTotals(), tablet: emptyTotals(), desktop: emptyTotals(), unknown: emptyTotals() };

  for (let s = 0; s < sessionCount; s++) {
    const c = cls[s];
    const g = groupOf(c);
    for (const t of [classes[c], groups[g], totals]) {
      t.views += sViews[s];
      t.visitors += 1;
      t.visits += sVisits[s];
    }
    if (g === "ai_search" || g === "ai_crawler") {
      aiVendors[aiVendorBucket(ua[s])] += sViews[s];
      addAiAgentViews(aiAgents, ua[s], g, sViews[s]);
    }
    if (c === "human") {
      const d = devices[deviceForSession(sessions.values[s])];
      d.views += sViews[s];
      d.visitors += 1;
      d.visits += sVisits[s];
    }
  }

  // Series buckets.
  const spanHours = (endMs - fromMs) / 3600_000;
  const unit: "hour" | "day" = spanHours <= HOURLY_SERIES_MAX_HOURS ? "hour" : "day";
  const bucketMs = unit === "hour" ? 3600_000 : 86_400_000;
  // The series starts at the first stored row when the window reaches further
  // back ("all" = 10 years would otherwise be 3,650 empty days).
  const oldestMs = oldestRow ? parseTs(oldestRow) : NaN;
  const lastMs = ranged ? endMs - 1 : endMs;
  // (A range that ends before the first stored row keeps its own buckets, all zero.)
  const seriesFromMs = Number.isFinite(oldestMs) && oldestMs > fromMs && oldestMs <= lastMs ? oldestMs : fromMs;
  const firstBucket = Math.floor(seriesFromMs / bucketMs) * bucketMs;
  const bucketCount = keepRows ? Math.max(1, Math.floor((lastMs - firstBucket) / bucketMs) + 1) : 0;
  const series = Array.from({ length: bucketCount }, (_, i) => {
    const iso = new Date(firstBucket + i * bucketMs).toISOString();
    return {
      t: unit === "hour" ? `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00` : iso.slice(0, 10),
      views: 0, humanViews: 0, aiViews: 0, botViews: 0, visitors: 0, humanVisitors: 0,
    };
  });
  const bucketSeen: Array<Set<number>> = series.map(() => new Set<number>());

  const pageViews = new Map<number, { views: number; humanViews: number; aiViews: number; botViews: number }>();
  const entry = new Map<string, { label: string; visits: number; visitors: Set<number> }>();
  const refHosts = new Map<string, { key: string; label: string; visits: number; visitors: Set<number> }>();

  for (let i = 0; i < n; i++) {
    const s = sIdx[i];
    const g = groupOf(cls[s]);
    const b = Math.min(bucketCount - 1, Math.max(0, Math.floor((tsArr[i] - firstBucket) / bucketMs)));
    const pt = series[b];
    pt.views += 1;
    if (g === "human") pt.humanViews += 1;
    else if (g === "ai_search" || g === "ai_crawler") pt.aiViews += 1;
    else pt.botViews += 1;
    if (!bucketSeen[b].has(s)) {
      bucketSeen[b].add(s);
      pt.visitors += 1;
      if (g === "human") pt.humanVisitors += 1;
    }

    let pv = pageViews.get(pIdx[i]);
    if (!pv) { pv = { views: 0, humanViews: 0, aiViews: 0, botViews: 0 }; pageViews.set(pIdx[i], pv); }
    pv.views += 1;
    if (g === "human") pv.humanViews += 1;
    else if (g === "ai_search" || g === "ai_crawler") pv.aiViews += 1;
    else pv.botViews += 1;

    if (g === "human" && visitStart[i]) {
      const referrer = rIdx[i] >= 0 ? referrers.values[rIdx[i]] : null;
      const src = classifyReferralSource(referrer, utmOf(uIdx[i]));
      // A visit that "starts" from one of our own pages is a person coming
      // back after more than 30 minutes: direct, not internal.
      const key = src.key === "intern" ? "direkte" : src.key;
      const label = src.key === "intern" ? "Direkte" : src.label;
      let e = entry.get(key);
      if (!e) { e = { label, visits: 0, visitors: new Set() }; entry.set(key, e); }
      e.visits += 1;
      e.visitors.add(s);
      if (referrer && key !== "direkte") {
        const host = refHost(referrer);
        let r = refHosts.get(host);
        if (!r) { r = { key, label, visits: 0, visitors: new Set() }; refHosts.set(host, r); }
        r.visits += 1;
        r.visitors.add(s);
      }
    }
  }

  // Top pages, with distinct visitors computed for the chosen paths only.
  const topPageIds = [...pageViews.entries()]
    .sort((a, b) => b[1].views - a[1].views || paths.values[a[0]].localeCompare(paths.values[b[0]]))
    .slice(0, opts.topPages ?? TOP_PAGES_LIMIT)
    .map(([p]) => p);
  const topSet = new Set(topPageIds);
  const pageVisitors = new Map<number, Set<number>>();
  const pageHumanVisitors = new Map<number, Set<number>>();
  for (const p of topPageIds) { pageVisitors.set(p, new Set()); pageHumanVisitors.set(p, new Set()); }

  // Distinct pages per session, for the listed sessions only.
  const humanTop = [...Array(keepRows ? sessionCount : 0).keys()]
    .filter((s) => cls[s] === "human")
    .sort((a, b) => sViews[b] - sViews[a] || sLast[b] - sLast[a])
    .slice(0, LIST_LIMIT);
  const recent = [...Array(keepRows ? sessionCount : 0).keys()]
    .sort((a, b) => sLast[b] - sLast[a] || sViews[b] - sViews[a])
    .slice(0, SESSION_LIST_LIMIT);
  const busiest = [...Array(keepRows ? sessionCount : 0).keys()]
    .sort((a, b) => sViews[b] - sViews[a] || sLast[b] - sLast[a])
    .slice(0, SESSION_LIST_LIMIT);
  const listed = new Set([...humanTop, ...recent, ...busiest]);
  const sessionPages = new Map<number, Set<number>>();
  const sessionEntry = new Map<number, string>();
  for (const s of listed) sessionPages.set(s, new Set());

  for (let i = 0; i < n; i++) {
    const s = sIdx[i];
    const p = pIdx[i];
    if (topSet.has(p)) {
      pageVisitors.get(p)!.add(s);
      if (cls[s] === "human") pageHumanVisitors.get(p)!.add(s);
    }
    const sp = sessionPages.get(s);
    if (sp) {
      sp.add(p);
      if (!sessionEntry.has(s)) {
        const referrer = rIdx[i] >= 0 ? referrers.values[rIdx[i]] : null;
        const k = classifyReferralSource(referrer, utmOf(uIdx[i])).key;
        sessionEntry.set(s, k === "intern" ? "direkte" : k);
      }
    }
  }

  const sessionRow = (s: number): SessionRow => {
    const sid = sessions.values[s];
    const c = cls[s];
    const isBot = groupOf(c) !== "human";
    return {
      id: (sid.split(":")[0] || "").slice(0, 8),
      cls: c,
      group: groupOf(c),
      device: isBot ? "bot" : deviceForSession(sid),
      ...(isBot ? { name: sessionBotName(sid, c) } : {}),
      ...(isBot && rawUaOfSession(sid) ? { ua: rawUaOfSession(sid).slice(0, 300) } : {}),
      views: sViews[s],
      uniquePages: sessionPages.get(s)?.size ?? 0,
      visits: sVisits[s],
      firstSeen: sqliteDatetime(sFirst[s]),
      lastSeen: sqliteDatetime(sLast[s]),
      entrySource: sessionEntry.get(s) ?? "direkte",
    };
  };

  // Named bots.
  const botMap = new Map<string, TrafficReport["bots"][number]>();
  const otherSamples = new Map<string, { ua: string; views: number }>();
  for (let s = 0; keepRows && s < sessionCount; s++) {
    const g = groupOf(cls[s]);
    if (g === "human" || g === "dev") continue;
    const raw = rawUaOfSession(sessions.values[s]);
    const name = sessionBotName(sessions.values[s], cls[s]);
    const key = `${name}|${cls[s]}`;
    let b = botMap.get(key);
    if (!b) { b = { name, group: g, cls: cls[s], views: 0, visitors: 0, sampleUa: raw ? raw.slice(0, 160) : null }; botMap.set(key, b); }
    b.views += sViews[s];
    b.visitors += 1;
    if (raw && (name === "Ukjent" || name === "Tom user-agent")) {
      const k = raw.slice(0, 40);
      const o = otherSamples.get(k);
      if (o) o.views += sViews[s];
      else otherSamples.set(k, { ua: raw.slice(0, 160), views: sViews[s] });
    }
  }

  // Human visit quality.
  let humanVisits = 0, humanDur = 0, humanSingle = 0, humanViews = 0;
  for (let s = 0; s < sessionCount; s++) {
    if (cls[s] !== "human") continue;
    humanVisits += sVisits[s];
    humanDur += sVisitDurSum[s];
    humanSingle += sSingleViewVisits[s];
    humanViews += sViews[s];
  }

  return {
    version: 1,
    window: { hours: spanHours, from: cutoff, to: sqliteDatetime(endMs), vertical: vertical ?? "all" },
    // Raw rows are pruned in whole UTC days (retention-service.ts), so a fixed
    // range starting at midnight is complete when its first day is stored.
    coverage: {
      oldestRow,
      complete: oldestRow !== null && (ranged ? oldestRow.slice(0, 10) <= cutoff.slice(0, 10) : oldestRow <= cutoff),
    },
    totals,
    groups,
    classes,
    aiVendors,
    aiAgents,
    owner,
    human: {
      devices,
      entrySources: [...entry.entries()]
        .map(([key, e]) => ({ key, label: e.label, visits: e.visits, visitors: e.visitors.size }))
        .sort((a, b) => b.visits - a.visits),
      referrers: [...refHosts.entries()]
        .map(([host, r]) => ({ host, key: r.key, label: r.label, visits: r.visits, visitors: r.visitors.size }))
        .sort((a, b) => b.visits - a.visits || a.host.localeCompare(b.host))
        .slice(0, LIST_LIMIT),
      visitSeconds: Math.round(humanDur / 1000),
      singleViewVisits: humanSingle,
      avgVisitSeconds: humanVisits ? Math.round(humanDur / humanVisits / 1000) : 0,
      pagesPerVisit: humanVisits ? Math.round((humanViews / humanVisits) * 100) / 100 : 0,
      bounceRate: humanVisits ? Math.round((humanSingle / humanVisits) * 1000) / 1000 : 0,
      topSessions: humanTop.map(sessionRow),
    },
    series: { unit, points: series },
    topPages: topPageIds.map((p) => ({
      path: paths.values[p],
      ...pageViews.get(p)!,
      visitors: pageVisitors.get(p)!.size,
      humanVisitors: pageHumanVisitors.get(p)!.size,
    })),
    bots: [...botMap.values()].sort((a, b) => b.views - a.views || a.name.localeCompare(b.name)),
    otherUaSamples: [...otherSamples.values()].sort((a, b) => b.views - a.views).slice(0, 20),
    recentSessions: recent.map(sessionRow),
    ...(opts.reclassified
      ? {
          reclassifiedSessions: [...Array(sessionCount).keys()]
            .filter((s) => cls[s] !== "human" && (sClass[s] === "human" || storedClientClass(sessions.values[s], null) === "human"))
            .map((s): [string, SessionCategory] => [sessions.values[s], cls[s]]),
        }
      : {}),
    busiestSessions: busiest.map(sessionRow),
  };
}

/** Thresholds, re-exported so the dashboard text and tests can cite them. */
export const SCRAPER_THRESHOLDS = {
  uniquePagesPer10Min: SCRAPER_UNIQUE_PAGES_PER_10_MIN,
  produsentPagesPerHour: SCRAPER_PRODUSENT_PAGES_PER_HOUR,
};
