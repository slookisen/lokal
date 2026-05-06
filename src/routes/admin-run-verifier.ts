// ─── Admin: Trigger lokal-agent-verifier from inside main app ────
//
// Phase 5 fix (Option B from priority-headsup 2026-05-06):
// Verifier needs access to the main app's volume-mounted SQLite DB.
// Running in a separate Fly Machine gives it an empty DB instead.
// This endpoint runs the verifier batch INSIDE the main app process,
// so it reads the real DB and writes back to the same volume.
//
// Triggered hourly by a thin Fly Machine cron that just curls this URL.
// Time-window gate (22:00-06:00 UTC) is enforced here so the trigger
// can fire 24×/day without doing work outside the window.
//
// All endpoints require X-Admin-Key.

import { Router, Request, Response } from "express";
import { runVerifierBatch, buildRunEnvelope } from "../agents/lokal-agent-verifier";
import { recordRun } from "../services/run-ledger";

const router = Router();

const ALLOWED_UTC_HOURS = [22, 23, 0, 1, 2, 3, 4, 5, 6];

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

// POST /admin/run-verifier
//   Optional body: { batchSize?: number, force?: boolean }
//   Optional query: ?force=1
//   Returns: { success, run_id, results, skipped?: boolean, reason? }
router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const now = new Date();
  const hourUTC = now.getUTCHours();
  const force =
    req.query.force === "1" ||
    req.query.force === "true" ||
    (req.body && (req.body.force === true || req.body.force === "1"));

  if (!ALLOWED_UTC_HOURS.includes(hourUTC) && !force) {
    res.json({
      success: true,
      skipped: true,
      reason: `UTC hour ${hourUTC} outside 22-06 window`,
      hint: "POST with body {force:true} or query ?force=1 to override",
    });
    return;
  }

  const batchSizeRaw = (req.body && req.body.batchSize) || req.query.batchSize;
  const batchSize = Math.min(Math.max(parseInt(String(batchSizeRaw ?? "30"), 10) || 30, 1), 100);

  try {
    const batchResult = await runVerifierBatch({ batchSize });
    const results = batchResult.results;

    const passed = results.filter((r) => r.passed).length;
    const reviewRequired = results.filter((r) => r.new_verification_status === "review_required").length;
    const pendingVerify = results.filter((r) => r.new_verification_status === "pending_verify").length;
    const httpUnreachable = results.filter((r) => r.flags.includes("website_unreachable")).length;
    const brregInactive = results.filter((r) =>
      r.flags.some((f: string) => f === "brreg_inactive" || f === "brreg_konkurs")
    ).length;
    const pooledNew = results.filter((r) => r.outreach_eligible_at !== null).length;

    // Build envelope and record directly via service (no HTTP roundtrip)
    const envelope: any = buildRunEnvelope({
      run_id: batchResult.run_id,
      started_at: batchResult.started_at,
      finished_at: batchResult.finished_at,
      results,
    });
    if (!envelope.evidence) envelope.evidence = [];

    let envelopeRecorded = false;
    try {
      recordRun(envelope);
      envelopeRecorded = true;
    } catch (e: any) {
      console.error(`[admin/run-verifier] envelope record failed:`, e?.message || e);
    }

    res.json({
      success: true,
      run_id: batchResult.run_id,
      processed: results.length,
      passed,
      review_required: reviewRequired,
      pending_verify: pendingVerify,
      http_unreachable: httpUnreachable,
      brreg_inactive: brregInactive,
      pool_added: pooledNew,
      envelope_recorded: envelopeRecorded,
      hour_utc: hourUTC,
      forced: !!force,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: String(err?.message || err),
      hour_utc: hourUTC,
    });
  }
});

// GET /admin/run-verifier — sanity check the endpoint is wired up
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const hourUTC = new Date().getUTCHours();
  res.json({
    success: true,
    endpoint: "POST /admin/run-verifier",
    in_window: ALLOWED_UTC_HOURS.includes(hourUTC),
    hour_utc: hourUTC,
    allowed_hours: ALLOWED_UTC_HOURS,
  });
});

export default router;
