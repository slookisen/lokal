/**
 * Buyer order actions — Fase B1 of dev-request
 * 2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent.
 *
 * The buyer's two commands, shared by the MCP tools (lokal_order_cancel,
 * lokal_order_picked_up) and the web order card (/ordre/:id?ref=…):
 *
 *   cancel    : pending → the buyer's free `withdraw` (cancel_reason
 *               'buyer_cancelled', no trust event against the producer);
 *               confirmed/ready → `cancel` (forbrukerkjøpsloven § 41).
 *   picked_up : confirmed/ready → completed, completion_source 'buyer'.
 *
 * Every transition goes through applyOrderAction (Fase A1) with actor role
 * buyer; this module only authenticates the buyer (buyer_ref), picks the
 * action and shapes the answer. The producer e-mail on a withdraw / cancel is
 * sent by the action layer (order-notify-service.sendProducerBuyerCancelNotice).
 *
 * A wrong buyer_ref and an unknown order give the same 403 answer, so the
 * answer says nothing about whether an order exists.
 */

import { timingSafeEqual } from "crypto";
import {
  cartServiceDb,
  orderPaymentMode,
  PAYMENT_MODE_UNKNOWN,
  producerContact,
  producerTraderStatus,
  type ProducerContact,
} from "./cart-service";
import { applyOrderAction, cancelActionsEnabled, type OrderChannel } from "./order-actions";
import { buyerCancelAfterConfirmationText } from "./order-receipt-service";
import type { PaymentsStripeClient } from "./payment-provider";
import {
  isOrderMessagesEnabled, orderMessagesForAgent, orderTakesMessages, postOrderMessage,
  ORDER_MESSAGES_UNTRUSTED_NOTE, type OrderMessageView, type PostOrderMessageResult,
} from "./order-messages";

/** Default off. On: the MCP tools are listed and callable, and lokal_order_status carries the B1 fields. */
export const ORDER_AGENT_ACTIONS_FLAG = "ORDER_AGENT_ACTIONS_ENABLED";

export function isOrderAgentActionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[ORDER_AGENT_ACTIONS_FLAG];
  return v === "1" || v === "true";
}

export type BuyerAvailableAction = "withdraw" | "cancel" | "picked_up" | "message";
export type BuyerOrderCommand = "cancel" | "picked_up";

/** The answer for an unknown order and for a wrong buyer_ref alike. */
export const BUYER_ORDER_ACCESS_DENIED = "Order not found or buyer_ref does not match";

/** The error prefix when the expected cancel action no longer matches the order (review B1). */
export const EXPECTED_ACTION_MISMATCH = "expected_action_mismatch";

const BUYER_IDEM_RE = /^[A-Za-z0-9:_.-]{1,120}$/;

interface BuyerOrderRow {
  id: string;
  agent_id: string;
  buyer_ref: string;
  status: string;
  cancel_reason: string | null;
  completion_source: string | null;
  pickup_time: string | null;
  producer_name: string;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The order when `buyerRef` is its buyer_ref; null otherwise (unknown order or wrong ref). */
export function getBuyerOrderRow(orderId: string, buyerRef: unknown, db: any = cartServiceDb()): BuyerOrderRow | null {
  if (typeof orderId !== "string" || !orderId || typeof buyerRef !== "string" || !buyerRef) return null;
  const r = db.prepare(`
    SELECT o.id, o.agent_id, o.buyer_ref, o.status, o.cancel_reason, o.completion_source, o.pickup_time, a.name AS producer_name
    FROM orders o INNER JOIN agents a ON a.id = o.agent_id
    WHERE o.id = ?
  `).get(orderId) as BuyerOrderRow | undefined;
  if (!r || !sameToken(r.buyer_ref, buyerRef)) return null;
  return { ...r, completion_source: r.completion_source ?? null };
}

/**
 * The buyer actions open for an order in its current state. A cancellation of
 * an order that is (or may be) prepaid follows the same gate as every other
 * channel (cancelActionsEnabled). `message` (Fase B2) is added by
 * buyerOrderStatusExtras while ORDER_MESSAGES_ENABLED is on.
 */
export function buyerAvailableActions(status: string, paymentMode: string | null): BuyerAvailableAction[] {
  const cancels = cancelActionsEnabled(paymentMode);
  if (status === "pending") return cancels ? ["withdraw"] : [];
  if (status === "confirmed" || status === "ready") return cancels ? ["cancel", "picked_up"] : ["picked_up"];
  return [];
}

function paymentModeOf(db: any, orderId: string): string | null {
  try { return orderPaymentMode(db, orderId); } catch { return PAYMENT_MODE_UNKNOWN; }
}

/**
 * The fields Fase B1 adds to lokal_order_status (only while
 * ORDER_AGENT_ACTIONS_ENABLED is on). Fase B2: with ORDER_MESSAGES_ENABLED
 * also on, messages[] is the order's thread as quoted data ({from, text,
 * created_at}), messages_notice says that the text is untrusted, and
 * available_actions carries 'message' while the order takes messages.
 * Off: messages stays [] and nothing else changes.
 */
export function buyerOrderStatusExtras(orderId: string, db: any = cartServiceDb(), env: NodeJS.ProcessEnv = process.env): {
  available_actions: BuyerAvailableAction[];
  completion_source: string | null;
  messages: OrderMessageView[];
  messages_notice?: string;
} {
  const r = db.prepare("SELECT status, completion_source, updated_at FROM orders WHERE id = ?").get(orderId) as
    | { status: string; completion_source: string | null; updated_at: string | null }
    | undefined;
  const actions: BuyerAvailableAction[] = r ? buyerAvailableActions(r.status, paymentModeOf(db, orderId)) : [];
  if (!isOrderMessagesEnabled(env)) {
    return { available_actions: actions, completion_source: r?.completion_source ?? null, messages: [] };
  }
  if (r && orderTakesMessages(r)) actions.push("message");
  return {
    available_actions: actions,
    completion_source: r?.completion_source ?? null,
    messages: r ? orderMessagesForAgent(orderId, db) : [],
    messages_notice: ORDER_MESSAGES_UNTRUSTED_NOTE,
  };
}

export type BuyerOrderMessageResult =
  | Extract<PostOrderMessageResult, { success: true }>
  | { success: false; status: number; error: string; code?: string };

/**
 * Fase B2: the buyer writes one message on one order (MCP lokal_order_message,
 * the order card), authenticated with the buyer_ref like the B1 commands
 * (wrong ref and unknown order → the same 403). The key is namespaced "b:".
 */
export async function postBuyerOrderMessage(
  orderId: string,
  buyerRef: unknown,
  message: unknown,
  channel: "mcp" | "web",
  opts: { idempotencyKey?: string | null; now?: Date; env?: NodeJS.ProcessEnv } = {},
): Promise<BuyerOrderMessageResult> {
  if (!isOrderMessagesEnabled(opts.env)) return { success: false, status: 404, code: "disabled", error: "Order messages are not available" };
  const order = getBuyerOrderRow(orderId, buyerRef);
  if (!order) return { success: false, status: 403, error: BUYER_ORDER_ACCESS_DENIED };
  let key: string | null = null;
  if (opts.idempotencyKey != null && String(opts.idempotencyKey) !== "") {
    const raw = String(opts.idempotencyKey);
    if (!BUYER_IDEM_RE.test(raw)) {
      return { success: false, status: 400, error: "idempotency_key must be 1–120 characters [A-Za-z0-9:_.-]" };
    }
    key = `b:${raw}`;
  }
  return postOrderMessage(order.id, "buyer", message, channel, { idempotencyKey: key, now: opts.now, env: opts.env });
}

export type BuyerOrderCommandResult =
  | {
      success: true;
      order_id: string;
      action: BuyerAvailableAction;
      status: string;
      replayed: boolean;
      cancel_reason?: string | null;
      completion_source?: string | null;
      /** cancel after confirmation: what applies (forbrukerkjøpsloven § 41, or the Sale of Goods Act for a non-trader). */
      consumer_law_note?: string;
      producer_contact: ProducerContact;
    }
  | { success: false; status: number; error: string; conflict?: boolean };

/**
 * One buyer command on one order, authenticated with the buyer_ref. The
 * caller's idempotency key is namespaced ("b:"), so it never collides with a
 * seller's key on the same order.
 */
export async function applyBuyerOrderCommand(
  orderId: string,
  buyerRef: unknown,
  command: BuyerOrderCommand,
  channel: Extract<OrderChannel, "mcp" | "web" | "a2a">,
  opts: {
    idempotencyKey?: string | null;
    /**
     * cancel only: the action the buyer saw offered (lokal_order_status
     * available_actions, or the card's form). When the order has moved on
     * since (e.g. the producer confirmed a pending order, so a free withdraw
     * would now be a binding § 41 cancel), nothing happens: 409.
     */
    expectedAction?: "withdraw" | "cancel" | null;
    payments?: PaymentsStripeClient | null;
    now?: Date;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<BuyerOrderCommandResult> {
  const db = cartServiceDb();
  const order = getBuyerOrderRow(orderId, buyerRef, db);
  if (!order) return { success: false, status: 403, error: BUYER_ORDER_ACCESS_DENIED };

  let key: string | null = null;
  if (opts.idempotencyKey != null && String(opts.idempotencyKey) !== "") {
    const raw = String(opts.idempotencyKey);
    if (!BUYER_IDEM_RE.test(raw)) {
      return { success: false, status: 400, error: "idempotency_key must be 1–120 characters [A-Za-z0-9:_.-]" };
    }
    key = `b:${raw}`;
  }

  let action: BuyerAvailableAction;
  if (command === "picked_up") {
    action = "picked_up";
  } else {
    // A repeat of a key keeps the action of the first call (the order is no
    // longer pending then), so the replay answers as the first call did.
    const prev = key === null ? undefined : db.prepare(
      "SELECT from_status FROM order_events WHERE order_id = ? AND idempotency_key = ? ORDER BY created_at, rowid LIMIT 1",
    ).get(order.id, key) as { from_status: string | null } | undefined;
    const from = prev ? prev.from_status : order.status;
    action = from === "pending" ? "withdraw" : "cancel";
    // Review B1 (stale tab): never turn a free withdraw into a binding cancel
    // (or the reverse) behind the buyer's back. For a replay, `action` is the
    // stored event's action, so the check compares against what was done.
    if (opts.expectedAction != null && opts.expectedAction !== action) {
      return {
        success: false,
        status: 409,
        error: `${EXPECTED_ACTION_MISMATCH}: expected '${opts.expectedAction}', but the order now allows '${action}' (status '${order.status}'). Nothing was changed; check lokal_order_status and ask the user again.`,
      };
    }
  }

  const r = await applyOrderAction(
    order.id, action,
    { role: "buyer", channel, ref: `${channel}:${order.id.slice(0, 8)}` },
    { idempotencyKey: key, payments: opts.payments ?? null, now: opts.now, env: opts.env },
  );
  if (!r.success) return r;

  const after = db.prepare("SELECT cancel_reason, completion_source FROM orders WHERE id = ?").get(order.id) as
    | { cancel_reason: string | null; completion_source: string | null }
    | undefined;
  const out: BuyerOrderCommandResult = {
    success: true,
    order_id: order.id,
    action,
    status: r.status,
    replayed: r.replayed,
    producer_contact: producerContact(order.agent_id, order.producer_name),
  };
  if (r.status === "cancelled") out.cancel_reason = after?.cancel_reason ?? null;
  if (r.status === "completed") out.completion_source = after?.completion_source ?? null;
  if (action === "cancel") out.consumer_law_note = buyerCancelAfterConfirmationText(order.producer_name, producerTraderStatus(db, order.agent_id));
  return out;
}
