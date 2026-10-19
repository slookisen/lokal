// ─── «Verifisert» only with a basis (a read-time rule) ──────────────────────
// A2A dev-request 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S8.
//
// The «Verifisert» badge, the verification_status the public answers give and
// every number and ranking built on it are shown only when the stored fields
// meet the rule the badge text describes: the rule-based check
// (computeDentalVerifiedRule) passes on what the verifier stored, and the
// clinic is not closed. A stored 'verified' that does not meet it (set by an
// earlier routine through PUT, or by hand, before the check existed) is not
// shown. The rule can only hide a badge, never give one, and nothing in the
// database changes: the verifier, the enrichment routine and the admin view
// keep reading the stored status. Same pattern as the akutt rule
// (dental-acute-claim.ts): a pure function plus its SQL twin, so the badge,
// the filter, the counts and the order say the same.
//
// The rule itself (computeDentalVerifiedRule, countRichFields and the
// constants they read) lives here, moved out of dental-verifier.ts, which
// re-exports it: the verifier imports dental-store, and the store reads the
// rule, so the rule needs a module that imports neither. It imports only a
// type from dental-catalog-class.ts, which imports nothing.
//
// Pure: no DB access, no I/O.

import type { DentalCatalogClass } from "./dental-catalog-class";

// ── The rule (moved from dental-verifier.ts) ─────────────────────────────

// "at least 3 rich fields populated" (dev-request spec, Verified rule).
export const DENTAL_VERIFIER_MIN_RICH_FIELDS = 3;

// The 10 PR-100 "deep-scrape" columns (init-dental.ts, PR-100 comment
// block: "Deep-scrape (10)") -- the codebase's own existing definition of
// what makes a dental_agents row substantively enriched beyond the raw
// Brreg-sweep import. No prior "richness" concept exists anywhere else in
// the dental code for this file to ground itself in (grepped
// enrichment_state's own values -- raw/enriched/thin_site -- and found no
// numeric field-count threshold anywhere), so this is the most directly
// grounded definition available: the exact column set another PR already
// singled out, by name, as "deepen[ing] enrichment beyond the raw import".
const RICH_FIELDS = [
  "om_oss",
  "specialists",
  "treatment_tech",
  "equipment_brands",
  "patient_focus",
  "accessibility",
  "payment_options",
  "online_booking_url",
  "social_media",
  "treatments_subtypes",
] as const;
export type DentalRichField = (typeof RICH_FIELDS)[number];
export const DENTAL_RICH_FIELDS: readonly DentalRichField[] = RICH_FIELDS;

export type DentalWebsiteOwnership = "verified" | "unverified" | "n/a";
export type DentalBrregStatus =
  | "active"
  | "dissolved"
  | "bankrupt"
  // Brreg's own `active` boolean (verifyOrgNumber, brreg-client.ts) also
  // folds in `underAvvikling`/`underTvangsavviklingEllerTvangsopplosning`
  // (under voluntary/forced liquidation), but its `flag` field only ever
  // surfaces "dissolved"/"bankrupt"/null for those two -- a CONFIRMED
  // (200-response, exists:true) entity that is inactive for one of those
  // two OTHER reasons would otherwise be silently misbucketed as the
  // ambiguous not-found-or-unreachable case below. Kept as its own bucket
  // so a genuine, confirmed inactive-but-unflagged Brreg answer is never
  // conflated with "we don't actually know".
  | "inactive_other"
  | "orgnr_not_found_or_unreachable";

/**
 * Whether one rich field counts as populated. The verifier passes the stored
 * text (SELECT of the TEXT columns), so a stored '[]'/'{}' (never written by
 * dental-store.ts's own jsonOrNull(), but defensively guarded the same way
 * dental-claim-service.ts's own completion-mode completeness check already
 * guards these exact columns) does not count, and malformed but non-empty
 * JSON does. A value that is not a string is taken as already parsed (a
 * hydrated row built by hand, F2-S8): an array or object counts when it is
 * not empty, any other value when it is not null or "". A hydrated row from
 * the store does not come through here: it carries the count of its stored
 * text (rich_field_count, hydrateAgent).
 */
function richFieldPopulated(field: DentalRichField, value: unknown): boolean {
  if (typeof value === "string") {
    if (value.trim() === "") return false;
    // om_oss: plain text.
    if (field === "om_oss") return true;
    try {
      return parsedValuePopulated(JSON.parse(value));
    } catch {
      // Malformed JSON but non-empty text -- still counts as "something is
      // there" rather than silently treating a write bug as "not rich".
      return true;
    }
  }
  return parsedValuePopulated(value);
}

function parsedValuePopulated(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== "";
}

/**
 * How many of DENTAL_RICH_FIELDS are genuinely populated on this row (see
 * richFieldPopulated for what counts). Pure, never throws.
 */
export function countRichFields(row: Partial<Record<DentalRichField, unknown>>): number {
  let count = 0;
  for (const field of DENTAL_RICH_FIELDS) if (richFieldPopulated(field, row[field])) count++;
  return count;
}

export interface DentalVerifiedRuleInput {
  brregStatus: DentalBrregStatus | null;
  websiteOwnership: DentalWebsiteOwnership | null;
  catalogClass: DentalCatalogClass | null;
  directoryUrl: string | null;
  richFieldCount: number;
}

/**
 * The Verified rule (dev-request spec): Brreg active AND (website_ownership
 * verified OR it's an offentlig_klinikk with a directory_url present) AND
 * at least DENTAL_VERIFIER_MIN_RICH_FIELDS rich fields populated. Pure.
 */
export function computeDentalVerifiedRule(input: DentalVerifiedRuleInput): boolean {
  if (input.brregStatus !== "active") return false;
  const ownershipOk =
    input.websiteOwnership === "verified" ||
    (input.catalogClass === "offentlig_klinikk" && !!input.directoryUrl && input.directoryUrl.trim() !== "");
  if (!ownershipOk) return false;
  return input.richFieldCount >= DENTAL_VERIFIER_MIN_RICH_FIELDS;
}

// ── The read-time claim (F2-S8) ──────────────────────────────────────────

/**
 * Switch for the read-time rule. Off (false) gives the badge, the status,
 * the filter, the counts and the order exactly as a stored 'verified' gave
 * them before F2-S8: rollback is a one-line change here.
 */
export const VERIFIED_CLAIM_REQUIRES_RULE = true;

/** The stored fields the claim reads: a hydrated row (dental-store's DentalAgentRow) or a raw one. */
export interface VerifiedClaimInput extends Partial<Record<DentalRichField, unknown>> {
  verification_status?: string | null;
  is_inactive?: number | null;
  brreg_status?: string | null;
  website_ownership?: string | null;
  catalog_class?: string | null;
  directory_url?: string | null;
  /**
   * countRichFields over the stored text, as hydrateAgent sets it on a row
   * stored as 'verified'. A hydrated row has parsed its JSON columns, and
   * malformed JSON is null there, so it cannot be counted from the parsed
   * values. Without it the claim counts the row's own values.
   */
  rich_field_count?: number | null;
}

/**
 * True when the clinic may show «Verifisert»: stored 'verified', not closed
 * (is_inactive 1), and computeDentalVerifiedRule passes on the stored
 * brreg_status, website_ownership, catalog_class, directory_url and rich
 * fields. With the switch off: stored 'verified', as before. KEEP IN SYNC
 * with DENTAL_VERIFIED_CLAIM_SQL; dental-verified-claim.test.ts checks that
 * both pick the same rows.
 */
export function resolveVerifiedClaim(row: VerifiedClaimInput, requiresRule: boolean = VERIFIED_CLAIM_REQUIRES_RULE): boolean {
  if (row.verification_status !== "verified") return false;
  if (!requiresRule) return true;
  if (row.is_inactive === 1) return false;
  return computeDentalVerifiedRule({
    // Stored values outside the types simply fail the comparisons, as in SQL.
    brregStatus: (row.brreg_status ?? null) as DentalBrregStatus | null,
    websiteOwnership: (row.website_ownership ?? null) as DentalWebsiteOwnership | null,
    catalogClass: (row.catalog_class ?? null) as DentalCatalogClass | null,
    directoryUrl: row.directory_url ?? null,
    richFieldCount: typeof row.rich_field_count === "number" ? row.rich_field_count : countRichFields(row),
  });
}

/**
 * The verification_status a public answer gives (A2A message/send, GET
 * /api/tannlege/discover): 'pending_verify' (the column's default, no new
 * value) where the claim hides a stored 'verified', otherwise the stored
 * value. Admin views and the raw REST list keep the stored value.
 */
export function shownVerificationStatus<T extends string | null | undefined>(
  row: VerifiedClaimInput & { verification_status?: T },
  requiresRule: boolean = VERIFIED_CLAIM_REQUIRES_RULE
): T | "pending_verify" {
  return row.verification_status === "verified" && !resolveVerifiedClaim(row, requiresRule)
    ? "pending_verify"
    : (row.verification_status as T);
}

// ── The SQL twin ─────────────────────────────────────────────────────────

// The characters String.prototype.trim() removes (ECMAScript WhiteSpace and
// LineTerminator: tab, LF, VT, FF, CR, space, NBSP, U+1680, U+2000-U+200A,
// U+2028, U+2029, U+202F, U+205F, U+3000 and the BOM), so SQLite's trim()
// empties exactly the values .trim() empties. Its default trims spaces only.
const JS_TRIM_CHARS_SQL =
  "char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)";

/** `column` holds text that .trim() leaves non-empty (NULL does not). */
const nonBlankSql = (column: string): string => `trim(COALESCE(${column}, ''), ${JS_TRIM_CHARS_SQL}) != ''`;

/**
 * richFieldPopulated over the stored text, 1 or 0. json_valid() accepts
 * exactly what JSON.parse() does here (RFC 8259; the parity test runs the
 * edge cases), and the CASE reads it before json_type()/json(), which throw
 * on malformed JSON. json() minifies, so '[ ]' and '{ }' are empty too; a
 * JSON string counts unless it is "".
 */
function richFieldPopulatedSql(field: DentalRichField): string {
  if (field === "om_oss") return `(CASE WHEN ${nonBlankSql(field)} THEN 1 ELSE 0 END)`;
  return (
    "(CASE" +
    ` WHEN NOT (${nonBlankSql(field)}) THEN 0` +
    ` WHEN NOT json_valid(${field}) THEN 1` +
    ` WHEN json_type(${field}) IN ('array', 'object') THEN (CASE WHEN json(${field}) IN ('[]', '{}') THEN 0 ELSE 1 END)` +
    ` WHEN json_type(${field}) = 'null' THEN 0` +
    ` WHEN json_type(${field}) = 'text' THEN (CASE WHEN json_extract(${field}, '$') = '' THEN 0 ELSE 1 END)` +
    " ELSE 1 END)"
  );
}

/**
 * SQL twin of `resolveVerifiedClaim(row)` (switch on) on the dental_agents
 * columns: the public verification_status filter, the «Verifisert» counts of
 * the area facts and the «verified first» order. KEEP IN SYNC with
 * resolveVerifiedClaim and computeDentalVerifiedRule above;
 * dental-verified-claim.test.ts checks that both pick the same rows. The
 * leading equality lets the planner use idx_dental_verification; the CASE
 * then reads the remaining conditions in order (a NULL column fails its
 * IS / IS NOT test, as a null fails the JS comparison) and counts the rich
 * fields only for a row that has passed the rest.
 */
export const DENTAL_VERIFIED_CLAIM_SQL =
  "(verification_status = 'verified' AND (CASE" +
  " WHEN is_inactive IS 1 THEN 0" +
  " WHEN brreg_status IS NOT 'active' THEN 0" +
  ` WHEN website_ownership IS NOT 'verified' AND (catalog_class IS NOT 'offentlig_klinikk' OR NOT (${nonBlankSql("directory_url")})) THEN 0` +
  ` WHEN (${DENTAL_RICH_FIELDS.map(richFieldPopulatedSql).join(" + ")}) >= ${DENTAL_VERIFIER_MIN_RICH_FIELDS} THEN 1` +
  " ELSE 0 END) = 1)";

/** The claim as SQL: the rule, or with the switch off the stored status alone. */
export function dentalVerifiedClaimSql(requiresRule: boolean = VERIFIED_CLAIM_REQUIRES_RULE): string {
  return requiresRule ? DENTAL_VERIFIED_CLAIM_SQL : "verification_status = 'verified'";
}
