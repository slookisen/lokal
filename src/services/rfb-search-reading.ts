/**
 * rfb-search-reading.ts — how the RFB searches read a free-text search before
 * discover(): the way MCP lokal_search reads it (routes/mcp.ts).
 *
 * dev-request 2026-10-17-integrasjonstest-oppfolging, slice I-AA (integration
 * test round 3: RFB-M-01, RFB-M-02, R3-RS-01, and FUNN rfb-ukjente-ord-web-rest).
 * Measured live 2026-10-19 on c9be20ea:
 * - A2A message/send (routes/a2a.ts, Mode 1) parsed the text and nothing
 *   more: no place lookup, no outside-Norway check, and DiscoveryQuerySchema
 *   dropped the parser's product, name and unknown words (Zod strips unknown
 *   keys). «honning Trondheim» gave Tønsberg, Hurum and Stathelle; lamb in
 *   Innlandet and reindeer in Finnmark the same 20 meat producers; «cheese in
 *   Stockholm» Norwegian dairies; «Finnes det kransekake» nothing.
 * - GET /sok (routes/seo.ts) put back the product and name words, but not the
 *   unknown words, so discover() step 3c never ran there: «kransekake» and
 *   «mandelbunn» showed the standard list as search results.
 *
 * lokal_search's reading is: the outside-Norway check (foreignPlaceIn) before
 * anything else, parseNaturalQuery, then the place in the text geocoded into
 * location and radius (enrichParsedWithGeo), and discover() on the parsed
 * query itself. A2A Mode 1 and /sok now read through readSearchText() and
 * geocodeSearchPlace(), and hand discover() the parser's words through
 * discoveryQueryOf().
 *
 * routes/mcp.ts is not changed: its tools and answers are frozen while OpenAI
 * reviews the app. Its own copies of these steps and texts (enrichParsedWithGeo,
 * outsideNorwayAnswer, noProductMatchText) stay; rfb-a2a-sok-paritet.test.ts
 * pins this module to them, so the surfaces cannot drift apart.
 */

import { marketplaceRegistry } from "./marketplace-registry";
import { geocodingService, type GeoResult } from "./geocoding-service";
import { foreignPlaceIn } from "./outside-norway";
import { DiscoveryQuerySchema, type DiscoveryQuery } from "../models/marketplace";

/** parseNaturalQuery's reading of a search. */
export type ParsedSearch = ReturnType<typeof marketplaceRegistry.parseNaturalQuery>;

export interface SearchText {
  /**
   * The place outside Norway the text names (foreignPlaceIn), or null. When
   * set, the search suggests no producer and no place is looked up.
   */
  outsideNorway: string | null;
  /** parseNaturalQuery's reading of the text. */
  parsed: ParsedSearch;
}

/**
 * Reads a free-text search as lokal_search does before it looks up the place:
 * foreignPlaceIn, then parseNaturalQuery. The text is read as given; the
 * callers cut it first (capFreeText).
 */
export function readSearchText(text: string): SearchText {
  return { outsideNorway: foreignPlaceIn(text), parsed: marketplaceRegistry.parseNaturalQuery(text) };
}

/**
 * lokal_search's next step (enrichParsedWithGeo in routes/mcp.ts): the place
 * the text names, geocoded into `parsed.location` and `parsed.maxDistanceKm`
 * (geocodingService.extractAndGeocode), unless `parsed` has a location
 * already. Returns the geocoder's answer, or null. A geocoder failure never
 * breaks the search: it is then nationwide, as in lokal_search.
 */
export async function geocodeSearchPlace(parsed: ParsedSearch, text: string): Promise<GeoResult | null> {
  if (parsed.location) return null;
  let place: GeoResult | null = null;
  try {
    place = await geocodingService.extractAndGeocode(text);
  } catch {
    place = null;
  }
  if (place) {
    parsed.location = { lat: place.lat, lng: place.lng };
    parsed.maxDistanceKm = place.radiusKm;
  }
  return place;
}

/**
 * The words of parseNaturalQuery's reading that discover() reads and
 * DiscoveryQuerySchema does not know, so its parse drops them: product terms
 * (step 6b), the name query (step 0) and the unknown words (step 3c, slice I-W).
 */
export const PARSED_SEARCH_TERMS = ["_productTerms", "_nameQuery", "_unknownTerms"] as const;
export type ParsedSearchTerm = (typeof PARSED_SEARCH_TERMS)[number];

/**
 * DiscoveryQuerySchema.parse({...parsed, ...fields}), with the words `terms`
 * of `parsed` put back, so discover() reads the search as it reads
 * lokal_search's (which hands it the parsed query unparsed). A word the parser
 * did not set stays unset.
 */
export function discoveryQueryOf(
  parsed: ParsedSearch,
  fields: Partial<DiscoveryQuery>,
  terms: readonly ParsedSearchTerm[] = PARSED_SEARCH_TERMS,
): DiscoveryQuery {
  const query = DiscoveryQuerySchema.parse({ ...parsed, ...fields });
  for (const term of terms) {
    const value = (parsed as Record<string, unknown>)[term];
    if (value) (query as Record<string, unknown>)[term] = value;
  }
  return query;
}

type Lang = "no" | "en";

const OUTSIDE_NORWAY: Readonly<Record<Lang, (place: string) => string>> = {
  no: (place) => `Rett fra Bonden dekker bare småskala matprodusenter i Norge, og «${place}» ligger utenfor. Ingen produsenter foreslås.`,
  en: (place) => `Rett fra Bonden only covers small-scale food producers in Norway; "${place}" is outside that, so no producers are suggested.`,
};

/**
 * The answer to a search that names a place outside Norway: in `lang`, or in
 * both, Norwegian first, which is lokal_search's text word for word.
 */
export function outsideNorwayText(place: string, lang?: Lang): string {
  return lang ? OUTSIDE_NORWAY[lang](place) : `${OUTSIDE_NORWAY.no(place)} / ${OUTSIDE_NORWAY.en(place)}`;
}

const NO_PRODUCT_MATCH: Readonly<Record<Lang, (words: string) => string>> = {
  no: (words) => `Ingen produsent har ${words} i produktlista eller i navnet, så søket gir ingen treff. ` +
    "Prøv et annet ord, en kategori (for eksempel «bakervarer» eller «honning») eller et produsentnavn.",
  en: (words) => `No producer lists ${words} as a product or has it in its name, so there are no matches. ` +
    "Try another word, a category (for example «bakery» or «honey») or a producer name.",
};

/**
 * The answer to a search whose words the parser could not read match no
 * product name (DiscoverMeta.unmatchedTerms), naming the words: in `lang`, or
 * in both, which is lokal_search's text for such a search without a place.
 */
export function noProductMatchText(terms: readonly string[], lang?: Lang): string {
  const words = `«${terms.join(" ")}»`;
  return lang ? NO_PRODUCT_MATCH[lang](words) : `🔎 ${NO_PRODUCT_MATCH.no(words)} / ${NO_PRODUCT_MATCH.en(words)}`;
}
