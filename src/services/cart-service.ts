/**
 * Cart Service — Phase 1 cart MVP ("handleliste")
 *
 * Shared logic consumed by both REST routes and MCP tools so there is
 * no duplication between the two interfaces.
 *
 * Design notes:
 *  - No payment: submit creates orders but makes no charge.
 *  - No seller notification: internal-only for Phase 1.
 *  - Anonymous buyer: capability-token model (buyer_ref).
 *  - Pickup only: no delivery address.
 *  - Products must be from verified, non-umbrella producers.
 *  - Availability is checked on add AND re-checked on submit.
 */

import { randomUUID, randomBytes } from "crypto";
import { getDb } from "../database/init";
import { recordTrustEvent } from "./trust-event-service";
import { sendOrderNotificationForOrder, OrderNotificationInput } from "./order-notify-service";

// ─── Test-DB override (module-local, race-proof) ─────────────────────────────
// In production _cartTestDb is always null → getDb() is used as normal.
// Tests call __setCartTestDb(db) to pin a specific in-memory DB for cart
// operations WITHOUT touching the global __setDbForTesting singleton, so
// concurrent test blocks that re-pin the global cannot clobber this handle.
let _cartTestDb: any = null;
export function __setCartTestDb(db: any): void { _cartTestDb = db; }

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CartItem {
  id: string;
  cart_id: string;
  product_id: string;
  agent_id: string;
  qty: number;
  unit_price_snapshot: number | null;
  line_note: string | null;
  added_at: string;
  // Joined from products/agents for view
  product_name?: string;
  unit?: string | null;
  producer_name?: string;
}

export interface CartGroup {
  agent_id: string;
  producer_name: string;
  items: Array<{
    id: string;
    product_id: string;
    product_name: string;
    unit: string | null;
    qty: number;
    unit_price_snapshot: number | null;
    line_total: number | null;
    line_note: string | null;
  }>;
  subtotal_nok: number;
}

export interface CartView {
  success: true;
  cart_id: string;
  status: string;
  groups: CartGroup[];
  total_nok: number;
  item_count: number;
}

export interface OrderSummary {
  order_id: string;
  agent_id: string;
  producer_name: string;
  total_nok: number;
  status: string;
}

// ─── Token generation ───────────────────────────────────────────────────────

export function generateBuyerRef(): string {
  return "bref_" + randomBytes(24).toString("hex");
}

export function generateConfirmToken(): string {
  return "ctok_" + randomBytes(16).toString("hex");
}

// ─── Producer eligibility check ─────────────────────────────────────────────
// A product can only be added to a cart if its producer is verified and
// non-umbrella — mirrors the catalog feed filter.

export function isProducerEligible(agentId: string): boolean {
  const db = _cartTestDb ?? getDb();
  const row = db.prepare(`
    SELECT 1 FROM agents a
    INNER JOIN agent_knowledge k ON k.agent_id = a.id
    WHERE a.id = ?
      AND a.umbrella_type IS NULL
      AND k.verification_status = 'verified'
  `).get(agentId);
  return !!row;
}

// ─── Create cart ─────────────────────────────────────────────────────────────

export function createCart(): { cart_id: string; buyer_ref: string } {
  const db = _cartTestDb ?? getDb();
  const cart_id = randomUUID();
  const buyer_ref = generateBuyerRef();
  // Carts expire after 7 days
  const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO carts (id, buyer_ref, buyer_kind, status, currency, created_at, updated_at, expires_at)
    VALUES (?, ?, 'platform_agent', 'open', 'NOK', datetime('now'), datetime('now'), ?)
  `).run(cart_id, buyer_ref, expires_at);

  return { cart_id, buyer_ref };
}

// ─── Token check ─────────────────────────────────────────────────────────────

export type TokenCheckResult =
  | { ok: true; cart: { id: string; status: string; buyer_ref: string } }
  | { ok: false; status: number; error: string };

export function checkCartToken(
  cartId: string,
  token: string | undefined
): TokenCheckResult {
  if (!token) {
    return { ok: false, status: 403, error: "Missing buyer token (X-Cart-Token header or buyer_ref body field)" };
  }

  const db = _cartTestDb ?? getDb();
  const cart = db.prepare(
    "SELECT id, status, buyer_ref FROM carts WHERE id = ?"
  ).get(cartId) as { id: string; status: string; buyer_ref: string } | undefined;

  if (!cart) {
    return { ok: false, status: 404, error: "Cart not found" };
  }

  if (cart.buyer_ref !== token) {
    return { ok: false, status: 403, error: "Invalid buyer token" };
  }

  return { ok: true, cart };
}

// ─── Add / upsert item ───────────────────────────────────────────────────────

export type AddItemResult =
  | { success: true; item: CartItem }
  | { success: false; status: number; error: string };

export function addCartItem(
  cartId: string,
  productId: string,
  qty: number,
  note?: string | null
): AddItemResult {
  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, status: 400, error: "qty must be a positive integer" };
  }

  const db = _cartTestDb ?? getDb();

  // Verify cart exists and is open (token already checked by caller)
  const cart = db.prepare("SELECT id, status FROM carts WHERE id = ?").get(cartId) as
    | { id: string; status: string }
    | undefined;
  if (!cart) return { success: false, status: 404, error: "Cart not found" };
  if (cart.status !== "open") {
    return { success: false, status: 409, error: `Cart is ${cart.status}, cannot add items` };
  }

  // Verify product
  const product = db.prepare(`
    SELECT p.id, p.agent_id, p.availability, p.price_nok
    FROM products p
    WHERE p.id = ?
  `).get(productId) as
    | { id: string; agent_id: string; availability: string; price_nok: number | null }
    | undefined;

  if (!product) return { success: false, status: 404, error: "Product not found" };
  if (product.availability !== "in_stock") {
    return { success: false, status: 409, error: `Product is not in stock (availability: ${product.availability})` };
  }

  // Verify producer eligibility
  if (!isProducerEligible(product.agent_id)) {
    return {
      success: false,
      status: 403,
      error: "Product producer is not verified or is an umbrella — only products from discoverable producers can be added",
    };
  }

  // Upsert: UNIQUE(cart_id, product_id) means re-adding updates qty
  const itemId = randomUUID();
  db.prepare(`
    INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot, line_note, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(cart_id, product_id) DO UPDATE SET
      qty                  = excluded.qty,
      unit_price_snapshot  = excluded.unit_price_snapshot,
      line_note            = COALESCE(excluded.line_note, cart_items.line_note),
      added_at             = datetime('now')
  `).run(itemId, cartId, productId, product.agent_id, qty, product.price_nok, note ?? null);

  // Update cart timestamp
  db.prepare("UPDATE carts SET updated_at = datetime('now') WHERE id = ?").run(cartId);

  // Return the upserted item
  const item = db.prepare(
    "SELECT * FROM cart_items WHERE cart_id = ? AND product_id = ?"
  ).get(cartId, productId) as CartItem;

  return { success: true, item };
}

// ─── Update item qty ─────────────────────────────────────────────────────────

export type UpdateItemResult =
  | { success: true; deleted?: boolean }
  | { success: false; status: number; error: string };

export function updateCartItem(
  cartId: string,
  itemId: string,
  qty: number
): UpdateItemResult {
  const db = _cartTestDb ?? getDb();

  const item = db.prepare(
    "SELECT id, cart_id FROM cart_items WHERE id = ? AND cart_id = ?"
  ).get(itemId, cartId) as { id: string; cart_id: string } | undefined;

  if (!item) return { success: false, status: 404, error: "Item not found in cart" };

  // orch-pr-20260614-6 review nit #3: items are only mutable while the cart is open.
  const ucStatus = db.prepare("SELECT status FROM carts WHERE id = ?").get(cartId) as { status: string } | undefined;
  if (ucStatus && ucStatus.status !== "open") {
    return { success: false, status: 409, error: `Cart is ${ucStatus.status}; items can only be changed while open` };
  }

  if (qty <= 0) {
    db.prepare("DELETE FROM cart_items WHERE id = ?").run(itemId);
    db.prepare("UPDATE carts SET updated_at = datetime('now') WHERE id = ?").run(cartId);
    return { success: true, deleted: true };
  }

  db.prepare("UPDATE cart_items SET qty = ? WHERE id = ?").run(qty, itemId);
  db.prepare("UPDATE carts SET updated_at = datetime('now') WHERE id = ?").run(cartId);
  return { success: true };
}

// ─── Delete item ─────────────────────────────────────────────────────────────

export function deleteCartItem(
  cartId: string,
  itemId: string
): UpdateItemResult {
  const db = _cartTestDb ?? getDb();

  const item = db.prepare(
    "SELECT id FROM cart_items WHERE id = ? AND cart_id = ?"
  ).get(itemId, cartId) as { id: string } | undefined;

  if (!item) return { success: false, status: 404, error: "Item not found in cart" };

  // orch-pr-20260614-6 review nit #3: items are only mutable while the cart is open.
  const dcStatus = db.prepare("SELECT status FROM carts WHERE id = ?").get(cartId) as { status: string } | undefined;
  if (dcStatus && dcStatus.status !== "open") {
    return { success: false, status: 409, error: `Cart is ${dcStatus.status}; items can only be changed while open` };
  }

  db.prepare("DELETE FROM cart_items WHERE id = ?").run(itemId);
  db.prepare("UPDATE carts SET updated_at = datetime('now') WHERE id = ?").run(cartId);
  return { success: true, deleted: true };
}

// ─── View cart ───────────────────────────────────────────────────────────────

export function viewCart(cartId: string): CartView | null {
  const db = _cartTestDb ?? getDb();

  const cart = db.prepare("SELECT id, status FROM carts WHERE id = ?").get(cartId) as
    | { id: string; status: string }
    | undefined;
  if (!cart) return null;

  const rows = db.prepare(`
    SELECT
      ci.id,
      ci.product_id,
      ci.agent_id,
      ci.qty,
      ci.unit_price_snapshot,
      ci.line_note,
      ci.added_at,
      p.name   AS product_name,
      p.unit   AS unit,
      a.name   AS producer_name
    FROM cart_items ci
    INNER JOIN products p ON p.id = ci.product_id
    INNER JOIN agents   a ON a.id = ci.agent_id
    WHERE ci.cart_id = ?
    ORDER BY ci.agent_id, ci.added_at
  `).all(cartId) as Array<{
    id: string;
    product_id: string;
    agent_id: string;
    qty: number;
    unit_price_snapshot: number | null;
    line_note: string | null;
    added_at: string;
    product_name: string;
    unit: string | null;
    producer_name: string;
  }>;

  // Group by producer
  const groupMap = new Map<string, CartGroup>();
  for (const r of rows) {
    if (!groupMap.has(r.agent_id)) {
      groupMap.set(r.agent_id, {
        agent_id: r.agent_id,
        producer_name: r.producer_name,
        items: [],
        subtotal_nok: 0,
      });
    }
    const group = groupMap.get(r.agent_id)!;
    const line_total =
      r.unit_price_snapshot != null ? r.unit_price_snapshot * r.qty : null;
    group.items.push({
      id: r.id,
      product_id: r.product_id,
      product_name: r.product_name,
      unit: r.unit,
      qty: r.qty,
      unit_price_snapshot: r.unit_price_snapshot,
      line_total,
      line_note: r.line_note,
    });
    if (line_total != null) group.subtotal_nok += line_total;
  }

  const groups = Array.from(groupMap.values());
  const total_nok = groups.reduce((s, g) => s + g.subtotal_nok, 0);
  const item_count = rows.length;

  return { success: true, cart_id: cartId, status: cart.status, groups, total_nok, item_count };
}

// ─── Submit cart ─────────────────────────────────────────────────────────────

export type SubmitResult =
  | { success: true; orders: OrderSummary[] }
  | { success: false; status: number; error: string; unavailable?: Array<{ product_id: string; product_name: string; availability: string }> };

export function submitCart(cartId: string): SubmitResult {
  const db = _cartTestDb ?? getDb();

  const cart = db.prepare("SELECT id, status FROM carts WHERE id = ?").get(cartId) as
    | { id: string; status: string }
    | undefined;
  if (!cart) return { success: false, status: 404, error: "Cart not found" };
  if (cart.status !== "open") {
    return { success: false, status: 409, error: `Cart is already ${cart.status}` };
  }

  const items = db.prepare(`
    SELECT
      ci.id,
      ci.product_id,
      ci.agent_id,
      ci.qty,
      ci.unit_price_snapshot,
      ci.line_note,
      p.name        AS product_name,
      p.unit        AS unit,
      p.availability AS availability,
      a.name        AS producer_name
    FROM cart_items ci
    INNER JOIN products p ON p.id = ci.product_id
    INNER JOIN agents   a ON a.id = ci.agent_id
    WHERE ci.cart_id = ?
  `).all(cartId) as Array<{
    id: string;
    product_id: string;
    agent_id: string;
    qty: number;
    unit_price_snapshot: number | null;
    line_note: string | null;
    product_name: string;
    unit: string | null;
    availability: string;
    producer_name: string;
  }>;

  if (!items.length) {
    return { success: false, status: 400, error: "Cart is empty" };
  }

  // Re-check availability for every item (mandatory per spec)
  const unavailable = items.filter(i => i.availability !== "in_stock");
  if (unavailable.length > 0) {
    return {
      success: false,
      status: 409,
      error: `${unavailable.length} item(s) are no longer available`,
      unavailable: unavailable.map(i => ({
        product_id: i.product_id,
        product_name: i.product_name,
        availability: i.availability,
      })),
    };
  }

  // Split items by agent_id
  const byAgent = new Map<string, typeof items>();
  for (const item of items) {
    if (!byAgent.has(item.agent_id)) byAgent.set(item.agent_id, []);
    byAgent.get(item.agent_id)!.push(item);
  }

  const buyer_ref = (db.prepare("SELECT buyer_ref FROM carts WHERE id = ?").get(cartId) as any).buyer_ref;

  const orderSummaries: OrderSummary[] = [];
  const pendingNotifications: OrderNotificationInput[] = [];

  // Transaction: set cart submitted + create one order per producer
  const tx = db.transaction(() => {
    db.prepare("UPDATE carts SET status = 'submitted', updated_at = datetime('now') WHERE id = ?").run(cartId);

    for (const [agent_id, agentItems] of byAgent) {
      const order_id = randomUUID();
      const confirm_token = generateConfirmToken();
      const total_nok = agentItems.reduce((s, i) => {
        return s + (i.unit_price_snapshot != null ? i.unit_price_snapshot * i.qty : 0);
      }, 0);
      const producer_name = agentItems[0]!.producer_name;

      db.prepare(`
        INSERT INTO orders
          (id, cart_id, agent_id, buyer_ref, status, fulfilment, pickup_time,
           total_nok, confirm_token, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, 'pending', 'pickup', NULL, ?, ?, datetime('now'), datetime('now'))
      `).run(order_id, cartId, agent_id, buyer_ref, total_nok, confirm_token);

      for (const item of agentItems) {
        const line_total =
          item.unit_price_snapshot != null ? item.unit_price_snapshot * item.qty : null;
        db.prepare(`
          INSERT INTO order_items
            (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total)
          VALUES
            (?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          order_id,
          item.product_id,
          item.product_name,
          item.qty,
          item.unit_price_snapshot,
          line_total
        );
      }

      orderSummaries.push({
        order_id,
        agent_id,
        producer_name,
        total_nok,
        status: "pending",
      });

      pendingNotifications.push({
        order_id,
        agent_id,
        producer_name,
        buyer_ref,
        confirm_token,
        pickup_time: null,
        total_nok,
        items: agentItems.map((i) => ({ name: i.product_name, qty: i.qty, unit: i.unit })),
      });
    }
  });

  try {
    tx();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, status: 500, error: `Submit failed: ${msg}` };
  }

  // ─── Seller notification (dev-request 2026-07-13-pilot-ordre-loop) ──────
  // Fire-and-forget per created order, AFTER the transaction committed. The
  // send path is hard-gated per producer (opt-in + verified contact +
  // suppression — see order-notify-service.ts); a skipped or failed send
  // must NEVER fail the submit itself, so nothing here is awaited and every
  // rejection is swallowed after logging. No charge — pickup only.
  for (const notif of pendingNotifications) {
    void sendOrderNotificationForOrder(notif).catch((err) => {
      console.error(`[order-notify] unexpected rejection order=${notif.order_id}:`, err);
    });
  }

  return { success: true, orders: orderSummaries };
}

// ─── Get order ───────────────────────────────────────────────────────────────

export type OrderView =
  | {
      success: true;
      order_id: string;
      cart_id: string | null;
      agent_id: string;
      producer_name: string;
      status: string;
      cancel_reason: string | null;
      fulfilment: string;
      pickup_time: string | null;
      total_nok: number | null;
      items: Array<{
        id: string;
        product_id: string | null;
        name_snapshot: string | null;
        qty: number | null;
        unit_price_snapshot: number | null;
        line_total: number | null;
      }>;
      // Status timeline (order_events) — pilot-ordre-loop. Empty until the
      // first transition happens.
      timeline: OrderEvent[];
    }
  | { success: false; status: number; error: string };

export function getOrder(orderId: string, buyerRef: string): OrderView {
  const db = _cartTestDb ?? getDb();

  const order = db.prepare(`
    SELECT o.id, o.cart_id, o.agent_id, o.buyer_ref, o.status, o.cancel_reason, o.fulfilment,
           o.pickup_time, o.total_nok, a.name AS producer_name
    FROM orders o
    INNER JOIN agents a ON a.id = o.agent_id
    WHERE o.id = ?
  `).get(orderId) as
    | {
        id: string;
        cart_id: string | null;
        agent_id: string;
        buyer_ref: string;
        status: string;
        cancel_reason: string | null;
        fulfilment: string;
        pickup_time: string | null;
        total_nok: number | null;
        producer_name: string;
      }
    | undefined;

  if (!order) return { success: false, status: 404, error: "Order not found" };
  if (order.buyer_ref !== buyerRef) {
    return { success: false, status: 403, error: "Invalid buyer token" };
  }

  const orderItems = db.prepare(`
    SELECT id, product_id, name_snapshot, qty, unit_price_snapshot, line_total
    FROM order_items
    WHERE order_id = ?
    ORDER BY rowid
  `).all(orderId) as Array<{
    id: string;
    product_id: string | null;
    name_snapshot: string | null;
    qty: number | null;
    unit_price_snapshot: number | null;
    line_total: number | null;
  }>;

  return {
    success: true,
    order_id: order.id,
    cart_id: order.cart_id,
    agent_id: order.agent_id,
    producer_name: order.producer_name,
    status: order.status,
    cancel_reason: order.cancel_reason,
    fulfilment: order.fulfilment,
    pickup_time: order.pickup_time,
    total_nok: order.total_nok,
    items: orderItems,
    timeline: getOrderTimeline(order.id),
  };
}

// ─── Order lifecycle transitions ─────────────────────────────────────────────
// dev-request 2026-07-13-pilot-ordre-loop: every legal transition appends an
// order_events row (the buyer/seller-visible timeline) and terminal outcomes
// write trust-ledger events (trust-event-service). `ready → cancelled` is the
// producer "no-show" path and stores cancel_reason='no_show'.

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending:   ["confirmed", "declined"],
  confirmed: ["ready", "cancelled"],
  ready:     ["completed", "cancelled"],
  declined:  [],
  completed: [],
  cancelled: [],
};

export type TransitionResult =
  | { success: true; order_id: string; status: string }
  | { success: false; status: number; error: string };

export function transitionOrder(
  orderId: string,
  toStatus: string,
  opts?: { actor?: string; cancelReason?: string | null }
): TransitionResult {
  const db = _cartTestDb ?? getDb();

  const order = db.prepare("SELECT id, status, agent_id FROM orders WHERE id = ?").get(orderId) as
    | { id: string; status: string; agent_id: string }
    | undefined;

  if (!order) return { success: false, status: 404, error: "Order not found" };

  const allowed = VALID_TRANSITIONS[order.status] ?? [];
  if (!allowed.includes(toStatus)) {
    return {
      success: false,
      status: 409,
      error: `Cannot transition order from '${order.status}' to '${toStatus}'. Allowed: ${allowed.join(", ") || "none"}`,
    };
  }

  const cancelReason = toStatus === "cancelled" ? (opts?.cancelReason ?? null) : null;
  const actor = opts?.actor ?? null;

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE orders SET status = ?, cancel_reason = COALESCE(?, cancel_reason), updated_at = datetime('now') WHERE id = ?"
    ).run(toStatus, cancelReason, orderId);
    db.prepare(`
      INSERT INTO order_events (id, order_id, from_status, to_status, actor, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(randomUUID(), orderId, order.status, toStatus, actor);
  });

  try {
    tx();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, status: 500, error: `Transition failed: ${msg}` };
  }

  // Trust-ledger: terminal outcomes only. recordTrustEvent never throws.
  if (toStatus === "completed") {
    recordTrustEvent({ agentId: order.agent_id, eventType: "order_completed", ref: orderId });
  } else if (toStatus === "declined") {
    recordTrustEvent({ agentId: order.agent_id, eventType: "order_declined", ref: orderId });
  } else if (toStatus === "cancelled" && cancelReason === "no_show") {
    recordTrustEvent({ agentId: order.agent_id, eventType: "order_no_show", ref: orderId });
  }

  return { success: true, order_id: orderId, status: toStatus };
}

// ─── Order timeline (order_events) ───────────────────────────────────────────

export interface OrderEvent {
  from_status: string | null;
  to_status: string;
  actor: string | null;
  created_at: string;
}

export function getOrderTimeline(orderId: string): OrderEvent[] {
  const db = _cartTestDb ?? getDb();
  try {
    return db.prepare(`
      SELECT from_status, to_status, actor, created_at
      FROM order_events
      WHERE order_id = ?
      ORDER BY created_at, rowid
    `).all(orderId) as OrderEvent[];
  } catch {
    // Defensive: a DB without the order_events table (minimal test schema)
    // degrades to an empty timeline instead of breaking order reads.
    return [];
  }
}

// ─── Producer-side order lookup (tokenized confirm link) ─────────────────────
// The confirm_token is the PRODUCER's capability for this order — it arrives
// only in the seller-notification email (routes/marketplace-cart.ts renders
// the /produsent/ordre/:token PRG page on top of this).

export interface ProducerOrderView {
  order_id: string;
  agent_id: string;
  producer_name: string;
  status: string;
  cancel_reason: string | null;
  fulfilment: string;
  pickup_time: string | null;
  total_nok: number | null;
  buyer_ref: string;
  created_at: string;
  items: Array<{
    name_snapshot: string | null;
    qty: number | null;
    unit_price_snapshot: number | null;
    line_total: number | null;
  }>;
  timeline: OrderEvent[];
}

export function getOrderByConfirmToken(token: string): ProducerOrderView | null {
  if (!token) return null;
  const db = _cartTestDb ?? getDb();

  const order = db.prepare(`
    SELECT o.id, o.agent_id, o.status, o.cancel_reason, o.fulfilment, o.pickup_time,
           o.total_nok, o.buyer_ref, o.created_at, a.name AS producer_name
    FROM orders o
    INNER JOIN agents a ON a.id = o.agent_id
    WHERE o.confirm_token = ?
  `).get(token) as
    | {
        id: string; agent_id: string; status: string; cancel_reason: string | null;
        fulfilment: string; pickup_time: string | null; total_nok: number | null;
        buyer_ref: string; created_at: string; producer_name: string;
      }
    | undefined;

  if (!order) return null;

  const items = db.prepare(`
    SELECT name_snapshot, qty, unit_price_snapshot, line_total
    FROM order_items WHERE order_id = ? ORDER BY rowid
  `).all(order.id) as ProducerOrderView["items"];

  return {
    order_id: order.id,
    agent_id: order.agent_id,
    producer_name: order.producer_name,
    status: order.status,
    cancel_reason: order.cancel_reason,
    fulfilment: order.fulfilment,
    pickup_time: order.pickup_time,
    total_nok: order.total_nok,
    buyer_ref: order.buyer_ref,
    created_at: order.created_at,
    items,
    timeline: getOrderTimeline(order.id),
  };
}
