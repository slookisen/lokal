/**
 * rfb-outreach-template.test.ts — the RFB cold-outreach e-mail as code
 * (dev-request 2026-09-19-rfb-marketing-utsending-inn-i-plattformjobben).
 *
 * Pins the rendered texts H, I and J byte-for-byte against the approved v4
 * draft (dev-request 2026-10-22-rfb-utsending-v4, AC0-AC2), the A/B subject
 * rule, the {N} rounding, the validate_profile_url class guard and the
 * render's refusal to produce anything the template does not describe. Pure —
 * no DB, no I/O.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/rfb-outreach-template.test.ts
 *   2. Wired into the gate: tests/test.ts.
 */

import {
  RFB_OUTREACH_TEMPLATE_ID,
  RFB_OUTREACH_FOLLOWUP_TEMPLATE_ID,
  formatProducerCount,
  isValidRfbProfileUrl,
  renderRfbOutreachEmail,
  renderRfbOutreachFollowup,
  renderRfbThankYouV4,
  rfbOutreachProducerCountLabel,
  rfbOutreachSubject,
  rfbOutreachSubjectVariant,
  rfbOwnerUrl,
  roundProducerCountDown,
} from "./rfb-outreach-template";
import { plainTextToEmailHtml } from "../utils/plain-text-to-html";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// The expected texts, written out independently of the implementation — the
// approved draft (A2A marketing-drafts/2026-10-22-utsendingstekster-v4-rfb.md,
// texts H, I and J) with its fields filled for the fixtures below. Every line
// is one source line of the draft; blank lines between paragraphs.
function expectedH(opts: { navn: string; N: string; url: string; hei: string }): string {
  return [
    opts.hei,
    "",
    `Jeg har ett spørsmål om ${opts.navn}: stemmer varene som står på siden deres? Jeg heter Daniel Fredriksen og driver Rett fra Bonden, en gratis oversikt over mer enn ${opts.N} norske matprodusenter. Dere står der allerede:`,
    "",
    opts.url,
    "",
    "Varene er det vi oftest tar feil av, så et kort svar hjelper mye. Er noe annet feil, kan dere bare svare på denne e-posten, så retter jeg det.",
    "",
    "Grunnen til at jeg gjør dette, er at mange nå spør ChatGPT og lignende tjenester om hvor de kan kjøpe lokal mat. Små produsenter kommer ofte ikke med i svarene, fordi informasjonen om dem er spredt eller gammel. Rett fra Bonden samler den og setter den opp slik at disse tjenestene kan lese den. Det erstatter ikke nettsiden deres, men gjør at dere blir funnet der folk nå spør.",
    "",
    "Det koster ingenting å stå der, og dere binder dere ikke til noe. Vil dere styre siden selv, svarer dere bare på denne e-posten, så hjelper jeg dere med å ta den over.",
    "",
    "Vil dere ikke være med, svarer dere bare «fjern», så tar jeg siden ned innen et døgn.",
    "",
    "Vennlig hilsen",
    "Daniel Fredriksen",
    "Rett fra Bonden",
    "905 737 34",
    "",
    "Slik behandler jeg opplysningene: https://rettfrabonden.com/personvern",
  ].join("\n");
}

function expectedI(opts: { navn: string; maaned: string; url: string }): string {
  return [
    "Hei igjen,",
    "",
    `Jeg skrev til dere ${opts.maaned} om ${opts.navn} på Rett fra Bonden. Det holder med ett ord: stemmer varene som står der, ja eller nei?`,
    "",
    opts.url,
    "",
    "Det er gratis å stå der. Vil dere ikke være med, svarer dere «fjern». Jeg skriver ikke igjen om dette.",
    "",
    "Vennlig hilsen",
    "Daniel Fredriksen",
    "",
    "Slik behandler jeg opplysningene: https://rettfrabonden.com/personvern",
  ].join("\n");
}

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
    // ── t1: text H byte for byte, both subject arms, with and without first name (AC1)
    const exA = {
      agentId: "9654d228-9fe7-4c9b-9ba7-e4ca4b0e8e56", // …6 even → A
      producerName: "Inderøy Mosteri — Inderøy",
      profileUrl: "https://rettfrabonden.com/produsent/inderoy-mosteri-inderoy",
      producerCountTotal: 1746,
    };
    const exB = {
      agentId: "58f4a132-3b23-0a41-f766-da7e39e06505", // …5 odd → B
      producerName: "Strandkaien Fisk AS, Bergen",
      profileUrl: "https://rettfrabonden.com/produsent/strandkaien-fisk",
      producerCountTotal: 12345,
    };
    const hA = renderRfbOutreachEmail(exA);
    assertEq(
      hA.text,
      expectedH({ navn: "Inderøy Mosteri", N: "1 700", url: exA.profileUrl, hei: "Hei," }),
      "t1: H arm A, no first name, equals the draft byte for byte",
    );
    assertEq(hA.subject, "Har vi riktig info om Inderøy Mosteri?", "t1: subject A, washed name (cut at « — »)");
    assertEq(hA.variant, "A", "t1: variant A");
    assertEq(hA.template, "rfb-outreach-v4", "t1: template id rfb-outreach-v4");
    const hB = renderRfbOutreachEmail({ ...exB, contactFirstName: "Vidar" });
    assertEq(
      hB.text,
      expectedH({ navn: "Strandkaien Fisk", N: "12 300", url: exB.profileUrl, hei: "Hei Vidar," }),
      "t1: H arm B, with first name, name washed (« AS» after «, » cut), equals the draft byte for byte",
    );
    assertEq(hB.subject, "Spørsmål om varene til Strandkaien Fisk", "t1: subject B");
    assertEq(hB.variant, "B", "t1: variant B");
    const hBnoName = renderRfbOutreachEmail(exB);
    assertTrue(hBnoName.text.startsWith("Hei,\n\n"), "t1: no first name → «Hei,»");
    assertEq(hB.text.slice("Hei Vidar,".length), hBnoName.text.slice("Hei,".length), "t1: the first name changes the greeting line only");
    const blank = renderRfbOutreachEmail({ ...exB, contactFirstName: "   " });
    assertTrue(blank.text.startsWith("Hei,\n\n"), "t1: whitespace-only name → «Hei,»");

    // ── t2: layout rules (AC1) ─────────────────────────────────────────────
    for (const [label, t] of [["H/A", hA.text], ["H/B", hB.text]] as const) {
      const paras = t.split("\n\n");
      const sig = paras.findIndex((p) => p.startsWith("Vennlig hilsen"));
      assertTrue(sig > 0, `t2: ${label} has a signature paragraph`);
      assertTrue(paras.every((p, i) => i === sig || !p.includes("\n")), `t2: ${label} no paragraph contains \\n except the signature block`);
      assertEq(paras[sig], "Vennlig hilsen\nDaniel Fredriksen\nRett fra Bonden\n905 737 34", `t2: ${label} signature block with the phone number`);
      assertTrue(!/katalog/i.test(t), `t2: ${label} never says «katalog»`);
      assertTrue(!/registrert|oppføring/i.test(t), `t2: ${label} never says «registrert»/«oppføring»`);
      assertTrue(t.includes("«fjern»"), `t2: ${label} has the «fjern» line`);
      assertTrue(t.includes("https://rettfrabonden.com/personvern"), `t2: ${label} links /personvern`);
      assertTrue(t.includes("905 737 34"), `t2: ${label} has 905 737 34`);
      assertTrue(!t.includes("\n\n\n"), `t2: ${label} no double blank line`);
      assertTrue(!/\{[a-zæøå_]+\}/i.test(t), `t2: ${label} no unfilled placeholder`);
    }
    // Daniel 2026-11-01: H and J ask the producer to reply instead of linking the claim flow.
    assertTrue(!hA.text.includes("selger?agent") && !hB.text.includes("selger?agent"), "t2: H carries no {eier_url} (A and B)");
    assertTrue(!hA.text.includes("uten passord") && hA.text.includes("svarer dere bare på denne e-posten, så hjelper jeg dere med å ta den over."), "t2: H asks for a reply to take the page over");
    assertEq(rfbOwnerUrl("abc"), "https://rettfrabonden.com/selger?agent=abc", "t2: rfbOwnerUrl");
    const links = hA.text.match(/https?:\/\/\S+/g) || [];
    assertEq(links, [exA.profileUrl, "https://rettfrabonden.com/personvern"], "t2: exactly two links (profile, privacy), both on rettfrabonden.com");
    assertEq(hA.text.includes("da.fredriksen@gmail.com"), false, "t2: private e-mail never in outbound text");

    // ── t3: text I byte for byte, threaded and unthreaded (AC1, AC4) ───────
    const iThreaded = renderRfbOutreachFollowup({ ...exA, monthPhrase: "i september", firstSubject: "Har vi riktig info om Inderøy Mosteri?" });
    assertEq(iThreaded.text, expectedI({ navn: "Inderøy Mosteri", maaned: "i september", url: exA.profileUrl }), "t3: I equals the draft byte for byte (example 1)");
    assertEq(iThreaded.subject, "Re: Har vi riktig info om Inderøy Mosteri?", "t3: threaded follow-up has subject «Re: <first subject>»");
    assertEq(iThreaded.template, "rfb-outreach-v4-followup", "t3: template id rfb-outreach-v4-followup");
    const iB = renderRfbOutreachFollowup({ ...exB, monthPhrase: "tidligere denne måneden", firstSubject: null });
    assertEq(iB.text, expectedI({ navn: "Strandkaien Fisk", maaned: "tidligere denne måneden", url: exB.profileUrl }), "t3: I equals the draft byte for byte (example 2, name washed)");
    assertEq(iB.subject, "Har vi riktig info om Strandkaien Fisk?", "t3: no first mail known → new mail with subject A (even for an arm-B agent)");
    const iOld = renderRfbOutreachFollowup({ ...exB, monthPhrase: "i desember i fjor", firstSubject: "  " });
    assertEq(iOld.subject, "Har vi riktig info om Strandkaien Fisk?", "t3: blank first subject → subject A");
    assertTrue(iThreaded.text.split("\n\n").every((p) => !p.includes("\n") || p.startsWith("Vennlig hilsen")), "t3: I has no \\n inside a paragraph except the signature");
    assertTrue(!/katalog/i.test(iThreaded.text), "t3: I never says «katalog»");
    assertTrue(!iThreaded.text.includes("eierskap") && !iThreaded.text.includes("selger?agent"), "t3: I has no ownership link (it is a one-word question)");
    assertThrows(() => renderRfbOutreachFollowup({ ...exA }), /month phrase/, "t3: follow-up without {måned} refused");

    // ── t4: text J (CS thank-you) byte for byte ────────────────────────────
    const jFixed = renderRfbThankYouV4({ agentId: exA.agentId, profileUrl: exA.profileUrl, firstName: "Vidar", corrected: true });
    assertEq(
      jFixed,
      [
        "Hei Vidar,",
        "",
        `Takk for svaret. Jeg har rettet siden, og den ser nå slik ut: ${exA.profileUrl}`,
        "",
        "Endrer noe seg, kan dere svare på denne e-posten når som helst. Vil dere heller styre siden selv, svarer dere bare på denne e-posten, så hjelper jeg dere med å ta den over.",
        "",
        "Vennlig hilsen",
        "Daniel Fredriksen",
      ].join("\n"),
      "t4: J (corrected) equals the draft byte for byte, no {eier_url}",
    );
    const jConfirmed = renderRfbThankYouV4({ agentId: exA.agentId, profileUrl: exA.profileUrl, firstName: "Vidar", corrected: false });
    assertTrue(jConfirmed.includes(`Takk for svaret. Da står siden slik den er: ${exA.profileUrl}\n\n`), "t4: J (confirmed only) uses the draft's alternative first sentence");

    // ── t5: HTML part — no <br> inside a prose paragraph (AC2) ────────────
    for (const [label, t] of [["H/A", hA.text], ["H/B", hB.text], ["I", iThreaded.text]] as const) {
      const html = plainTextToEmailHtml(t);
      const ps = html.split("\n");
      assertEq(ps.length, t.split("\n\n").length, `t5: ${label} one <p> per paragraph`);
      const prose = ps.filter((p) => !p.includes("Vennlig hilsen"));
      assertTrue(prose.every((p) => !p.includes("<br>")), `t5: ${label} no <br> in any prose paragraph`);
      assertTrue(ps.every((p) => !p.includes("\n")), `t5: ${label} no raw newline inside a <p>`);
    }
    const hHtml = plainTextToEmailHtml(hA.text);
    assertTrue(hHtml.includes("<p>Vennlig hilsen<br>Daniel Fredriksen<br>Rett fra Bonden<br>905 737 34</p>"), "t5: the signature block keeps its four short lines");

    // ── t6: A/B split — last hex digit (unchanged rule) ────────────────────
    assertEq(rfbOutreachSubjectVariant("53a89619-50d0-4ee9-919c-adbc1b119f74"), "A", "t6: …f74 (4, even) → A");
    assertEq(rfbOutreachSubjectVariant("58f4a132-3b23-0a41-f766-da7e39e06505"), "B", "t6: …505 (5, odd) → B");
    assertEq(rfbOutreachSubjectVariant("58F4A132-3B23-0A41-F766-DA7E39E0650B"), "B", "t6: uppercase hex handled");
    assertEq(rfbOutreachSubjectVariant("1247"), "B", "t6: legacy decimal id 1247 → B");
    assertEq(rfbOutreachSubjectVariant("agent-xyz"), "A", "t6: non-hex last char → A");
    assertEq(rfbOutreachSubjectVariant(""), "A", "t6: empty id → A");
    assertEq(rfbOutreachSubject("A", "Haugerud Gård"), "Har vi riktig info om Haugerud Gård?", "t6: subject A wording");
    assertEq(rfbOutreachSubject("B", "Haugerud Gård"), "Spørsmål om varene til Haugerud Gård", "t6: subject B wording");
    assertEq(rfbOutreachSubject("A", "Bakke Honning ENK"), "Har vi riktig info om Bakke Honning?", "t6: company form dropped");

    // ── t7: {N} — rounded DOWN to hundreds ─────────────────────────────────
    assertEq(roundProducerCountDown(1743), 1700, "t7: 1743 → 1700");
    assertEq(roundProducerCountDown(1799), 1700, "t7: rounds down, never up");
    assertEq(rfbOutreachProducerCountLabel(1743), "1 700", "t7: label 1 700");
    assertEq(rfbOutreachProducerCountLabel(716), "700", "t7: below a thousand, no separator");
    assertEq(rfbOutreachProducerCountLabel(12345), "12 300", "t7: plain-space thousands separator");
    assertEq(rfbOutreachProducerCountLabel(99), null, "t7: < 100 → null (caller must not send)");
    assertEq(rfbOutreachProducerCountLabel(Number.NaN), null, "t7: NaN → null");
    assertEq(formatProducerCount(1000000), "1 000 000", "t7: formatProducerCount groups every three digits");

    // ── t8: validate_profile_url (canonical-url addendum class guard) ─────
    assertTrue(isValidRfbProfileUrl("https://rettfrabonden.com/produsent/haugerud-gard-regenerativt"), "t8: canonical URL accepted");
    assertEq(isValidRfbProfileUrl("https://rettfrabonden.comhttps://rettfrabonden.com/produsent/toten-kjott-as"), false, "t8: double-prefix class rejected");
    assertEq(isValidRfbProfileUrl("https://rettfrabonden.com/produsent/x/"), false, "t8: trailing slash rejected");
    assertEq(isValidRfbProfileUrl("http://rettfrabonden.com/produsent/x"), false, "t8: http rejected");
    assertEq(isValidRfbProfileUrl("https://rettfrabonden.com/produsent/Haugerud"), false, "t8: uppercase slug rejected");

    // ── t9: refusals instead of improvisation ──────────────────────────────
    assertThrows(() => renderRfbOutreachEmail({ ...exA, producerName: "  " }), /producer name is empty/, "t9: empty producer name refused");
    assertThrows(
      () => renderRfbOutreachEmail({ ...exA, profileUrl: "https://rettfrabonden.comhttps://rettfrabonden.com/produsent/x" }),
      /validate_profile_url/,
      "t9: invalid profile URL refused",
    );
    assertThrows(() => renderRfbOutreachEmail({ ...exA, producerCountTotal: 42 }), /too small/, "t9: producer count too small refused");
    assertEq(RFB_OUTREACH_TEMPLATE_ID, "rfb-outreach-v4", "t9: first-contact template id constant");
    assertEq(RFB_OUTREACH_FOLLOWUP_TEMPLATE_ID, "rfb-outreach-v4-followup", "t9: follow-up template id constant");

    // ── t10: deterministic ─────────────────────────────────────────────────
    assertEq(JSON.stringify(renderRfbOutreachEmail(exA)), JSON.stringify(hA), "t10: same input → identical output");
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
