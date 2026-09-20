/**
 * admin-run-verifier-agentids.test.ts — tests for dev-request
 * 2026-09-16-run-verifier-agentids-og-pool-blocker-explain-gate-felt, punkt 1:
 * POST /admin/run-verifier and POST /admin/run-verifier/sweep accept an
 * optional `agentIds: string[]` (query `?agentIds=a,b,c` or JSON body
 * `{"agentIds":[...]}`) that REPLACES the normal batch-selection
 * (pickReviewQueueBatch/pickBatchBiased/default) with an explicit
 * `WHERE id IN (...)` filter — every other opt (force, skip_tick_lock,
 * reprocess_review_queue, bias_growth) stays unchanged and composable.
 *
 * Covers (src/routes/admin-run-verifier.ts, src/agents/lokal-agent-verifier.ts
 * pickByIds/runVerifierBatch, src/services/verifier-sweep.ts):
 *   (a) POST /admin/run-verifier?agentIds=a,b (query, comma-separated)
 *       processes ONLY those ids — other seeded agents are left untouched
 *       (last_verified_at stays NULL).
 *   (b) POST /admin/run-verifier body {"agentIds":[...]} (JSON array) —
 *       same effect via the body path.
 *   (c) agentIds composes with reprocess_review_queue=1: an explicit id
 *       whose status is 'verified' (which pickReviewQueueBatch would NEVER
 *       select on its own) is still processed — proving agentIds fully
 *       REPLACES pickFn's own selection rather than filtering its output.
 *   (d) omitting agentIds entirely still processes the whole default batch
 *       (regression: default behavior for every existing caller is
 *       unaffected by this feature existing).
 *   (e) POST /admin/run-verifier/sweep with agentIds consumes the given ids
 *       in chunkSize-sized slices and reaches status 'done' after exactly
 *       ids.length agents — proving it does NOT loop forever (the sweep's
 *       default empty-chunk-from-DB exhaustion signal cannot fire for an
 *       explicit id filter, since the same ids would match on every call).
 *   (f) sweep + agentIds: a chunk that comes back empty (e.g. a stale/
 *       deleted id) does not abort the sweep early — it moves on to the
 *       next slice of ids.
 *
 * Wired into tests/test.ts (runSerial, same convention as
 * admin-run-verifier-drain-observability.test.ts).
 * Standalone: npx tsx src/routes/admin-run-verifier-agentids.test.ts
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

const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key-run-verifier-agentids";

export function runAdminRunVerifierAgentIdsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

      // Deliberately no `website` on any seeded agent: the route never
      // injects a headProbe/brregLookup override, so a real `website` value
      // would trigger a live network HEAD-fetch from this test (same
      // convention as admin-run-verifier-drain-observability.test.ts).
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, 0)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, website, email, about, products, field_provenance, verification_status)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      );

      function seed(id: string, status: string): void {
        insertAgent.run(id, `${id} AS`, `key-${id}`);
        insertKnowledge.run(
          id,
          "Testveien 1, 1400 Ski",
          "91234567",
          "info@gmail.com",
          "Kort tekst.",
          "[]",
          JSON.stringify({}),
          status,
        );
      }

      seed("aid-a1", "pending_verify");
      seed("aid-a2", "unverified");
      seed("aid-a3", "data_insufficient");
      seed("aid-a4", "review_required");
      seed("aid-verified", "verified");

      const lastVerifiedOf = (id: string): string | null =>
        (db.prepare(`SELECT last_verified_at FROM agent_knowledge WHERE agent_id = ?`).get(id) as any)
          ?.last_verified_at ?? null;

      const clearTickLock = () =>
        db.prepare(`DELETE FROM orchestrator_locks WHERE agent = 'lokal-agent-verifier-tick'`).run();

      const { default: router } = require("./admin-run-verifier") as { default: any };

      // ── (a) query-string agentIds — comma-separated, processes ONLY those ids ──
      const roundA = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", bias_growth: "0", agentIds: "aid-a1,aid-a3" },
        body: {},
      });

      assertEq(roundA.status, 200, "a1: 200 response");
      assertEq(roundA.body.success, true, "a2: success=true");
      assertEq(roundA.body.processed, 2, "a3: processed exactly the 2 given ids");
      assertTrue(lastVerifiedOf("aid-a1") !== null, "a4: aid-a1 (given) was processed");
      assertTrue(lastVerifiedOf("aid-a3") !== null, "a5: aid-a3 (given) was processed");
      assertEq(lastVerifiedOf("aid-a2"), null, "a6: aid-a2 (NOT given) is untouched");
      assertEq(lastVerifiedOf("aid-a4"), null, "a7: aid-a4 (NOT given) is untouched");
      assertEq(lastVerifiedOf("aid-verified"), null, "a8: aid-verified (NOT given) is untouched");
      const sumByNewStatusA = Object.values(roundA.body.by_new_status ?? {}).reduce(
        (s: number, n: any) => s + (n as number), 0,
      );
      assertTrue(sumByNewStatusA <= 2, "a9: by_new_status never exceeds the 2 given ids");

      // ── (b) JSON body agentIds — array form ─────────────────────────────
      clearTickLock();
      const roundB = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", bias_growth: "0" },
        body: { agentIds: ["aid-a2", "aid-a4"] },
      });

      assertEq(roundB.status, 200, "b1: 200 response");
      assertEq(roundB.body.processed, 2, "b2: processed exactly the 2 given ids (body form)");
      assertTrue(lastVerifiedOf("aid-a2") !== null, "b3: aid-a2 (given, body) was processed");
      assertTrue(lastVerifiedOf("aid-a4") !== null, "b4: aid-a4 (given, body) was processed");
      assertEq(lastVerifiedOf("aid-verified"), null, "b5: aid-verified (still NOT given) remains untouched");

      // ── (c) agentIds composes with reprocess_review_queue=1: an explicit
      // 'verified' id (which pickReviewQueueBatch's own WHERE clause would
      // NEVER select) is still processed — proves agentIds REPLACES pickFn's
      // selection entirely rather than filtering its output. ──────────────
      clearTickLock();
      const roundC = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", reprocess_review_queue: "1", agentIds: "aid-verified" },
        body: {},
      });

      assertEq(roundC.status, 200, "c1: 200 response");
      assertEq(roundC.body.processed, 1, "c2: processed exactly the 1 given id despite reprocess_review_queue=1");
      assertTrue(
        lastVerifiedOf("aid-verified") !== null,
        "c3: the explicit 'verified' id WAS processed — agentIds overrides pickReviewQueueBatch's own status filter entirely",
      );

      // ── (d) omitting agentIds — default behavior processes the whole
      // remaining batch, unaffected by this feature's existence. ─────────
      clearTickLock();
      const roundD = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        query: { force: "1", bias_growth: "0", batchSize: "50" },
        body: {},
      });
      assertEq(roundD.status, 200, "d1: 200 response");
      assertTrue(
        roundD.body.processed >= 5,
        `d2: no agentIds -> default selection processes every remaining seeded agent (got ${roundD.body.processed})`,
      );
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    // ── (e) sweep + agentIds: chunked consumption, terminates at exactly
    // ids.length processed (proves it does NOT loop forever — the default
    // scope's "empty chunk = backlog exhausted" signal can never fire for a
    // fixed id list). Exercises startSweep directly (fresh module instance,
    // same require.cache-reload convention as tests/test.ts's own
    // verifier-sweep block), with an injectable fake runBatch — no DB/route
    // involved. ────────────────────────────────────────────────────────────
    {
      const sweepPath = require.resolve("../services/verifier-sweep");
      delete require.cache[sweepPath];
      const sweepMod = require("../services/verifier-sweep") as typeof import("../services/verifier-sweep");

      const sweepDb = new Database(":memory:");
      sweepDb.exec(`CREATE TABLE agent_knowledge (agent_id TEXT PRIMARY KEY, verification_status TEXT NOT NULL DEFAULT 'pending_verify');`);

      const calls: string[][] = [];
      function fakeRunBatch(callOpts: any) {
        calls.push(callOpts.agentIds ?? []);
        const ids: string[] = callOpts.agentIds ?? [];
        return Promise.resolve({
          run_id: `run-fake-${calls.length}`,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          results: ids.map((id) => ({
            agent_id: id, passed: true, flags: [], fields_verified: [], fields_failed: [],
            http_status: 200, brreg_status: null, new_verification_status: "verified",
            new_enrichment_status: "partial", outreach_eligible_at: null,
            cross_source_reason: {}, url_last_probed: null, url_last_status: null,
            url_demoted: false, domain_incoherent: false,
          })),
        });
      }
      const noSleep = () => Promise.resolve();

      const fiveIds = ["s-1", "s-2", "s-3", "s-4", "s-5"];
      const resultE = sweepMod.startSweep({
        chunkSize: 2,
        runBatch: fakeRunBatch,
        sleep: noSleep,
        db: sweepDb,
        agentIds: fiveIds,
      });
      assertTrue(resultE.started === true, "e1: sweep starts with agentIds set");

      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (sweepMod.getSweepJob().status !== "running") {
            clearInterval(interval);
            resolve();
          }
        }, 10);
        setTimeout(() => { clearInterval(interval); resolve(); }, 2000);
      });

      const jobE = sweepMod.getSweepJob();
      assertEq(jobE.status, "done", "e2: sweep reaches status=done (does not loop forever)");
      assertEq(jobE.processed, 5, `e3: processed=5 (exactly ids.length) got ${jobE.processed}`);
      assertEq(calls.length, 3, `e4: runBatch called 3 times (2+2+1 chunks of 5 ids at chunkSize=2) got ${calls.length}`);
      assertEq(calls[0], ["s-1", "s-2"], "e5: first chunk is the first 2 ids");
      assertEq(calls[1], ["s-3", "s-4"], "e6: second chunk is the next 2 ids");
      assertEq(calls[2], ["s-5"], "e7: third chunk is the final, partial slice");
      sweepDb.close();
    }

    // ── (f) sweep + agentIds: an empty-result chunk (e.g. a stale/deleted
    // id) does not abort the sweep — it advances to the next slice instead
    // of stopping (unlike the default pending_verify scope, where an empty
    // chunk means "backlog exhausted, stop"). ─────────────────────────────
    {
      const sweepPath = require.resolve("../services/verifier-sweep");
      delete require.cache[sweepPath];
      const sweepMod = require("../services/verifier-sweep") as typeof import("../services/verifier-sweep");

      const sweepDb = new Database(":memory:");
      sweepDb.exec(`CREATE TABLE agent_knowledge (agent_id TEXT PRIMARY KEY, verification_status TEXT NOT NULL DEFAULT 'pending_verify');`);

      const calls: string[][] = [];
      function fakeRunBatchWithGap(callOpts: any) {
        const ids: string[] = callOpts.agentIds ?? [];
        calls.push(ids);
        // Simulate "x2" no longer matching any row (deleted/stale id) —
        // every OTHER id yields a normal result.
        const results = ids
          .filter((id) => id !== "x2")
          .map((id) => ({
            agent_id: id, passed: true, flags: [], fields_verified: [], fields_failed: [],
            http_status: 200, brreg_status: null, new_verification_status: "verified",
            new_enrichment_status: "partial", outreach_eligible_at: null,
            cross_source_reason: {}, url_last_probed: null, url_last_status: null,
            url_demoted: false, domain_incoherent: false,
          }));
        return Promise.resolve({
          run_id: `run-fake-gap-${calls.length}`,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          results,
        });
      }
      const noSleep = () => Promise.resolve();

      const resultF = sweepMod.startSweep({
        chunkSize: 1,
        runBatch: fakeRunBatchWithGap,
        sleep: noSleep,
        db: sweepDb,
        agentIds: ["x1", "x2", "x3"],
      });
      assertTrue(resultF.started === true, "f1: sweep starts");

      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (sweepMod.getSweepJob().status !== "running") {
            clearInterval(interval);
            resolve();
          }
        }, 10);
        setTimeout(() => { clearInterval(interval); resolve(); }, 2000);
      });

      const jobF = sweepMod.getSweepJob();
      assertEq(jobF.status, "done", "f2: sweep still reaches status=done despite one empty-result chunk");
      assertEq(calls.length, 3, `f3: all 3 id-chunks were attempted (empty chunk did not abort early) got ${calls.length}`);
      assertEq(jobF.processed, 2, `f4: processed=2 (x1 and x3 — x2's empty chunk contributed 0) got ${jobF.processed}`);
      sweepDb.close();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminRunVerifierAgentIdsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
