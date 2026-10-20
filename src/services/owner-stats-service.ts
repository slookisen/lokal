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
 *   - analytics_page_views: HAS is_owner (excluded below). Since 2026-10-14
 *     (dev-request 2026-10-13-statistikk-riktig-for-investorer, S6) it is
 *     read with the same definitions as the public producer page
 *     (agent-stats-compute.ts, profile-activity-service.ts): page views only
 *     (2xx/304), each session classed once by the class stored at write time
 *     (traffic-classifier storedClientClass, the session_id for legacy rows),
 *     over the raw retention window (60 days). People are 'human'; the AI
 *     split is AI search only (an assistant fetching the page for a person),
 *     not AI crawlers. No page_view_daily top-up: it counted crawlers and
 *     files. Before that, LIKE marker lists counted bingbot/curl/scanners as
 *     people and Googlebot/GPTBot as AI, over 90 days.
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
 *     answer this honestly" reason. (2026-10-04: rows written since then DO
 *     carry is_owner + traffic_category and a Referer-derived view_source —
 *     see humanAgentViewSql in database/init.ts — but older rows do not, so
 *     this file still reads analytics_page_views.)
 *
 *   - conversations: has NEITHER is_bot NOR is_owner (verified in init.ts —
 *     the same finding profile-activity-service.ts already documented for
 *     slice 2). Used here for "matching search queries" and "conversations
 *     per channel"; both are known, unfiltered-by-bot/owner gaps, same as
 *     slice 2's topQueryTerms/platform badges. Both DO apply the shared
 *     COUNTABLE_CONV_SQL predicate (is_internal + traffic_class, a2a spam
 *     guard 2026-10-04), so our own fleet and classified spam/probe rows
 *     no longer reach the owner's numbers.
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
 *     as-is (unchanged) for the funnel's "discovered" stage. HISTORICALLY
 *     INFLATED: until the a2a spam guard (2026-10-04) discover() counted
 *     every candidate, not just the returned page, and spam a2a calls were
 *     tracked too. Since then only returned, countable results count; the
 *     history has no per-row source and is deliberately left as-is.
 */

import type Database from "better-sqlite3";
import { COUNTABLE_CONV_SQL } from "./a2a-traffic-classifier";
import { aiVendorBucket, storedClientClass, uaFromSessionId } from "./traffic-classifier";
import { AI_DELIVERY_WINDOW_DAYS, computeAiDeliveries, type AiDeliveries } from "./profile-ai-deliveries-compute";
import { getRetentionWindowDays } from "./retention-window";

/** The portal's window: the raw retention (RFB_AUTO_PRUNE_DAYS, 60), as on the public producer page. */
export function ownerStatsWindowDays(): number {
  return getRetentionWindowDays();
}

export function cutoffIsoFor(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export interface PathViewGroup {
  /** 'human', 'ai_search', 'ai_crawler', … — the session's class (stored at write time, else from its session_id). */
  cls: string;
  sessionId: string;
  source: string | null;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  views: number;
}

/**
 * The page views of one path since `cutoffIso`, grouped by session, source
 * and day, each group carrying its SESSION's class: page views only (2xx/304;
 * legacy rows without a status count), owner rows out, NULL session_id out.
 * Every row of a session has the same UA, so the session's class is the class
 * stored on any of its rows (MAX, as profile-activity-service.ts), else the
 * class recovered from its session_id. Shared by the RFB and gårdssalg owner
 * portals. No per-session velocity check (scrapers): the public producer tile
 * (agent-stats-compute.ts) runs that off-thread.
 */
export function readPathViewGroups(
  db: Database.Database,
  path: string,
  cutoffIso: string,
  opts: { vertical?: string } = {},
): PathViewGroup[] {
  const cols = new Set((db.prepare("PRAGMA table_info(analytics_page_views)").all() as Array<{ name: string }>).map((c) => c.name));
  const statusOk = cols.has("status_code") ? " AND (status_code IS NULL OR (status_code >= 200 AND status_code < 300) OR status_code = 304)" : "";
  const clientClass = cols.has("client_class") ? "MAX(client_class)" : "NULL";
  const source = cols.has("source") ? "source" : "NULL";
  const vertical = opts.vertical ? " AND vertical_id = ?" : "";
  const rows = db.prepare(`
    SELECT session_id, ${source} AS source, substr(created_at, 1, 10) AS day,
           ${clientClass} AS client_class, COUNT(*) AS views
    FROM analytics_page_views
    WHERE path = ?${vertical}
      AND (is_owner IS NULL OR is_owner = 0)
      AND created_at > ?${statusOk}
      AND session_id IS NOT NULL
    GROUP BY session_id, ${source}, day
  `).all(...(opts.vertical ? [path, opts.vertical] : [path]), cutoffIso) as Array<{
    session_id: string; source: string | null; day: string; client_class: string | null; views: number;
  }>;
  const stored = new Map<string, string>();
  for (const r of rows) {
    if (r.client_class && (!stored.has(r.session_id) || r.client_class > stored.get(r.session_id)!)) stored.set(r.session_id, r.client_class);
  }
  return rows.map((r) => ({
    cls: storedClientClass(r.session_id, stored.get(r.session_id) ?? null),
    sessionId: r.session_id,
    source: r.source,
    day: r.day,
    views: r.views,
  }));
}

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
  /**
   * «Med i AI-svar» (dev-request 2026-10-14-med-i-ai-svar-per-profil): times
   * the profile was sent to an AI assistant, last AI_DELIVERY_WINDOW_DAYS days
   * and since counting started, per AI and per channel.
   */
  aiDeliveries: { window: AiDeliveries; allTime: AiDeliveries };
}

/**
 * Groups 1 and 2 and the funnel's "viewed", from one read of the path's page
 * views over the window: views by source (total and per day) and the
 * funnel count are people's page views; the AI split is AI search only.
 */
function getPathViews(db: Database.Database, path: string, windowDays: number): {
  viewsBySource: OwnerStatsViewsBySource;
  aiPlatforms: OwnerStatsAiPlatforms;
  humanViews: number;
} {
  const totals: Record<string, number> = {};
  for (const source of PAGE_VIEW_SOURCES) totals[source] = 0;
  const daily = new Map<string, number>();
  const ai = { chatgpt: 0, claude: 0, other: 0 };
  let humanViews = 0;
  for (const g of readPathViewGroups(db, path, cutoffIsoFor(windowDays))) {
    if (g.cls === "human") {
      humanViews += g.views;
      // Rows without a known source (legacy) still count, under «unknown», so
      // the totals add up to the funnel's «Sett».
      const source = g.source && Object.prototype.hasOwnProperty.call(totals, g.source) ? g.source : "unknown";
      totals[source] = (totals[source] ?? 0) + g.views;
      const key = `${g.day}|${source}`;
      daily.set(key, (daily.get(key) ?? 0) + g.views);
    } else if (g.cls === "ai_search") {
      ai[aiVendorBucket(uaFromSessionId(g.sessionId))] += g.views;
    }
  }
  return {
    viewsBySource: {
      totals,
      daily: [...daily.entries()]
        .map(([key, count]) => { const [date, source] = key.split("|"); return { date, source, count }; })
        .sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source)),
    },
    aiPlatforms: { ...ai, total: ai.chatgpt + ai.claude + ai.other },
    humanViews,
  };
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
         AND ${COUNTABLE_CONV_SQL}
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
       WHERE seller_agent_id = ? AND ${COUNTABLE_CONV_SQL}
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
function getContactClicksByKind(db: Database.Database, agentId: string, windowDays: number): OwnerStatsClickKindCount[] {
  return countContactClicksByKind(db, agentId, { days: windowDays });
}

/**
 * Window for contact-click reads: either "last N days" (the owner-stats
 * shape) or an explicit calendar range (YYYY-MM-DD, `to` inclusive).
 */
export type ContactClickWindow = { days: number } | { from: string; to: string };

function contactClickWindowSql(win: ContactClickWindow): { sql: string; params: string[] } {
  if ("days" in win) return { sql: `created_at >= datetime('now', ?)`, params: [`-${win.days} days`] };
  return { sql: `created_at >= ? AND created_at < date(?, '+1 day')`, params: [win.from, win.to] };
}

/**
 * Shared by owner-stats (days window) and the admin partner-report (days or
 * from/to window) so both read contact_clicks with identical semantics:
 * is_bot = 0, grouped by kind, count desc.
 */
export function countContactClicksByKind(
  db: Database.Database,
  agentId: string,
  win: ContactClickWindow,
): OwnerStatsClickKindCount[] {
  const w = contactClickWindowSql(win);
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) as cnt
       FROM contact_clicks
       WHERE agent_id = ? AND is_bot = 0
         AND ${w.sql}
       GROUP BY kind
       ORDER BY cnt DESC`,
    )
    .all(agentId, ...w.params) as Array<{ kind: string; cnt: number }>;
  return rows.map((r) => ({ kind: r.kind, count: r.cnt }));
}

/**
 * Same filter as countContactClicksByKind, grouped by utm_source instead
 * (NULL/empty -> "(none)"). Aggregates only — never session_id.
 */
export function countContactClicksByUtmSource(
  db: Database.Database,
  agentId: string,
  win: ContactClickWindow,
): Array<{ source: string; count: number }> {
  const w = contactClickWindowSql(win);
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(utm_source, ''), '(none)') AS src, COUNT(*) as cnt
       FROM contact_clicks
       WHERE agent_id = ? AND is_bot = 0
         AND ${w.sql}
       GROUP BY src
       ORDER BY cnt DESC, src ASC`,
    )
    .all(agentId, ...w.params) as Array<{ src: string; cnt: number }>;
  return rows.map((r) => ({ source: r.src, count: r.cnt }));
}

/**
 * Group 6: discovered → viewed → kontakt-klikk funnel.
 *  - discovered: agent_metrics.times_discovered (pre-existing lifetime
 *    counter; not bot/owner-filterable — see module doc).
 *  - viewed: people's profile page views over the window (getPathViews).
 *  - contactClicked: sum of the window's bot-excluded contact-click counts
 *    already computed for group 5 (passed in — avoids re-querying).
 */
function getFunnel(
  db: Database.Database,
  agentId: string,
  humanViews: number,
  contactClickedTotal: number,
): OwnerStatsFunnel {
  const metricsRow = db
    .prepare(`SELECT times_discovered FROM agent_metrics WHERE agent_id = ?`)
    .get(agentId) as { times_discovered: number } | undefined;
  const discovered = metricsRow?.times_discovered ?? 0;
  return { discovered, viewed: humanViews, contactClicked: contactClickedTotal };
}

/**
 * Full owner-stats summary for one producer. `path` must be the exact
 * `/produsent/<slug>` path analytics_page_views recorded for this agent
 * (see agent-stats.ts's slugify(agent.name) convention — callers must use
 * the same slug derivation).
 */
export function getOwnerStats(db: Database.Database, agentId: string, path: string): OwnerStats {
  const windowDays = ownerStatsWindowDays();
  const { viewsBySource, aiPlatforms, humanViews } = getPathViews(db, path, windowDays);
  const matchingSearchQueries = getMatchingSearchQueries(db, agentId);
  const conversationsByChannel = getConversationsByChannel(db, agentId);
  const contactClicksByKind = getContactClicksByKind(db, agentId, windowDays);
  const contactClickedTotal = contactClicksByKind.reduce((sum, r) => sum + r.count, 0);
  const funnel = getFunnel(db, agentId, humanViews, contactClickedTotal);

  return {
    windowDays,
    viewsBySource,
    aiPlatforms,
    matchingSearchQueries,
    conversationsByChannel,
    contactClicksByKind,
    funnel,
    aiDeliveries: {
      window: computeAiDeliveries(db, "rfb", agentId, AI_DELIVERY_WINDOW_DAYS, Date.now()),
      allTime: computeAiDeliveries(db, "rfb", agentId, null, Date.now()),
    },
  };
}
