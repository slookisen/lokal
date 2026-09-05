/**
 * marketplace-registry-slug-alias.test.ts — tests for dev-request
 * 2026-09-03-rfb-korrigering-navn-sted-kategorier, Mål 1 (slug-alias/301 ved
 * navnebytte):
 *   - ensureAgentSlugAliasesTable / insertAgentSlugAlias / resolveAgentSlugAlias
 *     (src/services/marketplace-registry.ts)
 *   - updateAgent()'s rename hook: writes an alias row ONLY when the
 *     RESOLVABLE slug actually changes (slugify(old) !== slugify(new)),
 *     never on a purely cosmetic name edit (punctuation/casing that
 *     slugifies identically)
 *   - POST /admin/agents/:id/slug-alias (src/routes/admin-agents.ts), the
 *     one-shot manual-backfill route that calls the SAME insertAgentSlugAlias
 *     helper (no duplicated SQL between the automatic and manual paths)
 *
 * Own in-memory DB via __setDbForTesting/__initSchemaForTesting (never pins
 * the shared getDb() singleton) — same discipline as
 * admin-agents-duplicate-slugs.test.ts / produsent-role-gate.test.ts. The
 * admin-route case (f) grabs the real handler off the router's internal
 * stack and invokes it directly (mirrors admin-agents.test.ts's POST
 * /register harness) — no HTTP server, no port. ADMIN_KEY is only ever SET
 * here when nothing is already configured, and always restored in finally
 * (SHARED GLOBAL STATE discipline, same as admin-agents-duplicate-slugs.test.ts).
 *
 * Cases:
 *   (a) updateAgent() with a name change that changes the computed slug ->
 *       agent_slug_aliases gets a row with the correct old_slug/agent_id.
 *   (b) updateAgent() with a name change that does NOT change the computed
 *       slug (punctuation/spacing only) -> NO alias row written (proves the
 *       write is gated on slug equality, not raw string equality on name).
 *   (c) resolveAgentSlugAlias(): known old_slug -> the right (current) agent;
 *       unknown slug -> undefined; old_slug pointing at a now-deactivated
 *       agent -> undefined (is_active check).
 *   (f) POST /admin/agents/:id/slug-alias: missing X-Admin-Key -> 403; valid
 *       key + a real agent id -> writes the row, resolveAgentSlugAlias finds
 *       it afterward.
 *
 * Exported runMarketplaceRegistrySlugAliasTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone:
 *   npx tsx src/services/marketplace-registry-slug-alias.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runMarketplaceRegistrySlugAliasTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const { slugify } = require("../utils/slug") as typeof import("../utils/slug");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  function seedAgent(row: { id: string; name: string; isActive?: number }): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages,
        trust_score, is_active, is_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
        '[]', '[]', '[]', '{}', '["no"]',
        0.5, ?, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
    ).run(
      row.id, row.name, "En beskrivelse", row.name, `${row.id}@example.no`, `https://${row.id}.example.no`,
      `key-${row.id}`, row.isActive ?? 1,
    );
  }

  function fakeRes() {
    const r: any = { statusCode: 200, body: undefined };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.json = (b: any) => { r.body = b; return r; };
    return r;
  }

  const ambientAdminKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const setAdminKeyOurselves = ambientAdminKey === "";
  const prevAdminKey = process.env.ADMIN_KEY;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // Deliberately NOT cache-busted: the same singleton this require()
    // returns is the one src/routes/admin-agents.ts's own import resolves
    // to (Node module cache is keyed by resolved path) — case (f) below
    // needs both to agree, since it writes through the admin route's
    // handler and reads back through resolveAgentSlugAlias() on this
    // reference.
    const { marketplaceRegistry, insertAgentSlugAlias } = require("./marketplace-registry") as
      typeof import("./marketplace-registry");

    // ── (a) rename that changes the computed slug -> alias row written ───
    seedAgent({ id: "agent-a", name: "Gamle Navn Gård" });
    marketplaceRegistry.updateAgent("agent-a", { name: "Nye Navn Gård" });
    {
      const oldSlug = slugify("Gamle Navn Gård");
      const row = testDb
        .prepare("SELECT old_slug, agent_id FROM agent_slug_aliases WHERE old_slug = ?")
        .get(oldSlug) as { old_slug: string; agent_id: string } | undefined;
      assertTrue(!!row, "a1: alias row exists for the abandoned slug after a real rename");
      assertEq(row?.agent_id, "agent-a", "a2: alias row points at the renamed agent");
    }

    // ── (b) cosmetic-only rename (same computed slug) -> NO alias row ────
    seedAgent({ id: "agent-b", name: "Øverland Gard" });
    assertEq(
      slugify("Øverland Gard"),
      slugify("Øverland  Gård!"),
      "b0: fixture sanity — both names slugify identically (proves this case exercises the slug-equality gate, not a coincidence)",
    );
    marketplaceRegistry.updateAgent("agent-b", { name: "Øverland  Gård!" });
    {
      const row = testDb.prepare("SELECT 1 FROM agent_slug_aliases WHERE agent_id = 'agent-b'").get();
      assertTrue(!row, "b1: no alias row written for a name edit that doesn't change the computed slug");
    }

    // ── (c) resolveAgentSlugAlias() ────────────────────────────────────
    {
      const found = marketplaceRegistry.resolveAgentSlugAlias(slugify("Gamle Navn Gård"));
      assertTrue(!!found, "c1: known old_slug resolves to an agent");
      assertEq(found?.id, "agent-a", "c2: resolves to the correct agent id");
      assertEq(found?.name, "Nye Navn Gård", "c3: resolved agent reflects the CURRENT (post-rename) name");

      const missing = marketplaceRegistry.resolveAgentSlugAlias("dette-slugget-finnes-ikke");
      assertEq(missing, undefined, "c4: unknown old_slug -> undefined");
    }
    {
      seedAgent({ id: "agent-c", name: "Snart Borte Gård", isActive: 1 });
      insertAgentSlugAlias("agent-c", "snart-borte-gammelt-slug");
      testDb.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run("agent-c");
      const resolved = marketplaceRegistry.resolveAgentSlugAlias("snart-borte-gammelt-slug");
      assertEq(resolved, undefined, "c5: alias pointing at a now-deactivated agent -> undefined (is_active check)");
    }

    // ── (f) POST /admin/agents/:id/slug-alias ─────────────────────────────
    {
      const routePath = require.resolve("../routes/admin-agents");
      delete require.cache[routePath];
      const routerModule = require("../routes/admin-agents").default as any;
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === "/:id/slug-alias" && l.route.methods && l.route.methods.post,
      );
      assertTrue(!!layer, "f-setup: POST /:id/slug-alias handler is registered on the router");
      const handler = layer.route.stack[0].handle;

      seedAgent({ id: "agent-f", name: "Backfill Testgård" });

      if (setAdminKeyOurselves) process.env.ADMIN_KEY = "slug-alias-standalone-test-key";
      const testKey = (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string;

      // f1: missing X-Admin-Key -> 403
      {
        const res = fakeRes();
        handler({ params: { id: "agent-f" }, headers: {}, body: { oldSlug: "gammel-slug-uten-key" } } as any, res);
        assertEq(res.statusCode, 403, "f1: missing X-Admin-Key -> 403");
        const row = testDb.prepare("SELECT 1 FROM agent_slug_aliases WHERE old_slug = 'gammel-slug-uten-key'").get();
        assertTrue(!row, "f1b: no row written when auth is rejected");
      }

      // f2: valid key + real agent id -> writes the row; resolveAgentSlugAlias finds it after
      {
        const res = fakeRes();
        handler(
          { params: { id: "agent-f" }, headers: { "x-admin-key": testKey }, body: { oldSlug: "backfill-testgard-gammel" } } as any,
          res,
        );
        assertEq(res.statusCode, 200, "f2: valid key + real agent -> 200");
        assertEq(res.body?.success, true, "f2b: response success:true");
        assertEq(res.body?.old_slug, "backfill-testgard-gammel", "f2c: response echoes old_slug");
        assertEq(res.body?.agent_id, "agent-f", "f2d: response echoes agent_id");
        const resolved = marketplaceRegistry.resolveAgentSlugAlias("backfill-testgard-gammel");
        assertTrue(!!resolved, "f2e: resolveAgentSlugAlias finds the backfilled alias afterward");
        assertEq(resolved?.id, "agent-f", "f2f: resolves to the right agent");
      }

      // f3: unknown agent id -> 404, no row written
      {
        const res = fakeRes();
        handler(
          { params: { id: "does-not-exist" }, headers: { "x-admin-key": testKey }, body: { oldSlug: "irrelevant-slug" } } as any,
          res,
        );
        assertEq(res.statusCode, 404, "f3: unknown agent id -> 404");
        const row = testDb.prepare("SELECT 1 FROM agent_slug_aliases WHERE old_slug = 'irrelevant-slug'").get();
        assertTrue(!row, "f3b: no orphaned alias row written for a nonexistent agent");
      }
    }
  } catch (err) {
    failed++;
    failures.push(
      `marketplace-registry-slug-alias: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`,
    );
  } finally {
    if (setAdminKeyOurselves) {
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/admin-agents")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/marketplace-registry-slug-alias.test.ts`
if (require.main === module) {
  console.log("── marketplace-registry slug-alias (dev-request 2026-09-03-rfb-korrigering-navn-sted-kategorier, Mål 1) unit tests ──");
  runMarketplaceRegistrySlugAliasTests({ log: true }).then((r) => {
    console.log(`\nmarketplace-registry-slug-alias: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
