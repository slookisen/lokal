/**
 * outside-norway.ts — recognise a place the user named that is clearly not in
 * Norway, so the search tools can say "we only cover Norway" instead of
 * answering with Norwegian results.
 *
 * ChatGPT app re-review 2026-10-03: both submissions carry a negative test
 * case of this shape ("pizza restaurant in Rome", "safari lodge in Kenya")
 * whose expected outcome is that the app does NOT offer Norwegian results.
 * When the model called the tool anyway, "Rome" substring-matched the
 * producer Romeriksmat and "Kenya" was relaxed away into a nationwide list.
 *
 * Deliberately a short, curated list of countries and well-known cities —
 * not a gazetteer. Names that double as ordinary words ("turkey", "chile",
 * "island", "nice", "jordan") or as food names ("india" pale ale, "brussels"
 * sprouts, "roma" tomatoes, "milano" salami, pizza "napoli", "new york"
 * strip) are left out on purpose: a false positive here would refuse a real
 * Norwegian search, which is worse than the miss.
 */

const FOREIGN_PLACES: readonly string[] = [
  // Countries (English + Norwegian spellings)
  "kenya", "tanzania", "uganda", "south africa", "sør-afrika", "egypt", "morocco", "marokko",
  "italy", "italia", "france", "frankrike", "spain", "spania", "portugal", "germany", "tyskland",
  "greece", "hellas", "sweden", "sverige", "denmark", "danmark", "finland", "iceland",
  "united kingdom", "england", "scotland", "skottland", "ireland", "irland", "usa", "united states",
  "america", "amerika", "canada", "mexico", "brazil", "brasil", "argentina", "china", "kina",
  "japan", "thailand", "vietnam", "indonesia", "australia", "new zealand", "russia",
  "russland", "poland", "polen", "netherlands", "nederland", "belgium", "belgia", "switzerland",
  "sveits", "austria", "østerrike", "croatia", "kroatia",
  // Well-known cities
  "rome", "paris", "london", "berlin", "madrid", "barcelona", "lisbon", "lisboa", "venice",
  "venezia", "florence", "firenze", "amsterdam", "vienna", "wien", "prague", "praha", "budapest",
  "warsaw", "athens", "athen", "istanbul", "dubai",
  "cairo", "kairo", "nairobi", "zanzibar", "serengeti", "cape town", "los angeles",
  "san francisco", "chicago", "toronto", "tokyo", "beijing", "shanghai", "bangkok", "sydney",
  "stockholm", "gothenburg", "göteborg", "copenhagen", "københavn", "helsinki", "reykjavik",
  "edinburgh", "dublin", "munich", "münchen", "hamburg", "zurich", "zürich", "geneva", "genève",
];

const WORD_CHAR = "a-z0-9æøåäöüéèàáâêëïíóôúçñ";
const PATTERNS = FOREIGN_PLACES.map((name) => ({
  name,
  re: new RegExp(`(?:^|[^${WORD_CHAR}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^${WORD_CHAR}])`),
}));

/**
 * The first foreign place named in `text` (in its listed spelling), or null.
 * Matches whole words only, case-insensitively.
 */
export function foreignPlaceIn(text: string | null | undefined): string | null {
  const t = String(text ?? "").toLocaleLowerCase("nb-NO");
  if (!t.trim()) return null;
  for (const { name, re } of PATTERNS) {
    if (re.test(t)) return name;
  }
  return null;
}
