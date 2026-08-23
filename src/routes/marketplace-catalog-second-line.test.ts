/**
 * marketplace-catalog-second-line.test.ts — proves the public catalog feed
 * (GET /api/marketplace/catalog/feed) and per-agent product list
 * (GET /api/marketplace/catalog/agents/:id/products) exclude
 * verified_second_line=1 producers, while first-line-verified producers
 * (verified_second_line 0/NULL) are completely unaffected.
 *
 * Fix-up to dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel,
 * closing a code-review CHANGES-REQUESTED finding on 36580f2b: before this
 * fix-up, both endpoints gated purely on `verification_status = 'verified'`
 * + non-umbrella, with no awareness of verified_second_line — so a
 * second-line-only producer's products were publicly listed/orderable
 * exactly like a full first-line-verified producer's. The second line is
 * meant to unlock outreach/contact only, never public commerce.
 *
 * Harness mirrors marketplace-catalog-supply-graph.test.ts: in-memory
 * better-sqlite3 DB via __setDbForTesting + __initSchemaForTesting, router
 * exercised directly (router.handle(req, res, next)) — no HTTP server, no
 * network calls.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/marketplace-catalog-second-line.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runMarketplaceCatalogSecondLineTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { catalogRouter } from "./marketplace-catalog";

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
  opts: { method?: string; url: string; params?: Record<string, string>; query?: Record<string, any>; headers?: Record<string, string> }
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      params: opts.params || {},
      query: opts.query || {},
      headers,
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

export async function runMarketplaceCatalogSecondLineTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDb = initMod.getDb();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  (initMod as any).__setDbForTesting(db);
  (initMod as any).__initSchemaForTesting(db);

  try {
    // ── Fixture: one first-line-verified agent + one second-line-only agent,
    // each with one in-stock product. ──
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city)
      VALUES ('agent-first-line', 'Gard Førstelinje', 'test', 'test', 'first@example.com', 'https://example.com', 'producer', 'key-first', 'Oslo')
    `).run();
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, verification_status)
      VALUES ('agent-first-line', 'verified')
    `).run();
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, availability, availability_source)
      VALUES ('prod-first-line', 'agent-first-line', 'Førstelinje Poteter', 'forstelinje poteter', 30, 'in_stock', 'enrichment')
    `).run();

    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city)
      VALUES ('agent-second-line', 'Gard Andrelinje', 'test', 'test', 'second@example.com', 'https://example.com', 'producer', 'key-second', 'Bergen')
    `).run();
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, verification_status, verified_second_line)
      VALUES ('agent-second-line', 'verified', 1)
    `).run();
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, availability, availability_source)
      VALUES ('prod-second-line', 'agent-second-line', 'Andrelinje Gulrøtter', 'andrelinje gulrotter', 20, 'in_stock', 'enrichment')
    `).run();

    // ── GET /api/marketplace/catalog/feed ──────────────────────────────
    const feedRes = await callRoute(catalogRouter, { url: "/feed" });
    assertEq(feedRes.status, 200, "feed: 200 OK");
    assertEq(feedRes.body.success, true, "feed: success=true");
    assertEq(feedRes.body.count, 1, "feed: count=1 — second-line-only agent's product excluded");
    assertEq(feedRes.body.total, 1, "feed: total=1 — second-line-only agent's product excluded from count too");

    const byId = new Map<string, any>((feedRes.body.items as any[]).map((it) => [it.id, it]));
    assertTrue(byId.has("prod-first-line"), "feed: first-line-verified agent's product IS present");
    assertTrue(!byId.has("prod-second-line"), "feed: second-line-only agent's product is NOT present");

    // ── GET /api/marketplace/catalog/agents/:id/products ────────────────
    const firstLineList = await callRoute(catalogRouter, {
      url: "/agents/agent-first-line/products",
      params: { id: "agent-first-line" },
    });
    assertEq(firstLineList.status, 200, "agent-products: first-line-verified agent -> 200 OK");
    assertEq(firstLineList.body.success, true, "agent-products: first-line-verified agent -> success=true");
    assertEq(firstLineList.body.count, 1, "agent-products: first-line-verified agent -> 1 product returned");

    const secondLineList = await callRoute(catalogRouter, {
      url: "/agents/agent-second-line/products",
      params: { id: "agent-second-line" },
    });
    assertEq(secondLineList.status, 404, "agent-products: second-line-only agent -> 404 (not discoverable)");
    assertEq(
      secondLineList.body.error,
      "Agent not found or not discoverable",
      "agent-products: second-line-only agent -> the same 404 message used for unverified/umbrella agents"
    );
  } finally {
    (initMod as any).__setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runMarketplaceCatalogSecondLineTests({ log: true }).then((r) => {
    console.log(`\nmarketplace-catalog-second-line: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}
