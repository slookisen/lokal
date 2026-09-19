/**
 * Order-notify service — seller notification for cart orders (RFB).
 * dev-request 2026-07-13-pilot-ordre-loop.
 *
 * Send-guard (L4 condition, Daniel-approved — every clause is mandatory):
 *   1. agents.order_notifications_opt_in = 1 OR agents.is_verified = 1
 *      (default 0/0 → NEVER send). Slice 2 of dev-request 2026-09-16-
 *      handleliste-med-produsentvalg-og-bestillingsflyt ("hybrid
 *      utsending") added the `OR is_verified = 1` alternative: an
 *      owner-claimed profile (agents.is_verified, NOT the internal
 *      verification_status cross-check gate 3 reads below) is itself
 *      sufficient consent to be emailed about orders — the claim flow
 *      already verifies the owner's email by code — WITHOUT also
 *      requiring the separate, admin-only opt-in toggle. Gates 2-4 are
 *      UNCHANGED and still fully mandatory.
 *   2. A recipient email exists: order_notification_email (admin-set
 *      override) wins; otherwise contact_email.
 *   3. Verified contact: agent_knowledge.verification_status = 'verified',
 *      OR the recipient is an explicit admin-set order_notification_email
 *      (this is how test notifications go ONLY to Daniel's own inbox —
 *      same pattern as the booking test provider).
 *   4. The recipient email is not blocklisted (blocklist-service.isBlocked,
 *      the same suppression gate the outreach paths use).
 *
 * A failed/skipped notification must NEVER fail the order submit — callers
 * fire-and-forget (same posture as booking-store.sendProducerNotification).
 *
 * Email template versioning (Slice 2): the v1 template (below,
 * renderOrderNotificationEmailV1) is byte-for-byte the original pilot-
 * ordre-loop content and is kept reachable — "v1 beholdes bak
 * versjonsflagg" per the spec — via ORDER_NOTIFY_EMAIL_VERSION=v1. The v2
 * template (default) additionally includes the buyer's name/phone/email
 * and delivery_note when present on the order, and sets Reply-To to the
 * buyer's email when given. Same versioned-render-function + dispatcher
 * pattern as email-service.ts's renderGardssalgOutreach /
 * renderGardssalgOutreachPersonal / renderGardssalgOutreachVariant (A/B
 * template variant, dev-request 2026-08-15-outreach-ab-standard-vs-
 * personlig-drikke) — the established convention in this codebase for
 * keeping an old template selectable without deleting it.
 */

import { getDb } from "../database/init";
import { isBlocked } from "./blocklist-service";
import { emailService, EmailOptions } from "./email-service";

const APP_URL = process.env.APP_URL || "https://rettfrabonden.com";

/** Same address every other RFB transactional path replies to (order-notify-service.ts's own pre-Slice-2 constant, now named). */
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
           a.is_verified                AS is_verified,
           a.order_notification_email   AS override_email,
           a.contact_email              AS contact_email,
           k.verification_status        AS verification_status
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
    WHERE a.id = ?
  `).get(agentId) as
    | {
        opt_in: number; is_verified: number | null; override_email: string | null;
        contact_email: string | null; verification_status: string | null;
      }
    | undefined;

  if (!row) return { eligible: false, reason: "agent_not_found" };
  // Gate 1: explicit opt-in OR an owner-claimed (is_verified) profile.
  // Default 0/0 → never send. Reason stays "not_opted_in" even though it
  // now also covers "not is_verified" — this is the single "neither consent
  // path is satisfied" deny, and every existing caller matches on this
  // exact reason string.
  if (row.opt_in !== 1 && row.is_verified !== 1) {
    return { eligible: false, reason: "not_opted_in" };
  }

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

// ─── Notification send ──────────────────────────────────────────────────────

export interface OrderNotificationInput {
  order_id: string;
  agent_id: string;
  producer_name: string;
  buyer_ref: string;
  confirm_token: string;
  pickup_time: string | null;
  total_nok: number | null;
  items: Array<{ name: string; qty: number; unit: string | null }>;
  // Slice 2 (hybrid utsending) — optional; a pre-Slice-2 caller (there are
  // none left in this codebase, but the type stays permissive) simply omits
  // them and gets the exact v1 rendering. NEVER logged — see the module doc
  // comment and this file's own "never log a buyer_* field" convention.
  buyer_name?: string | null;
  buyer_email?: string | null;
  buyer_phone?: string | null;
  delivery_note?: string | null;
}

export type OrderNotifyEmailVersion = "v1" | "v2";

/**
 * v2 is the default (it's what actually delivers the buyer's contact info
 * to the producer — the whole point of Slice 2); v1 is reachable ONLY via
 * an explicit opt-out, for rollback, per "v1 beholdes bak versjonsflagg".
 * Read fresh on every call (not cached at module load) so tests can flip it
 * per-case via process.env.
 */
export function resolveOrderNotifyEmailVersion(): OrderNotifyEmailVersion {
  return process.env.ORDER_NOTIFY_EMAIL_VERSION === "v1" ? "v1" : "v2";
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

/**
 * v1 — the ORIGINAL pilot-ordre-loop template, byte-for-byte unchanged.
 * Kept reachable via ORDER_NOTIFY_EMAIL_VERSION=v1 ("v1 beholdes bak
 * versjonsflagg"). Never include buyer contact fields, regardless of
 * whether the order carries them — that's the whole point of pinning v1.
 */
export function renderOrderNotificationEmailV1(order: OrderNotificationInput): RenderedOrderNotificationEmail {
  const orderRef = order.order_id.slice(0, 8);
  const confirmUrl = `${APP_URL}/produsent/ordre/${encodeURIComponent(order.confirm_token)}`;
  const itemRows = order.items
    .map(
      (i) =>
        `<tr><td style="padding:4px 12px 4px 0">${escHtml(i.name)}</td><td>${i.qty}${i.unit ? " " + escHtml(i.unit) : ""}</td></tr>`
    )
    .join("\n  ");
  const itemLines = order.items
    .map((i) => `- ${i.name}: ${i.qty}${i.unit ? " " + i.unit : ""}`)
    .join("\n");

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
 * v2 (default) — everything v1 has, PLUS the buyer's name/phone/email and
 * delivery_note when present on the order, and Reply-To set to the buyer's
 * email when given (else the same platform default v1 uses). A buyer field
 * that's null/empty is simply omitted from both the HTML table and the
 * plain-text block — never rendered as a blank/placeholder row.
 */
export function renderOrderNotificationEmailV2(order: OrderNotificationInput): RenderedOrderNotificationEmail {
  const orderRef = order.order_id.slice(0, 8);
  const confirmUrl = `${APP_URL}/produsent/ordre/${encodeURIComponent(order.confirm_token)}`;
  const itemRows = order.items
    .map(
      (i) =>
        `<tr><td style="padding:4px 12px 4px 0">${escHtml(i.name)}</td><td>${i.qty}${i.unit ? " " + escHtml(i.unit) : ""}</td></tr>`
    )
    .join("\n  ");
  const itemLines = order.items
    .map((i) => `- ${i.name}: ${i.qty}${i.unit ? " " + i.unit : ""}`)
    .join("\n");

  const buyerName = (order.buyer_name || "").trim() || null;
  const buyerEmail = (order.buyer_email || "").trim() || null;
  const buyerPhone = (order.buyer_phone || "").trim() || null;
  const deliveryNote = (order.delivery_note || "").trim() || null;
  const hasBuyerBlock = !!(buyerName || buyerEmail || buyerPhone || deliveryNote);

  const buyerRowsHtml = [
    buyerName ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Navn:</td><td>${escHtml(buyerName)}</td></tr>` : "",
    buyerPhone ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Telefon:</td><td>${escHtml(buyerPhone)}</td></tr>` : "",
    buyerEmail ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">E-post:</td><td>${escHtml(buyerEmail)}</td></tr>` : "",
    deliveryNote ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Leveringsønske:</td><td>${escHtml(deliveryNote)}</td></tr>` : "",
  ]
    .filter(Boolean)
    .join("\n  ");
  const buyerBlockHtml = hasBuyerBlock
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
    replyTo: buyerEmail || DEFAULT_ORDER_NOTIFY_REPLY_TO,
  };
}

/**
 * The one variant dispatcher the send path goes through — same
 * single-source rule as email-service.ts's renderGardssalgOutreachVariant.
 */
export function renderOrderNotificationEmail(
  version: OrderNotifyEmailVersion,
  order: OrderNotificationInput
): RenderedOrderNotificationEmail {
  return version === "v1" ? renderOrderNotificationEmailV1(order) : renderOrderNotificationEmailV2(order);
}

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
