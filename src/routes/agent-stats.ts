/**
 * Per-agent usage stats — public endpoint
 *
 * Powers the visibility tiles + "Siste 5 samtaler"-kortet på /produsent/<slug>.
 *
 *  GET /api/agents/:id/stats
 *
 * Returns view aggregates over the raw retention window (60 days; `windowDays`
 * in the payload) pulled from existing analytics tables.
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
import { marketplaceRegistry } from "../services/marketplace-registry";
import { slugify } from "../utils/slug";
import { readAgentStats, __resetAgentStatsReaderForTesting } from "../services/agent-stats-reader";
import { getDb } from "../database/init";
import { publicFieldChoices } from "../owner-features/enforce";
import { publicCountsShown } from "../services/public-stats-threshold";

const router = Router();

// The computation itself (views bucketed by the shared traffic classifier,
// velocity checks, rollup blend, conversations) lives unchanged in
// services/agent-stats-compute.ts, so it can run on the off-thread stats
// worker. See that file for the details.

// ─── Public-response cache ────────────────────────────────────────────
// Serverheng skive 6: the payload is read through services/agent-stats-
// reader.ts — computed in the off-thread stats worker ("public" lane) behind
// an SWR cache when the DB allows it, synchronously with the old 120 s cache
// otherwise. See that file. The cache read happens AFTER the
// quarantine/unknown-agent checks below, so a cached payload can never
// outlive a 404 decision.

/** Test-only seam: clear the caches and/or pin the cache clock (null restores Date.now). */
export function __resetAgentStatsCacheForTesting(clock?: (() => number) | null): void {
  __resetAgentStatsReaderForTesting(clock);
}

/** The count fields a profile below the public threshold leaves out (no zeros either). */
export const PUBLIC_STATS_COUNT_FIELDS = ["humanViews", "aiViews", "aiBreakdown", "aiDeliveries", "year"] as const;

/**
 * «Mine valg» S2f: the payload's view and AI counts follow the profile
 * tiles — shown only with at least PUBLIC_STATS_MIN_VIEWS (20) page views from
 * people over 12 months (the owner's own «Sett», services/public-stats-
 * threshold.ts) and stats.public_counts not off. Otherwise the count fields
 * are left out and `publicCounts: false` says why; conversations stay.
 */
function publicStatsPayload(payload: any, agentId: string, path: string): any {
  if (!payload || typeof payload !== "object") return payload;
  const choices = publicFieldChoices(agentId);
  if (publicCountsShown(getDb(), agentId, path, choices ? choices.publicCounts : null)) return payload;
  const out: any = { ...payload, publicCounts: false };
  for (const f of PUBLIC_STATS_COUNT_FIELDS) delete out[f];
  return out;
}

// ─── GET /api/agents/:id/stats ─────────────────────────────────────────
router.get("/api/agents/:id/stats", async (req: Request, res: Response) => {
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

    const result = await readAgentStats(agentId, path);
    if (result.status === 503) {
      res.setHeader("Retry-After", "30");
      return res.status(503).json({ error: "stats not ready" });
    }

    // 5-min HTTP cache. All-time aggregates change slowly; this absorbs
    // most of the load from AI bot crawls (which hit /produsent/<slug>
    // and trigger the hydration script) without sacrificing freshness.
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(publicStatsPayload(result.payload, agentId, path));
  } catch (err) {
    console.error("[agent-stats] failed:", err);
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
