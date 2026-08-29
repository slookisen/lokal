/**
 * opplevelser-gardssalg-set-address.test.ts — tests for the missing "apply a
 * caller-supplied, corrected street ADDRESS" write path (dev-request
 * 2026-08-29-gardssalg-set-address), the third sibling of gardssalg-set-
 * content-field / gardssalg-set-producer-type:
 *
 *   - applyGardssalgSetAddress() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-set-address (src/routes/opplevelser.ts)
 *
 * The gap this closes: the only other writer of `adresse`,
 * applyGardssalgProviderAddress (Brreg address-enrichment), is FILL-ONLY —
 * it refuses to touch a row whose adresse is already non-blank — so a wrong
 * street address (stale Brreg registration, typo, producer's own
 * correction) had no write path.
 *
 * Harness copied from opplevelser-gardssalg-set-content-field.test.ts
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and adapted for this endpoint's
 * { provider_id, value, source } body shape (content-field's shape, not
 * producer-type's { producer_type, reason, source_url } shape — this
 * endpoint mirrors content-field's contract, per its own spec).
 *
 * Covers:
 *   (a) missing/wrong X-Admin-Key -> 403
 *   (b) happy path: blank adresse -> 200, column written, exactly ONE audit
 *       row (old_value null), field_provenance.adresse.source_url set
 *   (c) OVERWRITE of an already-filled adresse -> 200 with the old value on
 *       the audit row (the entire point of this slice — the fill-only
 *       enrichment writer refuses exactly this)
 *   (d) unknown provider_id -> 404 provider_not_found
 *   (e) missing provider_id -> 400 provider_id_required
 *   (f) missing value -> 400 value_required; missing source -> 400
 *       source_required; whitespace-only value -> 400 value_required
 *   (g) defective value rejected -> 400 defective_value + defect_type, with
 *       the column UNCHANGED and NO audit row (too_short, placeholder)
 *   (h) owner lock: content_source='manual' -> 409; content_source='claim'
 *       (with OR without a field_provenance.owner_locks.adresse stamp) ->
 *       409 either way — `adresse` is not one of the five claim-portal-
 *       editable fields, so isGardssalgFieldOwnerLocked's fallback locks it
 *       unconditionally for any claim-sourced row, same as org_nr/epost/
 *       telefon/postnummer/poststed; content_source=null -> 200 (not locked)
 *   (i) value: null clears the address -> 200, old_value/new_value correct,
 *       column cleared, correctly-shaped audit row (field_name='adresse',
 *       new_value=null)
 *   (j) rollback round-trip: planGardssalgContentRollback proposes restoring
 *       (c)'s old value with zero rollback-side changes needed (`adresse`
 *       already in GARDSSALG_ROLLBACKABLE_FIELDS), and a second round-trip
 *       proves the null-clear from (i) is itself restorable
 *   (k) poststed/kommune/fylke/postnummer/lat/lon are NEVER touched by this
 *       endpoint — only `adresse` and field_provenance change
 *   (l) direct service-function coverage (mirrors route-level assertions)
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
    const url = opts.url || "/admin/gardssalg-set-address";
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

const GOOD_ADDRESS = "Gårdsveien 14";
const GOOD_ADDRESS_2 = "Bygdevegen 27B";

export function runOpplevelserGardssalgSetAddressTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-set-address-test-key";
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

      // ── Fixtures ─────────────────────────────────────────────────────────
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, content_source, adresse, postnummer, poststed,
            kommune, fylke, lat, lon, field_provenance, hjemmeside,
            producer_type, enrichment_state, verification_status, source, confidence,
            catalog_hidden, created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @adresse, @postnummer, @poststed,
            @kommune, @fylke, @lat, @lon, @field_provenance, @hjemmeside,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium',
            @catalog_hidden, @created_at)`,
      );
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          org_nr: null, content_source: null, adresse: null, postnummer: null, poststed: null,
          kommune: null, fylke: null, lat: null, lon: null, field_provenance: null, hjemmeside: null,
          catalog_hidden: null, created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, adresse, postnummer, poststed, kommune, fylke, lat, lon, content_source, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      const auth = { "x-admin-key": testKey };

      // ── (a) auth ─────────────────────────────────────────────────────────
      const unauth = await callRoute(opplevelserRouter, { body: {} });
      assertEq(unauth.status, 403, "a1: unauthenticated request -> 403");
      const wrongKey = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": "not-the-key" },
        body: { provider_id: "x", value: GOOD_ADDRESS, source: "s" },
      });
      assertEq(wrongKey.status, 403, "a2: wrong X-Admin-Key -> 403");

      // ── (b) happy path: blank adresse ────────────────────────────────────
      mkProvider({ id: "sad-happy", navn: "Happy Address Gard" });
      const happyRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sad-happy",
          value: GOOD_ADDRESS,
          source: "produsentsvar 2026-08-29: korrekt gateadresse oppgitt",
        },
      });
      assertEq(happyRes.status, 200, "b1: happy path returns 200");
      assertEq(happyRes.body, {
        success: true,
        provider_id: "sad-happy",
        field: "adresse",
        old_value: null,
        new_value: GOOD_ADDRESS,
      }, "b2: response shape matches spec exactly");
      const happyRow = getProviderRow("sad-happy");
      assertEq(happyRow.adresse, GOOD_ADDRESS, "b3: DB column adresse actually written");
      const happyProv = JSON.parse(happyRow.field_provenance || "{}");
      assertEq(
        happyProv.adresse?.source_url,
        "produsentsvar 2026-08-29: korrekt gateadresse oppgitt",
        "b4: field_provenance.adresse.source_url is the request's source verbatim",
      );
      assertTrue(!!happyProv.adresse?.fetched_at, "b5: field_provenance.adresse has a fresh fetched_at");
      const happyAudit = getAuditRows("sad-happy");
      assertEq(happyAudit.length, 1, "b6: exactly ONE audit row inserted");
      assertEq(happyAudit[0].field_name, "adresse", "b7: audit field_name is adresse");
      assertEq(happyAudit[0].old_value, null, "b8: audit old_value is the true pre-write null");
      assertEq(happyAudit[0].new_value, GOOD_ADDRESS, "b9: audit new_value is the written value");
      assertEq(happyAudit[0].changed_by, "admin", "b10: audit changed_by is 'admin'");
      assertEq(happyAudit[0].batch_id, null, "b11: audit batch_id is NULL (single-row admin write)");

      // ── (c) OVERWRITE an already-filled value — the point of the slice ────
      mkProvider({
        id: "sad-overwrite",
        navn: "Overwrite Address Gard",
        adresse: GOOD_ADDRESS,
        created_at: "2026-01-02 00:00:00",
      });
      const overwriteRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sad-overwrite",
          value: GOOD_ADDRESS_2,
          source: "produsentsvar 2026-08-29: forrige adresse var feil (gammel Brreg-adresse)",
        },
      });
      assertEq(overwriteRes.status, 200, "c1: overwrite of an ALREADY-FILLED adresse -> 200 (fill-only enrichment writer refuses exactly this)");
      assertEq(overwriteRes.body.old_value, GOOD_ADDRESS, "c2: old_value is the prior stored address");
      assertEq(overwriteRes.body.new_value, GOOD_ADDRESS_2, "c3: new_value is the corrected address");
      assertEq(getProviderRow("sad-overwrite").adresse, GOOD_ADDRESS_2, "c4: DB column overwritten");
      const overwriteAudit = getAuditRows("sad-overwrite");
      assertEq(overwriteAudit.length, 1, "c5: exactly one audit row for the overwrite");
      assertEq(overwriteAudit[0].old_value, GOOD_ADDRESS, "c6: audit row carries the OLD value (rollback depends on this)");
      assertEq(overwriteAudit[0].new_value, GOOD_ADDRESS_2, "c7: audit row carries the new value");

      // ── (d) unknown provider -> 404 ──────────────────────────────────────
      const notFoundRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "does-not-exist", value: GOOD_ADDRESS, source: "s" },
      });
      assertEq(notFoundRes.status, 404, "d1: unknown provider_id -> 404");
      assertEq(notFoundRes.body.error, "provider_not_found", "d2: error code is provider_not_found");

      // ── (e) missing provider_id -> 400 ───────────────────────────────────
      const missingProviderIdRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { value: GOOD_ADDRESS, source: "s" },
      });
      assertEq(missingProviderIdRes.status, 400, "e1: missing provider_id -> 400");
      assertEq(missingProviderIdRes.body.error, "provider_id_required", "e2: error code is provider_id_required");

      // ── (f) value/source required ────────────────────────────────────────
      const missingValueRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-happy", source: "s" },
      });
      assertEq(missingValueRes.status, 400, "f1: missing value -> 400");
      assertEq(missingValueRes.body.error, "value_required", "f2: error code is value_required");
      const blankValueRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-happy", value: "   ", source: "s" },
      });
      assertEq(blankValueRes.status, 400, "f3: whitespace-only value -> 400 value_required (trim-then-check)");
      assertEq(blankValueRes.body.error, "value_required", "f4: error code is value_required for blank value");
      const missingSourceRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-happy", value: GOOD_ADDRESS_2 },
      });
      assertEq(missingSourceRes.status, 400, "f5: missing source -> 400");
      assertEq(missingSourceRes.body.error, "source_required", "f6: error code is source_required");
      const nonStringValueRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-happy", value: 12345, source: "s" },
      });
      assertEq(nonStringValueRes.status, 400, "f7: non-string, non-null value -> 400 value_required");
      assertEq(nonStringValueRes.body.error, "value_required", "f8: error code is value_required for a non-string value");

      // ── (g) defective values rejected FAIL-CLOSED ────────────────────────
      mkProvider({
        id: "sad-tooshort",
        navn: "Too Short Address Gard",
        adresse: GOOD_ADDRESS,
        created_at: "2026-01-03 00:00:00",
      });
      const tooShortRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-tooshort", value: "Ab", source: "s" },
      });
      assertEq(tooShortRes.status, 400, "g1: under the 4-char address floor -> 400");
      assertEq(tooShortRes.body.error, "defective_value", "g2: error code is defective_value");
      assertEq(tooShortRes.body.defect_type, "too_short", "g3: defect_type is too_short");
      assertEq(getProviderRow("sad-tooshort").adresse, GOOD_ADDRESS, "g4: column UNCHANGED on a rejected write");
      assertEq(getAuditRows("sad-tooshort").length, 0, "g5: NO audit row on a rejected write");

      mkProvider({
        id: "sad-placeholder",
        navn: "Placeholder Address Gard",
        adresse: GOOD_ADDRESS,
        created_at: "2026-01-04 00:00:00",
      });
      const placeholderRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-placeholder", value: "Adresse kommer snart", source: "s" },
      });
      assertEq(placeholderRes.status, 400, "g6: placeholder text -> 400");
      assertEq(placeholderRes.body.defect_type, "placeholder", "g7: defect_type is placeholder");
      assertEq(getProviderRow("sad-placeholder").adresse, GOOD_ADDRESS, "g8: column UNCHANGED (placeholder)");
      assertEq(getAuditRows("sad-placeholder").length, 0, "g9: NO audit row (placeholder)");

      // ── (h) owner lock ────────────────────────────────────────────────────
      mkProvider({
        id: "sad-manual",
        navn: "Manual Address Gard",
        content_source: "manual",
        adresse: GOOD_ADDRESS,
        created_at: "2026-01-05 00:00:00",
      });
      const manualRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-manual", value: GOOD_ADDRESS_2, source: "s" },
      });
      assertEq(manualRes.status, 409, "h1: content_source='manual' -> 409");
      assertEq(manualRes.body.error, "owner_locked", "h2: error code is owner_locked");
      assertEq(getProviderRow("sad-manual").adresse, GOOD_ADDRESS, "h3: manual row UNCHANGED");
      assertEq(getAuditRows("sad-manual").length, 0, "h4: NO audit row on an owner-locked refusal");

      // `adresse` is NOT claim-portal-editable, so a claim-sourced row is
      // locked unconditionally — WITH an owner_locks.adresse stamp present...
      mkProvider({
        id: "sad-claim-with-stamp",
        navn: "Claim With Stamp Gard",
        content_source: "claim",
        adresse: GOOD_ADDRESS,
        field_provenance: JSON.stringify({ owner_locks: { adresse: { locked_at: "2026-08-01T00:00:00Z" } } }),
        created_at: "2026-01-06 00:00:00",
      });
      const claimWithStampRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-claim-with-stamp", value: GOOD_ADDRESS_2, source: "s" },
      });
      assertEq(claimWithStampRes.status, 409, "h5: content_source='claim' WITH an owner_locks.adresse stamp -> 409");
      assertEq(claimWithStampRes.body.error, "owner_locked", "h6: error code is owner_locked");

      // ...and WITHOUT one, since the claim portal never exposes adresse for
      // editing in the first place (unlike about_text/visit_text/opening_
      // hours_text/products/hjemmeside, which are per-field via owner_locks).
      mkProvider({
        id: "sad-claim-no-stamp",
        navn: "Claim No Stamp Gard",
        content_source: "claim",
        adresse: GOOD_ADDRESS,
        field_provenance: JSON.stringify({ owner_locks: { visit_text: { locked_at: "2026-08-01T00:00:00Z" } } }),
        created_at: "2026-01-07 00:00:00",
      });
      const claimNoStampRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-claim-no-stamp", value: GOOD_ADDRESS_2, source: "s" },
      });
      assertEq(claimNoStampRes.status, 409, "h7: content_source='claim' WITHOUT an owner_locks.adresse stamp is STILL 409 — adresse is always-locked for claim rows, not per-field");
      assertEq(claimNoStampRes.body.error, "owner_locked", "h8: error code is owner_locked");
      assertEq(getProviderRow("sad-claim-no-stamp").adresse, GOOD_ADDRESS, "h9: claim row (no stamp) still UNCHANGED");

      // A row with no claim/manual stamp at all is NOT locked.
      mkProvider({
        id: "sad-unlocked",
        navn: "Unlocked Address Gard",
        content_source: null,
        adresse: GOOD_ADDRESS,
        created_at: "2026-01-08 00:00:00",
      });
      const unlockedRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-unlocked", value: GOOD_ADDRESS_2, source: "s" },
      });
      assertEq(unlockedRes.status, 200, "h10: content_source=null -> not locked -> 200");
      assertEq(getProviderRow("sad-unlocked").adresse, GOOD_ADDRESS_2, "h11: unlocked row written");

      // ── (i) value: null clears the address ───────────────────────────────
      mkProvider({
        id: "sad-clear",
        navn: "Clear Address Gard",
        adresse: GOOD_ADDRESS,
        created_at: "2026-01-09 00:00:00",
      });
      const clearRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-clear", value: null, source: "adresse var uverifiserbar, nullstilt" },
      });
      assertEq(clearRes.status, 200, "i1: value: null returns 200");
      assertEq(clearRes.body.old_value, GOOD_ADDRESS, "i2: old_value is the prior address");
      assertEq(clearRes.body.new_value, null, "i3: new_value is null");
      assertEq(getProviderRow("sad-clear").adresse, null, "i4: DB column cleared");
      const clearAudit = getAuditRows("sad-clear");
      assertEq(clearAudit.length, 1, "i5: exactly one audit row for the clear");
      assertEq(clearAudit[0].field_name, "adresse", "i6: audit field_name is adresse");
      assertEq(clearAudit[0].old_value, GOOD_ADDRESS, "i7: audit old_value is the pre-clear address");
      assertEq(clearAudit[0].new_value, null, "i8: audit new_value is null");

      // ── (j) rollback round-trip ───────────────────────────────────────────
      const rollbackPlan = store.planGardssalgContentRollback({
        provider_id: "sad-overwrite",
        field_name: "adresse",
      });
      assertEq(rollbackPlan.restorable.length, 1, "j1: rollback planner finds exactly one restorable field");
      assertEq(rollbackPlan.restorable[0]?.field_name, "adresse", "j2: restorable field is adresse");
      assertEq(rollbackPlan.restorable[0]?.current_value, GOOD_ADDRESS_2, "j3: planner sees the new value as current");
      assertEq(rollbackPlan.restorable[0]?.restore_to, GOOD_ADDRESS, "j4: planner proposes restoring the OLD value — zero rollback-side changes needed, adresse was already in GARDSSALG_ROLLBACKABLE_FIELDS");
      assertEq(rollbackPlan.skipped.length, 0, "j5: nothing skipped");
      const applied = store.applyGardssalgContentRollback(rollbackPlan.restorable);
      assertEq(applied.length, 1, "j6: rollback applies exactly one restore");
      assertEq(getProviderRow("sad-overwrite").adresse, GOOD_ADDRESS, "j7: DB column restored to the pre-overwrite address");

      // The null-clear from (i) is itself restorable.
      const clearRollbackPlan = store.planGardssalgContentRollback({
        provider_id: "sad-clear",
        field_name: "adresse",
      });
      assertEq(clearRollbackPlan.restorable.length, 1, "j8: the null-clear is itself restorable");
      assertEq(clearRollbackPlan.restorable[0]?.restore_to, GOOD_ADDRESS, "j9: planner proposes restoring the pre-clear address");

      // ── (k) locality/region/geo columns are NEVER touched ────────────────
      mkProvider({
        id: "sad-scope",
        navn: "Scope Gard",
        adresse: null,
        postnummer: "1430",
        poststed: "ÅS",
        kommune: "Ås",
        fylke: "Akershus",
        lat: 59.66,
        lon: 10.78,
        created_at: "2026-01-10 00:00:00",
      });
      const scopeRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sad-scope", value: GOOD_ADDRESS, source: "s" },
      });
      assertEq(scopeRes.status, 200, "k1: scope happy path returns 200");
      const scopeRow = getProviderRow("sad-scope");
      assertEq(scopeRow.adresse, GOOD_ADDRESS, "k2: adresse written");
      assertEq(scopeRow.postnummer, "1430", "k3: postnummer UNCHANGED");
      assertEq(scopeRow.poststed, "ÅS", "k4: poststed UNCHANGED");
      assertEq(scopeRow.kommune, "Ås", "k5: kommune UNCHANGED");
      assertEq(scopeRow.fylke, "Akershus", "k6: fylke UNCHANGED");
      assertEq(scopeRow.lat, 59.66, "k7: lat UNCHANGED");
      assertEq(scopeRow.lon, 10.78, "k8: lon UNCHANGED");

      // ── (l) direct service-function coverage ─────────────────────────────
      mkProvider({
        id: "sad-service-direct",
        navn: "Service Direct Gard",
        adresse: "Gammel Veien 1",
        created_at: "2026-01-11 00:00:00",
      });
      const directResult = store.applyGardssalgSetAddress(
        "sad-service-direct",
        "Ny Vei 2",
        "manuell verifisering",
      );
      assertTrue(directResult.ok === true, "l1: direct service call succeeds on a clean adresse");
      if (directResult.ok) {
        assertEq(directResult.old_value, "Gammel Veien 1", "l2: direct call returns the correct old_value");
        assertEq(directResult.new_value, "Ny Vei 2", "l3: direct call returns the correct new_value");
      }
      const directReject = store.applyGardssalgSetAddress(
        "sad-service-direct", "Xy", "manuell verifisering"
      );
      assertTrue(directReject.ok === false, "l4: direct service call blocked on a defective (too-short) value");
      if (!directReject.ok) {
        assertEq(directReject.reason, "defective_value", "l5: direct rejection reports defective_value");
        assertEq(
          directReject.reason === "defective_value" ? directReject.defect_type : null,
          "too_short",
          "l6: direct rejection carries defect_type",
        );
      }
      const directNotFound = store.applyGardssalgSetAddress(
        "no-such-provider", GOOD_ADDRESS, "s"
      );
      assertTrue(!directNotFound.ok && directNotFound.reason === "provider_not_found", "l7: direct call reports provider_not_found");
      // Blank value passed DIRECTLY to the service -> value_required, column
      // UNCHANGED, no audit row — same defense-in-depth as the content-field
      // sibling: the classifier reports blank as NOT defective on purpose, so
      // without this guard a "   " value would blank a good column.
      const directBlank = store.applyGardssalgSetAddress(
        "sad-service-direct", "   ", "manuell verifisering"
      );
      assertTrue(!directBlank.ok, "l8: whitespace-only value rejected by the SERVICE, not just the route");
      assertEq(
        directBlank.ok ? null : directBlank.reason,
        "value_required",
        "l9: direct blank rejection reports reason value_required",
      );
      assertEq(getProviderRow("sad-service-direct").adresse, "Ny Vei 2", "l10: column UNCHANGED — a good value was NOT blanked");
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-set-address.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgSetAddressTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
