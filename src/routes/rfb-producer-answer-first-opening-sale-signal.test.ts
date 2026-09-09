/**
 * rfb-producer-answer-first-opening-sale-signal.test.ts — unit tests for the
 * verb/closing-clause rewrite of buildProducerAnswerFirstOpening() and the
 * categories-fallback cap in buildProducerFaqJsonLd() (dev-request
 * 2026-09-09-rfb-profil-intro-setning-selger-bestill-direkte).
 *
 * Root cause fixed here: the producer-page opening sentence ALWAYS claimed
 * "selger ... bestill direkte" regardless of whether the sell-items list was
 * a real, sourced product catalog or just generic category-tag fallback, and
 * regardless of whether the producer has any confirmed direct-sale channel.
 * Confirmed wrong live for Smaken av Grimstad (no shop, long-shelf-life
 * products — not "Kjøtt, Grønnsaker, Egg"), Øverland Andelslandbruk (sells
 * memberships, not vegetables), and Soli Brug (an art gallery/café wrongly
 * tagged with a food category).
 *
 * Two new optional params — productsAreSourced, hasDirectSaleSignal — drive
 * a 3-way verb choice (tilbyr / selger / produserer) and a 2-way closing
 * clause (bestill direkte / finn kontaktinfo). Both default false, so any
 * caller that omits them gets the conservative wording, never the old wrong
 * default.
 *
 * Run standalone: npx tsx src/routes/rfb-producer-answer-first-opening-sale-signal.test.ts
 * Wired into the gate: tests/test.ts imports runRfbProducerAnswerFirstOpeningSaleSignalTests().
 */

import { buildProducerAnswerFirstOpening, buildProducerFaqJsonLd, deriveProductsAreSourced } from "./seo";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runRfbProducerAnswerFirstOpeningSaleSignalTests(opts: { log?: boolean } = {}): TestSummary {
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

  const baseParams = {
    name: "Smaken av Grimstad",
    cityName: "Grimstad",
    productsList: [{ name: "syltetøy" }, { name: "saft" }, { name: "sylte agurk" }],
    categories: ["meat", "vegetables", "eggs"],
  };

  // ── (a) NB: category-tag fallback (no sourced product list), no confirmed
  //     direct-sale signal → "tilbyr" + "finn kontaktinfo", never "bestill
  //     direkte". (Verb choice and closing clause are independent signals
  //     per spec — this is the realistic/expected combination for a
  //     fallback-tagged profile with no known sale channel.) ─────────────
  {
    const out = buildProducerAnswerFirstOpening({
      ...baseParams,
      productsList: [], // forces category-tag fallback
      productsAreSourced: false,
      hasDirectSaleSignal: false,
    });
    assertTrue(!!out && out.includes("tilbyr"), "a1: NB category-tag fallback uses 'tilbyr'");
    assertTrue(!!out && out.includes("finn kontaktinfo") && !out.includes("bestill direkte"), "a2: NB category-tag fallback closes with 'finn kontaktinfo', never 'bestill direkte'");
  }

  // ── (b) NB: sourced product list + no direct-sale signal → "produserer" +
  //     "finn kontaktinfo". ─────────────────────────────────────────────
  {
    const out = buildProducerAnswerFirstOpening({
      ...baseParams,
      productsAreSourced: true,
      hasDirectSaleSignal: false,
    });
    assertTrue(!!out && out.includes("produserer"), "b1: NB sourced products + no sale signal uses 'produserer'");
    assertTrue(!!out && out.includes("finn kontaktinfo") && !out.includes("bestill direkte"), "b2: NB sourced products + no sale signal closes with 'finn kontaktinfo', never 'bestill direkte'");
  }

  // ── (c) NB: sourced product list + confirmed direct-sale signal →
  //     "selger" + "bestill direkte". ─────────────────────────────────────
  {
    const out = buildProducerAnswerFirstOpening({
      ...baseParams,
      productsAreSourced: true,
      hasDirectSaleSignal: true,
    });
    assertTrue(!!out && out.includes("selger"), "c1: NB sourced products + sale signal uses 'selger'");
    assertTrue(!!out && out.includes("bestill direkte"), "c2: NB sourced products + sale signal closes with 'bestill direkte'");
  }

  // ── (d)/(e)/(f) same three cases, lang === "en" ────────────────────────
  {
    const outFallback = buildProducerAnswerFirstOpening({
      ...baseParams,
      productsList: [],
      lang: "en",
      productsAreSourced: false,
      hasDirectSaleSignal: false,
    });
    assertTrue(!!outFallback && outFallback.includes("offers"), "d1: EN category-tag fallback uses 'offers'");
    assertTrue(!!outFallback && outFallback.includes("find contact details") && !outFallback.includes("order directly"), "d2: EN category-tag fallback closes with 'find contact details', never 'order directly'");

    const outProduces = buildProducerAnswerFirstOpening({
      ...baseParams,
      lang: "en",
      productsAreSourced: true,
      hasDirectSaleSignal: false,
    });
    assertTrue(!!outProduces && outProduces.includes("produces"), "e1: EN sourced products + no sale signal uses 'produces'");
    assertTrue(!!outProduces && outProduces.includes("find contact details") && !outProduces.includes("order directly"), "e2: EN sourced products + no sale signal closes with 'find contact details', never 'order directly'");

    const outSells = buildProducerAnswerFirstOpening({
      ...baseParams,
      lang: "en",
      productsAreSourced: true,
      hasDirectSaleSignal: true,
    });
    assertTrue(!!outSells && outSells.includes("sells"), "f1: EN sourced products + sale signal uses 'sells'");
    assertTrue(!!outSells && outSells.includes("order directly"), "f2: EN sourced products + sale signal closes with 'order directly'");
  }

  // ── (g) Omitting productsAreSourced/hasDirectSaleSignal entirely (older
  //     caller / existing test) keeps the conservative "tilbyr ... finn
  //     kontaktinfo" wording, never the old "selger ... bestill direkte"
  //     default. ─────────────────────────────────────────────────────────
  {
    const out = buildProducerAnswerFirstOpening(baseParams);
    assertTrue(!!out && !out.includes("selger") && !out.includes("bestill direkte"), "g1: omitted signals default to conservative wording, never 'selger'/'bestill direkte'");
  }

  // ── (h) buildProducerFaqJsonLd categories-fallback caps at 3 items even
  //     when given more than 3 categories (samme kilde/cap as the opening
  //     sentence builder). ────────────────────────────────────────────────
  {
    const faq = buildProducerFaqJsonLd({
      name: "Test Gård",
      url: "https://example.com/produsent/test-gard",
      cityName: "Oslo",
      productsList: [], // forces category-tag fallback
      categories: ["meat", "vegetables", "eggs", "dairy", "honey"],
      hoursList: [],
      hoursText: "",
      website: "https://example.com",
    });
    const answer = faq?.mainEntity?.[0]?.acceptedAnswer?.text as string | undefined;
    assertTrue(!!answer, "h1: FAQ JSON-LD produced with a 'Hva selger' answer");
    const itemsPart = answer ? answer.replace(/^Test Gård tilbyr /, "").replace(/\.$/, "") : "";
    const itemCount = itemsPart ? itemsPart.split(",").length : 0;
    assertTrue(itemCount <= 3, `h2: categories-fallback answer lists at most 3 items (got ${itemCount}: "${answer}")`);
  }

  // ── (i) deriveProductsAreSourced() — the /produsent/:slug route handler's
  //     DB-derivation logic, extracted so it's testable without a DB. Round-2
  //     independent review found two successive malformed-shape bugs here
  //     that no test caught because only buildProducerAnswerFirstOpening()
  //     itself was ever tested, always with the signal hand-supplied. ──────
  {
    const products = [{ name: "syltetøy" }];
    assertTrue(
      deriveProductsAreSourced(products, undefined) === false,
      "i1: no field_provenance.products entry at all -> not sourced (round-1 defect)"
    );
    assertTrue(
      deriveProductsAreSourced(products, []) === false,
      "i2: empty provenance array -> not sourced"
    );
    // The exact legacy shape phase51_backfill_provenance_v1 (database/init.ts)
    // wrote historically: a real, non-inference source_type, but NO `value`
    // key at all (round-2 defect — "present" was wrongly treated as "sourced").
    assertTrue(
      deriveProductsAreSourced(products, [{ source_type: "website_homepage", source_url: "https://example.com", confidence: 0.7 }]) === false,
      "i3: provenance record present but with no usable value -> not sourced (round-2 defect)"
    );
    assertTrue(
      deriveProductsAreSourced(products, [{ value: "syltetøy", source_type: "category_inference" }]) === false,
      "i4: valued but inference-only source -> not sourced"
    );
    assertTrue(
      deriveProductsAreSourced(products, [{ value: "syltetøy", source_type: "website_homepage" }]) === true,
      "i5: valued, real (non-inference) source -> sourced"
    );
    assertTrue(
      deriveProductsAreSourced([], [{ value: "syltetøy", source_type: "website_homepage" }]) === false,
      "i6: no products list at all -> never sourced regardless of provenance"
    );
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const result = runRfbProducerAnswerFirstOpeningSaleSignalTests({ log: true });
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  if (result.failed > 0) process.exit(1);
}
