/**
 * dental-area-landing.test.ts -- dev-request 2026-10-16-finn-tannlege-landingssider,
 * skive F1-S3 (fakta-intro, tabell og FAQ på /sted og /fylke).
 *
 *   A  getDentalAreaFacts(): per poststed and per fylke counts from public
 *      rows only; SQL/JS parity of the sourced-akutt count against
 *      resolveAcuteClaim() on edge-case rows; served from the cache.
 *   B  /sted/bergen: answer-first paragraph (40-60 words, Helfo «ifølge
 *      klinikkenes nettsider», akutt «med kilde»), fact table, visible FAQ =
 *      FAQPage JSON-LD; the numbers equal /sok's counts for the same place.
 *   C  /fylke/Vestland and /fylke/Oslo; page 2 repeats neither FAQ nor table.
 *   D  FAQ gate: thin places (few clinics, few facts) get intro and table but
 *      no FAQ and no FAQPage; escaping of a place name with markup.
 *   E  indexing (decision 7=A): isDentalStedIndexable; /sted with 1 clinic is
 *      200, «index, follow» and in the sitemap, no FAQPage; /sted with 0 is
 *      404 or noindex and not in the sitemap; the route and the sitemap use
 *      the same predicate; no env variable changes the rule.
 *   F  cost: getDentalAreaFacts on a synthetic 6,900-row DB under 20 ms
 *      uncached, a hit comes from the cache.
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
    }
    const mk = (navn: string, poststed: string, fylke: string, x: Extra = {}): string => {
      const org_nr = String(++orgSeq);
      const id = store.createDentalAgent({ navn, org_nr, poststed, fylke, adresse: "Storgata 1", telefon: "22110099" } as any);
      db.prepare(
        "UPDATE dental_agents SET catalog_class = ?, is_inactive = ?, verification_status = ?, helfo_agreement = ?, acute_vakt = ?," +
        " field_provenance = ?, patient_focus = ?, specialists = COALESCE(?, specialists), updated_at = COALESCE(?, updated_at) WHERE id = ?"
      ).run(
        x.klass ?? "klinikk", x.inactive ? 1 : 0,
        x.rejected ? "rejected" : x.verified ? "verified" : "unverified",
        x.helfo ? "true" : "unknown", x.acuteVakt ?? 0,
        x.provenance ?? null, x.focus ?? null, x.specialists ?? null, x.updatedAt ?? null, id
      );
      return id;
    };
    const PROV = '{"acute_vakt":[{"source":"https://example.test/akutt"}]}';

    // Bergen: 12 × BERGEN + 1 × Bergen = 13 public clinics.
    //   helfo 1-5 (5) · verified 1-3 (3) · specialists 7-8 (2)
    //   akutt with a source: 1-2 vakt+provenance, 4-5 patient_focus «akutt» = 4
    //   not counted as akutt: 3 (acute_vakt without provenance), 6 (provenance, acute_vakt = 0)
    for (let i = 1; i <= 12; i++) {
      mk(`Bergen Tann ${i} AS`, "BERGEN", "Vestland", {
        helfo: i <= 5, verified: i <= 3,
        acuteVakt: i <= 3 ? 1 : 0,
        provenance: i <= 2 || i === 6 ? PROV : null,
        focus: i === 4 || i === 5 ? '["Akutte smerter","Voksne"]' : null,
        specialists: i === 7 || i === 8 ? '[{"navn":"Kjeve"}]' : null,
        updatedAt: `2026-0${(i % 9) + 1}-10 10:00:00`,
      });
    }
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
      assertEq([vestland.total, vestland.helfo_true, vestland.acute_sourced], [15, 6, 4], "A3: Vestland = Bergen 13 + Os 2; Helfo 5 + 1");
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
      assertTrue(intro.startsWith("I Bergen har vi 13 tannlegeklinikker i oversikten."), "B2: the paragraph leads with the number of clinics");
      assertTrue(words(intro) >= 40 && words(intro) <= 60, `B3: the paragraph is 40-60 words (${words(intro)})`);
      assertTrue(intro.includes("5 av dem oppgir Helfo-direkteoppgjør ifølge klinikkenes nettsider"), "B4: Helfo is worded «ifølge klinikkenes nettsider» with its number");
      assertTrue(intro.includes("4 oppgir akutt-tilbud med kilde"), "B5: akutt is worded «med kilde» with its number");
      const rows = tableRows(page.text);
      assertEq(rows.map(([k]) => k), [
        "Klinikker totalt", "Med verifisert oppføring",
        "Oppgir Helfo-direkteoppgjør (ifølge klinikkenes nettsider)", "Akutt-tilbud med kilde",
        "Med spesialister eller spesialiteter", "Sist oppdatert",
      ], "B6: the fact table has the expected rows, Helfo and akutt labelled");
      assertEq(rows.map(([, v]) => v), ["13", "3", "5", "4", "2", "30. september 2026"], "B7: the table values, «Sist oppdatert» from max_updated_at");

      // The same numbers /sok gives for the same place.
      const sokAll = sokCount((await callRoute(router, "/sok?q=Bergen")).text);
      const sokHelfo = sokCount((await callRoute(router, "/sok?q=Bergen&helfo=1")).text);
      const sokAkutt = sokCount((await callRoute(router, "/sok?q=Bergen&akutt=1")).text);
      assertEq([sokAll, sokHelfo, sokAkutt], [13, 5, 4], "B8: /sok gives 13 / 5 / 4 for Bergen, the table's numbers");

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
      assertTrue(introOf(oslo.text).startsWith("I Oslo har vi 4 tannlegeklinikker i oversikten. 2 av dem oppgir Helfo-direkteoppgjør ifølge klinikkenes nettsider."), "B17: /sted/oslo intro: 4 clinics, 2 Helfo");
      assertTrue(!/akutt/i.test(introOf(oslo.text)) && !tableRows(oslo.text).some(([k]) => /akutt/i.test(k)) && !faqPages(oslo.text).some((f) => /akutt/i.test(JSON.stringify(f))), "B18: Oslo has no akutt claim anywhere (no akutt number)");
      assertEq(faqPages(oslo.text).length, 1, "B19: /sted/oslo passes the gate (4 clinics, 2 facts) -> FAQPage");
    }

    // ── C. /fylke ────────────────────────────────────────────────────────
    {
      const v = await callRoute(router, "/fylke/Vestland");
      assertEq(v.status, 200, "C1: GET /fylke/Vestland -> 200");
      assertTrue(introOf(v.text).startsWith("I Vestland har vi 15 tannlegeklinikker i oversikten. 6 av dem oppgir Helfo-direkteoppgjør ifølge klinikkenes nettsider."), "C2: /fylke/Vestland intro: 15 clinics, 6 Helfo");
      assertEq(tableRows(v.text).map(([, x]) => x).slice(0, 3), ["15", "3", "6"], "C3: the table: 15 / 3 verified / 6 Helfo");
      const sok = sokCount((await callRoute(router, "/sok?fylke=Vestland")).text);
      assertEq(sok, 15, "C4: /sok?fylke=Vestland gives the same 15");
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
      assertTrue(introOf((await callRoute(router, "/sted/oslo")).text).startsWith("I Oslo har vi 5 tannlegeklinikker"), "G5: after the refresh it shows 5");
    }

    // ── F. cost ──────────────────────────────────────────────────────────
    {
      // 6,900 public rows over 1,500 poststeder, with akutt provenance/focus mixed in.
      const insert = db.prepare(
        "INSERT INTO dental_agents (id, org_nr, navn, poststed, fylke, helfo_agreement, acute_vakt, field_provenance, patient_focus, verification_status, catalog_class, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'klinikk', ?)"
      );
      db.transaction(() => {
        for (let i = 0; i < 6900; i++) {
          insert.run(
            `bench-${i}`, String(800000000 + i), `Bench Tann ${i} AS`, `STED${i % 1500}`, ["Oslo", "Vestland", "Rogaland", "Agder", "Nordland"][i % 5],
            i % 7 === 0 ? "true" : "unknown", i % 13 === 0 ? 1 : 0,
            i % 26 === 0 ? PROV : null, i % 11 === 0 ? '["Akutt"]' : '["Voksne","Barn"]',
            i % 5 === 0 ? "verified" : "unverified", `2026-0${(i % 9) + 1}-15 10:00:00`
          );
        }
      })();
      const times: number[] = [];
      let last: ReturnType<typeof areaFacts.getDentalAreaFacts> | null = null;
      for (let r = 0; r < 3; r++) {
        areaFacts.__resetDentalAreaFactsForTesting();
        const t0 = performance.now();
        last = areaFacts.getDentalAreaFacts();
        times.push(performance.now() - t0);
      }
      const best = Math.min(...times);
      assertTrue(best < 20, `F1: getDentalAreaFacts on ~6,900 rows uncached < 20 ms (best of 3: ${best.toFixed(1)} ms; all: ${times.map((t) => t.toFixed(1)).join(", ")})`);
      assertTrue(last!.byPoststed.size >= 1500, `F2: the aggregate has the 1,500 benchmark poststeder (${last!.byPoststed.size})`);
      const t1 = performance.now();
      let same = true;
      for (let i = 0; i < 1000; i++) same = same && areaFacts.getDentalAreaFacts() === last;
      const hitMs = performance.now() - t1;
      assertTrue(same && hitMs < 20, `F3: 1,000 later calls all return the cached aggregate (${hitMs.toFixed(1)} ms)`);
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
