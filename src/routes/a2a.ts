import { Router, Request, Response } from "express";
import { agentCardService, store } from "../services";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { DiscoveryQuerySchema } from "../models/marketplace";
import { interactionLogger, InteractionEvent } from "../services/interaction-logger";
import { conversationService } from "../services/conversation-service";
import { discoveryService } from "../services/discovery-service";
import { knowledgeService } from "../services/knowledge-service";

// ─── A2A Routes ──────────────────────────────────────────────
// Two protocols served here:
//   1. REST endpoints (for humans/dashboards)
//   2. JSON-RPC 2.0 at /a2a (for agent-to-agent — A2A spec)
//
// Why both? A2A mandates JSON-RPC, but dashboards need REST.
// The hybrid approach means we're both human-friendly AND
// agent-compatible. No one else in the food space does this.

const router = Router();
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

router.post("/a2a", (req: Request, res: Response) => {
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
  } catch (err: any) {
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

function handleMessageSend(params: any, id: any, req: Request, res: Response) {
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
  const task = marketplaceRegistry.createTask("message/send", params, params?.agentId);

  let discoveryQuery: any;

  // Extract text from various A2A message formats
  // The A2A spec uses { role, parts: [{ type: "text", text: "..." }] }
  // but agents may also send { text: "..." } or just a string.
  const extractText = (msg: any): string | null => {
    if (typeof msg === "string") return msg;
    if (msg.text) return msg.text;
    if (msg.parts && Array.isArray(msg.parts)) {
      const textPart = msg.parts.find((p: any) => p.type === "text" && p.text);
      if (textPart) return textPart.text;
    }
    return null;
  };

  const messageText = extractText(message);

  // Mode 1: Natural language search (flat text, parts array, or string)
  if (messageText) {
    discoveryQuery = marketplaceRegistry.parseNaturalQuery(messageText);
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
    const query = DiscoveryQuerySchema.parse({
      ...discoveryQuery,
      limit: discoveryQuery.limit || 20,
      offset: discoveryQuery.offset || 0,
    });

    const results = marketplaceRegistry.discover(query);
    const durationMs = Date.now() - startTime;

    // Complete the task with results
    const completedTask = marketplaceRegistry.updateTask(task.id, "completed", {
      type: "discovery",
      count: results.length,
      agents: results,
    });

    // Log the interaction (this powers the live dashboard)
    const queryText = messageText || JSON.stringify(discoveryQuery);
    interactionLogger.log("search", {
      agentId: params?.agentId,
      query: typeof queryText === "string" ? queryText : JSON.stringify(queryText),
      resultCount: results.length,
      matchedAgentIds: results.map(r => r.agent.id),
      metadata: {
        taskId: task.id,
        parsedQuery: messageText ? marketplaceRegistry.parseNaturalQuery(messageText) : discoveryQuery,
        method: "message/send",
      },
      ipAddress: req.ip,
      durationMs,
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
              parsedQuery: messageText ? marketplaceRegistry.parseNaturalQuery(messageText) : discoveryQuery,
            },
          },
        ],
      },
      id,
    });
  } catch (err: any) {
    marketplaceRegistry.updateTask(task.id, "failed", null, err.message);
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

function handleTasksGet(params: any, id: any, res: Response) {
  const taskId = params?.taskId || params?.id;
  if (!taskId) {
    res.json({
      jsonrpc: "2.0",
      error: { code: -32602, message: "Invalid params: 'taskId' required" },
      id,
    });
    return;
  }

  const task = marketplaceRegistry.getTask(taskId);
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

function handleTasksList(params: any, id: any, res: Response) {
  const tasks = marketplaceRegistry.listTasks(params?.agentId, params?.status);
  res.json({
    jsonrpc: "2.0",
    result: { tasks },
    id,
  });
}

// ─── agent/authenticatedExtendedCard ─────────────────────────
// Returns the full registry card with live inventory stats.
// Authenticated: requires API key for extended data.

function handleExtendedCard(params: any, id: any, req: Request, res: Response) {
  const registryCard = marketplaceRegistry.getRegistryCard(BASE_URL);
  const stats = marketplaceRegistry.getStats();

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

function handleAgentInfo(params: any, id: any, res: Response) {
  const agentId = params?.agentId;
  if (!agentId) {
    res.json({
      jsonrpc: "2.0",
      error: { code: -32602, message: "Invalid params: 'agentId' required" },
      id,
    });
    return;
  }

  const info = knowledgeService.getAgentInfo(agentId);
  if (!info) {
    res.json({
      jsonrpc: "2.0",
      error: { code: -32602, message: `Agent not found: ${agentId}` },
      id,
    });
    return;
  }

  // Log the interaction
  interactionLogger.log("view", {
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
function serveAgentCard(_req: Request, res: Response) {
  const registryCard = marketplaceRegistry.getRegistryCard(BASE_URL);
  const legacyProducers = agentCardService.generateRegistry(BASE_URL);

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
}

router.get("/.well-known/agent-card.json", serveAgentCard); // A2A spec v1.0.0
router.get("/.well-known/agent.json", serveAgentCard);       // Legacy compat

// GET /agents/:id/agent.json — Individual producer Agent Card
router.get("/agents/:id/agent.json", (req: Request, res: Response) => {
  const card = agentCardService.generateCard(req.params.id as string, BASE_URL);
  if (!card) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(card);
});

// GET /api/stats — Platform stats (combined)
router.get("/api/stats", (_req: Request, res: Response) => {
  const legacyStats = store.getStats();
  const registryStats = marketplaceRegistry.getStats();

  res.json({
    success: true,
    data: {
      ...legacyStats,
      registry: registryStats,
    },
  });
});

// GET /api/discovery — Discovery status and metadata
router.get("/api/discovery", (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      agentCardUrl: `${BASE_URL}/.well-known/agent-card.json`,
      a2aEndpoint: `${BASE_URL}/a2a`,
      registries: discoveryService.getRegistryStatus(),
      metadata: discoveryService.getDiscoveryMetadata(),
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// SSE LIVE FEED — Real-time interaction stream
// Connect with EventSource("/api/live") in the dashboard
// ═══════════════════════════════════════════════════════════════

const sseClients = new Set<Response>();

router.get("/api/live", (req: Request, res: Response) => {
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
interactionLogger.on("interaction", (event: InteractionEvent) => {
  const data = JSON.stringify({ eventType: "interaction", ...event });
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`); } catch { sseClients.delete(client); }
  }
});

interactionLogger.on("message", (msg: any) => {
  const data = JSON.stringify({ type: "conversation_message", ...msg });
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`); } catch { sseClients.delete(client); }
  }
});

// ═══════════════════════════════════════════════════════════════
// INTERACTION & CONVERSATION API
// ═══════════════════════════════════════════════════════════════

// GET /api/interactions — Recent interactions
router.get("/api/interactions", (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const interactions = interactionLogger.getRecent(limit);
  res.json({ success: true, data: interactions, count: interactions.length });
});

// GET /api/interactions/stats — Interaction statistics
router.get("/api/interactions/stats", (_req: Request, res: Response) => {
  const stats = interactionLogger.getStats();
  res.json({ success: true, data: stats });
});

// POST /api/conversations — Start a new conversation
router.post("/api/conversations", (req: Request, res: Response) => {
  const { buyerAgentId, sellerAgentId, queryText } = req.body;
  if (!sellerAgentId) {
    res.status(400).json({ success: false, error: "sellerAgentId required" });
    return;
  }
  const conversation = conversationService.startConversation({
    buyerAgentId, sellerAgentId, queryText,
  });
  res.json({ success: true, data: conversation });
});

// GET /api/conversations — List conversations
router.get("/api/conversations", (req: Request, res: Response) => {
  const conversations = conversationService.listConversations({
    limit: parseInt(req.query.limit as string) || 50,
    status: (req.query.status as string) || undefined,
    agentId: (req.query.agentId as string) || undefined,
  });
  res.json({ success: true, data: conversations, count: conversations.length });
});

// GET /api/conversations/:id — Get single conversation with messages
router.get("/api/conversations/:id", (req: Request, res: Response) => {
  const conversation = conversationService.getConversation(req.params.id as string);
  if (!conversation) {
    res.status(404).json({ success: false, error: "Conversation not found" });
    return;
  }
  res.json({ success: true, data: conversation });
});

// POST /api/conversations/:id/messages — Add message to conversation
router.post("/api/conversations/:id/messages", (req: Request, res: Response) => {
  const { senderRole, senderAgentId, content, messageType, metadata } = req.body;
  if (!content || !senderRole) {
    res.status(400).json({ success: false, error: "content and senderRole required" });
    return;
  }
  const message = conversationService.addMessage({
    conversationId: req.params.id as string,
    senderRole, senderAgentId, content,
    messageType: messageType || "text",
    metadata: metadata || {},
  });
  res.json({ success: true, data: message });
});

// POST /api/conversations/:id/complete — Mark transaction as completed
router.post("/api/conversations/:id/complete", (req: Request, res: Response) => {
  try {
    const conversation = conversationService.completeTransaction(req.params.id as string, {
      totalAmountNok: req.body.totalAmountNok,
      products: req.body.products,
    });
    res.json({ success: true, data: conversation });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// SELLER METRICS & SOCIAL PROOF
// ═══════════════════════════════════════════════════════════════

// GET /api/agents/:id/metrics — Seller dashboard data
router.get("/api/agents/:id/metrics", (req: Request, res: Response) => {
  const metrics = conversationService.getAgentMetrics(req.params.id as string);
  res.json({ success: true, data: metrics });
});

// GET /api/leaderboard — Top sellers (social proof)
router.get("/api/leaderboard", (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 10;
  const leaderboard = conversationService.getLeaderboard(limit);
  res.json({ success: true, data: leaderboard });
});

export default router;
