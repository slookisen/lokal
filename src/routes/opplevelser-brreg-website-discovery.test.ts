/**
 * opplevelser-brreg-website-discovery.test.ts — tests for dev-request
 * 2026-07-12-experiences-enrichment-supply-and-aggregator-hygiene, Daniel's
 * decision, step 2, evidence-leg (b): POST /admin/brreg-website-discovery
 * (direct Brreg org-nr lookup — GET /enheter/{orgNr} — reading the
 * `hjemmeside` field via the new fetchBrregWebsite(), screening out
 * directory/aggregator hosts and hosts already adopted elsewhere before
 * parking a verified candidate in experience_homepage_review_queue with
 * reason 'brreg_website_candidate' — NEVER written directly to hjemmeside)
 * and a regression proof that the EXISTING POST /admin/listing-homepage-
 * review-approve route adopts a 'brreg_website_candidate' row exactly as it
 * does 'listing_page_link_candidate' rows (no new approve route needed, per
 * the dev-request's explicit reuse instruction).
 *
 * Same conventions as opplevelser-listing-homepage-discovery.test.ts (router
 * .handle() as the HTTP entry point, in-memory experiences DB, fresh requires
 * per run) but mocks globalThis.fetch keyed on the Brreg org-nr URL (GET
 * /enheter/{orgNr}) — the SAME mocking convention
 * opplevelser-gardssalg-address-enrichment.test.ts already uses for
 * fetchBrregBusinessAddress, since this route calls fetchBrregWebsite with no
 * injected fetchImpl (always the global fetch).
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
    const url = opts.url || "/admin/brreg-website-discovery";
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

export function runOpplevelserBrregWebsiteDiscoveryTests(
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
    const prevFetch = globalThis.fetch;
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = "brreg-website-test-key";
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
      const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
      brregClient.__clearBrregWebsiteCacheForTesting();
      const adminHeaders = { "x-admin-key": testKey };

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, hjemmeside, content_source, source, confidence,
            enrichment_state, verification_status)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @hjemmeside, @content_source, 'test-fixture', 'medium',
            'raw', 'pending_verify')`,
      );

      // ── Fixtures ─────────────────────────────────────────────────────────
      // bw-good: Brreg carries a real, non-aggregator, not-already-used site.
      insertProvider.run({ id: "bw-good", navn: "Ekte Gård", org_nr: "800000001", hjemmeside: null, content_source: null });
      // bw-agg: Brreg's own hjemmeside points at a known aggregator/DMO host.
      insertProvider.run({ id: "bw-agg", navn: "Aggregert Gård", org_nr: "800000002", hjemmeside: null, content_source: null });
      // bw-taken: Brreg's hjemmeside host is already live as a DIFFERENT provider's hjemmeside.
      insertProvider.run({ id: "bw-taken", navn: "Tatt Brreg Gård", org_nr: "800000003", hjemmeside: null, content_source: null });
      insertProvider.run({ id: "bw-owner", navn: "Annen Eier Brreg", org_nr: null, hjemmeside: "https://tattdomene-brreg.no", content_source: null });
      // bw-none: Brreg has no hjemmeside field at all for this org-nr.
      insertProvider.run({ id: "bw-none", navn: "Nettsidelaus Gård", org_nr: "800000004", hjemmeside: null, content_source: null });
      // bw-404: org-nr not found in Brreg at all.
      insertProvider.run({ id: "bw-404", navn: "Ukjent Orgnr Gård", org_nr: "800000005", hjemmeside: null, content_source: null });
      // bw-locked: content_source claim -> never processed.
      insertProvider.run({ id: "bw-locked", navn: "Krevd Brreg Gård", org_nr: "800000006", hjemmeside: null, content_source: "claim" });
      // bw-has-website: already has hjemmeside -> never processed.
      insertProvider.run({ id: "bw-has-website", navn: "Har Brreg Nettside", org_nr: "800000007", hjemmeside: "https://harnettside-brreg.no", content_source: null });
      // bw-no-orgnr: no org_nr -> never a candidate (acceptance criterion 4).
      insertProvider.run({ id: "bw-no-orgnr", navn: "Uten Orgnr Gård", org_nr: null, hjemmeside: null, content_source: null });
      // bw-null-source: content_source is NULL (not "manual"/"claim") -> IS a
      // candidate. Regression guard for the NULL-safe form of the candidate
      // SQL: a bare `content_source NOT IN ('manual','claim')` is NULL (never
      // TRUE) for every NULL-content_source row per SQL's three-valued logic,
      // which would silently exclude every un-sourced/auto-discovered
      // provider — mirrors leg (a)'s existing selector, which already guards
      // against exactly this.
      insertProvider.run({ id: "bw-null-source", navn: "Nullkilde Gård", org_nr: "800000008", hjemmeside: null, content_source: null });

      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        const mk = (json: any) => ({ ok: true, status: 200, json: async () => json } as unknown as Response);
        const notFound = () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
        if (u.includes("/enheter/800000001")) return mk({ organisasjonsnummer: "800000001", navn: "Ekte Gård", hjemmeside: "https://ekte-nettside.no" });
        if (u.includes("/enheter/800000002")) return mk({ organisasjonsnummer: "800000002", navn: "Aggregert Gård", hjemmeside: "https://tripadvisor.com/attraction/aggregert" });
        if (u.includes("/enheter/800000003")) return mk({ organisasjonsnummer: "800000003", navn: "Tatt Brreg Gård", hjemmeside: "https://tattdomene-brreg.no/om-oss" });
        if (u.includes("/enheter/800000004")) return mk({ organisasjonsnummer: "800000004", navn: "Nettsidelaus Gård", hjemmeside: "" });
        if (u.includes("/enheter/800000005")) return notFound();
        if (u.includes("/enheter/800000008")) return mk({ organisasjonsnummer: "800000008", navn: "Nullkilde Gård", hjemmeside: "https://nullkilde-nettside.no" });
        return notFound();
      }) as unknown as typeof fetch;

      // ── bw-1: auth gate. ─────────────────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, { body: {} });
        assertEq(r.status, 403, "bw-1a: no admin key → 403 on discovery route");
      }

      // ── bw-2: DRY-RUN — Brreg fetched, NOTHING written. ─────────────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: {
            providerIds: [
              "bw-good", "bw-agg", "bw-taken", "bw-none", "bw-404",
              "bw-locked", "bw-has-website", "finnes-ikke",
            ],
          },
        });
        assertEq(r.status, 200, "bw-2a: dry-run 200");
        assertEq(r.body.dry_run, true, "bw-2b: dry-run is the default");
        assertEq(r.body.scanned, 5, "bw-2c: locked + already-has-website + unknown never reach processing (5 real targets)");
        assertEq((r.body.skipped_locked as any[])[0]?.provider_id, "bw-locked", "bw-2d: locked row reported");
        assertEq((r.body.already_has_website as any[])[0]?.provider_id, "bw-has-website", "bw-2e: already-has-website row reported");
        assertEq((r.body.not_found as any[])[0], "finnes-ikke", "bw-2f: unknown id reported");
        assertEq(r.body.proposed_count, 1, "bw-2g: exactly one proposal (bw-good)");

        const prop = (r.body.proposed as any[])[0];
        assertEq(prop?.provider_id, "bw-good", "bw-2h: proposed candidate is bw-good");
        assertEq(prop?.candidate_url, "https://ekte-nettside.no", "bw-2i: candidate_url is Brreg's own hjemmeside origin");
        assertEq(prop?.confidence, 1.0, "bw-2j: confidence is 1.0 (Brreg's own registry record, no separate text-verification leg)");
        assertEq(prop?.evidence?.org_nr, "800000001", "bw-2k: evidence records the org_nr used");

        const aggEx = (r.body.excluded as any[]).find((e) => e.provider_id === "bw-agg");
        assertTrue(!!aggEx && aggEx.reason === "directory_or_aggregator_host" && aggEx.host === "tripadvisor.com",
          "bw-2l: Brreg hjemmeside pointing at a known aggregator host → excluded");
        assertTrue(!(r.body.proposed as any[]).some((p) => p.provider_id === "bw-agg"), "bw-2m: aggregator-host row never proposed");

        const takenEx = (r.body.excluded as any[]).find((e) => e.provider_id === "bw-taken");
        assertTrue(!!takenEx && takenEx.reason === "host_already_in_catalog" && takenEx.host === "tattdomene-brreg.no",
          "bw-2n: host already live as a DIFFERENT provider's hjemmeside → excluded (misattribution guard)");
        assertTrue(!(r.body.proposed as any[]).some((p) => p.provider_id === "bw-taken"), "bw-2o: already-in-catalog row never proposed");

        const noneRes = (r.body.no_website_in_brreg as any[]).find((e) => e.provider_id === "bw-none");
        assertTrue(!!noneRes, "bw-2p: Brreg has a blank hjemmeside field → no_website_in_brreg");
        const notFoundRes = (r.body.no_website_in_brreg as any[]).find((e) => e.provider_id === "bw-404");
        assertTrue(!!notFoundRes, "bw-2q: Brreg 404s the org-nr → no_website_in_brreg");

        const qCnt = (expDb.prepare(`SELECT COUNT(*) c FROM experience_homepage_review_queue`).get() as any).c;
        assertEq(qCnt, 0, "bw-2r: dry-run wrote NOTHING to the queue");
        const hj = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='bw-good'`).get() as any).hjemmeside;
        assertEq(hj, null, "bw-2s: dry-run never writes hjemmeside directly (acceptance criterion 2)");
        const stamped = (expDb.prepare(`SELECT COUNT(*) c FROM experience_providers WHERE brreg_website_discovery_attempted_at IS NOT NULL`).get() as any).c;
        assertEq(stamped, 0, "bw-2t: dry-run stamped NOTHING (strict !dryRun-only convention)");
      }

      // ── bw-3: APPLY — queue upserted with reason 'brreg_website_candidate',
      //    stamps land on EVERY processed row, hjemmeside still untouched
      //    (acceptance criterion 3). ───────────────────────────────────────
      let queuedUrl = "";
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { providerIds: ["bw-good", "bw-agg", "bw-taken", "bw-none"], apply: true },
        });
        assertEq(r.body.dry_run, false, "bw-3a: apply mode");
        assertEq(r.body.proposed_count, 1, "bw-3b: same single proposal");
        const q = expDb.prepare(`SELECT * FROM experience_homepage_review_queue WHERE provider_id='bw-good'`).get() as any;
        assertTrue(!!q, "bw-3c: proposal parked in the review queue");
        assertEq(q?.candidate_url, "https://ekte-nettside.no", "bw-3d: queued candidate_url is Brreg's own hjemmeside origin");
        assertEq(q?.reason, "brreg_website_candidate", "bw-3e: reason is 'brreg_website_candidate' (acceptance criterion 3)");
        assertEq(q?.confidence, 1.0, "bw-3e2: queued confidence is 1.0");
        assertEq(q?.status, "pending", "bw-3f: queue row starts pending");
        queuedUrl = q?.candidate_url;
        const hj = (expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='bw-good'`).get() as any).hjemmeside;
        assertEq(hj, null, "bw-3g: apply on discovery NEVER writes hjemmeside directly — queue-only (acceptance criterion 3)");
        const stamps = expDb.prepare(
          `SELECT id FROM experience_providers WHERE brreg_website_discovery_attempted_at IS NOT NULL ORDER BY id`,
        ).all() as any[];
        assertEq(stamps.length, 4, "bw-3h: ALL 4 processed rows stamped (acceptance criterion 7: attempted-at stamped for no_website_in_brreg rows too)");
        assertEq(r.body.queue_size, 1, "bw-3i: queue size reported");
      }

      // ── bw-4: auto-select candidate-set query (acceptance criterion 4 +
      //    NULL-content_source inclusion regression). ─────────────────────
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
        const allIds = (r.body.proposed as any[]).map((p) => p.provider_id)
          .concat((r.body.excluded as any[]).map((e) => e.provider_id))
          .concat((r.body.no_website_in_brreg as any[]).map((e) => e.provider_id));
        assertTrue(!allIds.includes("bw-locked"), "bw-4a: locked row never auto-selected");
        assertTrue(!allIds.includes("bw-has-website"), "bw-4b: row WITH hjemmeside never auto-selected");
        assertTrue(!allIds.includes("bw-no-orgnr"), "bw-4c: row with no org_nr never auto-selected (acceptance criterion 4)");
        assertTrue(allIds.includes("bw-null-source"), "bw-4d: NULL-content_source row IS auto-selected (not silently excluded by the NOT IN(...) NULL trap)");
        const nullSourceProp = (r.body.proposed as any[]).find((p) => p.provider_id === "bw-null-source");
        assertTrue(!!nullSourceProp, "bw-4e: NULL-content_source row's Brreg website was actually proposed");
      }

      // ── bw-5: already_queued_for_provider — a provider that already has a
      //    pending/approved queue row (from ANY reason, e.g. leg (a)) is
      //    skipped rather than re-upserted, so this leg never clobbers a
      //    still-live proposal with its own (UNIQUE(provider_id) guard). ───
      {
        insertProvider.run({ id: "bw-prequeued", navn: "Forhåndskøet Gård", org_nr: "800000009", hjemmeside: null, content_source: null });
        (globalThis.fetch as any) = (async (url: string | URL | Request) => {
          const u = String(url);
          if (u.includes("/enheter/800000009")) {
            return { ok: true, status: 200, json: async () => ({ organisasjonsnummer: "800000009", navn: "Forhåndskøet Gård", hjemmeside: "https://ny-brreg-kandidat.no" }) } as unknown as Response;
          }
          return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
        }) as unknown as typeof fetch;
        // Simulate a pre-existing pending row from leg (a) for this SAME provider.
        expDb.prepare(
          `INSERT INTO experience_homepage_review_queue
             (id, provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, status, created_at, resolved_at)
           VALUES ('preq-1', 'bw-prequeued', 'Forhåndskøet Gård', 'https://listing-side-kandidat.no', 'https://listing-side-kandidat.no', '{}', 0.8, 'listing_page_link_candidate', 'batch-x', 'pending', datetime('now'), NULL)`,
        ).run();

        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { providerIds: ["bw-prequeued"], apply: true },
        });
        const ex = (r.body.excluded as any[]).find((e) => e.provider_id === "bw-prequeued");
        assertTrue(!!ex && ex.reason === "already_queued_for_provider", "bw-5a: provider with an existing pending queue row is excluded, not re-proposed");
        assertTrue(!(r.body.proposed as any[]).some((p) => p.provider_id === "bw-prequeued"), "bw-5b: not proposed");
        const q = expDb.prepare(`SELECT candidate_url, reason FROM experience_homepage_review_queue WHERE provider_id='bw-prequeued'`).get() as any;
        assertEq(q?.candidate_url, "https://listing-side-kandidat.no", "bw-5c: the pre-existing queue row is UNTOUCHED (not overwritten with the new Brreg candidate)");
        assertEq(q?.reason, "listing_page_link_candidate", "bw-5d: the pre-existing row's reason is unchanged");
      }

      // ── bw-6: approve lever — the EXISTING listing-homepage-review-approve
      //    route adopts a 'brreg_website_candidate' row exactly as it does
      //    'listing_page_link_candidate' rows, no changes needed (acceptance
      //    criterion 8). ─────────────────────────────────────────────────
      {
        const approve = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          url: "/admin/listing-homepage-review-approve",
          body: { approvals: [{ provider_id: "bw-good", url: queuedUrl }], apply: true },
        });
        assertEq(approve.body.written_count, 1, "bw-6a: the generic approve lever writes a brreg_website_candidate row");
        const row = expDb.prepare(`SELECT hjemmeside FROM experience_providers WHERE id='bw-good'`).get() as any;
        assertEq(row.hjemmeside, "https://ekte-nettside.no", "bw-6b: hjemmeside persisted via the shared writeProviderHjemmeside helper (acceptance criterion 8)");
        const qRow = expDb.prepare(`SELECT status FROM experience_homepage_review_queue WHERE provider_id='bw-good'`).get() as any;
        assertEq(qRow.status, "approved", "bw-6c: queue row flipped to approved");
      }

      // ── bw-7: migration is additive + idempotent (acceptance criterion 1). ─
      {
        const initModule = require("../database/init-experiences") as typeof import("../database/init-experiences");
        const rawDb = require("better-sqlite3");
        const scratchDb = new rawDb(":memory:");
        initModule.initExperiencesSchema(scratchDb);
        initModule.initExperiencesSchema(scratchDb); // second call must not throw
        const cols = scratchDb.prepare(`PRAGMA table_info(experience_providers)`).all() as any[];
        assertTrue(
          cols.some((c) => c.name === "brreg_website_discovery_attempted_at"),
          "bw-7a: brreg_website_discovery_attempted_at column exists after migration",
        );
        scratchDb.close();
        const liveCols = (expDb.prepare(`PRAGMA table_info(experience_providers)`).all() as any[]).map((c) => c.name);
        assertTrue(liveCols.includes("brreg_website_discovery_attempted_at"), "bw-7b: column also present on the live test DB handle");
        const untouchedRow = expDb.prepare(`SELECT navn FROM experience_providers WHERE id = 'bw-owner'`).get() as any;
        assertEq(untouchedRow?.navn, "Annen Eier Brreg", "bw-7c: existing rows unaffected by the additive migration");
      }

      // ── bw-8: fetchBrregWebsite unit coverage (own cache + safe defaults). ─
      {
        (globalThis.fetch as any) = (async (url: string | URL | Request) => {
          const u = String(url);
          if (u.includes("/enheter/810000001")) {
            return { ok: true, status: 200, json: async () => ({ organisasjonsnummer: "810000001", navn: "X", hjemmeside: "  https://med-mellomrom.no  " }) } as unknown as Response;
          }
          if (u.includes("/enheter/810000002")) {
            return { ok: true, status: 200, json: async () => ({ organisasjonsnummer: "810000002", navn: "Y", hjemmeside: "   " }) } as unknown as Response;
          }
          if (u.includes("/enheter/810000003")) {
            throw new Error("simulated network failure");
          }
          return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
        }) as unknown as typeof fetch;
        brregClient.__clearBrregWebsiteCacheForTesting();
        assertEq(await brregClient.fetchBrregWebsite("810000001"), "https://med-mellomrom.no", "bw-8a: hjemmeside is trimmed");
        assertEq(await brregClient.fetchBrregWebsite("810000002"), null, "bw-8b: whitespace-only hjemmeside counts as null");
        assertEq(await brregClient.fetchBrregWebsite("810000003"), null, "bw-8c: network failure never throws, resolves to null");
        assertEq(await brregClient.fetchBrregWebsite("810000009"), null, "bw-8d: 404 resolves to null");
        assertEq(await brregClient.fetchBrregWebsite(""), null, "bw-8e: blank orgNr resolves to null without a fetch");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-brreg-website-discovery: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
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

// Standalone runner: `npx tsx src/routes/opplevelser-brreg-website-discovery.test.ts`
if (require.main === module) {
  runOpplevelserBrregWebsiteDiscoveryTests(true).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
