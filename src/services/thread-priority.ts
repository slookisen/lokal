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

import * as fs from "fs";
import * as os from "os";
import { isMainThread } from "worker_threads";

/** Nice value for background worker threads (0 = normal, 19 = lowest). */
export const WORKER_THREAD_NICE = 10;

/**
 * Lowers the calling thread's scheduling priority. Call it at the top of a
 * worker thread, never on the main thread. Returns the resulting nice value,
 * or null when nothing was changed (not Linux, disabled, or the call failed).
 */
export function lowerCurrentThreadPriority(
  nice: number = WORKER_THREAD_NICE,
  opts: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    isMainThread?: boolean;
    setPriority?: (pid: number, prio: number) => void;
    getPriority?: (pid: number) => number;
  } = {}
): number | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  // Never on the main thread: that is the thread this whole exercise protects.
  if (opts.isMainThread ?? isMainThread) return null;
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

/**
 * JS source to put FIRST in an eval'd worker bootstrap (the tsx path in
 * offthread-stats.ts and offsite-backup.ts): lowers the thread's priority
 * before tsx compiles the worker's TypeScript imports — that compile is the
 * worker's heaviest CPU moment and lands in the boot window. Same rules as
 * lowerCurrentThreadPriority (Linux only, kill switch, fail-soft).
 */
export function lowerPriorityBootstrapSource(nice: number = WORKER_THREAD_NICE): string {
  const n = Math.max(0, Math.min(19, Math.trunc(nice)));
  return `if (process.platform === "linux" && process.env.WORKER_THREAD_NICE_DISABLED !== "1") { try { require("os").setPriority(0, ${n}); } catch (e) {} }\n`;
}

let threadPoolStartedHere = false;

/**
 * Call on the MAIN thread right before starting a worker that lowers its own
 * priority. New threads inherit the nice value of the thread that creates
 * them, and libuv creates its thread pool (fs, dns.lookup, zlib, crypto) on
 * the first piece of pool work in the process. If a niced worker were first,
 * the pool would run at its nice value for the rest of the process, including
 * the main thread's I/O. In prod the main thread uses the pool long before
 * (express.static, /health), so this is a cheap guarantee, not a fix.
 */
export function ensureThreadPoolStartedOnMainThread(): void {
  if (threadPoolStartedHere || !isMainThread) return;
  threadPoolStartedHere = true;
  try {
    fs.stat(__filename, () => {});
  } catch {
    // best effort
  }
}
