// ─── Admin: Verifier review queue (Phase 5.3 / WO-16, PR-19 update) ──────────
//
// Surfaces agents with verification_status='review_required' (default) or
// verification_status='data_insufficient' so Daniel can manually triage.
//
// PR-19 (2026-05-10): added ?status= query parameter so the dashboard can
// fetch the new data_insufficient bucket separately. Default status=
// review_required keeps backwards-compatibility with existing callers.
//
// PR-68 (2026-05-17): added umbrella_type to the SELECT clause + new
// ?exclude_umbrellas=1 (default) flag. Umbrella agents like "Bondens
// marked Norge" were polluting the producer review queue and burning
// Google Places quota during enrichment. The enrichment skill had a
// client-side post-filter `not row.umbrella_type`, but since
// umbrella_type was never selected, that filter was a silent no-op.
// We now exclude them server-side by default; pass
// ?exclude_umbrellas=0 to opt back in to the legacy behaviour.
//
// Requires X-Admin-Key header.
//
// GET /admin/verifier-review-queue
//   Query: ?status=review_required (default) | data_insufficient
//          ?exclude_umbrellas=1 (default) | 0
//   Returns: { success, count, status, exclude_umbrellas, agents: [{
//              agent_id, name, umbrella_type, verification_status,
//              review_reason, last_verified_at }] }

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

const router = Router();

// Whitelist of statuses this endpoint is allowed to surface. Other statuses
// (e.g. 'verified', 'pending_verify', 'unverified', 'opt_out') are NOT
// review-queue material and should not be queryable through this route.
const ALLOWED_STATUSES = new Set(["review_required", "data_insufficient"]);

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

// Parse a query flag that accepts 1/0/true/false. Defaults to `def` when
// the parameter is absent or the value is unrecognised.
function parseBoolFlag(raw: unknown, def: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return def;
  const v = String(raw).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return def;
}

// GET /admin/verifier-review-queue
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const requestedStatus = (req.query.status as string) || "review_required";
  if (!ALLOWED_STATUSES.has(requestedStatus)) {
    res.status(400).json({
      success: false,
      error: `Invalid status filter: ${requestedStatus}. Allowed: ${[...ALLOWED_STATUSES].join(", ")}`,
    });
    return;
  }

  // PR-68: default-on filter. Umbrella agents (umbrella_type IS NOT NULL)
  // are network-aggregators like "Bondens marked Norge"; they should not
  // show up in a *producer* review queue. Callers can opt-out via
  // ?exclude_umbrellas=0 for parity with the legacy response.
  const excludeUmbrellas = parseBoolFlag(req.query.exclude_umbrellas, true);

  try {
    const db = getDb();
    const sql = `SELECT a.id AS agent_id, a.name, a.umbrella_type,
                k.verification_status,
                k.verification_review_reason, k.last_verified_at
           FROM agents a
     INNER JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE k.verification_status = ?
            ${excludeUmbrellas ? "AND a.umbrella_type IS NULL" : ""}
       ORDER BY k.last_verified_at DESC
          LIMIT 500`;
    const rows = db.prepare(sql).all(requestedStatus) as {
        agent_id: string;
        name: string;
        umbrella_type: string | null;
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
        umbrella_type: r.umbrella_type,
        verification_status: r.verification_status,
        last_verified_at: r.last_verified_at,
        review_reason,
      };
    });

    res.json({
      success: true,
      status: requestedStatus,
      exclude_umbrellas: excludeUmbrellas,
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
