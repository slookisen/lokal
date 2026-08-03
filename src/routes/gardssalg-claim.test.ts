/**
 * gardssalg-claim.test.ts (routes) — HTTP-level tests for the opplevagent
 * gårdssalg producer owner-claim flow (dev-request 2026-07-21-opplevagent-
 * claim-flyt-drikkeprodusenter, src/routes/gardssalg-claim.ts).
 *
 * Mirrors the "Phase 5.4a M2: owner-portal frontend tests" HTTP-server
 * harness in tests/test.ts (real http.Server + raw http.request(), not a
 * mock req/res) since this router — like owner-portal.ts — deals in real
 * cookies/redirects, which are awkward to fake with the lighter
 * router.handle() mock used by the admin-only opplevelser.ts tests.
 *
 * Covers:
 *   (a) unauthenticated entry page: 404 for an unknown slug, manual-fallback
 *       messaging (no self-service form) for a non-eligible provider,
 *       masked-email + request form for an eligible provider.
 *   (b) POST .../request issues a real gardssalg_claims row and (indirectly,
 *       via the service-level test) sends the magic link; repeated requests
 *       past the rate limit are rejected. (b5)-(b16): dev-request 2026-08-03-
 *       claim-reinnlogging-kan-ikke-testes AC2/AC3 — this PUBLIC route never
 *       exposes a verify_url/token, in either its JSON-fetch or its no-JS
 *       (redirect) response shape, and a real provider's claim row stays
 *       is_test=0.
 *   (c) GET magic-link-verify: invalid token -> redirect with error; valid
 *       token -> sets the oa_owner_session cookie and redirects to the portal.
 *   (d) session gating on every edit endpoint: no cookie -> 401/redirect;
 *       wrong provider's session -> 403; correct session -> 200.
 *   (e) logout revokes the token (not just clears the cookie) — a second
 *       request with the same (pre-logout) cookie value no longer
 *       authenticates.
 *
 * Exported runGardssalgClaimRouteTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/gardssalg-claim.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgClaimRouteTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const claimSvcPath = require.resolve("../services/gardssalg-claim");
    const routerPath = require.resolve("./gardssalg-claim");
    for (const p of [dbFactoryPath, claimSvcPath, routerPath]) delete require.cache[p];

    let server: any = null;
    const initMod = require("../database/init") as typeof import("../database/init");
    const Database = (require("better-sqlite3")) as typeof import("better-sqlite3");
    const prevRfbDb = initMod.getDb();
    const rfbDb = new Database(":memory:");

    try {
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, hjemmeside, content_source, field_provenance,
           enrichment_state, verification_status, source, confidence)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, @brreg_verified, @hjemmeside, @content_source, @field_provenance,
           'raw', 'pending_verify', 'test-fixture', 'medium')
      `);
      insertProvider.run({
        id: "prov-route-eligible", navn: "Route Test Gård", slug: "route-test-gard",
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://route-test-gard.no",
        // NOT 'manual' — this fixture needs the row to still be WRITABLE
        // after the claim (content_source -> 'claim'), so eligibility here
        // comes via the admin-approved-discovery evidence marker
        // (field_provenance.hjemmeside), not via a Daniel-curated 'manual' row.
        content_source: null,
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/listing/route-test-gard", fetched_at: "2026-07-01T00:00:00Z" } }),
      });
      insertProvider.run({
        id: "prov-route-noemail", navn: "Route Test Uten Epost", slug: "route-test-uten-epost",
        org_nr: "911111111", brreg_verified: 1, hjemmeside: null,
        content_source: null, field_provenance: null,
      });
      insertProvider.run({
        id: "prov-route-other", navn: "En Annen Gård", slug: "en-annen-gard",
        org_nr: "922222222", brreg_verified: 1, hjemmeside: "https://enannengard.no",
        content_source: "manual", field_provenance: null,
      });
      // dev-request 2026-08-03-claim-reinnlogging-kan-ikke-testes AC2/AC3 —
      // a REAL (non-test) provider dedicated to asserting the public route
      // never leaks a verify_url/token, in both its JSON and no-JS
      // (redirect) response shapes. Own fixture so its rate-limit window
      // and claim-row history don't interact with any other section here.
      insertProvider.run({
        id: "prov-route-noleak", navn: "No Leak Gård", slug: "no-leak-gard",
        org_nr: "944444444", brreg_verified: 1, hjemmeside: "https://no-leak-gard.no",
        content_source: null,
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/listing/no-leak-gard", fetched_at: "2026-07-01T00:00:00Z" } }),
      });
      // stored_epost_verified (c-epost) route-level fixture: content_source=
      // 'manual', NO hjemmeside at all -- eligibility here can ONLY come
      // from the new tier. This is what pins the GET entry page's mirroring
      // of issueClaimMagicLink()'s own (b-epost) lookup (see routes/
      // gardssalg-claim.ts's GET handler comment) -- a regression that
      // updates one call site and not the other would show the wrong page.
      insertProvider.run({
        id: "prov-route-epost", navn: "Route Test Epost Gård", slug: "route-test-epost-gard",
        org_nr: "933333333", brreg_verified: 1, hjemmeside: null,
        content_source: "manual", field_provenance: null,
      });
      expDb.prepare("UPDATE experience_providers SET epost = ? WHERE id = ?").run("post@routeepost.no", "prov-route-epost");

      const routerMod = require("./gardssalg-claim") as typeof import("./gardssalg-claim");
      const expressMod = require("express") as typeof import("express");
      const app = expressMod();
      app.use(expressMod.json());
      app.use("/", routerMod.default);

      const httpMod = require("http") as typeof import("http");
      server = httpMod.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      function req(
        method: string,
        urlPath: string,
        opts: { headers?: Record<string, string>; body?: string } = {},
      ): Promise<{ status: number; headers: any; body: string }> {
        return new Promise((resolve, reject) => {
          const r = httpMod.request(
            { method, host: "127.0.0.1", port, path: urlPath, headers: opts.headers || {} },
            (resp) => {
              const chunks: Buffer[] = [];
              resp.on("data", (c) => chunks.push(c as Buffer));
              resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
            },
          );
          r.on("error", reject);
          if (opts.body) r.write(opts.body);
          r.end();
        });
      }

      function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string | null {
        const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
        for (const h of headers) {
          const m = h.match(new RegExp(`${name}=([^;]+)`));
          if (m) return m[1];
        }
        return null;
      }

      // ── (a) Unauthenticated entry page ──────────────────────────────────
      const notFound = await req("GET", "/kategori/gardssalg/eier/does-not-exist");
      assertEq(notFound.status, 404, "a1: GET entry page for an unknown slug -> 404");

      const noEmailPage = await req("GET", "/kategori/gardssalg/eier/route-test-uten-epost");
      assertEq(noEmailPage.status, 200, "a2: GET entry page for a non-eligible provider still returns 200 (manual fallback shown, not an error)");
      assertTrue(noEmailPage.body.includes("kontakt@opplevagent.no"), "a3: non-eligible provider's entry page shows the manual-fallback contact");
      assertTrue(!noEmailPage.body.includes("Send meg tilgangslenke"), "a4: non-eligible provider's entry page has NO self-service request button");

      const eligiblePage = await req("GET", "/kategori/gardssalg/eier/route-test-gard");
      assertEq(eligiblePage.status, 200, "a5: GET entry page for an eligible provider -> 200");
      assertTrue(eligiblePage.body.includes("Send meg tilgangslenke"), "a6: eligible provider's entry page shows the request button");
      assertTrue(!eligiblePage.body.includes("@route-test-gard.no"), "a7: entry page never shows the FULL target email, only a masked version");
      assertTrue(/p\*+t@r\*+\.no/.test(eligiblePage.body), "a8: entry page shows a masked version of post@route-test-gard.no");

      // ── stored_epost_verified: GET entry page mirrors issueClaimMagicLink ──
      const epostPage = await req("GET", "/kategori/gardssalg/eier/route-test-epost-gard");
      assertEq(epostPage.status, 200, "a9: GET entry page for a stored_epost_verified-only provider -> 200");
      assertTrue(epostPage.body.includes("Send meg tilgangslenke"), "a10: shows the self-service request button (not the manual fallback) for a stored_epost_verified-eligible provider");
      assertTrue(!epostPage.body.includes("post@routeepost.no"), "a11: never shows the full target email, only masked");

      const epostReqResp = await req("POST", "/kategori/gardssalg/eier/prov-route-epost/request", {
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assertEq(epostReqResp.status, 200, "a12: POST request-magic-link succeeds end to end for the stored_epost_verified provider");
      const epostClaimRow = expDb.prepare("SELECT email, email_source FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at DESC LIMIT 1").get("prov-route-epost") as any;
      assertEq(epostClaimRow?.email, "post@routeepost.no", "a13: the issued claim really targets the provider's stored epost");
      assertEq(epostClaimRow?.email_source, "stored_epost_verified", "a14: persisted with email_source='stored_epost_verified'");

      // ── (b) POST request -> issues a magic link (JSON path) ────────────
      const reqResp = await req("POST", "/kategori/gardssalg/eier/prov-route-eligible/request", {
        headers: { "Content-Type": "application/json", "Content-Length": "2" },
        body: "{}",
      });
      assertEq(reqResp.status, 200, "b1: POST request-magic-link (JSON) -> 200");
      const reqBody = JSON.parse(reqResp.body);
      assertTrue(reqBody.success === true, "b2: response body success=true");
      assertTrue(typeof reqBody.maskedEmail === "string" && reqBody.maskedEmail.length > 0, "b3: response carries a masked email");

      // Rate limit: 2 more succeed (3 total), 4th is rejected.
      await req("POST", "/kategori/gardssalg/eier/prov-route-eligible/request", { headers: { "Content-Type": "application/json" }, body: "{}" });
      await req("POST", "/kategori/gardssalg/eier/prov-route-eligible/request", { headers: { "Content-Type": "application/json" }, body: "{}" });
      const rateLimited = await req("POST", "/kategori/gardssalg/eier/prov-route-eligible/request", { headers: { "Content-Type": "application/json" }, body: "{}" });
      assertEq(rateLimited.status, 429, "b4: 4th request within the window -> 429 rate_limited");

      // ── (b5)-(b10) dev-request 2026-08-03-claim-reinnlogging-kan-ikke-
      // testes AC2/AC3: the public route NEVER exposes a verify_url/token,
      // in either its JSON-fetch or its no-JS (redirect) response shape —
      // and a real (non-test) provider's claim row stays is_test=0
      // ─────────────────────────────────────────────────────────────────
      const noLeakJson = await req("POST", "/kategori/gardssalg/eier/prov-route-noleak/request", {
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assertEq(noLeakJson.status, 200, "b5: JSON-fetch request-magic-link for a real provider -> 200");
      const noLeakJsonBody = JSON.parse(noLeakJson.body);
      assertTrue(noLeakJsonBody.success === true, "b6: JSON response success=true");
      assertTrue(
        !("verify_url" in noLeakJsonBody) && !("token" in noLeakJsonBody),
        "b7: AC2 — JSON response body has no verify_url/token field"
      );

      const noLeakClaimRow = expDb.prepare(
        `SELECT token, is_test FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at DESC LIMIT 1`
      ).get("prov-route-noleak") as any;
      assertTrue(!!noLeakClaimRow?.token, "b8: a claim token was really issued (fixture sanity check)");
      assertTrue(
        !noLeakJson.body.includes(noLeakClaimRow.token),
        "b9: AC2 — the actual token value appears nowhere in the JSON response body"
      );
      assertEq(noLeakClaimRow.is_test, 0, "b10: AC3 — a real (non-test) provider's claim row is is_test=0 via the public route");

      // No-JS (plain form POST) path — no Content-Type/Accept advertising
      // JSON, exactly like a browser without JS submitting the HTML form.
      const noLeakForm = await req("POST", "/kategori/gardssalg/eier/prov-route-noleak/request");
      assertEq(noLeakForm.status, 303, "b11: no-JS request-magic-link -> 303 redirect to the entry page");
      const noLeakLocation = String(noLeakForm.headers.location || "");
      assertTrue(noLeakLocation.startsWith("/kategori/gardssalg/eier/no-leak-gard"), "b12: redirects back to the provider's own entry page");
      assertTrue(!noLeakLocation.includes("token"), "b13: AC2 — the redirect Location header carries no token/verify_url");
      assertTrue(!noLeakForm.body.includes("token"), "b14: AC2 — the redirect response body carries no token/verify_url");
      const noLeakClaimRow2 = expDb.prepare(
        `SELECT token, is_test FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at DESC LIMIT 1`
      ).get("prov-route-noleak") as any;
      assertTrue(
        noLeakClaimRow2.token !== noLeakClaimRow.token && !noLeakLocation.includes(noLeakClaimRow2.token) && !noLeakForm.body.includes(noLeakClaimRow2.token),
        "b15: AC2 — the no-JS response leaks neither the earlier nor this request's actual token value anywhere (headers or body)"
      );
      assertEq(noLeakClaimRow2.is_test, 0, "b16: AC3 — the no-JS path's claim row is also is_test=0 (real, not a test row)");

      // ── (c) magic-link-verify ───────────────────────────────────────────
      const badVerify = await req("GET", "/kategori/gardssalg/eier/magic-link-verify?token=bogus");
      assertEq(badVerify.status, 302, "c1: GET verify with a bogus token -> 302 redirect");
      assertTrue(String(badVerify.headers.location || "").includes("error=invalid_token"), "c2: bogus-token redirect carries error=invalid_token");

      const claimRow = expDb.prepare("SELECT token FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at DESC LIMIT 1").get("prov-route-eligible") as any;
      assertTrue(!!claimRow?.token, "c3: a claim token exists to verify (fixture sanity check)");

      const goodVerify = await req("GET", `/kategori/gardssalg/eier/magic-link-verify?token=${claimRow.token}`);
      assertEq(goodVerify.status, 302, "c4: GET verify with a valid token -> 302 redirect to the portal");
      assertTrue(String(goodVerify.headers.location || "").includes("/kategori/gardssalg/eier/route-test-gard/portal"), "c5: valid-token redirect targets the portal");
      const sessionCookie = extractCookie(goodVerify.headers["set-cookie"], "oa_owner_session");
      assertTrue(!!sessionCookie, "c6: a valid verify sets the oa_owner_session cookie");

      // ── (d) session gating ──────────────────────────────────────────────
      const portalNoAuth = await req("GET", "/kategori/gardssalg/eier/route-test-gard/portal");
      assertEq(portalNoAuth.status, 302, "d1: GET portal without a session cookie -> redirect (not the portal HTML)");

      const profileNoAuth = await req("GET", "/api/opplevelser/gardssalg-claim/prov-route-eligible/profile");
      assertEq(profileNoAuth.status, 401, "d2: GET profile API without a session -> 401");

      const updateNoAuth = await req("POST", "/api/opplevelser/gardssalg-claim/prov-route-eligible/update-profile", {
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      assertEq(updateNoAuth.status, 401, "d3: POST update-profile without a session -> 401");

      const statsNoAuth = await req("GET", "/api/opplevelser/gardssalg-claim/prov-route-eligible/stats");
      assertEq(statsNoAuth.status, 401, "d4: GET stats API without a session -> 401");

      const cookieHeader = `oa_owner_session=${sessionCookie}`;

      const crossProvider = await req("GET", "/api/opplevelser/gardssalg-claim/prov-route-other/profile", { headers: { Cookie: cookieHeader } });
      assertEq(crossProvider.status, 403, "d5: a valid session for provider A used against provider B's profile API -> 403");

      const portalAuthed = await req("GET", "/kategori/gardssalg/eier/route-test-gard/portal", { headers: { Cookie: cookieHeader } });
      assertEq(portalAuthed.status, 200, "d6: GET portal with a valid session cookie -> 200");
      assertTrue(portalAuthed.body.includes("Route Test Gård"), "d7: portal HTML shows the provider name");
      assertTrue(portalAuthed.body.includes("Logg ut"), "d8: portal HTML shows a logout button");

      const profileAuthed = await req("GET", "/api/opplevelser/gardssalg-claim/prov-route-eligible/profile", { headers: { Cookie: cookieHeader } });
      assertEq(profileAuthed.status, 200, "d9: GET profile API with the right session -> 200");
      const profileBody = JSON.parse(profileAuthed.body);
      assertEq(profileBody.provider.navn, "Route Test Gård", "d10: profile API returns the right provider");
      assertEq(profileBody.fields.booking_live, false, "d11: profile API's booking_live starts false");

      const updateAuthed = await req("POST", "/api/opplevelser/gardssalg-claim/prov-route-eligible/update-profile", {
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({ about_text: "Ny beskrivelse via API", booking_live: true }),
      });
      assertEq(updateAuthed.status, 200, "d12: POST update-profile with the right session -> 200");
      const updateBody = JSON.parse(updateAuthed.body);
      assertTrue(updateBody.updated_fields.includes("about_text"), "d13: update-profile response lists about_text as updated");
      assertTrue(updateBody.updated_fields.includes("booking_live"), "d14: update-profile response lists booking_live as updated");

      const afterApiUpdate = expDb.prepare("SELECT about_text, booking_live, content_source FROM experience_providers WHERE id = ?").get("prov-route-eligible") as any;
      assertEq(afterApiUpdate.about_text, "Ny beskrivelse via API", "d15: about_text actually persisted via the JSON API");
      assertEq(afterApiUpdate.booking_live, 1, "d16: booking_live actually persisted via the JSON API");
      assertEq(afterApiUpdate.content_source, "claim", "d17: content_source is still 'claim' after an owner edit (never reverted)");

      const statsAuthed = await req("GET", "/api/opplevelser/gardssalg-claim/prov-route-eligible/stats", { headers: { Cookie: cookieHeader } });
      assertEq(statsAuthed.status, 200, "d18: GET stats API with the right session -> 200");
      const statsBody = JSON.parse(statsAuthed.body);
      assertTrue(statsBody.success === true, "d19: stats API success=true");
      assertEq(typeof statsBody.stats.humanViews, "number", "d20: stats API returns a numeric humanViews");
      assertTrue(Array.isArray(statsBody.stats.notAvailable) && statsBody.stats.notAvailable.length > 0, "d21: stats API honestly lists what's NOT available (never fabricated)");

      // ── (e) logout really revokes ───────────────────────────────────────
      const logout = await req("POST", "/kategori/gardssalg/eier/route-test-gard/logout", { headers: { Cookie: cookieHeader } });
      assertEq(logout.status, 303, "e1: POST logout -> 303 redirect");

      const afterLogout = await req("GET", "/api/opplevelser/gardssalg-claim/prov-route-eligible/profile", { headers: { Cookie: cookieHeader } });
      assertEq(afterLogout.status, 401, "e2: the SAME (pre-logout) session cookie no longer authenticates after logout — a real revoke, not just a cookie-clear");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-claim routes: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (server) {
        try { server.close(); } catch { /* ignore */ }
      }
      initMod.__setDbForTesting(prevRfbDb);
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/gardssalg-claim.test.ts`
if (require.main === module) {
  console.log("── gardssalg-claim route tests ──");
  runGardssalgClaimRouteTests({ log: true }).then((r) => {
    console.log(`\ngardssalg-claim routes: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
