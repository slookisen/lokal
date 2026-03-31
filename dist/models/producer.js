"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProducerSchema = exports.OpeningHoursSchema = exports.LocationSchema = void 0;
const zod_1 = require("zod");
// ─── Core Types ────────────────────────────────────────────────
// These models represent the Local Supply Graph — the #1 asset.
// Every field exists because a consumer agent or matching engine needs it.
exports.LocationSchema = zod_1.z.object({
    lat: zod_1.z.number().min(-90).max(90),
    lng: zod_1.z.number().min(-180).max(180),
    address: zod_1.z.string().optional(),
    city: zod_1.z.string(),
    district: zod_1.z.string().optional(), // e.g., "Grünerløkka", "Grønland"
});
exports.OpeningHoursSchema = zod_1.z.object({
    day: zod_1.z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
    open: zod_1.z.string(), // "08:00"
    close: zod_1.z.string(), // "17:00"
});
exports.ProducerSchema = zod_1.z.object({
    id: zod_1.z.string().uuid(),
    name: zod_1.z.string().min(1),
    description: zod_1.z.string().optional(),
    type: zod_1.z.enum(["farm", "shop", "market", "cooperative", "garden"]),
    location: exports.LocationSchema,
    openingHours: zod_1.z.array(exports.OpeningHoursSchema),
    contactPhone: zod_1.z.string().optional(),
    contactEmail: zod_1.z.string().email().optional(),
    // What makes matching work — these are the producer's "values"
    tags: zod_1.z.array(zod_1.z.string()), // ["organic", "seasonal", "family-run", "pesticide-free"]
    certifications: zod_1.z.array(zod_1.z.string()), // ["debio-organic", "nyt-norge"]
    deliveryOptions: zod_1.z.array(zod_1.z.enum(["pickup", "local-delivery", "shipping"])),
    maxDeliveryRadiusKm: zod_1.z.number().optional(),
    // Trust (built over time — starts empty)
    trustScore: zod_1.z.number().min(0).max(1).default(0.5), // 0.5 = new, unrated
    totalTransactions: zod_1.z.number().default(0),
    availabilityAccuracy: zod_1.z.number().min(0).max(1).default(0.5),
    responseTimeAvgMs: zod_1.z.number().optional(),
    // Metadata
    registeredAt: zod_1.z.string().datetime(),
    lastActiveAt: zod_1.z.string().datetime(),
    isActive: zod_1.z.boolean().default(true),
});
//# sourceMappingURL=producer.js.map