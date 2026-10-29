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
  normalizeProductName,
  numbersInText,
  parseNokPrice,
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
- "price" er prisen slik den står i kildeteksten (f.eks. "250 kr", "kr 89,-", "fra 150 kr/kg"), eller null hvis ingen pris står ved varen. Ikke regn ut eller anslå priser.
- "unit" er en av "kg", "g", "l", "stk", "pakke", eller null hvis kildeteksten ikke sier det.
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
    if (it.price && it.price.trim()) {
      const parsed = parseNokPrice(it.price);
      if (parsed.price_nok !== null && sourceNumbers.has(roundNok(parsed.price_nok))) {
        price_nok = roundNok(parsed.price_nok);
        price_text = it.price.replace(/\s+/g, " ").trim();
        price_is_from = parsed.price_is_from;
        // The unit belongs to the price: the one stated in the kept price
        // text wins, the model's own unit field is the fallback.
        unit = parsed.unit ?? canonicalUnit(it.unit);
      } else {
        pricesRejected++;
      }
    }
    out.push({ name, price_nok, price_text, unit, price_is_from });
    if (out.length >= PRODUCT_IMPORT_MAX_PRODUCTS) break;
  }
  return { items: out, names_rejected: namesRejected, prices_rejected: pricesRejected };
}
