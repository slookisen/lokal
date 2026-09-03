/**
 * product-glossary.test.ts — Daniel 2026-09-03: «ja kjør ordlisten for
 * produktene også». Pure-function tests for translateProductName(),
 * productLabel() (category word first) and a coverage floor measured against
 * a real frequency sample of the catalog (526 producers, top 120 names,
 * taken 2026-09-03T21:20Z through the public search API).
 */
import { translateProductName, glossaryCoverage } from "./product-glossary";
import { productLabel, isCategoryWord } from "../routes/seo";

export interface TestSummary { passed: number; failed: number; failures: string[] }

const FREQ: Array<[string, number]> = [["grønnsaker", 91], ["kjøtt", 73], ["bakervarer", 65], ["honning", 59], ["meieri", 58], ["egg", 55], ["frukt", 52], ["fisk", 50], ["lokal mat", 49], ["kjøtt og egg", 49], ["bakevarer og honning", 48], ["urter", 44], ["drikke", 23], ["poteter", 16], ["lammekjøtt", 12], ["storfekjøtt", 10], ["pølser", 9], ["syltetøy", 9], ["plommer", 7], ["eplemost", 7], ["brød og bakevarer", 6], ["pinnekjøtt", 6], ["epler", 6], ["fenalår", 6], ["syltetøy og hermetikk", 5], ["meieriprodukter", 5], ["bringebær", 5], ["saft", 5], ["eplesider", 5], ["svinekjøtt", 5], ["lynghonning", 5], ["egg fra frittgående høner", 4], ["spekemat", 4], ["bringebær (selvplukk)", 4], ["jordbær", 4], ["blomster", 4], ["pærer", 4], ["brød", 4], ["ost", 4], ["grønsaker", 3], ["bær", 3], ["yoghurt", 3], ["smør", 3], ["bacon", 3], ["geiteost", 3], ["varmrøkt peppermakrell", 3], ["sommerhonning", 3], ["brunost", 3], ["lam", 3], ["fjellørret", 3], ["økologisk storfekjøtt", 3], ["lammerull", 3], ["sesonggrønnsaker", 2], ["mikrogrønt", 2], ["kalvekjøtt", 2], ["gulrøtter", 2], ["pålegg", 2], ["delikatesseskinke", 2], ["tyttebær", 2], ["løk", 2], ["brisket", 2], ["burgere", 2], ["kålrot", 2], ["gresskar", 2], ["grønnkål", 2], ["lokalmat", 2], ["gulrot", 2], ["quinoa", 2], ["mais", 2], ["fersk frukt", 2], ["økologiske egg", 2], ["eplejuice", 2], ["sider", 2], ["konfekt", 2], ["most", 2], ["catering", 2], ["rømme", 2], ["salatost", 2], ["ribbe", 2], ["juice", 2], ["vegetables", 2], ["myrdal fjellost", 2], ["myrdal ramsløkost", 2], ["pepparost", 2], ["edamer", 2], ["myrdal kvit geitost", 2], ["vellagra kvit geitost", 2], ["bjørnefjorden blå", 2], ["kvit geitost med trøffel", 2], ["fersk geitost", 2], ["kvit geitost med ramsløk", 2], ["delikatesser", 2], ["arktiske jordbær", 2], ["nrf storfekjøtt", 2], ["spekemat av lam", 2], ["kaldpresset rapsolje", 2], ["reker", 2], ["røkt laks", 2], ["varmrøkt makrell", 2], ["sommarhonning", 2], ["geitost", 2], ["flatbrød", 2], ["surdeigsbrød", 2], ["croissanter", 2], ["focaccia", 2], ["konditorvarer", 2], ["sommerbolle", 2], ["surdeigbrød", 2], ["knekkebrød", 2], ["croissant", 2], ["pesto", 2], ["gårdsegg", 2], ["sjokolade", 2], ["bivokslys", 2], ["krydder", 2], ["kaker og konditorvarer", 2], ["gele", 2], ["bakevarer", 2], ["lokale gårdsprodukter", 2], ["spekepølse av lam", 2]];

export function runProductGlossaryTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0, failed = 0; const failures: string[] = [];
  const eq = (a: unknown, b: unknown, label: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; const m = `✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`; failures.push(m); if (log) console.log("  " + m); }
  };
  const en = (s: string) => translateProductName(s, "en");
  const sv = (s: string) => translateProductName(s, "sv");
  const no = (s: string) => translateProductName(s, "no");

  // ── rules ──
  eq(en("Eplemost"), "Apple juice", "g1: single word, capitalisation kept");
  eq(en("LAMMEKJØTT"), "LAMB", "g2: all-caps kept");
  eq(en("kjøtt og egg"), "meat and eggs", "g3: phrase before word-by-word");
  eq(en("Egg fra frittgående høner"), "Free-range eggs", "g4: fixed expression as a phrase");
  eq(en("Bringebær (selvplukk)"), "Raspberries (pick-your-own)", "g5: parenthesised group");
  eq(en("Økologisk storfekjøtt"), "Organic beef", "g6: word by word when every word is known");
  eq(en("Varmrøkt peppermakrell"), "Hot-smoked peppered mackerel", "g7: qualifier + noun");
  eq(en("Kvit geitost med trøffel"), "White goat cheese with truffle", "g8: connector 'med'");
  eq(en("Ukjent spesialitet"), "Ukjent spesialitet", "g9: unknown name unchanged");
  eq(en("Økologisk ukjentting"), "Økologisk ukjentting", "g10: ONE unknown word -> whole name unchanged, never half-translated");
  eq(en("Fenalår"), "Fenalår (cured leg of lamb)", "g11: Norwegian speciality keeps its name with a gloss");
  eq(en("Poteter, gulrøtter"), "Potatoes, carrots", "g12: trailing punctuation kept");
  eq(en(""), "", "g13: empty unchanged");
  eq(en("  "), "  ", "g14: whitespace unchanged");
  eq(no("Eplemost"), "Eplemost", "g15: Norwegian is always the producer's own text");
  eq(sv("Eplemost"), "Äppelmust", "g16: Swedish where known");
  eq(sv("Ukjent spesialitet"), "Ukjent spesialitet", "g17: Swedish falls back to the NORWEGIAN original, never English");

  // ── productLabel: category word first, then glossary ──
  eq(productLabel("Kjøtt", "en"), "Meat", "p1: bare category word -> category label");
  eq(productLabel("Grønnsaker", "en"), "Vegetables", "p2");
  eq(productLabel("Bakeri", "en"), "Bakery", "p3: badge-only category word");
  eq(productLabel("Lammekjøtt", "en"), "Lamb", "p4: not a category word -> glossary");
  eq(productLabel("Ukjent", "en"), "Ukjent", "p5: unknown unchanged");
  eq(productLabel("Kjøtt", "no"), "Kjøtt", "p6: Norwegian unchanged");
  eq([isCategoryWord("kjøtt"), isCategoryWord("Frukt"), isCategoryWord("eplemost")], [true, true, false], "p7: isCategoryWord");

  // ── coverage floor against the real sample (AC 4: ≥ 60 %) ──
  const c = glossaryCoverage(FREQ, "en", isCategoryWord);
  if (log) console.log(`  coverage en: ${c.translated}/${c.total} = ${c.pct}%`);
  eq(c.pct >= 60, true, `cov1: English coverage of the top-120 sample is at least 60% (actual ${c.pct}%)`);
  eq(c.pct >= 85, true, `cov2: …and at least 85% (regression guard; actual ${c.pct}%)`);
  // and nothing in the sample comes back half-translated: every output is
  // either the input or contains no Norwegian-only letters (æøå) except
  // inside a kept speciality name (fenalår/pinnekjøtt/lammerull/rakfisk).
  const keep = /fenalår|pinnekjøtt|lammerull|rakfisk|gammelost|brunost|lefse|skyr|myrdal|bjørnefjorden/i;
  const half = FREQ.map(([n]) => [n, productLabel(n, "en")] as const).filter(([n, o]) => o !== n && /[æøåÆØÅ]/.test(o) && !keep.test(o));
  eq(half, [], "cov3: no half-translated output in the sample");

  return { passed, failed, failures };
}
