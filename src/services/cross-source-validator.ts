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

// PR-130 (2026-06-10): parse a Norwegian address into a { core, postcode } pair
// for subset-aware agreement. The recurring false positive (~60+ review_required
// producers): a homepage gives a street-only address ("Nygårdsveien 10") while
// google_places gives the full form ("Nygårdsveien 10, 7320 Fannrem"). These are
// the SAME place but normalizeAddress() keyed them differently, so they never
// grouped and the agent stayed review_required despite 2 agreeing Tier-A sources.
// core = the first comma-segment (street + house number), space/punct-normalized.
// postcode = the first standalone 4-digit token anywhere (Norwegian postnummer).
export function parseAddressCore(raw: string): { core: string; postcode: string | null } {
  const lower = (raw || "").toLowerCase().trim();
  const firstSeg = lower.split(",")[0] ?? lower;
  const core = firstSeg
    .replace(/[^\p{L}\p{N}\s/.-]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,-]+|[\s.,-]+$/g, "")
    .trim();
  const pcMatch = lower.match(/(?<!\d)(\d{4})(?!\d)/);
  return { core, postcode: pcMatch ? pcMatch[1] : null };
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
  const v = raw.toLowerCase().trim().replace(/[\s-]+/g, "_");
  // PR-126: canonicalize business-status synonyms so that values describing
  // the SAME real-world state compare equal. The recurring false positive
  // (n=46 agents): Google-Places enrichment writes business_status
  // "OPERATIONAL" while the is_active-synthesized provenance writes "active".
  // Both mean "open for business" and both originate from google_places, yet
  // a raw lowercase compare flagged them as a MAJOR conflict and forced
  // review_required. PR-26 made business_status non-gating at the aggregate
  // level, but the per-field conflict still surfaced to downstream consumers
  // (enrichment worker, review-queue). Collapsing synonyms removes the
  // phantom conflict at the source so every consumer agrees.
  const OPEN = new Set(["active", "operational", "open", "open_now", "in_business", "aktiv"]);
  const TEMP_CLOSED = new Set(["closed_temporarily", "temporarily_closed", "midlertidig_stengt"]);
  const PERM_CLOSED = new Set([
    "closed", "inactive", "closed_permanently", "permanently_closed",
    "shut", "shutdown", "konkurs", "avviklet", "stengt",
  ]);
  if (OPEN.has(v)) return "operational";
  if (TEMP_CLOSED.has(v)) return "closed_temporarily";
  if (PERM_CLOSED.has(v)) return "closed_permanently";
  return v;
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

  // Check if any normalized value has >=2 agreeing Tier-A/B sources.
  let bestGroupCount = 0;
  if (fieldName === "address") {
    // PR-130: subset-aware address agreement. Group by street+number core; within
    // a core group the records agree only if their PRESENT postcodes do not
    // conflict (<=1 distinct postcode). So "Nygårdsveien 10" + "Nygårdsveien 10,
    // 7320 Fannrem" agree (one omits the postcode), while "Storgata 1, 0150 Oslo"
    // + "Storgata 1, 5003 Bergen" stay gated (two distinct postcodes = different
    // place). Exact street-core equality only — no prefix matching, so "Storgata 1"
    // never matches "Storgata 10".
    const byCore = new Map<string, { sources: string[]; postcodes: Set<string>; norms: Set<string> }>();
    for (const n of normalized) {
      const { core, postcode } = parseAddressCore(n.value);
      if (!core) continue;
      const g = byCore.get(core) ?? { sources: [], postcodes: new Set<string>(), norms: new Set<string>() };
      g.sources.push(n.source);
      if (postcode) g.postcodes.add(postcode);
      g.norms.add(n.norm);
      byCore.set(core, g);
    }
    for (const g of byCore.values()) {
      if (g.sources.length < 2 || g.postcodes.size > 1) continue;
      // PR-130 review hardening (finding 1): the subset merge (street-only ⊂
      // street+postcode) is only allowed when a postcode is actually present to
      // disambiguate. If NO postcode appears anywhere in the group, fall back to
      // the pre-PR-130 behaviour — agree only if the raw values are identical —
      // so two different "Storgata 1"-type addresses in different towns (neither
      // carrying a postcode) are NOT vacuously merged.
      if (g.postcodes.size === 0 && g.norms.size !== 1) continue;
      if (g.sources.length > bestGroupCount) bestGroupCount = g.sources.length;
    }
  } else {
    // Exact normalized-value grouping (unchanged) for phone / business_status.
    const groups = new Map<string, string[]>(); // norm → [source_types]
    for (const n of normalized) {
      const existing = groups.get(n.norm) ?? [];
      existing.push(n.source);
      groups.set(n.norm, existing);
    }
    for (const srcs of groups.values()) {
      if (srcs.length > bestGroupCount) bestGroupCount = srcs.length;
    }
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
  "gettyourguide.com",
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

// PR-126: hyphen/separator-insensitive registrable-domain equality. The
// recurring false positive (n=38 agents): a producer whose homepage/website
// is `liagard.no` but whose contact email is `post@lia-gard.no` (Lia Gard) —
// the same company using a cosmetic hyphenated alias of its own domain. A
// strict `!==` compare flagged this as distributor-misattribution and forced
// review_required. Collapsing separators before comparison treats
// `lia-gard.no` and `liagard.no` as the same registrable entity, while
// genuinely different domains (slakthuset.no vs eidsmokjott.no — the Eidsmo
// case) remain non-equivalent and stay gated.
function collapseDomain(root: string): string {
  // Strip hyphens from labels; keep dots (label/TLD separators) intact.
  return root.replace(/-/g, "");
}

// PR-129 (2026-06-10): the registrable label without its public suffix, with
// hyphens stripped. "vesteraalens.no" -> "vesteraalens", "brand.co.uk" -> "brand".
// Used for cross-TLD same-brand equivalence below.
function registrableLabel(root: string): string {
  const first = (root.split(".")[0] ?? root);
  return first.replace(/-/g, "");
}

// ─── orch-PR-20260613-domain-coherence FP reduction ──────────────────────────
//
// Problem: 93 of 124 review_required agents in the production queue are held by
// domain_coherence.coherent=false, many as FALSE POSITIVES caused by same-entity
// domain variants: IDN/punycode encoding, Norwegian char transliteration
// (æ↔ae, ø↔oe, å↔aa), www/shop prefixes (stripped earlier), hyphenation
// (handled by collapseDomain), possessive-s / definite-article suffix.
//
// Solution: add a host-normalization + similarity step that recognises same-entity
// variants while keeping real misattributions (aggregators, directories,
// municipalities) blocked. The denylist below ensures known aggregator labels
// are NEVER coerced to coherent by the new rules.

// Minimal RFC-3492 Bootstring decoder — decodes a single `xn--` ACE label to
// the unicode string it encodes. Only the label (without the `xn--` prefix) is
// passed in. Avoids the deprecated `node:punycode` module.
function decodePunycodeLabel(label: string): string {
  if (!label.startsWith("xn--")) return label;
  const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700;
  const INITIAL_BIAS = 72, INITIAL_N = 128;
  const input = label.slice(4); // strip "xn--"
  const output: number[] = [];
  let n = INITIAL_N, idx = 0, bias = INITIAL_BIAS;
  const dash = input.lastIndexOf("-");
  if (dash > 0) {
    for (let j = 0; j < dash; j++) output.push(input.charCodeAt(j));
  }
  let pos = dash > 0 ? dash + 1 : 0;
  const decodeDigit = (cp: number): number =>
    cp - 48 < 10 ? cp - 22 : cp - 65 < 26 ? cp - 65 : cp - 97 < 26 ? cp - 97 : BASE;
  const adaptBias = (delta: number, numPoints: number, first: boolean): number => {
    delta = first ? Math.floor(delta / DAMP) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    let k = 0;
    while (delta > ((BASE - TMIN) * TMAX) >> 1) { delta = Math.floor(delta / (BASE - TMIN)); k += BASE; }
    return Math.floor(k + (BASE - TMIN + 1) * delta / (delta + SKEW));
  };
  while (pos < input.length) {
    const oldi = idx; let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (pos >= input.length) return label; // malformed/truncated — fail safe
      const digit = decodeDigit(input.charCodeAt(pos++));
      idx += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
    }
    const out = output.length + 1;
    bias = adaptBias(idx - oldi, out, oldi === 0);
    n += Math.floor(idx / out);
    idx %= out;
    output.splice(idx, 0, n);
    idx++;
  }
  try { return String.fromCodePoint(...output); } catch { return label; }
}

// Transliterate Norwegian/Nordic unicode characters to their ASCII equivalents.
// Handles both directions of the common mappings used by Norwegian domain registrants:
//   æ → ae   ø → oe   å → aa
// (ø→o is not applied globally as it can cause spurious collapses)
function transliterateNorwegian(s: string): string {
  return s
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa");
}

// Compute the normalized brand token for similarity comparison.
// Steps: decode IDN label → transliterate Norwegian → strip hyphens →
// collapse double-a (aa→a) to unify å→aa vs å→a variants → lowercase.
// Input: a registrable-domain string like "xn--strehonning-98a.no" or "aakre-gard.no".
function normalizedBrandToken(root: string): string {
  const firstLabel = root.split(".")[0] ?? root;
  // Decode punycode if this label uses ACE encoding
  const unicode = decodePunycodeLabel(firstLabel);
  // Strip hyphens, lowercase
  let token = unicode.replace(/-/g, "").toLowerCase();
  // Transliterate Norwegian unicode → ASCII
  token = transliterateNorwegian(token);
  // Normalize double-a to single-a: catches "åkre→aakre" vs "åkre→akre" variants.
  // Limited to 'aa' sequences (not 'aaa') to avoid over-collapsing.
  token = token.replace(/(?<!a)aa(?!a)/g, "a");
  return token;
}

// Levenshtein edit distance (character-level), bounded to avoid O(n²) on long strings.
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length > 40 || b.length > 40) return Infinity; // safety guard
  const m = a.length, n = b.length;
  // Use a rolling two-row DP for space efficiency
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i, ...Array(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]!
        : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
    }
    prev = curr;
  }
  return prev[n]!;
}

// Aggregator / directory / municipality labels that must NEVER be coerced
// coherent by the new normalization-similarity rules, even if their normalized
// token happens to be close to a legitimate brand token. This is a defence-in-
// depth guard: the registrable-domain mismatch check already catches most of
// these, but belt-and-suspenders protection is warranted here.
const SIMILARITY_DENYLIST: ReadonlySet<string> = new Set([
  // Social / travel aggregators
  "yelp", "facebook", "instagram", "gettyourguide", "tripadvisor",
  "airbnb", "booking", "visitnorway", "visitnorwayno",
  // Norwegian directories / platforms
  "rettfrabonden", "bondensmarked", "bondensmarkedtroms", "lokalmat",
  "lokalmaten", "hanen", "rekonorge", "rekoring", "reko",
  "kortreist", "kortreistmat", "mathallenoslo", "godtlokalt",
  "selvplukk", "rensmak", "ostelandet", "siderlandet", "siderruta",
  "gronnguidetrondheim", "dehistoriske", "compassgroup",
  // Municipality / government
  "kommune", "statsforvalteren", "fylkeskommune",
  // Cooperatives / retailers
  "coop", "kiwi", "rema", "rema1000", "meny", "extra",
]);

// Return true when two normalized brand tokens are same-entity variants.
// Criteria (applied after denylist guard):
//   1. Exact match after normalization (catches IDN/punycode + transliteration variants)
//   2. One token is a substring of the other, both tokens ≥4 chars
//      (catches brand+suffix like kaffebrenneriet vs kaffebrenneriet-pv,
//       or eidsmo vs eidsmokjott — same Eidsmo company, different domains)
//   3. Edit distance ≤ 2, both tokens ≥6 chars
//      (catches single-char transliteration residuals like kraneskjokken vs kranekjokken,
//       bringebarlandet vs bringebaerlandet — the ae vs aer variant)
function brandTokensSimilar(ta: string, tb: string): boolean {
  if (!ta || !tb) return false;
  // Denylist: known aggregator / directory / municipality tokens must never be
  // coerced coherent by these rules (belt-and-suspenders on top of the
  // registrable-domain mismatch check that already blocks these).
  if (SIMILARITY_DENYLIST.has(ta) || SIMILARITY_DENYLIST.has(tb)) return false;
  // Generic domain stems (from GENERIC_DOMAIN_LABELS) must also not be coerced
  // coherent — two different producers can each own gard.no and gard.com.
  // (PR-129 already blocks this in the registrableLabel path; guard here too.)
  if (GENERIC_DOMAIN_LABELS.has(ta) || GENERIC_DOMAIN_LABELS.has(tb)) return false;
  // Short tokens (< 6 chars) risk false-positive collapses — e.g. "mat", "gard",
  // "fisk" — skip all similarity rules for them.
  if (ta.length < 6 || tb.length < 6) return false;
  if (ta === tb) return true;
  // Substring: one token wholly contains the other (brand + suffix / compound).
  // Both must be >= 4 chars (already satisfied by the len-6 guard above).
  if (ta.includes(tb) || tb.includes(ta)) return true;
  // Edit distance: normalisation residuals (ae/a variants, possessive-s, etc.).
  if (levenshteinDistance(ta, tb) <= 2) return true;
  return false;
}

function domainsEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  if (collapseDomain(a) === collapseDomain(b)) return true;
  // PR-129: cross-TLD same-brand equality. A producer using the same brand on a
  // different TLD (vesteraalens.no website vs post@vesteraalens.com email;
  // teksloseafood.no/.com) is the SAME company — these were stuck in
  // review_required as domain-coherence false positives. We treat the registrable
  // LABELS as equal only when they are identical AND distinctive (length >= 4),
  // so genuinely different companies (eidsmokjott.no vs slakthuset.no — the
  // Eidsmo contamination case) stay gated, and short generic labels
  // (mat.no vs mat.com) are NOT collapsed.
  const la = registrableLabel(a);
  const lb = registrableLabel(b);
  // Require an identical, distinctive label (>=6 chars) that is NOT a generic
  // local-food common noun — two different producers can each own e.g. gard.no
  // and gard.com, so generic stems must NOT collapse across TLDs (PR-129 review).
  if (la.length >= 6 && la === lb && !GENERIC_DOMAIN_LABELS.has(la)) return true;
  // orch-PR-20260613: Norwegian-variant / IDN-variant same-entity check.
  // After all exact/hyphen/TLD equivalences have been tried, compute the
  // normalised brand tokens (IDN-decoded, Norwegian-transliterated, aa-collapsed)
  // and apply the similarity rules. Genuine misattributions stay incoherent
  // because their brand tokens are far apart and not on the denylist.
  if (brandTokensSimilar(normalizedBrandToken(a), normalizedBrandToken(b))) return true;
  return false;
}

// Generic local-food / geography stems that are too common to treat as a unique
// brand across TLDs. Stored hyphen-stripped + lowercase (registrableLabel form).
const GENERIC_DOMAIN_LABELS: ReadonlySet<string> = new Set([
  "lokalmat", "kortreist", "kortreistmat", "produsent", "produsenter",
  "gardsmat", "gaardsmat", "bondensmarked", "bondemat", "norskmat",
  "bakeri", "bakeriet", "ysteri", "ysteriet", "bryggeri", "bryggeriet",
  "gartneri", "slakteri", "honning", "frukthage", "fiskemat", "sjomat",
  "kjottmat", "spekemat", "okologisk", "naturmat", "fjordmat", "fjellmat",
  // PR-129 review round 2 — compound generic food/geo stems that can collide
  // across TLDs between unrelated producers (false-positive direction).
  "fjordlaks", "fjellaks", "sjokolade", "villsau", "reinsdyr", "fjordrein",
  "gardsbakeri", "gardsysteri", "gardsost", "gardsmeieri", "bondegard",
  "fjellgard", "ostegard", "seterhonning", "gardshonning", "fjordfisk",
  "lokalmaten", "kortreistmat", "andelslandbruk", "selvplukk",
  // Norwegian geographic region stems — must NOT collapse unrelated entities sharing a region name
  "lofoten", "hardanger", "valdres", "setesdal", "sunnmore",
  "nordland", "telemark", "vestland", "trondelag", "sorlandet",
  "finnmark", "gudbrandsdalen",
]);

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
    if (!domainsEquivalent(websiteRoot, agentRoot)) {
      // orch-PR-20260614-1 (Option A / email-anchor): website-host mismatch is
      // non-blocking when the contact email host is equivalent to the agent host
      // (the deliverable contact confirms identity). Eidsmo-type cases (email host
      // != agent host) stay blocked.
      //
      // Real false-positive examples rescued by this rule:
      //   Gangstad Gårdsysteri: agent=ysteri.no, website=gangstad.no, email=post@ysteri.no
      //   Macks Ølbryggeri:     agent=mack.no,   website=mfrp.no,     email=kontakt@mack.no
      //   Domstein Sjømat:      agent=domstein.no,website=enghav.no,   email=post@domstein.no
      //
      // Must NOT rescue Eidsmo contamination:
      //   agent=eidsmokjott.no, website=slakthuset.no, email=post@slakthuset.no
      //   → email host (slakthuset.no) != agent host → no rescue → stays blocked.
      const emailAnchorsSite =
        emailHost !== null &&
        !FREE_MAIL_DOMAINS.includes(emailHost) &&
        domainsEquivalent(registrableDomain(emailHost), agentRoot);
      if (!emailAnchorsSite) {
        return {
          coherent: false,
          reason: `knowledge.website host ${websiteHost} != agents.url host ${agentHost}`,
          agentHost,
          knowledgeWebsiteHost: websiteHost,
          knowledgeEmailHost: emailHost ?? undefined,
        };
      }
      // Email anchors the agent identity — fall through to the email check below,
      // which will confirm consistency and return coherent: true.
    }
  }

  // Email check — free-mail domains get a pass (personal address, not a
  // distributor-misattribution signal).
  if (emailHost) {
    if (!FREE_MAIL_DOMAINS.includes(emailHost)) {
      const emailRoot = registrableDomain(emailHost);
      if (!domainsEquivalent(emailRoot, agentRoot)) {
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
