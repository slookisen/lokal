/**
 * experience-scope.test.ts — pure, DB-backed-but-network-free unit coverage
 * of providerInScopeSql() (services/experience-scope.ts) against a minimal
 * in-memory DB holding ONLY the columns its SQL touches
 * (experience_providers.id/producer_type/rfb_seed_source,
 * experiences.id/provider_id/category) — no db-factory, no getDb().
 *
 * REGRESSION this pins (2026-09-28 fleet audit): providerInScopeSql()'s
 * correlated EXISTS subquery over `experiences e_scope` was handed a bare
 * "id" by both org.nr enrichment services (and "id" was its own default).
 * SQLite resolves an unqualified column against the INNERMOST scope first,
 * and `experiences` has its own `id`, so the correlation silently became
 * `e_scope.provider_id = e_scope.id` — the "has a mat_drikke experience"
 * leg of the scope rule (dev-request 2026-09-18-opplevagent-skop-katalogen-
 * til-gardssalg-og-drikke, lokal PR #880) was always FALSE, and a provider
 * in scope ONLY via a mat_drikke experience was never selected.
 * `experiences.id` is therefore deliberately PART of this fixture: without
 * it a bare "id" would resolve outward and es1-es3 would pass on the buggy
 * code too (es5 pins that the fixture still reproduces the trap).
 *
 * Route-level, end-to-end coverage of the same leg through the two real
 * call sites lives in section (r) of
 * routes/opplevelser-experience-orgnr-from-website.test.ts and
 * routes/opplevelser-experience-orgnr-from-name-kommune.test.ts (their
 * candidate SELECTs read getDb("experiences"), which has no seam for a
 * hand-built DB like this one — so they run against the real in-memory
 * schema instead).
 *
 * Run standalone: npx tsx src/services/experience-scope.test.ts
 */

import Database from "better-sqlite3";
import { experienceInScopeSql, providerInScopeSql } from "./experience-scope";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceScopeTests(
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

  return (async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE experience_providers (
        id TEXT PRIMARY KEY,
        producer_type TEXT,
        rfb_seed_source TEXT
      );
      CREATE TABLE experiences (
        id TEXT PRIMARY KEY,
        provider_id TEXT,
        category TEXT
      );
    `);

    const insertProvider = db.prepare(
      `INSERT INTO experience_providers (id, producer_type, rfb_seed_source) VALUES (?, ?, ?)`,
    );
    const insertExperience = db.prepare(`INSERT INTO experiences (id, provider_id, category) VALUES (?, ?, ?)`);

    // (a) no cohort fields — in scope ONLY via one mat_drikke experience,
    //     plain and composite category forms.
    insertProvider.run("prov-a-mat", null, null);
    insertExperience.run("exp-a-mat", "prov-a-mat", "mat_drikke");
    insertProvider.run("prov-a-composite", null, null);
    insertExperience.run("exp-a-composite", "prov-a-composite", "kultur_historie, mat_drikke");
    // (b) no cohort fields and no mat_drikke experience — one with only a
    //     non-mat_drikke experience, one with no experiences at all. Also
    //     the over-selection guard: another provider's mat_drikke experience
    //     must never pull these in (a correlation that stopped correlating
    //     would select everyone).
    insertProvider.run("prov-b-kultur", null, null);
    insertExperience.run("exp-b-kultur", "prov-b-kultur", "kultur_historie");
    insertProvider.run("prov-b-none", null, null);
    // (c) gårdssalg cohort — either cohort field alone is enough, with or
    //     without any experience.
    insertProvider.run("prov-c-producer", "bryggeri", null);
    insertExperience.run("exp-c-producer", "prov-c-producer", "kultur_historie");
    insertProvider.run("prov-c-seed", null, "rfb-seed");

    const IN_SCOPE = ["prov-a-composite", "prov-a-mat", "prov-c-producer", "prov-c-seed"];
    const OUT_OF_SCOPE = ["prov-b-kultur", "prov-b-none"];

    const ids = (sql: string): string[] => (db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);
    // Both org.nr services' own query shape: FROM experience_providers,
    // unaliased — `AND <fragment>` for candidates/eligible, `AND NOT
    // (<fragment>)` for skipped_out_of_scope/out_of_scope.
    const inScope = (fragment: string) => ids(`SELECT id FROM experience_providers WHERE ${fragment} ORDER BY id`);
    const outOfScope = (fragment: string) =>
      ids(`SELECT id FROM experience_providers WHERE NOT (${fragment}) ORDER BY id`);

    try {
      // es1-es2: the DEFAULT idCol — what a future caller gets for free.
      assertEq(
        inScope(providerInScopeSql()),
        IN_SCOPE,
        "es1: default idCol — (a) mat_drikke-only providers (plain + composite category) and (c) cohort providers are in scope",
      );
      assertEq(
        outOfScope(providerInScopeSql()),
        OUT_OF_SCOPE,
        "es2: default idCol — NOT(...) is the exact complement: only (b), no provider lost to a NULL, no mat_drikke-only provider miscounted as out of scope",
      );

      // es3: the exact argument both org.nr call sites pass.
      assertEq(
        inScope(providerInScopeSql("experience_providers.id")),
        IN_SCOPE,
        'es3: "experience_providers.id" (the two org.nr call sites) — same in-scope set as es1',
      );

      // es4: an aliased outer query passing its own alias-qualified id.
      assertEq(
        ids(`SELECT p.id AS id FROM experience_providers p WHERE ${providerInScopeSql("p.id")} ORDER BY p.id`),
        IN_SCOPE,
        'es4: aliased outer query + "p.id" — same in-scope set as es1',
      );

      // es5: the trap itself — the bare "id" both call sites passed until
      // 2026-09-28 binds to e_scope.id, so only the cohort leg survives and
      // (a) silently disappears. Pinned so this fixture keeps reproducing
      // the bug (see file header): if it ever stops, es1-es3 no longer
      // prove anything.
      assertEq(
        inScope(providerInScopeSql("id")),
        ["prov-c-producer", "prov-c-seed"],
        'es5: bare "id" (the pre-fix call-site argument) binds to experiences.id — the mat_drikke leg is dead, (a) is missed',
      );

      // es6: an aliased outer query that forgets to pass its alias fails
      // LOUDLY with the qualified default, instead of silently re-binding.
      let aliasedDefaultError: string | null = null;
      try {
        db.prepare(`SELECT p.id FROM experience_providers p WHERE ${providerInScopeSql()}`).all();
      } catch (err) {
        aliasedDefaultError = err instanceof Error ? err.message : String(err);
      }
      assertEq(
        aliasedDefaultError !== null && aliasedDefaultError.includes("no such column"),
        true,
        `es6: aliased outer query + default idCol throws "no such column" rather than silently mis-correlating (got ${JSON.stringify(aliasedDefaultError)})`,
      );

      // es7-es8: sibling helper experienceInScopeSql(), in the judge sweep's
      // two call shapes (routes/opplevelser.ts SWEEP_IN_SCOPE_WHERE /
      // SWEEP_IN_SCOPE_WHERE_ALIASED) — audited 2026-09-28 for the same
      // trap and NOT affected: its correlation column is the outer FK
      // (provider_id), which the subquery's own table (experience_providers)
      // does not have, so even the unaliased form resolves outward.
      const EXPERIENCES_IN_SCOPE = ["exp-a-composite", "exp-a-mat", "exp-c-producer"];
      assertEq(
        ids(`SELECT id FROM experiences WHERE ${experienceInScopeSql("category", "provider_id")} ORDER BY id`),
        EXPERIENCES_IN_SCOPE,
        'es7: experienceInScopeSql("category", "provider_id") over unaliased experiences — cohort leg AND category leg both live',
      );
      assertEq(
        ids(
          `SELECT e.id AS id FROM experiences e LEFT JOIN experience_providers p ON p.id = e.provider_id
            WHERE ${experienceInScopeSql("e.category", "e.provider_id")} ORDER BY e.id`,
        ),
        EXPERIENCES_IN_SCOPE,
        'es8: experienceInScopeSql("e.category", "e.provider_id") over the sweep\'s aliased LEFT JOIN — same set as es7',
      );
    } finally {
      db.close();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperienceScopeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
