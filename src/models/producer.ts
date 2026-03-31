import { z } from "zod";

// ─── Core Types ────────────────────────────────────────────────
// These models represent the Local Supply Graph — the #1 asset.
// Every field exists because a consumer agent or matching engine needs it.

export const LocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().optional(),
  city: z.string(),
  district: z.string().optional(), // e.g., "Grünerløkka", "Grønland"
});

export const OpeningHoursSchema = z.object({
  day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
  open: z.string(), // "08:00"
  close: z.string(), // "17:00"
});

export const ProducerSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(["farm", "shop", "market", "cooperative", "garden"]),
  location: LocationSchema,
  openingHours: z.array(OpeningHoursSchema),
  contactPhone: z.string().optional(),
  contactEmail: z.string().email().optional(),

  // What makes matching work — these are the producer's "values"
  tags: z.array(z.string()), // ["organic", "seasonal", "family-run", "pesticide-free"]
  certifications: z.array(z.string()), // ["debio-organic", "nyt-norge"]
  deliveryOptions: z.array(z.enum(["pickup", "local-delivery", "shipping"])),
  maxDeliveryRadiusKm: z.number().optional(),

  // Trust (built over time — starts empty)
  trustScore: z.number().min(0).max(1).default(0.5), // 0.5 = new, unrated
  totalTransactions: z.number().default(0),
  availabilityAccuracy: z.number().min(0).max(1).default(0.5),
  responseTimeAvgMs: z.number().optional(),

  // Metadata
  registeredAt: z.string().datetime(),
  lastActiveAt: z.string().datetime(),
  isActive: z.boolean().default(true),
});

export type Producer = z.infer<typeof ProducerSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type OpeningHours = z.infer<typeof OpeningHoursSchema>;
