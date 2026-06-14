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
 *
 * No payment. No seller notification (Phase 1 internal-only).
 * Anonymous buyer: cart token (buyer_ref) guards reads and mutations.
 */

import { Router, Request, Response } from "express";
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
} from "../services/cart-service";

// ─── Public cart/order router ────────────────────────────────────────────────
export const cartRouter = Router();

// ─── Admin order lifecycle router ────────────────────────────────────────────
export const adminOrderRouter = Router();

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
// Submit the cart. Re-checks availability of every item. Splits into one order
// per producer. No charge. No seller notification (Phase 1).
// Token required. Body: { buyer_ref?: string }
// ─────────────────────────────────────────────────────────────────────────────
cartRouter.post("/cart/:id/submit", (req: Request, res: Response) => {
  const token = extractToken(req);
  const check = checkCartToken(cartId(req), token);
  if (!check.ok) {
    res.status(check.status).json({ success: false, error: check.error });
    return;
  }

  const result = submitCart(cartId(req));
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
// POST /admin/marketplace/orders/:id/confirm|decline|ready|complete
// Admin-gated (X-Admin-Key). Transitions the order status.

const LIFECYCLE_ACTIONS = ["confirm", "decline", "ready", "complete"] as const;
const ACTION_TO_STATUS: Record<string, string> = {
  confirm: "confirmed",
  decline: "declined",
  ready:   "ready",
  complete: "completed",
};

for (const action of LIFECYCLE_ACTIONS) {
  adminOrderRouter.post(`/orders/:id/${action}`, (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const toStatus = ACTION_TO_STATUS[action]!;
    const result = transitionOrder(cartId(req), toStatus);

    if (!result.success) {
      res.status(result.status).json(result);
      return;
    }

    res.json(result);
  });
}
