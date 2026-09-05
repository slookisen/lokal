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
 *   (g) PR #800 review finding 1 regression: the automatic updateAgent()
 *       rename hook must NOT let one agent's rename hijack a DIFFERENT
 *       agent's already-abandoned alias. Reproduces the reviewer's exact
 *       attack — agent A abandons slug X (alias X->A written); unrelated
 *       agent D is renamed TO a name that also slugifies to X and then
 *       immediately away again, both via updateAgent() (the self-service
 *       rename path) — and asserts the alias still resolves to A afterward,
 *       not D, with a console.warn collision message logged instead of a
 *       silent overwrite.
 *   (h) Idempotent case: the SAME agent abandoning the SAME slug a second
 *       time (reclaim -> re-abandon) must still update cleanly through the
 *       default (allowOverwrite:false) path, with NO collision warning —
 *       proves the fix only blocks a DIFFERENT agent_id, not the same one.
 *   (i) POST /admin/agents/:id/slug-alias with allowOverwrite:true (the
 *       route's hardcoded behavior) CAN overwrite an alias that already
 *       points at a different agent — the deliberate human-operator
 *       correction path must not be broken by finding 1's fix.
 *   (j) PR #800 review finding 2 regression: the admin route normalizes
 *       oldSlug through slugify() before writing, so a mixed-case/
 *       punctuated backfill value (e.g. "Romstad-Gard-Molde"-style input)
 *       is stored in the same normalized form resolveAgentSlugAlias's
 *       lowercase-URL-param read path expects.
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

    // ── (g) PR #800 review finding 1 regression: alias-hijack via
    // self-service rename must be refused by the automatic hook ──────────
    {
      const warnCalls: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: any[]) => { warnCalls.push(args.join(" ")); };
      try {
        // Agent A abandons "old-name-attack-gard" — legitimate rename, alias written.
        seedAgent({ id: "agent-attack-a", name: "Old Name Attack Gard" });
        marketplaceRegistry.updateAgent("agent-attack-a", { name: "New Name For A" });
        {
          const row = testDb
            .prepare("SELECT agent_id FROM agent_slug_aliases WHERE old_slug = ?")
            .get(slugify("Old Name Attack Gard")) as { agent_id: string } | undefined;
          assertEq(row?.agent_id, "agent-attack-a", "g0-setup: A's abandoned slug alias points at A");
        }

        // Unrelated agent D: rename TO the same slug A abandoned, then away
        // again — both through updateAgent(), the exact self-service path a
        // producer's own PUT /api/marketplace/agents/:id reaches.
        seedAgent({ id: "agent-attack-d", name: "Temp Name For D" });
        marketplaceRegistry.updateAgent("agent-attack-d", { name: "Old Name Attack Gard" });
        warnCalls.length = 0; // only care about the warning from the SECOND rename below
        marketplaceRegistry.updateAgent("agent-attack-d", { name: "Away Again For D" });

        const afterAttack = testDb
          .prepare("SELECT agent_id FROM agent_slug_aliases WHERE old_slug = ?")
          .get(slugify("Old Name Attack Gard")) as { agent_id: string } | undefined;
        assertEq(
          afterAttack?.agent_id,
          "agent-attack-a",
          "g1: alias for the contested slug STILL resolves to A, not the attacking agent D",
        );
        const stillResolvesToA = marketplaceRegistry.resolveAgentSlugAlias(slugify("Old Name Attack Gard"));
        assertEq(stillResolvesToA?.id, "agent-attack-a", "g2: resolveAgentSlugAlias also confirms A, not D");
        assertTrue(
          warnCalls.some(w => w.includes("slug-alias collision") && w.includes(slugify("Old Name Attack Gard"))),
          "g3: a collision warning was logged instead of a silent overwrite",
        );
      } finally {
        console.warn = origWarn;
      }
    }

    // ── (h) idempotent case: the SAME agent re-abandoning the SAME slug a
    // second time must still update cleanly, with NO false collision warning ──
    {
      const warnCalls: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: any[]) => { warnCalls.push(args.join(" ")); };
      try {
        seedAgent({ id: "agent-idem", name: "Idem Gard" });
        marketplaceRegistry.updateAgent("agent-idem", { name: "Idem Gard Two" }); // abandons "idem-gard" -> E
        marketplaceRegistry.updateAgent("agent-idem", { name: "Idem Gard" }); // reclaims it (abandons "idem-gard-two")
        warnCalls.length = 0;
        marketplaceRegistry.updateAgent("agent-idem", { name: "Idem Gard Three" }); // re-abandons "idem-gard"

        const row = testDb
          .prepare("SELECT agent_id FROM agent_slug_aliases WHERE old_slug = 'idem-gard'")
          .get() as { agent_id: string } | undefined;
        assertEq(row?.agent_id, "agent-idem", "h1: re-abandoned slug still points at the same (idempotent) owner");
        assertTrue(
          warnCalls.every(w => !w.includes("slug-alias collision")),
          "h2: no false collision warning when the same agent re-abandons a slug it already owns",
        );
      } finally {
        console.warn = origWarn;
      }
    }

    // ── (i) admin route with allowOverwrite:true CAN still overwrite an
    // existing alias — the deliberate human-operator correction path ────────
    {
      const routePath = require.resolve("../routes/admin-agents");
      delete require.cache[routePath];
      const routerModule = require("../routes/admin-agents").default as any;
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === "/:id/slug-alias" && l.route.methods && l.route.methods.post,
      );
      const handler = layer.route.stack[0].handle;
      const testKey = (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string;

      // "Old Name Attack Gard"'s alias currently points at agent-attack-a (case g).
      // A human operator deliberately reassigns it to a fresh agent.
      seedAgent({ id: "agent-correction", name: "Correction Target Gard" });
      const res = fakeRes();
      handler(
        {
          params: { id: "agent-correction" },
          headers: { "x-admin-key": testKey },
          body: { oldSlug: "Old Name Attack Gard" },
        } as any,
        res,
      );
      assertEq(res.statusCode, 200, "i1: admin backfill (overwrite) -> 200");
      const resolved = marketplaceRegistry.resolveAgentSlugAlias(slugify("Old Name Attack Gard"));
      assertEq(
        resolved?.id,
        "agent-correction",
        "i2: admin route with allowOverwrite:true DID overwrite the existing alias to the new agent",
      );
    }

    // ── (j) PR #800 review finding 2 regression: admin route normalizes
    // oldSlug through slugify() before writing ──────────────────────────────
    {
      const routePath = require.resolve("../routes/admin-agents");
      delete require.cache[routePath];
      const routerModule = require("../routes/admin-agents").default as any;
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === "/:id/slug-alias" && l.route.methods && l.route.methods.post,
      );
      const handler = layer.route.stack[0].handle;
      const testKey = (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string;

      seedAgent({ id: "agent-mixedcase", name: "Mixed Case Backfill Gard" });
      const mixedCaseInput = "Romstad-Gard-Molde"; // reviewer's exact example
      const expectedNormalized = slugify(mixedCaseInput); // "romstad-gard-molde"
      assertTrue(
        mixedCaseInput !== expectedNormalized,
        "j0-setup: fixture sanity — raw input differs from its normalized form (proves this exercises normalization, not a no-op)",
      );

      const res = fakeRes();
      handler(
        { params: { id: "agent-mixedcase" }, headers: { "x-admin-key": testKey }, body: { oldSlug: mixedCaseInput } } as any,
        res,
      );
      assertEq(res.statusCode, 200, "j1: mixed-case backfill -> 200");
      assertEq(res.body?.old_slug, expectedNormalized, "j2: response echoes the NORMALIZED old_slug, not the raw input");

      const rawRow = testDb.prepare("SELECT 1 FROM agent_slug_aliases WHERE old_slug = ?").get(mixedCaseInput);
      assertTrue(!rawRow, "j3: no row stored under the raw, unnormalized input");

      const normalizedRow = testDb
        .prepare("SELECT agent_id FROM agent_slug_aliases WHERE old_slug = ?")
        .get(expectedNormalized) as { agent_id: string } | undefined;
      assertEq(normalizedRow?.agent_id, "agent-mixedcase", "j4: row stored under the normalized slug");

      // Mirrors the real read path (seo.ts lowercases req.params.slug but does
      // not re-run slugify) — the backfilled alias must resolve there.
      const resolved = marketplaceRegistry.resolveAgentSlugAlias(expectedNormalized.toLowerCase());
      assertTrue(!!resolved, "j5: resolveAgentSlugAlias finds the backfilled alias via the lowercase read path");
      assertEq(resolved?.id, "agent-mixedcase", "j6: resolves to the right agent");
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
