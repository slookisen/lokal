/**
 * opplevelser-gardssalg-set-contact-phone.test.ts — tests for the missing
 * "correct an already-filled stale contact phone" path (dev-request
 * 2026-08-18-gardssalg-set-contact-phone):
 *
 *   - applyGardssalgSetContactPhone() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-set-contact-phone (src/routes/opplevelser.ts)
 *
 * Phone-field counterpart to
 * opplevelser-gardssalg-set-contact-email.test.ts (same gap, this time for
 * `telefon` — Monkey Brew case: a producer replied to outreach with a
 * corrected phone number and no write path existed to apply it).
 *
 * Harness copied verbatim from opplevelser-gardssalg-set-contact-email.test.ts
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and adapted for this endpoint. No
 * domain-mismatch concept applies to a phone number, so this endpoint has no
 * `force` parameter — instead it is gated by the shared write-time phone
 * guard (validatePhoneForWrite, contact-normalizer.ts), so this suite covers
 * that guard's rejection paths instead of the email endpoint's domain cases.
 *
 * Covers:
 *   (a) happy path: blank telefon -> 200, old_value null, new_value set,
 *       DB row updated, field_provenance.telefon has source_url/fetched_at,
 *       one audit row
 *   (b) overwrite path: ALREADY-FILLED telefon -> 200, old_value is the
 *       prior phone (proves this is NOT fill-only like contact-backfill)
 *   (c) unknown provider_id -> 404 provider_not_found
 *   (d) phone write-guard rejection: org-nr-shaped value -> 400
 *       invalid_phone, DB row UNCHANGED (no write happened)
 *   (e) phone write-guard rejection: date-shaped value -> 400 invalid_phone
 *   (f) phone write-guard rejection: does not reduce to 8-digit national
 *       number -> 400 invalid_phone
 *   (g) missing source field -> 400
 *   (h) missing/wrong X-Admin-Key header -> 403
 *   (i) additional validation: missing provider_id -> 400; blank phone -> 400
 *   (j) formatted input (spaces/+47) still passes the shape guard and is
 *       persisted AS TYPED (trimmed only) — this endpoint does not
 *       normalize, matching validatePhoneForWrite's own contract ("returns
 *       the ORIGINAL value unchanged") and the email sibling's precedent of
 *       storing the admin-supplied value verbatim
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
    const url = opts.url || "/admin/gardssalg-set-contact-phone";
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

export function runOpplevelserGardssalgSetContactPhoneTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-set-contact-phone-test-key";
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
            producer_type, enrichment_state, verification_status, source, confidence,
            catalog_hidden, created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @epost, @telefon, @hjemmeside,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium',
            @catalog_hidden, @created_at)`,
      );
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          org_nr: null, content_source: null, epost: null, telefon: null, hjemmeside: null,
          catalog_hidden: null, created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, epost, telefon, hjemmeside, content_source, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      const auth = { "x-admin-key": testKey };

      // ── (h) auth ─────────────────────────────────────────────────────────
      const unauth = await callRoute(opplevelserRouter, { body: {} });
      assertEq(unauth.status, 403, "h: unauthenticated request -> 403");

      // ── (a) happy path: blank telefon ──────────────────────────────────────
      mkProvider({
        id: "scp-happy",
        navn: "Happy Path Gard",
        telefon: null,
        created_at: "2026-01-01 00:00:00",
      });
      const happyRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scp-happy",
          phone: "47636504",
          source: "CRM-tråd 1a00ff69929e133a: Jorg, Monkey Brew",
        },
      });
      assertEq(happyRes.status, 200, "a1: happy path returns 200");
      assertEq(happyRes.body, {
        success: true,
        provider_id: "scp-happy",
        field: "telefon",
        old_value: null,
        new_value: "47636504",
      }, "a2: response shape matches spec exactly");
      const happyRow = getProviderRow("scp-happy");
      assertEq(happyRow.telefon, "47636504", "a3: DB row telefon actually changed");
      const happyProv = JSON.parse(happyRow.field_provenance || "{}");
      assertEq(happyProv.telefon?.source_url, "CRM-tråd 1a00ff69929e133a: Jorg, Monkey Brew", "a4: provenance source_url is the request's source verbatim");
      assertTrue(!!happyProv.telefon?.fetched_at, "a5: provenance has a fresh fetched_at");
      const happyAudit = getAuditRows("scp-happy");
      assertEq(happyAudit.length, 1, "a6: exactly one audit row inserted");
      assertEq(happyAudit[0].field_name, "telefon", "a7: audit field_name is telefon");
      assertEq(happyAudit[0].old_value, null, "a8: audit old_value is the true pre-write null");
      assertEq(happyAudit[0].new_value, "47636504", "a9: audit new_value is the written phone");
      assertEq(happyAudit[0].source_url, "CRM-tråd 1a00ff69929e133a: Jorg, Monkey Brew", "a10: audit source_url matches the request's source");
      assertEq(happyAudit[0].changed_by, "admin", "a11: audit changed_by is 'admin'");

      // ── (b) overwrite path: already-filled telefon ─────────────────────────
      mkProvider({
        id: "scp-overwrite",
        navn: "Overwrite Gard",
        telefon: "41276777",
        created_at: "2026-01-02 00:00:00",
      });
      const overwriteRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scp-overwrite",
          phone: "47636504",
          source: "autosvar: telefonnummer rettet",
        },
      });
      assertEq(overwriteRes.status, 200, "b1: overwrite of an already-filled telefon returns 200 (NOT fill-only)");
      assertEq(overwriteRes.body.old_value, "41276777", "b2: old_value correctly captured as the prior phone");
      assertEq(overwriteRes.body.new_value, "47636504", "b3: new_value is the new phone");
      assertEq(getProviderRow("scp-overwrite").telefon, "47636504", "b4: DB row overwritten");

      // ── (c) unknown provider_id -> 404 ──────────────────────────────────────
      const notFoundRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "does-not-exist",
          phone: "47636504",
          source: "autosvar",
        },
      });
      assertEq(notFoundRes.status, 404, "c1: unknown provider_id -> 404");
      assertEq(notFoundRes.body.error, "provider_not_found", "c2: error code is provider_not_found");

      // ── (d) write-guard: org-nr-shaped value rejected ───────────────────────
      mkProvider({
        id: "scp-orgnr",
        navn: "Orgnr Gard",
        telefon: "90000000",
        org_nr: "927011840",
        created_at: "2026-01-03 00:00:00",
      });
      const orgnrRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scp-orgnr",
          phone: "27011840",
          source: "scrape",
        },
      });
      assertEq(orgnrRes.status, 400, "d1: org-nr-collision phone -> 400");
      assertEq(orgnrRes.body.error, "invalid_phone", "d2: error code is invalid_phone");
      assertEq(getProviderRow("scp-orgnr").telefon, "90000000", "d3: DB row UNCHANGED — no write happened");
      assertEq(getAuditRows("scp-orgnr").length, 0, "d4: no audit row inserted on a blocked write");

      // ── (e) write-guard: date-shaped value rejected ─────────────────────────
      mkProvider({
        id: "scp-date",
        navn: "Date Gard",
        telefon: null,
        created_at: "2026-01-04 00:00:00",
      });
      const dateRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scp-date",
          phone: "20100101",
          source: "scrape",
        },
      });
      assertEq(dateRes.status, 400, "e1: date-shaped phone -> 400");
      assertEq(dateRes.body.error, "invalid_phone", "e2: error code is invalid_phone");
      assertEq(getProviderRow("scp-date").telefon, null, "e3: DB row UNCHANGED — no write happened");

      // ── (f) write-guard: not a valid 8-digit national number ───────────────
      mkProvider({
        id: "scp-badshape",
        navn: "Bad Shape Gard",
        telefon: null,
        created_at: "2026-01-05 00:00:00",
      });
      const badShapeRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scp-badshape",
          phone: "1234",
          source: "scrape",
        },
      });
      assertEq(badShapeRes.status, 400, "f1: too-short phone -> 400");
      assertEq(badShapeRes.body.error, "invalid_phone", "f2: error code is invalid_phone");

      // ── (g) missing source field -> 400 ─────────────────────────────────────
      const missingSourceRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scp-happy",
          phone: "47636504",
        },
      });
      assertEq(missingSourceRes.status, 400, "g1: missing source -> 400");
      assertEq(missingSourceRes.body.error, "source_required", "g2: error code is source_required");

      // ── (i) additional validation ───────────────────────────────────────────
      const missingProviderIdRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { phone: "47636504", source: "autosvar" },
      });
      assertEq(missingProviderIdRes.status, 400, "i1: missing provider_id -> 400");
      assertEq(missingProviderIdRes.body.error, "provider_id_required", "i2: error code is provider_id_required");

      const blankPhoneRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scp-happy", phone: "  ", source: "autosvar" },
      });
      assertEq(blankPhoneRes.status, 400, "i3: blank phone -> 400");
      assertEq(blankPhoneRes.body.error, "phone_required", "i4: error code is phone_required for blank phone");

      // ── (j) formatted input passes the shape guard and is stored AS TYPED ──
      mkProvider({
        id: "scp-formatted",
        navn: "Formatted Gard",
        telefon: null,
        created_at: "2026-01-06 00:00:00",
      });
      const formattedRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scp-formatted",
          phone: "+47 476 36 504",
          source: "autosvar",
        },
      });
      assertEq(formattedRes.status, 200, "j1: formatted phone with spaces/+47 -> 200 (shape guard normalizes only to VALIDATE, not to store)");
      assertEq(formattedRes.body.new_value, "+47 476 36 504", "j2: response new_value is the trimmed input verbatim, not normalized");
      assertEq(getProviderRow("scp-formatted").telefon, "+47 476 36 504", "j3: DB row stores the admin-supplied value verbatim, matching the email endpoint's precedent");

      // ── direct service-function coverage (mirrors route-level assertions) ─
      mkProvider({
        id: "scp-service-direct",
        navn: "Service Direct Gard",
        telefon: "90000001",
        created_at: "2026-01-07 00:00:00",
      });
      const directResult = store.applyGardssalgSetContactPhone(
        "scp-service-direct", "47636504", "manual verification"
      );
      assertTrue(directResult.ok === true, "k1: direct service call succeeds on a valid phone");
      if (directResult.ok) {
        assertEq(directResult.old_value, "90000001", "k2: direct call returns correct old_value");
        assertEq(directResult.new_value, "47636504", "k3: direct call returns correct new_value");
      }
      const directReject = store.applyGardssalgSetContactPhone(
        "scp-service-direct", "20100101", "manual verification"
      );
      assertTrue(directReject.ok === false, "k4: direct service call blocked on date-shaped phone");
      if (!directReject.ok) {
        assertEq(directReject.reason, "invalid_phone", "k5: direct rejection reports invalid_phone");
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-set-contact-phone.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgSetContactPhoneTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
