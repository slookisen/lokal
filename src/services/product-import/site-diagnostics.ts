// ─── Product import site diagnostics (measurement only) ─────────────────────
//
// dev-request 2026-11-24-rfb-vareopphenting-til-alle-eiere, slice 1: before
// "måling 3" the dry run must record, per website, (a) which platform the
// site runs on and (b) for a site with no products, why. PURE: no network,
// no DB. Every input is data the extractor has ALREADY fetched — nothing
// here may cause an extra request, change a tier, an outcome or a product.
//
// The result lands in ProductImportResult.diagnostics, which only the dry
// run's admin report reads. Owner flows (owner-import, auto-sync, outreach)
// copy named fields out of the result and never this one.

import type { ProductImportTier } from "./structured";

export type SitePlatform =
  | "shopify"
  | "woocommerce"
  | "wix"
  | "squarespace"
  | "mystore"
  | "webflow"
  | "jimdo"
  | "wordpress"
  | "other_shop"
  | "plain"
  | "unknown";

export type NoHitReason =
  | "fetch_failed"
  | "robots_blocked"
  | "js_shell"
  | "excluded_by_rules"
  | "grounding_rejected_all"
  | "llm_budget_exhausted"
  | "prices_on_page_not_extracted"
  | "no_price_text";

export interface SiteDiagnostics {
  site_platform: SitePlatform;
  /** Set only when the outcome is not `ok`. */
  no_hit_reason?: NoHitReason;
  /** A NOK price pattern ("kr 120", "120,-", "120 kr", "NOK 120") in the visible text of a fetched page. */
  has_price_text: boolean;
  /** A link to a second listing page (?page=2, /page/2, side=2) on a fetched page. */
  has_pagination_hint: boolean;
  /** HTML pages read (homepage + product pages); 0 when a structured tier answered. */
  pages_seen: number;
}

// Fingerprints, checked in this order; the first match wins. Conservative:
// asset hosts, generator meta and platform-specific attributes only — never
// a mere mention in body text. WooCommerce before WordPress (it runs on it).
const PLATFORM_FINGERPRINTS: ReadonlyArray<{ platform: SitePlatform; re: RegExp }> = [
  { platform: "shopify", re: /cdn\.shopify\.com|\.myshopify\.com|Shopify\.theme\b/i },
  { platform: "woocommerce", re: /\bwoocommerce\b|\bwc-block-|\/plugins\/woocommerce\//i },
  { platform: "wix", re: /static\.wixstatic\.com|static\.parastorage\.com|<meta\b[^>]*\bgenerator\b[^>]*\bwix\.com/i },
  { platform: "squarespace", re: /static1\.squarespace\.com|assets\.squarespace\.com|<!-- This is Squarespace\. -->/i },
  { platform: "mystore", re: /\bmystore\.no\b|<meta\b[^>]*\bgenerator\b[^>]*\bmystore\b/i },
  { platform: "webflow", re: /\bdata-wf-(?:site|page)\b|<meta\b[^>]*\bgenerator\b[^>]*\bwebflow\b/i },
  { platform: "jimdo", re: /\bjimstatic\.com|\bjimdo(?:cdn|free|site)?\.com|<meta\b[^>]*\bgenerator\b[^>]*\bjimdo\b/i },
  { platform: "wordpress", re: /\/wp-content\/|\/wp-includes\/|<meta\b[^>]*\bgenerator\b[^>]*\bwordpress\b/i },
];

/** Generic cart / checkout signals of a shop on no recognised platform. */
const SHOP_SIGNALS = /add[-_ ]to[-_ ]cart|legg (?:i|til i) (?:handle)?kurv|handlekurv|href=["'][^"']*\/(?:cart|checkout|kasse|handlekurv)\b|snipcart|ecwid/i;

/**
 * The site's platform. A structured-tier hit (shopify / woocommerce) is
 * authoritative; otherwise HTML fingerprints decide. No HTML at all →
 * `unknown`; readable HTML with no signal → `plain`. Deterministic. PURE.
 */
export function detectSitePlatform(input: {
  html?: string | null;
  tier?: ProductImportTier | null;
  /** Optional response headers (name → value); scanned like the HTML. */
  headers?: Record<string, string> | null;
}): SitePlatform {
  if (input.tier === "shopify" || input.tier === "woocommerce") return input.tier;
  const html = input.html ?? "";
  const headerText = input.headers
    ? Object.entries(input.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : "";
  if (headerText && /\bx-shopify-|\bx-shopid\b/i.test(headerText)) return "shopify";
  if (headerText && /\bx-wix-/i.test(headerText)) return "wix";
  if (!html.trim()) return "unknown";
  for (const { platform, re } of PLATFORM_FINGERPRINTS) if (re.test(html)) return platform;
  if (SHOP_SIGNALS.test(html)) return "other_shop";
  return "plain";
}

// "kr 120", "kr. 120", "120 kr", "120,-", "120,50 kr", "NOK 120", "120 NOK".
const PRICE_TEXT =
  /\b(?:kr\.?|nok)\s?\d{1,3}(?:[ .\u00a0]?\d{3})*(?:,\d{1,2})?\b|\b\d{1,3}(?:[ .\u00a0]?\d{3})*(?:,\d{1,2})?\s?(?:,-|kr(?:oner)?\b|nok\b)|\b\d+,-/i;

/** Whether visible text carries a NOK price pattern. PURE. */
export function hasNokPriceText(text: string): boolean {
  return PRICE_TEXT.test(text);
}

const PAGINATION_HREF = /href=["'][^"']*(?:[?&](?:page|side|p|paged|product-page)=2\b|\/(?:page|side)\/2\b)/i;

/** Whether the HTML links to a second listing page. PURE. */
export function hasPaginationHint(html: string): boolean {
  return PAGINATION_HREF.test(html);
}

/**
 * Why a site yielded no products, from the result alone. `undefined` for
 * `ok`. A rule exclusion is named before the LLM budget, a price pattern on
 * the page before "no price text". PURE.
 */
export function diagnoseNoHit(input: {
  outcome: string;
  llm_status?: string | null;
  excluded_count?: number;
  has_price_text: boolean;
}): NoHitReason | undefined {
  const o = input.outcome;
  if (o === "ok") return undefined;
  if (o.startsWith("fetch_failed")) return "fetch_failed";
  if (o === "robots_blocked") return "robots_blocked";
  if (o === "js_unreadable") return "js_shell";
  if (o === "grounding_rejected_all") return "grounding_rejected_all";
  if ((input.excluded_count ?? 0) > 0) return "excluded_by_rules";
  if (input.llm_status === "budget_exhausted") return "llm_budget_exhausted";
  return input.has_price_text ? "prices_on_page_not_extracted" : "no_price_text";
}

/** Assemble the diagnostics block from already-fetched pages. PURE. */
export function buildSiteDiagnostics(input: {
  outcome: string;
  tier: ProductImportTier | null;
  /** shopify / woocommerce when that tier answered, even with every candidate excluded. */
  structuredTier?: ProductImportTier | null;
  llm_status?: string | null;
  excluded_count: number;
  pages: ReadonlyArray<{ html: string; text: string }>;
}): SiteDiagnostics {
  const html = input.pages.map((p) => p.html).join("\n");
  const has_price_text = input.pages.some((p) => hasNokPriceText(p.text));
  const d: SiteDiagnostics = {
    site_platform: detectSitePlatform({ html, tier: input.tier ?? input.structuredTier ?? null }),
    has_price_text,
    has_pagination_hint: input.pages.some((p) => hasPaginationHint(p.html)),
    pages_seen: input.pages.length,
  };
  const reason = diagnoseNoHit({
    outcome: input.outcome,
    llm_status: input.llm_status,
    excluded_count: input.excluded_count,
    has_price_text,
  });
  if (reason) d.no_hit_reason = reason;
  return d;
}
