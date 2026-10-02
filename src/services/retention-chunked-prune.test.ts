/**
 * dev-request 2026-10-01-prod-auto-prune-skansom — chunked, index-friendly
 * rollup+prune (retention-service.ts core).
 *
 * Proves, against the LEGACY substr()-filter / single-transaction-per-batch
 * implementation inlined below as the reference:
 *   (1) identical rowsDeleted, identical rollup tables (page_view_daily,
 *       sessions_daily, page_view_utm_daily, query_daily, query_text_daily,
 *       agent_view_daily) and identical surviving raw rows on a dataset with
 *       mixed created_at formats (space, 'T', bare date, ms+Z, NULL, non-date)
 *   (2) the same when every day is forced down the chunked/marker path
 *   (3) delete transactions are bounded and the async variant yields between them
 *   (4) a crash after the rollup commit, or mid-delete, followed by a re-run
 *       gives the legacy result (no double count) and clears the marker
 *   (5) a degenerate '' oldest value behaves as before (job is a no-op)
 *   (6) no substr()-wrapped created_at range filter is left in the service
 *
 * Wired into tests/test.ts; standalone: npx tsx src/services/retention-chunked-prune.test.ts
 */

import Database from "better-sqlite3";
import fs from "fs";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runRetentionChunkedPruneTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevDb = (() => { try { return getDb(); } catch { return undefined; } })();
  const retention = require("./retention-service") as typeof import("./retention-service");

  const WINDOW = 90;

  function dayStr(daysAgo: number): string {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  }

  // Deterministic mixed-format timestamps for one day.
  function stampsFor(day: string, i: number): string {
    const hh = String(i % 24).padStart(2, "0");
    const mm = String((i * 7) % 60).padStart(2, "0");
    switch (i % 5) {
      case 0: return `${day} ${hh}:${mm}:05`;
      case 1: return `${day}T${hh}:${mm}:05`;
      case 2: return `${day}T${hh}:${mm}:05.123Z`;
      case 3: return day;                       // bare 10-char date
      default: return `${day} ${hh}:${mm}:59`;
    }
  }

  /** rowsPerDay old days (130..100 days ago) + in-window rows + odd rows. */
  function seed(db: Database.Database, rowsPerDay: number, withOdd: boolean): void {
    const pv = db.prepare(
      `INSERT INTO analytics_page_views (path, source, session_id, created_at, is_owner, vertical_id, utm_source, utm_medium)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const q = db.prepare(
      `INSERT INTO analytics_queries (protocol, query, city, result_count, response_time_ms, agent_id, created_at, is_owner, vertical_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const av = db.prepare(
      `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      for (let off = 130; off >= 100; off--) {
        const day = dayStr(off);
        for (let i = 0; i < rowsPerDay; i++) {
          const ts = stampsFor(day, i + off);
          const sess = `s${i % 4}:${i % 9 === 0 ? "GPTBot" : "Mozilla"}`;
          pv.run(`/p${i % 3}`, i % 2 ? "organic" : null, sess, ts, i % 11 === 0 ? 1 : 0, i % 6 === 0 ? "dental" : "rfb",
            i % 4 === 0 ? "newsletter" : null, i % 4 === 0 ? "email" : null);
          q.run(i % 2 ? "mcp" : "a2a", `q${i % 5}`, i % 3 ? "Oslo" : null, i % 7, i % 4 === 0 ? null : 10 + i, i % 2 ? "ClaudeBot" : null, ts, i % 13 === 0 ? 1 : 0, "rfb");
          av.run(`agent${i % 3}`, "n", i % 2 ? "Bergen" : null, i % 2 ? "search" : null, ts);
        }
      }
      // In-window rows must survive untouched.
      for (const off of [1, 5, 30, 89]) {
        const ts = `${dayStr(off)} 12:00:00`;
        pv.run("/keep", "direct", "keep", ts, 0, "rfb", null, null);
        q.run("api", "keep", null, 1, 1, null, ts, 0, "rfb");
        av.run("keep", "n", null, null, ts);
      }
      if (withOdd) {
        // NULL / non-date / bare-date edge rows. 'garbage' sorts after any
        // date so it is never inside the pruned range; NULL never matches.
        for (const ts of [null, "garbage", "zzzz-zz-zz zz:zz:zz"]) {
          pv.run("/odd", "x", "odd", ts, 0, "rfb", null, null);
          q.run("api", "odd", null, 1, 1, null, ts, 0, "rfb");
          av.run("odd", "n", null, null, ts);
        }
      }
    })();
  }

  const BOT_CASE = `CASE
    WHEN session_id LIKE '%GPTBot%' OR session_id LIKE '%ChatGPT%' OR session_id LIKE '%OAI-SearchBot%' THEN 'chatgpt'
    WHEN session_id LIKE '%ClaudeBot%' OR session_id LIKE '%Claude-User%' OR session_id LIKE '%Anthropic%' THEN 'claude'
    WHEN session_id LIKE '%bot%' OR session_id LIKE '%Bot%' OR session_id LIKE '%spider%' OR session_id LIKE '%Spider%' OR session_id LIKE '%crawl%' OR session_id LIKE '%Crawl%' THEN 'other_bot'
    WHEN session_id LIKE '%curl/%' OR session_id LIKE '%Python/%' OR session_id LIKE '%aiohttp%' OR session_id LIKE '%node-fetch%' OR session_id LIKE '%axios/%' THEN 'dev'
    ELSE 'human' END`;

  /** REFERENCE: the pre-change implementation (substr filters, one txn per 7-day batch). */
  function legacyPrune(db: Database.Database, table: string, rollups: string[], batchDays = 7): number {
    const oldest = (db.prepare(`SELECT MIN(substr(created_at, 1, 10)) as d FROM ${table}`).get() as { d: string | null })?.d;
    if (!oldest) return 0;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - WINDOW);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);
    if (oldest >= cutoffStr) return 0;
    let deleted = 0;
    let batchStart = oldest;
    while (batchStart < cutoffStr) {
      const e = new Date(batchStart);
      e.setDate(e.getDate() + batchDays);
      let batchEnd = e.toISOString().slice(0, 10);
      if (batchEnd > cutoffStr) batchEnd = cutoffStr;
      db.transaction(() => {
        for (const sql of rollups) db.prepare(sql).run(batchStart, batchEnd);
        deleted += db.prepare(
          `DELETE FROM ${table} WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) < ?`
        ).run(batchStart, batchEnd).changes;
      })();
      batchStart = batchEnd;
    }
    return deleted;
  }
  const W = "WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) < ? AND (is_owner IS NULL OR is_owner = 0)";
  const LEGACY_PV = [
    `INSERT INTO page_view_daily (day, path, source, bot_type, vertical_id, view_count, session_count)
     SELECT substr(created_at, 1, 10) as day, path, COALESCE(source, 'unknown') as source, ${BOT_CASE} as bot_type,
       COALESCE(vertical_id, 'rfb') as vertical_id, COUNT(*), COUNT(DISTINCT session_id)
     FROM analytics_page_views ${W} GROUP BY day, path, source, bot_type, vertical_id
     ON CONFLICT(day, path, source, bot_type, vertical_id) DO UPDATE SET
       view_count = view_count + excluded.view_count, session_count = session_count + excluded.session_count`,
    `INSERT INTO sessions_daily (day, vertical_id, bot_type, session_count)
     SELECT substr(created_at, 1, 10) as day, COALESCE(vertical_id, 'rfb') as vertical_id, ${BOT_CASE} as bot_type, COUNT(DISTINCT session_id)
     FROM analytics_page_views ${W} GROUP BY day, vertical_id, bot_type
     ON CONFLICT(day, vertical_id, bot_type) DO UPDATE SET session_count = session_count + excluded.session_count`,
    `INSERT INTO page_view_utm_daily (day, utm_source, utm_medium, utm_campaign, bot_type, vertical_id, view_count, session_count)
     SELECT substr(created_at, 1, 10) as day, COALESCE(utm_source, ''), COALESCE(utm_medium, ''), COALESCE(utm_campaign, ''),
       ${BOT_CASE} as bot_type, COALESCE(vertical_id, 'rfb'), COUNT(*), COUNT(DISTINCT session_id)
     FROM analytics_page_views ${W}
       AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL)
     GROUP BY day, utm_source, utm_medium, utm_campaign, bot_type, vertical_id
     ON CONFLICT(day, utm_source, utm_medium, utm_campaign, bot_type, vertical_id) DO UPDATE SET
       view_count = view_count + excluded.view_count, session_count = session_count + excluded.session_count`,
  ];
  const LEGACY_Q = [
    `INSERT INTO query_daily (day, protocol, agent_id, vertical_id, city, query_count, result_count_sum, response_time_ms_sum, response_time_ms_n)
     SELECT substr(created_at, 1, 10) as day, COALESCE(protocol, 'unknown') as protocol, COALESCE(agent_id, '') as agent_id,
       COALESCE(vertical_id, 'rfb') as vertical_id, COALESCE(city, '') as city, COUNT(*),
       COALESCE(SUM(result_count), 0), COALESCE(SUM(response_time_ms), 0), COUNT(response_time_ms)
     FROM analytics_queries ${W} GROUP BY day, protocol, agent_id, vertical_id, city
     ON CONFLICT(day, protocol, agent_id, vertical_id, city) DO UPDATE SET
       query_count = query_count + excluded.query_count, result_count_sum = result_count_sum + excluded.result_count_sum,
       response_time_ms_sum = response_time_ms_sum + excluded.response_time_ms_sum, response_time_ms_n = response_time_ms_n + excluded.response_time_ms_n`,
    `INSERT INTO query_text_daily (day, query, vertical_id, query_count)
     SELECT substr(created_at, 1, 10) as day, query, COALESCE(vertical_id, 'rfb') as vertical_id, COUNT(*)
     FROM analytics_queries ${W} GROUP BY day, query, vertical_id
     ON CONFLICT(day, query, vertical_id) DO UPDATE SET query_count = query_count + excluded.query_count`,
  ];
  const LEGACY_AV = [
    `INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count)
     SELECT substr(created_at, 1, 10) as day, agent_id, COALESCE(view_source, 'unknown'), COALESCE(city, ''), COUNT(*)
     FROM analytics_agent_views ${W} GROUP BY day, agent_id, view_source, city
     ON CONFLICT(day, agent_id, view_source, city) DO UPDATE SET view_count = view_count + excluded.view_count`,
  ];

  const ROLLUP_TABLES = ["page_view_daily", "sessions_daily", "page_view_utm_daily", "query_daily", "query_text_daily", "agent_view_daily"];
  function snapshot(db: Database.Database): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const t of ROLLUP_TABLES) out[t] = (db.prepare(`SELECT * FROM ${t}`).all() as object[]).map((r) => JSON.stringify(r)).sort();
    for (const t of ["analytics_page_views", "analytics_queries", "analytics_agent_views"]) {
      out[t] = db.prepare(`SELECT id, created_at FROM ${t} ORDER BY id`).all();
    }
    return out;
  }
  function newDb(rowsPerDay: number, withOdd: boolean): Database.Database {
    const db = new Database(":memory:");
    __initSchemaForTesting(db as any);
    seed(db, rowsPerDay, withOdd);
    return db;
  }
  function markerRows(db: Database.Database): number {
    return (db.prepare("SELECT COUNT(*) c FROM boot_job_state WHERE job LIKE 'retention-rolled-delete-pending:%'").get() as { c: number }).c;
  }
  function runNew(chunkSize: number | undefined): { pv: number; q: number; av: number } {
    const o = chunkSize ? { chunkSize } : {};
    return {
      pv: retention.rollupAndPrunePageViews(WINDOW, 7, false, o).rowsDeleted,
      q: retention.rollupAndPruneQueries(WINDOW, 7, false, o).rowsDeleted,
      av: retention.rollupAndPruneAgentViews(WINDOW, 7, false, o).rowsDeleted,
    };
  }
  function runLegacy(db: Database.Database): { pv: number; q: number; av: number } {
    return {
      pv: legacyPrune(db, "analytics_page_views", LEGACY_PV),
      q: legacyPrune(db, "analytics_queries", LEGACY_Q),
      av: legacyPrune(db, "analytics_agent_views", LEGACY_AV),
    };
  }

  try {
    // ── (1)+(2) equivalence with the legacy implementation ───────────────
    for (const [label, chunk] of [["default chunk (small days: atomic path)", undefined], ["chunk=3 (every day: marker path)", 3], ["chunk=1", 1]] as const) {
      const ref = newDb(23, true);
      const sut = newDb(23, true);
      const legacy = runLegacy(ref);
      __setDbForTesting(sut as any);
      const got = runNew(chunk);
      assertTrue(legacy.pv > 0 && legacy.q > 0 && legacy.av > 0, `[${label}] fixture actually prunes rows in all three tables`);
      assertEq(got, legacy, `[${label}] identical rowsDeleted per table`);
      assertEq(snapshot(sut), snapshot(ref), `[${label}] identical rollup tables and surviving raw rows (mixed formats, NULL/non-date rows)`);
      assertEq(markerRows(sut), 0, `[${label}] no delete-pending marker left behind`);
      // idempotent second run
      const again = runNew(chunk);
      assertEq(again, { pv: 0, q: 0, av: 0 }, `[${label}] second run deletes nothing`);
      assertEq(snapshot(sut), snapshot(ref), `[${label}] second run leaves rollups unchanged (no double count)`);
      sut.close(); ref.close();
    }

    // dryRun is unchanged: counts, writes nothing.
    {
      const ref = newDb(10, true);
      const sut = newDb(10, true);
      const before = snapshot(sut);
      __setDbForTesting(sut as any);
      const dry = retention.rollupAndPrunePageViews(WINDOW, 7, true, { chunkSize: 3 });
      const legacyDeleted = legacyPrune(ref, "analytics_page_views", LEGACY_PV);
      assertEq(dry.rowsDeleted, legacyDeleted, "dryRun: rowsDeleted equals what the legacy run really deletes");
      assertEq(snapshot(sut), before, "dryRun: nothing written or deleted");
      sut.close(); ref.close();
    }

    // ── (3) bounded transactions + event-loop yields (async variant) ─────
    {
      const sut = newDb(0, false);
      const day = dayStr(120);
      const ins = sut.prepare("INSERT INTO analytics_page_views (path, source, session_id, created_at, is_owner) VALUES (?, 'x', ?, ?, 0)");
      sut.transaction(() => { for (let i = 0; i < 9000; i++) ins.run(`/p${i % 10}`, `s${i % 300}`, `${day} 10:00:${String(i % 60).padStart(2, "0")}`); })();
      __setDbForTesting(sut as any);
      const stamps: number[] = [];
      let deleteTxns = 0;
      let ticks = 0;
      let running = true;
      const ticker = (async () => { while (running) { ticks++; await new Promise<void>((r) => setImmediate(r)); } })();
      let last = Date.now();
      const r = await retention.rollupAndPrunePageViewsAsync(WINDOW, 7, false, {
        afterChunk: (info) => {
          const now = Date.now();
          if (info.phase === "delete" && info.rows > 0) { deleteTxns++; stamps.push(now - last); }
          last = now;
        },
      });
      running = false;
      await ticker;
      assertEq(r.rowsDeleted, 9000, "async: all 9000 rows of the big day deleted");
      assertEq(deleteTxns, 5, "async: 9000 rows => 5 delete transactions of <=2000 rows (4x2000 + 1000)");
      assertTrue(Math.max(...stamps) < 500, `async: each 2000-row delete transaction is bounded (max ${Math.max(...stamps)} ms < 500)`);
      assertTrue(ticks >= deleteTxns, `async: event loop got to run between transactions (ticks=${ticks})`);
      const sd = sut.prepare("SELECT SUM(session_count) s FROM sessions_daily WHERE day = ?").get(day) as { s: number };
      assertEq(sd.s, 300, "async: sessions_daily holds the TRUE distinct count (300) — rollup was not split across chunks");
      assertEq((sut.prepare("SELECT SUM(view_count) v FROM page_view_daily").get() as { v: number }).v, 9000, "async: page_view_daily view_count sums to 9000");
      sut.close();
    }

    // ── (4) interruption + re-run => no double count ─────────────────────
    for (const crashAt of ["after rollup commit", "after 2nd delete chunk"] as const) {
      const ref = newDb(23, true);
      const sut = newDb(23, true);
      runLegacy(ref);
      __setDbForTesting(sut as any);
      let deleteCalls = 0;
      let threw = false;
      try {
        retention.rollupAndPrunePageViews(WINDOW, 7, false, {
          chunkSize: 4,
          afterChunk: (info) => {
            if (crashAt === "after rollup commit" && info.phase === "rollup") throw new Error("simulated crash");
            if (crashAt === "after 2nd delete chunk" && info.phase === "delete" && ++deleteCalls === 2) throw new Error("simulated crash");
          },
        });
      } catch (e: any) {
        threw = /simulated crash/.test(String(e?.message));
      }
      assertTrue(threw, `[${crashAt}] the job was interrupted`);
      assertEq(markerRows(sut), 1, `[${crashAt}] delete-pending marker persisted across the interruption`);
      const partialRows = (sut.prepare("SELECT COUNT(*) c FROM analytics_page_views").get() as { c: number }).c;
      assertTrue(partialRows > 0, `[${crashAt}] rows of the interrupted day still exist (rollup done, delete pending)`);
      // Re-run (plus the other two tables for the full comparison).
      const rr = runNew(4);
      assertEq(markerRows(sut), 0, `[${crashAt}] marker cleared after the re-run`);
      assertEq(snapshot(sut), snapshot(ref), `[${crashAt}] after re-run, rollups + raw rows equal the legacy result (no double count)`);
      assertTrue(rr.pv >= 0, `[${crashAt}] re-run completed`);
      sut.close(); ref.close();
    }

    // ── (5) degenerate '' oldest value: job is a no-op, exactly as before ─
    {
      const ref = newDb(5, false);
      const sut = newDb(5, false);
      for (const db of [ref, sut]) db.prepare("INSERT INTO analytics_page_views (path, session_id, created_at) VALUES ('/e', 'e', '')").run();
      const legacy = legacyPrune(ref, "analytics_page_views", LEGACY_PV);
      __setDbForTesting(sut as any);
      const got = retention.rollupAndPrunePageViews(WINDOW, 7, false);
      assertEq([legacy, got.rowsDeleted], [0, 0], "'' created_at as oldest: legacy and new both delete nothing");
      assertEq(snapshot(sut), snapshot(ref), "'' created_at as oldest: state identical");
      sut.close(); ref.close();
    }

    // ── (6) source guard: no substr()-wrapped range filter left ──────────
    {
      const src = fs.readFileSync(require.resolve("./retention-service").replace(/\.js$/, ".ts"), "utf8");
      assertTrue(!/substr\(created_at, 1, 10\)\s*(>=|<)\s*\?/.test(src), "retention-service: no `substr(created_at,1,10) >=/< ?` filters remain (index usable)");
      assertTrue(!/MIN\(substr\(created_at/.test(src), "retention-service: MIN(substr(created_at)) replaced by substr(MIN(created_at))");
    }
  } finally {
    try { if (prevDb) __setDbForTesting(prevDb as any); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRetentionChunkedPruneTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed ? 1 : 0);
  });
}
