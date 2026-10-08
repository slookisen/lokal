// ─── Raw/rollup boundary for the blended analytics readers (pure) ─────
// Moved out of retention-service.ts (which keeps getRollupBoundaryDate and
// re-exports isAnalyticsRollupReadEnabled unchanged) so the off-thread stats
// worker can resolve the same boundary on its own read-only connection
// without importing database/init. Keep this file free of side effects.

import type Database from "better-sqlite3";

export type RollupRawTable = "analytics_page_views" | "analytics_queries" | "analytics_agent_views";

/**
 * dev-request 2026-09-02-analytics-historikk-rollup-lesere-foer-retention,
 * Skive 3: shared boundary helper for every stats reader that blends raw +
 * rollup data. A given calendar day's data lives EITHER in the raw table OR
 * in its rollup table, never both (rollupAndPrune* above deletes whole days
 * at a time) — so "the earliest day still present in the raw table" is the
 * single fact a caller needs to partition a date range with zero
 * double-counting: days >= boundary → query raw; days < boundary → query
 * the matching rollup table.
 *
 * Written ONCE here (not duplicated per reader) per the dev-request's own
 * instruction. src/services/analytics-rollup-reads.ts is the caller-facing
 * blend layer built on top of this + isAnalyticsRollupReadEnabled().
 *
 * Returns the boundary as a "YYYY-MM-DD" day string (SQLite `day` column
 * format for the rollup tables). If the raw table is currently EMPTY (every
 * day has already been rolled up and pruned — an edge case, but possible on
 * a fresh/aggressively-pruned DB), there is no day left in raw at all, so
 * every day must route to rollup: returns tomorrow's UTC date, which makes
 * "day >= boundary" (the raw-side query) match nothing (correct — raw truly
 * has nothing) and "day < boundary" (the rollup-side query) cover today too.
 */
export function rollupBoundaryDateOn(db: Database.Database, table: RollupRawTable): string {
  // `table` is one of the three literal names above, never user input — same
  // interpolation-is-safe precedent as analytics-service.ts's exportData().
  //
  // substr(MIN(col)), NOT MIN(substr(col)) — dev-request 2026-09-26-rfb-
  // produsentside-synkron-slug-skann. This runs on EVERY /produsent/:slug
  // (NB/EN, GET and HEAD) and /api/agents/:id/stats request, via
  // getPrunedChatgptClaudeCounts → resolvePrunedWindow. A bare MIN(created_at)
  // is answered from the created_at index in O(log n) (SQLite's min/max
  // optimisation); wrapping the column in substr() disables that and walks
  // the whole index — ~1.29 M entries in prod, ~110-150 ms of synchronous
  // main-thread time per call even on a fast unthrottled CPU (~90 % of a
  // producer-page render). Same result: truncating to the first 10 characters
  // is monotone under SQLite's BINARY text ordering, so the prefix of the
  // minimum IS the minimum of the prefixes; MIN() skips NULLs in both forms.
  const row = db.prepare(
    `SELECT substr(MIN(created_at), 1, 10) as d FROM ${table}`
  ).get() as { d: string | null } | undefined;
  if (row?.d) return row.d;
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return tomorrow.toISOString().slice(0, 10);
}

/**
 * dev-request 2026-09-02-analytics-historikk-rollup-lesere-foer-retention,
 * Skive 3: master switch for the blended raw+rollup read path. Default
 * **true** when unset — Skive 1/2's rollup tables are already live-verified
 * in prod, so blending ships on by default — but reading it from the
 * environment (rather than hardcoding true) means it can be flipped to
 * `ANALYTICS_ROLLUP_READ=false` for an instant rollback (readers fall back
 * to the exact pre-Skive-3 raw-only behaviour) without a redeploy, purely an
 * env var change — mirrors the existing RFB_AUTO_PRUNE_DAYS /
 * RETENTION_JOB_ENABLED convention of reading process.env at call time (not
 * module load) so a running process always reflects the current value.
 * Any value other than the literal string "false" counts as enabled, same
 * permissive-default spirit as RFB_AUTO_PRUNE_DAYS's "unset or garbage ⇒
 * default" handling.
 */
export function isAnalyticsRollupReadEnabled(): boolean {
  return process.env.ANALYTICS_ROLLUP_READ !== "false";
}
