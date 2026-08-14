/**
 * opplevelser-gardssalg-website-verification.test.ts — route-level tests for
 * dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
 * Steg 3 ("nettside-verifisering-i-berikelse"), scoped-down slice:
 *
 *   - GET  /admin/gardssalg-website-verification-audit        (Part A, dry-run)
 *   - POST /admin/gardssalg-website-verification-remediation  (Part B, write)
 *
 * The pure classification-logic tests (classifyGardssalgProducerWebsite,
 * incl. the negative-control shared-word case) live in
 * services/gardssalg-website-verification.test.ts — this file exercises the
 * same shapes end-to-end through the real HTTP routes, a real (in-memory)
 * DB, and the field_provenance/audit-table/review-queue write machinery
 * those pure tests don't touch.
 *
 * Mirrors opplevelser-gardssalg-retro-scan.test.ts's setup (EXPERIENCES_DB_
 * PATH=":memory:", fresh require of db-factory + experience-store +
 * opplevelser router per run, callRoute() exercising router.handle()
 * directly with X-Admin-Key via headers) and mocks globalThis.fetch, keyed
 * by hostname, for the underlying crFetchGardssalgContent crawl — exactly
 * the same mocking convention, since this slice reuses that SAME fetcher.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key on both endpoints
 *   (b) GET .../gardssalg-website-verification-audit classifies a mixed
 *       cohort correctly: verified (org_nr match), unverified (fetch 404),
 *       aggregator (hanen.no, never fetched), missing_source (blank
 *       hjemmeside) — and performs ZERO writes
 *   (c) hidden producers (catalog_hidden=1) are excluded from the cohort
 *       BY DEFAULT — never appear in a no-scope GET report. Section (h)
 *       covers the explicit scope=hidden/all opt-ins (Daniel's 2026-08-01
 *       live override) and that a typo'd scope is a 400, never a silent
 *       visible-only run
 *   (d) POST .../gardssalg-website-verification-remediation dry-run: zero
 *       writes anywhere (field_provenance, audit table, review queue all
 *       untouched), reports would_enqueue containing only unverified rows
 *   (e) POST .../gardssalg-website-verification-remediation apply=true:
 *       writes field_provenance.hjemmeside_verification for EVERY
 *       classification (not just unverified), inserts one
 *       gardssalg_website_verification_audit row per write, and enqueues
 *       ONLY the unverified row into gardssalg_website_review_queue with
 *       reason 'verification_failed'
 *   (f) idempotent re-run: applying twice with unchanged classifications
 *       does not duplicate/re-touch the already-queued review entry
 *   (g) providerIds override re-targets a subset without recomputing the
 *       whole cohort
 *   (j) GET .../gardssalg-website-verification-audit `limit`/`offset`
 *       pagination (dev-request 2026-08-02-opplevagent-hjemmesideverifisering
 *       -og-enrichment-gate, Steg 1): default no-param response shape is
 *       byte-for-byte unchanged, invalid limit/offset -> 400, valid limit
 *       alone defaults offset to 0, limit+offset pages correctly with
 *       next_offset chaining to null on the last page, and the cohort's new
 *       deterministic ORDER BY id makes walking every page via next_offset
 *       visit every row exactly once
 *   (k) GET .../gardssalg-website-verification-audit `cohort` axis (Steg 2 of
 *       the same dev-request): invalid cohort -> 400, cohort=all without
 *       limit -> 400 (mandatory pagination), cohort=all widens the cohort
 *       beyond the gårdssalg producer-type restriction while the synthetic
 *       test-gardssalg row stays excluded either way, and cohort=all pages
 *       correctly
 *   (l) POST .../gardssalg-website-verification-remediation — the SAME
 *       `cohort`/`limit`/`offset` discipline as (j)/(k) above, applied to the
 *       write endpoint (Steg 2b): read from the request body instead of the
 *       query string, same validation/messages, `pagination` block on both
 *       the dry-run and apply responses, apply+cohort=all+limit writes
 *       provenance for exactly the paged rows (bounded blast radius), and the
 *       providerIds-only/no-cohort-body case stays byte-for-byte unchanged
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
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "GET";
    const url = opts.url || "/admin/gardssalg-website-verification-audit";
    // Parse the query string ourselves — router.handle() on a hand-built req
    // never runs express's query middleware, so a hardcoded `query: {}` would
    // silently swallow `?scope=...` and the scope tests in section (h) would
    // pass vacuously against the default. (Exactly that happened on first
    // run: 5 assertions failed because every scoped GET ran as scope-less.)
    const [pathOnly, queryString] = url.split("?");
    const query: Record<string, string> = {};
    if (queryString) {
      for (const [k, v] of new URLSearchParams(queryString)) query[k] = v;
    }
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: pathOnly,
      query,
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
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

export function runOpplevelserGardssalgWebsiteVerificationTests(
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
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "gardssalg-website-verification-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const verificationServicePath = require.resolve("../services/gardssalg-website-verification");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, verificationServicePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, org_nr, kommune, poststed, telefon, mobil, adresse, postnummer,
            catalog_hidden, producer_type, rfb_seed_source, content_source,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @org_nr, @kommune, @poststed, @telefon, @mobil, @adresse, @postnummer,
            @catalog_hidden, @producer_type, @rfb_seed_source, @content_source,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // ── (b)/(c) mixed cohort, realistic varied names ────────────────────
      insertProvider.run({
        id: "prov-verified-orgnr", navn: "Hebnes Vingård", hjemmeside: "https://hebnesvingard.example.no",
        org_nr: "912345678", kommune: "Suldal", poststed: null, telefon: null, mobil: null, adresse: null, postnummer: null,
        catalog_hidden: 0, producer_type: "vingård", rfb_seed_source: null, content_source: "provider_site",
      });
      insertProvider.run({
        id: "prov-unverified-404", navn: "Ciderhuset Balestrand", hjemmeside: "https://ciderhusetbalestrand.example.no",
        org_nr: null, kommune: "Sogndal", poststed: "Balestrand", telefon: null, mobil: null, adresse: null, postnummer: null,
        catalog_hidden: 0, producer_type: "cideri", rfb_seed_source: null, content_source: "provider_site",
      });
      insertProvider.run({
        id: "prov-aggregator", navn: "Aggregatorgaarden", hjemmeside: "https://hanen.no/gardsutsalg/aggregatorgaarden",
        org_nr: null, kommune: null, poststed: null, telefon: null, mobil: null, adresse: null, postnummer: null,
        catalog_hidden: 0, producer_type: "bryggeri", rfb_seed_source: null, content_source: "provider_site",
      });
      insertProvider.run({
        id: "prov-missing-source", navn: "Norumbryggeriet", hjemmeside: null,
        org_nr: null, kommune: null, poststed: null, telefon: null, mobil: null, adresse: null, postnummer: null,
        catalog_hidden: 0, producer_type: "bryggeri", rfb_seed_source: null, content_source: null,
      });
      // Hidden — must NEVER appear in either endpoint's output.
      insertProvider.run({
        id: "prov-hidden-verified", navn: "Fossmoen Frukt", hjemmeside: "https://fossmoenfrukt.example.no",
        org_nr: "900111222", kommune: null, poststed: null, telefon: null, mobil: null, adresse: null, postnummer: null,
        catalog_hidden: 1, producer_type: "cideri", rfb_seed_source: null, content_source: "provider_site",
      });
      // The synthetic test provider (POST /admin/gardssalg/test-provider) —
      // shaped exactly like the real prod row: catalog_hidden=1, a
      // producer_type of 'test-gardssalg', and a non-resolving hjemmeside. It
      // must be excluded from EVERY scope, not just the default one, so it
      // never files a bogus verification_failed queue entry. Deliberately
      // seeded here rather than in a section of its own: it makes the
      // pre-existing counts in (c)/(h) load-bearing for the exclusion —
      // without it, c1 would read 4 (unchanged, hidden) but h3 would read 2
      // and h6 would read 6, so the fix cannot regress silently.
      insertProvider.run({
        id: "prov-test-gardssalg", navn: "TEST — Ikke book", hjemmeside: "https://test-ikke-book.invalid",
        org_nr: "TEST000000", kommune: null, poststed: null, telefon: null, mobil: null, adresse: null, postnummer: null,
        catalog_hidden: 1, producer_type: "test-gardssalg", rfb_seed_source: null, content_source: null,
      });
      // A producer OUTSIDE the gårdssalg cohort entirely: producer_type IS
      // NULL and rfb_seed_source is NOT 'rfb-seed' — exactly the shape the
      // gårdssalg cohort (default) excludes and cohort=all (Steg 2 of
      // dev-request 2026-08-02-opplevagent-hjemmesideverifisering-og-
      // enrichment-gate) must newly include. Visible + blank hjemmeside
      // (missing_source) deliberately, so it never needs a fetch mock case
      // of its own and never affects any DEFAULT-cohort assertion above/
      // below (sections b/c/j all run with cohort defaulted to "gardssalg",
      // which excludes this row — that's the whole point).
      insertProvider.run({
        id: "prov-outside-gardssalg", navn: "Uidentifisert Aktør", hjemmeside: null,
        org_nr: null, kommune: null, poststed: null, telefon: null, mobil: null, adresse: null, postnummer: null,
        catalog_hidden: 0, producer_type: null, rfb_seed_source: null, content_source: null,
      });

      let fetchCallCount = 0;
      const fetchedHosts: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        fetchCallCount++;
        const host = new URL(urlStr).hostname;
        fetchedHosts.push(host);
        if (host === "hebnesvingard.example.no") {
          const html = "<html><body><p>Hebnes Vingård, Suldal. Org.nr 912 345 678. Velkommen til smaking.</p></body></html>";
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        if (host === "ciderhusetbalestrand.example.no") {
          // Simulated 404 — must classify as unverified, never throw.
          return {
            ok: false, status: 404, statusText: "Not Found", text: async () => "",
            arrayBuffer: async () => new ArrayBuffer(0),
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        // fossmoenfrukt.example.no (hidden — never fetched by a
        // DEFAULT-scope call, which is what assertion c3 pins at its point
        // in the sequence; section (h) later fetches it deliberately via
        // scope=hidden and expects org.nr evidence to verify it).
        const html = "<html><body><p>Fossmoen Frukt, org.nr 900 111 222.</p></body></html>";
        return {
          ok: true, status: 200, text: async () => html,
          arrayBuffer: async () => new TextEncoder().encode(html).buffer,
          headers: { get: () => null }, url: urlStr,
        } as unknown as Response;
      }) as typeof fetch;

      // ── (a) 403 without X-Admin-Key ──────────────────────────────────────
      const noKeyGet = await callRoute(opplevelserRouter, { url: "/admin/gardssalg-website-verification-audit" });
      assertEq(noKeyGet.status, 403, "a1: GET .../gardssalg-website-verification-audit without X-Admin-Key -> 403");
      const noKeyPost = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
      });
      assertEq(noKeyPost.status, 403, "a2: POST .../gardssalg-website-verification-remediation without X-Admin-Key -> 403");

      // ── (b)/(c) GET .../gardssalg-website-verification-audit ────────────
      const auditRes = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit",
        headers: { "x-admin-key": testKey },
      });
      assertEq(auditRes.status, 200, "b1: audit GET -> 200");
      assertEq(auditRes.body.success, true, "b2: success:true");
      const rows: any[] = auditRes.body.rows;
      assertTrue(Array.isArray(rows), "b3: response carries a rows array");
      assertEq(rows.length, 4, "c1: exactly 4 rows — the hidden producer is excluded from the cohort");
      assertTrue(!rows.some((r) => r.provider_id === "prov-hidden-verified"), "c2: hidden producer never appears in the report");
      assertTrue(!fetchedHosts.includes("fossmoenfrukt.example.no"), "c3: hidden producer's homepage is never even fetched");

      const verifiedRow = rows.find((r) => r.provider_id === "prov-verified-orgnr");
      assertEq(verifiedRow?.classification, "verified", "b4: org_nr-on-page -> verified");
      assertEq(verifiedRow?.evidence?.org_nr_found, true, "b5: verified row's evidence.org_nr_found is true");

      const unverifiedRow = rows.find((r) => r.provider_id === "prov-unverified-404");
      assertEq(unverifiedRow?.classification, "unverified", "b6: fetch 404 -> unverified, not a 500/throw");

      const aggregatorRow = rows.find((r) => r.provider_id === "prov-aggregator");
      assertEq(aggregatorRow?.classification, "aggregator", "b7: directory host -> aggregator");
      assertEq(aggregatorRow?.evidence, null, "b8: aggregator carries no evidence");
      assertTrue(!fetchedHosts.includes("hanen.no"), "b9: aggregator host is never fetched (Funn 4)");

      const missingRow = rows.find((r) => r.provider_id === "prov-missing-source");
      assertEq(missingRow?.classification, "missing_source", "b10: blank hjemmeside -> missing_source");

      assertEq(
        auditRes.body.summary,
        { verified: 1, unverified: 1, aggregator: 1, missing_source: 1, unreachable_transient: 0, total: 4 },
        "b11: summary counts every bucket exactly once over the visible cohort",
      );

      // ── (j) GET .../gardssalg-website-verification-audit — limit/offset
      //     pagination (Steg 1 of dev-request 2026-08-02-opplevagent-
      //     hjemmesideverifisering-og-enrichment-gate). Uses the same 4-row
      //     VISIBLE cohort as (b)/(c) above — the cohort's new `ORDER BY id`
      //     (services/gardssalg-website-verification.ts) makes these row
      //     positions ("prov-aggregator" < "prov-missing-source" <
      //     "prov-unverified-404" < "prov-verified-orgnr", plain string
      //     order) deterministic across repeated calls. Entirely read-only,
      //     so it's placed here, before any POST/write section below, and
      //     touches none of their state. ───────────────────────────────────

      // j1: no-param response shape is UNCHANGED bar the new `cohort` field
      // (Steg 2 adds it alongside the existing `scope` field, per its own
      // spec) — no `pagination` key sneaking in for a caller who never asked
      // for one, and no OTHER unexpected key either.
      assertEq(
        Object.keys(auditRes.body).sort(),
        ["cohort", "rows", "scope", "success", "summary"].sort(),
        "j1: default (no limit/offset) response carries today's keys plus the new `cohort` field — no `pagination` key",
      );
      assertEq(auditRes.body.cohort, "gardssalg", "j1b: cohort defaults to 'gardssalg' when the param is omitted entirely");

      // j2-j5: invalid limit/offset -> 400, Norwegian message, matching
      // `scope`'s own validation style.
      const badLimit = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?limit=0",
        headers: { "x-admin-key": testKey },
      });
      assertEq(badLimit.status, 400, "j2: limit=0 -> 400 (must be >= 1)");
      assertTrue(/Ugyldig limit/.test(badLimit.body.error || ""), "j2b: limit error message names the field");

      const badLimitStr = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?limit=abc",
        headers: { "x-admin-key": testKey },
      });
      assertEq(badLimitStr.status, 400, "j3: limit=abc -> 400 (not an integer)");

      const badOffset = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?limit=2&offset=-1",
        headers: { "x-admin-key": testKey },
      });
      assertEq(badOffset.status, 400, "j4: offset=-1 -> 400 (must be >= 0)");
      assertTrue(/Ugyldig offset/.test(badOffset.body.error || ""), "j4b: offset error message names the field");

      const offsetWithoutLimit = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?offset=1",
        headers: { "x-admin-key": testKey },
      });
      assertEq(offsetWithoutLimit.status, 400, "j5: offset without limit -> 400, no default limit is guessed");

      // j6-j10: valid limit alone (offset defaults to 0) -> first page, in
      // id order; summary/pagination reflect only the returned page.
      const page1 = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?limit=1",
        headers: { "x-admin-key": testKey },
      });
      assertEq(page1.status, 200, "j6: limit=1 alone -> 200");
      assertEq(page1.body.rows.length, 1, "j7: exactly one row returned");
      assertEq(page1.body.rows[0]?.provider_id, "prov-aggregator", "j8: first id-ordered row is prov-aggregator");
      assertEq(
        page1.body.pagination,
        { total: 4, offset: 0, limit: 1, returned: 1, next_offset: 1 },
        "j9: pagination block — offset defaulted to 0, next_offset points at the next row",
      );
      assertEq(
        page1.body.summary,
        { verified: 0, unverified: 0, aggregator: 1, missing_source: 0, unreachable_transient: 0, total: 1 },
        "j10: summary reflects ONLY the returned page, not the full cohort",
      );

      // j11-j15: walk the whole cohort one row at a time via limit=1,
      // confirming (a) each page's row differs from every other page's row
      // (the ordering fix — paginated calls at offset=0/1 must never return
      // the same row) and (b) `next_offset` correctly chains through to the
      // last page, which reports next_offset: null.
      const seenIds: string[] = [];
      let cursor: number | null = 0;
      let guard = 0;
      while (cursor !== null && guard < 10) {
        guard++;
        const pageRes = await callRoute(opplevelserRouter, {
          url: `/admin/gardssalg-website-verification-audit?limit=1&offset=${cursor}`,
          headers: { "x-admin-key": testKey },
        });
        assertEq(pageRes.status, 200, `j11.${cursor}: paged GET at offset=${cursor} -> 200`);
        assertEq(pageRes.body.rows.length, 1, `j12.${cursor}: exactly one row at offset=${cursor}`);
        seenIds.push(pageRes.body.rows[0].provider_id);
        cursor = pageRes.body.pagination.next_offset;
      }
      assertEq(seenIds.length, 4, "j13: walking next_offset visits exactly 4 pages — the whole visible cohort, no more, no less");
      assertEq(new Set(seenIds).size, 4, "j14: all 4 visited rows are DISTINCT — no row skipped or duplicated across pages");
      assertEq(
        seenIds,
        ["prov-aggregator", "prov-missing-source", "prov-unverified-404", "prov-verified-orgnr"],
        "j15: walking order matches the cohort's new deterministic ORDER BY id",
      );

      // j16-j18: limit+offset paging with a non-1 page size, and the last
      // page reporting next_offset: null.
      const page2of2 = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?limit=2&offset=2",
        headers: { "x-admin-key": testKey },
      });
      assertEq(page2of2.status, 200, "j16: limit=2&offset=2 -> 200");
      assertEq(
        page2of2.body.rows.map((r: any) => r.provider_id),
        ["prov-unverified-404", "prov-verified-orgnr"],
        "j17: second (final) page of a limit=2 walk carries the last two id-ordered rows",
      );
      assertEq(
        page2of2.body.pagination,
        { total: 4, offset: 2, limit: 2, returned: 2, next_offset: null },
        "j18: final page reports next_offset: null — nothing left to fetch",
      );

      // j19-j20: an offset at/past the end of the cohort -> zero rows,
      // next_offset still null (never negative / never re-wraps).
      const pastEnd = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?limit=5&offset=4",
        headers: { "x-admin-key": testKey },
      });
      assertEq(pastEnd.status, 200, "j19: limit=5&offset=4 (offset==total) -> 200");
      assertEq(
        pastEnd.body.pagination,
        { total: 4, offset: 4, limit: 5, returned: 0, next_offset: null },
        "j20: offset at the end of the cohort returns an empty page, not an error",
      );

      // j21-j23: server-side upper bound on `limit` (dev-request
      // 2026-08-02-opplevagent-hjemmesideverifisering-og-enrichment-gate
      // Steg 1 follow-up — MAX_GARDSSALG_AUDIT_LIMIT). A caller-chosen `limit`
      // large enough reproduces the exact unbounded-scan risk pagination was
      // added to prevent, so this route rejects anything past the cap —
      // never a silent clamp, same discipline as the rest of this route's
      // param validation.
      const atMax = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?limit=12",
        headers: { "x-admin-key": testKey },
      });
      assertEq(atMax.status, 200, "j21: limit=12 (the max) -> 200, not rejected");
      assertEq(
        atMax.body.pagination,
        { total: 4, offset: 0, limit: 12, returned: 4, next_offset: null },
        "j21b: limit=12 at the max still pages normally (only 4 rows exist in this cohort)",
      );

      const overMax = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?limit=13",
        headers: { "x-admin-key": testKey },
      });
      assertEq(overMax.status, 400, "j22: limit=13 (one over the max) -> 400");
      assertEq(
        overMax.body.error,
        "Ugyldig limit — maks er 12.",
        "j22b: limit-too-high error message names the max",
      );

      const wayOverMax = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?limit=1000",
        headers: { "x-admin-key": testKey },
      });
      assertEq(wayOverMax.status, 400, "j23: a much larger limit (the exact PR #432 unbounded-scan shape) is also rejected, not clamped");

      function getProviderRow(id: string): any {
        return expDb.prepare(`SELECT id, field_provenance FROM experience_providers WHERE id = ?`).get(id);
      }
      function getVerificationAuditRows(providerId: string): any[] {
        return expDb
          .prepare(`SELECT * FROM gardssalg_website_verification_audit WHERE provider_id = ? ORDER BY rowid ASC`)
          .all(providerId);
      }
      function getQueueRow(providerId: string): any {
        return expDb
          .prepare(`SELECT * FROM gardssalg_website_review_queue WHERE provider_id = ?`)
          .get(providerId);
      }

      const beforeAnyWrite = getProviderRow("prov-verified-orgnr");
      assertEq(beforeAnyWrite.field_provenance, null, "b12: pre-check — GET performed zero writes, field_provenance still null");

      // ── (d) POST dry-run: zero writes ────────────────────────────────────
      const dryRunRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: {},
      });
      assertEq(dryRunRes.status, 200, "d1: remediation dry-run -> 200");
      assertEq(dryRunRes.body.dry_run, true, "d2: dry_run defaults true");
      const wouldEnqueue: any[] = dryRunRes.body.would_enqueue;
      assertEq(wouldEnqueue.length, 1, "d3: dry-run would_enqueue contains exactly the one unverified row");
      assertEq(wouldEnqueue[0]?.provider_id, "prov-unverified-404", "d4: the would-be-enqueued row is the unverified producer");
      assertEq(
        dryRunRes.body.summary,
        { verified: 1, unverified: 1, aggregator: 1, missing_source: 1, unreachable_transient: 0, total: 4 },
        "d5: dry-run summary matches the GET report",
      );

      assertEq(getProviderRow("prov-verified-orgnr").field_provenance, null, "d6: dry-run wrote nothing to field_provenance");
      assertEq(getVerificationAuditRows("prov-verified-orgnr").length, 0, "d7: dry-run inserted zero audit rows");
      assertEq(getQueueRow("prov-unverified-404"), undefined, "d8: dry-run enqueued nothing into the review queue");

      // ── (e) POST apply=true — the real write ─────────────────────────────
      const batchId1 = "test-batch-wv-1";
      const applyRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { apply: true, batch_id: batchId1 },
      });
      assertEq(applyRes.status, 200, "e1: remediation apply -> 200");
      assertEq(applyRes.body.dry_run, false, "e2: dry_run is false on an apply call");
      assertEq(applyRes.body.provenance_written, 4, "e3: field_provenance written for ALL 4 classifications, not just unverified");
      assertEq(applyRes.body.enqueued, 1, "e4: exactly one NEW enqueue — the unverified row");

      const verifiedProvenance = JSON.parse(getProviderRow("prov-verified-orgnr").field_provenance);
      assertEq(verifiedProvenance.hjemmeside_verification.classification, "verified", "e5: verified row's provenance stamp");
      assertEq(verifiedProvenance.hjemmeside_verification.verified, true, "e6: provenance.verified is the strict boolean true");
      assertTrue(!!verifiedProvenance.hjemmeside_verification.evidence, "e7: verified row's provenance carries the evidence object");
      assertTrue(!!verifiedProvenance.hjemmeside_verification.checked_at, "e8: provenance stamp carries a checked_at timestamp");

      const aggregatorProvenance = JSON.parse(getProviderRow("prov-aggregator").field_provenance);
      assertEq(aggregatorProvenance.hjemmeside_verification.classification, "aggregator", "e9: aggregator row's provenance stamp");
      assertEq(aggregatorProvenance.hjemmeside_verification.evidence, undefined, "e10: aggregator provenance omits the evidence key entirely");

      const missingProvenance = JSON.parse(getProviderRow("prov-missing-source").field_provenance);
      assertEq(missingProvenance.hjemmeside_verification.classification, "missing_source", "e11: missing_source row's provenance stamp");
      assertEq(missingProvenance.hjemmeside_verification.evidence, undefined, "e12: missing_source provenance omits evidence too");

      for (const id of ["prov-verified-orgnr", "prov-unverified-404", "prov-aggregator", "prov-missing-source"]) {
        assertEq(getVerificationAuditRows(id).length, 1, `e13.${id}: exactly one audit row inserted for ${id}`);
      }
      const unverifiedAudit = getVerificationAuditRows("prov-unverified-404")[0];
      assertEq(unverifiedAudit.classification, "unverified", "e14: audit row classification matches");
      assertEq(unverifiedAudit.verified, 0, "e15: audit row verified column is 0 (INTEGER, not the string 'false')");
      assertEq(unverifiedAudit.batch_id, batchId1, "e16: audit row stamped with the request's batch_id");

      const queueRowAfterFirstApply = getQueueRow("prov-unverified-404");
      assertTrue(!!queueRowAfterFirstApply, "e17: the unverified producer now has a pending review-queue row");
      assertEq(queueRowAfterFirstApply.reason, "verification_failed", "e18: queue row reason is 'verification_failed'");
      assertEq(queueRowAfterFirstApply.candidate_url, "https://ciderhusetbalestrand.example.no", "e19: queue row candidate_url is the producer's own (unverifiable) hjemmeside");
      assertEq(queueRowAfterFirstApply.batch_id, batchId1, "e20: queue row batch_id matches the apply call");
      assertEq(getQueueRow("prov-verified-orgnr"), undefined, "e21: the verified producer is never enqueued");
      assertEq(getQueueRow("prov-aggregator"), undefined, "e22: the aggregator producer is never enqueued here (separate endpoint's job)");
      assertEq(getQueueRow("prov-missing-source"), undefined, "e23: the missing_source producer is never enqueued");

      // Existing `hjemmeside` provenance key (source-of-the-URL-value) must
      // be untouched/absent — this slice adds a NEW key, never overwrites it.
      assertEq(verifiedProvenance.hjemmeside, undefined, "e24: the pre-existing 'hjemmeside' provenance key is untouched (never had one to begin with here, and this write must not invent one)");

      // ── (f) idempotent re-run — same classifications, second apply must
      //     NOT duplicate/re-touch the already-queued entry ────────────────
      const batchId2 = "test-batch-wv-2";
      const applyRes2 = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { apply: true, batch_id: batchId2 },
      });
      assertEq(applyRes2.status, 200, "f1: second apply -> 200");
      assertEq(applyRes2.body.enqueued, 0, "f2: idempotent re-run — zero NEW enqueues (same reason+candidate_url already pending)");
      assertEq(applyRes2.body.provenance_written, 4, "f3: field_provenance is still (re-)written every apply — only the QUEUE upsert is idempotency-gated");

      const queueRowAfterSecondApply = getQueueRow("prov-unverified-404");
      assertEq(queueRowAfterSecondApply.batch_id, batchId1, "f4: queue row's batch_id is UNCHANGED by the second apply — proves the upsert was genuinely skipped, not just re-run with the same values");

      const allQueueRows = expDb.prepare(`SELECT * FROM gardssalg_website_review_queue`).all() as any[];
      assertEq(allQueueRows.length, 1, "f5: still exactly one review-queue row total — no duplicate row was created");

      // ── (g) providerIds override — re-target a subset ────────────────────
      const scopedRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-verified-orgnr"] },
      });
      assertEq(scopedRes.status, 200, "g1: scoped dry-run -> 200");
      assertEq(scopedRes.body.summary.total, 1, "g2: providerIds override scopes the scan to exactly the requested producer");
      assertEq(scopedRes.body.summary, { verified: 1, unverified: 0, aggregator: 0, missing_source: 0, unreachable_transient: 0, total: 1 }, "g3: scoped summary reflects only the requested producer");

      // ── (h) visibility scope — Daniel's 2026-08-01 live override: the
      //     sweep must reach hidden producers too, as an explicit per-call
      //     opt-in. Default stays "visible" (sections (c)/(e) above already
      //     pin that the hidden fixture is absent by default — those
      //     assertions are unchanged and still pass, which IS the
      //     backwards-compatibility proof). ─────────────────────────────────
      const hiddenAudit = await callRoute(opplevelserRouter, {
        method: "GET",
        url: "/admin/gardssalg-website-verification-audit?scope=hidden",
        headers: { "x-admin-key": testKey },
      });
      assertEq(hiddenAudit.status, 200, "h1: scope=hidden audit -> 200");
      assertEq(hiddenAudit.body.scope, "hidden", "h2: response echoes the scope it actually ran with");
      assertEq(hiddenAudit.body.summary.total, 1, "h3: hidden scope sees exactly the one hidden producer");
      assertTrue(
        hiddenAudit.body.rows.some((r: any) => r.provider_id === "prov-hidden-verified"),
        "h4: the hidden producer IS the row — reachable when explicitly asked for"
      );

      const allAudit = await callRoute(opplevelserRouter, {
        method: "GET",
        url: "/admin/gardssalg-website-verification-audit?scope=all",
        headers: { "x-admin-key": testKey },
      });
      assertEq(allAudit.status, 200, "h5: scope=all audit -> 200");
      assertEq(allAudit.body.summary.total, 5, "h6: scope=all sees every seeded producer, hidden included");
      // The synthetic test provider is the 6th seeded row and is catalog_hidden=1,
      // so h3 and h6 above would read 2 and 6 without the producer_type exclusion.
      // These name what those counts are pinning, and add the direct check that it
      // is never even fetched — a fetch is what would file the bogus queue entry.
      assertTrue(
        !hiddenAudit.body.rows.some((r: any) => r.provider_id === "prov-test-gardssalg"),
        "h6b: the synthetic test provider is absent from scope=hidden despite being catalog_hidden=1"
      );
      assertTrue(
        !allAudit.body.rows.some((r: any) => r.provider_id === "prov-test-gardssalg"),
        "h6c: ...and from scope=all — no scope reaches it"
      );
      assertTrue(
        !fetchedHosts.includes("test-ikke-book.invalid"),
        "h6d: its non-resolving homepage is never fetched, so it can never be enqueued as verification_failed"
      );

      const junkAudit = await callRoute(opplevelserRouter, {
        method: "GET",
        url: "/admin/gardssalg-website-verification-audit?scope=al",
        headers: { "x-admin-key": testKey },
      });
      assertEq(junkAudit.status, 400, "h7: a typo'd scope is a 400, never a silent visible-only scan");

      const junkRemediation = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { scope: "everything" },
      });
      assertEq(junkRemediation.status, 400, "h8: POST rejects unknown scope the same way — worse there, it gates writes");

      const hiddenApply = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { scope: "hidden", apply: true, batch_id: "wv-hidden-batch-1" },
      });
      assertEq(hiddenApply.status, 200, "h9: scope=hidden apply -> 200");
      assertEq(hiddenApply.body.scope, "hidden", "h10: apply response echoes scope");
      assertEq(hiddenApply.body.provenance_written, 1, "h11: exactly the one hidden row gets a provenance stamp");
      const hiddenProvRow = expDb
        .prepare(`SELECT field_provenance FROM experience_providers WHERE id = 'prov-hidden-verified'`)
        .get() as any;
      const hiddenProv = JSON.parse(hiddenProvRow.field_provenance);
      assertEq(
        hiddenProv.hjemmeside_verification?.classification,
        "verified",
        "h12: hidden producer's provenance carries the verification stamp — verify-without-publish works"
      );
      const visibleUntouched = expDb
        .prepare(`SELECT field_provenance FROM experience_providers WHERE id = 'prov-missing-source'`)
        .get() as any;
      const visibleProv = visibleUntouched.field_provenance ? JSON.parse(visibleUntouched.field_provenance) : {};
      assertEq(
        visibleProv.hjemmeside_verification?.classification,
        "missing_source",
        "h13: earlier default-scope applies still own the visible rows' stamps — hidden apply did not touch or clear them"
      );

      // ── (k) `cohort` axis — Steg 2 of dev-request 2026-08-02-opplevagent-
      //     hjemmesideverifisering-og-enrichment-gate. A SEPARATE axis from
      //     `scope` above: `cohort` decides WHICH PRODUCER TYPES are in the
      //     cohort at all (gårdssalg-only vs. every experience_providers
      //     row), never visibility — sections (b)/(c)/(j) above already pin
      //     that the default (cohort omitted) behaves byte-for-byte as
      //     before (rows.length===4, same summary, same pagination shape
      //     bar the new top-level `cohort` field), which IS this axis's
      //     backwards-compatibility proof. ───────────────────────────────────

      // k1: invalid cohort value -> 400 listing valid values, never a silent
      // fallback — same discipline as `scope`.
      const junkCohort = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?cohort=everything",
        headers: { "x-admin-key": testKey },
      });
      assertEq(junkCohort.status, 400, "k1: cohort=everything -> 400");
      assertTrue(/Ugyldig cohort/.test(junkCohort.body.error || ""), "k1b: cohort error message names the field");
      assertTrue(/gardssalg/.test(junkCohort.body.error || "") && /all/.test(junkCohort.body.error || ""), "k1c: error lists both valid values");

      // k2-k3: cohort=all WITHOUT limit -> 400, the mandatory-pagination
      // guard — checked before any DB load/fetch (fetchedHosts must gain
      // NOTHING from this call).
      const fetchCountBeforeGuard = fetchCallCount;
      const cohortAllNoLimit = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?cohort=all",
        headers: { "x-admin-key": testKey },
      });
      assertEq(cohortAllNoLimit.status, 400, "k2: cohort=all without limit -> 400 (mandatory pagination)");
      assertEq(
        cohortAllNoLimit.body.error,
        "Ugyldig — limit er påkrevd når cohort=all (kohorten er for stor for et enkelt kall uten paginering).",
        "k2b: exact Norwegian error message"
      );
      assertEq(fetchCallCount, fetchCountBeforeGuard, "k3: the mandatory-limit guard fires before any homepage fetch");

      // k4-k5: scope=hidden combined with cohort=all and no limit is STILL a
      // 400 — the guard fires on `cohort` alone, independent of `scope`.
      const cohortAllHiddenNoLimit = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?cohort=all&scope=hidden",
        headers: { "x-admin-key": testKey },
      });
      assertEq(cohortAllHiddenNoLimit.status, 400, "k4: cohort=all&scope=hidden, still no limit -> 400");
      assertTrue(/limit er påkrevd/.test(cohortAllHiddenNoLimit.body.error || ""), "k5: same mandatory-limit message regardless of scope");

      // k6-k9: cohort=all WITH a valid limit -> 200, widens the cohort to
      // include prov-outside-gardssalg (producer_type IS NULL, rfb_seed_
      // source != 'rfb-seed' — the exact shape the gårdssalg cohort
      // excludes), while the synthetic test-gardssalg row stays excluded
      // (unconditional, both cohorts) and is never fetched.
      const cohortAllVisible = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?cohort=all&limit=12",
        headers: { "x-admin-key": testKey },
      });
      assertEq(cohortAllVisible.status, 200, "k6: cohort=all&limit=12 -> 200");
      assertEq(cohortAllVisible.body.cohort, "all", "k7: response echoes cohort=all");
      const cohortAllVisibleIds = cohortAllVisible.body.rows.map((r: any) => r.provider_id);
      assertTrue(
        cohortAllVisibleIds.includes("prov-outside-gardssalg"),
        "k8: cohort=all widens to include the row the gårdssalg cohort (default) excludes"
      );
      const outsideRow = cohortAllVisible.body.rows.find((r: any) => r.provider_id === "prov-outside-gardssalg");
      assertEq(outsideRow?.classification, "missing_source", "k8b: the widened-in row classifies as missing_source (blank hjemmeside)");
      assertTrue(
        !cohortAllVisibleIds.includes("prov-test-gardssalg"),
        "k9: the synthetic test-gardssalg row stays excluded even under cohort=all"
      );
      assertTrue(
        !fetchedHosts.includes("test-ikke-book.invalid"),
        "k9b: ...and is never fetched under cohort=all either"
      );
      // Visible-scope default still excludes the hidden fixture even at
      // cohort=all — the two axes stay independent.
      assertTrue(
        !cohortAllVisibleIds.includes("prov-hidden-verified"),
        "k10: cohort=all does not itself widen visibility — scope=visible (default) still excludes the hidden row"
      );
      assertEq(
        cohortAllVisible.body.pagination.total,
        5,
        "k11: cohort=all&scope=visible total is the 4 default-cohort visible rows plus the 1 newly-widened-in row"
      );

      // k12-k14: cohort=all paginates correctly with a smaller page size —
      // walk it in two pages and confirm every row is visited exactly once.
      const cohortAllPage1 = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?cohort=all&limit=3&offset=0",
        headers: { "x-admin-key": testKey },
      });
      assertEq(cohortAllPage1.status, 200, "k12: cohort=all&limit=3&offset=0 -> 200");
      assertEq(cohortAllPage1.body.pagination.returned, 3, "k12b: first page returns exactly 3 rows");
      const cohortAllPage2 = await callRoute(opplevelserRouter, {
        url: `/admin/gardssalg-website-verification-audit?cohort=all&limit=3&offset=${cohortAllPage1.body.pagination.next_offset}`,
        headers: { "x-admin-key": testKey },
      });
      assertEq(cohortAllPage2.status, 200, "k13: second page -> 200");
      assertEq(cohortAllPage2.body.pagination.next_offset, null, "k13b: second page is the last page (5 rows total, 3+2)");
      const walkedIds = [
        ...cohortAllPage1.body.rows.map((r: any) => r.provider_id),
        ...cohortAllPage2.body.rows.map((r: any) => r.provider_id),
      ];
      assertEq(walkedIds.length, 5, "k14: walking both pages visits exactly 5 rows");
      assertEq(new Set(walkedIds).size, 5, "k14b: all 5 are distinct — no row skipped or duplicated across the cohort=all pages");

      // k15: scope=all COMBINED with cohort=all reaches every seeded row
      // except the synthetic test-gardssalg one (6 seeded + 1 outside = 7,
      // minus the always-excluded synthetic row = 6) — the two axes compose.
      const cohortAllScopeAll = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?cohort=all&scope=all&limit=12",
        headers: { "x-admin-key": testKey },
      });
      assertEq(cohortAllScopeAll.status, 200, "k15: cohort=all&scope=all&limit=12 -> 200");
      assertEq(cohortAllScopeAll.body.pagination.total, 6, "k15b: scope=all + cohort=all together see every seeded row bar the synthetic one");
      assertTrue(
        !cohortAllScopeAll.body.rows.some((r: any) => r.provider_id === "prov-test-gardssalg"),
        "k15c: ...still excluding the synthetic test-gardssalg row even with both axes maximally widened"
      );
      // scope=all neutralizes the visibility filter entirely (test-gardssalg
      // IS catalog_hidden=1, so a visible-only exclusion would no longer
      // apply here) — its absence above is therefore proof the COHORT
      // exclusion itself is what's keeping it out, not visibility. This
      // fetchedHosts check confirms that isolation directly.
      assertTrue(
        !fetchedHosts.includes("test-ikke-book.invalid"),
        "k15d: ...and, with visibility neutralized (scope=all), it's still never fetched — the cohort exclusion alone is what holds"
      );

      // ── (l) POST .../gardssalg-website-verification-remediation — the SAME
      //     `cohort`/`limit`/`offset` discipline as the GET audit route
      //     above, applied to the write endpoint (dev-request 2026-08-02-
      //     opplevagent-hjemmesideverifisering-og-enrichment-gate, Steg 2b).
      //     Read from the request BODY (this is a POST), same validation
      //     style/messages as the GET route's query parsing. Reuses the same
      //     5-row (default cohort=gardssalg 4 rows + prov-outside-gardssalg)
      //     cohort=all shape sections (j)/(k) already established above, in
      //     the SAME id order (prov-aggregator, prov-missing-source,
      //     prov-outside-gardssalg, prov-unverified-404, prov-verified-orgnr)
      //     — this section runs AFTER (e)/(f)/(h) have already applied
      //     provenance to the 4 default-cohort + 1 hidden rows, so
      //     prov-outside-gardssalg is the one row in this cohort that is
      //     STILL untouched going in — that's exactly what makes it useful
      //     as the bounded-blast-radius witness below (l9-l11). ─────────────

      // l1: cohort=all without limit -> 400, same mandatory-pagination guard
      // as the GET route, checked before any DB load/fetch.
      const fetchCountBeforePostGuard = fetchCallCount;
      const postCohortAllNoLimit = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { cohort: "all" },
      });
      assertEq(postCohortAllNoLimit.status, 400, "l1: POST cohort=all without limit -> 400 (mandatory pagination)");
      assertEq(
        postCohortAllNoLimit.body.error,
        "Ugyldig — limit er påkrevd når cohort=all (kohorten er for stor for et enkelt kall uten paginering).",
        "l1b: exact Norwegian error message, same as the GET route's"
      );
      assertEq(fetchCallCount, fetchCountBeforePostGuard, "l1c: the mandatory-limit guard fires before any homepage fetch");

      // l2: an unrecognized cohort value -> 400, never a silent fallback.
      const postJunkCohort = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { cohort: "everything" },
      });
      assertEq(postJunkCohort.status, 400, "l2: POST cohort=everything -> 400");
      assertTrue(/Ugyldig cohort/.test(postJunkCohort.body.error || ""), "l2b: cohort error message names the field");

      // l3: limit above the cap (13, cap is MAX_GARDSSALG_AUDIT_LIMIT=12) -> 400.
      const postOverMaxLimit = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { limit: 13 },
      });
      assertEq(postOverMaxLimit.status, 400, "l3: POST limit=13 (one over the max) -> 400");
      assertEq(postOverMaxLimit.body.error, "Ugyldig limit — maks er 12.", "l3b: limit-too-high error message names the max, same as the GET route's");

      // l4: offset without limit -> 400, no default page size is guessed.
      const postOffsetWithoutLimit = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { offset: 1 },
      });
      assertEq(postOffsetWithoutLimit.status, 400, "l4: POST offset without limit -> 400");

      // l5-l6: limit=0 or negative -> 400.
      const postLimitZero = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { limit: 0 },
      });
      assertEq(postLimitZero.status, 400, "l5: POST limit=0 -> 400 (must be >= 1)");
      const postLimitNegative = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { limit: -3 },
      });
      assertEq(postLimitNegative.status, 400, "l6: POST limit=-3 -> 400 (must be >= 1)");

      // l7-l8: negative offset -> 400, same message style as the GET route.
      const postOffsetNegative = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { limit: 2, offset: -1 },
      });
      assertEq(postOffsetNegative.status, 400, "l7: POST offset=-1 -> 400 (must be >= 0)");
      assertTrue(/Ugyldig offset/.test(postOffsetNegative.body.error || ""), "l8: offset error message names the field");

      // l9-l14: cohort=all with a valid limit that covers the whole 5-row
      // cohort -> 200, response echoes cohort:"all" and carries a
      // `pagination` block, and the scan reaches prov-outside-gardssalg — the
      // row OUTSIDE the gårdssalg producer-type restriction — proving the
      // widening actually reaches beyond it on the WRITE endpoint too, not
      // just the GET audit route.
      const fetchCountBeforeAllScan = fetchCallCount;
      const postCohortAllDryRun = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { cohort: "all", limit: 5 },
      });
      assertEq(postCohortAllDryRun.status, 200, "l9: POST cohort=all&limit=5 -> 200");
      assertEq(postCohortAllDryRun.body.cohort, "all", "l10: response echoes cohort:'all'");
      assertEq(
        postCohortAllDryRun.body.pagination,
        { total: 5, offset: 0, limit: 5, returned: 5, next_offset: null },
        "l11: pagination block mirrors the GET route's shape — total/offset/limit/returned/next_offset"
      );
      const dryRunAllIds = postCohortAllDryRun.body.would_enqueue.map((r: any) => r.provider_id);
      // would_enqueue only ever carries unverified rows (same contract as
      // section (d)) — assert instead via the summary total, which reflects
      // every SCANNED row regardless of classification.
      assertEq(postCohortAllDryRun.body.summary.total, 5, "l12: summary.total reflects all 5 scanned rows, not just the 4-row default cohort");
      assertTrue(
        fetchCallCount > fetchCountBeforeAllScan,
        "l13: the widened-in row(s) actually get scanned (this call performs real work, not a vacuous 200)"
      );
      assertTrue(Array.isArray(dryRunAllIds), "l14: would_enqueue is present and well-shaped on a paginated dry-run too");

      // l15-l18: apply=true with cohort=all + a bounded limit writes
      // provenance for EXACTLY the paged rows, not the whole cohort — the
      // bounded-blast-radius regression test. Targets prov-outside-gardssalg
      // specifically (offset=2 in the established id order: 0=prov-
      // aggregator, 1=prov-missing-source, 2=prov-outside-gardssalg), which
      // is untouched going into this section (every other row in this
      // cohort already got a provenance stamp from sections (e)/(f)/(h)
      // above), so its field_provenance is a clean before/after witness that
      // this call wrote for it and ONLY the one paged row.
      assertEq(getProviderRow("prov-outside-gardssalg").field_provenance, null, "l15: pre-check — prov-outside-gardssalg has no provenance yet, the clean witness for this test");
      const boundedApply = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { apply: true, cohort: "all", limit: 1, offset: 2, batch_id: "test-batch-wv-cohort-all-bounded" },
      });
      assertEq(boundedApply.status, 200, "l16: bounded apply (cohort=all, limit=1, offset=2) -> 200");
      assertEq(boundedApply.body.provenance_written, 1, "l17: provenance_written is exactly 1 — the single paged row, not the whole 5-row cohort");
      assertEq(
        boundedApply.body.pagination,
        { total: 5, offset: 2, limit: 1, returned: 1, next_offset: 3 },
        "l17b: apply response carries the same pagination block shape as the dry-run"
      );
      const outsideProvenanceAfter = JSON.parse(getProviderRow("prov-outside-gardssalg").field_provenance);
      assertEq(
        outsideProvenanceAfter.hjemmeside_verification?.classification,
        "missing_source",
        "l18: prov-outside-gardssalg now carries a provenance stamp — the one paged row was actually written"
      );

      // l19: default/no-body behavior stays byte-for-byte identical — the
      // hard regression requirement. Re-runs the exact section (g) call
      // (providerIds override, no cohort/limit/offset in the body at all)
      // and confirms it is unaffected by every cohort/pagination addition
      // above.
      const noBodyFieldsRegression = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-verified-orgnr"] },
      });
      assertEq(noBodyFieldsRegression.status, 200, "l19: providerIds-only body (no cohort/limit/offset) still -> 200");
      assertEq(
        Object.keys(noBodyFieldsRegression.body).sort(),
        ["cohort", "dry_run", "scope", "success", "summary", "would_enqueue"].sort(),
        "l19b: unpaginated response carries today's keys plus the new `cohort` field — no `pagination` key sneaking in"
      );
      assertEq(noBodyFieldsRegression.body.cohort, "gardssalg", "l19c: cohort defaults to 'gardssalg' when omitted, same as the GET route");

      // ── (m) `cohort=non_gardssalg` — dev-request 2026-08-14-exp-website-
      //     verification-stamp: the exact complement of the default
      //     `gardssalg` cohort, added so a routine sweep can reach the
      //     generic (non-gårdssalg) provider population — the one that feeds
      //     the generic experiences content-refresh selector's
      //     isHjemmesideVerified() gate — WITHOUT re-touching (re-fetching,
      //     re-classifying) the gårdssalg cohort on every tick, the way
      //     cohort=all would. Reuses the SAME prov-outside-gardssalg fixture
      //     (producer_type IS NULL, rfb_seed_source IS NULL) sections (k)/(l)
      //     above already established is outside the gårdssalg cohort — this
      //     section only adds the NEW cohort value's own behavior on top. ────

      // m1: same mandatory-pagination guard as cohort=all, checked before any
      // DB load/fetch — and the error message now names the ACTUAL cohort
      // requested (not a hardcoded "cohort=all"), unlike before this cohort
      // existed.
      const fetchCountBeforeNonGardssalgGuard = fetchCallCount;
      const nonGardssalgNoLimit = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?cohort=non_gardssalg",
        headers: { "x-admin-key": testKey },
      });
      assertEq(nonGardssalgNoLimit.status, 400, "m1: cohort=non_gardssalg without limit -> 400 (mandatory pagination)");
      assertEq(
        nonGardssalgNoLimit.body.error,
        "Ugyldig — limit er påkrevd når cohort=non_gardssalg (kohorten er for stor for et enkelt kall uten paginering).",
        "m1b: error message names the actual cohort requested"
      );
      assertEq(fetchCallCount, fetchCountBeforeNonGardssalgGuard, "m1c: the mandatory-limit guard fires before any homepage fetch");

      // m2-m5: cohort=non_gardssalg with a valid limit -> 200, contains
      // EXACTLY prov-outside-gardssalg (visible scope) — none of the four
      // gårdssalg-cohort rows, and not the synthetic test-gardssalg row.
      const nonGardssalgAudit = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-website-verification-audit?cohort=non_gardssalg&limit=12",
        headers: { "x-admin-key": testKey },
      });
      assertEq(nonGardssalgAudit.status, 200, "m2: cohort=non_gardssalg&limit=12 -> 200");
      assertEq(nonGardssalgAudit.body.cohort, "non_gardssalg", "m3: response echoes cohort=non_gardssalg");
      const nonGardssalgIds = nonGardssalgAudit.body.rows.map((r: any) => r.provider_id);
      assertEq(
        nonGardssalgIds,
        ["prov-outside-gardssalg"],
        "m4: cohort=non_gardssalg (visible scope) contains exactly the one row outside the gårdssalg producer-type restriction"
      );
      assertTrue(
        !nonGardssalgIds.some((id: string) =>
          ["prov-verified-orgnr", "prov-unverified-404", "prov-aggregator", "prov-missing-source", "prov-test-gardssalg"].includes(id)
        ),
        "m5: none of the gårdssalg-cohort rows or the synthetic test row leak into non_gardssalg"
      );

      // m6: gardssalg (default, 4 rows — section b/c) + non_gardssalg (1 row,
      // just measured) together equal cohort=all&scope=visible's own total of
      // 5 (pinned at k11) — the partition composes exactly, on the real HTTP
      // routes, not just the pure loader tested in the service-level suite.
      assertEq(
        rows.length + nonGardssalgAudit.body.rows.length,
        cohortAllVisible.body.pagination.total,
        "m6: gardssalg ∪ non_gardssalg (visible scope) accounts for the whole cohort=all&scope=visible population, no gap/overlap"
      );

      // m7-m9: the write endpoint carries the identical cohort + mandatory-
      // pagination discipline. apply=true with a bounded limit writes
      // provenance for exactly the non-gårdssalg row, without ever touching
      // (fetching, re-classifying) any gårdssalg-cohort row.
      const nonGardssalgNoLimitPost = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { cohort: "non_gardssalg" },
      });
      assertEq(nonGardssalgNoLimitPost.status, 400, "m7: POST cohort=non_gardssalg without limit -> 400");

      const nonGardssalgApply = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-website-verification-remediation",
        headers: { "x-admin-key": testKey },
        body: { apply: true, cohort: "non_gardssalg", limit: 12, batch_id: "test-batch-wv-non-gardssalg" },
      });
      assertEq(nonGardssalgApply.status, 200, "m8: POST apply=true cohort=non_gardssalg&limit=12 -> 200");
      assertEq(nonGardssalgApply.body.provenance_written, 1, "m9: provenance written for exactly the one non-gårdssalg row");
      const nonGardssalgProvenance = JSON.parse(getProviderRow("prov-outside-gardssalg").field_provenance);
      assertEq(
        nonGardssalgProvenance.hjemmeside_verification?.classification,
        "missing_source",
        "m10: the row's provenance stamp reflects its own (blank-hjemmeside) classification — the SAME field_provenance." +
          "hjemmeside_verification key isHjemmesideVerified() reads for the generic content-refresh gate"
      );

      // ── (i) GET /admin/website-review-queues — the read side both queues
      //     lacked. Semantics differ per table BY DESIGN and the assertions
      //     pin exactly that: the gardssalg table has no status column
      //     (approve DELETES the row, so existing == pending), while the
      //     homepage table keeps resolved rows behind status='approved'.
      //     Fixtures piggyback on state earlier sections created: section
      //     (e)'s apply enqueued prov-unverified-404 into the gardssalg
      //     queue. ─────────────────────────────────────────────────────────
      const noKeyQueues = await callRoute(opplevelserRouter, { url: "/admin/website-review-queues" });
      assertEq(noKeyQueues.status, 403, "i1: GET .../website-review-queues without X-Admin-Key -> 403");

      expDb
        .prepare(
          `INSERT INTO experience_homepage_review_queue
             (id, provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, resolved_at)
           VALUES
             ('hq-pend-1', 'prov-missing-source', 'Norumbryggeriet', 'https://norumbryggeriet.example.no', NULL, NULL, 0.8, 'brreg_hjemmeside', 'test-batch', 'pending', datetime('now'), NULL),
             ('hq-appr-1', 'prov-aggregator', 'Aggregatorgaarden', 'https://aggregatorgaarden.example.no', NULL, NULL, 0.9, 'brreg_hjemmeside', 'test-batch', 'approved', datetime('now'), datetime('now'))`
        )
        .run();

      const queuesRes = await callRoute(opplevelserRouter, {
        url: "/admin/website-review-queues",
        headers: { "x-admin-key": testKey },
      });
      assertEq(queuesRes.status, 200, "i2: queue listing -> 200");
      assertEq(
        queuesRes.body.counts,
        { gardssalg_pending: 1, homepage_pending: 1 },
        "i3: counts — one gardssalg row (section (e)'s enqueue), one PENDING homepage row; the approved homepage row is excluded"
      );
      assertEq(
        queuesRes.body.gardssalg[0]?.provider_id,
        "prov-unverified-404",
        "i4: the gardssalg entry is the verification sweep's own enqueue, with the fields the approve lever needs"
      );
      assertTrue(
        !!queuesRes.body.gardssalg[0]?.candidate_url,
        "i5: candidate_url present — the exact pair the approve lever demands"
      );
      assertEq(
        queuesRes.body.homepage[0]?.provider_id,
        "prov-missing-source",
        "i6: homepage listing carries the pending row only — status filter is load-bearing (i3 fails if it is dropped, since approved would join)"
      );
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-website-verification: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
      globalThis.fetch = prevFetch;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-website-verification.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgWebsiteVerificationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
