/**
 * for-tilbydere.test.ts — route-level tests for S4 of dev-request
 * 2026-08-06-opplevagent-ux-loft-drikkested-lansering: the /for-tilbydere
 * provider-onboarding page, its /for-tilbydere/finn search subpage, and the
 * new «For tilbydere» entry in the shared S1 chrome (oaSiteNav()/
 * oaSiteFooter()).
 *
 * Covers:
 *   (a) GET /for-tilbydere → 200 with the three claim steps (finn profilen →
 *       «Er dette din bedrift?» → magisk lenke/Brreg), the owner-edit list,
 *       the «Bekreftet av eier» badge section, and the "already claimed?
 *       Logg inn" section — plus the GET search form → /for-tilbydere/finn.
 *   (b) SEO: /for-tilbydere has canonical + index,follow + JSON-LD and a
 *       static sitemap entry; /for-tilbydere/finn is noindex,follow and NOT
 *       in the sitemap.
 *   (c) robots regression: the claim paths stay Disallow'd in every UA group
 *       (GARDSSALG_ROBOTS_DISALLOWS untouched), and /for-tilbydere itself is
 *       not Disallow'd.
 *   (d) /for-tilbydere/finn?q=: hits link to the claim entry
 *       /kategori/gardssalg/eier/<slug>; catalog_hidden rows never surface;
 *       empty/missing q renders the form + hint (200, no crash); a no-hit q
 *       renders the empty state with the manual-fallback contact.
 *   (e) the «For tilbydere» link renders in oaSiteNav() AND oaSiteFooter()
 *       on the landing page and /kategori/gardssalg (the S1 adopters), with
 *       aria-current="page" on /for-tilbydere itself and nowhere else.
 *   (f) NO + EN strings: the EN landing render shows "For providers"
 *       pointing at the same /for-tilbydere URL (the page is NO-canonical
 *       with no /en variant — same convention as /opplevelser).
 *   (g) dev-request orch-pr-20260818-kontakt-shared-chrome: /kontakt was
 *       migrated onto the shared S1 chrome too, so it now DOES pick up the
 *       «For tilbydere» link in oaSiteNav()/oaSiteFooter() (no more negative
 *       control here — see experiences-seo-site-chrome.test.ts for its full
 *       chrome-migration coverage).
 *
 * Same synthetic invokeRoute harness + in-memory-DB pattern as
 * experiences-seo-gardssalg-typesider.test.ts (S3).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/for-tilbydere.test.ts
 *   2. Wired into the gate: tests/test.ts imports runForTilbydereTests() and
 *      folds its pass/fail counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type InvokeResult = {
  found: boolean;   // the router has a layer for the route path at all
  handled: boolean; // the handler sent a response (false = it next()'d)
  status: number;
  body: string;
  headers: Record<string, string>;
};

// Direct route-layer invocation (the tests/test.ts invokeSeo pattern): finds
// the GET layer whose route.path matches, calls its final handler with a
// synthetic req/res, and reports next() as handled=false. All the handlers
// under test are synchronous (they end in res.send/res.redirect before
// returning), so the result is complete when the call returns. `lang`
// mirrors what the /en rewrite middleware stamps on req in production (the
// landing page is the only bilingual page exercised here).
function invokeRoute(
  router: any,
  routePath: string,
  params: Record<string, string>,
  reqPath: string,
  query: Record<string, string> = {},
  lang: "no" | "en" = "no"
): InvokeResult {
  const layer = (router.stack as any[]).find(
    (l: any) => l.route && l.route.path === routePath && l.route.methods?.get
  );
  if (!layer) return { found: false, handled: false, status: 0, body: "", headers: {} };
  let status = 200;
  let body = "";
  let handled = false;
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); },
    status(code: number) { status = code; this.statusCode = code; return this; },
    send(b: unknown) { handled = true; body = typeof b === "string" ? b : String(b); return this; },
    redirect(code: number, loc: string) {
      handled = true;
      status = code;
      headers["location"] = loc;
      return this;
    },
  };
  const req: any = {
    method: "GET",
    path: reqPath,
    originalUrl: reqPath,
    url: reqPath,
    hostname: "opplevagent.no",
    params,
    query,
    headers: {},
    lang,
    get() { return undefined; },
  };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { /* next() */ });
  return { found: true, handled, status, body, headers };
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    n++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

// Extract the .nav-links block / the .site-footer block so nav and footer
// assertions can't accidentally satisfy each other (same parsing approach as
// experiences-seo-site-chrome.test.ts's navLinkHrefs()).
function navBlock(body: string): string {
  const m = body.match(/<nav class="nav-links"[^>]*>([\s\S]*?)<\/nav>/);
  return m ? m[1] : "";
}
function footerBlock(body: string): string {
  const m = body.match(/<footer class="site-footer"[^>]*>([\s\S]*?)<\/footer>/);
  return m ? m[1] : "";
}

// One raw-SQL provider insert — same column set + slug=id convention as the
// S3 typesider fixture (there is no service-layer setter for producer_type /
// catalog_hidden / rfb_seed_source).
function insertProvider(
  db: any,
  p: {
    id: string;
    navn: string;
    producer_type: string | null;
    catalog_hidden?: number | null;
    rfb_seed_source?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO experience_providers
       (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden,
        rfb_seed_source, lat, lon, geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
     VALUES
       (?, ?, 'experiences', 'Innlandet', 'Ringsaker', 'Brumunddal', ?, NULL, ?,
        ?, 60.88, 10.94, 'high', ?, 'raw', 'pending_verify', 'test-fixture', 'medium')`
  ).run(p.id, p.navn, p.producer_type, p.catalog_hidden ?? null, p.rfb_seed_source ?? null, p.id);
}

export function runForTilbydereTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      require("../services/experience-store");

      // Fixture: 6 visible providers (≥5 → gardssalgVisible(), so the
      // /kategori/gardssalg S1-chrome page renders) + 1 hidden bryggeri that
      // must never surface in /for-tilbydere/finn.
      insertProvider(db, { id: "ft-brygg-1", navn: "Liaberg Bryggeri", producer_type: "bryggeri" });
      insertProvider(db, { id: "ft-brygg-2", navn: "Haugtun Bryggeri", producer_type: "bryggeri" });
      insertProvider(db, { id: "ft-sideri-1", navn: "Eplelund Sideri", producer_type: "sideri" });
      insertProvider(db, { id: "ft-cideri-1", navn: "Hagen Cideri", producer_type: "cideri" });
      insertProvider(db, { id: "ft-mjod-1", navn: "Vollen Mjøderi", producer_type: "mjøderi" });
      insertProvider(db, { id: "ft-null-1", navn: "Seterhagen Gard", producer_type: null, rfb_seed_source: "rfb-seed" });
      insertProvider(db, { id: "ft-hidden-1", navn: "Skjult Bryggeri", producer_type: "bryggeri", catalog_hidden: 1 });

      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = (seo as any).default;

      const page = invokeRoute(router, "/for-tilbydere", {}, "/for-tilbydere");

      // ── (a) content: three steps, badge, login section, search form ────
      assertTrue(page.found && page.handled && page.status === 200, `a1: GET /for-tilbydere renders 200 (got found=${page.found} handled=${page.handled} status=${page.status})`);
      assertTrue(page.body.includes("Finn profilen din"), "a2: step 1 «Finn profilen din» renders");
      assertTrue(page.body.includes("Er dette din bedrift?"), "a3: step 2 references the profile page's «Er dette din bedrift?» button");
      assertTrue(page.body.includes("magisk innloggingslenke") && page.body.includes("Brønnøysundregistrene"), "a4: step 3 explains the email-verified magic link to the Brreg/org-linked address");
      assertTrue(page.body.includes("Bekreftet av eier"), "a5: the «Bekreftet av eier» badge/trust section renders");
      assertTrue(page.body.includes("Allerede tatt eierskap? Logg inn"), "a6: the already-claimed «Logg inn» section renders");
      assertTrue(page.body.includes("Hva du kan redigere som eier"), "a7: the owner-edit section renders");
      assertTrue(/<form action="\/for-tilbydere\/finn" method="GET"/.test(page.body), "a8: the search form is a plain GET form posting to /for-tilbydere/finn");
      // The page EXPLAINS the claim flow — it never embeds/duplicates the
      // claim entry itself (no direct /eier/ link on this static page; those
      // only appear on /finn hits and the profile pages).
      assertTrue(!page.body.includes("/kategori/gardssalg/eier/"), "a9: the static page links no /eier/ claim URL directly (explains, not duplicates)");
      assertTrue(page.body.includes('href="/kategori/gardssalg"'), "a10: the page links into the gardssalg catalog for browsing");

      // ── (b) SEO: canonical + sitemap for /for-tilbydere; noindex /finn ─
      assertTrue(
        page.body.includes('<link rel="canonical" href="https://opplevagent.no/for-tilbydere">'),
        "b1: /for-tilbydere carries its own canonical"
      );
      assertTrue(page.body.includes('<meta name="robots" content="index, follow">'), "b2: /for-tilbydere is index,follow");
      assertTrue(
        page.body.includes('"@type":"WebPage"') && page.body.includes('"@type":"BreadcrumbList"'),
        "b3: /for-tilbydere carries WebPage + BreadcrumbList JSON-LD"
      );
      const sm = invokeRoute(router, "/sitemap.xml", {}, "/sitemap.xml");
      assertTrue(sm.found && sm.handled && sm.status === 200, `b4: sitemap.xml renders 200 (got ${sm.status})`);
      assertTrue(
        sm.body.includes("<loc>https://opplevagent.no/for-tilbydere</loc>"),
        "b5: sitemap lists the static /for-tilbydere entry"
      );
      assertTrue(!sm.body.includes("/for-tilbydere/finn"), "b6: sitemap never lists the noindex /for-tilbydere/finn subpage");

      // ── (c) robots regression: claim paths still Disallow'd, everywhere ─
      const robots = invokeRoute(router, "/robots.txt", {}, "/robots.txt");
      assertTrue(robots.found && robots.handled && robots.status === 200, `c1: robots.txt renders 200 (got ${robots.status})`);
      const eierDisallows = countOccurrences(robots.body, "Disallow: /kategori/gardssalg/eier/");
      const uaGroups = countOccurrences(robots.body, "User-agent: ");
      assertTrue(
        eierDisallows === uaGroups && uaGroups >= 9,
        `c2: every UA group (${uaGroups}) still Disallows the /eier/ claim path (got ${eierDisallows} disallows)`
      );
      assertTrue(
        countOccurrences(robots.body, "Disallow: /kategori/gardssalg/bekreft/") === uaGroups,
        "c3: the /bekreft/ token path stays Disallow'd in every UA group"
      );
      assertTrue(!robots.body.includes("Disallow: /for-tilbydere"), "c4: /for-tilbydere is NOT Disallow'd (covered by Allow: /)");

      // ── (d) /for-tilbydere/finn: hits, hidden-exclusion, empty q ───────
      const finnHit = invokeRoute(router, "/for-tilbydere/finn", {}, "/for-tilbydere/finn", { q: "bryggeri" });
      assertTrue(finnHit.found && finnHit.handled && finnHit.status === 200, `d1: GET /for-tilbydere/finn?q=bryggeri renders 200 (got ${finnHit.status})`);
      assertTrue(
        finnHit.body.includes('href="/kategori/gardssalg/eier/ft-brygg-1"') &&
        finnHit.body.includes('href="/kategori/gardssalg/eier/ft-brygg-2"'),
        "d2: every hit links to the claim entry /kategori/gardssalg/eier/<slug>"
      );
      assertTrue(
        finnHit.body.includes("Liaberg Bryggeri") && finnHit.body.includes("Haugtun Bryggeri"),
        "d3: both visible bryggeri providers render as hits"
      );
      assertTrue(!finnHit.body.includes("Skjult Bryggeri") && !finnHit.body.includes("ft-hidden-1"), "d4: the catalog_hidden=1 row never surfaces in /finn");
      assertTrue(!finnHit.body.includes("Eplelund Sideri"), "d5: non-matching providers don't render for q=bryggeri");
      assertTrue(finnHit.body.includes('<meta name="robots" content="noindex, follow">'), "d6: /for-tilbydere/finn is noindex,follow");
      assertTrue(!finnHit.body.includes('<link rel="canonical"'), "d7: the noindex /finn page carries no canonical");
      const finnEmpty = invokeRoute(router, "/for-tilbydere/finn", {}, "/for-tilbydere/finn");
      assertTrue(finnEmpty.handled && finnEmpty.status === 200, `d8: missing q renders 200 (no crash — got ${finnEmpty.status})`);
      assertTrue(
        /<form action="\/for-tilbydere\/finn" method="GET"/.test(finnEmpty.body) && finnEmpty.body.includes("Skriv inn bedriftsnavnet"),
        "d9: missing q renders the form + the hint"
      );
      const finnBlank = invokeRoute(router, "/for-tilbydere/finn", {}, "/for-tilbydere/finn", { q: "   " });
      assertTrue(finnBlank.handled && finnBlank.status === 200 && finnBlank.body.includes("Skriv inn bedriftsnavnet"), "d10: whitespace-only q behaves like missing q");
      const finnMiss = invokeRoute(router, "/for-tilbydere/finn", {}, "/for-tilbydere/finn", { q: "zzznotfound" });
      assertTrue(
        finnMiss.handled && finnMiss.status === 200 && finnMiss.body.includes("Ingen treff") && finnMiss.body.includes("kontakt@opplevagent.no"),
        "d11: a no-hit q renders the empty state with the manual-fallback contact"
      );
      // q is the slice's only user-controlled reflection point — pin the
      // escaping so a future regression can't slip through green.
      const xssQ = '"><script>alert(1)</script>';
      const finnXss = invokeRoute(router, "/for-tilbydere/finn", {}, "/for-tilbydere/finn", { q: xssQ });
      assertTrue(finnXss.handled && finnXss.status === 200, `d12: an XSS-payload q still renders 200 (got ${finnXss.status})`);
      assertTrue(
        !finnXss.body.includes("<script>alert(1)</script>"),
        "d13: the payload never reaches the body unescaped — no reflected XSS"
      );
      assertTrue(
        finnXss.body.includes('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'),
        "d14: the search field re-echoes q fully entity-escaped in its value attribute"
      );

      // ── (e) nav + footer link on the S1-chrome adopters ────────────────
      const home = invokeRoute(router, "/", {}, "/");
      const gard = invokeRoute(router, "/kategori/gardssalg", {}, "/kategori/gardssalg");
      assertTrue(home.handled && home.status === 200, `e1: GET / renders 200 (got ${home.status})`);
      assertTrue(gard.handled && gard.status === 200, `e2: GET /kategori/gardssalg renders 200 (got ${gard.status})`);
      for (const [name, p] of [["home", home], ["gardssalg", gard], ["for-tilbydere", page]] as const) {
        assertTrue(navBlock(p.body).includes('href="/for-tilbydere"'), `e3-${name}: oaSiteNav() on ${name} carries the /for-tilbydere link`);
        assertTrue(footerBlock(p.body).includes('href="/for-tilbydere"'), `e4-${name}: oaSiteFooter() on ${name} carries the /for-tilbydere link`);
      }
      assertTrue(
        /<a href="\/for-tilbydere" aria-current="page">/.test(page.body),
        "e5: /for-tilbydere marks its own nav link aria-current=\"page\""
      );
      for (const [name, p] of [["home", home], ["gardssalg", gard]] as const) {
        assertTrue(
          !/<a href="\/for-tilbydere" aria-current="page">/.test(p.body),
          `e6-${name}: ${name} does NOT mark the For-tilbydere nav link current`
        );
      }
      // The /finn subpage wears the same chrome with the same active state.
      assertTrue(
        /<a href="\/for-tilbydere" aria-current="page">/.test(finnEmpty.body),
        "e7: /for-tilbydere/finn also marks the For-tilbydere nav link current"
      );

      // ── (f) NO + EN strings ────────────────────────────────────────────
      assertTrue(
        /<a href="\/for-tilbydere"[^>]*>For tilbydere<\/a>/.test(home.body),
        "f1: the Norwegian render labels the link «For tilbydere»"
      );
      const homeEn = invokeRoute(router, "/", {}, "/", {}, "en");
      assertTrue(homeEn.handled && homeEn.status === 200, `f2: GET / with req.lang="en" renders 200 (got ${homeEn.status})`);
      assertTrue(
        /<a href="\/for-tilbydere"[^>]*>For providers<\/a>/.test(homeEn.body),
        "f3: the EN render labels the link \"For providers\", pointing at the same NO-canonical /for-tilbydere URL"
      );
      assertTrue(!homeEn.body.includes(">For tilbydere<"), "f4: the Norwegian label doesn't leak into the EN render");

      // ── (g) /kontakt: migrated onto the shared S1 chrome (dev-request
      // orch-pr-20260818-kontakt-shared-chrome) — it now renders oaSiteNav()/
      // oaSiteFooter() same as every other adopter, so the «For tilbydere»
      // link DOES appear (no longer a negative control; full chrome-migration
      // coverage for /kontakt lives in experiences-seo-site-chrome.test.ts).
      const kontakt = invokeRoute(router, "/kontakt", {}, "/kontakt");
      assertTrue(kontakt.handled && kontakt.status === 200, `g1: GET /kontakt renders 200 (got ${kontakt.status})`);
      assertTrue(
        kontakt.body.includes('href="/for-tilbydere"'),
        "g2: /kontakt now renders the shared chrome, which includes the For-tilbydere link"
      );
    } catch (err: any) {
      failed++;
      failures.push("for-tilbydere: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runForTilbydereTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    // Explicit exit either way: loading the seo module leaves live handles
    // behind, so a green run would otherwise hang the standalone runner.
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
