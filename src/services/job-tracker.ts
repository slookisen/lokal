// ─── In-memory job tracker (PR-65 Option D / Part A, 2026-05-17) ──────
//
// Why this exists: three admin endpoints (Hanen scrape, Debio cross-check,
// future bm-events bulk ops) routinely exceed Fly's ~120s HTTP proxy
// timeout. The work itself completes server-side, but the caller never
// gets a usable response. This module lets those endpoints fire-and-poll:
//
//   POST /admin/<endpoint>?async=1   → 202 + {job_id}
//   GET  /admin/jobs/<job_id>        → {status, result, ...}
//
// Why in-memory: all writes are committed to SQLite as the job
// progresses. If the Fly process restarts mid-flight, callers polling
// the job_id get a 404 and just re-fire — no data is lost (the
// last-applied DB state persists). A durable queue (BullMQ + Redis)
// would be over-engineering for this volume (a few admin ops/day).
//
// Lifecycle:
//   1. startJob() returns immediately with a job_id; the fn runs via
//      setImmediate() on the next tick.
//   2. State transitions: "running" → "completed" | "failed".
//   3. Completed/failed jobs stay queryable for 1 hour, then expire
//      lazily on access.
//
// Concurrency: 1 active job per (endpoint, dedupeKey) within a 60s
// window. Duplicate POSTs return the existing job_id. (Two different
// endpoints can run concurrently — the dedupe is per-endpoint.)
//
// Test hook: _clearJobsForTesting() resets all state.

import { randomUUID } from "node:crypto";

export type JobStatus = "running" | "completed" | "failed";

export type JobProgress = {
  stage: string;
  current: number;
  total: number | null;
};

export type JobState<T = unknown> = {
  job_id: string;
  endpoint: string;
  status: JobStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  result: T | null;
  error: string | null;
  progress: JobProgress | null;
};

// ─── Tunables ────────────────────────────────────────────────────────
// Jobs auto-expire 1h after they finished (or after start, if still
// running 1h later — that's a stuck job and the operator can just
// re-poll a fresh id). Cleanup is lazy on every get/list call.
const JOB_TTL_MS = 60 * 60 * 1000;

// Default dedupe window for startJob: identical params within 60s
// return the existing job_id instead of starting a new run.
const DEFAULT_DEDUPE_WINDOW_MS = 60 * 1000;

// ─── Module state ────────────────────────────────────────────────────
const jobs: Map<string, JobState<unknown>> = new Map();
// Maps dedupeKey → most-recent job_id. Cleared via expireOldJobs().
const dedupeIndex: Map<string, string> = new Map();

// ─── Internal helpers ────────────────────────────────────────────────
function nowIso(): string {
  return new Date().toISOString();
}

function epochMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

// Drop jobs older than JOB_TTL_MS (calculated from finished_at if set,
// else from started_at). Also prunes orphan dedupe-index entries.
function expireOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) {
    const anchor = j.finished_at ? epochMs(j.finished_at) : epochMs(j.started_at);
    if (anchor > 0 && anchor < cutoff) {
      jobs.delete(id);
    }
  }
  for (const [key, id] of dedupeIndex) {
    if (!jobs.has(id)) dedupeIndex.delete(key);
  }
}

// Decide whether an existing dedupe-matched job should suppress a
// new startJob call. A dedupe is honoured when:
//   - status is "running" (always — never start a second concurrent run), OR
//   - status is "completed" within the dedupe window (caller probably
//     just hit refresh; give them the cached result).
// Failed jobs do NOT block re-fire (the caller deserves a retry).
function shouldDedupe(j: JobState<unknown>, dedupeWindowMs: number): boolean {
  if (j.status === "running") return true;
  if (j.status === "completed" && j.finished_at) {
    return Date.now() - epochMs(j.finished_at) < dedupeWindowMs;
  }
  return false;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Start a background job and return its initial state synchronously.
 * The fn runs asynchronously via setImmediate(); the returned state's
 * status will already be "running" by the time the caller sees it.
 *
 * Dedupe: when options.dedupeKey is provided and an active or
 * recently-completed job exists for the same (endpoint, dedupeKey)
 * pair within the dedupe window (default 60s), the existing job's
 * state is returned instead of starting a new run.
 */
export function startJob<T>(
  endpoint: string,
  fn: (updateProgress: (p: JobProgress) => void) => Promise<T>,
  options?: { dedupeKey?: string; dedupeWindowMs?: number },
): JobState<T> {
  expireOldJobs();

  const dedupeKey = options?.dedupeKey
    ? `${endpoint}:${options.dedupeKey}`
    : null;
  const dedupeWindowMs = options?.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;

  if (dedupeKey) {
    const existingId = dedupeIndex.get(dedupeKey);
    if (existingId) {
      const existing = jobs.get(existingId) as JobState<T> | undefined;
      if (existing && shouldDedupe(existing, dedupeWindowMs)) {
        return existing;
      }
    }
  }

  const job_id = randomUUID();
  const state: JobState<T> = {
    job_id,
    endpoint,
    status: "running",
    started_at: nowIso(),
    finished_at: null,
    duration_ms: null,
    result: null,
    error: null,
    progress: null,
  };
  jobs.set(job_id, state as JobState<unknown>);
  if (dedupeKey) dedupeIndex.set(dedupeKey, job_id);

  const t0 = Date.now();
  const updateProgress = (p: JobProgress): void => {
    state.progress = { ...p };
  };

  setImmediate(() => {
    fn(updateProgress)
      .then((result) => {
        state.result = result;
        state.status = "completed";
        state.finished_at = nowIso();
        state.duration_ms = Date.now() - t0;
      })
      .catch((err) => {
        state.status = "failed";
        state.error = err instanceof Error ? err.message : String(err);
        state.finished_at = nowIso();
        state.duration_ms = Date.now() - t0;
      });
  });

  return state;
}

/** Return the live state for job_id, or null if unknown/expired. */
export function getJob<T = unknown>(jobId: string): JobState<T> | null {
  expireOldJobs();
  const j = jobs.get(jobId);
  return (j as JobState<T> | undefined) ?? null;
}

/**
 * List recent jobs sorted started_at DESC. Filter by endpoint to
 * scope to a particular admin op. Default limit 20, max 100.
 */
export function listJobs(filter?: {
  endpoint?: string;
  limit?: number;
}): JobState[] {
  expireOldJobs();
  const limit = Math.min(Math.max(1, filter?.limit ?? 20), 100);
  const all = Array.from(jobs.values());
  const filtered = filter?.endpoint
    ? all.filter(j => j.endpoint === filter.endpoint)
    : all;
  filtered.sort((a, b) => epochMs(b.started_at) - epochMs(a.started_at));
  return filtered.slice(0, limit);
}

/**
 * Test-only: clear ALL job state. Production code never calls this.
 */
export function _clearJobsForTesting(): void {
  jobs.clear();
  dedupeIndex.clear();
}

// Exported constants so callers (and tests) can reason about TTLs.
export const JOB_TRACKER_TTL_MS = JOB_TTL_MS;
export const JOB_TRACKER_DEFAULT_DEDUPE_WINDOW_MS = DEFAULT_DEDUPE_WINDOW_MS;
