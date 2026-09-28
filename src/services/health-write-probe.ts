// ─── Cached write-path probe for GET /health ────────────────────────
// dev-request 2026-09-28-health-endepunkt-maaler-ikke-skrivesti (A2A).
//
// 2026-09-28 the prod DB write path was down ~20 h (`disk I/O error` on every
// write) while /health kept answering the same "warning" it gives on a healthy
// day, because it only ever READ. This probe does one tiny upsert into a
// one-row table (auto-committed, so a failing disk surfaces as a thrown error)
// and caches the outcome, so /health costs at most one write per TTL, not one
// per HTTP call. Read-only DBs and in-memory DBs are probed the same way.

import type Database from "better-sqlite3";

export const WRITE_PROBE_TTL_MS = 30_000;

export interface WritePathHealth {
  ok: boolean;
  checkedAt: string;
  cachedAgeMs: number;
  error?: string;
}

let cache: { ok: boolean; at: number; error?: string } | null = null;

export function __resetWriteProbeCacheForTesting(): void {
  cache = null;
}

export function getWritePathHealth(
  db: Database.Database,
  nowMs: number = Date.now(),
  ttlMs: number = WRITE_PROBE_TTL_MS,
): WritePathHealth {
  if (!cache || nowMs - cache.at >= ttlMs || nowMs < cache.at) {
    try {
      db.exec("CREATE TABLE IF NOT EXISTS health_write_probe (id INTEGER PRIMARY KEY CHECK (id = 1), probed_at TEXT NOT NULL)");
      db.prepare(
        "INSERT INTO health_write_probe (id, probed_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET probed_at = excluded.probed_at",
      ).run(new Date(nowMs).toISOString());
      cache = { ok: true, at: nowMs };
    } catch (err) {
      cache = { ok: false, at: nowMs, error: String((err as Error)?.message ?? err).slice(0, 200) };
    }
  }
  return {
    ok: cache.ok,
    checkedAt: new Date(cache.at).toISOString(),
    cachedAgeMs: Math.max(0, nowMs - cache.at),
    ...(cache.error ? { error: cache.error } : {}),
  };
}
