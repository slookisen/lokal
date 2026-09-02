/**
 * dental-catalog-class.test.ts — unit tests for classifyDentalCatalogEntry()
 * (src/services/dental-catalog-class.ts), dev-request
 * 2026-09-02-dental-catalog-class-triage.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/dental-catalog-class.test.ts
 *   2. Wired into the gate: tests/test.ts imports runDentalCatalogClassTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import {
  classifyDentalCatalogEntry,
  isPublicDentalServiceHost,
  DENTAL_CLINIC_CLASS_SQL,
  DENTAL_CLINIC_CLASSES,
  DENTAL_CATALOG_CLASSES,
  type CatalogClassInput,
  type DentalCatalogClass,
} from "./dental-catalog-class";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDentalCatalogClassTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function expectClass(input: CatalogClassInput, expected: DentalCatalogClass, label: string): void {
    const got = classifyDentalCatalogEntry(input);
    if (got.catalog_class === expected) {
      passed++;
      if (log) console.log(`  ✓ ${label} → ${expected} (${got.rule})`);
    } else {
      failed++;
      const msg = `${label}: expected ${expected}, got ${got.catalog_class} (rule ${got.rule})`;
      failures.push(msg);
      if (log) console.log(`  ✗ ${msg}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(label); if (log) console.log(`  ✗ ${label}`); }
  }

  // ── Real clinics (from the live catalog) ──────────────────────────────
  expectClass({ navn: "7 FJELL KJEVEORTOPEDI AS", naeringskode: "86.230", organisasjonsform: "AS" }, "klinikk", "kjeveortopedi AS");
  expectClass({ navn: "A. VARRENG TANNKLINIKK AS", naeringskode: "86.230", organisasjonsform: "AS" }, "klinikk", "tannklinikk AS");
  expectClass({ navn: "A. MAHMOOD TANNLEGE", naeringskode: "86.230", organisasjonsform: "ENK" }, "klinikk", "ENK with tannlege word");
  expectClass({ navn: "KAMBO TANNKLINIKK, TANNLEGE EMILIA RUDNICKA", naeringskode: "86.230", organisasjonsform: "ENK" }, "klinikk", "ENK clinic name");
  expectClass({ navn: "ALBUS DENT AS", naeringskode: "86.230", organisasjonsform: "AS" }, "klinikk", "'dent ' suffix word");
  expectClass({ navn: "INVESTDENT AS", naeringskode: "86.230", organisasjonsform: "AS" }, "klinikk", "invest inside a dental brand is not holding");
  expectClass({ navn: "A C HVOSLEF AS", naeringskode: "86.230", organisasjonsform: "AS" }, "klinikk", "AS with dental NACE, non-descriptive name");
  expectClass({ navn: "DENTALPARTNER DA", naeringskode: "86.230", organisasjonsform: "DA" }, "klinikk", "DA with dental word");
  expectClass({ navn: "BLID ENSJØ", naeringskode: "86.230", organisasjonsform: "AS" }, "klinikk", "chain branch under company NACE");

  // ── Public clinics ────────────────────────────────────────────────────
  expectClass({ navn: "Ahus Tannklinikk", naeringskode: "", organisasjonsform: null }, "offentlig_klinikk", "county import row without Brreg metadata");
  expectClass({ navn: "Overhalla Tannklinikk", naeringskode: "86.230", organisasjonsform: "FKF", hjemmeside: "https://web.trondelagfylke.no/tannhelse-i-trondelag-fylkeskommune/vare-tannklinikker/" }, "offentlig_klinikk", "hjemmeside on fylkeskommune host");
  expectClass({ navn: "Ørnes tannklinikk", naeringskode: "", organisasjonsform: null, hjemmeside: "https://www.nfk.no/tjenester/tannhelse/" }, "offentlig_klinikk", "nfk.no host");
  expectClass({ navn: "JEVNAKER KLINIK NOBANDEGANI", naeringskode: "86.230", organisasjonsform: "ENK", hjemmeside: "https://afk.no/tjenester/tannhelse/tannklinikker/romerike/jevnaker-tannklinikk.190061.aspx" }, "offentlig_klinikk", "ENK pointing at afk.no wins over person_enk");

  // ── Sole proprietors under their own name ─────────────────────────────
  expectClass({ navn: "A AFRIDI", naeringskode: "86.230", organisasjonsform: "ENK" }, "person_enk", "ENK personal name");
  expectClass({ navn: "AAS FINN SINDRE", naeringskode: "86.230", organisasjonsform: "ENK" }, "person_enk", "ENK surname-first");
  expectClass({ navn: "JASLEEN KAUR KAINTH", naeringskode: "86.230", organisasjonsform: "ENK" }, "person_enk", "repeat wrong-entity offender");

  // ── Labs / suppliers ──────────────────────────────────────────────────
  expectClass({ navn: "ALIGN TECHNOLOGY BV", naeringskode: "32.500", organisasjonsform: "NUF" }, "lab_leverandor", "NACE 32.500");
  expectClass({ navn: "ALVESTAD TANNTEKNIKK", naeringskode: "32.500", organisasjonsform: "ENK" }, "lab_leverandor", "tannteknikk word");
  expectClass({ navn: "RUNAR AAMELFOT TANNTEKNISK LABORATORIUM", naeringskode: "86.230", organisasjonsform: "ENK" }, "lab_leverandor", "lab word under 86.230");
  expectClass({ navn: "AB DENTALSERVICE AS", naeringskode: "86.230", organisasjonsform: "AS" }, "lab_leverandor", "dentalservice word");
  expectClass({ navn: "ARTINORWAY DENTALFORUM LAB AS", naeringskode: "32.500", organisasjonsform: "AS" }, "lab_leverandor", "lab AS");

  // ── Holding / investment vehicles ─────────────────────────────────────
  expectClass({ navn: "AABA HOLDING AS", naeringskode: "86.230", organisasjonsform: "AS" }, "holding", "holding AS");
  expectClass({ navn: "ELU HOLDING AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: "https://alti.no/ll-holding-as/" }, "holding", "holding with directory hjemmeside");
  expectClass({ navn: "B KUBON INVEST AS", naeringskode: "86.230", organisasjonsform: "AS" }, "holding", "invest AS");
  expectClass({ navn: "ABBE EIENDOM AS", naeringskode: "86.230", organisasjonsform: "AS" }, "holding", "eiendom AS");
  expectClass({ navn: "TANNLEGE OLA NORDMANN HOLDING AS", naeringskode: "86.230", organisasjonsform: "AS" }, "holding", "dental word but ends with HOLDING AS");
  expectClass({ navn: "AFH CONSULT AS", naeringskode: "86.230", organisasjonsform: "AS" }, "holding", "consult AS");

  // ── Unknown: keep visible ─────────────────────────────────────────────
  expectClass({ navn: "AFAS 080426-03 AS", naeringskode: "86.991", organisasjonsform: "AS" }, "ukjent", "AS with non-dental NACE and no words");
  expectClass({ navn: "DREVELIN ORTOPEDI SØR AS", naeringskode: "86.230", organisasjonsform: "AS" }, "klinikk", "orthopedic 'orto' still reads as clinic (Sonnet slice, not rules)");
  expectClass({ navn: "", naeringskode: null, organisasjonsform: "AS" }, "ukjent", "empty name");
  expectClass({ navn: null }, "offentlig_klinikk", "null everything = county import shape");

  // ── Helpers / constants ───────────────────────────────────────────────
  assertTrue(isPublicDentalServiceHost("https://www.mrfylke.no/tannhelse/x"), "mrfylke.no is public host");
  assertTrue(isPublicDentalServiceHost("http://web.trondelagfylke.no/a"), "web.trondelagfylke.no is public host");
  assertTrue(!isPublicDentalServiceHost("https://tannlegegiving.no/"), "own domain is not public host");
  assertTrue(!isPublicDentalServiceHost(""), "empty is not public host");
  assertTrue(!isPublicDentalServiceHost(null), "null is not public host");
  assertTrue(DENTAL_CLINIC_CLASSES.every((c) => DENTAL_CLINIC_CLASS_SQL.includes(`'${c}'`)), "SQL clause names every clinic class");
  assertTrue(DENTAL_CLINIC_CLASS_SQL.includes("'ukjent'"), "SQL clause keeps ukjent eligible");
  assertTrue(DENTAL_CLINIC_CLASS_SQL.includes("IS NULL"), "SQL clause keeps unclassified rows eligible");
  assertTrue(DENTAL_CATALOG_CLASSES.length === 6, "six catalog classes");

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runDentalCatalogClassTests({ log: true });
  console.log(`\ndental-catalog-class: ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed > 0 ? 1 : 0);
}
