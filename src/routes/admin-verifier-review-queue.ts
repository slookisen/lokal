// ─── Admin: Verifier review queue (Phase 5.3 / WO-16) ────────────────────────
//
// Surfaces agents with verification_status='review_required' and their
// cross-source conflict details so Daniel can manually triage and apply
// curated_fields locks to override.
//
// Requires X-Admin-Key header.
//
// GET /admin/verifier-review-queue
//   Returns: { success, count, agents: [{ agent_id, name, verification_status,
//              review_reason: { address, phone, business_status } }] }

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

// GET /admin/verifier-review-queue
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT a.id AS agent_id, a.name, k.verification_status,
                k.verification_review_reason, k.last_verified_at
           FROM agents a
     INNER JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE k.verification_status = 'review_required'
       ORDER BY k.last_verified_at DESC
          LIMIT 500`
      )
      .all() as {
        agent_id: string;
        name: string;
        verification_status: string;
        verification_review_reason: string;
        last_verified_at: string | null;
      }[];

    const agents = rows.map((r) => {
      let review_reason: Record<string, unknown> = {};
      try {
        review_reason = JSON.parse(r.verification_review_reason || "{}");
      } catch {
        review_reason = {};
      }
      return {
        agent_id: r.agent_id,
        name: r.name,
        verification_status: r.verification_status,
        last_verified_at: r.last_verified_at,
        review_reason,
      };
    });

    res.json({
      success: true,
      count: agents.length,
      agents,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: String(err?.message || err),
    });
  }
});

export default router;
