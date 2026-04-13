"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const marketplace_registry_1 = require("../services/marketplace-registry");
const marketplace_1 = require("../models/marketplace");
const interaction_logger_1 = require("../services/interaction-logger");
const knowledge_service_1 = require("../services/knowledge-service");
const trust_score_service_1 = require("../services/trust-score-service");
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
        interaction_logger_1.interactionLogger.log("register", {
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
    const startTime = Date.now();
    try {
        const query = marketplace_1.DiscoveryQuerySchema.parse(req.body);
        const results = marketplace_registry_1.marketplaceRegistry.discover(query);
        interaction_logger_1.interactionLogger.log("discover", {
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
    const startTime = Date.now();
    const results = marketplace_registry_1.marketplaceRegistry.discover(query);
    interaction_logger_1.interactionLogger.log("search", {
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
            isClaimed: knowledge_service_1.knowledgeService.isAgentClaimed(a.id),
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
router.get("/agents/:id/info", (req, res) => {
    const info = knowledge_service_1.knowledgeService.getAgentInfo(req.params.id);
    if (!info) {
        res.status(404).json({ success: false, error: "Agent ikke funnet" });
        return;
    }
    // Log the view
    interaction_logger_1.interactionLogger.log("view", {
        agentId: req.params.id,
        metadata: { type: "agent_info_request", buyerAgent: req.headers["x-agent-id"] },
        ipAddress: req.ip,
    });
    res.json({ success: true, data: info });
});
// ─── GET /agents/:id/knowledge — Raw knowledge data ─────────
// For admin/debugging. Returns the raw knowledge record.
router.get("/agents/:id/knowledge", (req, res) => {
    const knowledge = knowledge_service_1.knowledgeService.getKnowledge(req.params.id);
    if (!knowledge) {
        res.status(404).json({ success: false, error: "Ingen kunnskapsdata for denne agenten" });
        return;
    }
    res.json({ success: true, data: knowledge });
});
// ─── GET /knowledge/stats — Knowledge layer statistics ──────
router.get("/knowledge/stats", (_req, res) => {
    const stats = knowledge_service_1.knowledgeService.getKnowledgeStats();
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
router.post("/agents/:id/claim", (req, res) => {
    const { name, email, phone } = req.body;
    if (!name || !email) {
        res.status(400).json({ success: false, error: "Navn og e-post er påkrevd" });
        return;
    }
    try {
        const result = knowledge_service_1.knowledgeService.requestClaim(req.params.id, {
            claimantName: name,
            claimantEmail: email,
            claimantPhone: phone,
        });
        // TODO: Send verification code via email (e.g. Resend, SendGrid)
        // Until email is implemented, we return the code in the response.
        // When email is live, remove verificationCode from the response
        // and only send it to the claimant's email address.
        res.json({
            success: true,
            message: "Verifiseringskode sendt. Bruk /claim/verify for å fullføre.",
            data: {
                claimId: result.claimId,
                verificationCode: result.verificationCode,
            },
        });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// ─── POST /agents/:id/claim/verify — Verify claim ──────────
router.post("/agents/:id/claim/verify", (req, res) => {
    const { claimId, code } = req.body;
    if (!claimId || !code) {
        res.status(400).json({ success: false, error: "claimId og code er påkrevd" });
        return;
    }
    const result = knowledge_service_1.knowledgeService.verifyClaim(claimId, code);
    if (!result.success) {
        res.status(400).json({ success: false, error: result.error });
        return;
    }
    // Recalculate trust score now that the agent is verified
    const newTrustScore = trust_score_service_1.trustScoreService.update(req.params.id);
    res.json({
        success: true,
        message: "Agenten er nå din! Bruk claim-token for å oppdatere informasjon.",
        data: {
            claimToken: result.claimToken,
            agentId: req.params.id,
            trustScore: newTrustScore,
        },
    });
});
// ─── PUT /agents/:id/knowledge — Update knowledge ───────────
// Authenticated via claim token, API key, OR admin key.
// Admin key uses upsertKnowledge (dataSource: "auto") for enrichment.
// Claim token / API key uses ownerUpdate (dataSource: "owner").
router.put("/agents/:id/knowledge", (req, res) => {
    const claimToken = req.headers["x-claim-token"] || "";
    const apiKey = req.headers["x-api-key"] || "";
    const adminKeyHeader = req.headers["x-admin-key"] || "";
    const expectedAdminKey = process.env.ADMIN_KEY || "lokal-admin-2026";
    let authorized = false;
    let isAdmin = false;
    // 1. Admin key — for automated enrichment (dataSource: "auto")
    if (adminKeyHeader && adminKeyHeader === expectedAdminKey) {
        authorized = true;
        isAdmin = true;
    }
    // 2. Claim token — seller who has claimed their agent
    if (!authorized && claimToken) {
        const claim = knowledge_service_1.knowledgeService.getClaimByToken(claimToken);
        if (claim && claim.agentId === req.params.id)
            authorized = true;
    }
    // 3. API key — agent's own key from registration
    if (!authorized && apiKey) {
        const agent = marketplace_registry_1.marketplaceRegistry.getAgentByApiKey(apiKey);
        if (agent && agent.id === req.params.id)
            authorized = true;
    }
    if (!authorized) {
        res.status(403).json({ success: false, error: "Ikke autorisert. Bruk X-Admin-Key, X-Claim-Token eller X-API-Key header." });
        return;
    }
    try {
        if (isAdmin) {
            // Admin enrichment — preserve dataSource as "auto" (or what's in body)
            knowledge_service_1.knowledgeService.upsertKnowledge(req.params.id, {
                ...req.body,
                dataSource: req.body.dataSource || "auto",
            });
        }
        else {
            // Owner update — sets dataSource to "owner"
            knowledge_service_1.knowledgeService.ownerUpdate(req.params.id, req.body);
        }
        // Recalculate trust score — completeness signal changes with every update
        const newTrustScore = trust_score_service_1.trustScoreService.update(req.params.id);
        const updated = knowledge_service_1.knowledgeService.getAgentInfo(req.params.id);
        res.json({
            success: true,
            message: isAdmin ? "Kunnskapsdata beriket (auto)" : "Kunnskapsdata oppdatert",
            data: { ...updated, trustScore: newTrustScore },
        });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});
// ─── POST /admin/bulk-enrich — Batch enrich multiple agents ──
// Accepts an array of { agentId, data } objects.
// Uses the existing bulkEnrich method (dataSource: "auto").
// Requires ADMIN_KEY header.
router.post("/admin/bulk-enrich", (req, res) => {
    const adminKey = req.headers["x-admin-key"];
    const expectedKey = process.env.ADMIN_KEY || "lokal-admin-2026";
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
        const enrichments = agents.map((a) => ({
            agentId: a.agentId || a.id,
            data: a.data || a,
        }));
        const count = knowledge_service_1.knowledgeService.bulkEnrich(enrichments);
        // Recalculate trust scores for all enriched agents
        let trustUpdated = 0;
        for (const e of enrichments) {
            try {
                trust_score_service_1.trustScoreService.update(e.agentId);
                trustUpdated++;
            }
            catch { }
        }
        res.json({
            success: true,
            message: `Beriket ${count} av ${agents.length} agenter`,
            data: { enriched: count, total: agents.length, trustScoresUpdated: trustUpdated },
        });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// ─── DELETE /agents/:id — Remove agent (admin) ─────────────
// Admin endpoint for removing duplicate or invalid agents.
// Requires ADMIN_KEY header for authorization.
// Returns the deleted agent's name for confirmation.
router.delete("/agents/:id", (req, res) => {
    const adminKey = req.headers["x-admin-key"];
    const expectedKey = process.env.ADMIN_KEY || "lokal-admin-2026";
    if (!adminKey || adminKey !== expectedKey) {
        res.status(403).json({ error: "Krever X-Admin-Key header" });
        return;
    }
    const { getDb } = require("../database/init");
    const db = getDb();
    const agent = db.prepare("SELECT id, name, city FROM agents WHERE id = ?").get(req.params.id);
    if (!agent) {
        res.status(404).json({ error: "Agent ikke funnet", id: req.params.id });
        return;
    }
    db.prepare("DELETE FROM agents WHERE id = ?").run(req.params.id);
    interaction_logger_1.interactionLogger.log("admin-delete", {
        agentId: req.params.id,
        metadata: { name: agent.name, city: agent.city, reason: req.body?.reason || "duplicate" },
        ipAddress: req.ip,
    });
    res.json({
        success: true,
        message: `Agent "${agent.name}" (${agent.city}) slettet`,
        id: req.params.id,
    });
});
// ─── POST /admin/deduplicate — Smart deduplication ──────────
// Finds and removes duplicate agents based on fuzzy name matching.
// Keeps the oldest entry (by created_at) for each group.
// Requires ADMIN_KEY header.
router.post("/admin/deduplicate", (req, res) => {
    const adminKey = req.headers["x-admin-key"];
    const expectedKey = process.env.ADMIN_KEY || "lokal-admin-2026";
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
  `).all();
    // Normalize: strip "— Suffix", lowercase, trim
    function normalize(name) {
        return name
            .replace(/\s*[—–-]\s*.+$/, "") // Remove everything after em-dash/en-dash/hyphen
            .replace(/\s*(gårdsbutikk|gårdsysteri|gardsysteri|ysteri|kloster|økologisk|gård|gard)\s*/gi, " ")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ");
    }
    const groups = new Map();
    for (const agent of allAgents) {
        const key = `${normalize(agent.name)}::${(agent.city || "").toLowerCase()}`;
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(agent);
    }
    const duplicates = [];
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
        const deleteMany = db.transaction((ids) => {
            for (const id of ids)
                deleteStmt.run(id);
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
router.get("/agents/:id/trust", (req, res) => {
    const breakdown = trust_score_service_1.trustScoreService.getBreakdown(req.params.id);
    if (!breakdown) {
        res.status(404).json({ success: false, error: "Agent ikke funnet" });
        return;
    }
    res.json({ success: true, data: breakdown });
});
// ─── POST /admin/recalculate-trust — Batch recalculate all ──
// Run after deploy or periodically to ensure scores reflect
// current data. Requires ADMIN_KEY header.
router.post("/admin/recalculate-trust", (req, res) => {
    const adminKey = req.headers["x-admin-key"];
    const expectedKey = process.env.ADMIN_KEY || "lokal-admin-2026";
    if (!adminKey || adminKey !== expectedKey) {
        res.status(403).json({ error: "Krever X-Admin-Key header" });
        return;
    }
    const result = trust_score_service_1.trustScoreService.recalculateAll();
    res.json({
        success: true,
        message: `Oppdaterte trust score for ${result.updated} agenter`,
        data: result,
    });
});
// ─── Helper ──────────────────────────────────────────────────
// NOTE: Server-side image analysis endpoint (POST /agents/:id/analyze-image)
// is planned for a future release with ANTHROPIC_API_KEY integration.
// Currently using client-side copy/paste workflow with AI prompt.
function getBaseUrl(req) {
    return process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
}
exports.default = router;
//# sourceMappingURL=marketplace.js.map