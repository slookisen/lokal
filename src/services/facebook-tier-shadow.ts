// ─── Facebook-tier shadow measurement (enrichment-kadens S1a) ────────────────
//
// Read-only "what if" for a later rule change (S1b): `facebook_official_page`
// should only count as evidence that the producer EXISTS, never as
// corroboration for `address` or `phone`. Before that change is built, this
// computes — for one profile's parsed field_provenance — the cross-source
// result as production computes it today, and the result with every
// `facebook_official_page` record removed from that field.
//
// Pure: no DB, no I/O, no change to TIER_B / tierForSource() or to any
// production verdict. "now" is the exact call the verifier makes
// (lokal-agent-verifier.ts runVerifierBatch: crossSourceAgreement(fieldProv,
// field, { ownName: agent.name }) for address/phone/business_status, then
// aggregateVerdict over those). "shadow" is the same call on a copy of the
// provenance where only that field's records are filtered.

import {
  aggregateVerdict,
  coerceProvenanceToArrayShape,
  crossSourceAgreement,
  type CrossSourceResult,
  type CrossSourceVerdict,
  type FieldName,
  type ProvenanceRecord,
} from "./cross-source-validator";

export const SHADOW_EXCLUDED_SOURCE_TYPE = "facebook_official_page";
export const SHADOW_FIELDS = ["address", "phone"] as const;
export type ShadowField = (typeof SHADOW_FIELDS)[number];

// Same field set the verifier evaluates before aggregateVerdict.
const VERIFIER_FIELDS: readonly FieldName[] = ["address", "phone", "business_status"];

export interface FacebookTierShadowFieldResult {
  now: CrossSourceResult;
  shadow: CrossSourceResult;
  /** The field carries ≥1 record with source_type === facebook_official_page. */
  has_facebook_record: boolean;
  /** Agreed (pool_eligible) today, and not any more without facebook. */
  would_lose: boolean;
}

export interface FacebookTierShadowResult {
  fields: Record<ShadowField, FacebookTierShadowFieldResult>;
  aggregate_now: CrossSourceVerdict;
  aggregate_shadow: CrossSourceVerdict;
  aggregate_would_lose: boolean;
}

function isAgreed(r: CrossSourceResult): boolean {
  return r.agree === true && r.verdict === "pool_eligible";
}

function isExcluded(rec: unknown): boolean {
  return (
    !!rec &&
    typeof rec === "object" &&
    (rec as Partial<ProvenanceRecord>).source_type === SHADOW_EXCLUDED_SOURCE_TYPE
  );
}

/**
 * PURE: today's vs the shadow (no facebook_official_page for address/phone)
 * cross-source results for one profile. `fieldProvenance` is the parsed
 * agent_knowledge.field_provenance object (any legacy/array shape).
 */
export function computeFacebookTierShadow(
  fieldProvenance: Record<string, unknown> | null | undefined,
  opts: { ownName?: string | null } = {},
): FacebookTierShadowResult {
  const prov: Record<string, unknown> =
    fieldProvenance && typeof fieldProvenance === "object" && !Array.isArray(fieldProvenance)
      ? fieldProvenance
      : {};
  const coerced = coerceProvenanceToArrayShape(prov);

  const nowResults: Record<string, CrossSourceResult> = {};
  for (const f of VERIFIER_FIELDS) {
    nowResults[f] = crossSourceAgreement(prov, f, { ownName: opts.ownName });
  }

  const shadowResults: Record<string, CrossSourceResult> = { ...nowResults };
  const fields = {} as Record<ShadowField, FacebookTierShadowFieldResult>;
  for (const f of SHADOW_FIELDS) {
    const records = coerced[f] ?? [];
    const hasFacebook = records.some(isExcluded);
    const shadow = hasFacebook
      ? crossSourceAgreement(
          { ...prov, [f]: records.filter((r) => !isExcluded(r)) },
          f,
          { ownName: opts.ownName },
        )
      : nowResults[f]!;
    shadowResults[f] = shadow;
    fields[f] = {
      now: nowResults[f]!,
      shadow,
      has_facebook_record: hasFacebook,
      would_lose: isAgreed(nowResults[f]!) && !isAgreed(shadow),
    };
  }

  const aggregate_now = aggregateVerdict(nowResults);
  const aggregate_shadow = aggregateVerdict(shadowResults);
  return {
    fields,
    aggregate_now,
    aggregate_shadow,
    aggregate_would_lose: aggregate_now === "pool_eligible" && aggregate_shadow !== "pool_eligible",
  };
}
