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
// "en" AND GARDSSALG_EMAIL_EN_ENABLED is on. No guest language is stored on a
// booking yet, so every caller passes "nb" today; the English strings are
// kept here (and tested) so the switch is a one-line change later.

import { getDb } from "../database/db-factory";
import type { GardssalgBooking } from "./booking-store";

export type ReceiptLang = "nb" | "en";

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
  "receipt.email.subject": {
    nb: "Vi har mottatt forespørselen din — {ref}",
    en: "We have received your request — {ref}",
  },
  "receipt.email.body": {
    nb: [
      "Hei {gjest},",
      "",
      "Vi har mottatt forespørselen din om besøk hos {produsent}. Besøket er ikke bekreftet ennå.",
      "",
      "Referanse: {ref}",
      "Tidspunkt du ba om: {tid}",
      "Antall: {antall}",
      "Din kommentar: {kommentar}",
      "",
      "Produsenten har fått forespørselen og svarer innen {frist}. Du får e-post når produsenten har bekreftet, foreslått et annet tidspunkt eller avslått. Svarer ikke produsenten innen fristen, utløper forespørselen, og du får beskjed.",
      "",
      "Du kan se status når som helst her: {statusside}",
      "",
      "Har du spørsmål, svarer du på denne e-posten.",
      "",
      "Hilsen",
      "Opplevagent",
    ].join("\n"),
    en: [
      "Hi {gjest},",
      "",
      "We have received your request to visit {produsent}. The visit is not confirmed yet.",
      "",
      "Reference: {ref}",
      "Time you asked for: {tid}",
      "Guests: {antall}",
      "Your note: {kommentar}",
      "",
      "The producer has received the request and will reply by {frist}. We will email you when the producer has confirmed, suggested another time or declined. If the producer does not reply by then, the request expires and we will let you know.",
      "",
      "You can check the status at any time here: {statusside}",
      "",
      "If you have questions, reply to this email.",
      "",
      "Best regards,",
      "Opplevagent",
    ].join("\n"),
  },
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
  "confirmed.icsLine": {
    nb: "Kalenderfilen er lagt ved, slik at du kan legge besøket inn i kalenderen din.",
    en: "A calendar file is attached so you can add the visit to your calendar.",
  },
  "confirmed.newTimeIcsLine": {
    nb: "Kalenderfilen med det nye tidspunktet er lagt ved. Slett den gamle avtalen hvis du har lagt den inn.",
    en: "A calendar file with the new time is attached. Please delete the old entry if you added one.",
  },
} as const;

export type Oa1ReceiptKey = keyof typeof OA1_RECEIPT_TEXTS;

export function oa1Text(key: Oa1ReceiptKey, lang: ReceiptLang = "nb"): string {
  return OA1_RECEIPT_TEXTS[key][lang];
}

/** Replaces {placeholder}s; values are inserted as given (escape before if needed). */
export function fillOa1(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zæøå-]+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m,
  );
}

// ─── Context helpers ────────────────────────────────────────────────────────

const DATE_LOCALE: Record<ReceiptLang, string> = { nb: "nb-NO", en: "en-GB" };

/** {tid}/{frist} in words, Oslo time ("fredag 12. desember 2026 kl. 13:00"). */
export function formatOsloInstant(iso: string | null, lang: ReceiptLang = "nb"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString(DATE_LOCALE[lang], {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  });
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
 * The guest receipt. Returns null when the booking has no answer deadline
 * ({frist} cannot be filled) — the caller then keeps the legacy receipt.
 * The «Din kommentar» line is only included when the guest wrote a note
 * (package rule); the status line only when the booking has a status link.
 */
export function buildHonestReceiptEmail(
  booking: GardssalgBooking,
  ctx: { producerName: string; statusUrl: string | null },
  lang: ReceiptLang = "nb",
): HonestReceiptEmail | null {
  const frist = formatOsloInstant(booking.respond_token_expires_at, lang);
  if (!frist) return null;

  const paragraphs = oa1Text("receipt.email.body", lang)
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

function statusUrlFor(booking: GardssalgBooking): string | null {
  const appUrl = process.env.APP_URL || "https://opplevagent.no";
  return booking.guest_status_token
    ? `${appUrl}/kategori/gardssalg/status/${encodeURIComponent(booking.booking_ref)}/${booking.guest_status_token}`
    : null;
}

/** The confirmed calendar file for the download route, or null before the producer has confirmed. */
export function confirmedIcsForBooking(booking: GardssalgBooking, lang: ReceiptLang = "nb"): string | null {
  if (!calendarFileAllowed(booking)) return null;
  const provider = loadReceiptProvider(booking.provider_id);
  return buildConfirmedIcs(
    booking,
    { producerName: provider.navn, sted: provider.sted, statusUrl: statusUrlFor(booking) },
    lang,
  );
}

/** receipt.formMessage — the POST /book `message` (plain text, not HTML). */
export function receiptFormMessage(guestEmail: string, lang: ReceiptLang = "nb"): string {
  return fillOa1(oa1Text("receipt.formMessage", lang), { "e-post": guestEmail });
}
