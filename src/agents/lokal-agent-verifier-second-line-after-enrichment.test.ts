/**
 * lokal-agent-verifier-second-line-after-enrichment.test.ts — dev-request
 * 2026-11-17-andrelinje-verifiserte-nedgraderes-etter-berikelse (S1).
 *
 * A second-line-verified RFB profile whose enrichment made the first-line
 * quality gate PASS must not be demoted solely because the cross-source
 * address verdict (one source) is review_required/data_insufficient: the
 * second line is now also attempted in that case. Every other guard
 * (inference-only fields, website ownership, domain coherence, corroborated
 * email, paraply e-mail, opt_out / terminal_unconfirmable, Brreg/NACE) still
 * keeps the demotion and the judge is never called.
 *
 *   AK1 gate passes + single-source address + second line passes -> verified
 *   AK2 same profile with a guard active -> still demoted, judge not called
 *   AK3 second line does not pass -> status as before
 *   AK4 flag off -> status as before, judge not called
 *
 * Same harness as lokal-agent-verifier-second-line.test.ts (in-memory DB via
 * __setDbForTesting / __initSchemaForTesting, injected judge, no network).
 * Wired into tests/test.ts via runSerial().
 * Standalone: npx tsx src/agents/lokal-agent-verifier-second-line-after-enrichment.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runLokalAgentVerifierSecondLineAfterEnrichmentTests(
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
    const { runVerifierBatch } = require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");

    const prevDb = initMod.getDb();
    const prevFlag = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
    const db = new Database(":memory:");
    try {
      db.pragma("journal_mode = DELETE");
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, 0)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, email, website, about, products, field_provenance,
            verification_status, enrichment_status, verified_second_line, verified_second_line_sources)
         VALUES (?, 'Testveien 1, 2600 Lillehammer', '91234567', ?, ?, ?, ?, ?, ?, 'rich', 1, '["facebook_official_page"]')`,
      );

      // A previously second-line-verified profile that enrichment has since
      // made gate-passing: live own website, matching-domain email, rich
      // content. Its address has exactly ONE (non-inference) source, so the
      // first line's cross-source verdict is review_required.
      const SINGLE_SOURCE_ADDRESS = {
        address: [{ value: "Testveien 1, 2600 Lillehammer", source_type: "google_places", source_url: "https://maps.google.com/?cid=1", fetched_at: "2026-11-01T00:00:00Z" }],
      };

      function seed(id: string, o: {
        agentUrl?: string;
        email?: string;
        website?: string;
        field_provenance?: Record<string, unknown>;
        status?: string;
      } = {}): void {
        insertAgent.run(id, "Testgård " + id, o.agentUrl ?? "https://testgard.no", "key-" + id);
        insertKnowledge.run(
          id,
          o.email ?? "kari@testgard.no",
          o.website ?? "https://testgard.no",
          "En liten gård som selger egg og grønnsaker direkte fra tunet. Familiedrevet i tre generasjoner, med gårdsbutikk.",
          JSON.stringify([{ name: "Egg" }, { name: "Poteter" }, { name: "Honning" }]),
          JSON.stringify(o.field_provenance ?? SINGLE_SOURCE_ADDRESS),
          o.status ?? "verified",
        );
      }

      function row(id: string): any {
        return db.prepare(
          `SELECT verification_status, verified_second_line FROM agent_knowledge WHERE agent_id = ?`,
        ).get(id);
      }

      function pickOnly(id: string) {
        return (dbi: any) => dbi.prepare(
          `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city, a.is_verified,
                  k.email, k.phone, k.address, k.website, k.about, k.products, k.field_provenance,
                  k.verification_status, k.enrichment_status,
                  k.last_verified_at, k.last_http_check_at, k.last_http_status
             FROM agents a INNER JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`,
        ).all(id);
      }

      let judgeCalls = 0;
      const approve = async () => { judgeCalls++; return { approved: true, reason: "identitet bekreftet" }; };
      const reject = async () => { judgeCalls++; return { approved: false, reason: "for tynt grunnlag" }; };

      async function runOne(id: string, flag: string | undefined, judgeFn: any) {
        judgeCalls = 0;
        if (flag === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
        else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = flag;
        const result = await runVerifierBatch({
          db,
          pickFn: pickOnly(id),
          headProbe: async () => 200,
          brregLookup: null,
          urlProbeFetch: (async () => ({ status: 200 })) as any,
          secondLineJudgeFn: judgeFn,
        });
        return result.results[0];
      }

      // ── AK1: gate passes, single-source address, second line passes ──
      seed("ak1");
      {
        const r = await runOne("ak1", "true", approve);
        assertEq(r.passed, true, "ak1-0: fixture sanity — first-line gate passes");
        assertEq(r.new_verification_status, "verified", "ak1-1: stays verified when the second line passes");
        assertEq(r.verified_second_line, true, "ak1-2: VerifierResult.verified_second_line=true");
        assertEq(judgeCalls, 1, "ak1-3: judge called exactly once");
        const k = row("ak1");
        assertEq(k.verification_status, "verified", "ak1-4: DB verification_status=verified");
        assertEq(k.verified_second_line, 1, "ak1-5: DB verified_second_line=1");
        const csr = r.cross_source_reason as any;
        assertEq(csr.address?.verdict, "review_required", "ak1-6: first-line address verdict was review_required");
        assertEq(csr.second_line?.attempted, true, "ak1-7: second_line recorded as attempted");
        assertEq(csr.second_line?.passes, true, "ak1-8: second_line recorded as passed");
      }

      // AK1b: zero address sources -> data_insufficient, second line still rescues.
      seed("ak1b", { field_provenance: {} });
      {
        const r = await runOne("ak1b", "true", approve);
        assertEq(r.new_verification_status, "verified", "ak1b-1: data_insufficient address verdict -> second line passes -> verified");
      }

      // ── AK2: guards keep the demotion; judge never called ────────────
      const guardCases: Array<{ id: string; label: string; seed: Parameters<typeof seed>[1]; expected: string }> = [
        {
          id: "g-wo",
          label: "website_ownership_unverified",
          seed: { field_provenance: { ...SINGLE_SOURCE_ADDRESS, website_ownership: { status: "unverified" } } },
          expected: "review_required",
        },
        {
          id: "g-coh",
          label: "domain coherence failure",
          seed: { agentUrl: "https://annengard.no" },
          expected: "review_required",
        },
        {
          id: "g-inf",
          label: "inference_only_fields (products)",
          seed: {
            field_provenance: {
              ...SINGLE_SOURCE_ADDRESS,
              products: [{ value: "Jordbær", source_type: "category_inference", source_url: null, fetched_at: "2026-11-01T00:00:00Z" }],
            },
          },
          expected: "review_required",
        },
        {
          id: "g-email",
          label: "corroborated_email_missing (platform-owned email domain)",
          seed: { email: "post@rettfrabonden.com", agentUrl: "https://rettfrabonden.com", website: "https://rettfrabonden.com" },
          expected: "review_required",
        },
        { id: "g-opt", label: "prior status opt_out", seed: { status: "opt_out" }, expected: "review_required" },
        { id: "g-term", label: "prior status terminal_unconfirmable", seed: { status: "terminal_unconfirmable" }, expected: "review_required" },
        {
          id: "g-para",
          label: "paraply e-mail",
          seed: { email: "post@hanen.no", agentUrl: "https://hanen.no", website: "https://hanen.no" },
          expected: "paraply_epost_mangler",
        },
      ];
      for (const g of guardCases) {
        seed(g.id, g.seed);
        const r = await runOne(g.id, "true", approve);
        assertEq(r.passed, true, `ak2-${g.id}-0: fixture sanity — gate passes (${g.label})`);
        assertEq(r.new_verification_status, g.expected, `ak2-${g.id}-1: ${g.label} -> still demoted (${g.expected})`);
        assertEq(r.verified_second_line, false, `ak2-${g.id}-2: ${g.label} -> verified_second_line=false`);
        assertEq(judgeCalls, 0, `ak2-${g.id}-3: ${g.label} -> judge not called`);
      }

      // ── AK3: second line does not pass -> as today ───────────────────
      seed("ak3");
      {
        const r = await runOne("ak3", "true", reject);
        assertEq(r.new_verification_status, "review_required", "ak3-1: judge rejects -> review_required, as before");
        assertEq(r.verified_second_line, false, "ak3-2: verified_second_line=false");
        assertEq(judgeCalls, 1, "ak3-3: judge was consulted");
        assertEq(row("ak3").verification_status, "review_required", "ak3-4: DB verification_status=review_required");
      }

      // ── AK4: flag off -> as today, judge never called ────────────────
      for (const flag of [undefined, "false"] as const) {
        const id = `ak4-${flag ?? "unset"}`;
        seed(id);
        const r = await runOne(id, flag, approve);
        assertEq(r.new_verification_status, "review_required", `ak4-${flag}: flag off -> review_required, as before`);
        assertEq(judgeCalls, 0, `ak4-${flag}: flag off -> judge not called`);
        assertEq((r.cross_source_reason as any).second_line, undefined, `ak4-${flag}: flag off -> no second_line record`);
      }
    } catch (err: any) {
      failed++;
      failures.push("second-line-after-enrichment: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevFlag === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
      else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = prevFlag;
      try { db.close(); } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierSecondLineAfterEnrichmentTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      for (const f of summary.failures) console.log(f);
      process.exit(1);
    }
  });
}
