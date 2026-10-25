/**
 * rfb-seo-feiltypede-knowledge-felt.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-G, the seo.ts part (FUNN
 * rfb-knowledge-lesere-utenfor-i-f), plus FUNN rfb-seo-ra-json-stringify-inline
 * from the lokal#1105 review.
 *
 * getAgentInfo (I-F) hands each knowledge list over in its declared shape, but
 * seo.ts read the fields inside a product or an opening-hours entry without
 * checking their type. On main (1f92ad56):
 *   - a product price stored as an object showed as "[object Object]" (also
 *     true, -5 and ["60"] as prices, and an object unit as "150 [object Object]");
 *   - opening hours without times showed as "undefined – undefined", a text
 *     entry in the list too, and JSON-LD said "https://schema.org/undefined";
 *   - the times were written into the page unescaped;
 *   - /produsent/:slug answered 500 for a day that is a number, a product
 *     month list stored as text and a seasonality entry whose months are a
 *     number; the front page answered 500 when a featured (claimed) producer's
 *     hours held a number;
 *   - the ultra-rich front-page card showed a text product as its emoji alone.
 * And the producer page's inline <script> wrote agentId with raw
 * JSON.stringify(), so a value with "</script>" ended the element.
 *
 * Covers:
 *   (a) pure: which opening-hours entries the pages show and how each field
 *       is read (openingHourRows() here until slice I-H moved it to
 *       utils/opening-hours.ts normalizeOpeningHours());
 *       buildProducerFaqJsonLd / buildProducerAnswerFirstOpening with product
 *       names that are not text.
 *   (b) parity: well-formed knowledge renders exactly as on main (goldens
 *       taken from main 1f92ad56): the product, hours, delivery and
 *       certification cards, the LocalBusiness and FAQPage JSON-LD (since
 *       I-H, openingHoursSpecification has valid days for range keys and
 *       long names, which main wrote as "https://schema.org/mon-fri"; since
 *       S6 del B of dev-request
 *       2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt,
 *       makesOffer holds Offers from the farm without a Product, and main's
 *       makesOffer bytes come back in rollback mode), and the whole inline
 *       script for a UUID agent id (no and en); the well-formed
 *       ultra-rich card is checked against main in (d).
 *   (c) regression, one producer per repro: object/boolean/negative/array
 *       prices and non-text units; product months as text and with non-month
 *       entries; hours with text entries, missing or object times, HTML in a
 *       time and an object note; hours that are all junk (no card, and the
 *       FAQ does not claim hours); a numeric day; seasonality with numeric
 *       months and object product/note; junk in the list fields; legacy
 *       numeric times keep their text.
 *   (d) front page with claimed producers whose products and hours are of the
 *       wrong type: 200, text products by name, no "undefined–undefined"
 *       (and, since I-H, no open-now claim when no entry has weekdays and
 *       times), number times on the hour, no junk.
 *   (e) inline script: an agent id with `</script><!--<script>&` and U+2028
 *       cannot end the element (parser view, tests/helpers/
 *       html-script-elements.ts) and evaluates back to the id.
 *   Every page: no "[object Object]", "undefined" or "NaN" in the visible HTML
 *   or in any JSON-LD string.
 *
 * Own in-memory DB, the real seo.ts router's handlers off its route stack, no
 * HTTP server — same harness as rfb-synlig-faq-og-fylkessider.test.ts.
 *
 * Exported runRfbSeoFeiltypedeKnowledgeFeltTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/rfb-seo-feiltypede-knowledge-felt.test.ts
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import * as vm from "vm";
import { scriptElements } from "../../tests/helpers/html-script-elements";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** The inner HTML of a card body whose grid is `<div class="${cls}">…</div></div>` on one line. */
function cardGrid(body: string, cls: string): string | null {
  const m = new RegExp(`<div class="${cls}">(.*)</div></div>\\n`).exec(body);
  return m ? m[1]! : null;
}

/** The page without the "today" highlight, which depends on the weekday the test runs. */
function withoutToday(html: string): string {
  return html.replace(/ hrs-today/g, "").replace(/<span class="hrs-open"><span class="hrs-dot"><\/span> [^<]*<\/span>/g, "");
}

/** Every JSON-LD block on the page, parsed. */
function jsonLdBlocks(body: string): any[] {
  return [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
}

/** Junk a wrong-typed field used to leave: in the visible HTML (scripts and styles removed) and in JSON-LD strings. */
function junk(body: string): string[] {
  const visible = body.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "").replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
  const found = [...visible.matchAll(/.{0,40}(\[object Object\]|\bundefined\b|\bNaN\b).{0,20}/g)].map((m) => m[0]);
  for (const ld of jsonLdBlocks(body)) {
    JSON.stringify(ld, (_k, v) => {
      if (typeof v === "string" && /\[object Object\]|undefined|NaN/.test(v)) found.push(`JSON-LD: ${v}`);
      return v;
    });
  }
  return found;
}

export async function runRfbSeoFeiltypedeKnowledgeFeltTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
      if (log) console.log(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const policy = require("../services/structured-data-policy") as typeof import("../services/structured-data-policy");
  const prevDb = (() => { try { return getDb(); } catch { return undefined; } })();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  const origLog = console.log;
  const origError = console.error;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }

    delete require.cache[require.resolve("./seo")];
    const seo = require("./seo") as typeof import("./seo");
    const { buildProducerFaqJsonLd, buildProducerAnswerFirstOpening } = seo;
    // Slice I-H moved the reading of an openingHours list from seo.ts's
    // openingHourRows() to utils/opening-hours.ts (normalizeOpeningHours),
    // shared with lokal_info and the auto-reply. The I-G cases below keep
    // their inputs and which entries are kept; the entry shape is the util's.
    const { normalizeOpeningHours } = require("../utils/opening-hours") as typeof import("../utils/opening-hours");

    // ══ (a) pure ═════════════════════════════════════════════════════════
    assertEq(normalizeOpeningHours([
      { day: "mon", open: "10:00", close: "17:00" },
      { day: "sat", open: "11:00", close: "15:00", note: "Kun i sesong" },
    ]), [
      { days: [0], label: "mon", open: "10:00", close: "17:00" },
      { days: [5], label: "sat", open: "11:00", close: "15:00", note: "Kun i sesong" },
    ], "a rows: well-formed entries keep their text, in order");
    assertEq(normalizeOpeningHours([{ day: "mon-fri", open: 10, close: 17 }]),
      [{ days: [0, 1, 2, 3, 4], label: "mon-fri", open: "10", close: "17" }],
      "a rows: a number time is its digits (main showed \"10 – 17\")");
    assertEq(normalizeOpeningHours(["  Lørdag etter avtale ", "", "   "]), [{ days: [], label: "", note: "Lørdag etter avtale" }],
      "a rows: a text entry is shown trimmed; an empty one is left out");
    assertEq(normalizeOpeningHours([
      { day: "tue", closed: true },
      { day: "sun", open: "", close: "" },
      { day: "sat", open: "10:00" },
      { day: "wed", open: { h: 10 }, close: "17:00" },
      { day: "thu", open: "10:00", close: [17] },
      { day: "fri", open: " ", close: "17:00" },
      { day: "mon", open: Infinity, close: "17:00" },
      null, 5, true, [{ day: "mon", open: "10:00", close: "17:00" }],
    ]), [], "a rows: entries without both usable times, and non-entries, are left out");
    assertEq(normalizeOpeningHours([{ day: 1, open: "10:00", close: "17:00", note: { x: 1 } }]),
      [{ days: [], label: "", open: "10:00", close: "17:00" }],
      "a rows: a day or note that is not text counts as none");
    for (const v of [null, undefined, 5, { mon: "10-17" }]) {
      assertEq(normalizeOpeningHours(v), [], `a rows: ${JSON.stringify(v) ?? "undefined"} (not a list or text) has no entries`);
    }
    // Free text for the whole field is one text entry for lokal_info and the
    // auto-reply; the producer page keeps showing it in its own row (hoursText).
    // (Slice I-O reads text in the day-and-time form, "Man–fre 10–17", into day rows.)
    assertEq(normalizeOpeningHours("Man–fre 10–17 (sommer)"), [{ days: [], label: "", note: "Man–fre 10–17 (sommer)" }],
      "a rows: free text for the whole field is one text entry");

    {
      const products = [{ name: { x: 1 } }, { name: 5 }, null, "Honning", { name: "Egg" }, { name: "" }];
      const faq = buildProducerFaqJsonLd({ name: "Test Gard", url: "https://rettfrabonden.com/produsent/test-gard", cityName: "Oslo", productsList: products, categories: [], hoursList: [], hoursText: "" });
      assertEq(faq?.mainEntity?.[0]?.acceptedAnswer?.text, "Test Gard tilbyr Honning, Egg.",
        "a FAQ: only text product names are listed (main: \"[object Object], 5, Honning, Egg\")");
      let opening: string | null = null;
      let threw = false;
      try {
        opening = buildProducerAnswerFirstOpening({ name: "Test Gard", cityName: "Oslo", productsList: products, categories: [], productsAreSourced: true, lang: "en" });
      } catch { threw = true; }
      assertTrue(!threw, "a opening: /en with non-text product names does not throw (main: name.trim is not a function)");
      assertEq(opening, "Test Gard in Oslo produces Honey, Eggs — find contact details below.", "a opening: only the text names, translated");
      assertEq(
        buildProducerFaqJsonLd({ name: "Test Gard", url: "https://rettfrabonden.com/produsent/test-gard", cityName: "Oslo", productsList: ["Honning", { name: "Egg", price: "50" }], categories: [], hoursList: [], hoursText: "" })?.mainEntity?.[0]?.acceptedAnswer?.text,
        "Test Gard tilbyr Honning, Egg.",
        "a FAQ: text entries and objects with a text name, as before",
      );
    }

    // ══ fixture ══════════════════════════════════════════════════════════
    function seedProducer(row: {
      id: string; name: string; city: string; geo: [number, number]; trust?: number; claimed?: boolean;
      knowledge?: Record<string, unknown>;
    }): void {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
          '[]', '[]', '[]', '{}', '["no"]', ?, ?, ?,
          ?, 1, 1, 0, 0, 0, 0, '2026-08-01 10:00:00', '2026-08-01 10:00:00')`,
      ).run(
        row.id, row.name, "Lokal produsent med gardsutsalg og mye godt.", row.name, `${row.name.length}@example.no`,
        "https://example.no", `key-${row.name}`, row.city, row.geo[0], row.geo[1], row.trust ?? 0.5,
      );
      // Each knowledge column holds the JSON text of the value, as written by
      // enrichment or an owner edit that nothing type-checked.
      const cols = ["agent_id", "updated_at", "created_at", "enrichment_status"];
      const vals: unknown[] = [row.id, "2026-08-01 10:00:00", "2026-08-01 10:00:00", "enriched"];
      for (const [col, value] of Object.entries(row.knowledge || {})) { cols.push(col); vals.push(JSON.stringify(value)); }
      testDb.prepare(`INSERT INTO agent_knowledge (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
      if (row.claimed) {
        testDb.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
           VALUES (?, ?, 'Eier', ?, 'verified', '2026-08-01 10:00:00')`,
        ).run(`claim-${row.id}`, row.id, `${row.id}-owner@example.no`);
      }
    }
    const allDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

    // W: well-formed (the parity golden).
    seedProducer({ id: "w-gard", name: "Wenche Gard", city: "Wtown", geo: [59.91, 10.75], knowledge: {
      products: [
        { name: "Honning", category: "honey", seasonal: true, months: [6, 7, 8], price: "150", priceUnit: "kr" },
        { name: "Lammelår – kr 275/kg", category: "meat" },
        { name: "Egg", category: "eggs", price: 60, priceUnit: "stk", organic: true },
        { name: "Syltetøy & gelé <hjemmelaget>", category: "preserves", price: "89/glass" },
        { name: "Ost", category: "dairy", price: "Spør om pris" },
        { name: "", category: "dairy" },
        { name: "  Smør  ", price: " 45 " },
        "Rabarbra",
        "🐑 LAM",
      ],
      opening_hours: [
        { day: "mon-fri", open: "10:00", close: "17:00" },
        { day: "sat-sun", open: "11:00", close: "15:00", note: "Kun i sesong & ferie" },
        { day: "mon", open: "09:00", close: "16:00" },
        { day: "saturday", open: "10:00", close: "14:00" },
      ],
      certifications: ["Nyt Norge", "Spesialitet"],
      payment_methods: ["Vipps", "Kontant"],
      delivery_options: ["Henting på gården", "REKO-ring"],
    } });
    // L: legacy shapes that rendered on main, with junk entries beside them.
    seedProducer({ id: "l-gard", name: "Lars Legacy", city: "Ltown", geo: [63.43, 10.4], knowledge: {
      products: [{ name: "Honning", price: 150 }, { name: "Egg", price: 0 }, { name: "Kjøtt", seasonal: true, months: ["6", "7"] }],
      opening_hours: [{ day: "mon-fri", open: 10, close: 17 }, { day: "sun", open: "", close: "" }, { day: "tue", closed: true }],
    } });
    // M: one producer per wrong-typed repro.
    seedProducer({ id: "m-price", name: "Maria Objektpris", city: "Mtown", geo: [58.97, 5.73], knowledge: {
      products: [
        { name: "Honning", price: { amount: 150, currency: "NOK" } },
        { name: "Egg", price: ["60"] },
        { name: "Ost", price: true },
        { name: "Smør", price: -5 },
        { name: "Fløte", price: 150, priceUnit: { unit: "l" } },
        { name: "Rømme", price: "45", priceUnit: 7 },
        { name: "Kefir", price: "35", priceUnit: "l" },
      ],
    } });
    seedProducer({ id: "m-months", name: "Morten Maaneder", city: "M2town", geo: [58.15, 7.99], knowledge: {
      products: [
        { name: "Jordbær", seasonal: true, months: "6,7,8" },
        { name: "Bringebær", seasonal: true, months: [7, { m: 8 }, null, "<b>9</b>"] },
      ],
    } });
    seedProducer({ id: "m-hours", name: "Mona Aapningstider", city: "M3town", geo: [69.65, 18.96], knowledge: {
      opening_hours: [
        "Lørdag etter avtale",
        { day: "tue", closed: true },
        { day: "wed", open: { h: 10 }, close: "17:00" },
        { day: "thu", open: "<b>10</b>", close: "17:00" },
        { day: "fri", open: "10:00", close: "17:00", note: { x: 1 } },
        { day: "sun", open: "", close: "" },
        null, 5,
        { day: "sat", open: "10:00" },
      ],
    } });
    seedProducer({ id: "m-junkhours", name: "Mari Bare Stengt", city: "M7town", geo: [60.8, 11.0], knowledge: {
      products: [{ name: "Ost", category: "dairy" }],
      opening_hours: [{ day: "tue", closed: true }, { day: "sun", open: "", close: "" }, null, 5],
    } });
    seedProducer({ id: "m-day", name: "Mads Talldag", city: "M4town", geo: [59.74, 10.2], knowledge: {
      opening_hours: [{ day: 1, open: "10:00", close: "17:00" }, { day: "mon-fri", open: "09:00", close: "15:00" }],
    } });
    seedProducer({ id: "m-season", name: "Mette Sesong", city: "M5town", geo: [59.22, 10.93], knowledge: {
      seasonality: [
        { product: "Jordbær", months: 7 },
        { product: { n: "x" }, months: [6], note: { y: 1 } },
        "Plommer i august",
        { product: "Kirsebær", months: [7], note: "Juli" },
      ],
    } });
    seedProducer({ id: "m-lists", name: "Mikkel Lister", city: "M6town", geo: [67.28, 14.4], knowledge: {
      certifications: ["Nyt Norge", 5, { a: 1 }],
      payment_methods: "Vipps",
      delivery_options: [{ x: 1 }, "REKO-ring", 7],
    } });
    // Inline script: a UUID id (parity) and a hostile one.
    const UUID = "0a1d8ad6-1c2b-4d5e-8f90-123456789abc";
    const HOSTILE_ID = "x</script><!--<script>&\u2028y";
    seedProducer({ id: UUID, name: "Uuid Gard", city: "Utown", geo: [62.47, 6.15] });
    seedProducer({ id: HOSTILE_ID, name: "Fiendtlig Id", city: "Ftown", geo: [61.0, 9.0] });
    // Front page: the three claimed producers with the highest trust get the
    // ultra-rich card, which reads products and opening hours.
    seedProducer({ id: "c-ok", name: "Claimed Velformet", city: "Ctown", geo: [60.0, 10.0], claimed: true, trust: 0.99, knowledge: {
      products: [{ name: "Ost", category: "dairy" }, { name: "Egg", category: "eggs" }],
      opening_hours: allDays.map((day) => ({ day, open: "00:00", close: "24:00" })),
    } });
    seedProducer({ id: "c-text", name: "Claimed Tekstprodukt", city: "Ctown", geo: [60.0, 10.0], claimed: true, trust: 0.98, knowledge: {
      products: ["Rabarbra", { name: "Honning", category: { k: 1 } }, { name: "Egg", category: "eggs" }, "Ekstra"],
      opening_hours: [{ day: 3, open: "10:00", close: "17:00" }, ...allDays.map((day) => ({ day, closed: true }))],
    } });
    seedProducer({ id: "c-num", name: "Claimed Talltid", city: "Ctown", geo: [60.0, 10.0], claimed: true, trust: 0.97, knowledge: {
      products: [{ name: "Honning", category: "honey" }],
      opening_hours: allDays.map((day) => ({ day, open: 0, close: 24 })),
    } });
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    const router = seo.default as any;
    function handlerFor(routePath: string): any {
      const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === routePath && l.route.methods?.get);
      if (!layer) throw new Error(`GET ${routePath} is not registered`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
    const producerHandler = handlerFor("/produsent/:slug");
    const homeHandler = handlerFor("/");
    function invoke(handler: any, req: any): { status: number; body: string } {
      let status = 200;
      let body = "";
      const res: any = {
        status: (c: number) => { status = c; return res; },
        send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
        redirect: () => { status = 301; return res; },
        setHeader: () => res,
        set: () => res,
        locals: {},
      };
      console.log = () => {};
      console.error = () => {};
      try { handler(req, res, () => { status = -1; }); } finally { console.log = origLog; console.error = origError; }
      return { status, body };
    }
    const producer = (slug: string, lang: "no" | "en" = "no") =>
      invoke(producerHandler, { params: { slug }, lang, ip: "127.0.0.1", headers: {}, get: () => undefined, query: {} });
    const home = (lang: "no" | "en") =>
      invoke(homeHandler, { lang, query: {}, ip: "127.0.0.1", headers: {}, get: () => undefined });
    const localBusiness = (body: string): any => jsonLdBlocks(body).find((b) => b["@type"] === "LocalBusiness");
    const faqPage = (body: string): any => jsonLdBlocks(body).find((b) => b["@type"] === "FAQPage");

    // ══ (b) parity: well-formed knowledge, goldens from main 1f92ad56 ═════
    {
      const no = producer("wenche-gard");
      const en = producer("wenche-gard", "en");
      assertEq([no.status, en.status], [200, 200], "b W: 200 (no, en)");
      assertEq(cardGrid(no.body, "prod-grid"),
        "<div class=\"prod-item\"><span class=\"prod-name\">Honning</span><span class=\"prod-price\">150</span><div class=\"prod-meta\"><span class=\"prod-season\">Jun–Jul–Aug</span></div></div><div class=\"prod-item\"><span class=\"prod-name\">Lammelår – kr 275/kg</span><div class=\"prod-meta\"></div></div><div class=\"prod-item\"><span class=\"prod-name\">Egg</span><span class=\"prod-price\">60 stk</span><div class=\"prod-meta\"><span class=\"prod-org\">&#127793; Øko</span></div></div><div class=\"prod-item\"><span class=\"prod-name\">Syltetøy &amp; gelé &lt;hjemmelaget&gt;</span><span class=\"prod-price\">89/glass</span><div class=\"prod-meta\"></div></div><div class=\"prod-item\"><span class=\"prod-name\">Ost</span><span class=\"prod-price\">Spør om pris</span><div class=\"prod-meta\"></div></div><div class=\"prod-item\"><span class=\"prod-name\">  Smør  </span><span class=\"prod-price\"> 45 </span><div class=\"prod-meta\"></div></div><div class=\"prod-item\"><span class=\"prod-name\">Rabarbra</span><div class=\"prod-meta\"></div></div><div class=\"prod-item\"><span class=\"prod-name\">🐑 LAM</span><div class=\"prod-meta\"></div></div>",
        "b W no: product card byte-identical to main (text and number prices, unit, months, organic, escaping, text entries)");
      assertEq(cardGrid(en.body, "prod-grid"), "<div class=\"prod-item\"><span class=\"prod-name\">Honey</span><span class=\"prod-price\">150</span><div class=\"prod-meta\"><span class=\"prod-season\">Jun–Jul–Aug</span></div></div><div class=\"prod-item\"><span class=\"prod-name\">Lammelår – kr 275/kg</span><div class=\"prod-meta\"></div></div><div class=\"prod-item\"><span class=\"prod-name\">Eggs</span><span class=\"prod-price\">60 stk</span><div class=\"prod-meta\"><span class=\"prod-org\">&#127793; Øko</span></div></div><div class=\"prod-item\"><span class=\"prod-name\">Syltetøy &amp; gelé &lt;hjemmelaget&gt;</span><span class=\"prod-price\">89/glass</span><div class=\"prod-meta\"></div></div><div class=\"prod-item\"><span class=\"prod-name\">Cheese</span><span class=\"prod-price\">Spør om pris</span><div class=\"prod-meta\"></div></div><div class=\"prod-item\"><span class=\"prod-name\">Butter</span><span class=\"prod-price\"> 45 </span><div class=\"prod-meta\"></div></div><div class=\"prod-item\"><span class=\"prod-name\">Rhubarb</span><div class=\"prod-meta\"></div></div><div class=\"prod-item\"><span class=\"prod-name\">🐑 LAM</span><div class=\"prod-meta\"></div></div>", "b W en: product card byte-identical to main");
      assertEq(withoutToday(cardGrid(no.body, "hrs-grid") ?? ""), "<div class=\"hrs-day\">Mandag–Fredag</div><div class=\"hrs-time\">10:00 – 17:00</div><div class=\"hrs-day\">Lørdag–Søndag</div><div class=\"hrs-time\">11:00 – 15:00 (Kun i sesong &amp; ferie)</div><div class=\"hrs-day\">Mandag</div><div class=\"hrs-time\">09:00 – 16:00</div><div class=\"hrs-day\">Lørdag</div><div class=\"hrs-time\">10:00 – 14:00</div>", "b W no: hours card byte-identical to main (today highlight aside)");
      assertEq(withoutToday(cardGrid(en.body, "hrs-grid") ?? ""), "<div class=\"hrs-day\">Monday–Friday</div><div class=\"hrs-time\">10:00 – 17:00</div><div class=\"hrs-day\">Saturday–Sunday</div><div class=\"hrs-time\">11:00 – 15:00 (Kun i sesong &amp; ferie)</div><div class=\"hrs-day\">Monday</div><div class=\"hrs-time\">09:00 – 16:00</div><div class=\"hrs-day\">Saturday</div><div class=\"hrs-time\">10:00 – 14:00</div>", "b W en: hours card byte-identical to main (today highlight aside)");
      assertEq(cardGrid(no.body, "del-grid"), "<div class=\"del-item\"><strong>Leveringsmetoder:</strong> Henting på gården, REKO-ring</div><div class=\"del-item\"><strong>Betaling:</strong> Vipps, Kontant</div>", "b W no: delivery and payment card byte-identical to main");
      assertEq(cardGrid(no.body, "certs-row"), "<div class=\"cert-item\"><span style=\"font-size:1.1rem;\">&#127942;</span><span class=\"cert-text\">Nyt Norge</span></div><div class=\"cert-item\"><span style=\"font-size:1.1rem;\">&#127942;</span><span class=\"cert-text\">Spesialitet</span></div>", "b W no: certifications card byte-identical to main");
      const lb = localBusiness(no.body);
      // Slice I-H: dayOfWeek is a schema.org DayOfWeek for every weekday
      // spelling. Main (and I-G) wrote the stored key after the prefix, so a
      // range or a long name gave an invalid value ("https://schema.org/mon-fri",
      // ".../saturday"); the "mon" entry is as on main. Slice I-O: the
      // "sat-sun" entry has a season note ("Kun i sesong & ferie"), so it holds
      // only in part of the year and is left out, as an entry with a period.
      const sd = (d: string) => `https://schema.org/${d}`;
      assertEq(lb?.openingHoursSpecification, [
        { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map(sd), opens: "10:00", closes: "17:00" },
        { "@type": "OpeningHoursSpecification", dayOfWeek: sd("Monday"), opens: "09:00", closes: "16:00" },
        { "@type": "OpeningHoursSpecification", dayOfWeek: sd("Saturday"), opens: "10:00", closes: "14:00" },
      ], "b W no: LocalBusiness openingHoursSpecification has valid days for ranges and long names (I-H); a short key as on main; no entry with a season note (I-O)");
      // dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt
      // (S6 del B): each priced product is an Offer from the farm with exactly
      // @type, name, price and priceCurrency, no Product node. The catalog,
      // paymentAccepted and keywords are as on main.
      assertEq(JSON.stringify({ o: lb?.makesOffer, c: lb?.hasOfferCatalog, p: lb?.paymentAccepted, k: lb?.keywords }),
        "{\"o\":[{\"@type\":\"Offer\",\"name\":\"Honning\",\"price\":150,\"priceCurrency\":\"NOK\"},{\"@type\":\"Offer\",\"name\":\"Lammelår\",\"price\":275,\"priceCurrency\":\"NOK\"},{\"@type\":\"Offer\",\"name\":\"Egg\",\"price\":60,\"priceCurrency\":\"NOK\"},{\"@type\":\"Offer\",\"name\":\"Syltetøy & gelé <hjemmelaget>\",\"price\":89,\"priceCurrency\":\"NOK\"},{\"@type\":\"Offer\",\"name\":\"  Smør  \",\"price\":45,\"priceCurrency\":\"NOK\"}],\"c\":{\"@type\":\"OfferCatalog\",\"name\":\"Produkter\",\"itemListElement\":[{\"@type\":\"Thing\",\"name\":\"Ost\"},{\"@type\":\"Thing\",\"name\":\"Rabarbra\"},{\"@type\":\"Thing\",\"name\":\"🐑 LAM\"}]},\"p\":\"Vipps, Kontant\",\"k\":\"Nyt Norge, Spesialitet\"}", "b W no: LocalBusiness offers (S6 del B: Offer from the farm, no Product), catalog, paymentAccepted and keywords");
      // Rollback mode (PRODUCER_PAGE_PRODUCT_NODES = true) gives back the
      // golden from main byte for byte: del A's name rule reads every Wenche
      // product as the old rule did («Lammelår – kr 275/kg» → Lammelår, 275).
      let rollback: { status: number; body: string } = { status: 0, body: "" };
      try {
        policy.__setProducerPageProductNodesForTesting(true);
        rollback = producer("wenche-gard");
      } finally {
        policy.__setProducerPageProductNodesForTesting(null);
      }
      const lbRollback = localBusiness(rollback.body);
      assertEq(JSON.stringify({ o: lbRollback?.makesOffer, c: lbRollback?.hasOfferCatalog, p: lbRollback?.paymentAccepted, k: lbRollback?.keywords }),
        "{\"o\":[{\"@type\":\"Offer\",\"itemOffered\":{\"@type\":\"Product\",\"name\":\"Honning\",\"description\":\"Honning fra Wenche Gard\",\"brand\":{\"@type\":\"Brand\",\"name\":\"Wenche Gard\"},\"offers\":{\"@type\":\"Offer\",\"price\":150,\"priceCurrency\":\"NOK\",\"availability\":\"https://schema.org/InStock\",\"seller\":{\"@type\":\"LocalBusiness\",\"name\":\"Wenche Gard\"}}},\"price\":150,\"priceCurrency\":\"NOK\",\"availability\":\"https://schema.org/InStock\"},{\"@type\":\"Offer\",\"itemOffered\":{\"@type\":\"Product\",\"name\":\"Lammelår\",\"description\":\"Lammelår fra Wenche Gard\",\"brand\":{\"@type\":\"Brand\",\"name\":\"Wenche Gard\"},\"offers\":{\"@type\":\"Offer\",\"price\":275,\"priceCurrency\":\"NOK\",\"availability\":\"https://schema.org/InStock\",\"seller\":{\"@type\":\"LocalBusiness\",\"name\":\"Wenche Gard\"}}},\"price\":275,\"priceCurrency\":\"NOK\",\"availability\":\"https://schema.org/InStock\"},{\"@type\":\"Offer\",\"itemOffered\":{\"@type\":\"Product\",\"name\":\"Egg\",\"description\":\"Egg fra Wenche Gard\",\"brand\":{\"@type\":\"Brand\",\"name\":\"Wenche Gard\"},\"offers\":{\"@type\":\"Offer\",\"price\":60,\"priceCurrency\":\"NOK\",\"availability\":\"https://schema.org/InStock\",\"seller\":{\"@type\":\"LocalBusiness\",\"name\":\"Wenche Gard\"}}},\"price\":60,\"priceCurrency\":\"NOK\",\"availability\":\"https://schema.org/InStock\"},{\"@type\":\"Offer\",\"itemOffered\":{\"@type\":\"Product\",\"name\":\"Syltetøy & gelé <hjemmelaget>\",\"description\":\"Syltetøy & gelé <hjemmelaget> fra Wenche Gard\",\"brand\":{\"@type\":\"Brand\",\"name\":\"Wenche Gard\"},\"offers\":{\"@type\":\"Offer\",\"price\":89,\"priceCurrency\":\"NOK\",\"availability\":\"https://schema.org/InStock\",\"seller\":{\"@type\":\"LocalBusiness\",\"name\":\"Wenche Gard\"}}},\"price\":89,\"priceCurrency\":\"NOK\",\"availability\":\"https://schema.org/InStock\"},{\"@type\":\"Offer\",\"itemOffered\":{\"@type\":\"Product\",\"name\":\"  Smør  \",\"description\":\"  Smør   fra Wenche Gard\",\"brand\":{\"@type\":\"Brand\",\"name\":\"Wenche Gard\"},\"offers\":{\"@type\":\"Offer\",\"price\":45,\"priceCurrency\":\"NOK\",\"availability\":\"https://schema.org/InStock\",\"seller\":{\"@type\":\"LocalBusiness\",\"name\":\"Wenche Gard\"}}},\"price\":45,\"priceCurrency\":\"NOK\",\"availability\":\"https://schema.org/InStock\"}],\"c\":{\"@type\":\"OfferCatalog\",\"name\":\"Produkter\",\"itemListElement\":[{\"@type\":\"Thing\",\"name\":\"Ost\"},{\"@type\":\"Thing\",\"name\":\"Rabarbra\"},{\"@type\":\"Thing\",\"name\":\"🐑 LAM\"}]},\"p\":\"Vipps, Kontant\",\"k\":\"Nyt Norge, Spesialitet\"}", "b W no rollback mode: LocalBusiness offers, catalog, paymentAccepted and keywords byte-identical to main");
      assertEq(JSON.stringify(faqPage(no.body)), "{\"@context\":\"https://schema.org\",\"@type\":\"FAQPage\",\"@id\":\"https://rettfrabonden.com/produsent/wenche-gard#faq\",\"mainEntity\":[{\"@type\":\"Question\",\"name\":\"Hva selger Wenche Gard?\",\"acceptedAnswer\":{\"@type\":\"Answer\",\"text\":\"Wenche Gard tilbyr Honning, Lammelår – kr 275/kg, Egg, Syltetøy & gelé <hjemmelaget>, Ost,   Smør  , Rabarbra, 🐑 LAM.\"}},{\"@type\":\"Question\",\"name\":\"Hvor ligger Wenche Gard?\",\"acceptedAnswer\":{\"@type\":\"Answer\",\"text\":\"Wenche Gard holder til i Wtown.\"}},{\"@type\":\"Question\",\"name\":\"Kan jeg besøke eller bestille fra Wenche Gard?\",\"acceptedAnswer\":{\"@type\":\"Answer\",\"text\":\"Ja — Wenche Gard har åpningstider oppført på profilen.\"}}]}", "b W no: FAQPage byte-identical to main");
      assertEq(junk(no.body).concat(junk(en.body)), [], "b W: no junk text (no, en)");
    }
    {
      // The whole inline script as on main, held as its SHA-256 (it is ~4 KB):
      // a legitimate edit of the script's JavaScript changes these hashes too,
      // so take new ones from main then (S1 2026-10-25: «Med i AI-søk» strings).
      // The server-written lines are spelled
      // out below so a failure shows which value moved.
      const scriptOf = (body: string): string => scriptElements(body).find((e) => e.content.includes("var agentId"))?.content ?? "";
      const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
      const no = scriptOf(producer("uuid-gard").body);
      const en = scriptOf(producer("uuid-gard", "en").body);
      assertEq(sha256(no), "d825f73bb4061d9a2ebb308056c25c5205a054a406374eb45fc625fabc7056c3", "b inline script no: byte-identical to main for a UUID id (sha256)");
      assertEq(sha256(en), "d2a83c1ef8d0cb531d0dc7d6d20f4a50d1920497752c55a4b70c2a0dde945601", "b inline script en: byte-identical to main, language strings included (sha256)");
      assertTrue(no.includes(`var agentId = "${UUID}";`) && en.includes(`var agentId = "${UUID}";`), "b inline script: agentId is the plain JSON string for a UUID");
      assertTrue(no.includes('toLocaleString("nb-NO")') && no.includes('parts.push("Annet" + " " + b.other)') && no.includes('"ganger profilen var blant treffene en AI-assistent hentet · siden "'),
        "b inline script no: Norwegian language strings as before");
      assertTrue(en.includes('toLocaleString("en-GB")') && en.includes('parts.push("Other" + " " + b.other)') && en.includes('"times the profile was among the results an AI assistant fetched · since "'),
        "b inline script en: English language strings as before");
    }

    // ══ (c) regression: wrong-typed knowledge ════════════════════════════
    {
      // The "[object Object]" repro from I-F (lokal#1110).
      for (const lang of ["no", "en"] as const) {
        const r = producer("maria-objektpris", lang);
        assertEq(r.status, 200, `c price ${lang}: 200`);
        assertEq(junk(r.body), [], `c price ${lang}: no "[object Object]" (main: "[object Object]" and "150 [object Object]")`);
      }
      const grid = cardGrid(producer("maria-objektpris").body, "prod-grid");
      assertEq(grid,
        "<div class=\"prod-item\"><span class=\"prod-name\">Honning</span><div class=\"prod-meta\"></div></div>" +
        "<div class=\"prod-item\"><span class=\"prod-name\">Egg</span><div class=\"prod-meta\"></div></div>" +
        "<div class=\"prod-item\"><span class=\"prod-name\">Ost</span><div class=\"prod-meta\"></div></div>" +
        "<div class=\"prod-item\"><span class=\"prod-name\">Smør</span><div class=\"prod-meta\"></div></div>" +
        "<div class=\"prod-item\"><span class=\"prod-name\">Fløte</span><span class=\"prod-price\">150</span><div class=\"prod-meta\"></div></div>" +
        "<div class=\"prod-item\"><span class=\"prod-name\">Rømme</span><span class=\"prod-price\">45</span><div class=\"prod-meta\"></div></div>" +
        "<div class=\"prod-item\"><span class=\"prod-name\">Kefir</span><span class=\"prod-price\">35 l</span><div class=\"prod-meta\"></div></div>",
        "c price: object, array, boolean and negative prices show no price (productPriceText, like lokal_info); a non-text unit is left out; a text unit stays");
    }
    {
      const r = producer("morten-maaneder");
      assertEq(r.status, 200, "c months: 200 (main: 500, months.map is not a function)");
      assertEq(cardGrid(r.body, "prod-grid"),
        "<div class=\"prod-item\"><span class=\"prod-name\">Jordbær</span><div class=\"prod-meta\"></div></div>" +
        "<div class=\"prod-item\"><span class=\"prod-name\">Bringebær</span><div class=\"prod-meta\"><span class=\"prod-season\">Jul–&lt;b&gt;9&lt;/b&gt;</span></div></div>",
        "c months: months as text give no badge; an object or null month is left out; month text is escaped (main wrote it raw)");
      assertEq(junk(r.body), [], "c months: no junk text");
    }
    {
      const r = producer("mona-aapningstider");
      assertEq(r.status, 200, "c hours: 200");
      assertEq(withoutToday(cardGrid(r.body, "hrs-grid") ?? ""),
        "<div class=\"hrs-day\"></div><div class=\"hrs-time\">Lørdag etter avtale</div>" +
        "<div class=\"hrs-day\">Torsdag</div><div class=\"hrs-time\">&lt;b&gt;10&lt;/b&gt; – 17:00</div>" +
        "<div class=\"hrs-day\">Fredag</div><div class=\"hrs-time\">10:00 – 17:00</div>",
        "c hours: a text entry is shown as text; entries without both times are left out (main: \"undefined – undefined\", \"[object Object] – 17:00\", \"10:00 – undefined\"); times are escaped; an object note is left out");
      // Slice I-H: JSON-LD takes only clock times, so the "<b>10</b>" entry
      // (I-G wrote it as opens) is left out of it; the card still shows it.
      assertEq(localBusiness(r.body)?.openingHoursSpecification, [
        { "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Friday", opens: "10:00", closes: "17:00" },
      ], "c hours: JSON-LD has the entries with a day and two clock times only (main: \"https://schema.org/undefined\", an object as opens; I-G: \"<b>10</b>\" as opens)");
      assertTrue(!/<b>10<\/b>/.test(r.body.replace(/<script[\s\S]*?<\/script>/g, "")), "c hours: no raw HTML from a time in the page");
      assertEq(junk(r.body), [], "c hours: no junk text");
    }
    {
      const r = producer("mads-talldag");
      assertEq(r.status, 200, "c numeric day: 200 (main: 500, key.toLowerCase is not a function)");
      assertEq(withoutToday(cardGrid(r.body, "hrs-grid") ?? ""),
        "<div class=\"hrs-day\"></div><div class=\"hrs-time\">10:00 – 17:00</div><div class=\"hrs-day\">Mandag–Fredag</div><div class=\"hrs-time\">09:00 – 15:00</div>",
        "c numeric day: the entry keeps its times without a day name");
      assertEq((localBusiness(r.body)?.openingHoursSpecification || []).map((s: any) => s.dayOfWeek),
        [["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d) => `https://schema.org/${d}`)],
        "c numeric day: no JSON-LD entry without a day; the range lists its days (I-H)");
    }
    {
      const r = producer("mette-sesong");
      assertEq(r.status, 200, "c seasonality: 200 (main: 500, months.includes is not a function)");
      const names = [...r.body.matchAll(/<div class="season-name">(?:<span class="season-live">&#9679;<\/span>)?([^<]*)<\/div>/g)].map((m) => m[1]);
      assertEq(names, ["Jordbær", "", "Plommer i august", "Kirsebær"], "c seasonality: product names are text only; a text entry is the product (main: empty)");
      assertEq([...r.body.matchAll(/<div class="season-note">([^<]*)<\/div>/g)].map((m) => m[1]), ["Juli"], "c seasonality: an object note is left out");
      assertEq(junk(r.body), [], "c seasonality: no junk text");
    }
    {
      const r = producer("mikkel-lister");
      assertEq(r.status, 200, "c lists: 200");
      assertEq(cardGrid(r.body, "certs-row"),
        "<div class=\"cert-item\"><span style=\"font-size:1.1rem;\">&#127942;</span><span class=\"cert-text\">Nyt Norge</span></div>",
        "c lists: certifications show their text entries only");
      assertEq(cardGrid(r.body, "del-grid"),
        "<div class=\"del-item\"><strong>Leveringsmetoder:</strong> REKO-ring</div><div class=\"del-item\"><strong>Betaling:</strong> Vipps</div>",
        "c lists: delivery options show text entries only; payment methods stored as one text are one entry");
      assertEq(localBusiness(r.body)?.paymentAccepted, "Vipps", "c lists: JSON-LD paymentAccepted from the same entries");
      assertEq(junk(r.body), [], "c lists: no junk text");
    }
    {
      const r = producer("lars-legacy");
      assertEq(r.status, 200, "c legacy: 200");
      assertEq(withoutToday(cardGrid(r.body, "hrs-grid") ?? ""),
        "<div class=\"hrs-day\">Mandag–Fredag</div><div class=\"hrs-time\">10 – 17</div>",
        "c legacy: number times keep main's text \"10 – 17\"; empty and missing times are left out (main: \" – \" and \"undefined – undefined\")");
      assertEq(cardGrid(r.body, "prod-grid"),
        "<div class=\"prod-item\"><span class=\"prod-name\">Honning</span><span class=\"prod-price\">150</span><div class=\"prod-meta\"></div></div>" +
        "<div class=\"prod-item\"><span class=\"prod-name\">Egg</span><div class=\"prod-meta\"></div></div>" +
        "<div class=\"prod-item\"><span class=\"prod-name\">Kjøtt</span><div class=\"prod-meta\"><span class=\"prod-season\">Jun–Jul</span></div></div>",
        "c legacy: number price 150, no price for 0, month numbers stored as text — all as on main");
      assertTrue(/Lars Legacy har åpningstider oppført på profilen/.test(JSON.stringify(faqPage(r.body))), "c legacy: FAQ still says the hours are listed");
      assertEq(junk(r.body), [], "c legacy: no junk text");
    }
    {
      // Hours that are all junk: no hours card and no FAQ claim that hours are listed.
      const r = producer("mari-bare-stengt");
      assertEq(r.status, 200, "c junk hours: 200");
      assertTrue(!r.body.includes('class="hrs-grid"'), "c junk hours: no hours card when no entry has times");
      assertTrue(!JSON.stringify(faqPage(r.body) || {}).includes("åpningstider"), "c junk hours: the FAQ does not claim hours (visible FAQ and FAQPage alike)");
      assertTrue(!localBusiness(r.body)?.openingHoursSpecification, "c junk hours: no openingHoursSpecification");
      assertEq(junk(r.body), [], "c junk hours: no junk text");
    }

    // ══ (d) front page with wrong-typed claimed producers ════════════════
    for (const lang of ["no", "en"] as const) {
      const r = home(lang);
      assertEq(r.status, 200, `d / ${lang}: 200 (main: 500 on a number in a featured producer's hours)`);
      const href = (slug: string) => `${lang === "en" ? "/en" : ""}/produsent/${slug}`;
      const card = (slug: string): string => new RegExp(`<a href="${href(slug)}" class="pc pc-ultra">([\\s\\S]*?)</a>`).exec(r.body)?.[1] ?? "";
      const ok = card("claimed-velformet");
      const text = card("claimed-tekstprodukt");
      const num = card("claimed-talltid");
      assertTrue(!!ok && !!text && !!num, `d / ${lang}: the three claimed producers have ultra-rich cards`);
      assertEq(ok.match(/<div class="pc-products">[\s\S]*?<\/div>/)?.[0],
        lang === "en" ? "<div class=\"pc-products\">&#129472; Cheese, &#129370; Eggs</div>" : "<div class=\"pc-products\">&#129472; Ost, &#129370; Egg</div>",
        `d / ${lang}: well-formed product line byte-identical to main`);
      assertEq(ok.match(/<div class="pc-meta-line">🕒[\s\S]*?<\/div>/)?.[0],
        lang === "en" ? "<div class=\"pc-meta-line\">🕒 <span class=\"pc-open-now\">Open now</span> <span class=\"pc-hours\">00:00–24:00</span></div>" : "<div class=\"pc-meta-line\">🕒 <span class=\"pc-open-now\">Åpent nå</span> <span class=\"pc-hours\">00:00–24:00</span></div>",
        `d / ${lang}: well-formed open-now line byte-identical to main`);
      assertEq(text.match(/<div class="pc-products">[\s\S]*?<\/div>/)?.[0],
        lang === "en"
          ? "<div class=\"pc-products\">&#127793; Rhubarb, &#127793; Honey, &#129370; Eggs <span class=\"pc-more\">+1 products</span></div>"
          : "<div class=\"pc-products\">&#127793; Rabarbra, &#127793; Honning, &#129370; Egg <span class=\"pc-more\">+1 produkter</span></div>",
        `d / ${lang}: a text product is shown by its name; an object category gets the default emoji`);
      // Slice I-H: its only timed entry has a number as day, so no entry says
      // which days it is open; the card claims nothing ("Stengt" before) and
      // shows no "undefined–undefined".
      assertTrue(!/🕒/.test(text) && !/undefined/.test(text),
        `d / ${lang}: no entry with weekdays and times -> no open-now line, no "undefined–undefined"`);
      assertEq(num.match(/<div class="pc-meta-line">🕒[\s\S]*?<\/div>/)?.[0],
        `<div class="pc-meta-line">🕒 <span class="pc-open-now">${lang === "en" ? "Open now" : "Åpent nå"}</span> <span class="pc-hours">0–24</span></div>`,
        `d / ${lang}: number times are hours on the hour (0–24 is open all day)`);
      assertEq(junk(r.body), [], `d / ${lang}: no junk text`);
    }

    // ══ (e) inline script: agentId cannot end the element ════════════════
    for (const lang of ["no", "en"] as const) {
      const r = producer("fiendtlig-id", lang);
      assertEq(r.status, 200, `e hostile id ${lang}: 200`);
      // Read from the inline script's own start tag: the vCard link earlier on
      // the page carries the id raw in an attribute, which the oracle does not model.
      const at = r.body.lastIndexOf("<script>", r.body.indexOf("var agentId"));
      const els = scriptElements(r.body.slice(at));
      const own = els[0];
      assertTrue(!!own && own.closed && own.content.includes("var agentId") && /\}\)\(\);\s*$/.test(own.content),
        `e hostile id ${lang}: the inline script ends at its own </script> with the whole script inside`);
      const expr = own?.content.match(/var agentId = (.*);/)?.[1] ?? "";
      assertTrue(!/[<>&\u2028\u2029]/.test(expr), `e hostile id ${lang}: no raw <, >, &, U+2028 or U+2029 in the agentId literal`);
      let value: unknown = null;
      try { value = vm.runInNewContext(`(${expr})`); } catch { /* reported below */ }
      assertEq(value, HOSTILE_ID, `e hostile id ${lang}: the literal evaluates to the stored id`);
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    policy.__setProducerPageProductNodesForTesting(null);
    if (prevDb) __setDbForTesting(prevDb as any);
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/rfb-seo-feiltypede-knowledge-felt.test.ts`
if (require.main === module) {
  console.log("── rfb-seo-feiltypede-knowledge-felt (I-G seo.ts + inline-script JSON) ──");
  runRfbSeoFeiltypedeKnowledgeFeltTests({ log: true }).then((r) => {
    console.log(`\nrfb-seo-feiltypede-knowledge-felt: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
