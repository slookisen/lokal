"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.geocodingService = void 0;
const init_1 = require("../database/init");
// ── In-memory cache (survives request cycle, clears on restart) ──
const geoCache = new Map();
const CACHE_MAX = 500;
// ── Top-20 cities hardcoded for speed (no API call needed) ──
// These cover >80% of searches. Everything else goes to API.
const MAJOR_CITIES = {
    "oslo": { lat: 59.9139, lng: 10.7522, radius: 25 },
    "bergen": { lat: 60.3913, lng: 5.3221, radius: 30 },
    "trondheim": { lat: 63.4305, lng: 10.3951, radius: 30 },
    "stavanger": { lat: 58.9700, lng: 5.7331, radius: 30 },
    "tromsø": { lat: 69.6496, lng: 18.9560, radius: 30 },
    "tromso": { lat: 69.6496, lng: 18.9560, radius: 30 },
    "kristiansand": { lat: 58.1599, lng: 8.0182, radius: 30 },
    "drammen": { lat: 59.7441, lng: 10.2045, radius: 25 },
    "fredrikstad": { lat: 59.2181, lng: 10.9298, radius: 25 },
    "bodø": { lat: 67.2804, lng: 14.4049, radius: 40 },
    "bodo": { lat: 67.2804, lng: 14.4049, radius: 40 },
    "ålesund": { lat: 62.4722, lng: 6.1495, radius: 30 },
    "alesund": { lat: 62.4722, lng: 6.1495, radius: 30 },
    "tønsberg": { lat: 59.2675, lng: 10.4076, radius: 25 },
    "tonsberg": { lat: 59.2675, lng: 10.4076, radius: 25 },
    "haugesund": { lat: 59.4138, lng: 5.2680, radius: 25 },
    "sandnes": { lat: 58.8524, lng: 5.7352, radius: 25 },
    "lillestrøm": { lat: 59.9550, lng: 11.0493, radius: 20 },
    "lillestrom": { lat: 59.9550, lng: 11.0493, radius: 20 },
    "hamar": { lat: 60.7945, lng: 11.0680, radius: 25 },
    "lillehammer": { lat: 61.1153, lng: 10.4662, radius: 30 },
    "sandefjord": { lat: 59.1314, lng: 10.2166, radius: 25 },
    "sarpsborg": { lat: 59.2839, lng: 11.1096, radius: 25 },
    "skien": { lat: 59.2099, lng: 9.6089, radius: 25 },
    "molde": { lat: 62.7375, lng: 7.1591, radius: 30 },
    "moss": { lat: 59.4346, lng: 10.6588, radius: 20 },
    "asker": { lat: 59.8371, lng: 10.4348, radius: 20 },
    "kongsberg": { lat: 59.6630, lng: 9.6501, radius: 25 },
};
// ── Radius heuristic based on place type ──
function radiusForType(type) {
    const t = type.toLowerCase();
    if (t.includes("tettsted") || t.includes("bydel") || t.includes("grend"))
        return 15;
    if (t.includes("by") || t.includes("kommune"))
        return 30;
    if (t.includes("fylke") || t.includes("region"))
        return 60;
    return 25; // sensible default
}
class GeocodingService {
    /**
     * Resolve a place name to coordinates.
     * Returns null if the name can't be geocoded.
     */
    async geocode(placeName) {
        const key = placeName.toLowerCase().trim();
        if (!key || key.length < 2)
            return null;
        // 1. Cache hit
        if (geoCache.has(key))
            return geoCache.get(key) || null;
        // 2. Hardcoded major cities (instant)
        const hardcoded = MAJOR_CITIES[key];
        if (hardcoded) {
            const result = {
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
    async extractAndGeocode(query) {
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
                if (result)
                    return result;
            }
        }
        // Try 2-word combos (e.g. "oslo sentrum", "kristiansand s")
        for (let i = 0; i < words.length - 1; i++) {
            const combo = words[i] + " " + words[i + 1];
            if (!skipWords.has(words[i]) || !skipWords.has(words[i + 1])) {
                const result = await this.geocode(combo);
                if (result)
                    return result;
            }
        }
        // Try single words (skip known food/preposition terms)
        for (const word of words) {
            if (skipWords.has(word))
                continue;
            const result = await this.geocode(word);
            if (result)
                return result;
        }
        return null;
    }
    // ── Private helpers ──
    lookupInDatabase(key) {
        try {
            const db = (0, init_1.getDb)();
            const row = db.prepare("SELECT lat, lng, city FROM agents WHERE LOWER(city) = ? AND lat IS NOT NULL AND lng IS NOT NULL LIMIT 1").get(key);
            if (row) {
                return {
                    lat: row.lat,
                    lng: row.lng,
                    name: row.city,
                    radiusKm: 30,
                    source: "database",
                };
            }
        }
        catch { /* DB not ready yet */ }
        return null;
    }
    async lookupKartverket(placeName) {
        try {
            const url = `https://ws.geonorge.no/stedsnavn/v1/sted?sok=${encodeURIComponent(placeName)}&treffPerSide=3&utkoordsys=4258`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { "Accept": "application/json" },
            });
            clearTimeout(timeout);
            if (!response.ok)
                return null;
            const data = await response.json();
            if (!data.navn || data.navn.length === 0)
                return null;
            // Prefer results that are populated places (tettsted, by, bydel)
            // over mountains, lakes etc.
            const placeTypes = ["Tettsted", "By", "Bydel", "Kommune", "Grend", "Bygd"];
            let best = data.navn.find((n) => placeTypes.some(t => (n.navneobjekttype || "").includes(t)));
            if (!best)
                best = data.navn[0]; // fallback to first result
            const punkt = best.representasjonspunkt;
            if (!punkt || punkt.nord == null || punkt.øst == null)
                return null;
            return {
                lat: punkt.nord,
                lng: punkt.øst,
                name: best.stedsnavn?.[0]?.skrivemåte || placeName,
                radiusKm: radiusForType(best.navneobjekttype || ""),
                source: "kartverket",
            };
        }
        catch (err) {
            // Network error or timeout — fail gracefully
            console.error(`[geocoding] Kartverket lookup failed for "${placeName}":`, err);
            return null;
        }
    }
    cacheResult(key, result) {
        // Evict oldest entries if cache is full
        if (geoCache.size >= CACHE_MAX) {
            const firstKey = geoCache.keys().next().value;
            if (firstKey)
                geoCache.delete(firstKey);
        }
        geoCache.set(key, result);
    }
}
exports.geocodingService = new GeocodingService();
//# sourceMappingURL=geocoding-service.js.map