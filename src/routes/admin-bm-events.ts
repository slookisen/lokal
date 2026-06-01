// ─── Admin: Bondens marked events scraper endpoint (PR-56) ──────
//
// POST /admin/bm-events/scrape
//   Synchronously runs the scraper pipeline and returns a ScrapeResult JSON.
//   Used by:
//     - Cowork scheduled-task (daily 05:00 UTC)
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

  const body = (req.body || {}) as { maxEvents?: number; useRenderWorker?: boolean };
  const maxEvents = typeof body.maxEvents === "number" && body.maxEvents > 0
    ? Math.min(body.maxEvents, 1000)
    : undefined;
  const useRenderWorker = body.useRenderWorker === true;

  try {
    const result = await runBmEventsScraper({ maxEvents, useRenderWorker });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: "Scrape failed",
      detail: err?.message || String(err),
    });
  }
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
