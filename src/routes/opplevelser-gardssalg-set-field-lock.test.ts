/**
 * opplevelser-gardssalg-set-field-lock.test.ts — tests for the missing
 * ADMIN-facing field lock/unlock endpoint (dev-request 2026-08-29-gardssalg-
 * products-write-and-field-lock, Part B):
 *
 *   - applyGardssalgFieldLock() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-set-field-lock (src/routes/opplevelser.ts)
 *
 * The gap this closes: field_provenance.owner_locks.<field> — the structure
 * isGardssalgFieldOwnerLocked already reads and every gårdssalg content
 * writer already gates on — was populated ONLY by the owner-claim flow.
 * There was no lever for CS/admin to lock a field themselves after a manual
 * correction.
 *
 * Harness copied from opplevelser-gardssalg-set-address.test.ts
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()).
 *
 * Covers:
 *   (a) missing/wrong X-Admin-Key -> 403
 *   (b) happy path LOCK: about_text -> 200, field_provenance.owner_locks.
 *       about_text set with locked_by:"admin" (distinguishing it from an
 *       owner-claim-set lock, which stamps only {locked_at}), one audit row
 *       with the SYNTHETIC field_name "about_text_lock" (NOT the bare field
 *       name — see applyGardssalgFieldLock's own doc comment for why)
 *   (c) happy path UNLOCK: the same field, lock:false -> 200, owner_locks.
 *       about_text entry removed, a SECOND audit row (still "about_text_lock")
 *   (d) all five lockable fields accepted: about_text, visit_text,
 *       opening_hours_text, producer_type, products
 *   (e) a field OUTSIDE the lockable vocabulary (e.g. "adresse", "epost",
 *       or a bogus name) -> 400 invalid_field
 *   (f) missing provider_id -> 400 provider_id_required; missing field ->
 *       400 field_required; missing/non-boolean lock -> 400 lock_required
 *   (g) unknown provider_id -> 404 provider_not_found
 *   (h) locking one field does NOT disturb a pre-existing owner_locks entry
 *       for a DIFFERENT field (read-modify-write merge)
 *   (i) THE cross-cutting proof this dev-request exists for: locking
 *       about_text via this endpoint on an ORDINARY (content_source=null)
 *       row, then calling POST /admin/gardssalg-set-content-field against
 *       the SAME field -> 409 owner_locked (not a silent no-op) — proves
 *       isGardssalgFieldOwnerLocked's broadened gate actually wires through
 *       end-to-end via the real HTTP write paths
 *   (j) same cross-cutting proof for producer_type: lock it, then POST
 *       /admin/gardssalg-set-producer-type against the same provider -> 409
 *       owner_locked
 *   (k) unlocking a previously admin-locked field lets a subsequent
 *       gardssalg-set-content-field call succeed again -> 200
 *   (l) direct service-function coverage (mirrors route-level assertions),
 *       including old_value/new_value on the synthetic audit row carrying
 *       the actual prior/new lock object JSON (not the bare field's content)
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
    const url = opts.url || "/admin/gardssalg-set-field-lock";
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

export function runOpplevelserGardssalgSetFieldLockTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-set-field-lock-test-key";
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
           (id, navn, vertical, org_nr, content_source, about_text, visit_text,
            opening_hours_text, producer_type, products, field_provenance,
            enrichment_state, verification_status, source, confidence,
            catalog_hidden, created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @about_text, @visit_text,
            @opening_hours_text, @producer_type, @products, @field_provenance,
            'raw', 'pending_verify', 'test-fixture', 'medium',
            @catalog_hidden, @created_at)`,
      );
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          org_nr: null, content_source: null, about_text: null, visit_text: null,
          opening_hours_text: null, producer_type: null, products: null, field_provenance: null,
          catalog_hidden: null, created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, content_source, field_provenance FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getOwnerLocks(id: string): any {
        const row = getProviderRow(id);
        const prov = JSON.parse(row.field_provenance || "{}");
        return prov.owner_locks || {};
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
        body: { provider_id: "x", field: "about_text", lock: true },
      });
      assertEq(wrongKey.status, 403, "a2: wrong X-Admin-Key -> 403");

      // ── (b) happy path LOCK ──────────────────────────────────────────────
      mkProvider({ id: "sfl-happy", navn: "Happy Lock Gard" });
      const lockRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sfl-happy",
          field: "about_text",
          lock: true,
          source: "CS verifiserte manuelt 2026-08-29",
        },
      });
      assertEq(lockRes.status, 200, "b1: lock happy path returns 200");
      assertEq(lockRes.body, {
        success: true,
        provider_id: "sfl-happy",
        field: "about_text",
        locked: true,
      }, "b2: response shape matches spec exactly");
      const locksAfterLock = getOwnerLocks("sfl-happy");
      assertTrue(!!locksAfterLock.about_text, "b3: owner_locks.about_text is set");
      assertEq(locksAfterLock.about_text.locked_by, "admin", "b4: locked_by is 'admin' — distinguishes from an owner-claim-set lock");
      assertTrue(!!locksAfterLock.about_text.locked_at, "b5: owner_locks.about_text has a locked_at timestamp");
      assertEq(locksAfterLock.about_text.source_url, "CS verifiserte manuelt 2026-08-29", "b6: source is captured on the lock entry");
      const auditAfterLock = getAuditRows("sfl-happy");
      assertEq(auditAfterLock.length, 1, "b7: exactly ONE audit row inserted");
      assertEq(auditAfterLock[0].field_name, "about_text_lock", "b8: audit field_name is the SYNTHETIC '<field>_lock' marker, NOT the bare 'about_text' — load-bearing for rollback safety");
      assertEq(auditAfterLock[0].old_value, null, "b9: audit old_value is null (no prior lock entry)");
      assertTrue(!!auditAfterLock[0].new_value, "b10: audit new_value carries the new lock object JSON");
      assertEq(JSON.parse(auditAfterLock[0].new_value).locked_by, "admin", "b11: audit new_value's parsed JSON carries locked_by:'admin'");
      assertEq(auditAfterLock[0].changed_by, "admin", "b12: audit changed_by is 'admin'");

      // ── (c) happy path UNLOCK ─────────────────────────────────────────────
      const unlockRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sfl-happy", field: "about_text", lock: false },
      });
      assertEq(unlockRes.status, 200, "c1: unlock happy path returns 200");
      assertEq(unlockRes.body.locked, false, "c2: response reports locked:false");
      const locksAfterUnlock = getOwnerLocks("sfl-happy");
      assertTrue(!("about_text" in locksAfterUnlock), "c3: owner_locks.about_text entry removed entirely");
      const auditAfterUnlock = getAuditRows("sfl-happy");
      assertEq(auditAfterUnlock.length, 2, "c4: a SECOND audit row for the unlock call");
      assertEq(auditAfterUnlock[1].field_name, "about_text_lock", "c5: second audit row still uses the synthetic marker");
      assertTrue(!!auditAfterUnlock[1].old_value, "c6: second audit row's old_value carries the PRIOR lock object (what was just removed)");
      assertEq(auditAfterUnlock[1].new_value, null, "c7: second audit row's new_value is null (nothing locked now)");

      // ── (d) all five lockable fields accepted ────────────────────────────
      mkProvider({ id: "sfl-allfields", navn: "All Fields Gard", created_at: "2026-01-02 00:00:00" });
      for (const field of ["about_text", "visit_text", "opening_hours_text", "producer_type", "products"]) {
        const r = await callRoute(opplevelserRouter, {
          headers: auth,
          body: { provider_id: "sfl-allfields", field, lock: true },
        });
        assertEq(r.status, 200, `d: field '${field}' is accepted -> 200`);
      }
      const allLocks = getOwnerLocks("sfl-allfields");
      for (const field of ["about_text", "visit_text", "opening_hours_text", "producer_type", "products"]) {
        assertTrue(!!allLocks[field], `d: owner_locks.${field} is set after locking all five`);
      }

      // ── (e) a field outside the lockable vocabulary -> 400 ──────────────
      mkProvider({ id: "sfl-badfield", navn: "Bad Field Gard", created_at: "2026-01-03 00:00:00" });
      for (const badField of ["adresse", "epost", "telefon", "hjemmeside", "not_a_real_field"]) {
        const r = await callRoute(opplevelserRouter, {
          headers: auth,
          body: { provider_id: "sfl-badfield", field: badField, lock: true },
        });
        assertEq(r.status, 400, `e: field '${badField}' -> 400`);
        assertEq(r.body.error, "invalid_field", `e: field '${badField}' error code is invalid_field`);
      }

      // ── (f) missing/invalid params ────────────────────────────────────────
      const missingProviderIdRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { field: "about_text", lock: true },
      });
      assertEq(missingProviderIdRes.status, 400, "f1: missing provider_id -> 400");
      assertEq(missingProviderIdRes.body.error, "provider_id_required", "f2: error code is provider_id_required");

      const missingFieldRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sfl-happy", lock: true },
      });
      assertEq(missingFieldRes.status, 400, "f3: missing field -> 400");
      assertEq(missingFieldRes.body.error, "field_required", "f4: error code is field_required");

      const missingLockRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sfl-happy", field: "about_text" },
      });
      assertEq(missingLockRes.status, 400, "f5: missing lock -> 400");
      assertEq(missingLockRes.body.error, "lock_required", "f6: error code is lock_required");

      const stringLockRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sfl-happy", field: "about_text", lock: "true" },
      });
      assertEq(stringLockRes.status, 400, "f7: lock as a STRING (not boolean) -> 400 lock_required");
      assertEq(stringLockRes.body.error, "lock_required", "f8: error code is lock_required for a non-boolean lock");

      // ── (g) unknown provider -> 404 ──────────────────────────────────────
      const notFoundRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "does-not-exist", field: "about_text", lock: true },
      });
      assertEq(notFoundRes.status, 404, "g1: unknown provider_id -> 404");
      assertEq(notFoundRes.body.error, "provider_not_found", "g2: error code is provider_not_found");

      // ── (h) locking one field doesn't disturb another field's lock ──────
      mkProvider({
        id: "sfl-merge",
        navn: "Merge Gard",
        field_provenance: JSON.stringify({ owner_locks: { visit_text: { locked_at: "2026-08-01T00:00:00Z" } } }),
        created_at: "2026-01-04 00:00:00",
      });
      await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sfl-merge", field: "about_text", lock: true },
      });
      const mergedLocks = getOwnerLocks("sfl-merge");
      assertTrue(!!mergedLocks.visit_text, "h1: pre-existing owner_locks.visit_text survives untouched");
      assertEq(mergedLocks.visit_text.locked_at, "2026-08-01T00:00:00Z", "h2: pre-existing entry's own shape/timestamp is unchanged");
      assertTrue(!!mergedLocks.about_text, "h3: the newly-locked about_text entry is also present");

      // ── (i) THE cross-cutting proof: lock -> subsequent gardssalg-set-
      // content-field call against the SAME field on an ORDINARY row -> 409.
      mkProvider({
        id: "sfl-e2e-content",
        navn: "E2E Content Gard",
        content_source: null,
        about_text: "Opprinnelig tekst som er lang nok til å bestå defektsjekken uten problemer.",
        created_at: "2026-01-05 00:00:00",
      });
      const e2eLockRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sfl-e2e-content", field: "about_text", lock: true },
      });
      assertEq(e2eLockRes.status, 200, "i1: lock about_text on an ordinary (content_source=null) row -> 200");
      const e2eWriteRes = await callRoute(opplevelserRouter, {
        headers: auth,
        url: "/admin/gardssalg-set-content-field",
        body: {
          provider_id: "sfl-e2e-content",
          field: "about_text",
          value: "Et forsøk på å overskrive den låste teksten med noe helt annet.",
          source: "s",
        },
      });
      assertEq(e2eWriteRes.status, 409, "i2: gardssalg-set-content-field against the now-admin-locked field -> 409 owner_locked (proves the broadened gate wires through end-to-end)");
      assertEq(e2eWriteRes.body.error, "owner_locked", "i3: error code is owner_locked");

      // ── (j) same cross-cutting proof for producer_type ───────────────────
      mkProvider({
        id: "sfl-e2e-producer-type",
        navn: "E2E Producer Type Gard",
        producer_type: "bryggeri",
        created_at: "2026-01-06 00:00:00",
      });
      await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sfl-e2e-producer-type", field: "producer_type", lock: true },
      });
      const e2eProducerTypeRes = await callRoute(opplevelserRouter, {
        headers: auth,
        url: "/admin/gardssalg-set-producer-type",
        body: {
          provider_id: "sfl-e2e-producer-type",
          producer_type: "annet",
          reason: "forsøk på å endre en låst klassifisering",
        },
      });
      assertEq(e2eProducerTypeRes.status, 409, "j1: gardssalg-set-producer-type against the now-admin-locked field -> 409 owner_locked");
      assertEq(e2eProducerTypeRes.body.error, "owner_locked", "j2: error code is owner_locked");

      // ── (k) unlocking lets a subsequent write succeed again ──────────────
      await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sfl-e2e-content", field: "about_text", lock: false },
      });
      const afterUnlockWriteRes = await callRoute(opplevelserRouter, {
        headers: auth,
        url: "/admin/gardssalg-set-content-field",
        body: {
          provider_id: "sfl-e2e-content",
          field: "about_text",
          value: "En ny, korrekt tekst etter at låsen ble fjernet av en administrator.",
          source: "s",
        },
      });
      assertEq(afterUnlockWriteRes.status, 200, "k1: after unlocking, gardssalg-set-content-field succeeds again -> 200");

      // ── (l) direct service-function coverage ─────────────────────────────
      mkProvider({ id: "sfl-direct", navn: "Direct Gard", created_at: "2026-01-07 00:00:00" });
      const directLock = store.applyGardssalgFieldLock("sfl-direct", "products", true, "direktetest");
      assertTrue(directLock.ok === true, "l1: direct service lock call succeeds");
      if (directLock.ok) {
        assertEq(directLock.field, "products", "l2: direct call returns the correct field");
        assertEq(directLock.locked, true, "l3: direct call returns locked:true");
      }
      const directLocksRow = getOwnerLocks("sfl-direct");
      assertEq(directLocksRow.products.locked_by, "admin", "l4: direct lock also stamps locked_by:'admin'");

      const directUnlock = store.applyGardssalgFieldLock("sfl-direct", "products", false, "");
      assertTrue(directUnlock.ok === true, "l5: direct service unlock call succeeds");
      const directLocksAfterUnlock = getOwnerLocks("sfl-direct");
      assertTrue(!("products" in directLocksAfterUnlock), "l6: direct unlock removes the entry");

      const directAudit = getAuditRows("sfl-direct");
      assertEq(directAudit.length, 2, "l7: two audit rows for direct lock + unlock");
      assertEq(directAudit[0].field_name, "products_lock", "l8: first direct audit row uses the synthetic marker 'products_lock'");
      assertEq(JSON.parse(directAudit[0].new_value).locked_by, "admin", "l9: first direct audit row's new_value JSON has locked_by:'admin'");
      assertTrue(!!directAudit[1].old_value, "l10: second direct audit row's old_value carries the PRIOR lock object");
      assertEq(directAudit[1].new_value, null, "l11: second direct audit row's new_value is null (unlocked)");

      const directNotFound = store.applyGardssalgFieldLock("no-such-provider", "products", true, "s");
      assertTrue(!directNotFound.ok && directNotFound.reason === "provider_not_found", "l12: direct call reports provider_not_found");
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-set-field-lock.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgSetFieldLockTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
