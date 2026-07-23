/**
 * supply-graph-availability.test.ts — integration tests for dev-request
 * 2026-07-23-supplygraph ("Local Supply Graph v1").
 *
 * Mirrors the harness in agent-knowledge-get-auth.test.ts: in-memory
 * better-sqlite3 DB via __setDbForTesting + __initSchemaForTesting, routers
 * exercised directly via router.handle() (no HTTP server), db re-pinned
 * synchronously before every single route call (see that file's "2026-07-05
 * CI fix" note — same hazard applies here since this file also swaps the
 * shared getDb() singleton).
 *
 * Covers:
 *   (A) PATCH /agents/:id/products/:productId/availability — auth matrix
 *       (no-cred, wrong-agent claim-token, valid claim-token, valid
 *       admin-key), invalid-enum 400, unmatched-product 404 with a
 *       user-showable message, cross-agent-product 404 (no leak).
 *   (B) GET /api/marketplace/catalog/agents/:id/products — owner-auth
 *       bypass of the verified-gate, additive `availability_updated_at` +
 *       `effective_availability` fields, additive-only regression for an
 *       untouched fresh product.
 *   (C) GET /api/marketplace/catalog/feed — stale in_stock excluded
 *       (auto-expiry), fresh in_stock included (regression), seasonal
 *       still excluded (unchanged base filter).
 *   (D) mcp.ts getCatalogProductIdMap()/formatProductsForMcp() — badge text
 *       for all four effective states, cart-id eligibility gated on
 *       EFFECTIVE availability (stale in_stock -> no id), additive-only
 *       regression for an untouched fresh in_stock product.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/supply-graph-availability.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runSupplyGraphAvailabilityTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

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
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any },
  rePin: () => void,
): Promise<RouteResult> {
  return new Promise((resolve) => {
    rePin();
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
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
      resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : undefined });
    });
  });
}

export function runSupplyGraphAvailabilityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    const prevDb = initMod.getDb();
    const testAdminKey = "supply-graph-availability-test-admin-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    process.env.ADMIN_KEY = testAdminKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(`
        INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
        VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)
      `);
      const insertKnowledge = db.prepare(
        "INSERT INTO agent_knowledge (agent_id, verification_status, field_provenance) VALUES (?, ?, '{}')"
      );
      insertAgent.run("ag-a", "Gård A", "a@example.no", "key-a");
      insertKnowledge.run("ag-a", "verified");
      insertAgent.run("ag-b", "Gård B", "b@example.no", "key-b");
      insertKnowledge.run("ag-b", "verified");
      insertAgent.run("ag-unverified", "Gård C (uverifisert)", "c@example.no", "key-c");
      insertKnowledge.run("ag-unverified", "unverified");

      db.prepare(`
        INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, claim_token_expires_at)
        VALUES ('claim-a', 'ag-a', 'Eier A', 'eier-a@example.no', 'verified', 'claim-token-a', datetime('now', '+30 days'))
      `).run();
      db.prepare(`
        INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, claim_token_expires_at)
        VALUES ('claim-c', 'ag-unverified', 'Eier C', 'eier-c@example.no', 'verified', 'claim-token-c', datetime('now', '+30 days'))
      `).run();

      function insertProduct(id: string, agentId: string, opts2: {
        availability?: string;
        freshDaysAgo?: number | null; // null = never confirmed (NULL column)
      } = {}): void {
        const availability = opts2.availability ?? "in_stock";
        db.prepare(`
          INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability)
          VALUES (?, ?, ?, ?, 50, 'kg', ?)
        `).run(id, agentId, `Produkt ${id}`, `produkt ${id}`, availability);
        if (opts2.freshDaysAgo === undefined) return; // leave availability_updated_at NULL (default)
        if (opts2.freshDaysAgo === null) return; // explicit "never confirmed"
        db.prepare(
          "UPDATE products SET availability_updated_at = datetime('now', ?) WHERE id = ?"
        ).run(`-${opts2.freshDaysAgo} days`, id);
      }

      // Fresh in_stock (ag-a) — the "additive-only, untouched-but-fresh"
      // regression fixture (simulates a row already migrated/backfilled).
      insertProduct("prod-fresh", "ag-a", { availability: "in_stock", freshDaysAgo: 1 });
      // Stale in_stock (ag-a) — auto-expiry fixture.
      insertProduct("prod-stale", "ag-a", { availability: "in_stock", freshDaysAgo: 20 });
      // Never confirmed (ag-a) — NULL timestamp.
      insertProduct("prod-never", "ag-a", { availability: "in_stock" });
      // Fresh seasonal / sold_out (ag-a).
      insertProduct("prod-seasonal", "ag-a", { availability: "seasonal", freshDaysAgo: 1 });
      insertProduct("prod-soldout", "ag-a", { availability: "sold_out", freshDaysAgo: 1 });
      // Product belonging to ag-b, for cross-agent tests.
      insertProduct("prod-b1", "ag-b", { availability: "in_stock", freshDaysAgo: 1 });
      // Unverified-but-claimed agent's product (owner-auth-bypass fixture).
      insertProduct("prod-c1", "ag-unverified", { availability: "in_stock", freshDaysAgo: 1 });

      delete require.cache[require.resolve("./marketplace")];
      delete require.cache[require.resolve("./marketplace-catalog")];
      delete require.cache[require.resolve("./mcp")];
      const marketplaceMod = require("./marketplace");
      const marketplaceRouter = marketplaceMod.default;
      const catalogMod = require("./marketplace-catalog");
      const catalogRouter = catalogMod.catalogRouter;
      const mcpMod = require("./mcp") as typeof import("./mcp");

      const rePin = () => {
        initMod.__setDbForTesting(db as any);
        process.env.ADMIN_KEY = testAdminKey;
        delete process.env.ANALYTICS_ADMIN_KEY;
      };

      // ══════════════════════════════════════════════════════════════════
      // (A) PATCH /agents/:id/products/:productId/availability
      // ══════════════════════════════════════════════════════════════════

      {
        const r = await callRoute(marketplaceRouter, {
          method: "PATCH",
          url: "/agents/ag-a/products/prod-fresh/availability",
          body: { availability: "sold_out" },
        }, rePin);
        assertEq(r.status, 403, "PATCH availability: no credentials -> 403");
      }

      {
        const r = await callRoute(marketplaceRouter, {
          method: "PATCH",
          url: "/agents/ag-a/products/prod-fresh/availability",
          headers: { "x-claim-token": "claim-token-c" }, // belongs to ag-unverified, not ag-a
          body: { availability: "sold_out" },
        }, rePin);
        assertEq(r.status, 403, "PATCH availability: wrong-agent's claim token -> 403");
      }

      {
        const r = await callRoute(marketplaceRouter, {
          method: "PATCH",
          url: "/agents/ag-a/products/prod-fresh/availability",
          headers: { "x-claim-token": "claim-token-a" },
          body: { availability: "sold_out" },
        }, rePin);
        assertEq(r.status, 200, "PATCH availability: valid claim-token (own agent) -> 200");
        assertEq(r.body?.success, true, "PATCH availability: claim-token success:true");
        assertEq(r.body?.availability, "sold_out", "PATCH availability: response reflects new value");
        assertTrue(!!r.body?.availability_updated_at, "PATCH availability: response includes availability_updated_at");

        const row = db.prepare("SELECT availability, field_provenance FROM products WHERE id = 'prod-fresh'").get() as any;
        assertEq(row.availability, "sold_out", "PATCH availability: DB row updated by claim-token write");
        const prov = JSON.parse(row.field_provenance);
        assertTrue(Array.isArray(prov?.availability), `PATCH availability: field_provenance.availability is an array (got ${JSON.stringify(prov)})`);
        if (Array.isArray(prov?.availability)) {
          assertEq(prov.availability[prov.availability.length - 1].source_type, "owner", "PATCH availability: claim-token write recorded as source_type 'owner'");
        }
      }

      {
        const r = await callRoute(marketplaceRouter, {
          method: "PATCH",
          url: "/agents/ag-b/products/prod-b1/availability",
          headers: { "x-admin-key": testAdminKey },
          body: { availability: "seasonal" },
        }, rePin);
        assertEq(r.status, 200, "PATCH availability: valid X-Admin-Key -> 200");
        const row = db.prepare("SELECT availability, field_provenance FROM products WHERE id = 'prod-b1'").get() as any;
        assertEq(row.availability, "seasonal", "PATCH availability: DB row updated by admin-key write");
        const prov = JSON.parse(row.field_provenance);
        assertTrue(Array.isArray(prov?.availability), `PATCH availability: (admin) field_provenance.availability is an array (got ${JSON.stringify(prov)})`);
        if (Array.isArray(prov?.availability)) {
          assertEq(prov.availability[prov.availability.length - 1].source_type, "admin", "PATCH availability: admin-key write recorded as source_type 'admin'");
        }
      }

      {
        const r = await callRoute(marketplaceRouter, {
          method: "PATCH",
          url: "/agents/ag-a/products/prod-never/availability",
          headers: { "x-claim-token": "claim-token-a" },
          body: { availability: "discontinued" },
        }, rePin);
        assertEq(r.status, 400, "PATCH availability: invalid enum value -> 400");
      }

      {
        const r = await callRoute(marketplaceRouter, {
          method: "PATCH",
          url: "/agents/ag-a/products/does-not-exist/availability",
          headers: { "x-claim-token": "claim-token-a" },
          body: { availability: "in_stock" },
        }, rePin);
        assertEq(r.status, 404, "PATCH availability: product not in catalog for this agent -> 404");
        assertTrue(typeof r.body?.error === "string" && r.body.error.length > 0, "PATCH availability: 404 includes a user-showable error message");
      }

      {
        // prod-b1 exists but belongs to ag-b, not ag-a — must 404 (not 403/leak).
        const r = await callRoute(marketplaceRouter, {
          method: "PATCH",
          url: "/agents/ag-a/products/prod-b1/availability",
          headers: { "x-claim-token": "claim-token-a" },
          body: { availability: "in_stock" },
        }, rePin);
        assertEq(r.status, 404, "PATCH availability: productId belonging to a DIFFERENT agent -> 404 (same as missing, no leak)");
      }

      // ══════════════════════════════════════════════════════════════════
      // (B) GET /api/marketplace/catalog/agents/:id/products
      // ══════════════════════════════════════════════════════════════════

      {
        const r = await callRoute(catalogRouter, { method: "GET", url: "/agents/ag-unverified/products" }, rePin);
        assertEq(r.status, 404, "catalog per-agent products: unauthenticated GET for an UNVERIFIED agent -> 404 (unchanged public behaviour)");
      }

      {
        const r = await callRoute(catalogRouter, {
          method: "GET",
          url: "/agents/ag-unverified/products",
          headers: { "x-claim-token": "claim-token-c" },
        }, rePin);
        assertEq(r.status, 200, "catalog per-agent products: OWNER (claim-token) GET for an unverified agent -> 200 (owner-auth bypasses the verified-gate)");
        const p = (r.body?.products || []).find((x: any) => x.id === "prod-c1");
        assertTrue(!!p, "catalog per-agent products: owner sees their own product");
      }

      {
        const r = await callRoute(catalogRouter, { method: "GET", url: "/agents/ag-a/products" }, rePin);
        assertEq(r.status, 200, "catalog per-agent products: verified agent, public GET -> 200");
        const fresh = (r.body?.products || []).find((x: any) => x.id === "prod-fresh");
        assertTrue(!!fresh, "catalog per-agent products: fresh product present");
        // NOTE: prod-fresh was flipped to 'sold_out' by the PATCH test (A)
        // above — that's the write path proving its own effect, so check
        // the ADDITIVE-ONLY (untouched-by-any-write) guarantee via
        // prod-seasonal instead, which no PATCH call ever touched.
        assertEq(fresh.availability, "sold_out", "catalog per-agent products: prod-fresh reflects the earlier PATCH write");
        const seasonal = (r.body?.products || []).find((x: any) => x.id === "prod-seasonal");
        assertEq(seasonal.availability, "seasonal", "catalog per-agent products: untouched product's raw `availability` unchanged");
        assertEq(seasonal.effective_availability, "seasonal", "catalog per-agent products: fresh seasonal -> effective_availability = seasonal");
        assertTrue(!!seasonal.availability_updated_at, "catalog per-agent products: additive field availability_updated_at present");

        const stale = (r.body?.products || []).find((x: any) => x.id === "prod-stale");
        assertEq(stale.availability, "in_stock", "catalog per-agent products: STALE product's raw `availability` still 'in_stock' (never mutated)");
        assertEq(stale.effective_availability, "unknown", "catalog per-agent products: STALE product's effective_availability degrades to 'unknown'");

        const never = (r.body?.products || []).find((x: any) => x.id === "prod-never");
        assertEq(never.effective_availability, "unknown", "catalog per-agent products: NEVER-confirmed product -> effective_availability 'unknown'");
      }

      // ══════════════════════════════════════════════════════════════════
      // (C) GET /api/marketplace/catalog/feed
      // ══════════════════════════════════════════════════════════════════

      {
        const r = await callRoute(catalogRouter, { method: "GET", url: "/feed" }, rePin);
        assertEq(r.status, 200, "catalog feed: 200");
        const ids = (r.body?.items || []).map((i: any) => i.id);
        assertTrue(!ids.includes("prod-stale"), "catalog feed: STALE in_stock product EXCLUDED (auto-expiry — the graph must not lie)");
        assertTrue(!ids.includes("prod-never"), "catalog feed: NEVER-confirmed in_stock product EXCLUDED");
        assertTrue(!ids.includes("prod-seasonal"), "catalog feed: seasonal EXCLUDED (unchanged base filter — not widened in this slice)");
        assertTrue(!ids.includes("prod-soldout"), "catalog feed: sold_out EXCLUDED (unchanged base filter)");

        const item = (r.body?.items || []).find((i: any) => i.id === "prod-b1");
        // prod-b1 was flipped to 'seasonal' by the admin-key PATCH test above,
        // so it should NOT be in the feed either — assert that directly.
        assertTrue(!item, "catalog feed: prod-b1 (now seasonal via PATCH) EXCLUDED");
      }

      // Add one more, untouched fresh in_stock product to positively prove
      // inclusion (everything else above only proves exclusion cases).
      insertProduct("prod-feed-fresh", "ag-a", { availability: "in_stock", freshDaysAgo: 0 });
      {
        const r = await callRoute(catalogRouter, { method: "GET", url: "/feed" }, rePin);
        const ids = (r.body?.items || []).map((i: any) => i.id);
        assertTrue(ids.includes("prod-feed-fresh"), "catalog feed: fresh in_stock product INCLUDED (regression: positive case still works)");
        const item = (r.body?.items || []).find((i: any) => i.id === "prod-feed-fresh");
        assertTrue(!!item?.availability_updated_at, "catalog feed: item includes additive availability_updated_at field");
      }

      // ══════════════════════════════════════════════════════════════════
      // (D) mcp.ts getCatalogProductIdMap() / formatProductsForMcp()
      // ══════════════════════════════════════════════════════════════════

      {
        const map = mcpMod.getCatalogProductIdMap("ag-a", db);

        const fresh = map.get("produkt prod-feed-fresh");
        assertTrue(!!fresh?.id, "mcp map: fresh in_stock product HAS a cart-eligible id (regression)");
        assertEq(fresh?.effectiveAvailability, "in_stock", "mcp map: fresh in_stock -> effectiveAvailability in_stock");

        const stale = map.get("produkt prod-stale");
        assertEq(stale?.id, "", "mcp map: STALE in_stock product's id is EMPTY (no longer cart-eligible — behaviour change, spec acceptance criterion)");
        assertEq(stale?.effectiveAvailability, "unknown", "mcp map: stale in_stock -> effectiveAvailability unknown");

        const never = map.get("produkt prod-never");
        assertEq(never?.id, "", "mcp map: never-confirmed product's id is EMPTY");

        const seasonal = map.get("produkt prod-seasonal");
        assertEq(seasonal?.id, "", "mcp map: seasonal product never gets a cart id (unchanged — only in_stock ever did)");
        assertEq(seasonal?.effectiveAvailability, "seasonal", "mcp map: fresh seasonal -> effectiveAvailability seasonal");
      }

      {
        const products = [
          { name: "Produkt prod-feed-fresh", price: "kr 50" },
          { name: "Produkt prod-stale", price: "kr 50" },
          { name: "Produkt prod-seasonal", price: "kr 50" },
          { name: "Produkt prod-soldout", price: "kr 50" },
          { name: "Produkt prod-never", price: "kr 50" },
        ];
        const map = mcpMod.getCatalogProductIdMap("ag-a", db);
        const text = mcpMod.formatProductsForMcp(products, map);

        assertTrue(text.includes("🟢 På lager"), "mcp format: fresh in_stock shows 🟢 På lager badge");
        assertTrue(text.includes("· id:"), "mcp format: at least one product line carries a cart id");
        assertTrue(text.includes("🟡 Sesong"), "mcp format: seasonal shows 🟡 Sesong badge");
        assertTrue(text.includes("🔴 Utsolgt"), "mcp format: sold_out shows 🔴 Utsolgt badge");
        assertTrue(/⚪ Ukjent \(sist bekreftet \d+ dager? siden\)/.test(text), "mcp format: stale in_stock shows '⚪ Ukjent (sist bekreftet N dager siden)'");
        assertTrue(text.includes("⚪ Ukjent (aldri bekreftet)"), "mcp format: never-confirmed shows '⚪ Ukjent (aldri bekreftet)'");

        // Additive-only: the stale/seasonal/soldout/never lines must NOT carry
        // a `· id:` fragment (never cart-eligible).
        const staleLine = text.split("\n").find(l => l.includes("prod-stale"));
        assertTrue(!!staleLine && !staleLine.includes("· id:"), "mcp format: stale product line has NO id fragment");
      }

      {
        // Regression: a product this feature never touched at all (no
        // matching catalog map entry, e.g. backfill never ran for this
        // agent) must format EXACTLY as before this feature existed —
        // no id, no badge, no crash.
        const untouchedProducts = [{ name: "Helt Ny Vare", price: "kr 99" }];
        const emptyMap = new Map();
        const text = mcpMod.formatProductsForMcp(untouchedProducts, emptyMap);
        assertTrue(text.includes("Helt Ny Vare"), "mcp format regression: product with no catalog entry still renders");
        assertTrue(!text.includes("·  ·"), "mcp format regression: no double-suffix artifact when there's no catalog entry");
        assertTrue(!text.includes("id:"), "mcp format regression: no id fragment when there's no catalog entry");
      }
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runSupplyGraphAvailabilityTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    // Explicit exit regardless of outcome — requiring marketplace.ts et al.
    // can leave dangling handles (e.g. email-service's transport) that would
    // otherwise keep this standalone run hanging after a passing suite (see
    // PR-32's precedent comment in tests/test.ts for the same class of
    // issue). tests/test.ts's own REPORT block already does this
    // unconditionally for the exact same reason.
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
