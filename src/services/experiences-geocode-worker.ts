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
  const parts = delabelled.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  // A 4-digit group anywhere in the string is a postnummer candidate. Guarded
  // against year-like numbers by requiring it to be followed by a word (the
  // poststed) or to end the string, and to not be part of a longer number.
  const postMatch = delabelled.match(/(?:^|[\s,])(\d{4})(?=[\s,]|$)/);
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
  if (/\b(danmark|denmark|sverige|sweden|finland|island|iceland|deutschland|germany|tyskland|nederland|holland|storbritannia|england|scotland|skottland)\b/i.test(delabelled)) {
    return null;
  }

  // A street with no postnummer anywhere is too weak: "Storgata 5" exists in
  // dozens of kommuner and geocodeOne would happily return the first one.
  if (!postnummer) return null;

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

  // ─── Step A — provider address geocoding ───────────────────────────
  // Exact mirror of dental-geocode-worker's WHERE clause: excludes both
  // successfully-geocoded rows (lat IS NOT NULL) and prior no_match rows
  // (geocode_confidence='no_match'), so the worker is naturally idempotent
  // across ticks and never re-hammers a dead address.
  const providerRows = db
    .prepare(
      `SELECT id, adresse, postnummer, poststed
       FROM experience_providers
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
      const result = await geocodeOne(
        row.adresse,
        row.postnummer,
        row.poststed ?? "",
        deps
      );
      stats.providers_processed++;

      if (result.confidence === "no_match") {
        stats.providers_no_match++;
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
      `SELECT id, kommune, kommunenummer, fylke
         FROM experience_providers
        WHERE lat IS NULL
          AND (
            geocode_confidence = 'no_match'
            OR (
              geocode_confidence IS NULL
              AND (adresse IS NULL OR adresse = '' OR postnummer IS NULL OR postnummer = '')
            )
          )
          AND ((kommune IS NOT NULL AND kommune <> '') OR (fylke IS NOT NULL AND fylke <> ''))
        ORDER BY id
        LIMIT ?`
    )
    .all(limit) as Array<{ id: string; kommune: string | null; kommunenummer: string | null; fylke: string | null }>;

  const updateProviderApprox = db.prepare(
    `UPDATE experience_providers
        SET lat = ?, lon = ?, geocode_source = 'kommune_fallback', geocode_confidence = 'approximate',
            updated_at = datetime('now')
      WHERE id = ?`
  );

  for (const row of providerFallbackRows) {
    try {
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
      if (geo) {
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
            AND p.geocode_confidence NOT IN ('no_match', 'approximate')
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
  // geo_precision='address'), but for rows already tagged 'kommune'.
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
            AND p.geocode_confidence NOT IN ('no_match', 'approximate')
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
        parsed.postnummer as string,
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
