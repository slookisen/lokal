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

// ─── looksTruncatedMidWord — dev-request
//     2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 5 ────────
//
// A DIFFERENT failure mode than isJunkDescription() above (nav-boilerplate
// dumped as a description): this one is a byte/char-range scrape slice that
// began and ended INSIDE words, not at a nav-menu problem. Real live example
// found in a gårdssalg producer's opening_hours_text (paraphrased faithfully):
//   "g håndverk. Bli med på en smaksreise! åPNINGSTIDER … åpent H"
// — starts mid-word ("g " is the tail of a cut-off word) and ends mid-word
// too (a lone trailing capital "H", no terminal punctuation). Apply this
// guard IN ADDITION TO isJunkDescription(), not instead of it — a field can
// fail either or both.
//
// SAFETY POSTURE: same as isJunkDescription() above — bias toward NOT
// flagging normal prose. A false positive costs the same as there (the field
// falls back to the same honest generic copy / the fact row is omitted) —
// never wrong data, just missed real content. So each signal below is
// narrow and allowlist-guarded rather than a blunt length/case check.

// Deliberately generous allowlist of short (1-2 character) Norwegian words
// that are completely normal sentence/fragment openers on their own.
// NOT an exhaustive dictionary — just enough common short words that a
// legitimate prose opener never gets misread as a cut-off word remnant.
// Erring generous here only REDUCES false positives (a real truncated
// fragment's leading remnant is essentially never one of these specific
// words), matching the "bias toward NOT flagging normal prose" posture.
//
// 2026-08-12 fix (CHANGES-REQUESTED review of arbeidspunkt 5): the original
// list was ad-hoc and missed several everyday bokmål words that are, if
// anything, MORE frequent in real Norwegian producer copy than some of the
// words that were already here — most visibly "kl" (opening-hours strings
// routinely start "kl 10-18…"), plus "så"/"da"/"er", three of the most
// common words in the language. Every entry below was individually
// sanity-checked as a genuine, common, standalone bokmål word or
// abbreviation that could plausibly open a short sentence/fragment — this
// is not a pasted-in dictionary dump:
//   kl  — "klokken/klokka" (o'clock), near-universal in hours strings
//         ("kl 10-18 alle dager…")
//   så  — adverb/conjunction "so/then", one of the most common words in
//         Norwegian ("Så lenge lageret rekker, …")
//   da  — conjunction/adverb "when/then", likewise extremely common
//         ("Da vi startet i 1990 …")
//   er  — present tense of "å være" (is/am/are), routinely opens a
//         question or statement ("Er dette stedet du leter etter…")
//   jo  — adverb "indeed/yes", a common confirmatory opener
//         ("Jo, vi har fortsatt…")
//   må  — present tense of the modal verb "å måtte" (must), common in
//         invitational marketing copy ("Må prøve!")
//   ok  — everyday loanword interjection, common as a casual opener
//   nb  — abbreviation of "nota bene", used as a heads-up prefix
//   ut  — adverb "out" ("Ut på tunet finner du…")
//   ny  — adjective "new" ("Ny åpningstid fra 1. juni…")
//   få  — verb "to get" / adjective "few", both common
//         ("Få med deg høstens…")
//   la  — imperative of "å la" (let) ("La oss vise deg gården.")
//   be  — imperative of "å be" (ask/request) ("Be om en omvisning…")
//   ta  — imperative of "å ta" (take), a very common marketing opener
//         ("Ta turen innom oss!")
//   gi  — imperative of "å gi" (give) ("Gi bort en opplevelse…")
//   øl  — noun "beer" ("Øl smakes her hver lørdag…") — directly relevant to
//         this platform's drikkeprodusent (drink-producer) domain, where a
//         short opener naming the product itself is routine copy
//
// 2026-08-12 fix, round 2 (CHANGES-REQUESTED review of the round-1 fix
// above): round 1 was STILL bokmål-only, and this route's own test fixtures
// are Vestland/Voss — nynorsk-dominant territory — so nynorsk short openers
// are squarely in scope, not a corner case. This round also went beyond the
// 5 reported strings to a systematic audit of BOTH bokmål and nynorsk 1-2
// char words/abbreviations, plus measurement/currency/commerce abbreviations
// (this route's fields carry prices, quantities and opening hours, so "kr
// 50…"/"pr stykk…"-shaped openers are realistic, not exotic). Every entry
// below was individually checked against the same bar as round 1: a
// genuine, common word/abbreviation that could plausibly be the literal
// FIRST token of a real about_text/visit_text/opening_hours_text value —
// not just "a word that exists in a dictionary somewhere":
//   eg  — nynorsk 1st-person pronoun "jeg" (I) ("Eg driv gard saman med
//         familien min i tredje generasjon.") — bokmål "jeg" is 3 chars so
//         never needed an entry; nynorsk "eg" is exactly the 2-char gap.
//   no  — nynorsk adverb "nå" (now) ("No sel vi eple og pære frå garden
//         kvar haust.") — bokmål already had "nå"; this is the nynorsk
//         spelling of the same word, a distinct token.
//   ca  — abbreviation "circa/omtrent" (approximately), routine in
//         distance/quantity openers ("Ca 200 meter frå hovudvegen finn du
//         garden vår.")
//   kr  — currency abbreviation "kroner", routine in price openers ("Kr 50
//         per kilo, betaling på staden eller vipps.") — this route's fields
//         include prices, so a value that IS just a price line is realistic.
//   pr  — abbreviation "per" ("Pr stykk koster eggene 5 kroner, henting i
//         utsalget.") — routine in per-unit pricing, same rationale as "kr".
//   ho  — nynorsk 3rd-person-fem pronoun "hun" (she), routine in bios
//         describing a female farmer/owner ("Ho driv garden saman med
//         mannen sin.")
//   me  — nynorsk 1st-person-plural pronoun "vi" (we) ("Me sel egg og
//         grønsaker rett frå garden kvar laurdag.")
//   so  — TWO independent, both-plausible readings: (a) nynorsk
//         conjunction/adverb "så" (so/then) ("So kjem hausten og me
//         haustar eplene."), AND (b) the literal noun "so" = a female pig
//         — directly on-domain for farm/gårdssalg copy ("So og grisar går
//         fritt på beite.")
//   då  — nynorsk spelling of "da" (when/then) — bokmål "da" was already
//         allowlisted in round 1; this is the distinct nynorsk-spelled
//         token ("Då eg var liten, dreiv bestefar garden.")
//   kg  — unit abbreviation "kilogram", routine in per-weight pricing
//         openers ("Kg-pris på eplene er 20 kr i haust.") — same
//         commerce-abbreviation rationale as "kr"/"pr".
//   nr  — abbreviation "nummer" (number), plausible in short address/list-
//         position openers ("Nr 12 i Bygdevegen, rett bak fjøset.")
//
// Candidates explicitly CONSIDERED and REJECTED (documented so this isn't
// re-litigated as an oversight next round): "mm"/"cm" (millimeter/
// centimeter) — real Norwegian abbreviations, but not plausible as the
// literal FIRST token of a farm about/visit/hours field; measurements at
// that scale show up mid-sentence describing a product ("epler på ca 7 cm
// i diameter"), essentially never as the opening word of a fragment, so
// adding them would only shrink true-positive coverage without closing a
// realistic gap. "bl" (short for "bl.a." = blant annet) — in real usage
// this is written as the single glued token "bl.a." (which the {1,2}-char
// regex here doesn't even match), not as a bare 2-char "bl" opener; too
// contrived to justify. "jf" (jamfør = cf./compare) — a citation/reference
// abbreviation, not a register that opens informal farm-producer prose.
// "m"/"l" (meter/liter as bare single letters) — too ambiguous standalone
// (collides with many possible truncated-word remnants) and not how these
// units are actually written as sentence openers in practice (the number
// leads: "5 liter…", not "l 5…").
const SHORT_WORD_ALLOWLIST = new Set([
  "og", "en", "et", "ei", "i", "på", "å", "av", "om", "nå",
  "de", "du", "vi", "ja", "to", "gå", "se",
  "kl", "så", "da", "er", "jo", "må", "ok", "nb",
  "ut", "ny", "få", "la", "be", "ta", "gi", "øl",
  "eg", "no", "ca", "kr", "pr", "ho", "me", "so", "då", "kg", "nr",
]);

// Sentence-ending punctuation, including common closing-quote glyphs —
// used by the "end" check below to tell a real sentence boundary apart
// from a raw cut mid-sentence.
const TERMINAL_PUNCT_RE = /[.!?"'”’»]$/;

/**
 * Heuristically detect a value that looks like a scraper grabbed a raw
 * char-range slice of a source page that began and/or ended inside a word
 * — see the module comment above for the motivating live example. Pure,
 * conservative, render-time-guard predicate — same category as
 * isJunkDescription() (no DB/queue access), apply both to a given field.
 *
 * Signals (either end alone is enough to flag true):
 *   - START: the first whitespace-delimited token is 1-2 characters, all
 *     lowercase Norwegian letters, and NOT in SHORT_WORD_ALLOWLIST — e.g.
 *     the "g" in "g håndverk…" above. A normal short opener ("på gården…",
 *     "og vi selger…") is allowlisted; a normal LONGER first word ("åpent
 *     hele uken…") never even reaches this check since it's already >2
 *     characters — length + allowlist together, not length alone, is what
 *     keeps this from flagging real short Norwegian words.
 *   - END: the last whitespace-delimited token is exactly one uppercase
 *     letter (e.g. the trailing "H" above), AND the token immediately
 *     before it does NOT already end with sentence-ending punctuation
 *     (`.`, `!`, `?`, or a closing quote). A lone capital letter right
 *     after a real, already-finished sentence reads as a plausible
 *     abbreviation/initial rather than a cut — so that case is NOT flagged.
 *     Known limitation (non-blocking, per 2026-08-12 review): a bare
 *     trailing capital letter with no preceding terminal punctuation at all
 *     (e.g. a short fragment like "kategori A") can still false-positive on
 *     this signal alone; left as-is since it's narrower and lower-impact
 *     than the START gap this fix addresses.
 *
 * Examples (see the accompanying test coverage for the full table):
 *   - "g håndverk. Bli med på en smaksreise! åPNINGSTIDER … åpent H" -> true
 *     (both the start AND end signal fire independently)
 *   - "Åpent hele uken, kontakt oss for avtale."                     -> false
 *   - "på gården selger vi egg og honning hver lørdag."              -> false
 *     (allowlisted opener, no suspicious ending)
 *   - "Vi holder åpent fra kl 10 til 18 alle dager unntatt søndag."  -> false
 */
export function looksTruncatedMidWord(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  // START check.
  const first = tokens[0];
  if (/^[a-zæøå]{1,2}$/.test(first) && !SHORT_WORD_ALLOWLIST.has(first)) {
    return true;
  }

  // END check — needs a token before the last one for the "was there
  // already a sentence boundary" context.
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const beforeLast = tokens[tokens.length - 2];
    if (/^[A-ZÆØÅ]$/.test(last) && !TERMINAL_PUNCT_RE.test(beforeLast)) {
      return true;
    }
  }

  return false;
}
