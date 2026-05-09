// ─── Admin: Force re-verification of pool members (WO-25) ─────────
//
// After the WO-16 cross-source gate landed, the pre-existing pool
// (built before WO-16) contains members that were never validated
// under the new rules. A spot-check showed ~43% would FAIL today.
//
// This endpoint demotes verified-but-stale pool members back to
// 'unverified' so the verifier picks them up again. We also clear
// `outreach_eligible_at` so they leave the pool until re-verified —
// otherwise they'd still show as outreach-ready while pending.
//
// Idempotent: re-running has no effect on already-demoted rows
// (the WHERE clause requires verification_status='verified').
//
// All endpoints require X-Admin-Key.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

const router = Router();

// WO-16 deploy time — anything verified before this used the old
// (looser) gate and should be re-checked.
const DEFAULT_SINCE = "2026-05-09T12:51:26Z";

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

// POST /admin/force-re-verify-pool
//   Optional body: { since?: ISO8601, dry_run?: boolean }
//
// Demotes pool members whose last_verified_at < `since` (default:
// the WO-16 deploy time 2026-05-09T12:51:26Z) back to verification_status='unverified'
// and resets last_verified_at to NULL so they get picked up by the
// next verifier batch. Critically: also clears outreach_eligible_at
// so they leave the pool until re-verified.
//
// Returns { success, demoted: N, dry_run: bool, sample_ids: [...] }
router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const since = (req.body && req.body.since) || DEFAULT_SINCE;
  const dryRun = !!(req.body && req.body.dry_run);

  const db = getDb();

  // Find candidates
  const candidates = db
    .prepare(
      `SELECT a.id, a.name, k.last_verified_at, k.outreach_eligible_at
         FROM agents a
   INNER JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE k.verification_status = 'verified'
          AND k.last_verified_at IS NOT NULL
          AND k.last_verified_at < ?`
    )
    .all(since) as Array<{ id: string; name: string; last_verified_at: string; outreach_eligible_at: string | null }>;

  if (dryRun) {
    res.json({
      success: true,
      dry_run: true,
      would_demote: candidates.length,
      sample_ids: candidates.slice(0, 10).map((c) => c.id),
      since,
    });
    return;
  }

  // Apply demotion in a transaction
  const stmt = db.prepare(
    `UPDATE agent_knowledge
        SET verification_status   = 'unverified',
            last_verified_at      = NULL,
            outreach_eligible_at  = NULL
      WHERE agent_id = ?`
  );

  const txn = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id);
  });

  txn(candidates.map((c) => c.id));

  res.json({
    success: true,
    dry_run: false,
    demoted: candidates.length,
    sample_ids: candidates.slice(0, 10).map((c) => c.id),
    since,
  });
});

// GET /admin/force-re-verify-pool — preview (acts as dry_run automatically)
router.get("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const since = (req.query.since as string) || DEFAULT_SINCE;
  const db = getDb();

  const result = db
    .prepare(
      `SELECT COUNT(*) as count
         FROM agent_knowledge
        WHERE verification_status = 'verified'
          AND last_verified_at IS NOT NULL
          AND last_verified_at < ?`
    )
    .get(since) as { count: number };

  res.json({
    success: true,
    candidates: result.count,
    since,
    note: "POST same body to execute. Use { dry_run: true } to preview ids.",
  });
});

export default router;
