/**
 * agents-truncation-sweep.test.ts — unit/integration tests for the
 * GET/POST /admin/agents/truncation-sweep pair added to routes/marketplace.ts
 * for dev-request 2026-07-01-cs-corrections-profile-quality's "Slice spec —
 * catalog-wide truncation sweep (2026-07-11)".
 *
 * Mirrors the admin-agents.test.ts pattern exactly (same file's own doc
 * comment explains why): tests/test.ts runs dozens of largely-independent
 * async blocks that share the same process.env.ADMIN_KEY and the same
 * getDb()/__setDbForTesting() singleton, so a real HTTP round-trip would
 * leave a window for a peer block to swap the DB or env var out from under
 * this one. Instead we grab the GET/POST handlers straight off the
 * marketplace router's internal stack and invoke them directly with fake
 * req/res objects — env var + handler call happen in the same synchronous
 * turn, so no peer block can interleave.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/agents-truncation-sweep.test.ts
 *   2. Wired into the gate: tests/test.ts imports runTruncationSweepTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const FFFD = "�";

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runTruncationSweepTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "truncation-sweep-test-key";

  function insertAgent(id: string, name: string, description: string): void {
    testDb
      .prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, ?, 'test-provider', ?, ?, 'producer', ?)`
      )
      .run(id, name, description, `${id}@example.no`, `https://${id}.example.no`, `key-${id}`);
  }

  function readDescription(id: string): string | undefined {
    const row = testDb.prepare("SELECT description FROM agents WHERE id = ?").get(id) as
      | { description: string }
      | undefined;
    return row?.description;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;

    // Re-require the route module fresh so it picks up the just-injected DB
    // and admin key, mirroring admin-agents.test.ts's require.cache dance.
    const routePath = require.resolve("../routes/marketplace");
    delete require.cache[routePath];
    const marketplaceRouter = require("../routes/marketplace").default as any;

    function findLayer(path: string, method: "get" | "post"): any {
      return marketplaceRouter.stack.find(
        (l: any) => l.route && l.route.path === path && l.route.methods && l.route.methods[method],
      );
    }

    const getLayer = findLayer("/admin/agents/truncation-sweep", "get");
    const postLayer = findLayer("/admin/agents/truncation-sweep", "post");
    assertTrue(!!getLayer, "setup: GET /admin/agents/truncation-sweep handler is registered");
    assertTrue(!!postLayer, "setup: POST /admin/agents/truncation-sweep handler is registered");
    const getHandler = getLayer.route.stack[getLayer.route.stack.length - 1].handle;
    const postHandler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

    async function callGet(headers: Record<string, string> = { "x-admin-key": ADMIN_KEY }): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await getHandler({ headers } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    async function callPost(
      body: Record<string, unknown>,
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await postHandler({ headers, body } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    // Fixture rows: one corrupted (trailing FFFD-run + partial word), one clean.
    const CORRUPTED_ID = "agent-corrupted-1";
    const CLEAN_ID = "agent-clean-1";
    const corruptedBefore = `Vi lager ost fra gårdens egne geiter og tilbyr opplevelser p${FFFD}${FFFD}`;
    const cleanDescription = "Vi lager ost fra gårdens egne geiter og tilbyr opplevelser på gården hver helg.";

    insertAgent(CORRUPTED_ID, "Test Meieri", corruptedBefore);
    insertAgent(CLEAN_ID, "Ren Gård", cleanDescription);

    const expectedAfter = require("../routes/seo").safeMetaDescription(corruptedBefore) as string;
    assertTrue(!expectedAfter.includes(FFFD), "setup: safeMetaDescription() actually strips the FFFD run in the fixture");

    // ── 1. GET diagnostic surfaces the corrupted row ──────────────────────
    {
      const r = await callGet();
      assertEq(r.status, 200, "GET: returns 200");
      assertEq(r.body?.success, true, "GET: success:true");
      const ids = (r.body?.agents || []).map((a: any) => a.id);
      assertTrue(ids.includes(CORRUPTED_ID), "GET: flags the corrupted row");
      assertTrue(r.body?.count >= 1, "GET: count reflects at least the corrupted row");
    }

    // ── 2. Clean row is never returned by the diagnostic ──────────────────
    {
      const r = await callGet();
      const ids = (r.body?.agents || []).map((a: any) => a.id);
      assertTrue(!ids.includes(CLEAN_ID), "GET: clean row is never returned");
    }

    // ── 3. POST with apply omitted → dry run, zero DB writes ─────────────
    {
      const r = await callPost({});
      assertEq(r.status, 200, "POST (apply omitted): returns 200");
      assertEq(r.body?.dry_run, true, "POST (apply omitted): dry_run:true");
      const wouldUpdate = (r.body?.would_update || []).map((u: any) => u.id);
      assertTrue(wouldUpdate.includes(CORRUPTED_ID), "POST (apply omitted): would_update includes the corrupted row");
      assertEq(readDescription(CORRUPTED_ID), corruptedBefore, "POST (apply omitted): corrupted row NOT written to DB");
      assertEq(readDescription(CLEAN_ID), cleanDescription, "POST (apply omitted): clean row untouched");
    }

    // ── 3b. POST with apply:false → same dry-run guarantee, explicit false ─
    {
      const r = await callPost({ apply: false });
      assertEq(r.body?.dry_run, true, "POST (apply:false): dry_run:true");
      assertEq(readDescription(CORRUPTED_ID), corruptedBefore, "POST (apply:false): zero writes");
    }

    // ── 4. POST with apply:true writes exactly the cleaned value to exactly
    //    the flagged row, and leaves the clean row byte-for-byte untouched ──
    {
      const r = await callPost({ apply: true });
      assertEq(r.status, 200, "POST (apply:true): returns 200");
      assertEq(r.body?.applied, true, "POST (apply:true): applied:true");
      assertEq(r.body?.updated_count, 1, "POST (apply:true): updated_count is exactly 1 (only the corrupted row)");
      const updatedEntry = (r.body?.updated || []).find((u: any) => u.id === CORRUPTED_ID);
      assertTrue(!!updatedEntry, "POST (apply:true): updated[] includes the corrupted row");
      assertEq(updatedEntry?.after, expectedAfter, "POST (apply:true): 'after' matches safeMetaDescription() output exactly");

      assertEq(readDescription(CORRUPTED_ID), expectedAfter, "POST (apply:true): DB row now holds the cleaned value");
      assertTrue(!(readDescription(CORRUPTED_ID) || "").includes(FFFD), "POST (apply:true): cleaned DB value has no remaining FFFD");
      assertEq(readDescription(CLEAN_ID), cleanDescription, "POST (apply:true): clean row is byte-for-byte untouched");

      const updatedIds = (r.body?.updated || []).map((u: any) => u.id);
      assertTrue(!updatedIds.includes(CLEAN_ID), "POST (apply:true): clean row never appears in updated[]");
    }

    // ── 4b. Re-running apply:true afterward is a safe no-op (already-clean
    //    row is never re-touched, per the re-checked WHERE clause) ─────────
    {
      const cleanedValue = readDescription(CORRUPTED_ID);
      const r = await callPost({ apply: true });
      assertEq(r.body?.updated_count, 0, "POST (apply:true) re-run: nothing left to update (idempotent)");
      assertEq(readDescription(CORRUPTED_ID), cleanedValue, "POST (apply:true) re-run: previously-cleaned row unchanged");
    }

    // ── 5. Auth: missing / wrong X-Admin-Key ──────────────────────────────
    {
      const rMissing = await callGet({});
      assertEq(rMissing.status, 403, "GET: missing X-Admin-Key -> 403");

      const rWrong = await callGet({ "x-admin-key": "not-the-key" });
      assertEq(rWrong.status, 403, "GET: wrong X-Admin-Key -> 403");

      const rPostMissing = await callPost({ apply: true }, {});
      assertEq(rPostMissing.status, 403, "POST: missing X-Admin-Key -> 403");
      // Confirm the unauthorized POST truly made no writes.
      assertEq(readDescription(CORRUPTED_ID), expectedAfter, "POST: unauthorized call did not touch the DB");

      const rPostWrong = await callPost({ apply: true }, { "x-admin-key": "not-the-key" });
      assertEq(rPostWrong.status, 403, "POST: wrong X-Admin-Key -> 403");
    }
  } catch (err) {
    failed++;
    failures.push(`agents-truncation-sweep: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/marketplace")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/agents-truncation-sweep.test.ts`
if (require.main === module) {
  console.log("── agents-truncation-sweep (GET/POST /admin/agents/truncation-sweep) unit tests ──");
  runTruncationSweepTests({ log: true }).then((r) => {
    console.log(`\nagents-truncation-sweep: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
