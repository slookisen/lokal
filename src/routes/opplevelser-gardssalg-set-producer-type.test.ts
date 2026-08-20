/**
 * opplevelser-gardssalg-set-producer-type.test.ts — tests for the manual
 * producer_type OVERRIDE write path (Grep 3c, dev-request
 * 2026-08-19-kursjustering-drikkefunnel-llm-og-supply follow-on):
 *
 *   - applyGardssalgSetProducerType() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-set-producer-type (src/routes/opplevelser.ts)
 *
 * Harness copied verbatim from
 * opplevelser-gardssalg-set-terminal-status.test.ts (EXPERIENCES_DB_PATH=
 * ":memory:", fresh require of db-factory + experience-store + opplevelser
 * router per run, callRoute() exercised directly against router.handle())
 * and adapted for this endpoint's producer_type body shape.
 *
 * Covers:
 *   (a) happy-path OVERRIDE: a row with an EXISTING drink-type producer_type
 *       ("bryggeri") is overridden to a NON_DRINK_PRODUCER_TYPES value
 *       ("annet") -> 200, DB row actually changed (unlike the fill-only
 *       sibling applyGardssalgProducerType, which would refuse this), one
 *       audit row
 *   (b) rollback path: producer_type: null on the same row clears it back to
 *       NULL -> 200, DB row cleared, second audit row
 *   (c) rejects a value outside the closed vocabulary -> 400
 *       invalid_producer_type, DB row UNCHANGED (no write happens)
 *   (d) missing provider_id -> 400 provider_id_required
 *   (e) missing/blank reason -> 400 reason_required
 *   (f) unknown provider_id -> 404 provider_not_found
 *   (g) missing/wrong X-Admin-Key header -> 403
 *   (h) source_url fallback vs explicit override (same discipline as
 *       gardssalg-set-terminal-status)
 *   (i) two audit rows total for the happy-path + rollback sequence, correct
 *       field_name/old_value/new_value on each
 *   (j) direct service-function coverage (mirrors route-level assertions)
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
    const url = opts.url || "/admin/gardssalg-set-producer-type";
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

export function runOpplevelserGardssalgSetProducerTypeTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-set-producer-type-test-key";
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
           (id, navn, vertical, org_nr, content_source, epost, telefon, hjemmeside,
            about_text, products, brreg_verified, catalog_hidden, slug, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence,
            created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @epost, @telefon, @hjemmeside,
            @about_text, @products, @brreg_verified, @catalog_hidden, @slug, @field_provenance,
            @producer_type, 'raw', 'pending_verify', 'test-fixture', 'medium',
            @created_at)`,
      );
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          org_nr: null, content_source: null, epost: null, telefon: null, hjemmeside: null,
          about_text: null, products: null, brreg_verified: 0, catalog_hidden: null, slug: null,
          field_provenance: null, producer_type: null,
          created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, producer_type FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      const auth = { "x-admin-key": testKey };

      // ── (g) auth ─────────────────────────────────────────────────────────
      const unauth = await callRoute(opplevelserRouter, { body: {} });
      assertEq(unauth.status, 403, "g: unauthenticated request -> 403");

      // ── (a) happy-path OVERRIDE: existing drink-type -> non-drink-type ─────
      mkProvider({
        id: "spt-happy",
        navn: "Happy Path Bryggeri",
        producer_type: "bryggeri",
        created_at: "2026-01-01 00:00:00",
      });
      assertEq(getProviderRow("spt-happy").producer_type, "bryggeri", "a0: fixture starts as bryggeri (sanity check)");
      const happyRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "spt-happy",
          producer_type: "annet",
          reason: "faktisk et arrangementssted, ikke en reell drikkeprodusent",
        },
      });
      assertEq(happyRes.status, 200, "a1: happy path returns 200");
      assertEq(happyRes.body, {
        success: true,
        provider_id: "spt-happy",
        field: "producer_type",
        old_value: "bryggeri",
        new_value: "annet",
      }, "a2: response shape matches spec exactly");
      assertEq(getProviderRow("spt-happy").producer_type, "annet", "a3: DB row actually changed (override, not fill-only refusal)");
      const happyAudit = getAuditRows("spt-happy");
      assertEq(happyAudit.length, 1, "a4: exactly one audit row inserted");
      assertEq(happyAudit[0].field_name, "producer_type", "a5: audit field_name is producer_type");
      assertEq(happyAudit[0].old_value, "bryggeri", "a6: audit old_value is the true pre-write value");
      assertEq(happyAudit[0].new_value, "annet", "a7: audit new_value is the written value");
      assertEq(happyAudit[0].changed_by, "admin", "a8: audit changed_by is 'admin'");

      // ── (b) rollback path: producer_type: null clears it ───────────────────
      const rollbackRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "spt-happy",
          producer_type: null,
          reason: "feilaktig klassifisert, angre",
        },
      });
      assertEq(rollbackRes.status, 200, "b1: rollback (producer_type: null) returns 200");
      assertEq(rollbackRes.body.old_value, "annet", "b2: old_value is the prior producer_type");
      assertEq(rollbackRes.body.new_value, null, "b3: new_value is null");
      assertEq(getProviderRow("spt-happy").producer_type, null, "b4: DB row cleared");

      // ── (i) two audit rows total for happy-path + rollback ──────────────────
      const afterRollbackAudit = getAuditRows("spt-happy");
      assertEq(afterRollbackAudit.length, 2, "i1: exactly two audit rows total (one per write)");
      assertEq(afterRollbackAudit[1].field_name, "producer_type", "i2: second audit row field_name is producer_type");
      assertEq(afterRollbackAudit[1].old_value, "annet", "i3: second audit row old_value is 'annet'");
      assertEq(afterRollbackAudit[1].new_value, null, "i4: second audit row new_value is null");

      // ── (c) rejects a value outside the closed vocabulary -> 400 ───────────
      mkProvider({
        id: "spt-invalid",
        navn: "Invalid Vocab Gard",
        producer_type: "cideri",
        created_at: "2026-01-02 00:00:00",
      });
      const invalidRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "spt-invalid",
          producer_type: "ikke-en-gyldig-type",
          reason: "test",
        },
      });
      assertEq(invalidRes.status, 400, "c1: invalid producer_type -> 400");
      assertEq(invalidRes.body.error, "invalid_producer_type", "c2: error code is invalid_producer_type");
      assertEq(getProviderRow("spt-invalid").producer_type, "cideri", "c3: DB row UNCHANGED — no write happened");
      assertEq(getAuditRows("spt-invalid").length, 0, "c4: no audit row inserted for the rejected write");

      // ── (d) missing provider_id -> 400 ──────────────────────────────────────
      const missingProviderIdRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { producer_type: "annet", reason: "test" },
      });
      assertEq(missingProviderIdRes.status, 400, "d1: missing provider_id -> 400");
      assertEq(missingProviderIdRes.body.error, "provider_id_required", "d2: error code is provider_id_required");

      // ── (e) missing/blank reason -> 400 ─────────────────────────────────────
      const missingReasonRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "spt-invalid", producer_type: "annet" },
      });
      assertEq(missingReasonRes.status, 400, "e1: missing reason -> 400");
      assertEq(missingReasonRes.body.error, "reason_required", "e2: error code is reason_required");

      const blankReasonRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "spt-invalid", producer_type: "annet", reason: "   " },
      });
      assertEq(blankReasonRes.status, 400, "e3: blank reason -> 400 reason_required");

      // ── (f) unknown provider_id -> 404 ──────────────────────────────────────
      const notFoundRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "does-not-exist",
          producer_type: "annet",
          reason: "test",
        },
      });
      assertEq(notFoundRes.status, 404, "f1: unknown provider_id -> 404");
      assertEq(notFoundRes.body.error, "provider_not_found", "f2: error code is provider_not_found");

      // ── (h) source_url fallback vs explicit override ────────────────────────
      mkProvider({
        id: "spt-provenance",
        navn: "Provenance Gard",
        producer_type: "vingård",
        created_at: "2026-01-03 00:00:00",
      });
      await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "spt-provenance",
          producer_type: "gardsutsalg",
          reason: "muntlig bekreftet av eier, ingen kilde-URL å oppgi",
        },
      });
      const fallbackAudit = getAuditRows("spt-provenance");
      assertEq(
        fallbackAudit[0].source_url,
        "muntlig bekreftet av eier, ingen kilde-URL å oppgi",
        "h1: source_url falls back to reason text when source_url is omitted",
      );

      mkProvider({
        id: "spt-provenance-url",
        navn: "Provenance URL Gard",
        producer_type: "sideri",
        created_at: "2026-01-04 00:00:00",
      });
      await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "spt-provenance-url",
          producer_type: "bakeri",
          reason: "korrigert etter e-post fra eier",
          source_url: "https://mail.example/thread/xyz789",
        },
      });
      const explicitAudit = getAuditRows("spt-provenance-url");
      assertEq(
        explicitAudit[0].source_url,
        "https://mail.example/thread/xyz789",
        "h2: source_url is used verbatim when given, NOT overridden by reason",
      );

      // ── (j) direct service-function coverage ────────────────────────────────
      mkProvider({
        id: "spt-service-direct",
        navn: "Service Direct Gard",
        producer_type: "mjøderi",
        created_at: "2026-01-05 00:00:00",
      });
      const directResult = store.applyGardssalgSetProducerType(
        "spt-service-direct", "annet", "direktetest", undefined
      );
      assertTrue(directResult.ok === true, "j1: direct service call succeeds");
      if (directResult.ok) {
        assertEq(directResult.old_value, "mjøderi", "j2: direct call returns correct old_value");
        assertEq(directResult.new_value, "annet", "j3: direct call returns correct new_value");
      }
      const directNotFound = store.applyGardssalgSetProducerType(
        "does-not-exist", "annet", "direktetest", undefined
      );
      assertTrue(directNotFound.ok === false, "j4: direct service call reports not-found for unknown id");
      if (!directNotFound.ok) {
        assertEq(directNotFound.reason, "provider_not_found", "j5: direct rejection reports provider_not_found");
      }
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-set-producer-type.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgSetProducerTypeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
