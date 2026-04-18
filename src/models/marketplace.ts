import { z } from "zod";

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

export const AgentRegistrationSchema = z.object({
  // Who is this agent?
  name: z.string().min(1),
  description: z.string().min(10),
  provider: z.string().min(1), // Organization behind the agent
  contactEmail: z.string().email(),

  // A2A standard fields
  url: z.string().url(), // Agent's service endpoint
  version: z.string().default("1.0.0"),
  capabilities: z.object({
    streaming: z.boolean().default(false),
    pushNotifications: z.boolean().default(false),
    stateTransitionHistory: z.boolean().default(false),
  }).default({ streaming: false, pushNotifications: false, stateTransitionHistory: false }),

  // What can this agent do?
  skills: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()), // Searchable tags: ["vegetables", "organic", "delivery"]
    inputModes: z.array(z.string()).default(["application/json"]),
    outputModes: z.array(z.string()).default(["application/json"]),
  })).min(1 as const),

  // What role does this agent play?
  role: z.enum([
    "producer",     // Sells goods (farms, shops, markets)
    "consumer",     // Buys goods (personal agents, restaurant agents)
    "logistics",    // Handles delivery/pickup
    "quality",      // Verifies quality/certifications
    "price-intel",  // Provides price data
  ]),

  // Location (for geo-matching)
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    city: z.string(),
    radiusKm: z.number().optional(), // Service radius
  }).optional(),

  // Lokal-specific metadata
  categories: z.array(z.string()).default([]), // ["vegetables", "fruit", "dairy"]
  tags: z.array(z.string()).default([]),       // ["organic", "seasonal", "budget"]
  languages: z.array(z.string()).default(["no"]), // ISO 639-1
});

export type AgentRegistration = z.infer<typeof AgentRegistrationSchema>;

// ─── Admin Agent Registration (relaxed) ──────────────────────
// Used by auto-discovery pipeline via POST /admin/register with X-Admin-Key.
// Only requires name — everything else has sensible defaults.
// Agents registered this way get lower trust scores until enriched,
// because the completeness signal in trust-score-service penalizes
// missing fields automatically.
//
// The PUBLIC /register keeps strict requirements above — producers
// who self-register MUST provide email, URL, etc. for verification.

export const AdminRegistrationSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  provider: z.string().default("auto-discovery"),
  contactEmail: z.string().optional(),

  url: z.string().default("https://rettfrabonden.com"),
  version: z.string().default("1.0.0"),
  capabilities: z.record(z.string(), z.any()).default({}),

  skills: z.array(z.object({
    id: z.string().default("default"),
    name: z.string().default("Lokal matprodusent"),
    description: z.string().default("Selger lokalprodusert mat"),
    tags: z.array(z.string()).default([]),
    inputModes: z.array(z.string()).default(["application/json"]),
    outputModes: z.array(z.string()).default(["application/json"]),
  })).default([{
    id: "default",
    name: "Lokal matprodusent",
    description: "Selger lokalprodusert mat",
    tags: [],
    inputModes: ["application/json"],
    outputModes: ["application/json"],
  }]),

  role: z.enum(["producer", "consumer", "logistics", "quality", "price-intel"]).default("producer"),

  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    city: z.string(),
    radiusKm: z.number().optional(),
  }).optional(),

  categories: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  languages: z.array(z.string()).default(["no"]),
});

export type AdminRegistration = z.infer<typeof AdminRegistrationSchema>;

// ─── Registered Agent (stored in registry) ────────────────────

export const RegisteredAgentSchema = AgentRegistrationSchema.extend({
  id: z.string().uuid(),
  apiKey: z.string(), // For authentication
  registeredAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  isActive: z.boolean().default(true),
  isVerified: z.boolean().default(false),

  // Trust metrics (built over time)
  trustScore: z.number().min(0).max(1).default(0.5),
  totalInteractions: z.number().default(0),
  avgResponseTimeMs: z.number().optional(),

  // Discovery stats
  discoveryCount: z.number().default(0),   // How many times this agent was found in searches
  interactionCount: z.number().default(0), // How many times other agents connected
});

export type RegisteredAgent = z.infer<typeof RegisteredAgentSchema>;

// ─── Discovery Query ──────────────────────────────────────────
// How consumer agents SEARCH for producer agents

export const DiscoveryQuerySchema = z.object({
  // Natural language query (parsed by matching engine)
  query: z.string().optional(), // "ferske grønnsaker nær meg"

  // Structured filters
  role: z.enum(["producer", "consumer", "logistics", "quality", "price-intel"]).optional(),
  categories: z.array(z.string()).optional(), // ["vegetables", "fruit"]
  tags: z.array(z.string()).optional(),       // ["organic", "local"]
  skills: z.array(z.string()).optional(),     // ["inventory-check", "delivery"]

  // Geo filter
  location: z.object({
    lat: z.number(),
    lng: z.number(),
  }).optional(),
  maxDistanceKm: z.number().optional(),

  // Pagination
  limit: z.number().min(1).max(100).default(20),
  offset: z.number().min(0).default(0),
});

export type DiscoveryQuery = z.infer<typeof DiscoveryQuerySchema>;

// ─── Discovery Result ─────────────────────────────────────────

export interface DiscoveryResult {
  agent: {
    id: string;
    name: string;
    description: string;
    url: string;
    role: string;
    skills: Array<{
      id: string;
      name: string;
      description: string;
      tags: string[];
    }>;
    location?: {
      city: string;
      distanceKm?: number;
    };
    trustScore: number;
    isVerified: boolean;
    categories: string[];
    tags: string[];
  };
  relevanceScore: number; // 0-1, how well this agent matches the query
  matchReasons: string[]; // Why this agent was returned
}
