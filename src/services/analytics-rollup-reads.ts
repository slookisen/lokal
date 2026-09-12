/**
 * analytics-rollup-reads.ts — Skive 3 of dev-request
 * 2026-09-02-analytics-historikk-rollup-lesere-foer-retention.
 *
 * Skive 1/2 taught runAutoPrune() to roll analytics_page_views /
 * analytics_queries / analytics_agent_views up into four permanent daily
 * tables (page_view_daily, query_daily, query_text_daily, agent_view_daily,
 * plus sessions_daily) BEFORE deleting the raw rows. But every stats reader
 * in the codebase still queried ONLY the raw tables — so a dashboard window
 * that reaches back past the retention cutoff silently went from "true
 * historical number" to "whatever's left in raw", with no error and no
 * visible sign anything was missing.
 *
 * This module is the shared blend layer: one small function PER DIMENSION
 * a reader needs (page-view count, top pages, city stats, …), each doing
 * the same thing:
 *   1. Ask retention-service.ts's getRollupBoundaryDate() for the earliest
 *      day still in the raw table for that table family.
 *   2. If the requested window doesn't reach past that boundary (or the
 *      ANALYTICS_ROLLUP_READ flag is off), do nothing — the raw query the
 *      caller already runs is the complete, correct answer, unchanged.
 *   3. Otherwise, query the matching rollup table for ONLY the sub-range
 *      before the boundary and return it for the caller to ADD to its raw
 *      result. Days are never double-counted because the raw side (by
 *      construction — see retention-service.ts's file-level invariant) only
 *      ever contains days >= boundary, and every function here only ever
 *      queries days < boundary.
 *
 * Callers ADD these numbers to their own raw-table query result; they never
 * replace it. When ANALYTICS_ROLLUP_READ=false, every function here returns
 * the zero/empty value, so callers reproduce their exact pre-Skive-3
 * raw-only behaviour (the instant-rollback path).
 *
 * Known, documented gap: several rollup tables/dimensions cannot exactly
 * reproduce a raw-table-only reader — see each function's doc comment and
 * the Skive 3 completion report for the full list (e.g. hour-level detail,
 * per-session identity, referrer URLs, raw UA strings, status_code, and the
 * "other AI" bot bucket some readers compute from a marker list that doesn't
 * line up 1:1 with retention-service.ts's coarser BOT_TYPE_CASE). Those stay
 * raw-only on purpose — Skive 3 does not invent new rollup columns.
 */

import { getDb } from "../database/init";
import { getRollupBoundaryDate, isAnalyticsRollupReadEnabled } from "./retention-service";
import type { VerticalId } from "./analytics-service";

type RawTable = "analytics_page_views" | "analytics_queries" | "analytics_agent_views";

interface PrunedWindow {
  /** Inclusive start day (YYYY-MM-DD) of the rollup-side sub-range. */
  fromDay: string;
  /** Exclusive end day (YYYY-MM-DD) — the raw table's current floor. */
  boundary: string;
}

/**
 * Resolves the rollup-side sub-range of [cutoffIso, now) that has already
 * been pruned from `table`, or null when there is nothing to blend (flag
 * off, or the whole requested window is still in raw). `cutoffIso` is a
 * SQLite-format datetime string ("YYYY-MM-DD HH:MM:SS") — same shape every
 * caller already computes for its raw `created_at > cutoff` query.
 */
function resolvePrunedWindow(cutoffIso: string, table: RawTable, dbHandle?: ReturnType<typeof getDb>): PrunedWindow | null {
  if (!isAnalyticsRollupReadEnabled()) return null;
  const fromDay = cutoffIso.slice(0, 10);
  const boundary = getRollupBoundaryDate(table, dbHandle);
  if (fromDay >= boundary) return null; // entire window is still in raw
  return { fromDay, boundary };
}

/**
 * Runs `fn(window, db)` guarded by resolvePrunedWindow + a try/catch,
 * returning `fallback` otherwise. `dbHandle` is optional — most readers use
 * the global getDb() singleton (the default), but a couple (owner-stats-
 * service.ts, profile-activity-service.ts) are deliberately parameterized on
 * an explicit `db` handle instead, so `fn` always gets a concrete handle to
 * query with rather than reaching for the global itself.
 */
function withPrunedWindow<T>(
  cutoffIso: string,
  table: RawTable,
  fallback: T,
  fn: (w: PrunedWindow, db: ReturnType<typeof getDb>) => T,
  dbHandle?: ReturnType<typeof getDb>
): T {
  const w = resolvePrunedWindow(cutoffIso, table, dbHandle);
  if (!w) return fallback;
  try {
    return fn(w, dbHandle ?? getDb());
  } catch (err) {
    console.error("[analytics-rollup-reads] blend query failed, falling back to raw-only:", err);
    return fallback;
  }
}

// ═════════════════════════════════════════════════════════════════
// page_view_daily blends
// ═════════════════════════════════════════════════════════════════

/** Pruned-day portion of a plain page-view count (AnalyticsService.getPageViewCount). */
export function getPrunedPageViewCount(cutoffIso: string, vertical?: VerticalId): number {
  return withPrunedWindow(cutoffIso, "analytics_page_views", 0, (w) => {
    const db = getDb();
    const V = vertical ? " AND vertical_id = ?" : "";
    const vp: string[] = vertical ? [vertical] : [];
    const row = db.prepare(`
      SELECT COALESCE(SUM(view_count), 0) as c FROM page_view_daily
      WHERE day >= ? AND day < ?${V}
    `).get(w.fromDay, w.boundary, ...vp) as { c: number };
    return row.c || 0;
  });
}

/** Pruned-day portion of page views grouped by `source` (AnalyticsService.getSummary.trafficBySource). */
export function getPrunedPageViewsBySource(cutoffIso: string, vertical?: VerticalId): Record<string, number> {
  return withPrunedWindow(cutoffIso, "analytics_page_views", {} as Record<string, number>, (w) => {
    const db = getDb();
    const V = vertical ? " AND vertical_id = ?" : "";
    const vp: string[] = vertical ? [vertical] : [];
    const rows = db.prepare(`
      SELECT source, SUM(view_count) as c FROM page_view_daily
      WHERE day >= ? AND day < ?${V}
      GROUP BY source
    `).all(w.fromDay, w.boundary, ...vp) as Array<{ source: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.source] = r.c || 0;
    return out;
  });
}

/**
 * Pruned-day portion of page views grouped by bot_type, restricted to
 * 'chatgpt'/'claude' — the ONLY two rollup bot_type buckets whose UA-token
 * set (see retention-service.ts's BOT_TYPE_CASE) is byte-identical to every
 * reader's own AI_MARKERS.chatgpt/.claude list (GPTBot/ChatGPT/OAI-SearchBot
 * and ClaudeBot/Claude-User/Anthropic respectively). Used by
 * AnalyticsService.getSummary.agentTraffic AND by every per-agent/per-path
 * reader's chatgpt/claude buckets (agent-stats.ts, owner-stats-service.ts,
 * profile-activity-service.ts, gardssalg-owner-stats-service.ts).
 *
 * Deliberately does NOT extend to an "other AI" bucket: rollup's
 * 'other_bot' classification is a broader/different token match than any
 * reader's own "other" AI marker list (e.g. Gemini, Perplexity-User,
 * YandexAdditional and NotHumanSearch all fall into rollup bot_type='human'
 * instead of 'other_bot' — no substring match on "bot"/"spider"/"crawl").
 * That mismatch makes an "other" blend actively wrong rather than merely
 * incomplete, so it is left as a documented, raw-only known gap instead.
 */
export function getPrunedChatgptClaudeCounts(
  cutoffIso: string,
  opts: { path?: string; vertical?: VerticalId; db?: ReturnType<typeof getDb> } = {}
): { chatgpt: number; claude: number } {
  const zero = { chatgpt: 0, claude: 0 };
  return withPrunedWindow(cutoffIso, "analytics_page_views", zero, (w, db) => {
    const conds: string[] = ["day >= ?", "day < ?", "bot_type IN ('chatgpt','claude')"];
    const params: string[] = [w.fromDay, w.boundary];
    if (opts.path) { conds.push("path = ?"); params.push(opts.path); }
    if (opts.vertical) { conds.push("vertical_id = ?"); params.push(opts.vertical); }
    const rows = db.prepare(`
      SELECT bot_type, SUM(view_count) as c FROM page_view_daily
      WHERE ${conds.join(" AND ")}
      GROUP BY bot_type
    `).all(...params) as Array<{ bot_type: string; c: number }>;
    const out = { ...zero };
    for (const r of rows) {
      if (r.bot_type === "chatgpt") out.chatgpt = r.c || 0;
      else if (r.bot_type === "claude") out.claude = r.c || 0;
    }
    return out;
  }, opts.db);
}

/**
 * Pruned-day portion of page views grouped by path (AnalyticsService's
 * top-pages callers / GET /admin/analytics/pages). `excludeLikePatterns`
 * mirrors the route's own scanner-path exclusion so a pruned-day scanner hit
 * doesn't leak back into the top-pages list after being filtered out today.
 * Also returns session_count (page_view_daily's PER-PATH distinct-session
 * count) so the route's "visitors" column can be summed the same way it
 * already sums raw session_id-distinct counts across days — both are
 * approximations of the same "how many distinct sessions hit this path"
 * question, and summing per-day/per-path counts across days can only ever
 * OVER-state true distinct visitors (a repeat visitor across days is counted
 * once per day) — that is an accepted, pre-existing approximation, not one
 * introduced here (see the module doc's "combine (sum)" instruction).
 */
export function getPrunedPageViewsByPath(
  cutoffIso: string,
  vertical: VerticalId | undefined,
  excludeLikePatterns: string[]
): Array<{ path: string; views: number; visitors: number }> {
  return withPrunedWindow(cutoffIso, "analytics_page_views", [], (w) => {
    const db = getDb();
    const V = vertical ? " AND vertical_id = ?" : "";
    const vp: string[] = vertical ? [vertical] : [];
    const excl = excludeLikePatterns.length
      ? " AND " + excludeLikePatterns.map(() => "path NOT LIKE ?").join(" AND ")
      : "";
    const rows = db.prepare(`
      SELECT path, SUM(view_count) as views, SUM(session_count) as visitors
      FROM page_view_daily
      WHERE day >= ? AND day < ?${V}${excl}
      GROUP BY path
    `).all(w.fromDay, w.boundary, ...vp, ...excludeLikePatterns) as Array<{ path: string; views: number; visitors: number }>;
    return rows;
  });
}

/**
 * Pruned-day portion of an exact-path (or IN-list) page-view count, optionally
 * filtered by `source` — used by GET /admin/analytics/umbrella-traffic's
 * pageViews_via_profile / pageViews_via_members / search_referrals, which all
 * query exact paths (page_view_daily's `path` column matches 1:1).
 *
 * ai_bot_pageviews on that same route is NOT blended here — it matches a
 * specific AI_TOKENS allow-list (Perplexity, Gemini, Googlebot, …) that,
 * like getPrunedChatgptClaudeCounts's doc comment explains, does not line up
 * 1:1 with rollup's bot_type buckets beyond chatgpt/claude. Left raw-only,
 * documented known gap.
 */
export function getPrunedExactPathViewCount(
  paths: string[],
  cutoffIso: string,
  opts: { source?: string } = {}
): number {
  if (paths.length === 0) return 0;
  return withPrunedWindow(cutoffIso, "analytics_page_views", 0, (w) => {
    const db = getDb();
    const placeholders = paths.map(() => "?").join(",");
    const sourceClause = opts.source ? " AND source = ?" : "";
    const params: string[] = [...paths, w.fromDay, w.boundary];
    if (opts.source) params.push(opts.source);
    const row = db.prepare(`
      SELECT COALESCE(SUM(view_count), 0) as c FROM page_view_daily
      WHERE path IN (${placeholders}) AND day >= ? AND day < ?${sourceClause}
    `).get(...params) as { c: number };
    return row.c || 0;
  });
}

// ═════════════════════════════════════════════════════════════════
// sessions_daily blend
// ═════════════════════════════════════════════════════════════════

/**
 * Pruned-day portion of TRUE distinct sessions (AnalyticsService.getSummary.
 * uniqueVisitors). Summed across all bot_type buckets, matching the raw
 * query's COUNT(DISTINCT session_id) which doesn't filter by bot/human
 * either. Same cross-day accepted approximation as getPrunedPageViewsByPath
 * above: a session returning on two different pruned days is counted twice
 * (sessions_daily is a true per-day distinct count, not a per-window one) —
 * this is the best available signal without re-deriving per-session identity
 * from an aggregate table, and matches the dev-request's own "combine (sum)"
 * blending instruction.
 */
export function getPrunedSessionsTotal(cutoffIso: string, vertical?: VerticalId): number {
  return withPrunedWindow(cutoffIso, "analytics_page_views", 0, (w) => {
    const db = getDb();
    const V = vertical ? " AND vertical_id = ?" : "";
    const vp: string[] = vertical ? [vertical] : [];
    const row = db.prepare(`
      SELECT COALESCE(SUM(session_count), 0) as c FROM sessions_daily
      WHERE day >= ? AND day < ?${V}
    `).get(w.fromDay, w.boundary, ...vp) as { c: number };
    return row.c || 0;
  });
}

// ═════════════════════════════════════════════════════════════════
// query_daily / query_text_daily blends
// ═════════════════════════════════════════════════════════════════

/** Pruned-day portion of a total query count (AnalyticsService.getSummary.totalQueries). */
export function getPrunedQueryCount(cutoffIso: string, vertical?: VerticalId): number {
  return withPrunedWindow(cutoffIso, "analytics_queries", 0, (w) => {
    const db = getDb();
    const V = vertical ? " AND vertical_id = ?" : "";
    const vp: string[] = vertical ? [vertical] : [];
    const row = db.prepare(`
      SELECT COALESCE(SUM(query_count), 0) as c FROM query_daily
      WHERE day >= ? AND day < ?${V}
    `).get(w.fromDay, w.boundary, ...vp) as { c: number };
    return row.c || 0;
  });
}

/** Pruned-day portion of query_daily grouped by agent_id (getSummary's agentQueryResult back-compat fold). */
export function getPrunedQueryCountsByAgent(cutoffIso: string, vertical?: VerticalId): Array<{ agent_id: string; count: number }> {
  return withPrunedWindow(cutoffIso, "analytics_queries", [], (w) => {
    const db = getDb();
    const V = vertical ? " AND vertical_id = ?" : "";
    const vp: string[] = vertical ? [vertical] : [];
    const rows = db.prepare(`
      SELECT agent_id, SUM(query_count) as c FROM query_daily
      WHERE day >= ? AND day < ? AND agent_id != ''${V}
      GROUP BY agent_id
    `).all(w.fromDay, w.boundary, ...vp) as Array<{ agent_id: string; c: number }>;
    return rows.map(r => ({ agent_id: r.agent_id, count: r.c || 0 }));
  });
}

/** Pruned-day portion of top search terms (AnalyticsService.getSummary.topSearchTerms), from query_text_daily. */
export function getPrunedTopQueryTerms(cutoffIso: string, vertical?: VerticalId): Array<{ query: string; count: number }> {
  return withPrunedWindow(cutoffIso, "analytics_queries", [], (w) => {
    const db = getDb();
    const V = vertical ? " AND vertical_id = ?" : "";
    const vp: string[] = vertical ? [vertical] : [];
    const rows = db.prepare(`
      SELECT query, SUM(query_count) as c FROM query_text_daily
      WHERE day >= ? AND day < ?${V}
      GROUP BY query
    `).all(w.fromDay, w.boundary, ...vp) as Array<{ query: string; c: number }>;
    return rows.map(r => ({ query: r.query, count: r.c || 0 }));
  });
}

/** Pruned-day portion of query_daily grouped by city (AnalyticsService.getCityStats.searchQueries). */
export function getPrunedQueryCountsByCity(cutoffIso: string, vertical?: VerticalId): Record<string, number> {
  return withPrunedWindow(cutoffIso, "analytics_queries", {} as Record<string, number>, (w) => {
    const db = getDb();
    const V = vertical ? " AND vertical_id = ?" : "";
    const vp: string[] = vertical ? [vertical] : [];
    const rows = db.prepare(`
      SELECT city, SUM(query_count) as c FROM query_daily
      WHERE day >= ? AND day < ? AND city != ''${V}
      GROUP BY city
    `).all(w.fromDay, w.boundary, ...vp) as Array<{ city: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.city] = r.c || 0;
    return out;
  });
}

// ═════════════════════════════════════════════════════════════════
// agent_view_daily blends
// ═════════════════════════════════════════════════════════════════

/**
 * Pruned-day portion of agent_view_daily grouped by agent_id + view_source
 * (AnalyticsService.getTopProducers). agent_view_daily has no agent_name
 * column (only agent_id) — callers must resolve the display name themselves
 * (e.g. from the `agents` table) for agent_ids that only appear here.
 */
export function getPrunedAgentViewRows(
  cutoffIso: string,
  vertical?: VerticalId
): Array<{ agent_id: string; city: string; view_source: string; view_count: number }> {
  return withPrunedWindow(cutoffIso, "analytics_agent_views", [], (w) => {
    const db = getDb();
    const V = vertical ? " AND vertical_id = ?" : "";
    const vp: string[] = vertical ? [vertical] : [];
    return db.prepare(`
      SELECT agent_id, city, view_source, SUM(view_count) as view_count
      FROM agent_view_daily
      WHERE day >= ? AND day < ?${V}
      GROUP BY agent_id, city, view_source
    `).all(w.fromDay, w.boundary, ...vp) as Array<{ agent_id: string; city: string; view_source: string; view_count: number }>;
  });
}

/** Pruned-day portion of agent_view_daily grouped by city (AnalyticsService.getCityStats.viewCount). */
export function getPrunedAgentViewCountsByCity(cutoffIso: string, vertical?: VerticalId): Record<string, number> {
  return withPrunedWindow(cutoffIso, "analytics_agent_views", {} as Record<string, number>, (w) => {
    const db = getDb();
    const V = vertical ? " AND vertical_id = ?" : "";
    const vp: string[] = vertical ? [vertical] : [];
    const rows = db.prepare(`
      SELECT city, SUM(view_count) as c FROM agent_view_daily
      WHERE day >= ? AND day < ? AND city != ''${V}
      GROUP BY city
    `).all(w.fromDay, w.boundary, ...vp) as Array<{ city: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.city] = r.c || 0;
    return out;
  });
}

// Exposed for tests that want to assert the exact boundary/window resolution
// without going through a specific reader.
export const __internal = { resolvePrunedWindow };
