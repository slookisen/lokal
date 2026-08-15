/**
 * admin-crm-compose-vertical.test.ts — static guards for the "Ny e-post"
 * compose modal in src/public/admin-crm.html.
 *
 * Background (2026-08-15, observed live by Daniel): POST /admin/crm/compose
 * has required an explicit `vertical` since the platform split (dev-request
 * 2026-07-27-crm-plattformadskillelse-opplevagent — composeSchema in
 * routes/crm.ts, deliberately no default), but the modal never sent the
 * field. Every manual send from the dashboard died with
 * `400 invalid body … path:["vertical"]`, surfaced as a raw JSON blob.
 *
 * The UI is a static HTML file with inline JS — there is no DOM harness in
 * this suite, so these are source-level honesty guards in the same spirit as
 * slik-fungerer-det.test.ts's content guards: they pin the exact properties
 * a future edit is most likely to quietly break.
 *
 * Covers:
 *   (a) the modal has a #composeNewVertical select whose options are exactly
 *       the three CRM_VERTICALS plus an empty must-choose placeholder
 *   (b) FAIL-CLOSED: no concrete platform is pre-selected in the markup, and
 *       openCompose() maps the 'all' filter to '' (must choose), never to a
 *       platform — a silent 'rfb' default is precisely how every pre-split
 *       CRM row got mis-tagged 'rfb' (see composeSchema's own comment)
 *   (c) sendCompose() blocks an empty vertical client-side BEFORE the POST,
 *       and includes `vertical` in the /compose payload
 *   (d) the resend_send confirm() names the platform identity that will be
 *       used, not a bare address
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-crm-compose-vertical.test.ts
 *   2. Wired into the gate via tests/test.ts.
 */

import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAdminCrmComposeVerticalTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log !== false;
  const summary: TestSummary = { passed: 0, failed: 0, failures: [] };

  const check = (name: string, cond: boolean) => {
    if (cond) {
      summary.passed++;
      if (log) console.log(`  ✓ ${name}`);
    } else {
      summary.failed++;
      summary.failures.push(name);
      if (log) console.error(`  ✗ ${name}`);
    }
  };

  const htmlPath = path.join(__dirname, "..", "public", "admin-crm.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  // (a) the select exists with exactly rfb|dental|experiences + empty placeholder
  const selectMatch = html.match(
    /<select id="composeNewVertical">([\s\S]*?)<\/select>/,
  );
  check("v1: #composeNewVertical select exists in the compose modal", !!selectMatch);
  const optionValues = [...(selectMatch?.[1] ?? "").matchAll(/<option value="([^"]*)"/g)].map(
    (m) => m[1],
  );
  check(
    "v2: options are exactly ['', 'rfb', 'dental', 'experiences'] (matches CRM_VERTICALS + must-choose placeholder)",
    JSON.stringify(optionValues) === JSON.stringify(["", "rfb", "dental", "experiences"]),
  );

  // (b) fail-closed: no option inside the vertical select is pre-selected —
  // the empty placeholder is the initial state, so a concrete platform can
  // never ride along unnoticed.
  check(
    "v3: no <option … selected> inside #composeNewVertical (empty placeholder is the initial state)",
    !!selectMatch && !/selected/.test(selectMatch[1]),
  );

  // (b) openCompose(): the 'all' filter must resolve to '' (forces a choice),
  // and never silently to a platform. Pin the exact guard expression.
  const openCompose = html.match(/function openCompose\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  check(
    "v4: openCompose() pre-selects from the global filter with the VERTICAL !== 'all' guard",
    /\(VERTICAL !== 'all'\) \? VERTICAL : ''/.test(openCompose),
  );

  const sendCompose = html.match(/async function sendCompose\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

  // (c) client-side guard runs BEFORE the POST and before the confirm()
  const guardIdx = sendCompose.indexOf("if (!vertical)");
  const postIdx = sendCompose.indexOf("api('/compose'");
  check("v5: sendCompose() reads #composeNewVertical", /composeNewVertical/.test(sendCompose));
  check(
    "v6: empty vertical is blocked client-side before the POST",
    guardIdx !== -1 && postIdx !== -1 && guardIdx < postIdx,
  );

  // (c) the payload carries vertical — as shorthand `vertical,` inside the
  // JSON.stringify body, alongside the unchanged createdBy: 'daniel'
  const payload = sendCompose.match(/JSON\.stringify\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
  check("v7: /compose payload includes `vertical`", /\bvertical,/.test(payload));
  check("v8: /compose payload keeps createdBy: 'daniel'", /createdBy: 'daniel'/.test(payload));

  // (b) the mis-tagging bug class: no hardcoded platform default anywhere in
  // the modal JS — neither `vertical: 'rfb'` in the payload nor `|| 'rfb'`
  // fallback (any platform literal, not just rfb).
  check(
    "v9: no hardcoded platform default (vertical: '<v>' or || '<v>') in sendCompose",
    !/vertical:\s*'(rfb|dental|experiences)'/.test(sendCompose) &&
      !/vertical\s*\|\|\s*'(rfb|dental|experiences)'/.test(sendCompose),
  );

  // (d) the resend_send confirm names the platform identity (display-name
  // form), not the bare shared address alone
  check(
    "v10: resend_send confirm() interpolates the platform display name (fromLabel)",
    /confirm\(`[\s\S]*\$\{fromLabel\}[\s\S]*kontakt@rettfrabonden\.com/.test(sendCompose),
  );

  return summary;
}

// Standalone runner
if (require.main === module) {
  runAdminCrmComposeVerticalTests({ log: true }).then((s) => {
    console.log(`\nadmin-crm-compose-vertical: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.error(`  FAILED: ${f}`);
      process.exit(1);
    }
  });
}
