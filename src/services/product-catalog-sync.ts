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
// category, and updated_at — it does not mention `availability`,
// `availability_source`, or `availability_updated_at` at all. That is the
// exact same clause the original admin route always used, so this sync
// (automatic or manual) has NEVER been able to touch a product row's
// availability, regardless of that row's availability_source. This is what
// keeps a producer_dashboard-sourced row's availability (set via the
// owner-portal write path in supply-graph.ts's setProducerAvailability*
// functions) safe from being clobbered by an enrichment-driven catalog sync.
// See src/services/product-catalog-sync.test.ts for the regression test that
// proves this.

import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { parseProductPrice, isProductHeader, isProductNoise } from "./knowledge-service";

// ─── Price string → numeric NOK ──────────────────────────────────────────
// Parses "kr 275/kg", "kr 275", "275" → 275.0; null if unparseable.
function parsePriceNok(priceStr: string | null | undefined): number | null {
  if (!priceStr) return null;
  const digits = priceStr.replace(/kr\.?\s*/gi, "").replace(/[^0-9,.]/g, "").replace(/,/g, ".").trim();
  const val = parseFloat(digits);
  return isFinite(val) && val > 0 ? val : null;
}

// ─── Name normalization for dedupe ───────────────────────────────────────
function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

export type ProductCatalogSyncResult =
  | { success: true; agents_processed: number; inserted: number; updated: number; skipped: number }
  | { success: false; error: string };

/**
 * Upserts every agent_knowledge.products row into `products`. Idempotent:
 * inserts new rows, updates price/category/updated_at on conflict — NEVER
 * touches `availability` (see module doc comment above). Never throws;
 * failures come back as `{success:false, error}` so callers (an HTTP route,
 * or the unattended scheduler tick in src/index.ts) can each decide how to
 * report it without a try/catch of their own.
 */
export function runProductCatalogSync(db?: any): ProductCatalogSyncResult {
  const conn = db ?? getDb();

  const rows = conn.prepare(`
    SELECT k.agent_id, k.products
    FROM agent_knowledge k
    INNER JOIN agents a ON a.id = k.agent_id
    WHERE k.products IS NOT NULL AND k.products != '[]' AND k.products != ''
  `).all() as Array<{ agent_id: string; products: string }>;

  const insert = conn.prepare(`
    INSERT INTO products
      (id, agent_id, name, name_norm, category, price_nok, currency,
       availability, source, created_at, updated_at)
    VALUES
      (@id, @agent_id, @name, @name_norm, @category, @price_nok, 'NOK',
       'in_stock', 'enrichment', datetime('now'), datetime('now'))
    ON CONFLICT(agent_id, name_norm) DO UPDATE SET
      price_nok  = CASE WHEN excluded.price_nok IS NOT NULL THEN excluded.price_nok ELSE products.price_nok END,
      category   = CASE WHEN excluded.category  IS NOT NULL THEN excluded.category  ELSE products.category  END,
      updated_at = datetime('now')
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
        const rawName = (p.name || "").trim();
        if (!rawName) { skipped++; continue; }
        if (isProductHeader(rawName)) { skipped++; continue; }
        if (isProductNoise(rawName)) { skipped++; continue; }

        const { cleanName, price: priceStr } = parseProductPrice(p);
        if (!cleanName) { skipped++; continue; }

        const name_norm = normalizeName(cleanName);
        if (!name_norm) { skipped++; continue; }
        if (seen.has(name_norm)) { skipped++; continue; } // in-batch dedupe
        seen.add(name_norm);

        const price_nok = parsePriceNok(priceStr) ?? parsePriceNok(p.price);
        const category = p.category && p.category !== "other" ? p.category : null;

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
