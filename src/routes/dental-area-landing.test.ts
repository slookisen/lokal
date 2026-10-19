/**
 * dental-area-landing.test.ts -- dev-request 2026-10-16-finn-tannlege-landingssider,
 * skive F1-S3 (fakta-intro, tabell og FAQ på /sted og /fylke).
 *
 *   A  getDentalAreaFacts(): per poststed and per fylke counts from public
 *      rows only; SQL/JS parity of the sourced-akutt count against
 *      resolveAcuteClaim() on edge-case rows; parity of the specialist count
 *      with the cards' clinicSpecialties() (staff-only lists do not count);
 *      a non-date updated_at hides no date; served from the cache.
 *   B  /sted/bergen: answer-first paragraph (40-60 words, Helfo «ifølge
 *      klinikkenes nettsider», akutt «med kilde»), fact table, visible FAQ =
 *      FAQPage JSON-LD; the page counts its poststed («med poststed Bergen»),
 *      /sok?q=Bergen also the rest of Bergen kommune (Nesttun 5221).
 *   C  /fylke/Vestland and /fylke/Oslo; page 2 repeats neither FAQ nor table.
 *   D  FAQ gate: thin places (few clinics, few facts) get intro and table but
 *      no FAQ and no FAQPage; escaping of a place name with markup.
 *   E  indexing (decision 7=A): isDentalStedIndexable; /sted with 1 clinic is
 *      200, «index, follow» and in the sitemap, no FAQPage; /sted with 0 is
 *      404 or noindex and not in the sitemap; the route and the sitemap use
 *      the same predicate; no env variable changes the rule.
 *   F  cost on a synthetic 6,900-row DB: a coarse time guard on an uncached
 *      getDentalAreaFacts (best of 5 under 150 ms; 12-23 ms measured on an
 *      idle machine and on CI, ~300 ms for a quadratic fold); a hit comes
 *      from the cache; one computation prepares one statement and runs it
 *      once, a hit none. Runs are counted on better-sqlite3's
 *      Statement.prototype, so every connection counts, and so does a
 *      statement cached per connection and run per row. Within the TTL a
 *      hit starts nothing; past it, one background computation.
 *   H  a failing background refresh keeps the old numbers and logs a warning
 *      (the message only, no row data).
 *
 * Same harness as dental-sted-stavemater.test.ts (in-memory dental DB, the
 * router driven through router.handle()).
 *
 * Standalone: npx tsx src/routes/dental-area-landing.test.ts
 * Wired into tests/test.ts via runDentalAreaLandingTests().
 */

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
      params: {}, query, headers: {}, get() { return undefined; },
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
const sokCount = (html: string): number | null => {
  const m = html.match(/([\d\s  ]+) klinikker funnet/);
  return m ? Number(m[1]!.replace(/\D/g, "")) : null;
};
/** Every JSON-LD block of a page, parsed. */
const jsonLdBlocks = (html: string): any[] =>
  Array.from(html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs), (m) => JSON.parse(m[1]!));
const faqPages = (html: string): any[] => jsonLdBlocks(html).filter((b) => b["@type"] === "FAQPage");
const introOf = (html: string): string => (html.match(/<p class="landing-intro"[^>]*>([^<]*)<\/p>/) || [])[1] ?? "";
const tableRows = (html: string): Array<[string, string]> =>
  Array.from(html.matchAll(/<tr><th scope="row"[^>]*>([^<]*)<\/th><td[^>]*>([^<]*)<\/td><\/tr>/g), (m) => [m[1]!, m[2]!]);
const faqQuestions = (html: string): string[] => Array.from(html.matchAll(/<h3 style="font-size:1rem;margin-bottom:4px">([^<]*)<\/h3>/g), (m) => m[1]!);
const words = (s: string): number => (s.trim() === "" ? 0 : s.trim().split(/\s+/).length);
/** <loc> list of the sitemap. */
const locs = (xml: string): string[] => Array.from(xml.matchAll(/<loc>([^<]*)<\/loc>/g), (m) => m[1]!);

export async function runDentalAreaLandingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevEnvSwitch = process.env.DENTAL_STED_MIN_CLINICS_INDEX;
  process.env.DENTAL_DB_PATH = ":memory:";

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-area-facts"),
    require.resolve("./dental-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const areaFacts = require("../services/dental-area-facts") as typeof import("../services/dental-area-facts");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const { resolveAcuteClaim } = require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");
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
    let orgSeq = 927770000;
    interface Extra {
      updatedAt?: string; rejected?: boolean; inactive?: boolean; klass?: string; verified?: boolean;
      helfo?: boolean; acuteVakt?: 0 | 1; provenance?: string | null; focus?: string | null; specialists?: string | null;
      /** Raw available_specialties column. */
      specialties?: string | null;
      postnummer?: string;
    }
    const mk = (navn: string, poststed: string, fylke: string, x: Extra = {}): string => {
      const org_nr = String(++orgSeq);
      const id = store.createDentalAgent({ navn, org_nr, poststed, fylke, adresse: "Storgata 1", telefon: "22110099", ...(x.postnummer ? { postnummer: x.postnummer } : {}) } as any);
      db.prepare(
        "UPDATE dental_agents SET catalog_class = ?, is_inactive = ?, verification_status = ?, helfo_agreement = ?, acute_vakt = ?," +
        " field_provenance = ?, patient_focus = ?, specialists = COALESCE(?, specialists), available_specialties = COALESCE(?, available_specialties)," +
        " updated_at = COALESCE(?, updated_at) WHERE id = ?"
      ).run(
        x.klass ?? "klinikk", x.inactive ? 1 : 0,
        x.rejected ? "rejected" : x.verified ? "verified" : "unverified",
        x.helfo ? "true" : "unknown", x.acuteVakt ?? 0,
        x.provenance ?? null, x.focus ?? null, x.specialists ?? null, x.specialties ?? null, x.updatedAt ?? null, id
      );
      return id;
    };
    // A deep-scraped staff list: every employee, no specialist among them.
    const STAFF_ONLY = '[{"navn":"Ola","title":"Tannlege"},{"navn":"Siri","title":"Tannhelsesekretær"},{"navn":"Per","title":"Klinikkleiar"}]';
    const PROV = '{"acute_vakt":[{"source":"https://example.test/akutt"}]}';

    // Bergen: 12 × BERGEN + 1 × Bergen = 13 public clinics.
    //   helfo 1-5 (5) · verified 1-3 (3)
    //   a specialty on the card: 7 (title «Spesialist i kjeveortopedi»), 8 (available_specialties) = 2
    //   no specialty on the card: 9 (staff only: tannlege, sekretær, klinikkleiar), 10 (a name, no title)
    //   akutt with a source: 1-2 vakt+provenance, 4-5 patient_focus «akutt» = 4
    //   not counted as akutt: 3 (acute_vakt without provenance), 6 (provenance, acute_vakt = 0)
    for (let i = 1; i <= 12; i++) {
      mk(`Bergen Tann ${i} AS`, "BERGEN", "Vestland", {
        helfo: i <= 5, verified: i <= 3,
        acuteVakt: i <= 3 ? 1 : 0,
        provenance: i <= 2 || i === 6 ? PROV : null,
        focus: i === 4 || i === 5 ? '["Akutte smerter","Voksne"]' : null,
        specialists: i === 7 ? '[{"navn":"Kari","title":"Spesialist i kjeveortopedi"}]' : i === 9 ? STAFF_ONLY : i === 10 ? '[{"navn":"Kjeve"}]' : null,
        specialties: i === 8 ? '["Oral kirurgi og oral medisin"]' : null,
        updatedAt: `2026-0${(i % 9) + 1}-10 10:00:00`,
      });
    }
    // NESTTUN (5221) is in Bergen kommune, so /sok?q=Bergen lists it; /sted/bergen does not.
    mk("Nesttun Tann AS", "NESTTUN", "Vestland", { postnummer: "5221", helfo: true, focus: '["Akutt"]', updatedAt: "2026-09-01 10:00:00" });
    mk("Bergen Mixed Tann AS", "Bergen", "Vestland", { updatedAt: "2026-09-30 12:00:00" });
    // Left out of every number: rejected, closed, a non-clinic class.
    mk("Avvist Bergen AS", "BERGEN", "Vestland", { rejected: true, helfo: true, acuteVakt: 1, provenance: PROV, updatedAt: "2026-10-05 10:00:00" });
    mk("Nedlagt Bergen AS", "BERGEN", "Vestland", { inactive: true, helfo: true, updatedAt: "2026-10-06 10:00:00" });
    mk("Bergen Enk", "BERGEN", "Vestland", { klass: "person_enk", helfo: true, updatedAt: "2026-10-07 10:00:00" });
    // OS (Vestland): 2 clinics, one Helfo.
    mk("Os Tann 1 AS", "OS", "Vestland", { helfo: true, updatedAt: "2026-08-01 10:00:00" });
    mk("Os Tann 2 AS", "OS", "Vestland", { updatedAt: "2026-08-02 10:00:00" });
    // Oslo: 4 clinics, Helfo 2 + verified 1 -> two real facts.
    for (let i = 1; i <= 4; i++) mk(`Oslo Tann ${i} AS`, "OSLO", "Oslo", { helfo: i <= 2, verified: i === 1, updatedAt: `2026-04-0${i} 10:00:00` });
    // Thin places in Agder: SOLO 1 clinic (two facts), TYNN 3 clinics (one fact).
    mk("Solo Tann AS", "SOLO", "Agder", { helfo: true, verified: true, updatedAt: "2026-05-05 10:00:00" });
    for (let i = 1; i <= 3; i++) mk(`Tynn Tann ${i} AS`, "TYNN", "Agder", { helfo: i === 1, updatedAt: "2026-05-06 10:00:00" });
    // PAGED: 55 clinics over two pages, Helfo 3, verified 2.
    for (let i = 1; i <= 55; i++) mk(`Paged Tann ${String(i).padStart(2, "0")} AS`, "PAGED", "Rogaland", { helfo: i <= 3, verified: i <= 2, updatedAt: "2026-06-01 10:00:00" });
    // A place name with markup, three clinics, two facts.
    const evilPlace = 'Ås<i>"&Co';
    for (let i = 1; i <= 3; i++) mk(`Markup Tann ${i} AS`, evilPlace, "Telemark", { helfo: i <= 2, verified: i === 1, updatedAt: "2026-07-01 10:00:00" });
    // A place with only a rejected clinic: not a /sted page at all.
    mk("Kun Avvist AS", "NULLSTED", "Troms", { rejected: true, helfo: true });
    // Parity edge rows (PARITET): every shape the akutt claim distinguishes.
    const edge: Array<[string, Extra]> = [
      ["a", { acuteVakt: 1, provenance: '{"acute_vakt":{"sources":["x"]}}' }],
      ["b", { acuteVakt: 1, provenance: '{"acute_vakt":[]}' }],
      ["c", { acuteVakt: 1, provenance: '{bad json' }],
      ["d", { focus: '["AKUTT hjelp"]' }],
      ["e", { focus: '"akutt"' }],
      ["f", { focus: '{"a":"akutt"}' }],
      ["g", { acuteVakt: 0, provenance: PROV }],
      ["h", { acuteVakt: 1, provenance: '{"acute_vakt":{"sources":[]}}', focus: '["Akutt"]' }],
      ["i", { focus: '[1,2,"annet"]' }],
      ["j", { acuteVakt: 1, provenance: PROV, focus: 'ikke json' }],
    ];
    for (const [k, x] of edge) mk(`Paritet ${k} AS`, "PARITET", "Nordland", x);
    // Specialty parity rows (SPESPARITET): b, c and h show a specialty on the card.
    const specEdge: Array<[string, Extra]> = [
      ["a", { specialists: '[{"title":"Tannlege"}]' }],
      ["b", { specialists: '[{"title":"Spesialist i kjeveortopedi"},{"title":"Tannlege"}]' }],
      ["c", { specialists: '[{"specialty":"Endodonti"}]' }],
      ["d", { specialists: '[{"specialty":"  "},{"title":null}]' }],
      ["e", { specialists: '"Kjeveortoped"' }],
      ["f", { specialists: 'ikke json' }],
      ["g", { specialties: '[""]' }],
      ["h", { specialties: '["Kjeveortopedi"]', specialists: STAFF_ONLY }],
      ["i", { specialties: 'null' }],
      ["j", { specialists: '[null,{"title":"Tannhelsesekretær"},{"title":"Klinikkleiar"}]' }],
    ];
    for (const [k, x] of specEdge) mk(`Spesparitet ${k} AS`, "SPESPARITET", "Nordland", x);
    // SPESTOM: 4 clinics, 2 Helfo, 2 with a staff-only list. One real fact, so no FAQ.
    for (let i = 1; i <= 4; i++) mk(`Spestom Tann ${i} AS`, "SPESTOM", "Innlandet", { helfo: i <= 2, specialists: i >= 3 ? STAFF_ONLY : null, updatedAt: "2026-05-07 10:00:00" });
    // UDATERT: one row whose updated_at is not a date; it must not hide the other's date.
    mk("Udatert Tann 1 AS", "UDATERT", "Innlandet", { updatedAt: "ukjent" });
    mk("Udatert Tann 2 AS", "UDATERT", "Innlandet", { updatedAt: "2026-03-03 10:00:00" });

    // ── A. the aggregate ─────────────────────────────────────────────────
    {
      const f = areaFacts.getDentalAreaFacts();
      const bergen = areaFacts.sumAreaCounts([f.byPoststed.get("BERGEN"), f.byPoststed.get("Bergen")]);
      assertEq(
        { total: bergen.total, verified: bergen.verified, helfo_true: bergen.helfo_true, acute_sourced: bergen.acute_sourced, specialist_clinics: bergen.specialist_clinics },
        { total: 13, verified: 3, helfo_true: 5, acute_sourced: 4, specialist_clinics: 2 },
        "A1: Bergen (both spellings): rejected, closed and non-clinic rows are not counted"
      );
      assertEq(bergen.max_updated_at, "2026-09-30 12:00:00", "A2: max_updated_at = the newest PUBLIC Bergen clinic (not the rejected/closed rows dated later)");
      const vestland = f.byFylke.get("Vestland")!;
      assertEq([vestland.total, vestland.helfo_true, vestland.acute_sourced], [16, 7, 5], "A3: Vestland = Bergen 13 + Nesttun 1 + Os 2; Helfo 5 + 1 + 1; akutt 4 + 1");
      assertEq(f.byPoststed.get("NULLSTED"), undefined, "A4: a poststed with only a rejected clinic has no aggregate");

      // SQL/JS parity: the aggregate's akutt count = resolveAcuteClaim(row) !== null, per poststed.
      const all = store.listPublicDentalAgents({}, 500, 0);
      const jsByPoststed = new Map<string, number>();
      for (const a of all) {
        if (resolveAcuteClaim(a) !== null) jsByPoststed.set(a.poststed!, (jsByPoststed.get(a.poststed!) ?? 0) + 1);
      }
      const mismatches: string[] = [];
      for (const [poststed, c] of f.byPoststed) {
        if ((jsByPoststed.get(poststed) ?? 0) !== c.acute_sourced) mismatches.push(`${poststed}: sql ${c.acute_sourced} js ${jsByPoststed.get(poststed) ?? 0}`);
      }
      assertEq(mismatches, [], "A5: acute_sourced (SQL) = resolveAcuteClaim !== null (JS) for every poststed");
      assertEq(all.length, [...f.byPoststed.values()].reduce((n, c) => n + c.total, 0), "A5b: the parity check ran over the whole public set (every aggregate row)");
      assertEq(f.byPoststed.get("PARITET")!.acute_sourced, 4, "A6: PARITET edge rows: a, d, h (patient_focus) and j (provenance) count; b, c, e, f, g, i do not");

      // Specialist parity: the aggregate counts exactly the clinics whose card
      // shows a specialty (clinicSpecialties on the rows the pages list).
      const { clinicSpecialties } = require("../config/dental-search-vocabulary") as typeof import("../config/dental-search-vocabulary");
      const specBy = (key: (a: (typeof all)[number]) => string | null | undefined): Map<string, number> => {
        const m = new Map<string, number>();
        for (const a of all) {
          const k = key(a);
          if (k && clinicSpecialties(a).length > 0) m.set(k, (m.get(k) ?? 0) + 1);
        }
        return m;
      };
      const specMismatches: string[] = [];
      for (const [label, map, js] of [
        ["poststed", f.byPoststed, specBy((a) => a.poststed)],
        ["fylke", f.byFylke, specBy((a) => a.fylke)],
      ] as const) {
        for (const [k, c] of map) {
          if ((js.get(k) ?? 0) !== c.specialist_clinics) specMismatches.push(`${label} ${k}: aggregate ${c.specialist_clinics} cards ${js.get(k) ?? 0}`);
        }
      }
      assertEq(specMismatches, [], "A10: specialist_clinics = clinics with clinicSpecialties(card row).length > 0, for every poststed and fylke");
      assertEq(f.byPoststed.get("SPESPARITET")!.specialist_clinics, 3, "A11: SPESPARITET edge rows: b (title), c (specialty) and h (available_specialties) count; staff titles, blanks, non-arrays and bad JSON do not");
      assertEq([bergen.specialist_clinics, f.byPoststed.get("SPESTOM")!.specialist_clinics], [2, 0], "A12: a filled specialists column with only staff titles (Bergen 9-10, SPESTOM) is not a specialist clinic");
      assertEq(f.byPoststed.get("UDATERT")!.max_updated_at, "2026-03-03 10:00:00", "A13: an updated_at that is not a date («ukjent») neither becomes nor hides the newest date");
      assertEq(
        ["2026-10-12 08:30:00", "2026-02-28", "2028-02-29", "2026-02-30 10:00:00", "2026-04-31", "2026-10-00", "2026-13-01", "ukjent"].map((v) => areaFacts.formatNorwegianDate(v)),
        ["12. oktober 2026", "28. februar 2026", "29. februar 2028", null, null, null, null, null],
        "A14: formatNorwegianDate gives only real calendar dates"
      );

      // Served from the cache: same object, and a later write is not seen until the TTL / a reset.
      assertTrue(areaFacts.getDentalAreaFacts() === f, "A7: a second call returns the cached aggregate");
      db.prepare("UPDATE dental_agents SET helfo_agreement = 'true' WHERE poststed = 'OSLO'").run();
      assertEq(areaFacts.getDentalAreaFacts().byPoststed.get("OSLO")!.helfo_true, 2, "A8: within the TTL a write is not re-read (no scan per request)");
      areaFacts.__resetDentalAreaFactsForTesting();
      assertEq(areaFacts.getDentalAreaFacts().byPoststed.get("OSLO")!.helfo_true, 4, "A9: after the cache is dropped the write shows");
      db.prepare("UPDATE dental_agents SET helfo_agreement = CASE WHEN navn IN ('Oslo Tann 1 AS','Oslo Tann 2 AS') THEN 'true' ELSE 'unknown' END WHERE poststed = 'OSLO'").run();
      resetCaches();
    }

    // ── B. /sted/bergen ──────────────────────────────────────────────────
    {
      const page = await callRoute(router, "/sted/bergen");
      assertEq(page.status, 200, "B1: GET /sted/bergen -> 200");
      const intro = introOf(page.text);
      assertTrue(intro.startsWith("Vi har 13 tannlegeklinikker med poststed Bergen i oversikten."), `B2: the paragraph leads with the number of clinics and says what it counts (poststed Bergen) («${intro.slice(0, 70)}»)`);
      assertTrue(words(intro) >= 40 && words(intro) <= 60, `B3: the paragraph is 40-60 words (${words(intro)})`);
      assertTrue(intro.includes("5 av dem oppgir Helfo-direkteoppgjør ifølge klinikkenes nettsider"), "B4: Helfo is worded «ifølge klinikkenes nettsider» with its number");
      assertTrue(intro.includes("4 oppgir akuttvakt med kilde eller at de tar imot akuttpasienter."), "B5: akutt is worded as the cards show it («akuttvakt med kilde» or «tar imot akuttpasienter») with its number");
      const rows = tableRows(page.text);
      assertEq(rows.map(([k]) => k), [
        "Klinikker totalt", "Med Verifisert-merket",
        "Oppgir Helfo-direkteoppgjør (ifølge klinikkenes nettsider)", "Akuttvakt med kilde eller tar imot akuttpasienter",
        "Med minst én oppført spesialitet", "Sist oppdatert",
      ], "B6: the fact table has the expected rows, Helfo and akutt labelled");
      assertTrue(page.text.includes("Fakta om tannlegeklinikker med poststed Bergen</caption>"), "B6b: the table caption says what it counts");
      assertEq(rows.map(([, v]) => v), ["13", "3", "5", "4", "2", "30. september 2026"], "B7: the table values, «Sist oppdatert» from max_updated_at");

      // The page counts its own list (poststed Bergen); /sok?q=Bergen also
      // reads the rest of Bergen kommune (D3b), here Nesttun 5221. So the
      // page states its own numbers and says «med poststed», never /sok's.
      assertTrue(page.text.includes("13 klinikker registrert"), "B8: the page's own list has the 13 clinics its text states");
      const sokAll = sokCount((await callRoute(router, "/sok?q=Bergen")).text);
      const sokHelfo = sokCount((await callRoute(router, "/sok?q=Bergen&helfo=1")).text);
      const sokAkutt = sokCount((await callRoute(router, "/sok?q=Bergen&akutt=1")).text);
      assertEq([sokAll, sokHelfo, sokAkutt], [14, 6, 5], "B8b: /sok?q=Bergen gives 14 / 6 / 5: the 13 / 5 / 4 with poststed Bergen plus Nesttun in Bergen kommune");
      const bergenQas: Array<{ name: string; acceptedAnswer: { text: string } }> = faqPages(page.text)[0]?.mainEntity ?? [];
      assertTrue(
        bergenQas.length > 0 && bergenQas.every((e) => e.name.includes("tannlegeklinikker") && e.name.includes("poststed Bergen") && !/\btannleger\b/.test(e.name)),
        `B8c: every question asks about tannlegeklinikker with poststed Bergen, as the answers count (${bergenQas.map((e) => e.name).join(" | ")})`
      );
      assertEq(bergenQas[0]?.acceptedAnswer.text, "Vi har 13 tannlegeklinikker med poststed Bergen registrert.", "B8d: the first answer names the scope it counts");

      // FAQ: visible = JSON-LD.
      const faq = faqPages(page.text);
      assertEq(faq.length, 1, "B9: exactly one FAQPage");
      const names: string[] = faq[0].mainEntity.map((e: any) => e.name);
      assertTrue(names.length >= 3 && names.length <= 5, `B10: 3-5 questions (${names.length})`);
      const decode = (s: string): string => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      assertEq(faqQuestions(page.text).map(decode), names, "B11: the visible questions = the FAQPage questions");
      assertTrue(faq[0].mainEntity.every((e: any) => /\d/.test(e.acceptedAnswer.text)), "B12: every answer has a number behind it");
      assertTrue(page.text.includes("5 av 13 klinikker oppgir Helfo-direkteoppgjør ifølge klinikkenes nettsider"), "B13: the Helfo answer carries the wording");
      assertTrue(jsonLdBlocks(page.text).some((b) => b["@type"] === "ItemList") && jsonLdBlocks(page.text).some((b) => b["@type"] === "BreadcrumbList"), "B14: ItemList and BreadcrumbList stay");
      assertTrue(/^index, follow/.test(robotsOf(page.text)), "B15: indexable");

      // No Helfo/akutt statement without a number: a place with neither.
      const oslo = await callRoute(router, "/sted/oslo");
      assertEq(oslo.status, 200, "B16: GET /sted/oslo -> 200");
      assertTrue(introOf(oslo.text).startsWith("Vi har 4 tannlegeklinikker med poststed Oslo i oversikten. 2 av dem oppgir Helfo-direkteoppgjør ifølge klinikkenes nettsider."), "B17: /sted/oslo intro: 4 clinics, 2 Helfo");
      assertTrue(!/akutt/i.test(introOf(oslo.text)) && !tableRows(oslo.text).some(([k]) => /akutt/i.test(k)) && !faqPages(oslo.text).some((f) => /akutt/i.test(JSON.stringify(f))), "B18: Oslo has no akutt claim anywhere (no akutt number)");
      assertEq(faqPages(oslo.text).length, 1, "B19: /sted/oslo passes the gate (4 clinics, 2 facts) -> FAQPage");
    }

    // ── C. /fylke ────────────────────────────────────────────────────────
    {
      const v = await callRoute(router, "/fylke/Vestland");
      assertEq(v.status, 200, "C1: GET /fylke/Vestland -> 200");
      assertTrue(introOf(v.text).startsWith("I Vestland har vi 16 tannlegeklinikker i oversikten. 7 av dem oppgir Helfo-direkteoppgjør ifølge klinikkenes nettsider."), "C2: /fylke/Vestland intro: 16 clinics, 7 Helfo");
      assertEq(tableRows(v.text).map(([, x]) => x).slice(0, 3), ["16", "3", "7"], "C3: the table: 16 / 3 verified / 7 Helfo");
      const sok = sokCount((await callRoute(router, "/sok?fylke=Vestland")).text);
      assertEq(sok, 16, "C4: /sok?fylke=Vestland gives the same 16");
      assertEq(faqPages(v.text)[0]?.mainEntity?.[0]?.name, "Hvor mange tannlegeklinikker finnes det i Vestland?", "C4b: the /fylke FAQ asks about tannlegeklinikker in the fylke");
      assertEq(faqPages(v.text).length, 1, "C5: FAQPage on /fylke/Vestland");
      assertEq(faqQuestions(v.text).map((s) => s.replace(/&amp;/g, "&")), faqPages(v.text)[0].mainEntity.map((e: any) => e.name), "C6: visible = JSON-LD on /fylke too");
      const o = await callRoute(router, "/fylke/Oslo");
      assertEq([o.status, introOf(o.text).startsWith("I Oslo har vi 4 tannlegeklinikker")], [200, true], "C7: GET /fylke/Oslo renders the intro");

      // Page 2 of a paged list repeats neither the table nor the FAQ.
      const p1 = await callRoute(router, "/sted/paged");
      const p2 = await callRoute(router, "/sted/paged?side=2");
      assertTrue(introOf(p1.text) !== "" && tableRows(p1.text).length > 0 && p1.text.includes("landing-faq"), "C8: /sted/paged page 1 has intro, table and FAQ");
      assertTrue(introOf(p2.text) === "" && tableRows(p2.text).length === 0 && !p2.text.includes("landing-faq") && faqPages(p2.text).length === 0, "C9: page 2 has none of them (no duplicate FAQPage)");
    }

    // ── D. the FAQ gate and escaping ─────────────────────────────────────
    {
      const tynn = await callRoute(router, "/sted/tynn");
      assertEq(tynn.status, 200, "D1: /sted/tynn (3 clinics, 1 fact) -> 200");
      assertTrue(tableRows(tynn.text).length > 0 && introOf(tynn.text) !== "", "D2: it still gets intro and table");
      assertTrue(faqPages(tynn.text).length === 0 && !tynn.text.includes("landing-faq"), "D3: one real fact < faq.minFacts: no FAQ, no FAQPage");
      assertTrue(/^index, follow/.test(robotsOf(tynn.text)), "D4: and it is still indexable (the gate never decides indexing)");

      const slug = dentalSeo.slugifyText(evilPlace);
      const evil = await callRoute(router, `/sted/${slug}`);
      assertEq(evil.status, 200, "D5: the markup place has a /sted page");
      const main = evil.text.slice(evil.text.indexOf("<main>"), evil.text.indexOf("</main>"));
      assertTrue(!/<i>/.test(main), "D6: no raw <i> from the place name in the page body");
      assertTrue(introOf(evil.text).includes("&lt;i&gt;") && introOf(evil.text).includes("&amp;co"), "D7: the intro shows the name escaped");
      assertTrue(/&lt;i&gt;/.test(main.slice(main.indexOf("landing-faq"))), "D8: and so does the FAQ");
      assertTrue(faqPages(evil.text).length === 1 && !/<\/script>.*<i>/s.test(evil.text.replace(/<script type="application\/ld\+json">.*?<\/script>/gs, "")), "D9: the FAQPage is script-safe (parses) and no markup leaks outside it");

      // One clinic with an akutt claim is «1 klinikk», in the visible FAQ and in FAQPage alike.
      const one = areaFacts.buildDentalAreaLanding(
        { total: 5, verified: 1, helfo_true: 2, acute_sourced: 1, specialist_clinics: 0, max_updated_at: null },
        { name: "Testby", url: `${base}/sted/testby`, scope: "poststed" }
      );
      const akuttAnswer = (one.faqJsonLd?.mainEntity as any[] | undefined)?.find((e) => /akutt/i.test(e.name))?.acceptedAnswer.text ?? "";
      const oneAkutt = "1 klinikk oppgir akuttvakt med kilde eller at den tar imot akuttpasienter.";
      assertTrue(akuttAnswer.startsWith(oneAkutt) && one.faqHtml.includes(oneAkutt), `D10: one akutt clinic is «1 klinikk … at den» (got «${akuttAnswer.slice(0, 75)}»)`);
      assertTrue(akuttAnswer.includes("116 117") && akuttAnswer.includes("113"), "D10b: the akutt answer points to legevakten (116 117) and to 113 for life-threatening situations");
      const many = areaFacts.buildDentalAreaLanding(
        { total: 5, verified: 1, helfo_true: 2, acute_sourced: 2, specialist_clinics: 0, max_updated_at: null },
        { name: "Testby", url: `${base}/sted/testby`, scope: "poststed" }
      );
      assertTrue(many.faqHtml.includes("2 klinikker oppgir akuttvakt med kilde eller at de tar imot akuttpasienter."), "D11: two are «2 klinikker … at de»");

      // Singular wording: one Helfo clinic among several, and a page with one clinic.
      const oneHelfo = introOf(areaFacts.buildDentalAreaLanding(
        { total: 5, verified: 0, helfo_true: 1, acute_sourced: 0, specialist_clinics: 0, max_updated_at: "2026-05-05 10:00:00" },
        { name: "Testby", url: `${base}/sted/testby`, scope: "poststed" }
      ).introHtml);
      assertTrue(oneHelfo.includes("1 av dem oppgir Helfo-direkteoppgjør ifølge klinikkens nettside."), `D12: one Helfo clinic of five: «ifølge klinikkens nettside» («${oneHelfo}»)`);
      const single = introOf(areaFacts.buildDentalAreaLanding(
        { total: 1, verified: 1, helfo_true: 1, acute_sourced: 1, specialist_clinics: 1, max_updated_at: "2026-05-05 10:00:00" },
        { name: "Solo", url: `${base}/sted/solo`, scope: "poststed" }
      ).introHtml);
      assertTrue(
        single.startsWith("Vi har 1 tannlegeklinikk med poststed Solo i oversikten. Den oppgir Helfo-direkteoppgjør ifølge klinikkens nettside. Den oppgir akuttvakt med kilde eller at den tar imot akuttpasienter.") &&
          !/\b1 av dem\b|\b1 oppgir\b|\b1 har\b/.test(single),
        `D13: a page with one clinic says «Den», never «1 av dem» («${single}»)`
      );
      assertTrue(single.includes("Den har Verifisert-merket hos Finn-tannlege.") && !/registeret/.test(single), "D14: Verifisert is named as the site's mark, not a register entry");

      // SPESTOM: 2 Helfo + 2 staff-only lists. Without a specialist fact it has one fact: no FAQ, no specialty claim.
      const spestom = await callRoute(router, "/sted/spestom");
      const spestomMain = spestom.text.slice(spestom.text.indexOf("<main>"), spestom.text.indexOf("</main>"));
      assertEq(spestom.status, 200, "D15: /sted/spestom -> 200");
      assertTrue(faqPages(spestom.text).length === 0 && !spestom.text.includes("landing-faq"), "D16: staff-only lists are no fact: 1 real fact < faq.minFacts, so no FAQ and no FAQPage");
      assertTrue(!/spesialit|spesialist/i.test(introOf(spestom.text) + JSON.stringify(tableRows(spestom.text))) && !spestomMain.includes("spec-chip"), "D17: no specialty claim in intro or table, and the cards show no specialty chip either");
    }

    // ── E. indexing, decision 7=A ────────────────────────────────────────
    {
      assertEq([0, 1, 2, 4, 5, 100].map((n) => dentalSeo.isDentalStedIndexable(n)), [false, true, true, true, true, true], "E1: isDentalStedIndexable is true exactly when total > 0");

      process.env.DENTAL_STED_MIN_CLINICS_INDEX = "5";
      resetCaches();
      const solo = await callRoute(router, "/sted/solo");
      assertEq(solo.status, 200, "E2: /sted with 1 clinic -> 200");
      assertTrue(/^index, follow/.test(robotsOf(solo.text)), "E3: it is «index, follow» (and an env variable does not change that)");
      assertEq(faqPages(solo.text).length, 0, "E4: and has no FAQPage though it has two facts");
      assertTrue(!solo.text.includes("landing-faq"), "E5: nor a visible FAQ");
      const sm = locs((await callRoute(router, "/sitemap.xml")).text);
      assertTrue(sm.includes(`${base}/sted/solo`) && sm.includes(`${base}/sted/tynn`), "E6: 1- and 3-clinic places are in the sitemap (env variable set)");
      delete process.env.DENTAL_STED_MIN_CLINICS_INDEX;

      const nullsted = await callRoute(router, "/sted/nullsted");
      assertTrue(nullsted.status === 404 || /content="noindex/.test(nullsted.text), "E7: /sted with 0 public clinics is 404 or noindex");
      assertTrue(!sm.includes(`${base}/sted/nullsted`), "E8: and it is not in the sitemap");

      // The route's own 0-branch: the poststed list is cached, the clinics close in between.
      mk("Siste Tann AS", "SISTESTED", "Finnmark", {});
      resetCaches();
      assertEq((await callRoute(router, "/sted/sistested")).status, 200, "E9: SISTESTED has a clinic and a page");
      db.prepare("UPDATE dental_agents SET is_inactive = 1 WHERE poststed = 'SISTESTED'").run();
      const stale = await callRoute(router, "/sted/sistested");
      assertTrue(/content="noindex,follow"/.test(stale.text) || stale.status === 404, "E10: the cached list still names it, total is 0: noindex,follow");
      assertTrue(introOf(stale.text) === "" && tableRows(stale.text).length === 0 && faqPages(stale.text).length === 0, "E11: and no number or FAQ is stated");
      resetCaches();
      const gone = await callRoute(router, "/sted/sistested");
      assertEq(gone.status, 404, "E12: after the list refreshes the page is 404");
      assertTrue(!locs((await callRoute(router, "/sitemap.xml")).text).includes(`${base}/sted/sistested`), "E13: and out of the sitemap");

      // The sitemap lists exactly the places the predicate accepts, one per slug.
      const smNow = locs((await callRoute(router, "/sitemap.xml")).text).filter((l) => l.startsWith(`${base}/sted/`));
      const expected = new Set(store.listPoststeder(1).filter((p) => dentalSeo.isDentalStedIndexable(p.count)).map((p) => `${base}/sted/${dentalSeo.slugifyText(p.poststed)}`));
      assertEq([smNow.length, new Set(smNow).size, smNow.every((l) => expected.has(l))], [expected.size, expected.size, true], "E14: the sitemap's /sted URLs = the places with total > 0, one each");
    }

    // ── G. a cache behind the data states no number ──────────────────────
    {
      resetCaches();
      assertTrue(introOf((await callRoute(router, "/sted/oslo")).text) !== "", "G1: /sted/oslo has its intro while cache and data agree");
      mk("Oslo Ny Tann AS", "OSLO", "Oslo", { helfo: true });
      const behind = await callRoute(router, "/sted/oslo");
      assertEq(behind.status, 200, "G2: the page still renders when the aggregate is one clinic behind");
      assertTrue(behind.text.includes("5 klinikker registrert"), "G3: with the live count (5)");
      assertTrue(introOf(behind.text) === "" && tableRows(behind.text).length === 0 && faqPages(behind.text).length === 0, "G4: but no intro, table or FAQ states the old 4 until the cache catches up");
      resetCaches();
      assertTrue(introOf((await callRoute(router, "/sted/oslo")).text).startsWith("Vi har 5 tannlegeklinikker med poststed Oslo"), "G5: after the refresh it shows 5");
    }

    // ── H. a failing background refresh ──────────────────────────────────
    {
      resetCaches();
      const before = areaFacts.getDentalAreaFacts();
      const realNow = Date.now;
      const realWarn = console.warn;
      const realPrepare = (db as any).prepare;
      const warned: string[] = [];
      try {
        (db as any).prepare = () => { throw new Error("SQLITE_BUSY: database is locked"); };
        console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
        Date.now = () => realNow() + 24 * 60 * 60 * 1000;
        const stale = areaFacts.getDentalAreaFacts();
        await new Promise((r) => setImmediate(r));
        assertTrue(stale === before && areaFacts.getDentalAreaFacts() === before, "H1: while the refresh fails, the old aggregate is served");
        assertTrue(warned.some((w) => w.includes("[dental-area-facts]") && w.includes("SQLITE_BUSY")), `H2: the failure is logged (${JSON.stringify(warned)})`);
        assertTrue(warned.every((w) => !/Bergen|BERGEN|Tann /.test(w)), "H3: the warning carries the message only, no place or clinic");
      } finally {
        Date.now = realNow;
        console.warn = realWarn;
        if (Object.prototype.hasOwnProperty.call(db, "prepare")) delete (db as any).prepare;
        if ((db as any).prepare !== realPrepare) (db as any).prepare = realPrepare;
      }
      resetCaches();
    }

    // ── F. cost ──────────────────────────────────────────────────────────
    {
      // 6,900 public rows over 1,500 poststeder, with akutt provenance/focus
      // mixed in, and a deep-scraped staff list on every fifth row (one in
      // five of those with a specialist title), so the specialty pass is
      // part of the measured cost.
      const insert = db.prepare(
        "INSERT INTO dental_agents (id, org_nr, navn, poststed, fylke, helfo_agreement, acute_vakt, field_provenance, patient_focus, specialists, verification_status, catalog_class, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'klinikk', ?)"
      );
      const SPECIALIST_STAFF = '[{"navn":"Kari","title":"Kjeveortoped"},{"navn":"Ola","title":"Tannlege"},{"navn":"Siri","title":"Tannhelsesekretær"}]';
      db.transaction(() => {
        for (let i = 0; i < 6900; i++) {
          insert.run(
            `bench-${i}`, String(800000000 + i), `Bench Tann ${i} AS`, `STED${i % 1500}`, ["Oslo", "Vestland", "Rogaland", "Agder", "Nordland"][i % 5],
            i % 7 === 0 ? "true" : "unknown", i % 13 === 0 ? 1 : 0,
            i % 26 === 0 ? PROV : null, i % 11 === 0 ? '["Akutt"]' : '["Voksne","Barn"]',
            i % 25 === 0 ? SPECIALIST_STAFF : i % 5 === 0 ? STAFF_ONLY : null,
            i % 5 === 0 ? "verified" : "unverified", `2026-0${(i % 9) + 1}-15 10:00:00`
          );
        }
      })();
      // A coarse regression guard, not a benchmark: best of 5 (the first
      // rounds pay for JIT warm-up, and a GC pause or a busy core can hit any
      // single round) against a bound a loaded runner does not reach. Best
      // of 5 on this thin fixture: 11.7-15.6 ms on an idle 4-core machine,
      // 22.5-23.4 ms on the GitHub CI runner (the old 20 ms bound failed
      // there in all three runs of the determinism gate), at most 66 ms with
      // the cores 2x oversubscribed by busy loops and at most 91 ms at 4x
      // (20 runs each). Realistic rows cost more (code review, round 2:
      // 25-35 ms warm, 55-87 ms cold); in production the event-loop stall
      // probe watches that, not this test. An algorithmic regression in the
      // fold lands at twice the bound even on the idle machine: a linear
      // search per row instead of the Map, or a rescan of all rows per row,
      // takes 297-322 ms. A query per row costs only 23-61 ms here, also
      // through a statement cached per connection, so F4d catches it by
      // counting statement runs, not by the clock. Since F1-S4a (A2A
      // dev-request 2026-10-16-finn-tannlege-fasettsider) the scan also has
      // one column per facet (DENTAL_LANDING_FACETS; a specialty column reads
      // a staff list through nb_lower once per title word): best of 5 on this
      // fixture 29-46 ms, against 17-26 ms without them, on the same idle
      // 4-core machine.
      const times: number[] = [];
      let last: ReturnType<typeof areaFacts.getDentalAreaFacts> | null = null;
      for (let r = 0; r < 5; r++) {
        areaFacts.__resetDentalAreaFactsForTesting();
        const t0 = performance.now();
        last = areaFacts.getDentalAreaFacts();
        times.push(performance.now() - t0);
      }
      const best = Math.min(...times);
      assertTrue(best < 150, `F1: getDentalAreaFacts on ~6,900 rows uncached < 150 ms (best of 5: ${best.toFixed(1)} ms; all: ${times.map((t) => t.toFixed(1)).join(", ")})`);
      assertTrue(last!.byPoststed.size >= 1500, `F2: the aggregate has the 1,500 benchmark poststeder (${last!.byPoststed.size})`);
      const benchSpecialists = [...last!.byPoststed].filter(([k]) => k.startsWith("STED")).reduce((n, [, c]) => n + c.specialist_clinics, 0);
      assertEq(benchSpecialists, 276, "F2b: of the 1,380 benchmark staff lists only the 276 with a specialist title count");
      // A hit is the cached object itself (`same`): a recompute, in the
      // foreground or as a background refresh, would hand out a new one. The
      // time bound only says a hit costs well under a millisecond (a scan
      // costs 12-25 ms, F1): 100 ms per 1,000 hits, best of 3 rounds as in F1.
      // Under tsx a hit takes 10-12 µs; the old single-round 20 ms bound
      // failed at 20-35 ms on a GC pause or a busy core. Every round makes
      // all 1,000 calls, so F3b times hits even when F3 fails.
      let same = true;
      const hitTimes: number[] = [];
      for (let r = 0; r < 3; r++) {
        const t1 = performance.now();
        for (let i = 0; i < 1000; i++) if (areaFacts.getDentalAreaFacts() !== last) same = false;
        hitTimes.push(performance.now() - t1);
      }
      const hitBest = Math.min(...hitTimes);
      assertTrue(same, "F3: 1,000 later calls all return the cached aggregate (the same object)");
      assertTrue(hitBest < 100, `F3b: 1,000 cache hits take under 100 ms (best of 3: ${hitBest.toFixed(1)} ms; all: ${hitTimes.map((t) => t.toFixed(1)).join(", ")})`);

      // One statement per computation, counted rather than timed, on these
      // 6,900 rows. Three counters:
      //   - the handle computeDentalAreaFacts gets counts each statement
      //     prepared on it and each run of one (F4);
      //   - the dental connection counts what is prepared on it, so a
      //     statement prepared behind the handle's back (a store helper with
      //     its own getDb()) shows too;
      //   - better-sqlite3's Statement.prototype, which every statement on
      //     every connection shares, counts each run (all, get, run,
      //     iterate), however and whenever the statement was prepared. A
      //     statement prepared once and cached per connection (as
      //     _specialtyStatements in dental-store.ts does for
      //     getAvailableSpecialties) and then run per row prepares nothing
      //     inside the window, so only this counter sees it (F4d, F5).
      // In F4, F4e and F5 the counters are on only inside synchronous calls,
      // so no other test block can add to them. countOff() in a finally puts
      // every method back.
      const RUN_METHODS = ["all", "get", "run", "iterate"] as const;
      const statementProto: Record<string, unknown> = Object.getPrototypeOf(db.prepare("SELECT 1"));
      const realRuns = RUN_METHODS.map((k) => [k, statementProto[k] as (...args: unknown[]) => unknown] as const);
      const realPrepare = (db as any).prepare;
      /** Prepares on the dental connection, runs on any connection, runs on the dental connection. */
      const tally = { onConnection: 0, runs: 0, runsOnDental: 0 };
      const resetTally = (): void => { tally.onConnection = 0; tally.runs = 0; tally.runsOnDental = 0; };
      const countOn = (): void => {
        (db as any).prepare = function (this: unknown, sql: string) { tally.onConnection++; return realPrepare.call(this, sql); };
        for (const [k, real] of realRuns) {
          statementProto[k] = function (this: { database?: unknown }, ...args: unknown[]) {
            tally.runs++;
            if (this.database === db) tally.runsOnDental++;
            return real.apply(this, args);
          };
        }
      };
      const countOff = (): void => {
        for (const [k, real] of realRuns) statementProto[k] = real;
        if (Object.prototype.hasOwnProperty.call(db, "prepare")) delete (db as any).prepare;
        if ((db as any).prepare !== realPrepare) (db as any).prepare = realPrepare;
      };
      const RUNS = new Set<PropertyKey>(RUN_METHODS);
      const countingHandle = () => {
        const seen = { prepared: [] as string[], runs: 0 };
        const wrapStatement = (stmt: any): any => {
          const proxy: any = new Proxy(stmt, {
            get(target, prop) {
              const v = target[prop];
              if (typeof v !== "function") return v;
              return (...args: unknown[]) => {
                if (RUNS.has(prop)) seen.runs++;
                const out = v.apply(target, args);
                // raw(), pluck() and bind() return the statement: chain on the counted one.
                return out === target ? proxy : out;
              };
            },
          });
          return proxy;
        };
        return { seen, handle: { prepare: (sql: string) => { seen.prepared.push(sql); return wrapStatement(db.prepare(sql)); } } };
      };
      const asJson = (f: ReturnType<typeof areaFacts.getDentalAreaFacts>): string => JSON.stringify([[...f.byPoststed], [...f.byFylke]]);

      const perComputation: Array<[number, number, number]> = [];
      const runsPerComputation: number[] = [];
      let sqls: string[] = [];
      let countedFacts: ReturnType<typeof areaFacts.computeDentalAreaFacts> | null = null;
      countOn();
      try {
        for (let r = 0; r < 3; r++) {
          const { seen, handle } = countingHandle();
          resetTally();
          countedFacts = areaFacts.computeDentalAreaFacts(handle);
          perComputation.push([seen.prepared.length, seen.runs, tally.onConnection]);
          runsPerComputation.push(tally.runs);
          sqls = seen.prepared;
        }
      } finally {
        countOff();
      }
      assertEq(perComputation, [[1, 1, 1], [1, 1, 1], [1, 1, 1]], "F4: each of 3 computations prepares one statement on the handle, runs it once, and prepares nothing else on the connection ([prepared, runs, on connection])");
      assertTrue(sqls.length === 1 && sqls[0]!.startsWith("SELECT poststed, fylke,") && sqls[0]!.includes(" FROM dental_agents WHERE "), "F4b: that statement is the one aggregate SELECT over dental_agents");
      assertTrue(countedFacts !== null && asJson(countedFacts) === asJson(last!), "F4c: the counted computation gives the same aggregate as the uncounted one");
      assertEq(runsPerComputation, [1, 1, 1], "F4d: each computation runs exactly one statement on any connection, however it was prepared (Statement.prototype: all, get, run, iterate)");

      // The run counter itself: a statement prepared before the window (as
      // a per-connection cache holds it) and run three times inside it gives
      // three runs and no prepare; a run on another connection is a run, but
      // not one on the dental connection.
      const preparedBefore = db.prepare("SELECT COUNT(*) AS n FROM dental_agents WHERE poststed = ?");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      const otherConnection = new Database(":memory:");
      const otherStatement = otherConnection.prepare("SELECT 1");
      let probe: number[] = [];
      countOn();
      try {
        resetTally();
        for (const p of ["BERGEN", "OSLO", "SOLO"]) preparedBefore.get(p);
        otherStatement.get();
        probe = [tally.onConnection, tally.runs, tally.runsOnDental];
      } finally {
        countOff();
        otherConnection.close();
      }
      assertEq(probe, [0, 4, 3], "F4e: the counter sees runs of a statement prepared before the window and runs on another connection ([prepared on the dental connection, runs, runs on the dental connection])");

      // The pages' path: getDentalAreaFacts() after a cache reset prepares
      // one statement on the dental connection and runs one statement; a hit
      // prepares and runs none.
      areaFacts.__resetDentalAreaFactsForTesting();
      const onPagePath: Array<[number, number]> = [];
      let hitIsCached = false;
      countOn();
      try {
        resetTally();
        const fresh = areaFacts.getDentalAreaFacts();
        onPagePath.push([tally.onConnection, tally.runs]);
        resetTally();
        hitIsCached = areaFacts.getDentalAreaFacts() === fresh;
        onPagePath.push([tally.onConnection, tally.runs]);
      } finally {
        countOff();
      }
      assertEq([onPagePath, hitIsCached], [[[1, 1], [0, 0]], true], "F5: through getDentalAreaFacts() a computation prepares one statement on the dental connection and runs one statement, a cache hit neither ([[prepared, runs] computation, [prepared, runs] hit], hit cached)");

      // The TTL and the refresh path. Within DENTAL_STATS_TTL_MS a hit
      // starts nothing, not even in the background. Past it, hits get the
      // old aggregate at once and start exactly one background computation,
      // and the next hit gets its result. That computation runs in a later
      // microtask, so here the counter stays on across a setImmediate, and
      // the check reads only the runs on this block's own in-memory dental
      // connection (no other test block holds it). Whatever an earlier check
      // left queued runs first, before the counter is on. The clock is fixed
      // for the whole check; the finally puts it and the counters back and
      // drops the cache.
      const { DENTAL_STATS_TTL_MS } = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");
      const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
      const realNow = Date.now;
      const t0 = realNow();
      let withinTtl: unknown[] = [];
      let pastTtl: unknown[] = [];
      try {
        await tick();
        Date.now = () => t0;
        areaFacts.__resetDentalAreaFactsForTesting();
        const first = areaFacts.getDentalAreaFacts();
        countOn();
        Date.now = () => t0 + DENTAL_STATS_TTL_MS - 1;
        resetTally();
        const hit = areaFacts.getDentalAreaFacts();
        await tick();
        withinTtl = [hit === first, tally.runsOnDental, areaFacts.getDentalAreaFacts() === first];
        Date.now = () => t0 + DENTAL_STATS_TTL_MS;
        resetTally();
        const staleHits = [areaFacts.getDentalAreaFacts(), areaFacts.getDentalAreaFacts()];
        const inCalls = tally.runsOnDental;
        await tick();
        const inBackground = tally.runsOnDental - inCalls;
        const next = areaFacts.getDentalAreaFacts();
        await tick();
        pastTtl = [
          staleHits.every((h) => h === first), inCalls, inBackground,
          next !== first && asJson(next) === asJson(first), tally.runsOnDental - inCalls - inBackground,
        ];
      } finally {
        countOff();
        Date.now = realNow;
        areaFacts.__resetDentalAreaFactsForTesting();
      }
      assertEq(withinTtl, [true, 0, true], "F6: within the TTL a hit is the cached aggregate and runs no statement, not even in the background ([cached, runs by the next macrotask, still cached])");
      assertEq(pastTtl, [true, 0, 1, true, 0], "F7: past the TTL two hits get the old aggregate at once and start exactly one background computation; the next hit gets its result and starts nothing ([old served, runs in the calls, runs in the background, new equal aggregate, runs after])");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental area landing: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevEnvSwitch === undefined) delete process.env.DENTAL_STED_MIN_CLINICS_INDEX;
    else process.env.DENTAL_STED_MIN_CLINICS_INDEX = prevEnvSwitch;
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
  runDentalAreaLandingTests({ log: true }).then((r) => {
    console.log(`\ndental area landing (F1-S3): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
