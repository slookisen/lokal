// ─── Experience indexability: one rule for robots meta, X-Robots-Tag, sitemap ─
// dev-request 2026-10-16-opplevagent-indekserbarhet-og-strukturdata, E1-S1.
//
// Measured live 2026-10-16: 145 of 556 published /opplevelse/<slug> pages had
// no description. They rendered the «Detaljert beskrivelse publiseres
// fortløpende» placeholder, yet carried a hardcoded `index, follow` and were
// listed in sitemap.xml. The page, its headers and the sitemap each decided
// on their own, so they could disagree.
//
// The rule that replaces that lives here, and all three read it:
//   - A page is indexable iff the detail page renders a real description —
//     non-blank and not isJunkDescription(). That is the detail page's own
//     render guard, so the placeholder shows exactly when the page is not
//     indexable. A faktalinje (the short generated-facts tier) is a real
//     description and counts.
//   - A non-indexable page answers 200 with `noindex, follow` in both the
//     robots meta and X-Robots-Tag, and is left out of sitemap.xml. It stays
//     published and linked (Daniel's scope choice 2026-09-18, alt. C: noindex
//     is not unpublishing). Once a description lands, the row's updated_at
//     moves and the page is indexable again — no state is kept here.
//   - Kill switch OPPLEVAGENT_PLACEHOLDER_NOINDEX, read per call like
//     isOpplevagentLangSwitcherEnabled(): anything but "false" = on. With
//     "false" every page is `index, follow` and listed, as before.
//
// Everything here is pure. The sitemap gets each row's description from
// listPublishedExperienceSlugs() (experience-store.ts), behind the publish gate.

import { isJunkDescription } from "./description-quality";

/** robots meta / X-Robots-Tag value for a page that must not be indexed. */
export const NOINDEX_FOLLOW = "noindex, follow";

/** Kill switch for the placeholder noindex. On unless the env says "false". */
export function isPlaceholderNoindexEnabled(): boolean {
  return process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX !== "false";
}

/**
 * The description the detail page may render, unchanged, or "" when it must
 * show the placeholder instead (missing, blank, or junk per
 * isJunkDescription()).
 */
export function renderableExperienceDescription(description: string | null | undefined): string {
  const text = description ? String(description) : "";
  if (!text.trim() || isJunkDescription(text)) return "";
  return text;
}

/** True when the experience has a real description to rank on. */
export function isExperienceIndexable(row: { description?: string | null }): boolean {
  return renderableExperienceDescription(row.description) !== "";
}

/**
 * The verdict the detail page, its X-Robots-Tag header and the sitemap all
 * use: true = `noindex, follow` and not listed. Combines the kill switch with
 * isExperienceIndexable().
 */
export function shouldNoindexExperience(row: { description?: string | null }): boolean {
  return isPlaceholderNoindexEnabled() && !isExperienceIndexable(row);
}

// ─── Combo pages: one gate for /kategori/:category/:kommune and the sitemap ──
// dev-request 2026-10-16-opplevagent-stedssider-kvalitet, E4-S1.
//
// Measured live 2026-10-16: the sitemap listed 345 combo pages, and 15 of a
// sample of 25 showed exactly one experience. The ≥2-real-facts rule counts
// total > 0 and providerCount > 0, which are nearly always both true, so one
// experience got through. The route and the sitemap also each carried their
// own copy of that rule.
//
// The rule that replaces both copies lives here:
//   - A cell is indexable iff it has at least produktByMinExperiences()
//     published experiences AND at least 2 real facts — the same three facts
//     buildProduktByFaqJsonLd()/buildProduktByAnswerFirstOpening() count
//     (experiences, providers, a stated price ≥ 0), so a cell that passes
//     always gets its answer-first opening and its FAQ.
//   - The route serves an indexable cell. A cell with ≥1 experience that is
//     not indexable answers 301 to /kommune/<kommune> (same experiences,
//     richer page); an empty cell stays 404. The sitemap lists exactly the
//     indexable cells, and /kommune/<kommune> links exactly those.
//   - The threshold is PRODUKT_BY_MIN_EXPERIENCES unless
//     OPPLEVAGENT_COMBO_MIN_EXPERIENCES holds a whole number ≥ 1, read per
//     call (no restart). "1" gives back the pre-E4-S1 behaviour (the fact
//     rule alone); anything else falls back to the default. The route reads
//     it per request; the sitemap per build, so after the sitemap cache TTL.

/** Default minimum number of published experiences a combo page needs. */
export const PRODUKT_BY_MIN_EXPERIENCES = 2;

/** The facts a combo cell is judged on — getProduktByStats() and
 *  listProduktByCombos() rows both carry them. */
export type ProduktByCellStats = {
  total: number;
  providerCount: number;
  minPriceFrom: number | null;
};

/** The combo threshold in force: OPPLEVAGENT_COMBO_MIN_EXPERIENCES when it is
 *  a whole number ≥ 1, else PRODUKT_BY_MIN_EXPERIENCES. Read per call. */
export function produktByMinExperiences(): number {
  const raw = (process.env.OPPLEVAGENT_COMBO_MIN_EXPERIENCES ?? "").trim();
  if (!/^\d+$/.test(raw)) return PRODUKT_BY_MIN_EXPERIENCES;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : PRODUKT_BY_MIN_EXPERIENCES;
}

/** How many of the three real facts (experiences, providers, a stated price
 *  ≥ 0) a combo cell has — the count the produkt×by FAQ builders gate on. */
export function countProduktByRealFacts(stats: ProduktByCellStats): number {
  return (
    (stats.total > 0 ? 1 : 0) +
    (stats.providerCount > 0 ? 1 : 0) +
    (stats.minPriceFrom !== null && stats.minPriceFrom >= 0 ? 1 : 0)
  );
}

/**
 * The verdict the /kategori/:category/:kommune route, the sitemap and the
 * /kommune category chips all use: true = serve, list and link the combo
 * page; false = never list or link it (the route redirects or 404s).
 */
export function isProduktByCellIndexable(stats: ProduktByCellStats): boolean {
  return stats.total >= produktByMinExperiences() && countProduktByRealFacts(stats) >= 2;
}
