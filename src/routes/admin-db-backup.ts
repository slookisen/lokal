// ─── Admin: DB Backup / Export Lever (additive, read-mostly) ────
//
// POST /admin/db/backup — take a timestamped snapshot of the live SQLite DB
// GET  /admin/db/backup  — list existing backup snapshots (no new file)
//
// Filed 2026-09-11 as a self-filed fleet follow-up
// (dev-requests/2026-09-11-experiences-retro-opprydding-db-backup-lever.md) to a
// FUNN logged against dev-requests/2026-08-25-experiences-retro-opprydding-
// boilerplate-innhold.md: Daniel's own AC (ii) for that mass-apply requires a
// DB-backup reference logged BEFORE the first mutating call, but no backup/
// export mechanism existed anywhere in the fleet. THIS route is only the
// lever — the mass-apply itself is a separate, later slice.
//
// Auth follows the same convention as admin-runs.ts / admin-db-table-sizes.ts:
// X-Admin-Key header, checked against ADMIN_KEY (falling back to
// ANALYTICS_ADMIN_KEY). Mounted under the EXISTING `/admin/db` prefix
// alongside admin-db-table-sizes.ts, so it inherits the same `adminLimiter`
// (500 req/hr, src/middleware/security.ts) from the shared app.use() call.
//
// ─── Safety notes ─────────────────────────────────────────────
// - Genuinely additive/read-mostly: the ONLY writes this file ever performs
//   are (a) a brand-new file under `backups/` per POST call and (b) deleting
//   OLDER files under that same `backups/` dir once more than 10 exist
//   (retention). No DELETE/UPDATE ever touches any existing application
//   table or row.
// - Uses better-sqlite3's built-in `.backup()` (SQLite's online/incremental
//   backup API): it copies the live DB in small page-sized chunks scheduled
//   via setImmediate between steps, so — unlike a manual
//   fs.readFileSync/copy of a 672MB+ live file — it never holds the event
//   loop for one long synchronous slice. This is the same "don't block the
//   shared event loop serving all customer traffic" concern
//   admin-db-table-sizes.ts's cache guard addresses for its own heavy call.
// - sha256 is computed by streaming the backup file through Node's crypto
//   hash (fs.createReadStream + incremental .update()), not a single
//   fs.readFileSync of the whole file — same non-blocking rationale.
// - Retention (readdir + sort + unlink of everything past the 10 newest) is
//   synchronous, but only ever touches the small `backups/` directory
//   listing, never the live multi-hundred-MB DB file — bounded, cheap work.
// - Known limitation (documented, not hidden — see the dev-request's own
//   FUNN block): backups live on the SAME Fly volume as the live DB. This
//   protects against a bad mutation/apply, NOT against loss of the whole
//   volume. Off-box (S3/object storage) export is an explicit non-goal here.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const router = Router();

// Duplicated from database/init.ts's own DB_PATH convention (not exported
// from there; src/index.ts already duplicates this same env-or-default
// pattern locally rather than importing it), so a test can point this route
// at a scratch directory by setting DB_PATH before a fresh require() of this
// module — same seam admin-db-table-sizes.test.ts uses for a clean module.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../data/lokal.db");

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

// Small, FIXED list of key application tables to report row counts for.
// Verified directly against src/database/init.ts's CREATE TABLE statements —
// this is the schema getDb() actually opens (DB_PATH / lokal.db). Tables like
// `experience_providers`/`experiences` live in a SEPARATE db file
// (data/experiences.db, schema in database/init-experiences.ts, opened via
// database/db-factory.ts) — deliberately NOT included here since they are not
// part of the DB this route backs up.
export const KEY_TABLES = ["agents", "listings", "tasks", "orders", "crm_contacts"];

function backupsDir(): string {
  return path.join(path.dirname(DB_PATH), "backups");
}

// UTC ISO timestamp with colons stripped (filesystem-safe), e.g.
// "2026-09-11T12-05-00-123Z".
function utcTimestampNoColons(d: Date): string {
  return d.toISOString().replace(/:/g, "-");
}

// Builds the destination path for a fresh backup. Virtually always just
// `lokal-<timestamp>.db`; the collision-avoidance suffix only matters if two
// calls somehow land in the exact same millisecond (belt-and-suspenders for
// AC #3 — "a second POST creates a DIFFERENT new file, never an overwrite").
function buildDestPath(dir: string): string {
  const ts = utcTimestampNoColons(new Date());
  let destPath = path.join(dir, `lokal-${ts}.db`);
  let suffix = 0;
  while (fs.existsSync(destPath)) {
    suffix += 1;
    destPath = path.join(dir, `lokal-${ts}-${suffix}.db`);
  }
  return destPath;
}

// Streams the file through sha256 rather than a single fs.readFileSync — see
// the file-header safety note on not blocking the event loop for one long
// synchronous read of a large file.
function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

const BACKUP_FILENAME_RE = /^lokal-.*\.db$/;

// Retention: keep only the `keep` most recent backup files (by filename,
// which sorts chronologically since it's built from an ISO timestamp),
// deleting the rest. Exported (not test-prefixed) so a test can exercise the
// deletion logic in isolation with a low `keep` value without needing to
// create 10+ real backups end-to-end. Never called from production code with
// anything but the default of 10.
export function pruneBackups(dir: string, keep: number = 10): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => BACKUP_FILENAME_RE.test(f));
  } catch {
    return [];
  }

  entries.sort(); // filename timestamp -> chronological ascending

  const deleted: string[] = [];
  if (entries.length > keep) {
    const toDelete = entries.slice(0, entries.length - keep);
    for (const name of toDelete) {
      try {
        fs.unlinkSync(path.join(dir, name));
        deleted.push(name);
      } catch {
        // Best-effort: a stray file that fails to delete doesn't fail the
        // backup response that triggered this retention pass.
      }
    }
  }
  return deleted;
}

// ─── POST /backup ─────────────────────────────────────────────
router.post("/backup", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  (async () => {
    const db = getDb();
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });

    const destPath = buildDestPath(dir);

    // better-sqlite3's built-in async/chunked online-backup API — see the
    // file-header safety note.
    await db.backup(destPath);

    const stat = fs.statSync(destPath);
    const sha256 = await sha256File(destPath);

    // Row counts against the LIVE source db at request time (not the backup
    // file) — one small COUNT(*) per fixed key table, same "N small queries
    // is fine for an infrequently-called admin route" reasoning as
    // admin-db-table-sizes.ts.
    const rowCounts: Record<string, number> = {};
    for (const table of KEY_TABLES) {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
        rowCounts[table] = row.c;
      } catch {
        // Should not happen (KEY_TABLES is verified against the real
        // schema), but don't let one bad table sink an otherwise-successful
        // backup response.
        rowCounts[table] = -1;
      }
    }

    // Retention runs AFTER a successful backup, never before — a failed
    // backup must never cost an existing older one.
    pruneBackups(dir);

    res.json({
      backup_path: destPath,
      size_bytes: stat.size,
      sha256,
      row_counts: rowCounts,
      created_at: new Date().toISOString(),
    });
  })().catch((err: any) => {
    res.status(500).json({
      error: "DB backup failed",
      detail: err?.message || String(err),
    });
  });
});

// ─── GET /backup ──────────────────────────────────────────────
router.get("/backup", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const dir = backupsDir();
  let backups: { name: string; size_bytes: number; mtime: string }[] = [];
  try {
    backups = fs
      .readdirSync(dir)
      .filter((f) => BACKUP_FILENAME_RE.test(f))
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return { name, size_bytes: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first
  } catch {
    // backups/ doesn't exist yet (no backup ever taken) -> empty list, not
    // an error.
    backups = [];
  }

  res.json({ success: true, backups });
});

export default router;
