/**
 * experiences-query-intent.ts — turning an Opplevagent request in plain words
 * into a discover filter, shared by every transport.
 *
 * dev-request 2026-10-16-opplevagent-mcp-fritekst-query:
 *   S1 moved the existing helpers here unchanged — the A2A intent parser
 *      (parseExperiencesIntent and its FYLKER / matchesAsWordPrefix /
 *      detectKommune / detectRegion, from routes/experiences-a2a.ts) and the
 *      category aliases (normalizeExperienceCategory, from
 *      routes/experiences-mcp.ts). Both route files import and re-export the
 *      same names, so existing callers and tests see the same functions.
 *   S2 added interpretDiscoverQuery(): discover_experiences' free-text
 *      `query` read as place, category, season, weather and search words.
 *
 * Platform-neutral: imports only norway-fylke (the local gazetteer) and
 * experience-store (the catalogue), never a route, so MCP, REST and A2A can
 * all use it without an import cycle. No outside service is called.
 */

import type { DiscoverFilter } from "./experience-store";
import {
  __FYLKE_INTERNAL,
  NON_KOMMUNE_REGION_LABELS,
  REGION_TO_KOMMUNER,
  cityToFylke,
  key as foldPlaceName,
  normaliseFylke,
} from "./norway-fylke";

// experience-store is required at call time, not imported at the top (same
// pattern as honest-count.ts): test blocks swap a fresh experience-store /
// db-factory copy into require.cache, and a top-level import would keep
// calling whichever copy was cached when this module was first loaded.
function experienceStore(): typeof import("./experience-store") {
  return require("./experience-store") as typeof import("./experience-store");
}

// ─── Intent parser ───────────────────────────────────────────
// Extracts discovery parameters from a Norwegian/English natural-language
// query. Keeps it simple: keyword matching on known fylker + signals.

const FYLKER = [
  "oslo", "akershus", "østfold", "buskerud", "innlandet", "vestfold",
  "telemark", "agder", "rogaland", "vestland", "møre og romsdal",
  "trøndelag", "nordland", "troms", "finnmark", "svalbard",
];

// The indoor/outdoor keywords are short Norwegian substrings ("inne", "ute")
// that collide with unrelated words — e.g. "finne" (to find) contains "inne",
// which previously forced indoor_outdoor="indoor" on any query using the verb
// "finne" (dev-request 2026-07-04-opplevagent-nl-parser-og-fylkesnormalisering:
// "hva kan vi finne på i Tromsø om vinteren?" wrongly excluded outdoor results).
// JS's \b doesn't treat æøå as word characters, so a plain regex \b boundary
// can't be used here. This checks the actual preceding character is not a
// Unicode letter/digit, while leaving the keyword's own end open so inflected
// continuations ("inne" + "ndørs" → "innendørs") still match.
export function matchesAsWordPrefix(haystack: string, keyword: string): boolean {
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(keyword, from);
    if (idx === -1) return false;
    const precedingChar = idx > 0 ? haystack[idx - 1] : "";
    if (!/[\p{L}\p{N}]/u.test(precedingChar)) return true;
    from = idx + 1;
  }
}

// Known kommune (city/municipality) display names, reused from
// norway-fylke.ts rather than hand-rolling a second list. Checked BEFORE
// the FYLKER substring loop below: a kommune name is the more specific
// signal, and several kommune names substring-match into FYLKER (e.g.
// "Tromsø" contains "troms"), which previously produced a wrong/
// over-broad fylke instead of the intended kommune (the flagship demo
// query "hva kan vi finne på i Tromsø om vinteren?" — dev-request
// 2026-07-04-opplevagent-nl-parser-og-fylkesnormalisering item 1).
// Excludes traditional region/valley/district labels (Romsdal, Sunnmøre, …)
// that appear in CITY_TO_FYLKE_RAW for fylke-resolution purposes but are
// NOT themselves a literal DB `kommune` value — see NON_KOMMUNE_REGION_LABELS
// in norway-fylke.ts for why (caught in PR #146 review: "Møre og Romsdal"
// queries were regressing to a nonexistent `kommune: "Romsdal"` match).
const KOMMUNE_NAMES: string[] = Object.keys(__FYLKE_INTERNAL.CITY_TO_FYLKE_RAW)
  .filter(name => !NON_KOMMUNE_REGION_LABELS.has(name));

// Detect a kommune name in `lower` (already-lowercased text) using the same
// word-boundary-aware matching as the indoor/outdoor keywords. When several
// kommune names match (e.g. short kommune "Os" is a substring-prefix of
// "Oslo"), the LONGEST match wins — this resolves the common
// short-name-inside-longer-name case without needing a full tokeniser.
// NOTE: this does not fully solve general false positives from very short
// kommune names that happen to be substring-prefixes of unrelated Norwegian
// words with no longer kommune name present (e.g. "Os" inside "oster"/
// "ost", or "Time" ["hour"] inside an unrelated "en time i ..." phrase) —
// left out of scope per the dev-request (word-boundary matching already
// eliminates the worse substring-inside-a-word bug class; full NLP
// disambiguation of short ambiguous place names is a separate concern).
function detectKommune(lower: string): string | null {
  let best: string | null = null;
  for (const display of KOMMUNE_NAMES) {
    if (matchesAsWordPrefix(lower, display.toLowerCase())) {
      if (!best || display.length > best.length) best = display;
    }
  }
  return best;
}

// Curated tourist-region names (dev-request 2026-09-21-opplevagent-
// discovery-regionnavn-utenfor-kommune-fylke) — see REGION_TO_KOMMUNER in
// norway-fylke.ts for the region -> kommune-list mapping itself, and that
// export's own doc comment for why this is a SEPARATE list from
// KOMMUNE_NAMES rather than more fake 1:1 kommune synonyms. Checked with the
// exact same word-boundary-aware technique as detectKommune() above (longest
// match wins on the rare chance two region names both match).
const REGION_NAMES: string[] = Object.keys(REGION_TO_KOMMUNER);

function detectRegion(lower: string): string | null {
  let best: string | null = null;
  for (const display of REGION_NAMES) {
    if (matchesAsWordPrefix(lower, display.toLowerCase())) {
      if (!best || display.length > best.length) best = display;
    }
  }
  return best;
}

export function parseExperiencesIntent(text: string): DiscoverFilter {
  const lower = text.toLowerCase();
  const params: DiscoverFilter = {};

  // Kommune detection takes priority over fylke AND over a curated region
  // match (see detectKommune above) — a caller who named an exact kommune
  // shouldn't have it shadowed by a broader region/fylke constraint. Only
  // when no kommune matched do we check for a curated multi-kommune region
  // name (e.g. "Lofoten" -> its constituent kommuner, dev-request 2026-09-
  // 21-opplevagent-discovery-regionnavn-utenfor-kommune-fylke); only when
  // NEITHER a kommune NOR a region matched do we fall back to fylke
  // detection, exactly as before this region-detection feature existed —
  // so an existing kommune/fylke-only query (e.g. "Tromsø", "Finnmark")
  // produces a byte-identical filter to before.
  const kommune = detectKommune(lower);
  if (kommune) {
    params.kommune = kommune;
  } else {
    const region = detectRegion(lower);
    if (region) {
      params.kommuner = [...REGION_TO_KOMMUNER[region]];
    } else {
      // Fylke detection — only when no kommune or curated region matched.
      for (const f of FYLKER) {
        if (lower.includes(f)) {
          params.fylke = f.charAt(0).toUpperCase() + f.slice(1);
          break;
        }
      }
    }
  }

  // Weather detection
  if (lower.includes("regn") || lower.includes("rain")) {
    params.weather = "rain";
  } else if (lower.includes("snø") || lower.includes("snow")) {
    params.weather = "snow";
  } else if (lower.includes("sol") || lower.includes("clear") || lower.includes("fint vær")) {
    params.weather = "clear";
  }

  // Indoor / outdoor detection (word-prefix-aware — see matchesAsWordPrefix)
  if (matchesAsWordPrefix(lower, "inne") || matchesAsWordPrefix(lower, "indoor")) {
    params.indoor_outdoor = "indoor";
  } else if (matchesAsWordPrefix(lower, "ute") || matchesAsWordPrefix(lower, "outdoor") || matchesAsWordPrefix(lower, "friluft")) {
    params.indoor_outdoor = "outdoor";
  }

  // Season detection
  if (lower.includes("vinter") || lower.includes("winter")) {
    params.season = "winter";
  } else if (lower.includes("sommer") || lower.includes("summer")) {
    params.season = "summer";
  } else if (lower.includes("vår") || lower.includes("spring")) {
    params.season = "spring";
  } else if (lower.includes("høst") || lower.includes("autumn") || lower.includes("fall")) {
    params.season = "autumn";
  }

  return params;
}

/** list_experience_categories' synthetic entry for the discover_gardssalg vertical. */
export const GARDSSALG_CATEGORY = "gardssalg_smaking";

// ChatGPT app review 2026-09-24: this tool's own description used to offer
// 'vinter' as a category example — not a slug that exists (the real one is
// 'vinter_sno'), so a model copying it got the category silently relaxed
// away. The description now lists the real slugs; this maps the obvious
// plain-word guesses (Norwegian or English) onto them.
//
// Re-review 2026-10-03: a model also passes the human label it showed the
// user ("wildlife & safari", "Food and drink") or an invented slug
// ("wildlife_safari"). Those missed the table above, the filter was relaxed
// away and the list mixed every category — test case 4 promises wildlife
// only. Multi-word values are now split into words and the first word with
// an alias wins; anything still unrecognised is reported back by
// discover_experiences instead of being silently dropped.
const CATEGORY_ALIASES: Record<string, string> = {
  kultur: "kultur_historie", historie: "kultur_historie", culture: "kultur_historie", cultural: "kultur_historie", history: "kultur_historie", museum: "kultur_historie", museums: "kultur_historie",
  natur: "natur_friluft", friluft: "natur_friluft", friluftsliv: "natur_friluft", nature: "natur_friluft", outdoors: "natur_friluft", outdoor: "natur_friluft",
  adrenalin: "adrenalin_action", adrenaline: "adrenalin_action", action: "adrenalin_action", adventure: "adrenalin_action",
  sightseeing: "sightseeing_transport", transport: "sightseeing_transport",
  overnatting: "overnatting_opplevelse", accommodation: "overnatting_opplevelse", stay: "overnatting_opplevelse", stays: "overnatting_opplevelse",
  dyreliv: "dyreliv_safari", safari: "dyreliv_safari", safaris: "dyreliv_safari", wildlife: "dyreliv_safari", animals: "dyreliv_safari", animal: "dyreliv_safari", dyr: "dyreliv_safari",
  vinter: "vinter_sno", winter: "vinter_sno", "snø": "vinter_sno", sno: "vinter_sno", snow: "vinter_sno",
  mat: "mat_drikke", drikke: "mat_drikke", food: "mat_drikke", "food_drink": "mat_drikke",
  "velvære": "velvaere_spa", velvaere: "velvaere_spa", spa: "velvaere_spa", wellness: "velvaere_spa",
  // Not an experience category: list_experience_categories appends this
  // synthetic entry for the separate discover_gardssalg tool.
  gardssalg: GARDSSALG_CATEGORY, "gårdssalg": GARDSSALG_CATEGORY, "farm-sale": GARDSSALG_CATEGORY, "farm_sale": GARDSSALG_CATEGORY,
};

export function normalizeExperienceCategory(category: string): string {
  const key = category.trim().toLowerCase();
  if (CATEGORY_ALIASES[key]) return CATEGORY_ALIASES[key];
  if (listCategorySlugs().includes(key)) return key;
  for (const word of key.split(/[^a-z0-9æøå]+/)) {
    if (CATEGORY_ALIASES[word]) return CATEGORY_ALIASES[word];
  }
  return category.trim();
}

/** The experience category slugs that currently have published listings. */
export function listCategorySlugs(): string[] {
  try {
    return experienceStore().listCategories().map((c) => c.category);
  } catch {
    return [];
  }
}

// ─── Free-text `query` → discover filter (dev-request 2026-10-16-opplevagent-
// mcp-fritekst-query, S2) ────────────────────────────────────────────────────
// discover_experiences asks the client to pass the user's request in `query`,
// but the handler used to read it only for the outside-Norway and stockfish
// checks. A call with only {query:"hvalsafari i Tromsø"} then searched with an
// empty filter and answered with the first 20 rows of the whole country.
// interpretDiscoverQuery() reads the place, category, season, weather and the
// remaining search words out of the text, from local data only: the gazetteer
// in norway-fylke.ts and the kommuner that have published experiences.
//
// The word lists below are configuration. A new language or vertical adds
// entries here; the matching code does not change.

export type QuerySeason = "winter" | "summer" | "spring" | "autumn";
export type QueryWeather = "rain" | "snow" | "clear";

/** A word right before an ambiguous place name that marks it as a place ("i Moss", "in Moss"). */
export const PLACE_PREPOSITIONS: ReadonlySet<string> = new Set(["i", "in", "på", "ved", "near", "around", "rundt"]);

/**
 * Gazetteer names (CITY_TO_FYLKE_RAW) that are also everyday words. They are
 * read as a place only in their own spelling (never folded, so "as" is not Ås
 * and "bo" is not Bø) and only when written as a name:
 *   - "capital": with a capital first letter, not as the first word of a
 *     sentence (unless the whole query is that one word). For words whose
 *     lower-case form often follows a preposition: "in time", "i sola" (in
 *     the sun), "på stranda" (on the beach), "hvaler" (whales), "in olden
 *     days", "i otta" (at dawn), "en lakselv" (a salmon river);
 *   - "preposition_or_capital": as above, or right after a PLACE_PREPOSITIONS
 *     word ("i moss").
 */
export const AMBIGUOUS_PLACE_WORDS: Readonly<Record<string, "capital" | "preposition_or_capital">> = {
  Time: "capital", Sola: "capital", Stranda: "capital", Hvaler: "capital", Olden: "capital", Otta: "capital",
  Lakselv: "capital",
  Moss: "preposition_or_capital", Os: "preposition_or_capital", Hol: "preposition_or_capital",
  Gol: "preposition_or_capital", "Bø": "preposition_or_capital", "Hå": "preposition_or_capital",
  "Ås": "preposition_or_capital", Lier: "preposition_or_capital", Valle: "preposition_or_capital",
  Loen: "preposition_or_capital", Bryne: "preposition_or_capital", Klepp: "preposition_or_capital",
  Reine: "preposition_or_capital", Frosta: "preposition_or_capital",
};

/**
 * Season words, matched as whole words ("våre" is not "vår", "waterfall" is
 * not "fall"). A season word sets `season`, never the category vinter_sno:
 * "om vinteren" asks for what is on in winter, which includes northern-lights
 * cruises (see the `category` description of discover_experiences).
 */
export const SEASON_WORDS: Readonly<Record<string, QuerySeason>> = {
  vinter: "winter", vinteren: "winter", vinterferie: "winter", vinterferien: "winter", winter: "winter", wintertime: "winter",
  sommer: "summer", sommeren: "summer", sommerferie: "summer", sommerferien: "summer", summer: "summer", summertime: "summer",
  "våren": "spring", spring: "spring", springtime: "spring",
  "høst": "autumn", "høsten": "autumn", haust: "autumn", hausten: "autumn", "høstferie": "autumn", "høstferien": "autumn",
  autumn: "autumn", fall: "autumn",
};

/**
 * Season words that are also everyday words. They count only right after one
 * of the listed words and at the end of a clause: "hva skjer i Oslo i vår?"
 * (this spring), not "i vår familie" (in our family).
 */
export const CONTEXTUAL_SEASON_WORDS: Readonly<Record<string, { season: QuerySeason; after: readonly string[] }>> = {
  "vår": { season: "spring", after: ["i", "neste", "denne", "til"] },
};

/** Weather words, matched as whole words ("regnbue" is not "regn"). */
export const WEATHER_WORDS: Readonly<Record<string, QueryWeather>> = {
  regn: "rain", regner: "rain", "regnvær": "rain", "regnværsdag": "rain", regnfull: "rain", regnfullt: "rain",
  rain: "rain", rainy: "rain", raining: "rain",
  "snør": "snow", "snøvær": "snow", "snøfall": "snow", snowing: "snow", snowfall: "snow",
  sol: "clear", solskinn: "clear", sunny: "clear", sunshine: "clear",
};

/** Words for the whole country: no place filter ("Find wildlife experiences in Norway"). */
export const WHOLE_COUNTRY_WORDS: ReadonlySet<string> = new Set([
  "norway", "norge", "noreg", "norwegian", "norsk", "norske", "norwegen",
]);

/**
 * CATEGORY_ALIASES words too general in a sentence to set the category from
 * free text ("during our stay", "an Arctic adventure"). Like every alias word
 * they are used up and never become a search word.
 */
export const GENERIC_CATEGORY_ALIAS_WORDS: ReadonlySet<string> = new Set([
  "stay", "stays", "adventure", "action", "transport", "outdoor", "outdoors",
]);

/**
 * Words that carry no search meaning on their own: question words, pronouns,
 * prepositions, request verbs, "experiences"/"activities", praise words and
 * who is travelling (a keyword filter on "family" would only keep the rows
 * whose text happens to say so). Norwegian and English.
 */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  // Norwegian
  "hva", "hvor", "hvordan", "hvilke", "hvilken", "hvilket", "når", "hvorfor", "kva", "kor", "korleis",
  "kan", "kunne", "skal", "vil", "ville", "må", "bør", "får", "jeg", "eg", "meg", "du", "deg", "vi", "oss",
  "dere", "de", "dem", "man", "min", "mitt", "mine", "din", "ditt", "dine", "vår", "vårt", "våre", "deres",
  "sin", "sitt", "sine", "en", "ei", "et", "ein", "eit", "den", "det", "denne", "dette", "disse", "noe",
  "noen", "noko", "nokon", "alle", "alt", "all", "mange", "mye", "flere", "litt", "annet", "andre", "slik",
  "og", "eller", "men", "som", "at", "så", "om", "hvis", "enn", "også", "bare", "helst", "gjerne", "veldig",
  "mest", "mer", "i", "på", "til", "fra", "frå", "for", "med", "av", "ved", "nær", "rundt", "hos", "mellom",
  "etter", "før", "uten", "innen", "langs", "mot", "er", "var", "blir", "bli", "være", "vere", "ha", "har",
  "hadde", "gjøre", "gjør", "finne", "finn", "finnes", "fins", "se", "vise", "vis", "søk", "søke",
  "anbefal", "anbefale", "anbefaler", "anbefaling", "anbefalinger", "forslag", "tips", "gi", "vite", "lyst",
  "ønsker", "oppleve", "besøke", "besøk", "dra", "reise", "komme", "opplevelse", "opplevelsen",
  "opplevelser", "opplevelsene", "aktivitet", "aktiviteten", "aktiviteter", "aktivitetene", "ting",
  "sted", "steder", "stedet", "område", "området", "severdighet", "severdigheter", "attraksjon",
  "attraksjoner", "tur", "turer", "turen", "god", "gode", "godt", "beste", "best", "bra", "fin", "fine",
  "fint", "flott", "flotte", "gøy", "morsom", "morsomme", "morsomt", "artig", "spennende", "populær",
  "populære", "kjent", "kjente", "lokal", "lokale", "unik", "unike", "topp", "her", "der", "nå", "neste",
  "dag", "dagen", "dager", "helg", "helgen", "uke", "uka", "ferie", "ferien", "tid", "vær", "været",
  "skjer", "skje", "kommer", "bor", "besøker", "reiser",
  "familie", "familien", "barn", "barna", "venner", "par", "hei", "takk",
  // English
  "what", "where", "which", "how", "when", "why", "who", "can", "could", "would", "should", "will", "may",
  "might", "must", "do", "does", "did", "me", "my", "we", "us", "our", "you", "your", "they", "them",
  "their", "it", "its", "a", "an", "the", "this", "that", "these", "those", "some", "any", "many", "much",
  "more", "most", "other", "such", "and", "or", "but", "if", "than", "then", "also", "just", "only",
  "very", "really", "please", "so", "too", "of", "in", "on", "at", "to", "from", "with", "near", "around",
  "about", "by", "into", "within", "nearby", "during", "while", "up", "out", "is", "are", "was", "were",
  "be", "been", "am", "have", "has", "get", "go", "going", "visit", "visiting", "see", "try", "want",
  "like", "love", "need", "looking", "look", "find", "show", "give", "list", "recommend",
  "recommendation", "recommendations", "suggest", "suggestions", "search", "tell", "know", "plan",
  "planning", "book", "things", "thing", "stuff", "something", "activities", "activity", "experiences",
  "experience", "ideas", "idea", "options", "places", "place", "spots", "attractions", "attraction",
  "sights", "tours", "tour", "trips", "trip", "excursions", "excursion", "day", "days", "weekend", "week",
  "today", "tomorrow", "next", "time", "good", "great", "nice", "fun", "cool", "top", "awesome",
  "amazing", "interesting", "unique", "popular", "famous", "local", "beautiful", "worth", "here", "there",
  "now", "details", "detail", "info", "information", "family", "families", "kids", "children", "couple",
  "friends", "people", "hi", "hello", "thanks", "happening", "happens", "arrive", "arriving", "travel",
  "travelling", "traveling", "fly", "flying", "staying", "spend", "spending",
]);

/** At most this many search words reach the filter (every one must match: AND). */
export const MAX_TEXT_TERMS = 6;

/** The structured arguments a caller passed next to `query`. They always win. */
export interface DiscoverQueryExplicitArgs {
  fylke?: string;
  kommune?: string;
  lat?: number;
  lng?: number;
  category?: string;
  season?: string;
  weather?: string;
}

/** What interpretDiscoverQuery() read from the text — only keys the explicit arguments left empty. */
export interface DiscoverQueryInterpretation {
  kommune?: string;
  kommuner?: string[];
  fylke?: string;
  category?: string;
  season?: QuerySeason;
  weather?: QueryWeather;
  /** Search words for DiscoverFilter.text_terms, lower case, query order. */
  terms?: string[];
  /** The query has at least one word that is not a stopword or the country itself. */
  hasContent: boolean;
}

interface QueryToken {
  raw: string;
  lower: string;
  fold: string;
  start: number;
  end: number;
}

function tokenizeQuery(text: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = m.index ?? 0;
    tokens.push({ raw: m[0], lower: m[0].toLocaleLowerCase("nb-NO"), fold: foldPlaceName(m[0]), start, end: start + m[0].length });
  }
  return tokens;
}

type PlaceKind = "kommune" | "region" | "district" | "fylke";

interface PlaceCandidate {
  name: string;
  kind: PlaceKind;
  /** 0 kommune, 1 region/district, 2 fylke — the same priority as parseExperiencesIntent(). */
  tier: number;
  words: string[];
  ambiguous?: "capital" | "preposition_or_capital";
}

function placeCandidate(name: string, kind: PlaceKind, tier: number): PlaceCandidate {
  return { name, kind, tier, words: tokenizeQuery(name).map((t) => t.fold), ambiguous: AMBIGUOUS_PLACE_WORDS[name] };
}

// Districts in CITY_TO_FYLKE_RAW that are no kommune and no curated region
// (Hallingdal, Jæren, Vesterålen, …): their fylke is known, so a query naming
// one is searched in that fylke with the district's name as a search word.
const PLACE_CANDIDATES: readonly PlaceCandidate[] = [
  ...KOMMUNE_NAMES.map((name) => placeCandidate(name, "kommune", 0)),
  ...REGION_NAMES.map((name) => placeCandidate(name, "region", 1)),
  ...[...NON_KOMMUNE_REGION_LABELS]
    .filter((name) => !(name in REGION_TO_KOMMUNER) && cityToFylke(name))
    .map((name) => placeCandidate(name, "district", 1)),
  ...FYLKER.map((name) => placeCandidate(name, "fylke", 2)),
];

function startsSentence(tokens: readonly QueryToken[], i: number, text: string): boolean {
  return i === 0 || /[.!?]/.test(text.slice(tokens[i - 1].end, tokens[i].start));
}

function endsClause(tokens: readonly QueryToken[], i: number, text: string): boolean {
  return i === tokens.length - 1 || /[.!?,;:]/.test(text.slice(tokens[i].end, tokens[i + 1].start));
}

function placeMatchesAt(c: PlaceCandidate, tokens: readonly QueryToken[], i: number, text: string): boolean {
  if (i + c.words.length > tokens.length) return false;
  if (c.ambiguous) {
    const t = tokens[i];
    if (t.lower !== c.name.toLocaleLowerCase("nb-NO")) return false;
    const capital = t.raw[0] !== t.raw[0].toLocaleLowerCase("nb-NO");
    if (capital && (!startsSentence(tokens, i, text) || tokens.length === 1)) return true;
    return c.ambiguous === "preposition_or_capital" && i > 0 && PLACE_PREPOSITIONS.has(tokens[i - 1].lower);
  }
  return c.words.every((w, k) => {
    const f = tokens[i + k].fold;
    // The last word may carry a genitive -s: "Tromsøs beste", "Lofotens".
    return f === w || (k === c.words.length - 1 && f === w + "s");
  });
}

/** Whether the kommune `name` has a published experience (folded comparison); true when unknown. */
function isPublishedKommune(name: string, published: ReadonlySet<string> | null): boolean {
  if (!published) return true;
  const want = foldPlaceName(name);
  for (const k of published) if (foldPlaceName(k) === want) return true;
  return false;
}

function safePublishedKommuneSet(): ReadonlySet<string> | null {
  try {
    return experienceStore().publishedKommuneSet();
  } catch {
    return null;
  }
}

/**
 * Read discover_experiences' free-text `query` into filter values.
 *
 * - Explicit arguments always win: a value is read only for a key they left
 *   empty, and the place only when no fylke, kommune or lat/lng was given
 *   (the handler's placeGiven rule). Words naming an already-given value are
 *   used up and never become search words.
 * - Place: kommune, then a curated region (REGION_TO_KOMMUNER) or district,
 *   then fylke; longest name first within a level. Whole words only, with
 *   æ/ø/å folded ("Tromso" is Tromsø), except AMBIGUOUS_PLACE_WORDS. A
 *   kommune without published experiences (a bygd such as Geiranger, or a
 *   town the catalogue files under its kommune) becomes its fylke, and its
 *   name a search word.
 * - Season, weather and category from SEASON_WORDS, WEATHER_WORDS and
 *   CATEGORY_ALIASES. Season words never set the category vinter_sno.
 * - Search words: what is left after stopwords, at most MAX_TEXT_TERMS. Read
 *   only when the query is also the place source: a caller that passed the
 *   place has structured its request, and its leftover words ("flying in
 *   from London", "details of") are conversation, not a filter. So adding
 *   `query` to a structured call never narrows it by keyword.
 *
 * `opts.publishedKommuner` replaces the catalogue lookup (tests); null skips
 * the published-kommune check.
 */
export function interpretDiscoverQuery(
  queryText: string,
  explicit: DiscoverQueryExplicitArgs = {},
  opts: { publishedKommuner?: ReadonlySet<string> | null } = {},
): DiscoverQueryInterpretation {
  const tokens = tokenizeQuery(queryText);
  const used = tokens.map(() => false);
  const out: DiscoverQueryInterpretation = { hasContent: false };
  // Search words by token position, so a place name kept as a search word
  // stays in query order.
  const termAt = new Map<number, string>();

  const placeGiven = Boolean(explicit.fylke || explicit.kommune) ||
    (typeof explicit.lat === "number" && typeof explicit.lng === "number");
  if (!placeGiven) {
    const matches: Array<{ c: PlaceCandidate; at: number }> = [];
    for (const c of PLACE_CANDIDATES) {
      for (let i = 0; i < tokens.length; i++) if (placeMatchesAt(c, tokens, i, queryText)) matches.push({ c, at: i });
    }
    let best: { c: PlaceCandidate; at: number } | undefined;
    for (const m of matches) {
      // Every place word is used up, also a second, unused place name.
      for (let k = 0; k < m.c.words.length; k++) used[m.at + k] = true;
      if (!best || m.c.tier < best.c.tier || (m.c.tier === best.c.tier && m.c.name.length > best.c.name.length)) best = m;
    }
    if (best) {
      out.hasContent = true;
      const { c } = best;
      const published = c.kind === "kommune"
        ? (opts.publishedKommuner !== undefined ? opts.publishedKommuner : safePublishedKommuneSet())
        : null;
      if (c.kind === "region") {
        out.kommuner = [...REGION_TO_KOMMUNER[c.name]];
      } else if (c.kind === "fylke") {
        out.fylke = normaliseFylke(c.name) ?? c.name.charAt(0).toUpperCase() + c.name.slice(1);
      } else if (c.kind === "kommune" && isPublishedKommune(c.name, published)) {
        out.kommune = c.name;
      } else {
        // A district, or a kommune with nothing published under that name.
        const fylke = cityToFylke(c.name);
        if (fylke) out.fylke = fylke;
        termAt.set(best.at, c.name.toLocaleLowerCase("nb-NO"));
      }
    }
  }

  tokens.forEach((t, i) => {
    if (used[i]) return;
    const contextual = CONTEXTUAL_SEASON_WORDS[t.lower];
    const season = SEASON_WORDS[t.lower] ??
      (contextual && i > 0 && contextual.after.includes(tokens[i - 1].lower) && endsClause(tokens, i, queryText) ? contextual.season : undefined);
    if (season) {
      used[i] = true;
      out.hasContent = true;
      if (!explicit.season && !out.season) out.season = season;
      return;
    }
    const weather = WEATHER_WORDS[t.lower];
    if (weather) {
      used[i] = true;
      out.hasContent = true;
      if (!explicit.weather && !out.weather) out.weather = weather;
      return;
    }
    const category = CATEGORY_ALIASES[t.lower];
    if (category) {
      used[i] = true;
      out.hasContent = true;
      if (!explicit.category && !out.category && category !== GARDSSALG_CATEGORY && !GENERIC_CATEGORY_ALIAS_WORDS.has(t.lower)) {
        out.category = category;
      }
      return;
    }
    if (WHOLE_COUNTRY_WORDS.has(t.lower) || QUERY_STOPWORDS.has(t.lower)) return;
    // Single letters and bare numbers ("for 4 people") are no search words.
    if (t.lower.length < 2 || /^\p{N}+$/u.test(t.lower)) return;
    out.hasContent = true;
    termAt.set(i, t.lower);
  });

  if (!placeGiven && termAt.size > 0) {
    const terms = [...new Set([...termAt.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w))];
    out.terms = terms.slice(0, MAX_TEXT_TERMS);
  }
  return out;
}
