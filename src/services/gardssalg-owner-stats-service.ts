// ─── gardssalg-owner-stats-service.ts — minimal "Statistikk" tab data for the
// opplevagent gårdssalg owner-claim portal (dev-request 2026-07-21-
// opplevagent-claim-flyt-drikkeprodusenter, acceptance criterion 3) ────────
//
// RFB's owner-stats-service.ts (src/services/owner-stats-service.ts) has SIX
// groups: views-by-source, AI-platform split, matching search queries,
// conversations-by-channel, contact-clicks-by-kind, and a discovered->viewed
// ->contacted funnel. That richness rests on RFB-only tables/columns:
// analytics_agent_views (agent_id-keyed), analytics_queries/conversations
// tied to seller_agent_id, contact_clicks tied to agent_id, and
// agent_metrics.times_discovered — verified directly against
// src/database/init.ts: NONE of these reference experience_providers at all,
// and analytics_mcp_calls (the closest thing to an "AI recommendation count"
// for MCP/A2A traffic) has NO per-agent/per-provider column whatsoever (just
// protocol/vertical_id/tool_name) — there is genuinely no way to attribute an
// MCP/AI tool call to one specific gårdssalg provider today.
//
// What DOES exist and IS usable: analytics_page_views (src/database/init.ts)
// is a CROSS-VERTICAL table (vertical_id column, stamped from the Host header
// by analytics-service.ts's request middleware — the exact mechanism
// oa-home-counters.ts already relies on for the opplevagent homepage counter
// strip) that logs every page view by path, with a session_id encoding the
// UA (used everywhere else in this codebase, e.g. owner-stats-service.ts, to
// classify bot/AI-crawler traffic via LIKE match) and an is_owner flag
// (fleet/internal traffic). A gårdssalg produsent page view
// (/kategori/gardssalg/produsent/<slug>) is logged there exactly like any
// other opplevagent page. So v1 of this owner's "Statistikk" tab shows
// ONLY: human page views vs. AI-bot page views on the producer's own
// /kategori/gardssalg/produsent/<slug> page, over the same 90-day window RFB
// uses. It does NOT show conversations, contact-clicks, matching search
// queries, or a discovery funnel — those tables simply don't have a gårdssalg
// analogue. This is a documented, honest gap (never fabricated) per the
// dev-request's own instruction: "v1 shows only what's actually available."
//
// Reads analytics_page_views from the RFB/shared lokal.db (via
// src/database/init.ts's getDb(), NOT db-factory's experiences.db handle) —
// same cross-DB read oa-home-counters.ts's getTrafficStats() already does.
// Read-only; never writes.

import { getDb as getRfbDb } from "../database/init";

// Same UA-marker technique + lists as owner-stats-service.ts / agent-stats.ts
// (session_id = "<ipHash>:<userAgent>", LIKE-matched). Duplicated rather than
// imported, same as owner-stats-service.ts itself already does relative to
// agent-stats.ts (see that file's own "SYNC-TODO" comment) — mirror any new
// marker added there here too.
const ALL_AI_MARKERS = [
  "GPTBot", "ChatGPT", "OAI-SearchBot",
  "ClaudeBot", "Claude-User", "Anthropic",
  "Gemini", "Google-Extended", "PerplexityBot", "Perplexity-User",
  "CCBot", "Bytespider", "Applebot-Extended", "YandexAdditional",
  "NotHumanSearch", "DuckDuckBot", "Googlebot",
];

export const GARDSSALG_OWNER_STATS_WINDOW_DAYS = 90; // matches RFB's window
const WINDOW_SQL = `datetime('now', '-${GARDSSALG_OWNER_STATS_WINDOW_DAYS} days')`;

export interface GardssalgOwnerStats {
  windowDays: number;
  path: string;
  humanViews: number;
  aiBotViews: number;
  /** Honest, explicit acknowledgment of what this tab does NOT show — the
   * portal UI renders this list so an owner never wonders why a number is
   * "missing" (never silently omitted). */
  notAvailable: string[];
}

const NOT_AVAILABLE = [
  "AI-anbefalinger (per produsent)",
  "Samtaler",
  "Kontakt-klikk",
  "Søk som traff profilen din",
];

export function getGardssalgOwnerStats(path: string): GardssalgOwnerStats {
  const db = getRfbDb();
  const aiClause = ALL_AI_MARKERS.map(() => "session_id LIKE ?").join(" OR ");
  const aiParams = ALL_AI_MARKERS.map((m) => `%${m}%`);
  const aiNotClause = ALL_AI_MARKERS.map(() => "session_id NOT LIKE ?").join(" AND ");
  const aiNotParams = ALL_AI_MARKERS.map((m) => `%${m}%`);

  const baseWhere = `path = ? AND vertical_id = 'experiences' AND (is_owner IS NULL OR is_owner = 0) AND created_at >= ${WINDOW_SQL}`;

  const human = db
    .prepare(`SELECT COUNT(*) as c FROM analytics_page_views WHERE ${baseWhere} AND ${aiNotClause}`)
    .get(path, ...aiNotParams) as { c: number } | undefined;

  const bot = db
    .prepare(`SELECT COUNT(*) as c FROM analytics_page_views WHERE ${baseWhere} AND (${aiClause})`)
    .get(path, ...aiParams) as { c: number } | undefined;

  return {
    windowDays: GARDSSALG_OWNER_STATS_WINDOW_DAYS,
    path,
    humanViews: human?.c ?? 0,
    aiBotViews: bot?.c ?? 0,
    notAvailable: NOT_AVAILABLE,
  };
}
