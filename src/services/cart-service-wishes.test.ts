/**
 * cart-service-wishes.test.ts — dev-request
 * 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt, Slice 1.
 *
 * Proves the cart_wishes model in cart-service.ts:
 *   - addCartWish(): validation, open-cart gate.
 *   - chooseCartWishOffer(): product_id path upserts a real cart_items row
 *     via the EXISTING addCartItem() machinery (same eligibility/
 *     availability gates); agent_id+mode='contact' path sets chosen_agent_id
 *     with NO cart_items row; switching a wish's choice cleans up any
 *     previously-linked cart_items row (no dangling order-mode line).
 *   - deleteCartWish(): also cleans up a linked cart_items row.
 *   - submitCart(cartId, contact?):
 *       * an eligible producer's chosen offer becomes a real order (existing
 *         behaviour, via the mirrored cart_items row) — unchanged.
 *       * a contact-mode wish (or a producer that turned out ineligible at
 *         submit time) produces NO order row, a contact_handoffs[] entry
 *         instead, and exactly one cart_handoffs analytics row with
 *         item_count and NO buyer/personal-data columns.
 *       * contact fields + contact_consent_at persist on `carts` only when
 *         contact_consent=true.
 *       * REGRESSION: a cart with no wishes at all (fase-1 flow) submits
 *         exactly as before — same orders, contact_handoffs: [].
 *
 * Mirrors cart-service-second-line.test.ts's fixture idiom: fresh in-memory
 * better-sqlite3 DB via __initSchemaForTesting, module-local test-DB pin via
 * __setCartTestDb.
 *   Standalone: npx tsx src/services/cart-service-wishes.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCartServiceWishesTests(opts: { log?: boolean } = {}): TestSummary {
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

  function insertAgent(id: string, name: string) {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'test agent', 'test', ?, 'https://example.com', 'producer', ?)
    `).run(id, name, `${id}@example.com`, `key-${id}`);
  }

  function insertKnowledge(agentId: string, opts2: {
    verificationStatus?: string | null; verifiedSecondLine?: number | null;
    phone?: string | null; email?: string | null;
  } = {}) {
    db.prepare(`
      INSERT INTO agent_knowledge (agent_id, verification_status, verified_second_line, phone, email)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      agentId,
      opts2.verificationStatus ?? "verified",
      opts2.verifiedSecondLine ?? 0,
      opts2.phone ?? "+47 90000000",
      opts2.email ?? `${agentId}@example.com`
    );
  }

  function insertProduct(id: string, agentId: string, name: string) {
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source)
      VALUES (?, ?, ?, ?, 30, 'kg', 'in_stock', 'enrichment')
    `).run(id, agentId, name, name.toLowerCase());
  }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);

    // ── Fixtures ──────────────────────────────────────────────────────────
    insertAgent("agent-eligible", "Gard Eligible");
    insertKnowledge("agent-eligible");
    insertProduct("prod-potet", "agent-eligible", "Poteter");
    insertProduct("prod-egg", "agent-eligible", "Egg");
    // orch-pr-20260919-handleliste-slice2: submitCart()'s order/handoff
    // split now ALSO requires the full order-notify send-gate (opt_in=1 is
    // mandatory; a verified-contact-or-is_verified profile satisfies the
    // separate gate-3 clause — see isEligibleForRealOrder(), cart-service.ts)
    // — set opt_in here so this file's pre-existing "eligible producer's
    // chosen offer becomes a real order" scenarios keep testing the
    // WISH-mirroring mechanics they were written for, unentangled from that
    // separate, orthogonal gate.
    db.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = 'agent-eligible'").run();

    insertAgent("agent-contact-only", "Gard KontaktSelv");
    insertKnowledge("agent-contact-only", { verificationStatus: "verified", verifiedSecondLine: 1 }); // second-line only — never checkout-eligible

    insertAgent("agent-turns-ineligible", "Gard SnurIneligible");
    insertKnowledge("agent-turns-ineligible");
    insertProduct("prod-gulrot", "agent-turns-ineligible", "Gulrøtter");

    // ═══════════ addCartWish ═══════════

    {
      const cart = cartSvc.createCart();
      const bad1 = cartSvc.addCartWish(cart.cart_id, "", 2);
      assertTrue(bad1.success === false, "addCartWish: empty term rejected");
      const bad2 = cartSvc.addCartWish(cart.cart_id, "Poteter", 0);
      assertTrue(bad2.success === false, "addCartWish: qty<=0 rejected");
      const ok = cartSvc.addCartWish(cart.cart_id, "Poteter", 2, "kg");
      assertTrue(ok.success === true, "addCartWish: valid wish created");
      if (ok.success) {
        assertEq(ok.wish.term, "Poteter", "addCartWish: term stored");
        assertEq(ok.wish.qty, 2, "addCartWish: qty stored");
        assertEq(ok.wish.mode, null, "addCartWish: mode starts NULL (no choice yet)");
      }

      const missingCart = cartSvc.addCartWish("nonexistent", "Poteter", 1);
      assertTrue(missingCart.success === false && missingCart.status === 404, "addCartWish: 404 for unknown cart");
    }

    // ═══════════ chooseCartWishOffer — product_id path (order mode) ═══════

    {
      const cart = cartSvc.createCart();
      const w = cartSvc.addCartWish(cart.cart_id, "Poteter", 3, "kg");
      assertTrue(w.success === true, "setup: wish added");
      if (!w.success) throw new Error("setup failed");

      const chosen = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { productId: "prod-potet" });
      assertTrue(chosen.success === true, "chooseCartWishOffer: product_id path succeeds for eligible producer's product");
      if (chosen.success) {
        assertEq(chosen.wish.mode, "order", "chooseCartWishOffer: mode set to 'order'");
        assertEq(chosen.wish.chosen_product_id, "prod-potet", "chooseCartWishOffer: chosen_product_id stored");
        assertEq(chosen.wish.chosen_agent_id, null, "chooseCartWishOffer: chosen_agent_id stays NULL for order mode");
      }

      const mirroredItem = db.prepare("SELECT * FROM cart_items WHERE cart_id = ? AND product_id = 'prod-potet'").get(cart.cart_id) as any;
      assertTrue(!!mirroredItem, "chooseCartWishOffer: a mirroring cart_items row was upserted via addCartItem()");
      assertEq(mirroredItem?.qty, 3, "chooseCartWishOffer: mirrored cart_items row inherits the wish's qty");

      // Both product_id and agent_id together is rejected.
      const both = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { productId: "prod-potet", agentId: "agent-eligible" });
      assertTrue(both.success === false && both.status === 400, "chooseCartWishOffer: product_id + agent_id together rejected (400)");

      // Neither is rejected.
      const neither = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, {});
      assertTrue(neither.success === false && neither.status === 400, "chooseCartWishOffer: neither product_id nor agent_id rejected (400)");
    }

    // ═══════════ chooseCartWishOffer — agent_id + contact mode ════════════

    {
      const cart = cartSvc.createCart();
      const w = cartSvc.addCartWish(cart.cart_id, "Gulrøtter", 1, "pose");
      if (!w.success) throw new Error("setup failed");

      const badMode = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { agentId: "agent-contact-only", mode: "order" });
      assertTrue(badMode.success === false && badMode.status === 400, "chooseCartWishOffer: mode must be 'contact' when agent_id is given");

      const unknownAgent = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { agentId: "does-not-exist" });
      assertTrue(unknownAgent.success === false && unknownAgent.status === 404, "chooseCartWishOffer: unknown agent_id → 404");

      const chosen = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { agentId: "agent-contact-only" });
      assertTrue(chosen.success === true, "chooseCartWishOffer: agent_id (contact) path succeeds even for a NON-checkout-eligible (second-line-only) producer");
      if (chosen.success) {
        assertEq(chosen.wish.mode, "contact", "chooseCartWishOffer: mode set to 'contact'");
        assertEq(chosen.wish.chosen_agent_id, "agent-contact-only", "chooseCartWishOffer: chosen_agent_id stored");
      }
      const noItem = db.prepare("SELECT COUNT(*) as c FROM cart_items WHERE cart_id = ?").get(cart.cart_id) as any;
      assertEq(noItem.c, 0, "chooseCartWishOffer: contact mode creates NO cart_items row");
    }

    // ═══════════ Switching a wish's choice cleans up the old cart_items row ══

    {
      const cart = cartSvc.createCart();
      const w = cartSvc.addCartWish(cart.cart_id, "Poteter", 1);
      if (!w.success) throw new Error("setup failed");
      cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { productId: "prod-potet" });

      let count = (db.prepare("SELECT COUNT(*) as c FROM cart_items WHERE cart_id = ?").get(cart.cart_id) as any).c;
      assertEq(count, 1, "switch setup: one mirrored cart_items row exists after choosing prod-potet");

      // Switch the SAME wish to a contact producer instead.
      const switched = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { agentId: "agent-contact-only" });
      assertTrue(switched.success === true, "chooseCartWishOffer: switching product → contact succeeds");
      count = (db.prepare("SELECT COUNT(*) as c FROM cart_items WHERE cart_id = ?").get(cart.cart_id) as any).c;
      assertEq(count, 0, "chooseCartWishOffer: switching away from a product choice removes the old mirrored cart_items row (no dangling line)");
    }

    // ═══════════ deleteCartWish cleans up a linked cart_items row ═══════════

    {
      const cart = cartSvc.createCart();
      const w = cartSvc.addCartWish(cart.cart_id, "Egg", 1);
      if (!w.success) throw new Error("setup failed");
      cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { productId: "prod-egg" });

      const del = cartSvc.deleteCartWish(cart.cart_id, w.wish.id);
      assertTrue(del.success === true, "deleteCartWish: succeeds");
      const wishRow = db.prepare("SELECT * FROM cart_wishes WHERE id = ?").get(w.wish.id);
      assertTrue(!wishRow, "deleteCartWish: wish row removed");
      const itemCount = (db.prepare("SELECT COUNT(*) as c FROM cart_items WHERE cart_id = ?").get(cart.cart_id) as any).c;
      assertEq(itemCount, 0, "deleteCartWish: mirrored cart_items row removed too");

      const missing = cartSvc.deleteCartWish(cart.cart_id, "nope");
      assertTrue(missing.success === false && missing.status === 404, "deleteCartWish: 404 for unknown wish");
    }

    // ═══════════ REGRESSION (orch-pr-20260919-handleliste-slice1 fix-up): ═
    // ═══════════ reviewer's exact repro — two wishes choosing the SAME ════
    // ═══════════ product_id must NEVER silently clobber/delete each ═══════
    // ═══════════ other's cart_items row ════════════════════════════════════
    //
    // Reviewer's original repro (pre-fix): wish #1 = 2kg poteter, wish #2 =
    // 3kg poteter (same product), wish #1 switched to a different product →
    // cart_items ended up with only the new product, wish #2's 3kg poteter
    // line silently vanished even though cart_wishes still claimed it was
    // chosen — submitCart() would then succeed with that order line missing
    // entirely. Post-fix, the SECOND wish's attempt to choose an
    // already-claimed product_id is rejected outright (409) — the row can
    // never come to be "owned" by two wishes at once, so there is nothing
    // left for a later switch/delete to silently destroy.

    {
      const cart = cartSvc.createCart();
      const w1 = cartSvc.addCartWish(cart.cart_id, "Poteter", 2, "kg");
      const w2 = cartSvc.addCartWish(cart.cart_id, "Poteter", 3, "kg");
      if (!w1.success || !w2.success) throw new Error("setup failed");

      const chosen1 = cartSvc.chooseCartWishOffer(cart.cart_id, w1.wish.id, { productId: "prod-potet" });
      assertTrue(chosen1.success === true, "repro: wish #1 chooses prod-potet — succeeds");

      // The exact reviewer repro step: wish #2 independently chooses the
      // SAME product_id. Pre-fix this silently upserted, clobbering wish
      // #1's cart_items row. Post-fix it must be a clean 409, not a clobber.
      const chosen2 = cartSvc.chooseCartWishOffer(cart.cart_id, w2.wish.id, { productId: "prod-potet" });
      assertTrue(
        chosen2.success === false && chosen2.status === 409,
        "repro FIX: wish #2 choosing a product already claimed by wish #1 is rejected with 409, not silently upserted"
      );

      // wish #1's row must be completely untouched by wish #2's rejected attempt.
      const rowsAfterReject = db.prepare("SELECT id, wish_id, qty FROM cart_items WHERE cart_id = ?").all(cart.cart_id) as any[];
      assertEq(rowsAfterReject.length, 1, "repro FIX: exactly one cart_items row exists after the rejected second choice (no clobber, no duplicate)");
      assertEq(rowsAfterReject[0]?.wish_id, w1.wish.id, "repro FIX: the surviving row still belongs to wish #1");
      assertEq(rowsAfterReject[0]?.qty, 2, "repro FIX: wish #1's original qty (2) is unchanged — wish #2's qty (3) never overwrote it");

      // wish #2 itself must be untouched by its own rejected attempt (no
      // dangling chosen_product_id/mode despite the 409).
      const w2Row = db.prepare("SELECT chosen_product_id, mode FROM cart_wishes WHERE id = ?").get(w2.wish.id) as any;
      assertEq(w2Row?.chosen_product_id, null, "repro FIX: wish #2's chosen_product_id stays NULL after its rejected choice");
      assertEq(w2Row?.mode, null, "repro FIX: wish #2's mode stays NULL after its rejected choice");

      // Now perform the reviewer's actual "switch away" step: wish #1
      // switches to a different product. This must delete ONLY wish #1's
      // own row (by wish_id) — there is no wish #2 row to endanger, because
      // it was never created.
      const switched = cartSvc.chooseCartWishOffer(cart.cart_id, w1.wish.id, { productId: "prod-egg" });
      assertTrue(switched.success === true, "repro FIX: wish #1 switching away to prod-egg succeeds");

      const rowsAfterSwitch = db.prepare("SELECT id, wish_id, product_id, qty FROM cart_items WHERE cart_id = ?").all(cart.cart_id) as any[];
      assertEq(rowsAfterSwitch.length, 1, "repro FIX: exactly one cart_items row after wish #1 switches away (old prod-potet row removed, no dangling wish #2 row was ever there to lose)");
      assertEq(rowsAfterSwitch[0]?.product_id, "prod-egg", "repro FIX: surviving row is wish #1's new product");
      assertEq(rowsAfterSwitch[0]?.wish_id, w1.wish.id, "repro FIX: surviving row is still tagged to wish #1");

      // A cart submit at this point must produce exactly one order line
      // (2kg prod-egg for wish #1) — no missing/lost line, matching the
      // reviewer's concern that submitCart() would otherwise silently
      // succeed with an order line missing entirely.
      const sub = cartSvc.submitCart(cart.cart_id);
      assertTrue(sub.success === true, "repro FIX: submitCart succeeds after the switch");
      if (sub.success) {
        assertEq(sub.orders.length, 1, "repro FIX: exactly one order created");
        assertEq(sub.orders[0]?.total_nok, 60, "repro FIX: order total reflects wish #1's 2 qty * 30 price only — nothing silently lost or duplicated");
      }
    }

    // ═══════════ REGRESSION: two wishes on DIFFERENT products are fully ═══
    // ═══════════ independent — deleting one never touches the other's ═════
    // ═══════════ mirrored cart_items row (wish_id-scoped delete, not a ═════
    // ═══════════ bare product match) ════════════════════════════════════════

    {
      const cart = cartSvc.createCart();
      const wA = cartSvc.addCartWish(cart.cart_id, "Poteter", 2);
      const wB = cartSvc.addCartWish(cart.cart_id, "Egg", 5);
      if (!wA.success || !wB.success) throw new Error("setup failed");

      const chosenA = cartSvc.chooseCartWishOffer(cart.cart_id, wA.wish.id, { productId: "prod-potet" });
      const chosenB = cartSvc.chooseCartWishOffer(cart.cart_id, wB.wish.id, { productId: "prod-egg" });
      assertTrue(chosenA.success === true && chosenB.success === true, "independence setup: two wishes on different products both succeed");

      const del = cartSvc.deleteCartWish(cart.cart_id, wA.wish.id);
      assertTrue(del.success === true, "independence: deleting wish A succeeds");

      const remaining = db.prepare("SELECT wish_id, product_id, qty FROM cart_items WHERE cart_id = ?").all(cart.cart_id) as any[];
      assertEq(remaining.length, 1, "independence: exactly one cart_items row remains after deleting wish A");
      assertEq(remaining[0]?.wish_id, wB.wish.id, "independence: the remaining row belongs to wish B, untouched by wish A's deletion");
      assertEq(remaining[0]?.product_id, "prod-egg", "independence: wish B's product (egg) is unaffected");
      assertEq(remaining[0]?.qty, 5, "independence: wish B's qty (5) is unaffected");
    }

    // ═══════════ REGRESSION: a directly-added (non-wish) cart_items row is ═
    // ═══════════ also protected — a wish cannot silently steal it either ══

    {
      const cart = cartSvc.createCart();
      const direct = cartSvc.addCartItem(cart.cart_id, "prod-potet", 4);
      assertTrue(direct.success === true, "direct-item setup: plain addCartItem succeeds");

      const w = cartSvc.addCartWish(cart.cart_id, "Poteter", 1);
      if (!w.success) throw new Error("setup failed");
      const chosen = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { productId: "prod-potet" });
      assertTrue(chosen.success === false && chosen.status === 409, "direct-item protection: a wish choosing a product already directly in the cart is rejected (409), not silently merged/overwritten");

      const rows = db.prepare("SELECT wish_id, qty FROM cart_items WHERE cart_id = ?").all(cart.cart_id) as any[];
      assertEq(rows.length, 1, "direct-item protection: still exactly one cart_items row");
      assertEq(rows[0]?.wish_id, null, "direct-item protection: the directly-added row's wish_id is still NULL — untouched");
      assertEq(rows[0]?.qty, 4, "direct-item protection: the directly-added row's qty (4) is unchanged");
    }

    // ═══════════ submitCart: eligible producer's chosen offer → real order ═

    {
      const cart = cartSvc.createCart();
      const w = cartSvc.addCartWish(cart.cart_id, "Poteter", 2);
      if (!w.success) throw new Error("setup failed");
      cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { productId: "prod-potet" });

      const sub = cartSvc.submitCart(cart.cart_id);
      assertTrue(sub.success === true, "submitCart: cart with an eligible chosen offer submits successfully");
      if (sub.success) {
        assertEq(sub.orders.length, 1, "submitCart: exactly one order created for the eligible producer");
        assertEq(sub.orders[0]?.agent_id, "agent-eligible", "submitCart: order belongs to the eligible producer");
        assertEq(sub.contact_handoffs.length, 0, "submitCart: no contact_handoffs for a fully-eligible submit");
      }
    }

    // ═══════════ submitCart: contact-mode wish → handoff, no order, ═══════
    // ═══════════ cart_handoffs row with no PII ═════════════════════════════

    {
      const cart = cartSvc.createCart();
      const w = cartSvc.addCartWish(cart.cart_id, "Gulrøtter", 4, "kg");
      if (!w.success) throw new Error("setup failed");
      cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { agentId: "agent-contact-only" });

      const sub = cartSvc.submitCart(cart.cart_id, {
        buyer_name: "Kari Nordmann",
        buyer_email: "kari@example.com",
        buyer_phone: "+47 91234567",
        delivery_note: "Ring på døra",
        contact_consent: true,
      });
      assertTrue(sub.success === true, "submitCart: contact-only cart submits successfully (not 'empty')");
      if (sub.success) {
        assertEq(sub.orders.length, 0, "submitCart: NO order created for a contact-mode-only cart");
        assertEq(sub.contact_handoffs.length, 1, "submitCart: exactly one contact_handoffs entry");
        const h = sub.contact_handoffs[0]!;
        assertEq(h.agent_id, "agent-contact-only", "submitCart: handoff is for the chosen contact producer");
        assertTrue(h.message.includes("Gulrøtter") && h.message.includes("4"), "submitCart: handoff message lists the wish's item/qty");
        assertTrue(!h.message.includes("Kari") && !h.message.includes("kari@example.com") && !h.message.includes("91234567"), "submitCart: handoff message contains NO buyer contact info");
      }

      const handoffRows = db.prepare("SELECT * FROM cart_handoffs WHERE cart_id = ?").all(cart.cart_id) as any[];
      assertEq(handoffRows.length, 1, "submitCart: exactly one cart_handoffs analytics row written");
      assertEq(handoffRows[0]?.agent_id, "agent-contact-only", "cart_handoffs: correct agent_id");
      assertEq(handoffRows[0]?.item_count, 1, "cart_handoffs: item_count reflects the one wish line");
      const handoffCols = handoffRows[0] ? Object.keys(handoffRows[0]).sort() : [];
      assertEq(handoffCols, ["agent_id", "cart_id", "created_at", "id", "item_count"], "cart_handoffs: columns are exactly id/agent_id/cart_id/item_count/created_at — no PII column exists to leak");

      const cartRow = db.prepare("SELECT buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at FROM carts WHERE id = ?").get(cart.cart_id) as any;
      assertEq(cartRow.buyer_name, "Kari Nordmann", "submitCart: buyer_name persisted on the cart");
      assertEq(cartRow.buyer_email, "kari@example.com", "submitCart: buyer_email persisted on the cart");
      assertTrue(!!cartRow.contact_consent_at, "submitCart: contact_consent_at set when contact_consent=true");
    }

    // ═══════════ submitCart: contact_consent=false/omitted never sets ═════
    // ═══════════ contact_consent_at, even if other contact fields given ═══

    {
      const cart = cartSvc.createCart();
      const w = cartSvc.addCartWish(cart.cart_id, "Egg", 1);
      if (!w.success) throw new Error("setup failed");
      cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { agentId: "agent-contact-only" });

      const sub = cartSvc.submitCart(cart.cart_id, { buyer_name: "Ola Nordmann", contact_consent: false });
      assertTrue(sub.success === true, "submitCart: submits fine without consent");
      const cartRow = db.prepare("SELECT contact_consent_at FROM carts WHERE id = ?").get(cart.cart_id) as any;
      assertEq(cartRow.contact_consent_at, null, "submitCart: contact_consent_at stays NULL when contact_consent is false");
    }

    // ═══════════ submitCart: producer eligible at add-time but turns ══════
    // ═══════════ INELIGIBLE by submit time → handoff, not an order ════════

    {
      const cart = cartSvc.createCart();
      const w = cartSvc.addCartWish(cart.cart_id, "Gulrøtter", 2);
      if (!w.success) throw new Error("setup failed");
      const chosen = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { productId: "prod-gulrot" });
      assertTrue(chosen.success === true, "setup: agent-turns-ineligible was eligible at choose-time");

      // Revoke eligibility between choose and submit (e.g. a verification
      // flip) — isProducerEligible() itself is untouched, only the DB state.
      db.prepare("UPDATE agent_knowledge SET verification_status = 'pending' WHERE agent_id = ?").run("agent-turns-ineligible");
      assertTrue(cartSvc.isProducerEligible("agent-turns-ineligible") === false, "setup: isProducerEligible() now correctly reports false");

      const sub = cartSvc.submitCart(cart.cart_id);
      assertTrue(sub.success === true, "submitCart: still submits successfully (re-check demotes to handoff, does not fail submit)");
      if (sub.success) {
        assertEq(sub.orders.length, 0, "submitCart: no order for the now-ineligible producer");
        assertEq(sub.contact_handoffs.length, 1, "submitCart: one contact_handoffs entry for the now-ineligible producer");
        assertEq(sub.contact_handoffs[0]?.agent_id, "agent-turns-ineligible", "submitCart: handoff is for the correct producer");
      }
      const handoffRows = db.prepare("SELECT * FROM cart_handoffs WHERE cart_id = ?").all(cart.cart_id) as any[];
      assertEq(handoffRows.length, 1, "submitCart: cart_handoffs row written for the ineligible-at-submit producer too");
    }

    // ═══════════ REGRESSION: fase-1 flow (no wishes at all) unchanged ═════

    {
      const cart = cartSvc.createCart();
      const add = cartSvc.addCartItem(cart.cart_id, "prod-potet", 2);
      assertTrue(add.success === true, "regression setup: plain addCartItem still works with no wishes involved");

      const sub = cartSvc.submitCart(cart.cart_id);
      assertTrue(sub.success === true, "regression: fase-1 submit (no wishes) still succeeds");
      if (sub.success) {
        assertEq(sub.orders.length, 1, "regression: exactly one order, same as before Slice 1");
        assertEq(sub.orders[0]?.agent_id, "agent-eligible", "regression: order for the correct producer");
        assertEq(sub.contact_handoffs, [], "regression: contact_handoffs is an empty array, never undefined, when no wishes are involved");
      }
      const wishCount = (db.prepare("SELECT COUNT(*) as c FROM cart_wishes WHERE cart_id = ?").get(cart.cart_id) as any).c;
      assertEq(wishCount, 0, "regression: no cart_wishes rows were created by the plain item-based flow");
    }

    // ═══════════ submitCart: empty cart (no items, no wishes) still 400 ═══

    {
      const cart = cartSvc.createCart();
      const sub = cartSvc.submitCart(cart.cart_id);
      assertTrue(sub.success === false, "submitCart: a truly empty cart (no items, no wishes) is still rejected");
      if (!sub.success) assertEq(sub.status, 400, "submitCart: empty-cart rejection is a 400");
    }
  } finally {
    cartSvc.__setCartTestDb(null);
    initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runCartServiceWishesTests({ log: true });
  console.log(`\ncart-service-wishes: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
