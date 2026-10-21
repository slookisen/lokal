/**
 * Order pricing helpers (F6) — dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel.
 *
 * Catalog rows can lack a price. An order line without a price must never be
 * shown as «0 kr»: it reads «Pris avtales med produsenten», and the sum is
 * only over the lines that have a price, labelled «Sum for varer med pris».
 * One place so the producer e-mail, the producer order page, the buyer
 * receipts and the API all say the same thing.
 */

export const PRICE_BY_AGREEMENT = "Pris avtales med produsenten";
export const PARTIAL_SUM_LABEL = "Sum for varer med pris";

export interface PricingSummary {
  /** Sum over the lines that have a price (0 when none has). */
  priced_total: number;
  /** At least one line has a price. */
  any_priced: boolean;
  /** At least one line has no price: the total does not cover the whole order. */
  is_partial: boolean;
}

export function summarizePricing(lines: ReadonlyArray<{ line_total: number | null | undefined }>): PricingSummary {
  let total = 0;
  let priced = 0;
  for (const l of lines) {
    if (l.line_total != null && Number.isFinite(l.line_total)) {
      total += l.line_total;
      priced++;
    }
  }
  return { priced_total: total, any_priced: priced > 0, is_partial: priced < lines.length };
}

/**
 * The sum text for an order, or null when no line has a price (then there is
 * nothing to sum and the price is agreed with the producer).
 */
export function sumLabel(p: PricingSummary, fmt: (n: number) => string): { label: string; value: string } | null {
  if (!p.any_priced) return null;
  return { label: p.is_partial ? PARTIAL_SUM_LABEL : "Sum", value: fmt(p.priced_total) };
}
