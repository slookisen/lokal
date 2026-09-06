/**
 * init-dental.test.ts — dev-request 2026-09-02-dental-profilkvalitet-finn-
 * tannlege (5c): the two one-time backfills wired into initDentalSchema()
 * itself (NOT a manual admin endpoint), so they run automatically on every
 * deploy/schema-init:
 *
 *   (a) is_chain_member backfill: `UPDATE dental_agents SET
 *       is_chain_member = 1 WHERE chain_brand IS NOT NULL AND chain_brand
 *       <> ''`. Simulates a "legacy" row (chain_brand set, is_chain_member
 *       still the pre-fix 0) that predates this dev-request, then re-runs
 *       initDentalSchema() against the ALREADY-populated DB (as a redeploy
 *       would) and asserts the row gets fixed. Also checks idempotency (a
 *       second re-run doesn't error or change anything further).
 *
 *   (b) available_specialties bulk backfill: re-derives available_specialties
 *       from dental_clinic_affiliations for every catalog-class-eligible
 *       clinic that has an active, specialty-bearing affiliation but an
 *       still-empty available_specialties (the incremental
 *       recomputeAvailableSpecialties() wiring in dental-store.ts only ever
 *       ran for affiliations created AFTER that wiring existed). Also checks
 *       that a non-clinic-class row (catalog_class='holding') is NOT
 *       backfilled even with a qualifying affiliation, and that a clinic
 *       whose available_specialties is already non-empty is left untouched
 *       (never clobbers a value the incremental path already computed).
 *
 * Deliberately drives initDentalSchema() directly against an already-open
 * handle (not just via db-factory.getDb(), which only runs it once and
 * caches) so the "re-run on redeploy" scenario is actually exercised, and so
 * this test also proves the reentrancy concern the code comment describes
 * (calling dental-store.ts's recomputeAvailableSpecialties() — which itself
 * calls getDb("dental") — from inside schema-init would recurse) never
 * fires: initDentalSchema() completes without ever touching db-factory.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runInitDentalBackfillTests(
  opts: { log?: boolean } = {}
): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";

  const dbFactoryPath = require.resolve("./db-factory");
  const initDentalPath = require.resolve("./init-dental");
  const cachePaths = [dbFactoryPath, initDentalPath];
  for (const p of cachePaths) delete require.cache[p];

  try {
    const dbFactory = require("./db-factory") as typeof import("./db-factory");
    dbFactory.__resetDbFactoryForTesting();
    // First open runs initDentalSchema() once against an EMPTY db — both
    // backfills below are no-ops here (nothing to touch yet).
    const db = dbFactory.getDb("dental");
    const { initDentalSchema } = require("./init-dental") as typeof import("./init-dental");

    // ── Seed LEGACY-shaped data directly (bypassing dental-store.ts, which
    // would already do the right thing on a fresh write — the whole point
    // here is data that predates this dev-request) ──────────────────────
    db.prepare(
      "INSERT INTO dental_agents (id, navn, catalog_class, chain_brand, is_chain_member) VALUES (?, ?, 'klinikk', ?, 0)"
    ).run("legacy-chain-1", "Legacy Kjede Klinikk AS", "Volvat");

    db.prepare(
      "INSERT INTO dental_agents (id, navn, catalog_class) VALUES (?, ?, 'klinikk')"
    ).run("legacy-spec-1", "Legacy Spesialist Klinikk AS");
    db.prepare(
      "INSERT INTO dental_agents (id, navn, catalog_class, available_specialties) VALUES (?, ?, 'klinikk', ?)"
    ).run("legacy-spec-already-filled", "Allerede Utfylt Klinikk AS", JSON.stringify(["endodonti"]));
    db.prepare(
      "INSERT INTO dental_agents (id, navn, catalog_class) VALUES (?, ?, 'holding')"
    ).run("legacy-holding-1", "Legacy Holding AS");

    db.prepare("INSERT INTO dental_persons (id, navn) VALUES (?, ?)").run("legacy-person-1", "Kari Nordmann");
    db.prepare(
      "INSERT INTO dental_clinic_affiliations (id, person_id, clinic_agent_id, specialty_used_here, is_active) VALUES (?, ?, ?, ?, 1)"
    ).run("legacy-aff-1", "legacy-person-1", "legacy-spec-1", "periodonti");
    db.prepare(
      "INSERT INTO dental_clinic_affiliations (id, person_id, clinic_agent_id, specialty_used_here, is_active) VALUES (?, ?, ?, ?, 1)"
    ).run("legacy-aff-already-filled", "legacy-person-1", "legacy-spec-already-filled", "kjeveortopedi");
    db.prepare(
      "INSERT INTO dental_clinic_affiliations (id, person_id, clinic_agent_id, specialty_used_here, is_active) VALUES (?, ?, ?, ?, 1)"
    ).run("legacy-aff-holding", "legacy-person-1", "legacy-holding-1", "endodonti");

    // ── Simulate a redeploy: schema-init runs again against already-populated data ──
    initDentalSchema(db);

    const chainRow = db.prepare("SELECT is_chain_member FROM dental_agents WHERE id = ?").get("legacy-chain-1") as any;
    assertEq(chainRow.is_chain_member, 1, "is_chain_member backfill: legacy chain_brand row is fixed to 1 on schema re-init");

    const specRow = db.prepare("SELECT available_specialties FROM dental_agents WHERE id = ?").get("legacy-spec-1") as any;
    assertEq(
      JSON.parse(specRow.available_specialties ?? "null"),
      ["periodonti"],
      "available_specialties bulk backfill: legacy clinic-class row with a specialty affiliation gets it filled in"
    );

    const alreadyFilledRow = db.prepare(
      "SELECT available_specialties FROM dental_agents WHERE id = ?"
    ).get("legacy-spec-already-filled") as any;
    assertEq(
      JSON.parse(alreadyFilledRow.available_specialties),
      ["endodonti"],
      "available_specialties bulk backfill: a row whose value is already non-empty is left untouched (not overwritten with the affiliation's 'kjeveortopedi')"
    );

    const holdingRow = db.prepare("SELECT available_specialties FROM dental_agents WHERE id = ?").get("legacy-holding-1") as any;
    assertEq(
      holdingRow.available_specialties,
      null,
      "available_specialties bulk backfill: a non-clinic-class (holding) row is NOT backfilled even though it has a qualifying affiliation"
    );

    // ── Idempotency: a second re-run changes nothing further and doesn't error ──
    initDentalSchema(db);
    const chainRow2 = db.prepare("SELECT is_chain_member FROM dental_agents WHERE id = ?").get("legacy-chain-1") as any;
    assertEq(chainRow2.is_chain_member, 1, "is_chain_member backfill is idempotent across repeated schema-init runs");
    const specRow2 = db.prepare("SELECT available_specialties FROM dental_agents WHERE id = ?").get("legacy-spec-1") as any;
    assertEq(
      JSON.parse(specRow2.available_specialties),
      ["periodonti"],
      "available_specialties bulk backfill is idempotent across repeated schema-init runs"
    );
  } catch (err: any) {
    failed++;
    failures.push("init-dental backfills (5c): unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      const dbFactory = require("./db-factory") as typeof import("./db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runInitDentalBackfillTests({ log: true });
  console.log(`\ninit-dental backfills (5c): ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed > 0 ? 1 : 0);
}
