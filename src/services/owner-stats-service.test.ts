/**
 * owner-stats-service.test.ts — tests for the owner dashboard "Statistikk"
 * aggregation (dev-request 2026-07-03-agent-profile-conversations-stats,
 * slice 3, work items 5+6).
 *
 * Uses its own throwaway in-memory better-sqlite3 database created directly
 * in this file (NOT the shared getDb() singleton — getOwnerStats() takes a
 * `db` handle as an explicit parameter and never calls getDb() itself), so
 * this suite needs no __setDbForTesting swap and cannot race any other
 * block in tests/test.ts that does touch the global singleton. Same
 * pattern as profile-activity-service.test.ts.
 *
 * Covers:
 *   (a) viewsBySource: totals per analytics_page_views.source, AI-bot rows
 *       excluded from totals (they're counted separately in aiPlatforms),
 *       owner rows excluded, rows older than the 90-day window excluded,
 *       a different agent's path never bleeds in, daily bucket counts sum
 *       back to the same totals.
 *   (b) aiPlatforms: chatgpt/claude/other split, owner rows excluded.
 *   (c) matchingSearchQueries: grouped by exact query_text, ordered by
 *       frequency, single-char query_text excluded, another seller's
 *       conversations never counted.
 *   (d) conversationsByChannel: grouped by conversations.source, NULL
 *       source coalesced to 'api', another seller's rows never counted.
 *   (e) contactClicksByKind: is_bot=1 rows excluded, rows outside the
 *       90-day window excluded, another agent's clicks never counted.
 *   (f) funnel: discovered from agent_metrics.times_discovered (0 when no
 *       row), viewed = the same bot/owner-excluded human view count as
 *       group (a), contactClicked = sum of group (e).
 *   (g) getOwnerStats(): the combined entry point returns all six groups
 *       together; a totally unseeded agent gets all-zero/empty results.
 *
 * Standalone: npx tsx src/services/owner-stats-service.test.ts
 */

import Database from "better-sqlite3";
import { getOwnerStats } from "./owner-stats-service";

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
      source TEXT DEFAULT 'unknown',
      session_id TEXT,
      is_owner INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      seller_agent_id TEXT,
      source TEXT,
      query_text TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE contact_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      is_bot INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_metrics (
      agent_id TEXT PRIMARY KEY,
      times_discovered INTEGER DEFAULT 0
    );
  `);
}

export function runOwnerStatsServiceTests(opts: { log?: boolean } = {}): TestSummary {
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

    const AGENT_ID = "agent-owner-stats-1";
    const PATH = "/produsent/owner-stats-gard";
    const OTHER_AGENT = "agent-owner-stats-2";
    const OTHER_PATH = "/produsent/annen-gard";

    // ── Fixtures: page views ──────────────────────────────────────────
    const insertPv = db.prepare(
      `INSERT INTO analytics_page_views (path, source, session_id, is_owner, created_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`,
    );

    // Human views inside the 90d window, by source: direct x3, search x2, organic x1
    for (let i = 0; i < 3; i++) insertPv.run(PATH, "direct", `iphash-d${i}:Mozilla/5.0 (Macintosh) Chrome/120`, 0, `-${i + 1} days`);
    for (let i = 0; i < 2; i++) insertPv.run(PATH, "search", `iphash-s${i}:Mozilla/5.0 (Macintosh) Chrome/120`, 0, "-3 days");
    insertPv.run(PATH, "organic", "iphash-o0:Mozilla/5.0 (Macintosh) Chrome/120", 0, "-4 days");

    // AI-bot views inside the window: chatgpt x4, claude x2, other(Googlebot) x1 —
    // must be EXCLUDED from viewsBySource totals but counted in aiPlatforms.
    for (let i = 0; i < 4; i++) insertPv.run(PATH, "direct", `iphash-gpt-${i}:Mozilla/5.0 (compatible; GPTBot/1.0)`, 0, "-2 days");
    for (let i = 0; i < 2; i++) insertPv.run(PATH, "direct", `iphash-claude-${i}:Mozilla/5.0 (compatible; ClaudeBot/1.0)`, 0, "-1 days");
    insertPv.run(PATH, "direct", "iphash-google:Mozilla/5.0 (compatible; Googlebot/2.1)", 0, "-1 days");

    // Owner view — normal browser UA, but is_owner=1 — must be fully excluded.
    insertPv.run(PATH, "direct", "iphash-owner:Mozilla/5.0 (Macintosh) Chrome/120", 1, "-1 days");

    // Human view OUTSIDE the 90-day window — must be excluded.
    insertPv.run(PATH, "direct", "iphash-old:Mozilla/5.0 (Macintosh) Chrome/120", 0, "-120 days");

    // Noise on a different agent's path — must never bleed into these counts.
    insertPv.run(OTHER_PATH, "direct", "iphash-other:Mozilla/5.0 (Macintosh) Chrome/120", 0, "-1 days");

    // ── Fixtures: conversations (query terms + channel counts) ────────
    const insertConv = db.prepare(
      `INSERT INTO conversations (id, seller_agent_id, source, query_text, created_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`,
    );
    insertConv.run("c1", AGENT_ID, "web", "Har du økologiske egg?", "-1 days");
    insertConv.run("c2", AGENT_ID, "mcp", "Har du økologiske egg?", "-2 days");
    insertConv.run("c3", AGENT_ID, "a2a", "Har du økologiske egg?", "-3 days");
    insertConv.run("c4", AGENT_ID, "web", "Åpningstider?", "-4 days");
    insertConv.run("c5", AGENT_ID, "web", "Åpningstider?", "-5 days");
    insertConv.run("c6", AGENT_ID, null, "Leverer dere til Oslo?", "-6 days"); // NULL source -> 'api'
    insertConv.run("c7", AGENT_ID, "web", "a", "-7 days"); // single-char -> excluded from terms, still counts as a channel row
    // Noise on a different seller — must never count toward AGENT_ID's terms/channels.
    for (let i = 0; i < 4; i++) insertConv.run(`other-c${i}`, OTHER_AGENT, "web", "Har du økologiske egg?", "-1 days");

    // ── Fixtures: contact_clicks ────────────────────────────────────
    const insertClick = db.prepare(
      `INSERT INTO contact_clicks (agent_id, kind, is_bot, created_at) VALUES (?, ?, ?, datetime('now', ?))`,
    );
    for (let i = 0; i < 3; i++) insertClick.run(AGENT_ID, "website", 0, "-1 days");
    for (let i = 0; i < 2; i++) insertClick.run(AGENT_ID, "email", 0, "-2 days");
    insertClick.run(AGENT_ID, "phone", 0, "-3 days");
    // Bot clicks — must be excluded.
    for (let i = 0; i < 5; i++) insertClick.run(AGENT_ID, "email", 1, "-1 days");
    // Out-of-window clicks — must be excluded.
    for (let i = 0; i < 4; i++) insertClick.run(AGENT_ID, "phone", 0, "-120 days");
    // Noise on a different agent — must never bleed in.
    for (let i = 0; i < 10; i++) insertClick.run(OTHER_AGENT, "email", 0, "-1 days");

    // ── Fixtures: agent_metrics ──────────────────────────────────────
    db.prepare(`INSERT INTO agent_metrics (agent_id, times_discovered) VALUES (?, ?)`).run(AGENT_ID, 42);
    // OTHER_AGENT deliberately has no agent_metrics row — discovered must default to 0.

    const stats = getOwnerStats(db, AGENT_ID, PATH);

    // ── (a) viewsBySource ───────────────────────────────────────────
    assertEq(stats.viewsBySource.totals.direct, 3, "viewsBySource: 3 direct (AI + owner + old excluded)");
    assertEq(stats.viewsBySource.totals.search, 2, "viewsBySource: 2 search");
    assertEq(stats.viewsBySource.totals.organic, 1, "viewsBySource: 1 organic");
    assertEq(stats.viewsBySource.totals.social, 0, "viewsBySource: 0 social");
    assertEq(stats.viewsBySource.totals.referral, 0, "viewsBySource: 0 referral");
    const dailySum = stats.viewsBySource.daily.reduce((sum, r) => sum + r.count, 0);
    const totalsSum = Object.values(stats.viewsBySource.totals).reduce((s, n) => s + n, 0);
    assertEq(dailySum, totalsSum, "viewsBySource: daily bucket counts sum to the same total as totals-by-source");
    assertTrue(stats.viewsBySource.daily.length > 0, "viewsBySource: daily array is non-empty");

    // ── (b) aiPlatforms ─────────────────────────────────────────────
    assertEq(stats.aiPlatforms.chatgpt, 4, "aiPlatforms: 4 ChatGPT views");
    assertEq(stats.aiPlatforms.claude, 2, "aiPlatforms: 2 Claude views");
    assertEq(stats.aiPlatforms.other, 1, "aiPlatforms: 1 other-AI (Googlebot) view");
    assertEq(stats.aiPlatforms.total, 7, "aiPlatforms: total = chatgpt+claude+other = 7");

    // ── (c) matchingSearchQueries ───────────────────────────────────
    assertEq(stats.matchingSearchQueries.length, 3, "matchingSearchQueries: 3 distinct terms (single-char 'a' excluded)");
    assertEq(stats.matchingSearchQueries[0], { term: "Har du økologiske egg?", count: 3 }, "matchingSearchQueries: #1 is the 3x term");
    assertEq(stats.matchingSearchQueries[1], { term: "Åpningstider?", count: 2 }, "matchingSearchQueries: #2 is the 2x term");
    assertEq(stats.matchingSearchQueries[2], { term: "Leverer dere til Oslo?", count: 1 }, "matchingSearchQueries: #3 is the 1x term");

    // ── (d) conversationsByChannel ──────────────────────────────────
    const channelMap: Record<string, number> = {};
    for (const row of stats.conversationsByChannel) channelMap[row.source] = row.count;
    assertEq(channelMap.web, 4, "conversationsByChannel: web=4 (c1,c4,c5,c7)");
    assertEq(channelMap.mcp, 1, "conversationsByChannel: mcp=1 (c2)");
    assertEq(channelMap.a2a, 1, "conversationsByChannel: a2a=1 (c3)");
    assertEq(channelMap.api, 1, "conversationsByChannel: NULL source coalesced to api=1 (c6)");
    assertTrue(!("undefined" in channelMap) && Object.keys(channelMap).length === 4, "conversationsByChannel: exactly 4 channels, nothing extra");

    // ── (e) contactClicksByKind ──────────────────────────────────────
    const clickMap: Record<string, number> = {};
    for (const row of stats.contactClicksByKind) clickMap[row.kind] = row.count;
    assertEq(clickMap.website, 3, "contactClicksByKind: website=3");
    assertEq(clickMap.email, 2, "contactClicksByKind: email=2 (5 bot rows excluded)");
    assertEq(clickMap.phone, 1, "contactClicksByKind: phone=1 (4 out-of-window rows excluded)");

    // ── (f) funnel ─────────────────────────────────────────────────
    assertEq(stats.funnel.discovered, 42, "funnel: discovered = agent_metrics.times_discovered");
    assertEq(stats.funnel.viewed, 6, "funnel: viewed = 6 (same bot/owner-excluded human views as viewsBySource totals sum)");
    assertEq(stats.funnel.contactClicked, 6, "funnel: contactClicked = 6 (sum of contactClicksByKind)");

    // ── (g) isolation + empty-agent behaviour ────────────────────────
    const otherStats = getOwnerStats(db, OTHER_AGENT, OTHER_PATH);
    assertEq(otherStats.matchingSearchQueries.length, 1, "isolation: OTHER_AGENT sees only its own term, not AGENT_ID's");
    assertEq(otherStats.matchingSearchQueries[0].count, 4, "isolation: OTHER_AGENT's term count is 4, unaffected by AGENT_ID's rows");
    assertEq(otherStats.funnel.discovered, 0, "isolation: OTHER_AGENT has no agent_metrics row -> discovered=0, not fabricated");
    // The single "noise" page view seeded on OTHER_PATH above IS correctly
    // attributed to OTHER_AGENT's own stats (it isn't lost) — the isolation
    // property being tested is that it never bled into AGENT_ID/PATH's
    // totals above (asserted in block (a): direct=3, not 4).
    assertEq(otherStats.viewsBySource.totals.direct, 1, "isolation: OTHER_AGENT's own path correctly sees its 1 direct view");

    const emptyStats = getOwnerStats(db, "agent-nothing-seeded", "/produsent/does-not-exist");
    assertEq(emptyStats.viewsBySource.totals, { direct: 0, organic: 0, search: 0, social: 0, referral: 0 }, "empty-agent: all-zero view totals");
    assertEq(emptyStats.viewsBySource.daily, [], "empty-agent: no daily rows");
    assertEq(emptyStats.aiPlatforms, { chatgpt: 0, claude: 0, other: 0, total: 0 }, "empty-agent: all-zero AI platforms");
    assertEq(emptyStats.matchingSearchQueries, [], "empty-agent: no query terms");
    assertEq(emptyStats.conversationsByChannel, [], "empty-agent: no channels");
    assertEq(emptyStats.contactClicksByKind, [], "empty-agent: no contact clicks");
    assertEq(emptyStats.funnel, { discovered: 0, viewed: 0, contactClicked: 0 }, "empty-agent: all-zero funnel, never throws");
    assertEq(emptyStats.windowDays, 90, "windowDays: exported constant is 90");
  } finally {
    db.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/owner-stats-service.test.ts`
if (require.main === module) {
  const summary = runOwnerStatsServiceTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
