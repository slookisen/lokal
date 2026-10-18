/**
 * rfb-sok-fyllord-navnekapring.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-W2 (review of lokal#1160,
 * I-W): the RFB search (parseNaturalQuery, discover() and lokal_search).
 *
 * - S2 (a regression from I-W): a search of one filler word that is also part
 *   of producer names («Finnes», «Mellom», «Bondens», «Godt», «Norsk»,
 *   «Topp») gave the standard list, where main found the producers with the
 *   word in their name. When the filler filter of Pass 2 leaves no word,
 *   main's rule applies again; the answers are main's byte for byte
 *   (tests/fixtures/rfb-sok-i-w2-main.json, captured with fyllordMainTexts
 *   below on main 727071f4, before I-W).
 * - S3: no fixture producer had a NO_PRODUCT_WORDS word in its name, so
 *   nothing pinned that part of the Pass 2 filter (mutation M4 survived).
 *   «Godt og Hjemmelaget Fixture» and «Norsk Urkorn Fixture» do now.
 * - S4: Pass 2 took any word of three letters or more found inside a producer
 *   name as a name search, so «Jeg ser etter kransekake» («Hvasser»), «Hvem
 *   lager spekepølse» («Fruktlager»), «Which bakeries make kransekake»
 *   («Ostemakeri»), «kransekake til jul» («Julseth») and «stor kransekake»
 *   («Storfjord») never reached the product names. In a search of several
 *   words such a word now names nobody when another word is a place, a
 *   category or a product; a whole word of a name still does. «ser»,
 *   «lager», «lage», «make» and «makes» are filler words, and «bakeries» is
 *   the bakery category; next to a category word the unknown words only rank
 *   that category's producers.
 * - S1: words for the occasion, meal, size or packaging («lunsj», «selskap»,
 *   «gave», «frokost», «stor», «jul») next to a product word brought in
 *   producers that match only them, as product matches, and could rank first.
 *   They now count only when nothing else in the search names a product.
 *
 * Data: I-W's fixtures (rfb-sok-ukjente-ord-bakeri-sted.test.ts, I_W_SEEDS
 * and its trust scores) plus I_W2_SEEDS, in an in-memory DB with the
 * production schema (restored in finally), geocoding offline. The noise
 * producers have a higher trust than the producers with the product, so
 * relevance alone would put them first. MCP tools through a duck-typed
 * server. The frozen MCP contract is pinned in rfb-mcp-contract-freeze.test.ts.
 *
 * Exported runRfbSokFyllordNavnekapringTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-sok-fyllord-navnekapring.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Seed, CatalogRow } from "./rfb-kategorietiketter-ikke-tilbud.test";
import { I_W_SEEDS, enterFixtures, captureTools, textOf, namesIn } from "./rfb-sok-ukjente-ord-bakeri-sted.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const id = (n: number) => `1f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// I-W's ids (rfb-sok-ukjente-ord-bakeri-sted.test.ts) that the expectations name
const GRINI = id(1), BYBAKST = id(3), FLATOY = id(4), TORGRIM = id(5), WALDERHAUG = id(6), RINGER = id(7), MANDEL = id(8);
const SYLT_REAL = id(14), SYLT_LABEL = id(15);
// S2 and S3: names that hold a filler word
const FINNES = id(101), MELLOM = id(102), BONDENS_HAGE = id(103), BONDENS_KOLONIAL = id(104), GODT = id(105), NORSK = id(106), TOPP = id(107);
// S4: names a word of a question sits inside
const HVASSER = id(111), FRUKTLAGER = id(112), LAGER11 = id(113), OSTEMAKERI = id(114), JULSETH = id(115), STORFJORD = id(116), TOMTERMAIS = id(117);
// S1: products that only a qualifier word matches, and the products they were ranked against
const LUNSJ = id(121), SELSKAP = id(122), GAVE = id(123), FROKOST = id(124), STORFE = id(125), JULEKAKE = id(126), SPEKE = id(127);

/** A producer whose knowledge products and catalog rows are the same names (and prices). */
function seed(n: string, name: string, lat: number, lng: number, city: string, categories: string[], catalog: CatalogRow[]): Seed {
  return {
    id: n, name, lat, lng, city, categories,
    products: catalog.map((c) => ({ name: c.name, category: c.category ?? categories[0], ...(c.priceNok ? { price: `${c.priceNok} kr` } : {}) })),
    catalog,
  };
}

export const I_W2_SEEDS: Seed[] = [
  seed(FINNES, "Finnes Gård Fixture", 59.13, 10.22, "Sandefjord", ["vegetables"], [{ name: "Poteter", priceNok: 30 }]),
  seed(MELLOM, "Mellom Fange Gård Fixture", 60.0, 11.0, "Nannestad", ["meat"], [{ name: "Grisekjøtt", priceNok: 180 }]),
  seed(BONDENS_HAGE, "Bondens Hage Fixture", 59.14, 10.2, "Sandefjord", ["vegetables"], [{ name: "Gulrøtter", priceNok: 25 }]),
  seed(BONDENS_KOLONIAL, "Bondens Kolonial Fixture", 59.92, 10.75, "Oslo", ["other"], [{ name: "Kolonialvarer", priceNok: 99 }]),
  seed(GODT, "Godt og Hjemmelaget Fixture", 59.49, 10.31, "Holmestrand", ["bakery"], [{ name: "Hjemmelaget flatbrød", priceNok: 60 }]),
  seed(NORSK, "Norsk Urkorn Fixture", 59.5, 11.2, "Trøgstad", ["other"], [{ name: "Urkornmel", priceNok: 70 }]),
  seed(TOPP, "Topp Sopp Fixture", 58.95, 5.72, "Stavanger", ["vegetables"], [{ name: "Østerssopp", priceNok: 89 }]),

  seed(HVASSER, "Hvasser Reke og Fisk Fixture", 59.07, 10.44, "Tjøme", ["fish"], [{ name: "Reker", priceNok: 220 }]),
  seed(FRUKTLAGER, "Ullensvang Fruktlager Fixture", 60.32, 6.65, "Lofthus", ["fruit"], [{ name: "Epler", priceNok: 40 }]),
  seed(LAGER11, "Lager 11 Fixture", 63.43, 10.41, "Trondheim", ["other"], [{ name: "Kaffe", priceNok: 45 }]),
  seed(OSTEMAKERI, "Langesund Ostemakeri Fixture", 59.0, 9.75, "Langesund", ["dairy"], [{ name: "Hvitost", priceNok: 110 }]),
  seed(JULSETH, "Julseth Østre Fixture", 63.46, 10.93, "Hell", ["vegetables"], [{ name: "Kålrot", priceNok: 20 }]),
  seed(STORFJORD, "Storfjord Iskrem Fixture", 62.4, 6.9, "Stordal", ["dairy"], [{ name: "Iskrem", priceNok: 79 }]),
  seed(TOMTERMAIS, "Tomtermais Fixture", 59.6, 11.3, "Tomter", ["vegetables"], [{ name: "Mais", priceNok: 15 }]),

  seed(LUNSJ, "Lillehammer Kafé Fixture", 61.11, 10.47, "Lillehammer", ["bakery"],
    [{ name: "Frukost og lunsj", priceNok: 145 }, { name: "Lunsjtallerken", priceNok: 165 }]),
  seed(SELSKAP, "Kafé Lokalet Fixture", 60.39, 5.32, "Bergen", ["other"],
    [{ name: "Catering til selskap", priceNok: 450 }, { name: "Selskapsmeny", priceNok: 395 }]),
  seed(GAVE, "Bua i Bygda Fixture", 60.8, 11.0, "Hamar", ["meat"], [{ name: "Gave med spekemat", priceNok: 399 }, { name: "Gavekort", priceNok: 500 }]),
  seed(FROKOST, "Morgenstund Fixture", 59.75, 10.2, "Drammen", ["other"], [{ name: "Frokost", priceNok: 189 }, { name: "Frokostbuffet", priceNok: 229 }]),
  seed(STORFE, "Engvoll Fixture", 60.2, 11.6, "Kongsvinger", ["meat"], [{ name: "Storfekjøtt", priceNok: 250 }, { name: "Servelat", priceNok: 80 }]),
  seed(JULEKAKE, "Kakehuset Fixture", 59.92, 10.7, "Oslo", ["bakery"], [{ name: "Julekake", priceNok: 120 }, { name: "Julebrød", priceNok: 90 }]),
  seed(SPEKE, "Spekeloftet Fixture", 61.5, 9.9, "Vinstra", ["meat"], [{ name: "Spekepølse av lam", priceNok: 120 }]),
];

/** The noise producers rank above the producers with the product on relevance alone. */
const I_W2_TRUST: Array<[string, number]> = [
  [LUNSJ, 0.9], [SELSKAP, 0.9], [GAVE, 0.9], [FROKOST, 0.9], [STORFE, 0.9], [JULEKAKE, 0.9], [SPEKE, 0.3],
];

/** The S2 searches: one filler word that is also part of producer names. */
export const S2_QUERIES: readonly string[] = ["Finnes", "Mellom", "Bondens", "Godt", "Norsk", "Topp"];

const MAIN_TEXTS_FIXTURE = path.join(__dirname, "../../tests/fixtures/rfb-sok-i-w2-main.json");

/** I-W's fixtures and I_W2_SEEDS, with the trust scores above. */
function enterI_W2Fixtures(): ReturnType<typeof enterFixtures> {
  const fixtures = enterFixtures([...I_W_SEEDS, ...I_W2_SEEDS]);
  const setTrust = fixtures.db.prepare("UPDATE agents SET trust_score = ? WHERE id = ?");
  for (const [agentId, trust] of I_W2_TRUST) setTrust.run(trust, agentId);
  (require("../services/marketplace-registry") as typeof import("../services/marketplace-registry")).marketplaceRegistry._agentsCache = null;
  return fixtures;
}

/**
 * lokal_search's text for each S2 search on these fixtures (BASE_URL unset,
 * client test-client, geocoding offline). Uses only what main has, so main's
 * texts are captured with it: tests/fixtures/rfb-sok-i-w2-main.json.
 */
export async function fyllordMainTexts(queries: readonly string[] = S2_QUERIES): Promise<Record<string, string>> {
  const fixtures = enterI_W2Fixtures();
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

export async function runRfbSokFyllordNavnekapringTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // S2 first: fyllordMainTexts opens (and closes) its own DB.
  const texts = await fyllordMainTexts();

  const fixtures = enterI_W2Fixtures();
  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence module chatter */ };

  try {
    const tools = captureTools();
    const parse = (q: string) => marketplaceRegistry.parseNaturalQuery(q) as ReturnType<typeof marketplaceRegistry.parseNaturalQuery> & { _nameQuery?: string };
    const ids = (r: Array<{ agent: { id: string } }>) => r.map((x) => x.agent.id);
    const discover = (q: string, meta?: any) => ids(marketplaceRegistry.discover({ ...parse(q), limit: 20 }, meta, { trackDiscovery: false }));
    const search = async (q: string) => textOf(await tools.get("lokal_search")!({ query: q, limit: 10 }));
    const KRANS = [GRINI, FLATOY, TORGRIM, WALDERHAUG, MANDEL, RINGER];
    const KRANS_NAMES = ["Grini Hjemmebakeri Fixture", "Flatøy Hjemmebakeri Fixture", "Torgrim Hansen Bakeri Fixture", "Baker Walderhaug Fixture",
      "Mandelbakeren Fixture", "Ringbakeriet Fixture"];

    // ══════════════════════════════════════════════════════════════
    // S2: one filler word that is part of producer names, as on main
    // ══════════════════════════════════════════════════════════════
    {
      const main = JSON.parse(fs.readFileSync(MAIN_TEXTS_FIXTURE, "utf8")) as Record<string, string>;
      for (const q of S2_QUERIES) {
        const at = [...(texts[q] ?? "")].findIndex((ch, i) => ch !== [...(main[q] ?? "")][i]);
        assertTrue(texts[q] === main[q], `S2 «${q}» (acceptance criterion): lokal_search answers byte for byte as main`
          + (texts[q] === main[q] ? "" : ` (first difference at ${at}: ${JSON.stringify(String(texts[q]).slice(Math.max(0, at - 40), at + 80))})`));
      }
      assertEq(S2_QUERIES.map((q) => namesIn(main[q]).sort()),
        [["Finnes Gård Fixture"], ["Mellom Fange Gård Fixture"], ["Bondens Hage Fixture", "Bondens Kolonial Fixture"], ["Godt og Hjemmelaget Fixture"],
          ["Norsk Urkorn Fixture"], ["Topp Sopp Fixture"]],
        "S2 setup: main finds the producers with the word in their name (so «byte for byte» compares name searches, not the standard list)");
      assertEq(S2_QUERIES.map((q) => parse(q)._nameQuery), [...S2_QUERIES],
        "parser: the filter left no word, so main's rule makes the word a name search");
      assertEq([parse("Godt og Hjemmelaget")._nameQuery, parse("Bondens Hage")._nameQuery, parse("Godt og Hjemmelaget Fixture")._nameQuery],
        ["Godt Hjemmelaget", "Bondens Hage", "Godt og Hjemmelaget Fixture"],
        "parser: two filler words that name a producer are read by main's rule too; a word that is no filler («Hage») and a full name (Pass 0) as before");
    }

    // ══════════════════════════════════════════════════════════════
    // S3: a NO_PRODUCT_WORDS word in a producer name (mutation M4)
    // ══════════════════════════════════════════════════════════════
    {
      for (const q of ["hjemmelaget kransekake", "norsk kransekake"]) {
        const p = parse(q);
        assertEq([p._nameQuery, p._unknownTerms], [undefined, ["kransekake"]],
          `«${q}»: no name search for «Godt og Hjemmelaget Fixture» / «Norsk Urkorn Fixture» (the word is a whole word of the name); «kransekake» goes to the product names`);
        assertEq(namesIn(await search(q)), KRANS_NAMES, `lokal_search «${q}»: the kransekake producers, Grini first`);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // S4: a word inside a producer name no longer takes over the search
    // ══════════════════════════════════════════════════════════════
    {
      const hijacked = ["Jeg ser etter kransekake", "Finnes det noen som lager kransekake", "Which bakeries make kransekake", "kransekake til jul",
        "stor kransekake", "kransekake til 17. mai"];
      for (const q of hijacked) {
        assertEq(parse(q)._nameQuery, undefined, `parser «${q}»: no name search`);
      }
      for (const q of hijacked.filter((x) => !x.startsWith("Which"))) {
        assertEq([parse(q)._unknownTerms, discover(q)], [["kransekake"], KRANS], `«${q}» (acceptance criterion): the kransekake producers, Grini first`);
        assertEq(namesIn(await search(q)), KRANS_NAMES, `lokal_search «${q}» (acceptance criterion): the kransekake producers, Grini first`);
      }
      assertEq([parse("Hvem lager spekepølse")._nameQuery, discover("Hvem lager spekepølse")], [undefined, [SPEKE]],
        "«Hvem lager spekepølse»: «lager» names neither «Fruktlager» nor «Lager 11» (a whole word there); the spekepølse producer");
      assertEq(discover("Jeg ser etter kransekake").includes(STORFE), false,
        "«ser» is a filler word, not a product word («Servelat»)");
      assertEq(["hvor får jeg tak i kransekake", "Jeg leter etter kransekake", "Noen som selger kransekake i nærheten av Bergen"].map((q) => parse(q)._unknownTerms),
        [["kransekake"], ["kransekake"], ["kransekake"]],
        "«få tak i», «leter etter» and «i nærheten av» are filler words too (the reviewer's other searches)");

      // Whole words of a name, and a search of one word, as before
      assertEq([parse("Ostemakeri kransekake")._nameQuery, parse("Julseth")._nameQuery, parse("Fruktlager")._nameQuery, parse("stor")._nameQuery],
        ["Ostemakeri kransekake", "Julseth", "Fruktlager", "stor"],
        "parser: a whole word of a name still makes a name search next to a product word; a search of one word is read as before (also «stor» inside «Storfjord»)");
      assertEq([parse("ostemaker zzzqqx")._nameQuery, ids(marketplaceRegistry.discover({ ...parse("ostemaker zzzqqx"), limit: 20 }, undefined, { trackDiscovery: false }))],
        ["ostemaker zzzqqx", [OSTEMAKERI]],
        "parser: a word inside a name still names when no other word is a place, a category or a product («zzzqqx»)");
      assertEq(parse("Grini kransekake til jul")._nameQuery, "Grini kransekake jul",
        "parser: a whole word of a name («Grini») keeps the name search even when the search also has a word only inside a name («jul») and a product");
      assertEq([parse("jul i Bærum")._nameQuery, parse("jul i Bærum")._unknownTerms], [undefined, ["jul"]],
        "parser: a word inside a name («Julseth») names nobody next to a place word");
      assertEq([parse("Lager 11 Fixture")._nameQuery, parse("Hvasser Reke og Fisk Fixture")._nameQuery, parse("Lager 11")._nameQuery],
        ["Lager 11 Fixture", "Hvasser Reke og Fisk Fixture", "Lager 11"],
        "parser: full names (Pass 0), also with a filler verb in them; «Lager 11» by main's rule, as the filler verb is its only word (S2)");

      // «bakeries»: the bakery category; next to it the words only rank
      assertEq([parse("bakeries").categories, parse("bakeries")._productTerms, parse("Which bakeries make kransekake").categories,
        parse("Which bakeries make kransekake")._productTerms, parse("Which bakeries make kransekake")._unknownTerms],
      [["bakery"], undefined, ["bakery"], undefined, ["kransekake"]],
      "parser: «bakeries» gives the bakery category and no product term; «kransekake» is kept next to it");
      const meta: any = {};
      const bakeries = discover("Which bakeries make kransekake", meta);
      const allBakeries = discover("bakeries");
      assertEq(bakeries.slice(0, 6), KRANS, "«Which bakeries make kransekake» (acceptance criterion): the kransekake producers first, Grini first, in 3c's order");
      assertEq([bakeries.length, [...bakeries].sort()], [allBakeries.length, [...allBakeries].sort()],
        "next to a category word the words add and remove no producer: the same bakeries as «bakeries»");
      // Rank, not relevance: near Oslo, two words, «Torgrim» (one of two words, 255 km away) scores below the Oslo bakeries without either.
      const OSLO = { lat: 59.9139, lng: 10.7522 };
      const ranked = marketplaceRegistry.discover({ ...parse("brød, kransekake og marsipan"), location: OSLO, maxDistanceKm: 300, limit: 50 }, undefined,
        { trackDiscovery: false });
      const score = (agentId: string) => ranked.find((r) => r.agent.id === agentId)?.relevanceScore ?? NaN;
      const firstWithout = ranked.findIndex((r) => !KRANS.includes(r.agent.id));
      assertTrue(score(TORGRIM) < score(BYBAKST) && ranked.slice(firstWithout).every((r) => !KRANS.includes(r.agent.id)) && ids(ranked).includes(TORGRIM),
        `next to a category word every producer with a match comes before every producer without one, whatever the relevance (got ${JSON.stringify(ranked.map((r) => r.agent.name))})`);
      assertEq([meta.productMatches?.get(GRINI), meta.unmatchedTerms], [["Kransekake 18 ringer boks", "Kransekake 18 ringer tårn"], undefined],
        "discover meta: the matching product names; no unmatchedTerms");
      const bakeryText = await search("Which bakeries make kransekake");
      const shown = namesIn(bakeryText);
      assertEq(shown.slice(0, 6), KRANS_NAMES, "lokal_search «Which bakeries make kransekake» (acceptance criterion): the kransekake producers first, Grini first");
      assertTrue(shown.length === 10 && KRANS_NAMES.every((n) => !bakeryText.includes(`${n} — Kategoritreff`))
        && shown.slice(6).every((n) => bakeryText.includes(`**${shown.indexOf(n) + 1}. ${n} — Kategoritreff / category-only: «kransekake» ikke oppført`)),
      `lokal_search: the other bakeries follow, each marked a category match for «kransekake» (got ${JSON.stringify(shown)})`);

      // No match next to a category word: the words are left alone, as in I-W
      const zMeta: any = {};
      assertEq([parse("brød zzzqqx").categories, parse("brød zzzqqx")._unknownTerms, discover("brød zzzqqx", zMeta), zMeta.productMatches, zMeta.unmatchedTerms],
        [["bakery"], ["zzzqqx"], discover("brød"), undefined, undefined],
        "«brød zzzqqx»: no product matches «zzzqqx», so the bakeries of «brød» in the same order, with no product matches and no unmatchedTerms");
      assertEq((await search("brød zzzqqx")).replace("\"brød zzzqqx\"", "\"brød\""), await search("brød"),
        "lokal_search «brød zzzqqx»: the answer of «brød», labelled by «brød» as before");
    }

    // ══════════════════════════════════════════════════════════════
    // S1: words for the occasion, meal, size or packaging
    // ══════════════════════════════════════════════════════════════
    {
      const cases: Array<[string, string, string[]]> = [
        ["kransekake til lunsj", "kransekake", KRANS],
        ["kransekake til selskap", "kransekake", KRANS],
        ["kransekake som gave", "kransekake", KRANS],
        ["syltetøy til frokost", "syltetøy", [SYLT_REAL, SYLT_LABEL]],
        ["spekepølse som gave", "spekepølse", [SPEKE]],
      ];
      const noise = [LUNSJ, SELSKAP, GAVE, FROKOST];
      for (const [q, item, expected] of cases) {
        const found = discover(q);
        assertEq([parse(q)._unknownTerms, found], [[item], expected],
          `«${q}» (acceptance criterion): only «${item}» is looked up, so no producer that matches only the qualifier word ranks before (or at all among) those with the product`);
        assertTrue(!namesIn(await search(q)).some((n) => ["Lillehammer Kafé Fixture", "Kafé Lokalet Fixture", "Bua i Bygda Fixture", "Morgenstund Fixture"].includes(n))
          && !found.some((x) => noise.includes(x)), `lokal_search «${q}»: no noise producer`);
      }
      assertEq([parse("stor kransekake")._unknownTerms, discover("stor kransekake").includes(STORFE)], [["kransekake"], false],
        "«stor kransekake»: «stor» does not bring in «Storfekjøtt»");
      assertEq([parse("kransekake til jul")._unknownTerms, discover("kransekake til jul").includes(JULEKAKE)], [["kransekake"], false],
        "«kransekake til jul»: «jul» does not bring in «Julekake»");
      assertEq([parse("kransekake til 17. mai")._unknownTerms, discover("kransekake til 17. mai").includes(TOMTERMAIS)], [["kransekake"], false],
        "«kransekake til 17. mai»: «mai» does not bring in «Mais»");

      // Alone, a qualifier word still finds what matches it; next to a category word it counts for nothing
      assertEq([parse("lunsj")._unknownTerms, discover("lunsj"), parse("gave til jul")._unknownTerms],
        [["lunsj"], [LUNSJ], ["gave", "jul"]], "a search of qualifier words only still looks them up («lunsj» finds lunch)");
      assertEq([parse("brød til frokost").categories, parse("brød til frokost")._unknownTerms], [["bakery"], undefined],
        "next to a category word a qualifier word is no unknown word («brød til frokost»)");
      assertEq([parse("kransekake bryllup")._unknownTerms, discover("kransekake bryllup")[0]], [["kransekake", "bryllup"], FLATOY],
        "«bryllup» names a product («Kransekake bryllup»), so it stays a word to look up, as in I-W");
    }
  } finally {
    console.log = prevLog;
    fixtures.restore();
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runRfbSokFyllordNavnekapringTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
