/**
 * marketplace-availability-patch.test.ts — tests for
 * `PATCH /agents/:id/products/:productId/availability`
 * (dev-request 2026-07-13-supply-graph-v1, salvage slice).
 *
 * Mirrors agent-knowledge-get-auth.test.ts's structure exactly:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema, including the
 *     products.availability_source/availability_updated_at columns).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - exported runMarketplaceAvailabilityPatchTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/marketplace-availability-patch.test.ts
 *
 * Covers:
 *   (1) unauthenticated PATCH -> 403.
 *   (2) valid X-Admin-Key -> 200, row updated.
 *   (3) valid X-Claim-Token (own agent) -> 200, row updated.
 *   (4) valid X-Claim-Token for a DIFFERENT agent -> 403 (not touched).
 *   (5) valid X-API-Key (own agent) -> 200, row updated.
 *   (6) valid X-API-Key for a DIFFERENT agent -> 403 (not touched).
 *   (7) unknown productId, valid auth -> 404.
 *   (8) valid auth for agent-a, but productId belongs to agent-b -> 404,
 *       agent-b's row never touched.
 *   (9) successful write stamps availability_source='producer_dashboard'
 *       and a fresh availability_updated_at, and the response echoes id +
 *       availability.
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
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
    params?: Record<string, string>;
  },
  rePin?: () => void,
): Promise<RouteResult> {
  return new Promise((resolve) => {
    if (rePin) rePin();
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
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

export function runMarketplaceAvailabilityPatchTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    const testAdminKey = "marketplace-availability-patch-test-admin-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    process.env.ADMIN_KEY = testAdminKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // ── Seed two agents ──
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
      );
      insertAgent.run("agent-a", "Gard A AS", "https://garda.no", "api-key-a");
      insertAgent.run("agent-b", "Gard B AS", "https://gardb.no", "api-key-b");

      // ── Seed a verified claim for agent-a ──
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, claim_token_expires_at)
         VALUES ('claim-a', 'agent-a', 'Eier A', 'eier-a@example.com', 'verified', 'claim-token-a',
                 datetime('now', '+30 days'))`,
      ).run();

      // ── Seed products: one per agent ──
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, availability)
         VALUES (?, ?, ?, ?, 'in_stock')`,
      ).run("prod-a-1", "agent-a", "Poteter", "poteter");
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, availability)
         VALUES (?, ?, ?, ?, 'in_stock')`,
      ).run("prod-b-1", "agent-b", "Gulrøtter", "gulrotter");

      // Fresh require so the router picks up the just-injected db.
      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;

      const rePin = () => {
        initMod.__setDbForTesting(db as any);
        process.env.ADMIN_KEY = testAdminKey;
        delete process.env.ANALYTICS_ADMIN_KEY;
      };

      // ── (1) unauthenticated PATCH -> 403, row untouched ──
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/agent-a/products/prod-a-1/availability",
          body: { availability: "out_of_stock" },
        }, rePin);
        assertEq(r.status, 403, "unauthenticated PATCH -> 403");
        const row = db.prepare("SELECT availability FROM products WHERE id = ?").get("prod-a-1") as any;
        assertEq(row.availability, "in_stock", "unauthenticated PATCH did not touch the row");
      }

      // ── (2) valid X-Admin-Key -> 200, row updated ──
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/agent-a/products/prod-a-1/availability",
          headers: { "x-admin-key": testAdminKey },
          body: { availability: "out_of_stock" },
        }, rePin);
        assertEq(r.status, 200, "PATCH with valid X-Admin-Key -> 200");
        assertEq(r.body?.success, true, "admin-key PATCH -> success:true");
        assertEq(r.body?.data?.id, "prod-a-1", "admin-key PATCH response echoes productId");
        assertEq(r.body?.data?.availability, "out_of_stock", "admin-key PATCH response echoes new availability");

        const row = db.prepare(
          "SELECT availability, availability_source, availability_updated_at FROM products WHERE id = ?",
        ).get("prod-a-1") as any;
        assertEq(row.availability, "out_of_stock", "admin-key PATCH updated the row's availability");
        assertEq(row.availability_source, "producer_dashboard", "admin-key PATCH stamped availability_source='producer_dashboard'");
        assertTrue(!!row.availability_updated_at, "admin-key PATCH stamped availability_updated_at");
      }

      // ── (3) valid X-Claim-Token (own agent) -> 200, row updated ──
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/agent-a/products/prod-a-1/availability",
          headers: { "x-claim-token": "claim-token-a" },
          body: { availability: "in_stock" },
        }, rePin);
        assertEq(r.status, 200, "PATCH with valid X-Claim-Token (own agent) -> 200");
        const row = db.prepare("SELECT availability FROM products WHERE id = ?").get("prod-a-1") as any;
        assertEq(row.availability, "in_stock", "claim-token PATCH updated the row's availability");
      }

      // ── (4) valid X-Claim-Token for a DIFFERENT agent -> 403, row untouched ──
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/agent-b/products/prod-b-1/availability",
          headers: { "x-claim-token": "claim-token-a" },
          body: { availability: "out_of_stock" },
        }, rePin);
        assertEq(r.status, 403, "PATCH with claim token belonging to a different agent -> 403");
        const row = db.prepare("SELECT availability FROM products WHERE id = ?").get("prod-b-1") as any;
        assertEq(row.availability, "in_stock", "cross-agent claim-token PATCH did not touch agent-b's row");
      }

      // ── (5) valid X-API-Key (own agent) -> 200, row updated ──
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/agent-b/products/prod-b-1/availability",
          headers: { "x-api-key": "api-key-b" },
          body: { availability: "out_of_stock" },
        }, rePin);
        assertEq(r.status, 200, "PATCH with valid X-API-Key (own agent) -> 200");
        const row = db.prepare("SELECT availability FROM products WHERE id = ?").get("prod-b-1") as any;
        assertEq(row.availability, "out_of_stock", "api-key PATCH updated agent-b's row");
      }

      // ── (6) valid X-API-Key for a DIFFERENT agent -> 403, row untouched ──
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/agent-a/products/prod-a-1/availability",
          headers: { "x-api-key": "api-key-b" },
          body: { availability: "out_of_stock" },
        }, rePin);
        assertEq(r.status, 403, "PATCH with API key belonging to a different agent -> 403");
        const row = db.prepare("SELECT availability FROM products WHERE id = ?").get("prod-a-1") as any;
        assertEq(row.availability, "in_stock", "cross-agent api-key PATCH did not touch agent-a's row");
      }

      // ── (7) unknown productId, valid auth -> 404 ──
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/agent-a/products/does-not-exist/availability",
          headers: { "x-admin-key": testAdminKey },
          body: { availability: "out_of_stock" },
        }, rePin);
        assertEq(r.status, 404, "PATCH for unknown productId, authorized -> 404");
      }

      // ── (8) valid auth for agent-a, but productId belongs to agent-b -> 404, never touched ──
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/agent-a/products/prod-b-1/availability",
          headers: { "x-admin-key": testAdminKey },
          body: { availability: "in_stock" },
        }, rePin);
        assertEq(r.status, 404, "PATCH with agent-a in the path but a productId belonging to agent-b -> 404");
        const row = db.prepare("SELECT availability FROM products WHERE id = ?").get("prod-b-1") as any;
        assertEq(row.availability, "out_of_stock", "cross-agent productId mismatch PATCH did not touch agent-b's row");
      }

      // ── (9) missing/empty availability in body -> 400 ──
      {
        const r = await callRoute(router, {
          method: "PATCH",
          url: "/agents/agent-a/products/prod-a-1/availability",
          headers: { "x-admin-key": testAdminKey },
          body: {},
        }, rePin);
        assertEq(r.status, 400, "PATCH with missing availability field -> 400");
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
  runMarketplaceAvailabilityPatchTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
