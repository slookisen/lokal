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
 *       path never bleeds into these counts. AI-agent lookups are AI search
 *       only (ChatGPT-User, Claude-User, Perplexity-User); AI crawlers,
 *       search engines, SEO bots, scripts and scanners are neither people
 *       nor AI lookups, and a non-2xx/304 response is not a page view
 *       (dev-request 2026-10-13-statistikk-riktig-for-investorer, S5).
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
      status_code INTEGER,
      client_class TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      seller_agent_id TEXT,
      source TEXT DEFAULT 'api',
      query_text TEXT,
      is_internal INTEGER NOT NULL DEFAULT 0,
      traffic_class TEXT NOT NULL DEFAULT 'external',
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
    // AI search inside the window: 3 ChatGPT + 2 Claude + 1 other (Perplexity)
    for (let i = 0; i < 3; i++) insertPv.run(PATH, `iphash-gpt-${i}:Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot`, 0, "-2 days");
    for (let i = 0; i < 2; i++) insertPv.run(PATH, `iphash-claude-${i}:Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)`, 0, "-1 days");
    insertPv.run(PATH, "iphash-pplx:Mozilla/5.0 (compatible; Perplexity-User/1.0)", 0, "-3 days");
    // Neither people nor AI lookups: AI crawlers, search engines, SEO bots, scripts, a fake-stale-Chrome scanner
    insertPv.run(PATH, "iphash-gptbot:Mozilla/5.0 (compatible; GPTBot/1.0)", 0, "-2 days");
    insertPv.run(PATH, "iphash-claudebot:Mozilla/5.0 (compatible; ClaudeBot/1.0)", 0, "-1 days");
    insertPv.run(PATH, "iphash-google:Mozilla/5.0 (compatible; Googlebot/2.1)", 0, "-3 days");
    insertPv.run(PATH, "iphash-bing:Mozilla/5.0 (compatible; bingbot/2.0)", 0, "-3 days");
    insertPv.run(PATH, "iphash-ahrefs:Mozilla/5.0 (compatible; AhrefsBot/7.0)", 0, "-3 days");
    insertPv.run(PATH, "iphash-curl:curl/8.0", 0, "-3 days");
    insertPv.run(PATH, "iphash-scan:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36", 0, "-3 days");
    // A browser-looking session whose class was stored at write time as a scanner (full UA),
    // with an older row of the same session from before the column (no class): the whole session is out.
    db.prepare(`INSERT INTO analytics_page_views (path, session_id, is_owner, client_class, created_at) VALUES (?, ?, 0, 'scanner', datetime('now', '-3 days'))`)
      .run(PATH, "iphash-bucket:desktop:0123456789abcdef");
    insertPv.run(PATH, "iphash-bucket:desktop:0123456789abcdef", 0, "-4 days");
    // A redirect and a 404 are not page views
    db.prepare(`INSERT INTO analytics_page_views (path, session_id, is_owner, status_code, created_at) VALUES (?, ?, 0, ?, datetime('now', '-3 days'))`)
      .run(PATH, "iphash-redirect:Mozilla/5.0 (Macintosh) Chrome/120", 301);
    db.prepare(`INSERT INTO analytics_page_views (path, session_id, is_owner, status_code, created_at) VALUES (?, ?, 0, ?, datetime('now', '-3 days'))`)
      .run(PATH, "iphash-404:Mozilla/5.0 (Macintosh) Chrome/120", 404);
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
    // a2a spam guard (2026-10-04): rows that would otherwise top the panel —
    // classified spam (5x), our own internal traffic (4x), and junk payloads
    // still marked external because they predate the backfill (4x each). None
    // may surface as a term; the expected top-3 above stays unchanged.
    const insertClassed = db.prepare(
      `INSERT INTO conversations (id, seller_agent_id, source, query_text, is_internal, traffic_class, created_at)
       VALUES (?, ?, 'a2a', ?, ?, ?, datetime('now', '-1 days'))`,
    );
    for (let i = 0; i < 5; i++) insertClassed.run(`sg-spam-${i}`, AGENT_ID, "紫薇社区邀约 ——Hermes紫薇", 0, "spam");
    for (let i = 0; i < 4; i++) insertClassed.run(`sg-int-${i}`, AGENT_ID, "honning intern sjekk", 1, "external");
    for (let i = 0; i < 4; i++) insertClassed.run(`sg-json-${i}`, AGENT_ID, '{"kind":"recontact-verify"}', 0, "external");
    for (let i = 0; i < 4; i++) insertClassed.run(`sg-url-${i}`, AGENT_ID, "https://kunlunyaochi.com/x", 0, "external");
    // A producer whose ONLY conversations are classified probe traffic.
    insertClassed.run("sg-probe-only", "agent-probe-only", "ping", 0, "probe");

    const activity = getProfileActivity(db, AGENT_ID, PATH);

    // ── (a) views30 ─────────────────────────────────────────────────
    assertEq(activity.views30.human, 4, "views30: 4 human views (owner, >30d-old, bots, scripts, scanners, redirects and 404s excluded)");
    assertEq(activity.views30.aiBreakdown.chatgpt, 3, "views30: 3 ChatGPT-User views (GPTBot crawl not counted)");
    assertEq(activity.views30.aiBreakdown.claude, 2, "views30: 2 Claude-User views (ClaudeBot crawl not counted)");
    assertEq(activity.views30.aiBreakdown.other, 1, "views30: 1 other AI search (Perplexity-User); Googlebot is not AI");
    assertEq(activity.views30.ai, 6, "views30: ai = chatgpt+claude+other = 6");
    assertEq(activity.views30.days, 30, "views30: a 30-day window (inside the 60-day raw retention)");

    // A raw retention shorter than 30 days shortens the window (and the label reads it).
    const prevPrune = process.env.RFB_AUTO_PRUNE_DAYS;
    process.env.RFB_AUTO_PRUNE_DAYS = "7"; // the lowest retention getRetentionWindowDays allows
    try {
      const short = getProfileActivity(db, AGENT_ID, PATH).views30;
      assertEq([short.days, short.human, short.ai], [7, 4, 6], "views30: retention 7 days → a 7-day window (every fixture view is ≤ 5 days old)");
    } finally {
      if (prevPrune === undefined) delete process.env.RFB_AUTO_PRUNE_DAYS; else process.env.RFB_AUTO_PRUNE_DAYS = prevPrune;
    }

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

    // ── (e) a2a spam guard ────────────────────────────────────────────
    assertTrue(
      !activity.topQueryTerms.some(q => /紫薇|intern sjekk|recontact|kunlunyaochi/.test(q.term)),
      "spam-guard: spam / internal / JSON / URL rows never surface as terms",
    );
    const probeOnly = getProfileActivity(db, "agent-probe-only", "/produsent/probe-only");
    assertEq(probeOnly.topQueryTerms, [], "spam-guard: probe-only producer gets no query terms");
    assertTrue(!probeOnly.platforms.includes("a2a"), "spam-guard: probe-only producer gets no A2A badge");

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
