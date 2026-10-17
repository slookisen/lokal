/**
 * Integration test 2026-10-17, slice I-V: how a search term matches a product
 * name in the offers (services/catalog-offers.ts findOffers: lokal_find_offers,
 * GET /api/marketplace/catalog/offers and the shopping list page). The name
 * only had to contain the term (LIKE '%term%'), so «egg» found «Kjøttpålegg»
 * and «Pålegg», and «øl» and «is» found only wrong products («Pølser», «Fisk»).
 *
 * The rule:
 * - the term starts a word of the name: «egg» finds «Egg», «Eggekartong» and
 *   «Frittgående egg», not «Pålegg»;
 * - a term of at least COMPOUND_HEAD_MIN_LENGTH letters may also end a word.
 *   A Norwegian compound names its kind last, so «Lynghonning» is honey and
 *   «Lammekjøtt» meat; without this «honning» would no longer find the
 *   honey of a beekeeper whose products are all compounds. A shorter term
 *   only counts at the start of a word: «egg» ends «pålegg» and «lammelegg»,
 *   «is» ends «ris» and «pris»;
 * - a term inside a word never counts.
 * Letters are those of marketplace-registry.ts's norwegianWordBoundary in lower
 * case, the class routes/mcp.ts categoryLabelWordsOf splits on: a-z, æ, ø, å
 * and the other Latin-1 letters, digits and «_».
 *
 * Pure: no DB, no imports, so the search side can share it.
 */

/** The shortest term that may match at the end of a word (a compound's head). */
export const COMPOUND_HEAD_MIN_LENGTH = 4;

/**
 * How well a term matches a product name; the higher the better, 0 for no
 * match. Of several occurrences, the best counts.
 * - 3: a whole word («egg» in «Frittgående egg», «Egg»);
 * - 2: the head of a compound («honning» in «Lynghonning»);
 * - 1: the start of a word («egg» in «Eggekartong», «honning» in «Honningkake»).
 */
export type ProductNameMatch = 0 | 1 | 2 | 3;

const LETTER = /[0-9a-zà-öø-ÿ_]/;

export function productNameMatch(name: string, term: string): ProductNameMatch {
  const n = name.toLowerCase();
  const t = term.trim().toLowerCase();
  if (!t) return 0;
  let best: ProductNameMatch = 0;
  for (let i = n.indexOf(t); i >= 0 && best < 3; i = n.indexOf(t, i + 1)) {
    const startsWord = !LETTER.test(n.charAt(i - 1));
    const endsWord = !LETTER.test(n.charAt(i + t.length));
    const match: ProductNameMatch = startsWord && endsWord ? 3
      : endsWord && t.length >= COMPOUND_HEAD_MIN_LENGTH ? 2
      : startsWord ? 1 : 0;
    if (match > best) best = match;
  }
  return best;
}
