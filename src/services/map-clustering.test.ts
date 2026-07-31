/**
 * map-clustering.test.ts — unit tests for services/map-clustering.ts
 * (dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg, arbeidspunkt 6).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/map-clustering.test.ts
 *   2. Wired into the gate: tests/test.ts imports runMapClusteringTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import { clusterMapPoints, MIN_CLUSTER_SIZE, type ClusterPoint } from "./map-clustering";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runMapClusteringTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── Dense set: 5 points all within a few hundred metres of one another
  // (a realistic "Oslo sentrum" spread) must collapse into ONE cluster ──
  {
    const oslo: ClusterPoint[] = [
      { lat: 59.9139, lon: 10.7522, approx: false },
      { lat: 59.9141, lon: 10.7530, approx: false },
      { lat: 59.9135, lon: 10.7518, approx: false },
      { lat: 59.9144, lon: 10.7509, approx: false },
      { lat: 59.9130, lon: 10.7540, approx: false },
    ];
    const groups = clusterMapPoints(oslo);
    assertEq(groups.length, 1, "dense-01: 5 tightly-packed points collapse into exactly 1 group");
    assertEq(groups[0]?.members.length, 5, "dense-02: the single group contains all 5 points");
    assertTrue(groups[0]!.members.length >= MIN_CLUSTER_SIZE, "dense-03: the group meets the real-cluster size threshold");
  }

  // ── Sparse set: points in different Norwegian cities, far apart, must
  // NEVER collapse into one giant cluster — each stays its own group ──
  {
    const farApart: ClusterPoint[] = [
      { lat: 59.9139, lon: 10.7522, approx: false }, // Oslo
      { lat: 60.3913, lon: 5.3221, approx: false },  // Bergen
      { lat: 63.4305, lon: 10.3951, approx: false }, // Trondheim
      { lat: 69.6492, lon: 18.9553, approx: false }, // Tromsø
    ];
    const groups = clusterMapPoints(farApart);
    assertEq(groups.length, 4, "sparse-01: 4 far-apart points stay as 4 separate groups");
    assertTrue(
      groups.every((g) => g.members.length === 1),
      "sparse-02: every group is a plain singleton (no giant cluster forms)"
    );
  }

  // ── Mixed density: a dense cluster of 3 in Oslo PLUS a lone point in
  // Bergen — the dense set clusters, the lone far point does not ──
  {
    const mixed: ClusterPoint[] = [
      { lat: 59.9139, lon: 10.7522, approx: false },
      { lat: 59.9141, lon: 10.7526, approx: false },
      { lat: 59.9136, lon: 10.7519, approx: false },
      { lat: 60.3913, lon: 5.3221, approx: false },
    ];
    const groups = clusterMapPoints(mixed);
    assertEq(groups.length, 2, "mixed-01: 2 groups total (1 real cluster + 1 singleton)");
    const sizes = groups.map((g) => g.members.length).sort((a, b) => a - b);
    assertEq(JSON.stringify(sizes), JSON.stringify([1, 3]), "mixed-02: group sizes are exactly [1 singleton, 3-point cluster]");
  }

  // ── Precision-honesty invariant: an approximate (kommune-centroid) point
  // and an exact (real-address) point that happen to sit at the SAME
  // coordinates must NEVER be merged into one cluster — requirement 3 ──
  {
    const samePlace: ClusterPoint[] = [
      { lat: 59.9139, lon: 10.7522, approx: false },
      { lat: 59.9139, lon: 10.7522, approx: true },
    ];
    const groups = clusterMapPoints(samePlace);
    assertEq(groups.length, 2, "honesty-01: an exact and an approx point at the IDENTICAL coordinate stay in 2 separate groups");
    assertTrue(
      groups.every((g) => g.members.length === 1),
      "honesty-02: neither group is a false 'cluster' — both are honest singletons"
    );
    assertTrue(groups.some((g) => g.approx === true) && groups.some((g) => g.approx === false),
      "honesty-03: one group is flagged approx:true, the other approx:false — never blended");
  }

  // ── Precision-honesty invariant, dense case: a tight cluster of 4 approx
  // points and a tight cluster of 4 exact points at the SAME location must
  // form TWO clusters (one all-approx, one all-exact), never one mixed
  // cluster of 8 — a mixed cluster would imply the approx points are as
  // precise as the exact ones. ──
  {
    const denseMixedPrecision: ClusterPoint[] = [
      { lat: 59.9139, lon: 10.7522, approx: false },
      { lat: 59.9140, lon: 10.7523, approx: false },
      { lat: 59.9138, lon: 10.7521, approx: false },
      { lat: 59.9141, lon: 10.7520, approx: false },
      { lat: 59.9139, lon: 10.7522, approx: true },
      { lat: 59.9140, lon: 10.7523, approx: true },
      { lat: 59.9138, lon: 10.7521, approx: true },
      { lat: 59.9141, lon: 10.7520, approx: true },
    ];
    const groups = clusterMapPoints(denseMixedPrecision);
    assertEq(groups.length, 2, "honesty-04: 8 co-located points (4 exact + 4 approx) form exactly 2 clusters, never 1");
    const exactGroup = groups.find((g) => g.approx === false);
    const approxGroup = groups.find((g) => g.approx === true);
    assertEq(exactGroup?.members.length, 4, "honesty-05: the exact-precision cluster has exactly its 4 exact members");
    assertEq(approxGroup?.members.length, 4, "honesty-06: the approx-precision cluster has exactly its 4 approx members");
    assertTrue(
      !!exactGroup && exactGroup.members.every((m) => m.approx === false),
      "honesty-07: the exact cluster's members are ALL approx:false — no approx point leaked in"
    );
    assertTrue(
      !!approxGroup && approxGroup.members.every((m) => m.approx === true),
      "honesty-08: the approx cluster's members are ALL approx:true — no exact point leaked in"
    );
  }

  // ── Empty input -> empty output (never throws, never fabricates a group) ──
  {
    const groups = clusterMapPoints([]);
    assertEq(groups.length, 0, "empty-01: zero points -> zero groups");
  }

  // ── Single point -> a single singleton group, never treated as a cluster ──
  {
    const groups = clusterMapPoints([{ lat: 59.91, lon: 10.75, approx: false }]);
    assertEq(groups.length, 1, "single-01: 1 point -> 1 group");
    assertEq(groups[0]?.members.length, 1, "single-02: that group has exactly 1 member (a singleton, not a cluster)");
  }

  // ── Custom radius parameter is honoured: shrinking the radius below the
  // real inter-point distance splits what would otherwise be one cluster ──
  {
    const twoPointsKmApart: ClusterPoint[] = [
      { lat: 59.9139, lon: 10.7522, approx: false },
      { lat: 59.9139, lon: 10.7522 + 0.03, approx: false }, // ~1.7km east at this latitude
    ];
    const clustered = clusterMapPoints(twoPointsKmApart, 5);
    const notClustered = clusterMapPoints(twoPointsKmApart, 0.1);
    assertEq(clustered.length, 1, "radius-01: a 5km radius merges two points ~1.7km apart into 1 cluster");
    assertEq(notClustered.length, 2, "radius-02: a 0.1km radius leaves the same two points as 2 separate groups");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runMapClusteringTests({ log: true });
  console.log(`\n${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
