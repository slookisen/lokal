// registration-confirmation-texts.ts — the wording of the confirmation mail
// a producer gets after a successful self-registration (public
// POST /api/marketplace/register). S1 of the registration-confirmation
// dev-request (2026-11-10).
//
// Kept in its own module, like claim-request-more-texts.ts, so the text can be
// quoted verbatim for approval and reworded without touching the flow
// (services/registration-confirmation.ts) or the mail plumbing
// (email-service.ts sendRegistrationConfirmation). Only the registered name is
// interpolated: no links, no profile data, no address. The subject is fixed, so
// no visitor text ever reaches a mail header.

export const REGISTRATION_CONFIRMATION_SUBJECT = "Vi har mottatt registreringen din";

export const REGISTRATION_CONFIRMATION_SIGN_OFF = "Rett fra Bonden";

/** Longest name (in code points) the mail repeats; longer names are cut with «…». */
const NAME_MAX_CHARS = 120;

/**
 * The registered name as the mail shows it: control characters (CR/LF among
 * them) and bidi marks become a space / are dropped, whitespace is collapsed,
 * and very long names are capped. Empty after cleaning → «profilen din».
 */
export function registrationConfirmationDisplayName(name: string): string {
  const oneLine = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return "profilen din";
  const chars = Array.from(oneLine);
  return chars.length <= NAME_MAX_CHARS ? oneLine : chars.slice(0, NAME_MAX_CHARS - 1).join("").trimEnd() + "…";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain-text body. */
export function buildRegistrationConfirmationText(name: string): string {
  const display = registrationConfirmationDisplayName(name);
  return (
    "Hei!\n\n" +
    `Takk for at du registrerte ${display} hos Rett fra Bonden. ` +
    "Vi har mottatt registreringen og ser over profilen innen to virkedager.\n\n" +
    "Har du spørsmål, kan du svare på denne e-posten. Svaret går til kundeservice.\n\n" +
    "Vennlig hilsen\n" +
    `${REGISTRATION_CONFIRMATION_SIGN_OFF}\n`
  );
}

/** HTML body: the same text, with the name HTML-escaped. */
export function buildRegistrationConfirmationHtml(name: string): string {
  const display = escapeHtml(registrationConfirmationDisplayName(name));
  return (
    "<p>Hei!</p>\n" +
    `<p>Takk for at du registrerte ${display} hos Rett fra Bonden. ` +
    "Vi har mottatt registreringen og ser over profilen innen to virkedager.</p>\n" +
    "<p>Har du spørsmål, kan du svare på denne e-posten. Svaret går til kundeservice.</p>\n" +
    `<p>Vennlig hilsen<br>\n${REGISTRATION_CONFIRMATION_SIGN_OFF}</p>\n`
  );
}
