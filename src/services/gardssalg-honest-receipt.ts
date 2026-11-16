// ─── Gårdssalg honest receipt + calendar file on confirmation (O1-2) ───────
//
// A2A dev-request 2026-11-12-opplevagent-o1-trygg-aa-aapne, slice O1-2
// (audit findings R3, R4, G13). Behind GARDSSALG_HONEST_RECEIPT_ENABLED
// (off unless exactly "true", read on every call like BOOKING_DISPATCH_ENABLED).
//
// Flag ON:
//   - the receipt page, the POST /book `message` and the guest receipt
//     e-mail say the request is RECEIVED, not confirmed; the receipt e-mail
//     carries NO calendar file;
//   - the calendar file is attached to the "bekreftet" e-mail when the
//     producer confirms, and a new file when the guest accepts a new time.
//     The file carries LOCATION (the producer's address) and no guest data.
// Flag OFF: every surface is byte-identical to before (booking-store.ts keeps
// the legacy code paths untouched).
//
// Every guest-facing string below is copied verbatim from the approved text
// package OA-1 (A2A marketing-drafts/2026-11-12-opplevagent-tekstpakke-oa-1.md
// §1.1–1.3, approved by Daniel 2026-11-15). Do not reword here: a new or
// changed sentence goes through the text package first.
//
// Language: the package's English text is used when the guest's language is
// "en" AND GARDSSALG_EMAIL_EN_ENABLED is on (O4-2: guestEmailLang() in
// gardssalg-email-texts.ts, where the e-mail texts now live).

import { getDb } from "../database/db-factory";
import type { GardssalgBooking } from "./booking-store";
import { GARDSSALG_EMAIL_TEXTS, type EmailTextEntry, type GardssalgEmailKey } from "./gardssalg-email-texts";

export type ReceiptLang = "nb" | "en";

/** An OA-1 e-mail text that has both languages, read from the O4-2 register. */
function fromEmailRegister(key: GardssalgEmailKey): { nb: string; en: string } {
  const e: EmailTextEntry = GARDSSALG_EMAIL_TEXTS[key];
  return { nb: e.nb, en: e.en ?? e.nb };
}

export function honestReceiptEnabled(): boolean {
  return process.env.GARDSSALG_HONEST_RECEIPT_ENABLED === "true";
}

// ─── Text package OA-1 §1 (verbatim) ────────────────────────────────────────
// Placeholders as in the package: {gjest} {produsent} {ref} {tid} {antall}
// {frist} {sted} {statusside} {kommentar} {e-post}.
export const OA1_RECEIPT_TEXTS = {
  "receipt.pageTitle": {
    nb: "Forespørselen er mottatt | Opplevagent",
    en: "Request received | Opplevagent",
  },
  "receipt.heading": {
    nb: "Vi har mottatt forespørselen",
    en: "We have received your request",
  },
  "receipt.lead": {
    nb: "Besøket er ikke bekreftet ennå. {produsent} har fått forespørselen og svarer innen {frist}. Du får e-post når produsenten har bekreftet, foreslått et annet tidspunkt eller avslått.",
    en: "Your visit is not confirmed yet. {produsent} has received the request and will reply by {frist}. We will email you when the producer has confirmed, suggested another time or declined.",
  },
  "receipt.statusLink": {
    nb: "Se status for forespørselen",
    en: "See the status of your request",
  },
  "receipt.formMessage": {
    nb: "Forespørselen er sendt. Vi sender en kvittering til {e-post}.",
    en: "Your request has been sent. We are emailing a receipt to {e-post}.",
  },
  // The e-mail texts live in the O4-2 register (gardssalg-email-texts.ts).
  "receipt.email.subject": fromEmailRegister("receipt.email.subject"),
  "receipt.email.body": fromEmailRegister("receipt.email.body"),
  "ics.summary": {
    nb: "Besøk hos {produsent} — {ref}",
    en: "Visit to {produsent} — {ref}",
  },
  "ics.description": {
    nb: "Besøk avtalt via opplevagent.no. Referanse: {ref}. Status og avlysning: {statusside}",
    en: "Visit arranged via opplevagent.no. Reference: {ref}. Status and cancellation: {statusside}",
  },
  "ics.location": {
    nb: "{sted}",
    en: "{sted}",
  },
  "confirmed.icsLine": fromEmailRegister("confirmed.icsLine"),
  "confirmed.newTimeIcsLine": fromEmailRegister("confirmed.newTimeIcsLine"),
} as const;

export type Oa1ReceiptKey = keyof typeof OA1_RECEIPT_TEXTS;

export function oa1Text(key: Oa1ReceiptKey, lang: ReceiptLang = "nb"): string {
  return OA1_RECEIPT_TEXTS[key][lang];
}

/**
 * Drops every sentence that contains {frist} (O1-2 review N1): a booking
 * without an answer deadline keeps the honest text minus that sentence —
 * never a reworded or invented one.
 */
export function dropFristSentences(template: string): string {
  return template
    .split("\n")
    .map((line) => line.split(/(?<=\.) /).filter((sentence) => !sentence.includes("{frist}")).join(" "))
    .join("\n");
}

/** Replaces {placeholder}s; values are inserted as given (escape before if needed). */
export function fillOa1(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zæøå-]+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m,
  );
}

// ─── Context helpers ────────────────────────────────────────────────────────

const DATE_LOCALE: Record<ReceiptLang, string> = { nb: "nb-NO", en: "en-GB" };

/**
 * {tid}/{frist} in words, Oslo time: "fredag 12. desember 2026 kl. 13:00", or
 * in English "Friday 12 December 2026 at 13:00" (OA-2, settled 2026-11-15:
 * 24-hour clock, no comma after the weekday).
 */
export function formatOsloInstant(iso: string | null, lang: ReceiptLang = "nb"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const s = d.toLocaleString(DATE_LOCALE[lang], {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  });
  return lang === "en" ? s.replace(/^([A-Za-z]+), /, "$1 ") : s;
}

export interface ReceiptProvider {
  navn: string;
  /** {sted}: "adresse, postnummer poststed" — "" when nothing is on file. */
  sted: string;
}

export function composeSted(row: { adresse?: unknown; postnummer?: unknown; poststed?: unknown }): string {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const place = [s(row.postnummer), s(row.poststed)].filter(Boolean).join(" ");
  return [s(row.adresse), place].filter(Boolean).join(", ");
}

/** Producer name + visit address for the receipt and the calendar file. Synchronous. */
export function loadReceiptProvider(provider_id: string): ReceiptProvider {
  try {
    const row = getDb("experiences")
      .prepare("SELECT navn, adresse, postnummer, poststed FROM experience_providers WHERE id = ?")
      .get(provider_id) as { navn?: string | null; adresse?: string | null; postnummer?: string | null; poststed?: string | null } | undefined;
    return { navn: String(row?.navn ?? "").trim(), sted: row ? composeSted(row) : "" };
  } catch {
    return { navn: "", sted: "" };
  }
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Receipt e-mail (§1.2) ──────────────────────────────────────────────────

export interface HonestReceiptEmail {
  subject: string;
  htmlContent: string;
  textContent: string;
}

/**
 * The guest receipt. Without an answer deadline the sentence that needs
 * {frist} is dropped (dropFristSentences); never the legacy receipt.
 * The «Din kommentar» line is only included when the guest wrote a note
 * (package rule); the status line only when the booking has a status link.
 */
export function buildHonestReceiptEmail(
  booking: GardssalgBooking,
  ctx: { producerName: string; statusUrl: string | null },
  lang: ReceiptLang = "nb",
): HonestReceiptEmail {
  const frist = formatOsloInstant(booking.respond_token_expires_at, lang);
  const body = frist ? oa1Text("receipt.email.body", lang) : dropFristSentences(oa1Text("receipt.email.body", lang));

  const paragraphs = body
    .split("\n\n")
    .map((p) => p.split("\n").filter((line) => !(line.includes("{kommentar}") && !booking.notes)))
    .filter((lines) => !(lines.some((l) => l.includes("{statusside}")) && !ctx.statusUrl));

  const raw: Record<string, string> = {
    gjest: booking.guest_name,
    produsent: ctx.producerName,
    ref: booking.booking_ref,
    tid: formatOsloInstant(booking.slot_at, lang),
    antall: String(booking.party_size),
    kommentar: booking.notes ?? "",
    frist,
    statusside: ctx.statusUrl ?? "",
  };
  const esc: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) esc[k] = escHtml(v);
  if (ctx.statusUrl) esc.statusside = `<a href="${escHtml(ctx.statusUrl)}">${escHtml(ctx.statusUrl)}</a>`;

  const textContent = fillOa1(paragraphs.map((lines) => lines.join("\n")).join("\n\n"), raw);
  const htmlContent = paragraphs
    .map((lines) => `<p>${lines.map((l) => fillOa1(escHtml(l), esc)).join("<br>\n")}</p>`)
    .join("\n");
  const subject = fillOa1(oa1Text("receipt.email.subject", lang), { ref: booking.booking_ref });
  return { subject, htmlContent, textContent };
}

// ─── Calendar file (§1.3) ───────────────────────────────────────────────────

function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
}

/** RFC 5545 §3.3.11 TEXT escaping. */
export function icsEscapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 §3.1 line folding at 75 octets (never splits a UTF-8 sequence). */
export function icsFold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8");
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** Reverses icsFold (for tests and readers). */
export function icsUnfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, "");
}

export const CONFIRMED_ICS_CONTENT_TYPE = "text/calendar; charset=utf-8; method=PUBLISH";

/**
 * The calendar file for a CONFIRMED visit. METHOD:PUBLISH (a plain calendar
 * entry, no invitation reply). The UID carries the start time, so the file
 * for an accepted new time is a separate entry (the package tells the guest
 * to delete the old one). No guest name or e-mail in the file. LOCATION is
 * omitted only when the producer has no address on file.
 */
export function buildConfirmedIcs(
  booking: GardssalgBooking,
  ctx: { producerName: string; sted: string; statusUrl: string | null },
  lang: ReceiptLang = "nb",
  now: Date = new Date(),
): string {
  const start = new Date(booking.slot_at);
  const dtStart = icsStamp(start);
  const dtEnd = icsStamp(new Date(start.getTime() + 2 * 60 * 60 * 1000));
  const vars = {
    produsent: ctx.producerName,
    ref: booking.booking_ref,
    sted: ctx.sted,
    statusside: ctx.statusUrl ?? "",
  };
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Opplevagent//Gardssalg Booking//NO",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${booking.booking_id}-${dtStart}@opplevagent.no`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${icsEscapeText(fillOa1(oa1Text("ics.summary", lang), vars))}`,
  ];
  if (ctx.statusUrl) lines.push(`DESCRIPTION:${icsEscapeText(fillOa1(oa1Text("ics.description", lang), vars))}`);
  if (ctx.sted) lines.push(`LOCATION:${icsEscapeText(fillOa1(oa1Text("ics.location", lang), vars))}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(icsFold).join("\r\n");
}

/** Only a visit the producer has confirmed gets a calendar file (flag ON). */
export function calendarFileAllowed(booking: Pick<GardssalgBooking, "pre_status" | "status">): boolean {
  return booking.pre_status === "provider_confirmed" && booking.status !== "cancelled";
}

/**
 * The confirmed calendar file for the download route, or null before the
 * producer has confirmed. The route is reachable with the booking reference
 * alone (receipt page, arrival QR), so this file never carries the guest's
 * status link (its token is a guest credential): statusUrl null drops
 * DESCRIPTION. Only the e-mailed file, sent to the guest, has it.
 */
export function confirmedIcsForBooking(booking: GardssalgBooking, lang: ReceiptLang = "nb"): string | null {
  if (!calendarFileAllowed(booking)) return null;
  const provider = loadReceiptProvider(booking.provider_id);
  return buildConfirmedIcs(
    booking,
    { producerName: provider.navn, sted: provider.sted, statusUrl: null },
    lang,
  );
}

/** receipt.formMessage — the POST /book `message` (plain text, not HTML). */
export function receiptFormMessage(guestEmail: string, lang: ReceiptLang = "nb"): string {
  return fillOa1(oa1Text("receipt.formMessage", lang), { "e-post": guestEmail });
}
