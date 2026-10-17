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
 *   honey of a beekeeper whose products are all compounds;
 * - a shorter term may end a word only when the caller knows the row is in
 *   the term's own category (`sameCategory`). A short word ends many words of
 *   other kinds: «egg» ends «Gårdsegg» (eggs) and «Pålegg» (meat), «ost»
 *   «Brunost» (dairy) and «Eplemost» (beverages), «bær» «Bringebær» (fruit)
 *   and «Honning med bringebær» (honey), «øl» «Juleøl» (beverages) and
 *   «Steinmalt rugmjøl» (bakery). Without the compounds «ost» found 44 of the
 *   87 dairy producers with «ost» in a product name in the live catalogue
 *   (2026-10-17). The category keeps most wrong heads out, not all: «te»
 *   still ends «Ekte sider» at a cidery;
 * - a term inside a word never counts.
 * A letter is any Unicode letter or digit, or «_», so «č», «š» or «ŋ» in a
 * Sámi name does not split a word; æ, ø and å are letters, as in
 * marketplace-registry.ts's norwegianWordBoundary.
 *
 * Pure: no DB, no imports, so the search side can share it.
 */

/** The shortest term that may end a word (a compound's head) whatever the row's category. */
export const COMPOUND_HEAD_MIN_LENGTH = 4;

/**
 * How well a term matches a product name; the higher the better, 0 for no
 * match. Of several occurrences, the best counts.
 * - 3: a whole word («egg» in «Frittgående egg», «Egg»);
 * - 2: the head of a compound («honning» in «Lynghonning», and «egg» in
 *   «Gårdsegg» when `sameCategory`);
 * - 1: the start of a word («egg» in «Eggekartong», «honning» in «Honningkake»).
 */
export type ProductNameMatch = 0 | 1 | 2 | 3;

const LETTER = /[\p{L}\p{N}_]/u;

export function productNameMatch(name: string, term: string, sameCategory = false): ProductNameMatch {
  const n = name.toLowerCase();
  const t = term.trim().toLowerCase();
  if (!t) return 0;
  const headOk = sameCategory || t.length >= COMPOUND_HEAD_MIN_LENGTH;
  let best: ProductNameMatch = 0;
  for (let i = n.indexOf(t); i >= 0 && best < 3; i = n.indexOf(t, i + 1)) {
    const startsWord = !LETTER.test(n.charAt(i - 1));
    const endsWord = !LETTER.test(n.charAt(i + t.length));
    const match: ProductNameMatch = startsWord && endsWord ? 3
      : endsWord && headOk ? 2
      : startsWord ? 1 : 0;
    if (match > best) best = match;
  }
  return best;
}
