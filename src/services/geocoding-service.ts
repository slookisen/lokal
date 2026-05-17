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
  source: "cache" | "hardcoded" | "database" | "kartverket";
}

// ── In-memory cache (survives request cycle, clears on restart) ──
const geoCache = new Map<string, GeoResult | null>();
const CACHE_MAX = 500;

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

// ── Radius heuristic based on place type ──
function radiusForType(type: string): number {
  const t = type.toLowerCase();
  if (t.includes("tettsted") || t.includes("bydel") || t.includes("grend")) return 15;
  if (t.includes("by") || t.includes("kommune")) return 30;
  if (t.includes("fylke") || t.includes("region")) return 60;
  return 25; // sensible default
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
    const apiResult = await this.lookupKartverket(key);
    this.cacheResult(key, apiResult); // cache null too to avoid repeated API calls
    return apiResult;
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
      const url = `https://ws.geonorge.no/stedsnavn/v1/sted?sok=${encodeURIComponent(placeName)}&treffPerSide=3&utkoordsys=4258`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "Accept": "application/json" },
      });
      clearTimeout(timeout);

      if (!response.ok) return null;

      const data: any = await response.json();
      if (!data.navn || data.navn.length === 0) return null;

      // Prefer results that are populated places (tettsted, by, bydel)
      // over mountains, lakes etc.
      const placeTypes = ["Tettsted", "By", "Bydel", "Kommune", "Grend", "Bygd"];
      let best = data.navn.find((n: any) =>
        placeTypes.some(t => (n.navneobjekttype || "").includes(t))
      );
      if (!best) best = data.navn[0]; // fallback to first result

      const punkt = best.representasjonspunkt;
      if (!punkt || punkt.nord == null || punkt.øst == null) return null;

      return {
        lat: punkt.nord,
        lng: punkt.øst,
        name: best.stedsnavn?.[0]?.skrivemåte || placeName,
        radiusKm: radiusForType(best.navneobjekttype || ""),
        source: "kartverket",
      };
    } catch (err) {
      // Network error or timeout — fail gracefully
      console.error(`[geocoding] Kartverket lookup failed for "${placeName}":`, err);
      return null;
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
