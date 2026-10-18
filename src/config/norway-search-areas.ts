// ─── Landsdeler and byområder for free-text place search ───────────────────
//
// dev-request 2026-10-17-dental-d3-rettelser, slice D3f (Daniel's yes to
// question 9, 2026-10-18: «Ja, sammen med regionordene, men også byer»). A
// search text that names a part of the country («tannlege på Vestlandet»,
// «Nord-Norge») or a city area («Osloområdet», «Tromsøya») is read as the
// fylker or kommuner listed here. Before, these words found nothing in MCP
// tannlege_search and /sok, and A2A found them only by accident (its keyword
// reading took «vestland» inside «Vestlandet» as the fylke).
//
// Data only. buildNorwegianGazetteer() (services/search-intent/
// norwegian-query.ts) takes this table as its second argument, and the dental
// gazetteer (services/dental-search-gazetteer.ts) passes it, so MCP, A2A and
// /sok, which parse with that one gazetteer, read the same words alike. The
// RFB gazetteer is built without it and is unchanged.
//
// A name is matched like every other place in the gazetteer: by placeKey()
// over one run of whole words, so case, hyphen and space make no difference
// («Nord-Norge», «Nord Norge», «nordnorge»), and the ASCII spelling of a name
// of four or more letters is read too («Ostlandet», «Tromsoya»). A
// preposition before it («på Vestlandet») is a stopword. A real poststed,
// kommune, region or fylke with the same key wins over an entry here, so no
// place that was read before D3f is read differently (checked in tests).

/** A landsdel or a byområde: its names and the places it covers. */
export interface SearchArea {
  /** The name tolkning shows («Vestlandet», «Osloområdet»). */
  name: string;
  /** Other names for the same area. A spelling that placeKey() folds into `name` needs no entry. */
  aliases: readonly string[];
  /**
   * A landsdel: its fylker (canonical 2024 names, each read as fylke X
   * reads). A byområde: its kommuner (2024 names), the city first, each read
   * as the kommune's name alone reads.
   */
  places: readonly string[];
  /** Where the definition comes from. */
  source: string;
}

export interface NorwegianSearchAreas {
  /** Parts of the country, each read as several fylker. */
  landsdeler: readonly SearchArea[];
  /** City areas, each read as one or more kommuner. */
  byomrader: readonly SearchArea[];
}

export const NORWEGIAN_SEARCH_AREAS: NorwegianSearchAreas = {
  // The same five landsdeler and fylker as Opplevagent's LANDSDEL_TO_FYLKER
  // and LANDSDEL_ALIASES (services/experiences-query-intent.ts), which stay
  // where they are while Opplevagent is frozen (a test keeps the two equal).
  // Names whose extent people disagree on («Sør-Norge», «Southern Norway»)
  // are left out there and here: a missing name costs a search word, a wrong
  // one gives a wrong place.
  landsdeler: [
    {
      name: "Vestlandet",
      aliases: ["Western Norway", "West Norway", "Fjord Norway"],
      places: ["Rogaland", "Vestland", "Møre og Romsdal"],
      source: "Store norske leksikon, «Vestlandet»: landsdelen som består av fylkene Rogaland, Vestland og Møre og Romsdal",
    },
    {
      name: "Sørlandet",
      aliases: [],
      places: ["Agder"],
      source: "Store norske leksikon, «Sørlandet»: svarer til Agder fylke",
    },
    {
      name: "Østlandet",
      aliases: ["Austlandet", "Eastern Norway", "East Norway"],
      places: ["Oslo", "Akershus", "Østfold", "Buskerud", "Innlandet", "Vestfold", "Telemark"],
      source: "Store norske leksikon, «Østlandet»: fylkene Akershus, Buskerud, Innlandet, Oslo, Telemark, Vestfold og Østfold",
    },
    {
      name: "Midt-Norge",
      aliases: ["Midt-Noreg", "Central Norway", "Mid-Norway"],
      places: ["Trøndelag", "Møre og Romsdal"],
      source: "Store norske leksikon, «Midt-Norge»: i offentlig forvaltning fylkene Trøndelag og Møre og Romsdal (Helse Midt-Norge, Statens vegvesen Region midt)",
    },
    {
      name: "Nord-Norge",
      aliases: ["Nord-Noreg", "Northern Norway", "North Norway"],
      places: ["Nordland", "Troms", "Finnmark"],
      source: "Store norske leksikon, «Nord-Norge»: fellesnavn for fylkene Nordland, Troms og Finnmark",
    },
  ],
  // Each city area is the kommuner of one official definition, named in
  // `source`. Oslo's byvekstavtale area is Oslo and the whole of Akershus,
  // too wide for «Osloområdet», so Oslo uses SSB's tettsted instead: the
  // kommuner with at least 1 % of its inhabitants (Lier has 0.2 %).
  byomrader: [
    {
      name: "Osloområdet",
      aliases: ["Stor-Oslo"],
      places: ["Oslo", "Bærum", "Asker", "Lillestrøm", "Lørenskog", "Nordre Follo", "Rælingen", "Nittedal"],
      source: "SSB, tettstedet Oslo (Store norske leksikon, «Oslo – tettsted», 2025): kommunene med minst 1 % av innbyggerne",
    },
    {
      name: "Bergensområdet",
      aliases: ["Bergenområdet", "Stor-Bergen"],
      places: ["Bergen", "Alver", "Askøy", "Bjørnafjorden", "Øygarden"],
      source: "Statens vegvesen, «Om byvekstavtaler»: byvekstavtalen for Bergensområdet (2019–2029)",
    },
    {
      name: "Stavangerregionen",
      aliases: ["Stavangerområdet", "Nord-Jæren", "Stor-Stavanger"],
      places: ["Stavanger", "Sandnes", "Sola", "Randaberg"],
      source: "Statens vegvesen, «Om byvekstavtaler»: byvekstavtalen for Nord-Jæren; det samme som SSBs tettsted Stavanger/Sandnes (Store norske leksikon, «Stavanger»)",
    },
    {
      name: "Trondheimsområdet",
      aliases: ["Trondheimområdet", "Stor-Trondheim"],
      places: ["Trondheim", "Melhus", "Malvik", "Skaun", "Orkland", "Stjørdal"],
      source: "Statens vegvesen, «Om byvekstavtaler»: byvekstavtalen for Trondheimsområdet (2023–2029)",
    },
    {
      name: "Tromsøya",
      aliases: [],
      places: ["Tromsø"],
      source: "Store norske leksikon, «Tromsø – tettsted»: tettstedet Tromsø er de tettbygde områdene på Tromsøya, i Tromsø kommune",
    },
  ],
};
