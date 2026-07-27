/**
 * cart-service-supply-graph.test.ts — tests that addCartItem() and
 * submitCart() gate on the EFFECTIVE availability (via
 * computeEffectiveAvailability from ./supply-graph), not the raw
 * `products.availability` column (dev-request 2026-07-13-supply-graph-v1,
 * salvage slice).
 *
 * Root cause closed: a producer could set `availability='in_stock'` via the
 * producer dashboard once, then go quiet forever — the raw column stays
 * 'in_stock' indefinitely, so both add-to-cart and submit kept trusting a
 * value that's actually gone stale (>14 days, see supply-graph.ts). This
 * suite pins that a stale producer_dashboard 'in_stock' row is rejected at
 * BOTH points, with the EFFECTIVE 'unknown' value surfacing in submitCart's
 * error payload — and that enrichment-sourced rows (the overwhelming
 * majority, no producer input yet) are completely unaffected regardless of
 * age (regression guard).
 *
 * Mirrors pilot-ordre-loop.test.ts's fixture idiom:
 *   - fresh in-memory better-sqlite3 DB, real prod schema via
 *     __initSchemaForTesting.
 *   - cart-service's module-local test DB pinned via __setCartTestDb
 *     (race-proof, does not touch the global __setDbForTesting singleton).
 *   - exported runCartServiceSupplyGraphTests({log}) -> TestSummary; wired
 *     into tests/test.ts.
 *     Standalone: npx tsx src/services/cart-service-supply-graph.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCartServiceSupplyGraphTests(opts: { log?: boolean } = {}): TestSummary {
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("./cart-service") as typeof import("./cart-service");

  const prevDb = (() => {
    try { return initMod.getDb(); } catch { return undefined; }
  })();

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  // SQLite datetime('now')-style "YYYY-MM-DD HH:MM:SS" (UTC, no offset) —
  // matches parseTimestamp()'s expected raw-column format in supply-graph.ts.
  function sqlTs(d: Date): string {
    return d.toISOString().slice(0, 19).replace("T", " ");
  }
  const now = new Date();
  const freshTs = sqlTs(new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000)); // 1 day old
  const staleTs = sqlTs(new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000)); // 20 days old (> 14-day window)
  const veryOldTs = sqlTs(new Date(now.getTime() - 900 * 24 * 60 * 60 * 1000)); // ~2.5 years old

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);

    // ── Seed one verified, non-umbrella producer (required by isProducerEligible) ──
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES ('agent-x', 'Gard X', 'test agent', 'test', 'x@example.com', 'https://example.com', 'producer', 'key-x')
    `).run();
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, verification_status) VALUES ('agent-x', 'verified')
    `).run();

    // ── Seed products ──
    const insertProduct = db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source, availability_updated_at)
      VALUES (?, 'agent-x', ?, ?, 30, 'kg', 'in_stock', ?, ?)
    `);
    insertProduct.run("prod-fresh-pd", "Fersk PD-satt", "fersk-pd-satt", "producer_dashboard", freshTs);
    insertProduct.run("prod-stale-pd", "Foreldet PD-satt", "foreldet-pd-satt", "producer_dashboard", staleTs);
    insertProduct.run("prod-old-enrichment", "Gammel enrichment", "gammel-enrichment", "enrichment", veryOldTs);

    // ═══════════ addCartItem ═══════════

    // A fresh producer_dashboard-set 'in_stock' row is addable.
    {
      const cart = cartSvc.createCart();
      const r = cartSvc.addCartItem(cart.cart_id, "prod-fresh-pd", 1);
      assertTrue(r.success === true, "addCartItem: fresh (1d old) producer_dashboard in_stock row is addable");
    }

    // A 14+-day-stale producer_dashboard 'in_stock' row is REJECTED at add-to-cart.
    {
      const cart = cartSvc.createCart();
      const r = cartSvc.addCartItem(cart.cart_id, "prod-stale-pd", 1);
      assertTrue(r.success === false, "addCartItem: 20d-stale producer_dashboard in_stock row is REJECTED");
      if (!r.success) {
        assertEq(r.status, 409, "addCartItem: stale row rejection is a 409");
        assertTrue(r.error.includes("unknown"), "addCartItem: stale row rejection error surfaces the effective 'unknown' value, not the stale raw 'in_stock'");
      }
    }

    // An enrichment-sourced 'in_stock' row of ANY age is unaffected (regression guard).
    {
      const cart = cartSvc.createCart();
      const r = cartSvc.addCartItem(cart.cart_id, "prod-old-enrichment", 1);
      assertTrue(r.success === true, "addCartItem: enrichment-sourced in_stock row (~2.5y old) is unaffected — never goes stale");
    }

    // ═══════════ submitCart ═══════════

    // Fresh producer_dashboard item + old-enrichment item: both submit fine.
    {
      const cart = cartSvc.createCart();
      const add1 = cartSvc.addCartItem(cart.cart_id, "prod-fresh-pd", 1);
      const add2 = cartSvc.addCartItem(cart.cart_id, "prod-old-enrichment", 1);
      assertTrue(add1.success === true && add2.success === true, "submitCart setup: both items added to cart successfully");

      const sub = cartSvc.submitCart(cart.cart_id);
      assertTrue(sub.success === true, "submitCart: cart with fresh producer_dashboard + old-enrichment items submits successfully");
    }

    // A stale producer_dashboard item present at submit time (inserted directly,
    // bypassing addCartItem's own gate, to isolate submitCart's re-check) is
    // REJECTED, and the EFFECTIVE 'unknown' value surfaces in `unavailable`.
    {
      const cart = cartSvc.createCart();
      db.prepare(`
        INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot, added_at)
        VALUES ('item-stale-submit', ?, 'prod-stale-pd', 'agent-x', 1, 30, datetime('now'))
      `).run(cart.cart_id);

      const sub = cartSvc.submitCart(cart.cart_id);
      assertTrue(sub.success === false, "submitCart: cart containing a stale producer_dashboard in_stock item is REJECTED at submit");
      if (!sub.success) {
        assertEq(sub.status, 409, "submitCart: stale-item rejection is a 409");
        assertTrue(Array.isArray(sub.unavailable) && sub.unavailable.length === 1, "submitCart: unavailable array has exactly the one stale item");
        assertEq(sub.unavailable?.[0]?.product_id, "prod-stale-pd", "submitCart: unavailable item identifies the correct product_id");
        assertEq(sub.unavailable?.[0]?.availability, "unknown", "submitCart: unavailable item's availability field is the EFFECTIVE 'unknown' value, not the stale raw 'in_stock'");
      }

      // Cart must remain open (submit failed) — never partially submitted.
      const cartRow = db.prepare("SELECT status FROM carts WHERE id = ?").get(cart.cart_id) as any;
      assertEq(cartRow.status, "open", "submitCart: cart stays 'open' after a rejected submit (no partial state change)");
    }

    // A cart with ONLY an old-enrichment item submits fine at any age (regression guard).
    {
      const cart = cartSvc.createCart();
      db.prepare(`
        INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot, added_at)
        VALUES ('item-old-enrichment-submit', ?, 'prod-old-enrichment', 'agent-x', 1, 30, datetime('now'))
      `).run(cart.cart_id);

      const sub = cartSvc.submitCart(cart.cart_id);
      assertTrue(sub.success === true, "submitCart: cart with only an old-enrichment in_stock item submits successfully — enrichment never goes stale");
    }
  } finally {
    cartSvc.__setCartTestDb(null);
    initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runCartServiceSupplyGraphTests({ log: true });
  console.log(`\ncart-service-supply-graph: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
