// ─── GET /admin/address-conflict-breakdown ──────────────────────────────────
//
// dev-request 2026-11-15-rfb-adressekonflikt-smal-regel-torrkjoring (slookisen/
// A2A), skive G1. READ-ONLY count that lets Daniel decide on a narrow address
// rule before anything is changed. It writes nothing and changes no verdict,
// no GATING_FIELDS and no pool membership.
//
// Cohort (the same one /admin/pool-blocker-explain reports on, read in bulk):
//   - agents.vertical_id = 'rfb', is_active = 1
//   - agent_knowledge.verification_status = 'review_required'
//   - e-mail present (agent_knowledge.email, the field pool-blocker-explain
//     reads as `email_present`)
//   - homepage present (COALESCE(k.website, a.url), same as `homepage_url`)
//   - uncontacted: no CRM outbound contact (buildContactedAtSql) and no
//     outreach_sent_log row (ALREADY_SENT_SQL) — both shared with
//     pool-blocker-explain, not re-derived here
//   - quarantineReasons() (pool-blocker-explain's own mapping) names
//     quarantine:address_conflict(<severity>) or
//     quarantine:address_uncorroborated
//
// Groups (`groups`, DISJOINT, every cohort row lands in exactly one, so
// sum_of_groups == total — AK2). Decided from the verifier's stored address
// verdict (verification_review_reason.address.conflict.values), i.e. the
// values the verifier actually compared:
//   same_postcode                     — every value has a postnummer, all equal
//   same_kommune_different_postcode   — >1 postnummer, all in one kommune
//   different_kommune                 — postnumre in >1 kommune
//   postcode_missing_or_unknown       — some value has no postnummer, or one
//                                       the Kartverket register does not know
//   fewer_than_two_sources            — no conflict to compare (the
//                                       address_uncorroborated case, or a
//                                       stored conflict with <2 values)
//
// `source_pairs.brreg_vs_own_website` is a SEPARATE dimension, not a group:
// a row is counted there when the compared values include a Brønnøysund
// (source_type `brreg`) value AND an own-website (`homepage` /
// `website_homepage`) value. It overlaps the groups above on purpose; its
// `by_group` split shows where those rows sit (and sums to its own count).
//
// Postnummer -> kommune uses the bundled Kartverket file via
// norway-postnummer.ts (no network). Postnummer is parsed with the
// validator's own parseAddressCore().
//
// Auth: X-Admin-Key via pool-blocker-explain's requireAdmin (same check as
// every admin route). Mounted under adminLimiter in index.ts.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  requireAdmin,
  parseReviewReason,
  quarantineReasons,
  buildContactedAtSql,
  ALREADY_SENT_SQL,
} from "./admin-pool-blocker-explain";
import {
  parseAddressCore,
  usableFieldRecords,
  coerceProvenanceToArrayShape,
  isInferenceSource,
} from "../services/cross-source-validator";
import { resolveKommuneFromPostnummer } from "../services/norway-postnummer";

const router = Router();

export const ADDRESS_BREAKDOWN_EXAMPLES_PER_GROUP = 10;

export const ADDRESS_BREAKDOWN_GROUPS = [
  "same_postcode",
  "same_kommune_different_postcode",
  "different_kommune",
  "postcode_missing_or_unknown",
  "fewer_than_two_sources",
] as const;
export type AddressBreakdownGroup = (typeof ADDRESS_BREAKDOWN_GROUPS)[number];

export interface AddressValue {
  source: string;
  address: string;
  postcode: string | null;
  kommune: string | null;
}

interface CohortRow {
  id: string;
  name: string | null;
  k_address: string | null;
  field_provenance: string | null;
  verification_review_reason: string | null;
}

function sourceHead(source: string): string {
  return String(source || "").trim().toLowerCase().split(":")[0] ?? "";
}

function describeValue(source: string, value: string, ownName: string | null): AddressValue {
  const { postcode } = parseAddressCore(value, ownName);
  let kommune: string | null = null;
  if (postcode) {
    const k = resolveKommuneFromPostnummer(postcode);
    if ("kommune" in k) kommune = k.kommune;
  }
  return { source, address: value, postcode, kommune };
}

/**
 * Pure grouping of the compared address values (exported for tests).
 * Disjoint: returns exactly one group per input.
 */
export function classifyAddressValues(values: AddressValue[]): AddressBreakdownGroup {
  if (values.length < 2) return "fewer_than_two_sources";
  if (values.some((v) => !v.postcode)) return "postcode_missing_or_unknown";
  const postcodes = new Set(values.map((v) => v.postcode));
  if (postcodes.size === 1) return "same_postcode";
  if (values.some((v) => !v.kommune)) return "postcode_missing_or_unknown";
  const kommuner = new Set(values.map((v) => v.kommune));
  return kommuner.size === 1 ? "same_kommune_different_postcode" : "different_kommune";
}

/** True when the values pair a Brønnøysund value with an own-website value. */
export function isBrregVsOwnWebsite(values: AddressValue[]): boolean {
  const heads = values.map((v) => sourceHead(v.source));
  const hasBrreg = heads.includes("brreg");
  const hasOwnSite = heads.some((h) => h === "homepage" || h === "website_homepage");
  return hasBrreg && hasOwnSite;
}

function provenanceAddressValues(raw: string | null): { source: string; value: string }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return usableFieldRecords(coerceProvenanceToArrayShape(parsed), "address").map((r) => ({
      source: r.source_type,
      value: r.value,
    }));
  } catch {
    return [];
  }
}

function emptyCounts(): Record<AddressBreakdownGroup, number> {
  const out = {} as Record<AddressBreakdownGroup, number>;
  for (const g of ADDRESS_BREAKDOWN_GROUPS) out[g] = 0;
  return out;
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.id AS id, a.name AS name,
              k.address AS k_address,
              k.field_provenance AS field_provenance,
              k.verification_review_reason AS verification_review_reason
         FROM agents a
         JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.vertical_id = ?
          AND a.is_active = 1
          AND k.verification_status = ?
          AND TRIM(COALESCE(k.email, '')) != ''
          AND (TRIM(COALESCE(k.website, '')) != '' OR TRIM(COALESCE(a.url, '')) != '')
          AND ${buildContactedAtSql(db)} IS NULL
          AND NOT ${ALREADY_SENT_SQL}
        ORDER BY a.name COLLATE NOCASE, a.id`,
    )
    .all("rfb", "review_required") as CohortRow[];

  const counts = emptyCounts();
  const examples = {} as Record<AddressBreakdownGroup, unknown[]>;
  for (const g of ADDRESS_BREAKDOWN_GROUPS) examples[g] = [];
  const byReason = { address_conflict: 0, address_uncorroborated: 0 };
  const pair = { count: 0, by_group: emptyCounts(), examples: [] as unknown[] };
  let total = 0;

  for (const row of rows) {
    const verdict = parseReviewReason(row.verification_review_reason);
    const reasons = quarantineReasons(row.field_provenance, verdict);
    const reason = reasons.find(
      (r) => r.startsWith("quarantine:address_conflict(") || r === "quarantine:address_uncorroborated",
    );
    if (!reason) continue;
    total++;
    const isConflict = reason.startsWith("quarantine:address_conflict(");
    if (isConflict) byReason.address_conflict++;
    else byReason.address_uncorroborated++;

    // The values the verifier compared. For address_uncorroborated there is no
    // conflict list; the stored address provenance is shown instead (0 or 1
    // real source, plus any inference guess) and the row is always
    // fewer_than_two_sources, so the group follows the verdict, not a newer
    // field_provenance the verifier has not judged yet.
    const conflictValues = isConflict ? verdict?.address?.conflict?.values ?? [] : [];
    const compared: AddressValue[] = (Array.isArray(conflictValues) ? conflictValues : [])
      .filter((v) => v && typeof v.value === "string" && v.value.trim() !== "")
      .map((v) => describeValue(String(v.source ?? ""), v.value, row.name));
    const group: AddressBreakdownGroup = isConflict ? classifyAddressValues(compared) : "fewer_than_two_sources";
    counts[group]++;

    const shown: AddressValue[] = isConflict
      ? compared
      : provenanceAddressValues(row.field_provenance).map((v) => describeValue(v.source, v.value, row.name));
    const example = {
      agent_id: row.id,
      name: row.name,
      quarantine_reason: reason,
      addresses: shown,
      inference_only: !isConflict && shown.length > 0 && shown.every((v) => isInferenceSource(v.source)),
      profile_address: row.k_address,
    };
    if (examples[group].length < ADDRESS_BREAKDOWN_EXAMPLES_PER_GROUP) examples[group].push(example);

    if (isBrregVsOwnWebsite(compared)) {
      pair.count++;
      pair.by_group[group]++;
      if (pair.examples.length < ADDRESS_BREAKDOWN_EXAMPLES_PER_GROUP) pair.examples.push(example);
    }
  }

  const sumOfGroups = ADDRESS_BREAKDOWN_GROUPS.reduce((s, g) => s + counts[g], 0);

  res.json({
    success: true,
    read_only: true,
    cohort:
      "rfb, active, review_required, e-mail and homepage present, not contacted and not sent; " +
      "quarantine:address_conflict or quarantine:address_uncorroborated (pool-blocker-explain mapping)",
    total,
    sum_of_groups: sumOfGroups,
    by_quarantine_reason: byReason,
    groups: ADDRESS_BREAKDOWN_GROUPS.map((g) => ({ group: g, count: counts[g], examples: examples[g] })),
    source_pairs: {
      brreg_vs_own_website: {
        note: "separate dimension, overlaps groups; by_group sums to count",
        count: pair.count,
        by_group: pair.by_group,
        examples: pair.examples,
      },
    },
    examples_per_group: ADDRESS_BREAKDOWN_EXAMPLES_PER_GROUP,
  });
});

export default router;
