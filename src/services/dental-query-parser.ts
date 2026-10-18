// ─── Dental natural-language query parser ───────────────────────────────────
//
// dev-request 2026-10-16-tannlege-sok-naturlig-sprak. Before this, MCP
// tannlege_search and /sok sent the whole query as ONE substring against
// name-or-poststed, so "tannlege i Bergen" or "kjeveortoped Bergen" gave 0
// hits; A2A had its own keyword parser with substring bugs ("troms" inside
// "Tromsø"). One parser now serves all three surfaces:
//
//   parseDentalQuery(text, gazetteer)  pure: text -> store filter fields +
//                                      a human-readable interpretation.
//   planDentalSearch(...)              shared by MCP, /sok and A2A: explicit
//                                      arguments win, and the old reading of
//                                      the text is kept alongside the parsed
//                                      one, so no query finds fewer clinics
//                                      than before (see the function).
//
// No DB access here: the gazetteer (poststed spellings, and since D3f the
// landsdeler and byområder of config/norway-search-areas.ts) and the count
// function are passed in. Input is bounded (MAX_QUERY_CHARS, MAX_QUERY_TOKENS,
// MAX_TERM_CHARS) before any work, so an oversized query costs no more than
// a normal one on the main thread (dev-requests 2026-09-19 / 2026-09-26).
// Rollback switch: DENTAL_QUERY_PARSER_DISABLED=1, read per request,
// restores the old behaviour on all three surfaces.

import { DENTAL_SEARCH_VOCABULARY, type SearchVocabulary } from "../config/dental-search-vocabulary";
import {
  detectPlaces,
  fylkerForPoststed,
  kommunerForPoststed,
  matchesAsWordPrefix,
  mergedFylkeParts,
  placeKey,
  tokenize,
  type PlaceGazetteer,
  type PlaceMatch,
} from "./search-intent/norwegian-query";
import { resolveFylke2024, resolveKommunenummerForName } from "./fylke-2024-migration";
import { cityToFylke, fylkeEquivalents, normaliseFylke } from "./norway-fylke";
import { postnumreForKommune, resolveKommuneFromPostnummer } from "./norway-postnummer";

/** Only this much of the text is read (the rest is ignored, with a note). */
export const MAX_QUERY_CHARS = 256;
/** Only this many words are read. */
export const MAX_QUERY_TOKENS = 32;
/** A longer word is cut to this length (the store's limit for a name word). */
export const MAX_TERM_CHARS = 100;
export const MAX_NAME_TERMS = 6;
export const MAX_POSTSTED_IN = 20;
export const MAX_POSTNUMMER_IN = 400;

/** Store filter fields (ListFilter in dental-store.ts) the parser can set. */
export interface DentalQueryFilter {
  poststed_in?: string[];
  postnummer_in?: string[];
  /** A poststed in the kommune of the same name («Bergen»): its spellings OR the kommune's postnumre (S3b). */
  poststed_or_postnummer?: { poststed_in: string[]; postnummer_in: string[] };
  fylke?: string;
  /** A re-split 2020 fylke ("Viken"): its own name plus today's fylker. A landsdel ("Vestlandet", D3f): its fylker. */
  fylke_in?: string[];
  specialty?: string;
  helfo_agreement?: "true";
  acute_vakt?: 1;
  name_terms?: string[];
}

export interface DentalQueryParse {
  filter: DentalQueryFilter;
  /** Norwegian, one entry per part used ("sted: Bergen (poststed)") plus notes. */
  interpretation: string[];
  /** Words left after places, specialty, triggers and stopwords (name_terms is the first 6). */
  residual_terms: string[];
}

export interface DentalQueryParseOptions {
  vocabulary?: SearchVocabulary;
  /**
   * A fylke the caller filters on explicitly. A place in the text that lies
   * outside it is used up but not applied (with a note), so the explicit
   * fylke decides: «tannlege i Bergen» + fylke Rogaland searches Rogaland.
   */
  withinFylke?: string;
}

export function parseDentalQuery(
  text: string,
  gazetteer: PlaceGazetteer,
  opts: DentalQueryParseOptions = {}
): DentalQueryParse {
  const vocabulary = opts.vocabulary ?? DENTAL_SEARCH_VOCABULARY;
  const filter: DentalQueryFilter = {};
  const interpretation: string[] = [];
  const notes: string[] = [];

  // 0. Bounds, before any other work: the first MAX_QUERY_CHARS characters,
  //    the first MAX_QUERY_TOKENS words, each word at most MAX_TERM_CHARS.
  const source = String(text ?? "");
  if (source.length > MAX_QUERY_CHARS) notes.push(`bare de første ${MAX_QUERY_CHARS} tegnene brukes`);
  let words = tokenize(source.slice(0, MAX_QUERY_CHARS));
  if (words.length > MAX_QUERY_TOKENS) {
    notes.push(`bare de første ${MAX_QUERY_TOKENS} ordene brukes`);
    words = words.slice(0, MAX_QUERY_TOKENS);
  }
  if (words.some((w) => w.length > MAX_TERM_CHARS)) notes.push(`ord over ${MAX_TERM_CHARS} tegn er kortet ned`);
  const tokens: Array<string | null> = words.map((w) => w.slice(0, MAX_TERM_CHARS));

  // 1. Specialty: longest synonym phrase first; every mention is used up, the first one applies.
  const specialty = takeSpecialty(tokens, vocabulary, notes);
  if (specialty) filter.specialty = specialty;

  // 2. Akutt / Helfo triggers, whole words only ("Akuttklinikken" stays a
  //    name word). A trigger right after a negation ("uten helfo") is used up
  //    but not applied.
  const triggers: Array<[kind: "akutt" | "helfo", words: string[]]> = [
    ...vocabulary.akutt.map((t) => ["akutt", tokenize(t)] as ["akutt", string[]]),
    ...vocabulary.helfo.map((t) => ["helfo", tokenize(t)] as ["helfo", string[]]),
  ];
  for (const [kind, phrase] of triggers) {
    for (let i = 0; i + phrase.length <= tokens.length; i++) {
      if (!phraseAt(tokens, i, phrase, false)) continue;
      const before = i > 0 ? tokens[i - 1] : null;
      consume(tokens, i, phrase.length);
      if (before && vocabulary.negations.has(before)) notes.push(`«${before} ${phrase.join(" ")}» brukes ikke som filter`);
      else if (kind === "akutt") filter.acute_vakt = 1;
      else filter.helfo_agreement = "true";
    }
  }

  // 3. Place: every place is found in one pass (detectPlaces); the first
  //    (longest) usable one applies and further places are used up with a
  //    note. A place that cannot be a filter (Herøy: several kommuner, no
  //    single fylke) stays in the text as name words; one outside the
  //    caller's explicit fylke is used up and noted. A kommune word right
  //    after the place ("Kvam kommune") names it as the kommune.
  const scope = opts.withinFylke && normaliseFylke(opts.withinFylke) ? new Set(fylkeEquivalents(opts.withinFylke)) : null;
  let placeSet = false;
  let placeDropped = false;
  for (const place of detectPlaces(tokens, gazetteer, { notAlone: vocabulary.stopwords })) {
    const shown = displayPhrase(place.phrase);
    if (placeSet) {
      consume(tokens, place.start, place.length);
      notes.push(`flere steder nevnt; «${shown}» brukes ikke`);
      continue;
    }
    const next = tokens[place.start + place.length];
    const reading = readPlace(place, shown, gazetteer, !!next && vocabulary.kommuneWords.has(next));
    if (!("fields" in reading)) {
      notes.push(reading.note);
      continue;
    }
    consume(tokens, place.start, place.length);
    if (scope && reading.fylker.length > 0 && !reading.fylker.some((f) => scope.has(f))) {
      notes.push(`«${shown}» ligger ikke i ${normaliseFylke(opts.withinFylke!)}; stedet i teksten brukes ikke`);
      placeDropped = true;
      continue;
    }
    Object.assign(filter, reading.fields);
    interpretation.push(reading.line);
    if (reading.note) notes.push(reading.note);
    placeSet = true;
  }

  // 4. What is left (minus stopwords and single letters) is matched against name or poststed.
  const residual = tokens.filter(
    (t): t is string => t !== null && t.length > 1 && !vocabulary.stopwords.has(t)
  );
  if (residual.length > 0) {
    filter.name_terms = residual.slice(0, MAX_NAME_TERMS);
    if (residual.length > MAX_NAME_TERMS) notes.push(`bare de ${MAX_NAME_TERMS} første ordene brukes i navnesøket`);
  }

  if (filter.specialty) interpretation.push(`spesialitet: ${filter.specialty}`);
  if (filter.acute_vakt) interpretation.push("akutt: ja");
  if (filter.helfo_agreement) interpretation.push("Helfo-avtale: ja");
  if (filter.name_terms) interpretation.push(`navn eller poststed inneholder: ${filter.name_terms.join(", ")}`);
  if (words.length > 0 && Object.keys(filter).length === 0 && !placeDropped) {
    notes.push("fant ikke sted, spesialitet eller navneord i teksten");
  }
  for (const n of new Set(notes)) interpretation.push(`merknad: ${n}`);

  return { filter, interpretation, residual_terms: residual };
}

// Uses up every specialty mention in `tokens` (longest synonym phrase
// first) and returns the first one's stored name.
function takeSpecialty(tokens: Array<string | null>, vocabulary: SearchVocabulary, notes: string[]): string | undefined {
  const phrases = vocabulary.specialties
    .flatMap((s) => s.synonyms.map((syn) => ({ canonical: s.canonical, words: tokenize(syn) })))
    .sort((a, b) => b.words.length - a.words.length || b.words.join(" ").length - a.words.join(" ").length);
  let found: string | undefined;
  for (const { canonical, words } of phrases) {
    for (let i = 0; i + words.length <= tokens.length; i++) {
      if (!phraseAt(tokens, i, words, true)) continue;
      consume(tokens, i, words.length);
      if (!found) found = canonical;
      else if (found !== canonical) notes.push(`flere spesialiteter nevnt; bruker ${found}`);
    }
  }
  return found;
}

// Tokens [i, i+words.length) spell the phrase. With `lastMayContinue` the
// last word may continue ("kjeveortoped" matches "kjeveortopeden").
function phraseAt(tokens: ReadonlyArray<string | null>, i: number, words: readonly string[], lastMayContinue: boolean): boolean {
  for (let j = 0; j < words.length; j++) {
    const t = tokens[i + j];
    if (t === null || t === undefined) return false;
    const continues = lastMayContinue && j === words.length - 1;
    if (continues ? !matchesAsWordPrefix(t, words[j]) : t !== words[j]) return false;
  }
  return words.length > 0;
}

function consume(tokens: Array<string | null>, start: number, length: number): void {
  for (let i = start; i < start + length; i++) tokens[i] = null;
}

// "mo i rana" -> "Mo i Rana": the user's own words, for the interpretation text.
function displayPhrase(phrase: string): string {
  return phrase
    .split(" ")
    .map((w) => (["i", "og", "på"].includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// "Akershus, Buskerud og Østfold"
function listNames(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} og ${names[names.length - 1]}` : names.join("");
}

interface PlaceReading {
  fields: DentalQueryFilter;
  /** The fylker the place lies in ([] when unknown). */
  fylker: readonly string[];
  /** Interpretation line. */
  line: string;
  note?: string;
}

// The filter fields for one place, or a note when the place cannot be used
// as a filter (ambiguous kommune with no fylke); its words then stay in the
// text and are matched as name words. `namedAsKommune`: a kommune word
// follows the place in the text ("Kvam kommune").
function readPlace(
  place: PlaceMatch,
  shown: string,
  gazetteer: PlaceGazetteer,
  namedAsKommune: boolean
): PlaceReading | { note: string } {
  switch (place.kind) {
    case "poststed": {
      const values = place.values.filter((v) => v.length <= MAX_TERM_CHARS).slice(0, MAX_POSTSTED_IN);
      if (values.length === 0) return { note: `«${shown}» brukes som navnesøk` };
      const fylker = fylkerForPoststed(place.values[0]);
      // S3b: a poststed that lies in the one kommune of the same name
      // («Bergen», «Tromsø») covers the whole kommune: its stored spellings
      // OR the kommune's postnumre, so Nesttun and Fyllingsdalen count as
      // Bergen. So does a poststed in another kommune when the text names
      // the kommune (D3c: «Kvam kommune» is the poststed KVAM in Nord-Fron
      // OR Kvam kommune's NORHEIMSUND, ØYSTESE …). The poststed alone, as
      // before, when several kommuner share the name (Herøy), when the
      // poststed lies in another kommune and the text does not say kommune
      // («tannlege i Kvam»), or when the kommune has more postnumre than the
      // store takes (Oslo, where the poststed and the kommune are nearly the
      // same). The fylker stay those of the poststed, so an explicit fylke
      // keeps or drops the place as before, and the filter only widens: no
      // query finds fewer clinics than before.
      const kommune = kommuneNamed(gazetteer.kommuner.get(placeKey(place.phrase)));
      if (
        kommune &&
        (namedAsKommune || kommunerForPoststed(place.values[0]).includes(kommune.kommunenummer)) &&
        kommune.postnumre.length > 0 &&
        kommune.postnumre.length <= MAX_POSTNUMMER_IN
      ) {
        return {
          fields: { poststed_or_postnummer: { poststed_in: values, postnummer_in: kommune.postnumre } },
          fylker,
          line: `sted: ${shown} (poststed + kommune)`,
        };
      }
      return { fields: { poststed_in: values }, fylker, line: `sted: ${shown} (poststed)` };
    }
    case "fylke": {
      const parts = mergedFylkeParts(place.name);
      if (parts) {
        return { fields: { fylke_in: [place.name, ...parts] }, fylker: parts, line: `sted: ${listNames(parts)} (fylker; «${shown}»)` };
      }
      return {
        fields: { fylke: place.name },
        fylker: [place.name],
        line: place.name.toLowerCase() === place.phrase ? `sted: ${place.name} (fylke)` : `sted: ${place.name} (fylke; «${shown}»)`,
      };
    }
    case "region": {
      const fylke = cityToFylke(place.name);
      if (!fylke) return { note: `«${shown}» er en region uten ett fylke; ordet brukes som navnesøk` };
      return { fields: { fylke }, fylker: [fylke], line: `sted: ${fylke} (fylke; regionen ${place.name})` };
    }
    case "landsdel": {
      // D3f: a part of the country («Vestlandet», «Nord-Norge») is its
      // fylker (config/norway-search-areas.ts), each as «tannlege i X» reads
      // it (today's name, so fylke_in matches as fylke X does).
      const fylker = place.values;
      return {
        fields: { fylke_in: [...fylker] },
        fylker,
        line: `sted: ${listNames(fylker)} (${fylker.length > 1 ? "fylker" : "fylke"}; landsdelen ${place.name})`,
      };
    }
    case "byomrade":
      return readCityArea(place, shown, gazetteer);
    case "kommune": {
      const kommune = kommuneNamed(place.name);
      if (kommune) {
        const fylker = kommune.fylke ? [kommune.fylke] : [];
        if (kommune.postnumre.length > 0 && kommune.postnumre.length <= MAX_POSTNUMMER_IN) {
          return { fields: { postnummer_in: kommune.postnumre }, fylker, line: `sted: ${place.name} kommune (etter postnummer)` };
        }
        if (kommune.fylke) {
          return {
            fields: { fylke: kommune.fylke },
            fylker,
            line: `sted: ${kommune.fylke} (fylke)`,
            note: `${place.name} kommune har ${kommune.postnumre.length} postnumre; søker i hele ${kommune.fylke}`,
          };
        }
      }
      // Several kommuner share the name (Herøy, Våler) or it is unknown.
      const fylke = cityToFylke(place.name);
      if (fylke) {
        return { fields: { fylke }, fylker: [fylke], line: `sted: ${fylke} (fylke)`, note: `«${shown}» er navnet på flere kommuner; søker i ${fylke}` };
      }
      return { note: `«${shown}» er navnet på flere kommuner; ordet brukes som navnesøk` };
    }
  }
}

// D3f: a city area («Osloområdet», «Tromsøya») is its kommuner
// (config/norway-search-areas.ts), each read as its name alone is (S3b): the
// poststed of the kommune's name in all its stored spellings, when that
// poststed lies in the kommune, OR the kommune's postnumre. Spellings or
// postnumre that would take the area past the store's caps (MAX_POSTSTED_IN,
// MAX_POSTNUMMER_IN) are left out, as Oslo's 445 postnumre are left out of
// «tannlege i Oslo», and a kommune left with neither is not in the line. The
// areas in the table stay within the caps (checked in tests), so an area
// finds every clinic that one of its kommuner finds alone.
function readCityArea(place: PlaceMatch, shown: string, gazetteer: PlaceGazetteer): PlaceReading | { note: string } {
  const poststeder: string[] = [];
  const postnumre: string[] = [];
  const fylker: string[] = [];
  const used: string[] = [];
  for (const name of place.values) {
    const kommune = kommuneNamed(name);
    if (!kommune) continue;
    const stored = gazetteer.poststeder.get(placeKey(name)) ?? [];
    const own = stored.length > 0 && kommunerForPoststed(stored[0]).includes(kommune.kommunenummer)
      ? stored.filter((v) => v.length <= MAX_TERM_CHARS)
      : [];
    const withSpellings = own.length > 0 && poststeder.length + own.length <= MAX_POSTSTED_IN;
    const withPostnumre = kommune.postnumre.length > 0 && postnumre.length + kommune.postnumre.length <= MAX_POSTNUMMER_IN;
    if (!withSpellings && !withPostnumre) continue;
    if (withSpellings) poststeder.push(...own);
    if (withPostnumre) postnumre.push(...kommune.postnumre);
    if (kommune.fylke && !fylker.includes(kommune.fylke)) fylker.push(kommune.fylke);
    used.push(name);
  }
  if (used.length === 0) return { note: `«${shown}» kan ikke brukes som sted; ordet brukes som navnesøk` };
  const fields: DentalQueryFilter =
    poststeder.length === 0
      ? { postnummer_in: postnumre }
      : postnumre.length === 0
        ? { poststed_in: poststeder }
        : { poststed_or_postnummer: { poststed_in: poststeder, postnummer_in: postnumre } };
  return { fields, fylker, line: `sted: ${listNames(used)} (${used.length > 1 ? "kommuner" : "kommune"}; ${place.name})` };
}

// The one kommune with this name: its number, fylke and postnumre. null for
// no name, a name several kommuner share (Herøy, Våler) or an unknown one.
function kommuneNamed(name: string | undefined): { kommunenummer: string; fylke?: string; postnumre: string[] } | null {
  if (!name) return null;
  const resolved = resolveKommunenummerForName(name);
  if (!("kommunenummer" in resolved)) return null;
  const { kommunenummer } = resolved;
  const own = resolveFylke2024({ kommunenummer });
  return { kommunenummer, fylke: "fylke" in own ? own.fylke : undefined, postnumre: postnumreForKommune(kommunenummer) };
}

// ─── Shared plan for MCP tannlege_search, /sok and A2A message/send ─────────

/** True when DENTAL_QUERY_PARSER_DISABLED is "1"/"true" (read per request, like DENTAL_HOMEPAGE_PARKING_DISABLED). */
export function isDentalQueryParserDisabled(): boolean {
  const v = process.env.DENTAL_QUERY_PARSER_DISABLED;
  return v === "1" || v === "true";
}

/** The `tolkning` block a search answer carries, so the caller can say what was used. */
export interface DentalSearchTolkning {
  /** The text that was read (at most MAX_QUERY_CHARS characters). */
  sporring: string;
  tolket_som: string[];
  /**
   * The filter the result was found with, as tolkningFilter() shows it: each
   * postnummer list is {kommunenummer, antall} (or {antall}), not the list.
   * The plan's own filter, and A2A metadata.filter, keep the list.
   */
  filter: DentalTolkningFilter;
  /** true: the parsed reading found nothing; every hit comes from the old reading of the text. */
  fallback: boolean;
}

/** A postnummer list as tolkning shows it: one whole kommune and how many, or just how many. */
export type TolkningPostnumre = { kommunenummer: string; antall: number } | { antall: number };

/**
 * A store filter as tolkning shows it (tolkningFilter): the same fields, with
 * each postnummer_in, at any depth, a TolkningPostnumre. For display only;
 * the store never reads it (its filter is dental-store's ListFilter).
 */
export interface DentalTolkningFilter {
  [field: string]: unknown;
  postnummer_in?: TolkningPostnumre;
  poststed_or_postnummer?: { poststed_in: string[]; postnummer_in: TolkningPostnumre };
  natural?: { parsed: DentalTolkningFilter; legacy: DentalTolkningFilter };
}

export interface DentalSearchPlan {
  filter: Record<string, unknown>;
  tolkning: DentalSearchTolkning | null;
  /** Total hits for `filter` (callers reuse it instead of counting again). */
  count: number;
}

/**
 * Turn a free-text query plus the caller's explicit filter fields into one
 * store filter.
 *
 * - Explicit fields win over what the parser read: a key set to undefined
 *   removes the parsed one, and an explicit fylke drops a place in the text
 *   that lies outside it.
 * - The old reading of the text is kept next to the parsed one: the store
 *   filter is explicit AND (parsed OR old) — dental-store's `natural` field
 *   — with the old reading's hits listed first, in their old order. So a
 *   query never finds fewer clinics than before, and a clinic named in the
 *   text («Bergen Tannhelse») still comes first. The old reading is the
 *   whole text as `q` (MCP, /sok), or `legacy(text)` (A2A: its keyword
 *   parser, kept in full; since D3c2 it reads a fylke only from whole
 *   words, so «Tromsø» is its q «tromsø», no longer fylke Troms).
 * - An old reading with no filter at all (A2A «tannlege i Ås»: words of two
 *   letters were dropped, and it listed the first clinics, which is no
 *   answer) is replaced by the parsed one, and used only when the parsed
 *   one finds nothing.
 * - tolkning.fallback is true when the parsed reading found nothing and
 *   every hit comes from the old reading.
 * - tolkning.filter shows `filter` with each postnummer list shortened
 *   (tolkningFilter); `filter` itself, which the caller searches with,
 *   keeps the lists.
 *
 * With the parser disabled the old behaviour is used as is (no tolkning);
 * with no query text the explicit fields are used as is.
 */
export function planDentalSearch(opts: {
  query: string | null | undefined;
  explicit: Record<string, unknown>;
  gazetteer: () => PlaceGazetteer;
  count: (filter: Record<string, unknown>) => number;
  /** The old reading of the text (A2A: its keyword parser). Default: the whole text as `q`. */
  legacy?: (text: string) => Record<string, unknown>;
}): DentalSearchPlan {
  const raw = opts.query ?? "";
  if (isDentalQueryParserDisabled()) {
    const filter = raw ? { ...opts.explicit, ...(opts.legacy ? opts.legacy(raw) : { q: raw }) } : opts.explicit;
    return { filter, tolkning: null, count: opts.count(filter) };
  }
  const query = raw.trim();
  if (!query) return { filter: opts.explicit, tolkning: null, count: opts.count(opts.explicit) };

  const explicit = definedOnly(opts.explicit);
  const withinFylke = typeof explicit.fylke === "string" ? explicit.fylke : undefined;
  const parsed = parseDentalQuery(query, opts.gazetteer(), { withinFylke });
  const overridden = new Set(Object.keys(opts.explicit));
  const parsedPart = definedOnly(
    Object.fromEntries(Object.entries(parsed.filter).filter(([k]) => !overridden.has(k)))
  );
  const parsedFilter = { ...explicit, ...parsedPart };
  const hasParsed = Object.keys(parsedPart).length > 0;
  // The whole-text q is capped like the parser's input: a longer q only
  // repeats this prefix, so it can match no clinic the prefix misses.
  const legacy = opts.legacy ? definedOnly(opts.legacy(query)) : { q: query.slice(0, MAX_QUERY_CHARS) };
  const plan = (filter: Record<string, unknown>, count: number, fallback: boolean): DentalSearchPlan => ({
    filter,
    count,
    tolkning: { sporring: query.slice(0, MAX_QUERY_CHARS), tolket_som: parsed.interpretation, filter: tolkningFilter(filter), fallback },
  });

  if (Object.keys(legacy).length === 0) {
    if (hasParsed) {
      const count = opts.count(parsedFilter);
      if (count > 0) return plan(parsedFilter, count, false);
    }
    // Nothing better: the old answer as is, so metadata.filter stays {} and
    // is not counted as a question.
    return plan(explicit, opts.count(explicit), hasParsed);
  }
  const filter = { ...explicit, natural: { parsed: parsedPart, legacy } };
  const count = opts.count(filter);
  return plan(filter, count, hasParsed && count > 0 && opts.count(parsedFilter) === 0);
}

/**
 * A store filter as tolkning shows it (D3c). A kommune's postnummer list
 * (up to MAX_POSTNUMMER_IN; Bergen's 144 were about 1.1 KB of every answer)
 * says no more than the kommune, so each postnummer_in, at any depth,
 * becomes {kommunenummer, antall} when it is one whole kommune's postnumre,
 * else {antall}. Pure: `filter` is not changed.
 */
export function tolkningFilter(filter: Record<string, unknown>): DentalTolkningFilter {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(filter)) {
    if (field === "postnummer_in" && Array.isArray(value)) out[field] = shownPostnumre(value);
    else if (value !== null && typeof value === "object" && !Array.isArray(value)) out[field] = tolkningFilter(value as Record<string, unknown>);
    else out[field] = value;
  }
  return out;
}

function shownPostnumre(list: readonly unknown[]): TolkningPostnumre {
  const first = typeof list[0] === "string" ? resolveKommuneFromPostnummer(list[0]) : null;
  if (first && "kommunenummer" in first) {
    const whole = postnumreForKommune(first.kommunenummer);
    const given = new Set(list);
    if (whole.length === list.length && whole.every((p) => given.has(p))) {
      return { kommunenummer: first.kommunenummer, antall: list.length };
    }
  }
  return { antall: list.length };
}

function definedOnly(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
