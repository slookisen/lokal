/**
 * profile-translations-worker.ts — dev-request
 * 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent, Daniel GO #1
 * (2026-09-02, live): «jobbe kraftig gjennom de neste 12 timene og komme seg
 * gjennom så mye som mulig … etter 12 timer, om det fortsatt er jobb å gjøre,
 * må det gå i mindre puljer pga usage».
 *
 * An in-process worker (same shape as the VERIFIER_SCHEDULER_ENABLED block in
 * src/index.ts) that drives the translation belt continuously instead of
 * relying on a once-a-day Cloud Routine call. Two modes, read fresh from env
 * on every tick so a fly.toml flip takes effect without a code change:
 *
 *   intensive — while now < PROFILE_TRANSLATIONS_WORKER_INTENSIVE_UNTIL (ISO
 *               timestamp): items are processed back-to-back with
 *               PROFILE_TRANSLATIONS_WORKER_INTENSIVE_CONCURRENCY parallel
 *               belts (default 5) for up to ~55 min per tick, then the next
 *               tick continues. Both platforms are interleaved round-robin so
 *               neither starves the other.
 *   steady    — after that timestamp (or when it is unset): at most
 *               PROFILE_TRANSLATIONS_WORKER_STEADY_ITEMS_PER_HOUR items per
 *               rolling hour (default 20), sequentially.
 *
 * Gates, all fail-safe (anything but the exact value = off):
 *   PROFILE_TRANSLATIONS_WORKER_ENABLED === "true"  — starts the interval
 *   PROFILE_TRANSLATIONS_ENABLED === "true"         — the pipeline's own LLM
 *     switch; the worker is a pure no-op while it is off (checked per tick).
 *
 * Safety:
 *   - single-flight: one batch at a time, and the admin route's
 *     POST /admin/profile-translations/run (dry_run:false) shares the same
 *     lock (409 "busy" while the worker holds it) so an item is never handed
 *     to two belts at once.
 *   - infrastructure failures (missing ANTHROPIC_API_KEY, network, 4xx) stop
 *     the batch and back the worker off for 15 minutes instead of burning
 *     every item's attempt budget.
 *   - never publishes, never serves, never touches Norwegian columns — it
 *     only calls processTranslationItem(), same as the admin route.
 *   - never throws out of the interval; last error is kept in state and
 *     exposed via GET /admin/profile-translations/status.
 */

import { getDb as getRfbDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import {
  TRANSLATION_PLATFORMS,
  TRANSLATION_TARGET_LANGS,
  type TranslationPlatform,
  type TranslationTargetLang,
  type PlannedItem,
  type ItemResult,
  isProfileTranslationPipelineEnabled,
  planTranslationBatch,
  processTranslationItem,
  type LlmDeps,
} from "./profile-translations";

// ─── Config (env, read fresh) ────────────────────────────────────────────

export interface WorkerConfig {
  enabled: boolean;
  intensiveUntil: Date | null;
  intensiveConcurrency: number;
  steadyItemsPerHour: number;
  platforms: TranslationPlatform[];
  /** Language priority (Daniel 2026-09-02: «engelsk er prio»): every actionable
   *  item of the first language — across both platforms — is processed before
   *  any item of the next. Default "en,sv". A language left out of the list is
   *  never processed by the worker. */
  langPriority: TranslationTargetLang[];
}

export const WORKER_DEFAULT_INTENSIVE_CONCURRENCY = 5;
export const WORKER_MAX_INTENSIVE_CONCURRENCY = 8;
export const WORKER_DEFAULT_STEADY_ITEMS_PER_HOUR = 20;
export const WORKER_MAX_STEADY_ITEMS_PER_HOUR = 200;
/** Intensive mode releases the lock after this long so a stuck LLM call can
 *  never wedge the belt for a whole night; the next tick simply continues. */
export const WORKER_INTENSIVE_TICK_BUDGET_MS = 55 * 60_000;
export const WORKER_INFRA_BACKOFF_MS = 15 * 60_000;
export const WORKER_TICK_INTERVAL_MS = 60_000;

export function isProfileTranslationWorkerEnabled(): boolean {
  return process.env.PROFILE_TRANSLATIONS_WORKER_ENABLED === "true";
}

function intFromEnv(name: string, def: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

export function readWorkerConfig(): WorkerConfig {
  const untilRaw = (process.env.PROFILE_TRANSLATIONS_WORKER_INTENSIVE_UNTIL || "").trim();
  const until = untilRaw ? new Date(untilRaw) : null;
  const platformsRaw = (process.env.PROFILE_TRANSLATIONS_WORKER_PLATFORMS || "").trim();
  const platforms = platformsRaw
    ? (platformsRaw.split(",").map((s) => s.trim()).filter((p) => (TRANSLATION_PLATFORMS as string[]).includes(p)) as TranslationPlatform[])
    : [...TRANSLATION_PLATFORMS];
  const langRaw = (process.env.PROFILE_TRANSLATIONS_WORKER_LANG_PRIORITY || "").trim();
  const langPriority = langRaw
    ? (Array.from(new Set(langRaw.split(",").map((s) => s.trim()).filter((l) => (TRANSLATION_TARGET_LANGS as string[]).includes(l)))) as TranslationTargetLang[])
    : [...TRANSLATION_TARGET_LANGS];
  return {
    enabled: isProfileTranslationWorkerEnabled(),
    intensiveUntil: until && !Number.isNaN(until.getTime()) ? until : null,
    intensiveConcurrency: intFromEnv("PROFILE_TRANSLATIONS_WORKER_INTENSIVE_CONCURRENCY", WORKER_DEFAULT_INTENSIVE_CONCURRENCY, WORKER_MAX_INTENSIVE_CONCURRENCY),
    steadyItemsPerHour: intFromEnv("PROFILE_TRANSLATIONS_WORKER_STEADY_ITEMS_PER_HOUR", WORKER_DEFAULT_STEADY_ITEMS_PER_HOUR, WORKER_MAX_STEADY_ITEMS_PER_HOUR),
    platforms: platforms.length ? platforms : [...TRANSLATION_PLATFORMS],
    langPriority: langPriority.length ? langPriority : [...TRANSLATION_TARGET_LANGS],
  };
}

export type WorkerMode = "off" | "pipeline_off" | "intensive" | "steady" | "backoff";

export function workerModeFor(cfg: WorkerConfig, now: Date): "intensive" | "steady" {
  return cfg.intensiveUntil && now.getTime() < cfg.intensiveUntil.getTime() ? "intensive" : "steady";
}

// ─── Shared run lock (worker ↔ admin route) ──────────────────────────────

const runLock: { holder: string | null; since: string | null } = { holder: null, since: null };

export function tryAcquireTranslationRunLock(holder: string): boolean {
  if (runLock.holder) return false;
  runLock.holder = holder;
  runLock.since = new Date().toISOString();
  return true;
}
export function releaseTranslationRunLock(holder: string): void {
  if (runLock.holder === holder) {
    runLock.holder = null;
    runLock.since = null;
  }
}
export function translationRunLockState(): { holder: string | null; since: string | null } {
  return { ...runLock };
}

// ─── State (in-memory, exposed on /status) ───────────────────────────────

export interface WorkerState {
  started: boolean;
  mode: WorkerMode;
  last_tick_at: string | null;
  last_batch_at: string | null;
  last_error: string | null;
  backoff_until: string | null;
  hour_window_start: string | null;
  hour_count: number;
  totals: Record<string, number>;
  total_items: number;
  total_usage: { input_tokens: number; output_tokens: number; calls: number };
  per_platform: Record<string, { items: number; verified: number; remaining_estimate: number | null }>;
}

const state: WorkerState = {
  started: false,
  mode: "off",
  last_tick_at: null,
  last_batch_at: null,
  last_error: null,
  backoff_until: null,
  hour_window_start: null,
  hour_count: 0,
  totals: {},
  total_items: 0,
  total_usage: { input_tokens: 0, output_tokens: 0, calls: 0 },
  per_platform: {},
};

export function getWorkerState(): WorkerState & { config: Omit<WorkerConfig, "intensiveUntil"> & { intensiveUntil: string | null }; lock: ReturnType<typeof translationRunLockState> } {
  const cfg = readWorkerConfig();
  return {
    ...state,
    totals: { ...state.totals },
    total_usage: { ...state.total_usage },
    per_platform: JSON.parse(JSON.stringify(state.per_platform)),
    config: { ...cfg, intensiveUntil: cfg.intensiveUntil ? cfg.intensiveUntil.toISOString() : null },
    lock: translationRunLockState(),
  };
}

/** Test helper — resets the in-memory state and lock. */
export function __resetWorkerStateForTesting(): void {
  state.started = false;
  state.mode = "off";
  state.last_tick_at = null;
  state.last_batch_at = null;
  state.last_error = null;
  state.backoff_until = null;
  state.hour_window_start = null;
  state.hour_count = 0;
  state.totals = {};
  state.total_items = 0;
  state.total_usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  state.per_platform = {};
  runLock.holder = null;
  runLock.since = null;
}

// ─── Planning across platforms ───────────────────────────────────────────

export interface WorkerDeps extends LlmDeps {
  now?: () => Date;
  dbFor?: (platform: TranslationPlatform) => any;
}

function defaultDbFor(platform: TranslationPlatform) {
  return platform === "rfb" ? getRfbDb() : getVerticalDb("experiences");
}

/** Plan up to `n` items: languages strictly in priority order (all `en`
 *  before any `sv` by default), and within a language the platforms are
 *  interleaved (rfb, opplevagent, rfb, …) so neither starves the other.
 *  Also records each platform's remaining estimate (all languages). */
export function planInterleaved(
  platforms: TranslationPlatform[],
  n: number,
  dbFor: (p: TranslationPlatform) => any,
  langPriority: TranslationTargetLang[] = [...TRANSLATION_TARGET_LANGS],
): Array<{ platform: TranslationPlatform; item: PlannedItem }> {
  const out: Array<{ platform: TranslationPlatform; item: PlannedItem }> = [];
  const remainingByPlatform: Record<string, number> = {};
  for (const lang of langPriority) {
    if (out.length >= n) break;
    const perPlatform: Array<{ platform: TranslationPlatform; items: PlannedItem[] }> = [];
    for (const platform of platforms) {
      try {
        const plan = planTranslationBatch(dbFor(platform), platform, [lang], n);
        perPlatform.push({ platform, items: plan.actionable });
        remainingByPlatform[platform] = (remainingByPlatform[platform] || 0) + plan.actionable.length + plan.remaining_actionable;
      } catch (e: any) {
        state.last_error = `plan ${platform}/${lang}: ${String(e?.message || e)}`;
        perPlatform.push({ platform, items: [] });
      }
    }
    let i = 0;
    while (out.length < n) {
      let any = false;
      for (const p of perPlatform) {
        if (i < p.items.length) {
          out.push({ platform: p.platform, item: p.items[i] });
          any = true;
          if (out.length >= n) break;
        }
      }
      if (!any) break;
      i++;
    }
  }
  for (const platform of platforms) {
    const pp = (state.per_platform[platform] = state.per_platform[platform] || { items: 0, verified: 0, remaining_estimate: null });
    pp.remaining_estimate = remainingByPlatform[platform] || 0;
  }
  return out;
}

const INFRA_RE = /ANTHROPIC_API_KEY|nettverksfeil|status 4\d\d/;

function recordResult(platform: TranslationPlatform, r: ItemResult): void {
  state.totals[r.outcome] = (state.totals[r.outcome] || 0) + 1;
  state.total_items++;
  state.total_usage.input_tokens += r.usage.input_tokens;
  state.total_usage.output_tokens += r.usage.output_tokens;
  state.total_usage.calls += r.usage.calls;
  const pp = (state.per_platform[platform] = state.per_platform[platform] || { items: 0, verified: 0, remaining_estimate: null });
  pp.items++;
  if (r.outcome === "verified") pp.verified++;
}

/** Process `items` with at most `concurrency` in flight. Returns true when an
 *  infrastructure failure was seen (caller backs off). */
async function processPool(
  items: Array<{ platform: TranslationPlatform; item: PlannedItem }>,
  concurrency: number,
  batchId: string,
  deps: WorkerDeps,
  dbFor: (p: TranslationPlatform) => any,
): Promise<{ processed: number; infra: boolean }> {
  let idx = 0;
  let processed = 0;
  let infra = false;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (!infra) {
      const my = idx++;
      if (my >= items.length) return;
      const { platform, item } = items[my];
      try {
        const r = await processTranslationItem(dbFor(platform), platform, item, batchId, deps);
        recordResult(platform, r);
        processed++;
        if (r.outcome === "translate_failed" && INFRA_RE.test(r.reason || "")) {
          infra = true;
          state.last_error = `infra: ${r.reason}`;
        }
      } catch (e: any) {
        state.last_error = `item ${platform}/${item.item.entity_id}/${item.item.field}/${item.lang}: ${String(e?.message || e)}`;
      }
    }
  });
  await Promise.all(workers);
  return { processed, infra };
}

// ─── One tick ────────────────────────────────────────────────────────────

export interface TickResult {
  mode: WorkerMode;
  processed: number;
  batches: number;
  skipped_reason?: string;
}

export async function workerTick(deps: WorkerDeps = {}): Promise<TickResult> {
  const now = deps.now ?? (() => new Date());
  const dbFor = deps.dbFor ?? defaultDbFor;
  const cfg = readWorkerConfig();
  const t0 = now();
  state.last_tick_at = t0.toISOString();

  if (!isProfileTranslationPipelineEnabled()) {
    state.mode = "pipeline_off";
    return { mode: "pipeline_off", processed: 0, batches: 0, skipped_reason: "PROFILE_TRANSLATIONS_ENABLED is not 'true'" };
  }
  if (state.backoff_until && t0.getTime() < new Date(state.backoff_until).getTime()) {
    state.mode = "backoff";
    return { mode: "backoff", processed: 0, batches: 0, skipped_reason: `backoff until ${state.backoff_until}` };
  }
  state.backoff_until = null;
  if (!tryAcquireTranslationRunLock("worker")) {
    return { mode: state.mode, processed: 0, batches: 0, skipped_reason: `lock held by ${runLock.holder}` };
  }

  const mode = workerModeFor(cfg, t0);
  state.mode = mode;
  let processed = 0;
  let batches = 0;
  try {
    if (mode === "intensive") {
      const batchSize = cfg.intensiveConcurrency * 2;
      while (true) {
        const nowT = now();
        if (nowT.getTime() - t0.getTime() > WORKER_INTENSIVE_TICK_BUDGET_MS) break;
        if (workerModeFor(cfg, nowT) !== "intensive") break;
        const items = planInterleaved(cfg.platforms, batchSize, dbFor, cfg.langPriority);
        if (!items.length) break;
        const batchId = `wk-int-${nowT.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
        const r = await processPool(items, cfg.intensiveConcurrency, batchId, deps, dbFor);
        processed += r.processed;
        batches++;
        state.last_batch_at = now().toISOString();
        if (r.infra) {
          state.backoff_until = new Date(now().getTime() + WORKER_INFRA_BACKOFF_MS).toISOString();
          break;
        }
        // A batch that processed nothing (every item threw) must not spin.
        if (r.processed === 0) break;
      }
    } else {
      // steady: rolling-hour budget
      const windowStart = state.hour_window_start ? new Date(state.hour_window_start) : null;
      if (!windowStart || t0.getTime() - windowStart.getTime() >= 60 * 60_000) {
        state.hour_window_start = t0.toISOString();
        state.hour_count = 0;
      }
      const allow = cfg.steadyItemsPerHour - state.hour_count;
      if (allow > 0) {
        const items = planInterleaved(cfg.platforms, Math.min(allow, 5), dbFor, cfg.langPriority);
        if (items.length) {
          const batchId = `wk-std-${t0.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
          const r = await processPool(items, 1, batchId, deps, dbFor);
          processed += r.processed;
          batches++;
          state.hour_count += r.processed;
          state.last_batch_at = now().toISOString();
          if (r.infra) state.backoff_until = new Date(now().getTime() + WORKER_INFRA_BACKOFF_MS).toISOString();
        }
      }
    }
  } catch (e: any) {
    state.last_error = String(e?.message || e);
  } finally {
    releaseTranslationRunLock("worker");
  }
  return { mode, processed, batches };
}

// ─── Bootstrap (called from src/index.ts) ────────────────────────────────

export function startProfileTranslationsWorker(): NodeJS.Timeout | null {
  if (!isProfileTranslationWorkerEnabled()) return null;
  state.started = true;
  const cfg = readWorkerConfig();
  console.log(
    `[profile-translations-worker] started — intensive_until=${cfg.intensiveUntil ? cfg.intensiveUntil.toISOString() : "(unset)"} ` +
    `concurrency=${cfg.intensiveConcurrency} steady=${cfg.steadyItemsPerHour}/h platforms=${cfg.platforms.join(",")} lang_priority=${cfg.langPriority.join(">")}`,
  );
  const timer = setInterval(async () => {
    try {
      const r = await workerTick();
      if (r.processed > 0 || r.skipped_reason) {
        console.log(`[profile-translations-worker] mode=${r.mode} processed=${r.processed} batches=${r.batches}${r.skipped_reason ? " skipped=" + r.skipped_reason : ""}`);
      }
    } catch (err) {
      console.error("[profile-translations-worker] tick failed:", err);
    }
  }, WORKER_TICK_INTERVAL_MS);
  // First tick shortly after boot so a flag flip + deploy starts working
  // within a minute instead of waiting for the first interval.
  setTimeout(() => { void workerTick().catch(() => { /* logged in state */ }); }, 5_000);
  return timer;
}
