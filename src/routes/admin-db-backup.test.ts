/**
 * admin-db-backup.test.ts — tests for the DB backup/export lever
 * (POST/GET /admin/db/backup), added 2026-09-11 per
 * dev-requests/2026-09-11-experiences-retro-opprydding-db-backup-lever.md,
 * extended 2026-09-13 for the `?db=experiences` follow-up slice (see the
 * route file's own `?db=` header comment).
 *
 * Mirrors admin-db-table-sizes.test.ts's conventions:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema) for lokal.db.
 *   - the previous global db handle is saved/restored so this test never
 *     leaves the module-level singleton swapped for later blocks.
 *   - the router is exercised directly (no HTTP server / supertest): build a
 *     minimal req/res pair and call `router.handle(req, res, next)`.
 *   - exported runAdminDbBackupTests({log}) → TestSummary; wired into
 *     tests/test.ts. Standalone: npx tsx src/routes/admin-db-backup.test.ts
 *
 * DB_PATH / EXPERIENCES_DB_PATH (which this route derives its `backups/`
 * dirs from) are module-level consts computed at require-time, same as
 * database/init.ts's own DB_PATH / db-factory.ts's own per-vertical env-path
 * resolution — so this test points them at a scratch temp directory via
 * process.env.DB_PATH / process.env.EXPERIENCES_DB_PATH BEFORE a fresh
 * require() of the route module (same "delete require.cache + fresh
 * require" seam admin-db-table-sizes.test.ts uses), instead of ever
 * touching the real repo's data/ directory. experiences.db itself is a REAL
 * file at that scratch path (not `:memory:` — its dirname is what the route
 * derives `backups/experiences/` from), opened via db-factory.ts's own
 * getDb('experiences') / __resetDbFactoryForTesting() seam (same seam
 * init-dental.test.ts uses for the 'dental' vertical) so the route's
 * `?db=experiences` branch backs up the SAME cached handle this test seeds
 * fixtures into.
 *
 * Covers (lokal.db / `db=lokal` / no `db` param — UNCHANGED from before the
 * `?db=` slice):
 *   (a) no X-Admin-Key -> 403, no file written
 *   (b) valid key -> 200; backup_path/size_bytes/sha256/row_counts/created_at
 *       present; the file at backup_path exists, is a valid SQLite file
 *       (openable read-only by a fresh better-sqlite3 instance), its sha256
 *       matches the response, and row_counts match a direct COUNT(*) against
 *       the source (fixture) db at test time
 *   (c) a second POST creates a DIFFERENT new file, not an overwrite
 *   (d) retention: pruneBackups() keeps only the N most recent, verified in
 *       isolation against synthetic filenames (the exported `keep` param is
 *       this route's test-only injection point for the cap)
 *   (e) GET /backup lists the file(s) created
 *
 * Covers (the `?db=` follow-up slice):
 *   (f) an invalid `db=` value -> 400, no file written
 *   (g) POST /backup?db=experiences with no X-Admin-Key -> 401/403, no file
 *       written
 *   (h) POST /backup?db=experiences with a valid key -> 200, against
 *       experiences.db's OWN schema/tables (not lokal.db's), same
 *       backup_path/sha256/row_counts fidelity as (b) above
 *   (i)/(j) the two databases' backup listings never leak into each other:
 *       GET /backup (no param) never lists an experiences-db file and
 *       GET /backup?db=experiences never lists a lokal-db file
 *   (k) an invalid `db=` value on GET too -> 400
 *   (l) retention is counted PER DATABASE, never combined: 13 seeded
 *       experiences-db backup files prune to 10 while 3 seeded lokal-db
 *       backup files (already under the cap) are left completely untouched
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import * as initMod from "../database/init";
import * as dbFactory from "../database/db-factory";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; url?: string; headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const rawUrl = opts.url || "/backup";
    // This harness calls router.handle() directly on a bare object rather
    // than going through a full Express app, so there is no query-parser
    // middleware to populate req.query from req.url the way a real request
    // would — parse it by hand here. Every pre-`?db=`-slice test passes a
    // plain "/backup" url with no "?", so `query` resolves to `{}` exactly
    // as it always hardcoded before; only the new `?db=...` tests actually
    // rely on this.
    const query: Record<string, string> = {};
    const queryIdx = rawUrl.indexOf("?");
    if (queryIdx !== -1) {
      for (const pair of rawUrl.slice(queryIdx + 1).split("&")) {
        if (!pair) continue;
        const [k, v] = pair.split("=");
        query[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
      }
    }
    const req: any = {
      method: opts.method || "POST",
      url: rawUrl,
      query,
      headers: opts.headers || {},
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runAdminDbBackupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "admin-db-backup-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    // Scratch DB_PATH so this route's `backups/` dir lands under a temp
    // directory, never the real repo's data/ directory. The route reads
    // DB_PATH at require-time, so this must be set BEFORE the fresh
    // require() below.
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admin-db-backup-test-"));
    const scratchDbPath = path.join(scratchRoot, "data", "lokal.db");
    fs.mkdirSync(path.dirname(scratchDbPath), { recursive: true });
    const prevDbPathEnv = process.env.DB_PATH;
    process.env.DB_PATH = scratchDbPath;
    const backupsDir = path.join(path.dirname(scratchDbPath), "backups");

    // Scratch EXPERIENCES_DB_PATH, same rationale as DB_PATH above — declared
    // (and its "previous value" captured) OUTSIDE the try block, alongside
    // prevDbPathEnv, so the `finally` below can always restore it even if
    // something inside try throws before reaching this point.
    const scratchExperiencesDbPath = path.join(scratchRoot, "data", "experiences.db");
    const prevExperiencesDbPathEnv = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = scratchExperiencesDbPath;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // Fixture rows in real, prod-schema tables so row_counts has known,
      // non-zero values to assert against.
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.com', 'producer', ?)`,
      );
      insertAgent.run("agent-1", "Test Gård 1", "key-1");
      insertAgent.run("agent-2", "Test Gård 2", "key-2");

      const insertListing = db.prepare(
        `INSERT INTO listings (id, agent_id, product_name) VALUES (?, ?, ?)`,
      );
      insertListing.run("listing-1", "agent-1", "Poteter");

      // ── Scratch experiences.db for the `?db=experiences` tests below ────
      // A REAL file (not `:memory:`) under the SAME scratch root as lokal's
      // DB_PATH above, so its dirname is a real, writable directory the
      // route can derive `backups/experiences/` from (mirrors production,
      // where both DBs' dirnames coincide at /app/data). Opened via
      // db-factory.ts's own getDb('experiences') + __resetDbFactoryForTesting
      // seam (same seam init-dental.test.ts uses for 'dental') so the
      // route's own `getVerticalDb("experiences")` call (inside
      // admin-db-backup.ts) returns THIS SAME cached handle rather than
      // opening a second connection — the route module's `require()` of
      // db-factory.ts below resolves to the identical cached module (its
      // require.cache entry is never deleted), so both sides share one
      // `handles` Map.
      dbFactory.__resetDbFactoryForTesting();
      const experiencesDb = dbFactory.getDb("experiences");

      experiencesDb
        .prepare(`INSERT INTO experience_providers (id, navn) VALUES (?, ?)`)
        .run("exp-prov-1", "Test Gård 1");
      experiencesDb
        .prepare(`INSERT INTO experience_providers (id, navn) VALUES (?, ?)`)
        .run("exp-prov-2", "Test Gård 2");
      experiencesDb
        .prepare(`INSERT INTO experiences (id, title) VALUES (?, ?)`)
        .run("exp-1", "Test Opplevelse");

      // Fresh require of the route module: picks up the scratch DB_PATH /
      // EXPERIENCES_DB_PATH set above, and gives this run its own clean
      // module state.
      delete require.cache[require.resolve("./admin-db-backup")];
      const dbBackupMod = require("./admin-db-backup");
      const router = dbBackupMod.default;
      const KEY_TABLES: string[] = dbBackupMod.KEY_TABLES;
      const EXPERIENCES_KEY_TABLES: string[] = dbBackupMod.EXPERIENCES_KEY_TABLES;
      const pruneBackups: (dir: string, keep?: number, filenameRe?: RegExp) => string[] =
        dbBackupMod.pruneBackups;
      const BACKUP_FILENAME_RE: RegExp = dbBackupMod.BACKUP_FILENAME_RE;
      const EXPERIENCES_BACKUP_FILENAME_RE: RegExp = dbBackupMod.EXPERIENCES_BACKUP_FILENAME_RE;

      // ── (a) 403 without X-Admin-Key, no file written ────────────
      const noKey = await callRoute(router, { method: "POST", url: "/backup" });
      assertEq(noKey.status, 403, "no-key: POST /backup without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.backup_path, "no-key: response carries no backup_path");
      assertTrue(!fs.existsSync(backupsDir), "no-key: backups/ dir was not created");

      // ── (b) 200 with valid key ───────────────────────────────────
      const first = await callRoute(router, {
        method: "POST",
        url: "/backup",
        headers: { "x-admin-key": testKey },
      });
      assertEq(first.status, 200, "with-key: POST /backup -> 200");

      assertTrue(typeof first.body?.backup_path === "string" && first.body.backup_path.length > 0,
        "with-key: response has backup_path");
      assertTrue(typeof first.body?.size_bytes === "number" && first.body.size_bytes > 0,
        "with-key: response has positive size_bytes");
      assertTrue(typeof first.body?.sha256 === "string" && /^[0-9a-f]{64}$/.test(first.body.sha256),
        "with-key: response has a well-formed sha256 hex digest");
      assertTrue(typeof first.body?.created_at === "string" && !isNaN(Date.parse(first.body.created_at)),
        "with-key: created_at is a parseable ISO timestamp");

      const backupPath1: string = first.body.backup_path;
      assertTrue(fs.existsSync(backupPath1), "with-key: the file at backup_path exists on disk");

      // Valid SQLite file: openable read-only by a fresh better-sqlite3 instance.
      let opened = false;
      try {
        const check = new Database(backupPath1, { readonly: true });
        const row = check.prepare(`SELECT COUNT(*) AS c FROM agents`).get() as { c: number };
        opened = true;
        assertEq(row.c, 2, "with-key: backup file's own 'agents' table has the 2 fixture rows");
        check.close();
      } catch (err) {
        failures.push(`✗ with-key: backup file failed to open as SQLite: ${String(err)}`);
        failed++;
      }
      assertTrue(opened, "with-key: backup file opened successfully as a valid SQLite db");

      // sha256 in the response matches the actual file's sha256.
      const actualHash = crypto.createHash("sha256").update(fs.readFileSync(backupPath1)).digest("hex");
      assertEq(first.body.sha256, actualHash, "with-key: response sha256 matches the actual file's sha256");

      // row_counts matches a direct COUNT(*) against the source db at test time.
      assertTrue(!!first.body?.row_counts && typeof first.body.row_counts === "object",
        "with-key: response has a row_counts object");
      for (const table of KEY_TABLES) {
        const expected = (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
        assertEq(first.body.row_counts[table], expected, `with-key: row_counts.${table} matches source COUNT(*)`);
      }

      // ── (c) second POST creates a DIFFERENT new file ─────────────
      const second = await callRoute(router, {
        method: "POST",
        url: "/backup",
        headers: { "x-admin-key": testKey },
      });
      assertEq(second.status, 200, "second POST: -> 200");
      const backupPath2: string = second.body?.backup_path;
      assertTrue(typeof backupPath2 === "string" && backupPath2.length > 0, "second POST: has a backup_path");
      assertTrue(backupPath2 !== backupPath1, "second POST: created a DIFFERENT file, not an overwrite");
      assertTrue(fs.existsSync(backupPath1) && fs.existsSync(backupPath2),
        "second POST: BOTH backup files still exist on disk");

      // ── (d) retention: pruneBackups keeps only the N most recent ─
      // Verified in isolation against synthetic filenames in a scratch dir —
      // the exported `keep` param is this route's test-only injection point,
      // so this doesn't require creating 10+ real (slow) backups end-to-end.
      const retentionDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-db-backup-retention-"));
      const syntheticNames = Array.from({ length: 13 }, (_, i) =>
        `lokal-2026-01-01T00-00-${String(i).padStart(2, "0")}-000Z.db`,
      );
      for (const name of syntheticNames) {
        fs.writeFileSync(path.join(retentionDir, name), "x");
      }
      const deleted = pruneBackups(retentionDir, 10);
      const remaining = fs.readdirSync(retentionDir).sort();
      assertEq(remaining.length, 10, "retention: exactly 10 files remain after pruning 13 down to the cap");
      assertEq(deleted.length, 3, "retention: pruneBackups reports the 3 files it deleted");
      assertEq(remaining, syntheticNames.slice(3), "retention: the 10 remaining are the 10 most recent by filename");
      fs.rmSync(retentionDir, { recursive: true, force: true });

      // ── (e) GET /backup lists the created file(s) ────────────────
      const list = await callRoute(router, {
        method: "GET",
        url: "/backup",
        headers: { "x-admin-key": testKey },
      });
      assertEq(list.status, 200, "GET /backup -> 200");
      assertTrue(Array.isArray(list.body?.backups), "GET /backup: backups is an array");
      const names: string[] = (list.body?.backups || []).map((b: any) => b.name);
      assertTrue(names.includes(path.basename(backupPath1)), "GET /backup: lists the first backup file");
      assertTrue(names.includes(path.basename(backupPath2)), "GET /backup: lists the second backup file");
      const entry1 = (list.body.backups as any[]).find((b) => b.name === path.basename(backupPath1));
      assertTrue(typeof entry1?.size_bytes === "number" && entry1.size_bytes > 0,
        "GET /backup: entry has a positive size_bytes");
      assertTrue(typeof entry1?.mtime === "string" && !isNaN(Date.parse(entry1.mtime)),
        "GET /backup: entry has a parseable mtime");

      // ── (f) invalid db= query value -> 400, no file written ──────
      const invalidDb = await callRoute(router, {
        method: "POST",
        url: "/backup?db=bogus",
        headers: { "x-admin-key": testKey },
      });
      assertEq(invalidDb.status, 400, "invalid db=: POST /backup?db=bogus -> 400");
      assertTrue(!invalidDb.body?.backup_path, "invalid db=: response carries no backup_path");

      // ── (g) POST /backup?db=experiences with no X-Admin-Key -> 401/403 ──
      const experiencesBackupsDir = path.join(scratchRoot, "data", "backups", "experiences");
      const expNoKey = await callRoute(router, { method: "POST", url: "/backup?db=experiences" });
      assertTrue(expNoKey.status === 401 || expNoKey.status === 403,
        "experiences no-key: POST /backup?db=experiences without X-Admin-Key -> 401/403");
      assertTrue(!expNoKey.body?.backup_path, "experiences no-key: response carries no backup_path");
      assertTrue(!fs.existsSync(experiencesBackupsDir),
        "experiences no-key: backups/experiences/ dir was not created");

      // ── (h) POST /backup?db=experiences with a valid key -> 200 ──────
      const expFirst = await callRoute(router, {
        method: "POST",
        url: "/backup?db=experiences",
        headers: { "x-admin-key": testKey },
      });
      assertEq(expFirst.status, 200, "experiences with-key: POST /backup?db=experiences -> 200");
      assertTrue(typeof expFirst.body?.backup_path === "string" && expFirst.body.backup_path.length > 0,
        "experiences with-key: response has backup_path");
      assertTrue(expFirst.body.backup_path.includes(path.join("backups", "experiences")),
        "experiences with-key: backup_path lives under its own backups/experiences/ subdirectory");
      assertTrue(typeof expFirst.body?.size_bytes === "number" && expFirst.body.size_bytes > 0,
        "experiences with-key: response has positive size_bytes");
      assertTrue(typeof expFirst.body?.sha256 === "string" && /^[0-9a-f]{64}$/.test(expFirst.body.sha256),
        "experiences with-key: response has a well-formed sha256 hex digest");
      assertTrue(typeof expFirst.body?.created_at === "string" && !isNaN(Date.parse(expFirst.body.created_at)),
        "experiences with-key: created_at is a parseable ISO timestamp");

      const expBackupPath1: string = expFirst.body.backup_path;
      assertTrue(fs.existsSync(expBackupPath1), "experiences with-key: the file at backup_path exists on disk");

      // Valid SQLite file, carrying experiences.db's OWN schema/rows (not
      // lokal.db's) — openable read-only by a fresh better-sqlite3 instance.
      let expOpened = false;
      try {
        const expCheck = new Database(expBackupPath1, { readonly: true });
        const row = expCheck.prepare(`SELECT COUNT(*) AS c FROM experience_providers`).get() as { c: number };
        expOpened = true;
        assertEq(row.c, 2, "experiences with-key: backup file's own 'experience_providers' table has the 2 fixture rows");
        expCheck.close();
      } catch (err) {
        failures.push(`✗ experiences with-key: backup file failed to open as SQLite: ${String(err)}`);
        failed++;
      }
      assertTrue(expOpened, "experiences with-key: backup file opened successfully as a valid SQLite db");

      const expActualHash = crypto.createHash("sha256").update(fs.readFileSync(expBackupPath1)).digest("hex");
      assertEq(expFirst.body.sha256, expActualHash, "experiences with-key: response sha256 matches the actual file's sha256");

      assertTrue(!!expFirst.body?.row_counts && typeof expFirst.body.row_counts === "object",
        "experiences with-key: response has a row_counts object");
      for (const table of EXPERIENCES_KEY_TABLES) {
        const expected = (experiencesDb.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
        assertEq(expFirst.body.row_counts[table], expected, `experiences with-key: row_counts.${table} matches source COUNT(*)`);
      }

      // ── (i)/(j) the two databases' listings never leak into each other ──
      const lokalListAfterExp = await callRoute(router, {
        method: "GET",
        url: "/backup",
        headers: { "x-admin-key": testKey },
      });
      assertEq(lokalListAfterExp.status, 200, "GET /backup (no db param) after an experiences backup: -> 200");
      const lokalNamesAfterExp: string[] = (lokalListAfterExp.body?.backups || []).map((b: any) => b.name);
      assertTrue(!lokalNamesAfterExp.includes(path.basename(expBackupPath1)),
        "GET /backup (no db param): does NOT list the experiences-db backup file");

      const expList = await callRoute(router, {
        method: "GET",
        url: "/backup?db=experiences",
        headers: { "x-admin-key": testKey },
      });
      assertEq(expList.status, 200, "GET /backup?db=experiences -> 200");
      assertTrue(Array.isArray(expList.body?.backups), "GET /backup?db=experiences: backups is an array");
      const expNames: string[] = (expList.body?.backups || []).map((b: any) => b.name);
      assertTrue(expNames.includes(path.basename(expBackupPath1)),
        "GET /backup?db=experiences: lists the experiences-db backup file");
      assertTrue(
        !expNames.includes(path.basename(backupPath1)) && !expNames.includes(path.basename(backupPath2)),
        "GET /backup?db=experiences: does NOT list either lokal-db backup file",
      );

      // ── (k) invalid db= on GET too -> 400 ─────────────────────────
      const getInvalidDb = await callRoute(router, {
        method: "GET",
        url: "/backup?db=bogus",
        headers: { "x-admin-key": testKey },
      });
      assertEq(getInvalidDb.status, 400, "GET /backup?db=bogus -> 400");

      // ── (l) retention counted PER DATABASE, never combined ────────
      // Direct pruneBackups() calls against synthetic filenames in isolated
      // scratch dirs (same "exported keep param as this route's test-only
      // injection point" convention as (d) above) — proves the two
      // databases' 10-newest caps are independent rather than sharing one
      // counter. Deliberately asymmetric seed counts (13 experiences-db / 3
      // lokal-db files), matching the filed spec: the 13 experiences-db
      // files must prune to 10, while the 3 lokal-db files (already under
      // the cap) must be left COMPLETELY untouched. A combined/shared
      // retention counter would fail this in one of two ways — either
      // wrongly pruning some of the 3 lokal-db files (to bring a shared
      // total of 16 down to a shared cap of 10) or wrongly leaving more than
      // 10 experiences-db files — either failure is caught by asserting the
      // exact remaining count in EACH directory independently.
      const combinedRetentionRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "admin-db-backup-combined-retention-"),
      );
      const expRetentionDir = path.join(combinedRetentionRoot, "experiences");
      fs.mkdirSync(expRetentionDir, { recursive: true });
      const lokalRetentionDir = combinedRetentionRoot; // flat, mirrors lokal's real (unchanged) layout

      const expSyntheticNames = Array.from({ length: 13 }, (_, i) =>
        `experiences-2026-01-01T00-00-${String(i).padStart(2, "0")}-000Z.db`,
      );
      for (const name of expSyntheticNames) fs.writeFileSync(path.join(expRetentionDir, name), "x");

      const lokalSyntheticNames = Array.from({ length: 3 }, (_, i) =>
        `lokal-2026-01-01T00-00-${String(i).padStart(2, "0")}-000Z.db`,
      );
      for (const name of lokalSyntheticNames) fs.writeFileSync(path.join(lokalRetentionDir, name), "x");

      const expDeleted = pruneBackups(expRetentionDir, 10, EXPERIENCES_BACKUP_FILENAME_RE);
      const lokalDeletedFromCombined = pruneBackups(lokalRetentionDir, 10, BACKUP_FILENAME_RE);

      const expRemaining = fs
        .readdirSync(expRetentionDir)
        .filter((f) => EXPERIENCES_BACKUP_FILENAME_RE.test(f))
        .sort();
      const lokalRemainingFromCombined = fs
        .readdirSync(lokalRetentionDir)
        .filter((f) => BACKUP_FILENAME_RE.test(f))
        .sort();

      assertEq(expRemaining.length, 10, "per-db retention: exactly 10 of the 13 seeded experiences-db files remain");
      assertEq(expDeleted.length, 3, "per-db retention: pruneBackups reports the 3 experiences-db files it deleted");
      assertEq(
        lokalRemainingFromCombined.length,
        3,
        "per-db retention: all 3 seeded lokal-db files remain untouched (under its OWN cap, unaffected by the 13 experiences-db files existing alongside)",
      );
      assertEq(lokalDeletedFromCombined.length, 0, "per-db retention: pruneBackups deletes NOTHING from the lokal-db dir (3 < 10)");

      fs.rmSync(combinedRetentionRoot, { recursive: true, force: true });
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevDbPathEnv === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = prevDbPathEnv;
      if (prevExperiencesDbPathEnv === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPathEnv;
      try {
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup — never fail the suite over teardown
      }
      db.close();
      try {
        fs.rmSync(scratchRoot, { recursive: true, force: true });
      } catch {
        // best-effort scratch-dir cleanup; never fail the test suite over it
      }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-db-backup.test.ts`
if (require.main === module) {
  runAdminDbBackupTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
