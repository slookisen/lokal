/**
 * norway-postnummer.test.ts — dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S1).
 *
 * The read-only postnummer -> kommune helper over the bundled Kartverket/
 * Geonorge file (src/data/postnummer-kommune-2026.json):
 *   P1-P4  resolveKommuneFromPostnummer: Bærum, Oslo, Bergen, Tromsø; unknown
 *          or malformed input is needs_review, never a guess.
 *   P5     postnumreForKommune is the exact inverse, sorted.
 *   P6     every row is well-formed and every kommunenummer exists in the 2024
 *          kommune table (kommune-fylke-2024.json) — fails on a stale file.
 *   P7     meta names source, licence, fetched_at and kommune basis.
 *   P8     the file is read lazily, once — not at import time.
 *   P9     kommuner2024 / officialPoststedFylker feed the search gazetteer.
 *   P11    shownPostnummer: the placeholder "0000" and an empty value are
 *          never shown as a postnummer (dev-request 2026-10-17-dental-d3-
 *          rettelser, D3d).
 *
 * Standalone: npx tsx src/services/norway-postnummer.test.ts
 * Wired into tests/test.ts via runNorwayPostnummerTests().
 */

import * as path from "path";

// The real module object (not an import namespace), so the read counter in
// P8 sees the calls norway-postnummer.ts makes.
const fs = require("fs") as typeof import("fs");

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runNorwayPostnummerTests(opts: { log?: boolean } = {}): TestSummary {
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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  const modulePath = require.resolve("./norway-postnummer");
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([modulePath]);
  const realRead = fs.readFileSync;

  try {
    // ── P8: lazy, once ────────────────────────────────────────────────────
    const dataFile = path.join(__dirname, "..", "data", "postnummer-kommune-2026.json");
    let reads = 0;
    fs.readFileSync = function (p: any, ...rest: any[]) {
      if (String(p) === dataFile) reads++;
      return (realRead as any).call(fs, p, ...rest);
    } as typeof fs.readFileSync;
    const pn = require("./norway-postnummer") as typeof import("./norway-postnummer");
    assertEq(reads, 0, "P8a: importing the module does not read the data file");
    pn.resolveKommuneFromPostnummer("0150");
    pn.resolveKommuneFromPostnummer("5003");
    pn.postnumreForKommune("3201");
    assertEq(reads, 1, "P8b: the data file is read once, on first use");
    fs.readFileSync = realRead;

    // ── P1-P4: resolve ────────────────────────────────────────────────────
    assertEq(pn.resolveKommuneFromPostnummer("0150"), { kommunenummer: "0301", kommune: "Oslo", fylke: "Oslo" }, "P1a: 0150 -> Oslo kommune, Oslo fylke");
    assertEq(pn.resolveKommuneFromPostnummer("1337"), { kommunenummer: "3201", kommune: "Bærum", fylke: "Akershus" }, "P1b: 1337 (Sandvika) -> Bærum, Akershus");
    const baerumRange: string[] = [];
    for (let n = 1300; n <= 1369; n++) {
      const r = pn.resolveKommuneFromPostnummer(String(n));
      if ("kommunenummer" in r) {
        baerumRange.push(String(n));
        assertEq(r.kommune, "Bærum", `P1c: ${n} -> Bærum`);
      } else {
        assertTrue(r.needs_review.startsWith("postnummer_not_found:"), `P1d: ${n} not in the open dataset -> needs_review (${r.needs_review})`);
      }
    }
    assertTrue(baerumRange.length >= 25, `P1e: the 1300-1369 range resolves to Bærum for the street-address numbers (got ${baerumRange.length})`);
    assertEq(pn.resolveKommuneFromPostnummer("1300"), { needs_review: "postnummer_not_found:1300" }, "P1f: 1300 (postbox-only, not in the open dataset) -> needs_review, no guess");
    assertEq(pn.resolveKommuneFromPostnummer("5003"), { kommunenummer: "4601", kommune: "Bergen", fylke: "Vestland" }, "P2: 5003 -> Bergen, Vestland");
    assertEq(pn.resolveKommuneFromPostnummer("9008"), { kommunenummer: "5501", kommune: "Tromsø", fylke: "Troms" }, "P3: 9008 -> Tromsø, Troms (2024 split)");
    assertEq(pn.resolveKommuneFromPostnummer(" 0150 "), pn.resolveKommuneFromPostnummer("0150"), "P3b: surrounding whitespace is ignored");
    assertEq(pn.resolveKommuneFromPostnummer("0001"), { needs_review: "postnummer_not_found:0001" }, "P4a: unknown postnummer -> needs_review");
    assertEq(pn.resolveKommuneFromPostnummer("9170"), { needs_review: "postnummer_not_found:9170" }, "P4b: Longyearbyen (Svalbard, no kommune in the 2024 table) -> needs_review");
    for (const bad of ["", "123", "12345", "12a4", "abcd"]) {
      assertEq(pn.resolveKommuneFromPostnummer(bad), { needs_review: `postnummer_invalid:${bad}` }, `P4c: malformed '${bad}' -> needs_review`);
    }
    assertEq(pn.resolveKommuneFromPostnummer(undefined as any), { needs_review: "postnummer_invalid:" }, "P4d: non-string input -> needs_review");

    // ── P5: inverse ───────────────────────────────────────────────────────
    const baerum = pn.postnumreForKommune("3201");
    assertEq(baerum, [...baerum].sort(), "P5a: postnumreForKommune is sorted");
    assertEq(baerum, baerumRange, "P5b: Bærum's postnumre are exactly the ones resolving to Bærum in 1300-1369");
    assertTrue(baerum.every((p) => {
      const r = pn.resolveKommuneFromPostnummer(p);
      return "kommunenummer" in r && r.kommunenummer === "3201";
    }), "P5c: every postnummer of a kommune resolves back to it");
    assertEq(pn.postnumreForKommune("9999"), [], "P5d: unknown kommunenummer -> []");
    const copy = pn.postnumreForKommune("3201");
    copy.push("0000");
    assertEq(pn.postnumreForKommune("3201"), baerum, "P5e: callers get a copy, the index is not mutable");

    // ── P6: file integrity against the 2024 kommune table ────────────────
    const file = JSON.parse(realRead.call(fs, dataFile, "utf-8") as string);
    const rows: Array<{ postnummer: string; poststed: string; kommunenummer: string }> = file.rows;
    const { isKnownKommunenummer } = require("./fylke-2024-migration") as typeof import("./fylke-2024-migration");
    const unknownKommune = [...new Set(rows.map((r) => r.kommunenummer))].filter((k) => !isKnownKommunenummer(k));
    assertEq(unknownKommune, [], "P6a: every kommunenummer in the file exists in kommune-fylke-2024.json");
    assertTrue(rows.every((r) => /^\d{4}$/.test(r.postnummer) && /^\d{4}$/.test(r.kommunenummer) && r.poststed.length > 0), "P6b: every row has a 4-digit postnummer, a 4-digit kommunenummer and a poststed");
    assertEq(new Set(rows.map((r) => r.postnummer)).size, rows.length, "P6c: one row per postnummer");
    assertTrue(rows.length >= 3300 && rows.length <= 5200, `P6d: row count is plausible for Norway (${rows.length})`);
    assertTrue(realRead.call(fs, dataFile).length < 300_000, "P6e: the file stays small (< 300 KB)");

    // ── P7: provenance ────────────────────────────────────────────────────
    const meta = pn.postnummerDatasetMeta();
    assertTrue(!!meta && /Kartverket/.test(meta.source), "P7a: meta.source names Kartverket");
    assertEq(meta?.license, "CC BY 4.0", "P7b: meta.license is CC BY 4.0");
    assertTrue(!!meta && /^\d{4}-\d{2}-\d{2}$/.test(meta.fetched_at), "P7c: meta.fetched_at is a date");
    assertEq(meta?.kommune_basis, "2024", "P7d: meta.kommune_basis is 2024");
    assertEq(meta?.row_count, rows.length, "P7e: meta.row_count matches the rows");

    // ── P9: gazetteer inputs ──────────────────────────────────────────────
    const kommuner = pn.kommuner2024();
    assertTrue(kommuner.some((k) => k.kommunenummer === "3201" && k.kommune === "Bærum"), "P9a: kommuner2024 lists Bærum");
    assertEq(kommuner.filter((k) => k.kommune === "Herøy").length, 2, "P9b: both Herøy kommuner are listed under their display name");
    assertTrue(!kommuner.some((k) => /\(/.test(k.kommune)), "P9c: display names carry no ' (<fylke>)' disambiguator");
    const officialFylker = pn.officialPoststedFylker();
    const official = new Set(officialFylker.keys());
    assertTrue(official.has("SANDVIKA") && official.has("OSLO") && official.has("MO I RANA"), "P9d: officialPoststedFylker has SANDVIKA, OSLO, MO I RANA");
    assertTrue(!official.has("BÆRUM") && !official.has("KRISTIANSAND"), "P9e: a kommune name that is not a poststed is not listed");
    assertEq([officialFylker.get("BERGEN"), officialFylker.get("SANDVIKA"), officialFylker.get("TROMSØ")], [["Vestland"], ["Akershus"], ["Troms"]], "P9f: each poststed carries the fylke its postnumre lie in");
    assertTrue([...officialFylker.values()].every((f) => f.length >= 1), "P9g: every official poststed has at least one fylke");
    assertTrue(pn.officialPoststedFylker() === officialFylker, "P9h: computed once");

    // ── P11: shownPostnummer (D3d) ────────────────────────────────────────
    assertEq(
      ["0000", " 0000 ", "", "   ", null, undefined].map((v) => pn.shownPostnummer(v)),
      [null, null, null, null, null, null],
      "P11a: the placeholder 0000 (also padded), an empty value, null and undefined -> null"
    );
    assertEq(["3340", "0010", "0001", "5003"].map((v) => pn.shownPostnummer(v)), ["3340", "0010", "0001", "5003"], "P11b: a real postnummer is unchanged");
    assertEq(
      [pn.PLACEHOLDER_POSTNUMMER, pn.resolveKommuneFromPostnummer(pn.PLACEHOLDER_POSTNUMMER)],
      ["0000", { needs_review: "postnummer_not_found:0000" }],
      "P11c: the placeholder is 0000, and it is not in the register"
    );

    // ── test seam ─────────────────────────────────────────────────────────
    pn.__setPostnummerRowsForTesting([{ postnummer: "1234", poststed: "TESTSTED", kommunenummer: "0301" }]);
    assertEq(pn.resolveKommuneFromPostnummer("1234"), { kommunenummer: "0301", kommune: "Oslo", fylke: "Oslo" }, "P10a: injected rows are used");
    assertEq(pn.resolveKommuneFromPostnummer("0150"), { needs_review: "postnummer_not_found:0150" }, "P10b: only the injected rows are used");
    pn.__setPostnummerRowsForTesting(null);
    assertEq(pn.resolveKommuneFromPostnummer("0150").hasOwnProperty("kommunenummer"), true, "P10c: reset re-reads the bundled file");
  } catch (err: any) {
    failed++;
    failures.push("norway-postnummer: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    fs.readFileSync = realRead;
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runNorwayPostnummerTests({ log: true });
  console.log(`\nnorway-postnummer: ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed > 0 ? 1 : 0);
}
