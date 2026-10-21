/**
 * Order follow-ups (F4) — dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel.
 *
 * An order must never die silently. Hourly pass over pay-at-pickup orders:
 *
 *   1. A producer e-mail that FAILED to send (orders.notify_failed_at, set by
 *      order-notify-service) is re-sent once (orders.notify_retried_at). The
 *      admin was told about the first failure at once.
 *   2. A `pending` order older than ORDER_REMINDER_HOURS (default 24) gets ONE
 *      reminder to the producer (same tokenized link) and the admin gets an
 *      alert at the same time (orders.reminder_sent_at; never again).
 *   3. A `pending` order older than ORDER_AUTOCANCEL_HOURS (default 72) is set
 *      to `cancelled` with cancel_reason `producer_no_response`. That is not a
 *      decline: cart-service.transitionOrder writes no `order_declined` trust
 *      event for it. The buyer gets the cancellation receipt with the
 *      producer's contact details when ORDER_BUYER_RECEIPTS_ENABLED=1.
 *
 * Steps 2 and 3 only apply to orders the producer actually RECEIVED
 * (orders.notify_sent_at, skive 1b / B1). An order whose producer e-mail was
 * skipped or never sent — including every order created before the strict
 * order gate, which no code ever notified — is never reminded about and never
 * cancelled as «not answered»: that would be a false statement about the
 * producer. A skipped send alerts the admin once (order-notify-service), a
 * failed one alerts and is retried once (step 1). The pre-gate backlog is
 * left for Daniel's one-off clean-up.
 *
 * The 24 h / 72 h clock starts when the producer GOT the order:
 * MAX(created_at, notify_sent_at). After the job was down for longer than the
 * deadline, a first send that only now succeeds (step 1) must not be followed
 * in the same run by a «not answered» cancellation (review round 2 of skive 1b).
 *
 * Prepay orders have their own deadline job (payment-service, payment_expired)
 * and are left alone. Idempotent: every step claims its row with a guarded
 * UPDATE first, so two overlapping runs (or two instances) do each step once.
 * `now` is injectable so the tests use a fake clock.
 */

import { getDb } from "../database/init";
import { transitionOrder, buildOrderNotificationInput } from "./cart-service";
import { sendOrderNotificationForOrder, sendAdminOrderAlert } from "./order-notify-service";
import { sendBuyerOrderReceipt } from "./order-receipt-service";

let _followupTestDb: any = null;
export function __setOrderFollowupsTestDb(db: any): void { _followupTestDb = db; }

function envHours(name: string, dflt: number, env: NodeJS.ProcessEnv): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
export function orderReminderHours(env: NodeJS.ProcessEnv = process.env): number { return envHours("ORDER_REMINDER_HOURS", 24, env); }
export function orderAutocancelHours(env: NodeJS.ProcessEnv = process.env): number { return envHours("ORDER_AUTOCANCEL_HOURS", 72, env); }

export interface OrderFollowupsResult {
  examined: number;
  retried: number;
  reminders_sent: number;
  cancelled: number;
  errors: number;
}

/** SQLite `datetime('now')` is UTC without a zone marker. */
function sqliteUtcMs(ts: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : ts.replace(" ", "T") + "Z");
}
function sqliteStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function processOrderFollowups(
  opts: { now?: Date; db?: any; env?: NodeJS.ProcessEnv } = {},
): Promise<OrderFollowupsResult> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const db = opts.db ?? _followupTestDb ?? getDb();
  const reminderMs = orderReminderHours(env) * 3600_000;
  const cancelMs = orderAutocancelHours(env) * 3600_000;
  const out: OrderFollowupsResult = { examined: 0, retried: 0, reminders_sent: 0, cancelled: 0, errors: 0 };
  const stamp = sqliteStamp(now);

  // 1. one re-send of a producer e-mail that failed
  const failed = db.prepare(`
    SELECT id FROM orders
    WHERE status = 'pending' AND notify_failed_at IS NOT NULL AND notify_retried_at IS NULL
      AND COALESCE(payment_mode, '') <> 'prepay'
  `).all() as Array<{ id: string }>;
  for (const r of failed) {
    try {
      const claimed = db.prepare("UPDATE orders SET notify_retried_at = ? WHERE id = ? AND notify_retried_at IS NULL").run(stamp, r.id);
      if (claimed.changes !== 1) continue;
      const input = buildOrderNotificationInput(r.id);
      if (!input) continue;
      await sendOrderNotificationForOrder(input, { retry: true });
      out.retried++;
    } catch (err) {
      out.errors++;
      console.error(`[order-followups] retry failed order=${r.id}:`, err);
    }
  }

  // 2 + 3. reminder and auto-cancel of orders nobody answered — only orders
  // the producer actually received (notify_sent_at, B1).
  const pending = db.prepare(`
    SELECT o.id, o.agent_id, o.created_at, o.notify_sent_at, o.reminder_sent_at, a.name AS producer_name
    FROM orders o INNER JOIN agents a ON a.id = o.agent_id
    WHERE o.status = 'pending' AND COALESCE(o.payment_mode, '') <> 'prepay'
      AND o.notify_sent_at IS NOT NULL
  `).all() as Array<{ id: string; agent_id: string; created_at: string; notify_sent_at?: string | null; reminder_sent_at: string | null; producer_name: string }>;
  for (const o of pending) {
    out.examined++;
    try {
      const sentMs = o.notify_sent_at ? sqliteUtcMs(o.notify_sent_at) : NaN;
      const startMs = Math.max(sqliteUtcMs(o.created_at), Number.isFinite(sentMs) ? sentMs : -Infinity);
      const ageMs = now.getTime() - startMs;
      if (!Number.isFinite(ageMs)) continue;
      if (ageMs >= cancelMs) {
        const res = transitionOrder(o.id, "cancelled", { actor: "system", cancelReason: "producer_no_response" });
        if (res.success) {
          out.cancelled++;
          console.log(`[order-followups] cancelled order=${o.id} reason=producer_no_response`);
          void sendBuyerOrderReceipt(o.id, "cancelled").catch(() => { /* never fails the job */ });
        }
        continue;
      }
      if (ageMs >= reminderMs && o.reminder_sent_at == null) {
        const claimed = db.prepare(
          "UPDATE orders SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL AND status = 'pending'"
        ).run(stamp, o.id);
        if (claimed.changes !== 1) continue;
        const input = buildOrderNotificationInput(o.id);
        const outcome = input ? await sendOrderNotificationForOrder({ ...input, reminder: true }, { reminder: true }) : "skipped";
        // S4: the alert states what actually happened to the reminder.
        const reminderLine =
          outcome === "sent" ? "Produsenten har fått én påminnelse."
          : outcome === "failed" ? "Påminnelsen til produsenten kunne ikke sendes."
          : "Påminnelsen ble ikke sendt, fordi produsenten ikke lenger kan motta bestillinger på e-post.";
        await sendAdminOrderAlert(
          `Ordre ${o.id.slice(0, 8)} er ubesvart etter ${orderReminderHours(env)} t`,
          `Ordre ${o.id} hos ${o.producer_name} (${o.agent_id}) har stått som «venter på bekreftelse» siden ${o.created_at} (UTC). ` +
          `${reminderLine} Uten svar blir ordren kansellert etter ${orderAutocancelHours(env)} t.`,
        );
        if (outcome === "sent") out.reminders_sent++;
      }
    } catch (err) {
      out.errors++;
      console.error(`[order-followups] step failed order=${o.id}:`, err);
    }
  }
  return out;
}
