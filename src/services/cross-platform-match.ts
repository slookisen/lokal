// ─── cross-platform-match.ts — "same producer?" across RFB and Opplevagent ──
//
// dev-request 2026-10-08-kryssplattform-karantene-produsent-og-domene.
// The cold-outreach cooldown between the two platforms used to compare the
// full e-mail address only, so a producer holding two addresses (Druehagen:
// eventer@ and post@) was mailed by both platforms inside the window. This
// module is the ONE place that decides whether two send targets are the same
// producer; every caller (RFB gate, pool-blocker-explain, Opplevagent
// candidates and send eligibility) uses it instead of its own comparison.
//
// A prior send in the other lane blocks a new one when ANY of these hold,
// reported as `match` in this priority order:
//   1. email    — same full address (case-insensitive)
//   2. domain   — same e-mail domain, unless that domain is a free-mail /
//                 consumer-ISP domain (FREE_MAIL_DOMAINS): two unrelated
//                 gmail.com mailboxes must never block each other
//   3. website  — same website host (www. stripped), unless the host is a
//                 shared platform (social media, search, ...)
//   4. org_nr   — same 9-digit organisation number, both sides having one
//
// Pure functions, no I/O. Normalisation only; nothing here writes data.

import { FREE_MAIL_DOMAINS } from "./recipient-policy";

export type CrossPlatformMatch = "email" | "domain" | "website" | "org_nr";

export interface CrossPlatformIdentity {
  /** Lowercased, trimmed full address, or null. */
  email: string | null;
  /** Lowercased e-mail domain, null for free-mail / malformed addresses. */
  emailDomain: string | null;
  /** Lowercased website host without `www.`, null when absent / unusable. */
  website: string | null;
  /** 9-digit org number, null when absent / malformed. */
  orgNr: string | null;
}

/**
 * Hosts that are shared by many unrelated businesses. A match on one of these
 * says nothing about "same producer", so they never count as a website match.
 */
const SHARED_WEBSITE_HOSTS: ReadonlySet<string> = new Set([
  "facebook.com",
  "fb.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "tiktok.com",
  "google.com",
  "goo.gl",
  "linktr.ee",
  "wixsite.com",
  "business.site",
  "godaddysites.com",
  "squarespace.com",
  "wordpress.com",
  "blogspot.com",
  "yelp.com",
  "tripadvisor.com",
  "tripadvisor.no",
  "finn.no",
  "gulesider.no",
  "proff.no",
  "1881.no",
  "brreg.no",
  "bondensmarked.no",
  "hanen.no",
  "matmerk.no",
]);

export function normalizeEmailForMatch(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v || v.indexOf("@") <= 0) return null;
  return v;
}

/** E-mail domain usable for matching; null for free-mail or malformed. */
export function emailDomainForMatch(value: unknown): string | null {
  const email = normalizeEmailForMatch(value);
  if (!email) return null;
  const at = email.lastIndexOf("@");
  const domain = email.slice(at + 1).trim().replace(/^www\./, "");
  if (!domain || domain.indexOf(".") < 0) return null;
  if (FREE_MAIL_DOMAINS.has(domain)) return null;
  return domain;
}

/** Website host without scheme / www. / port / path; null when unusable. */
export function websiteDomainForMatch(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(v)) v = "https://" + v;
  let host: string;
  try {
    host = new URL(v).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  if (!host || host.indexOf(".") < 0) return null;
  if (SHARED_WEBSITE_HOSTS.has(host)) return null;
  for (const shared of SHARED_WEBSITE_HOSTS) {
    if (host.endsWith("." + shared)) return null;
  }
  return host;
}

/** Norwegian org number: exactly 9 digits after stripping spaces / `NO` / `MVA`. */
export function normalizeOrgNrForMatch(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/\s+/g, "").replace(/^no/i, "").replace(/mva$/i, "");
  return /^\d{9}$/.test(digits) ? digits : null;
}

export function buildCrossPlatformIdentity(input: {
  email?: unknown;
  website?: unknown;
  orgNr?: unknown;
}): CrossPlatformIdentity {
  return {
    email: normalizeEmailForMatch(input.email),
    emailDomain: emailDomainForMatch(input.email),
    website: websiteDomainForMatch(input.website),
    orgNr: normalizeOrgNrForMatch(input.orgNr),
  };
}

/** The strongest rule on which two identities are the same producer, or null. */
export function matchCrossPlatformIdentity(
  a: CrossPlatformIdentity,
  b: CrossPlatformIdentity,
): CrossPlatformMatch | null {
  if (a.email && b.email && a.email === b.email) return "email";
  if (a.emailDomain && b.emailDomain && a.emailDomain === b.emailDomain) return "domain";
  if (a.website && b.website && a.website === b.website) return "website";
  if (a.orgNr && b.orgNr && a.orgNr === b.orgNr) return "org_nr";
  return null;
}

/**
 * Lookup structure over prior sends. `add` indexes a send under every
 * identity key it has; `find` returns the payload of the most recent send
 * that matches, with the strongest matching rule.
 */
export class CrossPlatformIndex<T extends { last_sent_at: string }> {
  private readonly byEmail = new Map<string, T>();
  private readonly byDomain = new Map<string, T>();
  private readonly byWebsite = new Map<string, T>();
  private readonly byOrgNr = new Map<string, T>();

  private static put<V extends { last_sent_at: string }>(m: Map<string, V>, key: string | null, v: V): void {
    if (!key) return;
    const prev = m.get(key);
    if (!prev || v.last_sent_at > prev.last_sent_at) m.set(key, v);
  }

  /**
   * `keys` limits which identity keys the send is indexed under (default all).
   * Used to keep a send from matching on a rule it was not meant to feed.
   */
  add(identity: CrossPlatformIdentity, payload: T, keys?: ReadonlyArray<CrossPlatformMatch>): void {
    const use = (k: CrossPlatformMatch) => !keys || keys.includes(k);
    if (use("email")) CrossPlatformIndex.put(this.byEmail, identity.email, payload);
    if (use("domain")) CrossPlatformIndex.put(this.byDomain, identity.emailDomain, payload);
    if (use("website")) CrossPlatformIndex.put(this.byWebsite, identity.website, payload);
    if (use("org_nr")) CrossPlatformIndex.put(this.byOrgNr, identity.orgNr, payload);
  }

  find(identity: CrossPlatformIdentity): { match: CrossPlatformMatch; hit: T } | undefined {
    let hit: T | undefined;
    if (identity.email && (hit = this.byEmail.get(identity.email))) return { match: "email", hit };
    if (identity.emailDomain && (hit = this.byDomain.get(identity.emailDomain))) return { match: "domain", hit };
    if (identity.website && (hit = this.byWebsite.get(identity.website))) return { match: "website", hit };
    if (identity.orgNr && (hit = this.byOrgNr.get(identity.orgNr))) return { match: "org_nr", hit };
    return undefined;
  }

  get size(): number {
    return this.byEmail.size + this.byDomain.size + this.byWebsite.size + this.byOrgNr.size;
  }
}
