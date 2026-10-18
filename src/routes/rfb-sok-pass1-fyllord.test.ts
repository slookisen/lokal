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
 *   («kortreist såper», «kortreist mat fra Valen gård»). They stay when
 *   nothing else is left, when a producer name holds them as whole words, and
 *   when the words left have no distinctive word in a producer name («When is
 *   the next Bondens marked in Oslo?», «stor zzzqqx»).
 * - Next to an indicator word a qualifier word counts no more than next to a
 *   category word («sunn mat» reads as «mat»), and «gourmet» and «artisan»
 *   are qualifier words (FUNN rfb-sok-egenskapsord-hale).
 * - B1: a search of one word, the producer names and the name searches that
 *   Pass 1 reads («Bjerke Spekemat & Delikatesse», «Dyrøy Sjømat», «When is the
 *   next Bondens marked in Oslo?») answer byte for byte as on I-W2
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
];

const I_W3_TRUST: Array<[string, number]> = [[AARVIK, 0.95], [SUNNMORSMAT, 0.9], [OVERNATURLIG, 0.9], [HARDANGER_SAFT, 0.9]];

/**
 * B1: searches that must answer byte for byte as on main (ad67dba6, I-W2): a
 * search of one word (also one that ends in an indicator or is a filler
 * word), producer names, and searches Pass 1 or Pass 2 reads as a name.
 */
export const B1_W3_QUERIES: readonly string[] = [
  // one word
  "Fiskemat", "Dyrøymat", "sjømat", "mat", "sunn", "kortreist", "gourmet", "artisan", "bakeri", "Finnes", "Bondens", "lunsj",
  "kransekake", "Grini", "såper", "Gårds-bakeri", "grillmat", "tomat", "nettbutikk", "kveldsmat",
  // names through Pass 0, Pass 1 (an indicator, also at the end of a word that is a word of a name) and Pass 2
  "Bjerke Spekemat & Delikatesse", "Hitra Sjømat", "Dyrøy Sjømat", "Valen Gård", "Mat i Bergen", "When is the next Bondens marked in Oslo?",
  "Bondens Hage", "Godt og Hjemmelaget", "Lager 11", "Norsk AS", "H.A. Hanssen",
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
      "the filler words stay when a producer name holds them («Bondens Hage»), in a search of filler words only («Godt og Hjemmelaget», «Lager 11», "
        + "«Norsk AS»), when nothing else would be left («sunn»), and a word under three letters is never left out («HA»)");
      assertEq([parse("stor zzzqqx")._nameQuery, discover("stor zzzqqx").includes(KORTREIST_NAVN)], ["stor zzzqqx", false],
        "and when the words left name nobody («zzzqqx»): the name query stays as on I-W2, not one that finds nobody and falls back to the standard list");
    }

    // ══════════════════════════════════════════════════════════════
    // Qualifier words next to an indicator, and the tail «gourmet», «artisan»
    // ══════════════════════════════════════════════════════════════
    {
      assertEq([parse("sunn mat")._unknownTerms, parse("mat til lunsj")._unknownTerms, parse("lunsj")._unknownTerms, parse("gave til jul")._unknownTerms],
        [undefined, undefined, ["lunsj"], ["gave", "jul"]],
        "next to «mat» a qualifier word is no word to look up, as next to a category word; alone it still is");
      for (const [q, base, word] of [["gourmet brød", "brød", "gourmet"], ["artisan bread", "bread", "artisan"]]) {
        const text = await search(q);
        assertEq([parse(q)._unknownTerms, text.includes(`«${word}»`), await searchAs(q, base) === await search(base)], [undefined, false, true],
          `«${q}» (FUNN rfb-sok-egenskapsord-hale): «${word}» labels no bakery, and lokal_search gives the answer of «${base}»`);
      }
      assertEq([parse("gourmet")._nameQuery, parse("artisan")._unknownTerms, namesIn(texts.artisan)], [undefined, ["artisan"], ["Kneippen Fixture"]],
        "alone «artisan» still finds «Artisan surdeigsbrød» (B1 above), and «gourmet» names no fixture producer");
      assertEq([discover("Reine Såper")[0], discover("Sunnmørsmat")[0], discover("Overnaturlig Honning")[0], discover("H.A. Hanssen")[0]],
        [REINE_SAPER, SUNNMORSMAT, OVERNATURLIG, HANSSEN], "setup: each fixture producer is found by its name");
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
