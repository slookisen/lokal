/**
 * analytics-rollup-export-diagnostics.test.ts — dev-request 2026-09-02-
 * analytics-historikk-rollup-lesere-foer-retention, Skive 4.
 *
 * Skive 1-3 rolled analytics_page_views / analytics_queries /
 * analytics_agent_views up into five PERMANENT rollup tables
 * (page_view_daily/sessions_daily/query_daily/query_text_daily/
 * agent_view_daily — schemas in database/init.ts) before pruning raw rows.
 * This slice makes that permanent history reachable operationally:
 *
 *   Part A — GET /admin/analytics/export/:table (src/routes/analytics.ts)
 *            additionally supports the five rollup tables, as JSON (default)
 *            or CSV (?format=csv). The original three raw tables
 *            (page_views/queries/agent_views) are unchanged.
 *   Part B — GET /admin/analytics/ops/diagnostics gets an additive
 *            `database.rollup.<table>.{rows,oldestDay}` block, one entry per
 *            rollup table. Every pre-existing field must stay correct
 *            (regression-proof, not just additive by inspection).
 *   Part C — retention-service.ts's rollupTableToCsv()/allRollupTablesToCsv()
 *            shared CSV helper, unit-tested directly against its own tiny
 *            fixture DB.
 *
 * Auth note: the spec transcript for this slice says the export endpoint's
 * unauthorized case "still 403s". The ACTUAL existing requireAdminAuth in
 * src/routes/analytics.ts (which this slice reuses unchanged, per the
 * "same X-Admin-Key gate ... do not create a new auth mechanism" instruction)
 * returns 401, not 403 — see its `res.status(401).json({ error:
 * "Unauthorized" })`. Tests below assert the REAL, existing status code
 * (401) rather than the spec transcript's assumption, and this file's
 * doc-comment plus the code-implementer's report flag the discrepancy.
 *
 * Harness mirrors admin-drink-coverage.test.ts (router.handle() direct,
 * so router.use(requireAdminAuth) is exercised, not bypassed) combined with
 * analytics-rollup-read-blend.test.ts's in-memory prod-schema DB via
 * __setDbForTesting + __initSchemaForTesting.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/analytics-rollup-export-diagnostics.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runAnalyticsRollupExportDiagnosticsTests() via runSerial() and folds
 *      its pass/fail counts into the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  headers: Record<string, string>;
}

function callRoute(
  router: any,
  opts: { url: string; query?: Record<string, string>; headers?: Record<string, string> },
): RouteResult {
  const rawHeaders = opts.headers || {};
  const lowerHeaders: Record<string, string> = {};
  for (const k of Object.keys(rawHeaders)) lowerHeaders[k.toLowerCase()] = rawHeaders[k];

  const req: any = {
    method: "GET",
    url: opts.url,
    originalUrl: opts.url,
    path: opts.url.split("?")[0],
    query: opts.query || {},
    headers: lowerHeaders,
    hostname: "localhost",
    get(name: string) {
      return lowerHeaders[String(name).toLowerCase()];
    },
  };

  let result: RouteResult = { status: 200, body: undefined, headers: {} };
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      result = { status: this.statusCode, body: payload, headers: result.headers };
      return this;
    },
    send(payload: any) {
      result = { status: this.statusCode, body: payload, headers: result.headers };
      return this;
    },
    setHeader(k: string, v: string) {
      result.headers[k] = v;
      return this;
    },
  };

  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) }, headers: result.headers };
  });
  return result;
}

export async function runAnalyticsRollupExportDiagnosticsTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = __peekDbForTesting();
  const testKey = process.env.ADMIN_KEY || "analytics-rollup-export-diagnostics-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;

  // ═══════════════════════════════════════════════════════════════════
  // Part A + Part B: GET /admin/analytics/export/:table and
  // GET /admin/analytics/ops/diagnostics against one seeded in-memory DB.
  // ═══════════════════════════════════════════════════════════════════
  {
    const testDb = new Database(":memory:");
    try {
      __setDbForTesting(testDb as any);
      __initSchemaForTesting(testDb as any);
      process.env.ADMIN_KEY = testKey;

      // ── Raw tables (for ops/diagnostics' pre-existing fields) ──────────
      testDb
        .prepare(
          `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
           VALUES (?, 'direct', 'h1', 'sess-a:Mozilla', 200, 'rfb', ?)`,
        )
        .run("/", "2026-02-01 10:00:00");
      testDb
        .prepare(
          `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
           VALUES (?, 'direct', 'h1', 'sess-b:Mozilla', 200, 'rfb', ?)`,
        )
        .run("/om-oss", "2026-02-03 11:00:00");
      testDb
        .prepare(
          `INSERT INTO analytics_queries (protocol, query, city, result_count, response_time_ms, agent_id, vertical_id, created_at)
           VALUES ('a2a', 'egg', 'Oslo', 3, 120, NULL, 'rfb', ?)`,
        )
        .run("2026-02-02 09:00:00");
      testDb
        .prepare(
          `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, vertical_id, created_at)
           VALUES ('agent-x', 'Gard X', 'Oslo', 'seo', 'rfb', ?)`,
        )
        .run("2026-02-01 08:00:00");
      testDb
        .prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, umbrella_type, is_active)
           VALUES ('agent-x', 'Gard X', 'd', 'test', 'x@x.invalid', 'https://x.invalid', 'producer', 'key-x', 'Oslo', NULL, 1)`,
        )
        .run();

      // ── page_view_daily: 2 rows, 2 days ─────────────────────────────────
      testDb
        .prepare(
          `INSERT INTO page_view_daily (day, path, source, bot_type, vertical_id, view_count, session_count)
           VALUES ('2026-01-05', '/', 'direct', 'human', 'rfb', 10, 4)`,
        )
        .run();
      testDb
        .prepare(
          `INSERT INTO page_view_daily (day, path, source, bot_type, vertical_id, view_count, session_count)
           VALUES ('2026-01-10', '/om-oss', 'seo', 'chatgpt', 'rfb', 3, 2)`,
        )
        .run();

      // ── sessions_daily: 1 row ────────────────────────────────────────────
      testDb
        .prepare(
          `INSERT INTO sessions_daily (day, vertical_id, bot_type, session_count) VALUES ('2026-01-05', 'rfb', 'human', 4)`,
        )
        .run();

      // ── query_daily: 3 rows, 3 days ──────────────────────────────────────
      testDb
        .prepare(
          `INSERT INTO query_daily (day, protocol, agent_id, vertical_id, city, query_count, result_count_sum, response_time_ms_sum, response_time_ms_n)
           VALUES ('2026-01-01', 'a2a', '', 'rfb', '', 5, 20, 500, 5)`,
        )
        .run();
      testDb
        .prepare(
          `INSERT INTO query_daily (day, protocol, agent_id, vertical_id, city, query_count, result_count_sum, response_time_ms_sum, response_time_ms_n)
           VALUES ('2026-01-03', 'mcp', '', 'rfb', '', 2, 8, 200, 2)`,
        )
        .run();
      testDb
        .prepare(
          `INSERT INTO query_daily (day, protocol, agent_id, vertical_id, city, query_count, result_count_sum, response_time_ms_sum, response_time_ms_n)
           VALUES ('2026-01-07', 'a2a', '', 'rfb', '', 1, 4, 100, 1)`,
        )
        .run();

      // ── query_text_daily: 1 row, with a comma+quote to exercise CSV escaping ──
      testDb
        .prepare(
          `INSERT INTO query_text_daily (day, query, vertical_id, query_count)
           VALUES ('2026-01-01', 'egg, melk "ferskt"', 'rfb', 5)`,
        )
        .run();

      // ── agent_view_daily: 4 rows, 2 days (NO vertical_id column) ────────
      testDb
        .prepare(
          `INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES ('2026-01-02', 'agent-x', 'seo', 'Oslo', 6)`,
        )
        .run();
      testDb
        .prepare(
          `INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES ('2026-01-02', 'agent-x', 'direct', 'Oslo', 2)`,
        )
        .run();
      testDb
        .prepare(
          `INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES ('2026-01-06', 'agent-y', 'seo', 'Bergen', 9)`,
        )
        .run();
      testDb
        .prepare(
          `INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES ('2026-01-06', 'agent-y', 'direct', 'Bergen', 1)`,
        )
        .run();

      delete require.cache[require.resolve("./analytics")];
      const analyticsRouter = (require("./analytics") as any).default;

      // ══════════════════════════════════════════════════════════════════
      // Part A: GET /admin/analytics/export/:table
      // ══════════════════════════════════════════════════════════════════

      // ── (a1) unauthorized: no X-Admin-Key -> 401 (existing requireAdminAuth,
      //        reused unchanged — see file header re the spec's "403" text) ──
      const noKeyExport = callRoute(analyticsRouter, { url: "/export/page_view_daily" });
      assertEq(noKeyExport.status, 401, "a1: export without X-Admin-Key -> 401 (existing requireAdminAuth behaviour, unchanged)");

      // ── (a2) invalid table name -> 400, same validation path as before ──
      const badTable = callRoute(analyticsRouter, {
        url: "/export/not_a_real_table",
        headers: { "X-Admin-Key": testKey },
      });
      assertEq(badTable.status, 400, "a2: unknown table name -> 400");
      assertTrue(
        typeof badTable.body?.error === "string" && badTable.body.error.includes("page_view_daily"),
        "a2b: 400 error message lists the new rollup table names too",
      );

      // ── (a3) original raw table export is completely unchanged ─────────
      const rawExport = callRoute(analyticsRouter, {
        url: "/export/agent_views",
        headers: { "X-Admin-Key": testKey },
      });
      assertEq(rawExport.status, 200, "a3: raw table export (agent_views) still 200");
      assertEq(rawExport.body.total, 1, "a3b: raw table export (agent_views) still returns the raw row, unaffected by the rollup fixtures");
      assertTrue(!("format" in (rawExport.body || {})), "a3c: raw table export response shape unchanged (no stray `format` field)");

      // ── (a4) JSON export — page_view_daily (has vertical_id) ────────────
      const pvdJson = callRoute(analyticsRouter, {
        url: "/export/page_view_daily",
        headers: { "X-Admin-Key": testKey },
      });
      assertEq(pvdJson.status, 200, "a4: page_view_daily JSON export -> 200");
      assertEq(pvdJson.body.table, "page_view_daily", "a4b: response echoes table name");
      assertEq(pvdJson.body.total, 2, "a4c: page_view_daily JSON export total=2");
      assertEq(pvdJson.body.data.length, 2, "a4d: page_view_daily JSON export data.length=2");
      assertEq(pvdJson.body.data[0].day, "2026-01-10", "a4e: page_view_daily JSON export ordered day DESC (newest first)");
      assertEq(pvdJson.body.data[1].view_count, 10, "a4f: page_view_daily JSON export row field values correct (view_count)");

      // ── (a5) JSON export — agent_view_daily (NO vertical_id column at all) ──
      const avdJson = callRoute(analyticsRouter, {
        url: "/export/agent_view_daily",
        headers: { "X-Admin-Key": testKey },
      });
      assertEq(avdJson.status, 200, "a5: agent_view_daily JSON export -> 200 (no vertical_id column doesn't break the query)");
      assertEq(avdJson.body.total, 4, "a5b: agent_view_daily JSON export total=4");
      assertTrue(
        avdJson.body.data.every((r: any) => !("vertical_id" in r)),
        "a5c: agent_view_daily rows never carry a vertical_id field (table has none)",
      );

      // ── (a6) CSV export — page_view_daily ────────────────────────────────
      const pvdCsv = callRoute(analyticsRouter, {
        url: "/export/page_view_daily",
        query: { format: "csv" },
        headers: { "X-Admin-Key": testKey },
      });
      assertEq(pvdCsv.status, 200, "a6: page_view_daily CSV export -> 200");
      assertEq(pvdCsv.headers["Content-Type"], "text/csv; charset=utf-8", "a6b: CSV export sets text/csv content type");
      const pvdCsvLines = String(pvdCsv.body).trim().split("\n");
      assertEq(pvdCsvLines[0], "day,path,source,bot_type,vertical_id,view_count,session_count", "a6c: CSV header row matches column order");
      assertEq(pvdCsvLines.length, 3, "a6d: CSV export has header + 2 data rows");

      // ── (a7) CSV export — query_text_daily, exercises comma+quote escaping ──
      const qtdCsv = callRoute(analyticsRouter, {
        url: "/export/query_text_daily",
        query: { format: "csv" },
        headers: { "X-Admin-Key": testKey },
      });
      const qtdCsvLines = String(qtdCsv.body).trim().split("\n");
      assertEq(qtdCsvLines[0], "day,query,vertical_id,query_count", "a7: query_text_daily CSV header");
      assertEq(qtdCsvLines[1], `2026-01-01,"egg, melk ""ferskt""",rfb,5`, "a7b: comma+quote in `query` is correctly CSV-escaped");

      // ── (a8) CSV export for the remaining three rollup tables — just
      //        confirm each is reachable, 200, correct row count ─────────
      for (const [table, expectedRows] of [
        ["sessions_daily", 1],
        ["query_daily", 3],
        ["agent_view_daily", 4],
      ] as const) {
        const r = callRoute(analyticsRouter, {
          url: `/export/${table}`,
          query: { format: "csv" },
          headers: { "X-Admin-Key": testKey },
        });
        assertEq(r.status, 200, `a8: ${table} CSV export -> 200`);
        const dataLines = String(r.body).trim().split("\n").length - 1; // minus header
        assertEq(dataLines, expectedRows, `a8b: ${table} CSV export has ${expectedRows} data row(s)`);
      }

      // ══════════════════════════════════════════════════════════════════
      // Part B: GET /admin/analytics/ops/diagnostics
      // ══════════════════════════════════════════════════════════════════

      const diagNoKey = callRoute(analyticsRouter, { url: "/ops/diagnostics" });
      assertEq(diagNoKey.status, 401, "b1: ops/diagnostics without X-Admin-Key -> 401 (unchanged pre-existing gate)");

      const diag = callRoute(analyticsRouter, {
        url: "/ops/diagnostics",
        headers: { "X-Admin-Key": testKey },
      });
      assertEq(diag.status, 200, "b2: ops/diagnostics with valid key -> 200");

      // ── Pre-existing fields — regression-proof, not just "still present":
      //    exact expected values computed independently from the raw fixtures. ──
      assertEq(diag.body.database.tables.pageViews, 2, "b3: pre-existing field database.tables.pageViews unchanged (2 raw rows)");
      assertEq(diag.body.database.tables.queries, 1, "b4: pre-existing field database.tables.queries unchanged (1 raw row)");
      assertEq(diag.body.database.tables.agentViews, 1, "b5: pre-existing field database.tables.agentViews unchanged (1 raw row)");
      assertEq(diag.body.database.tables.agents, 1, "b6: pre-existing field database.tables.agents unchanged (1 active agent)");
      assertEq(diag.body.database.oldest.pageView, "2026-02-01 10:00:00", "b7: pre-existing field database.oldest.pageView unchanged");
      assertEq(diag.body.database.oldest.query, "2026-02-02 09:00:00", "b8: pre-existing field database.oldest.query unchanged");
      assertTrue(typeof diag.body.uptime === "number", "b9: pre-existing field uptime still present and numeric");
      assertTrue(
        typeof diag.body.memory?.rssMb === "number" && typeof diag.body.memory?.heapUsedMb === "number",
        "b10: pre-existing memory.* fields still present and numeric",
      );
      assertTrue(
        typeof diag.body.lastHour?.totalViews === "number" && typeof diag.body.lastHour?.botRatio === "number",
        "b11: pre-existing lastHour.* fields still present",
      );
      assertTrue(typeof diag.body.timestamp === "string", "b12: pre-existing timestamp field still present");

      // ── New Part B fields — additive rollup block, one entry per table ──
      assertEq(diag.body.database.rollup.page_view_daily, { rows: 2, oldestDay: "2026-01-05" }, "b13: rollup.page_view_daily {rows, oldestDay}");
      assertEq(diag.body.database.rollup.sessions_daily, { rows: 1, oldestDay: "2026-01-05" }, "b14: rollup.sessions_daily {rows, oldestDay}");
      assertEq(diag.body.database.rollup.query_daily, { rows: 3, oldestDay: "2026-01-01" }, "b15: rollup.query_daily {rows, oldestDay}");
      assertEq(diag.body.database.rollup.query_text_daily, { rows: 1, oldestDay: "2026-01-01" }, "b16: rollup.query_text_daily {rows, oldestDay}");
      assertEq(diag.body.database.rollup.agent_view_daily, { rows: 4, oldestDay: "2026-01-02" }, "b17: rollup.agent_view_daily {rows, oldestDay}");

      // ── Empty-rollup-table edge case: fresh DB, no rollup rows at all —
      //    oldestDay must be null, not throw / not a malformed string. ──
      const emptyDb = new Database(":memory:");
      try {
        __setDbForTesting(emptyDb as any);
        __initSchemaForTesting(emptyDb as any);
        delete require.cache[require.resolve("./analytics")];
        const analyticsRouterEmpty = (require("./analytics") as any).default;
        const diagEmpty = callRoute(analyticsRouterEmpty, {
          url: "/ops/diagnostics",
          headers: { "X-Admin-Key": testKey },
        });
        assertEq(diagEmpty.status, 200, "b18: ops/diagnostics on an empty DB -> still 200");
        assertEq(
          diagEmpty.body.database.rollup.page_view_daily,
          { rows: 0, oldestDay: null },
          "b19: empty rollup table reports rows:0, oldestDay:null (no throw)",
        );
      } finally {
        emptyDb.close();
      }
    } finally {
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevDb) __setDbForTesting(prevDb);
      try {
        delete require.cache[require.resolve("./analytics")];
      } catch {
        /* ignore */
      }
      testDb.close();
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Part C: retention-service.ts's rollupTableToCsv() / allRollupTablesToCsv()
  // unit-tested directly against their own tiny fixture DB.
  // ═══════════════════════════════════════════════════════════════════
  {
    const csvDb = new Database(":memory:");
    try {
      __setDbForTesting(csvDb as any);
      __initSchemaForTesting(csvDb as any);

      const { rollupTableToCsv, allRollupTablesToCsv, getRollupTableColumns, isRollupTableName } =
        require("../services/retention-service") as typeof import("../services/retention-service");

      // ── isRollupTableName / getRollupTableColumns sanity ────────────────
      assertTrue(isRollupTableName("page_view_daily"), "c1: isRollupTableName true for a real rollup table");
      assertTrue(!isRollupTableName("analytics_page_views"), "c2: isRollupTableName false for a raw table name");
      assertEq(
        getRollupTableColumns("agent_view_daily"),
        ["day", "agent_id", "view_source", "city", "view_count"],
        "c3: getRollupTableColumns(agent_view_daily) — exact column list, no vertical_id",
      );

      // ── correct headers + correct rows ──────────────────────────────────
      csvDb
        .prepare(
          `INSERT INTO sessions_daily (day, vertical_id, bot_type, session_count) VALUES ('2026-03-01', 'rfb', 'human', 7)`,
        )
        .run();
      csvDb
        .prepare(
          `INSERT INTO sessions_daily (day, vertical_id, bot_type, session_count) VALUES ('2026-03-02', 'dental', 'human', 3)`,
        )
        .run();

      const sdCsv = rollupTableToCsv("sessions_daily", { dbHandle: csvDb as any });
      const sdLines = sdCsv.split("\n").filter((l) => l.length > 0);
      assertEq(sdLines[0], "day,vertical_id,bot_type,session_count", "c4: rollupTableToCsv header row");
      assertEq(sdLines.length, 3, "c5: rollupTableToCsv row count = header + 2 data rows");
      assertEq(sdLines[1], "2026-03-02,dental,human,3", "c6: rollupTableToCsv rows ordered day DESC, correct field values");
      assertEq(sdLines[2], "2026-03-01,rfb,human,7", "c7: rollupTableToCsv second row correct");

      // ── vertical filter ──────────────────────────────────────────────────
      const sdCsvRfbOnly = rollupTableToCsv("sessions_daily", { dbHandle: csvDb as any, vertical: "rfb" });
      const sdRfbLines = sdCsvRfbOnly.split("\n").filter((l) => l.length > 0);
      assertEq(sdRfbLines.length, 2, "c8: rollupTableToCsv vertical filter -> header + 1 matching row");
      assertTrue(sdRfbLines[1].includes(",rfb,"), "c9: rollupTableToCsv vertical filter row is the rfb one");

      // ── vertical filter is a no-op for agent_view_daily (no such column) ──
      csvDb
        .prepare(
          `INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES ('2026-03-01', 'agent-z', 'seo', 'Trondheim', 5)`,
        )
        .run();
      const avdCsvWithVertical = rollupTableToCsv("agent_view_daily", { dbHandle: csvDb as any, vertical: "rfb" });
      const avdLines = avdCsvWithVertical.split("\n").filter((l) => l.length > 0);
      assertEq(avdLines.length, 2, "c10: rollupTableToCsv(agent_view_daily, {vertical}) does not filter/throw — no vertical_id column to filter on");

      // ── limit/offset ──────────────────────────────────────────────────────
      const sdCsvLimited = rollupTableToCsv("sessions_daily", { dbHandle: csvDb as any, limit: 1 });
      assertEq(
        sdCsvLimited.split("\n").filter((l) => l.length > 0).length,
        2,
        "c11: rollupTableToCsv respects limit (header + 1 row)",
      );

      // ── empty table: never crashes, returns header-only ──────────────────
      const emptyCsv = rollupTableToCsv("query_daily", { dbHandle: csvDb as any });
      assertEq(emptyCsv, "day,protocol,agent_id,vertical_id,city,query_count,result_count_sum,response_time_ms_sum,response_time_ms_n\n", "c12: rollupTableToCsv on an empty table returns just the header line, no throw");

      // ── allRollupTablesToCsv(): all five keys present ─────────────────────
      const all = allRollupTablesToCsv({ dbHandle: csvDb as any });
      assertEq(
        Object.keys(all).sort(),
        ["agent_view_daily", "page_view_daily", "query_daily", "query_text_daily", "sessions_daily"],
        "c13: allRollupTablesToCsv returns exactly the five rollup table keys",
      );
      assertTrue(all.sessions_daily.startsWith("day,vertical_id,bot_type,session_count\n"), "c14: allRollupTablesToCsv's sessions_daily entry has the right header");
    } finally {
      if (prevDb) __setDbForTesting(prevDb);
      csvDb.close();
    }
  }

  if (log) console.log(`\nanalytics-rollup-export-diagnostics: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/analytics-rollup-export-diagnostics.test.ts`
if (require.main === module) {
  console.log("── dev-request 2026-09-02-analytics-historikk-rollup-lesere-foer-retention, Skive 4: rollup export + diagnostics ──");
  runAnalyticsRollupExportDiagnosticsTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
