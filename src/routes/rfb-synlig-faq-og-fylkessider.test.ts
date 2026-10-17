/**
 * rfb-synlig-faq-og-fylkessider.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, I-E (SD-01, SD-02), from
 * reports/2026-10-17-integrasjonstest-synlighet.md in the A2A repo.
 *
 * SD-01: RFB producer and place pages emitted FAQPage JSON-LD with no visible
 * FAQ. They now render a <section id="faq"> from the same FAQPage object.
 * SD-02: /vestland, /akershus, /vestfold were "city" pages holding only the
 * producer(s) whose `city` is the fylke name (/vestland: one producer, in
 * Fredrikstad), and the FAQ stated that count as fact. A fylke slug now lists
 * the producers placed in the fylke, counted for real, and the sitemap uses
 * the same predicate.
 *
 * Covers:
 *   (a) pure: fylkeForPlaceSlug() for every current fylke, Oslo, old names,
 *       merged 2020-2023 names, cities and non-slug spellings;
 *       producerPlaceFylke() for kommuner, towns, the Bø/Os name clashes,
 *       fylke names, unknown places, a trailing " kommune", the producer's
 *       own coordinate (veto outside the fylke's box, no veto from a missing
 *       or 0/0 coordinate, a border case) and the shared names (Nes, Sande,
 *       Hemnes, Osen, Åmot need a coordinate in the kommune's own box);
 *       placeSlugsForCity() with and without a coordinate.
 *   (b) pure: buildCityFaqJsonLd({isFylke}) says how the fylke count is made;
 *       the city wording is unchanged.
 *   (c) SD-01 on five pages: /bergen, /vestland, /en/vestland,
 *       /produsent/<slug>, /en/produsent/<slug>: the visible FAQ pairs equal
 *       the FAQPage pairs, the section id is the FAQPage @id anchor, /en marks
 *       the Norwegian section lang="nb"; a producer whose FAQ is gated out
 *       gets no section and no FAQ CSS; a producer name with & ' and < is
 *       escaped in the visible FAQ.
 *   (d) SD-02 regression (repro: /vestland showed 1 producer, in
 *       Fredrikstad): /vestland lists the Bergen and Voss producers only;
 *       hero, FAQ, meta description and LocalBusiness count all equal the
 *       cards; addressLocality is the producer's own place; the fylke-named
 *       Fredrikstad producer, an unknown place (Norheimsund) and the
 *       ambiguous Os are not listed; /rogaland (none) answers 404; /oslo,
 *       /bergen, /bo stay city pages with their old wording.
 *   (e) review B1 on lokal#1109, live repro with live coordinates: the three
 *       Sande i Vestfold producers are not on /more-og-romsdal (which lists
 *       only its Rauma producer, FAQ count 1); Mølstad Gård (Nes på Hedmark)
 *       and Furuset Tunet (Nes i Ådal) are not on /akershus, Rånås Gård
 *       (Auli) is, and the FAQ says 1; Åmot in Modum is not on /innlandet; a
 *       "Hamar" producer whose coordinate is in Rana is on neither /innlandet
 *       nor /nordland; "Lier kommune" with a 0/0 coordinate is on /buskerud.
 *   (f) sitemap: fylke pages exactly when they have producers, lastmod is
 *       the newest of them, no duplicate <loc>, and every place <loc> answers
 *       200 with at least one producer card.
 *
 * Own in-memory DB, the real seo.ts router's handlers pulled off its route
 * stack, no HTTP server — same harness as rfb-breadcrumblist-jsonld.test.ts.
 *
 * Exported runRfbSynligFaqOgFylkessiderTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-synlig-faq-og-fylkessider.test.ts
 */

import Database from "better-sqlite3";
import { __FYLKE_INTERNAL } from "../services/norway-fylke";
import { slugify } from "../utils/slug";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const BASE_URL = "https://rettfrabonden.com";

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Every JSON-LD block on the page, parsed. */
function jsonLdBlocks(body: string): any[] {
  const out: any[] = [];
  for (const m of body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { out.push(JSON.parse(m[1]!)); } catch { /* not this test's concern */ }
  }
  return out;
}

/** The FAQ section's opening tag and its visible pairs (unescaped), or null without a section. */
function visibleFaq(body: string): { openTag: string; pairs: Array<{ q: string; a: string }> } | null {
  const m = body.match(/(<section id="faq"[^>]*>)([\s\S]*?)<\/section>/);
  if (!m) return null;
  const pairs = [...m[2]!.matchAll(/<div class="faq-item"><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p><\/div>/g)]
    .map((x) => ({ q: unescapeHtml(x[1]!), a: unescapeHtml(x[2]!) }));
  return { openTag: m[1]!, pairs };
}

function ldPairs(faq: any): Array<{ q: string; a: string }> {
  return (faq?.mainEntity || []).map((e: any) => ({ q: e.name, a: e.acceptedAnswer.text }));
}

function cardCount(body: string): number {
  return (body.match(/class="pc"/g) || []).length;
}

export async function runRfbSynligFaqOgFylkessiderTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const prevDb = (() => { try { return getDb(); } catch { return undefined; } })();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  const origLog = console.log;

  function resetRegistryCache(): void {
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }

    // Fresh module: its place caches start empty.
    delete require.cache[require.resolve("./seo")];
    const seo = require("./seo") as typeof import("./seo");
    const { fylkeForPlaceSlug, producerPlaceFylke, placeSlugsForCity, buildCityFaqJsonLd } = seo;

    // ══ (a) pure place helpers ═══════════════════════════════════════════
    const fylker = __FYLKE_INTERNAL.CANONICAL_FYLKER.filter((f) => f !== "Oslo");
    assertEq(fylker.length, 14, "a: setup — 14 current fylker besides Oslo");
    for (const f of fylker) {
      assertEq(fylkeForPlaceSlug(slugify(f)), f, `a: /${slugify(f)} is the ${f} fylke page`);
    }
    assertEq(fylkeForPlaceSlug("oslo"), null, "a: /oslo stays a city page (Oslo is also a kommune)");
    for (const s of ["hordaland", "sogn-og-fjordane", "hedmark", "aust-agder", "sor-trondelag"]) {
      assertEq(fylkeForPlaceSlug(s), null, `a: old fylke name /${s} is not a fylke page`);
    }
    for (const s of ["viken", "vestfold-og-telemark", "troms-og-finnmark"]) {
      assertEq(fylkeForPlaceSlug(s), null, `a: 2020-2023 merged name /${s} is not a fylke page`);
    }
    for (const s of ["bergen", "tromso", "kristiansand-s", "lofoten", "norge", "", "vest-land", "Vestland", "more-romsdal"]) {
      assertEq(fylkeForPlaceSlug(s), null, `a: "${s}" is not a fylke slug`);
    }

    assertEq(producerPlaceFylke("Bergen"), "Vestland", "a: kommune Bergen -> Vestland");
    assertEq(producerPlaceFylke(" Voss "), "Vestland", "a: kommune Voss (trimmed) -> Vestland");
    assertEq(producerPlaceFylke("Fredrikstad"), "Østfold", "a: kommune Fredrikstad -> Østfold");
    assertEq(producerPlaceFylke("Ås"), "Akershus", "a: kommune Ås -> Akershus");
    assertEq(producerPlaceFylke("Svolvær"), "Nordland", "a: town Svolvær (town table) -> Nordland");
    assertEq(producerPlaceFylke("Oslo"), "Oslo", "a: Oslo -> Oslo");
    assertEq(producerPlaceFylke("Bø"), null, "a: Bø (Telemark town, Nordland kommune) is not guessed");
    assertEq(producerPlaceFylke("Os"), null, "a: Os (Vestland town, Innlandet kommune) is not guessed");
    for (const v of ["Vestland", "Akershus", "Hordaland", "Viken", "Norge", "Norheimsund", "", "   "]) {
      assertEq(producerPlaceFylke(v), null, `a: "${v}" places no producer`);
    }
    assertEq(producerPlaceFylke(null), null, "a: null places no producer");
    assertEq(producerPlaceFylke(undefined), null, "a: undefined places no producer");

    // A trailing " kommune" is not part of the place name (S1).
    assertEq(producerPlaceFylke("Lier kommune"), "Buskerud", "a: \"Lier kommune\" -> Buskerud");
    assertEq(producerPlaceFylke("Rauma kommune"), "Møre og Romsdal", "a: \"Rauma kommune\" -> Møre og Romsdal");
    assertEq(producerPlaceFylke("Austevoll KOMMUNE "), "Vestland", "a: suffix in any case, trimmed -> Vestland");
    assertEq(producerPlaceFylke("Rennesøy kommune"), null, "a: a merged-away kommune is still not placed");
    assertEq(producerPlaceFylke("Kommune"), null, "a: \"Kommune\" alone places no producer");

    // The producer's own coordinate (review B1 on lokal#1109): live coordinates.
    const hamarGeo = { lat: 60.795, lng: 11.068 };
    const ranaGeo = { lat: 66.3173418944786, lng: 14.145752939955319 };
    const raanaasGeo = { lat: 60.04679965585512, lng: 11.33372745180509 };
    const moelstadGeo = { lat: 60.92741454507553, lng: 10.709622024825517 };
    const furusetGeo = { lat: 60.56348, lng: 9.98776 };
    const sandeVestfoldGeo = { lat: 59.5934, lng: 10.2026 };
    const bakkeModumGeo = { lat: 59.9478998491016, lng: 9.800437734468055 };
    assertEq(producerPlaceFylke("Hamar", hamarGeo), "Innlandet", "a: coordinate in the fylke -> placed");
    assertEq(producerPlaceFylke("Hamar", ranaGeo), null, "a: \"Hamar\" with its coordinate in Rana -> not placed (coordinate vetoes)");
    assertEq(producerPlaceFylke("Hamar"), "Innlandet", "a: no coordinate -> the name decides");
    assertEq(producerPlaceFylke("Hamar", null), "Innlandet", "a: null coordinate -> the name decides");
    assertEq(producerPlaceFylke("Hamar", { lat: 0, lng: 0 }), "Innlandet", "a: a 0/0 coordinate is no evidence -> the name decides");
    assertEq(producerPlaceFylke("Hamar", { lat: null, lng: 11.068 }), "Innlandet", "a: half a coordinate is no evidence");
    assertEq(producerPlaceFylke("Nittedal", { lat: 59.97, lng: 10.875 }), "Akershus", "a: a coordinate just over the Oslo border keeps Nittedal in Akershus (the box is coarse)");
    assertEq(producerPlaceFylke("Nes", raanaasGeo), "Akershus", "a: Nes + Rånås Gård's coordinate (Auli) -> Akershus");
    assertEq(producerPlaceFylke("Nes", moelstadGeo), null, "a: Nes + Mølstad Gård's coordinate (Nes på Hedmark) -> not placed");
    assertEq(producerPlaceFylke("Nes", furusetGeo), null, "a: Nes + Furuset Tunet's coordinate (Nes i Ådal) -> not placed");
    assertEq(producerPlaceFylke("Nes"), null, "a: Nes without a coordinate -> not placed (a shared name needs one)");
    assertEq(producerPlaceFylke("Nes", { lat: 0, lng: 0 }), null, "a: Nes with a 0/0 coordinate -> not placed");
    assertEq(producerPlaceFylke("Nes kommune", raanaasGeo), "Akershus", "a: \"Nes kommune\" is the shared name Nes");
    assertEq(producerPlaceFylke("Sande", sandeVestfoldGeo), null, "a: Sande + a Sande i Vestfold coordinate -> not placed (not Møre og Romsdal)");
    assertEq(producerPlaceFylke("Sande", { lat: 62.25, lng: 5.45 }), "Møre og Romsdal", "a: Sande + a coordinate in Sande kommune -> Møre og Romsdal");
    assertEq(producerPlaceFylke("Hemnes", { lat: 59.72085, lng: 11.45524 }), null, "a: Hemnes + Hemnes i Høland's coordinate -> not placed");
    assertEq(producerPlaceFylke("Hemnes", { lat: 65.8833, lng: 14.0333 }), "Nordland", "a: Hemnes + a coordinate in Hemnes kommune -> Nordland");
    assertEq(producerPlaceFylke("Osen", { lat: 61.250179274314576, lng: 11.74469682120022 }), null, "a: Osen + Osen in Åmot's coordinate -> not placed");
    assertEq(producerPlaceFylke("Åmot", bakkeModumGeo), null, "a: Åmot + Åmot in Modum's coordinate -> not placed (inside Innlandet's box, outside Åmot's)");

    assertEq(placeSlugsForCity("Bergen"), ["bergen", "vestland"], "a: Bergen -> its city page and /vestland");
    assertEq(placeSlugsForCity("Oslo"), ["oslo"], "a: Oslo -> /oslo only");
    assertEq(placeSlugsForCity("Lofoten"), ["lofoten", "nordland"], "a: Lofoten -> /lofoten and /nordland");
    assertEq(placeSlugsForCity("Vestland"), [], "a: city \"Vestland\" -> no place page (no city page named after a fylke)");
    assertEq(placeSlugsForCity("Akershus"), [], "a: city \"Akershus\" -> no place page");
    assertEq(placeSlugsForCity("Bø"), ["bo"], "a: Bø -> its city page only");
    assertEq(placeSlugsForCity("Hordaland"), ["hordaland"], "a: Hordaland -> its city page as before");
    assertEq(placeSlugsForCity("Kristiansand S"), ["kristiansand-s"], "a: unknown place -> its city page as before");
    assertEq(placeSlugsForCity(""), [], "a: empty city -> nothing");
    assertEq(placeSlugsForCity("Bergen", { lat: 60.391, lng: 5.322 }), ["bergen", "vestland"], "a: Bergen with a Bergen coordinate -> both pages");
    assertEq(placeSlugsForCity("Bergen", { lat: 59.68178377851215, lng: 10.526837486003666 }), ["bergen"], "a: Bergen with an Asker coordinate -> its city page only");
    assertEq(placeSlugsForCity("Sande", sandeVestfoldGeo), ["sande"], "a: Sande i Vestfold -> /sande only, not /more-og-romsdal");
    assertEq(placeSlugsForCity("Nes", raanaasGeo), ["nes", "akershus"], "a: Rånås Gård -> /nes and /akershus");
    assertEq(placeSlugsForCity("Nes", moelstadGeo), ["nes"], "a: Mølstad Gård -> /nes only");
    assertEq(placeSlugsForCity("Lier kommune"), ["lier-kommune", "buskerud"], "a: \"Lier kommune\" keeps its own page slug and is on /buskerud");
    assertEq(placeSlugsForCity("Oslo", { lat: 59.913, lng: 10.739 }), ["oslo"], "a: Oslo with a coordinate -> /oslo only");

    // ══ (b) buildCityFaqJsonLd wording ═══════════════════════════════════
    {
      const base = { url: `${BASE_URL}/vestland`, topCategories: ["honning"], verifiedCount: 0 };
      const fylkeFaq = buildCityFaqJsonLd({ ...base, cityName: "Vestland", producerCount: 2, isFylke: true });
      assertEq(
        fylkeFaq?.mainEntity?.[0]?.acceptedAnswer?.text,
        "Rett fra Bonden har 2 lokale produsenter med registrert sted i Vestland.",
        "b: fylke count answer says how the count is made",
      );
      const one = buildCityFaqJsonLd({ ...base, cityName: "Vestland", producerCount: 1, isFylke: true });
      assertEq(
        one?.mainEntity?.[0]?.acceptedAnswer?.text,
        "Rett fra Bonden har 1 lokal produsent med registrert sted i Vestland.",
        "b: fylke count answer is singular for 1",
      );
      const city = buildCityFaqJsonLd({ ...base, url: `${BASE_URL}/bergen`, cityName: "Bergen", producerCount: 12 });
      assertEq(
        city?.mainEntity?.[0]?.acceptedAnswer?.text,
        "Det er 12 lokale produsenter registrert i Bergen-området.",
        "b: city count answer unchanged",
      );
      assertEq(
        JSON.stringify(buildCityFaqJsonLd({ ...base, cityName: "Bergen", producerCount: 12, isFylke: false })),
        JSON.stringify(buildCityFaqJsonLd({ ...base, cityName: "Bergen", producerCount: 12 })),
        "b: isFylke:false is byte-identical to omitting it",
      );
    }

    // ══ fixture ══════════════════════════════════════════════════════════
    function seedAgent(row: {
      id: string; name: string; city: string | null; categories?: string[]; verified?: boolean;
      address?: string; updatedAt?: string; geo?: [number, number];
    }): void {
      // The registry only exposes `city` (as location.city) on a row with
      // coordinates, so every placed fixture carries its real ones.
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
          ?, '[]', '[]', '{}', '["no"]', ?, ?, ?,
          0.5, 1, ?, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
      ).run(
        row.id, row.name, "Lokal produsent med gardsutsalg.", row.name, `${row.id}@example.no`,
        `https://${row.id}.example.no`, `key-${row.id}`, JSON.stringify(row.categories || []), row.city,
        row.geo?.[0] ?? null, row.geo?.[1] ?? null, row.verified ? 1 : 0,
      );
      testDb.prepare(
        "INSERT INTO agent_knowledge (agent_id, address, updated_at, created_at, enrichment_status) VALUES (?, ?, ?, ?, 'enriched')",
      ).run(row.id, row.address ?? null, row.updatedAt ?? "2026-08-01 10:00:00", row.updatedAt ?? "2026-08-01 10:00:00");
    }
    // The live repro: the one producer on /vestland, city "Vestland", address in Fredrikstad.
    seedAgent({ id: "aarvik", name: "Aarvik Gård — Vestland", city: "Vestland", categories: ["bakery"], address: "Th.Thomassens vei 19, 1613 FREDRIKSTAD", geo: [59.21, 10.93] });
    seedAgent({ id: "bergen-honning", name: "Berg & Sønn's Honning", city: "Bergen", categories: ["honey"], verified: true, address: "Bryggen 1, 5003 Bergen", updatedAt: "2026-09-01 10:00:00", geo: [60.39, 5.32] });
    seedAgent({ id: "voss-ysteri", name: "Voss Ysteri <Fjell>", city: "Voss", categories: ["cheese", "dairy"], updatedAt: "2026-10-02 10:00:00", geo: [60.63, 6.42] });
    seedAgent({ id: "norheimsund-gard", name: "Norheimsund Gard", city: "Norheimsund", categories: ["fruit"], geo: [60.37, 6.14] });
    seedAgent({ id: "os-gard", name: "Os Gard", city: "Os", categories: ["meat"], geo: [60.19, 5.47] });
    seedAgent({ id: "bo-gard", name: "Bø Gard", city: "Bø", categories: ["vegetables"], geo: [59.41, 9.06] });
    seedAgent({ id: "fredrikstad-gard", name: "Fredrikstad Gard", city: "Fredrikstad", categories: ["berries"], geo: [59.22, 10.93] });
    seedAgent({ id: "akershus-only", name: "Akershus Eple", city: "Akershus", categories: ["fruit"], geo: [59.66, 10.79] });
    seedAgent({ id: "oslo-bakeri", name: "Oslo Bakeri", city: "Oslo", categories: ["bakery"], geo: [59.91, 10.75] });
    seedAgent({ id: "uten-sted", name: "Uten Sted", city: null });
    // Review B1 on lokal#1109: the live producers whose city names a current
    // kommune in another fylke, with their live coordinates and addresses.
    seedAgent({ id: "gran-sondre", name: "Gran Søndre — Sande", city: "Sande", categories: ["meat"], address: "Gran 6", geo: [59.60360552016277, 10.229273400361958] });
    seedAgent({ id: "granstad", name: "Granstad Gård — Sande", city: "Sande", categories: ["vegetables"], address: "Trollsrudveien 72, Sande", geo: [59.5934, 10.2026] });
    seedAgent({ id: "flatan", name: "Flåtan Søndre Gårdsbutikk — Sande", city: "Sande", categories: ["berries"], address: "Gallebergveien 42-44, 3073 Sande i Vestfold", geo: [59.49, 10.17] });
    seedAgent({ id: "ranaas", name: "Rånås Gård", city: "Nes", categories: ["meat"], address: "Hvamsvegen 1263, 1929 Auli", geo: [60.04679965585512, 11.33372745180509] });
    seedAgent({ id: "molstad", name: "Mølstad Gård", city: "Nes", categories: ["vegetables"], address: "Mølstadveien 130, 2350 Nes på Hedmark", updatedAt: "2026-10-10 10:00:00", geo: [60.92741454507553, 10.709622024825517] });
    seedAgent({ id: "furuset", name: "Furuset Tunet — Nes", city: "Nes", categories: ["dairy"], geo: [60.56348, 9.98776] });
    seedAgent({ id: "bakke-modum", name: "Bakke Gårdsbakeri — Modum", city: "Åmot", categories: ["bakery"], address: "Nedre Bakke 29, 3340 Åmot", geo: [59.9478998491016, 9.800437734468055] });
    // A city and a coordinate that contradict each other (live: "Hamar", coordinate in Rana).
    seedAgent({ id: "matkvartalet", name: "LOKAL Matkvartalet Hamar", city: "Hamar", categories: ["bakery"], address: "Søderlundmyra 18", geo: [66.3173418944786, 14.145752939955319] });
    seedAgent({ id: "rauma", name: "Rauma Gardsmat", city: "Rauma kommune", categories: ["meat"], geo: [62.567, 7.687] });
    seedAgent({ id: "lier", name: "Lier Eple", city: "Lier kommune", categories: ["fruit"], geo: [0, 0] });
    resetRegistryCache();

    const router = seo.default as any;
    function handlerFor(routePath: string): any {
      const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === routePath && l.route.methods?.get);
      if (!layer) throw new Error(`GET ${routePath} is not registered`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
    const cityHandler = handlerFor("/:city");
    const producerHandler = handlerFor("/produsent/:slug");
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
      try { handler(req, res, () => { status = -1; }); } finally { console.log = origLog; }
      return { status, body };
    }
    const place = (slug: string, lang: "no" | "en" = "no") =>
      invoke(cityHandler, { params: { city: slug }, lang, ip: "127.0.0.1", headers: {}, get: () => undefined });
    const producer = (slug: string, lang: "no" | "en" = "no") =>
      invoke(producerHandler, { params: { slug }, lang, ip: "127.0.0.1", headers: {}, get: () => undefined });

    // ══ (c) SD-01: visible FAQ equals the FAQPage on five pages ═══════════
    const fivePages: Array<{ label: string; r: { status: number; body: string }; url: string; en: boolean }> = [
      { label: "/bergen", r: place("bergen"), url: `${BASE_URL}/bergen`, en: false },
      { label: "/vestland", r: place("vestland"), url: `${BASE_URL}/vestland`, en: false },
      { label: "/en/vestland", r: place("vestland", "en"), url: `${BASE_URL}/en/vestland`, en: true },
      { label: "/produsent/berg-sonn-s-honning", r: producer("berg-sonn-s-honning"), url: `${BASE_URL}/produsent/berg-sonn-s-honning`, en: false },
      { label: "/en/produsent/berg-sonn-s-honning", r: producer("berg-sonn-s-honning", "en"), url: `${BASE_URL}/produsent/berg-sonn-s-honning`, en: true },
    ];
    for (const p of fivePages) {
      assertEq(p.r.status, 200, `c ${p.label}: 200`);
      const faqLd = jsonLdBlocks(p.r.body).find((b) => b["@type"] === "FAQPage");
      const shown = visibleFaq(p.r.body);
      assertTrue(!!faqLd && ldPairs(faqLd).length >= 2, `c ${p.label}: FAQPage JSON-LD present`);
      assertTrue(!!shown, `c ${p.label}: visible <section id="faq"> present`);
      if (!faqLd || !shown) continue;
      assertEq(shown.pairs, ldPairs(faqLd), `c ${p.label}: visible questions and answers equal the FAQPage, in order`);
      assertEq(faqLd["@id"], `${p.url}#faq`, `c ${p.label}: FAQPage @id is this page's #faq anchor (the section id)`);
      assertEq(/\slang="nb"/.test(shown.openTag), p.en, `c ${p.label}: section lang="nb" ${p.en ? "on /en (Norwegian FAQ text)" : "absent on a Norwegian page"}`);
      assertTrue(p.r.body.includes(".faq-item {"), `c ${p.label}: FAQ CSS included`);
      assertEq((p.r.body.match(/id="faq"/g) || []).length, 1, `c ${p.label}: exactly one id="faq"`);
    }
    {
      const shown = visibleFaq(fivePages[3]!.r.body);
      assertTrue(!!shown && shown.pairs.some((x) => x.q === "Hva selger Berg & Sønn's Honning?"), "c producer: name with & and ' round-trips through the visible FAQ");
      assertTrue(fivePages[3]!.r.body.includes("Hva selger Berg &amp; Sønn&#39;s Honning?"), "c producer: visible FAQ text is HTML-escaped");
    }
    {
      // S5 on lokal#1109: a "<" in a producer name, end to end.
      const r = producer("voss-ysteri-fjell");
      assertEq(r.status, 200, "c producer <: 200");
      const shown = visibleFaq(r.body);
      const faqLd = jsonLdBlocks(r.body).find((b) => b["@type"] === "FAQPage");
      assertTrue(!!shown && shown.pairs.some((x) => x.q === "Hva selger Voss Ysteri <Fjell>?"), "c producer <: the name round-trips through the visible FAQ");
      assertEq(shown?.pairs, ldPairs(faqLd), "c producer <: visible pairs equal the FAQPage");
      const section = r.body.match(/<section id="faq"[\s\S]*?<\/section>/)?.[0] || "";
      assertTrue(section.includes("Voss Ysteri &lt;Fjell&gt;") && !section.includes("<Fjell>"), "c producer <: the visible FAQ escapes < and >");
    }
    {
      const r = producer("uten-sted");
      assertEq(r.status, 200, "c gated-out: producer without city or categories renders 200");
      assertTrue(!jsonLdBlocks(r.body).some((b) => b["@type"] === "FAQPage"), "c gated-out: no FAQPage (quality gate)");
      assertTrue(!r.body.includes('id="faq"'), "c gated-out: no visible FAQ section either");
      assertTrue(!r.body.includes(".faq-item {"), "c gated-out: no FAQ CSS");
    }

    // ══ (d) SD-02: fylke pages ═══════════════════════════════════════════
    {
      const r = fivePages[1]!.r;
      const body = r.body;
      assertEq(cardCount(body), 2, "d /vestland: 2 producer cards (Bergen + Voss)");
      assertTrue(body.includes("Berg &amp; Sønn&#39;s Honning") && body.includes("Voss Ysteri"), "d /vestland: the Bergen and Voss producers are listed");
      assertTrue(!body.includes("Aarvik"), "d /vestland: the city \"Vestland\" producer (address in Fredrikstad) is not listed — the live repro");
      assertTrue(!body.includes("Norheimsund Gard"), "d /vestland: a place neither table knows is not guessed into the fylke");
      assertTrue(!body.includes("Os Gard"), "d /vestland: Os (also a kommune in Innlandet) is not guessed into the fylke");
      assertTrue(body.includes('<h1>Lokal mat i <span translate="no">Vestland</span></h1>'), "d /vestland: H1 names the fylke");
      assertTrue(body.includes('<p>2 lokale matprodusenter i kommunene i <span translate="no">Vestland</span>.</p>'), "d /vestland: hero count equals the cards and says where it comes from");
      assertTrue(!body.includes("Vestland</span>-omr"), "d /vestland: no \"Vestland-området\"");
      assertTrue(body.includes('<meta name="description" content="Finn 2 matprodusenter i Vestland.'), "d /vestland: meta description count equals the cards");
      const blocks = jsonLdBlocks(body);
      const faq = blocks.find((b) => b["@type"] === "FAQPage");
      assertEq(
        faq?.mainEntity?.[0]?.acceptedAnswer?.text,
        "Rett fra Bonden har 2 lokale produsenter med registrert sted i Vestland.",
        "d /vestland: FAQ count is the real count",
      );
      const lbs = blocks.filter((b) => b["@type"] === "LocalBusiness");
      assertEq(lbs.length, 2, "d /vestland: 2 LocalBusiness nodes");
      const bergenLb = lbs.find((b) => b.name === "Berg & Sønn's Honning");
      assertEq(bergenLb?.address?.addressLocality, "Bergen", "d /vestland: addressLocality is the producer's own place, not the fylke");
      const bc = blocks.find((b) => b["@type"] === "BreadcrumbList");
      assertEq(bc?.itemListElement?.[1]?.name, "Vestland", "d /vestland: breadcrumb names the fylke");
      assertTrue(body.includes(`<link rel="canonical" href="${BASE_URL}/vestland">`), "d /vestland: self-canonical");
    }
    {
      const body = fivePages[2]!.r.body;
      assertTrue(body.includes('<p>2 local producers in the municipalities of <span translate="no">Vestland</span>.</p>'), "d /en/vestland: English hero count line");
      assertTrue(body.includes(`<link rel="canonical" href="${BASE_URL}/en/vestland">`), "d /en/vestland: self-canonical");
    }
    {
      const r = place("ostfold");
      assertEq(r.status, 200, "d /ostfold: 200");
      assertEq(cardCount(r.body), 1, "d /ostfold: only the Fredrikstad producer");
      assertTrue(r.body.includes("Fredrikstad Gard"), "d /ostfold: Fredrikstad producer listed");
    }
    for (const [slug, why] of [["rogaland", "no producers"], ["telemark", "Bø is not guessed into Telemark"], ["nordland", "a coordinate never places a producer by itself"], ["trondelag", "no producers"]] as const) {
      const r = place(slug);
      assertEq(r.status, 404, `d /${slug}: 404 (${why})`);
      assertTrue(r.body.includes('content="noindex, follow"'), `d /${slug}: the 404 page is noindex`);
    }
    {
      const r = place("oslo");
      assertEq(r.status, 200, "d /oslo: 200");
      assertEq(cardCount(r.body), 1, "d /oslo: city page with the Oslo producer");
      assertTrue(r.body.includes('<p>1 lokale matprodusenter i <span translate="no">Oslo</span>-området.</p>'), "d /oslo: city hero wording unchanged");
    }
    {
      const r = fivePages[0]!.r;
      assertEq(cardCount(r.body), 1, "d /bergen: city page with the Bergen producer");
      assertTrue(r.body.includes('<p>1 lokale matprodusenter i <span translate="no">Bergen</span>-området.</p>'), "d /bergen: city hero wording unchanged");
      const faq = jsonLdBlocks(r.body).find((b) => b["@type"] === "FAQPage");
      assertEq(faq?.mainEntity?.[0]?.acceptedAnswer?.text, "Det er 1 lokale produsenter registrert i Bergen-området.", "d /bergen: city FAQ wording unchanged");
    }
    for (const [slug, name] of [["bo", "Bø Gard"], ["os", "Os Gard"], ["norheimsund", "Norheimsund Gard"]] as const) {
      const r = place(slug);
      assertEq(r.status, 200, `d /${slug}: own city page still 200`);
      assertTrue(r.body.includes(name), `d /${slug}: lists ${name} as before`);
    }

    // ══ (e) review B1 on lokal#1109: names shared with another fylke ══════
    {
      const r = place("more-og-romsdal");
      assertEq(r.status, 200, "e /more-og-romsdal: 200 (the Rauma producer)");
      assertEq(cardCount(r.body), 1, "e /more-og-romsdal: 1 producer card");
      assertTrue(r.body.includes("Rauma Gardsmat"), "e /more-og-romsdal: \"Rauma kommune\" producer listed");
      for (const name of ["Gran Søndre", "Granstad Gård", "Flåtan Søndre"]) {
        assertTrue(!r.body.includes(name), `e /more-og-romsdal: ${name} (Sande i Vestfold) is not listed — the live repro`);
      }
      const blocks = jsonLdBlocks(r.body);
      assertEq(blocks.filter((b) => b["@type"] === "LocalBusiness").map((b) => b.name), ["Rauma Gardsmat"], "e /more-og-romsdal: LocalBusiness holds only the Rauma producer");
      assertEq(
        blocks.find((b) => b["@type"] === "FAQPage")?.mainEntity?.[0]?.acceptedAnswer?.text,
        "Rett fra Bonden har 1 lokal produsent med registrert sted i Møre og Romsdal.",
        "e /more-og-romsdal: FAQ count is the real count (1)",
      );
    }
    {
      const r = place("akershus");
      assertEq(r.status, 200, "e /akershus: 200 (Rånås Gård)");
      assertEq(cardCount(r.body), 1, "e /akershus: 1 producer card");
      assertTrue(r.body.includes("Rånås Gård"), "e /akershus: Rånås Gård (Auli, Nes) is listed");
      assertTrue(!r.body.includes("Mølstad Gård"), "e /akershus: Mølstad Gård (Nes på Hedmark) is not listed — the live repro");
      assertTrue(!r.body.includes("Furuset Tunet"), "e /akershus: Furuset Tunet (Nes i Ådal) is not listed — the live repro");
      assertTrue(!r.body.includes("Akershus Eple"), "e /akershus: the city \"Akershus\" producer is still not listed");
      const blocks = jsonLdBlocks(r.body);
      assertEq(blocks.filter((b) => b["@type"] === "LocalBusiness").map((b) => b.name), ["Rånås Gård"], "e /akershus: LocalBusiness holds only Rånås Gård");
      assertEq(
        blocks.find((b) => b["@type"] === "FAQPage")?.mainEntity?.[0]?.acceptedAnswer?.text,
        "Rett fra Bonden har 1 lokal produsent med registrert sted i Akershus.",
        "e /akershus: FAQ count is the real count (1)",
      );
      assertTrue(r.body.includes('<p>1 lokale matprodusenter i kommunene i <span translate="no">Akershus</span>.</p>'), "e /akershus: hero count equals the cards");
    }
    {
      const r = place("nes");
      assertEq(r.status, 200, "e /nes: own city page still 200");
      assertEq(cardCount(r.body), 3, "e /nes: lists all three Nes producers as before");
      const s = place("sande");
      assertEq(cardCount(s.body), 3, "e /sande: lists the three Sande producers as before");
    }
    {
      const r = place("innlandet");
      assertEq(r.status, 404, "e /innlandet: 404 — Åmot in Modum and the Hamar producer with a Rana coordinate are not placed there");
      assertEq(place("buskerud").status, 200, "e /buskerud: 200");
      assertTrue(place("buskerud").body.includes("Lier Eple"), "e /buskerud: \"Lier kommune\" with a 0/0 coordinate is listed by its name");
      assertTrue(!place("buskerud").body.includes("Furuset Tunet") && !place("buskerud").body.includes("Bakke Gårdsbakeri"), "e /buskerud: Nes i Ådal and Åmot in Modum are not guessed into Buskerud");
      const h = place("hamar");
      assertEq(h.status, 200, "e /hamar: own city page still 200");
      assertTrue(h.body.includes("LOKAL Matkvartalet Hamar"), "e /hamar: the producer stays on its own city page");
      assertEq(place("lier-kommune").status, 200, "e /lier-kommune: own city page slug unchanged");
    }

    // ══ (f) sitemap matches the route ════════════════════════════════════
    {
      console.log = () => {};
      let xml = "";
      try { xml = seo.buildSitemapXml(); } finally { console.log = origLog; }
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
      assertEq(locs.length, new Set(locs).size, "f: no duplicate <loc>");
      const has = (path: string) => locs.includes(`${BASE_URL}${path}`);
      for (const p of ["/vestland", "/en/vestland", "/ostfold", "/oslo", "/bergen", "/voss", "/fredrikstad", "/bo", "/os", "/norheimsund",
        "/akershus", "/more-og-romsdal", "/buskerud", "/nes", "/sande", "/amot", "/hamar", "/lier-kommune", "/rauma-kommune"]) {
        assertTrue(has(p), `f: ${p} listed`);
      }
      for (const p of ["/rogaland", "/telemark", "/nordland", "/innlandet", "/en/innlandet", "/trondelag"]) {
        assertTrue(!has(p), `f: ${p} not listed (no producers placed there)`);
      }
      const vestlandEntry = xml.match(/<url>\s*<loc>https:\/\/rettfrabonden\.com\/vestland<\/loc>[\s\S]*?<\/url>/)?.[0] || "";
      assertTrue(vestlandEntry.includes("<lastmod>2026-10-02</lastmod>"), "f: /vestland lastmod is its newest producer's (Voss, 2026-10-02)");
      const akershusEntry = xml.match(/<url>\s*<loc>https:\/\/rettfrabonden\.com\/akershus<\/loc>[\s\S]*?<\/url>/)?.[0] || "";
      assertTrue(akershusEntry.includes("<lastmod>2026-08-01</lastmod>"), "f: /akershus lastmod is Rånås Gård's, not the newer Mølstad Gård's (not placed there)");
      const nesEntry = xml.match(/<url>\s*<loc>https:\/\/rettfrabonden\.com\/nes<\/loc>[\s\S]*?<\/url>/)?.[0] || "";
      assertTrue(nesEntry.includes("<lastmod>2026-10-10</lastmod>"), "f: /nes lastmod is its newest producer's (Mølstad Gård, 2026-10-10)");
      const bergenEntry = xml.match(/<url>\s*<loc>https:\/\/rettfrabonden\.com\/bergen<\/loc>[\s\S]*?<\/url>/)?.[0] || "";
      assertTrue(bergenEntry.includes("<lastmod>2026-09-01</lastmod>"), "f: /bergen lastmod unchanged (its own producer)");

      // Invariant: every place page in the sitemap answers 200 with producers.
      const reserved = new Set(["", "om", "teknologi", "guide-mat-ai", "personvern", "kjopsvilkar", "proveniens", "kategori"]);
      const placeSlugs = locs
        .map((l) => l.slice(BASE_URL.length).replace(/^\/en(?=\/|$)/, "").replace(/^\//, ""))
        .filter((p) => !p.includes("/") && !reserved.has(p));
      assertTrue(placeSlugs.length >= 9, "f: setup — place pages found in the sitemap");
      const bad = [...new Set(placeSlugs)].filter((slug) => {
        const r = place(slug);
        return r.status !== 200 || cardCount(r.body) === 0;
      });
      assertEq(bad, [], "f: every place <loc> answers 200 with at least one producer card");
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-synlig-faq-og-fylkessider: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.log = origLog;
    if (prevDb) __setDbForTesting(prevDb);
    try { resetRegistryCache(); } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
    testDb.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── RFB synlig FAQ og fylkessider (dev-request 2026-10-17-integrasjonstest-oppfolging, I-E) ──");
  runRfbSynligFaqOgFylkessiderTests({ log: true }).then((r) => {
    console.log(`\nrfb-synlig-faq-og-fylkessider: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
