/**
 * dental-landing.test.ts -- A2A dev-request 2026-10-16-finn-tannlege-fasettsider,
 * skive F1-S4a (fasett-landingssider /sted/<sted>/<fasett> og
 * /fylke/<fylke>/<fasett>, med felles gate og sitemap-paritet).
 *
 *   A  the aggregate's facet counts: for every stored poststed and fylke and
 *      every facet, the count and the newest date equal what the page's own
 *      store filter lists (countPublicDentalAgents); sourced vakt in SQL =
 *      resolveAcuteClaim(row) === "vakt" in JS, on vakt / accepts / null rows
 *      and malformed JSON; rejected, closed, non-clinic and probe rows are in
 *      no facet; two spellings of one place add up.
 *   B  /sted/oslo/kjeveortopedi: 200, indexable, H1 «Kjeveortoped i Oslo»,
 *      title, canonical, breadcrumb Hjem → Oslo → Kjeveortoped i Oslo,
 *      ItemList = the rendered cards, intro (40-60 words) / table / FAQ that
 *      say what the clinics have and leave out the count the facet is named
 *      for; visible FAQ = FAQPage.
 *   C  tannlegevakt: only clinics whose card shows «Akuttvakt» (sourced);
 *      acute_vakt = 1 without provenance and «Tar imot akuttpasienter» are
 *      never on it; the akutt FAQ answer names 116 117 and 113; /fylke and a
 *      place with two spellings; the URL is read in any case, the canonical
 *      is the one spelling.
 *   D  the gate (facets.minListings 3, facets.minFacts 2): a thin facet, a
 *      facet with one fact, the disabled Helfo facet (unsourced Helfo rows),
 *      an unknown facet, place or fylke are 404 with noindex; 3 clinics with
 *      2 facts is 200.
 *   E  the sitemap: exactly the facet pages over the gate that are their own
 *      canonical, once each, lastmod the newest clinic in the facet; parity:
 *      every facet URL in it answers 200 as its own canonical, and every
 *      other place × facet combination is a 404 or a fylke page whose
 *      canonical is a /sted facet URL in it (section O).
 *   F  links from /sted and /fylke to the place's facet pages (and only
 *      those), each answering 200.
 *   G  paging: page 2 has its own canonical, ItemList positions from 51, no
 *      intro, table or FAQ; a ?side= past the end is page 1.
 *   H  escaping of a place name with markup.
 *   I  a cache behind the data: the page states no number until it catches
 *      up, nor does its meta description; a facet whose clinics all closed
 *      is 404.
 *   J  the two facet routes are registered before the catch-all, and no
 *      other route matches a facet URL.
 *   K  the facet pages' text never says FINN or «Finn» alone (decision 4=A).
 *   L  recordAiPageDelivery: an AI search fetch counts the page's clinics.
 *   M  llms.txt names the URL patterns and the facets that are on.
 *   N  the emergency notice (DENTAL_EMERGENCY_NOTICE): one marked box with
 *      the config's text and tel: links for 113 and 116 117, above the list
 *      on every tannlegevakt page of /sted and /fylke, on page 2 and while
 *      the cache is behind; on no other facet page and no /sted or /fylke
 *      page. Its full text is pinned on each of them, ending with the
 *      caveat of /vilkar pkt. 3 as /vilkar itself words it (call the clinic
 *      before you go).
 *   O  a fylke facet page with exactly the clinics of one /sted facet page
 *      (one spelling, two spellings, two pages) has that page as canonical
 *      and is not in the sitemap; one with a clinic in another poststed, in
 *      no poststed (also when the /sted page makes up the count with a
 *      clinic in another fylke), or whose /sted page has a clinic in another
 *      fylke is its own canonical and in it; the decision follows the cached
 *      aggregate.
 *   P  the sitemap runs no statement per place or facet: as many with 5
 *      more facet URLs (counted on Statement.prototype, as in
 *      dental-area-landing.test.ts F4d).
 *
 * Same harness as dental-area-landing.test.ts (in-memory dental DB, the
 * router driven through router.handle()).
 *
 * Standalone: npx tsx src/routes/dental-landing.test.ts
 * Wired into tests/test.ts via runDentalLandingTests().
 */

import Database from "better-sqlite3";
import { EventEmitter } from "events";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  text: string;
}

function callRoute(router: any, url: string): Promise<RouteResult> {
  const parsed = new URL(url, "http://finn-tannlege.test");
  const query: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => { query[k] = v; });
  return new Promise((resolve) => {
    const req: any = {
      method: "GET", url, originalUrl: url, path: parsed.pathname,
      params: {}, query, headers: {}, ip: "203.0.113.7", get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      send(payload: any) { resolve({ status: this.statusCode, text: String(payload ?? "") }); return this; },
      json(payload: any) { resolve({ status: this.statusCode, text: JSON.stringify(payload) }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, text: err ? String(err) : "unhandled" }));
  });
}

const robotsOf = (html: string): string => (html.match(/<meta name="robots" content="([^"]*)">/) || [])[1] ?? "";
const canonicalOf = (html: string): string => (html.match(/<link rel="canonical" href="([^"]*)">/) || [])[1] ?? "";
const titleOf = (html: string): string => (html.match(/<title>([^<]*)<\/title>/) || [])[1] ?? "";
const descriptionOf = (html: string): string => (html.match(/<meta name="description" content="([^"]*)">/) || [])[1] ?? "";
/** The description, og:description and twitter:description, decoded. */
const metaDescriptions = (html: string): string[] =>
  Array.from(html.matchAll(/<meta (?:name|property)="(?:description|og:description|twitter:description)" content="([^"]*)">/g), (m) => decode(m[1]!));
/** The emergency notice boxes (DENTAL_EMERGENCY_NOTICE) on a page. */
const noticesOf = (html: string): string[] => Array.from(html.matchAll(/<aside class="akutt-banner emergency-notice"[^>]*>([\s\S]*?)<\/aside>/g), (m) => m[1]!);
const textOf = (html: string): string => decode(html.replace(/<[^>]*>/g, ""));
const h1Of = (html: string): string => (html.match(/<h1 class="profile-name">([^<]*)<\/h1>/) || [])[1] ?? "";
const mainOf = (html: string): string => html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
const jsonLdBlocks = (html: string): any[] =>
  Array.from(html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs), (m) => JSON.parse(m[1]!));
const ofType = (html: string, type: string): any[] => jsonLdBlocks(html).filter((b) => b["@type"] === type);
const introOf = (html: string): string => (html.match(/<p class="landing-intro"[^>]*>([^<]*)<\/p>/) || [])[1] ?? "";
const tableRows = (html: string): Array<[string, string]> =>
  Array.from(html.matchAll(/<tr><th scope="row"[^>]*>([^<]*)<\/th><td[^>]*>([^<]*)<\/td><\/tr>/g), (m) => [m[1]!, m[2]!]);
const captionOf = (html: string): string => (html.match(/<caption[^>]*>([^<]*)<\/caption>/) || [])[1] ?? "";
const faqQuestions = (html: string): string[] => Array.from(html.matchAll(/<h3 style="font-size:1rem;margin-bottom:4px">([^<]*)<\/h3>/g), (m) => m[1]!);
const cards = (html: string): string[] => Array.from(html.matchAll(/<article class="clinic-card">([\s\S]*?)<\/article>/g), (m) => m[1]!);
const cardNames = (html: string): string[] => cards(html).map((c) => (c.match(/<div class="clinic-name"><a [^>]*>([^<]*)<\/a>/) || [])[1] ?? "");
const facetLinks = (html: string): string[] =>
  Array.from((html.match(/<div class="landing-facet-links"[\s\S]*?<\/div>\n<\/div>/) || [""])[0]!.matchAll(/<a href="([^"]*)" class="spec-chip">([^<]*) <span[^>]*>\((\d+)\)<\/span><\/a>/g), (m) => `${m[1]} ${m[2]} (${m[3]})`);
const words = (s: string): number => (s.trim() === "" ? 0 : s.trim().split(/\s+/).length);
const decode = (s: string): string => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const locs = (xml: string): string[] => Array.from(xml.matchAll(/<loc>([^<]*)<\/loc>/g), (m) => m[1]!);
const lastmodOf = (xml: string, loc: string): string | null => {
  const m = xml.match(new RegExp(`<url><loc>${loc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc>(?:<lastmod>([^<]*)</lastmod>)?`));
  return m ? m[1] ?? null : null;
};

export async function runDentalLandingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  const prevLog = console.log;

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-area-facts"),
    require.resolve("./dental-landing"),
    require.resolve("./dental-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    if (!log) console.log = () => { /* silence schema chatter */ };
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    console.log = prevLog;
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const areaFacts = require("../services/dental-area-facts") as typeof import("../services/dental-area-facts");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const { DENTAL_LANDING_FACETS, DENTAL_LANDING_CONFIG, DENTAL_EMERGENCY_NOTICE } = require("../config/dental-landing") as typeof import("../config/dental-landing");
    const { resolveAcuteClaim, DENTAL_ACUTE_VAKT_SQL } = require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");
    const { __resetDentalSearchGazetteerForTesting } = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");
    const router = dentalSeo.default as any;
    const base = process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";
    const resetCaches = (): void => {
      __resetDentalSearchGazetteerForTesting();
      areaFacts.__resetDentalAreaFactsForTesting();
      dentalSeo.__resetDentalSitemapCacheForTesting();
    };
    resetCaches();

    // ── fixture ──────────────────────────────────────────────────────────
    let orgSeq = 928880000;
    interface Extra {
      id?: string; updatedAt?: string; rejected?: boolean; inactive?: boolean; klass?: string; verified?: boolean;
      helfo?: boolean; acuteVakt?: 0 | 1; provenance?: string | null; focus?: string | null;
      specialists?: string | null; specialties?: string | null;
    }
    const mk = (navn: string, poststed: string, fylke: string, x: Extra = {}): string => {
      const org_nr = String(++orgSeq);
      const id = store.createDentalAgent({ ...(x.id ? { id: x.id } : {}), navn, org_nr, poststed, fylke, adresse: "Storgata 1", telefon: "22110099" } as any);
      db.prepare(
        "UPDATE dental_agents SET catalog_class = ?, is_inactive = ?, verification_status = ?, helfo_agreement = ?, acute_vakt = ?," +
        " field_provenance = ?, patient_focus = ?, specialists = ?, available_specialties = ?," +
        " updated_at = COALESCE(?, updated_at) WHERE id = ?"
      ).run(
        x.klass ?? "klinikk", x.inactive ? 1 : 0,
        x.rejected ? "rejected" : x.verified ? "verified" : "unverified",
        x.helfo ? "true" : "unknown", x.acuteVakt ?? 0,
        x.provenance ?? null, x.focus ?? null, x.specialists ?? null, x.specialties ?? null, x.updatedAt ?? null, id
      );
      return id;
    };
    const PROV = '{"acute_vakt":[{"source":"https://example.test/akutt"}]}';
    const KJEVE_TITLE = '[{"navn":"Kari","title":"Kjeveortoped"}]';

    // BERGEN (Vestland): 4 clinics with sourced vakt (one Helfo, one verified).
    for (let i = 1; i <= 4; i++) mk(`Bergen Vakt ${i} AS`, "BERGEN", "Vestland", { acuteVakt: 1, provenance: PROV, helfo: i === 1, verified: i === 2, updatedAt: `2026-05-0${i} 10:00:00` });
    // Never on a tannlegevakt page: the flag without provenance, and «Tar imot akuttpasienter».
    mk("Bergen Uten Kilde AS", "BERGEN", "Vestland", { acuteVakt: 1, helfo: true, updatedAt: "2026-09-09 10:00:00" });
    mk("Bergen Tar Imot AS", "BERGEN", "Vestland", { focus: '["Akutt"]', updatedAt: "2026-09-10 10:00:00" });
    // Helfo = 'true' with no source on 5 more: the Helfo facet is off, so no page.
    for (let i = 1; i <= 5; i++) mk(`Bergen Helfo ${i} AS`, "BERGEN", "Vestland", { helfo: true });
    // One kjeveortoped: under minListings.
    mk("Bergen Kjeve AS", "BERGEN", "Vestland", { specialists: KJEVE_TITLE });
    // In no facet and no number: rejected, closed, a non-clinic, the probe row.
    mk("Avvist Vakt AS", "BERGEN", "Vestland", { rejected: true, acuteVakt: 1, provenance: PROV, specialists: KJEVE_TITLE });
    mk("Nedlagt Vakt AS", "BERGEN", "Vestland", { inactive: true, acuteVakt: 1, provenance: PROV, specialists: KJEVE_TITLE });
    mk("Bergen Enk", "BERGEN", "Vestland", { klass: "person_enk", acuteVakt: 1, provenance: PROV, specialists: KJEVE_TITLE });
    mk("Probe Vakt AS", "BERGEN", "Vestland", { id: "persistence-probe-pr100b", acuteVakt: 1, provenance: PROV, specialists: KJEVE_TITLE });

    // OSLO (Oslo): kjeveortopedi 5 (every way the filter reads a specialty), 2 Helfo, 1 akutt.
    mk("Oslo Kjeve 1 AS", "OSLO", "Oslo", { specialties: '["kjeveortopedi"]', helfo: true, updatedAt: "2026-08-01 10:00:00" });
    mk("Oslo Kjeve 2 AS", "OSLO", "Oslo", { specialists: '[{"navn":"Per","specialty":"kjeveortopedi"}]', helfo: true, updatedAt: "2026-08-02 10:00:00" });
    mk("Oslo Kjeve 3 AS", "OSLO", "Oslo", { specialists: KJEVE_TITLE, focus: '["Akutt"]', updatedAt: "2026-08-03 10:00:00" });
    mk("Oslo Kjeve 4 AS", "OSLO", "Oslo", { specialists: '[{"navn":"Siv","title":"Spesialist i kjeveortopedi"}]', updatedAt: "2026-08-04 10:00:00" });
    mk("Oslo Kjeve 5 AS", "OSLO", "Oslo", { specialties: '["Kjeveortopedi"]', updatedAt: "2026-08-20 10:00:00" });
    // periodonti 3 with one Helfo: exactly at the gate (3 clinics, 2 facts).
    for (let i = 1; i <= 3; i++) mk(`Oslo Perio ${i} AS`, "OSLO", "Oslo", { specialists: '[{"title":"Periodontist"}]', helfo: i === 1, updatedAt: "2026-07-01 10:00:00" });
    // endodonti 3 with no other fact: one fact (its own) < minFacts.
    for (let i = 1; i <= 3; i++) mk(`Oslo Endo ${i} AS`, "OSLO", "Oslo", { specialties: '["endodonti"]', updatedAt: "2026-07-02 10:00:00" });
    // pedodonti 2 with Helfo and akutt: two clinics < minListings.
    for (let i = 1; i <= 2; i++) mk(`Oslo Pedo ${i} AS`, "OSLO", "Oslo", { specialties: '["pedodonti"]', helfo: true, focus: '["Akutt"]', updatedAt: "2026-07-03 10:00:00" });
    // Not kjeveortopedi clinics: rejected, closed, a lab.
    mk("Oslo Avvist Kjeve AS", "OSLO", "Oslo", { rejected: true, specialties: '["kjeveortopedi"]', helfo: true });
    mk("Oslo Nedlagt Kjeve AS", "OSLO", "Oslo", { inactive: true, specialties: '["kjeveortopedi"]', helfo: true });
    mk("Oslo Lab Kjeve AS", "OSLO", "Oslo", { klass: "lab_leverandor", specialties: '["kjeveortopedi"]', helfo: true });
    // The newest Oslo clinic is in no facet: /sted/oslo's lastmod, not the facets'.
    mk("Oslo Vanlig AS", "OSLO", "Oslo", { updatedAt: "2026-09-30 10:00:00" });

    // MOLDE in two spellings: 2 + 1 sourced vakt, one Helfo.
    mk("Molde Vakt 1 AS", "MOLDE", "Møre og Romsdal", { acuteVakt: 1, provenance: PROV, helfo: true, updatedAt: "2026-06-01 10:00:00" });
    mk("Molde Vakt 2 AS", "MOLDE", "Møre og Romsdal", { acuteVakt: 1, provenance: PROV, updatedAt: "2026-06-02 10:00:00" });
    mk("Molde Vakt 3 AS", "Molde", "Møre og Romsdal", { acuteVakt: 1, provenance: '{"acute_vakt":{"sources":["https://example.test/x"]}}', updatedAt: "2026-06-03 10:00:00" });

    // A place name with markup: 3 kjeveortopedi, one Helfo.
    const evilPlace = 'Ås<i>"&Co';
    for (let i = 1; i <= 3; i++) mk(`Markup Kjeve ${i} AS`, evilPlace, "Telemark", { specialties: '["kjeveortopedi"]', helfo: i === 1, updatedAt: "2026-07-07 10:00:00" });

    // PAGED (Rogaland): 55 kjeveortopedi over two pages, 3 Helfo.
    for (let i = 1; i <= 55; i++) mk(`Paged Kjeve ${String(i).padStart(2, "0")} AS`, "PAGED", "Rogaland", { specialties: '["kjeveortopedi"]', helfo: i <= 3, updatedAt: "2026-06-15 10:00:00" });

    // TYNN (Agder): two plain clinics, no facet.
    for (let i = 1; i <= 2; i++) mk(`Tynn Tann ${i} AS`, "TYNN", "Agder", {});

    // PARITET (Nordland): every shape the akutt claim distinguishes.
    const edge: Array<[string, Extra]> = [
      ["a", { acuteVakt: 1, provenance: '{"acute_vakt":{"sources":["x"]}}' }],
      ["b", { acuteVakt: 1, provenance: '{"acute_vakt":[]}' }],
      ["c", { acuteVakt: 1, provenance: '{bad json' }],
      ["d", { focus: '["AKUTT hjelp"]' }],
      ["e", { acuteVakt: 1, provenance: '{"acute_vakt":"x"}' }],
      ["f", { acuteVakt: 0, provenance: PROV }],
      ["g", { acuteVakt: 1, provenance: '{"acute_vakt":{"sources":[]}}', focus: '["Akutt"]' }],
      ["h", { acuteVakt: 1, provenance: PROV, focus: "ikke json" }],
      ["i", { acuteVakt: 1, provenance: '{"other":[1]}' }],
      ["j", {}],
    ];
    for (const [k, x] of edge) mk(`Paritet ${k} AS`, "PARITET", "Nordland", x);

    // Fylke facet pages that list more than any one /sted facet page (S3):
    // ASKØY puts a fifth sourced vakt in Vestland besides Bergen's 4; a
    // kjeveortopedi clinic in Telemark has no poststed at all.
    mk("Askøy Vakt AS", "ASKØY", "Vestland", { acuteVakt: 1, provenance: PROV, updatedAt: "2026-04-01 10:00:00" });
    const noPoststed = mk("Uten Poststed Kjeve AS", "UTEN", "Telemark", { specialties: '["kjeveortopedi"]', updatedAt: "2026-07-01 10:00:00" });
    db.prepare("UPDATE dental_agents SET poststed = NULL WHERE id = ?").run(noPoststed);
    // ... and evilPlace has a fourth in Vestfold: 4 in /sted's facet and 4 in
    // Telemark's, but not the same 4. Only the check that every clinic of the
    // fylke's facet has a listed poststed tells them apart (E1, E9, O3).
    mk("Markup Kjeve Vestfold AS", evilPlace, "Vestfold", { specialties: '["kjeveortopedi"]', updatedAt: "2026-07-02 10:00:00" });
    // GRENSE: 54 sourced vakt in Innlandet (one Helfo) and 1 in Trøndelag, so
    // /sted/grense/tannlegevakt (55) lists more than /fylke/Innlandet/… (54),
    // and both have a page 2.
    for (let i = 1; i <= 54; i++) mk(`Grense Vakt ${String(i).padStart(2, "0")} AS`, "GRENSE", "Innlandet", { acuteVakt: 1, provenance: PROV, helfo: i === 1, updatedAt: "2026-03-10 10:00:00" });
    mk("Grense Trøndelag Vakt AS", "GRENSE", "Trøndelag", { acuteVakt: 1, provenance: PROV, updatedAt: "2026-03-11 10:00:00" });

    const facetBySlug = (slug: string) => DENTAL_LANDING_FACETS.find((f) => f.slug === slug)!;
    const dayOf = (v: string | null | undefined): string | null => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

    // ── A. the aggregate's facet counts ──────────────────────────────────
    {
      const f = areaFacts.getDentalAreaFacts();
      const mismatches: string[] = [];
      let checked = 0;
      for (const [label, map, filterOf] of [
        ["poststed", f.byPoststed, (k: string) => ({ poststed_in: [k] })],
        ["fylke", f.byFylke, (k: string) => ({ fylke_in: [k] })],
      ] as const) {
        for (const [key, counts] of map) {
          for (const facet of DENTAL_LANDING_FACETS) {
            const listed = store.listPublicDentalAgents({ ...filterOf(key), ...facet.filter }, 500, 0);
            const got = counts.facets?.[facet.slug];
            const newest = listed.map((a: any) => dayOf(a.updated_at)).filter(Boolean).sort().pop() ?? null;
            checked++;
            if ((got?.total ?? 0) !== listed.length || (got ? dayOf(got.max_updated_at) : null) !== (listed.length ? newest : null)) {
              mismatches.push(`${label} ${key} ${facet.slug}: aggregate ${got?.total ?? 0}/${got?.max_updated_at ?? "-"} store ${listed.length}/${newest}`);
            }
          }
        }
      }
      assertEq(mismatches, [], `A1: for every stored poststed and fylke and every facet (${checked} cells), the aggregate's count and newest date = what the page's store filter lists`);
      assertEq(f.byPoststed.get("BERGEN")!.facets?.tannlegevakt?.total, 4, "A2: BERGEN tannlegevakt = the 4 with sourced vakt (no flag without provenance, no «Tar imot», no rejected/closed/non-clinic/probe row)");
      assertEq(f.byPoststed.get("OSLO")!.facets?.kjeveortopedi?.total, 5, "A3: OSLO kjeveortopedi = 5 (available_specialties in either case, specialists[].specialty, two titles); the rejected, closed and lab rows are not counted");
      assertEq(f.byPoststed.get("BERGEN")!.facets?.helfo?.total, 7, "A4: the aggregate counts the Helfo facet too (7 rows say Helfo = 'true'), though the facet is off");
      const oslo = f.byPoststed.get("OSLO")!.facets!.kjeveortopedi!;
      assertEq([oslo.helfo_true, oslo.acute_sourced, oslo.verified, oslo.max_updated_at], [2, 1, 0, "2026-08-20 10:00:00"], "A5: a facet carries its own facts and newest date (not the place's 2026-09-30)");
      const molde = areaFacts.sumAreaCounts([f.byPoststed.get("MOLDE"), f.byPoststed.get("Molde")]);
      assertEq([molde.facets?.tannlegevakt?.total, molde.facets?.tannlegevakt?.helfo_true, molde.facets?.tannlegevakt?.max_updated_at], [3, 1, "2026-06-03 10:00:00"], "A6: sumAreaCounts adds the facets of two spellings (2 + 1, newest of both)");
      assertTrue(![...f.byPoststed.values(), ...f.byFylke.values()].some((c) => Object.values(c.facets ?? {}).some((fc) => fc.facets !== undefined)), "A7: facet counts have no facets of their own");

      // The vakt rule: SQL = resolveAcuteClaim(row) === "vakt", over every row, public or not.
      const all = (db.prepare("SELECT * FROM dental_agents").all() as any[]).map((r) => store.getDentalAgentById(r.id)!).filter(Boolean);
      const sqlVakt = new Set((db.prepare(`SELECT id FROM dental_agents WHERE ${DENTAL_ACUTE_VAKT_SQL}`).all() as Array<{ id: string }>).map((r) => r.id));
      const vaktMismatch = all.filter((a) => (resolveAcuteClaim(a) === "vakt") !== sqlVakt.has(a.id!)).map((a) => `${a.navn}: js ${resolveAcuteClaim(a)} sql ${sqlVakt.has(a.id!)}`);
      assertEq(vaktMismatch, [], `A8: DENTAL_ACUTE_VAKT_SQL picks exactly the rows resolveAcuteClaim calls "vakt" (${all.length} rows, ${sqlVakt.size} vakt)`);
      const byName = (navn: string) => all.find((a) => a.navn === navn)!;
      assertEq(
        ["Bergen Vakt 1 AS", "Bergen Tar Imot AS", "Bergen Uten Kilde AS", "Paritet g AS", "Paritet h AS", "Paritet c AS"].map((n) => [resolveAcuteClaim(byName(n)), sqlVakt.has(byName(n).id!)]),
        [["vakt", true], ["accepts", false], [null, false], ["accepts", false], ["vakt", true], [null, false]],
        "A9: vakt with a source is vakt; «Tar imot akuttpasienter» (accepts) and the flag without a source (null) are not; malformed JSON is no vakt"
      );
      assertEq(f.byPoststed.get("PARITET")!.facets?.tannlegevakt?.total, 2, "A10: PARITET: a (sources) and h (provenance array, focus not JSON) are vakt; b, c, e, f, g, i, j are not");
      const ids = (rows: Array<{ id?: string }>): string[] => rows.map((a) => a.id!).sort();
      const publicRows = store.listPublicDentalAgents({}, 500, 0);
      assertEq(ids(store.listPublicDentalAgents({ acute_claim: "vakt" }, 500, 0)), ids(publicRows.filter((a) => resolveAcuteClaim(a) === "vakt")), "A11: the public acute_claim «vakt» filter lists exactly the public rows resolveAcuteClaim calls vakt");
      assertEq(store.countPublicDentalAgents({ acute_claim: "vakt" }), publicRows.filter((a) => resolveAcuteClaim(a) === "vakt").length, "A11b: and counts them");
      assertEq(store.countPublicDentalAgents({ acute_vakt: 1, poststed: "BERGEN" }), 5, "A12: the akutt filter acute_vakt 1 keeps its meaning (vakt or «Tar imot»: 4 + 1)");
    }

    // ── B. /sted/oslo/kjeveortopedi ──────────────────────────────────────
    {
      const page = await callRoute(router, "/sted/oslo/kjeveortopedi");
      assertEq(page.status, 200, "B1: GET /sted/oslo/kjeveortopedi -> 200");
      assertTrue(/^index, follow/.test(robotsOf(page.text)), "B2: indexable");
      assertEq(canonicalOf(page.text), `${base}/sted/oslo/kjeveortopedi`, "B3: canonical = the facet URL");
      assertEq(h1Of(page.text), "Kjeveortoped i Oslo", "B4: H1 «Kjeveortoped i Oslo» (the specialist's title)");
      assertEq(titleOf(page.text), "Kjeveortoped i Oslo: tannlegeklinikker med kjeveortopedi — Finn-tannlege.com", "B5: <title> from the facet's template");
      assertEq(decode(descriptionOf(page.text)), "Vi har 5 tannlegeklinikker med kjeveortopedi og poststed Oslo i oversikten. Kjeveortopedi er oppført som spesialitet hos hver av dem.", "B6: the description says what the page lists");
      assertEq(cardNames(page.text).sort(), ["Oslo Kjeve 1 AS", "Oslo Kjeve 2 AS", "Oslo Kjeve 3 AS", "Oslo Kjeve 4 AS", "Oslo Kjeve 5 AS"], "B7: the cards are the 5 kjeveortopedi clinics (none rejected, closed or a lab)");
      const itemList = ofType(page.text, "ItemList")[0];
      assertEq([itemList?.name, itemList?.numberOfItems, itemList?.itemListElement?.map((e: any) => e.position)], ["Kjeveortoped i Oslo", 5, [1, 2, 3, 4, 5]], "B8: ItemList = the rendered cards");
      const crumbs = ofType(page.text, "BreadcrumbList")[0]?.itemListElement ?? [];
      assertEq(crumbs.map((c: any) => [c.position, c.name, c.item]), [[1, "Hjem", base], [2, "Oslo", `${base}/sted/oslo`], [3, "Kjeveortoped i Oslo", `${base}/sted/oslo/kjeveortopedi`]], "B9: breadcrumb Hjem → Oslo → Kjeveortoped i Oslo");
      const intro = introOf(page.text);
      assertTrue(intro.startsWith("Vi har 5 tannlegeklinikker med kjeveortopedi og poststed Oslo i oversikten. Kjeveortopedi er oppført som spesialitet hos hver av dem."), `B10: the intro says what the clinics have and where («${intro.slice(0, 90)}»)`);
      assertTrue(words(intro) >= 40 && words(intro) <= 60, `B11: 40-60 words (${words(intro)})`);
      assertTrue(intro.includes("2 av dem oppgir Helfo-direkteoppgjør ifølge klinikkenes nettsider.") && intro.includes("1 oppgir akuttvakt med kilde eller at den tar imot akuttpasienter."), "B12: Helfo and akutt among them, worded as on /sted");
      assertTrue(!/minst én oppført spesialitet/.test(intro), "B13: the count the facet is named for is not stated again («minst én oppført spesialitet»)");
      assertEq(captionOf(page.text), "Fakta om tannlegeklinikker med kjeveortopedi og poststed Oslo", "B14: the table caption says what it counts");
      assertEq(tableRows(page.text), [
        ["Klinikker totalt", "5"],
        ["Oppgir Helfo-direkteoppgjør (ifølge klinikkenes nettsider)", "2"],
        ["Akuttvakt med kilde eller tar imot akuttpasienter", "1"],
        ["Sist oppdatert", "20. august 2026"],
      ], "B15: the table: total, Helfo, akutt and «Sist oppdatert» from the facet's newest clinic; no specialty row, no Verifisert at 0");
      const faq = ofType(page.text, "FAQPage");
      assertEq(faq.length, 1, "B16: one FAQPage");
      const qa: Array<{ name: string; acceptedAnswer: { text: string } }> = faq[0]?.mainEntity ?? [];
      assertEq([qa[0]?.name, qa[0]?.acceptedAnswer.text], ["Hvor mange tannlegeklinikker med kjeveortopedi har poststed Oslo?", "Vi har 5 tannlegeklinikker med kjeveortopedi og poststed Oslo registrert. Kjeveortopedi er oppført som spesialitet hos hver av dem."], "B17: the first Q/A counts the facet in the place");
      assertEq(faqQuestions(page.text).map(decode), qa.map((e) => e.name), "B18: the visible questions = the FAQPage questions");
      assertTrue(qa.length >= 2 && qa.every((e) => /\d/.test(e.acceptedAnswer.text)) && !qa.some((e) => /oppført spesialitet\?/.test(e.name)), "B19: every answer has a number, and there is no «har en oppført spesialitet?» question on a specialty page");
      assertTrue(page.text.includes(`<a href="/sted/oslo" style="color:rgba(255,255,255,.7)">&larr; Tannlege i Oslo</a>`) && page.text.includes(`<a href="/sted/oslo">&larr; Alle tannleger i Oslo</a>`), "B20: the page links back to /sted/oslo");
      assertTrue(page.text.includes("5 klinikker registrert"), "B21: the header count");

      const fylke = await callRoute(router, "/fylke/Oslo/kjeveortopedi");
      assertEq([fylke.status, h1Of(fylke.text), canonicalOf(fylke.text)], [200, "Kjeveortoped i Oslo", `${base}/sted/oslo/kjeveortopedi`], "B22: /fylke/Oslo/kjeveortopedi -> 200, same H1; it lists the same 5 clinics as /sted/oslo/kjeveortopedi, which is its canonical (S3, section O)");
      assertTrue(introOf(fylke.text).startsWith("I Oslo har vi 5 tannlegeklinikker med kjeveortopedi i oversikten."), "B23: the fylke wording");
      assertEq(ofType(fylke.text, "FAQPage")[0]?.mainEntity?.[0]?.name, "Hvor mange tannlegeklinikker med kjeveortopedi finnes det i Oslo?", "B24: the fylke FAQ asks about the fylke");
      assertEq(ofType(fylke.text, "BreadcrumbList")[0]?.itemListElement?.map((c: any) => c.item), [base, `${base}/fylke/Oslo`, `${base}/fylke/Oslo/kjeveortopedi`], "B25: breadcrumb Hjem → Oslo (fylke) → facet");
    }

    // ── C. tannlegevakt ──────────────────────────────────────────────────
    {
      const page = await callRoute(router, "/sted/bergen/tannlegevakt");
      assertEq(page.status, 200, "C1: GET /sted/bergen/tannlegevakt -> 200");
      assertEq([h1Of(page.text), titleOf(page.text)], ["Tannlegevakt i Bergen", "Tannlegevakt i Bergen: klinikker med akuttvakt med kilde — Finn-tannlege.com"], "C2: H1 and title");
      const cs = cards(page.text);
      assertEq(cardNames(page.text).sort(), ["Bergen Vakt 1 AS", "Bergen Vakt 2 AS", "Bergen Vakt 3 AS", "Bergen Vakt 4 AS"], "C3: only the 4 clinics with sourced vakt");
      assertTrue(cs.length === 4 && cs.every((c) => c.includes(`<span class="badge badge-akutt">Akuttvakt</span>`)), "C4: every card shows «Akuttvakt» (sourced on the profile)");
      const main = mainOf(page.text);
      assertTrue(!main.includes("Bergen Uten Kilde AS") && !main.includes("Tar imot akuttpasienter") && !main.includes("Bergen Tar Imot AS"), "C5: acute_vakt = 1 without provenance and «Tar imot akuttpasienter» are never on it");
      assertTrue(!/Probe Vakt|Avvist Vakt|Nedlagt Vakt|Bergen Enk/.test(page.text), "C6: nor the probe, rejected, closed or non-clinic row");
      const intro = introOf(page.text);
      assertTrue(intro.startsWith("Vi har 4 tannlegeklinikker med akuttvakt og poststed Bergen i oversikten. Alle oppgir akuttvakt med kilde."), `C7: intro («${intro.slice(0, 100)}»)`);
      assertTrue(!/tar imot akuttpasienter/i.test(intro + JSON.stringify(tableRows(page.text))), "C8: the facet's own count (the akutt claim) is not restated as «tar imot akuttpasienter»");
      const first = ofType(page.text, "FAQPage")[0]?.mainEntity?.[0];
      assertEq(first?.name, "Hvor mange tannlegeklinikker med akuttvakt har poststed Bergen?", "C9: first question");
      assertTrue(/Alle oppgir akuttvakt med kilde\./.test(first?.acceptedAnswer?.text ?? "") && /116 117/.test(first?.acceptedAnswer?.text ?? "") && /113/.test(first?.acceptedAnswer?.text ?? ""), "C10: its answer says «med kilde» and points to legevakten (116 117) and 113");

      const fylke = await callRoute(router, "/fylke/Vestland/tannlegevakt");
      assertEq([fylke.status, h1Of(fylke.text)], [200, "Tannlegevakt i Vestland"], "C11: /fylke/Vestland/tannlegevakt -> 200");
      assertTrue(introOf(fylke.text).startsWith("I Vestland har vi 5 tannlegeklinikker med akuttvakt i oversikten."), "C12: fylke intro");
      assertEq(cardNames(fylke.text).sort(), ["Askøy Vakt AS", "Bergen Vakt 1 AS", "Bergen Vakt 2 AS", "Bergen Vakt 3 AS", "Bergen Vakt 4 AS"], "C13: the same 4 clinics and Askøy's");
      const lower = await callRoute(router, "/fylke/vestland/tannlegevakt");
      assertEq([lower.status, canonicalOf(lower.text)], [200, `${base}/fylke/Vestland/tannlegevakt`], "C14: /fylke/vestland/… is read in any case; canonical is the fylke's spelling");
      const upper = await callRoute(router, "/sted/BERGEN/Tannlegevakt");
      assertEq([upper.status, canonicalOf(upper.text)], [200, `${base}/sted/bergen/tannlegevakt`], "C15: /sted/BERGEN/Tannlegevakt -> 200 with the lower-case canonical");
      const molde = await callRoute(router, "/sted/molde/tannlegevakt");
      assertEq([molde.status, cardNames(molde.text).sort()], [200, ["Molde Vakt 1 AS", "Molde Vakt 2 AS", "Molde Vakt 3 AS"]], "C16: /sted/molde/tannlegevakt lists both spellings (MOLDE 2 + Molde 1)");
      const mr = await callRoute(router, `/fylke/${encodeURIComponent("Møre og Romsdal")}/tannlegevakt`);
      assertEq(
        [mr.status, ofType(mr.text, "BreadcrumbList")[0]?.itemListElement?.[2]?.item, canonicalOf(mr.text)],
        [200, `${base}/fylke/M%C3%B8re%20og%20Romsdal/tannlegevakt`, `${base}/sted/molde/tannlegevakt`],
        "C17: a fylke with spaces and ø: 200, its URL encoded as /fylke's; its 3 clinics are /sted/molde's (two spellings), so that is the canonical (S3)"
      );
    }

    // ── D. the gate ──────────────────────────────────────────────────────
    {
      const notFound: Array<[string, string]> = [
        ["/sted/bergen/kjeveortopedi", "1 kjeveortoped < minListings"],
        ["/sted/oslo/pedodonti", "2 clinics < minListings (Helfo and akutt notwithstanding)"],
        ["/sted/oslo/endodonti", "3 clinics but one fact (their own) < minFacts"],
        ["/sted/paritet/tannlegevakt", "2 vakt < minListings"],
        ["/sted/bergen/helfo", "the Helfo facet is off (7 rows say Helfo, none with a source)"],
        ["/fylke/Vestland/helfo", "the Helfo facet is off on /fylke too"],
        ["/sted/oslo/ukjent", "an unknown facet"],
        ["/sted/oslo/constructor", "a prototype key is no facet"],
        ["/sted/finnes-ikke/kjeveortopedi", "an unknown place"],
        ["/fylke/Ukjent/tannlegevakt", "an unknown fylke"],
        ["/fylke/Vestland/ukjent", "an unknown facet on /fylke"],
        ["/sted/tynn/kjeveortopedi", "a place with no clinic in the facet"],
      ];
      for (const [url, why] of notFound) {
        const r = await callRoute(router, url);
        assertTrue(r.status === 404 && /^noindex/.test(robotsOf(r.text)), `D1: ${url} -> 404 noindex: ${why} (got ${r.status}, «${robotsOf(r.text)}»)`);
      }
      const perio = await callRoute(router, "/sted/oslo/periodonti");
      assertEq([perio.status, cardNames(perio.text).length, h1Of(perio.text)], [200, 3, "Periodontist i Oslo"], "D2: 3 clinics and 2 facts (their own + Helfo) is exactly the gate: 200");

      const c = (total: number, helfo: number, acute: number, verified: number, specialist: number) =>
        ({ total, helfo_true: helfo, acute_sourced: acute, verified, specialist_clinics: specialist, max_updated_at: null });
      assertEq(
        [undefined, c(2, 2, 2, 2, 2), c(3, 3, 0, 0, 0), c(3, 3, 1, 0, 0), c(3, 0, 0, 1, 3), c(100, 0, 0, 0, 100)].map((x) => areaFacts.passesDentalFacetGate(x as any)),
        [false, false, false, true, true, false],
        "D3: passesDentalFacetGate: none, 2 clinics, 1 fact -> no; 3 clinics with 2 facts -> yes; 100 clinics with 1 fact -> no"
      );
      assertTrue(DENTAL_LANDING_FACETS.filter((f) => !f.enabled).every((f) => f.slug === "helfo"), "D4: only the Helfo facet is off");
    }

    // ── E. the sitemap ───────────────────────────────────────────────────
    {
      resetCaches();
      const xml = (await callRoute(router, "/sitemap.xml")).text;
      const all = locs(xml);
      const facetLocs = all.filter((l) => /\/(?:sted|fylke)\/[^/]+\/[^/]+$/.test(l));
      const expected = [
        "/sted/bergen/tannlegevakt", "/sted/oslo/kjeveortopedi", "/sted/oslo/periodonti", "/sted/molde/tannlegevakt",
        `/sted/${dentalSeo.slugifyText(evilPlace)}/kjeveortopedi`, "/sted/paged/kjeveortopedi", "/sted/grense/tannlegevakt",
        "/fylke/Vestland/tannlegevakt", "/fylke/Innlandet/tannlegevakt", "/fylke/Telemark/kjeveortopedi",
      ].map((p) => `${base}${p}`).sort();
      assertEq([...facetLocs].sort(), expected, "E1: the sitemap's facet URLs are exactly the facet pages over the gate (not Bergen kjeveortopedi 1, Oslo pedodonti 2 or endodonti with one fact, PARITET vakt 2, any Helfo), less the fylke pages that list the same clinics as a /sted page (Oslo, Rogaland, Møre og Romsdal; S3)");
      assertEq(new Set(facetLocs).size, facetLocs.length, "E2: each facet URL once");
      assertTrue(!facetLocs.some((l) => l.endsWith("/helfo")), "E3: no Helfo facet URL (the facet is off)");
      assertEq(lastmodOf(xml, `${base}/sted/oslo/kjeveortopedi`), "2026-08-20", "E4: lastmod = the newest clinic in the facet");
      assertEq(lastmodOf(xml, `${base}/sted/oslo`), "2026-09-30", "E5: while /sted/oslo keeps its own (the newest Oslo clinic)");
      assertEq(lastmodOf(xml, `${base}/fylke/Vestland/tannlegevakt`), "2026-05-04", "E6: fylke facet lastmod");

      // Parity: every facet URL in the sitemap answers 200 and is its own
      // canonical; every other place × facet is a 404, or a fylke page that
      // answers 200 with a /sted facet URL of the sitemap as its canonical.
      const answer = new Map<string, { status: number; canonical: string }>();
      const fetchFacet = async (url: string): Promise<{ status: number; canonical: string }> => {
        let r = answer.get(url);
        if (!r) {
          const page = await callRoute(router, url);
          answer.set(url, (r = { status: page.status, canonical: page.status === 200 ? canonicalOf(page.text) : "" }));
        }
        return r;
      };
      const ownAnswers: string[] = [];
      for (const l of facetLocs) {
        const r = await fetchFacet(l.slice(base.length));
        if (r.status !== 200 || r.canonical !== l) ownAnswers.push(`${l}: ${r.status} ${r.canonical}`);
      }
      assertTrue(facetLocs.length > 0 && ownAnswers.length === 0, `E7: every facet URL in the sitemap answers 200 and is its own canonical (${facetLocs.length}; ${JSON.stringify(ownAnswers)})`);
      const stedSlugs = [...new Set(store.listPoststeder(1).map((p) => dentalSeo.slugifyText(p.poststed)))];
      const fylker = all.filter((l) => /\/fylke\/[^/]+$/.test(l)).map((l) => l.slice(`${base}/fylke/`.length));
      const segments = [...DENTAL_LANDING_FACETS.map((x) => x.slug), "ukjent"];
      const offenders: string[] = [];
      const pointing: string[] = [];
      let combos = 0;
      for (const p of [...stedSlugs.map((s) => `/sted/${s}`), ...fylker.map((x) => `/fylke/${x}`)]) {
        for (const seg of segments) {
          const url = `${p}/${seg}`;
          combos++;
          const { status, canonical } = await fetchFacet(url);
          const inSitemap = facetLocs.includes(`${base}${url}`);
          if (status !== 200) {
            if (inSitemap) offenders.push(`${url}: ${status}, in the sitemap`);
          } else if (canonical === `${base}${url}`) {
            if (!inSitemap) offenders.push(`${url}: 200 and its own canonical, not in the sitemap`);
          } else {
            pointing.push(url);
            if (inSitemap || !p.startsWith("/fylke/") || !canonical.startsWith(`${base}/sted/`) || !facetLocs.includes(canonical)) {
              offenders.push(`${url}: 200 with canonical ${canonical}${inSitemap ? ", in the sitemap" : ""}`);
            }
          }
        }
      }
      assertEq(offenders, [], `E8: over every place × facet (${combos} URLs), a URL is in the sitemap exactly when it answers 200 as its own canonical; a fylke page with another canonical points to a /sted facet URL of the sitemap`);
      assertEq(pointing.sort(), ["/fylke/M%C3%B8re%20og%20Romsdal/tannlegevakt", "/fylke/Oslo/kjeveortopedi", "/fylke/Oslo/periodonti", "/fylke/Rogaland/kjeveortopedi"], "E9: the fylke pages with a /sted facet page as canonical are the four that list the same clinics");
    }

    // ── F. links from /sted and /fylke ───────────────────────────────────
    {
      const oslo = await callRoute(router, "/sted/oslo");
      assertEq(facetLinks(oslo.text), ["/sted/oslo/kjeveortopedi Kjeveortoped i Oslo (5)", "/sted/oslo/periodonti Periodontist i Oslo (3)"], "F1: /sted/oslo links its two facet pages, with their counts (not endodonti, pedodonti or helfo)");
      assertTrue(oslo.text.includes("Mer om tannleger i Oslo"), "F2: under a heading");
      assertTrue(/^index, follow/.test(robotsOf(oslo.text)) && oslo.status === 200, "F3: /sted/oslo stays 200 and indexable (decision 7=A)");
      const fylke = await callRoute(router, "/fylke/Oslo");
      assertEq(facetLinks(fylke.text), ["/fylke/Oslo/kjeveortopedi Kjeveortoped i Oslo (5)", "/fylke/Oslo/periodonti Periodontist i Oslo (3)"], "F4: /fylke/Oslo links its facet pages");
      const bergen = await callRoute(router, "/sted/bergen");
      assertEq(facetLinks(bergen.text), ["/sted/bergen/tannlegevakt Tannlegevakt i Bergen (4)"], "F5: /sted/bergen links tannlegevakt only (no Helfo, no thin kjeveortopedi)");
      const tynn = await callRoute(router, "/sted/tynn");
      assertTrue(tynn.status === 200 && !tynn.text.includes("landing-facet-links"), "F6: a place with no facet page has no facet links");
      const page2 = await callRoute(router, "/sted/paged?side=2");
      assertEq(facetLinks(page2.text), ["/sted/paged/kjeveortopedi Kjeveortoped i Paged (55)"], "F7: the links are on every page of /sted");
      const linked = [...facetLinks(oslo.text), ...facetLinks(fylke.text), ...facetLinks(bergen.text)].map((l) => l.split(" ")[0]!);
      const statuses: number[] = [];
      for (const href of linked) statuses.push((await callRoute(router, href)).status);
      assertTrue(statuses.every((s) => s === 200), `F8: every linked facet page answers 200 (${statuses.join(",")})`);
    }

    // ── G. paging ────────────────────────────────────────────────────────
    {
      const p1 = await callRoute(router, "/sted/paged/kjeveortopedi");
      assertEq([p1.status, cards(p1.text).length], [200, 50], "G1: page 1 has 50 cards");
      assertTrue(p1.text.includes(`href="/sted/paged/kjeveortopedi?side=2"`), "G2: and links page 2");
      assertTrue(introOf(p1.text) !== "" && ofType(p1.text, "FAQPage").length === 1, "G3: page 1 has intro and FAQ");
      const p2 = await callRoute(router, "/sted/paged/kjeveortopedi?side=2");
      assertEq([p2.status, cards(p2.text).length], [200, 5], "G4: page 2 has the last 5 cards");
      assertEq(ofType(p2.text, "ItemList")[0]?.itemListElement?.map((e: any) => e.position), [51, 52, 53, 54, 55], "G5: ItemList positions go on from 51");
      assertEq(canonicalOf(p2.text), `${base}/sted/paged/kjeveortopedi?side=2`, "G6: page 2 is its own canonical");
      assertTrue(titleOf(p2.text).includes(" – side 2 — Finn-tannlege.com") && /Side 2 av 2\.$/.test(decode(descriptionOf(p2.text))), "G7: with its own title and description");
      assertTrue(introOf(p2.text) === "" && tableRows(p2.text).length === 0 && !p2.text.includes("landing-faq") && ofType(p2.text, "FAQPage").length === 0, "G8: and no intro, table or FAQ");
      const p99 = await callRoute(router, "/sted/paged/kjeveortopedi?side=99");
      assertEq([p99.status, cards(p99.text).length, canonicalOf(p99.text)], [200, 50, `${base}/sted/paged/kjeveortopedi`], "G9: a ?side= past the end is page 1");
    }

    // ── H. escaping ──────────────────────────────────────────────────────
    {
      const slug = dentalSeo.slugifyText(evilPlace);
      const page = await callRoute(router, `/sted/${slug}/kjeveortopedi`);
      assertEq(page.status, 200, "H1: the markup place has a kjeveortopedi page");
      const outsideJsonLd = page.text.replace(/<script type="application\/ld\+json">.*?<\/script>/gs, "");
      assertTrue(!/<i>/.test(outsideJsonLd), "H2: no raw <i> from the place name anywhere in the HTML");
      assertTrue(h1Of(page.text).includes("&lt;i&gt;") && introOf(page.text).includes("&lt;i&gt;") && captionOf(page.text).includes("&lt;i&gt;"), "H3: H1, intro and caption show it escaped");
      assertTrue(titleOf(page.text).includes("&lt;i&gt;&quot;&amp;") && !titleOf(page.text).includes("&amp;amp;"), "H4: the title is escaped once");
      assertTrue(jsonLdBlocks(page.text).length >= 3, "H5: the JSON-LD blocks parse (ItemList, BreadcrumbList, FAQPage)");
      const links = facetLinks((await callRoute(router, `/sted/${slug}`)).text);
      assertTrue(links.length === 1 && links[0]!.includes("&lt;i&gt;"), "H6: the link label on /sted is escaped too");
    }

    // ── I. a cache behind the data ───────────────────────────────────────
    {
      resetCaches();
      assertTrue(introOf((await callRoute(router, "/sted/oslo/kjeveortopedi")).text) !== "", "I1: intro while cache and data agree");
      mk("Oslo Kjeve 6 AS", "OSLO", "Oslo", { specialties: '["kjeveortopedi"]' });
      const behind = await callRoute(router, "/sted/oslo/kjeveortopedi");
      assertEq([behind.status, cards(behind.text).length], [200, 6], "I2: the page lists the live 6 while the aggregate says 5");
      assertTrue(introOf(behind.text) === "" && tableRows(behind.text).length === 0 && ofType(behind.text, "FAQPage").length === 0 && !behind.text.includes("klinikker registrert"), "I3: and states no number (no intro, table, FAQ or header count) until the cache catches up");
      assertEq(
        metaDescriptions(behind.text),
        Array(3).fill("Oversikt over tannlegeklinikker med kjeveortopedi og poststed Oslo. Kjeveortopedi er oppført som spesialitet hos hver av dem."),
        "I3b: nor does the meta description (and og:/twitter:description): what the page lists, without a count (S1)"
      );
      const fylkeBehind = await callRoute(router, "/fylke/Oslo/kjeveortopedi");
      assertEq(
        [cards(fylkeBehind.text).length, introOf(fylkeBehind.text), decode(descriptionOf(fylkeBehind.text))],
        [6, "", "Oversikt over tannlegeklinikker med kjeveortopedi i Oslo. Kjeveortopedi er oppført som spesialitet hos hver av dem."],
        "I3c: the same on /fylke/Oslo/kjeveortopedi, worded for the fylke"
      );
      assertTrue(![...metaDescriptions(behind.text), ...metaDescriptions(fylkeBehind.text)].some((d) => /\d/.test(d)), "I3d: no digit in any of them");
      resetCaches();
      const caught = await callRoute(router, "/sted/oslo/kjeveortopedi");
      assertTrue(introOf(caught.text).startsWith("Vi har 6 tannlegeklinikker med kjeveortopedi") && caught.text.includes("6 klinikker registrert"), "I4: after the refresh it says 6");
      assertTrue(decode(descriptionOf(caught.text)).startsWith("Vi har 6 tannlegeklinikker med kjeveortopedi og poststed Oslo i oversikten."), "I4b: and the description states the count again");

      db.prepare("UPDATE dental_agents SET is_inactive = 1 WHERE navn LIKE 'Oslo Perio %'").run();
      assertEq((await callRoute(router, "/sted/oslo/periodonti")).status, 404, "I5: every clinic of a facet closed since the cache: 404, not an empty page");
      resetCaches();
      const sm = locs((await callRoute(router, "/sitemap.xml")).text);
      assertTrue((await callRoute(router, "/sted/oslo/periodonti")).status === 404 && !sm.includes(`${base}/sted/oslo/periodonti`), "I6: after the refresh still 404, and out of the sitemap");
      db.prepare("UPDATE dental_agents SET is_inactive = 0 WHERE navn LIKE 'Oslo Perio %'").run();
      resetCaches();
    }

    // ── J. route registration ────────────────────────────────────────────
    {
      const stack: any[] = router.stack;
      const routePaths = stack.map((l) => l.route?.path as string | undefined);
      const catchAll = stack.length - 1;
      assertTrue(!stack[catchAll]?.route, "J0: the router ends with the catch-all (a layer without a route)");
      const sted = routePaths.indexOf("/sted/:stedSlug/:facet");
      const fylke = routePaths.indexOf("/fylke/:fylke/:facet");
      assertTrue(sted >= 0 && fylke >= 0 && sted < catchAll && fylke < catchAll, `J1: both facet routes are registered before the catch-all (${sted}, ${fylke} < ${catchAll})`);
      const others = routePaths.filter((p): p is string => typeof p === "string" && /^\/(?:sted|fylke)\/[^/]+\/./.test(p) && p !== "/sted/:stedSlug/:facet" && p !== "/fylke/:fylke/:facet");
      assertEq(others, [], "J2: no other route has a path under /sted/<x>/ or /fylke/<x>/, so the facet routes shadow nothing and nothing shadows them");
    }

    // ── K. brand text ────────────────────────────────────────────────────
    {
      const texts: string[] = [];
      for (const url of ["/sted/oslo/kjeveortopedi", "/sted/bergen/tannlegevakt", "/fylke/Vestland/tannlegevakt"]) texts.push(mainOf((await callRoute(router, url)).text));
      assertTrue(texts.every((t) => !/\bFINN\b/.test(t) && !/finn\.no/i.test(t) && !/\bFinn\b(?!-tannlege)/.test(t)), "K1: the facet pages never say FINN, finn.no or «Finn» alone");
    }

    // ── L. recordAiPageDelivery ──────────────────────────────────────────
    {
      const initMod = require("../database/init") as typeof import("../database/init");
      const svc = require("../services/profile-ai-deliveries") as typeof import("../services/profile-ai-deliveries");
      const prevMain = initMod.__peekDbForTesting();
      const mainDb = new Database(":memory:");
      try {
        if (!log) console.log = () => { /* silence schema chatter */ };
        initMod.__setDbForTesting(mainDb as any);
        initMod.__initSchemaForTesting(mainDb as any);
        console.log = prevLog;
        svc.__resetAiDeliveriesForTesting();
        const invoke = (url: string, ua: string): Promise<number> => new Promise((resolve) => {
          const headers: Record<string, string> = { "user-agent": ua };
          const req: any = {
            method: "GET", url, originalUrl: url, path: url.split("?")[0], hostname: "finn-tannlege.test",
            query: {}, params: {}, headers, ip: "198.51.100.23", get(h: string) { return headers[h.toLowerCase()]; },
          };
          const res: any = new EventEmitter();
          Object.assign(res, {
            statusCode: 200, locals: {},
            status(c: number) { res.statusCode = c; return res; },
            set() { return res; }, header() { return res; }, setHeader() { return res; },
            send() { res.emit("finish"); resolve(res.statusCode); return res; },
          });
          router.handle(req, res, () => resolve(404));
        });
        const rows = (): string[] => (mainDb.prepare("SELECT profile_id FROM profile_ai_deliveries WHERE vertical_id = 'dental' AND channel = 'ai_page_list' ORDER BY profile_id").all() as Array<{ profile_id: string }>).map((r) => r.profile_id);
        const status = await invoke("/sted/bergen/tannlegevakt", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot");
        svc.flushAiDeliveries(mainDb as any);
        const vaktIds = store.listPublicDentalAgents({ poststed: "BERGEN", acute_claim: "vakt" }, 50, 0).map((a) => a.id).sort();
        assertEq([status, rows()], [200, vaktIds], "L1: ChatGPT-User on /sted/bergen/tannlegevakt: each of its 4 clinics counted in ai_page_list under dental");
        await invoke("/sted/oslo/kjeveortopedi", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36");
        svc.flushAiDeliveries(mainDb as any);
        assertEq(rows(), vaktIds, "L2: a person fetching a facet page counts nothing");
      } finally {
        console.log = prevLog;
        svc.__resetAiDeliveriesForTesting();
        initMod.__setDbForTesting(prevMain as any);
        try { mainDb.close(); } catch { /* already closed */ }
      }
    }

    // ── M. llms.txt ──────────────────────────────────────────────────────
    {
      const txt = (await callRoute(router, "/llms.txt")).text;
      assertTrue(txt.includes(`${base}/sted/{sted}/{fasett}`) && txt.includes(`${base}/fylke/{fylke}/{fasett}`), "M1: llms.txt names the facet URL patterns");
      const line = (txt.match(/^Fasetter: (.*)$/m) || [])[1] ?? "";
      assertEq(line.split(", "), DENTAL_LANDING_FACETS.filter((x) => x.enabled).map((x) => x.slug), "M2: and the facets that are on (no helfo)");
      assertTrue(txt.includes(`minst ${DENTAL_LANDING_CONFIG.facets.minListings} klinikker`) && txt.includes(`${base}/sitemap.xml`), "M3: and the gate, pointing to the sitemap for the pages that exist");
      assertTrue(txt.includes("Har en fylkesside nøyaktig de samme klinikkene som én stedsside, står bare stedssiden der."), "M4: and says a fylke page with the clinics of one /sted page is not in it (S3)");
    }

    // ── N. the emergency notice on the tannlegevakt pages ────────────────
    {
      resetCaches();
      const vakt = await callRoute(router, "/sted/bergen/tannlegevakt");
      const boxes = noticesOf(vakt.text);
      assertEq([boxes.length, textOf(boxes[0] ?? "")], [1, DENTAL_EMERGENCY_NOTICE.text], "N1: /sted/bergen/tannlegevakt has one emergency notice, its text exactly DENTAL_EMERGENCY_NOTICE's");
      const box = boxes[0] ?? "";
      assertTrue(
        box.includes(`<a href="tel:113" style="white-space:nowrap">113</a>`) && box.includes(`<a href="tel:116117" style="white-space:nowrap">116 117</a>`) && (box.match(/<a /g) || []).length === 2,
        "N2: 113 and 116 117 are tel: links (tel:113, tel:116117), and nothing else is a link"
      );
      assertTrue(/<aside class="akutt-banner emergency-notice" role="note" /.test(vakt.text), "N3: a marked box: an aside with role note, in the akutt banner style");
      const main = mainOf(vakt.text);
      const at = main.indexOf(`class="akutt-banner emergency-notice"`);
      assertTrue(at > 0 && at < main.indexOf(`class="landing-intro"`) && at < main.indexOf(`<article class="clinic-card">`), "N4: it stands above the intro and the clinic list");
      const others: Array<[string, number]> = [
        ["/fylke/Vestland/tannlegevakt", 5],
        ["/sted/grense/tannlegevakt?side=2", 5],
        ["/fylke/Innlandet/tannlegevakt?side=2", 4],
      ];
      const shown: Array<[string, string]> = [["/sted/bergen/tannlegevakt", vakt.text]];
      for (const [url, n] of others) {
        const r = await callRoute(router, url);
        shown.push([url, r.text]);
        assertTrue(
          r.status === 200 && cards(r.text).length === n && noticesOf(r.text).length === 1 && textOf(noticesOf(r.text)[0] ?? "") === DENTAL_EMERGENCY_NOTICE.text &&
            mainOf(r.text).indexOf("emergency-notice") < mainOf(r.text).indexOf(`<article class="clinic-card">`),
          `N5: ${url} (${n} cards) has it above the list too`
        );
      }
      assertTrue(introOf((await callRoute(router, "/sted/grense/tannlegevakt?side=2")).text) === "", "N6: (page 2 has no intro, but the notice)");
      // While the list and the aggregate disagree the facts are hidden, the notice is not.
      const extra = mk("Bergen Vakt 5 AS", "BERGEN", "Vestland", { acuteVakt: 1, provenance: PROV });
      const behind = await callRoute(router, "/sted/bergen/tannlegevakt");
      assertTrue(
        cards(behind.text).length === 5 && introOf(behind.text) === "" && !behind.text.includes("klinikker registrert") && noticesOf(behind.text).length === 1,
        "N7: with the cache behind the data (5 listed, 4 counted) no number is stated, and the notice stays"
      );
      shown.push(["/sted/bergen/tannlegevakt (cache behind)", behind.text]);
      // The full text, pinned here as well (YMYL): on page 1, on page 2 of
      // /sted and /fylke and while the cache is behind. Those have no FAQ,
      // so the box is the only place they say to call the clinic first.
      const NOTICE =
        "Ved akutt fare for liv eller helse: ring 113. Trenger du rask hjelp utenom åpningstid, ring legevakten på 116 117. Ellers kan du kontakte tannlegevakten der du bor. " +
        "At en klinikk er merket med akuttilbud her, betyr ikke at den kan ta imot deg nå. Ring klinikken før du drar dit.";
      assertEq(
        shown.map(([url, html]) => [url, noticesOf(html).map(textOf)]),
        shown.map(([url]) => [url, [NOTICE]]),
        "N9: every tannlegevakt page shows the notice word for word, ending with «Ring klinikken før du drar dit.»: page 1, page 2 of /sted and /fylke, the cache behind"
      );
      assertEq(
        shown.filter(([url]) => url.includes("side=2") || url.includes("cache behind")).map(([url, html]) => [url, faqQuestions(html).length]),
        [["/sted/grense/tannlegevakt?side=2", 0], ["/fylke/Innlandet/tannlegevakt?side=2", 0], ["/sted/bergen/tannlegevakt (cache behind)", 0]],
        "N9b: (page 2 and the page with the cache behind show no FAQ)"
      );
      // The caveat is the one Daniel approved in /vilkar pkt. 3: read from the page itself.
      const vilkar = await callRoute(router, "/vilkar");
      const caveat = (textOf(vilkar.text).match(/At en klinikk er merket med akuttilbud her[^.]*\. Ring klinikken[^.]*\./) || [])[0] ?? "";
      assertTrue(
        vilkar.status === 200 && caveat !== "" && DENTAL_EMERGENCY_NOTICE.text.endsWith(` ${caveat}`),
        `N10: the notice ends with the caveat of /vilkar pkt. 3, word for word («${caveat}»)`
      );
      db.prepare("UPDATE dental_agents SET is_inactive = 1 WHERE id = ?").run(extra);
      resetCaches();
      const without: string[] = [];
      for (const url of ["/sted/oslo/kjeveortopedi", "/sted/oslo/periodonti", "/fylke/Telemark/kjeveortopedi", "/sted/paged/kjeveortopedi?side=2", "/sted/bergen", "/fylke/Vestland", "/sted/grense"]) {
        const r = await callRoute(router, url);
        if (r.status !== 200 || noticesOf(r.text).length > 0 || r.text.includes("tel:116117")) without.push(`${url}: ${r.status}`);
      }
      assertEq(without, [], "N8: no other facet page, and no /sted or /fylke page, has the notice");
    }

    // ── O. a fylke facet page with the clinics of one /sted facet page ───
    {
      resetCaches();
      const sm = locs((await callRoute(router, "/sitemap.xml")).text);
      const ogUrlOf = (html: string): string => (html.match(/<meta property="og:url" content="([^"]*)">/) || [])[1] ?? "";
      const same: Array<[string, string, string]> = [
        ["/fylke/Oslo/kjeveortopedi", "/sted/oslo/kjeveortopedi", "one spelling"],
        ["/fylke/Oslo/periodonti", "/sted/oslo/periodonti", "a second facet of the same place"],
        [`/fylke/${encodeURIComponent("Møre og Romsdal")}/tannlegevakt`, "/sted/molde/tannlegevakt", "two spellings, MOLDE and Molde"],
        ["/fylke/Rogaland/kjeveortopedi", "/sted/paged/kjeveortopedi", "two pages"],
      ];
      for (const [fylkeUrl, stedUrl, what] of same) {
        const f = await callRoute(router, fylkeUrl);
        const s = await callRoute(router, stedUrl);
        assertEq(
          [f.status, /^index, follow/.test(robotsOf(f.text)), canonicalOf(f.text), ogUrlOf(f.text), cardNames(f.text), sm.includes(`${base}${fylkeUrl}`), sm.includes(`${base}${stedUrl}`), canonicalOf(s.text)],
          [200, true, `${base}${stedUrl}`, `${base}${stedUrl}`, cardNames(s.text), false, true, `${base}${stedUrl}`],
          `O1: ${fylkeUrl} lists the clinics of ${stedUrl} (${what}): 200 and indexable, canonical and og:url ${stedUrl}, out of the sitemap; ${stedUrl} stays its own canonical, in the sitemap`
        );
      }
      const f2 = await callRoute(router, "/fylke/Rogaland/kjeveortopedi?side=2");
      const s2 = await callRoute(router, "/sted/paged/kjeveortopedi?side=2");
      assertEq([canonicalOf(f2.text), cardNames(f2.text)], [`${base}/sted/paged/kjeveortopedi?side=2`, cardNames(s2.text)], "O2: page 2 of it points to page 2 of the /sted page, which shows the same 5 clinics");
      const differ: Array<[string, string]> = [
        ["/fylke/Vestland/tannlegevakt", "Askøy's clinic is in no Bergen page"],
        ["/fylke/Innlandet/tannlegevakt", "/sted/grense has a 55th clinic, in Trøndelag"],
        ["/fylke/Telemark/kjeveortopedi", "a clinic without a poststed is in no /sted page, though its place has as many with one in Vestfold"],
      ];
      for (const [url, why] of differ) {
        const r = await callRoute(router, url);
        assertEq([r.status, canonicalOf(r.text), sm.includes(`${base}${url}`)], [200, `${base}${url}`, true], `O3: ${url} lists clinics no single /sted facet page has (${why}): its own canonical, in the sitemap`);
      }
      // Decided from the cached aggregate, not a query per request: a sixth
      // kjeveortopedi clinic in Oslo the fylke, with another poststed, moves
      // the canonical only once the cache has it.
      const listed = cards((await callRoute(router, "/fylke/Oslo/kjeveortopedi")).text).length;
      const nydalen = mk("Nydalen Kjeve AS", "NYDALEN", "Oslo", { specialties: '["kjeveortopedi"]' });
      const cached = await callRoute(router, "/fylke/Oslo/kjeveortopedi");
      assertEq([cards(cached.text).length, canonicalOf(cached.text)], [listed + 1, `${base}/sted/oslo/kjeveortopedi`], "O4: the canonical follows the cached aggregate, though the list already has Nydalen's clinic");
      resetCaches();
      const fresh = await callRoute(router, "/fylke/Oslo/kjeveortopedi");
      const freshSm = locs((await callRoute(router, "/sitemap.xml")).text);
      assertEq(
        [canonicalOf(fresh.text), freshSm.includes(`${base}/fylke/Oslo/kjeveortopedi`), freshSm.includes(`${base}/sted/oslo/kjeveortopedi`)],
        [`${base}/fylke/Oslo/kjeveortopedi`, true, true],
        "O5: after the refresh the fylke page lists one more than /sted/oslo's: its own canonical, and both are in the sitemap"
      );
      db.prepare("UPDATE dental_agents SET is_inactive = 1 WHERE id = ?").run(nydalen);
      resetCaches();

      // canonicalFacetPlace points only to a /sted facet page that is published.
      const landing = require("./dental-landing") as typeof import("./dental-landing");
      const c = (total: number, helfo: number) => ({ total, verified: 0, helfo_true: helfo, acute_sourced: 0, specialist_clinics: total, max_updated_at: null });
      const kjeve = facetBySlug("kjeveortopedi");
      const helfoFacet = facetBySlug("helfo");
      const sted = (n: number): any => ({ scope: "poststed", name: "X", path: "/sted/x", filter: {}, counts: { ...c(n, 1), facets: { kjeveortopedi: c(n, 1), helfo: { ...c(n, n), specialist_clinics: 1 } } } });
      const fylkeOf = (twin: any): any => ({ scope: "fylke", name: "Y", path: "/fylke/Y", filter: {}, counts: undefined, sameClinicsAs: () => twin });
      const over = sted(3);
      const under = sted(2);
      const fOver = fylkeOf(over);
      const fUnder = fylkeOf(under);
      const fNone = fylkeOf(undefined);
      assertTrue(
        landing.canonicalFacetPlace(fOver, kjeve) === over && landing.canonicalFacetPlace(fUnder, kjeve) === fUnder &&
          landing.canonicalFacetPlace(fOver, helfoFacet) === fOver && landing.canonicalFacetPlace(fNone, kjeve) === fNone,
        "O6: canonicalFacetPlace: the /sted place when its facet page is published, else the place itself (under the gate, a facet that is off, no such place)"
      );
    }

    // ── P. the sitemap's facet loop runs no query of its own ─────────────
    {
      // Statement runs while the sitemap is built from warm caches (the
      // aggregate, the place lists), counted on better-sqlite3's
      // Statement.prototype as in dental-area-landing.test.ts F4d: every run
      // of every statement on any connection, however it was prepared. Four
      // more places with a tannlegevakt page, and their fylke's, must not
      // add one: the loop reads the cached aggregate, never a query per
      // place or facet.
      const RUN_METHODS = ["all", "get", "run", "iterate"] as const;
      const statementProto: Record<string, unknown> = Object.getPrototypeOf(db.prepare("SELECT 1"));
      const realRuns = RUN_METHODS.map((k) => [k, statementProto[k] as (...args: unknown[]) => unknown] as const);
      const isFacetLoc = (l: string): boolean => /\/(?:sted|fylke)\/[^/]+\/[^/]+$/.test(l);
      const countedSitemap = async (): Promise<{ runs: number; facetUrls: number }> => {
        resetCaches();
        await callRoute(router, "/sitemap.xml");
        dentalSeo.__resetDentalSitemapCacheForTesting();
        let runs = 0;
        for (const [k, real] of realRuns) {
          statementProto[k] = function (this: unknown, ...args: unknown[]) { runs++; return real.apply(this, args); };
        }
        let xml = "";
        try {
          xml = (await callRoute(router, "/sitemap.xml")).text;
        } finally {
          for (const [k, real] of realRuns) statementProto[k] = real;
        }
        return { runs, facetUrls: locs(xml).filter(isFacetLoc).length };
      };
      const before = await countedSitemap();
      const added: string[] = [];
      for (let p = 1; p <= 4; p++) {
        for (let i = 1; i <= 3; i++) added.push(mk(`Vaktsted ${p}-${i} AS`, `VAKTSTED${p}`, "Nordland", { acuteVakt: 1, provenance: PROV, helfo: i === 1 }));
      }
      const after = await countedSitemap();
      assertEq(after.facetUrls, before.facetUrls + 5, `P1: (the fixture adds 5 facet URLs: 4 /sted/vaktstedN/tannlegevakt and /fylke/Nordland/tannlegevakt; ${before.facetUrls} -> ${after.facetUrls})`);
      assertTrue(before.runs > 0 && after.runs === before.runs, `P2: building the sitemap runs as many statements with ${after.facetUrls} facet URLs as with ${before.facetUrls} (${before.runs} -> ${after.runs}): no query per place or facet`);
      for (const id of added) db.prepare("UPDATE dental_agents SET is_inactive = 1 WHERE id = ?").run(id);
      resetCaches();
    }
  } catch (err: any) {
    failed++;
    failures.push("dental landing (F1-S4a): unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalLandingTests({ log: true }).then((r) => {
    console.log(`\ndental landing (F1-S4a): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
