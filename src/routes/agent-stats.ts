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
import { computeAgentStats, type AgentStatsPayload } from "../services/agent-stats-compute";
import { createSwrCache, offThreadStatsUsable, runStatsTaskOffThread } from "../services/offthread-stats";

const router = Router();

// The computation itself (views bucketed by the shared traffic classifier,
// velocity checks, rollup blend, conversations) lives unchanged in
// services/agent-stats-compute.ts, so it can run on the off-thread stats
// worker. See that file for the details.

// ─── Public-response cache ────────────────────────────────────────────
// Serverheng skive 6 (dev-request 2026-10-08-serverheng-hovedtraad-oppstart-
// statistikk-samtaler): with a file-backed WAL DB the payload is computed in
// the off-thread stats worker ("public" lane) and requests only read an SWR
// cache: a fresh value (< 15 min) is served as-is, a stale one is served
// immediately while a background refresh runs, and a cold miss waits up to
// AGENT_STATS_OFFTHREAD_WAIT_MS for the first result (503 after that; the page's
// hydration script fails quietly and simply shows no tiles). The numbers are
// 90-day and all-time aggregates, so minutes of staleness change nothing a
// visitor can see. In-memory DBs, OFFTHREAD_STATS_DISABLED=1 and a broken
// worker (three failures in a row) use the synchronous path below with the
// old 120 s cache — the pre-skive-6 behaviour.
// Lookup happens AFTER the quarantine/unknown-agent checks, so a cached
// payload can never outlive a 404 decision.
const STATS_CACHE_TTL_MS = 120_000;
const STATS_CACHE_MAX_ENTRIES = 2000;
export const AGENT_STATS_OFFTHREAD_TTL_MS = 15 * 60_000;
export const AGENT_STATS_OFFTHREAD_WAIT_MS = 20_000;
const AGENT_STATS_TASK_KEY = "agentStats";
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

// Key = agent id + page path: a renamed producer gets a new slug, so its
// cached payload is not reused for the new path.
const KEY_SEP = "\n";
let offThreadDbPath: string | null = null;
const offThreadStats = createSwrCache<AgentStatsPayload>({
  ttlMs: AGENT_STATS_OFFTHREAD_TTL_MS,
  maxEntries: STATS_CACHE_MAX_ENTRIES,
  retryAfterMs: 60_000,
  now: () => nowMs(),
  refresh: (key) => {
    const dbPath = offThreadDbPath;
    if (!dbPath) return Promise.reject(new Error("no DB path for off-thread agent stats"));
    const sep = key.indexOf(KEY_SEP);
    const agentId = key.slice(0, sep);
    const path = key.slice(sep + KEY_SEP.length);
    return runStatsTaskOffThread<AgentStatsPayload>(dbPath, { kind: "agentStats", agentId, path, nowMs: Date.now() });
  },
  onError: (key, err) =>
    console.warn(
      `[agent-stats] off-thread refresh failed for ${key.split(KEY_SEP)[0]}: ${err instanceof Error ? err.message : String(err)}`
    ),
});

function waitAtMost(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
    p.then(
      () => { clearTimeout(t); resolve(); },
      () => { clearTimeout(t); resolve(); },
    );
  });
}

/** Test-only seam: clear the caches and/or pin the clock (null restores Date.now). */
export function __resetAgentStatsCacheForTesting(clock?: (() => number) | null): void {
  statsCache.clear();
  offThreadStats.clear();
  offThreadDbPath = null;
  if (clock !== undefined) nowMs = clock ?? (() => Date.now());
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

    const db = getDb();

    if (offThreadStatsUsable(db, AGENT_STATS_TASK_KEY)) {
      if (offThreadDbPath !== db.name) {
        offThreadStats.clear();
        offThreadDbPath = db.name;
      }
      const key = agentId + KEY_SEP + path;
      let hit = offThreadStats.get(key); // a stale or missing value schedules a refresh
      if (!hit) {
        await waitAtMost(offThreadStats.settled(key), AGENT_STATS_OFFTHREAD_WAIT_MS);
        hit = offThreadStats.get(key);
      }
      if (!hit) {
        res.setHeader("Retry-After", "30");
        return res.status(503).json({ error: "stats not ready" });
      }
      // 5-min HTTP cache, as on the synchronous path.
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json(hit.value);
    }

    const cached = getCachedStats(agentId);
    if (cached !== undefined) {
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json(cached);
    }

    const payload = computeAgentStats(db, agentId, path, Date.now());

    // 5-min HTTP cache. All-time aggregates change slowly; this absorbs
    // most of the load from AI bot crawls (which hit /produsent/<slug>
    // and trigger the hydration script) without sacrificing freshness.
    res.setHeader("Cache-Control", "public, max-age=300");
    setCachedStats(agentId, payload);
    res.json(payload);
  } catch (err) {
    console.error("[agent-stats] failed:", err);
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
