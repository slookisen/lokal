/**
 * drink-taxonomy.test.ts — unit tests for services/drink-taxonomy.ts.
 *
 * dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 5a:
 * the shared six-value drink subcategory taxonomy (bryggeri/cideri/vingård/
 * destilleri/gårdskafé/mjød) both platforms' parser/MCP/API layers point at.
 *
 * Pure module, no DB, no network — every assertion here is a plain function
 * call. Integration coverage (parseNaturalQuery, discover(), corridorSearch,
 * the MCP tool schemas, the REST filters, the admin coverage reports) lives
 * in route-corridor.test.ts and the dedicated *-drink-subcategory*.test.ts /
 * *-drink-coverage.test.ts files — see those for "wired end to end against
 * real data".
 *
 * Exported runDrinkTaxonomyTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/drink-taxonomy.test.ts
 */

import {
  DRINK_SUBCATEGORIES,
  DRINK_SUBCATEGORY_META,
  GENERIC_DRINK_TERMS,
  isDrinkSubcategory,
  classifyDrinkSubcategoryFromText,
  classifyDrinkSubcategoryFromProducerType,
  isGenericDrinkText,
  allDrinkProducerTypes,
} from "./drink-taxonomy";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDrinkTaxonomyTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function ok(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function eq(actual: unknown, expected: unknown, label: string): void {
    ok(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  // ── t1: the exact six-value taxonomy, Daniel's own spelling ────────────
  eq(
    [...DRINK_SUBCATEGORIES],
    ["bryggeri", "cideri", "vingård", "destilleri", "gårdskafé", "mjød"],
    "t1: DRINK_SUBCATEGORIES is exactly Daniel's six values, in his order",
  );
  ok(DRINK_SUBCATEGORIES.length === 6, "t1b: exactly six, no more, no fewer");

  // ── t2: isDrinkSubcategory ──────────────────────────────────────────────
  for (const sub of DRINK_SUBCATEGORIES) {
    ok(isDrinkSubcategory(sub), `t2: isDrinkSubcategory("${sub}") -> true`);
  }
  ok(!isDrinkSubcategory("bakeri"), "t2b: a non-member string -> false");
  ok(!isDrinkSubcategory(undefined), "t2c: undefined -> false, no throw");
  ok(!isDrinkSubcategory(123 as any), "t2d: a non-string -> false, no throw");

  // ── t3: classifyDrinkSubcategoryFromText, bare keywords ─────────────────
  const bareCases: Array<[string, string]> = [
    ["bryggeri", "bryggeri"], ["mikrobryggeri", "bryggeri"], ["øl", "bryggeri"],
    ["cideri", "cideri"], ["sider", "cideri"], ["eplesider", "cideri"],
    ["vingård", "vingård"], ["vingard", "vingård"], ["musserende", "vingård"],
    ["destilleri", "destilleri"], ["brenneri", "destilleri"], ["akevitt", "destilleri"],
    ["gårdskafé", "gårdskafé"], ["gardskafe", "gårdskafé"],
    ["mjød", "mjød"], ["mjøderi", "mjød"], ["mjod", "mjød"],
  ];
  for (const [text, expected] of bareCases) {
    eq(classifyDrinkSubcategoryFromText(text), expected, `t3: classifyDrinkSubcategoryFromText("${text}")`);
  }

  // ── t4: inside a real sentence, Norwegian and English ───────────────────
  eq(classifyDrinkSubcategoryFromText("finnes det et bryggeri i Agder"), "bryggeri",
    "t4a: «finnes det et bryggeri i Agder» -> bryggeri (the dev-request's own example query)");
  eq(classifyDrinkSubcategoryFromText("looking for a winery near Larvik"), null,
    "t4b: English 'winery' has no Norwegian keyword match — documents the known gap (see marketplace-registry.ts's own English-term expansion note), not asserting a false capability");
  eq(classifyDrinkSubcategoryFromText("cideri i Hardanger"), "cideri", "t4c: «cideri i Hardanger»");

  // ── t5: generic drink terms are recognised as drink but NOT a subcategory ──
  eq(classifyDrinkSubcategoryFromText("drikkesteder"), null,
    "t5a: «drikkesteder» alone is not any ONE of the six — must not guess");
  ok(isGenericDrinkText("drikkesteder"), "t5b: …but isGenericDrinkText sees it as drink-related");
  eq(classifyDrinkSubcategoryFromText("beverages"), null, "t5c: «beverages» likewise not a specific subcategory");
  ok(isGenericDrinkText("beverages"), "t5d: …but is generic-drink");
  for (const term of GENERIC_DRINK_TERMS) {
    ok(isGenericDrinkText(term), `t5e: generic term "${term}" is recognised as drink-related`);
  }

  // ── t6: non-drink text ───────────────────────────────────────────────────
  eq(classifyDrinkSubcategoryFromText("honning fra Vadsø"), null, "t6a: non-drink query -> null");
  ok(!isGenericDrinkText("honning fra Vadsø"), "t6b: …and not generic-drink either");
  eq(classifyDrinkSubcategoryFromText(""), null, "t6c: empty string -> null, no throw");
  eq(classifyDrinkSubcategoryFromText(null), null, "t6d: null -> null, no throw");
  eq(classifyDrinkSubcategoryFromText(undefined), null, "t6e: undefined -> null, no throw");

  // ── t7: word-boundary safety — the short/ambiguous tokens ───────────────
  // "vin" (wine) is a real keyword, but is also a substring of unrelated
  // Norwegian words. A bare `includes()` would false-positive here; this
  // module mirrors marketplace-registry.ts's Norwegian-aware \b fix.
  eq(classifyDrinkSubcategoryFromText("en gjeng med kvinner"), null,
    "t7a: «kvinner» contains the substring «vin» but must NOT match vingård");
  eq(classifyDrinkSubcategoryFromText("vin fra Hardanger"), "vingård",
    "t7b: …while the standalone word «vin» still matches");
  eq(classifyDrinkSubcategoryFromText("Bryggerøl Gård"), null,
    "t7c: a producer NAME ending in -øl is not a drink query, matching marketplace-registry.ts's own d3 case");
  eq(classifyDrinkSubcategoryFromText("øl fra Bryggerøl Gård"), "bryggeri",
    "t7d: …but the standalone word «øl» in the same sentence does match");
  // gårdskafé: only the compound forms, never bare "kafé" (false-positive trap).
  eq(classifyDrinkSubcategoryFromText("koselig kafé i sentrum"), null,
    "t7e: a bare «kafé» (any café) must NOT match gårdskafé — same guard salgskanal-matcher.ts uses");

  // ── t8: classifyDrinkSubcategoryFromProducerType — DB alias spellings ──
  const producerTypeCases: Array<[string | null | undefined, string | null]> = [
    ["bryggeri", "bryggeri"],
    ["cideri", "cideri"], ["sideri", "cideri"],
    ["vingård", "vingård"], ["vingard", "vingård"],
    ["destilleri", "destilleri"],
    ["gårdskafé", "gårdskafé"], ["gardskafe", "gårdskafé"],
    ["mjøderi", "mjød"], ["mjoderi", "mjød"],
    ["Bryggeri", "bryggeri"], // case-insensitive
    [" bryggeri ", "bryggeri"], // trimmed
    ["seltzeri", null], // a real gårdssalg drink type, but not one of the six
    ["gardsbutikk", null], // known non-drink type
    [null, null], [undefined, null], ["", null],
  ];
  for (const [input, expected] of producerTypeCases) {
    eq(classifyDrinkSubcategoryFromProducerType(input), expected,
      `t8: classifyDrinkSubcategoryFromProducerType(${JSON.stringify(input)})`);
  }

  // ── t9: DRINK_SUBCATEGORY_META completeness — every subcategory has both ──
  for (const sub of DRINK_SUBCATEGORIES) {
    const meta = DRINK_SUBCATEGORY_META[sub];
    ok(!!meta, `t9a: DRINK_SUBCATEGORY_META has an entry for "${sub}"`);
    ok(!!meta.labelNo && !!meta.labelEn, `t9b: "${sub}" has both NO and EN labels`);
    ok(meta.keywords.length > 0, `t9c: "${sub}" has at least one keyword`);
    ok(meta.producerTypes.length > 0, `t9d: "${sub}" has at least one producer_type spelling`);
    // Every subcategory must classify to ITSELF via its own primary keyword —
    // catches a copy-paste mismatch between the map key and its own data.
    eq(classifyDrinkSubcategoryFromText(sub), sub, `t9e: "${sub}" classifies to itself as text`);
  }

  // ── t10: allDrinkProducerTypes() — flattened, used by admin coverage reports ──
  const flat = allDrinkProducerTypes();
  ok(flat.includes("mjøderi") && flat.includes("mjoderi"), "t10a: flattened list carries both mead spellings");
  ok(flat.includes("vingård") && flat.includes("vingard"), "t10b: …and both winery spellings");
  eq(flat.length, DRINK_SUBCATEGORIES.reduce((n, s) => n + DRINK_SUBCATEGORY_META[s].producerTypes.length, 0),
    "t10c: length matches the sum of every subcategory's own list (no dedup surprise)");

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  const s = runDrinkTaxonomyTests({ log: true });
  console.log(`\n${s.passed} passed, ${s.failed} failed`);
  for (const f of s.failures) console.log("  " + f);
  process.exit(s.failed > 0 ? 1 : 0);
}
