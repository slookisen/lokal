// ─── Admin-dashboard statistics: the queries, on an explicit DB handle ──
// dev-request 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-samtaler
// (A2A), skive 3.
//
// The admin statistics (/admin/analytics/summary, /summary/:hours,
// /producers, /cities, /visitors, /pages, /umbrella-traffic) used to run on
// the main thread inside the request and froze every host for 1.5–8.6 s on
// wide windows. These functions are those same queries, taking the DB handle
// and the clock as arguments, so they run unchanged in two places:
//   - in the off-thread stats worker's "admin" lane (offthread-stats-worker.ts)
//     on its own read-only connection — the normal path, see admin-stats.ts;
//   - on the main thread through AnalyticsService (getSummary, getTopProducers,
//     getCityStats, …) and the routes' fallback path (in-memory DB,
//     OFFTHREAD_STATS_DISABLED=1, non-WAL DB), with the old error handling.
//
// Changes against the old inline SQL (same output):
//   - GROUP BY source (summary) and GROUP BY path (/pages) name the time-window
//     index (INDEXED BY idx_analytics_page_views_created, or
//     idx_analytics_page_views_vertical when a vertical is set). Without it
//     SQLite picked idx_analytics_page_views_source/_path to avoid a sort and
//     walked the whole table whatever the window.
//   - /cities and /producers use one grouped query (CTEs + ROW_NUMBER)
//     instead of correlated subqueries evaluated per result row. Ties the old
//     SQL left to the engine are broken explicitly (see each function).
//
// Pure: no database/init import (analytics-rollup-reads only loads it when no
// handle is passed, and every call here passes one). Throws on SQL errors;
// callers decide how to report them.

import type Database from "better-sqlite3";
import type { VerticalId } from "./analytics-service";
import { humanAgentViewSql } from "../database/analytics-sql";
import { notPubliclyListableAgentIdsSql } from "./agent-visibility";
import { computeTrafficReport, groupOf, type TrafficReport, type SessionRow } from "./traffic-report";
import { isPageViewStatus } from "./page-view-definition";
import { storedClientClass } from "./traffic-classifier";
import { computeQueryStats, notBotSearchSql, type QueryStats } from "./search-stats-compute";
import { computeHistoryView } from "./traffic-history-compute";
import { slugify } from "../utils/slug";
import {
  aggregateHumanReferrals,
  classifyReferralSource,
  externalReferrerSqlFilter,
  type HumanReferralPattern,
  type HumanReferralRow,
} from "./human-referrals";
import {
  getPrunedAgentViewRows,
  getPrunedAgentViewCountsByCity,
  getPrunedQueryCountsByCity,
} from "./analytics-rollup-reads";

type Db = Database.Database;

// SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" (space, no T/Z).
function sqliteDatetime(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function cutoffFor(nowMs: number, hoursBack: number): string {
  return sqliteDatetime(new Date(nowMs - hoursBack * 60 * 60 * 1000));
}

const NOT_OWNER = "(is_owner IS NULL OR is_owner = 0)";

export const PAGE_VIEWS_CREATED_INDEX = "idx_analytics_page_views_created";
export const PAGE_VIEWS_VERTICAL_INDEX = "idx_analytics_page_views_vertical";

/**
 * `INDEXED BY …` for a time-window read of analytics_page_views: the
 * (vertical_id, created_at) index when a vertical is set, else the created_at
 * index. Empty when the index is missing (minimal test schemas), because
 * INDEXED BY on a missing index is an error rather than a hint.
 */
export function pageViewsWindowIndexHint(db: Db, vertical?: VerticalId): string {
  const name = vertical ? PAGE_VIEWS_VERTICAL_INDEX : PAGE_VIEWS_CREATED_INDEX;
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ? AND tbl_name = 'analytics_page_views'")
    .get(name) as { ok: number } | undefined;
  return row ? ` INDEXED BY ${name}` : "";
}

// ── /summary, /summary/:hours ─────────────────────────────────────────

export interface AdminSummary {
  /** Page views (page-view-definition.ts), owner excluded, every client class. */
  pageViews: number;
  /** Distinct visitors (IP + browser) in the window, every client class. */
  uniqueVisitors: number;
  /** Mean length of a human visit in seconds (traffic-report.ts). */
  avgTimeOnSite: number;
  totalQueries: number;
  topSearchTerms: Array<{ query: string; count: number }>;
  /** Human visits by where they came from (classifyReferralSource key). */
  trafficBySource: Record<string, number>;
  /** Page views by AI vendor over AI search + AI crawlers. */
  agentTraffic: { chatgpt: number; claude: number; other: number };
  ownerStats: { pageViews: number; queries: number; cookieViews?: number; scriptViews?: number; unknownViews?: number };
  // ── dev-request 2026-10-13-statistikk-riktig-for-investorer, S1 ──
  /** Visits (30 min inactivity rule), every client class. */
  visits?: number;
  humanViews?: number;
  humanVisitors?: number;
  humanVisits?: number;
  aiSearchViews?: number;
  aiCrawlerViews?: number;
  /** Search engines, SEO tools, link previews, other bots, scanners and scrapers. */
  botViews?: number;
  devViews?: number;
  /** Oldest stored page view; a window reaching further back is not fully covered. */
  coverage?: { oldestRow: string | null; complete: boolean };
  /** Searches per channel (S2): web = /sok, api, mcp = AI search tools, a2a. */
  searchesByChannel?: { web: number; api: number; mcp: number; a2a: number };
  /** Searches by crawlers and other bots, not in totalQueries. */
  botSearches?: number;
}

export function emptyAdminSummary(): AdminSummary {
  return {
    pageViews: 0,
    uniqueVisitors: 0,
    avgTimeOnSite: 0,
    totalQueries: 0,
    topSearchTerms: [],
    trafficBySource: {},
    agentTraffic: { chatgpt: 0, claude: 0, other: 0 },
    ownerStats: { pageViews: 0, queries: 0 },
  };
}

// ── Searches ──────────────────────────────────────────────────────────
//
// dev-request 2026-10-13-statistikk-riktig-for-investorer, S2
// (search-tracking.ts). A search is one of:
//   web   a search on /sok of one of the three sites (first result page);
//   api   a call to a public search/discover endpoint;
//   mcp   an AI assistant's call to a search tool (analytics_mcp_calls);
//   a2a   an A2A request to the registry agent (analytics_mcp_calls).
// Owner traffic is left out. Searches by crawlers and other bots (client
// class search_engine, seo_bot, social, other_bot, scanner — and scripts on
// the web search page) are counted apart in botQueries, not in totalQueries.
// Rows written before S2 have no class and count as they are.
//
// Raw rows only (60 days); the daily history for longer windows is S3.

// Search counts per channel: search-stats-compute.ts (shared with the stored
// traffic history, which must not import this module).
export { computeQueryStats, type QueryStats, type QueryStatsOptions } from "./search-stats-compute";

// ── Summary = traffic report + search queries ──────────────────────────
//
// dev-request 2026-10-13-statistikk-riktig-for-investorer, S1: every page-view
// number comes from the one traffic report (traffic-report.ts), so the cards
// add up. Gone with it: static files, redirects and the /mcp and /a2a
// endpoints counted as page views; AI search QUERIES added to the AI page-view
// card; a bot list maintained separately from the shared classifier.
//
// Raw rows only: windows longer than the stored raw data (60 days) report what
// is stored and say so in `coverage`. The history beyond that comes in S3.

export function summaryFromReport(report: TrafficReport, q: QueryStats): AdminSummary {
  const trafficBySource: Record<string, number> = {};
  for (const e of report.human.entrySources) trafficBySource[e.key] = e.visits;
  return {
    pageViews: report.totals.views,
    uniqueVisitors: report.totals.visitors,
    avgTimeOnSite: report.human.avgVisitSeconds,
    totalQueries: q.totalQueries,
    topSearchTerms: q.topSearchTerms,
    searchesByChannel: q.byChannel,
    botSearches: q.botQueries,
    trafficBySource,
    agentTraffic: { ...report.aiVendors },
    ownerStats: {
      pageViews: report.owner.views,
      queries: q.ownerQueries,
      cookieViews: report.owner.cookieViews,
      scriptViews: report.owner.scriptViews,
      unknownViews: report.owner.unknownViews,
    },
    visits: report.totals.visits,
    humanViews: report.groups.human.views,
    humanVisitors: report.groups.human.visitors,
    humanVisits: report.groups.human.visits,
    aiSearchViews: report.groups.ai_search.views,
    aiCrawlerViews: report.groups.ai_crawler.views,
    botViews: report.groups.bot.views,
    devViews: report.groups.dev.views,
    coverage: report.coverage,
  };
}

/**
 * Body of AnalyticsService.getSummary (which adds its 2-minute cache and
 * returns zeros on error).
 */
export function computeAdminSummary(db: Db, hoursBack: number, vertical: VerticalId | undefined, nowMs: number): AdminSummary {
  return summaryFromReport(
    computeTrafficReport(db, hoursBack, vertical, nowMs),
    computeQueryStats(db, hoursBack, vertical, nowMs),
  );
}

/**
 * Body of AnalyticsService.getPageViewCount (without its cache): page views of
 * every client class in the window (traffic-report.ts).
 */
export function computePageViewCount(db: Db, hoursBack: number, vertical: VerticalId | undefined, nowMs: number): number {
  return computeTrafficReport(db, hoursBack, vertical, nowMs, { detail: false }).totals.views;
}

export interface UtmRow {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  views: number;
  sessions: number;
}

/** Body of AnalyticsService.getUtmBreakdown (see the doc comment there). */
export function computeUtmBreakdown(db: Db, hours: number, vertical: string | undefined, nowMs: number): UtmRow[] {
  const cutoff = new Date(nowMs - hours * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];
  const merged = new Map<string, UtmRow>();
  const add = (r: any) => {
    const key = `${r.utm_source}\u0000${r.utm_medium}\u0000${r.utm_campaign}`;
    const cur = merged.get(key) || { utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign: r.utm_campaign, views: 0, sessions: 0 };
    cur.views += r.views;
    cur.sessions += r.sessions;
    merged.set(key, cur);
  };
  const raw = db.prepare(`
    SELECT COALESCE(utm_source, '') AS utm_source, COALESCE(utm_medium, '') AS utm_medium,
           COALESCE(utm_campaign, '') AS utm_campaign,
           COUNT(*) AS views, COUNT(DISTINCT session_id) AS sessions
    FROM analytics_page_views
    WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)
      AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL)${V}
    GROUP BY 1, 2, 3
    ORDER BY views DESC LIMIT 200
  `).all(cutoff, ...vp) as any[];
  raw.forEach(add);
  const oldestRaw = ((db.prepare(
    "SELECT MIN(created_at) AS d FROM analytics_page_views"
  ).get() as { d: string | null } | undefined)?.d || "").slice(0, 10) || null;
  const rolled = db.prepare(`
    SELECT utm_source, utm_medium, utm_campaign,
           SUM(view_count) AS views, SUM(session_count) AS sessions
    FROM page_view_utm_daily
    WHERE day >= ? ${oldestRaw ? "AND day < ?" : ""}${V}
    GROUP BY 1, 2, 3
  `).all(...(oldestRaw ? [cutoff.slice(0, 10), oldestRaw] : [cutoff.slice(0, 10)]), ...vp) as any[];
  rolled.forEach(add);
  return [...merged.values()].sort((a, b) => b.views - a.views).slice(0, 200);
}

// ── /producers ────────────────────────────────────────────────────────

export interface TopProducerRow {
  agentId: string;
  agentName: string;
  city?: string;
  viewCount: number;
  topSource: string;
}

/**
 * Body of AnalyticsService.getTopProducers. top_source is the most common
 * view_source among the agent's human rows in the window (all cities and
 * verticals, as before), now from one grouped query instead of a correlated
 * subquery per result row. Ties, which the old SQL left to the engine, are
 * now explicit: the top source is the highest view_source among equally
 * common ones (what SQLite 3.51.3 returned for the old GROUP BY + ORDER BY
 * COUNT(*) DESC LIMIT 1), and equal view counts are ordered by agent_id,
 * agent_name, city ascending (the old order varied with the query plan).
 */
export function computeTopProducers(db: Db, limit: number, hoursBack: number, vertical: VerticalId | undefined, nowMs: number): TopProducerRow[] {
  const cutoff = cutoffFor(nowMs, hoursBack);
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];

  // dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt: an
  // `agents` row that fails the shared public-listability predicate (the
  // hidden test fixture, a dental/experiences row in `agents`) is never a
  // "top producer" — it would also become the visibility routine's runtime
  // probe target, whose /api/agents/:id/stats now 404s for it. The ids are
  // read up front (a handful of rows); with none, both queries below are
  // byte-identical to before. A failed read (minimal contexts without the
  // columns) means no exclusion, same posture as nameById below.
  let hiddenIds: string[] = [];
  try {
    hiddenIds = (db.prepare(notPubliclyListableAgentIdsSql()).all() as Array<{ id: string }>).map(r => r.id);
  } catch { /* agents.catalog_hidden/vertical_id unavailable in some minimal contexts */ }
  const H = hiddenIds.length ? ` AND agent_id NOT IN (${hiddenIds.map(() => "?").join(",")})` : "";
  const hiddenSet = new Set(hiddenIds);

  // Skive 3 (dev-request 2026-09-02-analytics-historikk-rollup-lesere-
  // foer-retention): check the pruned-day portion FIRST. When it's empty
  // (ANALYTICS_ROLLUP_READ=false, or the window hasn't reached the
  // retention boundary) the raw-only query below runs with a SQL-level LIMIT — no re-ranking risk on that (fast, common) path.
  const prunedRows = getPrunedAgentViewRows(cutoff, vertical, db).filter(p => !hiddenSet.has(p.agent_id));

  // 2026-10-04 (view-stats honesty): human, non-owner views only
  // (humanAgentViewSql — legacy unclassified rows are not counted), and
  // top_source is the most common DERIVED view_source among those same
  // rows in the same window (it used to be all-time over every row, i.e.
  // always the hard-coded 'seo').
  const rawQuery = `
    WITH g AS (
      SELECT agent_id, agent_name, city, COUNT(*) AS view_count
      FROM analytics_agent_views aav
      WHERE created_at > ? AND ${humanAgentViewSql("aav")}${V}${H}
      GROUP BY agent_id, agent_name, city
    ),
    s AS (
      SELECT aav2.agent_id, aav2.view_source, COUNT(*) AS n
      FROM analytics_agent_views aav2
      WHERE aav2.created_at > ? AND ${humanAgentViewSql("aav2")}
        AND aav2.agent_id IN (SELECT agent_id FROM g)
      GROUP BY aav2.agent_id, aav2.view_source
    ),
    t AS (
      SELECT agent_id, view_source FROM (
        SELECT agent_id, view_source,
               ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY n DESC, view_source DESC) AS rn
        FROM s
      ) WHERE rn = 1
    )
    SELECT g.agent_id, g.agent_name, g.city, g.view_count, t.view_source AS top_source
    FROM g LEFT JOIN t ON t.agent_id = g.agent_id
    ORDER BY g.view_count DESC, g.agent_id ASC, g.agent_name ASC, g.city ASC
  `;
  const params = [cutoff, ...vp, ...hiddenIds, cutoff];

  if (prunedRows.length === 0) {
    const results = db.prepare(`${rawQuery} LIMIT ?`).all(...params, limit) as any[];
    return results.map(r => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      city: r.city,
      viewCount: r.view_count,
      topSource: r.top_source || "unknown",
    }));
  }

  const rawResults = db.prepare(rawQuery).all(...params) as any[];

  interface Acc { agentId: string; agentName: string; city: string | null; viewCount: number; topSource: string; }
  const byKey = new Map<string, Acc>();
  const keyOf = (agentId: string, city: string | null | undefined) => `${agentId}::${city || ""}`;

  for (const r of rawResults) {
    byKey.set(keyOf(r.agent_id, r.city), {
      agentId: r.agent_id,
      agentName: r.agent_name,
      city: r.city,
      viewCount: r.view_count,
      topSource: r.top_source || "unknown",
    });
  }

  // agent_view_daily has no agent_name column (see its doc comment in
  // analytics-rollup-reads.ts), so an agent that only shows up via the
  // pruned rollup (no surviving raw row this window) needs its display
  // name resolved from the `agents` table, falling back to the bare
  // agent_id if that lookup fails or the agent no longer exists.
  const nameById = new Map<string, string>();
  try {
    for (const row of db.prepare(`SELECT id, name FROM agents`).all() as Array<{ id: string; name: string }>) {
      nameById.set(row.id, row.name);
    }
  } catch { /* agents table unavailable in some minimal contexts */ }

  for (const p of prunedRows) {
    const key = keyOf(p.agent_id, p.city);
    const existing = byKey.get(key);
    if (existing) {
      existing.viewCount += p.view_count;
    } else {
      byKey.set(key, {
        agentId: p.agent_id,
        agentName: nameById.get(p.agent_id) || p.agent_id,
        city: p.city || null,
        viewCount: p.view_count,
        // Known gap (unchanged): topSource for a rollup-only agent is "unknown".
        topSource: "unknown",
      });
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, limit)
    .map(v => ({ agentId: v.agentId, agentName: v.agentName, city: v.city ?? undefined, viewCount: v.viewCount, topSource: v.topSource }));
}

// ── /cities ───────────────────────────────────────────────────────────

export interface CityStatsRow {
  city: string;
  viewCount: number;
  searchQueries: number;
  topCategory: string | null;
}

/**
 * Body of AnalyticsService.getCityStats, as one grouped query: per city the
 * human profile views, the non-owner search queries in that city, and the
 * most common first category among them. Ties, which the old SQL left to
 * the engine, are now explicit: the highest category among equally common
 * ones (what SQLite 3.51.3 returned for the old subquery), and equal view
 * counts ordered by city ascending (the old order varied with the plan).
 */
export function computeCityStats(db: Db, hoursBack: number, vertical: VerticalId | undefined, nowMs: number): CityStatsRow[] {
  const cutoff = cutoffFor(nowMs, hoursBack);
  const VA = vertical ? " AND aav.vertical_id = ?" : "";
  const VQ = vertical ? " AND aq.vertical_id = ?" : "";
  // Robots' searches (crawlers following a link with a city) are not demand.
  const NB = notBotSearchSql(db, "aq");
  const vp: string[] = vertical ? [vertical] : [];

  const results = db.prepare(`
    WITH v AS (
      SELECT aav.city, COUNT(DISTINCT aav.id) AS view_count
      FROM analytics_agent_views aav
      WHERE aav.created_at > ? AND aav.city IS NOT NULL
        AND ${humanAgentViewSql("aav")}${VA}
      GROUP BY aav.city
    ),
    q AS (
      SELECT aq.city, COUNT(*) AS search_queries
      FROM analytics_queries aq
      WHERE aq.created_at > ? AND (aq.is_owner IS NULL OR aq.is_owner = 0)${VQ}${NB}
        AND aq.city IN (SELECT city FROM v)
      GROUP BY aq.city
    ),
    c AS (
      SELECT aq.city, json_extract(aq.categories, '$[0]') AS category, COUNT(*) AS n
      FROM analytics_queries aq
      WHERE aq.created_at > ? AND aq.categories IS NOT NULL AND (aq.is_owner IS NULL OR aq.is_owner = 0)${VQ}${NB}
        AND aq.city IN (SELECT city FROM v)
      GROUP BY aq.city, json_extract(aq.categories, '$[0]')
    ),
    t AS (
      SELECT city, category FROM (
        SELECT city, category,
               ROW_NUMBER() OVER (PARTITION BY city ORDER BY n DESC, category DESC) AS rn
        FROM c
      ) WHERE rn = 1
    )
    SELECT v.city, v.view_count, COALESCE(q.search_queries, 0) AS search_queries, t.category AS top_category
    FROM v
    LEFT JOIN q ON q.city = v.city
    LEFT JOIN t ON t.city = v.city
    ORDER BY v.view_count DESC, v.city ASC
  `).all(cutoff, ...vp, cutoff, ...vp, cutoff, ...vp) as any[];

  const prunedViewByCity = getPrunedAgentViewCountsByCity(cutoff, vertical, db);
  const prunedQueryByCity = getPrunedQueryCountsByCity(cutoff, vertical, db);

  if (Object.keys(prunedViewByCity).length === 0 && Object.keys(prunedQueryByCity).length === 0) {
    return results.map(r => ({
      city: r.city,
      viewCount: r.view_count,
      searchQueries: r.search_queries || 0,
      topCategory: r.top_category,
    }));
  }

  const byCity = new Map<string, CityStatsRow>();
  for (const r of results) {
    byCity.set(r.city, { city: r.city, viewCount: r.view_count, searchQueries: r.search_queries || 0, topCategory: r.top_category });
  }
  for (const [city, addViews] of Object.entries(prunedViewByCity)) {
    const existing = byCity.get(city);
    if (existing) existing.viewCount += addViews;
    else byCity.set(city, { city, viewCount: addViews, searchQueries: 0, topCategory: null });
  }
  for (const [city, addQueries] of Object.entries(prunedQueryByCity)) {
    const existing = byCity.get(city);
    if (existing) existing.searchQueries += addQueries;
    else byCity.set(city, { city, viewCount: 0, searchQueries: addQueries, topCategory: null });
  }
  // Known gap (unchanged): topCategory is not blended from the rollups.
  return [...byCity.values()].sort((a, b) => b.viewCount - a.viewCount);
}

// ── /visitors ─────────────────────────────────────────────────────────

/**
 * Body of GET /admin/analytics/visitors: the most recently active visitors of
 * every class (traffic-report.ts recentSessions), newest first. Legacy field
 * names kept (ipHash is the first 8 hex chars of the salted IP hash).
 */
export function visitorsFromReport(report: TrafficReport, limit: number, sort: "views" | "recent" = "views"): any[] {
  const list = sort === "recent" ? report.recentSessions : report.busiestSessions;
  return list.slice(0, limit).map((r: SessionRow) => ({
    ipHash: r.id,
    pageViews: r.views,
    uniquePages: r.uniquePages,
    visits: r.visits,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    source: r.entrySource,
    device: r.device,
    cls: r.cls,
    group: r.group,
    name: r.name ?? null,
    ua: r.ua ?? null,
  }));
}

export function computeVisitors(db: Db, hours: number, limit: number, vertical: VerticalId | undefined, nowMs: number): any[] {
  return visitorsFromReport(computeTrafficReport(db, hours, vertical, nowMs), limit);
}

// ── /pages ────────────────────────────────────────────────────────────

export interface TopPageRow {
  path: string;
  views: number;
  visitors: number;
  humanViews?: number;
  aiViews?: number;
  botViews?: number;
  humanVisitors?: number;
}

/**
 * Body of GET /admin/analytics/pages: pages by views (traffic-report.ts), with
 * the human / AI / bot split. Static files, redirects, errors and scanner
 * probes are not page views (page-view-definition.ts), so they never appear.
 */
export function topPagesFromReport(report: TrafficReport, limit: number): TopPageRow[] {
  return report.topPages.slice(0, limit).map((p) => ({ ...p }));
}

export function computeTopPages(db: Db, hours: number, limit: number, vertical: VerticalId | undefined, nowMs: number): TopPageRow[] {
  return topPagesFromReport(computeTrafficReport(db, hours, vertical, nowMs), limit);
}

// ── /umbrella-traffic ─────────────────────────────────────────────────

export interface UmbrellaTrafficBucket {
  id: string;
  name: string;
  umbrella_type: string;
  active_members: number;
  /** Page views of every client class on the umbrella's own profile and its members' pages. */
  pageViews_total: number;
  pageViews_via_profile: number;
  pageViews_via_members: number;
  /** The same, by people only (the shared classifier). */
  human_pageviews_profile: number;
  human_pageviews_members: number;
  /** AI assistants and AI crawlers (classifier groups ai_search + ai_crawler). */
  ai_bot_pageviews: number;
  /** People's page views arriving from a search engine (referrer Google, Bing, DuckDuckGo). */
  search_referrals: number;
}

// Slugify mirror of src/utils/slug.ts (kept inline as before so the path
// lookup stays consistent with /produsent/<slug>).
function umbrellaSlugify(text: string): string {
  return (text || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// dev-request 2026-10-13-statistikk-riktig-for-investorer, S4: «Søk-treff»
// used to count rows with source = 'search' — mostly Googlebot and bingbot —
// and «AI-bot» a token list that counted Googlebot but not ExaSearchBot. Both
// now use the shared classifier, and «Søk-treff» means people arriving from a
// search engine. Raw rows only: the windows the dashboard asks for are within
// the 60 days of raw rows (longer windows show the last 60 days).
const UMBRELLA_SEARCH_SOURCES = new Set(["google", "bing", "duckduckgo"]);

/**
 * Body of GET /admin/analytics/umbrella-traffic (see the route's comment for
 * the meaning of each counter). Sorted by pageViews_total descending.
 */
export function computeUmbrellaTraffic(db: Db, sinceHours: number, nowMs: number): UmbrellaTrafficBucket[] {
  const umbrellas = db.prepare(`
    SELECT id, name, umbrella_type
    FROM agents
    WHERE umbrella_type IS NOT NULL
      AND (is_active IS NULL OR is_active = 1)
    ORDER BY name
  `).all() as Array<{ id: string; name: string; umbrella_type: string }>;
  if (umbrellas.length === 0) return [];

  const cutoff = sqliteDatetime(new Date(nowMs - sinceHours * 3600 * 1000));
  const memberCountStmt = db.prepare(`
    SELECT COUNT(*) as c FROM agent_affiliations
    WHERE umbrella_id = ? AND status = 'active'
  `);
  const memberNamesStmt = db.prepare(`
    SELECT a.name FROM agent_affiliations af
    JOIN agents a ON a.id = af.producer_id
    WHERE af.umbrella_id = ? AND af.status = 'active'
  `);

  // Which umbrellas each producer path belongs to, as profile or as member.
  const buckets: UmbrellaTrafficBucket[] = [];
  const byPath = new Map<string, Array<{ b: UmbrellaTrafficBucket; profile: boolean }>>();
  for (const u of umbrellas) {
    const memberNames = memberNamesStmt.all(u.id) as Array<{ name: string }>;
    const b: UmbrellaTrafficBucket = {
      id: u.id, name: u.name, umbrella_type: u.umbrella_type, active_members: (memberCountStmt.get(u.id) as { c: number }).c,
      pageViews_total: 0, pageViews_via_profile: 0, pageViews_via_members: 0,
      human_pageviews_profile: 0, human_pageviews_members: 0, ai_bot_pageviews: 0, search_referrals: 0,
    };
    buckets.push(b);
    const add = (path: string, profile: boolean) => {
      if (path === "/produsent/") return; // blank name
      const list = byPath.get(path) ?? [];
      if (!list.some((x) => x.b === b)) list.push({ b, profile });
      byPath.set(path, list);
    };
    add(`/produsent/${umbrellaSlugify(u.name)}`, true);
    for (const m of memberNames) add(`/produsent/${umbrellaSlugify(m.name)}`, false);
  }

  // One read of the window's rows on those paths (path index), classified
  // per row with the shared classifier (write-time client_class, else the
  // session_id): page views only (page-view-definition.ts), owner traffic out.
  // A row that looks like a person's takes the class the traffic report gives
  // its whole session: a scanner (probes), a scraper (reading faster than a
  // person; producer pages are where scrapers go), or a session whose rows
  // from before the write-time class sit next to a non-human one.
  const reclassified = new Map(
    computeTrafficReport(db, sinceHours, undefined, nowMs, { detail: false, reclassified: true }).reclassifiedSessions ?? [],
  );
  const cols = new Set((db.prepare("PRAGMA table_info(analytics_page_views)").all() as Array<{ name: string }>).map((c) => c.name));
  const col = (name: string) => (cols.has(name) ? name : `NULL AS ${name}`);
  const paths = [...byPath.keys()];
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500);
    const rows = db.prepare(`
      SELECT path, session_id, ${col("client_class")}, ${col("referrer")}, ${col("status_code")}
      FROM analytics_page_views
      WHERE path IN (${chunk.map(() => "?").join(",")})
        AND created_at > ?
        AND (is_owner IS NULL OR is_owner = 0)
    `).raw(true).all(...chunk, cutoff) as Array<[string, string | null, string | null, string | null, number | null]>;
    for (const [path, sid, cls, referrer, status] of rows) {
      if (!isPageViewStatus(status)) continue;
      const stored = groupOf(storedClientClass(sid ?? "", cls));
      const final = stored === "human" ? reclassified.get(sid ?? "") : undefined;
      const g = final ? groupOf(final) : stored;
      const human = g === "human";
      const ai = g === "ai_search" || g === "ai_crawler";
      const fromSearch = human && UMBRELLA_SEARCH_SOURCES.has(classifyReferralSource(referrer).key);
      for (const { b, profile } of byPath.get(path) ?? []) {
        if (profile) b.pageViews_via_profile += 1; else b.pageViews_via_members += 1;
        if (human) { if (profile) b.human_pageviews_profile += 1; else b.human_pageviews_members += 1; }
        if (ai) b.ai_bot_pageviews += 1;
        if (fromSearch) b.search_referrals += 1;
      }
    }
  }
  for (const b of buckets) b.pageViews_total = b.pageViews_via_profile + b.pageViews_via_members;
  buckets.sort((a, b) => b.pageViews_total - a.pageViews_total);
  return buckets;
}

// ── /samtaler "Menneskelige besøk" strip ──────────────────────────────

/**
 * Same result as AnalyticsService.getHumanReferralPatterns (which stays as the
 * main-thread path for in-memory DBs / the kill switch), with two cheaper
 * reads: the time-window index is named, and rows whose referrer is an own
 * domain are excluded in SQL (aggregateHumanReferrals would drop them anyway,
 * see externalReferrerSqlFilter) instead of being pulled into JS first.
 */
export function computeHumanReferralPatterns(
  db: Db,
  hoursBack: number,
  vertical: VerticalId | undefined,
  nowMs: number,
): HumanReferralPattern[] {
  const cutoff = cutoffFor(nowMs, hoursBack);
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];
  const own = externalReferrerSqlFilter();

  const rows = db.prepare(`
    SELECT referrer, path, session_id, is_owner
    FROM analytics_page_views${pageViewsWindowIndexHint(db, vertical)}
    WHERE created_at > ?
      AND (is_owner IS NULL OR is_owner = 0)
      AND referrer IS NOT NULL AND TRIM(referrer) != ''${V}${own.sql}
  `).all(cutoff, ...vp, ...own.params) as HumanReferralRow[];

  if (rows.length === 0) return [];

  // slug→name map from PUBLIC agent names (same as the main-thread path).
  const producerNameBySlug = new Map<string, string>();
  try {
    const agents = db.prepare(`SELECT name FROM agents`).all() as Array<{ name: string }>;
    for (const a of agents) {
      if (!a.name) continue;
      const s = slugify(a.name);
      if (s && !producerNameBySlug.has(s)) producerNameBySlug.set(s, a.name);
    }
  } catch { /* agents table not present in some minimal contexts — degrade to unnamed */ }

  return aggregateHumanReferrals(rows, { producerNameBySlug });
}

// ── Worker task dispatch ──────────────────────────────────────────────

/** One admin-dashboard read; JSON-serialisable (it crosses the worker boundary and is the cache key). */
export type AdminStatsQuery =
  // dev-request 2026-10-13-statistikk-riktig-for-investorer, S1: one report
  // per (window, vertical) feeds the summary cards, /traffic-classification,
  // /hourly, /devices, /referrers, /pages and /visitors, so they share one
  // cache entry and one computation.
  | { name: "trafficReport"; hours: number; vertical?: VerticalId }
  | { name: "queryStats"; hours: number; vertical?: VerticalId }
  | { name: "summary24"; vertical?: VerticalId }
  | { name: "summary"; hours: number; vertical?: VerticalId }
  | { name: "producers"; limit: number; hours: number; vertical?: VerticalId }
  | { name: "cities"; hours: number; vertical?: VerticalId }
  | { name: "visitors"; hours: number; limit: number; vertical?: VerticalId }
  | { name: "pages"; hours: number; limit: number; vertical?: VerticalId }
  | { name: "umbrellaTraffic"; sinceHours: number }
  // /samtaler referral strip (skive 4); cached 30–60 min by samtaler-strip.ts.
  | { name: "humanReferrals"; hours: number; vertical?: VerticalId }
  // Stored history beyond the raw window (S3): `days` = the last N days up to
  // yesterday, null = every stored day; plus every stored week and month.
  | { name: "trafficHistory"; days: number | null; vertical?: VerticalId };

/**
 * GET /admin/analytics/summary's three numbers: the 24 h summary, the human
 * visits of the last 30 days (`monthly_visits`; it used to be every stored row
 * of 30 days, static files and crawlers included) and the 24 h UTM table.
 */
export interface Summary24Result {
  summary: AdminSummary;
  monthlyVisits: number;
  utm: UtmRow[];
}

/** Human visits in the last 30 days (traffic-report.ts definitions). */
export function computeMonthlyHumanVisits(db: Db, vertical: VerticalId | undefined, nowMs: number): number {
  return computeTrafficReport(db, 24 * 30, vertical, nowMs, { detail: false }).groups.human.visits;
}

export function runAdminStatsQuery(db: Db, query: AdminStatsQuery, nowMs: number): unknown {
  switch (query.name) {
    case "trafficReport":
      return computeTrafficReport(db, query.hours, query.vertical, nowMs);
    case "queryStats":
      return computeQueryStats(db, query.hours, query.vertical, nowMs);
    case "summary24":
      return {
        summary: computeAdminSummary(db, 24, query.vertical, nowMs),
        monthlyVisits: computeMonthlyHumanVisits(db, query.vertical, nowMs),
        utm: computeUtmBreakdown(db, 24, query.vertical, nowMs),
      } satisfies Summary24Result;
    case "summary":
      return computeAdminSummary(db, query.hours, query.vertical, nowMs);
    case "producers":
      return computeTopProducers(db, query.limit, query.hours, query.vertical, nowMs);
    case "cities":
      return computeCityStats(db, query.hours, query.vertical, nowMs);
    case "visitors":
      return computeVisitors(db, query.hours, query.limit, query.vertical, nowMs);
    case "pages":
      return computeTopPages(db, query.hours, query.limit, query.vertical, nowMs);
    case "umbrellaTraffic":
      return computeUmbrellaTraffic(db, query.sinceHours, nowMs);
    case "humanReferrals":
      return computeHumanReferralPatterns(db, query.hours, query.vertical, nowMs);
    case "trafficHistory":
      return computeHistoryView(db, query.days, query.vertical ?? "all", nowMs);
    default:
      throw new Error(`unknown admin stats query: ${JSON.stringify(query)}`);
  }
}
