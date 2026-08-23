/**
 * lokal-agent-verifier-terminal-unconfirmable.test.ts — dev-request
 * 2026-08-23-terminal-unconfirmable: a new `terminal_unconfirmable`
 * verification status so agents that are demonstrably unconfirmable stop
 * being retried forever by the hourly verifier sweep. Two triggering
 * criteria, both gated behind RFB_TERMINAL_UNCONFIRMABLE_ENABLED (default
 * OFF — flag-off must be byte-identical to before this PR):
 *
 *   1. Brreg shows the business as deleted/bankrupt (brreg_konkurs) or
 *      inactive (brreg_inactive) — a permanent, structural disqualifier —
 *      via deriveVerificationStatus's !passes branch.
 *   2. The second (lower-bar) verification line found ZERO identity
 *      sources for a first-line failure that carried no brreg/nace flags
 *      at all (newVerification === 'pending_verify' going in) — via the
 *      RFB second verification line block in runVerifierBatch, which ALSO
 *      requires RFB_SECOND_LINE_VERIFICATION_ENABLED='true'.
 *
 * Harness pattern copied verbatim from the sibling
 * lokal-agent-verifier-second-line.test.ts: in-memory better-sqlite3 DB via
 * initMod.__setDbForTesting/__initSchemaForTesting, restored in `finally`.
 *
 * Exported runLokalAgentVerifierTerminalUnconfirmableTests({log}) ->
 * TestSummary; wired into tests/test.ts via runSerial() immediately after
 * the second-line suite's own registration.
 * Standalone: npx tsx src/agents/lokal-agent-verifier-terminal-unconfirmable.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runLokalAgentVerifierTerminalUnconfirmableTests(
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
    const { runVerifierBatch, pickBatch } = require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");

    const prevDb = initMod.getDb();
    const prevTerminalFlag = process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED;
    const prevSecondLineFlag = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
    const db = new Database(":memory:");
    try {
      db.pragma("journal_mode = DELETE");
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, email, website, about, products, field_provenance, verification_status, enrichment_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'partial')`,
      );

      function domainFromEmail(email: string | null | undefined): string | null {
        if (!email || !email.includes("@")) return null;
        return email.split("@")[1] || null;
      }

      // Mirrors lokal-agent-verifier-second-line.test.ts's seedAgent:
      // agents.url is pinned to the SAME domain as the email so the
      // unrelated domainCoherenceCheck guard never perturbs these
      // terminal_unconfirmable-specific scenarios.
      function seedAgent(id: string, opts: {
        name?: string;
        website?: string | null;
        email?: string | null;
        about?: string | null;
        products?: unknown[];
        field_provenance?: Record<string, unknown>;
        verificationStatus?: string;
      } = {}): void {
        const effectiveEmail = opts.email === undefined ? "kari@testgard.no" : opts.email;
        const emailDom = domainFromEmail(effectiveEmail);
        const agentUrl = emailDom ? `https://${emailDom}` : `https://example-registration.invalid/${id}`;
        insertAgent.run(id, opts.name ?? "Testgård " + id, agentUrl, "key-" + id, 0);
        insertKnowledge.run(
          id,
          "Testveien 1, 2600 Lillehammer",
          "91234567",
          effectiveEmail,
          opts.website ?? null,
          opts.about ?? "En liten gård som selger egg og grønnsaker direkte fra tunet. Familiedrevet i tre generasjoner.",
          JSON.stringify(opts.products ?? [{ name: "Egg" }, { name: "Poteter" }, { name: "Honning" }]),
          JSON.stringify(opts.field_provenance ?? {}),
          opts.verificationStatus ?? "pending_verify",
        );
      }

      function knowledgeRow(id: string): any {
        return db.prepare(
          `SELECT verification_status, verification_review_reason FROM agent_knowledge WHERE agent_id = ?`
        ).get(id);
      }

      // pickFn scoped to exactly ONE agent id, to keep each scenario isolated.
      function pickOnly(id: string) {
        return (dbi: any) => dbi.prepare(
          `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city, a.is_verified,
                  k.email, k.phone, k.address, k.website, k.about, k.products, k.field_provenance,
                  k.verification_status, k.enrichment_status,
                  k.last_verified_at, k.last_http_check_at, k.last_http_status
             FROM agents a INNER JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`
        ).all(id);
      }

      const throwingJudge = async (): Promise<{ approved: boolean; reason?: string }> => {
        throw new Error("second-line judge must NOT have been called in this scenario");
      };

      async function runOne(id: string, o: {
        terminalFlag?: string;
        secondLineFlag?: string;
        brregLookup?: any;
        judgeFn?: any;
        headProbeStatus?: number | null;
      } = {}) {
        const prevT = process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED;
        const prevS = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
        if (o.terminalFlag === undefined) delete process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED;
        else process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED = o.terminalFlag;
        if (o.secondLineFlag === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
        else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = o.secondLineFlag;
        try {
          const result = await runVerifierBatch({
            db,
            pickFn: pickOnly(id),
            headProbe: async () => (o.headProbeStatus === undefined ? null : o.headProbeStatus),
            brregLookup: o.brregLookup ?? null,
            secondLineJudgeFn: o.judgeFn,
          });
          return result.results[0];
        } finally {
          if (prevT === undefined) delete process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED;
          else process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED = prevT;
          if (prevS === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
          else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = prevS;
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // (a) flag OFF: brreg_konkurs-flagged pending_verify agent -> still
      //     review_required, byte-identical to today.
      // ═══════════════════════════════════════════════════════════════
      seedAgent("a1", { website: "https://testgard.no", email: "kari@testgard.no" });
      {
        const r = await runOne("a1", {
          headProbeStatus: 200,
          brregLookup: async () => ({ is_active: false, is_konkurs: true, naering: null }),
        });
        assertEq(r.new_verification_status, "review_required", "a-1: flag OFF, brreg_konkurs -> review_required (byte-identical)");
        assertEq(knowledgeRow("a1").verification_status, "review_required", "a-2: DB also reflects review_required");
      }

      // ═══════════════════════════════════════════════════════════════
      // (b) flag ON, Brreg is_konkurs:true -> terminal_unconfirmable,
      //     terminal_reason: 'brreg_konkurs' persisted.
      // ═══════════════════════════════════════════════════════════════
      seedAgent("b1", { website: "https://testgard.no", email: "kari@testgard.no" });
      {
        const r = await runOne("b1", {
          terminalFlag: "true",
          headProbeStatus: 200,
          brregLookup: async () => ({ is_active: false, is_konkurs: true, naering: null }),
        });
        assertEq(r.new_verification_status, "terminal_unconfirmable", "b-1: flag ON, brreg_konkurs -> terminal_unconfirmable");
        const row = knowledgeRow("b1");
        assertEq(row.verification_status, "terminal_unconfirmable", "b-2: DB also reflects terminal_unconfirmable");
        const reason = JSON.parse(row.verification_review_reason || "{}");
        assertEq(reason.terminal_reason, "brreg_konkurs", "b-3: persisted verification_review_reason.terminal_reason = 'brreg_konkurs'");
      }

      // ═══════════════════════════════════════════════════════════════
      // (c) flag ON, Brreg is_active:false, is_konkurs:false ->
      //     terminal_unconfirmable, terminal_reason: 'brreg_inactive'.
      // ═══════════════════════════════════════════════════════════════
      seedAgent("c1", { website: "https://testgard.no", email: "kari@testgard.no" });
      {
        const r = await runOne("c1", {
          terminalFlag: "true",
          headProbeStatus: 200,
          brregLookup: async () => ({ is_active: false, is_konkurs: false, naering: null }),
        });
        assertEq(r.new_verification_status, "terminal_unconfirmable", "c-1: flag ON, brreg_inactive -> terminal_unconfirmable");
        const row = knowledgeRow("c1");
        assertEq(row.verification_status, "terminal_unconfirmable", "c-2: DB also reflects terminal_unconfirmable");
        const reason = JSON.parse(row.verification_review_reason || "{}");
        assertEq(reason.terminal_reason, "brreg_inactive", "c-3: persisted verification_review_reason.terminal_reason = 'brreg_inactive'");
      }

      // ═══════════════════════════════════════════════════════════════
      // (d) flag ON, only a nace_blacklist:* flag present (no brreg flag)
      //     -> STILL review_required. Proves the change doesn't leak into
      //     the nace-blacklist branch.
      // ═══════════════════════════════════════════════════════════════
      seedAgent("d1", { website: "https://testgard.no", email: "kari@testgard.no" });
      {
        const r = await runOne("d1", {
          terminalFlag: "true",
          headProbeStatus: 200,
          brregLookup: async () => ({ is_active: true, is_konkurs: false, naering: "Drift av restauranter" }),
        });
        assertEq(r.new_verification_status, "review_required", "d-1: flag ON, nace_blacklist only (no brreg flag) -> STILL review_required");
        const row = knowledgeRow("d1");
        assertEq(row.verification_status, "review_required", "d-2: DB also reflects review_required");
        const reason = JSON.parse(row.verification_review_reason || "{}");
        assertEq(reason.terminal_reason, undefined, "d-3: no terminal_reason stamped for the nace-blacklist-only case");
      }

      // ═══════════════════════════════════════════════════════════════
      // (e) flag ON + RFB_SECOND_LINE_VERIFICATION_ENABLED='true': first
      //     line fails with NO brreg/nace flags at all (newVerification
      //     starts 'pending_verify'), second line finds ZERO identity
      //     sources -> terminal_unconfirmable, terminal_reason:
      //     'zero_identity_sources'.
      // ═══════════════════════════════════════════════════════════════
      // No website (-> website_ok=false, no own_website source), no
      // provenance records, no Brreg name match (brregLookup=null here) ->
      // computeSecondLineIdentitySources returns []. Gate fails on
      // website_ok alone (http_status null -> flags=['website_unreachable'],
      // no brreg/nace flag) -> deriveVerificationStatus -> 'pending_verify'.
      seedAgent("e1", { website: null, email: "kari@testgard.no" });
      {
        const r = await runOne("e1", { terminalFlag: "true", secondLineFlag: "true", judgeFn: throwingJudge });
        assertEq(r.new_verification_status, "terminal_unconfirmable", "e-1: flag ON both, zero identity sources -> terminal_unconfirmable");
        const row = knowledgeRow("e1");
        assertEq(row.verification_status, "terminal_unconfirmable", "e-2: DB also reflects terminal_unconfirmable");
        const reason = JSON.parse(row.verification_review_reason || "{}");
        assertEq(reason.terminal_reason, "zero_identity_sources", "e-3: persisted verification_review_reason.terminal_reason = 'zero_identity_sources'");
      }

      // ═══════════════════════════════════════════════════════════════
      // (f) same setup as (e) but RFB_SECOND_LINE_VERIFICATION_ENABLED
      //     unset/false -> stays pending_verify (proves the zero-source
      //     branch requires BOTH flags, not just the new one).
      // ═══════════════════════════════════════════════════════════════
      seedAgent("f1", { website: null, email: "kari@testgard.no" });
      {
        const r = await runOne("f1", { terminalFlag: "true", judgeFn: throwingJudge });
        assertEq(r.new_verification_status, "pending_verify", "f-1: terminal flag ON alone (second-line flag OFF) -> stays pending_verify");
        assertEq(knowledgeRow("f1").verification_status, "pending_verify", "f-2: DB also reflects pending_verify");
      }
      seedAgent("f3", { website: null, email: "kari@testgard.no" });
      {
        const r = await runOne("f3", { terminalFlag: "true", secondLineFlag: "false", judgeFn: throwingJudge });
        assertEq(r.new_verification_status, "pending_verify", "f-3: terminal flag ON, second-line flag explicitly 'false' -> stays pending_verify");
      }

      // ═══════════════════════════════════════════════════════════════
      // (g) pickBatch(): seed one terminal_unconfirmable row and one
      //     pending_verify row -> returned batch contains only the
      //     pending_verify row.
      // ═══════════════════════════════════════════════════════════════
      seedAgent("g-terminal", { website: "https://testgard.no", email: "kari@testgard.no", verificationStatus: "terminal_unconfirmable" });
      seedAgent("g-pending", { website: "https://testgard.no", email: "kari@testgard.no", verificationStatus: "pending_verify" });
      {
        const batch = pickBatch(db, 50);
        const ids = batch.map((r: any) => r.id).filter((id: string) => id === "g-terminal" || id === "g-pending");
        assertTrue(ids.includes("g-pending"), "g-1: pickBatch includes the pending_verify row");
        assertTrue(!ids.includes("g-terminal"), "g-2: pickBatch excludes the terminal_unconfirmable row");
      }
    } catch (err: any) {
      failed++;
      failures.push("terminal-unconfirmable: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevTerminalFlag === undefined) delete process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED;
      else process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED = prevTerminalFlag;
      if (prevSecondLineFlag === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
      else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = prevSecondLineFlag;
      try { db.close(); } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierTerminalUnconfirmableTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      for (const f of summary.failures) console.log(f);
      process.exit(1);
    }
  });
}
