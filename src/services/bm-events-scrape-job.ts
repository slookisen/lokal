// ─── bm-events-scrape-job.ts — fire-and-forget BM events scrape (orch-pr-20) ───
//
// Problem: POST /admin/bm-events/scrape runs runBmEventsScraper() synchronously
// and returns the ScrapeResult to the caller. Under a cold cache the full
// scrape now exceeds 120s, which blows past the bm-events worker's ~45s
// harness window (and even a 120s detached window). The worker can't capture
// the result → the run is marked PARTIAL even though the scrape may have landed
// data server-side. The scrape itself is fine; only the SYNCHRONOUS request
// window is the problem.
//
// Fix (mirrors search-enrich-sweep.ts / verifier-sweep.ts): run the scrape in
// ONE fire-and-forget background job behind an in-memory singleton. The async
// caller fires the job, gets {run_id, status:"started"} in <1s, then polls
// GET for {status, counts, started_at, finished_at, last_error}. No more 120s
// timeout.
//
// IMPORTANT — the scrape LOGIC is byte-identical: this module does NOT
// re-implement any scraping/matching/upserting. It only wraps the EXISTING
// runBmEventsScraper() (which is already idempotent on event_slug — INSERT OR
// REPLACE — and already wraps every event in its own try/catch so one bad
// event can't abort the run). The synchronous mode in the route still calls
// runBmEventsScraper() directly; this job is opt-in (?async=1 / {async:true}).
//
// Like the other sweeps this is an in-memory singleton; a process restart loses
// the job STATE but never corrupts data (the scrape upserts are already
// committed). Re-running is safe (idempotent upsert on event_slug).

import { runBmEventsScraper, type ScrapeResult } from "./bm-events-scraper";

// ─── In-memory job state (singleton, mirrors search-enrich-sweep) ──────────────

export type BmEventsScrapeStatus = "idle" | "running" | "done" | "error";

/**
 * The job's counts mirror ScrapeResult 1:1 (so GET surfaces exactly what the
 * synchronous response used to), plus a derived `match_rate` for at-a-glance
 * health. `errors` is the same per-event error list runBmEventsScraper builds.
 */
export interface BmEventsScrapeCounts {
  fetched: number;
  parsed: number;
  matched_to_venue: number;
  matched_to_lokallag_fallback: number;
  auto_created_bm_venue: number;
  unmatched: number;
  upserted: number;
  event_times_checked: number;
  event_times_corrected: number;
  /** matched/parsed as a 0..1 ratio (0 when nothing parsed yet). */
  match_rate: number;
  errors: string[];
}

export interface BmEventsScrapeJob {
  run_id: string | null;
  status: BmEventsScrapeStatus;
  /** Echo of the opts the run was started with (for observability). */
  opts: { maxEvents?: number; useRenderWorker: boolean; correctTimes: boolean };
  counts: BmEventsScrapeCounts;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
}

function emptyCounts(): BmEventsScrapeCounts {
  return {
    fetched: 0,
    parsed: 0,
    matched_to_venue: 0,
    matched_to_lokallag_fallback: 0,
    auto_created_bm_venue: 0,
    unmatched: 0,
    upserted: 0,
    event_times_checked: 0,
    event_times_corrected: 0,
    match_rate: 0,
    errors: [],
  };
}

/** Number of matched events (venue + lokallag-fallback + auto-created). */
function matchedTotal(r: ScrapeResult): number {
  return (
    r.matched_to_venue +
    r.matched_to_lokallag_fallback +
    r.auto_created_bm_venue
  );
}

/** Fold a ScrapeResult into the job's counts shape, computing match_rate. */
function countsFromResult(r: ScrapeResult): BmEventsScrapeCounts {
  const matched = matchedTotal(r);
  return {
    fetched: r.fetched,
    parsed: r.parsed,
    matched_to_venue: r.matched_to_venue,
    matched_to_lokallag_fallback: r.matched_to_lokallag_fallback,
    auto_created_bm_venue: r.auto_created_bm_venue,
    unmatched: r.unmatched,
    upserted: r.upserted,
    event_times_checked: r.event_times_checked,
    event_times_corrected: r.event_times_corrected,
    match_rate: r.parsed > 0 ? matched / r.parsed : 0,
    errors: r.errors,
  };
}

let _job: BmEventsScrapeJob = {
  run_id: null,
  status: "idle",
  opts: { maxEvents: undefined, useRenderWorker: false, correctTimes: true },
  counts: emptyCounts(),
  started_at: null,
  finished_at: null,
  last_error: null,
};

/** Read-only snapshot of the current job (deep-copied counts/errors). */
export function getBmEventsScrapeJob(): Readonly<BmEventsScrapeJob> {
  return {
    ..._job,
    opts: { ..._job.opts },
    counts: { ..._job.counts, errors: [..._job.counts.errors] },
  };
}

function makeRunId(): string {
  return `bm-scrape-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
}

// ─── startBmEventsScrapeJob ────────────────────────────────────────────────────

export interface StartBmEventsScrapeOpts {
  /** Cap on events fetched. Passed straight through to runBmEventsScraper. */
  maxEvents?: number;
  /** Force the render-worker fallback (Cloudflare-resistant). Default false. */
  useRenderWorker?: boolean;
  /** PR-125 lokallag-fasit time correction. Default true (same as the route). */
  correctTimes?: boolean;
  /**
   * Injectable scrape runner — defaults to the real runBmEventsScraper. Tests
   * pass a stub (or stub globalThis.fetch + a test DB) so the suite never hits
   * the network. The DEFAULT path is the exact same call the synchronous route
   * makes, so behaviour is identical.
   */
  runner?: (opts: {
    maxEvents?: number;
    useRenderWorker?: boolean;
    correctTimes?: boolean;
  }) => Promise<ScrapeResult>;
}

export type StartBmEventsScrapeResult =
  | { started: true; run_id: string; status: "running" }
  | { started: false; reason: "already_running" };

/**
 * Launch the BM events scrape as a fire-and-forget background job.
 *
 * Returns immediately ({started:true, run_id, status:"running"}) while the
 * scrape runs in the background (NOT awaited). If a scrape is already running →
 * {started:false, reason:"already_running"} so the route can 409.
 *
 * The background body just `await`s runBmEventsScraper(opts) — the SAME call
 * the synchronous route makes — and copies its ScrapeResult into the job. No
 * scrape logic is duplicated or altered here.
 */
export function startBmEventsScrapeJob(
  opts: StartBmEventsScrapeOpts = {},
): StartBmEventsScrapeResult {
  if (_job.status === "running") {
    return { started: false, reason: "already_running" };
  }

  const runner = opts.runner ?? runBmEventsScraper;
  const useRenderWorker = opts.useRenderWorker === true;
  const correctTimes = opts.correctTimes !== false; // default on (mirrors route)
  const maxEvents =
    typeof opts.maxEvents === "number" && opts.maxEvents > 0
      ? opts.maxEvents
      : undefined;

  const runId = makeRunId();
  const startedAt = new Date().toISOString();

  _job = {
    run_id: runId,
    status: "running",
    opts: { maxEvents, useRenderWorker, correctTimes },
    counts: emptyCounts(),
    started_at: startedAt,
    finished_at: null,
    last_error: null,
  };

  // ── Background run (fire-and-forget; NOT awaited) ───────────────────────────
  (async () => {
    try {
      const result = await runner({ maxEvents, useRenderWorker, correctTimes });
      _job.counts = countsFromResult(result);
      // runBmEventsScraper never throws for per-event failures (those are in
      // result.errors) — a non-empty errors list is NOT a job failure, it's
      // normal partial-coverage info. We surface the first error as a hint but
      // keep status=done so the worker stops polling on completion.
      _job.last_error = result.errors.length > 0 ? result.errors[0]! : null;
      _job.status = "done";
      _job.finished_at = new Date().toISOString();
      console.log(
        `[bm-events-scrape-job] ${runId}: COMPLETE — fetched=${_job.counts.fetched} ` +
          `parsed=${_job.counts.parsed} matched_venue=${_job.counts.matched_to_venue} ` +
          `upserted=${_job.counts.upserted} unmatched=${_job.counts.unmatched} ` +
          `match_rate=${_job.counts.match_rate.toFixed(2)} errors=${_job.counts.errors.length}`,
      );
    } catch (err: any) {
      // Only a hard failure of runBmEventsScraper itself (e.g. DB unavailable)
      // lands here — per-event errors are handled inside it. Mark the job
      // errored so the worker can react.
      _job.status = "error";
      _job.finished_at = new Date().toISOString();
      _job.last_error = err?.message ?? String(err);
      console.error(`[bm-events-scrape-job] ${runId}: scrape failed:`, _job.last_error);
    }
  })(); // fire-and-forget

  return { started: true, run_id: runId, status: "running" };
}

/** TEST-ONLY: reset the singleton job so independent tests don't bleed state. */
export function __resetBmEventsScrapeJobForTesting(): void {
  _job = {
    run_id: null,
    status: "idle",
    opts: { maxEvents: undefined, useRenderWorker: false, correctTimes: true },
    counts: emptyCounts(),
    started_at: null,
    finished_at: null,
    last_error: null,
  };
}
