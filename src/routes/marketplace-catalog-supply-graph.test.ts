/**
 * marketplace-catalog-supply-graph.test.ts — additive-regression tests for
 * GET /api/marketplace/catalog/feed and GET /api/marketplace/catalog/agents/:id/products
 * (dev-request 2026-07-13-supply-graph-v1, Slice 1).
 *
 * Proves:
 *   - Every field that existed in each response BEFORE this change is still
 *     present with the same value/type (additive-only regression guard).
 *   - The new `availability_updated_at` field is present (raw timestamp or
 *     null).
 *   - The `availability` field now carries the EFFECTIVE (post supply-graph
 *     staleness check) value: a stale producer_dashboard row → 'unknown'; a
 *     fresh producer_dashboard row and an enrichment row → pass through
 *     unchanged.
 *   - The existing `WHERE p.availability = 'in_stock'` FEED filter still runs
 *     against the RAW column — a stale row (raw availability='in_stock') is
 *     still returned by the feed (filtering unchanged), just with its
 *     exposed `availability` field showing 'unknown'.
 *
 * Harness mirrors src/routes/admin-outreach-candidates-mode2-ordering.test.ts /
 * admin-wrong-entity-retro-sweep.test.ts conventions: in-memory better-sqlite3
 * DB via __setDbForTesting + __initSchemaForTesting, router exercised directly
 * (router.handle(req, res, next)) — no HTTP server, no network calls.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/marketplace-catalog-supply-graph.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runMarketplaceCatalogSupplyGraphTests() and folds its pass/fail counts
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

export async function runMarketplaceCatalogSupplyGraphTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // ── Fixture: one verified, non-umbrella agent with three products ──
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city)
      VALUES ('agent-sg', 'Supply Graph Gård', 'test', 'test', 'test@example.com', 'https://example.com', 'producer', 'key-agent-sg', 'Oslo')
    `).run();
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, verification_status)
      VALUES ('agent-sg', 'verified')
    `).run();

    // Fresh producer_dashboard row — availability passes through unchanged.
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, availability, availability_updated_at, availability_source)
      VALUES ('prod-fresh', 'agent-sg', 'Ferske Poteter', 'ferske poteter', 30, 'in_stock', datetime('now', '-1 day'), 'producer_dashboard')
    `).run();

    // Stale producer_dashboard row (20 days old, > default 14-day window) —
    // exposed availability becomes 'unknown'; raw column ('in_stock') still
    // satisfies the feed's WHERE filter, so it still shows up in /feed.
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, availability, availability_updated_at, availability_source)
      VALUES ('prod-stale', 'agent-sg', 'Gamle Gulrøtter', 'gamle gulrøtter', 20, 'in_stock', datetime('now', '-20 days'), 'producer_dashboard')
    `).run();

    // Enrichment-sourced row, no producer timestamp — never goes stale.
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, description, unit, price_nok, availability, category, image_url)
      VALUES ('prod-enrich', 'agent-sg', 'Enrichment Eple', 'enrichment eple', 'et eple', 'kg', 40, 'in_stock', 'fruit', 'https://example.com/eple.jpg')
    `).run();

    // ── GET /api/marketplace/catalog/feed ──────────────────────────────
    const feedRes = await callRoute(catalogRouter, { url: "/feed" });
    assertEq(feedRes.status, 200, "feed: 200 OK");
    assertEq(feedRes.body.success, true, "feed: success=true");
    assertEq(feedRes.body.count, 3, "feed: count=3 (WHERE availability='in_stock' filter unchanged — raw column still 'in_stock' for all three)");

    const byId = new Map<string, any>((feedRes.body.items as any[]).map((it) => [it.id, it]));

    // Pre-existing fields, byte-identical shape/values.
    const enrichItem = byId.get("prod-enrich");
    assertTrue(!!enrichItem, "feed: prod-enrich present");
    assertEq(enrichItem.title, "Enrichment Eple", "feed: pre-existing field `title` unchanged");
    assertEq(enrichItem.description, "et eple", "feed: pre-existing field `description` unchanged");
    assertEq(enrichItem.price, { amount: 40, currency: "NOK" }, "feed: pre-existing field `price` unchanged");
    assertEq(enrichItem.unit, "kg", "feed: pre-existing field `unit` unchanged");
    assertEq(enrichItem.category, "fruit", "feed: pre-existing field `category` unchanged");
    assertEq(enrichItem.image_url, "https://example.com/eple.jpg", "feed: pre-existing field `image_url` unchanged");
    assertEq(
      enrichItem.seller,
      { agent_id: "agent-sg", name: "Supply Graph Gård", city: "Oslo", profile_url: "https://rettfrabonden.com/produsent/supply-graph-gard" },
      "feed: pre-existing field `seller` unchanged"
    );

    // New fields + effective-availability computation.
    assertEq(enrichItem.availability, "in_stock", "feed: enrichment row availability passes through unchanged (effective === raw)");
    assertTrue(enrichItem.availability_updated_at === null, "feed: enrichment row's new `availability_updated_at` field is null");

    const freshItem = byId.get("prod-fresh");
    assertEq(freshItem.availability, "in_stock", "feed: fresh (1d) producer_dashboard row's effective availability passes through unchanged");
    assertTrue(!!freshItem.availability_updated_at, "feed: fresh producer_dashboard row's new `availability_updated_at` field is populated");

    const staleItem = byId.get("prod-stale");
    assertEq(staleItem.availability, "unknown", "feed: stale (20d) producer_dashboard row's EXPOSED availability is 'unknown'");
    assertTrue(!!staleItem.availability_updated_at, "feed: stale producer_dashboard row's new `availability_updated_at` field is still populated (raw timestamp, not hidden)");

    // ── GET /api/marketplace/catalog/agents/:id/products ────────────────
    const listRes = await callRoute(catalogRouter, { url: "/agents/agent-sg/products", params: { id: "agent-sg" } });
    assertEq(listRes.status, 200, "agent-products: 200 OK");
    assertEq(listRes.body.success, true, "agent-products: success=true");
    assertEq(listRes.body.agent_id, "agent-sg", "agent-products: pre-existing field `agent_id` unchanged");
    assertEq(listRes.body.count, 3, "agent-products: count=3 (this endpoint is NOT filtered by availability)");

    const byId2 = new Map<string, any>((listRes.body.products as any[]).map((p) => [p.id, p]));

    const enrichP = byId2.get("prod-enrich");
    assertEq(enrichP.name, "Enrichment Eple", "agent-products: pre-existing field `name` unchanged");
    assertEq(enrichP.description, "et eple", "agent-products: pre-existing field `description` unchanged");
    assertEq(enrichP.unit, "kg", "agent-products: pre-existing field `unit` unchanged");
    assertEq(enrichP.price_nok, 40, "agent-products: pre-existing field `price_nok` unchanged");
    assertEq(enrichP.currency, "NOK", "agent-products: pre-existing field `currency` unchanged");
    assertEq(enrichP.category, "fruit", "agent-products: pre-existing field `category` unchanged");
    assertEq(enrichP.image_url, "https://example.com/eple.jpg", "agent-products: pre-existing field `image_url` unchanged");
    assertTrue(!("availability_source" in enrichP), "agent-products: internal `availability_source` stays un-projected, same as `source`");
    assertTrue(!("source" in enrichP), "agent-products: pre-existing behaviour — `source` stays un-projected (regression guard)");

    assertEq(enrichP.availability, "in_stock", "agent-products: enrichment row availability passes through unchanged");
    assertTrue(enrichP.availability_updated_at === null, "agent-products: enrichment row's new `availability_updated_at` is null");

    const staleP = byId2.get("prod-stale");
    assertEq(staleP.availability, "unknown", "agent-products: stale producer_dashboard row's EXPOSED availability is 'unknown'");
    assertTrue(!!staleP.availability_updated_at, "agent-products: stale row's new `availability_updated_at` field is populated");

    const freshP = byId2.get("prod-fresh");
    assertEq(freshP.availability, "in_stock", "agent-products: fresh producer_dashboard row's effective availability passes through unchanged");
  } finally {
    (initMod as any).__setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runMarketplaceCatalogSupplyGraphTests({ log: true }).then((r) => {
    console.log(`\nmarketplace-catalog-supply-graph: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}
