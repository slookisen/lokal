/**
 * rfb-address-normalization-c1.test.ts — dev-request
 * 2026-10-01-rfb-adressenormalisering-c1.
 *
 * Positive rows (observed 2026-09-30) must AGREE in crossSourceAgreement
 * (gating path) and the negative rows must still CONFLICT. Also pins the
 * extractAddress date rejection and the extended label list.
 *
 * Standalone:  npx tsx src/routes/rfb-address-normalization-c1.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

import { crossSourceAgreement, parseAddressCore, type ProvenanceRecord } from "../services/cross-source-validator";
import {
  addressesMatch,
  stripLeadingContactLabel,
  stripAddressLeadingNoise,
  looksLikeDateText,
} from "../services/contact-normalizer";
import { extractAddress } from "./marketplace";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function rec(source_type: string, value: string): ProvenanceRecord {
  return { value, source_type, extracted_at: "2026-09-30T00:00:00Z" } as unknown as ProvenanceRecord;
}

export function runRfbAddressNormalizationC1Tests(opts: { log?: boolean } = {}): TestSummary {
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

  // Gate-level agreement of two Tier-A/B sources, with the row's own name.
  const agrees = (a: string, b: string, name?: string): boolean =>
    crossSourceAgreement(
      { address: [rec("homepage", a), rec("google_places", b)] },
      "address",
      { ownName: name },
    ).agree;

  // ── Positive: observed table (agree) ───────────────────────────────────────
  assertTrue(agrees("Kontakt Lundemannsverk 46, 5414 Stord", "Lundemannsverk 46, 5414 Stord", "Lundemannsverk — Stord"),
    "POS ledetekst: Lundemannsverk");
  assertTrue(agrees("Kontakt Oceanfood AS Storhaugen 1, 9011 Tromsø", "Storhaugen 1, 9011 Tromsø", "Oceanfood — Tromsø"),
    "POS ledetekst+firma: Oceanfood");
  assertTrue(agrees("Safteriet Safteriet AS Hillevågsveien 99b, 4016 Stavanger Norway", "Hillevågsveien 99B, 4016 Stavanger, Norge", "Safteriet — Rogaland"),
    "POS firmanavn: Safteriet");
  assertTrue(agrees("Safteriet Safteriet AS Hillevågsveien 99b, 4016 Stavanger Norway", "Hillevågsveien 99B, 4016 Stavanger, Norge"),
    "POS firmanavn utan radnamn (selskapsform-regel)");
  assertTrue(agrees("Solvang Gård Bergenvegen 18, 3802 Bø", "Bergenvegen 18, 3802 Bø, Norge", "Solvang Gård"),
    "POS gårdsnavn: Solvang Gård (eget navn)");
  assertTrue(agrees("Ytre Hægeland Gård Stallemovegen 51, 4715 Øvrebø", "Stallemovegen 51, 4715 Øvrebø", "Ytre Hægeland Gård"),
    "POS gårdsnavn: Gårdssysleriet (eget navn = Ytre Hægeland Gård)");
  assertTrue(agrees("Facebook Instagram Breivevegen 38, 4755 Hovden", "Breivevegen 38, 4755 Hovden i Setesdal, Norge", "Fjellgarden Hovden — Setesdal"),
    "POS menytekst: Fjellgarden Hovden");
  assertTrue(agrees("www.aalan.no - Lauvdalen 186, 8360 Bøstad", "Lauvdalen 186, 8360 Bøstad, Norge", "Aalan Gård — Bøstad"),
    "POS URL-prefiks: Aalan Gård");
  assertTrue(agrees("Ullstindvegen 1242/1246, 9023 Krokelvdalen", "Ullstindvegen 1242, 9023 Krokelvdalen, Norge", "Nordvoll Økologisk Gård — Krokelvdalen"),
    "POS husnummerintervall: Nordvoll (N)");
  assertTrue(agrees("Ullstindvegen 1242/1246, 9023 Krokelvdalen", "Ullstindvegen 1246, 9023 Krokelvdalen, Norge"),
    "POS husnummerintervall: matcher også M");
  assertTrue(agrees("Prestealléen 52, 3944 Porsgrunn", "Prestealleen 52, 3944 Porsgrunn, Norge", "Prestegårdshagene SA — Porsgrunn"),
    "POS aksent: Prestealléen");
  assertTrue(addressesMatch("www.aalan.no | Lauvdalen 186", "Lauvdalen 186"), "POS URL-prefiks med |");
  assertTrue(addressesMatch("Instagram Lauvdalen 186, 8360 Bøstad", "Lauvdalen 186, 8360 Bøstad"), "POS Instagram-ledetekst");

  // ── Negative: must still conflict ──────────────────────────────────────────
  assertTrue(!agrees("Sirnesvegen 20, 4438 Sira", "Sirnesvegen 20, 4439 Sira, Norge", "Svindland Spekemat — Flekkefjord"),
    "NEG ulikt postnummer: Svindland 4438 vs 4439");
  assertTrue(!agrees("Breivevegen 34", "Breivevegen 38, 4755 Hovden i Setesdal, Norge", "Fjellgarden Hovden — Setesdal"),
    "NEG ulikt husnummer: Breivevegen 34 vs 38");
  assertTrue(!agrees("Fv106 51, 4715 Øvrebø", "Stallemovegen 51, 4715 Øvrebø", "Ytre Hægeland Gård"),
    "NEG ulikt vegnavn: Fv106 51 vs Stallemovegen 51");
  assertTrue(!agrees("Nedre Storgata 5, 0150 Oslo", "Storgata 5, 0150 Oslo", "Storgata Bakeri"),
    "NEG vilkårlig ledeord: Nedre Storgata 5 vs Storgata 5");
  assertTrue(!agrees("Nedre Storgata 5, 0150 Oslo", "Storgata 5, 0150 Oslo"),
    "NEG vilkårlig ledeord utan radnamn");
  assertTrue(!agrees("Ullstindvegen 1246, 9023 Krokelvdalen", "Ullstindvegen 1242, 9023 Krokelvdalen, Norge"),
    "NEG intervall gjør ikke 1246 og 1242 like");
  assertTrue(!addressesMatch("Ullstindvegen 1242/1246", "Ullstindvegen 1244"), "NEG intervall matcher ikke tall utenfor");
  assertTrue(!addressesMatch("Hillevågsveien 99B", "Hillevågsveien 99A"), "NEG husbokstav");
  assertTrue(parseAddressCore("Prestealléen 52, 3944 Porsgrunn").core !== parseAddressCore("Prestealleen 53, 3944 Porsgrunn").core,
    "NEG aksentfold endrer ikke husnummer");
  // æ ø å are never folded.
  assertTrue(!addressesMatch("Bærum 5", "Barum 5"), "NEG æ foldes aldri");
  assertTrue(!addressesMatch("Bjørkeveien 5", "Bjorkeveien 5"), "NEG ø foldes aldri");
  assertTrue(!addressesMatch("Åsveien 5", "Asveien 5"), "NEG å foldes aldri");

  // ── Preprocessing helpers ──────────────────────────────────────────────────
  assertTrue(stripLeadingContactLabel("Facebook Instagram Breivevegen 38") === "Breivevegen 38", "label: Facebook Instagram");
  assertTrue(stripLeadingContactLabel("www.aalan.no - Lauvdalen 186") === "Lauvdalen 186", "label: www-prefiks");
  assertTrue(stripAddressLeadingNoise("Nedre Storgata 5") === "Nedre Storgata 5", "ledeord strippes ikke");
  assertTrue(stripAddressLeadingNoise("Solvang Gård Bergenvegen 18", "Solvang Gård") === "Bergenvegen 18", "eget navn strippes");
  assertTrue(stripAddressLeadingNoise("Solvang Gård Bergenvegen 18") === "Solvang Gård Bergenvegen 18", "eget navn uten radnavn: urørt");

  // ── Date detection + extractAddress ────────────────────────────────────────
  assertTrue(looksLikeDateText("Nyheter September 17"), "date: English month + day");
  assertTrue(looksLikeDateText("Nyheter 17. september"), "date: Norwegian day + month");
  assertTrue(!looksLikeDateText("Augustveien 5"), "date NEG: street starting with month stem");
  assertTrue(!looksLikeDateText("Storgata 17"), "date NEG: ordinary street");
  assertTrue(
    extractAddress("<p>Nyheter September 17, 2025 Sesongavslutning</p>") === null,
    "extractAddress rejects 'September 17, 2025 Sesongavslutning'",
  );
  assertTrue(
    extractAddress("<p>Nyheter mai 3, 2024 Åpning</p>") === null,
    "extractAddress rejects Norwegian month + day + 20xx",
  );
  assertTrue(
    extractAddress("<p>Facebook Instagram Breivevegen 38, 4755 Hovden</p>") === "Breivevegen 38, 4755 Hovden",
    "extractAddress strips Facebook Instagram lead",
  );
  assertTrue(
    extractAddress("<p>Nyheter September 17, 2025 Sesongavslutning. Besøk oss: Lauvdalen 186, 8360 Bøstad</p>") === "Lauvdalen 186, 8360 Bøstad",
    "extractAddress still finds the real address after a date",
  );

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── rfb-address-normalization-c1 ──");
  const r = runRfbAddressNormalizationC1Tests({ log: true });
  console.log(`\nrfb-address-normalization-c1: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
