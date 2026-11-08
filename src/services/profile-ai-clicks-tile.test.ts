/**
 * profile-ai-clicks-tile.test.ts — dev-request 2026-10-14-klikk-fra-ai-svar-per-profil, slice 5a
 * (public «Klikk fra AI-svar · 60d: N» tile next to «Med i AI-søk»).
 *
 * Covers:
 *   (a) pure render over a full window: «Klikk fra AI-svar · 60d: N», help
 *       text («minimum»), split per AI in the tooltip; en-GB words on the rfb
 *       pf-stat.
 *   (b) inside the first window: «siden <dato>» with clicks, «Fra <dato>» at
 *       0 (never a 0, never «60d»); 0 over a full window and no counting at
 *       all → no tile.
 *   (c) read helper getProfileAiClicksTile: 60-day window, the vertical's
 *       first day as countingSince, verticals kept apart; bots, AI fetchers
 *       and crawlers stored nothing, so they add nothing to the tile.
 *   (d) the four pages (rfb producer, dental clinic, gårdssalg provider,
 *       experience) show the tile with the right N, period and tooltip.
 *   (e) a broken read (profile_ai_clicks with the wrong shape) → the pages
 *       render 200 without the tile.
 *
 * Exported runProfileAiClicksTileTests({log}) -> Promise<TestSummary>; wired
 * into tests/test.ts. Standalone: npx tsx src/services/profile-ai-clicks-tile.test.ts
 */

import Database from "better-sqlite3";
import { EventEmitter } from "events";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const HUMAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const CHATGPT_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const DAY = 24 * 60 * 60 * 1000;

function parseQuery(url: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(url.split("?")[1] || "")) out[k] = v;
  return out;
}

/** The tile element (rfb pf-stat or the div tile) out of a page, or "". */
function tileOf(body: string): string {
  const m = body.match(/<div class="(?:pf-stat|ai-clicks-tile)" data-ai-clicks="[^"]*"[\s\S]*?<\/small><\/(?:div><\/div|span><\/div)>/);
  return m ? m[0] : "";
}

export async function runProfileAiClicksTileTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevExpPath = process.env.EXPERIENCES_DB_PATH;
  const prevMinViews = process.env.PUBLIC_STATS_MIN_VIEWS;
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  // The rfb pf-stats row is shown only above the public threshold; off here.
  process.env.PUBLIC_STATS_MIN_VIEWS = "0";
  const cachePaths = [
    "../database/db-factory", "../services/dental-store", "../services/experience-store",
    "../routes/seo", "../routes/dental-seo", "../routes/experiences-seo",
  ].map((p) => require.resolve(p));
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const tile = require("./profile-ai-clicks-tile") as typeof import("./profile-ai-clicks-tile");
    const compute = require("./profile-ai-clicks-compute") as typeof import("./profile-ai-clicks-compute");
    const svc = require("./profile-ai-clicks") as typeof import("./profile-ai-clicks");
    svc.__resetAiClicksForTesting();

    const ins = db.prepare("INSERT INTO profile_ai_clicks (vertical_id, profile_id, day, ai_vendor, count) VALUES (?, ?, ?, ?, ?)");
    const clear = () => { db.prepare("DELETE FROM profile_ai_clicks").run(); svc.__resetAiClicksForTesting(); };
    const vendors = (o: Partial<Record<string, number>>) => ({ chatgpt: 0, claude: 0, perplexity: 0, gemini: 0, copilot: 0, other: 0, ...o });
    const now = Date.UTC(2026, 10, 7, 12, 0, 0);
    const dayAgo = (n: number) => compute.utcDay(now - n * DAY);

    // ── (a) full window ────────────────────────────────────────────────
    {
      const c = { windowDays: 60, countingSince: dayAgo(100), total: 12, byVendor: vendors({ chatgpt: 5, claude: 4, gemini: 3 }) };
      const html = tile.aiClicksTileHtml(c, now);
      assertTrue(html.includes("Klikk fra AI-svar &middot; 60d: <strong data-fill=\"aiClicks\">12</strong>"), "(a) full window: «Klikk fra AI-svar · 60d: 12»");
      assertTrue(html.includes("ChatGPT 5 · Claude 4 · Gemini 3"), "(a) tooltip: split per AI, only AIs with clicks");
      assertTrue(!/Perplexity \d|Copilot \d|Annet \d/.test(html), "(a) tooltip: AIs with 0 left out");
      assertTrue(html.includes("klikket seg inn") && html.includes("Tallet er et minimum"), "(a) help text: visits from people who clicked from an AI answer, a minimum");
      assertTrue(html.includes("de siste 60 dagene"), "(a) help text names the 60-day window");
      const en = tile.aiClicksPfStatHtml(c, now, "en");
      assertTrue(en.includes(">12</strong><small>Clicks from AI answers &middot; 60d<br>"), "(a) rfb pf-stat en-GB: «Clicks from AI answers · 60d» under the number");
      assertTrue(en.includes("It is a minimum") && en.includes("ChatGPT 5 · Claude 4 · Gemini 3"), "(a) en-GB help text and split");
      assertTrue(!en.includes("data-stat="), "(a) rfb pf-stat has no data-stat (not hidden waiting for the page script)");
    }

    // ── (b) younger than the window; 0 ─────────────────────────────────
    {
      const since = dayAgo(10);
      const sinceNb = new Date(Date.parse(since + "T00:00:00Z")).toLocaleDateString("nb-NO", { day: "numeric", month: "short", timeZone: "UTC" });
      const sinceEn = new Date(Date.parse(since + "T00:00:00Z")).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
      const some = tile.aiClicksTileHtml({ windowDays: 60, countingSince: since, total: 3, byVendor: vendors({ claude: 3 }) }, now);
      assertTrue(some.includes(`Klikk fra AI-svar &middot; siden ${sinceNb}: <strong data-fill="aiClicks">3</strong>`), `(b) inside the first window: «siden ${sinceNb}: 3»`);
      assertTrue(!some.includes("60d"), "(b) inside the first window: never «60d»");
      const zero = tile.aiClicksTileHtml({ windowDays: 60, countingSince: since, total: 0, byVendor: vendors({}) }, now);
      assertTrue(zero.includes(`<strong data-fill="aiClicks">Fra ${sinceNb}</strong>`), `(b) 0 inside the first window: «Fra ${sinceNb}» instead of the number`);
      assertTrue(!/>0</.test(zero) && !zero.includes("60d"), "(b) 0 inside the first window: no 0 and no «60d»");
      const zeroEn = tile.aiClicksPfStatHtml({ windowDays: 60, countingSince: since, total: 0, byVendor: vendors({}) }, now, "en");
      assertTrue(zeroEn.includes(`>From ${sinceEn}</strong>`), `(b) en-GB at 0: «From ${sinceEn}»`);
      assertEq(tile.aiClicksTileHtml({ windowDays: 60, countingSince: dayAgo(100), total: 0, byVendor: vendors({}) }, now), "", "(b) 0 over a full window → no tile (never a 0)");
      assertEq(tile.aiClicksTileHtml({ windowDays: 60, countingSince: null, total: 0, byVendor: vendors({}) }, now), "", "(b) no counting for the vertical → no tile");
      assertEq(tile.aiClicksTileHtml(null, now), "", "(b) nothing read → no tile");
      // Edge: exactly one window old → «60d».
      assertTrue(tile.aiClicksTileHtml({ windowDays: 60, countingSince: dayAgo(59), total: 1, byVendor: vendors({ other: 1 }) }, now).includes("&middot; 60d:"), "(b) first day = the window's first day → «60d»");
      assertTrue(tile.aiClicksTileHtml({ windowDays: 60, countingSince: dayAgo(58), total: 1, byVendor: vendors({ other: 1 }) }, now).includes("&middot; siden "), "(b) one day short of a window → «siden <dato>»");
    }

    // ── (c) read helper ────────────────────────────────────────────────
    {
      clear();
      ins.run("rfb", "first", dayAgo(80), "chatgpt", 1);   // the vertical's first day
      ins.run("rfb", "a", dayAgo(0), "chatgpt", 3);
      ins.run("rfb", "a", dayAgo(59), "claude", 2);        // last day inside
      ins.run("rfb", "a", dayAgo(60), "gemini", 7);        // just outside
      ins.run("dental", "a", dayAgo(0), "copilot", 100);   // another vertical
      const t = compute.getProfileAiClicksTile(db as any, "rfb", "a", now);
      assertEq(t.total, 5, "(c) 60-day window only, the profile's own vertical only");
      assertEq(`${t.byVendor.chatgpt},${t.byVendor.claude},${t.byVendor.gemini},${t.byVendor.copilot}`, "3,2,0,0", "(c) byVendor over the window");
      assertEq(t.countingSince, dayAgo(80), "(c) countingSince = the vertical's first stored day, not the profile's");
      assertEq(compute.getProfileAiClicksTile(db as any, "dental", "nobody", now).countingSince, dayAgo(0), "(c) countingSince per vertical");
      const emptyDb = new Database(":memory:");
      assertEq(compute.getProfileAiClicksTile(emptyDb as any, "rfb", "a", now).countingSince, null, "(c) no table → no counting");
      emptyDb.close();

      // Bots / AI fetchers through the real counting: nothing stored, so nothing on the tile.
      let ip = 0;
      for (const ua of [GPTBOT, GOOGLEBOT, CHATGPT_USER, "curl/8.5.0"]) {
        const headers: Record<string, string> = { "user-agent": ua, referer: "https://chatgpt.com/" };
        const req: any = { method: "GET", url: "/produsent/x?utm_source=claude", path: "/produsent/x", headers, query: { utm_source: "claude" }, ip: `192.0.2.${++ip}`, get(h: string) { return headers[h.toLowerCase()]; } };
        const res: any = Object.assign(new EventEmitter(), { statusCode: 200, locals: {} });
        svc.recordAiProfileClick(req, res, "bot-target", "rfb");
        res.emit("finish");
      }
      svc.flushAiClicks(db as any);
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM profile_ai_clicks WHERE profile_id = 'bot-target'").get() as { n: number }).n, 0, "(c) GPTBot / Googlebot / ChatGPT-User / curl from an AI answer stored no click rows");
      assertEq(compute.getProfileAiClicksTile(db as any, "rfb", "bot-target", Date.now()).total, 0, "(c) so the tile reads 0 for them");
      const headers: Record<string, string> = { "user-agent": HUMAN, referer: "https://chatgpt.com/" };
      const req: any = { method: "GET", url: "/produsent/x", path: "/produsent/x", headers, query: {}, ip: "192.0.2.99", get(h: string) { return headers[h.toLowerCase()]; } };
      const res: any = Object.assign(new EventEmitter(), { statusCode: 200, locals: {} });
      svc.recordAiProfileClick(req, res, "human-only", "rfb");
      res.emit("finish");
      svc.flushAiClicks(db as any);
      assertEq(compute.getProfileAiClicksTile(db as any, "rfb", "human-only", Date.now()).total, 1, "(c) a person from ChatGPT is counted and read back as 1");
      clear();
    }

    // ── (d) the four pages ─────────────────────────────────────────────
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
    const regMod = require("./marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const dentalDb = dbFactory.getDb("dental");
    const expDb = dbFactory.getDb("experiences");
    const dentalStore = require("./dental-store") as typeof import("./dental-store");
    const expStore = require("./experience-store") as typeof import("./experience-store");

    function makeReqRes(url: string, resolve: (v: { status: number; body: string }) => void) {
      const headers: Record<string, string> = { "user-agent": HUMAN };
      const req: any = {
        method: "GET", url, originalUrl: url, path: url.split("?")[0], hostname: "example.test",
        query: parseQuery(url), params: {}, headers, lang: "no", ip: "203.0.113.7",
        get(h: string) { return headers[h.toLowerCase()]; },
      };
      const res: any = new EventEmitter();
      Object.assign(res, {
        statusCode: 200, locals: {},
        status(c: number) { res.statusCode = c; return res; },
        set() { return res; }, header() { return res; }, setHeader() { return res; },
        redirect() { res.statusCode = 301; res.emit("finish"); resolve({ status: 301, body: "" }); return res; },
        send(b: unknown) { res.emit("finish"); resolve({ status: res.statusCode, body: String(b) }); return res; },
      });
      return { req, res };
    }
    function invoke(router: any, url: string): Promise<{ status: number; body: string }> {
      return new Promise((resolve) => {
        const { req, res } = makeReqRes(url, resolve);
        router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: err ? String(err) : "" }));
      });
    }
    const seoRouter = (require("../routes/seo") as typeof import("../routes/seo")).default as any;
    function invokeSeo(url: string, slug: string): Promise<{ status: number; body: string }> {
      return new Promise((resolve) => {
        const layer = (seoRouter.stack as any[]).find((l: any) => l.route && l.route.path === "/produsent/:slug" && l.route.methods?.get);
        const handler = layer.route.stack[layer.route.stack.length - 1].handle;
        const { req, res } = makeReqRes(url, resolve);
        req.params = { slug };
        req.hostname = "rettfrabonden.com";
        Promise.resolve(handler(req, res, () => resolve({ status: 404, body: "" }))).catch((err: any) => resolve({ status: 500, body: String(err) }));
      });
    }

    const clinicId = dentalStore.createDentalAgent({
      navn: "Sentrum Tannklinikk AS", org_nr: "918800190", poststed: "OSLO", fylke: "Oslo",
      adresse: "Storgata 1", telefon: "22110090", hjemmeside: "https://klinikk.example.no",
    } as any);
    dentalDb.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(clinicId);
    expDb.prepare(
      `INSERT INTO experience_providers
         (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
          geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
       VALUES ('gs-fossmoen', 'Fossmoen Frukt', 'experiences', 'Telemark', 'Skien', 'Skien', 'cideri', NULL, NULL, 59.21, 9.61,
          'high', 'fossmoen-frukt', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
    ).run();
    const expProvider = expStore.createProvider({
      navn: "Nordlys Opplevelser AS", fylke: "Troms og Finnmark", kommune: "Tromsø",
      brreg_verified: 1, brreg_active: 1, verification_status: "verified",
    });
    const expId = expStore.createExperience({
      title: "Hvalsafari i Tromsø", provider_id: expProvider,
      provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
      verification_status: "verified", confidence: "high",
    });
    const expSlug = (expDb.prepare("SELECT slug FROM experiences WHERE id = ?").get(expId) as { slug: string }).slug;
    const dentalRouter = (require("../routes/dental-seo") as typeof import("../routes/dental-seo")).default as any;
    const expRouter = (require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any;

    const realNow = Date.now();
    const realAgo = (n: number) => compute.utcDay(realNow - n * DAY);
    const fmtNb = (day: string) => new Date(Date.parse(day + "T00:00:00Z")).toLocaleDateString("nb-NO", { day: "numeric", month: "short", timeZone: "UTC" });
    const renderAll = async () => ({
      rfb: await invokeSeo("/produsent/aker-gaard-en", "aker-gaard-en"),
      dental: await invoke(dentalRouter, `/klinikk/id/${clinicId}`),
      gs: await invoke(expRouter, "/kategori/gardssalg/produsent/fossmoen-frukt"),
      exp: await invoke(expRouter, `/opplevelse/${expSlug}`),
    });

    {
      clear();
      // rfb: counting older than the window → «60d».
      ins.run("rfb", "p-1", realAgo(1), "chatgpt", 4);
      ins.run("rfb", "p-1", realAgo(2), "perplexity", 2);
      ins.run("rfb", "p-1", realAgo(70), "claude", 50);   // outside the window
      // dental: counting started 10 days ago → «siden <dato>».
      ins.run("dental", clinicId, realAgo(10), "claude", 3);
      // experiences: counting started 5 days ago; the gårdssalg provider has clicks, the experience 0 → «Fra <dato>».
      ins.run("experiences", "gs-fossmoen", realAgo(5), "copilot", 2);
      ins.run("experiences", "gs-fossmoen", realAgo(1), "gemini", 1);
      ins.run("experiences", "someone-else", realAgo(3), "chatgpt", 9);
      const pages = await renderAll();

      assertEq(pages.rfb.status, 200, "(d) rfb producer page renders 200");
      const rfbTile = tileOf(pages.rfb.body);
      assertTrue(rfbTile.includes(">6</strong><small>Klikk fra AI-svar &middot; 60d<br>"), "(d) rfb producer page: «Klikk fra AI-svar · 60d» with N = 6 (the 70-day-old row left out)");
      assertTrue(rfbTile.includes("ChatGPT 4 · Perplexity 2"), "(d) rfb producer page: split per AI in the tooltip");
      const del = pages.rfb.body.indexOf('data-stat="aiDeliveries"');
      const clk = pages.rfb.body.indexOf("data-ai-clicks=");
      assertTrue(del > 0 && clk > del && clk - del < 3000, "(d) rfb producer page: the tile sits right after «Med i AI-søk»");

      assertEq(pages.dental.status, 200, "(d) dental clinic page renders 200");
      const dTile = tileOf(pages.dental.body);
      assertTrue(dTile.includes(`Klikk fra AI-svar &middot; siden ${fmtNb(realAgo(10))}: <strong data-fill="aiClicks">3</strong>`), "(d) dental clinic page: «siden <dato>: 3» inside the first window");
      assertTrue(dTile.includes("Claude 3") && !dTile.includes("60d"), "(d) dental clinic page: tooltip split, no «60d»");

      assertEq(pages.gs.status, 200, "(d) gårdssalg provider page renders 200");
      const gTile = tileOf(pages.gs.body);
      assertTrue(gTile.includes(`siden ${fmtNb(realAgo(5))}: <strong data-fill="aiClicks">3</strong>`), "(d) gårdssalg provider page: N = 3 since the vertical's first day");
      assertTrue(gTile.includes("Gemini 1 · Copilot 2"), "(d) gårdssalg provider page: split per AI");

      assertEq(pages.exp.status, 200, "(d) experience page renders 200");
      const eTile = tileOf(pages.exp.body);
      assertTrue(eTile.includes(`<strong data-fill="aiClicks">Fra ${fmtNb(realAgo(5))}</strong>`), "(d) experience page at 0: «Fra <dato>» (the vertical's first day), never 0");
      assertTrue(!eTile.includes("ChatGPT 9"), "(d) experience page: another profile's clicks not counted");
    }

    // ── (e) a broken read leaves the tile out ──────────────────────────
    {
      db.exec("DROP TABLE profile_ai_clicks; CREATE TABLE profile_ai_clicks (vertical_id TEXT, broken TEXT)");
      assertEq(tile.aiClicksTileFor("dental", clinicId), "", "(e) aiClicksTileFor: read error → \"\"");
      assertEq(tile.aiClicksPfStatFor("p-1"), "", "(e) aiClicksPfStatFor: read error → \"\"");
      const pages = await renderAll();
      for (const [name, r] of Object.entries(pages)) {
        assertEq(r.status, 200, `(e) ${name} page still renders 200 on a read error`);
        assertTrue(!r.body.includes("data-ai-clicks=") && !r.body.includes('data-fill="aiClicks"'), `(e) ${name} page: no tile on a read error`);
      }
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
    if (prevMinViews === undefined) delete process.env.PUBLIC_STATS_MIN_VIEWS; else process.env.PUBLIC_STATS_MIN_VIEWS = prevMinViews;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best effort */ }
    restoreModuleCache();
    initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* already closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runProfileAiClicksTileTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
