// ─── Product catalog sync ───────────────────────────────────────────────
// dev-request 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt,
// Slice 0 ("Forutsetning"): the product-catalog upsert used to be reachable
// only via the admin-triggered POST /admin/products/backfill route
// (src/routes/marketplace-catalog.ts). This module extracts that route's
// exact upsert logic into a standalone, reusable function so the SAME code
// path can run automatically on a daily schedule (src/index.ts,
// CATALOG_SYNC_SCHEDULER_ENABLED) without duplicating it — one
// implementation, two callers (the admin route and the scheduler tick).
//
// Byte-identical behaviour to the original handler: same source query (every
// agent_knowledge.products row with a non-empty array), same per-product
// cleaning (isProductHeader/isProductNoise/parseProductPrice), same in-batch
// name_norm dedupe, same UNIQUE(agent_id, name_norm) upsert.
//
// ─── Availability-preservation guarantee (critical safety constraint) ─────
// The ON CONFLICT ... DO UPDATE SET clause below updates ONLY price_nok,
// category, updated_at and (skive 2, below) the provenance columns source,
// source_url, fetched_at and owner_confirmed_at — it does not mention `availability`,
// `availability_source`, or `availability_updated_at` at all. That is the
// exact same clause the original admin route always used, so this sync
// (automatic or manual) has NEVER been able to touch a product row's
// availability, regardless of that row's availability_source. This is what
// keeps a producer_dashboard-sourced row's availability (set via the
// owner-portal write path in supply-graph.ts's setProducerAvailability*
// functions) safe from being clobbered by an enrichment-driven catalog sync.
// See src/services/product-catalog-sync.test.ts for the regression test that
// proves this.
//
// Skive 4 (dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel):
// price_nok and category of a row whose availability_source is
// 'admin_producer_confirmed' are likewise left alone, so a producer-confirmed
// price entered by the admin is never overwritten by scraped enrichment data.
//
// Produktimport skive 2 (dev-request 2026-10-21-rfb-produktimport-fra-egen-
// nettside): `source` is the product's own ProductInfo.source (owner_manual,
// owner_import, owner_auto_sync; else 'enrichment') instead of always
// 'enrichment', with source_url / fetched_at / owner_confirmed_at beside it.
// A row another writer created ('owner' via the B1 portal, 'admin' via the
// producer list) or an admin_producer_confirmed row keeps its provenance.
// updated_at now moves only when price_nok or category actually changes, so
// it dates the last real change instead of the last sync. (The sync writes no
// unit, so a unit cannot change here.) None of this touches availability or
// availability_source — the orderability gate's only source input — so an
// owner_import product is no more orderable than before.
//
// B1b-2 (dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel):
// the skive-4 protection is widened to every row the owner controls, but only
// against SCRAPED input: a row with availability_source 'producer_dashboard'
// (owner confirmed stock in the portal) or source 'owner' (added via B1 «Legg
// til vare») keeps its price_nok and category (and provenance) when the
// incoming product is scraped (source not owner_manual/owner_import/
// owner_auto_sync). An owner-supplied incoming price updates price, category and
// provenance together as before. admin_producer_confirmed rows are protected
// against any incoming source. One predicate (keepOwnerPrice) drives price,
// category, provenance and updated_at. Availability stays untouched.

import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { parseProductPrice, productPriceText, isProductHeader, isProductNoise, PRODUCT_SOURCES, OWNER_PRODUCT_SOURCES, type ProductSource } from "./knowledge-service";

// ─── Price string → numeric NOK ──────────────────────────────────────────
// Parses "kr 275/kg", "kr 275", "275" → 275.0; null if unparseable.
//
// Integration test 2026-10-17, slice I-V: this used to run every digit of the
// text together, so the range «kr 70 – kr 650» became 70650 and «kr 48.00 –
// kr 220.00» 48.0022 (live in /catalog/feed, the offers and
// lokal_find_offers). The numbers are now read one by one:
// - a range, two prices joined by «-», «–», «—» or «til» with only «kr», «,-»,
//   «/» or the end after the second («kr 60 - 6 stk» is no range), gives its
//   lowest price. price_nok is one number, so this is the "from" price, as a
//   «fra kr 70» already gives;
// - otherwise the number after «kr» (or «kroner», «NOK»), else the one
//   before it, else the first number: «kr 60/6 stk» is 60, not 606. A number
//   after «kr» that a quantity follows («300 kr 2-3 kg») is that quantity, so
//   the number before «kr» is the price.
// A number may group thousands with a space («kr 1 200»), unless a unit
// follows («kr 120 500 g» is 120), or with a dot and three digits after a
// non-zero start («kr 1.250», «kr 1.200,-»; 1.25 and 1.2 before), and have
// decimals after a comma or a dot, as before, so a plain price gives what it
// gave. Only the first PRICE_TEXT_MAX characters are read: the patterns
// backtrack on a long run of digits and spaces, inside the sync transaction.
// The upsert below overwrites a stored price whenever this gives a number,
// so the next sync replaces 70650 with 70 (no manual clean-up).
const PRICE_TEXT_MAX = 200;
const PRICE_UNIT = String.raw`\s*(?:kg|kilo|hg|g|gr|gram|l|ltr|liter|dl|cl|ml|stk|pk)(?![a-zæøå])`;
const PRICE_QTY = String.raw`(?:\s*[-–—]\s*\d+(?:[.,]\d+)?)?${PRICE_UNIT}`;
const PRICE_NUM = String.raw`([1-9]\d{0,2}(?:\.\d{3})+(?!\d)(?:,\d+)?` +
  String.raw`|\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?(?!${PRICE_UNIT})|\d+(?:[.,]\d+)?)`;
const PRICE_KR = String.raw`(?<![a-zæøå])(?:kroner|kr\.?|nok)(?![a-zæøå])`;
const PRICE_ZERO_ORE = "(?:,[-–—])";
const PRICE_RANGE = new RegExp(
  `${PRICE_NUM}\\s*(?:${PRICE_KR}|${PRICE_ZERO_ORE})?\\s*(?:[-–—]|til)\\s*(?:${PRICE_KR})?\\s*${PRICE_NUM}` +
  `(?=\\s*(?:${PRICE_KR}|${PRICE_ZERO_ORE}|\\/|$))`, "i");
const PRICE_AFTER_KR = new RegExp(`${PRICE_KR}\\s*${PRICE_NUM}(?!\\d|[.,]\\d|${PRICE_QTY})`, "i");
const PRICE_BEFORE_KR = new RegExp(`${PRICE_NUM}\\s*(?:${PRICE_KR}|${PRICE_ZERO_ORE})`, "i");
const PRICE_FIRST = new RegExp(PRICE_NUM, "i");

function priceNumber(num: string): number {
  const n = num.replace(/\s/g, "");
  return parseFloat((/^[1-9]\d{0,2}(?:\.\d{3})+(?:,\d+)?$/.test(n) ? n.replace(/\./g, "") : n).replace(",", "."));
}

export function parsePriceNok(priceStr: string | null | undefined): number | null {
  if (!priceStr) return null;
  const text = priceStr.slice(0, PRICE_TEXT_MAX);
  const range = text.match(PRICE_RANGE);
  const single = range ? null : text.match(PRICE_AFTER_KR) || text.match(PRICE_BEFORE_KR) || text.match(PRICE_FIRST);
  const val = range ? Math.min(priceNumber(range[1]), priceNumber(range[2])) : single ? priceNumber(single[1]) : NaN;
  return isFinite(val) && val > 0 ? val : null;
}

// ─── Name normalization for dedupe ───────────────────────────────────────
// Exported for the admin producer-list endpoint (skive 4), which must produce
// the same name_norm as this sync so both address the same UNIQUE row.
export function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

// ─── Provenance columns from one ProductInfo (skive 2) ──────────────────
// The entry is DB JSON (see I-G below): only a known source and text values
// count. owner_confirmed_at is kept only with an owner source.
function productProvenance(p: any): { source: ProductSource; source_url: string | null; fetched_at: string | null; owner_confirmed_at: string | null } {
  const source: ProductSource = PRODUCT_SOURCES.includes(p?.source) ? p.source : "enrichment";
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    source,
    source_url: text(p?.sourceUrl),
    fetched_at: text(p?.fetchedAt),
    owner_confirmed_at: OWNER_PRODUCT_SOURCES.includes(source) ? text(p?.confirmedAt) : null,
  };
}

export type ProductCatalogSyncResult =
  | { success: true; agents_processed: number; inserted: number; updated: number; skipped: number }
  | { success: false; error: string };

/**
 * Upserts every agent_knowledge.products row into `products`. Idempotent:
 * inserts new rows, updates price/category/provenance on conflict (updated_at
 * only when price or category changed) — NEVER
 * touches `availability` (see module doc comment above). Never throws;
 * failures come back as `{success:false, error}` so callers (an HTTP route,
 * or the unattended scheduler tick in src/index.ts) can each decide how to
 * report it without a try/catch of their own.
 */
export function runProductCatalogSync(db?: any, opts: { agentId?: string } = {}): ProductCatalogSyncResult {
  const conn = db ?? getDb();

  // Produktimport skive 3: `agentId` syncs that one profile only (the owner
  // import publish), with the same per-row logic as the full sync.
  const onlyAgent = typeof opts.agentId === "string" && opts.agentId ? opts.agentId : null;
  const rows = conn.prepare(`
    SELECT k.agent_id, k.products
    FROM agent_knowledge k
    INNER JOIN agents a ON a.id = k.agent_id
    WHERE k.products IS NOT NULL AND k.products != '[]' AND k.products != ''
    ${onlyAgent ? "AND k.agent_id = ?" : ""}
  `).all(...(onlyAgent ? [onlyAgent] : [])) as Array<{ agent_id: string; products: string }>;

  // Every SET expression reads the row as it was, so updated_at compares the
  // new price/category (same expressions) with the stored ones.
  // B1b-2: a SCRAPED product (incoming source not an owner source) never takes
  // price_nok or category from a row the owner controls. 'producer_dashboard' =
  // the owner confirmed stock in the owner portal; source 'owner' = the owner
  // added the product via B1 «Legg til vare». 'admin_producer_confirmed' is
  // protected regardless of where the incoming price comes from. A price the
  // owner supplied themselves (owner_manual / owner_import / owner_auto_sync) is
  // the owner's only route to change price_nok, so it updates as before.
  const ownerSourceList = OWNER_PRODUCT_SOURCES.map((s) => `'${s}'`).join(", ");
  const scrapedIncoming = `(excluded.source IS NULL OR excluded.source NOT IN (${ownerSourceList}))`;
  const keepOwnerPrice = `(products.availability_source = 'admin_producer_confirmed'
                        OR (${scrapedIncoming}
                            AND (products.availability_source = 'producer_dashboard' OR products.source = 'owner')))`;
  const newPrice = `CASE WHEN ${keepOwnerPrice} THEN products.price_nok
                        WHEN excluded.price_nok IS NOT NULL THEN excluded.price_nok ELSE products.price_nok END`;
  const newCategory = `CASE WHEN ${keepOwnerPrice} THEN products.category
                        WHEN excluded.category  IS NOT NULL THEN excluded.category  ELSE products.category  END`;
  // Provenance follows the price: it is kept whenever the price was kept (so a
  // blocked scrape never stamps 'enrichment' / a scrape URL on an owner's price),
  // and, as before, for admin_producer_confirmed rows and rows another writer
  // created ('owner', 'admin' - not in PRODUCT_SOURCES). An owner-sourced update
  // of a producer_dashboard row stamps provenance together with its price
  // (test produktimport-s2).
  const keepProvenance = `${keepOwnerPrice}
                        OR products.source NOT IN (${PRODUCT_SOURCES.map((s) => `'${s}'`).join(", ")})`;
  const provenance = (col: string) =>
    `${col} = CASE WHEN ${keepProvenance} THEN products.${col} ELSE excluded.${col} END`;
  const insert = conn.prepare(`
    INSERT INTO products
      (id, agent_id, name, name_norm, category, price_nok, currency,
       availability, source, source_url, fetched_at, owner_confirmed_at, created_at, updated_at)
    VALUES
      (@id, @agent_id, @name, @name_norm, @category, @price_nok, 'NOK',
       'in_stock', @source, @source_url, @fetched_at, @owner_confirmed_at, datetime('now'), datetime('now'))
    ON CONFLICT(agent_id, name_norm) DO UPDATE SET
      price_nok  = ${newPrice},
      category   = ${newCategory},
      ${provenance("source")},
      ${provenance("source_url")},
      ${provenance("fetched_at")},
      ${provenance("owner_confirmed_at")},
      updated_at = CASE WHEN (${newPrice}) IS NOT products.price_nok OR (${newCategory}) IS NOT products.category
                        THEN datetime('now') ELSE products.updated_at END
  `);

  let agents_processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const tx = conn.transaction(() => {
    for (const row of rows) {
      let products: any[];
      try {
        products = JSON.parse(row.products);
        if (!Array.isArray(products)) continue;
      } catch {
        continue;
      }

      agents_processed++;
      const seen = new Set<string>(); // dedupe within this agent in this run

      for (const p of products) {
        // Integration test 2026-10-17 (I-G): each entry is DB JSON. A null
        // entry or a name that is not text threw on `.trim`, a negative,
        // boolean or object price on `.replace` (parsePriceNok), and an
        // object or boolean category failed the SQLite bind — any of them
        // rolled back the whole sync for every agent. Such an entry is
        // skipped, or its price or category left empty; text gives the same
        // rows as before.
        const rawName = p && typeof p.name === "string" ? p.name.trim() : "";
        if (!rawName) { skipped++; continue; }
        if (isProductHeader(rawName)) { skipped++; continue; }
        if (isProductNoise(rawName)) { skipped++; continue; }

        const { cleanName, price: priceStr } = parseProductPrice(p);
        if (!cleanName) { skipped++; continue; }

        const name_norm = normalizeName(cleanName);
        if (!name_norm) { skipped++; continue; }
        if (seen.has(name_norm)) { skipped++; continue; } // in-batch dedupe
        seen.add(name_norm);

        const price_nok = parsePriceNok(priceStr) ?? parsePriceNok(productPriceText(p.price));
        const category = typeof p.category === "string" && p.category && p.category !== "other" ? p.category : null;

        const existed = conn.prepare(
          "SELECT 1 FROM products WHERE agent_id = ? AND name_norm = ?"
        ).get(row.agent_id, name_norm);

        insert.run({
          id: randomUUID(),
          agent_id: row.agent_id,
          name: cleanName,
          name_norm,
          category,
          price_nok,
          ...productProvenance(p),
        });

        if (existed) updated++;
        else inserted++;
      }
    }
  });

  try {
    tx();
    return { success: true, agents_processed, inserted, updated, skipped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
