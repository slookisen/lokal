/**
 * about-source-substantiation.ts — dev-request 2026-08-22-rfbweb-about-guard:
 * a lightweight, deterministic (NO LLM) check that a candidate about/
 * description value the platform is about to WRITE actually appears in — or
 * is closely substantiated by — the raw source text it was purportedly
 * extracted FROM. Reference incident: the "Li Lynghonning" agent showed a
 * stale/mismatched about-text that did not match its actual current source
 * page — nothing in the enrichment pipeline ever checked a candidate against
 * its claimed source before writing it.
 *
 * Deliberately NOT the full LLM-judge machinery (contact-candidate-judge.ts /
 * admin-agents.ts's judgeRfbAboutCandidate): those already judge WHETHER a
 * candidate reads as coherent, on-topic, non-boilerplate prose — a semantic
 * QUALITY bar — but neither one checks the candidate against the page text
 * it claims to summarize, which is a different question ("is this true of
 * THIS page's current content", not "is this well-written"). This is a
 * narrower, cheaper, purely textual "is this actually SUPPORTED by the
 * source" check, meant to sit ALONGSIDE those judges (defense in depth,
 * additive), not replace them.
 *
 * Fail-closed philosophy (same spirit as the LLM-judge modules, without the
 * network/JSON failure modes those have to handle — this is pure string
 * matching, nothing here can throw on a well-formed string input): a
 * missing/empty candidate or missing/empty source text can never be
 * verified, so it is NEVER treated as substantiated. Callers must treat
 * `substantiated: false` exactly like "this candidate is not eligible to
 * write" — never a partially-trusted value.
 *
 * Similarity bar (documented, not hidden — a deliberate judgment call, see
 * the dev-request's own acceptance note asking for this to be explicit): the
 * candidate passes if EITHER
 *   (a) its whitespace/case/HTML-entity-normalised text is a literal
 *       SUBSTRING of the (identically normalised) source — covers the
 *       common case where the candidate is an exact excerpt or `<meta>`
 *       attribute value copied verbatim from the page. search-enrich.ts's
 *       summarizeAbout() — the RFB about/description extractor this check
 *       is designed to sit next to — has exactly three extraction modes
 *       (og:description, `<meta name="description">`, first substantive
 *       visible paragraph) and ALL THREE are verbatim excerpts of the source
 *       html, so a genuinely-fresh candidate should almost always hit this
 *       branch; OR
 *   (b) a "close paraphrase" bar: at least MIN_SIGNIFICANT_WORD_MATCHES (3)
 *       of the candidate's own significant words (>=4 letters, common
 *       stopwords excluded) appear as whole words in the source, AND that
 *       count is >= WORD_OVERLAP_RATIO (0.7) of the candidate's own DISTINCT
 *       significant words. This is deliberately generous toward TRUE
 *       positives (a real paraphrase of the same page should clear it
 *       easily — most of its content words are the page's own words) and
 *       strict toward FALSE positives (an unrelated candidate sharing a
 *       couple of generic words should not clear a 70% bar). Both constants
 *       are a documented judgment call, not a scientifically-derived
 *       threshold — tune WORD_OVERLAP_RATIO up (stricter) if false POSITIVES
 *       (a wrong candidate slipping through) are observed in practice, or
 *       down (looser) if false NEGATIVES (a genuinely-matching candidate
 *       getting rejected, e.g. because the extractor lightly reworded it)
 *       turn out to be the bigger problem.
 *
 * Callers are expected to pass a SOURCE that includes BOTH the raw fetched
 * HTML (so `<meta ...content="...">` values — which never survive a
 * tag-stripping pass — are still present as literal text) and any separate
 * tag-stripped visible-text extraction they already computed (so a
 * candidate drawn from prose broken across inline tags, e.g.
 * "Vi produserer <strong>ekte</strong> gårdshonning", still matches as
 * contiguous text) — concatenating both is the simplest correct choice and
 * costs nothing extra (this function decodes entities and normalises
 * whitespace on whatever it is given either way, so passing extra text that
 * doesn't help just costs a slightly bigger string).
 */

import { decodeHtmlEntities } from "./search-enrich";

export interface AboutSubstantiationVerdict {
  substantiated: boolean;
  reason: string;
}

const MIN_SIGNIFICANT_WORD_MATCHES = 3;
const WORD_OVERLAP_RATIO = 0.7;
const MIN_SIGNIFICANT_WORD_LENGTH = 4;

// A small Norwegian + English stopword list — words too generic to count as
// "significant" evidence of substantiation on their own (a candidate built
// almost entirely of these would otherwise clear the overlap ratio for
// free, since they are common in nearly ANY Norwegian source text).
const ABOUT_SUBSTANTIATION_STOPWORDS = new Set([
  "som", "for", "med", "det", "den", "denne", "disse", "dette", "vare",
  "vart", "eller", "ikke", "ikkje", "har", "hos", "fra", "til", "over",
  "under", "hvor", "hvordan", "alle", "sine", "deres", "blir", "vart",
  "our", "with", "from", "that", "this", "these", "those", "have", "will",
  "your", "about", "into", "when", "where", "which", "there", "their",
  "been", "were", "also",
]);

/** Lowercase, decode HTML entities, collapse whitespace, trim. PURE. */
function normalizeForMatch(text: string): string {
  return decodeHtmlEntities(text)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinct "significant" words (>= MIN_SIGNIFICANT_WORD_LENGTH letters/
 *  digits, common stopwords excluded) from `text`, normalised. PURE. */
function significantWords(text: string): Set<string> {
  const normalized = normalizeForMatch(text);
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(
    words.filter((w) => w.length >= MIN_SIGNIFICANT_WORD_LENGTH && !ABOUT_SUBSTANTIATION_STOPWORDS.has(w)),
  );
}

/**
 * Verify that `candidate` (an about/description value about to be written)
 * is actually substantiated by `sourceText` (the raw text — HTML included —
 * it was purportedly extracted from). See the module header comment for the
 * exact contract, similarity bar, and fail-closed philosophy. PURE, no
 * network/IO — safe to call synchronously on every candidate write.
 */
export function checkAboutCandidateSubstantiatedBySource(
  candidate: string | null | undefined,
  sourceText: string | null | undefined,
): AboutSubstantiationVerdict {
  const cand = (candidate ?? "").trim();
  const src = (sourceText ?? "").trim();
  if (!cand) {
    return { substantiated: false, reason: "candidate is empty — nothing to substantiate" };
  }
  if (!src) {
    return { substantiated: false, reason: "no source text available to verify against — cannot verify, fail-closed" };
  }

  const normCand = normalizeForMatch(cand);
  const normSrc = normalizeForMatch(src);
  if (normCand.length > 0 && normSrc.includes(normCand)) {
    return { substantiated: true, reason: "candidate text found verbatim (normalised) in source" };
  }

  const candWords = significantWords(cand);
  if (candWords.size === 0) {
    return {
      substantiated: false,
      reason: "candidate has no significant words to match against the source — cannot verify, fail-closed",
    };
  }
  const srcWords = significantWords(src);
  let matched = 0;
  for (const w of candWords) {
    if (srcWords.has(w)) matched++;
  }
  const ratio = matched / candWords.size;
  if (matched >= MIN_SIGNIFICANT_WORD_MATCHES && ratio >= WORD_OVERLAP_RATIO) {
    return {
      substantiated: true,
      reason: `close paraphrase: ${matched}/${candWords.size} significant words (${Math.round(ratio * 100)}%) also appear in source`,
    };
  }
  return {
    substantiated: false,
    reason:
      `candidate text not found in source and only ${matched}/${candWords.size} significant words overlap ` +
      `(need >= ${MIN_SIGNIFICANT_WORD_MATCHES} matches and >= ${Math.round(WORD_OVERLAP_RATIO * 100)}% overlap) — ` +
      `treating as unsubstantiated, fail-closed`,
  };
}
