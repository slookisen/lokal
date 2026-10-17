/**
 * fylke-bounds.test.ts — dev-request 2026-10-17-integrasjonstest-oppfolging,
 * I-E (SD-02), review B1 on lokal#1109: the fylke and shared-name kommune
 * bounding boxes (src/services/fylke-bounds.ts) that let a producer's own
 * coordinate veto a fylke placement by name.
 *
 * Covers:
 *   (a) FYLKE_BOUNDS has exactly the 15 current fylker, each box well formed
 *       and inside NORWAY_BBOX.
 *   (b) a known point in every fylke lies in that fylke's box.
 *   (c) the live repro (review B1): the three Sande i Vestfold producers lie
 *       outside Møre og Romsdal's box; Mølstad Gård (Nes på Hedmark) and
 *       Furuset Tunet (Nes i Ådal) outside Akershus's box; Rånås Gård (Auli,
 *       Nes) inside it; a "Hamar" producer whose coordinate is in Rana outside
 *       Innlandet's box.
 *   (d) the boxes are coarse: an Oslo point lies in Akershus's box too, and
 *       Åmot in Modum lies in Innlandet's box, which is why a shared name
 *       uses the kommune's own box.
 *   (e) SHARED_KOMMUNE_BOUNDS: every name is a current kommune in the SSB
 *       table, its box lies inside that fylke's box, the lookup folds case
 *       and æøå, and other names get no box.
 *   (f) inBounds(): edges included, no box or NaN -> false.
 *
 * Run standalone: npx tsx src/services/fylke-bounds.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

import { FYLKE_BOUNDS, SHARED_KOMMUNE_BOUNDS, inBounds, sharedKommuneNameBounds } from "./fylke-bounds";
import { __FYLKE_INTERNAL } from "./norway-fylke";
import { resolveFylke2024 } from "./fylke-2024-migration";
import { NORWAY_BBOX } from "./geo-distance";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runFylkeBoundsTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  const inFylke = (fylke: string, lat: number, lon: number) => inBounds(FYLKE_BOUNDS[fylke], lat, lon);

  // ── (a) the table ───────────────────────────────────────────────────────
  assertEq(Object.keys(FYLKE_BOUNDS).sort(), [...__FYLKE_INTERNAL.CANONICAL_FYLKER].sort(), "a: one box per current fylke, no more");
  for (const [fylke, b] of Object.entries(FYLKE_BOUNDS)) {
    assertTrue(b.minLat < b.maxLat && b.minLon < b.maxLon, `a: ${fylke} box is well formed`);
    assertTrue(
      b.minLat >= NORWAY_BBOX.minLat && b.maxLat <= NORWAY_BBOX.maxLat && b.minLon >= NORWAY_BBOX.minLon && b.maxLon <= NORWAY_BBOX.maxLon,
      `a: ${fylke} box lies inside NORWAY_BBOX`,
    );
  }

  // ── (b) a known point per fylke ─────────────────────────────────────────
  const known: Array<[string, string, number, number]> = [
    ["Oslo", "Oslo sentrum", 59.913, 10.739],
    ["Rogaland", "Stavanger", 58.97, 5.733],
    ["Møre og Romsdal", "Ålesund", 62.472, 6.155],
    ["Nordland", "Bodø", 67.28, 14.405],
    ["Østfold", "Fredrikstad", 59.22, 10.93],
    ["Akershus", "Lillestrøm", 59.956, 11.05],
    ["Buskerud", "Drammen", 59.744, 10.204],
    ["Innlandet", "Hamar", 60.795, 11.068],
    ["Vestfold", "Tønsberg", 59.267, 10.408],
    ["Telemark", "Skien", 59.209, 9.609],
    ["Agder", "Kristiansand", 58.146, 7.996],
    ["Vestland", "Bergen", 60.391, 5.322],
    ["Trøndelag", "Trondheim", 63.43, 10.395],
    ["Troms", "Tromsø", 69.649, 18.956],
    ["Finnmark", "Alta", 69.969, 23.272],
  ];
  for (const [fylke, place, lat, lon] of known) {
    assertTrue(inFylke(fylke, lat, lon), `b: ${place} lies in ${fylke}'s box`);
  }

  // ── (c) live repro (review B1 on lokal#1109) ────────────────────────────
  const sandeIVestfold: Array<[string, number, number]> = [
    ["Gran Søndre", 59.60360552016277, 10.229273400361958],
    ["Granstad Gård", 59.5934, 10.2026],
    ["Flåtan Søndre Gårdsbutikk", 59.49, 10.17],
  ];
  for (const [name, lat, lon] of sandeIVestfold) {
    assertTrue(!inFylke("Møre og Romsdal", lat, lon), `c: ${name} (Sande i Vestfold) lies outside Møre og Romsdal's box`);
    assertTrue(inFylke("Vestfold", lat, lon), `c: ${name} lies in Vestfold's box`);
  }
  assertTrue(!inFylke("Akershus", 60.92741454507553, 10.709622024825517), "c: Mølstad Gård (Nes på Hedmark) lies outside Akershus's box");
  assertTrue(!inFylke("Akershus", 60.56348, 9.98776), "c: Furuset Tunet (Nes i Ådal) lies outside Akershus's box");
  assertTrue(inFylke("Akershus", 60.04679965585512, 11.33372745180509), "c: Rånås Gård (Auli, Nes) lies in Akershus's box");
  assertTrue(!inFylke("Innlandet", 66.3173418944786, 14.145752939955319), "c: a \"Hamar\" producer with its coordinate in Rana lies outside Innlandet's box");

  // ── (d) coarse by design ────────────────────────────────────────────────
  assertTrue(inFylke("Akershus", 59.913, 10.739), "d: Oslo lies inside Akershus's box too (boxes overlap)");
  assertTrue(inFylke("Innlandet", 59.9478998491016, 9.800437734468055), "d: Åmot in Modum (Buskerud) lies inside Innlandet's box");
  assertTrue(!inBounds(sharedKommuneNameBounds("Åmot"), 59.9478998491016, 9.800437734468055), "d: ... but outside the box of the kommune Åmot");

  // ── (e) shared kommune names ────────────────────────────────────────────
  assertEq(SHARED_KOMMUNE_BOUNDS.map((e) => e.name), ["Nes", "Sande", "Hemnes", "Osen", "Åmot"], "e: the shared names found live");
  for (const { name, bounds } of SHARED_KOMMUNE_BOUNDS) {
    const r = resolveFylke2024({ kommune: name });
    const fylke = "fylke" in r ? r.fylke : null;
    assertTrue(!!fylke, `e: ${name} is a current kommune in the SSB table`);
    const fb = fylke ? FYLKE_BOUNDS[fylke] : undefined;
    assertTrue(
      !!fb && bounds.minLat < bounds.maxLat && bounds.minLon < bounds.maxLon &&
        bounds.minLat >= fb.minLat && bounds.maxLat <= fb.maxLat && bounds.minLon >= fb.minLon && bounds.maxLon <= fb.maxLon,
      `e: ${name}'s box is well formed and lies inside ${fylke}'s box`,
    );
    assertEq(sharedKommuneNameBounds(name), bounds, `e: lookup by "${name}"`);
  }
  assertEq(sharedKommuneNameBounds("NES"), sharedKommuneNameBounds("Nes"), "e: lookup ignores case");
  assertEq(sharedKommuneNameBounds("Amot"), sharedKommuneNameBounds("Åmot"), "e: lookup folds å");
  for (const other of ["Bergen", "Nesodden", "Sandefjord", "Hamar", "", "Nes på Hedmark"]) {
    assertEq(sharedKommuneNameBounds(other), undefined, `e: "${other}" has no shared-name box`);
  }
  assertTrue(inBounds(sharedKommuneNameBounds("Nes"), 60.04679965585512, 11.33372745180509), "e: Rånås Gård lies in Nes kommune's box");
  assertTrue(!inBounds(sharedKommuneNameBounds("Sande"), 59.5934, 10.2026), "e: Granstad Gård (Sande i Vestfold) lies outside Sande kommune's box");

  // ── (f) inBounds ────────────────────────────────────────────────────────
  const box = { minLat: 60, maxLat: 61, minLon: 10, maxLon: 11 };
  assertTrue(inBounds(box, 60, 10) && inBounds(box, 61, 11), "f: edges are inside");
  assertTrue(!inBounds(box, 59.999, 10.5) && !inBounds(box, 60.5, 11.001), "f: just past an edge is outside");
  assertTrue(!inBounds(undefined, 60.5, 10.5), "f: no box -> false");
  assertTrue(!inBounds(box, Number.NaN, 10.5) && !inBounds(box, 60.5, Number.NaN), "f: NaN -> false");

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── fylke-bounds: coordinate veto for fylke placement (dev-request 2026-10-17-integrasjonstest-oppfolging, I-E) ──");
  const r = runFylkeBoundsTests({ log: true });
  console.log(`\nfylke-bounds: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
