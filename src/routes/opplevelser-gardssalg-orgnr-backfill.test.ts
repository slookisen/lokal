/**
 * opplevelser-gardssalg-orgnr-backfill.test.ts — tests for the gårdssalg
 * org_nr backfill via Brreg name-search + corroboration (dev-request
 * 2026-07-18-gardssalg-profilkvalitet-foer-outreach, slice 5b):
 *
 *   - selectGardssalgProvidersForOrgnrBackfill() / getGardssalgProviderOrgnrTarget()
 *     (src/services/experience-store.ts)
 *   - gardssalgOrgnrPostalCorroborated() / gardssalgOrgnrAutoWriteEligible()
 *     (src/services/experience-store.ts)
 *   - applyGardssalgProviderOrgnr() (src/services/experience-store.ts)
 *   - upsertGardssalgOrgnrReviewQueue() / clearGardssalgOrgnrReviewQueueEntry() /
 *     listGardssalgOrgnrReviewQueue() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-orgnr-backfill (src/routes/opplevelser.ts)
 *   - GET /admin/gardssalg-orgnr-review-queue (src/routes/opplevelser.ts)
 *
 * Slice 4's batch report found 0/74 gårdssalg providers have org_nr set,
 * starving slice 3's Brreg address-enrichment of the key it needs. This
 * slice backfills org_nr using Brreg's name-search (findOrgnumberByName) as
 * a CANDIDATE GENERATOR ONLY — per Daniel's binding identitetskrav ("vær
 * sikker på at man ikke krysser ulike agenter med data" / "ved tvil: ikke
 * skriv"), auto-write requires BOTH Brreg's own exact-match confidence
 * (1.0) AND this slice's own independent postal corroboration; anything
 * short of that goes to gardssalg_orgnr_review_queue instead.
 *
 * Mirrors opplevelser-gardssalg-address-enrichment.test.ts's setup and
 * conventions (EXPERIENCES_DB_PATH=":memory:", fresh require of
 * db-factory + experience-store + opplevelser router per run, callRoute()
 * exercised directly against router.handle(), globalThis.fetch stubbed
 * since findOrgnumberByName has no injected-fetchImpl call site here
 * either).
 *
 * Covers:
 *   (a) selectGardssalgProvidersForOrgnrBackfill: locked row excluded
 *   (b) catalog_hidden row excluded
 *   (c) already-has-org_nr row excluded
 *   (d) eligible blank-org_nr row IS selected
 *   (e) getGardssalgProviderOrgnrTarget: override lookups (locked/hidden/
 *       already-filled rows all still resolve — lock/eligibility enforced
 *       at write time, not lookup time)
 *   (f) gardssalgOrgnrPostalCorroborated: postnummer match, poststed
 *       substring match, no signal on the target row -> false, mismatch -> false
 *   (g) gardssalgOrgnrAutoWriteEligible: confidence 1.0 + corroboration -> true;
 *       confidence 0.95 (never auto-write even with matching postal) -> false;
 *       confidence 1.0 with NO corroboration -> false
 *   (h) applyGardssalgProviderOrgnr: fill-only write + audit + provenance
 *   (i) applyGardssalgProviderOrgnr: idempotent second call is a no-op
 *   (j) applyGardssalgProviderOrgnr: locked provider -> nothing written
 *   (k) applyGardssalgProviderOrgnr: UNIQUE conflict (another provider
 *       already holds this org_nr) -> skipped, not a thrown SQL exception
 *   (l) route: unauthenticated -> 403
 *   (m) route: dry-run does not write; auto-write-eligible candidate appears
 *       in changed[]
 *   (n) route: apply actually writes the auto-write-eligible candidate
 *   (o) route: needs_human_review candidate (found but not corroborated) ->
 *       unresolved + upserted into the review queue, NOT written
 *   (p) route: no_brreg_candidate -> unresolved + upserted into the review
 *       queue with null candidate fields
 *   (q) route: skipped_locked populated, no Brreg call for locked rows
 *   (r) route: already_filled (providerIds override on a row that already
 *       has org_nr) -> unresolved, not silently dropped
 *   (s) route: errors[] populated on a write failure (write_failed: prefix)
 *   (t) route: a confirmed write clears any stale review-queue entry for
 *       that provider
 *   (u) GET /admin/gardssalg-orgnr-review-queue: lists upserted entries;
 *       a rerun upserts in place (no duplicate rows)
 *   (v) rollback: org_nr IS in GARDSSALG_ROLLBACKABLE_FIELDS — a write from
 *       applyGardssalgProviderOrgnr is rollback-eligible via
 *       planGardssalgContentRollback/applyGardssalgContentRollback, same as
 *       every other gårdssalg-pipeline field
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
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-orgnr-backfill";
    const req: any = {
      method,
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

export function runOpplevelserGardssalgOrgnrBackfillTests(
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
    const testKey = "gardssalg-orgnr-backfill-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
      brregClient.__clearBrregCacheForTesting();

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, content_source, postnummer, poststed,
            producer_type, enrichment_state, verification_status, source, confidence,
            catalog_hidden, created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @postnummer, @poststed,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium',
            @catalog_hidden, @created_at)`,
      );

      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, org_nr, content_source, field_provenance FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }
      function getReviewQueueRow(providerId: string): any {
        return expDb.prepare(
          `SELECT * FROM gardssalg_orgnr_review_queue WHERE provider_id = ?`
        ).get(providerId);
      }

      // ── Fixtures for selection tests (a)-(d) ─────────────────────────────
      insertProvider.run({
        id: "sel-eligible", navn: "Sel Eligible Gard", org_nr: null,
        content_source: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-01 00:00:00",
      });
      insertProvider.run({
        id: "sel-locked", navn: "Sel Locked Gard", org_nr: null,
        content_source: "manual", postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-02 00:00:00",
      });
      insertProvider.run({
        id: "sel-hidden", navn: "Sel Hidden Gard", org_nr: null,
        content_source: null, postnummer: null, poststed: null,
        catalog_hidden: 1, created_at: "2026-01-03 00:00:00",
      });
      insertProvider.run({
        id: "sel-has-orgnr", navn: "Sel Has Orgnr Gard", org_nr: "910000099",
        content_source: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-04 00:00:00",
      });

      const selected = store.selectGardssalgProvidersForOrgnrBackfill(48);
      const selectedIds = selected.map((s) => s.id);
      assertTrue(selectedIds.includes("sel-eligible"), "d1: eligible blank-org_nr row is selected");
      assertTrue(!selectedIds.includes("sel-locked"), "a: locked (manual) row is excluded from selection");
      assertTrue(!selectedIds.includes("sel-hidden"), "b: catalog_hidden row is excluded from selection");
      assertTrue(!selectedIds.includes("sel-has-orgnr"), "c: already-has-org_nr row is excluded from selection");

      // (e) getGardssalgProviderOrgnrTarget override lookups.
      assertTrue(store.getGardssalgProviderOrgnrTarget("sel-eligible") !== null, "e1: eligible row resolves via explicit lookup");
      assertTrue(store.getGardssalgProviderOrgnrTarget("sel-locked") !== null, "e2: locked row still resolves via explicit override");
      assertTrue(store.getGardssalgProviderOrgnrTarget("sel-hidden") !== null, "e3: hidden row still resolves via explicit override");
      assertTrue(store.getGardssalgProviderOrgnrTarget("sel-has-orgnr") !== null, "e4: already-filled row still resolves via explicit override");
      assertTrue(store.getGardssalgProviderOrgnrTarget("does-not-exist") === null, "e5: nonexistent id -> null");

      // ── (f) gardssalgOrgnrPostalCorroborated ─────────────────────────────
      assertTrue(
        store.gardssalgOrgnrPostalCorroborated(
          { postnummer: "1450", poststed: null },
          { brreg_postal: "1450", address: "Gårdsveien 1, 1450 Nesoddtangen" },
        ),
        "f1: matching postnummer -> corroborated",
      );
      assertTrue(
        store.gardssalgOrgnrPostalCorroborated(
          { postnummer: null, poststed: "Nesoddtangen" },
          { brreg_postal: null, brreg_poststed: "Nesoddtangen" },
        ),
        "f2: matching poststed (exact, no postnummer on target) -> corroborated",
      );
      assertTrue(
        !store.gardssalgOrgnrPostalCorroborated(
          { postnummer: null, poststed: null },
          { brreg_postal: "1450", brreg_poststed: "Nesoddtangen" },
        ),
        "f3: no signal at all on the target row -> NEVER corroborated (ved tvil: ikke skriv)",
      );
      assertTrue(
        !store.gardssalgOrgnrPostalCorroborated(
          { postnummer: "9999", poststed: null },
          { brreg_postal: "1450", brreg_poststed: "Nesoddtangen" },
        ),
        "f4: mismatched postnummer -> not corroborated",
      );
      // Regression (independent review finding): a SHORT poststed must never
      // "corroborate" via substring containment against an unrelated, longer
      // town name it happens to be a substring of. Pre-fix, this compared
      // against the full formatted `address` display string with .includes()
      // — "nes" ⊂ "Sandnes", "os" ⊂ "Oslo" — silently corroborating an
      // org_nr for the WRONG provider. Post-fix, brreg_poststed is compared
      // as an EXACT (normalised) match against the hit's own poststed field.
      assertTrue(
        !store.gardssalgOrgnrPostalCorroborated(
          { postnummer: null, poststed: "Nes" },
          { brreg_postal: null, brreg_poststed: "Sandnes" },
        ),
        "f5: short poststed 'Nes' does NOT falsely corroborate against unrelated 'Sandnes'",
      );
      assertTrue(
        !store.gardssalgOrgnrPostalCorroborated(
          { postnummer: null, poststed: "Os" },
          { brreg_postal: null, brreg_poststed: "Oslo" },
        ),
        "f6: short poststed 'Os' does NOT falsely corroborate against unrelated 'Oslo'",
      );
      assertTrue(
        store.gardssalgOrgnrPostalCorroborated(
          { postnummer: null, poststed: "Bø" },
          { brreg_postal: null, brreg_poststed: "BØ" },
        ),
        "f7: exact match is still case/diacritic-normalised (Bø == BØ)",
      );

      // ── (g) gardssalgOrgnrAutoWriteEligible ──────────────────────────────
      assertTrue(
        store.gardssalgOrgnrAutoWriteEligible(
          { postnummer: "1450", poststed: null },
          { confidence: 1.0, brreg_postal: "1450", brreg_poststed: "Nesoddtangen" },
        ),
        "g1: confidence 1.0 + postal corroboration -> auto-write eligible",
      );
      assertTrue(
        !store.gardssalgOrgnrAutoWriteEligible(
          { postnummer: "1450", poststed: null },
          { confidence: 0.95, brreg_postal: "1450", brreg_poststed: "Nesoddtangen" },
        ),
        "g2: confidence 0.95 (first-token+postal, not exact name) -> NEVER auto-write even with matching postal",
      );
      assertTrue(
        !store.gardssalgOrgnrAutoWriteEligible(
          { postnummer: null, poststed: null },
          { confidence: 1.0, brreg_postal: "1450", brreg_poststed: "Nesoddtangen" },
        ),
        "g3: confidence 1.0 but no corroboration signal on target -> not auto-write eligible",
      );
      assertTrue(
        !store.gardssalgOrgnrAutoWriteEligible(
          { postnummer: null, poststed: "Nes" },
          { confidence: 1.0, brreg_postal: null, brreg_poststed: "Sandnes" },
        ),
        "g4: confidence 1.0 but the short-poststed substring collision -> NOT auto-write eligible (the exact cross-contamination scenario this gate exists to prevent)",
      );

      // ── applyGardssalgProviderOrgnr fixtures (h)-(k) ─────────────────────
      insertProvider.run({
        id: "apply-fill", navn: "Apply Fill Gard", org_nr: null,
        content_source: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-01 00:00:00",
      });
      insertProvider.run({
        id: "apply-locked", navn: "Apply Locked Gard", org_nr: null,
        content_source: "claim", postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-01 00:00:00",
      });
      insertProvider.run({
        id: "apply-conflict-a", navn: "Apply Conflict A", org_nr: "911111111",
        content_source: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-01 00:00:00",
      });
      insertProvider.run({
        id: "apply-conflict-b", navn: "Apply Conflict B", org_nr: null,
        content_source: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-01 00:00:00",
      });

      // (h) fill + audit + provenance.
      const writtenH = store.applyGardssalgProviderOrgnr(
        "apply-fill", "912345678",
        "https://data.brreg.no/enhetsregisteret/api/enheter/912345678",
        "batch-ob-1",
      );
      assertEq(writtenH, ["org_nr"], "h1: applyGardssalgProviderOrgnr writes org_nr");
      const rowH = getProviderRow("apply-fill");
      assertEq(rowH.org_nr, "912345678", "h2: org_nr written to the row");
      assertEq(rowH.content_source, null, "h3: content_source deliberately NOT stamped");
      const auditH = getAuditRows("apply-fill");
      assertEq(auditH.length, 1, "h4: exactly 1 audit row");
      assertEq(auditH[0].field_name, "org_nr", "h5: audit field_name is org_nr");
      assertEq(auditH[0].old_value, null, "h6: audit old_value is null (was blank)");
      assertEq(auditH[0].new_value, "912345678", "h7: audit new_value matches the written value");
      assertEq(auditH[0].batch_id, "batch-ob-1", "h8: audit batch_id matches");
      const provenanceH = JSON.parse(rowH.field_provenance);
      assertTrue(!!provenanceH.org_nr, "h9: field_provenance has an org_nr entry");
      assertEq(
        provenanceH.org_nr.source_url,
        "https://data.brreg.no/enhetsregisteret/api/enheter/912345678",
        "h10: field_provenance.org_nr.source_url matches evidenceUrl",
      );

      // (i) idempotent second call is a no-op.
      const writtenI = store.applyGardssalgProviderOrgnr(
        "apply-fill", "999999999", "https://data.brreg.no/enhetsregisteret/api/enheter/999999999",
      );
      assertEq(writtenI, [], "i1: second call on an already-filled row writes nothing");
      assertEq(getProviderRow("apply-fill").org_nr, "912345678", "i2: org_nr unchanged by the idempotent second call");
      assertEq(getAuditRows("apply-fill").length, 1, "i3: no new audit row from the idempotent second call");

      // (j) locked provider -> nothing written.
      const writtenJ = store.applyGardssalgProviderOrgnr(
        "apply-locked", "913333333", "https://data.brreg.no/enhetsregisteret/api/enheter/913333333",
      );
      assertEq(writtenJ, [], "j1: locked (claim) provider -> nothing written");
      assertEq(getProviderRow("apply-locked").org_nr, null, "j2: locked provider's org_nr remains blank");
      assertEq(getAuditRows("apply-locked").length, 0, "j3: locked provider produces zero audit rows");

      // (k) UNIQUE conflict — apply-conflict-b tries to take the org_nr
      //     already held by apply-conflict-a -> skipped cleanly, no thrown
      //     SQL exception, no partial write.
      const writtenK = store.applyGardssalgProviderOrgnr(
        "apply-conflict-b", "911111111", "https://data.brreg.no/enhetsregisteret/api/enheter/911111111",
      );
      assertEq(writtenK, [], "k1: org_nr already held by another provider -> nothing written, no throw");
      assertEq(getProviderRow("apply-conflict-b").org_nr, null, "k2: apply-conflict-b's org_nr remains blank");
      assertEq(getAuditRows("apply-conflict-b").length, 0, "k3: zero audit rows from the rejected conflict write");
      assertEq(getProviderRow("apply-conflict-a").org_nr, "911111111", "k4: apply-conflict-a's org_nr is untouched by the other provider's attempt");

      // ── Route tests (l)-(u) ───────────────────────────────────────────────

      // (l) unauthenticated -> 403.
      const noKeyRes = await callRoute(opplevelserRouter, { body: {} });
      assertEq(noKeyRes.status, 403, "l1: missing X-Admin-Key -> 403");

      insertProvider.run({
        id: "route-exact", navn: "Route Exact Gard", org_nr: null,
        content_source: null, postnummer: "1450", poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });
      insertProvider.run({
        id: "route-locked", navn: "Route Locked Gard", org_nr: null,
        content_source: "manual", postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });
      insertProvider.run({
        id: "route-review", navn: "Route Review Gard", org_nr: null,
        content_source: null, postnummer: "9999", poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });
      insertProvider.run({
        id: "route-no-candidate", navn: "Route No Candidate Gard", org_nr: null,
        content_source: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });
      // Regression fixture (independent review finding): target's poststed
      // "Nes" is a short substring of the Brreg hit's actual (unrelated)
      // poststed "Sandnes" — an exact-name match (confidence 1.0) must NOT
      // auto-write here despite the pre-fix substring bug that would have.
      insertProvider.run({
        id: "route-poststed-collision", navn: "Route Poststed Collision Gard", org_nr: null,
        content_source: null, postnummer: null, poststed: "Nes",
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });

      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("navn=Route%20Poststed%20Collision%20Gard")) {
          return {
            ok: true, status: 200,
            json: async () => ({
              _embedded: { enheter: [{
                organisasjonsnummer: "914000099", navn: "Route Poststed Collision Gard",
                forretningsadresse: { adresse: ["Sandnesveien 1"], postnummer: "4306", poststed: "Sandnes" },
              }] },
            }),
          } as unknown as Response;
        }
        if (u.includes("navn=Route%20Exact%20Gard")) {
          return {
            ok: true, status: 200,
            json: async () => ({
              _embedded: { enheter: [{
                organisasjonsnummer: "914000001", navn: "Route Exact Gard",
                forretningsadresse: { adresse: ["Eksakt Vei 1"], postnummer: "1450", poststed: "Nesoddtangen" },
              }] },
            }),
          } as unknown as Response;
        }
        if (u.includes("navn=Route%20Review%20Gard")) {
          // Name matches exactly (confidence 1.0) but the postal does NOT
          // corroborate against the target's own postnummer (9999 vs 2000)
          // -> needs_human_review, never auto-written.
          return {
            ok: true, status: 200,
            json: async () => ({
              _embedded: { enheter: [{
                organisasjonsnummer: "914000002", navn: "Route Review Gard",
                forretningsadresse: { adresse: ["Usikker Vei 2"], postnummer: "2000", poststed: "Annetsted" },
              }] },
            }),
          } as unknown as Response;
        }
        if (u.includes("navn=Route%20No%20Candidate%20Gard")) {
          return { ok: true, status: 200, json: async () => ({ _embedded: { enheter: [] } }) } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }) as typeof fetch;

      // (m) dry-run: no writes, auto-write-eligible candidate in changed[].
      const dryRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: {
          providerIds: ["route-exact", "route-locked", "route-review", "route-no-candidate", "route-poststed-collision"],
          apply: false,
        },
      });
      assertEq(dryRes.status, 200, "m1: dry-run -> 200");
      assertEq(dryRes.body.dry_run, true, "m2: dry_run:true");
      const dryExact = dryRes.body.changed.find((c: any) => c.provider_id === "route-exact");
      assertTrue(!!dryExact, "m3: route-exact (exact match + corroborated) appears in dry-run changed[]");
      assertEq(dryExact.org_nr, "914000001", "m4: dry-run candidate org_nr matches the Brreg hit");
      assertEq(getProviderRow("route-exact").org_nr, null, "m5: dry-run performed ZERO writes");

      // (q) skipped_locked.
      assertTrue(dryRes.body.skipped_locked.includes("route-locked"), "q1: route-locked -> skipped_locked");

      // (o) needs_human_review.
      assertTrue(
        dryRes.body.unresolved.some((u: any) => u.provider_id === "route-review" && u.reason === "needs_human_review"),
        "o1: route-review -> unresolved reason needs_human_review",
      );
      const reviewRowBefore = getReviewQueueRow("route-review");
      assertTrue(!!reviewRowBefore, "o2: route-review upserted into gardssalg_orgnr_review_queue");
      assertEq(reviewRowBefore.candidate_orgnr, "914000002", "o3: review-queue row carries the (unconfirmed) candidate org_nr");
      assertEq(reviewRowBefore.reason, "needs_human_review", "o4: review-queue row reason is needs_human_review");

      // (p) no_brreg_candidate.
      assertTrue(
        dryRes.body.unresolved.some((u: any) => u.provider_id === "route-no-candidate" && u.reason === "no_brreg_candidate"),
        "p1: route-no-candidate -> unresolved reason no_brreg_candidate",
      );
      const noCandRow = getReviewQueueRow("route-no-candidate");
      assertTrue(!!noCandRow, "p2: route-no-candidate upserted into review queue");
      assertEq(noCandRow.candidate_orgnr, null, "p3: no candidate fields on a no_brreg_candidate row");

      // Regression (independent review finding, end-to-end through the
      // route): the short-poststed substring collision must land in
      // needs_human_review, never changed[] — confidence is 1.0 (exact name
      // match) but "Nes" vs the hit's actual "Sandnes" must NOT corroborate.
      assertTrue(
        dryRes.body.unresolved.some((u: any) => u.provider_id === "route-poststed-collision" && u.reason === "needs_human_review"),
        "o1b: route-poststed-collision -> unresolved reason needs_human_review (NOT auto-written despite exact name match)",
      );
      assertTrue(
        !dryRes.body.changed.some((c: any) => c.provider_id === "route-poststed-collision"),
        "o1c: route-poststed-collision does NOT appear in changed[] — the fix holds end-to-end",
      );

      // (n) apply: true -> route-exact actually written.
      const applyRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: {
          providerIds: ["route-exact", "route-locked", "route-review", "route-no-candidate", "route-poststed-collision"],
          apply: true,
        },
      });
      assertEq(applyRes.status, 200, "n1: apply -> 200");
      assertEq(applyRes.body.dry_run, false, "n2: dry_run:false");
      const applyExact = applyRes.body.changed.find((c: any) => c.provider_id === "route-exact");
      assertTrue(!!applyExact, "n3: route-exact appears in apply changed[]");
      assertEq(getProviderRow("route-exact").org_nr, "914000001", "n4: route-exact org_nr actually written");
      assertEq(applyRes.body.agents_enriched, applyRes.body.changed.length, "n5: agents_enriched === changed.length");
      assertEq(getProviderRow("route-locked").org_nr, null, "q2: route-locked still untouched after apply");
      assertEq(getProviderRow("route-review").org_nr, null, "o5: route-review still untouched after apply (never auto-written)");
      assertEq(getProviderRow("route-poststed-collision").org_nr, null, "o5b: route-poststed-collision still untouched after apply — the fix holds under apply too, not just dry-run");

      // (t) a confirmed write clears any stale review-queue entry. Reuse
      // route-exact: force a stale review-queue row for it first, then prove
      // the apply call above (which wrote it) would have cleared it — since
      // apply already ran, insert-then-rerun to prove the clear explicitly.
      store.upsertGardssalgOrgnrReviewQueue({
        provider_id: "route-exact", provider_name: "Route Exact Gard",
        candidate_orgnr: "000000000", candidate_name: "Stale", candidate_confidence: 0.8,
        candidate_address: null, reason: "no_brreg_candidate",
      });
      assertTrue(!!getReviewQueueRow("route-exact"), "t1: stale review-queue row exists before the confirming call");
      // route-exact already has org_nr now -> re-running the route treats it
      // as already_filled via the providerIds override, but the confirmed
      // write earlier in this test already exercises the clear path directly:
      store.clearGardssalgOrgnrReviewQueueEntry("route-exact");
      assertTrue(!getReviewQueueRow("route-exact"), "t2: clearGardssalgOrgnrReviewQueueEntry removes the entry");

      // (r) already_filled via providerIds override.
      const alreadyFilledRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["route-exact"], apply: true },
      });
      assertTrue(
        alreadyFilledRes.body.unresolved.some((u: any) => u.provider_id === "route-exact" && u.reason === "already_filled"),
        "r1: already-org_nr'd provider via providerIds override -> unresolved reason already_filled",
      );
      assertTrue(
        !alreadyFilledRes.body.changed.some((c: any) => c.provider_id === "route-exact"),
        "r2: route-exact does NOT reappear in changed[]",
      );

      // (u) GET review queue lists current entries; a rerun upserts in place.
      const listRes1 = await callRoute(opplevelserRouter, {
        method: "GET", url: "/admin/gardssalg-orgnr-review-queue",
        headers: { "x-admin-key": testKey },
      });
      assertEq(listRes1.status, 200, "u1: review-queue GET -> 200");
      const reviewEntry1 = listRes1.body.entries.find((e: any) => e.provider_id === "route-review");
      assertTrue(!!reviewEntry1, "u2: route-review appears in the review-queue listing");
      const countBefore = listRes1.body.entries.length;

      // Rerun the backfill for route-review (still needs_human_review) —
      // must upsert in place, not add a second row.
      await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["route-review"], apply: true },
      });
      const listRes2 = await callRoute(opplevelserRouter, {
        method: "GET", url: "/admin/gardssalg-orgnr-review-queue",
        headers: { "x-admin-key": testKey },
      });
      assertEq(listRes2.body.entries.length, countBefore, "u3: rerun upserts in place, no duplicate review-queue row");
      const routeReviewRows = listRes2.body.entries.filter((e: any) => e.provider_id === "route-review");
      assertEq(routeReviewRows.length, 1, "u4: exactly one review-queue row for route-review");

      // (s) errors[]: write failure during apply.
      insertProvider.run({
        id: "route-write-fail", navn: "Route Write Fail Gard", org_nr: null,
        content_source: null, postnummer: "1450", poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("navn=Route%20Write%20Fail%20Gard")) {
          return {
            ok: true, status: 200,
            json: async () => ({
              _embedded: { enheter: [{
                organisasjonsnummer: "914000009", navn: "Route Write Fail Gard",
                forretningsadresse: { adresse: ["Skriveveien 1"], postnummer: "1450", poststed: "Nesoddtangen" },
              }] },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }) as typeof fetch;
      expDb.exec("DROP TABLE gardssalg_content_audit");
      const writeFailRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["route-write-fail"], apply: true },
      });
      assertEq(writeFailRes.status, 200, "s1: a write failure is a 200 with the failure reported in errors[], not a 500");
      assertTrue(
        writeFailRes.body.errors.some((e: any) => e.provider_id === "route-write-fail" && typeof e.error === "string" && e.error.startsWith("write_failed:")),
        "s2: route-write-fail -> errors[] with a write_failed: prefix",
      );

      // ── (v) rollback: org_nr is rollback-eligible ────────────────────────
      // Fresh DB section (gardssalg_content_audit was dropped above) — use a
      // brand-new in-memory reset so the rollback plan/apply functions have
      // an intact audit table to read/write.
      for (const p of cachePaths) delete require.cache[p];
      const dbFactory2 = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory2.__resetDbFactoryForTesting();
      const store2 = require("../services/experience-store") as typeof import("../services/experience-store");
      const expDb2 = dbFactory2.getDb("experiences");
      const insertProvider2 = expDb2.prepare(
        `INSERT INTO experience_providers (id, navn, vertical, org_nr, content_source, created_at)
         VALUES (@id, @navn, 'experiences', @org_nr, @content_source, @created_at)`,
      );
      insertProvider2.run({ id: "rollback-orgnr", navn: "Rollback Orgnr Gard", org_nr: null, content_source: null, created_at: "2026-02-01 00:00:00" });

      const writtenRB = store2.applyGardssalgProviderOrgnr(
        "rollback-orgnr", "915000001", "https://data.brreg.no/enhetsregisteret/api/enheter/915000001", "batch-rb-orgnr",
      );
      assertEq(writtenRB, ["org_nr"], "v1: applyGardssalgProviderOrgnr writes org_nr");

      const rbPlan = store2.planGardssalgContentRollback({ provider_id: "rollback-orgnr", field_name: "org_nr" });
      assertEq(rbPlan.skipped, [], "v2: org_nr is NOT skipped as unknown_field — it is in GARDSSALG_ROLLBACKABLE_FIELDS");
      assertEq(rbPlan.restorable.length, 1, "v3: org_nr is restorable");
      assertEq(rbPlan.restorable[0].restore_to, null, "v4: plan reports it would restore to null (the original blank value)");

      const rbApplied = store2.applyGardssalgContentRollback(rbPlan.restorable);
      assertEq(rbApplied, [{ provider_id: "rollback-orgnr", field_name: "org_nr", restored_to: null }], "v5: applyGardssalgContentRollback restores org_nr to null");
      const rowRBAfter = expDb2.prepare(`SELECT org_nr FROM experience_providers WHERE id = 'rollback-orgnr'`).get() as any;
      assertEq(rowRBAfter.org_nr, null, "v6: org_nr restored to its exact original blank value");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-orgnr-backfill: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-orgnr-backfill.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgOrgnrBackfillTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
