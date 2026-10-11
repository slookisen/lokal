/**
 * lokal-agent-verifier-snapshot-claims.test.ts — dev-request
 * 2026-10-09-lokal-agent-verifier-batch-claim-vs-snapshot-probe-mismatch.
 *
 * buildRunEnvelope used to claim per-batch tallies for six snapshot-semantic
 * kinds while platform-verifier probes claim-counts?mode=snapshot (DB-wide), so
 * every run mismatched by construction. With `snapshotCounts` the six kinds
 * claim the DB-wide count; getSnapshotClaimCounts must equal the endpoint's
 * mode=snapshot count for every kind.
 *
 * Exported runLokalAgentVerifierSnapshotClaimsTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/agents/lokal-agent-verifier-snapshot-claims.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { buildRunEnvelope, type VerifierResult } from "./lokal-agent-verifier";
import { getSnapshotClaimCounts, SNAPSHOT_CLAIM_KINDS } from "../routes/admin-verifier-claim-counts";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runLokalAgentVerifierSnapshotClaimsTests(
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
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
    const prevDb = initMod.getDb();
    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      let n = 0;
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, verification_status, homepage_unreachable_since, verification_review_reason,
            domain_reconciliation_outcome, about, field_provenance)
         VALUES (?, ?, ?, ?, ?, 'A test farm shop', '{}')`,
      );
      function seed(
        id: string,
        f: { status?: string; unreachable?: string | null; reason?: string; domain?: string | null; active?: number },
      ): void {
        n++;
        insertAgent.run(id, `${id} AS`, `key-${id}-${n}`, f.active ?? 1);
        insertKnowledge.run(id, f.status ?? "unverified", f.unreachable ?? null, f.reason ?? "{}", f.domain ?? null);
      }

      // 3 review_required (+1 inactive, excluded), 2 pending_verify, 1 data_insufficient,
      // 2 http_unreachable, 1 brreg_inactive, 2 domain_incoherent, 4 verified (not a snapshot kind).
      seed("rr1", { status: "review_required" });
      seed("rr2", { status: "review_required" });
      seed("rr3", { status: "review_required", unreachable: "2026-10-01T00:00:00.000Z" });
      seed("rr-inactive", { status: "review_required", active: 0 });
      seed("pv1", { status: "pending_verify" });
      seed("pv2", { status: "pending_verify", domain: "manual_review_needed" });
      seed("di1", { status: "data_insufficient", reason: JSON.stringify({ terminal_reason: "brreg_inactive" }) });
      seed("un1", { unreachable: "2026-10-02T00:00:00.000Z" });
      seed("dc1", { domain: "circular_scramble_candidate" });
      for (let i = 0; i < 4; i++) seed(`v${i}`, { status: "verified" });

      const snap = getSnapshotClaimCounts(db as any);
      assertEq(
        snap,
        {
          agents_review_required: 3,
          agents_pending_verify: 2,
          agents_data_insufficient: 1,
          http_unreachable: 2,
          brreg_inactive_flagged: 1,
          agents_domain_incoherent: 2,
        },
        "sc-01: getSnapshotClaimCounts = DB-wide current-state counts, inactive agents excluded",
      );

      // Must equal what the endpoint itself answers for mode=snapshot.
      const prevKey = process.env.ADMIN_KEY;
      process.env.ADMIN_KEY = "snapshot-claims-test-key";
      try {
        delete require.cache[require.resolve("../routes/admin-verifier-claim-counts")];
        const route = require("../routes/admin-verifier-claim-counts").default;
        for (const kind of SNAPSHOT_CLAIM_KINDS) {
          const body: any = await new Promise((resolve) => {
            const req: any = {
              method: "GET", url: "/", originalUrl: "/", path: "/", ip: "127.0.0.1",
              query: { kind, mode: "snapshot" },
              headers: { "x-admin-key": "snapshot-claims-test-key" },
              get(name: string) { return this.headers[name.toLowerCase()]; },
            };
            const res: any = {
              statusCode: 200,
              status(c: number) { this.statusCode = c; return this; },
              json(p: any) { resolve(p); return this; },
              end() { resolve(undefined); return this; },
            };
            route.handle(req, res, () => resolve(undefined));
          });
          assertEq(snap[kind], body?.count, `sc-02: ${kind} helper count == endpoint mode=snapshot count`);
        }
      } finally {
        if (prevKey === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevKey;
      }

      // Envelope: batch of 1 review_required result, snapshot says 3.
      const results = [makeResult({ agent_id: "b1", new_verification_status: "review_required" })];
      const base = { run_id: "r", started_at: "2026-10-11T00:00:00.000Z", finished_at: "2026-10-11T00:01:00.000Z", results };

      const legacy = buildRunEnvelope(base);
      assertEq(findClaim(legacy, "agents_review_required")?.value, 1, "sc-03: without snapshotCounts, batch tally is kept (back-compat)");
      assertEq(findClaim(legacy, "agents_review_required")?.meta, { kind: "agents_review_required" }, "sc-04: legacy meta unchanged");

      const withSnap = buildRunEnvelope({ ...base, snapshotCounts: snap });
      const rr = findClaim(withSnap, "agents_review_required");
      assertEq(rr?.value, 3, "sc-05: with snapshotCounts, review_required claims the DB-wide count");
      assertEq(rr?.meta, { kind: "agents_review_required", scope: "snapshot", batch_count: 1 }, "sc-06: batch tally preserved in meta.batch_count");
      for (const kind of SNAPSHOT_CLAIM_KINDS) {
        assertEq(findClaim(withSnap, kind)?.value, snap[kind], `sc-07: ${kind} claims snapshot value`);
      }
      // agents_verified is a per-run delta and must be untouched.
      assertEq(findClaim(withSnap, "agents_verified")?.value, 0, "sc-08: agents_verified stays the per-run count");
      assertEq(findClaim(withSnap, "agents_verified")?.meta, { kind: "agents_verified" }, "sc-09: agents_verified meta unchanged");
      // Partial snapshot object: kinds missing from it fall back to batch.
      const partial = buildRunEnvelope({ ...base, snapshotCounts: { agents_pending_verify: 7 } });
      assertEq(findClaim(partial, "agents_pending_verify")?.value, 7, "sc-10: partial snapshot applies to present kind");
      assertEq(findClaim(partial, "agents_review_required")?.value, 1, "sc-11: partial snapshot falls back to batch for absent kind");
    } finally {
      initMod.__setDbForTesting(prevDb as any);
      try { db.close(); } catch { /* ignore */ }
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierSnapshotClaimsTests({ log: true }).then((s) => {
    console.log(`${s.passed} passed, ${s.failed} failed`);
    if (s.failed) { console.log(s.failures.join("\n")); process.exit(1); }
  });
}
