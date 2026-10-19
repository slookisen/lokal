/**
 * lokal-agent-verifier-email-cross-tld-marker.test.ts — runVerifierBatch-level
 * tests for dev-request 2026-10-01-rfb-verifier-epostdomene-paa-tvers-av-tld,
 * Endring 3 / AC3 (PR #1175, review blocker B1).
 *
 * Proves, end to end on an in-memory DB (not just on computeKvalitetsGate):
 *   - field_provenance actually reaches the gate (a caller that forgot
 *     `field_provenance: agent.field_provenance` would fail here),
 *   - the marker email_own_domain_via is persisted in
 *     agent_knowledge.verification_review_reason,
 *   - buildRunEnvelope counts it (agents_email_cross_tld_homepage),
 *   - /admin/pool-blocker-explain's stored-verdict parse exposes it
 *     (via the persisted JSON shape) and it is not part of gate.reasons,
 *   - a row without provenance gets no marker and stays a mismatch.
 *
 * Standalone: npx tsx src/agents/lokal-agent-verifier-email-cross-tld-marker.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const RICH_ABOUT =
  "Familiedrevet gårdsbruk med lange tradisjoner innen lokal matproduksjon. " +
  "Vi selger egne varer direkte fra gården til nærmiljøet, og legger vekt på " +
  "kvalitet, bærekraft og kortreist mat gjennom hele året.";

const RICH_PRODUCTS = JSON.stringify([{ name: "Melk" }, { name: "Ost" }, { name: "Egg" }, { name: "Poteter" }]);

function agreeingCrossSourceProvenance(): Record<string, unknown> {
  const two = (v: string) => [
    { value: v, source_type: "homepage", fetched_at: "2026-07-01T07:00:00Z" },
    { value: v, source_type: "brreg", fetched_at: "2026-07-01T07:05:00Z" },
  ];
  return {
    address: two("Testveien 1, 1400 Ski"),
    phone: two("91234567"),
    business_status: two("active"),
  };
}

export function runLokalAgentVerifierEmailCrossTldMarkerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      if (log) console.log("  " + failures[failures.length - 1]);
    }
  }

  return (async () => {
    const prevDb = initMod.getDb();
    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const { runVerifierBatch, buildRunEnvelope } =
        require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, 0)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, website, email, about, products, field_provenance, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_verify')`,
      );

      function seed(id: string, name: string, siteHost: string, email: string, emailProvenance?: unknown[]): void {
        const url = `https://${siteHost}`;
        insertAgent.run(id, name, url, `key-${id}`);
        const fp: Record<string, unknown> = { ...agreeingCrossSourceProvenance() };
        if (emailProvenance) fp.email = emailProvenance;
        insertKnowledge.run(id, "Testveien 1, 1400 Ski", "91234567", url, email, RICH_ABOUT, RICH_PRODUCTS, JSON.stringify(fp));
      }

      // A: .com site, .no address, homepage provenance on the site -> via marker.
      seed("x-via", "Knattenfrukt", "knattenfrukt.com", "nils@knattenfrukt.no", [
        { value: "nils@knattenfrukt.no", source_type: "homepage", source_url: "https://www.knattenfrukt.com/kontakt", fetched_at: "2026-07-10T00:00:00Z" },
      ]);
      // B: same shape, no email provenance -> mismatch, no marker.
      seed("x-noprov", "Utenbevisgard", "utenbevisgard.com", "nils@utenbevisgard.no");
      // C: plain same-domain address -> passes without the marker.
      seed("x-same", "Samme domene", "sammedomene.no", "post@sammedomene.no");

      const result = await runVerifierBatch({
        db,
        batchSize: 50,
        brregLookup: null,
        headProbe: async () => 200 as number | null,
      });
      const res = (id: string) => result.results.find((x) => x.agent_id === id)!;
      const stored = (id: string): Record<string, unknown> | null => {
        const row = db
          .prepare(`SELECT verification_review_reason AS r FROM agent_knowledge WHERE agent_id = ?`)
          .get(id) as { r: string | null } | undefined;
        return row?.r ? JSON.parse(row.r) : null;
      };

      // field_provenance reaches the gate: the flag is gone and the via marker is set.
      assertEq(res("x-via").flags.includes("email_domain_mismatch"), false, "ctm-1: provenance row has no email_domain_mismatch flag");
      assertEq(res("x-via").email_own_domain_via, "cross_tld_homepage", "ctm-2: result carries email_own_domain_via");
      assertEq(res("x-via").new_verification_status, "verified", "ctm-3: provenance row reaches verified");
      // Persisted in verification_review_reason.
      assertEq(stored("x-via")?.email_own_domain_via, "cross_tld_homepage", "ctm-4: marker persisted in verification_review_reason");
      assertEq(res("x-via").cross_source_reason.email_own_domain_via, "cross_tld_homepage", "ctm-5: marker on cross_source_reason");
      // Not a gate reason (does not alter fields_verified/failed).
      assertEq(
        [...res("x-via").fields_verified, ...res("x-via").fields_failed].includes("email_own_domain_via"),
        false,
        "ctm-6: marker is not a gate reason",
      );
      // No provenance: no marker, still a mismatch, not verified.
      assertEq(res("x-noprov").flags.includes("email_domain_mismatch"), true, "ctm-7: no-provenance row keeps email_domain_mismatch");
      assertEq(res("x-noprov").email_own_domain_via, undefined, "ctm-8: no-provenance row has no via on result");
      assertEq(stored("x-noprov")?.email_own_domain_via, undefined, "ctm-9: no-provenance row has no persisted marker");
      assertEq(res("x-noprov").new_verification_status === "verified", false, "ctm-10: no-provenance row is not verified");
      // Same-domain row: no marker.
      assertEq(stored("x-same")?.email_own_domain_via, undefined, "ctm-11: same-domain row has no marker");

      // Envelope counter.
      const env = buildRunEnvelope({
        run_id: "run-ctm",
        started_at: result.started_at,
        finished_at: result.finished_at,
        results: result.results,
      }) as any;
      const claim = env.claims.find((c: any) => c.meta?.kind === "agents_email_cross_tld_homepage");
      assertEq(claim?.value, 1, "ctm-12: envelope counts exactly one cross-TLD row");
      assertEq(claim?.meta?.examples, ["x-via"], "ctm-13: envelope examples list the agent id");
      const zero = buildRunEnvelope({
        run_id: "run-ctm0",
        started_at: result.started_at,
        finished_at: result.finished_at,
        results: result.results.filter((x) => x.agent_id !== "x-via"),
      }) as any;
      const zeroClaim = zero.claims.find((c: any) => c.meta?.kind === "agents_email_cross_tld_homepage");
      assertEq(zeroClaim?.value, 0, "ctm-14: counter is 0 when no row used the branch");
    } finally {
      initMod.__setDbForTesting(prevDb);
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierEmailCrossTldMarkerTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) process.exit(1);
  });
}
