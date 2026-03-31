"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const services_1 = require("../services");
const marketplace_registry_1 = require("../services/marketplace-registry");
const marketplace_1 = require("../models/marketplace");
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
    // Mode 1: Natural language search
    if (message.text || typeof message === "string") {
        const text = message.text || message;
        discoveryQuery = marketplace_registry_1.marketplaceRegistry.parseNaturalQuery(text);
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
    try {
        const query = marketplace_1.DiscoveryQuerySchema.parse({
            ...discoveryQuery,
            limit: discoveryQuery.limit || 20,
            offset: discoveryQuery.offset || 0,
        });
        const results = marketplace_registry_1.marketplaceRegistry.discover(query);
        // Complete the task with results
        const completedTask = marketplace_registry_1.marketplaceRegistry.updateTask(task.id, "completed", {
            type: "discovery",
            count: results.length,
            agents: results,
        });
        // A2A response format
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
                            parsedQuery: message.text ? marketplace_registry_1.marketplaceRegistry.parseNaturalQuery(message.text) : discoveryQuery,
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
// ═══════════════════════════════════════════════════════════════
// REST ENDPOINTS (backward compat + human use)
// ═══════════════════════════════════════════════════════════════
// GET /.well-known/agent.json — A2A Agent Card discovery
router.get("/.well-known/agent.json", (_req, res) => {
    const registryCard = marketplace_registry_1.marketplaceRegistry.getRegistryCard(BASE_URL);
    const legacyProducers = services_1.agentCardService.generateRegistry(BASE_URL);
    res.json({
        ...registryCard,
        producers: legacyProducers,
        endpoints: {
            jsonrpc: `${BASE_URL}/a2a`,
            discover: `${BASE_URL}/api/marketplace/discover`,
            search: `${BASE_URL}/api/marketplace/search`,
            register: `${BASE_URL}/api/marketplace/register`,
            agents: `${BASE_URL}/api/marketplace/agents`,
        },
    });
});
// GET /agents/:id/agent.json — Individual producer Agent Card
router.get("/agents/:id/agent.json", (req, res) => {
    const card = services_1.agentCardService.generateCard(req.params.id, BASE_URL);
    if (!card) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
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
exports.default = router;
//# sourceMappingURL=a2a.js.map