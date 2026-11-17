// ─── Gårdssalg booking e-mails: the one text register (O4-2) ──────────────
//
// A2A dev-request 2026-11-12-opplevagent-o4-epost-og-tekster, slice O4-2.
// Every subject line and every sentence of the gårdssalg booking e-mails —
// to the guest and to the producer — lives here, keyed per text key and
// language. The senders (booking-store.ts, gardssalg-honest-receipt.ts,
// gardssalg-cancel.ts) keep only markup and layout.
//
// Norwegian: today's wording, moved unchanged (the golden test
// gardssalg-email-texts.test.ts proves the e-mails are byte-identical).
// English: verbatim from the approved text packages — OA-2 part A (A2A
// marketing-drafts/2026-11-12-opplevagent-tekstpakke-oa-2.md, approved by
// Daniel 2026-11-15) for the four status e-mails and the shared labels, and
// OA-1 §1/§4 for the honest receipt and the cancellation. Do not reword
// here: a new or changed sentence goes through a text package first.
//
// `en: null` = the packages have no English text for that key:
//   - producer e-mails are always Norwegian (OA-2 A: «E-post til produsenten
//     er alltid norsk»);
//   - the legacy receipt (honest receipt flag off) is not translated (OA-2 A);
//   - Norwegian-only pieces of today's layout that the English e-mails do not
//     have (EN_NOT_IN_PACK below).
// English is sent only when GARDSSALG_EMAIL_EN_ENABLED is "true" AND the
// booking's guest_lang is "en" (guestEmailLang()); otherwise Norwegian.

export type EmailLang = "nb" | "en";
export type EmailAudience = "guest" | "producer";

export interface EmailTextEntry {
  readonly nb: string;
  readonly en: string | null;
  readonly audience: EmailAudience;
}

const guest = (nb: string, en: string | null): EmailTextEntry => ({ nb, en, audience: "guest" });
const producer = (nb: string): EmailTextEntry => ({ nb, en: null, audience: "producer" });

// Placeholders: {gjest} {produsent} {ref} {tid} {antall} {kommentar} {frist}
// {statusside} (URL) {statuslenke} (HTML link) {oversikt} (URL)
// {alternativlenke} (HTML link) {nytt_tidspunkt} {svarlenke} {profilside}
// {grunn} {e-post} {lenke} {sted}.
export const GARDSSALG_EMAIL_TEXTS = {
  // ── Shared (OA-2 A, «Felles ledetekster») ───────────────────────────────
  "greeting": guest("Hei {gjest},", "Hi {gjest},"),
  "greeting.producer": producer("Hei,"),
  "label.ref": guest("Bookingref:", "Reference:"),
  "label.time": guest("Dato/tid:", "Date and time:"),
  "label.party": guest("Antall:", "Guests:"),
  "label.note": guest("Din kommentar:", "Your note:"),
  "party.one": guest("{antall} person", null),
  "party.many": guest("{antall} personer", null),
  "footer.status": guest(
    "Se gjeldende status når som helst: {statuslenke}.",
    "You can check the current status at any time: {statusside}",
  ),
  "footer.statusLinkText": guest("statusside for reservasjonen", null),
  "footer.statusText": guest("Status: {statusside}", null),
  "signoff": guest("Hilsen\nOpplevagent", "Best regards,\nOpplevagent"),

  // ── Guest: legacy receipt (GARDSSALG_HONEST_RECEIPT_ENABLED off; not translated) ──
  "receipt.legacy.subject": guest("Bekreftelse på påmelding — {ref}", null),
  "receipt.legacy.lead": guest("Din påmelding er registrert! Her er din bekreftelse:", null),
  "receipt.legacy.textLead": guest("Din påmelding er registrert.", null),
  "receipt.legacy.notified": guest(
    "Produsenten er varslet om forespørselen og svarer på e-post — du får beskjed så snart reservasjonen er bekreftet eller besvart.",
    null,
  ),
  "receipt.legacy.status": guest("Du kan når som helst se gjeldende status her: {statuslenke}.", null),
  "receipt.legacy.statusText": guest("Status for reservasjonen: {statusside}", null),
  "receipt.legacy.ics": guest("En kalenderinvitasjon (ICS) er vedlagt denne e-posten.", null),
  "receipt.legacy.questions": guest("Spørsmål? Svar på denne e-posten.", null),

  // ── Guest: honest receipt (OA-1 §1.2) ───────────────────────────────────
  "receipt.email.subject": guest("Vi har mottatt forespørselen din — {ref}", "We have received your request — {ref}"),
  "receipt.email.body": guest(
    [
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
    [
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
  ),

  // ── Guest: the producer confirmed (OA-2 A1; calendar lines OA-1 §1.3) ───
  "guest.confirmed.subject": guest("Reservasjonen er bekreftet — {ref}", "Your visit is confirmed — {ref}"),
  "guest.confirmed.lead": guest("Gode nyheter — produsenten har bekreftet reservasjonen din:", "{produsent} has confirmed your visit:"),
  "guest.confirmed.leadAccepted": guest(
    "Du har akseptert det nye tidspunktet — reservasjonen er nå bekreftet:",
    "You accepted the new time, and your visit is now confirmed:",
  ),
  "guest.confirmed.textLead": guest("Produsenten har bekreftet reservasjonen din.", null),
  "guest.confirmed.textLeadAccepted": guest("Du har akseptert det nye tidspunktet — reservasjonen er nå bekreftet.", null),
  "guest.confirmed.welcome": guest("Velkommen! Produsenten registrerer oppmøtet etter besøket.", null),
  "confirmed.icsLine": guest(
    "Kalenderfilen er lagt ved, slik at du kan legge besøket inn i kalenderen din.",
    "A calendar file is attached so you can add the visit to your calendar.",
  ),
  "confirmed.newTimeIcsLine": guest(
    "Kalenderfilen med det nye tidspunktet er lagt ved. Slett den gamle avtalen hvis du har lagt den inn.",
    "A calendar file with the new time is attached. Please delete the old entry if you added one.",
  ),

  // ── Guest: declined (OA-2 A2) ───────────────────────────────────────────
  "guest.declined.subject": guest(
    "Reservasjonen kunne dessverre ikke bekreftes — {ref}",
    "Your request could not be confirmed — {ref}",
  ),
  "guest.declined.body": guest(
    "Vi beklager — reservasjonsforespørselen din ({ref}, {tid}) kunne dessverre ikke bekreftes av produsenten denne gangen.",
    "We are sorry. {produsent} could not confirm your request ({ref}, {tid}) this time.",
  ),
  "guest.alternatives": guest(
    "Det finnes flere produsenter som tar imot besøk: {alternativlenke}.",
    "Other producers accept visit requests. You can see them here: {oversikt}",
  ),
  "guest.alternativesLinkText": guest("se alternative tilbydere her", null),
  "guest.alternativesText": guest("Se alternative tilbydere: {oversikt}", null),

  // ── Guest: the producer suggests another time (OA-2 A3) ─────────────────
  "guest.suggestion.subject": guest(
    "Produsenten foreslår et nytt tidspunkt — {ref}",
    "The producer suggests another time — {ref}",
  ),
  "guest.suggestion.lead": guest(
    "Produsenten kan dessverre ikke ta imot besøket {tid}, men foreslår i stedet:",
    "{produsent} cannot receive you on {tid}, but suggests this time instead:",
  ),
  "guest.suggestion.reply": guest(
    "{svarlenke} — du kan akseptere det nye tidspunktet eller avslå.",
    "Reply to the suggestion here: {svarlenke}\nYou can accept the new time or decline it.",
  ),
  "guest.suggestion.replyLinkText": guest("Svar på forslaget her", null),
  "guest.suggestion.replyText": guest("Aksepter eller avslå forslaget her (personlig lenke):", null),
  "guest.suggestion.personal": guest(
    "Lenken er personlig for denne reservasjonen ({ref}) — ikke del den videre.",
    "The link is personal to this request ({ref}). Please do not share it.",
  ),

  // ── Guest: the request expired (OA-2 A4) ────────────────────────────────
  "guest.expired.subject": guest("Forespørselen utløp uten svar — {ref}", "Your request expired without a reply — {ref}"),
  "guest.expired.body": guest(
    "Vi beklager — produsenten har dessverre ikke besvart reservasjonsforespørselen din ({ref}, {tid}) i tide, så den er nå utløpt.",
    "We are sorry. {produsent} did not reply to your request ({ref}, {tid}) in time, so it has expired.",
  ),
  "guest.expired.bodySuggested": guest(
    "Vi beklager — det foreslåtte tidspunktet for reservasjonsforespørselen din ({ref}, {tid}) ble dessverre ikke endelig avklart i tide, så forespørselen er nå utløpt.",
    "We are sorry. The suggested time for your request ({ref}, {tid}) was not settled in time, so the request has expired.",
  ),

  // ── Guest: reminder the day before a confirmed visit (OA-2 B, O4-5) ─────
  // Sent once by the followup job (GARDSSALG_GUEST_REMINDER_ENABLED). The
  // body is the package's text with the cancel line ({statusside}); with
  // GARDSSALG_CANCEL_ENABLED off that paragraph is replaced by
  // guest.reminder.replyLine (OA-2 B, last paragraph).
  "guest.reminder.subject": guest(
    "I morgen: besøk hos {produsent} — {ref}",
    "Tomorrow: your visit to {produsent} — {ref}",
  ),
  "guest.reminder.body": guest(
    [
      "Hei {gjest},",
      "",
      "Dette er en påminnelse om besøket du har avtalt:",
      "",
      "Sted: {produsent}, {sted}",
      "Tidspunkt: {tid}",
      "Antall: {antall}",
      "Referanse: {ref}",
      "",
      "Kan du ikke komme likevel, er det fint om du avlyser, så produsenten får beskjed: {statusside}",
      "",
      "Hilsen",
      "Opplevagent",
    ].join("\n"),
    [
      "Hi {gjest},",
      "",
      "This is a reminder of the visit you have arranged:",
      "",
      "Place: {produsent}, {sted}",
      "Date and time: {tid}",
      "Guests: {antall}",
      "Reference: {ref}",
      "",
      "If you cannot come after all, please cancel so that the producer is told: {statusside}",
      "",
      "Best regards,",
      "Opplevagent",
    ].join("\n"),
  ),
  "guest.reminder.replyLine": guest(
    "Kan du ikke komme likevel, svarer du på denne e-posten.",
    "If you cannot come after all, reply to this email.",
  ),

  // ── Guest: the producer cancelled (OA-1 §4.2) ───────────────────────────
  "cancel.toGuest.subject": guest("{produsent} har avlyst besøket — {ref}", "{produsent} has cancelled the visit — {ref}"),
  "cancel.toGuest.body": guest(
    [
      "Hei {gjest},",
      "",
      "{produsent} har dessverre måttet avlyse besøket {tid}. Referanse: {ref}.",
      "",
      "Grunn fra produsenten: {grunn}",
      "",
      "Hvis du har lagt besøket inn i kalenderen din, må du slette det selv. Vil du prøve et annet tidspunkt, kan du sende en ny forespørsel fra profilsiden: {profilside}",
      "",
      "Hilsen",
      "Opplevagent",
    ].join("\n"),
    [
      "Hi {gjest},",
      "",
      "Unfortunately, {produsent} has had to cancel the visit on {tid}. Reference: {ref}.",
      "",
      "Reason from the producer: {grunn}",
      "",
      "If you added the visit to your calendar, please delete it yourself. If you would like to try another time, you can send a new request from the profile page: {profilside}",
      "",
      "Best regards,",
      "Opplevagent",
    ].join("\n"),
  ),

  // ── Producer: new request (always Norwegian) ────────────────────────────
  "producer.new.subject": producer("Ny reservasjon — {ref}"),
  "producer.new.lead": producer("Du har fått en ny reservasjonsforespørsel via Opplevagent:"),
  "producer.new.textLead": producer("Du har fått en ny reservasjonsforespørsel via Opplevagent."),
  "producer.label.guest": producer("Gjest:"),
  "producer.label.email": producer("E-post:"),
  "producer.label.phone": producer("Telefon:"),
  "producer.label.note": producer("Kommentar fra gjesten:"),
  "producer.label.hours": producer("Dine oppgitte åpningstider:"),
  "producer.new.respondHeading": producer("Svar på forespørselen:"),
  "producer.new.respondButton": producer("Åpne svarsiden"),
  "producer.new.respondChoices": producer("Der kan du bekrefte, foreslå et nytt tidspunkt eller avslå."),
  "producer.new.respondText": producer("Svar på forespørselen (bekreft / foreslå nytt tidspunkt / avslå):"),
  "producer.deadline": producer(
    "Svarfrist: {frist} — uten svar innen fristen utløper forespørselen automatisk og gjesten får beskjed.",
  ),
  "producer.deadlineNone": producer("Uten svar utløper forespørselen automatisk og gjesten får beskjed."),
  "producer.new.guestQuestions": producer("Spørsmål fra gjesten kan besvares direkte — gjestens e-post står over."),
  "producer.new.after": producer("Etter besøket: {lenke}."),
  "producer.new.afterLinkText": producer("bekreft oppmøte eller ikke-oppmøte her"),
  "producer.new.linksPersonal": producer("Lenkene er personlige for denne reservasjonen — ikke del dem videre."),
  "producer.new.afterText": producer("Etter besøket: bekreft oppmøte her (personlig lenke, ikke del videre):"),

  // ── Producer: reminder ──────────────────────────────────────────────────
  "producer.reminder.subject": producer("Påminnelse: ubesvart reservasjonsforespørsel — {ref}"),
  "producer.reminder.lead": producer("En reservasjonsforespørsel venter fortsatt på svar fra deg:"),
  "producer.reminder.textLead": producer("En reservasjonsforespørsel venter fortsatt på svar fra deg."),
  "producer.reminder.linkText": producer("Svar her: bekreft, foreslå nytt tidspunkt eller avslå"),
  "producer.reminder.respondText": producer("Svar her (bekreft / foreslå nytt tidspunkt / avslå):"),

  // ── Producer: the guest's answer to a suggested time ────────────────────
  "producer.guestAccepted.subject": producer("Gjesten aksepterte det nye tidspunktet — {ref}"),
  "producer.guestAccepted.body": producer("Gjesten {gjest} har akseptert det nye tidspunktet for reservasjon {ref}."),
  "producer.guestAccepted.time": producer("Avtalt tidspunkt er nå: {tid}."),
  "producer.guestAccepted.attendance": producer("Bekreft oppmøte etter besøket via lenken i den opprinnelige e-posten."),
  "producer.guestDeclined.subject": producer("Gjesten avslo det nye tidspunktet — {ref}"),
  "producer.guestDeclined.body": producer(
    "Gjesten {gjest} kunne dessverre ikke på det foreslåtte tidspunktet, og reservasjonsforespørselen {ref} er avsluttet.",
  ),

  // ── Producer: the guest cancelled or withdrew (OA-1 §4.1) ───────────────
  "cancel.toProducer.subject": producer("Gjesten har avlyst — {ref}"),
  "cancel.toProducer.subjectPending": producer("Gjesten har trukket forespørselen — {ref}"),
  "cancel.toProducer.body": producer(
    [
      "Hei,",
      "",
      "{gjest} har avlyst besøket {tid} ({antall} personer). Referanse: {ref}.",
      "",
      "Grunn fra gjesten: {grunn}",
      "",
      "Du trenger ikke gjøre noe. Tidspunktet er ledig igjen.",
      "",
      "Hilsen",
      "Opplevagent",
    ].join("\n"),
  ),
  "cancel.toProducer.cancelledPhrase": producer("har avlyst besøket"),
  "cancel.toProducer.withdrawnPhrase": producer("har trukket forespørselen om besøk"),
} as const satisfies Record<string, EmailTextEntry>;

export type GardssalgEmailKey = keyof typeof GARDSSALG_EMAIL_TEXTS;

/**
 * Guest keys without English text, and why. The English e-mails are built
 * without them (the packages' English layout has no such line). Producer
 * keys never have English and are not listed.
 */
export const EN_NOT_IN_PACK: Readonly<Partial<Record<GardssalgEmailKey, string>>> = {
  "party.one": "English shows the number only («Guests: {antall}»)",
  "party.many": "English shows the number only («Guests: {antall}»)",
  "footer.statusLinkText": "English shows the status URL itself",
  "footer.statusText": "Norwegian plain-text variant of footer.status",
  "receipt.legacy.subject": "legacy receipt is not translated (OA-2 A)",
  "receipt.legacy.lead": "legacy receipt is not translated (OA-2 A)",
  "receipt.legacy.textLead": "legacy receipt is not translated (OA-2 A)",
  "receipt.legacy.notified": "legacy receipt is not translated (OA-2 A)",
  "receipt.legacy.status": "legacy receipt is not translated (OA-2 A)",
  "receipt.legacy.statusText": "legacy receipt is not translated (OA-2 A)",
  "receipt.legacy.ics": "legacy receipt is not translated (OA-2 A)",
  "receipt.legacy.questions": "legacy receipt is not translated (OA-2 A)",
  "guest.confirmed.textLead": "Norwegian plain-text variant of guest.confirmed.lead",
  "guest.confirmed.textLeadAccepted": "Norwegian plain-text variant of guest.confirmed.leadAccepted",
  "guest.confirmed.welcome": "not in the English A1 e-mail",
  "guest.alternativesLinkText": "English shows the overview URL itself",
  "guest.alternativesText": "Norwegian plain-text variant of guest.alternatives",
  "guest.suggestion.replyLinkText": "English shows the reply URL itself",
  "guest.suggestion.replyText": "Norwegian plain-text variant of guest.suggestion.reply",
};

/** The text for a key; Norwegian when the key has no English text. */
export function emailText(key: GardssalgEmailKey, lang: EmailLang = "nb"): string {
  const e: EmailTextEntry = GARDSSALG_EMAIL_TEXTS[key];
  return lang === "en" && e.en !== null ? e.en : e.nb;
}

/** Replaces {placeholder}s in one pass; values are inserted as given (escape before if needed). */
export function fillEmailText(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zæøå_-]+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m,
  );
}

// ─── Guest language ─────────────────────────────────────────────────────────

/** Off unless exactly "true", read on every call like the other GARDSSALG_* flags. */
export function gardssalgEmailEnEnabled(): boolean {
  return process.env.GARDSSALG_EMAIL_EN_ENABLED === "true";
}

/** The stored guest language: "en" or "nb"; anything else (missing, invalid) is "nb". */
export function normaliseGuestLang(raw: unknown): EmailLang {
  return typeof raw === "string" && raw.trim().toLowerCase() === "en" ? "en" : "nb";
}

/** The language of the guest's e-mails: English only with the flag on AND guest_lang "en". */
export function guestEmailLang(booking: { guest_lang?: string | null }): EmailLang {
  return gardssalgEmailEnEnabled() && booking.guest_lang === "en" ? "en" : "nb";
}

// ─── English e-mail rendering ───────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Text and HTML from a plain body (the packages' layout): paragraphs split on
 * blank lines, lines in a paragraph joined with <br>. Values are escaped in
 * the HTML; `urlKeys` become links there.
 */
export function renderEmailBody(
  body: string,
  raw: Record<string, string>,
  urlKeys: string[] = [],
): { text: string; html: string } {
  const esc: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) esc[k] = escHtml(v);
  for (const k of urlKeys) if (raw[k]) esc[k] = `<a href="${escHtml(raw[k])}">${escHtml(raw[k])}</a>`;
  const text = fillEmailText(body, raw);
  const html = body
    .split("\n\n")
    .map((p) => `<p>${p.split("\n").map((l) => fillEmailText(escHtml(l), esc)).join("<br>\n")}</p>`)
    .join("\n");
  return { text, html };
}
