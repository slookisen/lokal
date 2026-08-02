/**
 * opplevelser-gardssalg-outreach-preflight.test.ts — tests for
 * POST /admin/gardssalg-outreach-preflight (src/routes/opplevelser.ts), added
 * for dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-
 * outreach, Steg 5: given a caller-supplied batch of provider ids, answer
 * GO/NO-GO per id for an outreach campaign, using EXACTLY the same tiering
 * logic (computeGardssalgReadinessRows / computeGardssalgReadinessTier) as
 * GET /admin/gardssalg-outreach-readiness — never a second, divergently-
 * maintained copy.
 *
 * Mirrors opplevelser-gardssalg-outreach-readiness.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly with
 * X-Admin-Key via headers — this repo's convention, no HTTP server /
 * supertest needed) and reuses the SAME one-fixture-per-tier set (8 tiers:
 * outreach_ready, needs_enrichment, no_website, unreachable, skjult,
 * ikke_soekbar, nettsted_uverifisert, dublettkonflikt).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key, 403 with wrong X-Admin-Key
 *   (b) GO case: outreach_ready fixture -> go:true, reason:null
 *   (c) NO-GO case for each of the other 7 tiers -> go:false, reason:<tier>
 *   (d) ikke_funnet for a nonexistent id mixed into a batch with real ids —
 *       does not affect the other rows' results
 *   (e) duplicate ids in the request -> deduped, appears once in results, in
 *       first-seen order
 *   (f) validation: missing/empty/non-array provider_ids -> 400
 *   (g) validation: >200 ids -> 400
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "POST",
      url: "/admin/gardssalg-outreach-preflight",
      originalUrl: "/admin/gardssalg-outreach-preflight",
      path: "/admin/gardssalg-outreach-preflight",
      query: {},
      headers,
      body: opts.body,
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgOutreachPreflightTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

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
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-outreach-preflight-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, about_text, visit_text, opening_hours_text,
            products, content_source, booking_live, catalog_hidden, slug, field_provenance,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, @rfb_seed_source, @producer_type,
            @epost, @telefon, @hjemmeside, @about_text, @visit_text, @opening_hours_text,
            @products, @content_source, @booking_live, @catalog_hidden, @slug, @field_provenance,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      // Same "provider_link" dublettkonflikt trigger as the readiness test —
      // a minimal `experiences` row whose booking_url registrable domain
      // does NOT match the producer's hjemmeside domain.
      const insertExperience = expDb.prepare(
        `INSERT INTO experiences (id, provider_id, title, booking_url, verification_status)
         VALUES (@id, @provider_id, @title, @booking_url, 'pending_verify')`,
      );
      const VERIFIED_PROVENANCE = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-01T00:00:00.000Z" },
      });

      // ── one fixture per readiness_tier (same shapes as the readiness
      // report test — kept in sync deliberately, since both exercise the
      // SAME computeGardssalgReadinessRows/computeGardssalgReadinessTier) ──
      process.env.BOOKING_DISPATCH_ENABLED = "true";
      insertProvider.run({
        id: "prov-ready", navn: "Klar Gård AS", org_nr: "111111111", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@klargard.no", telefon: null, hjemmeside: "https://klargard.no",
        about_text: "Om gården.", visit_text: "Besøksinfo.", opening_hours_text: "Ma-Fr 10-16",
        products: "Sider, cider", content_source: "provider_site",
        booking_live: 1, catalog_hidden: 0, slug: "klar-gard-as", field_provenance: VERIFIED_PROVENANCE,
      });
      insertProvider.run({
        id: "prov-enrich", navn: "Under Arbeid Gård", org_nr: "222222222", kommune: "Ulvik",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@underarbeid.no", telefon: null, hjemmeside: "https://underarbeid.no",
        about_text: null, visit_text: null, opening_hours_text: null,
        products: null, content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
      });
      insertProvider.run({
        id: "prov-noweb", navn: "Ingen Nettside Gård", org_nr: "333333333", kommune: "Aurland",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: "98765432", hjemmeside: null,
        about_text: null, visit_text: null, opening_hours_text: null,
        products: null, content_source: null,
        booking_live: null, catalog_hidden: null, slug: null, field_provenance: null,
      });
      insertProvider.run({
        id: "prov-unreach", navn: "Utilgjengelig Gård", org_nr: "444444444", kommune: "Lærdal",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: "https://utilgjengelig.no",
        about_text: "Om gården.", visit_text: "Besøksinfo.", opening_hours_text: "Lø 10-14",
        products: "Eplemost", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
      });
      insertProvider.run({
        id: "prov-hidden", navn: "Skjult Test Gård", org_nr: "555555555", kommune: "Voss",
        rfb_seed_source: null, producer_type: "test-gardssalg",
        epost: "post@skjult.no", telefon: "12312312", hjemmeside: "https://skjult.no",
        about_text: "Om gården.", visit_text: "Besøksinfo.", opening_hours_text: "Alle dager",
        products: "Sider", content_source: "provider_site",
        booking_live: 1, catalog_hidden: 1, slug: "skjult-test-gard", field_provenance: VERIFIED_PROVENANCE,
      });
      insertProvider.run({
        id: "prov-claimed", navn: "Krevd Gård AS", org_nr: "666666666", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "eier@krevdgard.no", telefon: "45454545", hjemmeside: "https://krevdgard.no",
        about_text: "Skrevet av eier selv.", visit_text: "Kom innom!", opening_hours_text: "Lø-Sø 11-15",
        products: "Eplevin", content_source: "manual",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
      });
      insertProvider.run({
        id: "prov-unverified", navn: "Uverifisert Gård AS", org_nr: "888888888", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@uverifisertgard.no", telefon: null, hjemmeside: "https://uverifisertgard.no",
        about_text: "Om gården.", visit_text: "Besøksinfo.", opening_hours_text: "Ti-Lø 10-17",
        products: "Most", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "uverifisert-gard", field_provenance: null,
      });
      insertProvider.run({
        id: "prov-conflict", navn: "Konflikt Gård AS", org_nr: "999999999", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@konfliktgard.no", telefon: null, hjemmeside: "https://konfliktgard.no",
        about_text: "Om gården.", visit_text: "Besøksinfo.", opening_hours_text: "Ma-Fr 09-16",
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "konflikt-gard", field_provenance: VERIFIED_PROVENANCE,
      });
      insertExperience.run({
        id: "exp-konflikt-gard", provider_id: "prov-conflict",
        title: "Konflikt Gård — gårdsbesøk og smaking",
        booking_url: "https://uenighetsbutikk.no/produkt",
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) auth gate ────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { body: { provider_ids: ["prov-ready"] } });
      assertEq(noKey.status, 403, "a1: POST /admin/gardssalg-outreach-preflight without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.results, "a2: no-key response carries no preflight payload");

      const badKey = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": "wrong-key" },
        body: { provider_ids: ["prov-ready"] },
      });
      assertEq(badKey.status, 403, "a3: POST /admin/gardssalg-outreach-preflight with wrong X-Admin-Key -> 403");

      const authHeaders = { "x-admin-key": testKey };

      // ── (b) GO case ──────────────────────────────────────────────────────
      const go = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: ["prov-ready"] } });
      assertEq(go.status, 200, "b1: single outreach_ready id -> 200");
      assertEq(go.body.results.length, 1, "b2: results has exactly one entry");
      assertEq(go.body.results[0], { provider_id: "prov-ready", name: "Klar Gård AS", go: true, reason: null }, "b3: prov-ready -> go:true, reason:null");
      assertEq(go.body.summary, { go: 1, no_go: 0, total: 1 }, "b4: summary reflects one GO");

      // ── (c) NO-GO case for each of the other 7 tiers ────────────────────
      const NO_GO_CASES: Array<{ id: string; name: string; tier: string }> = [
        { id: "prov-enrich", name: "Under Arbeid Gård", tier: "needs_enrichment" },
        { id: "prov-noweb", name: "Ingen Nettside Gård", tier: "no_website" },
        { id: "prov-unreach", name: "Utilgjengelig Gård", tier: "unreachable" },
        { id: "prov-hidden", name: "Skjult Test Gård", tier: "skjult" },
        { id: "prov-claimed", name: "Krevd Gård AS", tier: "ikke_soekbar" },
        { id: "prov-unverified", name: "Uverifisert Gård AS", tier: "nettsted_uverifisert" },
        { id: "prov-conflict", name: "Konflikt Gård AS", tier: "dublettkonflikt" },
      ];
      const allIds = ["prov-ready", ...NO_GO_CASES.map((c) => c.id)];
      const all = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: allIds } });
      assertEq(all.status, 200, "c0: batch of all 8 tiers -> 200");
      assertEq(all.body.results.length, 8, "c0a: results has 8 entries (one per requested id)");
      for (const c of NO_GO_CASES) {
        const row = (all.body.results as any[]).find((r) => r.provider_id === c.id);
        assertTrue(!!row, `c: ${c.id} present in results`);
        assertEq(row?.go, false, `c: ${c.id} go:false`);
        assertEq(row?.reason, c.tier, `c: ${c.id} reason is '${c.tier}'`);
        assertEq(row?.name, c.name, `c: ${c.id} name passthrough`);
      }
      assertEq(all.body.summary, { go: 1, no_go: 7, total: 8 }, "c-summary: 1 GO + 7 NO-GO of 8 total");

      // ── (d) ikke_funnet mixed with real ids ─────────────────────────────
      const withMissing = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-ready", "prov-does-not-exist", "prov-unreach"] },
      });
      assertEq(withMissing.status, 200, "d1: batch with a nonexistent id -> 200");
      assertEq(withMissing.body.results.length, 3, "d2: results has 3 entries");
      assertEq(
        withMissing.body.results[0],
        { provider_id: "prov-ready", name: "Klar Gård AS", go: true, reason: null },
        "d3: prov-ready unaffected by the missing id in the same batch",
      );
      assertEq(
        withMissing.body.results[1],
        { provider_id: "prov-does-not-exist", name: null, go: false, reason: "ikke_funnet" },
        "d4: nonexistent id -> ikke_funnet",
      );
      assertEq(
        withMissing.body.results[2],
        { provider_id: "prov-unreach", name: "Utilgjengelig Gård", go: false, reason: "unreachable" },
        "d5: prov-unreach unaffected by the missing id in the same batch",
      );
      assertEq(withMissing.body.summary, { go: 1, no_go: 2, total: 3 }, "d6: summary counts the missing id as no_go");

      // ── (e) duplicate ids deduped, first-seen order preserved ───────────
      const withDupes = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_ids: ["prov-ready", "prov-unreach", "prov-ready", "prov-unreach", "prov-ready"] },
      });
      assertEq(withDupes.status, 200, "e1: batch with duplicate ids -> 200");
      assertEq(withDupes.body.results.length, 2, "e2: duplicates collapsed to 2 entries");
      assertEq(withDupes.body.results[0].provider_id, "prov-ready", "e3: first-seen order preserved (prov-ready first)");
      assertEq(withDupes.body.results[1].provider_id, "prov-unreach", "e4: first-seen order preserved (prov-unreach second)");
      assertEq(withDupes.body.summary, { go: 1, no_go: 1, total: 2 }, "e5: summary reflects deduped count, not raw input length");

      // ── (f) validation: missing/empty/non-array provider_ids -> 400 ─────
      const noBody = await callRoute(opplevelserRouter, { headers: authHeaders, body: {} });
      assertEq(noBody.status, 400, "f1: missing provider_ids -> 400");
      assertTrue(typeof noBody.body?.error === "string", "f1a: error message present");

      const emptyArr = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: [] } });
      assertEq(emptyArr.status, 400, "f2: empty array provider_ids -> 400");

      const nonArray = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: "prov-ready" } });
      assertEq(nonArray.status, 400, "f3: non-array provider_ids (a string) -> 400");

      const nonStringEls = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: ["prov-ready", 42] } });
      assertEq(nonStringEls.status, 400, "f4: array with a non-string element -> 400");

      const blankStringEl = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: ["prov-ready", "  "] } });
      assertEq(blankStringEl.status, 400, "f5: array with a blank/whitespace-only string element -> 400");

      // ── (g) validation: >200 ids -> 400 ─────────────────────────────────
      const tooMany = Array.from({ length: 201 }, (_, i) => `prov-bulk-${i}`);
      const overCap = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: tooMany } });
      assertEq(overCap.status, 400, "g1: 201 ids -> 400 (exceeds cap of 200)");

      const atCap = Array.from({ length: 200 }, (_, i) => `prov-bulk-${i}`);
      const atCapResult = await callRoute(opplevelserRouter, { headers: authHeaders, body: { provider_ids: atCap } });
      assertEq(atCapResult.status, 200, "g2: exactly 200 ids -> 200 (at the cap, not over it)");
      assertEq(atCapResult.body.results.length, 200, "g3: all 200 (nonexistent) ids come back as ikke_funnet entries");
      assertEq(atCapResult.body.summary, { go: 0, no_go: 200, total: 200 }, "g4: summary for 200 nonexistent ids is all no_go");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-outreach-preflight: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
      delete process.env.BOOKING_DISPATCH_ENABLED;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-outreach-preflight.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgOutreachPreflightTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
