/**
 * verifier-sweep-claims.test.ts — dev-request
 * 2026-10-26-lokal-agent-verifier-snapshot-drift-toleranse, slice 2.
 *
 * The bulk pending_verify sweep's run-envelope must post its per-sweep tallies
 * under its own `bulk_sweep_*` kinds, never under the global snapshot kinds
 * that platform-verifier probes DB-wide (mode=snapshot).
 *
 * Exported runVerifierSweepClaimsTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/verifier-sweep-claims.test.ts
 */

import { buildSweepRunEnvelopeClaims } from "./verifier-sweep";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runVerifierSweepClaimsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }

  const claims = buildSweepRunEnvelopeClaims({
    verified: 5,
    review_required: 22,
    data_insufficient: 0,
    processed: 27,
  });

  // (a) exact kinds, order and values.
  assertEq(
    claims.map((c) => [c.type, c.meta.kind, c.value]),
    [
      ["db_state_change", "agents_verified", 5],
      ["db_state_change", "bulk_sweep_review_required", 22],
      ["db_state_change", "bulk_sweep_data_insufficient", 0],
      ["db_state_change", "bulk_sweep_processed", 27],
    ],
    "sweep claims: kinds + per-sweep values",
  );

  // (b) no global snapshot kinds in the sweep envelope.
  const forbidden = ["agents_review_required", "agents_data_insufficient", "agents_pending_verify"];
  for (const k of forbidden) {
    assertEq(claims.some((c) => c.meta.kind === k), false, `sweep claims: no '${k}' kind`);
  }

  return Promise.resolve({ passed, failed, failures });
}

if (require.main === module) {
  runVerifierSweepClaimsTests({ log: true }).then((r) => {
    console.log(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    if (r.failed > 0) process.exit(1);
  });
}
