/**
 * opplevelser-gardssalg-set-products.test.ts — tests for the missing
 * `products` write path (dev-request 2026-08-29-gardssalg-products-write-
 * and-field-lock, Part A):
 *
 *   - applyGardssalgSetProducts() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-set-products (src/routes/opplevelser.ts)
 *
 * The gap this closes: gardssalg-set-content-field's own doc comment
 * explicitly rejects `field: "products"` with 400 invalid_field ("no defect
 * vocabulary exists for it"). Live case: Anikonic Cider's public "Produkter"
 * list read "Frukt, Urter" (raw ingredients bought in, not grown) with no
 * admin lever to correct it.
 *
 * Harness copied from opplevelser-gardssalg-set-address.test.ts
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()), adapted for this endpoint's
 * { provider_id, value: string[], source } body shape — `value` is a JSON
 * ARRAY (the same shape the `products` column itself is stored in, and the
 * same shape the owner-claim write path already accepts for it), not a
 * delimited string.
 *
 * Covers:
 *   (a) missing/wrong X-Admin-Key -> 403
 *   (b) happy path: blank products -> 200, column written as a JSON array,
 *       exactly ONE audit row (old_value null), field_provenance.products
 *       set, items trimmed
 *   (c) OVERWRITE of an already-filled products value -> 200, old_value on
 *       the response/audit row is the prior JSON string
 *   (d) unknown provider_id -> 404 provider_not_found
 *   (e) missing provider_id -> 400 provider_id_required
 *   (f) missing/non-array/empty-array value -> 400 value_required; missing
 *       source -> 400 source_required
 *   (g) per-item defects rejected FAIL-CLOSED, each with column UNCHANGED
 *       and NO audit row: a blank item (blank_item), a non-string item
 *       (invalid_item_type), an over-length item (item_too_long), too many
 *       items (too_many_items)
 *   (h) owner lock: content_source='manual' -> 409; content_source='claim'
 *       WITH an owner_locks.products stamp -> 409; content_source='claim'
 *       WITHOUT one -> 200 (products IS claim-portal-editable, unlike
 *       adresse); content_source=null -> 200 (not locked)
 *   (i) the NEW cross-cutting case this dev-request exists for: an
 *       ADMIN-set lock (content_source=null/enrichment-derived +
 *       field_provenance.owner_locks.products with locked_by:"admin") is
 *       honored too -> 409, proving isGardssalgFieldOwnerLocked's broadened
 *       gate actually protects a non-claim row
 *   (j) rollback round-trip: planGardssalgContentRollback proposes restoring
 *       (c)'s old JSON value — `products` already in
 *       GARDSSALG_ROLLBACKABLE_FIELDS, zero rollback-side changes needed
 *   (k) direct service-function coverage (mirrors route-level assertions)
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
    const url = opts.url || "/admin/gardssalg-set-products";
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

export function runOpplevelserGardssalgSetProductsTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-set-products-test-key";
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
           (id, navn, vertical, org_nr, content_source, products, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence,
            catalog_hidden, created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @products, @field_provenance,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium',
            @catalog_hidden, @created_at)`,
      );
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          org_nr: null, content_source: null, products: null, field_provenance: null,
          catalog_hidden: null, created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, products, content_source, field_provenance FROM experience_providers WHERE id = ?`
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
        body: { provider_id: "x", value: ["Eplesider"], source: "s" },
      });
      assertEq(wrongKey.status, 403, "a2: wrong X-Admin-Key -> 403");

      // ── (b) happy path: blank products, items trimmed ───────────────────
      mkProvider({ id: "sp-happy", navn: "Happy Products Gard" });
      const happyRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sp-happy",
          value: ["  Fruktvin  ", "Isvin"],
          source: "produsentsvar 2026-08-29: faktiske produkter oppgitt",
        },
      });
      assertEq(happyRes.status, 200, "b1: happy path returns 200");
      assertEq(happyRes.body, {
        success: true,
        provider_id: "sp-happy",
        field: "products",
        old_value: null,
        new_value: JSON.stringify(["Fruktvin", "Isvin"]),
      }, "b2: response shape matches spec exactly, items trimmed");
      const happyRow = getProviderRow("sp-happy");
      assertEq(happyRow.products, JSON.stringify(["Fruktvin", "Isvin"]), "b3: DB column products actually written as JSON array");
      const happyProv = JSON.parse(happyRow.field_provenance || "{}");
      assertEq(
        happyProv.products?.source_url,
        "produsentsvar 2026-08-29: faktiske produkter oppgitt",
        "b4: field_provenance.products.source_url is the request's source verbatim",
      );
      assertTrue(!!happyProv.products?.fetched_at, "b5: field_provenance.products has a fresh fetched_at");
      const happyAudit = getAuditRows("sp-happy");
      assertEq(happyAudit.length, 1, "b6: exactly ONE audit row inserted");
      assertEq(happyAudit[0].field_name, "products", "b7: audit field_name is products");
      assertEq(happyAudit[0].old_value, null, "b8: audit old_value is the true pre-write null");
      assertEq(happyAudit[0].new_value, JSON.stringify(["Fruktvin", "Isvin"]), "b9: audit new_value is the written JSON");
      assertEq(happyAudit[0].changed_by, "admin", "b10: audit changed_by is 'admin'");
      assertEq(happyAudit[0].batch_id, null, "b11: audit batch_id is NULL (single-row admin write)");

      // ── (c) OVERWRITE an already-filled value ────────────────────────────
      mkProvider({
        id: "sp-overwrite",
        navn: "Overwrite Products Gard",
        products: JSON.stringify(["Frukt", "Urter"]),
        created_at: "2026-01-02 00:00:00",
      });
      const overwriteRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sp-overwrite",
          value: ["Fruktvin", "Isvin"],
          source: "produsentsvar 2026-08-29: forrige liste viste raavarer, ikke produkter",
        },
      });
      assertEq(overwriteRes.status, 200, "c1: overwrite of an ALREADY-FILLED products value -> 200");
      assertEq(overwriteRes.body.old_value, JSON.stringify(["Frukt", "Urter"]), "c2: old_value is the prior stored JSON");
      assertEq(overwriteRes.body.new_value, JSON.stringify(["Fruktvin", "Isvin"]), "c3: new_value is the corrected JSON");
      assertEq(getProviderRow("sp-overwrite").products, JSON.stringify(["Fruktvin", "Isvin"]), "c4: DB column overwritten");
      const overwriteAudit = getAuditRows("sp-overwrite");
      assertEq(overwriteAudit.length, 1, "c5: exactly one audit row for the overwrite");
      assertEq(overwriteAudit[0].old_value, JSON.stringify(["Frukt", "Urter"]), "c6: audit row carries the OLD value (rollback depends on this)");

      // ── (d) unknown provider -> 404 ──────────────────────────────────────
      const notFoundRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "does-not-exist", value: ["Sider"], source: "s" },
      });
      assertEq(notFoundRes.status, 404, "d1: unknown provider_id -> 404");
      assertEq(notFoundRes.body.error, "provider_not_found", "d2: error code is provider_not_found");

      // ── (e) missing provider_id -> 400 ───────────────────────────────────
      const missingProviderIdRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { value: ["Sider"], source: "s" },
      });
      assertEq(missingProviderIdRes.status, 400, "e1: missing provider_id -> 400");
      assertEq(missingProviderIdRes.body.error, "provider_id_required", "e2: error code is provider_id_required");

      // ── (f) value/source shape checks ────────────────────────────────────
      const missingValueRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-happy", source: "s" },
      });
      assertEq(missingValueRes.status, 400, "f1: missing value -> 400");
      assertEq(missingValueRes.body.error, "value_required", "f2: error code is value_required");
      const emptyArrayRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-happy", value: [], source: "s" },
      });
      assertEq(emptyArrayRes.status, 400, "f3: empty array -> 400 value_required");
      assertEq(emptyArrayRes.body.error, "value_required", "f4: error code is value_required for empty array");
      const nonArrayRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-happy", value: "Fruktvin, Isvin", source: "s" },
      });
      assertEq(nonArrayRes.status, 400, "f5: a delimited STRING (not an array) -> 400 value_required — this endpoint only accepts an array");
      assertEq(nonArrayRes.body.error, "value_required", "f6: error code is value_required for a non-array value");
      const missingSourceRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-happy", value: ["Sider"] },
      });
      assertEq(missingSourceRes.status, 400, "f7: missing source -> 400");
      assertEq(missingSourceRes.body.error, "source_required", "f8: error code is source_required");

      // ── (g) per-item defects rejected FAIL-CLOSED ────────────────────────
      mkProvider({
        id: "sp-blank-item",
        navn: "Blank Item Gard",
        products: JSON.stringify(["Original"]),
        created_at: "2026-01-03 00:00:00",
      });
      const blankItemRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-blank-item", value: ["Sider", "   "], source: "s" },
      });
      assertEq(blankItemRes.status, 400, "g1: a blank (whitespace-only) item -> 400");
      assertEq(blankItemRes.body.error, "defective_value", "g2: error code is defective_value");
      assertEq(blankItemRes.body.defect_type, "blank_item", "g3: defect_type is blank_item");
      assertEq(getProviderRow("sp-blank-item").products, JSON.stringify(["Original"]), "g4: column UNCHANGED on a rejected write");
      assertEq(getAuditRows("sp-blank-item").length, 0, "g5: NO audit row on a rejected write");

      mkProvider({
        id: "sp-wrong-type",
        navn: "Wrong Type Gard",
        products: JSON.stringify(["Original"]),
        created_at: "2026-01-04 00:00:00",
      });
      const wrongTypeRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-wrong-type", value: ["Sider", 12345], source: "s" },
      });
      assertEq(wrongTypeRes.status, 400, "g6: a non-string item -> 400");
      assertEq(wrongTypeRes.body.defect_type, "invalid_item_type", "g7: defect_type is invalid_item_type");
      assertEq(getProviderRow("sp-wrong-type").products, JSON.stringify(["Original"]), "g8: column UNCHANGED (wrong type)");
      assertEq(getAuditRows("sp-wrong-type").length, 0, "g9: NO audit row (wrong type)");

      mkProvider({
        id: "sp-too-long",
        navn: "Too Long Item Gard",
        products: JSON.stringify(["Original"]),
        created_at: "2026-01-05 00:00:00",
      });
      const tooLongRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-too-long", value: ["Sider", "x".repeat(201)], source: "s" },
      });
      assertEq(tooLongRes.status, 400, "g10: an over-length item (>200 chars) -> 400");
      assertEq(tooLongRes.body.defect_type, "item_too_long", "g11: defect_type is item_too_long");
      assertEq(getProviderRow("sp-too-long").products, JSON.stringify(["Original"]), "g12: column UNCHANGED (too long)");

      mkProvider({
        id: "sp-too-many",
        navn: "Too Many Items Gard",
        products: JSON.stringify(["Original"]),
        created_at: "2026-01-06 00:00:00",
      });
      const tooManyRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-too-many", value: Array.from({ length: 51 }, (_, i) => `Produkt ${i}`), source: "s" },
      });
      assertEq(tooManyRes.status, 400, "g13: 51 items (over the 50-item ceiling) -> 400");
      assertEq(tooManyRes.body.defect_type, "too_many_items", "g14: defect_type is too_many_items");
      assertEq(getProviderRow("sp-too-many").products, JSON.stringify(["Original"]), "g15: column UNCHANGED (too many items)");
      assertEq(getAuditRows("sp-too-many").length, 0, "g16: NO audit row (too many items)");

      // Exactly 50 items is still accepted (boundary check).
      mkProvider({
        id: "sp-exactly-max",
        navn: "Exactly Max Items Gard",
        created_at: "2026-01-07 00:00:00",
      });
      const exactlyMaxRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-exactly-max", value: Array.from({ length: 50 }, (_, i) => `Produkt ${i}`), source: "s" },
      });
      assertEq(exactlyMaxRes.status, 200, "g17: exactly 50 items -> 200 (boundary is inclusive)");

      // ── (h) owner lock ────────────────────────────────────────────────────
      mkProvider({
        id: "sp-manual",
        navn: "Manual Products Gard",
        content_source: "manual",
        products: JSON.stringify(["Original"]),
        created_at: "2026-01-08 00:00:00",
      });
      const manualRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-manual", value: ["Sider"], source: "s" },
      });
      assertEq(manualRes.status, 409, "h1: content_source='manual' -> 409");
      assertEq(manualRes.body.error, "owner_locked", "h2: error code is owner_locked");
      assertEq(getProviderRow("sp-manual").products, JSON.stringify(["Original"]), "h3: manual row UNCHANGED");
      assertEq(getAuditRows("sp-manual").length, 0, "h4: NO audit row on an owner-locked refusal");

      // products IS claim-portal-editable -> per-field lookup applies.
      mkProvider({
        id: "sp-claim-with-stamp",
        navn: "Claim With Stamp Gard",
        content_source: "claim",
        products: JSON.stringify(["Original"]),
        field_provenance: JSON.stringify({ owner_locks: { products: { locked_at: "2026-08-01T00:00:00Z" } } }),
        created_at: "2026-01-09 00:00:00",
      });
      const claimWithStampRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-claim-with-stamp", value: ["Sider"], source: "s" },
      });
      assertEq(claimWithStampRes.status, 409, "h5: content_source='claim' WITH an owner_locks.products stamp -> 409");
      assertEq(claimWithStampRes.body.error, "owner_locked", "h6: error code is owner_locked");

      mkProvider({
        id: "sp-claim-no-stamp",
        navn: "Claim No Stamp Gard",
        content_source: "claim",
        products: JSON.stringify(["Original"]),
        field_provenance: JSON.stringify({ owner_locks: { visit_text: { locked_at: "2026-08-01T00:00:00Z" } } }),
        created_at: "2026-01-10 00:00:00",
      });
      const claimNoStampRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-claim-no-stamp", value: ["Sider"], source: "s" },
      });
      assertEq(claimNoStampRes.status, 200, "h7: content_source='claim' WITHOUT an owner_locks.products stamp -> 200 (unlike adresse, products IS per-field)");
      assertEq(getProviderRow("sp-claim-no-stamp").products, JSON.stringify(["Sider"]), "h8: claim row (no products stamp) written");

      mkProvider({
        id: "sp-unlocked",
        navn: "Unlocked Products Gard",
        content_source: null,
        products: JSON.stringify(["Original"]),
        created_at: "2026-01-11 00:00:00",
      });
      const unlockedRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-unlocked", value: ["Sider"], source: "s" },
      });
      assertEq(unlockedRes.status, 200, "h9: content_source=null -> not locked -> 200");

      // ── (i) NEW cross-cutting case: an ADMIN-set lock on a NON-claim row
      // is honored — proves isGardssalgFieldOwnerLocked's broadened layer A
      // actually protects the field, not just a claim row. ──────────────
      mkProvider({
        id: "sp-admin-locked",
        navn: "Admin Locked Gard",
        content_source: null,
        products: JSON.stringify(["Original"]),
        field_provenance: JSON.stringify({
          owner_locks: { products: { locked_at: "2026-08-29T00:00:00Z", locked_by: "admin", source_url: null } },
        }),
        created_at: "2026-01-12 00:00:00",
      });
      const adminLockedRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sp-admin-locked", value: ["Sider"], source: "s" },
      });
      assertEq(adminLockedRes.status, 409, "i1: content_source=null WITH an admin-set owner_locks.products entry -> 409 (the whole point of this dev-request)");
      assertEq(adminLockedRes.body.error, "owner_locked", "i2: error code is owner_locked");
      assertEq(getProviderRow("sp-admin-locked").products, JSON.stringify(["Original"]), "i3: admin-locked row UNCHANGED");

      // ── (j) rollback round-trip ───────────────────────────────────────────
      const rollbackPlan = store.planGardssalgContentRollback({
        provider_id: "sp-overwrite",
        field_name: "products",
      });
      assertEq(rollbackPlan.restorable.length, 1, "j1: rollback planner finds exactly one restorable field");
      assertEq(rollbackPlan.restorable[0]?.field_name, "products", "j2: restorable field is products");
      assertEq(rollbackPlan.restorable[0]?.current_value, JSON.stringify(["Fruktvin", "Isvin"]), "j3: planner sees the new value as current");
      assertEq(rollbackPlan.restorable[0]?.restore_to, JSON.stringify(["Frukt", "Urter"]), "j4: planner proposes restoring the OLD JSON — zero rollback-side changes needed");
      const applied = store.applyGardssalgContentRollback(rollbackPlan.restorable);
      assertEq(applied.length, 1, "j5: rollback applies exactly one restore");
      assertEq(getProviderRow("sp-overwrite").products, JSON.stringify(["Frukt", "Urter"]), "j6: DB column restored to the pre-overwrite JSON");

      // ── (k) direct service-function coverage ─────────────────────────────
      mkProvider({
        id: "sp-service-direct",
        navn: "Service Direct Gard",
        products: JSON.stringify(["Gammelt Produkt"]),
        created_at: "2026-01-13 00:00:00",
      });
      const directResult = store.applyGardssalgSetProducts(
        "sp-service-direct", ["Nytt Produkt"], "manuell verifisering"
      );
      assertTrue(directResult.ok === true, "k1: direct service call succeeds");
      if (directResult.ok) {
        assertEq(directResult.old_value, JSON.stringify(["Gammelt Produkt"]), "k2: direct call returns the correct old_value");
        assertEq(directResult.new_value, JSON.stringify(["Nytt Produkt"]), "k3: direct call returns the correct new_value");
      }
      const directNotFound = store.applyGardssalgSetProducts(
        "no-such-provider", ["Sider"], "s"
      );
      assertTrue(!directNotFound.ok && directNotFound.reason === "provider_not_found", "k4: direct call reports provider_not_found");
      const directEmptyArray = store.applyGardssalgSetProducts(
        "sp-service-direct", [], "s"
      );
      assertTrue(!directEmptyArray.ok, "k5: direct call with an empty array rejected by the SERVICE, not just the route");
      assertEq(
        directEmptyArray.ok ? null : directEmptyArray.reason,
        "value_required",
        "k6: direct empty-array rejection reports reason value_required",
      );
      assertEq(getProviderRow("sp-service-direct").products, JSON.stringify(["Nytt Produkt"]), "k7: column UNCHANGED — a good value was NOT blanked");
      const directNonArray = store.applyGardssalgSetProducts(
        "sp-service-direct", "Sider, Most" as any, "s"
      );
      assertTrue(!directNonArray.ok, "k8: direct call with a non-array value rejected");
      assertEq(
        directNonArray.ok ? null : directNonArray.reason,
        "value_required",
        "k9: direct non-array rejection reports reason value_required",
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-set-products.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgSetProductsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
