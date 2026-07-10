// ─── city-normalizer — dev-request 2026-07-04-rfb-datakvalitet item 5 ────────
//
// STATS/COMPUTED-GUARD ONLY. This module does not touch the DB, does not
// backfill `agents.city`, and does not queue re-enrichment — it mirrors the
// incremental scoping already used by item 1 (description-quality.isJunk-
// Description) and item 3 (contact-normalizer.isDisplayablePhone): a pure,
// conservative function every STAT/AGGREGATE call site can run raw
// `agents.city` values through before they are counted or displayed.
//
// WHY THIS EXISTS
// ───────────────
// `agents.city` is free-text and has accumulated three distinct classes of
// pollution that make the homepage/lokal_stats "byer" (cities) counter
// wrong:
//   1. Country-level noise:      "Norge"
//   2. Fylke/county values:      "Akershus", "Vestland", "Troms", "Agder"
//   3. Multi-kommune region/valley/district labels that are not a single
//      real by/tettsted: "Lofoten", "Valdres", "Helgeland", "Hallingdal"
//   4. Casing typos:             "sandeid" (should read "Sandeid")
// None of these should count toward, or appear in, the "byer" list.
//
// SAFETY POSTURE (read before changing the heuristics)
// ──────────────────────────────────────────────────────
// The failure mode this module must avoid above all others is erasing a
// REAL city from the stat (a false positive on "this is region/country
// pollution"). That is worse than leaving a rare piece of pollution
// unfiltered, because it silently shrinks a number Daniel is watching for a
// reason unrelated to data quality.
//
// This is the reason normalizeCityLabel() does NOT simply call
// norway-fylke.ts's `normaliseFylke(raw)` and treat any non-null result as
// "this is a fylke, not a city" (a first, simpler draft was tried and
// rejected — verified empirically before writing this comment):
// `normaliseFylke()` has a token-level fallback that resolves a recognised
// KOMMUNE name to the fylke it belongs to (that's its intended job for
// strings like "Lyngdal, Agder"). Applied naively to a whole city value,
// that fallback misfires two ways:
//   • Real cities that are also literally kommuner get "normalised" to
//     their fylke and would be wrongly nulled out: normaliseFylke("Bergen")
//     === "Vestland", normaliseFylke("Stavanger") === "Rogaland",
//     normaliseFylke("Trondheim") === "Trøndelag", etc. — every well-known
//     Norwegian city would vanish from the byer-count.
//   • Multi-word real place names where one token happens to be a known
//     kommune also misfire: normaliseFylke("Kristiansand S") === "Agder"
//     even though "Kristiansand S" names a real place, not the fylke Agder.
// So a value is only treated as fylke/county pollution when the RAW STRING
// ITSELF is (or is a known historical alias of) a fylke name — see
// isFylkePollution() below — and even then only if it is not ALSO a
// recognised kommune/city name (the `cityToFylke` exemption), which is what
// keeps "Oslo" (simultaneously a fylke name and a real city with real
// producers) intact.
//
// No external deps. Pure data + string normalisation, same module style as
// description-quality.ts / contact-normalizer.ts.

import { normaliseFylke, cityToFylke, fylkeEquivalents, NON_KOMMUNE_REGION_LABELS } from "./norway-fylke";

// True when `raw` (the whole, untouched string) denotes a fylke/county
// value rather than a specific place — see the SAFETY POSTURE comment above
// for why this deliberately does NOT just check `normaliseFylke(raw) !== null`.
function isFylkePollution(raw: string): boolean {
  const canonicalGuess = normaliseFylke(raw);
  if (!canonicalGuess) return false;

  // A recognised kommune/city name is never region pollution, even if it
  // shares its name with its own fylke (e.g. "Oslo").
  if (cityToFylke(raw) !== null) return false;

  // Only reject when the input string itself is exactly the canonical
  // fylke name or one of its known historical variants (old halves of a
  // merged fylke, pre/post-2024 split forms, etc.) — never a broader
  // "resolves to a fylke via some token" match.
  const rawFold = raw.trim().toLowerCase();
  return fylkeEquivalents(canonicalGuess).some(name => name.toLowerCase() === rawFold);
}

/**
 * Normalize a raw `agents.city` value for stats/display purposes.
 *
 * Returns `null` when the value is not a real single city/tettsted:
 *   - empty / whitespace-only input
 *   - "Norge" (country, case-insensitive)
 *   - a fylke/county value (see isFylkePollution() above)
 *   - a multi-kommune region/valley/district label
 *     (norway-fylke.ts's NON_KOMMUNE_REGION_LABELS, case-insensitive)
 *
 * Otherwise returns the value with normalized display casing: each
 * whitespace- or hyphen-separated word gets its first letter uppercased and
 * the rest lowercased (Unicode-aware, so æ/ø/å case-fold correctly), e.g.
 *   "sandeid"        -> "Sandeid"
 *   "kristiansand s" -> "Kristiansand S"
 *   "stor-elvdal"    -> "Stor-Elvdal"
 * Re-casing is applied unconditionally (idempotent): already-correctly-cased
 * input is returned with the same content, just re-derived the same way.
 *
 * Pure, synchronous, side-effect-free — no DB access.
 */
export function normalizeCityLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const trimmedLower = trimmed.toLowerCase();
  if (trimmedLower === "norge") return null;

  for (const region of NON_KOMMUNE_REGION_LABELS) {
    if (region.toLowerCase() === trimmedLower) return null;
  }

  if (isFylkePollution(trimmed)) return null;

  // Title-case every run of non-whitespace/non-hyphen characters, leaving
  // whitespace and hyphens themselves untouched so multi-word and
  // hyphenated names keep their original shape ("Stor-Elvdal", not
  // "Stor-elvdal" or "STOR-ELVDAL").
  return trimmed.replace(/[^\s-]+/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}
