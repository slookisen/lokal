/**
 * boot-job-gate.test.ts — dev-request 2026-10-02-boot-jobber-event-loop-stall-
 * etter-deploy. Skip-logic for url-backfill, chunked execution (incl. the
 * chunked trust recalculation), and the exclusive boot-job gate. B5-B10: the
 * daily outreach ticks' persisted "ran today" stamp (resolveDailyJobLastRunAt).
 */
import Database from "better-sqlite3";
import {
  runChunked, runExclusiveBootJob, getJobLastCompletedAt, markJobCompleted, resolveDailyJobLastRunAt,
  shouldSkipRecentRun, resolveMinIntervalHours, URL_BACKFILL_JOB, URL_BACKFILL_BOOT_DELAY_MS,
  scheduleBootTrustRecalc, TRUST_RECALC_JOB, TRUST_RECALC_BOOT_DELAY_MS, TRUST_RECALC_MIN_INTERVAL_HOURS,
  TRAFFIC_PREWARM_BOOT_DELAY_MS, DENTAL_GEOCODE_BOOT_DELAY_MS, EXPERIENCES_GEOCODE_BOOT_DELAY_MS,
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

    // ── B'. daily-tick stamp: memory ∪ persisted (outreach ticks, 2026-10-04) ──
    const dJob = "daily-tick-test";
    const at0809 = new Date("2026-10-04T08:09:00Z");
    const at0852 = new Date("2026-10-04T08:52:00Z");
    t(resolveDailyJobLastRunAt(db, dJob, null, at0852) === null, "B5: nothing in memory, nothing persisted -> null (job runs)");
    markJobCompleted(db, dJob, at0809);
    t(resolveDailyJobLastRunAt(db, dJob, null, at0852)?.getTime() === at0809.getTime(),
      "B6: after a restart (memory empty) the persisted 08:09Z stamp is used");
    const yesterday = new Date("2026-10-03T08:05:00Z");
    t(resolveDailyJobLastRunAt(db, dJob, yesterday, at0852)?.getTime() === at0809.getTime(), "B7: the later of memory and DB wins (DB newer)");
    const later = new Date("2026-10-04T08:30:00Z");
    t(resolveDailyJobLastRunAt(db, dJob, later, at0852)?.getTime() === later.getTime(), "B8: the later of memory and DB wins (memory newer)");
    t(resolveDailyJobLastRunAt(db, dJob, null, new Date("2026-10-04T08:00:00Z")) === null,
      "B9: a persisted stamp in the future (clock skew) is not trusted");
    t(resolveDailyJobLastRunAt({ prepare() { throw new Error("db down"); }, exec() { throw new Error("db down"); } }, dJob, yesterday, at0852)?.getTime() === yesterday.getTime(),
      "B10: DB error -> the in-memory stamp alone");

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

    // ── G. boot staggering (dev-request 2026-10-08-serverheng, slice 2) ──
    const MIN = 60_000;
    t(TRUST_RECALC_BOOT_DELAY_MS >= 3 * MIN && TRUST_RECALC_BOOT_DELAY_MS <= 5 * MIN && TRUST_RECALC_BOOT_DELAY_MS < URL_BACKFILL_BOOT_DELAY_MS,
      "G1: boot-trust-recalc waits 3-5 min (before url-backfill)");
    t(TRUST_RECALC_MIN_INTERVAL_HOURS === 24, "G2: boot-trust-recalc skip window is 24 h");
    t(TRAFFIC_PREWARM_BOOT_DELAY_MS >= 45_000 && TRAFFIC_PREWARM_BOOT_DELAY_MS <= 90_000, "G3: traffic prewarm waits ~60 s");
    const { AGENTS_GEOCODE_BOOT_DELAY_MS } = require("./agents-geocode-worker") as typeof import("./agents-geocode-worker");
    t(DENTAL_GEOCODE_BOOT_DELAY_MS === 3 * MIN && EXPERIENCES_GEOCODE_BOOT_DELAY_MS === 6 * MIN && AGENTS_GEOCODE_BOOT_DELAY_MS === 9 * MIN,
      "G4: geocode first ticks staggered at +3/+6/+9 min");

    // scheduleBootTrustRecalc with a fake timer: delay used, skip when < 24 h, run + stamp otherwise.
    const sdb = new Database(":memory:");
    const nowS = new Date("2026-10-08T12:00:00Z");
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const fakeSet = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return 0; };
    let recalcs = 0;
    const logs: string[] = [];
    const sched = () => scheduleBootTrustRecalc({
      getDb: () => sdb, recalc: async () => { recalcs++; }, log: (m) => logs.push(m), now: () => nowS, setTimeoutFn: fakeSet,
    });
    sched();
    t(timers.length === 1 && timers[0].ms === TRUST_RECALC_BOOT_DELAY_MS && recalcs === 0, "G5: scheduled with the 4 min delay, nothing runs at once");
    timers[0].fn();
    await runExclusiveBootJob(() => undefined);
    t(recalcs === 1, "G6: first boot (no stamp) runs the recalculation");
    t(getJobLastCompletedAt(sdb, TRUST_RECALC_JOB)?.getTime() === nowS.getTime(), "G7: completion is stamped in boot_job_state");
    sched(); timers[1].fn();
    await runExclusiveBootJob(() => undefined);
    t(recalcs === 1 && logs.some((l) => l.includes("skipped")), "G8: a restart within 24 h skips the recalculation");
    markJobCompleted(sdb, TRUST_RECALC_JOB, new Date(nowS.getTime() - 25 * 3600_000));
    sched(); timers[2].fn();
    await runExclusiveBootJob(() => undefined);
    t(recalcs === 2, "G9: a stamp older than 24 h runs again");
    markJobCompleted(sdb, TRUST_RECALC_JOB, new Date(nowS.getTime() - 25 * 3600_000));
    scheduleBootTrustRecalc({ getDb: () => sdb, recalc: async () => { throw new Error("boom"); }, now: () => nowS, setTimeoutFn: fakeSet });
    const origErr = console.error; console.error = () => {};
    try { timers[3].fn(); await runExclusiveBootJob(() => undefined); } finally { console.error = origErr; }
    t(getJobLastCompletedAt(sdb, TRUST_RECALC_JOB)?.getTime() === nowS.getTime() - 25 * 3600_000, "G10: a failed recalculation is not stamped (retried next boot)");

    // Wiring guard: index.ts uses the constants instead of the old literals.
    const fsMod = require("fs") as typeof import("fs");
    const idx = fsMod.readFileSync(require("path").join(__dirname, "..", "index.ts"), "utf8");
    t(/scheduleBootTrustRecalc\(\{/.test(idx) && !/\}, 2000\); \/\/ 2 second delay/.test(idx), "G11: index.ts schedules boot-trust-recalc via the gate helper");
    t(/setTimeout\(\(\) => prewarmTrafficStats\(\[[^\]]*\]\), TRAFFIC_PREWARM_BOOT_DELAY_MS\)/.test(idx), "G12: index.ts delays prewarmTrafficStats");
    t(/\}\), DENTAL_GEOCODE_BOOT_DELAY_MS\)/.test(idx) && /\}\), EXPERIENCES_GEOCODE_BOOT_DELAY_MS\)/.test(idx),
      "G13: index.ts uses the staggered dental/experiences geocode delays");

    // trust calculate(): cached prepared statements give identical, non-stale results.
    const cdb = new Database(":memory:");
    cdb.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, is_active INTEGER DEFAULT 1, trust_score REAL, is_verified INTEGER DEFAULT 0,
      description TEXT, city TEXT, categories TEXT, tags TEXT, last_seen_at TEXT, created_at TEXT);
      CREATE TABLE agent_claims (agent_id TEXT, status TEXT);
      CREATE TABLE agent_knowledge (agent_id TEXT, owner_updated_at TEXT, last_enriched_at TEXT, updated_at TEXT, google_rating REAL, google_review_count INTEGER);
      CREATE TABLE agent_metrics (agent_id TEXT, last_interaction_at TEXT, times_discovered INTEGER, times_contacted INTEGER, times_chosen INTEGER);
      INSERT INTO agents (id, is_verified, created_at) VALUES ('c1', 0, datetime('now'));`);
    let prev2: any = null;
    try { prev2 = getDb(); } catch { prev2 = null; }
    __setDbForTesting(cdb);
    try {
      const s1 = trustScoreService.calculate("c1");
      const s2 = trustScoreService.calculate("c1");
      cdb.prepare("UPDATE agents SET is_verified = 1 WHERE id = 'c1'").run();
      const s3 = trustScoreService.calculate("c1");
      t(s1 === s2 && s1 >= 0 && s1 <= 1, "G14: repeated calculate() (statement cache) is stable");
      t(s3 > s1, "G15: cached statements still see fresh data (verification raises the score)");
    } finally {
      if (prev2) __setDbForTesting(prev2);
    }
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
