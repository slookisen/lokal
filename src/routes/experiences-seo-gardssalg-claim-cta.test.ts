/**
 * experiences-seo-gardssalg-claim-cta.test.ts — route-level tests for the
 * "Driver du dette stedet?" claim-CTA aside-card on the gårdssalg producer
 * profile page (GET /kategori/gardssalg/produsent/:providerSlug,
 * src/routes/experiences-seo.ts), dev-request 2026-07-30-opplevagent-claim-
 * epost-og-perfelt-laas, item 4 ("CTA hide").
 *
 * Mirrors RFB's seo.ts `!isClaimed` gate (knowledgeService.isAgentClaimed(),
 * consumed around seo.ts:4246-4248/5144) — the gårdssalg-side equivalent is
 * isGardssalgProviderClaimed() (src/services/gardssalg-claim.ts), which is a
 * live (uncached) COUNT(*) over gardssalg_claims WHERE provider_id = ? AND
 * used = 1 AND revoked_at IS NULL.
 *
 * Covers:
 *   (a) a provider with a used, non-revoked gardssalg_claims row — the CTA
 *       card is ABSENT.
 *   (b) a provider with no claim row at all — the CTA card is PRESENT
 *       (unclaimed providers keep showing it).
 *   (c) a provider with only a REVOKED claim row (used=1, revoked_at set) —
 *       must NOT count as claimed — the CTA card is PRESENT (mirrors the
 *       "revoke -> card reappears" acceptance criterion, since there's no
 *       cached flag to invalidate — it's a live query).
 *   (d) a provider with only an UNUSED claim row (used=0, never clicked) —
 *       must NOT count as claimed — the CTA card is PRESENT.
 *
 * Same synthetic-req/res router.handle() harness + in-memory-DB
 * (EXPERIENCES_DB_PATH=":memory:") pattern as
 * experiences-seo-sok-gardssalg.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-gardssalg-claim-cta.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoGardssalgClaimCtaTests() and folds its pass/fail
 *      counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as experiences-seo-sok-gardssalg.test.ts.
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

const CTA_MARKER = "Driver du dette stedet?";

export function runExperiencesSeoGardssalgClaimCtaTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const claimSvcPath = require.resolve("../services/gardssalg-claim");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, claimSvcPath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");

      // ── Fixtures — same raw-insert pattern as
      // experiences-seo-sok-gardssalg.test.ts (createProvider() doesn't
      // support producer_type/slug). ───────────────────────────────────────
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @poststed, @producer_type, @booking_live, @catalog_hidden, @lat, @lon,
            @geocode_confidence, @slug, 'raw', 'pending_verify', 'test-fixture', 'medium')`
      );

      insertProvider.run({
        id: "gs-claimed", navn: "Klaimet Gård", fylke: "Telemark", kommune: "Skien",
        poststed: "Skien", producer_type: "cideri", booking_live: null, catalog_hidden: null,
        lat: 59.21, lon: 9.61, geocode_confidence: "high", slug: "klaimet-gard",
      });
      insertProvider.run({
        id: "gs-unclaimed", navn: "Uklaimet Gård", fylke: "Telemark", kommune: "Skien",
        poststed: "Skien", producer_type: "bryggeri", booking_live: null, catalog_hidden: null,
        lat: 59.22, lon: 9.62, geocode_confidence: "high", slug: "uklaimet-gard",
      });
      insertProvider.run({
        id: "gs-revoked", navn: "Tilbakekalt Gård", fylke: "Telemark", kommune: "Skien",
        poststed: "Skien", producer_type: "vingård", booking_live: null, catalog_hidden: null,
        lat: 59.23, lon: 9.63, geocode_confidence: "high", slug: "tilbakekalt-gard",
      });
      insertProvider.run({
        id: "gs-unused", navn: "Uklikket Gård", fylke: "Telemark", kommune: "Skien",
        poststed: "Skien", producer_type: "mjøderi", booking_live: null, catalog_hidden: null,
        lat: 59.24, lon: 9.64, geocode_confidence: "high", slug: "uklikket-gard",
      });

      const insertClaim = db.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, used_at, revoked_at, created_at, expires_at)
         VALUES (@id, @provider_id, 'post@example.no', 'verified_domain_address', @token, @used, @used_at, @revoked_at, datetime('now'), datetime('now', '+7 days'))`
      );

      // (a) used=1, not revoked -> claimed.
      insertClaim.run({
        id: "gsc-claimed", provider_id: "gs-claimed", token: "tok-claimed",
        used: 1, used_at: new Date().toISOString(), revoked_at: null,
      });
      // (c) used=1, but revoked -> must NOT count as claimed.
      insertClaim.run({
        id: "gsc-revoked", provider_id: "gs-revoked", token: "tok-revoked",
        used: 1, used_at: new Date().toISOString(), revoked_at: new Date().toISOString(),
      });
      // (d) never clicked (used=0) -> must NOT count as claimed.
      insertClaim.run({
        id: "gsc-unused", provider_id: "gs-unused", token: "tok-unused",
        used: 0, used_at: null, revoked_at: null,
      });
      // gs-unclaimed intentionally has NO gardssalg_claims row at all.

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── (a) claimed provider — CTA absent ────────────────────────────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/klaimet-gard");
        assertTrue(r.handled, "a1: GET /kategori/gardssalg/produsent/klaimet-gard is handled");
        assertTrue(r.status === 200, `a2: response status is 200 (got ${r.status})`);
        assertTrue(r.body.includes("Klaimet Gård"), "a3: the producer page rendered (sanity check)");
        assertTrue(!r.body.includes(CTA_MARKER), "a4: a used, non-revoked claim hides the 'Driver du dette stedet?' CTA card");
      }

      // ── (b) unclaimed provider (no claim row) — CTA present ──────────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/uklaimet-gard");
        assertTrue(r.status === 200, `b1: GET /kategori/gardssalg/produsent/uklaimet-gard renders 200 (got ${r.status})`);
        assertTrue(r.body.includes(CTA_MARKER), "b2: an unclaimed provider (no gardssalg_claims row) still shows the CTA card");
        assertTrue(r.body.includes("/kategori/gardssalg/eier/uklaimet-gard"), "b3: the CTA links to the claim-entry page for this slug");
      }

      // ── (c) revoked claim — must NOT count as claimed, CTA present ───────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/tilbakekalt-gard");
        assertTrue(r.status === 200, `c1: GET /kategori/gardssalg/produsent/tilbakekalt-gard renders 200 (got ${r.status})`);
        assertTrue(r.body.includes(CTA_MARKER), "c2: a REVOKED claim does not suppress the CTA — the card reappears (live query, no cached flag)");
      }

      // ── (d) unused (never-clicked) claim — must NOT count as claimed, CTA present ──
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/uklikket-gard");
        assertTrue(r.status === 200, `d1: GET /kategori/gardssalg/produsent/uklikket-gard renders 200 (got ${r.status})`);
        assertTrue(r.body.includes(CTA_MARKER), "d2: an UNUSED (used=0) claim row does not count as claimed — CTA card still present");
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-gardssalg-claim-cta: unexpected error: " + String(err?.stack || err?.message || err));
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
  runExperiencesSeoGardssalgClaimCtaTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
