// ─── Product import extractor (Skive 1) ─────────────────────────────────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 1:
// given a profile's website URL, find the products and prices the producer
// publishes there. READ-ONLY: this module returns candidates and never writes
// anywhere — no DB access at all.
//
// Fetching:
//   • every request goes through fetchPage() (SSRF guard, timeouts, honest
//     Lokal-RFB-Scraper UA, classified failures);
//   • SAME HOST ONLY: the website's host and its www/non-www twin. Any other
//     URL (a link, a permalink, a redirect target) is rejected and recorded;
//   • robots.txt is read first and honoured for our UA and `*`
//     (services/product-import/robots.ts); `Disallow: /` → `robots_blocked`
//     and no further page is fetched;
//   • at most PRODUCT_IMPORT_MAX_FETCHES requests per profile (robots.txt not
//     counted), paced per host by the injected pacer.
//
// Tiers, most precise first; the first tier that yields products wins:
//   1 Shopify /products.json → 2 WooCommerce Store API → 3 JSON-LD Product/
//   Offer on the fetched pages → 4 LLM on the product pages (grounded).
//
// Outcome per profile: ok | no_products_found | robots_blocked |
// fetch_failed:<reason> | js_unreadable | grounding_rejected_all.

import { fetchPage, isSafeFetchUrl, type FetchPageResult } from "../fetch-page";
import { decodeHtmlEntities } from "../description-quality";
import {
  getCachedRobots,
  isPathAllowed,
  parseRobotsTxt,
  setCachedRobots,
  type RobotsPolicy,
} from "./robots";
import {
  parseJsonLdProducts,
  parseShopifyProductsJson,
  parseWooStoreProducts,
  type ProductCandidate,
  type ProductImportTier,
  type WooExcluded,
} from "./structured";
import {
  buildProductImportPrompt,
  defaultProductImportLlm,
  groundLlmItems,
  groundingHaystack,
  parseLlmAnswer,
  PRODUCT_IMPORT_LLM_SOURCE_CHAR_CAP,
  type LlmParseStatus,
  type ProductImportLlm,
} from "./llm";
import { PRODUCT_IMPORT_MAX_PRODUCTS, productNameKey } from "./normalize";
import { applyCandidateRules, type ExcludedCandidate } from "./rules";

export type { ProductCandidate, ProductImportTier } from "./structured";
export type { ExcludedCandidate } from "./rules";

export const PRODUCT_IMPORT_USER_AGENT = "Lokal-RFB-Scraper/1.0 (+https://rettfrabonden.com)";
/** Requests per profile, robots.txt excluded (spec: "maks ~8 sider"). */
export const PRODUCT_IMPORT_MAX_FETCHES = 8;
/** Bodies longer than this (chars, ~2 MB) are truncated before extraction. */
export const PRODUCT_IMPORT_MAX_BODY_CHARS = 2_000_000;
/** Below this many visible characters across all fetched pages (on a script-built page) → js_unreadable. */
export const JS_UNREADABLE_MIN_CHARS = 150;
export const PRODUCT_IMPORT_FETCH_TIMEOUT_MS = 10_000;

export type ProductImportOutcome =
  | "ok"
  | "no_products_found"
  | "robots_blocked"
  | `fetch_failed:${string}`
  | "js_unreadable"
  | "grounding_rejected_all";

export type LlmStatus = "not_needed" | "budget_exhausted" | LlmParseStatus;

export interface ProductImportResult {
  website: string;
  outcome: ProductImportOutcome;
  tier: ProductImportTier | null;
  products: ProductCandidate[];
  /** Candidates dropped by a rule (service/event, password-protected), with the reason. */
  excluded: ExcludedCandidate[];
  pages_fetched: number;
  fetched_urls: string[];
  rejected_urls: Array<{ url: string; reason: string }>;
  robots_skipped: string[];
  llm_calls: number;
  llm_status: LlmStatus;
  grounding: { llm_candidates: number; names_rejected: number; prices_rejected: number };
  duration_ms: number;
}

/** Shared per-run LLM budget (the dry run's total cap). */
export interface LlmBudget {
  cap: number;
  used: number;
}

/** Per-host pacing: at least `minIntervalMs` between two requests to one host. */
export class HostPacer {
  private last = new Map<string, number>();
  constructor(
    private minIntervalMs: number,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  async wait(host: string): Promise<void> {
    const key = host.toLowerCase().replace(/^www\./, "");
    for (;;) {
      const prev = this.last.get(key);
      const t = this.now();
      if (prev === undefined || t - prev >= this.minIntervalMs) {
        this.last.set(key, t);
        return;
      }
      await this.sleep(this.minIntervalMs - (t - prev));
    }
  }
}

export interface ProductImportDeps {
  /** Network stub for tests; passed to fetchPage(). Default: global fetch. */
  fetchImpl?: typeof fetch;
  llm?: ProductImportLlm;
  llmBudget?: LlmBudget;
  pacer?: HostPacer;
  now?: () => number;
  /** Passed to fetchPage() for its 429 wait. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** The website's host and its www/non-www twin. PURE. */
export function allowedHostsFor(hostname: string): Set<string> {
  const h = hostname.toLowerCase();
  const bare = h.replace(/^www\./, "");
  return new Set([bare, `www.${bare}`]);
}

/** Whether `url` is on one of the allowed hosts (http/https only). PURE. */
export function isAllowedHost(url: string, allowed: ReadonlySet<string>): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return allowed.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Visible text with entities DECODED (grounding needs the real characters). PURE. */
export function pageTextOf(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(stripped)
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const PRODUCT_LINK_PATTERNS: ReadonlyArray<{ re: RegExp; score: number }> = [
  { re: /prisliste|priser|\bpris\b/i, score: 4 },
  { re: /produkt|product|varer|\bvare\b|sortiment/i, score: 3 },
  { re: /nettbutikk|butikk|shop|bestill|kjøp|handle/i, score: 2 },
  { re: /meny|utsalg|gårdsbutikk|salg/i, score: 1 },
];

/** Same-host links that look like product / price pages, ranked. PURE. */
export function discoverProductLinks(
  html: string,
  baseUrl: string,
  allowed: ReadonlySet<string>,
  max: number,
): { links: string[]; rejected: string[] } {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { links: [], rejected: [] };
  }
  const scored = new Map<string, number>();
  const rejected = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi)) {
    const rawHref = decodeHtmlEntities(m[1]!);
    if (rawHref.startsWith("#") || /^(mailto|tel|javascript):/i.test(rawHref)) continue;
    let abs: URL;
    try {
      abs = new URL(rawHref, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    abs.hash = "";
    if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|css|js)$/i.test(abs.pathname)) continue;
    const linkText = m[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    let path = abs.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* malformed escape: match on the raw path */
    }
    const haystack = `${path} ${linkText}`;
    let best = 0;
    for (const { re, score } of PRODUCT_LINK_PATTERNS) if (re.test(haystack)) best = Math.max(best, score);
    if (best === 0) continue;
    if (!allowed.has(abs.hostname.toLowerCase())) {
      rejected.add(abs.toString());
      continue;
    }
    if (abs.pathname === base.pathname && abs.search === base.search) continue;
    const key = abs.toString();
    scored.set(key, Math.max(scored.get(key) ?? 0, best));
  }
  const links = [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, max))
    .map(([u]) => u);
  return { links, rejected: [...rejected] };
}

function dedupeCap(items: ProductCandidate[]): ProductCandidate[] {
  const seen = new Set<string>();
  const out: ProductCandidate[] = [];
  for (const it of items) {
    const k = productNameKey(it.name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= PRODUCT_IMPORT_MAX_PRODUCTS) break;
  }
  return out;
}

/**
 * Extract product candidates from one profile's website. Never throws; never
 * writes. Every failure is an outcome.
 */
export async function extractProductsFromWebsite(
  website: string,
  deps: ProductImportDeps = {},
): Promise<ProductImportResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const result: ProductImportResult = {
    website,
    outcome: "no_products_found",
    tier: null,
    products: [],
    excluded: [],
    pages_fetched: 0,
    fetched_urls: [],
    rejected_urls: [],
    robots_skipped: [],
    llm_calls: 0,
    llm_status: "not_needed",
    grounding: { llm_candidates: 0, names_rejected: 0, prices_rejected: 0 },
    duration_ms: 0,
  };
  const finish = (outcome: ProductImportOutcome): ProductImportResult => {
    result.outcome = outcome;
    result.duration_ms = Math.max(0, now() - started);
    return result;
  };

  const raw = (website || "").trim();
  let site: URL;
  try {
    site = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (site.protocol !== "http:" && site.protocol !== "https:") throw new Error("protocol");
  } catch {
    return finish("fetch_failed:invalid_url");
  }
  if (!isSafeFetchUrl(site.toString())) {
    result.rejected_urls.push({ url: site.toString(), reason: "ssrf_blocked" });
    return finish("fetch_failed:ssrf_blocked");
  }
  site.hash = "";
  const origin = site.origin;
  const allowed = allowedHostsFor(site.hostname);

  const doFetch = async (
    url: string,
    kind: "html" | "json" | "text",
    counted: boolean,
  ): Promise<FetchPageResult | { ok: false; reason: "offhost" | "fetch_cap"; detail: string }> => {
    if (!isAllowedHost(url, allowed)) {
      result.rejected_urls.push({ url, reason: "other_host" });
      return { ok: false, reason: "offhost", detail: "other host" };
    }
    if (counted && result.pages_fetched >= PRODUCT_IMPORT_MAX_FETCHES) {
      return { ok: false, reason: "fetch_cap", detail: "fetch cap" };
    }
    if (counted) result.pages_fetched++;
    if (deps.pacer) await deps.pacer.wait(new URL(url).hostname);
    const r = await fetchPage(url, {
      userAgent: PRODUCT_IMPORT_USER_AGENT,
      timeoutMs: deps.timeoutMs ?? PRODUCT_IMPORT_FETCH_TIMEOUT_MS,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      now: deps.now,
      ...(kind === "json"
        ? { accept: "application/json", allowNonHtmlBody: true }
        : kind === "text"
          ? { accept: "text/plain,*/*;q=0.5", allowNonHtmlBody: true }
          : {}),
    });
    if (counted) result.fetched_urls.push(url);
    if (r.ok && !isAllowedHost(r.finalUrl, allowed)) {
      // Redirected off the profile's own host: the body is not theirs.
      result.rejected_urls.push({ url: r.finalUrl, reason: "offhost_redirect" });
      return { ok: false, reason: "offhost", detail: "redirected to other host" };
    }
    if (!r.ok && r.reason === "ssrf_blocked") result.rejected_urls.push({ url, reason: "ssrf_blocked" });
    // Bound the text every downstream regex/parser sees.
    if (r.ok && r.html.length > PRODUCT_IMPORT_MAX_BODY_CHARS) {
      return { ...r, html: r.html.slice(0, PRODUCT_IMPORT_MAX_BODY_CHARS) };
    }
    return r;
  };

  // ── robots.txt ────────────────────────────────────────────────────────────
  let policy: RobotsPolicy | null = getCachedRobots(site.hostname, now());
  if (!policy) {
    const r = await doFetch(`${origin}/robots.txt`, "text", false);
    if (r.ok) {
      policy = parseRobotsTxt(r.html);
    } else if ("persistence" in r && r.status !== null && r.status >= 400 && r.status < 500) {
      policy = { rules: [], matched: "none" }; // no robots.txt published = allowed
    } else {
      return finish(`fetch_failed:${r.reason}`);
    }
    setCachedRobots(site.hostname, policy, now());
  }
  const allowedByRobots = (url: string): boolean => {
    const u = new URL(url);
    const ok = isPathAllowed(policy!, u.pathname + u.search);
    if (!ok) result.robots_skipped.push(url);
    return ok;
  };
  if (!allowedByRobots(`${origin}/`) || !allowedByRobots(site.toString())) {
    return finish("robots_blocked");
  }

  // The candidate rules (./rules.ts) run before dedupe/cap. A tier that
  // FOUND candidates but excluded every one (a shop selling only events) is
  // the answer: no_products_found, with the exclusions recorded. It never
  // falls through to the HTML/LLM tiers, which only see names and would
  // bring the same events back (and spend an LLM call).
  const done = (tier: ProductImportTier, items: ProductCandidate[]): ProductImportResult => {
    const { kept, excluded } = applyCandidateRules(items);
    result.excluded.push(...excluded);
    if (kept.length === 0) return finish("no_products_found");
    result.tier = tier;
    result.products = dedupeCap(kept);
    return finish("ok");
  };

  // ── Tier 1: Shopify ───────────────────────────────────────────────────────
  const shopifyUrl = `${origin}/products.json?limit=250`;
  if (allowedByRobots(shopifyUrl)) {
    const r = await doFetch(shopifyUrl, "json", true);
    if (r.ok) {
      const items = parseShopifyProductsJson(r.html, origin, allowed);
      if (items.length > 0) return done("shopify", items);
    }
  }

  // ── Tier 2: WooCommerce Store API ─────────────────────────────────────────
  const wooUrl = `${origin}/wp-json/wc/store/v1/products?per_page=100`;
  if (allowedByRobots(wooUrl)) {
    const r = await doFetch(wooUrl, "json", true);
    if (r.ok) {
      const wooExcluded: WooExcluded[] = [];
      const items = parseWooStoreProducts(r.html, origin, allowed, wooExcluded);
      result.excluded.push(...wooExcluded);
      if (items.length > 0 || wooExcluded.length > 0) return done("woocommerce", items);
    }
  }

  // ── Homepage + product pages ─────────────────────────────────────────────
  const home = await doFetch(site.toString(), "html", true);
  if (!home.ok) return finish(`fetch_failed:${home.reason}`);
  const pages: Array<{ url: string; html: string; text: string }> = [
    { url: home.finalUrl, html: home.html, text: pageTextOf(home.html) },
  ];
  const discovered = discoverProductLinks(
    home.html,
    home.finalUrl,
    allowed,
    PRODUCT_IMPORT_MAX_FETCHES - result.pages_fetched,
  );
  for (const u of discovered.rejected) result.rejected_urls.push({ url: u, reason: "other_host" });
  const productPages: typeof pages = [];
  for (const link of discovered.links) {
    if (result.pages_fetched >= PRODUCT_IMPORT_MAX_FETCHES) break;
    if (!allowedByRobots(link)) continue;
    const r = await doFetch(link, "html", true);
    if (r.ok) productPages.push({ url: r.finalUrl, html: r.html, text: pageTextOf(r.html) });
  }
  pages.push(...productPages);

  // ── Tier 3: JSON-LD ───────────────────────────────────────────────────────
  const ld: ProductCandidate[] = [];
  for (const p of pages) ld.push(...parseJsonLdProducts(p.html, p.url, allowed));
  if (ld.length > 0) return done("jsonld", ld);

  // js_unreadable: almost no visible text AND the page is a script shell —
  // a short but plain static page still goes to the LLM tier.
  const totalText = pages.reduce((n, p) => n + p.text.length, 0);
  const scriptShell = pages.some((p) => /<script\b/i.test(p.html));
  if (totalText < JS_UNREADABLE_MIN_CHARS && (scriptShell || totalText === 0)) return finish("js_unreadable");

  // ── Tier 4: LLM ───────────────────────────────────────────────────────────
  // Product pages first, the homepage last — same ordering as
  // gardssalgProductSourceText, so a long front page cannot eat the budget.
  const ordered = [...productPages, pages[0]!];
  const sourceText = ordered.map((p) => p.text).join("\n\n").slice(0, PRODUCT_IMPORT_LLM_SOURCE_CHAR_CAP);
  if (deps.llmBudget) {
    if (deps.llmBudget.used >= deps.llmBudget.cap) {
      result.llm_status = "budget_exhausted";
      return finish("no_products_found");
    }
    deps.llmBudget.used++; // reserved before the await: the cap is never overshot
  }
  const llm = deps.llm ?? defaultProductImportLlm;
  result.llm_calls = 1;
  let answer: { text: string | null };
  try {
    answer = await llm(buildProductImportPrompt(sourceText));
  } catch {
    answer = { text: null };
  }
  const parsed = parseLlmAnswer(answer.text);
  result.llm_status = parsed.status;
  if (parsed.status !== "ok" || parsed.items.length === 0) return finish("no_products_found");
  const grounded = groundLlmItems(parsed.items, sourceText);
  result.grounding = {
    llm_candidates: parsed.items.length,
    names_rejected: grounded.names_rejected,
    prices_rejected: grounded.prices_rejected,
  };
  if (grounded.items.length === 0) return finish("grounding_rejected_all");
  const items: ProductCandidate[] = grounded.items.map((g) => {
    const key = groundingHaystack(g.name);
    const page = ordered.find((p) => groundingHaystack(p.text).includes(key)) ?? ordered[0]!;
    return { ...g, source_url: page.url, tier: "llm" as const };
  });
  return done("llm", items);
}
