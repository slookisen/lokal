/**
 * event-loop-monitor.test.ts — dev-request 2026-09-19-prod-event-loop-stall-
 * mcp-unhealthy (A2A). Unit tests for src/services/event-loop-monitor.ts.
 *
 * tests/test.ts runs many blocks concurrently in ONE process, so every
 * assertion here is about THIS test's own uniquely-named jobs/paths, and
 * stall detection is driven by an injected clock + a manual heartbeat
 * (section C) rather than by blocking the shared event loop. Section F is
 * the one real-timer check (a 200 ms busy-wait), kept short on purpose.
 *
 * Sections:
 *   A. trackJob — sync/async/throw/reject: return value and errors pass
 *      through unchanged; the job is "active" exactly while it runs; slow
 *      jobs are recorded and logged, fast ones are not.
 *   B. requestTrackerMiddleware — in flight until finish/close (idempotent),
 *      query string stripped, slow requests recorded + logged.
 *   C. Stall detection with an injected clock: a late heartbeat records a
 *      stall with the in-flight requests and active jobs of that moment; an
 *      on-time heartbeat records nothing; the log line names both.
 *   D. Summary/report shape: public summary carries numbers only (no paths),
 *      report is newest-first, ring buffers are capped.
 *   E. Kill switch: EVENT_LOOP_MONITOR_DISABLED=1 starts nothing.
 *   F. Real heartbeat: start → 200 ms synchronous block → a stall ≥ 100 ms
 *      is recorded → stop leaves no timer running.
 *   G. Route wiring: GET /ops/event-loop exists on the analytics router, is
 *      mounted AFTER requireAdminAuth, and returns the report.
 */

import * as elm from "./event-loop-monitor";
import { EventEmitter } from "events";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes(): any {
  const res: any = new EventEmitter();
  res.statusCode = 200;
  return res;
}

export async function runEventLoopMonitorTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDisabled = process.env.EVENT_LOOP_MONITOR_DISABLED;
  delete process.env.EVENT_LOOP_MONITOR_DISABLED;
  let clock = 1_000_000;
  const lines: string[] = [];
  const setup = (overrides: Partial<elm.EventLoopMonitorConfig> = {}) => {
    elm.__resetEventLoopMonitorForTesting();
    lines.length = 0;
    elm.__configureEventLoopMonitorForTesting(
      { heartbeatMs: 500, stallMs: 1000, slowRequestMs: 2000, slowJobMs: 2000, ringSize: 200, ...overrides },
      { now: () => clock, log: (l: string) => lines.push(l) }
    );
  };
  const jobNames = () => elm.getEventLoopReport().activeJobsNow.map((j) => j.name);

  try {
    // ── A. trackJob ─────────────────────────────────────────────────
    setup();
    {
      let seenActive = false;
      const wrapped = elm.trackJob("elm-test-sync", (a: number, b: number) => {
        seenActive = jobNames().includes("elm-test-sync");
        return a + b;
      });
      const r = wrapped(2, 3);
      assertTrue(r === 5, "A1: sync job returns the wrapped function's value, args passed through");
      assertTrue(seenActive, "A2: sync job is listed as active while it runs");
      assertTrue(!jobNames().includes("elm-test-sync"), "A3: sync job is no longer active after it returns");
    }
    {
      const boom = new Error("elm-sync-boom");
      const wrapped = elm.trackJob("elm-test-throw", () => { throw boom; });
      let caught: unknown = null;
      try { wrapped(); } catch (e) { caught = e; }
      assertTrue(caught === boom, "A4: a sync throw is rethrown unchanged");
      assertTrue(!jobNames().includes("elm-test-throw"), "A5: a throwing job is removed from the active set");
    }
    {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      const wrapped = elm.trackJob("elm-test-async", async () => { await gate; return "done"; });
      const p = wrapped();
      assertTrue(jobNames().includes("elm-test-async"), "A6: async job stays active until its promise settles");
      clock += 2500; // make it "slow"
      release();
      const v = await p;
      await new Promise((r) => setImmediate(r));
      assertTrue(v === "done", "A7: async job resolves to the wrapped function's value");
      assertTrue(!jobNames().includes("elm-test-async"), "A8: async job leaves the active set once settled");
      const sj = elm.getEventLoopReport().slowJobs.find((j) => j.name === "elm-test-async");
      assertTrue(!!sj && sj.durationMs === 2500 && sj.ok === true, "A9: a slow async job is recorded with its duration and ok=true");
      assertTrue(lines.some((l) => l === "[slow-job] elm-test-async 2500ms ok=true"), "A10: …and logged as one [slow-job] line");
    }
    {
      const wrapped = elm.trackJob("elm-test-reject", async () => { clock += 3000; throw new Error("elm-reject"); });
      let msg = "";
      await wrapped().catch((e: Error) => { msg = e.message; });
      await new Promise((r) => setImmediate(r));
      assertTrue(msg === "elm-reject", "A11: an async rejection reaches the caller unchanged (not swallowed)");
      const sj = elm.getEventLoopReport().slowJobs.find((j) => j.name === "elm-test-reject");
      assertTrue(!!sj && sj.ok === false, "A12: a slow rejected job is recorded with ok=false");
    }
    {
      const before = elm.getEventLoopReport().slowJobs.length;
      elm.trackJob("elm-test-fast", () => 1)();
      assertTrue(elm.getEventLoopReport().slowJobs.length === before, "A13: a fast job is not recorded as slow");
    }

    // ── B. requestTrackerMiddleware ─────────────────────────────────
    setup();
    {
      const req: any = { method: "POST", hostname: "finn-tannlege.com", originalUrl: "/mcp?token=secret-ish", headers: {} };
      const res = fakeRes();
      let nextCalled = false;
      elm.requestTrackerMiddleware(req, res, () => { nextCalled = true; });
      assertTrue(nextCalled, "B1: middleware calls next()");
      const inflight = elm.getEventLoopReport().inflightNow.find((r) => r.host === "finn-tannlege.com");
      assertTrue(!!inflight && inflight.path === "/mcp" && inflight.method === "POST", "B2: request is in flight, with the query string stripped");
      clock += 2100;
      res.statusCode = 404;
      res.emit("finish");
      res.emit("close"); // must not double-record
      assertTrue(!elm.getEventLoopReport().inflightNow.some((r) => r.host === "finn-tannlege.com"), "B3: request leaves the in-flight set on finish");
      const slow = elm.getEventLoopReport().slowRequests.filter((r) => r.host === "finn-tannlege.com");
      assertTrue(slow.length === 1 && slow[0].durationMs === 2100 && slow[0].status === 404 && slow[0].path === "/mcp",
        "B4: a slow request is recorded exactly once (finish + close), with status, duration and no query");
      assertTrue(lines.includes("[slow-request] POST finn-tannlege.com/mcp 404 2100ms"), "B5: …and logged as one [slow-request] line");
      assertTrue(!lines.some((l) => l.includes("secret-ish")), "B6: the query string never reaches the log");
    }
    {
      const req: any = { method: "GET", hostname: "elm-close.example", url: "/x", headers: {} };
      const res = fakeRes();
      elm.requestTrackerMiddleware(req, res, () => {});
      res.emit("close");
      assertTrue(!elm.getEventLoopReport().inflightNow.some((r) => r.host === "elm-close.example"), "B7: an aborted request (close without finish) also leaves the in-flight set");
    }
    {
      const req: any = { method: "GET", headers: { host: "elm-hostheader.example" }, originalUrl: "/y" };
      const res = fakeRes();
      elm.requestTrackerMiddleware(req, res, () => {});
      assertTrue(elm.getEventLoopReport().inflightNow.some((r) => r.host === "elm-hostheader.example"), "B8: falls back to the Host header when req.hostname is absent");
      res.emit("finish");
      assertTrue(elm.getEventLoopReport().slowRequests.every((r) => r.host !== "elm-hostheader.example"), "B9: a fast request is not recorded as slow");
    }

    // ── C. Stall detection (injected clock) ─────────────────────────
    setup();
    {
      clock += 500; // exactly on time
      elm.__heartbeatForTesting();
      assertTrue(elm.getEventLoopReport().stalls.length === 0, "C1: an on-time heartbeat records no stall");

      const req: any = { method: "GET", hostname: "rettfrabonden.com", originalUrl: "/admin/analytics/heavy", headers: {} };
      const res = fakeRes();
      elm.requestTrackerMiddleware(req, res, () => {});
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      const jobDone = elm.trackJob("elm-test-verifier", async () => { await gate; })();

      clock += 12_500; // heartbeat due after 500 ms, fired 12 500 ms later → lag 12 000
      elm.__heartbeatForTesting();
      const stalls = elm.getEventLoopReport().stalls;
      assertTrue(stalls.length === 1 && stalls[0].lagMs === 12_000, "C2: a late heartbeat records one stall with lag = delay − heartbeat interval");
      assertTrue(stalls[0].inflight.some((r) => r.path === "/admin/analytics/heavy" && r.ageMs === 12_500),
        "C3: the stall snapshot names the request in flight, with its age");
      assertTrue(stalls[0].activeJobs.some((j) => j.name === "elm-test-verifier" && j.ageMs === 12_500),
        "C4: the stall snapshot names the background job running at that moment");
      const line = lines.find((l) => l.startsWith("[event-loop-stall]")) || "";
      assertTrue(line.includes("lag=12000ms") && line.includes("GET rettfrabonden.com/admin/analytics/heavy") && line.includes("elm-test-verifier"),
        "C5: one [event-loop-stall] log line carries lag, request and job");
      release();
      await jobDone;
      res.emit("finish");

      clock += 1400; // 900 ms late: below the 1000 ms stall threshold
      elm.__heartbeatForTesting();
      assertTrue(elm.getEventLoopReport().stalls.length === 1, "C6: lateness below stallMs is not a stall");
    }

    // ── D. Summary / report / caps ──────────────────────────────────
    {
      const summary: any = elm.getEventLoopSummary();
      assertTrue(summary.stallsLast60m === 1 && summary.maxStallLast60mMs === 12_000 && summary.lastStallLagMs === 12_000,
        "D1: summary counts stalls in the last 60 min and reports the max and the last lag");
      assertTrue(typeof summary.lastStallAt === "string" && !JSON.stringify(summary).includes("/admin/analytics/heavy"),
        "D2: the public summary carries numbers/timestamps only — no request paths");
      clock += 61 * 60_000;
      assertTrue(elm.getEventLoopSummary().stallsLast60m === 0, "D3: stalls older than 60 min drop out of stallsLast60m");
    }
    setup({ ringSize: 3 });
    {
      for (let i = 0; i < 5; i++) {
        clock += 500 + 2000 + i;
        elm.__heartbeatForTesting();
      }
      const st = elm.getEventLoopReport().stalls;
      assertTrue(st.length === 3, "D4: the stall ring buffer is capped at ringSize");
      assertTrue(st[0].lagMs === 2004 && st[2].lagMs === 2002, "D5: report lists stalls newest first and keeps the newest");
    }

    // ── C (cont.). Stall snapshot ordering vs long-lived streams ──
    setup();
    {
      // 25 long-lived SSE streams (open for an hour), then the real blocker
      // starts, the loop blocks for 8 s, and one request arrives after it.
      const sse: any[] = [];
      for (let i = 0; i < 25; i++) {
        const res = fakeRes();
        elm.requestTrackerMiddleware({ method: "GET", hostname: `elm-sse-${i}.example`, originalUrl: "/mcp", headers: {} }, res, () => {});
        sse.push(res);
      }
      clock += 3_600_000;
      elm.__configureEventLoopMonitorForTesting(); // heartbeat on time up to here
      const culpritRes = fakeRes();
      elm.requestTrackerMiddleware({ method: "GET", hostname: "elm-culprit.example", originalUrl: "/admin/heavy", headers: {} }, culpritRes, () => {});
      clock += 8_600; // heartbeat 500 ms → lag 8 100
      const lateRes = fakeRes();
      elm.requestTrackerMiddleware({ method: "GET", hostname: "elm-late.example", originalUrl: "/after", headers: {} }, lateRes, () => {});
      elm.__heartbeatForTesting();
      const st = elm.getEventLoopReport().stalls[0];
      assertTrue(!!st && st.inflight[0] && st.inflight[0].host === "elm-culprit.example",
        "C7: the stall snapshot leads with the request that started just before the block, not hour-old SSE streams");
      assertTrue(!!st && !st.inflight.some((r) => r.host === "elm-late.example") && st.inflight.length === 20 && st.inflightTotal === 27,
        "C8: requests that arrived after the block are excluded; the list is capped at 20 but inflightTotal counts all");
      for (const r of [...sse, culpritRes, lateRes]) r.emit("finish");
    }

    // ── E. Kill switch ──────────────────────────────────────────────
    elm.__resetEventLoopMonitorForTesting();
    process.env.EVENT_LOOP_MONITOR_DISABLED = "1";
    {
      const started = elm.startEventLoopMonitor({ heartbeatMs: 20 });
      assertTrue(started === false && elm.getEventLoopSummary().monitoring === false, "E1: EVENT_LOOP_MONITOR_DISABLED=1 starts no heartbeat");
    }
    delete process.env.EVENT_LOOP_MONITOR_DISABLED;

    // ── F. Real heartbeat ───────────────────────────────────────────
    elm.__resetEventLoopMonitorForTesting();
    {
      const realLines: string[] = [];
      const started = elm.startEventLoopMonitor(
        { heartbeatMs: 20, stallMs: 100, slowRequestMs: 60_000, slowJobMs: 60_000, ringSize: 50 },
        { log: (l: string) => realLines.push(l) }
      );
      assertTrue(started === true && elm.getEventLoopSummary().monitoring === true, "F1: monitor starts");
      await new Promise((r) => setTimeout(r, 60));
      const spinUntil = Date.now() + 200;
      elm.trackJob("elm-test-busy", () => { while (Date.now() < spinUntil) { /* block the loop */ } })();
      await new Promise((r) => setTimeout(r, 80));
      const st = elm.getEventLoopReport().stalls;
      assertTrue(st.some((s) => s.lagMs >= 100), "F2: a real 200 ms synchronous block is recorded as a stall ≥ 100 ms");
      const s: any = elm.getEventLoopSummary();
      assertTrue(typeof s.delayMaxMs === "number" && s.delayMaxMs > 0, "F3: the delay histogram reports a positive max");
      elm.stopEventLoopMonitor();
      assertTrue(elm.getEventLoopSummary().monitoring === false, "F4: stop leaves no heartbeat running");
    }

    // ── G. Route wiring ─────────────────────────────────────────────
    {
      const analytics = require("../routes/analytics");
      const router: any = analytics.default || analytics;
      const stack: any[] = router.stack || [];
      const authIdx = stack.findIndex((l) => !l.route && l.name === "requireAdminAuth");
      const routeIdx = stack.findIndex((l) => l.route && l.route.path === "/ops/event-loop" && l.route.methods.get);
      assertTrue(routeIdx >= 0, "G1: GET /ops/event-loop is registered on the analytics router");
      assertTrue(authIdx >= 0 && authIdx < routeIdx, "G2: …and mounted after requireAdminAuth, so it is admin-only");
      if (routeIdx >= 0) {
        let body: any = null;
        const res: any = { json(b: any) { body = b; return this; }, status() { return this; } };
        stack[routeIdx].route.stack[0].handle({}, res, () => {});
        assertTrue(!!body && Array.isArray(body.stalls) && typeof body.summary === "object" && typeof body.timestamp === "string",
          "G3: the route returns the report (summary, stalls, timestamp)");
      }
    }
  } catch (err: any) {
    failed++;
    failures.push("event-loop-monitor: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    elm.__resetEventLoopMonitorForTesting();
    if (prevDisabled === undefined) delete process.env.EVENT_LOOP_MONITOR_DISABLED;
    else process.env.EVENT_LOOP_MONITOR_DISABLED = prevDisabled;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runEventLoopMonitorTests({ log: true }).then((r) => {
    console.log(`\nevent-loop-monitor: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
