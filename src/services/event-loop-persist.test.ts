/**
 * event-loop-persist.test.ts — dev-request 2026-10-08-serverheng-hovedtraad-
 * oppstart-statistikk-samtaler, slice 1. Tests for services/event-loop-persist.ts
 * and the trackJob wall-vs-blocking split in event-loop-monitor.ts.
 *
 * The DDL is read out of database/init.ts (not copied) so the test fails if
 * the CREATE TABLE and the SQL ever drift apart.
 *
 * Sections: A persist + read-back across a simulated restart (file DB, two
 * "boots"); B since_hours filtering; C batched prune; D rate cap / failure
 * safety; E trackJob wall vs blocking; F route wiring of ?since_hours.
 *
 * Standalone: npx tsx src/services/event-loop-persist.test.ts
 */

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import * as elm from "./event-loop-monitor";
import * as ep from "./event-loop-persist";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function loadDdl(): string {
  const src = fs.readFileSync(path.join(__dirname, "..", "database", "init.ts"), "utf8");
  const m = src.match(/CREATE TABLE IF NOT EXISTS event_loop_events \([\s\S]*?\);\s*CREATE INDEX IF NOT EXISTS idx_event_loop_events_ts[^;]*;/);
  if (!m) throw new Error("event_loop_events DDL not found in init.ts");
  return m[0];
}

export async function runEventLoopPersistTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "elp-"));
  const dbFile = path.join(tmp, "t.db");
  const ddl = loadDdl();
  const NOW = Date.parse("2026-10-08T12:00:00.000Z");
  const H = 3_600_000;

  try {
    // ── A. persist + read back across a simulated restart ──────────
    {
      const db1 = new Database(dbFile);
      db1.exec(ddl);
      ep.__resetEventLoopPersistForTesting();
      ep.startEventLoopPersistence({ getDb: () => db1, gitSha: "sha-old", bootedAt: "2026-10-08T10:00:00.000Z", flushMs: 3_600_000 });
      elm.__resetEventLoopMonitorForTesting();
      let t = NOW;
      elm.__configureEventLoopMonitorForTesting({ stallMs: 1000, heartbeatMs: 500, slowRequestMs: 100, slowJobMs: 100 }, { now: () => t, log: () => {} });
      // sink survives __configure (it only resets on __reset), but __reset cleared it: re-register
      ep.startEventLoopPersistence({ getDb: () => db1, gitSha: "sha-old", bootedAt: "2026-10-08T10:00:00.000Z", flushMs: 3_600_000 });

      // stall
      t += 5000;
      elm.__heartbeatForTesting();
      // slow request
      const res: any = new (require("events").EventEmitter)();
      res.statusCode = 200;
      elm.requestTrackerMiddleware({ method: "GET", originalUrl: "/slow?x=1", hostname: "h" }, res, () => {});
      t += 300;
      res.emit("finish");
      // slow job
      elm.trackJob("elp-job", () => { t += 400; })();

      assertTrue(ep.getEventLoopPersistStats().buffered === 3, "A1: three events buffered, nothing written synchronously on the hot path");
      assertTrue((db1.prepare("SELECT COUNT(*) c FROM event_loop_events").get() as any).c === 0, "A2: table still empty before flush");
      assertTrue(ep.flushEventLoopEvents() === 3, "A3: flush writes all three");
      ep.stopEventLoopPersistence();
      db1.close();

      // "restart": new connection, new process-level deps
      const db2 = new Database(dbFile);
      db2.exec(ddl); // idempotent
      const rows = ep.readPersistedEventLoopEvents(db2, 24, { now: NOW + 10_000 });
      const kinds = rows.map((r) => r.kind).sort().join(",");
      assertTrue(kinds === "job,request,stall", "A4: all three kinds readable after restart (" + kinds + ")");
      const stall = rows.find((r) => r.kind === "stall")!;
      assertTrue(stall.duration_ms === 4500 && stall.git_sha === "sha-old" && stall.booted_at === "2026-10-08T10:00:00.000Z", "A5: stall row carries duration, git_sha and booted_at");
      assertTrue(!!stall.extra && typeof stall.extra === "object" && "finishedDuringBlock" in (stall.extra as any), "A6: extra JSON (suspects) round-trips");
      const job = rows.find((r) => r.kind === "job")!;
      assertTrue(job.label === "elp-job" && (job.extra as any).blockingMs === 400, "A7: job row has label and blockingMs in extra");
      const rq = rows.find((r) => r.kind === "request")!;
      assertTrue(rq.label === "GET h/slow" && !String(rq.label).includes("x=1"), "A8: request label is route only (query stripped)");
      db2.close();
    }

    // ── B. since_hours filtering ───────────────────────────────────
    {
      const db = new Database(":memory:");
      db.exec(ddl);
      const ins = db.prepare("INSERT INTO event_loop_events (ts, kind, duration_ms, label) VALUES (?, 'stall', 1500, 'x')");
      ins.run(new Date(NOW - 1 * H).toISOString());
      ins.run(new Date(NOW - 30 * H).toISOString());
      ins.run(new Date(NOW - 100 * H).toISOString());
      assertTrue(ep.readPersistedEventLoopEvents(db, 2, { now: NOW }).length === 1, "B1: since_hours=2 returns only the last 2h");
      assertTrue(ep.readPersistedEventLoopEvents(db, 72, { now: NOW }).length === 2, "B2: since_hours=72 spans 'restarts' (2 rows)");
      assertTrue(ep.readPersistedEventLoopEvents(db, 336, { now: NOW }).length === 3, "B3: since_hours=336 returns all");
      assertTrue(ep.readPersistedEventLoopEvents(db, 336, { now: NOW, limit: 2 }).length === 2, "B4: limit respected");
      db.close();
    }

    // ── C. prune is batched and respects the 14-day cutoff ─────────
    {
      const db = new Database(":memory:");
      db.exec(ddl);
      const ins = db.prepare("INSERT INTO event_loop_events (ts, kind, duration_ms, label) VALUES (?, 'job', 1, 'x')");
      for (let i = 0; i < 25; i++) ins.run(new Date(NOW - 20 * 86_400_000 - i * 1000).toISOString());
      for (let i = 0; i < 5; i++) ins.run(new Date(NOW - 2 * 86_400_000 - i * 1000).toISOString());
      let yields = 0;
      const p = ep.pruneEventLoopEvents(db, { now: NOW, batch: 10 });
      setImmediate(() => { yields++; });
      const deleted = await p;
      assertTrue(deleted === 25, "C1: 25 old rows deleted (got " + deleted + ")");
      assertTrue((db.prepare("SELECT COUNT(*) c FROM event_loop_events").get() as any).c === 5, "C2: recent rows kept");
      assertTrue(yields === 1, "C3: prune yielded to the event loop between batches");
      assertTrue((await ep.pruneEventLoopEvents(db, { now: NOW })) === 0, "C4: second prune is a no-op");
      db.close();
    }

    // ── D. rate cap + failure safety ───────────────────────────────
    {
      const db = new Database(":memory:");
      db.exec(ddl);
      ep.__resetEventLoopPersistForTesting();
      ep.startEventLoopPersistence({ getDb: () => db, gitSha: "s", bootedAt: "b", flushMs: 3_600_000, maxPerFlush: 5, maxBuffer: 8 });
      for (let i = 0; i < 20; i++) ep.__enqueueForTesting({ ts: NOW, kind: "job", durationMs: 10, label: "n" + i });
      assertTrue(ep.getEventLoopPersistStats().buffered === 8 && ep.getEventLoopPersistStats().dropped === 12, "D1: buffer capped, overflow counted as dropped");
      ep.flushEventLoopEvents();
      assertTrue((db.prepare("SELECT COUNT(*) c FROM event_loop_events").get() as any).c === 5, "D2: at most maxPerFlush rows written per flush");
      ep.stopEventLoopPersistence();

      const bad = new Database(":memory:"); // no table
      ep.startEventLoopPersistence({ getDb: () => bad, gitSha: "s", bootedAt: "b", flushMs: 3_600_000 });
      ep.__enqueueForTesting({ ts: NOW, kind: "stall", durationMs: 2000, label: "l" });
      let threw = false;
      try { ep.flushEventLoopEvents(); } catch { threw = true; }
      assertTrue(!threw && ep.getEventLoopPersistStats().flushErrors === 1, "D3: a failing flush never throws (counted)");
      ep.stopEventLoopPersistence();
      elm.setEventLoopEventSink(() => { throw new Error("boom"); });
      let mthrew = false;
      try { elm.trackJob("d4-job", () => 1)(); elm.__configureEventLoopMonitorForTesting({ slowJobMs: 0 }); } catch { mthrew = true; }
      assertTrue(!mthrew, "D4: a throwing sink never propagates into trackJob");
      elm.setEventLoopEventSink(null);
      db.close();
      bad.close();
    }

    // ── E. trackJob: wall-clock vs blocking time ───────────────────
    {
      elm.__resetEventLoopMonitorForTesting();
      let t = NOW;
      const logs: string[] = [];
      elm.__configureEventLoopMonitorForTesting({ stallMs: 1000, heartbeatMs: 500, slowJobMs: 100 }, { now: () => t, log: (l) => logs.push(l) });
      // async job: 10 ms synchronous, then waits "5000 ms" (clock advanced while awaiting)
      const asyncJob = elm.trackJob("e-async", async () => {
        t += 10;
        await Promise.resolve();
        t += 5000;
      });
      await asyncJob();
      const rep = elm.getEventLoopReport();
      const aj = rep.slowJobs.find((j) => j.name === "e-async")!;
      assertTrue(!!aj && aj.durationMs === 5010 && aj.blockingMs === 10, "E1: async job records wall=5010 and blocking=10");
      // heartbeat late by 6s right after: async job must NOT be a suspect
      t += 0;
      elm.__heartbeatForTesting();
      const st = elm.getEventLoopReport().stalls[0];
      assertTrue(!!st && !st.finishedDuringBlock.some((f) => f.label === "e-async"), "E2: long-awaiting async job is not listed as a stall suspect");
      // sync job blocks 3 s: wall == blocking and it IS a suspect
      elm.__heartbeatForTesting(); // reset window
      const syncJob = elm.trackJob("e-sync", () => { t += 3000; });
      syncJob();
      elm.__heartbeatForTesting();
      const st2 = elm.getEventLoopReport().stalls[0];
      const sj = elm.getEventLoopReport().slowJobs.find((j) => j.name === "e-sync")!;
      assertTrue(sj.durationMs === 3000 && sj.blockingMs === 3000, "E3: sync job wall == blocking");
      assertTrue(st2.finishedDuringBlock.some((f) => f.label === "e-sync" && f.durationMs === 3000), "E4: sync blocker is listed as suspect");
      // throwing sync job still records blocking
      let thrown = false;
      try { elm.trackJob("e-throw", () => { t += 500; throw new Error("x"); })(); } catch { thrown = true; }
      const tj = elm.getEventLoopReport().slowJobs.find((j) => j.name === "e-throw")!;
      assertTrue(thrown && tj.blockingMs === 500 && tj.ok === false, "E5: throwing job rethrows and records blocking");
      elm.__resetEventLoopMonitorForTesting();
    }

    // ── F. route wiring ────────────────────────────────────────────
    {
      const analytics = require("../routes/analytics");
      const router: any = analytics.default || analytics;
      const layer = (router.stack || []).find((l: any) => l.route && l.route.path === "/ops/event-loop");
      assertTrue(!!layer, "F1: /ops/event-loop route exists");
      if (layer) {
        const h = layer.route.stack[0].handle;
        const call = (query: any) => {
          let body: any = null;
          let code = 200;
          const res: any = { json(b: any) { body = b; return this; }, status(c: number) { code = c; return this; } };
          h({ query }, res, () => {});
          return { body, code };
        };
        const plain = call({});
        assertTrue(plain.code === 200 && plain.body && !("persisted" in plain.body), "F2: no since_hours keeps the old output (no persisted key)");
        assertTrue(call({ since_hours: "abc" }).code === 400, "F3: invalid since_hours rejected with 400");
        assertTrue(call({ since_hours: "100000" }).code === 400, "F4: out-of-range since_hours rejected with 400");
        const ok = call({ since_hours: "72" });
        assertTrue(ok.code === 200 && ok.body.persisted && ok.body.persisted.sinceHours === 72, "F5: since_hours=72 adds a persisted block");
      }
    }
  } catch (err: any) {
    failed++;
    failures.push("event-loop-persist: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    ep.__resetEventLoopPersistForTesting();
    elm.__resetEventLoopMonitorForTesting();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runEventLoopPersistTests({ log: true }).then((r) => {
    console.log(`\nevent-loop-persist: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
