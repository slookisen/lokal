/**
 * rfb-produsentmodal-apningstider-escaping.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-I (FUNN
 * rfb-app-modal-apningstider-og-escaping).
 *
 * On main (19e4d2e2) the producer modal on /app (app.html) and /dashboard
 * (dashboard.html) read the raw knowledge.openingHours with a day table of
 * its own, so {day, hours}, {day, from, to}, Norwegian day names, ranges and
 * notes showed as "undefined – undefined" or as the stored key, and text hours
 * threw the rich modal away; the /agent page (agent.html) said "Stengt" for
 * every entry without open/close. The modal also put every knowledge value
 * into innerHTML unescaped, and made any website a link (javascript: too).
 * Now GET /api/marketplace/agents/:id/info has an additive
 * `openingHoursDisplay` (rows from the shared normalizer, the same text as the
 * hours card on /produsent/:slug), the three pages read it, and the modal
 * escapes every API value with a local esc().
 *
 * Covers, on the real /info and /produsent/:slug handlers with an in-memory
 * DB and the pages' own inline scripts run in a vm with a small fake DOM:
 *   (a) /info: the new field is there for every stored form, after every
 *       existing field, and absent without hours; the existing fields are
 *       byte-identical to knowledgeService.getAgentInfo, which itself has no
 *       new field (lokal_info and the RFB MCP contract are unchanged).
 *   (b) the modal on app and dashboard and the /agent page show the same
 *       hours rows as /produsent/:slug, for long day names, {day, hours},
 *       {day, from, to}, periods, notes and the declared form; the declared
 *       form gives exactly the HTML the modal gave before.
 *   (c) a knowledge value "<img src=x onerror=…>" (and attribute break-outs)
 *       is text on all three pages: only the pages' own tags, no on*
 *       attribute, no foreign href; also the header badges and the basic
 *       modal (fetch failed).
 *   (d) a javascript:, data: or bare-host website is no link in the modal;
 *       an http(s) one still is; dashboard's external links follow the same
 *       rule; agent.html never produces a javascript: href.
 *   (e) without openingHoursDisplay no hours are shown, and wrong-typed
 *       values never show "[object Object]", "undefined", "NaN" or
 *       "Invalid Date".
 *   (f) source: the pages' own day tables are gone and none of them reads
 *       knowledge.openingHours for display.
 *
 * Exported runRfbProdusentmodalApningstiderEscapingTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-produsentmodal-apningstider-escaping.test.ts
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { decode, visibleText, startTags, injectionProblems, junk, inlineScript } from "../../tests/helpers/html-injection";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const XSS = "<img src=x onerror=alert(1)>";
const BREAK_DQ = "\"><svg onload=alert(2)>";
const BREAK_SQ = "' onmouseover='alert(3)";

// ─── HTML helpers (the shared ones: tests/helpers/html-injection.ts) ───

/** [day, time] per row of the modal's hours section, as text. */
function modalHourRows(html: string): string[][] {
  return [...html.matchAll(/<span class="modal-hours-day">([^<]*)<\/span><span class="modal-hours-time">([^<]*)<\/span>/g)]
    .map((m) => [decode(m[1]!), decode(m[2]!)]);
}

/** [day, time] per row of the /agent page's hours table, the note column after the time in brackets (as on the producer page). */
function agentPageHourRows(html: string): string[][] {
  const table = /<table class="hours-table">([\s\S]*?)<\/table>/.exec(html)?.[1] ?? "";
  return [...table.matchAll(/<tr><td>([^<]*)<\/td><td>([^<]*)<\/td><td[^>]*>([^<]*)<\/td><\/tr>/g)]
    .map((m) => [decode(m[1]!), decode(m[3]!) ? `${decode(m[2]!)} (${decode(m[3]!)})` : decode(m[2]!)]);
}

/** [day, time] per row of the hours card on /produsent/:slug, without the "today" badge. */
function producerPageHourRows(body: string): string[][] {
  const grid = /<div class="hrs-grid">(.*)<\/div><\/div>\n/.exec(body)?.[1] ?? "";
  const plain = grid.replace(/<span class="hrs-open"><span class="hrs-dot"><\/span> [^<]*<\/span>/g, "");
  return [...plain.matchAll(/<div class="hrs-day[^"]*">([^<]*)<\/div><div class="hrs-time[^"]*">([^<]*)<\/div>/g)]
    .map((m) => [decode(m[1]!), decode(m[2]!)]);
}

// ─── The pages' inline scripts in a vm ─────────────────────────────────

interface FakeElement {
  id: string;
  innerHTML: string;
  textContent: string;
  [key: string]: unknown;
}

function fakeElement(id: string): FakeElement {
  return {
    id, innerHTML: "", textContent: "", value: "", style: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [], appendChild() {}, focus() {},
  };
}

type FetchStub = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface PageSandbox {
  context: vm.Context;
  el(id: string): FakeElement;
}

/** Runs a page script with a fake DOM. `fetch` answers the page's requests. */
function runPage(script: string, fetchStub: FetchStub, location: { pathname: string } = { pathname: "/app" }): PageSandbox {
  const elements = new Map<string, FakeElement>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id)!;
  };
  const document = {
    readyState: "complete", title: "",
    getElementById: el,
    querySelector: () => fakeElement("q"), querySelectorAll: () => [],
    addEventListener() {}, createElement: () => fakeElement("new"),
    body: fakeElement("body"), head: fakeElement("head"),
  };
  const context: Record<string, unknown> = {
    document, fetch: fetchStub,
    location: { ...location, href: `https://rettfrabonden.com${location.pathname}`, hostname: "rettfrabonden.com", search: "" },
    navigator: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { log() {}, error() {}, warn() {} },
    setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, open() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(script, context);
  return { context, el };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

export async function runRfbProdusentmodalApningstiderEscapingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");
  const { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } = require("../services/geocoding-service") as
    typeof import("../services/geocoding-service");
  const prevDb = __peekDbForTesting();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  const origLog = console.log;
  const origError = console.error;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
    __clearGeocodeCacheForTesting();
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }

    // ══ fixture ══════════════════════════════════════════════════════════
    interface Seed {
      id: string; name: string; city?: string; description?: string; hours: unknown;
      knowledge?: Record<string, unknown>;
    }
    function seed(row: Seed): void {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
          '["vegetables"]', '[]', '[]', '{}', '["no"]', ?, 59.91, 10.75,
          0.5, 1, 1, 0, 0, 0, 0, '2026-08-01 10:00:00', '2026-08-01 10:00:00')`,
      ).run(row.id, row.name, row.description ?? "Lokal produsent med gardsutsalg og mye godt.", row.name,
        `${row.id}@example.no`, "https://example.no", `key-${row.id}`, row.city ?? "Oslo");
      const k = row.knowledge ?? {};
      const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
      testDb.prepare(
        `INSERT INTO agent_knowledge (agent_id, updated_at, created_at, enrichment_status, products, opening_hours,
          about, address, postal_code, website, phone, email, specialties, certifications, payment_methods, delivery_options)
         VALUES (?, '2026-08-01 10:00:00', '2026-08-01 10:00:00', 'enriched', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id, json(k.products ?? [{ name: "Poteter", category: "vegetables" }]), json(row.hours),
        (k.about as string) ?? null, (k.address as string) ?? null, (k.postalCode as string) ?? null,
        (k.website as string) ?? null, (k.phone as string) ?? null, (k.email as string) ?? null,
        json(k.specialties), json(k.certifications), json(k.paymentMethods), json(k.deliveryOptions),
      );
    }
    const S = {
      // The declared form: the modal's HTML for it is the same as before.
      plain: { id: "ii-plain", name: "Petter Plain", slug: "petter-plain", hours: [
        { day: "mon", open: "10:00", close: "17:00" }, { day: "sat", open: "10:00", close: "14:00", note: "Kun sommer" },
      ] },
      // Long English and Norwegian day names and ranges (I-H: 43 of 160 sampled producers).
      long: { id: "ii-long", name: "Lise Langnavn", slug: "lise-langnavn", hours: [
        { day: "monday", open: "10:00", close: "17:00" }, { day: "Lørdag", open: "10:00", close: "14:00", note: "Kun i sesong" },
        { day: "mon-fri", open: "08:00", close: "16:00" }, { day: "Tysdag-Onsdag", open: "12:00", close: "18:00" },
      ] },
      // {day, hours} with a closed day (Røtter Frogner, Sognasmak).
      hours: { id: "ii-hours", name: "Hanne Timer", slug: "hanne-timer", hours: [
        { day: "Mandag", hours: "Stengt" }, { day: "Tysdag-Onsdag", hours: "10:00-16:00" }, { day: "Lørdag", hours: "11:00-18:00" },
      ] },
      // {day, from, to}, a period, notes and {note} with HTML in it.
      mixed: { id: "ii-mixed", name: "Mia Miks", slug: "mia-miks", hours: [
        { day: "Påske", from: "12:00", to: "18:00" }, { period: "April", days: "Torsdag–Fredag", open: "12:00", close: "16:00" },
        { day: "by-appointment", note: "Åpent etter avtale" }, { day: "sun", open: "closed", close: "closed" },
        { note: "Selvbetjent <bod> & kjøleskap" },
      ] },
      // Free text for the whole field, not all in the day-and-time form (slice
      // I-O reads that form into day rows; see rfb-apningstider-sesong-tekstform.test.ts).
      text: { id: "ii-text", name: "Tore Tekst", slug: "tore-tekst", hours: "Man–fre 10–17, lør etter avtale" },
      // No opening hours.
      none: { id: "ii-none", name: "Nils Ingen", slug: "nils-ingen", hours: null },
    };
    for (const s of Object.values(S)) seed({ ...s, knowledge: { address: "Gata 1", postalCode: "0150", website: "https://example.no", phone: "91234567", email: "post@example.no" } });
    seed({
      id: "ii-xss", name: "Xavier Xss", description: XSS, hours: [{ day: XSS, open: "10:00", close: "17:00", note: XSS }, { note: BREAK_DQ }],
      knowledge: {
        about: XSS, address: XSS, postalCode: BREAK_DQ, website: XSS, phone: "91234567", email: `post@example.no${BREAK_DQ}`,
        products: [{ name: XSS, category: XSS, seasonal: true, months: [XSS, 6] }, BREAK_SQ],
        specialties: [XSS], certifications: [BREAK_DQ], paymentMethods: [BREAK_SQ], deliveryOptions: [XSS],
      },
    });
    seed({ id: "ii-js", name: "Jon Javascript", hours: null, knowledge: { website: "javascript:alert(document.cookie)", address: "Gata 2" } });

    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    // ══ the real handlers ════════════════════════════════════════════════
    delete require.cache[require.resolve("./marketplace")];
    const marketplace = require("./marketplace") as typeof import("./marketplace");
    const mRouter = marketplace.default as any;
    const infoLayer = (mRouter.stack as any[]).find((l: any) => l.route && l.route.path === "/agents/:id/info" && l.route.methods?.get);
    if (!infoLayer) throw new Error("GET /agents/:id/info is not registered");
    const infoHandler = infoLayer.route.stack[infoLayer.route.stack.length - 1].handle;
    function info(id: string): { status: number; body: any } {
      const res: any = { statusCode: 200, body: undefined };
      res.status = (c: number) => { res.statusCode = c; return res; };
      res.json = (b: unknown) => { res.body = b; return res; };
      infoHandler({ params: { id }, headers: {}, ip: "127.0.0.1" }, res);
      return { status: res.statusCode, body: JSON.parse(JSON.stringify(res.body)) };
    }

    delete require.cache[require.resolve("./seo")];
    const seo = require("./seo") as typeof import("./seo");
    const sRouter = seo.default as any;
    const producerLayer = (sRouter.stack as any[]).find((l: any) => l.route && l.route.path === "/produsent/:slug" && l.route.methods?.get);
    if (!producerLayer) throw new Error("GET /produsent/:slug is not registered");
    const producerHandler = producerLayer.route.stack[producerLayer.route.stack.length - 1].handle;
    function producerPage(slug: string): { status: number; body: string } {
      let status = 200;
      let body = "";
      const res: any = {
        status: (c: number) => { status = c; return res; },
        send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
        redirect: () => { status = 301; return res; },
        setHeader: () => res, set: () => res, locals: {},
      };
      console.log = () => {};
      console.error = () => {};
      try { producerHandler({ params: { slug }, lang: "no", ip: "127.0.0.1", headers: {}, get: () => undefined, query: {} }, res, () => { status = -1; }); }
      finally { console.log = origLog; console.error = origError; }
      return { status, body };
    }

    const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");

    // ══ (a) GET /agents/:id/info ═════════════════════════════════════════
    for (const s of [...Object.values(S), { id: "ii-xss" }, { id: "ii-js" }]) {
      const r = info(s.id);
      const direct = knowledgeService.getAgentInfo(s.id);
      assertEq(r.status, 200, `a ${s.id}: 200`);
      const { openingHoursDisplay, ...rest } = r.body.data as Record<string, unknown>;
      assertEq(rest, direct, `a ${s.id}: every existing field is byte-identical to knowledgeService.getAgentInfo (same keys, order and values)`);
      assertTrue(!("openingHoursDisplay" in (direct as object)), `a ${s.id}: getAgentInfo itself has no openingHoursDisplay (lokal_info unchanged)`);
      if (s.id === "ii-none" || s.id === "ii-js") {
        assertTrue(!("openingHoursDisplay" in r.body.data), `a ${s.id}: no opening hours -> the key is absent (not [] or null)`);
      } else {
        assertEq(Object.keys(r.body.data), ["agent", "knowledge", "meta", "openingHoursDisplay"], `a ${s.id}: openingHoursDisplay comes after every existing field`);
        const rows = openingHoursDisplay as Array<Record<string, unknown>>;
        assertTrue(Array.isArray(rows) && rows.length > 0 && rows.every((row) =>
          JSON.stringify(Object.keys(row)) === JSON.stringify(["days", "hours", "note"]) && Object.values(row).every((v) => typeof v === "string")),
          `a ${s.id}: each row is {days, hours, note}, all text`);
      }
    }
    assertEq(info(S.hours.id).body.data.openingHoursDisplay, [
      { days: "Mandag", hours: "", note: "Stengt" },
      { days: "Tirsdag–Onsdag", hours: "10:00 – 16:00", note: "" },
      { days: "Lørdag", hours: "11:00 – 18:00", note: "" },
    ], "a {day, hours}: the rows (main: the modal showed \"Mandag undefined – undefined\")");
    assertEq(info(S.mixed.id).body.data.openingHoursDisplay, [
      { days: "Påske", hours: "12:00 – 18:00", note: "" },
      { days: "Torsdag–Fredag", hours: "12:00 – 16:00", note: "April" },
      { days: "", hours: "", note: "Åpent etter avtale" },
      { days: "Søndag", hours: "", note: "Stengt" },
      { days: "", hours: "", note: "Selvbetjent <bod> & kjøleskap" },
    ], "a mixed forms: from/to, a period, a marker day, \"closed\" and {note}, as text (escaping is the page's job)");
    assertEq(info(S.text.id).body.data.openingHoursDisplay, [{ days: "", hours: "", note: "Man–fre 10–17, lør etter avtale" }],
      "a free text: one text row");
    assertEq(info(S.text.id).body.data.knowledge.openingHours, "Man–fre 10–17, lør etter avtale",
      "a free text: knowledge.openingHours stays as stored (selger.html edits it)");
    assertEq(info("ii-missing").status, 404, "a unknown id: still 404");
    for (const value of [undefined, null, 7, {}, { day: "mon", open: "10:00", close: "17:00" }, "", "   "]) {
      assertEq(marketplace.openingHoursDisplayRows(value), [], `a openingHoursDisplayRows(${JSON.stringify(value)}) is []`);
    }

    // ══ the pages, fed by the real /info handler ═════════════════════════
    const appScript = inlineScript("app.html", "function renderModalContent");
    const dashScript = inlineScript("dashboard.html", "function renderModalContent");
    const agentScript = inlineScript("agent.html", "function render(data)");
    const routeFetch: FetchStub = async (url: string) => {
      const m = /^\/api\/marketplace\/agents\/([^/]+)\/info$/.exec(url);
      if (m) {
        const r = info(decodeURIComponent(m[1]!));
        return jsonResponse(r.body, r.status);
      }
      if (url === "/api/marketplace/agents") return jsonResponse({ agents: [] });
      return jsonResponse({});
    };
    const listAgent = (id: string, extra: Record<string, unknown> = {}) => ({
      id, name: "Produsent", role: "producer", categories: ["vegetables"], skills: [], isVerified: false, isClaimed: false,
      location: { city: "Oslo" }, ...extra,
    });
    /** The modal of a list agent on a page (app or dashboard): its header badges and body. */
    async function modal(script: string, agent: Record<string, unknown>, fetchStub: FetchStub = routeFetch): Promise<{ badges: string; body: string }> {
      const page = runPage(script, fetchStub);
      (page.context as any).allAgents = [agent];
      await (page.context as any).openAgentModal(agent.id);
      return { badges: page.el("modalBadges").innerHTML, body: page.el("modalBody").innerHTML };
    }
    /** A modal body rendered from crafted /info data, without the route. */
    async function modalFromData(script: string, agent: Record<string, unknown>, data: unknown): Promise<string> {
      return (await modal(script, agent, async () => jsonResponse({ success: true, data }))).body;
    }
    async function agentPage(id: string, fetchStub: FetchStub = routeFetch): Promise<string> {
      const page = runPage(agentScript, fetchStub, { pathname: `/agent/${id}` });
      await settle();
      return page.el("app").innerHTML;
    }
    const pages: Array<[string, string]> = [["app", appScript], ["dashboard", dashScript]];

    // ══ (b) the same hours as /produsent/:slug ═══════════════════════════
    for (const s of [S.plain, S.long, S.hours, S.mixed]) {
      const page = producerPage(s.slug);
      assertEq(page.status, 200, `b ${s.slug}: /produsent/:slug 200`);
      const expected = producerPageHourRows(page.body);
      assertTrue(expected.length > 0, `b ${s.slug}: the producer page has an hours card (${expected.length} rows)`);
      for (const [name, script] of pages) {
        const { body } = await modal(script, listAgent(s.id));
        assertEq(modalHourRows(body), expected, `b ${s.slug} ${name}: the modal shows the producer page's rows`);
      }
      assertEq(agentPageHourRows(await agentPage(s.id)), expected, `b ${s.slug} agent.html: the /agent page shows the producer page's rows`);
    }
    for (const [name, script] of pages) {
      const { body } = await modal(script, listAgent(S.plain.id));
      assertTrue(body.includes(
        "<div class=\"modal-section-title\">Åpningstider</div><div class=\"modal-hours\">" +
        "<span class=\"modal-hours-day\">Mandag</span><span class=\"modal-hours-time\">10:00 – 17:00</span>" +
        "<span class=\"modal-hours-day\">Lørdag</span><span class=\"modal-hours-time\">10:00 – 14:00 (Kun sommer)</span></div>"),
        `b declared form ${name}: the hours HTML is byte-identical to the modal before I-I`);
      assertTrue(body.includes(
        "<div class=\"modal-contact-item\">Gata 1, 0150</div>" +
        "<div class=\"modal-contact-item\">Tlf: <a href=\"tel:91234567\">91234567</a></div>" +
        "<div class=\"modal-contact-item\">E-post: <a href=\"mailto:post@example.no\">post@example.no</a></div>" +
        "<div class=\"modal-contact-item\">Nett: <a href=\"https://example.no\" target=\"_blank\" rel=\"noopener\">https://example.no</a></div>"),
        `b declared form ${name}: the contact HTML is byte-identical to the modal before I-I`);
      const text = await modal(script, listAgent(S.text.id));
      assertEq(modalHourRows(text.body), [["", "Man–fre 10–17, lør etter avtale"]],
        `b free text ${name}: the text is shown (main: .forEach on text threw, and the basic modal replaced the rich one)`);
      assertTrue(text.body.includes("Produkter"), `b free text ${name}: the rich modal is rendered`);
    }
    assertEq(agentPageHourRows(await agentPage(S.text.id)), [["", "Man–fre 10–17, lør etter avtale"]], "b free text agent.html: the text is shown");
    {
      // Well-formed values: the whole modal is the HTML main (19e4d2e2) gave
      // for the same producer, header badges included (main read the hours
      // from knowledge.openingHours; these display rows are what /info now
      // sends for them).
      const wellFormedAgent = listAgent("wf", { name: "Gård Ås", categories: ["vegetables", "honey"], skills: ["sell-products", { name: "Bestilling" }], isVerified: true });
      const wellFormed = {
        agent: {}, meta: { dataSource: "owner" },
        knowledge: {
          address: "Gata 1", postalCode: "0150", website: "https://gard.no/", phone: "91234567", email: "post@gard.no",
          openingHours: [{ day: "mon", open: "10:00", close: "17:00" }, { day: "sat", open: "10:00", close: "14:00", note: "Sommer" }],
          products: [{ name: "Poteter", category: "vegetables" }, { name: "Jordbær", category: "berries", seasonal: true, months: [6, 7, 8], organic: true }],
          about: "Om gården vår, siden 1890.", certifications: ["Debio"], paymentMethods: ["Vipps"], deliveryOptions: ["Henting"], specialties: [],
        },
        openingHoursDisplay: marketplace.openingHoursDisplayRows([{ day: "mon", open: "10:00", close: "17:00" }, { day: "sat", open: "10:00", close: "14:00", note: "Sommer" }]),
      };
      const section = (title: string, inner: string) => `<div class="modal-section"><div class="modal-section-title">${title}</div>${inner}</div>`;
      const expectedBadges = "<span class=\"modal-badge verified\">&#10003; Verifisert av eier</span><span class=\"modal-badge\">producer</span>" +
        "<span class=\"modal-badge\">Grønnsaker</span><span class=\"modal-badge\">Honning</span>";
      const expectedBody = [
        section("Om", "<div class=\"modal-about\">Om gården vår, siden 1890.</div>"),
        section("Produkter", "<div class=\"modal-products-list\">" +
          "<div class=\"modal-product\"><span class=\"modal-product-name\">Poteter <span class=\"category-tag\">Grønnsaker</span></span><span class=\"modal-product-meta\"></span></div>" +
          "<div class=\"modal-product\"><span class=\"modal-product-name\">Jordbær <span class=\"category-tag\">Bær</span></span><span class=\"modal-product-meta\">Jun-Jul-Aug <span class=\"organic-badge\">Økologisk</span></span></div></div>"),
        section("Åpningstider", "<div class=\"modal-hours\"><span class=\"modal-hours-day\">Mandag</span><span class=\"modal-hours-time\">10:00 – 17:00</span>" +
          "<span class=\"modal-hours-day\">Lørdag</span><span class=\"modal-hours-time\">10:00 – 14:00 (Sommer)</span></div>"),
        section("Kontakt", "<div class=\"modal-contact-list\"><div class=\"modal-contact-item\">Gata 1, 0150</div>" +
          "<div class=\"modal-contact-item\">Tlf: <a href=\"tel:91234567\">91234567</a></div>" +
          "<div class=\"modal-contact-item\">E-post: <a href=\"mailto:post@gard.no\">post@gard.no</a></div>" +
          "<div class=\"modal-contact-item\">Nett: <a href=\"https://gard.no/\" target=\"_blank\" rel=\"noopener\">https://gard.no/</a></div></div>"),
        section("Sertifiseringer", "<div class=\"modal-tags\"><span class=\"modal-tag cert\">Debio</span></div>"),
        section("Levering", "<div class=\"modal-tags\"><span class=\"modal-tag \">Henting</span></div>"),
        section("Betaling", "<div class=\"modal-tags\"><span class=\"modal-tag \">Vipps</span></div>"),
        section("A2A Capabilities", "<div class=\"modal-tags\"><span class=\"modal-tag\">sell-products</span><span class=\"modal-tag\">Bestilling</span></div>"),
        "<div class=\"modal-section\"><div class=\"modal-data-source\"><span class=\"modal-data-dot owner\"></span> Eierverifisert data</div></div>",
        "<div class=\"modal-cta-row\"><a class=\"modal-cta modal-cta-primary\" href=\"/selger?agent=G%C3%A5rd%20%C3%85s\">Er dette din? Ta eierskap</a>" +
          "<button class=\"modal-cta modal-cta-secondary\" id=\"modalCardBtn\">Vis Agent Card (JSON)</button></div>",
      ].join("");
      for (const [name, script] of pages) {
        const r = await modal(script, wellFormedAgent, async (url) => url.endsWith("/info") ? jsonResponse({ success: true, data: wellFormed }) : jsonResponse({}));
        assertEq([r.badges, r.body], [expectedBadges, expectedBody], `b well-formed ${name}: the whole modal is byte-identical to main's`);
      }
    }

    // ══ (c) knowledge values are text ════════════════════════════════════
    const MODAL_TAGS = new Set(["div", "span", "a", "button"]);
    const MODAL_HREFS = [/^https?:\/\//, /^tel:/, /^mailto:/, /^\/selger\?agent=/];
    const xssAgent = listAgent("ii-xss", { name: XSS, role: XSS, categories: [XSS, BREAK_DQ], tags: [BREAK_SQ], skills: [XSS, { name: BREAK_DQ }], description: XSS });
    for (const [name, script] of pages) {
      const { badges, body } = await modal(script, xssAgent);
      assertEq(injectionProblems(badges + body, MODAL_TAGS, MODAL_HREFS), [], `c ${name}: only the modal's own tags, no on* attribute, no foreign href`);
      const text = visibleText(body);
      const shown = text.split(XSS).length - 1;
      assertTrue(shown >= 9, `c ${name}: "${XSS}" is shown as text for about, product, category, month, address, website, hours day and note, specialty, delivery, skill (${shown} times)`);
      assertTrue(text.includes(BREAK_DQ) && text.includes(BREAK_SQ), `c ${name}: the attribute break-outs are shown as text too`);
      assertTrue(visibleText(badges).includes(XSS) && visibleText(badges).includes(BREAK_DQ), `c ${name}: the header badges (role, categories) are text`);
      assertTrue(!/href="https?:\/\/[^"]*<img/.test(body) && !/<a [^>]*href="<img/.test(body), `c ${name}: the website "${XSS}" is no link`);
      const mailto = startTags(body).find((t) => t.name === "a" && (t.attrs.find(([n]) => n === "href")?.[1] ?? "").startsWith("mailto:"));
      assertEq(mailto?.attrs, [["href", `mailto:post@example.no${BREAK_DQ}`]], `c ${name}: an e-mail with a quote stays inside its href`);
      assertEq(junk(body), [], `c ${name}: no junk text`);

      // Fields /info does not let through as they are (an invalid phone is
      // dropped by getAgentInfo): crafted data straight into the modal.
      const crafted = await modalFromData(script, listAgent("x"), {
        agent: {}, meta: { dataSource: BREAK_DQ, lastUpdated: "2026-08-01T10:00:00Z" },
        knowledge: { phone: `${BREAK_DQ}${XSS}`, email: BREAK_SQ, website: `https://x.no/${BREAK_DQ}`, postalCode: XSS, address: "A",
          externalLinks: [{ url: `https://x.no/${BREAK_DQ}`, label: XSS, type: "info" }] },
        openingHoursDisplay: [{ days: XSS, hours: BREAK_DQ, note: BREAK_SQ }],
      });
      assertEq(injectionProblems(crafted, MODAL_TAGS, MODAL_HREFS), [], `c ${name} crafted: phone, e-mail, website, postal code, data source and hours rows are escaped, also in attributes`);
      assertTrue(visibleText(crafted).includes(`${BREAK_DQ}${XSS}`), `c ${name} crafted: the phone is shown as text`);

      const basic = await modal(script, xssAgent, async () => { throw new Error("offline"); });
      assertEq(injectionProblems(basic.badges + basic.body, MODAL_TAGS, MODAL_HREFS), [], `c ${name} basic modal (fetch failed): description, categories, tags and role are escaped`);
      assertTrue(visibleText(basic.body).includes(XSS) && visibleText(basic.body).includes(BREAK_SQ), `c ${name} basic modal: shown as text`);
    }
    {
      const html = await agentPage("ii-xss");
      const AGENT_TAGS = new Set(["nav", "div", "a", "header", "h1", "span", "main", "section", "h2", "p", "table", "thead", "tbody", "tr", "th", "td"]);
      assertEq(injectionProblems(html, AGENT_TAGS, [/^\/$/, ...MODAL_HREFS]), [], "c agent.html: only the page's own tags, no on* attribute, no foreign href");
      assertEq(agentPageHourRows(html), [[XSS, `10:00 – 17:00 (${XSS})`], ["", BREAK_DQ]], "c agent.html: the hours rows are text");
      assertTrue(visibleText(html).split(XSS).length - 1 >= 5, "c agent.html: the payload is shown as text");
    }

    // ══ (d) only http(s) websites are links ══════════════════════════════
    const websiteItem = (body: string) => /<div class="modal-contact-item">Nett: (.*?)<\/div>/.exec(body)?.[1] ?? null;
    for (const [name, script] of pages) {
      const { body } = await modal(script, listAgent("ii-js"));
      assertEq(websiteItem(body), "javascript:alert(document.cookie)", `d ${name}: a javascript: website from /info is text, not a link`);
      assertTrue(!/href\s*=\s*["']?\s*javascript:/i.test(body), `d ${name}: no javascript: href anywhere in the modal`);
      const cases: Array<[string, string | null]> = [
        [" JavaScript:alert(1)", null], ["data:text/html,<script>alert(1)</script>", null], ["www.gard.no", null], ["//evil.example", null],
        ["https://gard.no/?a=1&b=2", "https://gard.no/?a=1&amp;b=2"], ["HTTP://GARD.NO", "HTTP://GARD.NO"],
      ];
      for (const [website, href] of cases) {
        const item = websiteItem(await modalFromData(script, listAgent("x"), { agent: {}, meta: {}, knowledge: { website } })) ?? "";
        const link = /^<a href="([^"]*)" target="_blank" rel="noopener">/.exec(item);
        if (href === null) {
          assertTrue(!link && decode(item) === website, `d ${name}: website ${JSON.stringify(website)} is shown as text, not a link`);
        } else {
          assertEq(link?.[1] ?? null, href, `d ${name}: website ${JSON.stringify(website)} is a link`);
        }
      }
    }
    {
      const body = await modalFromData(dashScript, listAgent("x"), { agent: {}, meta: {}, knowledge: { externalLinks: [
        { url: "javascript:alert(1)", label: "Facebook", type: "facebook" }, { url: "https://reko.example/ring", label: "REKO", type: "info" },
      ] } });
      const links = startTags(body).filter((t) => t.attrs.some(([n, v]) => n === "class" && v === "modal-link-item"));
      assertEq(links.map((t) => [t.name, t.attrs.find(([n]) => n === "href")?.[1] ?? null]),
        [["span", null], ["a", "https://reko.example/ring"]], "d dashboard external links: a javascript: link is text, an https one a link");
    }
    {
      const html = await agentPage("ii-js");
      assertTrue(!/href\s*=\s*["']?\s*javascript:/i.test(html), "d agent.html: a javascript: website gives no javascript: href (the page keeps its https:// prefix)");
    }

    // ══ (e) fallback: no field, no hours; never junk text ════════════════
    for (const [name, script] of pages) {
      const body = await modalFromData(script, listAgent("x"), {
        agent: {}, meta: { dataSource: "auto" }, knowledge: { openingHours: [{ day: "monday", hours: "10-17" }], products: [{ name: "Ost" }] },
      });
      assertTrue(!body.includes("Åpningstider") && body.includes("Ost"), `e ${name}: /info without openingHoursDisplay (an older server) shows no hours, the rest of the modal is there`);
      const odd = await modalFromData(script, listAgent("x", { skills: [{}, null, { id: "sok" }, 5] }), {
        agent: {}, meta: { dataSource: {}, lastUpdated: "ikke en dato" },
        knowledge: {
          about: { text: "objekt" }, address: "Gata 3", postalCode: { code: 1 },
          products: ["Honning", { name: "Egg", category: { id: 1 }, seasonal: true, months: "6-8" }, { name: "Ost", seasonal: true, months: [6, { m: 7 }, 8] }, null],
          certifications: [{ id: 1 }, "Debio"],
        },
        openingHoursDisplay: [null, { days: { d: 1 }, hours: 5, note: null }, { days: "Lørdag", hours: "10:00 – 14:00", note: "" }],
      });
      assertEq(junk(odd), [], `e ${name}: wrong-typed values give no "[object Object]", "undefined", "NaN" or "Invalid Date"`);
      assertTrue(!odd.includes("<span class=\"modal-tag\"></span>"), `e ${name}: a skill with no name or id gives no empty tag`);
      assertTrue(odd.includes("Honning") && odd.includes("Jun-Aug") && odd.includes(">sok<") && odd.includes("Debio") && odd.includes("10:00 – 14:00"),
        `e ${name}: the well-typed values beside them are shown (text product, months, skill id, certification, hours row)`);
    }
    {
      const html = await agentPage("x", async (url) => url.endsWith("/info")
        ? jsonResponse({ success: true, data: { agent: { name: "Gard" }, knowledge: { openingHours: [{ day: "mon", open: "10:00", close: "17:00" }] }, meta: {} } })
        : jsonResponse({ agents: [] }));
      assertTrue(html.includes("<h1>Gard</h1>") && !html.includes("Apningstider"), "e agent.html: /info without openingHoursDisplay shows no hours");
    }

    // ══ (f) source ═══════════════════════════════════════════════════════
    for (const file of ["app.html", "dashboard.html", "agent.html"]) {
      const src = fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
      assertTrue(!/\bdayNames\b|\bDAY_NAMES\b/.test(src), `f ${file}: no day table of its own for opening hours`);
      assertTrue(!/\.openingHours\b/.test(src) && src.includes("openingHoursDisplay"), `f ${file}: reads openingHoursDisplay, not knowledge.openingHours`);
    }
    for (const [name, script] of pages) {
      const page = runPage(script, routeFetch).context as any;
      assertEq(
        ["<a href=\"x\" title='y'>&</a>", 5, 0, NaN, Infinity, null, undefined, {}, ["a"], true].map((v) => page.esc(v)),
        ["&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;", "5", "0", "", "", "", "", "", "", ""],
        `f ${name}: esc() escapes the five HTML characters (safe in either quote) and gives "" for anything but text and finite numbers`);
      assertEq(
        ["https://a.no", " http://a.no ", "HTTPS://A.NO", "javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "//a.no", "www.a.no", "", 5, null].map((v) => page.httpUrl(v)),
        ["https://a.no", "http://a.no", "HTTPS://A.NO", "", "", "", "", "", "", "", ""],
        `f ${name}: httpUrl() keeps only http(s) URLs`);
    }
  } catch (err: any) {
    failed++;
    failures.push("rfb-produsentmodal-apningstider-escaping: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = origLog;
    console.error = origError;
    if (prevDb) __setDbForTesting(prevDb as any);
    __setGeocodingFetchForTesting();
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbProdusentmodalApningstiderEscapingTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
