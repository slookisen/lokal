/**
 * rfb-offers-priser-ordgrense-avstand.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-V (found live 2026-10-17):
 * honest hits, distances and prices in the RFB offers and MCP text.
 *
 * - Price ranges (P2): parsePriceNok (product-catalog-sync.ts) ran every digit
 *   together, so «kr 70 – kr 650» became 70650 and «kr 48.00 – kr 220.00»
 *   48.0022. A range now gives its lowest price, a plain price what it gave
 *   before, and the next sync overwrites the stored wrong price.
 * - Word rule and limit (P3, P2 for short words): findOffers matched
 *   LIKE '%term%', so «egg» offered «Kjøttpålegg». The term must now start a
 *   word, or end one when it has four letters or more («Lynghonning» for
 *   «honning»; utils/product-name-match.ts), and `limit` counts producers:
 *   one offer each, its best row, whatever order the rows are in.
 * - Distance (P3): a producer placed at a centroid (geo_precision city,
 *   kommune, postal) showed «0 km». distance_km is now null for it, and the
 *   additive distance_label says where it is, on GET /catalog/offers,
 *   lokal_find_offers and the shopping list page.
 * - Cut-off tags (P3): mcpProse left a tag cut off at the end of a stored
 *   description («<div data-…») in lokal_info and lokal_search.
 *
 * Data: own fixtures through seedCategoryLabelOfferFixtures
 * (rfb-kategorietiketter-ikke-tilbud.test.ts) in in-memory DBs with the
 * production schema (restored in finally). Routers driven directly, MCP tools
 * through a duck-typed server, the page script in a vm with I-S2's fake DOM.
 * The frozen MCP contract is pinned in rfb-mcp-contract-freeze.test.ts.
 *
 * Exported runRfbOffersPriserOrdgrenseAvstandTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-offers-priser-ordgrense-avstand.test.ts
 */

import Database from "better-sqlite3";
import * as vm from "node:vm";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "../services/geocoding-service";
import { seedCategoryLabelOfferFixtures, sqliteTimestamp, type Seed, type CatalogRow } from "./rfb-kategorietiketter-ikke-tilbud.test";
import { callRoute, FakeNode } from "./rfb-kategoritreff-i-offers.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const B = { lat: 60.3913, lng: 5.3221 }; // Bergen (geocoding-service MAJOR_CITIES)
const O = { lat: 59.9139, lng: 10.7522 }; // Oslo
const S = { lat: 58.97, lng: 5.7331 }; // Stavanger

const id = (n: number) => `1e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PALEGG = id(1), FANA = id(2), KARTONG = id(3), BRYGG = id(4), LINDHEIM = id(5), POLSE = id(6), ISKREM = id(7);
const BIROKT = id(8), LAGER = id(9), NAVN = id(10);
const MANY = id(20), TIE_A = id(26), TIE_B = id(27);
const REPPE = id(30), ADDR = id(31), LEGACY = id(32), NOCITY = id(33), KOMMUNE = id(34), POSTAL = id(35), ETIKETT = id(36);
const FRAG = id(40);
const INDEROY = id(50), SIGDAL = id(51);

/** A producer whose knowledge products and catalog rows are the same names (and prices). */
function seed(n: string, name: string, pos: { lat: number; lng: number }, city: string, categories: string[], catalog: CatalogRow[],
  extra: Partial<Seed> = {}): Seed {
  return {
    id: n, name, lat: pos.lat, lng: pos.lng, city, categories,
    products: catalog.map((c) => ({ name: c.name, category: categories[0], ...(c.priceNok ? { price: `${c.priceNok} kr` } : {}) })),
    catalog, ...extra,
  };
}
const near = (p: { lat: number; lng: number }, dLat: number) => ({ lat: p.lat + dLat, lng: p.lng });

const SEEDS: Seed[] = [
  // Bergen: the word rule
  seed(PALEGG, "Bergen Pålegg Fixture", near(B, 0.0007), "Bergen", ["meat"],
    [{ name: "Kjøttpålegg", priceNok: 89 }, { name: "Pålegg", priceNok: 59 }, { name: "Lammelegg", priceNok: 250 }]),
  seed(FANA, "Fana Egg Fixture", near(B, 0.004), "Bergen", ["eggs"],
    [{ name: "Eggekartong", priceNok: 10 }, { name: "Frittgående egg", priceNok: 60 }, { name: "Egg", priceNok: 55 }]),
  seed(KARTONG, "Kartong Fixture", near(B, 0.007), "Bergen", ["eggs"], [{ name: "Eggekartong", priceNok: 15 }]),
  seed(BRYGG, "Bryggeri Fixture", near(B, 0.009), "Bergen", ["beverages"], [{ name: "Juleøl", priceNok: 95 }, { name: "Mørkt øl", priceNok: 85 }]),
  seed(LINDHEIM, "Lindheim Fixture", near(B, 0.011), "Bergen", ["beverages"], [{ name: "Øl fra Lindheim", priceNok: 90 }]),
  seed(POLSE, "Pølsemaker Fixture", near(B, 0.013), "Bergen", ["meat"],
    [{ name: "Grillpølser", priceNok: 120 }, { name: "Fisk", priceNok: 150 }, { name: "Ris", priceNok: 30 }]),
  seed(ISKREM, "Iskremfabrikk Fixture", near(B, 0.015), "Bergen", ["dairy"], [{ name: "Iskrem vanilje", priceNok: 70 }]),
  // Bergen: one offer per producer, its best row
  seed(BIROKT, "Birøkter Fixture", near(B, 0.017), "Bergen", ["honey"],
    [{ name: "Honningkake", priceNok: 80 }, { name: "Fjellhonning" }, { name: "Lynghonning", priceNok: 150 }]),
  seed(LAGER, "Honninglager Fixture", near(B, 0.019), "Bergen", ["honey"],
    [{ name: "Honning", priceNok: 200, ownerSet: true, availability: "out_of_stock" }, { name: "Honning, 1 kg", priceNok: 350 }]),
  seed(NAVN, "Navnelikhet Fixture", near(B, 0.021), "Bergen", ["honey"],
    [{ name: "Skogshonning", priceNok: 120 }, { name: "Blomsterhonning", priceNok: 120 }]),
  // Stavanger: the limit counts producers; equal distances go by agent id
  seed(MANY, "Potetgård Fixture", near(S, 0.001), "Stavanger", ["vegetables"],
    [{ name: "Mandelpoteter", priceNok: 40 }, { name: "Nypoteter", priceNok: 35 }, { name: "Poteter", priceNok: 25 }]),
  ...[0, 1, 2, 3, 4].map((i) => seed(id(21 + i), `Potetbonde ${i} Fixture`, near(S, 0.002 * (i + 1)), "Stavanger", ["vegetables"],
    [{ name: "Poteter", priceNok: 20 }])),
  seed(TIE_B, "Likt Sted B Fixture", near(S, 0.03), "Stavanger", ["vegetables"], [{ name: "Kålrot", priceNok: 15 }]),
  seed(TIE_A, "Likt Sted A Fixture", near(S, 0.03), "Stavanger", ["vegetables"], [{ name: "Kålrot", priceNok: 15 }]),
  // Oslo: distance honesty
  seed(REPPE, "Reppe Søndre Fixture", O, "Ski", ["vegetables"], [{ name: "Jordskokk", priceNok: 40, unit: "kg" }]),
  seed(ADDR, "Adressegård Fixture", near(O, 0.0216), "Oslo", ["vegetables"], [{ name: "Jordskokk", priceNok: 40, unit: "kg" }]),
  seed(LEGACY, "Ukjent Presisjon Fixture", near(O, 0.03), "Oslo", ["vegetables"], [{ name: "Jordskokk", priceNok: 40, unit: "kg" }]),
  seed(NOCITY, "Uten Sted Fixture", near(O, 0.04), "Oslo", ["vegetables"], [{ name: "Jordskokk", priceNok: 40, unit: "kg" }]),
  seed(KOMMUNE, "Kommunesenter Fixture", near(O, 0.05), "Nordre Follo", ["vegetables"], [{ name: "Pastinakk", priceNok: 30 }]),
  seed(POSTAL, "Postnummer Fixture", near(O, 0.06), "Kolbotn", ["vegetables"], [{ name: "Pastinakk", priceNok: 30 }]),
  seed(ETIKETT, "Sentroide Etikett Fixture", near(O, 0.01), "Ås", ["vegetables"], [{ name: "Grønnsaker" }]),
  // Molde: a description and an about cut off inside a tag
  seed(FRAG, "Fragmentgård Fixture", { lat: 62.7372, lng: 7.1607 }, "Molde", ["meat"], [{ name: "Lammestek", priceNok: 320 }], {
    description: "Sau og lam fra fjellbeite i Romsdal. <div data-elementor-type=\"wp-page\" data-id=\"12…",
    about: "Vi driver med sau og lam på garden.\n<link rel='stylesheet' id='wp-block-library' href='https://example.no/a.css…",
  }),
];
const PRECISION: Array<[string, string]> = [[REPPE, "city"], [ADDR, "address"], [NOCITY, "city"], [KOMMUNE, "kommune"], [POSTAL, "postal"], [ETIKETT, "city"]];

/** parsePriceNok before I-V (every digit run together), to show what a plain price read as. */
function parsePriceNokBeforeIV(priceStr: string): number | null {
  const digits = priceStr.replace(/kr\.?\s*/gi, "").replace(/[^0-9,.]/g, "").replace(/,/g, ".").trim();
  const val = parseFloat(digits);
  return isFinite(val) && val > 0 ? val : null;
}

export async function runRfbOffersPriserOrdgrenseAvstandTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const prevDb = __peekDbForTesting();
  const ownerSetAt = sqliteTimestamp(new Date(Date.now() - 24 * 3600 * 1000));
  const openDb = (seeds: readonly Seed[]) => {
    const conn = new Database(":memory:");
    conn.pragma("journal_mode = DELETE");
    conn.pragma("foreign_keys = ON");
    __setDbForTesting(conn as any);
    __initSchemaForTesting(conn as any);
    seedCategoryLabelOfferFixtures(conn, ownerSetAt, seeds);
    const setPrecision = conn.prepare("UPDATE agents SET geo_precision = ? WHERE id = ?");
    for (const [agentId, precision] of PRECISION) setPrecision.run(precision, agentId);
    conn.prepare("UPDATE agents SET city = NULL WHERE id = ?").run(NOCITY);
    return conn;
  };
  const db = openDb(SEEDS);
  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
  __clearGeocodeCacheForTesting();
  const prevBaseUrl = process.env.BASE_URL;
  delete process.env.BASE_URL;
  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  marketplaceRegistry._agentsCache = null;
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence module chatter */ };

  try {
    const { parsePriceNok, runProductCatalogSync } = require("../services/product-catalog-sync") as typeof import("../services/product-catalog-sync");
    const { productNameMatch, COMPOUND_HEAD_MIN_LENGTH } = require("../utils/product-name-match") as typeof import("../utils/product-name-match");
    const { findOffers } = require("../services/catalog-offers") as typeof import("../services/catalog-offers");
    const { formatRfbDistanceLabel } = require("../services/geo-precision") as typeof import("../services/geo-precision");
    const { catalogRouter } = require("./marketplace-catalog") as typeof import("./marketplace-catalog");
    const mcp = require("./mcp") as typeof import("./mcp");

    const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
    mcp.registerTools({
      registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
      resource() {}, prompt() {}, registerResource() {}, registerPrompt() {},
    } as any, () => "test-client", () => undefined);
    const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");
    const offersOf = (r: { offers: any[] }) => r.offers.map((o) => `${o.producer.name}: ${o.product_name}`);

    // ══════════════════════════════════════════════════════════════
    // Prices: parsePriceNok
    // ══════════════════════════════════════════════════════════════
    {
      const repro = ["kr 70 – kr 650", "kr 48.00 – kr 220.00"];
      assertEq(repro.map(parsePriceNokBeforeIV), [70650, 48.0022], "price repro: before I-V the two live ranges read as 70650 and 48.0022");
      assertEq(repro.map(parsePriceNok), [70, 48], "price: Inderøyhonning's «kr 70 – kr 650» is 70 and Sigdal Mølle's «kr 48.00 – kr 220.00» is 48 (the lowest price)");
      const ranges: Array<[string, number]> = [
        ["70-650 kr", 70], ["kr 650 – kr 70", 70], ["kr 70 til 650", 70], ["kr 70—kr 650/kg", 70],
        ["kr 1 200 – kr 1 500", 1200], ["kr 70,– – kr 650,–", 70], ["kr 49,50 - kr 89,50", 49.5],
      ];
      assertEq(ranges.map(([s]) => parsePriceNok(s)), ranges.map(([, v]) => v),
        "price: a range («-», «–», «—», «til», with or without «kr», thousands and decimals) gives its lowest price, whichever comes first");
      const plain = ["kr 275/kg", "kr 275", "275", "20 kr", "kr 55", "kr 49,90", "kr 1 200", "kr 1\u00a0200", "kr 350,-", "Fra kr 70",
        "kr. 89", "120 kr/glass", "60 kr/brett", "300 kr/kg", "kr 45 pr. 0,5 l", "NOK 89", "kr 1.200,-"];
      assertEq(plain.map((s) => parsePriceNok(s)), plain.map(parsePriceNokBeforeIV),
        "price byte-like: a plain price reads exactly as before (thousands with a space, decimals with a comma or a dot, «fra», «,-», «/kg»)");
      const glued: Array<[string, number, number]> = [
        ["kr 60/6 stk", 60, 606], ["kr 120 per 500 g", 120, 120500], ["500 g – kr 89", 89, 50089],
        ["45 kr per 0,5 l", 45, 450.5], ["kr 60 - 6 stk", 60, 606], ["ca. 275 kr", 275, 0.275], ["70 kroner", 70, 70],
      ];
      assertEq(glued.map(([s]) => [parsePriceNok(s), parsePriceNokBeforeIV(s)]), glued.map(([, now, before]) => [now, before]),
        "price: two numbers are never run together; the number by «kr» is the price («kr 60/6 stk» is 60, «500 g – kr 89» is 89), and «kr 60 - 6 stk» is no range");
      assertEq([null, undefined, "", "gratis", "kr 0", "0", "kr 0 – kr 0", "Pris etter avtale"].map((s) => parsePriceNok(s as any)),
        [null, null, null, null, null, null, null, null], "price: no positive number is no price");
    }

    // ══════════════════════════════════════════════════════════════
    // Prices: the next sync overwrites the stored wrong price
    // ══════════════════════════════════════════════════════════════
    {
      const T = { lat: 63.4305, lng: 10.3951 };
      const priceDb = openDb([
        { id: INDEROY, name: "Inderøyhonning Fixture", lat: T.lat + 0.01, lng: T.lng, city: "Inderøy", categories: ["honey"],
          products: [{ name: "Lynghonning", category: "honey", price: "kr 70 – kr 650" }],
          catalog: [{ name: "Lynghonning", priceNok: 70650 }] },
        { id: SIGDAL, name: "Sigdal Mølle Fixture", lat: T.lat + 0.02, lng: T.lng, city: "Sigdal", categories: ["bakery"],
          products: [{ name: "Siktet hvetemel", category: "bakery", price: "kr 48.00 – kr 220.00" }, { name: "Rugmel", category: "bakery" }],
          catalog: [{ name: "Siktet hvetemel", priceNok: 48.0022 }, { name: "Rugmel", priceNok: 33 }] },
      ]);
      const pricesOf = () => (priceDb.prepare("SELECT name, price_nok, availability, availability_source FROM products ORDER BY name").all() as any[])
        .map((p) => `${p.name}: ${p.price_nok} ${p.availability}/${p.availability_source}`);
      assertEq(pricesOf(), ["Lynghonning: 70650 in_stock/enrichment", "Rugmel: 33 in_stock/enrichment", "Siktet hvetemel: 48.0022 in_stock/enrichment"],
        "sync setup: the catalog holds the prices the earlier sync misread");
      const r = runProductCatalogSync(priceDb);
      assertEq(r.success && [r.inserted, r.updated], [0, 3], "sync: the run updates the three rows (no new row)");
      assertEq(pricesOf(), ["Lynghonning: 70 in_stock/enrichment", "Rugmel: 33 in_stock/enrichment", "Siktet hvetemel: 48 in_stock/enrichment"],
        "sync: the range overwrites the stored wrong price (70650 → 70, 48.0022 → 48); a product without a source price keeps its price; availability untouched");
      const honning = await findOffers({ q: "honning", lat: T.lat, lng: T.lng });
      const mel = await findOffers({ q: "hvetemel", lat: T.lat, lng: T.lng });
      assertEq([honning.offers.map((o) => [o.product_name, o.price_nok]), mel.offers.map((o) => [o.product_name, o.price_nok])],
        [[["Lynghonning", 70]], [["Siktet hvetemel", 48]]], "sync → offers: after the sync the offers show 70 and 48 kr");
      __setDbForTesting(db as any);
    }

    // ══════════════════════════════════════════════════════════════
    // The word rule (utils/product-name-match.ts)
    // ══════════════════════════════════════════════════════════════
    {
      const cases: Array<[string, string, number]> = [
        ["Egg", "egg", 3], ["Frittgående egg", "egg", 3], ["Ferske egg fra Fana", "egg", 3], ["Eggekartong", "egg", 1],
        ["Pålegg", "egg", 0], ["Kjøttpålegg", "egg", 0], ["Lammelegg", "egg", 0],
        ["Lynghonning", "honning", 2], ["Honningkake", "honning", 1], ["Honning, 1 kg", "honning", 3], ["Lammekjøtt", "kjøtt", 2],
        ["Øl fra Lindheim", "øl", 3], ["Mørkt øl", "øl", 3], ["Juleøl", "øl", 0], ["Grillpølser", "øl", 0],
        ["Iskrem vanilje", "is", 1], ["Fisk", "is", 0], ["Ris", "is", 0], ["Meieri", "er", 0],
        ["Poteter", "POTE", 1], ["  Egg  ", " EGG ", 3], ["Egg", "", 0], ["Pålegg og egg", "egg", 3], ["Jordbær", "bær", 0],
      ];
      assertEq(cases.map(([n, t]) => productNameMatch(n, t)), cases.map(([, , v]) => v),
        "word rule: whole word 3, compound head (≥ 4 letters) 2, start of a word 1, inside a word or a short word's end 0; case and spaces ignored; the best occurrence counts");
      assertEq(COMPOUND_HEAD_MIN_LENGTH, 4, "word rule: a compound head needs a term of at least four letters");
    }

    // ══════════════════════════════════════════════════════════════
    // Offers: the word rule on findOffers
    // ══════════════════════════════════════════════════════════════
    const searches = {
      eggB: await findOffers({ q: "egg", near: "Bergen" }),
      olB: await findOffers({ q: "øl", near: "Bergen" }),
      isB: await findOffers({ q: "is", near: "Bergen" }),
      honningB: await findOffers({ q: "honning", near: "Bergen" }),
      paleggB: await findOffers({ q: "pålegg", near: "Bergen" }),
      poteterS: await findOffers({ q: "poteter", lat: S.lat, lng: S.lng }),
      poteterS2: await findOffers({ q: "poteter", lat: S.lat, lng: S.lng, limit: 2 }),
      kalrotS: await findOffers({ q: "kålrot", lat: S.lat, lng: S.lng }),
      jordskokkO: await findOffers({ q: "jordskokk", near: "Oslo" }),
      pastinakkO: await findOffers({ q: "pastinakk", near: "Oslo" }),
      gronnsakerO: await findOffers({ q: "grønnsaker", near: "Oslo" }),
    };
    {
      const rows = (db.prepare("SELECT name FROM products WHERE LOWER(name) LIKE '%egg%'").all() as any[]).map((x) => x.name).sort();
      assertEq(rows, ["Egg", "Eggekartong", "Eggekartong", "Frittgående egg", "Kjøttpålegg", "Lammelegg", "Pålegg"],
        "egg setup: the catalog near Bergen has «egg» inside «Kjøttpålegg», «Pålegg» and «Lammelegg»");
      assertEq(offersOf(searches.eggB), ["Fana Egg Fixture: Egg", "Kartong Fixture: Eggekartong"],
        "«egg» near Bergen: no «Pålegg», «Kjøttpålegg» or «Lammelegg» (the acceptance criterion); «Egg» and «Eggekartong» stay");
      assertEq(offersOf(searches.paleggB), ["Bergen Pålegg Fixture: Pålegg"], "«pålegg» near Bergen: «Pålegg» itself is still found");
      assertEq(offersOf(searches.olB), ["Bryggeri Fixture: Mørkt øl", "Lindheim Fixture: Øl fra Lindheim"],
        "«øl» near Bergen: «Mørkt øl» and «Øl fra Lindheim» (upper-case «Ø» too), not «Grillpølser» nor the short word's end in «Juleøl»");
      assertEq(offersOf(searches.isB), ["Iskremfabrikk Fixture: Iskrem vanilje"], "«is» near Bergen: «Iskrem», not «Fisk» or «Ris»");
    }

    // ══════════════════════════════════════════════════════════════
    // Offers: limit counts producers, one offer each, its best row
    // ══════════════════════════════════════════════════════════════
    {
      assertEq(offersOf(searches.honningB),
        ["Birøkter Fixture: Lynghonning", "Honninglager Fixture: Honning, 1 kg", "Navnelikhet Fixture: Blomsterhonning"],
        "best row «honning»: a compound head beats a word start, a priced row an unpriced one (Lynghonning, not Honningkake, nor Fjellhonning, which sorts first by name); "
        + "in stock beats out of stock (the owner-set «Honning»); then by name (Blomsterhonning before Skogshonning)");
      assertEq(searches.honningB.offers.map((o) => [o.price_nok, o.availability]), [[150, "in_stock"], [350, "in_stock"], [120, "in_stock"]],
        "best row: the offer carries that row's price and availability");
      const manyRows = (db.prepare("SELECT COUNT(*) AS c FROM products WHERE agent_id = ?").get(MANY) as { c: number }).c;
      assertEq(manyRows, 3, "limit setup: the nearest producer has three rows that match «poteter»");
      assertEq(offersOf(searches.poteterS), ["Potetgård Fixture: Poteter", ...[0, 1, 2, 3].map((i) => `Potetbonde ${i} Fixture: Poteter`)],
        "limit: five offers are five producers, nearest first; the nearest is there once, with its whole-word «Poteter»");
      assertEq(offersOf(searches.poteterS2), ["Potetgård Fixture: Poteter", "Potetbonde 0 Fixture: Poteter"], "limit 2: two producers");
      assertTrue(Object.values(searches).every((r) => new Set(r.offers.map((o) => o.producer.agent_id)).size === r.offers.length),
        "limit: no producer has two offers on any search");
      assertEq(searches.kalrotS.offers.map((o) => o.producer.agent_id), [TIE_A, TIE_B],
        "order: two producers at one point go by agent id (B was written first)");

      // The same answers whatever order the rows are in: every producer, and
      // each producer's rows, written in the reverse order in a second DB
      // (the fixture ids follow the order, so the row is compared by name).
      const reversed = openDb([...SEEDS].reverse().map((s) => ({ ...s, catalog: [...s.catalog].reverse() })));
      const again = {
        honningB: await findOffers({ q: "honning", near: "Bergen" }), eggB: await findOffers({ q: "egg", near: "Bergen" }),
        poteterS: await findOffers({ q: "poteter", lat: S.lat, lng: S.lng }), kalrotS: await findOffers({ q: "kålrot", lat: S.lat, lng: S.lng }),
      };
      reversed.close();
      __setDbForTesting(db as any);
      const withoutIds = (r: { offers: any[] }) => r.offers.map(({ product_id: _id, ...rest }) => rest);
      for (const k of Object.keys(again) as Array<keyof typeof again>) {
        assertEq(withoutIds(again[k]), withoutIds(searches[k]), `order (${k}): the same offers with every row written in the reverse order`);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // Distance: no km figure for a centroid, and distance_label
    // ══════════════════════════════════════════════════════════════
    {
      const byId = new Map(searches.jordskokkO.offers.map((o) => [o.producer.agent_id, o.producer]));
      assertEq(searches.jordskokkO.offers.map((o) => o.producer.agent_id), [REPPE, ADDR, LEGACY, NOCITY],
        "distance: still ranked by the real distance (the centroid producer at the search point first)");
      const reppe = byId.get(REPPE);
      assertEq([reppe?.distance_km, reppe?.distance_label], [null, "i Ski-området"],
        "distance «city» (Reppe Søndre's repro): distance_km null, not 0, and distance_label «i Ski-området»");
      const addr = byId.get(ADDR);
      assertEq([addr?.distance_km, addr?.distance_label], [2.4, "2,4 km unna"], "distance «address»: the km figure and «2,4 km unna»");
      assertEq(addr?.distance_label, formatRfbDistanceLabel(addr?.distance_km ?? null, "address", "Oslo"), "distance: the label is formatRfbDistanceLabel's");
      const legacy = byId.get(LEGACY);
      assertTrue(typeof legacy?.distance_km === "number" && legacy.distance_km > 3 && !("distance_label" in (legacy ?? {})),
        `distance untagged (null): the km figure as before and no distance_label key (got ${JSON.stringify(legacy)})`);
      assertEq(Object.keys(legacy ?? {}), ["agent_id", "name", "city", "distance_km", "verifisert_av_eier", "can_order", "salgskanaler",
        "delivery_text", "phone", "email", "profile_url", "vcard_url"], "distance untagged: the producer has the fields it had before I-V, in that order");
      assertEq(Object.keys(addr ?? {}).slice(0, 5), ["agent_id", "name", "city", "distance_km", "distance_label"],
        "distance: distance_label is added right after distance_km");
      assertEq([byId.get(NOCITY)?.distance_km, byId.get(NOCITY)?.distance_label], [null, "omtrentlig posisjon"],
        "distance «city» without a city: «omtrentlig posisjon»");
      assertEq(searches.pastinakkO.offers.map((o) => [o.producer.distance_km, o.producer.distance_label]),
        [[null, "i Nordre Follo-området"], [null, "i Kolbotn-området"]], "distance «kommune» and «postal» are centroids too");
      const m = searches.gronnsakerO.category_matches?.[0];
      assertEq([m?.producer.agent_id, m?.producer.distance_km, m?.producer.distance_label], [ETIKETT, null, "i Ås-området"],
        "distance: a category match's producer follows the same rule (one producer shape)");
      assertTrue(Object.values(searches).every((r) => [...r.offers, ...(r.category_matches ?? [])].every((o) => o.producer.distance_km !== 0
        || !["city", "kommune", "postal"].includes(PRECISION.find(([a]) => a === o.producer.agent_id)?.[1] ?? ""))),
      "distance: no centroid producer says 0 km on any search");
    }

    // ══════════════════════════════════════════════════════════════
    // The surfaces: GET /catalog/offers, lokal_find_offers, the page
    // ══════════════════════════════════════════════════════════════
    {
      const egg = await callRoute(catalogRouter, "GET", "/offers?q=egg&near=Bergen&radius_km=50&limit=5");
      assertEq([egg.status, egg.body], [200, searches.eggB], "GET /catalog/offers «egg» near Bergen: findOffers' result, no «Pålegg»");
      const jord = await callRoute(catalogRouter, "GET", "/offers?q=jordskokk&near=Oslo&radius_km=50&limit=5");
      assertEq(jord.body, searches.jordskokkO, "GET /catalog/offers «jordskokk» near Oslo: distance_km null and distance_label for the centroid");
      const r = await tools.get("lokal_find_offers")!({ items: ["egg", "jordskokk"], near: "Bergen" });
      const viaTool = JSON.parse(textOf(r));
      assertEq(viaTool[0], searches.eggB, "lokal_find_offers «egg» near Bergen: the same offers, no «Pålegg»");
      const o = await tools.get("lokal_find_offers")!({ items: ["jordskokk", "poteter"], lat: O.lat, lng: O.lng });
      const parsed = JSON.parse(textOf(o));
      assertEq(parsed[0], searches.jordskokkO, "lokal_find_offers «jordskokk»: the result JSON carries distance_label");
      assertTrue(/"distance_km": null,\n\s+"distance_label": "i Ski-området"/.test(textOf(o)),
        "lokal_find_offers: Reppe Søndre reads «distance_km: null, distance_label: i Ski-området» in the tool text");
    }
    {
      const page = require("./handleliste-page") as typeof import("./handleliste-page");
      const copyJson = (page.buildHandelistePage("no").content.match(/<script type="application\/json" id="hl-copy">([\s\S]*?)<\/script>/) || [])[1] || "{}";
      const C = JSON.parse(copyJson);
      const nodes = new Map<string, FakeNode>();
      const el = (key: string) => { if (!nodes.has(key)) nodes.set(key, new FakeNode("div")); return nodes.get(key)!; };
      el("hl-copy").textContent = copyJson;
      const fetchStub = (path: string, init: { method: string }) =>
        callRoute(catalogRouter, init.method, path.slice("/api/marketplace/catalog".length)).then((x) => ({ status: x.status, json: async () => x.body }));
      const context = vm.createContext({
        document: { getElementById: el, createElement: (tag: string) => new FakeNode(tag), createTextNode: (s: string) => new FakeNode("#text", s) },
        fetch: fetchStub,
        localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
        navigator: {},
      });
      vm.runInContext(page.HANDELISTE_CLIENT_SCRIPT, context);
      el("hl-rows").getElementsByTagName("input")[0]!.value = "jordskokk";
      el("hl-place").value = "Oslo";
      el("hl-find").dispatch("click");
      for (let i = 0; i < 200; i++) await new Promise((res) => setImmediate(res));
      const metas = el("hl-offers").querySelectorAll(".hl-offer").map((n) => n.querySelectorAll(".hl-meta")[0]?.textContent);
      const km = (agentId: string) => searches.jordskokkO.offers.find((x) => x.producer.agent_id === agentId)?.producer.distance_km;
      assertEq(metas, [
        "i Ski-området · Jordskokk · 40 kr/kg",
        `Oslo · ${km(ADDR)} ${C.km} · Jordskokk · 40 kr/kg`,
        `Oslo · ${km(LEGACY)} ${C.km} · Jordskokk · 40 kr/kg`,
        "omtrentlig posisjon · Jordskokk · 40 kr/kg",
      ], "page: a centroid producer shows its distance_label in place of the city and a km figure; the others are as before");
      assertTrue(!metas.some((t) => / 0 km/.test(String(t))), "page: no row says «0 km»");
    }

    // ══════════════════════════════════════════════════════════════
    // Cut-off tags: mcpProse, lokal_info, lokal_search / lokal_discover
    // ══════════════════════════════════════════════════════════════
    {
      const { mcpProse } = mcp;
      assertEq([
        mcpProse("Sau og lam fra fjellbeite. <div data-elementor-type=\"wp-page\" data-id=\"12…"),
        mcpProse("Gårdsbutikk og kafé.<link rel='stylesheet' id='wp-block-library' href='https://example.no/a.css' …"),
        mcpProse("<p>Ost fra egen gård</p><p class=\"intro"),
        mcpProse("Honning og bivoks</p></di"),
        mcpProse("<span"),
        mcpProse("Linje 1<br />Linje 2 <img src=\"https://example.no/a.jpg", "\n   "),
      ], ["Sau og lam fra fjellbeite.", "Gårdsbutikk og kafé.", "Ost fra egen gård", "Honning og bivoks", "", "Linje 1\n   Linje 2"],
      "fragment: a tag cut off at the end («<div data-…», «<link rel='stylesheet' …», «<p class=…», «</di») is removed; the lines are trimmed as for a whole tag");
      const kept = ["a < b", "<3 honning", "Honning <3", "Pris: 50 < 60 kr", "Egg <10 kr", "5 <= 6", "x <y og 1 < 2", "Mer enn 2 <", "<"];
      assertEq(kept.map((s) => mcpProse(s)), kept, "fragment: «a < b», «<3» and a «<» before a digit, a space or another «<» stay");
      assertEq(mcpProse("x <y"), "x", "fragment: the rule is a «<» and a letter with no «<» or «>» after it, so a trailing «x <y» loses «<y»");
      const t0 = Date.now();
      mcpProse("<a ".repeat(50_000) + "x ".repeat(100_000) + "<b c".repeat(50_000));
      assertTrue(Date.now() - t0 < 500, `fragment: linear on many unclosed tags (${Date.now() - t0} ms)`);

      const info = textOf(await tools.get("lokal_info")!({ agentId: FRAG }));
      assertTrue(info.includes("\n\nVi driver med sau og lam på garden.\n") && !info.includes("<link") && !info.includes("stylesheet"),
        `lokal_info: the about has no tag fragment (got ${JSON.stringify(info.slice(0, 200))})`);
      const discovered = textOf(await tools.get("lokal_discover")!({ categories: ["meat"], lat: 62.7372, lng: 7.1607, limit: 10 }));
      const block = discovered.slice(discovered.indexOf("Fragmentgård Fixture"));
      assertTrue(block.includes("\n   Sau og lam fra fjellbeite i Romsdal.\n") && !block.includes("<div") && !block.includes("data-elementor"),
        `lokal_discover (lokal_search's compact view): the description has no tag fragment (got ${JSON.stringify(block.slice(0, 160))})`);
      const searched = textOf(await tools.get("lokal_search")!({ query: "lam nær Molde", limit: 10 }));
      const sblock = searched.slice(searched.indexOf("Fragmentgård Fixture"));
      assertTrue(searched.includes("Fragmentgård Fixture") && sblock.includes("Sau og lam fra fjellbeite i Romsdal.") && !sblock.includes("<div"),
        `lokal_search «lam nær Molde»: the description has no tag fragment (got ${JSON.stringify(sblock.slice(0, 160))})`);
    }
  } finally {
    console.log = prevLog;
    if (prevBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = prevBaseUrl;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    marketplaceRegistry._agentsCache = null;
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runRfbOffersPriserOrdgrenseAvstandTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
