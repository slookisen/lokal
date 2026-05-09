// ─── cross-source-validator — Phase 5.3 / WO-16 ─────────────────────────────
//
// Pure-function module that decides whether a critical field has ≥2 independent
// sources that agree (or 1 Tier-S owner-curated source).
//
// Reference: supervisor-inbox/2026-05-07-work-order-16-phase5.3-cross-source.md

export type FieldName = "address" | "phone" | "business_status";
export type SourceTier = "S" | "A" | "B" | "C";

export type ProvenanceRecord = {
  value: string;
  source_type: string;
  source_url?: string;
  fetched_at: string;
};

export type CrossSourceResult = {
  agree: boolean;
  source_count: number;
  sources_used: string[];
  conflict?: {
    values: { source: string; value: string }[];
    severity: "minor" | "major";
  };
};

// ─── Tier classification ────────────────────────────────────────────────────

const TIER_S: readonly string[] = ["owner"];
const TIER_A: readonly string[] = ["homepage", "google_places"];
const TIER_B: readonly string[] = ["brreg", "facebook_official_page"];

export function tierForSource(sourceType: string): SourceTier {
  if (TIER_S.includes(sourceType)) return "S";
  if (TIER_A.includes(sourceType)) return "A";
  if (TIER_B.includes(sourceType)) return "B";
  return "C";
}

// ─── Field-specific value normalization ────────────────────────────────────

function normalizeAddress(raw: string): string {
  return raw
    .toLowerCase()
    // normalize spacing around commas
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(raw: string): string {
  // Strip +47, 0047, leading +, then remove all non-digit characters
  return raw
    .replace(/^\+47/, "")
    .replace(/^0047/, "")
    .replace(/^\+/, "")
    .replace(/[\s\-().]/g, "")
    .replace(/\D/g, "");
}

function normalizeBusinessStatus(raw: string): string {
  return raw.toLowerCase().trim();
}

function normalizeValue(fieldName: FieldName, value: string): string {
  switch (fieldName) {
    case "address":
      return normalizeAddress(value);
    case "phone":
      return normalizePhone(value);
    case "business_status":
      return normalizeBusinessStatus(value);
  }
}

// ─── Main cross-source agreement logic ─────────────────────────────────────

/**
 * Given the field_provenance for an agent (keyed by field name, value is an
 * array of ProvenanceRecord), decide whether the named field has sufficient
 * cross-source agreement to be considered trustworthy.
 *
 * fieldProvenance: the parsed field_provenance JSON from agent_knowledge.
 *   Shape: { address: ProvenanceRecord[], phone: ProvenanceRecord[], ... }
 *   Also accepts the legacy single-object shape per field (pre-WO-16 rows
 *   that the migration has not yet touched): detected by checking whether
 *   the field value is an object (not array), and treated as a 1-element
 *   array automatically.
 */
export function crossSourceAgreement(
  fieldProvenance: Record<string, ProvenanceRecord[] | ProvenanceRecord | unknown>,
  fieldName: FieldName
): CrossSourceResult {
  const raw = fieldProvenance[fieldName];

  // Coerce single-object (legacy) or missing to array
  let records: ProvenanceRecord[];
  if (!raw) {
    records = [];
  } else if (Array.isArray(raw)) {
    records = raw as ProvenanceRecord[];
  } else if (typeof raw === "object" && raw !== null) {
    // Legacy single-record shape: { value, source_type, ... }
    records = [raw as ProvenanceRecord];
  } else {
    records = [];
  }

  // Filter out records without a usable value
  const valid = records.filter((r) => typeof r.value === "string" && r.value.trim() !== "");

  if (valid.length === 0) {
    return { agree: false, source_count: 0, sources_used: [] };
  }

  const sources_used = valid.map((r) => r.source_type);

  // ── Tier-S override ───────────────────────────────────────────────────────
  const tierSRecord = valid.find((r) => tierForSource(r.source_type) === "S");
  if (tierSRecord) {
    return {
      agree: true,
      source_count: valid.length,
      sources_used,
    };
  }

  // ── Tier-A and Tier-B sources only ───────────────────────────────────────
  const highQuality = valid.filter((r) => {
    const t = tierForSource(r.source_type);
    return t === "A" || t === "B";
  });

  if (highQuality.length < 2) {
    // Fewer than 2 high-quality sources — cannot meet the bar regardless of agreement
    const mayHaveConflict = valid.length >= 2;
    return {
      agree: false,
      source_count: valid.length,
      sources_used,
      ...(mayHaveConflict
        ? {
            conflict: {
              values: valid.map((r) => ({ source: r.source_type, value: r.value })),
              severity: computeConflictSeverity(fieldName, valid),
            },
          }
        : {}),
    };
  }

  // ── Check agreement among Tier-A/B sources ────────────────────────────────
  const normalized = highQuality.map((r) => ({
    source: r.source_type,
    value: r.value,
    norm: normalizeValue(fieldName, r.value),
  }));

  // Find groups of sources that share the same normalized value
  const groups = new Map<string, string[]>(); // norm → [source_types]
  for (const n of normalized) {
    const existing = groups.get(n.norm) ?? [];
    existing.push(n.source);
    groups.set(n.norm, existing);
  }

  // Check if any normalized value has >=2 agreeing Tier-A/B sources
  let bestGroupCount = 0;
  for (const srcs of groups.values()) {
    if (srcs.length > bestGroupCount) bestGroupCount = srcs.length;
  }

  if (bestGroupCount >= 2) {
    return {
      agree: true,
      source_count: valid.length,
      sources_used,
    };
  }

  // ── Disagreement among all high-quality sources ───────────────────────────
  return {
    agree: false,
    source_count: valid.length,
    sources_used,
    conflict: {
      values: normalized.map((n) => ({ source: n.source, value: n.value })),
      severity: computeConflictSeverity(fieldName, highQuality),
    },
  };
}

function computeConflictSeverity(
  fieldName: FieldName,
  records: ProvenanceRecord[]
): "minor" | "major" {
  // If all values normalize to the same string, it's a minor formatting diff.
  // If any pair differs after normalization, it's a major conflict.
  const norms = records.map((r) => normalizeValue(fieldName, r.value));
  const first = norms[0] ?? "";
  const allSame = norms.every((n) => n === first);
  return allSame ? "minor" : "major";
}

// ─── Migration helper: coerce field_provenance from legacy single-record shape ─
// Used in the DB migration at boot time (see init.ts).
// Exported so tests can exercise the transformation directly.
export function coerceProvenanceToArrayShape(
  raw: Record<string, unknown>
): Record<string, ProvenanceRecord[]> {
  const result: Record<string, ProvenanceRecord[]> = {};
  for (const [field, val] of Object.entries(raw)) {
    if (Array.isArray(val)) {
      result[field] = val as ProvenanceRecord[];
    } else if (val && typeof val === "object") {
      // Single-record legacy shape → wrap in array
      result[field] = [val as ProvenanceRecord];
    }
    // null / primitive / undefined → skip (treated as [] by crossSourceAgreement)
  }
  return result;
}
