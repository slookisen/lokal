// ─── Experiences org.nr resolution — server-side daily job (step «3n») ────
//
// A2A dev-request 2026-10-06-experiences-enrichment-plattformjobb-og-felles-
// serverjobbramme, «Innsnevring 2026-10-28» (Daniel 3.10): the experiences-
// enrichment routine is read-only since 2026-10-06 and no longer runs step
// 3n, so the two org.nr paths that resolve `brreg_active IS NULL` providers
// (POST /admin/experiences-orgnr-from-website, Trinn A, and POST
// /admin/experiences-orgnr-from-name-kommune, Trinn B) have had no caller.
// This job is their write path, in the same pattern as the deployed
// gårdssalg content-refresh job (services/gardssalg-content-refresh-job.ts):
// a 10-minute tick in index.ts, a UTC window, one run per day persisted in
// boot_job_state, a flag that is OFF by default, one ledger envelope per
// apply run. It never calls an LLM — both services are deterministic
// (labeled org.nr on the provider's own site / Brreg name+kommune search,
// each with its own corroboration gate).
//
// WHAT IT DOES. Lane 1 = Trinn A (website), lane 2 = Trinn B (name+kommune),
// each up to CALLS_PER_LANE ticks of the service's own default batch size,
// resuming from the SAME persisted cursor the routes use when `after` is
// omitted (experience_orgnr_sweep_state), so job and routes share one sweep
// position per path. A lane stops when the service reports the end of the
// backlog (next_after === null — the persisted cursor then restarts the next
// day from the top), on an error, or at max calls.
//
// PUNKT a (folded in from 2026-09-14-opplevagent-karantene-utgang-brreg-
// krav): when a tick resolves a provider to brreg_active=1, this job clears
// `admission_checked_at` on that provider's experiences rows that are in
// scope, still `needs_review`, canonical, and already judged — so the
// content-judge sweep (step 3k, which orders never-checked rows first) takes
// them next instead of in ~23 days. Only the timestamp is cleared;
// admission_verdict is left as-is. One transaction per provider, with an
// audit row in experience_provider_field_write_audit (field
// `experiences.admission_checked_at`, old values as JSON, batch_id = the
// job's run_id) so it can be read back and reversed.
//
// GUARDS, in order:
//   1. EXPERIENCE_ORGNR_JOB_ENABLED === "true" (OFF by default — flipping it
//      off is the rollback; cron only, a manual run ignores it).
//   2. The window: EXPERIENCE_ORGNR_JOB_WINDOW_HOUR_UTC (default 4, one hour
//      after the content-refresh job) and ≥ 20 h since the last completed
//      run (boot_job_state).
//   3. The experiences enrichment write-pause, checked before every apply
//      tick: a pause ends the run as `paused`, writes no envelope and leaves
//      the daily stamp alone so the next tick in the window retries.
//
// DRY-RUN (manual, apply:false) is read-only end to end: services run with
// dryRun, the persisted cursor is read but never advanced, nothing is reset,
// nothing goes on the ledger. It reports what the run would do, including
// how many rows punkt a would reset.

import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import { recordRun } from "./run-ledger";
import { getJobLastCompletedAt, markJobCompleted, resolveDailyJobLastRunAt } from "./boot-job-gate";
import { enrichmentWritePauseBlock } from "./enrichment-write-pause";
import { experienceInScopeSql } from "./experience-scope";
import {
  getExperienceOrgnrSweepAfter,
  setExperienceOrgnrSweepAfter,
  type ExperienceOrgnrSweepRoute,
} from "./experience-orgnr-sweep-state";

export const EXPERIENCE_ORGNR_JOB_AGENT = "experience-orgnr-platform";
export const EXPERIENCE_ORGNR_JOB_STATE_KEY = "experience-orgnr-daily";
export const EXPERIENCE_ORGNR_JOB_DEFAULT_WINDOW_HOUR_UTC = 4;
export const EXPERIENCE_ORGNR_JOB_MIN_HOURS_BETWEEN = 20;
export const EXPERIENCE_ORGNR_JOB_DEFAULT_CALLS_PER_LANE = 2;
export const EXPERIENCE_ORGNR_JOB_MAX_CALLS_PER_LANE = 6;
export const EXPERIENCE_ORGNR_ADMISSION_RESET_FIELD = "experiences.admission_checked_at";

export type ExperienceOrgnrLaneName = "website" | "name_kommune";

const LANE_CURSOR_KEY: Record<ExperienceOrgnrLaneName, ExperienceOrgnrSweepRoute> = {
  website: "orgnr_from_website",
  name_kommune: "orgnr_from_name_kommune",
};

/** The subset of both services' tick results this job reads. */
export interface ExperienceOrgnrTickResult {
  processed: number;
  resolved_active: number;
  resolved_inactive: number;
  errors: number;
  skipped_due_to_time_budget: string[];
  planned: Array<{ provider_id: string; outcome: string; org_nr: string | null }>;
  next_after: string | null;
}

export type ExperienceOrgnrTickFn = (opts: { dryRun: boolean; after: string | undefined }) => Promise<ExperienceOrgnrTickResult>;

export interface ExperienceOrgnrJobDeps {
  /** Trinn A tick; defaults to experienceOrgnrFromWebsiteTick (service default limit). */
  website?: ExperienceOrgnrTickFn;
  /** Trinn B tick; defaults to experienceOrgnrFromNameKommuneTick (service default limit). */
  nameKommune?: ExperienceOrgnrTickFn;
  /** Write-pause check; defaults to the experiences enrichment write-pause. Non-null = paused. */
  pauseBlock?: () => unknown | null;
  env?: Record<string, string | undefined>;
  now?: Date;
  /** MAIN db thunk — boot_job_state + run ledger live there. */
  mainDb?: () => Database.Database;
  /** experiences db thunk — sweep cursor + punkt-a reset live there. */
  expDb?: () => Database.Database;
}

export interface ExperienceOrgnrLaneReport {
  lane: ExperienceOrgnrLaneName;
  calls: number;
  processed: number;
  resolved_active: number;
  resolved_inactive: number;
  errors: number;
  skipped_due_to_time_budget: number;
  resolved_active_ids: string[];
  cursor_start: string | null;
  cursor_end: string | null;
  stop_reason: "backlog_end" | "max_calls" | "error" | "paused" | null;
  call_errors: Array<{ call: number; message: string }>;
}

export interface ExperienceOrgnrAdmissionReset {
  provider_id: string;
  experience_ids: string[];
}

export type ExperienceOrgnrSkipReason = "disabled" | "paused";

export interface ExperienceOrgnrDailyReport {
  run_id: string;
  agent: string;
  trigger: "cron" | "manual";
  apply: boolean;
  started_at: string;
  finished_at: string;
  skipped_reason: ExperienceOrgnrSkipReason | null;
  lanes: ExperienceOrgnrLaneReport[];
  /** Punkt a: rows reset (apply) or that would be reset (dry-run), per provider. */
  admission_resets: ExperienceOrgnrAdmissionReset[];
  totals: {
    calls: number;
    processed: number;
    resolved_active: number;
    resolved_inactive: number;
    errors: number;
    admission_reset_rows: number;
  };
  envelope_recorded: boolean;
}

export function experienceOrgnrJobEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EXPERIENCE_ORGNR_JOB_ENABLED === "true";
}

export function resolveExperienceOrgnrJobWindowHourUtc(env: Record<string, string | undefined> = process.env): number {
  const raw = String(env.EXPERIENCE_ORGNR_JOB_WINDOW_HOUR_UTC ?? "").trim();
  if (!/^\d{1,2}$/.test(raw)) return EXPERIENCE_ORGNR_JOB_DEFAULT_WINDOW_HOUR_UTC;
  const n = Number(raw);
  return n >= 0 && n <= 23 ? n : EXPERIENCE_ORGNR_JOB_DEFAULT_WINDOW_HOUR_UTC;
}

export function resolveExperienceOrgnrJobCallsPerLane(env: Record<string, string | undefined> = process.env): number {
  const raw = String(env.EXPERIENCE_ORGNR_JOB_CALLS_PER_LANE ?? "").trim();
  if (!/^\d+$/.test(raw)) return EXPERIENCE_ORGNR_JOB_DEFAULT_CALLS_PER_LANE;
  const n = Number(raw);
  if (n < 1) return EXPERIENCE_ORGNR_JOB_DEFAULT_CALLS_PER_LANE;
  return Math.min(EXPERIENCE_ORGNR_JOB_MAX_CALLS_PER_LANE, n);
}

/** Pure scheduling guard — same shape as shouldRunGardssalgContentRefreshDaily. */
export function shouldRunExperienceOrgnrDaily(opts: {
  now: Date;
  lastRunAt: Date | null;
  windowHourUtc?: number;
  minHoursBetween?: number;
}): boolean {
  const windowHourUtc = opts.windowHourUtc ?? EXPERIENCE_ORGNR_JOB_DEFAULT_WINDOW_HOUR_UTC;
  const minHoursBetween = opts.minHoursBetween ?? EXPERIENCE_ORGNR_JOB_MIN_HOURS_BETWEEN;
  if (opts.now.getUTCHours() !== windowHourUtc) return false;
  if (opts.lastRunAt) {
    const deltaMs = opts.now.getTime() - opts.lastRunAt.getTime();
    if (deltaMs < minHoursBetween * 3600_000) return false;
  }
  return true;
}

// ─── Punkt a: clear admission_checked_at for a provider resolved active ───

const RESET_SELECT_SQL =
  `SELECT e.id AS id, e.admission_checked_at AS admission_checked_at FROM experiences e
    WHERE e.provider_id = ?
      AND e.verification_status = 'needs_review'
      AND e.canonical_id IS NULL
      AND e.evidence_url IS NOT NULL
      AND e.admission_checked_at IS NOT NULL
      AND ${experienceInScopeSql("e.category", "e.provider_id")}
    ORDER BY e.id ASC`;

/**
 * Rows of `providerId` that punkt a would reset. With `apply`, clears their
 * admission_checked_at and writes one audit row, in ONE transaction. Never
 * touches a row that is not needs_review (the UPDATE re-checks it). Returns
 * the ids reset (apply) or that would be reset (dry-run).
 */
export function resetAdmissionCheckForResolvedProvider(
  expDb: Database.Database,
  providerId: string,
  opts: { apply: boolean; batchId: string },
): string[] {
  const select = expDb.prepare(RESET_SELECT_SQL);
  if (!opts.apply) {
    return (select.all(providerId) as Array<{ id: string }>).map((r) => r.id);
  }
  const update = expDb.prepare(
    `UPDATE experiences SET admission_checked_at = NULL
      WHERE id = ? AND verification_status = 'needs_review' AND admission_checked_at IS NOT NULL`,
  );
  const audit = expDb.prepare(
    `INSERT INTO experience_provider_field_write_audit (id, provider_id, field_name, old_value, new_value, batch_id)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  );
  const tx = expDb.transaction((): string[] => {
    const rows = select.all(providerId) as Array<{ id: string; admission_checked_at: string }>;
    const old: Record<string, string> = {};
    const done: string[] = [];
    for (const r of rows) {
      if (update.run(r.id).changes > 0) {
        old[r.id] = r.admission_checked_at;
        done.push(r.id);
      }
    }
    if (done.length > 0) {
      audit.run(uuid(), providerId, EXPERIENCE_ORGNR_ADMISSION_RESET_FIELD, JSON.stringify(old), opts.batchId);
    }
    return done;
  });
  return tx();
}

// ─── The run ──────────────────────────────────────────────────────────────

function emptyLane(lane: ExperienceOrgnrLaneName): ExperienceOrgnrLaneReport {
  return {
    lane,
    calls: 0,
    processed: 0,
    resolved_active: 0,
    resolved_inactive: 0,
    errors: 0,
    skipped_due_to_time_budget: 0,
    resolved_active_ids: [],
    cursor_start: null,
    cursor_end: null,
    stop_reason: null,
    call_errors: [],
  };
}

async function defaultTicks(): Promise<{ website: ExperienceOrgnrTickFn; nameKommune: ExperienceOrgnrTickFn }> {
  const a = await import("./experience-orgnr-from-website");
  const b = await import("./experience-orgnr-from-name-kommune");
  return {
    website: (o) => a.experienceOrgnrFromWebsiteTick(a.EXPERIENCE_ORGNR_WEBSITE_DEFAULT_LIMIT, o),
    nameKommune: (o) => b.experienceOrgnrFromNameKommuneTick(b.EXPERIENCE_ORGNR_NAME_KOMMUNE_DEFAULT_LIMIT, o),
  };
}

function defaultPauseBlock(): unknown | null {
  return enrichmentWritePauseBlock(getDb, "experiences");
}

/** The run itself (no scheduling). Used by the daily tick and the manual route. */
export async function runExperienceOrgnrDaily(
  opts: { apply: boolean; trigger: "cron" | "manual"; now?: Date },
  deps: ExperienceOrgnrJobDeps = {},
): Promise<ExperienceOrgnrDailyReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? opts.now ?? new Date();
  const startedAt = now.toISOString();
  const day = startedAt.slice(0, 10);
  // Cron: fixed per UTC day. A cron run that resumes after a mid-run pause
  // (its partial envelope already holds the day's id) gets its own id, or
  // recordRun's ON CONFLICT DO NOTHING would drop its envelope.
  const cronBaseId = `run-${day}-${EXPERIENCE_ORGNR_JOB_AGENT}-experiences`;
  const cronIdTaken = (): boolean => {
    try {
      return !!(deps.mainDb ?? getDb)().prepare(`SELECT 1 FROM runs WHERE run_id = ?`).get(cronBaseId);
    } catch {
      return false;
    }
  };
  const runId =
    opts.trigger === "cron"
      ? cronIdTaken()
        ? `run-${day}-${EXPERIENCE_ORGNR_JOB_AGENT}-r${startedAt.slice(11, 19).replace(/:/g, "")}-experiences`
        : cronBaseId
      : `run-${day}-${EXPERIENCE_ORGNR_JOB_AGENT}-manual-${startedAt.slice(11, 23).replace(/[:.]/g, "")}-${Math.random().toString(16).slice(2, 6)}-experiences`;
  const lanes: ExperienceOrgnrLaneReport[] = [];
  const resets: ExperienceOrgnrAdmissionReset[] = [];
  const finish = (skipped: ExperienceOrgnrSkipReason | null, envelopeRecorded: boolean): ExperienceOrgnrDailyReport => ({
    run_id: runId,
    agent: EXPERIENCE_ORGNR_JOB_AGENT,
    trigger: opts.trigger,
    apply: opts.apply,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    skipped_reason: skipped,
    lanes,
    admission_resets: resets,
    totals: {
      calls: lanes.reduce((n, l) => n + l.calls, 0),
      processed: lanes.reduce((n, l) => n + l.processed, 0),
      resolved_active: lanes.reduce((n, l) => n + l.resolved_active, 0),
      resolved_inactive: lanes.reduce((n, l) => n + l.resolved_inactive, 0),
      errors: lanes.reduce((n, l) => n + l.errors + l.call_errors.length, 0),
      admission_reset_rows: resets.reduce((n, r) => n + r.experience_ids.length, 0),
    },
    envelope_recorded: envelopeRecorded,
  });

  if (opts.trigger === "cron" && !experienceOrgnrJobEnabled(env)) return finish("disabled", false);

  const pauseBlock = deps.pauseBlock ?? defaultPauseBlock;
  if (opts.apply && pauseBlock()) return finish("paused", false);

  const expDb = (deps.expDb ?? (() => getVerticalDb("experiences") as unknown as Database.Database))();
  const ticks = deps.website && deps.nameKommune ? { website: deps.website, nameKommune: deps.nameKommune } : await defaultTicks();
  const callsPerLane = resolveExperienceOrgnrJobCallsPerLane(env);
  const seenReset = new Set<string>();
  let pausedMidRun = false;

  for (const lane of ["website", "name_kommune"] as const) {
    if (pausedMidRun) break;
    const rep = emptyLane(lane);
    lanes.push(rep);
    const tick = lane === "website" ? deps.website ?? ticks.website : deps.nameKommune ?? ticks.nameKommune;
    let cursor: string | undefined = getExperienceOrgnrSweepAfter(expDb, LANE_CURSOR_KEY[lane]);
    rep.cursor_start = cursor ?? null;
    while (rep.calls < callsPerLane) {
      if (opts.apply && pauseBlock()) {
        rep.stop_reason = "paused";
        pausedMidRun = true;
        break;
      }
      let out: ExperienceOrgnrTickResult;
      rep.calls++;
      try {
        out = await tick({ dryRun: !opts.apply, after: cursor });
      } catch (err: any) {
        rep.call_errors.push({ call: rep.calls, message: String(err?.message ?? err).slice(0, 300) });
        rep.stop_reason = "error";
        break;
      }
      rep.processed += Number(out.processed) || 0;
      rep.resolved_active += Number(out.resolved_active) || 0;
      rep.resolved_inactive += Number(out.resolved_inactive) || 0;
      rep.errors += Number(out.errors) || 0;
      rep.skipped_due_to_time_budget += Array.isArray(out.skipped_due_to_time_budget) ? out.skipped_due_to_time_budget.length : 0;
      const nextAfter = typeof out.next_after === "string" && out.next_after.length > 0 ? out.next_after : null;
      // Apply only: advance the shared persisted cursor exactly as the
      // omitted-`after` route path does. A dry-run never moves it.
      if (opts.apply) {
        try {
          setExperienceOrgnrSweepAfter(expDb, LANE_CURSOR_KEY[lane], nextAfter);
        } catch (err) {
          console.error(`[experience-orgnr-job] failed to persist ${lane} cursor (non-fatal):`, err);
        }
      }
      for (const p of Array.isArray(out.planned) ? out.planned : []) {
        if (p?.outcome !== "resolved_active" || !p.provider_id) continue;
        const pid = String(p.provider_id);
        rep.resolved_active_ids.push(pid);
        if (seenReset.has(pid)) continue;
        seenReset.add(pid);
        try {
          const ids = resetAdmissionCheckForResolvedProvider(expDb, pid, { apply: opts.apply, batchId: runId });
          if (ids.length > 0) resets.push({ provider_id: pid, experience_ids: ids });
        } catch (err: any) {
          rep.call_errors.push({ call: rep.calls, message: `admission reset ${pid}: ${String(err?.message ?? err).slice(0, 240)}` });
        }
      }
      cursor = nextAfter ?? undefined;
      if (nextAfter === null) {
        rep.stop_reason = "backlog_end";
        break;
      }
    }
    rep.cursor_end = cursor ?? null;
    if (!rep.stop_reason) rep.stop_reason = "max_calls";
  }

  if (!opts.apply) return finish(null, false);

  // A pause after at least one tick: the writes already made still go on the
  // ledger (status partial); the run reports `paused` so the daily stamp is
  // left alone and the next tick in the window resumes from the cursor.
  const skipped: ExperienceOrgnrSkipReason | null = pausedMidRun ? "paused" : null;
  if (pausedMidRun && lanes.every((l) => l.calls === 0)) return finish("paused", false);
  const web = lanes[0];
  const nk = lanes[1] ?? emptyLane("name_kommune");
  const report = finish(skipped, false);
  const callErrors = lanes.flatMap((l) => l.call_errors.map((e) => ({ message: `${l.lane} call ${e.call}: ${e.message}`, meta: { lane: l.lane, call: e.call } })));
  const nothingRan = lanes.every((l) => l.processed === 0 && l.call_errors.length > 0);
  const status: "completed" | "partial" | "failed" = nothingRan ? "failed" : callErrors.length > 0 || pausedMidRun ? "partial" : "completed";
  const unresolved = Math.max(0, report.totals.processed - report.totals.resolved_active - report.totals.resolved_inactive);
  const claims = [
    { type: "db_state_change" as const, value: report.totals.resolved_active, meta: { kind: "experience_orgnr_resolved_active", website: web.resolved_active, name_kommune: nk.resolved_active, source: "platform_job" } },
    { type: "db_state_change" as const, value: report.totals.resolved_inactive, meta: { kind: "experience_orgnr_resolved_inactive", website: web.resolved_inactive, name_kommune: nk.resolved_inactive } },
    { type: "db_state_change" as const, value: report.totals.processed, meta: { kind: "experience_orgnr_processed", website: web.processed, name_kommune: nk.processed } },
    { type: "db_state_change" as const, value: unresolved, meta: { kind: "experience_orgnr_unresolved" } },
    { type: "db_state_change" as const, value: report.totals.admission_reset_rows, meta: { kind: "needs_review_admission_reset", providers: resets.length } },
  ];
  const notes =
    (pausedMidRun ? "STANSET av skrivepause midt i kjøringen; " : "") +
    `3n (orgnr, ingen LLM): nettside ${web.resolved_active} aktive/${web.resolved_inactive} inaktive av ${web.processed} i ${web.calls} kall (stopp: ${web.stop_reason}); ` +
    `navn+kommune ${nk.resolved_active}/${nk.resolved_inactive} av ${nk.processed} i ${nk.calls} kall (stopp: ${nk.stop_reason}); ` +
    `admission_checked_at nullstilt for ${report.totals.admission_reset_rows} needs_review-rader hos ${resets.length} leverandører; feil ${report.totals.errors}`;
  let envelopeRecorded = false;
  try {
    recordRun(
      {
        run_id: runId,
        vertical: "experiences",
        agent: EXPERIENCE_ORGNR_JOB_AGENT,
        trigger_source: opts.trigger === "cron" ? "cron" : "manual",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status,
        claims,
        evidence: [
          { claim_idx: 0, ids: [...web.resolved_active_ids, ...nk.resolved_active_ids] },
          { claim_idx: 4, ids: resets.flatMap((r) => r.experience_ids) },
        ],
        notes: notes.slice(0, 490),
        ...(callErrors.length > 0 ? { errors: callErrors } : {}),
      },
      (deps.mainDb ?? getDb)(),
    );
    envelopeRecorded = true;
  } catch (err) {
    console.error("[experience-orgnr-job] run-ledger envelope failed (non-fatal):", err);
  }
  return { ...report, finished_at: new Date().toISOString(), envelope_recorded: envelopeRecorded };
}

/** Daily tick for index.ts: window + once-a-day guard, then the run. */
export async function tickExperienceOrgnrDaily(
  opts: { now: Date; lastRunAt: Date | null },
  deps: ExperienceOrgnrJobDeps = {},
): Promise<{ lastRunAt: Date | null; report: ExperienceOrgnrDailyReport | null }> {
  const env = deps.env ?? process.env;
  const mainDb = deps.mainDb ?? getDb;
  if (!experienceOrgnrJobEnabled(env)) return { lastRunAt: opts.lastRunAt, report: null };
  const lastRunAt = resolveDailyJobLastRunAt(mainDb(), EXPERIENCE_ORGNR_JOB_STATE_KEY, opts.lastRunAt, opts.now);
  if (!shouldRunExperienceOrgnrDaily({ now: opts.now, lastRunAt, windowHourUtc: resolveExperienceOrgnrJobWindowHourUtc(env) })) {
    return { lastRunAt, report: null };
  }
  const report = await runExperienceOrgnrDaily({ apply: true, trigger: "cron", now: opts.now }, deps);
  // A paused run did not do the day's work — leave the stamp alone so the
  // next tick inside the window retries once the pause is lifted.
  if (report.skipped_reason !== "paused") markJobCompleted(mainDb(), EXPERIENCE_ORGNR_JOB_STATE_KEY, opts.now);
  return { lastRunAt: report.skipped_reason === "paused" ? lastRunAt : opts.now, report };
}

/** Read-only status for GET /admin/experience-orgnr-job-status. */
export function getExperienceOrgnrJobStatus(
  deps: { env?: Record<string, string | undefined>; mainDb?: () => Database.Database; expDb?: () => Database.Database } = {},
): {
  enabled: boolean;
  llm: false;
  window_hour_utc: number;
  calls_per_lane: number;
  last_completed_at: string | null;
  cursors: Record<ExperienceOrgnrLaneName, string | null>;
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
      .all(EXPERIENCE_ORGNR_JOB_AGENT) as typeof rows;
  } catch { rows = []; }
  const cursors: Record<ExperienceOrgnrLaneName, string | null> = { website: null, name_kommune: null };
  try {
    const expDb = (deps.expDb ?? (() => getVerticalDb("experiences") as unknown as Database.Database))();
    cursors.website = getExperienceOrgnrSweepAfter(expDb, "orgnr_from_website") ?? null;
    cursors.name_kommune = getExperienceOrgnrSweepAfter(expDb, "orgnr_from_name_kommune") ?? null;
  } catch { /* status stays readable without the experiences db */ }
  const last = getJobLastCompletedAt(db, EXPERIENCE_ORGNR_JOB_STATE_KEY);
  return {
    enabled: experienceOrgnrJobEnabled(env),
    llm: false,
    window_hour_utc: resolveExperienceOrgnrJobWindowHourUtc(env),
    calls_per_lane: resolveExperienceOrgnrJobCallsPerLane(env),
    last_completed_at: last ? last.toISOString() : null,
    cursors,
    runs: rows.map((r) => {
      let claims: unknown = null;
      try { claims = JSON.parse(r.claims); } catch { claims = null; }
      return { run_id: r.run_id, started_at: r.started_at, finished_at: r.finished_at, status: r.status, claims, notes: r.notes };
    }),
  };
}
