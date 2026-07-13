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
      // orch-pr-20260713-verifier-sweep-parking (review-blocker fix): the
      // stamp is now written via SQL datetime('now') (computed by SQLite
      // itself), NOT the fake runStartedAt bound as a JS-ISO-string param —
      // mixing a JS Date#toISOString() value ("...T...Z") with the
      // datetime('now','-30 days') SQL-native format ("YYYY-MM-DD HH:MM:SS")
      // used on the read side made the 30-day window effectively ~31 days
      // (see stampParking() in admin-domain-coherence.ts for the identical,
      // already-fixed precedent). So we can no longer assert exact equality
      // against runStartedAt — instead assert "is set" and "is a real,
      // recent wall-clock stamp", the same idiom
      // homepage-provenance-selector-parking.test.ts uses for
      // homepage_unreachable_since (also stamped via datetime('now')-style
      // real-clock writes).
      assertTrue(!!row.pending_verify_parked_since, "pvp-06: after call 3, parked_since is set");
      assertTrue(
        Date.parse(row.pending_verify_parked_since!) > Date.now() - 60_000,
        "pvp-06b: after call 3, parked_since is a real, recent DB-stamped clock value (not the fake runStartedAt)"
      );

      // ── (2) re-stamp after expired backoff (PR #248 review-blocker shape) ──
      // Simulate the parked_since aging past 30 days (in SQL-native format,
      // matching how the real column is written), then hit the agent with
      // ANOTHER no-progress outcome (still unresolvable) — the stamp must be
      // bumped to a fresh value, not left stale.
      db.prepare(
        "UPDATE agent_knowledge SET pending_verify_parked_since = datetime('now', '-45 days') WHERE agent_id = 'agent-noprog'",
      ).run();
      noProgressOutcome("agent-noprog", "2026-07-13T00:00:00.000Z");
      row = knowledgeRow("agent-noprog");
      assertEq(row.pending_verify_no_progress_count, 4, "pvp-07: count keeps incrementing past 3");
      assertTrue(!!row.pending_verify_parked_since, "pvp-08: expired backoff + another no-progress outcome re-stamps parked_since (still set)");
      assertTrue(
        Date.parse(row.pending_verify_parked_since!) > Date.now() - 60_000,
        "pvp-08b: expired backoff + another no-progress outcome RE-STAMPS parked_since to a fresh value (not left at the 45-day-old stale value)"
      );
      const parkedSince2 = row.pending_verify_parked_since;

      // A repeat no-progress outcome while STILL within the backoff window
      // must NOT re-stamp (only expired backoffs re-stamp) — value must be
      // byte-for-byte unchanged from the re-stamp above.
      noProgressOutcome("agent-noprog", "2026-07-14T00:00:00.000Z");
      row = knowledgeRow("agent-noprog");
      assertEq(row.pending_verify_parked_since, parkedSince2,
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

      // ── (4b) format-mismatch regression: real write-path stamp, exercised
      // at the true 30-day boundary ────────────────────────────────────────
      // orch-pr-20260713-verifier-sweep-parking review finding: the previous
      // fixture-based tests above (agent-parked-active/-expired) seeded
      // pending_verify_parked_since via raw SQL datetime('now'[,'-31 days']),
      // which never exercised the actual applyVerifierOutcome write path —
      // so they couldn't have caught the JS-ISO-vs-SQL-native format
      // mismatch bug (a JS Date#toISOString() stamp compared against
      // datetime('now','-30 days') is off by ~1 day at the boundary). This
      // test drives 3 REAL applyVerifierOutcome calls to produce a REAL
      // DB-stamped value, then ages that real value (in SQL-native format,
      // as SQLite itself would represent it) to precisely 30 days + 1 hour
      // and 29 days 23 hours, to prove the exclusion clause's boundary is
      // exact — not the ~31-day boundary the pre-fix code produced.
      insertAgent.run("agent-boundary", "Boundarygard AS", "https://boundary-gard.no", "key-boundary");
      insertKnowledge.run("agent-boundary", "https://boundary-gard.no");
      noProgressOutcome("agent-boundary", "2026-07-01T00:00:00.000Z");
      noProgressOutcome("agent-boundary", "2026-07-02T00:00:00.000Z");
      noProgressOutcome("agent-boundary", "2026-07-03T00:00:00.000Z");
      row = knowledgeRow("agent-boundary");
      assertTrue(!!row.pending_verify_parked_since, "pvp-24: agent-boundary is parked after 3 real no-progress applyVerifierOutcome calls");
      assertTrue(
        Date.parse(row.pending_verify_parked_since!) > Date.now() - 60_000,
        "pvp-25: agent-boundary's parked_since is a real, recent DB-stamped wall-clock value"
      );

      // Age the real stamp to exactly "30 days + 1 hour" old -> just past
      // the boundary -> must be treated as EXPIRED (included).
      db.prepare(
        "UPDATE agent_knowledge SET pending_verify_parked_since = datetime('now', '-30 days', '-1 hours') WHERE agent_id = 'agent-boundary'",
      ).run();
      batch = pickPendingVerifyBatch(db, 100);
      batchIds = batch.map((r: any) => r.id);
      assertTrue(batchIds.includes("agent-boundary"),
        "pvp-26: parked_since aged to exactly 30 days + 1 hour is treated as EXPIRED (included) — the true 30-day boundary, not the pre-fix ~31-day one");

      // Age the real stamp to "29 days 23 hours" old -> just short of the
      // boundary -> must STILL be excluded (backoff not yet expired).
      db.prepare(
        "UPDATE agent_knowledge SET pending_verify_parked_since = datetime('now', '-29 days', '-23 hours') WHERE agent_id = 'agent-boundary'",
      ).run();
      batch = pickPendingVerifyBatch(db, 100);
      batchIds = batch.map((r: any) => r.id);
      assertTrue(!batchIds.includes("agent-boundary"),
        "pvp-27: parked_since aged to 29 days 23 hours is still within the 30-day backoff window (excluded)");

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
        assertEq(result.status, 200, "pvp-28: GET /stats -> 200");
        assertTrue(!!result.body?.pending_verify_parking,
          "pvp-29: response includes a pending_verify_parking object");
        // Parked-active (as of this point): agent-parked-active, agent-noprog
        // (re-parked at pvp-08 with a fresh timestamp), and agent-boundary
        // (left aged to 29d23h — still "active" — at the end of the (4b)
        // boundary sub-test above). agent-parked-expired is expired;
        // agent-progress/agent-progress2 were reset to NULL by real
        // progress.
        assertEq(result.body.pending_verify_parking.parked_active, 3,
          "pvp-30: parked_active counts agent-parked-active + agent-noprog + agent-boundary (all recently/still-actively stamped)");
        assertEq(result.body.pending_verify_parking.parked_expired_ready_for_retry, 1,
          "pvp-31: parked_expired_ready_for_retry counts agent-parked-expired");
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
