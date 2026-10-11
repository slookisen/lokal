// ─── Lower the CPU priority of the calling worker thread ────────────────
// dev-request 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-samtaler
// (skive 6). Prod runs on one shared vCPU. Work moved off the main thread
// (stats aggregation, offsite backup copy and integrity check) still competes
// with it for that one core, and the stall log shows request handlers slowing
// to 1–5 s while those workers run. On Linux the nice value is a per-thread
// attribute and setpriority(PRIO_PROCESS, 0, …) applies to the calling thread
// only (verified: a worker calling os.setPriority(0, 10) leaves the main
// thread at 0), so a worker can step back without touching the main thread.
// Other platforms apply it to the whole process, so it is Linux-only.
// Raising the nice value needs no privileges. Pure module: safe to import in
// worker threads.

import * as os from "os";

/** Nice value for background worker threads (0 = normal, 19 = lowest). */
export const WORKER_THREAD_NICE = 10;

/**
 * Lowers the calling thread's scheduling priority. Call it at the top of a
 * worker thread, never on the main thread. Returns the resulting nice value,
 * or null when nothing was changed (not Linux, disabled, or the call failed).
 */
export function lowerCurrentThreadPriority(
  nice: number = WORKER_THREAD_NICE,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; setPriority?: (pid: number, prio: number) => void; getPriority?: (pid: number) => number } = {}
): number | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== "linux") return null;
  if (env.WORKER_THREAD_NICE_DISABLED === "1") return null;
  const setPriority = opts.setPriority ?? ((pid: number, prio: number) => os.setPriority(pid, prio));
  const getPriority = opts.getPriority ?? ((pid: number) => os.getPriority(pid));
  try {
    setPriority(0, Math.max(0, Math.min(19, Math.trunc(nice))));
    return getPriority(0);
  } catch {
    return null;
  }
}
