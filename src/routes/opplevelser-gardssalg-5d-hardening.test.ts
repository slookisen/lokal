/**
 * opplevelser-gardssalg-5d-hardening.test.ts — slice 5d (shared-/directory-
 * domain guard + crawl containment) and the slice-5b integration-hardening
 * round (dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach;
 * findings B1/B2/M1/M2/M3/M5 from the 2026-07-19 independent review of the
 * combined train):
 *
 *   5d      — content-refresh excludes providers whose hjemmeside is on a
 *             curated directory/aggregator host (cross-source-validator's
 *             classifier — suffix-walk covers subdomains), a visit* DMO
 *             domain, or a host shared by 2+ catalog providers; excluded
 *             rows are attempt-stamped in apply mode (B2 — no queue
 *             starvation) and reported in excluded_shared_domain; the
 *             sub-page crawl stays inside the stored URL's section (M1 —
 *             including the no-trailing-slash form).
 *   B1      — exact_ties > 1 (two 1.0-scoring Brreg hits) vetoes the write;
 *             a bankrupt/deregistered exact match (verifyOrgNumber) vetoes.
 *   M2      — postnummer conflict across postal regions vetoes poststed-name
 *             corroboration.
 *   M3      — a rolled-back org_nr is never silently re-applied.
 *   M5      — a display-suffix-stripped search name demands exact postnummer
 *             corroboration (and the strip is what makes «Navn — Sted» rows
 *             auto-fillable at all).
 *
 * Same conventions as the sibling gårdssalg route test files: :memory: DB,
 * fresh requires (incl. brreg-client — its per-process caches must not leak
 * across runs), router.handle(), mocked globalThis.fetch.
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
  opts: { url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url || "/admin/gardssalg-orgnr-backfill";
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalg5dHardeningTests(
  log = false,
): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevFetch = globalThis.fetch;
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-5d-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANTHROPIC_API_KEY; // 5d content tests must never LLM-call

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const brregClientPath = require.resolve("../services/brreg-client");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, brregClientPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      // ═══ Section A — pure decision functions ═══════════════════════════
      assertEq(expStore.gardssalgSearchName("Ægir Bryggeri — Flåm"), "Ægir Bryggeri",
        "5h-a1: spaced em-dash display suffix stripped before search");
      assertEq(expStore.gardssalgSearchName("Hardanger Saft- og Siderfabrikk"), "Hardanger Saft- og Siderfabrikk",
        "5h-a2: inner compound hyphen untouched");
      assertEq(expStore.gardssalgSharedDomainReason("hanen.no"), "blocklisted_directory_domain",
        "5h-a3: hanen.no via curated classifier");
      assertEq(expStore.gardssalgSharedDomainReason("en.hanen.no"), "blocklisted_directory_domain",
        "5h-a4: SUBDOMAIN of a curated host caught (suffix-walk — B3 regression)");
      assertEq(expStore.gardssalgSharedDomainReason("visitfjordbygda.no"), "dmo_visit_domain",
        "5h-a5: visit* DMO prefix class catches boards the curated list does not know yet");
      assertEq(expStore.gardssalgSharedDomainReason("visittelemark.no"), "blocklisted_directory_domain",
        "5h-a5b: a curated-listed visit board is caught by layer 1 (either layer suffices)");
      assertEq(expStore.gardssalgSharedDomainReason("egetbryggeri.no"), null,
        "5h-a6: ordinary own domain passes");
      // M2 — postnummer-region conflict vetoes poststed-name corroboration.
      assertEq(expStore.gardssalgOrgnrPostalCorroborated(
        { postnummer: "4460", poststed: "Vik" }, { brreg_postal: "6893", brreg_poststed: "VIK" }), false,
        "5h-a7: same poststed NAME in a different postal region → NOT corroborated (M2 veto)");
      assertEq(expStore.gardssalgOrgnrPostalCorroborated(
        { postnummer: "5701", poststed: "Voss" }, { brreg_postal: "5705", brreg_poststed: "VOSS" }), true,
        "5h-a8: same-region postnummer mismatch still falls through to poststed equality");
      assertEq(expStore.gardssalgOrgnrPostalCorroborated(
        { postnummer: "5743", poststed: null }, { brreg_postal: "5743", brreg_poststed: null }), true,
        "5h-a9: exact postnummer still corroborates");

      // ═══ Fixtures ═══════════════════════════════════════════════════════
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, org_nr, postnummer, poststed, kommune, catalog_hidden, products, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, NULL, @org_nr, @postnummer, @poststed, NULL, @catalog_hidden, '["x"]', @field_provenance,
            'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      // dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
      // Steg 3 follow-up: POST /admin/gardssalg-content-refresh now fail-
      // closed-gates its fetch on field_provenance.hjemmeside_verification.
      // verified === true (see isHjemmesideVerified() in routes/opplevelser.ts).
      // This file's Section B fixtures are about the shared-domain-exclusion
      // and crawl-base behavior AFTER a fetch is reached (or correctly
      // excluded before it) — not about the verification gate itself (see
      // opplevelser-gardssalg-fillblank.test.ts for the gate's own dedicated
      // tests) — so every fixture is stamped verified by default.
      const VERIFIED_PROVENANCE_5H = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
      });
      const P = (o: Record<string, unknown>) => insertProvider.run({
        hjemmeside: null, org_nr: null, postnummer: null, poststed: null, catalog_hidden: null,
        field_provenance: VERIFIED_PROVENANCE_5H, ...o,
      });

      // 5d content-refresh fixtures
      P({ id: "p5-hanen", navn: "Hanen Medlem", hjemmeside: "https://en.hanen.no/medlem/gard-x" });
      P({ id: "p5-visit", navn: "Visit Gard", hjemmeside: "https://visitfjordbygda.no/gard-y" });
      P({ id: "p5-shared-a", navn: "Delt A", hjemmeside: "https://sharedgard.example.no/a" });
      P({ id: "p5-shared-b", navn: "Delt B", hjemmeside: "https://www.sharedgard.example.no/b" });
      // komplett-foer-synlig (2026-07-19): hidden REAL rows now DO count in
      // gardssalgSharedHostCounts (the contamination guard must see hidden
      // discovery batches under enrichment) — the co-host that must NOT
      // poison p5-alone's count is the booking-flyt TEST provider, excluded
      // by its stable producer_type marker. Fixture matches that shape.
      expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, catalog_hidden, products, producer_type, enrichment_state, verification_status, source, confidence)
         VALUES ('p5-hiddenshare', 'Test Deler', 'experiences', 'https://aleine.example.no/x', 1, '["x"]', 'test-gardssalg', 'raw', 'pending_verify', 'test-fixture', 'medium')`
      ).run();
      P({ id: "p5-alone", navn: "Aleine Gard", hjemmeside: "https://aleine.example.no/side/gard" });
      // 5b hardening fixtures
      P({ id: "p5-tie", navn: "Solbakken Gard", postnummer: "1111", poststed: "Solbygd" });
      P({ id: "p5-dead", navn: "Konkursgard", postnummer: "2222", poststed: "Dødsbygd" });
      P({ id: "p5-strip-bad", navn: "Strippet Gard — Fjellbygda", postnummer: "3333", poststed: "Fjellbygda" });
      P({ id: "p5-strip-ok", navn: "Testbryggeriet Nord — Fjordbygda", postnummer: "9999", poststed: "Fjordbygda" });
      P({ id: "p5-rolledback", navn: "Angret Gard", postnummer: "4444", poststed: "Angrebygd" });

      // Pre-existing rollback audit row for p5-rolledback (latest for org_nr).
      expDb.prepare(
        `INSERT INTO gardssalg_content_audit (id, provider_id, field_name, old_value, new_value, source_url, changed_by, changed_at)
         VALUES ('aud-rb-1','p5-rolledback','org_nr','977000111',NULL,'internal://rollback','admin', datetime('now'))`
      ).run();
      assertEq(expStore.gardssalgOrgnrWasRolledBack("p5-rolledback"), true,
        "5h-a10: rolled-back detector reads the latest org_nr audit row");
      assertEq(expStore.gardssalgOrgnrWasRolledBack("p5-tie"), false,
        "5h-a11: providers without rollback history are not flagged");

      // Shared-host counts: the TEST provider must not count (komplett-foer-
      // synlig revision of M4 — hidden real rows DO count now; the wd-7
      // block in opplevelser-gardssalg-website-discovery.test.ts pins the
      // hidden-row-counts side).
      {
        const counts = expStore.gardssalgSharedHostCounts();
        assertEq(counts.get("sharedgard.example.no"), 2, "5h-a12: www-folded shared host counted across both rows");
        assertEq(counts.get("aleine.example.no"), 1,
          "5h-a13: test-provider co-host does NOT count toward shared-host exclusion (marker-based, not hidden-based)");
      }

      // ═══ Section B — content-refresh: exclusion + B2 stamp + crawl base ══
      const fetchedPageUrls: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("data.brreg.no") || urlStr.includes("api.anthropic.com")) {
          throw new Error(`unexpected non-page fetch in 5d content tests: ${urlStr}`);
        }
        fetchedPageUrls.push(urlStr);
        const html5h = `<html><head><meta property="og:description" content="Aleine gard med gardsbutikk, servering og omvisning for grupper hele sesongen — velkomen innom for smaksprøver av eigen produksjon."></head><body><p>Velkomen.</p></body></html>`;
        return {
          ok: true, status: 200,
          text: async () => html5h,
          arrayBuffer: async () => new TextEncoder().encode(html5h).buffer,
          headers: { get: () => null },
        } as unknown as Response;
      }) as unknown as typeof fetch;

      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-content-refresh",
          body: { providerIds: ["p5-hanen", "p5-visit", "p5-shared-a", "p5-shared-b", "p5-alone"], apply: true },
        });
        assertEq(r.status, 200, "5h-b1: content-refresh 200");
        const byId: Record<string, string> = {};
        for (const e of (r.body.excluded_shared_domain as any[]) || []) byId[e.provider_id] = e.reason;
        assertEq(byId["p5-hanen"], "blocklisted_directory_domain", "5h-b2: hanen SUBDOMAIN page excluded via curated classifier");
        assertEq(byId["p5-visit"], "dmo_visit_domain", "5h-b3: visit* DMO excluded");
        assertEq(byId["p5-shared-a"], "shared_host_multiple_providers", "5h-b4: shared host A excluded");
        assertEq(byId["p5-shared-b"], "shared_host_multiple_providers", "5h-b5: shared host B excluded (www variant folded)");
        assertTrue(!("p5-alone" in byId), "5h-b6: single-owner domain NOT excluded (test-provider co-host doesn't count)");
        assertTrue(!fetchedPageUrls.some((u) => /hanen\.no|visitfjordbygda|sharedgard/.test(u)),
          "5h-b7: excluded providers never touched the network");
        // B2: excluded rows are attempt-stamped in apply mode → they cycle
        // to the back of the auto-select queue instead of starving it.
        const stamped = expDb.prepare(
          `SELECT COUNT(*) c FROM experience_providers
            WHERE id IN ('p5-hanen','p5-visit','p5-shared-a','p5-shared-b')
              AND last_content_attempt_at IS NOT NULL`
        ).get() as any;
        assertEq(stamped.c, 4, "5h-b8: ALL excluded providers attempt-stamped in apply mode (B2 anti-starvation)");
        // M1 crawl base: no-trailing-slash extensionless path is its own section.
        assertTrue(fetchedPageUrls.some((u) => u === "https://aleine.example.no/side/gard"),
          "5h-b9: stored page itself fetched");
        assertTrue(fetchedPageUrls.some((u) => u.startsWith("https://aleine.example.no/side/gard/")),
          "5h-b10: sub-pages crawled UNDER the extensionless stored path (M1 no-slash form)");
        // Path list kept in sync with GARDSSALG_CONTENT_PATHS (dev-request
        // 2026-08-10-produktnavn-uttrekk-blokkerer-28-rader, Skive 2 added
        // the product-oriented entries) — this assertion is only meaningful
        // if it covers every candidate the crawl actually tries.
        assertTrue(!fetchedPageUrls.some((u) => /^https:\/\/aleine\.example\.no\/(produkter|nettbutikk|kontakt|sortiment|besok|produkt|besøk|vare-produkter|om-oss|varer|om|ol|øl|smaking|smaksprover|smaksprøver|apningstider|åpningstider)$/.test(u)),
          "5h-b11: host-root sub-pages never fetched for a deep-path hjemmeside");
      }

      // ═══ Section C — backfill write-bar veto chain ══════════════════════
      const searchResponses: Record<string, any[]> = {
        // B1a: TWO exact-name hits (ENK vs AS prune identically) — ambiguous.
        "Solbakken Gard": [
          { organisasjonsnummer: "911000111", navn: "SOLBAKKEN GARD",
            forretningsadresse: { postnummer: "1111", poststed: "SOLBYGD" } },
          { organisasjonsnummer: "911000222", navn: "SOLBAKKEN GARD AS",
            forretningsadresse: { postnummer: "1111", poststed: "SOLBYGD" } },
        ],
        // B1b: single exact + corroborated hit, but the org is bankrupt.
        "Konkursgard": [
          { organisasjonsnummer: "922000111", navn: "KONKURSGARD AS",
            forretningsadresse: { postnummer: "2222", poststed: "DØDSBYGD" } },
        ],
        // M5-bad: stripped name; exact hit corroborates via postSTED only.
        "Strippet Gard": [
          { organisasjonsnummer: "933000111", navn: "STRIPPET GARD AS",
            forretningsadresse: { postnummer: "7777", poststed: "FJELLBYGDA" } },
        ],
        // M5-ok: stripped name; exact hit with EXACT postnummer.
        "Testbryggeriet Nord": [
          { organisasjonsnummer: "944000111", navn: "TESTBRYGGERIET NORD AS",
            forretningsadresse: { postnummer: "9999", poststed: "FJORDBYGDA" } },
        ],
        // M3: exact + corroborated, but the row was rolled back by a human.
        "Angret Gard": [
          { organisasjonsnummer: "977000111", navn: "ANGRET GARD AS",
            forretningsadresse: { postnummer: "4444", poststed: "ANGREBYGD" } },
        ],
      };
      const detailBodies: Record<string, any> = {
        "922000111": { organisasjonsnummer: "922000111", navn: "KONKURSGARD AS", konkurs: true },
      };
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (!urlStr.includes("data.brreg.no")) throw new Error(`unexpected fetch in veto tests: ${urlStr}`);
        const detailMatch = urlStr.match(/\/enheter\/(\d{9})$/);
        if (detailMatch) {
          const body = detailBodies[detailMatch[1]] ?? { organisasjonsnummer: detailMatch[1], navn: "SUNN AS" };
          return { ok: true, status: 200, json: async () => body } as unknown as Response;
        }
        const navn = decodeURIComponent((urlStr.match(/[?&]navn=([^&]*)/) || [])[1] || "");
        return {
          ok: true, status: 200,
          json: async () => ({ _embedded: { enheter: searchResponses[navn] ?? [] } }),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { apply: true, providerIds: ["p5-tie", "p5-dead", "p5-strip-bad", "p5-strip-ok", "p5-rolledback"] },
        });
        const reasons: Record<string, string> = {};
        for (const u of (r.body.unresolved as any[]) || []) reasons[u.provider_id] = u.reason;
        assertEq(reasons["p5-tie"], "ambiguous_exact_name_ties", "5h-c1: two 1.0 hits → tie veto (B1a)");
        assertEq(reasons["p5-dead"], "brreg_not_active", "5h-c2: bankrupt exact match → liveness veto (B1b)");
        assertEq(reasons["p5-strip-bad"], "stripped_name_requires_postal_match",
          "5h-c3: stripped search name + poststed-only corroboration → veto (M5)");
        assertEq(reasons["p5-rolledback"], "previously_rolled_back", "5h-c4: rolled-back row → veto (M3)");
        assertEq(r.body.agents_enriched, 1, "5h-c5: exactly ONE write survived the veto chain");
        assertEq((r.body.changed as any[])[0]?.provider_id, "p5-strip-ok",
          "5h-c6: the stripped-name row WITH exact postnummer match is the one written");
        const row = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id='p5-strip-ok'`).get() as any;
        assertEq(row.org_nr, "944000111",
          "5h-c7: suffix-strip made the «Navn — Sted» row auto-fillable (the recall half of M5)");
        for (const id of ["p5-tie", "p5-dead", "p5-strip-bad", "p5-rolledback"]) {
          const rr = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id=?`).get(id) as any;
          assertEq(rr.org_nr, null, `5h-c8-${id}: vetoed row has NO org_nr written`);
        }
        const queued = expDb.prepare(
          `SELECT COUNT(*) c FROM gardssalg_orgnr_review_queue WHERE provider_id IN ('p5-tie','p5-dead','p5-strip-bad','p5-rolledback')`
        ).get() as any;
        assertEq(queued.c, 4, "5h-c9: every veto landed a durable review-queue entry");
      }

      // ── (d) link-driven sub-page crawl stays inside the stored section ───
      //
      // Daniel, live session 2026-08-14. crFetchGardssalgContent now follows
      // the page's REAL links (discoverContentLinks) instead of guessing fixed
      // paths, because the guessing was measured at 7 hits per 92 attempts and
      // left 7 of 12 producer sites with no sub-page read at all.
      //
      // The existing 5h-b10/b11 assertions above cannot cover this: their
      // fixture HTML has no <a> elements, so discovery returns nothing and the
      // crawl falls through to the fixed-path fallback. They guard the FALLBACK
      // branch only. This block serves HTML that DOES link out — including a
      // link that escapes the stored section — so the section filter on the new
      // primary branch is actually exercised.
      //
      // Escaping matters: discoverContentLinks is same-HOST but not
      // same-SECTION, and a deep-path hjemmeside is exactly the 2026-07-19
      // hanen.no shape where the host root describes a different organisation.
      {
        const seen: string[] = [];
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = String(url);
          if (urlStr.includes("data.brreg.no") || urlStr.includes("api.anthropic.com")) {
            throw new Error(`unexpected non-page fetch in 5h-d: ${urlStr}`);
          }
          seen.push(urlStr);
          const html =
            `<html><head><meta property="og:description" content="Aleine gard med gardsbutikk og omvisning for grupper heile sesongen."></head>` +
            `<body><p>Velkomen.</p>` +
            `<a href="/side/gard/kontakt-oss">Kontakt oss</a>` +
            `<a href="/andre/produkter">Produkter hos ein annan aktør</a>` +
            `</body></html>`;
          return {
            ok: true, status: 200,
            text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }) as unknown as typeof fetch;

        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/gardssalg-content-refresh",
          body: { providerIds: ["p5-alone"], apply: true },
        });
        assertEq(r.status, 200, "5h-d1: content-refresh 200 on the link-driven path");

        assertTrue(
          seen.some((u) => u === "https://aleine.example.no/side/gard/kontakt-oss"),
          "5h-d2: the real in-section link IS followed — this is the branch that was never reached before",
        );
        assertTrue(
          !seen.some((u) => u.includes("/andre/produkter")),
          "5h-d3: a same-host link OUTSIDE the stored section is NOT followed (hanen.no cross-contamination guard holds on the discovery branch)",
        );
        // With real links present the fixed-path sweep must not also run —
        // topping discovered links up with guesses is the waste this replaced.
        assertTrue(
          !seen.some((u) => /\/side\/gard\/(produkter|nettbutikk|sortiment|varer|smaking)$/.test(u)),
          "5h-d4: fixed-path guessing is skipped entirely when real links were found",
        );
      }

      // ── (e) headless escalation for JS-built producer sites ──────────────
      //
      // Daniel, live session 2026-08-15. 67northdistillery.no serves 180 KB of
      // HTML that yields 19 visible characters, so about_text/products can
      // never be extracted from the source and the row is stuck forever.
      //
      // The load-bearing property these tests protect is WHERE the escalation
      // happens: on the primary page, BEFORE link discovery. A shell has no
      // links either, so rendering only for text extraction would leave the
      // sub-page crawl blind. 5h-e4 is the assertion that proves the ordering.
      //
      // Browser-free by construction — the render impl is injected, so the
      // `npm test` gate never reaches a browser or the render worker.
      {
        const opplevelserMod = require("./opplevelser") as typeof import("./opplevelser");
        const prevFlag = process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED;

        // A JS shell: big, scripted, no text, and — critically — no links.
        const shell =
          `<html><head><title>Aleine Gard</title><script src="/app.js"></script></head>` +
          `<body><div id="root"></div><div data-x="${"a".repeat(9_000)}"></div></body></html>`;
        // What the browser produces: real text AND a real link.
        const renderedHtml =
          `<html><head><title>Aleine Gard</title></head><body>` +
          `<p>${"Aleine Gard held til i Hardanger og lagar sider av eigne eple. ".repeat(6)}</p>` +
          `<a href="/side/gard/kontakt-oss">Kontakt oss</a></body></html>`;

        const mkFetch = (seen: string[]) =>
          (async (url: string | URL | Request) => {
            const urlStr = String(url);
            if (urlStr.includes("data.brreg.no") || urlStr.includes("api.anthropic.com")) {
              throw new Error(`unexpected non-page fetch in 5h-e: ${urlStr}`);
            }
            seen.push(urlStr);
            return {
              ok: true, status: 200,
              text: async () => shell,
              arrayBuffer: async () => new TextEncoder().encode(shell).buffer,
              headers: { get: () => null },
            } as unknown as Response;
          }) as unknown as typeof fetch;

        // ── flag OFF: the shell is never escalated, whatever it looks like ──
        {
          delete process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED;
          let renderCalls = 0;
          opplevelserMod.__setGardssalgRenderPageImplForTesting(async () => {
            renderCalls++;
            return { ok: true, html: renderedHtml, text: "x", finalUrl: "https://aleine.example.no/side/gard", elapsedMs: 1 };
          });
          const seen: string[] = [];
          globalThis.fetch = mkFetch(seen);
          await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            url: "/admin/gardssalg-content-refresh",
            body: { providerIds: ["p5-alone"], apply: false },
          });
          assertEq(renderCalls, 0, "5h-e1: with the flag OFF a JS shell is never escalated — the kill switch actually holds");
        }

        // ── flag ON: the shell IS escalated, and the render drives the crawl ──
        {
          process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED = "true";
          let renderCalls = 0;
          let renderedUrl = "";
          opplevelserMod.__setGardssalgRenderPageImplForTesting(async (url: string) => {
            renderCalls++;
            renderedUrl = url;
            return { ok: true, html: renderedHtml, text: "x", finalUrl: "https://aleine.example.no/side/gard", elapsedMs: 1 };
          });
          const seen: string[] = [];
          globalThis.fetch = mkFetch(seen);
          await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            url: "/admin/gardssalg-content-refresh",
            body: { providerIds: ["p5-alone"], apply: false },
          });
          assertEq(renderCalls, 1, "5h-e2: with the flag ON the JS shell escalates to the renderer exactly once");
          assertEq(
            renderedUrl,
            "https://aleine.example.no/side/gard",
            "5h-e3: the renderer is handed the page's own final url, not the host root",
          );
          // THE ordering assertion: the link only exists in the RENDERED html.
          // If escalation ran after link discovery (or only fed text extraction)
          // this sub-page could never be reached.
          assertTrue(
            seen.some((u) => u === "https://aleine.example.no/side/gard/kontakt-oss"),
            "5h-e4: a link that exists ONLY in the rendered DOM is crawled — escalation happens before link discovery",
          );
        }

        // ── a render failure must not fail the row ──────────────────────────
        {
          process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED = "true";
          opplevelserMod.__setGardssalgRenderPageImplForTesting(async () => ({
            ok: false, reason: "render_timeout", detail: "Timeout 25000ms exceeded.", elapsedMs: 25_000,
          }));
          const seen: string[] = [];
          globalThis.fetch = mkFetch(seen);
          const r = await callRoute(opplevelserRouter, {
            headers: adminHeaders,
            url: "/admin/gardssalg-content-refresh",
            body: { providerIds: ["p5-alone"], apply: false },
          });
          assertEq(r.status, 200, "5h-e5: a render failure is non-fatal — the row keeps its raw HTML and the route still 200s");
          assertTrue(
            seen.some((u) => u === "https://aleine.example.no/side/gard"),
            "5h-e6: the primary page was still fetched and used after the render failed",
          );
        }

        opplevelserMod.__setGardssalgRenderPageImplForTesting(null);
        if (prevFlag === undefined) delete process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED;
        else process.env.GARDSSALG_HEADLESS_FALLBACK_ENABLED = prevFlag;
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-5d-hardening: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}
