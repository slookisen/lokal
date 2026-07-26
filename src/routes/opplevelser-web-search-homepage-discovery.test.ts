/**
 * opplevelser-web-search-homepage-discovery.test.ts — tests for dev-request
 * 2026-07-12-experiences-enrichment-supply-and-aggregator-hygiene, Daniel's
 * decision, step 2, evidence-leg (d): the RESIDUAL cohort — providers with
 * NEITHER org_nr NOR listing_url set, so neither leg (a)'s listing_url-driven
 * candidate set nor leg (b)'s org_nr-driven candidate set ever selects them.
 *
 * There is no server-side web-search/LLM capability in this app (and none is
 * added here) — GET /admin/providers/homepage-open-uncovered surfaces the
 * residual cohort (read-only, cursor-rotated via
 * web_search_homepage_attempted_at) for an external researcher (human or
 * orchestrator session) to look up, and POST /admin/homepage-review-queue/
 * submit accepts already-researched {provider_id, candidate_url,
 * name_verified} triples, screens them through the SAME directory/aggregator-
 * host + already-catalogued-host + already-queued-for-provider guards legs
 * (a)/(b) already enforce (PLUS a hard name_verified===true requirement),
 * and — apply-mode only — upserts survivors into
 * experience_homepage_review_queue with reason 'web_search_candidate'.
 * NEVER writes hjemmeside directly; adoption goes through the EXISTING
 * listing-homepage-review-approve lever, unmodified.
 *
 * Same conventions as opplevelser-brreg-website-discovery.test.ts: router
 * .handle() as the HTTP entry point, in-memory experiences DB, fresh requires
 * per run. Neither new route calls fetch (no web-search/LLM call from
 * application code — the caller already did that research), so no
 * globalThis.fetch mock is needed here.
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
  opts: { method?: string; url?: string; query?: Record<string, string>; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/homepage-review-queue/submit";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: opts.query || {},
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

export function runOpplevelserWebSearchHomepageDiscoveryTests(
  log = false,
): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ✓ ${label}`); }
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = "web-search-homepage-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

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
      const oppl = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = oppl.default as any;
      const adminHeaders = { "x-admin-key": testKey };

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, listing_url, hjemmeside, content_source, kommune, producer_type, source, confidence,
            enrichment_state, verification_status)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @listing_url, @hjemmeside, @content_source, @kommune, @producer_type, 'test-fixture', 'medium',
            'raw', 'pending_verify')`,
      );

      // ── Fixtures ─────────────────────────────────────────────────────────
      // ws-residual: the actual residual cohort — no org_nr, no listing_url,
      // no hjemmeside, not locked.
      insertProvider.run({ id: "ws-residual", navn: "Reststrøm Gård", org_nr: null, listing_url: null, hjemmeside: null, content_source: null, kommune: "Voss", producer_type: "cideri" });
      // ws-has-orgnr: org_nr set -> already leg (b)'s candidate, must be
      // EXCLUDED from the residual cohort.
      insertProvider.run({ id: "ws-has-orgnr", navn: "Orgnr Gård", org_nr: "900000001", listing_url: null, hjemmeside: null, content_source: null, kommune: "Voss", producer_type: "bryggeri" });
      // ws-has-listing: listing_url set -> already leg (a)'s candidate, must
      // be EXCLUDED from the residual cohort.
      insertProvider.run({ id: "ws-has-listing", navn: "Listeside Gård", org_nr: null, listing_url: "https://dmo.no/listeside-gard", hjemmeside: null, content_source: null, kommune: "Voss", producer_type: "vingård" });
      // ws-has-website: already has hjemmeside -> excluded from BOTH the open
      // cohort AND submit (already_has_website).
      insertProvider.run({ id: "ws-has-website", navn: "Nettside Gård", org_nr: null, listing_url: null, hjemmeside: "https://harnettside-ws.no", content_source: null, kommune: "Voss", producer_type: null });
      // ws-locked: content_source manual -> excluded from BOTH the open
      // cohort AND submit (locked_content_source).
      insertProvider.run({ id: "ws-locked", navn: "Låst Gård", org_nr: null, listing_url: null, hjemmeside: null, content_source: "manual", kommune: "Voss", producer_type: null });
      // ws-agg-target: residual, for the directory/aggregator-host submit test.
      insertProvider.run({ id: "ws-agg-target", navn: "Aggregatmål Gård", org_nr: null, listing_url: null, hjemmeside: null, content_source: null, kommune: "Voss", producer_type: null });
      // ws-catalog-target: residual, for the host-already-in-catalog submit test.
      insertProvider.run({ id: "ws-catalog-target", navn: "Katalogmål Gård", org_nr: null, listing_url: null, hjemmeside: null, content_source: null, kommune: "Voss", producer_type: null });
      insertProvider.run({ id: "ws-catalog-owner", navn: "Katalogeier Gård", org_nr: null, listing_url: null, hjemmeside: "https://tatt-av-noen-ws.no", content_source: null, kommune: "Voss", producer_type: null });
      // ws-good: residual, for the fully-valid apply-then-requeue test.
      insertProvider.run({ id: "ws-good", navn: "Ekte Reststrøm Gård", org_nr: null, listing_url: null, hjemmeside: null, content_source: null, kommune: "Voss", producer_type: null });
      // ws-cross-a / ws-cross-b: two SEPARATE residual providers, for the
      // cross-provider host_already_queued_elsewhere regression test —
      // TWO DIFFERENT requests (not two items in one batch, which
      // queuedThisRun already catches) each submitting a candidate_url on
      // the SAME host for a DIFFERENT provider_id.
      insertProvider.run({ id: "ws-cross-a", navn: "Kryssvert Gård A", org_nr: null, listing_url: null, hjemmeside: null, content_source: null, kommune: "Voss", producer_type: null });
      insertProvider.run({ id: "ws-cross-b", navn: "Kryssvert Gård B", org_nr: null, listing_url: null, hjemmeside: null, content_source: null, kommune: "Voss", producer_type: null });

      // ── ws-1: auth gate on BOTH new routes. ─────────────────────────────
      {
        const rGet = await callRoute(opplevelserRouter, { method: "GET", url: "/admin/providers/homepage-open-uncovered" });
        assertEq(rGet.status, 403, "ws-1a: no admin key → 403 on GET homepage-open-uncovered");
        const rPost = await callRoute(opplevelserRouter, { body: { candidates: [] } });
        assertEq(rPost.status, 403, "ws-1b: no admin key → 403 on POST homepage-review-queue/submit");
      }

      // ── ws-2: GET homepage-open-uncovered candidate-set predicate. ──────
      {
        const r = await callRoute(opplevelserRouter, { method: "GET", url: "/admin/providers/homepage-open-uncovered", headers: adminHeaders });
        assertEq(r.status, 200, "ws-2a: 200 with admin key");
        const ids = (r.body.candidates as any[]).map((c) => c.id);
        assertTrue(ids.includes("ws-residual"), "ws-2b: residual (no org_nr, no listing_url, no hjemmeside) row IS included");
        assertTrue(!ids.includes("ws-has-orgnr"), "ws-2c: row with org_nr set is EXCLUDED");
        assertTrue(!ids.includes("ws-has-listing"), "ws-2d: row with listing_url set is EXCLUDED");
        assertTrue(!ids.includes("ws-has-website"), "ws-2e: row already carrying hjemmeside is EXCLUDED");
        assertTrue(!ids.includes("ws-locked"), "ws-2f: locked content_source row is EXCLUDED");

        const residual = (r.body.candidates as any[]).find((c) => c.id === "ws-residual");
        assertEq(residual?.navn, "Reststrøm Gård", "ws-2g: candidate shape carries navn");
        assertEq(residual?.kommune, "Voss", "ws-2h: candidate shape carries kommune");
        assertEq(residual?.producer_type, "cideri", "ws-2i: candidate shape carries producer_type");
      }

      // ── ws-3: batch cap — GET limit>30 → 400. ───────────────────────────
      {
        const r = await callRoute(opplevelserRouter, {
          method: "GET",
          url: "/admin/providers/homepage-open-uncovered",
          headers: adminHeaders,
          query: { limit: "31" },
        });
        assertEq(r.status, 400, "ws-3a: GET limit=31 → 400 (hard cap 30)");
      }

      // ── ws-4: submit — name_verified:false → rejected, zero queue writes. ─
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ provider_id: "ws-residual", candidate_url: "https://reststrom-nettside.no", name_verified: false }], apply: true },
        });
        const rej = (r.body.rejected as any[]).find((x) => x.provider_id === "ws-residual");
        assertTrue(!!rej && rej.reason === "name_not_verified", "ws-4a: name_verified:false → name_not_verified");
        const q = expDb.prepare(`SELECT COUNT(*) c FROM experience_homepage_review_queue WHERE provider_id='ws-residual'`).get() as any;
        assertEq(q.c, 0, "ws-4b: zero queue writes for a name-unverified candidate");
        // Truthy-ish but not the literal boolean true must ALSO be rejected —
        // hard requirement, not a loose truthy check.
        const r2 = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ provider_id: "ws-residual", candidate_url: "https://reststrom-nettside.no", name_verified: "true" }], apply: true },
        });
        const rej2 = (r2.body.rejected as any[]).find((x) => x.provider_id === "ws-residual");
        assertTrue(!!rej2 && rej2.reason === "name_not_verified", "ws-4c: name_verified:\"true\" (string) is NOT accepted — literal boolean true required");
        const q2 = expDb.prepare(`SELECT COUNT(*) c FROM experience_homepage_review_queue WHERE provider_id='ws-residual'`).get() as any;
        assertEq(q2.c, 0, "ws-4d: still zero queue writes");
        // Attempt stamp still advances on a substantive rejection.
        const stamped = expDb.prepare(`SELECT web_search_homepage_attempted_at FROM experience_providers WHERE id='ws-residual'`).get() as any;
        assertTrue(!!stamped.web_search_homepage_attempted_at, "ws-4e: web_search_homepage_attempted_at stamped on a name_not_verified rejection (apply mode)");
      }

      // ── ws-5: directory/aggregator host → rejected, zero write. ─────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ provider_id: "ws-agg-target", candidate_url: "https://www.facebook.com/aggregatmalgard", name_verified: true }], apply: true },
        });
        const rej = (r.body.rejected as any[]).find((x) => x.provider_id === "ws-agg-target");
        assertTrue(!!rej && rej.reason === "directory_or_aggregator_host", "ws-5a: known aggregator host → directory_or_aggregator_host");
        const q = expDb.prepare(`SELECT COUNT(*) c FROM experience_homepage_review_queue WHERE provider_id='ws-agg-target'`).get() as any;
        assertEq(q.c, 0, "ws-5b: zero queue writes for an aggregator-host candidate");
      }

      // ── ws-6: host already used elsewhere in the catalog → rejected. ────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ provider_id: "ws-catalog-target", candidate_url: "https://tatt-av-noen-ws.no/om-oss", name_verified: true }], apply: true },
        });
        const rej = (r.body.rejected as any[]).find((x) => x.provider_id === "ws-catalog-target");
        assertTrue(!!rej && rej.reason === "host_already_in_catalog", "ws-6a: host already live as a DIFFERENT provider's hjemmeside → host_already_in_catalog");
        const q = expDb.prepare(`SELECT COUNT(*) c FROM experience_homepage_review_queue WHERE provider_id='ws-catalog-target'`).get() as any;
        assertEq(q.c, 0, "ws-6b: zero queue writes");
      }

      // ── ws-7: locked content_source (manual) → rejected, zero write. ────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ provider_id: "ws-locked", candidate_url: "https://last-gard-nettside.no", name_verified: true }], apply: true },
        });
        const rej = (r.body.rejected as any[]).find((x) => x.provider_id === "ws-locked");
        assertTrue(!!rej && rej.reason === "locked_content_source", "ws-7a: content_source='manual' → locked_content_source");
        const q = expDb.prepare(`SELECT COUNT(*) c FROM experience_homepage_review_queue WHERE provider_id='ws-locked'`).get() as any;
        assertEq(q.c, 0, "ws-7b: zero queue writes");
      }

      // ── ws-7b: already has hjemmeside → rejected, zero write. ───────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ provider_id: "ws-has-website", candidate_url: "https://en-annen-side.no", name_verified: true }], apply: true },
        });
        const rej = (r.body.rejected as any[]).find((x) => x.provider_id === "ws-has-website");
        assertTrue(!!rej && rej.reason === "already_has_website", "ws-7c: provider already has hjemmeside → already_has_website");
      }

      // ── ws-8: dry-run vs apply — dry-run makes ZERO DB writes. ──────────
      {
        const dry = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ provider_id: "ws-good", candidate_url: "https://ekte-reststrom-nettside.no", name_verified: true }] },
        });
        assertEq(dry.body.dry_run, true, "ws-8a: dry-run is the default");
        assertEq(dry.body.would_queue_count, 1, "ws-8b: would_queue_count reflects the survivor");
        assertEq((dry.body.would_queue as any[])[0]?.provider_id, "ws-good", "ws-8c: would_queue lists ws-good");
        const qBefore = expDb.prepare(`SELECT COUNT(*) c FROM experience_homepage_review_queue WHERE provider_id='ws-good'`).get() as any;
        assertEq(qBefore.c, 0, "ws-8d: dry-run wrote NOTHING to the queue");
        const stampBefore = expDb.prepare(`SELECT web_search_homepage_attempted_at FROM experience_providers WHERE id='ws-good'`).get() as any;
        assertEq(stampBefore.web_search_homepage_attempted_at, null, "ws-8e: dry-run stamped NOTHING (cursor untouched)");

        // ── ws-9: apply on the SAME fully-valid candidate → queued with the
        //    right reason/confidence/evidence; a SECOND submission for the
        //    same provider → already_queued_for_provider. ─────────────────
        const apply1 = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ provider_id: "ws-good", candidate_url: "https://ekte-reststrom-nettside.no", name_verified: true }], apply: true },
        });
        assertEq(apply1.body.dry_run, false, "ws-9a: apply mode");
        assertEq(apply1.body.queued_count, 1, "ws-9b: queued_count is 1");
        const qRow = expDb.prepare(`SELECT * FROM experience_homepage_review_queue WHERE provider_id='ws-good'`).get() as any;
        assertTrue(!!qRow, "ws-9c: candidate parked in the review queue");
        assertEq(qRow?.candidate_url, "https://ekte-reststrom-nettside.no", "ws-9d: queued candidate_url matches the submitted URL");
        assertEq(qRow?.reason, "web_search_candidate", "ws-9e: reason is 'web_search_candidate'");
        assertEq(qRow?.confidence, 0.6, "ws-9f: confidence fixed at the conservative 0.6");
        assertEq(qRow?.status, "pending", "ws-9g: queue row starts pending");
        const evidence = JSON.parse(qRow?.evidence || "{}");
        assertEq(evidence.source, "web_search", "ws-9h: evidence.source is 'web_search'");
        assertEq(evidence.host, "ekte-reststrom-nettside.no", "ws-9i: evidence.host is the candidate's host");
        const stampAfter = expDb.prepare(`SELECT web_search_homepage_attempted_at FROM experience_providers WHERE id='ws-good'`).get() as any;
        assertTrue(!!stampAfter.web_search_homepage_attempted_at, "ws-9j: web_search_homepage_attempted_at stamped after apply");

        const apply2 = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ provider_id: "ws-good", candidate_url: "https://en-annen-kandidat.no", name_verified: true }], apply: true },
        });
        const rej2 = (apply2.body.rejected as any[]).find((x) => x.provider_id === "ws-good");
        assertTrue(!!rej2 && rej2.reason === "already_queued_for_provider", "ws-9k: a second submission for the same provider → already_queued_for_provider");
        const qStill = expDb.prepare(`SELECT candidate_url FROM experience_homepage_review_queue WHERE provider_id='ws-good'`).get() as any;
        assertEq(qStill?.candidate_url, "https://ekte-reststrom-nettside.no", "ws-9l: the original queue row is UNTOUCHED (not overwritten)");
      }

      // ── ws-10: cursor rotation — after processing (apply), the row's
      //    web_search_homepage_attempted_at advances and it sorts AFTER
      //    not-yet-attempted rows on a subsequent GET call. ────────────────
      {
        // ws-good and ws-residual have both been apply-processed above
        // (queued / name_not_verified respectively); ws-agg-target,
        // ws-catalog-target and ws-locked have too. ws-has-website is
        // never a candidate at all (has hjemmeside). Insert a brand-new,
        // never-attempted residual row and confirm it sorts BEFORE the
        // already-attempted ones.
        insertProvider.run({ id: "ws-fresh", navn: "Fersk Gård", org_nr: null, listing_url: null, hjemmeside: null, content_source: null, kommune: "Voss", producer_type: null });
        const r = await callRoute(opplevelserRouter, { method: "GET", url: "/admin/providers/homepage-open-uncovered", headers: adminHeaders, query: { limit: "30" } });
        const ids = (r.body.candidates as any[]).map((c) => c.id);
        const freshIdx = ids.indexOf("ws-fresh");
        const residualIdx = ids.indexOf("ws-residual");
        assertTrue(freshIdx !== -1, "ws-10a: never-attempted row present");
        assertTrue(residualIdx !== -1, "ws-10b: already-attempted row still present (not yet queued/locked)");
        assertTrue(freshIdx < residualIdx, "ws-10c: never-attempted row sorts BEFORE the already-attempted row");
      }

      // ── ws-11: submit batch cap — >30 candidates → 400. ─────────────────
      {
        const many = Array.from({ length: 31 }, (_, i) => ({ provider_id: `nope-${i}`, candidate_url: "https://x.no", name_verified: true }));
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { candidates: many, apply: true } });
        assertEq(r.status, 400, "ws-11a: >30 candidates → 400");
      }

      // ── ws-12: invalid_item / duplicate_in_request / not_found never
      //    stamp (nothing meaningful to attribute the attempt to). ────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: {
            candidates: [
              { provider_id: "", candidate_url: "https://x.no", name_verified: true },
              { provider_id: "does-not-exist", candidate_url: "https://x.no", name_verified: true },
              { provider_id: "ws-fresh", candidate_url: "https://fersk-nettside.no", name_verified: true },
              { provider_id: "ws-fresh", candidate_url: "https://fersk-nettside-2.no", name_verified: true },
            ],
            apply: true,
          },
        });
        const reasons = (r.body.rejected as any[]).map((x) => x.reason);
        assertTrue(reasons.includes("invalid_item"), "ws-12a: blank provider_id → invalid_item");
        assertTrue(reasons.includes("not_found"), "ws-12b: unknown provider_id → not_found");
        assertTrue(reasons.includes("duplicate_in_request"), "ws-12c: repeated provider_id within one request → duplicate_in_request");
        const stampNotFound = expDb.prepare(`SELECT web_search_homepage_attempted_at FROM experience_providers WHERE id='ws-fresh'`).get() as any;
        assertTrue(!!stampNotFound.web_search_homepage_attempted_at, "ws-12d: ws-fresh (the real, found row) DID get stamped despite being the duplicate-in-request pair");
      }

      // ── ws-13: migration is additive + idempotent. ──────────────────────
      {
        const initModule = require("../database/init-experiences") as typeof import("../database/init-experiences");
        const rawDb = require("better-sqlite3");
        const scratchDb = new rawDb(":memory:");
        initModule.initExperiencesSchema(scratchDb);
        initModule.initExperiencesSchema(scratchDb); // second call must not throw
        const cols = scratchDb.prepare(`PRAGMA table_info(experience_providers)`).all() as any[];
        assertTrue(
          cols.some((c) => c.name === "web_search_homepage_attempted_at"),
          "ws-13a: web_search_homepage_attempted_at column exists after migration",
        );
        scratchDb.close();
        const liveCols = (expDb.prepare(`PRAGMA table_info(experience_providers)`).all() as any[]).map((c) => c.name);
        assertTrue(liveCols.includes("web_search_homepage_attempted_at"), "ws-13b: column also present on the live test DB handle");
      }

      // ── ws-14: the EXISTING listing-homepage-review-approve route adopts
      //    a 'web_search_candidate' row exactly as it does the other legs'
      //    rows — no new approve route needed. ─────────────────────────────
      {
        const approve = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/listing-homepage-review-approve",
          body: { approvals: [{ provider_id: "ws-good", url: "https://ekte-reststrom-nettside.no" }], apply: true },
        });
        assertEq(approve.body.written_count, 1, "ws-14a: the generic approve lever writes a web_search_candidate row");
        const row = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='ws-good'`).get() as any;
        assertEq(row.hjemmeside, "https://ekte-reststrom-nettside.no", "ws-14b: hjemmeside persisted via the shared writeProviderHjemmeside helper");
        const qRow = expDb.prepare(`SELECT status FROM experience_homepage_review_queue WHERE provider_id='ws-good'`).get() as any;
        assertEq(qRow.status, "approved", "ws-14c: queue row flipped to approved");
      }
      // ── ws-15: cross-provider host_already_queued_elsewhere — a host
      //    PENDING in the queue for a DIFFERENT provider from an EARLIER,
      //    SEPARATE request must reject a later request for that same host,
      //    even though queuedThisRun (same-request-only) never sees it.
      //    Mirrors listing-homepage-discovery's / brreg-website-discovery's
      //    identical queuedElsewhereCount guard.
      //
      //    NB the guard's own SQL is `candidate_url LIKE '%' || host`, which
      //    only matches when the STORED candidate_url literally ENDS with
      //    the host (same characteristic as the sibling legs' identical
      //    query) — so the first submission's candidate_url is host-only
      //    (no path) to land a matchable row; the second carries a path to
      //    prove the match is host-based, not exact-URL-based. ───────────
      {
        const first = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ provider_id: "ws-cross-a", candidate_url: "https://kryssvert-ws.no", name_verified: true }], apply: true },
        });
        assertEq(first.body.queued_count, 1, "ws-15a: first request (ws-cross-a) queues successfully");
        const qA = expDb.prepare(`SELECT * FROM experience_homepage_review_queue WHERE provider_id='ws-cross-a'`).get() as any;
        assertTrue(!!qA, "ws-15b: ws-cross-a landed in the review queue");
        assertEq(qA?.status, "pending", "ws-15c: ws-cross-a's queue row is pending");

        const second = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { candidates: [{ provider_id: "ws-cross-b", candidate_url: "https://kryssvert-ws.no/kontakt", name_verified: true }], apply: true },
        });
        const rej = (second.body.rejected as any[]).find((x) => x.provider_id === "ws-cross-b");
        assertTrue(
          !!rej && rej.reason === "host_already_queued_elsewhere",
          "ws-15d: SECOND request, DIFFERENT provider, same host, host PENDING for ws-cross-a → host_already_queued_elsewhere",
        );
        assertEq(second.body.queued_count, 0, "ws-15e: second request queues nothing");

        const qHost = expDb.prepare(`SELECT COUNT(*) c FROM experience_homepage_review_queue WHERE candidate_url LIKE '%kryssvert-ws.no%'`).get() as any;
        assertEq(qHost.c, 1, "ws-15f: only ONE row total lands in the queue for this host");
        const qB = expDb.prepare(`SELECT 1 FROM experience_homepage_review_queue WHERE provider_id='ws-cross-b'`).get() as any;
        assertTrue(!qB, "ws-15g: ws-cross-b never got a queue row of its own");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-web-search-homepage-discovery: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-web-search-homepage-discovery.test.ts`
if (require.main === module) {
  runOpplevelserWebSearchHomepageDiscoveryTests(true).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
