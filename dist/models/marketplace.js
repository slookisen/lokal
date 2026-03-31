"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiscoveryQuerySchema = exports.RegisteredAgentSchema = exports.AgentRegistrationSchema = void 0;
const zod_1 = require("zod");
// ─── Agent Marketplace Models ─────────────────────────────────
// These models power Lokal as a REGISTRY — the discovery layer
// where any agent can register and be found by other agents.
//
// Why this matters: The A2A protocol defines agent cards but has
// NO standard registry. Lokal becomes the first vertical registry
// for local food. When a consumer agent asks "find local vegetables",
// it queries OUR registry — not Google, not a website.
// ─── External Agent Registration ──────────────────────────────
// Any agent (producer, logistics, quality-check) can register.
// Not just our internal producers — this is how we become infrastructure.
exports.AgentRegistrationSchema = zod_1.z.object({
    // Who is this agent?
    name: zod_1.z.string().min(1),
    description: zod_1.z.string().min(10),
    provider: zod_1.z.string().min(1), // Organization behind the agent
    contactEmail: zod_1.z.string().email(),
    // A2A standard fields
    url: zod_1.z.string().url(), // Agent's service endpoint
    version: zod_1.z.string().default("1.0.0"),
    capabilities: zod_1.z.object({
        streaming: zod_1.z.boolean().default(false),
        pushNotifications: zod_1.z.boolean().default(false),
        stateTransitionHistory: zod_1.z.boolean().default(false),
    }).default({}),
    // What can this agent do?
    skills: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string(),
        name: zod_1.z.string(),
        description: zod_1.z.string(),
        tags: zod_1.z.array(zod_1.z.string()), // Searchable tags: ["vegetables", "organic", "delivery"]
        inputModes: zod_1.z.array(zod_1.z.string()).default(["application/json"]),
        outputModes: zod_1.z.array(zod_1.z.string()).default(["application/json"]),
    })).min(1),
    // What role does this agent play?
    role: zod_1.z.enum([
        "producer", // Sells goods (farms, shops, markets)
        "consumer", // Buys goods (personal agents, restaurant agents)
        "logistics", // Handles delivery/pickup
        "quality", // Verifies quality/certifications
        "price-intel", // Provides price data
    ]),
    // Location (for geo-matching)
    location: zod_1.z.object({
        lat: zod_1.z.number().min(-90).max(90),
        lng: zod_1.z.number().min(-180).max(180),
        city: zod_1.z.string(),
        radiusKm: zod_1.z.number().optional(), // Service radius
    }).optional(),
    // Lokal-specific metadata
    categories: zod_1.z.array(zod_1.z.string()).default([]), // ["vegetables", "fruit", "dairy"]
    tags: zod_1.z.array(zod_1.z.string()).default([]), // ["organic", "seasonal", "budget"]
    languages: zod_1.z.array(zod_1.z.string()).default(["no"]), // ISO 639-1
});
// ─── Registered Agent (stored in registry) ────────────────────
exports.RegisteredAgentSchema = exports.AgentRegistrationSchema.extend({
    id: zod_1.z.string().uuid(),
    apiKey: zod_1.z.string(), // For authentication
    registeredAt: zod_1.z.string().datetime(),
    lastSeenAt: zod_1.z.string().datetime(),
    isActive: zod_1.z.boolean().default(true),
    isVerified: zod_1.z.boolean().default(false),
    // Trust metrics (built over time)
    trustScore: zod_1.z.number().min(0).max(1).default(0.5),
    totalInteractions: zod_1.z.number().default(0),
    avgResponseTimeMs: zod_1.z.number().optional(),
    // Discovery stats
    discoveryCount: zod_1.z.number().default(0), // How many times this agent was found in searches
    interactionCount: zod_1.z.number().default(0), // How many times other agents connected
});
// ─── Discovery Query ──────────────────────────────────────────
// How consumer agents SEARCH for producer agents
exports.DiscoveryQuerySchema = zod_1.z.object({
    // Natural language query (parsed by matching engine)
    query: zod_1.z.string().optional(), // "ferske grønnsaker nær meg"
    // Structured filters
    role: zod_1.z.enum(["producer", "consumer", "logistics", "quality", "price-intel"]).optional(),
    categories: zod_1.z.array(zod_1.z.string()).optional(), // ["vegetables", "fruit"]
    tags: zod_1.z.array(zod_1.z.string()).optional(), // ["organic", "local"]
    skills: zod_1.z.array(zod_1.z.string()).optional(), // ["inventory-check", "delivery"]
    // Geo filter
    location: zod_1.z.object({
        lat: zod_1.z.number(),
        lng: zod_1.z.number(),
    }).optional(),
    maxDistanceKm: zod_1.z.number().optional(),
    // Pagination
    limit: zod_1.z.number().min(1).max(100).default(20),
    offset: zod_1.z.number().min(0).default(0),
});
//# sourceMappingURL=marketplace.js.map