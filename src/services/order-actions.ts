/**
 * Order-action layer — Fase A1 of dev-request
 * 2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent.
 *
 * ONE function every channel uses to act on an order:
 *
 *   applyOrderAction(orderId, action, actor: { role, channel, ref }, opts)
 *
 * Channels today: the producer page (/produsent/ordre/:token), the admin
 * lifecycle routes and the follow-ups job (order-followups.ts). «Mine ordrer»,
 * MCP and A2A will call the same function later (Fase A2/B — not built here).
 *
 *   seller : confirm (optional pickup time), decline, no_show, buyer_cancelled,
 *            cannot_deliver — plus the existing page buttons «Hentet»
 *            (complete) and the legacy «Klar for henting» (mark_ready).
 *   buyer  : withdraw (pending), cancel (after confirmation), picked_up,
 *            message — the buyer channels are MCP (lokal_order_cancel /
 *            lokal_order_picked_up) and the order card /ordre/:id (Fase B1,
 *            buyer-order-actions.ts); `message` is answered 501 until Fase B2.
 *   system : auto_complete, producer_no_response (only for an order whose
 *            producer e-mail was sent, notify_sent_at), payment_expired.
 *   admin  : everything.
 *
 * What happens on a successful action:
 *   1. cart-service.transitionOrder() writes the status change and ONE
 *      order_events row with actor_role + channel (+ the idempotency key) in
 *      one transaction; completed orders get orders.completion_source.
 *   2. The existing payment step (payment-service.onOrderTransitioned) runs
 *      when the caller passes a payments client — unchanged money rules
 *      (confirm → capture, decline/cancel → release/refund, no_show → kept).
 *      The automatic close never gets a payment step: it moves no money.
 *   3. The existing buyer receipt (ORDER_BUYER_RECEIPTS_ENABLED) for
 *      confirmed / declined / cancelled — fire-and-forget.
 *
 * Idempotency: a repeated idempotencyKey on the same order returns the stored
 * transition (replayed: true) without a new transition, payment step or
 * receipt. Failed attempts store nothing, so they can be retried.
 *
 * Conflict: a buyer «picked_up» on an order the seller already recorded as a
 * no-show, or a seller «no_show» on an order the buyer already reported as
 * picked up, within ORDER_AUTOCOMPLETE_GRACE_HOURS — is NOT decided
 * automatically: no status change, an admin alert, 409 with conflict: true.
 */

import {
  transitionOrder,
  orderPaymentMode,
  PAYMENT_MODE_UNKNOWN,
  IDEMPOTENCY_KEY_TAKEN,
  cartServiceDb,
  type OrderActorRole,
  type OrderCompletionSource,
} from "./cart-service";
import { isPaymentsLifecycleActive, onOrderTransitioned, type OrderPaymentEffect } from "./payment-service";
import type { PaymentsStripeClient } from "./payment-provider";
import { sendBuyerOrderReceipt, type ReceiptEvent } from "./order-receipt-service";
import { sendAdminOrderAlert, sendProducerBuyerCancelNotice } from "./order-notify-service";
import {
  autoCompleteDueMs,
  isOrderAutocompleteEnabled,
  noShowEarliestMs,
  normalizePickupTime,
  orderAutocompleteGraceHours,
  parseOrderTimestamp,
} from "./order-lifecycle";

let _actionsTestDb: any = null;
export function __setOrderActionsTestDb(db: any): void { _actionsTestDb = db; }

export type OrderAction =
  // seller
  | "confirm" | "decline" | "no_show" | "buyer_cancelled" | "cannot_deliver" | "complete" | "mark_ready"
  // buyer
  | "withdraw" | "cancel" | "picked_up" | "message"
  // system
  | "auto_complete" | "producer_no_response" | "payment_expired";

export type OrderChannel = "producer_page" | "owner_portal" | "admin" | "system_job" | "mcp" | "a2a" | "web";

export interface OrderActor {
  role: OrderActorRole;
  channel: OrderChannel;
  /** Free-form reference for logs (job name, admin, token prefix). Never personal data. */
  ref?: string | null;
}

export interface OrderActionOptions {
  idempotencyKey?: string | null;
  /** confirm only: the pickup time (ISO, or datetime-local in Oslo time). */
  pickupTime?: string | null;
  /** Free-text reason for logs; the stored cancel_reason comes from the action. */
  reason?: string | null;
  /** The payment step's Stripe client; null/absent = no payment step (payments off, system jobs). */
  payments?: PaymentsStripeClient | null;
  /** Injectable clock and env (tests). */
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export type OrderActionResult =
  | {
      success: true;
      order_id: string;
      action: OrderAction;
      status: string;
      replayed: boolean;
      payment_effect: OrderPaymentEffect;
    }
  | { success: false; status: number; error: string; conflict?: boolean };

interface ActionSpec {
  from: string[];
  to: string;
  cancelReason?: string;
  /** completion source; "actor" = from the actor's role (seller/admin). */
  completion?: OrderCompletionSource | "actor";
  /** A cancellation that may involve a captured prepayment (F5 gate). */
  cancelGate?: boolean;
}

// `ready` is the legacy «Klar for henting» status — handled like `confirmed`.
const OPEN_CONFIRMED = ["confirmed", "ready"];

const ACTION_SPECS: Record<Exclude<OrderAction, "message">, ActionSpec> = {
  confirm:              { from: ["pending"], to: "confirmed" },
  decline:              { from: ["pending"], to: "declined" },
  no_show:              { from: OPEN_CONFIRMED, to: "cancelled", cancelReason: "no_show" },
  buyer_cancelled:      { from: ["pending", ...OPEN_CONFIRMED], to: "cancelled", cancelReason: "buyer_cancelled", cancelGate: true },
  cannot_deliver:       { from: OPEN_CONFIRMED, to: "cancelled", cancelReason: "producer_cancelled", cancelGate: true },
  complete:             { from: OPEN_CONFIRMED, to: "completed", completion: "actor" },
  mark_ready:           { from: ["confirmed"], to: "ready" },
  withdraw:             { from: ["pending"], to: "cancelled", cancelReason: "buyer_cancelled", cancelGate: true },
  cancel:               { from: OPEN_CONFIRMED, to: "cancelled", cancelReason: "buyer_cancelled", cancelGate: true },
  picked_up:            { from: OPEN_CONFIRMED, to: "completed", completion: "buyer" },
  auto_complete:        { from: OPEN_CONFIRMED, to: "completed", completion: "auto" },
  producer_no_response: { from: ["pending"], to: "cancelled", cancelReason: "producer_no_response" },
  payment_expired:      { from: ["pending"], to: "cancelled", cancelReason: "payment_expired" },
};

export const ACTIONS_BY_ROLE: Record<OrderActorRole, ReadonlySet<OrderAction>> = {
  seller: new Set<OrderAction>(["confirm", "decline", "no_show", "buyer_cancelled", "cannot_deliver", "complete", "mark_ready"]),
  buyer:  new Set<OrderAction>(["withdraw", "cancel", "picked_up", "message"]),
  system: new Set<OrderAction>(["auto_complete", "producer_no_response", "payment_expired"]),
  admin:  new Set<OrderAction>([
    "confirm", "decline", "no_show", "buyer_cancelled", "cannot_deliver", "complete", "mark_ready",
    "withdraw", "cancel", "picked_up", "message", "auto_complete", "producer_no_response", "payment_expired",
  ]),
};

export function isOrderAction(a: string): a is OrderAction {
  return a === "message" || Object.prototype.hasOwnProperty.call(ACTION_SPECS, a);
}

/**
 * F5 / skive 1b (S6), moved here from the producer page so every channel shares
 * it: a cancellation of an order that is (or may be) a prepay order only while
 * the payment lifecycle is on, as a captured payment must be refunded.
 */
export function cancelActionsEnabled(paymentMode: string | null | undefined): boolean {
  const mayBePrepay = paymentMode === "prepay" || paymentMode === PAYMENT_MODE_UNKNOWN;
  return !mayBePrepay || isPaymentsLifecycleActive();
}

const IDEM_KEY_RE = /^[A-Za-z0-9:_.-]{1,128}$/;

function legacyActor(role: OrderActorRole): string {
  return role === "seller" ? "producer" : role;
}

function receiptEventFor(toStatus: string): ReceiptEvent | null {
  return toStatus === "confirmed" || toStatus === "declined" || toStatus === "cancelled" ? toStatus : null;
}

/** The time the order was confirmed (first order_events row into 'confirmed'), else updated_at. */
export function orderConfirmedAt(db: any, orderId: string): string | null {
  const r = db.prepare(`
    SELECT COALESCE(
      (SELECT MIN(e.created_at) FROM order_events e WHERE e.order_id = o.id AND e.to_status = 'confirmed'),
      o.updated_at) AS confirmed_at
    FROM orders o WHERE o.id = ?
  `).get(orderId) as { confirmed_at: string | null } | undefined;
  return r?.confirmed_at ?? null;
}

export async function applyOrderAction(
  orderId: string,
  action: string,
  actor: OrderActor,
  opts: OrderActionOptions = {},
): Promise<OrderActionResult> {
  // Same DB as transitionOrder writes to (cart-service's pin, else getDb()).
  const db = _actionsTestDb ?? cartServiceDb();
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;

  if (!isOrderAction(action)) return { success: false, status: 400, error: `Unknown order action '${action}'` };
  const allowedForRole = ACTIONS_BY_ROLE[actor.role];
  if (!allowedForRole || !allowedForRole.has(action)) {
    return { success: false, status: 403, error: `Action '${action}' is not allowed for role '${actor.role}'` };
  }

  const idemKey = opts.idempotencyKey != null && String(opts.idempotencyKey) !== "" ? String(opts.idempotencyKey) : null;
  if (idemKey !== null && !IDEM_KEY_RE.test(idemKey)) {
    return { success: false, status: 400, error: "idempotencyKey must be 1–128 characters [A-Za-z0-9:_.-]" };
  }

  const order = db.prepare(`
    SELECT id, agent_id, status, cancel_reason, completion_source, pickup_time, notify_sent_at, updated_at
    FROM orders WHERE id = ?
  `).get(orderId) as
    | {
        id: string; agent_id: string; status: string; cancel_reason: string | null; completion_source: string | null;
        pickup_time: string | null; notify_sent_at: string | null; updated_at: string;
      }
    | undefined;
  if (!order) return { success: false, status: 404, error: "Order not found" };

  if (action === "message") {
    return { success: false, status: 501, error: "Order messages are not available yet" };
  }
  const spec = ACTION_SPECS[action];

  // AC5: the same key + the same action on the same order → the stored
  // transition, no new one. The same key with a DIFFERENT action is a key
  // collision (S9): 409, never a silent «success».
  if (idemKey !== null) {
    const replay = findReplay(db, orderId, idemKey, action, actor.role);
    if (replay) return replay;
  }

  // Conflict (AC2): buyer and seller contradict each other within the grace
  // window. Never decided automatically: admin alert, no status change.
  const conflict = detectConflict(action, actor.role, order, now, env);
  if (conflict) {
    console.error(`[order-actions] CONFLICT order=${orderId} action=${action} role=${actor.role} status=${order.status}`);
    void sendAdminOrderAlert(
      `Motstrid på ordre ${orderId.slice(0, 8)}: ${conflict.short}`,
      `Ordre ${orderId} (produsent ${order.agent_id}): ${conflict.detail} ` +
        `Plattformen avgjør ikke dette automatisk, og ordrestatusen er uendret (${order.status}). ` +
        `Kanal: ${actor.channel}. Avklar med kjøper og produsent, og rett ordren manuelt ved behov.`,
    ).catch(() => { /* never fails the action */ });
    return { success: false, status: 409, error: conflict.short, conflict: true };
  }

  if (!spec.from.includes(order.status)) {
    return {
      success: false,
      status: 409,
      error: `Action '${action}' is not possible for an order in '${order.status}'`,
    };
  }

  // S2: «Kunden kom ikke» only once the pickup time has passed (without a
  // pickup time: confirmation + ORDER_NO_SHOW_MIN_HOURS). Admin may correct anytime.
  if (action === "no_show" && actor.role !== "admin") {
    const earliest = noShowEarliestMs({ pickup_time: order.pickup_time, confirmed_at: orderConfirmedAt(db, orderId) }, env);
    if (earliest !== null && now.getTime() < earliest) {
      return { success: false, status: 409, error: "no_show is only possible after the pickup time" };
    }
  }

  if (spec.cancelGate) {
    let mode: string | null;
    try { mode = orderPaymentMode(db, orderId); } catch { mode = PAYMENT_MODE_UNKNOWN; }
    if (!cancelActionsEnabled(mode)) {
      return { success: false, status: 409, error: "cancellation of a prepay order requires PAYMENTS_ENABLED=1 or drain" };
    }
  }

  if (action === "producer_no_response" && !order.notify_sent_at) {
    // Skive 1b (B1): an order the producer never received is never «not answered».
    return { success: false, status: 409, error: "producer_no_response needs an order whose producer e-mail was sent" };
  }

  if (action === "auto_complete") {
    if (!isOrderAutocompleteEnabled(env)) {
      return { success: false, status: 409, error: "automatic close is off (ORDER_AUTOCOMPLETE_ENABLED)" };
    }
    const due = autoCompleteDueMs({ pickup_time: order.pickup_time, confirmed_at: orderConfirmedAt(db, orderId) }, env);
    if (due === null || now.getTime() < due) {
      return { success: false, status: 409, error: "the order is not due for the automatic close yet" };
    }
  }

  let pickupTime: string | null = null;
  if (opts.pickupTime != null && String(opts.pickupTime).trim() !== "") {
    if (action !== "confirm") return { success: false, status: 400, error: "pickupTime is only accepted with confirm" };
    const norm = normalizePickupTime(opts.pickupTime, now);
    if (norm === "invalid") return { success: false, status: 400, error: "pickupTime is not a valid time" };
    pickupTime = norm;
  }

  const completionSource: OrderCompletionSource | null =
    spec.completion === "actor" ? (actor.role === "admin" ? "admin" : actor.role === "buyer" ? "buyer" : "seller")
    : spec.completion ?? null;

  const t = transitionOrder(orderId, spec.to, {
    actor: legacyActor(actor.role),
    actorRole: actor.role,
    channel: actor.channel,
    cancelReason: spec.cancelReason ?? null,
    idempotencyKey: idemKey,
    completionSource,
    pickupTime,
  });
  if (!t.success) {
    if (idemKey !== null && t.error === IDEMPOTENCY_KEY_TAKEN) {
      const replay = findReplay(db, orderId, idemKey, action, actor.role);
      if (replay) return replay;
      return { success: false, status: 409, error: IDEM_KEY_CONFLICT };
    }
    return t;
  }
  console.log(
    `[order-actions] order=${orderId} action=${action} role=${actor.role} channel=${actor.channel}` +
    `${actor.ref ? ` ref=${actor.ref}` : ""} ${order.status}→${spec.to}`,
  );

  // Payment step (unchanged rules). The automatic close moves no money.
  let payment_effect: OrderPaymentEffect = "none";
  if (opts.payments && action !== "auto_complete") {
    payment_effect = await onOrderTransitioned({
      db, stripe: opts.payments, orderId, toStatus: spec.to, cancelReason: spec.cancelReason ?? null,
    });
  }

  const receipt = receiptEventFor(spec.to);
  if (receipt) void sendBuyerOrderReceipt(orderId, receipt).catch(() => { /* never fails the action */ });
  // Fase B1: the buyer's own withdraw / cancel (MCP, order card) is told to
  // the producer by e-mail. Not for a replay (returned above) or an admin.
  if (actor.role === "buyer" && (action === "withdraw" || action === "cancel")) {
    void sendProducerBuyerCancelNotice(orderId, action).catch(() => { /* never fails the action */ });
  }

  return { success: true, order_id: orderId, action, status: spec.to, replayed: false, payment_effect };
}

const IDEM_KEY_CONFLICT = "idempotencyKey was already used for a different action on this order";

/**
 * The stored transition for (order, key), or null when the key is unused.
 * A key that was used for a different action (other target status, cancel
 * reason or completion source) is a 409 collision, not a replay.
 */
function findReplay(db: any, orderId: string, key: string, action: Exclude<OrderAction, "message">, role: OrderActorRole): OrderActionResult | null {
  const ev = db.prepare(
    "SELECT to_status FROM order_events WHERE order_id = ? AND idempotency_key = ? ORDER BY created_at, rowid LIMIT 1",
  ).get(orderId, key) as { to_status: string } | undefined;
  if (!ev) return null;
  const spec = ACTION_SPECS[action];
  let same = ev.to_status === spec.to;
  if (same && (spec.to === "cancelled" || spec.to === "completed")) {
    const o = db.prepare("SELECT cancel_reason, completion_source FROM orders WHERE id = ?")
      .get(orderId) as { cancel_reason: string | null; completion_source: string | null } | undefined;
    if (spec.to === "cancelled") same = (o?.cancel_reason ?? null) === (spec.cancelReason ?? null);
    else {
      const expected = spec.completion === "actor" ? (role === "admin" ? "admin" : role === "buyer" ? "buyer" : "seller") : spec.completion ?? null;
      same = (o?.completion_source ?? null) === expected;
    }
  }
  if (!same) return { success: false, status: 409, error: IDEM_KEY_CONFLICT };
  return { success: true, order_id: orderId, action, status: ev.to_status, replayed: true, payment_effect: "none" };
}

function detectConflict(
  action: OrderAction,
  role: OrderActorRole,
  order: { status: string; cancel_reason: string | null; completion_source: string | null; updated_at: string },
  now: Date,
  env: NodeJS.ProcessEnv,
): { short: string; detail: string } | null {
  if (role === "admin") return null; // admin resolves; plain rules apply
  const closedMs = parseOrderTimestamp(order.updated_at);
  if (!Number.isFinite(closedMs)) return null;
  const withinGrace = now.getTime() - closedMs <= orderAutocompleteGraceHours(env) * 3600_000;
  if (!withinGrace) return null;
  if (action === "no_show" && order.status === "completed" && order.completion_source === "buyer") {
    return {
      short: "kjøperen har meldt henting, produsenten melder «kom ikke»",
      detail: "Kjøperen har meldt at varene er hentet, men produsenten vil registrere at kunden ikke kom.",
    };
  }
  if (action === "picked_up" && order.status === "cancelled" && order.cancel_reason === "no_show") {
    return {
      short: "produsenten har meldt «kom ikke», kjøperen melder henting",
      detail: "Produsenten har registrert at kunden ikke kom, men kjøperen melder at varene er hentet.",
    };
  }
  return null;
}
