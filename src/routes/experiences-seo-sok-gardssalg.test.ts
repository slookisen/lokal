/**
 * experiences-seo-sok-gardssalg.test.ts — route-level tests for /sok's new
 * "Produsenter" section (dev-request 2026-08-01-gardssalg-profilkomplett-
 * og-soekbar-foer-outreach, Steg 1).
 *
 * Background: gårdssalg producers (drink producers in experience_providers)
 * had ZERO presence in /sok's search — a producer's own name typed into the
 * live search box returned "Ingen treff" (12 of 13 outreach candidates,
 * measured 2026-08-01). This wires searchGardssalgProvidersByQuery()
 * (see experience-store-gardssalg-sok.test.ts for its own unit coverage)
 * into GET /sok, rendered as a separate, clearly labeled "Produsenter"
 * section (never merged into the "Opplevelser" experience results) so the
 * dev-request's Funn 2 (producer↔experience duplicate-entity conflicts,
 * e.g. Atlungstad) never get hidden by interleaving.
 *
 * Covers:
 *   (a) GET /sok?q=<producer name> renders the producer's real profile link
 *       (/kategori/gardssalg/produsent/<slug>) under a "Produsenter" label.
 *   (b) a catalog_hidden=1 producer never appears, even matching the query.
 *   (c) the "Produsenter" section is entirely absent when there are zero
 *       producer matches — no empty-state clutter.
 *   (d) regression: an experience-only query (zero producer matches) renders
 *       its "Opplevelser" results identically to before this feature existed
 *       — same rows, no "Produsenter"/"Opplevelser" section labels at all.
 *   (e) when both an experience AND a producer match the same query, both
 *       sections render, "Produsenter" before "Opplevelser".
 *
 * Same synthetic-req/res harness + in-memory-DB pattern as
 * experiences-seo-sok-geo.test.ts / experiences-seo-sok-boost.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-sok-gardssalg.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoSokGardssalgTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as experiences-seo-sok-geo.test.ts.
function callHtmlRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang: "no",
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

export function runExperiencesSeoSokGardssalgTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");

      // ── Fixtures — same raw-insert pattern as
      // opplevelser-gardssalg-rest-discover.test.ts (createProvider() doesn't
      // support producer_type/slug/catalog_hidden). ──────────────────────
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @poststed, @producer_type, @booking_live, @catalog_hidden, @lat, @lon,
            @geocode_confidence, @slug, 'raw', 'pending_verify', 'test-fixture', 'medium')`
      );
      insertProvider.run({
        id: "gs-fossmoen", navn: "Fossmoen Frukt", fylke: "Telemark", kommune: "Skien",
        poststed: "Skien", producer_type: "cideri", booking_live: null, catalog_hidden: null,
        lat: 59.21, lon: 9.61, geocode_confidence: "high", slug: "fossmoen-frukt",
      });
      insertProvider.run({
        id: "gs-hidden", navn: "Skjult Fjellgard", fylke: "Telemark", kommune: "Skien",
        poststed: "Skien", producer_type: "bryggeri", booking_live: null, catalog_hidden: 1,
        lat: 59.22, lon: 9.62, geocode_confidence: "high", slug: "skjult-fjellgard",
      });

      // A published experience whose provider name and text happen to share
      // no tokens with the producer fixtures above, so the two suites' query
      // strings stay cleanly separated.
      const expProvider = expStore.createProvider({
        navn: "Nordlys Opplevelser AS", fylke: "Troms og Finnmark", kommune: "Tromsø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expStore.createExperience({
        title: "Hvalsafari i Tromsø", provider_id: expProvider,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
        verification_status: "verified", confidence: "high",
      });

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── (a) producer name query renders the profile link under
      //     "Produsenter" ─────────────────────────────────────────────
      {
        const r = await callHtmlRoute(seoRouter, "/sok?q=Fossmoen");
        assertTrue(r.handled, "a1: GET /sok?q=Fossmoen is handled");
        assertTrue(r.status === 200, `a2: response status is 200 (got ${r.status})`);
        assertTrue(r.body.includes('<h2 class="sok-section-title">Produsenter</h2>'), "a3: the 'Produsenter' section heading is present");
        assertTrue(r.body.includes("Fossmoen Frukt"), "a4: the producer's name is rendered");
        assertTrue(
          r.body.includes('href="/kategori/gardssalg/produsent/fossmoen-frukt"'),
          "a5: the producer card links to its real profile page (/kategori/gardssalg/produsent/<slug>)"
        );
      }

      // ── (b) catalog_hidden=1 producer never appears ────────────────
      {
        const r = await callHtmlRoute(seoRouter, "/sok?q=Skjult");
        assertTrue(r.status === 200, `b1: GET /sok?q=Skjult renders 200 (got ${r.status})`);
        assertTrue(!r.body.includes("Skjult Fjellgard"), "b2: a catalog_hidden=1 producer is never rendered, even matching the query");
        assertTrue(!r.body.includes('<h2 class="sok-section-title">Produsenter</h2>'), "b3: no 'Produsenter' section heading at all when the only match is hidden");
      }

      // ── (c)+(d) experience-only query — no producer match at all ────
      //     Regression: the "Opplevelser" results must be unaffected, and
      //     no section-label markup should appear (byte-identical to the
      //     pre-Steg-1 single-list rendering for this — the overwhelmingly
      //     common — case).
      {
        const r = await callHtmlRoute(seoRouter, "/sok?q=hvalsafari");
        assertTrue(r.status === 200, `d1: GET /sok?q=hvalsafari renders 200 (got ${r.status})`);
        assertTrue(r.body.includes("Hvalsafari i Tromsø"), "d2: the existing experience result is still present");
        assertTrue(!r.body.includes('<h2 class="sok-section-title">Produsenter</h2>'), "d3: no 'Produsenter' section heading for an experience-only query");
        assertTrue(!r.body.includes("Fossmoen Frukt") && !r.body.includes("Skjult Fjellgard"),
          "d4: no producer rows leak into an unrelated experience query");
        assertTrue(!r.body.includes('<h2 class="sok-section-title">Opplevelser</h2>'),
          "d5: no 'Opplevelser' section label is added when there's no producer section (byte-identical experience-only rendering)");
      }

      // ── (e) both an experience and a producer match the same query:
      //     both sections render, Produsenter before Opplevelser ────────
      {
        const r = await callHtmlRoute(seoRouter, "/sok?q=Skien");
        assertTrue(r.status === 200, `e1: GET /sok?q=Skien renders 200 (got ${r.status})`);
        assertTrue(r.body.includes("Fossmoen Frukt"), "e2: the producer (kommune=Skien) matches");
        assertTrue(r.body.includes('<h2 class="sok-section-title">Produsenter</h2>'), "e3: 'Produsenter' section heading present");
        const idxProdusenter = r.body.indexOf('<h2 class="sok-section-title">Produsenter</h2>');
        const idxOpplevelser = r.body.indexOf('<h2 class="sok-section-title">Opplevelser</h2>');
        assertTrue(idxProdusenter >= 0 && idxOpplevelser >= 0 && idxProdusenter < idxOpplevelser,
          `e4: 'Produsenter' section renders BEFORE the 'Opplevelser' label (indices ${idxProdusenter}, ${idxOpplevelser})`);
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-sok-gardssalg: unexpected error: " + String(err?.stack || err?.message || err));
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
  runExperiencesSeoSokGardssalgTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
