/**
 * boot-job-gate.test.ts — dev-request 2026-10-02-boot-jobber-event-loop-stall-
 * etter-deploy. Skip-logic for url-backfill, chunked execution (incl. the
 * chunked trust recalculation), and the exclusive boot-job gate.
 */
import Database from "better-sqlite3";
import {
  runChunked, runExclusiveBootJob, getJobLastCompletedAt, markJobCompleted,
  shouldSkipRecentRun, resolveMinIntervalHours, URL_BACKFILL_JOB, URL_BACKFILL_BOOT_DELAY_MS,
} from "./boot-job-gate";
import { runUrlBackfill } from "../agents/lokal-agent-verifier";

export interface TestSummary { passed: number; failed: number; failures: string[] }

export async function runBootJobGateTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const t = (cond: boolean, label: string) => {
    if (cond) { passed++; if (opts.log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.log(`  ✗ ${label}`); }
  };

  try {
    // ── A. skip logic ──
    const now = new Date("2026-10-02T12:00:00Z");
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
    t(!shouldSkipRecentRun({ lastCompletedAt: null, now, minIntervalHours: 12 }), "A1: never run -> do not skip");
    t(shouldSkipRecentRun({ lastCompletedAt: hoursAgo(1), now, minIntervalHours: 12 }), "A2: 1h old < 12h -> skip");
    t(!shouldSkipRecentRun({ lastCompletedAt: hoursAgo(13), now, minIntervalHours: 12 }), "A3: 13h old -> run");
    t(!shouldSkipRecentRun({ lastCompletedAt: hoursAgo(12), now, minIntervalHours: 12 }), "A4: exactly 12h old -> run");
    t(!shouldSkipRecentRun({ lastCompletedAt: hoursAgo(1), now, minIntervalHours: 0 }), "A5: interval 0 disables skipping");
    t(!shouldSkipRecentRun({ lastCompletedAt: new Date(now.getTime() + 3600_000), now, minIntervalHours: 12 }), "A6: future stamp is not trusted");
    t(resolveMinIntervalHours(undefined) === 12 && resolveMinIntervalHours("") === 12 && resolveMinIntervalHours("abc") === 12 && resolveMinIntervalHours("-3") === 12,
      "A7: default 12h on missing/junk env");
    t(resolveMinIntervalHours("6") === 6 && resolveMinIntervalHours("0") === 0, "A8: env override honoured");
    t(URL_BACKFILL_BOOT_DELAY_MS >= 5 * 60 * 1000, "A9: url-backfill boot delay is >= 5 min");

    // ── B. persisted state ──
    const db = new Database(":memory:");
    t(getJobLastCompletedAt(db, URL_BACKFILL_JOB) === null, "B1: no row -> null");
    markJobCompleted(db, URL_BACKFILL_JOB, hoursAgo(2));
    t(getJobLastCompletedAt(db, URL_BACKFILL_JOB)?.getTime() === hoursAgo(2).getTime(), "B2: stamp round-trips");
    markJobCompleted(db, URL_BACKFILL_JOB, hoursAgo(1));
    t(getJobLastCompletedAt(db, URL_BACKFILL_JOB)?.getTime() === hoursAgo(1).getTime(), "B3: stamp is upserted");
    t(getJobLastCompletedAt({ prepare() { throw new Error("db down"); }, exec() { throw new Error("db down"); } }, "x") === null,
      "B4: DB error -> null (never blocks the job)");

    // ── C. chunked execution ──
    const sizes: number[] = [];
    const items = Array.from({ length: 23 }, (_, i) => i);
    let yields = 0;
    const tick = setInterval(() => { yields++; }, 1);
    const r = await runChunked(items, async (slice) => { sizes.push(slice.length); }, { chunkSize: 10 });
    clearInterval(tick);
    t(r.chunks === 3 && sizes.join(",") === "10,10,3", "C1: 23 items / 10 -> slices 10,10,3");
    t((await runChunked([], () => { throw new Error("no"); }, { chunkSize: 5 })).chunks === 0, "C2: empty list -> 0 chunks");
    // Between slices the event loop must get a turn: a setImmediate scheduled
    // before the run must fire before the last slice completes.
    let immediateRan = false;
    let ranBeforeLast = false;
    setImmediate(() => { immediateRan = true; });
    await runChunked([1, 2, 3], (slice) => { if (slice[0] === 3) ranBeforeLast = immediateRan; }, { chunkSize: 1 });
    t(ranBeforeLast, "C3: event loop is yielded to between slices");

    // ── D. exclusive gate ──
    const order: string[] = [];
    const slow = runExclusiveBootJob(async () => { order.push("a-start"); await new Promise((r2) => setTimeout(r2, 30)); order.push("a-end"); });
    const failing = runExclusiveBootJob(() => { order.push("b"); throw new Error("boom"); });
    const after = runExclusiveBootJob(() => { order.push("c"); return 7; });
    let bErr = false;
    await failing.catch(() => { bErr = true; });
    await slow;
    t((await after) === 7 && order.join(",") === "a-start,a-end,b,c", "D1: jobs run strictly one after another");
    t(bErr, "D2: a failing job rejects only its own caller and does not block the queue");

    // ── E. chunked trust recalculation gives the same result as the sync one ──
    const { trustScoreService } = require("./trust-score-service") as typeof import("./trust-score-service");
    const { getDb, __setDbForTesting } = require("../database/init") as typeof import("../database/init");
    let prev: any = null;
    try { prev = getDb(); } catch { prev = null; }
    const tdb = new Database(":memory:");
    tdb.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, is_active INTEGER DEFAULT 1, trust_score REAL, is_verified INTEGER DEFAULT 0)`);
    __setDbForTesting(tdb);
    try {
      const noopSvc: any = Object.create(trustScoreService);
      let n = 0;
      noopSvc.calculate = () => ((n++ % 10) / 10);
      for (let i = 0; i < 45; i++) tdb.prepare("INSERT INTO agents (id, is_active) VALUES (?, ?)").run("a" + i, i < 42 ? 1 : 0);
      const res = await noopSvc.recalculateAllChunked({ chunkSize: 10 });
      t(res.updated === 42 && res.chunks === 5, "E1: 42 active agents processed in 5 slices of <=10");
      const sum = Object.values(res.distribution).reduce((a: number, b: any) => a + b, 0);
      t(sum === 42, "E2: distribution covers every agent");
      const rows = tdb.prepare("SELECT COUNT(*) c FROM agents WHERE trust_score IS NOT NULL").get() as any;
      t(rows.c === 42, "E3: scores persisted for active agents only");
    } finally {
      if (prev) __setDbForTesting(prev);
    }

    // ── F. runUrlBackfill chunk pauses ──
    const bdb = new Database(":memory:");
    bdb.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY);
      CREATE TABLE agent_knowledge (agent_id TEXT, website TEXT, email TEXT, verification_status TEXT, enrichment_status TEXT, url_last_probed TEXT, url_last_status INTEGER)`);
    for (let i = 0; i < 6; i++) {
      bdb.prepare("INSERT INTO agents (id) VALUES (?)").run("g" + i);
      bdb.prepare("INSERT INTO agent_knowledge VALUES (?, ?, 'x@y.no', 'verified', 'rich', NULL, NULL)").run("g" + i, "https://example.test/" + i);
    }
    const fetchImpl: any = async () => ({ status: 200, ok: true, headers: { get: () => null }, body: null });
    const t0 = Date.now();
    const out = await runUrlBackfill({ db: bdb, fetchImpl, chunkSize: 2, chunkPauseMs: 40 });
    t(out.scanned === 6, "F1: all candidates are still scanned when chunked");
    t(Date.now() - t0 >= 70, "F2: pauses between chunks (2 pauses x 40ms) are honoured");
  } catch (err: any) {
    failed++;
    failures.push("boot-job-gate: unexpected error: " + String(err?.stack || err?.message || err));
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runBootJobGateTests({ log: true }).then((r) => {
    console.log(`\nboot-job-gate: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
