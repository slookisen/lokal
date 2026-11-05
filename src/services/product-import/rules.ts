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
// Round 2 (prod measurement 2026-10-30, A2A reports/2026-10-30-produktimport-
// maaling-2.md), set where the price is read (./association.ts, the parsers):
//   price_not_at_name      the LLM price is not at the name: not in its own
//                          element/line nor right after it in its product
//                          block (or it sits in another product's block, or
//                          is a shared «X eller Y … kr N» price for others).
//   price_reanchored       the model's price was not at the name, but the
//                          name's own product block shows exactly one price:
//                          that one is used, verbatim from the page.
//   price_blog_source_dropped  the price only stands on a blog post (date in
//                          the URL, article/blog markup) → no price.
//   price_excl_vat         the price is marked «ekskl. mva.»: kept, with
//                          `price_excl_vat: true` and the mark in price_text.
//
// Every rule that fires is recorded in the candidate's `rules`, and every
// excluded candidate in the result's `excluded`, so the dry run can be
// audited candidate by candidate.

import { classifyCartItemBan } from "../cart-item-ban";
import { isComingSoonPlaceholder, statesExclVat } from "./normalize";
import type { ProductCandidate, ProductImportTier } from "./structured";

export type CandidateRule =
  | "price_zero_dropped"
  | "price_placeholder_dropped"
  | "price_not_purchasable"
  | "price_multiple_lowest"
  | "unit_pack_weight"
  | "unit_unstated_dropped"
  | "flag_alcohol"
  | "price_not_at_name"
  | "price_reanchored"
  | "price_blog_source_dropped"
  | "price_excl_vat";

export type ExclusionReason =
  | "excluded_service"
  | "excluded_event_category"
  | "excluded_password_protected"
  | "excluded_check_failed";

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
  // The VAT mark belongs to the price that is gone.
  if (c.price_excl_vat) {
    delete c.price_excl_vat;
    c.rules = c.rules.filter((r) => r !== "price_excl_vat");
  }
  if (!c.rules.includes(rule)) c.rules.push(rule);
}

/**
 * The candidate's price excludes VAT: flag it, record the rule and make sure
 * the price text carries the mark, so it is never shown as a consumer price
 * without it. No-op without a price.
 */
export function markExclVat(c: ProductCandidate): void {
  if (c.price_nok === null) return;
  c.price_excl_vat = true;
  if (!statesExclVat(c.price_text)) c.price_text = `${c.price_text} ekskl. mva.`.trim();
  if (!c.rules.includes("price_excl_vat")) c.rules.push("price_excl_vat");
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

/**
 * Import-only: the shop's own category says event («Arrangement»,
 * «Arrangementer»), as a whole token. Kept here, not in cart-item-ban.ts, so
 * this import slice never changes the real order gate. PURE.
 */
export function isEventShopCategory(category: string | null | undefined): boolean {
  return String(category ?? "")
    .toLowerCase()
    .replace(/å/g, "a").replace(/ø/g, "o").replace(/æ/g, "ae")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9%]+/)
    .some((t) => t === "arrangement" || t === "arrangementer");
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
    // The PRICE text only: «Juleribbe – kommer i desember» with a real price keeps it.
    if (c.price_nok !== null && isComingSoonPlaceholder(c.raw_price_text)) {
      dropPrice(c, "price_placeholder_dropped");
    }
    if (c.price_nok === 0) dropPrice(c, "price_zero_dropped");
    kept.push(c);
  }
  return { kept, excluded };
}
