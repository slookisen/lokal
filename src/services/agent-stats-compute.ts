// ─── Per-agent public stats: pure computation ───────────────────────────
// dev-request 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-samtaler
// (skive 6). GET /api/agents/:id/stats (routes/agent-stats.ts) was the largest
// remaining source of main-thread stalls in prod: 17 stalls over 1 s between
// 2026-10-08 and 2026-10-11, up to 15 s right after a boot. Each cache miss
// runs a grouped read over the window's views of the page (the raw retention,
// 60 days; it was 90 until 2026-10-13) plus up to
// MAX_VELOCITY_CHECKS velocity reads, and every velocity read scans a full
// hour of analytics_page_views through the created_at index (there is no
// session_id index).
//
// This module holds that computation unchanged, as a pure function of an
// explicit connection, so the route can run it on the off-thread stats worker
// (task "agentStats", lane "public") and keep only a cache read on the request
// path. Keep the import graph pure: the worker imports this file, so nothing
// here may load database/init.

import type Database from "better-sqlite3";
import { getRetentionWindowDays } from "./retention-window";
import { redactPII } from "../utils/pii-redact";
import { COUNTABLE_CONV_SQL, countableConvSql, isPublicQueryTerm } from "./a2a-traffic-classifier";
import { AI_DELIVERY_WINDOW_DAYS, computeAiDeliveries, type AiDeliveries } from "./profile-ai-deliveries-compute";
import { classifySession, storedClientClass, uaFromSessionId, aiVendorBucket, type SessionVelocity } from "./traffic-classifier";
import { rollupBoundaryDateOn } from "./analytics-rollup-boundary";
import { computeProfileYear, profileYearFrom, type ProfileYear } from "./profile-year-compute";

/**
 * A session is velocity-checked around its first view of this page. One
 * indexed range read (≤ 1 hour of rows) per human-looking session; capped
 * per request so a page with an extreme number of sessions stays bounded —
 * sessions beyond the cap (the ones with the fewest views) count unchecked.
 */
export const MAX_VELOCITY_CHECKS = 200;

export interface AgentStatsPayload {
  agentId: string;
  humanViews: number;
  /** AI search only: assistants fetching the page for a person. AI crawlers are not counted. */
  aiViews: number;
  aiBreakdown: { chatgpt: number; claude: number; other: number };
  conversationCount: number;
  lastConversations: Array<{ source: string; createdAt: string; question: string }>;
  /** The window of humanViews/aiViews in days: the raw retention (RFB_AUTO_PRUNE_DAYS, 60). */
  windowDays: number;
  /**
   * «Med i AI-svar»: times the profile was sent to an AI assistant (list and
   * profile pages, MCP, A2A) in the last AI_DELIVERY_WINDOW_DAYS days
   * (profile-ai-deliveries-compute.ts). Sent to the AI, not seen by a person.
   */
  aiDeliveries: AiDeliveries;
  /**
   * The tiles' numbers over the last 12 months, or since the first day with
   * data, with their «siste 12 måneder» / «siden <dato>» labels
   * (profile-year-compute.ts; dev-request 2026-10-22-statistikk-samme-tall-
   * 12-mnd, S2c). The 60-day fields above keep their meaning.
   */
  year: ProfileYear;
}

// SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" (space-separated); the
// window cutoff below and the velocity reads compare against that format.
export function sqliteDatetime(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/**
 * Per-session request velocity around `anchorMs` (the query behind
 * getSessionVelocity in analytics-service.ts, over an explicit connection).
 * Returns null when the read fails, exactly like getSessionVelocity.
 */
export function readSessionVelocity(
  db: Database.Database,
  sessionId: string,
  anchorMs: number,
  mode: "trailing" | "centered"
): SessionVelocity | null {
  try {
    const span = (ms: number): [string, string] => mode === "trailing"
      ? [sqliteDatetime(new Date(anchorMs - ms)), sqliteDatetime(new Date(anchorMs))]
      : [sqliteDatetime(new Date(anchorMs - ms / 2)), sqliteDatetime(new Date(anchorMs + ms / 2))];
    const [from10, to10] = span(10 * 60 * 1000);
    const [fromHour, toHour] = span(60 * 60 * 1000);
    const row = db.prepare(`
      SELECT
        COUNT(DISTINCT CASE WHEN created_at >= ? AND created_at <= ? THEN path END) AS u10,
        COUNT(DISTINCT CASE WHEN path LIKE '%/produsent/%' THEN path END) AS p60
      FROM analytics_page_views
      WHERE created_at >= ? AND created_at <= ? AND session_id = ?
    `).get(from10, to10, fromHour, toHour, sessionId) as { u10: number; p60: number } | undefined;
    return { uniquePagesIn10Min: row?.u10 ?? 0, produsentPagesInHour: row?.p60 ?? 0 };
  } catch (err) {
    console.error("[analytics] Failed to read session velocity:", err);
    return null;
  }
}

/** 'YYYY-MM-DD' of the UTC day after `nowMs` (rollupBoundaryDateOn's value for an empty raw table). */
function utcTomorrow(nowMs: number): string {
  return new Date(nowMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The public stats payload for one producer page (`path` = /produsent/<slug>).
 * The caller has already resolved the agent and applied the quarantine gate.
 */
export function computeAgentStats(
  db: Database.Database,
  agentId: string,
  path: string,
  nowMs: number
): AgentStatsPayload {
  // ─── Period ──────────────────────────────────────────────────────
  // The raw rows' retention window (60 days). It used to be 90 days: people
  // and «other AI» were then counted over the 60 stored days only, and
  // ChatGPT/Claude topped up from page_view_daily, which counted files and
  // every status — one tile, three different periods and definitions
  // (dev-request 2026-10-13-statistikk-riktig-for-investorer, S5). The tile
  // labels in seo.ts read windowDays.
  const windowDays = getRetentionWindowDays();
  const cutoffIso = sqliteDatetime(new Date(nowMs - windowDays * 24 * 60 * 60 * 1000));
  // Page views only (page-view-definition.ts): 2xx or 304; legacy rows have no status.
  const cols = new Set((db.prepare("PRAGMA table_info(analytics_page_views)").all() as Array<{ name: string }>).map((c) => c.name));
  const statusOk = cols.has("status_code") ? " AND (status_code IS NULL OR (status_code >= 200 AND status_code < 300) OR status_code = 304)" : "";
  // The class stored at write time from the full UA (S1); every row of a
  // session has the same UA, so MAX() only skips legacy rows without one.
  // (Only a change to the classifier's pattern lists between two deploys can
  // give one session two stored classes; MAX() then takes the alphabetically
  // last one for up to the retention window.)
  const clientClass = cols.has("client_class") ? "MAX(client_class)" : "NULL";

  // ── Views: ONE grouped read, bucketed by the shared classifier ───
  // We anchor on path equality (not LIKE) because the slug uniquely
  // identifies the producer page. is_owner filter excludes our own ops
  // traffic (RFB-ContactVerifier etc.) so the count reflects real
  // public visits.
  //
  // The same read also counts the 12-month tiles' raw part (S2c): every view
  // from the raw floor of analytics_agent_views on (`yearViews`), the days
  // before it come from the stored daily sums (profile-year-compute.ts).
  // `views` and `first_seen` stay those of the 60-day window. The raw part
  // never starts before the 12-month window (a raw table that was not pruned).
  const yearFrom = profileYearFrom(nowMs);
  const hasAgentViews = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'analytics_agent_views'").get();
  const rawFloor = hasAgentViews ? rollupBoundaryDateOn(db, "analytics_agent_views") : utcTomorrow(nowMs);
  const rawFrom = rawFloor > yearFrom ? rawFloor : yearFrom;
  const rawFromIso = `${rawFrom} 00:00:00`;
  const readFromIso = rawFromIso < cutoffIso ? rawFromIso : cutoffIso;
  const sessions = (db.prepare(`
    SELECT session_id, ${clientClass} as client_class,
      SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) as views,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as yearViews,
      MIN(CASE WHEN created_at > ? THEN created_at END) as first_seen,
      MIN(created_at) as first_any
    FROM analytics_page_views
    WHERE path = ?
      AND (is_owner IS NULL OR is_owner = 0)
      AND created_at >= ?${statusOk}
    GROUP BY session_id
  `).all(cutoffIso, rawFromIso, cutoffIso, path, readFromIso) as Array<{ session_id: string | null; client_class: string | null; views: number; yearViews: number; first_seen: string | null; first_any: string }>)
    .filter((s) => s.views > 0 || s.yearViews > 0);

  // The AI tile counts AI search only: an assistant fetching the page for a
  // person (ChatGPT-User, Claude-User, Perplexity-User …), which is what its
  // tooltip says. AI crawlers (GPTBot, ClaudeBot, OAI-SearchBot …) index
  // pages and are not counted (Daniel 2026-10-13: «Tell bare AI-søk, behold
  // teksten»).
  const aiRaw = { chatgpt: 0, claude: 0, other: 0 };
  let aiYearRaw = 0;
  const humanLooking: typeof sessions = [];
  for (const s of sessions) {
    const sessionId = s.session_id || "";
    const category = storedClientClass(sessionId, s.client_class);
    if (category === "human") humanLooking.push(s);
    else if (category === "ai_search") {
      aiRaw[aiVendorBucket(uaFromSessionId(sessionId))] += s.views;
      aiYearRaw += s.yearViews;
    }
  }

  // Velocity: a browser UA proves nothing (see traffic-classifier.ts
  // isVelocityScraper). Largest sessions first, so the cap never lets the
  // sessions that move the number most go unchecked. The sort is stable, so
  // sessions with views only before the 60-day cutoff come last and the
  // 60-day sessions are checked exactly as before.
  humanLooking.sort((a, b) => b.views - a.views);
  let humanViews = 0;
  let humanYearRaw = 0;
  humanLooking.forEach((s, i) => {
    if (i < MAX_VELOCITY_CHECKS) {
      const anchor = Date.parse((s.first_seen ?? s.first_any).replace(" ", "T") + "Z");
      const velocity = Number.isFinite(anchor) ? readSessionVelocity(db, s.session_id || "", anchor, "centered") : null;
      if (classifySession(s.session_id || "", { velocity }) !== "human") return;
    }
    humanViews += s.views;
    humanYearRaw += s.yearViews;
  });

  const aiChatgpt = aiRaw.chatgpt;
  const aiClaude = aiRaw.claude;
  const aiOther = aiRaw.other;
  const aiViews = aiChatgpt + aiClaude + aiOther;

  // ── Conversations: count + last 5 with first buyer message ───────
  // seller_agent_id only; buyer_agent_id is never returned. Countable only
  // (a2a spam guard): our own fleet traffic and classified spam/probe
  // conversations are never public engagement.
  const convCountRow = db.prepare(`
    SELECT COUNT(*) as count FROM conversations WHERE seller_agent_id = ? AND ${COUNTABLE_CONV_SQL}
  `).get(agentId) as { count: number } | undefined;
  const conversationCount = convCountRow?.count ?? 0;

  interface ConvRow {
    id: string;
    source: string | null;
    created_at: string;
    query_text: string | null;
    first_buyer_msg: string | null;
  }

  // Prefer the conversation's query_text; fall back to the first inbound
  // message for older rows. A wider window than the 5 shown, so rows dropped
  // by the public query allow-list below don't leave the card short.
  const lastConvs = db.prepare(`
    SELECT
      c.id,
      c.source,
      c.created_at,
      c.query_text,
      (SELECT m.content FROM messages m
        WHERE m.conversation_id = c.id AND m.sender_role = 'buyer'
        ORDER BY m.created_at ASC LIMIT 1) as first_buyer_msg
    FROM conversations c
    WHERE c.seller_agent_id = ? AND ${countableConvSql("c")}
    ORDER BY c.created_at DESC
    LIMIT 20
  `).all(agentId) as ConvRow[];

  const lastConversations = lastConvs.map(r => {
    const question = (r.query_text && r.query_text.trim()) || (r.first_buyer_msg && r.first_buyer_msg.trim()) || "";
    // Public query allow-list (no URLs/JSON/wallet strings/CJK payloads),
    // then redactPII — this card is unauthenticated.
    if (!isPublicQueryTerm(question, { maxLen: 500, maxWords: 80, allowPii: true })) return null;
    const safe = redactPII(question);
    // ~140 chars keeps the profile-card tile compact on mobile.
    const truncated = safe.length > 140 ? safe.slice(0, 137) + "..." : safe;
    return {
      source: r.source || "api",
      createdAt: r.created_at,
      question: truncated,
    };
  }).filter((c): c is { source: string; createdAt: string; question: string } => !!c && c.question.length > 0)
    .slice(0, 5);

  return {
    agentId,
    humanViews,
    aiViews,
    aiBreakdown: { chatgpt: aiChatgpt, claude: aiClaude, other: aiOther },
    conversationCount,
    lastConversations,
    windowDays,
    aiDeliveries: computeAiDeliveries(db, "rfb", agentId, AI_DELIVERY_WINDOW_DAYS, nowMs),
    year: computeProfileYear(db, agentId, { rawFrom, humanViews: humanYearRaw, aiViews: aiYearRaw }, nowMs),
  };
}
