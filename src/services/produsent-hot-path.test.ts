/**
 * produsent-hot-path.test.ts — dev-request 2026-09-26-rfb-produsentside-
 * synkron-slug-skann (P0, event-loop stalls under crawling), part 2 after
 * #947 (slug→id map).
 *
 * Measured on a prod-scale DB (1.29 M analytics_page_views rows), one
 * /produsent/:slug render (NB/EN, GET or HEAD — HEAD runs the GET handler)
 * spent ~90 % of its synchronous main-thread time in:
 *   (A) retention-service.ts getRollupBoundaryDate():
 *       SELECT MIN(substr(created_at, 1, 10)) — the substr() wrapper defeats
 *       SQLite's index min/max optimisation, so the whole created_at index
 *       was walked on every request (also on /api/agents/:id/stats).
 * and, for heavily viewed producers, in
 *   (D) profile-activity-service.ts getViews30(): four COUNT(*) passes over
 *       the same rows of the path, then one SUM(CASE …) pass, now (2026-10-13,
 *       statistikk-riktig-for-investorer S5) one grouped read classed by the
 *       shared classifier — still a single pass over the path's rows.
 * (A) keeps its result identical; this file proves that against the old SQL
 * as an oracle, and guards (A) against regressing to a full scan. (D) is
 * checked against a row-by-row oracle of the current definition.
 *
 * Fully synchronous between swapping the shared getDb() singleton in and
 * restoring it (tests/test.ts runs harness blocks concurrently).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/produsent-hot-path.test.ts
 *   2. Wired into the gate: tests/test.ts calls runProdusentHotPathTests().
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runProdusentHotPathTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log !== false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, msg: string) => {
    if (cond) { passed++; if (log) console.log(`  ✓ ${msg}`); }
    else { failed++; failures.push(msg); if (log) console.log(`  ✗ ${msg}`); }
  };

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const init = require("../database/init") as typeof import("../database/init");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getRollupBoundaryDate } = require("./retention-service") as typeof import("./retention-service");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getProfileActivity } = require("./profile-activity-service") as typeof import("./profile-activity-service");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { storedClientClass, aiVendorBucket, uaFromSessionId } = require("./traffic-classifier") as typeof import("./traffic-classifier");

  const prev = init.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");
  init.__setDbForTesting(db);
  try {
    init.__initSchemaForTesting(db);
    const sqlTs = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);
    const DAY = 86_400_000;

    // ── (A1) boundary: same day as the old MIN(substr(...)) on all three raw tables ──
    const oldBoundary = (t: string): string | null =>
      (db.prepare(`SELECT MIN(substr(created_at, 1, 10)) as d FROM ${t}`).get() as { d: string | null }).d;
    const tomorrow = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
    const TABLES = ["analytics_page_views", "analytics_queries", "analytics_agent_views"] as const;
    for (const t of TABLES) {
      check(getRollupBoundaryDate(t, db) === tomorrow && oldBoundary(t) === null, `hp-A1 ${t}: empty table → tomorrow (unchanged fallback)`);
    }
    // Mixed formats (sqlite "YYYY-MM-DD HH:MM:SS" and JS ISO "…T…Z"), out-of-order inserts, NULLs.
    const stamps = ["2026-08-03 00:00:00", "2026-08-01T23:59:59.000Z", null, "2026-08-02 10:00:00", "2026-08-01 00:00:01", "2026-09-30T12:00:00.000Z"];
    const insPv = db.prepare(`INSERT INTO analytics_page_views (path, session_id, created_at) VALUES ('/produsent/x', 's', ?)`);
    const insQ = db.prepare(`INSERT INTO analytics_queries (protocol, query, created_at) VALUES ('mcp', 'egg', ?)`);
    const insAv = db.prepare(`INSERT INTO analytics_agent_views (agent_id, agent_name, created_at) VALUES ('a', 'A', ?)`);
    for (const s of stamps) { insPv.run(s); insQ.run(s); insAv.run(s); }
    for (const t of TABLES) {
      const got = getRollupBoundaryDate(t, db);
      check(got === oldBoundary(t) && got === "2026-08-01", `hp-A1 ${t}: boundary ${got} equals the old MIN(substr()) result (2026-08-01)`);
    }
    // ISO-only earliest day: the "T" form must not sort differently from the space form.
    db.prepare(`DELETE FROM analytics_queries`).run();
    for (const s of ["2026-07-15T08:00:00.000Z", "2026-07-15 07:00:00", "2026-07-16 00:00:00"]) insQ.run(s);
    check(getRollupBoundaryDate("analytics_queries", db) === oldBoundary("analytics_queries") && oldBoundary("analytics_queries") === "2026-07-15",
      "hp-A1 analytics_queries: 'T' and space forms on the same earliest day → 2026-07-15, same as before");
    db.prepare(`DELETE FROM analytics_page_views WHERE created_at IS NOT NULL`).run();
    check(getRollupBoundaryDate("analytics_page_views", db) === tomorrow && oldBoundary("analytics_page_views") === null,
      "hp-A1 analytics_page_views: only-NULL created_at → tomorrow, exactly like before");

    // ── (A2) boundary stays an index lookup: it must not scale with the table ──
    // Ratio, not an absolute threshold, so a slow CI box cannot flip it: the
    // old full-index walk vs the new min/max-optimised lookup on 200 000 rows.
    db.prepare(`DELETE FROM analytics_page_views`).run();
    const base = Date.UTC(2026, 7, 2);
    db.transaction(() => {
      for (let i = 0; i < 200_000; i++) insPv.run(new Date(base + i * 25_000).toISOString().replace("T", " ").slice(0, 19));
    })();
    const median = (fn: () => unknown) => {
      const xs: number[] = [];
      for (let i = 0; i < 5; i++) { const t0 = process.hrtime.bigint(); fn(); xs.push(Number(process.hrtime.bigint() - t0)); }
      return xs.sort((a, b) => a - b)[2];
    };
    const tOld = median(() => oldBoundary("analytics_page_views"));
    const tNew = median(() => getRollupBoundaryDate("analytics_page_views", db));
    check(getRollupBoundaryDate("analytics_page_views", db) === "2026-08-02", "hp-A2 boundary on 200k rows = earliest day");
    check(tNew * 20 < tOld, `hp-A2 boundary lookup is O(log n): new ${(tNew / 1e6).toFixed(3)} ms vs full-index walk ${(tOld / 1e6).toFixed(3)} ms (needs ≥20× faster)`);

    // ── (D) getViews30 one grouped read == a row-by-row oracle ──
    // Page views only (2xx/304, legacy rows without a status count), owner
    // rows out, each row classed by its stored class (else its session_id):
    // people are 'human', AI-agent lookups are AI search only.
    db.prepare(`DELETE FROM analytics_page_views`).run();
    const oracle = (p: string) => {
      const rows = db.prepare(`
        SELECT session_id, client_class FROM analytics_page_views
        WHERE path = ? AND (is_owner IS NULL OR is_owner = 0) AND created_at >= ?
          AND (status_code IS NULL OR (status_code >= 200 AND status_code < 300) OR status_code = 304)
      `).all(p, sqlTs(30 * DAY)) as Array<{ session_id: string | null; client_class: string | null }>;
      let human = 0;
      const aiBreakdown = { chatgpt: 0, claude: 0, other: 0 };
      for (const r of rows) {
        if (r.session_id === null) continue;
        const cls = storedClientClass(r.session_id, r.client_class);
        if (cls === "human") human++;
        else if (cls === "ai_search") aiBreakdown[aiVendorBucket(uaFromSessionId(r.session_id))]++;
      }
      return { human, ai: aiBreakdown.chatgpt + aiBreakdown.claude + aiBreakdown.other, aiBreakdown, days: 30 };
    };
    const ins = db.prepare(`INSERT INTO analytics_page_views (path, session_id, is_owner, status_code, client_class, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
    const P1 = "/produsent/hot-gard", P2 = "/produsent/annen-gard";
    const sessions: Array<[string | null, number | null, number | null, string | null]> = [
      ["ab12:desktop:0123456789abcdef", 0, 200, "human"],                       // human (hashed)
      ["ab12:desktop:0123456789abcdef", null, null, null],                      // same person, legacy row (NULL owner/status/class)
      ["cd34:Mozilla/5.0 (compatible; GPTBot/1.2)", 0, 200, "ai_crawler"],     // AI crawler: not counted
      ["cd35:Mozilla/5.0 AppleWebKit; ChatGPT-User/1.0", 0, 200, "ai_search"], // chatgpt
      ["ef56:Mozilla/5.0 (compatible; Claude-User/1.0; Claude-User@anthropic.com)", 0, 304, "ai_search"], // claude, 304 counts
      ["gh78:Mozilla/5.0 (compatible; Googlebot/2.1)", 0, 200, "search_engine"], // neither
      ["gh80:Mozilla/5.0 (compatible; Perplexity-User/1.0)", 0, 200, null],     // other AI search, legacy row
      ["ij90:curl/8.0", 0, 200, "dev"],                                          // script: neither
      ["op56:desktop:1111111111111111", 0, 200, "scanner"],                      // browser-looking scanner: neither
      ["qr78:desktop:2222222222222222", 0, 404, "human"],                        // a 404 is not a page view
      [null, 0, 200, null],                                                      // NULL session_id: counted nowhere
      ["kl12:Mozilla/5.0 (compatible; ChatGPT-User/1.0)", 1, 200, "ai_search"],  // owner: excluded
      ["mn34:desktop:fedcba9876543210", 1, 200, "human"],                        // owner human: excluded
    ];
    let n = 0;
    for (const [sid, owner, status, cls] of sessions) for (const ageDays of [1, 12, 29.9, 31, 59]) {
      ins.run(P1, sid, owner, status, cls, sqlTs(ageDays * DAY));
      if (n++ % 3 === 0) ins.run(P2, sid, owner, status, cls, sqlTs(ageDays * DAY));
    }
    for (const p of [P1, P2, "/produsent/ingen-visninger"]) {
      const got = getProfileActivity(db, "agent-x", p).views30;
      const want = oracle(p);
      check(JSON.stringify(got) === JSON.stringify(want), `hp-D ${p}: views30 ${JSON.stringify(got)} equals the row-by-row result`);
    }
    const p1 = getProfileActivity(db, "agent-x", P1).views30;
    check(p1.human === 6 && JSON.stringify(p1.aiBreakdown) === JSON.stringify({ chatgpt: 3, claude: 3, other: 3 }),
      `hp-D ${P1}: 6 human views, AI search only (3 per assistant over the 3 in-window ages): ${JSON.stringify(p1)}`);
    // No page_view_daily top-up: it counted crawlers. Raw rows now start 20
    // days back, so the old code would have added the rollup days 24-25 on top.
    db.prepare(`DELETE FROM analytics_page_views WHERE created_at < ?`).run(sqlTs(20 * DAY));
    const dayAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    const insDaily = db.prepare(`INSERT INTO page_view_daily (day, path, source, bot_type, vertical_id, view_count, session_count) VALUES (?, ?, 'direct', ?, 'rfb', ?, 1)`);
    insDaily.run(dayAgo(25), P1, "chatgpt", 7);
    insDaily.run(dayAgo(24), P1, "claude", 3);
    const after = getProfileActivity(db, "agent-x", P1).views30;
    check(JSON.stringify(after) === JSON.stringify(oracle(P1)) && after.aiBreakdown.chatgpt < 7,
      `hp-D page_view_daily rows are not added on top of the raw rows: ${JSON.stringify(after)}`);
  } catch (err: any) {
    failed++;
    failures.push(`hp: unexpected error: ${String(err?.stack || err)}`);
  } finally {
    init.__setDbForTesting(prev as any);
    try { db.close(); } catch { /* already closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  const s = runProdusentHotPathTests({ log: true });
  console.log(`\nprodusent-hot-path: ${s.passed} passed, ${s.failed} failed`);
  process.exit(s.failed ? 1 : 0);
}
