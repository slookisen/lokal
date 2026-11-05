// ─── Gårdssalg website-verification sweep — server-side daily job (step «3f») ──
//
// The only caller of POST /admin/gardssalg-website-verification-remediation was
// the experiences-enrichment routine (step 3f: 12 rows per call, 5 calls per
// run, `offset` omitted so the route resumes from the persisted sweep offset).
// This job is the platform's own write path for the same sweep, in the same
// pattern as the 3n job (services/experience-orgnr-job.ts): a 10-minute tick in
// index.ts, a UTC window, one run per day persisted in boot_job_state, a flag
// that is OFF by default, one ledger envelope per apply run. No LLM — the
// classification is deterministic (services/gardssalg-website-verification.ts).
//
// WHAT IT DOES. cohort "all", scope "visible" (the route's default), pages of
// at most PAGE_LIMIT (12 = MAX_GARDSSALG_AUDIT_LIMIT) rows, at most MAX_PAGES
// (5) pages per run. It resumes from, and advances, the SAME persisted offset
// the route uses on its omitted-offset path
// (gardssalg_website_verification_sweep_state, keyed by cohort), through the
// SAME helpers, and loads/paginates/scans through the SAME
// scanGardssalgWebsiteVerificationPage + applyGardssalgWebsiteVerification the
// route calls. The offset is persisted after each successful scan (before the
// apply), exactly like the route; exhausting the cohort persists 0 (fresh pass).
//
// GUARDS, in order:
//   1. GARDSSALG_WEBSITE_VERIFICATION_JOB_ENABLED === "true" (OFF by default;
//      cron only — a manual run ignores it).
//   2. The window: GARDSSALG_WEBSITE_VERIFICATION_JOB_WINDOW_HOUR_UTC
//      (default 5) and >= 20 h since the last completed run (boot_job_state).
//   3. The experiences enrichment write-pause, checked before every apply page:
//      a pause ends the run as `paused`, leaves the daily stamp alone so the
//      next tick in the window retries.
//   4. A wall-clock budget (TIME_BUDGET_MS) checked between pages.
//
// DRY-RUN (manual, apply:false) performs ZERO DB writes: it reads the persisted
// offset, walks pages with a local offset, and never persists it (unlike the
// route, whose omitted-offset dry-run does advance it), writes no audit rows and
// no ledger envelope.

import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import { recordRun } from "./run-ledger";
import { getJobLastCompletedAt, markJobCompleted, resolveDailyJobLastRunAt } from "./boot-job-gate";
import { enrichmentWritePauseBlock, isEnrichmentWritePausedError } from "./enrichment-write-pause";
import {
  applyGardssalgWebsiteVerification,
  getGardssalgWebsiteVerificationSweepOffset,
  scanGardssalgWebsiteVerificationPage,
  setGardssalgWebsiteVerificationSweepOffset,
  type GsWvCohort,
  type GsWvFetchFn,
  type GsWvScanRow,
  type GsWvScope,
  type GsWvSummary,
} from "./gardssalg-website-verification";

export const GARDSSALG_WV_JOB_AGENT = "gardssalg-website-verification-platform";
export const GARDSSALG_WV_JOB_STATE_KEY = "gardssalg-website-verification-daily";
export const GARDSSALG_WV_JOB_DEFAULT_WINDOW_HOUR_UTC = 5;
export const GARDSSALG_WV_JOB_MIN_HOURS_BETWEEN = 20;
/** Same ceiling as MAX_GARDSSALG_AUDIT_LIMIT in routes/opplevelser.ts. */
export const GARDSSALG_WV_JOB_PAGE_LIMIT = 12;
export const GARDSSALG_WV_JOB_MAX_PAGES = 5;
export const GARDSSALG_WV_JOB_TIME_BUDGET_MS = 6 * 60_000;
export const GARDSSALG_WV_JOB_COHORT: GsWvCohort = "all";
export const GARDSSALG_WV_JOB_SCOPE: GsWvScope = "visible";
/** Same throttle as CR_CONCURRENCY in routes/opplevelser.ts. */
const SCAN_CONCURRENCY = 3;

export type GardssalgWvSkipReason = "disabled" | "paused";
export type GardssalgWvStopReason = "cohort_end" | "max_pages" | "time_budget" | "error" | "paused";

export interface GardssalgWvPageReport {
  page: number;
  offset: number;
  returned: number;
  next_offset: number | null;
  summary: GsWvSummary;
  would_enqueue: number;
  enqueued: number;
  dequeued: number;
  provenance_written: number;
}

export interface GardssalgWvJobDeps {
  /** Live fetcher; defaults to the route's gsWvFetchFnFromGardssalgCrawler. */
  fetchFn?: GsWvFetchFn;
  /** Write-pause check; non-null = paused. Defaults to the experiences enrichment pause. */
  pauseBlock?: () => unknown | null;
  env?: Record<string, string | undefined>;
  now?: Date;
  /** MAIN db thunk — boot_job_state, write-pause and run ledger live there. */
  mainDb?: () => Database.Database;
  /** experiences db thunk — cohort, sweep offset and verification writes live there. */
  expDb?: () => Database.Database;
  /** Wall-clock budget override (ms), mostly for tests. */
  timeBudgetMs?: number;
  /** Clock override for the budget check, mostly for tests. */
  nowMs?: () => number;
}

export interface GardssalgWvDailyReport {
  run_id: string;
  agent: string;
  trigger: "cron" | "manual";
  apply: boolean;
  started_at: string;
  finished_at: string;
  skipped_reason: GardssalgWvSkipReason | null;
  cohort: GsWvCohort;
  scope: GsWvScope;
  offset_start: number | null;
  offset_end: number | null;
  stop_reason: GardssalgWvStopReason | null;
  pages: GardssalgWvPageReport[];
  page_errors: Array<{ page: number; message: string }>;
  totals: {
    pages: number;
    scanned: number;
    verified: number;
    unverified: number;
    aggregator: number;
    missing_source: number;
    unreachable_transient: number;
    would_enqueue: number;
    enqueued: number;
    dequeued: number;
    provenance_written: number;
    errors: number;
  };
  envelope_recorded: boolean;
}

export function gardssalgWebsiteVerificationJobEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GARDSSALG_WEBSITE_VERIFICATION_JOB_ENABLED === "true";
}

export function resolveGardssalgWebsiteVerificationJobWindowHourUtc(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = String(env.GARDSSALG_WEBSITE_VERIFICATION_JOB_WINDOW_HOUR_UTC ?? "").trim();
  if (!/^\d{1,2}$/.test(raw)) return GARDSSALG_WV_JOB_DEFAULT_WINDOW_HOUR_UTC;
  const n = Number(raw);
  return n >= 0 && n <= 23 ? n : GARDSSALG_WV_JOB_DEFAULT_WINDOW_HOUR_UTC;
}

/** Pure scheduling guard — same shape as shouldRunExperienceOrgnrDaily. */
export function shouldRunGardssalgWebsiteVerificationDaily(opts: {
  now: Date;
  lastRunAt: Date | null;
  windowHourUtc?: number;
  minHoursBetween?: number;
}): boolean {
  const windowHourUtc = opts.windowHourUtc ?? GARDSSALG_WV_JOB_DEFAULT_WINDOW_HOUR_UTC;
  const minHoursBetween = opts.minHoursBetween ?? GARDSSALG_WV_JOB_MIN_HOURS_BETWEEN;
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

function emptySummary(): GsWvSummary {
  return { verified: 0, unverified: 0, aggregator: 0, missing_source: 0, unreachable_transient: 0, total: 0 };
}

/** The run itself (no scheduling). Used by the daily tick and the manual route. */
export async function runGardssalgWebsiteVerificationJob(
  opts: { apply: boolean; trigger: "cron" | "manual"; now?: Date },
  deps: GardssalgWvJobDeps = {},
): Promise<GardssalgWvDailyReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? opts.now ?? new Date();
  const startedAt = now.toISOString();
  const day = startedAt.slice(0, 10);
  const cronBaseId = `run-${day}-${GARDSSALG_WV_JOB_AGENT}-experiences`;
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
        ? `run-${day}-${GARDSSALG_WV_JOB_AGENT}-r${startedAt.slice(11, 19).replace(/:/g, "")}-experiences`
        : cronBaseId
      : `run-${day}-${GARDSSALG_WV_JOB_AGENT}-manual-${startedAt.slice(11, 23).replace(/[:.]/g, "")}-${Math.random().toString(16).slice(2, 6)}-experiences`;

  const pages: GardssalgWvPageReport[] = [];
  const pageErrors: Array<{ page: number; message: string }> = [];
  let offsetStart: number | null = null;
  let offsetEnd: number | null = null;
  let stopReason: GardssalgWvStopReason | null = null;

  const finish = (skipped: GardssalgWvSkipReason | null, envelopeRecorded: boolean): GardssalgWvDailyReport => {
    const sum = (k: keyof GsWvSummary) => pages.reduce((n, p) => n + p.summary[k], 0);
    return {
      run_id: runId,
      agent: GARDSSALG_WV_JOB_AGENT,
      trigger: opts.trigger,
      apply: opts.apply,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      skipped_reason: skipped,
      cohort: GARDSSALG_WV_JOB_COHORT,
      scope: GARDSSALG_WV_JOB_SCOPE,
      offset_start: offsetStart,
      offset_end: offsetEnd,
      stop_reason: stopReason,
      pages,
      page_errors: pageErrors,
      totals: {
        pages: pages.length,
        scanned: sum("total"),
        verified: sum("verified"),
        unverified: sum("unverified"),
        aggregator: sum("aggregator"),
        missing_source: sum("missing_source"),
        unreachable_transient: sum("unreachable_transient"),
        would_enqueue: pages.reduce((n, p) => n + p.would_enqueue, 0),
        enqueued: pages.reduce((n, p) => n + p.enqueued, 0),
        dequeued: pages.reduce((n, p) => n + p.dequeued, 0),
        provenance_written: pages.reduce((n, p) => n + p.provenance_written, 0),
        errors: pageErrors.length,
      },
      envelope_recorded: envelopeRecorded,
    };
  };

  if (opts.trigger === "cron" && !gardssalgWebsiteVerificationJobEnabled(env)) return finish("disabled", false);

  const pauseBlock = deps.pauseBlock ?? defaultPauseBlock;
  if (opts.apply && pauseBlock()) {
    stopReason = "paused";
    return finish("paused", false);
  }

  const expDb = (deps.expDb ?? (() => getVerticalDb("experiences") as unknown as Database.Database))();
  let fetchFn = deps.fetchFn;
  if (!fetchFn) {
    const routes = await import("../routes/opplevelser");
    fetchFn = routes.gsWvFetchFnFromGardssalgCrawler();
  }
  const budgetMs = deps.timeBudgetMs ?? GARDSSALG_WV_JOB_TIME_BUDGET_MS;
  const clock = deps.nowMs ?? Date.now;
  const t0 = clock();

  let offset = getGardssalgWebsiteVerificationSweepOffset(expDb, GARDSSALG_WV_JOB_COHORT);
  offsetStart = offset;
  offsetEnd = offset;
  let pausedMidRun = false;

  while (pages.length < GARDSSALG_WV_JOB_MAX_PAGES) {
    if (pages.length > 0 && clock() - t0 >= budgetMs) {
      stopReason = "time_budget";
      break;
    }
    if (opts.apply && pauseBlock()) {
      stopReason = "paused";
      pausedMidRun = true;
      break;
    }
    const pageNo = pages.length + 1;
    let scanned: Awaited<ReturnType<typeof scanGardssalgWebsiteVerificationPage>>;
    try {
      scanned = await scanGardssalgWebsiteVerificationPage(expDb, {
        scope: GARDSSALG_WV_JOB_SCOPE,
        cohort: GARDSSALG_WV_JOB_COHORT,
        fetchFn,
        concurrency: SCAN_CONCURRENCY,
        page: { limit: GARDSSALG_WV_JOB_PAGE_LIMIT, offset },
      });
    } catch (err: any) {
      pageErrors.push({ page: pageNo, message: String(err?.message ?? err).slice(0, 300) });
      stopReason = "error";
      break;
    }
    const nextOffset = scanned.nextOffset ?? null;
    // Apply only: persist AFTER a successful scan, exactly like the route's
    // omitted-offset path (null -> 0 inside the setter). A dry-run never writes.
    if (opts.apply) {
      try {
        setGardssalgWebsiteVerificationSweepOffset(expDb, GARDSSALG_WV_JOB_COHORT, nextOffset);
      } catch (err) {
        console.error("[gardssalg-website-verification-job] failed to persist sweep offset (non-fatal):", err);
      }
    }
    const page: GardssalgWvPageReport = {
      page: pageNo,
      offset,
      returned: scanned.rows.length,
      next_offset: nextOffset,
      summary: scanned.summary,
      would_enqueue: scanned.rows.filter((r: GsWvScanRow) => r.classification === "unverified").length,
      enqueued: 0,
      dequeued: 0,
      provenance_written: 0,
    };
    if (opts.apply) {
      try {
        const { applied } = applyGardssalgWebsiteVerification(expDb, scanned.rows, runId);
        page.enqueued = applied.filter((a) => a.enqueued).length;
        page.dequeued = applied.filter((a) => a.dequeued).length;
        page.provenance_written = applied.length;
      } catch (err: any) {
        if (isEnrichmentWritePausedError(err)) {
          // Offset already advanced for a page that wrote nothing: rewind it so
          // the next run re-scans this page rather than skipping it.
          try {
            setGardssalgWebsiteVerificationSweepOffset(expDb, GARDSSALG_WV_JOB_COHORT, offset);
          } catch { /* best-effort */ }
          stopReason = "paused";
          pausedMidRun = true;
          break;
        }
        pageErrors.push({ page: pageNo, message: String(err?.message ?? err).slice(0, 300) });
        stopReason = "error";
        pages.push(page);
        break;
      }
    }
    pages.push(page);
    if (nextOffset === null) {
      offsetEnd = 0;
      stopReason = "cohort_end";
      break;
    }
    offset = nextOffset;
    offsetEnd = nextOffset;
  }
  if (!stopReason) stopReason = "max_pages";

  if (!opts.apply) return finish(null, false);
  if (pausedMidRun && pages.length === 0) return finish("paused", false);

  const report = finish(pausedMidRun ? "paused" : null, false);
  const t = report.totals;
  const status: "completed" | "partial" | "failed" =
    pageErrors.length > 0 && pages.every((p) => p.returned === 0 && p.provenance_written === 0)
      ? "failed"
      : pageErrors.length > 0 || pausedMidRun
        ? "partial"
        : "completed";
  const claims = [
    { type: "db_state_change" as const, value: t.provenance_written, meta: { kind: "gardssalg_website_verification_stamped", verified: t.verified, source: "platform_job" } },
    { type: "db_state_change" as const, value: t.scanned, meta: { kind: "gardssalg_website_verification_scanned", pages: t.pages } },
    { type: "db_state_change" as const, value: t.enqueued, meta: { kind: "gardssalg_website_review_enqueued", unverified: t.unverified, dequeued: t.dequeued } },
  ];
  const notes =
    (pausedMidRun ? "STANSET av skrivepause midt i kjøringen; " : "") +
    `3f (hjemmesideverifisering, ingen LLM): cohort=${GARDSSALG_WV_JOB_COHORT} offset ${offsetStart}->${offsetEnd}, ${t.pages} sider, ` +
    `${t.scanned} skannet (${t.verified} verifisert/${t.unverified} uverifisert/${t.aggregator} aggregator/${t.missing_source} mangler kilde/${t.unreachable_transient} forbigående); ` +
    `køet ${t.enqueued}, fjernet fra kø ${t.dequeued}; stopp: ${stopReason}; feil ${t.errors}`;
  let envelopeRecorded = false;
  try {
    recordRun(
      {
        run_id: runId,
        vertical: "experiences",
        agent: GARDSSALG_WV_JOB_AGENT,
        trigger_source: opts.trigger === "cron" ? "cron" : "manual",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status,
        claims,
        evidence: [],
        notes: notes.slice(0, 490),
        ...(pageErrors.length > 0
          ? { errors: pageErrors.map((e) => ({ message: `page ${e.page}: ${e.message}`, meta: { page: e.page } })) }
          : {}),
      },
      (deps.mainDb ?? getDb)(),
    );
    envelopeRecorded = true;
  } catch (err) {
    console.error("[gardssalg-website-verification-job] run-ledger envelope failed (non-fatal):", err);
  }
  return { ...report, finished_at: new Date().toISOString(), envelope_recorded: envelopeRecorded };
}

/** Daily tick for index.ts: flag + window + once-a-day guard, then the run. */
export async function tickGardssalgWebsiteVerificationDaily(
  opts: { now: Date; lastRunAt: Date | null },
  deps: GardssalgWvJobDeps = {},
): Promise<{ lastRunAt: Date | null; report: GardssalgWvDailyReport | null }> {
  const env = deps.env ?? process.env;
  const mainDb = deps.mainDb ?? getDb;
  if (!gardssalgWebsiteVerificationJobEnabled(env)) return { lastRunAt: opts.lastRunAt, report: null };
  const lastRunAt = resolveDailyJobLastRunAt(mainDb(), GARDSSALG_WV_JOB_STATE_KEY, opts.lastRunAt, opts.now);
  if (
    !shouldRunGardssalgWebsiteVerificationDaily({
      now: opts.now,
      lastRunAt,
      windowHourUtc: resolveGardssalgWebsiteVerificationJobWindowHourUtc(env),
    })
  ) {
    return { lastRunAt, report: null };
  }
  const report = await runGardssalgWebsiteVerificationJob({ apply: true, trigger: "cron", now: opts.now }, deps);
  // A paused run did not do the day's work — leave the stamp alone so the next
  // tick inside the window retries once the pause is lifted.
  if (report.skipped_reason !== "paused" && report.stop_reason !== "paused") {
    markJobCompleted(mainDb(), GARDSSALG_WV_JOB_STATE_KEY, opts.now);
    return { lastRunAt: opts.now, report };
  }
  return { lastRunAt, report };
}

/** Read-only status for GET /admin/gardssalg-website-verification-job-status. */
export function getGardssalgWebsiteVerificationJobStatus(
  deps: { env?: Record<string, string | undefined>; mainDb?: () => Database.Database; expDb?: () => Database.Database } = {},
): {
  enabled: boolean;
  llm: false;
  window_hour_utc: number;
  cohort: GsWvCohort;
  page_limit: number;
  max_pages: number;
  last_completed_at: string | null;
  next_offset: number | null;
} {
  const env = deps.env ?? process.env;
  const db = (deps.mainDb ?? getDb)();
  let nextOffset: number | null = null;
  try {
    const expDb = (deps.expDb ?? (() => getVerticalDb("experiences") as unknown as Database.Database))();
    nextOffset = getGardssalgWebsiteVerificationSweepOffset(expDb, GARDSSALG_WV_JOB_COHORT);
  } catch { /* status stays readable without the experiences db */ }
  const last = getJobLastCompletedAt(db, GARDSSALG_WV_JOB_STATE_KEY);
  return {
    enabled: gardssalgWebsiteVerificationJobEnabled(env),
    llm: false,
    window_hour_utc: resolveGardssalgWebsiteVerificationJobWindowHourUtc(env),
    cohort: GARDSSALG_WV_JOB_COHORT,
    page_limit: GARDSSALG_WV_JOB_PAGE_LIMIT,
    max_pages: GARDSSALG_WV_JOB_MAX_PAGES,
    last_completed_at: last ? last.toISOString() : null,
    next_offset: nextOffset,
  };
}
