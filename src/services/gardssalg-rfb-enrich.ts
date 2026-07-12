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

import { normalizeDomain } from "./blocklist-service";
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
  copy: Record<string, string | number>;      // field → value that WOULD be written
  skipped: Array<{ field: string; reason: string }>;
}

// Emails that are obviously placeholders / non-contactable — never copy these.
const JUNK_EMAIL_PATTERNS = [
  "user@domain.com",
  "example.com",
  "example.org",
  "test@test",
  "noreply@",
  "no-reply@",
  "your@email",
  "email@email",
  "domain.com",
];
export function isJunkEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const e = email.trim().toLowerCase();
  if (!e || !e.includes("@") || e.length < 5) return true;
  if (e.includes(" ")) return true;
  return JUNK_EMAIL_PATTERNS.some((p) => e.includes(p));
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
  }
  return out;
}

/**
 * Build the domain→RFB-source index. A source with no resolvable domain is
 * omitted (can't be strict-matched). If two sources share a domain, the FIRST
 * wins and the collision is not silently merged — callers can detect ambiguity
 * by comparing counts.
 */
export function indexRfbByDomain(sources: RfbSource[]): Map<string, RfbSource> {
  const map = new Map<string, RfbSource>();
  for (const s of sources) {
    const d = normalizeDomain(s.url);
    if (!d) continue;
    if (!map.has(d)) map.set(d, s);
  }
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
): EnrichResult {
  const base: EnrichResult = { provider_id: provider.id, navn: provider.navn, status: "no_match", copy: {}, skipped: [] };

  // Lock: never overwrite human/owner-authored rows.
  if (provider.content_source === "manual" || provider.content_source === "claim") {
    return { ...base, status: "locked" };
  }

  const providerDomain = normalizeDomain(provider.hjemmeside);
  if (!providerDomain) return { ...base, status: "no_domain" };

  const src = byDomain.get(providerDomain);
  if (!src) return { ...base, status: "no_match" };

  const inference = inferenceOnlyFields(src.verification_review_reason);
  const copy: Record<string, string | number> = {};
  const skipped: Array<{ field: string; reason: string }> = [];
  const isEmpty = (v: string | null): boolean => v === null || v.trim() === "";

  // about_text ← about (skip junk-description; 'about' is not a factual-inference field)
  if (isEmpty(provider.about_text)) {
    if (src.about && src.about.trim() && !isJunkDescription(src.about)) copy.about_text = src.about.trim();
    else if (src.about && src.about.trim()) skipped.push({ field: "about_text", reason: "junk_description" });
  }
  // adresse ← address (skip inference-only)
  if (isEmpty(provider.adresse) && src.address && src.address.trim()) {
    if (inference.has("address")) skipped.push({ field: "adresse", reason: "inference_only" });
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

  const status: EnrichResult["status"] = Object.keys(copy).length ? "would_enrich" : "nothing_to_fill";
  return { provider_id: provider.id, navn: provider.navn, status, matched_rfb: { agent_id: src.agent_id, name: src.name, domain: providerDomain }, copy, skipped };
}
