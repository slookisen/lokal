/**
 * opplevelser-admin-fylke-2024-migration.test.ts — route-level tests for
 * POST /api/opplevelser/admin/fylke-2024-migration (dev-request
 * 2026-08-07-orch-fylke-2024-migrasjon).
 *
 * Mirrors opplevelser-gardssalg-content-audit.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle() with X-Admin-Key via headers).
 *
 * Covers:
 *   (a) dry-run reports correct per-table {total_candidates, resolved,
 *       needs_review} counts against a seeded DB with rows in old-model
 *       fylker (Viken / Vestfold og Telemark / Troms og Finnmark) AND rows
 *       already on a correct 2024 fylke (untouched, never counted)
 *   (b) dry-run performs ZERO writes
 *   (c) apply writes the resolved fylke on resolved rows, and inserts one
 *       experience_fylke_2024_migration_audit row per write
 *   (d) needs_review rows are NEVER written on apply, and never audited
 *   (e) rows on any OTHER fylke (not one of the 3 stale names) are left
 *       completely untouched by apply
 *   (f) batch-cap is respected — apply on a cohort larger than the cap
 *       writes at most the cap's worth of rows per table
 *   (g) auth-gated: missing/wrong X-Admin-Key -> 403
 *   (h) needs_review_samples is capped and carries id/fylke/reason
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
    const url = opts.url || "/admin/fylke-2024-migration";
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

export function runOpplevelserAdminFylke2024MigrationTests(
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
    const testKey = process.env.ADMIN_KEY || "fylke-2024-migration-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const fylkeMigrationPath = require.resolve("../services/fylke-2024-migration");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, fylkeMigrationPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── Seed experiences (no kommunenummer column — kommune name only) ──
      const providerBase = store.createProvider({
        navn: "Base Provider AS", fylke: "Rogaland", kommune: "Stavanger",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      // e1: stale 'Viken', kommune 'Bærum' -> resolves to Akershus
      const eViken = store.createExperience({
        title: "Tur i Bærum", provider_id: providerBase, provider_match_status: "matched",
        kommune: "Bærum", fylke: "Viken", verification_status: "verified", confidence: "high",
      });
      // e2: stale 'Troms og Finnmark', kommune 'Tromsø' -> resolves to Troms
      const eTF = store.createExperience({
        title: "Fjelltur i Tromsø", provider_id: providerBase, provider_match_status: "matched",
        kommune: "Tromsø", fylke: "Troms og Finnmark", verification_status: "verified", confidence: "high",
      });
      // e3: stale 'Vestfold og Telemark', kommune name UNKNOWN -> needs_review
      const eVTUnknown = store.createExperience({
        title: "Ukjent kommune-opplevelse", provider_id: providerBase, provider_match_status: "matched",
        kommune: "Ikke-En-Ekte-Kommune", fylke: "Vestfold og Telemark", verification_status: "verified", confidence: "high",
      });
      // e4: already-correct 2024 fylke -> must NEVER appear as a candidate
      const eAlreadyCorrect = store.createExperience({
        title: "Allerede riktig fylke", provider_id: providerBase, provider_match_status: "matched",
        kommune: "Stavanger", fylke: "Rogaland", verification_status: "verified", confidence: "high",
      });

      function getExperienceRow(id: string): any {
        return expDb.prepare(`SELECT id, fylke FROM experiences WHERE id = ?`).get(id);
      }

      // ── Seed experience_providers (has kommunenummer) ────────────────
      // p1: stale 'Viken', kommunenummer for Bærum (3201) -> resolves to Akershus
      const pViken = store.createProvider({
        navn: "Viken Provider AS", fylke: "Viken", kommune: "Bærum", kommunenummer: "3201",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      // p2: stale 'Troms og Finnmark', kommunenummer NOT in the vendored table -> needs_review
      const pTFUnknownNr = store.createProvider({
        navn: "TF Provider Unknown Nr AS", fylke: "Troms og Finnmark", kommune: "Tromsø", kommunenummer: "9999",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      // p3: already-correct 2024 fylke -> must never appear as a candidate
      const pAlreadyCorrect = store.createProvider({
        navn: "Already Correct Provider AS", fylke: "Vestland", kommune: "Bergen", kommunenummer: "4601",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      function getProviderRow(id: string): any {
        return expDb.prepare(`SELECT id, fylke FROM experience_providers WHERE id = ?`).get(id);
      }
      function getAuditRows(tableName: string, rowId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM experience_fylke_2024_migration_audit WHERE table_name = ? AND row_id = ? ORDER BY rowid ASC`
        ).all(tableName, rowId);
      }
      function countAllAuditRows(): number {
        return (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_fylke_2024_migration_audit`).get() as any).n;
      }

      // ── (g) auth-gated: missing key -> 403 ───────────────────────────
      const noKeyRes = await callRoute(opplevelserRouter, { body: {} });
      assertEq(noKeyRes.status, 403, "g1: missing X-Admin-Key -> 403");
      const wrongKeyRes = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" }, body: {} });
      assertEq(wrongKeyRes.status, 403, "g2: wrong X-Admin-Key -> 403");

      // ── (a) dry-run reports correct per-table counts ─────────────────
      const dryRes = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, body: {} });
      assertEq(dryRes.status, 200, "a1: dry-run -> 200");
      assertEq(dryRes.body.success, true, "a2: dry-run success:true");
      assertEq(dryRes.body.dry_run, true, "a3: dry-run reports dry_run:true");

      const dryExp = dryRes.body.tables.find((t: any) => t.table === "experiences");
      const dryProv = dryRes.body.tables.find((t: any) => t.table === "experience_providers");
      assertTrue(!!dryExp && !!dryProv, "a4: response includes both table reports");

      assertEq(dryExp.total_candidates, 3, "a5: experiences table has exactly 3 stale-fylke candidates (Viken/TF/VT rows), the already-correct row excluded");
      assertEq(dryExp.resolved, 2, "a6: experiences table: 2 resolved (Bærum -> Akershus, Tromsø -> Troms)");
      assertEq(dryExp.needs_review, 1, "a7: experiences table: 1 needs_review (unknown kommune name)");
      assertEq(dryExp.needs_review_samples.length, 1, "a8: experiences needs_review_samples has exactly 1 entry");
      assertEq(dryExp.needs_review_samples[0].id, eVTUnknown, "a9: the needs_review sample is the unknown-kommune row");
      assertTrue(
        typeof dryExp.needs_review_samples[0].reason === "string" &&
          dryExp.needs_review_samples[0].reason.startsWith("ambiguous_or_unknown_kommune:"),
        "a10: needs_review sample carries the exact reason string"
      );

      assertEq(dryProv.total_candidates, 2, "a11: experience_providers table has exactly 2 stale-fylke candidates, the already-correct row excluded");
      assertEq(dryProv.resolved, 1, "a12: experience_providers table: 1 resolved (kommunenummer 3201 -> Akershus)");
      assertEq(dryProv.needs_review, 1, "a13: experience_providers table: 1 needs_review (unknown kommunenummer)");
      assertEq(dryProv.needs_review_samples[0].id, pTFUnknownNr, "a14: the needs_review sample is the unknown-kommunenummer row");
      assertTrue(
        typeof dryProv.needs_review_samples[0].reason === "string" &&
          dryProv.needs_review_samples[0].reason.startsWith("kommunenummer_not_found:"),
        "a15: needs_review sample carries the exact reason string"
      );

      // ── (b) dry-run performs ZERO writes ──────────────────────────────
      assertEq(getExperienceRow(eViken).fylke, "Viken", "b1: dry-run does not write experiences.fylke");
      assertEq(getProviderRow(pViken).fylke, "Viken", "b2: dry-run does not write experience_providers.fylke");
      assertEq(countAllAuditRows(), 0, "b3: dry-run inserts ZERO audit rows");

      // ── (e) an unrelated fylke value is untouched by the SCAN itself ──
      assertEq(getExperienceRow(eAlreadyCorrect).fylke, "Rogaland", "e0: already-correct experiences row untouched by dry-run");
      assertEq(getProviderRow(pAlreadyCorrect).fylke, "Vestland", "e0b: already-correct provider row untouched by dry-run");

      // ── (c)/(d) apply writes resolved rows + audits, needs_review rows
      //     are never written/audited, unrelated fylke rows untouched ──────
      const applyRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { apply: true, batch_id: "batch-fylke-1" },
      });
      assertEq(applyRes.status, 200, "c1: apply -> 200");
      assertEq(applyRes.body.dry_run, false, "c2: apply reports dry_run:false");

      const applyExp = applyRes.body.tables.find((t: any) => t.table === "experiences");
      const applyProv = applyRes.body.tables.find((t: any) => t.table === "experience_providers");
      assertEq(applyExp.written, 2, "c3: experiences apply writes exactly 2 rows (the resolved ones)");
      assertEq(applyProv.written, 1, "c4: experience_providers apply writes exactly 1 row (the resolved one)");

      assertEq(getExperienceRow(eViken).fylke, "Akershus", "c5: eViken (Bærum) written to Akershus");
      assertEq(getExperienceRow(eTF).fylke, "Troms", "c6: eTF (Tromsø) written to Troms");
      assertEq(getProviderRow(pViken).fylke, "Akershus", "c7: pViken (kommunenummer 3201) written to Akershus");

      // needs_review rows: never written
      assertEq(getExperienceRow(eVTUnknown).fylke, "Vestfold og Telemark", "d1: needs_review experiences row is NEVER written by apply");
      assertEq(getProviderRow(pTFUnknownNr).fylke, "Troms og Finnmark", "d2: needs_review experience_providers row is NEVER written by apply");

      // unrelated fylke rows: untouched by apply too
      assertEq(getExperienceRow(eAlreadyCorrect).fylke, "Rogaland", "e1: already-correct experiences row untouched by apply");
      assertEq(getProviderRow(pAlreadyCorrect).fylke, "Vestland", "e2: already-correct provider row untouched by apply");

      // audit rows: exactly one per WRITE, correct old/new fylke + batch_id
      const auditViken = getAuditRows("experiences", eViken);
      assertEq(auditViken.length, 1, "c8: exactly one audit row for eViken");
      assertEq(auditViken[0].old_fylke, "Viken", "c9: audit old_fylke = 'Viken'");
      assertEq(auditViken[0].new_fylke, "Akershus", "c10: audit new_fylke = 'Akershus'");
      assertEq(auditViken[0].batch_id, "batch-fylke-1", "c11: audit batch_id matches the request body");

      const auditProvViken = getAuditRows("experience_providers", pViken);
      assertEq(auditProvViken.length, 1, "c12: exactly one audit row for pViken");
      assertEq(auditProvViken[0].table_name, "experience_providers", "c13: audit table_name = 'experience_providers'");

      // needs_review rows: NEVER audited
      assertEq(getAuditRows("experiences", eVTUnknown).length, 0, "d3: needs_review experiences row has ZERO audit rows");
      assertEq(getAuditRows("experience_providers", pTFUnknownNr).length, 0, "d4: needs_review experience_providers row has ZERO audit rows");

      assertEq(countAllAuditRows(), 3, "c14: exactly 3 audit rows total across both tables (2 experiences + 1 provider)");

      // Re-running apply again must be idempotent-safe: the two resolved
      // rows are already on their new fylke (no longer matching the stale
      // WHERE clause), so a second apply call must write/audit nothing more
      // for them.
      const secondApplyRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { apply: true, batch_id: "batch-fylke-2" },
      });
      const secondApplyExp = secondApplyRes.body.tables.find((t: any) => t.table === "experiences");
      const secondApplyProv = secondApplyRes.body.tables.find((t: any) => t.table === "experience_providers");
      assertEq(secondApplyExp.total_candidates, 1, "c15: second apply's experiences scan only re-finds the still-stale needs_review row");
      assertEq(secondApplyExp.written, 0, "c16: second apply writes nothing further for experiences (nothing new resolved)");
      assertEq(secondApplyProv.total_candidates, 1, "c17: second apply's providers scan only re-finds the still-stale needs_review row");
      assertEq(secondApplyProv.written, 0, "c18: second apply writes nothing further for providers");
      assertEq(countAllAuditRows(), 3, "c19: no new audit rows from the idempotent second apply call");

      // ── (f) batch-cap is respected ────────────────────────────────────
      // Seed FYLKE_2024_MIGRATION_BATCH_CAP(200) + 5 = 205 extra resolvable
      // 'Viken' experiences rows (Bærum, an unambiguous kommune) in a FRESH
      // provider/DB state, then apply once and assert written is capped at
      // 200, with total_candidates reflecting the true (uncapped) scan size.
      const BATCH_CAP = 200;
      const capProviderId = store.createProvider({
        navn: "Cap Provider AS", fylke: "Akershus", kommune: "Bærum",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const capExperienceIds: string[] = [];
      for (let i = 0; i < BATCH_CAP + 5; i++) {
        capExperienceIds.push(
          store.createExperience({
            title: `Cap-test opplevelse ${i}`, provider_id: capProviderId, provider_match_status: "matched",
            kommune: "Bærum", fylke: "Viken", verification_status: "verified", confidence: "high",
          })
        );
      }
      const capApplyRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { apply: true, batch_id: "batch-fylke-cap" },
      });
      const capApplyExp = capApplyRes.body.tables.find((t: any) => t.table === "experiences");
      // total_candidates includes the earlier still-stale needs_review row
      // (eVTUnknown) PLUS all 205 newly-seeded cap-test rows.
      assertEq(capApplyExp.total_candidates, BATCH_CAP + 5 + 1, "f1: total_candidates reflects the FULL (uncapped) scan size");
      assertEq(capApplyExp.written, BATCH_CAP, "f2: written is capped at the batch-cap (200), even though more rows were resolvable");

      const capWrittenCount = capExperienceIds.filter((id) => getExperienceRow(id).fylke === "Akershus").length;
      assertEq(capWrittenCount, BATCH_CAP, "f3: exactly cap-many cap-test rows were actually written in the DB");
      const capStillStaleCount = capExperienceIds.filter((id) => getExperienceRow(id).fylke === "Viken").length;
      assertEq(capStillStaleCount, 5, "f4: the remaining 5 cap-test rows are left stale, available for a follow-up call");

      // ── (h) needs_review_samples cap (~20/table) ──────────────────────
      // Seed 25 experiences rows, each with a DISTINCT unresolvable kommune
      // name, all under a stale fylke -> needs_review_samples must cap at 20
      // even though needs_review itself counts all 25.
      const sampleCapProviderId = store.createProvider({
        navn: "Sample Cap Provider AS", fylke: "Telemark", kommune: "Skien",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      for (let i = 0; i < 25; i++) {
        store.createExperience({
          title: `Sample-cap opplevelse ${i}`, provider_id: sampleCapProviderId, provider_match_status: "matched",
          kommune: `Ukjent-Kommune-${i}`, fylke: "Vestfold og Telemark", verification_status: "verified", confidence: "high",
        });
      }
      const sampleCapDryRes = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, body: {} });
      const sampleCapExp = sampleCapDryRes.body.tables.find((t: any) => t.table === "experiences");
      // 25 new unresolvable rows + the original eVTUnknown = 26 needs_review.
      assertEq(sampleCapExp.needs_review, 26, "h1: needs_review counts ALL 26 unresolvable rows");
      assertEq(sampleCapExp.needs_review_samples.length, 20, "h2: needs_review_samples is capped at 20, even though needs_review is 26");

      if (log) console.log(`  fylke-2024-migration route tests: ${passed} passed, ${failed} failed`);
    } catch (err) {
      failed++;
      failures.push("opplevelser-admin-fylke-2024-migration: unexpected error: " + String((err as any)?.stack || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  (async () => {
    console.log("── opplevelser-admin-fylke-2024-migration route tests ──");
    const r = await runOpplevelserAdminFylke2024MigrationTests({ log: true });
    console.log(`\nopplevelser-admin-fylke-2024-migration: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  })();
}
