/**
 * Order cap notice (B4) — dev-request 2026-10-28-rfb-bestillinger-fra-start-til-slutt-for-eier.
 *
 * cart-service.submitCart() turns a real order into a contact handoff when a
 * per-producer spam cap is reached (F8):
 *   - 'producer_daily_cap' : ORDER_CAP_NEW_PER_PRODUCER_PER_DAY (default 10)
 *                            new orders per producer in the last 24 hours;
 *   - 'buyer_open_cap'     : ORDER_CAP_OPEN_PENDING_PER_BUYER (default 3)
 *                            open orders from one buyer address.
 * Before B4 nobody was told. This module:
 *
 *   1. orderCapBuyerNotice(): the ONE buyer text for every submitting channel
 *      (REST /api/marketplace/cart/:id/submit, the web cart that calls it, MCP
 *      lokal_cart_submit; A2A has no cart submit — it points at MCP). It rides
 *      on the contact_handoffs[] entry as cap_reached / cap_reason / cap /
 *      cap_notice (additive fields).
 *   2. recordOrderCapEvent(): one row per (submit, producer) that the cap turned
 *      into a handoff, in order_cap_events, keyed by the Europe/Oslo calendar
 *      day. No buyer data. Written whether or not the flag is on, so the admin
 *      count (GET /admin/orders/cap-stats) exists before Daniel approves the
 *      e-mail. Never throws; a failed write never fails a submit.
 *   3. processOrderCapNotices(): the daily digest. For YESTERDAY's Oslo day only,
 *      from 07:00 Oslo time, each producer with at least one
 *      'producer_daily_cap' event gets ONE e-mail with the day's total.
 *      «Exactly one per producer per day» is the primary key
 *      (agent_id, oslo_day) of order_cap_notices: the job claims the row with
 *      INSERT OR IGNORE before it sends, so overlapping runs, two instances
 *      and restarts can never send twice. A failed send is recorded
 *      (status 'failed') and not retried — a duplicate is worse than a miss,
 *      and the admin sees the count anyway.
 *
 * Behind ORDER_CAP_NOTICE_ENABLED (default off). Off = today's behaviour
 * exactly: no cap fields in the submit response and no producer e-mail (AC8:
 * Daniel approves the template, recorded in daniel-responses/, before it is
 * turned on). Only the event row (invisible to buyers and producers) is
 * written while it is off.
 */

import { randomUUID } from "crypto";
import { getDb } from "../database/init";

export type OrderCapReason = "producer_daily_cap" | "buyer_open_cap";

export function isOrderCapNoticeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORDER_CAP_NOTICE_ENABLED === "1" || env.ORDER_CAP_NOTICE_ENABLED === "true";
}

let _capNoticeTestDb: any = null;
export function __setOrderCapNoticeTestDb(db: any): void { _capNoticeTestDb = db; }

// ─── Europe/Oslo calendar day ───────────────────────────────────────────────

const OSLO_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" });
const OSLO_HOUR_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", hour12: false });

/** «YYYY-MM-DD» of `d` in Europe/Oslo. */
export function osloDay(d: Date = new Date()): string {
  return OSLO_DAY_FMT.format(d);
}

/** The hour (0–23) of `d` in Europe/Oslo. */
export function osloHour(d: Date = new Date()): number {
  const h = Number(OSLO_HOUR_FMT.format(d));
  return h === 24 ? 0 : h;
}

/** The calendar day before «YYYY-MM-DD». */
export function previousDay(day: string): string {
  const t = Date.parse(`${day}T12:00:00Z`) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** «onsdag 28. oktober» for «YYYY-MM-DD». */
export function formatOsloDayLabel(day: string): string {
  return new Intl.DateTimeFormat("nb-NO", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
    .format(new Date(`${day}T12:00:00Z`));
}

/** The digest is sent from this Oslo hour on (not in the night). */
export const ORDER_CAP_NOTICE_SEND_FROM_HOUR = 7;

// ─── 1. The buyer text ──────────────────────────────────────────────────────

/**
 * The buyer's explanation of a capped producer (one function for every
 * channel). `cap` is the limit in force; the web cart passes the token
 * «{cap}» and fills it in from the response.
 */
export function orderCapBuyerNotice(reason: OrderCapReason, cap: number | string, lang: "no" | "en" = "no"): string {
  if (lang === "en") {
    return reason === "producer_daily_cap"
      ? `This producer has reached the limit of ${cap} orders per day through Rett fra Bonden, so your order was not sent to the producer. It was turned into a contact request instead: contact the producer directly with the details and the message below.`
      : `You already have ${cap} unanswered orders with this producer, so this one was not sent as an order. It was turned into a contact request instead: contact the producer directly with the details and the message below.`;
  }
  return reason === "producer_daily_cap"
    ? `Produsenten har nådd grensen på ${cap} bestillinger per døgn gjennom Rett fra Bonden, så bestillingen ble ikke sendt til produsenten. Den ble gjort om til en kontaktforespørsel: ta kontakt med produsenten direkte med kontaktinformasjonen og meldingen under.`
    : `Du har allerede ${cap} ubesvarte bestillinger hos denne produsenten, så denne ble ikke sendt som bestilling. Den ble gjort om til en kontaktforespørsel: ta kontakt med produsenten direkte med kontaktinformasjonen og meldingen under.`;
}

/** The additive fields on a capped producer's contact_handoffs[] entry. */
export interface OrderCapHandoffFields {
  cap_reached: true;
  cap_reason: OrderCapReason;
  cap: number;
  cap_notice: string;
}

export function orderCapHandoffFields(reason: OrderCapReason, cap: number): OrderCapHandoffFields {
  return { cap_reached: true, cap_reason: reason, cap, cap_notice: orderCapBuyerNotice(reason, cap, "no") };
}

// ─── 2. The accumulator ─────────────────────────────────────────────────────

/** One row per (submit, producer) the cap turned into a handoff. Never throws. */
export function recordOrderCapEvent(
  ev: { agent_id: string; cart_id: string | null; reason: OrderCapReason; cap: number; now?: Date },
  dbIn?: any,
): void {
  try {
    const db = dbIn ?? _capNoticeTestDb ?? getDb();
    const now = ev.now ?? new Date();
    db.prepare(`
      INSERT INTO order_cap_events (id, agent_id, cart_id, reason, cap, oslo_day, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), ev.agent_id, ev.cart_id, ev.reason, ev.cap, osloDay(now), now.toISOString().slice(0, 19).replace("T", " "));
  } catch (err) {
    console.error(`[order-cap] event write failed agent=${ev.agent_id}:`, (err as any)?.message ?? "error");
  }
}

/** Over-cap counts per producer per Oslo day for the admin (newest first). */
export function listOrderCapStats(opts: { days?: number; now?: Date; db?: any } = {}): Array<{
  oslo_day: string; agent_id: string; name: string | null; producer_daily_cap: number; buyer_open_cap: number;
  cap: number | null; notice_status: string | null; notice_sent_at: string | null;
}> {
  const db = opts.db ?? _capNoticeTestDb ?? getDb();
  const days = Math.min(Math.max(Math.floor(opts.days ?? 30), 1), 365);
  let from = osloDay(opts.now ?? new Date());
  for (let i = 1; i < days; i++) from = previousDay(from);
  return db.prepare(`
    SELECT e.oslo_day AS oslo_day, e.agent_id AS agent_id, a.name AS name,
           SUM(CASE WHEN e.reason = 'producer_daily_cap' THEN 1 ELSE 0 END) AS producer_daily_cap,
           SUM(CASE WHEN e.reason = 'buyer_open_cap' THEN 1 ELSE 0 END) AS buyer_open_cap,
           MAX(CASE WHEN e.reason = 'producer_daily_cap' THEN e.cap END) AS cap,
           n.status AS notice_status, n.sent_at AS notice_sent_at
      FROM order_cap_events e
      LEFT JOIN agents a ON a.id = e.agent_id
      LEFT JOIN order_cap_notices n ON n.agent_id = e.agent_id AND n.oslo_day = e.oslo_day
     WHERE e.oslo_day >= ?
     GROUP BY e.oslo_day, e.agent_id
     ORDER BY e.oslo_day DESC, producer_daily_cap DESC, e.agent_id ASC
  `).all(from) as any[];
}

// ─── 3. The daily digest ────────────────────────────────────────────────────

export interface OrderCapNoticeResult {
  enabled: boolean;
  day: string | null;
  candidates: number;
  sent: number;
  skipped: number;
  failed: number;
}

export type OrderCapNoticeSender = (input: { agent_id: string; count: number; cap: number; oslo_day: string }) =>
  Promise<"sent" | "skipped" | "failed">;

/**
 * Sends yesterday's digest (Europe/Oslo) to every producer whose daily cap
 * turned at least one submit into a handoff that day. Idempotent (see the
 * module doc). `now` is injectable for the tests.
 */
export async function processOrderCapNotices(
  opts: { now?: Date; db?: any; env?: NodeJS.ProcessEnv; send?: OrderCapNoticeSender } = {},
): Promise<OrderCapNoticeResult> {
  const env = opts.env ?? process.env;
  const out: OrderCapNoticeResult = { enabled: isOrderCapNoticeEnabled(env), day: null, candidates: 0, sent: 0, skipped: 0, failed: 0 };
  if (!out.enabled) return out;
  const now = opts.now ?? new Date();
  if (osloHour(now) < ORDER_CAP_NOTICE_SEND_FROM_HOUR) return out;
  const day = previousDay(osloDay(now));
  out.day = day;
  const db = opts.db ?? _capNoticeTestDb ?? getDb();
  const send: OrderCapNoticeSender = opts.send ?? (async (input) => {
    const { sendProducerOrderCapNotice } = await import("./order-notify-service");
    return sendProducerOrderCapNotice(input);
  });

  const rows = db.prepare(`
    SELECT e.agent_id AS agent_id, COUNT(*) AS n, MAX(e.cap) AS cap
      FROM order_cap_events e
     WHERE e.oslo_day = ? AND e.reason = 'producer_daily_cap'
       AND NOT EXISTS (SELECT 1 FROM order_cap_notices x WHERE x.agent_id = e.agent_id AND x.oslo_day = e.oslo_day)
     GROUP BY e.agent_id
     ORDER BY e.agent_id
  `).all(day) as Array<{ agent_id: string; n: number; cap: number }>;
  out.candidates = rows.length;

  for (const r of rows) {
    try {
      // The claim: only the run whose INSERT lands sends. Restart-safe.
      const claimed = db.prepare(`
        INSERT OR IGNORE INTO order_cap_notices (agent_id, oslo_day, over_cap_count, cap, status, created_at)
        VALUES (?, ?, ?, ?, 'claimed', datetime('now'))
      `).run(r.agent_id, day, r.n, r.cap);
      if (claimed.changes !== 1) continue;
      const outcome = await send({ agent_id: r.agent_id, count: r.n, cap: r.cap, oslo_day: day });
      db.prepare(`UPDATE order_cap_notices SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END WHERE agent_id = ? AND oslo_day = ?`)
        .run(outcome, outcome, r.agent_id, day);
      out[outcome]++;
    } catch (err) {
      out.failed++;
      try {
        db.prepare(`UPDATE order_cap_notices SET status = 'failed' WHERE agent_id = ? AND oslo_day = ?`).run(r.agent_id, day);
      } catch { /* best-effort */ }
      console.error(`[order-cap] notice failed agent=${r.agent_id} day=${day}:`, (err as any)?.message ?? "error");
    }
  }
  return out;
}
