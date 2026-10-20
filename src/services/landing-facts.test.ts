/**
 * landing-facts.test.ts -- dev-request 2026-10-16-finn-tannlege-landingssider,
 * skive F1-S3 (felles landing-gate, svar-først-avsnitt og FAQ).
 *
 *   A  countRealFacts: only finite numbers above zero are facts.
 *   B  passesLandingGate: minListings and minFacts, thresholds 1/2/5; the
 *      listing count is not one of the facts.
 *   C  buildAnswerFirst: 40-60 words, sentence order kept, null when thin.
 *   D  buildFactFaq: null under minQas, no Q/A without a number, escaping in
 *      the html, visible text = JSON-LD (same list), at most 5.
 *
 * Pure: no DB, no network.
 *
 * Standalone: npx tsx src/services/landing-facts.test.ts
 * Wired into tests/test.ts via runLandingFactsTests().
 */

import {
  countRealFacts,
  passesLandingGate,
  buildAnswerFirst,
  buildFactFaq,
  wordCount,
  LANDING_FAQ_MAX_QAS,
} from "./landing-facts";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runLandingFactsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  // ── A. countRealFacts ───────────────────────────────────────────────
  assertEq(countRealFacts({}), 0, "A1: no facts -> 0");
  assertEq(countRealFacts({ a: 3, b: 1 }), 2, "A2: two numbers above zero -> 2");
  assertEq(countRealFacts({ a: 0, b: null, c: undefined, d: NaN, e: Infinity, f: -2 }), 0, "A3: zero, null, undefined, NaN, Infinity and negatives are not facts");
  assertEq(countRealFacts({ a: 5, b: 0, c: null, d: 2 }), 2, "A4: mixed -> only the real ones");
  assertEq(countRealFacts({ a: "7" as unknown as number }), 0, "A5: a string is not a number fact");

  // ── B. passesLandingGate ────────────────────────────────────────────
  {
    const facts = (listings: number, ...others: Array<number | null>) => ({
      listings,
      helfo: others[0] ?? 0,
      akutt: others[1] ?? 0,
      spes: others[2] ?? 0,
    });
    for (const minFacts of [1, 2, 5]) {
      // facts that are real: helfo 4, akutt 2 -> 2 of them
      const f = facts(10, 4, 2, 0);
      assertEq(passesLandingGate(f, { minListings: 3, minFacts }), 2 >= minFacts, `B1: 2 real facts vs minFacts ${minFacts}`);
    }
    assertEq(passesLandingGate(facts(2, 4, 2, 1), { minListings: 3, minFacts: 2 }), false, "B2: too few listings fails though the facts are enough");
    assertEq(passesLandingGate(facts(3, 4, 2, 1), { minListings: 3, minFacts: 2 }), true, "B3: listings = minListings passes");
    assertEq(passesLandingGate(facts(100, 0, 0, 0), { minListings: 1, minFacts: 1 }), false, "B4: many listings but no real fact fails (the listing count is not a fact)");
    assertEq(passesLandingGate(facts(1, 1), { minListings: 1, minFacts: 1 }), true, "B5: threshold 1/1 with one listing and one fact passes");
    assertEq(passesLandingGate({ listings: NaN, a: 5, b: 5 }, { minListings: 0, minFacts: 1 }), false, "B6: a non-numeric listing count fails");
  }

  // ── C. buildAnswerFirst ─────────────────────────────────────────────
  {
    const w = (n: number, tag = "ord"): string => Array.from({ length: n }, () => tag).join(" ") + ".";
    assertEq(wordCount("  to   ord "), 2, "C0: wordCount trims and splits on whitespace");
    const okText = buildAnswerFirst([w(20, "a"), w(15, "b"), w(10, "c")]);
    assertEq(okText && wordCount(okText), 45, "C1: 45 words come out as they are");
    const capped = buildAnswerFirst([w(30, "a"), w(25, "b"), w(10, "c")]);
    assertEq(capped && wordCount(capped), 55, "C2: a sentence that would pass 60 words is left out (55 kept)");
    assertTrue(!!capped && !capped.includes("c "), "C3: and so is everything after it (order kept)");
    assertEq(buildAnswerFirst([w(20), w(10)]), null, "C4: under 40 words -> null (no thin paragraph)");
    assertEq(buildAnswerFirst([]), null, "C5: nothing -> null");
    const exactly = buildAnswerFirst([w(40, "x")]);
    assertEq(exactly && wordCount(exactly), 40, "C6: 40 words is allowed");
    const sixty = buildAnswerFirst([w(60, "x")]);
    assertEq(sixty && wordCount(sixty), 60, "C7: 60 words is allowed");
    assertEq(buildAnswerFirst([w(61, "x")]), null, "C8: one sentence of 61 words -> null");
    const first = buildAnswerFirst(["", "  ", w(45, "q")]);
    assertEq(first && wordCount(first), 45, "C9: empty sentences are skipped");
    const custom = buildAnswerFirst([w(5)], { minWords: 3, maxWords: 8 });
    assertEq(custom && wordCount(custom), 5, "C10: custom limits");
  }

  // ── D. buildFactFaq ─────────────────────────────────────────────────
  {
    const url = "https://example.test/sted/x";
    const qa = (n: number) => ({ q: `Spørsmål ${n}?`, a: `Svar med tallet ${n}.` });
    assertEq(buildFactFaq([qa(1)], { url, minQas: 2 }), { html: "", jsonLd: null }, "D1: one Q/A under minQas 2 -> no html and no JSON-LD");
    assertEq(buildFactFaq([], { url, minQas: 2 }), { html: "", jsonLd: null }, "D2: none -> nothing");

    const two = buildFactFaq([qa(1), qa(2)], { url, minQas: 2 });
    assertTrue(two.jsonLd !== null && two.html !== "", "D3: two Q/As at minQas 2 -> html and JSON-LD");
    assertEq((two.jsonLd as any)["@type"], "FAQPage", "D4: JSON-LD is a FAQPage");
    assertEq((two.jsonLd as any).url, url, "D5: JSON-LD carries the page url");

    const one = buildFactFaq([qa(1)], { url, minQas: 1 });
    assertTrue(one.jsonLd !== null, "D6: minQas 1 lets a single Q/A through");

    // No claim without a number.
    const mixed = buildFactFaq(
      [qa(1), { q: "Er alle gode?", a: "Ja, alle er gode." }, qa(2), { q: "Tom?", a: "" }],
      { url, minQas: 2 }
    );
    assertEq((mixed.jsonLd as any).mainEntity.map((e: any) => e.name), ["Spørsmål 1?", "Spørsmål 2?"], "D7: a Q/A whose answer has no digit is dropped");
    assertTrue(!mixed.html.includes("Er alle gode"), "D8: and it is not in the visible html either");
    assertEq(buildFactFaq([{ q: "A?", a: "ingen tall" }, { q: "B?", a: "heller ikke" }], { url, minQas: 2 }), { html: "", jsonLd: null }, "D9: only number-free Q/As -> nothing");

    // Same list for the visible text and the JSON-LD.
    const six = buildFactFaq([1, 2, 3, 4, 5, 6, 7].map(qa), { url, minQas: 2 });
    const names: string[] = (six.jsonLd as any).mainEntity.map((e: any) => e.name);
    const htmlQs = Array.from(six.html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g), (m) => m[1]!);
    assertEq(names.length, LANDING_FAQ_MAX_QAS, "D10: at most 5 Q/As");
    assertEq(htmlQs, names, "D11: the visible questions = the JSON-LD questions, in order");
    const answers: string[] = (six.jsonLd as any).mainEntity.map((e: any) => e.acceptedAnswer.text);
    const htmlAs = Array.from(six.html.matchAll(/<p style="margin:0">([^<]*)<\/p>/g), (m) => m[1]!);
    assertEq(htmlAs, answers, "D12: the visible answers = the JSON-LD answers");

    // Escaping.
    const evil = buildFactFaq(
      [
        { q: `Hva er <script>alert(1)</script> & "x"?`, a: `3 <img src=x onerror=alert(1)> 'y'` },
        qa(2),
      ],
      { url, minQas: 2, heading: `H <b>` }
    );
    assertTrue(!evil.html.includes("<script>") && !evil.html.includes("<img") && !evil.html.includes("<b>"), "D13: no raw tag from a question, an answer or the heading reaches the html");
    assertTrue(evil.html.includes("&lt;script&gt;") && evil.html.includes("&amp;") && evil.html.includes("&quot;x&quot;") && evil.html.includes("&#39;y&#39;"), "D14: the values are escaped, not dropped");
    assertEq((evil.jsonLd as any).mainEntity[0].name, `Hva er <script>alert(1)</script> & "x"?`, "D15: the JSON-LD keeps the plain text (it is serialised for <script> by the shell)");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runLandingFactsTests({ log: true }).then((r) => {
    console.log(`\nlanding facts (F1-S3): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
