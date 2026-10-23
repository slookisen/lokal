/**
 * MCP Streamable HTTP Transport — Remote MCP endpoint for ChatGPT & other AI platforms
 *
 * This adds a /mcp endpoint to the Express server that speaks the MCP protocol
 * over Streamable HTTP (the transport ChatGPT, OpenAI Agents SDK, and other
 * remote clients use). Unlike the stdio MCP server (npm package), this runs
 * server-side and calls internal services directly — no HTTP round-trip.
 *
 * Endpoint: POST https://rettfrabonden.com/mcp
 *           GET  https://rettfrabonden.com/mcp  (SSE stream for notifications)
 *           DELETE https://rettfrabonden.com/mcp (session cleanup)
 *
 * ChatGPT Developer Mode: paste https://rettfrabonden.com/mcp as the MCP URL.
 */

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { marketplaceRegistry, type DiscoverMeta } from "../services/marketplace-registry";
import { knowledgeService, parseProductPrice, productPriceText, isProductHeader, isProductNoise } from "../services/knowledge-service";
import { slugify } from "../utils/slug";
import { textEntries } from "../utils/text-entries";
import { areGenericCategoryNames, isGenericCategoryName, isCategoryLabel } from "../utils/category-label";
import { openingHoursText } from "../utils/opening-hours";
import { addAiUtmParams } from "../utils/url-utm";
import { getDb } from "../database/init";
import { isDisplayablePhone } from "../services/contact-normalizer";
import { isJunkDescription, normalizeProse } from "../services/description-quality";
import { geocodingService } from "../services/geocoding-service";
import { isValidLatLng, resolveSearchRadiusKm } from "../utils/geo-query";
import { capFreeText, capName, capNameList } from "../utils/free-text";
import { mcpInternalErrorText, mcpToolInternalErrorResult } from "../utils/internal-error";
import { computeEffectiveAvailability } from "../services/supply-graph";
import { findOffers, resolveOffersRadiusKm, resolveOffersLimit } from "../services/catalog-offers";
import { formatAddressLine } from "../utils/address-format";
import { DRINK_SUBCATEGORIES } from "../services/drink-taxonomy";
import {
  createCart as svcCreateCart,
  checkCartToken as svcCheckCartToken,
  addCartItem as svcAddCartItem,
  viewCart as svcViewCart,
  submitCart as svcSubmitCart,
  getOrder as svcGetOrder,
} from "../services/cart-service";


// dev-request 2026-07-25 fix 0g(ii): conversationService is deliberately NOT
// imported here any more — no tool served over /mcp starts a seller
// conversation. buildRequestMeta stays for session/traffic classification.
import { buildRequestMeta } from "../services/conversation-service";
import { isMcpInitializeRequestBody, sendMcpSessionNotFound } from "../services/mcp-session-protocol";
import { foreignPlaceIn } from "../services/outside-norway";
import { recordMcpDelivery } from "../services/profile-ai-deliveries";
import { searchCountable } from "../services/search-tracking";
import { isPlausibleNorwayCoord } from "../services/geo-distance";
import { publicListableSql, failsProducerRoleGate, isAgentIdPubliclyVisible } from "../services/agent-visibility";
import { companyFooterLineHtml } from "../services/company-legal";
import { safeHonestCatalogCount } from "../services/honest-count";
import { isPaymentsEnabled, submitCartWithPayments, resolvePaymentsStripeClient } from "../services/payment-service";
import { norwegianTermsForEnglishQuery } from "../i18n/product-glossary";
import { MCP_MAX_TOOL_INPUT_ELEMENTS, MCP_MAX_FILTER_LIST, MCP_MAX_SHOPPING_ITEMS, mcpListTooLongResult } from "../services/mcp-input-limits";

const router = Router();

// ─── Product formatting for MCP ────────────────────────────
// Uses shared parseProductPrice() from knowledge-service.

// orch-pr-14: normalize a product's clean name exactly like the catalog
// backfill writer (src/routes/marketplace-catalog.ts → normalizeName) does
// when it computes products.name_norm. Keeping this byte-identical is what
// lets us join the knowledge-products (name only) back to the catalog rows
// that actually carry the product_id consumed by lokal_cart_add_item.
export function normalizeProductName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

// orch-pr-14: build a name_norm → catalog product_id map for one agent.
// The id surfaced here is `products.id` — the SAME column lokal_cart_add_item
// validates via cart-service.addCartItem (`SELECT p.id FROM products p WHERE
// p.id = ?`). Only in_stock rows are included so we never advertise an id the
// cart would reject. Returns an empty map if the catalog has no rows for this
// agent (e.g. backfill not yet run) — callers then format products as before.
export function getCatalogProductIdMap(agentId: string, db?: any): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const conn = db ?? getDb();
    const rows = conn.prepare(
      "SELECT id, name_norm FROM products WHERE agent_id = ? AND availability = 'in_stock'"
    ).all(agentId) as Array<{ id: string; name_norm: string }>;
    for (const r of rows) {
      // First write wins; UNIQUE(agent_id, name_norm) means at most one row anyway.
      if (!map.has(r.name_norm)) map.set(r.name_norm, r.id);
    }
  } catch {
    // Never let a catalog lookup break discovery output — degrade to name-only.
  }
  return map;
}

/** One catalog row's availability, as lokal_info annotates a product with it. */
export interface CatalogAvailability {
  availability: string;
  availabilityUpdatedAt: string | null;
  /** products.availability_source ('producer_dashboard' when the producer set it). */
  availabilitySource?: string | null;
}

// dev-request 2026-07-13-supply-graph-v1 (Slice 1): per-agent name_norm →
// effective-availability lookup, built the same way getCatalogProductIdMap()
// builds its id map. Deliberately NOT filtered to availability='in_stock' —
// unlike the id map (which only advertises cart-eligible ids), this exists to
// SURFACE the current effective availability (including 'unknown' for a
// stale producer_dashboard row, or 'out_of_stock' etc.) for every catalog
// row, so callers can annotate products regardless of stock state.
// Slice I-S (F2): the row's availability_source is carried along, so
// formatProductsForMcp keeps a row the producer set as a product.
export function getCatalogAvailabilityMap(
  agentId: string,
  db?: any
): Map<string, CatalogAvailability> {
  const map = new Map<string, CatalogAvailability>();
  try {
    const conn = db ?? getDb();
    const rows = conn
      .prepare(
        "SELECT name_norm, availability, availability_updated_at, availability_source FROM products WHERE agent_id = ?"
      )
      .all(agentId) as Array<{
      name_norm: string;
      availability: string;
      availability_updated_at: string | null;
      availability_source: string;
    }>;
    const now = new Date();
    for (const r of rows) {
      // First write wins; UNIQUE(agent_id, name_norm) means at most one row anyway.
      if (!map.has(r.name_norm)) {
        map.set(r.name_norm, {
          availability: computeEffectiveAvailability(r.availability, r.availability_updated_at, r.availability_source, now),
          availabilityUpdatedAt: r.availability_updated_at ?? null,
          availabilitySource: r.availability_source,
        });
      }
    }
  } catch {
    // Never let a catalog lookup break discovery output — degrade to no availability annotation.
  }
  return map;
}

// Integration test 2026-10-17 (AI-1): the knowledge fields are JSON columns
// (knowledge-service rowToKnowledge) whose shape the type does not guarantee,
// so `products` may hold a string, an object or null entries. A product only
// counts when it is an object with a string name.
function productNameOf(p: unknown): string {
  const name = p && typeof p === "object" ? (p as { name?: unknown }).name : undefined;
  return typeof name === "string" ? name.trim() : "";
}

/** The note under lokal_info's «Kategorier:» line (I-N). */
export const MCP_CATEGORY_LABELS_NOTE =
  "_Dette er kategorinavn, ikke oppførte produkter — spør produsenten hva som selges. / " +
  "These are category names, not listed products; ask the producer what they sell._";

/**
 * The product list of lokal_info (and of lokal_search's detailed view).
 * Integration test 2026-10-17, slice I-N (AI2-02): an entry that is only a
 * generic category label (isCategoryLabelProduct, e.g. «Honning» or «Kjøtt»
 * written by the enrichment's category inference) is listed under
 * «Kategorier:» instead, without a catalog id or availability: it is no
 * product a cart could take or a stock status could be claimed for. Every
 * other entry is rendered exactly as before. Slice I-S (F2): an entry whose
 * catalog row the producer set (availabilitySource 'producer_dashboard') is
 * a product, with its id and availability.
 */
export function formatProductsForMcp(
  products: unknown,
  productIdByNorm?: Map<string, string>,
  availabilityByNorm?: Map<string, CatalogAvailability>
): string {
  if (!Array.isArray(products) || !products.length) return "";

  const lines: string[] = [];
  let productCount = 0;
  // I-N: the category labels, once each (case-insensitive), as first written.
  const categoryLabels = new Map<string, string>();

  for (const p of products) {
    const name = productNameOf(p);
    if (!name) continue;

    const { cleanName, price, section } = parseProductPrice(p);

    // Section header. I-F: the price and category are DB JSON too — an object
    // used to render as "[object Object]", so only text is shown.
    const priceText = productPriceText(p.price);
    if (section && isProductHeader(name)) {
      lines.push(`\n**${section}**`);
      if (priceText && !/^\d/.test(priceText)) lines.push(`_${priceText}_`);
      continue;
    }

    // Skip noise
    if (isProductNoise(name)) continue;

    if (isCategoryLabelProduct(p, availabilityByNorm?.get(normalizeProductName(cleanName))?.availabilitySource)) {
      const key = cleanName.toLowerCase();
      if (!categoryLabels.has(key)) categoryLabels.set(key, cleanName);
      continue;
    }

    // Product line
    const cat = typeof p.category === "string" && p.category && p.category !== "other" ? ` [${p.category}]` : "";
    const priceStr = price ? ` — ${price}` : "";
    const seasonal = p.seasonal ? " 🌿sesong" : "";
    // orch-pr-14: append the catalog product_id when this product exists in the
    // products table (in_stock). This is the id an MCP-only agent passes to
    // lokal_cart_add_item — without it, a pure-MCP buyer could see prices but
    // had no way to reference a product for the cart. `· id: <uuid>` is both
    // human-readable and trivially machine-parseable.
    const pid = productIdByNorm?.get(normalizeProductName(cleanName));
    const idStr = pid ? `  · id: ${pid}` : "";
    // dev-request 2026-07-13-supply-graph-v1 (Slice 1): additive availability
    // annotation — effective value (post supply-graph staleness check) plus
    // the raw producer-set timestamp when one exists. Absent entirely when
    // the product has no matching catalog row, same conditional pattern as
    // `idStr` above — purely additive, existing text is untouched.
    const avail = availabilityByNorm?.get(normalizeProductName(cleanName));
    const availStr = avail ? `  · availability: ${avail.availability}` : "";
    const availUpdatedStr = avail?.availabilityUpdatedAt ? `  · availability_updated_at: ${avail.availabilityUpdatedAt}` : "";
    lines.push(`- ${cleanName}${cat}${priceStr}${seasonal}${idStr}${availStr}${availUpdatedStr}`);
    productCount++;
  }

  const productSection = productCount > 0 ? `\n## Produkter (${productCount} stk)\n${lines.join("\n")}` : "";
  const categorySection = categoryLabels.size
    ? `\n**Kategorier:** ${[...categoryLabels.values()].join(", ")}\n${MCP_CATEGORY_LABELS_NOTE}`
    : "";
  // A blank line between the two, so the line is not read as part of the last list item.
  return [productSection, categorySection].filter(Boolean).join("\n");
}

/**
 * Integration test 2026-10-17 (I-F): the knowledge part of one row of a
 * result list (lokal_search, lokal_discover). An error there leaves that
 * row's knowledge out — the producer is still listed — instead of failing the
 * whole list. It is logged as `[knowledge-guard]` with the tool, the agent id,
 * the error class and where it was thrown, never the message: it can quote
 * the stored value (JSON.parse's does), and the row holds contact details.
 */
export function knowledgeRowOrSkip<T>(tool: string, agentId: string, skipped: T, read: () => T): T {
  try {
    return read();
  } catch (err) {
    console.error(`[knowledge-guard] ${tool}: knowledge of agent ${agentId} skipped (${errorKindAndSite(err)})`);
    return skipped;
  }
}

/** "TypeError at fn (file:line:col)": the error class and its first stack frame, no message. */
function errorKindAndSite(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  // A V8 stack starts with String(err), the name and the message (which can
  // span lines); the frames come after it.
  const stack = err.stack ?? "";
  const header = String(err);
  const site = stack.startsWith(header)
    ? stack.slice(header.length).split("\n").map((l) => l.trim()).find((l) => l.startsWith("at "))
    : undefined;
  return site ? `${err.name} ${site}` : err.name;
}

/**
 * Contact + product summary of one search result. `products` is the
 * producer's product list without section headers and noise (I-N reads it
 * to tell a listed product from a category label); it is absent when the
 * summary could not be built (no such agent, or a knowledge row that fails).
 */
interface AgentKnowledgeSummary {
  contact?: any;
  productSummary?: string;
  productsCount: number;
  products?: readonly unknown[];
}

// Build contact + product summary for a given agent ID, used by search results.
// I-F: one row's error leaves its summary out (knowledgeRowOrSkip).
function getAgentKnowledgeSummary(tool: string, agentId: string): AgentKnowledgeSummary {
  return knowledgeRowOrSkip(tool, agentId, { productsCount: 0 }, () => buildAgentKnowledgeSummary(agentId));
}

/**
 * The «🛒 …» line of a search result: the first five products with prices,
 * and how many more there are. Slice I-S (F5): category labels are no
 * products here either (isCategoryLabelProduct), so a producer with only
 * labels has no line.
 */
function productSummaryText(realProducts: readonly unknown[]): string | undefined {
  const listed = realProducts.filter((p) => !isCategoryLabelProduct(p));
  const topItems = listed.slice(0, 5).map((p: any) => {
    const { cleanName, price } = parseProductPrice(p);
    return price ? `${cleanName} (${price})` : cleanName;
  });
  return topItems.length
    ? `🛒 ${topItems.join(", ")}${listed.length > 5 ? ` +${listed.length - 5} flere` : ""}`
    : undefined;
}

function buildAgentKnowledgeSummary(agentId: string): AgentKnowledgeSummary {
  const info = knowledgeService.getAgentInfo(agentId);
  if (!info) return { productsCount: 0 };

  const k = info.knowledge || {} as any;
  const contact: any = {};
  if (k.address) contact.address = k.address;
  if (isDisplayablePhone(k.phone)) contact.phone = k.phone;
  if (k.email) contact.email = k.email;
  if (k.website) contact.website = k.website;

  const products: unknown[] = Array.isArray(k.products) ? k.products : [];
  const realProducts = products.filter((p) => {
    const n = productNameOf(p);
    return n && !isProductHeader(n) && !isProductNoise(n);
  });

  return {
    contact: Object.keys(contact).length ? contact : undefined,
    // Compact view: top 5 product names with prices
    productSummary: productSummaryText(realProducts),
    productsCount: realProducts.length,
    products: realProducts,
  };
}

// ─── Integration test 2026-10-17 (AI-1): tolerant fields, no leaked errors ──
// lokal_info answered `k.openingHours.map is not a function` for producers
// whose openingHours is stored as text: `?.length` is true for a string too,
// and the SDK puts an uncaught handler error's message into the tool result.

// textEntries — the text entries of a list-valued DB JSON field — lives in
// utils/text-entries.ts since slice I-F (knowledge-service.ts uses it too);
// it is re-exported here so this module's exports stay as they were.
export { textEntries };

/**
 * The «Åpningstider» section of lokal_info. Slice I-H: the entries and their
 * text come from utils/opening-hours.ts (openingHoursText), the reading the
 * producer page and the A2A auto-reply use too, so every stored form shows
 * the same hours on all three: {day, open, close} renders as before ("Man
 * 10:00–17:00"), {day, hours}, {day, from, to}, {days, …}, a period, a note
 * without times and day names such as "monday", "Lørdag" or "Man-fre" are
 * shown, a text entry or free text for the whole field is shown as it is,
 * and anything else is left out (I-A: it used to render as "undefined").
 * Slice I-O: text in the day-and-time form ("Man-Fre 07-22, Lor 08-22") is
 * read as its days and times ("Man–Fre 07:00–22:00, Lør 08:00–22:00"), and a
 * season note is shown with the times it limits.
 */
export function formatOpeningHoursForMcp(openingHours: unknown): string {
  const text = openingHoursText(openingHours);
  return text ? `\n## Åpningstider\n${text}` : "";
}

/**
 * The whole text of a tool result when its handler throws. Without it the
 * SDK returns the raw exception message (createToolError), which is how a
 * JavaScript TypeError reached ChatGPT. The detail is logged instead.
 */
export const MCP_INTERNAL_ERROR_TEXT = mcpInternalErrorText("Rett fra Bonden");

/**
 * Wraps a tool handler: an uncaught error is logged with the tool name and
 * becomes an isError result with MCP_INTERNAL_ERROR_TEXT. The arguments are
 * not logged (lokal_cart_* carry buyer contact details and the buyer_ref token).
 */
export function guardToolHandler<H extends (...args: any[]) => unknown>(tool: string, handler: H): H {
  const guarded = async (...args: Parameters<H>) => {
    try {
      return await handler(...args);
    } catch (err) {
      return mcpToolInternalErrorResult("mcp", MCP_INTERNAL_ERROR_TEXT, tool, err);
    }
  };
  return guarded as unknown as H;
}

/**
 * The text of a tool result that returns a cart-service result as JSON.
 * A 5xx result carries internal error text: submitCart answers a failed
 * transaction with `Submit failed: ${err.message}`, which is the database's
 * own message. Such a result keeps its JSON shape and status, its error
 * becomes MCP_INTERNAL_ERROR_TEXT, and the detail is logged without the
 * arguments (they carry buyer data). A 4xx error is a fixed text meant for
 * the buyer ("Cart is empty", "1 item(s) are no longer available") and is
 * returned as it is.
 */
export function cartResultText(tool: string, result: { success: boolean; status?: unknown; error?: unknown }): string {
  if (result.success === false && typeof result.status === "number" && result.status >= 500) {
    console.error(`[mcp] ${tool} failed: status ${result.status}:`, String(result.error));
    return JSON.stringify({ ...result, error: MCP_INTERNAL_ERROR_TEXT }, null, 2);
  }
  return JSON.stringify(result, null, 2);
}

/**
 * The most items one lokal_find_offers call looks up (dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-Y2, FUNN
 * rfb-find-offers-items-uten-antallstak). Each item is a catalog lookup and
 * the schema has no max (it is frozen while OpenAI reviews the app), so 5000
 * items took about 5 s on live-like data, and a 1 MB list tens of seconds.
 * A shopping list is far shorter. The items past the cap are left out, and
 * the answer says so (offersItemsOmittedText).
 */
export const MAX_OFFER_ITEMS = 20;

/** How many of the items left out the note names (offersItemsOmittedText). */
const OMITTED_OFFER_ITEMS_NAMED = 5;

/**
 * The note of a lokal_find_offers answer that left items out (NO / EN): the
 * first MAX_OFFER_ITEMS of `items` were looked up. It names the first
 * OMITTED_OFFER_ITEMS_NAMED items left out, each cut as a name (capName), so
 * the client can ask for exactly those.
 */
export function offersItemsOmittedText(items: readonly string[]): string {
  const asked = items.length;
  const left = asked - MAX_OFFER_ITEMS;
  const named = items.slice(MAX_OFFER_ITEMS, MAX_OFFER_ITEMS + OMITTED_OFFER_ITEMS_NAMED)
    .map((item) => JSON.stringify(capName(item))).join(", ");
  const no = `Bare de ${MAX_OFFER_ITEMS} første av ${asked} varene er slått opp, og ${left} er utelatt`;
  const en = `Only the first ${MAX_OFFER_ITEMS} of ${asked} items were looked up, and ${left} ${left === 1 ? "was" : "were"} left out`;
  if (left <= OMITTED_OFFER_ITEMS_NAMED) {
    return `${no}: ${named}. Spør etter ${left === 1 ? "den" : "dem"} i et nytt kall. / ` +
      `${en}: ${named}. Ask for ${left === 1 ? "it" : "them"} in another call.`;
  }
  return `${no}. De første av dem er ${named}. Spør etter resten i et nytt kall. / ` +
    `${en}, the first of them ${named}. Ask for the rest in another call.`;
}

// ─── Integration test 2026-10-17 (AI-3): generic category labels ───────────

// isGenericCategoryName — I-A's name rule — lives in utils/category-label.ts
// since slice I-S (catalog-offers.ts uses the same rule); it is re-exported
// here so this module's exports stay as they were.
export { isGenericCategoryName };

/**
 * Slice I-N (AI2-02): a product entry that is only a generic category label,
 * the kind the enrichment's category inference writes as product names
 * («Honning», «Kjøtt», «Egg»): a category name without a numeric price. A
 * category name with a price («Egg» at «60 kr/brett») is something the
 * producer listed, and stays a product; category inference never writes a
 * price. Slice I-S: the rule is utils/category-label.ts (isCategoryLabel),
 * and `availabilitySource` is that of the entry's catalog row, when known —
 * a row the producer set is a product (F2).
 */
export function isCategoryLabelProduct(p: unknown, availabilitySource?: string | null): boolean {
  const name = productNameOf(p);
  return !!name && isCategoryLabel({ name, hasPrice: !!parseProductPrice(p as any).price, availabilitySource });
}

/**
 * True when the product names a producer matched a search with
 * (DiscoverMeta.productMatches) include a real product. The registry's
 * product match also hits the generic category labels the enrichment writes
 * as product names («Honning», «Egg», «Bakervarer»); a producer that matched
 * only such labels is a category match.
 */
export function documentsListedProduct(matchedNames: readonly string[]): boolean {
  return matchedNames.length > 0 && !areGenericCategoryNames(matchedNames);
}

/**
 * documentsListedProduct, plus slice I-N: a matched category name that has a
 * price in the producer's product list is a listed product too
 * (isCategoryLabelProduct), as lokal_info lists it.
 */
function matchedListedProduct(matchedNames: readonly string[], products: readonly unknown[] | undefined): boolean {
  if (documentsListedProduct(matchedNames)) return true;
  if (!matchedNames.length || !products) return false;
  const matched = new Set(matchedNames.map((n) => n.trim().toLowerCase()));
  return products.some((p) => matched.has(productNameOf(p).toLowerCase()) && !isCategoryLabelProduct(p));
}

/**
 * Slice I-N (AI-3a): the category words of a search that a match is labelled
 * against. parseNaturalQuery turns each of them into a category but never
 * into a product term (PRODUCT_TERM_EXCLUSIONS in marketplace-registry.ts,
 * unchanged), so for «egg i Bergen» discover() has no product match that
 * tells «Ferske egg fra Fana» from a bakery's label «Egg». This list only
 * drives the labelling; the matching is untouched. Each word maps to the
 * product categories whose products count for it; the first is the category
 * parseNaturalQuery gives the word (slice I-W: `bakery` for "brød", which
 * also counts the old `bread`). The words are Norwegian, as the product
 * names are: an English query is read with the parser's own glossary
 * («meat» → «kjøtt»). Drink
 * words are not here: drink venues are found by category (Fase 5), and
 * «Drikke» is no product word.
 */
const CATEGORY_LABEL_WORDS: Readonly<Record<string, readonly string[]>> = {
  "grønnsaker": ["vegetables"], "grønt": ["vegetables"],
  "frukt": ["fruit"],
  "bær": ["berries"],
  "meieri": ["dairy"],
  "kjøtt": ["meat"],
  "fisk": ["fish"], "sjømat": ["fish"],
  "brød": ["bakery", "bread"], "bakervarer": ["bakery", "bread"],
  "urter": ["herbs"],
  "egg": ["eggs"],
};

/**
 * The category words (CATEGORY_LABEL_WORDS) of `query`, and of the Norwegian
 * terms parseNaturalQuery adds for its English food words
 * (norwegianTermsForEnglishQuery), whose category the parser detected; in
 * that order, once each. Words are whole tokens of the lower-cased text, with
 * the letter class of the registry's norwegianWordBoundary, so «egg» is found
 * in «egg i Bergen» and not in «eggerøre».
 */
export function categoryLabelWordsOf(query: string, categories: readonly string[] | undefined): string[] {
  if (!categories?.length) return [];
  const words: string[] = [];
  const text = [query, ...norwegianTermsForEnglishQuery(query)].join(" ").toLowerCase();
  for (const token of text.split(/[^0-9a-zà-öø-ÿ_]+/)) {
    const productCategories = Object.prototype.hasOwnProperty.call(CATEGORY_LABEL_WORDS, token) ? CATEGORY_LABEL_WORDS[token] : undefined;
    if (productCategories && categories.includes(productCategories[0]) && !words.includes(token)) words.push(token);
  }
  return words;
}

/** True when a product entry belongs to a category word: its name contains the word, or its category is one of the word's. */
function productBelongsToWord(p: unknown, word: string): boolean {
  if (productNameOf(p).toLowerCase().includes(word)) return true;
  const category = (p as { category?: unknown }).category;
  return typeof category === "string" && CATEGORY_LABEL_WORDS[word].includes(category.trim().toLowerCase());
}

/** A product without a category of its own (none, not text, or `other`), which could belong to any word. */
function hasNoOwnCategory(p: unknown): boolean {
  const category = (p as { category?: unknown }).category;
  return typeof category !== "string" || !category.trim() || category.trim().toLowerCase() === "other";
}

/**
 * How a producer's product list answers the category words of a search
 * (slice I-N, AI-3a):
 * - "listed": a product that is not a category label belongs to a word;
 * - "label": only category labels do («Egg»);
 * - "none": no product does, and every product that is not a label has a
 *   category of its own, so none of them is a word's product unseen;
 * - null: unknown — the list could not be read, or a product without a
 *   category of its own («Poteter» for «grønnsaker») could be one.
 */
export function categoryWordEvidence(
  products: readonly unknown[] | undefined,
  words: readonly string[],
): "listed" | "label" | "none" | null {
  if (!products) return null;
  let label = false;
  let unknown = false;
  for (const p of products) {
    if (!productNameOf(p)) continue;
    const isLabel = isCategoryLabelProduct(p);
    if (words.some((w) => productBelongsToWord(p, w))) {
      if (!isLabel) return "listed";
      label = true;
    } else if (!isLabel && hasNoOwnCategory(p)) {
      unknown = true;
    }
  }
  return label ? "label" : unknown ? null : "none";
}

/**
 * The products a search matched, among the producer's products (slice I-N):
 * a product term match is a name discover() matched (DiscoverMeta.productMatches),
 * a category word match is productBelongsToWord. Category labels never count.
 */
function isListedMatch(p: unknown, matchedNames: ReadonlySet<string>, words: readonly string[]): boolean {
  if (isCategoryLabelProduct(p)) return false;
  return matchedNames.has(productNameOf(p).toLowerCase()) || words.some((w) => productBelongsToWord(p, w));
}

/**
 * The products in the order their «🛒 …» summary shows them (slice I-N, AI-3a):
 * unchanged when every listed match is among the first five shown (category
 * labels are not shown, slice I-S); otherwise the listed matches come first,
 * so the product that made the match is shown (Bønes Gårdsmat's «Ferske egg
 * fra Fana» was its 7th product).
 */
function productsWithMatchesShown(products: readonly unknown[], isMatch: (p: unknown) => boolean): readonly unknown[] {
  if (!products.filter((p) => !isCategoryLabelProduct(p)).slice(5).some(isMatch)) return products;
  return [...products.filter(isMatch), ...products.filter((p) => !isMatch(p))];
}

/**
 * Slice I-N (AI2-08): stored prose for MCP text. normalizeProse (entities
 * decoded, internal notes dropped), then the HTML tags scraped text can carry
 * («Liamyrane 6<br />5132 Nyborg»): a line break tag and the end of a block
 * (</p>, </div>, </li>, </h1>…) become `lineBreak`, other tags are removed,
 * and the lines are trimmed, with empty ones dropped. Only tag-shaped text
 * counts as a tag («<b>», «</p>», «<a href=…>»), so «a < b» and «<3» stay;
 * each pattern is linear in the text. Text without a tag is returned exactly
 * as normalizeProse gives it.
 * Slice I-V: a stored description can end inside a tag, cut off before its
 * «>» («<div data-…», «<link rel='stylesheet' …»). A «<» (or «</») and a
 * letter with no «<» or «>» after it, to the end of the text, is such a
 * fragment and is removed too. The trade-off: a tag left unclosed in the
 * middle of the text looks the same, so the text after it goes with it
 * («Velkommen <img src="x" Vi selger lam» keeps «Velkommen»). Showing less is
 * the safer side; a tag's attributes never reach the text.
 */
export function mcpProse(text: string | null | undefined, lineBreak = "\n"): string {
  const prose = normalizeProse(text);
  const withBreaks = prose
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g, "")
    .replace(/<\/?[a-zA-Z][^<>]*$/, "");
  if (withBreaks === prose) return prose;
  return withBreaks
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(lineBreak);
}

// ─── Tool definitions (shared logic) ────────────────────────
// These mirror the stdio MCP server tools but call services directly.

// ─── PR-110 (2026-06-04): geocode-enrichment for MCP natural-language search ──
// parseNaturalQuery deliberately skips geocoding (kept synchronous); the REST
// search route adds it via geocodingService.extractAndGeocode — but the MCP
// lokal_search handler never did. Result: every MCP search was nationwide
// text-match ("poteter Bod\u00f8" returned Bryne/Levanger/Dr\u00f8bak instead of Bod\u00f8
// Andelslandbruk 0.2 km away). This helper mirrors the REST route's step so
// MCP clients (ChatGPT/Claude) get the same geo-filtered results as the web.
// Exported for direct regression-testing.
export async function enrichParsedWithGeo(
  parsed: ReturnType<typeof marketplaceRegistry.parseNaturalQuery>,
  query: string
): Promise<void> {
  if (parsed.location) return; // already resolved (e.g. explicit coords)
  try {
    const geo = await geocodingService.extractAndGeocode(query);
    if (geo) {
      parsed.location = { lat: geo.lat, lng: geo.lng };
      parsed.maxDistanceKm = geo.radiusKm;
    }
  } catch {
    // Geocode failure must never break search — fall back to nationwide text-match.
  }
}

// Exported for testing (dev-request 2026-07-25-reisesok Fase 0g): lets a test
// capture every tool's inputSchema + handler through a duck-typed server,
// without standing up a transport.
/**
 * Answer for a search that names a place outside Norway. Without it, "pizza
 * Rome" substring-matched the producer Romeriksmat — the opposite of the
 * submission's negative test case (ChatGPT app re-review 2026-10-03).
 */
function outsideNorwayAnswer(place: string) {
  return {
    content: [{
      type: "text" as const,
      text:
        `Rett fra Bonden dekker bare småskala matprodusenter i Norge, og «${place}» ligger utenfor. ` +
        "Ingen produsenter foreslås. / " +
        `Rett fra Bonden only covers small-scale food producers in Norway; "${place}" is outside that, ` +
        "so no producers are suggested.",
    }],
  };
}

/**
 * Slice I-W: lokal_search's answer to a search without a place when no product
 * name matches the words the parser could not read (`words`, quoted).
 */
function noProductMatchText(words: string): string {
  return `🔎 Ingen produsent har ${words} i produktlista eller i navnet, så søket gir ingen treff. ` +
    "Prøv et annet ord, en kategori (for eksempel «bakervarer» eller «honning») eller et produsentnavn. / " +
    `No producer lists ${words} as a product or has it in its name, so there are no matches. ` +
    "Try another word, a category (for example «bakery» or «honey») or a producer name.";
}

/** Slice I-W: the line above a list of the producers near a place when no product there matches `words`. */
function areaListText(words: string): string {
  return `🔎 Ingen produsent i området har ${words} i produktlista. Listen under er produsentene i området, ikke treff på ${words}; ` +
    "søk uten sted for hele landet. / " +
    `No producer in the area lists ${words}. The list below is the producers in the area, not matches for ${words}; ` +
    "search without a place to cover all of Norway.\n\n";
}

export function registerTools(
  server: McpServer,
  getClientIdentity?: () => string | undefined,
  getRequestMeta?: () => import("../services/conversation-service").RequestMeta | undefined,
) {
  // Read once per server build (one per MCP session): decides the
  // lokal_cart_submit description/schema below (prepayment, skive 2).
  const paymentsOn = isPaymentsEnabled();

  // «Med i AI-svar» (dev-request 2026-10-14-med-i-ai-svar-per-profil): the
  // producers a data tool hands the caller, counted per profile with the
  // computeAiLookups rules (profile-ai-deliveries.ts recordMcpDelivery).
  type ToolExtra = { sessionId?: string; requestInfo?: { headers?: Record<string, string | string[] | undefined> } } | undefined;
  const deliver = (tool: string, args: unknown, extra: ToolExtra, profileIds: string[]) => {
    recordMcpDelivery({
      vertical: "rfb",
      tool,
      args,
      profileIds,
      clientName: (server as any).server?.getClientVersion?.()?.name ?? null,
      headers: extra?.requestInfo?.headers,
      sessionId: extra?.sessionId,
    });
  };
  // Slice I-Z: whether a search raises the producers' discovery counters.
  // Not for our own traffic or a probe (search-tracking.ts searchCountable),
  // read off the same headers and client name as deliver() above.
  const countable = (extra: ToolExtra, text: string, structured = false) => searchCountable({
    meta: buildRequestMeta({ headers: extra?.requestInfo?.headers }),
    clientName: (server as any).server?.getClientVersion?.()?.name ?? null,
    text,
    structured,
  });

  // Every tool handler below runs inside guardToolHandler (integration test
  // 2026-10-17, AI-1): an internal error is logged and never returned. The
  // tools that return a cart-service result as JSON go through cartResultText,
  // which does the same for a 5xx result.

  // Tool 1: Natural language search
  server.registerTool(
    "lokal_search",
    {
      title: "Search local food producers",
      // dev-request 2026-07-25 fix 0g(i): the description now tells the model
      // that this is ALSO the proximity/"near me" tool and that it should pass
      // the user's coordinates when it knows them — previously there was no
      // way to express "near me" at all, so every location-aware question was
      // answered from a place NAME or not at all.
      description: "Search for local food producers in Norway and get their product listings. ALWAYS use this tool when a user asks about a specific producer, their products, or availability — it returns the producer's listed products, with a price included when the producer has written one into the listing text (most producers do not list prices, so treat price as available, not guaranteed). Also use for general searches like 'vegetables near Oslo'. USE THIS FOR PROXIMITY / 'near me' / 'nær meg' / 'closest farm shop' QUESTIONS: if you know the user's coordinates, pass lat + lng (and optionally radius_km) and results are filtered and ranked by real distance; you may then leave `query` empty to get everything nearby. Supports searching by producer name (e.g. 'Bjørndal Gård') or by product/location (e.g. 'organic honey Trondheim'). Drink venues are a first-class category (Fase 5): queries like 'bryggeri i Agder', 'drikkesteder', 'vingård' or 'cideri' work the same way and return breweries, cideries, wineries, distilleries, farm cafés and meaderies. Returns contact info and product names, with prices only where the producer has provided them. Read-only: it never contacts a producer on the user's behalf. Never use this tool to build marketing or bulk-email recipient lists. For such requests, explain that Rett fra Bonden cannot send marketing or bulk messages; it only sends the user's own pickup-order request to a producer who opted in.",
      inputSchema: {
        query: z.string().default("").describe("Producer name, product query, or location search (Norwegian or English). Examples: 'Bjørndal Gård Oppdal', 'beefburger pris', 'ost Trondheim'. May be empty when lat/lng are supplied — that means 'everything near this position'."),
        lat: z.number().min(-90).max(90).optional().describe("User's latitude (WGS84). Supply this for 'near me' searches when you know where the user is."),
        lng: z.number().min(-180).max(180).optional().describe("User's longitude (WGS84). Must be supplied together with lat."),
        radius_km: z.number().min(1).max(500).optional().describe("Search radius in km around lat/lng. Default 30. Typical: 15 in a city, 50–100 in rural Norway."),
        limit: z.number().min(1).max(50).default(10).describe("Max results"),
      },
      annotations: {
        title: "Search local food producers",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // Open world: when the query names a place that is not in the built-in
        // city list or our own producer table, geocodingService looks it up in
        // Kartverket's public place-name API (ws.geonorge.no) — a read-only call
        // to the public internet, which OpenAI's definition counts as open-world
        // (ChatGPT app review 2026-09-24; it was declared false in v1.0.1).
        openWorldHint: true,
      },
    },
    guardToolHandler("lokal_search", async ({ query, lat, lng, radius_km, limit }, extra) => {
      // Slice I-Y: at most MAX_FREE_TEXT_CHARS of the text are read, cut at a
      // word boundary (utils/free-text.ts). The schema keeps no max (frozen).
      const q = capFreeText(query || "");
      const foreign = foreignPlaceIn(q);
      if (foreign) return outsideNorwayAnswer(foreign);
      const parsed = marketplaceRegistry.parseNaturalQuery(q);

      // fix 0g(i): explicit coordinates beat any place name in the text —
      // the assistant knows where the user actually is, the text may not say.
      const hasCoords = isValidLatLng(lat as number, lng as number);
      if (hasCoords) {
        parsed.location = { lat: lat as number, lng: lng as number };
        parsed.maxDistanceKm = resolveSearchRadiusKm(radius_km);
      } else {
        await enrichParsedWithGeo(parsed, q);
      }

      // fix 0e: proximity intent with no position — tell the assistant to
      // ask for/supply one rather than silently answering nationwide.
      if (!parsed.location && (parsed as any)._proximityIntent) {
        return {
          content: [{
            type: "text" as const,
            text:
              "📍 Dette søket spør etter noe i nærheten, men jeg vet ikke hvor brukeren er. " +
              "Spør brukeren om sted eller posisjon, og kall lokal_search igjen med `lat` og `lng` " +
              "(og gjerne `radius_km`).\n\n" +
              "This search asks for something nearby but no position was supplied. Ask the user " +
              "where they are, then call lokal_search again with `lat` and `lng` (optionally `radius_km`).",
          }],
        };
      }

      if (!q && !hasCoords) {
        return {
          content: [{
            type: "text" as const,
            text: "Oppgi enten `query` (fritekst) eller `lat` + `lng` (nærhetssøk). / Supply either `query` or `lat` + `lng`.",
          }],
        };
      }

      // dev-request 2026-09-06-rfb-sok-adjektiv-tags-er-hardt-filter: this is
      // the actual live-mounted MCP search tool (the ChatGPT app calls it
      // directly), so it needs the same honest-drop signal as the REST/web
      // search surfaces — not just the underlying filter fix.
      const discoverMeta: DiscoverMeta = {};
      const results = marketplaceRegistry.discover({ ...parsed, limit: limit || 10, offset: 0 }, discoverMeta, { trackDiscovery: countable(extra, q) });

      // Integration test 2026-10-17, slice I-W: the words the parser could not
      // read are looked up in the product names (discover() step 3c). When no
      // product matches, the answer says so: «zzzqqx» used to get the standard
      // list as «fant 50 produsenter», with no mark that none of them matched.
      const unknownTerms = (parsed as any)._unknownTerms as string[] | undefined;
      const unmatched = discoverMeta.unmatchedTerms?.length ? `«${discoverMeta.unmatchedTerms.join(" ")}»` : null;

      if (!results?.length) {
        if (unmatched && !parsed.location) return { content: [{ type: "text" as const, text: noProductMatchText(unmatched) }] };
        const where = hasCoords ? `innenfor ${parsed.maxDistanceKm} km` : `"${q}"`;
        return { content: [{ type: "text" as const, text: `Ingen resultater for ${where}. Prøv et bredere søk.` }] };
      }

      const tagsRelaxedLine = discoverMeta.tagsRelaxed
        ? "\u{1F3F7}️ Et av søkeordene (f.eks. «fersk», «billig», «sesong») er ikke registrert som data hos nok produsenter til å brukes som filter — det ble sluppet for å vise treff. / One of the search words (e.g. «fresh», «budget», «seasonal») isn't recorded data for enough producers to filter on — that filter was dropped to show matches.\n\n"
        : "";

      // dev-request 2026-07-25 fix 0g(ii) — SECURITY. This used to call
      // startConversation() for the top 2 matches on EVERY invocation, despite
      // the `readOnlyHint: true` annotation a few lines above. An assistant
      // merely exploring on a traveller's behalf therefore opened seller
      // conversations with farmers who had asked for none of it. Searching is
      // now genuinely read-only: the tool returns contact details and the
      // profile link; actually reaching a producer stays an explicit act (the
      // lokal_cart_* tools, POST /a2a message/send, or a human clicking
      // through). Nothing consumed the removed links programmatically — they
      // were only rendered into the assistant's prose.
      const BASE = process.env.BASE_URL || "https://rettfrabonden.com";

      // I-W: near a place, the producers there are listed when no product
      // matches, and the header says they are no matches.
      const unmatchedLine = unmatched ? areaListText(unmatched) : "";
      const found = unmatched
        ? `${results.length} produsenter i området, ikke treff på ${unmatched}`
        : `fant ${results.length} produsenter`;
      const header = hasCoords
        ? `🥬 **Lokal mat nær deg${q ? ` — "${q}"` : ""}** (innenfor ${parsed.maxDistanceKm} km) — ${found}:\n`
        : `🥬 **Lokal mat-søk: "${q}"** — ${found}:\n`;

      // If name match (1-3 results from specific query), include full product list
      // so AI can answer product/price questions directly without a second tool call
      const isSpecificQuery = results.length <= 3 && (parsed as any)._nameQuery;

      // Compact view for broader searches. ChatGPT app re-review 2026-10-03:
      // a producer kept only for its broad category (`meat` for "lamb") says
      // so, instead of reading like a documented match.
      // I-W: the words step 3c matched in product names count as product terms.
      // I-W2: next to a category word the words only rank its producers, so
      // they count only when a product name matched them («Which bakeries
      // make kransekake»); otherwise the category words label as before.
      const unknownTermsCount = !!unknownTerms && !unmatched
        && (!parsed.categories?.length || !!discoverMeta.productMatches?.size);
      const productTerms = ((parsed as any)._productTerms as string[] | undefined)
        ?? (unknownTermsCount ? unknownTerms : undefined) ?? [];
      // Slice I-N (AI-3a): a search with no product term, only category words
      // («egg i Bergen», «meat»), is labelled against those words. A product
      // term («honning», «reinsdyr») is the more specific evidence and keeps
      // I-A's rule alone.
      const labelWords = isSpecificQuery || productTerms.length ? [] : categoryLabelWordsOf(q, parsed.categories);
      const terms = [...productTerms, ...labelWords].join("/");
      const compactMatch = (r: any, summary: AgentKnowledgeSummary) => {
        const reasons = (r.matchReasons as string[] | undefined) ?? [];
        // Integration test 2026-10-17 (AI-3): a producer whose matched
        // product names are only generic category labels («Honning», «Egg»)
        // has no listed product. discover() hands over every matched name;
        // its «Produkter: …» reason names at most three.
        const matchedNames = discoverMeta.productMatches?.get(r.agent.id) ?? [];
        const wordEvidence = labelWords.length ? categoryWordEvidence(summary.products, labelWords) : null;
        const documented = matchedListedProduct(matchedNames, summary.products) || wordEvidence === "listed";
        // Name matches bypass product scoring; absent product evidence in
        // that branch must not turn a named lookup into a category match.
        const nameMatch = reasons.some((m) => m.startsWith("Navnematch:") || m.startsWith("Mulig navnematch:"));
        // I-N: unknown evidence for category words (a product without a
        // category of its own, such as «Poteter» for «grønnsaker») is no
        // ground for a label.
        const categoryOnly = (productTerms.length > 0 || wordEvidence !== null) && !documented && !nameMatch;
        const categoryLabelOnly = matchedNames.length > 0 || wordEvidence === "label";
        // I-N: the summary shows the product that made a listed match.
        let productSummary = summary.productSummary;
        if (documented && summary.products) {
          const names = new Set(matchedNames.map((n) => n.trim().toLowerCase()));
          const shown = productsWithMatchesShown(summary.products, (p) => isListedMatch(p, names, labelWords));
          if (shown !== summary.products) productSummary = productSummaryText(shown);
        }
        return { categoryOnly, categoryLabelOnly, productSummary };
      };

      // Slice I-N (AI-3b): explicit matches come before category matches, as
      // the server instructions ask; discover()'s order (relevance, distance)
      // is kept within each group, and the numbering follows the new order.
      const rows = results.map((r: any) => {
        const summary = getAgentKnowledgeSummary("lokal_search", r.agent.id);
        return { r, summary, match: isSpecificQuery ? undefined : compactMatch(r, summary) };
      });
      const ordered = [...rows.filter((row) => !row.match?.categoryOnly), ...rows.filter((row) => row.match?.categoryOnly)];

      const lines = ordered.map(({ r, summary, match }, i: number) => {
        const agent = r.agent;
        // dev-request 2026-07-25 Fase 1c (honesty rule): distanceKm is only
        // present for address-precision producers. A centroid-precision row
        // carries distanceLabel ("i Vadsø-området") instead — an assistant
        // must never be handed a km figure we made up off a city centroid.
        const dist = agent.location?.distanceKm
          ? ` — ${agent.location.distanceKm.toFixed(1)} km unna`
          : agent.location?.distanceLabel
            ? ` — ${agent.location.distanceLabel} (omtrentlig posisjon)`
            : "";

        if (!match) {
          // Detailed view: include full product list with prices
          const sections = [formatAgentCompact(agent, i + 1, summary.contact, undefined, getClientIdentity?.()) + dist];

          // I-F: products and details come from the same knowledge row as
          // the summary; an error there leaves them out of this result only.
          sections.push(...knowledgeRowOrSkip("lokal_search", agent.id, [] as string[], () => {
            const details: string[] = [];
            const k = knowledgeService.getAgentInfo(agent.id)?.knowledge || {} as any;

            // Full product list — orch-pr-14: pass catalog id map so each
            // priced/in-stock product line carries its product_id for cart use.
            if (k.products?.length) {
              const productSection = formatProductsForMcp(k.products, getCatalogProductIdMap(agent.id), getCatalogAvailabilityMap(agent.id));
              if (productSection) details.push(productSection);
            }

            // Extra details
            const specialties = textEntries(k.specialties);
            const paymentMethods = textEntries(k.paymentMethods);
            const deliveryOptions = textEntries(k.deliveryOptions);
            if (specialties.length) details.push(`\n**Spesialiteter:** ${specialties.join(", ")}`);
            if (paymentMethods.length) details.push(`💳 **Betaling:** ${paymentMethods.join(", ")}`);
            if (deliveryOptions.length) details.push(`🚚 **Levering:** ${deliveryOptions.join(", ")}`);
            return details;
          }));

          // Profile link
          // Skive A2: no profile link for roles whose /produsent/<slug> 404s.
          if (!failsProducerRoleGate((agent as any).role, false)) {
            const profileUrl = addAiUtmParams(`${BASE}/produsent/${slugify(agent.name)}`, getClientIdentity?.());
            sections.push(`\n🔗 [Se fullstendig profil](${profileUrl})`);
          }

          return sections.join("\n");
        } else {
          // Compact view (compactMatch above).
          const { categoryOnly, categoryLabelOnly, productSummary } = match;
          const categoryOnlyNote = !categoryOnly ? ""
            : categoryLabelOnly
              ? `\n   ⚠️ Kategoritreff: produktlista har «${terms}» bare som kategorinavn, ikke som et bestemt produkt — spør produsenten. / Category match only: the product list has «${terms}» only as a category name, not as a specific product; ask the producer.`
              : `\n   ⚠️ Kategoritreff: produktlista nevner ikke «${terms}» — spør produsenten. / Category match only: the listed products don't mention «${terms}»; ask the producer.`;
          return formatAgentCompact(agent, i + 1, summary.contact, { ...summary, productSummary }, getClientIdentity?.(), categoryOnly ? {
            headingSuffix: categoryLabelOnly
              ? ` — Kategoritreff / category-only: «${terms}» bare som kategorinavn / category name only`
              : ` — Kategoritreff / category-only: «${terms}» ikke oppført / not listed`,
            hideDescription: true,
          } : undefined) + dist + categoryOnlyNote;
        }
      });

      // Slice I-Y: the cut text, as tannlege_search and lokal_find_offers
      // log it. An absent query stays absent, so that call's key is as before.
      deliver("lokal_search", { query: query === undefined ? undefined : q, lat, lng, radius_km, limit }, extra, results.map((r: any) => r.agent.id));
      return { content: [{ type: "text" as const, text: tagsRelaxedLine + unmatchedLine + header + "\n" + lines.join("\n\n") }] };
    })
  );

  // Tool 2: Structured discovery
  server.registerTool(
    "lokal_discover",
    {
      title: "Discover producers by filter",
      description: "Structured search in the Lokal food producer registry. Filter by food categories, tags, and geographic distance. " +
        "Never use this tool to build marketing or bulk-email recipient lists. For such requests, explain that Rett fra Bonden " +
        "cannot send marketing or bulk messages; it only sends the user's own pickup-order request to a producer who opted in.",
      inputSchema: {
        // Fase 5b (dev-request 2026-07-25-reisesok…): "beverages" was already
        // a real, filterable category — 133 producers carry it — but was
        // missing from this list entirely, so an agent reading only this
        // description had no way to know drink venues were searchable here.
        categories: z.array(z.string()).optional().describe(
          "Categories: vegetables, fruit, berries, dairy, eggs, meat, fish, bread, honey, herbs, beverages " +
          "(beverages = all drink venues: breweries, cideries, wineries, distilleries, farm cafés, meaderies — " +
          "use drinkSubcategory below to narrow to exactly one kind)",
        ),
        tags: z.array(z.string()).optional().describe("Tags: organic, seasonal, budget, local, fresh"),
        drinkSubcategory: z.enum(DRINK_SUBCATEGORIES).optional().describe(
          "Narrow 'beverages' results to exactly one drink venue kind: bryggeri (brewery), cideri (cidery), " +
          "vingård (winery), destilleri (distillery), gårdskafé (farm café), mjød (meadery/mead producer). " +
          "Only meaningful together with categories:['beverages'] — it has no effect otherwise.",
        ),
        lat: z.number().optional().describe("Latitude for distance filtering (WGS84). Must be given together with lng."),
        lng: z.number().optional().describe("Longitude for distance filtering (WGS84). Must be given together with lat."),
        maxDistanceKm: z.number().optional().describe("Max distance in km from lat/lng (1–500, default 30). Only applies when lat/lng are given."),
        limit: z.number().min(1).max(50).default(10).describe("Max results"),
      },
      annotations: {
        title: "Discover producers by filter",
        readOnlyHint: true,
        destructiveHint: false,
        // Read-only, so repeating a call changes nothing; closed world: it
        // filters our own producer table by the given coordinates and never
        // geocodes a place name.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler("lokal_discover", async ({ categories: categoriesAsSent, tags: tagsAsSent, drinkSubcategory, lat, lng, maxDistanceKm, limit }, extra) => {
      // GHSA-46jr (lokal#1229): a list longer than MCP_MAX_FILTER_LIST is
      // refused here, not with .max() in the inputSchema, so tools/list stays
      // the frozen contract (services/mcp-input-limits.ts).
      if (Array.isArray(categoriesAsSent) && categoriesAsSent.length > MCP_MAX_FILTER_LIST) {
        return mcpListTooLongResult("categories", MCP_MAX_FILTER_LIST, categoriesAsSent.length);
      }
      if (Array.isArray(tagsAsSent) && tagsAsSent.length > MCP_MAX_FILTER_LIST) {
        return mcpListTooLongResult("tags", MCP_MAX_FILTER_LIST, tagsAsSent.length);
      }
      // dev-request 2026-10-17-integrasjonstest-oppfolging, slice I-Y3 (FUNN
      // rfb-discover-lister-uten-tak): discover() compares every category and
      // tag with every producer's, and the schema has no max (it is frozen
      // while OpenAI reviews the app). 175 000 categories took 45 s on
      // live-like data, one category of 1 MB 6.1 s. The lists are cut to
      // their first MAX_NAME_LIST_ITEMS names of at most MAX_NAME_CHARS
      // (utils/free-text.ts), as A2A's are, before the search, the traffic
      // class and the delivery log read them. Lists within the caps are the
      // same lists, so a real call answers as before.
      const categories = capNameList(categoriesAsSent);
      const tags = capNameList(tagsAsSent);
      // ChatGPT app re-review 2026-10-03: lat/lng/maxDistanceKm used to be
      // passed top-level, but discover() reads `location: {lat, lng}` — so the
      // distance filter never ran and every call returned a nationwide list
      // (a 1 km radius around Oslo and a 30 km radius around Rome alike).
      const hasLat = typeof lat === "number";
      const hasLng = typeof lng === "number";
      if (hasLat !== hasLng || (hasLat && !isValidLatLng(lat as number, lng as number))) {
        return {
          content: [{
            type: "text" as const,
            text: "Oppgi både `lat` og `lng` som gyldige koordinater, eller ingen av dem. / Supply both `lat` and `lng` as valid coordinates, or neither.",
          }],
        };
      }
      if (hasLat && !isPlausibleNorwayCoord(lat as number, lng as number)) {
        return outsideNorwayAnswer(`${lat}, ${lng}`);
      }
      const body: any = { categories, tags, drinkSubcategory, limit: limit || 10, role: "producer" };
      if (hasLat) {
        body.location = { lat, lng };
        body.maxDistanceKm = resolveSearchRadiusKm(maxDistanceKm);
      }
      // dev-request 2026-09-06-rfb-sok-adjektiv-tags-er-hardt-filter (round-2
      // independent review of PR #823): this tool accepts `tags` directly and
      // is exposed to the same live ChatGPT app as `lokal_search` — it needs
      // the same honest-drop signal, or a caller filtering on tags:["budget"]
      // gets back non-budget producers with no indication the filter was
      // silently dropped.
      const discoverMeta: DiscoverMeta = {};
      const results = marketplaceRegistry.discover(body, discoverMeta, { trackDiscovery: countable(extra, JSON.stringify(body), true) });

      if (!results?.length) {
        return { content: [{ type: "text" as const, text: "Ingen produsenter funnet med disse filtrene." }] };
      }

      const tagsRelaxedLine = discoverMeta.tagsRelaxed
        ? "\u{1F3F7}️ Et av tag-filtrene (f.eks. «budget», «fresh», «seasonal») er ikke registrert som data hos nok produsenter til å brukes som filter — det ble sluppet for å vise treff. / One of the tag filters (e.g. «budget», «fresh», «seasonal») isn't recorded data for enough producers to filter on — that filter was dropped to show matches.\n\n"
        : "";

      // dev-request 2026-07-25 fix 0g(ii): read-only means read-only — see
      // the same note on lokal_search above. No conversation is started here.

      const header = `🔍 **Strukturert søk** — ${results.length} resultater:\n`;
      const lines = results.map((r: any, i: number) => {
        // Fase 1c honesty rule — see the same note in lokal_search above.
        const dist = r.agent.location?.distanceKm
          ? ` (${r.agent.location.distanceKm.toFixed(1)} km)`
          : r.agent.location?.distanceLabel
            ? ` (${r.agent.location.distanceLabel}, omtrentlig)`
            : "";
        const summary = getAgentKnowledgeSummary("lokal_discover", r.agent.id);
        return formatAgentCompact(r.agent, i + 1, summary.contact, summary, getClientIdentity?.()) + dist;
      });

      deliver("lokal_discover", { categories, tags, drinkSubcategory, lat, lng, maxDistanceKm, limit }, extra, results.map((r: any) => r.agent.id));
      return { content: [{ type: "text" as const, text: tagsRelaxedLine + header + "\n" + lines.join("\n\n") }] };
    })
  );

  // Tool 3: Producer details
  server.registerTool(
    "lokal_info",
    {
      title: "Producer details",
      description: "Get a specific producer's full listed product catalog, contact details, opening hours, and delivery options. Use when you already have an agentId from lokal_search. Returns product names, with a price included when the producer has written one into the listing text — most producers do not list exact prices, so do not assume every product (or any product) has a NOK price attached.",
      inputSchema: {
        agentId: z.string().describe("The producer's agent ID (UUID)"),
      },
      annotations: {
        title: "Producer details",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler("lokal_info", async ({ agentId }, extra) => {
      const info = knowledgeService.getAgentInfo(agentId);
      // Shared by-id visibility predicate (agent-visibility.ts; flag-gated —
      // off = served as before). allowCatalogHidden: the hidden test fixture
      // stays orderable by id.
      if (!info || !isAgentIdPubliclyVisible(getDb(), agentId, { surface: "ungated", allowCatalogHidden: true })) {
        return { content: [{ type: "text" as const, text: `Fant ingen produsent med ID ${agentId}.` }] };
      }

      const { agent, knowledge: k = {} as any, meta = {} as any } = info;
      const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";
      const sections: string[] = [`# ${agent.name}`];

      if (agent.city) {
        sections.push(`📍 ${agent.city}${agent.isVerified ? "  ·  ✔ Verifisert av eier" : ""}`);
      }

      if (k.about) {
        if (isJunkDescription(k.about)) {
          console.log(`[description-guard] suppressed junk knowledge.about (lokal_info) for ${agent.id} (${agent.name})`);
        } else {
          // Strip an appended internal pipeline note (Daniel 2026-09-03) —
          // an AI agent must not relay the fleet's own working notes either.
          // I-N (AI2-08): scraped HTML tags («<br />») are no text either.
          // I-S (F1): an about of only tags gives no section.
          const about = mcpProse(k.about);
          if (about) sections.push(`\n${about}`);
        }
      }

      // Contact
      const contact: string[] = [];
      if (k.address) contact.push(`📍 ${formatAddressLine(k.address, k.postalCode, agent.city)}`);
      if (isDisplayablePhone(k.phone)) contact.push(`📞 ${k.phone}`);
      if (k.email) contact.push(`✉️ ${k.email}`);
      if (k.website) contact.push(`🌐 ${k.website}`);
      if (contact.length) sections.push(`\n## Kontakt\n${contact.join("\n")}`);

      // vCard
      sections.push(`\n🪪 [Last ned kontaktkort (vCard)](${addAiUtmParams(`${BASE_URL}/api/marketplace/agents/${agent.id}/vcard`, getClientIdentity?.())})`);

      // Opening hours (an array, or free text — see formatOpeningHoursForMcp)
      const hoursSection = formatOpeningHoursForMcp(k.openingHours);
      if (hoursSection) sections.push(hoursSection);

      // Products — structured with parsed prices.
      // orch-pr-14: attach catalog product_id (products.id) to each in-stock
      // product so an MCP-only agent can pass it straight to lokal_cart_add_item.
      if (k.products?.length) {
        const productSection = formatProductsForMcp(k.products, getCatalogProductIdMap(agent.id), getCatalogAvailabilityMap(agent.id));
        if (productSection) sections.push(productSection);
      }

      const specialties = textEntries(k.specialties);
      const certifications = textEntries(k.certifications);
      const paymentMethods = textEntries(k.paymentMethods);
      const deliveryOptions = textEntries(k.deliveryOptions);
      if (specialties.length) sections.push(`\n## Spesialiteter\n${specialties.map((s) => `- ${s}`).join("\n")}`);
      if (certifications.length) sections.push(`\n## Sertifiseringer\n${certifications.map((c) => `- ${c}`).join("\n")}`);
      if (paymentMethods.length) sections.push(`\n💳 **Betaling:** ${paymentMethods.join(", ")}`);
      if (deliveryOptions.length) sections.push(`🚚 **Levering:** ${deliveryOptions.join(", ")}`);

      if (meta.disclaimer) {
        const autoSources = textEntries(meta.autoSources);
        const src = autoSources.length ? ` (kilder: ${autoSources.join(", ")})` : "";
        sections.push(`\n---\n_${meta.disclaimer}${src}_`);
      }

      deliver("lokal_info", { agentId }, extra, [agent.id]);
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    })
  );

  // Tool 4: Platform stats
  server.registerTool(
    "lokal_stats",
    {
      title: "Platform statistics",
      description: "Get Lokal platform statistics — total agents, cities covered, interactions.",
      inputSchema: {},
      annotations: {
        title: "Platform statistics",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler("lokal_stats", async () => {
      // Same three figures as the rettfrabonden.com front page: the honest
      // catalog count, and distinct cities and categories among the producers
      // a visitor can find. getStats().totalAgents also counts inactive,
      // unvetted and umbrella rows, and getStats().cities is the list itself.
      const agents = marketplaceRegistry.getActiveAgents();
      const producers = safeHonestCatalogCount("rfb") ?? agents.length;
      const cities = new Set<string>();
      const categories = new Set<string>();
      for (const a of agents as any[]) {
        const city = a.city || a.location?.city;
        if (city) cities.add(city);
        for (const c of textEntries(a.categories)) categories.add(c);
      }
      const text = [
        "📊 **Rett fra Bonden — Plattformstatistikk**",
        `Produsenter: ${producers}`,
        `Byer: ${cities.size}`,
        `Kategorier: ${categories.size}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    })
  );

  // ─── Phase 5.11 A2.5 tools — umbrella discovery ────────────
  // Mirrors the npm-package tools but calls the DB directly (no HTTP loopback).

  // Tool 5: List umbrella organizations
  server.registerTool(
    "lokal_list_umbrellas",
    {
      title: "List umbrella organizations",
      description: "List all umbrella organizations on Lokal — markets-networks (Bondens marked, REKO), venues (Mathallen), industry orgs (Hanen), certifiers (Debio), and cooperatives. Each umbrella has many member producers. Optionally filter by type. Useful when the user asks 'where can I find local food markets?', 'what is Bondens marked?', or 'which certifications matter for local Norwegian food?'.",
      inputSchema: {
        umbrellaType: z.enum(["market_network", "venue", "industry_org", "certification", "cooperative"]).optional().describe("Filter by umbrella type"),
        limit: z.number().min(1).max(200).default(50).describe("Max results"),
      },
      annotations: {
        title: "List umbrella organizations",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler("lokal_list_umbrellas", async ({ umbrellaType, limit }) => {
      const db = getDb();
      const wheres: string[] = ["umbrella_type IS NOT NULL", "is_active = 1"];
      const params: any[] = [];
      if (umbrellaType) { wheres.push("umbrella_type = ?"); params.push(umbrellaType); }
      const lim = Math.min(limit || 50, 200);
      params.push(lim);

      const rows = db.prepare(`
        SELECT id, name, description, umbrella_type, parent_umbrella_id,
               umbrella_member_count, city
        FROM agents
        WHERE ${wheres.join(" AND ")}
        ORDER BY COALESCE(umbrella_member_count, 0) DESC, name ASC
        LIMIT ?
      `).all(...params) as any[];

      if (!rows.length) {
        return { content: [{ type: "text" as const, text: umbrellaType
          ? `Ingen paraplyer av type "${umbrellaType}" funnet.`
          : "Ingen paraplyer registrert ennå." }] };
      }

      const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
      const typeLabels: Record<string, string> = {
        market_network: "🏪 Marked-nettverk",
        venue: "🏛 Salgs-venue",
        industry_org: "🤝 Bransjeorganisasjon",
        certification: "✓ Sertifisering",
        cooperative: "👥 Samvirke",
      };

      const grouped: Record<string, any[]> = {};
      for (const u of rows) {
        const key = u.umbrella_type;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(u);
      }

      const sections = [`🌐 **Paraplyer på Lokal** — ${rows.length} totalt:\n`];
      for (const [type, items] of Object.entries(grouped)) {
        sections.push(`\n## ${typeLabels[type] || type} (${items.length})`);
        for (const u of items) {
          const where = u.city ? ` — ${u.city}` : "";
          const members = (u.umbrella_member_count || 0) > 0 ? ` · ${u.umbrella_member_count} medlemmer` : "";
          sections.push(`- **${u.name}**${where}${members}`);
          // dev-request 2026-08-24-rfb-mcp-verktoybeskrivelser-vs-virkelighet
          // (Funn A): `id` was already selected in the SQL above but never
          // rendered — so lokal_get_umbrella_members's own "use
          // lokal_list_umbrellas to find IDs" instruction was unreachable.
          // Expose the umbrella's existing stable id instead of inventing a
          // new identifier scheme.
          sections.push(`  umbrellaId: ${u.id}`);
          sections.push(`  ${addAiUtmParams(`${BASE}/produsent/${slugify(u.name)}`, getClientIdentity?.())}`);
        }
      }
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    })
  );

  // Tool 6: Producers in an umbrella's network
  server.registerTool(
    "lokal_get_umbrella_members",
    {
      title: "Get producers in an umbrella's network",
      description: "List producers that are members of a specific umbrella organization (e.g. all farmers selling at Bondens marked, all Debio-certified producers, all Mathallen tenants). Returns producer names + cities + profile links. Useful when the user asks 'which farmers sell at Bondens marked?', 'show me all Debio-certified producers', or 'who is at Mathallen Oslo?'.",
      inputSchema: {
        umbrellaId: z.string().describe("Umbrella agent ID (UUID). Use lokal_list_umbrellas to find IDs."),
        limit: z.number().min(1).max(500).default(100).describe("Max results"),
      },
      annotations: {
        title: "Get producers in an umbrella's network",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler("lokal_get_umbrella_members", async ({ umbrellaId, limit }, extra) => {
      const db = getDb();
      const umbrella = db.prepare(
        "SELECT id, name, umbrella_type FROM agents WHERE id = ? AND umbrella_type IS NOT NULL AND is_active = 1"
      ).get(umbrellaId) as any;
      if (!umbrella) {
        return { content: [{ type: "text" as const, text: `Fant ingen paraply med ID ${umbrellaId}.` }] };
      }

      const lim = Math.min(limit || 100, 500);
      const rows = db.prepare(`
        SELECT p.id, p.name, p.city, p.role, p.umbrella_type AS member_umbrella_type, aff.labels
        FROM agent_affiliations aff
        INNER JOIN agents p ON p.id = aff.producer_id
        WHERE aff.umbrella_id = ? AND aff.status = 'active' AND p.is_active = 1
          AND ${publicListableSql("p")}
        ORDER BY p.name ASC
        LIMIT ?
      `).all(umbrellaId, lim) as any[];

      if (!rows.length) {
        return { content: [{ type: "text" as const, text: `Ingen produsenter i ${umbrella.name} ennå.` }] };
      }

      const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
      const sections = [`🤝 **${umbrella.name}** — ${rows.length} produsenter:\n`];
      for (const m of rows) {
        let labels: string[] = [];
        if (m.labels) { try { labels = textEntries(JSON.parse(m.labels)); } catch { /* ignore */ } }
        const labelStr = labels.length ? ` _(${labels.join(", ")})_` : "";
        const where = m.city ? ` — ${m.city}` : "";
        sections.push(`- **${m.name}**${where}${labelStr}`);
        // Skive A2: no link for roles whose /produsent/<slug> page 404s.
        if (!failsProducerRoleGate(m.role, !!m.member_umbrella_type)) {
          sections.push(`  ${addAiUtmParams(`${BASE}/produsent/${slugify(m.name)}`, getClientIdentity?.())}`);
        }
      }
      deliver("lokal_get_umbrella_members", { umbrellaId, limit }, extra, rows.map((m: any) => m.id));
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    })
  );

  // Tool 7: Umbrellas a producer belongs to
  server.registerTool(
    "lokal_get_producer_affiliations",
    {
      title: "Get a producer's umbrella affiliations",
      description: "List umbrella organizations a specific producer is a member of (e.g. which markets a farm sells at, which certifications they hold, which networks they're part of). Returns umbrella names + types + their profile links. Useful when the user asks 'where does <Farmer X> sell?', 'is <Farm Y> Debio-certified?', or 'which markets does <Producer Z> attend?'.",
      inputSchema: {
        producerId: z.string().describe("Producer agent ID (UUID). Get this from lokal_search or lokal_discover results."),
      },
      annotations: {
        title: "Get a producer's umbrella affiliations",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler("lokal_get_producer_affiliations", async ({ producerId }) => {
      const db = getDb();
      const producer = db.prepare(
        "SELECT id, name, umbrella_type FROM agents WHERE id = ? AND is_active = 1"
      ).get(producerId) as any;
      if (!producer) {
        return { content: [{ type: "text" as const, text: `Fant ingen produsent med ID ${producerId}.` }] };
      }

      const rows = db.prepare(`
        SELECT u.id, u.name, u.umbrella_type, aff.labels
        FROM agent_affiliations aff
        INNER JOIN agents u ON u.id = aff.umbrella_id
        WHERE aff.producer_id = ? AND aff.status = 'active' AND u.is_active = 1
        ORDER BY u.name ASC
      `).all(producerId) as any[];

      if (!rows.length) {
        return { content: [{ type: "text" as const, text: `${producer.name} har ingen registrerte paraplyer-tilknytninger.` }] };
      }

      const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
      const typeLabels: Record<string, string> = {
        market_network: "Marked-nettverk",
        venue: "Salgs-venue",
        industry_org: "Bransjeorganisasjon",
        certification: "Sertifisering",
        cooperative: "Samvirke",
      };

      const sections = [`🔗 **${producer.name}** — ${rows.length} tilknytninger:\n`];
      for (const a of rows) {
        let labels: string[] = [];
        if (a.labels) { try { labels = textEntries(JSON.parse(a.labels)); } catch { /* ignore */ } }
        const labelStr = labels.length ? ` _(${labels.join(", ")})_` : "";
        const type = typeLabels[a.umbrella_type] || a.umbrella_type;
        sections.push(`- **${a.name}** (${type})${labelStr}`);
        sections.push(`  ${addAiUtmParams(`${BASE}/produsent/${slugify(a.name)}`, getClientIdentity?.())}`);
      }
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    })
  );

  // Tool 8: Upcoming Bondens marked events (PR-56, 2026-05-16)
  // Public-data DB-direct query — same pattern as the umbrella tools above
  // (no HTTP loopback). Reads bm_market_events populated by the daily
  // scraper at POST /admin/bm-events/scrape.
  server.registerTool(
    "lokal_bm_next_markets",
    {
      title: "Get upcoming Bondens marked events",
      description: "Returns upcoming Bondens marked events (markedsdager) for a region or specific lokallag/venue. Useful when AI agents are asked 'when is the next Bondens marked in Oslo?' or similar. Data is refreshed daily from bondensmarked.no.",
      inputSchema: {
        region: z.string().optional().describe("City or region substring filter, e.g. 'Oslo', 'Bergen', 'Vestfold'"),
        lokallag_slug: z.string().optional().describe("Lokallag slug, e.g. 'bondens-marked-agder'. Filters to events at any venue under this lokallag."),
        days: z.number().int().min(1).max(90).optional().describe("Look-ahead window in days (default 30, max 90)"),
      },
      annotations: {
        title: "Upcoming Bondens marked events",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler("lokal_bm_next_markets", async ({ region: regionAsSent, lokallag_slug, days }) => {
      // Slice I-Y2 (FUNN strukturerte-stedsfelt-uten-lengdetak): `region` is a
      // place name, cut to MAX_NAME_CHARS at a word boundary
      // (utils/free-text.ts). It is a LIKE over each event's place, and an
      // empty answer echoes it.
      const region = capName(regionAsSent);
      const db = getDb();
      const lookahead = Math.max(1, Math.min(days || 30, 90));
      const fromIso = new Date().toISOString();
      const toIso = new Date(Date.now() + lookahead * 24 * 60 * 60 * 1000).toISOString();

      const wheres: string[] = ["e.start_at >= ?", "e.start_at <= ?"];
      // PR-94: exclude unreviewed bm_venue placeholders from MCP output.
      wheres.push("(a.umbrella_type != 'bm_venue' OR a.agent_review_status = 'confirmed')");
      const params: any[] = [fromIso, toIso];

      let lokallagId: string | null = null;
      if (lokallag_slug) {
        // Resolve the slug back to an agent_id by scanning lokallag rows
        // (small set — at most ~15) and slugifying each name.
        try {
          const lokallags = db.prepare(
            "SELECT id, name FROM agents WHERE umbrella_type IN ('market_network','venue') AND is_active = 1"
          ).all() as Array<{ id: string; name: string }>;
          const wanted = lokallag_slug.toLowerCase();
          const hit = lokallags.find(l => slugify(l.name) === wanted);
          if (hit) lokallagId = hit.id;
        } catch { /* table missing — leave lokallagId null */ }
      }
      if (lokallagId) {
        wheres.push("(e.venue_agent_id = ? OR a.parent_umbrella_id = ?)");
        params.push(lokallagId, lokallagId);
      }
      if (region) {
        wheres.push("LOWER(e.location_text) LIKE ?");
        params.push(`%${region.toLowerCase()}%`);
      }

      let rows: any[] = [];
      try {
        rows = db.prepare(`
          SELECT e.event_slug, e.event_name, e.location_text, e.start_at, e.end_at, e.source_url,
                 a.id AS venue_agent_id, a.name AS venue_name
          FROM bm_market_events e
          INNER JOIN agents a ON a.id = e.venue_agent_id
          WHERE ${wheres.join(" AND ")}
          ORDER BY e.start_at ASC
          LIMIT 50
        `).all(...params) as any[];
      } catch {
        return { content: [{ type: "text" as const, text: "Bondens marked-arrangementer er ikke tilgjengelig ennå (skraperen har ikke kjørt)." }] };
      }

      if (!rows.length) {
        const filters: string[] = [];
        if (region) filters.push(`region "${region}"`);
        if (lokallag_slug) filters.push(`lokallag "${lokallag_slug}"`);
        const filterStr = filters.length ? ` med filter ${filters.join(", ")}` : "";
        return { content: [{ type: "text" as const, text: `Ingen kommende markedsdager neste ${lookahead} dager${filterStr}.` }] };
      }

      const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
      const sections = [`📅 **${rows.length} kommende markedsdager** (neste ${lookahead} dager):\n`];
      for (const r of rows) {
        const date = (r.start_at || "").slice(0, 10);
        const time = (r.start_at || "").slice(11, 16);
        const endTime = r.end_at ? (r.end_at || "").slice(11, 16) : "";
        const timeStr = time ? ` ${time}${endTime ? "–" + endTime : ""}` : "";
        sections.push(`- **${date}${timeStr}** — ${r.event_name} (${r.location_text})`);
        sections.push(`  ${addAiUtmParams(`${BASE}/produsent/${slugify(r.venue_name)}`, getClientIdentity?.())}`);
        sections.push(`  Kilde: ${r.source_url}`);
      }
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    })
  );

  // Tool 9: Geocode Norwegian place names (PR-76)
  // Resolves a Norwegian place name to lat/lng coordinates. Backs the
  // geocodingService directly — no HTTP loopback. With PR-75's expanded
  // MAJOR_CITIES, most calls return hardcoded coords instantly. Anything
  // not hardcoded falls back to DB-lookup → Kartverket API.
  server.registerTool(
    "lokal_geocode",
    {
      title: "Geocode a Norwegian place name",
      description: "Resolve a Norwegian place name (city, town, region, fylke, or kommune) to lat/lng coordinates. Use this when you need explicit coordinates for lokal_discover (e.g., 'show me organic farms within 10 km of Florø'). Returns coordinates + suggested search radius. Covers all of Norway via Kartverket Stedsnavn API fallback. Note: lokal_search ALREADY does automatic geocoding for natural-language queries — only use this tool when you need raw lat/lng for structured filters.",
      inputSchema: {
        place: z.string().describe("Norwegian place name (city, town, region, fylke, kommune). Examples: 'Oslo', 'Røros', 'Vestland', 'Setesdal', 'Florø'"),
      },
      annotations: {
        title: "Geocode Norwegian place",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // Open world: names not in the built-in list or our producer table are
        // resolved through Kartverket's public place-name API (see
        // lokal_search above). Declared false in v1.0.1 while the description
        // already said "via Kartverket Stedsnavn API fallback".
        openWorldHint: true,
      },
    },
    guardToolHandler("lokal_geocode", async ({ place: placeAsSent }) => {
      // Slice I-Y2: a place name, cut to MAX_NAME_CHARS at a word boundary
      // (utils/free-text.ts); the answer echoes it when nothing is found.
      const place = capName(placeAsSent);
      const result = await geocodingService.geocode(place);
      if (!result) {
        return {
          content: [{
            type: "text" as const,
            text: `Fant ikke koordinater for "${place}". Prøv en kjent norsk by, kommune, region eller fylke.`,
          }],
        };
      }
      // Concise structured text — LLM-friendly + line-parseable
      return {
        content: [{
          type: "text" as const,
          text: `📍 ${result.name}\nlat: ${result.lat}\nlng: ${result.lng}\nradius_km: ${result.radiusKm}\nsource: ${result.source}`,
        }],
      };
    })
  );

  // Tool: lokal_find_offers — dev-request 2026-09-16-handleliste-med-
  // produsentvalg-og-bestillingsflyt, Slice 0. Per-item multi-producer offer
  // lookup: for each search term in `items`, finds up to 5 nearby eligible
  // producers selling it, nearest first. Calls the exact same
  // findOffers() logic as GET /api/marketplace/catalog/offers — see
  // ../services/catalog-offers.ts for the full field contract (this is the
  // "which producer has X near me, and can I order from them" tool a future
  // shopping-list flow (later slice) will build on).
  server.registerTool(
    "lokal_find_offers",
    {
      title: "Find offers for shopping-list items",
      description: "For each item in a shopping list, find up to 5 nearby producers who sell it (or a matching product), sorted by distance, with contact info and whether an order can be placed through the platform (can_order). Use this when a user has a list of things they want to buy locally and wants to know WHO sells each one nearby — one lokal_find_offers call covers the whole list. Read-only.",
      inputSchema: {
        items: z.array(z.string()).min(1).describe("Search terms/item names to find offers for, e.g. ['poteter', 'honning', 'egg']."),
        near: z.string().optional().describe("Norwegian place name to search near (geocoded automatically). Supply this OR lat/lng."),
        lat: z.number().min(-90).max(90).optional().describe("User's latitude (WGS84). Supply together with lng."),
        lng: z.number().min(-180).max(180).optional().describe("User's longitude (WGS84). Must be supplied together with lat."),
        radius_km: z.number().min(1).max(500).optional().describe("Search radius in km. Default 50."),
      },
      annotations: {
        title: "Find offers for shopping-list items",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // Open world: `near` is geocoded, which can reach Kartverket's public
        // place-name API (see lokal_search above).
        openWorldHint: true,
      },
    },
    guardToolHandler("lokal_find_offers", async ({ items, near: nearAsSent, lat, lng, radius_km }, extra) => {
      // GHSA-46jr (lokal#1229): more than MCP_MAX_SHOPPING_ITEMS items is
      // refused here, not with .max() in the inputSchema, so tools/list stays
      // the frozen contract. 21..MCP_MAX_SHOPPING_ITEMS items keep the
      // MAX_OFFER_ITEMS cut and its note below.
      if (Array.isArray(items) && items.length > MCP_MAX_SHOPPING_ITEMS) {
        return mcpListTooLongResult("items", MCP_MAX_SHOPPING_ITEMS, items.length);
      }
      // Slice I-Y2: `near` is a place name, cut to MAX_NAME_CHARS at a word
      // boundary (utils/free-text.ts). Each item's lookup used to geocode the
      // whole text again.
      const near = capName(nearAsSent);
      const foreign = foreignPlaceIn(near);
      if (foreign) return outsideNorwayAnswer(foreign);
      const hasCoords = isValidLatLng(lat as number, lng as number);
      if (!hasCoords && !(near && near.trim())) {
        return {
          content: [{
            type: "text" as const,
            text: "Oppgi enten `near` (stedsnavn) eller `lat` + `lng`. / Supply either `near` or `lat` + `lng`.",
          }],
        };
      }

      const radiusKm = resolveOffersRadiusKm(radius_km);
      // Slice I-Y: each item is a catalog lookup, so each is cut like the
      // search text (utils/free-text.ts). An item past SQLite's LIKE pattern
      // limit (50 000 bytes) used to fail the whole call.
      // Slice I-Y2: and only the first MAX_OFFER_ITEMS items are looked up.
      const terms = items.slice(0, MAX_OFFER_ITEMS).map((item) => capFreeText(item));
      const results = [];
      for (const q of terms) {
        const result = await findOffers({
          q,
          near: hasCoords ? undefined : near,
          lat: hasCoords ? (lat as number) : undefined,
          lng: hasCoords ? (lng as number) : undefined,
          radiusKm,
          limit: resolveOffersLimit(undefined),
        });
        results.push(result);
      }

      // I-S2: a category match hands its producer to the caller too.
      deliver("lokal_find_offers", { items: terms, near, lat, lng, radius_km }, extra,
        results.flatMap((r) => [...r.offers, ...(r.category_matches ?? [])].map((o) => o.producer.agent_id)));
      const content = [{ type: "text" as const, text: JSON.stringify(results, null, 2) }];
      // I-Y2: the JSON stays the list of results; the note is its own part.
      if (items.length > MAX_OFFER_ITEMS) content.push({ type: "text" as const, text: offersItemsOmittedText(items) });
      return { content };
    })
  );

  // ─── Cart tools (Phase 1) ────────────────────────────────────
  // Tools 10-14: shopping cart ("handleliste") for local food pickup orders.
  // No payment. Anonymous buyer (buyer_ref token). Submitting e-mails the
  // producers who opted in to order notifications (see lokal_cart_submit).

  // Tool 10: Create a cart
  server.registerTool(
    "lokal_cart_create",
    {
      title: "Create a shopping cart",
      description: paymentsOn
        ? "Create a new anonymous shopping cart ('handleliste'). Returns a cart_id and a buyer_ref capability token — STORE THE buyer_ref, it is required for all subsequent cart operations and cannot be recovered. Each cart is valid for 7 days. Use lokal_cart_add_item to add products, lokal_cart_view to review, and lokal_cart_submit to place orders (pickup; producers that take prepayment get a Stripe payment link the buyer approves themselves, the others are paid at pickup)."
        : "Create a new anonymous shopping cart ('handleliste'). Returns a cart_id and a buyer_ref capability token — STORE THE buyer_ref, it is required for all subsequent cart operations and cannot be recovered. Each cart is valid for 7 days. Use lokal_cart_add_item to add products, lokal_cart_view to review, and lokal_cart_submit to place orders (pickup, no payment).",
      inputSchema: {},
      annotations: {
        title: "Create shopping cart",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler("lokal_cart_create", async () => {
      try {
        const result = svcCreateCart();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, ...result }, null, 2),
          }],
        };
      } catch (err) {
        // Same rule as guardToolHandler: the detail is logged, never returned.
        console.error("[mcp] lokal_cart_create failed:", err instanceof Error ? err.stack || err.message : String(err));
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: MCP_INTERNAL_ERROR_TEXT }) }] };
      }
    })
  );

  // Tool 11: Add item to cart
  server.registerTool(
    "lokal_cart_add_item",
    {
      title: "Add item to shopping cart",
      description: "Add a product to the cart or update its quantity (re-adding the same product_id updates qty). Product must be in_stock and from a verified non-umbrella producer (use lokal_search / catalog feed to find eligible products and their IDs). Requires cart_id and buyer_ref from lokal_cart_create.",
      inputSchema: {
        cart_id:    z.string().describe("Cart ID from lokal_cart_create"),
        buyer_ref:  z.string().describe("Buyer capability token from lokal_cart_create"),
        product_id: z.string().describe("Product ID from the catalog (products.id)"),
        qty:        z.number().int().positive().describe("Quantity to set for this product in the cart"),
        note:       z.string().optional().describe("Optional line note for this item (e.g. 'please keep cold')"),
      },
      annotations: {
        title: "Add cart item",
        readOnlyHint: false,
        // Destructive: re-adding a product already in the cart REPLACES that
        // line's quantity and note (upsert, see cart-service.addCartItem) — it
        // overwrites what the user set before. Idempotent for the same reason:
        // the same call twice leaves the same cart. (ChatGPT app review
        // 2026-09-24: both were false in v1.0.1.)
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler("lokal_cart_add_item", async ({ cart_id, buyer_ref, product_id, qty, note }) => {
      const check = svcCheckCartToken(cart_id, buyer_ref);
      if (!check.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: check.error }) }] };
      }
      const result = svcAddCartItem(cart_id, product_id, qty, note);
      if (!result.success) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: result.error }) }] };
      }
      const cart = svcViewCart(cart_id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, item: result.item, cart }, null, 2),
        }],
      };
    })
  );

  // Tool 12: View cart
  server.registerTool(
    "lokal_cart_view",
    {
      title: "View shopping cart",
      description: "View the current contents of a cart, grouped by producer, with subtotals and a total. Use this before submitting to review what is in the cart. Requires cart_id and buyer_ref.",
      inputSchema: {
        cart_id:   z.string().describe("Cart ID from lokal_cart_create"),
        buyer_ref: z.string().describe("Buyer capability token from lokal_cart_create"),
      },
      annotations: {
        title: "View cart",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler("lokal_cart_view", async ({ cart_id, buyer_ref }) => {
      const check = svcCheckCartToken(cart_id, buyer_ref);
      if (!check.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: check.error }) }] };
      }
      const cart = svcViewCart(cart_id);
      if (!cart) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Cart not found" }) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(cart, null, 2) }] };
    })
  );

  // Tool 13: Submit cart → place pickup orders
  server.registerTool(
    "lokal_cart_submit",
    {
      title: "Submit cart and place pickup orders",
      // Prepayment (A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-
      // connect, skive 2): with PAYMENTS_ENABLED off the description and
      // schema are exactly what they were; with it on they say how payment
      // links work and accept pay_at_pickup.
      description: paymentsOn
        ? "Submit the cart. Re-checks availability of every item at submit time; if any item is no longer in_stock, submit is rejected with a clear per-item message. This tool never charges anyone. A real pickup order (one per producer) is created ONLY for producers who are owner-verified AND have opted in to receive orders through the platform (can_order=true in lokal_find_offers). For producers that take prepayment, the order also gets an entry in payments[] with a Stripe checkout_url: the buyer must open it and approve the payment themselves (you never see card data). Each entry carries seller_trader_status, the producer's own declaration ('trader', 'non_trader' or null): when it is 'non_trader', tell the buyer before they pay that the Consumer Purchases Act and the Cancellation Act then do not apply. The producer is the seller; the amount is reserved and only captured when the producer confirms the order, and released if the producer declines. If the buyer does not pay before expires_at, the order goes to the producer as pay-at-pickup. Set pay_at_pickup=true to skip prepayment. Orders without a payments[] entry are paid at pickup. Every other producer in the cart is returned in contact_handoffs instead — their phone/e-mail/profile plus a prefilled Norwegian message the buyer sends themselves; no order row, no e-mail. Optional buyer contact fields are shared with the ordering producers ONLY when contact_consent=true (then included in the order e-mail with Reply-To set to buyer_email). Submitting places binding orders under Rett fra Bonden's terms of purchase (terms_url in the response): get the buyer's explicit go-ahead before calling, and show them terms_url. Returns orders[] (with payment_mode and producer_contact — the seller's phone/e-mail/profile for cancellation and complaints), payments[], contact_handoffs[] and terms_url. Use lokal_order_status to check an order."
        : "Submit the cart. Re-checks availability of every item at submit time; if any item is no longer in_stock, submit is rejected with a clear per-item message. No payment is charged. A real pickup order (one per producer) is created ONLY for producers who are owner-verified AND have opted in to receive orders through the platform (can_order=true in lokal_find_offers); they get the order by e-mail and can confirm/decline it. Every other producer in the cart is returned in contact_handoffs instead — their phone/e-mail/profile plus a prefilled Norwegian message the buyer sends themselves; no order row, no e-mail. Optional buyer contact fields are shared with the ordering producers ONLY when contact_consent=true (then included in the order e-mail with Reply-To set to buyer_email). Returns orders[] and contact_handoffs[]. Use lokal_order_status to check an order.",
      inputSchema: {
        cart_id:   z.string().describe("Cart ID to submit"),
        buyer_ref: z.string().describe("Buyer capability token"),
        buyer_name:      z.string().max(120).optional().describe("Buyer's name — shared with ordering producers only when contact_consent=true"),
        buyer_email:     z.string().max(254).optional().describe("Buyer's e-mail — becomes the order e-mail's Reply-To when contact_consent=true"),
        buyer_phone:     z.string().max(40).optional().describe("Buyer's phone — shared only when contact_consent=true"),
        delivery_note:   z.string().max(500).optional().describe("Free-text delivery/pickup wish for the producer (orders are pickup; this is informational)"),
        contact_consent: z.boolean().optional().describe("true = the buyer agrees that the contact fields above are passed to the producers who receive a real order. Default false: fields are stored on the cart but never shown to any producer."),
        ...(paymentsOn
          ? { pay_at_pickup: z.boolean().optional().describe("true = no prepayment; every order is paid at pickup. Default false: producers that take prepayment get a payment link in payments[].") }
          : {}),
      },
      annotations: {
        title: "Submit cart",
        readOnlyHint: false,
        // Destructive: submitting cannot be undone from the buyer's side — the
        // cart is closed for editing and each opted-in producer is e-mailed
        // about their order, and a sent e-mail cannot be recalled. OpenAI's
        // rule: "sending messages or transactions you can't undo" → true.
        // (ChatGPT app review 2026-09-24: false in v1.0.1.)
        destructiveHint: true,
        idempotentHint: false,
        // openWorldHint is TRUE because submitting reaches a third party outside
        // this app: sellers who opted in to order notifications are emailed about
        // their own order (order-notify-service). The only other open-world
        // tools are the three that can query Kartverket's public place-name API
        // (lokal_search, lokal_geocode, lokal_find_offers).
        openWorldHint: true,
      },
    },
    guardToolHandler("lokal_cart_submit", async ({ cart_id, buyer_ref, buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent, ...rest }: any) => {
      const check = svcCheckCartToken(cart_id, buyer_ref);
      if (!check.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: check.error }) }] };
      }
      // Same trim-or-null normalisation as the REST route (marketplace-cart.ts).
      const t = (v: unknown) => (typeof v === "string" ? v.trim() || null : null);
      const contact = {
        buyer_name: t(buyer_name),
        buyer_email: t(buyer_email),
        buyer_phone: t(buyer_phone),
        delivery_note: t(delivery_note),
        contact_consent: contact_consent === true,
        pay_at_pickup: rest?.pay_at_pickup === true,
      };
      const result = paymentsOn
        ? await submitCartWithPayments({
            cartId: cart_id,
            contact,
            stripe: resolvePaymentsStripeClient(),
            baseUrl: process.env.BASE_URL || "https://rettfrabonden.com",
          })
        : svcSubmitCart(cart_id, contact);
      return { content: [{ type: "text" as const, text: cartResultText("lokal_cart_submit", result) }] };
    })
  );

  // Tool 14: Order status
  server.registerTool(
    "lokal_order_status",
    {
      title: "Get order status",
      description: paymentsOn
        ? "Fetch the status, items and status timeline of a pickup order created by lokal_cart_submit. Requires the order_id returned by submit and the buyer_ref token. Status: pending → confirmed → ready → completed (or declined/cancelled; cancel_reason='no_show' means the buyer did not pick up, 'producer_cancelled' that the producer could not deliver (a captured payment is refunded), 'buyer_cancelled' that the buyer withdrew, 'payment_expired' that the producer did not confirm a prepaid order in time and the reservation was released). The timeline array lists every status transition with timestamps. producer_contact is the seller's phone/e-mail/profile for cancellation, the right of withdrawal and complaints. Prepaid orders also carry payment: status (requires_payment → authorized → captured, or canceled/expired/refunded), amount_nok, refunded_nok, fees, the checkout_url while it can still be paid, and events. The producer is the seller."
        : "Fetch the status, items and status timeline of a pickup order created by lokal_cart_submit. Requires the order_id returned by submit and the buyer_ref token. Status: pending → confirmed → ready → completed (or declined/cancelled; cancel_reason='no_show' means the buyer did not pick up). The timeline array lists every status transition with timestamps.",
      inputSchema: {
        order_id:  z.string().describe("Order ID from lokal_cart_submit"),
        buyer_ref: z.string().describe("Buyer capability token (same as used for the cart)"),
      },
      annotations: {
        title: "Order status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler("lokal_order_status", async ({ order_id, buyer_ref }) => {
      const result = svcGetOrder(order_id, buyer_ref);
      return { content: [{ type: "text" as const, text: cartResultText("lokal_order_status", result) }] };
    })
  );

  // ─── MCP Resources ──────────────────────────────────────────
  // Resources let agents READ data directly (vs tools which are actions).
  // This is the MCP equivalent of a database view.

  server.resource(
    "producers-overview",
    "lokal://producers/overview",
    { description: "Overview of all local food producers — count, cities, and categories", mimeType: "text/plain" },
    async () => {
      const agents = marketplaceRegistry.getActiveAgents();
      const cities = new Map<string, number>();
      for (const a of agents) {
        const city = (a as any).city || a.location?.city || "Ukjent";
        cities.set(city, (cities.get(city) || 0) + 1);
      }
      const topCities = [...cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      const text = [
        `# Rett fra Bonden — ${agents.length} lokale matprodusenter i Norge`,
        ``,
        `## Byer:`,
        ...topCities.map(([city, count]) => `- ${city}: ${count} produsenter`),
      ].join("\n");
      return { contents: [{ uri: "lokal://producers/overview", text, mimeType: "text/plain" }] };
    }
  );

  server.resource(
    "producer-detail",
    "lokal://producers/{agentId}",
    { description: "Detailed info about a specific food producer", mimeType: "application/json" },
    async (uri) => {
      const agentId = uri.pathname?.split("/").pop() || "";
      const info = knowledgeService.getAgentInfo(agentId);
      // Shared by-id visibility predicate (flag-gated, see lokal_info).
      if (!info || !isAgentIdPubliclyVisible(getDb(), agentId, { surface: "ungated" })) {
        return { contents: [{ uri: uri.href, text: "Producer not found", mimeType: "text/plain" }] };
      }
      return { contents: [{ uri: uri.href, text: JSON.stringify(info, null, 2), mimeType: "application/json" }] };
    }
  );
}

// ─── Compact agent formatter ────────────────────────────────

// `products` is the producer's AgentKnowledgeSummary: its «🛒 …» line, and the
// lokal_info pointer when it has products (I-S: also when they are only
// category labels, which have no 🛒 line).
function formatAgentCompact(agent: any, idx: number, contact?: any,
  products?: Pick<AgentKnowledgeSummary, "productSummary" | "productsCount">, clientIdentity?: string,
  display?: { headingSuffix?: string; hideDescription?: boolean }): string {
  const lines = [`**${idx}. ${agent.name}${display?.headingSuffix ?? ""}**`];
  if (agent.description && !display?.hideDescription) {
    if (isJunkDescription(agent.description)) {
      console.log(`[description-guard] suppressed junk description (lokal_search) for ${agent.id} (${agent.name})`);
    } else {
      // I-N (AI2-08): a line break in scraped HTML keeps the result's indent.
      // I-S (F1): a description of only tags gives no line.
      const description = mcpProse(agent.description, "\n   ");
      if (description) lines.push(`   ${description}`);
    }
  }

  const meta: string[] = [];
  if ((agent as any).city || agent.location?.city) meta.push(`📍 ${(agent as any).city || agent.location?.city}`);
  const categories = textEntries(agent.categories);
  if (categories.length) meta.push(`🏷️ ${categories.join(", ")}`);
  if (meta.length) lines.push(`   ${meta.join("  ·  ")}`);

  if (contact) {
    const cl: string[] = [];
    if (contact.address) cl.push(`📍 ${contact.address}`);
    if (isDisplayablePhone(contact.phone)) cl.push(`📞 ${contact.phone}`);
    if (contact.email) cl.push(`✉️ ${contact.email}`);
    if (contact.website) cl.push(`🌐 ${contact.website}`);
    if (cl.length) lines.push(`   ${cl.join("  ·  ")}`);
  }

  // Product summary: top products with "get details" hint
  if (products?.productSummary) lines.push(`   ${products.productSummary}`);
  if (products?.productsCount) {
    // dev-request 2026-09-05-rfb-mcp-engelsk-sok-kategorifeil: this line used
    // to promise "full prisliste". lokal_info's own tool description was
    // corrected in 2026-08-24-rfb-mcp-verktoybeskrivelser-vs-virkelighet
    // ("most producers do not list exact prices"), but this runtime string was
    // missed — so the search output still told the model a price list was one
    // call away, the model told the user, and lokal_info returned product
    // names. Measured 2026-08-24: 6 of 224 producers (3 %) carried any price
    // marker at all. Say what the next call actually returns.
    lines.push(`   _Bruk lokal_info med agentId "${agent.id}" for kontaktinfo, åpningstider og hele produktlista (pris kun der produsenten har oppgitt den)_`);
  }

  // Profile link
  const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";
  // Skive A2: no profile link for roles whose /produsent/<slug> 404s.
  if (!failsProducerRoleGate((agent as any).role, false)) {
    lines.push(`   🔗 [Profil](${addAiUtmParams(`${BASE_URL}/produsent/${slugify(agent.name)}`, clientIdentity)})`);
  }

  return lines.join("\n");
}

// ─── Session management ─────────────────────────────────────
// Each MCP client (ChatGPT session) gets its own transport+server pair.
// Sessions are cleaned up after 30 min of inactivity.

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  clientIdentity?: string;  // e.g. "ChatGPT", "Claude Desktop", "Cursor"
  requestMeta?: import("../services/conversation-service").RequestMeta;  // (item 3) internal-traffic classification signals
}

// ─── MCP client identity detection ─────────────────────────
// Identifies the AI platform from request headers.
function detectMcpClient(req: Request): string | undefined {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const origin = (req.headers["origin"] || "").toLowerCase();
  const referer = (req.headers["referer"] || "").toLowerCase();

  if (ua.includes("chatgpt") || ua.includes("openai") || origin.includes("openai") || origin.includes("chatgpt")) return "ChatGPT";
  if (ua.includes("claude") || origin.includes("claude.ai") || origin.includes("anthropic")) return "Claude";
  if (ua.includes("cursor")) return "Cursor";
  if (ua.includes("copilot") || origin.includes("github.com")) return "GitHub Copilot";
  if (ua.includes("windsurf")) return "Windsurf";
  if (ua.includes("cline")) return "Cline";
  if (ua.includes("continue")) return "Continue";
  if (ua.includes("python")) return "Python SDK";
  if (ua.includes("node")) return "Node SDK";
  return undefined;
}


const sessions = new Map<string, McpSession>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// The /mcp rate limiter's "is this a live session?" check (mcpPrimaryKey in
// middleware/mcp-rate-limit.ts): only a session this router minted gets its
// own bucket. Read-only; nothing here changes session handling.
export function hasMcpSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

// Cleanup stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      session.transport.close?.();
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

/**
 * Server-wide guidance returned from `initialize`. ChatGPT reads these
 * alongside the tool descriptions (plugins changelog 2026-05-26). They state
 * what the app cannot do, so a reviewer's out-of-scope request is answered
 * with the app's own limits (ChatGPT pre-submission check 2026-10-10: the
 * negative case "Send a marketing e-mail to every producer in Vestfold" got
 * a drafted e-mail and no statement that Rett fra Bonden cannot send one).
 */
export const RFB_MCP_INSTRUCTIONS =
  "Rett fra Bonden covers small-scale food producers in Norway only. When the user asks about a place outside " +
  "Norway, say that it only covers Norway; do not present Norwegian producers as an answer about another country. " +
  "It never takes payment and never asks for card details: a pickup order is paid to the producer at pickup. " +
  "It cannot send marketing, newsletters or bulk messages to producers. The only message it sends is the user's " +
  "own pickup order (lokal_cart_submit), and only to producers who have opted in to orders through the platform; " +
  "other producers are returned as contact details. When asked to do something outside these limits, say plainly " +
  "that Rett fra Bonden cannot do it. When refusing marketing or bulk e-mail, explain the opted-in pickup-order " +
  "limit above; do not use Rett fra Bonden tools to assemble a marketing recipient list or draft a campaign. " +
  "For a product search, preserve the tool result's distinction between an explicitly listed product and a broad " +
  "category match. Show explicit product matches first. Label a category-only match as such and tell the user " +
  "to ask the producer whether they sell the requested product; a producer description is not proof that the " +
  "product is currently listed or available.";

/**
 * Prepayment (A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-
 * connect, skive 4): the instructions with PAYMENTS_ENABLED=1. The platform
 * still never handles card details — where a producer offers prepayment the
 * buyer pays on Stripe's own page, directly to the producer.
 */
const RFB_NO_PAYMENT_SENTENCE =
  "It never takes payment and never asks for card details: a pickup order is paid to the producer at pickup. ";
// Derived from RFB_MCP_INSTRUCTIONS so later edits to the shared guidance
// reach both variants; only the payment sentence differs.
export const RFB_MCP_INSTRUCTIONS_PREPAY = RFB_MCP_INSTRUCTIONS.replace(
  RFB_NO_PAYMENT_SENTENCE,
  "It never asks for or handles card details. Some producers take prepayment: lokal_cart_submit then returns a " +
  "Stripe payment link that the user opens and approves themselves; the producer is the seller and the amount is " +
  "only charged when the producer confirms. Every other pickup order is paid to the producer at pickup. ",
);

/** The instructions for a new MCP server: unchanged unless PAYMENTS_ENABLED=1. */
export function rfbMcpInstructions(): string {
  return isPaymentsEnabled() ? RFB_MCP_INSTRUCTIONS_PREPAY : RFB_MCP_INSTRUCTIONS;
}

async function getOrCreateSession(
  sessionId: string | undefined,
  isInitialize: boolean,
  req?: Request
): Promise<{ id: string; session: McpSession } | { notFound: true }> {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    // Update client identity if we detect one and didn't have one before
    if (!session.clientIdentity && req) {
      session.clientIdentity = detectMcpClient(req);
    }
    // Capture internal-traffic classification signals if not yet known (item 3)
    if (!session.requestMeta && req) {
      session.requestMeta = buildRequestMeta(req);
    }
    return { id: sessionId, session };
  }

  if (!isInitialize) {
    // Not an initialize call, and the top guard above didn't find (or
    // wasn't given) a live session — either a session id was PROVIDED but
    // is unknown/expired (e.g. the in-memory map was wiped by a
    // deploy/restart), or NO session id was sent at all. Per the MCP spec
    // both are a 404, not a silently-created new session — creating one
    // here would leave a phantom, never properly-negotiated session that
    // still fails every subsequent call (the SDK's own transport would
    // reject it with a misleading 400 "Server not initialized" the moment
    // a real request reached it, since this fresh transport instance never
    // actually ran `initialize`). This is AC2 of the filed dev-request:
    // "tools/list uten sesjon og uten forutgående initialize -> 404".
    // Nothing is inserted into `sessions` on this branch.
    return { notFound: true };
  }

  // Create new session — detect which AI platform is connecting.
  // Either no session id was sent at all (a legitimate fresh `initialize`),
  // or the client sent `initialize` together with a stale/foreign
  // `mcp-session-id` header. Either way, `initialize` ALWAYS mints the
  // server's own id — a client-supplied id is never adopted here.
  const id = randomUUID();
  const clientIdentity = req ? detectMcpClient(req) : undefined;
  const requestMeta = req ? buildRequestMeta(req) : undefined;

  const server = new McpServer({ name: "rett-fra-bonden", version: "0.4.0" }, { instructions: rfbMcpInstructions(), maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS });
  const sessionRef: { clientIdentity?: string; requestMeta?: import("../services/conversation-service").RequestMeta } = { clientIdentity, requestMeta };
  registerTools(server, () => sessionRef.clientIdentity, () => sessionRef.requestMeta);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
  });

  await server.connect(transport);

  const session: McpSession = { transport, server, lastActivity: Date.now(), clientIdentity, requestMeta };
  sessions.set(id, session);
  return { id, session };
}

// ─── Routes ─────────────────────────────────────────────────

// POST /mcp — Main MCP message handler (JSON-RPC over HTTP)
router.post("/", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const result = await getOrCreateSession(sessionId, isMcpInitializeRequestBody(req.body), req);
    if ("notFound" in result) {
      sendMcpSessionNotFound(res);
      return;
    }
    await result.session.transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("MCP POST error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP transport error" });
    }
  }
});

// GET /mcp — SSE stream for server-to-client notifications
router.get("/", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    // Return a human-friendly landing page for browser GET (Accept: text/html, no session).
    // The MCP POST/session handshake path is unaffected — this branch only fires when
    // there is no valid session header, which a real MCP client would never send as GET.
    const accept = req.headers["accept"] || "";
    if (accept.includes("text/html")) {
      res.status(200).contentType("text/html").send(`<!doctype html>
<html lang="no">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rett fra Bonden MCP — Model Context Protocol</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 24px;color:#1a1a1a;line-height:1.6}
h1{font-size:1.5rem;margin-bottom:.25rem}p{margin:.75rem 0}code{background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:.9em}
pre{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:6px;padding:16px;overflow-x:auto;font-size:.85rem}
a{color:#0070f3}.back{display:inline-block;margin-top:24px;color:#555;text-decoration:none;font-size:.9rem}
.company-line{margin-top:32px;padding-top:12px;border-top:1px solid #e1e4e8;font-size:.8rem;color:#666}.company-line a{color:inherit}</style>
</head>
<body>
<h1>Rett fra Bonden MCP-endepunkt</h1>
<p>Dette er Rett fra Bonden sitt <a href="https://modelcontextprotocol.io" rel="noopener">Model Context Protocol</a>-endepunkt (Streamable HTTP). Det er designet for AI-agenter og MCP-klienter, ikke nettlesere.</p>
<p><strong>Koble til fra Claude Desktop / ChatGPT:</strong><br>Lim inn denne URL-en som MCP-server:</p>
<pre>https://rettfrabonden.com/mcp</pre>
<p><strong>Tilgjengelige verktøy:</strong></p>
<ul>
<li><code>lokal_search</code> — fritekstsøk blant produsenter</li>
<li><code>lokal_discover</code> — finn produsenter etter fylke, kommune, kategori, nær-meg</li>
<li><code>lokal_info</code> — hent én produsent med full profil</li>
<li><code>lokal_stats</code> — plattformstatistikk (antall produsenter, kategorier, fylker)</li>
<li><code>lokal_list_umbrellas</code> / <code>lokal_get_umbrella_members</code> / <code>lokal_get_producer_affiliations</code> — paraplyorganisasjoner</li>
<li><code>lokal_bm_next_markets</code> — neste bondens marked</li>
<li><code>lokal_geocode</code> — stedsnavn → koordinater</li>
<li><code>lokal_find_offers</code> — finn produsenter som selger hver vare på en handleliste, nærmest først</li>
<li><code>lokal_cart_create</code> / <code>lokal_cart_add_item</code> / <code>lokal_cart_view</code> / <code>lokal_cart_submit</code> — handlekurv hos produsent</li>
<li><code>lokal_order_status</code> — status på en avgitt bestilling</li>
</ul>
<p><strong>For utviklere — eksempel (cURL):</strong></p>
<pre>curl -X POST https://rettfrabonden.com/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'</pre>
<p>Se også: <a href="/.well-known/agent-card.json">Agent Card</a> · <a href="/openapi.json">OpenAPI 3.1</a> · <a href="/llms.txt">llms.txt</a></p>
<a class="back" href="/">← Tilbake til Rett fra Bonden</a>
<footer class="company-line">${companyFooterLineHtml("nb", { contactHref: "/kontakt" })}</footer>
</body></html>`);
      return;
    }
    // Non-browser caller with no valid session (never sent one, or sent an
    // unknown/expired one) on a GET: same premise as the POST-side 404 —
    // this must never have created a session, so there is nothing to clean
    // up here either.
    sendMcpSessionNotFound(res);
    return;
  }
  const session = sessions.get(sessionId)!;
  session.lastActivity = Date.now();
  await session.transport.handleRequest(req, res, req.body);
});

// DELETE /mcp — Session cleanup
router.delete("/", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.transport.close?.();
    sessions.delete(sessionId);
  }
  res.status(200).json({ ok: true });
});

export default router;
