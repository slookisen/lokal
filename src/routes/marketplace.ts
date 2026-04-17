import { Router, Request, Response } from "express";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { AgentRegistrationSchema, DiscoveryQuerySchema } from "../models/marketplace";
import { interactionLogger } from "../services/interaction-logger";
import { knowledgeService } from "../services/knowledge-service";
import { getDb } from "../database/init";
import { emailService } from "../services/email-service";
import { trustScoreService } from "../services/trust-score-service";

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

// ─── Ensure agent exists in SQLite for FK constraints ───────
// The marketplace registry keeps agents in-memory (loaded from seed/discovery).
// But agent_claims has a FOREIGN KEY to agents(id). If the agent only exists
// in the registry but not in SQLite, the claim INSERT fails.
// This function ensures the agent row exists before any FK-dependent operation.
function ensureAgentInDb(agentId: string): boolean {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM agents WHERE id = ?").get(agentId);
  if (exists) return true;

  // Try to get from registry and insert
  const agents = marketplaceRegistry.getActiveAgents();
  const agent = agents.find((a: any) => a.id === agentId);
  if (!agent) return false;

  try {
    db.prepare(`
      INSERT OR IGNORE INTO agents (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city, categories, trust_score, is_active, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      agent.id,
      agent.name,
      agent.description || "",
      agent.provider || "auto-discovered",
      agent.contactEmail || "ukjent@rettfrabonden.com",
      agent.url || `https://rettfrabonden.com/produsent/${agent.id}`,
      agent.role || "producer",
      agent.apiKey || `auto_${agent.id}`,
      agent.location?.lat || null,
      agent.location?.lng || null,
      agent.location?.city || null,
      JSON.stringify(agent.categories || []),
      agent.trustScore || 0.5,
      agent.isVerified || 0
    );
    console.log(`[claim] Synced agent ${agent.id} (${agent.name}) to SQLite for FK`);
    return true;
  } catch (err) {
    console.error(`[claim] Failed to sync agent ${agentId} to SQLite:`, err);
    return false;
  }
}

// ─── Helpers: contact block + vCard ──────────────────────────
// Used by /search, /discover (via enrichment) and /vcard endpoint.
// Keeping these inline to avoid a new util module just yet.

function buildContactBlock(agentId: string): {
  address?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  website?: string;
  openingHours?: Array<{ day: string; open: string; close: string }>;
  paymentMethods?: string[];
  deliveryOptions?: string[];
  vcardUrl: string;
} | null {
  const info = knowledgeService.getAgentInfo(agentId);
  if (!info) return null;
  const k = info.knowledge;
  const hasAnyContact = !!(k.address || k.phone || k.email || k.website);
  if (!hasAnyContact) {
    // Still return vcardUrl so clients always have a handle
    return { vcardUrl: `/api/marketplace/agents/${agentId}/vcard` };
  }
  return {
    address: k.address,
    postalCode: k.postalCode,
    phone: k.phone,
    email: k.email,
    website: k.website,
    openingHours: k.openingHours,
    paymentMethods: k.paymentMethods,
    deliveryOptions: k.deliveryOptions,
    vcardUrl: `/api/marketplace/agents/${agentId}/vcard`,
  };
}

// RFC 6350 vCard 3.0 — broad compatibility across iOS, Android, Outlook.
function escapeVCard(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function buildVCard(agentId: string): string | null {
  const info = knowledgeService.getAgentInfo(agentId);
  if (!info) return null;
  const { agent, knowledge: k } = info;
  const lines: string[] = [];
  lines.push("BEGIN:VCARD");
  lines.push("VERSION:3.0");
  lines.push(`FN:${escapeVCard(agent.name)}`);
  lines.push(`ORG:${escapeVCard(agent.name)}`);
  if (k.about) lines.push(`NOTE:${escapeVCard(k.about)}`);
  if (k.phone) lines.push(`TEL;TYPE=WORK,VOICE:${escapeVCard(k.phone)}`);
  if (k.email) lines.push(`EMAIL;TYPE=WORK:${escapeVCard(k.email)}`);
  if (k.website) lines.push(`URL:${escapeVCard(k.website)}`);
  if (k.address || agent.city) {
    // ADR;TYPE=WORK:;;<street>;<city>;<region>;<postal>;<country>
    const street = k.address ? escapeVCard(k.address) : "";
    const city = agent.city ? escapeVCard(agent.city) : "";
    const postal = k.postalCode ? escapeVCard(k.postalCode) : "";
    lines.push(`ADR;TYPE=WORK:;;${street};${city};;${postal};Norway`);
  }
  // Products as NOTE appendix (visible in most contact apps)
  if (k.products && Array.isArray(k.products) && k.products.length > 0) {
    const productList = k.products.map((p: any) => {
      let item = p.name || p.product || "Ukjent";
      if (p.price) item += ` (${p.price})`;
      if (p.season) item += ` [${p.season}]`;
      return item;
    }).join(", ");
    const notePrefix = k.about ? escapeVCard(k.about) + "\\n\\nProdukter: " : "Produkter: ";
    // Override NOTE with about + products combined
    const noteIdx = lines.findIndex(l => l.startsWith("NOTE:"));
    if (noteIdx >= 0) lines[noteIdx] = `NOTE:${notePrefix}${escapeVCard(productList)}`;
    else lines.push(`NOTE:Produkter: ${escapeVCard(productList)}`);
  }
  // Category tag helps contact apps group these
  lines.push("CATEGORIES:Rett fra Bonden,Norsk mat,Produsent");
  lines.push(`X-LOKAL-AGENT-ID:${agent.id}`);
  if (agent.trustScore !== undefined && agent.trustScore !== null) {
    lines.push(`X-LOKAL-TRUST-SCORE:${Math.round(agent.trustScore * 100)}`);
  }
  lines.push(`REV:${new Date().toISOString()}`);
  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9æøåÆØÅ_-]+/g, "_").slice(0, 60) || "agent";
}

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

    const enrichedResults = results.map((r: any) => ({
      ...r,
      contact: buildContactBlock(r.agent.id),
    }));

    res.json({
      success: true,
      count: enrichedResults.length,
      query: {
        role: query.role,
        categories: query.categories,
        tags: query.tags,
        maxDistanceKm: query.maxDistanceKm,
      },
      results: enrichedResults,
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

  // Support frontend geolocation: ?lat=59.91&lng=10.75
  const frontendLat = parseFloat(req.query.lat as string);
  const frontendLng = parseFloat(req.query.lng as string);
  if (!isNaN(frontendLat) && !isNaN(frontendLng) && !parsed.location) {
    parsed.location = { lat: frontendLat, lng: frontendLng };
    parsed.maxDistanceKm = parseFloat(req.query.radius as string) || 25;
  }

  // Preserve _productTerms through schema parsing (Zod strips unknown fields)
  const productTerms = parsed._productTerms;
  const query = DiscoveryQuerySchema.parse({
    ...parsed,
    limit: parseInt(req.query.limit as string) || 20,
    offset: parseInt(req.query.offset as string) || 0,
  });
  // Re-attach product terms for product-level filtering in discover()
  if (productTerms) (query as any)._productTerms = productTerms;

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

  // Enrich each result with a compact contact block so MCP/chat clients
  // can present action-handles (tel:, mailto:, vCard) without extra calls.
  const enrichedResults = results.map((r: any) => ({
    ...r,
    contact: buildContactBlock(r.agent.id),
  }));

  // Sanitize query echo to prevent reflected XSS if rendered by consumers
  const safeQuery = q.replace(/<[^>]*>/g, "").replace(/javascript:/gi, "");
  res.json({
    success: true,
    query: safeQuery,
    parsed, // Show what we understood (transparency)
    count: enrichedResults.length,
    results: enrichedResults,
  });
});

// ─── GET /agents/:id/vcard — Download vCard for contacts ─────
// Returns a standard RFC 6350 vCard 3.0 payload so buyers can
// tap "add to contacts" straight from a chat answer.

router.get("/agents/:id/vcard", (req: Request, res: Response) => {
  const agentId = req.params.id as string;
  const vcard = buildVCard(agentId);
  if (!vcard) {
    res.status(404).json({ success: false, error: "Agent ikke funnet" });
    return;
  }
  const info = knowledgeService.getAgentInfo(agentId);
  const filename = safeFileName(info?.agent.name || "agent") + ".vcf";

  interactionLogger.log("view", {
    agentId: agentId,
    metadata: { type: "vcard_download", buyerAgent: req.headers["x-agent-id"] as string },
    ipAddress: req.ip,
  });

  res.setHeader("Content-Type", "text/vcard; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(vcard);
});

// ─── GET /agents/:id/card — Individual agent card (A2A) ──────
// Standard A2A agent card for a registered agent

router.get("/agents/:id/card", (req: Request, res: Response) => {
  const agentId = req.params.id as string;
  const card = marketplaceRegistry.getAgentCard(agentId);
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
  const agentId = req.params.id as string;
  if (!apiKey) {
    res.status(401).json({ error: "Mangler X-API-Key header" });
    return;
  }

  const agent = marketplaceRegistry.getAgentByApiKey(apiKey);
  if (!agent || agent.id !== agentId) {
    res.status(403).json({ error: "Ikke autorisert" });
    return;
  }

  const updated = marketplaceRegistry.updateAgent(agentId, req.body);
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
  const agentId = req.params.id as string;
  const agent = marketplaceRegistry.getAgentByApiKey(apiKey);
  if (!agent || agent.id !== agentId) {
    res.status(403).json({ error: "Ikke autorisert" });
    return;
  }
  marketplaceRegistry.heartbeat(agentId);
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
      isClaimed: knowledgeService.isAgentClaimed(a.id),
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
  const agentId = req.params.id as string;
  const info = knowledgeService.getAgentInfo(agentId);
  if (!info) {
    res.status(404).json({ success: false, error: "Agent ikke funnet" });
    return;
  }

  // Log the view
  interactionLogger.log("view", {
    agentId: agentId,
    metadata: { type: "agent_info_request", buyerAgent: req.headers["x-agent-id"] as string },
    ipAddress: req.ip,
  });

  res.json({ success: true, data: info });
});

// ─── GET /agents/:id/knowledge — Raw knowledge data ─────────
// For admin/debugging. Returns the raw knowledge record.

router.get("/agents/:id/knowledge", (req: Request, res: Response) => {
  const agentId = req.params.id as string;
  const knowledge = knowledgeService.getKnowledge(agentId);
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

router.post("/agents/:id/claim", async (req: Request, res: Response) => {
  const { name, email, phone, source } = req.body;
  const agentId = req.params.id as string;
  if (!name || !email) {
    res.status(400).json({ success: false, error: "Navn og e-post er påkrevd" });
    return;
  }

  // Ensure the agent exists in SQLite before creating a claim (FK constraint)
  if (!ensureAgentInDb(agentId)) {
    res.status(404).json({ success: false, error: "Agent ikke funnet" });
    return;
  }

  try {
    const result = knowledgeService.requestClaim(agentId, {
      claimantName: name,
      claimantEmail: email,
      claimantPhone: phone,
      source: source || 'organic',
    });

    // Get agent name for the email
    const agents = marketplaceRegistry.getActiveAgents();
    const agent = agents.find((a: any) => a.id === agentId);
    const agentName = agent?.name || "Ukjent produsent";

    // Send verification code via email (graceful fallback if SMTP not configured)
    const emailResult = await emailService.sendVerificationCode(email, result.verificationCode, agentName);

    // Build response — include code in dev/dry-run mode, hide in production
    const responseData: any = { claimId: result.claimId };
    if (emailResult.messageId === "DRY_RUN") {
      // SMTP not configured — return code in response so dev/testing still works
      responseData.verificationCode = result.verificationCode;
      responseData._note = "E-post ikke konfigurert. Koden vises kun i testmodus.";
    }

    res.json({
      success: true,
      message: emailResult.messageId === "DRY_RUN"
        ? "Verifiseringskode generert (e-post ikke aktiv ennå)."
        : `Verifiseringskode sendt til ${email}.`,
      data: responseData,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /agents/:id/claim/verify — Verify claim ──────────

router.post("/agents/:id/claim/verify", (req: Request, res: Response) => {
  const { claimId, code } = req.body;
  const agentId = req.params.id as string;
  if (!claimId || !code) {
    res.status(400).json({ success: false, error: "claimId og code er påkrevd" });
    return;
  }

  const result = knowledgeService.verifyClaim(claimId, code);
  if (!result.success) {
    res.status(400).json({ success: false, error: result.error });
    return;
  }

  // Recalculate trust score now that the agent is verified
  const newTrustScore = trustScoreService.update(agentId);

  res.json({
    success: true,
    message: "Agenten er nå din! Bruk claim-token for å oppdatere informasjon.",
    data: {
      claimToken: result.claimToken,
      agentId: agentId,
      trustScore: newTrustScore,
    },
  });
});

// ─── POST /auth/login — Token-based login (single DB lookup) ──────────

router.post("/auth/login", (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ success: false, error: "Token er påkrevd" });
    return;
  }

  const claim = knowledgeService.getClaimByToken(token);
  if (!claim) {
    res.status(401).json({ success: false, error: "Ugyldig eller utløpt token" });
    return;
  }

  // Return the agent ID so the client can go straight to dashboard
  res.json({
    success: true,
    data: {
      agentId: claim.agentId,
      claimantName: claim.claimantName,
    },
  });
});

// ─── POST /auth/magic-link — Request magic link login ──────────

router.post("/auth/magic-link", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ success: false, error: "E-post er påkrevd" });
    return;
  }

  try {
    const result = knowledgeService.createMagicLink(email.toLowerCase().trim());
    if (!result.success) {
      // Don't reveal whether email exists — always show success to prevent enumeration
      res.json({ success: true, message: "Hvis e-posten er registrert, vil du motta en innloggingslenke." });
      return;
    }

    const baseUrl = process.env.APP_URL || "https://rettfrabonden.com";
    const magicUrl = `${baseUrl}/selger?magic=${result.token}`;

    await emailService.sendMagicLink(email, magicUrl, result.agentName || "din agent");

    res.json({
      success: true,
      message: "Hvis e-posten er registrert, vil du motta en innloggingslenke.",
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: "Kunne ikke sende innloggingslenke" });
  }
});

// ─── GET /auth/magic-verify — Verify magic link token ──────────

router.get("/auth/magic-verify", (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (!token) {
    res.status(400).json({ success: false, error: "Token mangler" });
    return;
  }

  const result = knowledgeService.verifyMagicLink(token);
  if (!result.success) {
    res.status(401).json({ success: false, error: result.error });
    return;
  }

  res.json({
    success: true,
    data: {
      agentId: result.agentId,
      claimToken: result.claimToken,
      claimantName: result.claimantName,
    },
  });
});

// ─── POST /agents/:id/unclaim — Give up ownership ──────────

router.post("/agents/:id/unclaim", (req: Request, res: Response) => {
  const claimToken = (req.headers["x-claim-token"] as string) || "";
  const agentId = req.params.id as string;
  if (!claimToken) {
    res.status(401).json({ success: false, error: "Claim token påkrevd" });
    return;
  }

  const claim = knowledgeService.getClaimByToken(claimToken);
  if (!claim || claim.agentId !== agentId) {
    res.status(403).json({ success: false, error: "Ikke autorisert for denne agenten" });
    return;
  }

  try {
    const db = getDb();
    // Remove this specific claim
    db.prepare("DELETE FROM agent_claims WHERE agent_id = ? AND claim_token = ?").run(agentId, claimToken);

    // Check if any other verified claims remain for this agent
    const remainingClaims = db.prepare(
      "SELECT COUNT(*) as c FROM agent_claims WHERE agent_id = ? AND status = 'verified'"
    ).get(agentId) as any;

    if (remainingClaims.c === 0) {
      // No owners left — reset verified status and data source
      db.prepare("UPDATE agents SET is_verified = 0 WHERE id = ?").run(agentId);
      db.prepare("UPDATE agent_knowledge SET data_source = 'auto' WHERE agent_id = ?").run(agentId);
    }

    // Recalculate trust score
    trustScoreService.update(agentId);

    res.json({ success: true, message: "Eierskap frasagt" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /admin/agents/:id/reset-claim — Admin: reset verified/claim status ──

router.post("/admin/agents/:id/reset-claim", (req: Request, res: Response) => {
  const expectedKey = process.env.ADMIN_KEY;
  const agentId = req.params.id as string;
  if (!expectedKey) {
    res.status(503).json({ success: false, error: "Admin not configured" });
    return;
  }
  const adminKey = req.headers["x-admin-key"] as string;
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ success: false, error: "Admin key required" });
    return;
  }

  try {
    const db = getDb();
    db.prepare("UPDATE agents SET is_verified = 0 WHERE id = ?").run(agentId);
    db.prepare("DELETE FROM agent_claims WHERE agent_id = ?").run(agentId);
    db.prepare("UPDATE agent_knowledge SET data_source = 'auto' WHERE agent_id = ?").run(agentId);
    trustScoreService.update(agentId);
    res.json({ success: true, message: "Claim and verification reset" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PUT /agents/:id/knowledge — Update knowledge ───────────
// Authenticated via claim token, API key, OR admin key.
// Admin key uses upsertKnowledge (dataSource: "auto") for enrichment.
// Claim token / API key uses ownerUpdate (dataSource: "owner").

router.put("/agents/:id/knowledge", (req: Request, res: Response) => {
  const claimToken = (req.headers["x-claim-token"] as string) || "";
  const apiKey = (req.headers["x-api-key"] as string) || "";
  const adminKeyHeader = (req.headers["x-admin-key"] as string) || "";
  const expectedAdminKey = process.env.ADMIN_KEY || "";
  const agentId = req.params.id as string;

  let authorized = false;
  let isAdmin = false;

  // 1. Admin key — for automated enrichment (dataSource: "auto")
  if (expectedAdminKey && adminKeyHeader && adminKeyHeader === expectedAdminKey) {
    authorized = true;
    isAdmin = true;
  }

  // 2. Claim token — seller who has claimed their agent
  if (!authorized && claimToken) {
    const claim = knowledgeService.getClaimByToken(claimToken);
    if (claim && claim.agentId === agentId) authorized = true;
  }

  // 3. API key — agent's own key from registration
  if (!authorized && apiKey) {
    const agent = marketplaceRegistry.getAgentByApiKey(apiKey);
    if (agent && agent.id === agentId) authorized = true;
  }

  if (!authorized) {
    res.status(403).json({ success: false, error: "Ikke autorisert. Bruk X-Admin-Key, X-Claim-Token eller X-API-Key header." });
    return;
  }

  try {
    if (isAdmin) {
      // Admin enrichment — preserve dataSource as "auto" (or what's in body)
      knowledgeService.upsertKnowledge(agentId, {
        ...req.body,
        dataSource: req.body.dataSource || "auto",
      });
    } else {
      // Owner update — sets dataSource to "owner"
      knowledgeService.ownerUpdate(agentId, req.body);
    }

    // Recalculate trust score — completeness signal changes with every update
    const newTrustScore = trustScoreService.update(agentId);

    const updated = knowledgeService.getAgentInfo(agentId);
    res.json({
      success: true,
      message: isAdmin ? "Kunnskapsdata beriket (auto)" : "Kunnskapsdata oppdatert",
      data: { ...updated, trustScore: newTrustScore },
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── POST /admin/bulk-enrich — Batch enrich multiple agents ──
// Accepts an array of { agentId, data } objects.
// Uses the existing bulkEnrich method (dataSource: "auto").
// Requires ADMIN_KEY header.

router.post("/admin/bulk-enrich", (req: Request, res: Response) => {
  const expectedKey = process.env.ADMIN_KEY;
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;

  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const { agents } = req.body;
  if (!Array.isArray(agents) || agents.length === 0) {
    res.status(400).json({ success: false, error: "Forventer { agents: [{ agentId, data }] }" });
    return;
  }

  try {
    const enrichments = agents.map((a: any) => ({
      agentId: a.agentId || a.id,
      data: a.data || a,
    }));

    const count = knowledgeService.bulkEnrich(enrichments);

    // Recalculate trust scores for all enriched agents
    let trustUpdated = 0;
    for (const e of enrichments) {
      try {
        trustScoreService.update(e.agentId);
        trustUpdated++;
      } catch {}
    }

    res.json({
      success: true,
      message: `Beriket ${count} av ${agents.length} agenter`,
      data: { enriched: count, total: agents.length, trustScoresUpdated: trustUpdated },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DELETE /agents/:id — Remove agent (admin) ─────────────
// Admin endpoint for removing duplicate or invalid agents.
// Requires ADMIN_KEY header for authorization.
// Returns the deleted agent's name for confirmation.

router.delete("/agents/:id", (req: Request, res: Response) => {
  try {
    const adminKey = req.headers["x-admin-key"] as string;
    const expectedKey = process.env.ADMIN_KEY;
    const agentId = req.params.id as string;
    if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }

    if (!adminKey || adminKey !== expectedKey) {
      res.status(403).json({ error: "Krever X-Admin-Key header" });
      return;
    }

    const db = getDb();

    const agent = db.prepare("SELECT id, name, city FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) {
      res.status(404).json({ error: "Agent ikke funnet", id: agentId });
      return;
    }

    // Delete agent and all related data in one transaction
    // Must clear all FK references before deleting the agent itself.
    // conversations.seller_agent_id lacks ON DELETE CASCADE, so we clean manually.
    const deleteAll = db.transaction(() => {
      db.prepare("DELETE FROM agent_knowledge WHERE agent_id = ?").run(agentId);
      db.prepare("DELETE FROM agent_claims WHERE agent_id = ?").run(agentId);
      db.prepare("UPDATE conversations SET seller_agent_id = NULL WHERE seller_agent_id = ?").run(agentId);
      db.prepare("DELETE FROM analytics_agent_views WHERE agent_id = ?").run(agentId);
      db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    });
    deleteAll();

    // Log (non-critical — wrapped so logging failure doesn't crash the response)
    try {
      interactionLogger.log("message", {
        agentId: agentId,
        metadata: { name: agent.name, city: agent.city, reason: req.body?.reason || "cleanup", action: "admin-delete" },
        ipAddress: req.ip || "unknown",
      });
    } catch (logErr) {
      console.error("[delete] Interaction log failed (non-critical):", logErr);
    }

    res.json({
      success: true,
      message: `Agent "${agent.name}" (${agent.city}) slettet`,
      id: agentId,
    });
  } catch (err) {
    console.error("[delete] Agent delete failed:", err);
    res.status(500).json({ error: "Sletting feilet", detail: String(err) });
  }
});

// ─── POST /admin/deduplicate — Smart deduplication ──────────
// Finds and removes duplicate agents based on fuzzy name matching.
// Keeps the oldest entry (by created_at) for each group.
// Requires ADMIN_KEY header.

router.post("/admin/deduplicate", (req: Request, res: Response) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expectedKey = process.env.ADMIN_KEY || "";

  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const dryRun = req.body?.dryRun !== false; // Default to dry run for safety

  const { getDb } = require("../database/init");
  const db = getDb();

  // Find duplicates: same city + name starts with same base name
  // Group by normalized name (lowercase, stripped of suffixes like "— Sandefjord")
  const allAgents = db.prepare(`
    SELECT id, name, city, created_at
    FROM agents
    WHERE is_active = 1
    ORDER BY created_at ASC
  `).all() as any[];

  // Normalize: strip "— Suffix", lowercase, trim
  function normalize(name: string): string {
    return name
      .replace(/\s*[—–-]\s*.+$/, "")  // Remove everything after em-dash/en-dash/hyphen
      .replace(/\s*(gårdsbutikk|gårdsysteri|gardsysteri|ysteri|kloster|økologisk|gård|gard)\s*/gi, " ")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  const groups = new Map<string, any[]>();
  for (const agent of allAgents) {
    const key = `${normalize(agent.name)}::${(agent.city || "").toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(agent);
  }

  const duplicates: any[] = [];
  for (const [key, agents] of groups) {
    if (agents.length > 1) {
      // Keep first (oldest), mark rest as duplicates
      const [keep, ...remove] = agents;
      for (const dup of remove) {
        duplicates.push({
          id: dup.id,
          name: dup.name,
          city: dup.city,
          keepId: keep.id,
          keepName: keep.name,
          groupKey: key,
        });
      }
    }
  }

  if (!dryRun && duplicates.length > 0) {
    const deleteStmt = db.prepare("DELETE FROM agents WHERE id = ?");
    const deleteMany = db.transaction((ids: string[]) => {
      for (const id of ids) deleteStmt.run(id);
    });
    deleteMany(duplicates.map(d => d.id));
  }

  res.json({
    success: true,
    dryRun,
    duplicatesFound: duplicates.length,
    duplicates: duplicates.map(d => ({
      remove: { id: d.id, name: d.name, city: d.city },
      keep: { id: d.keepId, name: d.keepName },
    })),
    message: dryRun
      ? `Fant ${duplicates.length} duplikater. Kjør med dryRun: false for å slette.`
      : `Slettet ${duplicates.length} duplikater.`,
  });
});

// ═══════════════════════════════════════════════════════════════
// TRUST SCORE — Dynamic reputation engine
// The score drives ranking in discovery results. Higher trust =
// more visible. Incentivizes sellers to claim, fill data, stay active.
// ═══════════════════════════════════════════════════════════════

// ─── GET /agents/:id/trust — Trust score breakdown ──────────
// Shows sellers exactly how their score is calculated and what
// they can do to improve it. This is the incentive dashboard.

router.get("/agents/:id/trust", (req: Request, res: Response) => {
  const agentId = req.params.id as string;
  const breakdown = trustScoreService.getBreakdown(agentId);
  if (!breakdown) {
    res.status(404).json({ success: false, error: "Agent ikke funnet" });
    return;
  }
  res.json({ success: true, data: breakdown });
});

// ─── POST /admin/recalculate-trust — Batch recalculate all ──
// Run after deploy or periodically to ensure scores reflect
// current data. Requires ADMIN_KEY header.

router.post("/admin/recalculate-trust", (req: Request, res: Response) => {
  const expectedKey = process.env.ADMIN_KEY;
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  const adminKey = req.headers["x-admin-key"] as string;

  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }

  const result = trustScoreService.recalculateAll();
  res.json({
    success: true,
    message: `Oppdaterte trust score for ${result.updated} agenter`,
    data: result,
  });
});

// ═══════════════════════════════════════════════════════════════
// FIND-OR-CREATE — Prevent duplicate registrations
// Seller enters name + city → we return fuzzy matches from the
// registry so they can claim an existing agent instead of creating
// a duplicate. Also used as a guard on POST /register.
// ═══════════════════════════════════════════════════════════════

// Shared normalize function for fuzzy matching
function normalizeName(name: string): string {
  return name
    .replace(/\s*[—–-]\s*.+$/, "")
    .replace(/\s*(gårdsbutikk|gårdsysteri|gardsysteri|ysteri|kloster|økologisk|gård|gard|bakeri|fiskeri|mathall|matmarked)\s*/gi, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// Simple Levenshtein distance for name similarity
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function similarityScore(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ─── GET /find-match?name=...&city=... — Find similar agents ──
// Returns agents that fuzzy-match the given name.
// City is optional and only used to boost ranking, never to filter.
// Used by the seller registration page to show "Is this you?"

router.get("/find-match", (req: Request, res: Response) => {
  const name = (req.query.name as string || "").trim();
  const city = (req.query.city as string || "").trim();

  if (!name || name.length < 2) {
    res.json({ success: true, matches: [] });
    return;
  }

  const { getDb } = require("../database/init");
  const db = getDb();

  // Normalize but fall back to raw lowercase if normalization empties the string
  // (e.g. "bakeri" is a suffix word and gets stripped)
  const rawInput = name.toLowerCase().trim();
  const normalized = normalizeName(name);
  const normalizedInput = normalized.length >= 2 ? normalized : rawInput;
  const inputWords = normalizedInput.split(/\s+/).filter(w => w.length >= 2);
  const normalizedCity = city.toLowerCase();

  // Fetch all active agents
  const allAgents = db.prepare(`
    SELECT a.id, a.name, a.city, a.categories, a.trust_score, a.is_verified,
           a.description,
           CASE WHEN ac.status = 'verified' THEN 1 ELSE 0 END as is_claimed
    FROM agents a
    LEFT JOIN agent_claims ac ON ac.agent_id = a.id AND ac.status = 'verified'
    WHERE a.is_active = 1
  `).all() as any[];

  const matches: any[] = [];

  for (const agent of allAgents) {
    const normalizedAgent = normalizeName(agent.name);
    const agentWords = normalizedAgent.split(/\s+/).filter((w: string) => w.length >= 2);

    // Also keep the raw lowercased name for matching common suffix words
    // (e.g. "gård" gets stripped by normalizeName but exists in raw name)
    const rawAgent = (agent.name || "").toLowerCase().trim();
    const rawAgentWords = rawAgent.split(/[\s—–\-,]+/).filter((w: string) => w.length >= 2);

    // ── Score components ──
    // 1. Full Levenshtein similarity (normalized)
    const fullSim = similarityScore(normalizedInput, normalizedAgent);

    // 2. Substring match — check both normalized AND raw agent name.
    //    Primarily "agent name contains the input" (user types partial).
    //    The reverse only counts if agent name is ≥70% of input length.
    const inputInAgent = normalizedInput.length >= 3 && (
      normalizedAgent.includes(normalizedInput) || rawAgent.includes(rawInput)
    );
    const agentInInput = normalizedInput.length >= 3 && normalizedAgent.length >= 3
      && normalizedAgent.length / normalizedInput.length >= 0.7
      && normalizedInput.includes(normalizedAgent);
    const isSubstring = inputInAgent || agentInInput;

    // 3. Word-level matching: check against both normalized AND raw agent words
    //    This catches searches like "gård" which get stripped during normalization
    const allAgentWords = [...new Set([...agentWords, ...rawAgentWords])];
    let wordScore = 0;
    for (const iw of inputWords) {
      for (const aw of allAgentWords) {
        if (aw.includes(iw) || iw.includes(aw)) {
          wordScore = Math.max(wordScore, Math.min(iw.length, aw.length) / Math.max(iw.length, aw.length));
        } else {
          // Also check word-level Levenshtein for typos
          const ws = similarityScore(iw, aw);
          if (ws >= 0.7) wordScore = Math.max(wordScore, ws * 0.8);
        }
      }
    }

    // 4. Starts-with check (min 3 chars, check both normalized and raw)
    const startsWith = normalizedInput.length >= 3 && (
      normalizedAgent.startsWith(normalizedInput) || normalizedInput.startsWith(normalizedAgent)
      || rawAgent.startsWith(rawInput) || rawInput.startsWith(rawAgent)
    );

    // ── Composite score ──
    // Take the best signal, with bonuses for multiple signals
    let score = Math.max(
      fullSim,
      isSubstring ? 0.85 : 0,
      startsWith ? 0.80 : 0,
      wordScore * 0.75,
    );

    // Bonus: if city matches, bump score slightly (but never filter by city)
    if (normalizedCity && (agent.city || "").toLowerCase().includes(normalizedCity)) {
      score = Math.min(1, score + 0.05);
    }

    // ── Lenient threshold: 0.35 lets partial matches through ──
    if (score >= 0.35) {
      matches.push({
        id: agent.id,
        name: agent.name,
        city: agent.city,
        description: (agent.description || "").substring(0, 120),
        categories: JSON.parse(agent.categories || "[]"),
        trustScore: agent.trust_score,
        isVerified: !!agent.is_verified,
        isClaimed: !!agent.is_claimed,
        similarity: Math.round(score * 100),
      });
    }
  }

  // Sort by similarity descending, limit to 15
  matches.sort((a, b) => b.similarity - a.similarity);

  res.json({
    success: true,
    query: { name, city },
    count: Math.min(matches.length, 15),
    matches: matches.slice(0, 15),
  });
});

// ─── POST /register (updated with dedup guard) ────────────────
// Before creating a new agent, check for fuzzy duplicates.
// If a close match exists, return a warning with matches.
// Caller can force-create by setting { force: true }.

// (The original POST /register handler above is kept unchanged —
//  the dedup guard is applied in the selger.html frontend by
//  calling /find-match first. Backend guard is a safety net.)

// ─── Helper ──────────────────────────────────────────────────

// ─── GET /admin/claims — Campaign tracking overview ───────────
// Shows all claims grouped by source, so you can track which
// outreach campaigns are converting.

router.get("/admin/claims", (req: Request, res: Response) => {
  const expectedKey = process.env.ADMIN_KEY;
  if (!expectedKey) { res.status(503).json({ error: "Admin not configured" }); return; }
  const adminKey = (req.headers["x-admin-key"] as string) || (req.query.key as string);
  if (!adminKey || adminKey !== expectedKey) {
    res.status(403).json({ error: "Krever admin-nøkkel" });
    return;
  }

  const db = getDb();

  // All claims with source info
  const claims = db.prepare(`
    SELECT ac.id, ac.agent_id, ac.claimant_name, ac.claimant_email, ac.status,
           ac.source, ac.created_at, ac.verified_at, a.name as agent_name
    FROM agent_claims ac
    LEFT JOIN agents a ON a.id = ac.agent_id
    ORDER BY ac.created_at DESC
  `).all();

  // Summary by source
  const byCampaign = db.prepare(`
    SELECT source, status, COUNT(*) as count
    FROM agent_claims
    GROUP BY source, status
    ORDER BY source, status
  `).all();

  res.json({
    success: true,
    data: {
      claims,
      byCampaign,
      total: claims.length,
      verified: (claims as any[]).filter((c: any) => c.status === 'verified').length,
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// INBOUND EMAIL WEBHOOK
// Resend sends a POST here when someone emails *@rettfrabonden.com
// We forward it to the admin's Gmail so nothing gets lost.
// ═══════════════════════════════════════════════════════════════

router.post("/webhooks/inbound-email", async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    // Log full payload to debug Resend's format
    console.log(`[Inbound] Raw payload: ${JSON.stringify(payload).substring(0, 2000)}`);

    // Resend wraps inbound data in { type, created_at, data: { ... } }
    const data = payload.data || payload; // fallback for direct test calls
    const from = data.from || payload.from || "unknown";
    const to = data.to || payload.to || [];
    const subject = data.subject || payload.subject || "(ingen emne)";
    const emailId = data.email_id || payload.email_id;

    console.log(`[Inbound] Event: ${payload.type || "unknown"}, email_id: ${emailId}, from: ${from}, subject: "${subject}"`);

    // Resend inbound webhooks don't include body — fetch it via API
    let html = "";
    let text = "";
    const resendKey = process.env.RESEND_API_KEY;

    if (emailId && resendKey) {
      try {
        const emailRes = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: { Authorization: `Bearer ${resendKey}` },
        });
        if (emailRes.ok) {
          const emailData = await emailRes.json() as { html?: string; text?: string };
          html = emailData.html || "";
          text = emailData.text || "";
          console.log(`[Inbound] Fetched body for ${emailId} (${html.length} chars HTML, ${text.length} chars text)`);
        } else {
          console.warn(`[Inbound] Could not fetch email body: ${emailRes.status} ${emailRes.statusText}`);
        }
      } catch (fetchErr) {
        console.warn(`[Inbound] Error fetching email body:`, fetchErr);
      }
    } else if (!resendKey) {
      console.warn(`[Inbound] RESEND_API_KEY not set — cannot fetch email body`);
    }

    // Extract sender email for reply-to (format: "Name <email@domain.com>")
    const senderEmail = typeof from === "string"
      ? (from.match(/<([^>]+)>/)?.[1] || from)
      : undefined;

    // Forward to admin Gmail
    const forwardTo = process.env.ADMIN_EMAIL || "da.fredriksen@gmail.com";
    const bodyHtml = html || (text ? `<pre>${text}</pre>` : `<p><em>Ingen innhold i eposten.</em></p>`);
    const bodyText = text || "(ingen tekstinnhold)";

    const forwarded = await emailService.sendEmail({
      to: forwardTo,
      subject: `[Innkommende] ${subject} (fra ${from})`,
      htmlContent: `
        <div style="border-bottom:1px solid #ccc;padding-bottom:8px;margin-bottom:16px;color:#666;font-size:13px;">
          <strong>Fra:</strong> ${from}<br>
          <strong>Til:</strong> ${Array.isArray(to) ? to.join(", ") : to}<br>
          <strong>Emne:</strong> ${subject}
        </div>
        ${bodyHtml}
      `,
      textContent: `Videresent fra: ${from}\nTil: ${Array.isArray(to) ? to.join(", ") : to}\nEmne: ${subject}\n\n${bodyText}`,
      replyTo: senderEmail,
    });

    if (forwarded) {
      console.log(`[Inbound] Forwarded to ${forwardTo}`);
    } else {
      console.warn(`[Inbound] Forward failed — email service not configured or send failed`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[Inbound] Webhook error:", err);
    res.status(200).json({ received: true }); // Always 200 so Resend doesn't retry
  }
});

function getBaseUrl(req: Request): string {
  return process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
}

export default router;
