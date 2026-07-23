// ─── Marketplace Catalog Routes (Phase 0) ──────────────────────────────────
//
// Phase 0: product catalog + ACP-shaped discovery feed. No cart, no payment.
//
// Endpoints:
//   POST  /admin/products/backfill          — admin-only; upsert from agent_knowledge
//   GET   /api/marketplace/catalog/feed     — public ACP feed (verified producers)
//   GET   /api/marketplace/catalog/agents/:id/products — public per-agent product list
//
// Route-path collision analysis (checked against src/routes/marketplace.ts):
//   - `/feed` — DOES NOT EXIST in marketplace.ts; safe to use as `/catalog/feed`
//   - `/agents/:id/products` — DOES NOT EXIST in marketplace.ts, but `/agents/:id/*`
//     is a dense pattern (vcard, card, heartbeat, info, knowledge, claim, unclaim…).
//     To avoid any Express ordering ambiguity when mounted under /api/marketplace,
//     we use the prefix `/catalog/` for all new public endpoints:
//       GET /api/marketplace/catalog/feed
//       GET /api/marketplace/catalog/agents/:id/products
//   - The admin backfill is mounted separately under /admin/products (no collision).

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { parseProductPrice, isProductHeader, isProductNoise } from "../services/knowledge-service";
import { slugify } from "../utils/slug";
import { computeEffectiveAvailability } from "../services/supply-graph";

// ─── Public catalog router (mounted at /api/marketplace/catalog) ────────────
export const catalogRouter = Router();

// ─── Admin catalog router (mounted at /admin/products) ──────────────────────
export const adminCatalogRouter = Router();

const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";

// ─── Admin key helper ─────────────────────────────────────────────────────────
function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

// ─── Price string → numeric NOK ──────────────────────────────────────────────
// Parses "kr 275/kg", "kr 275", "275" → 275.0; null if unparseable.
function parsePriceNok(priceStr: string | null | undefined): number | null {
  if (!priceStr) return null;
  // Strip "kr", "kr.", currency symbols, and unit suffixes like "/kg"
  const digits = priceStr.replace(/kr\.?\s*/gi, "").replace(/[^0-9,.]/g, "").replace(/,/g, ".").trim();
  const val = parseFloat(digits);
  return isFinite(val) && val > 0 ? val : null;
}

// ─── Name normalization for dedupe ───────────────────────────────────────────
function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

// ────────────────────────────────────────────────────────────────────────────
// POST /admin/products/backfill
// Admin-gated. Upserts every agent_knowledge.products row into `products`.
// Idempotent: insert new rows, update price/category/updated_at on conflict.
// ────────────────────────────────────────────────────────────────────────────
adminCatalogRouter.post("/backfill", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const db = getDb();

  // Fetch all agent_knowledge rows that have a non-empty products array.
  // We also join agents so we can confirm the agent exists (FK safety).
  const rows = db.prepare(`
    SELECT k.agent_id, k.products
    FROM agent_knowledge k
    INNER JOIN agents a ON a.id = k.agent_id
    WHERE k.products IS NOT NULL AND k.products != '[]' AND k.products != ''
  `).all() as Array<{ agent_id: string; products: string }>;

  // Prepared statements for upsert
  const insert = db.prepare(`
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

  // Wrap everything in a single transaction for speed
  let agents_processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
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

        // Count insert vs update by checking pre-existence
        const existed = db.prepare(
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
    res.json({ success: true, agents_processed, inserted, updated, skipped });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/marketplace/catalog/feed
// Public — no auth. ACP-shaped product feed.
// Filters: verified non-umbrella producers, availability='in_stock'.
// Query params: limit (default 100, max 500), offset, city (optional).
// ────────────────────────────────────────────────────────────────────────────
catalogRouter.get("/feed", (req: Request, res: Response) => {
  const db = getDb();

  const rawLimit = parseInt(String(req.query.limit ?? "100"), 10);
  const limit = Math.min(isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 500);
  const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
  const city = typeof req.query.city === "string" ? req.query.city.trim() : null;

  const params: any[] = [];
  let cityFilter = "";
  if (city) {
    cityFilter = "AND LOWER(a.city) = LOWER(?)";
    params.push(city);
  }

  // Count total matching rows
  const countRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM products p
    INNER JOIN agents a ON a.id = p.agent_id
    INNER JOIN agent_knowledge k ON k.agent_id = p.agent_id
    WHERE p.availability = 'in_stock'
      AND a.umbrella_type IS NULL
      AND k.verification_status = 'verified'
      ${cityFilter}
  `).get(...params) as { total: number };

  const total = countRow?.total ?? 0;

  // Fetch items
  const rows = db.prepare(`
    SELECT
      p.id,
      p.name,
      p.description,
      p.price_nok,
      p.currency,
      p.availability,
      p.availability_updated_at,
      p.availability_source,
      p.unit,
      p.category,
      p.image_url,
      a.id   AS agent_id,
      a.name AS agent_name,
      a.city AS agent_city
    FROM products p
    INNER JOIN agents a ON a.id = p.agent_id
    INNER JOIN agent_knowledge k ON k.agent_id = p.agent_id
    WHERE p.availability = 'in_stock'
      AND a.umbrella_type IS NULL
      AND k.verification_status = 'verified'
      ${cityFilter}
    ORDER BY p.updated_at DESC, p.id
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<{
    id: string;
    name: string;
    description: string | null;
    price_nok: number | null;
    currency: string;
    availability: string;
    availability_updated_at: string | null;
    availability_source: string;
    unit: string | null;
    category: string | null;
    image_url: string | null;
    agent_id: string;
    agent_name: string;
    agent_city: string | null;
  }>;

  // dev-request 2026-07-13-supply-graph-v1 (Slice 1): the WHERE filter above
  // still runs against the RAW p.availability column ('in_stock') — filtering
  // behaviour is unchanged. Only the EXPOSED `availability` field below is
  // replaced with the effective (post supply-graph staleness check) value;
  // `availability_updated_at` is additive — new field, raw timestamp or null.
  const now = new Date();
  const items = rows.map(r => ({
    id: r.id,
    title: r.name,
    description: r.description ?? null,
    price: {
      amount: r.price_nok ?? null,
      currency: r.currency,
    },
    availability: computeEffectiveAvailability(r.availability, r.availability_updated_at, r.availability_source, now),
    availability_updated_at: r.availability_updated_at ?? null,
    unit: r.unit ?? null,
    category: r.category ?? null,
    seller: {
      agent_id: r.agent_id,
      name: r.agent_name,
      city: r.agent_city ?? null,
      profile_url: `${BASE_URL}/produsent/${slugify(r.agent_name)}`,
    },
    image_url: r.image_url ?? null,
  }));

  res.json({ success: true, count: items.length, total, items });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/marketplace/catalog/agents/:id/products
// Public. Returns all products for a given agent from the products table.
// ────────────────────────────────────────────────────────────────────────────
catalogRouter.get("/agents/:id/products", (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  // Verify agent exists AND is discoverable (verified + non-umbrella) — mirrors
  // the feed filter so the public catalog never exposes unverified/umbrella
  // producers' products (orch-pr-20260614-5 review SHOULD-FIX). 404 otherwise.
  const agent = db.prepare(`
    SELECT a.id
      FROM agents a
INNER JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE a.id = ?
       AND a.umbrella_type IS NULL
       AND k.verification_status = 'verified'
  `).get(id) as { id: string } | undefined;
  if (!agent) {
    res.status(404).json({ success: false, error: "Agent not found or not discoverable" });
    return;
  }

  // Note: `source` (internal provenance) is intentionally NOT projected on this
  // public endpoint.
  const rows = db.prepare(`
    SELECT
      id, name, description, unit, price_nok, currency,
      availability, availability_updated_at, availability_source,
      stock_qty, category, image_url,
      created_at, updated_at
    FROM products
    WHERE agent_id = ?
    ORDER BY name_norm
  `).all(id) as Array<{
    id: string;
    name: string;
    description: string | null;
    unit: string | null;
    price_nok: number | null;
    currency: string;
    availability: string;
    availability_updated_at: string | null;
    availability_source: string;
    stock_qty: number | null;
    category: string | null;
    image_url: string | null;
    created_at: string;
    updated_at: string;
  }>;

  // dev-request 2026-07-13-supply-graph-v1 (Slice 1): additive fields only —
  // `availability` becomes the effective (post supply-graph staleness check)
  // value, `availability_updated_at` is new (raw timestamp or null).
  // `availability_source` (internal provenance) stays un-projected here, same
  // as `source` above.
  const now = new Date();
  const products = rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    unit: r.unit,
    price_nok: r.price_nok,
    currency: r.currency,
    availability: computeEffectiveAvailability(r.availability, r.availability_updated_at, r.availability_source, now),
    availability_updated_at: r.availability_updated_at ?? null,
    stock_qty: r.stock_qty,
    category: r.category,
    image_url: r.image_url,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  res.json({
    success: true,
    agent_id: id,
    count: products.length,
    products,
  });
});
