/**
 * profile-activity-service.test.ts — tests for the aggregated "Aktivitet"
 * panel data (dev-request 2026-07-03-agent-profile-conversations-stats,
 * slice 2, work item 4).
 *
 * Uses its own throwaway in-memory better-sqlite3 database created directly
 * in this file (NOT the shared getDb() singleton — getProfileActivity()
 * takes a `db` handle as an explicit parameter and never calls getDb()
 * itself), so this suite needs no __setDbForTesting swap and cannot race
 * any other block in tests/test.ts that does touch the global singleton.
 *
 * Covers:
 *   (a) views30: human vs AI-agent split (chatgpt/claude/other), owner rows
 *       excluded, rows older than 30 days excluded, a different agent's
 *       path never bleeds into these counts.
 *   (b) topQueryTerms: grouped by exact query_text, ordered by frequency,
 *       capped at 3, single-char/empty/null query_text excluded, another
 *       agent's conversations never counted.
 *   (c) platforms: "web"/"a2a"/"mcp" from conversations.source (all-time),
 *       "api" source never produces a badge, "chatgpt"/"claude" badges come
 *       from the page-view split (not from conversations.source), a
 *       conversation-only agent with zero page views still gets its
 *       web/a2a/mcp badges.
 *   (d) getProfileActivity(): the combined entry point returns all three
 *       pieces together; a totally unseeded agent gets all-zero/empty
 *       results (never throws, never fabricates a non-zero number).
 *
 * Standalone: npx tsx src/services/profile-activity-service.test.ts
 */

import Database from "better-sqlite3";
import { getProfileActivity } from "./profile-activity-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function buildSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE analytics_page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      session_id TEXT,
      is_owner INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      seller_agent_id TEXT,
      source TEXT DEFAULT 'api',
      query_text TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function runProfileActivityServiceTests(opts: { log?: boolean } = {}): TestSummary {
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

  const db = new Database(":memory:");
  try {
    buildSchema(db);

    const AGENT_ID = "agent-activity-1";
    const PATH = "/produsent/aktivitet-gard";
    const OTHER_PATH = "/produsent/annen-gard";
    const OTHER_AGENT = "agent-activity-2";

    // ── Fixtures: page views ──────────────────────────────────────────
    const insertPv = db.prepare(
      `INSERT INTO analytics_page_views (path, session_id, is_owner, created_at)
       VALUES (?, ?, ?, datetime('now', ?))`,
    );
    // 4 human views inside the 30d window
    for (let i = 0; i < 4; i++) {
      insertPv.run(PATH, `iphash${i}:Mozilla/5.0 (Macintosh) Chrome/120`, 0, "-5 days");
    }
    // 3 ChatGPT + 2 Claude + 1 other-AI (Googlebot) inside the window
    for (let i = 0; i < 3; i++) insertPv.run(PATH, `iphash-gpt-${i}:Mozilla/5.0 (compatible; GPTBot/1.0)`, 0, "-2 days");
    for (let i = 0; i < 2; i++) insertPv.run(PATH, `iphash-claude-${i}:Mozilla/5.0 (compatible; ClaudeBot/1.0)`, 0, "-1 days");
    insertPv.run(PATH, "iphash-google:Mozilla/5.0 (compatible; Googlebot/2.1)", 0, "-3 days");
    // 1 owner view — must be excluded entirely, even though it's a normal browser UA
    insertPv.run(PATH, "iphash-owner:Mozilla/5.0 (Macintosh) Chrome/120", 1, "-1 days");
    // 1 human view OUTSIDE the 30-day window — must be excluded from views30
    insertPv.run(PATH, "iphash-old:Mozilla/5.0 (Macintosh) Chrome/120", 0, "-45 days");
    // Noise on a different agent's path — must never bleed into these counts
    insertPv.run(OTHER_PATH, "iphash-other:Mozilla/5.0 (Macintosh) Chrome/120", 0, "-1 days");

    // ── Fixtures: conversations (query terms + platform sources) ──────
    const insertConv = db.prepare(
      `INSERT INTO conversations (id, seller_agent_id, source, query_text, created_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`,
    );
    // "Har du økologiske egg?" x3, "Åpningstider?" x2, "Leverer dere til Oslo?" x1
    // — after the length>=2 filter below drops "a"/blank/null, these are the
    // ONLY 3 distinct terms left, so the top-3 result is fully deterministic
    // (no tie-break needed): egg(3), åpningstider(2), leverer(1).
    insertConv.run("c1", AGENT_ID, "web", "Har du økologiske egg?", "-1 days");
    insertConv.run("c2", AGENT_ID, "mcp", "Har du økologiske egg?", "-2 days");
    insertConv.run("c3", AGENT_ID, "a2a", "Har du økologiske egg?", "-3 days");
    insertConv.run("c4", AGENT_ID, "web", "Åpningstider?", "-4 days");
    insertConv.run("c5", AGENT_ID, "mcp", "Åpningstider?", "-5 days");
    insertConv.run("c6", AGENT_ID, "api", "Leverer dere til Oslo?", "-6 days");
    // Single-char / blank / null query_text — must never surface as a "term"
    insertConv.run("c7", AGENT_ID, "web", "a", "-7 days");
    insertConv.run("c8", AGENT_ID, "web", "   ", "-8 days");
    insertConv.run("c9", AGENT_ID, "web", null, "-9 days");
    // Noise on a different seller — must never count toward AGENT_ID's terms/badges
    insertConv.run("c10", OTHER_AGENT, "web", "Har du økologiske egg?", "-1 days");
    insertConv.run("c11", OTHER_AGENT, "web", "Har du økologiske egg?", "-1 days");
    insertConv.run("c12", OTHER_AGENT, "web", "Har du økologiske egg?", "-1 days");
    insertConv.run("c13", OTHER_AGENT, "web", "Har du økologiske egg?", "-1 days");

    const activity = getProfileActivity(db, AGENT_ID, PATH);

    // ── (a) views30 ─────────────────────────────────────────────────
    assertEq(activity.views30.human, 4, "views30: 4 human views (owner + >30d-old excluded)");
    assertEq(activity.views30.aiBreakdown.chatgpt, 3, "views30: 3 ChatGPT views");
    assertEq(activity.views30.aiBreakdown.claude, 2, "views30: 2 Claude views");
    assertEq(activity.views30.aiBreakdown.other, 1, "views30: 1 other-AI (Googlebot) view");
    assertEq(activity.views30.ai, 6, "views30: ai = chatgpt+claude+other = 6");

    // ── (b) topQueryTerms ───────────────────────────────────────────
    assertEq(activity.topQueryTerms.length, 3, "topQueryTerms: capped at 3");
    assertEq(activity.topQueryTerms[0], { term: "Har du økologiske egg?", count: 3 }, "topQueryTerms: #1 is the 3x term");
    assertEq(activity.topQueryTerms[1], { term: "Åpningstider?", count: 2 }, "topQueryTerms: #2 is the 2x term");
    assertEq(activity.topQueryTerms[2], { term: "Leverer dere til Oslo?", count: 1 }, "topQueryTerms: #3 is the 1x term");
    assertTrue(
      !activity.topQueryTerms.some(q => q.term === "a" || q.term.trim() === ""),
      "topQueryTerms: single-char/blank query_text never surfaces as a term",
    );

    // ── (c) platforms ────────────────────────────────────────────────
    assertTrue(activity.platforms.includes("web"), "platforms: 'web' badge present (conversations.source='web' exists)");
    assertTrue(activity.platforms.includes("a2a"), "platforms: 'a2a' badge present");
    assertTrue(activity.platforms.includes("mcp"), "platforms: 'mcp' badge present");
    assertTrue(activity.platforms.includes("chatgpt"), "platforms: 'chatgpt' badge present (from page-view UA split)");
    assertTrue(activity.platforms.includes("claude"), "platforms: 'claude' badge present (from page-view UA split)");
    assertTrue(
      !(activity.platforms as string[]).includes("api"),
      "platforms: generic conversations.source='api' never produces its own badge",
    );
    assertEq(activity.platforms.length, 5, "platforms: exactly the 5 expected badges, nothing extra");

    // ── (d) isolation from noise + empty-agent behaviour ─────────────
    const otherActivity = getProfileActivity(db, OTHER_AGENT, OTHER_PATH);
    assertEq(otherActivity.topQueryTerms.length, 1, "isolation: OTHER_AGENT sees only its own 4x term, not AGENT_ID's");
    assertEq(otherActivity.topQueryTerms[0].count, 4, "isolation: OTHER_AGENT's term count is 4, unaffected by AGENT_ID's rows");
    assertTrue(!otherActivity.platforms.includes("chatgpt"), "isolation: OTHER_AGENT gets no chatgpt badge (no matching page views on its path)");

    const emptyActivity = getProfileActivity(db, "agent-nothing-seeded", "/produsent/does-not-exist");
    assertEq(emptyActivity.views30.human, 0, "empty-agent: 0 human views");
    assertEq(emptyActivity.views30.ai, 0, "empty-agent: 0 AI views");
    assertEq(emptyActivity.topQueryTerms, [], "empty-agent: no query terms");
    assertEq(emptyActivity.platforms, [], "empty-agent: no platform badges");
  } finally {
    db.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/profile-activity-service.test.ts`
if (require.main === module) {
  const summary = runProfileActivityServiceTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
