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
  total_nok: number | null;
  items: Array<{ name: string; qty: number; unit: string | null }>;
  // skive 2 (hybrid utsending): optional buyer contact fields. cart-service's
  // submitCart() only ever passes them when the buyer explicitly consented
  // (contact_consent=true) — a null/absent field is simply left out of the
  // rendered mail, never shown as a blank row. NEVER logged.
  buyer_name?: string | null;
  buyer_email?: string | null;
  buyer_phone?: string | null;
  delivery_note?: string | null;
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
        `<tr><td style="padding:4px 12px 4px 0">${escHtml(i.name)}</td><td>${i.qty}${i.unit ? " " + escHtml(i.unit) : ""}</td></tr>`
    )
    .join("\n  ");
}

function renderItemLinesText(items: OrderNotificationInput["items"]): string {
  return items.map((i) => `- ${i.name}: ${i.qty}${i.unit ? " " + i.unit : ""}`).join("\n");
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

  const htmlContent = `
<p>Hei,</p>
<p>Du har fått en ny henteordre via Rett fra Bonden:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Ordre-ref:</td><td>${escHtml(orderRef)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Kjøper-ref:</td><td>${escHtml(maskBuyerRef(order.buyer_ref))}</td></tr>
  ${order.pickup_time ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Hentetid:</td><td>${escHtml(order.pickup_time)}</td></tr>` : ""}
  ${order.total_nok != null ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Sum:</td><td>${order.total_nok} kr</td></tr>` : ""}
</table>
<p style="font-weight:bold;margin-bottom:4px">Varer:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  ${itemRows}
</table>
<p><a href="${confirmUrl}">Bekreft eller avslå ordren her</a> — samme side brukes for «klar for henting» og «hentet».<br>
Lenken er personlig for denne ordren — ikke del den videre.</p>
<p>Ingen betaling skjer via plattformen; oppgjør ved henting som vanlig.</p>
<p>Hilsen<br>Rett fra Bonden</p>
    `.trim();

  const textContent = `Hei,\n\nDu har fått en ny henteordre via Rett fra Bonden.\nOrdre-ref: ${orderRef}\nKjøper-ref: ${maskBuyerRef(order.buyer_ref)}${order.pickup_time ? `\nHentetid: ${order.pickup_time}` : ""}${order.total_nok != null ? `\nSum: ${order.total_nok} kr` : ""}\n\nVarer:\n${itemLines}\n\nBekreft eller avslå ordren her (personlig lenke, ikke del videre):\n${confirmUrl}\n\nIngen betaling skjer via plattformen; oppgjør ved henting som vanlig.\n\nHilsen\nRett fra Bonden`;

  return { subject: `Ny henteordre — ${orderRef}`, htmlContent, textContent, replyTo: DEFAULT_ORDER_NOTIFY_REPLY_TO };
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
  const confirmUrl = `${APP_URL}/produsent/ordre/${encodeURIComponent(order.confirm_token)}`;
  const itemRows = renderItemRowsHtml(order.items);
  const itemLines = renderItemLinesText(order.items);

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
<p>Du har fått en ny henteordre via Rett fra Bonden:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Ordre-ref:</td><td>${escHtml(orderRef)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Kjøper-ref:</td><td>${escHtml(maskBuyerRef(order.buyer_ref))}</td></tr>
  ${order.pickup_time ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Hentetid:</td><td>${escHtml(order.pickup_time)}</td></tr>` : ""}
  ${order.total_nok != null ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Sum:</td><td>${order.total_nok} kr</td></tr>` : ""}
</table>
${buyerBlockHtml}<p style="font-weight:bold;margin-bottom:4px">Varer:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  ${itemRows}
</table>
<p><a href="${confirmUrl}">Bekreft eller avslå ordren her</a> — samme side brukes for «klar for henting» og «hentet».<br>
Lenken er personlig for denne ordren — ikke del den videre.</p>
<p>Ingen betaling skjer via plattformen; oppgjør ved henting som vanlig.</p>
<p>Hilsen<br>Rett fra Bonden</p>
    `.trim();

  const textContent = `Hei,\n\nDu har fått en ny henteordre via Rett fra Bonden.\nOrdre-ref: ${orderRef}\nKjøper-ref: ${maskBuyerRef(order.buyer_ref)}${order.pickup_time ? `\nHentetid: ${order.pickup_time}` : ""}${order.total_nok != null ? `\nSum: ${order.total_nok} kr` : ""}\n${buyerBlockText}\nVarer:\n${itemLines}\n\nBekreft eller avslå ordren her (personlig lenke, ikke del videre):\n${confirmUrl}\n\nIngen betaling skjer via plattformen; oppgjør ved henting som vanlig.\n\nHilsen\nRett fra Bonden`;

  return {
    subject: `Ny henteordre — ${orderRef}`,
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

/**
 * Fire-and-forget seller notification for one freshly created order.
 * Resolves the gated recipient, sends via emailService, and logs
 * `[order-notify] sent <ms>` on success so the <1 min SLA is measurable.
 * Never throws.
 */
export async function sendOrderNotificationForOrder(order: OrderNotificationInput): Promise<void> {
  const started = Date.now();
  try {
    const recipient = resolveOrderNotificationRecipient(order.agent_id);
    if (!recipient.eligible) {
      console.log(
        `[order-notify] skipped order=${order.order_id} agent=${order.agent_id} reason=${recipient.reason}`
      );
      return;
    }

    const rendered = renderOrderNotificationEmail(resolveOrderNotifyEmailVersion(), order);

    const send: SendFn = _sendOverride ?? ((opts) => emailService.sendEmail(opts));
    const result = await send({
      to: recipient.email,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
      replyTo: rendered.replyTo,
    });

    const ms = Date.now() - started;
    if (result && result.success) {
      // Latency log line — the <1 min notification SLA is measured off this.
      console.log(`[order-notify] sent ${ms}ms order=${order.order_id} agent=${order.agent_id} via=${recipient.via}`);
    } else {
      console.error(
        `[order-notify] send FAILED order=${order.order_id} agent=${order.agent_id}: ${result?.error || "unknown error"}`
      );
    }
  } catch (err) {
    console.error(`[order-notify] send FAILED order=${order.order_id} agent=${order.agent_id}:`, err);
  }
}
