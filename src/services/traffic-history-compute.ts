// ─── Traffic history: aggregates kept after the raw rows are pruned ─────
// dev-request 2026-10-13-statistikk-riktig-for-investorer (A2A), S3.
//
// Raw page views (analytics_page_views) are deleted after RFB_AUTO_PRUNE_DAYS
// (60) days, and the privacy page promises exactly that: single visits with a
// hashed IP are deleted, only totals with no link to a person are kept. So the
// dashboard's history beyond 60 days is built from aggregates computed while
// the raw rows still exist, one row per (period, start, site) in traffic_history:
//
//   day    every UTC day: page views, visits and visitors per client class,
//          entry sources, devices, top pages, referrer hosts, named bots and
//          searches per channel, and AI lookups over MCP/A2A (aiLookups,
//          computeAiLookups' rule). Views, visits, searches and lookups add up
//          across days; visitors do not (one person on two days is one visitor).
//   week   every ISO week (Monday–Sunday, UTC) and
//   month  every calendar month: the same numbers computed over the whole
//          period at once, so their unique visitors are exact. Written once
//          the period has ended, while all of its raw days are still stored.
//
// A period whose first days were already pruned when it was computed (the
// history starts on the oldest stored day) is stored with `partialFrom` = its
// first stored day and never recomputed: its raw data only shrinks.
//
// Nothing here identifies a person: no session ids, IP hashes, user agents or
// full referrer URLs (hosts only). Search terms are kept as counts, like
// query_text_daily.
//
// Pure: takes the DB handle and the clock, no database/init import, so it runs
// in the off-thread stats worker (offthread-stats-worker.ts, task
// "trafficHistory") and in the admin worker (admin-stats-compute.ts, query
// "trafficHistory"). Writes live in traffic-history.ts (main thread).

import type Database from "better-sqlite3";
import type { VerticalId } from "./analytics-service";
import { emptyAiAgents, mergeAiAgents, type AiAgents, type SessionCategory } from "./traffic-classifier";
import {
  computeTrafficReport,
  groupOf,
  TRAFFIC_GROUPS,
  VISITOR_CLASSES,
  type Device,
  type Totals,
  type TrafficGroup,
} from "./traffic-report";
import { computeQueryStats, siteSearchCount, type AiLookups } from "./search-stats-compute";

type Db = Database.Database;

/**
 * Bump when a summary's numbers change meaning; rows of an older version are
 * recomputed while their raw days exist (planHistoryItems, and the prune's
 * ensureTrafficHistoryForDaySync), and kept as they are once those are gone.
 * 4: aiLookups (dev-request 2026-10-22-statistikk-samme-tall-12-mnd, S0).
 * 5: aiAgents (vendor × purpose, G2-S2). Rows stored at version 4 have no
 *    aiAgents, so they are recomputed while their raw days exist.
 */
export const TRAFFIC_HISTORY_VERSION = 5;

export type HistoryPeriod = "day" | "week" | "month";
export type HistoryVertical = VerticalId | "all";
export const HISTORY_PERIODS: readonly HistoryPeriod[] = ["day", "week", "month"];
export const HISTORY_VERTICALS: readonly HistoryVertical[] = ["all", "rfb", "dental", "experiences"];

const TOP_PAGES = 50;
const TOP_REFERRERS = 20;
const TOP_BOTS = 30;
const TOP_TERMS = 30;

export interface HistoryItem {
  period: HistoryPeriod;
  /** First day, 'YYYY-MM-DD' (UTC), inclusive. */
  start: string;
  /** Day after the last, exclusive. */
  end: string;
  vertical: HistoryVertical;
}

export interface SearchCounts {
  total: number;
  byChannel: { web: number; api: number; mcp: number; a2a: number; ai: number };
  botQueries: number;
  ownerQueries: number;
}

export interface HistorySummary extends HistoryItem {
  version: number;
  /** First stored raw day when after `start` (the period's first days were already pruned), else null. */
  partialFrom: string | null;
  totals: Totals;
  groups: Record<TrafficGroup, Totals>;
  classes: Record<SessionCategory, Totals>;
  aiVendors: { chatgpt: number; claude: number; other: number };
  /** aiVendors split by vendor × purpose (user / search / training); see AI_AGENT_REGISTRY. */
  aiAgents: AiAgents;
  owner: { views: number; cookieViews: number; scriptViews: number; unknownViews: number };
  human: {
    devices: Record<Device, Totals>;
    entrySources: Array<{ key: string; label: string; visits: number; visitors: number }>;
    referrers: Array<{ host: string; key: string; label: string; visits: number; visitors: number }>;
    visitSeconds: number;
    singleViewVisits: number;
  };
  /** aiSearchViews / aiCrawlerViews: absent in rows stored before 2026-10-26 (only aiViews, both summed). */
  topPages: Array<{ path: string; views: number; humanViews: number; aiViews: number; aiSearchViews?: number; aiCrawlerViews?: number; botViews: number; visitors: number; humanVisitors: number }>;
  bots: Array<{ name: string; group: TrafficGroup; cls: SessionCategory; views: number; visitors: number }>;
  searches: SearchCounts & { topTerms: Array<{ query: string; count: number }> };
  /**
   * AI agents' lookups over MCP data tools and countable A2A requests in the
   * covered range (computeAiLookups: the same rule as the public AI-søk
   * number), for this row's site. analytics_mcp_calls is pruned after 60 days
   * with no rollup of its own, so this is its only lasting record.
   *   absent  the row was stored before version 4;
   *   null    the raw MCP/A2A rows of the covered range were (partly) gone
   *           when the row was computed: unknown, never a zero.
   */
  aiLookups?: AiLookups | null;
}

// ── Calendar helpers (UTC) ──────────────────────────────────────────────

export function isDay(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(dayMs(s));
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function addDays(day: string, n: number): string {
  return dayOf(dayMs(day) + n * 86_400_000);
}

/** Monday of the ISO week containing `day`. */
export function weekStartOf(day: string): string {
  const dow = new Date(dayMs(day)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

export function monthStartOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function nextMonthStart(day: string): string {
  const d = new Date(dayMs(monthStartOf(day)));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return dayOf(d.getTime());
}

export function periodEnd(period: HistoryPeriod, start: string): string {
  if (period === "day") return addDays(start, 1);
  if (period === "week") return addDays(start, 7);
  return nextMonthStart(start);
}

// ── Raw coverage ────────────────────────────────────────────────────────

const PRUNE_MARKER_JOB = "retention-rolled-delete-pending:analytics_page_views";

function tableExists(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * The first UTC day whose raw page views are all still stored: the oldest
 * stored day, or the day after it while the nightly prune is part-way through
 * deleting it (retention-service.ts's delete-pending marker). Null when there
 * are no raw rows.
 */
export function firstCompleteRawDay(db: Db): string | null {
  // created_at >= '1970': rows with an empty or broken timestamp are not a day.
  const oldest = (db.prepare("SELECT substr(MIN(created_at), 1, 10) AS d FROM analytics_page_views WHERE created_at >= '1970'").get() as { d: string | null } | undefined)?.d ?? null;
  if (!oldest || !isDay(oldest)) return null;
  if (tableExists(db, "boot_job_state")) {
    const marker = (db.prepare("SELECT last_completed_at AS v FROM boot_job_state WHERE job = ?").get(PRUNE_MARKER_JOB) as { v: string } | undefined)?.v;
    if (marker && marker.slice(0, 10) === oldest) return addDays(oldest, 1);
  }
  return oldest;
}

/**
 * The first UTC day whose raw MCP/A2A calls are still stored: the oldest
 * stored day of analytics_mcp_calls (pruneAnalyticsMcpCalls deletes whole UTC
 * days in one statement, so that day is complete). Null when there are no rows,
 * which cannot be told from rows already pruned.
 */
export function firstRawMcpCallDay(db: Db): string | null {
  if (!tableExists(db, "analytics_mcp_calls")) return null;
  const oldest = (db.prepare("SELECT substr(MIN(created_at), 1, 10) AS d FROM analytics_mcp_calls WHERE created_at >= '1970'").get() as { d: string | null } | undefined)?.d ?? null;
  return oldest && isDay(oldest) ? oldest : null;
}

/**
 * AI lookups of [from, end) when every raw MCP/A2A call of that range is still
 * stored, else null. Holds for the prune's safety net too: the nightly prune
 * deletes analytics_mcp_calls after the page views (analytics-service.ts
 * runAutoPrune), so a day being pruned still has its calls.
 */
function aiLookupsIfCovered(db: Db, from: string, lookups: AiLookups | undefined): AiLookups | null {
  const first = firstRawMcpCallDay(db);
  if (!first || first > from || !lookups) return null;
  return { mcp: lookups.mcp, a2a: lookups.a2a, total: lookups.total };
}

// ── One summary ─────────────────────────────────────────────────────────

/**
 * Aggregates of one period for one site (or "all"), from the raw rows. When
 * the period's first days are no longer stored, covers [first stored day, end)
 * and says so in `partialFrom`. Throws when no raw day of the period is stored.
 *
 * `wholePeriod`: the caller knows every raw row of the period is still stored
 * (the nightly prune, about to delete the day), so the period is computed as
 * it is — a day with no rows is a real zero day.
 *
 * Reads in one read transaction, so the coverage check and the counts see
 * the same rows even while the prune is deleting on another connection.
 */
export function computeHistorySummary(db: Db, item: HistoryItem, nowMs: number, opts: { wholePeriod?: boolean } = {}): HistorySummary {
  return db.transaction(() => computeHistorySummaryInTx(db, item, nowMs, opts))();
}

function computeHistorySummaryInTx(db: Db, item: HistoryItem, nowMs: number, opts: { wholePeriod?: boolean }): HistorySummary {
  let from = item.start;
  if (!opts.wholePeriod) {
    const first = firstCompleteRawDay(db);
    if (!first || first >= item.end) throw new Error(`no raw rows for ${item.period} ${item.start} (${item.vertical})`);
    if (first > item.start) from = first;
  }
  const fromMs = dayMs(from);
  const toMs = dayMs(item.end);
  const vertical = item.vertical === "all" ? undefined : item.vertical;
  const report = computeTrafficReport(db, (toMs - fromMs) / 3600_000, vertical, nowMs, { fromMs, toMs, topPages: TOP_PAGES });
  const q = computeQueryStats(db, 0, vertical, nowMs, { fromMs, toMs, topTerms: TOP_TERMS });
  return {
    period: item.period,
    start: item.start,
    end: item.end,
    vertical: item.vertical,
    version: TRAFFIC_HISTORY_VERSION,
    partialFrom: from > item.start ? from : null,
    totals: report.totals,
    groups: report.groups,
    classes: report.classes,
    aiVendors: report.aiVendors,
    aiAgents: report.aiAgents,
    owner: report.owner,
    human: {
      devices: report.human.devices,
      entrySources: report.human.entrySources,
      referrers: report.human.referrers.slice(0, TOP_REFERRERS),
      visitSeconds: report.human.visitSeconds,
      singleViewVisits: report.human.singleViewVisits,
    },
    topPages: report.topPages,
    bots: report.bots.slice(0, TOP_BOTS).map(({ name, group, cls, views, visitors }) => ({ name, group, cls, views, visitors })),
    searches: {
      total: q.totalQueries,
      byChannel: { web: 0, api: 0, mcp: 0, a2a: 0, ai: 0, ...q.byChannel },
      botQueries: q.botQueries ?? 0,
      ownerQueries: q.ownerQueries,
      topTerms: q.topSearchTerms,
    },
    aiLookups: aiLookupsIfCovered(db, from, q.aiLookups),
  };
}

// ── Which periods still need a summary ─────────────────────────────────

export interface StoredHistoryRow {
  period: HistoryPeriod;
  start: string;
  vertical: HistoryVertical;
  version: number;
  partialFrom: string | null;
}

/**
 * Every (period, site) the history lacks and the raw rows can still give:
 * each finished day from the first complete raw day, each finished week and
 * month that ends after it. A stored row is redone only when its version is
 * older and the raw rows still cover the whole period. Oldest first (the next
 * to be pruned), days before weeks before months.
 */
export function planHistoryItems(db: Db, stored: StoredHistoryRow[], nowMs: number): HistoryItem[] {
  const first = firstCompleteRawDay(db);
  if (!first) return [];
  const today = dayOf(nowMs);
  const have = new Map(stored.map((r) => [`${r.period}|${r.start}|${r.vertical}`, r]));
  const items: HistoryItem[] = [];
  const consider = (period: HistoryPeriod, start: string) => {
    const end = periodEnd(period, start);
    if (end > today || end <= first) return;
    for (const vertical of HISTORY_VERTICALS) {
      const row = have.get(`${period}|${start}|${vertical}`);
      if (row && (row.version >= TRAFFIC_HISTORY_VERSION || start < first)) continue;
      items.push({ period, start, end, vertical });
    }
  };
  for (let d = first; d < today; d = addDays(d, 1)) consider("day", d);
  for (let w = weekStartOf(first); w < today; w = addDays(w, 7)) consider("week", w);
  for (let m = monthStartOf(first); m < today; m = nextMonthStart(m)) consider("month", m);
  const order: Record<HistoryPeriod, number> = { day: 0, week: 1, month: 2 };
  return items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : order[a.period] - order[b.period]));
}

// ── The dashboard's view of the history ────────────────────────────────

export interface HistoryPeriodRow {
  period: HistoryPeriod;
  start: string;
  end: string;
  /** Set when the period's first days were pruned before it was computed. */
  partialFrom: string | null;
  /** The current week or month, computed live from the raw rows so far. */
  inProgress: boolean;
  humanVisitors: number;
  humanVisits: number;
  humanViews: number;
  views: number;
  /** @deprecated ai_search + ai_crawler views; admin shows aiSearch and aiCrawlerViews instead. */
  aiViews: number;
  /** Page views by AI assistants fetching for someone (ai_search). */
  aiSearchViews: number;
  /** AI lookups over MCP/A2A in the period; null when not stored (before S0, or raw calls gone). */
  aiLookups: number | null;
  /** «AI-søk» = aiSearchViews + aiLookups (lookups counted as 0 when null; see aiLookups). */
  aiSearch: number;
  /** Page views by autonomous AI crawlers (ai_crawler). */
  aiCrawlerViews: number;
  botViews: number;
  visitors: number;
  /** Every channel, AI assistants included (older readers). */
  searches: number;
  /** «Søk (nettsider og API)»: web + api only (siteSearchCount). */
  siteSearches: number;
}

export interface HistoryView {
  version: number;
  vertical: HistoryVertical;
  /** [from, to): the requested days up to and including yesterday (UTC). */
  window: { days: number | null; from: string; to: string };
  coverage: { firstDay: string | null; lastDay: string | null; daysInWindow: number; daysWithData: number; missingDays: string[] };
  /** Sums over the stored days in the window (views, visits and searches add up; visitors do not). */
  totals: { views: number; visits: number };
  groups: Record<TrafficGroup, { views: number; visits: number }>;
  classes: Record<SessionCategory, { views: number; visits: number }>;
  aiVendors: { chatgpt: number; claude: number; other: number };
  aiAgents: AiAgents;
  owner: { views: number; cookieViews: number; scriptViews: number; unknownViews: number };
  human: {
    devices: Record<Device, { views: number; visits: number }>;
    entrySources: Array<{ key: string; label: string; visits: number }>;
    avgVisitSeconds: number;
    pagesPerVisit: number;
    bounceRate: number;
  };
  /** Mean of the exact monthly unique human visitors over the whole months inside the window; null when none. */
  monthlyHumanVisitors: { average: number; months: string[] } | null;
  searches: SearchCounts;
  /** «Søk (nettsider og API)» over the window: searches.byChannel web + api (siteSearchCount). */
  siteSearches: number;
  /**
   * AI lookups over MCP/A2A summed over the window's stored days that have
   * them (S0); firstDay = the first such day, null when none.
   */
  aiLookups: { total: number; daysWithData: number; firstDay: string | null };
  /**
   * Lists summed from each day's top list: a page, host, bot or term outside a
   * day's top list is missing from that day, so the sums are lower bounds.
   */
  approximate: {
    /** aiSearchViews / aiCrawlerViews: null when a day in the window has only the summed aiViews. */
    topPages: Array<{ path: string; views: number; humanViews: number; aiViews: number; aiSearchViews: number | null; aiCrawlerViews: number | null; botViews: number }>;
    referrers: Array<{ host: string; label: string; visits: number }>;
    bots: Array<{ name: string; group: TrafficGroup; cls: SessionCategory; views: number }>;
    topTerms: Array<{ query: string; count: number }>;
  };
  series: { unit: "day"; points: Array<{ t: string; views: number; humanViews: number; aiViews: number; botViews: number; visitors: number; humanVisitors: number; humanVisits: number; searches: number }> };
  /** Every stored month and week; the all-time view (days = null) adds the current one so far. */
  months: HistoryPeriodRow[];
  weeks: HistoryPeriodRow[];
}

function readSummaries(db: Db, period: HistoryPeriod, vertical: HistoryVertical, fromDay?: string, toDay?: string): HistorySummary[] {
  if (!tableExists(db, "traffic_history")) return [];
  const where = ["period = ?", "vertical = ?"];
  const params: string[] = [period, vertical];
  if (fromDay) { where.push("period_start >= ?"); params.push(fromDay); }
  if (toDay) { where.push("period_start < ?"); params.push(toDay); }
  const rows = db.prepare(`SELECT summary FROM traffic_history WHERE ${where.join(" AND ")} ORDER BY period_start`).all(...params) as Array<{ summary: string }>;
  const out: HistorySummary[] = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.summary) as HistorySummary); } catch { /* skip a corrupt row */ }
  }
  return out;
}

function periodRow(s: HistorySummary, inProgress: boolean): HistoryPeriodRow {
  const lookups = s.aiLookups && typeof s.aiLookups.total === "number" ? s.aiLookups.total : null;
  return {
    period: s.period,
    start: s.start,
    end: s.end,
    partialFrom: s.partialFrom,
    inProgress,
    humanVisitors: s.groups.human.visitors,
    humanVisits: s.groups.human.visits,
    humanViews: s.groups.human.views,
    views: s.totals.views,
    aiViews: s.groups.ai_search.views + s.groups.ai_crawler.views,
    aiSearchViews: s.groups.ai_search.views,
    aiLookups: lookups,
    aiSearch: s.groups.ai_search.views + (lookups ?? 0),
    aiCrawlerViews: s.groups.ai_crawler.views,
    botViews: s.groups.bot.views + s.groups.dev.views,
    visitors: s.totals.visitors,
    searches: s.searches.total,
    siteSearches: siteSearchCount(s.searches.byChannel),
  };
}

/** The current week or month so far, from the raw rows (null when none of it is stored). */
function liveSummary(db: Db, period: "week" | "month", vertical: HistoryVertical, nowMs: number): HistorySummary | null {
  const today = dayOf(nowMs);
  const start = period === "week" ? weekStartOf(today) : monthStartOf(today);
  const first = firstCompleteRawDay(db);
  if (!first || first > today) return null;
  const from = first > start ? first : start;
  const fromMs = dayMs(from);
  const v = vertical === "all" ? undefined : vertical;
  const report = computeTrafficReport(db, (nowMs - fromMs) / 3600_000, v, nowMs, { fromMs, toMs: nowMs, detail: false });
  const q = computeQueryStats(db, 0, v, nowMs, { fromMs, toMs: nowMs, topTerms: 0 });
  return {
    period, start, end: periodEnd(period, start), vertical, version: TRAFFIC_HISTORY_VERSION,
    partialFrom: from > start ? from : null,
    totals: report.totals, groups: report.groups, classes: report.classes, aiVendors: report.aiVendors, aiAgents: report.aiAgents, owner: report.owner,
    human: { devices: report.human.devices, entrySources: [], referrers: [], visitSeconds: report.human.visitSeconds, singleViewVisits: report.human.singleViewVisits },
    topPages: [], bots: [],
    searches: { total: q.totalQueries, byChannel: { web: 0, api: 0, mcp: 0, a2a: 0, ai: 0, ...q.byChannel }, botQueries: q.botQueries ?? 0, ownerQueries: q.ownerQueries, topTerms: [] },
    aiLookups: aiLookupsIfCovered(db, from, q.aiLookups),
  };
}

function addInto<K extends string>(acc: Record<K, { views: number; visits: number }>, src: Record<K, Totals>): void {
  for (const k of Object.keys(src) as K[]) {
    if (!acc[k]) acc[k] = { views: 0, visits: 0 };
    acc[k].views += src[k].views;
    acc[k].visits += src[k].visits;
  }
}

function topN<T>(m: Map<string, T>, by: (t: T) => number, n: number): T[] {
  return [...m.values()].sort((a, b) => by(b) - by(a)).slice(0, n);
}

/**
 * The dashboard's history: sums over the stored days of the last `days` days
 * (null = every stored day) up to yesterday, the daily series, and every
 * stored week and month plus the current one so far.
 */
export function computeHistoryView(db: Db, days: number | null, vertical: HistoryVertical, nowMs: number): HistoryView {
  const today = dayOf(nowMs);
  const bounds = tableExists(db, "traffic_history")
    ? (db.prepare("SELECT MIN(period_start) AS a, MAX(period_start) AS b FROM traffic_history WHERE period = 'day' AND vertical = ?").get(vertical) as { a: string | null; b: string | null })
    : { a: null, b: null };
  const firstDay = bounds.a;
  const lastDay = bounds.b;
  const from = days === null ? (firstDay ?? today) : addDays(today, -days);
  // Only the window's day rows are parsed (a year of rows is ~15 MB of JSON).
  const inWindow = readSummaries(db, "day", vertical, from, today);

  const zero = () => ({ views: 0, visits: 0 });
  const groups = Object.fromEntries(TRAFFIC_GROUPS.map((g) => [g, zero()])) as Record<TrafficGroup, { views: number; visits: number }>;
  const classes = Object.fromEntries(VISITOR_CLASSES.map((c) => [c, zero()])) as Record<SessionCategory, { views: number; visits: number }>;
  const devices = { mobile: zero(), tablet: zero(), desktop: zero(), unknown: zero() } as Record<Device, { views: number; visits: number }>;
  const totals = zero();
  const aiVendors = { chatgpt: 0, claude: 0, other: 0 };
  const aiAgents = emptyAiAgents();
  const owner = { views: 0, cookieViews: 0, scriptViews: 0, unknownViews: 0 };
  const searches: SearchCounts = { total: 0, byChannel: { web: 0, api: 0, mcp: 0, a2a: 0, ai: 0 }, botQueries: 0, ownerQueries: 0 };
  const entry = new Map<string, { key: string; label: string; visits: number }>();
  const pages = new Map<string, { path: string; views: number; humanViews: number; aiViews: number; aiSearchViews: number | null; aiCrawlerViews: number | null; botViews: number }>();
  const lookups = { total: 0, daysWithData: 0, firstDay: null as string | null };
  const refs = new Map<string, { host: string; label: string; visits: number }>();
  const bots = new Map<string, { name: string; group: TrafficGroup; cls: SessionCategory; views: number }>();
  const terms = new Map<string, { query: string; count: number }>();
  let visitSeconds = 0, singleViewVisits = 0;

  const points: HistoryView["series"]["points"] = [];
  const byDay = new Map(inWindow.map((d) => [d.start, d]));
  const missingDays: string[] = [];
  const seriesFrom = firstDay && firstDay > from ? firstDay : from;
  for (let d = seriesFrom; d < today; d = addDays(d, 1)) {
    const s = byDay.get(d);
    if (!s) {
      if (firstDay && d >= firstDay) missingDays.push(d);
      points.push({ t: d, views: 0, humanViews: 0, aiViews: 0, botViews: 0, visitors: 0, humanVisitors: 0, humanVisits: 0, searches: 0 });
      continue;
    }
    points.push({
      t: d,
      views: s.totals.views,
      humanViews: s.groups.human.views,
      aiViews: s.groups.ai_search.views + s.groups.ai_crawler.views,
      botViews: s.groups.bot.views + s.groups.dev.views,
      visitors: s.totals.visitors,
      humanVisitors: s.groups.human.visitors,
      humanVisits: s.groups.human.visits,
      searches: s.searches.total,
    });
  }

  for (const s of inWindow) {
    totals.views += s.totals.views;
    totals.visits += s.totals.visits;
    addInto(groups, s.groups);
    addInto(classes, s.classes);
    addInto(devices, s.human.devices);
    aiVendors.chatgpt += s.aiVendors.chatgpt; aiVendors.claude += s.aiVendors.claude; aiVendors.other += s.aiVendors.other;
    mergeAiAgents(aiAgents, s.aiAgents);
    owner.views += s.owner.views; owner.cookieViews += s.owner.cookieViews; owner.scriptViews += s.owner.scriptViews; owner.unknownViews += s.owner.unknownViews;
    searches.total += s.searches.total;
    for (const ch of ["web", "api", "mcp", "a2a", "ai"] as const) searches.byChannel[ch] += s.searches.byChannel[ch] ?? 0;
    searches.botQueries += s.searches.botQueries;
    searches.ownerQueries += s.searches.ownerQueries;
    visitSeconds += s.human.visitSeconds;
    singleViewVisits += s.human.singleViewVisits;
    for (const e of s.human.entrySources) {
      const x = entry.get(e.key) ?? { key: e.key, label: e.label, visits: 0 };
      x.visits += e.visits; entry.set(e.key, x);
    }
    for (const p of s.topPages) {
      const x = pages.get(p.path) ?? { path: p.path, views: 0, humanViews: 0, aiViews: 0, aiSearchViews: 0, aiCrawlerViews: 0, botViews: 0 };
      x.views += p.views; x.humanViews += p.humanViews; x.aiViews += p.aiViews; x.botViews += p.botViews;
      // Rows stored before the split only have the sum: the split becomes unknown.
      const split = typeof p.aiSearchViews === "number" && typeof p.aiCrawlerViews === "number";
      x.aiSearchViews = split && x.aiSearchViews !== null ? x.aiSearchViews + (p.aiSearchViews as number) : null;
      x.aiCrawlerViews = split && x.aiCrawlerViews !== null ? x.aiCrawlerViews + (p.aiCrawlerViews as number) : null;
      pages.set(p.path, x);
    }
    if (s.aiLookups && typeof s.aiLookups.total === "number") {
      lookups.total += s.aiLookups.total;
      lookups.daysWithData += 1;
      if (lookups.firstDay === null || s.start < lookups.firstDay) lookups.firstDay = s.start;
    }
    for (const r of s.human.referrers) {
      const x = refs.get(r.host) ?? { host: r.host, label: r.label, visits: 0 };
      x.visits += r.visits; refs.set(r.host, x);
    }
    for (const b of s.bots) {
      const k = `${b.name}|${b.cls}`;
      const x = bots.get(k) ?? { name: b.name, group: b.group ?? groupOf(b.cls), cls: b.cls, views: 0 };
      x.views += b.views; bots.set(k, x);
    }
    for (const t of s.searches.topTerms) {
      const x = terms.get(t.query) ?? { query: t.query, count: 0 };
      x.count += t.count; terms.set(t.query, x);
    }
  }

  const hv = groups.human.visits;
  const months = readSummaries(db, "month", vertical).map((s) => periodRow(s, false));
  const weeks = readSummaries(db, "week", vertical).map((s) => periodRow(s, false));
  // The current month and week so far are computed from the raw rows (up to
  // a month of rows) for the all-time view only, which carries the dashboard's
  // month/week table; a window view uses whole stored months only.
  if (days === null) {
    const liveMonth = liveSummary(db, "month", vertical, nowMs);
    if (liveMonth && !months.some((m) => m.start === liveMonth.start)) months.push(periodRow(liveMonth, true));
    const liveWeek = liveSummary(db, "week", vertical, nowMs);
    if (liveWeek && !weeks.some((w) => w.start === liveWeek.start)) weeks.push(periodRow(liveWeek, true));
  }

  // Whole months inside the window: stored, not partial, not in progress.
  const fullMonths = months.filter((m) => !m.inProgress && !m.partialFrom && m.start >= from && m.end <= today);
  const monthlyHumanVisitors = fullMonths.length
    ? { average: Math.round(fullMonths.reduce((a, m) => a + m.humanVisitors, 0) / fullMonths.length), months: fullMonths.map((m) => m.start.slice(0, 7)) }
    : null;

  let daysInWindow = 0;
  for (let d = from; d < today; d = addDays(d, 1)) daysInWindow++;

  return {
    version: TRAFFIC_HISTORY_VERSION,
    vertical,
    window: { days, from, to: today },
    coverage: { firstDay, lastDay, daysInWindow, daysWithData: inWindow.length, missingDays: missingDays.slice(-30) },
    totals,
    groups,
    classes,
    aiVendors,
    aiAgents,
    owner,
    human: {
      devices,
      entrySources: [...entry.values()].sort((a, b) => b.visits - a.visits),
      avgVisitSeconds: hv ? Math.round(visitSeconds / hv) : 0,
      pagesPerVisit: hv ? Math.round((groups.human.views / hv) * 100) / 100 : 0,
      bounceRate: hv ? Math.round((singleViewVisits / hv) * 1000) / 1000 : 0,
    },
    monthlyHumanVisitors,
    searches,
    siteSearches: siteSearchCount(searches.byChannel),
    aiLookups: lookups,
    approximate: {
      topPages: topN(pages, (p) => p.views, 50),
      referrers: topN(refs, (r) => r.visits, 30),
      bots: topN(bots, (b) => b.views, 30),
      topTerms: topN(terms, (t) => t.count, 20),
    },
    series: { unit: "day", points },
    months,
    weeks,
  };
}
