// ─── Admin: POST /admin/conversations/traffic-class-backfill ────────────────
//
// a2a spam guard (2026-10-04). The write-time guard on POST /a2a stops NEW
// spam/probe calls from creating conversations; this classifies the ~7 900
// that already exist, so they drop out of /samtaler, the profile «Aktivitet»
// panel, /api/agents/:id/stats and every other public counter.
//
// Body (JSON):
//   {}                          → dry-run backfill: what WOULD move, nothing written
//   { "apply": true }           → write: 'external' → 'spam' | 'probe'
//   { "reset": true }           → dry-run reset: what the reset WOULD revert
//   { "reset": true, "apply": true } → revert every row the backfill moved
//
// Never deletes a row. Idempotent (a re-run finds nothing left to move).
// On apply/reset it recomputes agent_metrics.times_contacted for the
// affected sellers from their countable conversations and re-runs their
// trust score. The logic lives in conversationService.backfillTrafficClass /
// resetTrafficClassBackfill (same file as backfillInternalFlags, whose
// pattern it follows); this route is auth + flag parsing only.
import { Router, Request, Response } from "express";
import { conversationService } from "../services/conversation-service";

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

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "1" || v === 1;
}

router.post("/traffic-class-backfill", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const apply = truthy(body.apply) || truthy(req.query?.apply);
  const reset = truthy(body.reset) || truthy(req.query?.reset);
  try {
    const result = reset
      ? conversationService.resetTrafficClassBackfill({ apply })
      : conversationService.backfillTrafficClass({ apply });
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error("[traffic-class-backfill] failed:", err);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
