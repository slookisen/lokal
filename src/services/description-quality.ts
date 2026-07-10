// ─── description-quality — dev-request 2026-07-04-rfb-datakvalitet item 1 ─────
//
// RENDER-TIME GUARD ONLY. This module does not touch the DB, does not queue
// re-enrichment, and does not backfill anything — it mirrors the incremental
// scoping used by item 3 (contact-normalizer.isDisplayablePhone): a pure,
// conservative predicate that every display/output call site consults before
// showing `agent.description` / `knowledge.about` to a human or an AI agent.
//
// WHY THIS EXISTS
// ───────────────
// The build-quality DoD's richness gate only checks length (egen-kilde-
// beskrivelse ≥120 tegn), so scraped page chrome that happens to be long
// enough sails through as if it were a real description. Live example
// (Homme Gård, Øvrebø — the case that triggered this dev-request):
//   "Skip to content Homme 8, 4715 Øvrebø 41360545 john@hommegaard.no
//    Facebook-f Instagram Forside Gårdsutsalg Produksjon … Meny …"
// That is nav-menu boilerplate + a contact block dumped by the scraper,
// not a description — but it is 140+ characters, so it passed.
//
// SAFETY POSTURE (read before changing the heuristics)
// ──────────────────────────────────────────────────────
// Bias toward NOT flagging normal prose. A false positive here just means a
// perfectly fine description gets replaced by the same category-line/generic
// fallback every call site already uses when a description is *missing* —
// mildly worse copy, never wrong data. A false negative lets a rendering
// annoyance (nav junk) through — also not a guardrail-tier failure (unlike
// wrong_contact_rate, which governs phone/address correctness). So the bar
// here is "reasonably conservative", not "zero false positives/negatives".
// Each rule below is deliberately narrow (an unambiguous boilerplate/nav
// signal, or several weaker nav-word signals *clustered together*) rather
// than penalizing any single normal-sounding word in isolation.

// Strong, near-unambiguous nav/menu tokens that legitimately show up on
// scraped nav bars and skip-links, but essentially never as ordinary words
// in a farm/producer self-description written in flowing prose. Used for
// the opening segment" signal — general words like "kontakt"/"produkter"
// are excluded here because they are common enough in normal prose
// ("Vi selger produkter rett fra gården") that clustering them would risk
// false positives; the words below are near-exclusively menu-label tokens.
const STRONG_NAV_TOKENS = [
  "forside", "meny", "produksjon", "facebook-f", "instagram", "gårdsutsalg",
];

// Broader nav-word list used only for the word-density ratio (signal 4
// below); this one DOES include generic-sounding menu labels because it is
// gated by a density threshold over the whole opening segment, not a raw
// substring match. Single tokens only (the density check below matches word
// by word) — multi-word labels like "Om oss" are intentionally left out
// since a bigram can't be matched by the per-word scan, and splitting it
// into "om"/"oss" would flag two extremely common, unrelated Norwegian
// words ("om" = about/if, "oss" = us).
const DENSITY_NAV_WORDS = [
  "forside", "kontakt", "meny", "produkter", "tjenester", "nyheter", "blogg",
];

// Matches an email address anywhere in the string.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

// Matches a Norwegian phone-number-shaped substring: 8 digits, optionally
// grouped/spaced/dashed, with an optional +47/0047 prefix. Deliberately
// loose (this is a "does this look like a phone number" scan for the junk
// heuristic, NOT the strict validator in contact-normalizer.ts).
const PHONE_SHAPE_RE = /(?:\+?47[\s-]?)?(?:\d[\s-]?){8}/;

/**
 * Heuristically detect scraped website boilerplate/nav junk masquerading as
 * a real agent description. See module doc comment for the safety posture.
 *
 * Any ONE of the following is treated as a strong-enough signal on its own:
 *   1. Contains the classic screen-reader skip-link text ("Skip to content" /
 *      "Hopp til innhold").
 *   2. Several distinct STRONG_NAV_TOKENS (menu labels like "Forside",
 *      "Meny", "Produksjon", "Facebook-f", "Instagram", "Gårdsutsalg")
 *      appear clustered within the first ~200 characters (>=3 distinct
 *      tokens = "clustered").
 *   3. The "contact block dumped as description" pattern: an email address
 *      AND a phone-number-shaped substring AND a social-platform name
 *      ("facebook"/"instagram") all within the first ~150 characters.
 *   4. High nav-word density in the opening segment: >=4 occurrences of
 *      DENSITY_NAV_WORDS AND those words make up more than ~18% of the
 *      opening segment's word count (guards against one-off mentions like
 *      "Følg oss på Facebook og Instagram!" at the end of otherwise-normal
 *      prose, which should NOT flag — see borderline test cases).
 *
 * Examples (see tests/test.ts "description-junk-guard" section for the full
 * table, including the exact borderline calls made and why):
 *   - Homme Gård junk string above           -> true  (rules 1, 2 and 3 all fire)
 *   - "Vi driver med økologisk grønnsaks-
 *      dyrking og selger direkte fra gården
 *      hver lørdag."                          -> false (plain prose, no signals)
 *   - "Følg oss på Facebook og Instagram for
 *      oppdateringer! Vi selger egg, honning
 *      og bær rett fra gårdsbutikken."         -> false (mentions Facebook/
 *      Instagram once each, no email/phone/nav-menu clustering — judgement
 *      call: a single social-media call-to-action inside otherwise normal
 *      prose is common and NOT junk on its own)
 */
export function isJunkDescription(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  const opening200 = lower.slice(0, 200);
  const opening150 = lower.slice(0, 150);

  // Rule 1: classic skip-link boilerplate, anywhere (it's never legitimate
  // prose no matter where in the string it lands).
  if (lower.includes("skip to content") || lower.includes("hopp til innhold")) {
    return true;
  }

  // Rule 2: clustered strong nav tokens in the opening segment.
  const distinctStrongTokens = new Set(
    STRONG_NAV_TOKENS.filter((tok) => opening200.includes(tok))
  );
  if (distinctStrongTokens.size >= 3) return true;

  // Rule 3: contact-block-dumped-as-description — email + phone-shape +
  // social-platform name, all within the opening 150 chars.
  const hasEmail = EMAIL_RE.test(opening150);
  const hasPhoneShape = PHONE_SHAPE_RE.test(opening150);
  const hasSocial = opening150.includes("facebook") || opening150.includes("instagram");
  if (hasEmail && hasPhoneShape && hasSocial) return true;

  // Rule 4: nav-word density in the opening segment.
  const words = opening200.split(/\s+/).filter(Boolean);
  if (words.length >= 6) {
    let navWordCount = 0;
    for (const w of words) {
      const clean = w.replace(/[^\p{L}\d-]/gu, "");
      if (DENSITY_NAV_WORDS.includes(clean)) navWordCount++;
    }
    const density = navWordCount / words.length;
    if (navWordCount >= 4 && density > 0.18) return true;
  }

  return false;
}
