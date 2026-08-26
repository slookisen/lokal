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
 *   0. looksLikeCodeArtifact(text) below returns true — a DIFFERENT failure
 *      mode (raw scraped JS/markup, not nav-menu boilerplate) that gets its
 *      own detector with its own, freer safety posture (see that function's
 *      doc comment for why). Folded into this predicate as an additional
 *      early rule so every existing isJunkDescription() call site picks it
 *      up automatically — see that function's own module note for the
 *      dev-request this rule was added for.
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

  // Rule 0: scraped JS/markup code artifact (dev-request 2026-08-24-
  // produsentbeskrivelser-skrapt-js-opprydding) — a DIFFERENT failure mode
  // from the nav-boilerplate rules below, checked FIRST via its own
  // dedicated, freer-threshold detector (see looksLikeCodeArtifact's doc
  // comment further down this file for the full rationale/signal classes).
  if (looksLikeCodeArtifact(trimmed)) return true;

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

// ─── looksLikeCodeArtifact — scraped JS/CMS-bootstrap code in a description ─
//
// dev-request 2026-08-24-produsentbeskrivelser-skrapt-js-opprydding. A THIRD
// failure mode in this module (distinct from isJunkDescription's nav-
// boilerplate above and looksTruncatedMidWord's cut-mid-word slice below): a
// scraped page's raw <script>/CMS-bootstrap JavaScript landed verbatim in
// `agents.description` instead of being stripped. Root cause (confirmed in
// code, not assumed): the automatic enrichment sweep (search-enrich.ts)
// ALWAYS strips <script>/<style>/<noscript>/<template> before ever storing
// text (extractVisibleText/extractProseText) — it structurally cannot
// produce this defect. The actual unsanitized write path is
// `PATCH /api/marketplace/agents/:id` (marketplace.ts), which — before this
// dev-request — had NO validation on `description` at all before writing;
// this is also the exact path `lokal-agent-enrichment` documents for manual/
// agent-driven enrichment (an agent reads a producer's site and PATCHes in
// its own composed text). Live example that triggered this: "Helios
// Trondheim" (found via `lokal_search` "økologiske grønnsaker Trøndelag")
// had a description that was a wall of scraped Squarespace bootstrap JS.
//
// SAFETY POSTURE — deliberately FREER than isJunkDescription() above, not
// copied from it. isJunkDescription's nav-word signals can each appear as an
// ordinary word in real Norwegian prose ("produkter", "kontakt"), so that
// detector needs clustering/density thresholds to stay conservative. Real
// executable JS syntax (a literal `<script>` tag, `function(){...}`,
// `var x = 1;`, a minified brace/semicolon density) is, by contrast,
// practically NEVER legitimate content in a farm/producer self-description —
// nobody writes "function(){var a=1;}" as prose. So this detector can fire on
// a single unambiguous signal (a literal script/style tag) OR on just two
// independently-weaker signal CLASSES together, instead of the heavier
// clustering isJunkDescription needs. Still THRESHOLD- and CLASS-based, never
// a single keyword match — Daniel's explicit requirement: a description that
// merely NAMES a technology in flowing prose, e.g. "Vi bruker moderne
// teknologi og JavaScript-baserte verktøy i gårdsdriften vår", must NOT flag;
// only actual code SYNTAX does. (This is a stronger guard than
// GENERIC_ABOUT_MARKERS's single-word "javascript" check in
// search-enrich.ts:1279-1284, which catches only the word, never the syntax
// — that check is not reused here.)
//
// Five independent signal classes (reworked post-review — round 1 shipped
// with only classes 2-4 below plus the <script>/<style> class; an
// independent code-reviewer then actually RAN the detector against 5
// extremely common real-world bootstrap/analytics snippets — WordPress
// `_wpemojiSettings`, a Google Tag Manager snippet, a jQuery
// `$(document).ready(...)` theme inline script, a Shopify `Shopify.shop`/
// `Shopify.locale` bootstrap, and a Next.js hydration payload
// (`self.__next_f.push(...)`) — and found all 5 were FALSE NEGATIVES. Root
// cause the reviewer traced in class 3 below: real minified/bundled JS from
// Terser/UglifyJS downlevels almost everything to `var` alone, so a class
// that required 2 DISTINCT declaration keywords (var/let/const) could
// structurally never reach its own threshold on realistic minified code, and
// classes 2/4 alone were not consistently enough either. Fixed two ways at
// once, deliberately not just special-cased for the 5 named snippets:
//   - class 1b below (new): known-ubiquitous provider/CMS bootstrap
//     signatures that are unambiguous alone, the same posture the literal
//     `<script>` tag already had in class 1 — nobody writes
//     "_wpemojiSettings" or "self.__next_f.push(...)" as prose either.
//   - class 3 below (reworked): the "assignment activity" half now accepts
//     var-only minified shapes (repeated `var x =` declarations, or an IIFE
//     wrapper), not only >=2 DISTINCT keywords.
//
//   1. UNAMBIGUOUS ALONE: a literal `<script`/`</script>`/`<style` tag
//      substring anywhere in the text — enough on its own (mirrors
//      isJunkDescription's rule-1 skip-link pattern: real code markup is
//      never legitimate prose no matter where it lands).
//   1b. UNAMBIGUOUS ALONE: a known-ubiquitous provider/CMS bootstrap
//      signature — `_wpemojiSettings` (WordPress), `dataLayer` together with
//      a `gtag(`/`ga(` call (Google Tag Manager/Analytics), `Shopify.shop`/
//      `Shopify.locale` (Shopify storefront bootstrap), `__next_f.push`
//      (Next.js App Router hydration payload), a jQuery/`$`
//      `(document).ready(` call (classic theme inline script), or
//      `Y.Squarespace`/`Static.SQUARESPACE_CONTEXT` (Squarespace storefront
//      bootstrap — moved here from class 2 on 2026-08-25 after the live
//      Helios Trondheim description, the actual case that motivated this
//      whole detector, was found to still slip through with it in the
//      weaker class: a real `SQUARESPACE_CONTEXT` payload is a large,
//      mostly-flat JSON literal that typically has neither the brace
//      density of class 4 nor the function/assignment shape of class 3, so
//      requiring a companion class structurally under-catches it). Same
//      unambiguous-alone posture as class 1 — these are provider-specific
//      code tokens, structurally impossible to appear in Norwegian
//      producer prose, so no second class is required.
//   2. CMS/framework bootstrap tokens: `window.<name>` followed by `.`/`(`,
//      `document.<name>` followed by `.`/`(` (anchored the same way as the
//      `window.` check — a bare "document.pdf"/"document.docx" mention
//      must NOT contribute; the identifier immediately after `document.`
//      must itself be immediately followed by `.` or `(`, i.e. an actual
//      member-access/call shape), `!function(`, `typeof exports`. Any one of
//      these makes this ONE class true (not one class per token) — several
//      appearing together still only counts once here.
//   3. JS-syntax density: `function(`/`function (` present AND semicolon
//      density over the whole string > 1.5 per 100 chars AND some
//      "assignment activity" — now ANY of: (a) >=2 DISTINCT declaration
//      keywords among var/let/const, each followed by `=` (source mixing
//      declaration forms), (b) >=2 REPEATED `var <name> =` declarations
//      (the var-only minified shape most Terser/UglifyJS output actually
//      produces), (c) an IIFE wrapper shape `(function(...){...})(...)`
//      (the single most common minified-bundle wrapper, present regardless
//      of which declaration keyword the body uses), or (d) a UNARY-operator
//      IIFE wrapper shape `!function(...){...}(...)` (also `+function(`/
//      `-function(`/`~function(`) — the classic Facebook-Pixel-bootstrap
//      form, used instead of the parenthesized form to avoid ASI hazards
//      when the expression opens a statement. All three of
//      function()-present / assignment-activity / semicolon-density must
//      hold together — this is what keeps a sentence merely naming
//      "function" or "variabel" from flagging on its own.
//   4. Brace density: `{`/`}` count >= 4 AND > 2.0 per 100 chars (minified-
//      JS shape) over a string of at least 40 chars — Norwegian prose
//      essentially never contains curly braces at all, so this stays
//      conservative even at a low absolute threshold.
// Flags true when class 1 or 1b fires alone, OR when >=2 of classes {2,3,4}
// fire together — never on any single one of classes 2-4 alone.
//
// Examples (see tests/test.ts "description-junk-guard" section for the full
// table, including the 5 real-world snippets named above):
//   - The real live Helios Trondheim text that motivated this detector,
//     captured verbatim via `lokal_info` 2026-08-25 (not a same-shape
//     stand-in): `Grønn Guide Trondheim Static = window.Static || {};
//     Static.SQUARESPACE_CONTEXT = {"betaFeatureFlags":
//     ["supports_versioned_template_assets","campaigns_merch_state", …]`
//     -> true (class 1b [`Static.SQUARESPACE_CONTEXT`] alone, unambiguous —
//     this string has only 3 braces and no function()/assignment shape, so
//     it would NOT have fired at all under the old class-2-only placement;
//     see tests/test.ts for the full byte-for-byte fixture)
//   - A generic minified-JS shape like
//     `function(){var a=1;var b=2;let c=3;const d=4;if(a){b=c;}return
//     a+b+c+d;}` -> true (class 3 [JS-syntax density] + class 4 [brace
//     density] both fire, no CMS tokens needed)
//   - A WordPress-shaped `window._wpemojiSettings = {...}; !function(window,
//     document,navigator){var Util,i,tests;...}(window,document,navigator);`
//     -> true (class 1b [`_wpemojiSettings`] alone, unambiguous)
//   - A GTM-shaped `window.dataLayer = window.dataLayer || [];
//     function gtag(){dataLayer.push(arguments);} gtag('js', new Date());`
//     -> true (class 1b [`dataLayer` + `gtag(`] alone, unambiguous)
//   - A jQuery theme inline script `$(document).ready(function() {
//     $('.nav-toggle').on('click', function(){ $('.menu').slideToggle();
//     }); });` -> true (class 1b [`$(document).ready(`] alone, unambiguous)
//   - A Shopify bootstrap `var Shopify = Shopify || {}; Shopify.shop =
//     "example.myshopify.com"; Shopify.locale = "en";`
//     -> true (class 1b [`Shopify.shop`] alone, unambiguous)
//   - A Next.js hydration payload `self.__next_f.push([1,"ad:I[47690,[],
//     \"ClientPageRoot\"]\n"])` -> true (class 1b [`__next_f.push`] alone,
//     unambiguous)
//   - "Vi bruker moderne teknologi og JavaScript-baserte verktøy i
//      gårdsdriften vår."                                     -> false
//     (names a technology in plain prose; no code syntax at all)
//   - "Vi driver med økologisk grønnsaksdyrking og selger direkte fra
//      gården hver lørdag."                                   -> false
//     (ordinary description, zero signals)
//   - "Vi driver en liten nettbutikk med lokale produkter fra gården, og
//      frakt kan bestilles direkte via telefon."                -> false
//     (names "nettbutikk"; no code syntax)
//   - "Vi tilbyr digital markedsføring og rådgivning til andre bønder i
//      regionen vår."                                          -> false
//     (names "digital markedsføring"; no code syntax)
//   - "Vi bruker moderne verktøy og teknologi for å sikre kvalitet i alle
//      ledd av produksjonen."                                  -> false
//     (names "moderne verktøy"; no code syntax)
export function looksLikeCodeArtifact(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Class 1 — unambiguous alone: a literal script/style tag substring.
  if (/<\/?script\b|<style\b/i.test(trimmed)) return true;

  // Class 1b — unambiguous alone: known-ubiquitous provider/CMS bootstrap
  // signatures. See the module doc comment above for why each is safe to
  // trust alone (structurally impossible in Norwegian producer prose).
  const providerSignatureSignal =
    trimmed.includes("_wpemojiSettings") ||
    (trimmed.includes("dataLayer") && /\b(?:gtag|ga)\s*\(/.test(trimmed)) ||
    trimmed.includes("Shopify.shop") ||
    trimmed.includes("Shopify.locale") ||
    trimmed.includes("__next_f.push") ||
    /(?:\$|jQuery)\(\s*document\s*\)\.ready\s*\(/.test(trimmed) ||
    // Squarespace bootstrap tokens — moved here from class 2 (2026-08-25,
    // Helios Trondheim live-verification gap). These were left in class 2
    // (needs a class-3/4 companion) when round 1 promoted the other five
    // providers' tokens to this unambiguous-alone class; a real Squarespace
    // `SQUARESPACE_CONTEXT` payload is typically a large, mostly-flat JSON
    // literal (string/array-heavy), so it structurally tends to miss both
    // the brace-density threshold (class 4) and the function/assignment
    // shape (class 3) — exactly what happened to the live Helios Trondheim
    // description this whole detector was built to catch (confirmed via
    // `POST /admin/agents/description-code-artifact-sweep {"apply":false}`
    // returning 0 candidates against prod, then reproducing class-by-class
    // against the real captured text). Same "structurally impossible in
    // Norwegian producer prose" reasoning as the other five class-1b
    // members applies identically here.
    trimmed.includes("Y.Squarespace") ||
    trimmed.includes("Static.SQUARESPACE_CONTEXT");
  if (providerSignatureSignal) return true;

  // Class 2 — CMS/framework bootstrap tokens. `document.` is anchored the
  // same way `window.` already was — the identifier right after the dot
  // must itself be immediately followed by `.`/`(` (an actual member-
  // access/call shape), so a stray "document.pdf" mention can't contribute.
  const cmsBootstrapSignal =
    /window\.[A-Za-z_$][\w$]*\s*[.(]/.test(trimmed) ||
    /document\.[A-Za-z_$][\w$]*\s*[.(]/.test(trimmed) ||
    trimmed.includes("!function(") ||
    trimmed.includes("typeof exports");

  // Class 3 — JS-syntax density: function() present AND some "assignment
  // activity" AND high semicolon density, ALL three together (see class
  // comment above for why this guards against prose that merely names a
  // technology, and for why the assignment-activity check now has 3 ways
  // to fire instead of requiring 2 distinct declaration keywords).
  const hasFunctionParen = /function\s*\(/.test(trimmed);
  const distinctAssignmentKeywords =
    (/\bvar\s+\w+\s*=/.test(trimmed) ? 1 : 0) +
    (/\blet\s+\w+\s*=/.test(trimmed) ? 1 : 0) +
    (/\bconst\s+\w+\s*=/.test(trimmed) ? 1 : 0);
  const repeatedVarDeclarations = (trimmed.match(/\bvar\s+\w+\s*=/g) ?? []).length;
  // Paren-wrapped IIFE: `(function(...){ ... })(...)`.
  const isParenIifeWrapper = /\(\s*function\s*\([^)]*\)\s*\{/.test(trimmed) && /\}\s*\)\s*\(/.test(trimmed);
  // Unary-operator IIFE: `!function(...){ ... }(...)` (the classic Facebook
  // Pixel bootstrap shape) and its siblings `+function(`/`-function(`/
  // `~function(` — all four unary operators are used interchangeably in
  // minified/concatenated JS bundles purely to defeat ASI (automatic-
  // semicolon-insertion) hazards when a `function` expression opens a
  // statement; none has any special meaning here beyond "not a function
  // DECLARATION". Requires the operator immediately before `function` (not
  // just present anywhere in the string) AND a matching `}(` call-shape
  // afterward, so a stray `!` earlier in the text plus an unrelated
  // `function(...)`/`}(` elsewhere can't combine into a false match on their
  // own — same unanchored-but-practically-safe posture as the paren-form
  // check above (an unrelated `}(` substring could in principle exist
  // elsewhere in a very large string, but that shape essentially never
  // occurs in Norwegian prose).
  const isUnaryIifeWrapper = /[!+\-~]\s*function\s*\([^)]*\)\s*\{/.test(trimmed) && /\}\s*\(/.test(trimmed);
  const isIifeWrapper = isParenIifeWrapper || isUnaryIifeWrapper;
  const hasAssignmentActivity =
    distinctAssignmentKeywords >= 2 || repeatedVarDeclarations >= 2 || isIifeWrapper;
  const semicolonDensity = (trimmed.match(/;/g)?.length ?? 0) / (trimmed.length / 100);
  const jsSyntaxDensitySignal = hasFunctionParen && hasAssignmentActivity && semicolonDensity > 1.5;

  // Class 4 — brace density (minified-JS shape). A minimum length AND a
  // minimum raw count are required in addition to the density ratio, so a
  // short string with one stray brace pair can't cross the density bar on a
  // tiny denominator.
  const braceCount = (trimmed.match(/[{}]/g) ?? []).length;
  const braceDensity = braceCount / (trimmed.length / 100);
  const braceDensitySignal = trimmed.length >= 40 && braceCount >= 4 && braceDensity > 2.0;

  const classCount = [cmsBootstrapSignal, jsSyntaxDensitySignal, braceDensitySignal].filter(Boolean).length;
  return classCount >= 2;
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
