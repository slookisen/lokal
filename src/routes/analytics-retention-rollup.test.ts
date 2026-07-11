/**
 * analytics-retention-rollup.test.ts — tests for the retention-rollup 500
 * root-cause fix (dev-request 2026-07-11-retention-rollup-500-rootcause,
 * Daniel GO, P1).
 *
 * Covers POST /admin/analytics/ops/retention-rollup (src/routes/analytics.ts):
 *   (a) the actual root cause: a request with no body at all (`req.body`
 *       is `undefined`, not `{}` — express.json() only populates req.body
 *       when Content-Type matches) used to throw `Cannot read properties
 *       of undefined (reading 'dryRun')` before the try/catch even started.
 *       Reproduced directly by passing `body: undefined` to the extracted
 *       handler (mirrors how express actually leaves req.body when a POST
 *       has no Content-Type header).
 *   (b) dryRun accepted from EITHER the body or the `?dryRun=true` query
 *       param; dry-run wins on any conflict (strict-false convention,
 *       mirrors POST /admin/experiences-dedup-unmerge, #215).
 *   (c) `?dryRun=true` as a query param never mutates (the exact
 *       param-footgun the dev-request was filed over — a caller who
 *       thinks they're dry-running via query used to run for real).
 *   (d) a genuine real (non-dry) pass against an in-memory DB actually
 *       rolls up + deletes representative rows and returns 200 — the
 *       acceptance criterion the dev-request never got to confirm because
 *       every real-pass attempt 500'd first.
 *   (e) disabled + no dry-run signal at all -> 503, not 500.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/analytics-retention-rollup.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runRetentionRollupTests() and folds its pass/fail counts into the
 *      `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runRetentionRollupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevEnabled = process.env.RETENTION_JOB_ENABLED;

  const testDb = new Database(":memory:");

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const routePath = require.resolve("../routes/analytics");
    delete require.cache[routePath];
    const analyticsModule = require("../routes/analytics") as typeof import("../routes/analytics");
    const routerModule = analyticsModule.default as any;

    function getHandler(path: string) {
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === path && l.route.methods && l.route.methods.post,
      );
      assertTrue(!!layer, `setup: POST ${path} handler is registered on the router`);
      return layer.route.stack[0].handle;
    }

    const postRetentionRollup = getHandler("/ops/retention-rollup");

    async function callPost(fakeReq: { body?: any; query?: any }): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await postRetentionRollup({ headers: {}, query: {}, ...fakeReq } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function seedOldRows(): void {
      testDb.exec("DELETE FROM analytics_page_views; DELETE FROM runs;");
      const oldPv = new Date(); oldPv.setDate(oldPv.getDate() - 120);
      testDb.prepare(
        `INSERT INTO analytics_page_views (path, referrer, source, user_agent_hash, session_id, status_code, created_at)
         VALUES ('/test', NULL, 'direct', 'h1', 'sess1:UA', 200, ?)`,
      ).run(oldPv.toISOString().replace("T", " ").slice(0, 19));

      const oldRun = new Date(); oldRun.setDate(oldRun.getDate() - 60);
      const oldRunStr = oldRun.toISOString().replace("T", " ").slice(0, 19);
      testDb.prepare(
        `INSERT INTO runs (run_id, vertical, agent, trigger_source, started_at, finished_at, status, claims, evidence)
         VALUES ('run-retention-test-1', 'rfb', 'test-agent', 'manual', ?, ?, 'completed', '[]', '[]')`,
      ).run(oldRunStr, oldRunStr);
    }

    function counts(): { pv: number; runs: number } {
      const pv = (testDb.prepare("SELECT COUNT(*) as c FROM analytics_page_views").get() as { c: number }).c;
      const runs = (testDb.prepare("SELECT COUNT(*) as c FROM runs").get() as { c: number }).c;
      return { pv, runs };
    }

    // ── (a) root cause: req.body is undefined (no Content-Type on the real
    //        request) — must not throw, must not 500. RETENTION_JOB_ENABLED
    //        unset + no dry-run signal anywhere -> the disabled-503 branch,
    //        which itself requires reading `body.dryRun` first (the exact
    //        line that used to crash on `undefined.dryRun`).
    {
      delete process.env.RETENTION_JOB_ENABLED;
      seedOldRows();
      const before = counts();
      const r = await callPost({ body: undefined });
      assertEq(r.status, 503, "root-cause: undefined req.body -> 503 (disabled), not a 500 crash");
      assertTrue(typeof r.body?.error === "string", "root-cause: 503 carries an error message");
      assertEq(counts(), before, "root-cause: disabled 503 path never touches the DB");
    }

    // ── (a2) same undefined-body request, but with the job enabled — must
    //        complete as a genuine REAL pass (200), never crash. This is
    //        the exact shape of request that reproduced the original 500
    //        3x in prod once RETENTION_JOB_ENABLED was already true there.
    {
      process.env.RETENTION_JOB_ENABLED = "true";
      seedOldRows();
      const before = counts();
      const r = await callPost({ body: undefined });
      assertEq(r.status, 200, "root-cause: undefined req.body + job enabled -> 200 real pass, no crash");
      assertEq(r.body?.dryRun, false, "root-cause: undefined body with no dry-run signal is a REAL pass");
      const after = counts();
      assertTrue(after.pv < before.pv, "root-cause: real pass actually deleted the old page-view row");
      assertTrue(after.runs < before.runs, "root-cause: real pass actually pruned the old run row");
    }

    // ── (b) + (c) query-param dryRun=true never mutates, even with the
    //        job enabled and no body at all — the exact param-footgun.
    {
      process.env.RETENTION_JOB_ENABLED = "true";
      seedOldRows();
      const before = counts();
      const r = await callPost({ body: undefined, query: { dryRun: "true" } });
      assertEq(r.status, 200, "query-dryRun: ?dryRun=true -> 200");
      assertEq(r.body?.dryRun, true, "query-dryRun: response reports dryRun:true");
      assertEq(counts(), before, "query-dryRun: ?dryRun=true as a query param never mutates (param-footgun pin)");
    }

    // ── (b2) duplicated query param (?dryRun=true&dryRun=true) parses as an
    //        array in Express — must still be treated as a dry-run signal,
    //        not silently fall through to a real run.
    {
      process.env.RETENTION_JOB_ENABLED = "true";
      seedOldRows();
      const before = counts();
      const r = await callPost({ body: undefined, query: { dryRun: ["true", "true"] } });
      assertEq(r.body?.dryRun, true, "query-dryRun-array: duplicated ?dryRun=true params -> still dry");
      assertEq(counts(), before, "query-dryRun-array: duplicated dryRun query params never mutate");
    }

    // ── (b) conflict: query says dry, body says real -> dry wins ────────
    {
      process.env.RETENTION_JOB_ENABLED = "true";
      seedOldRows();
      const before = counts();
      const r = await callPost({ body: { dryRun: false }, query: { dryRun: "true" } });
      assertEq(r.body?.dryRun, true, "conflict: query dryRun=true + body dryRun:false -> dry wins");
      assertEq(counts(), before, "conflict: dry-wins-on-conflict never mutates");
    }

    // ── (d) genuine real pass via explicit body dryRun:false -> mutates,
    //        returns sane rollup/prune numbers, no throw.
    {
      process.env.RETENTION_JOB_ENABLED = "true";
      seedOldRows();
      const r = await callPost({ body: { dryRun: false } });
      assertEq(r.status, 200, "real-pass: explicit body dryRun:false -> 200");
      assertEq(r.body?.success, true, "real-pass: success:true");
      assertEq(r.body?.rollup?.rowsDeleted, 1, "real-pass: rolled up+deleted the 1 seeded old page-view row");
      assertEq(r.body?.runLedger?.runsDeleted, 1, "real-pass: pruned the 1 seeded old run row");
    }

    // ── (e) disabled, no signal anywhere (normal body: {}) -> 503 ───────
    {
      delete process.env.RETENTION_JOB_ENABLED;
      const r = await callPost({ body: {} });
      assertEq(r.status, 503, "disabled: {} body, flag unset -> 503");
    }
  } finally {
    if (prevEnabled === undefined) delete process.env.RETENTION_JOB_ENABLED;
    else process.env.RETENTION_JOB_ENABLED = prevEnabled;
    if (prevDb) __setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRetentionRollupTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
