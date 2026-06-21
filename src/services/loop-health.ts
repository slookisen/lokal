// ─── Loop-health (pure) ─────────────────────────────────────────
// Phase P1 (server-migration plan 2026-06-20). Pure liveness logic for the
// autonomous control loop: given recent run-envelopes and a clock, decide
// whether the loop is alive, stalled, or paused-overnight. NO imports of
// DB / email / express — fully deterministic and unit-testable. The HTTP
// route (routes/admin-loop-heartbeat.ts) is a thin wrapper over this.

/** Minimal shape we need from a run-ledger record. `RunRecord` satisfies it. */
export interface RunLite {
  agent: string;
  started_at: string;
  finished_at?: string | null;
}

/** An agent that, during active hours, must have run within `maxSilenceMin`. */
export interface Watcher {
  agent: string;
  maxSilenceMin: number;
}

/** Default canaries for "is the whole loop turning over". */
export const DEFAULT_WATCHERS: Watcher[] = [
  { agent: "loop-dispatcher", maxSilenceMin: 40 }, // ~10-min cadence → 4 missed = dead
  { agent: "platform-verifier", maxSilenceMin: 90 }, // ~15-min cadence → secondary canary
];

export interface WatcherStatus {
  agent: string;
  maxSilenceMin: number;
  lastRunAt: string | null;
  ageMin: number | null; // null = no run within the read window
  stalled: boolean;
}

export interface LoopHealth {
  status: "healthy" | "stalled" | "paused";
  inActiveWindow: boolean;
  now: string;
  watchers: WatcherStatus[];
  stalledAgents: string[];
}

export interface LoopHealthOpts {
  nowMs: number;
  watchers?: Watcher[];
  activeStartUTC?: number; // inclusive hour, default 5  (~06:00 Europe/Oslo)
  activeEndUTC?: number; // exclusive hour, default 21 (~22:00 Europe/Oslo)
}

/**
 * Compute loop health from recent runs + a clock. Pure: no DB and no
 * `Date.now()` (the caller passes `nowMs`), so it is deterministic and
 * unit-testable.
 *
 * A watcher is "stalled" only when we are INSIDE the active window AND its
 * newest run is older than `maxSilenceMin` (or absent). Outside the window the
 * loop legitimately pauses overnight, so status is "paused" and never alerts.
 */
export function computeLoopHealth(
  runs: ReadonlyArray<RunLite>,
  opts: LoopHealthOpts,
): LoopHealth {
  const watchers = opts.watchers ?? DEFAULT_WATCHERS;
  const startH = opts.activeStartUTC ?? 5;
  const endH = opts.activeEndUTC ?? 21;
  const hourUTC = new Date(opts.nowMs).getUTCHours();
  const inActiveWindow =
    startH <= endH
      ? hourUTC >= startH && hourUTC < endH
      : hourUTC >= startH || hourUTC < endH; // wrap-around safety

  // newest finished_at (fallback started_at) per agent
  const latest = new Map<string, number>();
  for (const r of runs) {
    const t = Date.parse(r.finished_at || r.started_at);
    if (Number.isNaN(t)) continue;
    const prev = latest.get(r.agent);
    if (prev === undefined || t > prev) latest.set(r.agent, t);
  }

  const watcherStatuses: WatcherStatus[] = watchers.map((w) => {
    const last = latest.get(w.agent);
    const ageMin =
      last === undefined ? null : Math.floor((opts.nowMs - last) / 60_000);
    const stalled =
      inActiveWindow && (ageMin === null || ageMin > w.maxSilenceMin);
    return {
      agent: w.agent,
      maxSilenceMin: w.maxSilenceMin,
      lastRunAt: last === undefined ? null : new Date(last).toISOString(),
      ageMin,
      stalled,
    };
  });

  const stalledAgents = watcherStatuses
    .filter((w) => w.stalled)
    .map((w) => w.agent);
  const status: LoopHealth["status"] = !inActiveWindow
    ? "paused"
    : stalledAgents.length > 0
      ? "stalled"
      : "healthy";

  return {
    status,
    inActiveWindow,
    now: new Date(opts.nowMs).toISOString(),
    watchers: watcherStatuses,
    stalledAgents,
  };
}
