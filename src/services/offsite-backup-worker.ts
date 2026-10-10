// Worker thread for the offsite-backup restore test (src/services/offsite-backup.ts):
// opens a restored temp copy of a DB and runs PRAGMA integrity_check off the main thread.
// Not opened read-only: the copy may be in WAL mode without -shm/-wal files, and it is a
// throwaway file the caller deletes afterwards.
import { parentPort, workerData } from "worker_threads";
import Database from "better-sqlite3";

const { dbPath } = workerData as { dbPath: string };

try {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    parentPort!.postMessage({ ok: true, result: rows.map((r) => String(r.integrity_check)) });
  } finally {
    db.close();
  }
} catch (err) {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
