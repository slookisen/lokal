// ─── Gårdssalg RFB-knowledge enrichment (dev-request gardssalg-rike-profiler,
//     RFB-knowledge slice, 2026-07-12, Daniel) ────────────────────────────────
//
// The opplevagent "Gårdssalg & smaking" providers (experience_providers rows in
// experiences.db) were seeded from RFB by name/url/city ONLY — their rich detail
// (about/address/phone/products/geo) was never copied, so the produsent pages
// render sparse. This module re-matches a seeded provider back to its RFB
// producer (agents + agent_knowledge in lokal.db) and picks which fields are
// SAFE to copy over.
//
// Daniel's rules (2026-07-12):
//   • Strict matching — copy only on a WEBSITE-DOMAIN match (the strongest
//     signal; producer name is fuzzy and org_nr isn't stored). Name-only is
//     flagged for manual review, never auto-copied.
//   • Never carry over "dårlig/usikker" data — skip placeholder/invalid values
//     and inference-only factual fields.
//   • Respect the existing content_source lock: 'manual'/'claim' rows are
//     human/owner-authored and never auto-overwritten.
//   • Fill only fields the provider is MISSING (never clobber existing data).
//
// This file is PURE (no DB/IO) so it is unit-testable; the route wires it to the
// two DBs and does the dry-run/apply write.

import { normalizeDomain, normalizeName } from "./blocklist-service";
import { isDisplayablePhone } from "./contact-normalizer";
import { isJunkDescription } from "./description-quality";

/** Minimal shape of the seeded gårdssalg provider row we may enrich. */
export interface EnrichProviderRow {
  id: string;
  navn: string;
  hjemmeside: string | null;
  adresse: string | null;
  telefon: string | null;
  epost: string | null;
  lat: number | null;
  lon: number | null;
  about_text: string | null;
  products: string | null;
  content_source: string | null;
}

/** Minimal shape of the RFB source (agents + agent_knowledge joined). */
export interface RfbSource {
  agent_id: string;
  name: string;
  url: string | null;            // agents.url / agent_knowledge.website
  lat: number | null;            // agents.lat
  lng: number | null;            // agents.lng
  about: string | null;          // agent_knowledge.about
  address: string | null;        // agent_knowledge.address
  phone: string | null;          // agent_knowledge.phone
  email: string | null;          // agent_knowledge.email
  products: string | null;       // agent_knowledge.products (JSON)
  verification_review_reason: string | null; // inference_only_fields signal
}

export interface EnrichResult {
  provider_id: string;
  navn: string;
  status: "would_enrich" | "locked" | "no_domain" | "no_match" | "nothing_to_fill";
  matched_rfb?: { agent_id: string; name: string; domain: string };
  // How the RFB producer was matched: 'domain' (strict website match — strongest)
  // or 'name' (exact normalized-name via the rfb-seed provenance — the seed was
  // name-based, so an exact-name hit is reliable recovery, not fuzzy matching).
  matched_by?: "domain" | "name";
  copy: Record<string, string | number>;      // field → value that WOULD be written
  skipped: Array<{ field: string; reason: string }>;
}

// Emails that are obviously placeholders / non-contactable — never copy these.
const JUNK_EMAIL_PATTERNS = [
  "@domain.com",   // user@domain.com / post@domain.com placeholders (not real *domain.com)
  "@example.",
  "example.com",
  "example.org",
  "test@test",
  "noreply@",
  "no-reply@",
  "your@email",
  "email@email",
];
export function isJunkEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const e = email.trim().toLowerCase();
  if (!e || !e.includes("@") || e.length < 5) return true;
  if (e.includes(" ")) return true;
  return JUNK_EMAIL_PATTERNS.some((p) => e.includes(p));
}

// A light address sanity gate (the address field's counterpart to isJunkEmail /
// isJunkDescription). Real Norwegian street addresses carry a number and/or a
// postal code; the junk cases are short filler like "Norge" / "Se hjemmeside".
export function isJunkAddress(addr: string | null | undefined): boolean {
  if (!addr) return true;
  const a = addr.trim();
  if (a.length < 6) return true;
  const low = a.toLowerCase();
  const junkPhrases = ["se hjemmeside", "se nettside", "ukjent", "n/a", "norge", "ikke oppgitt", "kommer snart"];
  return junkPhrases.some((p) => low === p || low.includes(p));
}

// Which factual fields did the RFB verifier flag as inference-only (fabricated
// guesswork)? Same signal the outreach gate uses (agent_knowledge
// .verification_review_reason.inference_only_fields). Defensive: absent/malformed
// → empty set (nothing skipped for this reason).
function inferenceOnlyFields(verificationReviewReasonJson: string | null): Set<string> {
  const out = new Set<string>();
  if (!verificationReviewReasonJson) return out;
  try {
    const parsed = JSON.parse(verificationReviewReasonJson);
    const fields = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).inference_only_fields : null;
    if (Array.isArray(fields)) for (const f of fields) if (typeof f === "string") out.add(f);
  } catch {
    /* malformed → no inference flags */
  }
  return out;
}

/** Normalize a products JSON value to a de-duped list of non-empty names, or []. */
export function parseProductNames(productsJson: string | null | undefined): string[] {
  if (!productsJson) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(productsJson); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parsed) {
    const name = typeof p === "string"
      ? p
      : p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string"
      ? (p as { name: string }).name
      : "";
    const t = name.trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    if (out.length >= 50) break; // cap — never store an unbounded product blob
  }
  return out;
}

// Domains that are NOT a unique producer identity — a match on one of these is
// meaningless and would false-link two different producers (the wrong-producer-
// info-on-a-page harm Daniel called out). Covers our own domains, social /
// marketplace / map profiles, and free-site builders whose bare apex is shared
// across thousands of tenants. A provider or source whose only URL normalizes to
// one of these is treated as UN-matchable → flagged no_domain (manual review),
// never auto-copied. (Tenant subdomains like "gard.wixsite.com" survive
// normalizeDomain intact and stay distinct — only the bare shared apex is here.)
const GENERIC_DOMAINS: ReadonlySet<string> = new Set([
  "rettfrabonden.com", "opplevagent.no", "lokal.fly.dev",
  "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
  "youtube.com", "tiktok.com", "pinterest.com", "snapchat.com",
  "google.com", "maps.google.com", "goo.gl", "linktr.ee",
  "wixsite.com", "wix.com", "squarespace.com", "wordpress.com", "blogspot.com",
  "weebly.com", "webnode.no", "one.com", "gmail.com", "hotmail.com", "outlook.com",
]);

/** A domain we can safely use as a unique producer identity for matching. */
export function isMatchableDomain(domain: string): boolean {
  if (!domain) return false;
  if (!domain.includes(".")) return false;          // bare host, not a real domain
  if (GENERIC_DOMAINS.has(domain)) return false;     // shared/social/own — not identity
  return true;
}

/**
 * Build the domain→RFB-source index. A source with no resolvable OR non-matchable
 * (generic/shared) domain is omitted.
 *
 * COLLISION SAFETY: if two DIFFERENT active producers normalize to the SAME
 * domain (e.g. a shared free-host apex like sites.google.com that slips past the
 * generic list, an umbrella + member farms on one cooperative site, or duplicate
 * re-discovered agent rows), we do NOT pick an arbitrary winner — a first-wins
 * pick would silently attach the WRONG producer's address/phone to a page, the
 * exact harm Daniel forbade. Instead the colliding domain is made UN-matchable
 * (removed from the map), so every provider on it falls to no_match → manual
 * review. Same-agent duplicates (identical agent_id) are not treated as a
 * collision.
 */
export function indexRfbByDomain(sources: RfbSource[]): Map<string, RfbSource> {
  const map = new Map<string, RfbSource>();
  const collided = new Set<string>();
  for (const s of sources) {
    const d = normalizeDomain(s.url);
    if (!isMatchableDomain(d)) continue;
    const existing = map.get(d);
    if (existing) {
      if (existing.agent_id !== s.agent_id) collided.add(d); // two distinct producers → ambiguous
      continue;
    }
    map.set(d, s);
  }
  for (const d of collided) map.delete(d);
  return map;
}

/**
 * Build the normalized-name→RFB-source index used as the FALLBACK match when a
 * provider has no usable website domain. The opplevagent gårdssalg providers
 * were seeded from RFB by name (rfb-seed), so a provider's `navn` is the exact
 * name of its RFB agent — an exact normalized-name hit is reliable provenance
 * recovery, not fuzzy matching. Same collision safety as the domain index: if
 * two DIFFERENT producers normalize to the same name, that name is dropped
 * (un-matchable) so we never attach the wrong producer's info.
 */
export function indexRfbByName(sources: RfbSource[]): Map<string, RfbSource> {
  const map = new Map<string, RfbSource>();
  const collided = new Set<string>();
  for (const s of sources) {
    const n = normalizeName(s.name);
    if (!n) continue;
    const existing = map.get(n);
    if (existing) {
      if (existing.agent_id !== s.agent_id) collided.add(n);
      continue;
    }
    map.set(n, s);
  }
  for (const n of collided) map.delete(n);
  return map;
}

/**
 * Decide what to copy from RFB into a seeded gårdssalg provider. Pure.
 *   - Locked (content_source manual/claim) → status 'locked', copy {}.
 *   - No provider domain → 'no_domain' (flag for manual review).
 *   - No RFB source on that domain → 'no_match'.
 *   - Otherwise fill each MISSING provider field from a non-junk RFB value.
 */
export function pickEnrichmentFields(
  provider: EnrichProviderRow,
  byDomain: Map<string, RfbSource>,
  byName?: Map<string, RfbSource>,
): EnrichResult {
  const base: EnrichResult = { provider_id: provider.id, navn: provider.navn, status: "no_match", copy: {}, skipped: [] };

  // Lock: never overwrite human/owner-authored rows.
  if (provider.content_source === "manual" || provider.content_source === "claim") {
    return { ...base, status: "locked" };
  }

  // 1) Strict website-domain match (strongest signal).
  const providerDomain = normalizeDomain(provider.hjemmeside);
  const domainMatchable = isMatchableDomain(providerDomain);
  let src: RfbSource | undefined = domainMatchable ? byDomain.get(providerDomain) : undefined;
  let matchedBy: "domain" | "name" | undefined = src ? "domain" : undefined;

  // 2) Fallback: exact normalized-name match via the rfb-seed provenance.
  if (!src && byName) {
    const nm = normalizeName(provider.navn);
    const nsrc = nm ? byName.get(nm) : undefined;
    if (nsrc) { src = nsrc; matchedBy = "name"; }
  }

  if (!src) {
    // No domain to try AND no name hit → nothing to go on (no_domain); had a
    // usable domain/name but no RFB producer → no_match. Both need manual review.
    return { ...base, status: domainMatchable ? "no_match" : "no_domain" };
  }

  const inference = inferenceOnlyFields(src.verification_review_reason);
  const copy: Record<string, string | number> = {};
  const skipped: Array<{ field: string; reason: string }> = [];
  const isEmpty = (v: string | null): boolean => v === null || v.trim() === "";

  // about_text ← about (skip junk-description; 'about' is not a factual-inference field)
  if (isEmpty(provider.about_text)) {
    if (src.about && src.about.trim() && !isJunkDescription(src.about)) copy.about_text = src.about.trim();
    else if (src.about && src.about.trim()) skipped.push({ field: "about_text", reason: "junk_description" });
  }
  // adresse ← address (skip inference-only and junk/filler addresses)
  if (isEmpty(provider.adresse) && src.address && src.address.trim()) {
    if (inference.has("address")) skipped.push({ field: "adresse", reason: "inference_only" });
    else if (isJunkAddress(src.address)) skipped.push({ field: "adresse", reason: "junk_address" });
    else copy.adresse = src.address.trim();
  }
  // telefon ← phone (skip non-displayable / inference-only)
  if (isEmpty(provider.telefon) && src.phone && src.phone.trim()) {
    if (inference.has("phone")) skipped.push({ field: "telefon", reason: "inference_only" });
    else if (!isDisplayablePhone(src.phone)) skipped.push({ field: "telefon", reason: "not_displayable" });
    else copy.telefon = src.phone.trim();
  }
  // epost ← email (skip placeholders/invalid)
  if (isEmpty(provider.epost) && src.email && src.email.trim()) {
    if (isJunkEmail(src.email)) skipped.push({ field: "epost", reason: "junk_email" });
    else copy.epost = src.email.trim().toLowerCase();
  }
  // products ← products (skip inference-only; only if non-empty list)
  if (isEmpty(provider.products)) {
    const names = parseProductNames(src.products);
    if (names.length) {
      if (inference.has("products")) skipped.push({ field: "products", reason: "inference_only" });
      else copy.products = JSON.stringify(names);
    }
  }
  // lat/lon ← agents.lat/lng (only fill both together, when provider has none)
  if (provider.lat === null && provider.lon === null && src.lat !== null && src.lng !== null) {
    copy.lat = src.lat;
    copy.lon = src.lng;
  }
  // hjemmeside ← RFB producer's own site (mainly for NAME-matched rows, whose
  // provider hjemmeside is empty — that's why domain match missed them). Only a
  // real, matchable (non-generic) RFB domain is copied.
  const srcDomain = normalizeDomain(src.url);
  if (isEmpty(provider.hjemmeside) && src.url && src.url.trim() && isMatchableDomain(srcDomain)) {
    copy.hjemmeside = src.url.trim();
  }

  const status: EnrichResult["status"] = Object.keys(copy).length ? "would_enrich" : "nothing_to_fill";
  // matched_rfb.domain: the provider domain for a domain match, else the RFB
  // producer's own domain (name-matched rows have no provider domain).
  const matchDomain = matchedBy === "domain" ? providerDomain : srcDomain;
  return {
    provider_id: provider.id, navn: provider.navn, status, matched_by: matchedBy,
    matched_rfb: { agent_id: src.agent_id, name: src.name, domain: matchDomain },
    copy, skipped,
  };
}
