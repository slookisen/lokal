// ─── gardssalg-outreach-dedupe ──────────────────────────────────────────
//
// dev-request 2026-07-31-gardssalg-provider-dubletter-på-tvers-av-seeds,
// Slice 2 ("outreach-guard"): a single `POST /admin/gardssalg-outreach-
// preflight` request can contain two different experience_providers rows
// that represent the SAME real business (seeded from different sources) —
// same exact email, or different emails at the same company domain. Left
// alone, both rows could independently come back go:true, risking two
// outreach sends to one producer.
//
// This is a PURE, in-request dedup guard only — no cross-request/persistent
// "already sent" tracking (that would be a full outreach-ledger, larger
// scope, not this slice). "First seen in order" wins; everything after it
// for the same email or the same non-freemail registrable domain is
// suppressed with a machine-readable reason.
//
// Domain extraction is deliberately NOT reimplemented here: hostFromUrlLike/
// registrableDomain/FREE_MAIL_DOMAINS are reused UNCHANGED from
// cross-source-validator.ts, the existing single source of truth for this
// logic elsewhere in the codebase (contact-domain-coherence checks etc).
//
// Not to be confused with src/services/marketing-dedupe.ts's dedupeByEmail —
// that is the unrelated RFB marketing-pool dedupe (views/rating tiebreak,
// different domain). Same "pure function + own test file" style is the
// precedent followed here, not the code itself.

import { hostFromUrlLike, registrableDomain, FREE_MAIL_DOMAINS } from "./cross-source-validator";

export interface GardssalgOutreachRecipientCandidate {
  provider_id: string;
  email: string | null;
}

export type GardssalgOutreachSuppressionReason = "duplikat_epost" | "duplikat_epost_domene";

export interface GardssalgOutreachDedupeResult {
  /** provider_ids that are clear to receive outreach (not suppressed by this guard). */
  allowed: Set<string>;
  /** provider_id -> suppression reason, for ids downgraded by this guard. */
  suppressed: Map<string, GardssalgOutreachSuppressionReason>;
}

/**
 * Dedupe a batch of outreach recipient candidates by exact email and by
 * shared non-freemail registrable email domain. First-seen-in-order wins;
 * later candidates colliding with an earlier one are suppressed.
 *
 * - Empty/null email: always allowed, never a dedup source or target (it
 *   cannot collide with anything and is never itself suppressed by this
 *   function — the caller's own "has_email" gating already excludes these
 *   from an outreach_ready tier upstream).
 * - Exact same email (lowercased/trimmed) seen already -> suppressed,
 *   reason "duplikat_epost".
 * - Otherwise, derive the email's registrable domain via hostFromUrlLike +
 *   registrableDomain. If that domain is NOT in FREE_MAIL_DOMAINS and the
 *   SAME registrable domain was already seen from a DIFFERENT email ->
 *   suppressed, reason "duplikat_epost_domene". Free-mail domains (gmail.com,
 *   online.no, etc.) are explicitly exempt from this domain rule — only the
 *   exact-email rule above applies to them.
 */
export function dedupeGardssalgOutreachRecipients(
  candidates: GardssalgOutreachRecipientCandidate[],
): GardssalgOutreachDedupeResult {
  const allowed = new Set<string>();
  const suppressed = new Map<string, GardssalgOutreachSuppressionReason>();

  const seenEmails = new Set<string>();
  const seenDomains = new Set<string>();

  for (const { provider_id, email } of candidates) {
    const normalizedEmail = (email ?? "").trim().toLowerCase();
    if (!normalizedEmail) {
      allowed.add(provider_id);
      continue;
    }

    if (seenEmails.has(normalizedEmail)) {
      suppressed.set(provider_id, "duplikat_epost");
      continue;
    }

    // Malformed epost values (enrichment-sourced, can contain garbage) with
    // no "@" at all have no derivable domain — mirrors hostFromEmail's
    // `!raw.includes("@")` guard in cross-source-validator.ts. Without this,
    // "example.com".split("@").pop() returns "example.com" itself, which
    // would then be treated as a real domain and could false-positive
    // collide with an unrelated provider's genuine info@example.com.
    const emailDomainPart = normalizedEmail.includes("@") ? normalizedEmail.split("@").pop() ?? "" : "";
    const host = emailDomainPart ? hostFromUrlLike(emailDomainPart) : null;
    const domain = host ? registrableDomain(host) : null;
    const isFreeMail = !!domain && FREE_MAIL_DOMAINS.includes(domain);

    if (domain && !isFreeMail && seenDomains.has(domain)) {
      suppressed.set(provider_id, "duplikat_epost_domene");
      continue;
    }

    seenEmails.add(normalizedEmail);
    if (domain && !isFreeMail) seenDomains.add(domain);
    allowed.add(provider_id);
  }

  return { allowed, suppressed };
}
