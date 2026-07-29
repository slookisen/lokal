/**
 * produsent-role-gate.test.ts — dev-request
 * 2026-07-23-crm-house-bucket-kimaere-opprydding, fix 1 (role-gate on
 * GET /produsent/:slug in src/routes/seo.ts).
 *
 * Root cause this guards against: the route's main lookup
 * (marketplaceRegistry.getAgentBySlugIncludingUmbrellas) finds ANY active
 * agent by slugified name, regardless of `role` — so a non-producer agent
 * (role='logistics'/'consumer'/'quality'/'price-intel') got a full public
 * producer page rendered exactly like a real producer. Concretely: agent
 * 2b5fc7a6 ("Rett fra Bonden", role='logistics') is a de-facto CRM house
 * bucket that also inherited a real producer's contact data via a batch
 * mismatch, and was rendering live at /produsent/rett-fra-bonden with that
 * data in its JSON-LD.
 *
 * This suite asserts on the actual rendered HTTP response (status + body),
 * not on mocked internals — same convention as the existing badge check in
 * admin-agents-brreg-catalog-sweep.test.ts's section (g), which this
 * harness mirrors: own in-memory DB via __setDbForTesting/
 * __initSchemaForTesting, the REAL router's /produsent/:slug handler pulled
 * off the route stack and invoked directly with a fake req/res (no HTTP
 * server, no port).
 *
 * Cases:
 *   (a) role='producer'                    -> 200, producer page renders.
 *   (b) umbrella_type set (any role)        -> 200, umbrella stub renders
 *       (unchanged — Phase 5.11 A4.3/A4.4 umbrella rendering must not break).
 *   (c) role='logistics', no umbrella_type  -> 404, same "not found" page a
 *       truly-missing slug gets (THE fix — this is the house-bucket shape).
 *   (d) role='consumer' / 'quality' /
 *       'price-intel', no umbrella_type     -> 404 (general rule, not a
 *       special case for one id/role).
 *   (e) unknown slug entirely               -> 404 (regression guard: the
 *       gate must not change the pre-existing not-found path's shape).
 *
 * Exported runProdusentRoleGateTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/produsent-role-gate.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runProdusentRoleGateTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  function seedAgent(row: {
    id: string; name: string; role: string; umbrella_type?: string | null; is_active?: number;
  }): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages,
        trust_score, is_active, is_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at, umbrella_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
        '[]', '[]', '[]', '{}', '["no"]',
        0.5, ?, 0, 0, 0, 0, datetime('now'), datetime('now'), ?)`,
    ).run(
      row.id, row.name, "En beskrivelse", row.name, `${row.id}@example.no`, `https://${row.id}.example.no`,
      row.role, `key-${row.id}`, row.is_active ?? 1, row.umbrella_type ?? null,
    );
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // ── seed fixtures ──────────────────────────────────────────────────
    seedAgent({ id: "prod-1", name: "Ekte Testgård", role: "producer" });
    // Umbrella-tagged agent — role is whatever it was before tagging
    // (these are existing agent rows the A1 migration ALTERs onto, not a
    // new role value — see the comment block in database/init.ts above the
    // umbrella_type ALTERs). Using role='producer' here mirrors how real
    // umbrella rows in this codebase are shaped.
    seedAgent({ id: "umb-1", name: "Testmarked Nettverk", role: "producer", umbrella_type: "market_network" });
    // The house-bucket shape: non-producer role, NOT umbrella-tagged.
    seedAgent({ id: "chimera-1", name: "Ukoblet Samlemappe", role: "logistics" });
    seedAgent({ id: "consumer-1", name: "Forbrukertest Konto", role: "consumer" });
    seedAgent({ id: "quality-1", name: "Kvalitetstest Konto", role: "quality" });
    seedAgent({ id: "priceintel-1", name: "Prisintel Test Konto", role: "price-intel" });

    // seo.ts's shell() calls getConfig(), which throws unless the vertical
    // configs were cold-loaded at boot. Same best-effort load as
    // admin-agents-brreg-catalog-sweep.test.ts / reise-page.test.ts.
    const { loadConfigsAtBoot } = require("../config/vertical-config") as
      typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite, or dir missing in CI */ }

    const seoRoutePath = require.resolve("./seo");
    delete require.cache[seoRoutePath];
    const seoRouter = require("./seo").default as any;
    const layer = (seoRouter.stack as any[]).find(
      (l: any) => l.route && l.route.path === "/produsent/:slug" && l.route.methods?.get,
    );
    assertTrue(!!layer, "setup: GET /produsent/:slug layer is registered");
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    function invokeProdusent(slug: string): { status: number; body: string } {
      let status = 200;
      let body = "";
      const res: any = {
        status: (c: number) => { status = c; return res; },
        send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
        redirect: (_c: number, _l: string) => { status = 301; return res; },
      };
      const req: any = { params: { slug }, lang: "no", ip: "127.0.0.1" };
      handler(req, res);
      return { status, body };
    }

    // ── (a) real producer — unchanged, renders 200 ─────────────────────
    {
      const r = invokeProdusent("ekte-testgard");
      assertEq(r.status, 200, "a1: role='producer' agent's page renders 200");
      assertTrue(r.body.includes("Ekte Testgård"), "a2: producer page body includes the agent's name");
      assertTrue(!r.body.includes("Produsent ikke funnet"), "a3: producer page is not the not-found page");
    }

    // ── (b) umbrella-tagged agent — unchanged, renders 200 (not gated) ──
    {
      const r = invokeProdusent("testmarked-nettverk");
      assertEq(r.status, 200, "b1: umbrella_type='market_network' agent's page renders 200 (role-gate does not touch umbrellas)");
      assertTrue(r.body.includes("Testmarked Nettverk"), "b2: umbrella page body includes the agent's name");
      assertTrue(!r.body.includes("Produsent ikke funnet"), "b3: umbrella page is not the not-found page");
    }

    // ── (c) THE FIX: role='logistics', non-umbrella house-bucket -> 404 ─
    {
      const r = invokeProdusent("ukoblet-samlemappe");
      assertEq(r.status, 404, "c1: role='logistics', non-umbrella agent now 404s instead of rendering a public producer page");
      assertTrue(r.body.includes("Produsent ikke funnet"), "c2: 404 body is the same not-found page an unknown slug gets");
      assertTrue(!r.body.includes("Ukoblet Samlemappe"), "c3: the agent's own name/data never reaches the response body");
    }

    // ── (d) general rule: any other non-producer, non-umbrella role 404s ─
    for (const [slug, name] of [
      ["forbrukertest-konto", "role='consumer'"],
      ["kvalitetstest-konto", "role='quality'"],
      ["prisintel-test-konto", "role='price-intel'"],
    ]) {
      const r = invokeProdusent(slug);
      assertEq(r.status, 404, `d: ${name} agent 404s (general rule, not a special-case for one id)`);
      assertTrue(r.body.includes("Produsent ikke funnet"), `d: ${name} agent gets the same not-found page`);
    }

    // ── (e) regression guard: a genuinely unknown slug still 404s the same way ─
    {
      const r = invokeProdusent("dette-finnes-ikke-i-det-hele-tatt");
      assertEq(r.status, 404, "e1: unknown slug still 404s");
      assertTrue(r.body.includes("Produsent ikke funnet"), "e2: unknown slug gets the not-found page (pre-existing behavior, unchanged)");
    }
  } catch (err) {
    failed++;
    failures.push(`produsent-role-gate: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/produsent-role-gate.test.ts`
if (require.main === module) {
  console.log("── /produsent/:slug role-gate (dev-request 2026-07-23-crm-house-bucket-kimaere-opprydding) unit tests ──");
  runProdusentRoleGateTests({ log: true }).then((r) => {
    console.log(`\nprodusent-role-gate: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
