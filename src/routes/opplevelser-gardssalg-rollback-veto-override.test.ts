/**
 * opplevelser-gardssalg-rollback-veto-override.test.ts — tests for the
 * rollback-veto override lever (2026-08-09, closing the gap opened by
 * applyGardssalgFieldConcordanceApproval's new `rollback_vetoed` guard —
 * see opplevelser-gardssalg-field-concordance-review-approve.test.ts's own
 * item 9 for that guard's own test):
 *
 *   - planGardssalgRollbackVetoOverride() / applyGardssalgRollbackVetoOverride()
 *     (src/services/experience-store.ts) — service-level, direct calls
 *   - POST /admin/gardssalg-rollback-veto-override (src/routes/opplevelser.ts)
 *     — route-level, through the router
 *
 * Same in-memory-DB + fresh-require + callRoute() harness as
 * opplevelser-gardssalg-field-concordance-review-approve.test.ts.
 *
 * Covers:
 *   1. invalid_field — a field not in GFC_APPROVAL_FIELDS (e.g. "adresse")
 *      is rejected before ANY SQL, even with a provider_id that doesn't
 *      exist (proven by getting invalid_field, not not_found)
 *   2. justification_required — missing/blank/whitespace-only, rejected
 *      BEFORE the DB is ever queried for the provider (proven the same way:
 *      a nonexistent provider_id + blank justification still returns
 *      justification_required, not not_found), zero writes
 *   3. not_found — valid field, nonexistent provider
 *   4. not_vetoed — a field with no rollback history (or whose latest audit
 *      row is NOT a rollback) -> not_vetoed, zero writes (full audit
 *      row-count diff)
 *   5. success — a genuinely vetoed field + valid justification: exactly
 *      ONE new gardssalg_content_audit row (new sentinel source_url,
 *      trimmed/truncated justification in notes, changed_by='admin'), the
 *      original rollback row untouched and still present (both rows exist,
 *      in insertion order), experience_providers' stored value UNCHANGED,
 *      and gardssalgContactFieldWasRolledBack() immediately re-checks false
 *   6. justification truncation — a >1000-char justification is silently
 *      truncated to 1000 chars in notes, never rejected
 *   7. planGardssalgRollbackVetoOverride mirrors the apply path's reason
 *      codes without ever writing (dry-run precheck)
 *   8. route: auth (missing/wrong X-Admin-Key -> 403, zero DB touch)
 *   9. route: 400 when provider_id/field_name/justification is missing,
 *      before any DB read (zero audit rows before/after)
 *  10. route: dry-run (apply omitted) makes zero writes even when the
 *      override would succeed; apply=true then performs the real override
 *
 * Run standalone:
 *   npx tsx src/routes/opplevelser-gardssalg-rollback-veto-override.test.ts
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
    const url = opts.url || "/admin/gardssalg-rollback-veto-override";
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

export function runOpplevelserGardssalgRollbackVetoOverrideTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-rollback-veto-override-test-key";
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

      const insertAuditRow = expDb.prepare(
        `INSERT INTO gardssalg_content_audit
           (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
         VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, @batch_id, @changed_by, datetime('now'))`,
      );

      // prov-vetoed — epost written then rolled back; latest audit row for
      // (prov-vetoed, epost) is the rollback marker.
      insertProvider.run({
        id: "prov-vetoed",
        navn: "Bryggeriet Vetoed",
        ...baseProvider({ epost: null }),
      });
      insertAuditRow.run({
        id: "aud-vetoed-write",
        provider_id: "prov-vetoed",
        field_name: "epost",
        old_value: null,
        new_value: "was-here@vetoed.no",
        source_url: "https://vetoed.no",
        batch_id: null,
        changed_by: "system",
      });
      insertAuditRow.run({
        id: "aud-vetoed-rollback",
        provider_id: "prov-vetoed",
        field_name: "epost",
        old_value: "was-here@vetoed.no",
        new_value: null,
        source_url: "internal://rollback",
        batch_id: null,
        changed_by: "system",
      });

      // prov-never-vetoed — epost written, never rolled back.
      insertProvider.run({
        id: "prov-never-vetoed",
        navn: "Bryggeriet Ikke Vetoed",
        ...baseProvider({ epost: "still-here@ikke-vetoed.no" }),
      });
      insertAuditRow.run({
        id: "aud-never-vetoed-write",
        provider_id: "prov-never-vetoed",
        field_name: "epost",
        old_value: null,
        new_value: "still-here@ikke-vetoed.no",
        source_url: "https://ikke-vetoed.no",
        batch_id: null,
        changed_by: "system",
      });

      // prov-no-history — exists, but has NO audit row at all for telefon.
      insertProvider.run({
        id: "prov-no-history",
        navn: "Bryggeriet Ingen Historie",
        ...baseProvider({ telefon: "90000000" }),
      });

      // prov-long-justification-veto — a second, independently-vetoed field
      // used for the truncation test so it doesn't interfere with the main
      // success-path assertions on prov-vetoed.
      insertProvider.run({
        id: "prov-long-justification",
        navn: "Bryggeriet Langt",
        ...baseProvider({ telefon: null }),
      });
      insertAuditRow.run({
        id: "aud-long-write",
        provider_id: "prov-long-justification",
        field_name: "telefon",
        old_value: null,
        new_value: "90000001",
        source_url: "https://langt.no",
        batch_id: null,
        changed_by: "system",
      });
      insertAuditRow.run({
        id: "aud-long-rollback",
        provider_id: "prov-long-justification",
        field_name: "telefon",
        old_value: "90000001",
        new_value: null,
        source_url: "internal://rollback",
        batch_id: null,
        changed_by: "system",
      });

      const auditCount = () =>
        (expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit`).get() as { n: number }).n;

      // ── 1. invalid_field — before any SQL ───────────────────────────────
      const beforeInvalid = auditCount();
      const invalidFieldResult = experienceStore.applyGardssalgRollbackVetoOverride(
        "provider-does-not-exist",
        "adresse",
        "en gyldig begrunnelse",
      );
      assertEq(
        invalidFieldResult,
        { provider_id: "provider-does-not-exist", field_name: "adresse", overridden: false, reason: "invalid_field" },
        "1a: invalid_field rejected even with a nonexistent provider_id (never reaches SQL)",
      );
      assertEq(auditCount(), beforeInvalid, "1b: invalid_field -> zero writes");

      // ── 2. justification_required — before any DB read ──────────────────
      const beforeJustification = auditCount();
      for (const badJustification of ["", "   ", undefined as unknown as string]) {
        const r = experienceStore.applyGardssalgRollbackVetoOverride(
          "provider-does-not-exist",
          "epost",
          badJustification,
        );
        assertEq(
          r,
          { provider_id: "provider-does-not-exist", field_name: "epost", overridden: false, reason: "justification_required" },
          `2a: justification_required for ${JSON.stringify(badJustification)} (even nonexistent provider -> not not_found)`,
        );
      }
      assertEq(auditCount(), beforeJustification, "2b: justification_required -> zero writes");

      // ── 3. not_found ──────────────────────────────────────────────────
      const notFoundResult = experienceStore.applyGardssalgRollbackVetoOverride(
        "provider-does-not-exist",
        "epost",
        "gyldig begrunnelse",
      );
      assertEq(
        notFoundResult,
        { provider_id: "provider-does-not-exist", field_name: "epost", overridden: false, reason: "not_found" },
        "3a: not_found for a nonexistent (but validly-shaped) request",
      );

      // ── 4. not_vetoed ─────────────────────────────────────────────────
      const beforeNotVetoed = auditCount();
      const notVetoedResult1 = experienceStore.applyGardssalgRollbackVetoOverride(
        "prov-never-vetoed",
        "epost",
        "gyldig begrunnelse",
      );
      assertEq(
        notVetoedResult1,
        { provider_id: "prov-never-vetoed", field_name: "epost", overridden: false, reason: "not_vetoed" },
        "4a: not_vetoed for a field that was written but never rolled back",
      );
      const notVetoedResult2 = experienceStore.applyGardssalgRollbackVetoOverride(
        "prov-no-history",
        "telefon",
        "gyldig begrunnelse",
      );
      assertEq(
        notVetoedResult2,
        { provider_id: "prov-no-history", field_name: "telefon", overridden: false, reason: "not_vetoed" },
        "4b: not_vetoed for a field with NO audit history at all",
      );
      assertEq(auditCount(), beforeNotVetoed, "4c: not_vetoed -> zero writes (full row-count diff)");

      // ── 5. success ────────────────────────────────────────────────────
      const beforeSuccessAudit = expDb
        .prepare(`SELECT * FROM gardssalg_content_audit WHERE provider_id = 'prov-vetoed' ORDER BY rowid`)
        .all() as any[];
      const providerRowBefore = expDb.prepare(`SELECT epost FROM experience_providers WHERE id = 'prov-vetoed'`).get() as any;
      assertTrue(
        experienceStore.gardssalgContactFieldWasRolledBack("prov-vetoed", "epost"),
        "5a: precondition — prov-vetoed/epost IS currently vetoed",
      );
      const successResult = experienceStore.applyGardssalgRollbackVetoOverride(
        "prov-vetoed",
        "epost",
        "  Daniel bekreftet: opprinnelig rollback var en feilvurdering.  ",
        "batch-override-1",
      );
      assertEq(
        successResult,
        { provider_id: "prov-vetoed", field_name: "epost", overridden: true },
        "5b: successful override returns overridden:true, no reason key",
      );

      const afterSuccessAudit = expDb.prepare(`SELECT * FROM gardssalg_content_audit WHERE provider_id = 'prov-vetoed' ORDER BY rowid`).all() as any[];
      assertEq(afterSuccessAudit.length, beforeSuccessAudit.length + 1, "5c: exactly ONE new gardssalg_content_audit row");
      assertEq(afterSuccessAudit[0].id, "aud-vetoed-write", "5d: original content-refresh write row still present, unchanged, first");
      assertEq(afterSuccessAudit[1].id, "aud-vetoed-rollback", "5e: original rollback marker row still present, unchanged, second");
      assertEq(afterSuccessAudit[1].source_url, "internal://rollback", "5f: original rollback row's source_url untouched");
      const overrideRow = afterSuccessAudit[2];
      assertTrue(!!overrideRow, "5g: a third row exists (the override)");
      assertEq(overrideRow.source_url, "internal://rollback-veto-override", "5h: override row stamped with the NEW distinct sentinel");
      assertEq(overrideRow.notes, "Daniel bekreftet: opprinnelig rollback var en feilvurdering.", "5i: notes carries the trimmed justification");
      assertEq(overrideRow.changed_by, "admin", "5j: changed_by is 'admin'");
      assertEq(overrideRow.batch_id, "batch-override-1", "5k: batch_id carried through");
      assertEq(overrideRow.old_value, providerRowBefore.epost, "5l: old_value is the field's CURRENT stored value (unchanged)");
      assertEq(overrideRow.new_value, providerRowBefore.epost, "5m: new_value equals old_value — the lever never changes content");

      const providerRowAfter = expDb.prepare(`SELECT epost FROM experience_providers WHERE id = 'prov-vetoed'`).get() as any;
      assertEq(providerRowAfter.epost, providerRowBefore.epost, "5n: experience_providers.epost is byte-unchanged");

      assertTrue(
        !experienceStore.gardssalgContactFieldWasRolledBack("prov-vetoed", "epost"),
        "5o: gardssalgContactFieldWasRolledBack immediately re-checks false after the override",
      );

      // ── 6. justification truncation ──────────────────────────────────
      const longJustification = "x".repeat(1500);
      const truncResult = experienceStore.applyGardssalgRollbackVetoOverride(
        "prov-long-justification",
        "telefon",
        longJustification,
      );
      assertEq(truncResult, { provider_id: "prov-long-justification", field_name: "telefon", overridden: true }, "6a: long justification still succeeds");
      const truncRow = expDb
        .prepare(`SELECT notes FROM gardssalg_content_audit WHERE provider_id = 'prov-long-justification' AND source_url = 'internal://rollback-veto-override'`)
        .get() as any;
      assertEq(truncRow.notes.length, 1000, "6b: notes silently truncated to 1000 chars");
      assertEq(truncRow.notes, "x".repeat(1000), "6c: truncated notes content matches the first 1000 chars");

      // ── 7. planGardssalgRollbackVetoOverride mirrors apply's reasons ────
      assertEq(
        experienceStore.planGardssalgRollbackVetoOverride("whoever", "adresse", "ok"),
        { provider_id: "whoever", field_name: "adresse", overridden: false, reason: "invalid_field" },
        "7a: plan mirrors invalid_field",
      );
      assertEq(
        experienceStore.planGardssalgRollbackVetoOverride("whoever", "epost", "   "),
        { provider_id: "whoever", field_name: "epost", overridden: false, reason: "justification_required" },
        "7b: plan mirrors justification_required",
      );
      assertEq(
        experienceStore.planGardssalgRollbackVetoOverride("provider-does-not-exist", "epost", "ok"),
        { provider_id: "provider-does-not-exist", field_name: "epost", overridden: false, reason: "not_found" },
        "7c: plan mirrors not_found",
      );
      assertEq(
        experienceStore.planGardssalgRollbackVetoOverride("prov-never-vetoed", "epost", "ok"),
        { provider_id: "prov-never-vetoed", field_name: "epost", overridden: false, reason: "not_vetoed" },
        "7d: plan mirrors not_vetoed",
      );
      const beforePlanSuccessAudit = auditCount();
      const planSuccessResult = experienceStore.planGardssalgRollbackVetoOverride(
        "prov-long-justification",
        "telefon",
        "ok",
      );
      // prov-long-justification/telefon was already overridden in step 6, so
      // it's no longer vetoed — plan should now say not_vetoed too (proving
      // plan reads LIVE state, not a cached notion of "was once vetoed").
      assertEq(
        planSuccessResult,
        { provider_id: "prov-long-justification", field_name: "telefon", overridden: false, reason: "not_vetoed" },
        "7e: plan reflects live state — already-overridden field now reports not_vetoed",
      );
      assertEq(auditCount(), beforePlanSuccessAudit, "7f: plan() never writes, regardless of outcome");

      // ── route-level ──────────────────────────────────────────────────
      const authHeaders = { "x-admin-key": testKey };

      // 8. auth
      const beforeAuthAudit = auditCount();
      const noKey = await callRoute(opplevelserRouter, {
        body: { provider_id: "prov-vetoed", field_name: "epost", justification: "x", apply: true },
      });
      assertEq(noKey.status, 403, "8a: POST without X-Admin-Key -> 403");
      const wrongKey = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": "totally-wrong" },
        body: { provider_id: "prov-vetoed", field_name: "epost", justification: "x", apply: true },
      });
      assertEq(wrongKey.status, 403, "8b: POST with wrong X-Admin-Key -> 403");
      assertEq(auditCount(), beforeAuthAudit, "8c: auth failures touch zero rows");

      // 9. 400s for missing required fields, before any DB read
      const beforeMissingAudit = auditCount();
      const missingProviderId = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { field_name: "epost", justification: "x" },
      });
      assertEq(missingProviderId.status, 400, "9a: missing provider_id -> 400");
      const missingFieldName = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_id: "prov-vetoed", justification: "x" },
      });
      assertEq(missingFieldName.status, 400, "9b: missing field_name -> 400");
      const missingJustification = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_id: "prov-vetoed", field_name: "epost" },
      });
      assertEq(missingJustification.status, 400, "9c: missing justification -> 400");
      const blankJustification = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_id: "prov-vetoed", field_name: "epost", justification: "   " },
      });
      assertEq(blankJustification.status, 400, "9d: whitespace-only justification -> 400");
      assertEq(auditCount(), beforeMissingAudit, "9e: no writes from any of the 400 cases");

      // 10. dry-run vs apply, through the route, on a FRESH vetoed fixture
      const insertFreshVetoed = () => {
        insertProvider.run({
          id: "prov-route-vetoed",
          navn: "Bryggeriet Route Vetoed",
          ...baseProvider({ mobil: null }),
        });
        insertAuditRow.run({
          id: "aud-route-vetoed-write",
          provider_id: "prov-route-vetoed",
          field_name: "mobil",
          old_value: null,
          new_value: "99000000",
          source_url: "https://route-vetoed.no",
          batch_id: null,
          changed_by: "system",
        });
        insertAuditRow.run({
          id: "aud-route-vetoed-rollback",
          provider_id: "prov-route-vetoed",
          field_name: "mobil",
          old_value: "99000000",
          new_value: null,
          source_url: "internal://rollback",
          batch_id: null,
          changed_by: "system",
        });
      };
      insertFreshVetoed();

      const beforeDryRunAudit = auditCount();
      const dryRun = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_id: "prov-route-vetoed", field_name: "mobil", justification: "test dry-run" },
      });
      assertEq(dryRun.status, 200, "10a: dry-run -> 200");
      assertEq(dryRun.body.dry_run, true, "10b: dry_run:true when apply omitted");
      assertEq(dryRun.body.would_override, true, "10c: dry-run reports would_override:true for a genuinely vetoed field");
      assertEq(auditCount(), beforeDryRunAudit, "10d: dry-run writes nothing, even though it WOULD succeed");

      const apply = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_id: "prov-route-vetoed", field_name: "mobil", justification: "test apply", apply: true },
      });
      assertEq(apply.status, 200, "10e: apply=true -> 200");
      assertEq(apply.body.dry_run, false, "10f: dry_run:false when applying");
      assertEq(apply.body.overridden, true, "10g: apply=true actually overrides");
      assertEq(auditCount(), beforeDryRunAudit + 1, "10h: apply=true writes exactly one new audit row");
      assertTrue(
        !experienceStore.gardssalgContactFieldWasRolledBack("prov-route-vetoed", "mobil"),
        "10i: veto lifted after the route-level apply",
      );

      // route also surfaces invalid_field/not_vetoed as 200+reason, not 500
      const routeNotVetoed = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { provider_id: "prov-route-vetoed", field_name: "mobil", justification: "already lifted", apply: true },
      });
      assertEq(routeNotVetoed.status, 200, "10j: re-override of an already-lifted veto -> 200 (not an error)");
      assertEq(routeNotVetoed.body.overridden, false, "10k: ...overridden:false");
      assertEq(routeNotVetoed.body.reason, "not_vetoed", "10l: ...reason not_vetoed");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-rollback-veto-override: unexpected error: " + String(err?.stack || err?.message || err),
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-rollback-veto-override.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgRollbackVetoOverrideTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
