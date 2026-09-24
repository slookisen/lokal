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
import { computeEffectiveAvailability } from "./supply-graph";
import { knowledgeService } from "./knowledge-service";
import { slugify } from "../utils/slug";

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
  // orch-pr-20260919-handleliste-slice1 fix-up: NULL for items added
  // directly (not via a wish). Set/read only by the cart_wishes machinery
  // below — see chooseCartWishOffer()/deleteCartWish().
  wish_id?: string | null;
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
//
// dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel (fix-up,
// code-review CHANGES-REQUESTED on 36580f2b): verified_second_line=1 is a
// deliberately lower bar meant to unlock OUTREACH/CONTACT only — it is NOT
// sufficient for real customer checkout. Exclude it here explicitly so
// second-line-only producers cannot receive real orders.

export function isProducerEligible(agentId: string): boolean {
  const db = _cartTestDb ?? getDb();
  const row = db.prepare(`
    SELECT 1 FROM agents a
    INNER JOIN agent_knowledge k ON k.agent_id = a.id
    WHERE a.id = ?
      AND a.umbrella_type IS NULL
      AND k.verification_status = 'verified'
      AND (k.verified_second_line IS NULL OR k.verified_second_line = 0)
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
    "SELECT id, status, buyer_ref, expires_at FROM carts WHERE id = ?"
  ).get(cartId) as { id: string; status: string; buyer_ref: string; expires_at: string | null } | undefined;

  if (!cart) {
    return { ok: false, status: 404, error: "Cart not found" };
  }

  if (cart.buyer_ref !== token) {
    return { ok: false, status: 403, error: "Invalid buyer token" };
  }

  // dev-request 2026-09-24-mcp-rate-limit-og-personvern-sannhet, C3:
  // createCart() has always written expires_at (7 days out) but nothing
  // ever READ it — the lokal_cart_create tool description promises "valid
  // for 7 days" (src/routes/mcp.ts, out of scope for this PR to reword) with
  // nothing actually enforcing that promise. Every cart mutation/read in
  // both the REST router (marketplace-cart.ts) and the MCP tools (mcp.ts)
  // calls checkCartToken() first, so enforcing it here makes the promise
  // true everywhere in one place. Checked AFTER the token match above so a
  // caller presenting the WRONG token still gets a plain "invalid token"
  // (403), never an "expired" hint that would leak whether a given cart id
  // exists/has expired to someone who can't prove they own it. A NULL
  // expires_at (there are no such rows in production — createCart() always
  // sets it — but the column is nullable and some pre-Slice-1 test fixtures
  // omit it) is treated as "no expiry", not as already-expired.
  if (cart.expires_at && new Date(cart.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 410, error: "Cart has expired" };
  }

  return { ok: true, cart: { id: cart.id, status: cart.status, buyer_ref: cart.buyer_ref } };
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
    SELECT p.id, p.agent_id, p.availability, p.price_nok, p.availability_source, p.availability_updated_at
    FROM products p
    WHERE p.id = ?
  `).get(productId) as
    | {
        id: string;
        agent_id: string;
        availability: string;
        price_nok: number | null;
        availability_source: string;
        availability_updated_at: string | null;
      }
    | undefined;

  if (!product) return { success: false, status: 404, error: "Product not found" };

  // dev-request 2026-07-13-supply-graph-v1 (salvage slice): gate on the
  // EFFECTIVE availability (staleness-checked), not the raw column — a
  // producer_dashboard-sourced value that's gone stale (>14 days, see
  // supply-graph.ts) must degrade to 'unknown' and be rejected here, not
  // silently trusted forever. Enrichment-sourced rows are unaffected.
  const effectiveAvailability = computeEffectiveAvailability(
    product.availability,
    product.availability_updated_at,
    product.availability_source,
    new Date()
  );
  if (effectiveAvailability !== "in_stock") {
    return { success: false, status: 409, error: `Product is not in stock (availability: ${effectiveAvailability})` };
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

// ─── Wishes (cart_wishes) ─────────────────────────────────────────────────────
// dev-request 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt,
// Slice 1: a wish is "I want X" before a concrete offer is chosen. Choosing
// an offer either (a) links a `can_order`-eligible product, which mirrors a
// real cart_items row via the EXISTING addCartItem() machinery — so
// submitCart()'s per-producer order path needs no changes to find it — or
// (b) links a "contact this producer myself" producer with no cart_items
// row at all. submitCart() (below) reads mode='contact' wishes directly to
// build contact_handoffs.

export interface CartWish {
  id: string;
  cart_id: string;
  term: string;
  qty: number;
  unit_hint: string | null;
  chosen_product_id: string | null;
  chosen_agent_id: string | null;
  mode: "order" | "contact" | null;
  created_at: string;
}

export type WishResult =
  | { success: true; wish: CartWish }
  | { success: false; status: number; error: string };

function loadOpenCart(db: any, cartId: string): { id: string; status: string } | undefined {
  return db.prepare("SELECT id, status FROM carts WHERE id = ?").get(cartId) as
    | { id: string; status: string }
    | undefined;
}

export function addCartWish(
  cartId: string,
  term: string,
  qty: number,
  unitHint?: string | null
): WishResult {
  const trimmed = (term ?? "").trim();
  if (!trimmed) {
    return { success: false, status: 400, error: "term is required" };
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, status: 400, error: "qty must be a positive integer" };
  }

  const db = _cartTestDb ?? getDb();

  const cart = loadOpenCart(db, cartId);
  if (!cart) return { success: false, status: 404, error: "Cart not found" };
  if (cart.status !== "open") {
    return { success: false, status: 409, error: `Cart is ${cart.status}, cannot add wishes` };
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO cart_wishes (id, cart_id, term, qty, unit_hint, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(id, cartId, trimmed, qty, unitHint?.trim() || null);

  db.prepare("UPDATE carts SET updated_at = datetime('now') WHERE id = ?").run(cartId);

  const wish = db.prepare("SELECT * FROM cart_wishes WHERE id = ?").get(id) as CartWish;
  return { success: true, wish };
}

export interface ChooseWishOfferInput {
  productId?: string | null;
  qty?: number | null;
  agentId?: string | null;
  mode?: string | null;
}

/**
 * Choose an offer for an existing wish: either a concrete product
 * (`productId` — upserts a mirroring cart_items row via addCartItem(), same
 * eligibility/availability gates as adding directly) or a "contact this
 * producer myself" producer (`agentId` + mode='contact', no cart_items row).
 * Exactly one of the two must be provided.
 *
 * Switching a wish's choice (product → product, product → contact, or
 * simply re-picking) always cleans up any PREVIOUSLY-linked cart_items row
 * for this wish first — otherwise a stale order-mode line item would keep
 * creating a real order at submit even after the buyer switched away from
 * it (dangling-row bug this function exists specifically to avoid).
 *
 * orch-pr-20260919-handleliste-slice1 fix-up (reviewer CHANGES-REQUESTED):
 * the previously-linked row is now located and removed by `wish_id` (this
 * wish's OWN row, addressed by id), never by a bare (cart_id, product_id)
 * match — the old match-by-product approach could hit and delete a
 * DIFFERENT wish's mirrored row whenever two wishes independently chose the
 * same product_id (cart_items has UNIQUE(cart_id, product_id), so only one
 * row can exist per product). For the same reason, choosing a product_id
 * that's already claimed by another wish (or already a direct, non-wish
 * cart_items row) is rejected with 409 rather than silently merged or
 * clobbered — simplest option that cannot reintroduce the silent-data-loss
 * bug; a rejected buyer just sees "already chosen" and can bump qty on the
 * existing wish/line instead.
 */
export function chooseCartWishOffer(
  cartId: string,
  wishId: string,
  input: ChooseWishOfferInput
): WishResult {
  const db = _cartTestDb ?? getDb();

  const cart = loadOpenCart(db, cartId);
  if (!cart) return { success: false, status: 404, error: "Cart not found" };
  if (cart.status !== "open") {
    return { success: false, status: 409, error: `Cart is ${cart.status}, cannot change wishes` };
  }

  const wish = db.prepare("SELECT * FROM cart_wishes WHERE id = ? AND cart_id = ?").get(wishId, cartId) as
    | CartWish
    | undefined;
  if (!wish) return { success: false, status: 404, error: "Wish not found in cart" };

  const productId = (input.productId ?? "").toString().trim() || null;
  const agentId = (input.agentId ?? "").toString().trim() || null;

  if (!productId && !agentId) {
    return { success: false, status: 400, error: "Provide either product_id or agent_id" };
  }
  if (productId && agentId) {
    return { success: false, status: 400, error: "Provide only one of product_id or agent_id, not both" };
  }

  // THIS wish's own currently-linked cart_items row, if any — located by
  // wish_id (a specific row, by id), never by product match.
  const ownRow = db.prepare("SELECT id, product_id FROM cart_items WHERE wish_id = ?").get(wishId) as
    | { id: string; product_id: string }
    | undefined;

  if (productId) {
    // Reject if a DIFFERENT wish (or a directly-added, non-wish item)
    // already owns the cart_items row for this exact product in this cart —
    // see doc comment above for why this is rejected rather than merged.
    const existingForProduct = db.prepare(
      "SELECT id FROM cart_items WHERE cart_id = ? AND product_id = ?"
    ).get(cartId, productId) as { id: string } | undefined;
    if (existingForProduct && existingForProduct.id !== ownRow?.id) {
      return {
        success: false,
        status: 409,
        error: "This product is already chosen by another wish (or already in the cart) — change or remove that one first",
      };
    }

    // Clean up THIS wish's own previously-linked row (by id) before
    // switching to a different product. No-op if the wish had no prior
    // order-mode choice, or if re-choosing the SAME product (addCartItem
    // below upserts that row in place).
    if (ownRow && ownRow.product_id !== productId) {
      db.prepare("DELETE FROM cart_items WHERE id = ?").run(ownRow.id);
    }

    const qty = Number.isInteger(input.qty) && (input.qty as number) > 0 ? (input.qty as number) : wish.qty;
    const added = addCartItem(cartId, productId, qty);
    if (!added.success) {
      return { success: false, status: added.status, error: added.error };
    }
    // Tag the upserted row as owned by this wish. Safe: the conflict check
    // above already proved no OTHER wish/row owns this product, so this
    // can only ever (re-)tag this wish's own row.
    db.prepare("UPDATE cart_items SET wish_id = ? WHERE cart_id = ? AND product_id = ?").run(wishId, cartId, productId);

    db.prepare(`
      UPDATE cart_wishes SET chosen_product_id = ?, chosen_agent_id = NULL, mode = 'order' WHERE id = ?
    `).run(productId, wishId);
  } else {
    if (input.mode && input.mode !== "contact") {
      return { success: false, status: 400, error: "mode must be 'contact' when choosing agent_id" };
    }
    const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId);
    if (!agent) return { success: false, status: 404, error: "Producer not found" };

    // Switching to contact mode: drop this wish's own previously-linked
    // cart_items row (by id), if any.
    if (ownRow) {
      db.prepare("DELETE FROM cart_items WHERE id = ?").run(ownRow.id);
    }

    db.prepare(`
      UPDATE cart_wishes SET chosen_agent_id = ?, chosen_product_id = NULL, mode = 'contact' WHERE id = ?
    `).run(agentId, wishId);
  }

  db.prepare("UPDATE carts SET updated_at = datetime('now') WHERE id = ?").run(cartId);
  const updated = db.prepare("SELECT * FROM cart_wishes WHERE id = ?").get(wishId) as CartWish;
  return { success: true, wish: updated };
}

export function deleteCartWish(cartId: string, wishId: string): UpdateItemResult {
  const db = _cartTestDb ?? getDb();

  const wish = db.prepare("SELECT * FROM cart_wishes WHERE id = ? AND cart_id = ?").get(wishId, cartId) as
    | CartWish
    | undefined;
  if (!wish) return { success: false, status: 404, error: "Wish not found in cart" };

  const cart = db.prepare("SELECT status FROM carts WHERE id = ?").get(cartId) as { status: string } | undefined;
  if (cart && cart.status !== "open") {
    return { success: false, status: 409, error: `Cart is ${cart.status}; wishes can only be changed while open` };
  }

  // orch-pr-20260919-handleliste-slice1 fix-up: delete THIS wish's own
  // mirrored cart_items row by wish_id (a specific row, by id) — never by
  // bare (cart_id, product_id) match, which could otherwise delete a
  // DIFFERENT wish's row that happens to share the same chosen product_id
  // (the silent-data-loss bug this fix-up addresses). No-op if the wish
  // never had an order-mode choice.
  db.prepare("DELETE FROM cart_items WHERE wish_id = ?").run(wishId);
  db.prepare("DELETE FROM cart_wishes WHERE id = ?").run(wishId);
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

export interface SubmitContactInput {
  buyer_name?: string | null;
  buyer_email?: string | null;
  buyer_phone?: string | null;
  delivery_note?: string | null;
  contact_consent?: boolean;
}

export interface ContactHandoff {
  agent_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  profile_url: string;
  message: string;
}

export type SubmitResult =
  | { success: true; orders: OrderSummary[]; contact_handoffs: ContactHandoff[] }
  | { success: false; status: number; error: string; unavailable?: Array<{ product_id: string; product_name: string; availability: string }> };

const HANDOFF_BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";

/** Norwegian prefilled "contact yourself" message — never includes buyer contact info. */
function buildHandoffMessage(lines: Array<{ name: string; qty: number; unit?: string | null }>): string {
  const itemText = lines
    .map((l) => `${l.qty}${l.unit ? " " + l.unit : ""} ${l.name}`)
    .join(", ");
  return `Hei! Jeg fant deg på Rett fra Bonden og ønsker å bestille: ${itemText}. Har du dette tilgjengelig, og hvordan kan jeg få hentet det?`;
}

/** Builds a ContactHandoff for one producer from a merged item/wish list. Never throws. */
function buildContactHandoff(
  agentId: string,
  agentName: string,
  lines: Array<{ name: string; qty: number; unit?: string | null }>
): ContactHandoff {
  const info = knowledgeService.getAgentInfo(agentId);
  const k = info?.knowledge;
  return {
    agent_id: agentId,
    name: agentName,
    phone: k?.phone ?? null,
    email: k?.email ?? null,
    profile_url: `${HANDOFF_BASE_URL}/produsent/${slugify(agentName)}`,
    message: buildHandoffMessage(lines),
  };
}

export function submitCart(cartId: string, contact?: SubmitContactInput): SubmitResult {
  const db = _cartTestDb ?? getDb();

  const cart = db.prepare("SELECT id, status FROM carts WHERE id = ?").get(cartId) as
    | { id: string; status: string }
    | undefined;
  if (!cart) return { success: false, status: 404, error: "Cart not found" };
  if (cart.status !== "open") {
    return { success: false, status: 409, error: `Cart is already ${cart.status}` };
  }

  // mode='contact' wishes — no cart_items row, never touched by the
  // availability re-check below. Grouped into contact_handoffs, per agent,
  // further down.
  const contactWishes = db.prepare(`
    SELECT id, term, qty, unit_hint, chosen_agent_id
    FROM cart_wishes
    WHERE cart_id = ? AND mode = 'contact' AND chosen_agent_id IS NOT NULL
  `).all(cartId) as Array<{ id: string; term: string; qty: number; unit_hint: string | null; chosen_agent_id: string }>;

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
      p.availability_source AS availability_source,
      p.availability_updated_at AS availability_updated_at,
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
    availability_source: string;
    availability_updated_at: string | null;
    producer_name: string;
  }>;

  if (!items.length && !contactWishes.length) {
    return { success: false, status: 400, error: "Cart is empty" };
  }

  // Re-check availability for every item (mandatory per spec). Gate on the
  // EFFECTIVE availability (dev-request 2026-07-13-supply-graph-v1, salvage
  // slice) — a stale producer_dashboard 'in_stock' value must be rejected
  // here too, not just at add-to-cart time. The `availability` field
  // surfaced in the `unavailable` error array below is the EFFECTIVE value
  // (e.g. 'unknown'), so callers reading the error see the actual reason.
  const now = new Date();
  const withEffective = items.map(i => ({
    ...i,
    effectiveAvailability: computeEffectiveAvailability(
      i.availability,
      i.availability_updated_at,
      i.availability_source,
      now
    ),
  }));
  const unavailable = withEffective.filter(i => i.effectiveAvailability !== "in_stock");
  if (unavailable.length > 0) {
    return {
      success: false,
      status: 409,
      error: `${unavailable.length} item(s) are no longer available`,
      unavailable: unavailable.map(i => ({
        product_id: i.product_id,
        product_name: i.product_name,
        availability: i.effectiveAvailability,
      })),
    };
  }

  // Split items by agent_id
  const byAgent = new Map<string, typeof items>();
  for (const item of items) {
    if (!byAgent.has(item.agent_id)) byAgent.set(item.agent_id, []);
    byAgent.get(item.agent_id)!.push(item);
  }

  // Producers eligible for a real order RIGHT NOW — re-checked here at
  // submit (defense-in-depth; addCartItem() already required this at add
  // time, so in the common case nothing changes — it only matters if
  // eligibility changed between add and submit). Reuses isProducerEligible()
  // COMPLETELY UNCHANGED, per this slice's own scope: its gating logic is
  // not touched here.
  const eligibleAgentIds = new Set<string>();
  const ineligibleAgentIds = new Set<string>();
  for (const agent_id of byAgent.keys()) {
    (isProducerEligible(agent_id) ? eligibleAgentIds : ineligibleAgentIds).add(agent_id);
  }

  // Everything that will NOT become a real order — mode='contact' wishes
  // AND any cart_items producer that turned out ineligible at submit time
  // ("chosen via mode:'contact', or an ineligible producer") — merged one
  // entry per producer so a producer chosen both ways in the same cart
  // still gets exactly one contact_handoffs entry.
  const handoffByAgent = new Map<
    string,
    { name: string; lines: Array<{ name: string; qty: number; unit?: string | null }> }
  >();
  for (const agent_id of ineligibleAgentIds) {
    const agentItems = byAgent.get(agent_id)!;
    handoffByAgent.set(agent_id, {
      name: agentItems[0]!.producer_name,
      lines: agentItems.map((i) => ({ name: i.product_name, qty: i.qty, unit: i.unit })),
    });
  }
  for (const w of contactWishes) {
    const agentRow = db.prepare("SELECT name FROM agents WHERE id = ?").get(w.chosen_agent_id) as
      | { name: string }
      | undefined;
    // A contact-mode wish pointing at a deleted/unknown agent is dropped
    // silently rather than failing the whole submit — same defensive
    // posture as the availability re-check's "never throw" contract.
    if (!agentRow) continue;
    const line = { name: w.term, qty: w.qty, unit: w.unit_hint };
    const existing = handoffByAgent.get(w.chosen_agent_id);
    if (existing) {
      existing.lines.push(line);
    } else {
      handoffByAgent.set(w.chosen_agent_id, { name: agentRow.name, lines: [line] });
    }
  }

  const buyer_ref = (db.prepare("SELECT buyer_ref FROM carts WHERE id = ?").get(cartId) as any).buyer_ref;

  const orderSummaries: OrderSummary[] = [];
  const pendingNotifications: OrderNotificationInput[] = [];
  const consentNow = contact?.contact_consent === true;

  // Transaction: set cart submitted (+ contact fields) + create one order
  // per ELIGIBLE producer + one cart_handoffs analytics row per handoff
  // (agent_id/cart_id/item_count only — no buyer contact fields, ever).
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE carts
      SET status = 'submitted',
          buyer_name = ?,
          buyer_email = ?,
          buyer_phone = ?,
          delivery_note = ?,
          contact_consent_at = CASE WHEN ? THEN datetime('now') ELSE contact_consent_at END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      contact?.buyer_name ?? null,
      contact?.buyer_email ?? null,
      contact?.buyer_phone ?? null,
      contact?.delivery_note ?? null,
      consentNow ? 1 : 0,
      cartId
    );

    for (const [agent_id, lines] of handoffByAgent) {
      db.prepare(`
        INSERT INTO cart_handoffs (id, agent_id, cart_id, item_count, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(randomUUID(), agent_id, cartId, lines.lines.length);
    }

    for (const agent_id of eligibleAgentIds) {
      const agentItems = byAgent.get(agent_id)!;
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

  // Built AFTER the transaction committed (cart_handoffs rows already
  // written inside it) — this only reads agent contact info, no writes.
  const contact_handoffs: ContactHandoff[] = Array.from(handoffByAgent.entries()).map(([agent_id, v]) =>
    buildContactHandoff(agent_id, v.name, v.lines)
  );

  return { success: true, orders: orderSummaries, contact_handoffs };
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

  // No-show bookkeeping is only meaningful for an order that was actually
  // ready for pickup: cancel_reason='no_show' (and its trust-ledger event)
  // requires from-status 'ready'. Enforced centrally here so BOTH callers
  // (producer PRG page and the admin no-show route) share the same guard.
  // A plain confirmed → cancelled (no reason) remains legal.
  if (cancelReason === "no_show" && order.status !== "ready") {
    return {
      success: false,
      status: 409,
      error: `Cannot record a no-show for an order in '${order.status}' — only orders that were ready for pickup can be no-shows`,
    };
  }

  // Concurrency guard: the UPDATE re-asserts the from-status we validated
  // against (id AND status), so two racing transitions (multi-instance, or
  // producer + admin at once) can't both apply — the loser's UPDATE matches
  // 0 rows and its transaction rolls back with a 409.
  let conflict = false;
  const tx = db.transaction(() => {
    const upd = db.prepare(
      "UPDATE orders SET status = ?, cancel_reason = COALESCE(?, cancel_reason), updated_at = datetime('now') WHERE id = ? AND status = ?"
    ).run(toStatus, cancelReason, orderId, order.status);
    if (upd.changes !== 1) {
      conflict = true;
      throw new Error("concurrent status change");
    }
    db.prepare(`
      INSERT INTO order_events (id, order_id, from_status, to_status, actor, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(randomUUID(), orderId, order.status, toStatus, actor);
  });

  try {
    tx();
  } catch (err) {
    if (conflict) {
      return {
        success: false,
        status: 409,
        error: "Order status changed concurrently — reload and retry",
      };
    }
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
