/**
 * Integration test 2026-10-17, slices I-N and I-S: a generic category label
 * is no product and no offer. The enrichment's category inference writes the
 * platform's category names as product names («Honning», «Kjøtt», «Egg»),
 * and product-catalog-sync.ts copies them into `products` as in_stock rows,
 * so a bakery could be offered for «honning». One rule for every surface:
 * lokal_info, lokal_search and lokal_discover (routes/mcp.ts), and findOffers
 * (services/catalog-offers.ts: lokal_find_offers, GET
 * /api/marketplace/catalog/offers and the shopping list page).
 *
 * The rule:
 * - the name is a platform category name (I-A's rule, per name);
 * - there is no price, as category inference never writes one; a category
 *   name with a price («Egg» at «60 kr/brett») is something the producer
 *   listed;
 * - the catalog row was not set by the producer (availability_source
 *   'producer_dashboard', review F2 on lokal#1126): a row the owner set is
 *   always a product.
 */

/**
 * True when every name is a platform category name (case and spacing
 * ignored); false for an empty list. This is productsAreGenericCategoryNames
 * (routes/admin-outreach-candidates.ts), loaded lazily as admin-knowledge.ts
 * does. The names come from CATEGORY_MAP in routes/seo.ts and
 * CATEGORY_LABEL_NO in routes/admin-knowledge.ts, so a top-level import would
 * make every importer of this module (the tool manifest, the MCP tests, the
 * offers service) load those route modules as well.
 */
export function areGenericCategoryNames(names: readonly string[]): boolean {
  return (require("../routes/admin-outreach-candidates") as typeof import("../routes/admin-outreach-candidates"))
    .productsAreGenericCategoryNames(JSON.stringify(names));
}

/** True when a product name is only a platform category name («Honning», «egg », «Bakervarer»). */
export function isGenericCategoryName(name: string): boolean {
  return areGenericCategoryNames([name]);
}

/** One product entry or catalog row, as the label rule reads it. */
export interface CategoryLabelCandidate {
  name: string;
  /** A price the producer wrote: a numeric price in the listing text, or products.price_nok. */
  hasPrice: boolean;
  /** products.availability_source of the catalog row, when there is one. */
  availabilitySource?: string | null;
}

/** True when the entry is only a generic category label (see the module comment). */
export function isCategoryLabel(entry: CategoryLabelCandidate): boolean {
  return !entry.hasPrice && entry.availabilitySource !== "producer_dashboard" && isGenericCategoryName(entry.name);
}
