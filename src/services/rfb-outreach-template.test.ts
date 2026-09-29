/**
 * rfb-outreach-template.test.ts — the RFB cold-outreach e-mail as code
 * (dev-request 2026-09-19-rfb-marketing-utsending-inn-i-plattformjobben).
 *
 * Pins the rendered text byte-for-byte against the effective A2A template
 * (v2 body + 2026-09-08 personal_observation retirement + 2026-09-09
 * signature/social-proof addendum), the A/B subject rule, the social-proof
 * rounding, the validate_profile_url class guard and the render's refusal to
 * produce anything the template does not describe. Pure — no DB, no I/O.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/rfb-outreach-template.test.ts
 *   2. Wired into the gate: tests/test.ts.
 */

import {
  RFB_OUTREACH_TEMPLATE_ID,
  formatProducerCount,
  isValidRfbProfileUrl,
  renderRfbOutreachEmail,
  rfbOutreachSocialProofLine,
  rfbOutreachSubject,
  rfbOutreachSubjectVariant,
  roundProducerCountDown,
} from "./rfb-outreach-template";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// The expected body, written out independently of the implementation — the
// A2A template with its placeholders filled for the fixture below.
const EXPECTED_TEXT = [
  "Hei,",
  "",
  "Jeg har laget en profil for Inderøy Mosteri — Inderøy som del av en åpen katalog",
  "over norske matprodusenter. Du finner den her:",
  "",
  "https://rettfrabonden.com/produsent/inderoy-mosteri-inderoy",
  "",
  "Katalogen har i dag over 1 700 norske matprodusenter.",
  "",
  "Bakgrunnen: AI-assistenter (typ ChatGPT, Claude) svarer i økende",
  "grad direkte på «hvor får jeg lokal honning i Asker»-spørsmål.",
  "Norske produsenter forsvinner ofte i svarene fordi info-en deres",
  "ligger spredt. Vi samler det på ett sted, og holder profilene",
  "oppdaterte.",
  "",
  "Det koster ingenting og dere er ikke bundet til noe. Jeg ville bare",
  "sjekke at info stemmer, og at dere er OK med å være synlige der.",
  "",
  "Si fra om noe må endres — eller om dere helst fjernes. Begge deler",
  "ordnes innen 24 timer.",
  "",
  "Mvh,",
  "Daniel Fredriksen",
  "Rett fra Bonden",
  "kontakt@rettfrabonden.com",
  "rettfrabonden.com",
  "",
  "(Svar «fjern» så slettes profilen automatisk.)",
].join("\n");

export function runRfbOutreachTemplateTests(opts: { log?: boolean } = {}): TestSummary {
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
    assertEq(cond, true, label);
  }
  function assertThrows(fn: () => unknown, pattern: RegExp, label: string): void {
    try {
      fn();
      assertTrue(false, `${label} (no throw)`);
    } catch (err) {
      assertTrue(pattern.test(err instanceof Error ? err.message : String(err)), label);
    }
  }

  try {
    // ── t1: the full rendered body, byte for byte ──────────────────────────
    // agent 9654d228-…e57 / Inderøy Mosteri is a real 2026-09-12 send
    // (A2A marketing-runs/2026-09-12/daily-summary.md): subject B.
    const fixture = {
      agentId: "9654d228-9fe7-4c9b-9ba7-e4ca4b0e8e57",
      producerName: "Inderøy Mosteri — Inderøy",
      profileUrl: "https://rettfrabonden.com/produsent/inderoy-mosteri-inderoy",
      producerCountTotal: 1746,
    };
    const r = renderRfbOutreachEmail(fixture);
    assertEq(r.text, EXPECTED_TEXT, "t1: rendered body equals the effective A2A template, byte for byte");
    assertEq(r.subject, "Profil-utkast for Inderøy Mosteri — Inderøy", "t1: subject B for an odd last hex digit (…e57), as sent 2026-09-12");
    assertEq(r.variant, "B", "t1: variant B");
    assertEq(r.template, RFB_OUTREACH_TEMPLATE_ID, "t1: template id carried");

    // ── t2: A/B split — «producer_id mod 2 == 0 → A» on the last hex digit ─
    assertEq(rfbOutreachSubjectVariant("53a89619-50d0-4ee9-919c-adbc1b119f74"), "A", "t2: …f74 (4, even) → A (Virgenes, sent A 2026-09-12)");
    assertEq(rfbOutreachSubjectVariant("628a12d7-2448-3401-9972-1ed816deb3da"), "A", "t2: …3da (a=10, even) → A");
    assertEq(rfbOutreachSubjectVariant("58f4a132-3b23-0a41-f766-da7e39e06505"), "B", "t2: …505 (5, odd) → B");
    assertEq(rfbOutreachSubjectVariant("58F4A132-3B23-0A41-F766-DA7E39E0650B"), "B", "t2: uppercase hex handled (B=11, odd) → B");
    assertEq(rfbOutreachSubjectVariant("1246"), "A", "t2: legacy decimal id 1246 → A (1246 mod 2 = 0)");
    assertEq(rfbOutreachSubjectVariant("1247"), "B", "t2: legacy decimal id 1247 → B");
    assertEq(rfbOutreachSubjectVariant("agent-xyz"), "A", "t2: non-hex last char → A (the template's «anbefalt» subject)");
    assertEq(rfbOutreachSubjectVariant(""), "A", "t2: empty id → A");
    assertEq(rfbOutreachSubjectVariant("a1b2 "), "A", "t2: trailing whitespace ignored (…2 → A)");

    // ── t3: subject wording ────────────────────────────────────────────────
    assertEq(rfbOutreachSubject("A", "Haugerud Gård"), "Har vi info riktig om Haugerud Gård?", "t3: subject A wording");
    assertEq(rfbOutreachSubject("B", "Haugerud Gård"), "Profil-utkast for Haugerud Gård", "t3: subject B wording");
    assertEq(rfbOutreachSubject("A", "  Haugerud Gård  "), "Har vi info riktig om Haugerud Gård?", "t3: producer name trimmed");

    // ── t4: social proof — rounded DOWN to hundreds, no verification claim ─
    assertEq(roundProducerCountDown(1743), 1700, "t4: 1743 → 1700 (the 2026-09-09 addendum's own example)");
    assertEq(roundProducerCountDown(1799), 1700, "t4: rounds down, never up");
    assertEq(roundProducerCountDown(1800), 1800, "t4: exact hundred kept");
    assertEq(rfbOutreachSocialProofLine(1743), "Katalogen har i dag over 1 700 norske matprodusenter.", "t4: the addendum's sentence");
    assertEq(rfbOutreachSocialProofLine(716), "Katalogen har i dag over 700 norske matprodusenter.", "t4: below a thousand, no separator");
    assertEq(rfbOutreachSocialProofLine(12345), "Katalogen har i dag over 12 300 norske matprodusenter.", "t4: plain-space thousands separator");
    assertEq(rfbOutreachSocialProofLine(99), null, "t4: < 100 after rounding → no sentence (caller must not send)");
    assertEq(rfbOutreachSocialProofLine(0), null, "t4: 0 → null");
    assertEq(rfbOutreachSocialProofLine(Number.NaN), null, "t4: NaN → null");
    assertEq(formatProducerCount(1000000), "1 000 000", "t4: formatProducerCount groups every three digits");

    // ── t5: validate_profile_url (canonical-url addendum class guard) ─────
    assertTrue(isValidRfbProfileUrl("https://rettfrabonden.com/produsent/haugerud-gard-regenerativt"), "t5: canonical URL accepted");
    assertEq(isValidRfbProfileUrl("https://rettfrabonden.comhttps://rettfrabonden.com/produsent/toten-kjott-as"), false, "t5: double-prefix class (2026-07-28 Toten Kjøtt) rejected");
    assertEq(isValidRfbProfileUrl("https://rettfrabonden.com/produsent/haugerud-gaard-regenerativt/"), false, "t5: trailing slash rejected");
    assertEq(isValidRfbProfileUrl("https://rettfrabonden.com/produsent/"), false, "t5: empty slug rejected");
    assertEq(isValidRfbProfileUrl("http://rettfrabonden.com/produsent/x"), false, "t5: http rejected");
    assertEq(isValidRfbProfileUrl("https://opplevagent.no/produsent/x"), false, "t5: foreign host rejected");
    assertEq(isValidRfbProfileUrl("https://rettfrabonden.com/produsent/haugerud-gård"), false, "t5: non-ASCII slug rejected");
    assertEq(isValidRfbProfileUrl("https://rettfrabonden.com/produsent/Haugerud"), false, "t5: uppercase slug rejected");

    // ── t6: greeting rule ──────────────────────────────────────────────────
    assertTrue(r.text.startsWith("Hei,\n\n"), "t6: no first name → «Hei,» (never «Hei ,»)");
    const named = renderRfbOutreachEmail({ ...fixture, contactFirstName: "Vidar" });
    assertTrue(named.text.startsWith("Hei Vidar,\n\n"), "t6: first name → «Hei Vidar,»");
    assertEq(named.text.slice("Hei Vidar,".length), r.text.slice("Hei,".length), "t6: the name changes the greeting line only");
    const blank = renderRfbOutreachEmail({ ...fixture, contactFirstName: "   " });
    assertTrue(blank.text.startsWith("Hei,\n\n"), "t6: whitespace-only name → «Hei,»");

    // ── t7: the 2026-09-08/09 addenda hold ─────────────────────────────────
    assertEq(r.text.includes("da.fredriksen@gmail.com"), false, "t7: private e-mail never in outbound text");
    assertEq(r.text.includes("verifiserte"), false, "t7: no «verifiserte» claim in the social-proof line");
    assertEq(r.text.includes("besøk i måneden"), false, "t7: visits clause removed");
    assertEq(/\{\{|\}\}/.test(r.text), false, "t7: no unfilled placeholder");
    assertEq(r.text.includes("\n\n\n"), false, "t7: dropped personal_observation leaves no double blank line");
    assertTrue(r.text.includes("\nRett fra Bonden\nkontakt@rettfrabonden.com\nrettfrabonden.com\n"), "t7: signature block with the platform address");
    assertEq((r.text.match(/https?:\/\//g) || []).length, 1, "t7: exactly one link — the canonical profile URL");

    // ── t8: refusals instead of improvisation ──────────────────────────────
    assertThrows(() => renderRfbOutreachEmail({ ...fixture, producerName: "  " }), /producer name is empty/, "t8: empty producer name refused");
    assertThrows(
      () => renderRfbOutreachEmail({ ...fixture, profileUrl: "https://rettfrabonden.comhttps://rettfrabonden.com/produsent/x" }),
      /validate_profile_url/,
      "t8: invalid profile URL refused",
    );
    assertThrows(() => renderRfbOutreachEmail({ ...fixture, producerCountTotal: 42 }), /too small/, "t8: producer count too small refused");

    // ── t9: deterministic ──────────────────────────────────────────────────
    assertEq(JSON.stringify(renderRfbOutreachEmail(fixture)), JSON.stringify(r), "t9: same input → identical output");
  } catch (err) {
    failed++;
    failures.push(`rfb-outreach-template: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runRfbOutreachTemplateTests({ log: true });
  console.log(`\nrfb-outreach-template: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    for (const f of r.failures) console.log(f);
    process.exit(1);
  }
}
