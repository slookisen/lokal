// ─── Gårdssalg field concordance — read-only diagnosis slice ───────────────
//
// orchestrator dev-request 2026-08-03-gardssalg-field-concordance: for every
// producer in the verified drink-producer cohort (GET /admin/gardssalg-
// verified-drinkproducer-cohort's own provider-id set — routes/opplevelser.ts
// reuses that route's exact query/filter, not re-derived here), compares
// several DB-stored fields against what's actually findable on the
// producer's own (already ownership-verified) homepage, and reports a
// per-field verdict. Zero writes anywhere — this is diagnosis only, backing
// GET /admin/gardssalg-field-concordance-audit.
//
// This module is PURE: no DB access, no fetch. The route
// (routes/opplevelser.ts) supplies each producer's already-fetched page text
// (or `null` on a failed/skipped fetch) via crFetchGardssalgContent +
// gardssalgPageText — the SAME SSRF-guarded pipeline content-refresh and
// gardssalg-website-verification.ts already use, never a new fetch path.
//
// Verdict space:
//   bekreftet             — the stored value was found on the page.
//   avvik                 — (epost/telefon/mobil ONLY) the stored value is
//                            non-empty AND a DIFFERENT value of the same
//                            shape was found on the page instead. Carries
//                            `current` (stored) and `found` (extracted).
//   ikke_funnet_på_siden   — nothing usable found on the page for this field.
//                            Covers: fetch failure (fail-closed — never
//                            guess), blank stored value, or genuinely absent
//                            from the page. Also the fallback for the one
//                            case the spec leaves unstated (stored value
//                            blank but the page nonetheless contains
//                            something of that shape) — there is nothing
//                            stored to confirm or contradict, so there is
//                            nothing to report as bekreftet/avvik.
//
// adresse/postnummer/poststed/opening_hours_text are PRESENCE-ONLY by this
// slice's explicit spec — deliberately NO avvik/competing-value detection
// for those four fields (out of scope: free-text competing-value extraction
// is a false-positive risk this slice does not take on).

import { normaliseNorwegianPhone } from "./experience-store";
import { normaliseName } from "./brreg-client";

export type GfcFieldVerdict = "bekreftet" | "avvik" | "ikke_funnet_på_siden";

export interface GfcAvvikCapableField {
  verdict: GfcFieldVerdict;
  current: string | null;
  found: string | null;
}

export interface GfcPresenceField {
  verdict: GfcFieldVerdict;
}

export interface GfcProducerRow {
  id: string;
  navn: string;
  epost: string | null;
  telefon: string | null;
  mobil: string | null;
  adresse: string | null;
  postnummer: string | null;
  poststed: string | null;
  opening_hours_text: string | null;
}

export interface GfcProviderResult {
  provider_id: string;
  provider_name: string;
  epost: GfcAvvikCapableField;
  telefon: GfcAvvikCapableField;
  mobil: GfcAvvikCapableField;
  adresse: GfcPresenceField;
  postnummer: GfcPresenceField;
  poststed: GfcPresenceField;
  opening_hours_text: GfcPresenceField;
}

export type GfcFieldName =
  | "epost"
  | "telefon"
  | "mobil"
  | "adresse"
  | "postnummer"
  | "poststed"
  | "opening_hours_text";

export const GFC_AVVIK_CAPABLE_FIELDS: readonly GfcFieldName[] = ["epost", "telefon", "mobil"];
export const GFC_PRESENCE_ONLY_FIELDS: readonly GfcFieldName[] = [
  "adresse",
  "postnummer",
  "poststed",
  "opening_hours_text",
];
export const GFC_ALL_FIELDS: readonly GfcFieldName[] = [...GFC_AVVIK_CAPABLE_FIELDS, ...GFC_PRESENCE_ONLY_FIELDS];

export type GfcFieldSummary = { bekreftet: number; avvik: number; ikke_funnet_på_siden: number };
export type GfcSummary = Record<GfcFieldName, GfcFieldSummary>;

/**
 * Extract EVERY email-shaped substring from already-tag-stripped page text
 * (gardssalgPageText's output) — ALL matches, never just one best candidate
 * (unlike extractGardssalgContactEmail in experience-store.ts, which picks a
 * single write candidate; this audit needs the whole set to be able to tell
 * "stored value present" apart from "a DIFFERENT value present"). Lower-
 * cased, de-duplicated, first-seen order preserved. Pure — exported for
 * tests.
 */
export function extractAllEmails(pageText: string): string[] {
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(pageText || "")) !== null) {
    const email = m[0]!.toLowerCase();
    if (!seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

/**
 * Extract EVERY phone-shaped digit run from already-tag-stripped page text —
 * ALL runs (unlike extractGardssalgContactPhone in experience-store.ts,
 * which returns a single cued/best candidate for writing), normalised via
 * normaliseNorwegianPhone (the SAME helper gardssalgWebsiteEvidenceMatch
 * uses) and de-duplicated. Same not-embedded guard as that function's own
 * digit-run scan: an 8-digit run that is part of a LONGER digit run (a
 * 9-digit org.nr, a 12-digit account number) is never a phone number. Pure —
 * exported for tests.
 */
export function extractAllPhoneRuns(pageText: string): string[] {
  const text = pageText || "";
  const re = /(?:\+47|0047)?[\s.]?(?:\d[\s.]?){8}/g;
  const digitAdjacent = (idx: number, dir: -1 | 1): boolean => {
    let i = idx;
    while (i >= 0 && i < text.length && /[\s.]/.test(text[i]!)) i += dir;
    return i >= 0 && i < text.length && /\d/.test(text[i]!);
  };
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const phone = normaliseNorwegianPhone(m[0]!);
    if (!phone) continue;
    if (digitAdjacent(m.index - 1, -1) || digitAdjacent(m.index + m[0]!.length, 1)) continue;
    if (!seen.has(phone)) {
      seen.add(phone);
      out.push(phone);
    }
  }
  return out;
}

// Same word-boundary-safe substring check as gardssalgWebsiteEvidenceMatch's
// own private `boundaryIncludes` (experience-store.ts) — normaliseName
// collapses whitespace to single spaces, so space-padding both sides gives
// exact token-boundary semantics without a naive/unsafe `includes()`.
function boundaryIncludes(haystack: string, needle: string): boolean {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

// Same not-embedded digit-run guard as gardssalgWebsiteEvidenceMatch's
// org_nr/postnr checks — collapses separators between digits so a
// zero-width/space-broken run on the page still matches, and the
// negative-lookaround guards keep a shorter run from firing inside a longer
// one (postnummer "1234" must never match inside a 9-digit org.nr).
function digitRunPresent(pageText: string, digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  const digitCollapsed = (pageText || "").replace(/(\d)[\s. ]+(?=\d)/g, "$1");
  return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(digitCollapsed);
}

/** epost verdict — see module doc comment for the full rule. Pure. */
export function checkEmailField(stored: string | null, pageText: string): GfcAvvikCapableField {
  const storedTrim = (stored || "").trim();
  const extracted = extractAllEmails(pageText);
  const storedLower = storedTrim.toLowerCase();

  if (storedTrim && extracted.includes(storedLower)) {
    return { verdict: "bekreftet", current: storedTrim, found: storedTrim };
  }
  if (storedTrim && extracted.length > 0) {
    const different = extracted.find((e) => e !== storedLower) ?? extracted[0]!;
    return { verdict: "avvik", current: storedTrim, found: different };
  }
  return { verdict: "ikke_funnet_på_siden", current: storedTrim || null, found: null };
}

/** telefon/mobil verdict — identical rule for both fields, see module doc
 *  comment. Pure. */
export function checkPhoneField(stored: string | null, pageText: string): GfcAvvikCapableField {
  const storedTrim = (stored || "").trim();
  const storedNorm = normaliseNorwegianPhone(stored);
  const extracted = extractAllPhoneRuns(pageText);

  if (storedNorm && extracted.includes(storedNorm)) {
    return { verdict: "bekreftet", current: storedTrim, found: storedTrim };
  }
  if (storedTrim && extracted.length > 0) {
    const different = extracted.find((p) => p !== storedNorm) ?? extracted[0]!;
    return { verdict: "avvik", current: storedTrim, found: different };
  }
  return { verdict: "ikke_funnet_på_siden", current: storedTrim || null, found: null };
}

/** adresse verdict — presence-only (no avvik), same ≥6-char normalised
 *  token-boundary threshold gardssalgWebsiteEvidenceMatch's own address
 *  check uses (a bare short street name must never fire). Pure. */
export function checkAdresseField(stored: string | null, pageText: string): GfcPresenceField {
  const storedTrim = (stored || "").trim();
  if (!storedTrim) return { verdict: "ikke_funnet_på_siden" };
  const norm = normaliseName(storedTrim);
  if (norm.length < 6) return { verdict: "ikke_funnet_på_siden" };
  return { verdict: boundaryIncludes(normaliseName(pageText || ""), norm) ? "bekreftet" : "ikke_funnet_på_siden" };
}

/** postnummer verdict — presence-only, digit-run match (same discipline as
 *  gardssalgWebsiteEvidenceMatch's postnr_found: a bare 4-digit run is
 *  common to thousands of businesses, so this is presence-only here too —
 *  never sufficient alone to prove ownership, only reported as found/not
 *  found on the page). Pure. */
export function checkPostnummerField(stored: string | null, pageText: string): GfcPresenceField {
  const storedTrim = (stored || "").trim();
  if (!/^\d{4}$/.test(storedTrim)) return { verdict: "ikke_funnet_på_siden" };
  return { verdict: digitRunPresent(pageText || "", storedTrim) ? "bekreftet" : "ikke_funnet_på_siden" };
}

/** poststed verdict — presence-only, same ≥3-char normalised token-boundary
 *  threshold gardssalgWebsiteEvidenceMatch's own place check uses. Pure. */
export function checkPoststedField(stored: string | null, pageText: string): GfcPresenceField {
  const storedTrim = (stored || "").trim();
  if (!storedTrim) return { verdict: "ikke_funnet_på_siden" };
  const norm = normaliseName(storedTrim);
  if (norm.length < 3) return { verdict: "ikke_funnet_på_siden" };
  return { verdict: boundaryIncludes(normaliseName(pageText || ""), norm) ? "bekreftet" : "ikke_funnet_på_siden" };
}

/** opening_hours_text verdict — presence-only, same word-boundary-safe
 *  whole-value substring approach as adresse above (≥6 normalised chars, to
 *  keep a trivially short stored value from firing on unrelated page text).
 *  This is deliberately conservative: a page that phrases the same hours
 *  differently (different abbreviations/formatting) will legitimately not
 *  match — presence-only means "found verbatim (token-boundary-safe)", not
 *  "semantically equivalent", and this slice does not attempt the latter.
 *  Pure. */
export function checkOpeningHoursField(stored: string | null, pageText: string): GfcPresenceField {
  const storedTrim = (stored || "").trim();
  if (!storedTrim) return { verdict: "ikke_funnet_på_siden" };
  const norm = normaliseName(storedTrim);
  if (norm.length < 6) return { verdict: "ikke_funnet_på_siden" };
  return { verdict: boundaryIncludes(normaliseName(pageText || ""), norm) ? "bekreftet" : "ikke_funnet_på_siden" };
}

/**
 * Build one producer's full concordance row. `pageText === null` means the
 * homepage fetch failed (or there was no usable hjemmeside to fetch at all)
 * — fail-closed: EVERY field verdicts `ikke_funnet_på_siden`, never guessed,
 * never thrown. Pure (the route performs the actual fetch and hands the
 * result in here).
 */
export function buildProviderConcordanceRow(
  producer: GfcProducerRow,
  pageText: string | null,
): GfcProviderResult {
  if (pageText === null) {
    const blankAvvikCapable = (stored: string | null): GfcAvvikCapableField => ({
      verdict: "ikke_funnet_på_siden",
      current: (stored || "").trim() || null,
      found: null,
    });
    return {
      provider_id: producer.id,
      provider_name: producer.navn,
      epost: blankAvvikCapable(producer.epost),
      telefon: blankAvvikCapable(producer.telefon),
      mobil: blankAvvikCapable(producer.mobil),
      adresse: { verdict: "ikke_funnet_på_siden" },
      postnummer: { verdict: "ikke_funnet_på_siden" },
      poststed: { verdict: "ikke_funnet_på_siden" },
      opening_hours_text: { verdict: "ikke_funnet_på_siden" },
    };
  }

  return {
    provider_id: producer.id,
    provider_name: producer.navn,
    epost: checkEmailField(producer.epost, pageText),
    telefon: checkPhoneField(producer.telefon, pageText),
    mobil: checkPhoneField(producer.mobil, pageText),
    adresse: checkAdresseField(producer.adresse, pageText),
    postnummer: checkPostnummerField(producer.postnummer, pageText),
    poststed: checkPoststedField(producer.poststed, pageText),
    opening_hours_text: checkOpeningHoursField(producer.opening_hours_text, pageText),
  };
}

/** Per-field bekreftet/avvik/ikke_funnet_på_siden counts across a whole
 *  batch — mirrors summarizeGardssalgWebsiteVerification's shape (services/
 *  gardssalg-website-verification.ts), one summary object per field instead
 *  of one classification-bucket summary overall. Pure. */
export function summarizeGfc(rows: GfcProviderResult[]): GfcSummary {
  const empty = (): GfcFieldSummary => ({ bekreftet: 0, avvik: 0, ikke_funnet_på_siden: 0 });
  const summary: GfcSummary = {
    epost: empty(),
    telefon: empty(),
    mobil: empty(),
    adresse: empty(),
    postnummer: empty(),
    poststed: empty(),
    opening_hours_text: empty(),
  };
  for (const r of rows) {
    for (const f of GFC_ALL_FIELDS) {
      summary[f][r[f].verdict]++;
    }
  }
  return summary;
}
