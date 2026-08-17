/**
 * css-favicon-extraction-guards.test.ts — pins two extraction false-positive
 * bugs that caused the W34 weekly spot-check breach (26.7% mismatch rate,
 * `controller/enrichment-write-pause.yaml` `rfb.enabled: true`,
 * A2A dev-request 2026-08-17-enrichment-css-favicon-extraction-guards):
 *
 *   1. extractPhone() built its search text with only a generic tag-strip
 *      (`html.replace(/<[^>]+>/g, " ")`), which removes TAGS but not the
 *      CONTENT of <script>/<style> blocks. A Tailwind-generated CSS rule
 *      like `.bg-\[\#79656569\]{background-color:#79656569}` living inside a
 *      <style> block survives as 8 bare digits and can pass the phone
 *      regex + every existing plausibility guard. Confirmed live: Austrått
 *      Kaffebrenneri's stored phone `79656569` existed ONLY as a Tailwind
 *      hex-alpha class, never as a phone number anywhere on the page.
 *   2. extractEmail()'s bare-email-regex fallback ran directly against the
 *      RAW, untagged html string, so `<link rel="icon"
 *      href="favicon@2x.png">` matched inside the raw href attribute string
 *      ("png" is 3 letters, satisfies the TLD-shaped `[a-zA-Z]{2,}` tail).
 *      Confirmed live: LOKAL Matkvartalet Hamar's stored email
 *      `favicon@2x.png` — no real email existed anywhere in the page.
 *
 * Both fixes are narrow additive guards reusing an already-established
 * pattern in the same file (extractPageText's script/style strip) — see
 * marketplace.ts for the fix sites.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/css-favicon-extraction-guards.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runCssFaviconExtractionGuardsTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 *
 * extractPhone/extractEmail are pure functions of an html string (no DB, no
 * fetch), so this file mirrors the lightweight harness used by the sibling
 * homepage-provenance-contact-extraction-fix.test.ts rather than a
 * DB/router-backed harness.
 */

import { extractPhone, extractEmail } from "./marketplace";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCssFaviconExtractionGuardsTests(
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

  // ── Bug 1: extractPhone — Tailwind CSS hex-alpha class inside <style> ────

  // Reproduces the real Austrått Kaffebrenneri page shape: a Tailwind
  // arbitrary-value hex-alpha background class sits inside a <style> block,
  // and there is NO real phone number anywhere else in visible body text.
  // Must return null, not the CSS digits "79656569".
  //
  // NOTE on the second style rule (`:root{--call:79656569}`): included
  // alongside the named Tailwind class so this fixture is genuinely
  // mutation-sensitive to the NEW guard specifically. The Tailwind
  // hex-alpha class's digits are always immediately preceded by "#" (with
  // or without a backslash escape) and so already fail the pre-existing
  // hasPhoneContext direct-adjacency check (bug fix 4, slice D) on their
  // own regardless of this fix — verified empirically while building this
  // test (reverting ONLY the new script/style-strip guard still returned
  // null for the hex-alpha class alone). A plain custom-property-style
  // "--call:<digits>" snippet is a realistic enough alternate shape (theme/
  // widget CSS custom properties are common) whose digits sit directly
  // after "call:" with no intervening punctuation, so it DOES satisfy
  // hasPhoneContext's GENERIC_BEFORE check once <style> content survives
  // tag-stripping — i.e. without the new guard this exact fixture would
  // extract "79656569" as the phone (mutation-tested below); with the new
  // guard the entire <style> block (both rules) is dropped before the
  // phone regex ever runs, so this returns null.
  const htmlAustrattStyleOnly = `<html><head><style>
      .bg-\\[\\#79656569\\]{background-color:#79656569}
      :root{--call:79656569}
    </style></head><body>
      <p>Velkommen til Austrått Kaffebrenneri! Vi selger kaffe fra egen brenning.</p>
    </body></html>`;
  assertEq(
    extractPhone(htmlAustrattStyleOnly),
    null,
    "css-01: a Tailwind hex-alpha class + a CSS custom-property digit run inside a <style> block are not returned as a phone number when no real phone exists anywhere on the page",
  );

  // Regression-safety (positive control): the SAME fixture, but with a
  // genuine phone number also present in visible body text — the CSS noise
  // must not prevent the real number from being found and returned.
  const htmlAustrattStyleAndRealPhone = `<html><head><style>
      .bg-\\[\\#79656569\\]{background-color:#79656569}
      :root{--call:79656569}
    </style></head><body>
      <p>Velkommen til Austrått Kaffebrenneri! Ring oss på 91234567 for bestilling.</p>
    </body></html>`;
  assertEq(
    extractPhone(htmlAustrattStyleAndRealPhone),
    "91234567",
    "css-02: a genuine phone number in visible body text is still correctly extracted from the same style-block-bearing fixture (regression-safety)",
  );

  // Same false-positive class shape inside a <script> block (an unquoted
  // JS object-literal key, not just CSS) — extractPageText's established
  // fix strips both <script> and <style> content, so extractPhone must too.
  // "telefon:" with an unquoted key and no intervening punctuation before
  // the digits (a common minified-config-object shape) is what makes this
  // fixture mutation-sensitive to the new guard specifically — the earlier,
  // quoted-string-literal shape (`"79656569"`) already fails
  // hasPhoneContext's adjacency check on its own (the quote character
  // breaks direct adjacency), same caveat as css-01 above.
  const htmlScriptOnly = `<html><head><script>
      var widgetConfig = {telefon:79656569};
    </script></head><body>
      <p>Om oss: en liten gård i Trøndelag.</p>
    </body></html>`;
  assertEq(
    extractPhone(htmlScriptOnly),
    null,
    "css-03: an unquoted 'telefon:<digits>' config key inside a <script> block is not returned as a phone number when no real phone exists on the page",
  );

  // ── Bug 2: extractEmail — favicon filename false positive ────────────────

  // Reproduces the real LOKAL Matkvartalet Hamar page shape: only a favicon
  // <link> with an "@2x" filename, no real email anywhere on the page. Must
  // return null, not "favicon@2x.png".
  const htmlFaviconOnly =
    '<html><head><link rel="icon" href="favicon@2x.png"></head><body>' +
    "<p>Velkommen til Matkvartalet Hamar!</p></body></html>";
  assertEq(
    extractEmail(htmlFaviconOnly),
    null,
    "favicon-01: a favicon@2x.png href is not returned as an email when no real email exists anywhere on the page",
  );

  // Other known icon-extension shapes must be rejected the same way.
  const htmlFaviconIco =
    '<html><head><link rel="shortcut icon" href="favicon@1x.ico"></head><body>' +
    "<p>Ingen kontaktinfo her.</p></body></html>";
  assertEq(
    extractEmail(htmlFaviconIco),
    null,
    "favicon-02: a favicon@1x.ico href is not returned as an email (icon-extension guard covers .ico too)",
  );

  // Regression-safety (positive control 1): a genuine mailto: link in the
  // SAME favicon-bearing fixture must still be extracted correctly — the
  // mailto: path is unaffected by the icon-extension guard.
  const htmlFaviconAndMailto =
    '<html><head><link rel="icon" href="favicon@2x.png">' +
    '<body><a href="mailto:post@austrattkaffebrenneri.no">Kontakt oss</a></body></html>';
  assertEq(
    extractEmail(htmlFaviconAndMailto),
    "post@austrattkaffebrenneri.no",
    "favicon-03: a genuine mailto: link is still correctly extracted from a fixture that also has a favicon@2x.png href (regression-safety)",
  );

  // Regression-safety (positive control 2): a genuine bare visible-text
  // email (no mailto:) in the SAME favicon-bearing fixture must still be
  // extracted correctly — only the icon-extension-shaped candidate is
  // rejected, not every bare-fallback candidate.
  const htmlFaviconAndBareEmail =
    '<html><head><link rel="icon" href="favicon@2x.png"></head><body>' +
    "<p>Skriv til oss: post@austrattkaffebrenneri.no</p></body></html>";
  assertEq(
    extractEmail(htmlFaviconAndBareEmail),
    "post@austrattkaffebrenneri.no",
    "favicon-04: a genuine bare visible-text email is still correctly extracted via the bare-regex fallback from a fixture that also has a favicon@2x.png href (regression-safety)",
  );

  // Ordinary case, no favicon link at all: plain mailto: only.
  const htmlPlainMailto =
    '<html><body><a href="mailto:kontakt@example.no">E-post</a></body></html>';
  assertEq(
    extractEmail(htmlPlainMailto),
    "kontakt@example.no",
    "favicon-05: a plain mailto: link with no favicon link present extracts unchanged",
  );

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runCssFaviconExtractionGuardsTests({ log: true });
  console.log(`\n${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
