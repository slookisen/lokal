/**
 * owner-stats-service.ts — Owner dashboard "Statistikk" data
 * (dev-request 2026-07-03-agent-profile-conversations-stats, slice 3,
 *  work items 5+6).
 *
 * Feeds the new authenticated GET /api/agents/:id/owner-stats endpoint
 * (src/routes/owner-portal.ts) that powers selger.html's new "Statistikk"
 * tab: views over time by source, AI-platform split, matching search
 * queries, conversations per channel, contact-clicks by kind, and a simple
 * discovered→viewed→kontakt-klikk funnel.
 *
 * All six groups are pure aggregation over tables that ALREADY exist —
 * verified directly against src/database/init.ts (never against
 * GUIDEBOOK.md or other docs, which can be stale). Per work item 6 of this
 * dev-request, every query below documents which is_bot/is_owner columns
 * actually exist and are applied, and which genuinely don't (an honest,
 * documented gap rather than a fabricated filter) — same convention as
 * src/services/profile-activity-service.ts (slice 2).
 *
 * Bot/owner filtering summary (verified against init.ts):
 *
 *   - analytics_page_views: HAS is_owner (excluded below) and session_id,
 *     which the rest of the codebase (agent-stats.ts, profile-activity-
 *     service.ts) already uses as the bot-detection idiom for this table —
 *     AI-bot UA markers are baked into session_id ("<ipHash>:<userAgent>")
 *     and excluded/split via LIKE, same marker lists as those two files.
 *
 *   - analytics_agent_views: has is_owner but NO session_id/UA column at
 *     all, so bot traffic can never be excluded here — and in practice its
 *     view_source is always "seo" (the only call sites, in seo.ts, always
 *     pass "seo" and never compute isOwner). This dev-request's own
 *     acceptance criteria require "a known bot UA hitting a profile does
 *     not increment public/owner stats" — a requirement this table cannot
 *     honor. So even though analytics_agent_views.view_source's enum
 *     literally spells "search"/"direct"/"discovery"/"seo" (matching the
 *     dev-request text verbatim), we deliberately do NOT use it for "views
 *     over time by source" below. We use analytics_page_views instead
 *     (source enum: direct/organic/search/social/referral — a different
 *     but bot-filterable taxonomy) because it's the one table that can
 *     actually satisfy the bot-exclusion requirement. This is a documented
 *     mismatch, not a fabrication — the same kind of call profile-
 *     activity-service.ts already made (conversations.query_text over
 *     analytics_queries.agent_id) for the same "which table can actually
 *     answer this honestly" reason.
 *
 *   - conversations: has NEITHER is_bot NOR is_owner (verified in init.ts —
 *     the same finding profile-activity-service.ts already documented for
 *     slice 2). Used here for "matching search queries" and "conversations
 *     per channel"; both are known, unfiltered-by-bot/owner gaps, same as
 *     slice 2's topQueryTerms/platform badges.
 *
 *   - contact_clicks: HAS is_bot (applied below: is_bot = 0) but NO
 *     is_owner column (verified in init.ts — slice 1 only ever added
 *     is_bot). The owner's own test clicks on their profile are therefore
 *     NOT excluded from "kontakt-klikk etter type" below — a known,
 *     documented gap. Adding is_owner would require exporting analytics-
 *     service.ts's isOwnerRequest() helper and wiring it into contact-
 *     tracking.ts's recordClick(), which touches slice-1 behavior and is
 *     out of scope for this read-only stats slice (additive-only rule).
 *
 *   - agent_metrics.times_discovered: a PRE-EXISTING lifetime counter, not
 *     a new aggregate query written by this slice — incremented in
 *     marketplace-registry.ts with no bot/owner filter either. Reused
 *     as-is (unchanged) for the funnel's "discovered" stage.
 */

import type Database from "better-sqlite3";

// ─── AI bot UA markers ────────────────────────────────────────────────
// Same technique + marker lists as agent-stats.ts / profile-activity-
// service.ts (session_id = "<ipHash>:<userAgent>", LIKE-matched).
// Duplicated rather than imported — see the SYNC-TODO in agent-stats.ts;
// mirror any new marker added there here too.
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

// 90 days — matches agent-stats.ts's existing owner-dashboard window
// ("Returns last-90-days view aggregates"). Keep in sync if that changes.
export const OWNER_STATS_WINDOW_DAYS = 90;
const WINDOW_SQL = `datetime('now', '-${OWNER_STATS_WINDOW_DAYS} days')`;

// analytics_page_views.source enum, per its CREATE TABLE comment in init.ts.
const PAGE_VIEW_SOURCES = ["direct", "organic", "search", "social", "referral"] as const;

export interface OwnerStatsViewsBySource {
  totals: Record<string, number>;
  daily: Array<{ date: string; source: string; count: number }>;
}
export interface OwnerStatsAiPlatforms {
  chatgpt: number;
  claude: number;
  other: number;
  total: number;
}
export interface OwnerStatsTerm {
  term: string;
  count: number;
}
export interface OwnerStatsChannelCount {
  source: string;
  count: number;
}
export interface OwnerStatsClickKindCount {
  kind: string;
  count: number;
}
export interface OwnerStatsFunnel {
  discovered: number;
  viewed: number;
  contactClicked: number;
}

export interface OwnerStats {
  windowDays: number;
  viewsBySource: OwnerStatsViewsBySource;
  aiPlatforms: OwnerStatsAiPlatforms;
  matchingSearchQueries: OwnerStatsTerm[];
  conversationsByChannel: OwnerStatsChannelCount[];
  contactClicksByKind: OwnerStatsClickKindCount[];
  funnel: OwnerStatsFunnel;
}

function likeClause(markers: string[]): { clause: string; params: string[] } {
  return {
    clause: markers.map(() => "session_id LIKE ?").join(" OR "),
    params: markers.map((m) => `%${m}%`),
  };
}

/**
 * Group 1: profile page views over the last 90 days, broken down both by
 * total-per-source and by day+source (for a simple trend line). Bot UA
 * markers and owner (is_owner) rows excluded — see module doc for why this
 * uses analytics_page_views rather than analytics_agent_views.
 */
function getViewsBySource(db: Database.Database, path: string): OwnerStatsViewsBySource {
  const aiNotClause = ALL_AI_MARKERS.map(() => "session_id NOT LIKE ?").join(" AND ");
  const aiNotParams = ALL_AI_MARKERS.map((m) => `%${m}%`);

  const totals: Record<string, number> = {};
  for (const source of PAGE_VIEW_SOURCES) {
    const row = db
      .prepare(
        `SELECT COUNT(*) as c FROM analytics_page_views
         WHERE path = ? AND source = ?
           AND (is_owner IS NULL OR is_owner = 0)
           AND created_at >= ${WINDOW_SQL}
           AND ${aiNotClause}`,
      )
      .get(path, source, ...aiNotParams) as { c: number } | undefined;
    totals[source] = row?.c ?? 0;
  }

  const dailyRows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at) as date, source, COUNT(*) as c
       FROM analytics_page_views
       WHERE path = ?
         AND (is_owner IS NULL OR is_owner = 0)
         AND created_at >= ${WINDOW_SQL}
         AND ${aiNotClause}
       GROUP BY date, source
       ORDER BY date ASC`,
    )
    .all(path, ...aiNotParams) as Array<{ date: string; source: string | null; c: number }>;

  return {
    totals,
    daily: dailyRows.map((r) => ({ date: r.date, source: r.source || "unknown", count: r.c })),
  };
}

/**
 * Group 2: AI-platform split (chatgpt/claude/other) over the same 90-day
 * window, via the same session_id UA-marker technique as views-by-source
 * and agent-stats.ts. Owner rows excluded.
 */
function getAiPlatforms(db: Database.Database, path: string): OwnerStatsAiPlatforms {
  function bucket(markers: string[]): number {
    const { clause, params } = likeClause(markers);
    const row = db
      .prepare(
        `SELECT COUNT(*) as c FROM analytics_page_views
         WHERE path = ? AND (is_owner IS NULL OR is_owner = 0)
           AND created_at >= ${WINDOW_SQL}
           AND (${clause})`,
      )
      .get(path, ...params) as { c: number } | undefined;
    return row?.c ?? 0;
  }
  const chatgpt = bucket(AI_MARKERS.chatgpt);
  const claude = bucket(AI_MARKERS.claude);
  const other = bucket(AI_MARKERS.other);
  return { chatgpt, claude, other, total: chatgpt + claude + other };
}

/** Human (non-AI-bot, non-owner) page views in the 90-day window — reused for the funnel's "viewed" stage. */
function getHumanViews(db: Database.Database, path: string): number {
  const aiNotClause = ALL_AI_MARKERS.map(() => "session_id NOT LIKE ?").join(" AND ");
  const aiNotParams = ALL_AI_MARKERS.map((m) => `%${m}%`);
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM analytics_page_views
       WHERE path = ?
         AND (is_owner IS NULL OR is_owner = 0)
         AND created_at >= ${WINDOW_SQL}
         AND ${aiNotClause}`,
    )
    .get(path, ...aiNotParams) as { c: number } | undefined;
  return row?.c ?? 0;
}

/**
 * Group 3: search queries that matched this producer's profile — sourced
 * from conversations.query_text (tied to seller_agent_id), same technique
 * as profile-activity-service.ts's getTopQueryTerms, but a higher LIMIT
 * (10 instead of 3) since this is the owner's own full dashboard, not the
 * public teaser panel. All-time (no window) — see module doc.
 */
function getMatchingSearchQueries(db: Database.Database, agentId: string, limit = 10): OwnerStatsTerm[] {
  const rows = db
    .prepare(
      `SELECT query_text as term, COUNT(*) as cnt
       FROM conversations
       WHERE seller_agent_id = ?
         AND query_text IS NOT NULL
         AND LENGTH(TRIM(query_text)) >= 2
       GROUP BY query_text
       ORDER BY cnt DESC, term ASC
       LIMIT ?`,
    )
    .all(agentId, limit) as Array<{ term: string; cnt: number }>;
  return rows.map((r) => ({ term: r.term, count: r.cnt }));
}

/**
 * Group 4: conversations grouped by channel (conversations.source:
 * a2a/mcp/web/api). All-time — see module doc. "api" is a real legacy
 * default value here (unlike profile-activity-service.ts's platform
 * badges, which intentionally hide it) because this is a raw per-channel
 * count for the owner, not a curated "which platforms found you" badge
 * list — an owner benefits from seeing the true "api"-channel volume too.
 */
function getConversationsByChannel(db: Database.Database, agentId: string): OwnerStatsChannelCount[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(source, 'api') as source, COUNT(*) as cnt
       FROM conversations
       WHERE seller_agent_id = ?
       GROUP BY COALESCE(source, 'api')
       ORDER BY cnt DESC`,
    )
    .all(agentId) as Array<{ source: string; cnt: number }>;
  return rows.map((r) => ({ source: r.source, count: r.cnt }));
}

/**
 * Group 5: contact-click intent (email/phone/website/external:<type>),
 * grouped by kind, is_bot excluded. Labeled "kontakt-klikk" in the UI —
 * click intent, not confirmed contact (see dev-request spec).
 */
function getContactClicksByKind(db: Database.Database, agentId: string): OwnerStatsClickKindCount[] {
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) as cnt
       FROM contact_clicks
       WHERE agent_id = ? AND is_bot = 0
         AND created_at >= ${WINDOW_SQL}
       GROUP BY kind
       ORDER BY cnt DESC`,
    )
    .all(agentId) as Array<{ kind: string; cnt: number }>;
  return rows.map((r) => ({ kind: r.kind, count: r.cnt }));
}

/**
 * Group 6: discovered → viewed → kontakt-klikk funnel.
 *  - discovered: agent_metrics.times_discovered (pre-existing lifetime
 *    counter; not bot/owner-filterable — see module doc).
 *  - viewed: human (bot+owner-excluded) profile page views, 90-day window.
 *  - contactClicked: sum of the 90-day, bot-excluded contact-click counts
 *    already computed for group 5 (passed in — avoids re-querying).
 */
function getFunnel(
  db: Database.Database,
  agentId: string,
  path: string,
  contactClickedTotal: number,
): OwnerStatsFunnel {
  const metricsRow = db
    .prepare(`SELECT times_discovered FROM agent_metrics WHERE agent_id = ?`)
    .get(agentId) as { times_discovered: number } | undefined;
  const discovered = metricsRow?.times_discovered ?? 0;
  const viewed = getHumanViews(db, path);
  return { discovered, viewed, contactClicked: contactClickedTotal };
}

/**
 * Full owner-stats summary for one producer. `path` must be the exact
 * `/produsent/<slug>` path analytics_page_views recorded for this agent
 * (see agent-stats.ts's slugify(agent.name) convention — callers must use
 * the same slug derivation).
 */
export function getOwnerStats(db: Database.Database, agentId: string, path: string): OwnerStats {
  const viewsBySource = getViewsBySource(db, path);
  const aiPlatforms = getAiPlatforms(db, path);
  const matchingSearchQueries = getMatchingSearchQueries(db, agentId);
  const conversationsByChannel = getConversationsByChannel(db, agentId);
  const contactClicksByKind = getContactClicksByKind(db, agentId);
  const contactClickedTotal = contactClicksByKind.reduce((sum, r) => sum + r.count, 0);
  const funnel = getFunnel(db, agentId, path, contactClickedTotal);

  return {
    windowDays: OWNER_STATS_WINDOW_DAYS,
    viewsBySource,
    aiPlatforms,
    matchingSearchQueries,
    conversationsByChannel,
    contactClicksByKind,
    funnel,
  };
}
