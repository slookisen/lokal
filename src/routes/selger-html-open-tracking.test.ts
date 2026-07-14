/**
 * selger-html-open-tracking.test.ts — unit/integration tests for the
 * dev-request orch-pr-20260714-claim-opened-instrumentation change: GET
 * /selger.html now runs trackSelgerHtmlOpen (src/middleware/analytics.ts)
 * before falling through to express.static (src/index.ts), so the claim
 * landing page's open can be attributed to a specific producer via
 * ?agent=<id> for GET /admin/claim-funnel's new "opened" stage (see
 * src/routes/admin-claim-funnel.test.ts).
 *
 * Covers:
 *   (a) GET /selger.html is still served byte-identical (200, an html-ish
 *       content-type, and a body matching the real src/public/selger.html
 *       file on disk) — the new route registration doesn't change what's
 *       actually served — and records exactly one page view whose stored
 *       path is the bare "/selger.html" when there's no query string.
 *   (b) GET /selger.html?agent=<id>&ref=<x> produces exactly ONE new row in
 *       analytics_page_views, whose stored path is the FULL originalUrl
 *       (including the query string), not just the bare path — this is
 *       what GET /admin/claim-funnel's "opened" stage parses.
 *   (c) A tracking failure (getDb() pointed at a closed DB, so
 *       analyticsService.recordPageView()'s db.prepare() throws inside its
 *       own try/catch) never prevents or alters the served page — the
 *       request still completes 200 with the real file body.
 *
 * Spins up its own throwaway express app — same convention as
 * src/public/sw.test.ts's runServiceWorkerHttpTests (mirrors the same
 * mount order as src/index.ts: the dedicated /selger.html route registered
 * BEFORE express.static) — and swaps the shared getDb() singleton to a
 * fresh in-memory production-schema DB (same convention as
 * admin-claim-funnel.test.ts), since trackSelgerHtmlOpen writes through
 * analyticsService.recordPageView() -> getDb().
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/selger-html-open-tracking.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runSelgerHtmlOpenTrackingTests() and folds its pass/fail counts into
 *      the `npm test` summary.
 */

import express from "express";
import http from "http";
import path from "path";
import { readFileSync } from "fs";
import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runSelgerHtmlOpenTrackingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const { trackSelgerHtmlOpen } = require("../middleware/analytics") as
    typeof import("../middleware/analytics");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  let server: http.Server | undefined;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const app = express();
    // Same mount order as src/index.ts: the dedicated route registered
    // BEFORE express.static, pointed at the real src/public directory so
    // the actual production file is what gets served in this test.
    app.get("/selger.html", trackSelgerHtmlOpen);
    app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const get = async (p: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      const body = await res.text();
      return { status: res.status, body, contentType: res.headers.get("content-type") || "" };
    };

    const realFileContent = readFileSync(path.join(__dirname, "..", "public", "selger.html"), "utf8");
    const countRows = () => (testDb.prepare(`SELECT COUNT(*) AS n FROM analytics_page_views`).get() as { n: number }).n;
    const lastPath = () => (testDb.prepare(`SELECT path FROM analytics_page_views ORDER BY id DESC LIMIT 1`).get() as { path: string } | undefined)?.path;

    // ── (a) still served byte-identical, no-query request tracked as bare path ──
    const countBefore = countRows();
    const plain = await get("/selger.html");
    assertEq(plain.status, 200, "a1: GET /selger.html -> 200");
    assertTrue(/html/.test(plain.contentType), `a2: GET /selger.html content-type is html-ish (got "${plain.contentType}")`);
    assertEq(plain.body, realFileContent, "a3: GET /selger.html body is byte-identical to the real src/public/selger.html file");
    assertEq(countRows(), countBefore + 1, "a4: GET /selger.html (no query) still records exactly one page view");
    assertEq(lastPath(), "/selger.html", "a5: with no query string, stored path is the bare /selger.html");

    // ── (b) ?agent=<id> is captured in the stored path, exactly one new row ──
    const countBeforeAgent = countRows();
    const withAgent = await get("/selger.html?agent=agent-xyz&ref=produsent");
    assertEq(withAgent.status, 200, "b1: GET /selger.html?agent=agent-xyz&ref=produsent -> 200");
    assertEq(withAgent.body, realFileContent, "b2: GET /selger.html?agent=... body is still byte-identical to the real file");
    assertEq(countRows(), countBeforeAgent + 1, "b3: GET /selger.html?agent=... produces exactly one new analytics_page_views row");
    assertEq(lastPath(), "/selger.html?agent=agent-xyz&ref=produsent", "b4: stored path includes the full query string (agent + ref), not just the bare path");

    // ── (c) a tracking failure never blocks or alters the served page ──────
    // Point getDb() at an already-closed DB so recordPageView()'s internal
    // db.prepare(...) throws -- it must catch+log internally (see
    // services/analytics-service.ts) and never surface as a broken response.
    const brokenDb = new Database(":memory:");
    brokenDb.pragma("journal_mode = DELETE");
    __initSchemaForTesting(brokenDb as any);
    brokenDb.close(); // any statement against this DB now throws
    __setDbForTesting(brokenDb as any);
    let thrown = false;
    let brokenRes: { status: number; body: string } | undefined;
    try {
      brokenRes = await get("/selger.html?agent=should-not-block");
    } catch {
      thrown = true;
    }
    assertTrue(!thrown, "c1: a tracking DB failure does not throw / break the HTTP request");
    assertEq(brokenRes?.status, 200, "c2: page is still served 200 even when tracking fails");
    assertEq(brokenRes?.body, realFileContent, "c3: page body is still byte-identical even when tracking fails");
    __setDbForTesting(testDb as any); // restore the working DB for anything after this point
  } catch (err) {
    failed++;
    failures.push(`selger-html-open-tracking: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (server) { await new Promise<void>((resolve) => server!.close(() => resolve())); }
    if (prevDb) __setDbForTesting(prevDb);
    try { testDb.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/selger-html-open-tracking.test.ts`
if (require.main === module) {
  console.log("── selger-html-open-tracking (GET /selger.html) unit tests ──");
  runSelgerHtmlOpenTrackingTests({ log: true }).then((r) => {
    console.log(`\nselger-html-open-tracking: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
