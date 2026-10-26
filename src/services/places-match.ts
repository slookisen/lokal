// ─── places-match — shared Google Places match guard ────────────────────
// dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-
// treffvakt, slice S3.
//
// A Places Text Search answer is a list of candidates for a free-text query,
// not a lookup of OUR entity. Writing the first candidate's rating, address or
// phone onto a producer or clinic without checking it is how Bergen Mathall
// got Mathallen Oslo's data and 16k-review rating (dev-request
// 2026-07-16-wrong-entity-opprydding-rfb). Dental has guarded its writes since
// PR-128; RFB's two rating routes took places[0] unchecked. The rule now lives
// here with a neutral input, and both verticals use it:
//
//   isConfidentPlaceMatch(entity, place) — the PR-128 rule, moved unchanged
//                                          (dental-places.ts maps its clinic
//                                          fields onto it)
//   pickConfidentPlace(entity, places)   — the BEST-named confident candidate
//                                          in one Text Search answer (the
//                                          other candidates cost nothing
//                                          extra); none when two differently
//                                          named ones nearly tie
//   rfbPlaceMatchEntity(producer)        — RFB name + location → entity
//   pickRfbPlace(entity, places)         — the RFB routes' entry point, behind
//                                          PLACES_MATCH_GUARD_ENABLED; adds
//                                          the RFB-only farm-qualifier veto
//   rfbPlacesTextQuery(name, city)       — the Text Search query both RFB
//                                          routes send
//   formatPlacesMatchGuardLog(...)       — the "[places-match-guard]" line,
//                                          same shape as the Brreg guard's
//   placesFieldMask(fields)              — a FieldMask without Google's
//                                          rating fields while
//                                          GOOGLE_RATING_FETCH_ENABLED is off
//                                          (S4-A2); RFB and dental
//   fieldMaskRequestsRating(mask)        — does a sent mask ask for one?
//                                          (the Places call log, S4-A2)
//
// PURE: no DB, no network. The routes do the I/O.

import { nameSimilarity, nameVariants, normaliseForMatch } from "./name-matcher";

// ─── Thresholds (PR-128, unchanged) ────────────────────────────────────
export const NAME_SIM_THRESHOLD = 0.55;
// When the entity has no postal code we can only cross-check on town name,
// which is weaker — require a higher name similarity on that path.
export const NAME_SIM_THRESHOLD_POSTSTED_ONLY = 0.65;

// ─── Pick thresholds (S3) ──────────────────────────────────────────────
// Several candidates in one answer can pass the guard: "Nordre Hov Gård"
// clears the 0.55 bar for a producer "Hov Gård" in the same postal code
// (0.67). The best-named one wins. Below PICK_CLEAR_NAME_SIM, a differently
// named passing candidate within PICK_TIE_MARGIN of it means the answer cannot
// tell them apart (for "Hov Gård": Nordre and Søndre Hov Gård, 0.67 each), so
// none is picked.
export const PICK_CLEAR_NAME_SIM = 0.9;
export const PICK_TIE_MARGIN = 0.05;

// Kill switch for the RFB call sites ONLY (pickRfbPlace). Dental always
// guards. Rollback without a revert: a one-line PR setting this to false,
// which restores the pre-guard "take places[0]" behaviour on RFB.
export const PLACES_MATCH_GUARD_ENABLED = true;

// ─── Input shapes ───────────────────────────────────────────────────────
// The subset of a Places (New) place the guard reads. Requires
// places.displayName and places.addressComponents in the FieldMask (both
// Pro-tier fields).
export interface PlaceAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}
export interface MatchablePlace {
  displayName?: { text?: string };
  addressComponents?: PlaceAddressComponent[];
}

export interface PlaceMatchEntity {
  name: string;
  /** Other spellings of the same name. The best-scoring spelling counts. */
  altNames?: readonly string[];
  postalCode?: string | null;
  postalTown?: string | null;
}

function componentByType(place: MatchablePlace, t: string): PlaceAddressComponent | undefined {
  const comps = Array.isArray(place.addressComponents) ? place.addressComponents : [];
  return comps.find((c) => Array.isArray(c?.types) && c.types!.includes(t));
}

/** Best name similarity between the entity (name or any altName) and a place name. */
export function placeNameSimilarity(entity: PlaceMatchEntity, placeName: string): number {
  let best = nameSimilarity(entity.name ?? "", placeName);
  for (const alt of entity.altNames ?? []) {
    const sim = nameSimilarity(alt, placeName);
    if (sim > best) best = sim;
  }
  return best;
}

// Location half of the guard, given the name similarity already computed.
function corroborates(entity: PlaceMatchEntity, place: MatchablePlace, sim: number): boolean {
  if (sim < NAME_SIM_THRESHOLD) return false;

  const postalCode = (entity.postalCode ?? "").toString().trim();
  if (postalCode) {
    // Strongest branch-specific key: exact postal_code equality, else hard-fail.
    const pc = componentByType(place, "postal_code");
    const pcVal = ((pc?.longText ?? pc?.shortText ?? "") as string).trim();
    return pcVal !== "" && pcVal === postalCode;
  }

  // No postal code on the entity → stricter name bar + town equality.
  if (sim < NAME_SIM_THRESHOLD_POSTSTED_ONLY) return false;
  const town = (entity.postalTown ?? "").toString().trim().toLowerCase();
  if (!town) return false;
  const loc = componentByType(place, "postal_town") ?? componentByType(place, "locality");
  const locVal = ((loc?.longText ?? loc?.shortText ?? "") as string).trim().toLowerCase();
  return locVal !== "" && locVal === town;
}

// ─── isConfidentPlaceMatch ─────────────────────────────────────────────
/**
 * Confident-match guard (anti-contamination). A place is accepted ONLY if the
 * name is similar enough AND the location is corroborated:
 *  - If the entity has a postal code: REQUIRE an exact match against the
 *    place's postal_code component. A mismatch (or missing component)
 *    hard-fails — this is what stops a same-city sibling branch (e.g. Oris
 *    Storo vs Oris Lambertseter, both "Oslo") from being mistaken for it.
 *  - If the entity has NO postal code: require a higher name threshold AND an
 *    exact (case-insensitive) match of the place's postal_town/locality
 *    against the entity's town (equality, not a formattedAddress substring —
 *    the latter false-positives on short names like "Mo" ⊂ "Moss").
 */
export function isConfidentPlaceMatch(
  entity: PlaceMatchEntity,
  place: MatchablePlace | null | undefined
): boolean {
  if (!place) return false;
  return corroborates(entity, place, placeNameSimilarity(entity, place.displayName?.text ?? ""));
}

// ─── pickConfidentPlace ────────────────────────────────────────────────
export interface PlacePick<P> {
  /** The picked candidate; null when none passed or the best ones nearly tie. */
  place: P | null;
  /** Index of `place` in the candidate list; -1 when none was picked. */
  index: number;
  /**
   * Name similarity of `place` — or, when none was picked, of the best
   * passing candidate (ambiguous) or else the best-named candidate.
   */
  nameSim: number;
  /** Display name of that same candidate ("" when there were no candidates). */
  placeName: string;
  /**
   * Why `place` is null: "no_candidates", "no_confident_candidate",
   * "ambiguous", or the label a veto returned for the reported candidate.
   * null when a place was picked.
   */
  reason: string | null;
  /** "ambiguous" only: the display name of the near-tying rival. */
  rival?: string;
}

/**
 * Pick from one Text Search answer. Among the candidates that pass
 * isConfidentPlaceMatch (and the optional caller veto), the highest name
 * similarity wins; on equal similarity Google's order decides. When that best
 * candidate scores below PICK_CLEAR_NAME_SIM and a passing candidate with a
 * different (normalised) name scores within PICK_TIE_MARGIN of it, nothing is
 * picked (reason "ambiguous").
 *
 * `veto(placeName)` lets a caller reject a candidate the shared rule would
 * accept; it returns a reason label, or null to let it through.
 */
export function pickConfidentPlace<P extends MatchablePlace>(
  entity: PlaceMatchEntity,
  places: readonly (P | null | undefined)[] | null | undefined,
  veto?: (placeName: string) => string | null
): PlacePick<P> {
  const list = Array.isArray(places) ? places : [];
  const passing: { place: P; index: number; nameSim: number; placeName: string }[] = [];
  let bestNamed: { nameSim: number; placeName: string; reason: string } | null = null;
  for (let i = 0; i < list.length; i++) {
    const place = list[i];
    if (!place) continue;
    const placeName = place.displayName?.text ?? "";
    const nameSim = placeNameSimilarity(entity, placeName);
    let rejected: string | null = corroborates(entity, place, nameSim) ? null : "no_confident_candidate";
    if (!rejected && veto) rejected = veto(placeName);
    if (!rejected) passing.push({ place, index: i, nameSim, placeName });
    else if (!bestNamed || nameSim > bestNamed.nameSim) bestNamed = { nameSim, placeName, reason: rejected };
  }

  if (passing.length === 0) {
    return {
      place: null,
      index: -1,
      nameSim: bestNamed?.nameSim ?? 0,
      placeName: bestNamed?.placeName ?? "",
      reason: bestNamed?.reason ?? "no_candidates",
    };
  }

  let top = passing[0]!;
  for (const c of passing) if (c.nameSim > top.nameSim) top = c; // strict: ties keep Google's order
  if (top.nameSim < PICK_CLEAR_NAME_SIM) {
    const topKey = normaliseForMatch(top.placeName);
    const rival = passing.find(
      (c) => c !== top && top.nameSim - c.nameSim < PICK_TIE_MARGIN && normaliseForMatch(c.placeName) !== topKey
    );
    if (rival) {
      return { place: null, index: -1, nameSim: top.nameSim, placeName: top.placeName, reason: "ambiguous", rival: rival.placeName };
    }
  }
  return { place: top.place, index: top.index, nameSim: top.nameSim, placeName: top.placeName, reason: null };
}

// ─── RFB adapter ────────────────────────────────────────────────────────
export interface RfbPlaceMatchInput {
  /** agents.name, possibly in the platform's «<Producer> — <Place>» form. */
  name: string;
  /** agent_knowledge.postal_code. */
  postalCode?: string | null;
  /** agents.city. */
  city?: string | null;
}

/**
 * Drop the platform's place suffix: «Alm Gård — Feios» → «Alm Gård». An em or
 * en dash with or without spaces, or a hyphen WITH spaces on both sides (the
 * same split as contact-normalizer's own-name rule). An in-word hyphen
 * ("Midt-Telemark", "Øvre-Ål") is part of the name and never splits.
 *
 * Same result as split(/\s*[—–]\s*|\s+-\s+/)[0].trim(), but that pattern
 * backtracks quadratically on a long run of spaces; these fixed-width
 * alternatives scan once, and trim() drops the spaces next to the dash.
 */
export function stripPlatformPlaceSuffix(name: string): string {
  const s = name || "";
  const m = /[—–]|\s-\s/.exec(s);
  return (m ? s.slice(0, m.index) : s).trim();
}

/**
 * The Text Search query both RFB rating routes send: «<name> <city> Norway»
 * with every dash (em, en, hyphen) and the spaces around it turned into one
 * space. Same output as the routes' pre-S3 regex replace (optional spaces, a
 * dash, optional spaces → " ", then trim), without its quadratic backtracking
 * on long runs of spaces: split on the dash alone, trim the pieces' inner ends.
 */
export function rfbPlacesTextQuery(name: string, city: string): string {
  const parts = `${name} ${city} Norway`.split(/[—–-]/);
  return parts
    .map((p, i) => {
      let t = p;
      if (i > 0) t = t.trimStart();
      if (i < parts.length - 1) t = t.trimEnd();
      return t;
    })
    .join(" ")
    .trim();
}

/**
 * RFB producer → guard entity.
 *
 * Name: the stored name, plus the nameVariants of the suffix-stripped name
 * (itself, without org suffix "AS", without farm suffix "Gård" …). When the
 * stripped name has several words, single-word variants are left out — that
 * drops nameVariants' first-word fallback and a suffix strip down to one
 * word. Dice between one word and a longer place name is high whenever the
 * place name merely starts with that word: "bergen" vs "Bergen Kebab" = 0.63
 * passes the 0.55 bar, where "Bergen Mathall" itself scores 0.50. In a
 * city-centre postal code such a variant would accept a neighbouring business.
 *
 * Location: a 4-digit agent_knowledge.postal_code, else agents.city against
 * postal_town/locality. A stored postal code that is not 4 digits is treated
 * as missing (same rule as brreg-address-guard), so the city path applies.
 */
export function rfbPlaceMatchEntity(input: RfbPlaceMatchInput): PlaceMatchEntity {
  const name = (input.name || "").trim();
  const base = stripPlatformPlaceSuffix(name) || name;
  const multiWord = normaliseForMatch(base).includes(" ");
  const ownForm = normaliseForMatch(name);
  // nameVariants returns normalised, de-duplicated forms; its first entry is
  // the stripped name itself.
  const altNames = nameVariants(base).filter((v) => (!multiWord || v.includes(" ")) && v !== ownForm);
  const pc = (input.postalCode ?? "").toString().trim();
  return {
    name,
    altNames,
    postalCode: /^\d{4}$/.test(pc) ? pc : null,
    postalTown: (input.city ?? "").toString().trim() || null,
  };
}

// Farm-name qualifiers. «Nordre Hov» and «Søndre Hov» are different farms,
// yet their names score 0.79 against each other — enough for the shared rule
// in a shared postal code. Bokmål forms plus the nynorsk austre/søre/vesle.
const FARM_QUALIFIERS = new Set(
  ["nordre", "søndre", "søre", "øvre", "nedre", "vestre", "østre", "austre", "indre", "ytre", "midtre", "store", "lille", "vesle"]
    .map(normaliseForMatch)
);

function farmQualifiers(name: string): Set<string> {
  return new Set(normaliseForMatch(stripPlatformPlaceSuffix(name)).split(" ").filter((w) => FARM_QUALIFIERS.has(w)));
}

/**
 * True when each name carries a qualifier word the other lacks: «Nordre Hov
 * Gård» vs «Søndre Hov Gård», «Store Ree» vs «Lille Ree». One name without
 * any qualifier («Hov Gård» vs «Nordre Hov Gård») is not a conflict — name
 * similarity decides that, as before. RFB only (pickRfbPlace).
 */
export function farmQualifiersConflict(a: string, b: string): boolean {
  const qa = farmQualifiers(a);
  const qb = farmQualifiers(b);
  return [...qa].some((w) => !qb.has(w)) && [...qb].some((w) => !qa.has(w));
}

/**
 * The RFB routes' entry point, given rfbPlaceMatchEntity(producer). Guard on
 * (default): pickConfidentPlace plus the farm-qualifier veto, so dental's
 * rule is untouched. Guard off (PLACES_MATCH_GUARD_ENABLED = false): Google's
 * first candidate, exactly the pre-guard behaviour. `guardEnabled` is a
 * parameter only so the switch itself can be tested.
 */
export function pickRfbPlace<P extends MatchablePlace>(
  entity: PlaceMatchEntity,
  places: readonly (P | null | undefined)[] | null | undefined,
  guardEnabled: boolean = PLACES_MATCH_GUARD_ENABLED
): PlacePick<P> {
  if (guardEnabled) {
    return pickConfidentPlace(entity, places, (placeName) =>
      farmQualifiersConflict(entity.name, placeName) ? "qualifier_conflict" : null
    );
  }
  const first = (Array.isArray(places) ? places[0] : null) ?? null;
  const placeName = first?.displayName?.text ?? "";
  return {
    place: first,
    index: first ? 0 : -1,
    nameSim: placeNameSimilarity(entity, placeName),
    placeName,
    reason: first ? null : "no_candidates",
  };
}

/**
 * The guard's warn line — same shape as the Brreg guard's
 * ("[brreg-address-guard] rejected name hit for agent …: <reason> (…)").
 * An "ambiguous" or vetoed pick names that reason after nameSim.
 */
export function formatPlacesMatchGuardLog(
  agentId: string,
  pick: PlacePick<unknown>,
  candidates: number,
  entity: PlaceMatchEntity
): string {
  const why =
    pick.reason === "ambiguous"
      ? `, ambiguous with "${pick.rival ?? ""}"`
      : pick.reason && pick.reason !== "no_confident_candidate" && pick.reason !== "no_candidates"
        ? `, ${pick.reason}`
        : "";
  return (
    `[places-match-guard] rejected Places hit for agent ${agentId}: place_mismatch ` +
    `(place "${pick.placeName}", nameSim ${pick.nameSim.toFixed(2)}${why}, ${candidates} candidate(s); ` +
    `producer ${entity.postalCode ?? "-"} ${entity.postalTown ?? "-"})`
  );
}

// ─── Google rating fields (S4-A2) ───────────────────────────────────────
// Same dev-request, slice S4-A2: Daniel's decision 2=A (2026-10-17) phases the
// stored Google ratings out. Google's Places terms allow caching place_id (and
// lat/lng for 30 days), not rating or userRatingCount (A2A
// protocols/juridisk-sjekk-google-ratinger-2026-10-17.md §4.1), so the RFB
// rating routes no longer ask Google for them and write no rating. The values
// already stored stay untouched: deleting them needs Daniel's own yes.
// Rollback without a revert: a one-line PR setting this to true, which
// restores the pre-S4-A2 behaviour of both RFB routes (the rating masks, the
// batch's Enterprise-tier first-time call, rating writes).
export const GOOGLE_RATING_FETCH_ENABLED = false;

// dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-
// treffvakt (A6, Daniel's answer to question 26): finn-tannlege's Phase 2G
// (POST /api/tannlege/admin/google-places-batch) no longer asks Google Places
// for phone, website or opening hours and stores none of them from Places.
// While this is false the three fields are out of both dental masks, rows are
// not selected merely because one of them is empty, no Enterprise mask is
// chosen for them, and no google_places provenance is written for them. A row
// with no field left to fetch (address already filled) is not sent to Google.
// Values already stored stay untouched. The match guard is unchanged.
// Rollback without a revert: a one-line PR setting this to true, which
// restores the pre-A6 behaviour byte for byte.
export const DENTAL_PLACES_CONTACT_FIELDS_FETCH_ENABLED = false;

/** The Places (New) FieldMask entries for phone, website and opening hours. */
export const PLACES_DENTAL_CONTACT_FIELDS: readonly string[] = [
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.regularOpeningHours",
];

let dentalContactFieldsFetchForTesting: boolean | null = null;

/** Test-only: act as if DENTAL_PLACES_CONTACT_FIELDS_FETCH_ENABLED were `on`; null restores it. */
export function __setDentalPlacesContactFieldsFetchForTesting(on: boolean | null): void {
  dentalContactFieldsFetchForTesting = on;
}

/** DENTAL_PLACES_CONTACT_FIELDS_FETCH_ENABLED, or the test override. Phase 2G reads it per request. */
export function dentalPlacesContactFieldsFetchEnabled(): boolean {
  return dentalContactFieldsFetchForTesting ?? DENTAL_PLACES_CONTACT_FIELDS_FETCH_ENABLED;
}

/** The Places (New) FieldMask entries that carry Google's rating. */
export const PLACES_RATING_FIELDS: readonly string[] = ["places.rating", "places.userRatingCount"];

let googleRatingFetchForTesting: boolean | null = null;

/** Test-only: act as if GOOGLE_RATING_FETCH_ENABLED were `on`; null restores it. */
export function __setGoogleRatingFetchForTesting(on: boolean | null): void {
  googleRatingFetchForTesting = on;
}

/** GOOGLE_RATING_FETCH_ENABLED, or the test override. The RFB routes read it per request. */
export function googleRatingFetchEnabled(): boolean {
  return googleRatingFetchForTesting ?? GOOGLE_RATING_FETCH_ENABLED;
}

/**
 * The comma-joined FieldMask for `fields`, without PLACES_RATING_FIELDS unless
 * `ratingFetch` (default: googleRatingFetchEnabled()). The RFB masks that
 * listed a rating field are built with it, so none reaches Google while
 * fetching is off. Dental builds its masks with it and false: finn-tannlege
 * has never requested a rating, and decision 2 covers it too.
 */
export function placesFieldMask(
  fields: readonly string[],
  ratingFetch: boolean = googleRatingFetchEnabled()
): string {
  return fields.filter((f) => ratingFetch || !PLACES_RATING_FIELDS.includes(f)).join(",");
}

/**
 * True when the comma-separated FieldMask `mask` (as sent in X-Goog-FieldMask)
 * asks Google for a PLACES_RATING_FIELDS entry, for the Places call log
 * (services/places-usage-tracker.ts). A Place Details mask names the fields
 * without the "places." prefix, so both spellings count.
 */
export function fieldMaskRequestsRating(mask: string): boolean {
  return mask
    .split(",")
    .map((f) => f.trim())
    .some((f) => PLACES_RATING_FIELDS.includes(f) || PLACES_RATING_FIELDS.includes(`places.${f}`));
}
