/**
 * mapbox-budget.test.ts — Daniel, 2026-07-26:
 *   «ja, bygg månedstaket.»
 *
 * Context that shapes these tests: the session told Daniel to set a spending
 * cap in the Mapbox console and he came back with «jeg fant ingen måte å sette
 * pristak under billing». There is none — Mapbox offers usage ALERTS, not a
 * ceiling. So this module IS the guarantee, and a test suite that merely
 * exercises the happy path would leave that guarantee unproven.
 *
 *   mb1-mb6    the counter itself: persistence, the month boundary, and the
 *              refusal to increment past the cap
 *   mb7-mb11   cap resolution from the environment, including the one failure
 *              mode that costs money — a malformed cap must never mean
 *              "unlimited"
 *   mb12-mb18  cappedProvider: degrade, do not fail; cache misses only; and
 *              the capped straight line is DISTINGUISHABLE from the
 *              never-configured one
 *
 * MUTATION-TESTED — the mutant list and kill results are in the PR body.
 *
 * Exported runMapboxBudgetTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/mapbox-budget.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runMapboxBudgetTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      actual === expected,
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const prevCap = process.env.MAPBOX_MONTHLY_CALL_CAP;
    const db = new Database(":memory:");

    const budget = require("./mapbox-budget") as typeof import("./mapbox-budget");
    const corridor = require("./route-corridor-service") as typeof import("./route-corridor-service");

    // Fixed instants. Date.now() is never consulted by the code under test —
    // `now` is a parameter — so these tests cannot drift with the wall clock,
    // and the month-boundary case below is reachable at all.
    const JULY = Date.parse("2026-07-15T12:00:00Z");
    const AUGUST = Date.parse("2026-08-01T00:00:01Z");
    // A month no test has touched, so the kill-switch assertion below can
    // observe "no row was created" rather than "the row was already there".
    const SEPTEMBER = Date.parse("2026-09-10T09:00:00Z");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      budget.__resetMapboxBudgetSchemaForTesting();

      // ═══════════════════════════════════════════════════════════════
      // mb1-mb6 — the counter
      // ═══════════════════════════════════════════════════════════════
      process.env.MAPBOX_MONTHLY_CALL_CAP = "3";

      assertEq(budget.monthKey(JULY), "2026-07", "mb1: month key is the UTC calendar month");
      assertEq(budget.mapboxBudgetState(JULY).used, 0, "mb2: a fresh month starts at zero");

      assertEq(budget.tryConsumeMapboxCall(JULY), true, "mb3: the first call is granted");
      budget.tryConsumeMapboxCall(JULY);
      budget.tryConsumeMapboxCall(JULY);
      assertEq(budget.mapboxBudgetState(JULY).used, 3, "mb4: …and each grant is counted");
      assertEq(budget.tryConsumeMapboxCall(JULY), false,
        "mb5: the call that would exceed the cap is REFUSED — this is the whole point of the module");
      assertEq(budget.mapboxBudgetState(JULY).used, 3,
        "mb5b: …and refusing does not increment, so `used` stays a truthful record of requests issued");

      // The month boundary. Without this the cap would be a lifetime limit.
      assertEq(budget.tryConsumeMapboxCall(AUGUST), true,
        "mb6: a new UTC month starts a fresh allowance");
      assertEq(budget.mapboxBudgetState(JULY).used, 3,
        "mb6b: …without disturbing July's record");

      // ═══════════════════════════════════════════════════════════════
      // mb7-mb11 — cap resolution. The failure mode here is money.
      // ═══════════════════════════════════════════════════════════════
      assertEq(budget.resolveMapboxMonthlyCap({ MAPBOX_MONTHLY_CALL_CAP: "500" } as any), 500,
        "mb7: an explicit cap is honoured");
      assertEq(budget.resolveMapboxMonthlyCap({} as any), budget.MAPBOX_MONTHLY_CAP_DEFAULT,
        "mb8: an unset cap falls back to the default, not to unlimited");
      assertEq(budget.resolveMapboxMonthlyCap({ MAPBOX_MONTHLY_CALL_CAP: "  " } as any),
        budget.MAPBOX_MONTHLY_CAP_DEFAULT, "mb9: …and so does a blank one");
      assertEq(budget.resolveMapboxMonthlyCap({ MAPBOX_MONTHLY_CALL_CAP: "tolv" } as any),
        budget.MAPBOX_MONTHLY_CAP_DEFAULT,
        "mb10: a MALFORMED cap must never be read as unlimited — the one failure mode that costs money");
      assertEq(budget.resolveMapboxMonthlyCap({ MAPBOX_MONTHLY_CALL_CAP: "-5" } as any),
        budget.MAPBOX_MONTHLY_CAP_DEFAULT, "mb11: …nor a negative one");

      // A cap of exactly zero is a deliberate kill switch, not a malformed
      // value, so it is honoured: no calls at all.
      process.env.MAPBOX_MONTHLY_CALL_CAP = "0";
      assertEq(budget.tryConsumeMapboxCall(SEPTEMBER), false,
        "mb11b: cap = 0 is an honoured kill switch — routing degrades, nothing is spent");
      // The early-out is not merely redundant with `WHERE calls < 0`: it also
      // means a kill-switched deployment stops touching the database at all.
      // SEPTEMBER is used because it has no row yet — asserting against a month
      // that already had one would pass whether or not the guard exists, which
      // is exactly how the first version of this assertion let a mutant live.
      assertEq(
        (db.prepare(`SELECT COUNT(*) AS c FROM mapbox_monthly_usage WHERE month = ?`).get("2026-09") as any).c,
        0,
        "mb11c: …and with the switch off it does not even create the month's row — no work at all");

      // ═══════════════════════════════════════════════════════════════
      // mb12-mb18 — cappedProvider: degrade, never fail
      // ═══════════════════════════════════════════════════════════════
      {
        let primaryCalls = 0;
        const primary = {
          id: "mapbox",
          kind: "road" as const,
          async fetchRoute() {
            primaryCalls++;
            return {
              polyline: [{ lat: 59.9, lng: 10.7 }, { lat: 67.2, lng: 14.4 }],
              distanceKm: 1194.7,
              durationMinutes: 987,
              provider: "mapbox",
              kind: "road" as const,
            };
          },
        };

        let allowance = 2;
        const consume = () => (allowance-- > 0);
        const capped = corridor.cappedProvider(primary as any, consume);

        const a = await capped.fetchRoute({ lat: 59.9, lng: 10.7 }, { lat: 67.2, lng: 14.4 });
        assertEq(a.kind, "road", "mb12: inside the allowance the real provider answers");
        assertEq(a.provider, "mapbox", "mb12b: …and says so");
        await capped.fetchRoute({ lat: 59.9, lng: 10.7 }, { lat: 67.2, lng: 14.4 });
        assertEq(primaryCalls, 2, "mb13: …once per call");

        // Third call: allowance gone.
        const c = await capped.fetchRoute({ lat: 59.9, lng: 10.7 }, { lat: 67.2, lng: 14.4 });
        assertEq(primaryCalls, 2,
          "mb14: past the cap the metered provider is NOT called — no request, no charge");
        assertEq(c.kind, "straight_line",
          "mb15: …and the caller still gets an answer, degraded rather than failed");
        assertEq(c.provider, corridor.CAPPED_STRAIGHT_LINE_PROVIDER,
          "mb16: …tagged so 'allowance used up' is distinguishable from 'never configured'");
        assertTrue(c.polyline.length >= 2, "mb17: …with a usable polyline, so ordering still works");

        // The tag must NOT be the plain straight-line provider's id, or the
        // note cannot tell the two situations apart.
        const plain = await corridor.straightLineProvider().fetchRoute(
          { lat: 59.9, lng: 10.7 }, { lat: 67.2, lng: 14.4 });
        assertTrue(plain.provider !== corridor.CAPPED_STRAIGHT_LINE_PROVIDER,
          "mb18: the never-configured straight line carries a DIFFERENT tag");
      }
    } finally {
      if (prevCap === undefined) delete process.env.MAPBOX_MONTHLY_CALL_CAP;
      else process.env.MAPBOX_MONTHLY_CALL_CAP = prevCap;
      budget.__resetMapboxBudgetSchemaForTesting();
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runMapboxBudgetTests({ log: true }).then((s) => {
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
