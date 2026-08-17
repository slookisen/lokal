/**
 * experiences-seo-produsent-render-guards.test.ts — route-level tests for
 * GET /kategori/gardssalg/produsent/:providerSlug (src/routes/experiences-seo.ts),
 * arbeidspunkt 5 of dev-request 2026-07-19-opplevagent-forside-seksjoner-design:
 * three template render-guards so the page never renders obviously-broken
 * data, regardless of what's in the DB. Does NOT touch content-quality/
 * enrichment pipelines — pure render-time guards on this one page.
 *
 * Covers:
 *   (a) drivingSted() dedup — adjacent poststed==kommune duplicate collapses
 *       to a single value everywhere sted is derived (hero subtitle,
 *       <title>, meta description, JSON-LD address, map label); the
 *       non-duplicate case and only-one-field-present cases are unaffected.
 *   (b) looksTruncatedMidWord() applied (together with the existing
 *       isJunkDescription()) to opening_hours_text/about_text/visit_text:
 *       a corrupt, cut-mid-word fixture is treated as absent (fact row
 *       omitted / honest fallback copy rendered); normal Norwegian prose in
 *       all three fields renders verbatim.
 *   (c) the reserve-CTA renders the active amber/coral class + "Reserver
 *       besøk" label when booking is NOT paused, and the new muted
 *       .reserve-cta-paused class + "Meld interesse" label when it IS
 *       paused — id="reserve-cta" present in both cases (the owner-swap
 *       script's hook must survive either state).
 *   (i) 2026-08-17 P0 consent-bug fix: catalog_hidden=1 makes the profile
 *       page 404 by slug (falls through to next()), not just disappear from
 *       the grid — see getGardssalgProviderBySlug()'s doc comment in
 *       services/experience-store.ts.
 *
 * Same synthetic router.handle() harness + in-memory-DB pattern as
 * experiences-seo-gardssalg-claimed-badge.test.ts /
 * experiences-seo-gardssalg-booking-ikke-aktivert.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-produsent-render-guards.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoProdusentRenderGuardsTests() and folds its
 *      pass/fail counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as the sibling .test.ts files.
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

// The real live-found corrupt opening_hours_text fixture (paraphrased
// faithfully per the dev-request — cuts mid-word at both ends).
const CORRUPT_TRUNCATED =
  "g håndverk. Bli med på en smaksreise! åPNINGSTIDER … åpent H";

export function runExperiencesSeoProdusentRenderGuardsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevBookingDispatchEnabled = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const bookingStorePath = require.resolve("../services/booking-store");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, bookingStorePath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded by an earlier suite in the same process */ }

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");

      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence,
            about_text, visit_text, opening_hours_text)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @poststed, @producer_type, @booking_live, NULL, 60.63, 6.42,
            'high', @slug, 'raw', 'pending_verify', 'test-fixture', 'medium',
            @about_text, @visit_text, @opening_hours_text)`,
      );

      const normalAbout =
        "Vi er en liten familiedrevet sideri på Vestlandet og har laget sider av egne epler siden 2015.";
      const normalVisit =
        "Et besøk hos oss starter med en kort omvisning i frukthagen, etterfulgt av en smaking av våre sider på gårdstunet.";
      const normalHours = "Åpent lørdager kl. 11-16 i sesong, ellers etter avtale.";

      // ── (a) drivingSted() dedup fixtures ─────────────────────────────────
      insertProvider.run({
        id: "gs-rg-dup", navn: "Dupligård Bryggeri", producer_type: "bryggeri",
        booking_live: 1, slug: "dupligard-bryggeri",
        fylke: "Innlandet", kommune: "Stange", poststed: "Stange",
        about_text: null, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "gs-rg-nodup", navn: "Ikkedupligård Cideri", producer_type: "cideri",
        booking_live: 1, slug: "ikkedupligard-cideri",
        fylke: "Telemark", kommune: "Bø", poststed: "Skien",
        about_text: null, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "gs-rg-kommune-only", navn: "Kunkommunegård Vingård", producer_type: "vingård",
        booking_live: 1, slug: "kunkommunegard-vingard",
        fylke: null, kommune: "Stange", poststed: null,
        about_text: null, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "gs-rg-poststed-only", navn: "Kunpoststedgård Mjøderi", producer_type: "mjøderi",
        booking_live: 1, slug: "kunpoststedgard-mjoderi",
        fylke: null, kommune: null, poststed: "Stange",
        about_text: null, visit_text: null, opening_hours_text: null,
      });
      // Optional edge case (reviewer note, non-blocking): a null MIDDLE
      // field (kommune) makes two originally-non-adjacent same-value
      // fields (poststed and fylke) become array-adjacent once filter(Boolean)
      // drops the null — the dedup must still correctly collapse them.
      insertProvider.run({
        id: "gs-rg-null-middle-dup", navn: "Mellomhullgård Bryggeri", producer_type: "bryggeri",
        booking_live: 1, slug: "mellomhullgard-bryggeri",
        fylke: "Stange", kommune: null, poststed: "Stange",
        about_text: null, visit_text: null, opening_hours_text: null,
      });

      // ── (b) truncation-guard fixtures ────────────────────────────────────
      insertProvider.run({
        id: "gs-rg-corrupt", navn: "Korruptgård Destilleri", producer_type: "destilleri",
        booking_live: 1, slug: "korruptgard-destilleri",
        fylke: "Vestland", kommune: "Voss", poststed: "Voss",
        about_text: CORRUPT_TRUNCATED, visit_text: CORRUPT_TRUNCATED, opening_hours_text: CORRUPT_TRUNCATED,
      });
      insertProvider.run({
        id: "gs-rg-normal", navn: "Normalgård Sideri", producer_type: "sideri",
        booking_live: 1, slug: "normalgard-sideri",
        fylke: "Vestland", kommune: "Voss", poststed: "Voss",
        about_text: normalAbout, visit_text: normalVisit, opening_hours_text: normalHours,
      });

      // ── (c) reserve-CTA fixtures ──────────────────────────────────────────
      insertProvider.run({
        id: "gs-rg-live-cta", navn: "Aktivgård Seltzeri", producer_type: "seltzeri",
        booking_live: 1, slug: "aktivgard-seltzeri",
        fylke: "Agder", kommune: "Kristiansand", poststed: "Kristiansand",
        about_text: null, visit_text: null, opening_hours_text: null,
      });
      insertProvider.run({
        id: "gs-rg-paused-cta", navn: "Pausetgård Seltzeri", producer_type: "seltzeri",
        booking_live: 0, slug: "pausetgard-seltzeri",
        fylke: "Agder", kommune: "Kristiansand", poststed: "Kristiansand",
        about_text: null, visit_text: null, opening_hours_text: null,
      });

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── (a1) duplicate poststed==kommune collapses ───────────────────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/dupligard-bryggeri");
        assertTrue(r.handled && r.status === 200, `a1: dedup fixture renders (status ${r.status})`);
        assertTrue(!r.body.includes("Stange, Stange"), "a2: 'Stange, Stange' never appears anywhere on the page");
        assertTrue(r.body.includes("Stange, Innlandet"), "a3: sted collapses to 'Stange, Innlandet'");
        assertTrue(r.body.includes("<title>Dupligård Bryggeri – Stange, Innlandet | Opplevagent</title>"), "a4: <title> uses the deduped sted");
        assertTrue(r.body.includes('addressLocality":"Stange"') && !r.body.includes('"Stange, Stange"'), "a5: JSON-LD address is not polluted by the duplicate");
      }

      // ── (a2) non-duplicate case unaffected ────────────────────────────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/ikkedupligard-cideri");
        assertTrue(r.handled && r.status === 200, `b1: non-dup fixture renders (status ${r.status})`);
        assertTrue(r.body.includes("Skien, Bø, Telemark"), "b2: all three distinct values render in order, comma-joined");
      }

      // ── (a3) only-one-field-present cases unaffected ──────────────────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/kunkommunegard-vingard");
        assertTrue(r.handled && r.status === 200, `c1: kommune-only fixture renders (status ${r.status})`);
        assertTrue(r.body.includes(">Stange<"), "c2: single available field ('Stange') renders with no stray comma");
        assertTrue(!r.body.includes("Stange,"), "c3: no trailing comma when only one field is present");
      }
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/kunpoststedgard-mjoderi");
        assertTrue(r.handled && r.status === 200, `d1: poststed-only fixture renders (status ${r.status})`);
        assertTrue(r.body.includes(">Stange<"), "d2: single available field ('Stange') renders with no stray comma");
        assertTrue(!r.body.includes("Stange,"), "d3: no trailing comma when only one field is present");
      }

      // ── (a4) null-middle-field edge case: poststed==fylke become adjacent
      // once the null kommune is filtered out, and must still collapse ──────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/mellomhullgard-bryggeri");
        assertTrue(r.handled && r.status === 200, `a4-1: null-middle-field fixture renders (status ${r.status})`);
        assertTrue(!r.body.includes("Stange, Stange"), "a4-2: 'Stange, Stange' never appears (post-filter adjacency still dedups)");
        assertTrue(r.body.includes(">Stange<"), "a4-3: sted collapses to the single value 'Stange'");
      }

      // ── (b1) corrupt about_text/visit_text/opening_hours_text — guard fires,
      // falls back to honest generic copy / omits the fact row ──────────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/korruptgard-destilleri");
        assertTrue(r.handled && r.status === 200, `e1: corrupt fixture renders (status ${r.status})`);
        assertTrue(!r.body.includes(CORRUPT_TRUNCATED), "e2: the raw corrupt string never appears anywhere on the page");
        assertTrue(!r.body.includes("Åpningstider"), "e3: the 'Åpningstider' fact row is omitted entirely when opening_hours_text is corrupt");
        assertTrue(
          r.body.includes("Utfyllende presentasjon publiseres fortløpende") || r.body.includes("Les mer om produsenten"),
          "e4: aboutBody falls back to the existing honest fallback copy",
        );
        assertTrue(
          r.body.includes("Detaljer om hva besøket hos") || r.body.includes("inkluderer typisk"),
          "e5: visitBody falls back to the existing honest fallback copy",
        );
      }

      // ── (b2) normal Norwegian prose in all three fields renders verbatim ──
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/normalgard-sideri");
        assertTrue(r.handled && r.status === 200, `f1: normal-prose fixture renders (status ${r.status})`);
        assertTrue(r.body.includes(normalAbout), "f2: real about_text renders verbatim (guard does not false-positive)");
        assertTrue(r.body.includes(normalVisit), "f3: real visit_text renders verbatim (guard does not false-positive)");
        assertTrue(r.body.includes(normalHours), "f4: real opening_hours_text renders verbatim (guard does not false-positive)");
        assertTrue(r.body.includes("Åpningstider"), "f5: the 'Åpningstider' fact row IS present for a real value");
      }

      // ── (c1) NOT paused — active class + label ────────────────────────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/aktivgard-seltzeri");
        assertTrue(r.handled && r.status === 200, `g1: live-CTA fixture renders (status ${r.status})`);
        assertTrue(r.body.includes('id="reserve-cta" class="reserve-cta"'), "g2: active state uses the amber/coral .reserve-cta class");
        assertTrue(r.body.includes(">Reserver besøk<"), "g3: active state keeps the 'Reserver besøk' label");
        assertTrue(!r.body.includes('class="reserve-cta-paused"'), "g4: the paused class is not applied to the CTA anchor when booking is live (the CSS rule itself may still be present in <style>)");
      }

      // ── (c2) paused — muted class + 'Meld interesse' label ────────────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/pausetgard-seltzeri");
        assertTrue(r.handled && r.status === 200, `h1: paused-CTA fixture renders (status ${r.status})`);
        assertTrue(r.body.includes('id="reserve-cta" class="reserve-cta-paused"'), "h2: paused state uses the new neutral .reserve-cta-paused class");
        assertTrue(r.body.includes(">Meld interesse<"), "h3: paused state uses the 'Meld interesse' label, not 'Reserver besøk'");
        assertTrue(!r.body.includes(">Reserver besøk<"), "h4: the active label does not also appear");
        assertTrue(r.body.includes('id="reserve-cta"'), "h5: id=\"reserve-cta\" is still present (owner-swap script hook)");
      }

      // ── (i) catalog_hidden=1 → 404 by slug (2026-08-17 P0 consent-bug fix)
      // — a delisted producer's profile page must be gone, not just absent
      // from the grid. Own raw insert (not the shared insertProvider() above,
      // which hardcodes catalog_hidden NULL) so this doesn't touch the other
      // fixtures' shape. ─────────────────────────────────────────────────────
      {
        db.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
              geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
           VALUES
             ('gs-rg-hidden', 'Skjultgård Bryggeri', 'experiences', 'Agder', 'Kristiansand', 'Kristiansand', 'bryggeri', 1, 1, 60.63, 6.42,
              'high', 'skjultgard-bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
        ).run();
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/skjultgard-bryggeri");
        // The route itself next()'s (see the source), but this router has its
        // own catch-all that renders a real 404 page for it — same observable
        // shape as experiences-seo-site-chrome.test.ts's j1 (unknown path).
        assertTrue(r.handled && r.status === 404, `i1: catalog_hidden=1 provider's profile page 404s (status ${r.status})`);
        // Sanity check: the SAME slug, visible (catalog_hidden reset to NULL),
        // renders normally — proves i1 is about catalog_hidden, not a fixture
        // typo/column-name mistake.
        db.prepare(`UPDATE experience_providers SET catalog_hidden = NULL WHERE id = 'gs-rg-hidden'`).run();
        const r2 = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/skjultgard-bryggeri");
        assertTrue(r2.handled && r2.status === 200, `i2: sanity check — the same slug renders 200 once catalog_hidden is cleared (status ${r2.status})`);
      }

      return { passed, failed, failures };
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-produsent-render-guards: unexpected error: " + String(err?.stack || err?.message || err));
      return { passed, failed, failures };
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevBookingDispatchEnabled === undefined) delete process.env.BOOKING_DISPATCH_ENABLED;
      else process.env.BOOKING_DISPATCH_ENABLED = prevBookingDispatchEnabled;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }
  })();
}

if (require.main === module) {
  runExperiencesSeoProdusentRenderGuardsTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
