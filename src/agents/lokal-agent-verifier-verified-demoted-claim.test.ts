/**
 * lokal-agent-verifier-verified-demoted-claim.test.ts — tests the
 * `verified_demoted` claim added to buildRunEnvelope() for dev-request
 * 2026-09-18-verifier-by-transition-ikke-persistert.
 *
 * Background: runVerifierBatch's caller (src/routes/admin-run-verifier.ts)
 * already computes a detailed `by_transition` map, but that map is returned
 * ONLY in the raw HTTP response of the one call that computed it — it never
 * reaches the run-envelope buildRunEnvelope() posts to /admin/runs for every
 * scheduled tick, so no future observer can see "did a `verified` agent
 * regress this run" from persisted data without forcing a fresh diagnostic
 * batch. This suite proves the one new aggregate claim that fixes that:
 * `verified_demoted` = count of results where prior_verification_status was
 * "verified" and new_verification_status is anything else.
 *
 * Pure-function coverage: buildRunEnvelope takes a `results` array and
 * returns a claims payload, so this suite builds VerifierResult fixtures
 * directly (no DB / no runVerifierBatch needed), mirroring the "synthetic
 * mixed batch" pattern already used in
 * lokal-agent-verifier-email-ownership-provenance.test.ts.
 *
 * Exported runLokalAgentVerifierVerifiedDemotedClaimTests({log}) ->
 * TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/agents/lokal-agent-verifier-verified-demoted-claim.test.ts
 */

import { buildRunEnvelope, CLAIM_AGENT_IDS_MAX, type VerifierResult } from "./lokal-agent-verifier";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runLokalAgentVerifierVerifiedDemotedClaimTests(
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

  function makeResult(over: Partial<VerifierResult>): VerifierResult {
    return {
      agent_id: "x",
      passed: true,
      flags: [],
      fields_verified: [],
      fields_failed: [],
      http_status: 200,
      brreg_status: null,
      new_verification_status: "verified",
      new_enrichment_status: "rich",
      outreach_eligible_at: null,
      cross_source_reason: {},
      url_last_probed: null,
      url_last_status: null,
      url_demoted: false,
      domain_incoherent: false,
      email_ownership_unproven: false,
      email_ownership_report_only: false,
      verified_second_line: false,
      agent_name: null,
      prior_verification_status: "pending_verify",
      ...over,
    };
  }

  function findClaim(envelope: Record<string, unknown>, kind: string) {
    const claims = (envelope as any).claims as Array<{ value: unknown; meta: Record<string, unknown> }>;
    return claims.find((c) => c.meta?.kind === kind);
  }

  return (async () => {
    // ── Case 1: two verified-origin rows demoted to a non-verified status
    // -> verified_demoted = 2. ─────────────────────────────────────────────
    const demotedResults: VerifierResult[] = [
      makeResult({
        agent_id: "agent-demoted-1",
        prior_verification_status: "verified",
        new_verification_status: "review_required",
      }),
      makeResult({
        agent_id: "agent-demoted-2",
        prior_verification_status: "verified",
        new_verification_status: "needs_review",
      }),
      // a non-verified-origin row thrown in to prove it's excluded from the count
      makeResult({
        agent_id: "agent-unrelated",
        prior_verification_status: "pending_verify",
        new_verification_status: "verified",
      }),
    ];
    const demotedEnvelope = buildRunEnvelope({
      run_id: "run-demoted",
      started_at: "2026-09-18T00:00:00.000Z",
      finished_at: "2026-09-18T00:01:00.000Z",
      results: demotedResults,
    });
    const demotedClaim = findClaim(demotedEnvelope, "verified_demoted");
    assertTrue(!!demotedClaim, "vd-01: buildRunEnvelope includes the verified_demoted claim");
    assertEq(demotedClaim?.value, 2, `vd-02: two verified-origin demotions counted (got ${demotedClaim?.value})`);

    // ── Case 2: a verified->verified no-op reconfirmation must NOT be
    // counted as a regression — the exact case that motivated the fix. ─────
    const reconfirmedResults: VerifierResult[] = [
      makeResult({
        agent_id: "agent-reconfirmed",
        prior_verification_status: "verified",
        new_verification_status: "verified",
      }),
    ];
    const reconfirmedEnvelope = buildRunEnvelope({
      run_id: "run-reconfirmed",
      started_at: "2026-09-18T00:00:00.000Z",
      finished_at: "2026-09-18T00:01:00.000Z",
      results: reconfirmedResults,
    });
    const reconfirmedClaim = findClaim(reconfirmedEnvelope, "verified_demoted");
    assertTrue(!!reconfirmedClaim, "vd-03: verified_demoted claim present even with only a reconfirmation row");
    assertEq(reconfirmedClaim?.value, 0,
      `vd-04: verified->verified reconfirmation is NOT counted as a demotion (got ${reconfirmedClaim?.value})`);

    // ── Case 3: zero verified-origin rows at all -> claim present with
    // value 0 (not omitted), matching this function's zero-value convention
    // (e.g. agents_paraply_epost_mangler / agents_terminal_unconfirmable
    // are always emitted even when 0). ──────────────────────────────────────
    const noVerifiedOriginResults: VerifierResult[] = [
      makeResult({
        agent_id: "agent-fresh-1",
        prior_verification_status: "pending_verify",
        new_verification_status: "verified",
      }),
      makeResult({
        agent_id: "agent-fresh-2",
        prior_verification_status: "data_insufficient",
        new_verification_status: "review_required",
      }),
    ];
    const noOriginEnvelope = buildRunEnvelope({
      run_id: "run-no-verified-origin",
      started_at: "2026-09-18T00:00:00.000Z",
      finished_at: "2026-09-18T00:01:00.000Z",
      results: noVerifiedOriginResults,
    });
    const noOriginClaim = findClaim(noOriginEnvelope, "verified_demoted");
    assertTrue(!!noOriginClaim, "vd-05: verified_demoted claim present with zero verified-origin rows");
    assertEq(noOriginClaim?.value, 0,
      `vd-06: value is 0 (not omitted) when no result started as verified (got ${noOriginClaim?.value})`);

    // ── C5: newly_verified vs reverified split; agents_verified unchanged. ──
    const mixed: VerifierResult[] = [
      ...["n1", "n2"].map((id) =>
        makeResult({ agent_id: id, prior_verification_status: "pending_verify", new_verification_status: "verified" })),
      ...["r1", "r2", "r3"].map((id) =>
        makeResult({ agent_id: id, prior_verification_status: "verified", new_verification_status: "verified" })),
      makeResult({ agent_id: "p1", prior_verification_status: "pending_verify", new_verification_status: "pending_verify" }),
    ];
    const mixedEnvelope = buildRunEnvelope({
      run_id: "run-c5",
      started_at: "2026-10-17T00:00:00.000Z",
      finished_at: "2026-10-17T00:01:00.000Z",
      results: mixed,
    });
    assertEq(findClaim(mixedEnvelope, "agents_newly_verified")?.value, 2, "c5-e1: agents_newly_verified = 2");
    assertEq(findClaim(mixedEnvelope, "agents_reverified")?.value, 3, "c5-e2: agents_reverified = 3");
    assertEq(findClaim(mixedEnvelope, "agents_verified")?.value, 5, "c5-e3: agents_verified stays 5");

    // ── review_required re-evaluation claims (dev-request
    // 2026-09-15-review-required-koen-promoteres-ikke-aarsak-usynlig, AC2/AC3):
    // reevaluated counts every review_required-origin row; promoted only
    // those that reached verified. ──────────────────────────────────────────
    const rrResults: VerifierResult[] = [
      makeResult({ agent_id: "rr-up", prior_verification_status: "review_required", new_verification_status: "verified" }),
      makeResult({ agent_id: "rr-up-2", prior_verification_status: "review_required", new_verification_status: "verified" }),
      makeResult({ agent_id: "rr-stay", prior_verification_status: "review_required", new_verification_status: "review_required" }),
      makeResult({ agent_id: "rr-down", prior_verification_status: "review_required", new_verification_status: "data_insufficient" }),
      // not review_required-origin: reaches verified, must count in neither
      makeResult({ agent_id: "pv-up", prior_verification_status: "pending_verify", new_verification_status: "verified" }),
      // demoted INTO review_required: not a re-evaluation of a review_required row
      makeResult({ agent_id: "v-down", prior_verification_status: "verified", new_verification_status: "review_required" }),
    ];
    const rrEnvelope = buildRunEnvelope({
      run_id: "run-rr",
      started_at: "2026-10-31T00:00:00.000Z",
      finished_at: "2026-10-31T00:01:00.000Z",
      results: rrResults,
    });
    const rrRe = findClaim(rrEnvelope, "review_required_reevaluated");
    const rrPro = findClaim(rrEnvelope, "review_required_promoted");
    assertTrue(!!rrRe, "rr-01: buildRunEnvelope includes the review_required_reevaluated claim");
    assertTrue(!!rrPro, "rr-02: buildRunEnvelope includes the review_required_promoted claim");
    assertEq(rrRe?.value, 4, `rr-03: four review_required-origin rows re-evaluated (got ${rrRe?.value})`);
    assertEq(rrPro?.value, 2, `rr-04: two review_required-origin rows promoted to verified (got ${rrPro?.value})`);
    assertEq((rrEnvelope as any).claims.filter((c: any) => c.meta?.kind === "review_required_reevaluated").length, 1,
      "rr-05: review_required_reevaluated emitted exactly once");

    // zero review_required-origin rows -> both claims present with value 0
    const rrZero = buildRunEnvelope({
      run_id: "run-rr-zero",
      started_at: "2026-10-31T00:00:00.000Z",
      finished_at: "2026-10-31T00:01:00.000Z",
      results: mixed,
    });
    assertEq(findClaim(rrZero, "review_required_reevaluated")?.value, 0, "rr-06: reevaluated is 0 (not omitted) with no review_required-origin rows");
    assertEq(findClaim(rrZero, "review_required_promoted")?.value, 0, "rr-07: promoted is 0 (not omitted) with no review_required-origin rows");
    const rrEmpty = buildRunEnvelope({
      run_id: "run-rr-empty",
      started_at: "2026-10-31T00:00:00.000Z",
      finished_at: "2026-10-31T00:01:00.000Z",
      results: [],
    });
    assertEq(findClaim(rrEmpty, "review_required_reevaluated")?.value, 0, "rr-08: reevaluated is 0 on an empty batch");
    assertEq(findClaim(rrEmpty, "review_required_promoted")?.value, 0, "rr-09: promoted is 0 on an empty batch");

    // ── dev-request 2026-10-30-verifier-verified-demoted-agent-id-i-meta
    // slice 1: verified_demoted carries meta.agent_ids + meta.reasons; value
    // and kind unchanged. ───────────────────────────────────────────────────
    assertEq(demotedClaim?.meta, {
      kind: "verified_demoted",
      agent_ids: ["agent-demoted-1", "agent-demoted-2"],
      reasons: { needs_review: 1, review_required: 1 },
    }, "vdm-01: verified_demoted meta has sorted agent_ids and reasons per demoted-to status");
    assertEq(reconfirmedClaim?.meta, { kind: "verified_demoted", agent_ids: [], reasons: {} },
      "vdm-02: no demotions -> empty agent_ids and reasons");

    // Order-independence: same rows, reversed batch order -> same meta.
    const reversed = buildRunEnvelope({
      run_id: "run-demoted-rev",
      started_at: "2026-11-14T00:00:00.000Z",
      finished_at: "2026-11-14T00:01:00.000Z",
      results: [...demotedResults].reverse(),
    });
    assertEq(findClaim(reversed, "verified_demoted")?.meta, demotedClaim?.meta,
      "vdm-03: agent_ids/reasons are deterministic regardless of batch order");

    // Cap: 25 demotions -> value 25, agent_ids capped at 20, reasons count all 25.
    assertEq(CLAIM_AGENT_IDS_MAX, 20, "vdm-04: agent_ids cap is 20");
    const many: VerifierResult[] = Array.from({ length: 25 }, (_, i) =>
      makeResult({
        agent_id: `d-${String(i).padStart(2, "0")}`,
        prior_verification_status: "verified",
        new_verification_status: i < 15 ? "review_required" : "data_insufficient",
      }));
    const manyEnvelope = buildRunEnvelope({
      run_id: "run-demoted-many",
      started_at: "2026-11-14T00:00:00.000Z",
      finished_at: "2026-11-14T00:01:00.000Z",
      results: many,
    });
    const manyClaim = findClaim(manyEnvelope, "verified_demoted");
    assertEq(manyClaim?.value, 25, "vdm-05: value stays the full count above the cap");
    assertEq((manyClaim?.meta.agent_ids as string[]).length, 20, "vdm-06: agent_ids capped at 20");
    assertEq(manyClaim?.meta.agent_ids, many.slice(0, 20).map((x) => x.agent_id),
      "vdm-07: capped agent_ids are the first 20 in sorted order");
    assertEq(manyClaim?.meta.reasons, { data_insufficient: 10, review_required: 15 },
      "vdm-08: reasons count every demoted row, not just the capped ids");

    // ── slice 2: agents_verified carries meta.agent_ids; value/kind unchanged.
    const verifiedClaim = findClaim(mixedEnvelope, "agents_verified");
    assertEq(verifiedClaim?.meta, { kind: "agents_verified", agent_ids: ["n1", "n2", "r1", "r2", "r3"] },
      "vdm-09: agents_verified meta.agent_ids lists newly + re-verified agents, excluding non-verified");
    assertEq(findClaim(demotedEnvelope, "agents_verified")?.meta.agent_ids, ["agent-unrelated"],
      "vdm-10: agents_verified agent_ids exclude demoted rows");
    const manyVerified = Array.from({ length: 30 }, (_, i) =>
      makeResult({ agent_id: `v-${String(29 - i).padStart(2, "0")}`, new_verification_status: "verified" }));
    const mvEnvelope = buildRunEnvelope({
      run_id: "run-verified-many",
      started_at: "2026-11-14T00:00:00.000Z",
      finished_at: "2026-11-14T00:01:00.000Z",
      results: manyVerified,
    });
    const mvClaim = findClaim(mvEnvelope, "agents_verified");
    assertEq(mvClaim?.value, 30, "vdm-11: agents_verified value stays the full count above the cap");
    assertEq(mvClaim?.meta.agent_ids, Array.from({ length: 20 }, (_, i) => `v-${String(i).padStart(2, "0")}`),
      "vdm-12: agents_verified agent_ids capped at 20, sorted");
    assertEq(findClaim(rrEmpty, "agents_verified")?.meta, { kind: "agents_verified", agent_ids: [] },
      "vdm-13: empty batch -> agents_verified agent_ids is []");

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierVerifiedDemotedClaimTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
