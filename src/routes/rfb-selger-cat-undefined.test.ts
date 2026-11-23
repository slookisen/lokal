/**
 * rfb-selger-cat-undefined.test.ts: dev-request 2026-11-22-rfb-selger-cat-undefined-for-varer-uten-kategori.
 * The owner's product list must not show «cat_undefined» (or any raw cat_<x> key).
 * Static checks on selger.html plus a run of the inline productCategoryLabel().
 *
 * Exported runRfbSelgerCatUndefinedTests() -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-selger-cat-undefined.test.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runRfbSelgerCatUndefinedTests(): TestSummary {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) passed++;
    else { failed++; failures.push(label); }
  };

  const html = readFileSync(join(__dirname, "..", "public", "selger.html"), "utf8");
  ok(!html.includes("t('cat_' + p.category) || p.category"), "old t('cat_' + p.category) pattern is gone");
  ok(html.includes("cat_none: 'Uten kategori'"), "Norwegian dictionary has cat_none");
  ok(html.includes("cat_none: 'No category'"), "English dictionary has cat_none");

  const m = html.match(/function productCategoryLabel\(c\) \{[\s\S]*?\n    \}\n/);
  ok(!!m, "productCategoryLabel is defined");
  if (m) {
    const i18n: any = {
      no: { cat_dairy: "Meieri", cat_none: "Uten kategori" },
      en: { cat_dairy: "Dairy", cat_none: "No category" },
    };
    const state = { lang: "no" };
    const fn = new Function("i18n", "state", m[0] + "\nreturn productCategoryLabel;")(i18n, state);
    ok(fn(undefined) === "Uten kategori", "undefined category -> Uten kategori");
    ok(fn(null) === "Uten kategori", "null category -> Uten kategori");
    ok(fn("") === "Uten kategori", "empty category -> Uten kategori");
    ok(fn("  ") === "Uten kategori", "blank category -> Uten kategori");
    ok(fn("dairy") === "Meieri", "known category unchanged");
    ok(fn("mystery") === "mystery", "unknown category shows the raw value, not cat_mystery");
    state.lang = "en";
    ok(fn(undefined) === "No category", "English fallback");
    ok(fn("dairy") === "Dairy", "English known category unchanged");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runRfbSelgerCatUndefinedTests();
  console.log(`rfb-selger-cat-undefined: ${r.passed} passed, ${r.failed} failed`);
  for (const f of r.failures) console.log("  FAIL " + f);
  process.exit(r.failed ? 1 : 0);
}
