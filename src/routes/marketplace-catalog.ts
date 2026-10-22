// ─── Marketplace Catalog Routes (Phase 0) ──────────────────────────────────
//
// Phase 0: product catalog + ACP-shaped discovery feed. No cart, no payment.
//
// Endpoints:
//   POST  /admin/products/backfill          — admin-only; upsert from agent_knowledge
//   POST  /admin/products/producer-list     — admin-only; a producer's confirmed product list (skive 4)
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
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { slugify } from "../utils/slug";
import { computeEffectiveAvailability } from "../services/supply-graph";
import { runProductCatalogSync, normalizeName } from "../services/product-catalog-sync";
import { findOffers, resolveOffersRadiusKm, resolveOffersLimit } from "../services/catalog-offers";
import { isValidLatLng } from "../utils/geo-query";
import { capFreeText, capName } from "../utils/free-text";
// dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt: the ONE shared
// public-listability predicate (catalog_hidden fixture + RFB vertical) for the
// public LIST surfaces below (/feed, /acp-feed.csv). The direct-id order-flow
// path /agents/:id/products deliberately does NOT use it.
import { publiclyVisibleSql } from "../services/agent-visibility";

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
// POST /admin/products/producer-list
// dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel, skive 4.
// Admin-gated (401 without a valid X-Admin-Key, 503 when no admin key is
// configured). Enters a producer's CONFIRMED product list: name, price and,
// for pre-packaged food, ingredients, allergens and net weight. Rows are
// written with availability_source = 'admin_producer_confirmed', which is what
// lets a producer who passes isEligibleForRealOrder() actually sell them
// (scraped rows stay contact rows; see cart-service.ts). The catalog sync does
// not overwrite price/category of such rows.
//
// Body: { agent_id, products: [{ name, price_nok, unit?, description?,
//   category?, availability? ('in_stock' default | 'out_of_stock'),
//   packaged?: boolean, ingredients?, allergens?: string[], net_weight? }] }
// allergens (an array; [] = the producer states none) is required for every
// product (skive 4b). packaged:true also requires ingredients and net_weight
// ('250 g', '1,5 kg', '33 cl'). The whole request
// is validated first and written in one transaction: any error = nothing written.
// Idempotent per (agent_id, name): sending a name again updates that row.
// Never deletes rows. Producer-set availability on a row is replaced (the admin
// is stating the producer's current list).
// ────────────────────────────────────────────────────────────────────────────
const PRODUCER_LIST_MAX_PRODUCTS = 100;
const NET_WEIGHT_RE = /^\d{1,6}([.,]\d{1,3})?\s?(g|kg|ml|cl|dl|l)$/i;
const CTRL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function requireAdmin401(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(401).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

interface ValidatedProducerProduct {
  name: string;
  name_norm: string;
  price_nok: number;
  unit: string | null;
  description: string | null;
  category: string | null;
  availability: string;
  ingredients: string | null;
  allergens: string | null; // JSON array text or null
  net_weight: string | null;
}

function optText(v: unknown, max: number, field: string, errs: string[]): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") { errs.push(`${field} må være tekst`); return null; }
  const t = v.trim();
  if (t.length > max) { errs.push(`${field} er for lang (maks ${max} tegn)`); return null; }
  if (CTRL_CHARS_RE.test(t)) { errs.push(`${field} har ugyldige tegn`); return null; }
  return t || null;
}

export function validateProducerList(raw: unknown): { ok: true; products: ValidatedProducerProduct[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, errors: ["products må være en ikke-tom liste"] };
  if (raw.length > PRODUCER_LIST_MAX_PRODUCTS) return { ok: false, errors: [`products har for mange varer (maks ${PRODUCER_LIST_MAX_PRODUCTS})`] };
  const out: ValidatedProducerProduct[] = [];
  const seen = new Set<string>();
  raw.forEach((item, idx) => {
    const at = `products[${idx}]`;
    const errs: string[] = [];
    if (!item || typeof item !== "object" || Array.isArray(item)) { errors.push(`${at} må være et objekt`); return; }
    const o = item as Record<string, unknown>;
    const name = optText(o.name, 120, "name", errs);
    if (!name) errs.push("name er påkrevd");
    const price = o.price_nok;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 100000) {
      errs.push("price_nok er påkrevd og må være et tall over 0 (maks 100000)");
    }
    const unit = optText(o.unit, 30, "unit", errs);
    const description = optText(o.description, 500, "description", errs);
    const category = optText(o.category, 40, "category", errs);
    let availability = "in_stock";
    if (o.availability !== undefined && o.availability !== null) {
      if (o.availability === "in_stock" || o.availability === "out_of_stock") availability = o.availability;
      else errs.push("availability må være 'in_stock' eller 'out_of_stock'");
    }
    const packaged = o.packaged === true;
    if (o.packaged !== undefined && typeof o.packaged !== "boolean") errs.push("packaged må være true eller false");
    const ingredients = optText(o.ingredients, 1500, "ingredients", errs);
    let allergens: string[] | null = null;
    if (o.allergens !== undefined && o.allergens !== null) {
      if (!Array.isArray(o.allergens) || o.allergens.length > 30) errs.push("allergens må være en liste (maks 30)");
      else {
        const list: string[] = [];
        for (const a of o.allergens) {
          if (typeof a !== "string" || !a.trim() || a.trim().length > 40 || CTRL_CHARS_RE.test(a)) { errs.push("allergens har en ugyldig verdi"); break; }
          list.push(a.trim().toLowerCase());
        }
        allergens = Array.from(new Set(list));
      }
    }
    const netWeight = optText(o.net_weight, 20, "net_weight", errs);
    if (netWeight !== null && !NET_WEIGHT_RE.test(netWeight)) errs.push("net_weight må være et tall med enhet, f.eks. '250 g' eller '1,5 kg'");
    // Skive 4b (S3, Daniel's choice): allergens are required for ALL food on the list, not only
    // pre-packaged food ([] = the producer states none). Ingredients and net weight stay
    // required for pre-packaged food only.
    if (allergens === null) errs.push("allergens er påkrevd for all mat (tom liste = ingen allergener oppgitt av produsenten)");
    if (packaged) {
      if (!ingredients) errs.push("ingredients er påkrevd for ferdigpakket mat");
      if (!netWeight) errs.push("net_weight er påkrevd for ferdigpakket mat");
    }
    if (name) {
      const norm = normalizeName(name);
      if (seen.has(norm)) errs.push("name er oppgitt flere ganger");
      seen.add(norm);
    }
    if (errs.length) { for (const e of errs) errors.push(`${at}: ${e}`); return; }
    out.push({
      name: name!, name_norm: normalizeName(name!), price_nok: price as number,
      unit, description, category, availability, ingredients,
      allergens: allergens === null ? null : JSON.stringify(allergens),
      net_weight: netWeight,
    });
  });
  return errors.length ? { ok: false, errors } : { ok: true, products: out };
}

adminCatalogRouter.post("/producer-list", (req: Request, res: Response) => {
  if (!requireAdmin401(req, res)) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  if (!agentId) {
    res.status(400).json({ success: false, error: "agent_id er påkrevd" });
    return;
  }
  const v = validateProducerList(body.products);
  if (!v.ok) {
    res.status(400).json({ success: false, error: "Ugyldig vareliste", errors: v.errors });
    return;
  }
  try {
    const db = getDb();
    const agent = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(agentId) as { id: string; name: string } | undefined;
    if (!agent) {
      res.status(404).json({ success: false, error: "Produsent ikke funnet" });
      return;
    }
    const existing = db.prepare("SELECT id FROM products WHERE agent_id = ? AND name_norm = ?");
    const insert = db.prepare(`
      INSERT INTO products
        (id, agent_id, name, name_norm, description, unit, price_nok, currency, availability,
         category, source, availability_updated_at, availability_source,
         ingredients, allergens, net_weight, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'NOK', ?, ?, 'admin', datetime('now'), 'admin_producer_confirmed',
              ?, ?, ?, datetime('now'), datetime('now'))
    `);
    const update = db.prepare(`
      UPDATE products
         SET name = ?, description = ?, unit = ?, price_nok = ?, availability = ?, category = ?,
             availability_updated_at = datetime('now'), availability_source = 'admin_producer_confirmed',
             ingredients = ?, allergens = ?, net_weight = ?, updated_at = datetime('now')
       WHERE id = ? AND agent_id = ?
    `);
    let inserted = 0;
    let updated = 0;
    const tx = db.transaction(() => {
      for (const p of v.products) {
        const row = existing.get(agentId, p.name_norm) as { id: string } | undefined;
        if (row) {
          update.run(p.name, p.description, p.unit, p.price_nok, p.availability, p.category,
            p.ingredients, p.allergens, p.net_weight, row.id, agentId);
          updated++;
        } else {
          insert.run(randomUUID(), agentId, p.name, p.name_norm, p.description, p.unit, p.price_nok, p.availability,
            p.category, p.ingredients, p.allergens, p.net_weight);
          inserted++;
        }
      }
    });
    tx();
    res.json({ success: true, agent_id: agentId, producer_name: agent.name, inserted, updated, availability_source: "admin_producer_confirmed" });
  } catch (err) {
    console.error("[admin/products/producer-list] failed:", err instanceof Error ? err.message : String(err));
    res.status(500).json({ success: false, error: "Intern feil" });
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
      AND ${publiclyVisibleSql("a")}
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
      AND ${publiclyVisibleSql("a")}
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
      AND ${publiclyVisibleSql("a")}
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
  // Slice I-Y: the term is cut like search text (utils/free-text.ts). A term
  // past SQLite's LIKE pattern limit (50 000 bytes) fails the lookup.
  const q = capFreeText(typeof req.query.q === "string" ? req.query.q.trim() : "");
  if (!q) {
    res.status(400).json({ success: false, error: "Mangler ?q= parameter" });
    return;
  }

  const lat = parseFloat(String(req.query.lat ?? ""));
  const lng = parseFloat(String(req.query.lng ?? ""));
  const hasCoords = isValidLatLng(lat, lng);
  // Slice I-Y2: a place name, cut to MAX_NAME_CHARS at a word boundary, as
  // lokal_find_offers' `near` is.
  const near = capName(typeof req.query.near === "string" ? req.query.near.trim() : "");

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
