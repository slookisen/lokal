/**
 * about-fact-substantiation.ts — dev-request
 * 2026-09-24-stikkproeve-undersider-og-faktanivaa-about (Del B).
 *
 * A SECOND, separate substantiation check for the `about` field, used ONLY
 * by the read-only WEEKLY spot-check (`computeFieldSpotCheck`'s
 * `deps.substantiate` injection point, wired in from
 * `src/routes/admin-field-spot-check.ts` for `field_name === "about"` only).
 *
 * This module does NOT touch, replace, or weaken
 * `about-source-substantiation.ts`'s `checkAboutCandidateSubstantiatedBySource`,
 * which remains, byte-for-byte, the WRITE-GUARD used before a new `about`
 * value is ever written (admin-knowledge.ts). That guard's word-overlap bar
 * is deliberately strict because a false PASS there can cause a wrong value
 * to be persisted. This module's false PASS can, at worst, produce one wrong
 * `match` line in a human-read weekly report — it can never cause a write.
 * Given that asymmetry, this module trades some of the write-guard's
 * strictness for tolerance of dialectal/paraphrase rewording (the documented
 * bug: a Nynorsk stored `about` vs. a Bokmål page, or similar light
 * rewording, shares the same underlying FACTS but falls under the
 * write-guard's 70% significant-word-overlap bar).
 *
 * ── Why "is a fact present anywhere on the page" is not enough (history) ──
 *
 * Three prior implementation rounds on this exact problem were each rejected
 * by an independent adversarial code review, each for a reproduced defect,
 * not a style nit (full history:
 * protocols/orchestrator-failures/2026-09-24-stikkproeve-faktanivaa-about-delb.md
 * in the A2A control repo):
 *
 *   Round 1 (bare fact-presence anywhere on the page, >=2 facts): a
 *   fabricated candidate could borrow 2 unrelated tokens scattered in the
 *   page's own nav/footer (a phone number's digit run, an unrelated
 *   capitalized nav-link word) and score a false `substantiated: true`.
 *
 *   Round 2 (facts raised to >=3 + a fixed 500-character sliding-window
 *   proximity requirement around each fact): closed round 1's hole, but (a)
 *   an ordinary Norwegian contact/org-nr footer block (name + street + a
 *   year, naturally close together) still gave a false `true` for a
 *   fabricated founding story built from exactly those three loaned tokens,
 *   and (b) the module's OWN positive fixture (Vollan Gård) started FAILING
 *   because the real page's genuine prose between two real facts was ~1.4kB
 *   — longer than the fixed window — reintroducing the very false-mismatch
 *   class this feature exists to close, via a different mechanism (a
 *   character-count window too tight for real prose).
 *
 *   Round 3 (dropped the window; combined signal = 100% fact coverage AND
 *   overall-candidate word overlap >= 45%): fixed both round-2 defects, but
 *   splicing just TWO sentences of real, correct page prose into an
 *   otherwise-fabricated candidate (the actual shape a hallucinating LLM
 *   tends to produce — mostly invented, grounded by a couple of real
 *   snippets) lifted the OVERALL overlap signal past 45% independently of
 *   the FACT-coverage signal, which was still 100% purely from loaned footer
 *   tokens — so the two signals, each satisfiable by a different, unrelated
 *   part of the page, together let a materially false candidate through.
 *
 * ── This module's approach: tie the two signals to the SAME location ──
 *
 * The common thread in all three defeats: "fact found somewhere" and
 * "overall word overlap is high" were computed as two INDEPENDENT global
 * signals over the whole page, so an adversarial candidate could satisfy
 * each one from a different, unrelated part of the source (loan facts from
 * a compact footer; borrow overlap from real prose elsewhere).
 *
 * Instead of a global overlap number, this module requires that each
 * matched fact's own LOCAL context — the paragraph-/sentence-bounded block
 * of source text it actually sits in (found via HTML block-level tag
 * boundaries when the source carries markup, or sentence-grouped windows
 * otherwise — never a fixed character count) — itself shares a meaningful
 * amount of the candidate's OTHER vocabulary (explicitly excluding the fact
 * tokens themselves, so borrowing the fact words alone can never satisfy
 * this on its own). A genuine biography paragraph naturally shares many
 * other words with a true paraphrase of it. A compact footer/contact block
 * (address, org-nr, phone, one bare year) does not — it is short and
 * otherwise unrelated to a fabricated narrative built around it. And real
 * prose spliced in from ELSEWHERE on the page cannot corroborate a fact that
 * does not live in that same block, so round 3's exact defeat (splice real
 * prose from one place, loan facts from another) no longer works: the two
 * signals are now required to co-occur in the same local block, not just
 * both be true somewhere on the page.
 *
 * ── Residual risk (honest, not "narrow" or "theoretical") ──
 *
 * This is a heuristic over plain text, not a semantic fact-checker. A
 * candidate whose fabricated portion sits, in the source HTML, in the SAME
 * block-level element as a paragraph that genuinely discusses the borrowed
 * facts (e.g. a single long about-us paragraph on the real page that
 * mentions the founding year AND also happens to share enough incidental
 * vocabulary with a partially-invented rewrite of itself) could still pass.
 * This is deliberately a narrower and much more expensive-to-construct
 * exploit than any of the three rounds above (it requires the fabricated
 * and the real, fact-bearing content to be adjacent in the SAME structural
 * block, not just anywhere on the page) but it is not impossible, and this
 * comment does not claim it is. Given this measurement is read-only, feeds a
 * human-read weekly report, and cannot itself cause a wrong value to be
 * WRITTEN (the write-guard above is untouched and unaffected by anything in
 * this file), that residual risk is accepted rather than chased further.
 *
 * ── Fact extraction (per the dev-request spec) ──
 *
 * A candidate's "facts" are its own DISTINCT:
 *   - numbers with >= 3 digits (years, etc.), and
 *   - proper nouns: capitalized words, NOT sentence-initial, >= 4 letters.
 * A candidate with fewer than MIN_FACTS (2) such facts cannot be judged at
 * the fact level at all (too little to corroborate anything against) and
 * falls back, unchanged, to `checkAboutCandidateSubstantiatedBySource`'s
 * existing (a)/(b) rules.
 */

import { decodeHtmlEntities } from "./search-enrich";
import {
  checkAboutCandidateSubstantiatedBySource,
  type AboutSubstantiationVerdict,
} from "./about-source-substantiation";

export type { AboutSubstantiationVerdict };

const MIN_FACTS = 2;
const FACT_COVERAGE_RATIO = 0.8;
const MIN_PROPER_NOUN_LENGTH = 4;
const MIN_DIGIT_RUN_LENGTH = 3;

// Local-context corroboration bar: how much of the candidate's OTHER
// (non-fact) significant vocabulary a fact's own local block must share
// with the candidate before that fact counts as genuinely corroborated
// (not merely "the token is present somewhere"). Deliberately re-uses the
// write-guard's own MIN_SIGNIFICANT_WORD_LENGTH-style word definition so the
// two modules agree on what counts as a "significant word" at all.
const LOCAL_MIN_CONTEXT_WORD_MATCHES = 3;
const LOCAL_CONTEXT_OVERLAP_RATIO = 0.2;
const MIN_SIGNIFICANT_WORD_LENGTH = 4;

// Same block-level tag set fetch-page.ts's callers already treat as
// paragraph/section boundaries when reasoning about page structure — used
// here to carve the raw-HTML half of the source (see `structuredPortion`;
// the flattened `visibleTextOf()` half is excluded before this point is
// ever reached) into paragraph-like "blocks" without a fixed character
// count. Anything left over that ISN'T naturally chunked this way — a real
// block-level element whose OWN contents are unusually long with no further
// internal tag structure, or plain non-HTML source text in a test fixture
// that never had tags to begin with — is further divided into small
// sentence-grouped windows — bounded by sentence punctuation, never by a
// fixed character count — so a long, single, untagged blob of text can
// never become one giant "the whole page is this fact's local context"
// block (that would just reintroduce round 3's global-overlap defeat under
// a new name).
const BLOCK_TAG_RE =
  /<\/?(?:p|div|li|td|th|tr|header|footer|nav|section|article|blockquote|address|h[1-6]|br)\b[^>]*>/gi;
const MAX_BLOCK_CHARS_BEFORE_SENTENCE_SPLIT = 500;
const SENTENCE_WINDOW_SIZE = 3;

// Small, generic Norwegian + English stopword list — deliberately the SAME
// generic function words as about-source-substantiation.ts's own list (a
// separate, independent copy, not imported — this module must have zero
// coupling to the write-guard's internals so a future edit to one can never
// silently change the other's behavior). Deliberately NOT hand-picked to
// include dialect-pair words (e.g. nynorsk "sidan" vs bokmål "siden") — this
// module's tolerance for dialectal rewording comes from the LOCAL_CONTEXT_*
// ratio being modest, not from curating which words "don't count", which
// would just be re-fitting the stopword list to one known fixture.
const STOPWORDS = new Set([
  "som", "for", "med", "det", "den", "denne", "disse", "dette", "vare",
  "vart", "eller", "ikke", "ikkje", "har", "hos", "fra", "til", "over",
  "under", "hvor", "hvordan", "alle", "sine", "deres", "blir",
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

/** Distinct significant words (>=4 letters/digits, stopwords excluded),
 *  normalised. Mirrors the write-guard's own definition so both modules
 *  agree on what "a significant word" means, without importing from it.
 *  PURE. */
function significantWords(text: string): Set<string> {
  const normalized = normalizeForMatch(text);
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(
    words.filter((w) => w.length >= MIN_SIGNIFICANT_WORD_LENGTH && !STOPWORDS.has(w)),
  );
}

interface CandidateFacts {
  /** Distinct fact tokens (numbers as digit strings, proper nouns
   *  lowercased) — what must be found, with local corroboration, in the
   *  source. */
  tokens: string[];
  /** The candidate's own significant words MINUS the fact tokens above —
   *  the "other content" a fact's local block must independently overlap
   *  with. Deliberately excludes the fact tokens themselves so a block
   *  that merely repeats the loaned fact cannot self-corroborate. */
  contextWords: Set<string>;
}

/** Split `text` into sentences on '.', '!', '?' or '…' followed by
 *  whitespace (or end of string). A deliberately simple heuristic — good
 *  enough to find sentence-initial words and to group untagged text into
 *  small pseudo-paragraphs; not a full sentence tokenizer. PURE. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Extract the candidate's own distinct facts (numbers with >=3 digits;
 *  proper nouns — capitalized, not sentence-initial, >=4 letters) plus its
 *  remaining significant vocabulary. Operates on the ORIGINAL (not
 *  lowercased) candidate text so capitalization is still visible. PURE. */
function extractCandidateFacts(candidate: string): CandidateFacts {
  const decoded = decodeHtmlEntities(candidate).normalize("NFKC");
  const properNouns = new Set<string>();
  for (const sentence of splitSentences(decoded)) {
    const words = sentence.match(/[\p{L}][\p{L}\p{N}'-]*/gu) ?? [];
    words.forEach((w, i) => {
      if (i === 0) return; // sentence-initial position excluded, per spec
      if (w.length < MIN_PROPER_NOUN_LENGTH) return;
      const first = w[0]!;
      if (first.toUpperCase() === first && first.toLowerCase() !== first) {
        properNouns.add(w.toLowerCase());
      }
    });
  }
  const numbers = new Set<string>();
  for (const m of decoded.matchAll(/(?<!\d)\d+(?!\d)/g)) {
    if (m[0].length >= MIN_DIGIT_RUN_LENGTH) numbers.add(m[0]);
  }

  const tokens = [...numbers, ...properNouns];
  const factTokenSet = new Set(tokens);
  const contextWords = new Set(
    [...significantWords(candidate)].filter((w) => !factTokenSet.has(w)),
  );
  return { tokens, contextWords };
}

/**
 * `computeFieldSpotCheck` always builds its `sourceText` as EXACTLY
 * `${html}\n${visibleTextOf(html)}` — a single literal "\n" joining the raw
 * fetched markup to a SECOND, fully tag-stripped copy of the same content
 * (see lokal-agent-verifier.ts's `computeFieldSpotCheck`, both call sites:
 * `rootSourceText`/`subSourceText`, both `` `${...html}\n${visibleTextOf(...html)}` ``
 * — a fixed contract this module relies on but never changes). That second,
 * flattened half carries no structural boundaries at all: naively
 * blockifying it (e.g. via the sentence-window fallback below) can glue a
 * page's real body prose directly onto its footer/nav text whenever they
 * happen to land in the same sentence-count window — reintroducing, through
 * the fallback path itself, exactly the "local context" that isn't really
 * local this module exists to rule out (round 3's defeat, recreated by a
 * different mechanism). This function must therefore isolate ONLY the raw
 * HTML half before blockifying.
 *
 * FIXED (4th-attempt fix-up round 1): an earlier version of this function
 * located that boundary by scanning for the LAST '>' character in the whole
 * string, reasoning that it would sit at the end of the raw HTML's own final
 * tag and never recur once `visibleTextOf()`'s tag-free output begins. That
 * is CONTENT-dependent, not structure-dependent, and wrong: `visibleTextOf()`
 * only strips real `<...>` tags and HTML entities — it does NOT remove a
 * bare, legal '>' that appears in ordinary page text (a breadcrumb like
 * "Hjem > Om > Kontakt", a "Les mer >" link, a menu). Such a '>' survives
 * into the flattened tail verbatim, at whatever position its source text
 * occupied — so `lastIndexOf(">")` could land inside the flattened tail
 * itself, folding a chunk of tag-free flattened text into "the structured
 * portion" and letting the sentence-window fallback below glue unrelated
 * real elements (e.g. an `<article>`'s last sentence and a `<footer>`'s
 * address) into one fake "local block". Reproduced and fixed; see this
 * module's test file, section F.
 *
 * The FIX: split on the literal "\n" SEPARATOR itself, not on any character
 * that can legitimately occur in page content. This is safe because
 * `visibleTextOf()` collapses every run of whitespace (`\s`, which includes
 * "\n") to a single ASCII space and then trims — by construction, its output
 * can NEVER contain a "\n" character, no matter what the source page's text
 * contains. The raw HTML half, in contrast, commonly does contain "\n" (real
 * markup is rarely one line), but that never matters: because the flattened
 * tail — which comes entirely AFTER the separator — is guaranteed to have
 * zero "\n" characters anywhere in it, the LAST "\n" in the whole combined
 * string is unconditionally the join separator itself, regardless of how
 * many "\n"s appear earlier in the raw HTML or what characters (">" or
 * otherwise) appear in either half's content. This is a structural
 * invariant of the two pure functions being concatenated, not a heuristic
 * about what's "unlikely" to appear in text.
 *
 * A guard still applies: the text before that boundary must itself look
 * like HTML (contain a real tag) before we trust the split — otherwise this
 * isn't the `${html}\n${visibleTextOf(html)}` shape at all (e.g. a
 * plain-text test fixture that happens to contain an embedded newline for
 * unrelated reasons), and the whole string is used unchanged, exactly as
 * when no boundary is found at all. */
function structuredPortion(sourceText: string): string {
  const lastSeparator = sourceText.lastIndexOf("\n");
  if (lastSeparator === -1) return sourceText;
  const htmlHalf = sourceText.slice(0, lastSeparator);
  if (!/<[a-z][^>]*>/i.test(htmlHalf)) return sourceText;
  return htmlHalf;
}

/** Divide `sourceText` into paragraph-/sentence-bounded "blocks" — carved
 *  from HTML block-level tag boundaries where the source carries markup,
 *  and from sentence-grouped windows for any leftover untagged text (never
 *  a fixed character count for either). PURE. */
function blockify(sourceText: string): string[] {
  const rawChunks = structuredPortion(sourceText).split(BLOCK_TAG_RE);
  const blocks: string[] = [];
  for (const raw of rawChunks) {
    // Strip any remaining (non-block-level, e.g. <strong>/<a>/<span>) tags,
    // then normalise. Keeps inline-tag-broken prose contiguous, same
    // rationale as about-source-substantiation.ts's own callers.
    const text = normalizeForMatch(raw.replace(/<[^>]+>/g, " "));
    if (!text) continue;
    if (text.length <= MAX_BLOCK_CHARS_BEFORE_SENTENCE_SPLIT) {
      blocks.push(text);
      continue;
    }
    // No fine-grained tag structure inside this chunk — either a single
    // large real block-level element's contents with no further internal
    // tags (e.g. one long `<article>` paragraph), or plain non-HTML source
    // text in a test fixture that never had tags to begin with (the
    // flattened `visibleTextOf()` half is excluded before `blockify` is ever
    // reached — see `structuredPortion`). Group into small sentence-bounded
    // windows instead of treating the whole thing as one "local context"
    // block.
    const sentences = splitSentences(text);
    if (sentences.length === 0) {
      blocks.push(text);
      continue;
    }
    for (let i = 0; i < sentences.length; i += SENTENCE_WINDOW_SIZE) {
      blocks.push(sentences.slice(i, i + SENTENCE_WINDOW_SIZE).join(" "));
    }
  }
  return blocks;
}

/** Whether `factToken` (a lowercased proper noun, or a digit string) occurs
 *  as a whole token inside `block` (already normalised/lowercased). PURE. */
function blockContainsFact(block: string, factToken: string): boolean {
  if (/^\d+$/.test(factToken)) {
    return new RegExp(`(?<!\\d)${factToken}(?!\\d)`).test(block);
  }
  return significantWords(block).has(factToken);
}

/** Whether `block` corroborates the candidate independently of the fact
 *  tokens themselves — i.e. shares enough of the candidate's OTHER
 *  significant vocabulary. PURE. */
function blockCorroborates(block: string, contextWords: Set<string>): boolean {
  if (contextWords.size === 0) {
    // A candidate that is nothing BUT fact tokens has no other content to
    // corroborate against — cannot be verified beyond "the facts are
    // present", which alone is exactly what round 1 showed is not enough.
    // Fail closed rather than vacuously pass.
    return false;
  }
  const blockWords = significantWords(block);
  let matched = 0;
  for (const w of contextWords) {
    if (blockWords.has(w)) matched++;
  }
  const ratio = matched / contextWords.size;
  return matched >= LOCAL_MIN_CONTEXT_WORD_MATCHES && ratio >= LOCAL_CONTEXT_OVERLAP_RATIO;
}

/**
 * Fact-level substantiation check for the `about` field's read-only WEEKLY
 * spot-check ONLY (`computeFieldSpotCheck`'s `deps.substantiate`). See this
 * module's header for the full contract, failure history, and residual
 * risk. NEVER used as a write-guard — see about-source-substantiation.ts
 * for that, unchanged and untouched by this file.
 *
 * A candidate is `substantiated: true` when it has at least MIN_FACTS (2)
 * distinct facts (numbers with >=3 digits; proper nouns, not
 * sentence-initial, >=4 letters) AND at least FACT_COVERAGE_RATIO (80%) of
 * them are found in the source WITH local corroboration (see
 * `blockCorroborates`). A candidate with fewer than MIN_FACTS facts falls
 * back, unchanged, to `checkAboutCandidateSubstantiatedBySource`.
 */
export function checkAboutCandidateFactSubstantiated(
  candidate: string | null | undefined,
  sourceText: string | null | undefined,
): AboutSubstantiationVerdict {
  const cand = (candidate ?? "").trim();
  if (!cand) {
    return checkAboutCandidateSubstantiatedBySource(candidate, sourceText);
  }

  const { tokens, contextWords } = extractCandidateFacts(cand);
  if (tokens.length < MIN_FACTS) {
    return checkAboutCandidateSubstantiatedBySource(candidate, sourceText);
  }

  const src = (sourceText ?? "").trim();
  if (!src) {
    return {
      substantiated: false,
      reason: "no source text available to verify against — cannot verify, fail-closed",
    };
  }

  const blocks = blockify(src);
  const unconfirmed: string[] = [];
  let confirmedCount = 0;
  for (const token of tokens) {
    const confirmed = blocks.some(
      (block) => blockContainsFact(block, token) && blockCorroborates(block, contextWords),
    );
    if (confirmed) confirmedCount++;
    else unconfirmed.push(token);
  }

  const ratio = confirmedCount / tokens.length;
  if (confirmedCount >= MIN_FACTS && ratio >= FACT_COVERAGE_RATIO) {
    return {
      substantiated: true,
      reason:
        `fact-level match: ${confirmedCount}/${tokens.length} distinct facts ` +
        `(${Math.round(ratio * 100)}%) found on the source with corroborating local context`,
    };
  }
  return {
    substantiated: false,
    reason:
      `fact-level mismatch: only ${confirmedCount}/${tokens.length} distinct facts ` +
      `(${Math.round(ratio * 100)}%) found with corroborating local context ` +
      `(need >= ${MIN_FACTS} confirmed and >= ${Math.round(FACT_COVERAGE_RATIO * 100)}%); ` +
      `unconfirmed: ${unconfirmed.join(", ") || "(none extracted)"} — treating as unsubstantiated, fail-closed`,
  };
}
