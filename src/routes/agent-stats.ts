/**
 * Per-agent usage stats — public endpoint
 *
 * Powers the visibility tiles + "Siste 5 samtaler"-kortet på /produsent/<slug>.
 *
 *  GET /api/agents/:id/stats
 *
 * Returns all-time aggregates pulled from existing analytics tables. We do NOT
 * write anything new in this route — all source data is already captured by
 * analytics-service middleware and trackAgentView() in seo.ts. We just slice
 * it per agent here.
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

const router = Router();

// ─── slug helper (mirrors seo.ts::slugify) ────────────────────────────
// MUST stay byte-identical to seo.ts or we'll under-count visits because
// the path stored in analytics_page_views won't match what we look up.
// There's a regression test guarding this in tests/test.ts.
function slugify(text: string): string {
  return (text || "").normalize("NFC").toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ─── AI bot UA markers stored in session_id (`${ipHash}:${userAgent}`) ─
// Each marker is a substring we LIKE-match against session_id. Aligned with
// analytics-service.ts parseUserAgent + getSummary so the per-agent split
// matches the dashboard top-level totals.
const AI_MARKERS = {
  chatgpt: ["GPTBot", "ChatGPT", "OAI-SearchBot"],
  claude: ["ClaudeBot", "Claude-User", "Anthropic"],
  other: [
    "Gemini", "Google-Extended", "PerplexityBot", "Perplexity-User",
    "CCBot", "Bytespider", "Applebot-Extended", "YandexAdditional",
    "NotHumanSearch", "DuckDuckBot", "Googlebot",
  ],
};

function buildLikeClause(markers: string[]): { clause: string; params: string[] } {
  const parts = markers.map(() => "session_id LIKE ?");
  return {
    clause: parts.join(" OR "),
    params: markers.map(m => `%${m}%`),
  };
}

// All AI markers combined — for "human = NOT any AI marker"
const ALL_AI_MARKERS = [...AI_MARKERS.chatgpt, ...AI_MARKERS.claude, ...AI_MARKERS.other];

// ─── GET /api/agents/:id/stats ─────────────────────────────────────────
router.get("/api/agents/:id/stats", (req: Request, res: Response) => {
  try {
    const agentId = String(req.params.id || "").trim();
    if (!agentId) return res.status(400).json({ error: "agent id required" });

    // Resolve the agent — we need the canonical name to derive the URL path
    // analytics_page_views actually saw (`/produsent/<slug>`).
    const agents = marketplaceRegistry.getActiveAgents();
    const agent = agents.find((a: any) => a.id === agentId);
    if (!agent) return res.status(404).json({ error: "agent not found" });

    const slug = slugify(agent.name);
    const path = `/produsent/${slug}`;

    const db = getDb();

    // ── Human views: analytics_page_views with NO bot UA marker ──────
    // We anchor on path equality (not LIKE) because the slug uniquely
    // identifies the producer page. is_owner filter excludes our own ops
    // traffic (RFB-ContactVerifier etc.) so the count reflects real
    // public visits.
    const aiNotClause = ALL_AI_MARKERS.map(() => "session_id NOT LIKE ?").join(" AND ");
    const aiNotParams = ALL_AI_MARKERS.map(m => `%${m}%`);

    const humanRow = db.prepare(`
      SELECT COUNT(*) as count FROM analytics_page_views
      WHERE path = ?
        AND (is_owner IS NULL OR is_owner = 0)
        AND ${aiNotClause}
    `).get(path, ...aiNotParams) as { count: number } | undefined;
    const humanViews = humanRow?.count ?? 0;

    // ── AI views split: chatgpt / claude / other ─────────────────────
    function countAiBucket(markers: string[]): number {
      const { clause, params } = buildLikeClause(markers);
      const row = db.prepare(`
        SELECT COUNT(*) as count FROM analytics_page_views
        WHERE path = ? AND (is_owner IS NULL OR is_owner = 0)
          AND (${clause})
      `).get(path, ...params) as { count: number } | undefined;
      return row?.count ?? 0;
    }
    const aiChatgpt = countAiBucket(AI_MARKERS.chatgpt);
    const aiClaude = countAiBucket(AI_MARKERS.claude);
    const aiOther = countAiBucket(AI_MARKERS.other);
    const aiViews = aiChatgpt + aiClaude + aiOther;

    // ── Conversations: count + last 5 with first buyer message ───────
    // We rely on seller_agent_id only. buyer_agent_id stays in the DB
    // for our own analytics but is never returned to clients.
    const convCountRow = db.prepare(`
      SELECT COUNT(*) as count FROM conversations WHERE seller_agent_id = ?
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
      WHERE c.seller_agent_id = ?
      ORDER BY c.created_at DESC
      LIMIT 5
    `).all(agentId) as ConvRow[];

    const lastConversations = lastConvs.map(r => {
      const question = (r.query_text && r.query_text.trim()) || (r.first_buyer_msg && r.first_buyer_msg.trim()) || "";
      // Truncate aggressively — these render in a profile card, not a chat
      // view. ~140 chars matches our typical query length and keeps the
      // tile compact on mobile.
      const truncated = question.length > 140 ? question.slice(0, 137) + "..." : question;
      return {
        source: r.source || "api",
        createdAt: r.created_at,
        question: truncated,
      };
    }).filter(c => c.question.length > 0);  // Hide bare/empty rows

    res.json({
      agentId,
      humanViews,
      aiViews,
      aiBreakdown: { chatgpt: aiChatgpt, claude: aiClaude, other: aiOther },
      conversationCount,
      lastConversations,
    });
  } catch (err) {
    console.error("[agent-stats] failed:", err);
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
