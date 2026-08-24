// ─── Experience-category colours — ONE source for every surface ──────
// Daniel, live sesjon 2026-08-24: «Bruk rolige komfortable farger, og marker
// de ulike kategoriene i sin farge».
//
// Before this file the site had TWO unrelated per-category colour maps: none
// at all for the HTML surfaces (every category rendered in the same
// fjord-teal), and CATEGORY_OG_ACCENT_COLORS in experience-og-image.ts for
// the shared-link preview image — so vinter_sno was icy teal in a Facebook
// preview and identical-to-everything-else on the page it linked to. This
// module is the single map both now read: a category looks the same in the
// homepage grid, the listing cards, the facet chips, the profile badge, the
// drawn cover and the OG image.
//
// The set is deliberately muted (roughly S 30-50 %, L 30-40 %): calm and
// earthy against the beige canvas rather than a bag of primaries. The
// load-bearing constraint is contrast, not taste — each hue is used as a
// SOLID fill under white text (the .tag-cat / .badge-cat chips), so every
// value must clear WCAG AA 4.5:1 against #fff.
// experiences-seo-kategorifarger.test.ts asserts that for every entry, so a
// future addition cannot quietly ship an unreadable chip.
//
// Lighter shades are always DERIVED at use time with hex alpha (…1f / …33 /
// …66) — never a second hand-picked hex that could drift out of sync.
//
// Keys are the category slugs used by the `experiences` table (the same keys
// CATEGORY_LABELS / CATEGORY_ICON_INNER use in routes/experiences-seo.ts),
// plus `kajakk` — an internal key resolveCategoryIconKey() can return for
// water activities that have no label row of their own.
export const CATEGORY_COLORS: Record<string, string> = {
  natur_friluft: "#3f6b4c",           // skog/fjell — grønn
  dyreliv_safari: "#5e6841",          // olivengrønn (samme familie som --olive)
  velvaere_spa: "#4d7f70",            // dempet sjøgrønn
  sightseeing_transport: "#356b78",   // fjordblå
  kajakk: "#2f6b82",                  // vann
  vinter_sno: "#4d6b8f",              // isblå
  kultur_historie: "#6f5580",         // dempet lilla
  overnatting_opplevelse: "#8a5a5f",  // varm terrakotta-rose
  adrenalin_action: "#9e5133",        // rust
  mat_drikke: "#8a6224",              // okergul
  gardssalg: "#7a6a2e",               // korn/malt
};

// Brand teal for any category with no entry above (a newly published slug the
// resolver cannot bucket). Neutral on purpose: an unknown category gets the
// house colour, never a borrowed one that would imply a kinship it lacks.
export const CATEGORY_COLOR_FALLBACK = "#0f5a50"; // --fjord-700

/** Exact-slug lookup. Callers that also need to resolve human labels or
 *  legacy spellings go through categoryColor() in routes/experiences-seo.ts,
 *  which runs the same fuzzy resolver the category icons use and then reads
 *  this map. */
export function categoryColorBySlug(slug?: string | null): string {
  const key = String(slug ?? "").toLowerCase();
  return CATEGORY_COLORS[key] || CATEGORY_COLOR_FALLBACK;
}
