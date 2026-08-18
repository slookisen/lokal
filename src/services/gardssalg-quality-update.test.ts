/**
 * gardssalg-quality-update.test.ts — unit tests for the PURE policy in
 * services/gardssalg-quality-update.ts (dev-request 2026-08-17-
 * forsyningskjede-samarbeid-og-kvalitetsoppdatering, Skive 3): the obvious-
 * defect classifier (B), the info-point margin proxy (C), and their
 * combination into planGardssalgFieldReplacement.
 *
 * No DB access, no network — every function under test here is pure, so
 * this file needs no EXPERIENCES_DB_PATH/in-memory-DB setup (mirrors
 * experience-store.test.ts's own "no DB access" note for the same reason).
 * Owner-lock (A) and anti-churn (D), which DO touch the DB, plus the audited
 * writer (E) and the HTTP route itself, are covered by
 * routes/opplevelser-gardssalg-quality-update.test.ts instead.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/gardssalg-quality-update.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runGardssalgQualityUpdateTests() and folds its pass/fail counts into
 *      the `npm test` summary.
 */

import {
  classifyGardssalgFieldDefect,
  countGardssalgInfoPoints,
  planGardssalgFieldReplacement,
  hashGardssalgSourceContent,
} from "./gardssalg-quality-update";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgQualityUpdateTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  // ── classifyGardssalgFieldDefect: "ok" baseline ────────────────────────
  const GOOD_ABOUT =
    "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger direkte fra gårdsbutikken hele sommeren.";
  assertEq(
    classifyGardssalgFieldDefect("about_text", GOOD_ABOUT),
    { defective: false, type: null },
    "1: a genuinely decent about_text is not flagged defective"
  );
  assertEq(
    classifyGardssalgFieldDefect("about_text", null),
    { defective: false, type: null },
    "2: blank/null current value is never flagged (out of scope — fill-only's job)"
  );
  assertEq(
    classifyGardssalgFieldDefect("about_text", "   "),
    { defective: false, type: null },
    "3: whitespace-only current value is never flagged (same as blank)"
  );

  // ── too_short ───────────────────────────────────────────────────────────
  assertEq(
    classifyGardssalgFieldDefect("about_text", "Liten gård."),
    { defective: true, type: "too_short" },
    "4: about_text under the 40-char floor -> too_short"
  );
  assertEq(
    classifyGardssalgFieldDefect("opening_hours_text", "..."),
    { defective: true, type: "too_short" },
    "5: opening_hours_text under its own 8-char floor -> too_short"
  );
  assertEq(
    classifyGardssalgFieldDefect("opening_hours_text", "Lør-søn 10-16"),
    { defective: false, type: null },
    "6: a normal SHORT opening_hours_text (13 chars) is NOT flagged too_short — the field-specific floor is deliberately lower than prose fields"
  );

  // ── placeholder ─────────────────────────────────────────────────────────
  assertEq(
    classifyGardssalgFieldDefect(
      "about_text",
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor."
    ),
    { defective: true, type: "placeholder" },
    "7: lorem-ipsum placeholder text -> placeholder"
  );
  assertEq(
    classifyGardssalgFieldDefect("visit_text", "Siden er under oppbygging, kom tilbake senere for mer informasjon om gården."),
    { defective: true, type: "placeholder" },
    "8: 'under oppbygging' placeholder text -> placeholder"
  );

  // ── boilerplate / cookie-notice ─────────────────────────────────────────
  assertEq(
    classifyGardssalgFieldDefect(
      "about_text",
      "Vi bruker informasjonskapsler (cookies) for å forbedre din opplevelse. Les mer om personvern og samtykke her."
    ),
    { defective: true, type: "boilerplate" },
    "9: cookie-consent boilerplate -> boilerplate"
  );

  // ── CSS/JS leakage ──────────────────────────────────────────────────────
  assertEq(
    classifyGardssalgFieldDefect(
      "about_text",
      ".hero-banner { color: #fff; padding: 10px 20px; } .nav-menu{display:flex;} body{margin:0!important;}"
    ),
    { defective: true, type: "css_js_leakage" },
    "10: raw CSS rule fragment -> css_js_leakage"
  );
  assertEq(
    classifyGardssalgFieldDefect("about_text", "<script>function init(){ var x = 1; console.log(x); }</script>"),
    { defective: true, type: "css_js_leakage" },
    "11: raw <script> fragment -> css_js_leakage"
  );

  // ── UI-chrome leakage — the dev-request's own concrete example ─────────
  const BRINGEBAERLANDET_HOURS =
    "ebook , der legger vi ut alt som skjer. Vinsalget følger Vinmonopolet i Ås sine åpningstider (man, tirs, ons: 10-17 …). Previous Next Seks kilome";
  const bringebaerlandetVerdict = classifyGardssalgFieldDefect("opening_hours_text", BRINGEBAERLANDET_HOURS);
  assertEq(
    bringebaerlandetVerdict,
    { defective: true, type: "ui_chrome_leakage" },
    "12 (AC12/13, Bringebærlandet ce85458a fixture): the stored opening_hours_text — truncated at both ends " +
      "('Facebook'->'ebook', 'kilometer'->'kilome') with literal 'Previous Next' slider-nav chrome mid-string — is flagged defective (ui_chrome_leakage)"
  );
  assertEq(
    classifyGardssalgFieldDefect("about_text", "Forrige Neste — se alle våre produkter i nettbutikken vår her på gården."),
    { defective: true, type: "ui_chrome_leakage" },
    "13: Norwegian slider-chrome variant ('Forrige Neste') also flagged"
  );

  // ── truncated mid-sentence (independent of the UI-chrome fixture above) ─
  const TRUNCATED_ONLY =
    "Vi har åpent alle dager fra ti til atten og tilbyr rundvisning på gården samt smaking av våre egne";
  assertEq(
    classifyGardssalgFieldDefect("visit_text", TRUNCATED_ONLY),
    { defective: true, type: "truncated_mid_sentence" },
    "14: long text with no terminal punctuation (no UI-chrome, no other defect) -> truncated_mid_sentence"
  );
  assertEq(
    classifyGardssalgFieldDefect("visit_text", "Åpent hele sommeren, velkommen innom oss på gården!"),
    { defective: false, type: null },
    "15: a deliberately-punctuated real sentence is NOT flagged truncated (avoids false-positiving on genuine short-but-real copy)"
  );

  // ── wrong_language (prose fields only) ──────────────────────────────────
  assertEq(
    classifyGardssalgFieldDefect(
      "about_text",
      "Welcome to our farm shop where we sell fresh produce every single day of the week all year round."
    ),
    { defective: true, type: "wrong_language" },
    "16: pure-English prose (no Norwegian marker word, no æøå) -> wrong_language"
  );
  assertEq(
    classifyGardssalgFieldDefect("opening_hours_text", "Mon-Fri 10-18, Sat 10-15, closed Sundays and holidays."),
    { defective: false, type: null },
    "17: opening_hours_text is EXEMPT from the wrong_language check — day/time notation legitimately carries no Norwegian sentence markers"
  );

  // ── mangled encoding ──────────────────────────────────────────────────
  assertEq(
    classifyGardssalgFieldDefect("about_text", "Vi selger sider og cider fra gården vår i Hardanger, kom innom og smak p�."),
    { defective: true, type: "mangled_encoding" },
    "18: a Unicode replacement character (U+FFFD) anywhere in the text -> mangled_encoding, regardless of field"
  );

  // ── duplicate_of_other_provider (template leakage) ──────────────────────
  const SHARED_TEXT = "Vi er en gårdsbutikk som selger lokale varer rett fra egen produksjon året rundt.";
  assertEq(
    classifyGardssalgFieldDefect("about_text", SHARED_TEXT, { othersForField: ["Noe helt annet.", SHARED_TEXT] }),
    { defective: true, type: "duplicate_of_other_provider" },
    "19: byte-identical (after trim/case/whitespace normalization) to a DIFFERENT provider's stored value -> duplicate_of_other_provider"
  );
  assertEq(
    classifyGardssalgFieldDefect("about_text", SHARED_TEXT, { othersForField: ["Noe helt annet."] }),
    { defective: false, type: null },
    "20: same text, but no other provider actually shares it -> not flagged"
  );
  assertEq(
    classifyGardssalgFieldDefect("about_text", SHARED_TEXT),
    { defective: false, type: null },
    "21: duplicate check is skipped entirely when othersForField is omitted (never a false accusation with no comparison data)"
  );

  // ── countGardssalgInfoPoints + planGardssalgFieldReplacement margin rule ─
  const THIN_ABOUT = "Liten gård med noen dyr og planter, ikke så mye mer å si om det egentlig."; // no product/location/offering/visit markers
  const RICH_ABOUT =
    "Vi er en gårdsbutikk som produserer og selger egen sider og honning. Gården ligger i Hardanger kommune. " +
    "Vi tilbyr smaking og omvisning i sesong. Åpningstider: velkommen til å besøke oss, book gjerne på forhånd.";
  assertTrue(
    countGardssalgInfoPoints("about_text", RICH_ABOUT) > countGardssalgInfoPoints("about_text", THIN_ABOUT),
    "22: the richer about_text fixture covers strictly more info-point categories than the thin one"
  );

  assertEq(
    planGardssalgFieldReplacement("about_text", THIN_ABOUT, RICH_ABOUT),
    { shouldReplace: true, reason: "margin" },
    "23 (AC6): a NON-defective-but-thin current value IS replaced by a candidate that clears more info-point categories (margin)"
  );
  assertEq(
    planGardssalgFieldReplacement("about_text", RICH_ABOUT, THIN_ABOUT),
    { shouldReplace: false, reason: null },
    "24 (AC6): a candidate covering FEWER categories than a richer current value never replaces it, even though it is a valid, non-defective candidate"
  );
  assertEq(
    planGardssalgFieldReplacement("about_text", RICH_ABOUT, RICH_ABOUT),
    { shouldReplace: false, reason: null },
    "25: identical candidate/current -> never replace (nothing to gain)"
  );

  // ── planGardssalgFieldReplacement: defect path (AC6) ─────────────────────
  const CSS_LEAK_CURRENT = ".hero{color:#fff;padding:10px;} body{margin:0!important;} .nav{display:flex;}";
  assertEq(
    planGardssalgFieldReplacement("about_text", CSS_LEAK_CURRENT, GOOD_ABOUT),
    { shouldReplace: true, reason: "defect:css_js_leakage" },
    "26 (AC6): a row with an objectively-defective current value (CSS leakage) IS replaced when a valid, non-defective candidate exists"
  );
  assertEq(
    planGardssalgFieldReplacement("about_text", GOOD_ABOUT, "Kort."),
    { shouldReplace: false, reason: null },
    "27: a candidate that is ITSELF defective (too_short) never replaces anything — never replace bad with bad"
  );
  assertEq(
    planGardssalgFieldReplacement("about_text", GOOD_ABOUT, null),
    { shouldReplace: false, reason: null },
    "28: no candidate at all -> never replace"
  );
  assertEq(
    planGardssalgFieldReplacement("about_text", null, GOOD_ABOUT),
    { shouldReplace: false, reason: null },
    "29: blank current value -> out of scope for this lever (fill-only's job), never 'replaces'"
  );

  // ── Bringebærlandet (AC12/13), full plan: defect current + clean candidate -> replace ──
  const CLEAN_HOURS_CANDIDATE = "Åpent lør og søn kl. 10-17. Vinsalget følger Vinmonopolets ordinære åpningstider.";
  assertEq(
    planGardssalgFieldReplacement("opening_hours_text", BRINGEBAERLANDET_HOURS, CLEAN_HOURS_CANDIDATE),
    { shouldReplace: true, reason: "defect:ui_chrome_leakage" },
    "30 (AC12/13): given the Bringebærlandet-shaped defective current value and a clean candidate, the plan replaces it"
  );

  // ── hashGardssalgSourceContent — deterministic, sensitive to real changes ─
  assertEq(
    hashGardssalgSourceContent("samme tekst"),
    hashGardssalgSourceContent("samme tekst"),
    "31: hashing the same text twice yields the same hash (deterministic)"
  );
  assertTrue(
    hashGardssalgSourceContent("tekst A") !== hashGardssalgSourceContent("tekst B"),
    "32: hashing different text yields different hashes"
  );

  // ── current_defective_no_clean_candidate: current IS defective but no ───
  // ── clean candidate exists to replace it with (report-mode precision) ───
  assertEq(
    planGardssalgFieldReplacement("about_text", CSS_LEAK_CURRENT, null),
    { shouldReplace: false, reason: "current_defective_no_clean_candidate" },
    "33: defective current (CSS leakage) + no candidate -> reports the real current-side defect instead of a generic null reason"
  );
  assertEq(
    planGardssalgFieldReplacement("about_text", CSS_LEAK_CURRENT, "Kort."),
    { shouldReplace: false, reason: "current_defective_no_clean_candidate" },
    "34: defective current (CSS leakage) + a candidate that is ITSELF defective (too_short) -> still reports the real current-side defect, not null"
  );
  assertEq(
    planGardssalgFieldReplacement("opening_hours_text", BRINGEBAERLANDET_HOURS, BRINGEBAERLANDET_HOURS),
    { shouldReplace: false, reason: "current_defective_no_clean_candidate" },
    "35 (AC12/13 regression, Bringebærlandet ce85458a): a fresh candidate extracted from the same defective page " +
      "region inherits the identical UI-chrome leakage ('Previous Next') as the current value -- the defect is " +
      "still surfaced (current_defective_no_clean_candidate), never silently dropped to reason:null"
  );

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runGardssalgQualityUpdateTests({ log: true });
  console.log(`\n${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
