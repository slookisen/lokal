// ─── Shared search primitives for Norwegian/English free-text queries ──────
//
// dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S1). Pure helpers, no
// DB access: text normalisation + tokenising, LIKE escaping, and place
// detection against an injected gazetteer. dental-query-parser.ts is the
// first user; the vocabulary (stopwords, specialties, triggers) is per
// vertical config (src/config/dental-search-vocabulary.ts), so another
// vertical can reuse these primitives with its own word lists.

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
