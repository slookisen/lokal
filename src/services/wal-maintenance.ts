// WAL maintenance (slice S1 of 2026-10-09-rfb-grunnmur-wal-backup-fts-spillbok):
// nightly wal_checkpoint(TRUNCATE) for every open DB + cheap WAL-file sizes.
import * as fs from "fs";
import { getOpenDbHandles } from "../database/db-factory";

type Handle = { vertical: string; db: any };

/** True when the hour is inside the 07–09 UTC no-go window (morning traffic). */
export function isWalCheckpointBlockedHour(now: Date): boolean {
  const h = now.getUTCHours();
  return h >= 7 && h <= 9;
}

/** Size in bytes of `<dbfile>-wal`; 0 if missing, in-memory or unreadable. */
export function walFileSizeBytes(dbPath: string | undefined | null): number {
  if (!dbPath || dbPath === ":memory:") return 0;
  try {
    return fs.statSync(dbPath + "-wal").size;
  } catch {
    return 0;
  }
}

/** WAL size per open DB (statSync only, no queries). */
export function getWalSizes(handles?: Handle[]): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const h of handles ?? getOpenDbHandles()) {
      let name: string | undefined;
      try { name = h.db.name; } catch { /* closed handle */ }
      out[h.vertical] = walFileSizeBytes(name);
    }
  } catch {
    // never throw into callers (/health)
  }
  return out;
}

export interface WalCheckpointResult {
  vertical: string;
  ok: boolean;
  walBytesBefore: number;
  walBytesAfter: number;
  error?: string;
}

// NOTE: wal_checkpoint(TRUNCATE) is synchronous (better-sqlite3) and runs on the main thread.
// A large WAL can block the event loop for seconds, which is why it only runs in the 03 UTC
// autoPruneTick window (never 07-09 UTC). Prod duration is not yet measured; check the stall log.
/**
 * wal_checkpoint(TRUNCATE) on every open DB. Never throws; each DB is isolated.
 * Skipped entirely in the 07–09 UTC window.
 */
export function runWalCheckpoints(
  now: Date = new Date(),
  handles?: Handle[],
): WalCheckpointResult[] {
  const results: WalCheckpointResult[] = [];
  if (isWalCheckpointBlockedHour(now)) return results;
  let list: Handle[] = [];
  try { list = handles ?? getOpenDbHandles(); } catch (err) {
    console.error("[wal-checkpoint] could not list handles (non-fatal):", err);
    return results;
  }
  for (const h of list) {
    let name: string | undefined;
    try { name = h.db.name; } catch { /* ignore */ }
    const before = walFileSizeBytes(name);
    try {
      h.db.pragma("wal_checkpoint(TRUNCATE)");
      results.push({ vertical: h.vertical, ok: true, walBytesBefore: before, walBytesAfter: walFileSizeBytes(name) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wal-checkpoint] ${h.vertical} failed (non-fatal): ${msg}`);
      results.push({ vertical: h.vertical, ok: false, walBytesBefore: before, walBytesAfter: before, error: msg });
    }
  }
  return results;
}
