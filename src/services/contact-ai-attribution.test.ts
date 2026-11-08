/**
 * contact-ai-attribution.test.ts — dev-request 2026-10-14-klikk-fra-ai-svar-per-profil,
 * slice 4 («Kontakt-klikk»): the profile page remembers its landing (utm_* +
 * AI referrer host) and sends it with the contact beacon and the /ut/ links;
 * contact-tracking classifies the AI itself and stores contact_clicks.ai_source.
 *
 * Covers:
 *   (a) schema: contact_clicks.ai_source exists, re-init idempotent.
 *   (b) readContactAttribution / sanitizeAiRef: whitelist only, caps, bare host.
 *   (c) POST beacon: utm claude/mcp/ai_search → claude; ai_ref chatgpt.com →
 *       chatgpt; agentplatform.no / a producer's own campaign → no AI;
 *       garbage, oversized and non-whitelisted keys dropped; a forged AI key
 *       alone → no AI; no utm/marker → stored exactly as before.
 *   (d) GET /ut/: the query the page appends attributes; the redirect target
 *       is unchanged.
 *   (e) browser snippet run in a sandbox: capture on landing, sessionStorage
 *       carry-over, /ut/ links rewritten, beacon payload; the round trip of a
 *       landing on /produsent/<slug>?utm_source=claude… stores claude.
 *   (f) the rendered rfb producer page carries the snippet, the beacon uses
 *       aiAttrInto, and a /ut/ link is there for the rewrite.
 *   (g) funnel read getProfileAiContactClicks: per-AI counts in the window,
 *       bots, other profiles and old rows left out.
 *
 * Exported runContactAiAttributionTests({log}) -> Promise<TestSummary>; wired
 * into tests/test.ts. Standalone: npx tsx src/services/contact-ai-attribution.test.ts
 */

import Database from "better-sqlite3";
import vm from "vm";
import { EventEmitter } from "events";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const HUMAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const CLAUDEBOT = "Mozilla/5.0 (compatible; ClaudeBot/1.0; +https://anthropic.com/claudebot)";
const DAY = 24 * 60 * 60 * 1000;

function parseQuery(url: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(url.split("?")[1] || "")) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

interface RouteResult { status: number; redirectedTo?: string }

function callRoute(router: any, opts: { method?: string; url: string; ua?: string; body?: any }): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { "user-agent": opts.ua ?? HUMAN };
    const req: any = {
      method: opts.method || "GET", url: opts.url, originalUrl: opts.url,
      query: parseQuery(opts.url), headers, body: opts.body, ip: "127.0.0.1", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json() { resolve({ status: this.statusCode }); return this; },
      end() { resolve({ status: this.statusCode }); return this; },
      cookie() { return this; }, setHeader() { return this; }, getHeader() { return undefined; },
      redirect(code: number, url: string) { resolve({ status: code, redirectedTo: url }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 0 }));
  });
}

/** Runs the browser snippet against a tiny fake page. */
function runSnippet(js: string, page: { search: string; referrer?: string; storage?: Map<string, string>; hrefs?: string[] }) {
  const storage = page.storage ?? new Map<string, string>();
  const links = (page.hrefs ?? []).map((h) => {
    const attrs: Record<string, string> = { href: h };
    return { getAttribute: (n: string) => attrs[n] ?? null, setAttribute: (n: string, v: string) => { attrs[n] = v; } };
  });
  const ctx = vm.createContext({
    location: { search: page.search },
    document: {
      referrer: page.referrer ?? "",
      querySelectorAll: (sel: string) => (sel === 'a[href^="/ut/"]' ? links.filter((l) => (l.getAttribute("href") || "").startsWith("/ut/")) : []),
    },
    sessionStorage: {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => { storage.set(k, String(v)); },
    },
    URL, URLSearchParams, JSON, encodeURIComponent, Object,
  });
  const out = vm.runInContext(`(function () { ${js}\n return { aiAttr: aiAttr, aiAttrInto: aiAttrInto }; })()`, ctx) as {
    aiAttr: Record<string, string>; aiAttrInto: (o: Record<string, unknown>) => Record<string, unknown>;
  };
  return {
    attr: JSON.parse(JSON.stringify(out.aiAttr)) as Record<string, string>,
    payload: (o: Record<string, unknown>) => JSON.parse(JSON.stringify(out.aiAttrInto(o))) as Record<string, unknown>,
    hrefs: links.map((l) => l.getAttribute("href")),
    storage,
  };
}

export async function runContactAiAttributionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    assertTrue(a === e, `${label} (expected ${e}, got ${a})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };
  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevExpPath = process.env.EXPERIENCES_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  const cachePaths = [
    "../database/db-factory", "../services/dental-store", "../services/experience-store",
    "../routes/seo", "../routes/contact-tracking",
  ].map((p) => require.resolve(p));
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const attr = require("./contact-ai-attribution") as typeof import("./contact-ai-attribution");

    // ── (a) schema ────────────────────────────────────────────────
    const cols = () => (db.prepare("PRAGMA table_info(contact_clicks)").all() as Array<{ name: string }>).map((c) => c.name);
    assertTrue(cols().includes("ai_source") && cols().includes("utm_source"), "(a) contact_clicks has utm_source and ai_source");
    initMod.__initSchemaForTesting(db as any);
    assertEq(cols().filter((c) => c === "ai_source").length, 1, "(a) re-init keeps one ai_source column");

    // ── (b) readContactAttribution / sanitizeAiRef ────────────────
    assertEq(attr.sanitizeAiRef("Chatgpt.com"), "chatgpt.com", "(b) ai_ref lower-cased host");
    assertEq(attr.sanitizeAiRef("https://claude.ai/chat"), null, "(b) ai_ref with scheme/path dropped");
    assertEq(attr.sanitizeAiRef("javascript:alert(1)"), null, "(b) ai_ref script dropped");
    assertEq(attr.sanitizeAiRef("a".repeat(120) + ".com"), null, "(b) ai_ref over 100 chars dropped");
    assertEq(attr.sanitizeAiRef({ host: "claude.ai" }), null, "(b) ai_ref object dropped");
    const r1 = attr.readContactAttribution({ utm_source: "x".repeat(500), utm_medium: "mcp\u0000\n", ai_source: "claude", vendor: "claude", evil: "<script>" });
    assertEq(r1.utm.utm_source?.length, 64, "(b) oversized utm_source capped at 64");
    assertEq(r1.utm.utm_medium, "mcp", "(b) control chars stripped");
    assertEq(r1.aiRef, null, "(b) non-whitelisted keys never read");
    assertEq(attr.readContactAttribution({ utm_source: "claude" }, { utm_source: "chatgpt", utm_campaign: "ai_search" }).utm,
      { utm_source: "claude", utm_medium: null, utm_campaign: "ai_search" }, "(b) first source wins per key");
    assertEq(attr.readContactAttribution(null, "str", [1]).utm.utm_source, null, "(b) non-object sources ignored");

    // ── Fixtures ──────────────────────────────────────────────────
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    db.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city, lat, lng,
        trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at
      ) VALUES ('p-1', 'Aker Gaard En', 'En beskrivelse', 'Aker Gaard En', 'p-1@example.no', 'https://p-1.example.no', 'producer', 'key-p-1',
        '["vegetables"]', '[]', '[]', '{}', '["no"]', 'Oslo', 59.91, 10.75,
        0.9, 1, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(`INSERT INTO agent_knowledge (agent_id, website, phone) VALUES ('p-1', 'https://aker-gaard.example.no', '+47 22 11 00 90')`).run();
    db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
      VALUES ('p-2', 'Annen Gård', 'x', 'x', 'p-2@example.no', 'https://p-2.example.no', 'producer', 'key-p-2', 1)`).run();
    const regMod = require("./marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    const ct = require("../routes/contact-tracking");
    const track = ct.default;
    const redirect = ct.redirectRouter;
    const lastRow = () => db.prepare("SELECT agent_id, kind, is_bot, utm_source, ai_source FROM contact_clicks ORDER BY id DESC LIMIT 1").get() as any;
    const post = (body: any, ua = HUMAN) => callRoute(track, { method: "POST", url: "/contact-click", body, ua });

    // ── (c) POST beacon ───────────────────────────────────────────
    let r = await post({ agentId: "p-1", kind: "phone", utm_source: "claude", utm_medium: "mcp", utm_campaign: "ai_search" });
    assertEq(r.status, 204, "(c) beacon with landing utm -> 204");
    assertEq(lastRow(), { agent_id: "p-1", kind: "phone", is_bot: 0, utm_source: "claude", ai_source: "claude" }, "(c) utm_source=claude landing -> ai_source claude");

    await post({ agentId: "p-1", kind: "email", ai_ref: "chatgpt.com" });
    assertEq([lastRow().utm_source, lastRow().ai_source], [null, "chatgpt"], "(c) AI referrer marker chatgpt.com -> chatgpt");
    await post({ agentId: "p-1", kind: "email", ai_ref: "www.perplexity.ai" });
    assertEq(lastRow().ai_source, "perplexity", "(c) AI referrer subdomain -> perplexity");
    await post({ agentId: "p-1", kind: "email", ai_ref: "sylteogrokt.no" });
    assertEq(lastRow().ai_source, null, "(c) non-AI host marker -> no AI");

    await post({ agentId: "p-1", kind: "phone", utm_source: "agentplatform.no", utm_medium: "referral" });
    assertEq([lastRow().utm_source, lastRow().ai_source], ["agentplatform.no", null], "(c) agentplatform.no utm kept, no AI");
    await post({ agentId: "p-1", kind: "phone", utm_source: "claudes-gard", utm_campaign: "sommer" });
    assertEq([lastRow().utm_source, lastRow().ai_source], ["claudes-gard", null], "(c) producer's own campaign -> no AI");

    await post({ agentId: "p-1", kind: "phone", ai_source: "claude", ai: "chatgpt", vendor: "gemini" });
    assertEq([lastRow().utm_source, lastRow().ai_source], [null, null], "(c) forged AI key alone -> no AI");
    await post({ agentId: "p-1", kind: "phone", utm_source: { $gt: "" }, ai_ref: "https://claude.ai/", utm_campaign: ["x".repeat(300)] });
    assertEq([lastRow().utm_source, lastRow().ai_source], [null, null], "(c) object/garbage values dropped");
    await post({ agentId: "p-1", kind: "phone", utm_source: "y".repeat(5000) });
    assertEq(lastRow().utm_source.length, 64, "(c) oversized utm_source stored capped");

    const before = (db.prepare("SELECT COUNT(*) c FROM contact_clicks").get() as any).c;
    r = await post({ agentId: "p-1", kind: "website" });
    assertEq(r.status, 204, "(c) regression: plain beacon -> 204");
    assertEq(lastRow(), { agent_id: "p-1", kind: "website", is_bot: 0, utm_source: null, ai_source: null }, "(c) regression: no utm/marker -> stored as before");
    assertEq((db.prepare("SELECT COUNT(*) c FROM contact_clicks").get() as any).c, before + 1, "(c) regression: exactly one row");
    r = await post({ agentId: "p-1", kind: "banana", utm_source: "claude" });
    assertEq(r.status, 400, "(c) regression: invalid kind still 400 with utm");

    await post({ agentId: "p-1", kind: "phone", utm_source: "claude" }, CLAUDEBOT);
    assertEq([lastRow().is_bot, lastRow().ai_source], [1, "claude"], "(c) bot click stamped is_bot=1");

    // ── (d) GET /ut/ ─────────────────────────────────────────────
    r = await callRoute(redirect, { url: "/p-1/website?utm_source=claude&utm_medium=mcp&utm_campaign=ai_search" });
    assertEq(r.status, 302, "(d) /ut/ with landing query -> 302");
    assertEq(r.redirectedTo, "https://aker-gaard.example.no/?utm_source=rettfrabonden&utm_medium=referral&utm_campaign=producer_profile", "(d) /ut/ target unchanged (landing query not forwarded)");
    assertEq([lastRow().kind, lastRow().utm_source, lastRow().ai_source], ["website", "claude", "claude"], "(d) /ut/ click stored with ai_source claude");
    await callRoute(redirect, { url: "/p-1/website?ai_ref=gemini.google.com" });
    assertEq(lastRow().ai_source, "gemini", "(d) /ut/ AI marker -> gemini");
    await callRoute(redirect, { url: "/p-1/website?ai=claude" });
    assertEq(lastRow().ai_source, null, "(d) /ut/ forged key -> no AI");

    // ── (e) browser snippet ──────────────────────────────────────
    const js = attr.aiAttributionClientJs();
    const landing = runSnippet(js, {
      search: "?utm_source=claude&utm_medium=mcp&utm_campaign=ai_search&fbclid=abc",
      hrefs: ["/ut/p-1/website", "/ut/p-1/external:facebook", "/produsent/annen", "/ut/p-1/website?x=1"],
    });
    assertEq(landing.attr, { utm_source: "claude", utm_medium: "mcp", utm_campaign: "ai_search" }, "(e) landing captures utm_* only");
    assertEq(JSON.parse(landing.storage.get(attr.AI_ATTR_STORAGE_KEY) || "null"), landing.attr, "(e) landing stored in sessionStorage");
    assertEq(landing.hrefs, [
      "/ut/p-1/website?utm_source=claude&utm_medium=mcp&utm_campaign=ai_search",
      "/ut/p-1/external:facebook?utm_source=claude&utm_medium=mcp&utm_campaign=ai_search",
      "/produsent/annen",
      "/ut/p-1/website?x=1",
    ], "(e) /ut/ links carry the landing params; other links untouched");
    const payload = landing.payload({ agentId: "p-1", kind: "email" });
    assertEq(payload, { agentId: "p-1", kind: "email", utm_source: "claude", utm_medium: "mcp", utm_campaign: "ai_search" }, "(e) beacon payload carries the landing params");
    await post(payload);
    assertEq([lastRow().kind, lastRow().ai_source], ["email", "claude"], "(e) round trip: landing on /produsent/<slug>?utm_source=claude… -> contact click stored with claude");

    const next = runSnippet(js, { search: "", storage: landing.storage, hrefs: ["/ut/p-1/website"] });
    assertEq(next.attr, landing.attr, "(e) a later page in the tab reuses the stored landing");
    assertEq(next.hrefs, ["/ut/p-1/website?utm_source=claude&utm_medium=mcp&utm_campaign=ai_search"], "(e) later page rewrites /ut/ too");

    const fromAi = runSnippet(js, { search: "", referrer: "https://chatgpt.com/c/123?q=secret", hrefs: ["/ut/p-1/website"] });
    assertEq(fromAi.attr, { ai_ref: "chatgpt.com" }, "(e) AI referrer -> host-only marker");
    assertEq(fromAi.hrefs, ["/ut/p-1/website?ai_ref=chatgpt.com"], "(e) AI marker on /ut/ link");
    r = await callRoute(redirect, { url: fromAi.hrefs[0]!.replace(/^\/ut/, "") });
    assertEq(r.status, 302, "(e) rewritten /ut/ link still redirects");
    assertEq(lastRow().ai_source, "chatgpt", "(e) round trip: AI referrer landing -> /ut/ click stored with chatgpt");

    const google = runSnippet(js, { search: "", referrer: "https://www.google.com/", hrefs: ["/ut/p-1/website"] });
    assertEq([google.attr, google.hrefs, google.storage.size], [{}, ["/ut/p-1/website"], 0], "(e) non-AI referrer, no utm -> nothing stored or added");
    assertEq(google.payload({ agentId: "p-1", kind: "phone" }), { agentId: "p-1", kind: "phone" }, "(e) beacon payload unchanged without a landing");

    const fake = runSnippet(js, { search: "", referrer: "https://claude.ai.evil.example/", hrefs: [] });
    assertEq(fake.attr, {}, "(e) look-alike host is not an AI marker");
    const junk = runSnippet(js, { search: "?utm_source=" + encodeURIComponent("a\u0000b" + "z".repeat(200)), hrefs: [] });
    assertEq(junk.attr.utm_source?.length, 64, "(e) client caps utm values at 64");
    const badStore = new Map([[attr.AI_ATTR_STORAGE_KEY, JSON.stringify({ utm_source: "claude", ai_source: "claude", evil: "x" })]]);
    assertEq(runSnippet(js, { search: "", storage: badStore }).attr, { utm_source: "claude" }, "(e) stored value re-read through the key whitelist");

    // ── (f) rendered producer page ────────────────────────────────
    {
      const seoRouter = (require("../routes/seo") as typeof import("../routes/seo")).default as any;
      const layer = (seoRouter.stack as any[]).find((l: any) => l.route && l.route.path === "/produsent/:slug" && l.route.methods?.get);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const url = "/produsent/aker-gaard-en?utm_source=claude&utm_medium=mcp&utm_campaign=ai_search";
      const page = await new Promise<{ status: number; body: string }>((resolve) => {
        const headers: Record<string, string> = { "user-agent": HUMAN };
        const req: any = {
          method: "GET", url, originalUrl: url, path: url.split("?")[0], hostname: "rettfrabonden.com",
          query: parseQuery(url), params: { slug: "aker-gaard-en" }, headers, lang: "no", ip: "198.51.100.77",
          get(h: string) { return headers[h.toLowerCase()]; },
        };
        const res: any = new EventEmitter();
        Object.assign(res, {
          statusCode: 200, locals: {},
          status(c: number) { res.statusCode = c; return res; },
          set() { return res; }, header() { return res; }, setHeader() { return res; },
          redirect() { resolve({ status: 301, body: "" }); return res; },
          send(b: unknown) { res.emit("finish"); resolve({ status: res.statusCode, body: String(b) }); return res; },
        });
        Promise.resolve(handler(req, res, () => resolve({ status: 404, body: "" }))).catch((err: any) => resolve({ status: 500, body: String(err) }));
      });
      assertEq(page.status, 200, "(f) producer page renders 200");
      assertTrue(page.body.includes(js.trim()), "(f) page includes the capture snippet");
      assertTrue(page.body.includes('"rfb_ai_attr"') && page.body.includes('a[href^="/ut/"]'), "(f) snippet stores the landing and rewrites /ut/ links");
      assertTrue(page.body.includes("JSON.stringify(aiAttrInto({ agentId: agentId, kind: kind }))"), "(f) beacon payload carries the landing params");
      assertTrue(page.body.includes('href="/ut/p-1/website"'), "(f) page has a /ut/ link for the rewrite");
      assertTrue(page.body.indexOf('href="/ut/p-1/website"') < page.body.indexOf("var aiAttr ="), "(f) snippet runs after the /ut/ links are in the DOM");
      assertTrue(page.body.includes('data-track-kind="phone"'), "(f) beacon hook still on the phone link");
    }

    // ── (g) funnel read ───────────────────────────────────────────
    {
      db.prepare("DELETE FROM contact_clicks").run();
      const ins = db.prepare("INSERT INTO contact_clicks (agent_id, kind, is_bot, ai_source, created_at) VALUES (?, ?, ?, ?, ?)");
      const now = Date.parse("2026-11-06T12:00:00Z");
      const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString().replace("T", " ").slice(0, 19);
      ins.run("p-1", "phone", 0, "claude", at(0));
      ins.run("p-1", "email", 0, "claude", at(10));
      ins.run("p-1", "website", 0, "chatgpt", at(59));
      ins.run("p-1", "phone", 0, "weird-key", at(3));
      ins.run("p-1", "phone", 0, null, at(1));
      ins.run("p-1", "phone", 1, "claude", at(1));      // bot
      ins.run("p-1", "phone", 0, "claude", at(61));     // outside 60 days
      ins.run("p-2", "phone", 0, "claude", at(1));      // other profile
      const f = attr.getProfileAiContactClicks(db as any, "p-1", now);
      assertEq(f.windowDays, 60, "(g) default window 60 days");
      assertEq(f.contactClicks, 5, "(g) human contact clicks in window");
      assertEq(f.fromAi.total, 4, "(g) AI-attributed total");
      assertEq(f.fromAi.byVendor, { chatgpt: 1, claude: 2, perplexity: 0, gemini: 0, copilot: 0, other: 1 }, "(g) per-AI counts (unknown key -> other)");
      assertEq(attr.getProfileAiContactClicks(db as any, "p-1", now, 7).fromAi.byVendor.claude, 1, "(g) shorter window");
      assertEq(attr.getProfileAiContactClicks(db as any, "nobody", now).contactClicks, 0, "(g) unknown profile -> 0");
      const bare = new Database(":memory:");
      bare.exec("CREATE TABLE contact_clicks (id INTEGER PRIMARY KEY, agent_id TEXT, kind TEXT, is_bot INTEGER, created_at TEXT)");
      assertEq(attr.getProfileAiContactClicks(bare as any, "p-1", now).fromAi.total, 0, "(g) db without ai_source -> zeros, no throw");
      bare.close();
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    try { (require("./profile-ai-clicks") as typeof import("./profile-ai-clicks")).__resetAiClicksForTesting(); } catch { /* best effort */ }
    try { (require("./profile-ai-deliveries") as typeof import("./profile-ai-deliveries")).__resetAiDeliveriesForTesting(); } catch { /* best effort */ }
    try {
      const regMod = require("./marketplace-registry");
      regMod.marketplaceRegistry._agentsCache = null;
      regMod.marketplaceRegistry._statsCache = null;
    } catch { /* best effort */ }
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExpPath;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best effort */ }
    restoreModuleCache();
    initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* already closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runContactAiAttributionTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
