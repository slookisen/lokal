"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const services_1 = require("../services");
const marketplace_registry_1 = require("../services/marketplace-registry");
const marketplace_1 = require("../models/marketplace");
const interaction_logger_1 = require("../services/interaction-logger");
const conversation_service_1 = require("../services/conversation-service");
const discovery_service_1 = require("../services/discovery-service");
const knowledge_service_1 = require("../services/knowledge-service");
// ─── A2A Routes ──────────────────────────────────────────────
// Two protocols served here:
//   1. REST endpoints (for humans/dashboards)
//   2. JSON-RPC 2.0 at /a2a (for agent-to-agent — A2A spec)
//
// Why both? A2A mandates JSON-RPC, but dashboards need REST.
// The hybrid approach means we're both human-friendly AND
// agent-compatible. No one else in the food space does this.
const router = (0, express_1.Router)();
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
// ═══════════════════════════════════════════════════════════════
// JSON-RPC 2.0 ENDPOINT (Gap 3 fix)
// This is what makes us A2A-compatible.
//
// Consumer agents send:
//   POST /a2a
//   {"jsonrpc":"2.0","method":"message/send","params":{...},"id":"1"}
//
// We respond with standard JSON-RPC results.
// ═══════════════════════════════════════════════════════════════
router.post("/a2a", (req, res) => {
    const { jsonrpc, method, params, id } = req.body;
    // Validate JSON-RPC envelope
    if (jsonrpc !== "2.0" || !method || id === undefined) {
        res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32600, message: "Invalid Request: must include jsonrpc:'2.0', method, and id" },
            id: id || null,
        });
        return;
    }
    try {
        switch (method) {
            case "message/send":
                handleMessageSend(params, id, req, res);
                break;
            case "tasks/get":
                handleTasksGet(params, id, res);
                break;
            case "tasks/list":
                handleTasksList(params, id, res);
                break;
            case "agent/authenticatedExtendedCard":
                handleExtendedCard(params, id, req, res);
                break;
            case "agent/info":
                handleAgentInfo(params, id, res);
                break;
            default:
                res.json({
                    jsonrpc: "2.0",
                    error: { code: -32601, message: `Method not found: ${method}` },
                    id,
                });
        }
    }
    catch (err) {
        res.json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error", data: err.message },
            id,
        });
    }
});
// ─── message/send ────────────────────────────────────────────
// The primary A2A interaction method.
// Consumer agent sends a message, we process it and return results.
//
// Two modes:
//   1. Natural language: { message: { text: "finn grønnsaker..." } }
//   2. Structured:       { message: { data: { categories: [...] } } }
//
// Returns a task with results (or "working" status for async).
function handleMessageSend(params, id, req, res) {
    const message = params?.message;
    if (!message) {
        res.json({
            jsonrpc: "2.0",
            error: { code: -32602, message: "Invalid params: 'message' required" },
            id,
        });
        return;
    }
    // Create a task for lifecycle tracking
    const task = marketplace_registry_1.marketplaceRegistry.createTask("message/send", params, params?.agentId);
    let discoveryQuery;
    // Extract text from various A2A message formats
    // The A2A spec uses { role, parts: [{ type: "text", text: "..." }] }
    // but agents may also send { text: "..." } or just a string.
    const extractText = (msg) => {
        if (typeof msg === "string")
            return msg;
        if (msg.text)
            return msg.text;
        if (msg.parts && Array.isArray(msg.parts)) {
            const textPart = msg.parts.find((p) => p.type === "text" && p.text);
            if (textPart)
                return textPart.text;
        }
        return null;
    };
    const messageText = extractText(message);
    // Mode 1: Natural language search (flat text, parts array, or string)
    if (messageText) {
        discoveryQuery = marketplace_registry_1.marketplaceRegistry.parseNaturalQuery(messageText);
    }
    // Mode 2: Structured discovery query
    else if (message.data) {
        discoveryQuery = message.data;
    }
    // Mode 3: Treat entire params as query
    else {
        discoveryQuery = params;
    }
    // Execute discovery
    const startTime = Date.now();
    try {
        const query = marketplace_1.DiscoveryQuerySchema.parse({
            ...discoveryQuery,
            limit: discoveryQuery.limit || 20,
            offset: discoveryQuery.offset || 0,
        });
        const results = marketplace_registry_1.marketplaceRegistry.discover(query);
        const durationMs = Date.now() - startTime;
        // Complete the task with results
        const completedTask = marketplace_registry_1.marketplaceRegistry.updateTask(task.id, "completed", {
            type: "discovery",
            count: results.length,
            agents: results,
        });
        // Log the interaction (this powers the live dashboard)
        const queryText = messageText || JSON.stringify(discoveryQuery);
        interaction_logger_1.interactionLogger.log("search", {
            agentId: params?.agentId,
            query: typeof queryText === "string" ? queryText : JSON.stringify(queryText),
            resultCount: results.length,
            matchedAgentIds: results.map(r => r.agent.id),
            metadata: {
                taskId: task.id,
                parsedQuery: messageText ? marketplace_registry_1.marketplaceRegistry.parseNaturalQuery(messageText) : discoveryQuery,
                method: "message/send",
            },
            ipAddress: req.ip,
            durationMs,
        });
        // ─── Auto-start conversations with top matches ────────────
        // When an A2A agent searches, we create conversations with
        // the best matches so seller agents can auto-respond.
        // This makes the system "alive" — every search creates dialog.
        const conversations = [];
        const topResults = results.slice(0, 3); // Top 3 matches get conversations
        for (const r of topResults) {
            try {
                const conv = conversation_service_1.conversationService.startConversation({
                    buyerAgentId: params?.agentId || undefined,
                    sellerAgentId: r.agent.id,
                    queryText: typeof queryText === "string" ? queryText : JSON.stringify(queryText),
                    taskId: task.id,
                    source: "a2a",
                    autoRespond: true, // Seller agent auto-replies
                });
                conversations.push({
                    conversationId: conv.id,
                    sellerAgentId: r.agent.id,
                    sellerAgentName: conv.sellerAgentName,
                    status: conv.status,
                    messageCount: conv.messages.length,
                    viewUrl: `${BASE_URL}/samtale/${conv.id}`,
                });
            }
            catch { /* non-critical — don't break search if conv fails */ }
        }
        // A2A response format — now includes conversation links
        res.json({
            jsonrpc: "2.0",
            result: {
                task: {
                    id: task.id,
                    status: "completed",
                },
                artifacts: [
                    {
                        type: "application/json",
                        data: {
                            count: results.length,
                            agents: results,
                            conversations,
                            parsedQuery: messageText ? marketplace_registry_1.marketplaceRegistry.parseNaturalQuery(messageText) : discoveryQuery,
                        },
                    },
                ],
            },
            id,
        });
    }
    catch (err) {
        marketplace_registry_1.marketplaceRegistry.updateTask(task.id, "failed", null, err.message);
        res.json({
            jsonrpc: "2.0",
            error: { code: -32602, message: "Invalid discovery query", data: err.message },
            id,
        });
    }
}
// ─── tasks/get ───────────────────────────────────────────────
// Check the status of a previously submitted task.
// Part of the A2A task lifecycle (Gap 7 fix).
function handleTasksGet(params, id, res) {
    const taskId = params?.taskId || params?.id;
    if (!taskId) {
        res.json({
            jsonrpc: "2.0",
            error: { code: -32602, message: "Invalid params: 'taskId' required" },
            id,
        });
        return;
    }
    const task = marketplace_registry_1.marketplaceRegistry.getTask(taskId);
    if (!task) {
        res.json({
            jsonrpc: "2.0",
            error: { code: -32602, message: `Task not found: ${taskId}` },
            id,
        });
        return;
    }
    res.json({
        jsonrpc: "2.0",
        result: { task },
        id,
    });
}
// ─── tasks/list ──────────────────────────────────────────────
// List tasks for a given consumer agent.
function handleTasksList(params, id, res) {
    const tasks = marketplace_registry_1.marketplaceRegistry.listTasks(params?.agentId, params?.status);
    res.json({
        jsonrpc: "2.0",
        result: { tasks },
        id,
    });
}
// ─── agent/authenticatedExtendedCard ─────────────────────────
// Returns the full registry card with live inventory stats.
// Authenticated: requires API key for extended data.
function handleExtendedCard(params, id, req, res) {
    const registryCard = marketplace_registry_1.marketplaceRegistry.getRegistryCard(BASE_URL);
    const stats = marketplace_registry_1.marketplaceRegistry.getStats();
    res.json({
        jsonrpc: "2.0",
        result: {
            card: registryCard,
            liveStats: stats,
        },
        id,
    });
}
// ─── agent/info ──────────────────────────────────────────────
// Buyer agent asks: "tell me about this seller"
// Returns structured knowledge — address, products, hours, etc.
// This is the core of the dummy-agent system: every seller has
// an agent that can answer based on what we know about them.
function handleAgentInfo(params, id, res) {
    const agentId = params?.agentId;
    if (!agentId) {
        res.json({
            jsonrpc: "2.0",
            error: { code: -32602, message: "Invalid params: 'agentId' required" },
            id,
        });
        return;
    }
    const info = knowledge_service_1.knowledgeService.getAgentInfo(agentId);
    if (!info) {
        res.json({
            jsonrpc: "2.0",
            error: { code: -32602, message: `Agent not found: ${agentId}` },
            id,
        });
        return;
    }
    // Log the interaction
    interaction_logger_1.interactionLogger.log("view", {
        agentId,
        metadata: { type: "a2a_agent_info", buyerAgent: params?.buyerAgentId },
    });
    res.json({
        jsonrpc: "2.0",
        result: {
            task: { id: `info-${agentId}`, status: "completed" },
            artifacts: [{
                    type: "application/json",
                    data: info,
                }],
        },
        id,
    });
}
// ═══════════════════════════════════════════════════════════════
// REST ENDPOINTS (backward compat + human use)
// ═══════════════════════════════════════════════════════════════
// GET /.well-known/agent-card.json — A2A Agent Card discovery (spec v1.0.0 compliant)
// The official A2A spec requires agent-card.json, not agent.json.
// We serve both paths: the correct one and the legacy one for backward compat.
function serveAgentCard(_req, res) {
    const registryCard = marketplace_registry_1.marketplaceRegistry.getRegistryCard(BASE_URL);
    const legacyProducers = services_1.agentCardService.generateRegistry(BASE_URL);
    const card = {
        ...registryCard,
        producers: legacyProducers,
        endpoints: {
            jsonrpc: `${BASE_URL}/a2a`,
            discover: `${BASE_URL}/api/marketplace/discover`,
            search: `${BASE_URL}/api/marketplace/search`,
            register: `${BASE_URL}/api/marketplace/register`,
            agents: `${BASE_URL}/api/marketplace/agents`,
            mcp: `${BASE_URL}/mcp`,
            llms: `${BASE_URL}/llms.txt`,
            openapi: `${BASE_URL}/openapi.json`,
        },
    };
    // A2A spec recommends caching headers: Cache-Control + ETag
    const etag = `"v1-${Date.now().toString(36)}"`;
    res.header("Cache-Control", "public, max-age=3600");
    res.header("ETag", etag);
    res.json(card);
}
router.get("/.well-known/agent-card.json", serveAgentCard); // A2A spec v1.0.0
router.get("/.well-known/agent.json", serveAgentCard); // Legacy compat
// GET /agents/:id/agent.json — Individual producer Agent Card (enriched with knowledge)
router.get("/agents/:id/agent.json", (req, res) => {
    const card = services_1.agentCardService.generateCard(req.params.id, BASE_URL);
    if (!card) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    // Enrich with knowledge data so buyer-agents get the full picture
    const knowledge = knowledge_service_1.knowledgeService.getKnowledge(req.params.id);
    if (knowledge) {
        const enriched = { ...card };
        enriched["x-knowledge"] = {
            address: knowledge.address,
            postalCode: knowledge.postalCode,
            phone: knowledge.phone,
            email: knowledge.email,
            website: knowledge.website,
            openingHours: knowledge.openingHours,
            products: knowledge.products?.map((p) => ({
                name: p.name, category: p.category, seasonal: p.seasonal, months: p.months, organic: p.organic,
            })),
            specialties: knowledge.specialties,
            certifications: knowledge.certifications,
            paymentMethods: knowledge.paymentMethods,
            deliveryOptions: knowledge.deliveryOptions,
            deliveryRadius: knowledge.deliveryRadius,
            googleRating: knowledge.googleRating,
            googleReviewCount: knowledge.googleReviewCount,
            externalLinks: knowledge.externalLinks,
            seasonality: knowledge.seasonality,
            about: knowledge.about,
            dataSource: knowledge.dataSource,
            lastEnrichedAt: knowledge.lastEnrichedAt,
        };
        // Remove undefined values
        const xk = enriched["x-knowledge"];
        for (const key of Object.keys(xk)) {
            if (xk[key] === undefined || xk[key] === null)
                delete xk[key];
        }
        res.header("Cache-Control", "public, max-age=1800");
        res.json(enriched);
        return;
    }
    res.header("Cache-Control", "public, max-age=1800");
    res.json(card);
});
// GET /api/stats — Platform stats (combined)
router.get("/api/stats", (_req, res) => {
    const legacyStats = services_1.store.getStats();
    const registryStats = marketplace_registry_1.marketplaceRegistry.getStats();
    res.json({
        success: true,
        data: {
            ...legacyStats,
            registry: registryStats,
        },
    });
});
// GET /api/discovery — Discovery status and metadata
router.get("/api/discovery", (_req, res) => {
    res.json({
        success: true,
        data: {
            agentCardUrl: `${BASE_URL}/.well-known/agent-card.json`,
            a2aEndpoint: `${BASE_URL}/a2a`,
            registries: discovery_service_1.discoveryService.getRegistryStatus(),
            metadata: discovery_service_1.discoveryService.getDiscoveryMetadata(),
        },
    });
});
// ═══════════════════════════════════════════════════════════════
// SSE LIVE FEED — Real-time interaction stream
// Connect with EventSource("/api/live") in the dashboard
// ═══════════════════════════════════════════════════════════════
const sseClients = new Set();
router.get("/api/live", (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    });
    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
});
// Forward interactions and messages to SSE clients
interaction_logger_1.interactionLogger.on("interaction", (event) => {
    const data = JSON.stringify({ eventType: "interaction", ...event });
    for (const client of sseClients) {
        try {
            client.write(`data: ${data}\n\n`);
        }
        catch {
            sseClients.delete(client);
        }
    }
});
interaction_logger_1.interactionLogger.on("message", (msg) => {
    const data = JSON.stringify({ type: "conversation_message", ...msg });
    for (const client of sseClients) {
        try {
            client.write(`data: ${data}\n\n`);
        }
        catch {
            sseClients.delete(client);
        }
    }
});
// ═══════════════════════════════════════════════════════════════
// INTERACTION & CONVERSATION API
// ═══════════════════════════════════════════════════════════════
// GET /api/interactions — Recent interactions
router.get("/api/interactions", (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const interactions = interaction_logger_1.interactionLogger.getRecent(limit);
    res.json({ success: true, data: interactions, count: interactions.length });
});
// GET /api/interactions/stats — Interaction statistics
router.get("/api/interactions/stats", (_req, res) => {
    const stats = interaction_logger_1.interactionLogger.getStats();
    res.json({ success: true, data: stats });
});
// POST /api/conversations — Start a new conversation
router.post("/api/conversations", (req, res) => {
    const { buyerAgentId, sellerAgentId, queryText } = req.body;
    if (!sellerAgentId) {
        res.status(400).json({ success: false, error: "sellerAgentId required" });
        return;
    }
    const conversation = conversation_service_1.conversationService.startConversation({
        buyerAgentId, sellerAgentId, queryText,
    });
    res.json({ success: true, data: conversation });
});
// GET /api/conversations — List conversations
router.get("/api/conversations", (req, res) => {
    const conversations = conversation_service_1.conversationService.listConversations({
        limit: parseInt(req.query.limit) || 50,
        status: req.query.status || undefined,
        agentId: req.query.agentId || undefined,
    });
    res.json({ success: true, data: conversations, count: conversations.length });
});
// GET /api/conversations/:id — Get single conversation with messages
router.get("/api/conversations/:id", (req, res) => {
    const conversation = conversation_service_1.conversationService.getConversation(req.params.id);
    if (!conversation) {
        res.status(404).json({ success: false, error: "Conversation not found" });
        return;
    }
    res.json({ success: true, data: conversation });
});
// POST /api/conversations/:id/messages — Add message to conversation
router.post("/api/conversations/:id/messages", (req, res) => {
    const { senderRole, senderAgentId, content, messageType, metadata } = req.body;
    if (!content || !senderRole) {
        res.status(400).json({ success: false, error: "content and senderRole required" });
        return;
    }
    const message = conversation_service_1.conversationService.addMessage({
        conversationId: req.params.id,
        senderRole, senderAgentId, content,
        messageType: messageType || "text",
        metadata: metadata || {},
    });
    res.json({ success: true, data: message });
});
// POST /api/conversations/:id/complete — Mark transaction as completed
router.post("/api/conversations/:id/complete", (req, res) => {
    try {
        const conversation = conversation_service_1.conversationService.completeTransaction(req.params.id, {
            totalAmountNok: req.body.totalAmountNok,
            products: req.body.products,
        });
        res.json({ success: true, data: conversation });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// ═══════════════════════════════════════════════════════════════
// SELLER METRICS & SOCIAL PROOF
// ═══════════════════════════════════════════════════════════════
// GET /api/agents/:id/metrics — Seller dashboard data
router.get("/api/agents/:id/metrics", (req, res) => {
    const metrics = conversation_service_1.conversationService.getAgentMetrics(req.params.id);
    res.json({ success: true, data: metrics });
});
// GET /api/leaderboard — Top sellers (social proof)
router.get("/api/leaderboard", (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    const leaderboard = conversation_service_1.conversationService.getLeaderboard(limit);
    res.json({ success: true, data: leaderboard });
});
exports.default = router;
//# sourceMappingURL=a2a.js.map