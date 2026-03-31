import { z } from "zod";

// ─── Consumer Preferences ──────────────────────────────────────
// This is how agents find each other by VALUES, not by size.
// Each field is a weight 0–1 representing how much the consumer cares.
// The matching engine uses these to rank producers — no ads, no popularity.

export const ConsumerPreferencesSchema = z.object({
  id: z.string().uuid(),

  // Core preferences (0 = don't care, 1 = critical)
  priceSensitivity: z.number().min(0).max(1).default(0.5),
  organicPreference: z.number().min(0).max(1).default(0.3),
  freshnessWeight: z.number().min(0).max(1).default(0.7),
  seasonalPreference: z.number().min(0).max(1).default(0.5),
  sustainabilityWeight: z.number().min(0).max(1).default(0.3),
  localityWeight: z.number().min(0).max(1).default(0.6), // how much they value "local"

  // Hard constraints
  maxDistanceKm: z.number().min(0.5).max(50).default(5),
  dietary: z.array(z.string()).default([]), // ["vegetarian", "vegan", "gluten-free"]
  allergies: z.array(z.string()).default([]),
  preferredCategories: z.array(z.string()).default([]), // ["vegetables", "fruits", "eggs"]

  // Delivery preference
  preferPickup: z.boolean().default(true),
  preferDelivery: z.boolean().default(false),

  // Location (for distance calculation)
  location: z.object({
    lat: z.number(),
    lng: z.number(),
  }),

  // Learning data (updated over time)
  purchaseHistory: z
    .array(
      z.object({
        producerId: z.string().uuid(),
        productCategory: z.string(),
        timestamp: z.string().datetime(),
        satisfaction: z.number().min(1).max(5).optional(),
      })
    )
    .default([]),
});

// What a consumer agent sends when searching
export const SearchRequestSchema = z.object({
  query: z.string().optional(), // "tomater", "økologiske egg", free text
  category: z.string().optional(),
  maxPricePerUnit: z.number().optional(),
  maxDistanceKm: z.number().optional(),
  mustBeOrganic: z.boolean().optional(),
  mustBeSeasonal: z.boolean().optional(),
  preferredDelivery: z.enum(["pickup", "local-delivery", "any"]).optional(),

  // Consumer location for distance calc
  location: z.object({
    lat: z.number(),
    lng: z.number(),
  }),

  // Implicit preferences (from consumer profile, not typed by user)
  consumerPreferences: ConsumerPreferencesSchema.optional(),
});

// What comes back — ranked by preference match, NOT popularity
export const SearchResultSchema = z.object({
  producerId: z.string().uuid(),
  producerName: z.string(),
  producerType: z.string(),
  distanceKm: z.number(),
  trustScore: z.number(),

  product: z.object({
    productId: z.string().uuid(),
    name: z.string(),
    pricePerUnit: z.number(),
    unit: z.string(),
    quantityAvailable: z.number(),
    isOrganic: z.boolean(),
    isSeasonal: z.boolean(),
    freshnessHours: z.number().optional(), // hours since harvest
  }),

  // The magic — preference match score (0–1)
  matchScore: z.number().min(0).max(1),
  matchReasons: z.array(z.string()), // ["22% cheaper than Rema", "600m away", "harvested 4 hours ago"]

  // Price comparison (the killer feature)
  chainComparison: z
    .object({
      cheapestChain: z.string(),
      chainPrice: z.number(),
      priceDifference: z.number(), // negative = local is cheaper
      percentDifference: z.number(),
      comparisonLabel: z.string(), // "22% billigere enn Rema 1000"
    })
    .optional(),
});

export type ConsumerPreferences = z.infer<typeof ConsumerPreferencesSchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
