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

import { buildSweepRunEnvelopeClaims, startSweep, getSweepJob } from "./verifier-sweep";
import { buildRunEnvelope } from "../agents/lokal-agent-verifier";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runVerifierSweepClaimsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    newly_verified: 3,
    outreach_pool_added: 2,
    review_required: 22,
    data_insufficient: 0,
    processed: 27,
  });

  // (a) exact kinds, order and values.
  assertEq(
    claims.map((c) => [c.type, c.meta.kind, c.value]),
    [
      ["db_state_change", "agents_verified", 5],
      ["db_state_change", "agents_newly_verified", 3],
      ["db_state_change", "bulk_sweep_review_required", 22],
      ["db_state_change", "bulk_sweep_data_insufficient", 0],
      ["db_state_change", "bulk_sweep_processed", 27],
      ["db_state_change", "outreach_pool_added", 2],
      ["custom", "verifier_slots_verified_fill", 0],
      ["custom", "verifier_slots_verified_recheck", 0],
    ],
    "sweep claims: kinds + per-sweep values",
  );

  // (b) no global snapshot kinds in the sweep envelope.
  const forbidden = ["agents_review_required", "agents_data_insufficient", "agents_pending_verify"];
  for (const k of forbidden) {
    assertEq(claims.some((c) => c.meta.kind === k), false, `sweep claims: no '${k}' kind`);
  }

  // (c) dev-request 2026-11-11 slice A: zero values are still emitted.
  const zero = buildSweepRunEnvelopeClaims({
    verified: 0, newly_verified: 0, outreach_pool_added: 0, review_required: 0, data_insufficient: 0, processed: 0,
  });
  for (const k of ["agents_newly_verified", "outreach_pool_added", "verifier_slots_verified_fill", "verifier_slots_verified_recheck"]) {
    assertEq(zero.find((c) => c.meta.kind === k)?.value, 0, `sweep claims: '${k}' present with 0 on an empty sweep`);
  }

  // (d) newly_verified counts only verified results whose prior status was not
  // verified — the explicit-agentIds path can re-process already-verified rows.
  const results = [
    { agent_id: "a", new_verification_status: "verified", prior_verification_status: "pending_verify", flags: [], outreach_eligible_at: "s" },
    { agent_id: "b", new_verification_status: "verified", prior_verification_status: "verified", flags: [], outreach_eligible_at: null },
    { agent_id: "c", new_verification_status: "review_required", prior_verification_status: "verified", flags: [], outreach_eligible_at: null },
  ];
  const r = startSweep({
    agentIds: ["a", "b", "c"],
    chunkSize: 10,
    // Minimal fake db: countPendingVerify reads {n}; recordRun failures are
    // caught inside the sweep and do not affect the counters under test.
    db: { prepare: () => ({ get: () => ({ n: 0 }), run: () => ({ changes: 0 }), all: () => [] }) },
    brregLookup: null,
    sleep: () => Promise.resolve(),
    runBatch: async () => ({ run_id: "x", started_at: "s", finished_at: "f", results: results as any }),
  });
  assertEq(r.started, true, "sweep counter: started");
  for (let i = 0; i < 1000 && getSweepJob().status === "running"; i++) {
    await new Promise((res) => setImmediate(res));
  }
  const job = getSweepJob();
  assertEq(job.status, "done", "sweep counter: sweep finished");
  assertEq(job.verified, 2, "sweep counter: verified counts re-verified rows too");
  assertEq(job.newly_verified, 1, "sweep counter: newly_verified excludes prior-verified rows");

  // (e) dev-request 2026-11-15-verifier-timelane-ny-verifisering-gap: the
  // sweep's recorded envelope carries outreach_pool_added with the hourly
  // run's rule (outreach_eligible_at stamped by runVerifierBatch) and detail.
  async function runSweepCapture(rows: unknown[]): Promise<any[] | null> {
    let recorded: any[] | null = null;
    const fakeDb = {
      prepare: (sql: string) => ({
        get: () => ({ n: 0 }),
        run: (params: any) => {
          if (/INSERT INTO runs/.test(sql)) recorded = JSON.parse(params.claims);
          return { changes: 1 };
        },
        all: () => [],
      }),
    };
    const started = startSweep({
      agentIds: rows.map((x: any) => x.agent_id),
      chunkSize: 10,
      db: fakeDb,
      brregLookup: null,
      sleep: () => Promise.resolve(),
      runBatch: async () => ({ run_id: "x", started_at: "s", finished_at: "f", results: rows as any }),
    });
    assertEq(started.started, true, "sweep pool: started");
    for (let i = 0; i < 1000 && getSweepJob().status === "running"; i++) {
      await new Promise((res) => setImmediate(res));
    }
    return recorded;
  }
  const HOURLY_DETAIL = "transitioned to verified+(partial|rich)";
  const poolRows = [
    { agent_id: "p1", new_verification_status: "verified", prior_verification_status: "pending_verify", flags: [], outreach_eligible_at: "s" },
    { agent_id: "p2", new_verification_status: "verified", prior_verification_status: "review_required", flags: [], outreach_eligible_at: "s" },
    // newly verified but thin / under the content threshold: not stamped.
    { agent_id: "p3", new_verification_status: "verified", prior_verification_status: "pending_verify", flags: [], outreach_eligible_at: null },
    { agent_id: "p4", new_verification_status: "data_insufficient", prior_verification_status: "pending_verify", flags: [], outreach_eligible_at: null },
  ];
  const poolClaims = await runSweepCapture(poolRows);
  const poolClaim = poolClaims?.find((c: any) => c.meta?.kind === "outreach_pool_added");
  assertEq(getSweepJob().outreach_pool_added, 2, "sweep pool: job counter = 2 stamped rows");
  assertEq(poolClaim, { type: "db_state_change", value: 2, meta: { kind: "outreach_pool_added", detail: HOURLY_DETAIL } },
    "sweep pool: recorded envelope posts outreach_pool_added=2 with the hourly detail");
  // Same rows through the hourly envelope give the same count and claim.
  const hourly: any = buildRunEnvelope({ run_id: "h", started_at: "s", finished_at: "f", results: poolRows as any });
  const hourlyClaim = hourly.claims.find((c: any) => c.meta?.kind === "outreach_pool_added");
  assertEq(hourlyClaim, poolClaim, "sweep pool: identical to the hourly run's claim for the same rows");

  // (f) re-verifications / non-qualifying transitions only: claim still
  // emitted with 0, as the hourly run does.
  const reRows = [
    { agent_id: "r1", new_verification_status: "verified", prior_verification_status: "verified", flags: [], outreach_eligible_at: null },
    { agent_id: "r2", new_verification_status: "review_required", prior_verification_status: "pending_verify", flags: [], outreach_eligible_at: null },
  ];
  const reClaims = await runSweepCapture(reRows);
  assertEq(reClaims?.find((c: any) => c.meta?.kind === "outreach_pool_added"),
    { type: "db_state_change", value: 0, meta: { kind: "outreach_pool_added", detail: HOURLY_DETAIL } },
    "sweep pool: re-verifications only -> outreach_pool_added present with 0");
  const hourlyRe: any = buildRunEnvelope({ run_id: "h2", started_at: "s", finished_at: "f", results: reRows as any });
  assertEq(hourlyRe.claims.find((c: any) => c.meta?.kind === "outreach_pool_added")?.value, 0,
    "hourly: outreach_pool_added=0 for re-verifications only (convention unchanged)");

  return { passed, failed, failures };
}

if (require.main === module) {
  runVerifierSweepClaimsTests({ log: true }).then((r) => {
    console.log(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    if (r.failed > 0) process.exit(1);
  });
}
