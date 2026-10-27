/**
 * profile-ai-deliveries.test.ts — dev-request 2026-10-14-med-i-ai-svar-per-profil, S1
 * (Daniel 2026-10-14: «Med i AI-svar», how many times each profile was sent to
 * ChatGPT, Claude and other AIs).
 *
 * Covers the acceptance criteria:
 *   (a) profile_ai_deliveries exists with the unique key, and the batch upsert
 *       adds to an existing day row (schema vs. the flush query).
 *   (b) list pages: (S1, 2026-10-25) an ai_search fetch of the front page
 *       counts nothing any more; one of a city page counts
 *       each rendered profile once in ai_page_list; the same fetch from a
 *       crawler, a search engine, a person, a script or our own traffic counts
 *       nothing; a 4xx answer counts nothing.
 *   (c) repeat: the same AI session fetching the same list within the window
 *       counts once per profile; another session or after the window counts again.
 *   (d) profile page: ai_page_profile +1, and the rendered page has the
 *       «Med i AI-svar» tile with its help text and no literal `${`.
 *   (e) MCP: a data tool returning K profiles counts each once in `mcp`, per AI
 *       from client name / UA; a probe client or our own traffic counts nothing.
 *   (f) A2A: countable = 0 counts nothing; countable = 1 counts each profile;
 *       an error answer counts nothing.
 *   (g) the reads: /api/agents/:id/stats payload (aiDeliveries), the platform
 *       sum in computeTrafficStats, the owner stats (60 d + whole period) and
 *       the admin top list.
 *   (h) aiAssistantVendor has Perplexity; aiVendorBucket keeps three buckets.
 *   (g2) S1: rows before countingSince (PROFILE_AI_DELIVERIES_COUNTING_SINCE,
 *       default 2026-10-26) stay in the table but are not counted anywhere.
 *   (i) owner portal and admin dashboard wording: «Med i AI-søk», never
 *       «vist i ChatGPT»; «Oppdaget» is marked as the old lifetime counter.
 *
 * Exported runProfileAiDeliveriesTests({log}) -> Promise<TestSummary>; wired into
 * tests/test.ts. Standalone: npx tsx src/services/profile-ai-deliveries.test.ts
 */

import Database from "better-sqlite3";
import * as vm from "vm";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHATGPT_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const CLAUDE_USER = "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)";
const PERPLEXITY_USER = "Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)";
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const HUMAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const CURL = "curl/8.5.0";

export async function runProfileAiDeliveriesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq<T>(actual: T, expected: T, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };
  // «Med i AI-søk» (S1): counting starts on a configured day; a year back here
  // so the rows written today count whatever the clock says.
  const prevCountingSince = process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE;
  const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = yearAgo;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }

    const svc = require("./profile-ai-deliveries") as typeof import("./profile-ai-deliveries");
    const compute = require("./profile-ai-deliveries-compute") as typeof import("./profile-ai-deliveries-compute");
    svc.__resetAiDeliveriesForTesting();

    function seedAgent(id: string, name: string, city: string, trust: number, categories: string[]): void {
      db.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES (?, ?, 'En beskrivelse', ?, ?, ?, 'producer', ?,
          ?, '[]', '[]', '{}', '["no"]', ?, 59.91, 10.75,
          ?, 1, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
      ).run(id, name, name, `${id}@example.no`, `https://${id}.example.no`, `key-${id}`, JSON.stringify(categories), city, trust);
    }
    seedAgent("p-1", "Aker Gaard En", "Oslo", 0.9, ["vegetables"]);
    seedAgent("p-2", "Aker Gaard To", "Oslo", 0.8, ["vegetables"]);
    seedAgent("p-3", "Aker Gaard Tre", "Oslo", 0.7, ["vegetables"]);
    const regMod = require("./marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    const rowsFor = (channel: string) => db.prepare(
      "SELECT profile_id, ai_vendor, SUM(count) AS n FROM profile_ai_deliveries WHERE channel = ? GROUP BY profile_id, ai_vendor ORDER BY profile_id",
    ).all(channel) as Array<{ profile_id: string; ai_vendor: string; n: number }>;
    const total = () => (db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM profile_ai_deliveries").get() as { n: number }).n;
    const flush = () => svc.flushAiDeliveries(db as any);

    // ── (a) schema + upsert ────────────────────────────────────────────
    {
      const cols = (db.prepare("PRAGMA table_info(profile_ai_deliveries)").all() as Array<{ name: string }>).map((c) => c.name);
      assertEq(cols.join(","), "vertical_id,profile_id,day,channel,ai_vendor,count", "(a) profile_ai_deliveries columns");
      const n1 = svc.recordAiDeliveries({ vertical: "rfb", channel: "mcp", vendor: "claude", profileIds: ["x-1", "x-1", "x-2"], sessionKey: "s", listKey: "l" });
      assertEq(n1, 2, "(a) a profile listed twice in one delivery counts once");
      flush();
      svc.recordAiDeliveries({ vertical: "rfb", channel: "mcp", vendor: "claude", profileIds: ["x-1"], sessionKey: "s2", listKey: "l" });
      flush();
      const r = db.prepare("SELECT COUNT(*) AS rows, SUM(count) AS n FROM profile_ai_deliveries WHERE profile_id = 'x-1'").get() as { rows: number; n: number };
      assertEq(r.rows, 1, "(a) the second flush upserts into the same day row");
      assertEq(r.n, 2, "(a) and adds to its count");
      let dup = false;
      try {
        db.prepare("INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) SELECT vertical_id, profile_id, day, channel, ai_vendor, 1 FROM profile_ai_deliveries WHERE profile_id = 'x-1'").run();
      } catch { dup = true; }
      assertTrue(dup, "(a) the unique key covers vertical, profile, day, channel and AI");
      db.prepare("DELETE FROM profile_ai_deliveries").run();
    }

    // ── harness over the real seo.ts handlers ──────────────────────────
    const seoPath = require.resolve("../routes/seo");
    delete require.cache[seoPath];
    const seoRouter = require("../routes/seo").default as any;
    function invoke(routePath: string, url: string, ua: string, extra: { params?: Record<string, string>; lang?: string; ip?: string; cookie?: string } = {}) {
      const layer = (seoRouter.stack as any[]).find((l: any) => l.route && l.route.path === routePath && l.route.methods?.get);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const headers: Record<string, string> = { "user-agent": ua };
      if (extra.cookie) headers.cookie = extra.cookie;
      const req: any = {
        lang: extra.lang ?? "no", query: {}, params: extra.params ?? {}, headers, ip: extra.ip ?? "203.0.113.7",
        originalUrl: url, url, path: url, hostname: "rettfrabonden.com",
        get(h: string) { return headers[h.toLowerCase()]; },
      };
      let body = "";
      const res: any = new EventEmitter();
      Object.assign(res, {
        statusCode: 200,
        locals: {},
        status(c: number) { res.statusCode = c; return res; },
        set() { return res; },
        setHeader() { return res; },
        redirect() { res.statusCode = 301; res.emit("finish"); return res; },
        send(b: unknown) { body = typeof b === "string" ? b : String(b); res.emit("finish"); return res; },
      });
      handler(req, res, () => {});
      return { status: res.statusCode as number, body };
    }

    // ── (b) list pages ─────────────────────────────────────────────────
    {
      // S1 (2026-10-25): the front page's featured list answers no search, so it no longer counts.
      const home = invoke("/", "/", CHATGPT_USER, { ip: "203.0.113.200" });
      assertEq(home.status, 200, "(b) front page renders 200");
      assertTrue(home.body.includes("Aker Gaard En"), "(b) the front page lists the featured producers");
      flush();
      assertEq(total(), 0, "(b) S1: ChatGPT-User on the front page counts nothing (featured list not counted)");
      const seoSrc = fs.readFileSync(path.join(__dirname, "../routes/seo.ts"), "utf8");
      assertTrue(!/recordAiPageDelivery\([^)]*featured/.test(seoSrc), "(b) S1: seo.ts records no delivery for the featured list");

      const r = invoke("/:city", "/oslo", CHATGPT_USER, { params: { city: "oslo" } });
      assertEq(r.status, 200, "(b) city page renders 200");
      flush();
      const rows = rowsFor("ai_page_list");
      assertEq(rows.map((x) => x.profile_id).join(","), "p-1,p-2,p-3", "(b) ChatGPT-User on a city page: each listed profile counted");
      assertTrue(rows.every((x) => x.n === 1 && x.ai_vendor === "chatgpt"), "(b) once each, under chatgpt");

      for (const [label, ua, cookie] of [
        ["GPTBot (AI crawler)", GPTBOT, undefined], ["Googlebot", GOOGLEBOT, undefined], ["a person", HUMAN, undefined],
        ["a script / scraper", CURL, undefined], ["ChatGPT-User with the owner cookie", CHATGPT_USER, "_rfb_owner=1"],
      ] as Array<[string, string, string | undefined]>) {
        const before = total();
        invoke("/:city", "/oslo", ua, { ip: "198.51.100.9", cookie, params: { city: "oslo" } });
        flush();
        assertEq(total(), before, `(b) the same city-page fetch from ${label} counts nothing`);
      }

      const fakeRes: any = Object.assign(new EventEmitter(), { statusCode: 404, locals: {} });
      const before = total();
      svc.recordAiPageDelivery({ headers: { "user-agent": CHATGPT_USER }, ip: "198.51.100.10", originalUrl: "/x" } as any, fakeRes, "ai_page_list", ["p-1"]);
      fakeRes.emit("finish");
      flush();
      assertEq(total(), before, "(b) an ai_search fetch answered 404 counts nothing");

      const city = invoke("/:city", "/oslo", CLAUDE_USER, { params: { city: "oslo" }, ip: "203.0.113.8" });
      assertEq(city.status, 200, "(b) city page renders 200");
      flush();
      const claude = rowsFor("ai_page_list").filter((x) => x.ai_vendor === "claude");
      assertEq(claude.map((x) => x.profile_id).join(","), "p-1,p-2,p-3", "(b) Claude-User on /oslo: each city profile counted under claude");
    }

    // ── (c) repeat within the window ───────────────────────────────────
    {
      const before = total();
      invoke("/:city", "/oslo", CHATGPT_USER, { params: { city: "oslo" } }); // same ip + UA as the first city fetch in (b)
      flush();
      assertEq(total(), before, "(c) the same AI session fetching the same list again within 30 min counts nothing more");
      invoke("/:city", "/oslo?utm_source=chatgpt.com", CHATGPT_USER, { params: { city: "oslo" } });
      flush();
      assertEq(total(), before, "(c) a tracking parameter does not make it a new list");
      invoke("/:city", "/oslo", CHATGPT_USER, { ip: "203.0.113.99", params: { city: "oslo" } });
      flush();
      assertEq(total(), before + 3, "(c) another AI session counts each profile again");

      const t0 = Date.UTC(2026, 9, 14, 10, 0, 0);
      const input = { vertical: "rfb" as const, channel: "ai_page_list" as const, vendor: "chatgpt" as const, profileIds: ["r-1", "r-2"], sessionKey: "sess", listKey: "/sok?q=honning" };
      assertEq(svc.recordAiDeliveries({ ...input, nowMs: t0 }), 2, "(c) first fetch: 2 profiles");
      assertEq(svc.recordAiDeliveries({ ...input, nowMs: t0 + 29 * 60_000 }), 0, "(c) after 29 min: nothing");
      assertEq(svc.recordAiDeliveries({ ...input, nowMs: t0 + 31 * 60_000 }), 2, "(c) after 31 min: counted again");
      assertEq(svc.recordAiDeliveries({ ...input, listKey: "/sok?q=ost", nowMs: t0 + 31 * 60_000 }), 2, "(c) a different list counts on its own");
      flush();
      db.prepare("DELETE FROM profile_ai_deliveries WHERE profile_id LIKE 'r-%'").run();
    }

    // ── (d) profile page + tile ────────────────────────────────────────
    {
      const before = rowsFor("ai_page_profile").length;
      const r = invoke("/produsent/:slug", "/produsent/aker-gaard-en", PERPLEXITY_USER, { params: { slug: "aker-gaard-en" } });
      assertEq(r.status, 200, "(d) producer page renders 200");
      flush();
      const rows = rowsFor("ai_page_profile");
      assertEq(rows.length, before + 1, "(d) Perplexity-User on the profile page: one ai_page_profile row");
      assertTrue(rows.some((x) => x.profile_id === "p-1" && x.ai_vendor === "perplexity" && x.n === 1), "(d) for that profile, under perplexity");

      const human = invoke("/produsent/:slug", "/produsent/aker-gaard-en", HUMAN, { params: { slug: "aker-gaard-en" }, ip: "198.51.100.20" });
      flush();
      assertEq(rowsFor("ai_page_profile").length, before + 1, "(d) a person on the profile page counts nothing");
      assertTrue(human.body.includes('data-stat="aiDeliveries"'), "(d) the page has the «Med i AI-søk» tile");
      assertTrue(human.body.includes("<small>Med i AI-søk<br>"), "(d) tile label «Med i AI-søk»");
      assertTrue(!human.body.includes("Med i AI-svar"), "(d) the old name «Med i AI-svar» is gone");
      assertTrue(human.body.includes("ganger profilen var blant treffene en AI-assistent hentet &middot; siste 12 måneder"), "(d) tile subtitle, a full window after the counting started (statistikk S2c: 12 months)");
      assertTrue(human.body.includes("Tallet viser ikke hvor mange som så den."), "(d) help text: it does not show how many saw it");
      assertTrue(human.body.includes("var d = y.aiDeliveries;"), "(d) the tile is filled from /api/agents/:id/stats year.aiDeliveries (S2c)");
      assertTrue(human.body.includes("d.value > 0 || partial"), "(d) the tile also shows at 0 while the counting is younger than the window");
      assertTrue(human.body.includes("textContent = cap(lb.aiDeliveries)") && human.body.includes('"ganger profilen var blant treffene en AI-assistent hentet · " + lb.aiDeliveries'), "(d) at 0 it shows «Siden <dato>»; in the first window «siden <dato>»");
      assertTrue(human.body.includes('"nb-NO"'), "(d) Norwegian date format on the Norwegian page");
      assertTrue(!human.body.includes("${"), "(d) rendered HTML has no literal ${");
      assertTrue(!/vist i ChatGPT/i.test(human.body), "(d) never «vist i ChatGPT»");
      const en = invoke("/produsent/:slug", "/en/produsent/aker-gaard-en", HUMAN, { params: { slug: "aker-gaard-en" }, lang: "en", ip: "198.51.100.21" });
      assertTrue(en.body.includes("<small>In AI searches<br>") && !en.body.includes("${"), "(d) English tile «In AI searches» renders without ${");
      assertTrue(en.body.includes("times the profile was among the results an AI assistant fetched &middot; last 12 months"), "(d) English subtitle");
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = compute.utcDay(Date.now());
      const freshNb = invoke("/produsent/:slug", "/produsent/aker-gaard-en", HUMAN, { params: { slug: "aker-gaard-en" }, ip: "198.51.100.22" });
      const freshEn = invoke("/produsent/:slug", "/en/produsent/aker-gaard-en", HUMAN, { params: { slug: "aker-gaard-en" }, lang: "en", ip: "198.51.100.23" });
      const nbSince = new Date().toLocaleDateString("nb-NO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
      const enSince = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
      assertTrue(freshNb.body.includes(`ganger profilen var blant treffene en AI-assistent hentet &middot; siden ${nbSince}`), "(d) S1: «siden <dato>» shows the configured start day");
      assertTrue(freshEn.body.includes(`times the profile was among the results an AI assistant fetched &middot; since ${enSince}`), "(d) S1: English «since <date>»");
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = yearAgo;
      assertTrue(en.body.includes('y.labels["en"]') && en.body.includes('"en-GB"'), "(d) English: the English labels, English number format");
      // Every inline script on the page must compile: a "\n" written without the
      // template-literal escape becomes a raw newline inside a JS string.
      for (const [lang, body] of [["no", human.body], ["en", en.body]] as const) {
        const scripts = [...body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
          .filter((m) => !/type="application\/(ld\+)?json"/.test(m[0]))
          .map((m) => m[1]);
        const broken = scripts.filter((code) => { try { new vm.Script(code); return false; } catch { return true; } });
        assertEq(broken.length, 0, `(d) ${lang}: every inline script on the producer page compiles`);
      }
    }

    // ── (e) MCP ────────────────────────────────────────────────────────
    {
      const { registerTools } = require("../routes/mcp") as typeof import("../routes/mcp");
      const tools = new Map<string, any>();
      let clientName: string | undefined;
      const fakeServer: any = {
        server: { getClientVersion: () => (clientName ? { name: clientName, version: "1" } : undefined) },
        registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
        resource() { /* no-op */ }, prompt() { /* no-op */ }, registerResource() { /* no-op */ }, registerPrompt() { /* no-op */ },
      };
      registerTools(fakeServer, () => "test-client", () => undefined);
      const discover = tools.get("lokal_discover");
      const call = (ua: string, sessionId: string, args: any = { categories: ["vegetables"], limit: 10 }) =>
        discover(args, { sessionId, requestInfo: { headers: { "user-agent": ua } } });

      db.prepare("DELETE FROM profile_ai_deliveries").run();
      const out = await call("openai-mcp/1.0.0", "mcp-1");
      const text = String(out?.content?.[0]?.text ?? "");
      flush();
      const rows = rowsFor("mcp");
      assertTrue(text.includes("Aker Gaard En"), "(e) lokal_discover returns the seeded producers");
      assertEq(rows.map((x) => x.profile_id).join(","), "p-1,p-2,p-3", "(e) an MCP search returning K profiles counts each");
      assertTrue(rows.every((x) => x.n === 1 && x.ai_vendor === "chatgpt"), "(e) once each, chatgpt from the UA");

      await call("openai-mcp/1.0.0", "mcp-1");
      flush();
      assertEq(total(), 3, "(e) the same MCP session repeating the call within 30 min counts nothing more");

      for (const [label, ua] of [["a probe client (mcpbeat)", "mcpbeat/2.0"], ["our own fleet (rfb-…)", "rfb-health/1.0"], ["a monitor", "UptimeRobot monitor"]]) {
        await call(ua, `mcp-${label}`);
        flush();
        assertEq(total(), 3, `(e) ${label} counts nothing`);
      }

      clientName = "claude-ai";
      await call("node", "mcp-2");
      flush();
      assertTrue(rowsFor("mcp").filter((x) => x.ai_vendor === "claude").length === 3, "(e) vendor from initialize.clientInfo.name (claude-ai → claude)");
      clientName = "Smithery probe";
      await call("node", "mcp-3");
      flush();
      assertEq(total(), 6, "(e) a probe client name counts nothing");
      clientName = undefined;
      await call("python-httpx/0.27", "mcp-4");
      flush();
      assertTrue(rowsFor("mcp").filter((x) => x.ai_vendor === "unknown").length === 3, "(e) no AI in client name or UA → unknown");
      assertEq(svc.agentDeliveryVendor("Perplexity", ""), "perplexity", "(e) Perplexity client → perplexity");
    }

    // ── (f) A2A ────────────────────────────────────────────────────────
    {
      db.prepare("DELETE FROM profile_ai_deliveries").run();
      const a2a = (countable: boolean, status: number, ip: string) => {
        const res: any = Object.assign(new EventEmitter(), { statusCode: status, locals: { a2aCountable: countable } });
        svc.recordA2aDelivery({ headers: { "user-agent": "python-requests/2.31" }, ip } as any, res, ["p-1", "p-2"], "honning i oslo");
        res.emit("finish");
        flush();
      };
      a2a(false, 200, "192.0.2.1");
      assertEq(total(), 0, "(f) an A2A answer with countable = 0 counts nothing");
      a2a(true, 500, "192.0.2.2");
      assertEq(total(), 0, "(f) an A2A error answer counts nothing");
      a2a(true, 200, "192.0.2.3");
      const rows = rowsFor("a2a");
      assertEq(rows.map((x) => `${x.profile_id}:${x.ai_vendor}:${x.n}`).join(","), "p-1:unknown:1,p-2:unknown:1", "(f) countable = 1: each profile once, AI unknown");
      const a2aSrc = fs.readFileSync(path.join(__dirname, "../routes/a2a.ts"), "utf8");
      assertTrue(/res\.locals\.a2aCountable = countable && results\.length > 0;\s*\n\s*\/\/[^\n]*\n\s*recordA2aDelivery\(req, res, results\.map/.test(a2aSrc),
        "(f) a2a.ts records the answer's producers right after the countable verdict");
    }

    // ── (g) reads ──────────────────────────────────────────────────────
    {
      db.prepare("DELETE FROM profile_ai_deliveries").run();
      const now = Date.now();
      const today = compute.utcDay(now);
      const old = compute.utcDay(now - 90 * 24 * 60 * 60 * 1000);
      const ins = db.prepare("INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES (?, ?, ?, ?, ?, ?)");
      ins.run("rfb", "p-1", today, "ai_page_list", "chatgpt", 5);
      ins.run("rfb", "p-1", today, "mcp", "claude", 2);
      ins.run("rfb", "p-1", old, "a2a", "unknown", 4);
      ins.run("rfb", "p-2", today, "ai_page_profile", "perplexity", 1);
      ins.run("dental", "c-1", today, "mcp", "chatgpt", 9);

      const { computeAgentStats } = require("./agent-stats-compute") as typeof import("./agent-stats-compute");
      const s = computeAgentStats(db as any, "p-1", "/produsent/aker-gaard-en", now);
      assertEq(s.aiDeliveries.windowDays, 60, "(g) stats payload aiDeliveries.windowDays");
      assertEq(s.aiDeliveries.total, 7, "(g) stats payload aiDeliveries.total (60 d, older day left out)");
      assertEq(s.aiDeliveries.byVendor.chatgpt, 5, "(g) byVendor.chatgpt");
      assertEq(s.aiDeliveries.byVendor.claude, 2, "(g) byVendor.claude");
      assertEq(s.aiDeliveries.byChannel.ai_page_list, 5, "(g) byChannel.ai_page_list");
      assertEq(s.aiDeliveries.byChannel.mcp, 2, "(g) byChannel.mcp");

      const { getOwnerStats } = require("./owner-stats-service") as typeof import("./owner-stats-service");
      const o = getOwnerStats(db as any, "p-1", "/produsent/aker-gaard-en");
      assertEq(`${o.aiDeliveries.window.windowDays}:${o.aiDeliveries.window.total}`, "365:11", "(g) owner stats: 12 months since statistikk S2d (the 90-day-old row counts)");
      assertEq(o.aiDeliveries.allTime.total, 11, "(g) owner stats: whole period");
      assertEq(o.aiDeliveries.allTime.byChannel.a2a, 4, "(g) owner stats: whole period per channel");

      const { computeTrafficStats } = require("./traffic-stats-compute") as typeof import("./traffic-stats-compute");
      assertEq(computeTrafficStats(db as any, "rfb", 60, now).aiDeliveries, 8, "(g) /api/traffic-stats platform sum (rfb, 60 d)");
      assertEq(computeTrafficStats(db as any, undefined, 60, now).aiDeliveries, 17, "(g) platform sum across verticals");

      const top = compute.computeAiDeliveryTopProfiles(db as any, "rfb", 60, now, 10);
      assertEq(top.map((t) => `${t.profileId}:${t.total}`).join(","), "p-1:7,p-2:1", "(g) admin top list (60 d)");
      const topAll = compute.computeAiDeliveryTopProfiles(db as any, "rfb", null, now, 1);
      assertEq(topAll.map((t) => `${t.profileId}:${t.total}`).join(","), "p-1:11", "(g) admin top list (whole period, limit)");

      // The start date of the counting (Daniel 2026-10-15: show «fra <dato>» instead of 0);
      // S1: the configured day, the same for every vertical and profile.
      assertEq(s.aiDeliveries.countingSince, yearAgo, "(g) countingSince: the configured start day");
      assertEq(compute.computeAiDeliveries(db as any, "rfb", "p-unseen", 60, now).countingSince, yearAgo, "(g) a profile with 0 deliveries still gets the start date");
      assertEq(compute.computeAiDeliveries(db as any, "rfb", "p-unseen", 60, now).total, 0, "(g) …and total 0");
      assertEq(compute.computeAiDeliveries(db as any, "experiences", undefined, 60, now).countingSince, yearAgo, "(g) a vertical with no deliveries: still the start date");
      assertEq(o.aiDeliveries.window.countingSince, yearAgo, "(g) owner stats carry countingSince");
      assertEq(compute.emptyAiDeliveries(60).countingSince, null, "(g) empty payload: countingSince null");

      // ── (g2) S1: rows before countingSince are kept but not counted ──
      const mid = compute.utcDay(now - 30 * 24 * 60 * 60 * 1000);
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = mid;
      const o2 = getOwnerStats(db as any, "p-1", "/produsent/aker-gaard-en");
      assertEq(o2.aiDeliveries.allTime.total, 7, "(g2) owner stats whole period: the row before countingSince is left out");
      assertEq(o2.aiDeliveries.allTime.byChannel.a2a, 0, "(g2) …also per channel");
      assertEq(o2.aiDeliveries.allTime.countingSince, mid, "(g2) countingSince is the configured day");
      assertEq(compute.computeAiDeliveryTopProfiles(db as any, "rfb", null, now, 1).map((t) => `${t.profileId}:${t.total}`).join(","), "p-1:7", "(g2) admin top list (whole period) leaves it out");
      assertEq(compute.computeAiDeliveries(db as any, undefined, undefined, null, now).total, 17, "(g2) all verticals, whole period: 21 - 4");
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = today;
      assertEq(computeAgentStats(db as any, "p-1", "/produsent/aker-gaard-en", now).aiDeliveries.total, 7, "(g2) start day today: today's rows count");
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = compute.utcDay(now + 24 * 60 * 60 * 1000);
      assertEq(computeAgentStats(db as any, "p-1", "/produsent/aker-gaard-en", now).aiDeliveries.total, 0, "(g2) start day tomorrow: nothing counts yet, even in the 60-day window");
      assertEq(computeTrafficStats(db as any, undefined, 60, now).aiDeliveries, 0, "(g2) …and the platform sum is 0");
      assertEq((db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM profile_ai_deliveries").get() as { n: number }).n, 21, "(g2) no row was deleted");
      delete process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE;
      assertEq(compute.aiDeliveriesCountingSince(), "2026-10-26", "(g2) default start day 2026-10-26");
      assertEq(compute.DEFAULT_AI_DELIVERIES_COUNTING_SINCE, "2026-10-26", "(g2) default constant");
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-13-45";
      assertEq(compute.aiDeliveriesCountingSince(), "2026-10-26", "(g2) an invalid override falls back to the default");
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = yearAgo;
    }

    // ── (h) vendor buckets ─────────────────────────────────────────────
    {
      const tc = require("./traffic-classifier") as typeof import("./traffic-classifier");
      assertEq(tc.aiAssistantVendor(PERPLEXITY_USER), "perplexity", "(h) aiAssistantVendor: Perplexity-User → perplexity");
      assertEq(tc.aiVendorBucket(PERPLEXITY_USER), "other", "(h) aiVendorBucket keeps Perplexity under other");
      assertEq(tc.aiAssistantVendor(CHATGPT_USER), "chatgpt", "(h) ChatGPT-User → chatgpt");
      assertEq(tc.aiAssistantVendor(CLAUDE_USER), "claude", "(h) Claude-User → claude");
    }

    // ── (i) owner portal + admin wording ───────────────────────────────
    {
      const selger = fs.readFileSync(path.join(__dirname, "../public/selger.html"), "utf8");
      const admin = fs.readFileSync(path.join(__dirname, "../public/admin-dashboard.html"), "utf8");
      assertTrue(selger.includes("<h2>Med i AI-s&oslash;k</h2>") && selger.includes("statsAiDeliveries"), "(i) selger.html has the «Med i AI-søk» card");
      assertTrue(!selger.includes("Med i AI-svar") && !admin.includes("Med i AI-svar"), "(i) the old name «Med i AI-svar» is gone from selger.html and admin");
      assertTrue(selger.includes("Ganger profilen var blant treffene en AI-assistent hentet (") && selger.includes("'hele perioden'"), "(i) selger.html: 60 d and whole period, new subtitle");
      assertTrue(selger.includes("'siden ' + dlSince") && !selger.includes("'fra ' + dlSince"), "(i) selger.html: «siden <dato>» in the first window and for the whole period");
      assertTrue(admin.includes("📤 Med i AI-søk (ganger profilen var blant treffene en AI-assistent hentet)"), "(i) admin panel title «Med i AI-søk»");
      assertTrue(admin.includes("'siden ' + escHtml(sinceTxt)"), "(i) admin: shows since when it is counted");
      assertTrue(selger.includes("statsAiDeliveriesVendor") && selger.includes("statsAiDeliveriesChannel"), "(i) selger.html: per AI and per channel");
      assertTrue(selger.includes("ikke hvor mange som s&aring; profilen"), "(i) selger.html help text: not how many saw it");
      assertTrue(selger.includes("Oppdaget (gammel livstidsteller)"), "(i) selger.html marks «Oppdaget» as the old lifetime counter");
      assertTrue(admin.includes("aiDeliveriesPanel") && admin.includes("/ai-deliveries?limit=10"), "(i) admin dashboard has the panel and reads /ai-deliveries");
      for (const [name, src] of [["selger.html", selger], ["admin-dashboard.html", admin]]) {
        assertTrue(!/vist i ChatGPT/i.test(src), `(i) ${name}: never «vist i ChatGPT»`);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    if (prevCountingSince === undefined) delete process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE; else process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = prevCountingSince;
    (require("./profile-ai-deliveries") as typeof import("./profile-ai-deliveries")).__resetAiDeliveriesForTesting();
    const regMod = require("./marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
    initMod.__setDbForTesting(prevDb as any); // null: the next getDb() reopens the real file
    try { db.close(); } catch { /* already closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runProfileAiDeliveriesTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
