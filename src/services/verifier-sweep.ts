// ─── verifier-sweep.ts — Bulk pending_verify drain orchestrator ─────────────
//
// Problem: The hourly /admin/run-verifier picks at most 100 agents per run
// via pickBatchBiased. With ~843 agents in `pending_verify`, clearing the
// backlog would take ~28 hourly cycles (≈28 hours, night-gated to boot).
// This module enables a single admin-triggered sweep that drains the whole
// `pending_verify` pool in one background job without blocking the HTTP
// response (Fly/client would time out at ~30s for a 15-40 min operation).
//
// Design decisions:
//   - In-memory job state (singleton): no schema migration needed. If the
//     process restarts mid-sweep, the job is lost (see risk notes below).
//   - Fire-and-forget background loop: startSweep() launches an async IIFE
//     that is NOT awaited. The HTTP response returns within ~1ms.
//   - All dependencies (runBatch, db, sleep) are injectable so tests can
//     verify behavior without network I/O or real delays.
//   - 3-consecutive-error circuit-breaker: one transient I/O error doesn't
//     kill the whole sweep; 3 back-to-back errors indicate a systemic
//     problem and the loop aborts with status='error'.
//   - Sleep between chunks (default 400ms) to be gentle on Brreg rate limits.
//
// RISK — process restart mid-sweep:
//   If Fly restarts the process while a sweep is running, the background loop
//   is killed immediately. The job state is lost (reverts to 'idle' on the
//   new process). Agents whose chunks were processed before the restart have
//   already had their verification_status written to SQLite, so no data is
//   lost — the sweep just stops early. An operator can re-trigger via
//   POST /admin/run-verifier/sweep; it will pick up where it left off because
//   pickPendingVerifyBatch always selects the oldest un-processed pending_verify
//   agents first. The sweep is therefore restartable without double-processing.

import { runVerifierBatch, pickPendingVerifyBatch, countPendingVerify } from "../agents/lokal-agent-verifier";
import type { VerifierResult } from "../agents/lokal-agent-verifier";
import { getDb } from "../database/init";
import { recordRun } from "./run-ledger";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SweepStatus = "idle" | "running" | "done" | "error";

export interface SweepJobState {
  jobId: string | null;
  status: SweepStatus;
  /** "pending_verify" — the only scope for now; extensible later */
  scope: "pending_verify";
  startedAt: string | null;
  finishedAt: string | null;
  chunkSize: number;
  /** Total agents processed so far (sum across all chunks) */
  processed: number;
  verified: number;
  review_required: number;
  data_insufficient: number;
  /** Agents that remain pending_verify after processing (re-verified but still pending) */
  still_pending: number;
  /** Number of chunk-level errors (network failures, runBatch throws) */
  errors: number;
  lastError: string | null;
  lastChunkAt: string | null;
  // orch-pr-20260614-4: flag-level counters for observability.
  // Lets operators measure the free-mail exemption effect and thin-content
  // prevalence across the bulk sweep without querying the DB directly.
  email_domain_mismatch: number;
  thin_content: number;
  // orchestrator-pr-16: factual fields sourced solely from AI inference
  // (category_inference/seasonal_knowledge/name_analysis/web_search) — these
  // agents were quarantined from the pool, not promoted.
  inference_only_field: number;
  // orchestrator-pr-16: website-ownership unverified (homepage name-mismatch)
  // surfaced by Guard #1 at crawl time; counted here when the flag is present.
  website_ownership_unverified: number;
}

// ─── Singleton state ─────────────────────────────────────────────────────────

// Module-level singleton. Accessible through getSweepJob() / mutated in-loop.
// In-memory only — process restart resets to idle (see module docstring).
let _sweepJob: SweepJobState = {
  jobId: null,
  status: "idle",
  scope: "pending_verify",
  startedAt: null,
  finishedAt: null,
  chunkSize: 50,
  processed: 0,
  verified: 0,
  review_required: 0,
  data_insufficient: 0,
  still_pending: 0,
  errors: 0,
  lastError: null,
  lastChunkAt: null,
  email_domain_mismatch: 0,
  thin_content: 0,
  inference_only_field: 0,
  website_ownership_unverified: 0,
};

export function getSweepJob(): Readonly<SweepJobState> {
  return { ..._sweepJob };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJobId(): string {
  return `sweep-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
}

// Default sleep — injectable for tests so they don't add real delays.
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── startSweep ──────────────────────────────────────────────────────────────

export interface StartSweepOpts {
  /** Agents per runVerifierBatch call. Default: 50. */
  chunkSize?: number;
  /**
   * Hard cap on total agents processed this run. Useful for partial drains
   * or testing. Default: unlimited (safety cap of 5000 still applies).
   */
  maxAgents?: number;
  /**
   * Milliseconds to sleep between chunks. Injectable for tests. Default: 400.
   */
  sleepMs?: number;
  /**
   * Injectable runBatch — defaults to runVerifierBatch.
   * Signature matches runVerifierBatch's opts subset we need.
   */
  runBatch?: (opts: {
    batchSize: number;
    pickFn: (db: any, limit?: number) => any[];
    db?: any;
  }) => Promise<{ run_id: string; started_at: string; finished_at: string; results: VerifierResult[] }>;
  /**
   * Injectable sleep — defaults to defaultSleep. Pass `() => Promise.resolve()`
   * in tests.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable DB — defaults to getDb(). */
  db?: any;
}

export interface StartSweepResult {
  started: boolean;
  jobId?: string;
  reason?: string;
}

/**
 * Launch a background bulk-verification sweep over all `pending_verify` agents.
 *
 * Returns immediately ({started: true, jobId}) while the loop runs in the
 * background. The HTTP response returns in <1ms; the loop runs for 15-40 min.
 *
 * If a sweep is already running returns {started: false, reason: 'already_running'}.
 */
export function startSweep(opts: StartSweepOpts = {}): StartSweepResult {
  // Concurrency guard — only one sweep at a time.
  if (_sweepJob.status === "running") {
    return { started: false, reason: "already_running" };
  }

  const chunkSize = opts.chunkSize ?? 50;
  const maxAgents = opts.maxAgents ?? Infinity;
  const sleepMs = opts.sleepMs ?? 400;
  const runBatchFn = opts.runBatch ?? runVerifierBatch;
  const sleepFn = opts.sleep ?? defaultSleep;
  const db = opts.db ?? getDb();

  const jobId = makeJobId();
  const startedAt = new Date().toISOString();

  // Initialise job state (reset counters from any prior run).
  _sweepJob = {
    jobId,
    status: "running",
    scope: "pending_verify",
    startedAt,
    finishedAt: null,
    chunkSize,
    processed: 0,
    verified: 0,
    review_required: 0,
    data_insufficient: 0,
    still_pending: 0,
    errors: 0,
    lastError: null,
    lastChunkAt: null,
    email_domain_mismatch: 0,
    thin_content: 0,
    inference_only_field: 0,
    website_ownership_unverified: 0,
  };

  // ── Background loop (fire-and-forget) ──────────────────────────────────────
  // NOT awaited — the loop runs after startSweep() returns. This is the key
  // mechanism that keeps the HTTP response fast while the sweep takes minutes.
  (async () => {
    const HARD_SAFETY_CAP = 5000; // never process more than this in one sweep
    const MAX_CONSECUTIVE_ERRORS = 3;
    let consecutiveErrors = 0;

    try {
      while (true) {
        // Check stop conditions before each chunk.
        if (_sweepJob.processed >= HARD_SAFETY_CAP) {
          console.log(`[verifier-sweep] ${jobId}: safety cap (${HARD_SAFETY_CAP}) reached, stopping`);
          break;
        }
        if (_sweepJob.processed >= maxAgents) {
          console.log(`[verifier-sweep] ${jobId}: maxAgents (${maxAgents}) reached, stopping`);
          break;
        }

        let chunkResult: Awaited<ReturnType<typeof runVerifierBatch>>;
        try {
          chunkResult = await runBatchFn({
            batchSize: chunkSize,
            pickFn: pickPendingVerifyBatch,
            db,
          });
        } catch (err: unknown) {
          consecutiveErrors++;
          _sweepJob.errors++;
          _sweepJob.lastError = err instanceof Error ? err.message : String(err);
          console.error(`[verifier-sweep] ${jobId}: chunk error (consecutive=${consecutiveErrors}):`, _sweepJob.lastError);

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.error(`[verifier-sweep] ${jobId}: ${MAX_CONSECUTIVE_ERRORS} consecutive errors — aborting sweep`);
            try { _sweepJob.still_pending = countPendingVerify(db); } catch { /* best-effort */ }
            _sweepJob.status = "error";
            _sweepJob.finishedAt = new Date().toISOString();
            return; // exits the async IIFE
          }
          // Short backoff before retry after a single error.
          await sleepFn(sleepMs);
          continue;
        }

        // Successful chunk — reset consecutive-error counter.
        consecutiveErrors = 0;

        const { results } = chunkResult;

        // Empty chunk means no more pending_verify agents.
        if (results.length === 0) {
          console.log(`[verifier-sweep] ${jobId}: empty chunk — backlog exhausted after ${_sweepJob.processed} agents`);
          break;
        }

        // Aggregate counts into job state.
        _sweepJob.processed += results.length;
        _sweepJob.verified += results.filter((r) => r.new_verification_status === "verified").length;
        _sweepJob.review_required += results.filter((r) => r.new_verification_status === "review_required").length;
        _sweepJob.data_insufficient += results.filter((r) => r.new_verification_status === "data_insufficient").length;
        // orch-pr-20260614-4: flag-level counters (single source of truth in VerifierResult.flags).
        _sweepJob.email_domain_mismatch += results.filter((r) => r.flags.includes("email_domain_mismatch")).length;
        _sweepJob.thin_content += results.filter((r) => r.flags.includes("thin_content")).length;
        _sweepJob.inference_only_field += results.filter((r) => r.flags.some((f) => f.startsWith("inference_only_field"))).length;
        _sweepJob.website_ownership_unverified += results.filter((r) => r.flags.includes("website_ownership_unverified")).length;
        _sweepJob.lastChunkAt = new Date().toISOString();

        console.log(
          `[verifier-sweep] ${jobId}: chunk done — processed=${_sweepJob.processed} ` +
          `verified=${_sweepJob.verified} review=${_sweepJob.review_required} ` +
          `data_insuff=${_sweepJob.data_insufficient} errors=${_sweepJob.errors}`
        );

        // Gentle pause between chunks to avoid hammering Brreg rate limits.
        await sleepFn(sleepMs);
      }

      // Finished normally — record final pending count.
      _sweepJob.still_pending = countPendingVerify(db);
      _sweepJob.status = "done";
      _sweepJob.finishedAt = new Date().toISOString();

      console.log(
        `[verifier-sweep] ${jobId}: COMPLETE — processed=${_sweepJob.processed} ` +
        `verified=${_sweepJob.verified} still_pending=${_sweepJob.still_pending} ` +
        `took=${Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)}s`
      );

      // Record a summary run-envelope so the orchestrator's daily rollup
      // can see the bulk sweep in the runs ledger.
      try {
        const fakeEnvelope = {
          run_id: jobId,
          vertical: "rfb",
          agent: "lokal-agent-verifier",
          trigger_source: "manual" as const,
          started_at: startedAt,
          finished_at: _sweepJob.finishedAt,
          status: "completed" as const,
          claims: [
            { type: "db_state_change" as const, value: _sweepJob.verified, meta: { kind: "agents_verified" } },
            { type: "db_state_change" as const, value: _sweepJob.review_required, meta: { kind: "agents_review_required" } },
            { type: "db_state_change" as const, value: _sweepJob.data_insufficient, meta: { kind: "agents_data_insufficient" } },
            { type: "db_state_change" as const, value: _sweepJob.processed, meta: { kind: "bulk_sweep_processed" } },
          ],
          evidence: [],
          notes: `Bulk pending_verify sweep: processed ${_sweepJob.processed} agents, ${_sweepJob.verified} verified, ${_sweepJob.still_pending} still_pending`,
        };
        recordRun(fakeEnvelope, db);
      } catch (e: unknown) {
        // Non-fatal: ledger write failure doesn't invalidate the sweep results.
        console.error(`[verifier-sweep] ${jobId}: run-ledger record failed:`, e instanceof Error ? e.message : String(e));
      }
    } catch (outerErr: unknown) {
      // Unexpected error outside the chunk try/catch.
      try { _sweepJob.still_pending = countPendingVerify(db); } catch { /* best-effort */ }
      _sweepJob.status = "error";
      _sweepJob.finishedAt = new Date().toISOString();
      _sweepJob.lastError = outerErr instanceof Error ? outerErr.message : String(outerErr);
      console.error(`[verifier-sweep] ${jobId}: unexpected outer error:`, _sweepJob.lastError);
    }
  })(); // <-- fire-and-forget: NOT awaited

  return { started: true, jobId };
}
