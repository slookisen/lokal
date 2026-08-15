/**
 * opplevelser-gardssalg-outreach-template-variant.test.ts — guards for the
 * A/B template variant added by dev-request
 * 2026-08-15-outreach-ab-standard-vs-personlig-drikke.
 *
 * Two layers:
 *   1. RENDERER guards (real function calls, no DB/transport): the
 *      "personal" variant is the RFB-style plain-text draft — RFB subject
 *      formula, text-only, platform signature — and the "standard" variant
 *      is byte-identical to the pre-existing renderGardssalgOutreach.
 *   2. SOURCE guards on routes/opplevelser.ts (same static style as
 *      admin-crm-compose-vertical.test.ts): the route validates the enum
 *      fail-closed, threads `template` into the send, and files via the
 *      variant dispatcher — the properties a future edit is most likely to
 *      quietly break, pinned where the full route harness would be overkill.
 *
 * The platform-separation guards (p5/p6) are the ones that matter most: the
 * personal draft borrows the RFB STYLE, never the RFB identity — no
 * rettfrabonden.com profile link, no personal-gmail signature (removed from
 * the RFB master template itself 2026-08-15, Daniel live).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/opplevelser-gardssalg-outreach-template-variant.test.ts
 *   2. Wired into the gate via tests/test.ts.
 */

import * as fs from "fs";
import * as path from "path";
import {
  renderGardssalgOutreach,
  renderGardssalgOutreachPersonal,
  renderGardssalgOutreachVariant,
} from "../services/email-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOpplevelserGardssalgOutreachTemplateVariantTests(
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

  const NAME = "Testbryggeriet ANS";
  const URL = "https://opplevagent.no/kategori/gardssalg/produsent/testbryggeriet-ans--deadbeef";

  // ── 1. Renderer guards ─────────────────────────────────────────────
  const personal = renderGardssalgOutreachPersonal(NAME, URL);
  const standard = renderGardssalgOutreach(NAME, URL);

  check(
    "p1: personal subject uses the RFB formula «Har vi info riktig om …?»",
    personal.subject === `Har vi info riktig om ${NAME}?`,
  );
  check(
    "p2: personal text carries the opplevagent.no profile URL exactly once",
    personal.text.split(URL).length === 2,
  );
  check("p3: personal is TEXT-ONLY (html undefined, never an empty string)", personal.html === undefined);
  check(
    "p4: personal signature is the platform address kontakt@opplevagent.no",
    personal.text.includes("kontakt@opplevagent.no"),
  );
  check(
    "p5: personal never references rettfrabonden (link OR signature — platform separation)",
    !personal.text.toLowerCase().includes("rettfrabonden"),
  );
  check(
    "p6: personal never carries the personal gmail the RFB template used to",
    !personal.text.includes("da.fredriksen@gmail.com"),
  );
  check(
    "p7: personal keeps the RFB draft's opt-out line («Svar «fjern» …»)",
    /Svar «fjern»/.test(personal.text),
  );
  check(
    "p8: Norwegian characters survive verbatim (no mojibake)",
    personal.text.includes("økende") && personal.text.includes("gårdsopplevelser") && !personal.text.includes("Ã"),
  );

  check(
    "s1: standard subject formula is untouched («Stemmer det vi har om …?»)",
    standard.subject === `Stemmer det vi har om ${NAME}?`,
  );
  check("s2: standard still renders HTML", typeof standard.html === "string" && standard.html.length > 0);

  // The two arms must be distinguishable by subject alone — that is the
  // attribution mechanism in every log (sent-log, CRM, Resend).
  check("d1: the two variants have different subjects", personal.subject !== standard.subject);

  const viaDispatcherStd = renderGardssalgOutreachVariant("standard", NAME, URL);
  const viaDispatcherPers = renderGardssalgOutreachVariant("personal", NAME, URL);
  check(
    "d2: dispatcher('standard') is byte-identical to renderGardssalgOutreach",
    JSON.stringify(viaDispatcherStd) === JSON.stringify(standard),
  );
  check(
    "d3: dispatcher('personal') is byte-identical to renderGardssalgOutreachPersonal",
    JSON.stringify(viaDispatcherPers) === JSON.stringify(personal),
  );

  // ── 2. Source guards on the route ──────────────────────────────────
  const routeSrc = fs.readFileSync(path.join(__dirname, "opplevelser.ts"), "utf8");
  const pilotBlock = routeSrc.slice(
    routeSrc.indexOf('router.post("/admin/gardssalg-outreach-pilot-send"'),
    routeSrc.indexOf('router.post("/admin/gardssalg-outreach-pilot-send"') + 12000,
  );

  check(
    "r1: route rejects unknown template values with a 400 (fail-closed enum)",
    pilotBlock.includes('template must be "standard" or "personal"'),
  );
  check(
    "r2: the send call threads `template` into sendGardssalgOutreach",
    /sendGardssalgOutreach\(email, providerName, profileUrl, \{\s*isTestSend: isTest,\s*template,/m.test(pilotBlock),
  );
  check(
    "r3: CRM filing renders via the variant dispatcher (same-copy-filed rule holds for both arms)",
    pilotBlock.includes("renderGardssalgOutreachVariant(template, providerName, profileUrl)"),
  );
  check(
    "r4: no bare renderGardssalgOutreach( call remains inside the pilot-send block",
    !/renderGardssalgOutreach\(/.test(pilotBlock.replace(/renderGardssalgOutreachVariant\(/g, "").replace(/renderGardssalgOutreachPersonal\(/g, "")),
  );

  return summary;
}

// Standalone runner
if (require.main === module) {
  runOpplevelserGardssalgOutreachTemplateVariantTests({ log: true }).then((s) => {
    console.log(`\ngardssalg-outreach-template-variant: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.error(`  FAILED: ${f}`);
      process.exit(1);
    }
  });
}
