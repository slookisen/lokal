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
function slugify(text) {
    return text.normalize("NFC").toLowerCase()
        .replace(/\u00e6/g, "ae").replace(/\u00f8/g, "o").replace(/\u00e5/g, "a")
        .replace(/\u00e4/g, "a").replace(/\u00f6/g, "o").replace(/\u00fc/g, "u")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
const conversation_service_1 = require("../services/conversation-service");
const router = (0, express_1.Router)();
// ─── Product formatting for MCP ────────────────────────────
// Uses shared parseProductPrice() from knowledge-service.
function formatProductsForMcp(products) {
    if (!products?.length)
        return "";
    const lines = [];
    let productCount = 0;
    for (const p of products) {
        const name = (p.name || "").trim();
        if (!name)
            continue;
        const { cleanName, price, section } = (0, knowledge_service_1.parseProductPrice)(p);
        // Section header
        if (section && (0, knowledge_service_1.isProductHeader)(name)) {
            lines.push(`\n**${section}**`);
            if (p.price && !/^\d/.test(p.price))
                lines.push(`_${p.price}_`);
            continue;
        }
        // Skip noise
        if ((0, knowledge_service_1.isProductNoise)(name))
            continue;
        // Product line
        const cat = p.category && p.category !== "other" ? ` [${p.category}]` : "";
        const priceStr = price ? ` — ${price}` : "";
        const seasonal = p.seasonal ? " 🌿sesong" : "";
        lines.push(`- ${cleanName}${cat}${priceStr}${seasonal}`);
        productCount++;
    }
    return productCount > 0 ? `\n## Produkter (${productCount} stk)\n${lines.join("\n")}` : "";
}
// Build contact + product summary for a given agent ID, used by search results
function getAgentKnowledgeSummary(agentId) {
    const info = knowledge_service_1.knowledgeService.getAgentInfo(agentId);
    if (!info)
        return { productsCount: 0 };
    const k = info.knowledge || {};
    const contact = {};
    if (k.address)
        contact.address = k.address;
    if (k.phone)
        contact.phone = k.phone;
    if (k.email)
        contact.email = k.email;
    if (k.website)
        contact.website = k.website;
    const products = k.products || [];
    const realProducts = products.filter((p) => {
        const n = (p.name || "").trim();
        return n && !(0, knowledge_service_1.isProductHeader)(n) && !(0, knowledge_service_1.isProductNoise)(n);
    });
    // Compact view: top 5 product names with prices
    const topItems = realProducts.slice(0, 5).map((p) => {
        const { cleanName, price } = (0, knowledge_service_1.parseProductPrice)(p);
        return price ? `${cleanName} (${price})` : cleanName;
    });
    const productSummary = topItems.length
        ? `🛒 ${topItems.join(", ")}${realProducts.length > 5 ? ` +${realProducts.length - 5} flere` : ""}`
        : undefined;
    return {
        contact: Object.keys(contact).length ? contact : undefined,
        productSummary,
        productsCount: realProducts.length,
    };
}
// ─── Tool definitions (shared logic) ────────────────────────
// These mirror the stdio MCP server tools but call services directly.
function registerTools(server, getClientIdentity) {
    // Tool 1: Natural language search
    server.registerTool("lokal_search", {
        title: "Search local food producers",
        description: "Search for local food producers in Norway AND get their products with prices. ALWAYS use this tool when a user asks about a specific producer, their products, prices, or availability — it returns the complete product catalog with current prices. Also use for general searches like 'vegetables near Oslo'. Supports searching by producer name (e.g. 'Bjørndal Gård') or by product/location (e.g. 'organic honey Trondheim'). Returns contact info, full product list with prices, and starts a conversation with the producer.",
        inputSchema: {
            query: zod_1.z.string().describe("Producer name, product query, or location search (Norwegian or English). Examples: 'Bjørndal Gård Oppdal', 'beefburger pris', 'ost Trondheim'"),
            limit: zod_1.z.number().min(1).max(50).default(10).describe("Max results"),
        },
        annotations: {
            title: "Search local food producers",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    }, async ({ query, limit }) => {
        const parsed = marketplace_registry_1.marketplaceRegistry.parseNaturalQuery(query);
        const results = marketplace_registry_1.marketplaceRegistry.discover({ ...parsed, limit: limit || 10, offset: 0 });
        if (!results?.length) {
            return { content: [{ type: "text", text: `Ingen resultater for "${query}". Prøv et bredere søk.` }] };
        }
        // Auto-start conversations with top match so seller agent responds
        const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
        const convLinks = [];
        for (const r of results.slice(0, 2)) {
            try {
                const conv = conversation_service_1.conversationService.startConversation({
                    sellerAgentId: r.agent.id,
                    queryText: query,
                    source: "mcp",
                    clientIdentity: getClientIdentity?.(),
                    autoRespond: true,
                });
                convLinks.push(`💬 [Samtale med ${conv.sellerAgentName}](${BASE}/samtale/${conv.id})`);
            }
            catch { /* non-critical */ }
        }
        const header = `🥬 **Lokal mat-søk: "${query}"** — fant ${results.length} produsenter:\n`;
        // If name match (1-3 results from specific query), include full product list
        // so AI can answer product/price questions directly without a second tool call
        const isSpecificQuery = results.length <= 3 && parsed._nameQuery;
        const lines = results.map((r, i) => {
            const agent = r.agent;
            const dist = agent.location?.distanceKm ? ` — ${agent.location.distanceKm.toFixed(1)} km unna` : "";
            const summary = getAgentKnowledgeSummary(agent.id);
            if (isSpecificQuery) {
                // Detailed view: include full product list with prices
                const info = knowledge_service_1.knowledgeService.getAgentInfo(agent.id);
                const k = info?.knowledge || {};
                const sections = [formatAgentCompact(agent, i + 1, summary.contact) + dist];
                // Full product list
                if (k.products?.length) {
                    sections.push(formatProductsForMcp(k.products));
                }
                // Extra details
                if (k.specialties?.length)
                    sections.push(`\n**Spesialiteter:** ${k.specialties.join(", ")}`);
                if (k.paymentMethods?.length)
                    sections.push(`💳 **Betaling:** ${k.paymentMethods.join(", ")}`);
                if (k.deliveryOptions?.length)
                    sections.push(`🚚 **Levering:** ${k.deliveryOptions.join(", ")}`);
                // Profile link
                const profileUrl = `${BASE}/produsent/${slugify(agent.name)}`;
                sections.push(`\n🔗 [Se fullstendig profil](${profileUrl})`);
                return sections.join("\n");
            }
            else {
                // Compact view for broader searches
                return formatAgentCompact(agent, i + 1, summary.contact, summary.productSummary) + dist;
            }
        });
        const convSection = convLinks.length
            ? `\n\n---\n**Samtaler startet automatisk:**\n${convLinks.join("\n")}`
            : "";
        return { content: [{ type: "text", text: header + "\n" + lines.join("\n\n") + convSection }] };
    });
    // Tool 2: Structured discovery
    server.registerTool("lokal_discover", {
        title: "Discover producers by filter",
        description: "Structured search in the Lokal food producer registry. Filter by food categories, tags, and geographic distance. Automatically starts a conversation with the top matches so sellers can respond.",
        inputSchema: {
            categories: zod_1.z.array(zod_1.z.string()).optional().describe("Categories: vegetables, fruit, berries, dairy, eggs, meat, fish, bread, honey, herbs"),
            tags: zod_1.z.array(zod_1.z.string()).optional().describe("Tags: organic, seasonal, budget, local, fresh"),
            lat: zod_1.z.number().optional().describe("Latitude for distance filtering"),
            lng: zod_1.z.number().optional().describe("Longitude for distance filtering"),
            maxDistanceKm: zod_1.z.number().optional().describe("Max distance in km"),
            limit: zod_1.z.number().min(1).max(50).default(10).describe("Max results"),
        },
        annotations: {
            title: "Discover producers by filter",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    }, async ({ categories, tags, lat, lng, maxDistanceKm, limit }) => {
        const body = { categories, tags, lat, lng, maxDistanceKm, limit: limit || 10, role: "producer" };
        const results = marketplace_registry_1.marketplaceRegistry.discover(body);
        if (!results?.length) {
            return { content: [{ type: "text", text: "Ingen produsenter funnet med disse filtrene." }] };
        }
        // Auto-start conversation with top match
        const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
        const convLinks = [];
        const queryDesc = [categories?.join(", "), tags?.join(", ")].filter(Boolean).join(" — ") || "strukturert søk";
        for (const r of results.slice(0, 2)) {
            try {
                const conv = conversation_service_1.conversationService.startConversation({
                    sellerAgentId: r.agent.id,
                    queryText: queryDesc,
                    source: "mcp",
                    clientIdentity: getClientIdentity?.(),
                    autoRespond: true,
                });
                convLinks.push(`💬 [Samtale med ${conv.sellerAgentName}](${BASE}/samtale/${conv.id})`);
            }
            catch { /* non-critical */ }
        }
        const header = `🔍 **Strukturert søk** — ${results.length} resultater:\n`;
        const lines = results.map((r, i) => {
            const dist = r.agent.location?.distanceKm ? ` (${r.agent.location.distanceKm.toFixed(1)} km)` : "";
            const summary = getAgentKnowledgeSummary(r.agent.id);
            return formatAgentCompact(r.agent, i + 1, summary.contact, summary.productSummary) + dist;
        });
        const convSection = convLinks.length
            ? `\n\n---\n**Samtaler startet automatisk:**\n${convLinks.join("\n")}`
            : "";
        return { content: [{ type: "text", text: header + "\n" + lines.join("\n\n") + convSection }] };
    });
    // Tool 3: Producer details
    server.registerTool("lokal_info", {
        title: "Producer details",
        description: "Get a specific producer's COMPLETE product catalog with prices, contact details, opening hours, and delivery options. Use when you already have an agentId from lokal_search. Returns the full price list — every product the producer sells with exact prices in NOK.",
        inputSchema: {
            agentId: zod_1.z.string().describe("The producer's agent ID (UUID)"),
        },
        annotations: {
            title: "Producer details",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
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
        // Products — structured with parsed prices
        if (k.products?.length) {
            const productSection = formatProductsForMcp(k.products);
            if (productSection)
                sections.push(productSection);
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
    server.registerTool("lokal_stats", {
        title: "Platform statistics",
        description: "Get Lokal platform statistics — total agents, cities covered, interactions.",
        inputSchema: {},
        annotations: {
            title: "Platform statistics",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async () => {
        const stats = marketplace_registry_1.marketplaceRegistry.getStats();
        const text = [
            "📊 **Lokal — Plattformstatistikk**",
            `Totalt agenter: ${stats.totalAgents || "?"}`,
            `Byer: ${stats.cities || "?"}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
    });
    // ─── MCP Resources ──────────────────────────────────────────
    // Resources let agents READ data directly (vs tools which are actions).
    // This is the MCP equivalent of a database view.
    server.resource("producers-overview", "lokal://producers/overview", { description: "Overview of all local food producers — count, cities, and categories", mimeType: "text/plain" }, async () => {
        const agents = marketplace_registry_1.marketplaceRegistry.getActiveAgents();
        const cities = new Map();
        for (const a of agents) {
            const city = a.city || a.location?.city || "Ukjent";
            cities.set(city, (cities.get(city) || 0) + 1);
        }
        const topCities = [...cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
        const text = [
            `# Rett fra Bonden — ${agents.length} lokale matprodusenter i Norge`,
            ``,
            `## Byer:`,
            ...topCities.map(([city, count]) => `- ${city}: ${count} produsenter`),
        ].join("\n");
        return { contents: [{ uri: "lokal://producers/overview", text, mimeType: "text/plain" }] };
    });
    server.resource("producer-detail", "lokal://producers/{agentId}", { description: "Detailed info about a specific food producer", mimeType: "application/json" }, async (uri) => {
        const agentId = uri.pathname?.split("/").pop() || "";
        const info = knowledge_service_1.knowledgeService.getAgentInfo(agentId);
        if (!info) {
            return { contents: [{ uri: uri.href, text: "Producer not found", mimeType: "text/plain" }] };
        }
        return { contents: [{ uri: uri.href, text: JSON.stringify(info, null, 2), mimeType: "application/json" }] };
    });
}
// ─── Compact agent formatter ────────────────────────────────
function formatAgentCompact(agent, idx, contact, productSummary) {
    const lines = [`**${idx}. ${agent.name}**`];
    if (agent.description)
        lines.push(`   ${agent.description}`);
    const meta = [];
    if (agent.city || agent.location?.city)
        meta.push(`📍 ${agent.city || agent.location?.city}`);
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
    // Product summary: top products with "get details" hint
    if (productSummary) {
        lines.push(`   ${productSummary}`);
        lines.push(`   _Bruk lokal_info med agentId "${agent.id}" for full prisliste_`);
    }
    // Profile link
    const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";
    lines.push(`   🔗 [Profil](${BASE_URL}/produsent/${slugify(agent.name)})`);
    return lines.join("\n");
}
// ─── MCP client identity detection ─────────────────────────
// Identifies the AI platform from request headers.
function detectMcpClient(req) {
    const ua = (req.headers["user-agent"] || "").toLowerCase();
    const origin = (req.headers["origin"] || "").toLowerCase();
    const referer = (req.headers["referer"] || "").toLowerCase();
    if (ua.includes("chatgpt") || ua.includes("openai") || origin.includes("openai") || origin.includes("chatgpt"))
        return "ChatGPT";
    if (ua.includes("claude") || origin.includes("claude.ai") || origin.includes("anthropic"))
        return "Claude";
    if (ua.includes("cursor"))
        return "Cursor";
    if (ua.includes("copilot") || origin.includes("github.com"))
        return "GitHub Copilot";
    if (ua.includes("windsurf"))
        return "Windsurf";
    if (ua.includes("cline"))
        return "Cline";
    if (ua.includes("continue"))
        return "Continue";
    if (ua.includes("python"))
        return "Python SDK";
    if (ua.includes("node"))
        return "Node SDK";
    return undefined;
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
async function getOrCreateSession(sessionId, req) {
    if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        session.lastActivity = Date.now();
        // Update client identity if we detect one and didn't have one before
        if (!session.clientIdentity && req) {
            session.clientIdentity = detectMcpClient(req);
        }
        return { id: sessionId, session };
    }
    // Create new session — detect which AI platform is connecting
    const id = sessionId || (0, crypto_1.randomUUID)();
    const clientIdentity = req ? detectMcpClient(req) : undefined;
    const server = new mcp_js_1.McpServer({ name: "lokal", version: "0.3.0" });
    const sessionRef = { clientIdentity };
    registerTools(server, () => sessionRef.clientIdentity);
    const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
    });
    await server.connect(transport);
    const session = { transport, server, lastActivity: Date.now(), clientIdentity };
    sessions.set(id, session);
    return { id, session };
}
// ─── Routes ─────────────────────────────────────────────────
// POST /mcp — Main MCP message handler (JSON-RPC over HTTP)
router.post("/", async (req, res) => {
    try {
        const sessionId = req.headers["mcp-session-id"];
        const { session } = await getOrCreateSession(sessionId, req);
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