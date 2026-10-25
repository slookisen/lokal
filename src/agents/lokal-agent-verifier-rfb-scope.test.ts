/**
 * lokal-agent-verifier-rfb-scope.test.ts — dev-request
 * 2026-10-01-rfb-verifier-paraplyer-og-vertikaler-ut-c6.
 *
 * The RFB verifier pickers (pickBatch, pickBatchBiased, pickPendingVerifyBatch)
 * share RFB_VERIFIER_SCOPE_SQL and so skip umbrella agents and rows from other
 * verticals; explicit ids (pickByIds) still reach anything; and
 * GET /admin/outreach-ready-pool/stats gets the additive
 * `by_verification_status_rfb_producers`.
 *
 * Wired into tests/test.ts (runSerial, same convention as
 * admin-run-verifier-agentids.test.ts).
 * Standalone: npx tsx src/agents/lokal-agent-verifier-rfb-scope.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import {
  pickBatch,
  pickBatchBiased,
  pickPendingVerifyBatch,
  pickByIds,
} from "./lokal-agent-verifier";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key-rfb-scope";

function callStats(router: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { "x-admin-key": ADMIN_KEY };
    const req: any = {
      method: "GET", url: "/stats", originalUrl: "/stats", query: {}, headers, ip: "127.0.0.1",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined }));
  });
}

export async function runLokalAgentVerifierRfbScopeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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

  const prevAdminKey = process.env.ADMIN_KEY;
  const prevDb = initMod.getDb();
  const db = new Database(":memory:");
  try {
    process.env.ADMIN_KEY = ADMIN_KEY;
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);

    const insA = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified, umbrella_type, vertical_id)
       VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', ?, ?, 0, ?, ?)`,
    );
    const insK = db.prepare(
      `INSERT INTO agent_knowledge (agent_id, email, products, verification_status) VALUES (?, 'x@example.no', '[]', ?)`,
    );
    function seed(id: string, status: string, o: { role?: string; umbrella?: string | null; vertical?: string } = {}): void {
      insA.run(id, `${id} AS`, o.role ?? "producer", `key-${id}`, o.umbrella ?? null, o.vertical ?? "rfb");
      insK.run(id, status);
    }

    seed("rs-prod-pv", "pending_verify");
    seed("rs-prod-unv", "unverified");
    seed("rs-prod-ver", "verified");
    seed("rs-prod-consumer", "pending_verify", { role: "consumer" });
    seed("rs-umb-pv", "pending_verify", { umbrella: "market" });
    seed("rs-umb-ver", "verified", { umbrella: "market" });
    seed("rs-exp-pv", "pending_verify", { vertical: "experiences" });
    seed("rs-exp-ver", "verified", { vertical: "experiences" });
    seed("rs-dental-unv", "unverified", { vertical: "dental" });

    const ids = (rows: any[]) => rows.map((r) => r.id);
    const outOfScope = ["rs-umb-pv", "rs-umb-ver", "rs-exp-pv", "rs-exp-ver", "rs-dental-unv"];

    const pickers: Array<[string, string[]]> = [
      ["pickBatch", ids(pickBatch(db, 100))],
      ["pickBatchBiased", ids(pickBatchBiased(db, 100))],
      ["pickPendingVerifyBatch", ids(pickPendingVerifyBatch(db, 100))],
    ];
    for (const [name, got] of pickers) {
      assertTrue(got.includes("rs-prod-pv"), `${name}: RFB producer is picked`);
      for (const bad of outOfScope) {
        assertTrue(!got.includes(bad), `${name}: ${bad} (umbrella / other vertical) is NOT picked`);
      }
    }
    // Biased cross-bucket backfill must not leak either (verified-only umbrella/experiences rows).
    assertTrue(ids(pickBatchBiased(db, 100)).includes("rs-prod-ver"), "pickBatchBiased: verified RFB producer still picked");

    // Explicit agentIds are the targeted path — they still reach umbrella and other verticals.
    const explicit = ids(pickByIds(db, ["rs-umb-pv", "rs-exp-pv", "rs-dental-unv"]));
    assertTrue(
      explicit.length === 3 && ["rs-umb-pv", "rs-exp-pv", "rs-dental-unv"].every((i) => explicit.includes(i)),
      "pickByIds: explicit ids reach the umbrella and the other-vertical rows",
    );

    // Stats: new field = role='producer' AND umbrella_type IS NULL AND vertical rfb.
    const { default: router } = require("../routes/admin-outreach-pool") as { default: any };
    const r = await callStats(router);
    assertTrue(r.status === 200, "stats: 200 response");
    const rfb: Array<{ k: string; c: number }> = r.body?.by_verification_status_rfb_producers ?? [];
    const count = (k: string) => rfb.find((x) => x.k === k)?.c ?? 0;
    assertTrue(Array.isArray(r.body?.by_verification_status_rfb_producers), "stats: by_verification_status_rfb_producers present");
    assertTrue(count("pending_verify") === 1, `stats: rfb_producers pending_verify = 1 (got ${count("pending_verify")})`);
    assertTrue(count("unverified") === 1, `stats: rfb_producers unverified = 1 (got ${count("unverified")})`);
    assertTrue(count("verified") === 1, `stats: rfb_producers verified = 1 (got ${count("verified")})`);
    assertTrue(rfb.reduce((s, x) => s + x.c, 0) === 3, "stats: rfb_producers total = 3 (consumer, umbrella, experiences, dental excluded)");
    assertTrue(Array.isArray(r.body?.by_verification_status), "stats: by_verification_status still present");
  } finally {
    initMod.__setDbForTesting(prevDb);
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runLokalAgentVerifierRfbScopeTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed ? 1 : 0);
  });
}
