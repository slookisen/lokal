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
// isExperienceIndexable()/renderableExperienceDescription() are pure.
// experienceDescriptionsBySlug() reads the db handle it is given.

import type Database from "better-sqlite3";
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

/**
 * slug → raw description for every slugged experience row, in one query.
 * The publish gate is NOT applied here: the sitemap walks
 * listPublishedExperienceSlugs() (the gate's single owner) and only looks
 * descriptions up in this map. experiences.slug is UNIQUE, so the lookup is
 * unambiguous.
 */
export function experienceDescriptionsBySlug(db: Database.Database): Map<string, string | null> {
  const rows = db
    .prepare("SELECT slug, description FROM experiences WHERE slug IS NOT NULL")
    .all() as Array<{ slug: string; description: string | null }>;
  return new Map(rows.map((r) => [r.slug, r.description]));
}
