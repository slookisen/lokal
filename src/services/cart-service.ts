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
 *  - A category label is no product: refused on add, on a wish's choice
 *    and on submit (slice I-S2, see CATEGORY_LABEL_CART_ERROR).
 */

import { formatAddressLine } from "../utils/address-format";
import { randomUUID, randomBytes } from "crypto";
import { getDb } from "../database/init";
import { recordTrustEvent } from "./trust-event-service";
import { sendOrderNotificationForOrder, OrderNotificationInput } from "./order-notify-service";
import { computeEffectiveAvailability } from "./supply-graph";
import { knowledgeService } from "./knowledge-service";
import { slugify } from "../utils/slug";
import { isBlocked } from "./blocklist-service";
import { isCategoryLabel } from "../utils/category-label";
import { classifyCartItemBan, banErrorText, BAN_CHECK_FAILED_ERROR, type BannedItemKind } from "./cart-item-ban";
import { summarizePricing } from "./order-pricing";

// ─── Test-DB override (module-local, race-proof) ─────────────────────────────
// In production _cartTestDb is always null → getDb() is used as normal.
// Tests call __setCartTestDb(db) to pin a specific in-memory DB for cart
// operations WITHOUT touching the global __setDbForTesting singleton, so
// concurrent test blocks that re-pin the global cannot clobber this handle.
let _cartTestDb: any = null;
export function __setCartTestDb(db: any): void { _cartTestDb = db; }
/** The DB cart-service writes to (its test pin, else getDb()) — shared with order-actions.ts. */
export function cartServiceDb(): any { return _cartTestDb ?? getDb(); }

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
  /** F6: at least one line has no price; total_nok is the sum over the lines with a price. */
  total_is_partial: boolean;
  item_count: number;
}

export interface OrderSummary {
  order_id: string;
  agent_id: string;
  producer_name: string;
  total_nok: number;
  /** F6: at least one line has no price, so total_nok only covers the lines with a price. */
  total_is_partial: boolean;
  status: string;
  // Prerequisite 3 of the prepayment dev-request: the buyer reaches the
  // seller directly for cancellation, withdrawal and complaints — the
  // producer's PUBLIC contact details (same source as contact_handoffs).
  producer_contact?: ProducerContact;
}

export interface ProducerContact {
  phone: string | null;
  email: string | null;
  /** Geographic address from the public profile (angrerettloven § 8), or null. */
  address: string | null;
  profile_url: string;
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

// ─── Real-order eligibility (skive 2 of dev-request 2026-09-16-handleliste- ─
// med-produsentvalg-og-bestillingsflyt: hybrid utsending) ────────────────────
// Daniel 2026-10-01: «bygg skive 2 uten lempningen» — this gate is STRICTER
// than isProducerEligible() above, never looser. isProducerEligible() (the
// add-to-cart admission gate, UNCHANGED) decides whether a product can be put
// in a cart at all; this function decides, at submit time, whether a chosen
// producer gets a REAL order row + the notification e-mail, or whether the
// buyer gets a contact-handoff instead. It is ALSO what GET /api/marketplace/
// catalog/offers and lokal_find_offers expose as `can_order` (catalog-
// offers.ts calls it per offer row), so the two surfaces can never drift.
//
// ALL of the following must hold:
//   - everything isProducerEligible() requires (not an umbrella account,
//     internal cross-check verification_status = 'verified', NOT
//     second-line-only verification) — the INNER JOIN is deliberate: an
//     agent with no agent_knowledge row has no cross-check and is out;
//   - agents.is_active = 1 (never route a real order to a deactivated row);
//   - agents.is_verified = 1 — the owner has claimed the profile («Verifisert
//     av eier»); Daniel's rule: real orders only go to producers who have
//     confirmed their profile;
//   - agents.order_notifications_opt_in = 1 — explicit, independent,
//     mandatory (never satisfied by any other signal);
//   - a recipient e-mail exists (admin-set order_notification_email wins,
//     else contact_email — the same resolution order-notify-service.ts's
//     gate 2 uses) and it is not blocklisted (its gate 4, same isBlocked()).
// The admin override is only a DESTINATION for the mail (Daniel's test-inbox
// pattern); it never substitutes for the cross-check or the owner claim.
// Net effect: a producer that fails any clause gets a contact_handoffs entry
// and no order row — the «dead pending order nobody sees» gap is closed.
//
// `dbOverride` lets catalog-offers.ts (which takes an injectable db for its
// tests) evaluate the agents/agent_knowledge clauses against the same
// connection it queried offers from. The final isBlocked() clause always
// reads the global getDb() singleton (blocklist-service has no injectable
// handle) — identical in production, and tests that pass an override pin
// the singleton to the same DB. isBlocked() is fail-open on a DB error
// (same posture as the notify gate's clause 4), so an unreadable blocklist
// never turns a real order into a handoff.
export function isEligibleForRealOrder(agentId: string, dbOverride?: any): boolean {
  const db = dbOverride ?? _cartTestDb ?? getDb();
  const row = db.prepare(`
    SELECT a.order_notification_email AS override_email,
           a.contact_email            AS contact_email
    FROM agents a
    INNER JOIN agent_knowledge k ON k.agent_id = a.id
    WHERE a.id = ?
      AND a.umbrella_type IS NULL
      AND a.is_active = 1
      AND k.verification_status = 'verified'
      AND (k.verified_second_line IS NULL OR k.verified_second_line = 0)
      AND a.is_verified = 1
      AND a.order_notifications_opt_in = 1
  `).get(agentId) as { override_email: string | null; contact_email: string | null } | undefined;
  if (!row) return false;
  const email = (row.override_email || "").trim() || (row.contact_email || "").trim();
  if (!email) return false;
  return !isBlocked({ email }).blocked;
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

// ─── Category labels are no products ─────────────────────────────────────────
// dev-request 2026-10-17-integrasjonstest-oppfolging, slice I-S2 (a): a
// catalog row that is only a generic category label («Honning» at a bakery,
// written by the enrichment's category inference and copied into `products`
// by product-catalog-sync.ts) can never be put in a cart. findOffers no longer
// offers such rows (slice I-S), but their ids are still public via GET
// /catalog/feed and /catalog/agents/:id/products, so the cart checks them
// itself: in addCartItem, in chooseCartWishOffer (before it changes anything)
// and again in submitCart. The rule is the one findOffers and lokal_info use
// (utils/category-label.ts): a category name, no price_nok, not set by the
// producer (availability_source 'producer_dashboard').

/**
 * The 422 error (NO / EN). The code leads the text because the REST routes
 * and lokal_cart_add_item pass on only `error` and the status.
 */
export const CATEGORY_LABEL_CART_ERROR =
  "category_label: kategorinavn, ikke et produkt — spør produsenten. / A category name, not a product — ask the producer.";

function isCategoryLabelRow(row: { name: string; price_nok: number | null; availability_source: string | null }): boolean {
  return isCategoryLabel({ name: row.name, hasPrice: row.price_nok != null, availabilitySource: row.availability_source });
}

// ─── F9: alcohol and services/experiences are no cart items ──────────────────
// dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel, F9.
// Fail-closed (see cart-item-ban.ts): a classifier error refuses the row too.

/** The producer's own types (agents.categories / tags). Tolerant of a DB without the columns. */
function producerTypesOf(db: any, agentId: string): string[] {
  try {
    const row = db.prepare("SELECT categories, tags FROM agents WHERE id = ?").get(agentId) as
      | { categories: string | null; tags: string | null }
      | undefined;
    if (!row) return [];
    const out: string[] = [];
    for (const raw of [row.categories, row.tags]) {
      if (!raw) continue;
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) for (const v of arr) if (typeof v === "string") out.push(v);
      } catch { /* not JSON: ignore */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** The refusal for a catalog row, or null when it may be ordered. Never throws. */
function bannedItemError(
  db: any,
  row: { agent_id: string; name: string; description?: string | null; category?: string | null },
): { kind: BannedItemKind | "check_failed"; error: string } | null {
  try {
    const ban = classifyCartItemBan({
      name: row.name,
      description: row.description,
      category: row.category,
      producerTypes: producerTypesOf(db, row.agent_id),
    });
    return ban ? { kind: ban.kind, error: banErrorText(ban.kind) } : null;
  } catch {
    return { kind: "check_failed", error: BAN_CHECK_FAILED_ERROR };
  }
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
    SELECT p.id, p.agent_id, p.name, p.description, p.category, p.availability, p.price_nok, p.availability_source, p.availability_updated_at
    FROM products p
    WHERE p.id = ?
  `).get(productId) as
    | {
        id: string;
        agent_id: string;
        name: string;
        description: string | null;
        category: string | null;
        availability: string;
        price_nok: number | null;
        availability_source: string;
        availability_updated_at: string | null;
      }
    | undefined;

  if (!product) return { success: false, status: 404, error: "Product not found" };
  // I-S2: before the stock and producer checks, as a label is no product at all.
  if (isCategoryLabelRow(product)) return { success: false, status: 422, error: CATEGORY_LABEL_CART_ERROR };
  // F9: alcohol and services/experiences can never be ordered (fail-closed).
  const banned = bannedItemError(db, product);
  if (banned) return { success: false, status: 422, error: banned.error };

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
    // I-S2: refuse a category label before this wish's own row is touched
    // (addCartItem below would refuse it too, but only after the clean-up).
    const chosen = db.prepare("SELECT agent_id, name, description, category, price_nok, availability_source FROM products WHERE id = ?").get(productId) as
      | { agent_id: string; name: string; description: string | null; category: string | null; price_nok: number | null; availability_source: string }
      | undefined;
    if (chosen && isCategoryLabelRow(chosen)) {
      return { success: false, status: 422, error: CATEGORY_LABEL_CART_ERROR };
    }
    // F9: same refusal before the clean-up (addCartItem would refuse it too).
    const chosenBan = chosen ? bannedItemError(db, chosen) : null;
    if (chosenBan) return { success: false, status: 422, error: chosenBan.error };

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
  const total_is_partial = summarizePricing(
    groups.flatMap((g) => g.items.map((i) => ({ line_total: i.line_total })))
  ).is_partial;

  return { success: true, cart_id: cartId, status: cart.status, groups, total_nok, total_is_partial, item_count };
}

// ─── Submit cart ─────────────────────────────────────────────────────────────

export interface SubmitContactInput {
  buyer_name?: string | null;
  buyer_email?: string | null;
  buyer_phone?: string | null;
  delivery_note?: string | null;
  contact_consent?: boolean;
  // Prepayment (A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-
  // connect, skive 2): the buyer asks to pay at pickup even where the
  // producer takes prepayment. Only read through SubmitOptions.prepay.
  pay_at_pickup?: boolean;
}

/**
 * Prepayment hook (skive 2). submitCart() itself never talks to Stripe and
 * never changes WHO gets a real order (isEligibleForRealOrder() decides
 * that, unchanged). For each producer that already gets a real order,
 * `prepay` says whether the order should wait for a prepayment: such an
 * order is written with payment_mode='prepay' and its producer
 * notification is NOT sent here — payment-service.ts sends it once Stripe
 * reports the payment authorized, or falls back to pay-at-pickup.
 * Without `prepay` (payments off) submitCart behaves exactly as before.
 */
export interface SubmitOptions {
  prepay?: (agentId: string, lines: Array<{ unit_price_snapshot: number | null; qty: number }>) => boolean;
}

// skive 2: hard length caps on the buyer contact fields, enforced centrally
// in submitCart() so every caller (REST route, MCP lokal_cart_submit, any
// future website form) is symmetric. Since skive 2 these values are copied
// onto the order, rendered into the producer e-mail and shown on the
// producer's confirm page — an oversized value must be rejected up front
// (400, no side effects) rather than create an order whose notification
// then fails. The MCP tool's zod schema uses the same numbers.
export const SUBMIT_CONTACT_MAX_LEN = {
  buyer_name: 120,
  buyer_email: 254,
  buyer_phone: 40,
  delivery_note: 500,
} as const;

export interface ContactHandoff {
  agent_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  profile_url: string;
  message: string;
}

export type SubmitResult =
  | { success: true; orders: OrderSummary[]; contact_handoffs: ContactHandoff[]; terms_url: string }
  | {
      success: false;
      status: number;
      error: string;
      unavailable?: Array<{ product_id: string; product_name: string; availability: string }>;
      /** I-S2: the lines that are category labels (422 CATEGORY_LABEL_CART_ERROR). */
      category_labels?: Array<{ product_id: string; product_name: string }>;
      /** F9: the lines that are alcohol or services/experiences (422). */
      banned_items?: Array<{ product_id: string; product_name: string; kind: BannedItemKind | "check_failed" }>;
    };

const HANDOFF_BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";

/** Norwegian prefilled "contact yourself" message — never includes buyer contact info. */
function buildHandoffMessage(lines: Array<{ name: string; qty: number; unit?: string | null }>): string {
  const itemText = lines
    .map((l) => `${l.qty}${l.unit ? " " + l.unit : ""} ${l.name}`)
    .join(", ");
  return `Hei! Jeg fant deg på Rett fra Bonden og ønsker å bestille: ${itemText}. Har du dette tilgjengelig, og hvordan kan jeg få hentet det?`;
}

/** The producer's public contact details (agent_knowledge), as on the profile page. Never throws. */
export function producerContact(agentId: string, agentName: string): ProducerContact {
  let info: any = null;
  try { info = knowledgeService.getAgentInfo(agentId) ?? null; } catch { info = null; }
  const k = info?.knowledge ?? null;
  const address = k?.address ? formatAddressLine(k.address, k.postalCode, info?.agent?.city) : "";
  return {
    phone: k?.phone ?? null,
    email: k?.email ?? null,
    address: address || null,
    profile_url: `${HANDOFF_BASE_URL}/produsent/${slugify(agentName)}`,
  };
}

/** Prerequisite 6: every submit response points at the terms the buyer accepted. */
export const TERMS_OF_PURCHASE_URL = `${HANDOFF_BASE_URL}/kjopsvilkar`;

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

// ─── F2: a real order needs buyer contact info ────────────────────────────────
export const CONTACT_REQUIRED_ERROR =
  "contact_required: for å legge inn en bestilling trenger produsenten å kunne nå deg. Oppgi e-post eller telefon, og sett contact_consent=true (du godtar at kontaktinfoen deles med produsenten). Ingen bestilling er opprettet. / To place an order the producer must be able to reach you: give an e-mail or a phone number and set contact_consent=true. No order was created.";

const BUYER_EMAIL_RE = /^[^\s@<>,;"'()\\\x00-\x1f\x7f]+@[^\s@<>,;"'()\\\x00-\x1f\x7f]+\.[A-Za-z0-9-]{2,}$/;

/** contact_consent=true and a plausible e-mail or a phone number with at least 6 digits. */
export function hasUsableBuyerContact(contact?: SubmitContactInput): boolean {
  if (!contact || contact.contact_consent !== true) return false;
  const email = (contact.buyer_email || "").trim();
  if (email && email.length <= 254 && BUYER_EMAIL_RE.test(email)) return true;
  const phone = (contact.buyer_phone || "").trim();
  return (phone.match(/\d/g) || []).length >= 6;
}

// ─── F8: per-producer spam cap ────────────────────────────────────────────────
// At most N open (pending) orders from the same buyer address to one producer,
// and at most M new orders per producer per rolling 24 hours (all buyers).
// Defaults N=3, M=10, read from env on every call.
function envPositiveInt(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}
export function orderCapOpenPerBuyer(): number { return envPositiveInt("ORDER_CAP_OPEN_PENDING_PER_BUYER", 3); }
export function orderCapNewPerDay(): number { return envPositiveInt("ORDER_CAP_NEW_PER_PRODUCER_PER_DAY", 10); }

function orderCapReached(db: any, agentId: string, contact?: SubmitContactInput): boolean {
  try {
    const perDay = db.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE agent_id = ? AND created_at >= datetime('now', '-1 day')"
    ).get(agentId) as { n: number };
    if (perDay.n >= orderCapNewPerDay()) return true;
    const email = (contact?.buyer_email || "").trim().toLowerCase();
    const phone = (contact?.buyer_phone || "").replace(/\s+/g, "");
    if (email) {
      const open = db.prepare(
        "SELECT COUNT(*) AS n FROM orders WHERE agent_id = ? AND status = 'pending' AND lower(buyer_email) = ?"
      ).get(agentId, email) as { n: number };
      if (open.n >= orderCapOpenPerBuyer()) return true;
    } else if (phone) {
      const open = db.prepare(
        "SELECT COUNT(*) AS n FROM orders WHERE agent_id = ? AND status = 'pending' AND replace(buyer_phone, ' ', '') = ?"
      ).get(agentId, phone) as { n: number };
      if (open.n >= orderCapOpenPerBuyer()) return true;
    }
    return false;
  } catch {
    // A cap that cannot be read must not block a real buyer.
    return false;
  }
}

export function submitCart(cartId: string, contact?: SubmitContactInput, opts?: SubmitOptions): SubmitResult {
  const db = _cartTestDb ?? getDb();

  const cart = db.prepare("SELECT id, status FROM carts WHERE id = ?").get(cartId) as
    | { id: string; status: string }
    | undefined;
  if (!cart) return { success: false, status: 404, error: "Cart not found" };
  if (cart.status !== "open") {
    return { success: false, status: 409, error: `Cart is already ${cart.status}` };
  }

  // skive 2: reject oversized contact fields BEFORE any side effect (see
  // SUBMIT_CONTACT_MAX_LEN). The error names the field and the cap only —
  // never the value (personal data).
  for (const field of Object.keys(SUBMIT_CONTACT_MAX_LEN) as Array<keyof typeof SUBMIT_CONTACT_MAX_LEN>) {
    const value = contact?.[field];
    if (typeof value === "string" && value.length > SUBMIT_CONTACT_MAX_LEN[field]) {
      return {
        success: false,
        status: 400,
        error: `${field} is too long (max ${SUBMIT_CONTACT_MAX_LEN[field]} characters)`,
      };
    }
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
      p.description AS product_description,
      p.category    AS product_category,
      p.unit        AS unit,
      p.price_nok   AS price_nok,
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
    product_description: string | null;
    product_category: string | null;
    unit: string | null;
    price_nok: number | null;
    availability: string;
    availability_source: string;
    availability_updated_at: string | null;
    producer_name: string;
  }>;

  if (!items.length && !contactWishes.length) {
    return { success: false, status: 400, error: "Cart is empty" };
  }

  // I-S2: a category label in the cart (one added before addCartItem refused
  // them) is no product, so the cart is not sent: no order, no handoff line.
  // Checked on the row as it is now, like the availability below.
  const labels = items.filter((i) =>
    isCategoryLabelRow({ name: i.product_name, price_nok: i.price_nok, availability_source: i.availability_source }));
  if (labels.length > 0) {
    return {
      success: false,
      status: 422,
      error: CATEGORY_LABEL_CART_ERROR,
      category_labels: labels.map((i) => ({ product_id: i.product_id, product_name: i.product_name })),
    };
  }

  // F9: alcohol and services/experiences are no cart items. A row that got in
  // before the ban existed (or whose catalog row was edited since) is caught
  // here, on the row as it is now: no order, no handoff, no e-mail.
  const bannedLines = items
    .map((i) => ({ i, ban: bannedItemError(db, { agent_id: i.agent_id, name: i.product_name, description: i.product_description, category: i.product_category }) }))
    .filter((x) => x.ban !== null);
  if (bannedLines.length > 0) {
    return {
      success: false,
      status: 422,
      error: bannedLines[0]!.ban!.error,
      banned_items: bannedLines.map((x) => ({ product_id: x.i.product_id, product_name: x.i.product_name, kind: x.ban!.kind })),
    };
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

  // Producers that get a REAL order right now (skive 2, hybrid utsending):
  // isEligibleForRealOrder() — a strictly TIGHTER bar than the add-to-cart
  // gate addCartItem() applied (isProducerEligible(), unchanged): on top of
  // the cross-check it requires an active, owner-claimed (is_verified=1)
  // producer who opted in to orders and has a non-blocklisted recipient
  // address. Everyone else in the cart becomes a contact-handoff below —
  // no order row, no e-mail. Before skive 2 a non-opted-in producer got a
  // "dead" pending order nobody was ever told about; that gap is closed.
  const eligibleAgentIds = new Set<string>();
  const ineligibleAgentIds = new Set<string>();
  for (const agent_id of byAgent.keys()) {
    (isEligibleForRealOrder(agent_id) ? eligibleAgentIds : ineligibleAgentIds).add(agent_id);
  }

  // F2: a REAL order needs a way for the producer to reach the buyer — consent
  // to share the contact details plus an e-mail address or a phone number.
  // Without it the API answers with a clear error: no order row, no e-mail,
  // and the cart stays open so the buyer can retry with contact details.
  // Only evaluated when at least one producer would get a real order; a cart
  // that is all contact-handoffs needs no buyer contact info.
  if (eligibleAgentIds.size > 0 && !hasUsableBuyerContact(contact)) {
    return { success: false, status: 422, error: CONTACT_REQUIRED_ERROR };
  }

  // F8: per-producer spam cap. A producer over the cap gets a contact handoff
  // instead of one more order (no order row, no e-mail).
  for (const agent_id of Array.from(eligibleAgentIds)) {
    if (orderCapReached(db, agent_id, contact)) {
      eligibleAgentIds.delete(agent_id);
      ineligibleAgentIds.add(agent_id);
    }
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

  // Prepayment decision per real-order producer (skive 2). Evaluated BEFORE
  // the transaction so a throwing hook can never half-write a submit.
  const prepayAgentIds = new Set<string>();
  if (opts?.prepay) {
    for (const agent_id of eligibleAgentIds) {
      const lines = byAgent.get(agent_id)!.map((i) => ({ unit_price_snapshot: i.unit_price_snapshot, qty: i.qty }));
      if (opts.prepay(agent_id, lines)) prepayAgentIds.add(agent_id);
    }
  }

  const orderSummaries: OrderSummary[] = [];
  const pendingNotifications: OrderNotificationInput[] = [];
  const consentNow = contact?.contact_consent === true;

  // skive 2: the buyer's contact fields reach a PRODUCER (order row, e-mail,
  // /produsent/ordre/:token page) ONLY when the buyer explicitly consented.
  // Without consent the cart still stores what was typed (Slice 1, unchanged)
  // but every producer-facing copy stays NULL — the invariant the orders
  // columns document: non-NULL there ⇒ consent was given.
  const sharedContact = consentNow
    ? {
        buyer_name: contact?.buyer_name ?? null,
        buyer_email: contact?.buyer_email ?? null,
        buyer_phone: contact?.buyer_phone ?? null,
        delivery_note: contact?.delivery_note ?? null,
      }
    : { buyer_name: null, buyer_email: null, buyer_phone: null, delivery_note: null };

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

      // skive 2: the consented buyer contact fields are copied onto the
      // order itself — the v2 e-mail and the /produsent/ordre/:token page
      // read from the ORDER, not the cart (an order must stand on its own;
      // the cart-level and order-level 30-day sweeps run independently,
      // see cart-contact-sweep.ts). All NULL when the buyer did not consent.
      db.prepare(`
        INSERT INTO orders
          (id, cart_id, agent_id, buyer_ref, status, fulfilment, pickup_time,
           total_nok, confirm_token, created_at, updated_at,
           buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at)
        VALUES
          (?, ?, ?, ?, 'pending', 'pickup', NULL, ?, ?, datetime('now'), datetime('now'),
           ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END)
      `).run(
        order_id, cartId, agent_id, buyer_ref, total_nok, confirm_token,
        sharedContact.buyer_name,
        sharedContact.buyer_email,
        sharedContact.buyer_phone,
        sharedContact.delivery_note,
        consentNow ? 1 : 0
      );
      if (prepayAgentIds.has(agent_id)) {
        db.prepare(`UPDATE orders SET payment_mode = 'prepay' WHERE id = ?`).run(order_id);
      }

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

      const pricing = summarizePricing(agentItems.map((i) => ({
        line_total: i.unit_price_snapshot != null ? i.unit_price_snapshot * i.qty : null,
      })));
      orderSummaries.push({
        order_id,
        agent_id,
        producer_name,
        total_nok,
        total_is_partial: pricing.is_partial,
        status: "pending",
      });

      // A prepay order's producer is told only once the payment is
      // authorized (payment-service.ts) — never here.
      if (prepayAgentIds.has(agent_id)) continue;

      pendingNotifications.push({
        order_id,
        agent_id,
        producer_name,
        buyer_ref,
        confirm_token,
        pickup_time: null,
        // F6: no «0 kr» for an order whose lines have no price at all.
        total_nok: pricing.any_priced ? total_nok : null,
        total_is_partial: pricing.is_partial,
        items: agentItems.map((i) => ({
          name: i.product_name,
          qty: i.qty,
          unit: i.unit,
          line_total: i.unit_price_snapshot != null ? i.unit_price_snapshot * i.qty : null,
        })),
        // skive 2: same consent-gated values the transaction just wrote to
        // `orders` — the v2 template renders them (and sets Reply-To).
        ...sharedContact,
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

  // F3: the buyer's receipt at submit («forespørsel til produsenten har
  // bekreftet», betaling ved henting, lenke til /kjopsvilkar). Behind
  // ORDER_BUYER_RECEIPTS_ENABLED (a no-op while it is off). A prepay order is
  // left out: its payment flow tells the buyer something else, and the
  // «betaling ved henting» sentence would be false for it.
  for (const o of orderSummaries) {
    if (prepayAgentIds.has(o.agent_id)) continue;
    try {
      const { sendBuyerOrderReceipt } = require("./order-receipt-service") as typeof import("./order-receipt-service");
      void sendBuyerOrderReceipt(o.order_id, "submitted").catch(() => { /* never fails the submit */ });
    } catch { /* never fails the submit */ }
  }

  // Built AFTER the transaction committed (cart_handoffs rows already
  // written inside it) — this only reads agent contact info, no writes.
  const contact_handoffs: ContactHandoff[] = Array.from(handoffByAgent.entries()).map(([agent_id, v]) =>
    buildContactHandoff(agent_id, v.name, v.lines)
  );

  const orders = orderSummaries.map((o) => ({ ...o, producer_contact: producerContact(o.agent_id, o.producer_name) }));
  return { success: true, orders, contact_handoffs, terms_url: TERMS_OF_PURCHASE_URL };
}

// ─── Notification input rebuilt from the order (prepayment, skive 2) ────────
// A prepay order's producer notification is sent later than submit (when
// Stripe reports the payment authorized, or when the order falls back to
// pay-at-pickup), so the input is rebuilt from what submitCart() wrote to
// the ORDER — the same consent-gated contact fields, never the cart's.
export function buildOrderNotificationInput(orderId: string): OrderNotificationInput | null {
  const db = _cartTestDb ?? getDb();
  const o = db.prepare(`
    SELECT o.id, o.agent_id, o.buyer_ref, o.confirm_token, o.pickup_time, o.total_nok,
           o.buyer_name, o.buyer_email, o.buyer_phone, o.delivery_note, a.name AS producer_name
    FROM orders o INNER JOIN agents a ON a.id = o.agent_id
    WHERE o.id = ?
  `).get(orderId) as
    | {
        id: string; agent_id: string; buyer_ref: string; confirm_token: string | null; pickup_time: string | null;
        total_nok: number | null; buyer_name: string | null; buyer_email: string | null; buyer_phone: string | null;
        delivery_note: string | null; producer_name: string;
      }
    | undefined;
  if (!o || !o.confirm_token) return null;
  const items = db.prepare(`
    SELECT oi.name_snapshot AS name, oi.qty AS qty, p.unit AS unit, oi.line_total AS line_total
    FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ? ORDER BY oi.rowid
  `).all(orderId) as Array<{ name: string | null; qty: number | null; unit: string | null; line_total: number | null }>;
  const pricing = summarizePricing(items);
  return {
    order_id: o.id,
    agent_id: o.agent_id,
    producer_name: o.producer_name,
    buyer_ref: o.buyer_ref,
    confirm_token: o.confirm_token,
    pickup_time: o.pickup_time,
    total_nok: items.length > 0 && !pricing.any_priced ? null : o.total_nok,
    total_is_partial: pricing.is_partial,
    items: items.map((i) => ({ name: i.name ?? "", qty: i.qty ?? 0, unit: i.unit ?? null, line_total: i.line_total ?? null })),
    buyer_name: o.buyer_name,
    buyer_email: o.buyer_email,
    buyer_phone: o.buyer_phone,
    delivery_note: o.delivery_note,
  };
}

// ─── Get order ───────────────────────────────────────────────────────────────

export type OrderView =
  | {
      success: true;
      order_id: string;
      cart_id: string | null;
      agent_id: string;
      producer_name: string;
      producer_contact: ProducerContact;
      status: string;
      cancel_reason: string | null;
      fulfilment: string;
      pickup_time: string | null;
      total_nok: number | null;
      /** F6: at least one line has no price; total_nok then only covers the lines with a price. */
      total_is_partial: boolean;
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
      // Prepayment (A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-
      // connect): present only for orders that had a payment link.
      payment?: BuyerPaymentView;
    }
  | { success: false; status: number; error: string };

export interface BuyerPaymentView {
  status: string;
  amount_nok: number;
  refunded_nok: number;
  /** Only while the link is still payable. */
  checkout_url?: string;
  expires_at?: string;
  seller: "producer";
  capture: "on_producer_confirmation";
  fees: { stripe_fee_payer: "producer"; platform_fee_nok: number };
  /** The producer's own declaration (angrerettloven § 9 a); null if none. */
  seller_trader_status: "trader" | "non_trader" | null;
  /** Payment timeline (no personal data): buyer-relevant event types + timestamp. */
  events: Array<{ type: string; at: string }>;
}

// Only these payment_events types are shown to buyers/agents; internal
// retries, alerts and step failures stay in the admin view.
const BUYER_PAYMENT_EVENT_TYPES = [
  "checkout_created", "checkout_completed", "checkout_expired", "payment_authorized", "payment_captured",
  "payment_canceled", "payment_refunded", "payment_partially_refunded",
];

/** The newest trader declaration of a producer (producer_terms_acceptances); null if none. */
export function producerTraderStatus(db: any, agentId: string): "trader" | "non_trader" | null {
  try {
    const r = db.prepare(`SELECT trader_status FROM producer_terms_acceptances WHERE agent_id = ? ORDER BY accepted_at DESC, rowid DESC LIMIT 1`)
      .get(agentId) as { trader_status: string } | undefined;
    return r?.trader_status === "trader" || r?.trader_status === "non_trader" ? r.trader_status : null;
  } catch {
    return null;
  }
}

function buyerPaymentView(db: any, orderId: string): BuyerPaymentView | undefined {
  try {
    const p = db.prepare(`
      SELECT id, agent_id, status, amount_ore, refunded_ore, application_fee_ore, checkout_url, checkout_expires_at FROM payments WHERE order_id = ?
    `).get(orderId) as
      | { id: string; agent_id: string; status: string; amount_ore: number; refunded_ore: number; application_fee_ore: number; checkout_url: string | null; checkout_expires_at: string | null }
      | undefined;
    if (!p) return undefined;
    const events = db.prepare(`
      SELECT type, created_at AS at FROM payment_events
      WHERE payment_id = ? AND type IN (${BUYER_PAYMENT_EVENT_TYPES.map(() => "?").join(",")})
      ORDER BY created_at, rowid
    `).all(p.id, ...BUYER_PAYMENT_EVENT_TYPES) as Array<{ type: string; at: string }>;
    const payable = p.status === "requires_payment" && !!p.checkout_url && !!p.checkout_expires_at && Date.parse(p.checkout_expires_at) > Date.now();
    return {
      status: p.status,
      amount_nok: p.amount_ore / 100,
      refunded_nok: p.refunded_ore / 100,
      ...(payable ? { checkout_url: p.checkout_url!, expires_at: p.checkout_expires_at! } : {}),
      seller: "producer",
      capture: "on_producer_confirmation",
      fees: { stripe_fee_payer: "producer", platform_fee_nok: p.application_fee_ore / 100 },
      seller_trader_status: producerTraderStatus(db, p.agent_id),
      events,
    };
  } catch {
    // A DB without the payments table (minimal test schema) → no payment view.
    return undefined;
  }
}

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
    producer_contact: producerContact(order.agent_id, order.producer_name),
    status: order.status,
    cancel_reason: order.cancel_reason,
    fulfilment: order.fulfilment,
    pickup_time: order.pickup_time,
    total_nok: order.total_nok,
    total_is_partial: summarizePricing(orderItems).is_partial,
    items: orderItems,
    timeline: getOrderTimeline(order.id),
    ...(() => { const payment = buyerPaymentView(db, order.id); return payment ? { payment } : {}; })(),
  };
}

// ─── Order lifecycle transitions ─────────────────────────────────────────────
// dev-request 2026-07-13-pilot-ordre-loop: every legal transition appends an
// order_events row (the buyer/seller-visible timeline) and terminal outcomes
// write trust-ledger events (trust-event-service). `ready → cancelled` is the
// producer "no-show" path and stores cancel_reason='no_show'.

// Fase A1 (dev-request 2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent):
// «Klar for henting» is no longer a step — a confirmed order can be completed
// directly (seller «Hentet», buyer «picked_up», or the automatic close).
// `ready` stays for existing rows and is handled like `confirmed`.
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending:   ["confirmed", "declined"],
  confirmed: ["ready", "completed", "cancelled"],
  ready:     ["completed", "cancelled"],
  declined:  [],
  completed: [],
  cancelled: [],
};

// F4: 'producer_no_response' — the producer did not answer within the
// deadline (set by the order-followups job). Not a decline, so it writes no
// trust-ledger event.
const SYSTEM_PENDING_CANCEL_REASONS = new Set(["payment_expired", "buyer_cancelled", "producer_no_response"]);

export type TransitionResult =
  | { success: true; order_id: string; status: string }
  | { success: false; status: number; error: string };

export type OrderActorRole = "seller" | "buyer" | "system" | "admin";
/** transitionOrder's error when the idempotency key was already used on the order. */
export const IDEMPOTENCY_KEY_TAKEN = "idempotency_key_taken";
export type OrderCompletionSource = "auto" | "buyer" | "seller" | "admin";

/**
 * Fase A1: every order_events row carries actor_role + channel. Callers that
 * predate the action layer (payment-service's payment_expired) pass only the
 * legacy `actor`; the role and channel are derived from it here.
 */
export function deriveActorRoleChannel(actor: string | null | undefined): { role: OrderActorRole; channel: string } {
  switch (actor) {
    case "producer": return { role: "seller", channel: "producer_page" };
    case "admin":    return { role: "admin", channel: "admin" };
    case "buyer":    return { role: "buyer", channel: "internal" };
    case "system":   return { role: "system", channel: "system_job" };
    default:         return { role: "system", channel: "internal" };
  }
}

export function transitionOrder(
  orderId: string,
  toStatus: string,
  opts?: {
    actor?: string;
    cancelReason?: string | null;
    /** Fase A1: who acted and through which channel (derived from `actor` when absent). */
    actorRole?: OrderActorRole;
    channel?: string;
    /** Fase A1: stored on the order_events row; unique per order. */
    idempotencyKey?: string | null;
    /** Fase A1: stored on orders.completion_source when toStatus is 'completed'. */
    completionSource?: OrderCompletionSource | null;
    /** Fase A1: set orders.pickup_time in the same write (confirm with a pickup time). */
    pickupTime?: string | null;
  }
): TransitionResult {
  const db = _cartTestDb ?? getDb();

  const order = db.prepare("SELECT id, status, agent_id FROM orders WHERE id = ?").get(orderId) as
    | { id: string; status: string; agent_id: string }
    | undefined;

  if (!order) return { success: false, status: 404, error: "Order not found" };

  const allowed = VALID_TRANSITIONS[order.status] ?? [];
  // Prepayment (A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-
  // connect, skive 3 + prerequisite 2): pending → cancelled is reachable
  // ONLY with an explicit reason in SYSTEM_PENDING_CANCEL_REASONS —
  // 'payment_expired' (the producer did not confirm a reserved payment in
  // time, set by the system) and 'buyer_cancelled' (the buyer withdrew
  // before confirmation, recorded by the producer — forbrukerkjøpsloven
  // § 41 — instead of a «decline» that would count against the producer).
  // Every other caller still gets the matrix above.
  const systemCancel = order.status === "pending" && toStatus === "cancelled" &&
    SYSTEM_PENDING_CANCEL_REASONS.has(opts?.cancelReason ?? "");
  if (!allowed.includes(toStatus) && !systemCancel) {
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
  // payment_expired is only for a still-PENDING order (the deadline job):
  // never for an order the producer confirmed in the meantime — that one
  // may already be captured (review finding on skive 2+3).
  if (cancelReason === "payment_expired" && order.status !== "pending") {
    return {
      success: false,
      status: 409,
      error: `Cannot expire the payment of an order in '${order.status}' — only pending orders expire`,
    };
  }
  // Fase A1: «Klar for henting» is no longer a step, so a no-show can be
  // recorded for any confirmed order (confirmed or the legacy ready) until it
  // is closed — never for one that was not confirmed.
  if (cancelReason === "no_show" && order.status !== "ready" && order.status !== "confirmed") {
    return {
      success: false,
      status: 409,
      error: `Cannot record a no-show for an order in '${order.status}' — only confirmed orders can be no-shows`,
    };
  }

  const derived = deriveActorRoleChannel(actor);
  const actorRole: OrderActorRole = opts?.actorRole ?? derived.role;
  const channel = opts?.channel ?? derived.channel;
  const idempotencyKey = opts?.idempotencyKey ?? null;
  const completionSource: OrderCompletionSource | null = toStatus === "completed"
    ? (opts?.completionSource ?? (actorRole === "admin" ? "admin" : actorRole === "seller" ? "seller" : actorRole === "buyer" ? "buyer" : null))
    : null;
  const pickupTime = toStatus === "confirmed" ? (opts?.pickupTime ?? null) : null;

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
    if (completionSource) {
      db.prepare("UPDATE orders SET completion_source = ? WHERE id = ?").run(completionSource, orderId);
    }
    if (pickupTime) {
      db.prepare("UPDATE orders SET pickup_time = ? WHERE id = ?").run(pickupTime, orderId);
    }
    db.prepare(`
      INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_role, channel, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(randomUUID(), orderId, order.status, toStatus, actor, actorRole, channel, idempotencyKey);
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
    // Fase A1: a racing repeat of the same idempotency key lost the unique
    // index (order_id, idempotency_key); the whole write rolled back.
    if (idempotencyKey && /UNIQUE constraint failed: order_events/i.test(msg)) {
      return { success: false, status: 409, error: IDEMPOTENCY_KEY_TAKEN };
    }
    return { success: false, status: 500, error: `Transition failed: ${msg}` };
  }

  // Trust-ledger: terminal outcomes only. recordTrustEvent never throws.
  if (toStatus === "completed") {
    recordTrustEvent({ agentId: order.agent_id, eventType: "order_completed", ref: orderId, completionSource });
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
  /** F5/F6: 'prepay' / 'at_pickup' / null (null = pay at pickup). */
  payment_mode: string | null;
  /** F6: at least one line has no price. */
  total_is_partial: boolean;
  // skive 2: the buyer's consented contact fields, read-only display on the
  // /produsent/ordre/:token page — null for orders created before skive 2,
  // for a no-consent submit, or after the 30-day sweep nulled them.
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  delivery_note: string | null;
  items: Array<{
    name_snapshot: string | null;
    qty: number | null;
    unit_price_snapshot: number | null;
    line_total: number | null;
  }>;
  timeline: OrderEvent[];
}

/**
 * Skive 1b (S6): returned by orderPaymentMode when the order's payment_mode
 * could not be READ. Distinct from null (a pay-at-pickup order), so a read
 * error can never open the cancellation of a prepay order whose captured
 * payment would then not be refunded — the callers treat it like prepay.
 */
export const PAYMENT_MODE_UNKNOWN = "unknown";

/**
 * orders.payment_mode (null = pay at pickup). A DB without the column (an old
 * or minimal schema) has no prepay orders at all, so it reads as null; any
 * other read error is PAYMENT_MODE_UNKNOWN (fail-closed, S6).
 */
export function orderPaymentMode(db: any, orderId: string): string | null {
  try {
    const r = db.prepare("SELECT payment_mode FROM orders WHERE id = ?").get(orderId) as { payment_mode: string | null } | undefined;
    return r?.payment_mode ?? null;
  } catch (err) {
    if (/no such column/i.test(String((err as any)?.message || err))) return null;
    return PAYMENT_MODE_UNKNOWN;
  }
}

export function getOrderByConfirmToken(token: string): ProducerOrderView | null {
  if (!token) return null;
  const db = _cartTestDb ?? getDb();

  const order = db.prepare(`
    SELECT o.id, o.agent_id, o.status, o.cancel_reason, o.fulfilment, o.pickup_time,
           o.total_nok, o.buyer_ref, o.created_at, a.name AS producer_name,
           o.buyer_name, o.buyer_email, o.buyer_phone, o.delivery_note
    FROM orders o
    INNER JOIN agents a ON a.id = o.agent_id
    WHERE o.confirm_token = ?
  `).get(token) as
    | {
        id: string; agent_id: string; status: string; cancel_reason: string | null;
        fulfilment: string; pickup_time: string | null; total_nok: number | null;
        buyer_ref: string; created_at: string; producer_name: string;
        buyer_name: string | null; buyer_email: string | null; buyer_phone: string | null;
        delivery_note: string | null;
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
    payment_mode: orderPaymentMode(db, order.id),
    total_is_partial: summarizePricing(items).is_partial,
    buyer_name: order.buyer_name ?? null,
    buyer_email: order.buyer_email ?? null,
    buyer_phone: order.buyer_phone ?? null,
    delivery_note: order.delivery_note ?? null,
    items,
    timeline: getOrderTimeline(order.id),
  };
}
