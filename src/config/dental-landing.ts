// ─── Finn-tannlege landing pages (dev-request 2026-10-16-finn-tannlege-landingssider)
//
// The numbers and dates the dental list pages (/fylke, /sted, /spesialitet)
// and the sitemap read, kept here so no handler in routes/dental-seo.ts holds
// its own copy. F1-S1 (paging) and F1-S2 (sitemap lastmod) need no
// threshold; the thresholds F1-S3 brings (sted.minClinicsForIndex, faq.*)
// join this module, each with an env override read per call like
// OPPLEVAGENT_COMBO_MIN_EXPERIENCES (services/experience-indexability.ts).

export const DENTAL_LANDING_CONFIG = {
  /** Clinic cards per page on /fylke, /sted and /spesialitet (as before). */
  listPageSize: 50,
  /** Page links on each side of the current page in the page nav (F1-S1). */
  paginationWindow: 3,
} as const;

/**
 * The day (YYYY-MM-DD) each static page's own text last changed, the sitemap
 * <lastmod> for that page (F1-S2). Update the date in the same commit that
 * changes the page text. A page left out gets no <lastmod> rather than the
 * build day. The homepage is not listed: its lastmod is the newest public
 * clinic row (getDentalAggregateLastmods().all), since its numbers and place
 * lists come from them.
 *
 * Dates from git history of routes/dental-seo.ts (git log -L / git blame on
 * each route handler, 2026-10-17).
 */
export const DENTAL_STATIC_PAGE_DATES: Readonly<Record<string, string>> = {
  "/hvordan-det-fungerer": "2026-06-05",
  "/om": "2026-06-04",
  // Same day as the page's own «Sist oppdatert» (updatedDate in the
  // /personvern handler); a test keeps the two equal.
  "/personvern": "2026-10-13",
  "/proveniens": "2026-07-25",
};
