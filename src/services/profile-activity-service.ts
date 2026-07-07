/**
 * profile-activity-service.ts — Aggregated "Aktivitet" panel for the public
 * producer profile (dev-request 2026-07-03-agent-profile-conversations-stats,
 * slice 2, work item 4).
 *
 * Replaces the raw "Siste samtaler" (recent conversations) list on
 * /produsent/:slug — most of those conversations are search fan-out (one
 * auto-created per matched producer on every search) or probe traffic, so
 * quoting them read as noise rather than social proof. This module computes
 * honest, non-fabricated aggregates from tables that already exist:
 *
 *   - analytics_page_views  → profile views (humans) + AI-agent lookups
 *     (ChatGPT/Claude/other), last 30 days, excluding bots-that-aren't-AI
 *     and the owner's own views (is_owner).
 *   - conversations          → top search-query terms that led a buyer to
 *     this producer (query_text, seller_agent_id) + which channels
 *     (source: web/a2a/mcp) ever produced a conversation with this agent.
 *
 * What this deliberately does NOT do:
 *   - It does not fabricate a per-agent breakdown of analytics_queries,
 *     because analytics_queries.agent_id records the AI CLIENT that made
 *     the search (parseUserAgent().clientName — "ChatGPT"/"Claude"/etc.,
 *     see analytics-service.ts trackSearchQuery), not the producer being
 *     searched for. There is no reliable join from analytics_queries back
 *     to a specific seller agent, so query-term aggregation instead uses
 *     conversations.query_text (which IS tied to seller_agent_id).
 *   - conversations has no is_bot/is_owner column (verified in
 *     src/database/init.ts — only analytics_page_views, analytics_queries,
 *     analytics_agent_views got the is_owner ALTER TABLE), so query-term
 *     aggregation and the conversation-based platform badges (web/a2a/mcp)
 *     cannot be bot/owner-filtered at the DB level. This is a known,
 *     documented gap — not a fabricated filter.
 *   - conversations.source only ever takes "a2a" | "mcp" | "web" | "api"
 *     (see ConversationSource in conversation-service.ts). "api" is a
 *     generic legacy default used by callers that don't identify a
 *     specific channel and is intentionally NOT surfaced as one of the
 *     five platform badges Daniel asked for (Web/ChatGPT/Claude/A2A/MCP) —
 *     it would misrepresent a generic fallback as if it were a specific
 *     platform. ChatGPT/Claude badges come from the page-view UA split
 *     instead (which DOES reliably distinguish them).
 */

import type Database from "better-sqlite3";

// ─── AI bot UA markers ────────────────────────────────────────────────
// Same technique + marker lists as src/routes/agent-stats.ts's per-agent
// AI/human view split (session_id = "<ipHash>:<userAgent>", LIKE-matched).
// Duplicated rather than imported because agent-stats.ts doesn't currently
// export these lists — see the SYNC-TODO comment there. If a new AI bot
// marker is added in analytics-service.ts / agent-stats.ts, mirror it here.
const AI_MARKERS = {
  chatgpt: ["GPTBot", "ChatGPT", "OAI-SearchBot"],
  claude: ["ClaudeBot", "Claude-User", "Anthropic"],
  other: [
    "Gemini", "Google-Extended", "PerplexityBot", "Perplexity-User",
    "CCBot", "Bytespider", "Applebot-Extended", "YandexAdditional",
    "NotHumanSearch", "DuckDuckBot", "Googlebot",
  ],
};
const ALL_AI_MARKERS = [...AI_MARKERS.chatgpt, ...AI_MARKERS.claude, ...AI_MARKERS.other];

export interface ProfileActivityViews {
  human: number;
  ai: number;
  aiBreakdown: { chatgpt: number; claude: number; other: number };
}

export interface ProfileActivityQueryTerm {
  term: string;
  count: number;
}

export type ProfilePlatformBadge = "web" | "chatgpt" | "claude" | "a2a" | "mcp";

export interface ProfileActivity {
  views30: ProfileActivityViews;
  topQueryTerms: ProfileActivityQueryTerm[];
  platforms: ProfilePlatformBadge[];
}

const VIEWS_WINDOW_SQL = "datetime('now', '-30 days')";

function likeClause(markers: string[]): { clause: string; params: string[] } {
  return {
    clause: markers.map(() => "session_id LIKE ?").join(" OR "),
    params: markers.map((m) => `%${m}%`),
  };
}

/**
 * Profile views (humans, last 30d) + AI-agent lookups (last 30d, split by
 * platform). Mirrors the exact exclusion rules already used by
 * src/routes/agent-stats.ts's 90-day owner-dashboard stats (is_owner
 * excluded, AI UA markers split out of the "human" bucket) but windowed to
 * 30 days for the public panel per the dev-request spec.
 */
function getViews30(db: Database.Database, path: string): ProfileActivityViews {
  const aiNotClause = ALL_AI_MARKERS.map(() => "session_id NOT LIKE ?").join(" AND ");
  const aiNotParams = ALL_AI_MARKERS.map((m) => `%${m}%`);

  const humanRow = db.prepare(`
    SELECT COUNT(*) as c FROM analytics_page_views
    WHERE path = ?
      AND (is_owner IS NULL OR is_owner = 0)
      AND created_at >= ${VIEWS_WINDOW_SQL}
      AND ${aiNotClause}
  `).get(path, ...aiNotParams) as { c: number } | undefined;
  const human = humanRow?.c ?? 0;

  function bucket(markers: string[]): number {
    const { clause, params } = likeClause(markers);
    const row = db.prepare(`
      SELECT COUNT(*) as c FROM analytics_page_views
      WHERE path = ?
        AND (is_owner IS NULL OR is_owner = 0)
        AND created_at >= ${VIEWS_WINDOW_SQL}
        AND (${clause})
    `).get(path, ...params) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  const chatgpt = bucket(AI_MARKERS.chatgpt);
  const claude = bucket(AI_MARKERS.claude);
  const other = bucket(AI_MARKERS.other);

  return { human, ai: chatgpt + claude + other, aiBreakdown: { chatgpt, claude, other } };
}

/**
 * Top 3 aggregated search-query terms that led a buyer to this agent.
 * Sourced from conversations.query_text (tied to seller_agent_id — unlike
 * analytics_queries, see module doc). All-time, not windowed: per-agent
 * conversation volume is often low, and a 30-day window would leave most
 * producers with an empty (and therefore useless) block. Grouping is
 * case-sensitive on the raw text, mirroring analytics-service.ts's
 * existing topSearchTerms convention (GROUP BY query, no normalization).
 */
function getTopQueryTerms(db: Database.Database, agentId: string): ProfileActivityQueryTerm[] {
  const rows = db.prepare(`
    SELECT query_text as term, COUNT(*) as cnt
    FROM conversations
    WHERE seller_agent_id = ?
      AND query_text IS NOT NULL
      AND LENGTH(TRIM(query_text)) >= 2
    GROUP BY query_text
    ORDER BY cnt DESC, term ASC
    LIMIT 3
  `).all(agentId) as Array<{ term: string; cnt: number }>;

  return rows.map((r) => ({ term: r.term, count: r.cnt }));
}

/**
 * Platform badges: which channels ever discovered/contacted this agent.
 * - "web" / "a2a" / "mcp" come from conversations.source (all-time — a
 *   contact-worthy event is meaningful to remember beyond 30 days).
 * - "chatgpt" / "claude" are derived from the SAME 30-day page-view
 *   breakdown as views30 (reused, not re-queried) rather than from
 *   conversations.source="api", which doesn't reliably distinguish them
 *   (see module doc).
 */
function getPlatformBadges(
  db: Database.Database,
  agentId: string,
  views30: ProfileActivityViews,
): ProfilePlatformBadge[] {
  const sourceRows = db.prepare(`
    SELECT DISTINCT source FROM conversations
    WHERE seller_agent_id = ? AND source IS NOT NULL
  `).all(agentId) as Array<{ source: string }>;
  const sources = new Set(sourceRows.map((r) => r.source));

  const badges: ProfilePlatformBadge[] = [];
  if (sources.has("web")) badges.push("web");
  if (views30.aiBreakdown.chatgpt > 0) badges.push("chatgpt");
  if (views30.aiBreakdown.claude > 0) badges.push("claude");
  if (sources.has("a2a")) badges.push("a2a");
  if (sources.has("mcp")) badges.push("mcp");
  return badges;
}

/**
 * Full activity summary for one producer's profile page. Fail-quiet is the
 * CALLER's responsibility (matches the rest of seo.ts's /produsent/:slug
 * handler, which wraps every supplementary query in its own try/catch so a
 * single bad query never 500s the whole page).
 */
export function getProfileActivity(
  db: Database.Database,
  agentId: string,
  path: string,
): ProfileActivity {
  const views30 = getViews30(db, path);
  const topQueryTerms = getTopQueryTerms(db, agentId);
  const platforms = getPlatformBadges(db, agentId, views30);
  return { views30, topQueryTerms, platforms };
}
