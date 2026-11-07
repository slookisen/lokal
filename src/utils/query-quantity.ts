/**
 * A2A dev-request 2026-11-06-rfb-sok-mengde-flerord-og-treffvisning, slice A:
 * a quantity in a food search is not a product word. «biff 1kg» searched the
 * product names for «1kg» too, so lokal_search put the honey producer with
 * «Honning 1kg» in a product name on the page, «1kg» alone gave only that
 * producer, and lokal_find_offers looked for the whole text «biff 1kg» as one
 * phrase and found nothing (live 2026-11-06).
 *
 * splitQueryQuantity() takes the quantities out of a search text before it is
 * split into words: once split, «0,5kg» becomes «0» and «5kg», and «5kg» is
 * a word the parser looks up. A quantity is a number (with «,» or «.»
 * decimals, or a fraction «1/2»), optionally after a count and «x»
 * («2 x 500 g»), then a unit, with or without a space: «1kg», «1 kg»,
 * «1000g», «0,5 kg», «0.5kg», «500 g», «2 stk», «2stk», «1 l», «3 dl».
 * The unit must end the word, so «5 gårder» and «2 lam» hold no quantity.
 *
 * The quantity is only removed from the search. It never changes which
 * products match or their order, and it is never the quantity of a cart line.
 * Product names are not touched: «Honning 1kg» still matches «honning».
 *
 * Pure: no DB, no imports.
 */

/** The units a quantity may carry, longest first so «kg» is not read as «k» + «g». */
const UNITS = [
  "kilogram", "kilos", "kilo", "kg", "hg", "grams", "gram", "gr", "g",
  "liters", "litres", "liter", "litre", "dl", "cl", "ml", "l",
  "stykker", "stykk", "stk", "pieces", "pcs",
];

const NUMBER = String.raw`\d+(?:[.,/]\d+)?`;

/** A quantity, not inside a word: «1kg», «0,5 kg», «2 x 500 g», «2stk». */
const QUANTITY = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:\d+\s*[x×]\s*)?${NUMBER}\s*(?:${UNITS.join("|")})(?![\p{L}\p{N}])`,
  "giu",
);

const HAS_WORD = /[\p{L}\p{N}]/u;
const EDGE_JUNK = /^[\s,;:.\-–—+&/]+|[\s,;:\-–—+&/]+$/gu;

export interface QueryQuantity {
  /** The text with the quantities taken out (spaces collapsed, edge separators trimmed); "" when no word is left. */
  product: string;
  /** The quantities found, as written, in text order. */
  quantities: string[];
}

/** Splits a search text into the product text and its quantities (see the module comment). */
export function splitQueryQuantity(text: string): QueryQuantity {
  const raw = String(text ?? "");
  const quantities: string[] = [];
  const rest = raw.replace(QUANTITY, (m) => { quantities.push(m.trim()); return " "; });
  if (quantities.length === 0) return { product: raw.trim(), quantities };
  const product = rest.replace(/\s+/g, " ").replace(EDGE_JUNK, "").trim();
  return { product: HAS_WORD.test(product) ? product : "", quantities };
}

/** True when `text` holds a quantity and nothing else («1kg», «500 g»): there is no product to search for. */
export function isQuantityOnly(text: string): boolean {
  const { product, quantities } = splitQueryQuantity(text);
  return quantities.length > 0 && product === "";
}
