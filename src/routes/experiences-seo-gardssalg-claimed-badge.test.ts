/**
 * experiences-seo-gardssalg-claimed-badge.test.ts — route + service-level
 * tests for the "Bekreftet av eier" claimed-badge on the gårdssalg producer
 * profile page (GET /kategori/gardssalg/produsent/:providerSlug,
 * src/routes/experiences-seo.ts), dev-request 2026-08-03-claim-bekreftet-
 * merke-og-innlogging.
 *
 * Once a gårdssalg profile has been claimed (a magic link has been used at
 * least once), the "Driver du dette stedet? / Er dette din bedrift?"
 * claim-CTA card is replaced by a "Bekreftet av eier" trust badge + a
 * discreet "Logg inn" link back into the owner portal — pointed directly at
 * /kategori/gardssalg/eier/<slug>/portal since dev-request 2026-08-06-claim-
 * innlogging-sesjon (previously the entry page; see a6 below). This is
 * driven by the new,
 * PERSISTENT experience_providers.claimed_at column — set once, idempotently,
 * by verifyClaimToken() (services/gardssalg-claim.ts) the first time a magic
 * link is used, and NEVER cleared by revokeClaimToken() — as opposed to the
 * older isGardssalgProviderClaimed() query (still used by the owner-portal
 * session gate), which is live/revocable. See the sibling
 * experiences-seo-gardssalg-claim-cta.test.ts for the older CTA-hide
 * coverage (updated alongside this dev-request to match the new semantics).
 *
 * Covers:
 *   (a) a claimed provider (claimed_at set) shows the badge + "Logg inn"
 *       link, and NEITHER of the old CTA's texts ("Er dette din bedrift?",
 *       "Ta over profilen...") appear.
 *   (b) an unclaimed provider (claimed_at NULL) is unchanged — the old CTA
 *       still renders, the badge does not.
 *   (c) a provider that was claimed and LATER had its claim revoked still
 *       shows the badge (AC6) — revoking a session does not remove it.
 *   (d) verifyClaimToken() sets claimed_at on first use, and a second,
 *       independent verify (repeat login / a second magic link on the same
 *       provider) does NOT overwrite the first-set value (AC1).
 *   (e) the claimed_at backfill migration (init-experiences.ts, run again on
 *       an existing DB — simulating a redeploy) sets claimed_at from the
 *       earliest used_at of a pre-existing used+non-revoked claim row whose
 *       provider has claimed_at still NULL (AC2).
 *
 * Same synthetic-req/res router.handle() harness + in-memory-DB
 * (EXPERIENCES_DB_PATH=":memory:") pattern as
 * experiences-seo-gardssalg-claim-cta.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-gardssalg-claimed-badge.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoGardssalgClaimedBadgeTests() and folds its pass/fail
 *      counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as experiences-seo-gardssalg-claim-cta.test.ts.
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

const BADGE_MARKER = "Bekreftet av eier";
const LOGIN_MARKER = "Logg inn";
const OLD_CTA_HEADING = "Driver du dette stedet?";
const OLD_CTA_BUTTON = "Er dette din bedrift?";
const OLD_CTA_BODY = "Ta over profilen";

export function runExperiencesSeoGardssalgClaimedBadgeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const initExpPath = require.resolve("../database/init-experiences");
    const expStorePath = require.resolve("../services/experience-store");
    const claimSvcPath = require.resolve("../services/gardssalg-claim");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, initExpPath, expStorePath, claimSvcPath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const { initExperiencesSchema } = require("../database/init-experiences") as typeof import("../database/init-experiences");
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");

      // ── Fixtures — same raw-insert pattern as
      // experiences-seo-gardssalg-claim-cta.test.ts (createProvider() doesn't
      // support producer_type/slug). ───────────────────────────────────────
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence, claimed_at)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @poststed, @producer_type, @booking_live, @catalog_hidden, @lat, @lon,
            @geocode_confidence, @slug, 'raw', 'pending_verify', 'test-fixture', 'medium', @claimed_at)`
      );

      insertProvider.run({
        id: "gs-badge-claimed", navn: "Bekreftet Gård", fylke: "Telemark", kommune: "Skien",
        poststed: "Skien", producer_type: "cideri", booking_live: null, catalog_hidden: null,
        lat: 59.31, lon: 9.71, geocode_confidence: "high", slug: "bekreftet-gard",
        claimed_at: "2026-07-15T09:00:00.000Z",
      });
      insertProvider.run({
        id: "gs-badge-unclaimed", navn: "Ubekreftet Gård", fylke: "Telemark", kommune: "Skien",
        poststed: "Skien", producer_type: "bryggeri", booking_live: null, catalog_hidden: null,
        lat: 59.32, lon: 9.72, geocode_confidence: "high", slug: "ubekreftet-gard",
        claimed_at: null,
      });
      insertProvider.run({
        id: "gs-badge-revoked", navn: "Tilbakekalt Bekreftet Gård", fylke: "Telemark", kommune: "Skien",
        poststed: "Skien", producer_type: "vingård", booking_live: null, catalog_hidden: null,
        lat: 59.33, lon: 9.73, geocode_confidence: "high", slug: "tilbakekalt-bekreftet-gard",
        // Was actually claimed (verifyClaimToken would have stamped this);
        // the session was later revoked but claimed_at is untouched by that.
        claimed_at: "2026-07-10T09:00:00.000Z",
      });

      const insertClaim = db.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, used_at, revoked_at, created_at, expires_at)
         VALUES (@id, @provider_id, 'post@example.no', 'verified_domain_address', @token, @used, @used_at, @revoked_at, datetime('now'), datetime('now', '+7 days'))`
      );

      insertClaim.run({
        id: "gsc-badge-claimed", provider_id: "gs-badge-claimed", token: "tok-badge-claimed",
        used: 1, used_at: "2026-07-15T09:00:00.000Z", revoked_at: null,
      });
      // used, but later revoked — claimed_at (set above) must survive this.
      insertClaim.run({
        id: "gsc-badge-revoked", provider_id: "gs-badge-revoked", token: "tok-badge-revoked",
        used: 1, used_at: "2026-07-10T09:00:00.000Z", revoked_at: "2026-07-20T09:00:00.000Z",
      });

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── (a) claimed provider — badge + login link, old CTA text absent ──
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/bekreftet-gard");
        assertTrue(r.handled, "a1: GET /kategori/gardssalg/produsent/bekreftet-gard is handled");
        assertTrue(r.status === 200, `a2: response status is 200 (got ${r.status})`);
        assertTrue(r.body.includes("Bekreftet Gård"), "a3: the producer page rendered (sanity check)");
        assertTrue(r.body.includes(BADGE_MARKER), "a4: the 'Bekreftet av eier' badge is present");
        assertTrue(r.body.includes(LOGIN_MARKER), "a5: a 'Logg inn' link is present");
        assertTrue(
          r.body.includes('href="/kategori/gardssalg/eier/bekreftet-gard/portal"'),
          "a6: the 'Logg inn' link points DIRECTLY at the owner portal for this slug (not the entry page) — dev-request 2026-08-06-claim-innlogging-sesjon, so a valid-session owner lands in the portal without a fresh magic link",
        );
        assertTrue(!r.body.includes(OLD_CTA_HEADING), "a7: the old 'Driver du dette stedet?' heading does NOT appear");
        assertTrue(!r.body.includes(OLD_CTA_BUTTON), "a8: the old 'Er dette din bedrift?' CTA button text does NOT appear");
        assertTrue(!r.body.includes(OLD_CTA_BODY), "a9: the old 'Ta over profilen...' CTA body text does NOT appear");
      }

      // ── (b) unclaimed provider — unchanged from today ────────────────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/ubekreftet-gard");
        assertTrue(r.status === 200, `b1: GET /kategori/gardssalg/produsent/ubekreftet-gard renders 200 (got ${r.status})`);
        assertTrue(r.body.includes(OLD_CTA_HEADING), "b2: an unclaimed provider still shows the old claim-CTA heading");
        assertTrue(r.body.includes(OLD_CTA_BUTTON), "b3: an unclaimed provider still shows the old claim-CTA button text");
        assertTrue(!r.body.includes(BADGE_MARKER), "b4: the 'Bekreftet av eier' badge is absent for an unclaimed provider");
      }

      // ── (c) claimed, then session revoked — badge persists (AC6) ────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/tilbakekalt-bekreftet-gard");
        assertTrue(r.status === 200, `c1: GET /kategori/gardssalg/produsent/tilbakekalt-bekreftet-gard renders 200 (got ${r.status})`);
        assertTrue(r.body.includes(BADGE_MARKER), "c2: a REVOKED-after-claimed provider still shows the badge — revoke does not un-claim (AC6)");
        assertTrue(!r.body.includes(OLD_CTA_HEADING), "c3: the old claim-CTA does not reappear after a revoke");
      }

      // ── (d) verifyClaimToken(): sets claimed_at on first use, does not
      // overwrite it on a second/independent verify (AC1) ─────────────────
      {
        insertProvider.run({
          id: "gs-verify-idempotent", navn: "Idempotent Gård", fylke: "Telemark", kommune: "Skien",
          poststed: "Skien", producer_type: "mjøderi", booking_live: null, catalog_hidden: null,
          lat: 59.34, lon: 9.74, geocode_confidence: "high", slug: "idempotent-gard",
          claimed_at: null,
        });
        insertClaim.run({
          id: "gsc-verify-first", provider_id: "gs-verify-idempotent", token: "tok-verify-first",
          used: 0, used_at: null, revoked_at: null,
        });
        insertClaim.run({
          id: "gsc-verify-second", provider_id: "gs-verify-idempotent", token: "tok-verify-second",
          used: 0, used_at: null, revoked_at: null,
        });

        const before = db
          .prepare("SELECT claimed_at FROM experience_providers WHERE id = ?")
          .get("gs-verify-idempotent") as { claimed_at: string | null };
        assertTrue(before.claimed_at === null, "d1: claimed_at is NULL before any magic link is used");

        const firstResult = claimSvc.verifyClaimToken("tok-verify-first");
        assertTrue(firstResult.valid === true, "d2: verifyClaimToken() accepts a valid, unused token");

        const afterFirst = db
          .prepare("SELECT claimed_at FROM experience_providers WHERE id = ?")
          .get("gs-verify-idempotent") as { claimed_at: string | null };
        assertTrue(!!afterFirst.claimed_at, "d3: claimed_at is set after the first verify");

        const secondResult = claimSvc.verifyClaimToken("tok-verify-second");
        assertTrue(secondResult.valid === true, "d4: verifyClaimToken() accepts a second, independent valid token for the same provider");

        const afterSecond = db
          .prepare("SELECT claimed_at FROM experience_providers WHERE id = ?")
          .get("gs-verify-idempotent") as { claimed_at: string | null };
        assertTrue(
          afterSecond.claimed_at === afterFirst.claimed_at,
          `d5: a second verify does NOT overwrite the first-set claimed_at (before=${afterFirst.claimed_at}, after=${afterSecond.claimed_at})`,
        );
      }

      // ── (e) backfill migration: a pre-existing used+non-revoked claim row
      // whose provider has claimed_at NULL gets backfilled from used_at when
      // the migration runs again (simulates a redeploy on an existing DB) ──
      {
        insertProvider.run({
          id: "gs-backfill", navn: "Etterfylt Gård", fylke: "Telemark", kommune: "Skien",
          poststed: "Skien", producer_type: "sideri", booking_live: null, catalog_hidden: null,
          lat: 59.35, lon: 9.75, geocode_confidence: "high", slug: "etterfylt-gard",
          claimed_at: null,
        });
        insertClaim.run({
          id: "gsc-backfill", provider_id: "gs-backfill", token: "tok-backfill",
          used: 1, used_at: "2026-06-01T12:00:00.000Z", revoked_at: null,
        });

        const before = db
          .prepare("SELECT claimed_at FROM experience_providers WHERE id = ?")
          .get("gs-backfill") as { claimed_at: string | null };
        assertTrue(before.claimed_at === null, "e1: claimed_at is NULL immediately after the raw insert (pre-migration state)");

        // Re-run the migration on the SAME db handle — idempotent, additive,
        // and this is exactly what happens on every boot per init-experiences.ts.
        initExperiencesSchema(db);

        const after = db
          .prepare("SELECT claimed_at FROM experience_providers WHERE id = ?")
          .get("gs-backfill") as { claimed_at: string | null };
        assertTrue(
          after.claimed_at === "2026-06-01T12:00:00.000Z",
          `e2: claimed_at is backfilled from the used, non-revoked claim's used_at (got ${after.claimed_at})`,
        );

        // Running the migration yet again must not change an already-set value.
        initExperiencesSchema(db);
        const afterAgain = db
          .prepare("SELECT claimed_at FROM experience_providers WHERE id = ?")
          .get("gs-backfill") as { claimed_at: string | null };
        assertTrue(
          afterAgain.claimed_at === after.claimed_at,
          "e3: re-running the migration again does not change an already-backfilled claimed_at",
        );
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-gardssalg-claimed-badge: unexpected error: " + String(err?.stack || err?.message || err));
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
  runExperiencesSeoGardssalgClaimedBadgeTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
