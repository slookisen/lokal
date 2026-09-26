/**
 * offthread-stats.test.ts — dev-request 2026-09-19-prod-event-loop-stall-mcp-unhealthy (A2A).
 *
 * Covers the fix that moves the homepage traffic stats and the /health page-view
 * counts off the main event loop:
 *   S1–S10  createSwrCache: stale-while-revalidate, de-duplication, failure back-off, clear()
 *   T1–T9   createTrafficStatsReader (injected deps, fake DB handles): the off-thread
 *           path never runs the synchronous computation; the fallback path does
 *   P1–P5   createPageViewHealthCounter: one synchronous fill, then background refreshes
 *   U1–U5   offThreadStatsUsable: in-memory DBs, the kill switch, file DBs, non-WAL DBs
 *   W1–W10  the REAL worker (worker_threads + tsx) against a temp-file SQLite DB:
 *           identical results to the synchronous computation, task errors, timeout,
 *           the per-task fall-back-after-3-failures safety valve, worker replacement
 *           on a DB-path change, and the per-task run report
 *
 * No global DB injection and no await while process.env is modified, so it is safe
 * next to the concurrently running blocks in tests/test.ts. Exported
 * runOffThreadStatsTests({log}); standalone: npx tsx src/services/offthread-stats.test.ts
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createSwrCache,
  offThreadStatsUsable,
  runStatsTaskOffThread,
  getOffThreadStatsState,
  OFFTHREAD_MAX_CONSECUTIVE_FAILURES,
  __resetOffThreadStatsForTesting,
  __setWorkerScriptForTesting,
} from "./offthread-stats";
import { createTrafficStatsReader, type TrafficStatsReaderDeps } from "./traffic-stats";
import { computeTrafficStats, emptyTrafficStats, type TrafficStats } from "./traffic-stats-compute";
import { createPageViewHealthCounter } from "./health-counts";
import { computePageViewCounts, type PageViewCounts } from "./health-counts-compute";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function stats(pageViews: number): TrafficStats {
  return { ...emptyTrafficStats(60), pageViews, humanViews: pageViews, realHumans: pageViews };
}

const walPragma = () => "wal";
const FILE_DB = { name: "/data/lokal.db", memory: false, pragma: walPragma } as unknown as Database.Database;
const OTHER_FILE_DB = { name: "/data/other.db", memory: false, pragma: walPragma } as unknown as Database.Database;

export async function runOffThreadStatsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string, detail?: unknown): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}${detail === undefined ? "" : `\n    got: ${JSON.stringify(detail)}`}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // ── S: createSwrCache ─────────────────────────────────────────────
  {
    let t = 1_000;
    const calls: string[] = [];
    let d = deferred<number>();
    const errors: unknown[] = [];
    const swr = createSwrCache<number>({
      ttlMs: 100,
      retryAfterMs: 50,
      now: () => t,
      refresh: (key) => {
        calls.push(key);
        return d.promise;
      },
      onError: (_k, e) => errors.push(e),
    });

    ok(swr.get("a") === undefined && eq(calls, ["a"]), "S1: a missing key returns undefined and starts one refresh", calls);
    swr.get("a");
    swr.get("a");
    ok(calls.length === 1, "S2: reads while a refresh is in flight do not start another", calls);
    d.resolve(7);
    await swr.settled("a");
    const hit = swr.get("a");
    ok(!!hit && hit.value === 7 && hit.ageMs === 0 && calls.length === 1, "S3: the refreshed value is served; fresh reads do not refresh", { hit, calls });
    t += 100;
    d = deferred<number>();
    const stale = swr.get("a");
    ok(!!stale && stale.value === 7 && stale.ageMs === 100 && calls.length === 2, "S4: at the TTL the stale value is returned immediately and a refresh starts", { stale, calls });
    d.reject(new Error("boom"));
    await swr.settled("a");
    const kept = swr.get("a");
    ok(!!kept && kept.value === 7 && errors.length === 1 && calls.length === 2, "S5: a failed refresh keeps the old value, reports the error, and backs off", { kept, calls });
    t += 49;
    swr.get("a");
    ok(calls.length === 2, "S6: no retry inside the back-off window", calls);
    t += 1;
    d = deferred<number>();
    swr.get("a");
    ok(calls.length === 3, "S7: the retry happens once the back-off has passed", calls);
    d.resolve(8);
    await swr.settled("a");

    const throwing = createSwrCache<number>({
      ttlMs: 10,
      now: () => t,
      refresh: () => {
        throw new Error("sync throw");
      },
      onError: () => {
        throw new Error("logger throws too");
      },
    });
    let threw = false;
    try {
      throwing.get("x");
      await throwing.settled("x");
    } catch {
      threw = true;
    }
    ok(!threw && throwing.get("x") === undefined, "S8: a refresh that throws synchronously (and a throwing logger) never escapes get()");

    t -= 10_000;
    d = deferred<number>();
    swr.get("a");
    ok(calls.length === 4, "S9: a clock that moved backwards counts as stale and refreshes", calls);
    d.resolve(9);
    await swr.settled("a");

    // S10: a refresh that started before clear() must not land in the cleared
    // cache, and must not break de-duplication of the refresh started after it.
    const oldD = deferred<number>();
    const newD = deferred<number>();
    let n = 0;
    const cl = createSwrCache<number>({ ttlMs: 100, now: () => t, refresh: () => (n++ === 0 ? oldD.promise : newD.promise) });
    cl.get("k");
    cl.clear();
    cl.get("k");
    oldD.resolve(111);
    await flush();
    cl.get("k");
    const afterOld = cl.get("k");
    newD.resolve(222);
    await cl.settled("k");
    const afterNew = cl.get("k");
    ok(afterOld === undefined && n === 2 && !!afterNew && afterNew.value === 222,
      "S10: after clear() the old in-flight refresh is ignored and the new one is not duplicated", { afterOld, n, afterNew });
  }

  // ── T: createTrafficStatsReader ───────────────────────────────────
  {
    let t = 10_000;
    let db: Database.Database = FILE_DB;
    let usable = true;
    let dbThrows = false;
    const offCalls: Array<{ dbPath: string; vertical: string | undefined }> = [];
    const syncCalls: Array<string | undefined> = [];
    let off = deferred<TrafficStats>();
    const logs: string[] = [];
    const deps: TrafficStatsReaderDeps = {
      getDb: () => {
        if (dbThrows) throw new Error("db not open");
        return db;
      },
      offThreadUsable: () => usable,
      runOffThread: (dbPath, vertical) => {
        offCalls.push({ dbPath, vertical });
        return off.promise;
      },
      computeSync: (_db, vertical) => {
        syncCalls.push(vertical);
        return stats(500);
      },
      now: () => t,
      syncTtlMs: 120_000,
      offThreadTtlMs: 600_000,
      retryAfterMs: 60_000,
      log: (m) => logs.push(m),
    };
    const reader = createTrafficStatsReader(deps);

    const first = reader.snapshot("rfb");
    ok(!first.ready && first.stats.pageViews === 0 && eq(offCalls, [{ dbPath: "/data/lokal.db", vertical: "rfb" }]) && syncCalls.length === 0,
      "T1: first read on the off-thread path returns placeholder zeros (ready=false) and starts the worker task", { first, offCalls, syncCalls });
    off.resolve(stats(42));
    await reader.settled("rfb");
    const second = reader.snapshot("rfb");
    ok(second.ready && second.stats.pageViews === 42 && offCalls.length === 1, "T2: once the worker answers, the real stats are served from cache", { second, offCalls });
    t += 600_000;
    off = deferred<TrafficStats>();
    const stale = reader.snapshot("rfb");
    ok(stale.ready && stale.stats.pageViews === 42 && offCalls.length === 2 && syncCalls.length === 0,
      "T3: stale stats are returned immediately while one background refresh runs — never the synchronous computation", { stale, offCalls, syncCalls });
    off.reject(new Error("worker down"));
    await reader.settled("rfb");
    const afterFail = reader.snapshot("rfb");
    ok(afterFail.stats.pageViews === 42 && logs.length === 1 && /worker down/.test(logs[0]), "T4: a failed refresh keeps serving the last value and logs", { afterFail, logs });

    off = deferred<TrafficStats>();
    reader.snapshot();
    ok(offCalls[offCalls.length - 1].vertical === undefined, "T5: no vertical means the all-traffic key (vertical undefined)", offCalls);
    off.resolve(stats(1));
    await reader.settled();

    db = OTHER_FILE_DB;
    off = deferred<TrafficStats>();
    const moved = reader.snapshot("rfb");
    ok(!moved.ready && offCalls[offCalls.length - 1].dbPath === "/data/other.db", "T6: a different DB file drops the old cache", { moved, offCalls });
    off.resolve(stats(3));
    await reader.settled("rfb");

    usable = false;
    const syncFirst = reader.snapshot("dental");
    const syncCached = reader.snapshot("dental");
    ok(syncFirst.ready && syncFirst.stats.pageViews === 500 && syncCached.stats.pageViews === 500 && eq(syncCalls, ["dental"]),
      "T7: the fallback path computes synchronously and caches for the sync TTL", { syncCalls });
    t += 120_000;
    reader.snapshot("dental");
    ok(eq(syncCalls, ["dental", "dental"]), "T8: the fallback path recomputes after its TTL", syncCalls);

    const before = offCalls.length;
    reader.prewarm("experiences");
    ok(syncCalls.length === 2 && offCalls.length === before, "T9: prewarm on the fallback path does nothing (no synchronous scan at boot)", { syncCalls, offCalls });
    usable = true;
    off = deferred<TrafficStats>();
    reader.prewarm("experiences");
    ok(offCalls.length === before + 1 && offCalls[offCalls.length - 1].vertical === "experiences", "T10: prewarm on the off-thread path starts the worker task", offCalls);
    off.resolve(stats(5));
    await reader.settled("experiences");

    dbThrows = true;
    const noDb = reader.snapshot("rfb");
    ok(!noDb.ready && noDb.stats.pageViews === 0, "T11: an unavailable DB yields zeros and ready=false, never a throw", noDb);
  }

  // ── P: createPageViewHealthCounter ────────────────────────────────
  {
    let t = 50_000;
    let usable = true;
    const syncCalls: number[] = [];
    const offCalls: Array<{ dbPath: string; nowMs: number }> = [];
    let off = deferred<PageViewCounts>();
    const counter = createPageViewHealthCounter({
      offThreadUsable: () => usable,
      runOffThread: (dbPath, nowMs) => {
        offCalls.push({ dbPath, nowMs });
        return off.promise;
      },
      computeSync: (_db, nowMs) => {
        syncCalls.push(nowMs);
        return { pageViews: 100, lastHourPageViews: 5 };
      },
      now: () => t,
      offThreadTtlMs: 60_000,
      retryAfterMs: 60_000,
      log: () => {},
    });

    const first = counter.get(FILE_DB, t, 60_000);
    ok(eq(first, { pageViews: 100, lastHourPageViews: 5, cachedAgeMs: 0 }) && syncCalls.length === 1 && offCalls.length === 0,
      "P1: the first call after boot fills synchronously once (exact numbers, no placeholder zeros)", { first, syncCalls, offCalls });
    t += 30_000;
    const cached = counter.get(FILE_DB, t, 60_000);
    ok(cached.cachedAgeMs === 30_000 && syncCalls.length === 1 && offCalls.length === 0, "P2: within the TTL the cached counts are served", { cached });
    t += 30_000;
    const stale = counter.get(FILE_DB, t, 60_000);
    ok(stale.pageViews === 100 && stale.cachedAgeMs === 60_000 && syncCalls.length === 1 && eq(offCalls, [{ dbPath: "/data/lokal.db", nowMs: t }]),
      "P3: at the TTL the stale counts are served and the refresh runs off-thread, not synchronously", { stale, syncCalls, offCalls });
    off.resolve({ pageViews: 130, lastHourPageViews: 9 });
    await counter.settled();
    const fresh = counter.get(FILE_DB, t, 60_000);
    ok(fresh.pageViews === 130 && fresh.lastHourPageViews === 9 && fresh.cachedAgeMs === 0, "P4: the worker's counts replace the cache", fresh);

    usable = false;
    const syncPath = counter.get(FILE_DB, t, 60_000);
    ok(syncPath.pageViews === 100 && syncCalls.length === 2, "P5: the fallback path keeps the original synchronous 60 s cache", { syncPath, syncCalls });
  }

  // ── U: offThreadStatsUsable (synchronous: env restored before any await) ──
  {
    const prev = process.env.OFFTHREAD_STATS_DISABLED;
    const mem = new Database(":memory:");
    try {
      delete process.env.OFFTHREAD_STATS_DISABLED;
      ok(offThreadStatsUsable(mem) === false, "U1: an in-memory DB never uses the worker");
      ok(offThreadStatsUsable(FILE_DB) === true, "U2: a file-backed DB uses the worker");
      process.env.OFFTHREAD_STATS_DISABLED = "1";
      ok(offThreadStatsUsable(FILE_DB) === false, "U3: OFFTHREAD_STATS_DISABLED=1 is a kill switch");
      process.env.OFFTHREAD_STATS_DISABLED = "0";
      ok(offThreadStatsUsable(FILE_DB) === true, "U4: any other value leaves the worker enabled");
      const rollbackDb = { name: "/data/rollback.db", memory: false, pragma: () => "delete" } as unknown as Database.Database;
      ok(offThreadStatsUsable(rollbackDb) === false,
        "U5: a DB outside WAL mode never uses the worker (a long read would block the main thread's writes)");
    } finally {
      if (prev === undefined) delete process.env.OFFTHREAD_STATS_DISABLED;
      else process.env.OFFTHREAD_STATS_DISABLED = prev;
      mem.close();
    }
  }

  // ── W: the real worker against a temp-file DB ─────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offthread-stats-"));
  const dbPath = path.join(tmp, "stats.db");
  const writer = new Database(dbPath);
  try {
    __resetOffThreadStatsForTesting();
    writer.pragma("journal_mode = WAL");
    writer.exec(`
      CREATE TABLE analytics_page_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, session_id TEXT,
        created_at TEXT DEFAULT (datetime('now')), is_owner INTEGER DEFAULT 0,
        vertical_id TEXT NOT NULL DEFAULT 'rfb'
      );
      CREATE TABLE analytics_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT, is_owner INTEGER DEFAULT 0,
        vertical_id TEXT NOT NULL DEFAULT 'rfb'
      );
    `);
    const ins = writer.prepare("INSERT INTO analytics_page_views (path, session_id, created_at, is_owner, vertical_id) VALUES (?,?,?,?,?)");
    const recent = new Date(Date.now() - 10 * 60_000).toISOString().replace("T", " ").slice(0, 19);
    const old = "2026-01-01 00:00:00";
    const rows: Array<[string, string, string, number, string]> = [
      ["/", "ip1:desktop:aaaa", recent, 0, "rfb"],
      ["/sok", "ip1:desktop:aaaa", old, 0, "rfb"],
      ["/", "ip2:Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", old, 0, "rfb"],
      ["/", "ip3:Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", recent, 0, "rfb"],
      ["/wp-admin/setup.php", "ip4:mobile:bbbb", old, 0, "rfb"],
      ["/", "ip5:desktop:cccc", recent, 1, "rfb"],
      ["/", "ip6:desktop:dddd", recent, 0, "dental"],
    ];
    for (const r of rows) ins.run(...r);
    writer.prepare("INSERT INTO analytics_queries (query, vertical_id) VALUES (?, ?)").run("epler", "rfb");

    const expectedRfb = computeTrafficStats(writer, "rfb", 60);
    const gotRfb = await runStatsTaskOffThread<TrafficStats>(dbPath, { kind: "trafficStats", vertical: "rfb", windowDays: 60 });
    ok(eq(gotRfb, expectedRfb) && expectedRfb.pageViews === 5, "W1: the worker computes exactly what the synchronous function computes (rfb)", { gotRfb, expectedRfb });

    const nowMs = Date.now();
    const expectedPv = computePageViewCounts(writer, nowMs);
    const gotPv = await runStatsTaskOffThread<PageViewCounts>(dbPath, { kind: "pageViewCounts", nowMs });
    ok(eq(gotPv, expectedPv) && expectedPv.pageViews === 7, "W2: the worker's /health counts match the synchronous ones", { gotPv, expectedPv });

    ins.run("/", "ip7:desktop:eeee", recent, 0, "rfb");
    const afterWrite = await runStatsTaskOffThread<TrafficStats>(dbPath, { kind: "trafficStats", vertical: "rfb", windowDays: 60 });
    ok(afterWrite.pageViews === 6, "W3: the worker's read-only connection sees rows the main connection wrote after it opened", afterWrite);

    let taskErr = "";
    try {
      await runStatsTaskOffThread(dbPath, { kind: "nope" } as any);
    } catch (e) {
      taskErr = (e as Error).message;
    }
    const again = await runStatsTaskOffThread<PageViewCounts>(dbPath, { kind: "pageViewCounts", nowMs });
    ok(/unknown stats task/.test(taskErr) && again.pageViews === 8, "W4: a failing task rejects with its error and the worker keeps serving", { taskErr, again });

    __resetOffThreadStatsForTesting();
    let timeoutErr = "";
    try {
      await runStatsTaskOffThread(dbPath, { kind: "pageViewCounts", nowMs }, 1);
    } catch (e) {
      timeoutErr = (e as Error).message;
    }
    const st = getOffThreadStatsState();
    ok(/timed out/.test(timeoutErr) && !st.workerRunning && st.consecutiveFailures === 1, "W5: a task over its timeout rejects and the stuck worker is replaced", { timeoutErr, st });
    const recovered = await runStatsTaskOffThread<PageViewCounts>(dbPath, { kind: "pageViewCounts", nowMs });
    ok(recovered.pageViews === 8 && getOffThreadStatsState().consecutiveFailures === 0, "W6: the next task starts a fresh worker and a success resets the failure count", getOffThreadStatsState());

    __resetOffThreadStatsForTesting();
    __setWorkerScriptForTesting(path.join(tmp, "does-not-exist.ts"));
    const errs: string[] = [];
    for (let i = 0; i < OFFTHREAD_MAX_CONSECUTIVE_FAILURES; i++) {
      try {
        await runStatsTaskOffThread(dbPath, { kind: "pageViewCounts", nowMs });
      } catch (e) {
        errs.push((e as Error).message);
      }
    }
    const brokenState = getOffThreadStatsState();
    const prev = process.env.OFFTHREAD_STATS_DISABLED;
    delete process.env.OFFTHREAD_STATS_DISABLED;
    const usableWhenBroken = offThreadStatsUsable({ name: dbPath, memory: false, pragma: walPragma } as unknown as Database.Database);
    if (prev === undefined) delete process.env.OFFTHREAD_STATS_DISABLED;
    else process.env.OFFTHREAD_STATS_DISABLED = prev;
    ok(errs.length === OFFTHREAD_MAX_CONSECUTIVE_FAILURES && brokenState.broken && usableWhenBroken === false,
      "W7: a worker that cannot start fails its tasks, and after 3 failures in a row callers fall back to the synchronous path", { errs, brokenState, usableWhenBroken });

    // W8: failures are counted per task — another task's successes do not
    // reset a task that keeps failing, so the safety valve still trips.
    __resetOffThreadStatsForTesting();
    for (let i = 0; i < OFFTHREAD_MAX_CONSECUTIVE_FAILURES; i++) {
      try {
        await runStatsTaskOffThread(dbPath, { kind: "nope" } as any);
      } catch {
        // expected
      }
      await runStatsTaskOffThread<PageViewCounts>(dbPath, { kind: "pageViewCounts", nowMs });
    }
    const perTask = getOffThreadStatsState();
    ok(perTask.broken && perTask.failuresByTask["nope"] === OFFTHREAD_MAX_CONSECUTIVE_FAILURES && perTask.failuresByTask["pageViewCounts"] === 0,
      "W8: a task failing 3 times in a row trips the fallback even while another task keeps succeeding", perTask);

    // W9: switching DB file replaces the worker; tasks queued on the old one
    // are rejected right away without being charged as failures.
    __resetOffThreadStatsForTesting();
    const otherPath = path.join(tmp, "other.db");
    const other = new Database(otherPath);
    other.pragma("journal_mode = WAL");
    other.exec("CREATE TABLE analytics_page_views (id INTEGER PRIMARY KEY, path TEXT, created_at TEXT)");
    other.close();
    const onOld = runStatsTaskOffThread<PageViewCounts>(dbPath, { kind: "pageViewCounts", nowMs });
    const onNew = runStatsTaskOffThread<PageViewCounts>(otherPath, { kind: "pageViewCounts", nowMs });
    let oldErr = "";
    try {
      await onOld;
    } catch (e) {
      oldErr = (e as Error).message;
    }
    const newRes = await onNew;
    const swapState = getOffThreadStatsState();
    ok(/replaced/.test(oldErr) && newRes.pageViews === 0 && swapState.consecutiveFailures === 0 && swapState.pendingTasks === 0,
      "W9: a DB-path change rejects the old worker's queued tasks at once, without blame", { oldErr, newRes, swapState });

    // W10: the admin report records each task's last run.
    const run = swapState.lastRuns["pageViewCounts"];
    ok(!!run && run.ok === true && run.durationMs >= 0 && typeof run.at === "string",
      "W10: the last run of each task (ok, duration, time) is reported", swapState.lastRuns);
  } catch (e) {
    ok(false, "W: worker tests threw", (e as Error).stack);
  } finally {
    __resetOffThreadStatsForTesting();
    writer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOffThreadStatsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
