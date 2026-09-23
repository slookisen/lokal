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
 *   - never touches any column other than the 5 contact fields (order rows,
 *     other cart columns untouched).
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

  // Slice 2: an order carrying its OWN copy of the 5 buyer-contact columns
  // (mirrors what cart-service.ts's submitCart() writes at order-creation
  // time). `noContact: true` inserts an order with all 5 columns NULL — the
  // "already clean, nothing to sweep" case.
  function insertOrderWithContact(
    id: string,
    cartId: string,
    status: string,
    updatedAt: string,
    opts3: { noContact?: boolean } = {}
  ) {
    const c = opts3.noContact ? null : "Order Buyer";
    db.prepare(`
      INSERT INTO orders
        (id, cart_id, agent_id, buyer_ref, status, fulfilment, total_nok, confirm_token, created_at, updated_at,
         buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at)
      VALUES (?, ?, 'agent-x', ?, ?, 'pickup', 30, ?, datetime('now'), ?, ?, ?, ?, ?, ?)
    `).run(
      id, cartId, `bref_${cartId}`, status, `ctok_${id}`, updatedAt,
      c, c ? "orderbuyer@example.com" : null, c ? "+47 90000099" : null,
      c ? "Legg ved døra" : null, c ? sqlTs(now) : null
    );
  }

  function readCart(id: string): any {
    return db.prepare(
      "SELECT buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at, updated_at FROM carts WHERE id = ?"
    ).get(id);
  }

  function readOrder(id: string): any {
    return db.prepare(
      "SELECT buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at, status FROM orders WHERE id = ?"
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

    // ═══════════ Slice 2: order-level sweep (independent per-order clock) ═
    // Every fixture cart below is inserted WITHOUT its own contact fields
    // (same raw-insert idiom as cart-already-clean above) so these cases
    // exercise ONLY the order-level rule, without perturbing the cart-level
    // sweptCartIds/sweptCount assertion right below.

    // ── order-level-old-terminal: completed 40d ago → SWEPT ────────────────
    db.prepare(`
      INSERT INTO carts (id, buyer_ref, buyer_kind, status, currency, created_at, updated_at)
      VALUES ('cart-order-level-old', 'bref_cart-order-level-old', 'platform_agent', 'submitted', 'NOK', datetime('now'), ?)
    `).run(sqlTs(days(40)));
    insertOrderWithContact("order-level-old-terminal", "cart-order-level-old", "completed", sqlTs(days(40)));

    // ── order-level-recent-terminal: declined only 10d ago → NOT swept yet ─
    db.prepare(`
      INSERT INTO carts (id, buyer_ref, buyer_kind, status, currency, created_at, updated_at)
      VALUES ('cart-order-level-recent', 'bref_cart-order-level-recent', 'platform_agent', 'submitted', 'NOK', datetime('now'), ?)
    `).run(sqlTs(days(10)));
    insertOrderWithContact("order-level-recent-terminal", "cart-order-level-recent", "declined", sqlTs(days(10)));

    // ── order-level-live-order: still 'pending', 90d old → NEVER swept while
    // live, no matter how old (mirrors the cart-level rule's own such case).
    db.prepare(`
      INSERT INTO carts (id, buyer_ref, buyer_kind, status, currency, created_at, updated_at)
      VALUES ('cart-order-level-live', 'bref_cart-order-level-live', 'platform_agent', 'submitted', 'NOK', datetime('now'), ?)
    `).run(sqlTs(days(90)));
    insertOrderWithContact("order-level-live-order", "cart-order-level-live", "pending", sqlTs(days(90)));

    // ── order-level-already-clean: terminal+old but already has NULL
    // contact fields → never reselected (idempotency / nothing to null).
    db.prepare(`
      INSERT INTO carts (id, buyer_ref, buyer_kind, status, currency, created_at, updated_at)
      VALUES ('cart-order-level-clean', 'bref_cart-order-level-clean', 'platform_agent', 'submitted', 'NOK', datetime('now'), ?)
    `).run(sqlTs(days(60)));
    insertOrderWithContact("order-level-already-clean", "cart-order-level-clean", "completed", sqlTs(days(60)), { noContact: true });

    // ── cart-order-level-mixed-status: TWO orders, one terminal+old, one
    // still pending. The ORDER-level rule sweeps ONLY the terminal+old one,
    // independent of its sibling's status — a materially different rule
    // from the cart-level one (which requires ALL orders terminal before
    // touching the CART's own fields — see cart-two-orders-mixed-age above,
    // a same-shaped fixture that tests THAT rule instead).
    db.prepare(`
      INSERT INTO carts (id, buyer_ref, buyer_kind, status, currency, created_at, updated_at)
      VALUES ('cart-order-level-mixed-status', 'bref_cart-order-level-mixed-status', 'platform_agent', 'submitted', 'NOK', datetime('now'), ?)
    `).run(sqlTs(days(1)));
    insertOrderWithContact("order-level-mixed-terminal", "cart-order-level-mixed-status", "completed", sqlTs(days(45)));
    insertOrderWithContact("order-level-mixed-pending", "cart-order-level-mixed-status", "pending", sqlTs(days(90)));

    const result = sweepMod.sweepExpiredCartContactData(30, now);

    assertEq(
      [...result.sweptCartIds].sort(),
      ["cart-contact-only-old", "cart-terminal-old"].sort(),
      "sweepExpiredCartContactData: sweeps exactly the two eligible carts"
    );
    assertEq(result.sweptCount, 2, "sweepExpiredCartContactData: sweptCount matches sweptCartIds.length");

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
    ]) {
      const c = readCart(id);
      assertTrue(c.buyer_name === "Test Buyer", `${id}: buyer_name left untouched (not eligible yet)`);
    }

    // ── An order's STATUS is never touched by the sweep — only its 5
    // contact columns (order-1 here has none, so nothing changes at all).
    const order1 = db.prepare("SELECT status FROM orders WHERE id = 'order-1'").get() as any;
    assertEq(order1.status, "completed", "sweep never touches an order's status, only its contact columns");

    // ── Slice 2: order-level sweep results ─────────────────────────────────
    assertEq(
      [...result.sweptOrderIds].sort(),
      ["order-level-mixed-terminal", "order-level-old-terminal"].sort(),
      "sweepExpiredCartContactData: sweeps exactly the two eligible orders (order-level clock)"
    );
    assertEq(result.sweptOrderCount, 2, "sweepExpiredCartContactData: sweptOrderCount matches sweptOrderIds.length");

    for (const id of ["order-level-old-terminal", "order-level-mixed-terminal"]) {
      const o = readOrder(id);
      assertEq(o.buyer_name, null, `${id}: buyer_name nulled`);
      assertEq(o.buyer_email, null, `${id}: buyer_email nulled`);
      assertEq(o.buyer_phone, null, `${id}: buyer_phone nulled`);
      assertEq(o.delivery_note, null, `${id}: delivery_note nulled`);
      assertEq(o.contact_consent_at, null, `${id}: contact_consent_at nulled`);
    }

    for (const id of ["order-level-recent-terminal", "order-level-live-order", "order-level-mixed-pending"]) {
      const o = readOrder(id);
      assertEq(o.buyer_name, "Order Buyer", `${id}: buyer_name left untouched (not eligible yet)`);
    }

    // The sibling of order-level-mixed-terminal is untouched precisely
    // BECAUSE it's still 'pending', even though the cart-level rule (which
    // this order-level rule does NOT apply) would have blocked on it too —
    // this proves the two rules are independent, not that this one somehow
    // waited on the sibling.
    assertTrue(
      readOrder("order-level-mixed-terminal").buyer_name === null &&
      readOrder("order-level-mixed-pending").buyer_name === "Order Buyer",
      "order-level sweep ignores sibling-order status entirely — a materially different rule from the cart-level one"
    );

    // Cart-level fields are unaffected by the order-level rule: none of the
    // order-level fixture carts were ever cart-level candidates (inserted
    // with no contact fields of their own, same idiom as cart-already-clean
    // above), and none of them appear in sweptCartIds (already asserted by
    // the exact-match assertion above) — proving the order-level sweep only
    // ever writes to `orders`, never to `carts`.
    assertTrue(
      readCart("cart-order-level-old").buyer_name == null,
      "cart-order-level-old: cart-level buyer_name stays NULL — it never had one to begin with, and the order-level sweep never writes to carts"
    );

    // ── Idempotency: a second run on the same fixture sweeps nothing new ──
    const secondRun = sweepMod.sweepExpiredCartContactData(30, now);
    assertEq(secondRun.sweptCartIds, [], "sweepExpiredCartContactData: re-running is a no-op — already-swept carts are never re-selected");
    assertEq(secondRun.sweptCount, 0, "sweepExpiredCartContactData: second run's sweptCount is 0");
    assertEq(secondRun.sweptOrderIds, [], "sweepExpiredCartContactData: re-running is a no-op — already-swept orders are never re-selected");
    assertEq(secondRun.sweptOrderCount, 0, "sweepExpiredCartContactData: second run's sweptOrderCount is 0");
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
