/**
 * lokal-agent-verifier-pending-verify-parking.test.ts — tests the
 * pending_verify no-progress parking mechanism added for dev-request
 * 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction (item 6
 * follow-up): a ~817-row prod tail of `pending_verify` agents never
 * converges because their gate failure is structural (missing data the
 * bulk sweep has no way to acquire, e.g. a missing email) — every
 * re-probe just re-derives `pending_verify` again, wasting wall-clock on
 * a cohort proven unresolvable by re-verification alone.
 *
 * Mirrors the two existing precedents for this exact "wasted
 * recirculation" shape:
 *   - homepage_fetch_attempts / homepage_unreachable_since in
 *     src/routes/marketplace.ts (PR #248), tested in
 *     homepage-provenance-selector-parking.test.ts.
 *   - domain_reconciliation_checked_at in pickReviewQueueBatch, tested
 *     in admin-domain-coherence.test.ts.
 *
 * Coverage (per the dev-request spec):
 *   - 3 consecutive no-progress applyVerifierOutcome calls -> parked on
 *     the 3rd, not before.
 *   - Re-stamp-after-expired-backoff (the exact PR #248 review-blocker
 *     bug class: a stale parked_since must NOT be left stale forever —
 *     a still-unresolvable agent re-probed after its backoff expired and
 *     STILL making no progress must get parked_since bumped to now, not
 *     left at the old value which would satisfy the exclusion forever).
 *   - Real progress (any non-pending_verify outcome) fully resets both
 *     columns, even with prior no-progress history.
 *   - pickPendingVerifyBatch excludes parked-active, includes
 *     parked-expired, and honors PENDING_VERIFY_PARKING_DISABLED.
 *   - admin-outreach-ready-pool /stats exposes a pending_verify_parking
 *     block with correct parked_active / parked_expired_ready_for_retry.
 *
 * Exported runLokalAgentVerifierPendingVerifyParkingTests({log}) ->
 * TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/agents/lokal-agent-verifier-pending-verify-parking.test.ts
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

export function runLokalAgentVerifierPendingVerifyParkingTests(
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
    const prevDb = initMod.getDb();
    const prevParkingDisabled = process.env.PENDING_VERIFY_PARKING_DISABLED;
    delete process.env.PENDING_VERIFY_PARKING_DISABLED;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const {
        applyVerifierOutcome,
        pickPendingVerifyBatch,
      } = require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, about, field_provenance, verification_status)
         VALUES (?, ?, NULL, 'A test farm shop', '{}', 'pending_verify')`,
      );

      function knowledgeRow(agentId: string): {
        pending_verify_no_progress_count: number;
        pending_verify_parked_since: string | null;
      } {
        return db
          .prepare(
            "SELECT pending_verify_no_progress_count, pending_verify_parked_since FROM agent_knowledge WHERE agent_id = ?",
          )
          .get(agentId) as {
          pending_verify_no_progress_count: number;
          pending_verify_parked_since: string | null;
        };
      }

      function noProgressOutcome(agentId: string, runStartedAt: string): void {
        applyVerifierOutcome(db, agentId, {
          new_verification_status: "pending_verify",
          new_enrichment_status: "thin",
          http_status: 200,
          runStartedAt,
          eligibleAt: null,
        });
      }

      // ── (1) 3 consecutive no-progress outcomes -> parked on the 3rd ──────
      insertAgent.run("agent-noprog", "Noproggard AS", "https://noprog-gard.no", "key-noprog");
      insertKnowledge.run("agent-noprog", "https://noprog-gard.no");

      noProgressOutcome("agent-noprog", "2026-07-01T00:00:00.000Z");
      let row = knowledgeRow("agent-noprog");
      assertEq(row.pending_verify_no_progress_count, 1, "pvp-01: after call 1, count=1");
      assertEq(row.pending_verify_parked_since, null, "pvp-02: after call 1, not parked");

      noProgressOutcome("agent-noprog", "2026-07-02T00:00:00.000Z");
      row = knowledgeRow("agent-noprog");
      assertEq(row.pending_verify_no_progress_count, 2, "pvp-03: after call 2, count=2");
      assertEq(row.pending_verify_parked_since, null, "pvp-04: after call 2, still not parked");

      noProgressOutcome("agent-noprog", "2026-07-03T00:00:00.000Z");
      row = knowledgeRow("agent-noprog");
      assertEq(row.pending_verify_no_progress_count, 3, "pvp-05: after call 3, count=3");
      assertEq(row.pending_verify_parked_since, "2026-07-03T00:00:00.000Z",
        "pvp-06: after call 3, parked_since stamped to that call's runStartedAt");

      // ── (2) re-stamp after expired backoff (PR #248 review-blocker shape) ──
      // Simulate the parked_since aging past 30 days, then hit the agent with
      // ANOTHER no-progress outcome (still unresolvable) — the stamp must be
      // bumped to the new runStartedAt, not left stale.
      db.prepare(
        "UPDATE agent_knowledge SET pending_verify_parked_since = '2026-01-01T00:00:00.000Z' WHERE agent_id = 'agent-noprog'",
      ).run();
      noProgressOutcome("agent-noprog", "2026-07-13T00:00:00.000Z");
      row = knowledgeRow("agent-noprog");
      assertEq(row.pending_verify_no_progress_count, 4, "pvp-07: count keeps incrementing past 3");
      assertEq(row.pending_verify_parked_since, "2026-07-13T00:00:00.000Z",
        "pvp-08: expired backoff + another no-progress outcome RE-STAMPS parked_since (not left stale)");

      // A repeat no-progress outcome while STILL within the backoff window
      // must NOT re-stamp (only expired backoffs re-stamp).
      noProgressOutcome("agent-noprog", "2026-07-14T00:00:00.000Z");
      row = knowledgeRow("agent-noprog");
      assertEq(row.pending_verify_parked_since, "2026-07-13T00:00:00.000Z",
        "pvp-09: still-active backoff window is NOT re-stamped by a subsequent no-progress outcome");

      // ── (3) real progress resets both columns ────────────────────────────
      insertAgent.run("agent-progress", "Progressgard AS", "https://progress-gard.no", "key-progress");
      insertKnowledge.run("agent-progress", "https://progress-gard.no");
      noProgressOutcome("agent-progress", "2026-07-01T00:00:00.000Z");
      noProgressOutcome("agent-progress", "2026-07-02T00:00:00.000Z");
      row = knowledgeRow("agent-progress");
      assertEq(row.pending_verify_no_progress_count, 2, "pvp-10: agent-progress has prior no-progress history (count=2)");

      applyVerifierOutcome(db, "agent-progress", {
        new_verification_status: "verified",
        new_enrichment_status: "rich",
        http_status: 200,
        runStartedAt: "2026-07-03T00:00:00.000Z",
        eligibleAt: "2026-07-03T00:00:00.000Z",
      });
      row = knowledgeRow("agent-progress");
      assertEq(row.pending_verify_no_progress_count, 0, "pvp-11: verified outcome resets count to 0");
      assertEq(row.pending_verify_parked_since, null, "pvp-12: verified outcome resets parked_since to NULL");

      // Same reset behavior for review_required (also "real movement").
      insertAgent.run("agent-progress2", "Progressgard2 AS", "https://progress2-gard.no", "key-progress2");
      insertKnowledge.run("agent-progress2", "https://progress2-gard.no");
      noProgressOutcome("agent-progress2", "2026-07-01T00:00:00.000Z");
      applyVerifierOutcome(db, "agent-progress2", {
        new_verification_status: "review_required",
        new_enrichment_status: "partial",
        http_status: 200,
        runStartedAt: "2026-07-02T00:00:00.000Z",
        eligibleAt: null,
      });
      row = knowledgeRow("agent-progress2");
      assertEq(row.pending_verify_no_progress_count, 0, "pvp-13: review_required outcome also resets count to 0");
      assertEq(row.pending_verify_parked_since, null, "pvp-14: review_required outcome also resets parked_since to NULL");

      // ── (4) pickPendingVerifyBatch parking exclusion ─────────────────────
      insertAgent.run("agent-parked-active", "ParkedActive AS", "https://parked-active.no", "key-pa");
      insertKnowledge.run("agent-parked-active", "https://parked-active.no");
      db.prepare(
        "UPDATE agent_knowledge SET pending_verify_no_progress_count = 3, pending_verify_parked_since = datetime('now') WHERE agent_id = 'agent-parked-active'",
      ).run();

      insertAgent.run("agent-parked-expired", "ParkedExpired AS", "https://parked-expired.no", "key-pe");
      insertKnowledge.run("agent-parked-expired", "https://parked-expired.no");
      db.prepare(
        "UPDATE agent_knowledge SET pending_verify_no_progress_count = 3, pending_verify_parked_since = datetime('now', '-31 days') WHERE agent_id = 'agent-parked-expired'",
      ).run();

      let batch = pickPendingVerifyBatch(db, 100);
      let batchIds = batch.map((r: any) => r.id);
      assertTrue(!batchIds.includes("agent-parked-active"),
        "pvp-15: pickPendingVerifyBatch excludes a recently-parked agent");
      assertTrue(batchIds.includes("agent-parked-expired"),
        "pvp-16: pickPendingVerifyBatch includes a parked-but-expired-backoff agent");
      // agent-noprog was parked earlier in this test (re-stamped at pvp-08 to
      // a "now"-ish timestamp via the re-stamp-on-expired-backoff path) — it
      // should still be excluded here as a parked-active agent too.
      assertTrue(!batchIds.includes("agent-noprog"),
        "pvp-17: agent-noprog (parked earlier in this test, still within backoff) is excluded");

      process.env.PENDING_VERIFY_PARKING_DISABLED = "true";
      batch = pickPendingVerifyBatch(db, 100);
      batchIds = batch.map((r: any) => r.id);
      assertTrue(batchIds.includes("agent-parked-active"),
        "pvp-18: PENDING_VERIFY_PARKING_DISABLED=true includes the parked-active agent too");
      delete process.env.PENDING_VERIFY_PARKING_DISABLED;

      batch = pickPendingVerifyBatch(db, 100);
      batchIds = batch.map((r: any) => r.id);
      assertTrue(!batchIds.includes("agent-parked-active"),
        "pvp-19: unsetting the flag restores the exclusion");

      // ── (5) admin-outreach-ready-pool /stats exposes pending_verify_parking ──
      delete require.cache[require.resolve("../routes/admin-outreach-pool")];
      const routeMod = require("../routes/admin-outreach-pool");
      const router = routeMod.default;
      const testAdminKey = "pending-verify-parking-stats-test-key";
      const prevAdminKey = process.env.ADMIN_KEY;
      process.env.ADMIN_KEY = testAdminKey;
      try {
        const result = await callRoute(router, {
          method: "GET",
          url: "/stats",
          headers: { "x-admin-key": testAdminKey },
        });
        assertEq(result.status, 200, "pvp-20: GET /stats -> 200");
        assertTrue(!!result.body?.pending_verify_parking,
          "pvp-21: response includes a pending_verify_parking object");
        // Parked-active (as of this point): agent-parked-active only
        // (agent-parked-expired is expired, agent-noprog was re-parked at
        // pvp-08 with a fresh timestamp).
        assertEq(result.body.pending_verify_parking.parked_active, 2,
          "pvp-22: parked_active counts agent-parked-active + agent-noprog (both recently stamped)");
        assertEq(result.body.pending_verify_parking.parked_expired_ready_for_retry, 1,
          "pvp-23: parked_expired_ready_for_retry counts agent-parked-expired");
      } finally {
        if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
        else process.env.ADMIN_KEY = prevAdminKey;
      }
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevParkingDisabled === undefined) delete process.env.PENDING_VERIFY_PARKING_DISABLED;
      else process.env.PENDING_VERIFY_PARKING_DISABLED = prevParkingDisabled;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierPendingVerifyParkingTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
