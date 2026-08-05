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
    const testKey = process.env.ADMIN_KEY || "brreg-website-test-key";
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

      // ── bw-9: sub-slice 3g — the explicit-providerIds branch's lock check
      //    now goes through the shared isHjemmesideLocked() helper (already
      //    shipped for hjemmeside-write/listing-homepage-discovery, sub-
      //    slices 3d/3e), narrowing the freeze from an unconditional
      //    row-level content_source check to isGardssalgFieldOwnerLocked()'s
      //    per-field owner_locks stamp — but ONLY for gårdssalg-identified
      //    rows (producer_type set, or rfb_seed_source='rfb-seed'). A
      //    non-gårdssalg claim row keeps today's exact unconditional freeze.
      //    (Mirrors opplevelser-listing-homepage-discovery.test.ts's lh-9
      //    section, adapted to this route's org_nr-keyed candidate set —
      //    org_nr left NULL here since these fixtures only need to prove
      //    skipped_locked membership, not a full discovery proposal.) ───────
      {
        (globalThis.fetch as any) = (async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch;

        const insertGardssalgFixture = expDb.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, org_nr, hjemmeside, content_source, source, confidence,
              enrichment_state, verification_status, producer_type, rfb_seed_source, field_provenance)
           VALUES
             (@id, @navn, 'experiences', NULL, NULL, @content_source, 'test-fixture', 'medium',
              'raw', 'pending_verify', @producer_type, @rfb_seed_source, @field_provenance)`,
        );

        // bw-3g-1: gårdssalg row (producer_type set), content_source='claim',
        // field_provenance has owner_locks but NOT for 'hjemmeside' → not locked.
        insertGardssalgFixture.run({
          id: "bw-3g-unlocked-producer-type",
          navn: "Ulåst Bryggeri Brreg",
          content_source: "claim",
          producer_type: "bryggeri",
          rfb_seed_source: null,
          field_provenance: JSON.stringify({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00Z" } } }),
        });
        // bw-3g-2: same gårdssalg row shape, but owner_locks.hjemmeside IS
        // present → locked (negative control).
        insertGardssalgFixture.run({
          id: "bw-3g-locked-producer-type",
          navn: "Låst Bryggeri Brreg",
          content_source: "claim",
          producer_type: "bryggeri",
          rfb_seed_source: null,
          field_provenance: JSON.stringify({ owner_locks: { hjemmeside: { locked_at: "2026-08-01T00:00:00Z" } } }),
        });
        // bw-3g-3: gårdssalg identity via rfb_seed_source instead of
        // producer_type, no owner_locks.hjemmeside → not locked.
        insertGardssalgFixture.run({
          id: "bw-3g-unlocked-rfbseed",
          navn: "Ulåst Rfb-Seed Brreg",
          content_source: "claim",
          producer_type: null,
          rfb_seed_source: "rfb-seed",
          field_provenance: JSON.stringify({ owner_locks: {} }),
        });
        // bw-3g-4: critical safety test — NON-gårdssalg row (no producer_type,
        // no rfb_seed_source='rfb-seed'), content_source='claim', but an
        // ADVERSARIAL owner_locks.hjemmeside present anyway → still locked.
        // A non-gårdssalg claim row's freeze must never consult field_provenance.
        insertGardssalgFixture.run({
          id: "bw-3g-adversarial-non-gardssalg",
          navn: "Ikke Gårdssalg Brreg",
          content_source: "claim",
          producer_type: null,
          rfb_seed_source: null,
          field_provenance: JSON.stringify({ owner_locks: { hjemmeside: { locked_at: "2026-08-01T00:00:00Z" } } }),
        });
        // bw-3g-5: gårdssalg row with content_source='manual' → stays locked
        // unconditionally, regardless of field_provenance contents (manual
        // rows never consult owner_locks).
        insertGardssalgFixture.run({
          id: "bw-3g-manual-producer-type",
          navn: "Manuelt Bryggeri Brreg",
          content_source: "manual",
          producer_type: "bryggeri",
          rfb_seed_source: null,
          field_provenance: JSON.stringify({ owner_locks: {} }),
        });

        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: {
            providerIds: [
              "bw-3g-unlocked-producer-type",
              "bw-3g-locked-producer-type",
              "bw-3g-unlocked-rfbseed",
              "bw-3g-adversarial-non-gardssalg",
              "bw-3g-manual-producer-type",
            ],
          },
        });
        assertEq(r.status, 200, "bw-3g-0: request succeeds");
        const skippedIds = (r.body.skipped_locked as any[]).map((s) => s.provider_id);
        const noWebsiteIds = (r.body.no_website_in_brreg as any[]).map((n) => n.provider_id);

        assertTrue(
          !skippedIds.includes("bw-3g-unlocked-producer-type"),
          "bw-3g-1 (AC2): gårdssalg row (producer_type), owner_locks without 'hjemmeside' → NOT skipped_locked",
        );
        assertTrue(
          noWebsiteIds.includes("bw-3g-unlocked-producer-type"),
          "bw-3g-1b: ...and proceeds to normal discovery processing (reaches no_website_in_brreg, null org_nr)",
        );

        assertTrue(
          skippedIds.includes("bw-3g-locked-producer-type"),
          "bw-3g-2 (AC3): same gårdssalg row shape, but owner_locks.hjemmeside present → IS skipped_locked (negative control)",
        );

        assertTrue(
          !skippedIds.includes("bw-3g-unlocked-rfbseed"),
          "bw-3g-3: gårdssalg identity via rfb_seed_source='rfb-seed' (producer_type null), no owner_locks.hjemmeside → NOT skipped_locked",
        );
        assertTrue(
          noWebsiteIds.includes("bw-3g-unlocked-rfbseed"),
          "bw-3g-3b: ...and proceeds to normal discovery processing",
        );

        assertTrue(
          skippedIds.includes("bw-3g-adversarial-non-gardssalg"),
          "bw-3g-4: non-gårdssalg claim row with adversarial owner_locks.hjemmeside → STILL skipped_locked (field_provenance never consulted for non-gårdssalg rows)",
        );

        assertTrue(
          skippedIds.includes("bw-3g-manual-producer-type"),
          "bw-3g-5: gårdssalg row with content_source='manual' → skipped_locked unconditionally regardless of field_provenance",
        );

        // Existing bw-locked fixture (non-gårdssalg claim row, no
        // producer_type/rfb_seed_source, no field_provenance) — unmodified
        // re-assertion that it still lands in skipped_locked after the switch
        // to isHjemmesideLocked().
        const rLocked = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { providerIds: ["bw-locked"] },
        });
        assertEq(
          (rLocked.body.skipped_locked as any[])[0]?.provider_id,
          "bw-locked",
          "bw-3g-6: pre-existing non-gårdssalg bw-locked fixture still lands in skipped_locked, unmodified",
        );

        expDb.prepare(`DELETE FROM experience_providers WHERE id LIKE 'bw-3g-%'`).run();
      }

      // ── bw-10: sub-slice 3g — the auto-batch branch (no providerIds in the
      //    body) gains a two-phase top-up: phase 1 is today's exact SQL query
      //    unchanged (LIMIT BW_DISCOVERY_BATCH_CAP=30); phase 2 ONLY runs when
      //    phase 1 under-fills the batch, widening eligibility to gårdssalg
      //    content_source='claim' rows that pass isHjemmesideLocked()===false
      //    (the same shared, already-shipped gate 3d/3e/3f already use).
      //    Fetch is forced to 404 throughout — every fixture below only needs
      //    to prove it was PROCESSED (landed in `targets`, visible via
      //    proposed/excluded/no_website_in_brreg) or NOT processed, not
      //    whether a website candidate was actually found. Each sub-test
      //    inserts its own uniquely-prefixed (`bw-3g10-...`) fixtures with
      //    distinct org_nr values (org_nr is UNIQUE) and deletes them again
      //    afterward, so sub-tests don't leak into one another's
      //    phase-1/phase-2 pool. Several earlier-section fixtures
      //    (bw-agg/bw-taken/bw-none/bw-404/bw-null-source/bw-prequeued) are
      //    still phase-1-eligible by the time this section runs (org_nr set,
      //    hjemmeside never actually written, content_source NULL) — rather
      //    than hardcode that count, it's measured directly off the live DB
      //    (`baselineCount`) so these assertions stay correct regardless of
      //    what earlier sections leave behind. Well under the 30 cap either
      //    way, so phase 2 runs by default for every sub-test here except
      //    bw-10a (which deliberately fills the cap with phase-1-only rows
      //    first). ─────────────────────────────────────────────────────────
      {
        (globalThis.fetch as any) = (async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch;

        const baselineCount = (
          expDb
            .prepare(
              `SELECT COUNT(*) c FROM experience_providers
                WHERE org_nr IS NOT NULL AND hjemmeside IS NULL
                  AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))`,
            )
            .get() as any
        ).c as number;

        const insertGardssalgClaim = expDb.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, org_nr, hjemmeside, content_source, source, confidence,
              enrichment_state, verification_status, producer_type, rfb_seed_source, field_provenance)
           VALUES
             (@id, @navn, 'experiences', @org_nr, NULL, @content_source, 'test-fixture', 'medium',
              'raw', 'pending_verify', @producer_type, @rfb_seed_source, @field_provenance)`,
        );

        function autoBatch(): Promise<RouteResult> {
          return callRoute(opplevelserRouter, { headers: adminHeaders, body: {} });
        }
        function processedIdSet(r: RouteResult): Set<string> {
          const s = new Set<string>();
          for (const p of r.body.proposed as any[]) s.add(p.provider_id);
          for (const e of r.body.excluded as any[]) s.add(e.provider_id);
          for (const n of r.body.no_website_in_brreg as any[]) s.add(n.provider_id);
          return s;
        }
        function deleteFixtures(ids: string[]): void {
          const del = expDb.prepare(`DELETE FROM experience_providers WHERE id = ?`);
          for (const id of ids) del.run(id);
        }

        // ── bw-10a (AC4): phase 1 alone already fills BW_DISCOVERY_BATCH_CAP
        //    (>=30 eligible non-manual/non-claim rows) → phase 2 does NOT
        //    run, even though an eligible+unlocked gårdssalg claim row
        //    exists. ─────────────────────────────────────────────────────
        {
          const capFillIds: string[] = [];
          const insertCapFill = expDb.prepare(
            `INSERT INTO experience_providers
               (id, navn, vertical, org_nr, hjemmeside, content_source, source, confidence,
                enrichment_state, verification_status)
             VALUES (@id, @navn, 'experiences', @org_nr, NULL, NULL, 'test-fixture', 'medium',
                     'raw', 'pending_verify')`,
          );
          for (let i = 0; i < 30; i++) {
            const id = `bw-3g10-capfill-${i}`;
            capFillIds.push(id);
            insertCapFill.run({ id, navn: `Cap Fill ${i}`, org_nr: `91${String(i).padStart(7, "0")}` });
          }
          insertGardssalgClaim.run({
            id: "bw-3g10-ac4-claim",
            navn: "AC4 Skulle Vært Med",
            org_nr: "920000001",
            content_source: "claim",
            producer_type: "bryggeri",
            rfb_seed_source: null,
            field_provenance: JSON.stringify({ owner_locks: {} }),
          });

          const r = await autoBatch();
          assertEq(r.body.scanned, 30, "bw-10a-1: phase 1 alone fills the cap (30 scanned)");
          assertTrue(
            !processedIdSet(r).has("bw-3g10-ac4-claim"),
            "bw-10a-2 (AC4): eligible+unlocked gårdssalg claim row NOT processed — phase 2 never ran because phase 1 already filled the cap",
          );

          deleteFixtures([...capFillIds, "bw-3g10-ac4-claim"]);
        }

        // ── bw-10b (AC5): phase 1 under-fills; a gårdssalg (producer_type
        //    set) content_source='claim' row with owner_locks.hjemmeside NOT
        //    set → appears in targets (processed). ─────────────────────────
        {
          insertGardssalgClaim.run({
            id: "bw-3g10-ac5-unlocked",
            navn: "AC5 Ulåst Bryggeri",
            org_nr: "920000002",
            content_source: "claim",
            producer_type: "bryggeri",
            rfb_seed_source: null,
            field_provenance: JSON.stringify({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00Z" } } }),
          });

          const r = await autoBatch();
          assertTrue(
            processedIdSet(r).has("bw-3g10-ac5-unlocked"),
            "bw-10b (AC5): gårdssalg claim row (producer_type), owner_locks without 'hjemmeside' → IS processed (widening works)",
          );

          deleteFixtures(["bw-3g10-ac5-unlocked"]);
        }

        // ── bw-10c (AC6): same shape, but owner_locks.hjemmeside IS set →
        //    negative control, row does NOT appear in targets. ─────────────
        {
          insertGardssalgClaim.run({
            id: "bw-3g10-ac6-locked",
            navn: "AC6 Låst Bryggeri",
            org_nr: "920000003",
            content_source: "claim",
            producer_type: "bryggeri",
            rfb_seed_source: null,
            field_provenance: JSON.stringify({ owner_locks: { hjemmeside: { locked_at: "2026-08-01T00:00:00Z" } } }),
          });

          const r = await autoBatch();
          assertTrue(
            !processedIdSet(r).has("bw-3g10-ac6-locked"),
            "bw-10c (AC6): same gårdssalg row shape but owner_locks.hjemmeside present → NOT processed (negative control, same gate as 3d/3e/3f)",
          );

          deleteFixtures(["bw-3g10-ac6-locked"]);
        }

        // ── bw-10d (AC7): gårdssalg identity via rfb_seed_source='rfb-seed'
        //    (producer_type NULL) instead of producer_type, no
        //    owner_locks.hjemmeside → also appears (both identity signals
        //    honored, matching 3e/3f's equivalent AC). ────────────────────
        {
          insertGardssalgClaim.run({
            id: "bw-3g10-ac7-rfbseed",
            navn: "AC7 Ulåst Rfb-Seed",
            org_nr: "920000004",
            content_source: "claim",
            producer_type: null,
            rfb_seed_source: "rfb-seed",
            field_provenance: JSON.stringify({ owner_locks: {} }),
          });

          const r = await autoBatch();
          assertTrue(
            processedIdSet(r).has("bw-3g10-ac7-rfbseed"),
            "bw-10d (AC7): gårdssalg identity via rfb_seed_source='rfb-seed' (producer_type null), no owner_locks.hjemmeside → IS processed",
          );

          deleteFixtures(["bw-3g10-ac7-rfbseed"]);
        }

        // ── bw-10e (AC8): critical safety proof — content_source='manual'
        //    rows never appear in targets via EITHER branch, regardless of
        //    lock state. Auto-batch half: phase 1's own pool here is the
        //    1-row baseline, well under the cap, so phase 2 genuinely runs.
        //    Proves phase 2's SQL-level content_source = 'claim' filter —
        //    not just the JS gate — keeps manual out. ──────────────────────
        {
          const manualIds: string[] = [];
          for (let i = 0; i < 5; i++) {
            const id = `bw-3g10-ac8-manual-${i}`;
            manualIds.push(id);
            insertGardssalgClaim.run({
              id,
              navn: `AC8 Manuell ${i}`,
              org_nr: `92000010${i}`,
              content_source: "manual",
              producer_type: "bryggeri",
              rfb_seed_source: null,
              field_provenance: JSON.stringify({ owner_locks: {} }),
            });
          }

          const r = await autoBatch();
          const processed = processedIdSet(r);
          assertTrue(
            manualIds.every((id) => !processed.has(id)),
            "bw-10e (AC8, auto-batch half): content_source='manual' rows NEVER appear in targets, even gårdssalg-identified + field-level-unlocked ones",
          );

          deleteFixtures(manualIds);
        }
        // AC8's explicit-providerIds half is covered by bw-3g-5 above
        // (content_source='manual' gårdssalg row stays skipped_locked
        // unconditionally regardless of field_provenance).

        // ── bw-10f (AC9): non-gårdssalg content_source='claim' row
        //    (producer_type NULL, rfb_seed_source NOT 'rfb-seed') is never
        //    returned by phase 2 even with an adversarial owner_locks entry
        //    that would look "unlocked" — proves the SQL-level gårdssalg-
        //    identity filter is the first gate, isHjemmesideLocked the
        //    second, belt-and-suspenders. ──────────────────────────────────
        {
          insertGardssalgClaim.run({
            id: "bw-3g10-ac9-adversarial",
            navn: "AC9 Ikke Gårdssalg",
            org_nr: "920000020",
            content_source: "claim",
            producer_type: null,
            rfb_seed_source: null,
            field_provenance: JSON.stringify({ owner_locks: {} }),
          });

          const r = await autoBatch();
          assertTrue(
            !processedIdSet(r).has("bw-3g10-ac9-adversarial"),
            "bw-10f (AC9): non-gårdssalg claim row (no producer_type/rfb_seed_source) never returned by phase 2, even with an adversarial owner_locks shape",
          );

          deleteFixtures(["bw-3g10-ac9-adversarial"]);
        }

        // ── bw-10g (AC10): total targets.length from the combined phase-1 +
        //    phase-2 flow never exceeds BW_DISCOVERY_BATCH_CAP, even when
        //    phase 2 has far more eligible candidates (40) than remaining
        //    slots (30 - baselineCount). ────────────────────────────────────
        {
          const ac10Ids: string[] = [];
          for (let i = 0; i < 40; i++) {
            const id = `bw-3g10-ac10-${i}`;
            ac10Ids.push(id);
            insertGardssalgClaim.run({
              id,
              navn: `AC10 Kandidat ${i}`,
              org_nr: `93${String(i).padStart(7, "0")}`,
              content_source: "claim",
              producer_type: "bryggeri",
              rfb_seed_source: null,
              field_provenance: JSON.stringify({ owner_locks: {} }),
            });
          }

          const r = await autoBatch();
          assertEq(r.body.scanned, 30, "bw-10g-1 (AC10): total scanned never exceeds the cap even with 40 eligible phase-2 candidates");
          const processed = processedIdSet(r);
          const ac10Processed = ac10Ids.filter((id) => processed.has(id));
          const expectedRemainingSlots = 30 - baselineCount;
          assertEq(
            ac10Processed.length,
            expectedRemainingSlots,
            `bw-10g-2: exactly remaining_slots (${expectedRemainingSlots}) of the 40 eligible phase-2 candidates are taken, never more`,
          );

          deleteFixtures(ac10Ids);
        }

        // ── bw-10h (AC1): existing auto-batch tests (phase-1-only scenarios,
        //    no gårdssalg claim rows in the fixture set) pass unmodified —
        //    zero behavior change for the dominant case. bw-4 above already
        //    covers this against the mixed fixture set; this is a direct,
        //    isolated re-check against the clean baseline (all bw-10a..g
        //    fixtures deleted above) confirming the result set is EXACTLY
        //    the pre-existing baseline pool, nothing more, nothing less. ───
        {
          const r = await autoBatch();
          assertEq(
            r.body.scanned,
            baselineCount,
            `bw-10h-1 (AC1): clean baseline (no new gårdssalg claim rows) scans exactly the ${baselineCount} pre-existing eligible row(s)`,
          );
          assertTrue(processedIdSet(r).has("bw-null-source"), "bw-10h-2: baseline row bw-null-source still processed, unmodified by the 3g change");
        }
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
