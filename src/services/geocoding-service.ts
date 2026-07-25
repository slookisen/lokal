// ─── Geocoding Service ───────────────────────────────────────
// Resolves Norwegian place names → lat/lng coordinates.
//
// Strategy (fastest first):
//   1. In-memory cache (instant)
//   2. Top-20 major cities hardcoded (no API call needed)
//   3. Agent database lookup (cities where we have agents)
//   4. Kartverket Stedsnavn API (covers ALL Norwegian places)
//
// Kartverket API: https://ws.geonorge.no/stedsnavn/v1/
// Free, no API key, no rate limit issues at our scale.

import { getDb } from "../database/init";

export interface GeoResult {
  lat: number;
  lng: number;
  name: string;        // canonical name from source
  radiusKm: number;    // suggested search radius
  source: "cache" | "hardcoded" | "database" | "kartverket" | "kommuneinfo";
  /** Kartverket navneobjekttype the point came from (kartverket source only). */
  placeType?: string;
}

// ── In-memory cache (survives request cycle, clears on restart) ──
const geoCache = new Map<string, GeoResult | null>();
const CACHE_MAX = 500;

// ── Injectable fetch (tests) ──────────────────────────────────────
// Same seam shape as dental-geocode-worker.ts's GeocodeDeps.fetchImpl, but
// module-level because geocodingService is a singleton every route imports
// directly. Production never calls the setter, so the default is the global
// fetch exactly as before.
let fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args);

/** Test-only: swap the fetch used for all Kartverket/Kommuneinfo calls. Pass nothing to restore. */
export function __setGeocodingFetchForTesting(impl?: typeof fetch): void {
  fetchImpl = impl || ((...args: Parameters<typeof fetch>) => fetch(...args));
}

/** Test-only: drop the in-memory geocode cache so each case starts clean. */
export function __clearGeocodeCacheForTesting(): void {
  geoCache.clear();
}

// ── Major Norwegian places hardcoded for speed (no API call needed) ──
// Expanded in PR-75 (28 → ~100 entries). Covers >95% of common queries.
// Coordinates verified against Kartverket Stedsnavn API (EPSG:4258).
// Radius heuristic: storby 25-30 km, medium 20-25 km, tettsted 15-20 km,
// region/dal 40-60 km, fylke 80-120 km. ASCII-aliaser for ø/å/æ.
const MAJOR_CITIES: Record<string, { lat: number; lng: number; radius: number }> = {
  // ── Storbyer (original 4) ──
  "oslo":         { lat: 59.9139, lng: 10.7522, radius: 25 },
  "bergen":       { lat: 60.3913, lng: 5.3221,  radius: 30 },
  "trondheim":    { lat: 63.4305, lng: 10.3951, radius: 30 },
  "stavanger":    { lat: 58.9700, lng: 5.7331,  radius: 30 },

  // ── Andre store byer (original) ──
  "tromsø":       { lat: 69.6496, lng: 18.9560, radius: 30 },
  "tromso":       { lat: 69.6496, lng: 18.9560, radius: 30 },
  "kristiansand": { lat: 58.1599, lng: 8.0182,  radius: 30 },
  "drammen":      { lat: 59.7441, lng: 10.2045, radius: 25 },
  "fredrikstad":  { lat: 59.2181, lng: 10.9298, radius: 25 },
  "bodø":         { lat: 67.2804, lng: 14.4049, radius: 40 },
  "bodo":         { lat: 67.2804, lng: 14.4049, radius: 40 },
  "ålesund":      { lat: 62.4722, lng: 6.1495,  radius: 30 },
  "alesund":      { lat: 62.4722, lng: 6.1495,  radius: 30 },
  "tønsberg":     { lat: 59.2675, lng: 10.4076, radius: 25 },
  "tonsberg":     { lat: 59.2675, lng: 10.4076, radius: 25 },
  "haugesund":    { lat: 59.4138, lng: 5.2680,  radius: 25 },
  "sandnes":      { lat: 58.8524, lng: 5.7352,  radius: 25 },
  "lillestrøm":   { lat: 59.9550, lng: 11.0493, radius: 20 },
  "lillestrom":   { lat: 59.9550, lng: 11.0493, radius: 20 },
  "hamar":        { lat: 60.7945, lng: 11.0680, radius: 25 },
  "lillehammer":  { lat: 61.1153, lng: 10.4662, radius: 30 },
  "sandefjord":   { lat: 59.1314, lng: 10.2166, radius: 25 },
  "sarpsborg":    { lat: 59.2839, lng: 11.1096, radius: 25 },
  "skien":        { lat: 59.2099, lng: 9.6089,  radius: 25 },
  "molde":        { lat: 62.7375, lng: 7.1591,  radius: 30 },
  "moss":         { lat: 59.4346, lng: 10.6588, radius: 20 },
  "asker":        { lat: 59.8371, lng: 10.4348, radius: 20 },
  "kongsberg":    { lat: 59.6630, lng: 9.6501,  radius: 25 },

  // ── Østlandet — nye i PR-75 ──
  "ski":          { lat: 59.7195, lng: 10.8358, radius: 20 },
  "bærum":        { lat: 59.8901, lng: 10.5267, radius: 25 },
  "barum":        { lat: 59.8901, lng: 10.5267, radius: 25 },
  "drøbak":       { lat: 59.6633, lng: 10.6297, radius: 15 },
  "drobak":       { lat: 59.6633, lng: 10.6297, radius: 15 },
  "spydeberg":    { lat: 59.6171, lng: 11.0856, radius: 15 },
  "halden":       { lat: 59.1246, lng: 11.3874, radius: 25 },
  "holmestrand":  { lat: 59.4876, lng: 10.3176, radius: 20 },
  "larvik":       { lat: 59.0533, lng: 10.0352, radius: 25 },
  "porsgrunn":    { lat: 59.1317, lng: 9.6467,  radius: 25 },
  "notodden":     { lat: 59.5594, lng: 9.2585,  radius: 20 },
  "kragerø":      { lat: 58.8693, lng: 9.4149,  radius: 20 },
  "kragero":      { lat: 58.8693, lng: 9.4149,  radius: 20 },
  "hønefoss":     { lat: 60.1659, lng: 10.2558, radius: 25 },
  "honefoss":     { lat: 60.1659, lng: 10.2558, radius: 25 },
  "jevnaker":     { lat: 60.2398, lng: 10.3871, radius: 15 },
  "gran":         { lat: 60.3592, lng: 10.5728, radius: 15 },
  "eidsvoll":     { lat: 60.3305, lng: 11.2616, radius: 20 },
  "råholt":       { lat: 60.2751, lng: 11.1790, radius: 15 },
  "raholt":       { lat: 60.2751, lng: 11.1790, radius: 15 },
  "lena":         { lat: 60.6739, lng: 10.8132, radius: 15 },
  "moelv":        { lat: 60.9283, lng: 10.7010, radius: 15 },

  // ── Innlandet — nye ──
  "brumunddal":   { lat: 60.8836, lng: 10.9449, radius: 20 },
  "gjøvik":       { lat: 60.7957, lng: 10.6916, radius: 25 },
  "gjovik":       { lat: 60.7957, lng: 10.6916, radius: 25 },
  "elverum":      { lat: 60.8819, lng: 11.5623, radius: 20 },
  "kongsvinger":  { lat: 60.1905, lng: 11.9977, radius: 25 },
  "trysil":       { lat: 61.3162, lng: 12.2594, radius: 30 },
  "otta":         { lat: 61.7712, lng: 9.5353,  radius: 20 },
  "tynset":       { lat: 62.2752, lng: 10.7855, radius: 20 },
  "røros":        { lat: 62.5743, lng: 11.3834, radius: 20 },
  "roros":        { lat: 62.5743, lng: 11.3834, radius: 20 },

  // ── Buskerud/dalfører ──
  "hol":          { lat: 60.6151, lng: 8.2940,  radius: 25 },
  "hallingdal":   { lat: 60.6670, lng: 8.7778,  radius: 50 },

  // ── Sørlandet — nye ──
  "arendal":      { lat: 58.4612, lng: 8.7670,  radius: 25 },
  "grimstad":     { lat: 58.3405, lng: 8.5934,  radius: 20 },
  "risør":        { lat: 58.7206, lng: 9.2342,  radius: 20 },
  "risor":        { lat: 58.7206, lng: 9.2342,  radius: 20 },
  "tvedestrand":  { lat: 58.6227, lng: 8.9311,  radius: 15 },
  "mandal":       { lat: 58.0268, lng: 7.4535,  radius: 20 },
  "lyngdal":      { lat: 58.1376, lng: 7.0700,  radius: 20 },
  "lindesnes":    { lat: 58.0264, lng: 7.4502,  radius: 25 },
  "setesdal":     { lat: 59.0546, lng: 7.5746,  radius: 50 },

  // ── Vestlandet — nye ──
  "florø":        { lat: 61.5996, lng: 5.0329,  radius: 20 },
  "floro":        { lat: 61.5996, lng: 5.0329,  radius: 20 },
  "førde":        { lat: 61.4522, lng: 5.8572,  radius: 20 },
  "forde":        { lat: 61.4522, lng: 5.8572,  radius: 20 },
  "sogndal":      { lat: 61.2291, lng: 7.0967,  radius: 20 },
  "lærdal":       { lat: 61.0984, lng: 7.4810,  radius: 20 },
  "lerdal":       { lat: 61.0984, lng: 7.4810,  radius: 20 },
  "aurland":      { lat: 60.9055, lng: 7.1873,  radius: 25 },
  "voss":         { lat: 60.6278, lng: 6.4183,  radius: 25 },
  "ulvik":        { lat: 60.5679, lng: 6.9165,  radius: 15 },
  "stord":        { lat: 59.7808, lng: 5.4997,  radius: 20 },
  "etne":         { lat: 59.6653, lng: 5.9371,  radius: 15 },
  "stryn":        { lat: 61.9026, lng: 6.7179,  radius: 25 },
  "geiranger":    { lat: 62.1019, lng: 7.2072,  radius: 20 },
  "sandane":      { lat: 61.7770, lng: 6.2164,  radius: 15 },
  "bryne":        { lat: 58.7354, lng: 5.6477,  radius: 15 },
  "egersund":     { lat: 58.4525, lng: 6.0018,  radius: 20 },

  // ── Trøndelag — nye ──
  "stjørdal":     { lat: 63.4669, lng: 10.9126, radius: 20 },
  "stjordal":     { lat: 63.4669, lng: 10.9126, radius: 20 },
  "levanger":     { lat: 63.7464, lng: 11.2996, radius: 20 },
  "verdal":       { lat: 63.7914, lng: 11.4768, radius: 20 },
  "steinkjer":    { lat: 64.0148, lng: 11.4954, radius: 25 },
  "tingvoll":     { lat: 62.9131, lng: 8.2056,  radius: 20 },
  "rennebu":      { lat: 62.8287, lng: 10.0089, radius: 20 },

  // ── Nord-Norge — nye ──
  "mosjøen":      { lat: 65.8370, lng: 13.1914, radius: 25 },
  "mosjoen":      { lat: 65.8370, lng: 13.1914, radius: 25 },
  "brønnøysund":  { lat: 65.4681, lng: 12.2075, radius: 20 },
  "bronnoysund":  { lat: 65.4681, lng: 12.2075, radius: 20 },
  "mo i rana":    { lat: 66.3128, lng: 14.1428, radius: 25 },
  "fauske":       { lat: 67.2595, lng: 15.3933, radius: 20 },
  "narvik":       { lat: 68.4383, lng: 17.4278, radius: 30 },
  "sortland":     { lat: 68.6982, lng: 15.4138, radius: 25 },
  "stamsund":     { lat: 68.1301, lng: 13.8493, radius: 15 },
  "vesterålen":   { lat: 68.8364, lng: 14.5414, radius: 50 },
  "vesteralen":   { lat: 68.8364, lng: 14.5414, radius: 50 },
  "lofoten":      { lat: 68.0453, lng: 13.3824, radius: 50 },
  "alta":         { lat: 69.9689, lng: 23.2716, radius: 30 },
  "hammerfest":   { lat: 70.6634, lng: 23.6821, radius: 25 },
  "kirkenes":     { lat: 69.7271, lng: 30.0450, radius: 25 },
  "vadsø":        { lat: 70.0803, lng: 29.7309, radius: 25 },
  "vadso":        { lat: 70.0803, lng: 29.7309, radius: 25 },

  // ── Fylker / regioner — nye (bred radius) ──
  "vestland":     { lat: 60.7000, lng: 6.3000,  radius: 100 },
  "vestfold":     { lat: 59.3000, lng: 10.2000, radius: 80 },
  "telemark":     { lat: 59.2161, lng: 9.6112,  radius: 90 },
  "agder":        { lat: 58.5000, lng: 7.5000,  radius: 90 },
  "innlandet":    { lat: 61.5000, lng: 11.0000, radius: 120 },
  "trøndelag":    { lat: 63.7000, lng: 11.0000, radius: 120 },
  "trondelag":    { lat: 63.7000, lng: 11.0000, radius: 120 },
  "nordland":     { lat: 67.5000, lng: 14.0000, radius: 120 },
  "troms":        { lat: 69.5000, lng: 19.0000, radius: 100 },
  "finnmark":     { lat: 70.0000, lng: 25.0000, radius: 120 },

  // ── PR-78: Storby-bydeler (neighborhoods) ──
  // Fixes Kartverket Stedsnavn ambiguity where common neighborhood names
  // (e.g. "Oppsal") collide with rural places elsewhere in Norway.
  // The first Kartverket match for "Oppsal" is Lier (59.847, 10.267)
  // rather than Oslo-east (59.886, 10.879). Hardcoding here bypasses the
  // ambiguous Stedsnavn lookup. Radius is small (2-6 km, neighborhood-
  // scale) so the geo-filter stays local to the bydel rather than the
  // whole city. ASCII-aliaser for ø/å/æ follow the existing pattern.

  // ── Oslo bydeler (fixes Oppsal/Bøler/Manglerud disambiguation) ──
  "oppsal":            { lat: 59.886, lng: 10.879, radius: 4 },
  "bøler":             { lat: 59.881, lng: 10.864, radius: 4 },
  "boler":             { lat: 59.881, lng: 10.864, radius: 4 },
  "manglerud":         { lat: 59.890, lng: 10.845, radius: 4 },
  "grünerløkka":       { lat: 59.923, lng: 10.760, radius: 3 },
  "grunerlokka":       { lat: 59.923, lng: 10.760, radius: 3 },
  "vålerenga":         { lat: 59.910, lng: 10.778, radius: 3 },
  "valerenga":         { lat: 59.910, lng: 10.778, radius: 3 },
  "tøyen":             { lat: 59.917, lng: 10.769, radius: 3 },
  "toyen":             { lat: 59.917, lng: 10.769, radius: 3 },
  "sagene":            { lat: 59.937, lng: 10.760, radius: 3 },
  "frogner":           { lat: 59.924, lng: 10.706, radius: 4 },
  "majorstuen":        { lat: 59.928, lng: 10.715, radius: 3 },
  "bjørvika":          { lat: 59.907, lng: 10.755, radius: 2 },
  "bjorvika":          { lat: 59.907, lng: 10.755, radius: 2 },
  "bislett":           { lat: 59.925, lng: 10.738, radius: 2 },
  "st. hanshaugen":    { lat: 59.929, lng: 10.737, radius: 3 },
  "st-hanshaugen":     { lat: 59.929, lng: 10.737, radius: 3 },
  "torshov":           { lat: 59.940, lng: 10.760, radius: 3 },
  "sinsen":            { lat: 59.943, lng: 10.785, radius: 3 },
  "carl berner":       { lat: 59.927, lng: 10.789, radius: 3 },
  "ekeberg":           { lat: 59.890, lng: 10.770, radius: 4 },
  "holmlia":           { lat: 59.838, lng: 10.799, radius: 4 },
  "mortensrud":        { lat: 59.842, lng: 10.836, radius: 4 },
  "bjørndal":          { lat: 59.823, lng: 10.829, radius: 4 },
  "bjorndal":          { lat: 59.823, lng: 10.829, radius: 4 },
  "tveita":            { lat: 59.916, lng: 10.864, radius: 3 },
  "furuset":           { lat: 59.940, lng: 10.901, radius: 4 },
  "lambertseter":      { lat: 59.871, lng: 10.806, radius: 4 },
  "linderud":          { lat: 59.951, lng: 10.840, radius: 4 },
  "romsås":            { lat: 59.963, lng: 10.886, radius: 5 },
  "romsas":            { lat: 59.963, lng: 10.886, radius: 5 },
  "nydalen":           { lat: 59.948, lng: 10.762, radius: 4 },
  "storo":             { lat: 59.946, lng: 10.776, radius: 3 },
  "bryn":              { lat: 59.913, lng: 10.819, radius: 3 },
  "skøyen":            { lat: 59.923, lng: 10.677, radius: 4 },
  "skoyen":            { lat: 59.923, lng: 10.677, radius: 4 },
  "smestad":           { lat: 59.939, lng: 10.667, radius: 4 },
  "røa":               { lat: 59.948, lng: 10.642, radius: 4 },
  "roa":               { lat: 59.948, lng: 10.642, radius: 4 },

  // ── Bergen bydeler ──
  "fyllingsdalen":     { lat: 60.358, lng: 5.265,  radius: 5 },
  "sandviken":         { lat: 60.412, lng: 5.314,  radius: 4 },
  "åsane":             { lat: 60.460, lng: 5.327,  radius: 6 },
  "asane":             { lat: 60.460, lng: 5.327,  radius: 6 },
  "laksevåg":          { lat: 60.382, lng: 5.270,  radius: 5 },
  "laksevag":          { lat: 60.382, lng: 5.270,  radius: 5 },
  "loddefjord":        { lat: 60.350, lng: 5.183,  radius: 5 },
  "nesttun":           { lat: 60.317, lng: 5.358,  radius: 5 },
  "arna":              { lat: 60.421, lng: 5.480,  radius: 6 },
  "paradis (bergen)":  { lat: 60.357, lng: 5.336,  radius: 4 },

  // ── Trondheim bydeler ──
  "sluppen":           { lat: 63.398, lng: 10.391, radius: 4 },
  "lade":              { lat: 63.452, lng: 10.444, radius: 5 },
  "heimdal":           { lat: 63.355, lng: 10.341, radius: 5 },
  "singsaker":         { lat: 63.428, lng: 10.412, radius: 3 },
  "ila":               { lat: 63.434, lng: 10.366, radius: 3 },
  "lerkendal":         { lat: 63.412, lng: 10.408, radius: 3 },

  // ── Stavanger bydeler ──
  "madla":             { lat: 58.953, lng: 5.671,  radius: 5 },
  "storhaug":          { lat: 58.972, lng: 5.751,  radius: 3 },
  "hillevåg":          { lat: 58.939, lng: 5.726,  radius: 4 },
  "hillevag":          { lat: 58.939, lng: 5.726,  radius: 4 },
  "hundvåg":           { lat: 58.998, lng: 5.751,  radius: 5 },
  "hundvag":           { lat: 58.998, lng: 5.751,  radius: 5 },
};

// ── Shared distance helper (dev-request 2026-07-04-opplevagent-naer-meg-
// geosok, item 2) ──────────────────────────────────────────────────
// MOVED (dev-request 2026-07-25-reisesok…, Fase 2a — «konsolider de tre
// duplikate haversine-implementasjonene til én delt modul»): the formula now
// lives ONCE in services/geo-distance.ts, a PURE module (no DB, no network, no
// vertical) that marketplace-registry.ts, matching-engine.ts and the corridor
// engine can all import without coupling.
//
// This file used to document why marketplace-registry.ts kept a private
// duplicate rather than importing from here: geocoding-service pulls in
// database/init's getDb, and the rfb registry is deliberately vertical-isolated.
// geo-distance.ts has no such dependency, so that reason is gone and so is the
// duplicate.
//
// RE-exported (not merely moved) so the existing OpplevAgent call sites —
// experience-store.ts does `import { haversineDistanceKm } from
// "./geocoding-service"` — keep resolving unchanged.
export { haversineDistanceKm } from "./geo-distance";

// ── Kartverket navneobjekttype allowlist (dev-request 2026-07-25 fix 0c) ──
//
// Before this, lookupKartverket() preferred a populated-place type but fell
// back to `data.navn[0]` when none of the top-3 hits matched. Kartverket's
// `sok` is fuzzy, so ANY string that resembles a registered name produced a
// point — and the caller had no way to tell a real town from a holiday cabin.
// Live proof (measured 2026-07-25): `blåskjell` returns exactly one hit, the
// FRITIDSBOLIG «Blåskjell» in Larvik (58.9699, 9.89022). extractAndGeocode()
// therefore geocoded `blåskjell Kautokeino` to Larvik — 1 400 km wrong — and
// never even tried the word «Kautokeino» (which resolves correctly to the
// Tettsted Guovdageaidnu, 69.01243/23.04101).
//
// The fix is a STRICT, exact-match (case-insensitive) allowlist, checked in
// three tiers so a genuine settlement always beats a mere administrative or
// landscape polygon. Types are the literal `navneobjekttype` strings from
// https://ws.geonorge.no/stedsnavn/v1/navneobjekttyper (291 of them). Exact
// match, not substring: the old `.includes("By")` also accepted
// «Bygg for jordbruk, fiske og fangst» and friends.
//
// Anything outside all three tiers is REJECTED — no navn[0] fallback. A
// rejected lookup falls through to the kommune-register lookup below, and
// failing that returns null so the caller can be honest about having no geo
// rather than confidently pointing at the wrong end of the country.

// Tier 1 — towns and cities: the biggest settlement that can carry a name.
const MAJOR_SETTLEMENT_TYPES = new Set([
  "tettsted", "statistisk tettsted", "tettbebyggelse",
  "by", "bydel", "administrativ bydel",
]);

// Tier 2 — administrative areas (kommune/fylke centroids).
const ADMIN_AREA_TYPES = new Set([
  "kommune", "fylke", "annen administrativ inndeling",
]);

// Tier 3 — named landscape/landmass regions people genuinely search by
// («Lofoten», «Hardanger», «Valdres», «Vega», «Frosta»). Coarse, but real
// geography with a defensible representative point — unlike a cabin.
const REGION_PLACE_TYPES = new Set([
  "landskapsområde", "dalføre", "øy i sjø", "øygruppe i sjø",
  "halvøy i sjø", "øy i vann", "fjellområde",
]);

// Tier 4 — MINOR settlements: real places, but hamlet-scale. Ranked LAST
// (review follow-up R1).
//
// These used to sit in tier 1 alongside towns, which meant a hamlet
// out-ranked an island, a kommune or a region of the same name and the search
// never even looked further down. Measured 2026-07-25:
//   «Frøya»   → Grend in Bremanger, Vestland (61.7723, 4.8919) instead of the
//               Trøndelag island (63.6721, 8.3343) — 275 km, so `sjømat Frøya`
//               searched a 15 km circle around a hamlet in the wrong fjord.
//   «Sunndal» → Bygdelag in Kvinnherad instead of Sunndal kommune — 309 km.
//   «Tysnes»  → the bilingual Grend «Diksná/Tysnes» in the north instead of
//               Tysnes kommune in Vestland — 1 045 km.
// All three are the confident-wrong-point class 0a/0c exist to eliminate, and
// «Frøya» was a REGRESSION against main (which returned the island).
//
// Demoting them is strictly better than the alternative fix (consult the
// kommune register when tier 1 is a minor type): Kommuneinfo's Frøya centroid
// is (64.0705, 8.8895), ~50 km off the island, because the kommune is a wide
// archipelago. The named island itself is the better answer.
//
// Validated across 181 live names: 0 lost, 0 gained, 19 moved, every move a
// correction or a <20 km refinement.
const MINOR_SETTLEMENT_TYPES = new Set([
  "grend", "bygdelag (bygd)", "poststed", "boligfelt", "tettsteddel",
]);

/** All settlement types, major and minor — the "a person lives here" test. */
const POPULATED_PLACE_TYPES = new Set([...MAJOR_SETTLEMENT_TYPES, ...MINOR_SETTLEMENT_TYPES]);

/** Preference order used by lookupKartverket(). Earlier tiers win outright. */
const PLACE_TYPE_TIERS: ReadonlyArray<ReadonlySet<string>> = [
  MAJOR_SETTLEMENT_TYPES,
  ADMIN_AREA_TYPES,
  REGION_PLACE_TYPES,
  MINOR_SETTLEMENT_TYPES,
];

/** True if Kartverket's navneobjekttype is a place we are willing to geocode to. */
export function isAcceptablePlaceType(navneobjekttype: string | null | undefined): boolean {
  const t = (navneobjekttype || "").toLowerCase().trim();
  return PLACE_TYPE_TIERS.some((tier) => tier.has(t));
}

/** 0-based preference tier of a type, or -1 when it is not acceptable at all. Exported for tests. */
export function placeTypeTier(navneobjekttype: string | null | undefined): number {
  const t = (navneobjekttype || "").toLowerCase().trim();
  return PLACE_TYPE_TIERS.findIndex((tier) => tier.has(t));
}

// ── Name-similarity guard (review follow-up, item 5) ───────────────
//
// The type allowlist alone is not enough. Kartverket's `sok` is fuzzy, so a
// record can be an ACCEPTABLE TYPE and still not be the place that was asked
// for. Measured 2026-07-25:
//   • "nes"   → the top Tettsted hit is «Tingnes» (60.7621, 10.94127), which
//               merely lists "Nes" as a subordinate name.
//   • "våler" → the top Tettsted hit is «Vålbyen».
// Raising treffPerSide from 3 to 10 also changed Kartverket's own ordering,
// so which loosely-related name won became page-size dependent ("sande" moved
// ~370 km). A type check cannot catch any of that.
//
// The discriminator is `navnestatus`. Kartverket marks a record's OFFICIAL
// name(s) `hovednavn` — one per language — and subordinate/aliased forms
// `undernavn` (and similar). So:
//   • «Tingnes» lists ('Tingnes', hovednavn) + ('Nes', UNDERNAVN)  → rejected
//   • «Guovdageaidnu» lists five hovednavn, one per language, including
//     ('Kautokeino', hovednavn, Norsk)                             → accepted
// which is exactly the distinction we need: real multilingual place names
// (Sami/Kvensk/Norwegian) keep working, loose aliases do not.
//
// "<query> kommune" / "<query> herad" also count: Kartverket names the
// administrative record «Dyrøy kommune», «Kvam herad».

/** A record's official name(s) — hovednavn entries, falling back to the first listed. */
export function officialNames(n: any): string[] {
  const entries: any[] = Array.isArray(n?.stedsnavn) ? n.stedsnavn : [];
  const hoved = entries.filter((e) => e?.navnestatus === "hovednavn").map((e) => e?.skrivemåte || "");
  if (hoved.length > 0) return hoved.filter(Boolean);
  return entries.slice(0, 1).map((e) => e?.skrivemåte || "").filter(Boolean);
}

/** Diacritic- and case-insensitive normalisation (ø→o, æ→ae, å→a, accents stripped). */
function normalizePlaceName(s: string): string {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

/** True when one of the record's OFFICIAL names is the name that was searched for. */
export function nameMatchesQuery(n: any, query: string): boolean {
  const q = normalizePlaceName(query);
  if (!q) return false;
  return officialNames(n).some((name) => {
    const v = normalizePlaceName(name);
    return v === q || v === `${q} kommune` || v === `${q} herad`;
  });
}

// ── Radius heuristic based on place type ──
// Exact match on the same normalised type strings as the allowlist above
// (the old substring test made "Bygg for jordbruk…" a 30 km "by").
function radiusForType(type: string): number {
  const t = (type || "").toLowerCase().trim();
  if (t === "bydel" || t === "administrativ bydel" || t === "tettsteddel" || t === "boligfelt") return 10;
  if (POPULATED_PLACE_TYPES.has(t)) return 15;
  // (falls through to the tiers below for admin/region types)
  if (t === "kommune" || t === "annen administrativ inndeling") return 30;
  if (t === "fylke") return 90;
  if (REGION_PLACE_TYPES.has(t)) return 50;
  return 25; // sensible default
}

/**
 * Search radius from a kommune's Kartverket bounding box: the larger of the
 * two half-extents, so the whole kommune is reachable from its centroid.
 * Clamped to 10–120 km (a kommune-centroid hit is approximate by definition;
 * an unclamped Kautokeino would ask for ~90 km of nothing).
 */
export function radiusFromBoundingBox(box: any, centroidLat: number): number {
  const ring = box?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 3) return 30;
  const lats = ring.map((p: any) => Number(p?.[1])).filter((n: number) => Number.isFinite(n));
  const lngs = ring.map((p: any) => Number(p?.[0])).filter((n: number) => Number.isFinite(n));
  if (lats.length < 2 || lngs.length < 2) return 30;
  const halfLatKm = ((Math.max(...lats) - Math.min(...lats)) / 2) * 111;
  const halfLngKm = ((Math.max(...lngs) - Math.min(...lngs)) / 2) * 111 * Math.cos(centroidLat * (Math.PI / 180));
  const r = Math.max(halfLatKm, Math.abs(halfLngKm));
  if (!Number.isFinite(r) || r <= 0) return 30;
  return Math.round(Math.min(120, Math.max(10, r)));
}

class GeocodingService {

  /**
   * Resolve a place name to coordinates.
   * Returns null if the name can't be geocoded.
   */
  async geocode(placeName: string): Promise<GeoResult | null> {
    const key = placeName.toLowerCase().trim();
    if (!key || key.length < 2) return null;

    // 1. Cache hit
    if (geoCache.has(key)) return geoCache.get(key) || null;

    // 2. Hardcoded major cities (instant)
    const hardcoded = MAJOR_CITIES[key];
    if (hardcoded) {
      const result: GeoResult = {
        lat: hardcoded.lat,
        lng: hardcoded.lng,
        name: placeName,
        radiusKm: hardcoded.radius,
        source: "hardcoded",
      };
      this.cacheResult(key, result);
      return result;
    }

    // 3. Agent database lookup (any city where we have agents)
    const dbResult = this.lookupInDatabase(key);
    if (dbResult) {
      this.cacheResult(key, dbResult);
      return dbResult;
    }

    // 4. Kartverket Stedsnavn API (covers ALL Norwegian places)
    let apiResult = await this.lookupKartverket(key);

    // 5. Kommune-register fallback (dev-request 2026-07-25 fix 0a/0c).
    //    Stedsnavn's fuzzy `sok` frequently ranks a farm/cabin/church above
    //    (or instead of) the kommune that carries the same name — «Flakstad»
    //    returns 8 hits with the Navnegard «Flagstad» near Hamar first and
    //    Flakstad kommune in Lofoten never typed as a Kommune at all. Now
    //    that step 4 rejects those, ask the authoritative kommune register
    //    (Kommuneinfo) instead of guessing. Only reached when Stedsnavn had
    //    nothing acceptable, so the common path costs no extra request.
    if (!apiResult) apiResult = await this.lookupKommuneinfo(key);

    this.cacheResult(key, apiResult); // cache null too to avoid repeated API calls
    return apiResult;
  }

  /**
   * Resolve a KOMMUNE (municipality) to its official representative point.
   *
   * dev-request 2026-07-25 fix 0a. The experiences geocode worker used to call
   * geocode() for this, which meant a kommune name was resolved by Kartverket
   * Stedsnavn's fuzzy free-text search. For «Flakstad» that returned the
   * Navnegard «Flagstad» at Hamar (60.81836, 11.10518) — so every experience
   * in Flakstad kommune (Lofoten) was stored at Hamar, and OpplevAgent's
   * discover_experiences at Elverum reported «Nusfjord Arctic Resort» as
   * 26.2 km away when it is 788 km away.
   *
   * This goes to Kartverket's Kommuneinfo register instead, which only knows
   * about kommuner — a name that is not a kommune simply 404s. Prefers the
   * kommunenummer when the caller has one (experience_providers already
   * stores it), because that is exact and immune to name changes/aliases.
   */
  async geocodeKommune(kommuneName: string | null | undefined, kommunenummer?: string | null): Promise<GeoResult | null> {
    const nr = (kommunenummer || "").trim();
    const name = (kommuneName || "").trim();
    if (!nr && name.length < 2) return null;

    const key = nr ? `kommunenr:${nr}` : `kommune:${name.toLowerCase()}`;
    if (geoCache.has(key)) return geoCache.get(key) || null;

    let result: GeoResult | null = null;
    if (/^\d{4}$/.test(nr)) result = await this.lookupKommuneinfoByNumber(nr);
    if (!result && name) result = await this.lookupKommuneinfo(name);
    // Last resort: the generic geocoder (hardcoded table / agents DB / the
    // now-strict Stedsnavn lookup). Deliberately AFTER the kommune register
    // so a real kommune can never lose to a same-named farm again.
    if (!result && name) result = await this.geocode(name);

    this.cacheResult(key, result);
    return result;
  }

  /**
   * Extract location words from a search query and try to geocode them.
   * Returns the first successful geocode result.
   * Tries multi-word combos first ("mo i rana"), then single words.
   */
  async extractAndGeocode(query: string): Promise<GeoResult | null> {
    const q = query.toLowerCase().replace(/[?!.,]/g, "").trim();

    // Common Norwegian prepositions and food terms to skip
    const skipWords = new Set([
      "i", "på", "fra", "nær", "ved", "hos", "til", "og", "eller", "med",
      "fersk", "ferske", "økologisk", "økologiske", "lokal", "lokale",
      "billig", "billige", "god", "gode", "beste", "best",
      "hvor", "finner", "jeg", "kan", "kjøpe", "finne", "selger",
      "grønnsaker", "grønt", "frukt", "bær", "kjøtt", "fisk", "brød",
      "meieri", "ost", "melk", "egg", "honning", "urter", "sjømat",
      "poteter", "potet", "gulrøtter", "gulrot", "tomat", "tomater",
      "epler", "eple", "pærer", "jordbær", "blåbær", "bringebær",
      "lam", "kylling", "svin", "storfe", "laks", "torsk", "reker",
      "lefse", "boller", "grovbrød", "surdeig", "smør", "yoghurt",
      "løk", "kål", "agurk", "paprika", "spinat", "salat",
      "mat", "butikk", "butikker", "marked", "gård", "gårdsbutikk",
      "produsent", "produsenter", "bonde", "bonden", "selge", "selges",
      // dev-request 2026-07-25 fix 0c — product words that are ALSO
      // registered Norwegian place names. «blåskjell» is a Fritidsbolig in
      // Larvik; the strict navneobjekttype filter in lookupKartverket()
      // already rejects it, but skipping them here means we never spend an
      // HTTP round-trip on a word that is obviously food in the first place.
      "blåskjell", "skjell", "kamskjell", "østers", "hummer", "krabbe",
      "sopp", "vilt", "geit", "gris", "kalv", "sau", "and", "elg",
      "spekemat", "pølser", "pølse", "syltetøy", "saft", "most", "cider",
      "sider", "øl", "vin", "mjød", "gårdsutsalg", "gårdssalg", "reko",
    ]);

    const words = q.split(/\s+/).filter(w => w.length >= 2);

    // Try 3-word combos first (e.g. "mo i rana")
    for (let i = 0; i < words.length - 2; i++) {
      const combo = words.slice(i, i + 3).join(" ");
      if (!words.slice(i, i + 3).every(w => skipWords.has(w))) {
        const result = await this.geocode(combo);
        if (result) return result;
      }
    }

    // Try 2-word combos (e.g. "oslo sentrum", "kristiansand s")
    for (let i = 0; i < words.length - 1; i++) {
      const combo = words[i] + " " + words[i + 1];
      if (!skipWords.has(words[i]) || !skipWords.has(words[i + 1])) {
        const result = await this.geocode(combo);
        if (result) return result;
      }
    }

    // Try single words (skip known food/preposition terms)
    for (const word of words) {
      if (skipWords.has(word)) continue;
      const result = await this.geocode(word);
      if (result) return result;
    }

    return null;
  }

  // ── Private helpers ──

  private lookupInDatabase(key: string): GeoResult | null {
    try {
      const db = getDb();
      const row = db.prepare(
        "SELECT lat, lng, city FROM agents WHERE LOWER(city) = ? AND lat IS NOT NULL AND lng IS NOT NULL LIMIT 1"
      ).get(key) as { lat: number; lng: number; city: string } | undefined;

      if (row) {
        return {
          lat: row.lat,
          lng: row.lng,
          name: row.city,
          radiusKm: 30,
          source: "database",
        };
      }
    } catch { /* DB not ready yet */ }
    return null;
  }

  private async lookupKartverket(placeName: string): Promise<GeoResult | null> {
    try {
      // treffPerSide raised 3 → 10: the acceptable place type is often ranked
      // below several farms/cabins sharing the name (measured: «Bømlo» has the
      // Kommune at hit #3, «Dønna» the Poststed at #4). With the strict filter
      // below, looking at only 3 hits would reject genuine places.
      const url = `https://ws.geonorge.no/stedsnavn/v1/sted?sok=${encodeURIComponent(placeName)}&treffPerSide=10&utkoordsys=4258`;

      const data: any = await this.getJson(url);
      if (!data || !Array.isArray(data.navn) || data.navn.length === 0) return null;

      const hasPoint = (n: any) =>
        n?.representasjonspunkt && n.representasjonspunkt.nord != null && n.representasjonspunkt.øst != null;
      const typeOf = (n: any) => (n?.navneobjekttype || "").toLowerCase().trim();
      const pick = (allowed: ReadonlySet<string>) =>
        data.navn.find((n: any) =>
          hasPoint(n) && allowed.has(typeOf(n)) && nameMatchesQuery(n, placeName));

      // Tier order: town/city > administrative area > named region > hamlet.
      // NO navn[0] fallback — an unrecognised type means "we do not know
      // where this is", which is strictly better than a confident wrong point.
      let best: any;
      for (const tier of PLACE_TYPE_TIERS) {
        best = pick(tier);
        if (best) break;
      }
      if (!best) {
        const rejected = data.navn
          .map((n: any) => `${officialNames(n)[0] || "?"}[${n?.navneobjekttype || "?"}]`)
          .join(", ");
        console.log(`[geocoding] rejected low-confidence Kartverket match for "${placeName}" (candidates: ${rejected || "none"})`);
        return null;
      }

      const punkt = best.representasjonspunkt;
      return {
        lat: punkt.nord,
        lng: punkt.øst,
        name: officialNames(best)[0] || placeName,
        radiusKm: radiusForType(best.navneobjekttype || ""),
        source: "kartverket",
        placeType: best.navneobjekttype || undefined,
      };
    } catch (err) {
      // Network error or timeout — fail gracefully
      console.error(`[geocoding] Kartverket lookup failed for "${placeName}":`, err);
      return null;
    }
  }

  // ── Kartverket Kommuneinfo (the kommune register) ────────────────
  // https://ws.geonorge.no/kommuneinfo/v1/ — free, no API key, CC BY 4.0,
  // same terms as Stedsnavn. `punktIOmrade` is the kommune's official
  // representative point; `avgrensningsboks` its bounding box, which gives a
  // far better search radius than a flat 30 km (Flakstad ≈ 30 km, Oslo ≈ 12).
  // A name that is not a kommune returns HTTP 404, so there is no fuzzy
  // false-positive class here at all.

  private async lookupKommuneinfo(name: string): Promise<GeoResult | null> {
    try {
      const url = `https://ws.geonorge.no/kommuneinfo/v1/sok?knavn=${encodeURIComponent(name)}&utkoordsys=4258`;
      const data: any = await this.getJson(url);
      const list: any[] = Array.isArray(data?.kommuner) ? data.kommuner : [];
      if (list.length === 0) return null;

      // Ambiguity must be REFUSED, not silently resolved to list[0] (review
      // follow-up, item 4). Norway has genuinely duplicated kommune names, and
      // the register returns them all — measured 2026-07-25:
      //   «Herøy» → 1818 Nordland (66.133, 11.606) AND 1515 Møre og Romsdal
      //             (62.439, 5.293)  — ~450 km apart
      //   «Våler» → 3419 Innlandet  AND 3114 Østfold — ~150 km apart
      // The previous code ran the exact-name search BEFORE the "only one hit"
      // guard, so `exact` found the first of the two and returned it with full
      // confidence — the same class of bug as 0a, one layer down. There is no
      // honest way to choose between two kommuner with the same name, so we
      // return null and let the caller be honest about having no geo. Callers
      // that DO know which one (experience_providers.kommunenummer) go through
      // lookupKommuneinfoByNumber(), which is exact and unaffected.
      const norm = (s: string) => (s || "").toLowerCase().normalize("NFC").trim();
      const target = norm(name);
      const isExact = (k: any) =>
        norm(k.kommunenavn) === target ||
        norm(k.kommunenavnNorsk) === target ||
        (Array.isArray(k.gyldigeNavn) && k.gyldigeNavn.some((g: any) => g?.navn && norm(g.navn) === target));

      const exact = list.filter(isExact);
      if (exact.length > 1 || (exact.length === 0 && list.length > 1)) {
        const which = list.map((k) => `${k.kommunenavn} ${k.kommunenummer}`).join(" / ");
        console.log(`[geocoding] refusing ambiguous kommune name "${name}" — ${list.length} candidates: ${which}`);
        return null;
      }
      const hit = exact[0] || (list.length === 1 ? list[0] : null);
      return hit ? this.kommuneToGeoResult(hit, name) : null;
    } catch (err) {
      console.error(`[geocoding] Kommuneinfo lookup failed for "${name}":`, err);
      return null;
    }
  }

  private async lookupKommuneinfoByNumber(kommunenummer: string): Promise<GeoResult | null> {
    try {
      const url = `https://ws.geonorge.no/kommuneinfo/v1/kommuner/${encodeURIComponent(kommunenummer)}?utkoordsys=4258`;
      const data: any = await this.getJson(url);
      return data ? this.kommuneToGeoResult(data, kommunenummer) : null;
    } catch (err) {
      console.error(`[geocoding] Kommuneinfo lookup failed for kommunenummer ${kommunenummer}:`, err);
      return null;
    }
  }

  private kommuneToGeoResult(k: any, fallbackName: string): GeoResult | null {
    const coords = k?.punktIOmrade?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      lat,
      lng,
      name: k.kommunenavnNorsk || k.kommunenavn || fallbackName,
      radiusKm: radiusFromBoundingBox(k?.avgrensningsboks, lat),
      source: "kommuneinfo",
      placeType: "Kommune",
    };
  }

  /** Shared GET+JSON with the existing 3s abort budget. Non-2xx (incl. Kommuneinfo's 404-on-no-match) → null. */
  private async getJson(url: string): Promise<any | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { "Accept": "application/json" },
      });
      if (!response.ok) return null;
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private cacheResult(key: string, result: GeoResult | null): void {
    // Evict oldest entries if cache is full
    if (geoCache.size >= CACHE_MAX) {
      const firstKey = geoCache.keys().next().value;
      if (firstKey) geoCache.delete(firstKey);
    }
    geoCache.set(key, result);
  }
}

export const geocodingService = new GeocodingService();
