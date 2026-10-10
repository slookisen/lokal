// Worker thread for src/services/offsite-backup.ts. Keeps the heavy SQLite work off the
// main thread (the event loop serves all traffic):
//   op "backup":    own connection to the live DB file, SQLite online backup to destPath.
//                   After better-sqlite3's first step every later step asks for the maximum
//                   page count, i.e. "all remaining pages", so the copy finishes in one step
//                   even if the file grows meanwhile (asking for the previous total could
//                   leave a few pages over, and the next step would then restart after a
//                   write on the main connection — an endless loop while the DB grows).
//                   The final fsync of the copy also happens here.
//   op "integrity": PRAGMA integrity_check on a restored temp copy. Not opened read-only:
//                   the copy may be in WAL mode without -shm/-wal files, and it is a
//                   throwaway file the caller deletes afterwards.
import { parentPort, workerData } from "worker_threads";
import Database from "better-sqlite3";

const { op, dbPath, destPath } = workerData as { op: "backup" | "integrity"; dbPath: string; destPath?: string };

async function main(): Promise<string[]> {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    if (op === "backup") {
      if (!destPath) throw new Error("destPath missing");
      await db.backup(destPath, { progress: () => 0x7fffffff });
      return [];
    }
    const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    return rows.map((r) => String(r.integrity_check));
  } finally {
    db.close();
  }
}

main().then(
  (result) => parentPort!.postMessage({ ok: true, result }),
  (err) => parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
);
