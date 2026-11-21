/**
 * gardssalg-visit-facts.ts — dev-request 2026-11-12-opplevagent-o5-besok-i-
 * chatgpt-og-assistenter, slice O5-5.
 *
 * The visit facts a discover_gardssalg row may carry (behind
 * GARDSSALG_MCP_VISIT_FACTS_ENABLED, read in routes/experiences-mcp.ts):
 *
 *   - opening_hours_text — the producer's own opening-hours text,
 *   - visit_description  — the producer's own visit text (visit_text).
 *
 * No parsed opening windows: parseOpeningHoursText() reads one time range and
 * no negations («Stengt mandag», «unntatt søndag», «lør 11-15» after
 * «Man-fre 10-16»), so a structured window could state more than the producer
 * wrote. The row carries the producer's own text only.
 *
 * Only what the producer stated itself: a field is used only when the owner
 * saved it in the claim portal, i.e. field_provenance.owner_locks.<field> is
 * a plain object with no locker (`locked_by` absent, null or undefined). Any
 * `locked_by` string («admin», «Admin», «system», …) means someone other than
 * the owner set it. Text the
 * content job scraped or an LLM extracted is never used. There is no
 * owner-stated group-size field on experience_providers, so none is returned.
 *
 * Content rules (reports/2026-11-12-vurdering-reklameforbud-opplevagent.md
 * point 6, rule 2 and 6): no product names, brand names, strength, prices,
 * medals or tasting claims. Conservative: a field whose text shows any sign
 * of these is DROPPED whole, never rewritten.
 *
 * Pure: no DB access, no logging.
 */

import { classifyCartItemBan, hasDrinkSigns } from "./cart-item-ban";

export interface GardssalgVisitFactsSource {
  opening_hours_text?: string | null;
  visit_text?: string | null;
  products?: string | null;
  field_provenance?: string | null;
}

export interface GardssalgVisitFacts {
  opening_hours_text?: string;
  visit_description?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * True when the owner saved this field in the claim portal: the lock is a
 * plain object without a locker. Fail-closed on anything else (malformed
 * JSON, a null/string/array lock, any `locked_by` value but null/undefined).
 */
function ownerStated(row: GardssalgVisitFactsSource, field: string): boolean {
  if (!row.field_provenance) return false;
  let prov: unknown;
  try {
    prov = JSON.parse(row.field_provenance);
  } catch {
    return false;
  }
  if (!isPlainObject(prov) || !isPlainObject(prov.owner_locks)) return false;
  if (!Object.prototype.hasOwnProperty.call(prov.owner_locks, field)) return false;
  const lock = prov.owner_locks[field];
  if (!isPlainObject(lock)) return false;
  return lock.locked_by === undefined || lock.locked_by === null;
}

function productNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string").map((p) => p.trim().toLowerCase()).filter((p) => p.length >= 3);
  } catch {
    return [];
  }
}

// Prices: «149 kr», «kr 149», «NOK 200», «149,-», «149:-», «149 kroner»,
// any currency word or sign (NKR, SEK, euro, €, krone), «Pris 150», «Billett 200».
const PRICE_RE =
  /\d\s*(?:kr\b|kr\.|nok\b|kroner|,-|,–|\.-|:-)|\b(?:kr|nok|nkr|sek|eur)\.?\s*\d|\bnkr\b|\bsek\b|\beuros?\b|€|\bkrone\b|\b(?:pris|priser|prisen|billett|billetter|billetten)\s*:?\s*(?:kr\.?\s*)?\d/i;
// Strength: any percent/per-mille figure, «prosent», «pst», «vol», «alk.», «abv».
const STRENGTH_RE = /\d\s*%|%\s*\d|prosent|\bpst\b|‰|％|\bvol\b|\balk\.?\b|\babv\b|alkoholstyrke/i;
// Medals/awards, tasting and «free» claims (rule 2 and 6).
const CLAIM_RE = /medalj|medal|award|prisvinn|kåret|smak|tasting|degust|gratis|\bfree\b/i;
// A quoted span is treated as a product or brand name: any typographic quote
// mark, or a pair of straight apostrophes around text (a single possessive
// apostrophe, «Ola's», does not count).
const QUOTED_RE = /[«»“”"‘’‹›]|(?:^|[\s(\[:;,])'[^'\n]+'(?=$|[\s.,;:!?)\]])/;

/** Test-only: the regex checks, so a test can show a text is caught by hasDrinkSigns alone. */
export const __visitFactsRegexesForTesting = { PRICE_RE, STRENGTH_RE, CLAIM_RE, QUOTED_RE } as const;

// Norwegian definite suffixes: «Sideren», «Ølet», «Vina», «Ølene» -> stem.
const DEFINITE_SUFFIX_RE = /(?:ene|en|et|a)$/iu;

function isAlcoholWord(word: string): boolean {
  if (classifyCartItemBan({ name: word })?.kind === "alcohol") return true;
  const stem = word.replace(DEFINITE_SUFFIX_RE, "");
  // A two-letter stem only when it has æ/ø/å («Ølet» -> «Øl»), so a name like
  // «Ola» is not read as «Ol».
  const stemOk = stem.length >= 3 || (stem.length === 2 && /[æøå]/iu.test(stem));
  return stem !== word && stemOk && classifyCartItemBan({ name: stem })?.kind === "alcohol";
}

/**
 * True when the text may name a product or brand, give a price or a strength,
 * or claim medals/tasting. Fail-closed: any doubt counts as a leak.
 */
export function gardssalgVisitTextLeaksDrink(text: string, products: readonly string[] = []): boolean {
  if (PRICE_RE.test(text) || STRENGTH_RE.test(text) || CLAIM_RE.test(text) || QUOTED_RE.test(text)) return true;
  if (hasDrinkSigns(text, "")) return true;
  const lower = text.toLowerCase();
  if (products.some((p) => lower.includes(p))) return true;
  // A capitalised or all-caps drink word («Hardangersider», «Juleøl», «IPA»,
  // «SIDER», and definite forms like «Eplesideren», «Vinen») reads as a product
  // or brand name; the lower-case generic word («sider», «øl») does not.
  for (const word of text.split(/[^\p{L}\d]+/u)) {
    if (!word || word[0] === word[0]!.toLowerCase()) continue;
    try {
      if (isAlcoholWord(word)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * The visit facts for one discover_gardssalg row. Empty object when the
 * producer stated none (the caller spreads nothing — no null/empty fields).
 */
export function gardssalgVisitFacts(row: GardssalgVisitFactsSource): GardssalgVisitFacts {
  const out: GardssalgVisitFacts = {};
  const products = productNames(row.products);

  const hours = typeof row.opening_hours_text === "string" ? row.opening_hours_text.trim() : "";
  if (hours && ownerStated(row, "opening_hours_text") && !gardssalgVisitTextLeaksDrink(hours, products)) {
    out.opening_hours_text = hours;
  }

  const visit = typeof row.visit_text === "string" ? row.visit_text.trim() : "";
  if (visit && ownerStated(row, "visit_text") && !gardssalgVisitTextLeaksDrink(visit, products)) {
    out.visit_description = visit;
  }

  return out;
}
