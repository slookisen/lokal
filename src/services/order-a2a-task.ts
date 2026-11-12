/**
 * The pickup order as an A2A Task — Fase B3 of dev-request
 * 2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent.
 *
 * RFB's JSON-RPC endpoint (/a2a, routes/a2a.ts) answers `tasks/get` and
 * `tasks/cancel` for a pickup order, behind ORDER_AGENT_ACTIONS_ENABLED (the
 * B1 switch for the buyer's agent actions, default off). Off, nothing here is
 * reached: tasks/get answers as before, tasks/cancel is "Method not found"
 * and the agent cards are unchanged.
 *
 * Addressing. An order's Task id is `order:<order_id>`; marketplace tasks
 * (the `tasks` table) have bare UUIDs, so the prefix keeps the two apart. A
 * bare order_id (as lokal_cart_submit returns it) is accepted too, but only
 * with a buyer_ref in the metadata and only when no marketplace task has that
 * id, so every existing task id answers exactly as before.
 *
 * Authentication. The buyer sends `buyer_ref` in `params.metadata` (same
 * token as REST GET /api/marketplace/orders/:id, MCP lokal_order_status and
 * lokal_order_cancel). A wrong buyer_ref and an unknown order give the same
 * error (-32001, data.status 403), as B1's tools do: the answer says less
 * about whether an order exists than REST (404 vs 403) does.
 *
 * State mapping (A2A TaskState):
 *   pending → submitted · confirmed → working · ready → working (a confirmed
 *   order that is ready for pickup; still in progress, not done) ·
 *   completed → completed · declined / cancelled → canceled.
 *
 * tasks/cancel runs the buyer's `cancel` command through the same layer as
 * MCP lokal_order_cancel (applyBuyerOrderCommand → applyOrderAction), with
 * channel 'a2a' and actor role buyer: pending → free withdraw
 * (cancel_reason 'buyer_cancelled', no trust event, producer e-mailed);
 * confirmed/ready → § 41 cancel with the same consumer_law_note.
 * idempotency_key and expected_action in metadata work as in the MCP tool.
 */

import {
  cartServiceDb,
  getOrder,
  orderPaymentMode,
  PAYMENT_MODE_UNKNOWN,
} from "./cart-service";
import {
  applyBuyerOrderCommand,
  buyerAvailableActions,
  getBuyerOrderRow,
  BUYER_ORDER_ACCESS_DENIED,
} from "./buyer-order-actions";
import { isOrderAgentActionsEnabled } from "./order-agent-actions-flag";
import { isPaymentsLifecycleActive, resolvePaymentsStripeClient } from "./payment-service";
export { managePickupOrderSkill, rfbJsonRpcMethods } from "./order-a2a-card";
import type { PaymentsStripeClient } from "./payment-provider";

export { isOrderAgentActionsEnabled };

/** The prefix of an order's A2A Task id. */
export const ORDER_TASK_PREFIX = "order:";

/** A2A error codes (spec §8.2): TaskNotFoundError, TaskNotCancelableError. */
export const A2A_TASK_NOT_FOUND = -32001;
export const A2A_TASK_NOT_CANCELABLE = -32002;

export type A2aTaskState = "submitted" | "working" | "completed" | "canceled" | "unknown";

/** Order status → A2A TaskState. `ready` is a confirmed order ready for pickup: still working. */
export function orderStatusToTaskState(status: string): A2aTaskState {
  switch (status) {
    case "pending": return "submitted";
    case "confirmed":
    case "ready": return "working";
    case "completed": return "completed";
    case "declined":
    case "cancelled": return "canceled";
    default: return "unknown";
  }
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → ISO 8601; other strings pass through. */
export function sqliteToIso(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const s = String(ts);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return `${s.replace(" ", "T")}.000Z`;
  return s;
}

export interface OrderTaskTransition {
  state: A2aTaskState;
  order_status: string;
  from_order_status: string | null;
  timestamp: string | null;
  actor_role: string | null;
  channel: string | null;
}

/**
 * The order's state history: its creation (pending → submitted, from
 * orders.created_at; submit writes no event row), then one entry per
 * order_events row in time order.
 */
export function orderStateTransitionHistory(orderId: string, db: any = cartServiceDb()): OrderTaskTransition[] {
  const order = db.prepare("SELECT created_at FROM orders WHERE id = ?").get(orderId) as { created_at: string | null } | undefined;
  if (!order) return [];
  const out: OrderTaskTransition[] = [{
    state: "submitted", order_status: "pending", from_order_status: null,
    timestamp: sqliteToIso(order.created_at), actor_role: "buyer", channel: null,
  }];
  let rows: Array<{ from_status: string | null; to_status: string; actor_role: string | null; channel: string | null; created_at: string | null }> = [];
  try {
    rows = db.prepare(`
      SELECT from_status, to_status, actor_role, channel, created_at
      FROM order_events
      WHERE order_id = ?
      ORDER BY created_at, rowid
    `).all(orderId);
  } catch { rows = []; }
  for (const r of rows) {
    out.push({
      state: orderStatusToTaskState(r.to_status),
      order_status: r.to_status,
      from_order_status: r.from_status ?? null,
      timestamp: sqliteToIso(r.created_at),
      actor_role: r.actor_role ?? null,
      channel: r.channel ?? null,
    });
  }
  return out;
}

function paymentModeOf(db: any, orderId: string): string | null {
  try { return orderPaymentMode(db, orderId); } catch { return PAYMENT_MODE_UNKNOWN; }
}

/**
 * The A2A Task for an order the buyer has already been authenticated for
 * (buyer_ref checked). Same envelope as the marketplace tasks (status as
 * {state, timestamp}, artifacts as data parts); the order detail is the
 * lokal_order_status / REST order view.
 */
export function buildOrderTask(orderId: string, buyerRef: string, db: any = cartServiceDb()): any | null {
  const o = db.prepare(`
    SELECT id, status, cancel_reason, completion_source, pickup_time, created_at, updated_at
    FROM orders WHERE id = ?
  `).get(orderId) as
    | { id: string; status: string; cancel_reason: string | null; completion_source: string | null; pickup_time: string | null; created_at: string | null; updated_at: string | null }
    | undefined;
  if (!o) return null;
  const view = getOrder(o.id, buyerRef);
  const taskId = `${ORDER_TASK_PREFIX}${o.id}`;
  const detail = view.success ? (({ success: _s, ...rest }) => rest)(view) : null;
  return {
    kind: "task",
    id: taskId,
    contextId: taskId,
    status: { state: orderStatusToTaskState(o.status), timestamp: sqliteToIso(o.updated_at) ?? new Date().toISOString() },
    stateTransitionHistory: orderStateTransitionHistory(o.id, db),
    artifacts: detail ? [{ artifactId: `${taskId}:detail`, name: "pickup-order", parts: [{ kind: "data", data: detail }] }] : [],
    metadata: {
      order_id: o.id,
      order_status: o.status,
      cancel_reason: o.cancel_reason ?? null,
      completion_source: o.completion_source ?? null,
      pickup_time: o.pickup_time ?? null,
      // 'withdraw' / 'cancel' = tasks/cancel on this task.
      available_actions: buyerAvailableActions(o.status, paymentModeOf(db, o.id)),
    },
  };
}

type RpcError = { code: number; message: string; data?: unknown };
export type OrderTaskRpcResult = { result: any } | { error: RpcError };

function metadataOf(params: any): Record<string, unknown> {
  const m = params?.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? m : {};
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Whether a tasks/get / tasks/cancel addresses an order: the "order:" prefix,
 * or a bare id with a buyer_ref in metadata that no marketplace task has.
 * Returns the order id, or null for the existing task path.
 */
export function orderIdForTaskRequest(taskId: string, params: any, marketplaceTaskExists: (id: string) => boolean): string | null {
  if (taskId.startsWith(ORDER_TASK_PREFIX)) return taskId.slice(ORDER_TASK_PREFIX.length);
  if (nonEmptyString(metadataOf(params).buyer_ref) && !marketplaceTaskExists(taskId)) return taskId;
  return null;
}

const accessDenied = (): { error: RpcError } => ({
  error: { code: A2A_TASK_NOT_FOUND, message: BUYER_ORDER_ACCESS_DENIED, data: { status: 403 } },
});

const missingBuyerRef = (): { error: RpcError } => ({
  error: { code: -32602, message: "Invalid params: 'metadata.buyer_ref' required for an order task" },
});

/** tasks/get for an order. */
export function getOrderTask(orderId: string, params: any, db: any = cartServiceDb()): OrderTaskRpcResult {
  const buyerRef = nonEmptyString(metadataOf(params).buyer_ref);
  if (!buyerRef) return missingBuyerRef();
  const row = getBuyerOrderRow(orderId, buyerRef, db);
  if (!row) return accessDenied();
  const task = buildOrderTask(row.id, buyerRef, db);
  if (!task) return accessDenied();
  return { result: { task } };
}

/** tasks/cancel for an order: the buyer's withdraw (pending) or § 41 cancel (confirmed/ready). */
export async function cancelOrderTask(
  orderId: string,
  params: any,
  opts: { payments?: PaymentsStripeClient | null; now?: Date; env?: NodeJS.ProcessEnv; db?: any } = {},
): Promise<OrderTaskRpcResult> {
  const meta = metadataOf(params);
  const buyerRef = nonEmptyString(meta.buyer_ref);
  if (!buyerRef) return missingBuyerRef();
  const expected = meta.expected_action;
  if (expected != null && expected !== "withdraw" && expected !== "cancel") {
    return { error: { code: -32602, message: "Invalid params: 'metadata.expected_action' must be 'withdraw' or 'cancel'" } };
  }
  const idem = meta.idempotency_key;
  if (idem != null && typeof idem !== "string") {
    return { error: { code: -32602, message: "Invalid params: 'metadata.idempotency_key' must be a string" } };
  }
  const payments = opts.payments !== undefined
    ? opts.payments
    : (isPaymentsLifecycleActive() ? resolvePaymentsStripeClient() : null);
  const r = await applyBuyerOrderCommand(orderId, buyerRef, "cancel", "a2a", {
    idempotencyKey: (idem as string | undefined) ?? null,
    expectedAction: (expected as "withdraw" | "cancel" | undefined) ?? null,
    payments,
    now: opts.now,
    env: opts.env,
  });
  if (!r.success) {
    if (r.status === 403 || r.status === 404) return accessDenied();
    if (r.status === 400) return { error: { code: -32602, message: `Invalid params: ${r.error}` } };
    return { error: { code: A2A_TASK_NOT_CANCELABLE, message: r.error, data: { status: r.status } } };
  }
  const db = opts.db ?? cartServiceDb();
  const task = buildOrderTask(r.order_id, buyerRef, db);
  if (!task) return accessDenied();
  task.metadata.cancellation = {
    action: r.action,
    replayed: r.replayed,
    cancel_reason: r.cancel_reason ?? null,
    ...(r.consumer_law_note ? { consumer_law_note: r.consumer_law_note } : {}),
    producer_contact: r.producer_contact,
  };
  return { result: { task } };
}
