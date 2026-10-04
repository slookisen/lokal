// ─── Street-address parsing + road-designation detection (shared) ───────────
//
// parseStoredStreetAddress() and its regexes were written for the weekly
// field spot-check (routes/admin-field-spot-check.ts, W40 b4) and moved here
// UNCHANGED so the enrichment write paths can use the exact same parser
// (W40 RFB spot-check follow-up, "write guards"): Kvestad Sideri got
// `Fv109, 5776 Nå` — a road designation with no house number — from the
// Google Places address write in POST /admin/google-rating-batch, and the
// homepage's / Brreg's real street address (`Reisetevegen 83, 5776 Nå`)
// could never replace it because every enrichment address write is
// fill-empty-only. The helpers at the bottom of this file
// (isRoadDesignationOnlyAddress / hasStreetAndHouseNumber /
// streetAddressBeatsRoadDesignation) carry the precedence rule: a street
// address WITH a house number from the homepage or Brreg beats a road-only
// Google value. routes/admin-field-spot-check.ts re-exports the moved names.
//
// Pure, dependency-light (only contact-normalizer.ts) — safe to import from
// any route without dragging in a route module's service chain.

import { normalizeAddress, prepareAddressForComparison, splitAddress } from "./contact-normalizer";

/** Road designations ("Fv109", "Fv 109", "Rv. 7", "E6", "Fylkesvegen 109"):
 *  the number after one of these is a ROAD number, never a house number, so
 *  such a value has no street + house number to compare structurally. Tested
 *  against the street-name part AFTER normalizeAddress's canonicalization
 *  (which already turns "-vegen" into "-veien"). */
const ROAD_DESIGNATION_RE = /^(?:fv|rv|ev|kv|e|fylkesvei(?:en)?|riksvei(?:en)?|europavei(?:en)?)\.?$/;

/** "<street name> <house number>" as one comma segment, e.g. "lauvdalen
 *  186", "st. olavs gate 5b", "ullstindveien 1242/1246". */
const STREET_AND_NUMBER_RE = /^(\p{L}[\p{L}\p{N}.' -]*?)\s+(\d{1,4}[a-zæøå]?(?:\/\d{1,4}[a-zæøå]?)?)$/u;

/** A postal code written WITHOUT a comma straight after the house number,
 *  with no place name after it ("reiseteveien 83 5776", "… 83 n-5776").
 *  splitAddress only strips a postal tail after a comma or with a place
 *  word, so such a code stays in the street part and would be read as the
 *  house number (review fix). Requires a house number BEFORE the 4 digits,
 *  so a lone 4-digit house number ("ullstindveien 1242") is never taken for
 *  a postal code. Group 1 = street + number, 2 = postal code. */
const UNSEPARATED_POSTCODE_TAIL_RE = /^(.*\s\d{1,4}[a-zæøå]?)\s+(?:no?-\s?)?(\d{4})$/u;


export interface ParsedStreetAddress {
  /** Normalized street name ("lauvdalen", "solsideveien"). */
  street: string;
  /** Normalized house number incl. letter suffix ("186", "20b", "1242/1246"). */
  houseNumber: string;
  /** 4-digit postal code, or null when the stored value carries none. */
  postcode: string | null;
}

/** Parse a stored address into street name + house number + postal code
 *  using the SAME normalizer every other address comparison in this codebase
 *  uses (contact-normalizer.ts: prepareAddressForComparison → label/URL/
 *  own-name/company-form strip + accent fold; normalizeAddress →
 *  veg/vei + "12 a"/"12a" canonicalization; splitAddress → postal tail).
 *  Takes the LAST comma segment of the street part that ends in a house
 *  number, so a leading farm/company name ("Nordgard Aukrust, Solsidevegen
 *  449, 2686 Lom") is skipped. Returns null when there is no street + house
 *  number to compare (farm-name-only values like "Lønsdal, 8255 Røkland",
 *  road designations like "Fv109, 5776 Nå"). PURE. Exported for tests. */
export function parseStoredStreetAddress(
  raw: string | null | undefined,
  ownName?: string | null,
): ParsedStreetAddress | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const norm = normalizeAddress(prepareAddressForComparison(raw, ownName)).normalize("NFC");
  if (!norm) return null;
  const split = splitAddress(norm);
  const segments = split.street.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    // "reiseteveien 83 5776" (no comma, no place): the trailing 4 digits are
    // the postal code, not the house number.
    const tail = UNSEPARATED_POSTCODE_TAIL_RE.exec(segments[i]!);
    const segment = tail ? tail[1]! : segments[i]!;
    let postcode = tail ? tail[2]! : split.postcode;
    const m = STREET_AND_NUMBER_RE.exec(segment);
    if (!m) continue;
    const name = m[1]!.trim();
    if (ROAD_DESIGNATION_RE.test(name)) return null;
    const houseNumber = m[2]!;
    // splitAddress takes the first whole 4-digit run as the postal code even
    // when it IS the house number ("ullstindveien 1242" -> postcode 1242),
    // which would then "conflict" with the page's real postal code. A run
    // that occurs only once in the value, as its house number, is not a
    // postal code.
    if (
      !tail &&
      postcode !== null &&
      houseNumber.replace(/[a-zæøå]$/u, "") === postcode &&
      (norm.match(new RegExp(`(?<![\\d/])${postcode}(?![\\d/])`, "g"))?.length ?? 0) === 1
    ) {
      postcode = null;
    }
    return { street: name, houseNumber, postcode };
  }
  return null;
}

// ── Road-designation-only detection (write guards) ───────────────────────────

/** One comma segment that is ONLY a road designation + road number:
 *  "fv109", "fv 109", "rv. 7", "e6", "kv 12", "fylkesveien 109" (after
 *  normalizeAddress, which already turns "-vegen" into "-veien"). */
const ROAD_DESIGNATION_SEGMENT_RE =
  /^(?:fv|rv|ev|kv|e|fylkesvei(?:en)?|riksvei(?:en)?|europavei(?:en)?)\.?\s*\d{1,4}$/;

/** True when the address has NO street + house number (parseStoredStreetAddress
 *  returns null) AND one of its comma segments is a bare road designation
 *  ("Fv109, 5776 Nå", "Rv. 7, 3570 Ål", "Kvestad Sideri, Fv109, 5776 Nå").
 *  A farm-name-only value ("Lønsdal, 8255 Røkland") is NOT road-only — it is
 *  often the producer's real matrikkel address, so the correction rule below
 *  never touches it. PURE. Exported for tests. */
export function isRoadDesignationOnlyAddress(
  raw: string | null | undefined,
  ownName?: string | null,
): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  if (parseStoredStreetAddress(raw, ownName) !== null) return false;
  const norm = normalizeAddress(prepareAddressForComparison(raw, ownName)).normalize("NFC");
  if (!norm) return false;
  const split = splitAddress(norm);
  return split.street
    .split(",")
    .map((s) => s.trim())
    .some((seg) => {
      // "fv109 5776" (postal code glued on without a comma) — drop the tail.
      const noTail = seg.replace(/\s+(?:no?-\s?)?\d{4}$/u, "");
      return ROAD_DESIGNATION_SEGMENT_RE.test(seg) || ROAD_DESIGNATION_SEGMENT_RE.test(noTail);
    });
}

/** True when the address carries a real street name + house number
 *  ("Reisetevegen 83, 5776 Nå"). PURE. Exported for tests. */
export function hasStreetAndHouseNumber(raw: string | null | undefined, ownName?: string | null): boolean {
  return parseStoredStreetAddress(raw, ownName) !== null;
}

/** Source types whose street address may replace a road-only value: the
 *  producer's own homepage and the official Brreg registry. Compared on the
 *  head token before ':' (same convention as admin-knowledge.ts). */
export const STREET_ADDRESS_PREFERRED_SOURCES: ReadonlySet<string> = new Set([
  "homepage",
  "website_homepage",
  "brreg",
]);

export function isStreetAddressPreferredSource(sourceType: string | null | undefined): boolean {
  const head = String(sourceType ?? "").trim().toLowerCase().split(":")[0]!;
  return STREET_ADDRESS_PREFERRED_SOURCES.has(head);
}

/** Precedence rule: may `incoming` (an address from `incomingSourceType`)
 *  replace the stored `existing` value? Only when the stored value is a
 *  road designation without a house number, the incoming value has a real
 *  street + house number, and the incoming source is the homepage or Brreg.
 *  Callers still apply their own curated/owner locks first. PURE. */
export function streetAddressBeatsRoadDesignation(opts: {
  existing: string | null | undefined;
  incoming: string | null | undefined;
  incomingSourceType: string | null | undefined;
  ownName?: string | null;
}): boolean {
  return (
    isStreetAddressPreferredSource(opts.incomingSourceType) &&
    isRoadDesignationOnlyAddress(opts.existing, opts.ownName) &&
    hasStreetAndHouseNumber(opts.incoming, opts.ownName)
  );
}

/** The one exception to the fill-empty-only enrichment address writes
 *  (google-rating-batch, homepage-provenance-batch, brreg-contact-backfill):
 *  a road-designation-only stored value may be corrected by a homepage/Brreg
 *  street address WITH a house number — never over a curated lock or an
 *  owner-attested address record. PURE. */
export function canCorrectRoadOnlyAddress(opts: {
  currAddr: string;
  incoming: string;
  incomingSourceType: string;
  ownName?: string | null;
  existingAddressProvenance: unknown;
  isCurated: boolean;
}): boolean {
  if (opts.isCurated) return false;
  const recs = Array.isArray(opts.existingAddressProvenance) ? (opts.existingAddressProvenance as unknown[]) : [];
  const ownerAttested = recs.some(
    (r) => !!r && typeof r === "object" &&
      String((r as Record<string, unknown>).source_type ?? "").trim().toLowerCase().split(":")[0] === "owner",
  );
  if (ownerAttested) return false;
  return streetAddressBeatsRoadDesignation({
    existing: opts.currAddr,
    incoming: opts.incoming,
    incomingSourceType: opts.incomingSourceType,
    ownName: opts.ownName,
  });
}
