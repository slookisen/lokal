/**
 * crm-thread-status-enum-b3-opt-out.test.ts — regression tests for
 * dev-request 2026-09-14-crm-thread-status-enum-mangler-b3-opt-out-verdier
 * (slookisen/A2A).
 *
 * `scheduled-agents/rfb-customer-service.md`'s B3 opt-out/deletion-request
 * flow (line 664: Step 1 -> `awaiting_confirmation`, line 670: Step 2 ->
 * `awaiting_grace`) has always prescribed these two crm_threads.status
 * values, but neither `POST /admin/crm/threads/:id/status`'s Zod enum
 * (src/routes/crm.ts) nor the `crm_threads.status` CHECK constraint
 * (src/database/init.ts) ever accepted them — both 400/constraint-failed,
 * so a live B3 case (Toves Tradisjonsmat, 2026-09-14) fell back to
 * `awaiting_review` instead. Fix widens both the route-level Zod enum
 * (write path) and the `GET /admin/crm/threads?status=` allowlist (read
 * path) to accept the two new values, plus a rebuild-table CHECK-widening
 * migration for existing databases (SQLite can't ALTER a CHECK in place) —
 * same pattern as the existing `crm_outbox.status` 'superseded' widening.
 *
 * Covers:
 *   (1) POST /threads/:id/status accepts "awaiting_confirmation" -> 200,
 *       crm_threads.status actually persisted as that value (not silently
 *       folded into something else).
 *   (2) POST /threads/:id/status accepts "awaiting_grace" -> 200, persisted.
 *   (3) Regression: a pre-existing accepted value ("awaiting_review") still
 *       works unchanged -> 200.
 *   (4) Regression: an unknown status is still rejected -> 400 "invalid
 *       body" (the widening is additive, not a validation bypass).
 *   (5) GET /threads?status=awaiting_confirmation returns the thread (read
 *       path allowlist symmetry — a caller polling for B3-Step-1 threads
 *       must not 400).
 *   (6) GET /threads?status=awaiting_grace returns the thread.
 *   (7) GET /threads?status=<bogus> is still 400, and its `allowed` list in
 *       the response body includes both new values (proves the read-path
 *       allowlist and the write-path enum were widened together, not just
 *       one of the two closed sets the spec calls out).
 *
 * Harness conventions (matching this repo's established patterns — see
 * crm-max-touch-vern-send-guard.test.ts and
 * crm-compose-cooldown-untriaged-inbound-exempt.test.ts): fresh in-memory
 * DB via database/init's __setDbForTesting/__initSchemaForTesting, router
 * dispatch via router.handle(req, res, next) directly, no HTTP server.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/crm-thread-status-enum-b3-opt-out.test.ts
 *   2. Wired into the gate via tests/test.ts.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; query?: Record<string, string>; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url,
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
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export async function runCrmThreadStatusEnumB3OptOutTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = __peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const testKey = "crm-thread-status-enum-b3-opt-out-test-key";

  try {
    __setDbForTesting(testDb);
    __initSchemaForTesting(testDb);
    delete process.env.ANALYTICS_ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const routePath = require.resolve("./crm");
    delete require.cache[routePath];
    const router = (require("./crm") as typeof import("./crm")).default as any;

    const headers = { "x-admin-key": testKey };

    // ── fixture: one contact + one thread ("new") ──────────────────────
    testDb
      .prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name) VALUES (?,?,?,?,?)`)
      .run("c-b3-1", "producer", null, "toves-tradisjonsmat@example.no", "Toves Tradisjonsmat");
    testDb
      .prepare(
        `INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to, vertical_id)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run("t-b3-1", "c-b3-1", "Slett meg", "system", "new", "claude", "rfb");

    // ══ (1) POST .../status accepts "awaiting_confirmation" ═══════════
    const r1 = await callRoute(router, {
      method: "POST",
      url: "/threads/t-b3-1/status",
      headers,
      body: { status: "awaiting_confirmation" },
    });
    assertEq(r1.status, 200, "1a: POST /threads/:id/status awaiting_confirmation -> 200");
    const row1 = testDb.prepare("SELECT status FROM crm_threads WHERE id = ?").get("t-b3-1") as any;
    assertEq(row1?.status, "awaiting_confirmation", "1b: crm_threads.status persisted as awaiting_confirmation");

    // ══ (2) POST .../status accepts "awaiting_grace" ═══════════════════
    const r2 = await callRoute(router, {
      method: "POST",
      url: "/threads/t-b3-1/status",
      headers,
      body: { status: "awaiting_grace" },
    });
    assertEq(r2.status, 200, "2a: POST /threads/:id/status awaiting_grace -> 200");
    const row2 = testDb.prepare("SELECT status FROM crm_threads WHERE id = ?").get("t-b3-1") as any;
    assertEq(row2?.status, "awaiting_grace", "2b: crm_threads.status persisted as awaiting_grace");

    // ══ (3) regression: a pre-existing value still works ═══════════════
    const r3 = await callRoute(router, {
      method: "POST",
      url: "/threads/t-b3-1/status",
      headers,
      body: { status: "awaiting_review" },
    });
    assertEq(r3.status, 200, "3: POST /threads/:id/status awaiting_review (pre-existing value) still -> 200");

    // ══ (4) regression: an unknown status is still rejected ════════════
    const r4 = await callRoute(router, {
      method: "POST",
      url: "/threads/t-b3-1/status",
      headers,
      body: { status: "not_a_real_status" },
    });
    assertEq(r4.status, 400, "4: POST /threads/:id/status with a bogus value still -> 400");

    // ── second fixture thread, parked in awaiting_grace, for the GET-filter checks ──
    testDb
      .prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name) VALUES (?,?,?,?,?)`)
      .run("c-b3-2", "producer", null, "annen-sak@example.no", "Annen Sak");
    testDb
      .prepare(
        `INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to, vertical_id)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run("t-b3-2", "c-b3-2", "Bekreft slette meg", "system", "awaiting_confirmation", "claude", "rfb");
    testDb
      .prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name) VALUES (?,?,?,?,?)`)
      .run("c-b3-3", "producer", null, "tredje-sak@example.no", "Tredje Sak");
    testDb
      .prepare(
        `INSERT INTO crm_threads (id, contact_id, subject, category, status, assigned_to, vertical_id)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run("t-b3-3", "c-b3-3", "24t grace", "system", "awaiting_grace", "claude", "rfb");

    // ══ (5) GET /threads?status=awaiting_confirmation ══════════════════
    const r5 = await callRoute(router, { method: "GET", url: "/threads", query: { status: "awaiting_confirmation" }, headers });
    assertEq(r5.status, 200, "5a: GET /threads?status=awaiting_confirmation -> 200");
    assertTrue(
      Array.isArray(r5.body?.threads) && r5.body.threads.some((t: any) => t.id === "t-b3-2"),
      "5b: awaiting_confirmation thread t-b3-2 is in the filtered list",
    );

    // ══ (6) GET /threads?status=awaiting_grace ══════════════════════════
    const r6 = await callRoute(router, { method: "GET", url: "/threads", query: { status: "awaiting_grace" }, headers });
    assertEq(r6.status, 200, "6a: GET /threads?status=awaiting_grace -> 200");
    assertTrue(
      Array.isArray(r6.body?.threads) && r6.body.threads.some((t: any) => t.id === "t-b3-3"),
      "6b: awaiting_grace thread t-b3-3 is in the filtered list",
    );

    // ══ (7) GET /threads?status=<bogus> still 400, allowed list widened ═
    const r7 = await callRoute(router, { method: "GET", url: "/threads", query: { status: "not_a_real_status" }, headers });
    assertEq(r7.status, 400, "7a: GET /threads?status=<bogus> still -> 400");
    assertTrue(
      Array.isArray(r7.body?.allowed) &&
        r7.body.allowed.includes("awaiting_confirmation") &&
        r7.body.allowed.includes("awaiting_grace"),
      "7b: the 400 response's own `allowed` list names both new values (read-path allowlist widened, not just the write-path enum)",
    );
  } catch (err) {
    failed++;
    failures.push(`crm-thread-status-enum-b3-opt-out: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try {
      delete require.cache[require.resolve("./crm")];
    } catch {
      /* ignore */
    }
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── crm thread-status enum: B3 opt-out values (dev-request 2026-09-14-crm-thread-status-enum-mangler-b3-opt-out-verdier) ──");
  runCrmThreadStatusEnumB3OptOutTests({ log: true }).then((r) => {
    console.log(`\ncrm-thread-status-enum-b3-opt-out: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
