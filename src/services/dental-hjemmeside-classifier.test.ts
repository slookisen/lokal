/**
 * dental-hjemmeside-classifier.test.ts — unit tests for
 * src/services/dental-hjemmeside-classifier.ts (dev-request
 * 2026-07-18-dental-hjemmeside-directory-portal-cleanup).
 *
 * Pure/synchronous module — no DB, no HTTP. Covers:
 *   - true positives for each known directory domain (bare, "www.", and a
 *     subdomain variant)
 *   - business.site true positive
 *   - parking-hostname true positive
 *   - false positives NOT flagged: a normal clinic's own domain, null/empty/
 *     whitespace hjemmeside, a malformed URL (must not throw), a domain that
 *     merely CONTAINS a known-bad domain as a substring (not a real subdomain
 *     match) — e.g. "legelisten.no.evil-lookalike.no" or
 *     "notlegelisten.no" must NOT match "legelisten.no"
 *   - normalizeHostname never throws and strips scheme/path/query/www/port
 */

import {
  classifyHjemmeside,
  normalizeHostname,
  KNOWN_DIRECTORY_DOMAINS,
  KNOWN_PARKING_HOSTNAMES,
} from "./dental-hjemmeside-classifier";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDentalHjemmesideClassifierTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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

  return (async () => {
    try {
      // ── directory domains: true positives ────────────────────────────
      for (const domain of KNOWN_DIRECTORY_DOMAINS) {
        assertEq(
          classifyHjemmeside(`https://${domain}`),
          { isBad: true, reason: "directory" },
          `directory: https://${domain} -> flagged directory`,
        );
        assertEq(
          classifyHjemmeside(`https://www.${domain}/klinikk/oslo`),
          { isBad: true, reason: "directory" },
          `directory: https://www.${domain}/klinikk/oslo -> flagged directory (www + path stripped)`,
        );
        assertEq(
          classifyHjemmeside(`https://oslo.${domain}`),
          { isBad: true, reason: "directory" },
          `directory: subdomain oslo.${domain} -> flagged directory`,
        );
      }

      // ── business.site: true positives ────────────────────────────────
      assertEq(
        classifyHjemmeside("https://tannlegeoslo.business.site"),
        { isBad: true, reason: "business_site" },
        "business_site: *.business.site -> flagged",
      );
      assertEq(
        classifyHjemmeside("https://www.tannlegeoslo.business.site/"),
        { isBad: true, reason: "business_site" },
        "business_site: www + trailing slash -> still flagged",
      );

      // ── parking hostnames: true positives ────────────────────────────
      for (const host of KNOWN_PARKING_HOSTNAMES) {
        assertEq(
          classifyHjemmeside(`http://${host}`),
          { isBad: true, reason: "parked" },
          `parked: http://${host} -> flagged parked`,
        );
      }

      // ── false positives: must NOT be flagged ─────────────────────────
      assertEq(
        classifyHjemmeside("https://tannlege-oslo-sentrum.no"),
        { isBad: false, reason: null },
        "false-positive: a normal clinic's own domain -> not flagged",
      );
      assertEq(
        classifyHjemmeside(null),
        { isBad: false, reason: null },
        "false-positive: null hjemmeside -> not flagged",
      );
      assertEq(
        classifyHjemmeside(undefined),
        { isBad: false, reason: null },
        "false-positive: undefined hjemmeside -> not flagged",
      );
      assertEq(
        classifyHjemmeside(""),
        { isBad: false, reason: null },
        "false-positive: empty string hjemmeside -> not flagged",
      );
      assertEq(
        classifyHjemmeside("   "),
        { isBad: false, reason: null },
        "false-positive: whitespace-only hjemmeside -> not flagged",
      );
      assertTrue(
        (() => {
          try {
            const r = classifyHjemmeside("not a url at all !! %%");
            return r.isBad === false && r.reason === null;
          } catch {
            return false;
          }
        })(),
        "false-positive: malformed URL -> does not throw, not flagged",
      );
      assertEq(
        classifyHjemmeside("https://notlegelisten.no"),
        { isBad: false, reason: null },
        "false-positive: lookalike domain (notlegelisten.no) is NOT a subdomain match -> not flagged",
      );
      assertEq(
        classifyHjemmeside("https://legelisten.no.evil-lookalike.no"),
        { isBad: false, reason: null },
        "false-positive: known domain as a prefix of an unrelated host -> not flagged",
      );
      assertEq(
        classifyHjemmeside("https://businesssite.no"),
        { isBad: false, reason: null },
        "false-positive: 'businesssite.no' (no dot) is not *.business.site -> not flagged",
      );

      // ── normalizeHostname: never throws, strips consistently ─────────
      assertEq(
        normalizeHostname("https://www.Tannlege-Oslo.no:8080/om-oss?ref=x#top"),
        "tannlege-oslo.no",
        "normalizeHostname: scheme/www/port/path/query/fragment all stripped, lowercased",
      );
      assertEq(normalizeHostname(null), "", "normalizeHostname: null -> ''");
      assertEq(normalizeHostname(""), "", "normalizeHostname: '' -> ''");
      assertTrue(
        (() => {
          try {
            normalizeHostname("%%%not-a-url%%%");
            return true;
          } catch {
            return false;
          }
        })(),
        "normalizeHostname: garbage input does not throw",
      );
    } catch (err: any) {
      failed++;
      failures.push("dental-hjemmeside-classifier: unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ── dev-request 2026-09-02-dental-hjemmeside-hygiene-og-brreg-gjenfinning ──
    //    (steg 2a): extended directory list + "social" class.
    try {
      assertEq(
        classifyHjemmeside("https://www.tannlegernorge.no/trondelag/hoylandet/hoylandet-tannklinikk/"),
        { isBad: true, reason: "directory" },
        "tannlegernorge.no (distinct from tannlegerinorge.no) is a directory",
      );
      assertEq(classifyHjemmeside("https://aksdal.opusdentalonline.com/login.aspx"), { isBad: true, reason: "directory" }, "Opus booking portal is a directory");
      assertEq(classifyHjemmeside("https://maps.app.goo.gl/khd59A3DhXxvbekNA"), { isBad: true, reason: "directory" }, "Google Maps short link is a directory");
      assertEq(classifyHjemmeside("https://www.odont.uio.no/iko/personer/vit/thjortsj/"), { isBad: true, reason: "directory" }, "UiO staff page is a directory");
      assertEq(classifyHjemmeside("https://www.proff.no/selskap/x"), { isBad: true, reason: "directory" }, "proff.no is a directory");
      assertEq(classifyHjemmeside("https://www.facebook.com/bergdentalas/"), { isBad: true, reason: "social" }, "Facebook page is social");
      assertEq(classifyHjemmeside("https://nb-no.facebook.com/Finneidfjord-Tannklinikk-1499079680303795/"), { isBad: true, reason: "social" }, "localized Facebook subdomain is social");
      assertEq(classifyHjemmeside("https://www.instagram.com/klinikk"), { isBad: true, reason: "social" }, "Instagram is social");
      assertEq(classifyHjemmeside("https://tannlegegiving.no/"), { isBad: false, reason: null }, "own domain still not flagged");
      assertEq(classifyHjemmeside("https://www.mrfylke.no/tannhelse/klinikker/x"), { isBad: false, reason: null }, "fylkeskommune host is NOT flagged by this classifier (handled by dental-catalog-class)");
    } catch (err: any) {
      failed++;
      failures.push("dental-hjemmeside-classifier (steg 2a): unexpected error: " + String(err?.stack || err?.message || err));
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/services/dental-hjemmeside-classifier.test.ts`
if (require.main === module) {
  runDentalHjemmesideClassifierTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
