"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchResultSchema = exports.SearchRequestSchema = exports.ConsumerPreferencesSchema = void 0;
const zod_1 = require("zod");
// ─── Consumer Preferences ──────────────────────────────────────
// This is how agents find each other by VALUES, not by size.
// Each field is a weight 0–1 representing how much the consumer cares.
// The matching engine uses these to rank producers — no ads, no popularity.
exports.ConsumerPreferencesSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    // Core preferences (0 = don't care, 1 = critical)
    priceSensitivity: zod_1.z.number().min(0).max(1).default(0.5),
    organicPreference: zod_1.z.number().min(0).max(1).default(0.3),
    freshnessWeight: zod_1.z.number().min(0).max(1).default(0.7),
    seasonalPreference: zod_1.z.number().min(0).max(1).default(0.5),
    sustainabilityWeight: zod_1.z.number().min(0).max(1).default(0.3),
    localityWeight: zod_1.z.number().min(0).max(1).default(0.6), // how much they value "local"
    // Hard constraints
    maxDistanceKm: zod_1.z.number().min(0.5).max(50).default(5),
    dietary: zod_1.z.array(zod_1.z.string()).default([]), // ["vegetarian", "vegan", "gluten-free"]
    allergies: zod_1.z.array(zod_1.z.string()).default([]),
    preferredCategories: zod_1.z.array(zod_1.z.string()).default([]), // ["vegetables", "fruits", "eggs"]
    // Delivery preference
    preferPickup: zod_1.z.boolean().default(true),
    preferDelivery: zod_1.z.boolean().default(false),
    // Location (for distance calculation)
    location: zod_1.z.object({
        lat: zod_1.z.number(),
        lng: zod_1.z.number(),
    }),
    // Learning data (updated over time)
    purchaseHistory: zod_1.z
        .array(zod_1.z.object({
        producerId: zod_1.z.string().uuid(),
        productCategory: zod_1.z.string(),
        timestamp: zod_1.z.string().datetime(),
        satisfaction: zod_1.z.number().min(1).max(5).optional(),
    }))
        .default([]),
});
// What a consumer agent sends when searching
exports.SearchRequestSchema = zod_1.z.object({
    query: zod_1.z.string().optional(), // "tomater", "økologiske egg", free text
    category: zod_1.z.string().optional(),
    maxPricePerUnit: zod_1.z.number().optional(),
    maxDistanceKm: zod_1.z.number().optional(),
    mustBeOrganic: zod_1.z.boolean().optional(),
    mustBeSeasonal: zod_1.z.boolean().optional(),
    preferredDelivery: zod_1.z.enum(["pickup", "local-delivery", "any"]).optional(),
    // Consumer location for distance calc
    location: zod_1.z.object({
        lat: zod_1.z.number(),
        lng: zod_1.z.number(),
    }),
    // Implicit preferences (from consumer profile, not typed by user)
    consumerPreferences: exports.ConsumerPreferencesSchema.optional(),
});
// What comes back — ranked by preference match, NOT popularity
exports.SearchResultSchema = zod_1.z.object({
    producerId: zod_1.z.string().uuid(),
    producerName: zod_1.z.string(),
    producerType: zod_1.z.string(),
    distanceKm: zod_1.z.number(),
    trustScore: zod_1.z.number(),
    product: zod_1.z.object({
        productId: zod_1.z.string().uuid(),
        name: zod_1.z.string(),
        pricePerUnit: zod_1.z.number(),
        unit: zod_1.z.string(),
        quantityAvailable: zod_1.z.number(),
        isOrganic: zod_1.z.boolean(),
        isSeasonal: zod_1.z.boolean(),
        freshnessHours: zod_1.z.number().optional(), // hours since harvest
    }),
    // The magic — preference match score (0–1)
    matchScore: zod_1.z.number().min(0).max(1),
    matchReasons: zod_1.z.array(zod_1.z.string()), // ["22% cheaper than Rema", "600m away", "harvested 4 hours ago"]
    // Price comparison (the killer feature)
    chainComparison: zod_1.z
        .object({
        cheapestChain: zod_1.z.string(),
        chainPrice: zod_1.z.number(),
        priceDifference: zod_1.z.number(), // negative = local is cheaper
        percentDifference: zod_1.z.number(),
        comparisonLabel: zod_1.z.string(), // "22% billigere enn Rema 1000"
    })
        .optional(),
});
//# sourceMappingURL=consumer.js.map