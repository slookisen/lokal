/**
 * Per-agent usage stats — public endpoint
 *
 * Powers the visibility tiles + "Siste 5 samtaler"-kortet på /produsent/<slug>.
 *
 *  GET /api/agents/:id/stats
 *
 * Returns last-90-days view aggregates pulled from existing analytics tables.
 * conversationCount and lastConversations remain all-time (cumulative engagement
 * is a meaningful lifetime metric; views are noisy and benefit from a window).
 * We do NOT
 * write anything new in this route — all source data is already captured by
 * analytics-service middleware and trackAgentView() in seo.ts. We just slice
 * it per agent here.
 *
 * No-double-count contract:
 *  - This route is mounted under /api/* which the analytics middleware
 *    explicitly excludes from page-view tracking
 *    (see analytics-service.ts middleware: `!req.path.startsWith("/api/")`).
 *  - Therefore, browser-side hydration calls to /api/agents/:id/stats do
 *    NOT register a second page-view. The /produsent/<slug> SEO render
 *    is the only thing that increments analytics_page_views.
 *  - If you ever change either the mount path or the analytics-middleware
 *    filter, also re-verify this guarantee.
 *
 * Rate-limit:
 *  - Inherits app.use("/api", generalLimiter) from index.ts: 300 req / 15 min
 *    per IP. No extra limiter needed.
 *
 * Privacy:
 *  - No buyer identity, no IP hashes, no email — only the buyer's first
 *    message text (which is what the seller agent answers based on public
 *    profile data anyway).
 *  - Conversations table contains negotiation content. We expose ONLY the
 *    initial query_text + source channel + relative timestamp. Full
 *    threads remain admin/owner-only.
 */

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { slugify } from "../utils/slug";
import { getPrunedChatgptClaudeCounts } from "../services/analytics-rollup-reads";
import { redactPII } from "../utils/pii-redact";
import { COUNTABLE_CONV_SQL, countableConvSql, isPublicQueryTerm } from "../services/a2a-traffic-classifier";
import { getSessionVelocity } from "../services/analytics-service";
import { classifySession, uaFromSessionId, aiVendorBucket } from "../services/traffic-classifier";

const router = Router();

// SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" (space-separated) —
// mirrors the JS-side cutoff used elsewhere (analytics-service.ts,
// routes/analytics.ts) so getPrunedChatgptClaudeCounts's day-string
// comparison lines up with the `datetime('now', '-90 days')` used in the SQL
// below (sub-second clock skew between the two evaluations is immaterial at
// day granularity).
function sqliteDatetime(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

// ─── View classification: the SHARED traffic classifier ───────────────
// 2026-10-04 (view-stats honesty): this file used to keep its own short
// AI-marker LIKE list and called everything else "human" — so bingbot,
// PetalBot, AhrefsBot, SemrushBot, ExaSearchBot, scanners and browser-UA
// scrapers all inflated the public humanViews tile, while Googlebot and
// DuckDuckBot were counted as "AI other". Views are now bucketed by
// traffic-classifier.ts (the declared single source of truth), exactly like
// AnalyticsService.getSummary.agentTraffic:
//   human  = classifySession(...) === 'human', after the velocity check
//   AI     = ai_search + ai_crawler, split by aiVendorBucket
//   search engines / SEO tools / social / dev / scanners / scrapers = neither.

// A session is velocity-checked around its first view of this page. One
// indexed range read (≤ 1 hour of rows) per human-looking session; capped
// per request so a page with an extreme number of sessions stays bounded —
// sessions beyond the cap (the ones with the fewest views) count unchecked.
const MAX_VELOCITY_CHECKS = 200;

// ─── Public-response cache ────────────────────────────────────────────
// The aggregates below cost several indexed reads per request; a burst of
// hydration calls used to stall the event loop for seconds on prod. 120 s
// in-memory TTL keyed by agent id, bounded (oldest entry evicted first).
// Lookup happens AFTER the quarantine/unknown-agent checks, so a cached
// payload can never outlive a 404 decision.
const STATS_CACHE_TTL_MS = 120_000;
const STATS_CACHE_MAX_ENTRIES = 2000;
const statsCache = new Map<string, { payload: unknown; storedAt: number }>();
let nowMs: () => number = () => Date.now();

function getCachedStats(agentId: string): unknown | undefined {
  const hit = statsCache.get(agentId);
  if (!hit) return undefined;
  if (nowMs() - hit.storedAt >= STATS_CACHE_TTL_MS) {
    statsCache.delete(agentId);
    return undefined;
  }
  return hit.payload;
}

function setCachedStats(agentId: string, payload: unknown): void {
  statsCache.delete(agentId);
  while (statsCache.size >= STATS_CACHE_MAX_ENTRIES) {
    const oldest = statsCache.keys().next().value;
    if (oldest === undefined) break;
    statsCache.delete(oldest);
  }
  statsCache.set(agentId, { payload, storedAt: nowMs() });
}

/** Test-only seam: clear the cache and/or pin the clock (null restores Date.now). */
export function __resetAgentStatsCacheForTesting(clock?: (() => number) | null): void {
  statsCache.clear();
  if (clock !== undefined) nowMs = clock ?? (() => Date.now());
}

// ─── GET /api/agents/:id/stats ─────────────────────────────────────────
router.get("/api/agents/:id/stats", (req: Request, res: Response) => {
  try {
    const agentId = String(req.params.id || "").trim();
    if (!agentId) return res.status(400).json({ error: "agent id required" });

    // dev-request 2026-08-03-mikhailo-quarantine-gates (Gate 1 extension):
    // 404 exactly like an unknown id for a not-yet-vetted self-registered
    // agent — this is a public, unauthenticated endpoint (see file header),
    // same rule as /agents/:id/card, /info, /vcard, and /trust in
    // marketplace.ts. Reuses the shared helper rather than reimplementing
    // the quarantine check inline.
    if (marketplaceRegistry.isQuarantinedFromPublicView(agentId)) {
      return res.status(404).json({ error: "agent not found" });
    }

    // Resolve the agent — we need the canonical name to derive the URL path
    // analytics_page_views actually saw (`/produsent/<slug>`).
    // Phase 5.11 follow-up: include umbrella-tagged agents. Without this,
    // any umbrella that hits top-N on /admin/analytics/producers (e.g. "Bondens
    // marked Norge") 404s here — and the visibility-agent's runtime probe
    // (which picks the top producer at runtime) breaks whenever an umbrella
    // happens to be #1. Producer-discovery surfaces still use the narrower
    // getActiveAgents() everywhere else.
    const agent = marketplaceRegistry.getActiveAgentByIdIncludingUmbrellas(agentId);
    if (!agent) return res.status(404).json({ error: "agent not found" });

    // Use the shared slugify util (single source of truth — same as seo.ts).
    // Empty-name guard handled inline since shared util doesn't take falsy.
    const slug = slugify(agent.name || "");
    const path = `/produsent/${slug}`;

    const cached = getCachedStats(agentId);
    if (cached !== undefined) {
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json(cached);
    }

    const db = getDb();

    // ─── Period cutoff ───────────────────────────────────────────────
    // 90 days. Tile labels "Sidevisninger ... siste 90 dager" must stay in
    // sync with this; if you change the window here, also update seo.ts
    // (search for "siste 90 dager" / "last 90 days").
    const PERIOD_CUTOFF = "datetime('now', '-90 days')";

    // ── Views: ONE grouped read, bucketed by the shared classifier ───
    // We anchor on path equality (not LIKE) because the slug uniquely
    // identifies the producer page. is_owner filter excludes our own ops
    // traffic (RFB-ContactVerifier etc.) so the count reflects real
    // public visits. Replaces four separate COUNT(*) … LIKE '%marker%'
    // scans with a single GROUP BY session_id on the path index.
    const sessions = db.prepare(`
      SELECT session_id, COUNT(*) as views, MIN(created_at) as first_seen
      FROM analytics_page_views
      WHERE path = ?
        AND (is_owner IS NULL OR is_owner = 0)
        AND created_at >= ${PERIOD_CUTOFF}
      GROUP BY session_id
    `).all(path) as Array<{ session_id: string | null; views: number; first_seen: string }>;

    const aiRaw = { chatgpt: 0, claude: 0, other: 0 };
    const humanLooking: typeof sessions = [];
    for (const s of sessions) {
      const sessionId = s.session_id || "";
      const category = classifySession(sessionId);
      if (category === "human") humanLooking.push(s);
      else if (category === "ai_search" || category === "ai_crawler") {
        aiRaw[aiVendorBucket(uaFromSessionId(sessionId))] += s.views;
      }
    }

    // Velocity: a browser UA proves nothing (see traffic-classifier.ts
    // isVelocityScraper). Largest sessions first, so the cap never lets the
    // sessions that move the number most go unchecked.
    humanLooking.sort((a, b) => b.views - a.views);
    let humanViews = 0;
    humanLooking.forEach((s, i) => {
      if (i < MAX_VELOCITY_CHECKS) {
        const anchor = Date.parse(s.first_seen.replace(" ", "T") + "Z");
        const velocity = Number.isFinite(anchor) ? getSessionVelocity(s.session_id || "", anchor, "centered") : null;
        if (classifySession(s.session_id || "", { velocity }) !== "human") return;
      }
      humanViews += s.views;
    });

    // Skive 3 (dev-request 2026-09-02-analytics-historikk-rollup-lesere-
    // foer-retention): the 90-day PERIOD_CUTOFF above already reaches PAST
    // the default 60-day auto-prune retention window (RFB_AUTO_PRUNE_DAYS),
    // so this PUBLIC endpoint was already silently missing up to 30 days of
    // real history for every producer before this slice — not a hypothetical
    // edge case. chatgpt/claude are blended exactly (page_view_daily's
    // bot_type token sets are GPTBot/ChatGPT/OAI-SearchBot and
    // ClaudeBot/Claude-User/Anthropic — see getPrunedChatgptClaudeCounts's doc
    // comment). `aiOther` and `humanViews` are NOT blended: rollup's bot_type
    // classifier uses a different, coarser token match than the shared
    // classifier (e.g. Perplexity-User, ExaSearchBot, NotHumanSearch all land
    // in rollup bot_type='human' or 'other_bot'), and it has no velocity
    // signal — a partial blend there would silently change WHICH sessions
    // count as human, not just how far back the count reaches. Documented
    // known gap: both stay raw-only (never crash, never drop to a fabricated
    // zero — they simply keep reflecting only the still-in-raw portion of the
    // 90-day window).
    const cutoffIso = sqliteDatetime(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
    const prunedAi = getPrunedChatgptClaudeCounts(cutoffIso, { path });

    const aiChatgpt = aiRaw.chatgpt + prunedAi.chatgpt;
    const aiClaude = aiRaw.claude + prunedAi.claude;
    const aiOther = aiRaw.other;
    const aiViews = aiChatgpt + aiClaude + aiOther;

    // ── Conversations: count + last 5 with first buyer message ───────
    // We rely on seller_agent_id only. buyer_agent_id stays in the DB
    // for our own analytics but is never returned to clients.
    // Countable only (a2a spam guard): our own fleet traffic and classified
    // spam/probe conversations are never public engagement.
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

    // For each conversation, prefer the explicit query_text on the
    // conversation row (this is what the buyer agent originally asked).
    // Fall back to the first inbound message body if query_text is empty,
    // which can happen for older conversations created before the
    // query_text column existed.
    // A wider window than the 5 shown, so rows dropped by the public
    // query allow-list below don't leave the card short.
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
      // Truncate aggressively — these render in a profile card, not a chat
      // view. ~140 chars matches our typical query length and keeps the
      // tile compact on mobile.
      const truncated = safe.length > 140 ? safe.slice(0, 137) + "..." : safe;
      return {
        source: r.source || "api",
        createdAt: r.created_at,
        question: truncated,
      };
    }).filter((c): c is { source: string; createdAt: string; question: string } => !!c && c.question.length > 0)  // Hide bare/empty/rejected rows
      .slice(0, 5);

    // 5-min HTTP cache. All-time aggregates change slowly; this absorbs
    // most of the load from AI bot crawls (which hit /produsent/<slug>
    // and trigger the hydration script) without sacrificing freshness.
    res.setHeader("Cache-Control", "public, max-age=300");

    const payload = {
      agentId,
      humanViews,
      aiViews,
      aiBreakdown: { chatgpt: aiChatgpt, claude: aiClaude, other: aiOther },
      conversationCount,
      lastConversations,
    };
    setCachedStats(agentId, payload);
    res.json(payload);
  } catch (err) {
    console.error("[agent-stats] failed:", err);
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
