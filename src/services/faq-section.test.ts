/**
 * faq-section.test.ts — dev-request 2026-10-17-integrasjonstest-oppfolging,
 * I-E (SD-01): the shared visible-FAQ renderer (src/services/faq-section.ts).
 *
 * Covers:
 *   (a) faqPairsFromJsonLd() returns the Q/A pairs of a FAQPage in order,
 *       skips entries without a string question and answer, and gives [] for
 *       null, undefined, a non-object and a node without a mainEntity array.
 *   (b) renderFaqSection() renders one <h3>/<p> per pair inside
 *       <section id="faq">, in order, with the heading; "" for no pairs.
 *   (c) every text is escaped (`& < > " '`): a `</section><script>` in a
 *       question or answer stays text, and the heading and lang are escaped.
 *   (d) lang="…" only when asked for.
 *   (e) round trip: reading the rendered section back (unescaped) gives the
 *       same pairs as the FAQPage, so text and markup cannot drift.
 *
 * Run standalone: npx tsx src/services/faq-section.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

import { faqPairsFromJsonLd, renderFaqSection, type FaqPair } from "./faq-section";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function faqPage(pairs: FaqPair[]): any {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": "https://rettfrabonden.com/bergen#faq",
    mainEntity: pairs.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The visible pairs of a rendered section, unescaped. */
function readPairs(html: string): FaqPair[] {
  return [...html.matchAll(/<div class="faq-item"><h3>([\s\S]*?)<\/h3><p>([\s\S]*?)<\/p><\/div>/g)].map((m) => ({
    q: unescapeHtml(m[1]!),
    a: unescapeHtml(m[2]!),
  }));
}

export function runFaqSectionTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  const pairs: FaqPair[] = [
    { q: "Hvor mange lokale produsenter finnes i Bergen?", a: "Det er 12 lokale produsenter registrert i Bergen-området." },
    { q: "Hva slags lokalmat kan jeg finne i Bergen?", a: "Populære kategorier blant produsentene i Bergen er honning, ost." },
  ];

  // ── (a) faqPairsFromJsonLd ──────────────────────────────────────────────
  assertEq(faqPairsFromJsonLd(faqPage(pairs)), pairs, "a: pairs come back in order");
  assertEq(faqPairsFromJsonLd(null), [], "a: null -> []");
  assertEq(faqPairsFromJsonLd(undefined), [], "a: undefined -> []");
  assertEq(faqPairsFromJsonLd("FAQPage"), [], "a: a string -> []");
  assertEq(faqPairsFromJsonLd({ "@type": "FAQPage" }), [], "a: no mainEntity -> []");
  assertEq(faqPairsFromJsonLd({ mainEntity: { name: "q", acceptedAnswer: { text: "a" } } }), [], "a: mainEntity not an array -> []");
  assertEq(
    faqPairsFromJsonLd({
      mainEntity: [
        null,
        { name: "Bare spørsmål" },
        { acceptedAnswer: { text: "Bare svar" } },
        { name: 7, acceptedAnswer: { text: "tall" } },
        { name: "Gyldig?", acceptedAnswer: { text: "Ja." } },
      ],
    }),
    [{ q: "Gyldig?", a: "Ja." }],
    "a: entries without a string question and answer are skipped",
  );

  // ── (b) renderFaqSection ────────────────────────────────────────────────
  const html = renderFaqSection(pairs, { heading: "Ofte stilte spørsmål" });
  assertTrue(html.startsWith('<section id="faq" class="faq" aria-labelledby="faq-title">'), "b: <section id=\"faq\"> with the heading as its label");
  assertTrue(html.includes('<h2 id="faq-title">Ofte stilte spørsmål</h2>'), "b: heading rendered as <h2 id=\"faq-title\">");
  assertTrue(html.endsWith("</section>"), "b: section closes");
  assertEq((html.match(/<div class="faq-item">/g) || []).length, 2, "b: one .faq-item per pair");
  assertTrue(
    html.indexOf("Hvor mange lokale") < html.indexOf("Hva slags lokalmat"),
    "b: pairs keep their order",
  );
  assertEq(renderFaqSection([], { heading: "Ofte stilte spørsmål" }), "", "b: no pairs -> \"\" (no empty section)");

  // ── (c) escaping ────────────────────────────────────────────────────────
  const hostile: FaqPair[] = [
    { q: `Hva selger "Berg & Sønn's" <Gård>?`, a: `Berg & Sønn tilbyr </section><script>alert(1)</script>.` },
  ];
  const hostileHtml = renderFaqSection(hostile, { heading: `FAQ <b>&</b>`, lang: `nb"><script>` });
  assertTrue(!hostileHtml.includes("<script>"), "c: no raw <script> from a question, answer or lang");
  assertEq((hostileHtml.match(/<\/section>/g) || []).length, 1, "c: an answer cannot close the section early");
  assertTrue(hostileHtml.includes("&quot;Berg &amp; Sønn&#39;s&quot; &lt;Gård&gt;"), "c: question escapes & < > \" '");
  assertTrue(hostileHtml.includes("&lt;/section&gt;&lt;script&gt;alert(1)&lt;/script&gt;"), "c: answer escapes markup");
  assertTrue(hostileHtml.includes("<h2 id=\"faq-title\">FAQ &lt;b&gt;&amp;&lt;/b&gt;</h2>"), "c: heading escaped");
  assertTrue(hostileHtml.includes(' lang="nb&quot;&gt;&lt;script&gt;"'), "c: lang attribute escaped");

  // ── (d) lang attribute ──────────────────────────────────────────────────
  assertTrue(!html.includes(" lang="), "d: no lang attribute unless asked for");
  assertTrue(
    renderFaqSection(pairs, { heading: "Ofte stilte spørsmål", lang: "nb" }).startsWith('<section id="faq" class="faq" aria-labelledby="faq-title" lang="nb">'),
    "d: lang=\"nb\" on the section when asked for",
  );

  // ── (e) round trip ──────────────────────────────────────────────────────
  for (const set of [pairs, hostile]) {
    const ld = faqPage(set);
    const rendered = renderFaqSection(faqPairsFromJsonLd(ld), { heading: "Ofte stilte spørsmål" });
    assertEq(readPairs(rendered), faqPairsFromJsonLd(ld), `e: visible pairs equal the FAQPage pairs (${set === pairs ? "plain" : "hostile"} text)`);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── faq-section: visible FAQ from FAQPage pairs (dev-request 2026-10-17-integrasjonstest-oppfolging, I-E) ──");
  const r = runFaqSectionTests({ log: true });
  console.log(`\nfaq-section: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
