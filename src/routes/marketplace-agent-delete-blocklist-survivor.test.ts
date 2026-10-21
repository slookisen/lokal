/**
 * marketplace-agent-delete-blocklist-survivor.test.ts — unit/integration
 * tests for the survivor-email guard on DELETE /api/marketplace/agents/:id
 * (src/routes/marketplace.ts, `router.delete("/agents/:id", ...)`).
 *
 * Bug fixed: the route's blocklist auto-add side effect (meant to stop the
 * daily discovery agent from re-inserting a spammy/removed listing) used to
 * blocklist the deleted agent's contact email UNCONDITIONALLY. When that
 * same email is ALSO used by another agent row that is still active
 * (is_active = 1) — a genuine duplicate-agent-row situation where the
 * SURVIVOR legitimately keeps using that address — the email still got
 * blocklisted, poisoning all FUTURE contact with that correct, active
 * producer. This happened for real in production: post@akergaardsbutikk.no
 * (survivor agent id 5e652eb0-...) got auto-blocklisted despite the
 * survivor still legitimately using that address.
 *
 * Fix: immediately before the blocklistAdd() call, when the email that
 * would be blocklisted is non-empty, check whether another `agents` row has
 * is_active = 1 AND the same email (case-insensitive). If so, pass
 * `email: undefined` to blocklistAdd() instead — every other field
 * (agentId, name, website, reason, sourceEmail, agentNameForAudit) is
 * unaffected, so agentId/website/name still get blocklisted as before.
 *
 * Covers:
 *   1. Deleted agent's email IS shared by another active agent → email is
 *      NOT blocklisted, but the delete-cascade still ran (row gone from
 *      `agents`).
 *   2. Deleted agent's email is NOT shared by any other active agent (the
 *      normal/pre-existing case) → email IS blocklisted as before
 *      (regression guard — proves no behavior change for the common path).
 *   3. Regression check: the OTHER blocklist identifiers (agentId, website
 *      domain, name_normalized) are still written exactly as before in
 *      both of the above cases.
 *   4. Case-insensitivity: the surviving active agent's contact_email
 *      differs only in case from the deleted agent's email → still
 *      correctly detected as a match and the email is skipped.
 *
 * DB is a fresh in-memory SQLite spun up via the real production schema
 * (__initSchemaForTesting), same convention as admin-agents-delete.test.ts
 * and marketplace-quarantine-gates.test.ts. The DELETE handler is grabbed
 * straight off marketplace.ts's router stack and invoked directly (no real
 * HTTP socket) — same reasoning as those files: avoids any risk of
 * interleaving with a peer test block's process.env.ADMIN_KEY mutation.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/marketplace-agent-delete-blocklist-survivor.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runMarketplaceAgentDeleteBlocklistSurvivorTests() and folds its
 *      pass/fail counts into the `npm test` summary.
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

export async function runMarketplaceAgentDeleteBlocklistSurvivorTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
  testDb.pragma("foreign_keys = ON");

  const ADMIN_KEY = process.env.ADMIN_KEY || "marketplace-delete-blocklist-survivor-test-key";

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // Fresh require so no stale closures from an earlier suite's DB linger.
    const marketplaceRoutePath = require.resolve("./marketplace");
    delete require.cache[marketplaceRoutePath];
    const marketplaceRouter = require("./marketplace").default as any;

    const { marketplaceRegistry } = require("../services/marketplace-registry") as
      typeof import("../services/marketplace-registry");
    marketplaceRegistry._agentsCache = null;

    const { normalizeDomain, normalizeEmail, normalizeName } = require("../services/blocklist-service") as
      typeof import("../services/blocklist-service");

    const deleteLayer = (marketplaceRouter.stack as any[]).find(
      (l: any) => l.route && l.route.path === "/agents/:id" && l.route.methods?.delete,
    );
    assertTrue(!!deleteLayer, "setup: DELETE /agents/:id handler is registered on the router");
    const deleteHandler = deleteLayer.route.stack[deleteLayer.route.stack.length - 1].handle;

    function insertAgent(o: {
      id: string;
      name: string;
      email: string;
      url: string;
      isActive?: boolean;
    }): void {
      testDb.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, city, trust_score, is_active, is_verified)
         VALUES (?, ?, 'desc', 'test', ?, ?, 'producer', ?, 'Oslo', 0.5, ?, 0)`,
      ).run(o.id, o.name, o.email, o.url, `k-${o.id}`, o.isActive === false ? 0 : 1);
    }

    function readAgent(id: string): { id: string } | undefined {
      return testDb.prepare("SELECT id FROM agents WHERE id = ?").get(id) as any;
    }

    function blocklistRowsFor(type: string, value: string): any[] {
      return testDb.prepare(
        "SELECT * FROM agent_blocklist WHERE identifier_type = ? AND identifier_value = ?",
      ).all(type, value) as any[];
    }

    async function callDelete(id: string): Promise<{ status: number; body: any }> {
      // Same-synchronous-turn env-var + handler-invocation pattern as
      // admin-agents-delete.test.ts's callDelete() — avoids interleaving
      // with any peer test block sharing process.env.ADMIN_KEY.
      process.env.ADMIN_KEY = ADMIN_KEY;
      const res = fakeRes();
      await deleteHandler(
        { headers: { "x-admin-key": ADMIN_KEY }, params: { id }, query: {}, body: {}, ip: "127.0.0.1" } as any,
        res as any,
      );
      return { status: res.statusCode, body: res.body };
    }

    // ── Case 1: deleted agent's email IS shared by another active agent ───
    // → email NOT blocklisted, but the delete-cascade still ran.
    {
      const sharedEmail = "post@akergaardsbutikk.no";
      insertAgent({ id: "del-shared-1", name: "Duplicate Row AS", email: sharedEmail, url: "https://duplicate-row.no" });
      insertAgent({ id: "survivor-shared-1", name: "Akergaardsbutikk", email: sharedEmail, url: "https://akergaardsbutikk.no", isActive: true });
      marketplaceRegistry._agentsCache = null;

      const r = await callDelete("del-shared-1");
      assertEq(r.status, 200, "case1: DELETE succeeds (200) even with a surviving active agent sharing the email");
      assertEq(readAgent("del-shared-1"), undefined, "case1: delete-cascade still ran — deleted agent's row is gone from `agents`");
      assertTrue(!!readAgent("survivor-shared-1"), "case1: the survivor agent's own row is untouched");

      const emailRows = blocklistRowsFor("email", normalizeEmail(sharedEmail));
      assertEq(emailRows.length, 0, "case1: the shared email is NOT written to agent_blocklist (survivor guard fired)");

      const respEmailRows = (r.body?.blocklist?.rows || []).filter((row: any) => row.identifier_type === "email");
      assertEq(respEmailRows.length, 0, "case1: response body's blocklist.rows also carries no email row");

      // Case 3 (part a): other identifiers still written exactly as before.
      const agentIdRows = blocklistRowsFor("agent_id", "del-shared-1");
      assertEq(agentIdRows.length, 1, "case1/case3: agentId IS still blocklisted despite the email being skipped");
      const websiteRows = blocklistRowsFor("website_domain", normalizeDomain("https://duplicate-row.no"));
      assertEq(websiteRows.length, 1, "case1/case3: website_domain IS still blocklisted despite the email being skipped");
      const nameRows = blocklistRowsFor("name_normalized", normalizeName("Duplicate Row AS"));
      assertEq(nameRows.length, 1, "case1/case3: name_normalized IS still blocklisted despite the email being skipped");
    }

    // ── Case 2: deleted agent's email is NOT shared by any other active
    // agent (the normal/pre-existing case) → email IS blocklisted as before
    // (regression guard). ───────────────────────────────────────────────
    {
      const uniqueEmail = "unique-producer@example.no";
      insertAgent({ id: "del-unique-1", name: "Unique Producer AS", email: uniqueEmail, url: "https://unique-producer.no" });
      marketplaceRegistry._agentsCache = null;

      const r = await callDelete("del-unique-1");
      assertEq(r.status, 200, "case2: DELETE succeeds (200) for the normal (no-survivor) case");
      assertEq(readAgent("del-unique-1"), undefined, "case2: delete-cascade ran — row gone from `agents`");

      const emailRows = blocklistRowsFor("email", normalizeEmail(uniqueEmail));
      assertEq(emailRows.length, 1, "case2 (regression): the email IS blocklisted as before when no active survivor shares it");

      const respEmailRows = (r.body?.blocklist?.rows || []).filter((row: any) => row.identifier_type === "email");
      assertTrue(
        respEmailRows.some((row: any) => row.identifier_value === normalizeEmail(uniqueEmail)),
        "case2 (regression): response body's blocklist.rows carries the email row",
      );

      // Case 3 (part b): other identifiers unaffected in the normal case too.
      const agentIdRows = blocklistRowsFor("agent_id", "del-unique-1");
      assertEq(agentIdRows.length, 1, "case2/case3: agentId blocklisted (unaffected by the guard)");
      const websiteRows = blocklistRowsFor("website_domain", normalizeDomain("https://unique-producer.no"));
      assertEq(websiteRows.length, 1, "case2/case3: website_domain blocklisted (unaffected by the guard)");
      const nameRows = blocklistRowsFor("name_normalized", normalizeName("Unique Producer AS"));
      assertEq(nameRows.length, 1, "case2/case3: name_normalized blocklisted (unaffected by the guard)");
    }

    // ── Case 4: case-insensitivity — survivor's contact_email differs only
    // in case from the deleted agent's email → still detected as a match,
    // email skipped. ──────────────────────────────────────────────────────
    {
      const deletedEmailMixedCase = "Foo@Bar.no";
      const survivorEmailLowerCase = "foo@bar.no";
      insertAgent({ id: "del-case-1", name: "Case Mismatch Dupe AS", email: deletedEmailMixedCase, url: "https://case-mismatch-dupe.no" });
      insertAgent({ id: "survivor-case-1", name: "Case Mismatch Survivor AS", email: survivorEmailLowerCase, url: "https://case-mismatch-survivor.no", isActive: true });
      marketplaceRegistry._agentsCache = null;

      const r = await callDelete("del-case-1");
      assertEq(r.status, 200, "case4: DELETE succeeds (200)");
      assertEq(readAgent("del-case-1"), undefined, "case4: delete-cascade still ran despite the survivor guard skipping the email");

      const emailRows = blocklistRowsFor("email", normalizeEmail(deletedEmailMixedCase));
      assertEq(emailRows.length, 0, "case4: case-insensitive match correctly skips blocklisting the email (Foo@Bar.no vs foo@bar.no)");

      // Other identifiers still written for this case too.
      const agentIdRows = blocklistRowsFor("agent_id", "del-case-1");
      assertEq(agentIdRows.length, 1, "case4: agentId still blocklisted despite the case-insensitive email match");
    }

    // ── Case 5 (slettefrist slice B): permanent delete also removes the
    // agent's profile_translations + profile_translation_audit rows, and
    // leaves other agents' rows alone. ───────────────────────────────────
    {
      insertAgent({ id: "del-trans-1", name: "Translated Producer AS", email: "trans-del@example.no", url: "https://trans-del.no" });
      insertAgent({ id: "keep-trans-1", name: "Kept Translated AS", email: "trans-keep@example.no", url: "https://trans-keep.no" });
      marketplaceRegistry._agentsCache = null;

      const insTr = testDb.prepare(
        `INSERT INTO profile_translations
           (platform, entity_type, entity_id, entity_name, field, lang, source_text, source_hash, status)
         VALUES (?, ?, ?, 'n', ?, ?, 'kilde', 'h', 'published')`,
      );
      const insAudit = testDb.prepare(
        `INSERT INTO profile_translation_audit (translation_id, from_status, to_status, actor) VALUES (?, 'draft', 'published', 'test')`,
      );
      const delTrIds: number[] = [];
      for (const field of ["description", "about"]) {
        for (const lang of ["en", "sv"]) {
          delTrIds.push(Number(insTr.run("rfb", "agent", "del-trans-1", field, lang).lastInsertRowid));
        }
      }
      const keepTrId = Number(insTr.run("rfb", "agent", "keep-trans-1", "description", "en").lastInsertRowid);
      // Same id on the other platform must not be touched by an rfb delete.
      const oppTrId = Number(insTr.run("opplevagent", "provider", "del-trans-1", "about_text", "en").lastInsertRowid);
      for (const id of delTrIds) insAudit.run(id);
      insAudit.run(keepTrId);
      insAudit.run(oppTrId);

      const r = await callDelete("del-trans-1");
      assertEq(r.status, 200, "case5: DELETE succeeds (200)");
      assertEq(readAgent("del-trans-1"), undefined, "case5: agent row is gone");

      const cnt = (sql: string, ...a: unknown[]) => (testDb.prepare(sql).get(...a) as any).c as number;
      assertEq(cnt("SELECT COUNT(*) c FROM profile_translations WHERE platform = 'rfb' AND entity_id = ?", "del-trans-1"), 0,
        "case5: deleted agent's profile_translations rows are removed");
      assertEq(cnt(`SELECT COUNT(*) c FROM profile_translation_audit WHERE translation_id IN (${delTrIds.join(",")})`), 0,
        "case5: deleted agent's profile_translation_audit rows are removed");
      assertEq(cnt("SELECT COUNT(*) c FROM profile_translations WHERE entity_id = ?", "keep-trans-1"), 1,
        "case5: other agent's translation row is untouched");
      assertEq(cnt("SELECT COUNT(*) c FROM profile_translation_audit WHERE translation_id = ?", keepTrId), 1,
        "case5: other agent's audit row is untouched");
      assertEq(cnt("SELECT COUNT(*) c FROM profile_translations WHERE platform = 'opplevagent' AND entity_id = ?", "del-trans-1"), 1,
        "case5: non-rfb platform row with the same entity_id is untouched");
      assertEq(cnt("SELECT COUNT(*) c FROM profile_translation_audit WHERE translation_id = ?", oppTrId), 1,
        "case5: non-rfb audit row is untouched");
    }
  } catch (err) {
    failed++;
    failures.push(`marketplace-agent-delete-blocklist-survivor: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./marketplace")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/marketplace-agent-delete-blocklist-survivor.test.ts`
if (require.main === module) {
  console.log("── marketplace-agent-delete-blocklist-survivor (DELETE /api/marketplace/agents/:id survivor-email guard) unit tests ──");
  runMarketplaceAgentDeleteBlocklistSurvivorTests({ log: true }).then((r) => {
    console.log(`\nmarketplace-agent-delete-blocklist-survivor: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
