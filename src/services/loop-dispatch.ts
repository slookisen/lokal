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
 * Parse `DISPATCH_WINDOW_MIN` (dev-requests/2026-07-17-loop-dispatch-stall-hardening.md)
 * for planNow()'s candidate-freshness window. The pure default in computeWakeList stays
 * 12 for other callers/tests; the route now passes 45 so a next_suggested envelope
 * survives the 25-min cross-agent cooldown instead of expiring unfired (the 2026-07-16
 * 22:25Z event-wake deadlock) and a failed /fire gets retried on later ticks (the
 * 2026-07-17 09:40Z 401 outage burned its candidate after one attempt). Clamped to
 * [5, 55]: never below 5 (a window shorter than the ~10-min tick cadence re-creates
 * the expire-before-tick bug), never 56+ (planNow reads the ledger with sinceHours: 1,
 * so candidates older than ~an hour are invisible to the query — a wider window would
 * silently see nothing).
 */
export function resolveWindowMin(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 45;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 45;
  return Math.max(5, Math.min(55, n));
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

/**
 * Per-agent wake text (charter v2 2026-07-10, A2A dev-requests/2026-07-10-flaate-2-0-
 * consolidation.md): the previous one-size fire-text told EVERY woken agent to
 * "prioritize BUILDING dev-request slices first" — correct for the orchestrator,
 * nonsense for the verifier and controller, and the source of the supervisor's
 * improvised "verify-only fallback" cycles. Each agent is woken to do ITS OWN job.
 * Pure + exported so the texts are unit-testable.
 */
export function fireTextFor(agent: string, reason: string): string {
  const head = `Off-cycle wake by loop-dispatcher (${reason}; next_suggested=${agent}).`;
  const tail = `Still POST your run-envelope to /admin/runs at the end so this wake is visible in the run-ledger. One-time run.`;
  switch (agent) {
    case "platform-orchestrator":
      // Daniel's standing authorization, VERBATIM (given live in session 2026-07-23).
      // Fired sessions run with a branch-scoped git remote and — correctly — refuse to
      // treat repo-stored SKILL text as live consent for direct-to-main pushes; three
      // consecutive wakes 2026-07-23 0-built on exactly that. Carrying his sentence in
      // the fire payload delivers the consent live, in-context, on every wake.
      return `${head} Daniels stående autorisasjon for denne vekken: «Jeg, Daniel, autoriserer orchestrator-sesjoner fyrt av loop-dispatcheren til å bruke scripts/a2a-commit.sh (PAT-push til A2A main) for lease-claims, rapporter og dev-request-oppdateringer.» (gitt live i sesjon 2026-07-23). Prioritize BUILDING dev-request slices first (charter v2 Rule 0 — bygg først): pull the top unclaimed item, lease-claim it in the frontmatter, build. Housekeeping and full reports belong to the daily cycle only. ${tail}`;
    case "platform-verifier":
      return `${head} Probe the freshest pending deploy-claims against production (acceptance criteria live in the dev-request). On a failed probe: rollback first, investigate second (charter v2 §5). ${tail}`;
    case "orchestrator-v3-controller":
      return `${head} Run a scoped guardrail/error-budget pass over the suggesting run's outcome (controller/autonomy-policy.yaml error_budget) and handle any escalation it raised. Not a full daily cycle. ${tail}`;
    default:
      // Workers (rfb-customer-service, *-enrichment): remediation wake — continue the
      // charter job the suggesting run handed over.
      return `${head} Continue your own charter job that the suggesting run handed to you — this is a remediation wake, not a full scheduled cycle. ${tail}`;
  }
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
  // Self-continue breather (dev-requests/2026-07-09-self-continue-cooldown-carveout.md):
  // when a run suggests its OWN agent, `cooldownMin`'s 25-min anti-thrash window can
  // never be satisfied -- the candidate run itself is the newest entry for that agent,
  // so it is always "fresher" than cooldownMin. A fresh completion already proves the
  // agent is idle, so self-continues only need a short breather, not the cross-agent
  // anti-thrash cooldown. Default 3 min.
  selfContinueCooldownMin?: number;
  maxWakes?: number; // hard cap on wakes per cycle
  // Fireable set (dev-requests/2026-07-17-loop-dispatch-stall-hardening.md): the agents
  // the caller can actually /fire (FIRE_ROUTINES keys). Only wakes for THESE count
  // toward maxWakes — a wake for an allowlisted-but-routine-less agent (e.g.
  // platform-verifier) is always deferred downstream and spawns nothing, so letting it
  // consume the wake budget can starve the orchestrator behind a morning pileup of
  // worker→verifier suggestions. Omitted → all wakes count (previous behavior).
  fireable?: string[];
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
  // "rfb-supervisor" removed 2026-07-10 (charter v2, Daniel GO — A2A
  // dev-requests/2026-07-10-flaate-2-0-consolidation.md): the supervisor is a
  // 1x/day cron ops-run now, not a dispatcher-woken layer (~50% of its dispatcher
  // wakes were verify-only no-ops re-confirming what the merge gate + verifier
  // already prove). A next_suggested=["rfb-supervisor"] now simply skips on
  // allowlist — suggesting agents need no envelope change.
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
  // latestStart[agent] = newest started_at across ALL runs (incl. fire-markers, whose
  // started_at is the fire time). Used by the cross-agent consumed-guard below: a
  // target that STARTED a run after the suggesting run finished has consumed that
  // suggestion. started_at (not finished_at) so an in-flight run that merely
  // OVERLAPPED the suggestion — started before it was posted, finished just after —
  // does not falsely consume it (the 2026-07-16 22:25Z event-wake landed 3 min before
  // an already-running orchestrator cycle finished; that cycle never saw it).
  const latestStart = new Map<string, number>();
  for (const r of runs) {
    const t = Date.parse(r.finished_at || r.started_at);
    if (!Number.isNaN(t)) {
      const prev = latest.get(r.agent);
      if (prev === undefined || t > prev) latest.set(r.agent, t);
    }
    const s = Date.parse(r.started_at);
    if (!Number.isNaN(s)) {
      const prevS = latestStart.get(r.agent);
      if (prevS === undefined || s > prevS) latestStart.set(r.agent, s);
    }
  }

  const wake: WakeDecision[] = [];
  const skip: SkipDecision[] = [];
  const wokenThisCycle = new Set<string>();
  const fireableSet = opts.fireable === undefined ? null : new Set(opts.fireable);
  let fireableWakes = 0;
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
      const isSelfContinue = r.agent === a;

      if (isSelfContinue) {
        // `latest` is built from ALL runs including `r` itself, so `last` is only
        // STRICTLY newer than `finMs` when some OTHER run/fire-marker for this
        // agent landed after `r` finished -- i.e. the fleet already continued the
        // chain (no-double-fire invariant, same guarantee the fire-marker gives
        // cross-agent below). Equal timestamps mean `r` IS the newest entry for
        // its own agent, which is the normal self-continue case.
        if (last !== undefined && last > finMs) {
          skip.push({ agent: a, reason: `already continued (newer run for ${a} exists)` });
          continue;
        }
        const selfCooldownMin = opts.selfContinueCooldownMin ?? 3;
        if (ageMin < selfCooldownMin) {
          skip.push({
            agent: a,
            reason: `self-continue cooldown (${Math.floor(ageMin)}min ago < ${selfCooldownMin})`,
          });
          continue;
        }
      } else {
        // Cross-agent consumed-guard (dev-requests/2026-07-17-loop-dispatch-stall-
        // hardening.md): the target STARTED a run (or got a fire-marker — its
        // started_at is the fire time) after this suggestion was posted, so the
        // suggestion is already served. Required for the wider freshness window:
        // without it, a suggestion that outlives the cooldown would re-fire an
        // agent that already handled it.
        const lastStart = latestStart.get(a);
        if (lastStart !== undefined && lastStart >= finMs) {
          skip.push({ agent: a, reason: `consumed (${a} started a run after the suggestion)` });
          continue;
        }
        if (last !== undefined) {
          const sinceMin = Math.floor((opts.nowMs - last) / 60_000);
          if (sinceMin < cooldownMin) {
            skip.push({ agent: a, reason: `cooldown (ran ${sinceMin}min ago < ${cooldownMin})` });
            continue;
          }
        }
      }
      const countsTowardCap = fireableSet === null || fireableSet.has(a);
      if (countsTowardCap && fireableWakes >= maxWakes) {
        skip.push({ agent: a, reason: `max wakes (${maxWakes}) reached` });
        continue;
      }
      wake.push({ agent: a, reason: r.run_id });
      wokenThisCycle.add(a);
      if (countsTowardCap) fireableWakes++;
    }
  }

  return { now, inActiveWindow, candidates, wake, skip };
}
