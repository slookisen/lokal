// ─── dental-places — PR-128 (2026-06-10) ────────────────────────────
//
// Pure-function helpers for the dental Google-Places enrichment batch
// (POST /api/tannlege/admin/google-places-batch in src/routes/dental.ts).
//
// Everything here is PURE: no DB, no network. The route does the I/O
// (Places fetch + updateDentalAgent); these helpers do the data-quality
// decisions so they can be unit-tested without the live Places API.
//
// Three exports tested in tests/test.ts:
//   placesPeriodsToOpeningHours — Places regularOpeningHours.periods →
//                                 our dental opening_hours schema shape
//                                 ({day:"mon".."sun", open/close "HH:MM"}[])
//   isConfidentPlaceMatch       — the match-validation guard that prevents
//                                 pulling another clinic's data
//   normalizePlacePhone         — strip "tel:" + internal whitespace, keep +

import { nameSimilarity } from "./name-matcher";

// ─── Places API response shapes (the subset of fields we request) ──────
// FieldMask we send:
//   places.displayName, places.formattedAddress,
//   places.internationalPhoneNumber, places.websiteUri,
//   places.regularOpeningHours, places.businessStatus,
//   places.addressComponents
export interface PlacesTimePoint {
  day?: number; // 0=Sunday .. 6=Saturday
  hour?: number;
  minute?: number;
}
export interface PlacesPeriod {
  open?: PlacesTimePoint;
  close?: PlacesTimePoint;
}
export interface PlacesRegularOpeningHours {
  periods?: PlacesPeriod[];
}
export interface PlacesAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}
export interface PlacesPlace {
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: PlacesRegularOpeningHours;
  businessStatus?: string;
  addressComponents?: PlacesAddressComponent[];
}

// Our dental opening_hours entry (matches the zod schema in dental-store).
export interface OpeningHoursEntry {
  day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
  open: string; // HH:MM
  close: string; // HH:MM
}

// Places day-number → our weekday code. Places: 0=Sunday .. 6=Saturday.
const PLACES_DAY_TO_CODE: ReadonlyArray<OpeningHoursEntry["day"]> = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

// ─── normalizePlacePhone ───────────────────────────────────────────────
// Strip a leading "tel:" prefix (case-insensitive) and ALL internal
// whitespace, preserving a leading "+". Mirrors the rfb endpoint's phone
// normalisation so cross-source phone values compare cleanly. Returns ""
// for empty / non-string input.
export function normalizePlacePhone(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/^tel:/i, "")
    .replace(/\s+/g, "")
    .trim();
}

// ─── pad2 ──────────────────────────────────────────────────────────────
function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

// ─── placesPeriodsToOpeningHours ───────────────────────────────────────
// Convert Places regularOpeningHours.periods → our {day,open,close}[].
//
// Conservative by design (data-quality over completeness):
//   - Only keep a period whose open and close share the SAME day number.
//     A period that spans midnight (open.day !== close.day) is skipped —
//     our schema is a single same-day open/close pair and we'd rather drop
//     a 24h/overnight clinic period than mis-encode it.
//   - Skip a period that lacks a `close` (Places emits open-only periods
//     for 24/7 places; we can't represent that, so skip it).
//   - Skip a period missing hour/day data.
//   - hour/minute default to 0 if absent (Places omits minute:0).
//   - Returns [] when periods is missing/empty or nothing survives.
export function placesPeriodsToOpeningHours(
  periods: PlacesPeriod[] | undefined | null
): OpeningHoursEntry[] {
  if (!Array.isArray(periods) || periods.length === 0) return [];
  const out: OpeningHoursEntry[] = [];
  for (const p of periods) {
    const open = p?.open;
    const close = p?.close;
    // Must have both endpoints.
    if (!open || !close) continue;
    const openDay = open.day;
    const closeDay = close.day;
    if (typeof openDay !== "number" || typeof closeDay !== "number") continue;
    // Conservative: only same-day periods (skip midnight-spanning).
    if (openDay !== closeDay) continue;
    if (openDay < 0 || openDay > 6) continue;
    const code = PLACES_DAY_TO_CODE[openDay];
    if (!code) continue;
    const oh = typeof open.hour === "number" ? open.hour : 0;
    const om = typeof open.minute === "number" ? open.minute : 0;
    const ch = typeof close.hour === "number" ? close.hour : 0;
    const cm = typeof close.minute === "number" ? close.minute : 0;
    if (oh < 0 || oh > 23 || ch < 0 || ch > 23) continue;
    if (om < 0 || om > 59 || cm < 0 || cm > 59) continue;
    out.push({
      day: code,
      open: `${pad2(oh)}:${pad2(om)}`,
      close: `${pad2(ch)}:${pad2(cm)}`,
    });
  }
  return out;
}

// ─── isConfidentPlaceMatch ─────────────────────────────────────────────
// The match-validation guard. Core protection against pulling a DIFFERENT
// clinic's data (the rfb google-rating-batch flaw: it blindly took
// data.places[0] with no validation). Returns true ONLY if the name is
// similar enough AND the location is corroborated by EXACT key equality:
//   - clinic HAS postnummer → require exact equality with the place's
//     postal_code component (mismatch or missing component → hard-fail).
//     This rejects same-city sibling chain branches (e.g. Oris Storo vs
//     Oris Lambertseter, both "Oslo") that share a name and town.
//   - clinic has NO postnummer → require a higher name bar
//     (NAME_SIM_THRESHOLD_POSTSTED_ONLY) AND exact, case-insensitive
//     equality of the place's postal_town/locality component vs the
//     clinic's poststed (NOT a formattedAddress substring, which
//     false-positives on short names like "Mo" in "Moss").
export const NAME_SIM_THRESHOLD = 0.55;
// When the clinic has no postnummer we can only cross-check on town name, which
// is weaker — require a higher name similarity on that path.
export const NAME_SIM_THRESHOLD_POSTSTED_ONLY = 0.65;

export interface MatchClinic {
  navn: string;
  postnummer?: string | null;
  poststed?: string | null;
}

interface AddrComp { types?: string[]; longText?: string; shortText?: string; }

function componentByType(place: PlacesPlace, t: string): AddrComp | undefined {
  const comps = Array.isArray(place.addressComponents) ? place.addressComponents : [];
  return comps.find((c) => Array.isArray((c as AddrComp)?.types) && (c as AddrComp).types!.includes(t)) as AddrComp | undefined;
}

/**
 * Confident-match guard (anti-contamination). A place is accepted ONLY if the
 * name is similar enough AND the location is corroborated:
 *  - If the clinic has a postnummer: REQUIRE an exact match against the place's
 *    postal_code component. A mismatch (or missing component) hard-fails — this
 *    is what stops a same-city sibling branch (e.g. Oris Storo vs Oris
 *    Lambertseter, both "Oslo") from being mistaken for this clinic.
 *  - If the clinic has NO postnummer: require a higher name threshold AND an
 *    exact (case-insensitive) match of the place's postal_town/locality against
 *    the clinic's poststed (equality, not a formattedAddress substring — the
 *    latter false-positives on short names like "Mo" ⊂ "Moss").
 */
export function isConfidentPlaceMatch(
  clinic: MatchClinic,
  place: PlacesPlace | null | undefined
): boolean {
  if (!place) return false;
  const placeName = place.displayName?.text ?? "";
  const sim = nameSimilarity(clinic.navn ?? "", placeName);
  if (sim < NAME_SIM_THRESHOLD) return false;

  const postnummer = (clinic.postnummer ?? "").toString().trim();
  if (postnummer) {
    // Strongest branch-specific key: exact postal_code equality, else hard-fail.
    const pc = componentByType(place, "postal_code");
    const pcVal = ((pc?.longText ?? pc?.shortText ?? "") as string).trim();
    return pcVal !== "" && pcVal === postnummer;
  }

  // No postnummer on the clinic → stricter name bar + town equality.
  if (sim < NAME_SIM_THRESHOLD_POSTSTED_ONLY) return false;
  const poststed = (clinic.poststed ?? "").toString().trim().toLowerCase();
  if (!poststed) return false;
  const loc = componentByType(place, "postal_town") ?? componentByType(place, "locality");
  const locVal = ((loc?.longText ?? loc?.shortText ?? "") as string).trim().toLowerCase();
  return locVal !== "" && locVal === poststed;
}

// ─── isValidHttpUrl ────────────────────────────────────────────────────
// Tight check for websiteUri: must parse as a URL with http(s) scheme.
export function isValidHttpUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
