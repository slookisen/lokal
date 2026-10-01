/**
 * cart-contact-sweep.test.ts — dev-request
 * 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt, Slice 1.
 *
 * Proves sweepExpiredCartContactData() (src/services/cart-contact-sweep.ts)
 * nulls the 5 contact columns on `carts` exactly when the spec says to:
 *   - all of a cart's orders are TERMINAL (declined/completed/cancelled)
 *     AND the latest one's updated_at is 30+ days old → swept.
 *   - any order still non-terminal (pending/confirmed/ready), however old
 *     → NOT swept (never sweeps a live order's buyer contact info).
 *   - all-terminal but recent (< 30 days) → NOT swept yet.
 *   - a cart with NO orders at all (pure contact-handoff submission) uses
 *     its own updated_at as the clock: 30+ days old → swept; recent → not.
 *   - a cart with nothing to null (already swept, or an open/never-
 *     submitted cart) is never selected — re-running is a no-op (proves
 *     idempotency on a fixture: two runs back to back sweep 0 the 2nd time).
 *   - never touches any column other than the 5 contact fields (order
 *     status, other cart/order columns untouched).
 *
 *   skive 2 (orders carry their own consent-gated copy of the 5 columns):
 *   - each ORDER is swept independently 30+ days after ITS OWN terminal
 *     status — regardless of sibling orders in the same cart (a cart with a
 *     live sibling keeps its cart-level fields while the finished order's
 *     copy is nulled).
 *   - a live (pending/confirmed/ready) order is never swept, however old;
 *     a recent terminal one not yet; an order with nothing to null never
 *     appears in sweptOrderIds.
 *   - dryRun reports the same order ids without writing; re-running is a
 *     no-op.
 *
 * Standalone: npx tsx src/services/cart-contact-sweep.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCartContactSweepTests(opts: { log?: boolean } = {}): TestSummary {
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
  const sweepMod = require("./cart-contact-sweep") as typeof import("./cart-contact-sweep");

  const prevDb = (() => {
    try { return initMod.getDb(); } catch { return undefined; }
  })();

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  // SQLite datetime('now')-style "YYYY-MM-DD HH:MM:SS" (UTC) — same
  // convention as cart-service-supply-graph.test.ts's sqlTs() helper.
  function sqlTs(d: Date): string {
    return d.toISOString().slice(0, 19).replace("T", " ");
  }
  const now = new Date();
  const days = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  function insertCart(id: string, opts2: { status?: string; updatedAt?: string } = {}) {
    db.prepare(`
      INSERT INTO carts
        (id, buyer_ref, buyer_kind, status, currency, created_at, updated_at,
         buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at)
      VALUES (?, ?, 'platform_agent', ?, 'NOK', datetime('now'), ?,
              'Test Buyer', 'buyer@example.com', '+47 90000000', 'Ring på døra', datetime('now'))
    `).run(id, `bref_${id}`, opts2.status ?? "submitted", opts2.updatedAt ?? sqlTs(now));
  }

  function insertOrder(id: string, cartId: string, status: string, updatedAt: string) {
    db.prepare(`
      INSERT INTO orders (id, cart_id, agent_id, buyer_ref, status, fulfilment, total_nok, confirm_token, created_at, updated_at)
      VALUES (?, ?, 'agent-x', ?, ?, 'pickup', 30, ?, datetime('now'), ?)
    `).run(id, cartId, `bref_${cartId}`, status, `ctok_${id}`, updatedAt);
  }

  function readCart(id: string): any {
    return db.prepare(
      "SELECT buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at, updated_at FROM carts WHERE id = ?"
    ).get(id);
  }

  // skive 2: order-level fixtures. The cart is deliberately CLEAN (no
  // contact fields) unless stated, so the cart-level expectations stay
  // exactly as they are and the order-level pass is proven on its own.
  function insertCleanCart(id: string, status = "submitted") {
    db.prepare(`
      INSERT INTO carts (id, buyer_ref, buyer_kind, status, currency, created_at, updated_at)
      VALUES (?, ?, 'platform_agent', ?, 'NOK', datetime('now'), datetime('now'))
    `).run(id, `bref_${id}`, status);
  }
  function insertOrderWithContact(id: string, cartId: string, status: string, updatedAt: string) {
    db.prepare(`
      INSERT INTO orders (id, cart_id, agent_id, buyer_ref, status, fulfilment, total_nok, confirm_token, created_at, updated_at,
                          buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at)
      VALUES (?, ?, 'agent-x', ?, ?, 'pickup', 30, ?, datetime('now'), ?,
              'Order Buyer', 'order-buyer@example.com', '+47 91111111', 'Henter etter 16', datetime('now'))
    `).run(id, cartId, `bref_${cartId}`, status, `ctok_${id}`, updatedAt);
  }
  function readOrder(id: string): any {
    return db.prepare(
      "SELECT status, buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at, updated_at FROM orders WHERE id = ?"
    ).get(id);
  }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    sweepMod.__setCartContactSweepTestDb(db as any);

    // ── Cart 1: one order, terminal (completed), 40 days old → SWEPT ──────
    insertCart("cart-terminal-old");
    insertOrder("order-1", "cart-terminal-old", "completed", sqlTs(days(40)));

    // ── Cart 2: one order, terminal (declined), 10 days old → NOT swept yet
    insertCart("cart-terminal-recent");
    insertOrder("order-2", "cart-terminal-recent", "declined", sqlTs(days(10)));

    // ── Cart 3: one order, still 'confirmed' (non-terminal), 90 days old ──
    // → NEVER swept while an order is live, no matter how old.
    insertCart("cart-live-order-very-old");
    insertOrder("order-3", "cart-live-order-very-old", "confirmed", sqlTs(days(90)));

    // ── Cart 4: two orders, BOTH terminal, most recent one only 5 days old
    // → NOT swept (must wait for the LATEST terminal transition, not the
    // earliest).
    insertCart("cart-two-orders-mixed-age");
    insertOrder("order-4a", "cart-two-orders-mixed-age", "completed", sqlTs(days(60)));
    insertOrder("order-4b", "cart-two-orders-mixed-age", "cancelled", sqlTs(days(5)));

    // ── Cart 5: NO orders at all (pure contact-handoff submission), the
    // cart's own updated_at is 45 days old → SWEPT (no order lifecycle to
    // wait on).
    insertCart("cart-contact-only-old", { updatedAt: sqlTs(days(45)) });

    // ── Cart 6: NO orders, updated_at only 2 days old → NOT swept yet.
    insertCart("cart-contact-only-recent", { updatedAt: sqlTs(days(2)) });

    // ── Cart 7: still 'open' (never submitted) — must never be touched,
    // even though it happens to carry no contact data (nothing to null) AND
    // even if it somehow had old-looking updated_at.
    insertCart("cart-still-open", { status: "open", updatedAt: sqlTs(days(90)) });

    // ── Cart 8: already has NULL contact fields (nothing to sweep) — must
    // not appear in sweptCartIds even though its (hypothetical) order is
    // old and terminal, since there's nothing left to null.
    db.prepare(`
      INSERT INTO carts (id, buyer_ref, buyer_kind, status, currency, created_at, updated_at)
      VALUES ('cart-already-clean', 'bref_cart-already-clean', 'platform_agent', 'submitted', 'NOK', datetime('now'), ?)
    `).run(sqlTs(days(60)));
    insertOrder("order-8", "cart-already-clean", "completed", sqlTs(days(60)));

    // ── skive 2: ORDER-level fixtures (each order on its own clock) ────────
    // o1: terminal (completed) 40 days ago, carries contact → SWEPT.
    insertCleanCart("cart-o1");
    insertOrderWithContact("ord-old-terminal", "cart-o1", "completed", sqlTs(days(40)));
    // o2: terminal (declined) only 10 days ago → NOT yet.
    insertCleanCart("cart-o2");
    insertOrderWithContact("ord-recent-terminal", "cart-o2", "declined", sqlTs(days(10)));
    // o3: still 'pending', 90 days old → NEVER while live.
    insertCleanCart("cart-o3");
    insertOrderWithContact("ord-live-old", "cart-o3", "pending", sqlTs(days(90)));
    // o4: terminal + old but NO contact fields (pre-skive-2 / no-consent
    // order) → nothing to null, never listed.
    insertCleanCart("cart-o4");
    insertOrder("ord-clean-old", "cart-o4", "completed", sqlTs(days(60)));
    // o5: the independence case — a cart WITH contact fields holding one
    // completed order (40 days) and one still-pending sibling (40 days):
    // the cart-level fields must NOT clear (live sibling), but the finished
    // order's own copy MUST (its own clock), and the pending sibling's not.
    insertCart("cart-o5-mixed");
    insertOrderWithContact("ord-o5-done", "cart-o5-mixed", "completed", sqlTs(days(40)));
    insertOrderWithContact("ord-o5-pending", "cart-o5-mixed", "pending", sqlTs(days(40)));
    const expectedSweptOrders = ["ord-o5-done", "ord-old-terminal"].sort();

    // ── dev-request 2026-09-24-mcp-rate-limit-og-personvern-sannhet, C3:
    // dryRun=true finds the SAME candidates a real run would, but writes
    // nothing — proven here BEFORE the real run below actually mutates
    // anything, on the exact same fixture. ─────────────────────────────────
    const dryRunResult = sweepMod.sweepExpiredCartContactData(30, now, true);
    assertEq(dryRunResult.dryRun, true, "dryRun=true: result.dryRun echoes true");
    assertEq(
      [...dryRunResult.sweptCartIds].sort(),
      ["cart-contact-only-old", "cart-terminal-old"].sort(),
      "dryRun=true: reports the exact same 2 eligible carts a real run would"
    );
    assertEq(dryRunResult.sweptCount, 2, "dryRun=true: sweptCount matches the real run's eventual count");
    assertEq([...dryRunResult.sweptOrderIds].sort(), expectedSweptOrders, "dryRun=true (skive 2): reports exactly the 2 order rows a real run would sweep");
    assertEq(dryRunResult.sweptOrderCount, 2, "dryRun=true (skive 2): sweptOrderCount matches");
    for (const id of expectedSweptOrders) {
      assertTrue(readOrder(id).buyer_name === "Order Buyer", `dryRun=true (skive 2): ${id}'s buyer_name is NOT nulled (no mutation happened)`);
    }
    // Nothing was actually written — both eligible carts' contact fields
    // are still present.
    for (const id of ["cart-terminal-old", "cart-contact-only-old"]) {
      const c = readCart(id);
      assertTrue(c.buyer_name === "Test Buyer", `dryRun=true: ${id}'s buyer_name is NOT nulled (no mutation happened)`);
      assertTrue(c.buyer_email === "buyer@example.com", `dryRun=true: ${id}'s buyer_email is NOT nulled (no mutation happened)`);
    }

    const result = sweepMod.sweepExpiredCartContactData(30, now);
    assertEq(result.dryRun, false, "real run (dryRun omitted/false): result.dryRun is false");

    assertEq(
      [...result.sweptCartIds].sort(),
      ["cart-contact-only-old", "cart-terminal-old"].sort(),
      "sweepExpiredCartContactData: sweeps exactly the two eligible carts"
    );
    assertEq(result.sweptCount, 2, "sweepExpiredCartContactData: sweptCount matches sweptCartIds.length");
    assertEq([...result.sweptOrderIds].sort(), expectedSweptOrders, "skive 2: sweeps exactly the two eligible ORDER rows (own terminal+30d clock)");
    assertEq(result.sweptOrderCount, 2, "skive 2: sweptOrderCount matches sweptOrderIds.length");
    for (const id of expectedSweptOrders) {
      const o = readOrder(id);
      assertEq([o.buyer_name, o.buyer_email, o.buyer_phone, o.delivery_note, o.contact_consent_at], [null, null, null, null, null], `skive 2: ${id}: all five order contact columns nulled`);
      assertEq(o.status, "completed", `skive 2: ${id}: status untouched by the sweep`);
    }
    for (const id of ["ord-recent-terminal", "ord-live-old", "ord-o5-pending"]) {
      assertTrue(readOrder(id).buyer_name === "Order Buyer", `skive 2: ${id}: order contact left untouched (not eligible yet / live)`);
    }
    assertEq(readOrder("ord-clean-old").buyer_name, null, "skive 2: ord-clean-old had nothing to null");
    assertTrue(!result.sweptOrderIds.includes("ord-clean-old"), "skive 2: an order with nothing to null never appears in sweptOrderIds");
    assertTrue(readCart("cart-o5-mixed").buyer_name === "Test Buyer", "skive 2 independence: the mixed cart's OWN contact fields stay (live sibling) while its finished order's copy was nulled");

    // ── Swept carts: all 5 fields nulled ──────────────────────────────────
    for (const id of ["cart-terminal-old", "cart-contact-only-old"]) {
      const c = readCart(id);
      assertEq(c.buyer_name, null, `${id}: buyer_name nulled`);
      assertEq(c.buyer_email, null, `${id}: buyer_email nulled`);
      assertEq(c.buyer_phone, null, `${id}: buyer_phone nulled`);
      assertEq(c.delivery_note, null, `${id}: delivery_note nulled`);
      assertEq(c.contact_consent_at, null, `${id}: contact_consent_at nulled`);
    }

    // ── Untouched carts: contact fields still present ─────────────────────
    for (const id of [
      "cart-terminal-recent",
      "cart-live-order-very-old",
      "cart-two-orders-mixed-age",
      "cart-contact-only-recent",
      "cart-still-open",
      "cart-o5-mixed",
    ]) {
      const c = readCart(id);
      assertTrue(c.buyer_name === "Test Buyer", `${id}: buyer_name left untouched (not eligible yet)`);
    }

    // ── Order rows themselves are never touched by the sweep ──────────────
    const order1 = db.prepare("SELECT status FROM orders WHERE id = 'order-1'").get() as any;
    assertEq(order1.status, "completed", "sweep never touches order rows, only carts' contact columns");

    // ── Idempotency: a second run on the same fixture sweeps nothing new ──
    const secondRun = sweepMod.sweepExpiredCartContactData(30, now);
    assertEq(secondRun.sweptCartIds, [], "sweepExpiredCartContactData: re-running is a no-op — already-swept carts are never re-selected");
    assertEq(secondRun.sweptCount, 0, "sweepExpiredCartContactData: second run's sweptCount is 0");
    assertEq(secondRun.sweptOrderIds, [], "skive 2: re-running sweeps no order twice");
    assertEq(secondRun.sweptOrderCount, 0, "skive 2: second run's sweptOrderCount is 0");
  } finally {
    sweepMod.__setCartContactSweepTestDb(null);
    initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runCartContactSweepTests({ log: true });
  console.log(`\ncart-contact-sweep: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
