// ─── Gårdssalg producer owner-claim — dev-request 2026-07-21-opplevagent-
// claim-flyt-drikkeprodusenter ────────────────────────────────────────────
//
// Producer owner-claim flow for gårdssalg (drikkeprodusent) profiles on
// opplevagent.no. REUSES the RFB rettfrabonden.com owner-portal PATTERN
// (magic link -> verified session -> owner-editable profile,
// src/routes/owner-portal.ts / src/database/init.ts's magic_links table) —
// it does NOT modify RFB's flow, and does NOT invent a new identity
// mechanism. The claim table (gardssalg_claims) is a vertical-scoped MIRROR
// of magic_links, living in experiences.db (see init-experiences.ts's doc
// comment on that table for why a shared/cross-DB table wasn't an option).
//
// ─── Core requirement: verified ownership BEFORE claim (Daniel, 2026-07-21) ──
// The claim link is sent ONLY to an email address that provably belongs to
// the organisation:
//   (a) the Brreg-registered contact email for that org_nr, or
//   (b) an address on the producer's already ownership-verified website
//       domain (post@<verified-domain>).
// If neither exists, there is NO self-service claim path — only the manual
// fallback (Daniel verifies personally via kontakt@opplevagent.no).
//
// IMPORTANT, VERIFIED FINDING (read directly against the code, not assumed):
// path (a) is DORMANT in this codebase today. Brreg's Enhetsregisteret API —
// the ONLY Brreg integration this repo has (src/services/experience-brreg.ts,
// src/services/brreg-client.ts) — never returns a contact-email field for an
// "enhet" at all (see BrregEntity in experience-brreg.ts and RawBrregEntity in
// brreg-client.ts: organisasjonsnummer/navn/adresser/naeringskode/aktiv-flags
// only, no epost anywhere). experience_providers.epost is populated from
// homepage-crawl content or copied from an RFB producer's agent_knowledge
// .email (gardssalg-rfb-enrich.ts) — i.e. SCRAPED/imported data, not a
// Brreg-sourced, provably-org-linked address, so it is deliberately NOT used
// as a claim target. deriveOrgLinkedEmail() below still has a (currently
// always-empty) slot for a real Brreg contact email, so this dormant path
// activates for free the day a Brreg (or Frivillighetsregisteret/other
// authoritative) contact-email source is ever wired in — but until then,
// every real claim in this codebase resolves via path (b).
//
// Path (b) — "ownership-verified website domain" — also needed a concrete
// definition, since experience_providers.hjemmeside is populated from several
// sources of VERY different trust levels (rfb-seed copy, raw homepage-crawl
// guesses, admin-approved evidence-checked discovery, Daniel's own manual
// entry). Treating a bare, unvetted hjemmeside value as "ownership-verified"
// would repeat the exact "wrong producer's info on a page" harm Daniel has
// already forbidden elsewhere in this codebase (see gardssalg-rfb-enrich.ts's
// GENERIC_DOMAINS collision-safety discussion). So "ownership-verified" here
// means the domain reached experience_providers.hjemmeside via a path that
// was ALREADY evidence-checked + human-approved:
//   - content_source = 'manual' (Daniel personally entered/verified the row,
//     including its hjemmeside), OR
//   - field_provenance.hjemmeside.source_url is set — stamped ONLY by
//     applyGardssalgProviderWebsite() (experience-store.ts), which is called
//     ONLY from the two admin-approve endpoints
//     (POST /admin/gardssalg-website-review-approve,
//      POST /admin/listing-homepage-review-approve) after their queues'
//     evidence check (fetched page carries the provider's org_nr or exact
//     name + kommune/poststed) AND an explicit admin approval. This
//     provenance marker persists on the provider row even after the review-
//     queue entry itself is cleared on approval, so it's durably queryable
//     here.
// A raw/unvetted hjemmeside (content_source NULL/'provider_site', no
// field_provenance.hjemmeside) is NOT treated as verified — those providers
// fall to the manual-fallback path, same as a provider with no domain at all.
//
// Additional integrity gate (not literally required by the two bullets
// above, but a deliberate, documented judgment call): EVERY claim path also
// requires brreg_verified = 1 (a confident, active Brreg match) as a
// baseline. "Provably belongs to the organisation" presupposes the
// organisation itself is confirmed real and active — a provider that isn't
// even Brreg-verified has no confirmed legal-entity identity to claim
// against, regardless of which email path would otherwise apply.

import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../database/db-factory";
import { normalizeDomain } from "./blocklist-service";

const VERTICAL = "experiences";

export const CLAIM_MAGIC_LINK_VALID_HOURS = 7 * 24; // 7 days — matches RFB
export const CLAIM_RATE_LIMIT_WINDOW_HOURS = 1;
export const CLAIM_RATE_LIMIT_MAX_PER_WINDOW = 3; // matches RFB

export const GARDSSALG_OWNER_SESSION_COOKIE = "oa_owner_session";

// Manual-fallback contact — Daniel verifies personally. Matches the existing
// opplevagent.no ToS convention ("Oppdater, fjern eller overta din oppføring
// via kontakt@opplevagent.no", src/routes/experiences-seo.ts) rather than
// RFB's kontakt@rettfrabonden.com — this is the opplevagent vertical.
export const CLAIM_MANUAL_FALLBACK_EMAIL = "kontakt@opplevagent.no";

// ── Provider row shape needed for claim-eligibility + the portal ──────────
export interface ClaimProviderRow {
  id: string;
  navn: string;
  slug: string | null;
  org_nr: string | null;
  brreg_verified: number | null;
  hjemmeside: string | null;
  content_source: string | null;
  field_provenance: string | null;
  about_text: string | null;
  visit_text: string | null;
  opening_hours_text: string | null;
  products: string | null;
  booking_live: number | null;
  epost: string | null;
}

const CLAIM_PROVIDER_COLUMNS =
  "id, navn, slug, org_nr, brreg_verified, hjemmeside, content_source, field_provenance, about_text, visit_text, opening_hours_text, products, booking_live, epost";

export function getClaimProviderById(providerId: string): ClaimProviderRow | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT ${CLAIM_PROVIDER_COLUMNS} FROM experience_providers WHERE id = ?`)
    .get(providerId) as ClaimProviderRow | undefined;
  return row ?? null;
}

export function getClaimProviderBySlug(slug: string): ClaimProviderRow | null {
  if (!slug) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT ${CLAIM_PROVIDER_COLUMNS} FROM experience_providers WHERE slug = ?`)
    .get(slug) as ClaimProviderRow | undefined;
  return row ?? null;
}

// ── Ownership-verified-domain check (see module doc above) ───────────────
export function isHjemmesideOwnershipVerified(row: Pick<ClaimProviderRow, "content_source" | "field_provenance">): boolean {
  if (row.content_source === "manual") return true;
  if (!row.field_provenance) return false;
  try {
    const parsed = JSON.parse(row.field_provenance);
    return !!(
      parsed &&
      typeof parsed === "object" &&
      parsed.hjemmeside &&
      typeof parsed.hjemmeside === "object" &&
      typeof parsed.hjemmeside.source_url === "string" &&
      parsed.hjemmeside.source_url.trim().length > 0
    );
  } catch {
    return false;
  }
}

export type OrgLinkedEmailResult =
  | { eligible: true; email: string; source: "brreg_contact" | "verified_domain_address" }
  | { eligible: false; reason: "not_brreg_verified" | "no_org_linked_email" };

/**
 * Derive the ONE email address a claim magic-link may be sent to, or
 * "not eligible" (-> manual fallback, never self-service). Pure function —
 * no DB/IO — so the decision logic is fully unit-testable without a fixture
 * database. See module doc for the full rationale of both branches.
 *
 * brregContactEmail is an explicit, separate parameter (not read off the
 * provider row) because no such column/source exists yet anywhere in this
 * codebase (see module doc) — always undefined/null in production today.
 * The parameter exists so this function is ready the day a real source
 * shows up, without a signature change and without ever fabricating a value
 * meanwhile.
 */
export function deriveOrgLinkedEmail(
  provider: Pick<ClaimProviderRow, "org_nr" | "brreg_verified" | "hjemmeside" | "content_source" | "field_provenance">,
  brregContactEmail?: string | null,
): OrgLinkedEmailResult {
  const brregOk = !!provider.org_nr && provider.brreg_verified === 1;
  if (!brregOk) return { eligible: false, reason: "not_brreg_verified" };

  // (a) Brreg-registered contact email — dormant today (see module doc).
  const contact = (brregContactEmail || "").trim().toLowerCase();
  if (contact && contact.includes("@")) {
    return { eligible: true, email: contact, source: "brreg_contact" };
  }

  // (b) post@<ownership-verified-domain>. Deliberately NOT the (possibly
  // scraped/unverified) experience_providers.epost — the domain itself is
  // the thing we've verified, so the well-known "post@" convention address
  // on it is the only address we can send to without trusting scraped data.
  if (isHjemmesideOwnershipVerified(provider)) {
    const domain = normalizeDomain(provider.hjemmeside);
    if (domain && domain.includes(".")) {
      return { eligible: true, email: `post@${domain}`, source: "verified_domain_address" };
    }
  }

  return { eligible: false, reason: "no_org_linked_email" };
}

/** Mask an email for display ("we sent it to p***t@b*******t.no") — never
 * reveal the full address on the unauthenticated entry page. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  const maskPart = (s: string, keepEnd: boolean): string => {
    if (s.length <= 1) return s + "*";
    if (s.length === 2) return keepEnd ? s[0] + "*" : s[0] + "*";
    const stars = "*".repeat(Math.min(s.length - 2, 6));
    return keepEnd ? `${s[0]}${stars}${s[s.length - 1]}` : `${s[0]}${stars}`;
  };

  const dotIdx = domain.lastIndexOf(".");
  let maskedDomain: string;
  if (dotIdx > 0) {
    const name = domain.slice(0, dotIdx);
    const tld = domain.slice(dotIdx); // includes leading "."
    maskedDomain = `${maskPart(name, false)}${tld}`;
  } else {
    maskedDomain = maskPart(domain, false);
  }

  return `${maskPart(local, true)}@${maskedDomain}`;
}

// ── Rate limiting ─────────────────────────────────────────────────────────
export function isClaimRateLimited(providerId: string): boolean {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM gardssalg_claims
       WHERE provider_id = ? AND created_at >= datetime('now', '-' || ? || ' hours')`,
    )
    .get(providerId, CLAIM_RATE_LIMIT_WINDOW_HOURS) as { count: number };
  return row.count >= CLAIM_RATE_LIMIT_MAX_PER_WINDOW;
}

// ── Issue a claim magic link (DB insert only — sending the email is the
// route layer's job, via email-service.ts, mirroring RFB's split) ─────────
export interface IssuedClaim {
  claimId: string;
  token: string;
  email: string;
  maskedEmail: string;
  source: "brreg_contact" | "verified_domain_address";
  expiresAt: string;
}

export type IssueClaimResult =
  | { ok: true; claim: IssuedClaim }
  | { ok: false; error: "provider_not_found" | "not_brreg_verified" | "no_org_linked_email" | "rate_limited" };

export function issueClaimMagicLink(providerId: string, brregContactEmail?: string | null): IssueClaimResult {
  const provider = getClaimProviderById(providerId);
  if (!provider) return { ok: false, error: "provider_not_found" };

  const derived = deriveOrgLinkedEmail(provider, brregContactEmail);
  if (!derived.eligible) return { ok: false, error: derived.reason };

  if (isClaimRateLimited(providerId)) return { ok: false, error: "rate_limited" };

  const db = getDb(VERTICAL);
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CLAIM_MAGIC_LINK_VALID_HOURS * 60 * 60 * 1000);
  const claimId = `gsc_${crypto.randomBytes(8).toString("hex")}`;

  db.prepare(
    `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(claimId, providerId, derived.email, derived.source, token, now.toISOString(), expiresAt.toISOString());

  return {
    ok: true,
    claim: {
      claimId,
      token,
      email: derived.email,
      maskedEmail: maskEmail(derived.email),
      source: derived.source,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

// ── Verify a magic-link token -> mark used, stamp the claim lock ─────────
export interface VerifyClaimResult {
  valid: boolean;
  providerId?: string;
  token?: string;
}

/**
 * Marks the token used and — the acceptance-critical write — sets
 * experience_providers.content_source = 'claim' so every enrichment/
 * retro-scan write-path (which already gates on content_source IN
 * ('manual','claim'), verified across experience-store.ts /
 * gardssalg-rfb-enrich.ts) skips this row from here on. Never downgrades an
 * existing 'manual' lock (Daniel's own curation takes precedence) — the
 * session is still granted either way, only the lock label is left alone.
 */
export function verifyClaimToken(token: string): VerifyClaimResult {
  const db = getDb(VERTICAL);
  const claim = db
    .prepare(
      `SELECT id, provider_id, token FROM gardssalg_claims
       WHERE token = ? AND expires_at > datetime('now') AND revoked_at IS NULL`,
    )
    .get(token) as { id: string; provider_id: string; token: string } | undefined;

  if (!claim) return { valid: false };

  const txn = db.transaction(() => {
    db.prepare(`UPDATE gardssalg_claims SET used = 1, used_at = datetime('now') WHERE id = ?`).run(claim.id);
    db.prepare(
      `UPDATE experience_providers SET content_source = 'claim', updated_at = datetime('now')
       WHERE id = ? AND (content_source IS NULL OR content_source NOT IN ('manual', 'claim'))`,
    ).run(claim.provider_id);
  });
  txn();

  return { valid: true, providerId: claim.provider_id, token: claim.token };
}

// ── Session verification (cookie or Bearer, mirrors RFB's
// verifyOwnerSession) ─────────────────────────────────────────────────────
export interface OwnerSession {
  valid: boolean;
  providerId?: string;
  token?: string;
}

export function verifyGardssalgOwnerSessionToken(token: string | undefined | null): OwnerSession {
  if (!token) return { valid: false };
  const db = getDb(VERTICAL);
  const claim = db
    .prepare(
      `SELECT provider_id FROM gardssalg_claims
       WHERE token = ? AND used = 1 AND expires_at > datetime('now') AND revoked_at IS NULL`,
    )
    .get(token) as { provider_id: string } | undefined;
  if (!claim) return { valid: false };
  return { valid: true, providerId: claim.provider_id, token };
}

/** GDPR-minimum revoke: invalidates the session/token immediately (unlike
 * RFB's logout, which only clears the cookie — see init-experiences.ts's
 * doc comment on gardssalg_claims.revoked_at for why this is an intentional,
 * additive improvement scoped to THIS flow only). */
export function revokeClaimToken(token: string): void {
  if (!token) return;
  const db = getDb(VERTICAL);
  db.prepare(`UPDATE gardssalg_claims SET revoked_at = datetime('now') WHERE token = ? AND revoked_at IS NULL`).run(token);
}

// ── Owner profile update (session-authenticated writes) ──────────────────
export const CLAIM_EDITABLE_FIELDS = [
  "about_text",
  "visit_text",
  "opening_hours_text",
  "products",
  "hjemmeside",
  "booking_live",
] as const;
export type ClaimEditableField = (typeof CLAIM_EDITABLE_FIELDS)[number];

const TEXT_FIELD_MAX_LEN: Record<string, number> = {
  about_text: 2000,
  visit_text: 2000,
  opening_hours_text: 500,
};
const MAX_PRODUCTS = 50;
const MAX_PRODUCT_NAME_LEN = 100;

function sanitizeTextField(field: string, value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined; // reject wrong type — caller skips
  const trimmed = value.trim();
  const max = TEXT_FIELD_MAX_LEN[field] ?? 2000;
  return trimmed.slice(0, max);
}

function sanitizeProducts(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().slice(0, MAX_PRODUCT_NAME_LEN);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_PRODUCTS) break;
  }
  return JSON.stringify(out);
}

function sanitizeWebsite(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^https?:\/\/\S+\.\S+/i.test(trimmed) || trimmed.length > 2048) return undefined;
  return trimmed;
}

function sanitizeBookingLive(value: unknown): number | undefined {
  if (value === true || value === 1 || value === "1" || value === "true") return 1;
  if (value === false || value === 0 || value === "0" || value === "false") return 0;
  return undefined;
}

export interface UpdateProfileOutcome {
  ok: true;
  updatedFields: string[];
  skippedFields: Array<{ field: string; reason: string }>;
}

/**
 * Owner (session-authenticated) profile write. Unlike the auto-enrichment
 * write-paths in experience-store.ts (fill-only, gated on content_source NOT
 * IN ('manual','claim')), the OWNER is allowed to REPLACE any of their own
 * whitelisted fields freely — that's the entire point of the claim. The only
 * thing that still blocks a write is content_source = 'manual': a row Daniel
 * personally curated takes precedence over the claiming owner, mirroring
 * RFB's "locked_by_X, X != owner" rule in owner-portal.ts (skipped, not
 * silently dropped — same response shape: {field, reason}).
 */
export function updateClaimedProviderProfile(
  providerId: string,
  body: Record<string, unknown>,
): UpdateProfileOutcome | { ok: false; error: "provider_not_found" } {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT id, content_source FROM experience_providers WHERE id = ?`)
    .get(providerId) as { id: string; content_source: string | null } | undefined;
  if (!row) return { ok: false, error: "provider_not_found" };

  const locked = row.content_source === "manual";

  const sets: string[] = [];
  const params: Record<string, unknown> = { id: providerId };
  const updatedFields: string[] = [];
  const skippedFields: Array<{ field: string; reason: string }> = [];

  for (const field of CLAIM_EDITABLE_FIELDS) {
    if (!(field in body)) continue;
    if (locked) {
      skippedFields.push({ field, reason: "locked_by_manual" });
      continue;
    }
    let sanitized: unknown;
    if (field === "products") sanitized = sanitizeProducts(body[field]);
    else if (field === "hjemmeside") sanitized = sanitizeWebsite(body[field]);
    else if (field === "booking_live") sanitized = sanitizeBookingLive(body[field]);
    else sanitized = sanitizeTextField(field, body[field]);

    if (sanitized === undefined) {
      skippedFields.push({ field, reason: "invalid_value" });
      continue;
    }
    sets.push(`${field} = @${field}`);
    params[field] = sanitized;
    updatedFields.push(field);
  }

  if (sets.length > 0) {
    const txn = db.transaction(() => {
      db.prepare(
        `UPDATE experience_providers SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = @id`,
      ).run(params);
      // Audit trail — reuses gardssalg_content_audit (same shape RFB's
      // agent_knowledge_audit serves for owner-portal.ts), changed_by='owner'.
      // booking_live is a producer-consent toggle, not "content" — audited
      // too (same table, batch_id marks the source) for a complete change
      // history, but never blocked by the content_source lock above.
      for (const field of updatedFields) {
        db.prepare(
          `INSERT INTO gardssalg_content_audit (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
           VALUES (?, ?, ?, NULL, ?, NULL, 'owner-portal', 'owner', datetime('now'))`,
        ).run(uuid(), providerId, field, String(params[field]));
      }
    });
    txn();
  }

  return { ok: true, updatedFields, skippedFields };
}
