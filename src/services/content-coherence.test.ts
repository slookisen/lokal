/**
 * content-coherence.test.ts — unit tests for the PURE content-coherence gate
 * (services/content-coherence.ts, PR-B).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/content-coherence.test.ts
 *   2. Wired into the main gate: tests/test.ts imports runContentCoherenceTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 *
 * Table-driven over the FOUR real customer complaints (each a DISTINCTIVE
 * specialist mismatch → conflict), a benign-overlap case (→ coherent), and an
 * empty-homepage case (→ no_homepage_signal). Plus guards proving benign
 * overlaps, plant sidelines, and ambiguous/benign-only homepages NEVER conflict
 * (so this axis cannot widen the existing domain_coherence false-positives).
 */

import {
  contentCoherenceCheck,
  extractBusinessTypeTokensForCoherence,
  extractProductCategoriesForCoherence,
  type ContentCoherenceVerdict,
  type StoredContent,
  type HomepageContentSignals,
} from "./content-coherence";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runContentCoherenceTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };

  // ── Table: the 4 real complaints (conflict) + benign (coherent) + empty ─────
  type Row = {
    name: string;
    stored: StoredContent;
    homepage: HomepageContentSignals | null;
    expect: ContentCoherenceVerdict;
    /** A substring that MUST appear in one of the conflicts (conflict rows only). */
    conflictContains?: string;
  };

  const rows: Row[] = [
    // 1. Grette — stored MEAT, homepage distinctively andelslandbruk (vegetables).
    {
      name: "Grette: stored meat vs homepage andelslandbruk(vegetables)",
      stored: { categories: ["meat"], products: ["Kjøtt"], about: "Vi selger kjøtt fra egen gård." },
      homepage: {
        businessTypeTokens: ["andelslandbruk", "gard"],
        productMentions: ["vegetables"],
        aboutSummary: "Andelslandbruk på Romerike der vi dyrker grønnsaker.",
      },
      expect: "conflict",
      conflictContains: "meat",
    },
    // 2. Ingunnshage — stored hagekonsulent, homepage distinctively besøkshage.
    {
      name: "Ingunnshage: stored hagekonsulent vs homepage besøkshage",
      stored: { description: "Hagekonsulent", categories: ["hagekonsulent"], about: "Vi tilbyr hagekonsulent-tjenester." },
      homepage: {
        businessTypeTokens: ["besokshage"],
        productMentions: [],
        aboutSummary: "En besøkshage du kan besøke om sommeren.",
      },
      expect: "conflict",
      conflictContains: "besokshage",
    },
    // 3. Fløy — stored bread/lefser ABSENT-AND-contradicted by a distinctively
    //    different specialist homepage (a ysteri/dairy).
    {
      name: "Fløy: stored bread(lefser) vs homepage distinctively ysteri(dairy)",
      stored: { products: ["Lefser", "Flatbrød"], categories: ["bread"], about: "Vi lager lefser og flatbrød." },
      homepage: {
        businessTypeTokens: ["ysteri"],
        productMentions: ["dairy"],
        aboutSummary: "Vårt ysteri lager ost av lokal melk.",
      },
      expect: "conflict",
      conflictContains: "bread",
    },
    // 4. Bomstad — stored fish/shrimp, homepage is distinctively a goat (geit) page.
    {
      name: "Bomstad: stored fish(reker) vs homepage geit(meat)",
      stored: { products: ["Reker", "Fisk"], categories: ["fish"], about: "Vi selger reker og fersk fisk." },
      homepage: {
        businessTypeTokens: [],
        productMentions: ["meat"],
        aboutSummary: "Vi har geit og selger geitekjøtt fra egen gård.",
      },
      expect: "conflict",
      conflictContains: "fish",
    },
    // 5. Benign overlap — stored vegetables + farm, homepage vegetables + gård.
    {
      name: "Benign overlap: stored vegetables vs homepage vegetables+gård",
      stored: { categories: ["vegetables"], products: ["Poteter", "Gulrøtter"], about: "Gård med grønnsaker." },
      homepage: {
        businessTypeTokens: ["gard", "andelslandbruk"],
        productMentions: ["vegetables"],
        aboutSummary: "Andelslandbruk med grønnsaker fra egen jord.",
      },
      expect: "coherent",
    },
    // 6. Empty homepage (null) — advisory only.
    {
      name: "Empty homepage (null) → no_homepage_signal",
      stored: { categories: ["meat"], about: "Vi selger kjøtt." },
      homepage: null,
      expect: "no_homepage_signal",
    },
    // 6b. Empty homepage (all-empty fields) — advisory only.
    {
      name: "Empty homepage (empty fields) → no_homepage_signal",
      stored: { categories: ["meat"], about: "Vi selger kjøtt." },
      homepage: { businessTypeTokens: [], productMentions: [], aboutSummary: "" },
      expect: "no_homepage_signal",
    },
  ];

  for (const row of rows) {
    const r = contentCoherenceCheck(row.stored, row.homepage);
    ok(r.verdict === row.expect, `${row.name} → ${row.expect} (got ${r.verdict})`);
    if (row.expect === "conflict") {
      ok(r.conflicts.length > 0, `${row.name}: has ≥1 conflict descriptor`);
      if (row.conflictContains) {
        ok(
          r.conflicts.some((c) => c.includes(row.conflictContains!)),
          `${row.name}: conflict mentions "${row.conflictContains}" (got ${JSON.stringify(r.conflicts)})`,
        );
      }
    }
    if (row.expect === "no_homepage_signal") {
      ok(r.conflicts.length === 0, `${row.name}: no_homepage_signal has no conflicts`);
    }
  }

  // ── Guards: benign / ambiguous / sideline must NEVER conflict ───────────────
  {
    // Plant sideline: stored fruit, homepage andelslandbruk(vegetables) — both
    // in the "plant" bucket, so NOT a conflict.
    const r = contentCoherenceCheck(
      { categories: ["fruit"], products: ["Epler"] },
      { businessTypeTokens: ["andelslandbruk"], productMentions: ["vegetables"], aboutSummary: "" },
    );
    ok(r.verdict === "coherent", "plant sideline (fruit vs veg) → coherent (same bucket)");
  }
  {
    // Eggs/honey common sidelines never drive a conflict against a veg homepage.
    const r = contentCoherenceCheck(
      { categories: ["eggs"], products: ["Egg", "Honning"] },
      { businessTypeTokens: ["andelslandbruk"], productMentions: ["vegetables"], aboutSummary: "" },
    );
    ok(r.verdict === "coherent", "eggs/honey sideline vs veg homepage → coherent");
  }
  {
    // Ambiguous: stored meat, homepage carries ONLY benign gård tokens (no
    // distinctive signal) → coherent (never downgrade what we can't judge).
    const r = contentCoherenceCheck(
      { categories: ["meat"], about: "Velkommen til oss." },
      { businessTypeTokens: ["gard", "mat"], productMentions: [], aboutSummary: "Velkommen til gården vår." },
    );
    ok(r.verdict === "coherent", "benign-only homepage (no distinctive) → coherent (conservative)");
  }
  {
    // Corroborated dairy ysteri on both sides → coherent + corroborated.
    const r = contentCoherenceCheck(
      { categories: ["dairy"], products: ["Ost"], about: "Vårt ysteri." },
      { businessTypeTokens: ["ysteri"], productMentions: ["dairy"], aboutSummary: "Ysteri som lager ost." },
    );
    ok(r.verdict === "coherent", "matching ysteri/dairy → coherent");
    ok(r.corroborated.includes("dairy"), "matching ysteri/dairy → dairy corroborated");
  }
  {
    // Stored EMPTY, homepage distinctive → coherent (nothing stored to contradict).
    const r = contentCoherenceCheck(
      {},
      { businessTypeTokens: ["andelslandbruk"], productMentions: ["vegetables"], aboutSummary: "Andelslandbruk." },
    );
    ok(r.verdict === "coherent", "empty stored vs distinctive homepage → coherent (nothing to contradict)");
  }
  {
    // Determinism: same input twice → identical output.
    const a = contentCoherenceCheck(rows[0]!.stored, rows[0]!.homepage);
    const b = contentCoherenceCheck(rows[0]!.stored, rows[0]!.homepage);
    ok(JSON.stringify(a) === JSON.stringify(b), "deterministic: same input → identical output");
  }

  // ── Reconstruction helpers (used by the verifier) ───────────────────────────
  {
    ok(
      extractBusinessTypeTokensForCoherence("Vårt andelslandbruk på gården").includes("andelslandbruk"),
      "reconstruct: business-type token andelslandbruk found",
    );
    ok(
      extractProductCategoriesForCoherence("vi dyrker grønnsaker").includes("vegetables"),
      "reconstruct: 'grønnsaker' → vegetables",
    );
    ok(
      extractProductCategoriesForCoherence("vegetables").includes("vegetables"),
      "reconstruct: raw category key 'vegetables' → vegetables",
    );
    ok(extractProductCategoriesForCoherence("").length === 0, "reconstruct: empty text → []");
    ok(extractBusinessTypeTokensForCoherence("").length === 0, "reconstruct: empty text → [] (tokens)");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/content-coherence.test.ts`
if (require.main === module) {
  console.log("── content-coherence unit tests ──");
  const r = runContentCoherenceTests({ log: true });
  console.log(`\ncontent-coherence: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
