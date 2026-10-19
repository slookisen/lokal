/**
 * places-display-policy.test.ts — dev-request
 * 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt,
 * slice A4 (Daniel's question 21 = A, 2026-10-18T17:01Z).
 *
 * Pure unit tests (no DB, no network) for src/services/places-display-policy.ts:
 *   P  fieldProvenanceRecords reads a list, one record, {sources: [...]} and
 *      a JSON string; keeps records with a source_type and a text value;
 *      reads every key it is given; junk gives nothing.
 *   C  canonicalOpeningHours: order, "8:00"/"08:00", day names, a JSON
 *      string and the stored array are the same hours; other hours are not;
 *      nothing usable is null.
 *   R  placesFieldVerdict, per field: Places evidence (exact value) without
 *      corroboration -> places_only; a normalised-only Places match is not
 *      evidence (a Brreg phone Places repeated stays); corroboration by another
 *      real source (phonesMatch, addressesMatch, host name, canonical hours)
 *      or an owner signal -> shown; an inference source does not corroborate;
 *      marked wrong -> marked_wrong; no provenance or an empty value -> shown;
 *      source_type heads ("google_places:…", case).
 *   K  the kill switch: PLACES_DISPLAY_POLICY_ENABLED is true, the override
 *      reaches the default, off shows everything, null restores.
 *   S  the module imports no DB or network code.
 * The dental surfaces are covered by src/routes/dental-places-visning.test.ts.
 *
 * Exported runPlacesDisplayPolicyTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/places-display-policy.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  PLACES_DISPLAY_POLICY_ENABLED,
  PLACES_SOURCE_TYPE,
  __setPlacesDisplayPolicyForTesting,
  placesDisplayPolicyEnabled,
  fieldProvenanceRecords,
  canonicalOpeningHours,
  placesFieldVerdict,
  type PlacesFieldInput,
} from "./places-display-policy";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const gp = (value: string) => ({ source_type: PLACES_SOURCE_TYPE, value, fetched_at: "2026-09-01T00:00:00Z" });
const src = (source_type: string, value: string) => ({ source_type, value, fetched_at: "2026-09-01T00:00:00Z" });

export function runPlacesDisplayPolicyTests(opts: { log?: boolean } = {}): TestSummary {
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
  const verdict = (input: Omit<PlacesFieldInput, "records"> & { records?: PlacesFieldInput["records"] }) =>
    placesFieldVerdict({ records: [], ...input });

  try {
    // ── P: reading field_provenance ─────────────────────────────────────
    const rec = (st: string, value: string) => ({ source_type: st, value });
    assertEq(fieldProvenanceRecords({ phone: [gp("+4722110011"), src("homepage", "22 11 00 11")] }, ["phone"]),
      [rec("google_places", "+4722110011"), rec("homepage", "22 11 00 11")], "P1: a list of records");
    assertEq(fieldProvenanceRecords({ hjemmeside: src("brreg_registered_website", "https://a.no") }, ["hjemmeside"]),
      [rec("brreg_registered_website", "https://a.no")], "P2: one record (hjemmeside discovery's shape)");
    assertEq(fieldProvenanceRecords({ address: { sources: [src("brreg", "Storgata 1")] } }, ["address"]),
      [rec("brreg", "Storgata 1")], "P3: {sources: [...]} (the shape the Places batch sends to mergeFieldProvenance)");
    assertEq(fieldProvenanceRecords(JSON.stringify({ phone: [gp("+4722110011")] }), ["phone"]),
      [rec("google_places", "+4722110011")], "P4: the whole value as a JSON string (as stored)");
    for (const junk of [null, undefined, "", "not json", "[1,2]", [gp("x")], 42, { phone: "text" }, { phone: null }]) {
      assertEq(fieldProvenanceRecords(junk, ["phone"]), [], `P5: junk ${JSON.stringify(junk)} -> no records`);
    }
    assertEq(
      fieldProvenanceRecords({ phone: [{ source_type: "google_places" }, { value: "1" }, { source_type: " ", value: "1" }, { source_type: "brreg", value: 1 }, null, "x", gp("+4722")] }, ["phone"]),
      [rec("google_places", "+4722")],
      "P6: records without a source_type or a text value are left out"
    );
    assertEq(fieldProvenanceRecords({ address: [gp("A 1")], adresse: [src("homepage", "A 1")], phone: [gp("p")] }, ["address", "adresse"]),
      [rec("google_places", "A 1"), rec("homepage", "A 1")], "P7: every key given is read, others are not");

    // ── C: canonical opening hours ──────────────────────────────────────
    const monTue = [{ day: "mon", open: "08:00", close: "16:00" }, { day: "tue", open: "08:00", close: "16:00" }];
    const c = canonicalOpeningHours(monTue);
    assertEq(c !== null, true, "C0: stored hours have a canonical form");
    assertEq(canonicalOpeningHours([...monTue].reverse()), c, "C1: entry order does not matter");
    assertEq(canonicalOpeningHours([{ day: "mon", open: "8:00", close: "16:00" }, { day: "tue", open: "08.00", close: "16" }]), c, "C2: 8:00 / 08.00 / 16 are 08:00 / 16:00");
    assertEq(canonicalOpeningHours(JSON.stringify(monTue)), c, "C3: the JSON string (Places' provenance value) is the stored array");
    assertEq(canonicalOpeningHours([{ day: "Mandag", open: "08:00", close: "16:00" }, { day: "tirsdag", open: "08:00", close: "16:00" }]), c, "C4: day names (Mandag/mon) are the same day");
    assertEq(canonicalOpeningHours([{ day: "mon", open: "08:00", close: "15:00" }, { day: "tue", open: "08:00", close: "16:00" }]) === c, false, "C5: other hours differ");
    assertEq(canonicalOpeningHours([{ day: "mon", open: "08:00", close: "16:00" }]) === c, false, "C6: fewer days differ");
    for (const empty of [null, undefined, [], "", "[]", {}, [{ day: "mon" }], "[not json"]) {
      const out = canonicalOpeningHours(empty);
      if (empty === "[not json") assertEq(typeof out, "string", "C7: text that is not JSON is read as text (one text entry)");
      else assertEq(out, null, `C7: ${JSON.stringify(empty)} -> null`);
    }

    // ── R: the verdict ──────────────────────────────────────────────────
    // phone
    assertEq(verdict({ field: "phone", value: "+4722110011", records: [gp("+4722110011")] }), "places_only", "R1: phone only Places gives (exact) -> places_only");
    assertEq(verdict({ field: "phone", value: " +4722110011 ", records: [gp("+4722110011 ")] }), "places_only", "R1b: ... surrounding blanks do not matter");
    assertEq(verdict({ field: "phone", value: "35 08 10 60", records: [gp("+4735081060")] }), "shown",
      "R2: a Brreg/1881 phone Places only repeated (normalised match, not exact) -> shown (no over-hiding of Phase A phones)");
    assertEq(verdict({ field: "phone", value: "+4722110011", records: [gp("+4722110011"), src("homepage", "22 11 00 11")] }), "shown",
      "R3: Places phone the clinic's site also gives (phonesMatch) -> shown");
    assertEq(verdict({ field: "phone", value: "+4722110011", records: [gp("+4722110011"), src("homepage", "22 11 00 12")] }), "places_only",
      "R4: ... another number on the site does not corroborate");
    assertEq(verdict({ field: "phone", value: "+4722110011", records: [gp("+4722110011"), src("web_search:gulesider.no", "22 11 00 11")] }), "places_only",
      "R5: an inference source (web_search) does not corroborate");
    assertEq(verdict({ field: "phone", value: "+4722110011", records: [gp("+4722110011"), gp("22 11 00 11")] }), "places_only",
      "R5b: a second Places record does not corroborate");
    assertEq(verdict({ field: "phone", value: "+4722110011", records: [gp("+4722110011")], ownerConfirmed: true }), "shown", "R6: an owner signal corroborates");
    assertEq(verdict({ field: "phone", value: "+4722110011" }), "shown", "R7: no provenance -> shown (interpretation A)");
    assertEq(verdict({ field: "phone", value: "+4722110011", records: [src("homepage", "+4722110011")] }), "shown", "R7b: only another source -> shown");
    // address
    const placesAddr = "Storgata 1, 0150 Oslo, Norge";
    assertEq(verdict({ field: "address", value: placesAddr, records: [gp(placesAddr)] }), "places_only", "R8: Places formattedAddress -> places_only");
    assertEq(verdict({ field: "address", value: placesAddr, records: [gp(placesAddr), src("brreg", "Storgata 1")] }), "shown",
      "R9: ... Brreg gives the same street (addressesMatch) -> shown");
    assertEq(verdict({ field: "address", value: placesAddr, records: [gp(placesAddr), src("brreg", "Storgata 10")] }), "places_only",
      "R10: ... another house number does not corroborate");
    assertEq(verdict({ field: "address", value: placesAddr, records: [gp(placesAddr), src("brreg", "Storgata 1, 5003 Bergen")] }), "places_only",
      "R10b: ... the same street in another postnummer does not corroborate");
    assertEq(verdict({ field: "address", value: "Storgata 1", records: [gp(placesAddr)] }), "shown",
      "R11: a stored street that is not Places' exact value -> shown");
    // website
    const site = "https://www.placestann.no/klinikk/oslo";
    assertEq(verdict({ field: "website", value: site, records: [gp(site)] }), "places_only", "R12: Places websiteUri -> places_only (Daniel 17:01Z: websites too)");
    assertEq(verdict({ field: "website", value: site, records: [gp(site), src("brreg_registered_website", "http://placestann.no")] }), "shown",
      "R13: ... the website Brreg registers on the same host -> shown");
    assertEq(verdict({ field: "website", value: site, records: [gp(site), src("brreg_registered_website", "https://annen.no")] }), "places_only",
      "R14: ... another host does not corroborate");
    // opening hours
    const placesHours = JSON.stringify([{ day: "mon", open: "08:00", close: "16:00" }, { day: "tue", open: "08:00", close: "16:00" }]);
    const stored = [{ day: "mon", open: "08:00", close: "16:00" }, { day: "tue", open: "08:00", close: "16:00" }];
    assertEq(verdict({ field: "opening_hours", value: stored, records: [gp(placesHours)] }), "places_only", "R15: Places hours (canonical JSON) -> places_only");
    assertEq(verdict({ field: "opening_hours", value: stored, records: [gp(placesHours), src("own_homepage", JSON.stringify([...stored].reverse()))] }), "shown",
      "R16: ... the clinic's site gives the same hours in another order -> shown");
    assertEq(verdict({ field: "opening_hours", value: stored, records: [gp(placesHours), src("stage_v_correction", JSON.stringify([stored[0]]))] }), "places_only",
      "R17: ... other hours do not corroborate");
    assertEq(verdict({ field: "opening_hours", value: [stored[0]], records: [gp(placesHours)] }), "shown", "R18: stored hours that are not Places' -> shown");
    // marked wrong, empty, source heads
    assertEq(verdict({ field: "opening_hours", value: stored, records: [src("own_homepage", JSON.stringify(stored))], markedWrong: true }), "marked_wrong",
      "R19: marked wrong -> marked_wrong, whatever the source");
    assertEq(verdict({ field: "phone", value: "+4722110011", records: [gp("+4722110011"), src("homepage", "22110011")], markedWrong: true }), "marked_wrong",
      "R19b: ... corroboration does not override it");
    for (const empty of [null, undefined, "", "  ", []]) {
      assertEq(verdict({ field: "phone", value: empty, records: [gp("+4722110011")], markedWrong: true }), "shown", `R20: empty value ${JSON.stringify(empty)} -> shown (nothing to hide)`);
    }
    assertEq(verdict({ field: "phone", value: "+4722110011", records: [src("Google_Places:2026-09-01", "+4722110011")] }), "places_only", "R21: the source_type head is read case-insensitively");
    assertEq(verdict({ field: "phone", value: "+4722110011", records: [gp("+4722110011"), src("own_homepage:2026-07-19", "22110011")] }), "shown", "R22: own_homepage:<date> corroborates");

    // ── K: kill switch ──────────────────────────────────────────────────
    assertEq(PLACES_DISPLAY_POLICY_ENABLED, true, "K1: PLACES_DISPLAY_POLICY_ENABLED is true");
    assertEq(placesDisplayPolicyEnabled(), true, "K2: the reader gives the constant by default");
    assertEq(placesFieldVerdict({ field: "phone", value: "+4722110011", records: [gp("+4722110011")] }, false), "shown", "K3: off -> a Places-only value is shown");
    assertEq(placesFieldVerdict({ field: "phone", value: "+4722110011", records: [], markedWrong: true }, false), "shown", "K4: off -> a marked value is shown");
    __setPlacesDisplayPolicyForTesting(false);
    assertEq([placesDisplayPolicyEnabled(), verdict({ field: "phone", value: "+4722110011", records: [gp("+4722110011")] })], [false, "shown"],
      "K5: the override reaches the default argument");
    __setPlacesDisplayPolicyForTesting(null);
    assertEq([placesDisplayPolicyEnabled(), verdict({ field: "phone", value: "+4722110011", records: [gp("+4722110011")] })], [true, "places_only"],
      "K6: null restores the constant");

    // ── S: pure ─────────────────────────────────────────────────────────
    const source = fs.readFileSync(path.join(__dirname, "places-display-policy.ts"), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    assertEq(imports.filter((i) => /database|db-factory|fetch|http|express/.test(i!)), [], "S1: no DB, HTTP or route import");
  } catch (err) {
    failed++;
    failures.push(`places-display-policy: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    __setPlacesDisplayPolicyForTesting(null);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── places-display-policy (dev-request 2026-10-16, A4) unit tests ──");
  const r = runPlacesDisplayPolicyTests({ log: true });
  console.log(`\nplaces-display-policy: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
}
