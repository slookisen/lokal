/**
 * rfb-sok-mengde-flerord.test.ts — A2A dev-request
 * 2026-11-06-rfb-sok-mengde-flerord-og-treffvisning, slices A and B (found
 * live 2026-11-06 in the ChatGPT app review).
 *
 * - Slice A: a quantity is no product word (utils/query-quantity.ts). «biff
 *   1kg» in lokal_search put the honey producer with «Honning 1kg» on the
 *   page, «1kg» alone gave only that producer, and lokal_find_offers found
 *   nothing for «biff 1kg» or «1 kg honning». A quantity alone now asks for a
 *   product (lokal_search) or gives needs_product:true (findOffers).
 * - Slice B: findOffers (lokal_find_offers, GET /catalog/offers, the shopping
 *   list page) tries the whole phrase first; when it finds nothing, every
 *   word left after the filler words must match the same product name. An
 *   organic claim word is never left out (OFFER_CLAIM_WORDS, locked here).
 *
 * Data: own fixtures through seedCategoryLabelOfferFixtures
 * (rfb-kategorietiketter-ikke-tilbud.test.ts) in an in-memory DB with the
 * production schema (restored in finally). MCP tools through a duck-typed
 * server, the REST router driven directly. The frozen MCP contract is pinned
 * in rfb-mcp-contract-freeze.test.ts (no fixture change for these slices).
 *
 * Exported runRfbSokMengdeFlerordTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-sok-mengde-flerord.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "../services/geocoding-service";
import { seedCategoryLabelOfferFixtures, sqliteTimestamp, type Seed } from "./rfb-kategorietiketter-ikke-tilbud.test";
import { callRoute } from "./rfb-kategoritreff-i-offers.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const O = { lat: 59.9139, lng: 10.7522 }; // Oslo (geocoding-service MAJOR_CITIES)
const id = (n: number) => `1f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const near = (dLat: number) => ({ lat: O.lat + dLat, lng: O.lng });

const HONEY_1KG = "Helnora Honning Fixture";
const BIFF = "Biffgården Fixture";
const TORRMODNET = "Pølsemaker Fixture";
const LAM = "Lammegården Fixture";
const OKO = "Økobigården Fixture";
const VANLIG = "Vanlig Bigård Fixture";
const NORSK = "Norskbigården Fixture";
const BAKER = "Glutenbakeriet Fixture";
const MEIERI = "Laktosemeieriet Fixture";
const SYLTERI = "Sylteriet Fixture";
const SALTBAKER = "Saltbakeriet Fixture";
const ALL = [HONEY_1KG, BIFF, TORRMODNET, LAM, OKO, VANLIG, NORSK, BAKER, MEIERI, SYLTERI, SALTBAKER];

const SEEDS: Seed[] = [
  { id: id(1), name: HONEY_1KG, ...near(0.002), city: "Oslo", categories: ["honey"],
    products: [{ name: "Honning 1kg", category: "honey", price: "250 kr" }], catalog: [{ name: "Honning 1kg", priceNok: 250 }] },
  { id: id(2), name: BIFF, ...near(0.004), city: "Oslo", categories: ["meat"],
    products: [{ name: "Biff", category: "meat", price: "450 kr" }], catalog: [{ name: "Biff", priceNok: 450, unit: "kg" }] },
  { id: id(3), name: TORRMODNET, ...near(0.006), city: "Oslo", categories: ["meat"],
    products: [{ name: "Tørrmodnet biff", category: "meat", price: "520 kr" }], catalog: [{ name: "Tørrmodnet biff", priceNok: 520, unit: "kg" }] },
  { id: id(4), name: LAM, ...near(0.008), city: "Oslo", categories: ["meat"],
    products: [{ name: "Lammelår", category: "meat", price: "320 kr" }], catalog: [{ name: "Lammelår", priceNok: 320 }] },
  { id: id(5), name: OKO, ...near(0.010), city: "Oslo", categories: ["honey"],
    products: [{ name: "Økologisk honning", category: "honey", price: "200 kr" }], catalog: [{ name: "Økologisk honning", priceNok: 200 }] },
  { id: id(6), name: VANLIG, ...near(0.012), city: "Oslo", categories: ["honey"],
    products: [{ name: "Honning", category: "honey", price: "150 kr" }], catalog: [{ name: "Honning", priceNok: 150 }] },
  // Review N3: a product whose name holds a filler word («norsk»).
  { id: id(7), name: NORSK, ...near(0.014), city: "Oslo", categories: ["honey"],
    products: [{ name: "Norsk honning", category: "honey", price: "180 kr" }], catalog: [{ name: "Norsk honning", priceNok: 180 }] },
  // Review B1: products that hold what a negated search asks to be without.
  { id: id(8), name: BAKER, ...near(0.016), city: "Oslo", categories: ["bakery"],
    products: [{ name: "Brød med gluten", category: "bakery", price: "60 kr" }, { name: "Bread with gluten", category: "bakery", price: "60 kr" }],
    catalog: [{ name: "Brød med gluten", priceNok: 60 }, { name: "Bread with gluten", priceNok: 60 }] },
  { id: id(9), name: MEIERI, ...near(0.018), city: "Oslo", categories: ["dairy"],
    products: [{ name: "Melk med laktose", category: "dairy", price: "25 kr" }], catalog: [{ name: "Melk med laktose", priceNok: 25 }] },
  // Review B2: products that hold what a reduced-amount search asks for less of.
  { id: id(10), name: SYLTERI, ...near(0.020), city: "Oslo", categories: ["bakery"],
    products: [{ name: "Syltetøy med sukker", category: "bakery", price: "70 kr" }], catalog: [{ name: "Syltetøy med sukker", priceNok: 70 }] },
  { id: id(11), name: SALTBAKER, ...near(0.022), city: "Oslo", categories: ["bakery"],
    products: [{ name: "Brød med salt", category: "bakery", price: "55 kr" }], catalog: [{ name: "Brød med salt", priceNok: 55 }] },
];

export async function runRfbSokMengdeFlerordTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ══════════════════════════════════════════════════════════════
  // Slice A: splitQueryQuantity (pure)
  // ══════════════════════════════════════════════════════════════
  {
    const { splitQueryQuantity, isQuantityOnly } = require("../utils/query-quantity") as typeof import("../utils/query-quantity");
    const cases: Array<[string, string, string[]]> = [
      ["biff 1kg", "biff", ["1kg"]],
      ["biff 1 kg", "biff", ["1 kg"]],
      ["1000g honning", "honning", ["1000g"]],
      ["0,5 kg smør", "smør", ["0,5 kg"]],
      ["smør 0.5kg", "smør", ["0.5kg"]],
      ["0,5kg honning", "honning", ["0,5kg"]],
      ["500 g kaffe", "kaffe", ["500 g"]],
      ["2 stk kyllingfilet", "kyllingfilet", ["2 stk"]],
      ["2stk egg", "egg", ["2stk"]],
      ["eplemost 3 l", "eplemost", ["3 l"]],
      ["fløte 3 dl", "fløte", ["3 dl"]],
      ["2 x 500 g kjøttdeig", "kjøttdeig", ["2 x 500 g"]],
      ["1 kg honning i Oslo", "honning i Oslo", ["1 kg"]],
      ["Honning, 1 kg", "Honning", ["1 kg"]],
    ];
    assertEq(cases.map(([q]) => { const r = splitQueryQuantity(q); return [r.product, r.quantities]; }), cases.map(([, p, qs]) => [p, qs]),
      "quantity: «1kg», «1 kg», «1000g», «0,5 kg», «0.5kg», «500 g», «2 stk», «2stk», «3 l», «3 dl» and «2 x 500 g» are taken out of the text");
    const untouched = ["5 gårder", "2 lam", "17. mai", "Lager 11", "12 egg", "honning", "Øl fra Lindheim", "kg", "biff kilo", "omega3", "b12g"];
    assertEq(untouched.map((q) => splitQueryQuantity(q)), untouched.map((q) => ({ product: q, quantities: [] })),
      "quantity: a unit must stand right after a number and end the word («5 gårder», «2 lam», «12 egg», «kg» alone and «b12g» hold none)");
    assertEq(["1kg", "500g", " 1 kg ", "0,5 kg", "2 stk", "(500 g)"].map(isQuantityOnly), [true, true, true, true, true, true],
      "quantity only: «1kg», «500g», «0,5 kg», «2 stk», «(500 g)» name no product");
    assertEq(["biff 1kg", "honning", "", "1"].map(isQuantityOnly), [false, false, false, false],
      "quantity only: a product word, an empty text or a bare number is not a quantity-only search");
  }

  const prevDb = __peekDbForTesting();
  const conn = new Database(":memory:");
  conn.pragma("journal_mode = DELETE");
  conn.pragma("foreign_keys = ON");
  __setDbForTesting(conn as any);
  __initSchemaForTesting(conn as any);
  seedCategoryLabelOfferFixtures(conn, sqliteTimestamp(new Date(Date.now() - 24 * 3600 * 1000)), SEEDS);
  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
  __clearGeocodeCacheForTesting();
  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  marketplaceRegistry._agentsCache = null;
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence module chatter */ };

  try {
    const { findOffers, offerSearchWords, isOfferClaimWord, OFFER_CLAIM_WORDS } =
      require("../services/catalog-offers") as typeof import("../services/catalog-offers");
    const { catalogRouter } = require("./marketplace-catalog") as typeof import("./marketplace-catalog");
    const mcp = require("./mcp") as typeof import("./mcp");
    const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
    mcp.registerTools({
      registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
      resource() {}, prompt() {}, registerResource() {}, registerPrompt() {},
    } as any, () => "test-client", () => undefined);
    const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");
    const producersIn = (text: string) => ALL.filter((n) => text.includes(n));
    const offers = async (q: string) => findOffers({ q, lat: O.lat, lng: O.lng, radiusKm: 50 }, { db: conn });
    const offerNames = (r: { offers: any[] }) => r.offers.map((o) => `${o.producer.name}: ${o.product_name}`);

    // ══════════════════════════════════════════════════════════════
    // Slice A: parseNaturalQuery
    // ══════════════════════════════════════════════════════════════
    {
      const parse = (q: string) => marketplaceRegistry.parseNaturalQuery(q) as any;
      assertEq(parse("biff 1kg")._unknownTerms ?? null, parse("biff")._unknownTerms ?? null,
        "parse: «biff 1kg» looks up the same words as «biff» (no «1kg»)");
      assertEq(parse("0,5kg biff")._unknownTerms ?? null, parse("biff")._unknownTerms ?? null,
        "parse: «0,5kg biff» never looks up «0» or «5kg»");
      assertTrue(!(parse("1kg")._unknownTerms ?? []).length && !(parse("500g")._unknownTerms ?? []).length,
        "parse: «1kg» and «500g» are no words to look up in the product names");
    }

    // ══════════════════════════════════════════════════════════════
    // Slice A: lokal_search (AC1, AC2)
    // ══════════════════════════════════════════════════════════════
    {
      const search = tools.get("lokal_search")!;
      const biff = textOf(await search({ query: "biff", limit: 10 }));
      const biff1kg = textOf(await search({ query: "biff 1kg", limit: 10 }));
      assertTrue(producersIn(biff).includes(BIFF), `lokal_search «biff» finds the biff producer (got ${JSON.stringify(producersIn(biff))})`);
      assertTrue(!biff1kg.includes(HONEY_1KG), "AC1: lokal_search «biff 1kg» does not list the honey producer with «Honning 1kg»");
      assertEq(producersIn(biff1kg), producersIn(biff), "AC1: lokal_search «biff 1kg» lists the same producers as «biff»");
      for (const q of ["1kg", "500g", "0,5 kg"]) {
        const t = textOf(await search({ query: q, limit: 10 }));
        assertEq(producersIn(t), [], `AC2: lokal_search «${q}» lists no producers`);
        assertTrue(/ikke en vare/.test(t) && /not a product/.test(t) && t.includes(`«${q}»`),
          `AC2: lokal_search «${q}» asks for a product, in Norwegian and English (got ${JSON.stringify(t.slice(0, 160))})`);
      }
      const honey = textOf(await search({ query: "honning", limit: 10 }));
      assertTrue(honey.includes(HONEY_1KG), "lokal_search «honning» still finds «Honning 1kg» (product names are untouched)");
    }

    // ══════════════════════════════════════════════════════════════
    // Slice A: findOffers (AC2, AC3)
    // ══════════════════════════════════════════════════════════════
    {
      const one = await offers("1kg");
      assertEq(one, { term: "1kg", offers: [], needs_product: true }, "AC2: findOffers «1kg» gives needs_product:true and no offers");
      const noPos = await findOffers({ q: "500 g" }, { db: conn });
      assertEq(noPos, { term: "500 g", offers: [], needs_product: true }, "findOffers «500 g» gives needs_product:true before any position is needed");
      const biff = await offers("biff");
      const biff1kg = await offers("biff 1kg");
      assertEq(Object.keys(biff), ["term", "offers"], "findOffers «biff»: a phrase that finds offers gives the same fields as before (no matched_term)");
      assertEq(offerNames(biff1kg), offerNames(biff), "AC3: findOffers «biff 1kg» gives the same offers as «biff»");
      assertTrue(offerNames(biff).length >= 2, `findOffers «biff» finds both biff producers (got ${JSON.stringify(offerNames(biff))})`);
      assertEq([biff1kg.term, biff1kg.matched_term], ["biff 1kg", "biff"], "findOffers «biff 1kg»: term is what was sent, matched_term what was searched");
      const honning = await offers("honning");
      const kgHonning = await offers("1 kg honning");
      assertEq(offerNames(kgHonning), offerNames(honning), "AC3: findOffers «1 kg honning» gives the same offers as «honning»");
      assertTrue(offerNames(honning).some((n) => n.startsWith(HONEY_1KG)), "findOffers «honning» still offers «Honning 1kg»");
      const rest = await callRoute(catalogRouter, "GET", "/offers?q=1kg&near=Oslo&radius_km=50&limit=5");
      assertEq([rest.status, rest.body?.needs_product, rest.body?.offers], [200, true, []],
        "GET /catalog/offers?q=1kg: the shared findOffers gives needs_product:true");
    }

    // ══════════════════════════════════════════════════════════════
    // Slice B: several words (AC4, AC5, AC6)
    // ══════════════════════════════════════════════════════════════
    {
      const lam = await offers("norsk lam");
      assertTrue(offerNames(lam).some((n) => n.startsWith(LAM)), `AC4: findOffers «norsk lam» offers lamb (got ${JSON.stringify(offerNames(lam))})`);
      assertEq([lam.term, lam.matched_term], ["norsk lam", "lam"], "findOffers «norsk lam»: matched_term says the filler word was left out");

      for (const q of ["økologisk honning", "honning økologisk", "norsk økologisk honning", "økologisk honning 500 g"]) {
        const r = await offers(q);
        assertEq(offerNames(r), [`${OKO}: Økologisk honning`], `AC5: findOffers «${q}» offers only the product with the organic word in its name`);
      }
      const okoLam = await offers("økologisk lam");
      assertEq(offerNames(okoLam), [], "AC5: findOffers «økologisk lam» is empty when no lamb has the organic word (never plain lamb)");
      const organic = await offers("organic honning");
      assertEq(offerNames(organic), [], "AC5: findOffers «organic honning» is empty (never plain honey)");

      const butchers = await offers("butchers cut biff");
      assertEq(offerNames(butchers), [], "AC6: findOffers «butchers cut biff» presents no plain biff");
      assertTrue(!("matched_term" in butchers), "AC6: an empty answer read by its words carries no matched_term");

      const both = await offers("biff tørrmodnet");
      assertEq(offerNames(both), [`${TORRMODNET}: Tørrmodnet biff`], "findOffers «biff tørrmodnet»: all words in one product name, never one of them");
      assertTrue(!("matched_term" in both), "findOffers «biff tørrmodnet»: the same words in another order carry no matched_term");

      // Review N3: the whole phrase first, unchanged when it finds something.
      const norsk = await offers("norsk honning");
      assertEq(offerNames(norsk), [`${NORSK}: Norsk honning`],
        "findOffers «norsk honning»: the whole phrase hits «Norsk honning», and the answer is not widened to all honey");
      assertEq(Object.keys(norsk), ["term", "offers"], "findOffers «norsk honning»: a whole-phrase hit carries no matched_term");

      // Review N2: a pure letter-case difference sets no matched_term; other words still do.
      const caseOnly = await offers("Biff Tørrmodnet");
      assertEq(offerNames(caseOnly), [`${TORRMODNET}: Tørrmodnet biff`], "findOffers «Biff Tørrmodnet» finds the dry-aged biff by its words");
      assertTrue(!("matched_term" in caseOnly), "N2: findOffers «Biff Tørrmodnet»: only the letter case differs, so no matched_term");
      const norskLam = await offers("Norsk Lam");
      assertEq(norskLam.matched_term, "lam", "N2: findOffers «Norsk Lam»: a word left out still gives matched_term");

      // Review B1: a negation is never read word by word (allergen-related false claim).
      for (const q of ["brød uten gluten", "melk uten laktose", "bread without gluten", "Brød UTEN gluten"]) {
        const r = await offers(q);
        assertEq(r, { term: q, offers: [] }, `B1: findOffers «${q}» is empty with no matched_term (never the product with it)`);
      }
      assertEq(offerNames(await offers("brød gluten")), [`${BAKER}: Brød med gluten`], "B1 control: «brød gluten» (no negation) is read by its words");
      const { OFFER_NEGATION_WORDS, hasOfferNegationWord } =
        require("../services/catalog-offers") as typeof import("../services/catalog-offers");
      const negLocked = ["uten", "utan", "uden", "ikke", "ingen", "fri", "without", "not", "no", "free"];
      assertEq(negLocked.filter((w) => !OFFER_NEGATION_WORDS.has(w)), [], "negation words: OFFER_NEGATION_WORDS holds every locked word");
      assertEq(["brød uten gluten", "Bread WITHOUT gluten", "melk, uten laktose", "ikke pasteurisert ost", "honning", "utenlandsk ost", "glutenfritt brød"].map(hasOfferNegationWord),
        [true, true, true, true, false, false, false], "negation words: by whole word and any case («utenlandsk», «glutenfritt» are one word)");

      // Review B2: a reduced amount («lite», a bare «0» …) is never read word by word (false reduced-sugar/salt claim).
      for (const q of ["syltetøy med lite sukker", "lite sukker syltetøy", "0 sukker syltetøy", "brød med lite salt", "syltetøy 0% sukker", "Syltetøy med LAV sukker"]) {
        const r = await offers(q);
        assertEq(r, { term: q, offers: [] }, `B2: findOffers «${q}» is empty with no matched_term (never the product with it)`);
      }
      const sylt = await offers("syltetøy sukker");
      assertEq([offerNames(sylt), sylt.matched_term], [[`${SYLTERI}: Syltetøy med sukker`], undefined],
        "B2 control: «syltetøy sukker» (no reduced amount) still finds «Syltetøy med sukker» by its words");
      const { OFFER_REDUCED_AMOUNT_WORDS, hasOfferReducedAmountWord } =
        require("../services/catalog-offers") as typeof import("../services/catalog-offers");
      const redLocked = ["lite", "litt", "lav", "lavt", "låg", "redusert", "redusere", "mindre", "minst", "null",
        "low", "less", "reduced", "lower", "zero", "light", "lett", "0", "0%"];
      assertEq(redLocked.filter((w) => !OFFER_REDUCED_AMOUNT_WORDS.has(w)), [], "reduced-amount words: OFFER_REDUCED_AMOUNT_WORDS holds every locked word and a bare «0» / «0%»");
      assertEq(["syltetøy med lite sukker", "LOW sugar jam", "0 sukker syltetøy", "syltetøy 0% sukker", "Light-yoghurt",
        "lettmelk", "lavendel honning", "honning", "10 egg", "500 g honning", "nullstilt"].map(hasOfferReducedAmountWord),
        [true, true, true, true, true, false, false, false, false, false, false],
        "reduced-amount words: by whole word and any case («lettmelk», «lavendel», «10», «500» do not count)");

      const mcpOffers = tools.get("lokal_find_offers")!;
      const viaMcp = JSON.parse(textOf(await mcpOffers({ items: ["norsk lam", "1kg"], lat: O.lat, lng: O.lng, radius_km: 50 })));
      assertEq([viaMcp[0].matched_term, viaMcp[0].offers.length > 0, viaMcp[1].needs_product], ["lam", true, true],
        "lokal_find_offers passes matched_term and needs_product through");
    }

    // ══════════════════════════════════════════════════════════════
    // Slice B: claim words are never left out (locked list)
    // ══════════════════════════════════════════════════════════════
    {
      const locked = ["økologisk", "økologiske", "økologi", "øko", "organic", "debio", "biodynamisk", "demeter"];
      assertEq(locked.filter((w) => !OFFER_CLAIM_WORDS.has(w)), [], "claim words: OFFER_CLAIM_WORDS holds every locked word");
      const everythingFiller = () => true;
      assertEq(locked.map((w) => offerSearchWords(`${w} honning`, everythingFiller)), locked.map((w) => [w]),
        "claim words: kept even when the filler lists hold them (every other word left out)");
      assertEq(["Økologisk", "DEBIO", "økomerket", "Debio-godkjent", "organically"].map(isOfferClaimWord), [true, true, true, true, true],
        "claim words: other forms and cases count too (organic-claims.ts isOrganicWord)");
      assertEq(["honning", "norsk", "økonomi"].map(isOfferClaimWord), [false, false, false], "claim words: «honning», «norsk» and «økonomi» are no claim words");
      assertEq(offerSearchWords("Jeg vil ha norsk lam 12"), ["lam"], "words: filler words and bare numbers are left out");
    }
  } finally {
    console.log = prevLog;
    __setGeocodingFetchForTesting(null as any);
    __clearGeocodeCacheForTesting();
    marketplaceRegistry._agentsCache = null;
    if (prevDb) __setDbForTesting(prevDb as any);
    conn.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbSokMengdeFlerordTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed) console.log(s.failures.join("\n"));
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
