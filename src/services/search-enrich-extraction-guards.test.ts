/**
 * search-enrich-extraction-guards.test.ts — pins the SECOND, INDEPENDENT
 * copy of the two extraction false-positive bugs fixed in marketplace.ts by
 * PR #629 (css-favicon-extraction-guards.test.ts / commit 1d5dcc0). PR #629
 * fixed `extractPhone`/`extractEmail` in `src/routes/marketplace.ts`, but did
 * not touch this file's own, separately-maintained `extractPhones`/
 * `extractEmails` (plural, array-returning) in `src/services/search-enrich.ts`
 * — code-commented "mirrors marketplace.extractPhone" but never actually
 * updated in step. This pipeline feeds `pickProducerEmail()` (writes the
 * producer's email) and `confirmProducerPage()` (uses `page.phones` as a
 * match signal), so the same two false-positive shapes could silently write
 * bad contact data via search-enrich's route just as they did via
 * marketplace's, per A2A dev-request
 * 2026-08-17-search-enrich-css-favicon-extraction-guards-parallel-gap:
 *
 *   1. extractPhones() built its search text with only a generic tag-strip
 *      (`html.replace(/<[^>]+>/g, " ")`), which removes TAGS but not the
 *      CONTENT of <script>/<style> blocks. A Tailwind-generated CSS rule or
 *      a JS config-object key living inside a <script>/<style> block
 *      survives as 8 bare digits and can pass the phone regex.
 *   2. extractEmails()'s bare-email-regex fallback had no guard against a
 *      `<link rel="icon" href="favicon@2x.png">`-style href matching as an
 *      email ("png"/"ico"/etc. satisfy the TLD-shaped `[a-zA-Z]{2,}` tail).
 *
 * Both fixes reuse the exact guards already established for the singular
 * marketplace.ts functions (see marketplace.ts / commit 1d5dcc0 for the
 * original fix sites). Unlike the marketplace singular functions
 * (`string | null`), `extractPhones`/`extractEmails` here are PLURAL — they
 * return arrays of ALL deduplicated candidates, not a single "best" pick —
 * so assertions below check array contents/length, not null-ness.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/services/search-enrich-extraction-guards.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runSearchEnrichExtractionGuardsTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 *
 * extractPhones/extractEmails are pure functions of an html string (no DB,
 * no fetch), so this file mirrors the lightweight harness used by the
 * sibling css-favicon-extraction-guards.test.ts.
 */

import { extractPhones, extractEmails } from "./search-enrich";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runSearchEnrichExtractionGuardsTests(
  opts: { log?: boolean } = {},
): TestSummary {
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

  // ── Bug 1: extractPhones — Tailwind CSS hex-alpha class inside <style> ───

  // Same fixture shape as css-favicon-extraction-guards.test.ts's css-01: a
  // Tailwind arbitrary-value hex-alpha background class plus a CSS
  // custom-property digit run inside a <style> block, no real phone number
  // anywhere in visible body text. Must return [], not ["79656569"].
  const htmlStyleOnly = `<html><head><style>
      .bg-\\[\\#79656569\\]{background-color:#79656569}
      :root{--call:79656569}
    </style></head><body>
      <p>Velkommen til Austrått Kaffebrenneri! Vi selger kaffe fra egen brenning.</p>
    </body></html>`;
  assertEq(
    extractPhones(htmlStyleOnly),
    [],
    "phones-01: a Tailwind hex-alpha class + a CSS custom-property digit run inside a <style> block are not returned in the phones array when no real phone exists anywhere on the page",
  );

  // Regression-safety (positive control): the SAME fixture, but with a
  // genuine phone number also present in visible body text — the CSS noise
  // must not prevent the real number from being found and returned.
  const htmlStyleAndRealPhone = `<html><head><style>
      .bg-\\[\\#79656569\\]{background-color:#79656569}
      :root{--call:79656569}
    </style></head><body>
      <p>Velkommen til Austrått Kaffebrenneri! Ring oss på 91234567 for bestilling.</p>
    </body></html>`;
  assertEq(
    extractPhones(htmlStyleAndRealPhone),
    ["91234567"],
    "phones-02: a genuine phone number in visible body text is still correctly extracted from the same style-block-bearing fixture (regression-safety)",
  );

  // Same false-positive class shape inside a <script> block (an unquoted
  // JS object-literal key), mirroring css-favicon-extraction-guards.test.ts's
  // css-03 — extractPhones must strip <script> content too, not just <style>.
  const htmlScriptOnly = `<html><head><script>
      var widgetConfig = {telefon:79656569};
    </script></head><body>
      <p>Om oss: en liten gård i Trøndelag.</p>
    </body></html>`;
  assertEq(
    extractPhones(htmlScriptOnly),
    [],
    "phones-03: an unquoted 'telefon:<digits>' config key inside a <script> block is not returned in the phones array when no real phone exists on the page",
  );

  // ── Bug (dev-request 2026-09-22-telefon-css-js-identifikator-falske-
  //    positiver): extractPhones — an 8-digit run embedded in a longer
  //    alphanumeric token (CSS class name / JS config blob), NOT wrapped in
  //    <script>/<style> — must be rejected even though bugs 1/3 above
  //    (script/style stripping) don't apply, because these two live
  //    incidents reached agent_knowledge.phone via markup OUTSIDE any
  //    <script>/<style> block. ────────────────────────────────────────────

  // Live incident 1: Bjørke Gård (bjorkegard.no) — "35267336" was the tail
  // of a Facebook SDK config JSON blob's `"facebookAppId":"314192535267336"`
  // rendered directly into the page body (e.g. a no-JS/SSR fallback), not
  // inside a <script> tag. Must return [], not ["35267336"].
  const htmlFacebookAppIdBlob =
    '<html><body><div id="fb-root"></div>' +
    '<div class="fb-config-fallback">{"facebookAppId":"314192535267336","xfbml":true}</div>' +
    "<p>Velkommen til Bjørke Gård! Vi selger egne produkter fra gården.</p>" +
    "</body></html>";
  assertEq(
    extractPhones(htmlFacebookAppIdBlob),
    [],
    "phones-04 (Bjørke Gård repro): an 8-digit slice of a longer facebookAppId digit run is not returned when no real phone exists anywhere on the page",
  );

  // Live incident 2: Drivhuset Bageri & Gårdsutsalg (drivhusetbageri.no) —
  // "45352419" was the tail of a Wix-generated CSS class name
  // `StylableButton2545352419`. Fixture places the class-name-shaped token
  // as page TEXT CONTENT (not inside a `class="..."` attribute) — an
  // attribute value is already stripped away wholesale by the generic
  // tag-strip regardless of this fix (it's inside `<...>`), so a fixture
  // that only put it in an attribute would pass BEFORE this fix too and
  // wouldn't actually exercise the new guard. This mirrors how such an
  // identifier can leak into rendered/visible markup (e.g. an SSR
  // warmup-data fallback block), matching the real incident shape: an
  // 8-digit run welded directly onto letters with no separator. Must
  // return [], not ["45352419"].
  const htmlWixClassName =
    '<html><body><div class="wix-warmup-fallback">{"compId":"StylableButton2545352419","type":"Container"}</div>' +
    "<p>Velkommen til Drivhuset Bageri &amp; Gårdsutsalg!</p>" +
    "</body></html>";
  assertEq(
    extractPhones(htmlWixClassName),
    [],
    "phones-05 (Drivhuset repro): an 8-digit slice of a longer Wix CSS class name digit run is not returned when no real phone exists anywhere on the page",
  );

  // Regression-safety (positive control): the SAME two junk shapes, but with
  // a genuine phone number ALSO present in visible body text — the junk
  // must not prevent the real number from being found and returned.
  const htmlJunkPlusRealPhone =
    '<html><body><div id="fb-root"></div>' +
    '<div class="fb-config-fallback">{"facebookAppId":"314192535267336"}</div>' +
    '<div class="wix-warmup-fallback">{"compId":"StylableButton2545352419"}</div>' +
    "<p>Velkommen til gården! Ring oss på 91234567 for bestilling.</p>" +
    "</body></html>";
  assertEq(
    extractPhones(htmlJunkPlusRealPhone),
    ["91234567"],
    "phones-06: a genuine phone number in visible body text is still correctly extracted alongside both junk shapes (regression-safety)",
  );

  // Positive controls — real phone numbers must keep extracting exactly as
  // before (visible text / tel: link visible text / near a JSON-LD block /
  // near a <meta> contact block), none of them glued to a surrounding
  // letter or digit with no separator.
  const phonePositiveControls: Array<{ label: string; html: string; expected: string[] }> = [
    {
      label: "phones-07: plain visible-text phone number, no other markup",
      html: "<html><body><p>Ring 91234567 for bestilling.</p></body></html>",
      expected: ["91234567"],
    },
    {
      label: "phones-08: a tel: link whose visible anchor text carries the same digits",
      html: '<html><body><a href="tel:+4791234567">91234567</a></body></html>',
      expected: ["91234567"],
    },
    {
      label: "phones-09: a real phone number in visible text alongside a JSON-LD <script> block (JSON-LD content itself stays stripped, unaffected by the new guard — the VISIBLE number is what's found)",
      html:
        '<html><head><script type="application/ld+json">{"@type":"LocalBusiness","telephone":"+4791234567"}</script></head>' +
        "<body><p>Kontakt: 91234567</p></body></html>",
      expected: ["91234567"],
    },
    {
      label: "phones-10: a real phone number in visible text next to a <meta> contact tag (the meta attribute itself stays stripped like any tag — the VISIBLE number is what's found)",
      html:
        '<html><head><meta name="contact:phone_number" content="+4791234567"></head>' +
        "<body><p>Telefon: 91234567</p></body></html>",
      expected: ["91234567"],
    },
  ];
  for (const c of phonePositiveControls) {
    assertEq(extractPhones(c.html), c.expected, c.label);
  }

  // ── Bug 2: extractEmails — favicon filename false positive ──────────────

  // Same fixture shape as css-favicon-extraction-guards.test.ts's favicon-01:
  // only a favicon <link> with an "@2x" filename, no real email anywhere on
  // the page. Must return [], not ["favicon@2x.png"].
  const htmlFaviconOnly =
    '<html><head><link rel="icon" href="favicon@2x.png"></head><body>' +
    "<p>Velkommen til Matkvartalet Hamar!</p></body></html>";
  assertEq(
    extractEmails(htmlFaviconOnly),
    [],
    "emails-01: a favicon@2x.png href is not returned in the emails array when no real email exists anywhere on the page",
  );

  // Other known icon-extension shapes must be rejected the same way.
  const htmlFaviconIco =
    '<html><head><link rel="shortcut icon" href="favicon@1x.ico"></head><body>' +
    "<p>Ingen kontaktinfo her.</p></body></html>";
  assertEq(
    extractEmails(htmlFaviconIco),
    [],
    "emails-02: a favicon@1x.ico href is not returned in the emails array (icon-extension guard covers .ico too)",
  );

  // Regression-safety (positive control 1): a genuine mailto: link in the
  // SAME favicon-bearing fixture must still be extracted correctly — the
  // mailto: path is collected separately and is unaffected by the
  // icon-extension guard.
  const htmlFaviconAndMailto =
    '<html><head><link rel="icon" href="favicon@2x.png">' +
    '<body><a href="mailto:post@austrattkaffebrenneri.no">Kontakt oss</a></body></html>';
  assertEq(
    extractEmails(htmlFaviconAndMailto),
    ["post@austrattkaffebrenneri.no"],
    "emails-03: a genuine mailto: link is still correctly extracted from a fixture that also has a favicon@2x.png href (regression-safety)",
  );

  // Regression-safety (positive control 2): a genuine bare visible-text
  // email (no mailto:) in the SAME favicon-bearing fixture must still be
  // extracted correctly — only the icon-extension-shaped candidate is
  // rejected, not every bare-fallback candidate.
  const htmlFaviconAndBareEmail =
    '<html><head><link rel="icon" href="favicon@2x.png"></head><body>' +
    "<p>Skriv til oss: post@austrattkaffebrenneri.no</p></body></html>";
  assertEq(
    extractEmails(htmlFaviconAndBareEmail),
    ["post@austrattkaffebrenneri.no"],
    "emails-04: a genuine bare visible-text email is still correctly extracted via the bare-regex fallback from a fixture that also has a favicon@2x.png href (regression-safety)",
  );

  // Ordinary case, no favicon link at all: plain mailto: only.
  const htmlPlainMailto =
    '<html><body><a href="mailto:kontakt@example.no">E-post</a></body></html>';
  assertEq(
    extractEmails(htmlPlainMailto),
    ["kontakt@example.no"],
    "emails-05: a plain mailto: link with no favicon link present extracts unchanged",
  );

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runSearchEnrichExtractionGuardsTests({ log: true });
  console.log(`\n${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
