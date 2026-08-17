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
      // outreach_sent_log" failure class its postmortem documents).
      //
      // RETIRED-TIER UPDATE (dev-request 2026-08-06-aldri-gjett-
      // epostadresse): used to say this suite never populates rfbDb with
      // outreach rows — now prov-route-eligible needs ONE (see its own
      // fixture comment below), since tier (b) retiring took away the only
      // OTHER way this suite had to keep a claimed row editable
      // (content_source='manual' locks the owner portal — see gardssalg-
      // claim.ts's isHjemmesideOwnershipVerified doc / updateClaimed-
      // ProviderProfile's `locked` check). Still the isolated override, not
      // the shared singleton — same race-avoidance reasoning as above.
      const claimSvcForRfbOverride = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      claimSvcForRfbOverride.__setRfbDbForTesting(rfbDb as any);

      // ── THE FETCH-INJECTION SEAM (dev-request 2026-08-06-aldri-gjett-
      // epostadresse, SLICE 5 / AC7) ───────────────────────────────────────
      // Slice 2 named the absence of this seam as one of the three reasons
      // the harvest could not be live-wired: this suite drives the router
      // over a REAL http.Server with raw http.request(), so a route handler
      // has no parameter list a test can reach into, and wiring a live fetch
      // into the GET entry page would have made `npm test` fetch
      // route-test-gard.no / enannengard.no for real. gardssalg-claim.ts's
      // module-level __setClaimHarvestFetchForTesting() is that seam — the
      // SAME shape experience-brreg.ts's __setBrregFetchForTesting and
      // bm-events-scraper.ts's __setBmEventsScraperFetchForTesting already
      // use, installed here on the SAME freshly-required module instance
      // __setRfbDbForTesting is installed on one line up.
      //
      // `routeHarvestHtml` is what every harvest fetch in this suite sees;
      // individual sections below reassign it (and reset the harvest cache)
      // to drive a specific scenario. The DEFAULT is an email-free page, so
      // every pre-SLICE-5 assertion in this suite keeps its original answer.
      // routeFetchCalls exists so a test can prove a fetch did or did NOT
      // happen — fetchPage() never rethrows, so a throwing stub could not.
      let routeHarvestHtml = "<html><body><h1>Ingen kontaktinfo her</h1></body></html>";
      let routeFetchCalls: string[] = [];
      claimSvcForRfbOverride.__setClaimHarvestFetchForTesting(((async (input: unknown) => {
        const url = String(input);
        routeFetchCalls.push(url);
        const bytes = new TextEncoder().encode(routeHarvestHtml);
        return {
          ok: true,
          status: 200,
          statusText: "S200",
          url,
          headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as unknown as Response;
      }) as unknown) as typeof fetch);
      claimSvcForRfbOverride.__resetClaimHarvestCacheForTesting();

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
      // RETIRED-TIER UPDATE (dev-request 2026-08-06-aldri-gjett-
      // epostadresse): used to be eligible via the field_provenance-verified
      // hjemmeside marker (tier (b)), deliberately NOT 'manual' — the whole
      // point was a row that stays WRITABLE after the claim (content_source
      // -> 'claim', then owner edits in section (d) below must succeed).
      // Tier (b) is gone; content_source='manual' would ALSO be eligible
      // (tier (c), c-epost) but would lock the row forever, breaking every
      // (d) assertion. So this fixture now goes through (c)'s OTHER
      // sub-case, (b-epost) delivered-outreach-no-bounce — content_source
      // stays 'provider_site' (unlocked), and the matching outreach_sent_log
      // row is seeded right after the rfbDb handle is set up.
      insertProvider.run({
        id: "prov-route-eligible", navn: "Route Test Gård", slug: "route-test-gard",
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://route-test-gard.no",
        content_source: "provider_site",
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/listing/route-test-gard", fetched_at: "2026-07-01T00:00:00Z" } }),
      });
      expDb.prepare("UPDATE experience_providers SET epost = ? WHERE id = ?").run("post@route-test-gard.no", "prov-route-eligible");
      // (b-epost) fixture for prov-route-eligible — a real agents row is
      // inserted too so this holds even if a future change turns FK
      // enforcement on for this DB (mirrors services/gardssalg-claim.test.ts's
      // own identical rationale for its own copy of this fixture).
      rfbDb.prepare(`
        INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
        VALUES ('agent-fixture-route', 'Fixture Agent', 'x', 'test', 'agent-fixture@example.no', 'https://example.no', 'producer', 'fixture-key-route', 1)
      `).run();
      rfbDb.prepare(`
        INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id)
        VALUES ('agent-fixture-route', 'post@route-test-gard.no', datetime('now', '-2 days'), 'email', 'experiences')
      `).run();
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
      // RETIRED-TIER UPDATE: used to be eligible via tier (b) (field_
      // provenance-verified hjemmeside); this section never verifies the
      // token (no owner-portal editability to preserve), so — unlike
      // prov-route-eligible above — a plain content_source='manual' + epost
      // (tier (c), c-epost) is the simplest surviving path and needs no RFB
      // db fixture.
      insertProvider.run({
        id: "prov-route-noleak", navn: "No Leak Gård", slug: "no-leak-gard",
        org_nr: "944444444", brreg_verified: 1, hjemmeside: null,
        content_source: "manual", field_provenance: null,
      });
      expDb.prepare("UPDATE experience_providers SET epost = ? WHERE id = ?").run("post@no-leak-gard.no", "prov-route-noleak");
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

      // RETIRED-TIER UPDATE, dev-request 2026-08-06-aldri-gjett-epostadresse:
      // used to be a genuine two-candidate route fixture (verified own
      // domain [tier (b)] AND a manually-entered second address [tier (c)]
      // both qualifying) — dev-request 2026-08-06-claim-produsent-velger-
      // mottakeradresse's own worked example. Tier (b) is retired, and this
      // PUBLIC route never supplies an explicit brreg_contact address (see
      // routes/gardssalg-claim.ts's issueClaimMagicLink() call, second
      // argument always undefined) — brreg_contact stays dormant here the
      // same way it's dormant in production (gardssalg-claim.ts's own
      // module doc). So a genuine 2-candidate row is no longer reachable
      // through THIS route at all; a real multi-candidate scenario is only
      // reachable service-side today (services/gardssalg-claim.test.ts's
      // own j-series, which supplies brreg_contact explicitly, the way an
      // admin tool can). This fixture is downgraded to single-candidate —
      // see the rewritten k-series below for what it now actually proves.
      insertProvider.run({
        id: "prov-route-two", navn: "To Valg Gård", slug: "to-valg-gard",
        org_nr: "966666666", brreg_verified: 1, hjemmeside: null,
        content_source: "manual", field_provenance: null,
      });
      expDb.prepare("UPDATE experience_providers SET epost = ? WHERE id = ?").run("eier2@gmail.com", "prov-route-two");

      // ── catalog_hidden=1 fixtures (2026-08-17 P0 consent-bug fix, dev-
      // request 2026-08-17-gardssalg-claim-eier-side-catalog-hidden-
      // lekkasje) — mirrors lokal#637's getGardssalgProviderBySlug fixture
      // pattern. Own raw insert (not the shared insertProvider() above,
      // which doesn't carry catalog_hidden) so this doesn't touch the other
      // fixtures' shape. Two rows: one that WOULD otherwise be claim-
      // eligible (has a stored epost), one with zero candidates at all --
      // AC4 requires 404 for both, since the pre-fix code only ever
      // distinguished those two shapes AFTER already confirming the row
      // exists (i.e. both leaked "this slug is a real, delisted producer").
      const insertHiddenProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, hjemmeside, content_source, field_provenance, catalog_hidden,
           enrichment_state, verification_status, source, confidence)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, @brreg_verified, @hjemmeside, @content_source, @field_provenance, 1,
           'raw', 'pending_verify', 'test-fixture', 'medium')
      `);
      insertHiddenProvider.run({
        id: "prov-route-hidden", navn: "Skjult Route Gård", slug: "skjult-route-gard",
        org_nr: "977777777", brreg_verified: 1, hjemmeside: null,
        content_source: "manual", field_provenance: null,
      });
      expDb.prepare("UPDATE experience_providers SET epost = ? WHERE id = ?").run("post@skjultroutegard.no", "prov-route-hidden");
      insertHiddenProvider.run({
        id: "prov-route-hidden-noemail", navn: "Skjult Uten Epost Gård", slug: "skjult-uten-epost-gard",
        org_nr: "988888888", brreg_verified: 1, hjemmeside: null,
        content_source: null, field_provenance: null,
      });

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

      // ── catalog_hidden=1 -> 404 (2026-08-17 P0 consent-bug fix) ─────────
      const hiddenPage = await req("GET", "/kategori/gardssalg/eier/skjult-route-gard");
      assertEq(hiddenPage.status, 404, "a4b: GET entry page for a catalog_hidden=1 provider -> 404 (was previously 200, rendering the provider's name -- the P0 leak this fix closes)");
      assertTrue(!hiddenPage.body.includes("Skjult Route Gård"), "a4c: hidden provider's name never appears anywhere in the 404 response body");
      const hiddenNoEmailPage = await req("GET", "/kategori/gardssalg/eier/skjult-uten-epost-gard");
      assertEq(hiddenNoEmailPage.status, 404, "a4d: catalog_hidden=1 provider with zero email candidates ALSO 404s -- not the 200 manual-fallback page a4 has for a non-hidden 0-candidate provider, which would otherwise still confirm the slug exists");

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

      // ── Producer address selection — dev-request 2026-08-06-claim-
      // produsent-velger-mottakeradresse. REWRITTEN 2026-08-06 for dev-
      // request 2026-08-06-aldri-gjett-epostadresse: see prov-route-two's
      // own fixture comment above for why a genuine 2-candidate row is no
      // longer reachable through this PUBLIC route now that tier (b) is
      // retired (brreg_contact — the only other tier that could pair with
      // stored_epost_verified — is never supplied here). What's left worth
      // proving at THIS route level: the single-candidate render path shows
      // no selection UI, an explicit selection is still validated (not just
      // silently ignored) even when there's nothing to choose between, and
      // the RETIRED tier name specifically is rejected like any other
      // invalid selection — never treated as special/legacy-compatible. ──
      const singleCandidatePage = await req("GET", "/kategori/gardssalg/eier/to-valg-gard");
      assertEq(singleCandidatePage.status, 200, "k1: GET entry page for a single-candidate provider -> 200");
      // NOT a bare `body.includes('name="selected"')` — the page's own
      // inline <script> contains that exact string as JS source text
      // (`form.querySelector('input[name="selected"]:checked')`), which
      // is present on EVERY entry page regardless of candidate count and
      // would make this assertion vacuously true. Require the `<input`
      // element form specifically.
      assertTrue(!singleCandidatePage.body.includes('<input type="radio" name="selected"'), "k2: entry page renders NO selection control (radio input) when there is only one candidate");
      assertEq((singleCandidatePage.body.match(/type="radio"/g) || []).length, 0, "k3: no radios rendered for a single-candidate provider");
      assertTrue(!singleCandidatePage.body.includes("eier2@gmail.com"), "k6: the full address never appears anywhere on the page (AC4)");
      assertTrue(/e\*+2@g\*+\.com/.test(singleCandidatePage.body), "k8: the address IS shown, masked");

      // AC1 REGRESSION GUARD: explicitly selecting the RETIRED tier by name
      // is STILL rejected as invalid_selection on a single-candidate
      // provider — proves selectedSource validation runs regardless of
      // candidate count, never short-circuited to "there's only one, so
      // anything goes".
      const retiredTierSelectionResp = await req("POST", "/kategori/gardssalg/eier/prov-route-two/request", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected: "verified_domain_address" }),
      });
      assertEq(retiredTierSelectionResp.status, 403, "k11: POST selecting the RETIRED verified_domain_address tier by name -> 403, never silently substituted for the real candidate");
      assertEq(JSON.parse(retiredTierSelectionResp.body).error, "invalid_selection", "k12: error body names invalid_selection");

      // No selection at all -> succeeds directly (single-candidate path,
      // no selection_required — that error is reserved for 2+ candidates,
      // which this route can no longer produce).
      const noSelectionResp = await req("POST", "/kategori/gardssalg/eier/prov-route-two/request", {
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assertEq(noSelectionResp.status, 200, "k9: POST request with no selection on a single-candidate provider -> 200, auto-selects the only candidate");
      const soloClaimRow = expDb.prepare("SELECT email, email_source FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at DESC LIMIT 1").get("prov-route-two") as any;
      assertEq(soloClaimRow?.email, "eier2@gmail.com", "k14: issued claim targets the provider's only qualifying address");
      assertEq(soloClaimRow?.email_source, "stored_epost_verified", "k15: persisted with the (only surviving) stored_epost_verified source");

      // An explicit selection that DOES match the one real candidate also
      // succeeds — the no-JS form-POST path (urlencoded, mirrors a real
      // browser submitting a form field natively).
      const selectEpostResp = await req("POST", "/kategori/gardssalg/eier/prov-route-two/request", {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "selected=stored_epost_verified",
      });
      assertEq(selectEpostResp.status, 303, "k16: no-JS form POST with a matching explicit selection -> 303 redirect");
      assertTrue(String(selectEpostResp.headers.location || "").includes("status=sent"), "k17: redirects to status=sent");

      // AC6: rate limit is unchanged by any of this — invalid_selection
      // (k11) returns before the rate-limit check and before any DB insert,
      // so it does NOT consume a slot; k9 and k16 above are the only 2
      // successful issues so far. A 3rd successful request still succeeds,
      // a 4th is blocked.
      const thirdSelectResp = await req("POST", "/kategori/gardssalg/eier/prov-route-two/request", {
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assertEq(thirdSelectResp.status, 200, "k20: 3rd request on this provider still succeeds (limit is 3)");
      const fourthSelectResp = await req("POST", "/kategori/gardssalg/eier/prov-route-two/request", {
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assertEq(fourthSelectResp.status, 429, "k21: AC6 — the 4th request is rate-limited");

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

      // ── (g) dev-request 2026-08-06-eier-ser-reserver-knapp-paa-egen-
      // profil: GET /api/opplevelser/gardssalg-claim/:providerId/session-
      // status — the client-side-only owner-CTA-swap endpoint. Session
      // still valid here (asserted before the (e) logout block below,
      // which revokes it). ─────────────────────────────────────────────

      // g1: no session cookie at all -> isOwner:false (never a 401/403 —
      // this endpoint always answers a plain boolean, fails closed).
      const statusNoAuth = await req("GET", "/api/opplevelser/gardssalg-claim/prov-route-eligible/session-status");
      assertEq(statusNoAuth.status, 200, "g1: GET session-status with no cookie -> 200 (not 401)");
      assertEq(JSON.parse(statusNoAuth.body), { isOwner: false }, "g1b: no session -> isOwner:false");
      assertEq(statusNoAuth.headers["cache-control"], "no-store", "g1c: no-store cache header present even on the no-session path");

      // g2: valid session, matching providerId -> isOwner:true.
      const statusOwn = await req("GET", "/api/opplevelser/gardssalg-claim/prov-route-eligible/session-status", { headers: { Cookie: cookieHeader } });
      assertEq(statusOwn.status, 200, "g2: GET session-status with a valid session for THIS provider -> 200");
      assertEq(JSON.parse(statusOwn.body), { isOwner: true }, "g2b: valid session + matching providerId -> isOwner:true");
      assertEq(statusOwn.headers["cache-control"], "no-store", "g2c: no-store cache header present on the isOwner:true path (this response must never be cached/reused for another visitor)");

      // g3: valid session, but a DIFFERENT provider's id in the URL ->
      // isOwner:false. Same session as g2, only the path providerId changes.
      const statusOther = await req("GET", "/api/opplevelser/gardssalg-claim/prov-route-other/session-status", { headers: { Cookie: cookieHeader } });
      assertEq(statusOther.status, 200, "g3: GET session-status for a DIFFERENT provider with a valid-but-mismatched session -> 200");
      assertEq(JSON.parse(statusOther.body), { isOwner: false }, "g3b: valid session for provider A queried against provider B -> isOwner:false (never leaks A's session validity)");
      assertEq(statusOther.headers["cache-control"], "no-store", "g3c: no-store cache header present on the cross-provider path too");

      // g4: invalid/bogus session cookie -> isOwner:false, no throw.
      const statusBogus = await req("GET", "/api/opplevelser/gardssalg-claim/prov-route-eligible/session-status", { headers: { Cookie: "oa_owner_session=totally-bogus-token" } });
      assertEq(statusBogus.status, 200, "g4: GET session-status with an invalid/unknown session token -> 200 (fails closed, not an error)");
      assertEq(JSON.parse(statusBogus.body), { isOwner: false }, "g4b: invalid session token -> isOwner:false");

      // ── (e) logout really revokes ───────────────────────────────────────
      const logout = await req("POST", "/kategori/gardssalg/eier/route-test-gard/logout", { headers: { Cookie: cookieHeader } });
      assertEq(logout.status, 303, "e1: POST logout -> 303 redirect");

      const afterLogout = await req("GET", "/api/opplevelser/gardssalg-claim/prov-route-eligible/profile", { headers: { Cookie: cookieHeader } });
      assertEq(afterLogout.status, 401, "e2: the SAME (pre-logout) session cookie no longer authenticates after logout — a real revoke, not just a cookie-clear");

      // ── (w) SLICE 5 / AC7 live-wiring, at the HTTP level ────────────────
      // These are the route-level counterpart of the service suite's own
      // w-series. What they pin is specifically the thing the dev-request's
      // live measurement found missing in production: the PUBLIC, unauthenticated
      // entry page and the POST it submits to must both go through the
      // harvest, agree with each other, and stop offering a producer nothing
      // when their own website publishes a perfectly good address.
      //
      // `prov-route-found` deliberately has NO stored epost, NO brreg contact
      // and content_source='provider_site' — under slice 1 alone it is
      // claim-dead (the entry page would show the manual fallback), which is
      // exactly the 0/87 cohort state. Its hjemmeside is ownership-verified
      // via the field_provenance stamp, the shape the admin website-approval
      // queue produces.
      insertProvider.run({
        id: "prov-route-found", navn: "Funnet Rute Gård", slug: "funnet-rute-gard",
        org_nr: "977777771", brreg_verified: 1, hjemmeside: "https://funnet-rute-gard.no",
        content_source: "provider_site",
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/listing/funnet-rute-gard", fetched_at: "2026-07-01T00:00:00Z" } }),
      });

      routeHarvestHtml = `<html><body><h1>Funnet Rute Gård</h1><p>E-post: post@funnet-rute-gard.no</p></body></html>`;
      routeFetchCalls = [];
      claimSvcForRfbOverride.__resetClaimHarvestCacheForTesting();

      const foundPage = await req("GET", "/kategori/gardssalg/eier/funnet-rute-gard");
      assertEq(foundPage.status, 200, "w1: GET entry page for a harvest-only-eligible provider -> 200");
      assertTrue(foundPage.body.includes("Send meg tilgangslenke"), "w2: SLICE 5 — the entry page now offers the self-service link to a producer whose ONLY address was found on their own verified website (before wiring: manual fallback only — the measured 0/87 state)");
      assertTrue(!foundPage.body.includes("post@funnet-rute-gard.no"), "w3: ...and still never renders the full address, only a masked form (unchanged AC4 invariant)");
      assertTrue(/p\*+t@f\*+\.no/.test(foundPage.body), "w4: ...the masked form really is that of the harvested address");
      assertTrue(routeFetchCalls.includes("https://funnet-rute-gard.no"), "w5: ...and the page genuinely fetched the producer's own site through the injected fetch (never the real network)");

      // (w6) The cache: reloading the same public page inside the TTL costs
      // the producer's website nothing. This is the concrete protection the
      // CLAIM_HARVEST_CACHE_TTL_MS judgment call exists for — an unauthenticated
      // visitor holding down reload must not become a request amplifier.
      const fetchesAfterFirstView = routeFetchCalls.length;
      const foundPageAgain = await req("GET", "/kategori/gardssalg/eier/funnet-rute-gard");
      assertEq(foundPageAgain.status, 200, "w6: a reload of the same entry page -> 200");
      assertTrue(foundPageAgain.body.includes("Send meg tilgangslenke"), "w6b: ...still offering the link (the cached harvest is a real result, not an empty placeholder)");
      assertEq(routeFetchCalls.length, fetchesAfterFirstView, "w7: ...with ZERO additional outbound fetches — repeat unauthenticated page views reuse the cached harvest for the TTL");

      // (w8-w10) The POST agrees with what the page offered: same provider,
      // same harvest cache key, so a link really is issued and really is
      // stamped with the found tier.
      const foundReq = await req("POST", "/kategori/gardssalg/eier/prov-route-found/request", {
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assertEq(foundReq.status, 200, "w8: POST request-magic-link succeeds end to end for the harvest-only provider (page and POST agree — the invariant the GET handler's own comment states)");
      const foundClaimRow = expDb.prepare("SELECT email, email_source FROM gardssalg_claims WHERE provider_id = ? ORDER BY created_at DESC LIMIT 1").get("prov-route-found") as any;
      assertEq(foundClaimRow?.email, "post@funnet-rute-gard.no", "w9: the issued claim targets the address actually found on the producer's page");
      assertEq(foundClaimRow?.email_source, "found_same_domain", "w10: ...persisted with email_source='found_same_domain'");

      // (w11) A producer whose site publishes nothing usable still falls
      // through to the manual fallback — "empty is better than guessed"
      // (AC1) survives the wiring; nothing here invents an address from the
      // known-good domain just because the fetch succeeded.
      insertProvider.run({
        id: "prov-route-silent", navn: "Stille Rute Gård", slug: "stille-rute-gard",
        org_nr: "977777772", brreg_verified: 1, hjemmeside: "https://stille-rute-gard.no",
        content_source: "provider_site",
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/listing/stille-rute-gard", fetched_at: "2026-07-01T00:00:00Z" } }),
      });
      routeHarvestHtml = "<html><body><h1>Stille Rute Gård</h1><p>Ingen e-post her.</p></body></html>";
      claimSvcForRfbOverride.__resetClaimHarvestCacheForTesting();
      const silentPage = await req("GET", "/kategori/gardssalg/eier/stille-rute-gard");
      assertEq(silentPage.status, 200, "w11: GET entry page for a verified-site provider whose site publishes no address -> 200");
      assertTrue(!silentPage.body.includes("Send meg tilgangslenke"), "w12: AC1 REGRESSION GUARD — no address found means no self-service offer; the wiring never synthesizes post@stille-rute-gard.no from the (verified, known) domain");
      assertTrue(silentPage.body.includes("kontakt@opplevagent.no"), "w13: ...the manual fallback is shown instead");

      // Restore the suite default so nothing after this block inherits a
      // page with an address on it.
      routeHarvestHtml = "<html><body><h1>Ingen kontaktinfo her</h1></body></html>";
      claimSvcForRfbOverride.__resetClaimHarvestCacheForTesting();
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
        // SLICE 5 / AC7 — same discipline as the RFB-db override: a leftover
        // fetch override would silently answer a LATER suite's harvest, and a
        // leftover cache entry would silently answer its first call.
        claimSvcForRfbOverride.__setClaimHarvestFetchForTesting(undefined);
        claimSvcForRfbOverride.__resetClaimHarvestCacheForTesting();
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
