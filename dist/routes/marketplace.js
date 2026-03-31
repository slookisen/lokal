"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const marketplace_registry_1 = require("../services/marketplace-registry");
const marketplace_1 = require("../models/marketplace");
// ─── Marketplace Routes ───────────────────────────────────────
// These are the OPEN endpoints that make Lokal a marketplace.
// Any agent in the world can:
//   1. Register themselves (POST /api/marketplace/register)
//   2. Discover other agents (POST /api/marketplace/discover)
//   3. Search with natural language (GET /api/marketplace/search?q=...)
//
// This is the "DNS for food agents" — the endpoints that external
// AI agents (ChatGPT, Claude, Gemini plugins) will call.
const router = (0, express_1.Router)();
// ─── POST /register — Register a new agent ──────────────────
// A producer, logistics provider, or any food agent can register.
// Returns an API key for future authenticated requests.
//
// Example: A farm's agent registers with:
//   { name: "Aker Gård Agent", role: "producer",
//     skills: [{ id: "sell-vegetables", tags: ["tomater", "poteter"] }],
//     location: { lat: 59.95, lng: 10.77, city: "Oslo" } }
router.post("/register", (req, res) => {
    try {
        const registration = marketplace_1.AgentRegistrationSchema.parse(req.body);
        const agent = marketplace_registry_1.marketplaceRegistry.register(registration);
        res.status(201).json({
            success: true,
            message: "Agent registrert i Lokal-markedsplassen",
            data: {
                id: agent.id,
                apiKey: agent.apiKey, // Store this! Needed for updates
                agentCardUrl: `${getBaseUrl(req)}/api/marketplace/agents/${agent.id}/card`,
                registeredAt: agent.registeredAt,
            },
        });
    }
    catch (error) {
        if (error.name === "ZodError") {
            res.status(400).json({
                success: false,
                error: "Ugyldig registrering",
                details: error.errors,
            });
        }
        else {
            res.status(500).json({ success: false, error: "Intern feil" });
        }
    }
});
// ─── POST /discover — Structured agent discovery ─────────────
// Consumer agents call this to find producers matching criteria.
// This is the A2A-compatible discovery endpoint.
//
// Body: { categories: ["vegetables"], tags: ["organic"],
//         location: { lat: 59.92, lng: 10.75 }, maxDistanceKm: 5 }
router.post("/discover", (req, res) => {
    try {
        const query = marketplace_1.DiscoveryQuerySchema.parse(req.body);
        const results = marketplace_registry_1.marketplaceRegistry.discover(query);
        res.json({
            success: true,
            count: results.length,
            query: {
                role: query.role,
                categories: query.categories,
                tags: query.tags,
                maxDistanceKm: query.maxDistanceKm,
            },
            results,
        });
    }
    catch (error) {
        if (error.name === "ZodError") {
            res.status(400).json({ success: false, error: "Ugyldig søk", details: error.errors });
        }
        else {
            res.status(500).json({ success: false, error: "Intern feil" });
        }
    }
});
// ─── GET /search?q=... — Natural language search ─────────────
// The "Google-like" endpoint. Consumer agents send a text query,
// we parse it and return matching agents.
//
// Example: GET /search?q=ferske+økologiske+grønnsaker+nær+Grünerløkka
router.get("/search", (req, res) => {
    const q = req.query.q;
    if (!q) {
        res.status(400).json({ success: false, error: "Mangler ?q= parameter" });
        return;
    }
    // Parse natural language into structured query
    const parsed = marketplace_registry_1.marketplaceRegistry.parseNaturalQuery(q);
    const query = marketplace_1.DiscoveryQuerySchema.parse({
        ...parsed,
        limit: parseInt(req.query.limit) || 20,
        offset: parseInt(req.query.offset) || 0,
    });
    const results = marketplace_registry_1.marketplaceRegistry.discover(query);
    res.json({
        success: true,
        query: q,
        parsed, // Show what we understood (transparency)
        count: results.length,
        results,
    });
});
// ─── GET /agents/:id/card — Individual agent card (A2A) ──────
// Standard A2A agent card for a registered agent
router.get("/agents/:id/card", (req, res) => {
    const card = marketplace_registry_1.marketplaceRegistry.getAgentCard(req.params.id);
    if (!card) {
        res.status(404).json({ error: "Agent ikke funnet" });
        return;
    }
    res.json(card);
});
// ─── PUT /agents/:id — Update agent (authenticated) ──────────
// Agents can update their own info using their API key
router.put("/agents/:id", (req, res) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) {
        res.status(401).json({ error: "Mangler X-API-Key header" });
        return;
    }
    const agent = marketplace_registry_1.marketplaceRegistry.getAgentByApiKey(apiKey);
    if (!agent || agent.id !== req.params.id) {
        res.status(403).json({ error: "Ikke autorisert" });
        return;
    }
    const updated = marketplace_registry_1.marketplaceRegistry.updateAgent(req.params.id, req.body);
    if (!updated) {
        res.status(404).json({ error: "Agent ikke funnet" });
        return;
    }
    res.json({ success: true, data: { id: updated.id, name: updated.name, lastSeenAt: updated.lastSeenAt } });
});
// ─── POST /agents/:id/heartbeat — Keep agent alive ───────────
// Agents should ping this periodically so we know they're active
router.post("/agents/:id/heartbeat", (req, res) => {
    const apiKey = req.headers["x-api-key"];
    const agent = marketplace_registry_1.marketplaceRegistry.getAgentByApiKey(apiKey);
    if (!agent || agent.id !== req.params.id) {
        res.status(403).json({ error: "Ikke autorisert" });
        return;
    }
    marketplace_registry_1.marketplaceRegistry.heartbeat(req.params.id);
    res.json({ success: true, lastSeenAt: new Date().toISOString() });
});
// ─── GET /stats — Marketplace stats ──────────────────────────
router.get("/stats", (_req, res) => {
    res.json({
        success: true,
        data: marketplace_registry_1.marketplaceRegistry.getStats(),
    });
});
// ─── GET /agents — List all active agents ────────────────────
router.get("/agents", (_req, res) => {
    const agents = marketplace_registry_1.marketplaceRegistry.getActiveAgents();
    res.json({
        success: true,
        count: agents.length,
        agents: agents.map(a => ({
            id: a.id,
            name: a.name,
            description: a.description,
            role: a.role,
            categories: a.categories,
            tags: a.tags,
            location: a.location ? { city: a.location.city } : undefined,
            trustScore: a.trustScore,
            isVerified: a.isVerified,
            skills: a.skills.map(s => ({ id: s.id, name: s.name, tags: s.tags })),
        })),
    });
});
// ─── Helper ──────────────────────────────────────────────────
function getBaseUrl(req) {
    return process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
}
exports.default = router;
//# sourceMappingURL=marketplace.js.map