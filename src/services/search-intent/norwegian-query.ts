// ─── Shared search primitives for Norwegian/English free-text queries ──────
//
// dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S1). Pure helpers, no
// DB access: text normalisation + tokenising, LIKE escaping, and place
// detection against an injected gazetteer. dental-query-parser.ts is the
// first user; the vocabulary (stopwords, specialties, triggers) is per
// vertical config (src/config/dental-search-vocabulary.ts), so another
// vertical can reuse these primitives with its own word lists. The one
// shared word list is QUERY_STOPWORDS (Opplevagent and the RFB search).

import {
  __FYLKE_INTERNAL,
  EQUIVALENCE_CLASSES,
  fylkeEquivalents,
  normaliseFylke,
  NON_KOMMUNE_REGION_LABELS,
  REGION_TO_KOMMUNER,
} from "../norway-fylke";
import { kommuner2024, officialPoststedFylker, officialPoststedKommuner } from "../norway-postnummer";

/** NFC + Unicode-aware lower case (folds Æ/Ø/Å, unlike SQLite's LOWER()). */
export function normalize(text: string): string {
  return String(text ?? "").normalize("NFC").toLowerCase();
}

// Separators: whitespace and punctuation, hyphen included ("helfo-avtale" ->
// helfo + avtale, "Aurskog-Høland" -> aurskog + høland). `%` and `_` are kept
// inside tokens so a literal "50%_x" survives as one name term (the store
// LIKE-escapes it).
const TOKEN_SEPARATORS = /[\s,.;:!?()[\]{}"'«»“”‘’`´/\\|+&*=<>#@~^-]+/u;

/** Lower-cased tokens in input order; empty input gives []. */
export function tokenize(text: string): string[] {
  return normalize(text).split(TOKEN_SEPARATORS).filter((t) => t.length > 0);
}

// Copied from src/routes/experiences-a2a.ts (matchesAsWordPrefix), which is
// left untouched. JS's \b doesn't treat æøå as word characters, so a plain
// regex \b boundary can't be used here. This checks the actual preceding
// character is not a Unicode letter/digit, while leaving the keyword's own
// end open so inflected continuations ("akutt" -> "akuttvakt") still match.
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

/**
 * Escape SQLite LIKE metacharacters (`%`, `_`) and the escape character
 * itself with `\`, for use with `LIKE ? ESCAPE '\'`. Same escaping rule as
 * gardssalgLikePattern() in experience-store.ts, without its non-ASCII `_`
 * substitution (dental compares nb_lower() on both sides instead).
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

/**
 * Words that carry no search meaning on their own: question words, pronouns,
 * prepositions, request verbs, "experiences"/"activities", praise words, time
 * words, number words and who is travelling (a keyword filter on "family"
 * would only keep the rows whose text happens to say so). Norwegian and
 * English. A word missing here costs little: discoverExperiencesRelaxed()
 * relaxes the search words one at a time.
 *
 * Shared: moved here unchanged from experiences-query-intent.ts (which
 * re-exports it) in dev-request 2026-10-17-integrasjonstest-oppfolging,
 * slice I-W. Opplevagent's free-text search drops these words, and the RFB
 * search (marketplace-registry.ts unknownProductWords) never looks them up
 * in the product names. A vertical adds its own words in its own list
 * rather than here, since every user of the list would see them.
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

/**
 * Fold a place name for lookup: lower case, æ/ø/å as ae/oe/aa, then only
 * letters and digits. "Bodø", "BODØ" and the ASCII spelling "Bodoe" that some
 * stored rows carry all fold to "bodoe"; "Aurskog-Høland" and "Aurskog
 * Hoeland" both to "aurskoghoeland".
 */
export function placeKey(name: string): string {
  return fold(name, "oe", "aa");
}

function fold(name: string, oe: string, aa: string): string {
  return normalize(name)
    .replace(/æ|ä/g, "ae")
    .replace(/ø|ö/g, oe)
    .replace(/å/g, aa)
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// The fold plus the ASCII spelling a visitor types without æ/ø/å ("Tromso",
// "Alesund": ø as o, å as a). The ASCII key is only added for 4+ letters, so
// short names never collide with everyday words ("Ås" -> "as", "Hå" -> "ha").
function placeKeys(name: string): [exact: string, ascii?: string] {
  const exact = placeKey(name);
  const ascii = fold(name, "o", "a");
  return ascii !== exact && ascii.length >= 4 ? [exact, ascii] : [exact];
}

export type PlaceKind = "poststed" | "kommune" | "region" | "fylke";

/** Place names by placeKey() (plus ASCII aliases). Built by buildPlaceGazetteer(); never read from a DB here. */
export interface PlaceGazetteer {
  /** placeKey -> every stored spelling of that poststed, most common first. */
  poststeder: ReadonlyMap<string, readonly string[]>;
  /** placeKey -> kommune display name ("Bærum", "Herøy"). */
  kommuner: ReadonlyMap<string, string>;
  /** placeKey -> region label ("Lofoten"). */
  regioner: ReadonlyMap<string, string>;
  /** placeKey -> canonical 2024 fylke ("Hordaland" -> "Vestland"). */
  fylker: ReadonlyMap<string, string>;
  /** Longest entry, in tokens. */
  maxWords: number;
}

export interface PlaceMatch {
  kind: PlaceKind;
  /** Display name (kommune/region/fylke) or the most common stored poststed spelling. */
  name: string;
  /** Stored spellings for a poststed; [name] otherwise. */
  values: readonly string[];
  /** The phrase as the user typed it (tokens joined by spaces). */
  phrase: string;
  start: number;
  length: number;
}

export function buildPlaceGazetteer(input: {
  poststeder?: Iterable<string>;
  kommuner?: Iterable<string>;
  regioner?: Iterable<string>;
  fylker?: Iterable<readonly [name: string, canonical: string]>;
}): PlaceGazetteer {
  let maxWords = 1;
  const seen = (name: string) => {
    maxWords = Math.max(maxWords, tokenize(name).length);
  };
  // Exact folds are entered before any ASCII alias, so an alias never shadows
  // a real name. A poststed's alias shares its spelling list.
  const poststeder = new Map<string, string[]>();
  const spellings = [...(input.poststeder ?? [])];
  for (const stored of spellings) {
    const k = placeKey(stored);
    if (!k) continue;
    const list = poststeder.get(k);
    if (!list) poststeder.set(k, [stored]);
    else if (!list.includes(stored)) list.push(stored);
    seen(stored);
  }
  for (const stored of spellings) {
    const [k, ascii] = placeKeys(stored);
    if (ascii && !poststeder.has(ascii)) poststeder.set(ascii, poststeder.get(k)!);
  }
  const named = (entries: ReadonlyArray<readonly [name: string, value: string]>) => {
    const m = new Map<string, string>();
    for (const [name, value] of entries) {
      const k = placeKey(name);
      if (k && !m.has(k)) m.set(k, value);
      seen(name);
    }
    for (const [name, value] of entries) {
      const ascii = placeKeys(name)[1];
      if (ascii && !m.has(ascii)) m.set(ascii, value);
    }
    return m;
  };
  const self = (names: Iterable<string> | undefined) => [...(names ?? [])].map((n) => [n, n] as const);
  return {
    poststeder,
    kommuner: named(self(input.kommuner)),
    regioner: named(self(input.regioner)),
    fylker: named([...(input.fylker ?? [])]),
    maxWords,
  };
}

// placeKey(official poststed) -> the fylker / kommunenumre its postnumre lie in.
let _officialFylker: Map<string, readonly string[]> | null = null;
let _officialKommuner: Map<string, readonly string[]> | null = null;

function officialFylkerByKey(): Map<string, readonly string[]> {
  return (_officialFylker ??= byPlaceKey(officialPoststedFylker()));
}

// One list per placeKey: the lists of every official name with that key, merged.
function byPlaceKey(byName: ReadonlyMap<string, readonly string[]>): Map<string, readonly string[]> {
  const byKey = new Map<string, Set<string>>();
  for (const [name, values] of byName) {
    const k = placeKey(name);
    const set = byKey.get(k) ?? new Set<string>();
    for (const v of values) set.add(v);
    byKey.set(k, set);
  }
  return new Map([...byKey].map(([k, set]) => [k, [...set]]));
}

/**
 * The fylker an official poststed lies in, for any stored spelling of it
 * ("BERGEN", "Bergen" -> ["Vestland"]); [] when it is not an official
 * poststed. Read from the bundled postnummer register, never a DB.
 */
export function fylkerForPoststed(spelling: string): readonly string[] {
  return officialFylkerByKey().get(placeKey(spelling)) ?? [];
}

/** Likewise the kommunenumre it lies in ("Bergen" -> ["4601"]). */
export function kommunerForPoststed(spelling: string): readonly string[] {
  return (_officialKommuner ??= byPlaceKey(officialPoststedKommuner())).get(placeKey(spelling)) ?? [];
}

/** An official place name: Posten's poststed (upper case, "TROMSØ") or a 2024 kommune ("Bærum"). */
export interface OfficialPlaceSpelling {
  kind: Extract<PlaceKind, "poststed" | "kommune">;
  name: string;
}

// placeKey -> the official name with that key, or null where two different
// names share it. Built on first use and again only when the register's
// poststed index is a new object (its test seam swaps the rows).
let _officialSpellings: {
  source: ReadonlyMap<string, readonly string[]>;
  byKey: Map<string, OfficialPlaceSpelling | null>;
} | null = null;

function officialSpellingsByKey(): Map<string, OfficialPlaceSpelling | null> {
  const source = officialPoststedKommuner();
  if (_officialSpellings?.source === source) return _officialSpellings.byKey;
  const byKey = new Map<string, OfficialPlaceSpelling | null>();
  // Poststeder first; a kommune only fills a key no poststed has.
  const enter = (kind: OfficialPlaceSpelling["kind"], names: Iterable<string>) => {
    const tier = new Map<string, string | null>();
    for (const name of names) {
      const k = placeKey(name);
      if (!k) continue;
      const seen = tier.get(k);
      tier.set(k, seen === undefined || seen === name ? name : null);
    }
    for (const [k, name] of tier) if (!byKey.has(k)) byKey.set(k, name === null ? null : { kind, name });
  };
  enter("poststed", source.keys());
  enter("kommune", kommuner2024().map((k) => k.kommune));
  _officialSpellings = { source, byKey };
  return byKey;
}

/**
 * The official name a stored place value stands for, by placeKey, so the
 * ASCII form some rows carry ("Tromsoe", "Baerum") finds "TROMSØ" / "Bærum"
 * (dev-request 2026-10-17-dental-d3-rettelser, D3d). Posten's poststed comes
 * first, else the 2024 kommune name. null when the name is unknown or two
 * different official names share its key. Exact folds only: the ASCII alias a
 * visitor types ("Tromso") is not read. From the bundled register, never a DB.
 */
export function officialPlaceSpelling(spelling: string): OfficialPlaceSpelling | null {
  const k = placeKey(spelling);
  return k ? officialSpellingsByKey().get(k) ?? null : null;
}

/**
 * The Norwegian gazetteer: `poststedSpellings` (stored poststed values, most
 * common first — e.g. from dental-store listPoststeder) plus the static
 * kommune / region / fylke names from the shared data modules. A stored
 * spelling counts as a poststed only when it folds to an official poststed
 * in the bundled postnummer register, so a kommune name stored in the
 * poststed column ("Baerum", "Indre Oestfold") resolves as the kommune.
 */
export function buildNorwegianGazetteer(poststedSpellings: Iterable<string>): PlaceGazetteer {
  const officialKeys = officialFylkerByKey();
  const official: string[] = [];
  for (const s of poststedSpellings) if (officialKeys.has(placeKey(s))) official.push(s);
  return buildPlaceGazetteer({
    poststeder: official,
    kommuner: kommuner2024().map((k) => k.kommune),
    regioner: [...NON_KOMMUNE_REGION_LABELS, ...Object.keys(REGION_TO_KOMMUNER)],
    fylker: norwegianFylkeNames(),
  });
}

let _fylkeNames: Array<readonly [string, string]> | null = null;
// Every canonical 2024 fylke plus the historical halves it absorbed
// (Hordaland, Sør-Trøndelag, …), each mapped to the canonical name, and the
// re-split 2020 names (Viken, Vestfold og Telemark, Troms og Finnmark) mapped
// to themselves: they cover several of today's fylker, which the caller
// reads with mergedFylkeParts().
function norwegianFylkeNames(): Array<readonly [string, string]> {
  if (_fylkeNames) return _fylkeNames;
  const out: Array<readonly [string, string]> = [];
  for (const canonical of __FYLKE_INTERNAL.CANONICAL_FYLKER) {
    for (const name of fylkeEquivalents(canonical)) {
      if (normaliseFylke(name) === canonical) out.push([name, canonical]);
    }
  }
  for (const [merged] of EQUIVALENCE_CLASSES) out.push([merged, merged]);
  _fylkeNames = out;
  return out;
}

/**
 * Today's fylker a re-split 2020 fylke name covers ("Viken" -> Akershus,
 * Buskerud, Østfold), or null for any other name.
 */
export function mergedFylkeParts(name: string): readonly string[] | null {
  const cls = EQUIVALENCE_CLASSES.find((c) => c[0] === name);
  return cls ? cls.slice(1) : null;
}

const KIND_ORDER: readonly PlaceKind[] = ["poststed", "kommune", "region", "fylke"];

/**
 * Every place in `tokens`, in one pass: the longest phrase first, and for
 * equal length the leftmost, each kind tried in the order poststed, kommune,
 * region, fylke. Matches never overlap (a token belongs to at most one), so
 * the work is linear in the number of tokens. Whole tokens only, so "Tromsø"
 * is the poststed TROMSØ and never the fylke Troms. A `null` token (already
 * used by the caller, e.g. for a specialty) never takes part in a phrase; a
 * phrase made only of `notAlone` words (stopwords such as "time") is skipped.
 */
export function detectPlaces(
  tokens: ReadonlyArray<string | null>,
  gazetteer: PlaceGazetteer,
  opts: { notAlone?: ReadonlySet<string> } = {}
): PlaceMatch[] {
  const used = tokens.map((t) => t === null);
  const out: PlaceMatch[] = [];
  for (let len = Math.min(gazetteer.maxWords, tokens.length); len >= 1; len--) {
    for (let start = 0; start + len <= tokens.length; start++) {
      if (used.slice(start, start + len).some(Boolean)) continue;
      const words = tokens.slice(start, start + len) as string[];
      if (opts.notAlone && words.every((w) => opts.notAlone!.has(w))) continue;
      const phrase = words.join(" ");
      const k = placeKey(phrase);
      for (const kind of KIND_ORDER) {
        const hit = lookup(gazetteer, kind, k);
        if (!hit) continue;
        out.push({ kind, name: hit[0], values: hit, phrase, start, length: len });
        used.fill(true, start, start + len);
        break;
      }
    }
  }
  return out;
}

function lookup(g: PlaceGazetteer, kind: PlaceKind, k: string): readonly string[] | null {
  if (kind === "poststed") return g.poststeder.get(k) ?? null;
  const m = kind === "kommune" ? g.kommuner : kind === "region" ? g.regioner : g.fylker;
  const v = m.get(k);
  return v ? [v] : null;
}
