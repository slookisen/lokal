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
 *       the same rows of the path, now one SUM(CASE …) pass.
 * Both keep their RESULTS identical; this file proves that against the old
 * SQL as an oracle, and guards (A) against regressing to a full scan.
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
  const { getPrunedChatgptClaudeCounts } = require("./analytics-rollup-reads") as typeof import("./analytics-rollup-reads");

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

    // ── (D) getViews30 single pass == the former four COUNT(*) queries ──
    db.prepare(`DELETE FROM analytics_page_views`).run();
    const M = {
      chatgpt: ["GPTBot", "ChatGPT", "OAI-SearchBot"],
      claude: ["ClaudeBot", "Claude-User", "Anthropic"],
      other: ["Gemini", "Google-Extended", "PerplexityBot", "Perplexity-User", "CCBot", "Bytespider", "Applebot-Extended",
        "YandexAdditional", "NotHumanSearch", "DuckDuckBot", "Googlebot"],
    };
    const ALL = [...M.chatgpt, ...M.claude, ...M.other];
    const W = "path = ? AND (is_owner IS NULL OR is_owner = 0) AND created_at >= datetime('now', '-30 days')";
    const oldViews30 = (p: string) => {
      const human = (db.prepare(`SELECT COUNT(*) as c FROM analytics_page_views WHERE ${W} AND ${ALL.map(() => "session_id NOT LIKE ?").join(" AND ")}`)
        .get(p, ...ALL.map(m => `%${m}%`)) as { c: number }).c;
      const bucket = (ms: string[]) => (db.prepare(`SELECT COUNT(*) as c FROM analytics_page_views WHERE ${W} AND (${ms.map(() => "session_id LIKE ?").join(" OR ")})`)
        .get(p, ...ms.map(m => `%${m}%`)) as { c: number }).c;
      const cutoffIso = new Date(Date.now() - 30 * DAY).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
      const pr = getPrunedChatgptClaudeCounts(cutoffIso, { path: p, db });
      const chatgpt = bucket(M.chatgpt) + pr.chatgpt, claude = bucket(M.claude) + pr.claude, other = bucket(M.other);
      return { human, ai: chatgpt + claude + other, aiBreakdown: { chatgpt, claude, other } };
    };
    const ins = db.prepare(`INSERT INTO analytics_page_views (path, session_id, is_owner, created_at) VALUES (?, ?, ?, ?)`);
    const P1 = "/produsent/hot-gard", P2 = "/produsent/annen-gard";
    const sessions: Array<[string | null, number | null]> = [
      ["ab12:desktop:0123456789abcdef", 0],                                     // human (hashed)
      ["ab12:desktop:0123456789abcdef", null],                                  // human, legacy NULL is_owner
      ["cd34:Mozilla/5.0 (compatible; GPTBot/1.2)", 0],                         // chatgpt
      ["cd35:Mozilla/5.0 AppleWebKit; ChatGPT-User/1.0", 0],                     // chatgpt
      ["ef56:Mozilla/5.0 (compatible; ClaudeBot/1.0; claudebot@anthropic.com)", 0], // claude (2 markers, counted once)
      ["gh78:Mozilla/5.0 (compatible; Googlebot/2.1)", 0],                       // other
      ["gh79:ChatGPT relay via Googlebot", 0],                                   // chatgpt AND other (buckets overlap, as before)
      ["ij90:curl/8.0", 0],                                                      // human bucket (not an AI marker)
      [null, 0],                                                                 // NULL session_id: counted nowhere
      ["kl12:Mozilla/5.0 (compatible; GPTBot/1.2)", 1],                          // owner: excluded
      ["mn34:desktop:fedcba9876543210", 1],                                      // owner human: excluded
    ];
    let n = 0;
    for (const [sid, owner] of sessions) for (const ageDays of [1, 12, 29.9, 31, 59]) {
      ins.run(P1, sid, owner, sqlTs(ageDays * DAY));
      if (n++ % 3 === 0) ins.run(P2, sid, owner, sqlTs(ageDays * DAY));
    }
    for (const p of [P1, P2, "/produsent/ingen-visninger"]) {
      const got = getProfileActivity(db, "agent-x", p).views30;
      const want = oldViews30(p);
      check(JSON.stringify(got) === JSON.stringify(want), `hp-D ${p}: views30 ${JSON.stringify(got)} equals the four-query result`);
    }
    // Rollup blend still added on top (raw floor inside the 30-day window).
    db.prepare(`DELETE FROM analytics_page_views WHERE created_at < datetime('now', '-20 days')`).run();
    const dayAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    const insDaily = db.prepare(`INSERT INTO page_view_daily (day, path, source, bot_type, vertical_id, view_count, session_count) VALUES (?, ?, 'direct', ?, 'rfb', ?, 1)`);
    insDaily.run(dayAgo(25), P1, "chatgpt", 7);
    insDaily.run(dayAgo(24), P1, "claude", 3);
    insDaily.run(dayAgo(24), P1, "other_bot", 50);
    const blended = getProfileActivity(db, "agent-x", P1).views30;
    check(JSON.stringify(blended) === JSON.stringify(oldViews30(P1)) && blended.aiBreakdown.chatgpt >= 7 && blended.aiBreakdown.claude >= 3,
      `hp-D rollup blend unchanged: ${JSON.stringify(blended)}`);
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
