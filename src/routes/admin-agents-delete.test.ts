/**
 * admin-agents-delete.test.ts — unit/integration tests for DELETE
 * /admin/agents/:id (src/routes/admin-agents.ts), the rollback/undo path
 * for a bad POST /register call (wrong org-nr match, data error, etc.).
 * No delete/deactivate route for the `agents` table existed before this.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key.
 *   (b) Deleting an existing agent (inserted directly into the DB) → 200,
 *       row no longer queryable, response reports the deleted id/name/org_nr.
 *   (c) Deleting a non-existent id → 404 with a clear error body.
 *   (d) Deleting an agent that was itself registered via POST /register
 *       (end-to-end register → delete) → 200, row gone.
 *   (e) FK-ON block: the history guard added on top of the original route —
 *       an agent with a related row in conversations (seller_agent_id),
 *       agent_knowledge, listings, or agent_claims → 409 with `blocking`
 *       naming the category, agent row untouched; a brand-new agent with
 *       none of those → still 200 and actually deleted.
 *
 * DB is a fresh in-memory SQLite spun up via the real production schema
 * (__initSchemaForTesting), same convention as admin-agents.test.ts. The
 * handlers are grabbed straight off the router's internal stack and invoked
 * directly (no real HTTP socket), mirroring admin-agents.test.ts exactly —
 * same reasoning: several blocks in tests/test.ts share/stomp
 * process.env.ADMIN_KEY concurrently, and invoking the handler directly in
 * the same synchronous turn as setting the env var avoids that race.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-agents-delete.test.ts
 *   2. Wired into the gate: tests/test.ts imports runAdminAgentsDeleteTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runAdminAgentsDeleteTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  // Mirrors admin-agents.test.ts: FK enforcement off for this fixture DB so
  // inserting/deleting bare `agents` rows here never trips unrelated FK
  // constraints from other tables' schema (agent_knowledge, listings, etc.)
  // that this test never touches. Production behavior of those constraints
  // (ON DELETE CASCADE on agent_knowledge/listings/agent_metrics/agent_claims)
  // is a separate, already-existing schema fact — not something this route
  // adds — and is called out in the PR report rather than re-verified here.
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "admin-agents-delete-test-key";

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // Re-require the route module fresh and grab both the DELETE "/:id" and
    // POST "/register" handlers straight off the router's internal stack.
    const routePath = require.resolve("../routes/admin-agents");
    delete require.cache[routePath];
    const routerModule = require("../routes/admin-agents").default;

    const deleteLayer = routerModule.stack.find(
      (l: any) => l.route && l.route.path === "/:id" && l.route.methods && l.route.methods.delete,
    );
    assertTrue(!!deleteLayer, "setup: DELETE /:id handler is registered on the router");
    const deleteHandler = deleteLayer.route.stack[0].handle;

    const registerLayer = routerModule.stack.find(
      (l: any) => l.route && l.route.path === "/register" && l.route.methods && l.route.methods.post,
    );
    assertTrue(!!registerLayer, "setup: POST /register handler is registered on the router");
    const registerHandler = registerLayer.route.stack[0].handle;

    function insertAgent(id: string, name: string, orgNr: string | null): void {
      testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, trust_score, is_active, is_verified, org_nr)
         VALUES (?, ?, 'desc', 'test', 'test@test.no', 'https://test.no', 'producer', ?, 'Oslo', 0.5, 1, 0, ?)`,
      ).run(id, name, `k-${id}`, orgNr);
    }

    function readAgent(id: string): { id: string; name: string } | undefined {
      return testDb.prepare("SELECT id, name FROM agents WHERE id = ?").get(id) as any;
    }

    async function callDelete(id: string, opts2: { withKey?: boolean } = {}): Promise<{ status: number; body: any }> {
      const withKey = opts2.withKey ?? true;
      // Same-synchronous-turn env-var + handler-invocation pattern as
      // admin-agents.test.ts's callRegister() — avoids interleaving with
      // any peer test block sharing process.env.ADMIN_KEY.
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const res = fakeRes();
      const headers: Record<string, string> = withKey ? { "x-admin-key": ADMIN_KEY } : {};
      await deleteHandler({ headers, params: { id }, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    async function callRegister(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const res = fakeRes();
      await registerHandler({ headers: { "x-admin-key": ADMIN_KEY }, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    // ── Case 1: no X-Admin-Key header → 403 ─────────────────────────────────
    {
      insertAgent("del-noauth-1", "No Auth Test", "910100001");
      const r = await callDelete("del-noauth-1", { withKey: false });
      assertEq(r.status, 403, "case1: missing X-Admin-Key → 403");
      assertTrue(!!readAgent("del-noauth-1"), "case1: row NOT deleted when auth rejected");
    }

    // ── Case 2: delete an existing agent (direct DB insert) → 200 ───────────
    {
      insertAgent("del-existing-1", "Delete Me AS", "910100002");
      const r = await callDelete("del-existing-1");
      assertEq(r.status, 200, "case2: delete existing agent → 200");
      assertEq(r.body?.success, true, "case2: response success:true");
      assertEq(r.body?.deleted_id, "del-existing-1", "case2: response reports deleted_id");
      assertEq(r.body?.deleted_name, "Delete Me AS", "case2: response reports deleted_name");
      assertEq(r.body?.deleted_org_nr, "910100002", "case2: response reports deleted_org_nr");
      assertEq(readAgent("del-existing-1"), undefined, "case2: row no longer queryable after delete");
    }

    // ── Case 3: delete a non-existent id → 404 ──────────────────────────────
    {
      const r = await callDelete("does-not-exist-xyz");
      assertEq(r.status, 404, "case3: non-existent id → 404");
      assertEq(r.body?.error, "Agent not found", "case3: 404 body has clear error message");
      assertEq(r.body?.agent_id, "does-not-exist-xyz", "case3: 404 body echoes the requested agent_id");
    }

    // ── Case 4: end-to-end register → delete ────────────────────────────────
    {
      const orgNr = "910100003";
      const reg = await callRegister({
        name: "Registrert Så Slettet",
        url: "https://registrert-slettet.no",
        city: "Bergen",
        vertical_id: "rfb",
        org_nr: orgNr,
        source: "test",
      });
      assertEq(reg.status, 201, "case4 setup: register succeeds (201)");
      const agentId = reg.body?.agent_id;
      assertTrue(typeof agentId === "string" && agentId.length > 0, "case4 setup: register returns an agent_id");

      const r = await callDelete(agentId);
      assertEq(r.status, 200, "case4: delete a just-registered agent → 200");
      assertEq(r.body?.deleted_id, agentId, "case4: response reports the correct deleted_id");
      assertEq(r.body?.deleted_name, "Registrert Så Slettet", "case4: response reports the registered name");
      assertEq(readAgent(agentId), undefined, "case4: registered row no longer queryable after delete");
    }

    // ── Case 5: deleting the same id twice → second call is a 404 ──────────
    {
      insertAgent("del-twice-1", "Delete Twice AS", null);
      const r1 = await callDelete("del-twice-1");
      assertEq(r1.status, 200, "case5: first delete → 200");
      const r2 = await callDelete("del-twice-1");
      assertEq(r2.status, 404, "case5: second delete of the same id → 404 (not double-counted as success)");
    }
  } catch (err) {
    failed++;
    failures.push(`admin-agents-delete: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/admin-agents")]; } catch { /* ignore */ }
    testDb.close();
  }

  // ════════════════════════════════════════════════════════════════════════
  // FK-ON block: the history guard (409) added on top of the original route.
  //
  // Separate fixture DB from the block above, and this one runs with
  // `foreign_keys = ON` — matching production (src/database/init.ts). The
  // block above deliberately keeps FK enforcement OFF (see its own comment)
  // because it predates the guard and is only exercising the bare
  // delete-by-id mechanics; this block is the one that actually covers the
  // "agent has real history" scenarios the guard exists for, including the
  // conversations.seller_agent_id case that used to raw-500 under FK-ON.
  {
    const prevDb2 = (() => {
      try { return getDb(); } catch { return undefined; }
    })();
    const prevAdminKey2 = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey2 = process.env.ANALYTICS_ADMIN_KEY;

    const testDb2 = new Database(":memory:");
    testDb2.pragma("journal_mode = DELETE");
    testDb2.pragma("foreign_keys = ON");

    const ADMIN_KEY2 = "admin-agents-delete-fkon-test-key";

    try {
      __setDbForTesting(testDb2 as any);
      __initSchemaForTesting(testDb2 as any);

      const routePath2 = require.resolve("../routes/admin-agents");
      delete require.cache[routePath2];
      const routerModule2 = require("../routes/admin-agents").default;

      const deleteLayer2 = routerModule2.stack.find(
        (l: any) => l.route && l.route.path === "/:id" && l.route.methods && l.route.methods.delete,
      );
      assertTrue(!!deleteLayer2, "fk-on setup: DELETE /:id handler is registered on the router");
      const deleteHandler2 = deleteLayer2.route.stack[0].handle;

      function insertAgent2(id: string, name: string): void {
        testDb2.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, trust_score, is_active, is_verified, org_nr)
           VALUES (?, ?, 'desc', 'test', 'test@test.no', 'https://test.no', 'producer', ?, 'Oslo', 0.5, 1, 0, ?)`,
        ).run(id, name, `k-${id}`, `910${id.slice(-6).padStart(6, "0")}`);
      }

      function readAgent2(id: string): { id: string; name: string } | undefined {
        return testDb2.prepare("SELECT id, name FROM agents WHERE id = ?").get(id) as any;
      }

      async function callDelete2(id: string): Promise<{ status: number; body: any }> {
        process.env.ADMIN_KEY = ADMIN_KEY2;
        delete process.env.ANALYTICS_ADMIN_KEY;
        const res = fakeRes();
        await deleteHandler2({ headers: { "x-admin-key": ADMIN_KEY2 }, params: { id }, query: {} } as any, res as any);
        return { status: res.statusCode, body: res.body };
      }

      // ── Case A: agent has a conversations row (seller_agent_id) → 409 ────
      {
        insertAgent2("fkon-conv-1", "Has Conversation AS");
        testDb2.prepare(
          `INSERT INTO conversations (id, seller_agent_id) VALUES (?, ?)`,
        ).run("conv-1", "fkon-conv-1");

        const r = await callDelete2("fkon-conv-1");
        assertEq(r.status, 409, "fk-on caseA: agent with conversation history → 409");
        assertEq(r.body?.error, "Agent has existing history, refusing delete", "fk-on caseA: 409 body has clear error message");
        assertEq(r.body?.agent_id, "fkon-conv-1", "fk-on caseA: 409 body echoes agent_id");
        assertTrue(Array.isArray(r.body?.blocking) && r.body.blocking.includes("conversations"), "fk-on caseA: blocking names conversations");
        assertTrue(!!readAgent2("fkon-conv-1"), "fk-on caseA: agent row still exists after refused delete");
      }

      // ── Case B: agent has an agent_knowledge row → 409 ───────────────────
      {
        insertAgent2("fkon-knowledge-1", "Has Knowledge AS");
        testDb2.prepare(`INSERT INTO agent_knowledge (agent_id) VALUES (?)`).run("fkon-knowledge-1");

        const r = await callDelete2("fkon-knowledge-1");
        assertEq(r.status, 409, "fk-on caseB: agent with agent_knowledge row → 409");
        assertTrue(Array.isArray(r.body?.blocking) && r.body.blocking.includes("agent_knowledge"), "fk-on caseB: blocking names agent_knowledge");
        assertTrue(!!readAgent2("fkon-knowledge-1"), "fk-on caseB: agent row still exists after refused delete");
      }

      // ── Case C: agent has a listings row → 409 ───────────────────────────
      {
        insertAgent2("fkon-listing-1", "Has Listing AS");
        testDb2.prepare(
          `INSERT INTO listings (id, agent_id, product_name) VALUES (?, ?, ?)`,
        ).run("listing-1", "fkon-listing-1", "Tomater");

        const r = await callDelete2("fkon-listing-1");
        assertEq(r.status, 409, "fk-on caseC: agent with listings row → 409");
        assertTrue(Array.isArray(r.body?.blocking) && r.body.blocking.includes("listings"), "fk-on caseC: blocking names listings");
        assertTrue(!!readAgent2("fkon-listing-1"), "fk-on caseC: agent row still exists after refused delete");
      }

      // ── Case D: agent has an agent_claims row → 409 ──────────────────────
      {
        insertAgent2("fkon-claim-1", "Has Claim AS");
        testDb2.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email) VALUES (?, ?, ?, ?)`,
        ).run("claim-1", "fkon-claim-1", "Claimant Name", "claimant@test.no");

        const r = await callDelete2("fkon-claim-1");
        assertEq(r.status, 409, "fk-on caseD: agent with agent_claims row → 409");
        assertTrue(Array.isArray(r.body?.blocking) && r.body.blocking.includes("agent_claims"), "fk-on caseD: blocking names agent_claims");
        assertTrue(!!readAgent2("fkon-claim-1"), "fk-on caseD: agent row still exists after refused delete");
      }

      // ── Case E: brand-new agent, no rows in any of the four tables → 200 ─
      // Re-verifies the happy path still works under FK-ON with the new
      // guard queries in place (wrong column name / a stray row bleeding
      // in from another case would turn this into an unexpected 409).
      {
        insertAgent2("fkon-clean-1", "Brand New Clean AS");

        const r = await callDelete2("fkon-clean-1");
        assertEq(r.status, 200, "fk-on caseE: brand-new agent with no related rows → 200");
        assertEq(r.body?.success, true, "fk-on caseE: response success:true");
        assertEq(r.body?.deleted_id, "fkon-clean-1", "fk-on caseE: response reports deleted_id");
        assertEq(readAgent2("fkon-clean-1"), undefined, "fk-on caseE: row no longer queryable after delete");
      }
    } catch (err) {
      failed++;
      failures.push(`admin-agents-delete (fk-on): unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevAdminKey2 === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey2;
      if (prevAnalyticsAdminKey2 === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey2;
      if (prevDb2) __setDbForTesting(prevDb2);
      try { delete require.cache[require.resolve("../routes/admin-agents")]; } catch { /* ignore */ }
      testDb2.close();
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agents-delete.test.ts`
if (require.main === module) {
  console.log("── admin-agents-delete (DELETE /admin/agents/:id rollback path) unit tests ──");
  runAdminAgentsDeleteTests({ log: true }).then((r) => {
    console.log(`\nadmin-agents-delete: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
