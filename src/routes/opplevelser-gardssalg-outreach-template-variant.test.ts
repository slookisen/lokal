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
    "p1: personal subject uses the corrected RFB formula «Har vi riktig info om …?»",
    personal.subject === `Har vi riktig info om ${NAME}?`,
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

  // AC1 (dev-request 2026-09-03-opplevagent-e-postmal-spraak-og-linjeskift): no
  // line inside `text` breaks mid-paragraph — `\n` occurs only as the `\n\n`
  // blank-line separator between paragraphs, or inside the signature block.
  const blocks = personal.text.replace(/\n+$/, "").split("\n\n");
  const signatureBlockIndex = blocks.findIndex((b) => b.startsWith("Mvh,"));
  check("p9: AC1 setup — the signature block is present and found", signatureBlockIndex !== -1);
  check(
    "p10: AC1 — no paragraph outside the signature block contains an internal line break (client wraps itself, not us)",
    blocks.every((b, i) => i === signatureBlockIndex || !b.includes("\n")),
  );

  const EXPECTED_PERSONAL_TEXT = `Hei,

Jeg har laget en profil for ${NAME} som del av en åpen katalog over norske drikkeprodusenter og gårdsopplevelser. Du finner den her:

${URL}

Bakgrunnen: AI-assistenter som ChatGPT og Claude svarer i økende grad direkte på spørsmål som «hvor kan jeg besøke en lokal produsent i nærheten». Norske produsenter forsvinner ofte i svarene fordi informasjonen deres ligger spredt. Jeg samler den på ett sted og holder profilene oppdaterte.

Det koster ingenting, og dere er ikke bundet til noe. Jeg ville bare sjekke at informasjonen stemmer, og at dere er OK med å være synlige der.

Si fra om noe må endres, eller om dere heller vil fjernes. Begge deler ordnes innen 24 timer.

Mvh,
Daniel Fredriksen
Opplevagent
kontakt@opplevagent.no

(Svar «fjern», så fjerner jeg profilen med en gang.)
`;
  check(
    "p11: personal text matches the corrected 2026-09-03 template verbatim (AC1+AC3 golden check)",
    personal.text === EXPECTED_PERSONAL_TEXT,
  );
  check(
    "p12: language fixes — 'som ChatGPT og Claude' (not '(typ ChatGPT, Claude)')",
    personal.text.includes("som ChatGPT og Claude") && !personal.text.includes("typ ChatGPT"),
  );
  check(
    "p13: language fixes — 'informasjonen deres' (not 'info-en deres')",
    personal.text.includes("informasjonen deres") && !personal.text.includes("info-en deres"),
  );
  check(
    "p14: language fixes — comma before 'og' in the two-independent-clauses sentence",
    personal.text.includes("ingenting, og dere er ikke bundet"),
  );
  check(
    "p15: language fixes — 'heller vil fjernes' (not 'helst fjernes')",
    personal.text.includes("heller vil fjernes") && !personal.text.includes("helst fjernes"),
  );
  check(
    "p16: language fixes — first-person 'Jeg samler den' (not 'Vi samler det')",
    personal.text.includes("Jeg samler den på ett sted") && !personal.text.includes("Vi samler det"),
  );
  check(
    "p17: content fix — the locked Telemark/bryggerier example question is gone",
    !personal.text.includes("Telemark") && !personal.text.includes("bryggerier kan jeg besøke"),
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
