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
//                                      arguments win, and a parsed query
//                                      with 0 hits falls back to the old
//                                      behaviour when that one has hits.
//
// No DB access here: the gazetteer (poststed spellings) and the count
// function are passed in. Rollback switch: DENTAL_QUERY_PARSER_DISABLED=1,
// read per request, restores the old behaviour on all three surfaces.

import { DENTAL_SEARCH_VOCABULARY, type SearchVocabulary } from "../config/dental-search-vocabulary";
import { detectPlace, matchesAsWordPrefix, tokenize, type PlaceGazetteer, type PlaceMatch } from "./search-intent/norwegian-query";
import { resolveFylke2024, resolveKommunenummerForName } from "./fylke-2024-migration";
import { cityToFylke } from "./norway-fylke";
import { postnumreForKommune } from "./norway-postnummer";

export const MAX_NAME_TERMS = 6;
export const MAX_POSTNUMMER_IN = 400;

/** Store filter fields (ListFilter in dental-store.ts) the parser can set. */
export interface DentalQueryFilter {
  poststed_in?: string[];
  postnummer_in?: string[];
  fylke?: string;
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

export function parseDentalQuery(
  text: string,
  gazetteer: PlaceGazetteer,
  vocabulary: SearchVocabulary = DENTAL_SEARCH_VOCABULARY
): DentalQueryParse {
  const tokens: Array<string | null> = tokenize(text);
  const filter: DentalQueryFilter = {};
  const interpretation: string[] = [];
  const notes: string[] = [];

  // 1. Specialty: longest synonym phrase first; every mention is used up, the first one applies.
  const specialtyPhrases = vocabulary.specialties
    .flatMap((s) => s.synonyms.map((syn) => ({ canonical: s.canonical, words: tokenize(syn) })))
    .sort((a, b) => b.words.length - a.words.length || b.words.join(" ").length - a.words.join(" ").length);
  for (const { canonical, words } of specialtyPhrases) {
    for (let i = 0; i + words.length <= tokens.length; i++) {
      if (!phraseAt(tokens, i, words)) continue;
      consume(tokens, i, words.length);
      if (!filter.specialty) filter.specialty = canonical;
      else if (filter.specialty !== canonical) notes.push(`flere spesialiteter nevnt; bruker ${filter.specialty}`);
    }
  }

  // 2. Akutt / Helfo triggers. A trigger right after a negation ("uten helfo") is used up but not applied.
  const triggers: Array<[kind: "akutt" | "helfo", words: string[]]> = [
    ...vocabulary.akutt.map((t) => ["akutt", tokenize(t)] as ["akutt", string[]]),
    ...vocabulary.helfo.map((t) => ["helfo", tokenize(t)] as ["helfo", string[]]),
  ];
  for (const [kind, words] of triggers) {
    for (let i = 0; i + words.length <= tokens.length; i++) {
      if (!phraseAt(tokens, i, words)) continue;
      const before = i > 0 ? tokens[i - 1] : null;
      const phrase = tokens.slice(i, i + words.length).join(" ");
      consume(tokens, i, words.length);
      if (before && vocabulary.negations.has(before)) notes.push(`«${before} ${phrase}» brukes ikke som filter`);
      else if (kind === "akutt") filter.acute_vakt = 1;
      else filter.helfo_agreement = "true";
    }
  }

  // 3. Place: the first (longest) usable match decides; further places are
  //    used up with a note. A place that cannot be a filter (Herøy: several
  //    kommuner, no single fylke) stays in the text as name words.
  const placeTokens = [...tokens];
  let place: PlaceMatch | null;
  let placeSet = false;
  while ((place = detectPlace(placeTokens, gazetteer, { notAlone: vocabulary.stopwords }))) {
    consume(placeTokens, place.start, place.length);
    if (placeSet) {
      notes.push(`flere steder nevnt; «${displayPhrase(place.phrase)}» brukes ikke`);
    } else if (!applyPlace(place, filter, interpretation, notes)) {
      continue;
    }
    consume(tokens, place.start, place.length);
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
  for (const n of notes) interpretation.push(`merknad: ${n}`);

  return { filter, interpretation, residual_terms: residual };
}

// Tokens [i, i+words.length) spell the phrase; the last word may continue
// ("kjeveortoped" matches "kjeveortopeden").
function phraseAt(tokens: ReadonlyArray<string | null>, i: number, words: readonly string[]): boolean {
  for (let j = 0; j < words.length; j++) {
    const t = tokens[i + j];
    if (t === null || t === undefined) return false;
    if (j < words.length - 1 ? t !== words[j] : !matchesAsWordPrefix(t, words[j])) return false;
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

// Sets the filter for one place. Returns false when the place cannot be
// used as a filter (ambiguous kommune with no fylke); its words then stay in
// the text and are matched as name words.
function applyPlace(place: PlaceMatch, filter: DentalQueryFilter, interpretation: string[], notes: string[]): boolean {
  const shown = displayPhrase(place.phrase);
  switch (place.kind) {
    case "poststed":
      filter.poststed_in = [...place.values];
      interpretation.push(`sted: ${shown} (poststed)`);
      return true;
    case "fylke":
      filter.fylke = place.name;
      interpretation.push(
        place.name.toLowerCase() === place.phrase ? `sted: ${place.name} (fylke)` : `sted: ${place.name} (fylke; «${shown}»)`
      );
      return true;
    case "region": {
      const fylke = cityToFylke(place.name);
      if (!fylke) {
        notes.push(`«${shown}» er en region uten ett fylke; ordet brukes som navnesøk`);
        return false;
      }
      filter.fylke = fylke;
      interpretation.push(`sted: ${fylke} (fylke; regionen ${place.name})`);
      return true;
    }
    case "kommune": {
      const resolved = resolveKommunenummerForName(place.name);
      if ("kommunenummer" in resolved) {
        const postnumre = postnumreForKommune(resolved.kommunenummer);
        if (postnumre.length > 0 && postnumre.length <= MAX_POSTNUMMER_IN) {
          filter.postnummer_in = postnumre;
          interpretation.push(`sted: ${place.name} kommune (etter postnummer)`);
          return true;
        }
        const own = resolveFylke2024({ kommunenummer: resolved.kommunenummer });
        if ("fylke" in own) {
          filter.fylke = own.fylke;
          notes.push(`${place.name} kommune har ${postnumre.length} postnumre; søker i hele ${own.fylke}`);
          interpretation.push(`sted: ${own.fylke} (fylke)`);
          return true;
        }
      }
      // Several kommuner share the name (Herøy, Våler) or it is unknown.
      const fylke = cityToFylke(place.name);
      if (fylke) {
        filter.fylke = fylke;
        notes.push(`«${shown}» er navnet på flere kommuner; søker i ${fylke}`);
        interpretation.push(`sted: ${fylke} (fylke)`);
        return true;
      }
      notes.push(`«${shown}» er navnet på flere kommuner; ordet brukes som navnesøk`);
      return false;
    }
  }
}

// ─── Shared plan for MCP tannlege_search, /sok and A2A message/send ─────────

/** True when DENTAL_QUERY_PARSER_DISABLED is "1"/"true" (read per request, like DENTAL_HOMEPAGE_PARKING_DISABLED). */
export function isDentalQueryParserDisabled(): boolean {
  const v = process.env.DENTAL_QUERY_PARSER_DISABLED;
  return v === "1" || v === "true";
}

/** The `tolkning` block a search answer carries, so the caller can say what was used. */
export interface DentalSearchTolkning {
  sporring: string;
  tolket_som: string[];
  /** The filter the result was found with. */
  filter: Record<string, unknown>;
  /** true: the parsed query found nothing and the old whole-text search did. */
  fallback: boolean;
}

export interface DentalSearchPlan {
  filter: Record<string, unknown>;
  tolkning: DentalSearchTolkning | null;
  /** Total hits for `filter` (callers reuse it instead of counting again). */
  count: number;
}

/**
 * Turn a free-text query plus the caller's explicit filter fields into one
 * store filter. Explicit fields win over what the parser found (a key set to
 * undefined removes the parsed one). When the parsed filter has 0 hits and
 * the old behaviour (`legacy`, default: whole text as `q`) has hits, the old
 * one is used and tolkning.fallback is true. With the parser disabled, or no
 * query text, the old behaviour is used as is and tolkning is null.
 */
export function planDentalSearch(opts: {
  query: string | null | undefined;
  explicit: Record<string, unknown>;
  gazetteer: () => PlaceGazetteer;
  count: (filter: Record<string, unknown>) => number;
  legacy?: (query: string) => Record<string, unknown>;
}): DentalSearchPlan {
  const query = (opts.query ?? "").trim();
  const legacyFilter = () => (opts.legacy ? opts.legacy(query) : { ...opts.explicit, q: query });
  if (!query) return { filter: opts.explicit, tolkning: null, count: opts.count(opts.explicit) };
  if (isDentalQueryParserDisabled()) {
    const filter = legacyFilter();
    return { filter, tolkning: null, count: opts.count(filter) };
  }

  const parsed = parseDentalQuery(query, opts.gazetteer());
  const filter = definedOnly({ ...parsed.filter, ...opts.explicit });
  const count = opts.count(filter);
  if (count === 0) {
    const legacy = legacyFilter();
    const legacyCount = opts.count(legacy);
    if (legacyCount > 0) {
      return {
        filter: legacy,
        tolkning: { sporring: query, tolket_som: parsed.interpretation, filter: definedOnly(legacy), fallback: true },
        count: legacyCount,
      };
    }
  }
  return { filter, tolkning: { sporring: query, tolket_som: parsed.interpretation, filter, fallback: false }, count };
}

function definedOnly(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
