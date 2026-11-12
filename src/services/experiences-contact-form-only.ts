/**
 * experiences-contact-form-only.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-D3b
 * («Kontaktskjema som valg per profil» on opplevagent.no). The Opplevagent
 * counterpart of contact-form-only.ts (S-D1, RFB) and
 * dental-contact-form-only.ts (S-D3a, finn-tannlege.com).
 *
 * A gårdssalg producer that does not want its e-mail address shown can ask
 * us; an admin then sets experience_providers.contact_form_only = 1 (POST
 * /admin/experiences/providers/:id/contact-form-only, record only, no mail).
 * With the switch CONTACT_FORM_EXPERIENCES on, that producer:
 *   - has a contact form on /kategori/gardssalg/produsent/:providerSlug (and
 *     its /en, /sv forms) instead of the «E-post» mailto: row and «Vis
 *     e-post», and no JSON-LD `email` (the only public page that prints the
 *     provider e-mail);
 *   - answers GET /kategori/gardssalg/produsent/:providerSlug/epost like a
 *     producer without e-mail (404);
 *   - gets messages through POST /kategori/gardssalg/produsent/:providerSlug/kontakt
 *     (routes/experiences-seo.ts), forwarded as ONE text mail to the stored
 *     address (Reply-To = sender) through the platform mail path, with the
 *     shared honeypot, validation and per-IP limit (5 per hour, the
 *     experiences store) of contact-form-only.ts;
 *   - spends no e-mail reveal budget (EMAIL_REVEAL_GUARD_EXPERIENCES).
 * No form where the page would not show the e-mail anyway: no e-mail stored,
 * e-mail under review (AC4), hidden or test producer.
 *
 * Not touched: MCP (experiences-mcp.ts) and A2A (experiences-a2a.ts) carry no
 * producer e-mail and are under a contract freeze; booking notices keep using
 * the stored address internally.
 *
 * Switch: CONTACT_FORM_EXPERIENCES, default OFF; on for "on", "1" or "true"
 * (trimmed, any case). Read per call. Off → the flag is not even read and
 * every answer is byte-identical to main; the POST path falls through to the
 * router's catch-all 404.
 *
 * Logs: provider id, outcome and a hashed client id only — never an address,
 * an IP or the message text.
 */

import type Database from "better-sqlite3";
import { getDb } from "../database/db-factory";
import { crmFromHeader } from "./crm-platform-identity";
import { contactFormEnabled, contactFormOneLine, type ContactFormInput } from "./contact-form-only";
import type { EmailOptions } from "./email-service";

type Env = Record<string, string | undefined>;

/** Whether the contact-form option is on for opplevagent.no (default off). */
export function experiencesContactFormEnabled(env: Env = process.env): boolean {
  return contactFormEnabled("experiences", env);
}

/** Whether an experiences provider has the contact-form-only flag. Missing row / column → false. */
export function isExperiencesContactFormOnly(providerId: string, db: Database.Database = getDb("experiences")): boolean {
  try {
    const row = db.prepare("SELECT contact_form_only FROM experience_providers WHERE id = ?").get(providerId) as { contact_form_only?: number } | undefined;
    return Number(row?.contact_form_only ?? 0) === 1;
  } catch {
    return false;
  }
}

/**
 * Sets the flag (admin). Returns the stored value, or null for an unknown id.
 * The only DB write of S-D3b; never touches the e-mail address.
 */
export function setExperiencesContactFormOnly(db: Database.Database, providerId: string, enabled: boolean): { id: string; contact_form_only: boolean } | null {
  const row = db.prepare("SELECT id FROM experience_providers WHERE id = ?").get(providerId) as { id: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE experience_providers SET contact_form_only = ? WHERE id = ?").run(enabled ? 1 : 0, providerId);
  return { id: row.id, contact_form_only: isExperiencesContactFormOnly(providerId, db) };
}

const SUBJECT_MAX = 150;

/** The forwarded mail (text only). The producer's address is only `to`. */
export function buildExperiencesContactFormMail(opts: { providerName: string; profileUrl: string; input: ContactFormInput; to: string }): EmailOptions {
  const subjectRaw = `Melding via Opplevagent: ${opts.input.name}`;
  const chars = Array.from(subjectRaw);
  const subject = chars.length <= SUBJECT_MAX ? subjectRaw : chars.slice(0, SUBJECT_MAX - 1).join("").trimEnd() + "…";
  const textContent = [
    `Hei ${contactFormOneLine(opts.providerName)}!`,
    "",
    `Dere har fått en melding gjennom kontaktskjemaet på profilen deres på Opplevagent (${opts.profileUrl}).`,
    "",
    `Fra: ${opts.input.name}`,
    `Svar-adresse: ${opts.input.replyEmail}`,
    "",
    opts.input.message,
    "",
    "—",
    "Denne meldingen ble videresendt av Opplevagent. Avsenderen har ikke sett e-postadressen deres.",
    "Svarer dere på denne e-posten, går svaret direkte til avsenderen, som da ser adressen dere svarer fra.",
    "Vi har ikke kontrollert innholdet i meldingen. Ser den ut som svindel eller reklame, kan dere se bort fra den.",
  ].join("\n");
  return {
    to: opts.to,
    // The same sender identity as the gårdssalg booking notices (booking-store.ts).
    from: crmFromHeader("experiences"),
    subject,
    textContent,
    replyTo: opts.input.replyEmail,
    // Not outreach, and the mail carries a visitor's address and free text:
    // keep the recipient and the subject out of the send log.
    omitAgentHeader: true,
    redactRecipientInLogs: true,
    logSubjectAs: "[Kontaktskjema · gårdssalg]",
  };
}
