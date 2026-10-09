/**
 * wal-maintenance.test.ts — slice S1 of 2026-10-09-rfb-grunnmur-wal-backup-fts-spillbok.
 */
import Database from "better-sqlite3";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

export async function runWalMaintenanceTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string): void {
    if (cond) passed++;
    else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.log(`  ✗ ${label}`); }
  }
  const wm = require("./wal-maintenance") as typeof import("./wal-maintenance");
  const factory = require("../database/db-factory") as typeof import("../database/db-factory");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wal-s1-"));
  const prevEnv = process.env.DENTAL_DB_PATH;
  try {
    // (1) factory-opened WAL handle carries journal_size_limit = 64 MB
    process.env.DENTAL_DB_PATH = path.join(tmp, "dental.db");
    factory.__resetDbFactoryForTesting();
    const dental = factory.getDb("dental");
    ok(String(dental.pragma("journal_mode", { simple: true })).toLowerCase() === "wal", "dental handle is in WAL mode");
    ok(Number(dental.pragma("journal_size_limit", { simple: true })) === 67108864, "journal_size_limit = 67108864 on factory handle");

    // (2) checkpoint helper: returns sizes, truncates, never throws
    dental.exec("CREATE TABLE IF NOT EXISTS wal_t (x TEXT)");
    for (let i = 0; i < 200; i++) dental.prepare("INSERT INTO wal_t VALUES (?)").run("x".repeat(200));
    const before = wm.walFileSizeBytes(dental.name);
    ok(before > 0, "WAL file has bytes before checkpoint");
    const res = wm.runWalCheckpoints(new Date("2026-10-10T03:00:00Z"), [{ vertical: "dental", db: dental }]);
    ok(res.length === 1 && res[0].ok && res[0].walBytesBefore === before, "checkpoint ok and reports size before");
    ok(res[0].walBytesAfter === 0, "WAL truncated to 0 bytes");

    // failing handle: closed DB and a throwing stub must not throw
    const dead = new Database(":memory:");
    dead.close();
    let threw = false;
    let r2: any[] = [];
    try {
      r2 = wm.runWalCheckpoints(new Date("2026-10-10T03:00:00Z"), [
        { vertical: "dead", db: dead },
        { vertical: "stub", db: { name: "x", pragma() { throw new Error("boom"); } } },
      ]);
    } catch { threw = true; }
    ok(!threw, "checkpoint helper does not throw on failing handles");
    ok(r2.length === 2 && r2.every((x) => x.ok === false && typeof x.error === "string"), "failures reported per handle");

    // blocked hours 07–09 UTC
    ok(wm.runWalCheckpoints(new Date("2026-10-10T08:00:00Z"), [{ vertical: "dental", db: dental }]).length === 0, "no checkpoint at 08 UTC");

    // (3) WAL size field is a number per DB; 0 when missing / :memory:
    const sizes = wm.getWalSizes();
    ok(typeof sizes === "object" && sizes !== null, "getWalSizes returns object");
    ok(Object.values(sizes).every((v) => typeof v === "number" && v >= 0), "all WAL sizes are numbers");
    ok("dental" in sizes, "dental present in WAL sizes");
    ok(wm.walFileSizeBytes(":memory:") === 0 && wm.walFileSizeBytes(path.join(tmp, "nope.db")) === 0, "missing WAL file -> 0");
  } finally {
    try { factory.__resetDbFactoryForTesting(); } catch { /* ignore */ }
    if (prevEnv === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevEnv;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}
