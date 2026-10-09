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
import { classifyUA, uaFromSessionId, aiVendorBucket } from "./traffic-classifier";
import {
  getPrunedPageViewCount,
  getPrunedPageViewsBySource,
  getPrunedSessionsTotal,
  getPrunedQueryCount,
  getPrunedTopQueryTerms,
  getPrunedChatgptClaudeCounts,
  getPrunedQueryCountsByAgent,
  getPrunedAgentViewRows,
  getPrunedAgentViewCountsByCity,
  getPrunedQueryCountsByCity,
  getPrunedPageViewsByPath,
  getPrunedExactPathViewCount,
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
  pageViews: number;
  uniqueVisitors: number;
  avgTimeOnSite: number;
  totalQueries: number;
  topSearchTerms: Array<{ query: string; count: number }>;
  trafficBySource: Record<string, number>;
  agentTraffic: { chatgpt: number; claude: number; other: number };
  ownerStats: { pageViews: number; queries: number };
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

/**
 * Body of AnalyticsService.getSummary (which adds its 2-minute cache and
 * returns zeros on error).
 */
export function computeAdminSummary(db: Db, hoursBack: number, vertical: VerticalId | undefined, nowMs: number): AdminSummary {
  const cutoff = cutoffFor(nowMs, hoursBack);

  // Vertical filter fragment — appended to every per-table WHERE clause.
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];

  // Page views (excluding owner)
  // Skive 3 (dev-request 2026-09-02-analytics-historikk-rollup-lesere-
  // foer-retention): every raw COUNT()/GROUP BY below only sees whatever
  // auto-prune hasn't yet rolled up + deleted. Each is blended with its
  // pruned-day rollup portion from analytics-rollup-reads.ts — a no-op
  // (+0 / unchanged) when the window is entirely still in raw, or when
  // ANALYTICS_ROLLUP_READ=false (instant-rollback path). ownerPageViews/
  // ownerQueries and avgTimeOnSite below are NOT blended — owner (is_owner=1)
  // rows are excluded from every rollup write by design (retention-
  // service.ts), so their pruned-day history is genuinely gone forever;
  // and avgTimeOnSite needs per-session first/last-seen timestamps rollup
  // tables never captured. Both are documented known gaps, not oversights.
  const pvResult = db.prepare(`
    SELECT COUNT(*) as count FROM analytics_page_views WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)${V}
  `).get(cutoff, ...vp) as any;
  const pageViews = (pvResult.count as number) + getPrunedPageViewCount(cutoff, vertical, db);

  // Owner page views
  const ownerPvResult = db.prepare(`
    SELECT COUNT(*) as count FROM analytics_page_views WHERE created_at > ? AND is_owner = 1${V}
  `).get(cutoff, ...vp) as any;
  const ownerPageViews = ownerPvResult.count;

  // Unique visitors (excluding owner)
  const uvResult = db.prepare(`
    SELECT COUNT(DISTINCT session_id) as count FROM analytics_page_views WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)${V}
  `).get(cutoff, ...vp) as any;
  const uniqueVisitors = (uvResult.count as number) + getPrunedSessionsTotal(cutoff, vertical, db);

  // Traffic by source (excluding owner). INDEXED BY (skive 3, serverheng):
  // without it SQLite walks idx_analytics_page_views_source — the whole
  // table — to skip the GROUP BY sort, whatever the window.
  const sourceResult = db.prepare(`
    SELECT source, COUNT(*) as count FROM analytics_page_views${pageViewsWindowIndexHint(db, vertical)}
    WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)${V}
    GROUP BY source
  `).all(cutoff, ...vp) as any[];
  const trafficBySource: Record<string, number> = {};
  sourceResult.forEach(row => {
    trafficBySource[row.source] = row.count;
  });
  const prunedBySource = getPrunedPageViewsBySource(cutoff, vertical, db);
  for (const [source, count] of Object.entries(prunedBySource)) {
    trafficBySource[source] = (trafficBySource[source] || 0) + count;
  }

  // Total queries (excluding owner)
  const qResult = db.prepare(`
    SELECT COUNT(*) as count FROM analytics_queries WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)${V}
  `).get(cutoff, ...vp) as any;
  const totalQueries = (qResult.count as number) + getPrunedQueryCount(cutoff, vertical, db);

  // Owner queries
  const ownerQResult = db.prepare(`
    SELECT COUNT(*) as count FROM analytics_queries WHERE created_at > ? AND is_owner = 1${V}
  `).get(cutoff, ...vp) as any;
  const ownerQueries = ownerQResult.count;

  // Top search terms (excluding owner, excluding single-char autocomplete noise)
  const topQueriesResult = db.prepare(`
    SELECT query, COUNT(*) as count FROM analytics_queries
    WHERE created_at > ?
      AND query IS NOT NULL
      AND LENGTH(TRIM(query)) >= 2
      AND (is_owner IS NULL OR is_owner = 0)${V}
    GROUP BY query
    ORDER BY count DESC
    LIMIT 10
  `).all(cutoff, ...vp) as any[];
  // Blend in the pruned-day portion (query_text_daily has no <2-char
  // filter to replicate — trackSearchQuery() never wrote single-char
  // rows in the first place, see the skip-autocomplete-noise comment at
  // the insert site — so nothing here can reintroduce that noise), then
  // re-sort/re-limit exactly like the raw-only query already does.
  const termTotals = new Map<string, number>();
  for (const r of topQueriesResult) termTotals.set(r.query, (termTotals.get(r.query) || 0) + r.count);
  for (const r of getPrunedTopQueryTerms(cutoff, vertical, db)) termTotals.set(r.query, (termTotals.get(r.query) || 0) + r.count);
  const topSearchTerms = [...termTotals.entries()]
    .map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // AI agent traffic breakdown
  // WHY: bots overwhelmingly produce page views, not search queries, so the
  // old agent_id read from analytics_queries always came back ~0 even when
  // GPTBot and ClaudeBot were hammering the site. session_id is stored as
  // `${ipHash}:${userAgent}`, so we can scan it for crawler UA tokens and
  // get a truthful read on AI visibility.
  // Response shape (chatgpt/claude/other) is kept for compatibility, but
  // membership is now decided by the SHARED classifier
  // (src/services/traffic-classifier.ts): a session counts as AI traffic
  // iff it classifies as ai_search (`*-User` retrieval) or ai_crawler.
  // NOTE (slice A honesty fix): plain search-engine crawlers (Googlebot,
  // DuckDuckBot, …) used to be folded into `other` here — they are now
  // search_engine, not AI, so they no longer inflate this number.
  const agentTraffic = { chatgpt: 0, claude: 0, other: 0 };
  const aiSessions = db.prepare(`
    SELECT session_id, COUNT(*) as count FROM analytics_page_views
    WHERE created_at > ? AND ${"(is_owner IS NULL OR is_owner = 0)"}${V}
    GROUP BY session_id
  `).all(cutoff, ...vp) as any[];
  for (const row of aiSessions) {
    const ua = uaFromSessionId(row.session_id);
    const category = classifyUA(ua);
    if (category !== "ai_search" && category !== "ai_crawler") continue;
    agentTraffic[aiVendorBucket(ua)] += row.count;
  }
  // Skive 3: blend in the pruned-day chatgpt/claude portion from
  // page_view_daily's bot_type dimension — the token sets are identical
  // to the regexes just above. `other` is NOT blended: rollup's
  // 'other_bot' bucket uses a different, broader UA match than this
  // classifier's ai_search/ai_crawler "other" residue (see
  // getPrunedChatgptClaudeCounts's doc comment) — documented known gap.
  const prunedAgentTraffic = getPrunedChatgptClaudeCounts(cutoff, { vertical, db });
  agentTraffic.chatgpt += prunedAgentTraffic.chatgpt;
  agentTraffic.claude += prunedAgentTraffic.claude;

  // Back-compat: if the analytics_queries table has search-query hits from
  // explicitly named agents (ChatGPT/Claude), fold those in too so we don't
  // under-count real search-query traffic that also happens to be AI.
  const agentQueryResult = db.prepare(`
    SELECT agent_id, COUNT(*) as count FROM analytics_queries
    WHERE created_at > ? AND agent_id IS NOT NULL${V}
    GROUP BY agent_id
  `).all(cutoff, ...vp) as any[];
  agentQueryResult.forEach(row => {
    if (row.agent_id === "ChatGPT") agentTraffic.chatgpt += row.count;
    else if (row.agent_id === "Claude") agentTraffic.claude += row.count;
    else agentTraffic.other += row.count;
  });
  // Skive 3: same back-compat fold, for the pruned-day portion of
  // analytics_queries (query_daily.agent_id is an exact string match,
  // same as the raw column, so this reproduces the loop above exactly).
  getPrunedQueryCountsByAgent(cutoff, vertical, db).forEach(row => {
    if (row.agent_id === "ChatGPT") agentTraffic.chatgpt += row.count;
    else if (row.agent_id === "Claude") agentTraffic.claude += row.count;
    else agentTraffic.other += row.count;
  });

  // Average time on site (seconds) — approximation from session page-view spans.
  // WHY: we don't have explicit beacons/pagehide tracking, but session_id is
  // stable per visitor, so for any multi-pageview session we can take
  // (last_view - first_view) as a lower-bound for time spent. We cap each
  // session at 1800s (30 min) to filter "tab left open overnight" outliers,
  // and we exclude single-pageview sessions from the numerator because they
  // give us no duration signal at all — they show up as bounces in
  // uniqueVisitors but shouldn't drag the average to zero. Bots (session_id
  // containing a UA token like GPTBot/ClaudeBot) are excluded so we measure
  // human dwell time only.
  let avgTimeOnSite = 0;
  try {
    const durRow = db.prepare(`
      SELECT AVG(dur) as avg_dur FROM (
        SELECT MIN(
          1800,
          CAST((julianday(MAX(created_at)) - julianday(MIN(created_at))) * 86400 AS INTEGER)
        ) as dur
        FROM analytics_page_views
        WHERE created_at > ?
          AND (is_owner IS NULL OR is_owner = 0)
          AND session_id IS NOT NULL
          AND session_id NOT LIKE '%GPTBot%'
          AND session_id NOT LIKE '%ClaudeBot%'
          AND session_id NOT LIKE '%Claude-User%'
          AND session_id NOT LIKE '%ChatGPT%'
          AND session_id NOT LIKE '%bot%'
          AND session_id NOT LIKE '%Bot%'
          AND session_id NOT LIKE '%crawler%'
          AND session_id NOT LIKE '%spider%'${V}
        GROUP BY session_id
        HAVING COUNT(*) >= 2
      )
    `).get(cutoff, ...vp) as any;
    avgTimeOnSite = Math.round(durRow?.avg_dur || 0);
  } catch (e) {
    // Non-fatal: keep avgTimeOnSite at 0 rather than failing the whole summary.
    console.warn("[analytics] avgTimeOnSite calculation skipped:", (e as Error).message);
  }

  return {
    pageViews,
    uniqueVisitors,
    avgTimeOnSite,
    totalQueries,
    topSearchTerms,
    trafficBySource,
    agentTraffic,
    ownerStats: { pageViews: ownerPageViews, queries: ownerQueries },
  };
}

/** Body of AnalyticsService.getPageViewCount (without its cache). */
export function computePageViewCount(db: Db, hoursBack: number, vertical: VerticalId | undefined, nowMs: number): number {
  const cutoff = cutoffFor(nowMs, hoursBack);
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM analytics_page_views WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)${V}
  `).get(cutoff, ...vp) as any;
  return (result.count as number) + getPrunedPageViewCount(cutoff, vertical, db);
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
      WHERE aq.created_at > ? AND (aq.is_owner IS NULL OR aq.is_owner = 0)${VQ}
        AND aq.city IN (SELECT city FROM v)
      GROUP BY aq.city
    ),
    c AS (
      SELECT aq.city, json_extract(aq.categories, '$[0]') AS category, COUNT(*) AS n
      FROM analytics_queries aq
      WHERE aq.created_at > ? AND aq.categories IS NOT NULL AND (aq.is_owner IS NULL OR aq.is_owner = 0)${VQ}
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

/** Body of GET /admin/analytics/visitors. */
export function computeVisitors(db: Db, hours: number, limit: number, vertical: VerticalId | undefined, nowMs: number): any[] {
  const cutoff = cutoffFor(nowMs, hours);
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];
  return db.prepare(`
    SELECT
      session_id as ipHash,
      COUNT(*) as pageViews,
      COUNT(DISTINCT path) as uniquePages,
      MIN(created_at) as firstSeen,
      MAX(created_at) as lastSeen,
      source,
      CASE
        WHEN session_id LIKE '%mobile%' OR session_id LIKE '%iphone%' THEN 'mobile'
        WHEN session_id LIKE '%tablet%' OR session_id LIKE '%ipad%' THEN 'tablet'
        ELSE 'desktop'
      END as device
    FROM analytics_page_views
    WHERE created_at > ? AND ${NOT_OWNER}${V}
    GROUP BY session_id
    ORDER BY pageViews DESC
    LIMIT ?
  `).all(cutoff, ...vp, limit) as any[];
}

// ── /pages ────────────────────────────────────────────────────────────

/**
 * Automated vulnerability-scanner paths, excluded from the top-pages list
 * (bots probing for WordPress/PHP installs are not signal).
 */
export const TOP_PAGES_SCANNER_PATTERNS = [
  "%wp-admin%", "%wp-login%", "%wp-includes%", "%wordpress%",
  "%wlwmanifest%", "%xmlrpc%", "%/.env%", "%/.git%",
  "%phpunit%", "%phpinfo%", "%setup-config%",
];

export interface TopPageRow {
  path: string;
  views: number;
  visitors: number;
}

/** Body of GET /admin/analytics/pages (raw window + pruned-day rollup blend). */
export function computeTopPages(db: Db, hours: number, limit: number, vertical: VerticalId | undefined, nowMs: number): TopPageRow[] {
  const cutoff = cutoffFor(nowMs, hours);
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];
  const SCANNER_PATTERNS = TOP_PAGES_SCANNER_PATTERNS;
  const scannerExclusion = SCANNER_PATTERNS.map(() => "path NOT LIKE ?").join(" AND ");

  const prunedPages = getPrunedPageViewsByPath(cutoff, vertical, SCANNER_PATTERNS, db);

  // INDEXED BY: without it SQLite walks idx_analytics_page_views_path (whole
  // table) to skip the GROUP BY sort, whatever the window.
  const rawQuery = `
    SELECT
      path,
      COUNT(*) as views,
      COUNT(DISTINCT session_id) as visitors
    FROM analytics_page_views${pageViewsWindowIndexHint(db, vertical)}
    WHERE created_at > ? AND ${NOT_OWNER}${V}
      AND (${scannerExclusion})
    GROUP BY path
    ORDER BY views DESC, path ${vertical ? "DESC" : "ASC"}
  `;

  if (prunedPages.length === 0) {
    return db.prepare(`${rawQuery} LIMIT ?`).all(cutoff, ...vp, ...SCANNER_PATTERNS, limit) as any[];
  }
  const rawPages = db.prepare(rawQuery).all(cutoff, ...vp, ...SCANNER_PATTERNS) as any[];
  const byPath = new Map<string, TopPageRow>();
  for (const p of rawPages) byPath.set(p.path, { path: p.path, views: p.views, visitors: p.visitors });
  for (const p of prunedPages) {
    const existing = byPath.get(p.path);
    if (existing) {
      existing.views += p.views;
      existing.visitors += p.visitors; // approximation — see getPrunedPageViewsByPath
    } else {
      byPath.set(p.path, { path: p.path, views: p.views, visitors: p.visitors });
    }
  }
  return [...byPath.values()].sort((a, b) => b.views - a.views).slice(0, limit);
}

// ── /umbrella-traffic ─────────────────────────────────────────────────

export interface UmbrellaTrafficBucket {
  id: string;
  name: string;
  umbrella_type: string;
  active_members: number;
  pageViews_total: number;
  pageViews_via_profile: number;
  pageViews_via_members: number;
  ai_bot_pageviews: number;
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

// AI / bot UA tokens — the same bucket as producer-outcomes.
const UMBRELLA_AI_TOKENS = [
  "GPTBot", "ChatGPT", "OAI-SearchBot",
  "ClaudeBot", "Claude-User", "Anthropic",
  "Googlebot", "Google-Extended", "Gemini",
  "PerplexityBot", "Perplexity-User",
  "Bytespider", "CCBot", "Applebot", "YandexBot", "bingbot",
];

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
  const aiClause = UMBRELLA_AI_TOKENS.map(() => "session_id LIKE ?").join(" OR ");
  const aiParams = UMBRELLA_AI_TOKENS.map(t => `%${t}%`);

  const memberCountStmt = db.prepare(`
    SELECT COUNT(*) as c FROM agent_affiliations
    WHERE umbrella_id = ? AND status = 'active'
  `);
  const memberNamesStmt = db.prepare(`
    SELECT a.name FROM agent_affiliations af
    JOIN agents a ON a.id = af.producer_id
    WHERE af.umbrella_id = ? AND af.status = 'active'
  `);

  const out: UmbrellaTrafficBucket[] = [];
  for (const u of umbrellas) {
    const activeMembers = (memberCountStmt.get(u.id) as { c: number }).c;
    const memberNames = memberNamesStmt.all(u.id) as Array<{ name: string }>;

    const umbrellaPath = `/produsent/${umbrellaSlugify(u.name)}`;
    const memberPaths = memberNames
      .map(m => `/produsent/${umbrellaSlugify(m.name)}`)
      .filter(p => p !== "/produsent/"); // skip blank-name members

    const profileRow = db.prepare(`
      SELECT COUNT(*) as c FROM analytics_page_views
      WHERE path = ?
        AND created_at > ?
        AND (is_owner IS NULL OR is_owner = 0)
    `).get(umbrellaPath, cutoff) as { c: number };
    const pageViews_via_profile = profileRow.c + getPrunedExactPathViewCount([umbrellaPath], cutoff, {}, db);

    let pageViews_via_members = 0;
    if (memberPaths.length > 0) {
      const placeholders = memberPaths.map(() => "?").join(",");
      const memberRow = db.prepare(`
        SELECT COUNT(*) as c FROM analytics_page_views
        WHERE path IN (${placeholders})
          AND created_at > ?
          AND (is_owner IS NULL OR is_owner = 0)
      `).get(...memberPaths, cutoff) as { c: number };
      pageViews_via_members = memberRow.c + getPrunedExactPathViewCount(memberPaths, cutoff, {}, db);
    }

    // ai_bot_pageviews: NOT blended with the rollups (documented known gap).
    const allPaths = [umbrellaPath, ...memberPaths];
    const pathPlaceholders = allPaths.map(() => "?").join(",");
    const aiRow = db.prepare(`
      SELECT COUNT(*) as c FROM analytics_page_views
      WHERE path IN (${pathPlaceholders})
        AND created_at > ?
        AND (is_owner IS NULL OR is_owner = 0)
        AND (${aiClause})
    `).get(...allPaths, cutoff, ...aiParams) as { c: number };
    const ai_bot_pageviews = aiRow.c;

    const searchRow = db.prepare(`
      SELECT COUNT(*) as c FROM analytics_page_views
      WHERE path IN (${pathPlaceholders})
        AND created_at > ?
        AND (is_owner IS NULL OR is_owner = 0)
        AND source = 'search'
    `).get(...allPaths, cutoff) as { c: number };
    const search_referrals = searchRow.c + getPrunedExactPathViewCount(allPaths, cutoff, { source: "search" }, db);

    out.push({
      id: u.id,
      name: u.name,
      umbrella_type: u.umbrella_type,
      active_members: activeMembers,
      pageViews_total: pageViews_via_profile + pageViews_via_members,
      pageViews_via_profile,
      pageViews_via_members,
      ai_bot_pageviews,
      search_referrals,
    });
  }
  out.sort((a, b) => b.pageViews_total - a.pageViews_total);
  return out;
}

// ── Worker task dispatch ──────────────────────────────────────────────

/** One admin-dashboard read; JSON-serialisable (it crosses the worker boundary and is the cache key). */
export type AdminStatsQuery =
  | { name: "summary24"; vertical?: VerticalId }
  | { name: "summary"; hours: number; vertical?: VerticalId }
  | { name: "producers"; limit: number; hours: number; vertical?: VerticalId }
  | { name: "cities"; hours: number; vertical?: VerticalId }
  | { name: "visitors"; hours: number; limit: number; vertical?: VerticalId }
  | { name: "pages"; hours: number; limit: number; vertical?: VerticalId }
  | { name: "umbrellaTraffic"; sinceHours: number };

/** GET /admin/analytics/summary's three numbers (24 h summary, 30-day visits, 24 h UTM). */
export interface Summary24Result {
  summary: AdminSummary;
  monthlyVisits: number;
  utm: UtmRow[];
}

export function runAdminStatsQuery(db: Db, query: AdminStatsQuery, nowMs: number): unknown {
  switch (query.name) {
    case "summary24":
      return {
        summary: computeAdminSummary(db, 24, query.vertical, nowMs),
        monthlyVisits: computePageViewCount(db, 24 * 30, query.vertical, nowMs),
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
    default:
      throw new Error(`unknown admin stats query: ${JSON.stringify(query)}`);
  }
}
