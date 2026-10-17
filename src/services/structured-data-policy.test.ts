/**
 * structured-data-policy.test.ts — dev-request
 * 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt, S1 + S2
 * and S4-A1a.
 *
 * Pure unit tests (no DB, no network) for src/services/structured-data-policy.ts:
 *   S1 — buildRatingJsonLd returns null for every third-party source and never
 *        invents a reviewCount; buildOfferPolicyJsonLd returns {} without an
 *        explicit per-producer policy.
 *   S2 — formatRatingDisplay names the source in no/en/sv, shows a count only
 *        when it is known (never "0 anmeldelser"), and shows nothing in mode
 *        'hidden'.
 *   S4-A1a — the default mode is 'hidden' (Daniel's decision 2=A), so the
 *        routes, which pass no mode, show no Google rating.
 * The rendered pages are covered by src/routes/rfb-jsonld-ingen-tredjepartsrating.test.ts
 * (JSON-LD, all three sites) and src/routes/rfb-rating-visning-kildeangivelse.test.ts
 * (visible text).
 *
 * Exported runStructuredDataPolicyTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/structured-data-policy.test.ts
 */
import {
  RATING_MARKUP_SOURCES_ALLOWED,
  RATING_DISPLAY_MODE,
  buildRatingJsonLd,
  buildOfferPolicyJsonLd,
  formatRatingDisplay,
  __setRatingDisplayModeForTesting,
  type RatingSource,
} from "./structured-data-policy";
import { t, type Lang } from "../i18n/t";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runStructuredDataPolicyTests(opts: { log?: boolean } = {}): TestSummary {
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

  try {
    // ── S1: rating markup ─────────────────────────────────────────────
    assertEq(RATING_MARKUP_SOURCES_ALLOWED, ["first_party"], "s1-01: only first_party ratings may be marked up");
    for (const source of ["google", "tripadvisor", "external"] as RatingSource[]) {
      assertEq(buildRatingJsonLd({ source, rating: 4.6, count: 236 }), null, `s1-02: ${source} rating with a real count -> no markup`);
    }
    assertEq(
      buildRatingJsonLd({ source: "first_party", rating: 4.6, count: 236 }),
      { "@type": "AggregateRating", ratingValue: 4.6, bestRating: 5, worstRating: 1, reviewCount: 236 },
      "s1-03: first_party rating with a real count -> AggregateRating with that count",
    );
    for (const count of [null, undefined, 0, -3, 1.5]) {
      assertEq(buildRatingJsonLd({ source: "first_party", rating: 4.6, count }), null,
        `s1-04: first_party without a real count (${String(count)}) -> null, never an invented reviewCount`);
    }
    for (const rating of [null, undefined, 0, 5.1, Number.NaN]) {
      assertEq(buildRatingJsonLd({ source: "first_party", rating, count: 10 }), null, `s1-05: invalid rating (${String(rating)}) -> null`);
    }

    // ── S1: offer return/shipping policy ──────────────────────────────
    assertEq(buildOfferPolicyJsonLd(null), {}, "s1-06: no policy (null) -> {}");
    assertEq(buildOfferPolicyJsonLd(undefined), {}, "s1-07: no policy (undefined) -> {}");
    assertEq(buildOfferPolicyJsonLd({}), {}, "s1-08: empty policy object -> {} (no default terms)");
    assertEq(
      buildOfferPolicyJsonLd({
        hasMerchantReturnPolicy: { "@type": "Wrong", applicableCountry: "NO", returnPolicyCategory: "https://schema.org/MerchantReturnNotPermitted" },
      }),
      { hasMerchantReturnPolicy: { "@type": "MerchantReturnPolicy", applicableCountry: "NO", returnPolicyCategory: "https://schema.org/MerchantReturnNotPermitted" } },
      "s1-09: an explicit return policy is emitted as given, typed MerchantReturnPolicy, and nothing else is added",
    );
    assertEq(
      Object.keys(buildOfferPolicyJsonLd({ shippingDetails: { shippingDestination: { addressCountry: "NO" } } })),
      ["shippingDetails"],
      "s1-10: an explicit shipping policy alone adds only shippingDetails",
    );

    // ── S2: visible rating text ───────────────────────────────────────
    assertEq(RATING_DISPLAY_MODE, "hidden", "s2-01: default display mode is 'hidden' (S4-A1a, Daniel's decision 2=A)");
    const g = (rating: number | null | undefined, count: number | null | undefined, lang: Lang) =>
      formatRatingDisplay({ rating, count, source: "google" }, lang, "attributed");

    assertEq(g(4.6, 236, "no"), { score: "4.6", attribution: "236 anmeldelser på Google", text: "★ 4.6 · 236 anmeldelser på Google" },
      "s2-02: no, count known -> '★ 4.6 · 236 anmeldelser på Google'");
    assertEq(g(4.6, 236, "en"), { score: "4.6", attribution: "236 reviews on Google", text: "★ 4.6 · 236 reviews on Google" },
      "s2-03: en, count known -> '★ 4.6 · 236 reviews on Google'");
    assertEq(g(4.6, 236, "sv")?.attribution, "236 recensioner på Google", "s2-04: sv, count known");
    assertEq(g(4.6, 1, "no")?.attribution, "1 anmeldelse på Google", "s2-05: no, singular");
    assertEq(g(4.6, 1, "en")?.attribution, "1 review on Google", "s2-06: en, singular");
    assertEq(g(4.6, null, "no"), { score: "4.6", attribution: "på Google", text: "★ 4.6 på Google" },
      "s2-07: no, count unknown -> source only, no number");
    assertEq(g(4.6, null, "en"), { score: "4.6", attribution: "on Google", text: "★ 4.6 on Google" },
      "s2-08: en, count unknown -> source only, no number");
    for (const lang of ["no", "en", "sv"] as Lang[]) {
      for (const count of [0, undefined, -1, 2.5]) {
        const d = g(4.6, count, lang);
        assertEq(!!d && !/\d+\s*(anmeldelse|review|recension)/.test(d.text) && d.text.includes("Google"), true,
          `s2-09: ${lang}, count ${String(count)} -> no count shown (never "0 anmeldelser"), source still named`);
      }
    }
    assertEq(g(5, 12, "no")?.score, "5.0", "s2-10: score has one decimal");
    for (const rating of [null, undefined, 0, Number.NaN, 7]) {
      assertEq(g(rating, 236, "no"), null, `s2-11: no valid rating (${String(rating)}) -> nothing shown`);
    }
    for (const source of ["first_party", "external"] as RatingSource[]) {
      assertEq(formatRatingDisplay({ rating: 4.6, count: 236, source }, "no", "attributed"), null,
        `s2-12: ${source} has no display name -> not shown unattributed`);
    }
    assertEq(formatRatingDisplay({ rating: 4.2, count: 9, source: "tripadvisor" }, "en", "attributed")?.text,
      "★ 4.2 · 9 reviews on Tripadvisor", "s2-13: other named source is attributed by name");
    for (const lang of ["no", "en", "sv"] as Lang[]) {
      assertEq(formatRatingDisplay({ rating: 4.6, count: 236, source: "google" }, lang, "hidden"), null,
        `s2-14: ${lang}, mode 'hidden' -> nothing shown (same input renders in 'attributed', s2-02..04)`);
      for (const key of ["producer.rating_on_source", "producer.rating_count_on_source", "producer.rating_count_on_source_one"]) {
        assertEq(t(lang, key, { count: 2, source: "Google" }).includes("Google"), true, `s2-15: ${lang} locale has ${key}`);
      }
    }

    // The mode the routes use (default param) follows the test override.
    for (const lang of ["no", "en", "sv"] as Lang[]) {
      for (const count of [236, 1, null]) {
        assertEq(formatRatingDisplay({ rating: 4.6, count, source: "google" }, lang), null,
          `s2-16: ${lang}, count ${String(count)}: the default mode shows no Google rating (S4-A1a)`);
      }
    }
    __setRatingDisplayModeForTesting("attributed");
    assertEq(formatRatingDisplay({ rating: 4.6, count: 236, source: "google" }, "no")?.text, "★ 4.6 · 236 anmeldelser på Google",
      "s2-17: override 'attributed' reaches the default mode");
    __setRatingDisplayModeForTesting(null);
    assertEq(formatRatingDisplay({ rating: 4.6, count: 236, source: "google" }, "no"), null, "s2-18: clearing the override restores 'hidden'");
  } catch (err) {
    failed++;
    failures.push(`structured-data-policy: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    __setRatingDisplayModeForTesting(null);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── structured-data-policy (dev-request 2026-10-16 S1+S2, S4-A1a) unit tests ──");
  const r = runStructuredDataPolicyTests({ log: true });
  console.log(`\nstructured-data-policy: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
}
