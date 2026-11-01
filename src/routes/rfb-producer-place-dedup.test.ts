/**
 * rfb-producer-place-dedup.test.ts — dev-request
 * 2026-10-27-produsentside-sted-dobbelt-i-navn-og-tekst («Malm i Malm»).
 *
 * Producer names carry a « — Sted» suffix on purpose (disambiguation +
 * geocoding), so the sentence/title builders in seo.ts must not append
 * « i {sted}» to a name that already ends with that place. These tests pin:
 *   - nameForPlaceSentence(): strips the suffix only when it IS the place;
 *   - buildProducerMetaDescription / buildProducerAnswerFirstOpening /
 *     buildProducerPageTitle / buildProducerFaqJsonLd («holder til i»)
 *     no longer render «{Sted} i {Sted}»;
 *   - control cases («— Agder» in Arendal, «— Gårdsis», «Akerhaugen Gård —
 *     Kafé og Bakeri, Telemark» in Sauherad, «— Fisketorget Bergen», a name
 *     with no suffix) are byte-identical to before;
 *   - when only the tail after the last «,» / «/» / « i » is the place, just
 *     that tail is dropped («— Svelvik, Drammen» → «— Svelvik»).
 *
 * Run standalone: npx tsx src/routes/rfb-producer-place-dedup.test.ts
 * Wired into the gate: tests/test.ts imports runRfbProducerPlaceDedupTests().
 */

import {
  nameForPlaceSentence,
  buildProducerMetaDescription,
  buildProducerAnswerFirstOpening,
  buildProducerPageTitle,
  buildProducerFaqJsonLd,
  safeMetaDescription,
} from "./seo";
import { t } from "../i18n/t";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runRfbProducerPlaceDedupTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── nameForPlaceSentence ────────────────────────────────────────────────
  assertEq(nameForPlaceSentence("Tverås Gårdsmat — Malm", "Malm"), "Tverås Gårdsmat", "P1 suffix = city → stripped");
  assertEq(nameForPlaceSentence("Tverås Gårdsmat – Malm", "Malm"), "Tverås Gårdsmat", "P2 en dash also recognised");
  assertEq(nameForPlaceSentence("Bra Bakst — ALTA", "Alta"), "Bra Bakst", "P3 case-insensitive");
  assertEq(nameForPlaceSentence("Gården — Nes, Hedmark", "Nes"), "Gården", "P4 first comma segment = city → stripped");
  assertEq(nameForPlaceSentence("Bageri Vanilje — Agder", "Arendal"), "Bageri Vanilje — Agder", "P5 suffix not the city → unchanged");
  assertEq(nameForPlaceSentence("Bamsrudlåven — Gårdsis", "Askim"), "Bamsrudlåven — Gårdsis", "P6 non-place suffix → unchanged");
  assertEq(
    nameForPlaceSentence("Bageri Vanilje — Kafé og Bakeri, Telemark", "Telemark"),
    "Bageri Vanilje — Kafé og Bakeri",
    "P7 city as LAST comma segment → only «, Telemark» dropped, descriptive part kept",
  );
  assertEq(
    nameForPlaceSentence("Berles Gårdsbutikk — Svelvik, Drammen", "Drammen"),
    "Berles Gårdsbutikk — Svelvik",
    "P7b «Svelvik, Drammen» in Drammen → «— Svelvik» (sentence: «… — Svelvik i Drammen»)",
  );
  assertEq(
    nameForPlaceSentence("Bringebærlandet — Drøbak (Akershus)", "Drøbak"),
    "Bringebærlandet",
    "P7c trailing «(…)» qualifier ignored",
  );
  assertEq(
    nameForPlaceSentence("Bondens marked — Kabelvåg/Lofoten", "Kabelvåg"),
    "Bondens marked",
    "P7d first «/» segment = city → stripped",
  );
  assertEq(
    nameForPlaceSentence("Bondens Grøntmarked — Fisketorget Bergen", "Bergen"),
    "Bondens Grøntmarked — Fisketorget Bergen",
    "P7e venue suffix that merely contains the city word → unchanged",
  );
  assertEq(
    nameForPlaceSentence("Gård – Sannidal, Kragerø", "Kragerø"),
    "Gård – Sannidal",
    "P7f original en-dash separator preserved when the tail is dropped",
  );
  assertEq(
    nameForPlaceSentence("Akerhaugen Gård — Kafé og Bakeri, Telemark", "Sauherad"),
    "Akerhaugen Gård — Kafé og Bakeri, Telemark",
    "P7g spec control (real producer, city Sauherad) → unchanged",
  );
  assertEq(
    nameForPlaceSentence("Kapczynska Bakeri — Husøy i Senja", "Senja"),
    "Kapczynska Bakeri — Husøy",
    "P7h «Husøy i Senja» in Senja → «— Husøy» (sentence: «… — Husøy i Senja»)",
  );
  assertEq(
    nameForPlaceSentence("Kapczynska Bakeri — Husøy i Senja", "Husøy"),
    "Kapczynska Bakeri",
    "P7i first « i » segment = city → stripped",
  );
  assertEq(
    nameForPlaceSentence("Judiths Urtehage — Kabelvåg/Lofoten", "Lofoten"),
    "Judiths Urtehage — Kabelvåg",
    "P7j last «/» segment = city → only «/Lofoten» dropped",
  );
  assertEq(
    nameForPlaceSentence("Fjellgård — Herøy (Nordland)", "Herøy (Møre og Romsdal)"),
    "Fjellgård — Herøy (Nordland)",
    "P7k both sides qualified differently → not the same place, unchanged",
  );
  assertEq(
    nameForPlaceSentence("Fjellgård — Herøy (Nordland)", "Herøy (Nordland)"),
    "Fjellgård",
    "P7l both sides qualified identically → stripped",
  );
  assertEq(nameForPlaceSentence("Tverås Gårdsmat — Malm", "   "), "Tverås Gårdsmat — Malm", "P7m whitespace-only city → unchanged");
  assertEq(
    nameForPlaceSentence("Tverås Gårdsmat\u00a0—\u00a0Malm", "Malm"),
    "Tverås Gårdsmat",
    "P7n non-breaking spaces around the dash still recognised",
  );
  assertEq(nameForPlaceSentence("Nordfjord Bakeri", "Ålesund"), "Nordfjord Bakeri", "P8 no suffix → unchanged");
  assertEq(nameForPlaceSentence("Tverås Gårdsmat — Malm", ""), "Tverås Gårdsmat — Malm", "P9 no city → unchanged");
  assertEq(nameForPlaceSentence("Ola-Gården", "Gården"), "Ola-Gården", "P10 unspaced hyphen is not a suffix separator");
  assertEq(nameForPlaceSentence("A — B — Malm", "Malm"), "A — B", "P11 only the LAST suffix is compared");
  assertEq(nameForPlaceSentence("Gård — Malmø", "Malm"), "Gård — Malmø", "P12 prefix match is not equality");

  // ── meta description (AC1) ──────────────────────────────────────────────
  const desc = "Vi driver et lite gårdsbruk med kyr, og lager ost og smør av egen melk på gården.";
  const nbMeta = buildProducerMetaDescription("Tverås Gårdsmat — Malm", "Malm", "no", desc, "dairy", 0);
  assertTrue(nbMeta.startsWith("Tverås Gårdsmat i Malm."), "M1 NB meta starts «Tverås Gårdsmat i Malm.»");
  assertTrue(!nbMeta.includes("Malm i Malm"), "M2 NB meta has no «Malm i Malm»");
  assertEq(
    buildProducerMetaDescription("Bageri Vanilje — Agder", "Arendal", "no", desc, "bakery", 0),
    `Bageri Vanilje — Agder i Arendal. ${safeMetaDescription(desc)}`,
    "M3 NB control «— Agder» in Arendal byte-identical",
  );
  assertEq(
    buildProducerMetaDescription("Nordfjord Bakeri", "", "no", "", "bakery", 0),
    "Nordfjord Bakeri. Lokalprodusert mat i Norge.",
    "M4 NB no city → unchanged",
  );
  assertEq(
    buildProducerMetaDescription("Tverås Gårdsmat — Malm", "", "no", "", "dairy", 0),
    "Tverås Gårdsmat — Malm. Lokalprodusert mat i Norge.",
    "M4b NB suffixed name without city → full name, unchanged",
  );
  assertEq(
    buildProducerMetaDescription("Akerhaugen Gård — Kafé og Bakeri, Telemark", "Sauherad", "no", desc, "bakery", 0),
    `Akerhaugen Gård — Kafé og Bakeri, Telemark i Sauherad. ${safeMetaDescription(desc)}`,
    "M4c NB spec control through the meta builder → unchanged",
  );
  const enMeta = buildProducerMetaDescription("Tverås Gårdsmat — Malm", "Malm", "en", desc, "dairy", 2);
  assertTrue(enMeta.startsWith("Tverås Gårdsmat is a local food producer in Malm, Norway."), "M5 EN meta dedups the place");
  assertEq(
    buildProducerMetaDescription("Bamsrudlåven — Gårdsis", "Askim", "en", desc, "", 0),
    "Bamsrudlåven — Gårdsis is a local food producer in Askim, Norway.",
    "M6 EN control unchanged",
  );

  // ── answer-first opening (AC1) ──────────────────────────────────────────
  const opening = buildProducerAnswerFirstOpening({
    name: "Tverås Gårdsmat — Malm",
    cityName: "Malm",
    productsList: [],
    categories: ["dairy"],
  });
  assertTrue(!!opening && opening.startsWith("Tverås Gårdsmat i Malm tilbyr "), "O1 NB opening «Tverås Gårdsmat i Malm tilbyr …»");
  assertTrue(!!opening && !opening.includes("Malm i Malm"), "O2 NB opening has no «Malm i Malm»");
  const openingEn = buildProducerAnswerFirstOpening({
    name: "Tverås Gårdsmat — Malm",
    cityName: "Malm",
    productsList: [],
    categories: ["dairy"],
    lang: "en",
  });
  assertTrue(!!openingEn && openingEn.startsWith("Tverås Gårdsmat in Malm offers "), "O3 EN opening dedups the place");
  const openingCtl = buildProducerAnswerFirstOpening({
    name: "Bageri Vanilje — Agder",
    cityName: "Arendal",
    productsList: [],
    categories: ["bakery"],
  });
  assertTrue(!!openingCtl && openingCtl.startsWith("Bageri Vanilje — Agder i Arendal tilbyr "), "O4 control unchanged");
  const openingCtlEn = buildProducerAnswerFirstOpening({
    name: "Bamsrudlåven — Gårdsis",
    cityName: "Askim",
    productsList: [],
    categories: ["dairy"],
    lang: "en",
  });
  assertTrue(!!openingCtlEn && openingCtlEn.startsWith("Bamsrudlåven — Gårdsis in Askim offers "), "O5 EN control unchanged");

  // ── page title (AC1) ────────────────────────────────────────────────────
  assertEq(
    buildProducerPageTitle("Tverås Gårdsmat — Malm", "Malm", "no", null),
    `Tverås Gårdsmat${t("no", "producer.title_suffix", { city: "Malm" })}`,
    "T1 NB title «Tverås Gårdsmat — Lokal matprodusent i Malm»",
  );
  assertTrue(
    buildProducerPageTitle("Tverås Gårdsmat — Malm", "Malm", "no", null).startsWith("Tverås Gårdsmat — Lokal matprodusent i Malm"),
    "T2 NB title text as in the dev-request",
  );
  assertEq(
    buildProducerPageTitle("Bamsrudlåven — Gårdsis", "Askim", "no", null),
    `Bamsrudlåven — Gårdsis${t("no", "producer.title_suffix", { city: "Askim" })}`,
    "T3 control unchanged",
  );
  assertEq(
    buildProducerPageTitle("Tverås Gårdsmat — Malm", "", "no", null),
    "Tverås Gårdsmat — Malm",
    "T4 no city → full name, unchanged",
  );
  assertEq(
    buildProducerPageTitle("Tverås Gårdsmat — Malm", "Malm", "en", null),
    `Tverås Gårdsmat${t("en", "producer.title_suffix", { city: "Malm" })}`,
    "T5 EN title dedups the place",
  );

  // ── FAQ JSON-LD «holder til i» (same bug class, same helper) ────────────
  const faq = buildProducerFaqJsonLd({
    name: "Tverås Gårdsmat — Malm",
    url: "https://rettfrabonden.com/produsent/tveras-gardsmat-malm",
    cityName: "Malm",
    productsList: [],
    categories: ["dairy"],
    hoursList: [],
    hoursText: "",
  });
  const where = faq?.mainEntity?.find((q: any) => String(q.name).startsWith("Hvor ligger"));
  assertEq(where?.name, "Hvor ligger Tverås Gårdsmat — Malm?", "F1 FAQ question keeps the full name");
  assertEq(where?.acceptedAnswer?.text, "Tverås Gårdsmat holder til i Malm.", "F2 FAQ answer has no «Malm i Malm»");

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runRfbProducerPlaceDedupTests({ log: true });
  console.log(`\nrfb-producer-place-dedup: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
