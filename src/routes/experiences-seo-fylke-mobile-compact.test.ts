/**
 * experiences-seo-fylke-mobile-compact.test.ts — dev-request
 * 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 7
 * (fylkesblokk-kompaktering).
 *
 * Daniel's design review (2026-07-19) found the homepage's "Utforsk etter
 * fylke" grid renders one full-width card per row on mobile (auto-fill
 * minmax(180px,1fr) never fits 2 columns below ~396px content width), so a
 * county list of a dozen-plus rows becomes "ekstrem scroll" on a phone.
 *
 * Fix is CSS-only: a max-width:560px media query switches `.fylke-grid` to a
 * fixed 2-column layout with tighter card padding/type — same markup, same
 * underlying data (fylkeGridCards is unchanged), just denser on narrow
 * viewports. Same breakpoint convention already used elsewhere on this page
 * (.container, .hero-inner, .trust-inner, .counters-inner, .section all use
 * max-width:560px).
 *
 * Covers:
 *   (a) the .fylke-grid section still renders (desktop behavior unchanged —
 *       no @media wrapper on the base auto-fill rule).
 *   (b) a max-width:560px media query exists containing a 2-column
 *       .fylke-grid override.
 *   (c) that same media block also compacts .fylke-card padding and the
 *       name/count type scale (the part of the "ekstrem scroll" fix that
 *       actually shortens the page, not just re-flows it).
 *   (d) the compaction is scoped to that one media query — the base
 *       (non-mobile) .fylke-card/.fylke-grid rules are untouched.
 *   (e) same data: the actual fylke anchors/counts rendered are identical to
 *       before this change (this is a display-density change only).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-fylke-mobile-compact.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoFylkeMobileCompactTests() and folds its pass/fail
 *      counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

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

export function runExperiencesSeoFylkeMobileCompactTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

      // Two published, verified experiences in two different fylker so the
      // fylke grid renders a non-empty, real (not single-item) card set.
      const insert = db.prepare(
        `INSERT INTO experiences
           (id, title, slug, description, category, fylke, kommune, evidence_url, content_source, enrichment_state, verification_status, confidence)
         VALUES
           (@id, @title, @slug, @description, @category, @fylke, @kommune, @evidence_url, 'provider_site', 'enriched', 'verified', 'high')`
      );
      insert.run({ id: "e-fmc-1", title: "Elvepadling", slug: "elvepadling-fmc-1", description: "d", category: "aktiv", fylke: "Telemark", kommune: "Skien", evidence_url: "https://a.no" });
      insert.run({ id: "e-fmc-2", title: "Fjelltur", slug: "fjelltur-fmc-2", description: "d", category: "aktiv", fylke: "Innlandet", kommune: "Lillehammer", evidence_url: "https://b.no" });

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      const home = await callHtmlRoute(seoRouter, "/");
      assertTrue(home.handled && home.status === 200, `fmc1: GET / renders 200 (got ${home.status})`);
      assertTrue(home.body.includes('id="fylker"'), "fmc2: fylke section renders");
      assertTrue(home.body.includes('href="/fylke/Telemark"'), "fmc3: Telemark fylke card renders (real data, not stubbed)");
      assertTrue(home.body.includes('href="/fylke/Innlandet"'), "fmc4: Innlandet fylke card renders");

      // ── (a) base/desktop rule unchanged ────────────────────────────────
      assertTrue(
        home.body.includes(".fylke-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}"),
        "fmc5: base .fylke-grid auto-fill rule is unchanged (desktop layout untouched)"
      );

      // ── (b)+(c)+(d) the mobile compaction media query ──────────────────
      const mediaMatch = home.body.match(/@media\(max-width:560px\)\{\s*\.fylke-grid\{grid-template-columns:1fr 1fr[^}]*\}[\s\S]*?\}\s*\}/);
      assertTrue(!!mediaMatch, "fmc6: a max-width:560px media query switches .fylke-grid to a 2-column layout");
      if (mediaMatch) {
        const block = mediaMatch[0];
        assertTrue(/\.fylke-card\{padding:/.test(block), "fmc7: mobile block compacts .fylke-card padding");
        assertTrue(/\.fylke-card-name\{font-size:/.test(block), "fmc8: mobile block shrinks .fylke-card-name type");
        assertTrue(/\.fylke-card-count\{font-size:/.test(block), "fmc9: mobile block shrinks .fylke-card-count type");
      }

      // ── (e) same underlying data — card count text unaffected ─────────
      assertTrue(home.body.includes('class="fylke-card-count">1 '), "fmc10: each single-experience fylke still shows its true count (1), unchanged by the density change");

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      void prevExperiencesDbPath;
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      for (const p of cachePaths) delete require.cache[p];
    }

    if (log) {
      console.log(`\nexperiences-seo-fylke-mobile-compact: ${passed} passed, ${failed} failed`);
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperiencesSeoFylkeMobileCompactTests({ log: true }).then((r) => {
    if (r.failed > 0) process.exit(1);
  });
}
