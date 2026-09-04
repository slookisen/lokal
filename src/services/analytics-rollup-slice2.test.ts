/**
 * analytics-rollup-slice2.test.ts — orch-pr-20260903-analytics-rollup-slice2.
 *
 * Slice 1 (lokal#782 + #788) made runAutoPrune() roll analytics_page_views up
 * into page_view_daily before deleting them, and STOPPED deleting from
 * analytics_queries / analytics_agent_views entirely, because neither had a
 * rollup destination yet (reported via skippedPendingRollup +
 * wouldDeleteIfPruned). This slice builds that missing coverage so deletion can
 * safely resume on all three tables with zero aggregate-history loss:
 *
 *   - query_daily        (day × protocol × agent × vertical × city)
 *   - query_text_daily   (day × query × vertical)
 *   - agent_view_daily   (day × agent × view_source × city)
 *   - sessions_daily     (day × vertical × bot_type) — TRUE distinct sessions
 *
 * Covered here:
 *   (1) rollupAndPruneQueries: aggregates match the seeded rows exactly, old
 *       raw rows gone, in-window rows kept, and the response-time average is
 *       reconstructable from sum/n with NULL latencies excluded from BOTH.
 *   (2) rollupAndPruneAgentViews: agent_view_daily totals correct per
 *       agent/source/city, old raw rows gone, in-window rows kept.
 *   (3) sessions_daily is a TRUE distinct-session count — the same session_id
 *       visiting several DIFFERENT paths on one day counts ONCE. (Summing
 *       page_view_daily.session_count, which is per-path, would overcount it —
 *       this is the specific correctness trap this table exists to avoid.)
 *   (4) Idempotency: a second rollup over an already-exhausted window is a
 *       no-op — no double-counting in any rollup table.
 *   (5) runAutoPrune() end-to-end: skippedPendingRollup === [],
 *       deleted.queries/.agentViews carry real counts, and every rollup table's
 *       contents are stable across repeated calls (nothing ever deletes FROM a
 *       rollup table).
 *   (6) GET /admin/outreach-ready-pool/ views_count regression: the lifetime
 *       view total an agent reports is IDENTICAL before and after a
 *       rollup+delete cycle (rollup total + remaining raw rows).
 *
 * Added in review round 2 (the three blocking findings on 908ae0c):
 *   (7) Transaction-boundary regression pins for all three rollups. Finding 1:
 *       the rollup INSERTs and the raw DELETE are one all-or-nothing
 *       transaction, but a broken boundary is invisible on every happy path —
 *       the reviewer moved each DELETE out of its db.transaction() callback and
 *       all three suites still passed. Each rollup now gets two probes: an
 *       INSERT-side one (the target rollup table is dropped so its INSERT
 *       throws → the DELETE must be rolled back and any sibling rollup INSERT
 *       must show nothing) and a DELETE-side one (a BEFORE DELETE trigger
 *       aborts the raw DELETE → the rollup INSERTs must be rolled back).
 *   (8) GET /admin/outreach-candidates views_count. Finding 2: the route
 *       carries the same rollup+raw fix as admin-outreach-pool in TWO SQL
 *       branches (mode=first / mode=second) and neither was covered. It never
 *       leaks views_count, so the value is read out through dedupeByEmail()'s
 *       tiebreaker and bracketed with a probe agent on the same email; both
 *       endpoints are then shown to report the SAME number for the same agent.
 *   (9) DELETE /admin/agents/:id (opt-out) clears agent_view_daily. Finding 3:
 *       the opt-out path is a user-initiated deletion request, NOT retention
 *       pruning, so it removes the permanent rollup row too — deliberately
 *       unlike runAutoPrune/retention-service.ts.
 *
 * Harness mirrors analytics-auto-prune-rollup.test.ts exactly: in-memory
 * better-sqlite3 with the full prod schema injected via __setDbForTesting +
 * __initSchemaForTesting, previous global handle saved/restored.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/analytics-rollup-slice2.test.ts
 *   2. Wired into the gate: tests/test.ts imports runAnalyticsRollupSlice2Tests()
 *      and folds its pass/fail counts into the `npm test` summary.
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

export async function runAnalyticsRollupSlice2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevAdminKey = process.env.ADMIN_KEY;
  // Section (8) exercises GET /admin/outreach-candidates, whose global
  // kill-switch (OUTREACH_PAUSED=true) short-circuits to zero candidates.
  const prevOutreachPaused = process.env.OUTREACH_PAUSED;
  delete process.env.OUTREACH_PAUSED;

  const testDb = new Database(":memory:");

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const retention = require("./retention-service") as typeof import("./retention-service");

    const DAYS_TO_KEEP = 90;

    function isoDaysAgo(days: number): string {
      const d = new Date();
      d.setDate(d.getDate() - days);
      return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }

    function clearAll(): void {
      testDb.exec(
        "DELETE FROM analytics_page_views; DELETE FROM analytics_queries; " +
        "DELETE FROM analytics_agent_views; DELETE FROM page_view_daily; " +
        "DELETE FROM query_daily; DELETE FROM query_text_daily; " +
        "DELETE FROM agent_view_daily; DELETE FROM sessions_daily;"
      );
    }

    const count = (t: string) => (testDb.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number }).c;
    const sumOf = (t: string, c: string) =>
      (testDb.prepare(`SELECT COALESCE(SUM(${c}), 0) as s FROM ${t}`).get() as { s: number }).s;

    // ── Atomicity-probe helpers (used by section (7)) ────────────────────────
    // Both probes make ONE statement inside a rollup's per-batch transaction
    // fail, then assert nothing that transaction did survived. They are the
    // only way to observe the transaction boundary from outside — a rollup that
    // silently moved its DELETE out of db.transaction() produces byte-identical
    // results on every happy path.

    /** Full DDL (table first, then its indexes) so a dropped table can be restored. */
    function tableDdl(table: string): string[] {
      return (testDb
        .prepare(
          "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL " +
          "ORDER BY (type = 'table') DESC",
        )
        .all(table) as Array<{ sql: string }>).map((r) => r.sql);
    }

    /** Run fn with `table` dropped, so an INSERT targeting it throws. Always restores. */
    function withDroppedTable(table: string, fn: () => void): void {
      const ddl = tableDdl(table);
      testDb.exec(`DROP TABLE ${table}`);
      try {
        fn();
      } finally {
        for (const sql of ddl) testDb.exec(sql);
      }
    }

    /** Run fn with any DELETE on `table` aborted by a trigger. Always removes it. */
    function withDeleteBlocked(table: string, fn: () => void): void {
      const trg = `trg_atomicity_probe_${table}`;
      testDb.exec(
        `CREATE TRIGGER ${trg} BEFORE DELETE ON ${table} ` +
        `BEGIN SELECT RAISE(ABORT, 'atomicity probe: DELETE blocked'); END;`,
      );
      try {
        fn();
      } finally {
        testDb.exec(`DROP TRIGGER IF EXISTS ${trg}`);
      }
    }

    function assertThrows(fn: () => unknown, label: string): void {
      let threw = false;
      try {
        fn();
      } catch {
        threw = true;
      }
      assertTrue(threw, label);
    }

    // ════════════════════════════════════════════════════════════════════
    // (1) rollupAndPruneQueries
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const newCreated = isoDaysAgo(1);

      const ins = testDb.prepare(
        `INSERT INTO analytics_queries
           (protocol, query, city, result_count, response_time_ms, agent_id, vertical_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      // Group A: a2a / gpt-1 / rfb / Oslo — 3 rows, latencies 100, 300, NULL
      ins.run("a2a", "egg", "Oslo", 5, 100, "gpt-1", "rfb", oldCreated);
      ins.run("a2a", "egg", "Oslo", 7, 300, "gpt-1", "rfb", oldCreated);
      ins.run("a2a", "melk", "Oslo", 1, null, "gpt-1", "rfb", oldCreated);
      // Group B: mcp / NULL agent / dental / NULL city — 2 rows, latencies NULL, NULL
      ins.run("mcp", "tannlege", null, 2, null, null, "dental", oldCreated);
      ins.run("mcp", "tannlege", null, 4, null, null, "dental", oldCreated);
      // Group C: api / claude-1 / rfb / Bergen — 1 row, latency 50
      ins.run("api", "honning", "Bergen", 3, 50, "claude-1", "rfb", oldCreated);
      // Inside the retention window — must survive untouched
      ins.run("a2a", "egg", "Oslo", 9, 900, "gpt-1", "rfb", newCreated);

      assertEq(count("analytics_queries"), 7, "queries setup: 7 seeded rows");

      const r = retention.rollupAndPruneQueries(DAYS_TO_KEEP, 7, false);

      assertEq(r.rowsDeleted, 6, "queries: 6 out-of-window rows deleted");
      assertEq(count("analytics_queries"), 1, "queries: only the in-window row remains raw");

      // query_daily — one row per (day, protocol, agent, vertical, city) group
      const qd = testDb.prepare(
        `SELECT protocol, agent_id, vertical_id, city, query_count,
                result_count_sum, response_time_ms_sum, response_time_ms_n
           FROM query_daily ORDER BY protocol, city`
      ).all() as Array<Record<string, unknown>>;

      assertEq(qd.length, 3, "query_daily: exactly 3 dimension groups");
      // ORDER BY protocol, city (SQLite binary collation): a2a < api < mcp.
      // Key order below must match the SELECT list — assertEq compares JSON.
      assertEq(
        qd,
        [
          { protocol: "a2a", agent_id: "gpt-1", vertical_id: "rfb", city: "Oslo",
            query_count: 3, result_count_sum: 13, response_time_ms_sum: 400, response_time_ms_n: 2 },
          { protocol: "api", agent_id: "claude-1", vertical_id: "rfb", city: "Bergen",
            query_count: 1, result_count_sum: 3, response_time_ms_sum: 50, response_time_ms_n: 1 },
          // NULL agent_id -> '', NULL city -> ''
          { protocol: "mcp", agent_id: "", vertical_id: "dental", city: "",
            query_count: 2, result_count_sum: 6, response_time_ms_sum: 0, response_time_ms_n: 0 },
        ],
        "query_daily: every aggregate matches the seeded rows exactly (NULL agent_id/city coalesced)",
      );

      // Latency average: NULLs excluded from BOTH sum and n, never coerced to 0.
      const oslo = qd.find((row) => row.city === "Oslo") as any;
      assertEq(oslo.response_time_ms_n, 2, "query_daily: NULL response_time_ms excluded from _n (3 rows, 2 timed)");
      assertEq(oslo.response_time_ms_sum, 400, "query_daily: NULL response_time_ms excluded from _sum");
      assertEq(oslo.response_time_ms_sum / oslo.response_time_ms_n, 200, "query_daily: avg = sum/n = 200ms (NOT 400/3 = 133ms)");
      const dental = qd.find((row) => row.vertical_id === "dental") as any;
      assertEq(dental.response_time_ms_n, 0, "query_daily: all-NULL group has _n = 0 (avg is undefined, not 0ms)");
      assertEq(dental.response_time_ms_sum, 0, "query_daily: all-NULL group has _sum = 0");

      // query_text_daily — one row per (day, query, vertical)
      const qtd = testDb.prepare(
        "SELECT query, vertical_id, query_count FROM query_text_daily ORDER BY query"
      ).all() as Array<Record<string, unknown>>;
      assertEq(
        qtd,
        [
          { query: "egg", vertical_id: "rfb", query_count: 2 },
          { query: "honning", vertical_id: "rfb", query_count: 1 },
          { query: "melk", vertical_id: "rfb", query_count: 1 },
          { query: "tannlege", vertical_id: "dental", query_count: 2 },
        ],
        "query_text_daily: per-query counts match the seeded rows",
      );
      assertEq(sumOf("query_text_daily", "query_count"), 6, "query_text_daily: total equals the rolled-up row count");
      assertEq(sumOf("query_daily", "query_count"), 6, "query_daily: total equals the rolled-up row count");
    }

    // ════════════════════════════════════════════════════════════════════
    // (2) rollupAndPruneAgentViews
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const newCreated = isoDaysAgo(1);

      const ins = testDb.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, vertical_id, created_at)
         VALUES (?, ?, ?, ?, 'rfb', ?)`,
      );
      for (let i = 0; i < 4; i++) ins.run("agent-a", "Gård A", "Oslo", "seo", oldCreated);
      for (let i = 0; i < 2; i++) ins.run("agent-a", "Gård A", "Oslo", "direct", oldCreated);
      for (let i = 0; i < 3; i++) ins.run("agent-b", "Gård B", null, null, oldCreated);
      ins.run("agent-a", "Gård A", "Oslo", "seo", newCreated); // in-window, must survive

      assertEq(count("analytics_agent_views"), 10, "agent-views setup: 10 seeded rows");

      const r = retention.rollupAndPruneAgentViews(DAYS_TO_KEEP, 7, false);

      assertEq(r.rowsDeleted, 9, "agent-views: 9 out-of-window rows deleted");
      assertEq(count("analytics_agent_views"), 1, "agent-views: only the in-window row remains raw");

      const avd = testDb.prepare(
        "SELECT agent_id, view_source, city, view_count FROM agent_view_daily ORDER BY agent_id, view_source"
      ).all();
      assertEq(
        avd,
        [
          { agent_id: "agent-a", view_source: "direct", city: "Oslo", view_count: 2 },
          { agent_id: "agent-a", view_source: "seo", city: "Oslo", view_count: 4 },
          // NULL view_source -> 'unknown', NULL city -> ''
          { agent_id: "agent-b", view_source: "unknown", city: "", view_count: 3 },
        ],
        "agent_view_daily: per agent/source/city counts match the seeded rows (NULLs coalesced)",
      );
      assertEq(sumOf("agent_view_daily", "view_count"), 9, "agent_view_daily: total equals the rolled-up row count");
    }

    // ════════════════════════════════════════════════════════════════════
    // (3) sessions_daily is a TRUE distinct-session count across ALL paths
    //     — the multi-path-same-session fixture. This is the whole reason
    //     sessions_daily exists rather than SUM(page_view_daily.session_count).
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const day = oldCreated.slice(0, 10);

      const ins = testDb.prepare(
        `INSERT INTO analytics_page_views
           (path, referrer, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES (?, NULL, 'direct', 'h1', ?, 200, 'rfb', ?)`,
      );
      // sess-A visits THREE different paths on the same day (2 hits on /a).
      ins.run("/a", "sess-A:Mozilla", oldCreated);
      ins.run("/a", "sess-A:Mozilla", oldCreated);
      ins.run("/b", "sess-A:Mozilla", oldCreated);
      ins.run("/c", "sess-A:Mozilla", oldCreated);
      // sess-B visits two of the same paths on the same day.
      ins.run("/a", "sess-B:Mozilla", oldCreated);
      ins.run("/b", "sess-B:Mozilla", oldCreated);

      const r = retention.rollupAndPrunePageViews(DAYS_TO_KEEP, 7, false);
      assertEq(r.rowsDeleted, 6, "sessions_daily fixture: all 6 raw page views deleted");

      // page_view_daily is PER-PATH: /a=2 sessions, /b=2 sessions, /c=1 session
      // => summing it gives 5. That number is what sessions_daily must NOT be.
      assertEq(sumOf("page_view_daily", "session_count"), 5, "control: SUM(page_view_daily.session_count) overcounts to 5 (per-path)");

      const sd = testDb.prepare(
        "SELECT day, vertical_id, bot_type, session_count FROM sessions_daily"
      ).all();
      assertEq(
        sd,
        [{ day, vertical_id: "rfb", bot_type: "human", session_count: 2 }],
        "sessions_daily: counts the 2 TRUE distinct sessions once each, not 5 (multi-path session counted once)",
      );

      // page_view_daily behaviour is unchanged by the additive sessions_daily write.
      assertEq(sumOf("page_view_daily", "view_count"), 6, "sessions_daily fixture: page_view_daily view_count unchanged (6 raw hits)");
      assertEq(count("page_view_daily"), 3, "sessions_daily fixture: page_view_daily still one row per path");
    }

    // sessions_daily splits bot_type, and bots do not contaminate the human count
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const day = oldCreated.slice(0, 10);
      const ins = testDb.prepare(
        `INSERT INTO analytics_page_views
           (path, referrer, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES (?, NULL, 'direct', 'h1', ?, 200, ?, ?)`,
      );
      ins.run("/x", "sess-H:Mozilla", "rfb", oldCreated);
      ins.run("/y", "sess-H:Mozilla", "rfb", oldCreated);
      ins.run("/x", "sess-G:GPTBot/1.0", "rfb", oldCreated);
      ins.run("/y", "sess-G:GPTBot/1.0", "rfb", oldCreated);
      ins.run("/x", "sess-D:Mozilla", "dental", oldCreated);

      retention.rollupAndPrunePageViews(DAYS_TO_KEEP, 7, false);

      const sd = testDb.prepare(
        "SELECT day, vertical_id, bot_type, session_count FROM sessions_daily ORDER BY vertical_id, bot_type"
      ).all();
      assertEq(
        sd,
        [
          { day, vertical_id: "dental", bot_type: "human", session_count: 1 },
          { day, vertical_id: "rfb", bot_type: "chatgpt", session_count: 1 },
          { day, vertical_id: "rfb", bot_type: "human", session_count: 1 },
        ],
        "sessions_daily: split per vertical × bot_type, each multi-path session counted once",
      );
    }

    // is_owner rows are excluded from sessions_daily/page_view_daily but still deleted
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      testDb.prepare(
        `INSERT INTO analytics_page_views
           (path, source, user_agent_hash, session_id, status_code, vertical_id, is_owner, created_at)
         VALUES ('/owner', 'direct', 'h1', 'sess-O:Mozilla', 200, 'rfb', 1, ?)`,
      ).run(oldCreated);
      testDb.prepare(
        `INSERT INTO analytics_page_views
           (path, source, user_agent_hash, session_id, status_code, vertical_id, is_owner, created_at)
         VALUES ('/pub', 'direct', 'h1', 'sess-P:Mozilla', 200, 'rfb', 0, ?)`,
      ).run(oldCreated);

      const r = retention.rollupAndPrunePageViews(DAYS_TO_KEEP, 7, false);
      assertEq(r.rowsDeleted, 2, "is_owner: both raw rows deleted regardless of is_owner");
      assertEq(sumOf("sessions_daily", "session_count"), 1, "is_owner: owner session excluded from sessions_daily aggregate");
      assertEq(sumOf("page_view_daily", "view_count"), 1, "is_owner: owner page view excluded from page_view_daily aggregate");
    }

    // ════════════════════════════════════════════════════════════════════
    // (4) Idempotency — a second rollup over an exhausted window is a no-op
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      testDb.prepare(
        `INSERT INTO analytics_queries (protocol, query, city, result_count, response_time_ms, agent_id, vertical_id, created_at)
         VALUES ('a2a', 'egg', 'Oslo', 5, 100, 'gpt-1', 'rfb', ?)`,
      ).run(oldCreated);
      testDb.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, vertical_id, created_at)
         VALUES ('agent-a', 'Gård A', 'Oslo', 'seo', 'rfb', ?)`,
      ).run(oldCreated);
      testDb.prepare(
        `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES ('/a', 'direct', 'h1', 'sess-A:Mozilla', 200, 'rfb', ?)`,
      ).run(oldCreated);

      retention.rollupAndPruneQueries(DAYS_TO_KEEP, 7, false);
      retention.rollupAndPruneAgentViews(DAYS_TO_KEEP, 7, false);
      retention.rollupAndPrunePageViews(DAYS_TO_KEEP, 7, false);

      const after1 = {
        queryDaily: sumOf("query_daily", "query_count"),
        queryTextDaily: sumOf("query_text_daily", "query_count"),
        agentViewDaily: sumOf("agent_view_daily", "view_count"),
        pageViewDaily: sumOf("page_view_daily", "view_count"),
        sessionsDaily: sumOf("sessions_daily", "session_count"),
        rows: [count("query_daily"), count("query_text_daily"), count("agent_view_daily"),
               count("page_view_daily"), count("sessions_daily")],
      };
      assertEq(after1.queryDaily, 1, "idempotency setup: one query rolled up");
      assertEq(after1.agentViewDaily, 1, "idempotency setup: one agent view rolled up");
      assertEq(after1.sessionsDaily, 1, "idempotency setup: one session rolled up");

      const r2q = retention.rollupAndPruneQueries(DAYS_TO_KEEP, 7, false);
      const r2a = retention.rollupAndPruneAgentViews(DAYS_TO_KEEP, 7, false);
      const r2p = retention.rollupAndPrunePageViews(DAYS_TO_KEEP, 7, false);

      assertEq([r2q.rowsDeleted, r2a.rowsDeleted, r2p.rowsDeleted], [0, 0, 0],
        "idempotency: second rollup pass deletes nothing (source already exhausted)");
      assertEq(
        {
          queryDaily: sumOf("query_daily", "query_count"),
          queryTextDaily: sumOf("query_text_daily", "query_count"),
          agentViewDaily: sumOf("agent_view_daily", "view_count"),
          pageViewDaily: sumOf("page_view_daily", "view_count"),
          sessionsDaily: sumOf("sessions_daily", "session_count"),
          rows: [count("query_daily"), count("query_text_daily"), count("agent_view_daily"),
                 count("page_view_daily"), count("sessions_daily")],
        },
        after1,
        "idempotency: no rollup table double-counts or loses rows on a second pass",
      );
    }

    // ════════════════════════════════════════════════════════════════════
    // (5) runAutoPrune() end-to-end
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      const servicePath = require.resolve("./analytics-service");
      delete require.cache[servicePath];
      const { analyticsService } = require("./analytics-service") as
        typeof import("./analytics-service");

      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const newCreated = isoDaysAgo(1);

      const insPv = testDb.prepare(
        `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES (?, 'direct', 'h1', ?, 200, 'rfb', ?)`,
      );
      insPv.run("/a", "sess-A:Mozilla", oldCreated);
      insPv.run("/b", "sess-A:Mozilla", oldCreated);
      insPv.run("/a", "sess-B:Mozilla", oldCreated);
      insPv.run("/keep", "sess-C:Mozilla", newCreated);

      const insQ = testDb.prepare(
        `INSERT INTO analytics_queries (protocol, query, city, result_count, response_time_ms, agent_id, vertical_id, created_at)
         VALUES ('a2a', ?, 'Oslo', 2, 120, 'gpt-1', 'rfb', ?)`,
      );
      insQ.run("egg", oldCreated);
      insQ.run("melk", oldCreated);
      insQ.run("keep-me", newCreated);

      const insAv = testDb.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, vertical_id, created_at)
         VALUES ('agent-a', 'Gård A', 'Oslo', 'seo', 'rfb', ?)`,
      );
      insAv.run(oldCreated);
      insAv.run(oldCreated);
      insAv.run(oldCreated);
      insAv.run(newCreated);

      const result = analyticsService.runAutoPrune({ daysToKeep: DAYS_TO_KEEP });

      assertEq(result.skippedPendingRollup, [], "runAutoPrune: skippedPendingRollup is now [] (all three tables covered)");
      assertEq(result.deleted.pageViews, 3, "runAutoPrune: deleted.pageViews counts the real page-view deletions");
      assertEq(result.deleted.queries, 2, "runAutoPrune: deleted.queries counts the real query deletions");
      assertEq(result.deleted.agentViews, 3, "runAutoPrune: deleted.agentViews counts the real agent-view deletions");
      assertEq(result.wouldDeleteIfPruned, { queries: 2, agentViews: 3 },
        "runAutoPrune: wouldDeleteIfPruned still sizes the pre-delete backlog");

      assertEq(
        [count("analytics_page_views"), count("analytics_queries"), count("analytics_agent_views")],
        [1, 1, 1],
        "runAutoPrune: exactly the in-window row survives in each raw table",
      );

      const rollupSnapshot = () => ({
        pageViewDaily: [count("page_view_daily"), sumOf("page_view_daily", "view_count")],
        sessionsDaily: [count("sessions_daily"), sumOf("sessions_daily", "session_count")],
        queryDaily: [count("query_daily"), sumOf("query_daily", "query_count")],
        queryTextDaily: [count("query_text_daily"), sumOf("query_text_daily", "query_count")],
        agentViewDaily: [count("agent_view_daily"), sumOf("agent_view_daily", "view_count")],
      });

      const snap1 = rollupSnapshot();
      assertEq(snap1.pageViewDaily, [2, 3], "runAutoPrune: page_view_daily has 2 path rows totalling 3 views");
      assertEq(snap1.sessionsDaily, [1, 2], "runAutoPrune: sessions_daily has 2 distinct sessions (sess-A counted once across /a and /b)");
      assertEq(snap1.queryDaily, [1, 2], "runAutoPrune: query_daily has 1 dimension row totalling 2 queries");
      assertEq(snap1.queryTextDaily, [2, 2], "runAutoPrune: query_text_daily has one row per query text");
      assertEq(snap1.agentViewDaily, [1, 3], "runAutoPrune: agent_view_daily totals 3 views");

      // Repeated calls once the source is exhausted must NEVER change a rollup table.
      const r2 = analyticsService.runAutoPrune({ daysToKeep: DAYS_TO_KEEP });
      const r3 = analyticsService.runAutoPrune({ daysToKeep: DAYS_TO_KEEP });
      assertEq(r2.deleted, { pageViews: 0, queries: 0, agentViews: 0 }, "runAutoPrune: second call deletes nothing");
      assertEq(r3.deleted, { pageViews: 0, queries: 0, agentViews: 0 }, "runAutoPrune: third call deletes nothing");
      assertEq(r3.skippedPendingRollup, [], "runAutoPrune: skippedPendingRollup stays [] across calls");
      assertEq(rollupSnapshot(), snap1,
        "runAutoPrune: all 5 rollup tables are byte-stable across repeated calls (nothing ever deletes FROM a rollup table)");
    }

    // ════════════════════════════════════════════════════════════════════
    // (6) GET /admin/outreach-ready-pool/ views_count survives a prune cycle
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      testDb.exec("DELETE FROM agent_knowledge; DELETE FROM agents;");

      const testKey = "analytics-rollup-slice2-test-key";
      process.env.ADMIN_KEY = testKey;

      testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, umbrella_type)
         VALUES ('agent-pool', 'Pool Gård', 'desc', 'test', 'a@x.invalid', 'https://x.invalid', 'producer', 'key-pool', 'Oslo', NULL)`,
      ).run();
      testDb.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, website, email, verification_status, enrichment_status, url_last_probed, url_last_status,
            google_rating, google_review_count)
         VALUES ('agent-pool', 'https://x.invalid', 'post@x.invalid', 'verified', 'rich',
                 datetime('now', '-1 day'), 200, 4.5, 10)`,
      ).run();

      // 5 views well past the cutoff (will be rolled up + deleted) and
      // 2 inside the window (stay raw). Lifetime total = 7 either way.
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const newCreated = isoDaysAgo(1);
      const insAv = testDb.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, vertical_id, created_at)
         VALUES ('agent-pool', 'Pool Gård', 'Oslo', 'seo', 'rfb', ?)`,
      );
      for (let i = 0; i < 5; i++) insAv.run(oldCreated);
      for (let i = 0; i < 2; i++) insAv.run(newCreated);

      const poolPath = require.resolve("../routes/admin-outreach-pool");
      delete require.cache[poolPath];
      const poolRouter = (require("../routes/admin-outreach-pool") as any).default;
      const handler = poolRouter.stack
        .filter((l: any) => l.route && l.route.path === "/" && l.route.methods?.get)
        .map((l: any) => l.route.stack[0].handle)[0];
      assertTrue(typeof handler === "function", "outreach-pool: GET / handler resolved");

      async function viewsCount(): Promise<number | undefined> {
        const res = fakeRes();
        await handler(
          { headers: { "x-admin-key": testKey }, query: {}, body: {} } as any,
          res as any,
        );
        assertTrue(res.statusCode === 200, "outreach-pool: 200 from GET /");
        return res.body?.agents?.[0]?.views_count;
      }

      const before = await viewsCount();
      assertEq(before, 7, "outreach-pool: views_count is the full lifetime total before any prune");

      const pruneResult = retention.rollupAndPruneAgentViews(DAYS_TO_KEEP, 7, false);
      assertEq(pruneResult.rowsDeleted, 5, "outreach-pool: 5 old raw agent-view rows rolled up + deleted");
      assertEq(count("analytics_agent_views"), 2, "outreach-pool: only the 2 in-window raw rows remain");
      assertEq(sumOf("agent_view_daily", "view_count"), 5, "outreach-pool: the 5 pruned views live on in agent_view_daily");

      const after = await viewsCount();
      assertEq(after, before, "outreach-pool: views_count UNCHANGED across a rollup+delete cycle (rollup + remaining raw)");
      assertEq(after, 7, "outreach-pool: views_count is still the full lifetime total (7), not the 2 surviving raw rows");
    }

    // ════════════════════════════════════════════════════════════════════
    // (7) TRANSACTION-BOUNDARY REGRESSION PINS (review round 2, finding 1)
    //
    // The whole safety property of this slice is "the rollup INSERTs and the
    // raw DELETE are ONE transaction, so a batch is all-or-nothing: history is
    // never deleted without having landed in a rollup table first, and a rollup
    // is never left half-written". Every assertion above this point only
    // observes the happy path, where a broken boundary produces byte-identical
    // results — the reviewer proved it by moving each DELETE out of its
    // db.transaction() callback and watching all three suites still pass.
    //
    // These probes make ONE statement inside the transaction fail and assert an
    // all-or-nothing outcome. Two directions are needed to pin the boundary
    // from both sides:
    //
    //   (a) INSERT-side: drop the target rollup table so a rollup INSERT
    //       throws. Then the DELETE must NOT have happened (source rows all
    //       survive) and any SIBLING rollup INSERT in the same transaction must
    //       show nothing either. Catches a DELETE that commits independently /
    //       ahead of the rollup.
    //   (b) DELETE-side: a BEFORE DELETE trigger aborts the raw DELETE. Then
    //       the rollup INSERTs must be rolled back too. Catches the mirror
    //       break — rollup INSERTs committing in their own transaction with the
    //       DELETE outside/after it, which the INSERT-side probe alone cannot
    //       see (the throw would simply short-circuit before the DELETE ran).
    // ════════════════════════════════════════════════════════════════════

    // (7a) rollupAndPruneQueries — INSERT-side: query_text_daily is gone.
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const newCreated = isoDaysAgo(1);
      const ins = testDb.prepare(
        `INSERT INTO analytics_queries
           (protocol, query, city, result_count, response_time_ms, agent_id, vertical_id, created_at)
         VALUES ('a2a', ?, 'Oslo', 2, 120, 'gpt-1', 'rfb', ?)`,
      );
      ins.run("egg", oldCreated);
      ins.run("melk", oldCreated);
      ins.run("honning", oldCreated);
      ins.run("keep-me", newCreated);
      assertEq(count("analytics_queries"), 4, "atomicity/queries: 4 seeded rows (3 out-of-window)");

      withDroppedTable("query_text_daily", () => {
        assertThrows(
          () => retention.rollupAndPruneQueries(DAYS_TO_KEEP, 7, false),
          "atomicity/queries: a failing rollup INSERT propagates out of rollupAndPruneQueries",
        );
      });

      assertEq(count("analytics_queries"), 4,
        "atomicity/queries: DELETE rolled back — every source row for the failed batch survives");
      assertEq(count("query_daily"), 0,
        "atomicity/queries: the SIBLING rollup INSERT (query_daily) rolled back too — whole transaction, not just the failing statement");
      assertEq(count("query_text_daily"), 0, "atomicity/queries: query_text_daily empty after the failed batch");

      // Recovery: with the table back, the SAME batch rolls up exactly once —
      // the failed attempt left no partial state to double-count.
      const rec = retention.rollupAndPruneQueries(DAYS_TO_KEEP, 7, false);
      assertEq(rec.rowsDeleted, 3, "atomicity/queries: retry after the failure deletes the 3 out-of-window rows");
      assertEq(count("analytics_queries"), 1, "atomicity/queries: retry leaves only the in-window row");
      assertEq(sumOf("query_daily", "query_count"), 3, "atomicity/queries: retry rolls up exactly 3 queries (no double-count)");
      assertEq(sumOf("query_text_daily", "query_count"), 3, "atomicity/queries: retry rolls up exactly 3 query texts");
    }

    // (7b) rollupAndPruneQueries — DELETE-side: the raw DELETE aborts.
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      testDb.prepare(
        `INSERT INTO analytics_queries
           (protocol, query, city, result_count, response_time_ms, agent_id, vertical_id, created_at)
         VALUES ('a2a', 'egg', 'Oslo', 2, 120, 'gpt-1', 'rfb', ?)`,
      ).run(oldCreated);

      withDeleteBlocked("analytics_queries", () => {
        assertThrows(
          () => retention.rollupAndPruneQueries(DAYS_TO_KEEP, 7, false),
          "atomicity/queries: a failing raw DELETE propagates out of rollupAndPruneQueries",
        );
      });

      assertEq(count("analytics_queries"), 1, "atomicity/queries: source row still there after the aborted DELETE");
      assertEq(count("query_daily"), 0,
        "atomicity/queries: query_daily INSERT rolled back with the failed DELETE (INSERTs are NOT committed separately)");
      assertEq(count("query_text_daily"), 0,
        "atomicity/queries: query_text_daily INSERT rolled back with the failed DELETE");
    }

    // (7c) rollupAndPruneAgentViews — INSERT-side: agent_view_daily is gone.
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const newCreated = isoDaysAgo(1);
      const ins = testDb.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, vertical_id, created_at)
         VALUES ('agent-a', 'Gård A', 'Oslo', 'seo', 'rfb', ?)`,
      );
      ins.run(oldCreated);
      ins.run(oldCreated);
      ins.run(oldCreated);
      ins.run(newCreated);
      assertEq(count("analytics_agent_views"), 4, "atomicity/agent-views: 4 seeded rows (3 out-of-window)");

      withDroppedTable("agent_view_daily", () => {
        assertThrows(
          () => retention.rollupAndPruneAgentViews(DAYS_TO_KEEP, 7, false),
          "atomicity/agent-views: a failing rollup INSERT propagates out of rollupAndPruneAgentViews",
        );
      });

      assertEq(count("analytics_agent_views"), 4,
        "atomicity/agent-views: DELETE rolled back — every source row for the failed batch survives");
      assertEq(count("agent_view_daily"), 0, "atomicity/agent-views: agent_view_daily empty after the failed batch");

      const rec = retention.rollupAndPruneAgentViews(DAYS_TO_KEEP, 7, false);
      assertEq(rec.rowsDeleted, 3, "atomicity/agent-views: retry after the failure deletes the 3 out-of-window rows");
      assertEq(sumOf("agent_view_daily", "view_count"), 3, "atomicity/agent-views: retry rolls up exactly 3 views (no double-count)");
    }

    // (7d) rollupAndPruneAgentViews — DELETE-side: the raw DELETE aborts.
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      testDb.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, vertical_id, created_at)
         VALUES ('agent-a', 'Gård A', 'Oslo', 'seo', 'rfb', ?)`,
      ).run(oldCreated);

      withDeleteBlocked("analytics_agent_views", () => {
        assertThrows(
          () => retention.rollupAndPruneAgentViews(DAYS_TO_KEEP, 7, false),
          "atomicity/agent-views: a failing raw DELETE propagates out of rollupAndPruneAgentViews",
        );
      });

      assertEq(count("analytics_agent_views"), 1, "atomicity/agent-views: source row still there after the aborted DELETE");
      assertEq(count("agent_view_daily"), 0,
        "atomicity/agent-views: agent_view_daily INSERT rolled back with the failed DELETE");
    }

    // (7e) rollupAndPrunePageViews / sessions_daily — INSERT-side: sessions_daily
    //      is gone, so THIS slice's added INSERT (1b) is what throws. page_view_daily
    //      (INSERT 1a, which already succeeded inside the same transaction) must show
    //      nothing — that is the "whole transaction rolled back" proof.
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const newCreated = isoDaysAgo(1);
      const ins = testDb.prepare(
        `INSERT INTO analytics_page_views
           (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES (?, 'direct', 'h1', ?, 200, 'rfb', ?)`,
      );
      ins.run("/a", "sess-A:Mozilla", oldCreated);
      ins.run("/b", "sess-A:Mozilla", oldCreated);
      ins.run("/a", "sess-B:Mozilla", oldCreated);
      ins.run("/keep", "sess-C:Mozilla", newCreated);
      assertEq(count("analytics_page_views"), 4, "atomicity/page-views: 4 seeded rows (3 out-of-window)");

      withDroppedTable("sessions_daily", () => {
        assertThrows(
          () => retention.rollupAndPrunePageViews(DAYS_TO_KEEP, 7, false),
          "atomicity/page-views: a failing sessions_daily INSERT propagates out of rollupAndPrunePageViews",
        );
      });

      assertEq(count("analytics_page_views"), 4,
        "atomicity/page-views: DELETE rolled back — every source row for the failed batch survives");
      assertEq(count("page_view_daily"), 0,
        "atomicity/page-views: the OTHER rollup INSERT (page_view_daily) rolled back too — sessions_daily is inside the SAME transaction, not appended after it");
      assertEq(count("sessions_daily"), 0, "atomicity/page-views: sessions_daily empty after the failed batch");

      const rec = retention.rollupAndPrunePageViews(DAYS_TO_KEEP, 7, false);
      assertEq(rec.rowsDeleted, 3, "atomicity/page-views: retry after the failure deletes the 3 out-of-window rows");
      assertEq(sumOf("page_view_daily", "view_count"), 3, "atomicity/page-views: retry rolls up exactly 3 views (no double-count)");
      assertEq(sumOf("sessions_daily", "session_count"), 2, "atomicity/page-views: retry rolls up the 2 TRUE distinct sessions");
    }

    // (7f) rollupAndPrunePageViews — DELETE-side: the raw DELETE aborts.
    {
      clearAll();
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      testDb.prepare(
        `INSERT INTO analytics_page_views
           (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES ('/a', 'direct', 'h1', 'sess-A:Mozilla', 200, 'rfb', ?)`,
      ).run(oldCreated);

      withDeleteBlocked("analytics_page_views", () => {
        assertThrows(
          () => retention.rollupAndPrunePageViews(DAYS_TO_KEEP, 7, false),
          "atomicity/page-views: a failing raw DELETE propagates out of rollupAndPrunePageViews",
        );
      });

      assertEq(count("analytics_page_views"), 1, "atomicity/page-views: source row still there after the aborted DELETE");
      assertEq(count("page_view_daily"), 0,
        "atomicity/page-views: page_view_daily INSERT rolled back with the failed DELETE");
      assertEq(count("sessions_daily"), 0,
        "atomicity/page-views: sessions_daily INSERT rolled back with the failed DELETE");
    }

    // ════════════════════════════════════════════════════════════════════
    // (8) GET /admin/outreach-candidates views_count (review round 2, finding 2)
    //
    // admin-outreach-candidates.ts carries the SAME rollup+raw views_count fix
    // as admin-outreach-pool.ts, in TWO separate SQL branches (mode=first, which
    // reads the outreach_ready_pool VIEW, and mode=second, which reads the base
    // agents/agent_knowledge conditions without the sent_log exclusion). Section
    // (6) above only covers the pool, so reverting either branch back to the
    // unbounded `(SELECT COUNT(*) FROM analytics_agent_views …)` went unnoticed.
    //
    // The route never LEAKS views_count (the response is stripped back to
    // {agent_id, name, email}), so it is read out here the only way a caller
    // can observe it: through dedupeByEmail()'s tiebreaker. A probe agent shares
    // the target's email and holds a known number of raw views; the winner
    // brackets the target's views_count exactly.
    //
    //   probe = 7 views → target wins  ⟺ target_views >= 7 (tie breaks on name asc)
    //   probe = 8 views → probe wins   ⟺ target_views <  8
    //   ⇒ target_views == 7 — the full lifetime total (5 rolled up + 2 raw),
    //     NOT the 2 surviving raw rows the reverted query would count.
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      testDb.exec("DELETE FROM agent_knowledge; DELETE FROM agents; DELETE FROM outreach_sent_log;");

      const testKey = "analytics-rollup-slice2-test-key";
      process.env.ADMIN_KEY = testKey;

      const insAgent = testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, umbrella_type)
         VALUES (?, ?, 'desc', 'test', ?, 'https://x.invalid', 'producer', ?, 'Oslo', NULL)`,
      );
      const insKnowledge = testDb.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, website, email, field_provenance, verification_status, enrichment_status,
            url_last_probed, url_last_status)
         VALUES (?, 'https://x.invalid', ?, '{}', 'verified', 'rich', datetime('now', '-1 day'), 200)`,
      );
      function insertPoolAgent(id: string, name: string, email: string): void {
        insAgent.run(id, name, email, `key-${id}`);
        insKnowledge.run(id, email);
      }
      const insView = testDb.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, vertical_id, created_at)
         VALUES (?, ?, 'Oslo', 'seo', 'rfb', ?)`,
      );
      function insertViews(agentId: string, name: string, n: number, createdAt: string): void {
        for (let i = 0; i < n; i++) insView.run(agentId, name, createdAt);
      }
      function insertPriorContact(agentId: string, email: string, daysAgo: number): void {
        testDb.prepare(
          `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
           VALUES (?, ?, datetime('now', ?), 'email', ?, 'test:prior', 'rfb')`,
        ).run(agentId, email.toLowerCase(), `-${daysAgo} days`, `msg-prior-${agentId}`);
      }

      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const newCreated = isoDaysAgo(1);

      // mode=first fixture: never contacted → visible through outreach_ready_pool.
      insertPoolAgent("cs1-target", "Aa Rollup Target", "cand-first@prod-test.no");
      insertPoolAgent("cs1-probe", "Zz Probe", "cand-first@prod-test.no");
      insertViews("cs1-target", "Aa Rollup Target", 5, oldCreated); // → agent_view_daily
      insertViews("cs1-target", "Aa Rollup Target", 2, newCreated); // → stays raw

      // mode=second fixture: contacted 120 days ago (>60d cooldown), so the
      // outreach_ready_pool VIEW excludes it and the mode=second branch is the
      // ONLY query that can return it.
      insertPoolAgent("cs2-target", "Aa Rollup Target 2", "cand-second@prod-test.no");
      insertPoolAgent("cs2-probe", "Zz Probe 2", "cand-second@prod-test.no");
      insertPriorContact("cs2-target", "cand-second@prod-test.no", 120);
      insertPriorContact("cs2-probe", "cand-second@prod-test.no", 120);
      insertViews("cs2-target", "Aa Rollup Target 2", 5, oldCreated);
      insertViews("cs2-target", "Aa Rollup Target 2", 2, newCreated);

      // Prune: the 5 old rows per target move into agent_view_daily and the raw
      // rows are deleted. Lifetime total per target is still 5 + 2 = 7.
      const pruned = retention.rollupAndPruneAgentViews(DAYS_TO_KEEP, 7, false);
      assertEq(pruned.rowsDeleted, 10, "outreach-candidates: the 10 old raw agent-view rows rolled up + deleted");
      assertEq(count("analytics_agent_views"), 4, "outreach-candidates: only the 4 in-window raw rows remain");
      assertEq(sumOf("agent_view_daily", "view_count"), 10, "outreach-candidates: the pruned views live on in agent_view_daily");

      // Probes are seeded AFTER the prune so all 7 of their views stay raw.
      insertViews("cs1-probe", "Zz Probe", 7, newCreated);
      insertViews("cs2-probe", "Zz Probe 2", 7, newCreated);

      const candidatesRouter = (require("../routes/admin-outreach-candidates") as any).default;
      const candidatesHandler = candidatesRouter.stack
        .filter((l: any) => l.route && l.route.path === "/" && l.route.methods?.get)
        .map((l: any) => l.route.stack[0].handle)[0];
      assertTrue(typeof candidatesHandler === "function", "outreach-candidates: GET / handler resolved");

      const poolRouter2 = (require("../routes/admin-outreach-pool") as any).default;
      const poolHandler2 = poolRouter2.stack
        .filter((l: any) => l.route && l.route.path === "/" && l.route.methods?.get)
        .map((l: any) => l.route.stack[0].handle)[0];

      async function candidateWinnerFor(mode: string, email: string): Promise<string | undefined> {
        const res = fakeRes();
        await candidatesHandler(
          { headers: { "x-admin-key": testKey }, query: { mode, cooldown_days: "60" }, body: {} } as any,
          res as any,
        );
        assertTrue(res.statusCode === 200, `outreach-candidates: 200 from GET /?mode=${mode}`);
        const list = (res.body?.candidates || []) as Array<{ agent_id: string; email: string }>;
        return list.find((c) => (c.email || "").toLowerCase() === email)?.agent_id;
      }

      /** views_count as the POOL reports it, with dedupe OFF so every row is visible. */
      async function poolViewsCount(agentId: string): Promise<number | undefined> {
        const res = fakeRes();
        await poolHandler2(
          { headers: { "x-admin-key": testKey }, query: { dedupe_by_email: "false", limit: "500" }, body: {} } as any,
          res as any,
        );
        assertTrue(res.statusCode === 200, "outreach-pool: 200 from GET /?dedupe_by_email=false");
        const row = ((res.body?.agents || []) as Array<any>).find((a) => a.agent_id === agentId);
        return row?.views_count;
      }

      // ── mode=first branch ──────────────────────────────────────────────────
      assertEq(
        await candidateWinnerFor("first", "cand-first@prod-test.no"),
        "cs1-target",
        "outreach-candidates mode=first: rollup-backed agent (5 rolled up + 2 raw = 7) beats a 7-raw-view probe on the SAME email — a raw-only COUNT(*) would see 2 and lose",
      );
      insertViews("cs1-probe", "Zz Probe", 1, newCreated); // probe now 8
      assertEq(
        await candidateWinnerFor("first", "cand-first@prod-test.no"),
        "cs1-probe",
        "outreach-candidates mode=first: an 8-raw-view probe wins — brackets the rollup-backed views_count at exactly 7, not higher",
      );

      // ── mode=second branch ─────────────────────────────────────────────────
      assertEq(
        await candidateWinnerFor("second", "cand-second@prod-test.no"),
        "cs2-target",
        "outreach-candidates mode=second: SAME rollup+raw views_count in the second SQL branch (7 beats a 7-raw probe on name asc)",
      );
      insertViews("cs2-probe", "Zz Probe 2", 1, newCreated); // probe now 8
      assertEq(
        await candidateWinnerFor("second", "cand-second@prod-test.no"),
        "cs2-probe",
        "outreach-candidates mode=second: an 8-raw-view probe wins — brackets the second branch's views_count at exactly 7 too",
      );

      // ── The two endpoints must AGREE on views_count for the same agent ─────
      // Both feed marketing-dedupe.ts's tiebreaker and the route files say so
      // explicitly. The pool reports the number directly; the candidates route's
      // number is the one bracketed to 7 above, on this exact DB state.
      assertEq(await poolViewsCount("cs1-target"), 7,
        "views_count parity: outreach-pool reports 7 for the rollup+raw agent (the same value outreach-candidates was just bracketed to)");
      assertEq(await poolViewsCount("cs1-probe"), 8,
        "views_count parity: outreach-pool reports 8 for the raw-only probe");

      // ...and therefore pick the SAME dedupe winner for that shared email.
      const poolRes = fakeRes();
      await poolHandler2(
        { headers: { "x-admin-key": testKey }, query: {}, body: {} } as any,
        poolRes as any,
      );
      const poolWinner = ((poolRes.body?.agents || []) as Array<any>)
        .find((a) => (a.email || "").toLowerCase() === "cand-first@prod-test.no")?.agent_id;
      assertEq(
        poolWinner,
        await candidateWinnerFor("first", "cand-first@prod-test.no"),
        "views_count parity: outreach-pool and outreach-candidates pick the SAME winner for the same email after a prune cycle",
      );
    }

    // ════════════════════════════════════════════════════════════════════
    // (9) Agent opt-out deletion clears agent_view_daily (review round 2,
    //     finding 3)
    //
    // DELETE /admin/agents/:id in routes/marketplace.ts is the opt-out /
    // removal path (its own 409 names "?force=1" as the opt-out case) and is
    // meant to remove ALL of an agent's tracking data. After this slice, part
    // of that history is permanent aggregate in agent_view_daily, so the route
    // clears that table too — in the SAME transaction as the raw delete.
    //
    // DELIBERATE asymmetry with retention: runAutoPrune / retention-service.ts
    // NEVER delete a rollup row (that is this whole slice's point). An explicit
    // user-initiated opt-out is a deletion request, not a retention policy.
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      testDb.exec("DELETE FROM agent_knowledge; DELETE FROM agents; DELETE FROM outreach_sent_log; DELETE FROM agent_blocklist;");

      const testKey = "analytics-rollup-slice2-test-key";
      process.env.ADMIN_KEY = testKey;

      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const newCreated = isoDaysAgo(1);

      function insertOptOutAgent(id: string, name: string, email: string): void {
        testDb.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, umbrella_type, is_verified)
           VALUES (?, ?, 'desc', 'test', ?, 'https://x.invalid', 'producer', ?, 'Oslo', NULL, 1)`,
        ).run(id, name, email, `key-${id}`);
        testDb.prepare(
          `INSERT INTO agent_knowledge
             (agent_id, website, email, field_provenance, verification_status, enrichment_status,
              url_last_probed, url_last_status)
           VALUES (?, 'https://x.invalid', ?, '{}', 'verified', 'rich', datetime('now', '-1 day'), 200)`,
        ).run(id, email);
      }
      const insView = testDb.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, vertical_id, created_at)
         VALUES (?, ?, 'Oslo', 'seo', 'rfb', ?)`,
      );

      insertOptOutAgent("optout-1", "Opt Out Gård", "optout@prod-test.no");
      insertOptOutAgent("keep-1", "Keep Gård", "keep@prod-test.no");
      for (let i = 0; i < 5; i++) insView.run("optout-1", "Opt Out Gård", oldCreated);
      for (let i = 0; i < 2; i++) insView.run("optout-1", "Opt Out Gård", newCreated);
      for (let i = 0; i < 3; i++) insView.run("keep-1", "Keep Gård", oldCreated);

      retention.rollupAndPruneAgentViews(DAYS_TO_KEEP, 7, false);
      const rollupFor = (agentId: string) =>
        (testDb.prepare("SELECT COALESCE(SUM(view_count), 0) AS s FROM agent_view_daily WHERE agent_id = ?")
          .get(agentId) as { s: number }).s;
      const rawFor = (agentId: string) =>
        (testDb.prepare("SELECT COUNT(*) AS c FROM analytics_agent_views WHERE agent_id = ?")
          .get(agentId) as { c: number }).c;

      assertEq(rollupFor("optout-1"), 5, "opt-out: 5 of the agent's views are permanent rollup history before the delete");
      assertEq(rawFor("optout-1"), 2, "opt-out: 2 of the agent's views are still raw before the delete");

      const marketplaceRouter = (require("../routes/marketplace") as any).default;
      const deleteHandler = marketplaceRouter.stack
        .filter((l: any) => l.route && l.route.path === "/agents/:id" && l.route.methods?.delete)
        .map((l: any) => l.route.stack[0].handle)[0];
      assertTrue(typeof deleteHandler === "function", "opt-out: DELETE /agents/:id handler resolved");

      const delRes = fakeRes();
      await deleteHandler(
        {
          headers: { "x-admin-key": testKey },
          params: { id: "optout-1" },
          // ?force=1 — the opt-out path named by the route's own 409 text.
          query: { force: "1", skipBlocklist: "1" },
          body: {},
          ip: "127.0.0.1",
        } as any,
        delRes as any,
      );
      assertEq(delRes.statusCode, 200, "opt-out: DELETE /admin/agents/:id?force=1 → 200");
      assertEq(delRes.body?.success, true, "opt-out: delete reports success");

      assertEq(rawFor("optout-1"), 0, "opt-out: raw analytics_agent_views rows for the agent are gone (pre-existing behaviour)");
      assertEq(rollupFor("optout-1"), 0,
        "opt-out: agent_view_daily rows for the agent are gone too — an opt-out DOES remove the rollup, unlike runAutoPrune/retention-service.ts");
      assertEq(count("agent_view_daily") > 0, true, "opt-out: the delete is scoped to that agent_id (other agents' rollup rows survive)");
      assertEq(rollupFor("keep-1"), 3, "opt-out: an unrelated agent keeps its full rollup history");
      assertEq(
        (testDb.prepare("SELECT COUNT(*) AS c FROM agents WHERE id = 'optout-1'").get() as { c: number }).c,
        0,
        "opt-out: the agent row itself is gone",
      );

      // agent_id reuse: a NEW agent registered under the same id must start at
      // views_count 0. Without the agent_view_daily delete above, the pool would
      // report the opted-out producer's 5 rolled-up views for a different farm.
      insertOptOutAgent("optout-1", "Ny Gård samme id", "ny@prod-test.no");
      const poolRouter3 = (require("../routes/admin-outreach-pool") as any).default;
      const poolHandler3 = poolRouter3.stack
        .filter((l: any) => l.route && l.route.path === "/" && l.route.methods?.get)
        .map((l: any) => l.route.stack[0].handle)[0];
      const reuseRes = fakeRes();
      await poolHandler3(
        { headers: { "x-admin-key": testKey }, query: { dedupe_by_email: "false", limit: "500" }, body: {} } as any,
        reuseRes as any,
      );
      const reuseRow = ((reuseRes.body?.agents || []) as Array<any>).find((a) => a.agent_id === "optout-1");
      assertEq(reuseRow?.views_count, 0,
        "opt-out: a reused agent_id reads back views_count 0 — no rollup remainder resurfaces");
    }
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevOutreachPaused === undefined) delete process.env.OUTREACH_PAUSED;
    else process.env.OUTREACH_PAUSED = prevOutreachPaused;
    if (prevDb) __setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAnalyticsRollupSlice2Tests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
