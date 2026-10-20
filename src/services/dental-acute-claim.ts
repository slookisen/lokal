/**
 * dental-acute-claim.ts — dev-request 2026-10-06-dental-nedlagte-og-akuttpastander,
 * skive B, and A2A dev-request 2026-10-16-finn-tannlege-fasettsider, F1-S4c.
 * «Tannlegevakt»/«Akuttvakt» is a health claim and is only shown when the
 * row stores a quote from the source that describes it; otherwise the soft
 * claim «Tar imot akuttpasienter» is shown when the row has acute_vakt = 1
 * with provenance or patient_focus mentions akutt; else nothing.
 *
 * Provenance rule: `field_provenance.acute_vakt` exists and is either a
 * non-empty array of sources (enrichment/mergeFieldProvenance shape) or an
 * object with a non-empty `sources` array (stage_v_correction shape).
 *
 * A source is a stamp ({value, source_type, source_url, fetched_at}): it says
 * where the value was read, not that the page describes an emergency duty
 * (the live check of 2026-10-19 found most of the stamped rows describe
 * emergency appointments in opening hours). «vakt» therefore needs one
 * source with a non-blank `quote`, the text from the source page, which no
 * row stores yet (F1-S4c «Slås på igjen når»: the extraction stores it once
 * Daniel has defined vakt and the dental write pause is lifted). A stamp
 * alone gives «Tar imot akuttpasienter», so the akutt claim, and with it the
 * public akutt filter, covers the same rows as before.
 *
 * Pure functions plus their SQL twins (DENTAL_ACUTE_CLAIM_SQL,
 * DENTAL_ACUTE_VAKT_SQL), no DB access, no data changes.
 */

export type AcuteClaim = "vakt" | "accepts" | null;

interface AcuteClaimInput {
  acute_vakt?: 0 | 1 | null;
  field_provenance?: Record<string, unknown> | null;
  patient_focus?: string[] | null;
}

export const ACUTE_ACCEPTS_LABEL = "Tar imot akuttpasienter";

/** The sources recorded for acute_vakt, in either shape; [] for any other value. */
function acuteVaktSources(fieldProvenance: Record<string, unknown> | null | undefined): unknown[] {
  if (!fieldProvenance || typeof fieldProvenance !== "object") return [];
  const entry = (fieldProvenance as Record<string, unknown>)["acute_vakt"];
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === "object") {
    const sources = (entry as { sources?: unknown }).sources;
    return Array.isArray(sources) ? sources : [];
  }
  return [];
}

export function hasAcuteVaktProvenance(
  fieldProvenance: Record<string, unknown> | null | undefined
): boolean {
  return acuteVaktSources(fieldProvenance).length > 0;
}

/**
 * True when a source for acute_vakt (either shape) carries the quote from
 * the source page: a `quote` that is a string with more than whitespace in
 * it (String.prototype.trim).
 */
export function hasAcuteVaktQuote(
  fieldProvenance: Record<string, unknown> | null | undefined
): boolean {
  return acuteVaktSources(fieldProvenance).some((source) => {
    const quote = source && typeof source === "object" ? (source as { quote?: unknown }).quote : undefined;
    return typeof quote === "string" && quote.trim() !== "";
  });
}

export function patientFocusMentionsAkutt(focus: string[] | null | undefined): boolean {
  return Array.isArray(focus) && focus.some((f) => typeof f === "string" && /akutt/i.test(f));
}

export function resolveAcuteClaim(a: AcuteClaimInput): AcuteClaim {
  if (a.acute_vakt === 1 && hasAcuteVaktQuote(a.field_provenance)) return "vakt";
  // F1-S4c: a stamp without the quote is provenance, not evidence of a vakt.
  if (a.acute_vakt === 1 && hasAcuteVaktProvenance(a.field_provenance)) return "accepts";
  if (patientFocusMentionsAkutt(a.patient_focus)) return "accepts";
  return null;
}

// acute_vakt = 1 with provenance (hasAcuteVaktProvenance): «vakt» with a
// quote, «Tar imot akuttpasienter» without one. DENTAL_ACUTE_CLAIM_SQL's
// first branch.
const ACUTE_VAKT_WITH_PROVENANCE_SQL =
  "acute_vakt = 1 AND json_valid(field_provenance) AND (" +
  "json_array_length(field_provenance, '$.acute_vakt') > 0 OR json_array_length(field_provenance, '$.acute_vakt.sources') > 0" +
  ")";

// The characters String.prototype.trim() removes (ECMAScript WhiteSpace and
// LineTerminator), for SQLite's trim(), which removes only spaces by default.
const TRIM_CODE_POINTS = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

// One source `s` (a json_each row) with a quote (hasAcuteVaktQuote): an
// object whose `quote` is a JSON string with more than whitespace in it.
// CASE reads json_type(s.value) only for an object, whose value is JSON text.
const SOURCE_HAS_QUOTE_SQL =
  "(CASE WHEN s.type = 'object' AND json_type(s.value, '$.quote') = 'text'" +
  ` THEN trim(json_extract(s.value, '$.quote'), char(${TRIM_CODE_POINTS.join(", ")})) <> '' ELSE 0 END)`;

// The "vakt" branch of resolveAcuteClaim: acute_vakt = 1 with a quote
// (hasAcuteVaktQuote). Each source list is read only when it is an array
// (json_each would also walk an object's members), as acuteVaktSources does.
const ACUTE_VAKT_WITH_QUOTE_SQL =
  "acute_vakt = 1 AND json_valid(field_provenance) AND (" +
  "(json_type(field_provenance, '$.acute_vakt') = 'array' AND EXISTS (" +
  `SELECT 1 FROM json_each(field_provenance, '$.acute_vakt') AS s WHERE ${SOURCE_HAS_QUOTE_SQL}` +
  ")) OR (json_type(field_provenance, '$.acute_vakt.sources') = 'array' AND EXISTS (" +
  `SELECT 1 FROM json_each(field_provenance, '$.acute_vakt.sources') AS s WHERE ${SOURCE_HAS_QUOTE_SQL}` +
  "))" +
  ")";

/**
 * SQL twin of `resolveAcuteClaim(row) !== null` on the dental_agents columns
 * (dev-request 2026-10-16-tannlege-sok-naturlig-sprak, S2b): the public akutt
 * filter, so a clinic is listed under akutt only when its card shows
 * «Akuttvakt» or «Tar imot akuttpasienter». F1-S4c moved the stamped rows
 * without a quote from «Akuttvakt» to «Tar imot akuttpasienter», so these
 * are the same rows as before: acute_vakt = 1 with provenance, quote or not,
 * or akutt in patient_focus. KEEP IN SYNC with the functions above;
 * dental-acute-filter.test.ts checks that both pick the same rows. Each step
 * mirrors a JS check: the column is JSON that JSON.parse reads (json_valid),
 * the provenance entry is a non-empty array or an object with a non-empty
 * `sources` array (json_array_length is 0 for any other value), and
 * patient_focus is an array (json_each would also walk an object or a lone
 * string) with a string element containing «akutt» in any case (LIKE folds
 * ASCII case, as /akutt/i does). CASE keeps json_valid ahead of the other
 * JSON functions, which throw on malformed JSON, and reads the provenance
 * only when acute_vakt = 1.
 */
export const DENTAL_ACUTE_CLAIM_SQL =
  "(CASE" +
  ` WHEN ${ACUTE_VAKT_WITH_PROVENANCE_SQL} THEN 1` +
  " WHEN json_valid(patient_focus) AND json_type(patient_focus) = 'array' AND EXISTS (" +
  "SELECT 1 FROM json_each(patient_focus) WHERE json_each.type = 'text' AND json_each.value LIKE '%akutt%'" +
  ") THEN 1" +
  " ELSE 0 END) = 1";

/**
 * SQL twin of `resolveAcuteClaim(row) === "vakt"`: «Akuttvakt» with a stored
 * quote, never the softer «Tar imot akuttpasienter» (A2A dev-request
 * 2026-10-16-finn-tannlege-fasettsider: the tannlegevakt pages of F1-S4 list
 * only these, and F1-S4c made a stamp without a quote no vakt). A row with
 * acute_vakt = 1 and provenance but no quote is not one. The quote is a JSON
 * string, blank after trimming the characters String.prototype.trim removes
 * (TRIM_CODE_POINTS). In a CASE, as above, so json_valid is read before the
 * other JSON functions wherever the planner puts the clause. KEEP IN SYNC
 * with resolveAcuteClaim; dental-acute-filter.test.ts and
 * dental-landing.test.ts check that both pick the same rows.
 */
export const DENTAL_ACUTE_VAKT_SQL = `(CASE WHEN ${ACUTE_VAKT_WITH_QUOTE_SQL} THEN 1 ELSE 0 END) = 1`;
