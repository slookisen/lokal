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

import { DENTAL_SEARCH_VOCABULARY } from "./dental-search-vocabulary";
import type { ListFilter } from "../services/dental-store";

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
  /**
   * When a facet page (/sted/<sted>/<fasett>, /fylke/<fylke>/<fasett>, A2A
   * dev-request 2026-10-16-finn-tannlege-fasettsider F1-S4) exists at all:
   * under it the URL is a 404 and is left out of the sitemap. Unlike faq.*,
   * this gate decides indexing, but only for the facet URLs. minListings 3
   * is Daniel's answer to question 7 (2026-10-18). The facts are the
   * clinics' own numbers within the facet, so the one the facet is named
   * for (every clinic on /sted/x/tannlegevakt has the akutt claim) is among
   * them.
   */
  facets: {
    /** Fewest clinics in the facet. */
    minListings: 3,
    /** Fewest real facts (Helfo, akutt, verified, specialists) among them. */
    minFacts: 2,
  },
} as const;

// ─── Facet pages (A2A dev-request 2026-10-16-finn-tannlege-fasettsider, F1-S4)
//
// A facet is a subset of a place's clinics with a page of its own:
// /sted/<sted>/<slug> and /fylke/<fylke>/<slug>. Each entry is data:
// `filter` is the store filter the page lists the clinics with, and the area
// aggregate (services/dental-area-facts.ts) counts them with the same SQL, so
// a new facet is one entry here. The specialty facets come from the search
// vocabulary's specialties, which mirror SPECIALTY_PAGES in
// routes/dental-seo.ts (a test checks both); this module cannot import the
// route module.

export type DentalLandingFacetKind = "helfo" | "tannlegevakt" | "specialty";

export interface DentalLandingFacet {
  /** The last URL segment. */
  slug: string;
  kind: DentalLandingFacetKind;
  /** The store filter fields that pick the facet's clinics. */
  filter: Readonly<Pick<ListFilter, "helfo_agreement" | "acute_claim" | "specialty">>;
  /** The H1 before « i <place>»: «Kjeveortoped» gives «Kjeveortoped i Bergen». */
  h1Label: string;
  /** The <title> before the page number and « — Finn-tannlege.com»; {sted} is the place. */
  titleTemplate: string;
  /** false: no page, no sitemap URL and no link. */
  enabled: boolean;
}

// The specialist's title for each specialty slug, for the H1.
const SPECIALIST_TITLES: Readonly<Record<string, string>> = {
  kjeveortopedi: "Kjeveortoped",
  "oral-kirurgi-og-oral-medisin": "Oralkirurg",
  periodonti: "Periodontist",
  endodonti: "Endodontist",
  pedodonti: "Pedodontist",
  "oral-protetikk": "Protetiker",
  "kjeve-og-ansiktsradiologi": "Kjeve- og ansiktsradiolog",
};

export const DENTAL_LANDING_FACETS: readonly DentalLandingFacet[] = [
  // Helfo only with a source (Daniel, question 24, 2026-10-19): off until
  // F2-S6 in 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon is merged,
  // which makes the public helfo_agreement filter and the area aggregate's
  // Helfo numbers DENTAL_HELFO_CLAIM_SQL. Turned on in its own small PR.
  {
    slug: "helfo", kind: "helfo", filter: { helfo_agreement: "true" },
    h1Label: "Tannleger med Helfo-direkteoppgjør", titleTemplate: "Tannleger med Helfo-direkteoppgjør i {sted}", enabled: false,
  },
  // Only «Akuttvakt» (resolveAcuteClaim = "vakt"), never the softer «Tar imot
  // akuttpasienter». Off since F1-S4c (live check 2026-10-19): a stored
  // source was only a stamp of where acute_vakt was read, and most of the
  // clinics it listed describe emergency appointments in opening hours, not
  // a vakt outside them. «vakt» now needs a stored quote, which no row has
  // yet, so the pages would be empty. Turned on again in its own small PR
  // only when (1) Daniel has defined «vakt», (2) the dental write pause is
  // lifted, (3) the extraction stores `quote` in the acute_vakt provenance
  // (SKILL schema, mergeFieldProvenance/normaliseSource in
  // admin-knowledge.ts) and (4) a new enrichment run has stored the quotes.
  // The title says «med sitat», as the page text does (F1-S4e point 13).
  {
    slug: "tannlegevakt", kind: "tannlegevakt", filter: { acute_claim: "vakt" },
    h1Label: "Tannlegevakt", titleTemplate: "Tannlegevakt i {sted}: klinikker med akuttvakt med sitat", enabled: false,
  },
  ...DENTAL_SEARCH_VOCABULARY.specialties.map((s): DentalLandingFacet => {
    const title = SPECIALIST_TITLES[s.slug] ?? s.canonical.charAt(0).toUpperCase() + s.canonical.slice(1);
    return {
      slug: s.slug, kind: "specialty", filter: { specialty: s.canonical },
      h1Label: title, titleTemplate: `${title} i {sted}: tannlegeklinikker med ${s.canonical}`, enabled: true,
    };
  }),
];

/** The facet with this URL segment, or undefined. */
export function findDentalLandingFacet(slug: string): DentalLandingFacet | undefined {
  return DENTAL_LANDING_FACETS.find((f) => f.slug === slug);
}

/**
 * The emergency notice on the tannlegevakt pages (A2A dev-request
 * 2026-10-16-finn-tannlege-fasettsider, F1-S4): a box above the clinic list
 * on every /sted/<sted>/tannlegevakt and /fylke/<fylke>/tannlegevakt page,
 * and on the national /tannlegevakt hub (F1-S4b); MCP tannlege_akutt gives
 * the same text as rad_om_kommunal_tannlegevakt (F1-S4c), and
 * /hvordan-det-fungerer shows it under «Akutt tannverk» and gives it as the
 * FAQ answer to «Hva gjør jeg ved akutt tannverk?» (F1-S4e), and the akutt
 * FAQ answer on /sted and /fylke ends with it (F1-S4e point 14). YMYL text,
 * reviewed line by line: change it here only, never in a page or a tool
 * answer. `phones` are the numbers in the text as it writes them, each shown
 * as a tel: link to `tel`. The facet pages are in Norwegian only, so there
 * is no English text.
 *
 * The last two sentences are word for word the caveat in pkt. 3 of /vilkar,
 * which Daniel approved on 2026-10-19 (A2A
 * daniel-responses/2026-10-19-live-svar-steg-a-og-vilkar.md, message 5):
 * a clinic on a tannlegevakt page has an akuttvakt with a stored quote, not a
 * promise that it can see you now. They stand here so every tannlegevakt page says
 * it, also page 2 and later and while the cache is behind, where the FAQ is
 * not shown (dental-landing.test.ts N9-N10 compare them with /vilkar).
 */
export const DENTAL_EMERGENCY_NOTICE = {
  text: "Ved akutt fare for liv eller helse: ring 113. Trenger du rask hjelp utenom åpningstid, ring legevakten på 116 117. Ellers kan du kontakte tannlegevakten der du bor. At en klinikk er merket med akuttilbud her, betyr ikke at den kan ta imot deg nå. Ring klinikken før du drar dit.",
  phones: [
    { number: "113", tel: "113" },
    { number: "116 117", tel: "116117" },
  ],
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
  // the Kartverket labels in the lists. F1-S4e (A2A dev-request
  // 2026-10-16-finn-tannlege-fasettsider), the same day: the akutt texts on
  // /hvordan-det-fungerer and /proveniens, and «akuttopplysninger» in the
  // data sources on all three.
  "/hvordan-det-fungerer": "2026-10-19",
  "/om": "2026-10-19",
  // Same day as the page's own «Sist oppdatert» (updatedDate in the
  // /personvern handler); a test keeps the two equal.
  "/personvern": "2026-10-13",
  // The /vilkar handler prints this as its own «Sist oppdatert» (F2-S5, A2A
  // dev-request 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon). It is the
  // day the terms take effect: the day Daniel approved the text, 2026-10-19
  // (A2A daniel-responses/2026-10-19-live-svar-steg-a-og-vilkar.md). The text
  // is the draft of 2026-10-18; only this date changed. A new date means new
  // terms, which Daniel approves again (company-legal-sites.test.ts pins it).
  "/vilkar": "2026-10-19",
  "/proveniens": "2026-10-19",
};
