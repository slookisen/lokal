// ─── The public 12-month block: five numbers with their start dates ─────
// dev-request 2026-10-22-statistikk-samme-tall-12-mnd, S2.
//
// The strips on rettfrabonden.com, finn-tannlege.com and opplevagent.no and
// the `year` block of GET /api/traffic-stats show five numbers over the last
// 12 months (365 UTC days, today included):
//
//   humanVisits     Besøk fra mennesker (30-minute rule, traffic-report.ts)
//   humanViews      Sidevisninger fra mennesker
//   aiSearch        AI-søk: ai_search page views + AI lookups over MCP/A2A
//   aiCrawlerViews  AI-crawlere
//   aiDeliveries    Med i AI-søk (profile_ai_deliveries from countingSince)
//
// Raw page views are pruned after 60 days, so the year is read from the
// stored day rows of traffic_history (only the needed fields, extracted in
// SQL, never the whole summaries), plus the raw rows of the days after the
// last stored day (normally just today). Never 12 months of raw data.
//
// Start date per number: null when the number has data for the whole
// window, else the first day it has data for all of its parts. For AI-søk
// that is the later of the first stored traffic day (ai_search) and the first
// day with stored lookups; both parts are summed from that day.
//
// Pure: takes the DB handle and the clock, no database/init import, so it
// runs inside the off-thread stats worker (via computeTrafficStats).

import type Database from "better-sqlite3";
import type { VerticalId } from "./analytics-service";
import { computeTrafficReport } from "./traffic-report";
import { computeQueryStats } from "./search-stats-compute";
import { computeAiDeliveries } from "./profile-ai-deliveries-compute";
import { addDays, dayMs, dayOf, firstCompleteRawDay, firstRawMcpCallDay } from "./traffic-history-compute";

type Db = Database.Database;

/** The window of the 12-month block, in days (today included). */
export const TRAFFIC_YEAR_DAYS = 365;

export interface TrafficYearCount {
  value: number;
  /** First day ('YYYY-MM-DD', UTC) the number covers when after the window's first day; null = the whole window. */
  since: string | null;
}

export interface TrafficYear {
  windowDays: number;
  /** First day of the window ('YYYY-MM-DD', UTC). */
  from: string;
  /** Last day of the window (today, UTC). */
  to: string;
  humanVisits: TrafficYearCount;
  humanViews: TrafficYearCount;
  /** value = pages + lookups, both counted from `since`. */
  aiSearch: TrafficYearCount & { pages: number; lookups: number };
  aiCrawlerViews: TrafficYearCount;
  aiDeliveries: TrafficYearCount;
  /**
   * For the explanatory note, over the same period as humanViews:
   * pageViews = humanViews + aiSearchViews + aiCrawlerViews + otherBotViews.
   * aiSearchViews differs from aiSearch.pages only when the lookups start later.
   */
  pageViews: TrafficYearCount;
  aiSearchViews: TrafficYearCount;
  otherBotViews: TrafficYearCount;
}

export function emptyTrafficYear(nowMs: number = Date.now()): TrafficYear {
  const to = dayOf(nowMs);
  const zero = (): TrafficYearCount => ({ value: 0, since: null });
  return {
    windowDays: TRAFFIC_YEAR_DAYS,
    from: addDays(to, -(TRAFFIC_YEAR_DAYS - 1)),
    to,
    humanVisits: zero(),
    humanViews: zero(),
    aiSearch: { value: 0, since: null, pages: 0, lookups: 0 },
    aiCrawlerViews: zero(),
    aiDeliveries: zero(),
    pageViews: zero(),
    aiSearchViews: zero(),
    otherBotViews: zero(),
  };
}

function tableExists(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

interface StoredDay {
  day: string;
  views: number;
  humanViews: number;
  humanVisits: number;
  aiSearchViews: number;
  aiCrawlerViews: number;
  /** null: the row has no (or an unknown) lookup count. */
  lookups: number | null;
}

function readStoredDays(db: Db, vertical: string, fromDay: string, toDay: string): StoredDay[] {
  if (!tableExists(db, "traffic_history")) return [];
  // json_extract reads five numbers per row; a year of whole summaries is ~15 MB of JSON.
  const rows = db.prepare(`
    SELECT period_start AS day,
      json_extract(summary, '$.totals.views') AS views,
      json_extract(summary, '$.groups.human.views') AS humanViews,
      json_extract(summary, '$.groups.human.visits') AS humanVisits,
      json_extract(summary, '$.groups.ai_search.views') AS aiSearchViews,
      json_extract(summary, '$.groups.ai_crawler.views') AS aiCrawlerViews,
      json_extract(summary, '$.aiLookups.total') AS lookups
    FROM traffic_history
    WHERE period = 'day' AND vertical = ? AND period_start >= ? AND period_start < ? AND json_valid(summary)
    ORDER BY period_start
  `).all(vertical, fromDay, toDay) as Array<Record<string, unknown>>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return rows.map((r) => ({
    day: String(r.day),
    views: num(r.views),
    humanViews: num(r.humanViews),
    humanVisits: num(r.humanVisits),
    aiSearchViews: num(r.aiSearchViews),
    aiCrawlerViews: num(r.aiCrawlerViews),
    lookups: typeof r.lookups === "number" && Number.isFinite(r.lookups) ? r.lookups : null,
  }));
}

/** null when `first` is on or before the window's first day, else `first`. */
function sinceOf(first: string, from: string): string | null {
  return first <= from ? null : first;
}

/**
 * The 12-month block for one site (or all, `vertical` undefined) at `nowMs`.
 * Throws on DB errors; computeTrafficStats' callers decide the fallback.
 */
export function computeTrafficYear(db: Db, vertical: VerticalId | undefined, nowMs: number = Date.now()): TrafficYear {
  const out = emptyTrafficYear(nowMs);
  const today = out.to;
  const from = out.from;

  const stored = readStoredDays(db, vertical ?? "all", from, today);
  const lastStored = stored.length ? stored[stored.length - 1].day : null;

  // The live part: the raw rows after the last stored day (normally today
  // only), never before the first complete raw day or the window.
  const rawFirst = firstCompleteRawDay(db);
  let liveFrom = lastStored ? addDays(lastStored, 1) : (rawFirst ?? today);
  if (liveFrom < from) liveFrom = from;
  if (rawFirst && rawFirst > liveFrom) liveFrom = rawFirst <= today ? rawFirst : today;
  const hasLive = rawFirst !== null && rawFirst <= today;
  const liveFromMs = dayMs(liveFrom);
  const live = { views: 0, humanViews: 0, humanVisits: 0, aiSearchViews: 0, aiCrawlerViews: 0, lookups: 0 };
  if (hasLive && liveFromMs < nowMs) {
    const report = computeTrafficReport(db, (nowMs - liveFromMs) / 3600_000, vertical, nowMs, { fromMs: liveFromMs, toMs: nowMs, detail: false });
    live.views = report.totals.views;
    live.humanViews = report.groups.human.views;
    live.humanVisits = report.groups.human.visits;
    live.aiSearchViews = report.groups.ai_search.views;
    live.aiCrawlerViews = report.groups.ai_crawler.views;
  }
  // MCP/A2A rows are kept as long as the page views (both 60 days), so the
  // live part's lookups come from the raw calls. When there are no raw calls
  // at all the live lookups are a real zero.
  const mcpFirst = firstRawMcpCallDay(db);
  if (liveFromMs < nowMs) {
    const q = computeQueryStats(db, 0, vertical, nowMs, { fromMs: liveFromMs, toMs: nowMs, topTerms: 0 });
    live.lookups = q.aiLookups?.total ?? 0;
  }
  const liveLookupsFrom = mcpFirst && mcpFirst > liveFrom ? mcpFirst : liveFrom;

  // Traffic numbers: first stored day, else the live part's first day.
  const trafficFirst = stored.length ? stored[0].day : liveFrom;
  const trafficSince = sinceOf(trafficFirst, from);
  let views = live.views, humanViews = live.humanViews, humanVisits = live.humanVisits, aiCrawlerViews = live.aiCrawlerViews;
  let aiSearchViews = live.aiSearchViews;
  for (const s of stored) {
    views += s.views;
    aiSearchViews += s.aiSearchViews;
    humanViews += s.humanViews;
    humanVisits += s.humanVisits;
    aiCrawlerViews += s.aiCrawlerViews;
  }

  // AI-søk: from the later of the first traffic day and the first lookup day.
  const firstStoredLookup = stored.find((s) => s.lookups !== null)?.day ?? null;
  const lookupFirst = firstStoredLookup ?? liveLookupsFrom;
  const aiFirst = lookupFirst > trafficFirst ? lookupFirst : trafficFirst;
  let pages = 0, lookups = 0;
  for (const s of stored) {
    if (s.day < aiFirst) continue;
    pages += s.aiSearchViews;
    lookups += s.lookups ?? 0;
  }
  pages += live.aiSearchViews;
  lookups += live.lookups;

  out.humanVisits = { value: humanVisits, since: trafficSince };
  out.humanViews = { value: humanViews, since: trafficSince };
  out.aiCrawlerViews = { value: aiCrawlerViews, since: trafficSince };
  out.pageViews = { value: views, since: trafficSince };
  out.aiSearchViews = { value: aiSearchViews, since: trafficSince };
  out.otherBotViews = { value: Math.max(0, views - humanViews - aiSearchViews - aiCrawlerViews), since: trafficSince };
  out.aiSearch = { value: pages + lookups, since: sinceOf(aiFirst, from), pages, lookups };

  // Med i AI-søk: profile_ai_deliveries over the window, from countingSince.
  const deliveries = computeAiDeliveries(db, vertical, undefined, TRAFFIC_YEAR_DAYS, nowMs);
  out.aiDeliveries = { value: deliveries.total, since: sinceOf(deliveries.countingSince ?? today, from) };
  return out;
}

// ── Labels (server-rendered strips) ─────────────────────────────────────

export type TrafficYearLang = "nb" | "en" | "sv";

/** «siste 12 måneder» for the whole window, else «siden 13. aug. 2026». */
export function trafficYearPeriodLabel(since: string | null, lang: TrafficYearLang = "nb"): string {
  if (since === null || Number.isNaN(dayMs(since))) {
    return lang === "en" ? "last 12 months" : lang === "sv" ? "senaste 12 månaderna" : "siste 12 måneder";
  }
  const locale = lang === "en" ? "en-GB" : lang === "sv" ? "sv-SE" : "nb-NO";
  const d = new Date(dayMs(since)).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return (lang === "en" ? "since " : lang === "sv" ? "sedan " : "siden ") + d;
}

/**
 * The `year` block of GET /api/traffic-stats: the five numbers with their
 * start dates (null = the whole window). null while it is not available.
 */
export function publicTrafficYearBlock(y: TrafficYear | null): {
  windowDays: number; from: string; to: string;
  humanVisits: TrafficYearCount; humanViews: TrafficYearCount;
  aiSearch: TrafficYearCount & { pages: number; lookups: number };
  aiCrawlerViews: TrafficYearCount; aiDeliveries: TrafficYearCount;
} | null {
  if (!y) return null;
  return {
    windowDays: y.windowDays,
    from: y.from,
    to: y.to,
    humanVisits: y.humanVisits,
    humanViews: y.humanViews,
    aiSearch: y.aiSearch,
    aiCrawlerViews: y.aiCrawlerViews,
    aiDeliveries: y.aiDeliveries,
  };
}

/** The site language codes ("no"/"nb", "en", "sv") as a label language. */
export function trafficYearLangOf(lang: string | undefined): TrafficYearLang {
  return lang === "en" ? "en" : lang === "sv" ? "sv" : "nb";
}

export type TrafficYearKey = "humanVisits" | "humanViews" | "aiSearch" | "aiCrawlerViews" | "aiDeliveries";

/** The strips' five numbers, in their order. */
export const TRAFFIC_YEAR_KEYS: readonly TrafficYearKey[] = ["humanVisits", "humanViews", "aiSearch", "aiCrawlerViews", "aiDeliveries"];

/**
 * One strip cell: the formatted number and its period («siste 12 måneder» or
 * «siden <dato>»). While the block is not available the number is «–» with no
 * period, never a 0 that reads as a measured year.
 */
export function trafficYearCell(
  year: TrafficYear | null, key: TrafficYearKey, lang: TrafficYearLang, numFmt: string,
): { value: string; period: string } {
  if (!year) return { value: "–", period: "" };
  const c = year[key];
  return { value: c.value.toLocaleString(numFmt), period: trafficYearPeriodLabel(c.since, lang) };
}

// ── Admin (same snapshot as the strips) ─────────────────────────────────

/**
 * Body of GET /admin/analytics/year (dev-request
 * 2026-10-22-statistikk-samme-tall-12-mnd, S2): the admin dashboard's five
 * cards for one site and «Siste år». Built from the very snapshot the site's
 * strip and /api/traffic-stats read (getTrafficStatsSnapshot(vertical), the
 * off-thread cache), through the same publicTrafficYearBlock, so admin and
 * the strip cannot drift apart. computedAt: when that snapshot was computed
 * («oppdatert kl. HH:MM»); null while the first computation is running.
 */
export function adminTrafficYearBody(
  vertical: string,
  snap: { stats: { year: TrafficYear | null }; ready: boolean; computedAt?: number },
): { vertical: string; ready: boolean; computedAt: string | null; year: ReturnType<typeof publicTrafficYearBlock> } {
  const ready = snap.ready === true;
  const at = ready && typeof snap.computedAt === "number" && Number.isFinite(snap.computedAt) ? new Date(snap.computedAt).toISOString() : null;
  return { vertical, ready, computedAt: at, year: publicTrafficYearBlock(ready ? snap.stats.year : null) };
}
