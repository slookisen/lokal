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
import { runVerifierBatch, buildRunEnvelope, pickReviewQueueBatch, pickBatchBiased } from "../agents/lokal-agent-verifier";
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

  // PR-27: Optional reprocess-review-queue mode. When set, scope the
  // pick to review_required + data_insufficient rows (oldest first) so
  // we drain the review queue instead of starving on `unverified`.
  const reprocessReviewQueue =
    req.query.reprocess_review_queue === "1" ||
    req.query.reprocess_review_queue === "true" ||
    (req.body && (req.body.reprocess_review_queue === true || req.body.reprocess_review_queue === "1"));

  // orch-pr-87: bias_growth flag (default 1) — use pickBatchBiased
  // (70/30 growth-reservoir split) unless explicitly disabled with
  // bias_growth=0 (falls back to legacy pickBatch oldest-first).
  // Has no effect when reprocess_review_queue=1 (review-queue drain
  // mode still uses pickReviewQueueBatch).
  const biasGrowthRaw =
    (req.body && req.body.bias_growth !== undefined ? req.body.bias_growth : req.query.bias_growth);
  const biasGrowth = biasGrowthRaw === undefined
    ? true
    : !(biasGrowthRaw === "0" || biasGrowthRaw === 0 || biasGrowthRaw === false || biasGrowthRaw === "false");

  try {
    const batchResult = await runVerifierBatch(
      reprocessReviewQueue
        ? { batchSize, pickFn: pickReviewQueueBatch }
        : biasGrowth
          ? { batchSize, pickFn: pickBatchBiased }
          : { batchSize }
    );
    const results = batchResult.results;

    const passed = results.filter((r) => r.passed).length;
    const reviewRequired = results.filter((r) => r.new_verification_status === "review_required").length;
    const pendingVerify = results.filter((r) => r.new_verification_status === "pending_verify").length;
    const dataInsufficient = results.filter((r) => r.new_verification_status === "data_insufficient").length;
    const httpUnreachable = results.filter((r) => r.flags.includes("website_unreachable")).length;
    const brregInactive = results.filter((r) =>
      r.flags.some((f: string) => f === "brreg_inactive" || f === "brreg_konkurs")
    ).length;
    // orch-PR-20260512-33: domain-coherence overrides (Eidsmo fix)
    const domainIncoherent = results.filter((r) => r.domain_incoherent).length;
    const pooledNew = results.filter((r) => r.outreach_eligible_at !== null).length;
    // orch-pr-20260614-4: flag-level observability so operators can measure
    // the free-mail exemption effect and track thin-content prevalence.
    const email_domain_mismatch = results.filter((r) => r.flags.includes("email_domain_mismatch")).length;
    const thin_content = results.filter((r) => r.flags.includes("thin_content")).length;
    // dev-request 2026-07-19-verifier-drain-persistens-og-throughput: this
    // endpoint's outcomes are ALWAYS written to agent_knowledge (every
    // candidate goes through applyVerifierOutcome unconditionally — there
    // is no evaluate-only/dry-run mode today). `persisted` makes that
    // explicit so a caller never again has to infer it from an unrelated
    // field. `status_transitions` distinguishes a real status change from
    // a re-confirmation of the same status (e.g. a review_required agent
    // whose underlying evidence hasn't changed since the last pass will
    // correctly persist review_required again — that is NOT a sign the
    // write failed; `passed` alone (the basic quality-gate result, which
    // can be true even when a stricter downstream guard still routes the
    // agent to review_required) cannot tell these two cases apart.
    const statusTransitions = results.filter(
      (r) => r.prior_verification_status !== r.new_verification_status
    ).length;

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
      data_insufficient: dataInsufficient,
      http_unreachable: httpUnreachable,
      brreg_inactive: brregInactive,
      domain_incoherent: domainIncoherent,
      email_domain_mismatch,
      thin_content,
      pool_added: pooledNew,
      status_transitions: statusTransitions,
      persisted: true,
      envelope_recorded: envelopeRecorded,
      hour_utc: hourUTC,
      forced: !!force,
      reprocess_review_queue: !!reprocessReviewQueue,
      bias_growth: !!biasGrowth,
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

// ─── Bulk pending_verify sweep endpoints (orch-pr-20260614-2) ─────────────
//
// POST /admin/run-verifier/sweep
//   Triggers a background sweep over all pending_verify agents. Returns
//   immediately (the loop runs for 15-40 min in the background). Not
//   night-gated — explicit admin one-off, intended to drain the backlog.
//   Rejects 409 if a sweep is already running.
//
// GET /admin/run-verifier/sweep
//   Returns the current (or last) sweep job state plus how many
//   pending_verify agents remain.

import { startSweep, getSweepJob } from "../services/verifier-sweep";
import { countPendingVerify } from "../agents/lokal-agent-verifier";
import { getDb } from "../database/init";

router.post("/sweep", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const db = getDb();
  const chunkSizeRaw = (req.body && req.body.chunkSize) || req.query.chunkSize;
  const chunkSize = chunkSizeRaw ? Math.min(Math.max(parseInt(String(chunkSizeRaw), 10) || 50, 1), 200) : 50;

  const maxAgentsRaw = (req.body && req.body.maxAgents) || req.query.maxAgents;
  const maxAgents = maxAgentsRaw ? parseInt(String(maxAgentsRaw), 10) : undefined;

  const result = startSweep({ chunkSize, maxAgents, db });

  if (!result.started) {
    // A sweep is already in flight — surface current job for observability.
    res.status(409).json({
      success: false,
      started: false,
      reason: result.reason,
      job: getSweepJob(),
      pending_verify_remaining: countPendingVerify(db),
    });
    return;
  }

  res.json({
    success: true,
    started: true,
    job_id: result.jobId,
    pending_verify_remaining: countPendingVerify(db),
    note: "Sweep running in background. Poll GET /admin/run-verifier/sweep for progress.",
  });
});

router.get("/sweep", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  res.json({
    success: true,
    job: getSweepJob(),
    pending_verify_remaining: countPendingVerify(db),
  });
});
