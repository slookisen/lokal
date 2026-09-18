// ─── Marketplace Catalog Routes (Phase 0) ──────────────────────────────────
//
// Phase 0: product catalog + ACP-shaped discovery feed. No cart, no payment.
//
// Endpoints:
//   POST  /admin/products/backfill          — admin-only; upsert from agent_knowledge
//   GET   /api/marketplace/catalog/feed     — public ACP feed (verified producers)
//   GET   /api/marketplace/catalog/acp-feed.csv — public ACP non-Ads CSV product feed
//   GET   /api/marketplace/catalog/agents/:id/products — public per-agent product list
//   GET   /api/marketplace/catalog/offers   — public per-item multi-producer offer lookup
//
// Route-path collision analysis (checked against src/routes/marketplace.ts):
//   - `/feed` — DOES NOT EXIST in marketplace.ts; safe to use as `/catalog/feed`
//   - `/agents/:id/products` — DOES NOT EXIST in marketplace.ts, but `/agents/:id/*`
//     is a dense pattern (vcard, card, heartbeat, info, knowledge, claim, unclaim…).
//     To avoid any Express ordering ambiguity when mounted under /api/marketplace,
//     we use the prefix `/catalog/` for all new public endpoints:
//       GET /api/marketplace/catalog/feed
//       GET /api/marketplace/catalog/agents/:id/products
//       GET /api/marketplace/catalog/offers
//   - The admin backfill is mounted separately under /admin/products (no collision).
//
// dev-request 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt,
// Slice 0: GET /offers is a NEW public read endpoint (no admin-key gate — same
// public posture as /feed and the underlying lokal_search REST route). Its
// filtering/geo/can_order logic lives in ../services/catalog-offers.ts, shared
// with the lokal_find_offers MCP tool (src/routes/mcp.ts).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { slugify } from "../utils/slug";
import { computeEffectiveAvailability } from "../services/supply-graph";
import { runProductCatalogSync } from "../services/product-catalog-sync";
import { findOffers, resolveOffersRadiusKm, resolveOffersLimit } from "../services/catalog-offers";
import { isValidLatLng } from "../utils/geo-query";

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

// ────────────────────────────────────────────────────────────────────────────
// POST /admin/products/backfill
// Admin-gated. Upserts every agent_knowledge.products row into `products`.
// Idempotent: insert new rows, update price/category/updated_at on conflict.
//
// dev-request 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt,
// Slice 0: the actual upsert logic now lives in
// src/services/product-catalog-sync.ts (runProductCatalogSync) so the daily
// automatic sync (src/index.ts, CATALOG_SYNC_SCHEDULER_ENABLED) can call the
// exact same code path instead of a re-implementation. This handler's
// request/response contract is unchanged.
// ────────────────────────────────────────────────────────────────────────────
adminCatalogRouter.post("/backfill", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const result = runProductCatalogSync();
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({ success: false, error: result.error });
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
      AND (k.verified_second_line IS NULL OR k.verified_second_line = 0)
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
      AND (k.verified_second_line IS NULL OR k.verified_second_line = 0)
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

// ─── RFC4180 CSV field escaping ───────────────────────────────────────────────
// Wrap in double-quotes if the field contains a comma, a double-quote, or a
// newline (\n / \r); any double-quote inside such a field is doubled ("→"").
function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/marketplace/catalog/acp-feed.csv
// Public — no auth. OpenAI Agentic Commerce Protocol (ACP) non-Ads product
// feed, CSV format, so RFB producers' products can be discovered in ChatGPT
// shopping surfaces. Discovery-only — no checkout/payment (is_eligible_checkout
// is always "false").
//
// Reuses the EXACT same filter/source as GET /feed above (same JOINs, same
// WHERE clause) — this is a pure output-format addition, not a new query.
// dev-request 2026-08-24-acp-produktfeed-rfb.
// ────────────────────────────────────────────────────────────────────────────
catalogRouter.get("/acp-feed.csv", (_req: Request, res: Response) => {
  const db = getDb();

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
      p.category,
      p.image_url,
      a.name AS agent_name
    FROM products p
    INNER JOIN agents a ON a.id = p.agent_id
    INNER JOIN agent_knowledge k ON k.agent_id = p.agent_id
    WHERE p.availability = 'in_stock'
      AND a.umbrella_type IS NULL
      AND k.verification_status = 'verified'
      AND (k.verified_second_line IS NULL OR k.verified_second_line = 0)
    ORDER BY p.updated_at DESC, p.id
  `).all() as Array<{
    id: string;
    name: string;
    description: string | null;
    price_nok: number | null;
    currency: string;
    availability: string;
    availability_updated_at: string | null;
    availability_source: string;
    category: string | null;
    image_url: string | null;
    agent_name: string;
  }>;

  const header = [
    "item_id", "title", "description", "brand", "url", "image_url",
    "price", "availability", "is_eligible_search", "is_eligible_checkout",
    "target_countries", "product_category",
  ];

  const now = new Date();
  let skippedMissingRequired = 0;
  const lines: string[] = [header.join(",")];

  for (const r of rows) {
    // Required-field skip guard: image_url and price_nok are nullable
    // columns. A row missing either is excluded entirely (telemetry-only,
    // not an error).
    if (!r.image_url || r.price_nok == null) {
      skippedMissingRequired++;
      continue;
    }

    const title = r.name.slice(0, 150);
    const description = (r.description ?? "").slice(0, 5000);
    const brand = r.agent_name.slice(0, 70);
    const url = `${BASE_URL}/produsent/${slugify(r.agent_name)}`;
    const price = `${r.price_nok.toFixed(2)} ${r.currency}`;
    const availability = computeEffectiveAvailability(r.availability, r.availability_updated_at, r.availability_source, now);
    const productCategory = r.category ?? "";

    const fields = [
      r.id,
      title,
      description,
      brand,
      url,
      r.image_url,
      price,
      availability,
      "true",
      "false",
      "NO",
      productCategory,
    ];

    lines.push(fields.map(f => escapeCsvField(String(f))).join(","));
  }

  res.header("Content-Type", "text/csv; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.header("X-Acp-Feed-Skipped-Count", String(skippedMissingRequired));
  res.send(lines.join("\r\n") + "\r\n");
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
       AND (k.verified_second_line IS NULL OR k.verified_second_line = 0)
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

// ────────────────────────────────────────────────────────────────────────────
// GET /api/marketplace/catalog/offers
// Public — no auth (same posture as /feed above). Multi-producer offer lookup
// for one search term ("handleliste" item), sorted by distance, capped at
// `limit` (default/max 5).
//
// Query params:
//   q          — required. Product/item search term.
//   near       — free-text Norwegian place name (geocoded the same way
//                lokal_geocode / lokal_search resolve a place name).
//   lat, lng   — explicit coordinates; take priority over `near` when both
//                are given valid (same priority as lokal_search fix 0g(i)).
//   radius_km  — default 50.
//   limit      — default 5, capped at 5 ("vis flere" is a later slice).
//
// `near` or `lat`+`lng` is required — this is a proximity lookup, there is no
// nationwide fallback. Response shape: { term, offers: [...] } — see
// ../services/catalog-offers.ts for the full field-by-field contract.
// ────────────────────────────────────────────────────────────────────────────
catalogRouter.get("/offers", async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.status(400).json({ success: false, error: "Mangler ?q= parameter" });
    return;
  }

  const lat = parseFloat(String(req.query.lat ?? ""));
  const lng = parseFloat(String(req.query.lng ?? ""));
  const hasCoords = isValidLatLng(lat, lng);
  const near = typeof req.query.near === "string" ? req.query.near.trim() : "";

  if (!hasCoords && !near) {
    res.status(400).json({
      success: false,
      error: "Oppgi enten ?near= (stedsnavn) eller ?lat=&lng= (koordinater)",
    });
    return;
  }

  try {
    const result = await findOffers({
      q,
      near: near || undefined,
      lat: hasCoords ? lat : undefined,
      lng: hasCoords ? lng : undefined,
      radiusKm: resolveOffersRadiusKm(req.query.radius_km),
      limit: resolveOffersLimit(req.query.limit),
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});
