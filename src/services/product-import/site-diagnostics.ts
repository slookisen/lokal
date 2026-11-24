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
  | "llm_failed"
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
// asset hosts / paths, platform-specific attributes and the generator meta
// tag only — never a mere mention in body text. WooCommerce before
// WordPress (it runs on it). `html` is tested against the whole page,
// `generator` against the text after "generator" in a <meta> tag
// (generatorMetaTexts). Every pattern is linear-time on hostile HTML.
const PLATFORM_FINGERPRINTS: ReadonlyArray<{ platform: SitePlatform; html?: RegExp; generator?: RegExp }> = [
  { platform: "shopify", html: /cdn\.shopify\.com|\.myshopify\.com|Shopify\.theme\b/i },
  {
    platform: "woocommerce",
    // Plugin asset path, a wc-* / woocommerce-* script or style handle
    // (id="wc-add-to-cart-js", id="woocommerce-layout-css"), or a
    // woocommerce / wc-block-* CSS class — not the word in body text.
    html: /\/plugins\/woocommerce\/|\bid=["'](?:wc|woocommerce)-[\w-]{1,80}-(?:js|css)["']|\bclass=["'][^"']{0,500}?(?:\bwoocommerce\b|\bwc-block-)/i,
    generator: /\bwoocommerce\b/i,
  },
  { platform: "wix", html: /static\.wixstatic\.com|static\.parastorage\.com/i, generator: /\bwix\.com/i },
  { platform: "squarespace", html: /static1\.squarespace\.com|assets\.squarespace\.com|<!-- This is Squarespace\. -->/i },
  {
    platform: "mystore",
    // An asset served from a mystore.no host (src=, or a .css/.js href) —
    // not "mystore.no" written in the text or a plain link to it.
    html: /\bsrc=["'](?:https?:)?\/\/(?:[\w-]{1,63}\.){0,4}mystore\.no\/|\bhref=["'](?:https?:)?\/\/(?:[\w-]{1,63}\.){0,4}mystore\.no\/[^"'\s>]{0,300}?\.(?:css|js)\b/i,
    generator: /\bmystore\b/i,
  },
  { platform: "webflow", html: /\bdata-wf-(?:site|page)\b/i, generator: /\bwebflow\b/i },
  { platform: "jimdo", html: /\bjimstatic\.com|\bjimdo(?:cdn|free|site)?\.com/i, generator: /\bjimdo\b/i },
  { platform: "wordpress", html: /\/wp-content\/|\/wp-includes\//i, generator: /\bwordpress\b/i },
];

/** Chars of one <meta> tag read for the generator (longer tags are cut). */
const META_TAG_MAX_CHARS = 1000;

/**
 * For each `<meta …generator…>` tag, the tag text after its first
 * "generator" (where the platform name sits). Linear-time: one pass over
 * the `<meta` tags, each read up to its ">" (at most META_TAG_MAX_CHARS),
 * instead of the quadratic `<meta\b[^>]*\bgenerator\b[^>]*…`. PURE.
 */
export function generatorMetaTexts(html: string): string[] {
  const out: string[] = [];
  const re = /<meta\b/gi;
  let gtAt = -2;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const start = m.index;
    // Next ">" (positions only grow, so this stays linear).
    if (gtAt !== -1 && gtAt < start) gtAt = html.indexOf(">", start);
    const end = Math.min(gtAt < 0 ? html.length : gtAt, start + META_TAG_MAX_CHARS);
    const tag = html.slice(start, end);
    const g = /\bgenerator\b/i.exec(tag);
    if (g) out.push(tag.slice(g.index + g[0].length));
    // A later "<meta" inside this tag reads a suffix of it: nothing new.
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return out;
}

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
  const generators = generatorMetaTexts(html);
  for (const { platform, html: htmlRe, generator } of PLATFORM_FINGERPRINTS) {
    if (htmlRe?.test(html)) return platform;
    if (generator && generators.some((g) => generator.test(g))) return platform;
  }
  if (SHOP_SIGNALS.test(html)) return "other_shop";
  return "plain";
}

// "kr 120", "kr. 120", "120 kr", "120,-", "120,50 kr", "NOK 120", "120 NOK".
// Digit runs are capped (at most 12 digits in groups, 9 before a bare ",-")
// so a long run of digit groups with no price after
// it cannot make the pattern backtrack quadratically.
const PRICE_TEXT =
  /\b(?:kr\.?|nok)\s?\d{1,3}(?:[ .\u00a0]?\d{3}){0,3}(?:,\d{1,2})?\b|\b\d{1,3}(?:[ .\u00a0]?\d{3}){0,3}(?:,\d{1,2})?\s?(?:,-|kr(?:oner)?\b|nok\b)|\b\d{1,9},-/i;

/** Whether visible text carries a NOK price pattern. PURE. */
export function hasNokPriceText(text: string): boolean {
  return PRICE_TEXT.test(text);
}

const PAGINATION_HREF = /href=["'][^"']*(?:[?&](?:page|side|p|paged|product-page)=2\b|\/(?:page|side)\/2\b)/i;

/** Whether the HTML links to a second listing page. PURE. */
export function hasPaginationHint(html: string): boolean {
  return PAGINATION_HREF.test(html);
}

/** LLM parse statuses (./llm.ts LlmParseStatus) that mean the call itself failed. */
const LLM_FAILED_STATUSES: ReadonlySet<string> = new Set(["infra_failure", "invalid_json", "not_array"]);

/**
 * Why a site yielded no products, from the result alone. `undefined` for
 * `ok`. A rule exclusion is named before the LLM budget, the budget before
 * a failed LLM call, and a price pattern on the page before "no price
 * text". PURE.
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
  // The LLM tier ran but gave no usable answer (call failed / not JSON / not
  // an array) — not the same as "the page has no prices". `sentinel` is the
  // model's own "no products" answer and falls through.
  if (LLM_FAILED_STATUSES.has(input.llm_status ?? "")) return "llm_failed";
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
