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
//
// ─── `?db=` parameter (follow-up slice, 2026-09-13) ────────────
// This route originally only ever backed up lokal.db. The experiences/
// opplevagent vertical lives in a COMPLETELY SEPARATE SQLite file
// (data/experiences.db, schema in database/init-experiences.ts, opened via
// database/db-factory.ts's getDb('experiences') — see that module's own
// "CRITICAL ISOLATION INVARIANT" comment on why it is a different file, not
// a table in lokal.db) that this route had NO concept of. Confirmed gap,
// found live while preparing to run an irreversible mass-mutation against
// the experiences catalog that needs a real backup reference first.
//
// `?db=lokal` (or the param OMITTED) is the exact, byte-for-byte-unchanged
// default behavior from before this slice. `?db=experiences` runs the
// identical `.backup()` / streaming-sha256 / retention machinery against
// experiences.db instead, via the small DB_CONFIGS table below —
// parameterized, not duplicated as a second near-identical route file. Any
// other `db=` value (or a repeated `?db=a&db=b`, which Express parses as an
// array rather than a string) -> 400, no file written.
//
// DESIGN DECISION — path layout: lokal.db's existing backups stay EXACTLY
// where they are today — flat files directly under
// `<dirname(DB_PATH)>/backups/lokal-<ts>.db` — rather than moving into a new
// `backups/lokal/` subdirectory for symmetry. Moving them would risk today's
// exact lokal.db path/behavior for zero benefit (a symmetrical rename buys
// nothing an existing caller needs). experiences.db backups instead get a
// NEW `backups/experiences/` subdirectory — this is what keeps the two
// databases' retention counts independent (13 experiences + 3 lokal backups
// must prune to 10 experiences-db files and leave the 3 lokal-db files
// alone, never a combined/shared count) without disturbing a single
// existing lokal.db file or filename.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import Database from "better-sqlite3";
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

// experiences.db path — mirrors db-factory.ts's own getDb('experiences')
// path resolution EXACTLY (env override `EXPERIENCES_DB_PATH`, else the
// production Fly-volume path `/app/data/experiences.db`) — deliberately NOT
// the __dirname-relative dev-fallback DB_PATH above uses, because
// db-factory.ts never falls back that way for any non-rfb vertical (see its
// own `getDb()`). Duplicated locally for the same test-injection reason
// DB_PATH is duplicated from init.ts: a test sets EXPERIENCES_DB_PATH before
// a fresh require() of this module to point its backups/ subdirectory at a
// scratch directory instead of the real repo's data/ directory.
const EXPERIENCES_DB_PATH = process.env.EXPERIENCES_DB_PATH || "/app/data/experiences.db";

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
// database/db-factory.ts) — handled by EXPERIENCES_KEY_TABLES below, under
// the `?db=experiences` branch, never mixed into this list.
export const KEY_TABLES = ["agents", "listings", "tasks", "orders", "crm_contacts"];

// Small, FIXED list of key experiences-vertical tables to report row counts
// for. Verified directly against src/database/init-experiences.ts's actual
// `CREATE TABLE IF NOT EXISTS` statements (initExperiencesSchema) — the
// schema database/db-factory.ts's getDb('experiences') opens on
// experiences.db. experience_providers/experiences are the two primary
// harvest-model tables (see that file's own header comment); umbrellas +
// affiliations + gardssalg_bookings round out the other core top-level
// tables defined in that file (not later additive ALTER-only columns),
// mirroring how KEY_TABLES above only lists lokal.db's own top-level tables.
export const EXPERIENCES_KEY_TABLES = [
  "experience_providers",
  "experiences",
  "experience_umbrellas",
  "provider_umbrella_affiliations",
  "gardssalg_bookings",
];

// UTC ISO timestamp with colons stripped (filesystem-safe), e.g.
// "2026-09-11T12-05-00-123Z".
function utcTimestampNoColons(d: Date): string {
  return d.toISOString().replace(/:/g, "-");
}

// Builds the destination path for a fresh backup, `<dir>/<prefix>-<ts>.db`.
// Virtually always just that; the collision-avoidance suffix only matters if
// two calls somehow land in the exact same millisecond (belt-and-suspenders
// for AC #3 — "a second POST creates a DIFFERENT new file, never an
// overwrite"). `prefix` distinguishes lokal.db backups ("lokal") from
// experiences.db backups ("experiences") — see DB_CONFIGS below.
function buildDestPath(dir: string, prefix: string): string {
  const ts = utcTimestampNoColons(new Date());
  let destPath = path.join(dir, `${prefix}-${ts}.db`);
  let suffix = 0;
  while (fs.existsSync(destPath)) {
    suffix += 1;
    destPath = path.join(dir, `${prefix}-${ts}-${suffix}.db`);
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

// Matches lokal.db's OWN backup filenames only — unchanged from before this
// slice (still the default for pruneBackups()/GET below, for AC3 fidelity).
export const BACKUP_FILENAME_RE = /^lokal-.*\.db$/;

// Matches experiences.db's own backup filenames. They live in their own
// `backups/experiences/` subdirectory (see DB_CONFIGS below), so this regex
// never needs to distinguish them from lokal's by name — the directory
// already does; it only guards against stray non-backup files in that dir.
export const EXPERIENCES_BACKUP_FILENAME_RE = /^experiences-.*\.db$/;

// Retention: keep only the `keep` most recent backup files (by filename,
// which sorts chronologically since it's built from an ISO timestamp),
// deleting the rest. Exported (not test-prefixed) so a test can exercise the
// deletion logic in isolation with a low `keep` value without needing to
// create 10+ real backups end-to-end. Never called from production code with
// anything but the default `keep` of 10.
// `filenameRe` defaults to BACKUP_FILENAME_RE (lokal.db's pattern) so every
// call site that predates the `?db=` parameter — including this file's own
// pre-existing test — is completely unaffected; the experiences branch below
// passes EXPERIENCES_BACKUP_FILENAME_RE explicitly. Retention is ALWAYS run
// against one single directory at a time (lokal's flat backups/ dir, or
// experiences' own backups/experiences/ subdirectory) — never both — which
// is what keeps the two databases' 10-newest caps independent.
export function pruneBackups(
  dir: string,
  keep: number = 10,
  filenameRe: RegExp = BACKUP_FILENAME_RE,
): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => filenameRe.test(f));
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

type DbKey = "lokal" | "experiences";

interface DbBackupConfig {
  getDb: () => Database.Database;
  backupDir: () => string;
  filePrefix: string;
  filenameRe: RegExp;
  keyTables: string[];
}

// The parameterized config this whole `?db=` extension hangs off — one entry
// per supported `db` query value, reusing every piece of shared machinery
// above (buildDestPath/sha256File/pruneBackups) rather than a second
// near-identical route file.
const DB_CONFIGS: Record<DbKey, DbBackupConfig> = {
  lokal: {
    getDb: () => getDb(),
    // Flat, UNCHANGED location — see the file-header design-decision note.
    backupDir: () => path.join(path.dirname(DB_PATH), "backups"),
    filePrefix: "lokal",
    filenameRe: BACKUP_FILENAME_RE,
    keyTables: KEY_TABLES,
  },
  experiences: {
    // db-factory.ts owns experiences.db's own open/cache/schema-init — reuse
    // its handle rather than opening a second connection to the same file.
    getDb: () => getVerticalDb("experiences"),
    backupDir: () => path.join(path.dirname(EXPERIENCES_DB_PATH), "backups", "experiences"),
    filePrefix: "experiences",
    filenameRe: EXPERIENCES_BACKUP_FILENAME_RE,
    keyTables: EXPERIENCES_KEY_TABLES,
  },
};

// Parses & validates the `?db=` query param. Returns the resolved key, or
// `null` after already sending the 400 response. Absent -> 'lokal', for
// 100% backward compatibility with every existing caller of this route.
// Anything else (an unrecognized value, or `?db=a&db=b`, which Express
// parses as an array rather than a string) -> 400, no file written.
function parseDbKey(raw: unknown, res: Response): DbKey | null {
  if (raw === undefined) return "lokal";
  if (raw === "lokal" || raw === "experiences") return raw;
  res.status(400).json({
    error: `Invalid db query param: ${JSON.stringify(raw)}. Must be 'lokal' or 'experiences' (omit for 'lokal').`,
  });
  return null;
}

// ─── POST /backup ─────────────────────────────────────────────
router.post("/backup", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const dbKey = parseDbKey(req.query.db, res);
  if (dbKey === null) return; // 400 already sent by parseDbKey

  const config = DB_CONFIGS[dbKey];

  (async () => {
    const db = config.getDb();
    const dir = config.backupDir();
    fs.mkdirSync(dir, { recursive: true });

    const destPath = buildDestPath(dir, config.filePrefix);

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
    for (const table of config.keyTables) {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
        rowCounts[table] = row.c;
      } catch {
        // Should not happen (keyTables is verified against the real
        // schema), but don't let one bad table sink an otherwise-successful
        // backup response.
        rowCounts[table] = -1;
      }
    }

    // Retention runs AFTER a successful backup, never before — a failed
    // backup must never cost an existing older one. Scoped to THIS db's own
    // directory only (see pruneBackups' doc comment) so lokal's and
    // experiences' 10-newest caps never interact.
    pruneBackups(dir, 10, config.filenameRe);

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

  const dbKey = parseDbKey(req.query.db, res);
  if (dbKey === null) return; // 400 already sent by parseDbKey

  const config = DB_CONFIGS[dbKey];
  const dir = config.backupDir();
  let backups: { name: string; size_bytes: number; mtime: string }[] = [];
  try {
    backups = fs
      .readdirSync(dir)
      .filter((f) => config.filenameRe.test(f))
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return { name, size_bytes: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first
  } catch {
    // backups/ (or backups/experiences/) doesn't exist yet (no backup ever
    // taken for this db) -> empty list, not an error.
    backups = [];
  }

  res.json({ success: true, backups });
});

export default router;
