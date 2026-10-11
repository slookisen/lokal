// ─── order-receipt-service.ts ─────────────────────────────────────────
// A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect,
// prerequisite 1 («Kvittering til kjøper på varig medium», angrerettloven
// § 18): the buyer gets an e-mail when the producer confirms (the contract
// is concluded), declines or cancels an order — with the seller's name and
// contact details, the items, the payment state, the right-of-cancellation
// exceptions and a link to /kjopsvilkar and its cancellation form.
//
// Behind ORDER_BUYER_RECEIPTS_ENABLED=1 (default off). Independent of
// PAYMENTS_ENABLED: the § 18 gap exists for pay-at-pickup orders too.
//
// Recipient: the buyer's own e-mail as typed at submit — the order's copy
// (consented) or else the cart's. This is the platform writing to its own
// customer about their own order; nothing is shared with anyone. Skipped
// when the address is not plausible or is suppressed (blocklist). The buyer
// address is NEVER logged (ids only).
//
// Reads the payments table directly (no import of payment-service.ts, which
// itself calls this module from its maintenance job).

import { getDb } from "../database/init";
import { emailService, type EmailOptions } from "./email-service";
import { isBlocked } from "./blocklist-service";
import { producerContact, TERMS_OF_PURCHASE_URL } from "./cart-service";
import { companyOperatorSentence } from "./company-legal";

export function isBuyerReceiptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORDER_BUYER_RECEIPTS_ENABLED === "1";
}

type SendFn = (opts: EmailOptions) => Promise<{ success: boolean; messageId?: string; error?: string }>;
let _sendOverride: SendFn | null = null;
export function __setBuyerReceiptSendForTesting(fn: SendFn | null): void { _sendOverride = fn; }
let _testDb: any = null;
export function __setBuyerReceiptTestDb(db: any): void { _testDb = db; }

export type ReceiptEvent = "confirmed" | "declined" | "cancelled";

const EMAIL_RE = /^[^\s@<>,;"'()\\\x00-\x1f\x7f]+@[^\s@<>,;"'()\\\x00-\x1f\x7f]+\.[A-Za-z0-9-]{2,}$/;
function plausibleEmail(e: string | null | undefined): string | null {
  const v = (e || "").trim();
  return v && v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

function kr(ore: number): string {
  const v = ore / 100;
  return Number.isInteger(v) ? `${v} kr` : `${v.toFixed(2).replace(".", ",")} kr`;
}
function krNok(n: number | null): string {
  if (n == null) return "–";
  return Number.isInteger(n) ? `${n} kr` : `${n.toFixed(2).replace(".", ",")} kr`;
}

export interface RenderedReceipt {
  subject: string;
  text: string;
  replyTo: string;
}

interface ReceiptData {
  orderRef: string;
  producerName: string;
  contact: { phone: string | null; email: string | null; profile_url: string };
  items: Array<{ name: string; qty: number; line_total: number | null }>;
  totalNok: number | null;
  cancelReason: string | null;
  payment: { status: string; amount_ore: number; refunded_ore: number } | null;
}

/** Pure renderer — tested on its own. Norwegian, plain text (durable, printable). */
export function renderBuyerReceipt(event: ReceiptEvent, d: ReceiptData): RenderedReceipt | null {
  const contactLines = [
    d.contact.phone ? `Telefon: ${d.contact.phone}` : "",
    d.contact.email ? `E-post: ${d.contact.email}` : "",
    `Profil: ${d.contact.profile_url}`,
  ].filter(Boolean).join("\n");
  const itemLines = d.items.map((i) => `- ${i.qty} × ${i.name}${i.line_total != null ? ` — ${krNok(i.line_total)}` : ""}`).join("\n");
  const p = d.payment;
  const footer =
    `Kjøpsvilkår og angreskjema: ${TERMS_OF_PURCHASE_URL}\n\n` +
    `Rett fra Bonden formidler bestillingen; ${d.producerName} er selger. ${companyOperatorSentence("nb").replace(/^Operatør: /, "Rett fra Bonden drives av ")}`;

  if (event === "confirmed") {
    let pay: string;
    if (p && (p.status === "captured" || p.status === "authorized")) {
      pay = `Du har betalt ${kr(p.amount_ore)} på forhånd. Beløpet går direkte til ${d.producerName}.`;
    } else {
      pay = `Du betaler ${d.producerName} ved henting.`;
    }
    const text =
      `Hei!\n\n${d.producerName} har bekreftet bestillingen din via Rett fra Bonden. Kjøpet er dermed bindende. ` +
      `Denne e-posten er bekreftelsen din – ta vare på den.\n\n` +
      `Ordre: ${d.orderRef}\nSelger: ${d.producerName}\n${contactLines}\n\n` +
      `Varer:\n${itemLines}\nSum: ${krNok(d.totalNok)}\n\n` +
      `Henting: Du henter varene hos ${d.producerName}. Avtal tid og sted med produsenten.\n` +
      `Betaling: ${pay}\n\n` +
      `Avbestilling: Vil du avbestille før henting, kontakter du ${d.producerName} direkte. Produsenten kan da kreve dekket dokumentert tap (forbrukerkjøpsloven § 41).\n` +
      `Angrerett: Som hovedregel har du 14 dagers angrerett fra du har hentet varene. Den gjelder ikke for varer som forringes eller raskt går ut på dato, ` +
      `og ikke for forseglede varer der forseglingen er brutt etter henting (angrerettloven § 22 b og g).\n` +
      `Reklamasjon: Er det feil ved varene, kontakter du ${d.producerName} innen rimelig tid etter at du oppdaget feilen.\n\n` +
      footer;
    return { subject: `Ordrebekreftelse fra ${d.producerName} (${d.orderRef})`, text, replyTo: "" };
  }

  if (event === "declined") {
    const pay = p && (p.status === "canceled" || p.status === "authorized" || p.status === "requires_payment")
      ? " Reservasjonen på betalingskortet ditt er frigjort, og du belastes ikke."
      : "";
    const text =
      `Hei!\n\n${d.producerName} kunne dessverre ikke ta imot bestillingen din (ordre ${d.orderRef}).${pay}\n\n` +
      `Vil du spørre produsenten direkte:\n${contactLines}\n\n` + footer;
    return { subject: `Bestillingen ble ikke bekreftet (${d.orderRef})`, text, replyTo: "" };
  }

  // cancelled
  let why: string;
  let pay = "";
  switch (d.cancelReason) {
    case "payment_expired":
      why = `${d.producerName} bekreftet ikke bestillingen innen fristen, så den er kansellert.`;
      pay = " Reservasjonen på betalingskortet ditt er frigjort, og du belastes ikke.";
      break;
    case "producer_cancelled":
      why = `${d.producerName} har kansellert bestillingen fordi den ikke kan leveres.`;
      if (p?.status === "refunded" || (p && p.refunded_ore > 0)) pay = " Du får pengene tilbake til samme betalingsmåte. Det tar vanligvis 5–10 virkedager.";
      else if (p?.status === "canceled") pay = " Reservasjonen på betalingskortet ditt er frigjort, og du belastes ikke.";
      break;
    case "buyer_cancelled":
      why = "Avbestillingen din er registrert.";
      if (p?.status === "captured") pay = ` ${d.producerName} refunderer deg; produsenten kan trekke fra dokumentert tap (forbrukerkjøpsloven § 41).`;
      else if (p?.status === "canceled") pay = " Reservasjonen på betalingskortet ditt er frigjort, og du belastes ikke.";
      break;
    default:
      return null; // no_show and other reasons: no receipt
  }
  const text = `Hei!\n\n${why}${pay} (Ordre ${d.orderRef}.)\n\nKontakt produsenten:\n${contactLines}\n\n` + footer;
  return { subject: `Bestillingen er kansellert (${d.orderRef})`, text, replyTo: "" };
}

/** Fire-and-forget after an order transition. Never throws. */
export async function sendBuyerOrderReceipt(orderId: string, event: ReceiptEvent): Promise<void> {
  if (!isBuyerReceiptsEnabled()) return;
  try {
    const db = _testDb ?? getDb();
    const o = db.prepare(`
      SELECT o.id, o.agent_id, o.total_nok, o.cancel_reason, o.buyer_email AS order_email, c.buyer_email AS cart_email,
             a.name AS producer_name
      FROM orders o INNER JOIN agents a ON a.id = o.agent_id LEFT JOIN carts c ON c.id = o.cart_id
      WHERE o.id = ?
    `).get(orderId) as
      | { id: string; agent_id: string; total_nok: number | null; cancel_reason: string | null; order_email: string | null; cart_email: string | null; producer_name: string }
      | undefined;
    if (!o) return;
    const to = plausibleEmail(o.order_email) ?? plausibleEmail(o.cart_email);
    if (!to) {
      console.log(`[buyer-receipt] skipped order=${orderId} reason=no_email`);
      return;
    }
    if (isBlocked({ email: to }).blocked) {
      console.log(`[buyer-receipt] skipped order=${orderId} reason=suppressed`);
      return;
    }
    const items = db.prepare(`SELECT name_snapshot AS name, qty, line_total FROM order_items WHERE order_id = ? ORDER BY rowid`).all(orderId) as
      Array<{ name: string | null; qty: number | null; line_total: number | null }>;
    let payment: ReceiptData["payment"] = null;
    try {
      payment = (db.prepare(`SELECT status, amount_ore, refunded_ore FROM payments WHERE order_id = ?`).get(orderId) as ReceiptData["payment"]) ?? null;
    } catch { payment = null; }
    const contact = producerContact(o.agent_id, o.producer_name);
    const rendered = renderBuyerReceipt(event, {
      orderRef: o.id.slice(0, 8),
      producerName: o.producer_name,
      contact,
      items: items.map((i) => ({ name: i.name ?? "Vare", qty: i.qty ?? 0, line_total: i.line_total })),
      totalNok: o.total_nok,
      cancelReason: o.cancel_reason,
      payment,
    });
    if (!rendered) return;
    const replyTo = plausibleEmail(contact.email) ?? "kontakt@rettfrabonden.com";
    const send: SendFn = _sendOverride ?? ((opts) => emailService.sendEmail(opts));
    const res = await send({ to, subject: rendered.subject, textContent: rendered.text, replyTo });
    if (res?.success) console.log(`[buyer-receipt] sent order=${orderId} event=${event}`);
    else console.error(`[buyer-receipt] send FAILED order=${orderId} event=${event}: ${res?.error || "unknown error"}`);
  } catch (err: any) {
    console.error(`[buyer-receipt] FAILED order=${orderId} event=${event}: ${String(err?.message || err)}`);
  }
}
