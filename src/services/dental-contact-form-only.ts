/**
 * dental-contact-form-only.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-D3a
 * («Kontaktskjema som valg per profil» on finn-tannlege.com). The dental
 * counterpart of contact-form-only.ts (S-D1 + S-D2 on rettfrabonden.com).
 *
 * A clinic that does not want its e-mail address shown can ask us; an admin
 * then sets dental_agents.contact_form_only = 1 (POST
 * /admin/dental/agents/:id/contact-form-only, record only, no mail). With the
 * switch CONTACT_FORM_DENTAL on, that clinic:
 *   - has a contact form on /klinikk/:slug and /klinikk/id/:id instead of the
 *     mailto: line and «Vis e-post», and no JSON-LD `email`;
 *   - answers GET /klinikk/id/:id/epost like a clinic without e-mail (404);
 *   - gets messages through POST /klinikk/id/:id/kontakt (routes/dental-seo.ts),
 *     forwarded as ONE text mail to the stored address (Reply-To = sender)
 *     through the platform mail path, with the shared honeypot, validation
 *     and per-IP limit (5 per hour, dental's own store) of contact-form-only.ts;
 *   - has `epost` null — exactly what a clinic without e-mail has, no new
 *     field — in REST GET /api/tannlege/agents[/:id] (public view; the
 *     X-Admin-Key view keeps it), the A2A message/send answers (tannlege_info
 *     and the search list) and MCP tannlege_info. A flagged clinic spends no
 *     e-mail reveal budget (EMAIL_REVEAL_GUARD_DENTAL).
 *
 * Switch: CONTACT_FORM_DENTAL, default OFF; on for "on", "1" or "true"
 * (trimmed, any case). Read per call. Off → the flag is not even read and
 * every answer is byte-identical to main; the POST path falls through to the
 * dental catch-all 404.
 *
 * Logs: profile id, outcome and a hashed client id only — never an address,
 * an IP or the message text.
 */

import type Database from "better-sqlite3";
import { getDb } from "../database/db-factory";
import { crmFromHeader } from "./crm-platform-identity";
import { contactFormEnabled, contactFormOneLine, type ContactFormInput } from "./contact-form-only";
import type { EmailOptions } from "./email-service";

type Env = Record<string, string | undefined>;

/** Whether the contact-form option is on for finn-tannlege.com (default off). */
export function dentalContactFormEnabled(env: Env = process.env): boolean {
  return contactFormEnabled("dental", env);
}

/** Whether a dental clinic has the contact-form-only flag. Missing row / column → false. */
export function isDentalContactFormOnly(clinicId: string, db: Database.Database = getDb("dental")): boolean {
  try {
    const row = db.prepare("SELECT contact_form_only FROM dental_agents WHERE id = ?").get(clinicId) as { contact_form_only?: number } | undefined;
    return Number(row?.contact_form_only ?? 0) === 1;
  } catch {
    return false;
  }
}

/** Ids per IN (…) query, well below SQLite's bound-parameter limit. */
const FLAG_QUERY_CHUNK = 500;

/**
 * The ids among `clinicIds` that have the contact-form-only flag. null when
 * CONTACT_FORM_DENTAL is off: the flag is not read and the caller changes
 * nothing. Duplicates / empty ids are ignored; a failed read counts as
 * unflagged.
 */
export function dentalContactFormOnlyIds(clinicIds: readonly string[], env: Env = process.env): ReadonlySet<string> | null {
  if (!dentalContactFormEnabled(env)) return null;
  const ids = Array.from(new Set(clinicIds.filter((id) => typeof id === "string" && id !== "")));
  const flagged = new Set<string>();
  if (ids.length === 0) return flagged;
  let db: Database.Database;
  try { db = getDb("dental"); } catch { return flagged; }
  for (let i = 0; i < ids.length; i += FLAG_QUERY_CHUNK) {
    const chunk = ids.slice(i, i + FLAG_QUERY_CHUNK);
    try {
      const rows = db.prepare(`SELECT id FROM dental_agents WHERE contact_form_only = 1 AND id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<{ id: string }>;
      for (const r of rows) flagged.add(r.id);
    } catch { /* no column: nothing flagged */ }
  }
  return flagged;
}

/**
 * Sets the flag (admin). Returns the stored value, or null for an unknown id.
 * The only DB write of S-D3a; never touches the e-mail address.
 */
export function setDentalContactFormOnly(db: Database.Database, clinicId: string, enabled: boolean): { id: string; contact_form_only: boolean } | null {
  const row = db.prepare("SELECT id FROM dental_agents WHERE id = ?").get(clinicId) as { id: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE dental_agents SET contact_form_only = ? WHERE id = ?").run(enabled ? 1 : 0, clinicId);
  return { id: row.id, contact_form_only: isDentalContactFormOnly(clinicId, db) };
}

const SUBJECT_MAX = 150;

/** The forwarded mail (text only). The clinic's address is only `to`. */
export function buildDentalContactFormMail(opts: { clinicName: string; profileUrl: string; input: ContactFormInput; to: string }): EmailOptions {
  const subjectRaw = `Melding via Finn-tannlege.com: ${opts.input.name}`;
  const chars = Array.from(subjectRaw);
  const subject = chars.length <= SUBJECT_MAX ? subjectRaw : chars.slice(0, SUBJECT_MAX - 1).join("").trimEnd() + "…";
  const textContent = [
    `Hei ${contactFormOneLine(opts.clinicName)}!`,
    "",
    `Dere har fått en melding gjennom kontaktskjemaet på klinikkens side på Finn-tannlege.com (${opts.profileUrl}).`,
    "",
    `Fra: ${opts.input.name}`,
    `Svar-adresse: ${opts.input.replyEmail}`,
    "",
    opts.input.message,
    "",
    "—",
    "Denne meldingen ble videresendt av Finn-tannlege.com. Avsenderen har ikke sett e-postadressen deres.",
    "Svarer dere på denne e-posten, går svaret direkte til avsenderen, som da ser adressen dere svarer fra.",
    "Vi har ikke kontrollert innholdet i meldingen. Ser den ut som svindel eller reklame, kan dere se bort fra den.",
  ].join("\n");
  return {
    to: opts.to,
    from: crmFromHeader("dental"),
    subject,
    textContent,
    replyTo: opts.input.replyEmail,
    // Not outreach, and the mail carries a visitor's address and free text:
    // keep the recipient and the subject out of the send log.
    omitAgentHeader: true,
    redactRecipientInLogs: true,
    logSubjectAs: "[Kontaktskjema · tannklinikk]",
  };
}
