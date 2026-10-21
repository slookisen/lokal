/**
 * Marketplace Cart Routes — Phase 1 cart MVP ("handleliste")
 *
 * REST endpoints for anonymous cart + order management.
 *
 * Public (buyer-token-gated):
 *   POST   /api/marketplace/cart                         — create cart
 *   POST   /api/marketplace/cart/:id/items               — add/upsert item
 *   PATCH  /api/marketplace/cart/:id/items/:itemId       — update qty
 *   DELETE /api/marketplace/cart/:id/items/:itemId       — remove item
 *   GET    /api/marketplace/cart/:id                     — view grouped cart
 *   POST   /api/marketplace/cart/:id/submit              — place orders
 *   GET    /api/marketplace/orders/:id                   — order detail
 *
 * Admin-gated lifecycle (X-Admin-Key):
 *   POST   /admin/marketplace/orders/:id/confirm
 *   POST   /admin/marketplace/orders/:id/decline
 *   POST   /admin/marketplace/orders/:id/ready
 *   POST   /admin/marketplace/orders/:id/complete
 *   POST   /admin/marketplace/orders/:id/no-show      (ready → cancelled, cancel_reason='no_show')
 *
 * Producer confirm page (tokenized, PRG — dev-request 2026-07-13-pilot-ordre-loop):
 *   GET    /produsent/ordre/:confirm_token            shows the order, mutates NOTHING
 *   POST   /produsent/ordre/:confirm_token            action=confirm|decline|ready|complete|no_show
 *
 * No payment. Sellers with explicit opt-in ARE notified on submit (see
 * services/order-notify-service.ts — opt-in + verified contact + suppression
 * gate). Anonymous buyer: cart token (buyer_ref) guards reads and mutations.
 */

import express, { Router, Request, Response } from "express";
import {
  createCart,
  checkCartToken,
  addCartItem,
  updateCartItem,
  deleteCartItem,
  viewCart,
  getOrder,
  transitionOrder,
  getOrderByConfirmToken,
  orderPaymentMode,
  addCartWish,
  chooseCartWishOffer,
  deleteCartWish,
} from "../services/cart-service";
import { cartWishesLimiter } from "../middleware/security";
import {
  submitCartWithPayments,
  resolvePaymentsStripeClient,
  isPaymentsEnabled,
  isPaymentsLifecycleActive,
  onOrderTransitioned,
  getPaymentForOrder,
  formatOsloDateTime,
  type OrderPaymentEffect,
} from "../services/payment-service";
import { getDb } from "../database/init";
import { sendBuyerOrderReceipt, type ReceiptEvent } from "../services/order-receipt-service";
import { PRICE_BY_AGREEMENT, PARTIAL_SUM_LABEL, summarizePricing } from "../services/order-pricing";
import type { PaymentsStripeClient } from "../services/payment-provider";

// ─── Public cart/order router ────────────────────────────────────────────────
export const cartRouter = Router();

// ─── Admin order lifecycle router ────────────────────────────────────────────
export const adminOrderRouter = Router();

// ─── Producer order confirm-page router (mounted at /produsent/ordre) ────────
export const producerOrderRouter = Router();

// ─── Admin key helper ─────────────────────────────────────────────────────────
function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Requires X-Admin-Key header" });
    return false;
  }
  return true;
}

// ─── Token extractor ──────────────────────────────────────────────────────────
// Accepts token from header X-Cart-Token OR body field buyer_ref.
// req.params are typed as string | string[] in Express 5 strict types; cast to string.
function extractToken(req: Request): string | undefined {
  const hdr = req.headers["x-cart-token"];
  const headerToken = Array.isArray(hdr) ? hdr[0] : hdr;
  return headerToken || (req.body?.buyer_ref as string | undefined);
}

function cartId(req: Request): string {
  const v = req.params["id"];
  return Array.isArray(v) ? v[0]! : (v as string);
}

function itemId(req: Request): string {
  const v = req.params["itemId"];
  return Array.isArray(v) ? v[0]! : (v as string);
}

function wishId(req: Request): string {
  const v = req.params["wid"];
  return Array.isArray(v) ? v[0]! : (v as string);
}

function orderId(req: Request): string {
  const v = req.params["id"];
  return Array.isArray(v) ? v[0]! : (v as string);
}

function queryToken(req: Request): string | undefined {
  const hdr = req.headers["x-cart-token"];
  const headerToken = Array.isArray(hdr) ? hdr[0] : hdr;
  const qp = req.query["buyer_ref"];
  const queryParam: string | undefined = typeof qp === "string" ? qp : Array.isArray(qp) ? (qp[0] as string | undefined) : undefined;
  return headerToken || queryParam;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/marketplace/cart
// Create a new cart. Returns {success, cart_id, buyer_ref}.
// buyer_ref is a capability token — the caller MUST store it; it cannot be
// recovered and is required for all subsequent cart operations.
// ─────────────────────────────────────────────────────────────────────────────
cartRouter.post("/cart", (_req: Request, res: Response) => {
  try {
    const { cart_id, buyer_ref } = createCart();
    res.status(201).json({ success: true, cart_id, buyer_ref });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/marketplace/cart/:id/items
// Add or upsert an item into the cart. Token required.
// Body: { product_id: string, qty: number, note?: string, buyer_ref?: string }
// ─────────────────────────────────────────────────────────────────────────────
cartRouter.post("/cart/:id/items", (req: Request, res: Response) => {
  const token = extractToken(req);
  const check = checkCartToken(cartId(req), token);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error });
    return;
  }
  if (check.cart.status !== "open") {
    res.status(409).json({ success: false, error: `Cart is ${check.cart.status}` });
    return;
  }

  const { product_id, qty, note } = req.body;
  if (!product_id) {
    res.status(400).json({ success: false, error: "product_id is required" });
    return;
  }
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0) {
    res.status(400).json({ success: false, error: "qty must be a positive integer" });
    return;
  }

  const result = addCartItem(cartId(req), product_id, qty, note);
  if (!result.success) {
    res.status(result.status).json({ success: false, error: result.error });
    return;
  }

  const cart = viewCart(cartId(req));
  res.status(200).json({ success: true, item: result.item, cart });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/marketplace/cart/:id/items/:itemId
// Update qty. qty=0 deletes the item. Token required.
// Body: { qty: number, buyer_ref?: string }
// ─────────────────────────────────────────────────────────────────────────────
cartRouter.patch("/cart/:id/items/:itemId", (req: Request, res: Response) => {
  const token = extractToken(req);
  const check = checkCartToken(cartId(req), token);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error });
    return;
  }

  const { qty } = req.body;
  if (typeof qty !== "number") {
    res.status(400).json({ success: false, error: "qty must be a number" });
    return;
  }

  const result = updateCartItem(cartId(req), itemId(req), qty);
  if (!result.success) {
    res.status(result.status).json({ success: false, error: result.error });
    return;
  }

  const cart = viewCart(cartId(req));
  res.json({ success: true, deleted: result.deleted ?? false, cart });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/marketplace/cart/:id/items/:itemId
// Remove an item. Token required (X-Cart-Token header or query param buyer_ref).
// ─────────────────────────────────────────────────────────────────────────────
cartRouter.delete("/cart/:id/items/:itemId", (req: Request, res: Response) => {
  // For DELETE, also accept token from query string (some clients can't send body)
  const token = queryToken(req);
  const check = checkCartToken(cartId(req), token);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error });
    return;
  }

  const result = deleteCartItem(cartId(req), itemId(req));
  if (!result.success) {
    res.status(result.status).json({ success: false, error: result.error });
    return;
  }

  const cart = viewCart(cartId(req));
  res.json({ success: true, cart });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wishes ("handleliste" — dev-request 2026-09-16-handleliste-med-
// produsentvalg-og-bestillingsflyt, Slice 1). A wish is "I want X" before a
// concrete offer is chosen; PATCH picks either a can_order product (mirrors
// a real cart_items row) or a contact-only producer (chosen_agent_id,
// mode='contact', no cart_items row). Same token gate as everything else on
// this router, plus cartWishesLimiter (defense-in-depth against an open,
// unauthenticated POST triggering downstream side effects at submit).
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/marketplace/cart/:id/wishes
// Body: { term: string, qty: number, unit_hint?: string, buyer_ref?: string }
cartRouter.post("/cart/:id/wishes", cartWishesLimiter, (req: Request, res: Response) => {
  const token = extractToken(req);
  const check = checkCartToken(cartId(req), token);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error });
    return;
  }

  const { term, qty, unit_hint } = req.body ?? {};
  if (typeof term !== "string" || !term.trim()) {
    res.status(400).json({ success: false, error: "term is required" });
    return;
  }
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0) {
    res.status(400).json({ success: false, error: "qty must be a positive integer" });
    return;
  }

  const result = addCartWish(cartId(req), term, qty, typeof unit_hint === "string" ? unit_hint : null);
  if (!result.success) {
    res.status(result.status).json({ success: false, error: result.error });
    return;
  }

  res.status(201).json({ success: true, wish: result.wish });
});

// PATCH /api/marketplace/cart/:id/wishes/:wid
// Body: { product_id?: string, qty?: number, agent_id?: string, mode?: 'contact', buyer_ref?: string }
// Exactly one of product_id / agent_id is required.
cartRouter.patch("/cart/:id/wishes/:wid", cartWishesLimiter, (req: Request, res: Response) => {
  const token = extractToken(req);
  const check = checkCartToken(cartId(req), token);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error });
    return;
  }

  const { product_id, qty, agent_id, mode } = req.body ?? {};
  const result = chooseCartWishOffer(cartId(req), wishId(req), {
    productId: typeof product_id === "string" ? product_id : null,
    qty: typeof qty === "number" ? qty : null,
    agentId: typeof agent_id === "string" ? agent_id : null,
    mode: typeof mode === "string" ? mode : null,
  });
  if (!result.success) {
    res.status(result.status).json({ success: false, error: result.error });
    return;
  }

  const cart = viewCart(cartId(req));
  res.json({ success: true, wish: result.wish, cart });
});

// DELETE /api/marketplace/cart/:id/wishes/:wid
// Token from header X-Cart-Token or query param buyer_ref (DELETE has no body convention here).
cartRouter.delete("/cart/:id/wishes/:wid", cartWishesLimiter, (req: Request, res: Response) => {
  const token = queryToken(req);
  const check = checkCartToken(cartId(req), token);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error });
    return;
  }

  const result = deleteCartWish(cartId(req), wishId(req));
  if (!result.success) {
    res.status(result.status).json({ success: false, error: result.error });
    return;
  }

  const cart = viewCart(cartId(req));
  res.json({ success: true, cart });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/marketplace/cart/:id
// View cart grouped by producer. Token required.
// Returns { success, cart_id, status, groups, total_nok, item_count }.
// ─────────────────────────────────────────────────────────────────────────────
cartRouter.get("/cart/:id", (req: Request, res: Response) => {
  const token = queryToken(req);
  const check = checkCartToken(cartId(req), token);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error });
    return;
  }

  const cart = viewCart(cartId(req));
  if (!cart) {
    res.status(404).json({ success: false, error: "Cart not found" });
    return;
  }

  res.json(cart);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/marketplace/cart/:id/submit
// Submit the cart. Re-checks availability of every item. Creates a real order
// per producer that passes cart-service.isEligibleForRealOrder() right now
// (skive 2: cross-check verified + owner-claimed + opted in + reachable, not
// blocklisted); every OTHER chosen producer (contact-mode wishes, or one that
// fails that bar) comes back as a contact_handoffs[] entry instead — no
// order row, no email. Contact fields reach a producer only with
// contact_consent=true (copied onto the order, rendered in the e-mail and on
// the producer's confirm page).
// Token required. Body: { buyer_ref?: string, buyer_name?, buyer_email?,
// buyer_phone?, delivery_note?, contact_consent?: boolean, website?: string }
//
// `website` is a honeypot: a real browser never fills it (hidden field), so
// any non-empty value means an automated submission — rejected before any
// DB write. Rate-limited (cartWishesLimiter) — an unauthenticated POST that
// can trigger a seller-notification email and a contact-handoff message is
// exactly the "open form → spam" shape that limiter exists for.
//
// Privacy: buyer_name/buyer_email/buyer_phone/delivery_note are personal
// data — NEVER logged (no console.log/error touches req.body here or in
// cart-service.submitCart). Swept 30 days after terminal order status by
// services/cart-contact-sweep.ts.
// ─────────────────────────────────────────────────────────────────────────────
cartRouter.post("/cart/:id/submit", cartWishesLimiter, async (req: Request, res: Response) => {
  const body = req.body ?? {};

  // Honeypot — silently accepted as a field, rejected only if filled in.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    res.status(400).json({ success: false, error: "Submission rejected" });
    return;
  }

  const token = extractToken(req);
  const check = checkCartToken(cartId(req), token);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error });
    return;
  }

  const contact = {
    buyer_name: typeof body.buyer_name === "string" ? body.buyer_name.trim() || null : null,
    buyer_email: typeof body.buyer_email === "string" ? body.buyer_email.trim() || null : null,
    buyer_phone: typeof body.buyer_phone === "string" ? body.buyer_phone.trim() || null : null,
    delivery_note: typeof body.delivery_note === "string" ? body.delivery_note.trim() || null : null,
    contact_consent: body.contact_consent === true,
    pay_at_pickup: body.pay_at_pickup === true,
  };

  // Prepayment (A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-
  // connect, skive 2): with PAYMENTS_ENABLED off this is exactly
  // submitCart() and the response is unchanged; with it on, orders for
  // producers that take prepayment come back with Stripe payment links in
  // `payments[]`.
  const result = await submitCartWithPayments({
    cartId: cartId(req),
    contact,
    stripe: isPaymentsEnabled()
      ? resolvePaymentsStripeClient(req.app.get("paymentsStripeClient") as PaymentsStripeClient | undefined)
      : null,
    baseUrl: process.env.BASE_URL || "https://rettfrabonden.com",
  });
  if (!result.success) {
    res.status(result.status).json(result);
    return;
  }

  res.status(201).json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/marketplace/orders/:id
// Fetch order detail. buyer_ref required (X-Cart-Token header or query param).
// ─────────────────────────────────────────────────────────────────────────────
cartRouter.get("/orders/:id", (req: Request, res: Response) => {
  const token = queryToken(req);

  if (!token) {
    res.status(403).json({ success: false, error: "Missing buyer token (X-Cart-Token header or buyer_ref query param)" });
    return;
  }

  const result = getOrder(cartId(req), token);
  if (!result.success) {
    res.status(result.status).json(result);
    return;
  }

  res.json(result);
});

// Prerequisite 1 (buyer receipt, angrerettloven § 18): after the payment
// step, so the mail states what happened to the money. Fire-and-forget;
// a no-op unless ORDER_BUYER_RECEIPTS_ENABLED=1.
function receiptAfterTransition(orderId: string, toStatus: string): void {
  if (toStatus === "confirmed" || toStatus === "declined" || toStatus === "cancelled") {
    void sendBuyerOrderReceipt(orderId, toStatus as ReceiptEvent);
  }
}

// Prepayment (A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-
// connect, skive 3): the Stripe client for the payment step after an order
// transition — null when payments are off (the step is then a no-op).
function paymentsClientFor(req: Request): PaymentsStripeClient | null {
  // "drain" (rollback) still captures/releases open payments.
  return isPaymentsLifecycleActive()
    ? resolvePaymentsStripeClient(req.app.get("paymentsStripeClient") as PaymentsStripeClient | undefined)
    : null;
}

// ─── Admin order lifecycle ────────────────────────────────────────────────────
// POST /admin/marketplace/orders/:id/confirm|decline|ready|complete|no-show
// Admin-gated (X-Admin-Key). Transitions the order status. "no-show" is the
// ready → cancelled path and stores cancel_reason='no_show' (pilot-ordre-loop).
// no-show on an order that is not 'ready' is rejected with 409 by the central
// guard in cart-service.transitionOrder (review fix, finding 3).

const LIFECYCLE_ACTIONS = ["confirm", "decline", "ready", "complete", "no-show", "cancel"] as const;
const ACTION_TO_STATUS: Record<string, string> = {
  confirm:   "confirmed",
  decline:   "declined",
  ready:     "ready",
  complete:  "completed",
  "no-show": "cancelled",
  cancel:    "cancelled",
};
// POST /admin/marketplace/orders/:id/cancel { reason } — prerequisite 2.
const ADMIN_CANCEL_REASONS = new Set(["producer_cancelled", "buyer_cancelled"]);

for (const action of LIFECYCLE_ACTIONS) {
  adminOrderRouter.post(`/orders/:id/${action}`, async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const toStatus = ACTION_TO_STATUS[action]!;
    let cancelReason: string | null = action === "no-show" ? "no_show" : null;
    if (action === "cancel") {
      // Ships with prepayment, like the producer page's cancellation box:
      // with the lifecycle off a captured payment could not be refunded.
      // F5: an order that is NOT a prepay order has no money to refund, so
      // the cancellation works for it whatever PAYMENTS_ENABLED says.
      let adminOrderMode: string | null = null;
      try { adminOrderMode = orderPaymentMode(getDb(), cartId(req)); } catch { adminOrderMode = null; }
      if (!cancelActionsEnabled(adminOrderMode)) {
        res.status(409).json({ success: false, error: "cancellation with a reason requires PAYMENTS_ENABLED=1 or drain" });
        return;
      }
      cancelReason = String(req.body?.reason || "");
      if (!ADMIN_CANCEL_REASONS.has(cancelReason)) {
        res.status(400).json({ success: false, error: "reason must be producer_cancelled or buyer_cancelled" });
        return;
      }
    }
    const result = transitionOrder(cartId(req), toStatus, {
      actor: "admin",
      cancelReason,
    });

    if (!result.success) {
      res.status(result.status).json(result);
      return;
    }

    // Prepayment step (capture / release / refund) after the transition —
    // never undoes it. Absent from the response when payments are off.
    const stripe = paymentsClientFor(req);
    if (!stripe) {
      receiptAfterTransition(result.order_id, toStatus);
      res.json(result);
      return;
    }
    const payment_effect = await onOrderTransitioned({ db: getDb(), stripe, orderId: result.order_id, toStatus, cancelReason });
    receiptAfterTransition(result.order_id, toStatus);
    res.json({ ...result, payment_effect });
  });
}

// ─── Producer confirm page (PRG — dev-request 2026-07-13-pilot-ordre-loop) ───
// Pattern mirrors the booking "bekreft-løkka" in experiences-seo.ts: the
// tokenized link lands ONLY in the producer's notification email; GET renders
// state and mutates NOTHING (mail-scanner link prefetch safe); every mutation
// is an explicit POST button → 303 redirect back to the GET (PRG).

function escapePageHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CANCEL_REASON_LABEL: Record<string, string> = Object.assign(Object.create(null), {
  no_show: "ikke hentet",
  producer_cancelled: "kansellert av produsenten",
  buyer_cancelled: "avbestilt av kunden",
  payment_expired: "ikke bekreftet innen fristen – reservasjonen er frigjort",
  producer_no_response: "ikke besvart innen fristen",
});

const ORDER_STATUS_LABEL: Record<string, string> = {
  pending:   "Venter på din bekreftelse",
  confirmed: "Bekreftet — ikke klar for henting ennå",
  declined:  "Avslått",
  ready:     "Klar for henting",
  completed: "Hentet",
  cancelled: "Kansellert",
};

// action → { toStatus, cancelReason } for the producer POST handler.
// NOTE (review fix, finding 3): no_show is additionally gated on the order
// being in status 'ready' — enforced centrally in cart-service
// transitionOrder (shared with the admin no-show route above), which
// returns 409 → this page redirects with ?error=ugyldig. The button is also
// only rendered for 'ready' (ACTIONS_FOR_STATUS).
const PRODUCER_ACTIONS: Record<string, { toStatus: string; cancelReason: string | null }> = Object.assign(Object.create(null), {
  confirm:  { toStatus: "confirmed", cancelReason: null },
  decline:  { toStatus: "declined",  cancelReason: null },
  ready:    { toStatus: "ready",     cancelReason: null },
  complete: { toStatus: "completed", cancelReason: null },
  no_show:  { toStatus: "cancelled", cancelReason: "no_show" },
  // Prerequisite 2 of the prepayment dev-request: cancellation after
  // confirmation, with the reason recorded — the producer cannot deliver,
  // or the buyer withdrew (also before confirmation, § 41).
  cancel_producer: { toStatus: "cancelled", cancelReason: "producer_cancelled" },
  cancel_buyer:    { toStatus: "cancelled", cancelReason: "buyer_cancelled" },
});

// Which action buttons are offered per current status (must stay a subset of
// cart-service VALID_TRANSITIONS — the service re-validates on POST anyway).
const ACTIONS_FOR_STATUS: Record<string, Array<{ action: string; label: string; cls: string }>> = {
  pending: [
    { action: "confirm", label: "Bekreft ordren", cls: "act-primary" },
    { action: "decline", label: "Avslå", cls: "act-secondary" },
  ],
  confirmed: [
    { action: "ready", label: "Klar for henting", cls: "act-primary" },
  ],
  ready: [
    { action: "complete", label: "Hentet", cls: "act-primary" },
    { action: "no_show", label: "Ikke hentet (no-show)", cls: "act-secondary" },
  ],
  declined: [],
  completed: [],
  cancelled: [],
};

// Cancellation, behind a «Kanseller ordren …» disclosure so it is never one
// stray click (prerequisite 2). Offered while the order is still open.
const CANCEL_ACTIONS_FOR_STATUS: Record<string, Array<{ action: string; label: string }>> = {
  pending: [
    { action: "cancel_buyer", label: "Kunden har avbestilt" },
  ],
  confirmed: [
    { action: "cancel_producer", label: "Jeg kan ikke levere – kanseller" },
    { action: "cancel_buyer", label: "Kunden har avbestilt" },
  ],
  ready: [
    { action: "cancel_producer", label: "Jeg kan ikke levere – kanseller" },
    { action: "cancel_buyer", label: "Kunden har avbestilt" },
  ],
};

// The cancellation box shipped with prepayment: for a PREPAY order it is shown
// (and accepted on POST) only while the payment lifecycle is on
// (PAYMENTS_ENABLED=1 or "drain"), as a captured payment must be refunded.
// F5 (dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel):
// an order that is not a prepay order (pay at pickup, the pilot) has no money
// to refund, so the choices exist for it regardless of PAYMENTS_ENABLED.
function cancelActionsEnabled(paymentMode: string | null | undefined): boolean {
  return paymentMode !== "prepay" || isPaymentsLifecycleActive();
}

/** F8: a SQLite UTC timestamp («2026-10-21 13:05:00») or ISO string, shown in Oslo time. */
function osloTime(ts: string | null | undefined): string {
  if (!ts) return "";
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(ts);
  if (!m) return ts;
  const iso = `${m[1]}T${m[2]}${m[4] ?? "Z"}`;
  if (Number.isNaN(Date.parse(iso))) return ts;
  return formatOsloDateTime(iso);
}

function cancelHint(p: ReturnType<typeof getPaymentForOrder>): string {
  if (p?.status === "captured") {
    return "Betalingen er trukket. Velger du «Jeg kan ikke levere», refunderes kunden automatisk. " +
      "Har kunden avbestilt, refunderer du selv i Stripe – helt, eller med fradrag for dokumentert tap (forbrukerkjøpsloven § 41).";
  }
  if (p?.status === "authorized" || p?.status === "requires_payment") {
    return "Betalingen er bare reservert. Kansellerer du, frigjøres reservasjonen og kunden belastes ikke.";
  }
  return "Avtal eventuelt oppgjør direkte med kunden.";
}

function kr(ore: number): string {
  const v = ore / 100;
  return Number.isInteger(v) ? `${v} kr` : `${v.toFixed(2).replace(".", ",")} kr`;
}

/** One line on the producer page per payment state (prepayment, skive 3). */
function producerPaymentText(p: NonNullable<ReturnType<typeof getPaymentForOrder>>): string {
  if (p.status === "authorized" && !isPaymentsLifecycleActive()) {
    // Payments switched fully off with a reservation still open: nothing
    // will capture it — never promise that it will.
    return `Kunden har reservert ${kr(p.amount_ore)}, men forhåndsbetaling er midlertidig slått av, så beløpet blir ikke trukket automatisk. Oppgjør ved henting som vanlig.`;
  }
  switch (p.status) {
    case "authorized":
      return `Kunden har betalt ${kr(p.amount_ore)}. Beløpet er reservert og trekkes når du bekrefter ordren.` +
        (p.capture_deadline_at ? ` Bekreft innen ${formatOsloDateTime(p.capture_deadline_at)}, ellers frigjøres reservasjonen og ordren kanselleres.` : "") +
        " Avslår du, frigjøres reservasjonen.";
    case "captured": {
      const fee = p.stripe_fee_ore;
      const net = fee != null ? p.amount_ore - fee - p.application_fee_ore - p.refunded_ore : null;
      return `${kr(p.amount_ore)} er trukket og går til din Stripe-konto.` +
        (fee != null ? ` Stripe-gebyr: ${kr(fee)}.` : "") +
        (p.refunded_ore > 0 ? ` Refundert til kunden: ${kr(p.refunded_ore)}.` : "") +
        (net != null ? ` Netto til deg: ${kr(net)}.` : "");
    }
    case "refunded":
      return `${kr(p.refunded_ore || p.amount_ore)} er refundert til kunden.`;
    case "requires_payment":
      return "Kunden har ikke betalt ennå.";
    case "expired":
      return p.authorized_at
        ? "Reservasjonen gikk ut før betalingen ble trukket. Oppgjør ved henting som vanlig."
        : "Kunden betalte ikke på forhånd. Oppgjør ved henting som vanlig.";
    case "canceled": {
      const reason = (p as { failure_reason?: string | null }).failure_reason || "";
      if (!p.authorized_at) return "Kunden betalte ikke på forhånd. Oppgjør ved henting som vanlig.";
      if (reason === "payment_expired") return "Ordren ble ikke bekreftet innen fristen. Reservasjonen er frigjort, og kunden er ikke belastet.";
      if (reason === "order_declined") return "Reservasjonen er frigjort, og kunden er ikke belastet.";
      return "Reservasjonen er frigjort, og kunden er ikke belastet. Oppgjør ved henting som vanlig hvis bestillingen gjennomføres.";
    }
    default:
      return "Oppgjør ved henting som vanlig.";
  }
}

const PAYMENT_BANNERS: Record<string, string> = Object.assign(Object.create(null), {
  trukket: `<div class="ordre-banner ok" role="status">Betalingen er trukket.</div>`,
  frigjort: `<div class="ordre-banner ok" role="status">Reservasjonen er frigjort.</div>`,
  refundert: `<div class="ordre-banner ok" role="status">Betalingen er refundert til kunden.</div>`,
  venter: `<div class="ordre-banner warn" role="status">Betalingen trekkes om litt. Du trenger ikke gjøre noe.</div>`,
  feilet: `<div class="ordre-banner warn" role="alert">Betalingen kunne ikke trekkes fordi reservasjonen er utløpt. Avtal betaling ved henting.</div>`,
});

const EFFECT_TO_BANNER: Partial<Record<OrderPaymentEffect, string>> = {
  captured: "trukket",
  released: "frigjort",
  refunded: "refundert",
  capture_pending: "venter",
  capture_failed: "feilet",
};

producerOrderRouter.get("/:token", (req: Request, res: Response) => {
  const raw = req.params["token"];
  const token = Array.isArray(raw) ? (raw[0] as string) : (raw as string);
  const order = token ? getOrderByConfirmToken(token) : null;
  if (!order) {
    res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send("<!doctype html><html lang=\"nb\"><head><meta charset=\"utf-8\"><title>Ordre ikke funnet</title></head><body><p>Ordren ble ikke funnet. Sjekk at du brukte hele lenken fra e-posten.</p></body></html>");
    return;
  }

  const orderRef = order.order_id.slice(0, 8);
  const statusLabel = ORDER_STATUS_LABEL[order.status] || order.status;
  const done = String(req.query["done"] || "");
  const errorParam = String(req.query["error"] || "");
  const banner =
    done && ORDER_STATUS_LABEL[done]
      ? `<div class="ordre-banner ok" role="status">Registrert: ${escapePageHtml(ORDER_STATUS_LABEL[done])}</div>`
      : errorParam === "ugyldig"
        ? `<div class="ordre-banner warn" role="alert">Handlingen er ikke gyldig for ordrens nåværende status.</div>`
        : errorParam
          ? `<div class="ordre-banner warn" role="alert">Kunne ikke oppdatere ordren. Prøv igjen.</div>`
          : "";

  // Prepayment (skive 3): what happened to the buyer's payment. Only for
  // orders that have a payment row — every other order renders as before.
  let paymentRow: ReturnType<typeof getPaymentForOrder> = null;
  try { paymentRow = getPaymentForOrder(getDb(), order.order_id); } catch { paymentRow = null; }

  const postTo = `/produsent/ordre/${encodeURIComponent(token)}`;
  const cancelActions = cancelActionsEnabled(order.payment_mode) ? (CANCEL_ACTIONS_FOR_STATUS[order.status] || []) : [];
  const actionsHtml = (ACTIONS_FOR_STATUS[order.status] || [])
    .map(
      (a) =>
        `<form method="POST" action="${postTo}"><input type="hidden" name="action" value="${a.action}"><button type="submit" class="act-btn ${a.cls}">${a.label}</button></form>`
    )
    .join("\n    ") + (cancelActions.length
      ? `\n    <details class="cancel-box"><summary>Kanseller ordren …</summary>\n      <p class="hint">${escapePageHtml(cancelHint(paymentRow))}</p>\n      ${cancelActions
          .map((a) => `<form method="POST" action="${postTo}"><input type="hidden" name="action" value="${a.action}"><button type="submit" class="act-btn act-secondary">${a.label}</button></form>`)
          .join("\n      ")}\n    </details>`
      : "");

  // F6: no «0 kr» for lines without a price; a sum over only some lines says so.
  const pageSum = summarizePricing(order.items);
  const sumHtml = !pageSum.any_priced
    ? (order.items.length ? `<div><strong>Pris:</strong> ${PRICE_BY_AGREEMENT}</div>` : "")
    : `<div><strong>${pageSum.is_partial ? PARTIAL_SUM_LABEL : "Sum"}:</strong> ${pageSum.is_partial ? pageSum.priced_total : (order.total_nok ?? pageSum.priced_total)} kr</div>`;
  const itemsHtml = order.items
    .map(
      (i) =>
        `<div>${escapePageHtml(i.name_snapshot || "Vare")} — ${i.qty ?? "?"} stk (${i.line_total != null ? `${i.line_total} kr` : PRICE_BY_AGREEMENT})</div>`
    )
    .join("\n      ");

  // skive 2 (hybrid utsending): the buyer's consented contact fields +
  // delivery wish, when present on the order — read-only display, no new
  // actions on this page. Omitted entirely (not shown as blank rows) when
  // absent: pre-skive-2 orders, a no-consent submit, or after
  // cart-contact-sweep.ts's 30-day sweep nulled them.
  const buyerRowsHtml = [
    order.buyer_name ? `<div><strong>Navn:</strong> ${escapePageHtml(order.buyer_name)}</div>` : "",
    order.buyer_phone ? `<div><strong>Telefon:</strong> ${escapePageHtml(order.buyer_phone)}</div>` : "",
    order.buyer_email ? `<div><strong>E-post:</strong> ${escapePageHtml(order.buyer_email)}</div>` : "",
    order.delivery_note ? `<div><strong>Leveringsønske:</strong> ${escapePageHtml(order.delivery_note)}</div>` : "",
  ]
    .filter(Boolean)
    .join("\n      ");
  const buyerBlockHtml = buyerRowsHtml
    ? `<div class="recap"><strong>Kunde:</strong>\n      ${buyerRowsHtml}\n    </div>`
    : "";

  const paymentHtml = paymentRow ? `<div class="recap"><strong>Betaling:</strong>\n      <div>${escapePageHtml(producerPaymentText(paymentRow))}</div>\n    </div>` : "";
  const paymentBanner = PAYMENT_BANNERS[String(req.query["betaling"] || "")] || "";

  const timelineHtml = order.timeline.length
    ? `<div class="recap"><strong>Tidslinje:</strong>\n      ${order.timeline
        .map((e) => `<div>${escapePageHtml(osloTime(e.created_at))}: ${escapePageHtml(e.from_status || "–")} → ${escapePageHtml(e.to_status)}</div>`)
        .join("\n      ")}</div>`
    : "";

  const html = `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ordre ${escapePageHtml(orderRef)} | Rett fra Bonden</title>
<meta name="robots" content="noindex, nofollow">
<style>
body{font-family:system-ui,sans-serif;background:#f5f3ee;color:#1e2b23;margin:0}
.confirm-panel{max-width:480px;margin:32px auto;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.07);padding:28px 24px}
.confirm-panel h1{font-size:1.25rem;font-weight:800;margin:0 0 4px}
.confirm-panel .ref{font-family:monospace;font-size:1rem;font-weight:700;letter-spacing:.03em;background:#eef0ea;border-radius:8px;padding:6px 12px;display:inline-block;margin:8px 0 4px}
.confirm-panel .status-line{margin:12px 0 4px;font-size:.95rem}
.confirm-panel .recap{text-align:left;margin:16px 0;font-size:.92rem;color:#41504a}
.confirm-panel .recap div{padding:5px 0;border-bottom:1px solid #e4e2da}
.confirm-panel .hint{font-size:.82rem;color:#7c877f;margin-top:14px}
.ordre-banner{border-radius:8px;padding:12px 14px;margin:14px 0;font-size:.9rem}
.ordre-banner.ok{background:#e8f4ec;border:1px solid #bcd9c5;color:#1d5a30}
.ordre-banner.warn{background:#fdf3e7;border:1px solid #f0d4ae;color:#7a5218}
.act-btn{margin-top:12px;width:100%;padding:12px 18px;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer}
.act-primary{background:#2c5b3f;color:#fff}
.act-secondary{background:#eef0ea;color:#1e2b23;border:1px solid #d8dbd2}
.cancel-box{margin-top:16px;font-size:.92rem}
.cancel-box summary{cursor:pointer;color:#7a5218;font-weight:600}
</style>
</head>
<body>
<main class="container">
  <div class="confirm-panel">
    <h1>Henteordre hos ${escapePageHtml(order.producer_name)}</h1>
    <div class="ref">${escapePageHtml(orderRef)}</div>
    ${banner}
    <div class="status-line">Status: <strong>${escapePageHtml(statusLabel)}</strong>${CANCEL_REASON_LABEL[order.cancel_reason || ""] ? ` (${CANCEL_REASON_LABEL[order.cancel_reason || ""]})` : ""}</div>
    <div class="recap">
      <div><strong>Opprettet:</strong> ${escapePageHtml(osloTime(order.created_at))}</div>
      ${order.pickup_time ? `<div><strong>Hentetid:</strong> ${escapePageHtml(order.pickup_time)}</div>` : ""}
      ${sumHtml}
      ${itemsHtml}
    </div>
    ${buyerBlockHtml}${paymentRow ? `\n    ${paymentBanner}${paymentHtml}` : ""}
    ${timelineHtml}
    ${actionsHtml}
    <p class="hint">Denne siden er for produsenten. Lenken er personlig for denne ordren — ikke del den videre. ${paymentRow ? "Betalingen går via Stripe direkte til din egen Stripe-konto." : "Ingen betaling skjer via plattformen."}</p>
  </div>
</main>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

producerOrderRouter.post(
  "/:token",
  express.urlencoded({ extended: false }),
  async (req: Request, res: Response) => {
    const raw = req.params["token"];
    const token = Array.isArray(raw) ? (raw[0] as string) : (raw as string);
    const order = token ? getOrderByConfirmToken(token) : null;
    if (!order) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }

    const backTo = `/produsent/ordre/${encodeURIComponent(token)}`;
    const action = String((req.body || {})["action"] || "");
    const mapped = PRODUCER_ACTIONS[action];
    if (!mapped || (action.startsWith("cancel_") && !cancelActionsEnabled(order.payment_mode))) {
      res.redirect(303, `${backTo}?error=ugyldig`);
      return;
    }

    const result = transitionOrder(order.order_id, mapped.toStatus, {
      actor: "producer",
      cancelReason: mapped.cancelReason,
    });
    if (!result.success) {
      res.redirect(303, `${backTo}?error=ugyldig`);
      return;
    }
    // Prepayment step after the transition (skive 3): confirm → capture,
    // decline → release. The banner says what happened to the payment.
    const stripe = paymentsClientFor(req);
    const effect = stripe
      ? await onOrderTransitioned({ db: getDb(), stripe, orderId: order.order_id, toStatus: mapped.toStatus, cancelReason: mapped.cancelReason })
      : "none";
    receiptAfterTransition(order.order_id, mapped.toStatus);
    const banner = EFFECT_TO_BANNER[effect];
    res.redirect(303, `${backTo}?done=${mapped.toStatus}${banner ? `&betaling=${banner}` : ""}`);
  }
);
