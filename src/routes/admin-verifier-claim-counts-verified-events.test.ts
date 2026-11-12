/**
 * admin-verifier-claim-counts-verified-events.test.ts — dev-request
 * 2026-11-11-verifier-ny-verifisering-og-delta-ledd, slice B ("delta-leddet").
 *
 * The agents_verified claim is "results this run set to verified". Delta
 * mode of GET /admin/verifier/claim-counts?kind=agents_verified used to count
 * rows whose CURRENT status is verified AND whose CURRENT last_verified_at is
 * inside the window — which a later run's applyVerifierOutcome overwrites.
 * applyVerifierOutcome now appends verifier_verified_events rows, and delta
 * mode for agents_verified counts those.
 *
 * Coverage:
 *   (a) verified in run 1, re-processed (verified again) in run 2 -> run 1's
 *       window still counts 1, run 2's window counts 1.
 *   (b) verified in run 1, demoted in run 2 -> run 1 still counts it.
 *   (c) non-verified outcomes write no event.
 *   (d) snapshot mode for agents_verified and delta for another kind are
 *       unaffected by the event log.
 *   (e) a window before the first recorded event falls back to the original
 *       current-state query.
 *   (f) applyVerifierOutcome does not throw when the events table is absent.
 *   (g) the same agent verified twice in one run counts once (per run).
 *
 * Exported runAdminVerifierClaimCountsVerifiedEventsTests({log}) ->
 * TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-verifier-claim-counts-verified-events.test.ts
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

export function runAdminVerifierClaimCountsVerifiedEventsTests(
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
    const testKey = process.env.ADMIN_KEY || "admin-verifier-claim-counts-events-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const { applyVerifierOutcome } = require("../agents/lokal-agent-verifier") as typeof import("../agents/lokal-agent-verifier");
      delete require.cache[require.resolve("./admin-verifier-claim-counts")];
      const router = require("./admin-verifier-claim-counts").default;
      const get = (qs: string) => callRoute(router, `/?${qs}`, { "x-admin-key": testKey });

      let n = 0;
      function seed(id: string, status: string, lastVerifiedAt: string | null, updatedAt: string | null = null): void {
        n++;
        db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
           VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.no', 'producer', ?, 1)`,
        ).run(id, `${id} AS`, `key-${id}-${n}`);
        db.prepare(
          `INSERT INTO agent_knowledge (agent_id, verification_status, last_verified_at, updated_at, about, field_provenance)
           VALUES (?, ?, ?, ?, 'A test farm shop', '{}')`,
        ).run(id, status, lastVerifiedAt, updatedAt);
      }

      function apply(id: string, status: string, runStartedAt: string, withProbe: boolean): void {
        applyVerifierOutcome(db, id, {
          new_verification_status: status,
          new_enrichment_status: "rich",
          http_status: 200,
          runStartedAt,
          eligibleAt: null,
          ...(withProbe ? { url_last_probed: runStartedAt, url_last_status: 200 } : {}),
        });
      }

      // A pre-deploy agent: verified long before any event exists. Used for
      // the fallback check (e) — no event ever written for it.
      seed("pre-deploy", "verified", "2026-10-01T10:00:00.000Z");

      // Two hourly runs, each window [started, finished].
      const R1_START = "2026-11-10T23:08:00.123Z";
      const R1_END = "2026-11-10T23:09:30.000Z";
      const R2_START = "2026-11-11T00:08:00.456Z";
      const R2_END = "2026-11-11T00:09:30.000Z";

      seed("a-reverified", "pending_verify", null);
      seed("b-demoted", "pending_verify", null);
      seed("c-pending", "pending_verify", null);
      seed("c-review", "pending_verify", null);
      seed("g-dup", "pending_verify", null);

      // Run 1: three verified (one via each UPDATE branch), two non-verified.
      apply("a-reverified", "verified", R1_START, true);
      apply("b-demoted", "verified", R1_START, false);
      apply("g-dup", "verified", R1_START, true);
      apply("g-dup", "verified", R1_START, true); // accidental double-apply in one run
      apply("c-pending", "pending_verify", R1_START, true);
      apply("c-review", "review_required", R1_START, false);

      // Run 2: a re-verified (stamp moves to R2), b demoted.
      apply("a-reverified", "verified", R2_START, true);
      apply("b-demoted", "review_required", R2_START, true);

      // (c) non-verified outcomes write no event.
      const evNonVerified = db
        .prepare(`SELECT COUNT(*) AS c FROM verifier_verified_events WHERE agent_id IN ('c-pending','c-review')`)
        .get() as { c: number };
      assertEq(evNonVerified.c, 0, "vve-01: pending_verify/review_required outcomes write no verifier_verified_events row");
      const evB = db
        .prepare(`SELECT run_started_at FROM verifier_verified_events WHERE agent_id = 'b-demoted'`)
        .all() as Array<{ run_started_at: string }>;
      assertEq(evB.map((r) => r.run_started_at), [R1_START], "vve-02: demoting outcome writes no event; the run-1 verified event (no-probe branch) is kept");

      // Legacy semantics would now give run 1 a count of 1 (only g-dup still
      // verified with the R1 stamp) — the bug.
      let r = await get(`kind=agents_verified&since=${R1_START}&until=${R1_END}`);
      assertEq(r.status, 200, "vve-03: run-1 window -> 200");
      // (a)+(b)+(g): a, b and g-dup verified by run 1 -> 3, despite a's stamp
      // being overwritten, b being demoted, and g-dup applied twice.
      assertEq(r.body.count, 3, "vve-04: run-1 window counts every agent run 1 verified (stamp overwritten / demoted later / double-apply once)");
      assertEq(
        r.body.sample.map((s: any) => s.id),
        ["a-reverified", "b-demoted", "g-dup"],
        "vve-05: run-1 sample lists the agents verified by run 1, ordered by id",
      );
      assertEq(r.body.sample[0].name, "a-reverified AS", "vve-06: sample carries agent name");
      assertEq(
        Object.keys(r.body).sort(),
        ["count", "kind", "mode", "sample", "since", "success", "until"],
        "vve-07: response shape unchanged",
      );
      assertEq(r.body.since, "2026-11-10 23:08:00", "vve-08: since echoed normalized as before");

      r = await get(`kind=agents_verified&since=${R2_START}&until=${R2_END}`);
      assertEq(r.body.count, 1, "vve-09: run-2 window counts only a-reverified (b was demoted in run 2)");

      // Whole span covering both runs: one per (agent, run) -> a twice, b, g.
      r = await get(`kind=agents_verified&since=${R1_START}&until=${R2_END}`);
      assertEq(r.body.count, 4, "vve-10: window spanning both runs counts per agent per run");

      // (d) snapshot mode for agents_verified is still current state.
      r = await get(`kind=agents_verified&mode=snapshot`);
      // currently verified: pre-deploy, a-reverified, g-dup
      assertEq(r.body.count, 3, "vve-11: snapshot mode for agents_verified still counts current verified rows");
      assertEq(r.body.since, null, "vve-12: snapshot mode still echoes since=null");

      // (d) another kind in delta mode is unaffected (updated_at based).
      seed("rr-x", "review_required", null, "2026-11-10T23:08:30.000Z");
      r = await get(`kind=agents_review_required&since=${R1_START}&until=${R1_END}`);
      assertEq(r.body.count, 1, "vve-13: agents_review_required delta still uses agent_knowledge.updated_at");

      // (e) a window entirely before the first event falls back to the
      // original current-state query.
      r = await get(`kind=agents_verified&since=2026-10-01T09:00:00Z&until=2026-10-01T11:00:00Z`);
      assertEq(r.body.count, 1, "vve-14: pre-event window falls back to legacy query (pre-deploy row counted)");
      assertEq(r.body.sample.map((s: any) => s.id), ["pre-deploy"], "vve-15: fallback sample from legacy query");

      // (f) applyVerifierOutcome with no events table never throws.
      const bare = new Database(":memory:");
      bare.exec(`CREATE TABLE agent_knowledge (
        agent_id TEXT PRIMARY KEY, verification_status TEXT, enrichment_status TEXT,
        last_verified_at TEXT, last_http_check_at TEXT, last_http_status INTEGER,
        outreach_eligible_at TEXT, verification_review_reason TEXT)`);
      bare.prepare(`INSERT INTO agent_knowledge (agent_id, verification_status) VALUES ('x', 'pending_verify')`).run();
      let threw = false;
      try {
        applyVerifierOutcome(bare, "x", {
          new_verification_status: "verified",
          new_enrichment_status: "rich",
          http_status: 200,
          runStartedAt: R1_START,
          eligibleAt: null,
        });
      } catch {
        threw = true;
      }
      assertEq(threw, false, "vve-16: missing verifier_verified_events table never breaks applyVerifierOutcome");
      assertEq(
        (bare.prepare(`SELECT verification_status FROM agent_knowledge WHERE agent_id='x'`).get() as any).verification_status,
        "verified",
        "vve-17: the verification write itself still lands without the events table",
      );
      bare.close();
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminVerifierClaimCountsVerifiedEventsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
