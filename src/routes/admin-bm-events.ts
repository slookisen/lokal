// ─── Admin: Bondens marked events scraper endpoint (PR-56) ──────
//
// POST /admin/bm-events/scrape
//   DEFAULT (backward-compatible): synchronously runs the scraper pipeline and
//   returns a ScrapeResult JSON (unchanged — callers that want the result
//   inline still get it).
//   ?async=1  /  { async: true }  (orch-pr-20): fires the scrape as a
//   fire-and-forget background job and returns { run_id, status:"started" } in
//   <1s (409 if a scrape is already running). The bm-events worker uses this to
//   dodge the >120s synchronous-request timeout, then polls GET to completion.
// GET /admin/bm-events/scrape  (orch-pr-20)
//   Background-job status + counts (fetched/parsed/matched/upserted/unmatched/
//   match_rate, started_at, finished_at, last_error).
//   Used by:
//     - Cowork scheduled-task (daily 05:00 UTC) — now fires ?async=1 then polls
//     - Daniel for ad-hoc runs
//
// PR-94 (2026-06-01) — added Phase B.2 venue-review endpoints:
//   GET  /admin/bm-events/venues/pending  — list pending bm_venue agents
//   POST /admin/bm-events/venues/:id/confirm
//   POST /admin/bm-events/venues/:id/reject
//
// X-Admin-Key auth (same key as /admin/runs).

import { Router, Request, Response } from "express";
import { runBmEventsScraper } from "../services/bm-events-scraper";
import {
  startBmEventsScrapeJob,
  getBmEventsScrapeJob,
} from "../services/bm-events-scrape-job";
import { getDb } from "../database/init";

const router = Router();

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

router.post("/scrape", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body || {}) as { maxEvents?: number; useRenderWorker?: boolean; correctTimes?: boolean; async?: boolean };
  const maxEvents = typeof body.maxEvents === "number" && body.maxEvents > 0
    ? Math.min(body.maxEvents, 1000)
    : undefined;
  const useRenderWorker = body.useRenderWorker === true;
  const correctTimes = body.correctTimes !== false; // PR-125: default on

  // orch-pr-20: opt-in async mode (?async=1 or { async: true }). When set, the
  // scrape runs as a fire-and-forget background job so the request returns in
  // <1s — the bm-events worker fires this then polls GET /admin/bm-events/scrape
  // to completion, dodging the >120s synchronous-request timeout. The scrape
  // logic is identical (same runBmEventsScraper call, same opts) — only the
  // delivery is async.
  const asyncRaw = body.async ?? req.query["async"];
  const wantAsync = asyncRaw === true || asyncRaw === "1" || asyncRaw === "true";

  if (wantAsync) {
    const started = startBmEventsScrapeJob({ maxEvents, useRenderWorker, correctTimes });
    if (!started.started) {
      // already_running → 409 with the current job for observability.
      res.status(409).json({
        success: false,
        error: "bm-events scrape already running",
        reason: started.reason,
        job: getBmEventsScrapeJob(),
      });
      return;
    }
    res.json({
      success: true,
      run_id: started.run_id,
      status: "started",
      note: "Scrape running in background. Poll GET /admin/bm-events/scrape for progress.",
    });
    return;
  }

  // Synchronous mode (default — unchanged backward-compatible behaviour).
  try {
    const result = await runBmEventsScraper({ maxEvents, useRenderWorker, correctTimes });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: "Scrape failed",
      detail: err?.message || String(err),
    });
  }
});

// GET /admin/bm-events/scrape (orch-pr-20)
//   Returns the background scrape job's status + counts so the worker can poll
//   to completion. status is one of idle|running|done|error.
router.get("/scrape", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json({ success: true, job: getBmEventsScrapeJob() });
});

// ─── PR-94 Phase B.2: bm_venue review queue ─────────────────────
//
// GET /admin/bm-events/venues/pending?status=pending_review&limit=50
//   Returns auto-created bm_venue agents awaiting Daniel\'s review,
//   with the linked bm_market_events count + parsed metadata. Default
//   status filter is \'pending_review\'; use ?status=all to see everything.

router.get("/venues/pending", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const status = (req.query.status as string) || "pending_review";
    const limit = Math.min(parseInt((req.query.limit as string) || "50", 10) || 50, 200);

    const db = getDb();
    let sql: string;
    let params: any[];
    if (status === "all") {
      sql = `
        SELECT a.id, a.name, a.city, a.is_active,
               a.agent_review_status, a.bm_venue_meta, a.created_at,
               (SELECT COUNT(*) FROM bm_market_events e WHERE e.venue_agent_id = a.id) AS event_count
        FROM agents a
        WHERE a.umbrella_type = \'bm_venue\'
        ORDER BY a.created_at DESC
        LIMIT ?
      `;
      params = [limit];
    } else {
      if (!["pending_review", "confirmed", "rejected"].includes(status)) {
        res.status(400).json({ success: false, error: "Invalid status filter" });
        return;
      }
      sql = `
        SELECT a.id, a.name, a.city, a.is_active,
               a.agent_review_status, a.bm_venue_meta, a.created_at,
               (SELECT COUNT(*) FROM bm_market_events e WHERE e.venue_agent_id = a.id) AS event_count
        FROM agents a
        WHERE a.umbrella_type = \'bm_venue\' AND a.agent_review_status = ?
        ORDER BY a.created_at DESC
        LIMIT ?
      `;
      params = [status, limit];
    }
    const rows = db.prepare(sql).all(...params) as Array<{
      id: string;
      name: string;
      city: string | null;
      is_active: number;
      agent_review_status: string | null;
      bm_venue_meta: string | null;
      created_at: string;
      event_count: number;
    }>;

    const venues = rows.map(r => {
      let meta: any = null;
      try { meta = r.bm_venue_meta ? JSON.parse(r.bm_venue_meta) : null; } catch { meta = null; }
      return {
        id: r.id,
        name: r.name,
        city: r.city,
        is_active: r.is_active === 1,
        review_status: r.agent_review_status,
        event_count: r.event_count,
        created_at: r.created_at,
        meta,
      };
    });

    res.json({ success: true, count: venues.length, venues });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// POST /admin/bm-events/venues/:id/confirm
//   Flip agent_review_status to \'confirmed\' and set is_active=1 so the
//   venue surfaces in public bm-events + profile-page listings.
router.post("/venues/:id/confirm", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  try {
    const db = getDb();
    const agent = db.prepare(
      "SELECT id, agent_review_status FROM agents WHERE id = ? AND umbrella_type = \'bm_venue\'"
    ).get(id) as { id: string; agent_review_status: string | null } | undefined;
    if (!agent) {
      res.status(404).json({ success: false, error: "bm_venue agent ikke funnet" });
      return;
    }
    db.prepare(
      "UPDATE agents SET agent_review_status = \'confirmed\', is_active = 1 WHERE id = ?"
    ).run(id);
    res.json({ success: true, id, review_status: "confirmed", is_active: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// POST /admin/bm-events/venues/:id/reject
//   Flip agent_review_status to \'rejected\' and is_active=0. Linked
//   bm_market_events rows stay (foreign key); but the venue won\'t
//   surface publicly. Future scraper runs WILL re-create the venue
//   if the slug doesn\'t match — that\'s an acceptable trade-off
//   until we add a denylist (out of scope for PR-94).
router.post("/venues/:id/reject", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  try {
    const db = getDb();
    const agent = db.prepare(
      "SELECT id, agent_review_status FROM agents WHERE id = ? AND umbrella_type = \'bm_venue\'"
    ).get(id) as { id: string; agent_review_status: string | null } | undefined;
    if (!agent) {
      res.status(404).json({ success: false, error: "bm_venue agent ikke funnet" });
      return;
    }
    db.prepare(
      "UPDATE agents SET agent_review_status = \'rejected\', is_active = 0 WHERE id = ?"
    ).run(id);
    res.json({ success: true, id, review_status: "rejected", is_active: false });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

export default router;
