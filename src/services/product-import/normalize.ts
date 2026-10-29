// ─── Product import: price / unit / name normalisation (PURE) ───────────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 1.
// Everything here is pure string work — no network, no DB — so the
// extractor's tiers share one definition of "what a Norwegian price looks
// like" and the tests can pin it case by case.
//
//   "kr 250"  "250 kr"  "250,-"  "NOK 1 250"  "1.250,50 kr"  → 250 / 1250 / 1250.5
//   "fra 250" / "Fra kr 250,-"                                → price_is_from = true
//   "/kg" "pr kg" "per stk" "à pakke" "500 g" "1 l"            → unit kg|stk|pakke|l|g

export type ProductUnit = "kg" | "stk" | "pakke" | "l" | "g";

export const PRODUCT_IMPORT_MAX_PRODUCTS = 100;
/** Same bound as the existing name extractor's item length, a little wider. */
export const PRODUCT_IMPORT_MAX_NAME_LEN = 120;

const UNIT_ALIASES: Record<string, ProductUnit> = {
  kg: "kg",
  kilo: "kg",
  g: "g",
  gr: "g",
  gram: "g",
  l: "l",
  liter: "l",
  litre: "l",
  ltr: "l",
  stk: "stk",
  stykk: "stk",
  stykket: "stk",
  pakke: "pakke",
  pakken: "pakke",
  pk: "pakke",
  pkt: "pakke",
};

const UNIT_WORD = "(kg|kilo|gram|gr|g|liter|litre|ltr|l|stykket|stykk|stk|pakken|pakke|pkt|pk)";

/** Map a unit word to the canonical unit, or null. PURE. */
export function canonicalUnit(raw: string | null | undefined): ProductUnit | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase().replace(/\.$/, "");
  return UNIT_ALIASES[k] ?? null;
}

/**
 * The pricing unit stated in a price text: "/kg", "pr kg", "pr. stk",
 * "per pakke", "à 500 g", "kr/l". PURE. null when none is stated.
 */
export function detectPriceUnit(text: string | null | undefined): ProductUnit | null {
  if (!text) return null;
  const re = new RegExp(`(?:\\/|\\bpr\\.?\\s*|\\bper\\s+|\\bà\\s*)(?:\\d+(?:[.,]\\d+)?\\s*)?${UNIT_WORD}(?![a-zæøå])`, "i");
  const m = text.match(re);
  return m ? canonicalUnit(m[1]) : null;
}

/**
 * The unit of a size/variant label such as "1 kg", "500 g", "Stk", "Pakke".
 * PURE. Used for Shopify variant titles and similar structured labels; never
 * guesses from free product names.
 */
export function detectSizeUnit(label: string | null | undefined): ProductUnit | null {
  if (!label) return null;
  const re = new RegExp(`^\\s*(?:ca\\.?\\s*)?(?:\\d+(?:[.,]\\d+)?\\s*)?${UNIT_WORD}\\.?\\s*$`, "i");
  const m = label.match(re);
  return m ? canonicalUnit(m[1]) : (detectPriceUnit(label) ?? null);
}

/** Number tokens as written in Norwegian text: "1 250", "1.250,50", "89,50", "250". */
const NUMBER_TOKEN_RE = /(?<![\d.,])(\d{1,3}(?:[  .]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d])/g;

/**
 * Parse one Norwegian-formatted number token. PURE.
 *   "1 250" → 1250, "1.250" → 1250, "1.250,50" → 1250.5, "89,50" → 89.5,
 *   "89.5" → 89.5, "250" → 250. null when not a number.
 */
export function parseNorwegianNumber(token: string): number | null {
  let t = token.replace(/[\s ]/g, "");
  if (!t) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) {
    t = t.replace(/\./g, "").replace(",", ".");
  } else if (/^\d+,\d{1,2}$/.test(t)) {
    t = t.replace(",", ".");
  } else if (!/^\d+(\.\d{1,2})?$/.test(t)) {
    return null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** All number values written in a text (see NUMBER_TOKEN_RE). PURE. */
export function numbersInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_TOKEN_RE)) {
    const n = parseNorwegianNumber(m[1]!);
    if (n !== null) out.push(n);
  }
  return out;
}

export interface ParsedPrice {
  price_nok: number | null;
  price_is_from: boolean;
  unit: ProductUnit | null;
}

/**
 * Parse a free-text price: "kr 250", "250 kr", "250,-", "NOK 1 250",
 * "Fra kr 250,- pr kg". PURE.
 *
 * The number nearest a currency marker (kr / NOK / ,-) wins; without any
 * marker a text that is only a number ("250") is accepted, anything else
 * (e.g. "Ring for pris", "2 for 100" without kr) gives price_nok = null —
 * we drop a price rather than guess one. A non-NOK currency (EUR, $, €)
 * also gives null.
 */
export function parseNokPrice(text: string | null | undefined): ParsedPrice {
  const raw = (text ?? "").replace(/\s+/g, " ").trim();
  const result: ParsedPrice = {
    price_nok: null,
    price_is_from: /(^|[^a-zæøå])fra([^a-zæøå]|$)/i.test(raw),
    unit: detectPriceUnit(raw),
  };
  if (!raw) return result;
  if (/(€|\$|£|\beur\b|\busd\b|\bsek\b|\bdkk\b)/i.test(raw)) return result;

  const candidates: RegExp[] = [
    /(?:\bkr\.?|\bnok)\s*(\d{1,3}(?:[  .]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i,
    /(\d{1,3}(?:[  .]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:,-|kr\b|kr\.|nok\b|kroner\b)/i,
  ];
  for (const re of candidates) {
    const m = raw.match(re);
    if (m) {
      result.price_nok = parseNorwegianNumber(m[1]!);
      if (result.price_nok !== null) return result;
    }
  }
  // Bare number ("250", "fra 250", "250 /kg"): accept only when the text holds
  // exactly one number token and nothing that looks like another quantity.
  const stripped = raw.replace(/\bfra\b/i, "").trim();
  const nums = [...stripped.matchAll(NUMBER_TOKEN_RE)];
  if (nums.length === 1) {
    const rest = stripped.replace(nums[0]![0], "").trim();
    const restIsUnitOnly = rest === "" || detectPriceUnit(rest) !== null || /^[/\s]*$/.test(rest);
    if (restIsUnitOnly) result.price_nok = parseNorwegianNumber(nums[0]![1]!);
  }
  return result;
}

/** Machine price ("250.00", 250, "250") from a JSON API / JSON-LD. PURE. */
export function parseMachinePrice(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Round to øre. PURE. */
export function roundNok(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Trimmed, whitespace-collapsed product name, or null when unusable. PURE. */
export function normalizeProductName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.replace(/\s+/g, " ").trim();
  if (!n || n.length > PRODUCT_IMPORT_MAX_NAME_LEN) return null;
  return n;
}

/** Dedup key for product names. PURE. */
export function productNameKey(name: string): string {
  return name.toLocaleLowerCase("nb-NO").replace(/\s+/g, " ").trim();
}

/** Text form of a price for `price_text` when the source was structured. PURE. */
export function formatPriceText(price: number | null, currency: string | null, isFrom: boolean): string {
  if (price === null) return "";
  return `${isFrom ? "fra " : ""}${price} ${currency || "NOK"}`.trim();
}

// ─── Accuracy fixes (prod measurement 2026-10-29, 70.6 %) ───────────────────
// reports/2026-10-29-produktimport-maaling.md (A2A): pack weight read as a
// unit price, size variants without price_is_from. PURE helpers used by the
// LLM grounding and the candidate rules (./rules.ts).

/** Every number token in a text with its position (see NUMBER_TOKEN_RE). PURE. */
export function numberTokensInText(text: string): Array<{ value: number; index: number; length: number }> {
  const out: Array<{ value: number; index: number; length: number }> = [];
  for (const m of text.matchAll(NUMBER_TOKEN_RE)) {
    const n = parseNorwegianNumber(m[1]!);
    if (n !== null) out.push({ value: n, index: m.index!, length: m[0].length });
  }
  return out;
}

const NUM = "(\\d{1,3}(?:[  .]\\d{3})+(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";

/**
 * Every NOK price written in a price text, in order, de-duplicated: numbers
 * with a currency marker («kr 585», «985,-», «200.-», «250 kr») and both ends
 * of a range («150–250 kr»). PURE. Sizes and counts («8-10 porsjoner»,
 * «500 g») carry no marker and are not prices. A non-NOK currency → [].
 */
export function nokPriceValues(text: string | null | undefined): number[] {
  const raw = (text ?? "").replace(/\s+/g, " ").trim();
  if (!raw || /(€|\$|£|\beur\b|\busd\b|\bsek\b|\bdkk\b)/i.test(raw)) return [];
  const found: Array<{ index: number; value: number }> = [];
  const add = (index: number, token: string) => {
    const v = parseNorwegianNumber(token);
    if (v !== null) found.push({ index, value: v });
  };
  const range = new RegExp(`${NUM}\\s*[-–]\\s*${NUM}\\s*(?:,-|\\.-|kr\\b|kr\\.|nok\\b|kroner\\b)`, "gi");
  for (const m of raw.matchAll(range)) {
    add(m.index!, m[1]!);
    add(m.index! + m[0].indexOf(m[2]!, m[1]!.length), m[2]!);
  }
  for (const m of raw.matchAll(new RegExp(`(?:\\bkr\\.?|\\bnok)\\s*${NUM}`, "gi"))) add(m.index!, m[1]!);
  for (const m of raw.matchAll(new RegExp(`${NUM}\\s*(?:,-|\\.-(?!\\d)|kr\\b|kr\\.|nok\\b|kroner\\b)`, "gi"))) add(m.index!, m[1]!);
  const seen = new Set<number>();
  return found
    .sort((a, b) => a.index - b.index)
    .map((f) => f.value)
    .filter((v) => (seen.has(v) ? false : (seen.add(v), true)));
}

/** Units that state a weight/volume — a price "per" one of these is a unit price. */
export type MeasureUnit = "kg" | "g" | "l";

/**
 * True when `text` says the price is PER kg / g / l: «kr/kg», «/kg», «pr. kg»,
 * «per kilo», «kiloen», «kilopris», «pr. liter», «literpris», «kr/hg»,
 * «pr 100 g». PURE. A weight that only describes the pack («10 kg 160,-»,
 * «à 500 g», «5kg. 1.200,-») is NOT a unit price.
 */
export function statesUnitPrice(text: string | null | undefined, unit: MeasureUnit): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  const per = "(?:\\/|\\bpr\\.?\\s*|\\bper\\s+|\\bpris\\s+pr\\.?\\s*)";
  if (unit === "kg") return new RegExp(`${per}(?:kg|kilo|kilogram)(?![a-zæøå])|\\bkiloen\\b|\\bkilopris|\\bkg-pris`, "i").test(t);
  if (unit === "l") return new RegExp(`${per}(?:l|liter|litre|ltr)(?![a-zæøå])|\\bliteren\\b|\\bliterpris`, "i").test(t);
  return new RegExp(`${per}(?:\\d+\\s*)?(?:g|gr|gram|hg|hekto)(?![a-zæøå])|\\bhektoen\\b|\\bhektopris`, "i").test(t);
}

/** A weight/volume written in a text («10 kg», «5kg.», «250g», «1,5 l») → «10 kg». PURE. */
export function packSizeIn(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(kg|kilo|gram|gr|g|liter|ltr|l|dl|cl|ml)(?![a-zæøå])/i);
  if (!m) return null;
  const u = m[2]!.toLowerCase();
  const unit = u === "kilo" ? "kg" : u === "gram" || u === "gr" ? "g" : u === "liter" || u === "ltr" ? "l" : u;
  return `${m[1]} ${unit}`;
}

/** «kommer høsten», «kommer snart», «coming soon», «pris kommer»: a placeholder, not a price. PURE. */
export function isComingSoonPlaceholder(text: string | null | undefined): boolean {
  if (!text) return false;
  return /(^|[^a-zæøå])kommer([^a-zæøå]|$)|coming soon|\bsnart tilgjengelig\b|\bpris ikke satt\b/i.test(text);
}
