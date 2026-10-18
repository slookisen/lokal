/**
 * rfb-sok-fyllord-ikke-sted.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-W4 (found live 2026-10-18
 * on 7131787f, P1): the RFB search's place reading (geocoding-service.ts
 * extractAndGeocode, marketplace-registry.ts isPlaceWord, placeWordsIn and
 * parseNaturalQuery, lokal_search).
 *
 * - Kartverket geocodes «Finnes» as a place (62.12 N 6.55 Ø, radius 15 km),
 *   so «Finnes det noen bakeri som lager kransekake» and «Finnes det
 *   kransekake» searched 15 km around a small village and answered «Ingen
 *   resultater», and «Finnes det noen bakeri med kransekake i Bærum» never
 *   reached Bærum. A filler word (QUERY_STOPWORDS, NO_PRODUCT_WORDS,
 *   QUALIFIER_WORDS, plus the nynorsk question words «kven», «kvar», «kvifor»,
 *   «korfor» and «finst» for the place reading only: FILLER_WORDS in
 *   search-intent/rfb-filler-words.ts) is no place now, unless a place
 *   preposition stands right before it («i Finnes», «på Time») or it is the
 *   whole search («Finnes»). The geocoder no longer looks it up alone; its
 *   runs of two and three words are looked up as before. The three searches
 *   that geocode free text (MCP lokal_search, GET /api/marketplace/search,
 *   GET /sok) all read it through extractAndGeocode, checked through their
 *   own handlers.
 * - The class in the repo's own place data: «nå» (poststed NÅ, and the city
 *   of two live producers, which geocode() finds before Kartverket), «time»
 *   (Time kommune), «feiring» (poststed FEIRING) and «more» (Møre in ASCII,
 *   which stays a place word by its own list). isPlaceWord() reads none of
 *   the first three as a place alone, and placeWordsIn() reads them as one
 *   only where the search says so.
 * - The parser: next to a category word, a place right after a place
 *   preposition is no part of a producer name in Pass 1. «… bakeri med
 *   kransekake i Bærum» was the name query «kransekake Bærum», which found the
 *   producers named after Bærum and not Grini, and «bakeri i Bærum» found
 *   only them. Without a category word the place stays («gård i Valen»), and
 *   so does a word of a place of several words («bakeri i Mo i Rana» finds
 *   Bakeriet Mo i Rana by name, as before).
 * - B1: «Finnes», «i Finnes» and the other searches that name such a place
 *   answer byte for byte as main (tests/fixtures/rfb-sok-i-w4-main.json,
 *   captured with fyllordStedMainCapture below on main 7131787f, with the
 *   Kartverket stub LIVE_PLACES). The geocoder's lookups are main's without
 *   the filler words alone, also for the texts slice I-Y2 pinned
 *   (tests/fixtures/dyre-oppslag-tak-i-y2-main.json, whose hashes main's
 *   lists here are checked against); dyre-oppslag-tak.test.ts leaves that
 *   one row to this test.
 *
 * Data: the fixtures of I-W, I-W2 and I-W3 plus I_W4_SEEDS, in an in-memory
 * DB with the production schema (restored in finally); for the geocoder's
 * lookups I-Y's fixtures (enterRfb), as in dyre-oppslag-tak.test.ts.
 * Kartverket is a stub: LIVE_PLACES (the live «Finnes», and Time and Feiring)
 * or, as the worst case, every filler word a place. No network. MCP tools
 * through a duck-typed server; the frozen MCP contract is pinned in
 * rfb-mcp-contract-freeze.test.ts.
 *
 * Exported runRfbSokFyllordIkkeStedTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-sok-fyllord-ikke-sted.test.ts
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { __clearGeocodeCacheForTesting, __setGeocodingFetchForTesting, geocodingService } from "../services/geocoding-service";
import type { Seed, CatalogRow } from "./rfb-kategorietiketter-ikke-tilbud.test";
import { I_W_SEEDS, enterFixtures, captureTools, textOf, namesIn } from "./rfb-sok-ukjente-ord-bakeri-sted.test";
import { I_W2_SEEDS } from "./rfb-sok-fyllord-navnekapring.test";
import { I_W3_SEEDS } from "./rfb-sok-pass1-fyllord.test";
import { enterRfb } from "./fritekst-lengdetak-alle-plattformer.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const id = (n: number) => `1f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// I-W's ids that the expectations name
const GRINI = id(1), BAERUMNAVN = id(2), TRD_HONEY = id(12), TRD_LABEL = id(13), VALEN = id(21);
// A honey producer in Time kommune, a fruit farm in Nå (live: two producers have «Nå» as their city), an egg farm in Feiring,
// and a bakery named after a place of several words (live: «Bakeriet Mo i Rana AS»)
const JAERHONNING = id(171), SORFJORDFRUKT = id(172), FEIRING_EGG = id(173), MO_BAKERI = id(174);

/** A producer whose knowledge products and catalog rows are the same names (and prices). */
function seed(n: string, name: string, lat: number, lng: number, city: string, categories: string[], catalog: CatalogRow[]): Seed {
  return {
    id: n, name, lat, lng, city, categories,
    products: catalog.map((c) => ({ name: c.name, category: c.category ?? categories[0], ...(c.priceNok ? { price: `${c.priceNok} kr` } : {}) })),
    catalog,
  };
}

export const I_W4_SEEDS: Seed[] = [
  seed(JAERHONNING, "Jærhonning Fixture", 58.7356, 5.6477, "Bryne", ["honey"], [{ name: "Lynghonning", priceNok: 149 }]),
  seed(SORFJORDFRUKT, "Sørfjordfrukt Fixture", 60.25, 6.57, "Nå", ["fruit"], [{ name: "Epler", priceNok: 40 }]),
  seed(FEIRING_EGG, "Eidsvoll Egg Fixture", 60.51, 11.17, "Feiring", ["eggs"], [{ name: "Egg", priceNok: 55 }]),
  seed(MO_BAKERI, "Bakeriet Mo i Rana Fixture", 66.3128, 14.1428, "Mo i Rana", ["bakery"], [{ name: "Polarbrød", priceNok: 49 }]),
];

/**
 * Kartverket's Stedsnavn as the stub answers it: these names give one
 * record (official name, type, point); every other name, and Kommuneinfo,
 * is a 404. «Finnes» is the live point (lokal_geocode, 2026-10-18); Time
 * kommune and the bygd Feiring are approximate.
 */
export const LIVE_PLACES: Readonly<Record<string, readonly [type: string, lat: number, lng: number]>> = {
  finnes: ["Grend", 62.12, 6.55],
  time: ["Kommune", 58.7337, 5.6476],
  feiring: ["Bygdelag (bygd)", 60.51, 11.17],
};

/** A geocoder fetch that answers `places` as Kartverket would and pushes each name asked (Stedsnavn `sok`, Kommuneinfo `knavn`). */
function kartverketStub(places: (name: string) => readonly [string, number, number] | undefined, asked: string[] = []): typeof fetch {
  return (async (url: unknown) => {
    const params = new URL(String(url)).searchParams;
    const sok = params.get("sok");
    asked.push(sok ?? params.get("knavn") ?? "");
    const place = sok === null ? undefined : places(sok.toLowerCase());
    if (!place) return { ok: false, status: 404, json: async () => ({}) } as Response;
    const [type, nord, øst] = place;
    return {
      ok: true, status: 200,
      json: async () => ({ navn: [{ navneobjekttype: type, representasjonspunkt: { nord, øst }, stedsnavn: [{ skrivemåte: sok, navnestatus: "hovednavn" }], kommuner: [] }] }),
    } as Response;
  }) as typeof fetch;
}

/** Searches that name a place the filler lists hold, where the search says so: answered as main. */
export const AS_MAIN_QUERIES: readonly string[] = [
  "Finnes", "i Finnes", "honning ved Finnes", "Time", "honning i Time", "honey in Time", "på Time", "Feiring", "egg i Feiring", "Nå", "frukt på Nå",
];

/** Texts whose geocoder lookups this test compares with main's, besides the ones I-Y2 pinned. */
export const W4_GEOCODE_TEXTS: readonly string[] = [
  "Finnes det noen bakeri som lager kransekake", "Finnes det kransekake", "Finnes det noen bakeri med kransekake i Bærum",
  "Finnes det økologisk honning i Trondheim?", "i Finnes", "Finnes", "Er det noen bakeri som lager kransekake", "Hvem selger kransekake nå?",
  "kransekake til feiring", "honning i Time", "What time does the farm shop in Bergen open?", "honning på Lager", "Finst det kransekake",
];

const MAIN_FIXTURE = path.join(__dirname, "../../tests/fixtures/rfb-sok-i-w4-main.json");
const IY2_FIXTURE = path.join(__dirname, "../../tests/fixtures/dyre-oppslag-tak-i-y2-main.json");
const GEOCODER_ENTRY = "rfb geocoder lookups (extractAndGeocode)";

/** The texts slice I-Y2 pinned the geocoder's lookups for (the keys of its fixture's row). */
function iy2GeocodeTexts(): string[] {
  const iy2 = JSON.parse(fs.readFileSync(IY2_FIXTURE, "utf8")) as { answers: Record<string, Record<string, { sha256: string }>> };
  return Object.keys(iy2.answers[GEOCODER_ENTRY] ?? {}).map((k) => JSON.parse(k) as string);
}

/** I-W's, I-W2's, I-W3's and I-W4's fixtures, with `places` as Kartverket. */
function enterW4Fixtures(fetchImpl: typeof fetch): ReturnType<typeof enterFixtures> {
  const fixtures = enterFixtures([...I_W_SEEDS, ...I_W2_SEEDS, ...I_W3_SEEDS, ...I_W4_SEEDS]);
  __setGeocodingFetchForTesting(fetchImpl);
  return fixtures;
}

/** The geocoder's outbound requests for `text`, every one a 404, on a clean cache (as dyre-oppslag-tak.test.ts b1Answers records them). */
async function geocoderUrls(text: string): Promise<string[]> {
  const urls: string[] = [];
  __clearGeocodeCacheForTesting();
  __setGeocodingFetchForTesting((async (url: unknown) => { urls.push(String(url)); return { ok: false, status: 404, json: async () => ({}) } as Response; }) as typeof fetch);
  await geocodingService.extractAndGeocode(text);
  return urls;
}

/**
 * main's answers for this test: lokal_search's text for AS_MAIN_QUERIES on
 * these fixtures with LIVE_PLACES as Kartverket (BASE_URL unset, client
 * test-client), and the geocoder's requests for the texts I-Y2 pinned and
 * W4_GEOCODE_TEXTS on I-Y's fixtures, every request a 404. Uses only what
 * main has, so main's answers are captured with it:
 * tests/fixtures/rfb-sok-i-w4-main.json.
 */
export async function fyllordStedMainCapture(): Promise<{ lokal_search: Record<string, string>; geocoder: Record<string, string[]> }> {
  const prevLog = console.log;
  console.log = () => { /* silence module chatter */ };
  try {
    const lokal_search: Record<string, string> = {};
    const fixtures = enterW4Fixtures(kartverketStub((name) => LIVE_PLACES[name]));
    try {
      const tools = captureTools();
      for (const q of AS_MAIN_QUERIES) {
        __clearGeocodeCacheForTesting();
        lokal_search[q] = textOf(await tools.get("lokal_search")!({ query: q, limit: 10 }));
      }
    } finally {
      fixtures.restore();
    }
    const geocoder: Record<string, string[]> = {};
    const rfb = enterRfb();
    try {
      for (const text of [...iy2GeocodeTexts(), ...W4_GEOCODE_TEXTS]) geocoder[text] = await geocoderUrls(text);
    } finally {
      rfb.restore();
      __setGeocodingFetchForTesting();
      __clearGeocodeCacheForTesting();
    }
    return { lokal_search, geocoder };
  } finally {
    console.log = prevLog;
  }
}

export async function runRfbSokFyllordIkkeStedTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // Slice I-W4's own module, required here so fyllordStedMainCapture runs on main too.
  const { FILLER_WORDS, isFillerNoPlaceAt, NO_PRODUCT_WORDS } =
    require("../services/search-intent/rfb-filler-words") as typeof import("../services/search-intent/rfb-filler-words");
  const { PLACE_PREPOSITIONS, QUERY_STOPWORDS } =
    require("../services/search-intent/norwegian-query") as typeof import("../services/search-intent/norwegian-query");
  const { marketplaceRegistry, isPlaceWord, placeWordsIn } =
    require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const main = JSON.parse(fs.readFileSync(MAIN_FIXTURE, "utf8")) as { lokal_search: Record<string, string>; geocoder: Record<string, string[]> };

  // ══════════════════════════════════════════════════════════════
  // B1 and the geocoder's lookups: main's, without the filler words alone
  // ══════════════════════════════════════════════════════════════
  // Own DB (I-Y's fixtures), before the fixtures below.
  {
    const iy2 = JSON.parse(fs.readFileSync(IY2_FIXTURE, "utf8")) as { answers: Record<string, Record<string, { sha256: string }>> };
    const pinned = iy2GeocodeTexts();
    const mainHashes = pinned.filter((t) => createHash("sha256").update((main.geocoder[t] ?? ["?"]).join("\n")).digest("hex")
      === iy2.answers[GEOCODER_ENTRY][JSON.stringify(t)].sha256);
    assertEq([pinned.length, mainHashes.length], [27, 27],
      "setup: main's lookups in this test's fixture are the ones dyre-oppslag-tak-i-y2-main.json pinned for its 27 texts (same sha256)");

    const placeAsked = (url: string) => { const p = new URL(url).searchParams; return p.get("sok") ?? p.get("knavn") ?? ""; };
    /** The words of `text` as extractAndGeocode() reads them (lower case, without ?!., split at white space). */
    const wordsOf = (text: string) => text.toLowerCase().replace(/[?!.,]/g, "").trim().split(/\s+/);
    const prevLog = console.log;
    if (!log) console.log = () => { /* silence module chatter */ };
    const rfb = enterRfb();
    const bad: string[] = [];
    let dropped = 0;
    let droppedFinnes = 0;
    try {
      for (const text of Object.keys(main.geocoder)) {
        const was = main.geocoder[text];
        const now = await geocoderUrls(text);
        const tokens = wordsOf(text);
        // A word may be a place where it stands: right after a place preposition, or as the whole search.
        const mayBePlace = (w: string) => tokens.length === 1 || tokens.some((t, i) => t === w && i > 0 && PLACE_PREPOSITIONS.has(tokens[i - 1]));
        // now is was without some requests (an ordered subsequence) ...
        let j = 0;
        for (const url of was) {
          if (url === now[j]) { j++; continue; }
          const w = placeAsked(url);
          dropped++;
          if (w === "finnes") droppedFinnes++;
          // ... and each request left out asks a filler word alone, where the search names no place with it
          if (w.includes(" ") || !FILLER_WORDS.has(w) || mayBePlace(w)) bad.push(`${JSON.stringify(text)}: left out ${w}`);
        }
        if (j !== now.length) bad.push(`${JSON.stringify(text)}: ${now.length - j} requests main did not make`);
        // ... and no request left asks a filler word alone, unless the search names a place with it
        for (const url of now) {
          const w = placeAsked(url);
          if (!w.includes(" ") && FILLER_WORDS.has(w) && !mayBePlace(w)) bad.push(`${JSON.stringify(text)}: still asks ${w}`);
        }
      }
      // The three searches that geocode free text, through their own handlers
      const surfaces = ["rfb mcp lokal_search", "rfb GET /api/marketplace/search", "rfb GET /sok"];
      const asksFinnes: boolean[][] = [];
      for (const surface of surfaces) {
        const row: boolean[] = [];
        for (const text of ["Finnes det noen bakeri som lager kransekake", "i Finnes"]) {
          const urls: string[] = [];
          __clearGeocodeCacheForTesting();
          __setGeocodingFetchForTesting((async (url: unknown) => { urls.push(String(url)); return { ok: false, status: 404, json: async () => ({}) } as Response; }) as typeof fetch);
          await rfb.asks[surface]!(text);
          row.push(urls.map(placeAsked).includes("finnes"));
        }
        asksFinnes.push(row);
      }
      assertEq(asksFinnes, surfaces.map(() => [false, true]),
        `${surfaces.join(", ")}: «Finnes det noen bakeri som lager kransekake» does not look «finnes» up as a place, «i Finnes» does`);
    } finally {
      rfb.restore();
      __setGeocodingFetchForTesting();
      __clearGeocodeCacheForTesting();
      console.log = prevLog;
    }
    assertTrue(bad.length === 0 && dropped > 0 && droppedFinnes > 0,
      `the geocoder's requests are main's without the filler words alone (${dropped} left out of ${Object.values(main.geocoder).flat().length}, `
        + `«finnes» ${droppedFinnes} times), for I-Y2's texts and the searches of this slice${bad.length ? `: ${bad.slice(0, 8).join("; ")}` : ""}`);
    assertEq([main.geocoder["i Finnes"].map(placeAsked), main.geocoder["Finnes"].map(placeAsked)], [["finnes", "finnes"], ["finnes", "finnes"]],
      "setup: on main «i Finnes» and «Finnes» ask Stedsnavn and Kommuneinfo for «finnes» (and so do they now, checked above)");
  }

  const asked: string[] = [];
  let places: (name: string) => readonly [string, number, number] | undefined = (name) => LIVE_PLACES[name];
  const fixtures = enterW4Fixtures(kartverketStub((name) => places(name), asked));
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence module chatter */ };

  try {
    const tools = captureTools();
    const parse = (q: string) => marketplaceRegistry.parseNaturalQuery(q) as ReturnType<typeof marketplaceRegistry.parseNaturalQuery> & { _nameQuery?: string };
    const search = async (q: string) => { __clearGeocodeCacheForTesting(); return textOf(await tools.get("lokal_search")!({ query: q, limit: 10 })); };
    /** lokal_search's text for `q`, with the search as shown in the header put back to `as`. */
    const searchAs = async (q: string, as: string) => (await search(q)).split(`"${q}"`).join(`"${as}"`);
    const geo = async (q: string) => { __clearGeocodeCacheForTesting(); const g = await geocodingService.extractAndGeocode(q); return g && g.name.toLowerCase(); };
    const KRANS_NAMES = ["Grini Hjemmebakeri Fixture", "Flatøy Hjemmebakeri Fixture", "Torgrim Hansen Bakeri Fixture", "Baker Walderhaug Fixture",
      "Mandelbakeren Fixture", "Ringbakeriet Fixture"];

    // ══════════════════════════════════════════════════════════════
    // B1: a place the filler lists hold, named as a place, answers as main
    // ══════════════════════════════════════════════════════════════
    {
      for (const q of AS_MAIN_QUERIES) {
        const text = await search(q);
        const at = [...text].findIndex((ch, i) => ch !== [...(main.lokal_search[q] ?? "")][i]);
        assertTrue(text === main.lokal_search[q], `B1 «${q}» (acceptance criterion for «i Finnes» and «Finnes»): lokal_search answers byte for byte as main`
          + (text === main.lokal_search[q] ? "" : ` (first difference at ${at}: ${JSON.stringify(text.slice(Math.max(0, at - 40), at + 80))})`));
      }
      assertEq([namesIn(main.lokal_search.Finnes), namesIn(main.lokal_search["i Finnes"]), namesIn(main.lokal_search["honning i Time"])],
        [["Finnes Gård Fixture"], ["Finnes Gård Fixture"], ["Jærhonning Fixture"]],
        "setup: on main «Finnes» and «i Finnes» find Finnes Gård by name, and «honning i Time» the honey producer in Time");
      assertEq([await geo("Finnes"), await geo("i Finnes"), await geo("honning ved Finnes"), await geo("honning i Time"), await geo("frukt på Nå")],
        ["finnes", "finnes", "finnes", "time", "nå"],
        "the geocoder: a filler word that is the whole search or stands right after a place preposition is still looked up as a place");
    }

    // ══════════════════════════════════════════════════════════════
    // «Finnes det …»: the acceptance criteria
    // ══════════════════════════════════════════════════════════════
    {
      for (const q of ["Finnes det noen bakeri som lager kransekake", "Finnes det kransekake", "Fins det kransekake", "Finst det kransekake"]) {
        asked.length = 0;
        const text = await search(q);
        const first = q.split(" ")[0].toLowerCase();
        assertEq([namesIn(text).slice(0, 6), asked.includes(first), await geo(q), parse(q)._nameQuery], [KRANS_NAMES, false, null, undefined],
          `«${q}» (acceptance criterion): the kransekake producers first, Grini first; «${first}» is not looked up as a place, and there is no name search`);
      }
      assertTrue(await searchAs("Finst det kransekake", "Finnes det kransekake") === await search("Finnes det kransekake"),
        "«Finst det kransekake» (nynorsk) answers as «Finnes det kransekake»");
      for (const q of ["Finnes det noen bakeri med kransekake i Bærum", "Finnes det noen bakeri som lager kransekake i Bærum", "bakeri med kransekake i Bærum"]) {
        const text = await search(q);
        const names = namesIn(text);
        assertEq([names[0], names.includes("Bærum Gårdsmat Fixture"), await geo(q), parse(q)._nameQuery, parse(q)._unknownTerms],
          ["Grini Hjemmebakeri Fixture", false, "bærum", undefined, ["kransekake"]],
          `«${q}» (acceptance criterion): Grini first, near Bærum; no name search for the producers named after Bærum`);
      }
      {
        const q = "Finnes det økologisk honning i Trondheim?";
        const text = await search(q);
        assertEq([namesIn(text).sort(), await geo(q), await searchAs(q, "økologisk honning i Trondheim") === await search("økologisk honning i Trondheim")],
          [["Hevd Etikett Fixture", "Tirslaug Birøkt Fixture"], "trondheim", true],
          `«${q}» (acceptance criterion): the honey producers in Trondheim, as «økologisk honning i Trondheim»`);
        assertEq([TRD_HONEY, TRD_LABEL].length, 2, "setup: the two honey producers of the fixtures in Trondheim");
      }
      assertEq([namesIn(await search("Er det noen bakeri som lager kransekake")).slice(0, 6), namesIn(await search("bakeri som lager kransekake")).slice(0, 6)],
        [KRANS_NAMES, KRANS_NAMES], "«Er det noen bakeri som lager kransekake» and «bakeri som lager kransekake» answer as before, Grini first");
    }

    // ══════════════════════════════════════════════════════════════
    // The class: the words of the lists the repo's place data knows
    // ══════════════════════════════════════════════════════════════
    {
      const fillers = [...FILLER_WORDS];
      assertEq(fillers.filter((w) => placeWordsIn(w).has(w)).sort(), ["feiring", "more", "nå", "time"],
        "the class: of the filler words the gazetteer has «nå» (poststed), «time» (kommune) and «feiring» (poststed); «more» is a place word by its own list");
      assertEq(fillers.filter((w) => isPlaceWord(w)), ["more"], "isPlaceWord: no filler word is a place word alone, but «more»");
      assertEq(fillers.filter((w) => placeWordsIn(`kransekake ${w}`).has(w) || placeWordsIn(`${w} honning`).has(w)), ["more"],
        "placeWordsIn: next to another word without a place preposition, no filler word is a place word (but «more»)");
      assertEq(["nå", "time", "feiring"].map((w) => [...PLACE_PREPOSITIONS].every((p) => placeWordsIn(`honning ${p} ${w}`).has(w))), [true, true, true],
        "placeWordsIn: right after each place preposition they are place words");
      assertEq([placeWordsIn("What time does the farm shop in Bergen open?").has("time"), placeWordsIn("honning i Møre og Romsdal").has("og"),
        placeWordsIn("Stor-Elvdal honning").has("stor"), placeWordsIn("egg Mo i Rana").has("mo")], [false, true, true, true],
      "placeWordsIn: «time» in a question is none; a filler word inside a place of several words still is («og», «stor» in «Stor-Elvdal», «i»)");
      assertEq([isFillerNoPlaceAt(["finnes", "det"], 0), isFillerNoPlaceAt(["i", "finnes"], 1), isFillerNoPlaceAt(["finnes"], 0),
        isFillerNoPlaceAt(["fra", "finnes"], 1), isFillerNoPlaceAt(["honning", "bergen"], 1)], [true, false, false, true, false],
      "isFillerNoPlaceAt: a filler word is no place, except right after a place preposition or as the whole search («fra» is none)");
      const nynorsk = ["kven", "kvar", "kvifor", "korfor", "finst"];
      assertEq(nynorsk.filter((w) => !FILLER_WORDS.has(w) || NO_PRODUCT_WORDS.has(w) || QUERY_STOPWORDS.has(w) || isPlaceWord(w)), [],
        "the nynorsk question words are filler words for the place reading only (in neither NO_PRODUCT_WORDS nor the shared list), and none is a place word");
      assertEq([parse("kven")._unknownTerms, parse("Kven sel kransekake")._unknownTerms], [["kven"], ["kven", "kransekake"]],
        "the parser reads them as before («kven» alone is still a word to look up, as on main)");
    }

    // ══════════════════════════════════════════════════════════════
    // The geocoder, when Kartverket knows every filler word as a place
    // ══════════════════════════════════════════════════════════════
    {
      places = (name) => (FILLER_WORDS.has(name) ? ["Grend", 70.5, 25.5] as const : LIVE_PLACES[name]);
      const placeNamed: string[] = [];
      let alone = 0;
      for (const w of FILLER_WORDS) {
        for (const q of [`kransekake ${w}`, `${w} kransekake`, `${w} kransekake i Bergen`]) {
          const g = await geo(q);
          if (g !== null && g !== "bergen") placeNamed.push(`«${q}» → ${g}`);
        }
        // after a place preposition, as when it is the whole search (both skip extractAndGeocode's own skip words)
        const whole = await geo(w);
        if (whole !== null) alone++;
        if (await geo(`honning i ${w}`) !== whole || await geo(`honey near ${w}`) !== whole) placeNamed.push(`«honning i ${w}» ≠ «${w}»`);
      }
      assertTrue(placeNamed.length === 0, `no filler word becomes the place of a search, and a real place after it still wins («… i Bergen») (${FILLER_WORDS.size} words)`
        + (placeNamed.length ? `: ${placeNamed.slice(0, 8).join("; ")}` : ""));
      assertTrue(alone > 0.9 * FILLER_WORDS.size,
        `…but after a place preposition or as the whole search it is looked up as before (${alone} of ${FILLER_WORDS.size} resolve; the rest are the geocoder's own skip words)`);
      assertEq([await geo("kransekake fra finnes"), await geo("Finnes det kransekake"), await geo("Finnes det kransekake i Time")], [null, null, "time"],
        "«fra» is no place preposition, and «i Time» wins over «Finnes»");
      places = (name) => LIVE_PLACES[name];
    }

    // ══════════════════════════════════════════════════════════════
    // The parser: a place after a preposition next to a category word
    // ══════════════════════════════════════════════════════════════
    {
      const p = parse("bakeri i Bærum");
      const text = await search("bakeri i Bærum");
      assertEq([p._nameQuery, p.categories, namesIn(text)[0], namesIn(text).includes("Bærum Gårdsmat Fixture")],
        [undefined, ["bakery"], "Grini Hjemmebakeri Fixture", false],
        "«bakeri i Bærum»: the bakeries near Bærum, not the name search «Bærum» (which found Bærum Gårdsmat alone)");
      assertEq([parse("Bærum Gårdsmat")._nameQuery, parse("gård i Valen")._nameQuery, parse("Tromsø Bakeri")._productTerms],
        ["Bærum Gårdsmat", "gård Valen", ["bakeri"]],
        "a name with the place in it is still a name search, and without a category word the place stays in the name query («gård i Valen»)");
      assertEq(marketplaceRegistry.discover({ ...parse("gård i Valen"), limit: 5 }, undefined, { trackDiscovery: false }).map((r) => r.agent.id), [VALEN],
        "«gård i Valen» finds Valen Gård, as before");
      assertEq([parse("bakeri i Mo i Rana")._nameQuery, namesIn(await search("bakeri i Mo i Rana"))[0]], ["Mo Rana", "Bakeriet Mo i Rana Fixture"],
        "a word of a place of several words stays in the name query, as before («bakeri i Mo i Rana» finds Bakeriet Mo i Rana by name; "
          + "the geocoder never looks «Mo i Rana» up whole)");
      assertEq([parse("kransekake til feiring")._unknownTerms, await geo("kransekake til feiring"), namesIn(await search("kransekake til feiring")).slice(0, 6)],
        [["kransekake"], null, KRANS_NAMES], "«kransekake til feiring»: «feiring» names no place, and the kransekake producers come first");
      assertEq([await geo("Hvem selger kransekake nå?"), namesIn(await search("Hvem selger kransekake nå?")).slice(0, 6)], [null, KRANS_NAMES],
        "«Hvem selger kransekake nå?»: «nå» is not the city of Sørfjordfrukt (geocode()'s DB tier), and the kransekake producers come first");
      assertEq([await geo("What time does the farm shop in Bergen open?"), await geo("egg i Feiring"), namesIn(await search("egg i Feiring"))],
        ["bergen", "feiring", ["Eidsvoll Egg Fixture"]], "«What time does …» is no search in Time, and «egg i Feiring» is one in Feiring");
      assertEq([GRINI, BAERUMNAVN, JAERHONNING, SORFJORDFRUKT, MO_BAKERI].length, 5, "setup: the fixtures named above");
    }
  } finally {
    console.log = prevLog;
    fixtures.restore();
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  if (process.argv.includes("--print")) {
    // main's answers for the fixture (see the header).
    fyllordStedMainCapture().then((answers) => {
      console.log(JSON.stringify(answers, null, 1));
      process.exit(0);
    }).catch((err) => { console.error(err); process.exit(1); });
  } else {
    runRfbSokFyllordIkkeStedTests({ log: true }).then((s) => {
      console.log(`\n${s.passed} passed, ${s.failed} failed`);
      // Explicit exit: requiring the route modules leaves background timers open.
      process.exit(s.failed > 0 ? 1 : 0);
    });
  }
}
