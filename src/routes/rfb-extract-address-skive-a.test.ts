/**
 * rfb-extract-address-skive-a.test.ts — extractAddress "Skive A" (2026-11-01):
 * only the clean «street nr, postnummer poststed», or null.
 *
 * Block boundaries (<br>, </p>, </hN>, </li>, </div>, …) are line breaks:
 * the street and the poststed never cross one; house number -> postcode may
 * cross at most one. Trailing Norge/Norway dropped. A poststed is checked
 * against the Bring postnummerregister ONLY when it is already loaded in
 * memory (never fetched). A name prefix still glued in front of the street
 * returns null.
 *
 * Standalone:  npx tsx src/routes/rfb-extract-address-skive-a.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

import { extractAddress } from "./marketplace";
import {
  __setCityPostalRegistryCacheForTesting,
  getCachedPostalRegistry,
} from "../services/agents-city-backfill";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runRfbExtractAddressSkiveATests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log(`  ${msg}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    assertEq(cond, true, label);
  }

  // Never let another test's registry cache leak into these cases (or ours out).
  const savedRegistry = getCachedPostalRegistry();
  __setCityPostalRegistryCacheForTesting(null);
  try {
    // ── Real-site repros (registry NOT loaded) ──────────────────────────────
    const bearHouse = `<html><body>
      <header><a href="/">Bear House</a></header>
      <section class="contact">
        <h3>Nesbyen</h3>
        <p>Jordeshagen 3, 3540 Nesbyen</p>
        <p>Det er bare å ta kontakt for booking.</p>
      </section></body></html>`;
    assertEq(extractAddress(bearHouse), "Jordeshagen 3, 3540 Nesbyen",
      "A1 Bear House: heading/company on lines above are not swallowed, nor the next paragraph's «Det»");

    const ildOgBonner = `<html><body><footer>
      <h4>Ild og Bønner</h4>
      <p>Joel Simpson<br>Storgata 120<br>3915 Porsgrunn<br>Norway</p>
      <p>Tlf: 412 34 567</p>
    </footer></body></html>`;
    const ild = extractAddress(ildOgBonner);
    assertEq(ild, "Storgata 120, 3915 Porsgrunn", "A2 Ild og Bønner: person-name line and «Norway» dropped");
    assertTrue(!ild || (!ild.includes("Joel") && !ild.includes("Simpson") && !ild.includes("Norway")),
      "A2b Ild og Bønner: never contains «Joel Simpson» or «Norway»");

    const selvig = `<html><body><footer class="site-footer">
      <div class="col"><h4>Selvig Gård</h4><p>Bekkajordet 9, 3189 Horten</p></div>
      <div class="col"><p>post@selvig.no</p></div></footer></body></html>`;
    assertEq(extractAddress(selvig), "Bekkajordet 9, 3189 Horten", "A3 Selvig: clean hit unchanged");

    const sjorbottens = `<html><body><footer>
      <p><strong>Sjørbottens Gårdsutsalg</strong><br>Blybergs vei 12<br>3531 Krokkleiva</p>
    </footer></body></html>`;
    assertEq(extractAddress(sjorbottens), "Blybergs vei 12, 3531 Krokkleiva",
      "A4 Sjørbottens: «Blybergs vei» (one capitalised word + vei) still passes");

    const sjorbottensOneLine = "<p>Blybergs vei 12, 3531 Krokkleiva</p>";
    assertEq(extractAddress(sjorbottensOneLine), "Blybergs vei 12, 3531 Krokkleiva",
      "A4b Sjørbottens one-line form unchanged");

    const sjovold = `<html><body><div class="footer">
      <h5>Sjøvold Gård</h5><p>Trælnessjøveien 23, 8920 Sømna, Norge</p></div></body></html>`;
    assertEq(extractAddress(sjovold), "Trælnessjøveien 23, 8920 Sømna", "A5 Sjøvold: «, Norge» not included");

    assertEq(extractAddress("<p>Trælnessjøveien 23, 8920 Sømna Norge</p>"), "Trælnessjøveien 23, 8920 Sømna",
      "A5b trailing country word without comma is dropped");

    // ── Line-break rules ─────────────────────────────────────────────────────
    assertEq(extractAddress("<p>Storgata 120<br>3915 Porsgrunn</p>"), "Storgata 120, 3915 Porsgrunn",
      "B1 one line break between house number and postcode is allowed");

    assertEq(extractAddress("<div>Gården vår</div><div>Storgata 5, 1400 Ski</div>"), "Storgata 5, 1400 Ski",
      "B2 street does not cross a line break");

    assertEq(extractAddress("<p>Storgata 120</p><p>Åpent hver dag</p><p>3915 Porsgrunn</p>"), null,
      "B3 two line breaks between house number and postcode — no match");

    assertEq(extractAddress("<p>Storgata 5, 1400 Ski<br>Nordre Follo</p>"), "Storgata 5, 1400 Ski",
      "B4 poststed does not cross a line break");

    assertEq(extractAddress("<p>Storgata 5, 1400\nSki</p>"), "Storgata 5, 1400 Ski",
      "B5 a raw newline in the HTML source is whitespace, not a line break");

    // ── Name-prefix guard ───────────────────────────────────────────────────
    assertEq(extractAddress("<p>Joel Simpson Storgata 120, 3915 Porsgrunn</p>"), null,
      "C1 person name in front of the street on the same line ⇒ null");
    assertEq(extractAddress("<p>Bear House Jordeshagen 3, 3540 Nesbyen</p>"), null,
      "C2 producer name in front of «…hagen» street on the same line ⇒ null");
    assertEq(extractAddress("<p>Joel Simpson Blybergs vei 12, 3531 Krokkleiva</p>"), null,
      "C3 name in front of a «<Name> vei» street ⇒ null");
    assertEq(extractAddress("<p>Kong Oscars gate 5, 5017 Bergen</p>"), "Kong Oscars gate 5, 5017 Bergen",
      "C4 genitive two-word street «Kong Oscars gate» passes");
    assertEq(extractAddress("<p>Øvre Slottsgate 5, 0157 Oslo</p>"), "Øvre Slottsgate 5, 0157 Oslo",
      "C5 one capitalised word in front of a compound street passes");

    // ── Registry ───────────────────────────────────────────────────────────
    const sameLineExtraWord = "<p>Jordeshagen 3, 3540 Nesbyen Det er bare å ta kontakt.</p>";
    assertEq(extractAddress(sameLineExtraWord), "Jordeshagen 3, 3540 Nesbyen Det",
      "D1 registry NOT loaded: only the line-break rule applies (extra same-line word kept)");

    __setCityPostalRegistryCacheForTesting(new Map([
      ["3540", "NESBYEN"],
      ["4370", "EGERSUND"],
      ["4630", "KRISTIANSAND S"],
      ["1400", "SKI"],
    ]));
    assertEq(extractAddress(sameLineExtraWord), "Jordeshagen 3, 3540 Nesbyen",
      "D2 registry loaded: extra word not in the registry name is dropped");
    assertEq(extractAddress("<p>Skolegata 12, 4370 Egersund Vest og fjord</p>"), "Skolegata 12, 4370 Egersund",
      "D3 registry loaded: «Egersund Vest» -> «Egersund»");
    assertEq(extractAddress("<p>Tordenskjolds gate 9, 4630 Kristiansand S</p>"), "Tordenskjolds gate 9, 4630 Kristiansand S",
      "D4 registry loaded: multi-word registry name taken from the page");
    assertEq(extractAddress("<p>Storgata 5, 1400 Drammen</p>"), null,
      "D5 registry loaded: poststed contradicting the registry is not written");
    assertEq(extractAddress("<p>Storgata 5, 3915 Porsgrunn</p>"), "Storgata 5, 3915 Porsgrunn",
      "D6 registry loaded but postcode unknown to it: line-break rule only");
  } finally {
    __setCityPostalRegistryCacheForTesting(savedRegistry);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runRfbExtractAddressSkiveATests({ log: true });
  console.log(`\nrfb-extract-address-skive-a: ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed > 0 ? 1 : 0);
}
