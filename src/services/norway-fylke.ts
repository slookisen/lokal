// ─── Norway fylke / kommune lookup (Phase 5.11 C.2 PR-64, 2026-05-16) ─
//
// Two-way mapping between Norwegian city/kommune names and fylker
// (counties), plus an alias-aware comparator.
//
// Background — the 2020/2024 fylke reform:
//   In 2020 Norway merged several fylker:
//     Hordaland + Sogn og Fjordane    → Vestland
//     Vestfold + Telemark              → Vestfold og Telemark
//     Aust-Agder + Vest-Agder          → Agder
//     Akershus + Buskerud + Østfold    → Viken
//     Troms + Finnmark                 → Troms og Finnmark
//     Hedmark + Oppland                → Innlandet
//     (Sør-Trøndelag + Nord-Trøndelag merged in 2018 → Trøndelag)
//
//   In 2024 several mergers were partially reversed:
//     Viken                            → Akershus + Buskerud + Østfold
//     Vestfold og Telemark             → Vestfold + Telemark
//     Troms og Finnmark                → Troms + Finnmark
//
//   Vestland, Agder, Innlandet, and Trøndelag remain merged post-2024.
//
// Matching convention (this module):
//   - Canonical = the 2024-onwards name (so Viken/Vestfold-og-Telemark/
//     Troms-og-Finnmark each fan back out to their constituent fylker).
//   - normaliseFylke() returns the canonical name.
//   - fylkerMatch() treats old↔new variants as aliases so that:
//       "Vestland" ↔ "Hordaland" → true (Hordaland is now part of Vestland)
//       "Akershus" ↔ "Viken"     → true (Akershus was in Viken 2020-2023)
//       "Innlandet" ↔ "Hedmark"  → true (Hedmark is now part of Innlandet)
//       "Trøndelag" ↔ "Sør-Trøndelag" → true (merged in 2018)
//
//   This is asymmetric in spirit (the merged name is broader than the
//   old name) but for matching we treat both as "same fylke" because
//   Hanen's data is usually the current name and our agents' city
//   field is a kommune name we map through cityToFylke().
//
// No external deps. Pure data + string normalisation.

// ─── helpers ───────────────────────────────────────────────────

// Lowercase, transliterate æ/ø/å, strip non-alphanum to a canonical key
// usable for lookups. Same convention as name-matcher.normaliseForMatch
// but kept inline so we don't take a cross-module dep for one regex.
function key(s: string): string {
  if (!s) return "";
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/[^a-z0-9]/g, "");
}

// ─── canonical fylke list (2024+) ──────────────────────────────
// Source: Kartverket / SSB fylkesinndelingen per 2024-01-01.
// 15 fylker total.
const CANONICAL_FYLKER: readonly string[] = [
  "Oslo",
  "Rogaland",
  "Møre og Romsdal",
  "Nordland",
  "Vestland",         // Hordaland + Sogn og Fjordane (still merged)
  "Innlandet",        // Hedmark + Oppland (still merged)
  "Vestfold",         // post-2024 (split from Vestfold og Telemark)
  "Telemark",         // post-2024
  "Agder",            // Aust-Agder + Vest-Agder (still merged)
  "Trøndelag",        // Sør-Trøndelag + Nord-Trøndelag (since 2018)
  "Troms",            // post-2024
  "Finnmark",         // post-2024
  "Akershus",         // post-2024
  "Buskerud",         // post-2024
  "Østfold",          // post-2024
];

// Build a canonical-key → display map for fast normaliseFylke().
const CANONICAL_BY_KEY = new Map<string, string>();
for (const f of CANONICAL_FYLKER) CANONICAL_BY_KEY.set(key(f), f);

// Alias map: any historical / merged / pre-reform variant → canonical.
// Both directions are exercised in fylkerMatch().
// Each entry: alias (raw string) → canonical 2024 name it ALSO covers.
//
// IMPORTANT: a few aliases are MANY-to-ONE (e.g. "Viken" was Akershus +
// Buskerud + Østfold). fylkerMatch() handles those via an explicit
// equivalence-class table below; this map only stores 1:1 redirects.
const ALIAS_TO_CANONICAL: Record<string, string> = {
  // ── pre-2018 Trøndelag halves ──
  "sortrondelag": "Trøndelag",
  "sor trondelag": "Trøndelag",
  "nordtrondelag": "Trøndelag",
  "nord trondelag": "Trøndelag",

  // ── pre-2020 Vestland halves ──
  "hordaland": "Vestland",
  "sognogfjordane": "Vestland",
  "sogn og fjordane": "Vestland",
  "sognfjordane": "Vestland",

  // ── pre-2020 Innlandet halves ──
  "hedmark": "Innlandet",
  "oppland": "Innlandet",

  // ── pre-2020 Agder halves ──
  "austagder": "Agder",
  "aust agder": "Agder",
  "vestagder": "Agder",
  "vest agder": "Agder",

  // ── pre-2020 → 2020-2023 Vestfold og Telemark, now split again ──
  // Note: "Vestfold og Telemark" is one of the broader equivalence
  // classes in EQUIVALENCE_CLASSES below; the alias map here just
  // catches single-form spellings.
  "vestfoldogtelemark": "Vestfold og Telemark",
  "vestfold og telemark": "Vestfold og Telemark",

  // ── pre-2020 → 2020-2023 Troms og Finnmark, now split again ──
  "tromsogfinnmark": "Troms og Finnmark",
  "troms og finnmark": "Troms og Finnmark",

  // ── pre-2020 → 2020-2023 Viken, now split into Akershus/Buskerud/Østfold ──
  "viken": "Viken",
};

// Equivalence classes for the broad merged-fylke names. fylkerMatch()
// returns true when both inputs land in the same set. Order doesn't
// matter; the comparator looks for set intersection.
//
// Example: "Akershus" and "Viken" both belong to the "Viken (2020-2023)"
// class, so they match. "Akershus" and "Buskerud" also both belong to
// the same Viken class — they were sibling sub-fylker. We treat sibling
// matches as TRUE (intentionally permissive — Hanen's "Viken" tag means
// any one of the three, and a producer's kommune-mapped fylke could be
// any of the three).
const EQUIVALENCE_CLASSES: ReadonlyArray<ReadonlyArray<string>> = [
  // Viken 2020-2023 = Akershus + Buskerud + Østfold
  ["Viken", "Akershus", "Buskerud", "Østfold"],
  // Vestfold og Telemark 2020-2023 = Vestfold + Telemark
  ["Vestfold og Telemark", "Vestfold", "Telemark"],
  // Troms og Finnmark 2020-2023 = Troms + Finnmark
  ["Troms og Finnmark", "Troms", "Finnmark"],
];

// Pre-compute key-set for each class for O(1) lookups.
const CLASS_KEYS: ReadonlyArray<Set<string>> = EQUIVALENCE_CLASSES.map(
  cls => new Set(cls.map(key))
);

// ─── cityToFylke ───────────────────────────────────────────────
// Map kommune/city name → canonical 2024 fylke. Returns null when the
// city is unknown so callers can treat it as "location unknown" rather
// than guessing.
//
// Coverage: ~120 entries. Targets (a) the 30 most populous Norwegian
// cities, (b) the kommuner where Hanen members typically cluster
// (farm-tourism heartland: Vestland, Innlandet, Trøndelag), and (c)
// every fylke capital so at least one city per fylke resolves.
const CITY_TO_FYLKE_RAW: Record<string, string> = {
  // Oslo
  "Oslo": "Oslo",

  // Akershus
  "Lillestrøm": "Akershus",
  "Bærum": "Akershus",
  "Asker": "Akershus",
  "Ås": "Akershus",
  "Ullensaker": "Akershus",
  "Jessheim": "Akershus",
  "Nittedal": "Akershus",
  "Frogn": "Akershus",
  "Drøbak": "Akershus",
  "Eidsvoll": "Akershus",

  // Buskerud
  "Drammen": "Buskerud",
  "Kongsberg": "Buskerud",
  "Hønefoss": "Buskerud",
  "Ringerike": "Buskerud",
  "Hallingdal": "Buskerud",
  "Hemsedal": "Buskerud",
  "Gol": "Buskerud",
  "Geilo": "Buskerud",
  "Hol": "Buskerud",
  "Nesbyen": "Buskerud",
  "Modum": "Buskerud",
  "Lier": "Buskerud",

  // Østfold
  "Fredrikstad": "Østfold",
  "Sarpsborg": "Østfold",
  "Moss": "Østfold",
  "Halden": "Østfold",
  "Askim": "Østfold",
  "Mysen": "Østfold",
  "Hvaler": "Østfold",
  "Rakkestad": "Østfold",

  // Innlandet (Hedmark + Oppland merged)
  "Hamar": "Innlandet",
  "Lillehammer": "Innlandet",
  "Gjøvik": "Innlandet",
  "Elverum": "Innlandet",
  "Kongsvinger": "Innlandet",
  "Tynset": "Innlandet",
  "Otta": "Innlandet",
  "Vinstra": "Innlandet",
  "Fagernes": "Innlandet",
  "Beitostølen": "Innlandet",
  "Ringebu": "Innlandet",
  "Trysil": "Innlandet",
  "Stange": "Innlandet",
  "Brumunddal": "Innlandet",
  "Moelv": "Innlandet",

  // Vestfold
  "Tønsberg": "Vestfold",
  "Sandefjord": "Vestfold",
  "Larvik": "Vestfold",
  "Horten": "Vestfold",
  "Holmestrand": "Vestfold",
  "Stavern": "Vestfold",
  "Færder": "Vestfold",

  // Telemark
  "Skien": "Telemark",
  "Porsgrunn": "Telemark",
  "Notodden": "Telemark",
  "Rjukan": "Telemark",
  "Kragerø": "Telemark",
  "Bamble": "Telemark",
  "Drangedal": "Telemark",
  "Seljord": "Telemark",
  // "Bø" is ambiguous: there's Bø in Telemark AND Bø in Nordland (Vesterålen).
  // Pick Telemark (the larger; Bø i Telemark, ~5800 inhabitants vs Bø i
  // Nordland ~2500). Callers needing disambiguation can pass the full
  // "Bø i Nordland" string instead. Documented in PR-64.
  "Bø": "Telemark",
  "Bø i Telemark": "Telemark",
  "Bø i Nordland": "Nordland",

  // Agder (Aust-Agder + Vest-Agder merged)
  "Kristiansand": "Agder",
  "Arendal": "Agder",
  "Grimstad": "Agder",
  "Mandal": "Agder",
  "Lyngdal": "Agder",
  "Flekkefjord": "Agder",
  "Risør": "Agder",
  "Tvedestrand": "Agder",
  "Lillesand": "Agder",
  "Farsund": "Agder",
  "Setesdal": "Agder",
  "Valle": "Agder",
  "Bygland": "Agder",

  // Rogaland
  "Stavanger": "Rogaland",
  "Sandnes": "Rogaland",
  "Haugesund": "Rogaland",
  "Egersund": "Rogaland",
  "Bryne": "Rogaland",
  "Jæren": "Rogaland",
  "Sola": "Rogaland",
  "Randaberg": "Rogaland",
  "Klepp": "Rogaland",
  "Hå": "Rogaland",
  "Time": "Rogaland",

  // Vestland (Hordaland + Sogn og Fjordane merged)
  "Bergen": "Vestland",
  "Voss": "Vestland",
  "Sogndal": "Vestland",
  "Stryn": "Vestland",
  "Førde": "Vestland",
  "Florø": "Vestland",
  "Odda": "Vestland",
  "Leikanger": "Vestland",
  "Lærdal": "Vestland",
  "Aurland": "Vestland",
  "Flåm": "Vestland",
  "Balestrand": "Vestland",
  "Loen": "Vestland",
  "Olden": "Vestland",
  "Kvinnherad": "Vestland",
  "Os": "Vestland",
  "Askøy": "Vestland",
  "Sotra": "Vestland",
  "Lindås": "Vestland",
  "Hardanger": "Vestland",
  "Ulvik": "Vestland",
  "Jondal": "Vestland",
  "Eidfjord": "Vestland",

  // Møre og Romsdal
  "Ålesund": "Møre og Romsdal",
  "Molde": "Møre og Romsdal",
  "Kristiansund": "Møre og Romsdal",
  "Volda": "Møre og Romsdal",
  "Ørsta": "Møre og Romsdal",
  "Surnadal": "Møre og Romsdal",
  "Geiranger": "Møre og Romsdal",
  "Stranda": "Møre og Romsdal",
  "Sykkylven": "Møre og Romsdal",
  "Sunnmøre": "Møre og Romsdal",
  "Nordmøre": "Møre og Romsdal",
  "Romsdal": "Møre og Romsdal",

  // Trøndelag (Sør- + Nord-Trøndelag merged)
  "Trondheim": "Trøndelag",
  "Steinkjer": "Trøndelag",
  "Levanger": "Trøndelag",
  "Verdal": "Trøndelag",
  "Stjørdal": "Trøndelag",
  "Røros": "Trøndelag",
  "Namsos": "Trøndelag",
  "Orkdal": "Trøndelag",
  "Melhus": "Trøndelag",
  "Inderøy": "Trøndelag",
  "Oppdal": "Trøndelag",
  "Rennebu": "Trøndelag",
  "Selbu": "Trøndelag",
  "Frosta": "Trøndelag",

  // Nordland
  "Bodø": "Nordland",
  "Mo i Rana": "Nordland",
  "Narvik": "Nordland",
  "Mosjøen": "Nordland",
  "Sortland": "Nordland",
  "Svolvær": "Nordland",
  "Leknes": "Nordland",
  "Vesterålen": "Nordland",
  "Lofoten": "Nordland",
  "Reine": "Nordland",
  "Henningsvær": "Nordland",
  "Brønnøysund": "Nordland",

  // Troms (post-2024)
  "Tromsø": "Troms",
  "Harstad": "Troms",
  "Finnsnes": "Troms",
  "Bardufoss": "Troms",
  "Skjervøy": "Troms",
  "Storslett": "Troms",
  "Lyngseidet": "Troms",

  // Finnmark (post-2024)
  "Alta": "Finnmark",
  "Hammerfest": "Finnmark",
  "Vadsø": "Finnmark",
  "Kirkenes": "Finnmark",
  "Honningsvåg": "Finnmark",
  "Karasjok": "Finnmark",
  "Kautokeino": "Finnmark",
  "Lakselv": "Finnmark",
  "Båtsfjord": "Finnmark",
};

// Build a key-normalised lookup once for O(1) cityToFylke().
const CITY_KEY_TO_FYLKE = new Map<string, string>();
for (const [city, fylke] of Object.entries(CITY_TO_FYLKE_RAW)) {
  CITY_KEY_TO_FYLKE.set(key(city), fylke);
}

export function cityToFylke(city: string | null | undefined): string | null {
  if (!city) return null;
  const k = key(city);
  if (!k) return null;
  return CITY_KEY_TO_FYLKE.get(k) ?? null;
}

// ─── normaliseFylke ────────────────────────────────────────────
// Take a free-form fylke string (any spelling, case, old/new name) and
// return the canonical 2024 form. Returns null when input is empty or
// unrecognised.
//
// Resolution order:
//   1. Exact match against the 15 canonical fylker (key-normalised).
//   2. Alias map redirect (old → new). For merged fylker that have been
//      split again (Viken/Vestfold og Telemark/Troms og Finnmark) we
//      return the broader merged name — fylkerMatch() handles the
//      equivalence-class resolution.
//   3. null.
export function normaliseFylke(s: string | null | undefined): string | null {
  if (!s) return null;
  const k = key(s);
  if (!k) return null;
  // Direct hit on canonical name.
  const direct = CANONICAL_BY_KEY.get(k);
  if (direct) return direct;
  // Alias redirect.
  if (ALIAS_TO_CANONICAL[k]) return ALIAS_TO_CANONICAL[k];
  // Try plain-form alias map (with spaces).
  const withSpaces = s
    .normalize("NFC")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (ALIAS_TO_CANONICAL[withSpaces]) return ALIAS_TO_CANONICAL[withSpaces];
  // Comma/whitespace-separated forms like "Lyngdal, Agder" or
  // "Lyngdal Agder" — try each token (and 2-3 token spans) as a fylke
  // OR as a kommune (cityToFylke). Returns the first hit.
  const parts = s
    .split(/[,;/]/)
    .map(p => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    const pk = key(part);
    if (!pk) continue;
    const directPart = CANONICAL_BY_KEY.get(pk);
    if (directPart) return directPart;
    if (ALIAS_TO_CANONICAL[pk]) return ALIAS_TO_CANONICAL[pk];
    const fromCity = CITY_KEY_TO_FYLKE.get(pk);
    if (fromCity) return fromCity;
  }
  // Final fallback: any whitespace-token of the original string that
  // resolves as a fylke or kommune.
  const tokens = s.split(/\s+/).map(t => t.trim()).filter(Boolean);
  for (const t of tokens) {
    const tk = key(t);
    if (!tk) continue;
    const direct2 = CANONICAL_BY_KEY.get(tk);
    if (direct2) return direct2;
    if (ALIAS_TO_CANONICAL[tk]) return ALIAS_TO_CANONICAL[tk];
    const fromCity2 = CITY_KEY_TO_FYLKE.get(tk);
    if (fromCity2) return fromCity2;
  }
  return null;
}

// ─── fylkerMatch ───────────────────────────────────────────────
// Returns true when two fylke strings refer to the same fylke OR fall
// in the same equivalence class (old↔new aliases, Viken ↔ Akershus,
// etc). Either input null/unknown → false (caller must treat as
// "location unknown" via a separate check).
//
// Semantics:
//   fylkerMatch("Vestland", "Hordaland")          → true   (alias)
//   fylkerMatch("Akershus", "Viken")              → true   (eq class)
//   fylkerMatch("Akershus", "Buskerud")           → true   (eq class — Viken siblings)
//   fylkerMatch("Vestland", "Trøndelag")          → false
//   fylkerMatch("Vestland", null)                 → false
//   fylkerMatch(null, "Vestland")                 → false
export function fylkerMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return false;
  const ka = key(a);
  const kb = key(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // Try canonical-form comparison.
  const na = normaliseFylke(a);
  const nb = normaliseFylke(b);
  if (na && nb && key(na) === key(nb)) return true;
  // Equivalence-class membership: each input may match by raw key or by
  // its normalised form.
  for (const cls of CLASS_KEYS) {
    const aInClass = cls.has(ka) || (na ? cls.has(key(na)) : false);
    const bInClass = cls.has(kb) || (nb ? cls.has(key(nb)) : false);
    if (aInClass && bInClass) return true;
  }
  return false;
}

// ─── fylkeEquivalents ──────────────────────────────────────────
// Display-cased names for the historical alias-map entries that don't
// have a reverse split in EQUIVALENCE_CLASSES (Vestland / Innlandet /
// Agder / Trøndelag — see the "still merged" fylker in the top-of-file
// doc comment: "Hordaland + Sogn og Fjordane", "Hedmark + Oppland",
// "Aust-Agder + Vest-Agder", "Sør-Trøndelag + Nord-Trøndelag"). The
// ALIAS_TO_CANONICAL keys themselves are lossy (lowercased, diacritics
// transliterated, spaces sometimes stripped) so they can't be used
// directly as DB-literal strings — this restores the proper casing for
// exactly the entries ALIAS_TO_CANONICAL already carries.
const ALIAS_DISPLAY: Record<string, string> = {
  "sortrondelag": "Sør-Trøndelag",
  "sor trondelag": "Sør-Trøndelag",
  "nordtrondelag": "Nord-Trøndelag",
  "nord trondelag": "Nord-Trøndelag",
  "hordaland": "Hordaland",
  "sognogfjordane": "Sogn og Fjordane",
  "sogn og fjordane": "Sogn og Fjordane",
  "sognfjordane": "Sogn og Fjordane",
  "hedmark": "Hedmark",
  "oppland": "Oppland",
  "austagder": "Aust-Agder",
  "aust agder": "Aust-Agder",
  "vestagder": "Vest-Agder",
  "vest agder": "Vest-Agder",
};

// Given any fylke string (any era/spelling), return the de-duplicated
// set of ALL fylke-name variants (as they might literally appear in the
// DB `fylke` column) that should be treated as "the same place" — for
// driving a SQL `IN (...)` clause. Restricted to strings that actually
// occur in this module's own data (CANONICAL_FYLKER, the
// ALIAS_TO_CANONICAL keys/values, and EQUIVALENCE_CLASSES entries) —
// not an open-ended fuzzy set.
//
// This is a DIFFERENT (asymmetric) relation from fylkerMatch()'s
// permissive sibling-matching:
//   - Input is a narrow, post-2024 part of a since-re-split merged
//     fylke (e.g. "Troms", "Akershus", "Vestfold") → returns itself +
//     the broader historical merged name it used to be filed under
//     (so pre-split DB rows still match), but NOT sibling split-parts
//     (a "Troms" query should not also match "Finnmark" rows).
//   - Input IS the broader merged name itself (e.g. "Viken", "Troms og
//     Finnmark", "Vestland") → returns itself + every historical
//     constituent part (a caller asking for the merged/broad name means
//     "any of these").
//
// Examples:
//   fylkeEquivalents("Troms")              → ["Troms", "Troms og Finnmark"]
//   fylkeEquivalents("Troms og Finnmark")  → ["Troms og Finnmark", "Troms", "Finnmark"]
//   fylkeEquivalents("Viken")               → ["Viken", "Akershus", "Buskerud", "Østfold"]
//   fylkeEquivalents("Vestland")            → ["Vestland", "Hordaland", "Sogn og Fjordane"]
//   fylkeEquivalents("garbage")             → ["garbage"]  (unrecognised: literal match only)
export function fylkeEquivalents(fylke: string | null | undefined): string[] {
  if (!fylke) return [];
  const canonical = normaliseFylke(fylke);
  if (!canonical) return [fylke];

  const result = new Set<string>([canonical]);
  const ck = key(canonical);

  // Equivalence-class handling: if canonical IS the merged/broad name
  // (class[0] by this module's convention), every constituent belongs;
  // if canonical is one of the split parts, add back only the merged
  // name (not sibling parts).
  let matchedClass = false;
  for (const cls of EQUIVALENCE_CLASSES) {
    const idx = cls.findIndex((s) => key(s) === ck);
    if (idx === -1) continue;
    matchedClass = true;
    if (idx === 0) {
      for (const s of cls) result.add(s);
    } else {
      result.add(cls[0]);
    }
    break;
  }

  if (!matchedClass) {
    // "Still merged" fylker (Vestland / Innlandet / Agder / Trøndelag):
    // add the display form of every old half on record in ALIAS_TO_CANONICAL.
    for (const [aliasKey, canon] of Object.entries(ALIAS_TO_CANONICAL)) {
      if (canon !== canonical) continue;
      const displayed = ALIAS_DISPLAY[aliasKey];
      if (displayed) result.add(displayed);
    }
  }

  return Array.from(result);
}

// ─── non-kommune region/valley/district labels ─────────────────
// CITY_TO_FYLKE_RAW is a "place name → fylke" lookup (its own doc comment
// says "city/municipality"), but a handful of its entries are traditional
// geographic districts spanning MULTIPLE real kommuner, not a kommune in
// their own right — they exist in the map only so a caller can still
// resolve the fylke for a well-known district name. Treating one of these
// as if it were a literal DB `kommune` column value is wrong: no
// experience row has e.g. `kommune = "Romsdal"`, so a caller that mistakes
// one for a kommune gets a confident but empty (0-row) result — the exact
// bug class this module exists to prevent, just relocated. Some of these
// also substring-collide with a full fylke name ("Romsdal" ⊂ "Møre og
// Romsdal"), which is how this was first caught (dev-request
// 2026-07-04-opplevagent-nl-parser-og-fylkesnormalisering item 1, PR #146
// review). Exported so callers doing kommune-vs-fylke disambiguation
// (see parseExperiencesIntent in experiences-a2a.ts) can exclude these
// from "is this a specific kommune" detection while still using
// cityToFylke()/CITY_TO_FYLKE_RAW normally for fylke resolution.
export const NON_KOMMUNE_REGION_LABELS: ReadonlySet<string> = new Set([
  "Hallingdal",   // Buskerud — spans Flå/Nes/Gol/Hemsedal/Ål/Hol
  "Jæren",        // Rogaland — spans Sandnes/Klepp/Time/Hå/Gjesdal etc.
  "Setesdal",     // Agder — spans Bygland/Valle/Bykle/Evje og Hornnes
  "Sunnmøre",     // Møre og Romsdal — spans Ålesund/Volda/Ørsta/Sykkylven etc.
  "Nordmøre",     // Møre og Romsdal — spans Kristiansund/Surnadal etc.
  "Romsdal",      // Møre og Romsdal — spans Molde/Rauma etc.; substring-collides with the fylke name itself
  "Vesterålen",   // Nordland — spans Sortland/Andøy/Øksnes/Bø/Hadsel
  "Lofoten",      // Nordland — spans Vågan/Vestvågøy/Flakstad/Moskenes/Røst/Værøy
  "Hardanger",    // Vestland — spans Odda/Ulvik/Jondal/Eidfjord/Kvinnherad etc.
]);

// Exported for tests + admin-UI sanity checks.
export const __FYLKE_INTERNAL = {
  CANONICAL_FYLKER,
  CITY_TO_FYLKE_RAW,
};
