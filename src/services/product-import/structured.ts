// ─── Product import: structured tiers 1–3 (PURE parsers) ────────────────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 1.
//   tier 1  Shopify          GET /products.json
//   tier 2  WooCommerce      GET /wp-json/wc/store/v1/products
//   tier 3  schema.org       Product / Offer in <script type="application/ld+json">
//
// Each parser takes an already-fetched body and returns candidates; none of
// them fetches. Invalid JSON is never repaired: a body JSON.parse rejects
// yields no candidates from that body.

import { decodeHtmlEntities } from "../description-quality";
import {
  detectPriceUnit,
  detectSizeUnit,
  formatPriceText,
  normalizeProductName,
  parseMachinePrice,
  roundNok,
  type ProductUnit,
} from "./normalize";
import { dropPrice, gateVerdict, isEventShopCategory } from "./rules";

export type ProductImportTier = "shopify" | "woocommerce" | "jsonld" | "llm";

export interface ProductCandidate {
  name: string;
  price_nok: number | null;
  price_text: string;
  unit: ProductUnit | null;
  price_is_from: boolean;
  source_url: string;
  tier: ProductImportTier;
  /**
   * The price exactly as the source had it, before any rule (Shopify variant
   * prices, the Store API's minor-unit price fields, JSON-LD offer prices,
   * the model's price string). null when the source had none. For audit.
   */
  raw_price_text: string | null;
  /** The pack weight/volume when the unit was a pack size («10 kg»), else null. */
  pack_size: string | null;
  /** The rules (./rules.ts) that changed this candidate, e.g. price_zero_dropped. */
  rules: string[];
}

/** A Store API product excluded before it became a candidate. */
export interface WooExcluded {
  name: string;
  source_url: string;
  tier: "woocommerce";
  reason: "excluded_service" | "excluded_event_category" | "excluded_password_protected" | "excluded_check_failed";
  raw_price_text: string | null;
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Resolve `href` against `base`; null unless it lands on an allowed host. */
function sameHostUrl(href: unknown, base: string, allowedHosts: ReadonlySet<string>): string | null {
  if (typeof href !== "string" || !href.trim()) return null;
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!allowedHosts.has(u.hostname.toLowerCase())) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function isNok(currency: unknown): boolean {
  return currency === undefined || currency === null || currency === "" || String(currency).toUpperCase() === "NOK";
}

// ── Tier 1: Shopify /products.json ──────────────────────────────────────────

export function parseShopifyProductsJson(
  body: string,
  origin: string,
  allowedHosts: ReadonlySet<string>,
): ProductCandidate[] {
  const parsed = safeJsonParse(body) as { products?: unknown } | undefined;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.products)) return [];
  const out: ProductCandidate[] = [];
  for (const p of parsed.products as any[]) {
    if (!p || typeof p !== "object") continue;
    const name = normalizeProductName(decodeHtmlEntities(String(p.title ?? "")));
    if (!name) continue;
    const variants: any[] = Array.isArray(p.variants) ? p.variants : [];
    const priced = variants
      .map((v) => ({ price: parseMachinePrice(v?.price), title: typeof v?.title === "string" ? v.title : "" }))
      .filter((v) => v.price !== null) as Array<{ price: number; title: string }>;
    let price: number | null = null;
    let isFrom = false;
    let unit: ProductUnit | null = null;
    if (priced.length > 0) {
      const min = priced.reduce((a, b) => (b.price < a.price ? b : a));
      price = roundNok(min.price);
      isFrom = priced.some((v) => v.price !== min.price);
      const t = min.title && min.title !== "Default Title" ? min.title : "";
      unit = detectSizeUnit(t) ?? detectPriceUnit(name);
    } else {
      unit = detectPriceUnit(name);
    }
    const rawPrices = variants.map((v) => v?.price).filter((v) => v !== undefined && v !== null).map(String);
    const handle = typeof p.handle === "string" && /^[\w-]+$/.test(p.handle) ? p.handle : null;
    const source_url = handle ? `${origin}/products/${handle}` : `${origin}/products.json`;
    out.push({
      name,
      price_nok: price,
      price_text: formatPriceText(price, "NOK", isFrom),
      unit,
      price_is_from: isFrom,
      source_url: sameHostUrl(source_url, origin, allowedHosts) ?? `${origin}/products.json`,
      tier: "shopify",
      raw_price_text: rawPrices.length ? rawPrices.join(" | ") : null,
      pack_size: null,
      rules: [],
    });
  }
  return out;
}

// ── Tier 2: WooCommerce Store API ───────────────────────────────────────────

export function parseWooStoreProducts(
  body: string,
  origin: string,
  allowedHosts: ReadonlySet<string>,
  /** Receives the products dropped here (password-protected, service/event). */
  excluded?: WooExcluded[],
): ProductCandidate[] {
  const parsed = safeJsonParse(body);
  if (!Array.isArray(parsed)) return [];
  const apiUrl = `${origin}/wp-json/wc/store/v1/products`;
  const out: ProductCandidate[] = [];
  for (const p of parsed as any[]) {
    if (!p || typeof p !== "object") continue;
    const name = normalizeProductName(decodeHtmlEntities(String(p.name ?? "")));
    if (!name) continue;
    const source_url = sameHostUrl(p.permalink, origin, allowedHosts) ?? apiUrl;
    const prices = p.prices && typeof p.prices === "object" ? p.prices : null;
    const range = prices?.price_range && typeof prices.price_range === "object" ? prices.price_range : null;
    const raw_price_text = prices
      ? `price=${String(prices.price ?? "")}` +
        (range ? ` range=${String(range.min_amount ?? "")}-${String(range.max_amount ?? "")}` : "") +
        ` minor=${String(prices.currency_minor_unit ?? "")} ${String(prices.currency_code ?? "")}`.trimEnd()
      : null;
    // A password-protected product is not on public sale (prod 2026-10-29:
    // a professional meeting behind a password).
    if (p.is_password_protected === true) {
      excluded?.push({ name, source_url, tier: "woocommerce", reason: "excluded_password_protected", raw_price_text });
      continue;
    }
    // Services / events by the cart gate's own classifier, with the shop's
    // own category names (e.g. «Arrangement») as the category.
    const categories = Array.isArray(p.categories)
      ? p.categories.map((c: any) => (typeof c?.name === "string" ? decodeHtmlEntities(c.name) : "")).filter(Boolean).join(" ")
      : "";
    if (isEventShopCategory(categories)) {
      excluded?.push({ name, source_url, tier: "woocommerce", reason: "excluded_event_category", raw_price_text });
      continue;
    }
    const verdict = gateVerdict(name, categories);
    if (verdict === "service" || verdict === "check_failed") {
      excluded?.push({
        name,
        source_url,
        tier: "woocommerce",
        reason: verdict === "service" ? "excluded_service" : "excluded_check_failed",
        raw_price_text,
      });
      continue;
    }
    let price: number | null = null;
    let isFrom = false;
    if (prices && isNok(prices.currency_code)) {
      const minor = Number.isInteger(prices.currency_minor_unit) ? prices.currency_minor_unit : 2;
      const scale = Math.pow(10, Math.max(0, Math.min(4, minor)));
      const rawMin = range ? parseMachinePrice(range.min_amount) : null;
      const rawMax = range ? parseMachinePrice(range.max_amount) : null;
      const rawPrice = rawMin ?? parseMachinePrice(prices.price);
      if (rawPrice !== null) price = roundNok(rawPrice / scale);
      // Several variations at different prices → lowest, «fra».
      isFrom = rawMin !== null && rawMax !== null && rawMin !== rawMax;
    }
    const c: ProductCandidate = {
      name,
      price_nok: price,
      price_text: formatPriceText(price, "NOK", isFrom),
      unit: detectPriceUnit(name),
      price_is_from: isFrom,
      source_url,
      tier: "woocommerce",
      raw_price_text,
      pack_size: null,
      rules: [],
    };
    if (verdict === "alcohol") c.rules.push("flag_alcohol");
    // Not purchasable («Les mer», «kontakt oss», no buy button): the Store
    // API reports price "0" or a stale price that is not on sale. An
    // external/affiliate product is never purchasable here but shows a real
    // price, so it keeps it.
    if (p.is_purchasable === false && p.type !== "external" && c.price_nok !== null) dropPrice(c, "price_not_purchasable");
    out.push(c);
  }
  return out;
}

// ── Tier 3: schema.org JSON-LD ──────────────────────────────────────────────

const UNIT_CODES: Record<string, ProductUnit> = {
  KGM: "kg",
  GRM: "g",
  LTR: "l",
  H87: "stk",
  C62: "stk",
  EA: "stk",
  PK: "pakke",
};

function hasType(node: any, type: string): boolean {
  const t = node?.["@type"];
  if (typeof t === "string") return t === type || t === `schema:${type}` || t.endsWith(`/${type}`);
  if (Array.isArray(t)) return t.some((x) => typeof x === "string" && (x === type || x.endsWith(`/${type}`)));
  return false;
}

function collectNodes(v: unknown, out: any[], depth = 0): void {
  if (depth > 8 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) collectNodes(x, out, depth + 1);
    return;
  }
  out.push(v);
  const o = v as Record<string, unknown>;
  if (o["@graph"]) collectNodes(o["@graph"], out, depth + 1);
  // ItemList → itemListElement → item
  if (o.itemListElement) collectNodes(o.itemListElement, out, depth + 1);
  if (o.item && typeof o.item === "object") collectNodes(o.item, out, depth + 1);
}

function offerUnit(offer: any): ProductUnit | null {
  const spec = Array.isArray(offer?.priceSpecification) ? offer.priceSpecification[0] : offer?.priceSpecification;
  const ref = spec?.referenceQuantity ?? offer?.eligibleQuantity;
  const code = typeof ref?.unitCode === "string" ? ref.unitCode.toUpperCase() : null;
  if (code && UNIT_CODES[code]) return UNIT_CODES[code]!;
  const text = typeof ref?.unitText === "string" ? ref.unitText : typeof spec?.unitText === "string" ? spec.unitText : null;
  return text ? detectSizeUnit(text) : null;
}

export function parseJsonLdProducts(
  html: string,
  pageUrl: string,
  allowedHosts: ReadonlySet<string>,
): ProductCandidate[] {
  const out: ProductCandidate[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const parsed = safeJsonParse(m[1]!.trim());
    if (parsed === undefined) continue; // never repaired
    const nodes: any[] = [];
    collectNodes(parsed, nodes);
    for (const node of nodes) {
      if (!hasType(node, "Product")) continue;
      const name = normalizeProductName(decodeHtmlEntities(String(node.name ?? "")));
      if (!name) continue;
      const offers: any[] = Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : [];
      let price: number | null = null;
      let isFrom = false;
      let unit: ProductUnit | null = null;
      const values: number[] = [];
      const rawPrices: string[] = [];
      for (const offer of offers) {
        if (!offer || typeof offer !== "object") continue;
        const spec = Array.isArray(offer.priceSpecification) ? offer.priceSpecification[0] : offer.priceSpecification;
        const currency = offer.priceCurrency ?? spec?.priceCurrency;
        if (!isNok(currency)) continue;
        if (hasType(offer, "AggregateOffer")) {
          if (offer.lowPrice !== undefined) rawPrices.push(`low=${String(offer.lowPrice)}`);
          if (offer.highPrice !== undefined) rawPrices.push(`high=${String(offer.highPrice)}`);
          const low = parseMachinePrice(offer.lowPrice);
          const high = parseMachinePrice(offer.highPrice);
          if (low !== null) {
            values.push(low);
            if (high === null || high !== low) isFrom = true;
          }
        } else {
          const rawP = offer.price ?? spec?.price;
          if (rawP !== undefined && rawP !== null) rawPrices.push(String(rawP));
          const p = parseMachinePrice(rawP);
          if (p !== null) values.push(p);
        }
        unit = unit ?? offerUnit(offer);
      }
      if (values.length > 0) {
        const min = Math.min(...values);
        price = roundNok(min);
        if (values.some((v) => v !== min)) isFrom = true;
      }
      unit = unit ?? detectPriceUnit(name);
      out.push({
        name,
        price_nok: price,
        price_text: formatPriceText(price, "NOK", isFrom),
        unit,
        price_is_from: isFrom,
        source_url: sameHostUrl(node.url, pageUrl, allowedHosts) ?? pageUrl,
        tier: "jsonld",
        raw_price_text: rawPrices.length ? rawPrices.join(" | ") : null,
        pack_size: null,
        rules: [],
      });
    }
  }
  return out;
}
