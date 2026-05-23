// ─── Admin: GET /admin/verifier/sweep-status (orch-pr-87) ─────────
//
// Returns aggregate sweep-progress counters derived from
// agent_knowledge.sweep_processed_at (written on every verifier run
// by applyVerifierOutcome). Used by the orchestrator's daily report
// and the visibility dashboard.
//
// Admin-key gated — same pattern as admin-run-verifier.ts.

import { Router, Request, Response } from "express";
import { getSweepStatus } from "../agents/lokal-agent-verifier";
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

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const status = getSweepStatus(getDb());
    res.json({
      success: true,
      ...status,
      generated_at: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: String(err?.message || err),
    });
  }
});

export default router;
