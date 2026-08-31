/**
 * opplevelser-gardssalg-set-provider-name.test.ts — tests for the missing
 * "apply a caller-supplied, corrected DISPLAY NAME" write path (dev-request
 * 2026-08-30-gardssalg-set-provider-navn-endepunkt), the fourth sibling of
 * gardssalg-set-content-field / gardssalg-set-producer-type /
 * gardssalg-set-address:
 *
 *   - applyGardssalgSetProviderName() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-set-provider-name (src/routes/opplevelser.ts)
 *
 * The gap this closes: `navn` had NO update path anywhere in the codebase —
 * only ever written once, at row INSERT (seeding). Motivating case:
 * Anikonic corrected they produce fruit wine, not cider, but the producer's
 * DISPLAY NAME itself was "Anikonic Cider".
 *
 * Harness copied from opplevelser-gardssalg-set-address.test.ts
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and adapted for this endpoint's
 * contract, which differs from `-set-address` in two ways this suite
 * specifically covers: no `value: null` clear path, and no objective-defect
 * classifier (any non-blank value is accepted).
 *
 * Covers:
 *   (a) missing/wrong X-Admin-Key -> 403
 *   (b) happy path: overwrite an existing navn -> 200, column written,
 *       exactly ONE audit row (old_value = prior name),
 *       field_provenance.navn.source_url set, `slug` UNTOUCHED
 *   (c) unknown provider_id -> 404 provider_not_found
 *   (d) missing provider_id -> 400 provider_id_required
 *   (e) missing value -> 400 value_required; missing source -> 400
 *       source_required; whitespace-only value -> 400 value_required;
 *       non-string value -> 400 value_required
 *   (f) owner lock: content_source='manual' -> 409; content_source='claim'
 *       (with OR without a field_provenance.owner_locks.navn stamp) -> 409
 *       either way — `navn` is not one of the five claim-portal-editable
 *       fields, same "always locked for claim rows" fallback as `adresse`;
 *       content_source=null -> 200 (not locked)
 *   (g) rollback round-trip: planGardssalgContentRollback proposes restoring
 *       (b)'s old value with zero rollback-side changes needed (`navn` was
 *       added to GARDSSALG_ROLLBACKABLE_FIELDS by this same dev-request)
 *   (h) direct service-function coverage (mirrors route-level assertions),
 *       including the whitespace-only defense-in-depth guard
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
    const url = opts.url || "/admin/gardssalg-set-provider-name";
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

const OLD_NAME = "Anikonic Cider";
const NEW_NAME = "Anikonic";

export function runOpplevelserGardssalgSetProviderNameTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-set-provider-name-test-key";
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
           (id, navn, slug, vertical, org_nr, content_source, adresse, field_provenance,
            hjemmeside, producer_type, enrichment_state, verification_status, source,
            confidence, catalog_hidden, created_at)
         VALUES
           (@id, @navn, @slug, 'experiences', @org_nr, @content_source, @adresse, @field_provenance,
            @hjemmeside, 'vingard', 'raw', 'pending_verify', 'test-fixture', 'medium',
            @catalog_hidden, @created_at)`,
      );
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          slug: `${p.id}--slug`, org_nr: null, content_source: null, adresse: null,
          field_provenance: null, hjemmeside: null, catalog_hidden: null,
          created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, navn, slug, content_source, field_provenance FROM experience_providers WHERE id = ?`
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
        body: { provider_id: "x", value: NEW_NAME, source: "s" },
      });
      assertEq(wrongKey.status, 403, "a2: wrong X-Admin-Key -> 403");

      // ── (b) happy path: overwrite an existing navn ──────────────────────
      mkProvider({
        id: "sgpn-happy",
        navn: OLD_NAME,
        slug: "anikonic-cider--f28c646b",
        created_at: "2026-01-02 00:00:00",
      });
      const happyRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sgpn-happy",
          value: NEW_NAME,
          source: "crm-thread:1a04801578a5f4fc — Anika Perisic 2026-08-28: fruktvin, ikke sideri",
        },
      });
      assertEq(happyRes.status, 200, "b1: happy path returns 200");
      assertEq(happyRes.body, {
        success: true,
        provider_id: "sgpn-happy",
        field: "navn",
        old_value: OLD_NAME,
        new_value: NEW_NAME,
      }, "b2: response shape matches spec exactly");
      const happyRow = getProviderRow("sgpn-happy");
      assertEq(happyRow.navn, NEW_NAME, "b3: DB column navn actually written");
      assertEq(happyRow.slug, "anikonic-cider--f28c646b", "b4: slug (URL) UNTOUCHED by a name correction");
      const happyProv = JSON.parse(happyRow.field_provenance || "{}");
      assertEq(
        happyProv.navn?.source_url,
        "crm-thread:1a04801578a5f4fc — Anika Perisic 2026-08-28: fruktvin, ikke sideri",
        "b5: field_provenance.navn.source_url is the request's source verbatim",
      );
      assertTrue(!!happyProv.navn?.fetched_at, "b6: field_provenance.navn has a fresh fetched_at");
      const happyAudit = getAuditRows("sgpn-happy");
      assertEq(happyAudit.length, 1, "b7: exactly ONE audit row inserted");
      assertEq(happyAudit[0].field_name, "navn", "b8: audit field_name is navn");
      assertEq(happyAudit[0].old_value, OLD_NAME, "b9: audit old_value is the true pre-write name");
      assertEq(happyAudit[0].new_value, NEW_NAME, "b10: audit new_value is the written value");
      assertEq(happyAudit[0].changed_by, "admin", "b11: audit changed_by is 'admin'");
      assertEq(happyAudit[0].batch_id, null, "b12: audit batch_id is NULL (single-row admin write)");

      // ── (c) unknown provider_id ──────────────────────────────────────────
      const notFoundRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "no-such-provider", value: NEW_NAME, source: "s" },
      });
      assertEq(notFoundRes.status, 404, "c1: unknown provider_id -> 404");
      assertEq(notFoundRes.body.error, "provider_not_found", "c2: error code is provider_not_found");

      // ── (d)/(e) validation ────────────────────────────────────────────────
      const missingProviderId = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { value: NEW_NAME, source: "s" },
      });
      assertEq(missingProviderId.status, 400, "d1: missing provider_id -> 400");
      assertEq(missingProviderId.body.error, "provider_id_required", "d2: error code is provider_id_required");

      mkProvider({ id: "sgpn-validation", navn: OLD_NAME, created_at: "2026-01-03 00:00:00" });
      const missingValue = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sgpn-validation", source: "s" },
      });
      assertEq(missingValue.status, 400, "e1: missing value -> 400");
      assertEq(missingValue.body.error, "value_required", "e2: error code is value_required");

      const blankValue = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sgpn-validation", value: "   ", source: "s" },
      });
      assertEq(blankValue.status, 400, "e3: whitespace-only value -> 400 value_required");
      assertEq(blankValue.body.error, "value_required", "e4: error code is value_required");

      const nonStringValue = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sgpn-validation", value: 123, source: "s" },
      });
      assertEq(nonStringValue.status, 400, "e5: non-string value -> 400 value_required (no null-clear path unlike -set-address)");
      assertEq(nonStringValue.body.error, "value_required", "e6: error code is value_required");

      const missingSource = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sgpn-validation", value: NEW_NAME },
      });
      assertEq(missingSource.status, 400, "e7: missing source -> 400");
      assertEq(missingSource.body.error, "source_required", "e8: error code is source_required");
      assertEq(getProviderRow("sgpn-validation").navn, OLD_NAME, "e9: no validation failure ever wrote the column");
      assertEq(getAuditRows("sgpn-validation").length, 0, "e10: no validation failure ever wrote an audit row");

      // ── (f) owner lock ────────────────────────────────────────────────────
      mkProvider({
        id: "sgpn-manual",
        navn: OLD_NAME,
        content_source: "manual",
        created_at: "2026-01-05 00:00:00",
      });
      const manualRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sgpn-manual", value: NEW_NAME, source: "s" },
      });
      assertEq(manualRes.status, 409, "f1: content_source='manual' -> 409");
      assertEq(manualRes.body.error, "owner_locked", "f2: error code is owner_locked");
      assertEq(getProviderRow("sgpn-manual").navn, OLD_NAME, "f3: manual row UNCHANGED");
      assertEq(getAuditRows("sgpn-manual").length, 0, "f4: NO audit row on an owner-locked refusal");

      // `navn` is NOT claim-portal-editable, so a claim-sourced row is locked
      // unconditionally — WITH an owner_locks.navn stamp present...
      mkProvider({
        id: "sgpn-claim-with-stamp",
        navn: OLD_NAME,
        content_source: "claim",
        field_provenance: JSON.stringify({ owner_locks: { navn: { locked_at: "2026-08-01T00:00:00Z" } } }),
        created_at: "2026-01-06 00:00:00",
      });
      const claimWithStampRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sgpn-claim-with-stamp", value: NEW_NAME, source: "s" },
      });
      assertEq(claimWithStampRes.status, 409, "f5: content_source='claim' WITH an owner_locks.navn stamp -> 409");
      assertEq(claimWithStampRes.body.error, "owner_locked", "f6: error code is owner_locked");

      // ...and WITHOUT one, since the claim portal never exposes navn for
      // editing in the first place.
      mkProvider({
        id: "sgpn-claim-no-stamp",
        navn: OLD_NAME,
        content_source: "claim",
        field_provenance: JSON.stringify({ owner_locks: { visit_text: { locked_at: "2026-08-01T00:00:00Z" } } }),
        created_at: "2026-01-07 00:00:00",
      });
      const claimNoStampRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sgpn-claim-no-stamp", value: NEW_NAME, source: "s" },
      });
      assertEq(claimNoStampRes.status, 409, "f7: content_source='claim' WITHOUT an owner_locks.navn stamp is STILL 409 — navn is always-locked for claim rows, not per-field");
      assertEq(claimNoStampRes.body.error, "owner_locked", "f8: error code is owner_locked");
      assertEq(getProviderRow("sgpn-claim-no-stamp").navn, OLD_NAME, "f9: claim row (no stamp) still UNCHANGED");

      // A row with no claim/manual stamp at all is NOT locked.
      mkProvider({
        id: "sgpn-unlocked",
        navn: OLD_NAME,
        content_source: null,
        created_at: "2026-01-08 00:00:00",
      });
      const unlockedRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sgpn-unlocked", value: NEW_NAME, source: "s" },
      });
      assertEq(unlockedRes.status, 200, "f10: content_source=null -> not locked -> 200");
      assertEq(getProviderRow("sgpn-unlocked").navn, NEW_NAME, "f11: unlocked row written");

      // ── (g) rollback round-trip ─────────────────────────────────────────
      const rollbackPlan = store.planGardssalgContentRollback({
        provider_id: "sgpn-happy",
        field_name: "navn",
      });
      assertEq(rollbackPlan.restorable.length, 1, "g1: rollback planner finds exactly one restorable field");
      assertEq(rollbackPlan.restorable[0]?.field_name, "navn", "g2: restorable field is navn");
      assertEq(rollbackPlan.restorable[0]?.current_value, NEW_NAME, "g3: planner sees the new name as current");
      assertEq(rollbackPlan.restorable[0]?.restore_to, OLD_NAME, "g4: planner proposes restoring the OLD name — zero rollback-side changes needed, navn was added to GARDSSALG_ROLLBACKABLE_FIELDS by this same dev-request");
      assertEq(rollbackPlan.skipped.length, 0, "g5: nothing skipped");
      const applied = store.applyGardssalgContentRollback(rollbackPlan.restorable);
      assertEq(applied.length, 1, "g6: rollback applies exactly one restore");
      assertEq(getProviderRow("sgpn-happy").navn, OLD_NAME, "g7: DB column restored to the pre-correction name");
      assertEq(getProviderRow("sgpn-happy").slug, "anikonic-cider--f28c646b", "g8: slug still untouched after rollback too");

      // ── (h) direct service-function coverage ────────────────────────────
      mkProvider({
        id: "sgpn-service-direct",
        navn: "Gammelt Navn AS",
        created_at: "2026-01-11 00:00:00",
      });
      const directResult = store.applyGardssalgSetProviderName(
        "sgpn-service-direct",
        "Nytt Navn AS",
        "manuell verifisering",
      );
      assertTrue(directResult.ok === true, "h1: direct service call succeeds");
      if (directResult.ok) {
        assertEq(directResult.old_value, "Gammelt Navn AS", "h2: direct call returns the correct old_value");
        assertEq(directResult.new_value, "Nytt Navn AS", "h3: direct call returns the correct new_value");
      }
      const directNotFound = store.applyGardssalgSetProviderName(
        "no-such-provider", NEW_NAME, "s"
      );
      assertTrue(!directNotFound.ok && directNotFound.reason === "provider_not_found", "h4: direct call reports provider_not_found");
      // Whitespace-only value passed DIRECTLY to the service -> value_required,
      // column UNCHANGED, no audit row — same defense-in-depth discipline as
      // the -set-address sibling.
      const directBlank = store.applyGardssalgSetProviderName(
        "sgpn-service-direct", "   ", "manuell verifisering"
      );
      assertTrue(!directBlank.ok, "h5: whitespace-only value rejected by the SERVICE, not just the route");
      assertEq(
        directBlank.ok ? null : directBlank.reason,
        "value_required",
        "h6: direct blank rejection reports reason value_required",
      );
      assertEq(getProviderRow("sgpn-service-direct").navn, "Nytt Navn AS", "h7: column UNCHANGED — a good value was NOT blanked");
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-set-provider-name.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgSetProviderNameTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
