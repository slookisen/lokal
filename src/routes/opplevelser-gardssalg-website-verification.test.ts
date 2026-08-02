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
    const testKey = "gardssalg-website-verification-test-key";
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
        { verified: 1, unverified: 1, aggregator: 1, missing_source: 1, total: 4 },
        "b11: summary counts every bucket exactly once over the visible cohort",
      );

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
        { verified: 1, unverified: 1, aggregator: 1, missing_source: 1, total: 4 },
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
      assertEq(scopedRes.body.summary, { verified: 1, unverified: 0, aggregator: 0, missing_source: 0, total: 1 }, "g3: scoped summary reflects only the requested producer");

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
