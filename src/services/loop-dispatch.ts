// ─── Loop-dispatch (pure) ───────────────────────────────────────
// P2.5 (server-migration plan 2026-06-20; A2A/protocols/p25-loop-dispatcher-fire).
// Pure "who should wake whom" logic for the autonomous control loop, ported
// verbatim from the Cowork dispatcher SKILL (A2A/scheduled-agents/loop-dispatcher.md):
// consume `next_suggested` from recently-finished runs and decide the wake-list,
// bounded by allowlist + per-agent cooldown + freshness window + max-wakes +
// one-wake-per-agent-per-cycle. NO DB / fetch / express and NO `Date.now()` (the
// caller passes `nowMs`), so it is deterministic and unit-testable. The HTTP route
// (routes/admin-loop-dispatch.ts) is a thin wrapper that reads the ledger, calls
// this, and POSTs the routine `/fire` API for each woken agent that has a routine.

/**
 * Parse an active-window-hour env var (`DISPATCH_ACTIVE_START_UTC` /
 * `DISPATCH_ACTIVE_END_UTC`), falling back to `fallback` on missing, empty-string
 * (`""` is a common Fly.io/CI unset-but-present footgun -- NOT caught by `??`), or
 * non-numeric input. Clamped to `[0, 24]` since it feeds an hour-of-day comparison.
 * Pure + exported so `planNow()`'s env-parsing is unit-testable without a DB.
 */
export function resolveActiveWindowHour(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(24, n));
}

/**
 * Parse `DISPATCH_TICK_INTERVAL_MIN` (dev-requests/2026-07-09-loop-dispatch-self-tick.md)
 * for the in-process dispatcher self-tick in src/index.ts. Missing / empty-string /
 * non-numeric input falls back to 10 (the design cadence from admin-loop-dispatch.ts's
 * "every ~10 min" header). Numeric input is clamped to [2, 120]: never faster than
 * 2 min (the tick is "knock on the door", not "spawn" — but a sub-minute loop would
 * still hammer the ledger query), never slower than 120 min (beyond that the 12-min
 * next_suggested freshness window makes the tick pointless — the very bug this fixes).
 * Pure + exported so index.ts's env-parsing is unit-testable, mirroring
 * resolveActiveWindowHour above.
 */
export function resolveTickIntervalMin(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 10;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 10;
  return Math.max(2, Math.min(120, n));
}

/** Minimal shape we need from a run-ledger record. `RunRecord` satisfies it. */
export interface DispatchRunLite {
  run_id: string;
  agent: string;
  started_at: string;
  finished_at?: string | null;
  next_suggested?: string[] | null;
}

export interface DispatchOpts {
  nowMs: number;
  allowlist?: string[];
  windowMin?: number; // candidate freshness (a run is fresh if it finished within this)
  cooldownMin?: number; // a target that ran within this is skipped
  maxWakes?: number; // hard cap on wakes per cycle
  activeStartUTC?: number; // inclusive hour, default 5  (~06:00 Europe/Oslo)
  activeEndUTC?: number; // exclusive hour, default 21 (~22:00 Europe/Oslo)
}

export interface WakeDecision {
  agent: string;
  reason: string; // the run_id whose next_suggested asked for this wake
}

export interface SkipDecision {
  agent: string;
  reason: string;
}

export interface DispatchPlan {
  now: string;
  inActiveWindow: boolean;
  candidates: number; // count of fresh runs with a non-empty next_suggested
  wake: WakeDecision[];
  skip: SkipDecision[];
}

/**
 * The only agents the dispatcher may ever wake. The control plane (first 4) may be
 * woken by any agent's `next_suggested`. The three workers below were added so
 * remediation can wake the worker directly instead of waiting on its own cron
 * (`dev-requests/2026-07-01-loop-reliability-backend.md` item 5, "Worker-fireability").
 * Workers share the same generic cooldown/window rate-limits as the control plane —
 * no separate mechanism. Discipline (enforced in each worker's own SKILL, not here):
 * a worker's `next_suggested` may only name a control-plane agent, never another
 * worker — this allowlist governs who may be a wake *target*, not what a woken
 * worker itself may emit, so it does not by itself prevent a worker→worker loop.
 */
export const DEFAULT_ALLOWLIST: string[] = [
  "platform-orchestrator",
  "orchestrator-v3-controller",
  "rfb-supervisor",
  "platform-verifier",
  "rfb-customer-service",
  "lokal-agent-enrichment",
  "experiences-enrichment",
];

/**
 * Decide the wake-list from recent runs + a clock. Pure: no DB, no fetch, no
 * `Date.now()`. Mirrors `computeLoopHealth`'s style.
 *
 * Outside the active window the loop legitimately pauses overnight, so the plan
 * is empty (nothing is woken) — same gate the Cowork dispatcher's cron enforces
 * by simply not running 22:00–06:00.
 */
export function computeWakeList(
  runs: ReadonlyArray<DispatchRunLite>,
  opts: DispatchOpts,
): DispatchPlan {
  const allowlist = new Set(opts.allowlist ?? DEFAULT_ALLOWLIST);
  const windowMin = opts.windowMin ?? 12;
  const cooldownMin = opts.cooldownMin ?? 25;
  const maxWakes = opts.maxWakes ?? 4;
  const startH = opts.activeStartUTC ?? 5;
  const endH = opts.activeEndUTC ?? 21;
  const hourUTC = new Date(opts.nowMs).getUTCHours();
  const inActiveWindow =
    startH <= endH
      ? hourUTC >= startH && hourUTC < endH
      : hourUTC >= startH || hourUTC < endH; // wrap-around safety
  const now = new Date(opts.nowMs).toISOString();

  if (!inActiveWindow) {
    return { now, inActiveWindow, candidates: 0, wake: [], skip: [] };
  }

  // lastRunAt[agent] = newest finished_at (fallback started_at) across ALL runs.
  const latest = new Map<string, number>();
  for (const r of runs) {
    const t = Date.parse(r.finished_at || r.started_at);
    if (Number.isNaN(t)) continue;
    const prev = latest.get(r.agent);
    if (prev === undefined || t > prev) latest.set(r.agent, t);
  }

  const wake: WakeDecision[] = [];
  const skip: SkipDecision[] = [];
  const wokenThisCycle = new Set<string>();
  let candidates = 0;

  for (const r of runs) {
    const finMs = Date.parse(r.finished_at || r.started_at);
    if (Number.isNaN(finMs)) continue;
    const ageMin = (opts.nowMs - finMs) / 60_000;
    if (ageMin < 0 || ageMin > windowMin) continue; // not a fresh run
    const suggested = r.next_suggested ?? [];
    if (suggested.length === 0) continue;
    candidates++;

    for (const a of suggested) {
      if (wokenThisCycle.has(a)) continue; // one wake per agent per cycle
      if (!allowlist.has(a)) {
        skip.push({ agent: a, reason: "not in allowlist" });
        continue;
      }
      const last = latest.get(a);
      if (last !== undefined) {
        const sinceMin = Math.floor((opts.nowMs - last) / 60_000);
        if (sinceMin < cooldownMin) {
          skip.push({ agent: a, reason: `cooldown (ran ${sinceMin}min ago < ${cooldownMin})` });
          continue;
        }
      }
      if (wake.length >= maxWakes) {
        skip.push({ agent: a, reason: `max wakes (${maxWakes}) reached` });
        continue;
      }
      wake.push({ agent: a, reason: r.run_id });
      wokenThisCycle.add(a);
    }
  }

  return { now, inActiveWindow, candidates, wake, skip };
}
