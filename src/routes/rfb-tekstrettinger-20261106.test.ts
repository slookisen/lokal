/**
 * rfb-tekstrettinger-20261106.test.ts: the public texts Daniel decided on
 * 2026-11-06 (A2A daniel-responses/2026-11-06-live-beslutninger-etter-eksamen.md).
 * /om: no «non-profit», no «Oslo først», the approved sentence is there.
 * /selger metadata and the shared footer: no promise of being found.
 *
 * Exported runRfbTekstrettinger20261106Tests() -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-tekstrettinger-20261106.test.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runRfbTekstrettinger20261106Tests(): TestSummary {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) passed++;
    else { failed++; failures.push(label); }
  };
  const read = (...parts: string[]) => readFileSync(join(__dirname, "..", ...parts), "utf8");

  const seo = read("routes", "seo.ts");
  ok(!/is a non-profit|er et non-profit/.test(seo), "/om: «non-profit» is gone");
  ok(!/translate="no">Oslo<\/span> (first|f\\u00f8rst)/.test(seo), "/om: «Oslo først» is gone");
  ok(seo.includes("Gratis \\u00e5 v\\u00e6re med i dag. Drevet av AGENTPLATFORM.NO AS."), "/om: the approved Norwegian sentence");
  ok(seo.includes("Free to join today. Run by AGENTPLATFORM.NO AS."), "/om: the English counterpart");
  ok(seo.includes("ingen betalte plasseringer"), "/om: «ingen betalte plasseringer» stays (principle locked 2026-11-06)");

  const selger = read("public", "selger.html");
  ok(!selger.includes("finner dere automatisk"), "/selger: no «finner dere automatisk» in any description");
  ok((selger.match(/Gratis selgerprofil for norske matprodusenter, gårder og REKO-ringer\."/g) || []).length === 3, "/selger: the three descriptions end after the first two sentences");

  for (const file of ["app.html", "dashboard.html"]) {
    const page = read("public", file);
    ok(!page.includes("finner deg automatisk"), `${file}: no «finner deg automatisk»`);
    ok(!page.includes("agenten din svarer for deg"), `${file}: the platform does not answer in the producer's name`);
    ok(page.includes("om lokal mat kan finne deg."), `${file}: the softened sentence`);
  }
  const sv = read("i18n", "locales", "sv.json");
  ok(!/kunderna hittar dig/.test(sv) && (sv.match(/kunderna kan hitta dig/g) || []).length === 2, "footer sv: «kan hitta»");

  const no = read("i18n", "locales", "no.json");
  const en = read("i18n", "locales", "en.json");
  ok(!/kundene finner deg/.test(no) && (no.match(/kundene kan finne deg/g) || []).length === 2, "footer no: «kan finne»");
  ok(!/customers find you/.test(en) && (en.match(/customers can find you/g) || []).length === 2, "footer en: «can find»");

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runRfbTekstrettinger20261106Tests();
  console.log(`rfb-tekstrettinger-20261106: ${r.passed} passed, ${r.failed} failed`);
  for (const f of r.failures) console.log("  FAIL " + f);
  process.exit(r.failed ? 1 : 0);
}
