// ─── postcode-fylke — WO-24 ────────────────────────────────────────────────
//
// Pure-function module that maps a Norwegian postcode (4-digit string) to its
// fylke (county) using the post-2024 fylke reorganization.
//
// Used by the verifier to detect data-quality bugs of the form
// "addressLocality city is in a different fylke than the postcode implies"
// (e.g. addressLocality=Mandal but postalCode=6817 which is Naustdal/Vestland).
//
// The lookup table covers the full 0001-9999 numeric range with broad ranges
// that match Posten's official postcode→fylke mapping. It is not exhaustive
// to the postnummer level — for unknown prefixes the function returns null
// rather than guessing.
//
// Reference: WO-24 quality probe report (2026-05-09).

// ─── Range table ────────────────────────────────────────────────────────────
//
// Each entry: [start, end, fylke]. Ranges are inclusive on both ends and
// non-overlapping. A postcode falls in the first range it matches.
//
// Post-2024 fylker (15): Oslo, Akershus, Østfold, Buskerud, Vestfold, Telemark,
// Innlandet, Agder, Rogaland, Vestland, Møre og Romsdal, Trøndelag, Nordland,
// Troms, Finnmark.

type Range = readonly [start: number, end: number, fylke: string];

const RANGES: readonly Range[] = [
  // Oslo: 0001-1295
  [1, 1295, "Oslo"],

  // Akershus: 1300-1599 (Bærum, Lørenskog etc.)
  [1300, 1599, "Akershus"],

  // 1600-1999: historically Østfold; many of these are now Akershus after
  // Viken split back. 1940 = Bjørkelangen which is in Akershus.
  // 1600-1789 = Østfold (Fredrikstad, Sarpsborg, Halden), 1790-1999 = Akershus.
  [1600, 1789, "Østfold"],
  [1790, 1999, "Akershus"],

  // 2000-2099: Lillestrøm/Skedsmo area = Akershus
  [2000, 2099, "Akershus"],

  // 2100-2999: Innlandet (Hedmark + Oppland merged)
  [2100, 2999, "Innlandet"],

  // 3000-3999: Buskerud / Vestfold / Telemark
  // Coarse split:
  //   3000-3699 = Buskerud (Drammen, Hokksund, Kongsberg, Hønefoss)
  //   3700-3899 = Telemark (Skien, Porsgrunn, Notodden, Bø)
  //   3900-3999 = Vestfold (Larvik, Stavern)
  // Sufficient for the bug class WO-24 catches (cross-fylke mismatches).
  [3000, 3699, "Buskerud"],
  [3700, 3899, "Telemark"],
  [3900, 3999, "Vestfold"],

  // 4000-4999: Rogaland (north) + Agder (south)
  //   4000-4099 = Rogaland (Stavanger)
  //   4100-4399 = Rogaland (Jæren, Sandnes)
  //   4400-4999 = Agder (Flekkefjord, Mandal, Kristiansand, Arendal)
  [4000, 4399, "Rogaland"],
  [4400, 4999, "Agder"],

  // 5000-5999: Vestland (Bergen + western Vestland)
  [5000, 5999, "Vestland"],

  // 6000-6999: Møre og Romsdal + Vestland-Sunnfjord
  //   6000-6699 = Møre og Romsdal (Ålesund, Molde, Kristiansund)
  //   6700-6999 = Vestland (Sunnfjord, Florø, Naustdal, Førde)
  [6000, 6699, "Møre og Romsdal"],
  [6700, 6999, "Vestland"],

  // 7000-7999: Trøndelag (Trondheim + Nord-Trøndelag merged)
  [7000, 7999, "Trøndelag"],

  // 8000-8999: Nordland (Bodø, Mo i Rana, Lofoten)
  [8000, 8999, "Nordland"],

  // 9000-9499 = Troms (Tromsø, Harstad, Finnsnes)
  // 9500-9999 = Finnmark (Alta, Hammerfest, Kirkenes, Vadsø)
  [9000, 9499, "Troms"],
  [9500, 9999, "Finnmark"],
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Given a 4-digit Norwegian postcode (with or without leading zeros), return
 * the fylke (county) it belongs to, or null if the postcode is invalid or
 * we don't have a confident mapping for it.
 *
 * Examples:
 *   fylkeForPostcode("4513") → "Agder"      (Mandal)
 *   fylkeForPostcode("6817") → "Vestland"   (Naustdal)
 *   fylkeForPostcode("1940") → "Akershus"   (Bjørkelangen)
 *   fylkeForPostcode("0287") → "Oslo"
 *   fylkeForPostcode("xxxx") → null
 */
export function fylkeForPostcode(postcode: string | null | undefined): string | null {
  if (!postcode) return null;
  const trimmed = String(postcode).trim();
  if (!/^\d{4}$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return null;
  for (const [start, end, fylke] of RANGES) {
    if (n >= start && n <= end) return fylke;
  }
  return null;
}

// ─── City → fylke (coarse) ──────────────────────────────────────────────────
//
// We don't have a full city→fylke table, but we can map the major cities that
// appear in our outreach pool. For unknown cities we return null, which the
// caller treats as "unknown — don't flag" (conservative: only flag positively
// known mismatches).
//
// This list is intentionally small and curated. New entries should be added
// when a city appears repeatedly in agent_knowledge.

const CITY_FYLKE: Record<string, string> = {
  // Oslo
  oslo: "Oslo",

  // Akershus
  bærum: "Akershus",
  baerum: "Akershus",
  sandvika: "Akershus",
  asker: "Akershus",
  lillestrøm: "Akershus",
  lillestrom: "Akershus",
  lørenskog: "Akershus",
  lorenskog: "Akershus",
  skedsmokorset: "Akershus",
  bjørkelangen: "Akershus",
  bjorkelangen: "Akershus",
  ski: "Akershus",
  drøbak: "Akershus",
  drobak: "Akershus",
  jessheim: "Akershus",

  // Østfold
  fredrikstad: "Østfold",
  sarpsborg: "Østfold",
  moss: "Østfold",
  halden: "Østfold",
  askim: "Østfold",

  // Innlandet
  hamar: "Innlandet",
  lillehammer: "Innlandet",
  gjøvik: "Innlandet",
  gjovik: "Innlandet",
  elverum: "Innlandet",
  kongsvinger: "Innlandet",

  // Buskerud
  drammen: "Buskerud",
  hokksund: "Buskerud",
  kongsberg: "Buskerud",
  hønefoss: "Buskerud",
  honefoss: "Buskerud",
  ål: "Buskerud",
  geilo: "Buskerud",

  // Vestfold
  tønsberg: "Vestfold",
  tonsberg: "Vestfold",
  sandefjord: "Vestfold",
  larvik: "Vestfold",
  horten: "Vestfold",

  // Telemark
  skien: "Telemark",
  porsgrunn: "Telemark",
  notodden: "Telemark",
  bø: "Telemark",

  // Agder
  kristiansand: "Agder",
  arendal: "Agder",
  mandal: "Agder",
  grimstad: "Agder",
  flekkefjord: "Agder",
  lindesnes: "Agder",
  lyngdal: "Agder",
  farsund: "Agder",

  // Rogaland
  stavanger: "Rogaland",
  sandnes: "Rogaland",
  haugesund: "Rogaland",
  bryne: "Rogaland",
  egersund: "Rogaland",

  // Vestland
  bergen: "Vestland",
  voss: "Vestland",
  florø: "Vestland",
  floro: "Vestland",
  førde: "Vestland",
  forde: "Vestland",
  naustdal: "Vestland",
  sogndal: "Vestland",
  stord: "Vestland",
  odda: "Vestland",
  gulen: "Vestland",

  // Møre og Romsdal
  ålesund: "Møre og Romsdal",
  alesund: "Møre og Romsdal",
  molde: "Møre og Romsdal",
  kristiansund: "Møre og Romsdal",
  ulsteinvik: "Møre og Romsdal",
  volda: "Møre og Romsdal",
  ørsta: "Møre og Romsdal",

  // Trøndelag
  trondheim: "Trøndelag",
  steinkjer: "Trøndelag",
  levanger: "Trøndelag",
  stjørdal: "Trøndelag",
  stjordal: "Trøndelag",
  namsos: "Trøndelag",
  orkanger: "Trøndelag",

  // Nordland
  bodø: "Nordland",
  bodo: "Nordland",
  "mo i rana": "Nordland",
  narvik: "Nordland",
  svolvær: "Nordland",
  svolvaer: "Nordland",
  sandnessjøen: "Nordland",

  // Troms
  tromsø: "Troms",
  tromso: "Troms",
  harstad: "Troms",
  finnsnes: "Troms",

  // Finnmark
  alta: "Finnmark",
  hammerfest: "Finnmark",
  kirkenes: "Finnmark",
  vadsø: "Finnmark",
  vadso: "Finnmark",
};

/**
 * Returns the fylke for a known city name (case-insensitive). Returns null
 * for cities we don't recognize — caller should treat null as "unknown" and
 * not flag the address.
 */
export function fylkeForCity(city: string | null | undefined): string | null {
  if (!city) return null;
  const key = String(city).toLowerCase().trim();
  return CITY_FYLKE[key] ?? null;
}

/**
 * Returns true if (city, postcode) are in the same fylke, false if they
 * disagree, or null if either lookup is unknown (caller should not flag).
 */
export function cityIsInFylke(
  city: string | null | undefined,
  postcode: string | null | undefined
): boolean | null {
  const cityFylke = fylkeForCity(city);
  const postFylke = fylkeForPostcode(postcode);
  if (cityFylke === null || postFylke === null) return null;
  return cityFylke === postFylke;
}
