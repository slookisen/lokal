/**
 * rfb-en-chrome.test.ts — Daniel 2026-09-03 (screenshots of /en/produsent/…
 * and /en): "Er kategorier, produkter, kontaktinfo punkter også oversatt?"
 * They were not. Pure-function tests for the pieces that made an English
 * page read Norwegian even with translations served:
 *   - catLabel(): category chips/badges in en/sv, Norwegian byte-identical
 *     to formatCat(); formatCatEn() keeps its old contract (d1–d3 in
 *     rfb-producer-en-seo.test.ts) on top of real labels.
 *   - buildProducerAnswerFirstOpening(): the generated "… selger … — finn
 *     kontaktinfo …" line gets an English sentence.
 *   - formatUpdatedPretty(): "Profil oppdatert: i går" → "Profile updated:
 *     yesterday", same thresholds, injectable `now`.
 *   - decodeHtmlEntities() / normalizeProse(): "you&#039;ll" from a scrape.
 *   - the producer.* dictionary keys the contact card now reads exist in all
 *     three locales.
 */
import { catLabel, formatCat, formatCatEn, productLabel, buildProducerAnswerFirstOpening } from "./seo";
import { formatUpdatedPretty, formatUpdatedPrettyEn, formatUpdatedPrettyNo } from "../utils/freshness";
import { decodeHtmlEntities, normalizeProse } from "../services/description-quality";
import { t } from "../i18n/t";

export interface TestSummary { passed: number; failed: number; failures: string[] }

export function runRfbEnChromeTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0, failed = 0; const failures: string[] = [];
  const eq = (a: unknown, b: unknown, label: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; const m = `✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`; failures.push(m); if (log) console.log("  " + m); }
  };

  // ── catLabel ──
  const keys = ["vegetables","fruit","berries","dairy","eggs","meat","fish","bread","honey","herbs"];
  const en = ["Vegetables","Fruit","Berries","Dairy","Eggs","Meat","Fish","Bread","Honey","Herbs"];
  eq(keys.map((k) => catLabel(k, "en")), en, "c1: every homepage category has a real English label");
  eq(keys.map((k) => catLabel(k, "no")), keys.map(formatCat), "c2: Norwegian labels are byte-identical to formatCat()");
  eq(catLabel("meat", "no"), "Kjøtt", "c3: Kjøtt stays Kjøtt on the Norwegian page");
  eq(catLabel("meat", "sv"), "Kött", "c4: Swedish label exists");
  eq(["bakery","beverages","preserves","other"].map((k) => catLabel(k, "en")), ["Bakery","Beverages","Preserves","Other"], "c5: badge-only categories have English labels");
  eq(catLabel("bakery", "no"), "Bakeri", "c6: …and keep their Norwegian one");
  eq(catLabel("unknown-thing", "en"), "Unknown-thing", "c7: unmapped key falls back to the capitalised key in English");
  eq(catLabel("unknown-thing", "no"), "unknown-thing", "c8: …and to the raw key in Norwegian (unchanged behaviour)");
  eq(catLabel("", "en"), "", "c9: empty key -> empty string");
  eq([formatCatEn("vegetables"), formatCatEn("dairy"), formatCatEn("")], ["Vegetables", "Dairy", ""], "c10: formatCatEn keeps its existing contract");
  eq(formatCatEn("meat"), "Meat", "c11: …and now returns a real label, not the capitalised key");

  // ── answer-first opening ──
  const base = { name: "Gvarv Frukt og Bær", cityName: "Gvarv", productsList: [], categories: ["meat","vegetables","fruit","honey"] };
  eq(buildProducerAnswerFirstOpening({ ...base }), "Gvarv Frukt og Bær i Gvarv selger Kjøtt, Grønnsaker, Frukt med mer — finn kontaktinfo og bestill direkte under.", "a1: Norwegian sentence unchanged (no lang = no)");
  eq(buildProducerAnswerFirstOpening({ ...base, lang: "en" }), "Gvarv Frukt og Bær in Gvarv sells Meat, Vegetables, Fruit and more — find contact details and order directly below.", "a2: English sentence with English category labels");
  eq(buildProducerAnswerFirstOpening({ ...base, categories: ["meat"], lang: "en" }), "Gvarv Frukt og Bær in Gvarv sells Meat — find contact details and order directly below.", "a3: no ' and more' when three or fewer");
  eq(buildProducerAnswerFirstOpening({ ...base, productsList: [{ name: "eplemost" }], lang: "en" }), "Gvarv Frukt og Bær in Gvarv sells eplemost — find contact details and order directly below.", "a4: product names are the producer's own words and stay as written");
  eq(buildProducerAnswerFirstOpening({ ...base, cityName: "", lang: "en" }), null, "a5: still null without two real facts");
  // Live 2026-09-03 (Gvarv): products listed as bare category words rendered
  // "sells Kjøtt, Grønnsaker, Frukt" on /en. Same product -> category label.
  const gvarv = { ...base, productsList: [{ name: "Kjøtt" }, { name: "Grønnsaker" }, { name: "Frukt" }, { name: "eplemost" }] };
  eq(buildProducerAnswerFirstOpening({ ...gvarv, lang: "en" }), "Gvarv Frukt og Bær in Gvarv sells Meat, Vegetables, Fruit and more — find contact details and order directly below.", "a6: product names that are category words get the English category label");
  eq(buildProducerAnswerFirstOpening({ ...gvarv }), "Gvarv Frukt og Bær i Gvarv selger Kjøtt, Grønnsaker, Frukt med mer — finn kontaktinfo og bestill direkte under.", "a7: …and stay exactly as written in Norwegian");
  eq(buildProducerAnswerFirstOpening({ ...base, productsList: [{ name: "Eplemost" }, { name: "honning" }], lang: "en" }), "Gvarv Frukt og Bær in Gvarv sells Eplemost, Honey — find contact details and order directly below.", "a8: a real product name stays as written; a lower-case category word still maps");
  eq(productLabel("Bakeri", "en"), "Bakery", "a9: badge-only category words map too");
  eq(productLabel("Kjøtt", "no"), "Kjøtt", "a10: productLabel is a no-op in Norwegian");

  // ── updated-at ──
  const now = new Date("2026-09-03T12:00:00Z");
  const d = (iso: string) => new Date(iso);
  eq(formatUpdatedPrettyEn(d("2026-09-03T08:00:00Z"), now), "today", "u1: today");
  eq(formatUpdatedPrettyEn(d("2026-09-02T08:00:00Z"), now), "yesterday", "u2: yesterday");
  eq(formatUpdatedPrettyEn(d("2026-08-31T08:00:00Z"), now), "3 days ago", "u3: N days ago");
  eq(formatUpdatedPrettyEn(d("2026-05-11T08:00:00Z"), now), "11 May 2026", "u4: absolute date past a week");
  eq(formatUpdatedPretty(d("2026-09-02T08:00:00Z"), "en", now), "yesterday", "u5: dispatcher en");
  eq(formatUpdatedPretty(d("2026-09-02T08:00:00Z"), "no", now), formatUpdatedPrettyNo(d("2026-09-02T08:00:00Z"), now), "u6: dispatcher no = existing Norwegian");
  eq(formatUpdatedPretty(d("2026-09-02T08:00:00Z"), "sv", now), "i går", "u7: sv falls back to Norwegian text (no sv formatter yet)");

  // ── entities ──
  eq(decodeHtmlEntities("Here, you&#039;ll find products"), "Here, you'll find products", "e1: &#039; (the Gvarv case)");
  eq(decodeHtmlEntities("you&#39;ll &amp; more &#x27;x&#x27;"), "you'll & more 'x'", "e2: &#39;, &amp;, hex");
  eq(decodeHtmlEntities("G&aring;rd &oslash;st &AElig;"), "Gård øst Æ", "e3: Norwegian named entities");
  eq(decodeHtmlEntities("Vi selger egg og honning."), "Vi selger egg og honning.", "e4: no-op without entities");
  eq(decodeHtmlEntities(decodeHtmlEntities("you&#039;ll")), "you'll", "e5: idempotent");
  eq(decodeHtmlEntities("a &unknownthing; b"), "a &unknownthing; b", "e6: unknown named entity left alone");
  eq(decodeHtmlEntities("x&#0;y&#7;z"), "xyz", "e7: control characters never decoded");
  eq(decodeHtmlEntities(null), "", "e8: null -> ''");
  eq(normalizeProse("Vi selger egg. You&#039;ll love it. Kontakt ikke verifisert — verifisering pågår."), "Vi selger egg. You'll love it.", "e9: normalizeProse = decode + strip note");

  // ── dictionary keys the contact card now reads ──
  for (const k of ["address","phone","email","website","map","visit_website","show_on_map","download_vcard","updated_prefix","badge_brreg","badge_organic"]) {
    eq([t("en", `producer.${k}`) !== `producer.${k}`, t("no", `producer.${k}`) !== `producer.${k}`, t("sv", `producer.${k}`) !== `producer.${k}`], [true, true, true], `k: producer.${k} exists in en/no/sv`);
  }
  eq(t("en", "producer.download_vcard"), "Download contact card", "k2: button text is English");
  eq(t("no", "producer.download_vcard"), "Last ned kontaktkort", "k3: …and unchanged in Norwegian");

  return { passed, failed, failures };
}
