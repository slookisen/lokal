/**
 * agent-stats-view-honesty.test.ts — 2026-10-04 view-stats honesty:
 * producer view statistics count humans, not bots or city pages.
 *
 * Covers:
 *   (a) GET /:city no longer books a profile view on the city's top
 *       producer; GET /produsent/:slug still books exactly one, stamped with
 *       is_owner + traffic_category + a Referer-derived view_source.
 *   (b) trackAgentView write-time classification: search-engine / AI-crawler
 *       UAs, fake-stale-Chrome scanner, owner cookie, velocity scraper,
 *       plain Chrome; view_source mapping (direct/discovery/search/ai).
 *   (c) getTopProducers / getCityStats count only human, non-owner rows —
 *       legacy (traffic_category NULL) rows excluded — and topSource is the
 *       derived source of those rows, not the old hard-coded 'seo'.
 *   (d) GET /api/agents/:id/stats on the shared classifier: bingbot,
 *       PetalBot, AhrefsBot and ExaSearchBot never increment humanViews; a
 *       normal Chrome UA does; GPTBot → chatgpt, Claude-User → claude,
 *       ExaSearchBot → other; Googlebot/DuckDuckBot are neither human nor
 *       AI; velocity scrapers (10-minute and hourly rules) are excluded.
 *   (e) the 120 s response cache returns the same payload within the TTL
 *       (even after new rows land) and a fresh one after it (pinned clock).
 *
 * Harness: own in-memory DB via __setDbForTesting/__initSchemaForTesting
 * (previous handle restored in finally), real route handlers pulled off the
 * router stacks and invoked with fake req/res — same convention as
 * produsent-role-gate.test.ts / analytics-rollup-read-blend.test.ts.
 *
 * Exported runAgentStatsViewHonestyTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/agent-stats-view-honesty.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UA = {
  bingbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116",
  petalbot: "Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
  ahrefs: "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  exa: "Mozilla/5.0 (compatible; ExaSearchBot/1.0; +https://crawler.exa.ai/)",
  gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)",
  claudeUser: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
  googlebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/125",
  duckduckbot: "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
  fakeOldChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36",
};

function fakeJsonRes() {
  const r: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; return r; };
  r.header = () => r;
  r.set = () => r;
  r.type = () => r;
  return r;
}

function findGetHandler(router: any, routePath: string): any {
  const layer = (router.stack as any[]).find(
    (l: any) => l.route && l.route.path === routePath && l.route.methods?.get,
  );
  return layer ? layer.route.stack[layer.route.stack.length - 1].handle : undefined;
}

function sqliteAt(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export async function runAgentStatsViewHonestyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  let resetStatsCache: ((clock?: (() => number) | null) => void) | undefined;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    function seedAgent(id: string, name: string, city: string, trust: number): void {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES (?, ?, 'En beskrivelse', ?, ?, ?, 'producer', ?,
          '[]', '[]', '[]', '{}', '["no"]', ?, 59.91, 10.75,
          ?, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
      ).run(id, name, name, `${id}@example.no`, `https://${id}.example.no`, `key-${id}`, city, trust);
    }
    const agentViews = () =>
      testDb.prepare(
        "SELECT agent_id, view_source, is_owner, traffic_category FROM analytics_agent_views ORDER BY id",
      ).all() as Array<{ agent_id: string; view_source: string; is_owner: number; traffic_category: string | null }>;
    const insertPv = testDb.prepare(
      `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, is_owner, status_code, vertical_id, created_at)
       VALUES (?, 'direct', 'h', ?, 0, 200, 'rfb', ?)`,
    );

    seedAgent("top-trust", "Hoyesttillit Gard", "Testby", 0.99);
    seedAgent("low-trust", "Lavtillit Gard", "Testby", 0.10);

    const { marketplaceRegistry } = require("../services/marketplace-registry") as
      typeof import("../services/marketplace-registry");
    (marketplaceRegistry as any).invalidateCache();

    const { loadConfigsAtBoot } = require("../config/vertical-config") as
      typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }

    const analyticsPath = require.resolve("../services/analytics-service");
    const analytics = require(analyticsPath) as typeof import("../services/analytics-service");
    const { analyticsService, sessionIdFor, hashIP, agentViewSourceFor } = analytics;

    // ════════════════════════════════════════════════════════════════════
    // (a) city page books nothing; profile page books one classified row
    // ════════════════════════════════════════════════════════════════════
    {
      const seoPath = require.resolve("./seo");
      delete require.cache[seoPath];
      const seoRouter = require("./seo").default as any;
      const cityHandler = findGetHandler(seoRouter, "/:city");
      const profileHandler = findGetHandler(seoRouter, "/produsent/:slug");
      assertTrue(typeof cityHandler === "function", "a0: GET /:city handler resolved");
      assertTrue(typeof profileHandler === "function", "a0: GET /produsent/:slug handler resolved");

      function invokeHtml(handler: any, req: any): { status: number; body: string } {
        let status = 200;
        let body = "";
        const res: any = {
          status: (c: number) => { status = c; return res; },
          send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
          redirect: (_c: number, _l: string) => { status = 301; return res; },
          setHeader: () => res, set: () => res, header: () => res, type: () => res,
        };
        handler(req, res, () => { status = -1; });
        return { status, body };
      }

      const city = invokeHtml(cityHandler, {
        params: { city: "testby" }, lang: "no", ip: "10.0.0.1",
        headers: { "user-agent": CHROME_UA },
      });
      assertEq(city.status, 200, "a1: /testby city page renders 200");
      assertTrue(city.body.includes("Hoyesttillit Gard"), "a2: city page lists the highest-trust producer");
      assertEq(agentViews().length, 0, "a3: a city-page visit books NO profile view (used to book one on the highest-trust producer)");

      const profile = invokeHtml(profileHandler, {
        params: { slug: "lavtillit-gard" }, lang: "no", ip: "10.0.0.2",
        headers: { "user-agent": CHROME_UA, referer: "https://rettfrabonden.com/testby" },
      });
      assertEq(profile.status, 200, "a4: /produsent/lavtillit-gard renders 200");
      assertEq(
        agentViews(),
        [{ agent_id: "low-trust", view_source: "discovery", is_owner: 0, traffic_category: "human" }],
        "a5: a profile visit books exactly one row: own-domain Referer → 'discovery', human, not owner",
      );
    }

    // ════════════════════════════════════════════════════════════════════
    // (b) trackAgentView write-time classification + view_source
    // ════════════════════════════════════════════════════════════════════
    {
      testDb.exec("DELETE FROM analytics_agent_views; DELETE FROM analytics_page_views;");
      const track = (headers: Record<string, string>, ip = "10.1.0.1") =>
        analyticsService.trackAgentView({ headers, ip } as any, "low-trust", "Lavtillit Gard", "Testby");
      const last = () => agentViews().slice(-1)[0];

      track({ "user-agent": UA.bingbot });
      assertEq(last().traffic_category, "search_engine", "b1: bingbot profile view → search_engine (not human)");
      track({ "user-agent": UA.exa });
      assertEq(last().traffic_category, "ai_crawler", "b2: ExaSearchBot → ai_crawler");
      track({ "user-agent": UA.fakeOldChrome });
      assertEq(last().traffic_category, "scanner", "b3: fake-stale-Chrome UA → scanner");
      track({ "user-agent": CHROME_UA, cookie: "_rfb_owner=1" });
      assertEq([last().is_owner, last().traffic_category], [1, "human"], "b4: owner cookie → is_owner=1 (category still recorded)");
      track({ "user-agent": CHROME_UA });
      assertEq([last().view_source, last().traffic_category], ["direct", "human"], "b5: plain Chrome, no Referer → direct + human");
      track({ "user-agent": CHROME_UA, referer: "https://www.google.com/" });
      assertEq(last().view_source, "search", "b6: Google Referer → search");
      track({ "user-agent": CHROME_UA, referer: "https://chatgpt.com/" });
      assertEq(last().view_source, "ai", "b7: ChatGPT Referer → ai");
      assertEq(agentViewSourceFor("https://www.facebook.com/x"), "social", "b8: social Referer → social");
      assertEq(agentViewSourceFor("https://example.org/blog"), "referral", "b9: other site → referral");

      // Velocity: 61 distinct pages from this exact session in the last
      // 10 minutes → the next profile view is a scraper's.
      const scraperIp = "10.9.9.9";
      const scraperSid = sessionIdFor(hashIP(scraperIp), CHROME_UA);
      const now = Date.now();
      for (let i = 0; i < 61; i++) insertPv.run(`/produsent/side-${i}`, scraperSid, sqliteAt(now - 5 * 60 * 1000 + i * 1000));
      track({ "user-agent": CHROME_UA }, scraperIp);
      assertEq(last().traffic_category, "scraper", "b10: browser UA with 61 unique pages in 10 min → scraper");
      const politeIp = "10.9.9.8";
      const politeSid = sessionIdFor(hashIP(politeIp), CHROME_UA);
      for (let i = 0; i < 60; i++) insertPv.run(`/produsent/side-${i}`, politeSid, sqliteAt(now - 5 * 60 * 1000 + i * 1000));
      track({ "user-agent": CHROME_UA }, politeIp);
      assertEq(last().traffic_category, "human", "b11: exactly 60 unique pages in 10 min is still human (threshold is strict >)");
    }

    // ════════════════════════════════════════════════════════════════════
    // (c) getTopProducers / getCityStats: human non-owner rows only
    // ════════════════════════════════════════════════════════════════════
    {
      testDb.exec("DELETE FROM analytics_agent_views;");
      const ins = testDb.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, vertical_id, is_owner, traffic_category)
         VALUES (?, ?, 'Testby', ?, 'rfb', ?, ?)`,
      );
      ins.run("low-trust", "Lavtillit Gard", "search", 0, "human");
      ins.run("low-trust", "Lavtillit Gard", "search", 0, "human");
      ins.run("low-trust", "Lavtillit Gard", "direct", 0, "human");
      for (let i = 0; i < 5; i++) ins.run("low-trust", "Lavtillit Gard", "direct", 0, "search_engine");
      ins.run("low-trust", "Lavtillit Gard", "direct", 1, "human");        // owner
      ins.run("low-trust", "Lavtillit Gard", "direct", 0, "scraper");
      ins.run("low-trust", "Lavtillit Gard", "seo", 0, null);             // legacy
      for (let i = 0; i < 9; i++) ins.run("top-trust", "Hoyesttillit Gard", "seo", 0, null); // legacy city-page rows

      const top = analyticsService.getTopProducers(10, 24);
      assertEq(
        top.map((p: any) => [p.agentId, p.viewCount, p.topSource]),
        [["low-trust", 3, "search"]],
        "c1: only the 3 human non-owner views count; topSource derived ('search'); legacy-only agent absent",
      );
      const cities = analyticsService.getCityStats(24);
      assertEq(cities.find((c: any) => c.city === "Testby")?.viewCount, 3, "c2: getCityStats viewCount counts the same 3 human views");
    }

    // ════════════════════════════════════════════════════════════════════
    // (d) + (e) GET /api/agents/:id/stats
    // ════════════════════════════════════════════════════════════════════
    {
      testDb.exec("DELETE FROM analytics_page_views;");
      const statsPath = require.resolve("./agent-stats");
      delete require.cache[statsPath];
      const statsMod = require("./agent-stats") as typeof import("./agent-stats");
      resetStatsCache = statsMod.__resetAgentStatsCacheForTesting;
      let clock = Date.now();
      resetStatsCache(() => clock);
      const statsHandler = findGetHandler(statsMod.default, "/api/agents/:id/stats");
      assertTrue(typeof statsHandler === "function", "d0: GET /api/agents/:id/stats handler resolved");

      async function stats(): Promise<any> {
        const res = fakeJsonRes();
        await statsHandler({ params: { id: "low-trust" }, headers: {}, query: {} } as any, res);
        assertEq(res.statusCode, 200, "d: stats 200");
        return res.body;
      }

      const path = "/produsent/lavtillit-gard";
      const t = Date.now() - 2 * 24 * 3600 * 1000;
      const view = (sid: string, at = t) => insertPv.run(path, sid, sqliteAt(at));
      const botSid = (ip: string, ua: string) => `${hashIP(ip)}:${ua}`;

      // Bots that the old marker list called "human".
      view(botSid("20.0.0.1", UA.bingbot));
      view(botSid("20.0.0.2", UA.petalbot));
      view(botSid("20.0.0.3", UA.ahrefs));
      view(botSid("20.0.0.4", UA.exa));
      let s = await stats();
      assertEq(s.humanViews, 0, "d1: bingbot / PetalBot / AhrefsBot / ExaSearchBot add NOTHING to humanViews");
      assertEq(s.aiBreakdown, { chatgpt: 0, claude: 0, other: 1 }, "d2: ExaSearchBot is an AI crawler (other); bingbot/PetalBot/AhrefsBot are not AI");

      // Search engines the old list called "AI other".
      resetStatsCache(() => clock);
      view(botSid("20.0.0.5", UA.googlebot));
      view(botSid("20.0.0.6", UA.duckduckbot));
      view(botSid("20.0.0.7", UA.gptbot));
      view(botSid("20.0.0.8", UA.claudeUser));
      s = await stats();
      assertEq(
        [s.humanViews, s.aiViews, s.aiBreakdown],
        [0, 3, { chatgpt: 1, claude: 1, other: 1 }],
        "d3: Googlebot/DuckDuckBot are search_engine (neither human nor AI); GPTBot → chatgpt, Claude-User → claude",
      );

      // A real visitor (current bucketed session_id format) counts.
      resetStatsCache(() => clock);
      view(sessionIdFor(hashIP("30.0.0.1"), CHROME_UA));
      s = await stats();
      assertEq(s.humanViews, 1, "d4: a normal Chrome UA increments humanViews");

      // Velocity scraper, 10-minute rule: same session, 70 distinct pages in
      // ±4 minutes around its view of this producer.
      resetStatsCache(() => clock);
      const scraper10 = sessionIdFor(hashIP("30.0.0.2"), CHROME_UA);
      view(scraper10);
      for (let i = 0; i < 70; i++) insertPv.run(`/produsent/annen-${i}`, scraper10, sqliteAt(t - 4 * 60 * 1000 + i * 6 * 1000));
      // Velocity scraper, hourly /produsent rule: 205 distinct producer pages
      // spread over ±25 minutes (≈41 per 10 min — below the 10-minute rule).
      const scraperHour = sessionIdFor(hashIP("30.0.0.3"), CHROME_UA);
      const t2 = t + 6 * 3600 * 1000;
      view(scraperHour, t2);
      for (let i = 0; i < 205; i++) insertPv.run(`/produsent/time-${i}`, scraperHour, sqliteAt(t2 - 25 * 60 * 1000 + i * 14 * 1000));
      // A slow, real reader: 5 pages over the same hour.
      const reader = sessionIdFor(hashIP("30.0.0.4"), CHROME_UA);
      view(reader, t2);
      for (let i = 0; i < 5; i++) insertPv.run(`/produsent/les-${i}`, reader, sqliteAt(t2 + i * 60 * 1000));
      s = await stats();
      assertEq(s.humanViews, 2, "d5: velocity scrapers (>60 unique pages/10 min, >200 /produsent pages/hour) are excluded; the slow reader counts");

      // (e) cache: a new human view within the TTL is not visible yet …
      const before = await stats();
      view(sessionIdFor(hashIP("30.0.0.5"), CHROME_UA));
      clock += 119_000;
      const within = await stats();
      assertEq(within, before, "e1: within 120 s the cached payload is returned unchanged");
      // … and is after the TTL expires.
      clock += 2_000;
      const after = await stats();
      assertEq(after.humanViews, before.humanViews + 1, "e2: after the TTL the payload is recomputed (new human view visible)");
    }

    if (log) console.log(`\nagent-stats-view-honesty: ${passed} passed, ${failed} failed`);
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    try { resetStatsCache?.(null); } catch { /* ignore */ }
    if (prevDb) __setDbForTesting(prevDb);
    try {
      const { marketplaceRegistry } = require("../services/marketplace-registry") as
        typeof import("../services/marketplace-registry");
      (marketplaceRegistry as any).invalidateCache();
    } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/agent-stats-view-honesty.test.ts`
if (require.main === module) {
  runAgentStatsViewHonestyTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
