// ─── Finn-tannlege landing pages (dev-request 2026-10-16-finn-tannlege-landingssider)
//
// The numbers, places and dates the dental list pages (/fylke, /sted,
// /spesialitet), the homepage hero and the sitemap read, kept here so no
// handler in routes/dental-seo.ts holds its own copy.
//
// No env override for these, on purpose: listPageSize decides which clinics
// an indexed ?side=N URL shows, so it must not differ between deploys or
// machines, and the rest is page layout, not thresholds. The thresholds F1-S3
// brings (sted.minClinicsForIndex, faq.*) join this module each with an env
// override read per call, like OPPLEVAGENT_COMBO_MIN_EXPERIENCES
// (services/experience-indexability.ts).

export const DENTAL_LANDING_CONFIG = {
  /** Clinic cards per page on /fylke, /sted and /spesialitet (as before). */
  listPageSize: 50,
  /** Page links on each side of the current page in the page nav (F1-S1). */
  paginationWindow: 3,
  /**
   * The homepage hero chips, in order (F1-S1): each links /sted/<slug> when
   * the place has a /sted page, /sok?q=<place> when it has none.
   */
  heroPlaces: ["Oslo", "Bergen", "Trondheim", "Stavanger"],
} as const;

/**
 * The day (YYYY-MM-DD) each static page's own text last changed, the sitemap
 * <lastmod> for that page (F1-S2). Update the date in the same commit that
 * changes the page text. A page left out gets no <lastmod> rather than the
 * build day. The homepage is not listed: its lastmod is the newest public
 * clinic row (getDentalAggregateLastmods().all), since its numbers and place
 * lists come from them.
 *
 * Each date is the last commit on main that changed the page's route handler
 * in routes/dental-seo.ts (the handler text compared across all 58 commits
 * that touched the file up to 114fe2ad, 2026-10-17). The handlers interpolate
 * no data, so that is the day their text last changed.
 */
export const DENTAL_STATIC_PAGE_DATES: Readonly<Record<string, string>> = {
  "/hvordan-det-fungerer": "2026-06-05",
  "/om": "2026-06-04",
  // Same day as the page's own «Sist oppdatert» (updatedDate in the
  // /personvern handler); a test keeps the two equal.
  "/personvern": "2026-10-13",
  "/proveniens": "2026-07-25",
};
