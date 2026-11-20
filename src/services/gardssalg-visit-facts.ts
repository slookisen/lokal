/**
 * gardssalg-visit-facts.ts — dev-request 2026-11-12-opplevagent-o5-besok-i-
 * chatgpt-og-assistenter, slice O5-5.
 *
 * The visit facts a discover_gardssalg row may carry (behind
 * GARDSSALG_MCP_VISIT_FACTS_ENABLED, read in routes/experiences-mcp.ts):
 *
 *   - opening_hours_text — the producer's own opening-hours text,
 *   - opening_windows    — that text as parsed by parseOpeningHoursText(), the
 *                          SAME parser book_gardssalg's outside_hours check
 *                          uses (services/gardssalg-opening-hours.ts),
 *   - visit_description  — the producer's own visit text (visit_text).
 *
 * Only what the producer stated itself: a field is used only when the owner
 * saved it in the claim portal, i.e. field_provenance.owner_locks.<field> is
 * set and was not set by Opplevagent support (locked_by "admin"). Text the
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

import { getClaimOwnerLocks } from "./gardssalg-claim";
import { parseOpeningHoursText, type Weekday } from "./gardssalg-opening-hours";
import { classifyCartItemBan, hasDrinkSigns } from "./cart-item-ban";

export interface GardssalgVisitFactsSource {
  opening_hours_text?: string | null;
  visit_text?: string | null;
  products?: string | null;
  field_provenance?: string | null;
}

export interface GardssalgOpeningWindow {
  days: string[];
  opens: string;
  closes: string;
}

export interface GardssalgVisitFacts {
  opening_hours_text?: string;
  opening_windows?: GardssalgOpeningWindow[];
  visit_description?: string;
}

const DAY_CODES: Record<Weekday, string> = { 0: "mon", 1: "tue", 2: "wed", 3: "thu", 4: "fri", 5: "sat", 6: "sun" };

/** True when the owner saved this field in the claim portal (not an admin lock). */
function ownerStated(row: GardssalgVisitFactsSource, field: string): boolean {
  const lock = getClaimOwnerLocks({ field_provenance: row.field_provenance ?? null })[field];
  return lock !== undefined && lock.locked_by !== "admin";
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

// Prices: «149 kr», «kr 149», «NOK 200», «149,-», «149 kroner».
const PRICE_RE = /\d\s*(?:kr\b|kr\.|nok\b|kroner|,-|,–|\.-)|\b(?:kr|nok)\.?\s*\d/i;
// Strength: any percent figure, «prosent», «vol», «alk.», «abv».
const STRENGTH_RE = /\d\s*%|%\s*\d|prosent|\bvol\b|\balk\.?\b|\babv\b|alkoholstyrke/i;
// Medals/awards, tasting and «free» claims (rule 2 and 6).
const CLAIM_RE = /medalj|medal|award|prisvinn|kåret|smak|tasting|degust|gratis|\bfree\b/i;
// A quoted span is treated as a product or brand name.
const QUOTED_RE = /[«»“”"]/;

/**
 * True when the text may name a product or brand, give a price or a strength,
 * or claim medals/tasting. Fail-closed: any doubt counts as a leak.
 */
export function gardssalgVisitTextLeaksDrink(text: string, products: readonly string[] = []): boolean {
  if (PRICE_RE.test(text) || STRENGTH_RE.test(text) || CLAIM_RE.test(text) || QUOTED_RE.test(text)) return true;
  if (hasDrinkSigns(text, "")) return true;
  const lower = text.toLowerCase();
  if (products.some((p) => lower.includes(p))) return true;
  // A capitalised drink word («Hardangersider», «Juleøl», «IPA») reads as a
  // product or brand name; the lower-case generic word («sider», «øl») does not.
  for (const word of text.split(/[^\p{L}\d]+/u)) {
    if (!word || word[0] === word[0]!.toLowerCase()) continue;
    try {
      if (classifyCartItemBan({ name: word })?.kind === "alcohol") return true;
    } catch {
      return true;
    }
  }
  return false;
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
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
    const parsed = parseOpeningHoursText(hours);
    if (parsed && parsed.days.size > 0) {
      const days = [...parsed.days].sort((a, b) => a - b).map((d) => DAY_CODES[d]);
      out.opening_windows = [{ days, opens: hhmm(parsed.openMin), closes: hhmm(parsed.closeMin) }];
    }
  }

  const visit = typeof row.visit_text === "string" ? row.visit_text.trim() : "";
  if (visit && ownerStated(row, "visit_text") && !gardssalgVisitTextLeaksDrink(visit, products)) {
    out.visit_description = visit;
  }

  return out;
}
