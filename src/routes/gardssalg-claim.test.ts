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
    const rfbDb = new Database(":memory:");

    try {
      initMod.__initSchemaForTesting(rfbDb as any);
      // Isolated override (dev-request 2026-08-06-claim-produsent-velger-
      // mottakeradresse), not the shared GLOBAL RFB singleton this route
      // suite used to swap via initMod.__setDbForTesting(): the ONLY thing
      // this router touches on the RFB db is wasEpostDeliveredOutreachNoBounce()
      // (via issueClaimMagicLink -> deriveOrgLinkedEmailCandidatesWithOutreachLookup),
      // which already has its own test-only seam for exactly this — see
      // services/gardssalg-claim.test.ts's own doc comment on
      // __setRfbDbForTesting for the full rationale (swapping the shared
      // singleton here raced live against unrelated suites running
      // concurrently elsewhere in the full `npm test`, the "no such table:
      // outreach_sent_log" failure class its postmortem documents). This
      // suite never actually populates rfbDb with outreach fixture rows —
      // it only needs a validly-schema'd, empty RFB db so that lookup never
      // throws — so the isolated override is a drop-in, lower-risk swap.
      const claimSvcForRfbOverride = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      claimSvcForRfbOverride.__setRfbDbForTesting(rfbDb as any);

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

      // Two-candidate route fixture — dev-request 2026-08-06-claim-
      // produsent-velger-mottakeradresse: a verified own domain AND a
      // manually-entered second address both qualify.
      insertProvider.run({
        id: "prov-route-two", navn: "To Valg Gård", slug: "to-valg-gard",
        org_nr: "966666666", brreg_verified: 1, hjemmeside: "https://toroute.no",
        content_source: "manual", field_provenance: null,
      });
      expDb.prepare("UPDATE experience_providers SET epost = ? WHERE id = ?").run("eier2@gmail.com", "prov-route-two");

      const routerMod = require("./gardssalg-claim") as typeof import("./gardssalg-claim");

      // ── describeSaveOutcome (pure, dev-request 2026-08-03-eierportal-
      // lagre-knapp-henger) — both outcomes, no server/DOM needed. This is
      // the exact function shipped to the browser via `.toString()` in the
      // portal's inline <script>, so testing it here IS testing the client
      // logic, not a hand-copied stand-in.
      assertEq(
        routerMod.describeSaveOutcome(true, { success: true, updated_fields: ["about_text"] }),
        { success: true, message: "Endringene er lagret." },
        "save-01: ok response with success:true -> success receipt",
      );
      assertEq(
        routerMod.describeSaveOutcome(false, { success: false, error: "session_invalid" }),
        { success: false, message: "Klarte ikke å lagre. Prøv igjen." },
        "save-02: non-ok response -> error receipt",
      );
      assertEq(
        routerMod.describeSaveOutcome(true, { success: false, error: "provider_not_found" }),
        { success: false, message: "Klarte ikke å lagre. Prøv igjen." },
        "save-03: ok:true but body.success:false (e.g. a 200 that still reports failure) -> error receipt, not success",
      );
      assertEq(
        routerMod.describeSaveOutcome(true, null),
        { success: false, message: "Klarte ikke å lagre. Prøv igjen." },
        "save-04: ok:true but unparsable/null body -> error receipt, not a throw",
      );

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

      // ── Producer address selection (2+ candidates) — dev-request
      // 2026-08-06-claim-produsent-velger-mottakeradresse ─────────────────
      const twoChoicePage = await req("GET", "/kategori/gardssalg/eier/to-valg-gard");
      assertEq(twoChoicePage.status, 200, "k1: GET entry page for a 2-candidate provider -> 200");
      assertTrue(twoChoicePage.body.includes('name="selected"'), "k2: entry page renders a selection control when there is more than one candidate");
      assertTrue(
        (twoChoicePage.body.match(/type="radio"/g) || []).length === 2,
        "k3: exactly one radio per candidate (2 candidates -> 2 radios)",
      );
      assertTrue(twoChoicePage.body.includes('value="verified_domain_address"'), "k4: one radio's value is the verified_domain_address source tag");
      assertTrue(twoChoicePage.body.includes('value="stored_epost_verified"'), "k5: the other radio's value is the stored_epost_verified source tag");
      assertTrue(!twoChoicePage.body.includes("eier2@gmail.com"), "k6: the full second address never appears anywhere on the page (AC4)");
      assertTrue(!twoChoicePage.body.includes("post@toroute.no"), "k7: the full first address never appears anywhere on the page either (AC4)");
      assertTrue(/e\*+2@g\*+\.com/.test(twoChoicePage.body), "k8: the second address IS shown, masked");

      // k8a-k8c: DOM-structural check (independent review finding, PR #494) —
      // a real browser (JS `form.querySelector(...)` AND a plain no-JS
      // native form submit) only ever sees a field as "in the form" if it is
      // a DESCENDANT of the <form>...</form> element, or carries a matching
      // `form="..."` attribute. Earlier drafts of this page rendered the
      // radios as SIBLINGS before <form> opened — every assertion above
      // still passed (they only check the radios exist SOMEWHERE in the
      // body), yet the picker was completely non-functional end to end: the
      // JS handler's querySelector found nothing, and a plain form submit
      // never included `selected` at all, so every real click on any radio
      // still resulted in "selection_required". Assert the actual DOM
      // nesting, not just presence, so this class of bug can't recur silently.
      const formOpenIdx = twoChoicePage.body.indexOf('<form id="gc-request-form"');
      const formCloseIdx = twoChoicePage.body.indexOf("</form>", formOpenIdx);
      assertTrue(formOpenIdx >= 0 && formCloseIdx > formOpenIdx, "k8a: the request form is present and well-formed (fixture sanity check)");
      const radioIndices: number[] = [];
      {
        const re = /<input type="radio" name="selected"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(twoChoicePage.body))) radioIndices.push(m.index);
      }
      assertEq(radioIndices.length, 2, "k8b: found exactly 2 radio inputs to check (fixture sanity check)");
      assertTrue(
        radioIndices.every((idx) => idx > formOpenIdx && idx < formCloseIdx),
        "k8c: every radio input is a DESCENDANT of <form id=\"gc-request-form\">...</form> (not a sibling before it) — the actual DOM relationship a real browser's form submission and querySelector(form, ...) depend on",
      );

      // No selection at all -> selection_required, never a silent guess.
      const noSelectionResp = await req("POST", "/kategori/gardssalg/eier/prov-route-two/request", {
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assertEq(noSelectionResp.status, 400, "k9: POST request with no selection on a 2-candidate provider -> 400");
      assertEq(JSON.parse(noSelectionResp.body).error, "selection_required", "k10: error body names selection_required");

      // An invalid/unknown selection value -> rejected, never silently
      // falls back to picking one on the client's behalf.
      const invalidSelectionResp = await req("POST", "/kategori/gardssalg/eier/prov-route-two/request", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected: "brreg_contact" }),
      });
      assertEq(invalidSelectionResp.status, 403, "k11: POST request with a selection that isn't one of this provider's real candidates -> 403");
      assertEq(JSON.parse(invalidSelectionResp.body).error, "invalid_selection", "k12: error body names invalid_selection");

      // A real selection (JSON/fetch path) -> succeeds, targets exactly the
      // chosen candidate.
      const selectDomainResp = await req("POST", "/kategori/gardssalg/eier/prov-route-two/request", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected: "verified_domain_address" }),
      });
      assertEq(selectDomainResp.status, 200, "k13: POST request selecting verified_domain_address -> 200");
      const domainClaimRow = expDb.prepare("SELECT email, email_source FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at DESC LIMIT 1").get("prov-route-two") as any;
      assertEq(domainClaimRow?.email, "post@toroute.no", "k14: issued claim targets the SELECTED candidate's address");
      assertEq(domainClaimRow?.email_source, "verified_domain_address", "k15: persisted with the selected source");

      // The OTHER candidate, no-JS form-POST path (urlencoded, mirrors a
      // real browser submitting the radio group natively).
      const selectEpostResp = await req("POST", "/kategori/gardssalg/eier/prov-route-two/request", {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "selected=stored_epost_verified",
      });
      assertEq(selectEpostResp.status, 303, "k16: no-JS form POST selecting the other candidate -> 303 redirect (same as the single-candidate no-JS path)");
      assertTrue(String(selectEpostResp.headers.location || "").includes("status=sent"), "k17: redirects to status=sent");
      const epostClaimRow2 = expDb.prepare("SELECT email, email_source FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at DESC LIMIT 1").get("prov-route-two") as any;
      assertEq(epostClaimRow2?.email, "eier2@gmail.com", "k18: the no-JS path issued a claim for the OTHER selected candidate, not the first");
      assertEq(epostClaimRow2?.email_source, "stored_epost_verified", "k19: persisted with the newly-selected source");

      // AC6: rate limit shared across selections — 3 requests total have now
      // been made for prov-route-two (k13, k16 above are #1 and #2; a 3rd
      // still succeeds, a 4th — regardless of which candidate — is blocked).
      const thirdSelectResp = await req("POST", "/kategori/gardssalg/eier/prov-route-two/request", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected: "verified_domain_address" }),
      });
      assertEq(thirdSelectResp.status, 200, "k20: 3rd request on this provider still succeeds (limit is 3)");
      const fourthSelectResp = await req("POST", "/kategori/gardssalg/eier/prov-route-two/request", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected: "stored_epost_verified" }),
      });
      assertEq(fourthSelectResp.status, 429, "k21: AC6 — the 4th request is rate-limited even though it picks a different candidate than the 3 before it");

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
      assertTrue(portalAuthed.body.includes('id="gc-save-status"'), "d8a: portal HTML has the in-place save-receipt container");
      assertTrue(portalAuthed.body.includes("gcDescribeSaveOutcome"), "d8b: portal HTML wires up describeSaveOutcome for the in-place receipt");
      assertTrue(portalAuthed.body.includes("var watchdog = setTimeout"), "d8c: portal HTML includes the never-stuck-forever watchdog timeout");
      assertTrue(!portalAuthed.body.includes('window.location.href = base + (out.ok'), "d8d: portal HTML no longer redirects to show the save receipt");

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

      // ── (f) dev-request 2026-08-06-claim-innlogging-sesjon: the claimed-
      // badge's "Logg inn" link on the public producer page now points
      // straight at .../portal instead of the entry page, so an owner with
      // a still-valid session skips the "request a new link" round-trip.
      // The portal route's OWN session/ownership/redirect logic (already
      // exercised above in (d)) is exactly what makes this fix correct with
      // zero new logic — these four cases pin that behavior end to end from
      // the "Logg inn" link's actual target, not just the API. ───────────

      // f1 (AC1): valid session for THIS producer hitting the portal
      // directly (what the fixed link now does) -> lands in the portal,
      // no fresh magic link needed.
      const loginLinkOwnSession = await req(
        "GET",
        "/kategori/gardssalg/eier/route-test-gard/portal",
        { headers: { Cookie: cookieHeader } },
      );
      assertEq(loginLinkOwnSession.status, 200, "f1: 'Logg inn' link target (.../portal) with a valid session for THIS producer -> 200, straight into the portal");
      assertTrue(loginLinkOwnSession.body.includes("Route Test Gård"), "f1b: the portal page rendered for the right producer");

      // f2 (AC2): the SAME valid session used against a DIFFERENT
      // producer's portal URL -> 403, never bypassing the ownership check.
      const loginLinkWrongProvider = await req(
        "GET",
        "/kategori/gardssalg/eier/en-annen-gard/portal",
        { headers: { Cookie: cookieHeader } },
      );
      assertEq(loginLinkWrongProvider.status, 403, "f2: a valid session for producer A hitting producer B's portal URL -> 403 (ownership check preserved)");
      assertTrue(loginLinkWrongProvider.body.includes("Ingen tilgang"), "f2b: the 403 page explains access is denied, not a silent portal render");

      // f3 (AC3): no/expired session hitting the portal URL directly ->
      // redirected to that SAME producer's entry page (not a different one,
      // not a bare 404/500).
      assertTrue(
        String(portalNoAuth.headers.location || "") === "/kategori/gardssalg/eier/route-test-gard",
        `f3: no-session portal hit redirects to this producer's OWN entry page (got ${JSON.stringify(portalNoAuth.headers.location)})`,
      );

      // f4 (AC3 cont'd): following that redirect lands on the entry page
      // with the "Send meg tilgangslenke" request-a-link CTA still shown —
      // current no-session behavior is unchanged by the fix.
      const entryAfterRedirect = await req("GET", String(portalNoAuth.headers.location));
      assertEq(entryAfterRedirect.status, 200, "f4: following the no-session redirect -> entry page, 200");
      assertTrue(entryAfterRedirect.body.includes("Send meg tilgangslenke"), "f4b: entry page still offers to send a fresh access link");

      // f5 (AC4): the owner can still deliberately reach the entry page
      // (e.g. to log in on another device) even while already holding a
      // valid session elsewhere — the entry page itself stays reachable and
      // able to issue a brand-new link on request (reuses the (b) POST
      // .../request path already proven above).
      const deliberateEntryVisit = await req("GET", "/kategori/gardssalg/eier/route-test-gard", { headers: { Cookie: cookieHeader } });
      assertEq(deliberateEntryVisit.status, 200, "f5: the entry page is still directly reachable (even with a valid session already held) for a deliberate re-login elsewhere");
      assertTrue(deliberateEntryVisit.body.includes("Send meg tilgangslenke"), "f5b: it still offers 'Send meg tilgangslenke' so a new device/link can be requested on demand");

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
      try {
        const claimSvcForRfbOverride = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
        claimSvcForRfbOverride.__setRfbDbForTesting(null);
      } catch { /* ignore */ }
      try { rfbDb.close(); } catch { /* already closed */ }
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
