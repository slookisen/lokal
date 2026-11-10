/**
 * dental-kommune-pages.test.ts -- A2A dev-request
 * 2026-10-16-finn-tannlege-fasettsider, slice F1-S5: /kommune/<slug>
 * (alternative A: read-time from the postnummer table, no DB writes).
 *
 *   M  mapping: every postnummer 1300-1369 in the table is Bærum (3201),
 *      and Bærum's postnumre all lie in 1300-1369; the aggregate puts
 *      Sandvika (1337) and Bekkestua (1357) clinics in Bærum.
 *   C  canonical rule (Daniel, q23): /kommune/baerum is 200 and lists every
 *      poststed of Bærum; a kommune whose clinic ids are exactly one /sted
 *      page's is a 301 to that page; a kommune with the same COUNT as a
 *      /sted page but other clinics is 200; a kommune whose /sted page has a
 *      clinic from a neighbour kommune is 200; an unknown slug and a kommune
 *      without a clinic are 404; the page says «etter postnummer».
 *   P  gate/sitemap parity: the sitemap lists /kommune/<slug> exactly for
 *      the kommuner the route answers 200 for; a redirecting kommune is not
 *      in it, its /sted page is.
 *
 * Same harness as dental-area-landing.test.ts (in-memory dental DB, the
 * router driven through router.handle()).
 *
 * Standalone: npx tsx src/routes/dental-kommune-pages.test.ts
 * Wired into tests/test.ts via runDentalKommunePagesTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  text: string;
  location?: string;
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
      redirect(code: number, location: string) { resolve({ status: code, text: "", location }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, text: String(payload ?? "") }); return this; },
      json(payload: any) { resolve({ status: this.statusCode, text: JSON.stringify(payload) }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, text: err ? String(err) : "unhandled" }));
  });
}

const locs = (xml: string): string[] => Array.from(xml.matchAll(/<loc>([^<]*)<\/loc>/g), (m) => m[1]!);
const robotsOf = (html: string): string => (html.match(/<meta name="robots" content="([^"]*)">/) || [])[1] ?? "";

export async function runDentalKommunePagesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-area-facts"),
    require.resolve("./dental-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    // ── M: mapping (static data, no DB) ──────────────────────────────────
    const pn = require("../services/norway-postnummer") as typeof import("../services/norway-postnummer");
    const resolvedInRange: string[] = [];
    const notBaerum: string[] = [];
    for (let n = 1300; n <= 1369; n++) {
      const r = pn.resolveKommuneFromPostnummer(String(n));
      if ("kommunenummer" in r) {
        resolvedInRange.push(String(n));
        if (r.kommunenummer !== "3201" || r.kommune !== "Bærum") notBaerum.push(String(n));
      }
    }
    assertTrue(resolvedInRange.length > 20, `M1: the table has postnumre in 1300-1369 (${resolvedInRange.length})`);
    assertEq(notBaerum, [], "M2: every postnummer 1300-1369 in the table maps to Bærum (3201)");
    const baerumPostnumre = pn.postnumreForKommune("3201");
    assertEq(baerumPostnumre.filter((p) => Number(p) < 1300 || Number(p) > 1369), [], "M3: Bærum's postnumre all lie in 1300-1369");
    assertEq(baerumPostnumre, resolvedInRange, "M4: postnumreForKommune(3201) is exactly the resolvable postnumre 1300-1369");

    // ── fixture ──────────────────────────────────────────────────────────
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const areaFacts = require("../services/dental-area-facts") as typeof import("../services/dental-area-facts");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const { __resetDentalSearchGazetteerForTesting } = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");
    const router = dentalSeo.default as any;
    const base = process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";
    const resetCaches = (): void => {
      __resetDentalSearchGazetteerForTesting();
      areaFacts.__resetDentalAreaFactsForTesting();
      dentalSeo.__resetDentalSitemapCacheForTesting();
    };

    let orgSeq = 928880000;
    const mk = (navn: string, poststed: string, postnummer: string, fylke: string, x: { rejected?: boolean } = {}): string => {
      const id = store.createDentalAgent({ navn, org_nr: String(++orgSeq), poststed, postnummer, fylke, adresse: "Storgata 1", telefon: "22110099" } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', verification_status = ?, updated_at = '2026-09-01 10:00:00' WHERE id = ?")
        .run(x.rejected ? "rejected" : "unverified", id);
      return id;
    };
    // Bærum: several poststeder (Sandvika 1337 ×2, Bekkestua 1357 ×1) -> own page.
    mk("Sandvika Tann 1 AS", "SANDVIKA", "1337", "Akershus");
    mk("Sandvika Tann 2 AS", "SANDVIKA", "1337", "Akershus");
    mk("Bekkestua Tann AS", "BEKKESTUA", "1357", "Akershus");
    mk("Avvist Bærum AS", "SANDVIKA", "1337", "Akershus", { rejected: true });
    // Gjøvik: one poststed, the same clinics as /sted/gjoevik -> 301.
    mk("Gjøvik Tann 1 AS", "GJØVIK", "2815", "Innlandet");
    mk("Gjøvik Tann 2 AS", "GJØVIK", "2815", "Innlandet");
    // Hamar kommune: 2 clinics with poststed HAMAR; /sted/hamar also lists a
    // clinic with poststed HAMAR in Ringsaker (2380) -> Hamar's clinics
    // deviate -> 200; Ringsaker (only that clinic) deviates too -> 200.
    mk("Hamar Tann 1 AS", "HAMAR", "2317", "Innlandet");
    mk("Hamar Tann 2 AS", "HAMAR", "2317", "Innlandet");
    mk("Hamar Nord Tann AS", "HAMAR", "2380", "Innlandet");
    // Lillehammer kommune: LILLEHAMMER (2609) + FAABERG (2609, other slug),
    // 2 clinics; /sted/lillehammer: 2 clinics too, but one has a postnummer
    // outside the kommune (2390, Ringsaker). Same count, other ids -> 200.
    mk("Lillehammer Tann AS", "LILLEHAMMER", "2609", "Innlandet");
    mk("Faaberg Tann AS", "FAABERG", "2609", "Innlandet");
    mk("Lillehammer Utenfor AS", "LILLEHAMMER", "2390", "Innlandet");
    resetCaches();

    // ── M (aggregate) ────────────────────────────────────────────────────
    const facts = areaFacts.getDentalAreaFacts();
    const baerum = facts.byKommune.get("3201");
    assertEq(baerum?.counts.total, 3, "M5: the aggregate counts Bærum's 3 public clinics (rejected left out)");
    assertEq(baerum ? [...baerum.poststeder.keys()].sort() : null, ["BEKKESTUA", "SANDVIKA"], "M6: Bærum aggregates both its poststeder");
    assertEq(baerum?.postnumre, ["1337", "1357"], "M7: Bærum's store filter is its clinics' stored postnumre");
    assertEq(facts.byKommune.get("3411")?.counts.total, 2, "M8: Ringsaker counts its clinics with poststed HAMAR and LILLEHAMMER by postnummer");

    // ── C: canonical rule ────────────────────────────────────────────────
    const decide = (slug: string) => dentalSeo.resolveDentalKommunePage(slug).kind;
    const b = await callRoute(router, "/kommune/baerum");
    assertEq(b.status, 200, "C1: /kommune/baerum is 200");
    assertTrue(b.text.includes("Sandvika Tann 1 AS") && b.text.includes("Sandvika Tann 2 AS") && b.text.includes("Bekkestua Tann AS"), "C2: /kommune/baerum lists the clinics of every Bærum poststed");
    assertTrue(!b.text.includes("Avvist Bærum AS"), "C3: a rejected clinic is not listed");
    assertTrue(b.text.includes("etter postnummer"), "C4: the page says «etter postnummer»");
    assertTrue(b.text.includes(`<link rel="canonical" href="${base}/kommune/baerum">`), "C5: canonical is the bare /kommune URL");
    assertTrue(b.text.includes("Tannlege i Bærum kommune"), "C6: title/h1 name the kommune");
    assertTrue(b.text.includes('href="/sted/sandvika"') && b.text.includes('href="/sted/bekkestua"'), "C7: the page links its poststeder's /sted pages");
    assertTrue(!robotsOf(b.text).includes("noindex"), "C8: /kommune/baerum is indexable");
    assertEq((await callRoute(router, "/kommune/BAERUM")).status, 200, "C9: the slug is case-insensitive, as on /sted");

    const g = await callRoute(router, "/kommune/gjoevik");
    assertEq([g.status, g.location], [301, "/sted/gjoevik"], "C10: a kommune with exactly the clinics of /sted/gjoevik is a 301 there");
    assertEq((await callRoute(router, "/sted/gjoevik")).status, 200, "C11: the redirect target answers 200");

    assertEq((await callRoute(router, "/kommune/hamar")).status, 200, "C12: Hamar (its /sted page also has a clinic from Ringsaker) is 200");
    assertEq((await callRoute(router, "/kommune/ringsaker")).status, 200, "C13: Ringsaker (clinics deviate from every single /sted) is 200");
    assertEq(decide("lillehammer"), "page", "C14: Lillehammer has the same clinic COUNT as /sted/lillehammer but other ids -> own page, not a redirect");
    assertEq((await callRoute(router, "/kommune/lillehammer")).status, 200, "C15: /kommune/lillehammer is 200");

    const unknown = await callRoute(router, "/kommune/finnes-ikke");
    assertEq(unknown.status, 404, "C16: an unknown kommune slug is 404, as an unknown /sted");
    assertEq((await callRoute(router, "/kommune/tromsoe")).status, 404, "C17: a known kommune without a clinic is 404, as a place without a clinic has no /sted page");
    assertEq(decide("vaaler"), "not_found", "C18: two kommuner named alike have no bare slug");

    // ── P: gate/sitemap parity ───────────────────────────────────────────
    dentalSeo.__resetDentalSitemapCacheForTesting();
    const sm = locs((await callRoute(router, "/sitemap.xml")).text);
    const kommuneLocs = sm.filter((l) => l.startsWith(`${base}/kommune/`)).sort();
    assertEq(kommuneLocs, ["baerum", "hamar", "lillehammer", "ringsaker"].map((s) => `${base}/kommune/${s}`), "P1: the sitemap lists exactly the kommuner with a page of their own");
    assertTrue(!sm.includes(`${base}/kommune/gjoevik`) && sm.includes(`${base}/sted/gjoevik`), "P2: a redirecting kommune is not in the sitemap; its /sted page is");
    for (const loc of kommuneLocs) {
      const r = await callRoute(router, loc.slice(base.length));
      assertEq(r.status, 200, `P3: ${loc} in the sitemap answers 200`);
    }
    const pages = dentalSeo.dentalKommunePages().map((p) => `${base}/kommune/${p.kommune.slug}`).sort();
    assertEq(pages, kommuneLocs, "P4: the sitemap and the route's decision (dentalKommunePages) agree");
  } catch (err: any) {
    failed++;
    failures.push("dental kommune pages: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
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
  runDentalKommunePagesTests({ log: true }).then((r) => {
    console.log(`\ndental kommune pages (F1-S5): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
