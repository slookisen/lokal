/**
 * admin-outreach-pool-parking-event-counters.test.ts — dev-request
 * 2026-10-27-parkering-released-reparked-tellere: additive integer fields
 * parking_released_24h / parking_reparked_24h / parking_released_prev_24h /
 * parking_reparked_prev_24h on pending_verify_parking in
 * GET /admin/outreach-ready-pool/stats, fed by the
 * pending_verify_parking_events table (written by applyVerifierOutcome and
 * POST /admin/agents/pending-verify-unpark).
 * Standalone: npx tsx src/routes/admin-outreach-pool-parking-event-counters.test.ts
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

export function runAdminOutreachPoolParkingEventCountersTests(
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
      const msg = `FAIL ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  return (async () => {
    const prevDb = initMod.getDb();
    const testKey = "parking-event-counters-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevParkingDisabled = process.env.PENDING_VERIFY_PARKING_DISABLED;
    process.env.ADMIN_KEY = testKey;
    delete process.env.PENDING_VERIFY_PARKING_DISABLED;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      delete require.cache[require.resolve("./admin-outreach-pool")];
      const statsRouter = require("./admin-outreach-pool").default;
      delete require.cache[require.resolve("./admin-agents-pending-verify-unpark")];
      const unparkRouter = require("./admin-agents-pending-verify-unpark").default;
      const { applyVerifierOutcome } = require("../agents/lokal-agent-verifier") as typeof import("../agents/lokal-agent-verifier");

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, about, field_provenance, verification_status) VALUES (?, ?, 'A farm', '{}', 'pending_verify')`,
      );
      function mk(id: string): void {
        insertAgent.run(id, id, `https://${id}.invalid`, `key-${id}`);
        insertKnowledge.run(id, `https://${id}.invalid`);
      }
      function outcome(id: string, status: string): void {
        applyVerifierOutcome(db, id, {
          new_verification_status: status,
          new_enrichment_status: "thin",
          http_status: 200,
          runStartedAt: "2026-10-01T00:00:00.000Z",
          eligibleAt: null,
        });
      }
      function events(kind: string): number {
        return (db.prepare(`SELECT COUNT(*) AS c FROM pending_verify_parking_events WHERE kind = ?`).get(kind) as any).c;
      }
      async function stats(): Promise<any> {
        const r = await callRoute(statsRouter, { method: "GET", url: "/stats", headers: { "x-admin-key": testKey } });
        assertEq(r.status, 200, "stats -> 200");
        return r.body.pending_verify_parking;
      }

      // Baseline: nothing yet -> zero integers, existing fields intact.
      let pvp = await stats();
      assertEq(
        [pvp.parking_released_24h, pvp.parking_reparked_24h, pvp.parking_released_prev_24h, pvp.parking_reparked_prev_24h],
        [0, 0, 0, 0],
        "pec-01: all four counters are 0 with no events",
      );
      assertEq(pvp.parked_active, 0, "pec-02: existing parked_active still 0");
      assertEq(pvp.parked_age_buckets, { "0-7d": 0, "7-14d": 0, "14-30d": 0, "30d+": 0 }, "pec-03: existing parked_age_buckets intact");
      assertEq(pvp.next_release_at, null, "pec-04: existing next_release_at intact");

      // (4) first-time park -> no reparked event.
      mk("a1");
      outcome("a1", "pending_verify");
      outcome("a1", "pending_verify");
      outcome("a1", "pending_verify");
      assertEq(
        (db.prepare(`SELECT pending_verify_parked_since AS p FROM agent_knowledge WHERE agent_id='a1'`).get() as any).p !== null,
        true,
        "pec-05: a1 parked on 3rd outcome",
      );
      assertEq(events("reparked"), 0, "pec-06: first-time park does NOT log a reparked event");
      assertEq(events("released"), 0, "pec-07: first-time park does NOT log a released event");

      // (1) aged past 30d + another pending_verify -> reparked +1.
      db.prepare(`UPDATE agent_knowledge SET pending_verify_parked_since = datetime('now','-45 days') WHERE agent_id='a1'`).run();
      outcome("a1", "pending_verify");
      assertEq(events("reparked"), 1, "pec-08: expired-backoff re-stamp logs one reparked event");
      // Within backoff -> no further event.
      outcome("a1", "pending_verify");
      assertEq(events("reparked"), 1, "pec-09: pending_verify inside active backoff logs no reparked event");
      pvp = await stats();
      assertEq(pvp.parking_reparked_24h, 1, "pec-10: parking_reparked_24h = 1");
      assertEq(pvp.parking_released_24h, 0, "pec-11: parking_released_24h unchanged (0)");
      assertEq(pvp.parked_active, 1, "pec-12: existing parked_active still reported (1)");

      // (2) parked row + non-pending outcome -> released +1.
      outcome("a1", "verified");
      assertEq(events("released"), 1, "pec-13: parked row + verified outcome logs one released event");
      // (3) never-parked row + non-pending outcome -> none.
      mk("n1");
      outcome("n1", "verified");
      outcome("a1", "verified"); // already unparked now
      assertEq(events("released"), 1, "pec-14: never-parked / already-released rows log no released event");
      pvp = await stats();
      assertEq(pvp.parking_released_24h, 1, "pec-15: parking_released_24h = 1");
      assertEq(pvp.parking_reparked_24h, 1, "pec-16: parking_reparked_24h still 1");

      // (5) unpark lever: dry-run -> 0, apply -> +1 per previously-parked id.
      for (const id of ["u1", "u2", "u3"]) mk(id);
      db.prepare(`UPDATE agent_knowledge SET pending_verify_parked_since = datetime('now','-1 days'), pending_verify_no_progress_count = 3 WHERE agent_id IN ('u1','u2')`).run();
      const before = events("released");
      const dry = await callRoute(unparkRouter, {
        method: "POST", url: "/agents/pending-verify-unpark",
        headers: { "x-admin-key": testKey }, body: { agentIds: ["u1", "u2", "u3"] },
      });
      assertEq(dry.status, 200, "pec-17: dry-run -> 200");
      assertEq(events("released"), before, "pec-18: dry-run logs no released events");
      const applied = await callRoute(unparkRouter, {
        method: "POST", url: "/agents/pending-verify-unpark",
        headers: { "x-admin-key": testKey }, body: { agentIds: ["u1", "u2", "u3"], apply: true },
      });
      assertEq(applied.status, 200, "pec-19: apply -> 200");
      assertEq(events("released") - before, 2, "pec-20: apply logs one released event per previously-parked id (u3 never parked -> none)");
      pvp = await stats();
      assertEq(pvp.parking_released_24h, 3, "pec-21: parking_released_24h = 3 after unpark apply");

      // (6) window boundaries.
      db.exec(`DELETE FROM pending_verify_parking_events`);
      const ins = db.prepare(`INSERT INTO pending_verify_parking_events (agent_id, kind, created_at) VALUES (?, ?, datetime('now', ?))`);
      ins.run("w", "released", "-1 hours");
      ins.run("w", "released", "-30 hours");
      ins.run("w", "released", "-30 hours");
      ins.run("w", "released", "-60 hours");
      ins.run("w", "reparked", "-2 hours");
      ins.run("w", "reparked", "-2 hours");
      ins.run("w", "reparked", "-40 hours");
      ins.run("w", "reparked", "-72 hours");
      pvp = await stats();
      assertEq(pvp.parking_released_24h, 1, "pec-22: released_24h counts only <24h");
      assertEq(pvp.parking_released_prev_24h, 2, "pec-23: released_prev_24h counts only 24h-48h (60h-old in neither)");
      assertEq(pvp.parking_reparked_24h, 2, "pec-24: reparked_24h counts only <24h");
      assertEq(pvp.parking_reparked_prev_24h, 1, "pec-25: reparked_prev_24h counts only 24h-48h (72h-old in neither)");

      // Missing table -> zeros, route still 200.
      db.exec(`DROP TABLE pending_verify_parking_events`);
      pvp = await stats();
      assertEq(
        [pvp.parking_released_24h, pvp.parking_reparked_24h, pvp.parking_released_prev_24h, pvp.parking_reparked_prev_24h],
        [0, 0, 0, 0],
        "pec-26: missing events table -> four zeros, no error",
      );
      // And the verifier write path still works without the table.
      mk("m1");
      db.prepare(`UPDATE agent_knowledge SET pending_verify_parked_since = datetime('now','-45 days'), pending_verify_no_progress_count = 5 WHERE agent_id='m1'`).run();
      outcome("m1", "pending_verify");
      const m1 = db.prepare(`SELECT pending_verify_parked_since AS p FROM agent_knowledge WHERE agent_id='m1'`).get() as any;
      assertEq(m1.p > new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace("T", " "), true, "pec-27: re-stamp still happens when events table is absent");
    } finally {
      initMod.__setDbForTesting(prevDb);
      try { db.close(); } catch { /* ignore */ }
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevParkingDisabled === undefined) delete process.env.PENDING_VERIFY_PARKING_DISABLED; else process.env.PENDING_VERIFY_PARKING_DISABLED = prevParkingDisabled;
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminOutreachPoolParkingEventCountersTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed === 0 ? 0 : 1);
  });
}
