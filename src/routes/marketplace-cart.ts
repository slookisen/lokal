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
  submitCart,
  getOrder,
  transitionOrder,
  getOrderByConfirmToken,
  addCartWish,
  chooseCartWishOffer,
  deleteCartWish,
} from "../services/cart-service";
import { cartWishesLimiter } from "../middleware/security";

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
// per producer eligible to receive one right now; every OTHER chosen producer
// (contact-mode wishes, or one that turned out ineligible) comes back as a
// contact_handoffs[] entry instead — no order row, no email.
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
cartRouter.post("/cart/:id/submit", cartWishesLimiter, (req: Request, res: Response) => {
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
  };

  const result = submitCart(cartId(req), contact);
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

// ─── Admin order lifecycle ────────────────────────────────────────────────────
// POST /admin/marketplace/orders/:id/confirm|decline|ready|complete|no-show
// Admin-gated (X-Admin-Key). Transitions the order status. "no-show" is the
// ready → cancelled path and stores cancel_reason='no_show' (pilot-ordre-loop).
// no-show on an order that is not 'ready' is rejected with 409 by the central
// guard in cart-service.transitionOrder (review fix, finding 3).

const LIFECYCLE_ACTIONS = ["confirm", "decline", "ready", "complete", "no-show"] as const;
const ACTION_TO_STATUS: Record<string, string> = {
  confirm:   "confirmed",
  decline:   "declined",
  ready:     "ready",
  complete:  "completed",
  "no-show": "cancelled",
};

for (const action of LIFECYCLE_ACTIONS) {
  adminOrderRouter.post(`/orders/:id/${action}`, (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const toStatus = ACTION_TO_STATUS[action]!;
    const result = transitionOrder(cartId(req), toStatus, {
      actor: "admin",
      cancelReason: action === "no-show" ? "no_show" : null,
    });

    if (!result.success) {
      res.status(result.status).json(result);
      return;
    }

    res.json(result);
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
const PRODUCER_ACTIONS: Record<string, { toStatus: string; cancelReason: string | null }> = {
  confirm:  { toStatus: "confirmed", cancelReason: null },
  decline:  { toStatus: "declined",  cancelReason: null },
  ready:    { toStatus: "ready",     cancelReason: null },
  complete: { toStatus: "completed", cancelReason: null },
  no_show:  { toStatus: "cancelled", cancelReason: "no_show" },
};

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

  const postTo = `/produsent/ordre/${encodeURIComponent(token)}`;
  const actionsHtml = (ACTIONS_FOR_STATUS[order.status] || [])
    .map(
      (a) =>
        `<form method="POST" action="${postTo}"><input type="hidden" name="action" value="${a.action}"><button type="submit" class="act-btn ${a.cls}">${a.label}</button></form>`
    )
    .join("\n    ");

  const itemsHtml = order.items
    .map(
      (i) =>
        `<div>${escapePageHtml(i.name_snapshot || "Vare")} — ${i.qty ?? "?"} stk${i.line_total != null ? ` (${i.line_total} kr)` : ""}</div>`
    )
    .join("\n      ");

  const timelineHtml = order.timeline.length
    ? `<div class="recap"><strong>Tidslinje:</strong>\n      ${order.timeline
        .map((e) => `<div>${escapePageHtml(e.created_at)}: ${escapePageHtml(e.from_status || "–")} → ${escapePageHtml(e.to_status)}</div>`)
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
</style>
</head>
<body>
<main class="container">
  <div class="confirm-panel">
    <h1>Henteordre hos ${escapePageHtml(order.producer_name)}</h1>
    <div class="ref">${escapePageHtml(orderRef)}</div>
    ${banner}
    <div class="status-line">Status: <strong>${escapePageHtml(statusLabel)}</strong>${order.cancel_reason === "no_show" ? " (ikke hentet)" : ""}</div>
    <div class="recap">
      <div><strong>Opprettet:</strong> ${escapePageHtml(order.created_at)}</div>
      ${order.pickup_time ? `<div><strong>Hentetid:</strong> ${escapePageHtml(order.pickup_time)}</div>` : ""}
      ${order.total_nok != null ? `<div><strong>Sum:</strong> ${order.total_nok} kr</div>` : ""}
      ${itemsHtml}
    </div>
    ${timelineHtml}
    ${actionsHtml}
    <p class="hint">Denne siden er for produsenten. Lenken er personlig for denne ordren — ikke del den videre. Ingen betaling skjer via plattformen.</p>
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
  (req: Request, res: Response) => {
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
    if (!mapped) {
      res.redirect(303, `${backTo}?error=ugyldig`);
      return;
    }

    const result = transitionOrder(order.order_id, mapped.toStatus, {
      actor: "producer",
      cancelReason: mapped.cancelReason,
    });
    res.redirect(303, result.success ? `${backTo}?done=${mapped.toStatus}` : `${backTo}?error=ugyldig`);
  }
);
