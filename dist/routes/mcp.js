"use strict";
/**
 * MCP Streamable HTTP Transport — Remote MCP endpoint for ChatGPT & other AI platforms
 *
 * This adds a /mcp endpoint to the Express server that speaks the MCP protocol
 * over Streamable HTTP (the transport ChatGPT, OpenAI Agents SDK, and other
 * remote clients use). Unlike the stdio MCP server (npm package), this runs
 * server-side and calls internal services directly — no HTTP round-trip.
 *
 * Endpoint: POST https://rettfrabonden.com/mcp
 *           GET  https://rettfrabonden.com/mcp  (SSE stream for notifications)
 *           DELETE https://rettfrabonden.com/mcp (session cleanup)
 *
 * ChatGPT Developer Mode: paste https://rettfrabonden.com/mcp as the MCP URL.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = require("crypto");
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const zod_1 = require("zod");
const marketplace_registry_1 = require("../services/marketplace-registry");
const knowledge_service_1 = require("../services/knowledge-service");
const router = (0, express_1.Router)();
// ─── Tool definitions (shared logic) ────────────────────────
// These mirror the stdio MCP server tools but call services directly.
function registerTools(server) {
    // Tool 1: Natural language search
    server.tool("lokal_search", "Search for local food producers in Norway using natural language. Supports Norwegian and English. Returns ranked producers with contact info. Examples: 'fresh vegetables near Grünerløkka', 'organic honey Oslo', 'ost Trondheim'.", {
        query: zod_1.z.string().describe("Natural language search query (Norwegian or English)"),
        limit: zod_1.z.number().min(1).max(50).default(10).describe("Max results"),
    }, async ({ query, limit }) => {
        const parsed = marketplace_registry_1.marketplaceRegistry.parseNaturalQuery(query);
        const results = marketplace_registry_1.marketplaceRegistry.discover({ ...parsed, limit: limit || 10, offset: 0 });
        if (!results?.length) {
            return { content: [{ type: "text", text: `Ingen resultater for "${query}". Prøv et bredere søk.` }] };
        }
        const header = `🥬 **Lokal mat-søk: "${query}"** — fant ${results.length} produsenter:\n`;
        const lines = results.map((r, i) => {
            const agent = r.agent;
            const dist = r.distanceKm ? ` — ${r.distanceKm.toFixed(1)} km unna` : "";
            return formatAgentCompact(agent, i + 1, r.contact) + dist;
        });
        return { content: [{ type: "text", text: header + "\n" + lines.join("\n\n") }] };
    });
    // Tool 2: Structured discovery
    server.tool("lokal_discover", "Structured search in the Lokal food producer registry. Filter by food categories, tags, and geographic distance.", {
        categories: zod_1.z.array(zod_1.z.string()).optional().describe("Categories: vegetables, fruit, berries, dairy, eggs, meat, fish, bread, honey, herbs"),
        tags: zod_1.z.array(zod_1.z.string()).optional().describe("Tags: organic, seasonal, budget, local, fresh"),
        lat: zod_1.z.number().optional().describe("Latitude for distance filtering"),
        lng: zod_1.z.number().optional().describe("Longitude for distance filtering"),
        maxDistanceKm: zod_1.z.number().optional().describe("Max distance in km"),
        limit: zod_1.z.number().min(1).max(50).default(10).describe("Max results"),
    }, async ({ categories, tags, lat, lng, maxDistanceKm, limit }) => {
        const body = { categories, tags, lat, lng, maxDistanceKm, limit: limit || 10, role: "producer" };
        const results = marketplace_registry_1.marketplaceRegistry.discover(body);
        if (!results?.length) {
            return { content: [{ type: "text", text: "Ingen produsenter funnet med disse filtrene." }] };
        }
        const header = `🔍 **Strukturert søk** — ${results.length} resultater:\n`;
        const lines = results.map((r, i) => {
            const dist = r.distanceKm ? ` (${r.distanceKm.toFixed(1)} km)` : "";
            return formatAgentCompact(r.agent, i + 1, r.contact) + dist;
        });
        return { content: [{ type: "text", text: header + "\n" + lines.join("\n\n") }] };
    });
    // Tool 3: Producer details
    server.tool("lokal_info", "Get detailed information about a specific Lokal producer — address, products, opening hours, certifications, and contact info.", {
        agentId: zod_1.z.string().describe("The producer's agent ID (UUID)"),
    }, async ({ agentId }) => {
        const info = knowledge_service_1.knowledgeService.getAgentInfo(agentId);
        if (!info) {
            return { content: [{ type: "text", text: `Fant ingen produsent med ID ${agentId}.` }] };
        }
        const { agent, knowledge: k = {}, meta = {} } = info;
        const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";
        const sections = [`# ${agent.name}`];
        if (agent.city) {
            sections.push(`📍 ${agent.city}${agent.trustScore ? `  ·  Trust ${Math.round(agent.trustScore * 100)}%` : ""}${agent.isVerified ? "  ·  ✔ Verifisert" : ""}`);
        }
        if (k.about)
            sections.push(`\n${k.about}`);
        // Contact
        const contact = [];
        if (k.address)
            contact.push(`📍 ${k.address}${k.postalCode ? `, ${k.postalCode}` : ""}`);
        if (k.phone)
            contact.push(`📞 ${k.phone}`);
        if (k.email)
            contact.push(`✉️ ${k.email}`);
        if (k.website)
            contact.push(`🌐 ${k.website}`);
        if (contact.length)
            sections.push(`\n## Kontakt\n${contact.join("\n")}`);
        // vCard
        sections.push(`\n🪪 [Last ned kontaktkort (vCard)](${BASE_URL}/api/marketplace/agents/${agent.id}/vcard)`);
        // Opening hours
        if (k.openingHours?.length) {
            const dayNames = { mon: "Man", tue: "Tir", wed: "Ons", thu: "Tor", fri: "Fre", sat: "Lør", sun: "Søn" };
            const hours = k.openingHours.map((h) => `${dayNames[h.day] || h.day} ${h.open}–${h.close}`).join(", ");
            sections.push(`\n## Åpningstider\n${hours}`);
        }
        // Products
        if (k.products?.length) {
            const productLines = k.products.map((p) => {
                const seasonal = p.seasonal && p.months?.length ? ` _(sesong: mnd ${p.months.join(", ")})_` : "";
                return `- ${p.name}${p.category ? ` — ${p.category}` : ""}${seasonal}`;
            });
            sections.push(`\n## Produkter\n${productLines.join("\n")}`);
        }
        if (k.specialties?.length)
            sections.push(`\n## Spesialiteter\n${k.specialties.map((s) => `- ${s}`).join("\n")}`);
        if (k.certifications?.length)
            sections.push(`\n## Sertifiseringer\n${k.certifications.map((c) => `- ${c}`).join("\n")}`);
        if (k.paymentMethods?.length)
            sections.push(`\n💳 **Betaling:** ${k.paymentMethods.join(", ")}`);
        if (k.deliveryOptions?.length)
            sections.push(`🚚 **Levering:** ${k.deliveryOptions.join(", ")}`);
        if (meta.disclaimer) {
            const src = meta.autoSources?.length ? ` (kilder: ${meta.autoSources.join(", ")})` : "";
            sections.push(`\n---\n_${meta.disclaimer}${src}_`);
        }
        return { content: [{ type: "text", text: sections.join("\n") }] };
    });
    // Tool 4: Platform stats
    server.tool("lokal_stats", "Get Lokal platform statistics — total agents, cities covered, interactions.", {}, async () => {
        const stats = marketplace_registry_1.marketplaceRegistry.getStats();
        const text = [
            "📊 **Lokal — Plattformstatistikk**",
            `Totalt agenter: ${stats.totalAgents || "?"}`,
            `Byer: ${stats.cities || "?"}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
    });
}
// ─── Compact agent formatter ────────────────────────────────
function formatAgentCompact(agent, idx, contact) {
    const lines = [`**${idx}. ${agent.name}**`];
    if (agent.description)
        lines.push(`   ${agent.description}`);
    const meta = [];
    if (agent.location?.city)
        meta.push(`📍 ${agent.location.city}`);
    if (agent.categories?.length)
        meta.push(`🏷️ ${agent.categories.join(", ")}`);
    if (agent.trustScore)
        meta.push(`✅ Trust ${Math.round(agent.trustScore * 100)}%`);
    if (meta.length)
        lines.push(`   ${meta.join("  ·  ")}`);
    if (contact) {
        const cl = [];
        if (contact.address)
            cl.push(`📍 ${contact.address}`);
        if (contact.phone)
            cl.push(`📞 ${contact.phone}`);
        if (contact.email)
            cl.push(`✉️ ${contact.email}`);
        if (contact.website)
            cl.push(`🌐 ${contact.website}`);
        if (cl.length)
            lines.push(`   ${cl.join("  ·  ")}`);
    }
    return lines.join("\n");
}
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
// Cleanup stale sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastActivity > SESSION_TTL_MS) {
            session.transport.close?.();
            sessions.delete(id);
        }
    }
}, 5 * 60 * 1000);
async function getOrCreateSession(sessionId) {
    if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        session.lastActivity = Date.now();
        return { id: sessionId, session };
    }
    // Create new session
    const id = sessionId || (0, crypto_1.randomUUID)();
    const server = new mcp_js_1.McpServer({ name: "lokal", version: "0.3.0" });
    registerTools(server);
    const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
    });
    await server.connect(transport);
    const session = { transport, server, lastActivity: Date.now() };
    sessions.set(id, session);
    return { id, session };
}
// ─── Routes ─────────────────────────────────────────────────
// POST /mcp — Main MCP message handler (JSON-RPC over HTTP)
router.post("/", async (req, res) => {
    try {
        const sessionId = req.headers["mcp-session-id"];
        const { session } = await getOrCreateSession(sessionId);
        await session.transport.handleRequest(req, res, req.body);
    }
    catch (err) {
        console.error("MCP POST error:", err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: "MCP transport error" });
        }
    }
});
// GET /mcp — SSE stream for server-to-client notifications
router.get("/", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({ error: "Missing or invalid mcp-session-id header" });
        return;
    }
    const session = sessions.get(sessionId);
    session.lastActivity = Date.now();
    await session.transport.handleRequest(req, res, req.body);
});
// DELETE /mcp — Session cleanup
router.delete("/", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        session.transport.close?.();
        sessions.delete(sessionId);
    }
    res.status(200).json({ ok: true });
});
exports.default = router;
//# sourceMappingURL=mcp.js.map