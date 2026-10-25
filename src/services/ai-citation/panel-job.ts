// ─── AI citation panel: the weekly job behind a flag ────────────────────────
// A2A dev-request 2026-10-16-siteringspanel, S5b. The run itself (questions,
// caps, store) is panel-runner.ts; the engines are engines.ts.
//
//   - AI_CITATION_PANEL_ENABLED ("1"/"true") turns it on; default OFF. Off =
//     the scheduler registers nothing and a tick makes no call.
//   - First check AI_CITATION_PANEL_BOOT_DELAY_MS (15 min) after boot, then
//     hourly. Each check waits for the boot jobs queued in the exclusive gate
//     (boot-job-gate.ts) and then runs outside it: the run is network waits,
//     one call at a time with a yield between, so it never holds back the
//     CPU-heavy boot jobs.
//   - Once a week: a check runs the current ISO week's questions that are not
//     stored yet, so the first free check of a week runs the panel and the
//     rest find nothing to do. A week is never asked twice (panel-runner.ts).
//   - Never in 00:00–01:00Z or 06:30–09:30Z: a check there does nothing, and a
//     run that reaches one pauses before its next call; the next free check
//     resumes it.
//   - Caps AI_CITATION_MAX_USD_PER_RUN (8) and AI_CITATION_MAX_USD_PER_MONTH
//     (30), applied by the runner before every call.
//   - Models and prices come from config/ai-citation-panel.json ("engines"),
//     with AI_CITATION_<ENGINE>_MODEL to pick another listed model
//     (engines.ts). An engine without its key, or whose override names a
//     model without prices there, is skipped, with one log line per process.
//     An invalid config makes no call.
//   - Status (GET /admin/analytics/ai-citations/status): the flag, each
//     engine's model, prices and whether it is active, the caps,
//     month_cost_usd from the stored results, the current week's progress and
//     the last run of this process.
// Keys are read from the environment per call and never logged; every log
// line also goes through redactSecrets().

import type Database from "better-sqlite3";
import { runExclusiveBootJob, AI_CITATION_PANEL_BOOT_DELAY_MS } from "../boot-job-gate";
import { trackJob } from "../event-loop-monitor";
import { createLlmCallMeter, runWithLlmCallMeter } from "../llm-call-meter";
import { redactSecrets } from "../search-console-fetch";
import {
  citationEngineKeys,
  citationEnginesForView,
  loadCitationEngines,
  type CitationEngine,
  type CitationEngineId,
} from "./engines";
import {
  aiCitationMonthCostUsd,
  aiCitationWeekOf,
  aiCitationWeekTotals,
  loadCitationPrompts,
  resolveAiCitationCaps,
  runCitationPanel,
  type CitationPanelRunSummary,
  type CitationPrompt,
} from "./panel-runner";

type Db = Database.Database;

export const AI_CITATION_PANEL_FLAG = "AI_CITATION_PANEL_ENABLED";
export const AI_CITATION_PANEL_TICK_INTERVAL_MS = 60 * 60_000;

/** UTC windows (from inclusive, to exclusive) in which the job makes no call. */
export const AI_CITATION_BLOCKED_WINDOWS_UTC: readonly { from: string; to: string }[] = Object.freeze([
  { from: "00:00", to: "01:00" },
  { from: "06:30", to: "09:30" },
]);

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** "06:30-09:30" when `at` is inside a blocked window, else null. */
export function aiCitationBlockedWindowAt(at: Date): string | null {
  const m = at.getUTCHours() * 60 + at.getUTCMinutes();
  for (const w of AI_CITATION_BLOCKED_WINDOWS_UTC) {
    if (m >= minutesOf(w.from) && m < minutesOf(w.to)) return `${w.from}-${w.to}`;
  }
  return null;
}

/** On only when AI_CITATION_PANEL_ENABLED is "1" or "true". */
export function isAiCitationPanelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[AI_CITATION_PANEL_FLAG] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

// ── State of this process ─────────────────────────────────────────────

interface LastRun {
  at: string;
  week: string;
  calls: number;
  ok: number;
  errors: number;
  skipped_cost_cap: number;
  cost_usd: number;
  stopped: string | null;
  pending: number;
  llm_calls: Record<string, number>;
}

let running = false;
let schedulerStarted = false;
let lastRun: LastRun | null = null;
/** Per engine, why it was last logged as skipped (so the line is not repeated every hour). */
const loggedInactive = new Map<CitationEngineId, string>();

function defaultDb(): Db {
  // Lazy: keeps this module loadable in tests without opening the prod DB.
  const init = require("../../database/init") as typeof import("../../database/init");
  return init.getDb();
}

// ── One check ─────────────────────────────────────────────────────────

export interface AiCitationTickOptions {
  env?: NodeJS.ProcessEnv;
  /** Defaults to the main DB (database/init.ts getDb()). */
  db?: Db;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Tests: other engines / questions (default: config/ai-citation-panel.json for `env`). */
  engines?: readonly CitationEngine[];
  prompts?: readonly CitationPrompt[];
}

export type AiCitationTickResult =
  | { skipped: "disabled" | "blocked_window" | "already_running" | "invalid_config" | "no_active_engine"; detail?: string }
  | (CitationPanelRunSummary & { skipped?: undefined; llmCalls: Record<string, number> });

function formatRunLine(r: CitationPanelRunSummary & { llmCalls: Record<string, number> }): string {
  const byEngine = Object.entries(r.llmCalls).map(([k, v]) => `${k.replace(/^ai-citation-/, "")}:${v}`).join(",") || "-";
  return (
    `[ai-citations] week=${r.week} calls=${r.calls} ok=${r.ok} errors=${r.errors} skipped_cost_cap=${r.skippedCostCap} ` +
    `cost_usd=${r.costUsd.toFixed(4)} week_cost_usd=${r.weekCostUsd.toFixed(4)} month_cost_usd=${r.monthCostUsd.toFixed(4)} ` +
    `stopped=${r.stopped ?? "-"} pending=${r.pending} by_engine=${byEngine}`
  );
}

/** Why an engine has no model (it then makes no call). The override's value is not echoed. */
const unpricedModel = (e: CitationEngine) => `${e.modelEnv} names a model without prices in config/ai-citation-panel.json`;

/** Why an engine is off, for its one log line; null when it is active. */
function inactiveReason(e: CitationEngine, env: NodeJS.ProcessEnv): string | null {
  if (e.model === null) return unpricedModel(e);
  return e.enabled(env) ? null : `${e.keyEnv} is not set`;
}

/**
 * One check: with the flag on, outside the blocked windows, with a valid config and at least one
 * active engine (model priced, key set), run the current week's missing questions within the
 * caps. Logs one line when it asked or skipped anything. Makes no call with the flag off.
 */
export async function runAiCitationPanelTick(opts: AiCitationTickOptions = {}): Promise<AiCitationTickResult> {
  const env = opts.env ?? process.env;
  if (!isAiCitationPanelEnabled(env)) return { skipped: "disabled" };
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.log(m));
  const say = (m: string) => log(redactSecrets(m, citationEngineKeys(env, opts.engines)));
  const window = aiCitationBlockedWindowAt(now());
  if (window) return { skipped: "blocked_window", detail: window };
  if (running) return { skipped: "already_running" };
  let prompts: readonly CitationPrompt[];
  let engines: readonly CitationEngine[];
  try {
    prompts = opts.prompts ?? loadCitationPrompts();
    engines = opts.engines ?? loadCitationEngines(env);
  } catch {
    say("[ai-citations] skipped: config/ai-citation-panel.json is invalid (see the engines and panel-runner tests)");
    return { skipped: "invalid_config" };
  }
  for (const e of engines) {
    const why = inactiveReason(e, env);
    if (why === null) loggedInactive.delete(e.engine);
    else if (loggedInactive.get(e.engine) !== why) {
      loggedInactive.set(e.engine, why);
      say(`[ai-citations] ${e.engine} skipped: ${why}`);
    }
  }
  const active = engines.filter((e) => e.enabled(env));
  if (active.length === 0) return { skipped: "no_active_engine" };

  running = true;
  try {
    const db = opts.db ?? defaultDb();
    const meter = createLlmCallMeter();
    const summary = await runWithLlmCallMeter(meter, () =>
      runCitationPanel({
        db,
        week: aiCitationWeekOf(now()),
        prompts,
        engines: active,
        caps: resolveAiCitationCaps(env),
        now,
        shouldPause: () => (aiCitationBlockedWindowAt(now()) ? "blocked_window" : null),
        deps: { env, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs },
      }),
    );
    const result = { ...summary, llmCalls: { ...meter.bySource } };
    if (summary.calls > 0 || summary.skippedCostCap > 0) {
      lastRun = {
        at: now().toISOString(),
        week: summary.week,
        calls: summary.calls,
        ok: summary.ok,
        errors: summary.errors,
        skipped_cost_cap: summary.skippedCostCap,
        cost_usd: Math.round(summary.costUsd * 1e6) / 1e6,
        stopped: summary.stopped,
        pending: summary.pending,
        llm_calls: result.llmCalls,
      };
      say(formatRunLine(result));
    }
    return result;
  } finally {
    running = false;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────

/**
 * Called once from src/index.ts. With the flag off it logs one line and schedules nothing.
 * Otherwise: first check after AI_CITATION_PANEL_BOOT_DELAY_MS, then every
 * AI_CITATION_PANEL_TICK_INTERVAL_MS, each after the boot jobs queued in the exclusive gate.
 */
export function startAiCitationPanelScheduler(opts: {
  getDb: () => Db;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  bootDelayMs?: number;
  intervalMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => any;
  setIntervalFn?: (fn: () => void, ms: number) => any;
  /** Tests: fetchImpl, now, timeoutMs, engines, prompts. */
  run?: Omit<AiCitationTickOptions, "db" | "env" | "log">;
}): { started: boolean; stop: () => void } {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  if (!isAiCitationPanelEnabled(env)) {
    log(`[ai-citations] disabled (${AI_CITATION_PANEL_FLAG} is not 1): no calls`);
    return { started: false, stop: () => {} };
  }
  const tick = () => {
    runExclusiveBootJob(() => undefined)
      .then(trackJob("ai-citation-panel", () => runAiCitationPanelTick({ ...opts.run, db: opts.getDb(), env, log })))
      .catch((err: any) => {
        console.error(
          `[ai-citations] run failed (non-fatal): ${err?.name ?? "Error"}: ${redactSecrets(String(err?.message ?? err), citationEngineKeys(env))}`,
        );
      });
  };
  const bootDelayMs = opts.bootDelayMs ?? AI_CITATION_PANEL_BOOT_DELAY_MS;
  const boot = (opts.setTimeoutFn ?? setTimeout)(tick, bootDelayMs);
  const interval = (opts.setIntervalFn ?? setInterval)(tick, opts.intervalMs ?? AI_CITATION_PANEL_TICK_INTERVAL_MS);
  boot?.unref?.();
  interval?.unref?.();
  schedulerStarted = true;
  const active = (opts.run?.engines ?? citationEnginesForView(env).engines).filter((e) => e.enabled(env)).map((e) => `${e.engine} (${e.model})`);
  log(`[ai-citations] on: first check in ${Math.round(bootDelayMs / 60_000)} min, then hourly; active engines: ${active.join(", ") || "none"}`);
  return {
    started: true,
    stop: () => {
      clearTimeout(boot);
      clearInterval(interval);
      schedulerStarted = false;
    },
  };
}

// ── Status ────────────────────────────────────────────────────────────

/**
 * GET /admin/analytics/ai-citations/status. Read-only, no network: the flag, the engines (model,
 * its prices and per-call bound as in config/ai-citation-panel.json, why the model cannot be
 * used if so, key set or not; never the key), the caps, the month's stored cost
 * (month_cost_usd) and what is left of it, the current week's stored results against
 * questions × active engines, the blocked windows and this process's last run. config_valid is
 * false when the questions or the engines block of the config are invalid.
 */
export function getAiCitationPanelStatus(opts: {
  db?: Db;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  engines?: readonly CitationEngine[];
  prompts?: readonly CitationPrompt[];
} = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const db = opts.db ?? defaultDb();
  const caps = resolveAiCitationCaps(env);
  const loaded = opts.engines ? { engines: opts.engines, configValid: true } : citationEnginesForView(env);
  const engines = loaded.engines.map((e) => ({
    engine: e.engine,
    model: e.model,
    model_env: e.modelEnv,
    model_error: e.model !== null ? null : loaded.configValid ? unpricedModel(e) : "config/ai-citation-panel.json is invalid",
    key_env: e.keyEnv,
    active: e.enabled(env),
    max_cost_usd_per_call: e.maxCostUsdPerCall,
    price: e.price ? { ...e.price } : null,
  }));
  let prompts: number | null = null;
  try {
    prompts = (opts.prompts ?? loadCitationPrompts()).length;
  } catch {
    /* config_valid: false below */
  }
  const week = aiCitationWeekOf(now);
  const weekTotals = aiCitationWeekTotals(db, week);
  const monthCost = aiCitationMonthCostUsd(db, now);
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    enabled: isAiCitationPanelEnabled(env),
    flag: AI_CITATION_PANEL_FLAG,
    scheduler_started: schedulerStarted,
    running,
    engines,
    caps: { per_run_usd: caps.perRunUsd, per_month_usd: caps.perMonthUsd },
    month: now.toISOString().slice(0, 7),
    month_cost_usd: round(monthCost),
    month_remaining_usd: round(Math.max(0, caps.perMonthUsd - monthCost)),
    month_cap_reached: monthCost >= caps.perMonthUsd,
    config_valid: prompts !== null && loaded.configValid,
    prompts,
    week,
    week_cost_usd: round(weekTotals.costUsd),
    week_results: weekTotals.results,
    week_expected: prompts === null ? null : prompts * engines.filter((e) => e.active).length,
    blocked_windows_utc: AI_CITATION_BLOCKED_WINDOWS_UTC.map((w) => `${w.from}-${w.to}`),
    blocked_now: aiCitationBlockedWindowAt(now),
    last_run: lastRun ? { ...lastRun, llm_calls: { ...lastRun.llm_calls } } : null,
  };
}

/** Test-only: reset module state. */
export function __resetAiCitationPanelForTesting(): void {
  running = false;
  schedulerStarted = false;
  lastRun = null;
  loggedInactive.clear();
}
