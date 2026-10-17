/**
 * rfb-places-match-guard.test.ts — dev-request
 * 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt
 * (slookisen/A2A), slice S3: shared Places match guard.
 *
 * Before S3 both RFB rating routes wrote Google's FIRST Text Search candidate
 * (places[0]) onto the producer without checking it was the producer. That is
 * how Bergen Mathall got Mathallen Oslo's data and 16k-review rating
 * (2026-07-16). Now services/places-match.ts holds the guard dental has used
 * since PR-128 (name similarity + exact postal code, or a higher name bar +
 * exact town), and the RFB routes write only a confident candidate.
 *
 * Covers the dev-request's acceptance list:
 *   (a) the right place is written (rating, address, phone, provenance)
 *   (b) a same-named place in another kommune is rejected; nothing written
 *   (c) the right name with the wrong postal code is rejected
 *   (d) places[0] wrong and places[1] right → places[1] is written
 *   (e) a «Navn — Sted» producer name matches the place name without suffix
 *   (f) Bergen Mathall vs Mathallen Oslo is rejected; the stored rating stays
 *   (g) POST /admin/google-rating/:id is guarded the same way
 *   (h) the enrichment write pause still answers 423 before any Places call
 * plus: dental's isConfidentPlaceMatch is the shared rule unchanged (parity
 * matrix), the kill switch restores places[0], the three FieldMasks only
 * gained places.addressComponents, the Enterprise attempt is still recorded
 * on a mismatch (no new spend), no Brreg lookup on a mismatch, and the
 * "[places-match-guard]" log line.
 *
 * Review round 1 (PR #1090): the BEST-named confident candidate wins, not the
 * first ("Hov Gård" with [Nordre Hov Gård, Hov Gård] in one postal code took
 * Nordre's rating, address and phone); two differently named candidates that
 * nearly tie below 0.9 → place_mismatch "ambiguous"; the RFB-only
 * farm-qualifier veto (Nordre vs Søndre Hov Gård); the suffix strip and the
 * Text Search query stay linear on long runs of spaces and give the same
 * output as the old regexes.
 *
 * S4-A2 (same dev-request, Daniel's decision 2=A): Google's rating is no
 * longer fetched (places-match.ts GOOGLE_RATING_FETCH_ENABLED = false). The
 * S3 route scenarios run with that lever forced ON, its rollback position,
 * where they pin the S3 behaviour unchanged. The "S4-A2" sections run in the
 * production default (off): placesFieldMask and the lever's default; both
 * routes ask Google for no rating field and write or report no rating, a
 * stored rating stays untouched, address and phone still come only from a
 * confident candidate, the flag-less batch and the single route make no
 * Places call, and the write pause still answers 423 first.
 *
 * Harness: better-sqlite3 ":memory:" + __setDbForTesting/__initSchemaForTesting,
 * the real marketplace router driven through router.handle() with a fake
 * req/res, globalThis.fetch and console.warn stubbed (restored in finally).
 *
 * Exported runRfbPlacesMatchGuardTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-places-match-guard.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "POST",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
      else resolve({ status: 404, body: { error: "no route" } });
    });
  });
}

// ─── Places fixtures ───────────────────────────────────────────────────
function place(
  name: string,
  postal: string,
  town: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    displayName: { text: name, languageCode: "no" },
    addressComponents: [
      { longText: postal, shortText: postal, types: ["postal_code"] },
      { longText: town, shortText: town, types: ["postal_town"] },
    ],
    ...extra,
  };
}

const HAUGEN_SKI = place("Haugen Gård", "1400", "Ski", {
  id: "place-haugen-ski",
  rating: 4.6,
  userRatingCount: 236,
  formattedAddress: "Haugenveien 5, 1400 Ski",
  internationalPhoneNumber: "+47 64 87 00 00",
});
const HAUGEN_OPPDAL = place("Haugen Gård", "7340", "Oppdal", {
  id: "place-haugen-oppdal",
  rating: 4.9,
  userRatingCount: 51,
  formattedAddress: "Haugen, 7340 Oppdal",
  internationalPhoneNumber: "+47 72 40 00 00",
});
const HAUGEN_SKI_1401 = place("Haugen Gård", "1401", "Ski", {
  id: "place-haugen-1401",
  rating: 4.1,
  userRatingCount: 12,
  formattedAddress: "Haugenveien 5, 1401 Ski",
});
const MATHALLEN_OSLO = place("Mathallen Oslo", "0178", "Oslo", {
  id: "place-mathallen-oslo",
  rating: 4.5,
  userRatingCount: 16000,
  formattedAddress: "Vulkan 5, 0178 Oslo",
  internationalPhoneNumber: "+47 40 00 12 09",
});
const BERGEN_MATHALL = place("Bergen Mathall", "5013", "Bergen", {
  id: "place-bergen-mathall",
  rating: 4.2,
  userRatingCount: 900,
  formattedAddress: "Strandkaien 3, 5013 Bergen",
  internationalPhoneNumber: "+47 55 00 00 00",
});
const ASK_RINGSAKER = place("Ask", "2380", "Brumunddal", {
  id: "place-ask",
  rating: 4.7,
  userRatingCount: 33,
  formattedAddress: "Askvegen 2, 2380 Brumunddal",
});
// Review round 1 (B1): three farms in one postal code. For a producer "Hov
// Gård", Nordre/Søndre Hov Gård score 0.67 each — over the 0.55 bar.
const NORDRE_HOV = place("Nordre Hov Gård", "2335", "Stange", {
  id: "place-nordre-hov",
  rating: 4.9,
  userRatingCount: 812,
  formattedAddress: "Hovsvegen 10, 2335 Stange",
  internationalPhoneNumber: "+47 11 11 11 11",
});
const SONDRE_HOV = place("Søndre Hov Gård", "2335", "Stange", {
  id: "place-sondre-hov",
  rating: 4.8,
  userRatingCount: 97,
  formattedAddress: "Hovsvegen 30, 2335 Stange",
  internationalPhoneNumber: "+47 22 22 22 22",
});
const HOV = place("Hov Gård", "2335", "Stange", {
  id: "place-hov",
  rating: 4.3,
  userRatingCount: 14,
  formattedAddress: "Hovsvegen 20, 2335 Stange",
  internationalPhoneNumber: "+47 33 33 33 33",
});

// Pre-S3 FieldMasks, verbatim — the new masks must equal these plus
// places.addressComponents (a Pro-tier field: no SKU change).
const OLD_MASKS = {
  batchEnterpriseAddrPhone:
    "places.id,places.rating,places.userRatingCount,places.displayName,places.formattedAddress,places.internationalPhoneNumber",
  batchEnterprise: "places.rating,places.userRatingCount,places.displayName",
  batchPro: "places.id,places.displayName,places.formattedAddress",
  single: "places.rating,places.userRatingCount,places.displayName,places.formattedAddress",
};

function maskFields(mask: string | undefined): string[] {
  return (mask || "").split(",").map((f) => f.trim()).filter(Boolean).sort();
}

// Verbatim copy of dental-places.ts's isConfidentPlaceMatch BEFORE S3 moved
// the rule to places-match.ts — the reference for the dental parity check
// (U03). Do not "fix" it: it pins dental's behaviour as it was.
function legacyDentalIsConfidentPlaceMatch(
  clinic: { navn: string; postnummer?: string | null; poststed?: string | null },
  place: any,
): boolean {
  const { nameSimilarity } = require("../services/name-matcher") as typeof import("../services/name-matcher");
  const componentByType = (pl: any, t: string): any => {
    const comps = Array.isArray(pl.addressComponents) ? pl.addressComponents : [];
    return comps.find((c: any) => Array.isArray(c?.types) && c.types!.includes(t));
  };
  if (!place) return false;
  const placeName = place.displayName?.text ?? "";
  const sim = nameSimilarity(clinic.navn ?? "", placeName);
  if (sim < 0.55) return false;
  const postnummer = (clinic.postnummer ?? "").toString().trim();
  if (postnummer) {
    const pc = componentByType(place, "postal_code");
    const pcVal = ((pc?.longText ?? pc?.shortText ?? "") as string).trim();
    return pcVal !== "" && pcVal === postnummer;
  }
  if (sim < 0.65) return false;
  const poststed = (clinic.poststed ?? "").toString().trim().toLowerCase();
  if (!poststed) return false;
  const loc = componentByType(place, "postal_town") ?? componentByType(place, "locality");
  const locVal = ((loc?.longText ?? loc?.shortText ?? "") as string).trim().toLowerCase();
  return locVal !== "" && locVal === poststed;
}

export async function runRfbPlacesMatchGuardTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ═════════════════════════════════════════════════════════════════════
  // Pure: services/places-match.ts
  // ═════════════════════════════════════════════════════════════════════
  const pm = require("../services/places-match") as typeof import("../services/places-match");
  const dental = require("../services/dental-places") as typeof import("../services/dental-places");
  const { nameSimilarity, nameVariants } = require("../services/name-matcher") as typeof import("../services/name-matcher");

  // ── Dental parity: the wrapper behaves exactly as before S3 ────────────
  assertEq([dental.NAME_SIM_THRESHOLD, dental.NAME_SIM_THRESHOLD_POSTSTED_ONLY], [0.55, 0.65],
    "U01: dental-places still exports the PR-128 thresholds (0.55 / 0.65)");
  assertEq([pm.NAME_SIM_THRESHOLD, pm.NAME_SIM_THRESHOLD_POSTSTED_ONLY], [0.55, 0.65],
    "U02: places-match holds the same thresholds");
  {
    const clinics = [
      { navn: "Tannlege Oslo Sentrum AS", postnummer: "0155", poststed: "OSLO" },
      { navn: "Tannlege Oslo Sentrum AS", postnummer: null, poststed: "Oslo" },
      { navn: "Tannlege Oslo Sentrum AS", postnummer: "015", poststed: "OSLO" },
      { navn: "Tannlege Oslo Sentrum AS", postnummer: " 0155 ", poststed: null },
      { navn: "Oris Dental Storo", postnummer: "0484", poststed: "OSLO" },
      { navn: "Tannklinikk Mo AS", postnummer: null, poststed: "Mo" },
      { navn: "Tannklinikk Mo AS", postnummer: null, poststed: "Moss" },
      { navn: "Tannklinikk Mo AS", postnummer: "", poststed: "  moss " },
      { navn: "Bergen Kjeveortopedi Klinikk", postnummer: "0155", poststed: "OSLO" },
      { navn: "", postnummer: "0155", poststed: "OSLO" },
      { navn: "Tannlege Oslo Sentrum AS", postnummer: null, poststed: null },
    ];
    const places: any[] = [
      null,
      undefined,
      { displayName: { text: "Tannlege Oslo Sentrum AS" }, addressComponents: [
        { longText: "0155", types: ["postal_code"] }, { longText: "Oslo", types: ["postal_town"] }] },
      { displayName: { text: "Tannlege Oslo Sentrum" }, addressComponents: [
        { shortText: "0155", types: ["postal_code"] }, { longText: "Oslo", types: ["locality", "political"] }] },
      { displayName: { text: "Tannlege Oslo Sentrum AS" }, addressComponents: [{ longText: "5004", types: ["postal_code"] }] },
      { displayName: { text: "Oris Dental Lambertseter" }, addressComponents: [
        { longText: "1153", types: ["postal_code"] }, { longText: "Oslo", types: ["postal_town"] }] },
      { displayName: { text: "Tannklinikk Mo AS" }, addressComponents: [
        { longText: "1531", types: ["postal_code"] }, { longText: "Moss", types: ["postal_town"] }] },
      { displayName: { text: "Tannklinikk Mo AS" } },
      { addressComponents: [{ longText: "0155", types: ["postal_code"] }] },
      { displayName: { text: "Tannlege Oslo Sentrum AS" }, addressComponents: "junk" },
      { displayName: { text: "TANNLEGE OSLO SENTRUM" }, addressComponents: [
        { longText: " 0155 ", types: ["postal_code"] }, { longText: " OSLO ", types: ["locality"] }] },
      { displayName: { text: "Oris Dental Storo" }, addressComponents: [
        { longText: "0484", types: ["postal_code"] }, { shortText: "Oslo", types: ["postal_town"] }] },
    ];
    let same = 0;
    let trues = 0;
    let total = 0;
    for (const c of clinics) {
      for (const p of places) {
        total++;
        const before = legacyDentalIsConfidentPlaceMatch(c, p);
        const viaDental = dental.isConfidentPlaceMatch(c, p);
        const viaShared = pm.isConfidentPlaceMatch({ name: c.navn, postalCode: c.postnummer, postalTown: c.poststed }, p);
        if (viaDental === before && viaShared === before) same++;
        if (before) trues++;
      }
    }
    assertEq(same, total, `U03: dental wrapper and shared rule === the pre-S3 dental rule on all ${total} clinic×place pairs`);
    assertTrue(trues > 0 && trues < total, "U04: the parity matrix exercises both outcomes (not vacuous)");
  }

  // ── pickConfidentPlace ─────────────────────────────────────────────────
  const haugenSki = pm.rfbPlaceMatchEntity({ name: "Haugen Gård", postalCode: "1400", city: "Ski" });
  {
    const pick = pm.pickConfidentPlace(haugenSki, [HAUGEN_OPPDAL, HAUGEN_SKI] as any[]);
    assertEq([pick.index, (pick.place as any)?.id], [1, "place-haugen-ski"],
      "U05 (d): places[0] wrong kommune, places[1] right → picks places[1]");
    const first = pm.pickConfidentPlace(haugenSki, [HAUGEN_SKI, { ...HAUGEN_SKI, id: "dup" }] as any[]);
    assertEq((first.place as any)?.id, "place-haugen-ski", "U06: two confident candidates → Google's first wins");
    const none = pm.pickConfidentPlace(haugenSki, [MATHALLEN_OSLO, HAUGEN_OPPDAL] as any[]);
    assertEq([none.place, none.index, none.placeName, none.nameSim, none.reason], [null, -1, "Haugen Gård", 1, "no_confident_candidate"],
      "U07: no confident candidate → null; reports the best-named candidate for the log");
    const empty = pm.pickConfidentPlace(haugenSki, []);
    assertEq([empty.place, empty.index, empty.placeName, empty.nameSim, empty.reason], [null, -1, "", 0, "no_candidates"],
      "U08: no candidates → null, empty report");
    assertEq(pm.pickConfidentPlace(haugenSki, null).place, null, "U09: null candidate list → null");
    assertEq((pm.pickConfidentPlace(haugenSki, [null, undefined, HAUGEN_SKI] as any[]).place as any)?.id, "place-haugen-ski",
      "U10: null entries in the list are skipped");
    assertEq(pm.pickConfidentPlace(haugenSki, [HAUGEN_SKI] as any[]).reason, null, "U10b: a picked place has reason null");
  }

  // ── Review round 1, B1: the best-named confident candidate wins ────────
  {
    const hov = pm.rfbPlaceMatchEntity({ name: "Hov Gård", postalCode: "2335", city: "Stange" });
    const nordreSim = pm.placeNameSimilarity(hov, "Nordre Hov Gård");
    assertTrue(nordreSim >= pm.NAME_SIM_THRESHOLD && nordreSim < pm.PICK_CLEAR_NAME_SIM && pm.isConfidentPlaceMatch(hov, NORDRE_HOV as any),
      "U41: 'Nordre Hov Gård' passes the shared rule on its own for producer 'Hov Gård' (0.67, same postal code) — the B1 setup");
    const b1 = pm.pickConfidentPlace(hov, [NORDRE_HOV, HOV] as any[]);
    assertEq([b1.index, (b1.place as any)?.id, b1.nameSim, b1.reason], [1, "place-hov", 1, null],
      "U42 (B1): [near-namesake, exact] in one postal code → the exact match at index 1, not places[0]");
    const b1r = pm.pickConfidentPlace(hov, [HOV, NORDRE_HOV] as any[]);
    assertEq([b1r.index, (b1r.place as any)?.id], [0, "place-hov"], "U43: [exact, near-namesake] → the exact match at index 0");
    const tie = pm.pickConfidentPlace(hov, [NORDRE_HOV, SONDRE_HOV] as any[]);
    assertEq([tie.place, tie.index, tie.reason, tie.placeName, tie.rival, Math.round(tie.nameSim * 100) / 100],
      [null, -1, "ambiguous", "Nordre Hov Gård", "Søndre Hov Gård", 0.67],
      "U44: two differently named candidates tie below 0.9 (Nordre/Søndre Hov Gård) → none picked, reason ambiguous");
    const tie3 = pm.pickConfidentPlace(hov, [NORDRE_HOV, SONDRE_HOV, HOV] as any[]);
    assertEq((tie3.place as any)?.id, "place-hov", "U45: …but an exact match in the same answer still wins (≥ 0.9 is clear)");
    const otherPostal = pm.pickConfidentPlace(hov, [NORDRE_HOV, place("Søndre Hov Gård", "2340", "Løten")] as any[]);
    assertEq((otherPostal.place as any)?.id, "place-nordre-hov",
      "U46: a near-tie that fails the location check is no rival (only passing candidates count)");
    const sameName = pm.pickConfidentPlace(hov, [NORDRE_HOV, { ...NORDRE_HOV, id: "nordre-dup" }] as any[]);
    assertEq((sameName.place as any)?.id, "place-nordre-hov",
      "U47: two passing listings with the same name are no rival → Google's first, as U06");

    const haugen = pm.rfbPlaceMatchEntity({ name: "Haugen Gård", postalCode: "1400", city: "Ski" });
    const kafe = place("Haugen Gård Kafé", "1400", "Ski", { id: "kafe" });
    const butikk = place("Haugen Gårdsbutikk", "1400", "Ski", { id: "butikk" });
    const utsalg = place("Haugen Gårdsutsalg", "1400", "Ski", { id: "utsalg" });
    const gaard = place("Haugen Gaard", "1400", "Ski", { id: "gaard" });
    assertEq((pm.pickConfidentPlace(haugen, [butikk, kafe] as any[]).place as any)?.id, "kafe",
      "U48: best below 0.9 (0.80) but the rival is ≥ PICK_TIE_MARGIN behind (0.74) → the best is picked");
    assertEq(pm.pickConfidentPlace(haugen, [butikk, utsalg] as any[]).reason, "ambiguous",
      "U49: equal 0.74 for two different names → ambiguous");
    assertEq((pm.pickConfidentPlace(haugen, [gaard, HAUGEN_SKI] as any[]).place as any)?.id, "place-haugen-ski",
      "U50: best ≥ PICK_CLEAR_NAME_SIM (1.00) is picked even with a different name within the margin (0.95)");
    assertEq([pm.PICK_CLEAR_NAME_SIM, pm.PICK_TIE_MARGIN], [0.9, 0.05], "U51: pick thresholds 0.9 / 0.05");

    // Caller veto (generic; RFB passes the farm-qualifier rule).
    const vetoed = pm.pickConfidentPlace(haugenSki, [HAUGEN_SKI] as any[], () => "test_veto");
    assertEq([vetoed.place, vetoed.reason, vetoed.placeName], [null, "test_veto", "Haugen Gård"],
      "U52: a veto rejects a candidate the shared rule accepts and names its label");
    const vetoFirst = pm.pickConfidentPlace(haugenSki, [HAUGEN_SKI, { ...HAUGEN_SKI, id: "second" }] as any[],
      (() => { let n = 0; return () => (n++ === 0 ? "test_veto" : null); })());
    assertEq((vetoFirst.place as any)?.id, "second", "U53: a vetoed candidate is skipped; the next confident one is picked");
    assertEq(pm.pickConfidentPlace(haugenSki, [HAUGEN_OPPDAL] as any[], () => "test_veto").reason, "no_confident_candidate",
      "U54: a candidate failing the shared rule reports no_confident_candidate (the veto is not consulted)");
  }

  // ── Review round 1, F1: RFB-only farm-qualifier veto ───────────────────
  {
    assertTrue(pm.farmQualifiersConflict("Nordre Hov Gård", "Søndre Hov Gård"), "U55: Nordre vs Søndre Hov Gård → conflict");
    assertTrue(pm.farmQualifiersConflict("Store Ree", "Lille Ree Gård"), "U56: Store vs Lille → conflict");
    assertTrue(pm.farmQualifiersConflict("AUSTRE MOLAND", "Vestre Moland"), "U57: nynorsk Austre vs Vestre, any case → conflict");
    assertTrue(!pm.farmQualifiersConflict("Hov Gård", "Nordre Hov Gård"), "U58: one side without a qualifier → no conflict (name similarity decides)");
    assertTrue(!pm.farmQualifiersConflict("Nordre Hov Gård", "Nordre Hov Gård"), "U59: same qualifier → no conflict");
    assertTrue(!pm.farmQualifiersConflict("Store Nordre Hov", "Nordre Hov"), "U60: one qualifier set inside the other → no conflict");
    assertTrue(!pm.farmQualifiersConflict("Nordre Hov Gård — Ytre Enebakk", "Nordre Hov Gård"),
      "U61: a qualifier in the platform's «— Sted» suffix does not count");
    assertTrue(!pm.farmQualifiersConflict("Storeng Gård", "Lille Storeng"), "U62: qualifiers are whole words ('Storeng' is no 'store')");

    const nordre = pm.rfbPlaceMatchEntity({ name: "Nordre Hov Gård", postalCode: "2335", city: "Stange" });
    assertTrue(pm.isConfidentPlaceMatch(nordre, SONDRE_HOV as any) && pm.placeNameSimilarity(nordre, "Søndre Hov Gård") > 0.75,
      "U63: the shared rule (dental's) accepts Søndre Hov Gård for Nordre Hov Gård (0.79) — unchanged for dental");
    const q = pm.pickRfbPlace(nordre, [SONDRE_HOV] as any[]);
    assertEq([q.place, q.reason, q.placeName], [null, "qualifier_conflict", "Søndre Hov Gård"],
      "U64: pickRfbPlace vetoes it → place_mismatch reason qualifier_conflict");
    assertEq((pm.pickRfbPlace(nordre, [SONDRE_HOV, NORDRE_HOV] as any[]).place as any)?.id, "place-nordre-hov",
      "U65: …and takes the right farm when it is in the same answer");
  }

  // ── Review round 1, F3: linear suffix strip and Text Search query ──────
  {
    const legacyStrip = (n: string) => (n || "").split(/\s*[—–]\s*|\s+-\s+/)[0]!.trim();
    const legacyQuery = (n: string, c: string) => `${n} ${c} Norway`.replace(/\s*[—–-]\s*/g, " ").trim();
    const names = [
      "", "Alm Gård — Feios", "Alm Gård–Feios", "Alm Gård - Feios", "Alm Gård -Feios", "Alm Gård- Feios",
      "Midt-Telemark Bigard", "  — Feios", "A - B — C", "A — B - C", "A  -  B", "a--b", "a - - b", "a -- b",
      "Øvre-Ål Gård — Ål", "Gård\t-\tSted", "x \u00a0— y", "Hov Gård –  Stange ", " lead", "trail - ", "-",
    ];
    let sameStrip = 0;
    let sameQuery = 0;
    for (const n of names) {
      if (pm.stripPlatformPlaceSuffix(n) === legacyStrip(n)) sameStrip++;
      if (pm.rfbPlacesTextQuery(n, "Ski") === legacyQuery(n, "Ski") && pm.rfbPlacesTextQuery(n, "") === legacyQuery(n, "")) sameQuery++;
    }
    assertEq(sameStrip, names.length, `U66: stripPlatformPlaceSuffix === the old split regex on all ${names.length} names`);
    assertEq(sameQuery, names.length, `U67: rfbPlacesTextQuery === the routes' old replace on all ${names.length} names (with/without city)`);
    assertEq(pm.rfbPlacesTextQuery("Haugen Gård — Ski", "Ski"), "Haugen Gård Ski Ski Norway", "U68: query shape «<name> <city> Norway»");

    const spaces = "A" + " ".repeat(200_000) + "B";
    const t0 = Date.now();
    pm.stripPlatformPlaceSuffix(spaces);
    pm.rfbPlacesTextQuery(spaces, spaces);
    pm.pickRfbPlace(pm.rfbPlaceMatchEntity({ name: spaces, postalCode: "1400" }), [place(spaces, "1400", "Ski")] as any[]);
    const ms = Date.now() - t0;
    assertTrue(ms < 1000, `U69: 200k spaces through strip, query and pick in ${ms} ms (< 1000; the old regexes took ~1 s at 50k)`);
  }

  // ── Acceptance (b), (c), (f) at the rule level ─────────────────────────
  assertTrue(!pm.isConfidentPlaceMatch(haugenSki, HAUGEN_OPPDAL as any),
    "U11 (b): same-named place in another kommune (7340 Oppdal vs 1400 Ski) → rejected");
  assertTrue(!pm.isConfidentPlaceMatch(pm.rfbPlaceMatchEntity({ name: "Haugen Gård", city: "Ski" }), HAUGEN_OPPDAL as any),
    "U12 (b): …also on the town-only path (no postal code, Ski vs Oppdal)");
  assertTrue(!pm.isConfidentPlaceMatch(haugenSki, HAUGEN_SKI_1401 as any),
    "U13 (c): right name, right town, wrong postal code (1401 vs 1400) → rejected");
  assertTrue(pm.isConfidentPlaceMatch(haugenSki, HAUGEN_SKI as any), "U14 (a): right name + right postal code → accepted");
  {
    const bergen = pm.rfbPlaceMatchEntity({ name: "Bergen Mathall", postalCode: "5013", city: "Bergen" });
    assertTrue(nameSimilarity("Bergen Mathall", "Mathallen Oslo") >= pm.NAME_SIM_THRESHOLD,
      "U15 (f): Bergen Mathall vs Mathallen Oslo clears the NAME bar on its own (0.62) — location must decide");
    assertTrue(!pm.isConfidentPlaceMatch(bergen, MATHALLEN_OSLO as any), "U16 (f): Bergen Mathall vs Mathallen Oslo → rejected");
    assertTrue(!pm.isConfidentPlaceMatch(pm.rfbPlaceMatchEntity({ name: "Bergen Mathall", city: "Bergen" }), MATHALLEN_OSLO as any),
      "U17 (f): …also with no postal code on record (town Bergen vs Oslo)");
    assertTrue(pm.isConfidentPlaceMatch(bergen, BERGEN_MATHALL as any), "U18: Bergen Mathall vs its own place → accepted");

    // Single-word variants of a multi-word name are not used: "bergen" alone
    // would clear the bar against any "Bergen …" business in the same code.
    const kebab = place("Bergen Kebab", "5013", "Bergen");
    assertTrue(nameVariants("Bergen Mathall").includes("bergen"), "U19: nameVariants offers the first-word fallback 'bergen'");
    assertTrue(nameSimilarity("bergen", "Bergen Kebab") >= pm.NAME_SIM_THRESHOLD, "U20: …which alone would clear the 0.55 bar vs 'Bergen Kebab'");
    assertTrue(!bergen.altNames!.includes("bergen"), "U21: rfbPlaceMatchEntity leaves single-word variants out of a multi-word name");
    assertTrue(!pm.isConfidentPlaceMatch(bergen, kebab as any), "U22: Bergen Mathall vs 'Bergen Kebab' in the same postal code → rejected");
  }

  // ── Acceptance (e): «Navn — Sted» suffix ───────────────────────────────
  {
    const ask = pm.rfbPlaceMatchEntity({ name: "Ask — Ringsaker", postalCode: "2380", city: "Ringsaker" });
    assertTrue(nameSimilarity("Ask — Ringsaker", "Ask") < pm.NAME_SIM_THRESHOLD,
      "U23 (e): the raw suffixed name alone would NOT match 'Ask' (0.29) — stripping is load-bearing");
    assertTrue(pm.isConfidentPlaceMatch(ask, ASK_RINGSAKER as any), "U24 (e): «Ask — Ringsaker» matches place 'Ask' in its postal code");
    assertEq(pm.stripPlatformPlaceSuffix("Alm Gård — Feios"), "Alm Gård", "U25: em dash suffix stripped");
    assertEq(pm.stripPlatformPlaceSuffix("Alm Gård–Feios"), "Alm Gård", "U26: unspaced en dash suffix stripped");
    assertEq(pm.stripPlatformPlaceSuffix("Alm Gård - Feios"), "Alm Gård", "U27: spaced hyphen suffix stripped");
    assertEq(pm.stripPlatformPlaceSuffix("Midt-Telemark Bigard"), "Midt-Telemark Bigard", "U28: in-word hyphen is part of the name");
    assertEq(pm.stripPlatformPlaceSuffix("Dalheim Gård og Gårdsysteri — Kvæfjord"), "Dalheim Gård og Gårdsysteri", "U29: long name keeps all words before the dash");
  }

  // ── rfbPlaceMatchEntity location rules ─────────────────────────────────
  {
    const e1 = pm.rfbPlaceMatchEntity({ name: "Haugen Gård", postalCode: " 1400 ", city: " Ski " });
    assertEq([e1.postalCode, e1.postalTown], ["1400", "Ski"], "U30: postal code and city trimmed");
    const e2 = pm.rfbPlaceMatchEntity({ name: "Haugen Gård", postalCode: "N-1400", city: "Ski" });
    assertEq(e2.postalCode, null, "U31: a stored postal code that is not 4 digits counts as missing");
    assertTrue(pm.isConfidentPlaceMatch(e2, HAUGEN_SKI as any), "U32: …so the town path decides (Ski = Ski)");
    const e3 = pm.rfbPlaceMatchEntity({ name: "Haugen Gård", postalCode: null, city: "" });
    assertEq([e3.postalCode, e3.postalTown], [null, null], "U33: no postal code and no city → no location");
    assertTrue(!pm.isConfidentPlaceMatch(e3, HAUGEN_SKI as any), "U34: no location on record → never confident");
    const e4 = pm.rfbPlaceMatchEntity({ name: "Heim Gård AS", postalCode: "1400" });
    assertTrue(e4.altNames!.includes("heim gard") && !e4.altNames!.includes("heim"),
      "U35: org-suffix variant kept, single-word farm strip left out");
  }

  // ── Kill switch + log line ────────────────────────────────────────────
  {
    assertEq(pm.PLACES_MATCH_GUARD_ENABLED, true, "U36: PLACES_MATCH_GUARD_ENABLED defaults to true");
    const entity = pm.rfbPlaceMatchEntity({ name: "Bergen Mathall", postalCode: "5013", city: "Bergen" });
    assertEq(pm.pickRfbPlace(entity, [MATHALLEN_OSLO] as any[]).place, null, "U37: guard on → Mathallen Oslo not picked");
    const off = pm.pickRfbPlace(entity, [MATHALLEN_OSLO, BERGEN_MATHALL] as any[], false);
    assertEq([(off.place as any)?.id, off.index, off.reason], ["place-mathallen-oslo", 0, null], "U38: guard off → places[0], the pre-S3 behaviour");
    const nordre = pm.rfbPlaceMatchEntity({ name: "Nordre Hov Gård", postalCode: "2335", city: "Stange" });
    assertEq((pm.pickRfbPlace(nordre, [SONDRE_HOV] as any[], false).place as any)?.id, "place-sondre-hov",
      "U38b: guard off → no qualifier veto either");
    assertEq(pm.pickRfbPlace(entity, [], false).place, null, "U39: guard off, no candidates → null");
    const line = pm.formatPlacesMatchGuardLog("agent-x", pm.pickRfbPlace(entity, [MATHALLEN_OSLO] as any[]), 1, entity);
    assertEq(line,
      '[places-match-guard] rejected Places hit for agent agent-x: place_mismatch (place "Mathallen Oslo", nameSim 0.62, 1 candidate(s); producer 5013 Bergen)',
      "U40: log line format (same shape as [brreg-address-guard])");
    const hov = pm.rfbPlaceMatchEntity({ name: "Hov Gård", postalCode: "2335", city: "Stange" });
    assertEq(pm.formatPlacesMatchGuardLog("agent-y", pm.pickRfbPlace(hov, [NORDRE_HOV, SONDRE_HOV] as any[]), 2, hov),
      '[places-match-guard] rejected Places hit for agent agent-y: place_mismatch (place "Nordre Hov Gård", nameSim 0.67, ambiguous with "Søndre Hov Gård", 2 candidate(s); producer 2335 Stange)',
      "U40b: log line names the ambiguous rival");
    assertEq(pm.formatPlacesMatchGuardLog("agent-z", pm.pickRfbPlace(nordre, [SONDRE_HOV] as any[]), 1, nordre),
      '[places-match-guard] rejected Places hit for agent agent-z: place_mismatch (place "Søndre Hov Gård", nameSim 0.79, qualifier_conflict, 1 candidate(s); producer 2335 Stange)',
      "U40c: log line names the veto");
  }

  // ═════════════════════════════════════════════════════════════════════
  // S4-A2 (pure): Google's rating fields out of the Places masks
  // ═════════════════════════════════════════════════════════════════════
  {
    assertEq(pm.GOOGLE_RATING_FETCH_ENABLED, false, "A2-U01: GOOGLE_RATING_FETCH_ENABLED defaults to false (decision 2=A)");
    assertEq(pm.googleRatingFetchEnabled(), false, "A2-U02: …and that is what the routes read without an override");
    assertEq([...pm.PLACES_RATING_FIELDS], ["places.rating", "places.userRatingCount"], "A2-U03: the rating fields are rating and userRatingCount");
    const full = ["places.id", "places.rating", "places.userRatingCount", "places.displayName", "places.internationalPhoneNumber"];
    assertEq(pm.placesFieldMask(full, false), "places.id,places.displayName,places.internationalPhoneNumber",
      "A2-U04: fetch off → exactly the two rating fields dropped, the order kept");
    assertEq(pm.placesFieldMask(full, true), full.join(","), "A2-U05: fetch on → the mask as listed (the pre-S4-A2 masks)");
    assertEq(pm.placesFieldMask(full), "places.id,places.displayName,places.internationalPhoneNumber", "A2-U06: the default follows the lever (off)");
    const noRating = ["places.displayName", "places.formattedAddress", "places.regularOpeningHours", "places.addressComponents"];
    assertEq([pm.placesFieldMask(noRating, false), pm.placesFieldMask(noRating, true)], [noRating.join(","), noRating.join(",")],
      "A2-U07: a mask without rating fields (dental's) is the same either way");
    try {
      pm.__setGoogleRatingFetchForTesting(true);
      assertEq([pm.googleRatingFetchEnabled(), pm.placesFieldMask(full)], [true, full.join(",")], "A2-U08: the test override turns the default on");
    } finally {
      pm.__setGoogleRatingFetchForTesting(null);
    }
    assertEq(pm.googleRatingFetchEnabled(), false, "A2-U09: null restores the lever");
  }

  // ═════════════════════════════════════════════════════════════════════
  // Routes: POST /admin/google-rating-batch and /admin/google-rating/:id
  // ═════════════════════════════════════════════════════════════════════
  const prevDb = initMod.__peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
  const prevFetch = (globalThis as any).fetch;
  const prevWarn = console.warn;

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");
  const ADMIN_KEY = process.env.ADMIN_KEY || "rfb-places-match-guard-test-key";
  const adminHeaders = { "x-admin-key": ADMIN_KEY, "content-type": "application/json" };

  let placesAnswer: unknown[] = [];
  const placesCalls: Array<{ url: string; mask: string | undefined }> = [];
  let brregCalls = 0;
  const warnings: string[] = [];

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    process.env.GOOGLE_PLACES_API_KEY = "test-places-key";

    (globalThis as any).fetch = async (url: string, init?: any) => {
      const u = String(url);
      if (u.includes("places.googleapis.com")) {
        placesCalls.push({ url: u, mask: init?.headers?.["X-Goog-FieldMask"] });
        const answer = JSON.parse(JSON.stringify(placesAnswer));
        return { ok: true, status: 200, json: async () => ({ places: answer }), text: async () => "" } as any;
      }
      if (u.includes("brreg.no")) brregCalls++;
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
    };
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    delete require.cache[require.resolve("./marketplace")];
    const router = require("./marketplace").default as any;
    // S4-A2: the S3 scenarios run with rating fetch forced ON, the rollback
    // position of GOOGLE_RATING_FETCH_ENABLED; the production default (off)
    // is the "S4-A2" section after (h). Restored in finally.
    pm.__setGoogleRatingFetchForTesting(true);

    const insertAgent = (id: string, name: string, city: string | null, knowledge: Record<string, unknown> = {}) => {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, city, created_at)
         VALUES (?, ?, 't', 't', '', '', 'producer', ?, 'rfb', ?, '2026-01-01 00:00:00')`,
      ).run(id, name, `key-${id}`, city);
      const cols = ["agent_id", ...Object.keys(knowledge)];
      db.prepare(
        `INSERT INTO agent_knowledge (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ).run(id, ...Object.values(knowledge));
    };
    const row = (id: string) =>
      db.prepare(
        `SELECT google_rating, google_review_count, address, phone, field_provenance, google_enterprise_fetched_at
           FROM agent_knowledge WHERE agent_id = ?`,
      ).get(id) as any;
    const trust = (id: string) => (db.prepare(`SELECT trust_score FROM agents WHERE id = ?`).get(id) as any)?.trust_score;
    const runBatch = async (id: string, includeAddrPhone = true) => {
      const r = await callRoute(router, {
        url: "/admin/google-rating-batch",
        headers: adminHeaders,
        body: { agentIds: [id], include_address_phone: includeAddrPhone, max_details_calls: 0 },
      });
      return { status: r.status, row: r.body?.data?.results?.[0], body: r.body };
    };
    // Brreg name lookups are cached per process ("<name>|<postal>"); a test
    // asserting "no Brreg lookup" clears it first so a cache hit cannot pass it.
    const { __clearBrregCacheForTesting } = require("../services/brreg-client") as typeof import("../services/brreg-client");
    const runSingle = (id: string) => callRoute(router, { url: `/admin/google-rating/${id}`, headers: adminHeaders, body: {} });
    const lastMask = () => placesCalls[placesCalls.length - 1]?.mask;

    // ── (a) the right place is written ─────────────────────────────────
    {
      insertAgent("pmg-a", "Haugen Gård — Ski", "Ski", { postal_code: "1400" });
      placesAnswer = [HAUGEN_SKI];
      const brregBefore = brregCalls;
      const r = await runBatch("pmg-a");
      assertEq([r.status, r.row?.status, r.row?.googleRating, r.row?.addressWritten, r.row?.phoneWritten],
        [200, "enriched", 4.6, true, true], "R01 (a): matching place → enriched, address + phone written");
      const k = row("pmg-a");
      assertEq([k.google_rating, k.google_review_count, k.address, k.phone], [4.6, 236, "Haugenveien 5, 1400 Ski", "+4764870000"],
        "R02 (a): rating, count, address and phone stored from the matched place");
      assertTrue(String(k.field_provenance).includes("google_places"), "R03 (a): google_places provenance merged");
      assertTrue(brregCalls > brregBefore, "R04: a matched place with an empty address still asks Brreg first (baseline for R09)");
      assertEq(maskFields(lastMask()), maskFields(OLD_MASKS.batchEnterpriseAddrPhone + ",places.addressComponents"),
        "R05: Enterprise+addr/phone mask = the old mask + places.addressComponents, nothing else");
    }

    // ── (b) same name, other kommune → nothing written ─────────────────
    {
      insertAgent("pmg-b", "Haugen Gård", "Ski", { postal_code: "1400" });
      placesAnswer = [HAUGEN_OPPDAL];
      const trustBefore = trust("pmg-b");
      __clearBrregCacheForTesting();
      const brregBefore = brregCalls;
      const warnBefore = warnings.length;
      const r = await runBatch("pmg-b");
      assertEq([r.status, r.row?.status, r.row?.mismatchReason, r.row?.placeName, r.row?.nameSim],
        [200, "place_mismatch", "no_confident_candidate", "Haugen Gård", 1],
        "R06 (b): same-named place in Oppdal → place_mismatch, reports the rejected place and why");
      const k = row("pmg-b");
      assertEq([k.google_rating, k.google_review_count, k.address, k.phone], [null, null, null, null],
        "R07 (b): no rating, count, address or phone written");
      assertTrue(!String(k.field_provenance ?? "").includes("google_places"), "R08 (b): no google_places provenance");
      assertEq(brregCalls, brregBefore, "R09 (b): no Brreg lookup on a mismatch");
      assertTrue(!!k.google_enterprise_fetched_at, "R10 (b): the spent Enterprise call is still recorded (no re-spend next run)");
      assertEq(trust("pmg-b"), trustBefore, "R11 (b): trust score untouched");
      assertEq(r.body?.data?.enriched, 0, "R12 (b): not counted as enriched");
      const lines = warnings.slice(warnBefore).filter((l) => l.startsWith("[places-match-guard]"));
      assertEq(lines,
        ['[places-match-guard] rejected Places hit for agent pmg-b: place_mismatch (place "Haugen Gård", nameSim 1.00, 1 candidate(s); producer 1400 Ski)'],
        "R13 (b): one [places-match-guard] warn line with placeName and nameSim");
    }

    // ── (c) right name, wrong postal code ──────────────────────────────
    {
      insertAgent("pmg-c", "Haugen Gård", "Ski", { postal_code: "1400" });
      placesAnswer = [HAUGEN_SKI_1401];
      const r = await runBatch("pmg-c");
      assertEq(r.row?.status, "place_mismatch", "R14 (c): right name + town, postal 1401 vs 1400 → place_mismatch");
      const k = row("pmg-c");
      assertEq([k.google_rating, k.address], [null, null], "R15 (c): nothing written");
    }

    // ── (d) places[0] wrong, places[1] right ───────────────────────────
    {
      insertAgent("pmg-d", "Bergen Mathall", "Bergen", { postal_code: "5013" });
      placesAnswer = [MATHALLEN_OSLO, BERGEN_MATHALL];
      const r = await runBatch("pmg-d");
      assertEq([r.row?.status, r.row?.googleRating, r.row?.googleReviewCount], ["enriched", 4.2, 900],
        "R16 (d): rating comes from places[1] (Bergen Mathall), not places[0] (Mathallen Oslo)");
      const k = row("pmg-d");
      assertEq([k.google_rating, k.google_review_count, k.address, k.phone], [4.2, 900, "Strandkaien 3, 5013 Bergen", "+4755000000"],
        "R17 (d): address and phone also from places[1]");
      assertTrue(!String(k.field_provenance).includes("Vulkan 5"), "R18 (d): nothing of Mathallen Oslo in provenance");
    }

    // ── (e) «Navn — Sted» suffix ───────────────────────────────────────
    {
      insertAgent("pmg-e", "Ask — Ringsaker", "Ringsaker", { postal_code: "2380" });
      placesAnswer = [ASK_RINGSAKER];
      const r = await runBatch("pmg-e");
      assertEq([r.row?.status, r.row?.googleRating], ["enriched", 4.7], "R19 (e): «Ask — Ringsaker» matches place 'Ask' → enriched");
    }

    // ── (f) Bergen Mathall vs Mathallen Oslo; stored rating stays ──────
    {
      insertAgent("pmg-f", "Bergen Mathall", "Bergen", { postal_code: "5013", google_rating: 4.0, google_review_count: 100 });
      placesAnswer = [MATHALLEN_OSLO];
      const r = await runBatch("pmg-f");
      assertEq([r.row?.status, r.row?.googleRating, r.row?.googleReviewCount], ["place_mismatch", 4, 100],
        "R20 (f): Mathallen Oslo rejected; the row reports the rating already on file");
      const k = row("pmg-f");
      assertEq([k.google_rating, k.google_review_count, k.address, k.phone], [4, 100, null, null],
        "R21 (f): stored rating neither overwritten nor nulled (no nulling in S3); no address/phone");
    }

    // ── Review round 1, B1: [near-namesake, exact] in one postal code ───
    {
      insertAgent("pmg-b1", "Hov Gård", "Stange", { postal_code: "2335" });
      placesAnswer = [NORDRE_HOV, HOV];
      const r = await runBatch("pmg-b1");
      assertEq([r.row?.status, r.row?.googleRating, r.row?.googleReviewCount], ["enriched", 4.3, 14],
        "R38 (B1): 'Hov Gård' gets Hov Gård's 4.3/14, not Nordre Hov Gård's 4.9/812 at places[0]");
      const k = row("pmg-b1");
      assertEq([k.google_rating, k.google_review_count, k.address, k.phone], [4.3, 14, "Hovsvegen 20, 2335 Stange", "+4733333333"],
        "R39 (B1): address and phone also from Hov Gård");
      assertTrue(!/Hovsvegen 10|11111111/.test(String(k.field_provenance)), "R40 (B1): nothing of Nordre Hov Gård in provenance");
    }

    // ── Review round 1: ambiguous answer → nothing written ───────────────
    {
      insertAgent("pmg-amb", "Hov Gård", "Stange", { postal_code: "2335" });
      placesAnswer = [NORDRE_HOV, SONDRE_HOV];
      __clearBrregCacheForTesting();
      const brregBefore = brregCalls;
      const warnBefore = warnings.length;
      const r = await runBatch("pmg-amb");
      assertEq([r.row?.status, r.row?.mismatchReason, r.row?.placeName], ["place_mismatch", "ambiguous", "Nordre Hov Gård"],
        "R41: Nordre and Søndre Hov Gård tie for 'Hov Gård' → place_mismatch, reason ambiguous");
      const k = row("pmg-amb");
      assertEq([k.google_rating, k.address, k.phone], [null, null, null], "R42: ambiguous → no rating, address or phone");
      assertEq(brregCalls, brregBefore, "R43: ambiguous → no Brreg lookup");
      assertTrue(warnings.slice(warnBefore).some((l) => l.includes('ambiguous with "Søndre Hov Gård"')),
        "R44: the warn line names the rival");
    }

    // ── Review round 1, F1: farm-qualifier veto on the route ─────────────
    {
      insertAgent("pmg-q", "Nordre Hov Gård — Stange", "Stange", { postal_code: "2335" });
      placesAnswer = [SONDRE_HOV];
      const r = await runBatch("pmg-q");
      assertEq([r.row?.status, r.row?.mismatchReason], ["place_mismatch", "qualifier_conflict"],
        "R45 (F1): 'Nordre Hov Gård — Stange' vs Søndre Hov Gård in the same postal code → place_mismatch");
      assertEq([row("pmg-q").google_rating, row("pmg-q").address], [null, null], "R46 (F1): nothing written");
    }

    // ── Repeat-run (Pro mask) path ──────────────────────────────────────
    {
      insertAgent("pmg-pro", "Haugen Gård", "Ski", {
        postal_code: "1400", google_rating: 4.6, google_review_count: 236, google_enterprise_fetched_at: "2099-01-01T00:00:00.000Z",
      });
      placesAnswer = [HAUGEN_OPPDAL];
      const r = await runBatch("pmg-pro");
      assertEq(maskFields(lastMask()), maskFields(OLD_MASKS.batchPro + ",places.addressComponents"),
        "R22: Pro mask = the old mask + places.addressComponents (still no Enterprise field)");
      assertEq([r.row?.status, r.row?.googleRating], ["place_mismatch", 4.6], "R23: Pro path mismatch → place_mismatch, existing rating reported");
      const k = row("pmg-pro");
      assertEq([k.address, k.phone, k.google_enterprise_fetched_at], [null, null, "2099-01-01T00:00:00.000Z"],
        "R24: nothing written, Enterprise marker untouched (no Enterprise call was made)");

      placesAnswer = [];
      const r2 = await runBatch("pmg-pro");
      assertEq(r2.row?.status, "skipped_has_rating", "R25: Pro path with no candidates → skipped_has_rating, as before");
    }

    // ── Flag-less Enterprise path + no candidates ───────────────────────
    {
      insertAgent("pmg-nocand", "Haugen Gård", "Ski", { postal_code: "1400" });
      placesAnswer = [];
      const r = await runBatch("pmg-nocand", false);
      assertEq(maskFields(lastMask()), maskFields(OLD_MASKS.batchEnterprise + ",places.addressComponents"),
        "R26: Enterprise mask without addr/phone = the old mask + places.addressComponents");
      assertEq(r.row?.status, "no_rating", "R27: Enterprise path with no candidates → no_rating, as before");
      assertTrue(!!row("pmg-nocand").google_enterprise_fetched_at, "R28: …and the attempt is recorded, as before");
    }

    // ── (g) POST /admin/google-rating/:id ──────────────────────────────
    {
      insertAgent("pmg-g1", "Haugen Gård", "Ski", { postal_code: "1400" });
      placesAnswer = [HAUGEN_OPPDAL];
      const warnBefore = warnings.length;
      let r = await runSingle("pmg-g1");
      assertEq([r.status, r.body?.success, r.body?.found, r.body?.status, r.body?.mismatchReason, r.body?.placeName],
        [200, true, false, "place_mismatch", "no_confident_candidate", "Haugen Gård"],
        "R29 (g): single route, same-named place in Oppdal → place_mismatch");
      assertEq(row("pmg-g1").google_rating, null, "R30 (g): single route wrote no rating");
      assertTrue(warnings.slice(warnBefore).some((l) => l.startsWith("[places-match-guard] rejected Places hit for agent pmg-g1:")),
        "R31 (g): single route logs the [places-match-guard] line");
      assertEq(maskFields(lastMask()), maskFields(OLD_MASKS.single + ",places.addressComponents"),
        "R32 (g): single-route mask = the old mask + places.addressComponents");

      insertAgent("pmg-g2", "Bergen Mathall", "Bergen", { postal_code: "5013" });
      placesAnswer = [MATHALLEN_OSLO, BERGEN_MATHALL];
      r = await runSingle("pmg-g2");
      assertEq([r.body?.hasRating, r.body?.googleRating, r.body?.placeName], [true, 4.2, "Bergen Mathall"],
        "R33 (g): single route takes the confident places[1]");
      assertEq([row("pmg-g2").google_rating, row("pmg-g2").google_review_count], [4.2, 900], "R34 (g): …and stores its rating");

      insertAgent("pmg-g3", "Hov Gård", "Stange", { postal_code: "2335" });
      placesAnswer = [NORDRE_HOV, HOV];
      r = await runSingle("pmg-g3");
      assertEq([r.body?.hasRating, r.body?.googleRating, r.body?.placeName], [true, 4.3, "Hov Gård"],
        "R47 (g, B1): single route takes the exact match at places[1], not Nordre Hov Gård");
      assertEq([row("pmg-g3").google_rating, row("pmg-g3").google_review_count], [4.3, 14], "R48 (g, B1): …and stores its rating");
      placesAnswer = [NORDRE_HOV, SONDRE_HOV];
      insertAgent("pmg-g4", "Hov Gård", "Stange", { postal_code: "2335" });
      r = await runSingle("pmg-g4");
      assertEq([r.body?.status, r.body?.mismatchReason, row("pmg-g4").google_rating], ["place_mismatch", "ambiguous", null],
        "R49 (g): single route, ambiguous answer → place_mismatch, nothing stored");
    }

    // ── (h) write pause still answers 423 before any Places call ───────
    {
      const svc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
      insertAgent("pmg-h", "Haugen Gård", "Ski", { postal_code: "1400" });
      placesAnswer = [HAUGEN_SKI];
      svc.setEnrichmentWritePause(db as any, {
        vertical: "rfb", enabled: true, reason: "test: skrivepause", triggered_by: "platform-verifier",
      }, "test");
      const callsBefore = placesCalls.length;
      try {
        const b = await runBatch("pmg-h");
        const s = await runSingle("pmg-h");
        assertEq([b.status, s.status], [423, 423], "R35 (h): paused rfb → batch and single route answer 423");
        assertEq(placesCalls.length, callsBefore, "R36 (h): …before any Places call");
        assertEq(row("pmg-h").google_rating, null, "R37 (h): nothing written");
      } finally {
        svc.setEnrichmentWritePause(db as any, { vertical: "rfb", enabled: false, cleared_by: "daniel" }, "test");
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    // S4-A2: both routes in the production default (rating fetch off). The
    // stubbed answers still carry Google's rating: the routes must not take it.
    // ═════════════════════════════════════════════════════════════════════
    pm.__setGoogleRatingFetchForTesting(null);
    const a2CallsFrom = placesCalls.length;
    const hasRating = (o: any) => !!o && ("googleRating" in o || "googleReviewCount" in o);
    assertEq(pm.googleRatingFetchEnabled(), false, "A2-R00: the scenarios below run with the production default");

    // ── first-time agent, matching place: address/phone pass, no rating ──
    {
      insertAgent("a2-a", "Haugen Gård — Ski", "Ski", { postal_code: "1400" });
      placesAnswer = [HAUGEN_SKI];
      const trustBefore = trust("a2-a");
      const r = await runBatch("a2-a");
      assertEq([r.status, r.row?.status, r.row?.addressWritten, r.row?.phoneWritten], [200, "enriched_addr_phone_only", true, true],
        "A2-R01: matching place → address and phone written, status enriched_addr_phone_only");
      assertTrue(!hasRating(r.row), "A2-R02: the row reports no Google rating");
      const k = row("a2-a");
      assertEq([k.google_rating, k.google_review_count, k.address, k.phone], [null, null, "Haugenveien 5, 1400 Ski", "+4764870000"],
        "A2-R03: no rating stored although the answer had 4.6/236; address and phone stored");
      assertTrue(String(k.field_provenance).includes("google_places"), "A2-R04: google_places provenance merged as before");
      assertTrue(!!k.google_enterprise_fetched_at,
        "A2-R05: the Enterprise-tier call (internationalPhoneNumber) is recorded, so it stays once per 90 days");
      assertEq(maskFields(lastMask()),
        maskFields("places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.addressComponents"),
        "A2-R06: first-time address/phone mask = the S3 mask without places.rating and places.userRatingCount");
      assertEq([r.body?.data?.enriched, r.body?.data?.rating_calls, r.body?.data?.enterprise_calls], [0, 0, 1],
        "A2-R07: enriched 0 (no rating), rating_calls 0, the one Enterprise call counted");
      assertEq(trust("a2-a"), trustBefore, "A2-R08: trust score untouched");
      assertTrue(String(r.body?.message).startsWith("Google-ratinger hentes ikke lenger"), "A2-R08b: the message says ratings are not fetched");
    }

    // ── the guard is unchanged: places[0] wrong, places[1] right ─────────
    {
      insertAgent("a2-d", "Bergen Mathall", "Bergen", { postal_code: "5013" });
      placesAnswer = [MATHALLEN_OSLO, BERGEN_MATHALL];
      const r = await runBatch("a2-d");
      const k = row("a2-d");
      assertEq([r.row?.status, k.google_rating, k.address, k.phone], ["enriched_addr_phone_only", null, "Strandkaien 3, 5013 Bergen", "+4755000000"],
        "A2-R09: address and phone from places[1] (Bergen Mathall), no rating");
      assertTrue(!String(k.field_provenance).includes("Vulkan 5"), "A2-R10: nothing of Mathallen Oslo in provenance");
    }

    // ── a stored rating stays: mismatch, and a confident match ───────────
    {
      insertAgent("a2-f", "Bergen Mathall", "Bergen", { postal_code: "5013", google_rating: 4.0, google_review_count: 100 });
      placesAnswer = [MATHALLEN_OSLO];
      let r = await runBatch("a2-f");
      assertEq([r.row?.status, r.row?.mismatchReason], ["place_mismatch", "no_confident_candidate"], "A2-R11: wrong place → place_mismatch, as before");
      assertTrue(!hasRating(r.row), "A2-R12: …and the row does not report the rating on file either");
      let k = row("a2-f");
      assertEq([k.google_rating, k.google_review_count, k.address, k.phone], [4, 100, null, null],
        "A2-R13: stored rating untouched, nothing written");

      insertAgent("a2-s", "Bergen Mathall", "Bergen", { postal_code: "5013", google_rating: 4.0, google_review_count: 100 });
      placesAnswer = [BERGEN_MATHALL];
      r = await runBatch("a2-s");
      k = row("a2-s");
      assertEq([r.row?.status, k.google_rating, k.google_review_count, k.address], ["enriched_addr_phone_only", 4, 100, "Strandkaien 3, 5013 Bergen"],
        "A2-R14: a confident match neither overwrites (4.2/900 in the answer) nor nulls the stored 4.0/100; address written");
    }

    // ── no candidates ────────────────────────────────────────────────────
    {
      insertAgent("a2-n", "Haugen Gård", "Ski", { postal_code: "1400" });
      placesAnswer = [];
      const r = await runBatch("a2-n");
      assertEq([r.row?.status, hasRating(r.row)], ["no_place", false], "A2-R15: no candidates → no_place (no rating was asked for)");
      assertTrue(!!row("a2-n").google_enterprise_fetched_at, "A2-R16: …and the spent Enterprise call is recorded");
    }

    // ── repeat run (fresh Enterprise marker): Pro mask, as before ────────
    {
      insertAgent("a2-p", "Haugen Gård", "Ski", {
        postal_code: "1400", google_rating: 4.6, google_review_count: 236, google_enterprise_fetched_at: "2099-01-01T00:00:00.000Z",
      });
      placesAnswer = [HAUGEN_SKI];
      let r = await runBatch("a2-p");
      assertEq(maskFields(lastMask()), maskFields(OLD_MASKS.batchPro + ",places.addressComponents"), "A2-R17: repeat run → the Pro mask, unchanged");
      assertEq([r.row?.status, r.row?.addressWritten, hasRating(r.row)], ["enriched_addr_phone_only", true, false],
        "A2-R18: repeat run → the address pass as before, no rating on the row");
      const k = row("a2-p");
      assertEq([k.google_rating, k.google_review_count, k.google_enterprise_fetched_at], [4.6, 236, "2099-01-01T00:00:00.000Z"],
        "A2-R19: stored rating and the Enterprise marker untouched");
      placesAnswer = [];
      r = await runBatch("a2-p");
      assertEq(r.row?.status, "no_place", "A2-R20: repeat run, no candidates → no_place");
    }

    // ── without include_address_phone nothing is left to fetch ───────────
    {
      insertAgent("a2-x", "Haugen Gård", "Ski", { postal_code: "1400", google_rating: 4.6, google_review_count: 236 });
      placesAnswer = [HAUGEN_SKI];
      const callsBefore = placesCalls.length;
      const r = await runBatch("a2-x", false);
      assertEq(placesCalls.length, callsBefore, "A2-R21: flag-less batch → no Places call");
      assertEq([r.status, r.row?.status, hasRating(r.row)], [200, "skipped_rating_fetch_disabled", false],
        "A2-R22: …status skipped_rating_fetch_disabled, no rating on the row");
      assertEq([r.body?.data?.places_api_calls, r.body?.data?.enterprise_calls, r.body?.data?.rating_calls], [0, 0, 0],
        "A2-R23: …and no call counted");
      const k = row("a2-x");
      assertEq([k.google_rating, k.google_review_count, k.google_enterprise_fetched_at], [4.6, 236, null],
        "A2-R24: stored rating untouched, no Enterprise attempt recorded");
    }

    // ── POST /admin/google-rating/:id: no Places call, nothing written ───
    {
      insertAgent("a2-g", "Bergen Mathall", "Bergen", { postal_code: "5013", google_rating: 4.0, google_review_count: 100 });
      placesAnswer = [BERGEN_MATHALL];
      const callsBefore = placesCalls.length;
      const trustBefore = trust("a2-g");
      const s = await runSingle("a2-g");
      assertEq([s.status, s.body?.success, s.body?.found, s.body?.status], [200, true, false, "rating_fetch_disabled"],
        "A2-R25: single route → status rating_fetch_disabled");
      assertEq(placesCalls.length, callsBefore, "A2-R26: …without a Places call");
      assertTrue(!hasRating(s.body), "A2-R27: …and with no rating in the answer");
      assertEq([row("a2-g").google_rating, row("a2-g").google_review_count, trust("a2-g")], [4, 100, trustBefore],
        "A2-R28: stored rating and trust score untouched");
      const missing = await runSingle("a2-nope");
      assertEq(missing.status, 404, "A2-R29: an unknown agent is still 404");
    }

    // ── the write pause still answers 423 first ──────────────────────────
    {
      const svc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
      svc.setEnrichmentWritePause(db as any, {
        vertical: "rfb", enabled: true, reason: "test: skrivepause", triggered_by: "platform-verifier",
      }, "test");
      const callsBefore = placesCalls.length;
      try {
        const b = await runBatch("a2-a");
        const s = await runSingle("a2-a");
        assertEq([b.status, s.status], [423, 423], "A2-R30: paused rfb → batch and single route answer 423");
        assertEq(placesCalls.length, callsBefore, "A2-R31: …before any Places call");
      } finally {
        svc.setEnrichmentWritePause(db as any, { vertical: "rfb", enabled: false, cleared_by: "daniel" }, "test");
      }
    }

    // ── every call above, and the rollback lever ─────────────────────────
    {
      const a2Masks = placesCalls.slice(a2CallsFrom).map((c) => maskFields(c.mask));
      assertTrue(a2Masks.length >= 7 && a2Masks.every((m) => !m.some((f) => pm.PLACES_RATING_FIELDS.includes(f))),
        "A2-R32: no Places call in the S4-A2 scenarios asked for a rating field");

      pm.__setGoogleRatingFetchForTesting(true);
      try {
        insertAgent("a2-on", "Haugen Gård — Ski", "Ski", { postal_code: "1400" });
        placesAnswer = [HAUGEN_SKI];
        const r = await runBatch("a2-on");
        assertEq([r.row?.status, r.row?.googleRating, row("a2-on").google_rating, r.body?.data?.rating_calls], ["enriched", 4.6, 4.6, 1],
          "A2-R33: lever set back on → the rating is fetched and written again, rating_calls 1 (rollback without a revert)");
      } finally {
        pm.__setGoogleRatingFetchForTesting(null);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push("rfb-places-match-guard: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    pm.__setGoogleRatingFetchForTesting(null);
    console.warn = prevWarn;
    (globalThis as any).fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevPlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = prevPlacesKey;
    initMod.__setDbForTesting(prevDb as any);
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: npx tsx src/routes/rfb-places-match-guard.test.ts
if (require.main === module) {
  runRfbPlacesMatchGuardTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
