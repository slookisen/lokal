// ─── order-receipt-service.ts ─────────────────────────────────────────
// A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect,
// prerequisite 1 («Kvittering til kjøper på varig medium», angrerettloven
// § 18): the buyer gets an e-mail when the producer confirms (the contract
// is concluded), declines or cancels an order — with the seller's name,
// contact details and address, the items, the payment state, the rules that
// apply (consumer law for a trader, the Sale of Goods Act for a producer who
// declared they do not sell as a trader), the right-of-withdrawal exceptions
// and the standard withdrawal form in the mail itself (a link to a web page
// is not a durable medium).
//
// Behind ORDER_BUYER_RECEIPTS_ENABLED=1 (default off). Independent of
// PAYMENTS_ENABLED: the § 18 gap exists for pay-at-pickup orders too.
//
// Recipient: the buyer's own e-mail as typed at submit — the order's copy
// (consented) or else the cart's. This is the platform writing to its own
// customer about their own order; nothing is shared with anyone. Skipped
// when the address is not plausible or is suppressed (blocklist). The buyer
// address is NEVER logged: ids only here, and the e-mail service is told to
// redact the recipient (redactRecipientInLogs) and mask addresses in errors.
//
// Reads the payments table directly (no import of payment-service.ts, which
// itself calls this module from its maintenance job).

import { getDb } from "../database/init";
import { emailService, maskEmails, type EmailOptions } from "./email-service";
import { isBlocked } from "./blocklist-service";
import { producerContact, producerTraderStatus, TERMS_OF_PURCHASE_URL, type ProducerContact } from "./cart-service";
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
}

export interface ReceiptPayment {
  status: string;
  amount_ore: number;
  refunded_ore: number;
  /** Set once the card was ever reserved — decides «frigjort» vs «ikke belastet». */
  authorized_at: string | null;
}

export interface ReceiptData {
  orderRef: string;
  producerName: string;
  contact: ProducerContact;
  /** The producer's own declaration; null = none collected (treated as a trader, like /kjopsvilkar). */
  traderStatus: "trader" | "non_trader" | null;
  items: Array<{ name: string; qty: number; line_total: number | null }>;
  totalNok: number | null;
  cancelReason: string | null;
  payment: ReceiptPayment | null;
}

const RELEASED = " Reservasjonen på betalingskortet ditt blir frigjort, og du belastes ikke.";
const NOT_CHARGED = " Du er ikke belastet.";
const REFUND = " Du får pengene tilbake til samme betalingsmåte. Det tar vanligvis 5–10 virkedager, avhengig av banken.";

/** What happened to an un-captured payment: reserved → released; never reserved → not charged. */
function notChargedLine(p: ReceiptPayment | null): string {
  if (!p) return "";
  if (p.status === "captured" || p.status === "refunded") return "";
  return p.authorized_at ? RELEASED : NOT_CHARGED;
}

function angreskjemaText(producerName: string): string {
  return (
    "Angreskjema (angrerettloven § 8 h)\n" +
    "Fyll ut og send dette skjemaet til produsenten dersom du ønsker å gå fra avtalen. Du kan også gi beskjed på annen måte, for eksempel på e-post.\n" +
    `Til: ${producerName} (kontaktinformasjon over)\n` +
    "Jeg/vi underretter herved om at jeg/vi ønsker å gå fra min/vår avtale om kjøp av følgende varer: ……………\n" +
    "Varen ble mottatt (hentet) den (dato): ……………\n" +
    "Forbrukerens navn: ……………\nForbrukerens adresse: ……………\nDato: ……………\n" +
    "Forbrukerens underskrift (bare hvis skjemaet sendes på papir): ……………"
  );
}

/** Pure renderer — tested on its own. Norwegian, plain text (durable, printable). */
export function renderBuyerReceipt(event: ReceiptEvent, d: ReceiptData): RenderedReceipt | null {
  const contactLines = [
    d.contact.address ? `Adresse: ${d.contact.address}` : "",
    d.contact.phone ? `Telefon: ${d.contact.phone}` : "",
    d.contact.email ? `E-post: ${d.contact.email}` : "",
    `Profil: ${d.contact.profile_url}`,
  ].filter(Boolean).join("\n");
  const itemLines = d.items.map((i) => `- ${i.qty} × ${i.name}${i.line_total != null ? ` — ${krNok(i.line_total)}` : ""}`).join("\n");
  const p = d.payment;
  const nonTrader = d.traderStatus === "non_trader";
  const footer =
    `Kjøpsvilkår: ${TERMS_OF_PURCHASE_URL}\n\n` +
    `Rett fra Bonden formidler bestillingen; ${d.producerName} er selger. ${companyOperatorSentence("nb").replace(/^Operatør: /, "Rett fra Bonden drives av ")}`;

  if (event === "confirmed") {
    let pay: string;
    if (p && p.status === "captured") pay = `Du har betalt ${kr(p.amount_ore)} på forhånd. Beløpet går direkte til ${d.producerName}.`;
    else if (p && p.status === "authorized") pay = `${kr(p.amount_ore)} er reservert på betalingskortet ditt og trekkes nå. Beløpet går direkte til ${d.producerName}.`;
    else pay = `Du betaler ${d.producerName} ved henting.`;
    const rights = nonTrader
      ? `Hvilke regler som gjelder: ${d.producerName} har oppgitt at produsenten ikke selger som næringsdrivende. Da gjelder kjøpsloven for kjøpet, ikke forbrukerkjøpsloven og angrerettloven. ` +
        `Vil du avbestille, eller er det feil ved varene, tar du kontakt med ${d.producerName} direkte.\n\n`
      : `Avbestilling: Vil du avbestille før henting, kontakter du ${d.producerName} direkte. Produsenten kan da kreve dekket dokumentert tap avbestillingen påfører produsenten (forbrukerkjøpsloven § 41).\n` +
        `Angrerett: Som hovedregel har du 14 dagers angrerett fra dagen du henter varene. Den gjelder ikke for varer som forringes eller raskt går ut på dato (angrerettloven § 22 b), ` +
        `og ikke for forseglede varer som av hensyn til helsevern eller hygiene ikke er egnet for retur, når forseglingen er brutt etter henting (§ 22 g). ` +
        `Bruker du angreretten, gir du ${d.producerName} beskjed innen fristen og leverer varene tilbake senest 14 dager etter beskjeden. Du dekker returkostnaden. ` +
        `Produsenten betaler tilbake det du har betalt innen 14 dager etter beskjeden, men kan vente til varene er mottatt.\n` +
        `Reklamasjon: Er det feil ved varene, gir du ${d.producerName} beskjed innen rimelig tid etter at du oppdaget feilen (forbrukerkjøpsloven § 27).\n\n` +
        `${angreskjemaText(d.producerName)}\n\n`;
    const text =
      `Hei!\n\n${d.producerName} har bekreftet bestillingen din via Rett fra Bonden. Kjøpet er dermed bindende. ` +
      `Denne e-posten er bekreftelsen din – ta vare på den.\n\n` +
      `Ordre: ${d.orderRef}\nSelger: ${d.producerName}\n${contactLines}\n\n` +
      `Varer:\n${itemLines}\nSum: ${krNok(d.totalNok)}\n\n` +
      `Henting: Du henter varene hos ${d.producerName}. Avtal tid og sted med produsenten.\n` +
      `Betaling: ${pay}\n\n` +
      rights +
      footer;
    return { subject: `Ordrebekreftelse fra ${d.producerName} (${d.orderRef})`, text };
  }

  if (event === "declined") {
    const text =
      `Hei!\n\n${d.producerName} kunne dessverre ikke ta imot bestillingen din (ordre ${d.orderRef}).${notChargedLine(p)}\n\n` +
      `Vil du spørre produsenten direkte:\n${contactLines}\n\n` + footer;
    return { subject: `Bestillingen ble ikke bekreftet (${d.orderRef})`, text };
  }

  // cancelled
  let why: string;
  let pay = "";
  const paid = !!p && (p.status === "captured" || p.status === "refunded" || p.refunded_ore > 0);
  switch (d.cancelReason) {
    case "payment_expired":
      why = `${d.producerName} bekreftet ikke bestillingen innen fristen, så den er kansellert.`;
      pay = notChargedLine(p);
      break;
    case "producer_cancelled":
      why = `${d.producerName} har kansellert bestillingen fordi den ikke kan leveres.`;
      // A captured payment is refunded automatically (and retried by the
      // maintenance job if Stripe failed), so «captured» also gets the line.
      pay = paid ? REFUND : notChargedLine(p);
      break;
    case "buyer_cancelled":
      why = "Avbestillingen din er registrert.";
      if (paid) {
        pay = nonTrader
          ? ` Avtal tilbakebetaling med ${d.producerName}.`
          : ` ${d.producerName} refunderer deg, med fradrag for eventuelt dokumentert tap avbestillingen påfører produsenten (forbrukerkjøpsloven § 41).`;
      } else {
        pay = notChargedLine(p);
      }
      break;
    default:
      return null; // no_show and other reasons: no receipt
  }
  const text = `Hei!\n\n${why}${pay} (Ordre ${d.orderRef}.)\n\nKontakt produsenten:\n${contactLines}\n\n` + footer;
  return { subject: `Bestillingen er kansellert (${d.orderRef})`, text };
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
    let payment: ReceiptPayment | null = null;
    try {
      payment = (db.prepare(`SELECT status, amount_ore, refunded_ore, authorized_at FROM payments WHERE order_id = ?`).get(orderId) as ReceiptPayment | undefined) ?? null;
    } catch { payment = null; }
    const contact = producerContact(o.agent_id, o.producer_name);
    const rendered = renderBuyerReceipt(event, {
      orderRef: o.id.slice(0, 8),
      producerName: o.producer_name,
      contact,
      traderStatus: producerTraderStatus(db, o.agent_id),
      items: items.map((i) => ({ name: i.name ?? "Vare", qty: i.qty ?? 0, line_total: i.line_total })),
      totalNok: o.total_nok,
      cancelReason: o.cancel_reason,
      payment,
    });
    if (!rendered) return;
    const replyTo = plausibleEmail(contact.email) ?? "kontakt@rettfrabonden.com";
    const send: SendFn = _sendOverride ?? ((opts) => emailService.sendEmail(opts));
    const res = await send({ to, subject: rendered.subject, textContent: rendered.text, replyTo, redactRecipientInLogs: true });
    if (res?.success) console.log(`[buyer-receipt] sent order=${orderId} event=${event}`);
    else console.error(`[buyer-receipt] send FAILED order=${orderId} event=${event}: ${maskEmails(String(res?.error || "unknown error"))}`);
  } catch (err: any) {
    console.error(`[buyer-receipt] FAILED order=${orderId} event=${event}: ${maskEmails(String(err?.message || err))}`);
  }
}
