/**
 * admin-runs-lock.test.ts — tests for the orchestrator run-lock endpoints
 * (dev-request orch-pr-20260724-wake-mutex, slookisen/lokal):
 *   POST /admin/runs/lock
 *   POST /admin/runs/lock/release
 *
 * Context: platform-orchestrator is the fleet's one build lane (WIP limit
 * of 1). Two independent Claude Code sessions can start within the same
 * minute (a cron spine-tick racing a manual/signal trigger) and both pass
 * the existing dev-request lease + fire-marker dedup before either commits
 * anything — a proven double-fire that once produced a 1811-line duplicate
 * PR. This lock is a server-side mutex (the ledger backend both sessions
 * already talk to over HTTP) closing that specific race: acquireLock() is
 * a single atomic INSERT...ON CONFLICT...DO UPDATE...WHERE statement, not a
 * SELECT-then-write, so there's no window for a second caller to land in.
 *
 * These tests exercise the ROUTE layer (validation, status codes, response
 * shapes, admin-key gating) end-to-end against a real in-memory schema, and
 * additionally assert directly on the orchestrator_locks table to prove the
 * "never overwrite an active lock" / "never delete someone else's lock"
 * guarantees actually hold at the DB level, not just in the JSON response.
 *
 * Mirrors admin-blocklist-manual-entry.test.ts / admin-run-verifier-drain-
 * observability.test.ts: synchronous route exercise via router.handle(),
 * real init.ts schema, wired into tests/test.ts. Router paths are relative
 * to the router's own mount point ("/lock", "/lock/release") — admin-runs.ts
 * is mounted at /admin/runs in index.ts, but router.handle() here bypasses
 * that mount, so url must be the router-relative path.
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";

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
  opts: { method?: string; url: string; body?: any; headers?: Record<string, string> },
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const headers = opts.headers || {};
  const req: any = {
    method: opts.method || "GET",
    url: opts.url,
    query: {},
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

export function runAdminRunsLockTests(opts: { log?: boolean } = {}): TestSummary {
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

  const testKey = process.env.ADMIN_KEY || "admin-runs-lock-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = testKey;

  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  try {
    const router = require("./admin-runs").default;

    function getLockRow(agent: string): { agent: string; run_id: string; started_at: string; locked_at: string } | undefined {
      return db.prepare("SELECT * FROM orchestrator_locks WHERE agent = ?").get(agent) as any;
    }

    const AUTH = { "x-admin-key": testKey };

    // ── 1. Fresh acquire (no existing lock) → 200, locked:true ─────────
    const r1 = callRouteSync(router, {
      method: "POST",
      url: "/lock",
      headers: AUTH,
      body: { agent: "platform-orchestrator", run_id: "run-A", started_at: new Date().toISOString() },
    });
    assertEq(r1.status, 200, "fresh acquire: status 200");
    assertEq(r1.body, { success: true, locked: true }, "fresh acquire: response shape");
    assertEq(getLockRow("platform-orchestrator")?.run_id, "run-A", "fresh acquire: DB row holds run-A");

    // ── 2. Acquire while a FRESH lock is held by someone else → 409 ────
    const rowBeforeConflict = getLockRow("platform-orchestrator");
    const r2 = callRouteSync(router, {
      method: "POST",
      url: "/lock",
      headers: AUTH,
      body: { agent: "platform-orchestrator", run_id: "run-B", started_at: new Date().toISOString() },
    });
    assertEq(r2.status, 409, "contended acquire (fresh holder): status 409");
    assertEq(r2.body?.success, false, "contended acquire: success:false");
    assertEq(r2.body?.locked, false, "contended acquire: locked:false");
    assertEq(r2.body?.holder?.run_id, "run-A", "contended acquire: holder.run_id is the ORIGINAL holder (run-A), not the loser (run-B)");
    assertEq(r2.body?.holder?.started_at, rowBeforeConflict?.started_at, "contended acquire: holder.started_at matches original row");
    const rowAfterConflict = getLockRow("platform-orchestrator");
    assertEq(rowAfterConflict, rowBeforeConflict, "contended acquire: DB row is BYTE-FOR-BYTE unchanged (no overwrite happened)");

    // ── 3. Acquire when existing lock is STALE (>90 min) → 200, new holder ─
    // Staleness keys off the SERVER-stamped `locked_at`, never the
    // caller-supplied `started_at` (orch-pr-20260724-wake-mutex bug fix —
    // see acquireLock() JSDoc). To prove that in this test, we deliberately
    // backdate ONLY `locked_at` here and leave `started_at` at whatever
    // fresh value run-A's original acquire wrote — if the lock is still
    // correctly treated as stale despite a FRESH started_at, staleness must
    // be coming from locked_at alone.
    const staleLockedAt = new Date(Date.now() - 91 * 60_000).toISOString();
    db.prepare(
      "UPDATE orchestrator_locks SET locked_at = ? WHERE agent = ?",
    ).run(staleLockedAt, "platform-orchestrator");
    const r3 = callRouteSync(router, {
      method: "POST",
      url: "/lock",
      headers: AUTH,
      body: { agent: "platform-orchestrator", run_id: "run-C", started_at: new Date().toISOString() },
    });
    assertEq(r3.status, 200, "stale acquire (by locked_at, started_at left fresh): status 200");
    assertEq(r3.body, { success: true, locked: true }, "stale acquire: response shape");
    assertEq(getLockRow("platform-orchestrator")?.run_id, "run-C", "stale acquire: DB row now shows NEW run_id (run-C)");

    // Boundary sanity: a lock LOCKED exactly 89 minutes ago is NOT stale
    // (default staleMinutes=90) and must still block a contender — again,
    // only `locked_at` is backdated; `started_at` is left at run-C's fresh
    // value from the acquire above, so this isolates locked_at as the sole
    // staleness signal.
    const almostStaleLockedAt = new Date(Date.now() - 89 * 60_000).toISOString();
    db.prepare(
      "UPDATE orchestrator_locks SET locked_at = ? WHERE agent = ?",
    ).run(almostStaleLockedAt, "platform-orchestrator");
    const r3b = callRouteSync(router, {
      method: "POST",
      url: "/lock",
      headers: AUTH,
      body: { agent: "platform-orchestrator", run_id: "run-D", started_at: new Date().toISOString() },
    });
    assertEq(r3b.status, 409, "89-min-old (by locked_at) lock: still fresh, contender rejected with 409");
    assertEq(getLockRow("platform-orchestrator")?.run_id, "run-C", "89-min-old lock: DB row still shows run-C");

    // ── 4. Release by the CURRENT holder → released:true, row gone ─────
    const r4 = callRouteSync(router, {
      method: "POST",
      url: "/lock/release",
      headers: AUTH,
      body: { agent: "platform-orchestrator", run_id: "run-C" },
    });
    assertEq(r4.status, 200, "release by current holder: status 200");
    assertEq(r4.body, { success: true, released: true }, "release by current holder: response shape");
    assertEq(getLockRow("platform-orchestrator"), undefined, "release by current holder: row is gone");

    // ── 5. Release by a run_id that is NOT the current holder ──────────
    // 5a. Nobody holds the lock right now (released above) — releasing an
    // arbitrary run_id is a no-op, not an error.
    const r5a = callRouteSync(router, {
      method: "POST",
      url: "/lock/release",
      headers: AUTH,
      body: { agent: "platform-orchestrator", run_id: "run-C" },
    });
    assertEq(r5a.status, 200, "release when nobody holds it: status 200 (no-op, not an error)");
    assertEq(r5a.body, { success: true, released: false }, "release when nobody holds it: released:false");

    // 5b. Someone ELSE holds the lock — a late release from a run that lost
    // the race must not delete the new holder's lock.
    const r5setup = callRouteSync(router, {
      method: "POST",
      url: "/lock",
      headers: AUTH,
      body: { agent: "platform-orchestrator", run_id: "run-E", started_at: new Date().toISOString() },
    });
    assertEq(r5setup.body?.locked, true, "release-vs-other-holder setup: run-E acquired the lock");
    const rowBeforeBadRelease = getLockRow("platform-orchestrator");
    const r5b = callRouteSync(router, {
      method: "POST",
      url: "/lock/release",
      headers: AUTH,
      body: { agent: "platform-orchestrator", run_id: "run-D" }, // run-D never held it
    });
    assertEq(r5b.status, 200, "release by a non-holder run_id: status 200 (no-op, not an error)");
    assertEq(r5b.body, { success: true, released: false }, "release by a non-holder run_id: released:false");
    const rowAfterBadRelease = getLockRow("platform-orchestrator");
    assertEq(rowAfterBadRelease, rowBeforeBadRelease, "release by a non-holder run_id: run-E's lock is still intact (not deleted)");
    assertEq(rowAfterBadRelease?.run_id, "run-E", "release by a non-holder run_id: DB row still shows run-E as holder");

    // ── 6. Missing/empty agent or run_id → 400 ──────────────────────────
    const badLockBodies: Array<[string, any]> = [
      ["lock: missing agent", { run_id: "run-X", started_at: new Date().toISOString() }],
      ["lock: empty agent", { agent: "", run_id: "run-X", started_at: new Date().toISOString() }],
      ["lock: missing run_id", { agent: "platform-orchestrator", started_at: new Date().toISOString() }],
      ["lock: empty run_id", { agent: "platform-orchestrator", run_id: "", started_at: new Date().toISOString() }],
      ["lock: missing started_at", { agent: "platform-orchestrator", run_id: "run-X" }],
      ["lock: empty started_at", { agent: "platform-orchestrator", run_id: "run-X", started_at: "" }],
    ];
    for (const [label, body] of badLockBodies) {
      const r = callRouteSync(router, { method: "POST", url: "/lock", headers: AUTH, body });
      assertEq(r.status, 400, `${label} -> 400`);
    }

    const badReleaseBodies: Array<[string, any]> = [
      ["release: missing agent", { run_id: "run-X" }],
      ["release: empty agent", { agent: "", run_id: "run-X" }],
      ["release: missing run_id", { agent: "platform-orchestrator" }],
      ["release: empty run_id", { agent: "platform-orchestrator", run_id: "" }],
    ];
    for (const [label, body] of badReleaseBodies) {
      const r = callRouteSync(router, { method: "POST", url: "/lock/release", headers: AUTH, body });
      assertEq(r.status, 400, `${label} -> 400`);
    }

    // ── 7. Missing/wrong X-Admin-Key → 403 ──────────────────────────────
    const r7a = callRouteSync(router, {
      method: "POST",
      url: "/lock",
      body: { agent: "platform-orchestrator", run_id: "run-Z", started_at: new Date().toISOString() },
    });
    assertEq(r7a.status, 403, "lock: missing X-Admin-Key -> 403");

    const r7b = callRouteSync(router, {
      method: "POST",
      url: "/lock",
      headers: { "x-admin-key": "wrong-key" },
      body: { agent: "platform-orchestrator", run_id: "run-Z", started_at: new Date().toISOString() },
    });
    assertEq(r7b.status, 403, "lock: wrong X-Admin-Key -> 403");

    const r7c = callRouteSync(router, {
      method: "POST",
      url: "/lock/release",
      body: { agent: "platform-orchestrator", run_id: "run-Z" },
    });
    assertEq(r7c.status, 403, "release: missing X-Admin-Key -> 403");

    const r7d = callRouteSync(router, {
      method: "POST",
      url: "/lock/release",
      headers: { "x-admin-key": "wrong-key" },
      body: { agent: "platform-orchestrator", run_id: "run-Z" },
    });
    assertEq(r7d.status, 403, "release: wrong X-Admin-Key -> 403");

    // ── 8. Sanity: existing routes on this router are untouched ────────
    // Not exhaustive (out of scope to re-test), but a cheap regression pin
    // that mounting the two new routes didn't break GET /summary.
    const r8 = callRouteSync(router, { method: "GET", url: "/summary", headers: AUTH });
    assertEq(r8.status, 200, "sanity: GET /summary (pre-existing route) still 200");
    assertTrue(typeof r8.body?.total === "number", "sanity: GET /summary still returns a total count");

    // ── 9. Malformed/garbage started_at must NOT be able to wedge or defeat
    // the lock (orch-pr-20260724-wake-mutex bug fix). Before the fix,
    // acquireLock()'s staleness WHERE guard compared the CALLER-SUPPLIED
    // started_at against a server-computed cutoff via a raw lexicographic
    // string comparison — and started_at has no format validation beyond
    // "non-empty string" at the route layer. A value like "not-a-date" or a
    // far-future date sorts lexicographically AFTER any real ISO cutoff
    // ("n" > any digit; "9999" > "20xx"), so the old WHERE guard's
    // `started_at < @staleCutoff` was permanently FALSE for those values —
    // the lock could never be judged stale and was wedged forever. The fix
    // keys staleness off the server-stamped `locked_at` instead, so none of
    // this should matter any more: the route still accepts these malformed
    // values (no new format validation was added — the fix removes the need
    // for it by not trusting the field for anything correctness-relevant),
    // but staleness/reacquisition must work correctly regardless of what
    // garbage is stored in started_at.
    const garbageStartedAtValues = [
      "not-a-date",
      "9999-12-31T23:59:59.999Z", // far-future date: lexicographically > any real cutoff
      "2099-01-01T00:00:00+05:00", // non-"Z"-suffixed offset timestamp
      String(Date.now()), // epoch number as a string
    ];

    for (const [i, garbage] of garbageStartedAtValues.entries()) {
      const agent = `garbage-started-at-agent-${i}`;

      // Fresh acquire with a malformed started_at is still accepted (route
      // layer only checks non-empty-string) and stored verbatim.
      const acq = callRouteSync(router, {
        method: "POST",
        url: "/lock",
        headers: AUTH,
        body: { agent, run_id: "run-garbage-1", started_at: garbage },
      });
      assertEq(acq.status, 200, `garbage started_at ${JSON.stringify(garbage)}: fresh acquire is accepted`);
      assertEq(
        getLockRow(agent)?.started_at,
        garbage,
        `garbage started_at ${JSON.stringify(garbage)}: stored as-is (no format validation)`,
      );

      // Backdate ONLY locked_at past the 90-min threshold; started_at stays
      // exactly the garbage value above, untouched. Under the OLD
      // started_at-based WHERE guard, this reacquire would incorrectly get
      // rejected with 409 for values like "not-a-date" / the far-future
      // date (their lexicographic comparison against staleCutoff never
      // satisfies "<"), even though the lock is 91 minutes old by any real
      // clock — that's the permanent-wedge bug. Under the FIXED
      // locked_at-based guard this must succeed unconditionally.
      const staleLockedAt = new Date(Date.now() - 91 * 60_000).toISOString();
      db.prepare("UPDATE orchestrator_locks SET locked_at = ? WHERE agent = ?").run(staleLockedAt, agent);

      const reacq = callRouteSync(router, {
        method: "POST",
        url: "/lock",
        headers: AUTH,
        body: { agent, run_id: "run-garbage-2", started_at: new Date().toISOString() },
      });
      assertEq(
        reacq.status,
        200,
        `garbage started_at ${JSON.stringify(garbage)}: stale-by-locked_at lock IS reacquired despite garbage started_at`,
      );
      assertEq(
        reacq.body,
        { success: true, locked: true },
        `garbage started_at ${JSON.stringify(garbage)}: reacquire response shape`,
      );
      assertEq(
        getLockRow(agent)?.run_id,
        "run-garbage-2",
        `garbage started_at ${JSON.stringify(garbage)}: DB row now shows new holder`,
      );
    }
  } catch (err) {
    failed++;
    failures.push(`admin-runs-lock: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  const r = runAdminRunsLockTests({ log: true });
  console.log(`\nadmin-runs-lock: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
