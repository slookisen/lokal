/**
 * Order-notify service — seller notification for cart orders (RFB).
 * dev-request 2026-07-13-pilot-ordre-loop.
 *
 * Send-guard (L4 condition, Daniel-approved — every clause is mandatory):
 *   1. agents.order_notifications_opt_in = 1 (default 0 → NEVER send).
 *   2. A recipient email exists: order_notification_email (admin-set
 *      override) wins; otherwise contact_email.
 *   3. Verified contact: agent_knowledge.verification_status = 'verified',
 *      OR the recipient is an explicit admin-set order_notification_email
 *      (this is how test notifications go ONLY to Daniel's own inbox —
 *      same pattern as the booking test provider).
 *   4. The recipient email is not blocklisted (blocklist-service.isBlocked,
 *      the same suppression gate the outreach paths use).
 *
 * dev-request 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt,
 * skive 2 (hybrid utsending) — Daniel 2026-10-01, «bygg skive 2 uten
 * lempningen»: this gate is UNCHANGED. No clause was widened — in particular
 * there is NO `OR agents.is_verified = 1` alternative on clause 3 (the
 * widening the spec originally asked for was dropped by Daniel's decision,
 * see daniel-responses/2026-10-01-live-go-synk-flagg-og-skive-2-uten-
 * lempning.md). Slice 2 only (a) adds the email template v2 below, which
 * carries the buyer's contact fields when the buyer consented to sharing
 * them, and (b) moves the decision "does this producer get a real order at
 * all" to cart-service.ts's isEligibleForRealOrder(), which is STRICTER than
 * this gate (it additionally requires the internal cross-check, an
 * owner-claimed profile and an active account) — so every order that reaches
 * this send path already has a resolvable recipient unless state changed in
 * between submit and send.
 *
 * A failed/skipped notification must NEVER fail the order submit — callers
 * fire-and-forget (same posture as booking-store.sendProducerNotification).
 *
 * Email template versioning (skive 2): v2 (default) = v1 + a «Kunde» block
 * (name / phone / e-mail / delivery wish — only the fields actually present
 * on the order) + Reply-To set to the buyer's e-mail when given and
 * plausible. v1 is byte-for-byte the original pilot-ordre-loop template and
 * stays selectable via ORDER_NOTIFY_EMAIL_VERSION=v1 («v1 beholdes bak
 * versjonsflagg») — same versioned-render + dispatcher pattern as
 * email-service.ts's renderGardssalgOutreachVariant.
 *
 * Privacy: buyer_name/buyer_email/buyer_phone/delivery_note are personal
 * data — this module NEVER logs them (the log lines below carry ids only).
 */

import { getDb } from "../database/init";
import { isBlocked } from "./blocklist-service";
import { emailService, EmailOptions } from "./email-service";
import { isOrderAutocompleteEnabled } from "./order-lifecycle";
import { PRICE_BY_AGREEMENT, PARTIAL_SUM_LABEL } from "./order-pricing";
import { formatOsloDayLabel } from "./order-cap-notice";

const APP_URL = process.env.APP_URL || "https://rettfrabonden.com";

/** The platform Reply-To every order notification used before skive 2, now named. */
export const DEFAULT_ORDER_NOTIFY_REPLY_TO = "kontakt@rettfrabonden.com";

// Module-local test pins (race-proof, same idiom as cart-service).
let _notifyTestDb: any = null;
export function __setOrderNotifyTestDb(db: any): void { _notifyTestDb = db; }

type SendFn = (opts: EmailOptions) => Promise<{ success: boolean; messageId?: string; error?: string }>;
let _sendOverride: SendFn | null = null;
export function __setOrderNotifySendForTesting(fn: SendFn | null): void { _sendOverride = fn; }

// ─── Recipient resolution (the gate) ────────────────────────────────────────

export type RecipientResolution =
  | { eligible: true; email: string; via: "admin_override" | "verified_contact" }
  | { eligible: false; reason: "agent_not_found" | "not_opted_in" | "no_email" | "unverified_contact" | "blocklisted" };

export function resolveOrderNotificationRecipient(agentId: string): RecipientResolution {
  const db = _notifyTestDb ?? getDb();
  const row = db.prepare(`
    SELECT a.order_notifications_opt_in AS opt_in,
           a.order_notification_email   AS override_email,
           a.contact_email              AS contact_email,
           k.verification_status        AS verification_status
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
    WHERE a.id = ?
  `).get(agentId) as
    | { opt_in: number; override_email: string | null; contact_email: string | null; verification_status: string | null }
    | undefined;

  if (!row) return { eligible: false, reason: "agent_not_found" };
  // Gate 1: explicit opt-in. Default 0 → never send.
  if (row.opt_in !== 1) return { eligible: false, reason: "not_opted_in" };

  // Gate 2: a recipient exists. Admin override wins over contact_email.
  const overrideEmail = (row.override_email || "").trim();
  const email = overrideEmail || (row.contact_email || "").trim();
  if (!email) return { eligible: false, reason: "no_email" };

  // Gate 3: verified contact, unless the admin explicitly set the recipient.
  if (!overrideEmail && row.verification_status !== "verified") {
    return { eligible: false, reason: "unverified_contact" };
  }

  // Gate 4: suppression — never mail a blocklisted address.
  const bl = isBlocked({ email });
  if (bl.blocked) return { eligible: false, reason: "blocklisted" };

  return { eligible: true, email, via: overrideEmail ? "admin_override" : "verified_contact" };
}

// ─── Notification content ───────────────────────────────────────────────────

export interface OrderNotificationInput {
  order_id: string;
  agent_id: string;
  producer_name: string;
  buyer_ref: string;
  confirm_token: string;
  pickup_time: string | null;
  /**
   * The sum over the lines that have a price; null = no line has a price (no
   * sum row is rendered — F6, never «0 kr»).
   */
  total_nok: number | null;
  /** F6: at least one line has no price, so the sum is labelled «Sum for varer med pris». */
  total_is_partial?: boolean;
  /** `line_total: null` (explicit) = the line has no price → «Pris avtales med produsenten». */
  items: Array<{ name: string; qty: number; unit: string | null; line_total?: number | null }>;
  // skive 2 (hybrid utsending): optional buyer contact fields. cart-service's
  // submitCart() only ever passes them when the buyer explicitly consented
  // (contact_consent=true) — a null/absent field is simply left out of the
  // rendered mail, never shown as a blank row. NEVER logged.
  buyer_name?: string | null;
  buyer_email?: string | null;
  buyer_phone?: string | null;
  delivery_note?: string | null;
  // Prepayment (A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-
  // connect, skive 2). Absent on every order without a prepayment attempt —
  // then both templates are byte-for-byte what they were. Present only on
  // the notification payment-service.ts sends when the payment is
  // authorized ("authorized") or when a prepay order fell back to paying at
  // pickup ("not_prepaid"); it replaces the «Ingen betaling skjer via
  // plattformen» line, which would be false for a prepaid order (also in v1).
  /** F4: the single reminder for an order the producer has not answered (same link). */
  reminder?: boolean;
  payment?:
    | { status: "authorized"; amount_nok: number; confirm_by: string | null }
    | { status: "not_prepaid" }
    | { status: "payment_released" };
}

export type OrderNotifyEmailVersion = "v1" | "v2";

/**
 * v2 is the default (it is what actually delivers the buyer's contact info
 * to the producer — the point of skive 2); v1 is reachable ONLY via an
 * explicit opt-out, for rollback. Read fresh on every call (never cached at
 * module load) so an operator can flip it without a restart and tests can
 * flip it per case.
 */
export function resolveOrderNotifyEmailVersion(): OrderNotifyEmailVersion {
  return process.env.ORDER_NOTIFY_EMAIL_VERSION === "v1" ? "v1" : "v2";
}

// Reply-To is a MAIL HEADER. A buyer-supplied value is used only when it is a
// single, plausible address with no whitespace, angle brackets, quotes or
// separators (header-injection / display-name-smuggling guard); anything
// else — including an empty value — falls back to the platform default.
const REPLY_TO_EMAIL_RE = /^[^\s@<>,;"'()\\\x00-\x1f\x7f]+@[^\s@<>,;"'()\\\x00-\x1f\x7f]+\.[A-Za-z0-9-]{2,}$/;

export function resolveReplyTo(buyerEmail: string | null | undefined): string {
  const e = (buyerEmail || "").trim();
  return e && e.length <= 254 && REPLY_TO_EMAIL_RE.test(e) ? e : DEFAULT_ORDER_NOTIFY_REPLY_TO;
}

export interface RenderedOrderNotificationEmail {
  subject: string;
  htmlContent: string;
  textContent: string;
  replyTo: string;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The buyer_ref is the BUYER's capability token (it authorizes order reads).
// The producer only needs it as an opaque reference, so we surface a
// truncated form — never the full token (mirror of the booking-side
// commission-integrity rule: capability tokens go only to their own party).
function maskBuyerRef(buyerRef: string): string {
  return buyerRef.length <= 12 ? buyerRef : `${buyerRef.slice(0, 12)}…`;
}

function renderItemRowsHtml(items: OrderNotificationInput["items"]): string {
  return items
    .map(
      (i) =>
        `<tr><td style="padding:4px 12px 4px 0">${escHtml(i.name)}</td><td>${i.qty}${i.unit ? " " + escHtml(i.unit) : ""}</td>${i.line_total === null ? `<td style="padding-left:12px">${escHtml(PRICE_BY_AGREEMENT)}</td>` : ""}</tr>`
    )
    .join("\n  ");
}

function renderItemLinesText(items: OrderNotificationInput["items"]): string {
  return items.map((i) => `- ${i.name}: ${i.qty}${i.unit ? " " + i.unit : ""}${i.line_total === null ? ` — ${PRICE_BY_AGREEMENT}` : ""}`).join("\n");
}

/** F6: the sum row label (partial sums say so); the row is omitted when total_nok is null. */
function sumLabelOf(order: OrderNotificationInput): string {
  return order.total_is_partial ? PARTIAL_SUM_LABEL : "Sum";
}

const NO_PAYMENT_HTML = "<p>Ingen betaling skjer via plattformen; oppgjør ved henting som vanlig.</p>";
const NO_PAYMENT_TEXT = "Ingen betaling skjer via plattformen; oppgjør ved henting som vanlig.";

function formatNok(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ",");
}

/** The payment line + subject for a notification (unchanged when `payment` is absent). */
interface PaymentCopy { html: string; text: string; subject: string; intro?: string; link?: string }
const DEFAULT_INTRO = "Du har fått en ny henteordre via Rett fra Bonden";
const DEFAULT_LINK = "Bekreft eller avslå ordren her";
function paymentCopy(order: OrderNotificationInput, orderRef: string): Required<PaymentCopy> {
  const c = paymentCopyInner(order, orderRef);
  const merged = { intro: DEFAULT_INTRO, link: DEFAULT_LINK, ...c };
  if (order.reminder) {
    return {
      ...merged,
      subject: `Påminnelse: henteordre venter på svar — ${orderRef}`,
      intro: "Påminnelse: du har en henteordre via Rett fra Bonden som ikke er besvart ennå. Kunden venter på bekreftelse eller avslag",
    };
  }
  return merged;
}
function paymentCopyInner(order: OrderNotificationInput, orderRef: string): PaymentCopy {
  const p = order.payment;
  if (p?.status === "authorized") {
    const deadline = p.confirm_by ? ` Bekreft innen ${p.confirm_by}, ellers frigjøres reservasjonen automatisk og ordren kanselleres.` : "";
    const sentence = `Beløpet er reservert på kundens betalingskort og trekkes først når du bekrefter ordren. Avslår du, frigjøres reservasjonen.${deadline} Pengene går til din egen Stripe-konto.`;
    return {
      html: `<p><strong>Kunden har betalt ${formatNok(p.amount_nok)} kr på forhånd.</strong> ${escHtml(sentence)}</p>`,
      text: `Kunden har betalt ${formatNok(p.amount_nok)} kr på forhånd. ${sentence}`,
      subject: `Ny forhåndsbetalt henteordre — ${orderRef}`,
    };
  }
  if (p?.status === "payment_released") {
    return {
      html: "<p><strong>Rettelse:</strong> Forhåndsbetalingen for denne ordren er frigjort og blir ikke trukket. Oppgjør ved henting som vanlig.</p>",
      text: "Rettelse: Forhåndsbetalingen for denne ordren er frigjort og blir ikke trukket. Oppgjør ved henting som vanlig.",
      subject: `Endring i henteordre — ${orderRef}`,
      // Not a new order: the producer already got this one (review finding).
      intro: "Det er en endring i en henteordre du allerede har fått via Rett fra Bonden",
      link: "Se ordren her",
    };
  }
  if (p?.status === "not_prepaid") {
    return {
      html: "<p>Kunden betalte ikke på forhånd. Oppgjør ved henting som vanlig.</p>",
      text: "Kunden betalte ikke på forhånd. Oppgjør ved henting som vanlig.",
      subject: `Ny henteordre — ${orderRef}`,
    };
  }
  return { html: NO_PAYMENT_HTML, text: NO_PAYMENT_TEXT, subject: `Ny henteordre — ${orderRef}` };
}

/**
 * v1 — the ORIGINAL pilot-ordre-loop template, byte-for-byte unchanged.
 * Never includes buyer contact fields, whatever the order carries — that is
 * the whole point of being able to pin v1.
 */
export function renderOrderNotificationEmailV1(order: OrderNotificationInput): RenderedOrderNotificationEmail {
  const orderRef = order.order_id.slice(0, 8);
  const confirmUrl = `${APP_URL}/produsent/ordre/${encodeURIComponent(order.confirm_token)}`;
  const itemRows = renderItemRowsHtml(order.items);
  const itemLines = renderItemLinesText(order.items);
  const pay = paymentCopy(order, orderRef);

  const htmlContent = `
<p>Hei,</p>
<p>${escHtml(pay.intro)}:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Ordre-ref:</td><td>${escHtml(orderRef)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Kjøper-ref:</td><td>${escHtml(maskBuyerRef(order.buyer_ref))}</td></tr>
  ${order.pickup_time ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Hentetid:</td><td>${escHtml(order.pickup_time)}</td></tr>` : ""}
  ${order.total_nok != null ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">${sumLabelOf(order)}:</td><td>${order.total_nok} kr</td></tr>` : ""}
</table>
<p style="font-weight:bold;margin-bottom:4px">Varer:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  ${itemRows}
</table>
<p><a href="${confirmUrl}">${escHtml(pay.link)}</a> — her bekrefter eller avslår du ordren.<br>
Lenken er personlig for denne ordren — ikke del den videre.</p>
${pay.html}
<p>Hilsen<br>Rett fra Bonden</p>
    `.trim();

  const textContent = `Hei,\n\n${pay.intro}.\nOrdre-ref: ${orderRef}\nKjøper-ref: ${maskBuyerRef(order.buyer_ref)}${order.pickup_time ? `\nHentetid: ${order.pickup_time}` : ""}${order.total_nok != null ? `\n${sumLabelOf(order)}: ${order.total_nok} kr` : ""}\n\nVarer:\n${itemLines}\n\n${pay.link} (personlig lenke, ikke del videre):\n${confirmUrl}\n\n${pay.text}\n\nHilsen\nRett fra Bonden`;

  return { subject: pay.subject, htmlContent, textContent, replyTo: DEFAULT_ORDER_NOTIFY_REPLY_TO };
}

/**
 * v2 (default) — everything v1 has, PLUS a «Kunde» block with the buyer's
 * name / phone / e-mail / delivery wish (only the fields present) and
 * Reply-To set to the buyer's e-mail when given and plausible (else the same
 * platform default v1 uses). With no buyer fields at all the rendered mail
 * is identical to v1 apart from nothing — the block is omitted entirely.
 */
export function renderOrderNotificationEmailV2(order: OrderNotificationInput): RenderedOrderNotificationEmail {
  const orderRef = order.order_id.slice(0, 8);
  // Fase A2: the main button opens THIS order in the compact «Mine ordrer» view
  // (per-order token, no login); «Se alle ordrene dine» needs a login.
  const confirmUrl = `${APP_URL}/produsent/ordre/${encodeURIComponent(order.confirm_token)}/kompakt`;
  const allOrdersUrl = `${APP_URL}/eier/${encodeURIComponent(order.agent_id)}/ordrer`;
  const itemRows = renderItemRowsHtml(order.items);
  const itemLines = renderItemLinesText(order.items);
  const pay = paymentCopy(order, orderRef);
  const linkLabel = pay.link === DEFAULT_LINK ? "Se og bekreft bestillingen" : pay.link;
  // Only the new-order mail promises the automatic close, and only while it is switched on (never a promise the platform does not keep).
  const autoCloseLine = !order.reminder && !order.payment?.status?.startsWith("payment_") && isOrderAutocompleteEnabled()
    ? "Du trenger bare å bekrefte eller avslå. Ordren avsluttes av seg selv etter henting." : "";

  const buyerName = (order.buyer_name || "").trim() || null;
  const buyerEmail = (order.buyer_email || "").trim() || null;
  const buyerPhone = (order.buyer_phone || "").trim() || null;
  const deliveryNote = (order.delivery_note || "").trim() || null;

  const buyerRowsHtml = [
    buyerName ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Navn:</td><td>${escHtml(buyerName)}</td></tr>` : "",
    buyerPhone ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Telefon:</td><td>${escHtml(buyerPhone)}</td></tr>` : "",
    buyerEmail ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">E-post:</td><td>${escHtml(buyerEmail)}</td></tr>` : "",
    deliveryNote ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Leveringsønske:</td><td>${escHtml(deliveryNote)}</td></tr>` : "",
  ]
    .filter(Boolean)
    .join("\n  ");
  const buyerBlockHtml = buyerRowsHtml
    ? `<p style="font-weight:bold;margin-bottom:4px">Kunde:</p>\n<table style="border-collapse:collapse;font-family:sans-serif">\n  ${buyerRowsHtml}\n</table>\n`
    : "";

  const buyerLinesText = [
    buyerName ? `Navn: ${buyerName}` : "",
    buyerPhone ? `Telefon: ${buyerPhone}` : "",
    buyerEmail ? `E-post: ${buyerEmail}` : "",
    deliveryNote ? `Leveringsønske: ${deliveryNote}` : "",
  ].filter(Boolean);
  const buyerBlockText = buyerLinesText.length ? `\nKunde:\n${buyerLinesText.join("\n")}\n` : "";

  const htmlContent = `
<p>Hei,</p>
<p>${escHtml(pay.intro)}:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Ordre-ref:</td><td>${escHtml(orderRef)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Kjøper-ref:</td><td>${escHtml(maskBuyerRef(order.buyer_ref))}</td></tr>
  ${order.pickup_time ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Hentetid:</td><td>${escHtml(order.pickup_time)}</td></tr>` : ""}
  ${order.total_nok != null ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">${sumLabelOf(order)}:</td><td>${order.total_nok} kr</td></tr>` : ""}
</table>
${buyerBlockHtml}<p style="font-weight:bold;margin-bottom:4px">Varer:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  ${itemRows}
</table>
<p><a href="${confirmUrl}" style="display:inline-block;background:#2c5b3f;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escHtml(linkLabel)}</a><br>
Lenken er personlig for denne ordren — ikke del den videre.</p>
${autoCloseLine ? `<p>${escHtml(autoCloseLine)}</p>\n` : ""}<p><a href="${allOrdersUrl}">Se alle ordrene dine</a> (krever innlogging)</p>
${pay.html}
<p>Hilsen<br>Rett fra Bonden</p>
    `.trim();

  const textContent = `Hei,\n\n${pay.intro}.\nOrdre-ref: ${orderRef}\nKjøper-ref: ${maskBuyerRef(order.buyer_ref)}${order.pickup_time ? `\nHentetid: ${order.pickup_time}` : ""}${order.total_nok != null ? `\n${sumLabelOf(order)}: ${order.total_nok} kr` : ""}\n${buyerBlockText}\nVarer:\n${itemLines}\n\n${linkLabel} (personlig lenke, ikke del videre):\n${confirmUrl}\n\n${autoCloseLine ? autoCloseLine + "\n\n" : ""}Se alle ordrene dine (krever innlogging): ${allOrdersUrl}\n\n${pay.text}\n\nHilsen\nRett fra Bonden`;

  return {
    subject: pay.subject,
    htmlContent,
    textContent,
    replyTo: resolveReplyTo(buyerEmail),
  };
}

/** The one dispatcher the send path goes through — single source for the version switch. */
export function renderOrderNotificationEmail(
  version: OrderNotifyEmailVersion,
  order: OrderNotificationInput
): RenderedOrderNotificationEmail {
  return version === "v1" ? renderOrderNotificationEmailV1(order) : renderOrderNotificationEmailV2(order);
}

// ─── Notification send ──────────────────────────────────────────────────────

export type OrderNotifyOutcome = "sent" | "skipped" | "failed";

/**
 * F4: records that the producer e-mail for an order FAILED (a skip because the
 * producer is not eligible is no failure). Best-effort: a DB without the
 * column (minimal test schema) is tolerated.
 */
function markNotifyFailed(orderId: string): void {
  try {
    const db = _notifyTestDb ?? getDb();
    db.prepare("UPDATE orders SET notify_failed_at = COALESCE(notify_failed_at, datetime('now')) WHERE id = ?").run(orderId);
  } catch { /* best-effort */ }
}

/**
 * Skive 1b (B1): records that the producer e-mail for an order was actually
 * SENT (the first send or the follow-ups retry, never the reminder). The
 * follow-ups job only reminds about and auto-cancels orders carrying this
 * stamp. Best-effort like markNotifyFailed: a DB without the column is
 * tolerated (the order then simply gets no follow-ups, the safe side).
 */
function markNotifySent(orderId: string): void {
  try {
    const db = _notifyTestDb ?? getDb();
    db.prepare("UPDATE orders SET notify_sent_at = COALESCE(notify_sent_at, datetime('now')) WHERE id = ?").run(orderId);
  } catch { /* best-effort */ }
}

/**
 * F4: the admin alert («den eksisterende varselkanalen» = the admin
 * notification e-mail, ADMIN_NOTIFICATION_EMAIL, same as the claim
 * notifications). No address configured → logged only. Never throws.
 */
export async function sendAdminOrderAlert(subject: string, text: string): Promise<boolean> {
  const to = (process.env.ADMIN_NOTIFICATION_EMAIL || "").trim();
  console.error(`[order-followup] ALERT ${subject}`);
  if (!to) return false;
  try {
    const send: SendFn = _sendOverride ?? ((opts) => emailService.sendEmail(opts));
    const res = await send({ to, subject, textContent: text, omitAgentHeader: true });
    return !!res?.success;
  } catch (err) {
    console.error("[order-followup] admin alert send failed:", err);
    return false;
  }
}

/**
 * Fire-and-forget seller notification for one freshly created order.
 * Resolves the gated recipient, sends via emailService, and logs
 * `[order-notify] sent <ms>` on success so the <1 min SLA is measurable.
 * Never throws.
 *
 * F4: a FAILED send (transport error, not a skip) marks the order
 * (orders.notify_failed_at) and alerts the admin once; the followups job then
 * retries once (`opts.retry`). A failed retry alerts again.
 */
export async function sendOrderNotificationForOrder(order: OrderNotificationInput, opts: { retry?: boolean; reminder?: boolean } = {}): Promise<OrderNotifyOutcome> {
  const started = Date.now();
  const fail = async (why: string): Promise<OrderNotifyOutcome> => {
    // The reminder is its own single send: it neither re-arms the retry of
    // the original e-mail nor gets retried itself.
    if (!opts.retry && !opts.reminder) markNotifyFailed(order.order_id);
    const what = opts.reminder ? "påminnelsen til produsenten" : "produsent-e-posten";
    await sendAdminOrderAlert(
      opts.retry ? `Ordre ${order.order_id.slice(0, 8)}: nytt forsøk på produsent-e-post feilet` : `Ordre ${order.order_id.slice(0, 8)}: ${what} feilet`,
      `${what[0]!.toUpperCase()}${what.slice(1)} for ordre ${order.order_id} (produsent ${order.producer_name}, ${order.agent_id}) kunne ikke sendes${opts.retry ? " heller ved nytt forsøk" : ""}.\nÅrsak: ${why}\n` +
      (opts.retry || opts.reminder ? "Ingen flere forsøk. Kontakt produsenten direkte." : "Systemet prøver én gang til."),
    );
    return "failed";
  };
  try {
    const recipient = resolveOrderNotificationRecipient(order.agent_id);
    if (!recipient.eligible) {
      console.log(
        `[order-notify] skipped order=${order.order_id} agent=${order.agent_id} reason=${recipient.reason}`
      );
      // Skive 1b (B1): an order that exists but never reached the producer
      // (they turned orders off, or the address was blocklisted, between the
      // submit and this send) gets no notify_sent_at, so the follow-ups never
      // call it «not answered». The admin is told once, here, instead. The
      // reminder reports its own outcome (order-followups), and a retry only
      // follows a failure, so neither alerts again.
      if (!opts.retry && !opts.reminder) {
        // Review round 2 (S4): an order that already reached the producer
        // once (e.g. a prepay order notified at authorization whose later
        // fallback notice is skipped) is still followed up as usual.
        let sentBefore: string | null = null;
        try {
          const db = _notifyTestDb ?? getDb();
          sentBefore = (db.prepare("SELECT notify_sent_at FROM orders WHERE id = ?").get(order.order_id) as { notify_sent_at: string | null } | undefined)?.notify_sent_at ?? null;
        } catch { /* best-effort */ }
        await sendAdminOrderAlert(
          `Ordre ${order.order_id.slice(0, 8)}: produsent-e-posten ble ikke sendt`,
          `Ordre ${order.order_id} (produsent ${order.producer_name}, ${order.agent_id}) ble ikke sendt til produsenten (${recipient.reason}).\n` +
          (sentBefore
            ? `Produsenten fikk ordren tidligere (${sentBefore} UTC), så den følges opp som vanlig.`
            : "Ordren står som «venter på bekreftelse», men får verken påminnelse eller automatisk kansellering. Kontakt produsenten eller kjøperen direkte."),
        );
      }
      return "skipped";
    }

    const rendered = renderOrderNotificationEmail(resolveOrderNotifyEmailVersion(), order);

    const send: SendFn = _sendOverride ?? ((opts) => emailService.sendEmail(opts));
    const result = await send({
      to: recipient.email,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
      replyTo: rendered.replyTo,
      // F8: an order mail is transactional, not outreach.
      omitAgentHeader: true,
    });

    const ms = Date.now() - started;
    if (result && result.success) {
      // Latency log line — the <1 min notification SLA is measured off this.
      console.log(`[order-notify] sent ${ms}ms order=${order.order_id} agent=${order.agent_id} via=${recipient.via}`);
      if (!opts.reminder) markNotifySent(order.order_id);
      return "sent";
    }
    console.error(
      `[order-notify] send FAILED order=${order.order_id} agent=${order.agent_id}: ${result?.error || "unknown error"}`
    );
    return await fail(String(result?.error || "unknown error").slice(0, 200));
  } catch (err) {
    console.error(`[order-notify] send FAILED order=${order.order_id} agent=${order.agent_id}:`, err);
    return await fail(String((err as any)?.message || err).slice(0, 200));
  }
}

/**
 * Fase B1 (dev-request 2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent):
 * the producer is told when the BUYER withdraws (pending) or cancels (after
 * confirmation) through a buyer channel (MCP, the order card). Same gated
 * recipient (resolveOrderNotificationRecipient) and the same send path as the
 * order e-mail; no buyer contact data in it. Only for an order whose order
 * e-mail actually reached the producer (notify_sent_at): a producer who never
 * got the order has nothing to stop. Fire-and-forget; never throws.
 */
export async function sendProducerBuyerCancelNotice(orderId: string, kind: "withdraw" | "cancel"): Promise<OrderNotifyOutcome> {
  try {
    const db = _notifyTestDb ?? getDb();
    const o = db.prepare(`
      SELECT o.id, o.agent_id, o.notify_sent_at, a.name AS producer_name
      FROM orders o INNER JOIN agents a ON a.id = o.agent_id
      WHERE o.id = ?
    `).get(orderId) as { id: string; agent_id: string; notify_sent_at: string | null; producer_name: string } | undefined;
    if (!o) return "skipped";
    if (!o.notify_sent_at) {
      console.log(`[order-notify] buyer-cancel notice skipped order=${orderId} reason=order_not_sent`);
      return "skipped";
    }
    const recipient = resolveOrderNotificationRecipient(o.agent_id);
    if (!recipient.eligible) {
      console.log(`[order-notify] buyer-cancel notice skipped order=${orderId} agent=${o.agent_id} reason=${recipient.reason}`);
      return "skipped";
    }
    const items = db.prepare("SELECT name_snapshot, qty FROM order_items WHERE order_id = ? ORDER BY rowid").all(orderId) as
      Array<{ name_snapshot: string | null; qty: number | null }>;
    const orderRef = o.id.slice(0, 8);
    const allOrdersUrl = `${APP_URL}/eier/${encodeURIComponent(o.agent_id)}/ordrer`;
    const what = kind === "withdraw"
      ? `Kunden har trukket bestillingen ${orderRef} før du bekreftet den. Ordren er kansellert, og den teller ikke mot deg. Du trenger ikke gjøre noe.`
      : `Kunden har avbestilt bestillingen ${orderRef} etter at du bekreftet den. Ordren er kansellert, så du trenger ikke holde av varene.`;
    const itemLines = items.map((i) => `- ${i.qty ?? "?"} × ${i.name_snapshot || "Vare"}`).join("\n");
    const textContent = `Hei,\n\n${what}\n\nVarer:\n${itemLines}\n\nSe alle ordrene dine (krever innlogging): ${allOrdersUrl}\n\nHilsen\nRett fra Bonden`;
    const subject = kind === "withdraw" ? `Kunden har trukket bestillingen (${orderRef})` : `Kunden har avbestilt (${orderRef})`;
    const send: SendFn = _sendOverride ?? ((opts) => emailService.sendEmail(opts));
    const res = await send({
      to: recipient.email,
      subject,
      htmlContent: `<p>Hei,</p>\n<p>${escHtml(what)}</p>\n<p><a href="${allOrdersUrl}">Se alle ordrene dine</a> (krever innlogging)</p>\n<p>Hilsen<br>Rett fra Bonden</p>`,
      textContent,
      replyTo: DEFAULT_ORDER_NOTIFY_REPLY_TO,
      // F8: transactional, not outreach.
      omitAgentHeader: true,
    });
    if (res && res.success) {
      console.log(`[order-notify] buyer-cancel notice sent order=${orderId} agent=${o.agent_id} kind=${kind}`);
      return "sent";
    }
    console.error(`[order-notify] buyer-cancel notice FAILED order=${orderId} agent=${o.agent_id}: ${res?.error || "unknown error"}`);
    return "failed";
  } catch (err) {
    console.error(`[order-notify] buyer-cancel notice FAILED order=${orderId}:`, err);
    return "failed";
  }
}

/**
 * Fase B2 (dev-request 2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent):
 * the producer is told that the BUYER wrote a message on an order (MCP
 * lokal_order_message or the order card). Same gated recipient
 * (resolveOrderNotificationRecipient) and the same send path as the order
 * e-mail, and like sendProducerBuyerCancelNotice only for an order whose
 * order e-mail reached the producer (notify_sent_at). The mail carries the
 * message text (escaped) and links to the order: the per-order view of the
 * order e-mail (no login) and «Mine ordrer» (login), where the producer
 * answers. No buyer contact data in it: the Reply-To is the platform
 * address, so a reply never reveals anything new to either side.
 * Fire-and-forget; never throws; the text is never logged.
 */
export async function sendProducerOrderMessageNotice(orderId: string, messageText: string): Promise<OrderNotifyOutcome> {
  try {
    const db = _notifyTestDb ?? getDb();
    const o = db.prepare(`
      SELECT o.id, o.agent_id, o.notify_sent_at, o.confirm_token, a.name AS producer_name
      FROM orders o INNER JOIN agents a ON a.id = o.agent_id
      WHERE o.id = ?
    `).get(orderId) as { id: string; agent_id: string; notify_sent_at: string | null; confirm_token: string | null; producer_name: string } | undefined;
    if (!o) return "skipped";
    if (!o.notify_sent_at) {
      console.log(`[order-notify] message notice skipped order=${orderId} reason=order_not_sent`);
      return "skipped";
    }
    const recipient = resolveOrderNotificationRecipient(o.agent_id);
    if (!recipient.eligible) {
      console.log(`[order-notify] message notice skipped order=${orderId} agent=${o.agent_id} reason=${recipient.reason}`);
      return "skipped";
    }
    const orderRef = o.id.slice(0, 8);
    const orderUrl = o.confirm_token ? `${APP_URL}/produsent/ordre/${encodeURIComponent(o.confirm_token)}/kompakt` : null;
    const mineUrl = `${APP_URL}/eier/${encodeURIComponent(o.agent_id)}/ordrer?o=${encodeURIComponent(o.id)}#o-${encodeURIComponent(o.id)}`;
    const quoted = messageText.split("\n").map((l) => `> ${l}`).join("\n");
    const textContent =
      `Hei,\n\nKunden har skrevet en melding om bestillingen ${orderRef}:\n\n${quoted}\n\n` +
      (orderUrl ? `Se bestillingen: ${orderUrl}\n` : "") +
      `Svar kunden i Mine ordrer (krever innlogging): ${mineUrl}\n\n` +
      `Ikke svar på denne e-posten. Svaret ditt kommer fram når du skriver det i Mine ordrer.\n\nHilsen\nRett fra Bonden`;
    const htmlContent =
      `<p>Hei,</p>\n<p>Kunden har skrevet en melding om bestillingen ${escHtml(orderRef)}:</p>\n` +
      `<blockquote style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #ccc;white-space:pre-wrap">${escHtml(messageText)}</blockquote>\n` +
      (orderUrl ? `<p><a href="${escHtml(orderUrl)}">Se bestillingen</a></p>\n` : "") +
      `<p><a href="${escHtml(mineUrl)}">Svar kunden i Mine ordrer</a> (krever innlogging)</p>\n` +
      `<p>Ikke svar på denne e-posten. Svaret ditt kommer fram når du skriver det i Mine ordrer.</p>\n<p>Hilsen<br>Rett fra Bonden</p>`;
    const send: SendFn = _sendOverride ?? ((opts) => emailService.sendEmail(opts));
    const res = await send({
      to: recipient.email,
      subject: `Ny melding fra kunden (${orderRef})`,
      htmlContent,
      textContent,
      replyTo: DEFAULT_ORDER_NOTIFY_REPLY_TO,
      // F8: transactional, not outreach.
      omitAgentHeader: true,
    });
    if (res && res.success) {
      console.log(`[order-notify] message notice sent order=${orderId} agent=${o.agent_id}`);
      return "sent";
    }
    console.error(`[order-notify] message notice FAILED order=${orderId} agent=${o.agent_id}: ${res?.error || "unknown error"}`);
    return "failed";
  } catch (err) {
    console.error(`[order-notify] message notice FAILED order=${orderId}:`, (err as any)?.message ?? "error");
    return "failed";
  }
}

/**
 * B4 (dev-request 2026-10-28-rfb-bestillinger-fra-start-til-slutt-for-eier):
 * the producer's daily digest of submits the daily cap turned into contact
 * requests. FIRST VERSION — Daniel approves this text (recorded in
 * daniel-responses/) before ORDER_CAP_NOTICE_ENABLED is turned on (AC8).
 * No buyer data in it.
 */
export function renderOrderCapNoticeEmail(input: { agent_id: string; count: number; cap: number; oslo_day: string }): {
  subject: string; textContent: string; htmlContent: string;
} {
  const day = formatOsloDayLabel(input.oslo_day);
  const n = Math.max(0, Math.floor(input.count));
  const what = n === 1 ? "1 bestilling kom" : `${n} bestillinger kom`;
  const mineUrl = `${APP_URL}/eier/${encodeURIComponent(input.agent_id)}/ordrer`;
  const lead = `${what} etter grensen din på ${input.cap} bestillinger per døgn i går (${day}) og ble sendt som kontaktforespørsel.`;
  const explain = "Kundene fikk kontaktinformasjonen din i stedet for å sende bestillingen, så de kan ta kontakt med deg direkte.";
  const subject = `${what} etter grensen din i går`;
  const textContent =
    `Hei,\n\n${lead}\n\n${explain}\n\n` +
    `Se bestillingene du har fått i Mine ordrer (krever innlogging): ${mineUrl}\n\n` +
    `Du får høyst én slik e-post per dag.\n\nHilsen\nRett fra Bonden`;
  const htmlContent =
    `<p>Hei,</p>\n<p>${escHtml(lead)}</p>\n<p>${escHtml(explain)}</p>\n` +
    `<p><a href="${escHtml(mineUrl)}">Se bestillingene i Mine ordrer</a> (krever innlogging)</p>\n` +
    `<p>Du får høyst én slik e-post per dag.</p>\n<p>Hilsen<br>Rett fra Bonden</p>`;
  return { subject, textContent, htmlContent };
}

/** B4: sends the daily digest (same gated recipient as the order e-mail). Never throws. */
export async function sendProducerOrderCapNotice(input: { agent_id: string; count: number; cap: number; oslo_day: string }): Promise<OrderNotifyOutcome> {
  try {
    const recipient = resolveOrderNotificationRecipient(input.agent_id);
    if (!recipient.eligible) {
      console.log(`[order-notify] cap notice skipped agent=${input.agent_id} day=${input.oslo_day} reason=${recipient.reason}`);
      return "skipped";
    }
    const rendered = renderOrderCapNoticeEmail(input);
    const send: SendFn = _sendOverride ?? ((opts) => emailService.sendEmail(opts));
    const res = await send({
      to: recipient.email,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
      replyTo: DEFAULT_ORDER_NOTIFY_REPLY_TO,
      // F8: transactional, not outreach.
      omitAgentHeader: true,
    });
    if (res && res.success) {
      console.log(`[order-notify] cap notice sent agent=${input.agent_id} day=${input.oslo_day} count=${input.count}`);
      return "sent";
    }
    console.error(`[order-notify] cap notice FAILED agent=${input.agent_id} day=${input.oslo_day}: ${res?.error || "unknown error"}`);
    return "failed";
  } catch (err) {
    console.error(`[order-notify] cap notice FAILED agent=${input.agent_id}:`, (err as any)?.message ?? "error");
    return "failed";
  }
}
