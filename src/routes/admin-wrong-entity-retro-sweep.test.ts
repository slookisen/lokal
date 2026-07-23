/**
 * admin-wrong-entity-retro-sweep.test.ts — tests
 * POST /admin/verifier/wrong-entity-retro-sweep
 * (dev-request 2026-07-16-wrong-entity-opprydding-rfb, platform-wide
 * retro-sweep detector step).
 *
 * Mirrors admin-domain-coherence.test.ts's harness (in-memory better-sqlite3
 * DB injected via __setDbForTesting + __initSchemaForTesting, router
 * exercised directly via router.handle(), exported
 * runAdminWrongEntityRetroSweepTests({log}) -> TestSummary, wired into
 * tests/test.ts via runSerial()).
 *
 * Coverage (per the spec's two implemented heuristics):
 *   - 3 agents sharing an identical (normalized) address -> one
 *     duplicate_value_clusters entry with all 3 agent_ids.
 *   - Only 2 agents sharing a value -> below the 3-agent threshold, not
 *     flagged.
 *   - A short/generic shared value (< MIN_CLUSTER_VALUE_LEN) is never
 *     grouped, however many agents share it.
 *   - address containing a postal code that differs from the stored
 *     postal_code column -> postal_code_mismatches entry.
 *   - address whose only 4-digit token IS the stored postal_code -> no
 *     mismatch.
 *   - An ambiguous address (0 or 2+ distinct 4-digit "poststed-shaped"
 *     tokens) is skipped, never guessed.
 *   - Umbrella agents excluded entirely from both heuristics.
 *   - apply:true stamps wrong_entity_retro_checked_at/_outcome on every
 *     agent in the cohort, and does NOT modify any content field (address/
 *     phone/opening_hours/website).
 *   - A second sweep within the 30-day parking window re-reports an empty
 *     cohort (nothing left to look at); WRONG_ENTITY_RETRO_PARKING_DISABLED
 *     =true removes the exclusion.
 *   - 403 without/with-wrong X-Admin-Key.
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

export function runAdminWrongEntityRetroSweepTests(
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
    const testKey = "admin-wrong-entity-retro-sweep-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevParkingDisabled = process.env.WRONG_ENTITY_RETRO_PARKING_DISABLED;
    delete process.env.WRONG_ENTITY_RETRO_PARKING_DISABLED;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, postal_code, phone, opening_hours, website, email, about, field_provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'A test farm shop', '{}')`,
      );

      // (1)-(3) Planted-address cluster: 3 unrelated agents sharing the
      // identical (case/whitespace-insensitive) address — mirrors the real
      // REKO-ring finding (addendum 2).
      insertAgent.run("agent-reko-1", "REKO-ringen Alpha", "https://reko-alpha.no", "key-reko-1", null);
      insertKnowledge.run("agent-reko-1", "Såkrokveien 156, 1923 Sørum", "1923", null, null, null, null);
      insertAgent.run("agent-reko-2", "REKO-ringen Beta", "https://reko-beta.no", "key-reko-2", null);
      insertKnowledge.run("agent-reko-2", "Såkrokveien 156, 1923 Sørum", "1923", null, null, null, null);
      insertAgent.run("agent-reko-3", "REKO-ringen Gamma", "https://reko-gamma.no", "key-reko-3", null);
      insertKnowledge.run("agent-reko-3", "  såkrokveien 156,  1923 sørum ", "1923", null, null, null, null);

      // (4)-(5) Only TWO agents share a value — below the 3-agent threshold.
      insertAgent.run("agent-pair-1", "Pargard A", "https://pargard-a.no", "key-pair-1", null);
      insertKnowledge.run("agent-pair-1", null, null, "99887766", null, null, null);
      insertAgent.run("agent-pair-2", "Pargard B", "https://pargard-b.no", "key-pair-2", null);
      insertKnowledge.run("agent-pair-2", null, null, "99887766", null, null, null);

      // (6)-(8) Three agents share a SHORT/generic opening_hours fragment —
      // must never cluster (below MIN_CLUSTER_VALUE_LEN).
      insertAgent.run("agent-short-1", "Kortgard A", "https://kortgard-a.no", "key-short-1", null);
      insertKnowledge.run("agent-short-1", null, null, null, "17:00", null, null);
      insertAgent.run("agent-short-2", "Kortgard B", "https://kortgard-b.no", "key-short-2", null);
      insertKnowledge.run("agent-short-2", null, null, null, "17:00", null, null);
      insertAgent.run("agent-short-3", "Kortgard C", "https://kortgard-c.no", "key-short-3", null);
      insertKnowledge.run("agent-short-3", null, null, null, "17:00", null, null);

      // (9) Postal-code-vs-address mismatch: address's poststed token (0655)
      // differs from the stored postal_code (1923, deliberately reusing an
      // otherwise-unrelated value so this agent isn't accidentally swept
      // into the address cluster above).
      insertAgent.run("agent-postal-mismatch", "Postgard Mismatch", "https://postgard-mismatch.no", "key-postal-mismatch", null);
      insertKnowledge.run("agent-postal-mismatch", "Solveien 4, 0655 Oslo", "1923", null, null, null, null);

      // (10) Postal code CORRECT — address's token matches stored postal_code.
      insertAgent.run("agent-postal-ok", "Postgard OK", "https://postgard-ok.no", "key-postal-ok", null);
      insertKnowledge.run("agent-postal-ok", "Fjordveien 2, 4321 Stedet", "4321", null, null, null, null);

      // (11) Ambiguous address (two distinct plausible poststed-shaped
      // tokens) — must be skipped, never guessed.
      insertAgent.run("agent-postal-ambiguous", "Postgard Ambiguous", "https://postgard-ambiguous.no", "key-postal-ambiguous", null);
      insertKnowledge.run("agent-postal-ambiguous", "Gate 1, 1111 Sted Og 2222 AnnetSted", "1111", null, null, null, null);

      // (12) Umbrella agent sharing the SAME planted address as the REKO
      // cluster — must be excluded entirely (not counted in cohort_size,
      // not added to the cluster).
      insertAgent.run("agent-umbrella-reko", "Umbrella REKO", "https://umbrella-reko.no", "key-umbrella-reko", "network");
      insertKnowledge.run("agent-umbrella-reko", "Såkrokveien 156, 1923 Sørum", "1923", null, null, null, null);

      // Fresh require so the router picks up the just-injected db.
      delete require.cache[require.resolve("./admin-wrong-entity-retro-sweep")];
      const routeMod = require("./admin-wrong-entity-retro-sweep");
      const router = routeMod.default;

      function post(body: any, key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", url: "/", headers, body });
      }

      // ── auth gate ──────────────────────────────────────────────────────
      let result = await post({}, false);
      assertEq(result.status, 403, "wers-01: missing X-Admin-Key -> 403");
      result = await post({}, "wrong-key");
      assertEq(result.status, 403, "wers-02: wrong X-Admin-Key -> 403");

      // ── dry-run ──────────────────────────────────────────────────────
      result = await post({});
      assertEq(result.status, 200, "wers-03: dry-run POST -> 200");
      const body1 = result.body;
      assertEq(body1.apply, false, "wers-04: apply reflects false when absent");
      // cohort = 11 non-umbrella agents (reko x3, pair x2, short x3, postal x3) — umbrella excluded
      assertEq(body1.cohort_size, 11, "wers-05: cohort_size excludes the umbrella agent (11)");

      const rekoCluster = body1.duplicate_value_clusters.find((c: any) => c.field === "address");
      assertTrue(!!rekoCluster, "wers-06: an address cluster was found");
      assertEq(rekoCluster.agent_count, 3, "wers-07: address cluster has exactly 3 agents (umbrella excluded)");
      assertEq(
        rekoCluster.agents.map((a: any) => a.agent_id).sort(),
        ["agent-reko-1", "agent-reko-2", "agent-reko-3"],
        "wers-08: address cluster names exactly the 3 REKO agents",
      );

      const phoneCluster = body1.duplicate_value_clusters.find((c: any) => c.field === "phone");
      assertTrue(!phoneCluster, "wers-09: a 2-agent phone match never forms a cluster (below threshold)");

      const hoursCluster = body1.duplicate_value_clusters.find((c: any) => c.field === "opening_hours");
      assertTrue(!hoursCluster, "wers-10: a short/generic shared value never clusters regardless of count");

      assertEq(body1.postal_code_mismatches.length, 1, "wers-11: exactly one postal-code mismatch found");
      assertEq(body1.postal_code_mismatches[0].agent_id, "agent-postal-mismatch", "wers-12: the mismatch is the expected agent");
      assertEq(body1.postal_code_mismatches[0].address_postal_code, "0655", "wers-13: extracted address postal code is 0655");
      assertEq(body1.postal_code_mismatches[0].stored_postal_code, "1923", "wers-14: stored postal code reported as 1923");

      const mismatchIds = body1.postal_code_mismatches.map((m: any) => m.agent_id);
      assertTrue(!mismatchIds.includes("agent-postal-ok"), "wers-15: matching postal code never flagged");
      assertTrue(!mismatchIds.includes("agent-postal-ambiguous"), "wers-16: ambiguous address never guessed/flagged");

      // flagged_count = 3 (reko cluster) + 1 (postal mismatch) = 4, no overlap
      assertEq(body1.flagged_count, 4, "wers-17: flagged_count unions both heuristics without double-counting");

      // Dry-run must not write anything.
      const preApply = db.prepare("SELECT address, wrong_entity_retro_checked_at FROM agent_knowledge WHERE agent_id = 'agent-reko-1'").get() as any;
      assertEq(preApply.address, "Såkrokveien 156, 1923 Sørum", "wers-18: dry-run does not touch content fields");
      assertEq(preApply.wrong_entity_retro_checked_at, null, "wers-19: dry-run does not stamp parking markers");

      // ── apply mode ───────────────────────────────────────────────────
      result = await post({ apply: true });
      assertEq(result.status, 200, "wers-20: apply POST -> 200");
      assertEq(result.body.apply, true, "wers-21: apply reflects true");
      assertEq(result.body.parked, 11, "wers-22: parked stamps every agent in the cohort (11)");

      const postApplyReko = db.prepare("SELECT address, wrong_entity_retro_outcome FROM agent_knowledge WHERE agent_id = 'agent-reko-1'").get() as any;
      assertEq(postApplyReko.address, "Såkrokveien 156, 1923 Sørum", "wers-23: apply NEVER writes the address content field");
      assertEq(postApplyReko.wrong_entity_retro_outcome, "duplicate_cluster", "wers-24: apply stamps the duplicate_cluster outcome");

      const postApplyOk = db.prepare("SELECT wrong_entity_retro_outcome FROM agent_knowledge WHERE agent_id = 'agent-postal-ok'").get() as any;
      assertEq(postApplyOk.wrong_entity_retro_outcome, "no_action_needed", "wers-25: a clean agent is stamped no_action_needed");

      // ── parking backoff ────────────────────────────────────────────────
      result = await post({});
      assertEq(result.body.cohort_size, 0, "wers-26: a second sweep within the 30-day window finds an empty cohort (all parked)");

      process.env.WRONG_ENTITY_RETRO_PARKING_DISABLED = "true";
      result = await post({});
      assertEq(result.body.cohort_size, 11, "wers-27: WRONG_ENTITY_RETRO_PARKING_DISABLED=true removes the exclusion");
      delete process.env.WRONG_ENTITY_RETRO_PARKING_DISABLED;
    } catch (err: any) {
      failed++;
      failures.push(`✗ unexpected error: ${String(err?.message || err)}\n${err?.stack || ""}`);
    } finally {
      initMod.__setDbForTesting(prevDb as any);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevParkingDisabled === undefined) delete process.env.WRONG_ENTITY_RETRO_PARKING_DISABLED;
      else process.env.WRONG_ENTITY_RETRO_PARKING_DISABLED = prevParkingDisabled;
      db.close();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminWrongEntityRetroSweepTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
