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

// ─── expandFylkeAliases ────────────────────────────────────────
// Given a free-form fylke query value, return every fylke spelling that
// should be treated as a match for it in a DB `WHERE fylke IN (...)`
// query. This is the SQL-facing counterpart to fylkerMatch(): instead of
// comparing two values, it expands ONE value into the full candidate set.
//
// Used to fix the dev-request 2026-07-04-opplevagent-nl-parser-og-fylkesnormalisering
// item-1 bug: the live experiences DB stores the pre-2024 merged names
// ("Troms og Finnmark", "Vestfold og Telemark", possibly "Viken") for rows
// harvested/seeded before the 2024 fylke split, while callers (NL parser,
// REST query params, MCP args) send the modern split names ("Troms",
// "Finnmark", "Vestfold", "Telemark", "Akershus", "Buskerud", "Østfold").
// An exact `fylke = @fylke` match therefore silently returns 0 rows.
//
// Resolution:
//   1. Always include the raw input verbatim (so an exact DB match still
//      works even for fylker with no aliasing, e.g. "Oslo").
//   2. Include the canonical (2024) form, if resolvable.
//   3. If the raw input OR its canonical form belongs to one of the
//      old-merger equivalence classes (Viken / Vestfold og Telemark /
//      Troms og Finnmark), include every member of that class — this is
//      what makes fylke=Troms also match rows stored as "Troms og
//      Finnmark", and vice versa.
//
// NOTE: this reuses fylkerMatch()'s equivalence-class semantics, which are
// intentionally permissive about SIBLINGS within a merged-fylke class (e.g.
// querying fylke=Akershus will also match rows tagged "Buskerud" or
// "Østfold", not just "Viken") — same trade-off already accepted for
// hanen-scraper matching. Documented here so it's a visible, reviewed
// choice rather than a surprise.
export function expandFylkeAliases(fylke: string | null | undefined): string[] {
  if (!fylke) return [];
  const out = new Set<string>([fylke]);
  const canonical = normaliseFylke(fylke);
  if (canonical) out.add(canonical);
  const k = key(fylke);
  const kCanon = canonical ? key(canonical) : null;
  EQUIVALENCE_CLASSES.forEach((cls, i) => {
    const keys = CLASS_KEYS[i];
    if (keys.has(k) || (kCanon !== null && keys.has(kCanon))) {
      for (const member of cls) out.add(member);
    }
  });
  return Array.from(out);
}

// Exported for tests + admin-UI sanity checks.
export const __FYLKE_INTERNAL = {
  CANONICAL_FYLKER,
  CITY_TO_FYLKE_RAW,
};
