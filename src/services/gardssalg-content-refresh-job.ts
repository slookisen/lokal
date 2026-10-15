// ─── Gårdssalg content-refresh — server-side daily job («4b-det») ─────────
//
// A2A dev-request 2026-10-06-experiences-enrichment-plattformjobb-og-felles-
// serverjobbramme, tillegg 2026-10-15 (Daniel live: «bygg 4b-det nå»), which
// moved Step 4b of the experiences-enrichment routine (the gårdssalg content
// queue, DRINK COHORT FIRST — Grep 1 of dev-request 2026-08-19) off the
// Cloud Routine and onto the platform, exactly like opplevagent outreach
// (tickGardssalgOutreachDaily) and the description proposals job.
//
// WHY. Since 2026-10-06 the routine is read-only (M02) and nobody drained
// the drink queue: 111 thin+verified drink rows on 2026-10-15, 2 resting.
// Routines do not own recurring prod writes (CLAUDE.md, 2026-10-04); a
// server-side job does.
//
// WHAT IT DOES. Once a day, inside a UTC window, it calls the SAME shared
// core as POST /admin/gardssalg-content-refresh (runGardssalgContentRefresh
// in routes/opplevelser.ts) — never a copy of it — twice over:
//   lane 1  cohort:"drink"   verified drink producers still thin on a field,
//                            oldest-attempted first (Del B hvile applies)
//   lane 2  auto             the generic gårdssalg queue
// up to CALLS_PER_LANE batches of 8 per lane, stopping a lane after two
// consecutive zero-yield batches or when the drink queue reports
// cohort_eligible_total === 0.
//
// NEVER CALLS AN LLM. Every batch is run with `llm: false` (Daniel
// 2026-10-08: the server job's LLM budget is 0 by design). In that mode the
// shared core skips every model call site — quality judge, generators, the
// Del-A3 visit path, the products generator — and still does the
// deterministic work: selection, gates, crawl, extractive summaries, JSON-LD
// opening hours (Del A4), no-yield bookkeeping (Del B1). A row whose
// deterministic candidate merely lacks a judge is reported as
// `judge_required` and is NOT given a no-yield strike (it is the input to
// the subscription-side «4b-forslag» lane, where Claude Code on Daniel's
// subscription writes and judges, and a file-queue job stores).
//
// GUARDS, in order, each a silent no-op:
//   1. GARDSSALG_CONTENT_REFRESH_JOB_ENABLED === "true" (OFF by default —
//      flipping it off is the rollback; cron only, a manual run ignores it).
//   2. The window: GARDSSALG_CONTENT_REFRESH_JOB_WINDOW_HOUR_UTC (default 3)
//      and ≥ 20 h since the last completed run (boot_job_state, so a deploy
//      inside the window cannot run it twice).
//   3. The experiences enrichment write-pause — enforced INSIDE the shared
//      core (HTTP 423 body); the first 423 ends the run as `paused`.
//
// LEDGER. One run-envelope per run (agent gardssalg-content-refresh-platform,
// run_id fixed per UTC day for cron runs, so a repeat is a no-op on the
// ledger too) with the SAME claim kinds the routine used to emit, so every
// downstream reader (charter metric_sources, daily brief, verifier) keeps
// working: gardssalg_drink_cohort_enriched / _eligible / _resting,
// gardssalg_content_enriched (generic lane), http_unreachable (permanent
// fetch failures), providers_parked — plus gardssalg_judge_required_rows
// (new, additive). Dry-runs (manual, apply:false) record no envelope.

import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import { recordRun } from "./run-ledger";
import { getJobLastCompletedAt, markJobCompleted, resolveDailyJobLastRunAt } from "./boot-job-gate";
import { ENRICHMENT_WRITE_PAUSE_HTTP_STATUS } from "./enrichment-write-pause";

export const GARDSSALG_CR_JOB_AGENT = "gardssalg-content-refresh-platform";
export const GARDSSALG_CR_JOB_STATE_KEY = "gardssalg-content-refresh-daily";
export const GARDSSALG_CR_JOB_DEFAULT_WINDOW_HOUR_UTC = 3;
export const GARDSSALG_CR_JOB_MIN_HOURS_BETWEEN = 20;
export const GARDSSALG_CR_JOB_BATCH_SIZE = 8;
export const GARDSSALG_CR_JOB_DEFAULT_CALLS_PER_LANE = 2;
export const GARDSSALG_CR_JOB_MAX_CALLS_PER_LANE = 6;
/** A lane stops after this many consecutive zero-yield batches. */
export const GARDSSALG_CR_JOB_ZERO_STREAK_STOP = 2;

export type GardssalgCrRunFn = (input: {
  apply: boolean;
  limit: number;
  cohort?: "drink";
  llm: false;
}) => Promise<{ status: number; body: any }>;

export interface GardssalgContentRefreshJobDeps {
  /** The shared core; defaults to runGardssalgContentRefresh (routes/opplevelser). */
  run?: GardssalgCrRunFn;
  env?: Record<string, string | undefined>;
  now?: Date;
  /** MAIN db thunk — boot_job_state + run ledger live there. */
  mainDb?: () => Database.Database;
}

export type GardssalgCrLaneName = "drink" | "generic";

export interface GardssalgCrLaneReport {
  lane: GardssalgCrLaneName;
  calls: number;
  scanned: number;
  enriched: number;
  changed_ids: string[];
  parked_now: string[];
  permanent_errors: number;
  excluded_shared_domain: number;
  judge_required_rows: number;
  /** drink lane only, from the FIRST batch (queue depth before this run). */
  cohort_eligible_total: number | null;
  cohort_resting_total: number | null;
  stop_reason: "zero_streak" | "queue_empty" | "max_calls" | "error" | "paused" | null;
  errors: Array<{ call: number; status: number; message: string }>;
}

export type GardssalgCrSkipReason = "disabled" | "paused";

export interface GardssalgContentRefreshDailyReport {
  run_id: string;
  agent: string;
  trigger: "cron" | "manual";
  apply: boolean;
  llm: false;
  started_at: string;
  finished_at: string;
  skipped_reason: GardssalgCrSkipReason | null;
  lanes: GardssalgCrLaneReport[];
  totals: {
    calls: number;
    scanned: number;
    drink_enriched: number;
    generic_enriched: number;
    permanent_errors: number;
    parked_now: number;
    judge_required_rows: number;
  };
  envelope_recorded: boolean;
}

export function gardssalgContentRefreshJobEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GARDSSALG_CONTENT_REFRESH_JOB_ENABLED === "true";
}

export function resolveGardssalgCrJobWindowHourUtc(env: Record<string, string | undefined> = process.env): number {
  const n = parseInt(String(env.GARDSSALG_CONTENT_REFRESH_JOB_WINDOW_HOUR_UTC ?? ""), 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : GARDSSALG_CR_JOB_DEFAULT_WINDOW_HOUR_UTC;
}

export function resolveGardssalgCrJobCallsPerLane(env: Record<string, string | undefined> = process.env): number {
  const n = parseInt(String(env.GARDSSALG_CONTENT_REFRESH_JOB_CALLS_PER_LANE ?? ""), 10);
  if (!Number.isInteger(n) || n < 1) return GARDSSALG_CR_JOB_DEFAULT_CALLS_PER_LANE;
  return Math.min(GARDSSALG_CR_JOB_MAX_CALLS_PER_LANE, n);
}

/** Pure scheduling guard — same shape as shouldRunGardssalgOutreachDaily. */
export function shouldRunGardssalgContentRefreshDaily(opts: {
  now: Date;
  lastRunAt: Date | null;
  windowHourUtc?: number;
  minHoursBetween?: number;
}): boolean {
  const windowHourUtc = opts.windowHourUtc ?? GARDSSALG_CR_JOB_DEFAULT_WINDOW_HOUR_UTC;
  const minHoursBetween = opts.minHoursBetween ?? GARDSSALG_CR_JOB_MIN_HOURS_BETWEEN;
  if (opts.now.getUTCHours() !== windowHourUtc) return false;
  if (opts.lastRunAt) {
    const deltaMs = opts.now.getTime() - opts.lastRunAt.getTime();
    if (deltaMs < minHoursBetween * 3600_000) return false;
  }
  return true;
}

function emptyLane(lane: GardssalgCrLaneName): GardssalgCrLaneReport {
  return {
    lane,
    calls: 0,
    scanned: 0,
    enriched: 0,
    changed_ids: [],
    parked_now: [],
    permanent_errors: 0,
    excluded_shared_domain: 0,
    judge_required_rows: 0,
    cohort_eligible_total: null,
    cohort_resting_total: null,
    stop_reason: null,
    errors: [],
  };
}

/**
 * One run: drink lane, then generic lane, each up to callsPerLane batches of
 * GARDSSALG_CR_JOB_BATCH_SIZE through the shared core with llm:false.
 * Returns "paused" (and stops everything) on the first 423 from the core.
 */
async function runLanes(
  run: GardssalgCrRunFn,
  apply: boolean,
  callsPerLane: number,
): Promise<{ lanes: GardssalgCrLaneReport[]; paused: boolean }> {
  const lanes: GardssalgCrLaneReport[] = [];
  for (const lane of ["drink", "generic"] as const) {
    const rep = emptyLane(lane);
    lanes.push(rep);
    let zeroStreak = 0;
    while (rep.calls < callsPerLane) {
      let out: { status: number; body: any };
      try {
        out = await run({
          apply,
          limit: GARDSSALG_CR_JOB_BATCH_SIZE,
          ...(lane === "drink" ? { cohort: "drink" as const } : {}),
          llm: false,
        });
      } catch (err: any) {
        rep.calls++;
        rep.errors.push({ call: rep.calls, status: 0, message: String(err?.message ?? err).slice(0, 300) });
        rep.stop_reason = "error";
        break;
      }
      rep.calls++;
      if (out.status === ENRICHMENT_WRITE_PAUSE_HTTP_STATUS) {
        rep.stop_reason = "paused";
        return { lanes, paused: true };
      }
      if (out.status !== 200 || !out.body) {
        rep.errors.push({
          call: rep.calls,
          status: out.status,
          message: String(out.body?.error ?? out.body?.message ?? "non-200").slice(0, 300),
        });
        rep.stop_reason = "error";
        break;
      }
      const b = out.body;
      const enriched = Number(b.agents_enriched ?? 0) || 0;
      rep.scanned += Number(b.scanned ?? 0) || 0;
      rep.enriched += enriched;
      rep.judge_required_rows += Number(b.judge_required_rows ?? 0) || 0;
      rep.permanent_errors += Number(b.errors_by_persistence?.permanent ?? 0) || 0;
      rep.excluded_shared_domain += Array.isArray(b.excluded_shared_domain) ? b.excluded_shared_domain.length : 0;
      if (Array.isArray(b.changed)) for (const c of b.changed) if (c?.provider_id) rep.changed_ids.push(String(c.provider_id));
      if (Array.isArray(b.parked_now)) for (const id of b.parked_now) rep.parked_now.push(String(id));
      if (lane === "drink" && rep.calls === 1) {
        rep.cohort_eligible_total = typeof b.cohort_eligible_total === "number" ? b.cohort_eligible_total : null;
        rep.cohort_resting_total = typeof b.cohort_resting_total === "number" ? b.cohort_resting_total : null;
      }
      if (lane === "drink" && typeof b.cohort_eligible_total === "number" && b.cohort_eligible_total === 0) {
        rep.stop_reason = "queue_empty";
        break;
      }
      zeroStreak = enriched === 0 ? zeroStreak + 1 : 0;
      if (zeroStreak >= GARDSSALG_CR_JOB_ZERO_STREAK_STOP) {
        rep.stop_reason = "zero_streak";
        break;
      }
    }
    if (!rep.stop_reason) rep.stop_reason = "max_calls";
  }
  return { lanes, paused: false };
}

async function defaultRun(): Promise<GardssalgCrRunFn> {
  const mod = await import("../routes/opplevelser");
  return (input) => mod.runGardssalgContentRefresh(input);
}

/** The run itself (no scheduling). Used by the daily tick and the manual route. */
export async function runGardssalgContentRefreshDaily(
  opts: { apply: boolean; trigger: "cron" | "manual"; now?: Date },
  deps: GardssalgContentRefreshJobDeps = {},
): Promise<GardssalgContentRefreshDailyReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? opts.now ?? new Date();
  const startedAt = now.toISOString();
  const day = startedAt.slice(0, 10);
  const runId =
    opts.trigger === "cron"
      ? `run-${day}-${GARDSSALG_CR_JOB_AGENT}-experiences`
      : `run-${day}-${GARDSSALG_CR_JOB_AGENT}-manual-${startedAt.slice(11, 23).replace(/[:.]/g, "")}-${Math.random().toString(16).slice(2, 6)}-experiences`;
  const base = {
    run_id: runId,
    agent: GARDSSALG_CR_JOB_AGENT,
    trigger: opts.trigger,
    apply: opts.apply,
    llm: false as const,
    started_at: startedAt,
  };
  const finish = (
    skipped: GardssalgCrSkipReason | null,
    lanes: GardssalgCrLaneReport[],
    envelopeRecorded: boolean,
  ): GardssalgContentRefreshDailyReport => {
    const drink = lanes.find((l) => l.lane === "drink");
    const generic = lanes.find((l) => l.lane === "generic");
    return {
      ...base,
      finished_at: new Date().toISOString(),
      skipped_reason: skipped,
      lanes,
      totals: {
        calls: lanes.reduce((n, l) => n + l.calls, 0),
        scanned: lanes.reduce((n, l) => n + l.scanned, 0),
        drink_enriched: drink?.enriched ?? 0,
        generic_enriched: generic?.enriched ?? 0,
        permanent_errors: lanes.reduce((n, l) => n + l.permanent_errors, 0),
        parked_now: lanes.reduce((n, l) => n + l.parked_now.length, 0),
        judge_required_rows: lanes.reduce((n, l) => n + l.judge_required_rows, 0),
      },
      envelope_recorded: envelopeRecorded,
    };
  };

  if (opts.trigger === "cron" && !gardssalgContentRefreshJobEnabled(env)) {
    return finish("disabled", [], false);
  }

  const run = deps.run ?? (await defaultRun());
  const callsPerLane = resolveGardssalgCrJobCallsPerLane(env);
  const { lanes, paused } = await runLanes(run, opts.apply, callsPerLane);
  if (paused) return finish("paused", lanes, false);

  // Dry-run is read-only end to end: nothing written, nothing on the ledger.
  if (!opts.apply) return finish(null, lanes, false);

  const drink = lanes.find((l) => l.lane === "drink") ?? emptyLane("drink");
  const generic = lanes.find((l) => l.lane === "generic") ?? emptyLane("generic");
  const allErrors = lanes.flatMap((l) => l.errors.map((e) => ({ message: `${l.lane} call ${e.call}: HTTP ${e.status} ${e.message}`, meta: { lane: l.lane, call: e.call, status: e.status } })));
  const firstCallFailed = drink.calls === 1 && drink.errors.length === 1 && drink.scanned === 0 && generic.calls === 0;
  const status: "completed" | "partial" | "failed" = firstCallFailed ? "failed" : allErrors.length > 0 ? "partial" : "completed";
  const claims = [
    { type: "db_state_change" as const, value: drink.enriched, meta: { kind: "gardssalg_drink_cohort_enriched", source: "platform_job", llm: false } },
    { type: "db_state_change" as const, value: drink.cohort_eligible_total ?? 0, meta: { kind: "gardssalg_drink_cohort_eligible", measured: drink.cohort_eligible_total !== null } },
    { type: "db_state_change" as const, value: drink.cohort_resting_total ?? 0, meta: { kind: "gardssalg_drink_cohort_resting", measured: drink.cohort_resting_total !== null } },
    { type: "db_state_change" as const, value: generic.enriched, meta: { kind: "gardssalg_content_enriched", source: "platform_job", llm: false } },
    { type: "db_state_change" as const, value: drink.permanent_errors + generic.permanent_errors, meta: { kind: "http_unreachable" } },
    { type: "db_state_change" as const, value: drink.parked_now.length + generic.parked_now.length, meta: { kind: "providers_parked" } },
    { type: "db_state_change" as const, value: drink.judge_required_rows + generic.judge_required_rows, meta: { kind: "gardssalg_judge_required_rows" } },
  ];
  const notes =
    `4b-det (llm:false): drikke ${drink.enriched} beriket av ${drink.scanned} skannet i ${drink.calls} kall ` +
    `(kø ${drink.cohort_eligible_total ?? "?"} aktive / ${drink.cohort_resting_total ?? "?"} hviler, stopp: ${drink.stop_reason}); ` +
    `generisk ${generic.enriched} beriket av ${generic.scanned} skannet i ${generic.calls} kall (stopp: ${generic.stop_reason}); ` +
    `judge_required ${drink.judge_required_rows + generic.judge_required_rows}; excl_shared ${drink.excluded_shared_domain + generic.excluded_shared_domain}`;
  let envelopeRecorded = false;
  try {
    recordRun(
      {
        run_id: runId,
        vertical: "experiences",
        agent: GARDSSALG_CR_JOB_AGENT,
        trigger_source: opts.trigger === "cron" ? "cron" : "manual",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status,
        claims,
        evidence: [
          { claim_idx: 0, ids: drink.changed_ids },
          { claim_idx: 3, ids: generic.changed_ids },
          { claim_idx: 5, ids: [...drink.parked_now, ...generic.parked_now] },
        ],
        notes: notes.slice(0, 490),
        ...(allErrors.length > 0 ? { errors: allErrors } : {}),
      },
      (deps.mainDb ?? getDb)(),
    );
    envelopeRecorded = true;
  } catch (err) {
    console.error("[gardssalg-content-refresh-job] run-ledger envelope failed (non-fatal):", err);
  }
  return finish(null, lanes, envelopeRecorded);
}

/** Daily tick for index.ts: window + once-a-day guard, then the run. */
export async function tickGardssalgContentRefreshDaily(
  opts: { now: Date; lastRunAt: Date | null },
  deps: GardssalgContentRefreshJobDeps = {},
): Promise<{ lastRunAt: Date | null; report: GardssalgContentRefreshDailyReport | null }> {
  const env = deps.env ?? process.env;
  const mainDb = deps.mainDb ?? getDb;
  if (!gardssalgContentRefreshJobEnabled(env)) return { lastRunAt: opts.lastRunAt, report: null };
  const lastRunAt = resolveDailyJobLastRunAt(mainDb(), GARDSSALG_CR_JOB_STATE_KEY, opts.lastRunAt, opts.now);
  if (!shouldRunGardssalgContentRefreshDaily({ now: opts.now, lastRunAt, windowHourUtc: resolveGardssalgCrJobWindowHourUtc(env) })) {
    return { lastRunAt, report: null };
  }
  const report = await runGardssalgContentRefreshDaily({ apply: true, trigger: "cron", now: opts.now }, deps);
  // A paused run did not do the day's work — leave the stamp alone so the
  // next tick inside the window retries once the pause is lifted.
  if (report.skipped_reason !== "paused") markJobCompleted(mainDb(), GARDSSALG_CR_JOB_STATE_KEY, opts.now);
  return { lastRunAt: report.skipped_reason === "paused" ? lastRunAt : opts.now, report };
}

/** Read-only status for GET /admin/gardssalg-content-refresh-job-status. */
export function getGardssalgContentRefreshJobStatus(
  deps: { env?: Record<string, string | undefined>; mainDb?: () => Database.Database } = {},
): {
  enabled: boolean;
  llm: false;
  window_hour_utc: number;
  calls_per_lane: number;
  batch_size: number;
  last_completed_at: string | null;
  runs: Array<{ run_id: string; started_at: string; finished_at: string | null; status: string; claims: unknown; notes: string | null }>;
} {
  const env = deps.env ?? process.env;
  const db = (deps.mainDb ?? getDb)();
  let rows: Array<{ run_id: string; started_at: string; finished_at: string | null; status: string; claims: string; notes: string | null }> = [];
  try {
    rows = db
      .prepare(
        `SELECT run_id, started_at, finished_at, status, claims, notes FROM runs
          WHERE agent = ? ORDER BY started_at DESC LIMIT 14`,
      )
      .all(GARDSSALG_CR_JOB_AGENT) as typeof rows;
  } catch { rows = []; }
  const last = getJobLastCompletedAt(db, GARDSSALG_CR_JOB_STATE_KEY);
  return {
    enabled: gardssalgContentRefreshJobEnabled(env),
    llm: false,
    window_hour_utc: resolveGardssalgCrJobWindowHourUtc(env),
    calls_per_lane: resolveGardssalgCrJobCallsPerLane(env),
    batch_size: GARDSSALG_CR_JOB_BATCH_SIZE,
    last_completed_at: last ? last.toISOString() : null,
    runs: rows.map((r) => {
      let claims: unknown = null;
      try { claims = JSON.parse(r.claims); } catch { claims = null; }
      return { run_id: r.run_id, started_at: r.started_at, finished_at: r.finished_at, status: r.status, claims, notes: r.notes };
    }),
  };
}
