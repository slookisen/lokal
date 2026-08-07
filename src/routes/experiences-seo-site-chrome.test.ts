/**
 * experiences-seo-site-chrome.test.ts — route-level tests for the shared
 * opplevagent.no site chrome (dev-request
 * 2026-08-06-opplevagent-ux-loft-drikkested-lansering, S1):
 * oaSiteNav()/oaSiteFooter() + the CSS-only hamburger nav, adopted by the
 * landing page ("/") and /kategori/gardssalg in this slice.
 *
 * Covers:
 *   (a) GET / renders the hamburger toggle (id="oa-nav-toggle") + burger
 *       label (class="nav-burger").
 *   (b) GET /kategori/gardssalg is upgraded to the brand nav (brand-word
 *       mark) + the FULL footer (llms.txt + personvern links).
 *   (c) nav-link parity: both pages render the exact same href set inside
 *       .nav-links (the landing page's NO/EN lang-toggle excluded — the
 *       browse page is NO-canonical and deliberately has no toggle).
 *   (d) the chrome CSS contains the `#oa-nav-toggle:checked~.nav-links`
 *       reveal rule, and the old always-hide-below-760px rule
 *       (`.nav-links a:not(.nav-cta){display:none}`) is GONE on both pages.
 *   (e) aria-current="page" lands on the right element per page: the brand
 *       link on "/", the Gårdssalg nav link on /kategori/gardssalg — and
 *       never on the other page's element.
 *   (f) keyboard accessibility: the checkbox is visually hidden via the
 *       clip/clip-path technique, NOT display:none (it must stay focusable
 *       so space toggles the menu without JS), while a min-width:761px rule
 *       removes it from the desktop tab order where the hack is unused.
 *   (g) sibling structure: the checkbox is a SIBLING immediately preceding
 *       the burger label, and precedes .nav-links inside the same
 *       .nav-inner — the `#oa-nav-toggle:checked~.nav-links` selector only
 *       works with that structure (nesting the input inside the label would
 *       silently break the hack while keeping every selector string alive).
 *   (h) EN render (/en → req.lang="en"): lang-toggle back to Norwegian
 *       ("NO") present, and the chrome's anchor links are lang-aware
 *       (/en#kategorier — never the Norwegian-front /#kategorier).
 *
 * Same synthetic-req/res harness + in-memory-DB pattern as
 * experiences-seo-sok-gardssalg.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-site-chrome.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoSiteChromeTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as experiences-seo-sok-gardssalg.test.ts.
// `lang` mirrors what the /en rewrite middleware stamps on req in production.
function callHtmlRoute(router: any, url: string, lang: "no" | "en" = "no"): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, body: String(body) });
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

// Extract the hrefs of the .nav-links block, excluding the NO/EN lang-toggle
// (only the bilingual landing page renders it — parity is over the real
// navigation targets).
function navLinkHrefs(body: string): string[] {
  const navMatch = body.match(/<nav class="nav-links"[^>]*>([\s\S]*?)<\/nav>/);
  if (!navMatch) return [];
  const hrefs: string[] = [];
  const anchorRe = /<a\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(navMatch[1])) !== null) {
    if (m[0].includes('class="lang-toggle"')) continue;
    const href = m[0].match(/href="([^"]+)"/);
    if (href) hrefs.push(href[1]);
  }
  return hrefs.sort();
}

export function runExperiencesSeoSiteChromeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

      // One visible gårdssalg producer so /kategori/gardssalg renders a
      // non-empty grid (the chrome must be present either way — kg-zero in
      // tests/test.ts already covers the zero-producer render).
      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES
           ('gs-chrome', 'Chromegard Sideri', 'experiences', 'Telemark', 'Skien', 'Skien', 'sideri', NULL, NULL, 59.21, 9.61,
            'high', 'chromegard-sideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`
      ).run();

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      const home = await callHtmlRoute(seoRouter, "/");
      const gard = await callHtmlRoute(seoRouter, "/kategori/gardssalg");

      // ── (a) hamburger elements on the landing page ────────────────────
      assertTrue(home.handled && home.status === 200, `a1: GET / renders 200 (got ${home.status})`);
      assertTrue(home.body.includes('id="oa-nav-toggle"'), "a2: landing page has the #oa-nav-toggle checkbox");
      assertTrue(home.body.includes('class="nav-burger"'), "a3: landing page has the .nav-burger label");
      assertTrue(
        /<input type="checkbox" id="oa-nav-toggle" class="nav-toggle">/.test(home.body),
        "a4: the toggle is a real <input type=\"checkbox\"> (pure-CSS hack, no JS dependency)"
      );
      assertTrue(
        /<label for="oa-nav-toggle" class="nav-burger" aria-label="Meny">/.test(home.body),
        "a5: the burger is a <label for=\"oa-nav-toggle\"> with aria-label"
      );

      // ── (b) /kategori/gardssalg upgraded to brand nav + full footer ───
      assertTrue(gard.handled && gard.status === 200, `b1: GET /kategori/gardssalg renders 200 (got ${gard.status})`);
      assertTrue(gard.body.includes('class="brand-word"'), "b2: gardssalg page renders the brand mark (brand-word)");
      assertTrue(gard.body.includes('class="site-footer"'), "b3: gardssalg page has the full .site-footer (not the old mini-footer)");
      assertTrue(gard.body.includes('href="/llms.txt"'), "b4: gardssalg footer links llms.txt");
      assertTrue(gard.body.includes('href="/personvern"'), "b5: gardssalg footer links /personvern");
      assertTrue(gard.body.includes('href="/.well-known/agent-card.json"'), "b6: gardssalg footer links agent-card.json");
      assertTrue(gard.body.includes('id="oa-nav-toggle"'), "b7: gardssalg page also carries the hamburger toggle");

      // ── (c) nav-link parity between the two pages ─────────────────────
      const homeHrefs = navLinkHrefs(home.body);
      const gardHrefs = navLinkHrefs(gard.body);
      assertTrue(homeHrefs.length > 0, "c1: landing page .nav-links parsed to a non-empty href set");
      assertTrue(
        JSON.stringify(homeHrefs) === JSON.stringify(gardHrefs),
        `c2: both pages render the same .nav-links href set (lang-toggle excluded) — got ${JSON.stringify(homeHrefs)} vs ${JSON.stringify(gardHrefs)}`
      );
      for (const expected of ["/opplevelser", "/#kategorier", "/kategori/gardssalg"]) {
        assertTrue(homeHrefs.includes(expected), `c3: nav includes ${expected}`);
      }
      // The lang-toggle stays a landing-page-only affordance (browse pages
      // are NO-canonical) — the exclusion in navLinkHrefs must be real.
      assertTrue(home.body.includes('class="lang-toggle"'), "c4: landing page keeps its NO/EN lang-toggle");
      assertTrue(!gard.body.includes('class="lang-toggle"'), "c5: gardssalg page has no lang-toggle");

      // ── (d) CSS: :checked reveal present, old always-hide rule gone ───
      for (const [name, page] of [["landing", home], ["gardssalg", gard]] as const) {
        assertTrue(
          page.body.includes("#oa-nav-toggle:checked~.nav-links"),
          `d1-${name}: CSS contains the #oa-nav-toggle:checked~.nav-links reveal rule`
        );
        assertTrue(
          !page.body.includes(".nav-links a:not(.nav-cta){display:none}"),
          `d2-${name}: the old unconditional hide-nav-links-below-760px rule is gone`
        );
      }

      // ── (e) aria-current="page" on the right element per page ─────────
      assertTrue(
        /<a class="brand" href="\/"[^>]*aria-current="page">/.test(home.body),
        "e1: landing page marks the brand/home link aria-current=\"page\""
      );
      assertTrue(
        !/<a href="\/kategori\/gardssalg" aria-current="page">/.test(home.body),
        "e2: landing page does NOT mark the Gårdssalg nav link current"
      );
      assertTrue(
        /<a href="\/kategori\/gardssalg" aria-current="page">/.test(gard.body),
        "e3: gardssalg page marks the Gårdssalg nav link aria-current=\"page\""
      );
      assertTrue(
        !/<a class="brand" href="\/"[^>]*aria-current="page">/.test(gard.body),
        "e4: gardssalg page does NOT mark the brand/home link current"
      );

      // ── (f) keyboard: checkbox visually hidden, never display:none ────
      for (const [name, page] of [["landing", home], ["gardssalg", gard]] as const) {
        // First .nav-toggle{…} occurrence is the base (mobile-effective) rule.
        const toggleRule = (page.body.match(/\.nav-toggle\{[^}]*\}/) || [""])[0];
        assertTrue(toggleRule.length > 0, `f1-${name}: a .nav-toggle{…} rule exists`);
        assertTrue(!toggleRule.includes("display:none"), `f2-${name}: base .nav-toggle rule is NOT display:none (stays focusable on mobile)`);
        assertTrue(
          toggleRule.includes("clip:rect(0 0 0 0)") && toggleRule.includes("clip-path:inset(50%)"),
          `f3-${name}: .nav-toggle uses the visually-hidden clip technique`
        );
        assertTrue(
          page.body.includes("@media(min-width:761px){.nav-toggle{display:none}}"),
          `f4-${name}: desktop removes the (there unused) checkbox from the tab order`
        );
      }

      // ── (g) sibling structure of the checkbox hack — the :checked~ selector
      //     only works when input, label and .nav-links are siblings in
      //     .nav-inner with the input first; selector-string checks alone
      //     would survive e.g. moving the checkbox inside the label. ───────
      for (const [name, page] of [["landing", home], ["gardssalg", gard]] as const) {
        const inner = (page.body.match(/<div class="nav-inner">([\s\S]*?)<\/nav>/) || ["", ""])[1];
        const iInput = inner.indexOf('<input type="checkbox" id="oa-nav-toggle"');
        const iLabel = inner.indexOf('<label for="oa-nav-toggle"');
        const iNav = inner.indexOf('<nav class="nav-links"');
        assertTrue(
          iInput >= 0 && iLabel > iInput && iNav > iLabel,
          `g1-${name}: .nav-inner orders input(${iInput}) < label(${iLabel}) < .nav-links(${iNav})`
        );
        assertTrue(
          /<input type="checkbox" id="oa-nav-toggle" class="nav-toggle">\s*<label for="oa-nav-toggle" class="nav-burger"/.test(page.body),
          `g2-${name}: the checkbox IMMEDIATELY precedes the burger label as a sibling (not nested inside it)`
        );
      }

      // ── (h) EN render: lang-toggle + lang-aware anchors ───────────────
      const homeEn = await callHtmlRoute(seoRouter, "/", "en");
      assertTrue(homeEn.handled && homeEn.status === 200, `h1: GET / with req.lang="en" renders 200 (got ${homeEn.status})`);
      assertTrue(
        homeEn.body.includes('class="lang-toggle"') && />NO<\/a>/.test(homeEn.body) && homeEn.body.includes('hreflang="nb"'),
        "h2: EN render keeps the lang-toggle pointing back to Norwegian (NO / hreflang=nb)"
      );
      assertTrue(homeEn.body.includes('href="/en#kategorier"'), "h3: EN nav/footer category anchor is lang-aware (/en#kategorier)");
      assertTrue(homeEn.body.includes('href="/en#slik-funker-det"'), "h4: EN footer how-it-works anchor is lang-aware (/en#slik-funker-det)");
      assertTrue(!homeEn.body.includes('href="/#kategorier"'), "h5: no Norwegian-front /#kategorier anchor leaks into the EN render");
      assertTrue(home.body.includes('href="/#kategorier"'), "h6: the Norwegian render keeps its /#kategorier anchor");
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-site-chrome: unexpected error: " + String(err?.stack || err?.message || err));
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
  runExperiencesSeoSiteChromeTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
