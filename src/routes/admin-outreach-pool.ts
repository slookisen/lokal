// ─── Admin: outreach_ready_pool endpoints (Phase 5.1, WO #7) ─────
//
// Read-only HTTP surface for the verify-first marketing pool.
// Marketing-comms agent will switch over to this in WO #9; until then
// these endpoints exist for the orchestrator + dashboard to monitor
// pool growth as lokal-agent-verifier (WO #8) lifts agents out of
// `unverified`/`thin` into `verified`/(`partial`|`rich`).
//
// All endpoints require X-Admin-Key.

import { Router, Request, Response } from "express";
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

// GET /admin/outreach-ready-pool/stats — pool size + breakdowns
// Defined BEFORE the index route so /stats is not eaten by /:limit-style logic.
router.get("/stats", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) AS c FROM outreach_ready_pool`).get() as { c: number };
    const byStatus = db
      .prepare(`SELECT verification_status AS k, COUNT(*) AS c FROM agent_knowledge GROUP BY verification_status`)
      .all() as Array<{ k: string; c: number }>;
    const byEnrichment = db
      .prepare(`SELECT enrichment_status AS k, COUNT(*) AS c FROM agent_knowledge GROUP BY enrichment_status`)
      .all() as Array<{ k: string; c: number }>;
    res.json({
      success: true,
      pool_size: total?.c ?? 0,
      by_verification_status: byStatus,
      by_enrichment_status: byEnrichment,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// GET /admin/outreach-ready-pool — pool rows (capped at 500)
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const limitRaw = parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);
    const rows = db
      .prepare(
        `SELECT * FROM outreach_ready_pool
         ORDER BY COALESCE(outreach_eligible_at, '9999-12-31') ASC
         LIMIT ?`
      )
      .all(limit);
    res.json({ success: true, count: rows.length, agents: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
