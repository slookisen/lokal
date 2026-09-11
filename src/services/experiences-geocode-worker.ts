// ─── Experiences Geocode Worker — dev-request 2026-07-04-opplevagent-naer-meg-geosok
// (item 1 of 4, 2026-07-10) ──────────────────────────────────────────────
//
// Backend Kartverket-based geocoding worker for the experiences vertical.
// Mirrors src/services/dental-geocode-worker.ts's pattern (idempotent SQL
// work-queue, injectable fetch/sleep deps for tests, try/catch-per-row so
// one bad record never crashes the tick) but adds a second tier: unlike
// dental_agents (each row IS an address-bearing entity), the experiences
// vertical is harvest-first — `experiences` rows often have no provider_id
// yet, and even when they do, an experience has no address of its own; its
// location comes from its provider. So this worker runs FOUR steps per
// tick, in order:
//
//   Step A — geocode experience_providers' street addresses via the
//            Kartverket adresse-API 4-step retry ladder (reusing
//            geocodeOne/kartverketQuery/transliterate/stripHouseLetterSuffix
//            from dental-geocode-worker.ts — those helpers are already
//            generic, taking plain address/postnummer/poststed strings).
//   Step D — for providers Step A could not (or will never usefully) place
//            at address precision, fall back to a kommune/fylke-centroid
//            lookup via geocodingService, tagged geocode_confidence=
//            'approximate' so the profile page can render it honestly
//            (added 2026-07-12, dev-request gardssalg-go-live-gate slice 3
//            — rural gårdssalg addresses often never resolve via the
//            adresse-API even though the kommune is known).
//   Step B — propagate a just-(or previously-)geocoded provider's REAL
//            address-precision lat/lon down to any of its experiences that
//            don't have a location yet (geo_precision='address'). Step D's
//            approximate fallback is deliberately excluded from this
//            propagation (see Step B's own comment below) — geo_precision=
//            'address' is the near-me search honesty rule (formatDistanceLabel(),
//            discoverExperiences()'s radius filter/sort all trust it to mean
//            a real street address).
//   Step C — for experiences that still have no location (unmatched to a
//            provider, or matched to a provider whose address geocoding
//            failed / is still pending), fall back to a kommune-centroid
//            lookup via geocodingService (geo_precision='kommune'). This
//            hits the Kartverket Stedsnavn API (not the adresse API), which
//            geocodingService already caches in-memory — cheap, and the
//            kommune namespace is small (~360) so it converges fast.
//
// Disable via env var RFB_DISABLE_EXPERIENCES_GEOCODE=1 (used in tests / dev).
// Gated in src/index.ts by ENABLE_EXPERIENCES=1 as well (no point ticking
// against a DB handle that isn't open).

import { getDb } from "../database/db-factory";
import {
  geocodeOne,
  type GeocodeDeps,
} from "./dental-geocode-worker";
import { geocodingService } from "./geocoding-service";
import { isPlausibleNorwayCoord, NORWAY_BBOX } from "./geo-distance";

const VERTICAL = "experiences";

// ── Fase 1b — is this free text actually an address? ─────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok.
//
// `experiences.meeting_point` is free text written for humans. Measured
// examples range from a real address ("Sjøgata 21, 8006 Bodø") to things that
// are not addresses at all ("ved brygga", "vi henter deg på hotellet",
// "oppmøte 30 min før avgang"). Feeding the second kind to Kartverket's
// adresse-API is exactly the class of confident-wrong-point bug Fase 0 spent
// its whole budget killing, so this is deliberately strict and refuses far
// more than it accepts: a street-ish word followed by a house number is the
// ONLY shape we accept, and a leading "oppmøte:"-style label is stripped
// first. When in doubt we return null and the row stays at kommune precision —
// an honest coarse position beats a precise wrong one.
// Review follow-up 5 — words that take a number but are NOT a street.
// The adresse-API is strictly conjunctive, so these false accepts returned 0
// hits and never wrote a wrong point; the reason to reject them up front is
// that they were the volume amplifier for B2 (13 of 29 adversarial inputs
// accepted → 13 futile requests per pass). Post boxes are the important class:
// «Postboks 123, 0150 Oslo» is a real postal address and NOT a location.
const NON_STREET_HEAD = /^(postboks|postbox|p\.?\s?b\.?|boks|bygg|byggetrinn|sal|rom|inngang|port|kai|spor|plattform|gate\s?nr|rv|fv|ev|e)$/i;

// Monotonic ms stamps for Step F's rotation key (review B2). datetime('now')
// is 1-second granular, so a whole batch would collapse to a single value and
// the ORDER BY would fall back to the `id` tiebreaker — reinstating exactly
// the "same rows every tick" defect the stamp exists to fix. Same helper shape
// as agents-geocode-worker.ts's nextAttemptStamp().
let lastMeetingPointStampMs = 0;
function nextMeetingPointStamp(): string {
  const now = Date.now();
  lastMeetingPointStampMs = now > lastMeetingPointStampMs ? now : lastMeetingPointStampMs + 1;
  return new Date(lastMeetingPointStampMs).toISOString();
}

export function parseAddressLike(
  meetingPoint: string | null | undefined
): { street: string; postnummer: string | null } | null {
  const raw = (meetingPoint || "").trim();
  if (!raw || raw.length > 120) return null;

  // Drop a leading label ("Oppmøte: …", "Møtested: …"). Bounded to a SHORT
  // single word plus an optional qualifier so it cannot eat a real place name:
  // «Oslo S: spor 12, 0154 Oslo» used to be delabelled to «spor 12» and then
  // parsed as a street (review follow-up 5). A label is a word like «Oppmøte»,
  // «Møtested», «Sted», «Adresse» — not an arbitrary ≤20-char prefix.
  const delabelled = raw.replace(/^(oppm(ø|o)te|m(ø|o)tested|m(ø|o)teplass|sted|adresse|hvor)\s*:\s*/i, "");

  // dev-request 2026-09-11 fix 2 — "c/o <name>, " / "v/ <name>, " prefix.
  // "c/o Josef Flatlandsmo, Åbyfaret 12B" names a CARE-OF recipient before the
  // real street line. Left in place, parts[0] below is the person's name (no
  // trailing number), so the street shape test never even sees the real
  // address one comma over — measured live: ~46 of 50 sampled backlog rows
  // misclassified as place names this way. Stripped from the string BEFORE
  // the comma split (not just parts[0] swapped out) so every downstream
  // guard — postnummer scan, NON_STREET_HEAD, foreign-country check, length
  // caps — sees the address exactly as if the care-of segment had never been
  // there. `<name>` is free text up to the next comma, per spec.
  const careOfMatch = delabelled.match(/^(?:c\s?\/\s?o|v\s?\/)\s+[^,]+,\s*/i);
  const addressPart = careOfMatch ? delabelled.slice(careOfMatch[0].length) : delabelled;

  const parts = addressPart.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  // A 4-digit group anywhere in the string is a postnummer candidate. Guarded
  // against year-like numbers by requiring it to be followed by a word (the
  // poststed) or to end the string, and to not be part of a longer number.
  const postMatch = addressPart.match(/(?:^|[\s,])(\d{4})(?=[\s,]|$)/);
  const postnummer = postMatch ? postMatch[1] : null;

  // "<name…> <number><optional letter>" — the shape of a Norwegian street
  // address. The name part must contain a letter and must not itself be the
  // postnummer segment.
  const streetMatch = parts[0].match(/^([\p{L}][\p{L}\s.'’-]{1,40}?)\s+(\d{1,4}\s?[A-Za-z]?)$/u);
  if (!streetMatch) return null;
  const namePart = streetMatch[1].trim();
  const numberPart = streetMatch[2].replace(/\s+/g, "");
  const street = `${namePart} ${numberPart}`;

  // Review follow-up 5, guard 1: reject heads that take a number but are not a
  // street — «Postboks 123», «P.b. 22», «Kai 4», «Bygg 3», «Sal 2», «Rom 12»,
  // «Inngang 2», «Rv 7». Compared on the LAST word of the name part, so
  // «Nedre Postboks» is rejected but «Postboksgata» (a real street) is not.
  const headWord = namePart.split(/\s+/).pop() || "";
  if (NON_STREET_HEAD.test(headWord)) return null;

  // Guard 2: the "house number" must not BE the postnummer. «Gården vår i
  // Vestre Slidre 2966» parsed as street «Gården vår i Vestre Slidre» + number
  // 2966, with 2966 simultaneously read as the postnummer — a whole sentence
  // masquerading as an address.
  if (postMatch && numberPart.replace(/[^\d]/g, "") === postMatch[1]) return null;

  // Guard 3: a street name is at most a few words. «Gården vår i Vestre
  // Slidre» is prose; a real Norwegian street name is 1-3 words («Nedre
  // Slottsgate», «Kong Oscars gate»).
  if (namePart.split(/\s+/).length > 3) return null;

  // Guard 4: an explicitly FOREIGN address. «Vestergade 5, 8000 Aarhus,
  // Danmark» is perfectly address-shaped and its 8000 is a valid Norwegian
  // postnummer too (Trondheim) — the only signal that it is not ours is the
  // country. Kartverket only knows Norway, so this would silently place a
  // Danish meeting point in Trøndelag if the numbers happened to line up.
  if (/\b(danmark|denmark|sverige|sweden|finland|island|iceland|deutschland|germany|tyskland|nederland|holland|storbritannia|england|scotland|skottland)\b/i.test(addressPart)) {
    return null;
  }

  // A street with no postnummer anywhere is too weak: "Storgata 5" exists in
  // dozens of kommuner and geocodeOne would happily return the first one.
  // EXCEPT when a care-of prefix was stripped above: "c/o <name>," / "v/
  // <name>," is a specific, named-individual signal a bare street name is
  // not, and every caller of this function already knows the row's own
  // kommune — the disambiguation the postnummer exists for is available from
  // context instead. Existing bare-street rejections (no prefix) are
  // unaffected — "Storgata 5" alone is still refused.
  if (!postnummer && !careOfMatch) return null;

  return { street, postnummer };
}

export type ExperiencesGeocodeResult = {
  providers_processed: number;
  providers_high: number;
  providers_medium: number;
  providers_low: number;
  providers_no_match: number;
  providers_kommune_fallback: number;
  providers_fallback_unresolved: number;
  /**
   * dev-request 2026-09-09-opplevagent-stedsetikett-poststed-og-
   * kommunesentroide-kart, Skive 2: rows whose place-name `adresse` (no house
   * number, so Step A/parseAddressLike() can't treat it as a street address)
   * resolved via Kartverket's Stedsnavn API scoped to the row's own kommune —
   * geocode_confidence='sted', a real (if approximate) point, distinct from
   * both a genuine street address and the coarser kommune-centroid fallback.
   */
  providers_sted_fallback: number;
  // 2026-08-25: a geocoder answer that cannot be a Norwegian position, refused
  // at the write instead of being stored (see Step A / Step D).
  providers_implausible_rejected: number;
  // Rows whose already-stored coordinate was impossible and has been cleared
  // so the normal ladder can resolve it properly (Step 0).
  providers_coords_reset: number;
  experiences_coords_reset: number;
  experiences_address_precision: number;
  experiences_kommune_precision: number;
  experiences_unresolved: number;
  /** Fase 1b — kommune-precision rows lifted to address precision this tick. */
  experiences_upgraded_to_address: number;
  /** Fase 1b — …of which came from a parseable `meeting_point`. */
  experiences_upgraded_from_meeting_point: number;
  /** Fase 1b — Step F rows whose meeting_point is not address-shaped (stamped, rotated). */
  meeting_point_not_addresslike: number;
  /** Fase 1b — Step F rows whose parsed address Kartverket could not find (stamped, rotated). */
  meeting_point_no_match: number;
  errors: number;
  duration_ms: number;
};

// Re-exported so callers/tests can inject the same deps shape used by
// dental-geocode-worker without importing that module directly.
export type { GeocodeDeps };

/**
 * Main tick. Runs Step A (provider address geocoding), Step D (provider
 * kommune/fylke-centroid fallback for providers Step A couldn't resolve at
 * address precision), Step B (propagate provider location -> experiences),
 * Step C (kommune-centroid fallback for experiences still unresolved), each
 * capped at `limit` rows so a large backlog can't runaway a single tick.
 * Sequential and deterministic (ORDER BY id) so re-runs are reproducible.
 */
export async function experiencesGeocodeTick(
  limit: number = 50,
  deps: GeocodeDeps = {}
): Promise<ExperiencesGeocodeResult> {
  const start = Date.now();
  const db = getDb(VERTICAL);
  const stats: ExperiencesGeocodeResult = {
    providers_processed: 0,
    providers_high: 0,
    providers_medium: 0,
    providers_low: 0,
    providers_no_match: 0,
    providers_kommune_fallback: 0,
    providers_fallback_unresolved: 0,
    providers_sted_fallback: 0,
    providers_implausible_rejected: 0,
    providers_coords_reset: 0,
    experiences_coords_reset: 0,
    experiences_address_precision: 0,
    experiences_kommune_precision: 0,
    experiences_unresolved: 0,
    experiences_upgraded_to_address: 0,
    experiences_upgraded_from_meeting_point: 0,
    meeting_point_not_addresslike: 0,
    meeting_point_no_match: 0,
    errors: 0,
    duration_ms: 0,
  };

  // ─── Step 0 — repair coordinates that cannot be Norwegian ──────────
  // Daniel, 2026-08-25: «har lagt med begge adressene på bildet. burde vært
  // lett å funnet selv, i stedet for å sette 0.0» — and he is right. Two
  // producers sat at lat 0 / lon 0 while their real street address was in
  // our own `adresse` column the whole time (and Kartverket resolves both on
  // the first query). Step A's gate below used to skip them, Step D stamped a
  // centroid that came back 0/0, and the row was then STUCK: every later step
  // keys on `lat IS NULL`, so a poisoned coordinate is never retried.
  //
  // This step is the way out. It clears any stored coordinate that cannot be
  // a Norwegian position, putting the row back in the normal ladder — Step A
  // will now geocode it from the address it already has. Self-healing: no
  // admin call, no manual SQL, and it also catches any future row that picks
  // up a bad coordinate from a source we don't control.
  const resetProviderCoords = db.prepare(
    `UPDATE experience_providers
        SET lat = NULL, lon = NULL, geocode_source = NULL, geocode_confidence = NULL,
            updated_at = datetime('now')
      WHERE lat IS NOT NULL AND lon IS NOT NULL
        AND (lat NOT BETWEEN ${NORWAY_BBOX.minLat} AND ${NORWAY_BBOX.maxLat}
             OR lon NOT BETWEEN ${NORWAY_BBOX.minLon} AND ${NORWAY_BBOX.maxLon})`
  );
  const resetExperienceCoords = db.prepare(
    `UPDATE experiences
        SET loc_lat = NULL, loc_lon = NULL, geo_precision = NULL,
            updated_at = datetime('now')
      WHERE loc_lat IS NOT NULL AND loc_lon IS NOT NULL
        AND (loc_lat NOT BETWEEN ${NORWAY_BBOX.minLat} AND ${NORWAY_BBOX.maxLat}
             OR loc_lon NOT BETWEEN ${NORWAY_BBOX.minLon} AND ${NORWAY_BBOX.maxLon})`
  );
  try {
    stats.providers_coords_reset = resetProviderCoords.run().changes;
    stats.experiences_coords_reset = resetExperienceCoords.run().changes;
    if (stats.providers_coords_reset || stats.experiences_coords_reset) {
      console.log(
        `[experiences-geocode] cleared impossible coordinates: ` +
        `providers=${stats.providers_coords_reset} experiences=${stats.experiences_coords_reset} ` +
        `(rows return to the normal geocode ladder)`
      );
    }
  } catch (err) {
    stats.errors++;
    console.error("[experiences-geocode] coordinate repair sweep failed:", err);
  }

  // ─── Step A — provider address geocoding ───────────────────────────
  // Excludes both successfully-geocoded rows (lat IS NOT NULL) and prior
  // no_match rows (geocode_confidence='no_match'), so the worker is naturally
  // idempotent across ticks and never re-hammers a dead address.
  //
  // `postnummer` is NOT required (changed 2026-08-25, Daniel's finding above).
  // It used to mirror dental-geocode-worker's WHERE clause exactly, which also
  // demanded a separate postnummer column — but experience_providers routinely
  // holds the whole address in `adresse` ("Utgårdsveien 4, 1684 Vesterøy")
  // with postnummer empty, and those rows were dropped straight past the
  // geocoder into Step D's kommune centroid. geocodeOne() builds a free-text
  // Kartverket query, so an embedded or absent postcode is fine as long as
  // there is a street line: both of the rows that exposed this bug resolve on
  // the FIRST query with 1 hit each. A row whose address genuinely doesn't
  // resolve still lands on `no_match` and drops to Step D as before — the
  // fallback is now the last resort it was meant to be, not the first stop.
  const providerRows = db
    .prepare(
      `SELECT id, adresse, postnummer, poststed, kommune
       FROM experience_providers
       WHERE adresse IS NOT NULL
         AND adresse <> ''
         AND lat IS NULL
         AND geocode_confidence IS NULL
       ORDER BY id
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    adresse: string;
    postnummer: string | null;
    poststed: string | null;
    kommune: string | null;
  }>;

  const updateProviderGeocoded = db.prepare(
    `UPDATE experience_providers
        SET lat = ?, lon = ?, geocode_source = 'kartverket', geocode_confidence = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  );
  const updateProviderNoMatch = db.prepare(
    `UPDATE experience_providers
        SET geocode_source = 'kartverket', geocode_confidence = 'no_match',
            updated_at = datetime('now')
      WHERE id = ?`
  );

  for (const row of providerRows) {
    try {
      // poststed falls back to kommune: with no postnummer, the place name is
      // what disambiguates a street that exists in several municipalities.
      const result = await geocodeOne(
        row.adresse,
        row.postnummer ?? "",
        row.poststed ?? row.kommune ?? "",
        deps
      );
      stats.providers_processed++;

      if (result.confidence === "no_match") {
        stats.providers_no_match++;
        updateProviderNoMatch.run(row.id);
      } else if (!isPlausibleNorwayCoord(result.lat, result.lng)) {
        // Same sanity gate as Step D's write below: a geocoder answer that
        // cannot be a Norwegian position is treated as no match, never
        // written. This is what stops a 0/0 from entering the DB at all.
        stats.providers_no_match++;
        stats.providers_implausible_rejected++;
        console.warn(
          `[experiences-geocode] rejected implausible coordinate for provider ${row.id}: ` +
          `${result.lat}/${result.lng} (${result.reason})`
        );
        updateProviderNoMatch.run(row.id);
      } else {
        if (result.confidence === "high") stats.providers_high++;
        else if (result.confidence === "medium") stats.providers_medium++;
        else if (result.confidence === "low") stats.providers_low++;
        updateProviderGeocoded.run(result.lat, result.lng, result.confidence, row.id);
      }
    } catch (err) {
      stats.errors++;
      console.error(`[experiences-geocode] provider geocoding failed for ${row.id}:`, err);
    }
  }

  // ─── Step D — provider kommune/fylke-centroid fallback ─────────────
  // (numbered D, not C, to match the pre-existing Step C below it — this
  // fills the gap dev-request 2026-07-12-gardssalg-go-live-gate-dark-launch-
  // og-onboarding slice 3 calls out: rural gårdssalg addresses often never
  // resolve via the Kartverket adresse-API, so Step A leaves them
  // geocode_confidence='no_match' and the profile page's map block shows
  // "posisjon ikke registrert" forever — even though the provider's own
  // kommune/fylke IS known and geocodable. Mirrors Step C's kommune-centroid
  // lookup, but writes the PROVIDER's own lat/lon (not an experience's), and
  // only for rows Step A could not (or will never usefully) resolve at
  // address precision — never overwrites a real address-level geocode.
  // geocode_confidence='approximate' tags the result distinctly from
  // Step A's high/medium/low tiers so the profile route can render an
  // honest "ca. posisjon" label instead of claiming address precision.
  const providerFallbackRows = db
    .prepare(
      `SELECT id, adresse, kommune, kommunenummer, fylke
         FROM experience_providers
        WHERE lat IS NULL
          AND (
            geocode_confidence = 'no_match'
            OR (
              geocode_confidence IS NULL
              AND (adresse IS NULL OR adresse = '')
            )
          )
          AND ((kommune IS NOT NULL AND kommune <> '') OR (fylke IS NOT NULL AND fylke <> ''))
        ORDER BY id
        LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    adresse: string | null;
    kommune: string | null;
    kommunenummer: string | null;
    fylke: string | null;
  }>;

  const updateProviderApprox = db.prepare(
    `UPDATE experience_providers
        SET lat = ?, lon = ?, geocode_source = 'kommune_fallback', geocode_confidence = 'approximate',
            updated_at = datetime('now')
      WHERE id = ?`
  );
  // dev-request 2026-09-09-opplevagent-stedsetikett-poststed-og-kommunesentroide-
  // kart, Skive 2: same shape as updateProviderApprox, distinct
  // geocode_source/geocode_confidence so the profile page can render this as
  // an approximate POINT (see experiences-seo.ts's gardssalgMapPresentation())
  // rather than the kommune tier's no-point card.
  const updateProviderSted = db.prepare(
    `UPDATE experience_providers
        SET lat = ?, lon = ?, geocode_source = 'stedsnavn_kommune', geocode_confidence = 'sted',
            updated_at = datetime('now')
      WHERE id = ?`
  );

  for (const row of providerFallbackRows) {
    try {
      // dev-request 2026-09-09-opplevagent-stedsetikett-poststed-og-
      // kommunesentroide-kart, Skive 2: BEFORE falling to the kommune
      // centroid, try the place name itself when `adresse` holds one.
      // parseAddressLike() already exists in this file to recognise a real
      // street address ("<name> <number>"); a place name like "Innset" has no
      // house number, so it returns null there — which is exactly the signal
      // used here to mean "this is a place name, not a street". Rows with no
      // adresse (or a genuine street address, which Step A already tried and
      // failed) skip straight to the unchanged kommune fallback below.
      let stedGeo = null as Awaited<ReturnType<typeof geocodingService.geocodeStedInKommune>> | null;
      if (row.adresse && row.adresse.trim() && !parseAddressLike(row.adresse)) {
        stedGeo = await geocodingService.geocodeStedInKommune(row.adresse, row.kommunenummer, row.kommune);
      }
      if (stedGeo && isPlausibleNorwayCoord(stedGeo.lat, stedGeo.lng)) {
        updateProviderSted.run(stedGeo.lat, stedGeo.lng, row.id);
        stats.providers_sted_fallback++;
        continue;
      }

      // dev-request 2026-07-25 fix 0a: geocodeKommune (Kartverket's kommune
      // REGISTER, keyed on kommunenummer when we have one) instead of the
      // free-text geocode() this used to call. Stedsnavn's fuzzy search
      // resolved «Flakstad» to the Navnegard «Flagstad» near Hamar, so every
      // Lofoten provider in that kommune was stored 780 km off.
      let geo = (row.kommune || row.kommunenummer)
        ? await geocodingService.geocodeKommune(row.kommune, row.kommunenummer)
        : null;
      if (!geo && row.fylke) {
        geo = await geocodingService.geocode(row.fylke);
      }
      // Coordinate sanity gate (Daniel, live sesjon 2026-08-24): a geocode
      // result that cannot be a Norwegian position — 0/0 "null island" is the
      // one seen on prod, where 2 providers ended up ~5 000 km off West
      // Africa and dragged the /kategori/gardssalg map's fitBounds() out over
      // the Atlantic — is treated as NOT resolved rather than written. The row
      // stays lat IS NULL, so this same fallback retries it next tick (exactly
      // what the "no negative-cache column" branch below already relies on),
      // instead of being poisoned with a coordinate no surface can trust. The
      // display-side gate in experience-store.ts's map queries hides the rows
      // already written before this guard existed; this stops new ones.
      if (geo && isPlausibleNorwayCoord(geo.lat, geo.lng)) {
        updateProviderApprox.run(geo.lat, geo.lng, row.id);
        stats.providers_kommune_fallback++;
      } else {
        // Genuine "can't resolve" -- same discipline as Step C: no
        // negative-cache column for this tier, left to retry next tick
        // (cheap once geocodingService's in-memory cache is warm).
        stats.providers_fallback_unresolved++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`[experiences-geocode] provider kommune fallback failed for ${row.id}:`, err);
    }
  }

  // ─── Step B — propagate provider location -> experiences ──────────
  // Any experience still missing a location, matched to a provider that
  // already has a usable, address-precision geocode result. Single SQL
  // statement via a join, capped at `limit` rows per tick.
  //
  // Excludes 'approximate' (Step D's kommune/fylke-centroid fallback) as
  // well as 'no_match' — this UPDATE always writes geo_precision='address',
  // which formatDistanceLabel() (experience-store.ts) and discoverExperiences()'s
  // haversine radius filter/sort treat as a genuine street-address-level
  // position (the near-me search "honesty rule"). Propagating an approximate
  // provider position here would silently mislabel it as exact and corrupt
  // "within X km" results. Step D's approximate fallback is scoped to the
  // provider's own profile-page map for now (dev-request gardssalg-go-live-
  // gate slice 3) — propagating it to experiences is a distinct, un-asked-for
  // feature left for a future slice if wanted.
  // Also excludes 'sted' (dev-request 2026-09-09-opplevagent-stedsetikett-…,
  // Skive 2's new provider tier) for the exact same reason: a Stedsnavn-in-
  // kommune point is a real point but still only place-name-scale, not a
  // street address, so it must not silently become geo_precision='address'
  // here either. Propagating it to experiences (as its own 'sted' precision,
  // say) is the same distinct, un-asked-for future-slice feature the
  // 'approximate' comment above already defers.
  try {
    const propagateRows = db
      .prepare(
        `SELECT e.id AS id, p.lat AS lat, p.lon AS lon
           FROM experiences e
           JOIN experience_providers p ON p.id = e.provider_id
          WHERE e.loc_lat IS NULL
            AND e.geo_precision IS NULL
            AND e.provider_id IS NOT NULL
            AND p.lat IS NOT NULL
            AND p.lon IS NOT NULL
            AND p.geocode_confidence IS NOT NULL
            AND p.geocode_confidence NOT IN ('no_match', 'approximate', 'sted')
          ORDER BY e.id
          LIMIT ?`
      )
      .all(limit) as Array<{ id: string; lat: number; lon: number }>;

    const updateExperienceAddress = db.prepare(
      `UPDATE experiences
          SET loc_lat = ?, loc_lon = ?, geo_precision = 'address', updated_at = datetime('now')
        WHERE id = ?`
    );

    for (const row of propagateRows) {
      try {
        updateExperienceAddress.run(row.lat, row.lon, row.id);
        stats.experiences_address_precision++;
      } catch (err) {
        stats.errors++;
        console.error(`[experiences-geocode] provider->experience propagation failed for ${row.id}:`, err);
      }
    }
  } catch (err) {
    stats.errors++;
    console.error("[experiences-geocode] Step B (propagate) failed:", err);
  }

  // ─── Step C — kommune-centroid fallback ────────────────────────────
  // Covers unmatched experiences AND experiences whose provider has no
  // usable address / failed geocoding. Kommune name-space is small and
  // geocodingService caches lookups in-memory, so this converges fast
  // and never grows unbounded even though a failed lookup here doesn't
  // set any negative-cache column (there's no confidence tier for it,
  // just a genuine "can't resolve yet" -- retried next tick).
  const fallbackRows = db
    .prepare(
      // LEFT JOIN only to borrow the provider's kommunenummer when it has one
      // (the `experiences` table has no such column) — an exact register key
      // beats a fuzzy name lookup. Rows with no provider still work by name.
      `SELECT e.id AS id, e.kommune AS kommune, e.fylke AS fylke,
              p.kommunenummer AS kommunenummer
         FROM experiences e
         LEFT JOIN experience_providers p
                ON p.id = e.provider_id
               AND p.kommune IS NOT NULL
               AND LOWER(p.kommune) = LOWER(e.kommune)
        WHERE e.loc_lat IS NULL
          AND e.geo_precision IS NULL
          AND e.kommune IS NOT NULL
          AND e.kommune <> ''
        ORDER BY e.id
        LIMIT ?`
    )
    .all(limit) as Array<{ id: string; kommune: string; fylke: string | null; kommunenummer: string | null }>;

  const updateExperienceKommune = db.prepare(
    `UPDATE experiences
        SET loc_lat = ?, loc_lon = ?, geo_precision = 'kommune', updated_at = datetime('now')
      WHERE id = ?`
  );

  for (const row of fallbackRows) {
    try {
      // dev-request 2026-07-25 fix 0a — kommune REGISTER lookup, see Step D.
      let geo = await geocodingService.geocodeKommune(row.kommune, row.kommunenummer);
      if (!geo && row.fylke) {
        geo = await geocodingService.geocode(row.fylke);
      }
      if (geo) {
        updateExperienceKommune.run(geo.lat, geo.lng, row.id);
        stats.experiences_kommune_precision++;
      } else {
        // Genuine "can't resolve" -- no negative-cache column exists for
        // this tier, so leave geo_precision NULL and let it retry next
        // tick (cheap: cached after first hit, small kommune namespace).
        stats.experiences_unresolved++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`[experiences-geocode] kommune fallback failed for ${row.id}:`, err);
    }
  }

  // ─── Step E — kommune-precision → address-precision UPGRADE ────────
  // dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1b.
  //
  // Measured live 2026-07-25: ~427 of 433 experiences are geocoded and 100 %
  // of them sit at geo_precision='kommune'. ZERO at address precision — so
  // everything in Bodø honestly reports distance_km 0, and a 10–25 km corridor
  // search (Fase 2) over those points would be meaningless.
  //
  // The cause is an ordering gap, not missing data: Step B only propagates a
  // provider's address-level position to experiences whose geo_precision IS
  // NULL. Any experience that Step C reached FIRST (its provider's address
  // geocoding was still pending, or the provider matched later) is pinned at
  // 'kommune' forever — even after Step A gives the provider a real street
  // position. Step E is the missing re-attempt: same join and the same
  // confidence gate as Step B ('no_match' and Step D's 'approximate' both
  // excluded — only a genuine address-level provider geocode may claim
  // geo_precision='address'), but for rows already tagged 'kommune'. Also
  // excludes 'sted' (Skive 2), same reasoning as Step B's own comment above.
  //
  // Strictly an upgrade: kommune → address. Nothing here can move a row the
  // other way.
  try {
    const upgradeRows = db
      .prepare(
        `SELECT e.id AS id, p.lat AS lat, p.lon AS lon
           FROM experiences e
           JOIN experience_providers p ON p.id = e.provider_id
          WHERE e.geo_precision = 'kommune'
            AND p.lat IS NOT NULL
            AND p.lon IS NOT NULL
            AND p.geocode_confidence IS NOT NULL
            AND p.geocode_confidence NOT IN ('no_match', 'approximate', 'sted')
          ORDER BY e.id
          LIMIT ?`
      )
      .all(limit) as Array<{ id: string; lat: number; lon: number }>;

    const upgradeToAddress = db.prepare(
      `UPDATE experiences
          SET loc_lat = ?, loc_lon = ?, geo_precision = 'address', updated_at = datetime('now')
        WHERE id = ? AND geo_precision = 'kommune'`
    );

    for (const row of upgradeRows) {
      try {
        upgradeToAddress.run(row.lat, row.lon, row.id);
        stats.experiences_upgraded_to_address++;
      } catch (err) {
        stats.errors++;
        console.error(`[experiences-geocode] address upgrade failed for ${row.id}:`, err);
      }
    }
  } catch (err) {
    stats.errors++;
    console.error("[experiences-geocode] Step E (address upgrade) failed:", err);
  }

  // ─── Step F — meeting_point as a last-resort address source ────────
  // Fase 1b, second half. Some experiences have no provider address at all
  // (unmatched, or the provider row carries none) but their own
  // `meeting_point` free text happens to BE an address. parseAddressLike()
  // above accepts only "<street> <number>" plus a postnummer and refuses
  // everything else — «ved brygga» must stay at kommune precision rather than
  // become a confident wrong point. Only a real Kartverket adresse-API hit
  // promotes the row.
  //
  // REVIEW B2 — ROTATION. Both give-up paths used to be a bare `continue`
  // with no write, while the selector was `WHERE geo_precision='kommune' …
  // ORDER BY e.id LIMIT ?`. The unresolvable residue was therefore re-selected
  // in exactly the same order every hour, forever, AND starved every row
  // behind the LIMIT (measured: 3 ticks, byte-identical row list, rows 4-6
  // never reached; ~100 zero-result Kartverket requests per hour, indefinitely,
  // against a free public API). meeting_point_geocode_attempted_at is now
  // stamped on EVERY attempt whatever the outcome, and the selector orders by
  // it — never-attempted first, then oldest — so a failure rotates to the back
  // of the queue instead of blocking it. Monotonic ms stamps for the same
  // reason as the agents worker: datetime('now') is 1-second granular and a
  // whole batch would collapse to one value, restoring the `id` tiebreaker and
  // with it the original defect.
  const meetingPointRows = db
    .prepare(
      `SELECT e.id AS id, e.meeting_point AS meeting_point, e.kommune AS kommune,
              p.poststed AS poststed
         FROM experiences e
         LEFT JOIN experience_providers p ON p.id = e.provider_id
        WHERE e.geo_precision = 'kommune'
          AND e.meeting_point IS NOT NULL
          AND e.meeting_point <> ''
          AND (p.id IS NULL OR p.adresse IS NULL OR p.adresse = '')
        ORDER BY (e.meeting_point_geocode_attempted_at IS NOT NULL),
                 e.meeting_point_geocode_attempted_at ASC,
                 e.id ASC
        LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    meeting_point: string | null;
    kommune: string | null;
    poststed: string | null;
  }>;

  const upgradeFromMeetingPoint = db.prepare(
    `UPDATE experiences
        SET loc_lat = ?, loc_lon = ?, geo_precision = 'address',
            meeting_point_geocode_attempted_at = ?, updated_at = datetime('now')
      WHERE id = ? AND geo_precision = 'kommune'`
  );
  const stampMeetingPointAttempt = db.prepare(
    `UPDATE experiences SET meeting_point_geocode_attempted_at = ? WHERE id = ?`
  );
  // Guard the guard: a stamp failure must never abort the tick, and must never
  // be the reason a row is silently skipped.
  const stampAttempt = (id: string) => {
    try {
      stampMeetingPointAttempt.run(nextMeetingPointStamp(), id);
    } catch (err) {
      console.error(`[experiences-geocode] could not stamp meeting_point attempt for ${id}:`, err);
    }
  };

  for (const row of meetingPointRows) {
    try {
      const parsed = parseAddressLike(row.meeting_point);
      if (!parsed) {
        // Not address-shaped — leave it at kommune precision, honestly, and
        // stamp so it does not come back round on the very next tick.
        stats.meeting_point_not_addresslike++;
        stampAttempt(row.id);
        continue;
      }
      const result = await geocodeOne(
        parsed.street,
        parsed.postnummer ?? "",
        row.poststed ?? row.kommune ?? "",
        deps
      );
      if (result.confidence === "no_match") {
        stats.meeting_point_no_match++;
        stampAttempt(row.id);
        continue;
      }
      upgradeFromMeetingPoint.run(result.lat, result.lng, nextMeetingPointStamp(), row.id);
      stats.experiences_upgraded_to_address++;
      stats.experiences_upgraded_from_meeting_point++;
    } catch (err) {
      stats.errors++;
      console.error(`[experiences-geocode] meeting_point upgrade failed for ${row.id}:`, err);
      // Errors rotate too — a row that throws every tick must not pin the head
      // of the queue (same invariant as the agents worker's catch).
      stampAttempt(row.id);
    }
  }

  stats.duration_ms = Date.now() - start;
  return stats;
}

// ─── Backlog re-geocode pass — dev-request 2026-09-10-gardssalg-geocode-
// backlog-sted-retry ──────────────────────────────────────────────────────
//
// PRs #840/#841 shipped Step D's Stedsnavn-in-kommune tier just above
// (providers_sted_fallback), but measured live 2026-09-10 it has hit ZERO
// rows in production. The cause is Step D's own SELECT — `WHERE lat IS NULL
// AND (geocode_confidence = 'no_match' OR …)` — which is exactly right for
// the ordinary tick's documented idempotence ("never re-hammers a dead
// address"), but has the side effect that the 85 rows already sitting at
// geocode_confidence='approximate' (a real lat/lon already stored, from
// BEFORE Skive 2 shipped) are invisible to it forever: they already have a
// lat/lon, so `lat IS NULL` excludes them on every future tick, no matter how
// long the worker runs.
//
// This is a deliberate, EXPLICIT, BOUNDED exception to that idempotence rule
// — a distinct entry point, never folded into experiencesGeocodeTick()/Step D
// itself, so the ordinary tick's own SELECT (and its idempotence contract for
// dead addresses) stays completely untouched. It only ever looks at rows
// already at geocode_confidence='approximate' (the readiness report's
// "kommune" bucket — see GET /admin/gardssalg-outreach-readiness's own
// bucketing, which treats 'approximate' as the sole provider-level "kommune
// precision" value), only ever attempts the SAME stedsnavn-in-kommune lookup
// Step D uses (geocodeStedInKommuneDiagnostic(), the diagnostic twin of
// geocodeStedInKommune() in geocoding-service.ts — no lookup logic
// reimplemented here), and — like Step D — REFUSES to write anything it
// cannot corroborate to the row's own kommune: an honest kommune centroid
// always beats a wrong precise point, so an ambiguous or no-match lookup
// leaves the row byte-identical. Never touches `experiences.geo_precision` —
// Step B/E's own comments already document that propagating a 'sted'-tier
// provider point down to experiences is a distinct, un-asked-for future
// slice, and this backlog pass inherits that same boundary unchanged.
//
// dev-request 2026-09-11 fix 3 — a row parseAddressLike() now (correctly,
// since fix 2 above) recognises as street-address-shaped gets a REAL shot at
// the address tier instead of being skipped outright: geocodeOne() (the same
// Step A entry point, same GeocodeDeps test-injection seam threaded through
// as `opts.deps`) is tried against the CLEANED street parseAddressLike()
// already extracted. A confirmed hit upgrades the row past 'approximate' at
// address precision (geocode_source='kartverket_backlog'); no match or an
// implausible coordinate falls back to the exact same skipped_address_shaped
// counter/action as before — "tried and still couldn't confirm" rather than
// "never tried". Still never writes a coordinate this pass cannot corroborate.
//
// Pagination (dev-request 2026-09-11-geo-pagination) — an `after` cursor
// (last-seen id) threads through selectBacklogCandidates()'s WHERE clause so
// a row that is scanned but SKIPPED (no match / already correct / ambiguous)
// does not sort right back to the top of the very next call's window: it
// keeps the exact same column values, so a bare `ORDER BY id LIMIT ?` with no
// cursor re-selects it forever and the tail of the backlog past `limit` is
// never reached. `next_after` (the id of the last row this call scanned, or
// null once a page comes back shorter than `limit` — the backlog is
// exhausted) is the caller's cue to pass `after: next_after` on the next call,
// same keyset-pagination contract as GET /admin/providers/all.

export type ExperiencesGeocodeBacklogAction =
  | "upgraded"
  | "upgraded_address"
  | "would_upgrade"
  | "would_upgrade_address"
  | "skipped_address_shaped"
  | "skipped_ambiguous"
  | "skipped_no_match"
  | "skipped_race"
  | "error";

export type ExperiencesGeocodeBacklogRowOutcome = {
  provider_id: string;
  navn: string | null;
  kommune: string | null;
  adresse: string;
  before: { lat: number | null; lon: number | null; geocode_confidence: string | null };
  action: ExperiencesGeocodeBacklogAction;
  reason?: string;
  /** Only set for "upgraded"/"would_upgrade"/"upgraded_address"/"would_upgrade_address" — the planned point and its source label (Stedsnavn place name, or the cleaned street for the address tier). */
  planned?: { lat: number; lon: number; place_name: string };
};

export type ExperiencesGeocodeBacklogResult = {
  dry_run: boolean;
  limit: number;
  candidates_scanned: number;
  upgraded: number;
  /** Fix 3 — address-tier upgrades (parseAddressLike() + geocodeOne()), counted separately from the sted-tier `upgraded` above. */
  upgraded_address: number;
  would_upgrade: number;
  /** Fix 3 — dry-run twin of `upgraded_address`. */
  would_upgrade_address: number;
  skipped_address_shaped: number;
  skipped_ambiguous: number;
  skipped_no_match: number;
  skipped_race: number;
  errors: number;
  rows: ExperiencesGeocodeBacklogRowOutcome[];
  duration_ms: number;
  /** Keyset pagination cursor — the id of the last row scanned this call, or null once the page came back shorter than `limit` (backlog exhausted). Pass back as `opts.after` on the next call. */
  next_after: string | null;
};

// Smaller ceiling than agents-geocode-worker.ts's clampGeocodeBatchLimit
// (max 200) — this route deliberately re-attempts rows that already have a
// stored value, so a bounded, resumable chunk matters more here than a big
// single call. Same "cap style" as LH_DISCOVERY_BATCH_CAP (opplevelser.ts)
// and this file's own `limit` param, just with its own name/default per the
// spec's own "30-50 rows per call" instruction.
export const EXPERIENCES_GEOCODE_BACKLOG_LIMIT_DEFAULT = 40;
export const EXPERIENCES_GEOCODE_BACKLOG_LIMIT_MAX = 50;

/** Clamp a caller-supplied batch limit into [1, 50]; non-numbers -> default (mirrors clampGeocodeBatchLimit's shape). */
export function clampExperiencesGeocodeBacklogLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : EXPERIENCES_GEOCODE_BACKLOG_LIMIT_DEFAULT;
  return Math.max(1, Math.min(EXPERIENCES_GEOCODE_BACKLOG_LIMIT_MAX, n));
}

/**
 * STRICT dry_run parser — same non-negotiable-boolean discipline as
 * agents-geocode-worker.ts's parseDryRunFlag() (review B4: a quoted
 * "true"/"false" is REJECTED rather than silently misread, because a
 * misparsed dry_run on a mutation-rehearsal switch would otherwise perform a
 * real write). The default is flipped relative to that function, though:
 * parseDryRunFlag()'s caller (city-backfill) writes rows that start out
 * EMPTY, so its safe default is "no dry_run field = apply". This route
 * REWRITES rows that already carry a geocoded point, so the safe default has
 * to be the other way — no dry_run field = read-only — matching
 * admin-knowledge.ts's address-norge-suffix-sweep default-safe convention
 * (`dry_run !== false`).
 */
export function parseExperiencesGeocodeBacklogDryRunFlag(
  raw: unknown
): { ok: true; dryRun: boolean } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, dryRun: true };
  if (typeof raw === "boolean") return { ok: true, dryRun: raw };
  return {
    ok: false,
    error:
      `dry_run må være en boolsk verdi (true/false uten anførselstegn) — fikk ${JSON.stringify(raw)}. ` +
      `Avvist i stedet for tolket: denne ruten skriver over rader som allerede har et geokodet punkt.`,
  };
}

/**
 * The backlog SELECT, as its own function so the admin route's queue-status
 * check (before/after, same shape as city-backfill's own
 * cityBackfillQueueStatus()) can share the exact same WHERE clause as the
 * pass itself — the same "one source of truth for eligibility" discipline
 * agents-geocode-worker.ts's own module comment documents for its selector.
 */
type BacklogCandidateRow = {
  id: string;
  navn: string | null;
  adresse: string;
  kommune: string | null;
  kommunenummer: string | null;
  fylke: string | null;
  lat: number;
  lon: number;
  geocode_confidence: string | null;
};

function selectBacklogCandidates(
  db: ReturnType<typeof getDb>,
  limit: number,
  after: string
): BacklogCandidateRow[] {
  return db
    .prepare(
      `SELECT id, navn, adresse, kommune, kommunenummer, fylke, lat, lon, geocode_confidence
         FROM experience_providers
        WHERE geocode_confidence = 'approximate'
          AND lat IS NOT NULL AND lon IS NOT NULL
          AND adresse IS NOT NULL AND adresse <> ''
          AND id > ?
        ORDER BY id
        LIMIT ?`
    )
    .all(after, limit) as BacklogCandidateRow[];
}

/** Same WHERE clause as the pass's own SELECT, no LIMIT — cheap status check for the admin route's before/after block. */
export function experiencesGeocodeBacklogQueueStatus(): { pending: number } {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM experience_providers
        WHERE geocode_confidence = 'approximate'
          AND lat IS NOT NULL AND lon IS NOT NULL
          AND adresse IS NOT NULL AND adresse <> ''`
    )
    .get() as { n: number };
  return { pending: row?.n ?? 0 };
}

/**
 * Backlog re-geocode pass. Chunked (bounded by `limit`), resumable two ways —
 * a row this call upgrades past 'approximate' is excluded from the very next
 * call's SELECT by the WHERE clause itself (no separate "already processed"
 * bookkeeping needed), AND a row this call scans but leaves 'approximate'
 * (skipped/ambiguous/no_match) is excluded from the NEXT call by the `after`
 * keyset cursor (`opts.after`, echoed back as `result.next_after`) — without
 * it, a byte-identical skipped row sorts right back to the top of the very
 * next `ORDER BY id LIMIT ?` window and the tail of the backlog past `limit`
 * is never reached. And dry-run-safe by default (see
 * parseExperiencesGeocodeBacklogDryRunFlag() above). `opts.deps` threads the
 * same GeocodeDeps test-injection seam experiencesGeocodeTick() itself uses,
 * for the fix-3 address-tier geocodeOne() call below.
 */
export async function runExperiencesGeocodeBacklogPass(
  limit: number = EXPERIENCES_GEOCODE_BACKLOG_LIMIT_DEFAULT,
  opts: { dryRun?: boolean; after?: string; deps?: GeocodeDeps } = {}
): Promise<ExperiencesGeocodeBacklogResult> {
  const start = Date.now();
  const dryRun = opts.dryRun !== false;
  const after = typeof opts.after === "string" ? opts.after : "";
  const deps: GeocodeDeps = opts.deps ?? {};
  const db = getDb(VERTICAL);

  const result: ExperiencesGeocodeBacklogResult = {
    dry_run: dryRun,
    limit,
    candidates_scanned: 0,
    upgraded: 0,
    upgraded_address: 0,
    would_upgrade: 0,
    would_upgrade_address: 0,
    skipped_address_shaped: 0,
    skipped_ambiguous: 0,
    skipped_no_match: 0,
    skipped_race: 0,
    errors: 0,
    rows: [],
    duration_ms: 0,
    next_after: null,
  };

  const rows = selectBacklogCandidates(db, limit, after);
  // Keyset cursor for the NEXT call — the last id this call scanned, or null
  // once a page comes back shorter than `limit` (nothing left to scan). Set
  // up front from the SELECT itself so it reflects what was scanned even if
  // an individual row's processing throws below.
  result.next_after = rows.length === limit && rows.length > 0 ? rows[rows.length - 1].id : null;

  const updateSted = db.prepare(
    `UPDATE experience_providers
        SET lat = ?, lon = ?, geocode_source = 'stedsnavn_kommune_backlog', geocode_confidence = 'sted',
            updated_at = datetime('now')
      WHERE id = ? AND geocode_confidence = 'approximate'`
  );
  // Fix 3 — the address-tier upgrade. Same compare-and-swap guard as
  // updateSted above: never overwrite a row that moved off 'approximate'
  // between this call's SELECT and its UPDATE. geocode_confidence is written
  // from geocodeOne()'s OWN confidence tier (high/medium/low) — the same
  // honest propagation Step A itself does — rather than a hardcoded value.
  const updateAddress = db.prepare(
    `UPDATE experience_providers
        SET lat = ?, lon = ?, geocode_source = 'kartverket_backlog', geocode_confidence = ?,
            updated_at = datetime('now')
      WHERE id = ? AND geocode_confidence = 'approximate'`
  );

  for (const row of rows) {
    result.candidates_scanned++;
    const before = { lat: row.lat, lon: row.lon, geocode_confidence: row.geocode_confidence };
    const base = { provider_id: row.id, navn: row.navn, kommune: row.kommune, adresse: row.adresse, before };

    try {
      // Step D's OWN gate, reused verbatim: an address-SHAPED adresse is not
      // what the STEDSNAVN tier below is for (a dead STREET address is Step
      // A's problem, not the sted lookup's) — parseAddressLike() returning
      // non-null means "this looks like a street". Fix 3 (dev-request
      // 2026-09-11): rather than skip it outright, give it the real address
      // tier's own shot first — reusing the CLEANED street parseAddressLike()
      // already extracted, never re-derived.
      const parsedAddress = parseAddressLike(row.adresse);
      if (parsedAddress) {
        const addressResult = await geocodeOne(
          parsedAddress.street,
          parsedAddress.postnummer ?? "",
          row.kommune ?? row.fylke ?? "",
          deps
        );

        if (
          addressResult.confidence !== "no_match" &&
          isPlausibleNorwayCoord(addressResult.lat, addressResult.lng)
        ) {
          const planned = { lat: addressResult.lat, lon: addressResult.lng, place_name: parsedAddress.street };

          if (dryRun) {
            result.would_upgrade_address++;
            result.rows.push({ ...base, action: "would_upgrade_address", planned });
            continue;
          }

          const write = updateAddress.run(addressResult.lat, addressResult.lng, addressResult.confidence, row.id);
          if (write.changes > 0) {
            result.upgraded_address++;
            result.rows.push({ ...base, action: "upgraded_address", planned });
          } else {
            // Same concurrent-race guard as updateSted below.
            result.skipped_race++;
            result.rows.push({
              ...base, action: "skipped_race",
              reason: "row's geocode_confidence changed since selection (concurrent run?) — left untouched",
            });
          }
          continue;
        }

        // Tried the address tier and it could not confirm a point — same
        // counter/action as before fix 3, but now honestly "attempted and
        // still unconfirmed" rather than "never attempted".
        result.skipped_address_shaped++;
        result.rows.push({
          ...base, action: "skipped_address_shaped",
          reason: "adresse is street-address-shaped; address-tier geocode attempted but returned no confirmable Norwegian match",
        });
        continue;
      }

      const outcome = await geocodingService.geocodeStedInKommuneDiagnostic(row.adresse, row.kommunenummer, row.kommune);

      if (outcome.status === "ambiguous") {
        result.skipped_ambiguous++;
        result.rows.push({ ...base, action: "skipped_ambiguous", reason: outcome.reason });
        continue;
      }
      if (outcome.status === "no_match") {
        result.skipped_no_match++;
        result.rows.push({ ...base, action: "skipped_no_match", reason: outcome.reason });
        continue;
      }

      // resolved — but never trust a geocoder answer that cannot be a
      // Norwegian position, the exact same sanity gate as Step A/D above.
      if (!isPlausibleNorwayCoord(outcome.geo.lat, outcome.geo.lng)) {
        result.skipped_no_match++;
        result.rows.push({
          ...base, action: "skipped_no_match",
          reason: `Stedsnavn hit (${outcome.geo.lat}/${outcome.geo.lng}) is not a plausible Norwegian position`,
        });
        continue;
      }

      const planned = { lat: outcome.geo.lat, lon: outcome.geo.lng, place_name: outcome.geo.name };

      if (dryRun) {
        result.would_upgrade++;
        result.rows.push({ ...base, action: "would_upgrade", planned });
        continue;
      }

      const write = updateSted.run(outcome.geo.lat, outcome.geo.lng, row.id);
      if (write.changes > 0) {
        result.upgraded++;
        result.rows.push({ ...base, action: "upgraded", planned });
      } else {
        // Compare-and-swap missed: the row moved off geocode_confidence=
        // 'approximate' between this call's SELECT and its UPDATE (e.g. the
        // ordinary tick ran concurrently, or a prior chunk in the same call
        // already… no, `id` rows are only visited once per call — this is the
        // concurrent-process case). Never double-write; report it plainly
        // rather than silently dropping it (review discipline: a resumable
        // batch must never look like it did nothing when it actually raced).
        result.skipped_race++;
        result.rows.push({
          ...base, action: "skipped_race",
          reason: "row's geocode_confidence changed since selection (concurrent run?) — left untouched",
        });
      }
    } catch (err) {
      result.errors++;
      result.rows.push({ ...base, action: "error", reason: String((err as any)?.message || err) });
      console.error(`[experiences-geocode-backlog] row ${row.id} failed:`, err);
    }
  }

  result.duration_ms = Date.now() - start;
  return result;
}
