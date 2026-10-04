/**
 * admin-runs-verifier-queue.test.ts — claim-less envelopes stop clogging the
 * platform-verifier queue (fleet plumbing 2026-10-04):
 *   POST /admin/runs          — claims:[] and no explicit verifier_state → stored 'skipped'
 *   GET  /admin/runs/pending  — claim-less runs never listed; aged_out_count exposes the
 *                               verifiable backlog that fell out of max_age_hours
 *   listStaleRuns()           — claim-less runs never reported stale
 *
 * Context: loop-dispatcher wakes, daniel-manual-trigger and fire-markers carry zero
 * claims (~40% of envelopes). They were 'pending' forever and took slots in the
 * verifier's 20-run cap, so claim-bearing runs aged out of the 48h window unverified.
 *
 * Mirrors admin-runs-lock.test.ts: synchronous route exercise via router.handle(),
 * real init.ts schema on a pinned in-memory DB, wired into tests/test.ts.
 */

import { __pinInMemoryDbForTesting, getDb } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRouteSync(
  router: any,
  opts: { method?: string; url: string; body?: any; query?: Record<string, string>; headers?: Record<string, string> },
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const headers = opts.headers || {};
  const req: any = {
    method: opts.method || "GET",
    url: opts.url,
    query: opts.query || {},
    headers,
    body: opts.body,
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
      result = { status: this.statusCode, body: payload };
      return this;
    },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

export function runAdminRunsVerifierQueueTests(opts: { log?: boolean } = {}): TestSummary {
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
    assertEq(cond, true, label);
  }

  const testKey = process.env.ADMIN_KEY || "admin-runs-verifier-queue-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = testKey;
  const restoreDb = __pinInMemoryDbForTesting();

  try {
    const db = getDb();
    const router = require("./admin-runs").default;
    const { listStaleRuns, listPendingVerification, countAgedOutPending } =
      require("../services/run-ledger") as typeof import("../services/run-ledger");
    const AUTH = { "x-admin-key": testKey };
    const CLAIM = [{ type: "commit", value: "abc1234" }];

    const stateOf = (runId: string) =>
      db.prepare("SELECT verifier_state, verifier_checked_at FROM runs WHERE run_id = ?").get(runId) as
        | { verifier_state: string; verifier_checked_at: string | null }
        | undefined;
    const post = (body: any) => callRouteSync(router, { method: "POST", url: "/", headers: AUTH, body });
    const now = new Date().toISOString();
    const env = (run_id: string, claims: any[], extra: Record<string, unknown> = {}) => ({
      run_id,
      agent: "loop-dispatcher",
      status: "completed",
      started_at: now,
      finished_at: now,
      claims,
      ...extra,
    });

    // ── 1. POST claim-less envelope → stored 'skipped', response says why ──
    const r1 = post(env("vq-noclaims", []));
    assertEq(r1.status, 200, "claim-less POST: status 200");
    assertEq(r1.body?.verifier_state, "skipped", "claim-less POST: response reports verifier_state=skipped");
    assertEq(r1.body?.verifier_skip_reason, "no_claims", "claim-less POST: response carries reason no_claims");
    assertEq(stateOf("vq-noclaims")?.verifier_state, "skipped", "claim-less POST: DB row verifier_state=skipped");
    assertEq(stateOf("vq-noclaims")?.verifier_checked_at, null,
      "claim-less POST: verifier_checked_at stays NULL (the verifier never touched it)");

    // ── 2. POST claim-bearing envelope → unchanged: 'pending' ─────────────
    const r2 = post(env("vq-claims", CLAIM));
    assertEq(r2.status, 200, "claim-bearing POST: status 200");
    assertEq(r2.body?.verifier_state, undefined, "claim-bearing POST: no skip fields in response");
    assertEq(stateOf("vq-claims")?.verifier_state, "pending", "claim-bearing POST: DB row stays pending");

    // ── 3. Explicit verifier_state opts out of the auto-skip ──────────────
    const r3 = post(env("vq-noclaims-explicit", [], { verifier_state: "pending" }));
    assertEq(r3.status, 200, "explicit verifier_state: status 200");
    assertEq(r3.body?.verifier_skip_reason, undefined, "explicit verifier_state: no auto-skip");
    assertEq(stateOf("vq-noclaims-explicit")?.verifier_state, "pending",
      "explicit verifier_state: claim-less row stays pending");
    // …but an agent can never SET its own verifier verdict (proposer ≠ admitter).
    post(env("vq-self-verified", CLAIM, { verifier_state: "verified" }));
    assertEq(stateOf("vq-self-verified")?.verifier_state, "pending",
      "explicit verifier_state=verified is NOT persisted (agents can't self-verify)");

    // ── 4. Idempotent: re-POST of a skipped run_id with claims doesn't flip it ─
    post(env("vq-noclaims", CLAIM));
    assertEq(stateOf("vq-noclaims")?.verifier_state, "skipped", "re-POST same run_id: first write wins (no-op)");

    // ── 5. GET /pending: claim-less excluded, oldest-first, aged_out_count ─
    db.exec("DELETE FROM runs");
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    const ins = db.prepare(`
      INSERT INTO runs (run_id, agent, trigger_source, started_at, finished_at, status, claims, verifier_state)
      VALUES (?, 'a', 'cron', ?, ?, 'completed', ?, ?)
    `);
    const C = JSON.stringify(CLAIM);
    ins.run("p-fresh-newer", hoursAgo(1), hoursAgo(1), C, "pending");
    ins.run("p-fresh-older", hoursAgo(5), hoursAgo(5), C, "pending");
    ins.run("p-fresh-noclaims", hoursAgo(3), hoursAgo(3), "[]", "pending"); // legacy pending claim-less
    ins.run("p-fresh-malformed", hoursAgo(2), hoursAgo(2), "not-json", "pending");
    ins.run("p-old-claims", hoursAgo(72), hoursAgo(72), C, "pending"); // aged out
    ins.run("p-old-noclaims", hoursAgo(72), hoursAgo(72), "[]", "pending"); // not verifiable → not counted
    ins.run("p-old-verified", hoursAgo(72), hoursAgo(72), C, "verified"); // done → not counted
    ins.run("firemarker-2026-x-platform-orchestrator", hoursAgo(72), hoursAgo(72), C, "pending");

    const g1 = callRouteSync(router, { url: "/pending", headers: AUTH });
    assertEq(g1.status, 200, "GET /pending: status 200 (malformed claims row does not crash the query)");
    assertEq((g1.body?.runs || []).map((r: any) => r.run_id), ["p-fresh-older", "p-fresh-newer"],
      "GET /pending: only claim-bearing runs, oldest first");
    assertEq(g1.body?.count, 2, "GET /pending: count matches listed runs");
    assertEq(g1.body?.aged_out_count, 1,
      "GET /pending: aged_out_count = verifiable pending runs older than max_age_hours (excl. claim-less/verified/firemarker)");
    assertEq(g1.body?.max_age_hours, 48, "GET /pending: echoes the default max_age_hours");

    const g2 = callRouteSync(router, { url: "/pending", headers: AUTH, query: { max_age_hours: "100" } });
    assertEq((g2.body?.runs || []).map((r: any) => r.run_id), ["p-old-claims", "p-fresh-older", "p-fresh-newer"],
      "GET /pending?max_age_hours=100: the older claim-bearing run is back in window, still oldest first");
    assertEq(g2.body?.aged_out_count, 0, "GET /pending?max_age_hours=100: nothing aged out");

    assertEq(countAgedOutPending({ db, maxAgeHours: 48, vertical: "tannlege" }), 0,
      "countAgedOutPending: vertical filter applies");
    assertEq(listPendingVerification({ db }).some((r) => r.claims.length === 0), false,
      "listPendingVerification: never returns a claim-less run");

    // ── 6. listStaleRuns: claim-less pending runs are not "stale" ─────────
    const stale = listStaleRuns({ db }).map((r) => r.run_id);
    assertTrue(stale.includes("p-old-claims"), "listStaleRuns: claim-bearing pending run is still reported");
    assertTrue(!stale.includes("p-old-noclaims") && !stale.includes("p-fresh-noclaims"),
      "listStaleRuns: claim-less pending runs are excluded");
  } catch (err) {
    failed++;
    failures.push(`admin-runs-verifier-queue: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    restoreDb();
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  const r = runAdminRunsVerifierQueueTests({ log: true });
  console.log(`\nadmin-runs-verifier-queue: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
