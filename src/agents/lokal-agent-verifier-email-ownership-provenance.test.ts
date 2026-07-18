/**
 * lokal-agent-verifier-email-ownership-provenance.test.ts — tests the
 * free-mail ownership-provenance guard added for dev-request
 * 2026-07-15-gate-integrity-unverified-agent-bypass (slice 2).
 *
 * Background: computeKvalitetsGate's email_own_domain check treats ANY
 * free-mail/ISP address (gmail.com, online.no, …) as automatically "the
 * producer's own email" with zero evidence required — that exemption is
 * intentional (small Norwegian producers commonly use a personal mailbox)
 * and stays UNCHANGED by this dev-request. Real failure (2026-07-15): an
 * outreach email went to the wrong entity because a personal free-mail
 * address (norskott@online.no) had been attached to the wrong producer
 * ("Dalheim Gårdsysteri") during enrichment — the gate had no way to catch
 * a mis-attached free-mail address because it required no evidence at all.
 *
 * This suite proves the layered fix in runVerifierBatch (Guard #3, sitting
 * alongside the existing websiteOwnershipUnverified / inferenceOnlyFields /
 * domain-coherence guards):
 *   - A free-mail email is only "ownership-proven" when EITHER (A) a
 *     field_provenance.email "homepage" record matches the exact email, OR
 *     (B) agents.is_verified = 1 (manual claim flow).
 *   - CRITICAL monotonic guard, per Daniel's explicit "we cannot reduce the
 *     verified/outreach pool" instruction: an agent that is ALREADY
 *     `verified` going into a run is NEVER downgraded by this check — it is
 *     report-only for that case. Only agents NOT already in the pool are
 *     quarantined (forced to review_required) when unproven.
 *   - Real-domain (non-free-mail) emails are completely unaffected.
 *   - buildRunEnvelope surfaces both an enforced-count claim and a
 *     report-only claim (count + up to 5 {agent_id, name} examples).
 *
 * Exported runLokalAgentVerifierEmailOwnershipProvenanceTests({log}) ->
 * TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/agents/lokal-agent-verifier-email-ownership-provenance.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// A long-enough Norwegian about-text so computeEnrichmentStatus computes
// "rich" (about>=150 chars) when combined with >=3 products + an address —
// i.e. every fixture in this file "otherwise passes every other gate", per
// the spec, so the only thing under test is the new email-ownership guard.
const RICH_ABOUT =
  "Familiedrevet gårdsbruk med lange tradisjoner innen lokal matproduksjon. " +
  "Vi selger egne varer direkte fra gården til nærmiljøet, og legger vekt på " +
  "kvalitet, bærekraft og kortreist mat gjennom hele året.";

const RICH_PRODUCTS = JSON.stringify([
  { name: "Melk" },
  { name: "Ost" },
  { name: "Egg" },
  { name: "Poteter" },
]);

// Homepage+brreg agreeing provenance for the 3 cross-source fields
// (address/phone/business_status) — mirrors the existing "Fixture 2" dual-
// source pattern in tests/test.ts so agentVerdict comes back pool_eligible
// and the basic + cross-source gates both pass cleanly, independent of the
// email-ownership guard under test here.
function agreeingCrossSourceProvenance(): Record<string, unknown> {
  return {
    address: [
      { value: "Testveien 1, 1400 Ski", source_type: "homepage", fetched_at: "2026-07-01T07:00:00Z" },
      { value: "Testveien 1, 1400 Ski", source_type: "brreg", fetched_at: "2026-07-01T07:05:00Z" },
    ],
    phone: [
      { value: "91234567", source_type: "homepage", fetched_at: "2026-07-01T07:00:00Z" },
      { value: "91234567", source_type: "brreg", fetched_at: "2026-07-01T07:05:00Z" },
    ],
    business_status: [
      { value: "active", source_type: "homepage", fetched_at: "2026-07-01T07:00:00Z" },
      { value: "active", source_type: "brreg", fetched_at: "2026-07-01T07:05:00Z" },
    ],
  };
}

export function runLokalAgentVerifierEmailOwnershipProvenanceTests(
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
    const prevDb = initMod.getDb();
    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const {
        runVerifierBatch,
        buildRunEnvelope,
      } = require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, website, email, about, products, field_provenance, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      function seedAgent(seed: {
        id: string;
        name: string;
        domain: string;
        email: string;
        verificationStatus: string;
        isVerified?: boolean;
        emailProvenance?: unknown[];
      }): void {
        const url = `https://${seed.domain}`;
        insertAgent.run(seed.id, seed.name, url, `key-${seed.id}`, seed.isVerified ? 1 : 0);
        const fieldProvenance: Record<string, unknown> = {
          ...agreeingCrossSourceProvenance(),
        };
        if (seed.emailProvenance) fieldProvenance.email = seed.emailProvenance;
        insertKnowledge.run(
          seed.id,
          "Testveien 1, 1400 Ski",
          "91234567",
          url,
          seed.email,
          RICH_ABOUT,
          RICH_PRODUCTS,
          JSON.stringify(fieldProvenance),
          seed.verificationStatus,
        );
      }

      const mockHeadProbe = async (_url: string) => 200 as number | null;

      // ── Case 1: MONOTONIC GUARD (the critical case) ─────────────────────
      // Already verified + free-mail + no evidence + agents.is_verified=0
      // -> must NOT be downgraded. Report-only.
      seedAgent({
        id: "agent-already-verified",
        name: "Alreadygard AS",
        domain: "alreadygard.no",
        email: "foo@gmail.com",
        verificationStatus: "verified",
        isVerified: false,
      });

      // ── Case 2: ENFORCEMENT — otherwise-identical agent, NOT already
      // verified going in (pending_verify) -> quarantined to review_required.
      seedAgent({
        id: "agent-not-yet-verified",
        name: "Notyetgard AS",
        domain: "notyetgard.no",
        email: "foo@gmail.com",
        verificationStatus: "pending_verify",
        isVerified: false,
      });

      // ── Case 3: Evidence path A (homepage provenance) clears the flag,
      // regardless of prior status. source_url must resolve to THIS agent's
      // own agent_url host (review fix-up, 2026-07-18) for the evidence to
      // count.
      seedAgent({
        id: "agent-homepage-evidence",
        name: "Homepagegard AS",
        domain: "homepagegard.no",
        email: "bar@gmail.com",
        verificationStatus: "pending_verify",
        isVerified: false,
        emailProvenance: [
          { value: "bar@gmail.com", source_type: "homepage", source_url: "https://homepagegard.no/kontakt", fetched_at: "2026-07-10T00:00:00Z" },
        ],
      });

      // ── Case 6 (review fix-up, 2026-07-18): STALE-EVIDENCE / host-mismatch
      // negative control. A homepage record proves the exact free-mail value
      // was published — but at a DIFFERENT agent's homepage (source_url host
      // != this agent's own agent_url host). This is the append-only-
      // provenance staleness class: must NOT count as ownership proof for
      // THIS listing, so the flag stays unproven and (not already verified)
      // the agent is quarantined.
      seedAgent({
        id: "agent-stale-homepage-evidence",
        name: "Stalegard AS",
        domain: "stalegard.no",
        email: "qux@gmail.com",
        verificationStatus: "pending_verify",
        isVerified: false,
        emailProvenance: [
          { value: "qux@gmail.com", source_type: "homepage", source_url: "https://some-other-unrelated-agent.no/kontakt", fetched_at: "2026-07-10T00:00:00Z" },
        ],
      });

      // ── Case 4: Evidence path B (agents.is_verified=1) clears the flag,
      // no field_provenance evidence needed.
      seedAgent({
        id: "agent-manually-verified",
        name: "Manuellgard AS",
        domain: "manuellgard.no",
        email: "baz@gmail.com",
        verificationStatus: "review_required",
        isVerified: true,
      });

      // ── Case 5: Negative control — real-domain email (non-free-mail),
      // completely untouched by any of this.
      seedAgent({
        id: "agent-real-domain",
        name: "Realdomenegard AS",
        domain: "realdomenegard.no",
        email: "post@realdomenegard.no",
        verificationStatus: "pending_verify",
        isVerified: false,
      });

      const result = await runVerifierBatch({
        db,
        batchSize: 50,
        brregLookup: null,
        headProbe: mockHeadProbe,
      });

      function resultFor(id: string) {
        const r = result.results.find((x) => x.agent_id === id);
        assertTrue(!!r, `precondition: result found for ${id}`);
        return r!;
      }

      // ── Case 1 assertions (the critical monotonic-guard case) ──────────
      const r1 = resultFor("agent-already-verified");
      assertEq(r1.new_verification_status, "verified",
        "eop-01 (CRITICAL): already-verified agent with unproven free-mail email is NOT downgraded — stays 'verified'");
      assertEq(r1.email_ownership_unproven, true,
        "eop-02: already-verified agent IS flagged as email_ownership_unproven (condition holds)");
      assertEq(r1.email_ownership_report_only, true,
        "eop-03: already-verified agent's flag is report-only (true)");
      assertTrue(!r1.flags.includes("email_ownership_unproven"),
        "eop-04: report-only case does NOT push the advisory gate.flags entry (zero effect on outcome)");

      // ── Case 2 assertions (enforcement) ─────────────────────────────────
      const r2 = resultFor("agent-not-yet-verified");
      assertEq(r2.new_verification_status, "review_required",
        "eop-05: NOT-already-verified agent with unproven free-mail email is quarantined to review_required (not verified)");
      assertTrue(r2.flags.includes("email_ownership_unproven"),
        "eop-06: enforced case DOES push the advisory gate.flags entry");
      assertEq(r2.email_ownership_report_only, false,
        "eop-07: enforced case is NOT report-only");
      assertEq(r2.email_ownership_unproven, true,
        "eop-08: enforced case is flagged unproven");

      // ── Case 3 assertions (evidence path A) ─────────────────────────────
      const r3 = resultFor("agent-homepage-evidence");
      assertEq(r3.email_ownership_unproven, false,
        "eop-09: homepage-provenance evidence (path A) clears the unproven flag");
      assertEq(r3.email_ownership_report_only, false,
        "eop-10: path-A-evidenced agent is not report-only either");
      assertEq(r3.new_verification_status, "verified",
        "eop-11: path-A-evidenced agent gets a normal verdict (verified) despite starting pending_verify");
      assertTrue(!r3.flags.includes("email_ownership_unproven"),
        "eop-12: path-A-evidenced agent has no advisory flag");

      // ── Case 4 assertions (evidence path B) ─────────────────────────────
      const r4 = resultFor("agent-manually-verified");
      assertEq(r4.email_ownership_unproven, false,
        "eop-13: agents.is_verified=1 (path B) clears the unproven flag");
      assertEq(r4.email_ownership_report_only, false,
        "eop-14: path-B-evidenced agent is not report-only either");
      assertEq(r4.new_verification_status, "verified",
        "eop-15: path-B-evidenced agent gets a normal verdict (verified) despite starting review_required");

      // ── Case 5 assertions (negative control) ────────────────────────────
      const r5 = resultFor("agent-real-domain");
      assertEq(r5.email_ownership_unproven, false,
        "eop-16: real-domain (non-free-mail) email is completely unaffected — never flagged");
      assertEq(r5.email_ownership_report_only, false,
        "eop-17: real-domain email is never report-only either");
      assertEq(r5.new_verification_status, "verified",
        "eop-18: real-domain email agent verdict unaffected (no regression) — verified");
      assertTrue(!r5.flags.includes("email_domain_mismatch"),
        "eop-19: real-domain email matching its own website host still has no email_domain_mismatch flag (unchanged pre-existing behavior)");

      // ── Case 6 assertions (review fix-up: stale/host-mismatched homepage
      // evidence must NOT count as ownership proof) ──────────────────────
      const r6 = resultFor("agent-stale-homepage-evidence");
      assertEq(r6.email_ownership_unproven, true,
        "eop-19b: homepage evidence whose source_url host != this agent's own agent_url host does NOT clear the unproven flag (fail closed)");
      assertEq(r6.email_ownership_report_only, false,
        "eop-19c: not-already-verified, so the host-mismatched-evidence case is enforced, not report-only");
      assertEq(r6.new_verification_status, "review_required",
        "eop-19d: host-mismatched homepage evidence does not rescue — agent is quarantined to review_required");
      assertTrue(r6.flags.includes("email_ownership_unproven"),
        "eop-19e: host-mismatched-evidence case pushes the advisory gate.flags entry");

      // ── DB write-through sanity: case 1 truly left verification_status
      // untouched in agent_knowledge (not just in the in-memory result). ──
      const dbRow1 = db
        .prepare("SELECT verification_status FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-already-verified") as { verification_status: string };
      assertEq(dbRow1.verification_status, "verified",
        "eop-20: agent_knowledge.verification_status for the monotonic-guard agent is written as 'verified' (DB write matches in-memory result)");

      const dbRow2 = db
        .prepare("SELECT verification_status FROM agent_knowledge WHERE agent_id = ?")
        .get("agent-not-yet-verified") as { verification_status: string };
      assertEq(dbRow2.verification_status, "review_required",
        "eop-21: agent_knowledge.verification_status for the enforced agent is written as 'review_required'");

      // ── buildRunEnvelope claims from this same real run ─────────────────
      const envelope = buildRunEnvelope({
        run_id: result.run_id,
        started_at: result.started_at,
        finished_at: result.finished_at,
        results: result.results,
      });
      const claims = (envelope as any).claims as Array<{ value: unknown; meta: Record<string, unknown> }>;
      const enforcedClaim = claims.find((c) => c.meta?.kind === "agents_email_ownership_unproven_enforced");
      const reportOnlyClaim = claims.find(
        (c) => c.meta?.kind === "agents_email_ownership_unproven_existing_verified_report_only",
      );
      assertTrue(!!enforcedClaim, "eop-22: buildRunEnvelope includes the enforced-count claim");
      assertTrue(!!reportOnlyClaim, "eop-23: buildRunEnvelope includes the report-only claim");
      assertEq(enforcedClaim?.value, 2,
        `eop-24: enforced claim counts agent-not-yet-verified + agent-stale-homepage-evidence (got ${enforcedClaim?.value})`);
      assertEq(reportOnlyClaim?.value, 1,
        `eop-25: report-only claim counts exactly agent-already-verified (got ${reportOnlyClaim?.value})`);
      const examples = (reportOnlyClaim?.meta as any)?.examples as Array<{ agent_id: string; name: string | null }>;
      assertTrue(Array.isArray(examples), "eop-26: report-only claim meta.examples is an array");
      assertEq(examples?.length, 1, `eop-27: report-only claim has exactly 1 example (got ${examples?.length})`);
      assertEq(examples?.[0]?.agent_id, "agent-already-verified",
        "eop-28: report-only example has the right agent_id");
      assertEq(examples?.[0]?.name, "Alreadygard AS",
        "eop-29: report-only example includes the agent name");

      // ── Case 6: buildRunEnvelope shape with a synthetic mixed batch, incl.
      // the >5-examples cap. Built directly (not via runVerifierBatch) so we
      // can cheaply construct 7 report-only + 2 enforced + 1 clean result. ──
      function makeResult(over: Partial<import("./lokal-agent-verifier").VerifierResult>): import("./lokal-agent-verifier").VerifierResult {
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
          agent_name: null,
          ...over,
        };
      }

      const synthetic: import("./lokal-agent-verifier").VerifierResult[] = [];
      for (let i = 0; i < 7; i++) {
        synthetic.push(
          makeResult({
            agent_id: `ro-${i}`,
            agent_name: `Report Only ${i}`,
            email_ownership_unproven: true,
            email_ownership_report_only: true,
          }),
        );
      }
      for (let i = 0; i < 2; i++) {
        synthetic.push(
          makeResult({
            agent_id: `en-${i}`,
            agent_name: `Enforced ${i}`,
            new_verification_status: "review_required",
            email_ownership_unproven: true,
            email_ownership_report_only: false,
          }),
        );
      }
      synthetic.push(makeResult({ agent_id: "clean-0", agent_name: "Clean 0" }));

      const syntheticEnvelope = buildRunEnvelope({
        run_id: "run-synthetic",
        started_at: "2026-07-18T00:00:00.000Z",
        finished_at: "2026-07-18T00:01:00.000Z",
        results: synthetic,
      });
      const syntheticClaims = (syntheticEnvelope as any).claims as Array<{ value: unknown; meta: Record<string, unknown> }>;
      const synEnforced = syntheticClaims.find((c) => c.meta?.kind === "agents_email_ownership_unproven_enforced");
      const synReportOnly = syntheticClaims.find(
        (c) => c.meta?.kind === "agents_email_ownership_unproven_existing_verified_report_only",
      );
      assertEq(synEnforced?.value, 2, `eop-30: synthetic enforced-claim value = 2 (got ${synEnforced?.value})`);
      assertEq(synReportOnly?.value, 7, `eop-31: synthetic report-only claim value = 7 (got ${synReportOnly?.value})`);
      const synExamples = (synReportOnly?.meta as any)?.examples as Array<{ agent_id: string; name: string | null }>;
      assertTrue(Array.isArray(synExamples), "eop-32: synthetic report-only examples is an array");
      assertEq(synExamples?.length, 5, `eop-33: synthetic report-only examples capped at 5 (got ${synExamples?.length})`);
      for (const ex of synExamples ?? []) {
        assertTrue(typeof ex.agent_id === "string" && typeof ex.name !== "undefined",
          `eop-34: each capped example has {agent_id, name} shape (got ${JSON.stringify(ex)})`);
      }
      assertEq(synExamples?.[0]?.agent_id, "ro-0", "eop-35: examples preserve original order (first is ro-0)");
    } finally {
      initMod.__setDbForTesting(prevDb);
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierEmailOwnershipProvenanceTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
