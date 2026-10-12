/**
 * admin-outreach-pool-stats-population.test.ts — dev-request
 * 2026-10-11-controller-to-admin-endepunkter-uenige-om-verified-beholdningen.
 *
 * GET /admin/outreach-ready-pool/stats `by_verification_status` must classify
 * the SAME population the same way as GET /admin/dod-bulk: producers without
 * umbrella_type, LEFT JOIN agent_knowledge, no knowledge row = 'unverified'.
 * Before the fix it grouped every agent_knowledge row, so umbrella/non-producer
 * rows leaked into paraply_epost_mangler/verified/... and producers without a
 * knowledge row were missing ('unverified' did not exist in the output).
 *
 * Standalone: npx tsx src/routes/admin-outreach-pool-stats-population.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

export async function runAdminOutreachPoolStatsPopulationTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDb = initMod.getDb();
  const testKey = process.env.ADMIN_KEY || "admin-outreach-pool-stats-population-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = testKey;
  delete require.cache[require.resolve("./admin-outreach-pool")];
  delete require.cache[require.resolve("./admin-dod-bulk")];
  const statsRouter = require("./admin-outreach-pool").default;
  const dodRouter = require("./admin-dod-bulk").default;

  const db = new Database(":memory:");
  try {
    initMod.__initSchemaForTesting(db as any);
    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, umbrella_type, api_key)
       VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?)`,
    );
    const insertK = db.prepare(`INSERT INTO agent_knowledge (agent_id, verification_status) VALUES (?, ?)`);
    const fixtures: Array<{ id: string; role: string; umbrella: string | null; status: string | null }> = [
      { id: "p-verified-1", role: "producer", umbrella: null, status: "verified" },
      { id: "p-verified-2", role: "producer", umbrella: null, status: "verified" },
      { id: "p-pending", role: "producer", umbrella: null, status: "pending_verify" },
      { id: "p-no-knowledge-row", role: "producer", umbrella: null, status: null },
      { id: "u-paraply", role: "producer", umbrella: "paraply", status: "paraply_epost_mangler" },
      { id: "u-verified", role: "producer", umbrella: "paraply", status: "verified" },
      { id: "c-consumer", role: "consumer", umbrella: null, status: "pending_verify" },
    ];
    for (const f of fixtures) {
      insertAgent.run(f.id, f.id, `${f.id} d`, `${f.id}@dummy.invalid`, `https://${f.id}.invalid`, f.role, f.umbrella, `key-${f.id}`);
      if (f.status !== null) insertK.run(f.id, f.status);
    }
    initMod.__setDbForTesting(db as any);

    const stats = await callRoute(statsRouter, { url: "/stats", headers: { "x-admin-key": testKey } });
    assertEq(stats.status, 200, "stats-pop-01: GET /stats -> 200");
    const sortKeys = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    const toMap = (rows: Array<{ k: string; c: number }>) => sortKeys(Object.fromEntries(rows.map((r) => [r.k, r.c])));
    const byStatus = toMap(stats.body?.by_verification_status ?? []);
    assertEq(byStatus, sortKeys({ verified: 2, pending_verify: 1, unverified: 1 }),
      "stats-pop-02: by_verification_status is producer-scoped, excludes umbrella/non-producer rows, includes 'unverified' for a producer without knowledge row");

    const all = toMap(stats.body?.by_verification_status_all_knowledge_rows ?? []);
    assertEq(all, sortKeys({ verified: 3, pending_verify: 2, paraply_epost_mangler: 1 }),
      "stats-pop-03: by_verification_status_all_knowledge_rows keeps the unscoped GROUP BY over agent_knowledge");

    const dod = await callRoute(dodRouter, { url: "/", headers: { "x-admin-key": testKey } });
    assertEq(dod.status, 200, "stats-pop-04: GET /admin/dod-bulk -> 200");
    const dodCounts: Record<string, number> = {};
    for (const a of dod.body?.agents ?? []) dodCounts[a.verification_status] = (dodCounts[a.verification_status] ?? 0) + 1;
    assertEq(byStatus, sortKeys(dodCounts), "stats-pop-05: pool-stats by_verification_status === dod-bulk per-status counts (parity, +/-0)");
  } finally {
    initMod.__setDbForTesting(prevDb as any);
    db.close();
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminOutreachPoolStatsPopulationTests({ log: true }).then((s) => {
    console.log(`${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
