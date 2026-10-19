// ─── Finn-tannlege landing pages (dev-request 2026-10-16-finn-tannlege-landingssider)
//
// The numbers, places and dates the dental list pages (/fylke, /sted,
// /spesialitet), the homepage hero and the sitemap read, kept here so no
// handler in routes/dental-seo.ts holds its own copy.
//
// No env override for these, on purpose: listPageSize decides which clinics
// an indexed ?side=N URL shows, so it must not differ between deploys or
// machines, and the rest is page layout, not thresholds. The faq.* numbers
// (F1-S3) say when a /sted or /fylke page also gets a FAQ; they never decide
// whether a page is indexed. A /sted page is indexable whenever it has a
// clinic (isDentalStedIndexable in routes/dental-seo.ts, decision 7=A): there
// is no clinic-count threshold and no env switch for it, and a threshold above
// 0 needs a new decision from Daniel.

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
  /**
   * When a /sted or /fylke page shows the FAQ and its FAQPage JSON-LD (F1-S3,
   * services/landing-facts.ts). Only the FAQ is gated by these, not indexing.
   */
  faq: {
    /** Fewest clinics on the page. */
    minListings: 3,
    /** Fewest real facts (Helfo, akutt, verified, specialists) besides the clinic count. */
    minFacts: 2,
    /** Fewest question/answer pairs, for the visible FAQ and for FAQPage. */
    minQas: 2,
  },
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
 * no clinic data, except the two live numbers on /proveniens (F2-S2: the
 * clinics in the directory and those with the «Verifisert» badge, from the
 * caches). The numbers are not a change of the page's text and do not move
 * its <lastmod>, so the date stays the day the text last changed.
 */
export const DENTAL_STATIC_PAGE_DATES: Readonly<Record<string, string>> = {
  // F2-S1 (A2A dev-request 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon):
  // the data sources and the «Verifisert» text on these three pages; F2-S2,
  // the same day: the method page on /proveniens, «Om plattformen» on /om and
  // the Kartverket labels in the lists.
  "/hvordan-det-fungerer": "2026-10-19",
  "/om": "2026-10-19",
  // Same day as the page's own «Sist oppdatert» (updatedDate in the
  // /personvern handler); a test keeps the two equal.
  "/personvern": "2026-10-13",
  // The /vilkar handler prints this as its own «Sist oppdatert» (F2-S5, A2A
  // dev-request 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon). It is the
  // day the terms take effect: set it to the day Daniel approves the text and
  // merges, even if the text is unchanged since the draft of 2026-10-18.
  "/vilkar": "2026-10-18",
  "/proveniens": "2026-10-19",
};
