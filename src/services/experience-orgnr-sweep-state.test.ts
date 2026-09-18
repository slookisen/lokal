/**
 * experience-orgnr-sweep-state.test.ts — pure, DB-backed-but-network-free
 * unit coverage of getExperienceOrgnrSweepAfter/setExperienceOrgnrSweepAfter
 * (dev-request 2026-09-14-opplevagent-karantene-utgang-brreg-krav, FUNN
 * "orgnr-fra-webside-og-navn-kommune-mangler-cron-kobling-og-persistert-
 * cursor") against a minimal in-memory DB holding only their own table
 * (experience_orgnr_sweep_state) — no experience_providers needed, since
 * these two functions never touch it. Mirrors section (ee) of
 * gardssalg-website-verification.test.ts (the reference offset-persistence
 * helper's own pure unit coverage), adapted from an integer offset to a
 * nullable TEXT keyset cursor.
 *
 * Route-level, end-to-end coverage through the real POST
 * .../experiences-orgnr-from-website and POST
 * .../experiences-orgnr-from-name-kommune endpoints lives in
 * routes/opplevelser-experience-orgnr-from-website.test.ts and
 * routes/opplevelser-experience-orgnr-from-name-kommune.test.ts respectively
 * — this file is the narrower, HTTP-free complement.
 *
 * Run standalone: npx tsx src/services/experience-orgnr-sweep-state.test.ts
 */

import Database from "better-sqlite3";
import {
  getExperienceOrgnrSweepAfter,
  setExperienceOrgnrSweepAfter,
} from "./experience-orgnr-sweep-state";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceOrgnrSweepStateTests(
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
      CREATE TABLE experience_orgnr_sweep_state (
        route TEXT PRIMARY KEY,
        next_after TEXT,
        updated_at TEXT
      )
    `);

    try {
      // eoss1: absence of a row (fresh DB, never swept via the omitted-`after`
      // path) reads as undefined — "resume from the start", not an
      // error/throw.
      assertEq(
        getExperienceOrgnrSweepAfter(db, "orgnr_from_website"),
        undefined,
        "eoss1: absence of a row reads as undefined (resume from the start)",
      );

      // eoss2-3: a set is immediately visible to a get (INSERT branch), and a
      // second set for the SAME route overwrites, not duplicates (UPDATE
      // branch of the ON CONFLICT upsert).
      setExperienceOrgnrSweepAfter(db, "orgnr_from_website", "prov-0012");
      assertEq(
        getExperienceOrgnrSweepAfter(db, "orgnr_from_website"),
        "prov-0012",
        "eoss2: a set is immediately visible to a get — first-write-ever path",
      );
      setExperienceOrgnrSweepAfter(db, "orgnr_from_website", "prov-0024");
      assertEq(
        getExperienceOrgnrSweepAfter(db, "orgnr_from_website"),
        "prov-0024",
        "eoss3: a second set for the SAME route overwrites (not duplicates)",
      );
      assertEq(
        db.prepare(`SELECT COUNT(*) AS n FROM experience_orgnr_sweep_state`).get(),
        { n: 1 },
        "eoss4: still exactly one row for 'orgnr_from_website' — eoss2/eoss3 upserted the same PRIMARY KEY",
      );

      // eoss5-6: routes are independent — writing 'orgnr_from_name_kommune'
      // never disturbs the already-set 'orgnr_from_website' row, and a route
      // never explicitly set still reads as undefined (same as eoss1).
      setExperienceOrgnrSweepAfter(db, "orgnr_from_name_kommune", "prov-0036");
      assertEq(
        getExperienceOrgnrSweepAfter(db, "orgnr_from_name_kommune"),
        "prov-0036",
        "eoss5: a different route key gets its own independent value",
      );
      assertEq(
        getExperienceOrgnrSweepAfter(db, "orgnr_from_website"),
        "prov-0024",
        "eoss5b: ...and does not disturb 'orgnr_from_website's own value",
      );

      // eoss7: wrap — passing `null` (the exact shape a tick's own
      // `next_after` uses once the backlog is exhausted) persists NULL, not
      // left at the previous value and not coerced to a string "null" — the
      // contract that makes the NEXT omitted-`after` call start a fresh pass
      // instead of getting permanently stuck.
      setExperienceOrgnrSweepAfter(db, "orgnr_from_website", null);
      assertEq(
        getExperienceOrgnrSweepAfter(db, "orgnr_from_website"),
        undefined,
        "eoss7: setting next_after=null (backlog exhausted) persists as NULL, read back as undefined — ready for a fresh pass",
      );
      assertEq(
        getExperienceOrgnrSweepAfter(db, "orgnr_from_name_kommune"),
        "prov-0036",
        "eoss7b: ...and the sibling route's own cursor is untouched",
      );
    } finally {
      db.close();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperienceOrgnrSweepStateTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
