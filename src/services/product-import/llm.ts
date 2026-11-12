// ─── Product import: tier 4 — LLM on product pages, source-grounded ─────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 1.
// Extends the existing Haiku name extractor's pattern
// (services/gardssalg-product-list.ts) with price and unit. Same contract:
//   • the model sees ONLY the already-fetched visible page text (capped);
//   • the answer must be a JSON array; a markdown code fence is unwrapped
//     (gardssalgStripCodeFence — both fences required), nothing else is ever
//     repaired: genuinely invalid JSON stays invalid → no candidates;
//   • grounding is enforced HERE, in code, not trusted to the prompt:
//       – a name is kept only if it appears verbatim in the source text
//         (whitespace-collapsed, case-insensitive);
//       – a price is kept only if its number appears verbatim as a number in
//         the source text; otherwise the price is dropped and the product kept.
//
// The model call is injectable (`ProductImportLlm`) so tests never touch the
// network; the default implementation is the same Messages API call the
// existing extractor makes, counted on the LLM call meter.

import { noteLlmCall } from "../llm-call-meter";
import { gardssalgStripCodeFence } from "../gardssalg-product-list";
import {
  canonicalUnit,
  nokPriceValues,
  normalizeProductName,
  numberTokensInText,
  numbersInText,
  packSizeIn,
  parseNokPrice,
  statesUnitPrice,
  PRODUCT_IMPORT_MAX_PRODUCTS,
  roundNok,
  type ProductUnit,
} from "./normalize";

export const PRODUCT_IMPORT_LLM_SOURCE = "product-import-extractor";
export const PRODUCT_IMPORT_LLM_MODEL = "claude-haiku-4-5";
export const PRODUCT_IMPORT_LLM_SOURCE_CHAR_CAP = 20000;
export const PRODUCT_IMPORT_LLM_SENTINEL = "INGEN_PRODUKTER_FUNNET";

/** One model call: prompt in, raw text answer out (null = infra failure). */
export type ProductImportLlm = (prompt: string) => Promise<{ text: string | null }>;

export const defaultProductImportLlm: ProductImportLlm = async (prompt) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { text: null };
  noteLlmCall(PRODUCT_IMPORT_LLM_SOURCE);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: PRODUCT_IMPORT_LLM_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return { text: null };
    const result: any = await response.json();
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.find((c: any) => c?.type === "text")?.text;
    return { text: typeof text === "string" ? text : null };
  } catch {
    return { text: null };
  }
};

export function buildProductImportPrompt(sourceText: string): string {
  const capped = sourceText.slice(0, PRODUCT_IMPORT_LLM_SOURCE_CHAR_CAP);
  return `Lag en liste over varer denne produsenten selger, med pris og enhet, KUN basert på kildeteksten under.

Kildetekst (hentet fra produsentens egen nettside):
${capped}

Regler:
- Bruk KUN produktnavn som står i kildeteksten, med nøyaktig samme ordlyd. Ikke finn på produkter.
- "price" er prisen slik den står i kildeteksten (f.eks. "250 kr", "kr 89,-", "fra 150 kr/kg"), med enhetsmerket ("/kg", "pr. kg", "per liter") hvis det står ved prisen, eller null hvis ingen pris står ved varen. Ikke regn ut eller anslå priser.
- Står det flere priser ved samme vare (størrelser/varianter, f.eks. "585,- / 985,-"), ta med alle slik de står.
- "0 kr", "0 NOK" og plassholdere som "kommer høsten" eller "kommer snart" er ingen pris: bruk null.
- "unit" er en av "kg", "g", "l", "stk", "pakke", eller null hvis kildeteksten ikke sier det. Bruk "kg", "g" eller "l" BARE når kildeteksten sier at prisen er per enhet ("kr/kg", "/kg", "pr. kg", "per kilo", "kiloen", "kilopris", "pr. liter"). En vekt eller et volum i varenavnet eller foran prisen er pakkestørrelsen ("Poteter 10 kg 160,-", "5kg. 1.200,-"): da er "unit" "pakke".
- Retter som serveres (meny, catering, buffet) er ikke varer.
- Svar med EKSAKT et JSON-array av objekter, f.eks. [{"name":"Lammelår","price":"250 kr/kg","unit":"kg"}], og ingenting annet — ingen markdown, ingen kodeblokk.
- Hvis kildeteksten ikke nevner noen konkrete varer, svar med nøyaktig ${PRODUCT_IMPORT_LLM_SENTINEL} og ingenting annet.`;
}

export type LlmParseStatus = "ok" | "sentinel" | "invalid_json" | "not_array" | "infra_failure";

export interface LlmRawItem {
  name: string;
  price: string | null;
  unit: string | null;
}

/** Parse the model's answer. Only a code fence is unwrapped; nothing is repaired. PURE. */
export function parseLlmAnswer(text: string | null): { status: LlmParseStatus; items: LlmRawItem[] } {
  if (text === null) return { status: "infra_failure", items: [] };
  const unfenced = gardssalgStripCodeFence(text.trim());
  if (unfenced === PRODUCT_IMPORT_LLM_SENTINEL) return { status: "sentinel", items: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return { status: "invalid_json", items: [] };
  }
  if (!Array.isArray(parsed)) return { status: "not_array", items: [] };
  const items: LlmRawItem[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== "string") continue;
    items.push({
      name: r.name,
      price: typeof r.price === "string" ? r.price : typeof r.price === "number" ? String(r.price) : null,
      unit: typeof r.unit === "string" ? r.unit : null,
    });
  }
  return { status: "ok", items };
}

/** Lower-cased, whitespace-collapsed haystack used for verbatim name checks. PURE. */
export function groundingHaystack(text: string): string {
  return text.replace(/\s+/g, " ").toLocaleLowerCase("nb-NO");
}

export interface GroundedItem {
  name: string;
  price_nok: number | null;
  price_text: string;
  unit: ProductUnit | null;
  price_is_from: boolean;
  /** The model's price string, before grounding and rules (audit). */
  raw_price_text: string | null;
  pack_size: string | null;
  rules: string[];
}

export interface GroundingResult {
  items: GroundedItem[];
  names_rejected: number;
  prices_rejected: number;
}

/**
 * Apply the grounding rule to the model's items. PURE.
 * `sourceText` is exactly the text the model was shown.
 */
export function groundLlmItems(items: LlmRawItem[], sourceText: string): GroundingResult {
  const hay = groundingHaystack(sourceText);
  const sourceNumbers = new Set(numbersInText(sourceText).map((n) => roundNok(n)));
  const out: GroundedItem[] = [];
  let namesRejected = 0;
  let pricesRejected = 0;
  for (const it of items) {
    const name = normalizeProductName(it.name);
    if (!name || !hay.includes(groundingHaystack(name))) {
      namesRejected++;
      continue;
    }
    let price_nok: number | null = null;
    let price_text = "";
    let price_is_from = false;
    let unit: ProductUnit | null = null;
    let pack_size: string | null = null;
    const rules: string[] = [];
    const raw_price_text = it.price && it.price.trim() ? it.price.replace(/\s+/g, " ").trim() : null;
    if (raw_price_text) {
      const parsed = parseNokPrice(raw_price_text);
      // Several prices at one product (sizes/variants: «585,- / 985,-") →
      // the lowest grounded one, marked «fra».
      const grounded = nokPriceValues(raw_price_text).filter((v) => sourceNumbers.has(roundNok(v)));
      if (grounded.length > 1) {
        price_nok = roundNok(Math.min(...grounded));
        price_text = raw_price_text;
        price_is_from = true;
        rules.push("price_multiple_lowest");
        unit = parsed.unit ?? canonicalUnit(it.unit);
      } else if (parsed.price_nok !== null && sourceNumbers.has(roundNok(parsed.price_nok))) {
        price_nok = roundNok(parsed.price_nok);
        price_text = raw_price_text;
        price_is_from = parsed.price_is_from;
        // The unit belongs to the price: the one stated in the kept price
        // text wins, the model's own unit field is the fallback.
        unit = parsed.unit ?? canonicalUnit(it.unit);
      } else {
        pricesRejected++;
      }
      if (price_nok !== null && price_nok > 0 && (unit === "kg" || unit === "g" || unit === "l")) {
        const r = packWeightRule(name, raw_price_text, price_nok, unit, sourceText);
        unit = r.unit;
        pack_size = r.pack_size;
        if (r.rule) rules.push(r.rule);
      }
    }
    out.push({ name, price_nok, price_text, unit, price_is_from, raw_price_text, pack_size, rules });
    if (out.length >= PRODUCT_IMPORT_MAX_PRODUCTS) break;
  }
  return { items: out, names_rejected: namesRejected, prices_rejected: pricesRejected };
}

/**
 * kg / g / l is a UNIT PRICE («189 kr/kg»). It is kept only when the price
 * text, or the source text right at the price, says the price is per that
 * unit (normalize.statesUnitPrice). Otherwise the weight is the pack size
 * («Poteter 10 kg 160,-», «5kg. 1.200,-»): unit «pakke» with the weight in
 * `pack_size` when one is written in the name or just before the price, and
 * no unit at all when no weight is written anywhere (never a guess). PURE.
 */
export function packWeightRule(
  name: string,
  priceText: string,
  price: number,
  unit: "kg" | "g" | "l",
  sourceText: string,
): { unit: ProductUnit | null; pack_size: string | null; rule: "unit_pack_weight" | "unit_unstated_dropped" | null } {
  if (statesUnitPrice(priceText, unit)) return { unit, pack_size: null, rule: null };
  let before: string | null = null;
  for (const tok of numberTokensInText(sourceText)) {
    if (roundNok(tok.value) !== price) continue;
    const lineStart = sourceText.lastIndexOf("\n", tok.index - 1) + 1;
    const nl = sourceText.indexOf("\n", tok.index + tok.length);
    const lineEnd = nl === -1 ? sourceText.length : nl;
    const after = sourceText.slice(tok.index + tok.length, Math.min(lineEnd, tok.index + tok.length + 16));
    const prev = sourceText.slice(Math.max(lineStart, tok.index - 30), tok.index);
    // «189 kr/kg», «189,- pr. kg» right after the number; «Kilopris: 189»
    // or «pr. kg 189» right before it, on the same line.
    if (statesUnitPrice(after, unit)) return { unit, pack_size: null, rule: null };
    if (new RegExp(`(kilopris|literpris|hektopris|kiloen|literen|(pr\\.?|per)\\s*(kg|kilo|l|liter|hg|100\\s*g))\\s*:?\\s*(kr\\.?|nok)?\\s*$`, "i").test(prev)) {
      return { unit, pack_size: null, rule: null };
    }
    before = before ?? packSizeIn(prev.split(/;|,\s|\s[-–]\s/).pop() ?? null);
  }
  const pack = packSizeIn(name) ?? before ?? packSizeIn(priceText);
  return pack ? { unit: "pakke", pack_size: pack, rule: "unit_pack_weight" } : { unit: null, pack_size: null, rule: "unit_unstated_dropped" };
}
