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
 * T11 (dev-request 2026-10-30-rfb-eierportal-testrunde-1, punkt 5), behind
 * ORDER_CAP_V2_ENABLED (default off; off = everything above, byte for byte):
 * the producer-wide 10/day cap is gone; the caps are per buyer (open +
 * ORDER_CAP_NEW_PER_BUYER_PER_DAY) plus a platform ceiling per producer
 * (ORDER_CAP_PRODUCER_CEILING_PER_DAY). The CHECK on order_cap_events.reason
 * is NOT widened: a ceiling hit is reason 'producer_daily_cap', a per-buyer
 * hit 'buyer_open_cap', and the nullable reason_detail says which v2 rule
 * ('platform_ceiling' | 'buyer_daily_cap' | 'buyer_open_cap'). The admin is
 * told internally (sendAdminOrderAlert → ADMIN_NOTIFICATION_EMAIL only, never
 * a producer or buyer) once per producer per Oslo day at the ceiling and once
 * at the pre-warning; order_cap_admin_alerts is the durable dedupe marker.
 *
 * Behind ORDER_CAP_NOTICE_ENABLED (default off). Off = today's behaviour
 * exactly: no cap fields in the submit response and no producer e-mail (AC8:
 * Daniel approves the template, recorded in daniel-responses/, before it is
 * turned on). Only the event row (invisible to buyers and producers) is
 * written while it is off.
 */

import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { buyerOrderCapNotice, type OrderCapDetail } from "../owner-features/order-texts";

export type OrderCapReason = "producer_daily_cap" | "buyer_open_cap";
export type { OrderCapDetail } from "../owner-features/order-texts";

export function isOrderCapNoticeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORDER_CAP_NOTICE_ENABLED === "1" || env.ORDER_CAP_NOTICE_ENABLED === "true";
}

/** T11: order caps v2 (per buyer + platform ceiling). Default off. */
export function isOrderCapV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORDER_CAP_V2_ENABLED === "1" || env.ORDER_CAP_V2_ENABLED === "true";
}

/** T11: the CHECK-constrained reason a v2 detail is stored under (the CHECK is not widened). */
export function orderCapReasonForDetail(detail: OrderCapDetail): OrderCapReason {
  return detail === "platform_ceiling" ? "producer_daily_cap" : "buyer_open_cap";
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

/**
 * T11: the UTC instant of midnight Europe/Oslo that starts `d`'s Oslo day, as
 * «YYYY-MM-DD HH:MM:SS» (the format of orders.created_at). Oslo is UTC+1 or
 * UTC+2 and switches at 01:00 UTC, never at midnight, so exactly one of the
 * two candidates starts the day (DST days 2026-10-25 / 2027-03-28 included).
 */
export function osloDayStartUtc(d: Date = new Date()): string {
  const day = osloDay(d);
  const base = Date.parse(`${day}T00:00:00Z`);
  let start = base - 3_600_000;
  for (const off of [2, 1]) {
    const t = base - off * 3_600_000;
    if (osloDay(new Date(t)) === day && osloDay(new Date(t - 1000)) !== day) { start = t; break; }
  }
  return new Date(start).toISOString().slice(0, 19).replace("T", " ");
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

/** «8. november» for «YYYY-MM-DD» (tekstpakke C punkt 4: no weekday). */
export function formatOsloDayMonthLabel(day: string): string {
  return new Intl.DateTimeFormat("nb-NO", { timeZone: "UTC", day: "numeric", month: "long" })
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

/**
 * T11 (ORDER_CAP_V2_ENABLED): the same additive fields for a v2 hit;
 * cap_reason is the v2 detail (new values 'platform_ceiling' and
 * 'buyer_daily_cap' are additive), the text comes from order-texts.ts.
 */
export function orderCapHandoffFieldsV2(detail: OrderCapDetail, cap: number): {
  cap_reached: true; cap_reason: OrderCapDetail; cap: number; cap_notice: string;
} {
  return { cap_reached: true, cap_reason: detail, cap, cap_notice: buyerOrderCapNotice(detail, cap, "no") };
}

// ─── 2. The accumulator ─────────────────────────────────────────────────────

/** One row per (submit, producer) the cap turned into a handoff. Never throws. */
export function recordOrderCapEvent(
  ev: { agent_id: string; cart_id: string | null; reason: OrderCapReason; cap: number; now?: Date; reason_detail?: OrderCapDetail },
  dbIn?: any,
): void {
  try {
    const db = dbIn ?? _capNoticeTestDb ?? getDb();
    const now = ev.now ?? new Date();
    if (ev.reason_detail) {
      // T11: the v2 rule that hit (nullable column; NULL for every v1 row).
      db.prepare(`
        INSERT INTO order_cap_events (id, agent_id, cart_id, reason, cap, oslo_day, created_at, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), ev.agent_id, ev.cart_id, ev.reason, ev.cap, osloDay(now), now.toISOString().slice(0, 19).replace("T", " "), ev.reason_detail);
      return;
    }
    db.prepare(`
      INSERT INTO order_cap_events (id, agent_id, cart_id, reason, cap, oslo_day, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), ev.agent_id, ev.cart_id, ev.reason, ev.cap, osloDay(now), now.toISOString().slice(0, 19).replace("T", " "));
  } catch (err) {
    console.error(`[order-cap] event write failed agent=${ev.agent_id}:`, (err as any)?.message ?? "error");
  }
}

/** Over-cap counts per producer per Oslo day for the admin (newest first). */
export function listOrderCapStats(opts: { days?: number; now?: Date; db?: any; detail?: boolean } = {}): Array<{
  oslo_day: string; agent_id: string; name: string | null; producer_daily_cap: number; buyer_open_cap: number;
  cap: number | null; notice_status: string | null; notice_sent_at: string | null;
  /** T11, only with opts.detail: counts per reason_detail and the admin alerts sent that day. */
  platform_ceiling?: number; buyer_daily_cap?: number; buyer_open_cap_v2?: number;
  ceiling_alert_at?: string | null; prewarn_alert_at?: string | null;
}> {
  const db = opts.db ?? _capNoticeTestDb ?? getDb();
  const days = Math.min(Math.max(Math.floor(opts.days ?? 30), 1), 365);
  let from = osloDay(opts.now ?? new Date());
  for (let i = 1; i < days; i++) from = previousDay(from);
  if (opts.detail) {
    // T11 (ORDER_CAP_V2_ENABLED): the same rows plus reason_detail counts and
    // the internal admin alerts (order_cap_admin_alerts) per producer per day.
    return db.prepare(`
      SELECT e.oslo_day AS oslo_day, e.agent_id AS agent_id, a.name AS name,
             SUM(CASE WHEN e.reason = 'producer_daily_cap' THEN 1 ELSE 0 END) AS producer_daily_cap,
             SUM(CASE WHEN e.reason = 'buyer_open_cap' THEN 1 ELSE 0 END) AS buyer_open_cap,
             MAX(CASE WHEN e.reason = 'producer_daily_cap' THEN e.cap END) AS cap,
             n.status AS notice_status, n.sent_at AS notice_sent_at,
             SUM(CASE WHEN e.reason_detail = 'platform_ceiling' THEN 1 ELSE 0 END) AS platform_ceiling,
             SUM(CASE WHEN e.reason_detail = 'buyer_daily_cap' THEN 1 ELSE 0 END) AS buyer_daily_cap,
             SUM(CASE WHEN e.reason_detail = 'buyer_open_cap' THEN 1 ELSE 0 END) AS buyer_open_cap_v2,
             (SELECT c.created_at FROM order_cap_admin_alerts c WHERE c.agent_id = e.agent_id AND c.oslo_day = e.oslo_day AND c.kind = 'ceiling') AS ceiling_alert_at,
             (SELECT p.created_at FROM order_cap_admin_alerts p WHERE p.agent_id = e.agent_id AND p.oslo_day = e.oslo_day AND p.kind = 'prewarn') AS prewarn_alert_at
        FROM order_cap_events e
        LEFT JOIN agents a ON a.id = e.agent_id
        LEFT JOIN order_cap_notices n ON n.agent_id = e.agent_id AND n.oslo_day = e.oslo_day
       WHERE e.oslo_day >= ?
       GROUP BY e.oslo_day, e.agent_id
       ORDER BY e.oslo_day DESC, producer_daily_cap DESC, e.agent_id ASC
    `).all(from) as any[];
  }
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

// ─── 2b. T11: the admin's internal ceiling alerts ───────────────────────────

/** T11: the pre-warning is sent when a producer reaches this many new orders on one Oslo day. */
export const ORDER_CAP_CEILING_PREWARN_AT = 20;

export type OrderCapAdminAlertKind = "ceiling" | "prewarn";

/**
 * T11 (ORDER_CAP_V2_ENABLED): one internal alert per (producer, Oslo day,
 * kind). The claim — INSERT OR IGNORE on the primary key of
 * order_cap_admin_alerts — happens before the send, so overlapping submits,
 * two instances and restarts never alert twice; a failed send is recorded and
 * not retried (the count is in GET /admin/orders/cap-stats anyway). The send
 * is the existing admin alert (order-notify-service sendAdminOrderAlert →
 * ADMIN_NOTIFICATION_EMAIL only): never a producer or a buyer. No buyer data.
 * Returns true when this call claimed the alert. Never throws.
 */
export function claimOrderCapAdminAlert(
  ev: { agent_id: string; kind: OrderCapAdminAlertKind; count: number; cap: number; now?: Date },
  dbIn?: any,
): boolean {
  let day = "";
  try {
    const db = dbIn ?? _capNoticeTestDb ?? getDb();
    const now = ev.now ?? new Date();
    day = osloDay(now);
    const claimed = db.prepare(`
      INSERT OR IGNORE INTO order_cap_admin_alerts (agent_id, oslo_day, kind, order_count, cap, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?)
    `).run(ev.agent_id, day, ev.kind, ev.count, ev.cap, now.toISOString().slice(0, 19).replace("T", " "));
    if (claimed.changes !== 1) return false;
    let name = ev.agent_id;
    try {
      const a = db.prepare("SELECT name FROM agents WHERE id = ?").get(ev.agent_id) as { name: string | null } | undefined;
      if (a?.name) name = a.name;
    } catch { /* the id is enough */ }
    const subject = ev.kind === "ceiling"
      ? `Bestillingstaket nådd: ${name} (${ev.cap} bestillinger i dag)`
      : `Førvarsel bestillingstak: ${name} har ${ev.count} bestillinger i dag`;
    const text = ev.kind === "ceiling"
      ? `${name} (${ev.agent_id}) har fått ${ev.cap} nye bestillinger i dag (${day}, norsk tid). Plattformtaket er nådd: resten av dagen får kundene kontaktinformasjonen i stedet for å sende bestilling.\nIngen e-post er sendt til produsenten eller kundene om dette. Tall: GET /admin/orders/cap-stats.`
      : `${name} (${ev.agent_id}) har fått ${ev.count} nye bestillinger i dag (${day}, norsk tid). Plattformtaket er ${ev.cap} per dag.\nDette er bare et førvarsel. Ingen e-post er sendt til produsenten eller kundene.`;
    const { sendAdminOrderAlert } = require("./order-notify-service") as typeof import("./order-notify-service");
    void sendAdminOrderAlert(subject, text).then((ok) => {
      try { db.prepare("UPDATE order_cap_admin_alerts SET status = ? WHERE agent_id = ? AND oslo_day = ? AND kind = ?").run(ok ? "sent" : "failed", ev.agent_id, day, ev.kind); } catch { /* best-effort */ }
    }).catch(() => { /* never fails a submit */ });
    return true;
  } catch (err) {
    console.error(`[order-cap] admin alert failed agent=${ev.agent_id} day=${day} kind=${ev.kind}:`, (err as any)?.message ?? "error");
    return false;
  }
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

export type OrderCapNoticeSender = (input: { agent_id: string; count: number; cap: number; oslo_day: string; v2?: boolean }) =>
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

  // Tekstpakke C punkt 4: with ORDER_CAP_V2_ENABLED on, only platform-ceiling
  // hits (reason_detail 'platform_ceiling') count; a buyer's own limits never
  // give the producer an e-mail. Off: the query is exactly as before.
  const v2 = isOrderCapV2Enabled(env);
  const rows = db.prepare(`
    SELECT e.agent_id AS agent_id, COUNT(*) AS n, MAX(e.cap) AS cap
      FROM order_cap_events e
     WHERE e.oslo_day = ? AND e.reason = 'producer_daily_cap'${v2 ? " AND e.reason_detail = 'platform_ceiling'" : ""}
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
      const outcome = await send(v2 ? { agent_id: r.agent_id, count: r.n, cap: r.cap, oslo_day: day, v2: true } : { agent_id: r.agent_id, count: r.n, cap: r.cap, oslo_day: day });
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
