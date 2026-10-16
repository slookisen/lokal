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
 *   S4/S5 moved isStockfishPurchase() here from routes/experiences-mcp.ts,
 *      so REST /discover?q= and the A2A search words refuse the same
 *      food-purchase request as discover_experiences.
 *
 * Platform-neutral: imports only norway-fylke (the local gazetteer) and
 * experience-store (the catalogue), never a route, so MCP, REST and A2A can
 * all use it without an import cycle. No outside service is called.
 */

import { MAX_TEXT_TERMS, MAX_TEXT_TERM_LENGTH, type DiscoverFilter } from "./experience-store";
import {
  __FYLKE_INTERNAL,
  NON_KOMMUNE_REGION_LABELS,
  REGION_TO_KOMMUNER,
  cityToFylke,
  key as foldPlaceName,
  normaliseFylke,
} from "./norway-fylke";

// experience-store's functions are required at call time, not imported at the
// top (same pattern as honest-count.ts): test blocks swap a fresh
// experience-store / db-factory copy into require.cache, and a top-level
// import would keep calling whichever copy was cached when this module was
// first loaded. Its constants (MAX_TEXT_TERMS …) are the same in every copy.
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
export type QueryIndoorOutdoor = "indoor" | "outdoor";

/** A word right before an ambiguous place name that marks it as a place ("i Moss", "in Moss"). */
export const PLACE_PREPOSITIONS: ReadonlySet<string> = new Set(["i", "in", "på", "ved", "nær", "near", "around", "rundt"]);

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
 * A longer gazetteer name that starts with one of these words needs that
 * word in its own spelling too: "bo i Telemark" (stay in Telemark) is the
 * fylke Telemark, not the kommune Bø i Telemark.
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
 * Former county names, read as a fylke by interpretDiscoverQuery() only
 * (parseExperiencesIntent() keeps its FYLKER list, so A2A is unchanged).
 * normaliseFylke() turns each into the name the discover filter searches: a
 * 2020-2023 merged fylke stays itself and covers its parts through
 * fylkeEquivalents() ("Troms og Finnmark" is Troms and Finnmark), an older one
 * becomes its successor ("Hordaland" is Vestland).
 */
export const FORMER_FYLKE_NAMES: readonly string[] = [
  "Troms og Finnmark", "Vestfold og Telemark", "Viken",
  "Hordaland", "Sogn og Fjordane", "Hedmark", "Oppland", "Aust-Agder", "Vest-Agder", "Sør-Trøndelag", "Nord-Trøndelag",
];

/**
 * Landsdeler (parts of the country) and their fylker. interpretDiscoverQuery()
 * reads one as a place covering all of them (DiscoverFilter.fylker). Without
 * it "Nord-Norge vinter" kept "nord" as a search word, relaxed it away and
 * answered with winter rows from Bergen, Oslo and Ålesund. Names whose extent
 * people disagree on ("Sør-Norge", "Southern Norway": Agder, or everything
 * south of Trøndelag?) are left out: a missing name costs a search word, a
 * wrong one gives a wrong place.
 */
export const LANDSDEL_TO_FYLKER: Readonly<Record<string, readonly string[]>> = {
  "Nord-Norge": ["Nordland", "Troms", "Finnmark"],
  "Midt-Norge": ["Trøndelag", "Møre og Romsdal"],
  "Vestlandet": ["Rogaland", "Vestland", "Møre og Romsdal"],
  "Sørlandet": ["Agder"],
  "Østlandet": ["Oslo", "Akershus", "Østfold", "Buskerud", "Innlandet", "Vestfold", "Telemark"],
};

/** Other names for the LANDSDEL_TO_FYLKER entries: one-word, nynorsk and English. */
export const LANDSDEL_ALIASES: Readonly<Record<string, string>> = {
  Nordnorge: "Nord-Norge", "Nord-Noreg": "Nord-Norge", "Northern Norway": "Nord-Norge", "North Norway": "Nord-Norge",
  Midtnorge: "Midt-Norge", "Midt-Noreg": "Midt-Norge", "Central Norway": "Midt-Norge", "Mid-Norway": "Midt-Norge",
  "Western Norway": "Vestlandet", "West Norway": "Vestlandet", "Fjord Norway": "Vestlandet",
  Austlandet: "Østlandet", "Eastern Norway": "Østlandet", "East Norway": "Østlandet",
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

/**
 * Weather words, matched as whole words ("regnbue" is not "regn"). The place
 * names among them count as weather only where they are no place: "i sola"
 * (in the sun) is weather, "i Sola" the kommune (AMBIGUOUS_PLACE_WORDS).
 */
export const WEATHER_WORDS: Readonly<Record<string, QueryWeather>> = {
  regn: "rain", regner: "rain", "regnvær": "rain", "regnværsdag": "rain", regnfull: "rain", regnfullt: "rain",
  rain: "rain", rainy: "rain", raining: "rain",
  "snør": "snow", "snøvær": "snow", "snøfall": "snow", snowing: "snow", snowfall: "snow",
  sol: "clear", sola: "clear", solen: "clear", solskinn: "clear", sunny: "clear", sunshine: "clear",
};

/**
 * Indoor/outdoor words, matched as whole words ("outdoor activities in Oslo").
 * «inne» and «ute» are left out: as everyday words ("inne i byen", "spise
 * ute") they say nothing about the activity.
 */
export const INDOOR_OUTDOOR_WORDS: Readonly<Record<string, QueryIndoorOutdoor>> = {
  indoor: "indoor", indoors: "indoor", "innendørs": "indoor", innendors: "indoor",
  outdoor: "outdoor", outdoors: "outdoor", "utendørs": "outdoor", utendors: "outdoor",
};

/** Words for the whole country: no place filter ("Find wildlife experiences in Norway"). */
export const WHOLE_COUNTRY_WORDS: ReadonlySet<string> = new Set([
  "norway", "norge", "noreg", "norwegian", "norsk", "norske", "norwegen",
]);

/**
 * CATEGORY_ALIASES words too general in a sentence to set the category from
 * free text ("during our stay", "an Arctic adventure"). Like every alias word
 * they are used up and never become a search word, and they do not count as
 * content: a query of only such words ("adventure") browses like a general
 * question.
 */
export const GENERIC_CATEGORY_ALIAS_WORDS: ReadonlySet<string> = new Set([
  "stay", "stays", "adventure", "action", "transport",
]);

/**
 * Words that carry no search meaning on their own: question words, pronouns,
 * prepositions, request verbs, "experiences"/"activities", praise words, time
 * words, number words and who is travelling (a keyword filter on "family"
 * would only keep the rows whose text happens to say so). Norwegian and
 * English. A word missing here costs little: discoverExperiencesRelaxed()
 * relaxes the search words one at a time.
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
  "kveld", "kvelden", "skjer", "skje", "kommer", "bo", "bor", "besøker", "reiser", "hele", "landet",
  "kommune", "kommunen", "fylke", "fylket",
  "familie", "familien", "barn", "barna", "venner", "par", "voksen", "voksne", "person", "personer",
  "gjester", "fem", "seks", "sju", "syv", "åtte", "ni", "ti", "hei", "takk",
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
  "today", "tonight", "tomorrow", "next", "time", "good", "great", "nice", "fun", "cool", "top", "awesome",
  "amazing", "interesting", "unique", "popular", "famous", "local", "beautiful", "worth", "here", "there",
  "now", "details", "detail", "info", "information", "family", "families", "kids", "children", "couple",
  "friends", "people", "persons", "adult", "adults", "guests", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "hi", "hello", "thanks", "happening", "happens", "arrive", "arriving",
  "travel", "travelling", "traveling", "fly", "flying", "staying", "spend", "spending", "across",
  "throughout", "anywhere", "everywhere", "whole", "entire", "country", "county", "municipality",
  // What is left of a contraction once the apostrophe splits it ("don't" → "don", "we'll" → "ll").
  "don", "doesn", "didn", "isn", "aren", "wasn", "weren", "won", "wouldn", "couldn", "shouldn", "haven",
  "hasn", "ll", "ve", "re", "let", "lets",
]);

// The limits live with DiscoverFilterSchema (experience-store.ts), which
// enforces them; re-exported here with the rest of the configuration.
export { MAX_TEXT_TERMS, MAX_TEXT_TERM_LENGTH };

/** The structured arguments a caller passed next to `query`. They always win. */
export interface DiscoverQueryExplicitArgs {
  fylke?: string;
  kommune?: string;
  lat?: number;
  lng?: number;
  category?: string;
  season?: string;
  weather?: string;
  indoor_outdoor?: string;
}

/** What interpretDiscoverQuery() read from the text — only keys the explicit arguments left empty. */
export interface DiscoverQueryInterpretation {
  kommune?: string;
  kommuner?: string[];
  fylke?: string;
  /** The fylker of a landsdel (LANDSDEL_TO_FYLKER). */
  fylker?: string[];
  /** May be GARDSSALG_CATEGORY: the query asks for gårdssalg, which has its own tool. */
  category?: string;
  season?: QuerySeason;
  weather?: QueryWeather;
  indoor_outdoor?: QueryIndoorOutdoor;
  /** Search words for DiscoverFilter.text_terms, lower case, query order. */
  terms?: string[];
  /** The query has a word that is no stopword, generic alias word or the country itself. */
  hasContent: boolean;
}

interface QueryToken {
  raw: string;
  lower: string;
  fold: string;
  start: number;
  end: number;
}

/** table[key] for the table's own entries only: a query word such as "constructor" is no entry. */
function lookup<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function tokenizeQuery(text: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = m.index ?? 0;
    tokens.push({ raw: m[0], lower: m[0].toLocaleLowerCase("nb-NO"), fold: foldPlaceName(m[0]), start, end: start + m[0].length });
  }
  return tokens;
}

type PlaceKind = "kommune" | "region" | "district" | "fylke" | "landsdel";

/**
 * Place levels, most specific first. Kommune before region/district before
 * fylke is parseExperiencesIntent()'s priority; a landsdel is wider than a
 * fylke. A kommune only the catalogue knows (publishedOnlyCandidates) comes
 * after every gazetteer level: its name may be an everyday word ("på øyer",
 * "strand"), so a place the gazetteer knows wins over it.
 */
const PLACE_TIER = { kommune: 0, region: 1, district: 1, fylke: 2, landsdel: 3, catalogueKommune: 4 } as const;

interface PlaceCandidate {
  name: string;
  kind: PlaceKind;
  /** PLACE_TIER: lower wins. */
  tier: number;
  /** The name's words, folded (æ/ø/å → ae/o/a). */
  words: string[];
  /** The name's words in their own spelling, lower case. */
  lowerWords: string[];
  /**
   * Own spelling only, and: "capital" / "preposition_or_capital" (see
   * AMBIGUOUS_PLACE_WORDS), or "catalogue" — see catalogueNameAt().
   */
  ambiguous?: "capital" | "preposition_or_capital" | "catalogue";
  /** The first word must be in its own spelling: an AMBIGUOUS_PLACE_WORDS entry starts the name ("Bø i Telemark"). */
  ownSpellingFirst: boolean;
  /** A kommune known from the catalogue (publishedKommuneSet) and not from the gazetteer. */
  publishedOnly: boolean;
}

function placeCandidate(name: string, kind: PlaceKind, tier: number, publishedOnly = false): PlaceCandidate {
  const tokens = tokenizeQuery(name);
  return {
    name,
    kind,
    tier,
    words: tokens.map((t) => t.fold),
    lowerWords: tokens.map((t) => t.lower),
    ambiguous: publishedOnly ? "catalogue" : lookup(AMBIGUOUS_PLACE_WORDS, name),
    ownSpellingFirst: tokens.length > 1 && lookup(AMBIGUOUS_PLACE_WORDS, tokens[0].raw) !== undefined,
    publishedOnly,
  };
}

// Districts in CITY_TO_FYLKE_RAW that are no kommune and no curated region
// (Hallingdal, Jæren, Vesterålen, …): their fylke is known, so a query naming
// one is searched in that fylke with the district's name as a search word.
const PLACE_CANDIDATES: readonly PlaceCandidate[] = [
  ...KOMMUNE_NAMES.map((name) => placeCandidate(name, "kommune", PLACE_TIER.kommune)),
  ...REGION_NAMES.map((name) => placeCandidate(name, "region", PLACE_TIER.region)),
  ...[...NON_KOMMUNE_REGION_LABELS]
    .filter((name) => !(name in REGION_TO_KOMMUNER) && cityToFylke(name))
    .map((name) => placeCandidate(name, "district", PLACE_TIER.district)),
  ...[...FYLKER, ...FORMER_FYLKE_NAMES].map((name) => placeCandidate(name, "fylke", PLACE_TIER.fylke)),
  ...[...Object.keys(LANDSDEL_TO_FYLKER), ...Object.keys(LANDSDEL_ALIASES)].map((name) => placeCandidate(name, "landsdel", PLACE_TIER.landsdel)),
];

// The gazetteer's names at any level, and its kommune, region and district
// names, folded: see publishedOnlyCandidates().
const GAZETTEER_NAME_KEYS: ReadonlySet<string> = new Set(PLACE_CANDIDATES.map((c) => c.words.join(" ")));
const GAZETTEER_SUBFYLKE_KEYS: ReadonlySet<string> = new Set(PLACE_CANDIDATES.filter((c) => c.tier < 2).map((c) => c.words.join(" ")));

/** Whether some run of consecutive `words` is a gazetteer kommune, region or district name. */
function containsSubfylkeName(words: readonly string[]): boolean {
  for (let from = 0; from < words.length; from++) {
    for (let to = from + 1; to <= words.length; to++) {
      if (GAZETTEER_SUBFYLKE_KEYS.has(words.slice(from, to).join(" "))) return true;
    }
  }
  return false;
}

/** A catalogue kommune value that reads as one name: letters only, one to three words. */
const CLEAN_KOMMUNE_VALUE = /^\p{L}{2,}(?:[ -]\p{L}+){0,2}$/u;
/** Words that make a catalogue value a description rather than a name ("Lyngen kommune"). */
const NOT_A_NAME_WORDS: ReadonlySet<string> = new Set(["kommune", "kommun", "herad", "municipality"]);

const publishedOnlyCache = new WeakMap<ReadonlySet<string>, readonly PlaceCandidate[]>();

/**
 * Kommuner the catalogue has but the gazetteer lacks (Lyngen, Sirdal, Vågan
 * …), from publishedKommuneSet(): the DB, no outside call. A catalogue value
 * can be an everyday word ("Fjord", "Strand", "Øyer" are islands, "Sel" is a
 * seal) or the start of a foreign name ("Gran Canaria"), so it is read only
 * as written in catalogueNameAt() and ranks after every gazetteer place
 * (PLACE_TIER). Left out: values the gazetteer already reads (Senja stays a
 * region), values with a gazetteer kommune, region or district name in them
 * (a stray "Tromsø sentrum" must not shadow Tromsø), stopwords and values
 * that are no clean name.
 */
function publishedOnlyCandidates(published: ReadonlySet<string> | null): readonly PlaceCandidate[] {
  if (!published) return [];
  let cached = publishedOnlyCache.get(published);
  if (!cached) {
    cached = [...published]
      .filter((value) => CLEAN_KOMMUNE_VALUE.test(value))
      .map((value) => placeCandidate(value, "kommune", PLACE_TIER.catalogueKommune, true))
      .filter((c) =>
        !GAZETTEER_NAME_KEYS.has(c.words.join(" ")) &&
        !containsSubfylkeName(c.words) &&
        !c.lowerWords.some((w) => NOT_A_NAME_WORDS.has(w)) &&
        !(c.lowerWords.length === 1 && QUERY_STOPWORDS.has(c.lowerWords[0])));
    publishedOnlyCache.set(published, cached);
  }
  return cached;
}

function startsSentence(tokens: readonly QueryToken[], i: number, text: string): boolean {
  return i === 0 || /[.!?]/.test(text.slice(tokens[i - 1].end, tokens[i].start));
}

function endsClause(tokens: readonly QueryToken[], i: number, text: string): boolean {
  return i === tokens.length - 1 || /[.!?,;:]/.test(text.slice(tokens[i].end, tokens[i + 1].start));
}

function afterPreposition(tokens: readonly QueryToken[], i: number): boolean {
  return i > 0 && PLACE_PREPOSITIONS.has(tokens[i - 1].lower);
}

function isCapitalised(token: QueryToken): boolean {
  return token.raw[0] !== token.raw[0].toLocaleLowerCase("nb-NO");
}

/**
 * Whether a catalogue-only kommune (publishedOnlyCandidates) at
 * tokens[i, i+n) is written as that place: the whole query ("Lyngen"), or
 * capitalised right after a place preposition ("i Lyngen") and not followed
 * by another capitalised word, which makes it part of a longer name
 * ("på Gran Canaria", "in Lyngen Alps"). "på øyer", "på strand" and
 * "in fjord landscapes" name no kommune.
 */
function catalogueNameAt(tokens: readonly QueryToken[], i: number, n: number, text: string): boolean {
  if (tokens.length === n) return true;
  if (!afterPreposition(tokens, i) || !isCapitalised(tokens[i])) return false;
  const next = tokens[i + n];
  return !(next && /^[\s-]+$/.test(text.slice(tokens[i + n - 1].end, next.start)) && isCapitalised(next));
}

function placeMatchesAt(c: PlaceCandidate, tokens: readonly QueryToken[], i: number, text: string): boolean {
  const n = c.words.length;
  if (i + n > tokens.length) return false;
  if (c.ambiguous) {
    if (!c.lowerWords.every((w, k) => tokens[i + k].lower === w)) return false;
    if (c.ambiguous === "catalogue") return catalogueNameAt(tokens, i, n, text);
    if (isCapitalised(tokens[i]) && (!startsSentence(tokens, i, text) || tokens.length === 1)) return true;
    return c.ambiguous === "preposition_or_capital" && afterPreposition(tokens, i);
  }
  if (c.ownSpellingFirst && tokens[i].lower !== c.lowerWords[0]) return false;
  return c.words.every((w, k) => {
    const f = tokens[i + k].fold;
    // The last word may carry a genitive -s: "Tromsøs beste", "Lofotens".
    return f === w || (k === n - 1 && f === w + "s");
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
 * - Place: whole words, with æ/ø/å folded ("Tromso" is Tromsø) except
 *   AMBIGUOUS_PLACE_WORDS. Gazetteer kommuner, curated regions
 *   (REGION_TO_KOMMUNER), districts, fylker, FORMER_FYLKE_NAMES, landsdeler
 *   (LANDSDEL_TO_FYLKER) and the kommuner only the catalogue has
 *   (publishedOnlyCandidates). A name inside a longer matched name is part
 *   of it ("Romsdal" in "Møre og Romsdal"). Then the most specific level
 *   (PLACE_TIER: kommune, region/district, fylke, landsdel, then a
 *   catalogue-only kommune); within a level the name right after a place
 *   preposition ("flying from Bergen, what to do in Oslo"), else the first
 *   one named. A gazetteer kommune without published experiences (a bygd
 *   such as Geiranger, or a town the catalogue files under its kommune)
 *   becomes its fylke, and its name a search word. A catalogue-only kommune
 *   that loses to another place stays an ordinary word.
 * - Season, weather, indoor/outdoor and category from SEASON_WORDS,
 *   WEATHER_WORDS, INDOOR_OUTDOOR_WORDS and CATEGORY_ALIASES. Season words
 *   never set the category vinter_sno.
 * - Search words: what is left after stopwords, at most MAX_TEXT_TERMS, each
 *   at most MAX_TEXT_TERM_LENGTH long. Read only when the caller passed
 *   neither a place nor a category: those name what the request is about, and
 *   the leftover words of a call that structured them ("wildlife experiences
 *   across Norway", "details of") are conversation, not a filter. So adding
 *   `query` to a call with a structured place or category never narrows it
 *   by keyword; it can still fill an empty key (a place, a season).
 *
 * `opts.publishedKommuner` replaces the catalogue lookup (tests); null skips
 * the catalogue: no published-kommune check and no catalogue-only kommuner.
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
    const published = opts.publishedKommuner !== undefined ? opts.publishedKommuner : safePublishedKommuneSet();
    const matches: Array<{ c: PlaceCandidate; at: number; len: number }> = [];
    for (const c of [...PLACE_CANDIDATES, ...publishedOnlyCandidates(published)]) {
      for (let i = 0; i < tokens.length; i++) {
        if (placeMatchesAt(c, tokens, i, queryText)) matches.push({ c, at: i, len: c.words.length });
      }
    }
    const best = matches
      .filter((m) => !matches.some((o) => o.len > m.len && o.at <= m.at && m.at + m.len <= o.at + o.len))
      .sort((a, b) =>
        a.c.tier - b.c.tier ||
        Number(afterPreposition(tokens, b.at)) - Number(afterPreposition(tokens, a.at)) ||
        a.at - b.at)[0];
    // Every gazetteer place word is used up, also one of a second, unused
    // place name. A catalogue-only kommune that lost stays an ordinary word:
    // it is the least certain place signal ("strand" in "på Strand i Bergen").
    for (const m of matches) {
      if (m.c.publishedOnly && m !== best) continue;
      for (let k = 0; k < m.len; k++) used[m.at + k] = true;
    }
    if (best) {
      out.hasContent = true;
      const { c } = best;
      if (c.kind === "region") {
        out.kommuner = [...REGION_TO_KOMMUNER[c.name]];
      } else if (c.kind === "landsdel") {
        out.fylker = [...LANDSDEL_TO_FYLKER[lookup(LANDSDEL_ALIASES, c.name) ?? c.name]];
      } else if (c.kind === "fylke") {
        out.fylke = normaliseFylke(c.name) ?? c.name.charAt(0).toUpperCase() + c.name.slice(1);
      } else if (c.kind === "kommune" && (c.publishedOnly || isPublishedKommune(c.name, published))) {
        out.kommune = c.name;
      } else {
        // A district, or a gazetteer kommune with nothing published under that name.
        const fylke = cityToFylke(c.name);
        if (fylke) out.fylke = fylke;
        termAt.set(best.at, c.name.toLocaleLowerCase("nb-NO"));
      }
    }
  }

  tokens.forEach((t, i) => {
    if (used[i]) return;
    const contextual = lookup(CONTEXTUAL_SEASON_WORDS, t.lower);
    const season = lookup(SEASON_WORDS, t.lower) ??
      (contextual && i > 0 && contextual.after.includes(tokens[i - 1].lower) && endsClause(tokens, i, queryText) ? contextual.season : undefined);
    if (season) {
      used[i] = true;
      out.hasContent = true;
      if (!explicit.season && !out.season) out.season = season;
      return;
    }
    const weather = lookup(WEATHER_WORDS, t.lower);
    if (weather) {
      used[i] = true;
      out.hasContent = true;
      if (!explicit.weather && !out.weather) out.weather = weather;
      return;
    }
    const indoorOutdoor = lookup(INDOOR_OUTDOOR_WORDS, t.lower);
    if (indoorOutdoor) {
      used[i] = true;
      out.hasContent = true;
      if (!explicit.indoor_outdoor && !out.indoor_outdoor) out.indoor_outdoor = indoorOutdoor;
      return;
    }
    const category = lookup(CATEGORY_ALIASES, t.lower);
    if (category) {
      used[i] = true;
      if (GENERIC_CATEGORY_ALIAS_WORDS.has(t.lower)) return;
      out.hasContent = true;
      if (!explicit.category && !out.category) out.category = category;
      return;
    }
    if (WHOLE_COUNTRY_WORDS.has(t.lower) || QUERY_STOPWORDS.has(t.lower)) return;
    // Single letters, bare numbers ("for 4 people") and over-long tokens are no search words.
    if (t.lower.length < 2 || t.lower.length > MAX_TEXT_TERM_LENGTH || /^\p{N}+$/u.test(t.lower)) return;
    out.hasContent = true;
    termAt.set(i, t.lower);
  });

  if (!placeGiven && !explicit.category && termAt.size > 0) {
    const terms = [...new Set([...termAt.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w))];
    out.terms = terms.slice(0, MAX_TEXT_TERMS);
  }
  return out;
}

// ─── Out of scope: buying food (moved from routes/experiences-mcp.ts) ──────
// Unchanged; experiences-mcp.ts imports it from here so discover_experiences,
// REST /discover?q= (S4) and the A2A search words (S5) run the same early
// return (dev-request 2026-10-16-opplevagent-mcp-fritekst-query, felles regel 3).

/** Refuse the observed retail request without excluding food experiences. */
export function isStockfishPurchase(query: string | undefined): boolean {
  if (!query) return false;
  const request = query.normalize("NFKC").toLowerCase().replace(/ø/g, "o");
  if (!/\b(?:stock[ -]?fish|torrfisk)\b/.test(request)) return false;
  // Buying the food itself takes precedence over incidental museum/tour words.
  if (/\b(?:buy|buying|purchase|purchasing|order|ordering|kjope|kjop|bestille)\s+(?:(?:some|fresh|dried|local|the|litt|fersk|lokal)\s+)*(?:stock[ -]?fish|torrfisk)\b(?!\s+(?:tickets?|tours?|tastings?|museums?|workshops?|experiences?|cooking\s+class(?:es)?))/i.test(request)) return true;
  // Only an actual experience object qualifies, not a museum/tour mentioned elsewhere.
  if (/\b(?:stock[ -]?fish|torrfisk)\s+(?:tickets?|tours?|tastings?|museums?|workshops?|experiences?|cooking\s+class(?:es)?)\b|\b(?:buy|buying|purchase|purchasing|order|ordering|kjope|kjop|bestille)\s+(?:(?:a|an|the|some|en|et)\s+)?(?:tickets?|tours?|tastings?|workshops?|experiences?|cooking\s+class(?:es)?|billett(?:er)?|omvisning|smaking|matkurs|opplevelser?|turer?)\b/.test(request)) return false;
  return /\b(?:buy|buying|purchase|purchasing|order|ordering|kjope|kjop|bestille|shops?|stores?|sellers?|butikker?|utsalg)\b/.test(request);
}
