// ─── Recipient policy for COLD outreach ───────────────────────────────────────
//
// dev-request 2026-10-08-mottakerpolicy-alle-adresser (Daniel live 2026-10-08:
// «A, la alle adresser slippe gjennom»): cold outreach goes to EVERY well-formed
// address, personal addresses and free-mail domains included — small producers
// often use their own mailbox. Only malformed or empty input is held back.
//
// This replaces the "strict" mode of dev-request 2026-10-06-mottakerpolicy-
// kald-utsending-mfl-15 (lokal#997: general role addresses only). The
// classifier below is kept unchanged, now for REPORTING only: the dry runs
// count what kind of address each selected recipient has
// (countRecipientAddressTypes), so reply rates can be compared per type later.
//
// Pure: no I/O, no env. The mode is a constant in code (no secret needed).
// Used by every cold-send selection/send path (RFB gate + daily job,
// gårdssalg/opplevagent eligibility + send). Transactional mail (account,
// booking, service notifications, replies to people who wrote to us) never
// goes through this module. All other suppressions (cooldown, opt-out,
// bounces, blocklist, cross-platform) live elsewhere and are unaffected.

/** "all_valid": every well-formed address may receive cold outreach. */
export const RECIPIENT_POLICY_MODE = "all_valid" as const;

/**
 * Reason string for the existing `personal_address` suppressed_counts bucket
 * and skip rows. The key is kept so the response contract does not change;
 * under "all_valid" it is only produced for a malformed or empty address.
 */
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
  reason: RecipientAddressType;
}

/** The address types the classifier tells apart (stable strings). */
export type RecipientAddressType =
  | "general_role_address"
  | "personal_local_part"
  | "free_mail_domain"
  | "malformed_or_empty";

const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What kind of address is this? `general: true` only when the local part is in
 * GENERAL_ROLE_LOCAL_PARTS AND the domain is not a free-mail domain. Reporting
 * only since 2026-10-08 — isColdRecipientAllowed no longer filters on it.
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
 * outreach. Under "all_valid" that is every well-formed address; only a
 * malformed or empty one is held back.
 */
export function isColdRecipientAllowed(email: unknown): boolean {
  return classifyRecipientAddress(email).reason !== "malformed_or_empty";
}

/**
 * Count the address types of a set of recipients — reporting only, never a
 * filter. Used by the dry runs so the share of general / personal / free-mail
 * recipients is visible per run.
 */
export function countRecipientAddressTypes(emails: Iterable<unknown>): Record<RecipientAddressType, number> {
  const counts: Record<RecipientAddressType, number> = {
    general_role_address: 0,
    personal_local_part: 0,
    free_mail_domain: 0,
    malformed_or_empty: 0,
  };
  for (const e of emails) counts[classifyRecipientAddress(e).reason]++;
  return counts;
}
