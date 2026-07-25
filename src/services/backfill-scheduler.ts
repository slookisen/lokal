// ─── Adaptive backfill scheduler ────────────────────────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1a
// throughput follow-up.
//
// THE PROBLEM THIS REPLACES
// ─────────────────────────
// Both RFB backfill workers were registered in src/index.ts as
// `setTimeout(bootTick, 30s)` + `setInterval(tick, 1h)`, 50 rows per tick.
// Measured against live prod 2026-07-25T22:17Z: 1 022 rows pending on the
// geocode queue ⇒ 1022/50 ≈ 20.4 HOURS of wall clock, while a dry-run probe
// resolved «Matgalleriet Molde» → address/high in 432 ms. The API was never
// the bottleneck; the CADENCE was. Daniel, watching the queue, saw the numbers
// not move at all across three minutes and asked for a fix.
//
// A fixed hourly interval is the wrong shape for a backfill: it is far too slow
// while there is a backlog and it keeps waking up forever after the backlog is
// gone. What a backfill wants is "go fast while there is work, go quiet when
// there is not", which is what this does.
//
// THE SHAPE
// ─────────
// A self-rescheduling setTimeout chain (NOT setInterval): the next delay is
// chosen AFTER each tick from the queue's own state, and a tick can never
// overlap its successor no matter how long it runs. Delay is `backlogDelayMs`
// while `hasBacklog()` is true and `idleDelayMs` once it is false, so the
// cadence decays to the old hourly heartbeat by itself with no flag to unset.
//
// THE INVARIANT THAT MATTERS
// ──────────────────────────
// ALWAYS RESCHEDULE — including from the error path. This is the scheduler-level
// twin of the ALWAYS-STAMP invariant the two workers took three review blockers
// for this evening: a worker whose failure path does not write re-picks the same
// batch forever, and a SCHEDULER whose failure path does not re-arm simply stops
// forever, silently, with the queue frozen mid-drain and no log line that says
// so. The rearm therefore lives in a `finally` that wraps both the tick AND the
// hasBacklog() probe (a throw from the probe — getDb() during a restart, say —
// must not be able to kill the chain either), and the delay falls back to the
// idle cadence when the probe is what threw.
//
// Timers are injected so tests drive the chain synchronously instead of waiting
// on wall clock.

export type BackfillSchedulerDeps = {
  /** Log/metric prefix, e.g. "agents-geocode". */
  label: string;
  /** One unit of work. May throw; the chain survives. */
  runTick: () => Promise<void>;
  /** True while rows remain that the worker could still act on. May throw. */
  hasBacklog: () => boolean;
  /** Delay between ticks while a backlog exists. */
  backlogDelayMs: number;
  /** Delay between ticks once the queue is drained. */
  idleDelayMs: number;
  /** Delay before the very first tick after boot. */
  bootDelayMs: number;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (handle: any) => void;
  log?: (msg: string) => void;
};

export type BackfillSchedulerHandle = {
  stop(): void;
  /** Delay chosen for the pending timer — exposed for tests and for logging. */
  currentDelayMs(): number;
};

/**
 * Pure cadence decision, extracted so it can be asserted without timers.
 * Kept trivially small on purpose: everything interesting about this module is
 * the rescheduling invariant, not the arithmetic.
 */
export function nextBackfillDelayMs(
  hasBacklog: boolean,
  backlogDelayMs: number,
  idleDelayMs: number
): number {
  return hasBacklog ? backlogDelayMs : idleDelayMs;
}

export function startBackfillScheduler(deps: BackfillSchedulerDeps): BackfillSchedulerHandle {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: any) => clearTimeout(h));
  const log = deps.log ?? ((m: string) => console.log(m));

  let stopped = false;
  let handle: any = null;
  let delayMs = deps.bootDelayMs;

  const arm = (ms: number) => {
    if (stopped) return;
    delayMs = ms;
    handle = setTimer(() => { void cycle(); }, ms);
  };

  const cycle = async (): Promise<void> => {
    if (stopped) return;
    let next = deps.idleDelayMs;
    try {
      await deps.runTick();
    } catch (err) {
      // A failed tick is a reason to slow down, never a reason to stop.
      console.error(`[${deps.label}] tick failed:`, err);
    } finally {
      try {
        next = nextBackfillDelayMs(deps.hasBacklog(), deps.backlogDelayMs, deps.idleDelayMs);
      } catch (err) {
        // The backlog probe itself failed (DB mid-restart, schema not ready).
        // Fall back to the SLOW cadence: unknown state must not become a hot
        // loop against a free public API.
        console.error(`[${deps.label}] backlog probe failed, falling back to the idle cadence:`, err);
        next = deps.idleDelayMs;
      }
      if (!stopped) {
        if (next !== delayMs) {
          log(`[${deps.label}] cadence → ${Math.round(next / 1000)}s (backlog ${next === deps.backlogDelayMs ? "present" : "drained"})`);
        }
        arm(next);
      }
    }
  };

  arm(deps.bootDelayMs);

  return {
    stop() {
      stopped = true;
      if (handle !== null) clearTimer(handle);
      handle = null;
    },
    currentDelayMs() {
      return delayMs;
    },
  };
}
