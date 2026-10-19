/**
 * dental-acute-claim.ts — dev-request 2026-10-06-dental-nedlagte-og-akuttpastander,
 * skive B. «Tannlegevakt»/«Akuttvakt» is a health claim and may only be shown
 * when the row carries provenance for `acute_vakt`; otherwise the soft claim
 * «Tar imot akuttpasienter» is shown when patient_focus mentions akutt; else nothing.
 *
 * Provenance rule: `field_provenance.acute_vakt` exists and is either a
 * non-empty array of sources (enrichment/mergeFieldProvenance shape) or an
 * object with a non-empty `sources` array (stage_v_correction shape).
 * Pure functions plus their SQL twin (DENTAL_ACUTE_CLAIM_SQL), no DB access,
 * no data changes.
 */

export type AcuteClaim = "vakt" | "accepts" | null;

interface AcuteClaimInput {
  acute_vakt?: 0 | 1 | null;
  field_provenance?: Record<string, unknown> | null;
  patient_focus?: string[] | null;
}

export const ACUTE_ACCEPTS_LABEL = "Tar imot akuttpasienter";

export function hasAcuteVaktProvenance(
  fieldProvenance: Record<string, unknown> | null | undefined
): boolean {
  if (!fieldProvenance || typeof fieldProvenance !== "object") return false;
  const entry = (fieldProvenance as Record<string, unknown>)["acute_vakt"];
  if (Array.isArray(entry)) return entry.length > 0;
  if (entry && typeof entry === "object") {
    const sources = (entry as { sources?: unknown }).sources;
    return Array.isArray(sources) && sources.length > 0;
  }
  return false;
}

export function patientFocusMentionsAkutt(focus: string[] | null | undefined): boolean {
  return Array.isArray(focus) && focus.some((f) => typeof f === "string" && /akutt/i.test(f));
}

export function resolveAcuteClaim(a: AcuteClaimInput): AcuteClaim {
  if (a.acute_vakt === 1 && hasAcuteVaktProvenance(a.field_provenance)) return "vakt";
  if (patientFocusMentionsAkutt(a.patient_focus)) return "accepts";
  return null;
}

// The "vakt" branch of resolveAcuteClaim: acute_vakt = 1 with provenance
// (hasAcuteVaktProvenance). Shared by the two SQL twins below.
const ACUTE_VAKT_WITH_PROVENANCE_SQL =
  "acute_vakt = 1 AND json_valid(field_provenance) AND (" +
  "json_array_length(field_provenance, '$.acute_vakt') > 0 OR json_array_length(field_provenance, '$.acute_vakt.sources') > 0" +
  ")";

/**
 * SQL twin of `resolveAcuteClaim(row) !== null` on the dental_agents columns
 * (dev-request 2026-10-16-tannlege-sok-naturlig-sprak, S2b): the public akutt
 * filter, so a clinic is listed under akutt only when its card shows
 * «Akuttvakt» or «Tar imot akuttpasienter». KEEP IN SYNC with the three
 * functions above; dental-acute-filter.test.ts checks that both pick the same
 * rows. Each step mirrors a JS check: the column is JSON that JSON.parse
 * reads (json_valid), the provenance entry is a non-empty array or an object
 * with a non-empty `sources` array (json_array_length is 0 for any other
 * value), and patient_focus is an array (json_each would also walk an object
 * or a lone string) with a string element containing «akutt» in any case
 * (LIKE folds ASCII case, as /akutt/i does). CASE keeps json_valid ahead of
 * the other JSON functions, which throw on malformed JSON, and reads the
 * provenance only when acute_vakt = 1.
 */
export const DENTAL_ACUTE_CLAIM_SQL =
  "(CASE" +
  ` WHEN ${ACUTE_VAKT_WITH_PROVENANCE_SQL} THEN 1` +
  " WHEN json_valid(patient_focus) AND json_type(patient_focus) = 'array' AND EXISTS (" +
  "SELECT 1 FROM json_each(patient_focus) WHERE json_each.type = 'text' AND json_each.value LIKE '%akutt%'" +
  ") THEN 1" +
  " ELSE 0 END) = 1";

/**
 * SQL twin of `resolveAcuteClaim(row) === "vakt"`: «Akuttvakt» with a source,
 * never the softer «Tar imot akuttpasienter» (A2A dev-request
 * 2026-10-16-finn-tannlege-fasettsider, F1-S4: the tannlegevakt pages list
 * only clinics with sourced vakt). A row with acute_vakt = 1 and no
 * provenance is not one. In a CASE, as above, so json_valid is read before
 * json_array_length wherever the planner puts the clause. KEEP IN SYNC with
 * resolveAcuteClaim; dental-landing.test.ts checks that both pick the same rows.
 */
export const DENTAL_ACUTE_VAKT_SQL = `(CASE WHEN ${ACUTE_VAKT_WITH_PROVENANCE_SQL} THEN 1 ELSE 0 END) = 1`;
