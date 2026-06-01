// ─── Name matcher utilities (Phase 5.11 C.2, 2026-05-16) ────────────
//
// Shared fuzzy-name matching primitives. Extracted from
// bm-events-scraper.ts so the Hanen scraper (hanen-scraper.ts) can use
// the same Norwegian-aware normalisation rules.
//
// Exports:
//   normaliseForMatch(s)          — NFC-lowercase, transliterate æ/ø/å,
//                                   strip punctuation, collapse whitespace
//   diceCoefficient(a, b)         — bigram Dice coefficient ∈ [0, 1].
//                                   Symmetric, robust on short strings.
//   nameSimilarity(a, b)          — convenience wrapper that applies
//                                   normaliseForMatch to both inputs
//                                   first, then returns Dice on the
//                                   normalised strings. Returns 1.0 for
//                                   exact normalised hit (short-circuit).
//                                   Returns 0 if either is empty.
//   bestMatch(needle, candidates) — returns the highest-scoring candidate
//                                   along with its score; null if no
//                                   candidate scores above 0.
//
// Why Dice (not Jaccard, not Levenshtein-ratio):
//   - Symmetric so order doesn't matter.
//   - Bigram-based: tolerates a missing accent or a swapped letter
//     without collapsing to 0 the way exact-equal would.
//   - O(n+m) per pair — fast enough for matching ~500 Hanen members
//     against ~1500 agents in a single scrape run.
//   - The bm-events-scraper's substring-overlap scorer is kept inside
//     that file because its semantics (longest-overlap wins) are
//     specific to BM's venue-name patterns; Dice is the right default
//     for fuzzy person/farm-name matching.

// ─── 1. normaliseForMatch ──────────────────────────────────────
// Identical semantics to the original private helper in
// bm-events-scraper.ts (verified by the PR-56 behavioural tests).
// Kept BM-prefix stripping for backward-compat, even though the
// Hanen scraper won\'t hit BM-prefixed strings — extra cost is one
// regex per call and the prefix would never accidentally collide.
//
// PR-94 (2026-06-01): hardened against non-ASCII apostrophe noise
// seen on bondensmarked.no — U+00B4 acute, U+2019 right single
// quote, U+0060 backtick, U+2032 prime, U+2018 left single quote,
// U+0301 combining acute, U+00B7 middle dot. These are stripped
// BEFORE the non-alphanumeric collapse so they don\'t survive as
// spaces (which would split a single token in two and break Dice).
//
// Suffix stripping for BM events (`-et`/`-en`/`martn`→`marked`) is
// in a separate function `normaliseBmLocation` below — applying it
// here would over-strip Hanen producer names like "Stordalen Bruk AS"
// (the "-en" rule would wrongly collapse "stordalen" → "stordal").
export function normaliseForMatch(s: string): string {
  if (!s) return "";
  return s
    .normalize("NFC")
    .toLowerCase()
    // PR-94: strip non-ASCII apostrophe/quote/prime variants up front
    // so they don\'t survive into the non-alphanumeric collapse step.
    .replace(/[\u00B4\u2018\u2019\u0060\u2032\u0301\u00B7]/g, "")
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/^bondens?\s*marked\s*[-—–:]?\s*/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── 1b. normaliseBmLocation (PR-94, 2026-06-01) ───────────────
// Stronger normalisation used by the bm-events-scraper matcher.
// Applies `normaliseForMatch` then strips Norwegian definite-suffix
// patterns specific to place/venue names that appear on
// bondensmarked.no:
//
//   - "martnan" / "martn" → "marked"  (dialect/colloquial form
//                                      e.g. "kaupangermartn" → "kaupangermarked")
//   - trailing "-et", "-en", "-an", "-a"  → stripped when the
//                                            stem stays >= 3 chars
//
// Why a separate function (not folded into normaliseForMatch):
// `nameVariants` and the Hanen matcher rely on the unstripped form
// (Hanen producer names like "Stordalen Bruk AS" need "stordalen"
// preserved as-is for the org/farm-suffix variant pipeline). Only
// BM event/venue names need the place-name suffix stripping.
//
// Token-level stripping is conservative: stem must remain >= 3 chars
// after the strip, so "Os" and "Bø" stay intact.
export function normaliseBmLocation(s: string): string {
  const base = normaliseForMatch(s);
  if (!base) return "";

  const tokens = base.split(" ");
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    if (!t) continue;
    // martnan / martn → marked
    if (/martnan$/.test(t)) {
      t = t.replace(/martnan$/, "marked");
    } else if (/martn$/.test(t)) {
      t = t.replace(/martn$/, "marked");
    }
    // Strip Norwegian definite-suffix. Order = longest first ("an"/"en"/"et" before "a")
    // to avoid premature single-char strip on words like "tjern" (would lose "n").
    // Guard: only strip if stem stays >= 3 chars.
    const suffixOrdered = ["an", "en", "et", "a"];
    for (const sfx of suffixOrdered) {
      if (t.length > sfx.length + 2 && t.endsWith(sfx)) {
        t = t.slice(0, -sfx.length);
        break;
      }
    }
    tokens[i] = t;
  }
  return tokens.join(" ").replace(/\s+/g, " ").trim();
}

// ─── 2. diceCoefficient ────────────────────────────────────────
// Sørensen–Dice over character bigrams.
//   - Strings of length < 2 fall back to equality (1 if equal, 0 else)
//     since they have no bigrams.
//   - Whitespace inside the string contributes bigrams normally — this
//     is desired so "olav g" ≠ "olavg" but "olav gard" ≈ "olav  gard"
//     (caller is expected to normaliseForMatch first to collapse
//     whitespace).
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
  }

  let intersection = 0;
  let totalB = 0;
  // Walk b's bigrams once, draining matches from bigramsA so each
  // occurrence is counted at most once (standard Dice on multisets).
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    totalB++;
    const count = bigramsA.get(bg) || 0;
    if (count > 0) {
      intersection++;
      bigramsA.set(bg, count - 1);
    }
  }

  const totalA = a.length - 1;
  return (2 * intersection) / (totalA + totalB);
}

// ─── 3. nameSimilarity ─────────────────────────────────────────
// Convenience: normalises both inputs and returns Dice. Short-circuits
// on exact normalised equality (very common — saves the bigram cost
// for the obvious case where Hanen and our DB spell a farm identically).
export function nameSimilarity(a: string, b: string): number {
  const na = normaliseForMatch(a);
  const nb = normaliseForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return diceCoefficient(na, nb);
}

// ─── 4. bestMatch ──────────────────────────────────────────────
// Scan candidates, return the highest-scoring one. Useful for the
// "match one Hanen member to one agent" inner loop. Threshold
// filtering is left to the caller so different scrapers can use
// different cut-offs (Hanen starts at 0.85).
export function bestMatch<T>(
  needle: string,
  candidates: Array<{ key: string; item: T }>
): { item: T; score: number; key: string } | null {
  let best: { item: T; score: number; key: string } | null = null;
  for (const c of candidates) {
    const score = nameSimilarity(needle, c.key);
    if (score > 0 && (!best || score > best.score)) {
      best = { item: c.item, score, key: c.key };
    }
  }
  return best;
}

// ─── 5. nameVariants ───────────────────────────────────────────
// Generate multiple normalised variants of a producer name so the
// matcher can compare against the strongest plausible spelling of
// either side. All variants are lowercase, æ/ø/å transliterated.
//
// Variants generated from `normaliseForMatch(s)`:
//   1. Full normalised form               ("heim gard as")
//   2. With common org-suffix stripped    ("heim gard")
//   3. With farm-suffix stripped          ("heim")
//   4. First-word-only fallback           ("heim")
//
// Set semantics — duplicates collapse. Empty string is filtered out.
//
// Why: Hanen sometimes uses just "Heim Gardsbutikk" while our agent
// is registered as "Heim Gård AS"; the first/last-word stems align
// even though full Dice would be below threshold.
//
// Suffix lists (case-insensitive, end-of-string only):
//   Org-suffix:  as, asa, da, ans, enk, sa, ba, ks, nuf, stif, stiftelse
//   Farm-suffix: gard, gard*sbutikk*, gard*sutsalg*, gardsbruk, gartneri,
//                seter, bruk, hage, hagebruk
//   (Note: "gård" has already been transliterated to "gard" by
//   normaliseForMatch, so we match the transliterated forms.)
const ORG_SUFFIX_RE = /\s+(?:as|asa|da|ans|enk|sa|ba|ks|nuf|stif|stiftelse)$/;
const FARM_SUFFIX_RE = /\s+(?:gard|gardsbutikk|gardsutsalg|gardsbruk|gartneri|seter|bruk|hage|hagebruk)$/;

export function nameVariants(s: string): string[] {
  const base = normaliseForMatch(s);
  if (!base) return [];
  const out = new Set<string>();
  out.add(base);

  // Strip org-suffix (e.g. " AS" at end). Apply iteratively in case of
  // chained suffixes like "AS AS" — unusual but cheap to be defensive.
  let stripped = base;
  for (let i = 0; i < 3; i++) {
    const next = stripped.replace(ORG_SUFFIX_RE, "");
    if (next === stripped) break;
    stripped = next;
  }
  if (stripped && stripped !== base) out.add(stripped);

  // Strip farm-suffix from EITHER the base or the org-stripped form
  // (handles "Heim Gård AS" → "heim gard as" → "heim gard" → "heim").
  for (const candidate of [base, stripped]) {
    let farmless = candidate;
    for (let i = 0; i < 3; i++) {
      const next = farmless.replace(FARM_SUFFIX_RE, "");
      if (next === farmless) break;
      farmless = next;
    }
    if (farmless && farmless !== candidate) out.add(farmless);
  }

  // First-word-only fallback. Skip if the first word is too short to be
  // distinctive (≤2 chars: "av", "og", "de") — produces too many false
  // positives on the matcher side.
  const firstWord = base.split(/\s+/)[0] || "";
  if (firstWord.length >= 3) out.add(firstWord);

  // Return as array, drop empties just in case.
  return Array.from(out).filter(v => v.length > 0);
}
