/**
 * cart-service-expiry.test.ts — dev-request
 * 2026-09-24-mcp-rate-limit-og-personvern-sannhet, track C3.
 *
 * Proves checkCartToken() (src/services/cart-service.ts) enforces
 * `carts.expires_at`, which createCart() has always written (7 days out)
 * but nothing ever read — the lokal_cart_create tool description promises
 * "valid for 7 days" with nothing actually enforcing it until this change.
 *
 * checkCartToken() is the single gate EVERY cart mutation/read goes through
 * (both the REST router marketplace-cart.ts and the MCP tools in mcp.ts),
 * so proving it here at the service layer covers every caller.
 *
 * Standalone: npx tsx src/services/cart-service-expiry.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCartServiceExpiryTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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

  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("./cart-service") as typeof import("./cart-service");

  const prevDb = (() => {
    try { return initMod.getDb(); } catch { return undefined; }
  })();

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);

    // ── 1. Fresh cart (createCart()'s own default: 7 days out) — not expired.
    const { cart_id, buyer_ref } = cartSvc.createCart();
    const freshCheck = cartSvc.checkCartToken(cart_id, buyer_ref);
    assertTrue(freshCheck.ok, "fresh cart (createCart's default 7-day expiry): checkCartToken ok=true");

    // ── 2. Force the SAME cart into the past — now rejected.
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE carts SET expires_at = ? WHERE id = ?").run(pastIso, cart_id);
    const expiredCheck = cartSvc.checkCartToken(cart_id, buyer_ref);
    assertEq(expiredCheck.ok, false, "expired cart: checkCartToken ok=false");
    if (!expiredCheck.ok) {
      assertEq(expiredCheck.status, 410, "expired cart: status 410 (Gone)");
      assertTrue(/expired/i.test(expiredCheck.error), "expired cart: error message mentions expiry");
    }

    // ── 3. Wrong token on that SAME (now-expired) cart still reports plain
    // "invalid token" (403), not the expiry — proves an attacker guessing
    // tokens can't use the error shape to learn whether a cart id exists
    // or has expired.
    const wrongTokenCheck = cartSvc.checkCartToken(cart_id, "not-the-real-token");
    assertEq(wrongTokenCheck.ok, false, "wrong token on an expired cart: still ok=false");
    if (!wrongTokenCheck.ok) {
      assertEq(wrongTokenCheck.status, 403, "wrong token on an expired cart: 403 invalid-token, NOT 410 expired");
    }

    // ── 4. A cart with expires_at = NULL (nullable column; no such rows in
    // production since createCart() always sets it, but must not crash or
    // false-positive as "expired" if one ever exists).
    db.prepare("UPDATE carts SET expires_at = NULL WHERE id = ?").run(cart_id);
    const nullExpiryCheck = cartSvc.checkCartToken(cart_id, buyer_ref);
    assertTrue(nullExpiryCheck.ok, "cart with NULL expires_at: never rejected as expired");

    // ── 5. A cart expiring in the far future — never rejected.
    const { cart_id: cart2, buyer_ref: buyerRef2 } = cartSvc.createCart();
    db.prepare("UPDATE carts SET expires_at = ? WHERE id = ?").run(
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      cart2
    );
    const futureCheck = cartSvc.checkCartToken(cart2, buyerRef2);
    assertTrue(futureCheck.ok, "cart expiring far in the future: checkCartToken ok=true");

    // ── 6. Missing cart still reports 404, unaffected by the expiry check.
    const missingCheck = cartSvc.checkCartToken("cart-does-not-exist", "whatever");
    assertEq(missingCheck.ok, false, "missing cart: ok=false");
    if (!missingCheck.ok) assertEq(missingCheck.status, 404, "missing cart: still 404 (expiry check never reached)");
  } finally {
    cartSvc.__setCartTestDb(null);
    initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runCartServiceExpiryTests({ log: true });
  console.log(`\ncart-service-expiry: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
