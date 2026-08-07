/**
 * experiences-seo-eier-cta-swap.test.ts — dev-request 2026-08-06-eier-ser-
 * reserver-knapp-paa-egen-profil.
 *
 * Covers:
 *   (a) `decideOwnerCtaSwap` (src/routes/experiences-seo.ts) — the pure
 *       decision function shipped verbatim into the produsent profile
 *       page's inline <script> via `.toString()` (same pattern as
 *       `describeSaveOutcome`, PR #492). Every branch it can take.
 *   (b) CACHE-SAFETY REGRESSION (the load-bearing test for AC4): the SAME
 *       GET /kategori/gardssalg/produsent/:providerSlug request, once with
 *       NO cookie and once with a VALID owner-session cookie for that
 *       EXACT provider, must return byte-identical HTML. This is what
 *       proves the server-rendered response never varies by viewer — the
 *       owner-CTA swap happens client-side only, against the separate
 *       `Cache-Control: no-store` GET .../session-status endpoint in
 *       src/routes/gardssalg-claim.ts (covered by that file's own test
 *       suite, gardssalg-claim.test.ts, section (g)).
 *   (c) the server-rendered HTML always contains the unmodified "Reserver
 *       besøk" CTA (with its stable id="reserve-cta"), the swap <script>,
 *       and the session-status fetch call — for EVERY viewer, own-profile
 *       owner included (AC1 depends on this script running client-side;
 *       AC2/AC3 depend on it being a no-op for everyone else).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-eier-cta-swap.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoEierCtaSwapTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as experiences-seo-gardssalg-
// claim-cta.test.ts, extended to accept request headers (needed here to
// simulate a Cookie header) and to record any res.setHeader() calls (needed
// to assert the page's own Cache-Control is untouched by the swap feature).
function callHtmlRoute(
  router: any,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ handled: boolean; status: number; body: string; resHeaders: Record<string, string> }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const resHeaders: Record<string, string> = {};
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers,
      lang: "no",
      get(name: string) {
        const key = String(name || "").toLowerCase();
        for (const k of Object.keys(headers)) if (k.toLowerCase() === key) return headers[k];
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        resHeaders[String(name).toLowerCase()] = String(value);
      },
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, body: String(body), resHeaders });
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "", resHeaders });
    });
  });
}

export function runExperiencesSeoEierCtaSwapTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const seoMod = require("./experiences-seo") as typeof import("./experiences-seo");
      const decideOwnerCtaSwap = seoMod.decideOwnerCtaSwap;

      // ── (a) decideOwnerCtaSwap — pure, no DOM/fetch ──────────────────────
      assertEq(
        decideOwnerCtaSwap(true, { isOwner: true }, "/portal", "/book"),
        { swap: true, primaryLabel: "Rediger profilen", primaryHref: "/portal", secondaryLabel: "Forhåndsvis som besøkende", secondaryHref: "/book" },
        "swap-01: ok:true + isOwner:true -> swap, correct hrefs/labels",
      );
      assertEq(
        decideOwnerCtaSwap(true, { isOwner: false }, "/portal", "/book"),
        { swap: false },
        "swap-02: ok:true + isOwner:false -> no swap (the common case: anonymous visitor / other producer's owner)",
      );
      assertEq(
        decideOwnerCtaSwap(false, { isOwner: true }, "/portal", "/book"),
        { swap: false },
        "swap-03: ok:false (fetch/HTTP failure) -> no swap even if body somehow says isOwner:true — fail closed",
      );
      assertEq(
        decideOwnerCtaSwap(true, null, "/portal", "/book"),
        { swap: false },
        "swap-04: ok:true but null/unparsable body -> no swap, no throw",
      );
      assertEq(
        decideOwnerCtaSwap(true, { isOwner: "true" }, "/portal", "/book"),
        { swap: false },
        "swap-05: isOwner as a truthy STRING (not boolean true) -> no swap — strict === true check, not a truthy check",
      );
      assertEq(
        decideOwnerCtaSwap(true, {}, "/portal", "/book"),
        { swap: false },
        "swap-06: ok:true + empty body -> no swap",
      );

      // ── DB fixtures for (b)/(c) ──────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");

      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence, claimed_at)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @poststed, @producer_type, @booking_live, @catalog_hidden, @lat, @lon,
            @geocode_confidence, @slug, 'raw', 'pending_verify', 'test-fixture', 'medium', @claimed_at)`
      );
      insertProvider.run({
        id: "ecta-prov-owner", navn: "Eierbryggeriet", fylke: "Telemark", kommune: "Skien",
        poststed: "Skien", producer_type: "bryggeri", booking_live: null, catalog_hidden: null,
        lat: 59.21, lon: 9.61, geocode_confidence: "high", slug: "eierbryggeriet",
        claimed_at: new Date().toISOString(),
      });

      const insertClaim = db.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, used_at, revoked_at, created_at, expires_at)
         VALUES (@id, @provider_id, 'post@example.no', 'verified_domain_address', @token, 1, @used_at, NULL, datetime('now'), datetime('now', '+7 days'))`
      );
      const ownerToken = "ecta-owner-session-token";
      insertClaim.run({
        id: "ecta-claim-owner", provider_id: "ecta-prov-owner", token: ownerToken,
        used_at: new Date().toISOString(),
      });

      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      // Fixture sanity check: the session token really does verify as this
      // exact provider's owner — otherwise (b) below would trivially pass
      // for the wrong reason (a cookie that never authenticated anyway).
      const verified = claimSvc.verifyGardssalgOwnerSessionToken(ownerToken);
      assertTrue(verified.valid === true && verified.providerId === "ecta-prov-owner", "fixture: the owner session token verifies for ecta-prov-owner (sanity check)");

      const seoRouter = seoMod.default as any;
      const url = "/kategori/gardssalg/produsent/eierbryggeriet";

      const noCookie = await callHtmlRoute(seoRouter, url);
      const ownerCookie = await callHtmlRoute(seoRouter, url, { cookie: `${claimSvc.GARDSSALG_OWNER_SESSION_COOKIE}=${ownerToken}` });

      assertTrue(noCookie.handled && noCookie.status === 200, "b1: no-cookie request handled, 200");
      assertTrue(ownerCookie.handled && ownerCookie.status === 200, "b2: owner-cookie request (for THIS exact provider) handled, 200");

      // ── (b) THE cache-safety regression test (AC4) ───────────────────────
      assertTrue(
        noCookie.body === ownerCookie.body,
        "b3 [AC4]: server-rendered HTML is BYTE-IDENTICAL whether the request carries no cookie or a valid owner-session cookie for this exact provider — the server-side output never varies by viewer, so a shared cache can never leak an owner-specific variant",
      );
      assertEq(
        noCookie.resHeaders["cache-control"],
        "public, max-age=300",
        "b4: the profile page's own Cache-Control is still the public, shared-cacheable one (unchanged by this feature)",
      );
      assertEq(
        ownerCookie.resHeaders["cache-control"],
        "public, max-age=300",
        "b5: ...identically so even when the request carried a valid owner-session cookie — the route itself never sets a different header per viewer either",
      );

      // ── (c) the swap machinery is present in the SAME server-rendered
      // HTML for every viewer (own-profile owner, other-profile owner, and
      // anonymous alike) — it's a client-side no-op until the browser's own
      // fetch() resolves, which this router.handle() harness never runs. ──
      for (const [label, resp] of [["no-cookie", noCookie] as const, ["owner-cookie", ownerCookie] as const]) {
        assertTrue(resp.body.includes('id="reserve-cta"'), `c1 (${label}): server-rendered CTA still has the stable id="reserve-cta" for the client script to target`);
        assertTrue(resp.body.includes(">Reserver besøk<"), `c2 (${label}): server-rendered CTA text is still exactly "Reserver besøk" — unchanged for cache-safety, swap happens client-side only`);
        assertTrue(resp.body.includes("decideOwnerCtaSwap"), `c3 (${label}): the inline <script> embeds decideOwnerCtaSwap.toString() — tested code IS shipped code`);
        assertTrue(resp.body.includes("/session-status"), `c4 (${label}): the inline <script> calls the separate no-store session-status endpoint`);
        assertTrue(resp.body.includes("ecta-prov-owner"), `c5 (${label}): the inline <script> is parameterized with THIS page's own provider id`);
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-eier-cta-swap: unexpected error: " + String(err?.stack || err?.message || err));
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
  runExperiencesSeoEierCtaSwapTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
