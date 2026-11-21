/**
 * admin-verifier-claim-counts-drift-bound.test.ts — dev-request
 * 2026-10-26-lokal-agent-verifier-snapshot-drift-toleranse, slice 4.
 *
 * lokal-agent-verifier reads the queue counts (agents_pending_verify /
 * agents_review_required / agents_data_insufficient) at run time; the
 * platform-verifier probe reads them again 10-12 h later, after real writes
 * moved the queues by 3-6, so the fixed +-2 rule failed ~55% of runs. The
 * queue claims now carry meta.read_at, and mode=snapshot&drift_since=<read_at>
 * returns drift_bound = distinct agents that entered/left the queue since
 * (from the trigger-fed agent_queue_state_events log).
 *
 * Coverage:
 *   - drift_since absent -> response unchanged (keys, since/until null, and
 *     a garbage since/until still ignored).
 *   - drift_since present -> drift_bound counts only queue moves at/after
 *     drift_since, for this kind only; writes that never touch updated_at
 *     are still counted; unrelated updated_at bumps are not.
 *   - is_active toggles and deletes count.
 *   - bad drift_since -> 400; drift_since on a non-queue kind -> 400.
 *   - AK4 replay: claim 625 at read, 5 rows enter pending_verify after the
 *     read -> count 630, drift_bound 5 -> matched; the same numbers without a
 *     bound (old rule) fail; a constructed real mismatch still fails.
 *   - buildRunEnvelope puts meta.read_at on the three queue claims only.
 *
 * Exported runAdminVerifierClaimCountsDriftBoundTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-verifier-claim-counts-drift-bound.test.ts
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
}

function callRoute(router: any, url: string, headers: Record<string, string>): Promise<RouteResult> {
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

export function runAdminVerifierClaimCountsDriftBoundTests(
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
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "admin-verifier-claim-counts-drift-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      delete require.cache[require.resolve("./admin-verifier-claim-counts")];
      const mod = require("./admin-verifier-claim-counts") as typeof import("./admin-verifier-claim-counts");
      const router = mod.default;
      const get = (qs: string) => callRoute(router, `/?${qs}`, { "x-admin-key": testKey });

      // Deterministic timeline: every logged change is restamped per phase so
      // drift_since sits between phases. Anchored 8 h before the real clock so
      // it stays inside the 14-day log retention horizon (slice 5).
      const BASE_MS = Math.floor(Date.now() / 1000) * 1000 - 8 * 3600_000;
      const at = (offsetMs: number) => new Date(BASE_MS + offsetMs).toISOString();
      const asLogged = (iso: string) => iso.slice(0, 23).replace("T", " ");
      const T_BEFORE = asLogged(at(0)); // history before the run's read
      const READ_AT = at(35 * 60_000 + 12_345); // claim meta.read_at
      const T_AFTER = asLogged(at(6 * 3600_000 + 10 * 60_000)); // writes between read and probe
      const stampPhase = (fromId: number, at: string) =>
        db.prepare(`UPDATE agent_queue_state_events SET changed_at = ? WHERE id > ?`).run(at, fromId);
      const maxEventId = () =>
        ((db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM agent_queue_state_events`).get() as any).m as number);

      const insAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, 1)`,
      );
      const insKnow = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, verification_status, updated_at, about, field_provenance)
         VALUES (?, ?, '2026-11-01 00:00:00', 'A test farm shop', '{}')`,
      );
      const seed = (id: string, status: string) => {
        insAgent.run(id, `${id} AS`, `key-${id}`);
        insKnow.run(id, status);
      };

      // ── Phase A (before read): 625 pending_verify, 10 unverified, 4
      // review_required, 3 verified.
      db.transaction(() => {
        for (let i = 0; i < 625; i++) seed(`pv-${String(i).padStart(3, "0")}`, "pending_verify");
        for (let i = 0; i < 10; i++) seed(`un-${i}`, "unverified");
        for (let i = 0; i < 4; i++) seed(`rr-${i}`, "review_required");
        for (let i = 0; i < 3; i++) seed(`vf-${i}`, "verified");
      })();
      stampPhase(0, T_BEFORE);
      const afterA = maxEventId();
      assertEq(afterA >= 642, true, "dbd-01: inserts into agent_knowledge are logged by the trigger");

      // drift_since absent -> response unchanged.
      let r = await get(`kind=agents_pending_verify&mode=snapshot`);
      assertEq(r.status, 200, "dbd-02: snapshot without drift_since -> 200");
      assertEq(r.body.count, 625, "dbd-03: snapshot count at read time = 625");
      assertEq(
        Object.keys(r.body),
        ["success", "kind", "mode", "count", "since", "until", "sample"],
        "dbd-04: without drift_since the response keys (and order) are unchanged",
      );
      r = await get(`kind=agents_pending_verify&mode=snapshot&since=not-a-date&until=x`);
      assertEq([r.status, r.body.since, r.body.until, "drift_bound" in r.body], [200, null, null, false], "dbd-05: snapshot still ignores a supplied since/until");

      // Before any post-read write the bound is 0.
      r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=${READ_AT}`);
      assertEq([r.status, r.body.count, r.body.drift_bound], [200, 625, 0], "dbd-06: no moves since read -> drift_bound 0");
      assertEq(r.body.drift_since, asLogged(READ_AT), "dbd-07: drift_since echoed in changed_at's format, ms kept");
      assertEq(
        Object.keys(r.body),
        ["success", "kind", "mode", "count", "since", "until", "sample", "drift_since", "drift_bound", "count_at_read"],
        "dbd-08: drift_since adds only drift_since + drift_bound + count_at_read at the end",
      );

      // ── Phase B (after read, before probe): the failure shape.
      // 5 unverified -> pending_verify via a raw UPDATE that does NOT touch
      // updated_at (several prod write sites do exactly this).
      db.prepare(
        `UPDATE agent_knowledge SET verification_status = 'pending_verify' WHERE agent_id IN ('un-0','un-1','un-2','un-3','un-4')`,
      ).run();
      // Unrelated enrichment writes bump updated_at on 50 pending rows: not queue moves.
      db.prepare(
        `UPDATE agent_knowledge SET updated_at = '2026-11-15 12:00:00', about = 'enriched' WHERE agent_id LIKE 'pv-0%'`,
      ).run();
      // A same-status rewrite is not a move either.
      db.prepare(`UPDATE agent_knowledge SET verification_status = 'pending_verify' WHERE agent_id = 'pv-100'`).run();
      // A verified -> review_required move touches review_required only.
      db.prepare(`UPDATE agent_knowledge SET verification_status = 'review_required' WHERE agent_id = 'vf-0'`).run();
      stampPhase(afterA, T_AFTER);

      r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=${READ_AT}`);
      assertEq(r.body.count, 630, "dbd-09: pending_verify count at probe time = 630");
      assertEq(r.body.drift_bound, 5, "dbd-10: drift_bound counts the 5 entries only (not updated_at bumps, not same-status rewrites, not other queues)");
      const replay = mod.snapshotDriftDecision(625, r.body.count, r.body.drift_bound);
      assertEq(replay, { matched: true, diff: 5, tolerance: 5 }, "dbd-11: AK4 replay — claim 625 / probe 630 / drift_bound 5 -> matched");
      assertEq(mod.snapshotDriftDecision(625, 630, null).matched, false, "dbd-12: same numbers under the old fixed ±2 rule fail (the false alarm)");
      assertEq(mod.snapshotDriftDecision(640, 630, 5), { matched: false, diff: 10, tolerance: 5 }, "dbd-13: constructed real mismatch (diff 10 > max(2, 5)) still fails");
      assertEq(mod.snapshotDriftDecision(1, 67, 3).matched, false, "dbd-14: claim 1 vs snapshot 67 (sweep-2026-11-03 shape) still fails");
      assertEq(mod.snapshotDriftDecision(71, 73, 0), { matched: true, diff: 2, tolerance: 2 }, "dbd-15: drift_bound below 2 keeps the ±2 floor");
      assertEq(mod.snapshotDriftDecision(71, 74, 0).matched, false, "dbd-16: diff 3 with drift_bound 0 fails");

      // Earlier drift_since (before phase A) counts phase A too; later one counts nothing.
      r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=${at(-3600_000)}`);
      assertEq(r.body.drift_bound, 630, "dbd-17: drift_since before the history counts every agent that touched the queue");
      r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=${at(7 * 3600_000)}`);
      assertEq(r.body.drift_bound, 0, "dbd-18: changes before drift_since are excluded");

      r = await get(`kind=agents_review_required&mode=snapshot&drift_since=${READ_AT}`);
      assertEq([r.body.count, r.body.drift_bound], [5, 1], "dbd-19: review_required bound is kind-specific (vf-0 entered)");
      r = await get(`kind=agents_data_insufficient&mode=snapshot&drift_since=${READ_AT}`);
      assertEq([r.status, r.body.count, r.body.drift_bound], [200, 0, 0], "dbd-20: data_insufficient supported, nothing moved");

      // ── Phase C: is_active toggle and delete count as moves.
      const afterB = maxEventId();
      db.prepare(`UPDATE agents SET is_active = 0 WHERE id = 'pv-200'`).run();
      db.prepare(`UPDATE agents SET name = 'renamed' WHERE id = 'pv-201'`).run(); // not a move
      db.prepare(`DELETE FROM agents WHERE id = 'pv-202'`).run();
      db.prepare(`DELETE FROM agent_knowledge WHERE agent_id = 'pv-202'`).run(); // FK may be off; drop the orphan too
      stampPhase(afterB, T_AFTER);
      r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=${READ_AT}`);
      assertEq(r.body.count, 628, "dbd-21: deactivating + deleting a pending agent shrinks the count");
      assertEq(r.body.drift_bound, 7, "dbd-22: is_active toggle and delete each count once; a rename does not");
      assertEq(mod.snapshotDriftDecision(625, 628, 7).matched, true, "dbd-23: mixed in/out moves within the bound -> matched");

      // Wall-clock path (no restamping): a status write right now is inside a
      // drift_since of one minute ago.
      const recent = new Date(Date.now() - 60_000).toISOString();
      db.prepare(`UPDATE agent_knowledge SET verification_status = 'data_insufficient' WHERE agent_id = 'un-5'`).run();
      r = await get(`kind=agents_data_insufficient&mode=snapshot&drift_since=${recent}`);
      assertEq([r.body.count, r.body.drift_bound], [1, 1], "dbd-24: trigger stamps changed_at with the real clock, comparable to an ISO drift_since");

      // Validation.
      r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=not-a-date`);
      assertEq([r.status, r.body.success], [400, false], "dbd-25: unparseable drift_since -> 400");
      r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=`);
      assertEq(r.status, 400, "dbd-26: empty drift_since -> 400");
      r = await get(`kind=http_unreachable&mode=snapshot&drift_since=${READ_AT}`);
      assertEq(r.status, 400, "dbd-27: drift_since on a non-queue kind -> 400");
      r = await get(`kind=agents_pending_verify&since=${READ_AT}&until=${at(6 * 3600_000)}&drift_since=${READ_AT}`);
      assertEq([r.status, "drift_bound" in r.body], [200, false], "dbd-28: delta mode ignores drift_since (response unchanged)");

      // Log unreadable -> null (caller falls back to ±2), never a throw.
      const bare = new Database(":memory:");
      assertEq(mod.getSnapshotDriftBound(bare, "pending_verify", asLogged(READ_AT)), null, "dbd-29: missing event log -> drift_bound null");
      bare.close();

      // ── Envelope: meta.read_at on the three queue claims only.
      const { buildRunEnvelope } = require("../agents/lokal-agent-verifier") as typeof import("../agents/lokal-agent-verifier");
      const snapshotCounts = mod.getSnapshotClaimCounts(db);
      const base = { run_id: "run-x", started_at: "s", finished_at: "f", results: [] as any[] };
      const env: any = buildRunEnvelope({ ...base, snapshotCounts, snapshotReadAt: READ_AT });
      const metaOf = (e: any, kind: string) => e.claims.find((c: any) => c.meta?.kind === kind)?.meta;
      for (const kind of ["agents_review_required", "agents_pending_verify", "agents_data_insufficient"]) {
        assertEq(metaOf(env, kind).read_at, READ_AT, `dbd-30: ${kind} claim carries meta.read_at`);
      }
      for (const kind of ["brreg_inactive_flagged", "agents_domain_incoherent", "http_unreachable_known_total", "agents_verified"]) {
        assertEq("read_at" in metaOf(env, kind), false, `dbd-31: ${kind} claim has no read_at`);
      }
      const noReadAt: any = buildRunEnvelope({ ...base, snapshotCounts });
      assertEq(
        metaOf(noReadAt, "agents_pending_verify"),
        { kind: "agents_pending_verify", scope: "snapshot", batch_count: 0 },
        "dbd-32: without snapshotReadAt the snapshot meta is unchanged",
      );
      const legacy: any = buildRunEnvelope({ ...base, snapshotReadAt: READ_AT });
      assertEq(metaOf(legacy, "agents_pending_verify"), { kind: "agents_pending_verify" }, "dbd-33: batch-tally claims (no snapshotCounts) never get read_at");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminVerifierClaimCountsDriftBoundTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
