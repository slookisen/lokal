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
  statesExclVat,
  type ProductUnit,
} from "./normalize";
import { dropPrice, gateVerdict, isEventShopCategory, markExclVat } from "./rules";

export type ProductImportTier = "shopify" | "woocommerce" | "jsonld" | "llm";

/**
 * Stock status as the site states it in structured form (dev-request
 * 2026-11-21-rfb-produktimport-lagerstatus-og-fullstendighet, point 3).
 * "unknown" when the site says nothing usable; the LLM tier never sets it.
 */
export type StockStatus = "in_stock" | "out_of_stock" | "unknown";

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
  /**
   * Set (true) only when the source marks the price as EXCLUDING VAT
   * («ekskl. mva.»); absent otherwise. Such a price is never a consumer
   * price without the mark (price_text carries it too).
   */
  price_excl_vat?: true;
  /**
   * The site's stock status (Shopify variant `available`, Store API
   * `is_in_stock`, JSON-LD `offers.availability`). Absent = unknown. Only
   * applied with PRODUCT_IMPORT_STOCK_READ_ENABLED on (the extractor drops
   * it with the flag off).
   */
  stock_status?: StockStatus;
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

// ── Stock status (PURE) ─────────────────────────────────────────────────────

/**
 * Flag: "1"/"true" makes the import and the weekly auto-sync apply the site's
 * stock status (a product the site says is sold out → out_of_stock). Anything
 * else = off: the status is not even kept on the candidates, so the
 * behaviour is as before.
 */
export const PRODUCT_IMPORT_STOCK_READ_FLAG = "PRODUCT_IMPORT_STOCK_READ_ENABLED";
export function productImportStockReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[PRODUCT_IMPORT_STOCK_READ_FLAG];
  return v === "1" || v === "true";
}

/** Shopify: sold out iff ≥ 1 variant and every variant has available === false; any true → in stock. */
export function shopifyStockStatus(variants: unknown[]): StockStatus {
  let anyFalse = false;
  let allFalse = variants.length > 0;
  for (const v of variants) {
    const a = v && typeof v === "object" ? (v as { available?: unknown }).available : undefined;
    if (a === true) return "in_stock";
    if (a === false) anyFalse = true;
    else allFalse = false;
  }
  return allFalse && anyFalse ? "out_of_stock" : "unknown";
}

/** WooCommerce Store API: `is_in_stock` boolean; anything else → unknown. */
export function wooStockStatus(p: { is_in_stock?: unknown }): StockStatus {
  if (p.is_in_stock === true) return "in_stock";
  if (p.is_in_stock === false) return "out_of_stock";
  return "unknown";
}

const SCHEMA_SOLD_OUT = new Set(["outofstock", "soldout", "discontinued"]);
const SCHEMA_IN_STOCK = new Set(["instock", "limitedavailability", "onlineonly", "instoreonly"]);

/**
 * One schema.org ItemAvailability value: a full URL (http or https,
 * schema.org), «schema:InStock» or the bare name. PreOrder, BackOrder and
 * everything else → unknown.
 */
export function schemaAvailabilityStatus(v: unknown): StockStatus {
  const raw = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as any)["@id"] === "string" ? (v as any)["@id"] : null;
  if (raw === null) return "unknown";
  let t = raw.trim();
  const m = /^https?:\/\/(?:www\.)?schema\.org\/(\w+)\/?$/i.exec(t);
  if (m) t = m[1]!;
  else if (/^schema:\w+$/i.test(t)) t = t.slice(7);
  else if (!/^\w+$/.test(t)) return "unknown";
  const k = t.toLowerCase();
  if (SCHEMA_SOLD_OUT.has(k)) return "out_of_stock";
  if (SCHEMA_IN_STOCK.has(k)) return "in_stock";
  return "unknown";
}

/**
 * Several offers, the same rule as shopifyStockStatus: in stock if any is;
 * sold out only if there is ≥ 1 offer and EVERY offer is explicitly sold out.
 * Sold out mixed with unknown (PreOrder, missing, unparseable) → unknown —
 * a false «utsolgt» is never undone by the weekly sync, so fail safe.
 */
export function combineStockStatus(statuses: StockStatus[]): StockStatus {
  if (statuses.includes("in_stock")) return "in_stock";
  if (statuses.length > 0 && statuses.every((s) => s === "out_of_stock")) return "out_of_stock";
  return "unknown";
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
      stock_status: shopifyStockStatus(variants),
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
      stock_status: wooStockStatus(p),
    };
    if (verdict === "alcohol") c.rules.push("flag_alcohol");
    // Not purchasable («Les mer», «kontakt oss», no buy button): the Store
    // API reports price "0" or a stale price that is not on sale. An
    // external/affiliate product is never purchasable here but shows a real
    // price, so it keeps it.
    if (p.is_purchasable === false && p.type !== "external" && c.price_nok !== null) dropPrice(c, "price_not_purchasable");
    // The shop's own price display carries the VAT suffix
    // («<small class="woocommerce-price-suffix">ekskl. mva.</small>»).
    if (c.price_nok !== null && typeof p.price_html === "string" && statesExclVat(htmlToText(p.price_html))) markExclVat(c);
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

function htmlToText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function hasType(node: any, type: string): boolean {
  const t = node?.["@type"];
  if (typeof t === "string") return t === type || t === `schema:${type}` || t.endsWith(`/${type}`);
  if (Array.isArray(t)) return t.some((x) => typeof x === "string" && (x === type || x.endsWith(`/${type}`)));
  return false;
}

export function collectNodes(v: unknown, out: any[], depth = 0): void {
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
      let exclVat = false;
      const stock: StockStatus[] = [];
      for (const offer of offers) {
        if (!offer || typeof offer !== "object") continue;
        const spec = Array.isArray(offer.priceSpecification) ? offer.priceSpecification[0] : offer.priceSpecification;
        const currency = offer.priceCurrency ?? spec?.priceCurrency;
        if (!isNok(currency)) continue;
        // Availability only from the offers the price logic accepts (NOK). No
        // accepted offer → stock stays empty → combineStockStatus gives unknown
        // (fail safe: never a sold-out mark from a non-NOK offer).
        stock.push(schemaAvailabilityStatus(offer.availability));
        const vatIncl = spec?.valueAddedTaxIncluded ?? offer.valueAddedTaxIncluded;
        if (vatIncl === false || vatIncl === "false" || vatIncl === "False") exclVat = true;
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
      const c: ProductCandidate = {
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
        stock_status: combineStockStatus(stock),
      };
      if (exclVat) markExclVat(c);
      out.push(c);
    }
  }
  return out;
}
