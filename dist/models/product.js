"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChainPriceSchema = exports.InventoryEntrySchema = exports.ProductSchema = exports.ProductCategorySchema = void 0;
const zod_1 = require("zod");
// ─── Product & Inventory ───────────────────────────────────────
// This is the LIVE part of the supply graph.
// A product is what a producer CAN sell.
// An inventory entry is what they HAVE RIGHT NOW.
// The distinction matters: tomatoes are a product, "40kg picked today" is inventory.
exports.ProductCategorySchema = zod_1.z.enum([
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
exports.ProductSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    producerId: zod_1.z.string().uuid(),
    name: zod_1.z.string().min(1),
    category: exports.ProductCategorySchema,
    description: zod_1.z.string().optional(),
    unit: zod_1.z.enum(["kg", "g", "piece", "bunch", "liter", "box", "bag"]),
    // Variety support — "Tomater" is the product, "Cherry" is the variety
    // This lets us distinguish cherry tomatoes from beef tomatoes,
    // new potatoes from baking potatoes, Gravenstein from Summerred apples.
    variety: zod_1.z.string().optional(), // e.g., "Cherry", "San Marzano", "Mandel"
    parentProduct: zod_1.z.string().optional(), // normalized parent, e.g., "tomater"
    // Quality signals — what the preference engine uses
    isOrganic: zod_1.z.boolean().default(false),
    isSeasonal: zod_1.z.boolean().default(true),
    isLocallyGrown: zod_1.z.boolean().default(true), // grown by the producer themselves
    growingMethod: zod_1.z.string().optional(), // "outdoor", "greenhouse", "hydroponic"
    // Visual — from video/image scan or manual upload
    imageUrl: zod_1.z.string().url().optional(),
    detectedFromScan: zod_1.z.boolean().default(false), // true if auto-detected from video/image
    scanConfidence: zod_1.z.number().min(0).max(1).optional(), // how confident the vision model was
});
exports.InventoryEntrySchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    productId: zod_1.z.string().uuid(),
    producerId: zod_1.z.string().uuid(),
    // What's available RIGHT NOW
    quantityAvailable: zod_1.z.number().min(0),
    unit: zod_1.z.enum(["kg", "g", "piece", "bunch", "liter", "box", "bag"]),
    pricePerUnit: zod_1.z.number().min(0), // in NOK
    currency: zod_1.z.string().default("NOK"),
    // Freshness — the killer differentiator
    harvestedAt: zod_1.z.string().datetime().optional(), // when was it picked/made
    availableFrom: zod_1.z.string().datetime(), // when can it be bought
    availableUntil: zod_1.z.string().datetime(), // when does it expire/run out
    // Status
    status: zod_1.z.enum(["available", "low-stock", "reserved", "sold-out"]),
    updatedAt: zod_1.z.string().datetime(),
});
// Chain price comparison — the "22% cheaper than Rema" feature
exports.ChainPriceSchema = zod_1.z.object({
    productName: zod_1.z.string(), // normalized name, e.g., "tomatoes-regular"
    category: exports.ProductCategorySchema,
    chain: zod_1.z.string(), // "rema-1000", "kiwi", "meny", "coop-extra"
    pricePerUnit: zod_1.z.number(),
    unit: zod_1.z.enum(["kg", "g", "piece", "bunch", "liter", "box", "bag"]),
    currency: zod_1.z.string().default("NOK"),
    isOrganic: zod_1.z.boolean().default(false),
    scrapedAt: zod_1.z.string().datetime(),
    source: zod_1.z.string().optional(), // "oda.com", "kolonial.no", "manual"
});
//# sourceMappingURL=product.js.map