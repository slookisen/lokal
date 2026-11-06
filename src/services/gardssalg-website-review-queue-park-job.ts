// ─── Gårdssalg website-review-queue parking — server-side daily job (step «3m») ──
//
// POST /admin/gardssalg-website-review-queue-park (routes/opplevelser.ts) stamps
// `parked_since` on the two terminal-failure reasons of
// gardssalg_website_review_queue (`verification_failed`,
// `candidate_evidence_failed`). Until now it only ran when somebody called it.
// This job runs the SAME core (runGardssalgWebsiteReviewQueuePark, below —
// the route is a thin wrapper around it) once a day, in the same pattern as the
// 3f/3n jobs: a 10-minute tick in index.ts, a UTC window, one run per day
// persisted in boot_job_state, a flag that is OFF by default, one ledger
// envelope per apply run. No LLM, no new table, never a DELETE, never touches
// reason/evidence/candidate_url.
//
// GUARDS, in order:
//   1. GARDSSALG_WEBSITE_REVIEW_QUEUE_PARK_JOB_ENABLED === "true" (OFF by
//      default; cron only — a manual run ignores it).
//   2. The window: GARDSSALG_WEBSITE_REVIEW_QUEUE_PARK_JOB_WINDOW_HOUR_UTC
//      (default 6 — one hour AFTER the 3f verification sweep at 5, whose
//      failures this job parks, and clear of 3n at 4 and content-refresh at 3)
//      and >= 20 h since the last completed run (boot_job_state).
//   3. The experiences enrichment write-pause, checked before the apply: a
//      paused run writes nothing and leaves the daily stamp alone so the next
//      tick in the window retries.
//
// DRY-RUN (manual, apply:false) performs ZERO DB writes and records no envelope.

import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import { recordRun } from "./run-ledger";
import { getJobLastCompletedAt, markJobCompleted, resolveDailyJobLastRunAt } from "./boot-job-gate";
import { enrichmentWritePauseBlock } from "./enrichment-write-pause";

export const GARDSSALG_RQP_JOB_AGENT = "gardssalg-website-review-queue-park-platform";
export const GARDSSALG_RQP_JOB_STATE_KEY = "gardssalg-website-review-queue-park-daily";
export const GARDSSALG_RQP_JOB_DEFAULT_WINDOW_HOUR_UTC = 6;
export const GARDSSALG_RQP_JOB_MIN_HOURS_BETWEEN = 20;

export interface GardssalgRqpResult {
  would_park: number;
  parked: number;
  results: Array<{ provider_id: string; reason: string }>;
}

/**
 * Shared core of the park route and the daily job. Selects the terminal rows
 * (`verification_failed` / `candidate_evidence_failed`, `parked_since IS NULL`);
 * dry-run reports, apply stamps with a guarded UPDATE. Never deletes, never
 * touches reason/evidence/candidate_url. The response shape is exactly what
 * the route returned before the extraction.
 */
export function runGardssalgWebsiteReviewQueuePark(
  db: Database.Database,
  opts: { apply: boolean },
): GardssalgRqpResult {
  const candidates = db
    .prepare(
      `SELECT provider_id, reason FROM gardssalg_website_review_queue
        WHERE reason IN ('verification_failed', 'candidate_evidence_failed')
          AND parked_since IS NULL
        ORDER BY updated_at ASC`,
    )
    .all() as Array<{ provider_id: string; reason: string }>;

  // A true no-op on an empty selection — never throws, dry-run or apply.
  if (candidates.length === 0) return { would_park: 0, parked: 0, results: [] };

  const results = candidates.map((c) => ({ provider_id: c.provider_id, reason: c.reason }));
  if (!opts.apply) return { would_park: candidates.length, parked: 0, results };

  const stampPark = db.prepare(
    `UPDATE gardssalg_website_review_queue
        SET parked_since = datetime('now'), updated_at = datetime('now')
      WHERE provider_id = ? AND parked_since IS NULL`,
  );
  let parked = 0;
  for (const c of candidates) {
    const result = stampPark.run(c.provider_id);
    // changes === 0 means a concurrent call already parked this row between
    // our SELECT and this UPDATE — excluded from `parked`, still in `results`.
    if (result.changes > 0) parked++;
  }
  return { would_park: candidates.length, parked, results };
}

export type GardssalgRqpSkipReason = "disabled" | "paused";

export interface GardssalgRqpJobDeps {
  /** Write-pause check; non-null = paused. Defaults to the experiences enrichment pause. */
  pauseBlock?: () => unknown | null;
  env?: Record<string, string | undefined>;
  now?: Date;
  /** MAIN db thunk — boot_job_state, write-pause and run ledger live there. */
  mainDb?: () => Database.Database;
  /** experiences db thunk — the review queue lives there. */
  expDb?: () => Database.Database;
}

export interface GardssalgRqpDailyReport {
  run_id: string;
  agent: string;
  trigger: "cron" | "manual";
  apply: boolean;
  started_at: string;
  finished_at: string;
  skipped_reason: GardssalgRqpSkipReason | null;
  would_park: number;
  parked: number;
  results: Array<{ provider_id: string; reason: string }>;
  envelope_recorded: boolean;
}

export function gardssalgWebsiteReviewQueueParkJobEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GARDSSALG_WEBSITE_REVIEW_QUEUE_PARK_JOB_ENABLED === "true";
}

export function resolveGardssalgWebsiteReviewQueueParkJobWindowHourUtc(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = String(env.GARDSSALG_WEBSITE_REVIEW_QUEUE_PARK_JOB_WINDOW_HOUR_UTC ?? "").trim();
  if (!/^\d{1,2}$/.test(raw)) return GARDSSALG_RQP_JOB_DEFAULT_WINDOW_HOUR_UTC;
  const n = Number(raw);
  return n >= 0 && n <= 23 ? n : GARDSSALG_RQP_JOB_DEFAULT_WINDOW_HOUR_UTC;
}

/** Pure scheduling guard — same shape as shouldRunGardssalgWebsiteVerificationDaily. */
export function shouldRunGardssalgWebsiteReviewQueueParkDaily(opts: {
  now: Date;
  lastRunAt: Date | null;
  windowHourUtc?: number;
  minHoursBetween?: number;
}): boolean {
  const windowHourUtc = opts.windowHourUtc ?? GARDSSALG_RQP_JOB_DEFAULT_WINDOW_HOUR_UTC;
  const minHoursBetween = opts.minHoursBetween ?? GARDSSALG_RQP_JOB_MIN_HOURS_BETWEEN;
  if (opts.now.getUTCHours() !== windowHourUtc) return false;
  if (opts.lastRunAt) {
    const deltaMs = opts.now.getTime() - opts.lastRunAt.getTime();
    if (deltaMs < minHoursBetween * 3600_000) return false;
  }
  return true;
}

function defaultPauseBlock(): unknown | null {
  return enrichmentWritePauseBlock(getDb, "experiences");
}

/** The run itself (no scheduling). Used by the daily tick and the manual route. */
export async function runGardssalgWebsiteReviewQueueParkJob(
  opts: { apply: boolean; trigger: "cron" | "manual"; now?: Date },
  deps: GardssalgRqpJobDeps = {},
): Promise<GardssalgRqpDailyReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? opts.now ?? new Date();
  const startedAt = now.toISOString();
  const day = startedAt.slice(0, 10);
  const mainDb = deps.mainDb ?? getDb;
  const cronBaseId = `run-${day}-${GARDSSALG_RQP_JOB_AGENT}-experiences`;
  const cronIdTaken = (): boolean => {
    try {
      return !!mainDb().prepare(`SELECT 1 FROM runs WHERE run_id = ?`).get(cronBaseId);
    } catch {
      return false;
    }
  };
  const runId =
    opts.trigger === "cron"
      ? cronIdTaken()
        ? `run-${day}-${GARDSSALG_RQP_JOB_AGENT}-r${startedAt.slice(11, 19).replace(/:/g, "")}-experiences`
        : cronBaseId
      : `run-${day}-${GARDSSALG_RQP_JOB_AGENT}-manual-${startedAt.slice(11, 23).replace(/[:.]/g, "")}-${Math.random().toString(16).slice(2, 6)}-experiences`;

  const finish = (
    skipped: GardssalgRqpSkipReason | null,
    r: GardssalgRqpResult,
    envelopeRecorded: boolean,
  ): GardssalgRqpDailyReport => ({
    run_id: runId,
    agent: GARDSSALG_RQP_JOB_AGENT,
    trigger: opts.trigger,
    apply: opts.apply,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    skipped_reason: skipped,
    would_park: r.would_park,
    parked: r.parked,
    results: r.results,
    envelope_recorded: envelopeRecorded,
  });
  const none: GardssalgRqpResult = { would_park: 0, parked: 0, results: [] };

  if (opts.trigger === "cron" && !gardssalgWebsiteReviewQueueParkJobEnabled(env)) return finish("disabled", none, false);

  const pauseBlock = deps.pauseBlock ?? defaultPauseBlock;
  if (opts.apply && pauseBlock()) return finish("paused", none, false);

  const expDb = (deps.expDb ?? (() => getVerticalDb("experiences") as unknown as Database.Database))();
  const result = runGardssalgWebsiteReviewQueuePark(expDb, { apply: opts.apply });
  if (!opts.apply) return finish(null, result, false);

  let envelopeRecorded = false;
  try {
    recordRun(
      {
        run_id: runId,
        vertical: "experiences",
        agent: GARDSSALG_RQP_JOB_AGENT,
        trigger_source: opts.trigger === "cron" ? "cron" : "manual",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: "completed",
        claims: [
          { type: "db_state_change" as const, value: result.parked, meta: { kind: "gardssalg_website_review_queue_parked", would_park: result.would_park, source: "platform_job" } },
        ],
        evidence: [],
        notes: `3m (parkering av terminale rader i nettsidekøen, ingen LLM): ${result.would_park} kandidater, ${result.parked} parkert`.slice(0, 490),
      },
      mainDb(),
    );
    envelopeRecorded = true;
  } catch (err) {
    console.error("[gardssalg-website-review-queue-park-job] run-ledger envelope failed (non-fatal):", err);
  }
  return finish(null, result, envelopeRecorded);
}

/** Daily tick for index.ts: flag + window + once-a-day guard, then the run. */
export async function tickGardssalgWebsiteReviewQueueParkDaily(
  opts: { now: Date; lastRunAt: Date | null },
  deps: GardssalgRqpJobDeps = {},
): Promise<{ lastRunAt: Date | null; report: GardssalgRqpDailyReport | null }> {
  const env = deps.env ?? process.env;
  const mainDb = deps.mainDb ?? getDb;
  if (!gardssalgWebsiteReviewQueueParkJobEnabled(env)) return { lastRunAt: opts.lastRunAt, report: null };
  const lastRunAt = resolveDailyJobLastRunAt(mainDb(), GARDSSALG_RQP_JOB_STATE_KEY, opts.lastRunAt, opts.now);
  if (
    !shouldRunGardssalgWebsiteReviewQueueParkDaily({
      now: opts.now,
      lastRunAt,
      windowHourUtc: resolveGardssalgWebsiteReviewQueueParkJobWindowHourUtc(env),
    })
  ) {
    return { lastRunAt, report: null };
  }
  const report = await runGardssalgWebsiteReviewQueueParkJob({ apply: true, trigger: "cron", now: opts.now }, deps);
  // A paused run did not do the day's work — leave the stamp alone so the next
  // tick inside the window retries once the pause is lifted.
  if (report.skipped_reason !== "paused") {
    markJobCompleted(mainDb(), GARDSSALG_RQP_JOB_STATE_KEY, opts.now);
    return { lastRunAt: opts.now, report };
  }
  return { lastRunAt, report };
}

/** Read-only status for GET /admin/gardssalg-website-review-queue-park-job-status. */
export function getGardssalgWebsiteReviewQueueParkJobStatus(
  deps: { env?: Record<string, string | undefined>; mainDb?: () => Database.Database; expDb?: () => Database.Database } = {},
): {
  enabled: boolean;
  llm: false;
  window_hour_utc: number;
  last_completed_at: string | null;
  unparked_terminal_rows: number | null;
} {
  const env = deps.env ?? process.env;
  const db = (deps.mainDb ?? getDb)();
  let pending: number | null = null;
  try {
    const expDb = (deps.expDb ?? (() => getVerticalDb("experiences") as unknown as Database.Database))();
    pending = (
      expDb
        .prepare(
          `SELECT COUNT(*) AS c FROM gardssalg_website_review_queue
            WHERE reason IN ('verification_failed', 'candidate_evidence_failed') AND parked_since IS NULL`,
        )
        .get() as { c: number }
    ).c;
  } catch { /* status stays readable without the experiences db */ }
  const last = getJobLastCompletedAt(db, GARDSSALG_RQP_JOB_STATE_KEY);
  return {
    enabled: gardssalgWebsiteReviewQueueParkJobEnabled(env),
    llm: false,
    window_hour_utc: resolveGardssalgWebsiteReviewQueueParkJobWindowHourUtc(env),
    last_completed_at: last ? last.toISOString() : null,
    unparked_terminal_rows: pending,
  };
}
