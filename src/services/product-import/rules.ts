// ─── Product import: candidate rules after extraction (PURE) ────────────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 1 —
// accuracy fixes after the prod measurement 2026-10-29 (70.6 % correct
// among priced candidates; A2A reports/2026-10-29-produktimport-maaling.md).
// Applied to every tier's candidates before dedupe/cap, deterministic,
// whatever a parser or the model returned:
//
//   excluded_service       the row is a service / experience / event by the
//                          SAME classifier the cart/order gate uses
//                          (cart-item-ban.ts classifyCartItemBan, F9). It is
//                          removed from products and listed in `excluded`.
//   excluded_check_failed  the classifier threw: fail-closed like the gate.
//   flag_alcohol           the gate's alcohol kind: kept (it is a real
//                          product with a real price), only marked so a
//                          re-measurement can see it.
//   price_placeholder_dropped  «kommer høsten» / «coming soon» → no price.
//   price_zero_dropped     a price of 0 is never a real price → no price.
//
// Every rule that fires is recorded in the candidate's `rules`, and every
// excluded candidate in the result's `excluded`, so the dry run can be
// audited candidate by candidate.

import { classifyCartItemBan } from "../cart-item-ban";
import { isComingSoonPlaceholder } from "./normalize";
import type { ProductCandidate, ProductImportTier } from "./structured";

export type CandidateRule =
  | "price_zero_dropped"
  | "price_placeholder_dropped"
  | "price_not_purchasable"
  | "price_multiple_lowest"
  | "unit_pack_weight"
  | "unit_unstated_dropped"
  | "flag_alcohol";

export type ExclusionReason = "excluded_service" | "excluded_password_protected" | "excluded_check_failed";

export interface ExcludedCandidate {
  name: string;
  source_url: string;
  tier: ProductImportTier;
  reason: ExclusionReason;
  /** The price as the source had it (before any rule), when there was one. */
  raw_price_text: string | null;
}

/** Drop the price of a candidate (the unit is the price's unit, so it goes too). */
export function dropPrice(c: ProductCandidate, rule: CandidateRule): void {
  c.price_nok = null;
  c.price_text = "";
  c.price_is_from = false;
  c.unit = null;
  if (!c.rules.includes(rule)) c.rules.push(rule);
}

export function excludedOf(c: ProductCandidate, reason: ExclusionReason): ExcludedCandidate {
  return { name: c.name, source_url: c.source_url, tier: c.tier, reason, raw_price_text: c.raw_price_text };
}

/**
 * The cart gate's verdict on one candidate: "service" (or "check_failed")
 * excludes it, "alcohol" flags it, null keeps it. `category` is the source's
 * own category labels (WooCommerce categories), when it has any.
 */
export function gateVerdict(name: string, category?: string | null): "service" | "alcohol" | "check_failed" | null {
  try {
    const ban = classifyCartItemBan({ name, category: category ?? null });
    return ban ? ban.kind : null;
  } catch {
    return "check_failed";
  }
}

/** Apply the rules to one tier's candidates. Mutates the kept candidates' price fields. PURE otherwise. */
export function applyCandidateRules(items: ProductCandidate[]): { kept: ProductCandidate[]; excluded: ExcludedCandidate[] } {
  const kept: ProductCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];
  for (const c of items) {
    const verdict = gateVerdict(c.name);
    if (verdict === "service") {
      excluded.push(excludedOf(c, "excluded_service"));
      continue;
    }
    if (verdict === "check_failed") {
      excluded.push(excludedOf(c, "excluded_check_failed"));
      continue;
    }
    if (verdict === "alcohol" && !c.rules.includes("flag_alcohol")) c.rules.push("flag_alcohol");
    if (c.price_nok !== null && (isComingSoonPlaceholder(c.raw_price_text) || isComingSoonPlaceholder(c.name))) {
      dropPrice(c, "price_placeholder_dropped");
    }
    if (c.price_nok === 0) dropPrice(c, "price_zero_dropped");
    kept.push(c);
  }
  return { kept, excluded };
}
