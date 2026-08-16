/**
 * opplevelser-gardssalg-set-contact-email.test.ts — tests for the missing
 * "correct an already-filled stale contact email" path (dev-request
 * 2026-08-16-gardssalg-set-contact-email):
 *
 *   - applyGardssalgSetContactEmail() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-set-contact-email (src/routes/opplevelser.ts)
 *
 * gardssalg-contact-backfill (opplevelser-gardssalg-contact-backfill.test.ts)
 * only ever WRITES epost when it is currently blank (fill-only) — there was
 * no lever to CORRECT an already-filled epost once it goes stale (e.g. an
 * autoresponder says the contact person left and gives a new address). This
 * suite covers that missing path.
 *
 * Harness copied verbatim from opplevelser-gardssalg-contact-backfill.test.ts
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and adapted only for this endpoint.
 *
 * Covers:
 *   (a) happy path: blank epost, hjemmeside domain matches new email domain
 *       -> 200, old_value null, new_value set, DB row updated,
 *       field_provenance.epost has source_url/fetched_at, one audit row
 *   (b) overwrite path: ALREADY-FILLED epost -> 200, old_value is the prior
 *       email (proves this is NOT fill-only like contact-backfill)
 *   (c) domain mismatch without force -> 409 domain_mismatch, DB row
 *       UNCHANGED (no write happened)
 *   (d) domain mismatch WITH force:true -> 200, write succeeds
 *   (e) provider has no hjemmeside at all -> write succeeds without force
 *   (f) unknown provider_id -> 404 provider_not_found
 *   (g) invalid email format -> 400
 *   (h) missing source field -> 400
 *   (i) missing/wrong X-Admin-Key header -> 403
 *   (j) additional validation: missing provider_id -> 400; blank email -> 400
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
    const url = opts.url || "/admin/gardssalg-set-contact-email";
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

export function runOpplevelserGardssalgSetContactEmailTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-set-contact-email-test-key";
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

      // ── (i) auth ─────────────────────────────────────────────────────────
      const unauth = await callRoute(opplevelserRouter, { body: {} });
      assertEq(unauth.status, 403, "i: unauthenticated request -> 403");

      // ── (a) happy path: blank epost, matching hjemmeside domain ──────────
      mkProvider({
        id: "sce-happy",
        navn: "Happy Path Gard",
        hjemmeside: "https://happygard.no",
        epost: null,
        created_at: "2026-01-01 00:00:00",
      });
      const happyRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sce-happy",
          email: "ny@happygard.no",
          source: "autosvar 2026-08-16T08:40:53Z + kontaktside",
        },
      });
      assertEq(happyRes.status, 200, "a1: happy path returns 200");
      assertEq(happyRes.body, {
        success: true,
        provider_id: "sce-happy",
        field: "epost",
        old_value: null,
        new_value: "ny@happygard.no",
      }, "a2: response shape matches spec exactly");
      const happyRow = getProviderRow("sce-happy");
      assertEq(happyRow.epost, "ny@happygard.no", "a3: DB row epost actually changed");
      const happyProv = JSON.parse(happyRow.field_provenance || "{}");
      assertEq(happyProv.epost?.source_url, "autosvar 2026-08-16T08:40:53Z + kontaktside", "a4: provenance source_url is the request's source verbatim");
      assertTrue(!!happyProv.epost?.fetched_at, "a5: provenance has a fresh fetched_at");
      const happyAudit = getAuditRows("sce-happy");
      assertEq(happyAudit.length, 1, "a6: exactly one audit row inserted");
      assertEq(happyAudit[0].field_name, "epost", "a7: audit field_name is epost");
      assertEq(happyAudit[0].old_value, null, "a8: audit old_value is the true pre-write null");
      assertEq(happyAudit[0].new_value, "ny@happygard.no", "a9: audit new_value is the written email");
      assertEq(happyAudit[0].source_url, "autosvar 2026-08-16T08:40:53Z + kontaktside", "a10: audit source_url matches the request's source");
      assertEq(happyAudit[0].changed_by, "admin", "a11: audit changed_by is 'admin'");

      // ── (b) overwrite path: already-filled epost ──────────────────────────
      mkProvider({
        id: "sce-overwrite",
        navn: "Overwrite Gard",
        hjemmeside: "https://overwritegard.no",
        epost: "gammel-kontakt@overwritegard.no",
        created_at: "2026-01-02 00:00:00",
      });
      const overwriteRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sce-overwrite",
          email: "ny-kontakt@overwritegard.no",
          source: "autosvar: gammel kontakt sluttet",
        },
      });
      assertEq(overwriteRes.status, 200, "b1: overwrite of an already-filled epost returns 200 (NOT fill-only)");
      assertEq(overwriteRes.body.old_value, "gammel-kontakt@overwritegard.no", "b2: old_value correctly captured as the prior email");
      assertEq(overwriteRes.body.new_value, "ny-kontakt@overwritegard.no", "b3: new_value is the new email");
      assertEq(getProviderRow("sce-overwrite").epost, "ny-kontakt@overwritegard.no", "b4: DB row overwritten");

      // ── (c) domain mismatch without force -> 409, no write ────────────────
      mkProvider({
        id: "sce-mismatch",
        navn: "Mismatch Gard",
        hjemmeside: "https://mismatchgard.no",
        epost: "post@mismatchgard.no",
        created_at: "2026-01-03 00:00:00",
      });
      const mismatchRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sce-mismatch",
          email: "ny@annendomene.no",
          source: "autosvar",
        },
      });
      assertEq(mismatchRes.status, 409, "c1: domain mismatch without force -> 409");
      assertEq(mismatchRes.body.error, "domain_mismatch", "c2: error code is domain_mismatch");
      assertEq(mismatchRes.body.website_domain, "mismatchgard.no", "c3: website_domain reported");
      assertEq(mismatchRes.body.email_domain, "annendomene.no", "c4: email_domain reported");
      assertEq(getProviderRow("sce-mismatch").epost, "post@mismatchgard.no", "c5: DB row UNCHANGED — no write happened");
      assertEq(getAuditRows("sce-mismatch").length, 0, "c6: no audit row inserted on a blocked write");

      // ── (d) domain mismatch WITH force:true -> 200, write succeeds ────────
      const forcedRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sce-mismatch",
          email: "ny@annendomene.no",
          source: "autosvar, bekreftet manuelt",
          force: true,
        },
      });
      assertEq(forcedRes.status, 200, "d1: force:true bypasses the domain-mismatch block -> 200");
      assertEq(forcedRes.body.new_value, "ny@annendomene.no", "d2: write succeeds despite mismatch");
      assertEq(getProviderRow("sce-mismatch").epost, "ny@annendomene.no", "d3: DB row now updated");

      // ── (e) no hjemmeside on file -> write succeeds without force ─────────
      mkProvider({
        id: "sce-no-website",
        navn: "No Website Gard",
        hjemmeside: null,
        epost: null,
        created_at: "2026-01-04 00:00:00",
      });
      const noWebsiteRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sce-no-website",
          email: "post@whatever-domain.no",
          source: "autosvar",
        },
      });
      assertEq(noWebsiteRes.status, 200, "e1: provider without hjemmeside -> write succeeds without force");
      assertEq(getProviderRow("sce-no-website").epost, "post@whatever-domain.no", "e2: DB row written");

      // ── (f) unknown provider_id -> 404 ─────────────────────────────────────
      const notFoundRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "does-not-exist",
          email: "post@example.no",
          source: "autosvar",
        },
      });
      assertEq(notFoundRes.status, 404, "f1: unknown provider_id -> 404");
      assertEq(notFoundRes.body.error, "provider_not_found", "f2: error code is provider_not_found");

      // ── (g) invalid email format -> 400 ────────────────────────────────────
      const invalidEmailRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sce-happy",
          email: "not-an-email",
          source: "autosvar",
        },
      });
      assertEq(invalidEmailRes.status, 400, "g1: invalid email format -> 400");
      assertEq(invalidEmailRes.body.error, "invalid_email", "g2: error code is invalid_email");

      // ── (h) missing source field -> 400 ────────────────────────────────────
      const missingSourceRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sce-happy",
          email: "post@happygard.no",
        },
      });
      assertEq(missingSourceRes.status, 400, "h1: missing source -> 400");
      assertEq(missingSourceRes.body.error, "source_required", "h2: error code is source_required");

      // ── (j) additional validation ──────────────────────────────────────────
      const missingProviderIdRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "post@example.no", source: "autosvar" },
      });
      assertEq(missingProviderIdRes.status, 400, "j1: missing provider_id -> 400");
      assertEq(missingProviderIdRes.body.error, "provider_id_required", "j2: error code is provider_id_required");

      const blankEmailRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sce-happy", email: "  ", source: "autosvar" },
      });
      assertEq(blankEmailRes.status, 400, "j3: blank email -> 400");
      assertEq(blankEmailRes.body.error, "email_required", "j4: error code is email_required for blank email");

      // ── direct service-function coverage (mirrors route-level assertions) ─
      mkProvider({
        id: "sce-service-direct",
        navn: "Service Direct Gard",
        hjemmeside: "https://servicedirect.no",
        epost: "old@servicedirect.no",
        created_at: "2026-01-05 00:00:00",
      });
      const directResult = store.applyGardssalgSetContactEmail(
        "sce-service-direct", "new@servicedirect.no", "manual verification", false
      );
      assertTrue(directResult.ok === true, "k1: direct service call succeeds on matching domain");
      if (directResult.ok) {
        assertEq(directResult.old_value, "old@servicedirect.no", "k2: direct call returns correct old_value");
        assertEq(directResult.new_value, "new@servicedirect.no", "k3: direct call returns correct new_value");
      }
      const directMismatch = store.applyGardssalgSetContactEmail(
        "sce-service-direct", "new@otherdomain.no", "manual verification", false
      );
      assertTrue(directMismatch.ok === false, "k4: direct service call blocked on domain mismatch");
      if (!directMismatch.ok && directMismatch.reason === "domain_mismatch") {
        assertEq(directMismatch.website_domain, "servicedirect.no", "k5: direct mismatch reports website_domain");
        assertEq(directMismatch.email_domain, "otherdomain.no", "k6: direct mismatch reports email_domain");
      } else {
        failed++;
        failures.push("✗ k5/k6: direct mismatch did not return reason domain_mismatch");
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-set-contact-email.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgSetContactEmailTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
