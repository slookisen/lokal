// ─── «i» or «på» before a Norwegian place name ──────────────────────────────
// dev-request 2026-10-17-integrasjonstest-oppfolging, SD-13.
//
// Measured live 2026-10-17: /fylke/Svalbard's visible FAQ asked «Hvor mange
// opplevelser finnes i Svalbard?», and the meta description and aria-label
// said «i Svalbard» too. Norwegian uses «på» before islands and
// archipelagos, so it is «på Svalbard», «på Hitra», «på Karmøy».
//
// The rule: «på» for the names below, «i» for every other place. The list is
// the island and archipelago names, among fylker and kommuner, where «på» is
// the settled usage. Kommuner made up of several islands where «i» is the
// usual form (Herøy, Giske, Lurøy, Austevoll, Øygarden) and region names
// that take «i» (Lofoten, Vesterålen) are left out. Inland places that also
// take «på» (Lillehammer, Voss, Røros) are out of scope: they are not
// islands, and «i» is still understood there.

const PAA_PLACES: ReadonlySet<string> = new Set(
  [
    "Askøy", "Averøy", "Bokn", "Bømlo", "Dønna", "Fedje", "Frøya", "Hitra", "Hvaler",
    "Jan Mayen", "Karmøy", "Kvitsøy", "Leka", "Røst", "Senja", "Skjervøy", "Smøla",
    "Stord", "Sula", "Svalbard", "Træna", "Tysnes", "Utsira", "Vega", "Vestvågøy", "Værøy",
  ].map((name) => name.toLocaleLowerCase("nb")),
);

/** «på» for an island or archipelago name in the list above, else «i».
 *  Matched on the trimmed name, ignoring case. */
export function placePreposition(name: string): "i" | "på" {
  return PAA_PLACES.has(name.trim().toLocaleLowerCase("nb")) ? "på" : "i";
}

/** The place name with its preposition: «i Bergen», «på Svalbard». */
export function inPlace(name: string): string {
  return `${placePreposition(name)} ${name}`;
}
