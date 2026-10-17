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
 *       fylke names and unknown places; placeSlugsForCity().
 *   (b) pure: buildCityFaqJsonLd({isFylke}) says how the fylke count is made;
 *       the city wording is unchanged.
 *   (c) SD-01 on five pages: /bergen, /vestland, /en/vestland,
 *       /produsent/<slug>, /en/produsent/<slug>: the visible FAQ pairs equal
 *       the FAQPage pairs, the section id is the FAQPage @id anchor, /en marks
 *       the Norwegian section lang="nb"; a producer whose FAQ is gated out
 *       gets no section and no FAQ CSS.
 *   (d) SD-02 regression (repro: /vestland showed 1 producer, in
 *       Fredrikstad): /vestland lists the Bergen and Voss producers only;
 *       hero, FAQ, meta description and LocalBusiness count all equal the
 *       cards; addressLocality is the producer's own place; the fylke-named
 *       Fredrikstad producer, an unknown place (Norheimsund) and the
 *       ambiguous Os are not listed; /akershus (only a city "Akershus"
 *       producer) and /rogaland (none) answer 404; /oslo, /bergen, /bo stay
 *       city pages with their old wording.
 *   (e) sitemap: fylke pages exactly when they have producers, lastmod is
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

    assertEq(placeSlugsForCity("Bergen"), ["bergen", "vestland"], "a: Bergen -> its city page and /vestland");
    assertEq(placeSlugsForCity("Oslo"), ["oslo"], "a: Oslo -> /oslo only");
    assertEq(placeSlugsForCity("Lofoten"), ["lofoten", "nordland"], "a: Lofoten -> /lofoten and /nordland");
    assertEq(placeSlugsForCity("Vestland"), [], "a: city \"Vestland\" -> no place page (no city page named after a fylke)");
    assertEq(placeSlugsForCity("Akershus"), [], "a: city \"Akershus\" -> no place page");
    assertEq(placeSlugsForCity("Bø"), ["bo"], "a: Bø -> its city page only");
    assertEq(placeSlugsForCity("Hordaland"), ["hordaland"], "a: Hordaland -> its city page as before");
    assertEq(placeSlugsForCity("Kristiansand S"), ["kristiansand-s"], "a: unknown place -> its city page as before");
    assertEq(placeSlugsForCity(""), [], "a: empty city -> nothing");

    // ══ (b) buildCityFaqJsonLd wording ═══════════════════════════════════
    {
      const base = { url: `${BASE_URL}/vestland`, topCategories: ["honning"], verifiedCount: 0 };
      const fylkeFaq = buildCityFaqJsonLd({ ...base, cityName: "Vestland", producerCount: 2, isFylke: true });
      assertEq(
        fylkeFaq?.mainEntity?.[0]?.acceptedAnswer?.text,
        "Rett fra Bonden har 2 lokale produsenter med registrert kommune i Vestland.",
        "b: fylke count answer says how the count is made",
      );
      const one = buildCityFaqJsonLd({ ...base, cityName: "Vestland", producerCount: 1, isFylke: true });
      assertEq(
        one?.mainEntity?.[0]?.acceptedAnswer?.text,
        "Rett fra Bonden har 1 lokal produsent med registrert kommune i Vestland.",
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
    seedAgent({ id: "voss-ysteri", name: "Voss Ysteri", city: "Voss", categories: ["cheese", "dairy"], updatedAt: "2026-10-02 10:00:00", geo: [60.63, 6.42] });
    seedAgent({ id: "norheimsund-gard", name: "Norheimsund Gard", city: "Norheimsund", categories: ["fruit"], geo: [60.37, 6.14] });
    seedAgent({ id: "os-gard", name: "Os Gard", city: "Os", categories: ["meat"], geo: [60.19, 5.47] });
    seedAgent({ id: "bo-gard", name: "Bø Gard", city: "Bø", categories: ["vegetables"], geo: [59.41, 9.06] });
    seedAgent({ id: "fredrikstad-gard", name: "Fredrikstad Gard", city: "Fredrikstad", categories: ["berries"], geo: [59.22, 10.93] });
    seedAgent({ id: "akershus-only", name: "Akershus Eple", city: "Akershus", categories: ["fruit"], geo: [59.66, 10.79] });
    seedAgent({ id: "oslo-bakeri", name: "Oslo Bakeri", city: "Oslo", categories: ["bakery"], geo: [59.91, 10.75] });
    seedAgent({ id: "uten-sted", name: "Uten Sted", city: null });
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
        "Rett fra Bonden har 2 lokale produsenter med registrert kommune i Vestland.",
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
    for (const [slug, why] of [["akershus", "only a producer whose city is the fylke name"], ["rogaland", "no producers"], ["telemark", "Bø is not guessed into Telemark"]] as const) {
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

    // ══ (e) sitemap matches the route ════════════════════════════════════
    {
      console.log = () => {};
      let xml = "";
      try { xml = seo.buildSitemapXml(); } finally { console.log = origLog; }
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
      assertEq(locs.length, new Set(locs).size, "e: no duplicate <loc>");
      const has = (path: string) => locs.includes(`${BASE_URL}${path}`);
      for (const p of ["/vestland", "/en/vestland", "/ostfold", "/oslo", "/bergen", "/voss", "/fredrikstad", "/bo", "/os", "/norheimsund"]) {
        assertTrue(has(p), `e: ${p} listed`);
      }
      for (const p of ["/akershus", "/en/akershus", "/rogaland", "/telemark", "/nordland"]) {
        assertTrue(!has(p), `e: ${p} not listed (no producers placed there)`);
      }
      const vestlandEntry = xml.match(/<url>\s*<loc>https:\/\/rettfrabonden\.com\/vestland<\/loc>[\s\S]*?<\/url>/)?.[0] || "";
      assertTrue(vestlandEntry.includes("<lastmod>2026-10-02</lastmod>"), "e: /vestland lastmod is its newest producer's (Voss, 2026-10-02)");
      const bergenEntry = xml.match(/<url>\s*<loc>https:\/\/rettfrabonden\.com\/bergen<\/loc>[\s\S]*?<\/url>/)?.[0] || "";
      assertTrue(bergenEntry.includes("<lastmod>2026-09-01</lastmod>"), "e: /bergen lastmod unchanged (its own producer)");

      // Invariant: every place page in the sitemap answers 200 with producers.
      const reserved = new Set(["", "om", "teknologi", "guide-mat-ai", "personvern", "kjopsvilkar", "proveniens", "kategori"]);
      const placeSlugs = locs
        .map((l) => l.slice(BASE_URL.length).replace(/^\/en(?=\/|$)/, "").replace(/^\//, ""))
        .filter((p) => !p.includes("/") && !reserved.has(p));
      assertTrue(placeSlugs.length >= 9, "e: setup — place pages found in the sitemap");
      const bad = [...new Set(placeSlugs)].filter((slug) => {
        const r = place(slug);
        return r.status !== 200 || cardCount(r.body) === 0;
      });
      assertEq(bad, [], "e: every place <loc> answers 200 with at least one producer card");
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
