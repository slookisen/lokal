/**
 * opplevelser-gardssalg-field-concordance-review-approve.test.ts —
 * route-level tests for orchestrator dev-request 2026-08-03-gardssalg-field-
 * concordance-review-approve:
 *
 *   GET  /admin/gardssalg-field-concordance-review-queue
 *   POST /admin/gardssalg-field-concordance-review-approve
 *
 * The missing consumer for gardssalg_field_concordance_review_queue (the
 * table applyGardssalgFieldConcordance, services/gardssalg-field-
 * concordance.ts, populates but never resolves). Same in-memory-DB +
 * router.handle harness as opplevelser-gardssalg-field-concordance-
 * remediation.test.ts.
 *
 * Covers:
 *   1. dry-run makes zero writes (full before/after dump diff of
 *      experience_providers + the review queue)
 *   2. apply=true on a genuine matching approval writes the field, writes
 *      exactly one new gardssalg_content_audit row with the correct
 *      old_value/new_value, stamps field_provenance[field_name], and clears
 *      the queue row
 *   3. mismatch_with_queued_candidate when found_value doesn't match the
 *      queued candidate — no write
 *   4. owner_locked for content_source='manual' AND content_source='claim'
 *      (both lock mobil/epost/telefon since none are in
 *      GARDSSALG_OWNER_LOCK_ELIGIBLE_FIELDS) — DB unchanged either way
 *   5. stale_current_value when the provider's stored value was mutated
 *      after queuing and the approval still carries the ORIGINAL
 *      current_value — no write
 *   6. a second approve of an already-cleared (provider_id, field_name) ->
 *      not_in_review_queue (not a duplicate write)
 *   7. applyGardssalgFieldConcordanceApproval called directly with a
 *      presence-only field name ("adresse") -> written:false,
 *      reason:"invalid_field", never writes
 *   8. a provider with TWO queued fields (epost + telefon) — approving one
 *      leaves the OTHER queue row intact (UNIQUE(provider_id, field_name)
 *      DELETE scoping)
 *   9. (2026-08-09 rollback-veto gap fix) a field whose LATEST
 *      gardssalg_content_audit row is a rollback (source_url ===
 *      "internal://rollback") -> applyGardssalgFieldConcordanceApproval now
 *      returns written:false, reason:"rollback_vetoed", zero write to
 *      experience_providers — exercised both via the route (apply=true) and
 *      via a direct call, checked BEFORE the pre-existing
 *      stale_current_value guard (the queued current_value still matches
 *      the post-rollback stored value, so this rejection can only be
 *      rollback_vetoed, never stale_current_value)
 *
 * Run standalone:
 *   npx tsx src/routes/opplevelser-gardssalg-field-concordance-review-approve.test.ts
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
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url || "/admin/gardssalg-field-concordance-review-approve";
    const method = opts.method || "POST";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() {
        return undefined;
      },
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

export function runOpplevelserGardssalgFieldConcordanceReviewApproveTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-field-concordance-review-approve-test-key";
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
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const experienceStore = require("../services/experience-store") as typeof import("../services/experience-store");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, epost, telefon, mobil, adresse, postnummer, poststed,
            opening_hours_text, producer_type, rfb_seed_source, catalog_hidden, content_source, field_provenance,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @epost, @telefon, @mobil, @adresse, @postnummer, @poststed,
            @opening_hours_text, @producer_type, @rfb_seed_source, @catalog_hidden, @content_source, @field_provenance,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      const insertQueueRow = expDb.prepare(
        `INSERT INTO gardssalg_field_concordance_review_queue
           (id, provider_id, provider_name, field_name, current_value, found_value, reason, batch_id, created_at, updated_at)
         VALUES (@id, @provider_id, @provider_name, @field_name, @current_value, @found_value, 'field_concordance_avvik', @batch_id, datetime('now'), datetime('now'))`,
      );

      function baseProvider(overrides: Record<string, unknown>): Record<string, unknown> {
        return {
          hjemmeside: "https://example.no",
          epost: null,
          telefon: null,
          mobil: null,
          adresse: null,
          postnummer: null,
          poststed: null,
          opening_hours_text: null,
          producer_type: "bryggeri",
          rfb_seed_source: null,
          catalog_hidden: 0,
          content_source: null,
          field_provenance: null,
          ...overrides,
        };
      }

      // prov-match — clean approval target
      insertProvider.run({
        id: "prov-match",
        navn: "Bryggeriet Match",
        ...baseProvider({ epost: "gammel@match.no" }),
      });
      insertQueueRow.run({
        id: "q-match-epost",
        provider_id: "prov-match",
        provider_name: "Bryggeriet Match",
        field_name: "epost",
        current_value: "gammel@match.no",
        found_value: "ny@match.no",
        batch_id: "batch-1",
      });

      // prov-mismatch — approval will submit a DIFFERENT found_value
      insertProvider.run({
        id: "prov-mismatch",
        navn: "Bryggeriet Mismatch",
        ...baseProvider({ telefon: "90000001" }),
      });
      insertQueueRow.run({
        id: "q-mismatch-telefon",
        provider_id: "prov-mismatch",
        provider_name: "Bryggeriet Mismatch",
        field_name: "telefon",
        current_value: "90000001",
        found_value: "90000009",
        batch_id: null,
      });

      // prov-manual — locked (content_source='manual')
      insertProvider.run({
        id: "prov-manual",
        navn: "Sideriet Manual",
        ...baseProvider({ epost: "gammel@manual.no", content_source: "manual" }),
      });
      insertQueueRow.run({
        id: "q-manual-epost",
        provider_id: "prov-manual",
        provider_name: "Sideriet Manual",
        field_name: "epost",
        current_value: "gammel@manual.no",
        found_value: "ny@manual.no",
        batch_id: null,
      });

      // prov-claim — locked (content_source='claim'; mobil not owner-lock-eligible)
      insertProvider.run({
        id: "prov-claim",
        navn: "Sideriet Claim",
        ...baseProvider({ mobil: "99887766", content_source: "claim" }),
      });
      insertQueueRow.run({
        id: "q-claim-mobil",
        provider_id: "prov-claim",
        provider_name: "Sideriet Claim",
        field_name: "mobil",
        current_value: "99887766",
        found_value: "99887799",
        batch_id: null,
      });

      // prov-stale — DB value mutated after queuing
      insertProvider.run({
        id: "prov-stale",
        navn: "Bryggeriet Stale",
        ...baseProvider({ epost: "opprinnelig@stale.no" }),
      });
      insertQueueRow.run({
        id: "q-stale-epost",
        provider_id: "prov-stale",
        provider_name: "Bryggeriet Stale",
        field_name: "epost",
        current_value: "opprinnelig@stale.no",
        found_value: "ny@stale.no",
        batch_id: null,
      });
      // Something else changed the field since the finding was queued.
      expDb.prepare(`UPDATE experience_providers SET epost = 'mellomliggende@stale.no' WHERE id = 'prov-stale'`).run();

      // prov-cleared — will be approved once, then approved again
      insertProvider.run({
        id: "prov-cleared",
        navn: "Bryggeriet Cleared",
        ...baseProvider({ telefon: "90000005" }),
      });
      insertQueueRow.run({
        id: "q-cleared-telefon",
        provider_id: "prov-cleared",
        provider_name: "Bryggeriet Cleared",
        field_name: "telefon",
        current_value: "90000005",
        found_value: "90000006",
        batch_id: null,
      });

      // prov-two-fields — two independently-pending queue rows
      insertProvider.run({
        id: "prov-two-fields",
        navn: "Bryggeriet Tofelt",
        ...baseProvider({ epost: "gammel@tofelt.no", telefon: "90000010" }),
      });
      insertQueueRow.run({
        id: "q-two-epost",
        provider_id: "prov-two-fields",
        provider_name: "Bryggeriet Tofelt",
        field_name: "epost",
        current_value: "gammel@tofelt.no",
        found_value: "ny@tofelt.no",
        batch_id: null,
      });
      insertQueueRow.run({
        id: "q-two-telefon",
        provider_id: "prov-two-fields",
        provider_name: "Bryggeriet Tofelt",
        field_name: "telefon",
        current_value: "90000010",
        found_value: "90000099",
        batch_id: null,
      });

      // prov-vetoed — epost was written by content-refresh, then a human
      // deliberately rolled it back (POST /admin/gardssalg-content-rollback),
      // whose own audit row (source_url = the rollback marker) is the
      // LATEST row for (prov-vetoed, epost). The queued avvik's
      // current_value matches the field's actual post-rollback stored value
      // (null), so absent the new guard this would otherwise sail through
      // as a normal (non-stale) approval.
      insertProvider.run({
        id: "prov-vetoed",
        navn: "Bryggeriet Vetoed",
        ...baseProvider({ epost: null }),
      });
      insertQueueRow.run({
        id: "q-vetoed-epost",
        provider_id: "prov-vetoed",
        provider_name: "Bryggeriet Vetoed",
        field_name: "epost",
        current_value: null,
        found_value: "reappears@vetoed.no",
        batch_id: null,
      });
      expDb
        .prepare(
          `INSERT INTO gardssalg_content_audit
             (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
           VALUES ('aud-vetoed-write', 'prov-vetoed', 'epost', NULL, 'was-here@vetoed.no', 'https://vetoed.no', NULL, 'system', datetime('now'))`,
        )
        .run();
      expDb
        .prepare(
          `INSERT INTO gardssalg_content_audit
             (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
           VALUES ('aud-vetoed-rollback', 'prov-vetoed', 'epost', 'was-here@vetoed.no', NULL, 'internal://rollback', NULL, 'system', datetime('now'))`,
        )
        .run();

      const dumpProviders = () =>
        (expDb.prepare(`SELECT * FROM experience_providers ORDER BY id`).all() as unknown[]).map((r) => JSON.stringify(r));
      const dumpQueue = () =>
        (expDb.prepare(`SELECT * FROM gardssalg_field_concordance_review_queue ORDER BY provider_id, field_name`).all() as unknown[]).map(
          (r) => JSON.stringify(r),
        );
      const dumpAudit = () =>
        (expDb.prepare(`SELECT * FROM gardssalg_content_audit ORDER BY rowid`).all() as unknown[]).map((r) => JSON.stringify(r));

      const authHeaders = { "x-admin-key": testKey };

      // ── auth gate ────────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter);
      assertEq(noKey.status, 403, "auth1: POST without X-Admin-Key -> 403");
      const getNoKey = await callRoute(opplevelserRouter, {
        method: "GET",
        url: "/admin/gardssalg-field-concordance-review-queue",
      });
      assertEq(getNoKey.status, 403, "auth2: GET without X-Admin-Key -> 403");

      // ── GET queue: sanity ────────────────────────────────────────────────
      const getQueue = await callRoute(opplevelserRouter, {
        method: "GET",
        url: "/admin/gardssalg-field-concordance-review-queue",
        headers: authHeaders,
      });
      assertEq(getQueue.status, 200, "get1: GET review-queue -> 200");
      assertEq(getQueue.body.count, 9, "get2: GET review-queue count reflects all 9 fixture rows");
      assertTrue(Array.isArray(getQueue.body.entries), "get3: entries is an array");

      // ── 1. dry-run makes zero writes ────────────────────────────────────
      const beforeProviders = dumpProviders();
      const beforeQueue = dumpQueue();
      const dryRun = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { approvals: [{ provider_id: "prov-match", field_name: "epost", found_value: "ny@match.no" }] },
      });
      assertEq(dryRun.status, 200, "1a: dry-run -> 200");
      assertEq(dryRun.body.dry_run, true, "1b: dry_run:true when apply omitted");
      assertEq(dryRun.body.approved_count, 1, "1c: approved_count 1");
      assertEq(dryRun.body.written_count, 0, "1d: written_count 0 in dry-run");
      const afterDryProviders = dumpProviders();
      const afterDryQueue = dumpQueue();
      assertEq(afterDryProviders, beforeProviders, "1e: experience_providers byte-identical before/after dry-run");
      assertEq(afterDryQueue, beforeQueue, "1f: review queue byte-identical before/after dry-run");

      // ── 2. apply=true on a genuine matching approval ────────────────────
      const beforeAuditMatch = dumpAudit();
      const apply1 = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { apply: true, approvals: [{ provider_id: "prov-match", field_name: "epost", found_value: "ny@match.no" }] },
      });
      assertEq(apply1.status, 200, "2a: apply=true -> 200");
      assertEq(apply1.body.dry_run, false, "2b: dry_run:false when applying");
      assertEq(apply1.body.written_count, 1, "2c: written_count 1");
      assertEq(apply1.body.rejected, [], "2d: nothing rejected");

      const matchRow = expDb.prepare(`SELECT epost, field_provenance FROM experience_providers WHERE id = 'prov-match'`).get() as any;
      assertEq(matchRow.epost, "ny@match.no", "2e: epost column overwritten with the approved value");
      const matchProvenance = JSON.parse(matchRow.field_provenance);
      assertTrue(!!matchProvenance.epost?.fetched_at, "2f: field_provenance.epost stamped");
      assertEq(matchProvenance.epost.source_url, "https://example.no", "2g: field_provenance.epost.source_url uses the provider's hjemmeside");

      const matchQueueAfter = expDb
        .prepare(`SELECT * FROM gardssalg_field_concordance_review_queue WHERE provider_id = 'prov-match'`)
        .all() as any[];
      assertEq(matchQueueAfter.length, 0, "2h: queue row cleared after successful approval");

      const afterAuditMatch = dumpAudit();
      assertEq(afterAuditMatch.length, beforeAuditMatch.length + 1, "2i: exactly one new gardssalg_content_audit row");
      const newAuditRow = expDb
        .prepare(`SELECT * FROM gardssalg_content_audit WHERE provider_id = 'prov-match' AND field_name = 'epost'`)
        .get() as any;
      assertEq(newAuditRow.old_value, "gammel@match.no", "2j: audit old_value is the true pre-write value");
      assertEq(newAuditRow.new_value, "ny@match.no", "2k: audit new_value is the approved value");
      assertEq(newAuditRow.batch_id, "batch-1", "2l: audit batch_id carried from the queue entry");

      // ── 3. mismatch_with_queued_candidate ───────────────────────────────
      const beforeMismatchProviders = dumpProviders();
      const mismatch = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { apply: true, approvals: [{ provider_id: "prov-mismatch", field_name: "telefon", found_value: "90000000" }] },
      });
      assertEq(mismatch.body.written_count, 0, "3a: mismatch -> written_count 0");
      assertEq(mismatch.body.rejected, [{ provider_id: "prov-mismatch", field_name: "telefon", reason: "mismatch_with_queued_candidate" }], "3b: rejected reason mismatch_with_queued_candidate");
      const afterMismatchProviders = dumpProviders();
      assertEq(afterMismatchProviders, beforeMismatchProviders, "3c: no write happened on mismatch");

      // ── 4. owner_locked (manual + claim) ────────────────────────────────
      const manualRowBefore = expDb.prepare(`SELECT epost FROM experience_providers WHERE id = 'prov-manual'`).get() as any;
      const manualApprove = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { apply: true, approvals: [{ provider_id: "prov-manual", field_name: "epost", found_value: "ny@manual.no" }] },
      });
      assertEq(manualApprove.body.rejected, [{ provider_id: "prov-manual", field_name: "epost", reason: "owner_locked" }], "4a: manual content_source -> owner_locked");
      const manualRowAfter = expDb.prepare(`SELECT epost FROM experience_providers WHERE id = 'prov-manual'`).get() as any;
      assertEq(manualRowAfter.epost, manualRowBefore.epost, "4b: manual row's epost unchanged");

      const claimRowBefore = expDb.prepare(`SELECT mobil FROM experience_providers WHERE id = 'prov-claim'`).get() as any;
      const claimApprove = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { apply: true, approvals: [{ provider_id: "prov-claim", field_name: "mobil", found_value: "99887799" }] },
      });
      assertEq(claimApprove.body.rejected, [{ provider_id: "prov-claim", field_name: "mobil", reason: "owner_locked" }], "4c: claim content_source -> owner_locked (mobil not owner-lock-eligible)");
      const claimRowAfter = expDb.prepare(`SELECT mobil FROM experience_providers WHERE id = 'prov-claim'`).get() as any;
      assertEq(claimRowAfter.mobil, claimRowBefore.mobil, "4d: claim row's mobil unchanged");

      // ── 5. stale_current_value ───────────────────────────────────────────
      const staleApprove = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { apply: true, approvals: [{ provider_id: "prov-stale", field_name: "epost", found_value: "ny@stale.no" }] },
      });
      assertEq(staleApprove.body.rejected, [{ provider_id: "prov-stale", field_name: "epost", reason: "stale_current_value" }], "5a: stale current_value -> stale_current_value, no write");
      const staleRow = expDb.prepare(`SELECT epost FROM experience_providers WHERE id = 'prov-stale'`).get() as any;
      assertEq(staleRow.epost, "mellomliggende@stale.no", "5b: prov-stale's epost is still the intervening value, not the approved one");

      // ── 6. re-approve an already-cleared pair -> not_in_review_queue ─────
      const firstClear = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { apply: true, approvals: [{ provider_id: "prov-cleared", field_name: "telefon", found_value: "90000006" }] },
      });
      assertEq(firstClear.body.written_count, 1, "6a: first approval of prov-cleared writes successfully");
      const secondClear = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { apply: true, approvals: [{ provider_id: "prov-cleared", field_name: "telefon", found_value: "90000006" }] },
      });
      assertEq(secondClear.body.rejected, [{ provider_id: "prov-cleared", field_name: "telefon", reason: "not_in_review_queue" }], "6b: second approval of the same pair -> not_in_review_queue");
      assertEq(secondClear.body.written_count, 0, "6c: second approval writes nothing");

      // ── 7. direct call with a presence-only field -> invalid_field ───────
      const invalidFieldResult = experienceStore.applyGardssalgFieldConcordanceApproval(
        "prov-match",
        "adresse",
        null,
        "Fjellveien 1",
      );
      assertEq(invalidFieldResult, { provider_id: "prov-match", field_name: "adresse", written: false, reason: "invalid_field" }, "7a: invalid_field rejected before any DB call");

      // ── 8. two queued fields — clearing one leaves the other intact ─────
      const twoFieldsApprove = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { apply: true, approvals: [{ provider_id: "prov-two-fields", field_name: "epost", found_value: "ny@tofelt.no" }] },
      });
      assertEq(twoFieldsApprove.body.written_count, 1, "8a: epost approval for prov-two-fields written");
      const remainingQueueRows = expDb
        .prepare(`SELECT field_name FROM gardssalg_field_concordance_review_queue WHERE provider_id = 'prov-two-fields' ORDER BY field_name`)
        .all() as any[];
      assertEq(remainingQueueRows, [{ field_name: "telefon" }], "8b: telefon queue row for prov-two-fields still present after epost was cleared");
      const twoFieldsProviderRow = expDb.prepare(`SELECT epost, telefon FROM experience_providers WHERE id = 'prov-two-fields'`).get() as any;
      assertEq(twoFieldsProviderRow.epost, "ny@tofelt.no", "8c: epost was written");
      assertEq(twoFieldsProviderRow.telefon, "90000010", "8d: telefon untouched (still pending, not approved yet)");

      // ── 9. rollback_vetoed (2026-08-09 gap fix) ─────────────────────────
      const beforeVetoedProviders = dumpProviders();
      const beforeVetoedAudit = dumpAudit();
      const vetoedApprove = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { apply: true, approvals: [{ provider_id: "prov-vetoed", field_name: "epost", found_value: "reappears@vetoed.no" }] },
      });
      assertEq(
        vetoedApprove.body.rejected,
        [{ provider_id: "prov-vetoed", field_name: "epost", reason: "rollback_vetoed" }],
        "9a: a field whose latest audit row is a rollback -> rollback_vetoed, not written",
      );
      assertEq(vetoedApprove.body.written_count, 0, "9b: rollback_vetoed writes nothing");
      const afterVetoedProviders = dumpProviders();
      assertEq(afterVetoedProviders, beforeVetoedProviders, "9c: experience_providers byte-identical, no write happened");
      const afterVetoedAudit = dumpAudit();
      assertEq(afterVetoedAudit.length, beforeVetoedAudit.length, "9d: no new gardssalg_content_audit row inserted");
      const vetoedQueueAfter = expDb
        .prepare(`SELECT * FROM gardssalg_field_concordance_review_queue WHERE provider_id = 'prov-vetoed'`)
        .all() as any[];
      assertEq(vetoedQueueAfter.length, 1, "9e: queue row NOT cleared (rejection, not an approval)");

      // Direct call (bypassing the route) confirms the same guard fires
      // independent of the route layer, and that it fires BEFORE
      // stale_current_value would (the queued current_value of null still
      // matches the post-rollback stored value, so a stale_current_value
      // result here would indicate the new guard is missing/misordered).
      const directVetoed = experienceStore.applyGardssalgFieldConcordanceApproval(
        "prov-vetoed",
        "epost",
        null,
        "reappears@vetoed.no",
      );
      assertEq(
        directVetoed,
        { provider_id: "prov-vetoed", field_name: "epost", written: false, reason: "rollback_vetoed" },
        "9f: direct call also returns rollback_vetoed (not stale_current_value)",
      );
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-field-concordance-review-approve: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-field-concordance-review-approve.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgFieldConcordanceReviewApproveTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
