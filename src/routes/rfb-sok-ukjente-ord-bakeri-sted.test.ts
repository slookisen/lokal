/**
 * rfb-sok-ukjente-ord-bakeri-sted.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-W (found live 2026-10-17):
 * the RFB search (parseNaturalQuery, discover() and lokal_search).
 *
 * - Unknown words (P2): «kransekake» is no keyword of the category map, so
 *   it became no product term and no name hit, and discover() returned its
 *   standard list, exactly as for «zzzqqx»; lokal_search said «fant 50
 *   produsenter» with no mark. Such words are now looked up in the product
 *   names, in the offers' catalog and by the offers' word rule (I-V), and a
 *   search they match nothing for says so: no list nationwide, and near a
 *   place the producers there, marked as no matches.
 * - Bakery (P2): the map's key was «bread», while the platform stores
 *   «bakery», so «brød», «bakervarer» and «bakeri» left out every
 *   producer with only «bakery». The key is now «bakery», a test pins the
 *   keys to search-enrich.ts PLATFORM_CATEGORIES, and the old «bread» still
 *   finds and is found by «bakery».
 * - Place words (P3): KNOWN_PLACE_WORDS had 30 cities and the fylker, so
 *   «kransekake i Bærum» became a name search for producers with «Bærum» in
 *   their name. A place word is now one the shared gazetteer has (every
 *   poststed, kommune, region and fylke). The name passes keep the old list,
 *   since a place can be part of a producer's name: «Valen Gård» is still
 *   looked up by name, and «Dyrøy» still finds «Dyrøymat» when nothing else
 *   does.
 * - B1: lokal_search answers searches without such words byte for byte as
 *   main did (tests/fixtures/rfb-sok-i-w-main.json, captured with
 *   lokalSearchTexts below on main 9be8825f), and the bakery searches keep
 *   every producer main found.
 *
 * Data: own fixtures through seedCategoryLabelOfferFixtures
 * (rfb-kategorietiketter-ikke-tilbud.test.ts) in an in-memory DB with the
 * production schema (restored in finally), geocoding offline (the hardcoded
 * cities still resolve). MCP tools through a duck-typed server. The frozen
 * MCP contract is pinned in rfb-mcp-contract-freeze.test.ts.
 *
 * Exported runRfbSokUkjenteOrdBakeriStedTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-sok-ukjente-ord-bakeri-sted.test.ts
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "../services/geocoding-service";
import { seedCategoryLabelOfferFixtures, sqliteTimestamp, type Seed, type CatalogRow } from "./rfb-kategorietiketter-ikke-tilbud.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const id = (n: number) => `1f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const GRINI = id(1), BAERUMNAVN = id(2), BYBAKST = id(3), FLATOY = id(4), TORGRIM = id(5), WALDERHAUG = id(6);
const RINGER = id(7), MANDEL = id(8), INNI = id(9);
const TRD_BAKERY = id(10), TRD_BREAD = id(11), TRD_HONEY = id(12), TRD_LABEL = id(13);
const SYLT_REAL = id(14), SYLT_LABEL = id(15);
const LAM = id(16), REIN = id(17), HONEY_VF = id(18), TORRFISK = id(19), OSTEGARDEN = id(20);
const VALEN = id(21), MATIBERGEN = id(22), DYROYMAT = id(23);

/** A producer whose knowledge products and catalog rows are the same names (and prices). */
function seed(n: string, name: string, lat: number, lng: number, city: string, categories: string[], catalog: CatalogRow[]): Seed {
  return {
    id: n, name, lat, lng, city, categories,
    products: catalog.map((c) => ({ name: c.name, category: c.category ?? categories[0], ...(c.priceNok ? { price: `${c.priceNok} kr` } : {}) })),
    catalog,
  };
}

/** The fixtures; the trust scores of the kransekake bakeries are their live ones (2026-10-17). */
export const I_W_SEEDS: Seed[] = [
  // Bærum (geocoding-service MAJOR_CITIES 59.8901, 10.5267, 25 km) and Oslo
  seed(GRINI, "Grini Hjemmebakeri Fixture", 59.935, 10.555, "Bærum", ["bakery"],
    [{ name: "Kransekake 18 ringer boks", priceNok: 395 }, { name: "Kransekake 18 ringer tårn", priceNok: 695 }, { name: "Surdeigsbrød", priceNok: 65 }]),
  seed(BAERUMNAVN, "Bærum Gårdsmat Fixture", 59.9, 10.5, "Bærum", ["vegetables", "eggs"], [{ name: "Egg", priceNok: 50 }, { name: "Poteter", priceNok: 25 }]),
  seed(BYBAKST, "Byens Bakst Fixture", 59.9139, 10.7522, "Oslo", ["bakery"], [{ name: "Kanelboller", priceNok: 35 }]),
  // The other kransekake bakeries, and the word rule
  seed(FLATOY, "Flatøy Hjemmebakeri Fixture", 59.2181, 10.9298, "Fredrikstad", ["bakery"],
    [{ name: "Kransekake bryllup" }, { name: "Kransekake konfirmasjon" }, { name: "Kransekake 18 ringer" }]),
  seed(TORGRIM, "Torgrim Hansen Bakeri Fixture", 58.1467, 7.9956, "Kristiansand", ["bakery"], [{ name: "Kransekake" }]),
  seed(WALDERHAUG, "Baker Walderhaug Fixture", 62.4722, 6.1549, "Ålesund", ["bakery"], [{ name: "Bløtkaker og kransekake" }]),
  seed(RINGER, "Ringbakeriet Fixture", 59.6687, 9.6502, "Kongsberg", ["bakery"], [{ name: "Kransekakeringer i pose", priceNok: 89 }]),
  seed(MANDEL, "Mandelbakeren Fixture", 60.7945, 11.068, "Hamar", ["bakery"], [{ name: "Mandelkransekake", priceNok: 450 }]),
  seed(INNI, "Minibakst Fixture", 61.1153, 10.4662, "Lillehammer", ["bakery"], [{ name: "Minikransekakebiter", priceNok: 79 }]),
  // Trondheim (63.4305, 10.3951): «bakery», the old «bread», and labels
  seed(TRD_BAKERY, "Nidaros Bakehus Fixture", 63.433, 10.4, "Trondheim", ["bakery"], [{ name: "Grovbrød", priceNok: 55 }]),
  seed(TRD_BREAD, "Elgeseter Lefsebu Fixture", 63.42, 10.39, "Trondheim", ["bread"], [{ name: "Lefse", priceNok: 40 }]),
  seed(TRD_HONEY, "Tirslaug Birøkt Fixture", 63.46, 10.46, "Trondheim", ["honey"], [{ name: "Lynghonning", priceNok: 150 }]),
  seed(TRD_LABEL, "Hevd Etikett Fixture", 63.44, 10.42, "Trondheim", ["bakery", "honey"], [{ name: "Honning" }, { name: "Bakervarer" }]),
  // Stavanger: a product and a category label for a word outside the map
  seed(SYLT_REAL, "Bærhagen Fixture", 58.97, 5.7331, "Stavanger", ["preserves"], [{ name: "Bringebærsyltetøy", priceNok: 120 }]),
  seed(SYLT_LABEL, "Gartneri Etikett Fixture", 58.96, 5.74, "Stavanger", ["preserves", "vegetables"], [{ name: "Syltetøy" }]),
  // The test sets of rfb-connectors-prep and chatgpt-app-submission.json
  seed(LAM, "Sygard Grytting Fixture", 61.58, 9.93, "Sør-Fron", ["meat"], [{ name: "Lammekjøtt", priceNok: 300 }]),
  seed(REIN, "Finnmark Kjøtt Fixture", 70.66, 23.68, "Hammerfest", ["meat"], [{ name: "Reinsdyrkjøtt", priceNok: 450 }]),
  seed(HONEY_VF, "TønsbergBier Fixture", 59.267, 10.408, "Tønsberg", ["honey"], [{ name: "Honning", priceNok: 150 }]),
  seed(TORRFISK, "Sverdrup Reine Fixture", 67.93, 13.09, "Reine", ["fish"], [{ name: "Tørrfisk", priceNok: 200 }]),
  seed(OSTEGARDEN, "Ostegården — Krokeide", 60.29, 5.27, "Bergen", ["dairy"], [{ name: "Lagret Fanaost", priceNok: 190 }]),
  // Name lookups: a farm named after its place, and a big place with a kind word
  seed(VALEN, "Valen Gård — Fixture", 59.84, 5.73, "Kvinnherad", ["meat"], [{ name: "Lammestek", priceNok: 320 }]),
  seed(MATIBERGEN, "Mat i Bergen — Fixture", 60.392, 5.324, "Bergen", ["meat", "fish"], [{ name: "Fiskesuppe", priceNok: 120 }]),
  seed(DYROYMAT, "Dyrøymat Fixture", 69.08, 17.6, "Dyrøy", ["other"], [{ name: "Fiskekaker", priceNok: 120 }]),
];
const TRUST: Array<[string, number]> = [[GRINI, 0.461], [FLATOY, 0.434], [TORGRIM, 0.268], [WALDERHAUG, 0.268], [RINGER, 0.9], [MANDEL, 0.8], [INNI, 0.9]];

/** Searches whose lokal_search answer must be byte-identical to main's (no word outside the map, no bakery word). */
export const B1_QUERIES: readonly string[] = [
  // chatgpt-app-submission.json test_cases and BRAND_ENTITIES.rfb.exampleQueries (rfb-connectors-prep)
  "Where can I buy reindeer meat in Finnmark?",
  "Find a farm in Vestfold with raw honey",
  "Which farms in Innlandet sell lamb?",
  "Tell me about Ostegården in Bergen — what do they make and how can I contact them?",
  "Where can I buy stockfish in Lofoten?",
  "What organic cheese producers are there in Norway?",
  "Find me a good pizza restaurant in Rome",
  // the Norwegian searches of I-N, I-S and I-V
  "honning nær Trondheim", "honning", "egg i Bærum", "ost Bergen", "Ostegården", "reinsdyrkjøtt Finnmark",
  "tørrfisk Lofoten", "lam i Innlandet", "honning Vestfold", "Grini", "Valen Gård",
];
/** Bakery searches: every producer main found must still be found. */
export const BAKERY_QUERIES: readonly string[] = ["bakervarer i Trondheim", "brød Trondheim", "bakeri Trondheim", "bakery in Trondheim"];

const MAIN_TEXTS_FIXTURE = path.join(__dirname, "../../tests/fixtures/rfb-sok-i-w-main.json");

/** Opens an in-memory DB with the fixtures and makes it the getDb() singleton. */
function openFixtureDb(seeds: readonly Seed[] = I_W_SEEDS): Database.Database {
  const conn = new Database(":memory:");
  conn.pragma("journal_mode = DELETE");
  conn.pragma("foreign_keys = ON");
  __setDbForTesting(conn as any);
  __initSchemaForTesting(conn as any);
  seedCategoryLabelOfferFixtures(conn, sqliteTimestamp(new Date(Date.now() - 24 * 3600 * 1000)), seeds);
  const setTrust = conn.prepare("UPDATE agents SET trust_score = ? WHERE id = ?");
  for (const [agentId, trust] of TRUST) setTrust.run(trust, agentId);
  return conn;
}

type ToolMap = Map<string, (args: any, extra?: any) => Promise<any>>;

function captureTools(): ToolMap {
  const mcp = require("./mcp") as typeof import("./mcp");
  const tools: ToolMap = new Map();
  mcp.registerTools({
    registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
    resource() {}, prompt() {}, registerResource() {}, registerPrompt() {},
  } as any, () => "test-client", () => undefined);
  return tools;
}

const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");

/**
 * lokal_search's text for each query, and lokal_discover's for the two
 * bakery keys near Trondheim, on the fixtures (BASE_URL unset, client
 * test-client, geocoding offline). Uses only what main has, so main's texts
 * are captured with it: tests/fixtures/rfb-sok-i-w-main.json.
 */
export async function lokalSearchTexts(queries: readonly string[] = [...B1_QUERIES, ...BAKERY_QUERIES]): Promise<Record<string, string>> {
  const prevDb = __peekDbForTesting();
  const prevBaseUrl = process.env.BASE_URL;
  delete process.env.BASE_URL;
  const db = openFixtureDb();
  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
  __clearGeocodeCacheForTesting();
  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  marketplaceRegistry._agentsCache = null;
  const prevLog = console.log;
  console.log = () => { /* silence module chatter */ };
  try {
    const tools = captureTools();
    const out: Record<string, string> = {};
    for (const q of queries) out[q] = textOf(await tools.get("lokal_search")!({ query: q, limit: 10 }));
    for (const c of ["bread", "bakery"]) {
      out[`lokal_discover:${c}`] = textOf(await tools.get("lokal_discover")!({ categories: [c], lat: 63.4305, lng: 10.3951, maxDistanceKm: 30, limit: 10 }));
    }
    return out;
  } finally {
    console.log = prevLog;
    if (prevBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = prevBaseUrl;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    marketplaceRegistry._agentsCache = null;
    db.close();
    if (prevDb) __setDbForTesting(prevDb as any);
  }
}

/** The producer names of a lokal_search / lokal_discover text, in the order shown. */
function namesIn(text: string): string[] {
  return [...text.matchAll(/^\*\*\d+\. (.+?)(?: — Kategoritreff[^*]*)?\*\*/gm)].map((m) => m[1]);
}

export async function runRfbSokUkjenteOrdBakeriStedTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // B1 first: lokalSearchTexts opens (and closes) its own DB.
  const texts = await lokalSearchTexts();

  const prevDb = __peekDbForTesting();
  const prevBaseUrl = process.env.BASE_URL;
  delete process.env.BASE_URL;
  const db = openFixtureDb();
  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
  __clearGeocodeCacheForTesting();
  const { marketplaceRegistry, isPlaceWord, placeWordsIn, sameCategoryKey, categoryValueMatches, PRODUCT_CATEGORY_KEYWORDS } =
    require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  marketplaceRegistry._agentsCache = null;
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence module chatter */ };

  try {
    const { PLATFORM_CATEGORIES } = require("../services/search-enrich") as typeof import("../services/search-enrich");
    const tools = captureTools();
    const parse = (q: string) => marketplaceRegistry.parseNaturalQuery(q) as ReturnType<typeof marketplaceRegistry.parseNaturalQuery> & { _nameQuery?: string };
    const ids = (r: Array<{ agent: { id: string } }>) => r.map((x) => x.agent.id);
    const search = async (q: string) => textOf(await tools.get("lokal_search")!({ query: q, limit: 10 }));

    // ══════════════════════════════════════════════════════════════
    // B1: unchanged answers for the test sets, more for bakery
    // ══════════════════════════════════════════════════════════════
    {
      const main = JSON.parse(fs.readFileSync(MAIN_TEXTS_FIXTURE, "utf8")) as Record<string, string>;
      for (const q of B1_QUERIES) {
        const at = [...(texts[q] ?? "")].findIndex((ch, i) => ch !== [...(main[q] ?? "")][i]);
        assertTrue(texts[q] === main[q], `B1 «${q}»: lokal_search answers byte for byte as main`
          + (texts[q] === main[q] ? "" : ` (first difference at ${at}: ${JSON.stringify(String(texts[q]).slice(Math.max(0, at - 40), at + 80))})`));
      }
      // (The Rome search is answered before the parser: Norway only.)
      assertTrue(B1_QUERIES.filter((q) => !q.endsWith("in Rome")).every((q) => !("_unknownTerms" in parse(q))),
        "B1: none of these searches has a word the parser cannot read");
      assertTrue(namesIn(main["Which farms in Innlandet sell lamb?"]).includes("Sygard Grytting Fixture")
        && namesIn(main["Where can I buy reindeer meat in Finnmark?"]).includes("Finnmark Kjøtt Fixture")
        && namesIn(main["Find a farm in Vestfold with raw honey"]).includes("TønsbergBier Fixture")
        && namesIn(main["Where can I buy stockfish in Lofoten?"]).includes("Sverdrup Reine Fixture")
        && main["Tell me about Ostegården in Bergen — what do they make and how can I contact them?"].includes("Ostegården — Krokeide"),
      "B1 setup: main finds the test sets' producers in the fixtures (so «byte for byte» compares real answers)");
      for (const q of [...BAKERY_QUERIES, "lokal_discover:bread", "lokal_discover:bakery"]) {
        const before = namesIn(main[q]);
        const after = namesIn(texts[q]);
        assertTrue(before.every((n) => after.includes(n)) && after.length > before.length,
          `B1 «${q}»: every producer main found is still found, and more (main ${JSON.stringify(before)}, now ${JSON.stringify(after)})`);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // Bakery: the keys are the platform's, and «bread» = «bakery»
    // ══════════════════════════════════════════════════════════════
    {
      const keys = Object.keys(PRODUCT_CATEGORY_KEYWORDS);
      assertEq(keys.filter((k) => !PLATFORM_CATEGORIES.includes(k)), ["berries"],
        "keys: every key of the search's category map is a platform category (search-enrich.ts PLATFORM_CATEGORIES), but «berries» (sold under fruit)");
      assertTrue(keys.includes("bakery") && !keys.includes("bread"), "keys: the baked-goods key is «bakery», not «bread»");
      assertEq(["bakervarer i Trondheim", "brød", "bakeri Trondheim", "bakery in Trondheim", "lefse Voss", "bread Oslo"].map((q) => parse(q).categories),
        [["bakery"], ["bakery"], ["bakery"], ["bakery"], ["bakery"], ["bakery"]],
        "parser: «bakervarer», «brød», «bakeri», English «bakery» and «bread», and «lefse» give «bakery»");
      assertEq([parse("bær").categories, parse("brunost og egg").categories], [["berries"], ["dairy", "eggs"]], "parser: the other keys are as before");
      assertEq([sameCategoryKey("bread", "bakery"), sameCategoryKey("Bakery", "BREAD"), sameCategoryKey("berries", "fruit"), sameCategoryKey("bakeri", "bakery")],
        [true, true, false, false], "sameCategoryKey: «bread» is «bakery» either way and in any case; «berries» stays apart from «fruit»; the stray «bakeri» is no key");
      assertEq([categoryValueMatches("bread", "bakery"), categoryValueMatches("bakery", "bread"), categoryValueMatches("beverages", "beverages"),
        categoryValueMatches("Fresh vegetables", "vegetables"), categoryValueMatches("fruit", "berries"), categoryValueMatches("berries", "fruit")],
      [true, true, true, true, false, false],
      "categoryValueMatches: the old «bread» and «bakery» match each other, a stored value containing the searched one matches as before, «fruit» and «berries» do not");

      const near = { lat: 63.4305, lng: 10.3951 };
      const bakeries = marketplaceRegistry.discover({ ...parse("bakervarer"), location: near, maxDistanceKm: 30, limit: 20 }, undefined, { trackDiscovery: false });
      assertEq(ids(bakeries).sort(), [TRD_BAKERY, TRD_BREAD, TRD_LABEL].sort(),
        "«bakervarer i Trondheim» (acceptance criterion): the «bakery» producers, and the one with the old «bread»; not the beekeeper");
      const breadFilter = marketplaceRegistry.discover({ categories: ["bread"], location: near, maxDistanceKm: 30, limit: 20 } as any, undefined, { trackDiscovery: false });
      assertEq(ids(breadFilter).sort(), [TRD_BAKERY, TRD_BREAD, TRD_LABEL].sort(),
        "structured «bread» (lokal_discover's frozen description lists it) also finds the «bakery» producers");
      assertTrue(bakeries.every((r) => r.matchReasons.some((m) => m.startsWith("Kategorier:"))),
        "relevance: the «bakery» and «bread» producers both get the category match reason");
      const lefse = marketplaceRegistry.discover({ ...parse("lefse"), location: near, maxDistanceKm: 30, limit: 20 }, undefined, { trackDiscovery: false });
      assertEq(ids(lefse)[0], TRD_BREAD, "product term «lefse»: the producer with «Lefse» ranks first");
      assertTrue(ids(lefse).includes(TRD_BAKERY),
        "product term: a «bakery» producer without the product is still kept for the category, as a producer with the old «bread» was");
      const bakeryText = await search("bakervarer i Trondheim");
      assertTrue(/\*\*\d+\. Hevd Etikett Fixture — Kategoritreff/.test(bakeryText) && !/Nidaros Bakehus Fixture — Kategoritreff/.test(bakeryText),
        "lokal_search «bakervarer i Trondheim»: the label-only producer is marked a category match, the bakery with «Grovbrød» is not (I-N keeps working under «bakery»)");
    }

    // ══════════════════════════════════════════════════════════════
    // Place words from the gazetteer
    // ══════════════════════════════════════════════════════════════
    {
      assertEq(["Bærum", "baerum", "Sandvika", "Aurskog-Høland", "Oppdal", "Lofoten", "Vestland", "Hordaland", "Norge", "Tromso"].map(isPlaceWord),
        [true, true, true, true, true, true, true, true, true, true],
        "isPlaceWord: a kommune (also in ASCII), a poststed, a hyphenated kommune, a region, a fylke (also the old Hordaland), the country, an ASCII city");
      assertEq(["kransekake", "honning", "Grini", "zzzqqx", "", "egg"].map(isPlaceWord), [false, false, false, false, false, false],
        "isPlaceWord: a food word, a farm name that is no place, nonsense and nothing are no place words");
      const oldList = ["oslo", "bergen", "trondheim", "stavanger", "tromsø", "tromso", "kristiansand", "drammen", "fredrikstad", "bodø", "bodo",
        "ålesund", "alesund", "tønsberg", "tonsberg", "haugesund", "sandnes", "lillestrøm", "lillestrom", "hamar", "lillehammer", "sandefjord",
        "sarpsborg", "skien", "molde", "moss", "asker", "kongsberg", "porsgrunn", "arendal", "larvik", "halden", "vestland", "viken", "rogaland",
        "trøndelag", "trondelag", "nordland", "innlandet", "troms", "finnmark", "agder", "vestfold", "telemark", "østfold", "ostfold", "akershus",
        "buskerud", "oppland", "hedmark", "sogn", "fjordane", "møre", "more", "romsdal", "grünerløkka", "grunerlokka", "frogner", "majorstuen", "sentrum"];
      assertEq(oldList.filter((w) => !isPlaceWord(w)), [], "isPlaceWord: every word of the list it replaces is still a place word");
      assertTrue(["møre", "og", "romsdal"].every((w) => placeWordsIn("honning i Møre og Romsdal").has(w)) && placeWordsIn("egg Mo i Rana").has("mo"),
        "placeWordsIn: every word of a multi-word place («Møre og Romsdal», «Mo i Rana»)");

      for (const q of ["kransekake i Bærum", "Hvor kan jeg kjøpe kransekake i Bærum?"]) {
        const p = parse(q);
        assertEq([p._nameQuery, p._unknownTerms], [undefined, ["kransekake"]],
          `«${q}» (repro): no name search for producers with «Bærum» in the name; «kransekake» goes to the product names`);
      }
      assertEq([parse("Valen Gård")._nameQuery, parse("Tell me about Valen Gård in Kvinnherad")._nameQuery, parse("Bjørndal Gård Oppdal")._nameQuery],
        ["Valen Gård", "Valen Gård", "Bjørndal Gård Oppdal"],
        "Pass 0 and Pass 1: a place can be part of a producer's name («Valen Gård», also inside a question), so the name passes keep it, as before");
      const named = (nameQuery: string) => marketplaceRegistry.discover({ role: "producer", _nameQuery: nameQuery, limit: 20 } as any, undefined, { trackDiscovery: false });
      assertEq([parse("Grini Bærum")._nameQuery, ids(named("Grini Bærum"))], ["Grini Bærum", [GRINI]],
        "fuzzy name match: «Grini Bærum» finds Grini by its own word first, not every producer with «Bærum» in the name");
      assertEq(ids(named("Dyrøy Fiskemat")), [DYROYMAT],
        "fuzzy name match: when the other words find nobody, the place word is tried («Dyrøy» finds «Dyrøymat», as before)");
      assertEq([parse("mat i Bergen")._nameQuery, parse("Tromsø bakeri")._nameQuery], [undefined, undefined],
        "Pass 0: a big place and a kind word («Mat i Bergen») stays a search, not a lookup of the producer called that");
      assertEq([parse("fersk fisk i Bergen").categories, parse("fersk fisk i Bergen")._nameQuery], [["fish"], undefined], "Pass 2: «fersk fisk i Bergen» as before");
      const egg = await search("egg i Bærum");
      assertTrue(egg.includes("Bærum Gårdsmat Fixture") && !egg.includes("Grini"), "lokal_search «egg i Bærum»: the egg producer in Bærum, by category");
    }

    // ══════════════════════════════════════════════════════════════
    // Unknown words: the parser
    // ══════════════════════════════════════════════════════════════
    {
      assertEq([parse("kransekake")._unknownTerms, parse("zzzqqx")._unknownTerms, parse("syltetøy")._unknownTerms],
        [["kransekake"], ["zzzqqx"], ["syltetøy"]], "parser: a word outside the map, no place and no producer name is an unknown word");
      assertEq([parse("kransekake").categories, parse("kransekake")._productTerms, parse("kransekake")._nameQuery], [undefined, undefined, undefined],
        "parser: an unknown word sets no category, product term or name query");
      assertEq(["honning nær Trondheim", "egg i Bergen", "god ost i Bergen", "Grini", "mat i Trondheim", "produsenter i Trondheim", "nær meg", "bondens marked Oslo"]
        .map((q) => parse(q)._unknownTerms), [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined],
      "parser: no unknown word next to a category («god ost»), for a producer name, a generic word («mat», «produsenter», «bondens marked») or a filler");
      assertEq([parse("økologisk kransekake").tags, parse("økologisk kransekake")._unknownTerms], [["organic"], ["kransekake"]],
        "parser: a tag word is no unknown word, and the tag stays");
      assertEq(parse("ferske kransekaker")._unknownTerms, ["kransekaker"], "parser: a word that starts with a tag word («ferske») is the tag's");
      assertEq(parse("kransekake 18 ringer 2026")._unknownTerms, ["kransekake", "ringer"], "parser: numbers are no words");
      assertEq(parse("alfa beta gamma delta epsilon")._unknownTerms, ["alfa", "beta", "gamma", "delta"], "parser: at most four words");
    }

    // ══════════════════════════════════════════════════════════════
    // Unknown words: discover() looks them up in the product names
    // ══════════════════════════════════════════════════════════════
    {
      const meta: any = {};
      const krans = marketplaceRegistry.discover({ ...parse("kransekake"), limit: 20 }, meta, { trackDiscovery: false });
      assertEq(ids(krans), [GRINI, FLATOY, TORGRIM, WALDERHAUG, MANDEL, RINGER],
        "«kransekake» (acceptance criterion): Grini first; a whole word before a compound head («Mandelkransekake») before a word start "
        + "(«Kransekakeringer»), whatever the trust; relevance (trust) within each; not «Minikransekakebiter» (inside a word), and no other producer");
      assertEq(meta.productMatches?.get(GRINI), ["Kransekake 18 ringer boks", "Kransekake 18 ringer tårn"],
        "discover meta: the matching product names (for lokal_search's labels and «Produkter:»)");
      assertTrue(krans[0].matchReasons.some((m) => m.startsWith("Produkter: Kransekake 18 ringer boks")), "discover: the «Produkter:» match reason");
      assertEq(meta.unmatchedTerms, undefined, "discover meta: no unmatchedTerms when a product matches");

      const two = marketplaceRegistry.discover({ ...parse("kransekake bryllup"), limit: 20 }, undefined, { trackDiscovery: false });
      assertEq(ids(two)[0], FLATOY, "two words: the producer whose products name both («Kransekake bryllup») comes before Grini");

      const baerum = marketplaceRegistry.discover({ ...parse("kransekake i Bærum"), location: { lat: 59.8901, lng: 10.5267 }, maxDistanceKm: 25, limit: 20 },
        undefined, { trackDiscovery: false });
      assertEq(ids(baerum), [GRINI], "«kransekake i Bærum» (acceptance criterion): Grini, not «Bærum Gårdsmat» (the name) nor the Oslo bakery (no kransekake)");

      const nullMeta: any = {};
      assertEq(ids(marketplaceRegistry.discover({ ...parse("zzzqqx"), limit: 50 }, nullMeta, { trackDiscovery: false })), [],
        "«zzzqqx» (acceptance criterion): no standard list");
      assertEq(nullMeta.unmatchedTerms, ["zzzqqx"], "discover meta: unmatchedTerms names the words");
      const areaMeta: any = {};
      const area = marketplaceRegistry.discover({ ...parse("zzzqqx"), location: { lat: 59.8901, lng: 10.5267 }, maxDistanceKm: 25, limit: 50 }, areaMeta,
        { trackDiscovery: false });
      assertEq([ids(area).sort(), areaMeta.unmatchedTerms], [[GRINI, BAERUMNAVN, BYBAKST].sort(), ["zzzqqx"]],
        "near a place: the producers there stay, with unmatchedTerms for the caller to say they are no matches");

      const sylt = marketplaceRegistry.discover({ ...parse("syltetøy"), limit: 20 }, undefined, { trackDiscovery: false });
      assertEq(ids(sylt), [SYLT_REAL, SYLT_LABEL],
        "«syltetøy»: «Bringebærsyltetøy» (a product, compound head) before the category label «Syltetøy» (a whole word, but a label)");

      const tagMeta: any = {};
      const tagged = marketplaceRegistry.discover({ ...parse("økologisk kransekake"), limit: 20 }, tagMeta, { trackDiscovery: false });
      assertEq([ids(tagged)[0], tagMeta.tagsRelaxed], [GRINI, true],
        "a tag is weighed against the producers with the product: none is organic, so the tag is dropped (tagsRelaxed), not the product");

      const guard = marketplaceRegistry.discover({ role: "producer", _productTerms: ["lefse"], _unknownTerms: ["zzzqqx"], limit: 50 } as any, undefined,
        { trackDiscovery: false });
      assertTrue(guard.length > 0 && ids(guard)[0] === TRD_BREAD, "guard: unknown words are left alone next to product terms");

      const counted = (agentId: string) => (db.prepare("SELECT discovery_count AS c FROM agents WHERE id = ?").get(agentId) as { c: number }).c;
      const before = counted(GRINI);
      marketplaceRegistry.discover({ ...parse("kransekake"), limit: 1 });
      assertEq([counted(GRINI) - before, counted(FLATOY)], [1, 0], "discovery count: only what the page shows is counted, as before");

      // The catalog cannot be read: the words are left alone (the old answer), not an empty one.
      db.exec("ALTER TABLE products RENAME TO products_gone");
      const unread: any = {};
      const old = marketplaceRegistry.discover({ ...parse("kransekake"), limit: 50 }, unread, { trackDiscovery: false });
      db.exec("ALTER TABLE products_gone RENAME TO products");
      assertTrue(old.length === I_W_SEEDS.length && unread.unmatchedTerms === undefined,
        `no catalog: discover() answers as before I-W (${old.length} producers, no unmatchedTerms)`);
    }

    // ══════════════════════════════════════════════════════════════
    // Unknown words: lokal_search's text
    // ══════════════════════════════════════════════════════════════
    {
      const krans = await search("kransekake");
      assertEq(namesIn(krans), ["Grini Hjemmebakeri Fixture", "Flatøy Hjemmebakeri Fixture", "Torgrim Hansen Bakeri Fixture", "Baker Walderhaug Fixture",
        "Mandelbakeren Fixture", "Ringbakeriet Fixture"], "lokal_search «kransekake»: the producers with kransekake, Grini first");
      assertTrue(krans.includes("— fant 6 produsenter:") && !krans.includes("Kategoritreff") && krans.includes("🛒"),
        "lokal_search «kransekake»: «fant 6 produsenter», none marked a category match");

      const nothing = await search("zzzqqx");
      assertEq(nothing, "🔎 Ingen produsent har «zzzqqx» i produktlista eller i navnet, så søket gir ingen treff. "
        + "Prøv et annet ord, en kategori (for eksempel «bakervarer» eller «honning») eller et produsentnavn. / "
        + "No producer lists «zzzqqx» as a product or has it in its name, so there are no matches. "
        + "Try another word, a category (for example «bakery» or «honey») or a producer name.",
      "lokal_search «zzzqqx» (acceptance criterion): an honest null answer, no producer and no «fant»");

      const baerum = await search("kransekake i Bærum");
      assertEq(namesIn(baerum), ["Grini Hjemmebakeri Fixture"], "lokal_search «kransekake i Bærum» (acceptance criterion): Grini");

      const area = await search("zzzqqx i Bærum");
      assertTrue(area.startsWith("🔎 Ingen produsent i området har «zzzqqx» i produktlista. Listen under er produsentene i området, ikke treff på «zzzqqx»;")
        && area.includes("— 3 produsenter i området, ikke treff på «zzzqqx»:") && !area.includes("fant ") && !area.includes("Kategoritreff")
        && namesIn(area).length === 3,
      `lokal_search «zzzqqx i Bærum»: the producers in the area, said to be no matches (got ${JSON.stringify(area.slice(0, 400))})`);

      const sylt = await search("syltetøy");
      assertEq(namesIn(sylt), ["Bærhagen Fixture", "Gartneri Etikett Fixture"], "lokal_search «syltetøy»: the product first");
      assertTrue(/\*\*2\. Gartneri Etikett Fixture — Kategoritreff \/ category-only: «syltetøy» bare som kategorinavn/.test(sylt)
        && !/Bærhagen Fixture — Kategoritreff/.test(sylt),
        "lokal_search «syltetøy»: the category label is marked «Kategoritreff … bare som kategorinavn», the product is not");
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
  runRfbSokUkjenteOrdBakeriStedTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
