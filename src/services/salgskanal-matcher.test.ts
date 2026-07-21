/**
 * salgskanal-matcher.test.ts — unit tests for matchSalgskanalCategories()
 * (dev-request 2026-07-06-rfb-salgskanal-kategorier, datamodel + auto-matcher
 * slice). Pure-function tests — no DB, no network — mirrors the
 * brreg-client.test.ts pattern in this directory.
 *
 * Fixtures are drawn from the dev-request's own known-true spot-probes
 * (Vedlegg + acceptance criteria) plus its two named false-positive traps.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/salgskanal-matcher.test.ts
 *   2. Wired into the gate: tests/test.ts imports runSalgskanalMatcherTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import { matchSalgskanalCategories, SalgskanalCategoryMatch, SalgskanalCategorySlug } from "./salgskanal-matcher";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runSalgskanalMatcherTests(opts: { log?: boolean } = {}): TestSummary {
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

  function find(verdicts: SalgskanalCategoryMatch[], category: SalgskanalCategorySlug): SalgskanalCategoryMatch {
    const v = verdicts.find((x) => x.category === category);
    if (!v) throw new Error(`matchSalgskanalCategories did not return a verdict for ${category}`);
    return v;
  }

  // ── Shape: always returns all 5 categories ─────────────────────────────
  {
    const verdicts = matchSalgskanalCategories({ name: "Tomt Gårdsbruk", description: "Vi selger poteter." });
    assertEq(verdicts.length, 5, "shape: matchSalgskanalCategories returns exactly 5 category verdicts");
    const slugs = verdicts.map((v) => v.category).sort();
    assertEq(
      slugs,
      ["gardsbutikk", "gardskafe-servering", "hjemlevering", "reko-ring", "selvplukk"].sort(),
      "shape: all 5 canonical category slugs present",
    );
    for (const v of verdicts) {
      assertEq(v.matched, false, `shape: "${v.category}" not matched on unrelated text`);
      assertEq(v.matched_keywords, [], `shape: "${v.category}" matched_keywords empty when unmatched`);
      assertEq(v.evidence_snippet, null, `shape: "${v.category}" evidence_snippet null when unmatched`);
    }
  }

  // ── Selvplukk — dev-request spot-probes ────────────────────────────────
  {
    const hilde = matchSalgskanalCategories({
      name: "Selvplukk hos Hilde",
      description: "Kom og plukk dine egne bær! Selvplukk av jordbær og bringebær hele sommeren.",
    });
    const v = find(hilde, "selvplukk");
    assertTrue(v.matched, "selvplukk: 'Selvplukk hos Hilde' matches on name + description");
    assertTrue(v.matched_keywords.includes("selvplukk"), "selvplukk: matched_keywords includes 'selvplukk'");
    assertTrue(!!v.evidence_snippet, "selvplukk: evidence_snippet populated");

    const bringebaerlandet = matchSalgskanalCategories({
      name: "Bringebærlandet",
      description: "Selvplukk av bringebær rett fra bushen — åpent i sesong.",
    });
    assertTrue(find(bringebaerlandet, "selvplukk").matched, "selvplukk: 'Bringebærlandet' matches");

    const hoppestadMais = matchSalgskanalCategories({
      name: "Hoppestad Mais — Skien",
      description: "Hos oss kan du plukke selv i maisåkeren fra august.",
    });
    assertTrue(find(hoppestadMais, "selvplukk").matched, "selvplukk: 'Hoppestad Mais — Skien' matches on 'plukk selv'");

    // Tag-only membership (no keyword hit in free text) still counts,
    // since tags are folded into the scanned haystack.
    const tagOnly = matchSalgskanalCategories({
      name: "Anonym Gård",
      description: "Vi driver med frukt og bær.",
      tags: ["selvplukk"],
    });
    assertTrue(find(tagOnly, "selvplukk").matched, "selvplukk: tag-only 'selvplukk' membership matches");
  }

  // ── Hjemlevering — dev-request spot-probe + false-positive trap ───────
  {
    const godtLokalt = matchSalgskanalCategories({
      name: "Godt Lokalt Bergen",
      description: "Vi tilbyr hjemlevering av lokalmat i hele Bergen-området.",
    });
    const v = find(godtLokalt, "hjemlevering");
    assertTrue(v.matched, "hjemlevering: 'Godt Lokalt Bergen' matches");
    assertTrue(v.matched_keywords.some((k) => k.includes("hjemlever")), "hjemlevering: matched_keywords cites 'hjemlever*'");

    // Named false-positive trap: "levering til butikk" must NOT match.
    const shopDelivery = matchSalgskanalCategories({
      name: "Vanlig Gårdsbruk",
      description: "Vi tar levering til butikk hver mandag og torsdag.",
    });
    assertTrue(!find(shopDelivery, "hjemlevering").matched, "hjemlevering: 'levering til butikk' does NOT match (false-positive trap)");
  }

  // ── Gårdsbutikk — dev-request spot-probe ───────────────────────────────
  {
    const leksas = matchSalgskanalCategories({
      name: "Leksås Gårdsmat — Grong",
      description: "Velkommen til vår gårdsbutikk med lokalprodusert kjøtt og ost.",
    });
    assertTrue(find(leksas, "gardsbutikk").matched, "gardsbutikk: 'Leksås Gårdsmat — Grong' matches");

    const tagOnly = matchSalgskanalCategories({
      name: "Anonym Gård",
      description: "Vi selger egg.",
      tags: ["farm-shop"],
    });
    assertTrue(find(tagOnly, "gardsbutikk").matched, "gardsbutikk: 'farm-shop' tag matches");
  }

  // ── Gårdskafé/servering — precision-gated (strong OR >=2 weak signals) ─
  {
    // Strong keyword alone is sufficient.
    const strong = matchSalgskanalCategories({
      name: "Solbakken Gård",
      description: "Hos oss finner du en koselig gårdskafé åpen hele sommeren.",
    });
    assertTrue(find(strong, "gardskafe-servering").matched, "gardskafe: strong keyword 'gårdskafé' alone matches");

    // Two distinct weak signals (café mention + serving mention) also qualify.
    const twoWeak = matchSalgskanalCategories({
      name: "Nordre Gård",
      description: "Vi har en liten kafé med servering av vafler og nytraktet kaffe hver helg.",
    });
    assertTrue(find(twoWeak, "gardskafe-servering").matched, "gardskafe: 'kafé' + 'servering' (2 weak signals) matches");

    // Named false-positive trap: a lone mention of a NEARBY café (one weak
    // signal only, no serving corroboration) must NOT match.
    const nearbyCafe = matchSalgskanalCategories({
      name: "Fjelltun Gård",
      description: "Det er en hyggelig kafé i nærheten hvis du trenger en pause etter gårdsbesøket.",
    });
    assertTrue(
      !find(nearbyCafe, "gardskafe-servering").matched,
      "gardskafe: 'kafé i nærheten' (nearby café, 1 weak signal) does NOT match (false-positive trap)",
    );

    // Follow-up proximity guard: two UNRELATED weak signals far apart in the
    // text must NOT combine into a match (a café mention in one sentence, a
    // serving mention about something else ~200 chars later).
    const farApartWeak = matchSalgskanalCategories({
      name: "Vidsyn Gård",
      description:
        "Det ligger en koselig kafé nede i bygda som mange stopper ved. " +
        "Vi driver med sau og storfe her på gården, og har holdt på i tre generasjoner med " +
        "tradisjonelt husdyrhold og stell av kulturlandskapet rundt tunet. " +
        "Vi tilbyr servering til større selskaper på nabogården etter avtale.",
    });
    assertTrue(
      !find(farApartWeak, "gardskafe-servering").matched,
      "gardskafe: café + servering far apart (unrelated) do NOT combine (proximity guard)",
    );

    // Adjacent café + servering still matches (proximity guard does not
    // over-suppress the true weak-signal case).
    const adjacentWeak = matchSalgskanalCategories({
      name: "Nære Gård",
      description: "Enkel kafé med servering i låven på lørdager.",
    });
    assertTrue(
      find(adjacentWeak, "gardskafe-servering").matched,
      "gardskafe: adjacent 'kafé med servering' still matches after proximity guard",
    );
  }

  // ── REKO-ring — dev-request spot-probe ─────────────────────────────────
  {
    const urkorn = matchSalgskanalCategories({
      name: "Norsk Urkorn (Trøgstad)",
      description: "Vi selger kornprodukter via REKO-ringen Moss.",
    });
    const v = find(urkorn, "reko-ring");
    assertTrue(v.matched, "reko-ring: 'Norsk Urkorn (Trøgstad)' selling via 'REKO-ringen Moss' matches");

    const tagOnly = matchSalgskanalCategories({
      name: "Anonym Gård",
      description: "Vi selger melk.",
      tags: ["reko-ring"],
    });
    assertTrue(find(tagOnly, "reko-ring").matched, "reko-ring: tag-only 'reko-ring' membership matches");

    // Absent-beats-wrong: bare "REKO" without "ring" should not fire, since
    // it risks colliding with unrelated acronyms.
    const bareReko = matchSalgskanalCategories({
      name: "Et Firma",
      description: "Vårt REKO-nummer er 12345 hos regnskapsføreren.",
    });
    assertTrue(!find(bareReko, "reko-ring").matched, "reko-ring: bare 'REKO' (no 'ring') does not match");

    // Follow-up negation/ownership guard: an explicit NON-membership statement
    // must not be mis-tagged.
    const negatedReko = matchSalgskanalCategories({
      name: "Sjølberg Gård",
      description: "Vi selger ikke via reko-ringen — bare fra egen gårdsbutikk.",
    });
    assertTrue(
      !find(negatedReko, "reko-ring").matched,
      "reko-ring: 'selger ikke via reko-ringen' does NOT match (negation guard)",
    );

    // ...but a positive ownership statement in the same shape still matches
    // (guard does not over-suppress).
    const positiveReko = matchSalgskanalCategories({
      name: "Medlem Gård",
      description: "Vi er medlem av reko-ringen og leverer der hver uke.",
    });
    assertTrue(
      find(positiveReko, "reko-ring").matched,
      "reko-ring: positive 'medlem av reko-ringen' still matches after negation guard",
    );
  }

  // ── Multi-category producer — a profile can match more than one ───────
  {
    const multi = matchSalgskanalCategories({
      name: "Stor Gård",
      description: "Vi har gårdsbutikk, selvplukk av jordbær, og gårdskafé med servering. " +
        "Du kan også få hjemlevering, og vi selger via REKO-ringen.",
    });
    for (const category of ["gardsbutikk", "selvplukk", "gardskafe-servering", "hjemlevering", "reko-ring"] as const) {
      assertTrue(find(multi, category).matched, `multi-category: "${category}" matches on a profile mentioning all 5`);
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/salgskanal-matcher.test.ts`
if (require.main === module) {
  console.log("── salgskanal-matcher unit tests ──");
  const r = runSalgskanalMatcherTests({ log: true });
  console.log(`\nsalgskanal-matcher: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
