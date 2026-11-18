/**
 * admin-verifier-claim-counts-count-at-read.test.ts — dev-request
 * 2026-10-26-lokal-agent-verifier-snapshot-drift-toleranse, slice 5.
 *
 * Slice 4's drift_bound is a GROSS bound (A out + B in = net 0, bound 2); over
 * 10-12 h it can grow large enough to hide a real claim mismatch. Slice 5
 * rebuilds the exact queue count as of drift_since (`count_at_read`) from the
 * agent_queue_state_events log, and the probe compares the claim to it with
 * +-2. Each scenario below: seed (stamped before the read) -> take the claim
 * (snapshot count) -> writes after the read -> probe with drift_since=read_at
 * -> count_at_read must equal the claim.
 *
 * Also kills the slice-4 surviving mutants (review N2 of lokal#1592): the
 * agents INSERT / DELETE triggers, COUNT(DISTINCT) -> COUNT(*), and read_at
 * taken after the read (readSnapshotClaimCounts).
 *
 * Exported runAdminVerifierClaimCountsCountAtReadTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-verifier-claim-counts-count-at-read.test.ts
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

const STATUS_FOR_KIND: Record<string, string> = {
  agents_pending_verify: "pending_verify",
  agents_review_required: "review_required",
  agents_data_insufficient: "data_insufficient",
};

export function runAdminVerifierClaimCountsCountAtReadTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const testKey = process.env.ADMIN_KEY || "admin-verifier-claim-counts-car-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    // Timeline anchored 8 h before the real clock (inside the 14-day
    // retention horizon). Events are restamped per phase.
    const BASE_MS = Math.floor(Date.now() / 1000) * 1000 - 8 * 3600_000;
    const at = (offsetMs: number) => new Date(BASE_MS + offsetMs).toISOString();
    const asLogged = (iso: string) => iso.slice(0, 23).replace("T", " ");
    const T_BEFORE = asLogged(at(0));
    const READ_AT = at(35 * 60_000 + 12_345);
    const T_AFTER = asLogged(at(6 * 3600_000));

    try {
      delete require.cache[require.resolve("./admin-verifier-claim-counts")];
      const mod = require("./admin-verifier-claim-counts") as typeof import("./admin-verifier-claim-counts");
      const router = mod.default;
      const get = (qs: string) => callRoute(router, `/?${qs}`, { "x-admin-key": testKey });

      function freshDb(foreignKeys: boolean) {
        const db = new Database(":memory:");
        initMod.__setDbForTesting(db as any);
        initMod.__initSchemaForTesting(db as any);
        db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
        const insAgent = db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
           VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, ?)`,
        );
        const insKnow = db.prepare(
          `INSERT INTO agent_knowledge (agent_id, verification_status, updated_at, about, field_provenance)
           VALUES (?, ?, '2026-11-01 00:00:00', 'A test farm shop', '{}')`,
        );
        const agent = (id: string, active = 1) => insAgent.run(id, `${id} AS`, `key-${id}`, active);
        const know = (id: string, status: string) => insKnow.run(id, status);
        const seed = (id: string, status: string, active = 1) => {
          agent(id, active);
          know(id, status);
        };
        const setStatus = (id: string, status: string) =>
          db.prepare(`UPDATE agent_knowledge SET verification_status = ? WHERE agent_id = ?`).run(status, id);
        const setActive = (id: string, active: number) =>
          db.prepare(`UPDATE agents SET is_active = ? WHERE id = ?`).run(active, id);
        const maxEventId = () =>
          (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM agent_queue_state_events`).get() as any).m as number;
        const stampFrom = (fromId: number, ts: string) =>
          db.prepare(`UPDATE agent_queue_state_events SET changed_at = ? WHERE id > ?`).run(ts, fromId);
        // Baseline queue: 20 pending_verify, 5 unverified, 3 review_required,
        // 2 inactive pending_verify.
        for (let i = 0; i < 20; i++) seed(`pv-${i}`, "pending_verify");
        for (let i = 0; i < 5; i++) seed(`un-${i}`, "unverified");
        for (let i = 0; i < 3; i++) seed(`rr-${i}`, "review_required");
        for (let i = 0; i < 2; i++) seed(`ia-${i}`, "pending_verify", 0);
        return { db, agent, know, seed, setStatus, setActive, maxEventId, stampFrom };
      }
      type Ctx = ReturnType<typeof freshDb>;

      // Runs one scenario and returns { claim, body } for `kind`.
      async function scenario(
        opts: { kind?: string; foreignKeys?: boolean; beforeRead?: (c: Ctx) => void; afterRead: (c: Ctx) => void },
      ) {
        const kind = opts.kind ?? "agents_pending_verify";
        const c = freshDb(opts.foreignKeys ?? true);
        opts.beforeRead?.(c);
        c.stampFrom(0, T_BEFORE);
        const claim = (await get(`kind=${kind}&mode=snapshot`)).body.count as number;
        const mark = c.maxEventId();
        opts.afterRead(c);
        c.stampFrom(mark, T_AFTER);
        const r = await get(`kind=${kind}&mode=snapshot&drift_since=${encodeURIComponent(READ_AT)}`);
        return { claim, status: r.status, body: r.body, c };
      }
      const view = (s: { claim: number; body: any }) => ({
        claim: s.claim,
        count: s.body.count,
        count_at_read: s.body.count_at_read,
        drift_bound: s.body.drift_bound,
      });

      let s = await scenario({ afterRead: (c) => ["un-0", "un-1", "un-2"].forEach((id) => c.setStatus(id, "pending_verify")) });
      assertEq(view(s), { claim: 20, count: 23, count_at_read: 20, drift_bound: 3 }, "car-01: 3 enter -> count_at_read = claim");

      s = await scenario({ afterRead: (c) => ["pv-0", "pv-1"].forEach((id) => c.setStatus(id, "verified")) });
      assertEq(view(s), { claim: 20, count: 18, count_at_read: 20, drift_bound: 2 }, "car-02: 2 leave -> count_at_read = claim");

      s = await scenario({
        afterRead: (c) => {
          c.setStatus("un-0", "pending_verify");
          c.setStatus("un-0", "unverified");
        },
      });
      assertEq(
        view(s),
        { claim: 20, count: 20, count_at_read: 20, drift_bound: 1 },
        "car-03: enter-then-leave (one agent, two events) -> net 0, drift_bound counts the agent once (COUNT DISTINCT)",
      );

      s = await scenario({
        afterRead: (c) => {
          for (let i = 0; i < 10; i++) c.setStatus(`pv-${i}`, "verified");
          for (let i = 0; i < 10; i++) c.seed(`new-${i}`, "pending_verify");
        },
      });
      assertEq(
        view(s),
        { claim: 20, count: 20, count_at_read: 20, drift_bound: 20 },
        "car-04: swap 10 out / 10 in -> count_at_read exact while drift_bound is 20 (gross)",
      );

      s = await scenario({ afterRead: (c) => ["pv-0", "pv-1"].forEach((id) => c.setActive(id, 0)) });
      assertEq(view(s), { claim: 20, count: 18, count_at_read: 20, drift_bound: 2 }, "car-05: deactivate 2 -> count_at_read = claim");

      s = await scenario({ afterRead: (c) => c.setActive("ia-0", 1) });
      assertEq(view(s), { claim: 20, count: 21, count_at_read: 20, drift_bound: 1 }, "car-06: reactivate an agent inactive at read -> count_at_read = claim");

      // Delete with foreign_keys ON (prod): ON DELETE CASCADE removes the
      // knowledge row before any AFTER trigger on agents; the BEFORE DELETE
      // trigger logs the real is_active first.
      s = await scenario({
        afterRead: (c) => {
          c.db.prepare(`DELETE FROM agents WHERE id = 'pv-0'`).run();
          c.db.prepare(`DELETE FROM agents WHERE id = 'ia-0'`).run();
        },
      });
      assertEq(
        [view(s), (s.c.db.prepare(`SELECT COUNT(*) AS n FROM agent_knowledge WHERE agent_id IN ('pv-0','ia-0')`).get() as any).n],
        [{ claim: 20, count: 19, count_at_read: 20, drift_bound: 2 }, 0],
        "car-07: FK on — delete an active and an inactive pending agent (cascade) -> count_at_read = claim",
      );

      // Delete with foreign_keys OFF: only the agents_del trigger sees it
      // (the knowledge row stays as an orphan, not counted by the INNER JOIN).
      s = await scenario({ foreignKeys: false, afterRead: (c) => c.db.prepare(`DELETE FROM agents WHERE id = 'pv-0'`).run() });
      assertEq(
        view(s),
        { claim: 20, count: 19, count_at_read: 20, drift_bound: 1 },
        "car-08: FK off — agents DELETE alone is logged (trg_aqse_agents_del) -> count_at_read = claim",
      );

      // agents INSERT over an orphan knowledge row (FK off): the pair enters
      // the queue only through the agents INSERT trigger.
      s = await scenario({
        foreignKeys: false,
        beforeRead: (c) => c.know("orphan-0", "pending_verify"),
        afterRead: (c) => c.agent("orphan-0"),
      });
      assertEq(
        view(s),
        { claim: 20, count: 21, count_at_read: 20, drift_bound: 1 },
        "car-09: FK off — agents INSERT over an existing knowledge row is logged (trg_aqse_agents_ins) -> count_at_read = claim",
      );

      // An orphan knowledge row (FK off, no agents row) is never in the queue:
      // its status change after the read must not be added back (old_active
      // NULL is not "active" for count_at_read).
      s = await scenario({
        foreignKeys: false,
        beforeRead: (c) => c.know("orphan-1", "pending_verify"),
        afterRead: (c) => c.setStatus("orphan-1", "verified"),
      });
      assertEq(
        [view(s).claim, view(s).count, view(s).count_at_read],
        [20, 20, 20],
        "car-09b: FK off — orphan knowledge row leaving the status does not change count_at_read",
      );

      s = await scenario({ afterRead: (c) => c.seed("brand-new", "pending_verify") });
      assertEq(view(s), { claim: 20, count: 21, count_at_read: 20, drift_bound: 1 }, "car-10: new knowledge row insert -> count_at_read = claim");

      // Events before drift_since are ignored, including an earlier event of
      // an agent that moves again after the read (MIN(id) only over >= since).
      s = await scenario({
        beforeRead: (c) => {
          c.setStatus("un-0", "pending_verify");
          c.setStatus("pv-5", "verified");
        },
        afterRead: (c) => c.setStatus("un-0", "unverified"),
      });
      assertEq(
        view(s),
        { claim: 20, count: 19, count_at_read: 20, drift_bound: 1 },
        "car-11: moves before drift_since ignored; earliest event is taken at/after drift_since only",
      );

      // Mixed moves on another queue.
      s = await scenario({
        kind: "agents_review_required",
        afterRead: (c) => {
          c.setStatus("rr-0", "verified");
          c.setStatus("pv-0", "review_required");
          c.setStatus("pv-1", "review_required");
          c.setActive("rr-1", 0);
          c.setStatus("rr-2", "pending_verify");
          c.setStatus("rr-2", "review_required");
        },
      });
      assertEq(view(s), { claim: 3, count: 3, count_at_read: 3, drift_bound: 5 }, "car-12: review_required mixed in/out/deactivate/round-trip -> exact");

      s = await scenario({ kind: "agents_data_insufficient", afterRead: (c) => c.setStatus("pv-0", "data_insufficient") });
      assertEq(view(s), { claim: 0, count: 1, count_at_read: 0, drift_bound: 1 }, "car-13: data_insufficient supported");

      // Millisecond precision: an event 1 ms before read_at is before the read.
      {
        const c = freshDb(true);
        c.stampFrom(0, T_BEFORE);
        const mark = c.maxEventId();
        c.setStatus("un-0", "pending_verify");
        c.stampFrom(mark, asLogged(new Date(Date.parse(READ_AT) - 1).toISOString()));
        const claim = (await get(`kind=agents_pending_verify&mode=snapshot`)).body.count;
        let r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=${encodeURIComponent(READ_AT)}`);
        assertEq(
          [claim, r.body.count_at_read, r.body.drift_bound],
          [21, 21, 0],
          "car-14: event 1 ms before drift_since is excluded (no rounding down to the second)",
        );
        c.stampFrom(mark, asLogged(READ_AT));
        r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=${encodeURIComponent(READ_AT)}`);
        assertEq([r.body.count_at_read, r.body.drift_bound], [20, 1], "car-15: event at exactly drift_since is included");

        // Retention horizon (14 days).
        const old = new Date(Date.now() - 15 * 24 * 3600_000).toISOString();
        r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=${encodeURIComponent(old)}`);
        assertEq(
          [r.status, r.body.drift_since, r.body.drift_bound, r.body.count_at_read],
          [200, asLogged(old), null, null],
          "car-16: drift_since older than 14 days -> drift_bound and count_at_read null",
        );
        const inside = new Date(Date.now() - 13 * 24 * 3600_000).toISOString();
        r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=${encodeURIComponent(inside)}`);
        assertEq(typeof r.body.count_at_read, "number", "car-17: drift_since 13 days old -> count_at_read numeric");
        assertEq(mod.driftSinceWithinRetention("2026-11-01 00:00:00.000", Date.parse("2026-11-15T00:00:00Z")), true, "car-18: exactly 14 days -> within retention");
        assertEq(mod.driftSinceWithinRetention("2026-11-01 00:00:00.000", Date.parse("2026-11-15T00:00:00.001Z")), false, "car-19: 14 days + 1 ms -> outside retention");

        // Boot pruning: events older than 14 days are deleted, newer kept.
        const oldTs = asLogged(new Date(Date.now() - 15 * 24 * 3600_000).toISOString());
        const keepTs = asLogged(new Date(Date.now() - 13 * 24 * 3600_000).toISOString());
        c.db
          .prepare(`INSERT INTO agent_queue_state_events (agent_id, old_status, new_status, changed_at) VALUES ('x', NULL, 'pending_verify', ?), ('y', NULL, 'pending_verify', ?)`)
          .run(oldTs, keepTs);
        initMod.__initSchemaForTesting(c.db as any);
        const ids = (c.db.prepare(`SELECT agent_id FROM agent_queue_state_events WHERE agent_id IN ('x','y') ORDER BY agent_id`).all() as any[]).map((x) => x.agent_id);
        assertEq(ids, ["y"], "car-20: boot prunes events older than 14 days and keeps newer ones");

        // Log unreadable -> null (fixed ±2 fallback), endpoint still 200.
        for (const t of ["knowledge_ins", "knowledge_upd", "knowledge_del", "agents_ins", "agents_upd", "agents_del"]) {
          c.db.exec(`DROP TRIGGER IF EXISTS trg_aqse_${t}`);
        }
        c.db.exec(`DROP TABLE agent_queue_state_events`);
        r = await get(`kind=agents_pending_verify&mode=snapshot&drift_since=${encodeURIComponent(READ_AT)}`);
        assertEq(
          [r.status, r.body.count, r.body.drift_bound, r.body.count_at_read],
          [200, 21, null, null],
          "car-21: event log missing -> drift_bound and count_at_read null, count still served",
        );
      }
      const bare = new Database(":memory:");
      assertEq(mod.getSnapshotCountAtRead(bare, "pending_verify", asLogged(READ_AT), 5), null, "car-22: getSnapshotCountAtRead on a missing log -> null");
      bare.close();

      // Response without drift_since is unchanged.
      freshDb(true);
      const plain = await get(`kind=agents_pending_verify&mode=snapshot`);
      assertEq(
        Object.keys(plain.body),
        ["success", "kind", "mode", "count", "since", "until", "sample"],
        "car-23: without drift_since no drift_since/drift_bound/count_at_read keys",
      );

      // ── Decision rule.
      const d = mod.snapshotDriftDecision;
      assertEq(d(100, 150, 50, 97), { matched: false, diff: 3, tolerance: 2 }, "car-24: real mismatch of 3 vs count_at_read FAILS even with drift_bound 50");
      assertEq(d(100, 103, 50, 97).matched, false, "car-25: count_at_read wins over drift_bound when numeric (old rule would pass)");
      assertEq(d(100, 150, 50, 98), { matched: true, diff: 2, tolerance: 2 }, "car-26: count_at_read within ±2 matches regardless of count_now");
      assertEq(d(0, 40, 40, 0), { matched: true, diff: 0, tolerance: 2 }, "car-27: count_at_read 0 is numeric (not treated as missing)");
      assertEq(d(100, 105, 5, null), { matched: true, diff: 5, tolerance: 5 }, "car-28: count_at_read null -> max(2, drift_bound) fallback");
      assertEq(d(100, 105, 5), { matched: true, diff: 5, tolerance: 5 }, "car-29: count_at_read absent -> drift_bound fallback (slice-4 callers unchanged)");
      assertEq(d(100, 103, null, null), { matched: false, diff: 3, tolerance: 2 }, "car-30: both null -> fixed ±2");

      // ── read_at is taken before the snapshot read (review N2, M16).
      const { readSnapshotClaimCounts } = require("./admin-run-verifier") as typeof import("./admin-run-verifier");
      const real = freshDb(true).db;
      let firstQueryAt: number | null = null;
      const slowDb = {
        prepare(sql: string) {
          if (firstQueryAt === null) firstQueryAt = Date.now();
          const until = Date.now() + 5;
          while (Date.now() <= until) {
            /* make the read take measurable time */
          }
          return real.prepare(sql);
        },
      };
      const t0 = Date.now();
      const out = readSnapshotClaimCounts(slowDb);
      const readAtMs = Date.parse(out.snapshotReadAt);
      assertEq(out.snapshotCounts?.agents_pending_verify, 20, "car-31: readSnapshotClaimCounts returns the snapshot counts");
      assertEq(
        firstQueryAt !== null && readAtMs >= t0 && readAtMs <= (firstQueryAt as number),
        true,
        "car-32: snapshotReadAt is taken before the first snapshot query (read_at <= read time)",
      );
      const broken = readSnapshotClaimCounts({ prepare() { throw new Error("db down"); } });
      assertEq([broken.snapshotCounts, typeof broken.snapshotReadAt], [undefined, "string"], "car-33: read failure -> counts undefined, read_at still set (fail-open)");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminVerifierClaimCountsCountAtReadTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
