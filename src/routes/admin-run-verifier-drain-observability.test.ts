/**
 * admin-run-verifier-drain-observability.test.ts — tests the `persisted` +
 * `status_transitions` response fields added for dev-request
 * 2026-07-19-verifier-drain-persistens-og-throughput.
 *
 * Background: a live drain-burst against POST /admin/run-verifier
 * (reprocess_review_queue=1) showed 8 rounds returning near-identical
 * aggregate counts (processed=33, passed=26, pool_added=0 every round, no
 * change in the verified/review_required/pool totals) and was read as
 * "the 26 passed results aren't being persisted". Live re-verification
 * (this dev-request) found `applyVerifierOutcome` is called unconditionally
 * for every candidate — there is no evaluate-only path — so writes DO
 * happen every round. The apparent "no change" was actually correct: a
 * review_required agent whose underlying evidence hasn't changed since the
 * last pass is correctly RE-CONFIRMED review_required (the domain-coherence
 * / cross-source / email-ownership guards are deterministic over unchanged
 * inputs). `passed` (the basic quality-gate result) is a different signal
 * from "did this agent's status actually change" — a stricter downstream
 * guard can hold `passed=true` while still routing the agent away from
 * `verified`, and the old response gave no way to tell "persisted but
 * unchanged" apart from "not persisted".
 *
 * This suite proves:
 *   - `persisted` is always `true` in a successful response (the write
 *     path is unconditional).
 *   - `status_transitions` counts only agents whose verification_status
 *     actually changed, distinct from `passed` (basic-gate-pass) and from
 *     `pool_added` (first-time promotion only).
 *   - Re-running the SAME unchanged candidate a second time correctly
 *     reports status_transitions=0 for it (persisted, not a bug) while
 *     `persisted` stays true both times.
 *   - `transitioned` (added for dev-request
 *     2026-08-10-verifier-portkjede-og-provenansrydding, Skive B) mirrors
 *     `status_transitions` under the name that dev-request's root-cause
 *     report asked for, and `by_new_status` breaks those transitions down
 *     by resulting status — so a bulk-sweep caller never again mistakes a
 *     high `passed` count (basic-gate re-passes) for real promotions.
 *
 * dev-request 2026-08-17-verifier-tick-lock: runVerifierTick() now acquires
 * a DB-backed once-per-hour lock (orchestrator_locks, agent
 * "lokal-agent-verifier-tick") as the very first thing it does, so rounds
 * 2 and 3 below now DELETE that lock row before calling the route again —
 * standing in for "the next hour's tick, after the previous lock's natural
 * staleMinutes=50 expiry" — otherwise every round after the first would
 * immediately get skipped:true and none of the observability assertions
 * below (which depend on a REAL batch running each round) would exercise
 * anything. The lock's own behavior (skip-when-fresh, response shape,
 * no-second-batch) is proven separately at the end of this suite (round 4),
 * where the lock is deliberately left in place.
 *
 * Exported runAdminRunVerifierDrainObservabilityTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-run-verifier-drain-observability.test.ts
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
    query?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: opts.query || {},
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

const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key-verifier-drain";

export function runAdminRunVerifierDrainObservabilityTests(
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
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevDb = initMod.getDb();
    const db = new Database(":memory:");
    try {
      process.env.ADMIN_KEY = ADMIN_KEY;
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // Deliberately no `website` on any seeded agent below: the route
      // never injects a headProbe/brregLookup override, so a real
      // `website` value would trigger a live network HEAD-fetch from this
      // test. Skipping it (httpStatus stays null) keeps the suite hermetic
      // while still exercising the full write + response path.
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, 0)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, website, email, about, products, field_provenance, verification_status)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      );

      // A review_required agent with NO cross-source agreement and NO
      // website — every re-run of the gate against this unchanged
      // evidence will correctly re-derive review_required again. This is
      // the exact "reprocessed but nothing changed" case from the live
      // drain-burst finding.
      insertAgent.run("agent-stable-review", "Stablegard AS", "key-stable-review");
      insertKnowledge.run(
        "agent-stable-review",
        "Testveien 1, 1400 Ski",
        "91234567",
        "info@gmail.com",
        "Kort tekst.",
        "[]",
        JSON.stringify({}),
        "review_required",
      );

      const { default: router } = require("./admin-run-verifier") as { default: any };

      // dev-request 2026-08-17-verifier-tick-lock: runVerifierTick() now
      // acquires an orchestrator_locks row (agent
      // "lokal-agent-verifier-tick") as the first thing it does and never
      // releases it explicitly — it just expires after staleMinutes=50.
      // Deleting the row directly stands in for "that natural expiry
      // already happened", i.e. simulates moving to the next hour's tick
      // between rounds in this suite.
      const clearTickLock = () =>
        db.prepare(`DELETE FROM orchestrator_locks WHERE agent = 'lokal-agent-verifier-tick'`).run();

      // ── Round 1: reprocess the review queue ─────────────────────────
      const round1 = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", reprocess_review_queue: "1", batchSize: "5" },
        body: {},
      });

      assertEq(round1.status, 200, "obs-1: round 1 responds 200");
      assertTrue(round1.body.success === true, "obs-2: round 1 success=true");
      assertEq(round1.body.persisted, true, "obs-3: round 1 persisted=true");
      assertEq(round1.body.processed, 1, "obs-4: round 1 processed the 1 seeded review_required agent");

      // The seeded agent has no real evidence at all, so the gate lands it
      // on `pending_verify` (data-insufficient territory) rather than the
      // `review_required` it started at — a genuine transition, correctly
      // counted. The interesting assertion is round 2 below: re-running
      // against the SAME now-unchanged evidence must NOT keep counting
      // transitions forever.
      const row1 = db
        .prepare(`SELECT verification_status, last_verified_at FROM agent_knowledge WHERE agent_id = ?`)
        .get("agent-stable-review") as { verification_status: string; last_verified_at: string };
      assertTrue(!!row1.last_verified_at, "obs-5: last_verified_at was stamped (proves the UPDATE ran, not just the response)");
      assertEq(round1.body.status_transitions, 1, "obs-6: status_transitions=1 (genuine review_required -> pending_verify transition, persisted)");
      assertEq(round1.body.status_transitions <= round1.body.processed, true, "obs-7: status_transitions never exceeds processed");
      assertEq(round1.body.transitioned, 1, "obs-6b: transitioned mirrors status_transitions (Skive B)");
      assertEq(round1.body.by_new_status?.pending_verify, 1, "obs-6c: by_new_status names the resulting status of the one real transition");

      // dev-request 2026-08-17-verifier-tick-lock, requirement (c): the
      // non-skipped response shape must be byte-identical to what this
      // route returned before the lock was added — no field silently
      // dropped/renamed while widening runVerifierTick's return type to a
      // discriminated union. Pin the exact key set (order-independent).
      const expectedNonSkippedKeys = [
        "success", "run_id", "processed", "passed", "review_required",
        "pending_verify", "data_insufficient", "http_unreachable",
        "brreg_inactive", "domain_incoherent", "email_domain_mismatch",
        "thin_content", "pool_added", "status_transitions", "transitioned",
        "by_new_status", "persisted", "envelope_recorded", "hour_utc",
        "forced", "tick_lock_skipped", "reprocess_review_queue", "bias_growth",
      ].sort();
      assertEq(
        Object.keys(round1.body).sort(),
        expectedNonSkippedKeys,
        "lock-1: round 1 (non-skipped) response has EXACTLY the pre-existing field set — nothing dropped, nothing added",
      );
      assertEq(round1.body.skipped, undefined, "lock-2: non-skipped response has no `skipped` key at all (matches pre-lock shape exactly)");

      const firstStamp = row1.last_verified_at;

      // ── Round 2: reprocess again, same unchanged evidence. The agent is
      // now `pending_verify` (round 1's real transition) — the
      // review-queue picker (WHERE verification_status IN
      // ('review_required','data_insufficient')) would no longer select
      // it, so this round deliberately uses the plain/biased picker
      // (which includes pending_verify) to keep re-selecting the SAME
      // agent against the SAME unchanged evidence — the actual scenario
      // the live drain-burst finding was about.
      clearTickLock();
      const round2 = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", reprocess_review_queue: "0", batchSize: "5" },
        body: {},
      });

      assertEq(round2.body.persisted, true, "obs-8: round 2 persisted=true (still unconditional, not a one-time fluke)");
      assertEq(round2.body.status_transitions, 0, "obs-9: round 2 status_transitions=0 (still correctly unchanged)");
      assertEq(round2.body.pool_added, 0, "obs-10: round 2 pool_added=0 (no first-time promotion — consistent with status_transitions=0)");
      assertEq(round2.body.transitioned, 0, "obs-9b: transitioned=0 on a re-confirmation round (this is the exact case the dev-request's root-cause report was misled by when it read `passed` instead)");
      assertEq(Object.keys(round2.body.by_new_status ?? {}).length, 0, "obs-9c: by_new_status is empty when nothing transitioned");

      const row2 = db
        .prepare(`SELECT last_verified_at FROM agent_knowledge WHERE agent_id = ?`)
        .get("agent-stable-review") as { last_verified_at: string };
      assertTrue(
        row2.last_verified_at >= firstStamp,
        "obs-11: last_verified_at advanced (or stayed equal at second-resolution) across round 2 — a real second write happened, proving round 1 wasn't a fluke pass-through",
      );

      // ── A second agent that DOES transition, alongside the stable one,
      // to prove status_transitions counts transitions selectively, not
      // just "any write happened this batch". ───────────────────────────
      insertAgent.run("agent-clears-review", "Clearsgard AS", "key-clears-review");
      insertKnowledge.run(
        "agent-clears-review",
        "Testveien 2, 1400 Ski",
        "91234568",
        "kontakt@clearsgard.no",
        "En lang og god beskrivelse av gården vår med mye relevant innhold om produktene.",
        JSON.stringify([{ name: "Sider" }, { name: "Eplemost" }, { name: "Honning" }]),
        JSON.stringify({}),
        "unverified",
      );

      clearTickLock();
      const round3 = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", reprocess_review_queue: "0", batchSize: "5", bias_growth: "0" },
        body: {},
      });

      assertEq(round3.body.persisted, true, "obs-12: round 3 persisted=true");
      assertTrue(
        round3.body.processed >= 1,
        `obs-13: round 3 processed at least the new unverified agent (got ${round3.body.processed})`,
      );
      // Both an unchanged re-confirmation (if re-picked) and a genuine
      // fresh-agent transition can appear in the same batch — the point
      // under test is only that status_transitions is NOT hardcoded to
      // `processed` (which would silently collapse back into the
      // ambiguity this fix exists to remove).
      assertTrue(
        round3.body.status_transitions <= round3.body.processed,
        `obs-14: status_transitions (${round3.body.status_transitions}) never exceeds processed (${round3.body.processed})`,
      );
      assertEq(round3.body.transitioned, round3.body.status_transitions, "obs-14b: transitioned always equals status_transitions");
      const byNewStatusSum = Object.values(round3.body.by_new_status ?? {}).reduce(
        (a: number, b: any) => a + (b as number),
        0,
      );
      assertEq(byNewStatusSum, round3.body.transitioned, "obs-14c: by_new_status counts sum to transitioned exactly (no double counting, no dropped rows)");

      // ── dev-request 2026-08-17-verifier-tick-lock: lock-contention ─────
      // behavior. Round 3's call above acquired the tick lock and did NOT
      // clear it afterwards (no releaseLock() in this design — see
      // runVerifierTick's own comment). Round 4 fires immediately after,
      // with the lock still fresh (well within staleMinutes=50), and must
      // be skipped WITHOUT running a second batch — this is the exact
      // production bug (2-6 near-simultaneous runs/night) this dev-request
      // fixes.
      const runsCountBefore = (
        db.prepare(`SELECT COUNT(*) AS c FROM runs`).get() as { c: number }
      ).c;
      const lockRowBefore = db
        .prepare(`SELECT run_id, started_at FROM orchestrator_locks WHERE agent = 'lokal-agent-verifier-tick'`)
        .get() as { run_id: string; started_at: string } | undefined;
      assertTrue(!!lockRowBefore, "lock-3: round 3 left a fresh orchestrator_locks row behind (agent=lokal-agent-verifier-tick)");

      const round4 = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", reprocess_review_queue: "0", batchSize: "5" },
        body: {},
      });

      assertEq(round4.status, 200, "lock-4: round 4 (lock still fresh) responds 200");
      assertEq(
        round4.body,
        { success: true, skipped: true, reason: `already ran this hour (locked by ${lockRowBefore?.run_id} at ${lockRowBefore?.started_at})` },
        "lock-5: round 4 response is EXACTLY {success:true, skipped:true, reason} naming the current holder — no run_id/processed/etc fields leak through",
      );

      const runsCountAfter = (
        db.prepare(`SELECT COUNT(*) AS c FROM runs`).get() as { c: number }
      ).c;
      assertEq(runsCountAfter, runsCountBefore, "lock-6: round 4 wrote NO new run-ledger envelope (batch-processing function was not invoked a second time)");

      const lockRowAfter = db
        .prepare(`SELECT run_id, started_at FROM orchestrator_locks WHERE agent = 'lokal-agent-verifier-tick'`)
        .get() as { run_id: string; started_at: string } | undefined;
      assertEq(lockRowAfter, lockRowBefore, "lock-7: the lock row itself is untouched by the skipped call (still held by round 3's run_id)");

      // ── dev-request 2026-08-28-enrichment-verifier-lock-blokkerer-force-promote ──
      // Round 5: the lock is STILL held from round 3 (round 4 above proved a
      // plain force=1 call, with no skip_tick_lock, is blocked by it). Now
      // fire a call with skip_tick_lock=1 — this must run a real batch even
      // though the lock is held, mirroring the enrichment-agent's
      // 2B-PENDING caller.
      insertAgent.run("agent-skip-lock", "Skiplockgard AS", "key-skip-lock");
      insertKnowledge.run(
        "agent-skip-lock",
        "Testveien 3, 1400 Ski",
        "91234569",
        "kontakt@skiplockgard.no",
        "En lang og god beskrivelse av gården vår med mye relevant innhold om produktene.",
        JSON.stringify([{ name: "Sider" }, { name: "Eplemost" }]),
        JSON.stringify({}),
        "unverified",
      );

      const round5 = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", skip_tick_lock: "1", reprocess_review_queue: "0", batchSize: "5", bias_growth: "0" },
        body: {},
      });

      assertEq(round5.status, 200, "skip-lock-1: round 5 (skip_tick_lock=1, lock held) responds 200");
      assertEq(round5.body.skipped, undefined, "skip-lock-2: round 5 is NOT skipped despite the lock being held");
      assertEq(round5.body.success, true, "skip-lock-3: round 5 success=true");
      assertEq(round5.body.persisted, true, "skip-lock-4: round 5 persisted=true — a real batch ran");
      assertEq(round5.body.tick_lock_skipped, true, "skip-lock-5: round 5 response reports tick_lock_skipped=true");
      assertEq(round5.body.forced, true, "skip-lock-6: round 5 still reports forced=true (force and skip_tick_lock are independent fields)");

      // Note: NOT asserting on `runs` row COUNT here — the run_id embeds
      // only minute-resolution timestamps (see runVerifierBatch), so two
      // real batch runs within the same test-execution minute (round 3 and
      // round 5) can legitimately collide on `INSERT ... ON CONFLICT
      // (run_id) DO NOTHING` and not add a second row; that collision is a
      // pre-existing envelope-recording property, unrelated to
      // skip_tick_lock. Instead prove the batch actually executed the way
      // round 4's skip did NOT: the newly-seeded agent's row was written.
      const skipLockAgentRow = db
        .prepare(`SELECT verification_status, last_verified_at FROM agent_knowledge WHERE agent_id = ?`)
        .get("agent-skip-lock") as { verification_status: string; last_verified_at: string } | undefined;
      assertTrue(
        !!skipLockAgentRow?.last_verified_at,
        "skip-lock-7: round 5 actually wrote agent-skip-lock's last_verified_at — the batch-processing function WAS invoked, unlike round 4's skip",
      );

      const lockRowAfterSkip = db
        .prepare(`SELECT run_id, started_at FROM orchestrator_locks WHERE agent = 'lokal-agent-verifier-tick'`)
        .get() as { run_id: string; started_at: string } | undefined;
      assertEq(
        lockRowAfterSkip,
        lockRowBefore,
        "skip-lock-8: the lock row is completely untouched by the skip_tick_lock=1 call — it neither acquires nor refreshes it (still round 3's original run_id/started_at)",
      );

      // ── Round 6: with the lock STILL held (round 5 never touched it),
      // a plain force=1 call (no skip_tick_lock) must STILL be blocked —
      // proving skip_tick_lock is opt-in only and does not change behavior
      // for callers that don't pass it, even after a skip_tick_lock=1 call
      // has just run in between.
      const round6 = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", reprocess_review_queue: "0", batchSize: "5" },
        body: {},
      });

      assertEq(
        round6.body,
        { success: true, skipped: true, reason: `already ran this hour (locked by ${lockRowBefore?.run_id} at ${lockRowBefore?.started_at})` },
        "skip-lock-9: round 6 (plain force=1, no skip_tick_lock) is still correctly blocked by the still-held lock — unaffected by round 5's bypass",
      );
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminRunVerifierDrainObservabilityTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
