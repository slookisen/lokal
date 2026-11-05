// dental-verifier-scheduler.ts — pure helpers for the in-process hourly
// dental-verifier scheduler wired up in src/index.ts (dev-request
// 2026-09-02-dental-verifier-website-ownership, scheduler slice).
//
// Kept in its own tiny module (no DB/network imports) so the gate and the
// batch-size resolution can be unit-tested without booting index.ts.
//
// The scheduler is gated OFF by default. It only runs when BOTH
// DENTAL_VERIFIER_SCHEDULER_ENABLED === "1" AND ENABLE_DENTAL === "1" (the
// dental.db handle is only open when the dental vertical is enabled). The
// flag is turned on only by Daniel — nothing in this repo sets it.

/** Batch size used when DENTAL_VERIFIER_BATCH_SIZE is missing/invalid/<=0. */
export const DENTAL_VERIFIER_SCHEDULER_DEFAULT_BATCH_SIZE = 30;
/** Hard upper cap on DENTAL_VERIFIER_BATCH_SIZE for the scheduler. */
export const DENTAL_VERIFIER_SCHEDULER_MAX_BATCH_SIZE = 200;
/** Scheduler interval: hourly. */
export const DENTAL_VERIFIER_SCHEDULER_INTERVAL_MS = 60 * 60_000;

type Env = Record<string, string | undefined>;

/** True only when both env flags are exactly "1". */
export function shouldRunDentalVerifierScheduler(env: Env = process.env): boolean {
  return env.DENTAL_VERIFIER_SCHEDULER_ENABLED === "1" && env.ENABLE_DENTAL === "1";
}

/**
 * Resolves the scheduler's batch size from DENTAL_VERIFIER_BATCH_SIZE:
 * a positive integer, capped at DENTAL_VERIFIER_SCHEDULER_MAX_BATCH_SIZE;
 * anything missing/unparseable/<=0 falls back to the conservative default.
 */
export function resolveDentalVerifierSchedulerBatchSize(env: Env = process.env): number {
  const raw = env.DENTAL_VERIFIER_BATCH_SIZE;
  if (raw === undefined || raw.trim() === "" || !/^\s*\d+\s*$/.test(raw)) {
    return DENTAL_VERIFIER_SCHEDULER_DEFAULT_BATCH_SIZE;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DENTAL_VERIFIER_SCHEDULER_DEFAULT_BATCH_SIZE;
  return Math.min(n, DENTAL_VERIFIER_SCHEDULER_MAX_BATCH_SIZE);
}
