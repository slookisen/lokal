/**
 * dental-helfo-claim.ts — A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S6 (Daniel's answer
 * to question 24, 2026-10-19). «Helfo-direkteoppgjør»/«Helfo-avtale» is shown
 * only when the row says where the value comes from, the same rule as the
 * akutt claim (dental-acute-claim.ts). Without a source there is no Helfo
 * claim at all: no badge, no sentence, not counted, not in a Helfo search,
 * and the public answers give helfo_agreement "unknown" (the column's
 * default, no new value) instead of "true", never "false".
 *
 * Source rule: helfo_agreement = 'true' and `field_provenance.helfo_agreement`
 * holds at least one source that names where it was read: an object with a
 * non-blank `source_type` or `source_url` (String.prototype.trim). The entry
 * is read in every stored shape: an array of sources
 * (enrichment/mergeFieldProvenance), an object with a `sources` array
 * (stage_v_correction), or a legacy single record, which
 * coerceProvenanceToArrayShape wraps in an array. A record that names
 * neither ({}, blanks, a fetch date alone) is no source.
 *
 * Switch: HELFO_CLAIM_REQUIRES_SOURCE. Off (false) gives the claim from
 * helfo_agreement = 'true' alone, as before F2-S6: rollback is a one-line
 * change here. GET /api/tannlege/agents and /agents/:id keep the stored
 * value (F2-S7 is its own PR).
 *
 * Pure functions plus their SQL twin (DENTAL_HELFO_CLAIM_SQL), no DB access,
 * no data changes.
 */

import { coerceProvenanceToArrayShape } from "./cross-source-validator";
import { TRIM_CODE_POINTS } from "./dental-acute-claim";

/**
 * Switch for the source rule. Off (false) gives the badge, the sentence, the
 * public helfo_agreement, the filter and the counts exactly as
 * helfo_agreement = 'true' gave them before F2-S6.
 */
export const HELFO_CLAIM_REQUIRES_SOURCE = true;

/** A Helfo claim: the sources that name where helfo_agreement was read (none with the switch off). */
export interface HelfoClaim {
  sources: Array<Record<string, unknown>>;
}

interface HelfoClaimInput {
  helfo_agreement?: string | null;
  field_provenance?: Record<string, unknown> | null;
}

/** The records stored for helfo_agreement, in any shape; [] for any other value. */
function helfoProvenanceRecords(fieldProvenance: Record<string, unknown> | null | undefined): unknown[] {
  if (!fieldProvenance || typeof fieldProvenance !== "object" || Array.isArray(fieldProvenance)) return [];
  const entry = (fieldProvenance as Record<string, unknown>)["helfo_agreement"];
  if (entry && typeof entry === "object" && !Array.isArray(entry) && "sources" in entry) {
    const sources = (entry as { sources?: unknown }).sources;
    return Array.isArray(sources) ? sources : [];
  }
  return coerceProvenanceToArrayShape({ helfo_agreement: entry })["helfo_agreement"] ?? [];
}

const nonBlank = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

/** True when a record names where the value was read: a non-blank source_type or source_url. */
function namesSource(record: unknown): record is Record<string, unknown> {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const r = record as Record<string, unknown>;
  return nonBlank(r.source_type) || nonBlank(r.source_url);
}

/** The sources for helfo_agreement that name where it was read (namesSource). */
export function helfoClaimSources(
  fieldProvenance: Record<string, unknown> | null | undefined
): Array<Record<string, unknown>> {
  return helfoProvenanceRecords(fieldProvenance).filter(namesSource);
}

/**
 * The Helfo claim, or null: helfo_agreement = 'true' with at least one source
 * (helfoClaimSources). With the switch off: helfo_agreement = 'true' alone,
 * with no sources. KEEP IN SYNC with DENTAL_HELFO_CLAIM_SQL;
 * dental-helfo-claim.test.ts checks that both pick the same rows.
 */
export function resolveHelfoClaim(
  a: HelfoClaimInput,
  requiresSource: boolean = HELFO_CLAIM_REQUIRES_SOURCE
): HelfoClaim | null {
  if (a.helfo_agreement !== "true") return null;
  if (!requiresSource) return { sources: [] };
  const sources = helfoClaimSources(a.field_provenance);
  return sources.length > 0 ? { sources } : null;
}

/**
 * The helfo_agreement a public answer gives (the MCP and A2A cards,
 * GET /api/tannlege/discover): "unknown" where the stored 'true' has no
 * source, otherwise the stored value. GET /api/tannlege/agents keeps the
 * stored value.
 */
export function shownHelfoAgreement<T extends string | null | undefined>(
  a: HelfoClaimInput & { helfo_agreement?: T },
  requiresSource: boolean = HELFO_CLAIM_REQUIRES_SOURCE
): T | "unknown" {
  return a.helfo_agreement === "true" && !resolveHelfoClaim(a, requiresSource) ? "unknown" : (a.helfo_agreement as T);
}

// ── The SQL twin ─────────────────────────────────────────────────────────

const TRIM_CHARS_SQL = `char(${TRIM_CODE_POINTS.join(", ")})`;

// `path` of the JSON text `json` is a string with more than whitespace in it.
const nonBlankSql = (json: string, path: string): string =>
  `(json_type(${json}, '${path}') = 'text' AND trim(json_extract(${json}, '${path}'), ${TRIM_CHARS_SQL}) <> '')`;

// One record `s` (a json_each row) that names its source (namesSource). CASE
// reads json_type(s.value) only for an object, whose value is JSON text.
const RECORD_NAMES_SOURCE_SQL =
  "(CASE WHEN s.type = 'object' THEN " +
  `(${nonBlankSql("s.value", "$.source_type")} OR ${nonBlankSql("s.value", "$.source_url")})` +
  " ELSE 0 END)";

const sourcesExistSql = (path: string): string =>
  `(json_type(field_provenance, '${path}') = 'array' AND EXISTS (` +
  `SELECT 1 FROM json_each(field_provenance, '${path}') AS s WHERE ${RECORD_NAMES_SOURCE_SQL}))`;

/**
 * SQL twin of `resolveHelfoClaim(row) !== null` (switch on) on the
 * dental_agents columns: the public Helfo filter (/sok?helfo=1, MCP `helfo`,
 * A2A, /api/tannlege/discover, the Helfo facet), getDentalStats' helfo_count
 * and the area facts' helfo_true. KEEP IN SYNC with the functions above;
 * dental-helfo-claim.test.ts checks that both pick the same rows. Each step
 * mirrors a JS check: the column is JSON that JSON.parse reads (json_valid,
 * in a CASE ahead of the other JSON functions, which throw on malformed
 * JSON); the entry is an array of records, an object with a `sources` key
 * (whose value must be an array), or else a single record; a record names
 * its source with a non-blank source_type or source_url, blank after
 * trimming the characters String.prototype.trim removes (TRIM_CODE_POINTS).
 * json_each reads a list only when it is an array (it would also walk an
 * object's members). The leading equality lets the planner skip every other
 * row.
 */
export const DENTAL_HELFO_CLAIM_SQL =
  "(helfo_agreement = 'true' AND (CASE" +
  " WHEN NOT json_valid(field_provenance) THEN 0" +
  ` WHEN json_type(field_provenance, '$.helfo_agreement') = 'array' THEN ${sourcesExistSql("$.helfo_agreement")}` +
  " WHEN json_type(field_provenance, '$.helfo_agreement') = 'object' THEN (CASE" +
  ` WHEN json_type(field_provenance, '$.helfo_agreement.sources') IS NOT NULL THEN ${sourcesExistSql("$.helfo_agreement.sources")}` +
  ` ELSE (${nonBlankSql("field_provenance", "$.helfo_agreement.source_type")} OR ${nonBlankSql("field_provenance", "$.helfo_agreement.source_url")})` +
  " END)" +
  " ELSE 0 END) = 1)";

/** The claim as SQL: the source rule, or with the switch off helfo_agreement = 'true' alone. */
export function dentalHelfoClaimSql(requiresSource: boolean = HELFO_CLAIM_REQUIRES_SOURCE): string {
  return requiresSource ? DENTAL_HELFO_CLAIM_SQL : "helfo_agreement = 'true'";
}
