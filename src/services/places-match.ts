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
//   pickConfidentPlace(entity, places)   — the first confident candidate in
//                                          one Text Search answer (the other
//                                          candidates cost nothing extra)
//   rfbPlaceMatchEntity(producer)        — RFB name + location → entity
//   pickRfbPlace(producer, places)       — the RFB routes' entry point, behind
//                                          PLACES_MATCH_GUARD_ENABLED
//   formatPlacesMatchGuardLog(...)       — the "[places-match-guard]" line,
//                                          same shape as the Brreg guard's
//
// PURE: no DB, no network. The routes do the I/O.

import { nameSimilarity, nameVariants, normaliseForMatch } from "./name-matcher";

// ─── Thresholds (PR-128, unchanged) ────────────────────────────────────
export const NAME_SIM_THRESHOLD = 0.55;
// When the entity has no postal code we can only cross-check on town name,
// which is weaker — require a higher name similarity on that path.
export const NAME_SIM_THRESHOLD_POSTSTED_ONLY = 0.65;

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
  /** First candidate, in Google's order, that passes the guard; null when none does. */
  place: P | null;
  /** Index of `place` in the candidate list; -1 when none passed. */
  index: number;
  /** Name similarity of `place` — or, when none passed, of the best-named candidate. */
  nameSim: number;
  /** Display name of that same candidate ("" when there were no candidates). */
  placeName: string;
}

export function pickConfidentPlace<P extends MatchablePlace>(
  entity: PlaceMatchEntity,
  places: readonly (P | null | undefined)[] | null | undefined
): PlacePick<P> {
  const list = Array.isArray(places) ? places : [];
  let best: { nameSim: number; placeName: string } | null = null;
  for (let i = 0; i < list.length; i++) {
    const place = list[i];
    if (!place) continue;
    const placeName = place.displayName?.text ?? "";
    const nameSim = placeNameSimilarity(entity, placeName);
    if (corroborates(entity, place, nameSim)) return { place, index: i, nameSim, placeName };
    if (!best || nameSim > best.nameSim) best = { nameSim, placeName };
  }
  return { place: null, index: -1, nameSim: best?.nameSim ?? 0, placeName: best?.placeName ?? "" };
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
 */
export function stripPlatformPlaceSuffix(name: string): string {
  return (name || "").split(/\s*[—–]\s*|\s+-\s+/)[0]!.trim();
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

/**
 * The RFB routes' entry point. Guard on (default): the first confident
 * candidate, or place:null. Guard off (PLACES_MATCH_GUARD_ENABLED = false):
 * Google's first candidate, exactly the pre-guard behaviour. `guardEnabled`
 * is a parameter only so the switch itself can be tested.
 */
export function pickRfbPlace<P extends MatchablePlace>(
  producer: RfbPlaceMatchInput,
  places: readonly (P | null | undefined)[] | null | undefined,
  guardEnabled: boolean = PLACES_MATCH_GUARD_ENABLED
): PlacePick<P> {
  const entity = rfbPlaceMatchEntity(producer);
  if (guardEnabled) return pickConfidentPlace(entity, places);
  const first = (Array.isArray(places) ? places[0] : null) ?? null;
  const placeName = first?.displayName?.text ?? "";
  return { place: first, index: first ? 0 : -1, nameSim: placeNameSimilarity(entity, placeName), placeName };
}

/**
 * The guard's warn line — same shape as the Brreg guard's
 * ("[brreg-address-guard] rejected name hit for agent …: <reason> (…)").
 */
export function formatPlacesMatchGuardLog(
  agentId: string,
  pick: PlacePick<unknown>,
  candidates: number,
  producer: RfbPlaceMatchInput
): string {
  const entity = rfbPlaceMatchEntity(producer);
  return (
    `[places-match-guard] rejected Places hit for agent ${agentId}: place_mismatch ` +
    `(place "${pick.placeName}", nameSim ${pick.nameSim.toFixed(2)}, ${candidates} candidate(s); ` +
    `producer ${entity.postalCode ?? "-"} ${entity.postalTown ?? "-"})`
  );
}
