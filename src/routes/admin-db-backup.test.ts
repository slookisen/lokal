/**
 * admin-db-backup.test.ts — tests for the DB backup/export lever
 * (POST/GET /admin/db/backup), added 2026-09-11 per
 * dev-requests/2026-09-11-experiences-retro-opprydding-db-backup-lever.md.
 *
 * Mirrors admin-db-table-sizes.test.ts's conventions:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored so this test never
 *     leaves the module-level singleton swapped for later blocks.
 *   - the router is exercised directly (no HTTP server / supertest): build a
 *     minimal req/res pair and call `router.handle(req, res, next)`.
 *   - exported runAdminDbBackupTests({log}) → TestSummary; wired into
 *     tests/test.ts. Standalone: npx tsx src/routes/admin-db-backup.test.ts
 *
 * DB_PATH (which this route derives its `backups/` dir from) is a
 * module-level const computed at require-time, same as database/init.ts's
 * own copy — so this test points it at a scratch temp directory via
 * process.env.DB_PATH BEFORE a fresh require() of the route module (same
 * "delete require.cache + fresh require" seam admin-db-table-sizes.test.ts
 * uses), instead of ever touching the real repo's data/ directory.
 *
 * Covers:
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
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import * as initMod from "../database/init";

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
    const req: any = {
      method: opts.method || "POST",
      url: opts.url || "/backup",
      query: {},
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

      // Fresh require of the route module: picks up the scratch DB_PATH set
      // above, and gives this run its own clean module state.
      delete require.cache[require.resolve("./admin-db-backup")];
      const dbBackupMod = require("./admin-db-backup");
      const router = dbBackupMod.default;
      const KEY_TABLES: string[] = dbBackupMod.KEY_TABLES;
      const pruneBackups: (dir: string, keep?: number) => string[] = dbBackupMod.pruneBackups;

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
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevDbPathEnv === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = prevDbPathEnv;
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
