// ─── Structured-data policy: what JSON-LD may claim, how ratings are shown ──
// dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt,
// S1 + S2, S4-A1a and S4-A1b.
//
// Measured live 2026-10-16: 35 of 40 /produsent/:slug pages carried Google's
// rating as their own LocalBusiness.aggregateRating (plus a copy on every
// Product), reviewCount fell back to 1 and the review author to «Kunde» when
// unknown, and every priced Offer claimed 14 days free return by post and
// 0 kr shipping (WO-17). The rules that replace that live here:
//   1. Rating/review markup only from sources the site collects itself.
//      Google's review-snippet guidelines exclude ratings copied from Google,
//      Yelp and the like. No first-party review flow exists yet, so nothing is
//      marked up today; an own-review flow is added to
//      RATING_MARKUP_SOURCES_ALLOWED and nothing else changes.
//   2. reviewCount is never invented: no known count, no AggregateRating.
//   3. Return and shipping terms only from an explicit per-producer policy.
//      No data source holds one, so Offers carry neither node.
//   4. A third-party rating may be SHOWN on the page as text that names its
//      source, with a count only when the count is known, and not at all in
//      RATING_DISPLAY_MODE 'hidden' (the mode since S4-A1a, for RFB and
//      finn-tannlege).
//   5. A stored Google rating is not passed on in public API, A2A or MCP
//      output. knowledgeService.getAgentInfo leaves it out unless one of the
//      site's own pages asks for it, and there rule 4 decides (S4-A1a).
//      GET /api/marketplace/agents/:id/trust and the finn-tannlege REST
//      answers (GET /api/tannlege/agents, /agents/:id) leave it out too
//      (S4-A1b). Reads behind owner or admin authentication (GET
//      /agents/:id/knowledge, the owner portal, the admin outreach tools)
//      still return it; S4-A3 decides those.
//   6. trust_score does not read it either (S4-A1b). Its community signal
//      takes first-party reviews only, and is neutral (0.3) for every agent
//      until an own-review flow exists; that flow feeds both
//      RATING_MARKUP_SOURCES_ALLOWED and trust-score-service.ts.
//
// The page tests check the same rules against the rendered RFB, Opplevagent
// and dental JSON-LD (tests/helpers/jsonld-invariants.ts).
//
// PURE: no DB, no env, no I/O.

import { t, type Lang } from "../i18n/t";

export type RatingSource = "first_party" | "google" | "tripadvisor" | "external";

/** Sources whose ratings may become schema.org AggregateRating markup. */
export const RATING_MARKUP_SOURCES_ALLOWED: readonly RatingSource[] = ["first_party"];

export interface RatingInput {
  source: RatingSource;
  rating: number | null | undefined;
  count?: number | null;
}

const isRatingValue = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 5;
const isKnownCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * AggregateRating for an allowed source with a real rating and a real count;
 * null otherwise (every third-party source, a missing or zero count).
 */
export function buildRatingJsonLd(src: RatingInput): Record<string, unknown> | null {
  if (!RATING_MARKUP_SOURCES_ALLOWED.includes(src.source)) return null;
  if (!isRatingValue(src.rating) || !isKnownCount(src.count)) return null;
  return {
    "@type": "AggregateRating",
    "ratingValue": src.rating,
    "bestRating": 5,
    "worstRating": 1,
    "reviewCount": src.count,
  };
}

/**
 * A producer's own return and shipping terms, in schema.org shape. Nothing
 * stores these yet; a per-producer field is what a caller would pass here.
 */
export interface OfferPolicy {
  hasMerchantReturnPolicy?: Record<string, unknown>;
  shippingDetails?: Record<string, unknown>;
}

/**
 * The Offer-level return/shipping nodes for an explicit policy, to spread into
 * an Offer. Without a policy: {} (no default terms, so the nodes are left out).
 */
export function buildOfferPolicyJsonLd(policy: OfferPolicy | null | undefined): OfferPolicy {
  const out: OfferPolicy = {};
  if (policy?.hasMerchantReturnPolicy) {
    out.hasMerchantReturnPolicy = { ...policy.hasMerchantReturnPolicy, "@type": "MerchantReturnPolicy" };
  }
  if (policy?.shippingDetails) {
    out.shippingDetails = { ...policy.shippingDetails, "@type": "OfferShippingDetails" };
  }
  return out;
}

export type RatingDisplayMode = "attributed" | "hidden";

/**
 * How a stored third-party rating is shown, on rettfrabonden.com and
 * finn-tannlege.com alike. 'hidden' since S4-A1a: Daniel's decision 2
 * (2026-10-17) is to phase the stored Google ratings out (choice A). The terms
 * check (protocols/juridisk-sjekk-google-ratinger-2026-10-17.md) found that
 * storing them is not allowed, and that showing them in a directory is not an
 * allowed use under the EEA terms. The stored values stay untouched;
 * 'attributed' would show them again with «Google» as the source (S2), and is
 * not to be set back without Daniel.
 */
export const RATING_DISPLAY_MODE: RatingDisplayMode = "hidden";

let ratingDisplayModeForTesting: RatingDisplayMode | null = null;

/** Test-only: render as if RATING_DISPLAY_MODE were `mode`; null restores it. */
export function __setRatingDisplayModeForTesting(mode: RatingDisplayMode | null): void {
  ratingDisplayModeForTesting = mode;
}

/** Display names; a source without one is not shown (it could not be attributed). */
const RATING_SOURCE_LABEL: Partial<Record<RatingSource, string>> = {
  google: "Google",
  tripadvisor: "Tripadvisor",
};

export interface RatingDisplay {
  /** "4.6" */
  score: string;
  /** "236 anmeldelser på Google", or "på Google" when the count is unknown. */
  attribution: string;
  /** "★ 4.6 · 236 anmeldelser på Google", or "★ 4.6 på Google". */
  text: string;
}

/**
 * Plain text (callers escape it) for a rating shown on the page, or null when
 * nothing should be shown: mode 'hidden', no valid rating, or a source with no
 * display name. A missing or zero count is left out, never shown as 0.
 */
export function formatRatingDisplay(
  input: { rating: number | null | undefined; count?: number | null; source: RatingSource },
  lang: Lang,
  mode: RatingDisplayMode = ratingDisplayModeForTesting ?? RATING_DISPLAY_MODE,
): RatingDisplay | null {
  if (mode === "hidden") return null;
  const source = RATING_SOURCE_LABEL[input.source];
  if (!source || !isRatingValue(input.rating)) return null;
  const score = input.rating.toFixed(1);
  if (!isKnownCount(input.count)) {
    const attribution = t(lang, "producer.rating_on_source", { source });
    return { score, attribution, text: `★ ${score} ${attribution}` };
  }
  const key = input.count === 1 ? "producer.rating_count_on_source_one" : "producer.rating_count_on_source";
  const attribution = t(lang, key, { count: input.count, source });
  return { score, attribution, text: `★ ${score} · ${attribution}` };
}
