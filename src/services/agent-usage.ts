// ─── Cached reader for the public tool-call count ───────────────────────────
// A2A dev-request 2026-10-09-agentplatform-partnerside. Same shape as
// traffic-stats.ts: with a file-backed DB the count runs in the off-thread
// stats worker (task "agentToolCalls") and requests only read the cache —
// a stale value is served while a background refresh runs, and nothing is
// shown until the first refresh after boot has landed (ready=false). In-memory
// DBs, OFFTHREAD_STATS_DISABLED=1 and a broken worker use a synchronous,
// cached computation instead.

import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import {
  AGENT_TOOL_CALL_WINDOW_DAYS,
  computeAgentToolCalls,
  type AgentToolCallStats,
} from "./agent-usage-compute";
import { createSwrCache, offThreadStatsUsable, runStatsTaskOffThread } from "./offthread-stats";

/** A 30-day total: a few hours of staleness is fine and keeps the worker idle. */
export const AGENT_USAGE_OFFTHREAD_TTL_MS = 6 * 60 * 60_000;
export const AGENT_USAGE_SYNC_TTL_MS = 10 * 60_000;
const AGENT_USAGE_RETRY_MS = 5 * 60_000;
const KEY = "agentToolCalls";

export interface AgentToolCallSnapshot {
  stats: AgentToolCallStats;
  /** False until a real value exists (first off-thread refresh still running, or the query failed). */
  ready: boolean;
}

export interface AgentUsageReaderDeps {
  getDb: () => Database.Database;
  offThreadUsable: (db: Database.Database, taskKey?: string) => boolean;
  runOffThread: (dbPath: string, nowMs: number, windowDays: number) => Promise<AgentToolCallStats>;
  computeSync: (db: Database.Database, nowMs: number) => AgentToolCallStats;
  now: () => number;
  syncTtlMs: number;
  offThreadTtlMs: number;
  retryAfterMs: number;
  log: (msg: string) => void;
}

export interface AgentUsageReader {
  snapshot(): AgentToolCallSnapshot;
  /** Schedules the off-thread refresh when the worker path is in use; never computes synchronously. */
  prewarm(): void;
  /** Test hook: resolves once an in-flight off-thread refresh settles. */
  settled(): Promise<void>;
  reset(): void;
}

const EMPTY: AgentToolCallStats = { toolCalls: 0, windowDays: AGENT_TOOL_CALL_WINDOW_DAYS };

export function createAgentUsageReader(deps: AgentUsageReaderDeps): AgentUsageReader {
  let syncCache: { data: AgentToolCallStats; time: number } | null = null;
  let offThreadDbPath: string | null = null;
  const offThread = createSwrCache<AgentToolCallStats>({
    ttlMs: deps.offThreadTtlMs,
    retryAfterMs: deps.retryAfterMs,
    now: deps.now,
    refresh: () => {
      const dbPath = offThreadDbPath;
      if (!dbPath) return Promise.reject(new Error("no DB path for off-thread agent tool calls"));
      return deps.runOffThread(dbPath, deps.now(), AGENT_TOOL_CALL_WINDOW_DAYS);
    },
    onError: (_key, err) =>
      deps.log(`[agent-usage] off-thread refresh failed: ${err instanceof Error ? err.message : String(err)}`),
  });

  return {
    snapshot() {
      let db: Database.Database;
      try {
        db = deps.getDb();
      } catch {
        return { stats: EMPTY, ready: false };
      }
      if (deps.offThreadUsable(db, KEY)) {
        if (offThreadDbPath !== db.name) {
          offThread.clear();
          offThreadDbPath = db.name;
        }
        const hit = offThread.get(KEY);
        return hit ? { stats: hit.value, ready: true } : { stats: EMPTY, ready: false };
      }
      const now = deps.now();
      if (syncCache && now >= syncCache.time && now - syncCache.time < deps.syncTtlMs) {
        return { stats: syncCache.data, ready: true };
      }
      try {
        const data = deps.computeSync(db, now);
        syncCache = { data, time: now };
        return { stats: data, ready: true };
      } catch {
        return { stats: EMPTY, ready: false };
      }
    },
    prewarm() {
      let db: Database.Database;
      try {
        db = deps.getDb();
      } catch {
        return;
      }
      if (!deps.offThreadUsable(db, KEY)) return;
      if (offThreadDbPath !== db.name) {
        offThread.clear();
        offThreadDbPath = db.name;
      }
      offThread.get(KEY);
    },
    settled() {
      return offThread.settled(KEY);
    },
    reset() {
      syncCache = null;
      offThread.clear();
      offThreadDbPath = null;
    },
  };
}

const defaultReader = createAgentUsageReader({
  getDb,
  offThreadUsable: offThreadStatsUsable,
  runOffThread: (dbPath, nowMs, windowDays) =>
    runStatsTaskOffThread<AgentToolCallStats>(dbPath, { kind: "agentToolCalls", nowMs, windowDays }),
  computeSync: (db, nowMs) => computeAgentToolCalls(db, nowMs),
  now: Date.now,
  syncTtlMs: AGENT_USAGE_SYNC_TTL_MS,
  offThreadTtlMs: AGENT_USAGE_OFFTHREAD_TTL_MS,
  retryAfterMs: AGENT_USAGE_RETRY_MS,
  log: (msg) => console.warn(msg),
});

export function getAgentToolCallsSnapshot(): AgentToolCallSnapshot {
  return defaultReader.snapshot();
}

/** Starts the first off-thread count after boot, so /partnere has the figure early. */
export function prewarmAgentToolCalls(): void {
  defaultReader.prewarm();
}

/** Test-only. */
export function __resetAgentUsageCacheForTesting(): void {
  defaultReader.reset();
}
