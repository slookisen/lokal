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
 *     (AI search: ChatGPT/Claude/other assistants fetching the page for a
 *     person), last 30 days, page views only, excluding every other bot and
 *     the owner's own views (is_owner).
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
 *     documented gap — not a fabricated filter. (Since then conversations
 *     gained is_internal + traffic_class; both conversation reads below use
 *     the shared COUNTABLE_CONV_SQL predicate — see a2a-traffic-classifier.)
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
import { COUNTABLE_CONV_SQL, isPublicQueryTerm } from "./a2a-traffic-classifier";
import { aiVendorBucket, storedClientClass, uaFromSessionId } from "./traffic-classifier";
import { getRetentionWindowDays } from "./retention-window";

export interface ProfileActivityViews {
  human: number;
  ai: number;
  aiBreakdown: { chatgpt: number; claude: number; other: number };
  /** The window in days: 30, or the raw retention if that is shorter. */
  days: number;
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

const VIEWS_WINDOW_DAYS = 30;

/**
 * Profile views from people and AI-agent lookups over the last 30 days, with
 * the shared definitions (dev-request 2026-10-13-statistikk-riktig-for-
 * investorer, S5): page views only (2xx/304), each session classed once by
 * the class stored at write time (traffic-classifier storedClientClass, the
 * session_id for legacy rows), so search engines, SEO bots, scanners and
 * scripts are not «profile views». AI-agent lookups are AI search only, as on
 * the AI tile above (Daniel 2026-10-13: «Tell bare AI-søk»); AI crawlers
 * (GPTBot, ClaudeBot …) are not counted.
 *
 * Runs synchronously on every /produsent/:slug render, so it is one grouped
 * read of the path's rows and no per-session velocity read: a scraper behind
 * a browser UA can count as one profile view here (the tile above, computed
 * off-thread, checks velocity). The window stays inside the raw rows; the
 * old page_view_daily top-up counted crawlers and is no longer added.
 */
function getViews30(db: Database.Database, path: string): ProfileActivityViews {
  const days = Math.min(VIEWS_WINDOW_DAYS, getRetentionWindowDays());
  const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const cols = new Set((db.prepare("PRAGMA table_info(analytics_page_views)").all() as Array<{ name: string }>).map((c) => c.name));
  const statusOk = cols.has("status_code") ? " AND (status_code IS NULL OR (status_code >= 200 AND status_code < 300) OR status_code = 304)" : "";
  // One class per session (same UA on every row); MAX() skips legacy NULLs.
  const clientClass = cols.has("client_class") ? "MAX(client_class)" : "NULL";
  const sessions = db.prepare(`
    SELECT session_id, ${clientClass} AS client_class, COUNT(*) AS views
    FROM analytics_page_views
    WHERE path = ?
      AND (is_owner IS NULL OR is_owner = 0)
      AND created_at >= ?${statusOk}
      AND session_id IS NOT NULL
    GROUP BY session_id
  `).all(path, cutoffIso) as Array<{ session_id: string; client_class: string | null; views: number }>;

  let human = 0;
  const aiBreakdown = { chatgpt: 0, claude: 0, other: 0 };
  for (const s of sessions) {
    const cls = storedClientClass(s.session_id, s.client_class);
    if (cls === "human") human += s.views;
    else if (cls === "ai_search") aiBreakdown[aiVendorBucket(uaFromSessionId(s.session_id))] += s.views;
  }
  return { human, ai: aiBreakdown.chatgpt + aiBreakdown.claude + aiBreakdown.other, aiBreakdown, days };
}

/**
 * Top 3 aggregated search-query terms that led a buyer to this agent.
 * Sourced from conversations.query_text (tied to seller_agent_id — unlike
 * analytics_queries, see module doc). All-time, not windowed: per-agent
 * conversation volume is often low, and a 30-day window would leave most
 * producers with an empty (and therefore useless) block. Grouping is
 * case-sensitive on the raw text, mirroring analytics-service.ts's
 * existing topSearchTerms convention (GROUP BY query, no normalization).
 *
 * a2a spam guard (2026-10-04): countable conversations only (not internal,
 * not classified spam/probe), and every term must pass the public query
 * allow-list (≤40 chars, no URL / 0x address / JSON / CJK payload, a real
 * word) — this panel republished attacker payloads verbatim. A wider SQL
 * window than the 3 shown so rejected terms don't leave the panel short.
 */
function getTopQueryTerms(db: Database.Database, agentId: string): ProfileActivityQueryTerm[] {
  const rows = db.prepare(`
    SELECT query_text as term, COUNT(*) as cnt
    FROM conversations
    WHERE seller_agent_id = ?
      AND ${COUNTABLE_CONV_SQL}
      AND query_text IS NOT NULL
      AND LENGTH(TRIM(query_text)) BETWEEN 2 AND 40
    GROUP BY query_text
    ORDER BY cnt DESC, term ASC
    LIMIT 30
  `).all(agentId) as Array<{ term: string; cnt: number }>;

  return rows
    .filter((r) => isPublicQueryTerm(r.term))
    .slice(0, 3)
    .map((r) => ({ term: r.term, count: r.cnt }));
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
  // Countable only — a spam a2a call must not earn a producer the A2A badge.
  const sourceRows = db.prepare(`
    SELECT DISTINCT source FROM conversations
    WHERE seller_agent_id = ? AND source IS NOT NULL AND ${COUNTABLE_CONV_SQL}
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
