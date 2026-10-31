/**
 * ai-agent-rollup.test.ts — slice B5 of dev-request 2026-09-24-ai-sok-bli-svaret-rfb.
 * Covers: the SQL token CASE agrees with aiAgentEntryOf (first registry token,
 * case-sensitive), the nightly rollup keeps OAI-SearchBot / GPTBot /
 * ChatGPT-User (and the Claude trio) as separate rows in
 * page_view_ai_agent_daily while page_view_daily is unchanged, owner rows are
 * excluded, re-runs do not double-count, and computeAiAgentBreakdown reports
 * raw and rolled-up numbers separately with caps and vertical filtering.
 * Standalone: npx tsx src/services/ai-agent-rollup.test.ts
 */
import Database from "better-sqlite3";

export interface TestSummary { passed: number; failed: number; failures: string[] }

export async function runAiAgentRollupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }

  const { AI_AGENT_REGISTRY, aiAgentEntryOf, aiAgentTokenCaseSql, aiAgentEntryByToken } =
    require("./traffic-classifier") as typeof import("./traffic-classifier");

  // ── SQL CASE == aiAgentEntryOf (pure, in-memory) ──
  const mem = new Database(":memory:");
  const sqlToken = (s: string) =>
    (mem.prepare(`WITH s(v) AS (SELECT ?) SELECT ${aiAgentTokenCaseSql("v")} AS t FROM s`).get(s) as { t: string | null }).t;
  const uas = [
    ...AI_AGENT_REGISTRY.map((e) => `Mozilla/5.0 (compatible; ${e.token}/1.0; +https://example.com/bot)`),
    "Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
    "Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +Claude-User)", // two tokens: registry order decides
    "Mozilla/5.0 (Macintosh) Safari/605.1.15",
    "gptbot lowercase is not GPTBot",
    "",
  ];
  for (const ua of uas) {
    const sid = "ab12cd:" + ua;
    assertEq(sqlToken(sid), aiAgentEntryOf(ua)?.token ?? null, `case == aiAgentEntryOf for ${JSON.stringify(ua.slice(0, 60))}`);
  }
  assertEq(sqlToken("x:ChatGPT-User/1.0"), "ChatGPT-User", "case: ChatGPT-User");
  assertEq(sqlToken("x:OAI-SearchBot/1.0"), "OAI-SearchBot", "case: OAI-SearchBot separate from ChatGPT-User");
  assertEq(sqlToken("x:Mozilla GPTBot/1.2"), "GPTBot", "case: GPTBot");
  assertEq(sqlToken("x:gptbot/1.0 chatgpt-user"), null, "case: matching is case-sensitive like String.includes");
  assertEq(sqlToken("x:meta-externalagent/1.1"), "meta-externalagent", "case: longer token listed first wins");
  assertEq(aiAgentEntryByToken("OAI-SearchBot")?.purpose, "search_index", "entryByToken: purpose");
  assertEq(aiAgentEntryByToken("nope"), null, "entryByToken: unknown -> null");
  mem.close();

  // ── DB-backed rollup ──
  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const prevDb = (() => { try { return getDb(); } catch { return undefined; } })();
  const testDb = new Database(":memory:");
  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    __initSchemaForTesting(testDb as any); // idempotent
    const hasTable = !!testDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='page_view_ai_agent_daily'").get();
    assertEq(hasTable, true, "schema: page_view_ai_agent_daily exists");

    const ago = (d: number) => { const t = new Date(); t.setDate(t.getDate() - d); return t.toISOString().replace("T", " ").slice(0, 19); };
    const ins = testDb.prepare(
      `INSERT INTO analytics_page_views (path, source, session_id, created_at, is_owner, vertical_id)
       VALUES (?, 'direct', ?, ?, ?, ?)`);
    const oldTs = ago(200);
    ins.run("/a", "h1:Mozilla/5.0 (compatible; OAI-SearchBot/1.0)", oldTs, 0, "rfb");
    ins.run("/b", "h1:Mozilla/5.0 (compatible; OAI-SearchBot/1.0)", oldTs, 0, "rfb");
    ins.run("/a", "h2:Mozilla/5.0 compatible; ChatGPT-User/1.0", oldTs, 0, "rfb");
    ins.run("/a", "h3:Mozilla/5.0 compatible; ChatGPT-User/1.0", oldTs, null, "rfb");
    ins.run("/a", "h4:Mozilla/5.0 (compatible; GPTBot/1.2)", oldTs, 0, "rfb");
    ins.run("/a", "h5:Mozilla/5.0 Claude-User/1.0", oldTs, 0, "dental");
    ins.run("/a", "h6:Mozilla/5.0 ClaudeBot/1.0", oldTs, 0, "rfb");
    ins.run("/a", "h7:Mozilla/5.0 ChatGPT-User/1.0", oldTs, 1, "rfb"); // owner: excluded
    ins.run("/a", "h8:Mozilla/5.0 (Macintosh) Safari", oldTs, 0, "rfb"); // human: not an AI row
    ins.run("/new", "h9:Mozilla/5.0 ChatGPT-User/1.0", ago(1), 0, "rfb");
    ins.run("/new", "h10:Mozilla/5.0 OAI-SearchBot/1.0", ago(1), 0, "rfb");

    const { rollupAndPrunePageViews } = require("./retention-service") as typeof import("./retention-service");
    const r = rollupAndPrunePageViews(90, 7, false);
    assertEq(r.rowsDeleted, 9, "rollup: old rows deleted");
    assertEq((testDb.prepare("SELECT SUM(view_count) AS v FROM page_view_daily").get() as any).v, 8,
      "rollup: page_view_daily unchanged (8 non-owner rows)");
    const chatgptBucket = (testDb.prepare("SELECT SUM(view_count) AS v FROM page_view_daily WHERE bot_type='chatgpt'").get() as any).v;
    assertEq(chatgptBucket, 5, "rollup: coarse bot_type='chatgpt' bucket still holds all three OpenAI agents");
    const rows = testDb.prepare(
      "SELECT agent, vertical_id, view_count, session_count FROM page_view_ai_agent_daily ORDER BY agent, vertical_id").all();
    assertEq(rows, [
      { agent: "ChatGPT-User", vertical_id: "rfb", view_count: 2, session_count: 2 },
      { agent: "Claude-User", vertical_id: "dental", view_count: 1, session_count: 1 },
      { agent: "ClaudeBot", vertical_id: "rfb", view_count: 1, session_count: 1 },
      { agent: "GPTBot", vertical_id: "rfb", view_count: 1, session_count: 1 },
      { agent: "OAI-SearchBot", vertical_id: "rfb", view_count: 2, session_count: 1 },
    ], "rollup: one row per agent token, owner and human rows excluded");
    rollupAndPrunePageViews(90, 7, false);
    assertEq((testDb.prepare("SELECT SUM(view_count) AS v FROM page_view_ai_agent_daily").get() as any).v, 7,
      "rollup: second run does not double-count");

    // ── breakdown: raw vs rollup, separately ──
    const { computeAiAgentBreakdown, AI_AGENT_RAW_MAX_HOURS } =
      require("./admin-stats-compute") as typeof import("./admin-stats-compute");
    const now = Date.now();
    const b = computeAiAgentBreakdown(testDb as any, 72, 400, undefined, now);
    assertEq(b.raw.map((x) => `${x.agent}:${x.purpose}:${x.views}`),
      ["ChatGPT-User:user_fetch:1", "OAI-SearchBot:search_index:1"], "breakdown raw: OAI-SearchBot and ChatGPT-User separate");
    assertEq(b.rollup.map((x) => `${x.agent}:${x.vendor}:${x.views}`),
      ["ChatGPT-User:chatgpt:2", "OAI-SearchBot:chatgpt:2", "Claude-User:claude:1", "ClaudeBot:claude:1", "GPTBot:chatgpt:1"],
      "breakdown rollup: per agent from rolled-up days");
    const rfb = computeAiAgentBreakdown(testDb as any, 72, 400, "rfb", now);
    assertEq(rfb.rollup.some((x) => x.agent === "Claude-User"), false, "breakdown: vertical filter on rollup");
    const short = computeAiAgentBreakdown(testDb as any, 72, 30, undefined, now);
    assertEq(short.rollup.length, 0, "breakdown: rollup window in days (200-day-old rows outside 30 days)");
    const narrow = computeAiAgentBreakdown(testDb as any, 1, 400, undefined, now);
    assertEq(narrow.raw.length, 0, "breakdown: raw window in hours (1-day-old rows outside 1 h)");
    assertEq(AI_AGENT_RAW_MAX_HOURS, 168, "breakdown: raw cap 168 h");
    // raw side: owner rows and other verticals excluded
    ins.run("/new", "h11:Mozilla/5.0 GPTBot/1.2", ago(1), 1, "rfb");
    ins.run("/new", "h12:Mozilla/5.0 GPTBot/1.2", ago(1), 0, "dental");
    const rawRfb = computeAiAgentBreakdown(testDb as any, 72, 400, "rfb", now).raw.map((x) => x.agent);
    assertEq(rawRfb, ["ChatGPT-User", "OAI-SearchBot"], "breakdown raw: owner row and other vertical excluded");
    // rollup side only counts days strictly before the oldest raw day
    testDb.prepare("INSERT INTO page_view_ai_agent_daily (day, agent, vertical_id, view_count, session_count) VALUES (?, 'GPTBot', 'rfb', 9, 9)")
      .run(ago(1).slice(0, 10));
    const g = computeAiAgentBreakdown(testDb as any, 72, 400, undefined, now).rollup.find((x) => x.agent === "GPTBot");
    assertEq(g?.views, 1, "breakdown rollup: days not yet pruned (>= oldest raw day) are not counted");
    // upsert adds, never replaces: a second rollup of the same day adds to the row
    const oldDay = ago(200);
    ins.run("/c", "h13:Mozilla/5.0 (compatible; GPTBot/1.2)", oldDay, 0, "rfb");
    rollupAndPrunePageViews(90, 7, false);
    const gp = testDb.prepare("SELECT view_count FROM page_view_ai_agent_daily WHERE agent='GPTBot' AND day=?").get(oldDay.slice(0, 10)) as any;
    assertEq(gp?.view_count, 2, "rollup: a late row for an already rolled-up day is added, not replaced");
    testDb.prepare("INSERT INTO page_view_ai_agent_daily (day, agent, vertical_id, view_count, session_count) VALUES (?, 'RetiredBot', 'rfb', 3, 1)")
      .run(ago(100).slice(0, 10));
    const unk = computeAiAgentBreakdown(testDb as any, 24, 400, undefined, now).rollup.find((x) => x.agent === "RetiredBot");
    assertEq(unk ? `${unk.vendor}/${unk.purpose}/${unk.views}` : null, "unknown/unknown/3", "breakdown: token no longer in registry kept as unknown");
  } finally {
    if (prevDb) __setDbForTesting(prevDb as any);
    testDb.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAiAgentRollupTests({ log: true }).then((s) => {
    console.log(`ai-agent-rollup: ${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
