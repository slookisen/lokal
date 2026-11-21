/**
 * admin-verifier-claim-counts-http-unreachable.test.ts — dev-request
 * 2026-10-26-lokal-agent-verifier-snapshot-drift-toleranse, slice 6.
 *
 * The http_unreachable gauge (claim meta kind http_unreachable_known_total,
 * endpoint kind http_unreachable, k.homepage_unreachable_since IS NOT NULL)
 * drifts between the agent's read and the probe 10-12 h later; the probe
 * required an exact match ("http_unreachable snapshot 93 != claim 95").
 * The gauge cannot be rebuilt as of read_at (no change log; clears leave no
 * trace; re-stamps overwrite), so it gets the queue kinds' fixed ±2 fallback.
 *
 * Coverage:
 *   - snapshotClaimDecision(http_unreachable): exact -> match; off by 2 (both
 *     directions) -> match; off by 3 -> mismatch; the 93/95 shape matches;
 *     the claim meta kind alias behaves the same; a drift_bound/count_at_read
 *     passed in is ignored (no wider margin).
 *   - Non-queue exact kinds (brreg_inactive_flagged, agents_domain_incoherent)
 *     still require an exact match (off by 1 -> mismatch).
 *   - Queue kinds still route to snapshotDriftDecision unchanged.
 *   - Endpoint: http_unreachable snapshot response keys unchanged; a clear and
 *     a new park after the read move the count by 2 and the decision matches;
 *     drift_since on http_unreachable is still a 400.
 *
 * Exported runAdminVerifierClaimCountsHttpUnreachableTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-verifier-claim-counts-http-unreachable.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, url: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const [path, qs] = url.split("?");
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path,
      query: Object.fromEntries(new URLSearchParams(qs || "")),
      headers,
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
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined });
    });
  });
}

export function runAdminVerifierClaimCountsHttpUnreachableTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "admin-verifier-claim-counts-hu-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    try {
      delete require.cache[require.resolve("./admin-verifier-claim-counts")];
      const mod = require("./admin-verifier-claim-counts") as typeof import("./admin-verifier-claim-counts");
      const d = mod.snapshotClaimDecision;

      // ── Pure decision rule.
      assertEq(d("http_unreachable", 95, 95), { matched: true, diff: 0, tolerance: 2 }, "hu-01: exact -> match");
      assertEq(d("http_unreachable", 95, 93), { matched: true, diff: 2, tolerance: 2 }, "hu-02: 93 vs claim 95 (observed failure) -> match");
      assertEq(d("http_unreachable", 95, 97), { matched: true, diff: 2, tolerance: 2 }, "hu-03: off by +2 -> match");
      assertEq(d("http_unreachable", 95, 92), { matched: false, diff: 3, tolerance: 2 }, "hu-04: off by -3 -> mismatch");
      assertEq(d("http_unreachable", 95, 98), { matched: false, diff: 3, tolerance: 2 }, "hu-05: off by +3 -> mismatch");
      assertEq(
        d("http_unreachable_known_total", 95, 93),
        { matched: true, diff: 2, tolerance: 2 },
        "hu-06: claim meta kind alias http_unreachable_known_total -> same ±2",
      );
      assertEq(d("http_unreachable_known_total", 95, 92).matched, false, "hu-07: alias off by 3 -> mismatch");
      assertEq(
        d("http_unreachable", 95, 105, 50, 95),
        { matched: false, diff: 10, tolerance: 2 },
        "hu-08: drift_bound/count_at_read passed in are ignored for http_unreachable (no wider margin)",
      );

      // Non-queue exact kinds are unchanged.
      assertEq(d("brreg_inactive_flagged", 10, 10), { matched: true, diff: 0, tolerance: 0 }, "hu-09: brreg_inactive_flagged exact -> match");
      assertEq(d("brreg_inactive_flagged", 10, 11), { matched: false, diff: 1, tolerance: 0 }, "hu-10: brreg_inactive_flagged off by 1 -> mismatch (exact required)");
      assertEq(d("agents_domain_incoherent", 7, 9), { matched: false, diff: 2, tolerance: 0 }, "hu-11: agents_domain_incoherent off by 2 -> mismatch (exact required)");
      assertEq(d("agents_domain_incoherent", 7, 7, 50, 7).matched, true, "hu-12: agents_domain_incoherent exact -> match");
      assertEq(d("agents_domain_incoherent", 7, 8, 50, 7).matched, false, "hu-13: drift args never widen an exact kind");

      // Queue kinds route to snapshotDriftDecision unchanged.
      for (const k of ["agents_pending_verify", "agents_review_required", "agents_data_insufficient"]) {
        assertEq(
          [d(k, 625, 630, 5), d(k, 100, 150, 50, 97), d(k, 71, 74, 0)],
          [mod.snapshotDriftDecision(625, 630, 5), mod.snapshotDriftDecision(100, 150, 50, 97), mod.snapshotDriftDecision(71, 74, 0)],
          `hu-14: ${k} decision identical to snapshotDriftDecision`,
        );
      }
      assertEq(mod.SNAPSHOT_FIXED_TOLERANCE_KINDS as readonly string[], ["http_unreachable"], "hu-15: only http_unreachable added to the fixed ±2 set");

      // ── Endpoint: gauge moves by 2 after the read.
      const db = new Database(":memory:");
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      const insAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, 1)`,
      );
      const insKnow = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, verification_status, homepage_unreachable_since, updated_at, about, field_provenance)
         VALUES (?, 'verified', ?, '2026-11-01 00:00:00', 'A test farm shop', '{}')`,
      );
      for (let i = 0; i < 12; i++) {
        insAgent.run(`hu-${i}`, `hu-${i} AS`, `key-hu-${i}`);
        insKnow.run(`hu-${i}`, i < 5 ? "2026-11-10T08:00:00.000Z" : null);
      }
      const router = mod.default;
      const get = (qs: string) => callRoute(router, `/?${qs}`, { "x-admin-key": testKey });

      const r0 = await get("kind=http_unreachable&mode=snapshot");
      assertEq(
        [r0.status, Object.keys(r0.body).sort(), r0.body.count],
        [200, ["count", "kind", "mode", "sample", "since", "success", "until"], 5],
        "hu-16: snapshot response keys unchanged, count = 5",
      );
      const claim = r0.body.count as number;
      // After the read: one cleared by a successful fetch (-1), one re-stamped
      // after backoff (0, but its old timestamp is gone — why no rebuild), three
      // newly parked (+3) -> net +2.
      db.prepare(`UPDATE agent_knowledge SET homepage_unreachable_since = NULL WHERE agent_id = 'hu-0'`).run();
      db.prepare(`UPDATE agent_knowledge SET homepage_unreachable_since = ? WHERE agent_id = 'hu-1'`).run(new Date().toISOString());
      for (const id of ["hu-5", "hu-6", "hu-7"]) {
        db.prepare(`UPDATE agent_knowledge SET homepage_unreachable_since = ? WHERE agent_id = ?`).run(new Date().toISOString(), id);
      }
      const r1 = await get("kind=http_unreachable&mode=snapshot");
      assertEq(r1.body.count, 7, "hu-17: gauge moved 5 -> 7 after the read");
      assertEq(d("http_unreachable", claim, r1.body.count), { matched: true, diff: 2, tolerance: 2 }, "hu-18: probe on drifted gauge (diff 2) -> match");
      db.prepare(`UPDATE agent_knowledge SET homepage_unreachable_since = ? WHERE agent_id = 'hu-8'`).run(new Date().toISOString());
      const r2 = await get("kind=http_unreachable&mode=snapshot");
      assertEq(d("http_unreachable", claim, r2.body.count).matched, false, "hu-19: diff 3 after one more park -> mismatch");

      const r3 = await get(`kind=http_unreachable&mode=snapshot&drift_since=${encodeURIComponent(new Date().toISOString())}`);
      assertEq(r3.status, 400, "hu-20: drift_since on http_unreachable is still a 400 (no reconstruction for this kind)");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminVerifierClaimCountsHttpUnreachableTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
