// ─── Recipient policy for COLD outreach (markedsføringsloven § 15) ────────────
//
// dev-request 2026-10-06-mottakerpolicy-kald-utsending-mfl-15 (confirmed by
// Daniel 2026-10-06). Cold marketing e-mail may only go to GENERAL role
// addresses (post@, firmapost@, kontakt@, info@ and close equivalents) — or to
// recipients with documented consent. A personal-looking address is held back.
//
// FAIL-CLOSED: anything this module cannot positively recognise as a general
// role address is NOT general (malformed input, unknown local part, unknown
// shape). Free-mail domains (gmail.com, hotmail.com, online.no, …) are never
// general even when the local part looks generic («kontakt@gmail.com»): that is
// a private mailbox with a generic name. Daniel's decision 2026-10-06: «Nei,
// hold tilbake til advokaten har svart.»
//
// Pure: no I/O, no env. The mode is a constant in code (no secret needed).
// Used by every cold-send selection/send path (RFB gate + daily job,
// gårdssalg/opplevagent eligibility + send). Transactional mail (account,
// booking, service notifications, replies to people who wrote to us) never
// goes through this module.

/** Only "strict" exists: general role addresses only. */
export const RECIPIENT_POLICY_MODE = "strict" as const;

/** Reason string used for the suppressed_counts bucket and result rows. */
export const PERSONAL_ADDRESS_REASON = "personal_address";

/**
 * Local parts (before the @) accepted as a general/role address. Exact match
 * after lower-casing — «post.ola» or «info2» are NOT matched (fail-closed).
 */
export const GENERAL_ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "post",
  "firmapost",
  "postmottak",
  "kontakt",
  "kontor",
  "info",
  "informasjon",
  "epost",
  "e-post",
  "mail",
  "contact",
  "office",
  "salg",
  "bestilling",
  "bestillinger",
  "booking",
  "reservasjon",
  "kundeservice",
  "order",
]);

/** Free-mail / consumer-ISP domains: a mailbox there is a private person's. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.no",
  "hotmail.co.uk",
  "outlook.com",
  "outlook.no",
  "live.com",
  "live.no",
  "msn.com",
  "yahoo.com",
  "yahoo.no",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "proton.me",
  "protonmail.com",
  "yandex.com",
  "online.no",
  "broadpark.no",
  "c2i.net",
  "getmail.no",
  "start.no",
  "frisurf.no",
  "lyse.net",
  "altibox.no",
  "tele2.no",
  "chello.no",
  "bbnett.no",
]);

export interface RecipientClassification {
  general: boolean;
  /** Short machine-readable reason (stable strings, safe to log/report). */
  reason: string;
}

const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Is this address a general role address? `general: true` only when the local
 * part is in GENERAL_ROLE_LOCAL_PARTS AND the domain is not a free-mail domain.
 */
export function classifyRecipientAddress(email: unknown): RecipientClassification {
  if (typeof email !== "string") return { general: false, reason: "malformed_or_empty" };
  const addr = email.trim().toLowerCase();
  if (!addr || !SIMPLE_EMAIL.test(addr) || addr.split("@").length !== 2) {
    return { general: false, reason: "malformed_or_empty" };
  }
  const [local, domainRaw] = addr.split("@");
  const domain = domainRaw.replace(/\.$/, "");
  if (FREE_MAIL_DOMAINS.has(domain)) return { general: false, reason: "free_mail_domain" };
  if (!GENERAL_ROLE_LOCAL_PARTS.has(local)) return { general: false, reason: "personal_local_part" };
  return { general: true, reason: "general_role_address" };
}

/**
 * The helper every cold-send path calls: true = this recipient may receive cold
 * marketing e-mail under the strict policy. (No consent store exists yet, so
 * there is no consent exception — documented consent would be added here.)
 */
export function isColdRecipientAllowed(email: unknown): boolean {
  return classifyRecipientAddress(email).general;
}
