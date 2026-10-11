// ─── Cached reader for GET /api/agents/:id/stats ────────────────────────
// A2A dev-request 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-
// samtaler, skive 6. Same shape as agent-usage.ts / traffic-stats.ts: with a
// file-backed WAL DB the payload (agent-stats-compute.ts) runs in the
// off-thread stats worker ("public" lane) and a request only reads an SWR
// cache — a fresh value is returned as-is, a stale one is returned at once
// while a background refresh runs, and a cold miss waits up to `waitMs` for
// the first result (503 after that, or when the refresh failed; the page's
// hydration script fails quietly and shows no tiles). In-memory DBs,
// OFFTHREAD_STATS_DISABLED=1 and a broken worker (three failures in a row)
// use the synchronous computation with the old short TTL cache — the
// pre-skive-6 behaviour. The route keeps the quarantine/404 checks BEFORE it
// calls read(), so a cached payload never outlives a 404 decision.

import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import { computeAgentStats, type AgentStatsPayload } from "./agent-stats-compute";
import { createSwrCache, offThreadStatsUsable, runStatsTaskOffThread } from "./offthread-stats";

/** Off-thread values are refreshed in the worker, so a short freshness window costs the main thread nothing. */
export const AGENT_STATS_OFFTHREAD_TTL_MS = 5 * 60_000;
/** How long a cold miss waits for the worker before answering 503. */
export const AGENT_STATS_OFFTHREAD_WAIT_MS = 20_000;
/** Synchronous path (pre-skive-6 behaviour). */
export const AGENT_STATS_SYNC_TTL_MS = 120_000;
export const AGENT_STATS_MAX_ENTRIES = 2000;
const AGENT_STATS_RETRY_MS = 60_000;
export const AGENT_STATS_TASK_KEY = "agentStats";
/** Never a real agent id (agent ids are UUIDs); used only to start the worker. */
const PREWARM_AGENT_ID = "__prewarm__";

export type AgentStatsRead = { status: 200; payload: AgentStatsPayload } | { status: 503 };

export interface AgentStatsReaderDeps {
  getDb: () => Database.Database;
  offThreadUsable: (db: Database.Database, taskKey?: string) => boolean;
  runOffThread: (dbPath: string, agentId: string, path: string, nowMs: number) => Promise<AgentStatsPayload>;
  computeSync: (db: Database.Database, agentId: string, path: string, nowMs: number) => AgentStatsPayload;
  /** Clock for the caches. The computation itself always uses Date.now() (as before skive 6). */
  now: () => number;
  offThreadTtlMs: number;
  waitMs: number;
  syncTtlMs: number;
  maxEntries: number;
  retryAfterMs: number;
  log: (msg: string) => void;
}

export interface AgentStatsReader {
  read(agentId: string, path: string): Promise<AgentStatsRead>;
  /** Starts the public-lane worker (no-op on the synchronous path). */
  prewarm(): void;
  reset(clock?: (() => number) | null): void;
}

// agent id + page path: a renamed producer gets a new slug, so its cached
// payload is not reused for the new path.
const KEY_SEP = "\n";

function waitAtMost(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Not unref()ed: a request is waiting on it.
    const t = setTimeout(resolve, ms);
    p.then(
      () => { clearTimeout(t); resolve(); },
      () => { clearTimeout(t); resolve(); },
    );
  });
}

export function createAgentStatsReader(input: AgentStatsReaderDeps): AgentStatsReader {
  const deps = { ...input };
  let offThreadDbPath: string | null = null;
  const syncCache = new Map<string, { payload: AgentStatsPayload; storedAt: number }>();

  const offThread = createSwrCache<AgentStatsPayload>({
    ttlMs: deps.offThreadTtlMs,
    maxEntries: deps.maxEntries,
    retryAfterMs: deps.retryAfterMs,
    now: () => deps.now(),
    refresh: (key) => {
      const dbPath = offThreadDbPath;
      if (!dbPath) return Promise.reject(new Error("no DB path for off-thread agent stats"));
      const sep = key.indexOf(KEY_SEP);
      return deps.runOffThread(dbPath, key.slice(0, sep), key.slice(sep + KEY_SEP.length), Date.now());
    },
    onError: (key, err) =>
      deps.log(`[agent-stats] off-thread refresh failed for ${key.split(KEY_SEP)[0]}: ${err instanceof Error ? err.message : String(err)}`),
  });

  function useOffThread(db: Database.Database): boolean {
    if (!deps.offThreadUsable(db, AGENT_STATS_TASK_KEY)) return false;
    if (offThreadDbPath !== db.name) {
      offThread.clear();
      offThreadDbPath = db.name;
    }
    return true;
  }

  return {
    async read(agentId, path) {
      const db = deps.getDb();
      if (useOffThread(db)) {
        const key = agentId + KEY_SEP + path;
        let hit = offThread.get(key); // a stale or missing value schedules a refresh
        if (!hit) {
          await waitAtMost(offThread.settled(key), deps.waitMs);
          hit = offThread.get(key);
        }
        return hit ? { status: 200, payload: hit.value } : { status: 503 };
      }
      const cached = syncCache.get(agentId);
      const t = deps.now();
      if (cached && t - cached.storedAt < deps.syncTtlMs) return { status: 200, payload: cached.payload };
      syncCache.delete(agentId);
      const payload = deps.computeSync(db, agentId, path, Date.now());
      while (syncCache.size >= deps.maxEntries) {
        const oldest = syncCache.keys().next().value;
        if (oldest === undefined) break;
        syncCache.delete(oldest);
      }
      syncCache.set(agentId, { payload, storedAt: deps.now() });
      return { status: 200, payload };
    },
    prewarm() {
      let db: Database.Database;
      try {
        db = deps.getDb();
      } catch {
        return;
      }
      if (!useOffThread(db) || !offThreadDbPath) return;
      // Not cached: only spawns the worker and compiles its modules, so the
      // first real request after a deploy does not pay for that.
      void deps.runOffThread(offThreadDbPath, PREWARM_AGENT_ID, `/produsent/${PREWARM_AGENT_ID}`, Date.now()).catch((err) =>
        deps.log(`[agent-stats] prewarm failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    },
    reset(clock) {
      syncCache.clear();
      offThread.clear();
      offThreadDbPath = null;
      if (clock !== undefined) deps.now = clock ?? (() => Date.now());
    },
  };
}

const defaultReader = createAgentStatsReader({
  getDb,
  offThreadUsable: offThreadStatsUsable,
  runOffThread: (dbPath, agentId, path, nowMs) =>
    runStatsTaskOffThread<AgentStatsPayload>(dbPath, { kind: "agentStats", agentId, path, nowMs }),
  computeSync: computeAgentStats,
  now: () => Date.now(),
  offThreadTtlMs: AGENT_STATS_OFFTHREAD_TTL_MS,
  waitMs: AGENT_STATS_OFFTHREAD_WAIT_MS,
  syncTtlMs: AGENT_STATS_SYNC_TTL_MS,
  maxEntries: AGENT_STATS_MAX_ENTRIES,
  retryAfterMs: AGENT_STATS_RETRY_MS,
  log: (msg) => console.warn(msg),
});

export function readAgentStats(agentId: string, path: string): Promise<AgentStatsRead> {
  return defaultReader.read(agentId, path);
}

/** Started from src/index.ts shortly after boot (like prewarmTrafficStats). */
export function prewarmAgentStats(): void {
  defaultReader.prewarm();
}

/** Test-only: clear the caches and/or pin the cache clock (null restores Date.now). */
export function __resetAgentStatsReaderForTesting(clock?: (() => number) | null): void {
  defaultReader.reset(clock);
}
