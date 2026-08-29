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
import { recordRun, acquireLock } from "../services/run-ledger";

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

// isVerifierWindowHour — the SAME 22:00-06:00 UTC gate this route enforces,
// exposed so other in-process callers (e.g. index.ts's internal hourly
// scheduler, dev-request 2026-08-13-verifier-rutine-stub-og-kadens) can
// self-gate on the identical window logic instead of redeclaring the hour
// array.
export function isVerifierWindowHour(hourUTC: number): boolean {
  return ALLOWED_UTC_HOURS.includes(hourUTC);
}

// VerifierTickResult — discriminated union added for dev-request
// 2026-08-17-verifier-tick-lock: a real batch run (`skipped: false`) keeps
// every field runVerifierTick has always returned, unchanged; a
// lock-contended call (`skipped: true`) returns only success/skipped/reason
// and does NOT run a batch. See the acquireLock() call at the top of
// runVerifierTick below for why this exists.
export type VerifierTickResult =
  | { success: true; skipped: true; reason: string }
  | {
      success: true;
      skipped: false;
      run_id: string;
      processed: number;
      passed: number;
      review_required: number;
      pending_verify: number;
      data_insufficient: number;
      http_unreachable: number;
      brreg_inactive: number;
      domain_incoherent: number;
      email_domain_mismatch: number;
      thin_content: number;
      pool_added: number;
      status_transitions: number;
      transitioned: number;
      by_new_status: Record<string, number>;
      persisted: true;
      envelope_recorded: boolean;
      reprocess_review_queue: boolean;
      bias_growth: boolean;
    };

// runVerifierTick — the actual verifier-batch-run + stat-computation +
// envelope-record logic, extracted out of the POST / handler below so it
// can be called directly from in-process schedulers (dev-request
// 2026-08-13-verifier-rutine-stub-og-kadens) without an HTTP self-call.
// This is the exact body that used to live inline in the route handler —
// a refactor, not a behavior change: the route handler (below) still
// produces byte-identical JSON responses by calling this and shaping the
// result the same way it always did.
//
// dev-request 2026-08-17-verifier-tick-lock: the FIRST thing this function
// does is acquire a DB-backed lock (orchestrator_locks, via the SAME atomic
// acquireLock() primitive the platform-orchestrator's build-lane mutex
// uses — see run-ledger.ts). Root cause: the two independent callers of
// this function (the HTTP route below, and index.ts's internal setInterval
// scheduler) had NOTHING coordinating them — the scheduler's own
// `verifierTickRunning` guard is an in-memory, per-process boolean that
// resets on every restart and is invisible to the separate HTTP route
// process/request — so live prod's run-ledger showed 2-6 near-simultaneous
// runs clustering every night instead of one-per-hour. A DB row survives
// restarts and is atomic across both callers (whichever caller's INSERT
// wins the `agent` unique-key race is the only one that proceeds), closing
// both gaps at once. Uses its own lock key
// ("lokal-agent-verifier-tick") — separate from the orchestrator's own
// build-lane lock key so the two systems can never contend with each
// other. staleMinutes=50 is deliberately just under the 60-minute cadence
// so the lock always expires on its own before the next legitimate hourly
// tick; there is intentionally no matching releaseLock() call — natural
// staleness expiry IS the release mechanism (an explicit release would add
// a "crashed mid-batch, now permanently wedged" failure mode this design
// avoids).
export async function runVerifierTick(opts: {
  batchSize?: number;
  reprocessReviewQueue?: boolean;
  biasGrowth?: boolean;
  skipTickLock?: boolean;
} = {}): Promise<VerifierTickResult> {
  const tickStartedAt = new Date().toISOString();
  const tickRunId = `run-${tickStartedAt.replace(/[:.]/g, "").slice(0, 15)}-lokal-agent-verifier-tick`;
  // dev-request 2026-08-28-enrichment-verifier-lock-blokkerer-force-promote:
  // skipTickLock is a separate, explicitly-named opt-in that bypasses ONLY
  // this acquireLock() call — every other caller (internal cron scheduler,
  // plain HTTP route, force=1 alone, reprocess_review_queue=1 drain) still
  // acquires the lock exactly as before. When set, go straight to running
  // the batch: per this function's own design note above, there is no
  // matching releaseLock() (natural staleness IS the release mechanism), so
  // acquiring on a bypassed path would just pointlessly consume/refresh a
  // lock nothing needs.
  if (!opts.skipTickLock) {
    const lock = acquireLock({
      agent: "lokal-agent-verifier-tick",
      run_id: tickRunId,
      started_at: tickStartedAt,
      staleMinutes: 50,
    });
    if (!lock.acquired) {
      return {
        success: true,
        skipped: true,
        reason: `already ran this hour (locked by ${lock.holder.run_id} at ${lock.holder.started_at})`,
      };
    }
  }

  const batchSize = Math.min(
    Math.max(parseInt(String(opts.batchSize ?? (process.env.VERIFY_BATCH_SIZE ?? "30")), 10) || 30, 1),
    100
  );
  const reprocessReviewQueue = !!opts.reprocessReviewQueue;
  // orch-pr-87: bias_growth flag (default true) — use pickBatchBiased
  // (70/30 growth-reservoir split) unless explicitly disabled. Has no
  // effect when reprocessReviewQueue is set (review-queue drain mode
  // still uses pickReviewQueueBatch).
  const biasGrowth = opts.biasGrowth === undefined ? true : !!opts.biasGrowth;

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
  // dev-request 2026-08-10-verifier-portkjede-og-provenansrydding (Skive B):
  // `passed` is the basic-gate result ONLY (computeKvalitetsGate: http_status,
  // email, website, about, products, brreg) — it says nothing about whether the
  // stricter cross-source/domain-coherence/email-ownership guards let the agent
  // through, and nothing about whether this run actually changed anything. A
  // high `passed` count over a backlog sweep can co-exist with near-zero real
  // promotions when most candidates were already `verified` and simply re-pass
  // the basic gate every round (see the dev-request's root-cause report). Expose
  // the transition count under the name the report's fix asked for (`transitioned`,
  // same value as the pre-existing `status_transitions` — kept for compatibility)
  // plus a breakdown of what those transitions actually became, so a caller reading
  // the response never again has to infer promotion counts from `passed`.
  const transitioned = statusTransitions;
  const byNewStatus: Record<string, number> = {};
  for (const r of results) {
    if (r.prior_verification_status === r.new_verification_status) continue;
    byNewStatus[r.new_verification_status] = (byNewStatus[r.new_verification_status] ?? 0) + 1;
  }

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

  return {
    success: true,
    skipped: false,
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
    transitioned,
    by_new_status: byNewStatus,
    persisted: true,
    envelope_recorded: envelopeRecorded,
    reprocess_review_queue: reprocessReviewQueue,
    bias_growth: biasGrowth,
  };
}

// POST /admin/run-verifier
//   Optional body: { batchSize?: number, force?: boolean, skip_tick_lock?: boolean }
//   Optional query: ?force=1&skip_tick_lock=1
//   skip_tick_lock: separate from `force` — bypasses ONLY the DB-backed
//   once-per-hour tick-lock (dev-request 2026-08-17-verifier-tick-lock),
//   not the 22:00-06:00 UTC window check. Default off; every existing
//   caller (including plain force=1) is unaffected unless it opts in.
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
  const batchSize = Math.min(Math.max(parseInt(String(batchSizeRaw ?? (process.env.VERIFY_BATCH_SIZE ?? "30")), 10) || 30, 1), 100);

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

  // dev-request 2026-08-28-enrichment-verifier-lock-blokkerer-force-promote:
  // separate, explicitly-named opt-in that bypasses ONLY the DB-backed
  // tick-lock inside runVerifierTick — NOT a replacement for `force` (which
  // only bypasses the 22:00-06:00 UTC window check above) and NOT implied
  // by `force=1` alone, so existing force=1 callers (e.g. the
  // reprocess_review_queue=1 operator drain) keep respecting the tick-lock
  // exactly as before. Default-off; only a caller that explicitly passes
  // this flag skips the lock.
  const skipTickLock =
    req.query.skip_tick_lock === "1" ||
    req.query.skip_tick_lock === "true" ||
    (req.body && (req.body.skip_tick_lock === true || req.body.skip_tick_lock === "1"));

  try {
    const tick = await runVerifierTick({ batchSize, reprocessReviewQueue, biasGrowth, skipTickLock });

    if (tick.skipped) {
      // dev-request 2026-08-17-verifier-tick-lock: same response shape as
      // the window-hour skip case above ({success, skipped, reason}) — this
      // is a SEPARATE, additional gate (the DB-backed once-per-hour lock),
      // not a replacement for the window-hour check.
      res.json({
        success: true,
        skipped: true,
        reason: tick.reason,
      });
      return;
    }

    res.json({
      success: true,
      run_id: tick.run_id,
      processed: tick.processed,
      passed: tick.passed,
      review_required: tick.review_required,
      pending_verify: tick.pending_verify,
      data_insufficient: tick.data_insufficient,
      http_unreachable: tick.http_unreachable,
      brreg_inactive: tick.brreg_inactive,
      domain_incoherent: tick.domain_incoherent,
      email_domain_mismatch: tick.email_domain_mismatch,
      thin_content: tick.thin_content,
      pool_added: tick.pool_added,
      status_transitions: tick.status_transitions,
      transitioned: tick.transitioned,
      by_new_status: tick.by_new_status,
      persisted: tick.persisted,
      envelope_recorded: tick.envelope_recorded,
      hour_utc: hourUTC,
      forced: !!force,
      tick_lock_skipped: !!skipTickLock,
      reprocess_review_queue: tick.reprocess_review_queue,
      bias_growth: tick.bias_growth,
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
