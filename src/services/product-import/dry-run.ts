// ─── Product import dry run (measurement, Skive 1) ──────────────────────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 1:
// run the extractor against a stratified sample of ~100 RFB profiles that
// have a website (owned is_verified=1 and unowned; never umbrellas) and
// store what it found for the measurement report. Publishes NOTHING: the
// only tables written are product_import_runs and product_import_run_results.
// agent_knowledge and products are only ever read (the sample query).
//
// The run is a background job: startProductImportDryRun() inserts the run
// row and returns its id at once; the profiles are processed afterwards with
// a small worker pool, per-host pacing and ONE shared LLM-call cap for the
// whole run (≤ PRODUCT_IMPORT_DRYRUN_LLM_CAP_MAX), so it can never eat the
// nightly enrichment's budget.
//
// Round 2 (measurement 2026-10-30 was cut twice by a deploy): the run keeps
// its profile list (product_import_runs.sample_json), and on boot
// resumeProductImportDryRunOnBoot() continues a run left `running` /
// `interrupted` with the profiles that have no result row yet — one row per
// (run_id, agent_id) by the table's PRIMARY KEY, written INSERT OR IGNORE, so
// a resumed run never duplicates a profile. Same flag; off at boot = no
// resume. The LLM cap stays the run's: the calls already reserved count.

import { randomUUID } from "crypto";
import { getDb } from "../../database/init";
import { publicListableSql } from "../agent-visibility";
import { createLlmCallMeter, runWithLlmCallMeter } from "../llm-call-meter";
import {
  extractProductsFromWebsite,
  HostPacer,
  type LlmBudget,
  type ProductImportDeps,
  type ProductImportResult,
} from "./extractor";

export const PRODUCT_IMPORT_DRYRUN_DEFAULT_SAMPLE = 100;
export const PRODUCT_IMPORT_DRYRUN_MAX_SAMPLE = 200;
export const PRODUCT_IMPORT_DRYRUN_LLM_CAP_MAX = 150;
export const PRODUCT_IMPORT_DRYRUN_HOST_INTERVAL_MS = 1500;
export const PRODUCT_IMPORT_DRYRUN_CONCURRENCY = 3;
/** A run is resumed on boot at most this many times (a crash loop must not spin forever). */
export const PRODUCT_IMPORT_DRYRUN_MAX_RESUMES = 5;
/** Only runs started within this many hours are resumed; an older one stays interrupted. */
export const PRODUCT_IMPORT_DRYRUN_RESUME_MAX_AGE_HOURS = 24;

/** Flag: "1" turns the dry-run endpoints on. Anything else = off (404). */
export function productImportDryRunEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PRODUCT_IMPORT_DRYRUN_ENABLED === "1";
}

export interface DryRunSampleRow {
  agent_id: string;
  agent_name: string;
  website: string;
  is_owned: number;
}

export interface DryRunParams {
  agentIds?: string[];
  sampleSize?: number;
  llmCallCap?: number;
}

/**
 * The profiles to measure. With `agentIds`: those ids, still filtered to
 * producers with a website and no umbrella. Without: a random sample, half
 * owned (is_verified = 1) and half unowned — when one stratum is short the
 * other fills the rest. Read-only.
 */
export function selectDryRunSample(params: DryRunParams): DryRunSampleRow[] {
  const db = getDb();
  const size = clampSample(params.sampleSize);
  const base = `
    SELECT a.id AS agent_id, a.name AS agent_name, TRIM(k.website) AS website,
           CASE WHEN a.is_verified = 1 THEN 1 ELSE 0 END AS is_owned
      FROM agents a
      JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE a.role = 'producer'
       AND a.umbrella_type IS NULL
       AND COALESCE(a.is_active, 1) = 1
       AND ${publicListableSql("a", { ownerChoices: false })}
       AND TRIM(COALESCE(k.website, '')) <> ''`;

  if (params.agentIds && params.agentIds.length > 0) {
    const ids = [...new Set(params.agentIds.map(String))].slice(0, PRODUCT_IMPORT_DRYRUN_MAX_SAMPLE);
    const ph = ids.map(() => "?").join(",");
    return db.prepare(`${base} AND a.id IN (${ph}) ORDER BY a.id`).all(...ids) as DryRunSampleRow[];
  }

  const half = Math.ceil(size / 2);
  const owned = db
    .prepare(`${base} AND a.is_verified = 1 ORDER BY RANDOM() LIMIT ?`)
    .all(size) as DryRunSampleRow[];
  const unowned = db
    .prepare(`${base} AND COALESCE(a.is_verified, 0) <> 1 ORDER BY RANDOM() LIMIT ?`)
    .all(size) as DryRunSampleRow[];
  const takeOwned = Math.min(owned.length, Math.max(half, size - unowned.length));
  const takeUnowned = Math.min(unowned.length, size - takeOwned);
  return [...owned.slice(0, takeOwned), ...unowned.slice(0, takeUnowned)];
}

function clampSample(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : PRODUCT_IMPORT_DRYRUN_DEFAULT_SAMPLE;
  return Math.max(1, Math.min(PRODUCT_IMPORT_DRYRUN_MAX_SAMPLE, v));
}

function clampLlmCap(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : PRODUCT_IMPORT_DRYRUN_LLM_CAP_MAX;
  return Math.max(0, Math.min(PRODUCT_IMPORT_DRYRUN_LLM_CAP_MAX, v));
}

// ── Summary (PURE) ──────────────────────────────────────────────────────────

export interface DryRunResultRow {
  agent_id: string;
  agent_name: string;
  website: string;
  is_owned: number;
  result: ProductImportResult;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const share = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);

/** Every number the measurement report needs, from the per-profile rows. PURE. */
export function summarizeDryRun(rows: DryRunResultRow[]) {
  const count = (pred: (r: DryRunResultRow) => boolean) => rows.filter(pred).length;
  const tally = (key: (r: DryRunResultRow) => string | null) => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const k = key(r) ?? "none";
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  const productCounts = rows.map((r) => r.result.products.length);
  const withProducts = rows.filter((r) => r.result.products.length > 0);
  const priced = (r: DryRunResultRow) => r.result.products.some((p) => p.price_nok !== null);
  const allProducts = rows.flatMap((r) => r.result.products);
  const llmCandidates = rows.reduce((n, r) => n + r.result.grounding.llm_candidates, 0);
  const namesRejected = rows.reduce((n, r) => n + r.result.grounding.names_rejected, 0);
  const pricesRejected = rows.reduce((n, r) => n + r.result.grounding.prices_rejected, 0);
  const llmCalls = rows.reduce((n, r) => n + r.result.llm_calls, 0);
  const durations = rows.map((r) => r.result.duration_ms);
  const byOwnership = (owned: number) => {
    const sub = rows.filter((r) => r.is_owned === owned);
    const o: Record<string, number> = {};
    for (const r of sub) o[r.result.outcome] = (o[r.result.outcome] ?? 0) + 1;
    return {
      profiles: sub.length,
      outcome_counts: o,
      with_priced_product: sub.filter(priced).length,
      share_with_priced_product: share(sub.filter(priced).length, sub.length),
    };
  };
  return {
    profiles_total: rows.length,
    outcome_counts: tally((r) => r.result.outcome),
    outcome_shares: Object.fromEntries(
      Object.entries(tally((r) => r.result.outcome)).map(([k, v]) => [k, share(v, rows.length)]),
    ),
    tier_counts: tally((r) => r.result.tier),
    llm_status_counts: tally((r) => r.result.llm_status),
    profiles_with_products: withProducts.length,
    profiles_with_priced_product: count(priced),
    share_with_priced_product: share(count(priced), rows.length),
    products_total: allProducts.length,
    products_priced: allProducts.filter((p) => p.price_nok !== null).length,
    // Round 2: prices marked «ekskl. mva.» (not consumer prices; flagged, kept).
    products_price_excl_vat: allProducts.filter((p) => p.price_excl_vat === true).length,
    // Audit of the candidate rules (./rules.ts): how often each fired, and
    // what was excluded and why. Older stored results have neither field.
    rule_counts: (() => {
      const o: Record<string, number> = {};
      for (const p of allProducts) for (const rule of p.rules ?? []) o[rule] = (o[rule] ?? 0) + 1;
      return o;
    })(),
    excluded_total: rows.reduce((n, r) => n + (r.result.excluded?.length ?? 0), 0),
    excluded_reasons: (() => {
      const o: Record<string, number> = {};
      for (const r of rows) for (const e of r.result.excluded ?? []) o[e.reason] = (o[e.reason] ?? 0) + 1;
      return o;
    })(),
    products_per_profile: {
      mean_all: rows.length ? Math.round((allProducts.length / rows.length) * 100) / 100 : 0,
      mean_with_products: withProducts.length
        ? Math.round((allProducts.length / withProducts.length) * 100) / 100
        : 0,
      median_with_products: median(withProducts.map((r) => r.result.products.length)),
      max: productCounts.length ? Math.max(...productCounts) : 0,
    },
    grounding: {
      llm_candidates: llmCandidates,
      names_rejected: namesRejected,
      prices_rejected: pricesRejected,
      name_rejection_rate: share(namesRejected, llmCandidates),
      price_rejection_rate: share(pricesRejected, llmCandidates - namesRejected),
    },
    llm_calls_total: llmCalls,
    llm_calls_per_profile: share(llmCalls, rows.length),
    duration_ms: {
      total: durations.reduce((a, b) => a + b, 0),
      mean_per_profile: rows.length ? Math.round(durations.reduce((a, b) => a + b, 0) / rows.length) : 0,
      median_per_profile: median(durations),
      max: durations.length ? Math.max(...durations) : 0,
    },
    by_ownership: { owned: byOwnership(1), unowned: byOwnership(0) },
  };
}

// ── The job ─────────────────────────────────────────────────────────────────

export interface DryRunDeps extends Pick<ProductImportDeps, "fetchImpl" | "llm" | "sleep" | "now" | "timeoutMs"> {
  hostIntervalMs?: number;
  concurrency?: number;
}

let testDeps: DryRunDeps | null = null;
/** Test-only: inject fetch / LLM / clock for every run started after this. */
export function __setDryRunDepsForTesting(deps: DryRunDeps | null): void {
  testDeps = deps;
}

const jobs = new Map<string, Promise<void>>();

/** The id of a run still being processed in this process, if any. */
export function activeDryRunId(): string | null {
  for (const id of jobs.keys()) return id;
  return null;
}

/**
 * Test-only: forget every in-process job, as a fresh process after a
 * restart would (the old job's promise is simply no longer tracked).
 */
export function __forgetDryRunJobsForTesting(): void {
  jobs.clear();
}

/** Test-only: resolves when the background job for `runId` has finished. */
export function __awaitDryRunForTesting(runId: string): Promise<void> {
  return jobs.get(runId) ?? Promise.resolve();
}

export interface StartedDryRun {
  run_id: string;
  profiles_total: number;
  llm_call_cap: number;
}

export function startProductImportDryRun(params: DryRunParams, deps: DryRunDeps = testDeps ?? {}): StartedDryRun {
  const db = getDb();
  const sample = selectDryRunSample(params);
  const runId = `pir-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const llmCap = clampLlmCap(params.llmCallCap);
  db.prepare(
    `INSERT INTO product_import_runs (id, mode, status, params_json, profiles_total, llm_call_cap, sample_json)
     VALUES (?, 'dry_run', 'running', ?, ?, ?, ?)`,
  ).run(
    runId,
    JSON.stringify({
      agentIds: params.agentIds ?? null,
      sampleSize: params.agentIds?.length ? null : clampSample(params.sampleSize),
      llmCallCap: llmCap,
    }),
    sample.length,
    llmCap,
    JSON.stringify(sample.map((r) => r.agent_id)),
  );

  launchJob(runId, sample, llmCap, deps, { llmUsed: 0, resumed: 0 });
  return { run_id: runId, profiles_total: sample.length, llm_call_cap: llmCap };
}

function launchJob(
  runId: string,
  sample: DryRunSampleRow[],
  llmCap: number,
  deps: DryRunDeps,
  from: { llmUsed: number; resumed: number },
): void {
  const job = runJob(runId, sample, llmCap, deps, from).finally(() => jobs.delete(runId));
  jobs.set(runId, job);
}

export interface ResumedDryRun {
  run_id: string;
  profiles_total: number;
  profiles_done: number;
  profiles_remaining: number;
  resume_count: number;
}

/**
 * Boot hook: continue the newest dry run that a restart/deploy left
 * `running` or `interrupted` (started ≤ 24 h ago, with a stored profile
 * list), with the profiles that have no result row yet. Returns what was
 * resumed, or null (flag off, a run already active here, nothing to
 * resume). Never throws.
 */
export function resumeProductImportDryRunOnBoot(deps: DryRunDeps = testDeps ?? {}): ResumedDryRun | null {
  try {
    if (!productImportDryRunEnabled()) return null;
    if (activeDryRunId()) return null;
    const db = getDb();
    const run = db
      .prepare(
        `SELECT id, llm_call_cap, llm_calls, profiles_total, sample_json, resume_count, status
           FROM product_import_runs
          WHERE mode = 'dry_run' AND status IN ('running', 'interrupted')
            AND sample_json IS NOT NULL
            AND created_at >= datetime('now', ?)
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(`-${PRODUCT_IMPORT_DRYRUN_RESUME_MAX_AGE_HOURS} hours`) as
      | { id: string; llm_call_cap: number; llm_calls: number; profiles_total: number; sample_json: string; resume_count: number; status: string }
      | undefined;
    if (!run) return null;
    if (run.resume_count >= PRODUCT_IMPORT_DRYRUN_MAX_RESUMES) {
      db.prepare(
        `UPDATE product_import_runs
            SET status = 'interrupted', error = 'resume limit reached', finished_at = COALESCE(finished_at, datetime('now'))
          WHERE id = ?`,
      ).run(run.id);
      return null;
    }
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(run.sample_json);
      if (Array.isArray(parsed)) ids = parsed.map(String);
    } catch {
      /* unreadable list → nothing to resume with */
    }
    const done = new Set(
      (db.prepare(`SELECT agent_id FROM product_import_run_results WHERE run_id = ?`).all(run.id) as Array<{ agent_id: string }>).map(
        (r) => r.agent_id,
      ),
    );
    const remainingIds = ids.filter((id) => !done.has(id));
    // Same filters as the original selection, in the original order.
    const byId = new Map(
      (remainingIds.length > 0 ? selectDryRunSample({ agentIds: remainingIds }) : []).map((r) => [r.agent_id, r]),
    );
    const remaining = remainingIds.map((id) => byId.get(id)).filter((r): r is DryRunSampleRow => r !== undefined);
    const resumeCount = run.resume_count + 1;
    db.prepare(
      `UPDATE product_import_runs
          SET status = 'running', resume_count = ?, error = NULL, finished_at = NULL
        WHERE id = ?`,
    ).run(resumeCount, run.id);
    launchJob(run.id, remaining, run.llm_call_cap, deps, { llmUsed: run.llm_calls, resumed: resumeCount });
    return {
      run_id: run.id,
      profiles_total: run.profiles_total,
      profiles_done: done.size,
      profiles_remaining: remaining.length,
      resume_count: resumeCount,
    };
  } catch (err) {
    console.error("[product-import] dry-run resume failed:", err);
    return null;
  }
}

function storedResultRows(runId: string): DryRunResultRow[] {
  return (
    getDb()
      .prepare(
        `SELECT agent_id, agent_name, website, is_owned, result_json
           FROM product_import_run_results WHERE run_id = ? ORDER BY agent_id`,
      )
      .all(runId) as Array<{ agent_id: string; agent_name: string; website: string; is_owned: number; result_json: string }>
  ).map((r) => ({
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    website: r.website,
    is_owned: r.is_owned,
    result: JSON.parse(r.result_json || "{}") as ProductImportResult,
  }));
}

async function runJob(
  runId: string,
  sample: DryRunSampleRow[],
  llmCap: number,
  deps: DryRunDeps,
  from: { llmUsed: number; resumed: number },
): Promise<void> {
  const db = getDb();
  const budget: LlmBudget = { cap: llmCap, used: Math.min(llmCap, Math.max(0, from.llmUsed)) };
  const pacer = new HostPacer(deps.hostIntervalMs ?? PRODUCT_IMPORT_DRYRUN_HOST_INTERVAL_MS, deps.now, deps.sleep);
  const countDone = db.prepare(`SELECT COUNT(*) AS n FROM product_import_run_results WHERE run_id = ?`);
  const doneCount = () => (countDone.get(runId) as { n: number }).n;
  // One row per (run_id, agent_id) — the table's PRIMARY KEY; a profile that
  // already has a row (a resumed run) is never written twice.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO product_import_run_results
       (run_id, agent_id, agent_name, website, is_owned, outcome, tier, product_count, priced_count,
        llm_calls, duration_ms, result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const progress = db.prepare(`UPDATE product_import_runs SET profiles_done = ?, llm_calls = ? WHERE id = ?`);
  const meter = createLlmCallMeter();
  try {
    await runWithLlmCallMeter(meter, async () => {
      let next = 0;
      const worker = async () => {
        while (next < sample.length) {
          const row = sample[next++]!;
          const result = await extractProductsFromWebsite(row.website, {
            fetchImpl: deps.fetchImpl,
            llm: deps.llm,
            sleep: deps.sleep,
            now: deps.now,
            timeoutMs: deps.timeoutMs,
            llmBudget: budget,
            pacer,
          });
          insert.run(
            runId,
            row.agent_id,
            row.agent_name,
            row.website,
            row.is_owned,
            result.outcome,
            result.tier,
            result.products.length,
            result.products.filter((p) => p.price_nok !== null).length,
            result.llm_calls,
            result.duration_ms,
            JSON.stringify(result),
          );
          progress.run(doneCount(), budget.used, runId);
        }
      };
      const n = Math.max(1, Math.min(deps.concurrency ?? PRODUCT_IMPORT_DRYRUN_CONCURRENCY, sample.length || 1));
      await Promise.all(Array.from({ length: n }, worker));
    });
    // The summary covers every stored row, also those from before a resume.
    const rows = storedResultRows(runId);
    const summary = {
      ...summarizeDryRun(rows),
      llm_call_cap: llmCap,
      // Metered in this process only: before a resume, see llm_calls.
      llm_calls_metered: meter.calls,
      resume_count: from.resumed,
    };
    db.prepare(
      `UPDATE product_import_runs
          SET status = 'completed', profiles_done = ?, llm_calls = ?, summary_json = ?, finished_at = datetime('now')
        WHERE id = ?`,
    ).run(rows.length, budget.used, JSON.stringify(summary), runId);
  } catch (err) {
    try {
      db.prepare(
        `UPDATE product_import_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`,
      ).run(String((err as Error)?.message ?? err).slice(0, 300), runId);
    } catch {
      /* DB gone (e.g. a test closed it) — nothing left to record into */
    }
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export function getDryRun(runId: string, opts: { includeCandidates?: boolean } = {}) {
  const db = getDb();
  const run = db.prepare(`SELECT * FROM product_import_runs WHERE id = ? AND mode = 'dry_run'`).get(runId) as
    | Record<string, any>
    | undefined;
  if (!run) return null;
  let status = run.status as string;
  if (status === "running" && !jobs.has(runId)) {
    // The process that ran it is gone (restart/deploy): the run will never finish.
    db.prepare(
      `UPDATE product_import_runs SET status = 'interrupted', finished_at = datetime('now') WHERE id = ? AND status = 'running'`,
    ).run(runId);
    status = "interrupted";
  }
  const results = (
    db
      .prepare(
        `SELECT agent_id, agent_name, website, is_owned, outcome, tier, product_count, priced_count,
                llm_calls, duration_ms, result_json
           FROM product_import_run_results WHERE run_id = ? ORDER BY agent_id`,
      )
      .all(runId) as Array<Record<string, any>>
  ).map((r) => {
    const parsed = JSON.parse(r.result_json || "{}") as ProductImportResult;
    const { result_json: _ignored, ...rest } = r;
    return {
      ...rest,
      is_owned: r.is_owned === 1,
      llm_status: parsed.llm_status,
      grounding: parsed.grounding,
      pages_fetched: parsed.pages_fetched,
      fetched_urls: parsed.fetched_urls,
      rejected_urls: parsed.rejected_urls,
      robots_skipped: parsed.robots_skipped,
      excluded: parsed.excluded ?? [],
      ...(opts.includeCandidates === false ? {} : { candidates: parsed.products ?? [] }),
    };
  });
  return {
    run_id: run.id,
    mode: run.mode,
    status,
    params: JSON.parse(run.params_json || "{}"),
    profiles_total: run.profiles_total,
    profiles_done: run.profiles_done,
    llm_call_cap: run.llm_call_cap,
    llm_calls: run.llm_calls,
    created_at: run.created_at,
    finished_at: run.finished_at,
    error: run.error,
    resume_count: run.resume_count ?? 0,
    summary: run.summary_json ? JSON.parse(run.summary_json) : null,
    results,
  };
}

export function listDryRuns(limit = 20) {
  const db = getDb();
  return db
    .prepare(
      `SELECT id AS run_id, status, profiles_total, profiles_done, llm_calls, created_at, finished_at
         FROM product_import_runs WHERE mode = 'dry_run' ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, limit)));
}
