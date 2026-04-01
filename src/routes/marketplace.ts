import { Router, Request, Response } from "express";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { AgentRegistrationSchema, DiscoveryQuerySchema } from "../models/marketplace";
import { interactionLogger } from "../services/interaction-logger";
import { knowledgeService } from "../services/knowledge-service";

// ─── Marketplace Routes ───────────────────────────────────────
// These are the OPEN endpoints that make Lokal a marketplace.
// Any agent in the world can:
//   1. Register themselves (POST /api/marketplace/register)
//   2. Discover other agents (POST /api/marketplace/discover)
//   3. Search with natural language (GET /api/marketplace/search?q=...)
//
// This is the "DNS for food agents" — the endpoints that external
// AI agents (ChatGPT, Claude, Gemini plugins) will call.

const router = Router();

// ─── POST /register — Register a new agent ──────────────────
// A producer, logistics provider, or any food agent can register.
// Returns an API key for future authenticated requests.
//
// Example: A farm's agent registers with:
//   { name: "Aker Gård Agent", role: "producer",
//     skills: [{ id: "sell-vegetables", tags: ["tomater", "poteter"] }],
//     location: { lat: 59.95, lng: 10.77, city: "Oslo" } }

router.post("/register", (req: Request, res: Response) => {
  try {
    const registration = AgentRegistrationSchema.parse(req.body);
    const agent = marketplaceRegistry.register(registration);

    interactionLogger.log("register", {
      agentId: agent.id,
      metadata: { name: agent.name, role: agent.role, city: agent.location?.city },
      ipAddress: req.ip,
    });

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
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({
        success: false,
        error: "Ugyldig registrering",
        details: error.errors,
      });
    } else {
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

router.post("/discover", (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const query = DiscoveryQuerySchema.parse(req.body);
    const results = marketplaceRegistry.discover(query);

    interactionLogger.log("discover", {
      query: JSON.stringify({ categories: query.categories, tags: query.tags }),
      resultCount: results.length,
      matchedAgentIds: results.map(r => r.agent.id),
      metadata: { query },
      ipAddress: req.ip,
      durationMs: Date.now() - startTime,
    });

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
  } catch (error: any) {
    if (error.name === "ZodError") {
      res.status(400).json({ success: false, error: "Ugyldig søk", details: error.errors });
    } else {
      res.status(500).json({ success: false, error: "Intern feil" });
    }
  }
});

// ─── GET /search?q=... — Natural language search ─────────────
// The "Google-like" endpoint. Consumer agents send a text query,
// we parse it and return matching agents.
//
// Example: GET /search?q=ferske+økologiske+grønnsaker+nær+Grünerløkka

router.get("/search", (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) {
    res.status(400).json({ success: false, error: "Mangler ?q= parameter" });
    return;
  }

  // Parse natural language into structured query
  const parsed = marketplaceRegistry.parseNaturalQuery(q);
  const query = DiscoveryQuerySchema.parse({
    ...parsed,
    limit: parseInt(req.query.limit as string) || 20,
    offset: parseInt(req.query.offset as string) || 0,
  });

  const startTime = Date.now();
  const results = marketplaceRegistry.discover(query);

  interactionLogger.log("search", {
    query: q,
    resultCount: results.length,
    matchedAgentIds: results.map(r => r.agent.id),
    metadata: { parsed },
    ipAddress: req.ip,
    durationMs: Date.now() - startTime,
  });

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

router.get("/agents/:id/card", (req: Request, res: Response) => {
  const card = marketplaceRegistry.getAgentCard(req.params.id);
  if (!card) {
    res.status(404).json({ error: "Agent ikke funnet" });
    return;
  }
  res.json(card);
});

// ─── PUT /agents/:id — Update agent (authenticated) ──────────
// Agents can update their own info using their API key

router.put("/agents/:id", (req: Request, res: Response) => {
  const apiKey = req.headers["x-api-key"] as string;
  if (!apiKey) {
    res.status(401).json({ error: "Mangler X-API-Key header" });
    return;
  }

  const agent = marketplaceRegistry.getAgentByApiKey(apiKey);
  if (!agent || agent.id !== req.params.id) {
    res.status(403).json({ error: "Ikke autorisert" });
    return;
  }

  const updated = marketplaceRegistry.updateAgent(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: "Agent ikke funnet" });
    return;
  }

  res.json({ success: true, data: { id: updated.id, name: updated.name, lastSeenAt: updated.lastSeenAt } });
});

// ─── POST /agents/:id/heartbeat — Keep agent alive ───────────
// Agents should ping this periodically so we know they're active

router.post("/agents/:id/heartbeat", (req: Request, res: Response) => {
  const apiKey = req.headers["x-api-key"] as string;
  const agent = marketplaceRegistry.getAgentByApiKey(apiKey);
  if (!agent || agent.id !== req.params.id) {
    res.status(403).json({ error: "Ikke autorisert" });
    return;
  }
  marketplaceRegistry.heartbeat(req.params.id);
  res.json({ success: true, lastSeenAt: new Date().toISOString() });
});

// ─── GET /stats — Marketplace stats ──────────────────────────

router.get("/stats", (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: marketplaceRegistry.getStats(),
  });
});

// ─── GET /agents — List all active agents ────────────────────

router.get("/agents", (_req: Request, res: Response) => {
  const agents = marketplaceRegistry.getActiveAgents();
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

// ═══════════════════════════════════════════════════════════════
// AGENT KNOWLEDGE — "Tell me about this seller"
// The core of the dummy-agent system. Buyer agents call this
// to get everything we know about a seller: address, products,
// hours, ratings, etc. Honest about data provenance.
// ═══════════════════════════════════════════════════════════════

// ─── GET /agents/:id/info — Structured seller info ──────────
// This is what buyer agents call. Returns everything we know
// about this seller in a clean, parseable format.
//
// Example response:
//   { agent: { name, city, trustScore, isClaimed },
//     knowledge: { address, products, openingHours, ... },
//     meta: { dataSource: "auto", disclaimer: "..." } }

router.get("/agents/:id/info", (req: Request, res: Response) => {
  const info = knowledgeService.getAgentInfo(req.params.id);
  if (!info) {
    res.status(404).json({ success: false, error: "Agent ikke funnet" });
    return;
  }

  // Log the view
  interactionLogger.log("view", {
    agentId: req.params.id,
    metadata: { type: "agent_info_request", buyerAgent: req.headers["x-agent-id"] as string },
    ipAddress: req.ip,
  });

  res.json({ success: true, data: info });
});

// ─── GET /agents/:id/knowledge — Raw knowledge data ─────────
// For admin/debugging. Returns the raw knowledge record.

router.get("/agents/:id/knowledge", (req: Request, res: Response) => {
  const knowledge = knowledgeService.getKnowledge(req.params.id);
  if (!knowledge) {
    res.status(404).json({ success: false, error: "Ingen kunnskapsdata for denne agenten" });
    return;
  }
  res.json({ success: true, data: knowledge });
});

// ─── GET /knowledge/stats — Knowledge layer statistics ──────

router.get("/knowledge/stats", (_req: Request, res: Response) => {
  const stats = knowledgeService.getKnowledgeStats();
  res.json({ success: true, data: stats });
});

// ═══════════════════════════════════════════════════════════════
// CLAIM SYSTEM — Sellers take ownership of their agent
// Flow:
//   1. POST /agents/:id/claim         → Request claim (get verification code)
//   2. POST /agents/:id/claim/verify  → Submit code → get claim token
//   3. PUT  /agents/:id/knowledge     → Update info (with claim token)
// ═══════════════════════════════════════════════════════════════

// ─── POST /agents/:id/claim — Request to claim an agent ─────

router.post("/agents/:id/claim", (req: Request, res: Response) => {
  const { name, email, phone } = req.body;
  if (!name || !email) {
    res.status(400).json({ success: false, error: "Navn og e-post er påkrevd" });
    return;
  }

  try {
    const result = knowledgeService.requestClaim(req.params.id, {
      claimantName: name,
      claimantEmail: email,
      claimantPhone: phone,
    });

    // In production: send verification code via email
    // For now: return it in the response (development mode)
    res.json({
      success: true,
      message: "Verifiseringskode sendt. Bruk /claim/verify for å fullføre.",
      data: {
        claimId: result.claimId,
        // DEV ONLY — remove in production:
        verificationCode: process.env.NODE_ENV === "production" ? undefined : result.verificationCode,
      },
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /agents/:id/claim/verify — Verify claim ──────────

router.post("/agents/:id/claim/verify", (req: Request, res: Response) => {
  const { claimId, code } = req.body;
  if (!claimId || !code) {
    res.status(400).json({ success: false, error: "claimId og code er påkrevd" });
    return;
  }

  const result = knowledgeService.verifyClaim(claimId, code);
  if (!result.success) {
    res.status(400).json({ success: false, error: result.error });
    return;
  }

  res.json({
    success: true,
    message: "Agenten er nå din! Bruk claim-token for å oppdatere informasjon.",
    data: {
      claimToken: result.claimToken,
      agentId: req.params.id,
    },
  });
});

// ─── PUT /agents/:id/knowledge — Owner updates knowledge ────
// Authenticated via claim token or API key.

router.put("/agents/:id/knowledge", (req: Request, res: Response) => {
  // Auth: accept either claim token or API key
  const claimToken = (req.headers["x-claim-token"] as string) || "";
  const apiKey = (req.headers["x-api-key"] as string) || "";

  let authorized = false;

  if (claimToken) {
    const claim = knowledgeService.getClaimByToken(claimToken);
    if (claim && claim.agentId === req.params.id) authorized = true;
  }

  if (!authorized && apiKey) {
    const agent = marketplaceRegistry.getAgentByApiKey(apiKey);
    if (agent && agent.id === req.params.id) authorized = true;
  }

  if (!authorized) {
    res.status(403).json({ success: false, error: "Ikke autorisert. Bruk X-Claim-Token eller X-API-Key header." });
    return;
  }

  try {
    knowledgeService.ownerUpdate(req.params.id, req.body);
    const updated = knowledgeService.getAgentInfo(req.params.id);
    res.json({
      success: true,
      message: "Kunnskapsdata oppdatert",
      data: updated,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── Helper ──────────────────────────────────────────────────

function getBaseUrl(req: Request): string {
  return process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
}

export default router;
