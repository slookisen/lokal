// ─── Organic-Certification Keyword Detector — PR-58 (Phase 5.11 C.1-C) ──
//
// Pure function: scans HTML for Norwegian/English organic-certification
// keywords (e.g., "Debio sertifisert", "Ø-merket", "økologisk produksjon")
// and returns a structured signal with confidence tier + evidence snippets.
//
// Used by lokal-agent-enrichment (Cowork scheduled task) when crawling a
// producer homepage. When `confidence >= "low"`, the SKILL POSTs to
// /admin/affiliations/auto-create with the producer-id, the Debio umbrella
// id, and the evidence — which inserts a `pending_confirmation` affiliation
// row tagged `source = 'inferred'`. The producer can later accept (via
// owner-portal) or reject (via /opt-out). The UI flags such pending rows
// with "antatt sertifisert via Debio (ikke bekreftet)".
//
// Why pure function (no fetch, no DB):
//   - Keeps the detector trivially testable (string in → struct out)
//   - The HTTP/DB orchestration lives in the SKILL + /admin endpoint,
//     keeping concerns separated.
//   - Dependency-free (no cheerio): a tiny regex strips <script>/<style>
//     so injected keywords inside scripts don't trigger false positives.
//
// Confidence tiers (mutually exclusive — highest wins):
//   - HIGH:   any HIGH-confidence keyword present → very likely certified
//   - MEDIUM: ≥2 MEDIUM-confidence keywords (no HIGH) → probably referencing org farming
//   - LOW:    ≥1 LOW-confidence keyword (no HIGH or MEDIUM) → could be aspirational

export type OrganicConfidence = "low" | "medium" | "high";

export type OrganicSignal = {
  detected: boolean;
  matched_keywords: string[];   // raw keyword text that fired
  evidence_snippets: string[];  // up to 3 short snippets (max 200 chars) showing keyword in context
  confidence: OrganicConfidence;
};

// ─── Keyword tiers — case-insensitive matching ───────────────────────
// HIGH-confidence: explicit certification claims (Debio is the Norwegian
// organic-certification body; Ø-merket is its consumer-facing label).
const HIGH_CONFIDENCE_KEYWORDS = [
  "debio sertifisert",
  "debio-sertifisert",
  "debio godkjent",
  "sertifisert økologisk",
  "ø-merket",
];

// MEDIUM-confidence: references organic farming as a practice — needs
// ≥2 hits to fire, since a single English/Norwegian phrase could be
// background context rather than a self-claim.
const MEDIUM_CONFIDENCE_KEYWORDS = [
  "økologisk produksjon",
  "organic farming",
  "organic produce",
];

// LOW-confidence: bare "økologisk" — used aspirationally ("vi tenker
// på å gå over til økologisk drift") as often as descriptively.
const LOW_CONFIDENCE_KEYWORDS = [
  "økologisk",
];

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Strip <script> and <style> tags (plus their contents) from HTML before
 * matching. Prevents JS-template strings or CSS comments from triggering
 * false positives. Uses non-greedy regex with `[\s\S]` (so `.` doesn't
 * need /s flag — works on older Node targets too).
 */
function stripScriptStyle(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
}

/**
 * Collapse all whitespace (newlines, tabs, multi-spaces) into single
 * spaces so a keyword that wraps across lines still matches as a unit.
 * Also strips HTML tags so "<p>Debio sertifisert</p>" matches.
 */
function normalize(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")        // strip remaining HTML tags
    .replace(/\s+/g, " ")            // collapse whitespace
    .trim();
}

/**
 * Find first occurrence of `keyword` in `haystack` (case-insensitive)
 * and return a snippet: 80 chars before + keyword + 80 chars after.
 * Trimmed to ≤200 chars total. Returns null if not found.
 */
function buildSnippet(haystack: string, keyword: string): string | null {
  const idx = haystack.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - 80);
  const end = Math.min(haystack.length, idx + keyword.length + 80);
  let snippet = haystack.slice(start, end).trim();
  if (snippet.length > 200) snippet = snippet.slice(0, 200);
  return snippet;
}

// ─── Public detector ─────────────────────────────────────────────────

export function detectOrganicCertification(html: string): OrganicSignal {
  if (typeof html !== "string" || html.length === 0) {
    return { detected: false, matched_keywords: [], evidence_snippets: [], confidence: "low" };
  }

  const stripped = stripScriptStyle(html);
  const normalized = normalize(stripped);
  const lower = normalized.toLowerCase();

  const matchedHigh: string[] = [];
  const matchedMedium: string[] = [];
  const matchedLow: string[] = [];

  for (const k of HIGH_CONFIDENCE_KEYWORDS) {
    if (lower.includes(k.toLowerCase())) matchedHigh.push(k);
  }
  for (const k of MEDIUM_CONFIDENCE_KEYWORDS) {
    if (lower.includes(k.toLowerCase())) matchedMedium.push(k);
  }
  for (const k of LOW_CONFIDENCE_KEYWORDS) {
    if (lower.includes(k.toLowerCase())) matchedLow.push(k);
  }

  // Determine tier — mutually exclusive, highest wins
  let confidence: OrganicConfidence;
  let matched: string[];
  let detected: boolean;

  if (matchedHigh.length >= 1) {
    confidence = "high";
    matched = [...matchedHigh, ...matchedMedium, ...matchedLow];
    detected = true;
  } else if (matchedMedium.length >= 2) {
    confidence = "medium";
    matched = [...matchedMedium, ...matchedLow];
    detected = true;
  } else if (matchedLow.length >= 1) {
    confidence = "low";
    matched = [...matchedLow];
    detected = true;
  } else {
    return {
      detected: false,
      matched_keywords: [],
      evidence_snippets: [],
      confidence: "low",
    };
  }

  // Build up to 3 evidence snippets — first match per unique keyword
  const evidence_snippets: string[] = [];
  const seenKeywords = new Set<string>();
  for (const k of matched) {
    if (evidence_snippets.length >= 3) break;
    if (seenKeywords.has(k.toLowerCase())) continue;
    seenKeywords.add(k.toLowerCase());
    const snippet = buildSnippet(normalized, k);
    if (snippet) evidence_snippets.push(snippet);
  }

  return {
    detected,
    matched_keywords: matched,
    evidence_snippets,
    confidence,
  };
}
