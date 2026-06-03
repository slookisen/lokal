// ─── Dental Geocode Worker — PR-103 (2026-06-03) ──────────────────
//
// Backend Kartverket-based geocoding worker for dental_agents.
//
// Runs from an hourly setInterval in src/index.ts. Each tick:
//   1. Selects up to 50 records: adresse non-empty, postnummer non-empty,
//      lat IS NULL AND geocode_confidence IS NULL (the work queue —
//      excludes both successfully geocoded rows AND rows previously
//      marked 'no_match' so we don't keep retrying dead addresses).
//   2. For each, runs the Kartverket 4-step retry ladder:
//        Step 1: full address (street + postnummer + poststed) -> "high"
//        Step 2: transliteration recovery (aa/oe/ae diacritic)  -> "medium"
//        Step 3: strip house-letter suffix (e.g. "12B" -> "12") -> "medium"
//        Step 4: street + postnummer only (drop poststed)       -> "low"
//   3. PUTs lat, lng, geocode_source='kartverket', geocode_confidence
//      via the dental-store updateDentalAgent helper (which already
//      knows the field-allowlist + JSON serialisation rules).
//   4. Returns a summary {processed, high, medium, low, no_match, errors}.
//
// Throttle: 350 ms between Kartverket HTTP requests to respect their
// fair-use guidance. Worst case: 50 records x 4 steps x 0.35s ~= 70s
// per tick. Well under the hourly interval.
//
// Disable via env var RFB_DISABLE_DENTAL_GEOCODE=1 (used in tests / dev).
//
// API: https://ws.geonorge.no/adresser/v1/sok?sok=<urlencoded>&treffPerSide=1&utkoordsys=4258
// Returns: { adresser: [{ representasjonspunkt: { lat, lon } }] }
// utkoordsys=4258 is ETRS89, equivalent to WGS84 at sub-meter precision
// for our use-case (clinic-marker placement on a map).

import { getDb } from "../database/db-factory";
import { updateDentalAgent } from "./dental-store";

// Kartverket endpoint + standard params.
const KARTVERKET_BASE = "https://ws.geonorge.no/adresser/v1/sok";
const THROTTLE_MS = 350;

export type GeocodeConfidence = "high" | "medium" | "low" | "no_match";

export type GeocodeResult = {
  processed: number;
  high: number;
  medium: number;
  low: number;
  no_match: number;
  errors: number;
  duration_ms: number;
};

// Injection seams for tests -- pass a mock fetch + zero-delay sleep.
// Production callers omit deps and we use real fetch / setTimeout.
export type GeocodeDeps = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

// --- Helpers ------------------------------------------------------

// Norwegian char-substitution: aa->aa-circle, ae->ae-lig, oe->o-slash.
// Most common Brreg -> Kartverket gap when historical sources lost
// the diacritic. (Source comments use the Latin-1 chars directly.)
export function transliterate(text: string): string {
  return text
    .replace(/aa/g, "å")
    .replace(/Aa/g, "Å")
    .replace(/ae/g, "æ")
    .replace(/Ae/g, "Æ")
    .replace(/oe/g, "ø")
    .replace(/Oe/g, "Ø");
}

// Strip trailing letters from a house-number (e.g. "Storgata 12B"
// -> "Storgata 12"). No-op if the address doesn't end with digits
// followed by letters.
export function stripHouseLetterSuffix(addr: string): string {
  const m = addr.match(/(\d+)[A-Za-z]+$/);
  if (!m || m.index === undefined) return addr;
  return addr.slice(0, m.index) + m[1];
}

// Single Kartverket query. Returns first representasjonspunkt or null.
// Network errors, non-2xx, malformed JSON, and missing results all
// resolve to null -- the caller (geocodeOne) treats null as "try next
// step in the ladder".
export async function kartverketQuery(
  q: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ lat: number; lng: number } | null> {
  const url = `${KARTVERKET_BASE}?sok=${encodeURIComponent(q)}&treffPerSide=1&utkoordsys=4258`;
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": "RFBBot/1.0 (https://rettfrabonden.com)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      adresser?: Array<{ representasjonspunkt?: { lat: number; lon: number } }>;
    };
    const addr = data.adresser?.[0];
    if (!addr?.representasjonspunkt) return null;
    const { lat, lon } = addr.representasjonspunkt;
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    return { lat, lng: lon };
  } catch {
    return null;
  }
}

// 4-step retry ladder. Returns the first successful result with the
// highest-confidence label that produced it. If every step misses
// we return a no_match placeholder so the worker can persist that
// state and stop re-trying the row on every tick.
export async function geocodeOne(
  adresse: string,
  postnummer: string,
  poststed: string,
  deps: GeocodeDeps = {}
): Promise<{
  lat: number;
  lng: number;
  confidence: GeocodeConfidence;
  reason: string;
}> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  // Step 1: full address (street + postnummer + poststed).
  const q1 = poststed
    ? `${adresse} ${postnummer} ${poststed}`
    : `${adresse} ${postnummer}`;
  let result = await kartverketQuery(q1, fetchImpl);
  await sleep(THROTTLE_MS);
  if (result) {
    return { ...result, confidence: "high", reason: "exact_match_step1" };
  }

  // Step 2: transliteration recovery.
  const transliterated = transliterate(adresse);
  if (transliterated !== adresse) {
    const q2 = poststed
      ? `${transliterated} ${postnummer} ${poststed}`
      : `${transliterated} ${postnummer}`;
    result = await kartverketQuery(q2, fetchImpl);
    await sleep(THROTTLE_MS);
    if (result) {
      return {
        ...result,
        confidence: "medium",
        reason: "transliteration_recovery",
      };
    }
  }

  // Step 3: strip house-letter suffix.
  const stripped = stripHouseLetterSuffix(adresse);
  if (stripped !== adresse) {
    const q3 = poststed
      ? `${stripped} ${postnummer} ${poststed}`
      : `${stripped} ${postnummer}`;
    result = await kartverketQuery(q3, fetchImpl);
    await sleep(THROTTLE_MS);
    if (result) {
      return {
        ...result,
        confidence: "medium",
        reason: "strip_suffix_recovery",
      };
    }
  }

  // Step 4: street + postnummer only (drop poststed).
  const q4 = `${adresse} ${postnummer}`;
  result = await kartverketQuery(q4, fetchImpl);
  await sleep(THROTTLE_MS);
  if (result) {
    return { ...result, confidence: "low", reason: "street_only_fallback" };
  }

  return { lat: 0, lng: 0, confidence: "no_match", reason: "all_retries_failed" };
}

// Main tick. Pulls a batch of ungeocoded records, runs each through
// the ladder, persists results via updateDentalAgent. Deterministic
// ordering (ORDER BY id) so re-runs are reproducible.
export async function geocodeTick(
  limit: number = 50,
  deps: GeocodeDeps = {}
): Promise<GeocodeResult> {
  const start = Date.now();
  const db = getDb("dental");
  const stats: GeocodeResult = {
    processed: 0,
    high: 0,
    medium: 0,
    low: 0,
    no_match: 0,
    errors: 0,
    duration_ms: 0,
  };

  // Select candidates. The WHERE clause picks any non-empty adresse
  // with no lat AND no prior confidence label -- that excludes both
  // successfully-geocoded rows (lat IS NOT NULL) and prior no_match
  // rows (geocode_confidence='no_match'), making the worker naturally
  // idempotent across ticks.
  const rows = db
    .prepare(
      `SELECT id, adresse, postnummer, poststed
       FROM dental_agents
       WHERE adresse IS NOT NULL
         AND adresse <> ''
         AND postnummer IS NOT NULL
         AND postnummer <> ''
         AND lat IS NULL
         AND geocode_confidence IS NULL
       ORDER BY id
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    adresse: string;
    postnummer: string;
    poststed: string | null;
  }>;

  for (const row of rows) {
    try {
      const result = await geocodeOne(
        row.adresse,
        row.postnummer,
        row.poststed ?? "",
        deps
      );
      stats.processed++;

      if (result.confidence === "no_match") {
        stats.no_match++;
        // Persist confidence='no_match' (lat/lng stay NULL) so we
        // don't keep retrying the same dead address every hour.
        updateDentalAgent(row.id, {
          lat: null,
          lng: null,
          geocode_source: "kartverket",
          geocode_confidence: "no_match",
        });
      } else {
        stats[result.confidence]++;
        updateDentalAgent(row.id, {
          lat: result.lat,
          lng: result.lng,
          geocode_source: "kartverket",
          geocode_confidence: result.confidence,
        });
      }
    } catch (err) {
      stats.errors++;
      console.error(`[dental-geocode] failed for ${row.id}:`, err);
    }
  }

  stats.duration_ms = Date.now() - start;
  return stats;
}
