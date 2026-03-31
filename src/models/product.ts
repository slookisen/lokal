import { z } from "zod";

// ─── Product & Inventory ───────────────────────────────────────
// This is the LIVE part of the supply graph.
// A product is what a producer CAN sell.
// An inventory entry is what they HAVE RIGHT NOW.
// The distinction matters: tomatoes are a product, "40kg picked today" is inventory.

export const ProductCategorySchema = z.enum([
  "vegetables",
  "fruits",
  "berries",
  "herbs",
  "eggs",
  "dairy",
  "bread",
  "meat",
  "fish",
  "honey",
  "preserves",
  "flowers",
  "other",
]);

export const ProductSchema = z.object({
  id: z.string().uuid(),
  producerId: z.string().uuid(),
  name: z.string().min(1),
  category: ProductCategorySchema,
  description: z.string().optional(),
  unit: z.enum(["kg", "g", "piece", "bunch", "liter", "box", "bag"]),

  // Variety support — "Tomater" is the product, "Cherry" is the variety
  // This lets us distinguish cherry tomatoes from beef tomatoes,
  // new potatoes from baking potatoes, Gravenstein from Summerred apples.
  variety: z.string().optional(), // e.g., "Cherry", "San Marzano", "Mandel"
  parentProduct: z.string().optional(), // normalized parent, e.g., "tomater"

  // Quality signals — what the preference engine uses
  isOrganic: z.boolean().default(false),
  isSeasonal: z.boolean().default(true),
  isLocallyGrown: z.boolean().default(true), // grown by the producer themselves
  growingMethod: z.string().optional(), // "outdoor", "greenhouse", "hydroponic"

  // Visual — from video/image scan or manual upload
  imageUrl: z.string().url().optional(),
  detectedFromScan: z.boolean().default(false), // true if auto-detected from video/image
  scanConfidence: z.number().min(0).max(1).optional(), // how confident the vision model was
});

export const InventoryEntrySchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  producerId: z.string().uuid(),

  // What's available RIGHT NOW
  quantityAvailable: z.number().min(0),
  unit: z.enum(["kg", "g", "piece", "bunch", "liter", "box", "bag"]),
  pricePerUnit: z.number().min(0), // in NOK
  currency: z.string().default("NOK"),

  // Freshness — the killer differentiator
  harvestedAt: z.string().datetime().optional(), // when was it picked/made
  availableFrom: z.string().datetime(), // when can it be bought
  availableUntil: z.string().datetime(), // when does it expire/run out

  // Status
  status: z.enum(["available", "low-stock", "reserved", "sold-out"]),
  updatedAt: z.string().datetime(),
});

// Chain price comparison — the "22% cheaper than Rema" feature
export const ChainPriceSchema = z.object({
  productName: z.string(), // normalized name, e.g., "tomatoes-regular"
  category: ProductCategorySchema,
  chain: z.string(), // "rema-1000", "kiwi", "meny", "coop-extra"
  pricePerUnit: z.number(),
  unit: z.enum(["kg", "g", "piece", "bunch", "liter", "box", "bag"]),
  currency: z.string().default("NOK"),
  isOrganic: z.boolean().default(false),
  scrapedAt: z.string().datetime(),
  source: z.string().optional(), // "oda.com", "kolonial.no", "manual"
});

export type Product = z.infer<typeof ProductSchema>;
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;
export type ChainPrice = z.infer<typeof ChainPriceSchema>;
export type ProductCategory = z.infer<typeof ProductCategorySchema>;
