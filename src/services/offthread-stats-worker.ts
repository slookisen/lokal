// ─── Off-thread stats worker (worker_threads entry) ─────────────────
// dev-request 2026-09-19-prod-event-loop-stall-mcp-unhealthy (A2A).
//
// Runs the analytics aggregations that used to freeze the main event loop
// (getTrafficStats: 8–23 s per homepage render in prod; /health's COUNT(*):
// ~1.8 s) on its own READ-ONLY better-sqlite3 connection. The DB is in WAL
// mode, so these reads never block the main connection's writes, and the
// main thread stays free to serve every host while they run.
//
// Started by offthread-stats.ts with workerData = { dbPath }. tsx's loader
// hooks do not reach worker threads, so under tsx this .ts file is loaded by
// a small CommonJS bootstrap that registers tsx/cjs first (see ensureWorker
// in offthread-stats.ts). Keep the import graph pure: no database/init,
// nothing with side effects.

import { parentPort, workerData } from "worker_threads";
import Database from "better-sqlite3";
import type { VerticalId } from "./analytics-service";
import { computeTrafficStats } from "./traffic-stats-compute";
import { computePageViewCounts } from "./health-counts-compute";

export type StatsTask =
  | { kind: "trafficStats"; vertical?: VerticalId; windowDays: number }
  | { kind: "pageViewCounts"; nowMs: number };

export interface StatsWorkerRequest {
  id: number;
  task: StatsTask;
}

export type StatsWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export function runStatsTask(db: Database.Database, task: StatsTask): unknown {
  switch (task.kind) {
    case "trafficStats":
      return computeTrafficStats(db, task.vertical, task.windowDays);
    case "pageViewCounts":
      return computePageViewCounts(db, task.nowMs);
    default:
      throw new Error(`unknown stats task: ${JSON.stringify(task)}`);
  }
}

if (parentPort && workerData && typeof workerData.dbPath === "string") {
  const port = parentPort;
  const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  port.on("message", (req: StatsWorkerRequest) => {
    let res: StatsWorkerResponse;
    try {
      res = { id: req.id, ok: true, result: runStatsTask(db, req.task) };
    } catch (err) {
      res = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    port.postMessage(res);
  });
}
