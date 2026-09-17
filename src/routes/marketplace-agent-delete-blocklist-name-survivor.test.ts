/**
 * marketplace-agent-delete-blocklist-name-survivor.test.ts — unit/integration
 * tests for the survivor-NAME guard on DELETE /api/marketplace/agents/:id
 * (src/routes/marketplace.ts, `router.delete("/agents/:id", ...)`).
 * Sibling of marketplace-agent-delete-blocklist-survivor.test.ts (#813, the
 * survivor-EMAIL guard) — same harness, one identifier over.
 *
 * Bug fixed (dev-request 2026-09-16-delete-agent-collateral-name-blocklist):
 * the route's blocklist auto-add side effect passes the deleted agent's
 * name to blocklistAdd(), which derives a `name_normalized` row via
 * normalizeName(). When a DUPLICATE agent row is deleted, the surviving,
 * still-active row with the same normalized name (different agent_id, often
 * a different email/website too) is then suppressed at the outreach gate —
 * isBlocked({ name }) hits the name_normalized row. Measured in prod
 * 2026-09-16: 11 of 20 raw-pool candidates were blocked this way by legacy
 * rows from May.
 *
 * Fix: immediately before the blocklistAdd() call, compute
 * normalizeName(agent.name) and check whether ANOTHER `agents` row with
 * is_active = 1 normalizes to the same value (compared in JS with the SAME
 * exported normalizeName(), never a SQL re-implementation). If so, pass
 * `name: undefined` to blocklistAdd() — agentId/website/email and
 * agentNameForAudit are unaffected.
 *
 * Covers:
 *   (a) Two active rows with the same normalized name ("Øvre-Eide Gård" vs
 *       "ovre-eide gard"), different ids/emails/websites → DELETE
 *       one → NO name_normalized row, but agent_id / website_domain / email
 *       rows still inserted.
 *   (b) Single row, no survivor → name_normalized row inserted exactly as
 *       today (regression guard for the default path).
 *   (c) Survivor exists but is_active = 0 → name IS still blocklisted
 *       (inactive rows don't count as survivors).
 *   (d) Audit column original_agent_name is still populated on the rows that
 *       ARE written when the name identifier is skipped.
 *
 * DB is a fresh in-memory SQLite spun up via the real production schema
 * (__initSchemaForTesting), same convention as the #813 sibling. The DELETE
 * handler is grabbed straight off marketplace.ts's router stack and invoked
 * directly (no real HTTP socket).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/marketplace-agent-delete-blocklist-name-survivor.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runMarketplaceAgentDeleteBlocklistNameSurvivorTests() and folds its
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

export async function runMarketplaceAgentDeleteBlocklistNameSurvivorTests(
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

  const ADMIN_KEY = process.env.ADMIN_KEY || "marketplace-delete-blocklist-name-survivor-test-key";

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
         VALUES (?, ?, 'desc', 'test', ?, ?, 'producer', ?, 'Bergen', 0.5, ?, 0)`,
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
      // Same-synchronous-turn env-var + handler-invocation pattern as the
      // #813 sibling — avoids interleaving with any peer test block sharing
      // process.env.ADMIN_KEY.
      process.env.ADMIN_KEY = ADMIN_KEY;
      const res = fakeRes();
      await deleteHandler(
        { headers: { "x-admin-key": ADMIN_KEY }, params: { id }, query: {}, body: {}, ip: "127.0.0.1" } as any,
        res as any,
      );
      return { status: res.statusCode, body: res.body };
    }

    // Sanity: the two spellings used in case (a) really do normalize to the
    // same value — otherwise the case would pass for the wrong reason.
    // (Note: a place-suffixed variant like "ovre eide gard - Eidsvåg" is NOT
    // a same-normalized-name case — normalizeName() keeps " eidsvag", so it
    // would not be a survivor by this guard's definition. Kept in sync with
    // what blocklistAdd()/isBlocked() actually compare on.)
    const deletedName = "Øvre-Eide Gård";
    const survivorNameSameNorm = "ovre-eide gard";
    assertEq(
      normalizeName(survivorNameSameNorm),
      normalizeName(deletedName),
      "setup: 'Øvre-Eide Gård' and 'ovre-eide gard' normalize to the same value ('ovre eide gard')",
    );

    // ── Case (a): deleted agent's normalized name IS shared by another
    // active agent (different id/email/website) → name_normalized NOT
    // blocklisted, but agent_id / website_domain / email still are. ─────
    {
      insertAgent({ id: "del-name-1", name: deletedName, email: "post@ovre-eide-dupe.no", url: "https://ovre-eide-dupe.no" });
      insertAgent({ id: "survivor-name-1", name: survivorNameSameNorm, email: "post@ovre-eide.no", url: "https://ovre-eide.no", isActive: true });
      marketplaceRegistry._agentsCache = null;

      const r = await callDelete("del-name-1");
      assertEq(r.status, 200, "case a: DELETE succeeds (200) even with a surviving active agent sharing the normalized name");
      assertEq(readAgent("del-name-1"), undefined, "case a: delete-cascade still ran — deleted agent's row is gone from `agents`");
      assertTrue(!!readAgent("survivor-name-1"), "case a: the survivor agent's own row is untouched");

      const nameRows = blocklistRowsFor("name_normalized", normalizeName(deletedName));
      assertEq(nameRows.length, 0, "case a: the shared normalized name is NOT written to agent_blocklist (survivor guard fired)");

      const respNameRows = (r.body?.blocklist?.rows || []).filter((row: any) => row.identifier_type === "name_normalized");
      assertEq(respNameRows.length, 0, "case a: response body's blocklist.rows also carries no name_normalized row");

      // Other identifiers still written exactly as before.
      const agentIdRows = blocklistRowsFor("agent_id", "del-name-1");
      assertEq(agentIdRows.length, 1, "case a: agentId IS still blocklisted despite the name being skipped");
      const websiteRows = blocklistRowsFor("website_domain", normalizeDomain("https://ovre-eide-dupe.no"));
      assertEq(websiteRows.length, 1, "case a: website_domain IS still blocklisted despite the name being skipped");
      const emailRows = blocklistRowsFor("email", normalizeEmail("post@ovre-eide-dupe.no"));
      assertEq(emailRows.length, 1, "case a: email IS still blocklisted (no email survivor) despite the name being skipped");

      // The survivor must still pass the outreach gate on its name.
      const { isBlocked } = require("../services/blocklist-service") as typeof import("../services/blocklist-service");
      assertEq(isBlocked({ name: survivorNameSameNorm }).blocked, false, "case a: survivor's name is NOT blocked at the isBlocked() gate afterwards");

      // ── Case (d): audit column still populated when the name identifier
      // is skipped (agentNameForAudit is passed regardless). ───────────
      assertEq(agentIdRows[0]?.original_agent_name, deletedName, "case d: original_agent_name is still populated on the agent_id row when the name identifier is skipped");
      assertEq(websiteRows[0]?.original_agent_name, deletedName, "case d: original_agent_name is still populated on the website_domain row when the name identifier is skipped");
      assertEq(emailRows[0]?.original_agent_name, deletedName, "case d: original_agent_name is still populated on the email row when the name identifier is skipped");
    }

    // ── Case (b): single row, no survivor → name_normalized row inserted
    // exactly as today (regression guard for the default path). ─────────
    {
      const uniqueName = "Unik Produsent AS";
      insertAgent({ id: "del-unique-name-1", name: uniqueName, email: "post@unik-produsent.no", url: "https://unik-produsent.no" });
      marketplaceRegistry._agentsCache = null;

      const r = await callDelete("del-unique-name-1");
      assertEq(r.status, 200, "case b: DELETE succeeds (200) for the normal (no-survivor) case");
      assertEq(readAgent("del-unique-name-1"), undefined, "case b: delete-cascade ran — row gone from `agents`");

      const nameRows = blocklistRowsFor("name_normalized", normalizeName(uniqueName));
      assertEq(nameRows.length, 1, "case b (regression): name_normalized IS blocklisted as before when no active survivor shares the name");
      assertEq(nameRows[0]?.original_agent_name, uniqueName, "case b (regression): original_agent_name populated on the name_normalized row as before");

      const respNameRows = (r.body?.blocklist?.rows || []).filter((row: any) => row.identifier_type === "name_normalized");
      assertTrue(
        respNameRows.some((row: any) => row.identifier_value === normalizeName(uniqueName)),
        "case b (regression): response body's blocklist.rows carries the name_normalized row",
      );

      const agentIdRows = blocklistRowsFor("agent_id", "del-unique-name-1");
      assertEq(agentIdRows.length, 1, "case b: agentId blocklisted (unaffected by the guard)");
      const websiteRows = blocklistRowsFor("website_domain", normalizeDomain("https://unik-produsent.no"));
      assertEq(websiteRows.length, 1, "case b: website_domain blocklisted (unaffected by the guard)");
      const emailRows = blocklistRowsFor("email", normalizeEmail("post@unik-produsent.no"));
      assertEq(emailRows.length, 1, "case b: email blocklisted (unaffected by the guard)");
    }

    // ── Case (c): a row with the same normalized name exists but is
    // is_active = 0 → does NOT count as a survivor → name IS blocklisted. ─
    {
      const deletedName2 = "Nedre Eide Gård";
      const inactiveTwin = "nedre-eide gard";
      assertEq(normalizeName(inactiveTwin), normalizeName(deletedName2), "case c setup: the inactive twin normalizes identically");
      insertAgent({ id: "del-inactive-twin-1", name: deletedName2, email: "post@nedre-eide-dupe.no", url: "https://nedre-eide-dupe.no" });
      insertAgent({ id: "inactive-twin-1", name: inactiveTwin, email: "post@nedre-eide.no", url: "https://nedre-eide.no", isActive: false });
      marketplaceRegistry._agentsCache = null;

      const r = await callDelete("del-inactive-twin-1");
      assertEq(r.status, 200, "case c: DELETE succeeds (200)");
      assertEq(readAgent("del-inactive-twin-1"), undefined, "case c: delete-cascade ran — row gone from `agents`");
      assertTrue(!!readAgent("inactive-twin-1"), "case c: the inactive twin's own row is untouched");

      const nameRows = blocklistRowsFor("name_normalized", normalizeName(deletedName2));
      assertEq(nameRows.length, 1, "case c: name_normalized IS blocklisted — an is_active = 0 row does not count as a survivor");

      const agentIdRows = blocklistRowsFor("agent_id", "del-inactive-twin-1");
      assertEq(agentIdRows.length, 1, "case c: agentId blocklisted as before");
    }
  } catch (err) {
    failed++;
    failures.push(`marketplace-agent-delete-blocklist-name-survivor: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./marketplace")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/marketplace-agent-delete-blocklist-name-survivor.test.ts`
if (require.main === module) {
  console.log("── marketplace-agent-delete-blocklist-name-survivor (DELETE /api/marketplace/agents/:id survivor-name guard) unit tests ──");
  runMarketplaceAgentDeleteBlocklistNameSurvivorTests({ log: true }).then((r) => {
    console.log(`\nmarketplace-agent-delete-blocklist-name-survivor: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
