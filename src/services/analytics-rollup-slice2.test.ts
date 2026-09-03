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
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
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
