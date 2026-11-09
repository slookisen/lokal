/**
 * «Mine ordrer» (Fase A2 of dev-request 2026-10-21-rfb-mine-ordrer-ett-klikk-
 * og-kjoperagent): data access + HTML rendering for the owner's order list
 * (/eier/:id/ordrer) and the single-order view opened from the e-mail
 * (/produsent/ordre/:token/kompakt). No routes and no auth here — see
 * owner-orders.ts. Every transition goes through services/order-actions.ts
 * (Fase A1); nothing in this file changes an order.
 *
 * All values that come from the database (buyer name, item names, notes) are
 * HTML-escaped. Tokens are never logged.
 */

import { cartServiceDb, getOrderTimeline, orderPaymentMode, PAYMENT_MODE_UNKNOWN } from "../services/cart-service";
import { cancelActionsEnabled } from "../services/order-actions";
import { formatPickupTimeOslo, noShowEarliestMs, isOrderAutocompleteEnabled } from "../services/order-lifecycle";
import { PRICE_BY_AGREEMENT } from "../services/order-pricing";
import { randomUUID } from "crypto";
import { soldOutChoices, stockSoftExpiryActiveFor } from "../services/stock-soft-expiry";
import { isOrderMessagesEnabled, listOrderMessages, orderTakesMessages, ORDER_MESSAGE_MAX_CHARS, type OrderMessageRow } from "../services/order-messages";
import { OWNER_ORDERS_THEME_CSS, ownerThemeHtml } from "../owner-ui/tokens";
import { OWNER_SHELL_MAIN_ID } from "../owner-ui/shell";
import { isBuyerReceiptsEnabled } from "../services/order-receipt-service";
import { osloDay, osloDayStartUtc } from "../services/order-cap-notice";
import {
  OWNER_CANCEL_SUMMARY, OWNER_ORDER_ACTION_LABELS, OWNER_ORDER_OVERVIEW_EMPTY, OWNER_ORDER_OVERVIEW_HEADING,
  ownerCancelChooseLine, ownerCancelledBanner, ownerNoShowFromLine, ownerOverviewMonthLine, ownerOverviewTotalLine,
} from "../owner-features/order-texts";

export type OwnerOrdersTab = "venter" | "kommende" | "avsluttet";
export const OWNER_ORDERS_TABS: ReadonlyArray<{ key: OwnerOrdersTab; label: string }> = [
  { key: "venter", label: "Venter på svar" },
  { key: "kommende", label: "Kommende henting" },
  { key: "avsluttet", label: "Avsluttet" },
];

const TAB_STATUSES: Record<OwnerOrdersTab, string[]> = {
  venter: ["pending"],
  kommende: ["confirmed", "ready"],
  avsluttet: ["declined", "completed", "cancelled"],
};

/** The tab an order with this status belongs in. */
export function tabForStatus(status: string): OwnerOrdersTab {
  if (status === "pending") return "venter";
  if (status === "confirmed" || status === "ready") return "kommende";
  return "avsluttet";
}

export function parseTab(raw: unknown): OwnerOrdersTab | null {
  const s = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
  return s === "venter" || s === "kommende" || s === "avsluttet" ? s : null;
}

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export interface OwnerOrder {
  id: string;
  agent_id: string;
  producer_name: string;
  status: string;
  cancel_reason: string | null;
  completion_source: string | null;
  pickup_time: string | null;
  total_nok: number | null;
  created_at: string;
  updated_at: string;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  delivery_note: string | null;
  payment_mode: string | null;
  items: Array<{ name_snapshot: string | null; qty: number | null; line_total: number | null }>;
  timeline: Array<{ from_status: string | null; to_status: string; created_at: string }>;
}

const ORDER_COLS = `o.id, o.agent_id, a.name AS producer_name, o.status, o.cancel_reason, o.completion_source,
       o.pickup_time, o.total_nok, o.created_at, o.updated_at,
       o.buyer_name, o.buyer_email, o.buyer_phone, o.delivery_note`;

function hydrate(db: any, r: any): OwnerOrder {
  const items = db.prepare(
    "SELECT name_snapshot, qty, line_total FROM order_items WHERE order_id = ? ORDER BY rowid",
  ).all(r.id) as OwnerOrder["items"];
  let paymentMode: string | null;
  try { paymentMode = orderPaymentMode(db, r.id); } catch { paymentMode = PAYMENT_MODE_UNKNOWN; }
  return {
    ...r,
    buyer_name: r.buyer_name ?? null,
    buyer_email: r.buyer_email ?? null,
    buyer_phone: r.buyer_phone ?? null,
    delivery_note: r.delivery_note ?? null,
    completion_source: r.completion_source ?? null,
    payment_mode: paymentMode,
    items,
    timeline: getOrderTimeline(r.id),
  } as OwnerOrder;
}

/** Open order counts per tab (all rows, not just the listed ones). */
export function countOwnerOrders(agentId: string, db: any = cartServiceDb()): Record<OwnerOrdersTab, number> {
  const out: Record<OwnerOrdersTab, number> = { venter: 0, kommende: 0, avsluttet: 0 };
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM orders WHERE agent_id = ? GROUP BY status").all(agentId) as Array<{ status: string; n: number }>;
  for (const r of rows) out[tabForStatus(r.status)] += r.n;
  return out;
}

const TAB_LIMIT = 50;

export function listOwnerOrders(agentId: string, tab: OwnerOrdersTab, db: any = cartServiceDb()): OwnerOrder[] {
  const statuses = TAB_STATUSES[tab];
  const marks = statuses.map(() => "?").join(",");
  const order =
    tab === "venter" ? "o.created_at ASC, o.rowid ASC"
    : tab === "kommende" ? "(o.pickup_time IS NULL), o.pickup_time ASC, o.created_at ASC"
    : "o.updated_at DESC, o.rowid DESC";
  const rows = db.prepare(`
    SELECT ${ORDER_COLS}
    FROM orders o INNER JOIN agents a ON a.id = o.agent_id
    WHERE o.agent_id = ? AND o.status IN (${marks})
    ORDER BY ${order}
    LIMIT ${TAB_LIMIT}
  `).all(agentId, ...statuses) as any[];
  return rows.map((r) => hydrate(db, r));
}

/** One order of one producer (the owner session path). */
export function getOwnerOrder(agentId: string, orderId: string, db: any = cartServiceDb()): OwnerOrder | null {
  const r = db.prepare(`
    SELECT ${ORDER_COLS}
    FROM orders o INNER JOIN agents a ON a.id = o.agent_id
    WHERE o.id = ? AND o.agent_id = ?
  `).get(orderId, agentId) as any;
  return r ? hydrate(db, r) : null;
}

/** One order by its per-order e-mail token (the passwordless path). Reads nothing else. */
export function getOwnerOrderByToken(token: string, db: any = cartServiceDb()): OwnerOrder | null {
  if (!token) return null;
  const r = db.prepare(`
    SELECT ${ORDER_COLS}
    FROM orders o INNER JOIN agents a ON a.id = o.agent_id
    WHERE o.confirm_token = ?
  `).get(token) as any;
  return r ? hydrate(db, r) : null;
}

// ─── Labels ────────────────────────────────────────────────────────────────

export function statusLabel(o: Pick<OwnerOrder, "status" | "cancel_reason" | "completion_source">): { text: string; cls: string } {
  switch (o.status) {
    case "pending": return { text: "Venter på svar", cls: "wait" };
    case "confirmed":
    case "ready": return { text: "Bekreftet", cls: "ok" };
    case "declined": return { text: "Avslått", cls: "end" };
    case "completed": return { text: o.completion_source === "auto" ? "Avsluttet automatisk" : "Hentet", cls: "ok" };
    case "cancelled":
      switch (o.cancel_reason) {
        case "no_show": return { text: "Kunden kom ikke", cls: "end" };
        case "buyer_cancelled": return { text: "Kunden avbestilte", cls: "end" };
        case "producer_cancelled": return { text: "Kansellert av deg", cls: "end" };
        case "producer_no_response": return { text: "Ikke besvart i tide", cls: "end" };
        case "payment_expired": return { text: "Betaling utløpt", cls: "end" };
        default: return { text: "Kansellert", cls: "end" };
      }
    default: return { text: o.status, cls: "end" };
  }
}

const TIMELINE_LABEL: Record<string, string> = {
  pending: "Mottatt", confirmed: "Bekreftet", ready: "Bekreftet", declined: "Avslått", completed: "Avsluttet", cancelled: "Kansellert",
};

/** «2 × Poteter + 1 annen» */
export function itemsSummary(items: OwnerOrder["items"]): string {
  if (!items.length) return "Ingen varer";
  const first = items[0]!;
  const head = `${first.qty ?? "?"} × ${first.name_snapshot || "Vare"}`;
  const rest = items.length - 1;
  return rest <= 0 ? head : `${head} + ${rest} ${rest === 1 ? "annen" : "andre"}`;
}

function shortDate(ts: string): string {
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : ts.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return ts;
  return new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "numeric", month: "short" }).format(new Date(t));
}

function nowOsloLocalMin(now: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(now).replace(" ", "T");
}

export const ROW_ANCHOR = (orderId: string): string => `o-${orderId}`;

export interface RowContext {
  /** Form target for the order's actions. */
  postTo: string;
  /** Row starts unfolded. */
  open: boolean;
  now?: Date;
  /**
   * Fase B2: the form target for the seller's message (the owner-session
   * page only). Absent: the thread is shown read-only (the e-mail token
   * view). Ignored while ORDER_MESSAGES_ENABLED is off.
   */
  messagePostTo?: string;
  /**
   * T12: the cancellation component (orderActionsComponentHtml) instead of
   * today's buttons — only for a producer on OWNER_FEATURES_ALLOWED_SUBJECTS.
   */
  t12?: boolean;
}

const ACTION_LABEL = {
  confirm: "Bekreft",
  decline: "Avslå",
  no_show: "Kunden kom ikke",
  buyer_cancelled: "Kunden avbestilte",
  cannot_deliver: "Kan ikke levere",
  // B3 (dev-request 2026-10-28-rfb-bestillinger-fra-start-til-slutt-for-eier):
  // the same «Hentet» as the producer's order page — the shared layer's
  // `complete` (confirmed/ready → completed, completion_source 'seller').
  complete: "Hentet",
} as const;

function actionForm(ctx: RowContext, action: keyof typeof ACTION_LABEL, cls: string, extra = ""): string {
  return `<form method="post" action="${esc(ctx.postTo)}" class="mo-form"><input type="hidden" name="action" value="${action}"><input type="hidden" name="idem" value="${randomUUID()}">${extra}<button type="submit" class="mo-btn ${cls}">${ACTION_LABEL[action]}</button></form>`;
}

/**
 * B2b-1 «Utsolgt»: a second decline button that also sets the ticked items
 * (all ticked by default) to out of stock. Only while the soft-expiry rule is
 * active for the producer, and only when the order has products of it; ""
 * otherwise, so the page is unchanged with the rule off.
 */
function soldOutDeclineForm(o: OwnerOrder, ctx: RowContext): string {
  if (!stockSoftExpiryActiveFor(o.agent_id)) return "";
  const choices = soldOutChoices(cartServiceDb(), o.id, o.agent_id);
  if (!choices.length) return "";
  const boxes = choices.map((c) =>
    `<label style="display:block;padding:4px 0"><input type="checkbox" name="sold_out" value="${esc(c.product_id)}" checked> ${esc(c.name)}</label>`,
  ).join("");
  return `<form method="post" action="${esc(ctx.postTo)}" class="mo-form" data-sold-out-form="1"><input type="hidden" name="action" value="decline_sold_out"><input type="hidden" name="idem" value="${randomUUID()}">` +
    `<fieldset style="border:1px solid #e4e2da;border-radius:8px;margin:0 0 6px;padding:6px 10px"><legend style="font-size:.9rem">Kryss av varene som er utsolgt. De blir merket som utsolgt.</legend>${boxes}</fieldset>` +
    `<button type="submit" class="mo-btn mo-secondary">Avslå – utsolgt</button></form>`;
}

function actionsHtml(o: OwnerOrder, ctx: RowContext): string {
  const now = ctx.now ?? new Date();
  if (ctx.t12) {
    return orderActionsComponentHtml({
      orderId: o.id, agentId: o.agent_id, status: o.status, pickupTime: o.pickup_time, paymentMode: o.payment_mode,
      confirmedAt: o.timeline.find((e) => e.to_status === "confirmed")?.created_at ?? null,
      postTo: ctx.postTo, now, cls: MO_COMPONENT_CLASSES,
    });
  }
  if (o.status === "pending") {
    const pickup = `<label class="mo-pick">Hentetid (valgfritt)<input type="datetime-local" name="pickup_time" min="${nowOsloLocalMin(now)}"></label>`;
    return `<div class="mo-actions">${actionForm(ctx, "confirm", "mo-primary", pickup)}${actionForm(ctx, "decline", "mo-secondary")}${soldOutDeclineForm(o, ctx)}</div>`;
  }
  if (o.status === "confirmed" || o.status === "ready") {
    const confirmedAt = o.timeline.find((e) => e.to_status === "confirmed")?.created_at ?? null;
    const from = noShowEarliestMs({ pickup_time: o.pickup_time, confirmed_at: confirmedAt });
    const noShowLocked = from !== null && now.getTime() < from;
    const cancels = cancelActionsEnabled(o.payment_mode);
    const parts: string[] = [];
    if (noShowLocked) parts.push(`<p class="mo-hint">«Kunden kom ikke» kan registreres fra ${esc(formatPickupTimeOslo(new Date(from!).toISOString()))}.</p>`);
    else parts.push(actionForm(ctx, "no_show", "mo-secondary"));
    if (cancels) {
      parts.push(actionForm(ctx, "buyer_cancelled", "mo-secondary"));
      parts.push(actionForm(ctx, "cannot_deliver", "mo-secondary"));
    }
    const hint = isOrderAutocompleteEnabled()
      ? `<p class="mo-hint">Du trenger ikke gjøre mer. Bestillingen avsluttes av seg selv etter henting.</p>` : "";
    // B3: «Hentet» is optional (the automatic close stays the main path) and
    // offered only for confirmed/ready — the layer re-validates on POST.
    const pickedUp = `<div class="mo-actions">${actionForm(ctx, "complete", "mo-primary")}</div>`;
    return `${hint}${pickedUp}<details class="mo-menu"><summary>Flere valg</summary>${parts.join("")}</details>`;
  }
  return "";
}

// ─── T12: one cancellation component for the three order pages ─────────────

/** The CSS classes of the page the component is placed on. */
export interface OrderComponentClasses {
  /** Wrapper of a group of buttons. */
  actions: string;
  form: string;
  btn: string;
  primary: string;
  secondary: string;
  hint: string;
  /** The `<details>` holding the cancellation reasons. */
  menu: string;
  /** The label around the optional pickup time. */
  pickup: string;
}

export const MO_COMPONENT_CLASSES: OrderComponentClasses = {
  actions: "mo-actions", form: "mo-form", btn: "mo-btn", primary: "mo-primary", secondary: "mo-secondary",
  hint: "mo-hint", menu: "mo-menu", pickup: "mo-pick",
};

export interface OrderComponentInput {
  orderId: string;
  agentId: string;
  status: string;
  pickupTime: string | null;
  paymentMode: string | null;
  /** The first order_events row into 'confirmed' (for «Kunden kom ikke»). */
  confirmedAt: string | null;
  postTo: string;
  now: Date;
  cls: OrderComponentClasses;
  /** Escaped HTML put under «Kanseller bestillingen …» (the old order page's payment line). */
  cancelExtraHtml?: string;
}

/**
 * T12 (dev-request 2026-10-30-rfb-eierportal-testrunde-1, punkt 6): the order
 * buttons of «Mine ordrer», the compact page from the e-mail and the old
 * order page — the caller shows it only for a producer on the allowlist.
 *
 *   pending   : «Bekreft» (optional pickup time), «Avslå», «Avslå – utsolgt»
 *               and «Kunden har avbestilt» (buyer_cancelled, not a decline).
 *               «Avslå – utsolgt» and the item boxes of «Varen er utsolgt»
 *               keep B2b-1's gate (stockSoftExpiryActiveFor + items of the
 *               producer on the order).
 *   confirmed : «Hentet» as the main button and right under it «Kanseller
 *               bestillingen …» with «Varen er utsolgt», «Jeg kan ikke levere
 *               likevel», «Kunden har avbestilt» and «Kunden kom ikke» (the
 *               latter disabled with «Kan registreres fra {tid}.» before
 *               noShowEarliestMs, as today).
 *
 * No new transitions: the posted values are mapped by t12SellerActionFrom
 * (order-actions.ts) and the layer re-validates everything. The cancellation
 * choices that may touch a prepayment follow cancelActionsEnabled, as today.
 */
export function orderActionsComponentHtml(i: OrderComponentInput): string {
  const c = i.cls;
  const L = OWNER_ORDER_ACTION_LABELS;
  const form = (action: string, label: string, btnCls: string, extra = "", attrs = "") =>
    `<form method="post" action="${esc(i.postTo)}" class="${c.form}"${attrs}><input type="hidden" name="action" value="${action}"><input type="hidden" name="idem" value="${randomUUID()}">${extra}<button type="submit" class="${c.btn} ${btnCls}">${esc(label)}</button></form>`;
  // B2b-1's gate for the sold-out write (STOCK_SOFT_EXPIRY_ENABLED + allowlist).
  const soldOutRule = stockSoftExpiryActiveFor(i.agentId);
  const choices = soldOutRule ? soldOutChoices(cartServiceDb(), i.orderId, i.agentId) : [];
  const soldOutBoxes = (): string => {
    if (!choices.length) return "";
    const boxes = choices.map((ch) =>
      `<label style="display:block;padding:4px 0"><input type="checkbox" name="sold_out" value="${esc(ch.product_id)}" checked> ${esc(ch.name)}</label>`,
    ).join("");
    return `<fieldset style="border:1px solid #e4e2da;border-radius:8px;margin:0 0 6px;padding:6px 10px"><legend style="font-size:.9rem">Kryss av varene som er utsolgt. De blir merket som utsolgt.</legend>${boxes}</fieldset>`;
  };
  const cancels = cancelActionsEnabled(i.paymentMode);

  if (i.status === "pending") {
    const pickup = `<label class="${c.pickup}">Hentetid (valgfritt)<input type="datetime-local" name="pickup_time" min="${nowOsloLocalMin(i.now)}"></label>`;
    return `<div class="${c.actions}" data-t12-actions="pending">` +
      form("confirm", L.confirm, c.primary, pickup) +
      form("decline", L.decline, c.secondary) +
      // «Avslå – utsolgt» as B2b-1: only with the rule active and items of this producer on the order.
      (choices.length ? form("decline_sold_out", L.decline_sold_out, c.secondary, soldOutBoxes(), ' data-sold-out-form="1"') : "") +
      (cancels ? form("buyer_cancelled", L.buyer_cancelled, c.secondary) : "") +
      `</div>`;
  }
  if (i.status === "confirmed" || i.status === "ready") {
    const from = noShowEarliestMs({ pickup_time: i.pickupTime, confirmed_at: i.confirmedAt });
    const noShowLocked = from !== null && i.now.getTime() < from;
    const reasons: string[] = [];
    if (cancels) {
      reasons.push(form("cancel_sold_out", L.cancel_sold_out, c.secondary, soldOutBoxes(), choices.length ? ' data-sold-out-form="1"' : ""));
      reasons.push(form("cancel_cannot_deliver", L.cancel_cannot_deliver, c.secondary));
      reasons.push(form("buyer_cancelled", L.buyer_cancelled, c.secondary));
    }
    reasons.push(noShowLocked
      ? `<div class="${c.form}"><button type="button" class="${c.btn} ${c.secondary}" disabled>${esc(L.no_show)}</button><p class="${c.hint}">${esc(ownerNoShowFromLine(formatPickupTimeOslo(new Date(from!).toISOString())))}</p></div>`
      : form("no_show", L.no_show, c.secondary));
    const autoHint = isOrderAutocompleteEnabled()
      ? `<p class="${c.hint}">Du trenger ikke gjøre mer. Bestillingen avsluttes av seg selv etter henting.</p>` : "";
    return `${autoHint}<div class="${c.actions}" data-t12-actions="confirmed">${form("complete", L.complete, c.primary)}</div>` +
      `<details class="${c.menu}"><summary>${esc(OWNER_CANCEL_SUMMARY)}</summary>` +
      `<p class="${c.hint}">${esc(ownerCancelChooseLine(isBuyerReceiptsEnabled()))}</p>` +
      (i.cancelExtraHtml ? `<p class="${c.hint}">${i.cancelExtraHtml}</p>` : "") +
      reasons.join("") + `</details>`;
  }
  return "";
}

/** T12: the banner text after a successful action, "" = keep the page's own banner. */
export function t12DoneBannerText(done: string): string {
  return done === "cancelled" ? ownerCancelledBanner(isBuyerReceiptsEnabled()) : "";
}

// ─── T12: «Bestillinger gjennom Rett fra Bonden» (the overview) ────────────

export interface OwnerOrderOverview {
  /** «november» — the current Oslo month, lower case. */
  monthName: string;
  /** Orders received this Oslo month (any status) and how many of them are picked up (completed). */
  month: { received: number; pickedUp: number };
  /** The same since the producer's first order. */
  total: { received: number; pickedUp: number };
}

/** The UTC bounds [start, end) of the Oslo calendar month of `now`, as «YYYY-MM-DD HH:MM:SS». */
export function osloMonthBoundsUtc(now: Date): { start: string; end: string; ym: string } {
  const ym = osloDay(now).slice(0, 7);
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return {
    start: osloDayStartUtc(new Date(`${ym}-01T12:00:00Z`)),
    end: osloDayStartUtc(new Date(`${next}-01T12:00:00Z`)),
    ym,
  };
}

/**
 * T12: the producer's orders through Rett fra Bonden — received and picked up
 * this Oslo month and since the start. One shared function, for «Mine ordrer»
 * now and the dashboard's Oversikt and Statistikk later (T15). Real numbers
 * from `orders` of THIS producer only. «Received» counts every order by
 * created_at (any status); «picked up» counts those of them with status
 * 'completed' (the seller's «Hentet», the buyer's report or the automatic
 * close after pickup).
 */
export function getOwnerOrderOverview(agentId: string, now: Date = new Date(), db: any = cartServiceDb()): OwnerOrderOverview {
  const b = osloMonthBoundsUtc(now);
  const r = db.prepare(`
    SELECT COUNT(*) AS total_received,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS total_picked,
           COALESCE(SUM(CASE WHEN datetime(created_at) >= ? AND datetime(created_at) < ? THEN 1 ELSE 0 END), 0) AS month_received,
           COALESCE(SUM(CASE WHEN datetime(created_at) >= ? AND datetime(created_at) < ? AND status = 'completed' THEN 1 ELSE 0 END), 0) AS month_picked
    FROM orders WHERE agent_id = ?
  `).get(b.start, b.end, b.start, b.end, agentId) as
    { total_received: number; total_picked: number; month_received: number; month_picked: number };
  const monthName = new Intl.DateTimeFormat("nb-NO", { timeZone: "UTC", month: "long" }).format(new Date(`${b.ym}-15T12:00:00Z`));
  return {
    monthName,
    month: { received: r.month_received, pickedUp: r.month_picked },
    total: { received: r.total_received, pickedUp: r.total_picked },
  };
}

/** T12: the overview block at the top of «Mine ordrer». */
export function ownerOrderOverviewHtml(ov: OwnerOrderOverview): string {
  const lines = ov.total.received === 0
    ? `<p class="mo-hint">${esc(OWNER_ORDER_OVERVIEW_EMPTY)}</p>`
    : `<p>${esc(ownerOverviewMonthLine(ov.monthName, ov.month.received, ov.month.pickedUp))}</p>` +
      `<p>${esc(ownerOverviewTotalLine(ov.total.received, ov.total.pickedUp))}</p>`;
  return `<section class="mo-block" id="mo-oversikt" aria-labelledby="mo-oversikt-h"><h2 id="mo-oversikt-h" style="font-size:1rem;margin:0 0 4px">${esc(OWNER_ORDER_OVERVIEW_HEADING)}</h2>${lines}</section>`;
}

function detailHtml(o: OwnerOrder, ctx: RowContext): string {
  const itemRows = o.items.map((i) =>
    `<li><span>${esc(i.qty ?? "?")} × ${esc(i.name_snapshot || "Vare")}</span><span>${i.line_total != null ? `${esc(i.line_total)} kr` : esc(PRICE_BY_AGREEMENT)}</span></li>`,
  ).join("");
  const sum = o.total_nok != null ? `<p class="mo-sum">Sum: ${esc(o.total_nok)} kr</p>` : "";
  const contact = [
    o.buyer_name ? `<div><strong>Navn:</strong> ${esc(o.buyer_name)}</div>` : "",
    o.buyer_phone ? `<div><strong>Telefon:</strong> ${esc(o.buyer_phone)}</div>` : "",
    o.buyer_email ? `<div><strong>E-post:</strong> ${esc(o.buyer_email)}</div>` : "",
  ].filter(Boolean).join("");
  const wish = o.delivery_note ? `<div class="mo-block"><strong>Kundens ønske</strong><p>${esc(o.delivery_note)}</p></div>` : "";
  const tl = o.timeline.length
    ? `<div class="mo-block"><strong>Tidslinje</strong><ul class="mo-tl">${o.timeline.map((e) =>
        `<li>${esc(formatPickupTimeOslo(e.created_at))}: ${esc(TIMELINE_LABEL[e.to_status] || e.to_status)}</li>`).join("")}</ul></div>`
    : "";
  return `<div class="mo-detail">
    <div class="mo-block"><strong>Varer</strong><ul class="mo-items">${itemRows}</ul>${sum}</div>
    ${contact ? `<div class="mo-block"><strong>Kunde</strong>${contact}</div>` : ""}
    ${wish}${tl}${messagesHtml(o, ctx)}${actionsHtml(o, ctx)}
  </div>`;
}

// ─── Fase B2: the message thread ───────────────────────────────────────────

function msgTime(ts: string): string {
  return formatPickupTimeOslo(ts);
}

/**
 * The thread of one order, oldest first, every text HTML-escaped (it is
 * written by the other party). `viewer` decides the labels («Du» for the
 * viewer's own messages). Shared with the buyer's order card. Inline styles
 * only, so the shared page CSS is unchanged.
 */
export function messageThreadHtml(rows: OrderMessageRow[], viewer: "buyer" | "seller", producerName: string, anchorId?: string): string {
  const who = (role: string) => role === viewer ? "Du" : role === "buyer" ? "Kunden" : producerName;
  const items = rows.map((m) =>
    `<li style="margin:6px 0;padding:8px 10px;border-radius:8px;background:${m.author_role === viewer ? "#eef0ea" : "#fdf8ef"}">` +
    `<span class="mo-hint">${esc(who(m.author_role))} · ${esc(msgTime(m.created_at))}</span>` +
    `<p style="margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.body)}</p></li>`,
  ).join("");
  return `<div class="mo-block"${anchorId ? ` id="${esc(anchorId)}"` : ""}><strong>Meldinger</strong>` +
    (rows.length ? `<ul style="list-style:none;margin:6px 0 0;padding:0">${items}</ul>` : `<p class="mo-hint">Ingen meldinger ennå.</p>`) +
    `</div>`;
}

/** The PRG error code of a refused message (the pages map it to a banner). */
export function messageErrorCode(r: { status: number; code?: string }): string {
  if (r.code === "empty") return "melding-tom";
  if (r.code === "too_long") return "melding-lang";
  if (r.code === "rate_limited" || r.status === 429) return "melding-grense";
  if (r.code === "closed") return "melding-stengt";
  return "melding-feil";
}

/** The banner after a message post; "" when done/error is not about a message. */
export function messageBannerHtml(done: string, error: string, okText: string): string {
  switch (error) {
    case "melding-tom": return `<div class="mo-banner warn" role="alert">Meldingen er tom. Skriv noe før du sender.</div>`;
    case "melding-lang": return `<div class="mo-banner warn" role="alert">Meldingen er for lang. Den kan ha høyst ${ORDER_MESSAGE_MAX_CHARS} tegn.</div>`;
    case "melding-grense": return `<div class="mo-banner warn" role="alert">Du har sendt mange meldinger på denne ordren den siste timen. Prøv igjen senere.</div>`;
    case "melding-stengt": return `<div class="mo-banner warn" role="alert">Ordren er avsluttet og tar ikke imot flere meldinger.</div>`;
    case "melding-feil": return `<div class="mo-banner warn" role="alert">Kunne ikke sende meldingen. Prøv igjen.</div>`;
  }
  return done === "melding" && !error ? `<div class="mo-banner ok" role="status">${esc(okText)}</div>` : "";
}

function messagesHtml(o: OwnerOrder, ctx: RowContext): string {
  if (!isOrderMessagesEnabled()) return "";
  const thread = messageThreadHtml(listOrderMessages(o.id), "seller", o.producer_name);
  if (!ctx.messagePostTo) {
    return thread + `<p class="mo-hint">Svar kunden i Mine ordrer (krever innlogging).</p>`;
  }
  if (!orderTakesMessages(o, ctx.now)) return thread;
  return thread +
    `<form method="post" action="${esc(ctx.messagePostTo)}" class="mo-form"><input type="hidden" name="idem" value="${randomUUID()}">` +
    `<label class="mo-pick">Skriv til kunden<textarea name="message" rows="3" maxlength="${ORDER_MESSAGE_MAX_CHARS}" required style="display:block;width:100%;margin-top:4px;padding:10px;font-size:1rem;border:1px solid #d8dbd2;border-radius:8px"></textarea></label>` +
    `<button type="submit" class="mo-btn mo-secondary">Send melding</button></form>`;
}

export function renderOrderRow(o: OwnerOrder, ctx: RowContext): string {
  const st = statusLabel(o);
  const who = o.buyer_name || "Kunde";
  const pick = o.pickup_time ? `Henting ${formatPickupTimeOslo(o.pickup_time)}` : "Hentetid ikke satt";
  return `<details class="mo-row" id="${esc(ROW_ANCHOR(o.id))}"${ctx.open ? " open" : ""}>
  <summary>
    <span class="mo-top"><span class="mo-date">${esc(shortDate(o.created_at))}</span><span class="mo-who">${esc(who)}</span><span class="mo-badge mo-${st.cls}">${esc(st.text)}</span></span>
    <span class="mo-items-line">${esc(itemsSummary(o.items))}</span>
    <span class="mo-pick-line">${esc(pick)}</span>
  </summary>
  ${detailHtml(o, ctx)}
</details>`;
}

// ─── Page shell ──────────────────────────────────────────────────────────

const CSS = `
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#f5f3ee;color:#1e2b23;margin:0;line-height:1.4}
.mo-wrap{max-width:640px;margin:0 auto;padding:16px}
.mo-wrap h1{font-size:1.3rem;margin:8px 0 4px}
.mo-sub{color:#5b6a62;font-size:.9rem;margin:0 0 12px}
.mo-tabs{display:flex;gap:6px;margin:12px 0;overflow-x:auto}
.mo-tab{flex:1 0 auto;text-align:center;padding:12px 10px;border-radius:10px;background:#fff;border:1px solid #d8dbd2;color:#1e2b23;text-decoration:none;font-weight:600;font-size:.92rem;min-height:44px}
.mo-tab[aria-current=page]{background:#2c5b3f;color:#fff;border-color:#2c5b3f}
.mo-count{display:inline-block;min-width:1.4em;padding:0 6px;margin-left:4px;border-radius:999px;background:#eef0ea;color:#1e2b23;font-size:.8rem}
.mo-tab[aria-current=page] .mo-count{background:#fff;color:#2c5b3f}
.mo-row{background:#fff;border:1px solid #e4e2da;border-radius:12px;margin:10px 0;overflow:hidden}
.mo-row summary{display:block;padding:12px 14px;cursor:pointer;list-style:none;min-height:44px}
.mo-row summary::-webkit-details-marker{display:none}
.mo-top{display:flex;gap:8px;align-items:center}
.mo-date{color:#5b6a62;font-size:.85rem}
.mo-who{font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mo-badge{font-size:.78rem;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}
.mo-wait{background:#fdf3e7;color:#7a5218}.mo-ok{background:#e8f4ec;color:#1d5a30}.mo-end{background:#eef0ea;color:#41504a}
.mo-items-line,.mo-pick-line{display:block;font-size:.9rem;color:#41504a;margin-top:2px}
.mo-detail{padding:4px 14px 14px;border-top:1px solid #eef0ea}
.mo-block{margin:12px 0;font-size:.92rem}
.mo-block p{margin:4px 0}
.mo-items,.mo-tl{list-style:none;margin:6px 0 0;padding:0}
.mo-items li{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px solid #eef0ea}
.mo-tl li{padding:2px 0;color:#41504a}
.mo-sum{font-weight:700}
.mo-actions{display:flex;flex-direction:column;gap:4px}
.mo-form{margin:8px 0 0}
.mo-btn{width:100%;min-height:48px;padding:12px 18px;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer}
.mo-primary{background:#2c5b3f;color:#fff}.mo-secondary{background:#eef0ea;color:#1e2b23;border:1px solid #d8dbd2}
.mo-pick{display:block;font-size:.9rem;margin-bottom:8px}
.mo-pick input{display:block;width:100%;margin-top:4px;padding:10px;font-size:1rem;border:1px solid #d8dbd2;border-radius:8px}
.mo-menu{margin-top:12px}.mo-menu summary{cursor:pointer;color:#7a5218;font-weight:600;padding:10px 0;min-height:44px}
.mo-hint{font-size:.85rem;color:#5b6a62}
.mo-banner{border-radius:10px;padding:12px 14px;margin:12px 0;font-size:.92rem}
.mo-banner.ok{background:#e8f4ec;border:1px solid #bcd9c5;color:#1d5a30}.mo-banner.warn{background:#fdf3e7;border:1px solid #f0d4ae;color:#7a5218}
.mo-empty{color:#5b6a62;text-align:center;padding:24px 0}
.mo-link{display:block;text-align:center;margin:16px 0;color:#2c5b3f;font-weight:700;padding:12px}
`;

export function ordersShell(title: string, body: string): string {
  return ordersShellWith(title, body, null);
}

/**
 * ordersShell with the T15a owner shell (skip link + menu before <main>, and
 * <main> as the skip link's target). `ownerShellHtml` null = exactly
 * ordersShell, so the buyer's card and the token page are unchanged.
 */
function ordersShellWith(title: string, body: string, ownerShellHtml: string | null): string {
  return `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} | Rett fra Bonden</title>
<style>${CSS}</style>
</head>
<body>
${ownerShellHtml ? `${ownerShellHtml}\n<main class="mo-wrap" id="${OWNER_SHELL_MAIN_ID}" tabindex="-1">` : `<main class="mo-wrap">`}
${body}
</main>
<script>
(function(){var h=location.hash;if(h.indexOf('#o-')===0){var e=document.getElementById(h.slice(1));if(e&&e.tagName==='DETAILS'){e.open=true;e.scrollIntoView();}}})();
</script>
</body>
</html>`;
}

export function bannerHtml(done: string, error: string, t12 = false): string {
  // Fase B2: the message banners exist only while the thread is switched on.
  if (isOrderMessagesEnabled()) {
    const m = messageBannerHtml(done, error, "Meldingen er sendt til kunden.");
    if (m) return m;
  }
  if (error === "hentetid") return `<div class="mo-banner warn" role="alert">Hentetiden er ikke gyldig. Velg et tidspunkt fra i dag og fram i tid, eller la feltet stå tomt.</div>`;
  if (error === "allerede-hentet") return `<div class="mo-banner ok" role="status">Ordren er allerede registrert som hentet. Ingenting ble endret.</div>`;
  if (error === "ugyldig") return `<div class="mo-banner warn" role="alert">Handlingen er ikke gyldig for ordrens status akkurat nå.</div>`;
  if (error) return `<div class="mo-banner warn" role="alert">Kunne ikke oppdatere ordren. Prøv igjen.</div>`;
  const t12Text = t12 && !error ? t12DoneBannerText(done) : "";
  if (t12Text) return `<div class="mo-banner ok" role="status">${esc(t12Text)}</div>`;
  const labels: Record<string, string> = {
    confirmed: "Bestillingen er bekreftet.", declined: "Bestillingen er avslått.", cancelled: "Ordren er kansellert.", completed: "Bestillingen er registrert som hentet.", ready: "Bestillingen er oppdatert.",
  };
  return labels[done] ? `<div class="mo-banner ok" role="status">${esc(labels[done])}</div>` : "";
}

export function renderOrdersPage(opts: {
  agentId: string;
  producerName: string;
  tab: OwnerOrdersTab;
  counts: Record<OwnerOrdersTab, number>;
  orders: OwnerOrder[];
  openId: string | null;
  done: string;
  error: string;
  now?: Date;
  /** T6: the shared owner theme (dark mode, token classes); allowlisted subjects only. */
  ownerTheme?: boolean;
  /** T12: the cancellation component and the overview (allowlisted subjects only; absent = page as before). */
  t12?: { overview: OwnerOrderOverview } | null;
  /** T15a: the owner shell's markup (renderOwnerShellStart); absent = page as before. */
  ownerShellHtml?: string | null;
}): string {
  const base = `/eier/${encodeURIComponent(opts.agentId)}/ordrer`;
  const tabs = OWNER_ORDERS_TABS.map((t) =>
    `<a class="mo-tab" href="${base}?tab=${t.key}"${t.key === opts.tab ? ` aria-current="page"` : ""}>${esc(t.label)}<span class="mo-count">${opts.counts[t.key]}</span></a>`,
  ).join("");
  const rows = opts.orders.map((o) =>
    renderOrderRow(o, {
      postTo: `${base}/${encodeURIComponent(o.id)}`, open: o.id === opts.openId, now: opts.now,
      messagePostTo: `${base}/${encodeURIComponent(o.id)}/melding`,
      ...(opts.t12 ? { t12: true } : {}),
    }),
  ).join("\n");
  const empty = opts.orders.length ? "" : `<p class="mo-empty">${opts.tab === "venter" ? "Ingen bestillinger venter på svar." : opts.tab === "kommende" ? "Ingen kommende henting." : "Ingen avsluttede bestillinger ennå."}</p>`;
  // F-b (tekstpakke A): with the owner shell its menu already links to the portal, so no «← Eierportalen» back link.
  const backLink = opts.ownerShellHtml ? "" : `<p class="mo-sub"><a href="/eier/${encodeURIComponent(opts.agentId)}/portal">← Eierportalen</a></p>\n`;
  const body = `
${backLink}<h1>Mine ordrer</h1>
<p class="mo-sub">${esc(opts.producerName)}</p>
${opts.t12 ? `${ownerOrderOverviewHtml(opts.t12.overview)}\n` : ""}${bannerHtml(opts.done, opts.error, !!opts.t12)}
<nav class="mo-tabs" aria-label="Ordrer">${tabs}</nav>
${rows}${empty}`;
  return ordersShellWith(`Mine ordrer · ${opts.producerName}`,
    opts.ownerTheme ? `<style>${OWNER_ORDERS_THEME_CSS}</style>${ownerThemeHtml(body)}` : body,
    opts.ownerShellHtml || null);
}

/** The single-order view opened from the e-mail (token). Shows that order only. */
export function renderTokenOrderPage(o: OwnerOrder, tokenBase: string, done: string, error: string, now?: Date, t12 = false): string {
  return ordersShell(`Ordre ${o.id.slice(0, 8)}`, `
<h1>Henteordre hos ${esc(o.producer_name)}</h1>
<p class="mo-sub">Ordre ${esc(o.id.slice(0, 8))}</p>
${bannerHtml(done, error, t12)}
${renderOrderRow(o, { postTo: tokenBase, open: true, now, ...(t12 ? { t12: true } : {}) })}
<a class="mo-link" href="/eier/${encodeURIComponent(o.agent_id)}/ordrer">Se alle bestillingene dine</a>
<p class="mo-hint">Lenken er personlig for denne bestillingen. Ikke del den videre. Kunden betaler deg når varene hentes. Rett fra Bonden tar ikke betalt.</p>`);
}

/** The «Mine ordrer» card on the owner portal front page. */
export function ownerOrdersEntryCardHtml(agentId: string, pending: number): string {
  const id = encodeURIComponent(agentId);
  const badge = pending > 0 ? ` <span class="mo-count" style="background:#fdf3e7;color:#7a5218;padding:2px 10px;border-radius:999px;">${pending} venter på svar</span>` : "";
  return `<div class="ep-card" id="mine-ordrer">
        <h2>Mine ordrer${badge}</h2>
        <p style="margin-bottom:12px;color:#737373;font-size:0.88rem;">Se alle bestillingene dine ett sted. Du trenger bare å bekrefte eller avslå.</p>
        <a class="ep-btn ep-btn-primary" href="/eier/${id}/ordrer">Åpne Mine ordrer</a>
      </div>`;
}
