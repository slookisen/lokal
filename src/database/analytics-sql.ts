// ─── Pure SQL fragments for the analytics readers ────────────────────
// Moved verbatim out of database/init.ts (which re-exports them) so the
// off-thread stats worker (services/offthread-stats-worker.ts) can build the
// same queries without importing database/init. Keep this file free of
// imports and side effects.

// ─── Producer-profile view honesty (analytics_agent_views) ──────────────────
// 2026-10-04: analytics_agent_views rows used to carry no traffic class at
// all, so every crawler, scraper and — via a city-page hack in seo.ts — every
// city-page visit was counted as a "view" of some producer. trackAgentView
// (analytics-service.ts) now stamps is_owner + traffic_category (a
// traffic-classifier.ts SessionCategory) on every new row, and every reader
// that reports producer views (getTopProducers, getCityStats,
// admin-outreach-pool / admin-outreach-candidates views_count) counts ONLY
// rows matching this predicate. Rows written before the column existed have
// traffic_category IS NULL (= unknown) and are deliberately NOT counted as
// human: they are exactly the inflated numbers this change stops quoting.
// `alias` qualifies the columns for correlated subqueries.
export function humanAgentViewSql(alias?: string): string {
  const p = alias ? `${alias}.` : "";
  return `(COALESCE(${p}is_owner, 0) = 0 AND ${p}traffic_category = 'human')`;
}

// agent_view_daily bucket for those legacy (traffic_category IS NULL) rows.
// The nightly rollup still rolls them up before deleting them — no history is
// dropped without landing in the permanent table — but under this view_source,
// so every agent_view_daily reader excludes them exactly like the raw readers
// above do. Rows rolled up BEFORE this change kept their original view_source
// and cannot be told apart (documented known gap; a fixed historical offset).
export const LEGACY_AGENT_VIEW_SOURCE = "legacy_unclassified";
