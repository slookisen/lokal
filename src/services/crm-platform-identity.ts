// ─── CRM outbound platform identity ─────────────────────────────────
//
// dev-requests/2026-07-27-crm-plattformadskillelse-opplevagent.md, steg 3.
//
// Funn 2, observed live in Daniel's own Gmail on 18 July (booking
// GARD-20260718-C5EEN):
//
//     From:    kontakt@rettfrabonden.com
//     Subject: Ny reservasjon — GARD-20260718-C5EEN
//     Body:    "Du har fått en ny reservasjonsforespørsel via Opplevagent:"
//
// A gårdssalg producer receiving a booking notice today gets it from Rett fra
// Bonden, carrying Opplevagent content. Not a theoretical leak — observable in
// production.
//
// ── WHY THE ADDRESS DOES NOT CHANGE ─────────────────────────────────
//
// Resend's free plan verifies exactly ONE domain, and rettfrabonden.com is it.
// Daniel decided 2026-07-27 not to buy out of that. So the sender ADDRESS stays
// kontakt@rettfrabonden.com for every platform, and the separation lives in the
// two fields Resend does not constrain:
//
//   • DISPLAY NAME — `"Opplevagent" <kontakt@rettfrabonden.com>`. This is what
//     the recipient actually reads in their inbox list; the address is fine
//     print. Honest, not impersonation: it IS the same company.
//   • REPLY-TO — kontakt@opplevagent.no for experiences. This is also what
//     PRESERVES the inbound discriminator: replies arrive through the
//     Opplevagent forwarder (ImprovMX) rather than the RFB one (AWS SES), which
//     is the signal steg 4 sorts on. Without it the whole separation collapses
//     on the return path (funn 4).
//
// Both are per-vertical and live HERE, in one table, so that switching to a
// dedicated sender domain later — if the Resend plan is ever upgraded — is a
// config change rather than another sweep through the call sites.
//
// ── FAIL-CLOSED ─────────────────────────────────────────────────────
//
// A vertical with no configured identity REFUSES to send. It never quietly
// falls back on the RFB identity, because that silent fallback is precisely
// the mechanism behind funn 2: an email went out branded as the wrong platform
// and nothing anywhere reported a problem.

import { CrmVertical, assertVertical } from "./crm-service";

export interface CrmPlatformIdentity {
  /** Shown in the recipient's inbox list — the part that reads as the brand. */
  displayName: string;
  /** Where a reply lands. Also the inbound platform discriminator (steg 4). */
  replyTo: string;
}

/**
 * The single source of truth. One entry per vertical, no defaults, no merge
 * with a "base" identity — a missing entry must be a missing entry, not a
 * half-inherited one.
 */
const CRM_PLATFORM_IDENTITIES: Readonly<Record<CrmVertical, CrmPlatformIdentity>> = {
  rfb: {
    displayName: "Rett fra Bonden",
    replyTo: "kontakt@rettfrabonden.com",
  },
  experiences: {
    // Daniel confirmed the ImprovMX alias for kontakt@opplevagent.no is live
    // (2026-07-28). Before that it was a possible black hole — every
    // opplevagent reply-to had nowhere to land (funn 3). The DNS check that
    // established this: opplevagent.no MX = mx1/mx2.improvmx.com, forwarding to
    // the same Gmail as RFB. Deliberately NOT Cloudflare Email Routing, which
    // would have required moving the whole zone off subsys.no.
    displayName: "Opplevagent",
    replyTo: "kontakt@opplevagent.no",
  },
  dental: {
    displayName: "Finn Tannlege",
    // finn-tannlege.com has no inbound forwarder configured. Pointing reply-to
    // at an address that does not receive would recreate funn 3 on a third
    // platform, so this deliberately routes to the address that DOES work.
    // Revisit when the domain gets its own alias.
    replyTo: "kontakt@rettfrabonden.com",
  },
};

/**
 * Test seam. Returns the LIVE table so a test can drive crmFromHeader with a
 * display name we do not ship — the escaping rule has to be provable without
 * inventing a producer called `Bonde "Ola" Nordmann`. Restore what you change.
 */
export function __identityTableForTesting(): Record<CrmVertical, CrmPlatformIdentity> {
  return CRM_PLATFORM_IDENTITIES as Record<CrmVertical, CrmPlatformIdentity>;
}

/** The one address Resend has verified. Every platform sends FROM this. */
export const CRM_SENDER_ADDRESS = "kontakt@rettfrabonden.com";

/**
 * Resolve the outbound identity for a platform, or THROW.
 *
 * Throwing is the feature. The alternative — returning the RFB identity for an
 * unknown vertical — is how an Opplevagent booking notice went out branded as
 * Rett fra Bonden for weeks without anyone noticing.
 */
export function resolveCrmIdentity(vertical: unknown): CrmPlatformIdentity {
  const v = assertVertical(vertical, "resolveCrmIdentity");
  const identity = CRM_PLATFORM_IDENTITIES[v];
  if (!identity || !identity.displayName || !identity.replyTo) {
    throw new Error(
      `[crm-identity] vertical ${JSON.stringify(v)} has no configured outbound identity ` +
        `(needs displayName + replyTo). Refusing to send rather than fall back on the ` +
        `Rett fra Bonden identity — a wrongly-branded email is the bug this guards.`,
    );
  }
  return identity;
}

/**
 * RFC 5322 display-name form: `"Opplevagent" <kontakt@rettfrabonden.com>`.
 *
 * The name is quoted and any embedded quote or backslash escaped. These names
 * are ours and contain neither today, but an unescaped display name is a header
 * that a future name like `Bonde "Ola" Nordmann` would silently corrupt — and a
 * malformed From is a deliverability problem, not a cosmetic one.
 */
export function crmFromHeader(vertical: unknown): string {
  const { displayName } = resolveCrmIdentity(vertical);
  const escaped = displayName.replace(/([\\"])/g, "\\$1");
  return `"${escaped}" <${CRM_SENDER_ADDRESS}>`;
}
