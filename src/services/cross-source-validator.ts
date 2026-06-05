// ─── cross-source-validator — Phase 5.3 / WO-16 ─────────────────────────────
//
// Pure-function module that decides whether a critical field has ≥2 independent
// sources that agree (or 1 Tier-S owner-curated source).
//
// Reference: supervisor-inbox/2026-05-07-work-order-16-phase5.3-cross-source.md
// PR-19 (2026-05-10): added per-field verdict so the verifier can split the
// gate into three buckets — pool_eligible / review_required / data_insufficient.

export type FieldName = "address" | "phone" | "business_status";
export type SourceTier = "S" | "A" | "B" | "C";

// Per-field verdict (PR-19 / 2026-05-10).
//   pool_eligible      — ≥2 high-quality sources agree, or Tier-S override
//   review_required    — exactly 1 source recorded; we have *some* data but
//                        cannot confirm it without a human
//   data_insufficient  — 0 sources recorded; the back-catalogue case where
//                        field_provenance is empty / missing → needs more
//                        enrichment, not human review
export type CrossSourceVerdict = "pool_eligible" | "review_required" | "data_insufficient";

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
  verdict: CrossSourceVerdict;
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
    // PR-19: 0 sources → the back-catalogue case. Cannot review without data.
    return { agree: false, source_count: 0, sources_used: [], verdict: "data_insufficient" };
  }

  const sources_used = valid.map((r) => r.source_type);

  // ── Tier-S override ───────────────────────────────────────────────────────
  const tierSRecord = valid.find((r) => tierForSource(r.source_type) === "S");
  if (tierSRecord) {
    return {
      agree: true,
      source_count: valid.length,
      sources_used,
      verdict: "pool_eligible",
    };
  }

  // ── Tier-A and Tier-B sources only ───────────────────────────────────────
  const highQuality = valid.filter((r) => {
    const t = tierForSource(r.source_type);
    return t === "A" || t === "B";
  });

  if (highQuality.length < 2) {
    // Fewer than 2 high-quality sources — cannot meet the bar regardless of agreement.
    // Verdict depends on total source_count: 1 source → review_required; ≥2 (but
    // mostly Tier-C) → review_required as well, since we have some data and could
    // potentially confirm by hand.
    const mayHaveConflict = valid.length >= 2;
    return {
      agree: false,
      source_count: valid.length,
      sources_used,
      verdict: "review_required",
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
      verdict: "pool_eligible",
    };
  }

  // ── Disagreement among all high-quality sources ───────────────────────────
  return {
    agree: false,
    source_count: valid.length,
    sources_used,
    verdict: "review_required",
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

// ─── Per-agent aggregate verdict (PR-19 / 2026-05-10, PR-26 / 2026-05-11) ────
//
// Given a map of field → CrossSourceResult, compute the agent-level verdict:
//   - any gating field with verdict='data_insufficient' → agent is data_insufficient
//   - else any gating field with verdict='review_required' → agent is review_required
//   - else (all gating fields pool_eligible) → agent is pool_eligible
//
// PR-26 (2026-05-11) policy: ONLY `address` and `phone` gate pool eligibility.
// `business_status` is intentionally excluded — it answers "is the business
// open?" and that's a Google-Places-canonical signal that is never
// crosscheckable against a homepage. Requiring 2-source cross-check on it
// makes it impossible for an agent to become pool-eligible without
// facebook/brreg data, which most Norwegian small producers don't have.
// The cross-source value for outreach is in address + phone (the fields
// used for delivery). business_status is still computed and surfaced in
// CrossSourceResult outputs for review-queue display — it just doesn't gate.
//
// This is the gate-split logic that the verifier and the migration both need.
const GATING_FIELDS: readonly string[] = ["address", "phone"];

export function aggregateVerdict(
  perField: Record<string, CrossSourceResult>
): CrossSourceVerdict {
  let hasInsufficient = false;
  let hasReview = false;
  for (const [field, r] of Object.entries(perField)) {
    // PR-26: skip non-gating fields (currently business_status).
    if (!GATING_FIELDS.includes(field)) continue;
    if (r.verdict === "data_insufficient") hasInsufficient = true;
    else if (r.verdict === "review_required") hasReview = true;
  }
  if (hasInsufficient) return "data_insufficient";
  if (hasReview) return "review_required";
  return "pool_eligible";
}

// ─── Domain-coherence check (orch-PR-20260512-33 / Eidsmo fix) ──────────────
//
// WO-16 cross-source agreement checks per-field self-consistency, but does
// not notice when fields are individually agreed-upon yet point to DIFFERENT
// legal entities. The Eidsmo case (2026-05-12): two companies share the same
// physical address; Google-Places enrichment overwrote the homepage/email
// for `Eidsmo Kjøtt` (orgnr 995662175, eidsmokjott.no) with the values from
// the SLAUGHTERHOUSE at the same address (Slakthuset Eidsmo Dullum AS,
// orgnr 988300020, slakthuset.no). The agent ended up with
// agents.url=eidsmokjott.no but knowledge.website=slakthuset.no and
// knowledge.email=post@slakthuset.no. Marketing then mailed the wrong
// company. This check compares the registrable domain of agents.url against
// knowledge.website + knowledge.email and flags mismatches as
// review_required.

export type DomainCoherenceResult = {
  coherent: boolean;
  reason?: string;
  agentHost?: string;
  knowledgeWebsiteHost?: string;
  knowledgeEmailHost?: string;
};

const FREE_MAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "proton.me",
  "protonmail.com",
  "icloud.com",
  "live.com",
  "msn.com",
  // Extended 2026-06-05 (lokal-agent-enrichment): Norwegian ISP / freemail
  // hosts surfaced as domain-coherence false positives in the review queue
  // (n=14 agents blocked solely by a personal email at one of these hosts;
  // online.no alone accounted for 12). A producer using a personal ISP
  // mailbox is not a distributor-misattribution signal.
  "online.no",
  "live.no",
  "hotmail.no",
  "yahoo.no",
  "outlook.no",
  "me.com",
  "mac.com",
  "posteo.no",
  "posteo.de",
  "frisurf.no",
  "altibox.no",
  "lyse.net",
  "c2i.net",
  "epost.no",
  "start.no",
  "broadpark.no",
  "getmail.no",
];

// Directory / aggregator hosts that frequently end up saved as `agents.url`
// by discovery (e.g. "https://hanen.no/produsent/<slug>"). When the agent
// URL itself is a directory listing, it is NOT the entity-truth signal —
// downstream enrichment correctly upgrades knowledge.website to the
// producer's real site. Skip the mismatch check entirely in that case.
// orch-PR-20260512-33 iteration 2: directory-host bypass.
// Extended 2026-05-19 (orch-PR-81): additional Norwegian discovery directories
// surfaced by domain-coherence false-positives in the review queue (n=102
// agents blocked solely by mismatches against these hosts). Categories:
// tourism guides (Visit-*), food-route directories (siderlandet, ostelandet,
// gronnguidetrondheim), REKO/Bondens-marked regional umbrellas (rekonorge,
// bondensmarkedtroms), Mathallen Oslo, self-pick directory (selvplukk),
// and local-food shop platforms (rensmak, godtlokalt). Both unicode and
// punycode forms included for IDN hosts (visitjæren.com).
export const KNOWN_DIRECTORY_HOSTS: ReadonlySet<string> = new Set([
  "1881.no",
  "bondebladet.no",
  "bondensmarked.no",
  "bondensmarkedtroms.no",
  "bondesmarked.no",
  "brreg.no",
  "facebook.com",
  "godtlokalt.no",
  "gronnguidetrondheim.no",
  "gulesider.no",
  "hanen.no",
  "instagram.com",
  "kortreist.no",
  "kortreistmat.no",
  "linkedin.com",
  "lokalmat.no",
  "mathallenoslo.no",
  "matnyhetene.no",
  "matprat.no",
  "ostelandet.no",
  "proff.no",
  "reko.no",
  "rekonorge.no",
  "rekoring.no",
  "rensmak.no",
  "selvplukk.com",
  "siderlandet.no",
  "siderruta.no",
  "visitgreateroslo.com",
  "visitjæren.com",
  "visitnorway.com",
  "visitnorway.no",
  "visittelemark.no",
  "xn--visitjren-w1a.com",
  // Extended 2026-06-04 (lokal-agent-enrichment): tourism guides and
  // local-food directories surfaced as domain-coherence false positives in
  // the review queue (n≈19 agents blocked solely by these agentHost values).
  "fjordnorway.com",
  "ivaldres.no",
  "matfatetringsaker.no",
  "meny.no",
  "smakavnordhordland.no",
  "sorlandssenteret.no",
  "statsforvalteren.no",
  "vingelen.com",
  "visitbo.no",
  "visitfredrikskadhvaler.com",
  "visitvestfold.com",
]);

export function isKnownDirectoryHost(host: string): boolean {
  return KNOWN_DIRECTORY_HOSTS.has(host);
}

// Multi-label public suffixes — kept tiny on purpose. For .co.uk / .com.au
// we take the last three labels; for everything else (incl. .no) the last
// two labels are the registrable domain.
const MULTI_LABEL_SUFFIXES: readonly string[] = ["co.uk", "com.au", "co.nz", "co.jp"];

function stripProtocol(s: string): string {
  return s.replace(/^https?:\/\//i, "").replace(/^\/\//, "");
}

function hostFromUrlLike(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  s = stripProtocol(s);
  // Drop path / query / fragment
  s = s.split("/")[0]!.split("?")[0]!.split("#")[0]!;
  // Drop userinfo / port
  s = s.split("@").pop()!.split(":")[0]!;
  s = s.replace(/^www\./i, "").toLowerCase();
  if (!s) return null;
  // IDN normalization (2026-06-05, lokal-agent-enrichment): unicode and
  // punycode forms of the same host must compare equal (svanøylaks.no vs
  // svanoylaks.no false positives in the review queue). URL() converts
  // unicode hostnames to their punycode (ASCII) form.
  if (/[^\x00-\x7f]/.test(s)) {
    try {
      s = new URL(`http://${s}`).hostname.replace(/^www\./i, "");
    } catch {
      /* keep the raw lowercase host if it cannot be parsed */
    }
  }
  return s || null;
}

function hostFromEmail(raw: string): string | null {
  if (!raw.includes("@")) return null;
  const after = raw.split("@").pop();
  if (!after) return null;
  return hostFromUrlLike(after);
}

// Registrable domain (eTLD+1 with simple heuristics, sufficient for .no).
function registrableDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.includes(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

export function domainCoherenceCheck(
  agentUrl: string | null | undefined,
  knowledgeWebsite: string | null | undefined,
  knowledgeEmail: string | null | undefined
): DomainCoherenceResult {
  // No agent URL → nothing to validate against; do not penalize.
  if (!agentUrl || !agentUrl.trim()) return { coherent: true };

  const agentHost = hostFromUrlLike(agentUrl);
  if (!agentHost) return { coherent: true };
  const agentRoot = registrableDomain(agentHost);

  const websiteHost = knowledgeWebsite && knowledgeWebsite.trim()
    ? hostFromUrlLike(knowledgeWebsite)
    : null;
  const emailHost = knowledgeEmail && knowledgeEmail.trim() && knowledgeEmail.includes("@")
    ? hostFromEmail(knowledgeEmail)
    : null;

  // Directory-host bypass: if agents.url points at a known directory/aggregator
  // (Hanen, Lokalmat, Brreg, …), it cannot be used as the entity-truth signal.
  // Trust knowledge.website / knowledge.email instead and return coherent.
  if (isKnownDirectoryHost(agentRoot)) {
    return {
      coherent: true,
      reason: undefined,
      agentHost,
      knowledgeWebsiteHost: websiteHost ?? undefined,
      knowledgeEmailHost: emailHost ?? undefined,
    };
  }

  // Website check (stronger signal — checked first so it takes precedence).
  if (websiteHost) {
    const websiteRoot = registrableDomain(websiteHost);
    if (websiteRoot !== agentRoot) {
      return {
        coherent: false,
        reason: `knowledge.website host ${websiteHost} != agents.url host ${agentHost}`,
        agentHost,
        knowledgeWebsiteHost: websiteHost,
        knowledgeEmailHost: emailHost ?? undefined,
      };
    }
  }

  // Email check — free-mail domains get a pass (personal address, not a
  // distributor-misattribution signal).
  if (emailHost) {
    if (!FREE_MAIL_DOMAINS.includes(emailHost)) {
      const emailRoot = registrableDomain(emailHost);
      if (emailRoot !== agentRoot) {
        return {
          coherent: false,
          reason: `knowledge.email host ${emailHost} != agents.url host ${agentHost}`,
          agentHost,
          knowledgeWebsiteHost: websiteHost ?? undefined,
          knowledgeEmailHost: emailHost,
        };
      }
    }
  }

  return {
    coherent: true,
    agentHost,
    knowledgeWebsiteHost: websiteHost ?? undefined,
    knowledgeEmailHost: emailHost ?? undefined,
  };
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
