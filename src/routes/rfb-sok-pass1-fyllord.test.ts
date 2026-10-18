/**
 * rfb-sok-pass1-fyllord.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-W3 (FUNN rfb-sok-pass1-fyllord,
 * review of lokal#1163, I-W2, rounds 3 and 4): the RFB search
 * (parseNaturalQuery, discover() and lokal_search).
 *
 * - A name indicator («mat», «gård», «bakeri» …) counts only as a whole word.
 *   «mat» counted at the end of every word, so «kortreist sjømat», «tomat fra
 *   Hardanger» and «grillmat i Bergen» went to Pass 1 and became name
 *   searches. A word that only ends in an indicator still counts when it is
 *   the whole search (read as before) or a whole word of a producer name
 *   («Spekemat» in «Bjerke Spekemat & Delikatesse», «Sjømat» in «Hitra Sjømat»).
 * - Pass 1 read neither NO_PRODUCT_WORDS nor QUALIFIER_WORDS. «kortreist mat»,
 *   «sunn mat», «kortreist sjømat», «naturlig sjømat» and «sunn sjømat» were
 *   name searches for «Kortreist Italiener», «Sunnmørsmat» and «Overnaturlig
 *   Honning» (main too), and «Finnes det noen bakeri som lager kransekake»
 *   one for «Finnes noen lager kransekake». The filler and qualifier words now
 *   make no name search in Pass 1, and next to a category word a name word
 *   must sit inside a producer name.
 * - «bakeri» as the only product term gives way to a word the parser cannot
 *   read, as «bakeries» does (I-W2): «kransekake fra bakeri» put the producers
 *   with «… fra eget bakeri» in a product name first.
 * - The name query of both passes leaves out the filler and qualifier words
 *   («kortreist såper», «kortreist mat fra Valen gård»). They stay when the
 *   words left have no distinctive word in a producer name («When is the next
 *   Bondens marked in Oslo?», «stor zzzqqx», a search of filler words only),
 *   and a filler word stays when a producer name holds it as a whole word
 *   together with a distinctive word of the search. Review round 1 (B2): they
 *   stayed only when one name held every word of the search, so «Tell me
 *   about Den Gode Baker» and «Den Gode Baker Sandefjord» lost «Den Gode» and
 *   missed Den Gode Baker.
 * - Next to an indicator word a qualifier word counts no more than next to a
 *   category word («sunn mat» reads as «mat»), and «gourmet», «artisan» and
 *   «artisanal» are qualifier words (FUNN rfb-sok-egenskapsord-hale).
 * - Review round 1 (S1): «finner» is a filler word («Hvor finner jeg kortreist
 *   mat i Oslo?» was the name search «finner mat», for Finnerud Gård).
 * - Review round 1 (B1): the cost of a long search. A word with other
 *   characters than letters that ends in an indicator («x-mat») was matched
 *   against every producer name, for each such word: a 1 MB search took 33 s.
 * - B1: a search of one word, the producer names and the name searches that
 *   Pass 1 reads («Bjerke Spekemat & Delikatesse», «Dyrøy Sjømat», «When is the
 *   next Bondens marked in Oslo?»), and names with filler words with more
 *   words around them («Den Gode Baker Sandefjord»), answer byte for byte as on I-W2
 *   (tests/fixtures/rfb-sok-i-w3-main.json, captured with pass1MainTexts below
 *   on main ad67dba6).
 *
 * Data: the fixtures of I-W and I-W2 (I_W_SEEDS, I_W2_SEEDS) plus I_W3_SEEDS,
 * in an in-memory DB with the production schema (restored in finally),
 * geocoding offline. MCP tools through a duck-typed server. The frozen MCP
 * contract is pinned in rfb-mcp-contract-freeze.test.ts.
 *
 * Exported runRfbSokPass1FyllordTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-sok-pass1-fyllord.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Seed, CatalogRow } from "./rfb-kategorietiketter-ikke-tilbud.test";
import { I_W_SEEDS, enterFixtures, captureTools, textOf, namesIn } from "./rfb-sok-ukjente-ord-bakeri-sted.test";
import { I_W2_SEEDS } from "./rfb-sok-fyllord-navnekapring.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const id = (n: number) => `1f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// I-W's and I-W2's ids that the expectations name
const GRINI = id(1), FLATOY = id(4), TORGRIM = id(5), WALDERHAUG = id(6), RINGER = id(7), MANDEL = id(8);
const VALEN = id(21), DYROYMAT = id(23), BONDENS_KOLONIAL = id(104), KORTREIST_NAVN = id(131);
// The producers of the review's repro (live 2026-10-17), and one that bakes with «bakeri» in a product name
const SUNNMORSMAT = id(141), OVERNATURLIG = id(142), REINE_SAPER = id(143), AARVIK = id(144), BJERKE = id(145), HANSSEN = id(146);
const KNEIPPEN = id(147);
// The whole-word indicator: «Sjømat» as a word of a name, and words that only end in «mat»
const HITRA = id(148), SORFJORD = id(149), HARDANGER_SAFT = id(150), FJORDGRILL = id(151);
// A filler word inside a word of a name («ren» in «Grenland»), and a generic word in a name («marked» in «Matmarked»)
const GRENLAND = id(152), SOLLI = id(153), MATMARKED = id(154);
// Review round 1 (B2): names with filler words («Den», «Gode», «Norsk», «Topp»), and producers that share their
// distinctive word (live 2026-10-17); I-W2's «Topp Sopp Fixture»
const DEN_GODE_BAKER = id(155), NORSK_ULLGRIS = id(156), SETESDAL_ULLGRIS = id(157), HELLA_SOPPERI = id(158), TOPP = id(107);
// Review round 1 (B1, S1): a word of a name with a character other than a letter that ends in «mat», and a name «finner» begins
const AR_SJOMAT = id(159), FINNERUD = id(160);

/** A producer whose knowledge products and catalog rows are the same names (and prices). */
function seed(n: string, name: string, lat: number, lng: number, city: string, categories: string[], catalog: CatalogRow[]): Seed {
  return {
    id: n, name, lat, lng, city, categories,
    products: catalog.map((c) => ({ name: c.name, category: c.category ?? categories[0], ...(c.priceNok ? { price: `${c.priceNok} kr` } : {}) })),
    catalog,
  };
}

export const I_W3_SEEDS: Seed[] = [
  seed(SUNNMORSMAT, "Sunnmørsmat Fixture", 62.68, 6.4, "Haramsøy", ["meat"], [{ name: "Fenalår", priceNok: 320 }]),
  seed(OVERNATURLIG, "Overnaturlig Honning Fixture", 59.6, 9.9, "Hokksund", ["honey"], [{ name: "Lynghonning", priceNok: 160 }]),
  seed(REINE_SAPER, "Reine Såper Fixture", 68.56, 14.91, "Stokmarknes", ["other"], [{ name: "Naturlige såper", priceNok: 89 }]),
  // «Brød og boller fra eget bakeri» (live: Aarvik Gård), with a trust that puts it first on relevance
  seed(AARVIK, "Aarvik Gård Fixture", 60.4, 5.3, "Bergen", ["bakery"], [{ name: "Brød og boller fra eget bakeri", priceNok: 60 }]),
  // a name Pass 1 finds through the indicator at the end of «Spekemat» (live: «Bjerke Spekemat & Delikatesse AS»)
  seed(BJERKE, "Bjerke Spekemat & Delikatesse AS Fixture", 59.95, 10.9, "Oslo", ["meat"], [{ name: "Fenalår", priceNok: 300 }]),
  seed(HANSSEN, "H.A. Hanssen Fixture", 69.65, 18.96, "Tromsø", ["other"], [{ name: "Kaffe", priceNok: 99 }]),
  // the quality-word tail next to a category word
  seed(KNEIPPEN, "Kneippen Fixture", 59.91, 10.73, "Oslo", ["bakery"],
    [{ name: "Gourmetbrød med valnøtter", priceNok: 75 }, { name: "Artisan surdeigsbrød", priceNok: 69 }]),
  // «Sjømat» as a whole word of a name (live: «Trøndelag Sjømat — Tiller», «Hitra Sjømat»)
  seed(HITRA, "Hitra Sjømat Fixture", 63.6, 8.97, "Hitra", ["fish"], [{ name: "Laks", priceNok: 220 }]),
  // «tomat fra Hardanger»: a tomato grower («tomat» inside the word «Tomatgård», no whole word), and a producer named after Hardanger
  seed(SORFJORD, "Sørfjord Tomatgård Fixture", 60.07, 6.55, "Odda", ["vegetables"], [{ name: "Tomater", priceNok: 45 }]),
  seed(HARDANGER_SAFT, "Hardanger Saft Fixture", 60.33, 6.65, "Lofthus", ["beverages"], [{ name: "Eplesaft", priceNok: 79 }]),
  // «grillmat»: a product word that ends in «mat» and is no word of a name
  seed(FJORDGRILL, "Fjordgrill Fixture", 60.39, 5.33, "Bergen", ["meat"], [{ name: "Grillmat til hytta", priceNok: 249 }]),
  seed(GRENLAND, "Grenland Krydderhage Fixture", 59.14, 9.65, "Porsgrunn", ["herbs"], [{ name: "Timian", priceNok: 39 }]),
  seed(SOLLI, "Solli Krydderhage Fixture", 59.28, 11.11, "Sarpsborg", ["herbs"], [{ name: "Basilikum", priceNok: 35 }]),
  // live: «Maschmanns Matmarked»
  seed(MATMARKED, "Maschmanns Matmarked Fixture", 60.39, 5.32, "Bergen", ["other"], [{ name: "Ferskvarer", priceNok: 99 }]),
  // live: «Den Gode Baker AS» (Sandefjord), «Norsk Ullgris», «Setesdal Ullgris», «Hella Sopperi»
  seed(DEN_GODE_BAKER, "Den Gode Baker AS Fixture", 59.13, 10.22, "Sandefjord", ["bakery"], [{ name: "Grovbrød", priceNok: 55 }]),
  seed(NORSK_ULLGRIS, "Norsk Ullgris Fixture", 59.58, 11.17, "Askim", ["meat"], [{ name: "Ullgrispølse", priceNok: 89 }]),
  seed(SETESDAL_ULLGRIS, "Setesdal Ullgris Fixture", 59.33, 7.38, "Valle", ["meat"], [{ name: "Ullgriskoteletter", priceNok: 159 }]),
  seed(HELLA_SOPPERI, "Hella Sopperi Fixture", 61.2, 6.6, "Leikanger", ["vegetables"], [{ name: "Østerssopp", priceNok: 79 }]),
  // live: «AR-Sjømat — Averøy», «Finnerud Gård»
  seed(AR_SJOMAT, "AR-Sjømat Fixture", 63.05, 7.6, "Averøy", ["fish"], [{ name: "Klippfisk", priceNok: 199 }]),
  seed(FINNERUD, "Finnerud Gård Fixture", 60.8, 10.69, "Gjøvik", ["vegetables"], [{ name: "Poteter", priceNok: 35 }]),
];

// The producers that share a distinctive word rank first by trust, as live
const I_W3_TRUST: Array<[string, number]> = [[AARVIK, 0.95], [SUNNMORSMAT, 0.9], [OVERNATURLIG, 0.9], [HARDANGER_SAFT, 0.9],
  [SETESDAL_ULLGRIS, 0.9], [HELLA_SOPPERI, 0.9]];

/**
 * B1: searches that must answer byte for byte as on main (ad67dba6, I-W2): a
 * search of one word (also one that ends in an indicator or is a filler
 * word), producer names, searches Pass 1 or Pass 2 reads as a name, and
 * names with filler words with a place or a product word after them.
 */
export const B1_W3_QUERIES: readonly string[] = [
  // one word
  "Fiskemat", "Dyrøymat", "sjømat", "mat", "sunn", "kortreist", "gourmet", "artisan", "bakeri", "Finnes", "Bondens", "lunsj",
  "kransekake", "Grini", "såper", "Gårds-bakeri", "grillmat", "tomat", "nettbutikk", "kveldsmat", "finner", "artisanal",
  // names through Pass 0, Pass 1 (an indicator, also at the end of a word that is a word of a name) and Pass 2
  "Bjerke Spekemat & Delikatesse", "Hitra Sjømat", "Dyrøy Sjømat", "Valen Gård", "Mat i Bergen", "When is the next Bondens marked in Oslo?",
  "Bondens Hage", "Godt og Hjemmelaget", "Lager 11", "Norsk AS", "H.A. Hanssen", "AR-Sjømat laks", "Finnerud Gård",
  // review round 1 (B2): names with filler words, with a place or a product word after them
  "Den Gode Baker", "Den Gode Baker Sandefjord", "Den Gode Baker kransekake", "Norsk Ullgris kransekake", "Norsk Ullgris Askim",
  "Topp Sopp kransekake",
  // a category word with «bakeri» and nothing else
  "bakeri i Bergen", "bakeri Trondheim",
];

const MAIN_TEXTS_FIXTURE = path.join(__dirname, "../../tests/fixtures/rfb-sok-i-w3-main.json");

/** I-W's and I-W2's fixtures and I_W3_SEEDS, with the trust scores above. */
function enterI_W3Fixtures(): ReturnType<typeof enterFixtures> {
  const fixtures = enterFixtures([...I_W_SEEDS, ...I_W2_SEEDS, ...I_W3_SEEDS]);
  const setTrust = fixtures.db.prepare("UPDATE agents SET trust_score = ? WHERE id = ?");
  for (const [agentId, trust] of I_W3_TRUST) setTrust.run(trust, agentId);
  (require("../services/marketplace-registry") as typeof import("../services/marketplace-registry")).marketplaceRegistry._agentsCache = null;
  return fixtures;
}

/**
 * lokal_search's text for each search on these fixtures (BASE_URL unset,
 * client test-client, geocoding offline). Uses only what main has, so main's
 * texts are captured with it: tests/fixtures/rfb-sok-i-w3-main.json.
 */
export async function pass1MainTexts(queries: readonly string[] = B1_W3_QUERIES): Promise<Record<string, string>> {
  const fixtures = enterI_W3Fixtures();
  const prevLog = console.log;
  console.log = () => { /* silence module chatter */ };
  try {
    const tools = captureTools();
    const out: Record<string, string> = {};
    for (const q of queries) out[q] = textOf(await tools.get("lokal_search")!({ query: q, limit: 10 }));
    return out;
  } finally {
    console.log = prevLog;
    fixtures.restore();
  }
}

export async function runRfbSokPass1FyllordTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // B1 first: pass1MainTexts opens (and closes) its own DB.
  const texts = await pass1MainTexts();

  const fixtures = enterI_W3Fixtures();
  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence module chatter */ };

  try {
    const tools = captureTools();
    const parse = (q: string) => marketplaceRegistry.parseNaturalQuery(q) as ReturnType<typeof marketplaceRegistry.parseNaturalQuery> & { _nameQuery?: string };
    const ids = (r: Array<{ agent: { id: string } }>) => r.map((x) => x.agent.id);
    const discover = (q: string) => ids(marketplaceRegistry.discover({ ...parse(q), limit: 20 }, undefined, { trackDiscovery: false }));
    const search = async (q: string) => textOf(await tools.get("lokal_search")!({ query: q, limit: 10 }));
    /** lokal_search's text for `q`, with the search as shown in the header put back to `as`. */
    const searchAs = async (q: string, as: string) => (await search(q)).split(`"${q}"`).join(`"${as}"`);
    const KRANS = [GRINI, FLATOY, TORGRIM, WALDERHAUG, MANDEL, RINGER];
    const KRANS_NAMES = ["Grini Hjemmebakeri Fixture", "Flatøy Hjemmebakeri Fixture", "Torgrim Hansen Bakeri Fixture", "Baker Walderhaug Fixture",
      "Mandelbakeren Fixture", "Ringbakeriet Fixture"];

    // ══════════════════════════════════════════════════════════════
    // B1: one word, the names and the name searches, byte for byte as main
    // ══════════════════════════════════════════════════════════════
    {
      const main = JSON.parse(fs.readFileSync(MAIN_TEXTS_FIXTURE, "utf8")) as Record<string, string>;
      for (const q of B1_W3_QUERIES) {
        const at = [...(texts[q] ?? "")].findIndex((ch, i) => ch !== [...(main[q] ?? "")][i]);
        assertTrue(texts[q] === main[q], `B1 «${q}» (acceptance criterion): lokal_search answers byte for byte as main`
          + (texts[q] === main[q] ? "" : ` (first difference at ${at}: ${JSON.stringify(String(texts[q]).slice(Math.max(0, at - 40), at + 80))})`));
      }
      assertEq([namesIn(main["Bjerke Spekemat & Delikatesse"]), namesIn(main["Dyrøy Sjømat"]), namesIn(main["When is the next Bondens marked in Oslo?"])],
        [["Bjerke Spekemat & Delikatesse AS Fixture"], ["Dyrøymat Fixture"], ["Bondens Kolonial Fixture"]],
        "B1 setup: on main Pass 1 finds these producers by name («Spekemat» and «Sjømat» end in the indicator «mat»; «Bondens» names the Oslo shop)");
      assertEq([parse("Bjerke Spekemat & Delikatesse")._nameQuery, parse("Dyrøy Sjømat")._nameQuery, parse("When is the next Bondens marked in Oslo?")._nameQuery],
        ["Bjerke Delikatesse", "Dyrøy", "When is next Bondens marked"],
        "parser: a word that ends in an indicator and is a word of a producer name («Spekemat», «Sjømat» in «Hitra Sjømat») still makes Pass 1 read "
          + "the name; the filler words stay in the name query when the words left have no distinctive word («is», and «marked», generic though "
          + "«Maschmanns Matmarked» holds it)");
      assertEq(ids(marketplaceRegistry.discover({ ...parse("When is the next Bondens marked in Oslo?"), location: { lat: 59.9139, lng: 10.7522 }, maxDistanceKm: 30, limit: 20 },
        undefined, { trackDiscovery: false })), [BONDENS_KOLONIAL],
      "«When is the next Bondens marked in Oslo?» (chatgpt-app-submission.json): «Bondens» in the name query finds the Oslo shop, as on main");
    }

    // ══════════════════════════════════════════════════════════════
    // Pass 1 reads the filler and qualifier words
    // ══════════════════════════════════════════════════════════════
    {
      const asWithout: Array<[string, string]> = [
        ["kortreist mat", "mat"],
        ["sunn mat", "mat"],
        ["kortreist mat i Bergen", "mat i Bergen"],
        ["kortreist sjømat", "sjømat"],
        ["naturlig sjømat", "sjømat"],
        ["sunn sjømat", "sjømat"],
        ["Hvem selger kortreist mat", "mat"],
        ["Jeg ser etter kortreist mat", "mat"],
        ["kortreist bakeri", "bakeri"],
      ];
      for (const [q, base] of asWithout) {
        const p = parse(q);
        assertEq([p._nameQuery, p._unknownTerms, await searchAs(q, base) === await search(base)], [undefined, undefined, true],
          `«${q}» (acceptance criterion): no name search and no word to look up; lokal_search gives the answer of «${base}»`);
      }
      const shown = [...new Set((await Promise.all(asWithout.map(([q]) => search(q)))).flatMap(namesIn))];
      assertEq(["Kortreist Italiener Fixture", "Sunnmørsmat Fixture", "Overnaturlig Honning Fixture"].filter((n) => shown.includes(n) && !namesIn(texts.mat).includes(n)), [],
        "none of these searches shows a producer named after the filler word, unless «mat» alone shows it");
      assertEq([parse("kortreist sjømat").categories, parse("kortreist mat")._nameQuery, parse("Kortreist Italiener")._nameQuery], [["fish"], undefined, "Kortreist Italiener"],
        "«kortreist sjømat» is the fish category (Pass 1: «Sjømat» is a word of «Hitra Sjømat Fixture»), and a name with a word that is no filler is still "
          + "a name search («Kortreist Italiener», Pass 2)");
    }

    // ══════════════════════════════════════════════════════════════
    // A name indicator counts only as a whole word
    // ══════════════════════════════════════════════════════════════
    {
      const tomat = parse("tomat fra Hardanger");
      assertEq([tomat._nameQuery, tomat.categories, tomat._productTerms], [undefined, ["vegetables"], ["tomat"]],
        "«tomat fra Hardanger»: «tomat» ends in «mat» but is no whole word of a name (only inside «Tomatgård»), so no Pass 1 and no name search for «Hardanger»");
      assertEq([discover("tomat fra Hardanger")[0], discover("tomat fra Hardanger").includes(HARDANGER_SAFT)], [SORFJORD, false],
        "discover «tomat fra Hardanger»: the tomato grower first, not the producer named after Hardanger");
      assertEq([parse("Dyrøy tomat")._nameQuery, discover("Dyrøy tomat")[0]], [undefined, SORFJORD], "«Dyrøy tomat»: the same, no name search for «Dyrøy»");
      const grill = parse("grillmat i Bergen");
      assertEq([grill._nameQuery, grill._unknownTerms], [undefined, ["grillmat"]],
        "«grillmat i Bergen»: no name search; «grillmat» goes to the product names (step 3c)");
      assertEq([discover("grillmat i Bergen"), namesIn(await search("grillmat i Bergen"))[0]], [[FJORDGRILL], "Fjordgrill Fixture"],
        "discover and lokal_search «grillmat i Bergen»: the producer with «Grillmat til hytta»");
      assertEq([parse("Dyrøy Fiskemat")._nameQuery, parse("Dyrøy Fiskemat")._unknownTerms], [undefined, ["fiskemat"]],
        "«Dyrøy Fiskemat»: «Fiskemat» is no word of a name, so it is read as a product word (I-W's «Dyrøy Sjømat» still finds Dyrøymat, B1 above)");
      assertEq([discover("Dyrøy Sjømat"), discover("Bjerke Spekemat & Delikatesse"), discover("Hitra Sjømat")], [[DYROYMAT], [BJERKE], [HITRA]],
        "discover: «Dyrøy Sjømat», «Bjerke Spekemat & Delikatesse» and «Hitra Sjømat» find their producer, as on main");
      assertEq([parse("Gårds-bakeri").categories, parse("Gårds-bakeri")._nameQuery, parse("grillmat")._nameQuery, parse("nettbutikk")._nameQuery],
        [["bakery"], "Gårds-bakeri", "grillmat", "nettbutikk"],
        "a search of one word is read as before, also when it only ends in an indicator or is a filler word («grillmat», «nettbutikk»)");
    }

    // ══════════════════════════════════════════════════════════════
    // «Finnes det noen bakeri som lager kransekake»: «bakeri» gives way
    // ══════════════════════════════════════════════════════════════
    {
      const q = "Finnes det noen bakeri som lager kransekake";
      const p = parse(q);
      assertEq([p._nameQuery, p.categories, p._productTerms, p._unknownTerms], [undefined, ["bakery"], undefined, ["kransekake"]],
        "parser: no name search (left is «kransekake», in no producer name, next to the category word «bakeri»); «bakeri» gives way to «kransekake»");
      const found = discover(q);
      assertEq(found.slice(0, 6), KRANS, `«${q}» (acceptance criterion): the kransekake producers first, Grini first`);
      const text = await search(q);
      const names = namesIn(text);
      assertEq(names.slice(0, 6), KRANS_NAMES, `lokal_search «${q}» (acceptance criterion): the kransekake producers first, Grini first`);
      assertTrue(names.length === 10 && KRANS_NAMES.every((n) => !text.includes(`${n} — Kategoritreff`))
        && names.slice(6).every((n) => text.includes(`${n} — Kategoritreff / category-only: «kransekake» ikke oppført`)) && !text.includes("«bakeri»"),
      `lokal_search: the other bakeries follow, each marked a category match for «kransekake», none for «bakeri» (got ${JSON.stringify(names)})`);
      assertTrue(found.indexOf(AARVIK) > 5, "«Brød og boller fra eget bakeri» no longer ranks its producer first");
      for (const v of ["kransekake fra bakeri", "bakeri kransekake", "Hvilket bakeri lager kransekake", "Finnes det et bakeri som lager kransekake",
        "Which bakery makes kransekake", "kransekake fra bakeriet"]) {
        assertEq([parse(v)._nameQuery, discover(v), await searchAs(v, q) === text], [undefined, found, true],
          `«${v}»: the same answer as «${q}»`);
      }
      assertEq([discover("Which bakeries make kransekake"), await searchAs("Which bakeries make kransekake", q) === text], [found, true],
        "and the same as I-W2's «Which bakeries make kransekake»");
      // «bakeri» without such a word is a product term as before («bakeri i Bergen», B1 above)
      assertEq([parse("bakeri")._productTerms, parse("bakeri i Bergen")._productTerms, parse("Tromsø Bakeri")._productTerms, parse("bakeri til lunsj")._productTerms],
        [["bakeri"], ["bakeri"], ["bakeri"], ["bakeri"]],
        "«bakeri» stays a product term when no other word is read in its place (a qualifier word next to it is none)");
    }

    // ══════════════════════════════════════════════════════════════
    // The name query leaves out the filler and qualifier words
    // ══════════════════════════════════════════════════════════════
    {
      for (const q of ["kortreist såper", "ren såper", "naturlige såper"]) {
        assertEq([parse(q)._nameQuery, namesIn(await search(q))], ["såper", ["Reine Såper Fixture"]],
          `«${q}» (acceptance criterion): the name query is «såper», and Reine Såper comes first (and alone: no producer named after «${q.split(" ")[0]}»)`);
      }
      assertEq([parse("ren krydderhage")._nameQuery, discover("ren krydderhage").sort()], ["krydderhage", [GRENLAND, SOLLI].sort()],
        "«ren krydderhage»: a filler word stays only as a whole word of a name, so «ren» inside «Grenland» keeps no name query «ren krydderhage», "
          + "which found Grenland Krydderhage alone");
      assertEq([parse("kortreist mat fra Valen")._nameQuery, discover("kortreist mat fra Valen")], ["mat Valen", [VALEN]],
        "Pass 1: «kortreist mat fra Valen» looks up «mat Valen», and finds Valen Gård alone (not «Kortreist Italiener» by «kortreist»)");
      assertEq([parse("Jeg vil ha Grini")._nameQuery, namesIn(await search("Jeg vil ha Grini"))], ["ha Grini", ["Grini Hjemmebakeri Fixture"]],
        "«Jeg vil ha Grini»: «vil» is left out of the name query («ha» is under three letters, see «HA» below), which finds Grini alone");
      assertEq([parse("Bondens Hage")._nameQuery, parse("Godt og Hjemmelaget")._nameQuery, parse("Lager 11")._nameQuery, parse("Norsk AS")._nameQuery,
        parse("sunn")._nameQuery, parse("H.A. Hanssen")._nameQuery],
      ["Bondens Hage", "Godt Hjemmelaget", "Lager 11", "Norsk AS", "sunn", "HA Hanssen"],
      "the filler words stay when a producer name holds them with a distinctive word of the search («Bondens Hage»), in a search of filler words "
        + "only («Godt og Hjemmelaget», «Lager 11», «Norsk AS»), when nothing else would be left («sunn»), and a word under three letters is never "
        + "left out («HA»)");
      assertEq([parse("stor zzzqqx")._nameQuery, discover("stor zzzqqx").includes(KORTREIST_NAVN)], ["stor zzzqqx", false],
        "and when the words left name nobody («zzzqqx»): the name query stays as on I-W2, not one that finds nobody and falls back to the standard list");
    }

    // ══════════════════════════════════════════════════════════════
    // Review round 1 (B2): a name with filler words, with more words around it
    // ══════════════════════════════════════════════════════════════
    {
      // [search, name query, the producer it names, its name]. Round 1 kept the filler words only when one name held every
      // word of the search, so these were «Baker», «Ullgris …» and «Sopp …»: Den Gode Baker fell out of the list, and
      // Setesdal Ullgris and Hella Sopperi (higher trust) came first.
      const cases: Array<[string, string, string, string]> = [
        ["Tell me about Den Gode Baker", "Den Gode Baker", DEN_GODE_BAKER, "Den Gode Baker AS Fixture"],
        ["Jeg vil kontakte Den Gode Baker", "kontakte Den Gode Baker", DEN_GODE_BAKER, "Den Gode Baker AS Fixture"],
        ["Den Gode Baker Sandefjord", "Den Gode Baker Sandefjord", DEN_GODE_BAKER, "Den Gode Baker AS Fixture"],
        ["Den Gode Baker kransekake", "Den Gode Baker kransekake", DEN_GODE_BAKER, "Den Gode Baker AS Fixture"],
        ["Tell me about Norsk Ullgris", "Norsk Ullgris", NORSK_ULLGRIS, "Norsk Ullgris Fixture"],
        ["Norsk Ullgris kransekake", "Norsk Ullgris kransekake", NORSK_ULLGRIS, "Norsk Ullgris Fixture"],
        ["Jeg vil kontakte Norsk Ullgris", "kontakte Norsk Ullgris", NORSK_ULLGRIS, "Norsk Ullgris Fixture"],
        ["Tell me about Topp Sopp", "Topp Sopp", TOPP, "Topp Sopp Fixture"],
        ["Topp Sopp kransekake", "Topp Sopp kransekake", TOPP, "Topp Sopp Fixture"],
        ["Jeg vil kontakte Topp Sopp", "kontakte Topp Sopp", TOPP, "Topp Sopp Fixture"],
      ];
      for (const [q, nameQuery, first, firstName] of cases) {
        assertEq([parse(q)._nameQuery, discover(q)[0], namesIn(await search(q))[0]], [nameQuery, first, firstName],
          `«${q}» (review round 1, B2): the name query keeps the filler words of the producer's name, and the producer comes first, as on main`);
      }
      assertEq([parse("Ullgris kransekake")._nameQuery, discover("Ullgris kransekake")[0]], ["Ullgris kransekake", SETESDAL_ULLGRIS],
        "setup: without «Norsk» the higher trust of Setesdal Ullgris puts it first");
      assertEq([parse("gode såper")._nameQuery, parse("Den Gode Baker zzzqqx")._nameQuery], ["såper", "Den Gode Baker zzzqqx"],
        "a filler word stays only with a distinctive word of the search in the same name: «gode såper» is «såper» («Gode» is in «Den Gode Baker», "
          + "«såper» is not), and a word in no name («zzzqqx») does not take «Den Gode» away");
    }

    // ══════════════════════════════════════════════════════════════
    // Qualifier words next to an indicator, and the tail «gourmet», «artisan»
    // ══════════════════════════════════════════════════════════════
    {
      assertEq([parse("sunn mat")._unknownTerms, parse("mat til lunsj")._unknownTerms, parse("lunsj")._unknownTerms, parse("gave til jul")._unknownTerms],
        [undefined, undefined, ["lunsj"], ["gave", "jul"]],
        "next to «mat» a qualifier word is no word to look up, as next to a category word; alone it still is");
      for (const [q, base, word] of [["gourmet brød", "brød", "gourmet"], ["artisan bread", "bread", "artisan"], ["artisanal bread", "bread", "artisanal"]]) {
        const text = await search(q);
        assertEq([parse(q)._unknownTerms, text.includes(`«${word}»`), await searchAs(q, base) === await search(base)], [undefined, false, true],
          `«${q}» (FUNN rfb-sok-egenskapsord-hale): «${word}» labels no bakery, and lokal_search gives the answer of «${base}»`);
      }
      assertEq([parse("gourmet")._nameQuery, parse("artisan")._unknownTerms, namesIn(texts.artisan)], [undefined, ["artisan"], ["Kneippen Fixture"]],
        "alone «artisan» still finds «Artisan surdeigsbrød» (B1 above), and «gourmet» names no fixture producer");
      assertEq([discover("Reine Såper")[0], discover("Sunnmørsmat")[0], discover("Overnaturlig Honning")[0], discover("H.A. Hanssen")[0]],
        [REINE_SAPER, SUNNMORSMAT, OVERNATURLIG, HANSSEN], "setup: each fixture producer is found by its name");
    }

    // ══════════════════════════════════════════════════════════════
    // Review round 1 (S1): «finner»
    // ══════════════════════════════════════════════════════════════
    {
      const q = "Hvor finner jeg kortreist mat i Oslo?";
      assertEq([parse(q)._nameQuery, parse(q)._unknownTerms, namesIn(await search(q)).includes("Finnerud Gård Fixture"), await searchAs(q, "mat i Oslo") === await search("mat i Oslo")],
        [undefined, undefined, false, true],
        `«${q}»: no name search («finner mat» found Finnerud Gård alone), and lokal_search gives the answer of «mat i Oslo»`);
      assertEq([parse("finner")._nameQuery, namesIn(texts.finner), parse("Finnerud Gård")._nameQuery], ["finner", ["Finnerud Gård Fixture"], "Finnerud Gård"],
        "alone «finner» is still the name search of main (B1 above), and «Finnerud Gård» names its producer");
    }

    // ══════════════════════════════════════════════════════════════
    // Review round 1 (B1): the cost of a long search
    // ══════════════════════════════════════════════════════════════
    {
      // A name, or the text of all names, is searched for a word with String.prototype.indexOf (productNameMatch) or
      // .includes, so the calls of those two with a word of the search as the needle count how often that word is
      // looked for (as in security-sanitize-fixpoint.test.ts, the methods are put back in finally). Round 1 looked
      // for each word with a character other than a letter that ends in an indicator in every name, and Pass 2,
      // where such a word now goes, did the same for each word: a 1 MB search of «x-mat» took 33 s on the 1 563
      // live names (main 1.8 s).
      const lookupsOf = (isNeedle: (s: string) => boolean, fn: () => unknown): number => {
        const orig = { indexOf: String.prototype.indexOf, includes: String.prototype.includes };
        let n = 0;
        for (const m of ["indexOf", "includes"] as const) {
          (String.prototype as any)[m] = function (this: string, search: any, ...rest: any[]) {
            if (typeof search === "string" && isNeedle(search)) n++;
            return (orig[m] as any).call(this, search, ...rest);
          };
        }
        try { fn(); } finally { Object.assign(String.prototype, orig); }
        return n;
      };
      const names = [...I_W_SEEDS, ...I_W2_SEEDS, ...I_W3_SEEDS].length;
      assertEq([parse("AR-Sjømat laks")._nameQuery, discover("AR-Sjømat laks")], ["AR-Sjømat", [AR_SJOMAT]],
        "setup: «AR-Sjømat», a whole word of «AR-Sjømat Fixture», still makes Pass 1 read the name (B1 above)");
      // «zqa-mat», «zqb-mat» …: 2000 words no name holds
      const words = Array.from({ length: 2000 }, (_, i) => `zq${[...i.toString(26)].map((d) => String.fromCharCode(97 + parseInt(d, 26))).join("")}-mat`);
      const long = words.join(" ");
      const longCalls = lookupsOf((s) => s.endsWith("-mat"), () => parse(long));
      assertTrue(new Set(words).size === 2000 && longCalls <= 2 * words.length && parse(long)._nameQuery === undefined,
        `B1: a search of 2000 different words like «x-mat» looks for each in the text of all names, in the indicator check and in Pass 2 `
          + `(${longCalls} calls ≤ ${2 * words.length}), not in each name (round 1: 2 × 2000 × ${names})`);
      // «r-sjømat» is inside «AR-Sjømat», but no whole word of it
      const inside = Array(2000).fill("r-sjømat").join(" ");
      const insideCalls = lookupsOf((s) => s === "r-sjømat", () => parse(inside));
      assertTrue(insideCalls <= 4 * names && parse("r-sjømat laks")._nameQuery === undefined,
        `B1: 2000 times a word inside a name («r-sjømat»): the names are read for it a few times in all (${insideCalls} calls ≤ ${4 * names}), `
          + "not once per word, and it is no indicator");
      // the name query reads the names once for each different filler word
      const fillers = [...Array(1999).fill("kortreist"), "Grini"].join(" ");
      const fillerCalls = lookupsOf((s) => s === "kortreist", () => parse(fillers));
      assertTrue(fillerCalls <= 2 * names && parse(fillers)._nameQuery === "Grini",
        `B1: 1999 times «kortreist» and «Grini»: the names are read for «kortreist» once (${fillerCalls} calls ≤ ${2 * names}), and the name query is «Grini»`);
    }
  } finally {
    console.log = prevLog;
    fixtures.restore();
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runRfbSokPass1FyllordTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
