// ─── places-display-policy — when a stored Google Places value may be shown ──
// dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-
// treffvakt, slice A4 (Daniel 2026-10-18: «ikke vis dersom vi ikke har lov til
// det eller det er gale data»; question 21 answered A, websites from Places
// hidden too, 17:01Z).
//
// The Places terms do not allow saving Google's business addresses, phone
// numbers and the like (A2A protocols/2026-10-17-google-places-vilkar-sjekk.md
// §5), and a Places answer can describe another business. Nothing stored is
// deleted (that is A3, Daniel's own call). Instead, every public surface asks
// this module, per field, whether the stored value V may be shown:
//
//   Places evidence  a google_places provenance record whose value is EXACTLY
//                    V (trimmed; opening hours in canonical form). The Places
//                    writers record Places' value verbatim, so this is
//                    their fingerprint. A normalised match is not evidence: a
//                    phone from Brreg ("35 08 10 60") that Places only
//                    repeated ("+4735081060") is not Places' value.
//   Corroboration    a record from another real source (not Places, not an
//                    inference source such as web_search) whose value is the
//                    same once normalised (phonesMatch, addressesMatch, the
//                    host name for a website, canonical hours), or an owner
//                    signal the caller passes.
//   Marked wrong     a stored flag the caller passes (dental: a pending Stage V
//                    correction of the opening hours).
//
//   hidden  when marked wrong, or when there is Places evidence and no
//           corroboration; shown otherwise, also when the field has no
//           provenance at all (interpretation A, not C).
//
// A hidden field is replaced by nothing: the surface shows what is left
// (place, postnummer, map and coordinates stay; Daniel 17:01Z). Each vertical
// has a thin adapter that maps its columns and provenance keys onto this rule
// (dental: services/dental-places-display.ts).
//
// PURE: no DB, no network.
//
// Kill switch: PLACES_DISPLAY_POLICY_ENABLED. Rollback without a revert is a
// one-line PR setting it to false: every field is then shown as stored, as
// before A4.

import { phonesMatch, addressesMatch } from "./contact-normalizer";
import { isInferenceSource } from "./cross-source-validator";
import { normalizeHostname } from "./dental-hjemmeside-classifier";
import { normalizeOpeningHours, clockTime } from "../utils/opening-hours";

export const PLACES_DISPLAY_POLICY_ENABLED = true;

let placesDisplayPolicyForTesting: boolean | null = null;

/** Test-only: act as if PLACES_DISPLAY_POLICY_ENABLED were `on`; null restores it. */
export function __setPlacesDisplayPolicyForTesting(on: boolean | null): void {
  placesDisplayPolicyForTesting = on;
}

/** PLACES_DISPLAY_POLICY_ENABLED, or the test override. Read per call. */
export function placesDisplayPolicyEnabled(): boolean {
  return placesDisplayPolicyForTesting ?? PLACES_DISPLAY_POLICY_ENABLED;
}

/** The fields Places can supply, in the rule's own names (each vertical maps its columns onto them). */
export type PlacesDisplayField = "address" | "phone" | "opening_hours" | "website";

/** The source_type the Places writers stamp on their provenance records. */
export const PLACES_SOURCE_TYPE = "google_places";

/** One provenance record, as the rule reads it. */
export interface PlacesProvenanceRecord {
  source_type: string;
  value: string;
}

/** "own_homepage:2026-07-19" -> "own_homepage", as cross-source-validator.ts reads it. */
function sourceHead(sourceType: string): string {
  return sourceType.trim().toLowerCase().split(":")[0]!;
}

/**
 * The records stored under any of `keys` in a field_provenance value. Reads the
 * three stored shapes (a list of records, one record, and {sources: [...]}),
 * and a JSON string of the whole value; keeps only records with a source_type
 * and a text value. Anything else gives no records.
 */
export function fieldProvenanceRecords(fieldProvenance: unknown, keys: readonly string[]): PlacesProvenanceRecord[] {
  let prov = fieldProvenance;
  if (typeof prov === "string") {
    try {
      prov = JSON.parse(prov);
    } catch {
      return [];
    }
  }
  if (!prov || typeof prov !== "object" || Array.isArray(prov)) return [];
  const records: PlacesProvenanceRecord[] = [];
  for (const key of keys) {
    let entry = (prov as Record<string, unknown>)[key];
    if (entry && typeof entry === "object" && !Array.isArray(entry) && Array.isArray((entry as { sources?: unknown }).sources)) {
      entry = (entry as { sources: unknown[] }).sources;
    }
    const list = Array.isArray(entry) ? entry : entry && typeof entry === "object" ? [entry] : [];
    for (const r of list) {
      const { source_type, value } = (r ?? {}) as { source_type?: unknown; value?: unknown };
      if (typeof source_type === "string" && source_type.trim() && typeof value === "string") {
        records.push({ source_type, value });
      }
    }
  }
  return records;
}

/**
 * Opening hours in one comparable form, or null when they say nothing: read
 * through the shared normaliser (utils/opening-hours.ts, every stored form, a
 * JSON string too), times as "HH:MM", day labels left out where the days are
 * known, entries sorted. So `[{"day":"tue",…},{"day":"mon",…}]` and the same
 * hours in another order, or with "8:00" for "08:00", are the same hours.
 */
export function canonicalOpeningHours(value: unknown): string | null {
  let hours = value;
  if (typeof hours === "string" && /^\s*[[{]/.test(hours)) {
    try {
      hours = JSON.parse(hours);
    } catch {
      // not JSON: read as text below
    }
  }
  const time = (t: string | undefined) => (t === undefined ? "" : clockTime(t) ?? t.trim());
  const entries = normalizeOpeningHours(hours).map((e) =>
    JSON.stringify([e.days, e.days.length ? "" : e.label.toLowerCase(), time(e.open), time(e.close), e.period ?? "", e.note ?? ""])
  );
  return entries.length ? JSON.stringify(entries.sort()) : null;
}

/** Places evidence: the record holds exactly the stored value. */
function isStoredValue(field: PlacesDisplayField, stored: unknown, recordValue: string): boolean {
  if (field === "opening_hours") {
    const canonical = canonicalOpeningHours(stored);
    return canonical !== null && canonical === canonicalOpeningHours(recordValue);
  }
  return typeof stored === "string" && stored.trim() !== "" && recordValue.trim() === stored.trim();
}

/** Corroboration: the record holds the same value once both are normalised. */
function isSameValue(field: PlacesDisplayField, stored: unknown, recordValue: string): boolean {
  if (field === "opening_hours") return isStoredValue(field, stored, recordValue);
  if (typeof stored !== "string") return false;
  if (field === "phone") return phonesMatch(stored, recordValue);
  if (field === "address") return addressesMatch(stored, recordValue);
  const host = normalizeHostname(stored);
  return host !== "" && host === normalizeHostname(recordValue);
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0);
}

export interface PlacesFieldInput {
  field: PlacesDisplayField;
  /** The stored value (text; opening hours in any stored form). */
  value: unknown;
  /** The field's provenance records (fieldProvenanceRecords). */
  records: readonly PlacesProvenanceRecord[];
  /** The owner has given this value (counts as corroboration). */
  ownerConfirmed?: boolean;
  /** A stored flag says the value is wrong. */
  markedWrong?: boolean;
}

/** shown, or why not: only Places has it, or it is marked wrong. */
export type PlacesFieldVerdict = "shown" | "places_only" | "marked_wrong";

/** The rule above for one field. An empty value, or the switch off, is always "shown". */
export function placesFieldVerdict(input: PlacesFieldInput, enabled: boolean = placesDisplayPolicyEnabled()): PlacesFieldVerdict {
  if (!enabled || isBlank(input.value)) return "shown";
  if (input.markedWrong) return "marked_wrong";
  const placesEvidence = input.records.some(
    (r) => sourceHead(r.source_type) === PLACES_SOURCE_TYPE && isStoredValue(input.field, input.value, r.value)
  );
  if (!placesEvidence || input.ownerConfirmed) return "shown";
  const corroborated = input.records.some((r) => isCorroboratingRecord(input.field, input.value, r));
  return corroborated ? "shown" : "places_only";
}

/**
 * Corroboration (above) by one record: it comes from a real source (not
 * Places, not an inference source) and holds the stored value once both are
 * normalised. Also read by dental-import-display.ts (F2-S10), whose import
 * values are shown once a real source confirms them.
 */
export function isCorroboratingRecord(field: PlacesDisplayField, stored: unknown, record: PlacesProvenanceRecord): boolean {
  return (
    sourceHead(record.source_type) !== PLACES_SOURCE_TYPE &&
    !isInferenceSource(record.source_type) &&
    isSameValue(field, stored, record.value)
  );
}
