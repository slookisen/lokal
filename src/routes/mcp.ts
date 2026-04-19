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

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { knowledgeService } from "../services/knowledge-service";
import { conversationService } from "../services/conversation-service";

const router = Router();

// ─── Tool definitions (shared logic) ────────────────────────
// These mirror the stdio MCP server tools but call services directly.

function registerTools(server: McpServer) {
  // Tool 1: Natural language search
  server.tool(
    "lokal_search",
    "Search for local food producers in Norway using natural language. Supports Norwegian and English. Returns ranked producers with contact info. Examples: 'fresh vegetables near Grünerløkka', 'organic honey Oslo', 'ost Trondheim'.",
    {
      query: z.string().describe("Natural language search query (Norwegian or English)"),
      limit: z.number().min(1).max(50).default(10).describe("Max results"),
    },
    async ({ query, limit }) => {
      const parsed = marketplaceRegistry.parseNaturalQuery(query);
      const results = marketplaceRegistry.discover({ ...parsed, limit: limit || 10, offset: 0 });

      if (!results?.length) {
        return { content: [{ type: "text" as const, text: `Ingen resultater for "${query}". Prøv et bredere søk.` }] };
      }

      // Auto-start conversations with top match so seller agent responds
      const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
      const convLinks: string[] = [];
      for (const r of results.slice(0, 2)) {
        try {
          const conv = conversationService.startConversation({
            sellerAgentId: r.agent.id,
            queryText: query,
            source: "mcp",
            autoRespond: true,
          });
          convLinks.push(`💬 [Samtale med ${conv.sellerAgentName}](${BASE}/samtale/${conv.id})`);
        } catch { /* non-critical */ }
      }

      const header = `🥬 **Lokal mat-søk: "${query}"** — fant ${results.length} produsenter:\n`;
      const lines = results.map((r: any, i: number) => {
        const agent = r.agent;
        const dist = r.distanceKm ? ` — ${r.distanceKm.toFixed(1)} km unna` : "";
        return formatAgentCompact(agent, i + 1, r.contact) + dist;
      });

      const convSection = convLinks.length
        ? `\n\n---\n**Samtaler startet automatisk:**\n${convLinks.join("\n")}`
        : "";

      return { content: [{ type: "text" as const, text: header + "\n" + lines.join("\n\n") + convSection }] };
    }
  );

  // Tool 2: Structured discovery
  server.tool(
    "lokal_discover",
    "Structured search in the Lokal food producer registry. Filter by food categories, tags, and geographic distance.",
    {
      categories: z.array(z.string()).optional().describe("Categories: vegetables, fruit, berries, dairy, eggs, meat, fish, bread, honey, herbs"),
      tags: z.array(z.string()).optional().describe("Tags: organic, seasonal, budget, local, fresh"),
      lat: z.number().optional().describe("Latitude for distance filtering"),
      lng: z.number().optional().describe("Longitude for distance filtering"),
      maxDistanceKm: z.number().optional().describe("Max distance in km"),
      limit: z.number().min(1).max(50).default(10).describe("Max results"),
    },
    async ({ categories, tags, lat, lng, maxDistanceKm, limit }) => {
      const body: any = { categories, tags, lat, lng, maxDistanceKm, limit: limit || 10, role: "producer" };
      const results = marketplaceRegistry.discover(body);

      if (!results?.length) {
        return { content: [{ type: "text" as const, text: "Ingen produsenter funnet med disse filtrene." }] };
      }

      // Auto-start conversation with top match
      const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
      const convLinks: string[] = [];
      const queryDesc = [categories?.join(", "), tags?.join(", ")].filter(Boolean).join(" — ") || "strukturert søk";
      for (const r of results.slice(0, 2)) {
        try {
          const conv = conversationService.startConversation({
            sellerAgentId: r.agent.id,
            queryText: queryDesc,
            source: "mcp",
            autoRespond: true,
          });
          convLinks.push(`💬 [Samtale med ${conv.sellerAgentName}](${BASE}/samtale/${conv.id})`);
        } catch { /* non-critical */ }
      }

      const header = `🔍 **Strukturert søk** — ${results.length} resultater:\n`;
      const lines = results.map((r: any, i: number) => {
        const dist = r.distanceKm ? ` (${r.distanceKm.toFixed(1)} km)` : "";
        return formatAgentCompact(r.agent, i + 1, r.contact) + dist;
      });

      const convSection = convLinks.length
        ? `\n\n---\n**Samtaler startet automatisk:**\n${convLinks.join("\n")}`
        : "";

      return { content: [{ type: "text" as const, text: header + "\n" + lines.join("\n\n") + convSection }] };
    }
  );

  // Tool 3: Producer details
  server.tool(
    "lokal_info",
    "Get detailed information about a specific Lokal producer — address, products, opening hours, certifications, and contact info.",
    {
      agentId: z.string().describe("The producer's agent ID (UUID)"),
    },
    async ({ agentId }) => {
      const info = knowledgeService.getAgentInfo(agentId);
      if (!info) {
        return { content: [{ type: "text" as const, text: `Fant ingen produsent med ID ${agentId}.` }] };
      }

      const { agent, knowledge: k = {} as any, meta = {} as any } = info;
      const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";
      const sections: string[] = [`# ${agent.name}`];

      if (agent.city) {
        sections.push(`📍 ${agent.city}${agent.trustScore ? `  ·  Trust ${Math.round(agent.trustScore * 100)}%` : ""}${agent.isVerified ? "  ·  ✔ Verifisert" : ""}`);
      }

      if (k.about) sections.push(`\n${k.about}`);

      // Contact
      const contact: string[] = [];
      if (k.address) contact.push(`📍 ${k.address}${k.postalCode ? `, ${k.postalCode}` : ""}`);
      if (k.phone) contact.push(`📞 ${k.phone}`);
      if (k.email) contact.push(`✉️ ${k.email}`);
      if (k.website) contact.push(`🌐 ${k.website}`);
      if (contact.length) sections.push(`\n## Kontakt\n${contact.join("\n")}`);

      // vCard
      sections.push(`\n🪪 [Last ned kontaktkort (vCard)](${BASE_URL}/api/marketplace/agents/${agent.id}/vcard)`);

      // Opening hours
      if (k.openingHours?.length) {
        const dayNames: Record<string, string> = { mon: "Man", tue: "Tir", wed: "Ons", thu: "Tor", fri: "Fre", sat: "Lør", sun: "Søn" };
        const hours = k.openingHours.map((h: any) => `${dayNames[h.day] || h.day} ${h.open}–${h.close}`).join(", ");
        sections.push(`\n## Åpningstider\n${hours}`);
      }

      // Products
      if (k.products?.length) {
        const productLines = k.products.map((p: any) => {
          const seasonal = p.seasonal && p.months?.length ? ` _(sesong: mnd ${p.months.join(", ")})_` : "";
          return `- ${p.name}${p.category ? ` — ${p.category}` : ""}${seasonal}`;
        });
        sections.push(`\n## Produkter\n${productLines.join("\n")}`);
      }

      if (k.specialties?.length) sections.push(`\n## Spesialiteter\n${k.specialties.map((s: string) => `- ${s}`).join("\n")}`);
      if (k.certifications?.length) sections.push(`\n## Sertifiseringer\n${k.certifications.map((c: string) => `- ${c}`).join("\n")}`);
      if (k.paymentMethods?.length) sections.push(`\n💳 **Betaling:** ${k.paymentMethods.join(", ")}`);
      if (k.deliveryOptions?.length) sections.push(`🚚 **Levering:** ${k.deliveryOptions.join(", ")}`);

      if (meta.disclaimer) {
        const src = meta.autoSources?.length ? ` (kilder: ${meta.autoSources.join(", ")})` : "";
        sections.push(`\n---\n_${meta.disclaimer}${src}_`);
      }

      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    }
  );

  // Tool 4: Platform stats
  server.tool(
    "lokal_stats",
    "Get Lokal platform statistics — total agents, cities covered, interactions.",
    {},
    async () => {
      const stats = marketplaceRegistry.getStats();
      const text = [
        "📊 **Lokal — Plattformstatistikk**",
        `Totalt agenter: ${stats.totalAgents || "?"}`,
        `Byer: ${stats.cities || "?"}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ─── MCP Resources ──────────────────────────────────────────
  // Resources let agents READ data directly (vs tools which are actions).
  // This is the MCP equivalent of a database view.

  server.resource(
    "producers-overview",
    "lokal://producers/overview",
    { description: "Overview of all local food producers — count, cities, and categories", mimeType: "text/plain" },
    async () => {
      const agents = marketplaceRegistry.getActiveAgents();
      const cities = new Map<string, number>();
      for (const a of agents) {
        const city = (a as any).city || a.location?.city || "Ukjent";
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
    }
  );

  server.resource(
    "producer-detail",
    "lokal://producers/{agentId}",
    { description: "Detailed info about a specific food producer", mimeType: "application/json" },
    async (uri) => {
      const agentId = uri.pathname?.split("/").pop() || "";
      const info = knowledgeService.getAgentInfo(agentId);
      if (!info) {
        return { contents: [{ uri: uri.href, text: "Producer not found", mimeType: "text/plain" }] };
      }
      return { contents: [{ uri: uri.href, text: JSON.stringify(info, null, 2), mimeType: "application/json" }] };
    }
  );
}

// ─── Compact agent formatter ────────────────────────────────

function formatAgentCompact(agent: any, idx: number, contact?: any): string {
  const lines = [`**${idx}. ${agent.name}**`];
  if (agent.description) lines.push(`   ${agent.description}`);

  const meta: string[] = [];
  if ((agent as any).city || agent.location?.city) meta.push(`📍 ${(agent as any).city || agent.location?.city}`);
  if (agent.categories?.length) meta.push(`🏷️ ${agent.categories.join(", ")}`);
  if (agent.trustScore) meta.push(`✅ Trust ${Math.round(agent.trustScore * 100)}%`);
  if (meta.length) lines.push(`   ${meta.join("  ·  ")}`);

  if (contact) {
    const cl: string[] = [];
    if (contact.address) cl.push(`📍 ${contact.address}`);
    if (contact.phone) cl.push(`📞 ${contact.phone}`);
    if (contact.email) cl.push(`✉️ ${contact.email}`);
    if (contact.website) cl.push(`🌐 ${contact.website}`);
    if (cl.length) lines.push(`   ${cl.join("  ·  ")}`);
  }

  return lines.join("\n");
}

// ─── Session management ─────────────────────────────────────
// Each MCP client (ChatGPT session) gets its own transport+server pair.
// Sessions are cleaned up after 30 min of inactivity.

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

const sessions = new Map<string, McpSession>();
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

async function getOrCreateSession(sessionId?: string): Promise<{ id: string; session: McpSession }> {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    return { id: sessionId, session };
  }

  // Create new session
  const id = sessionId || randomUUID();
  const server = new McpServer({ name: "lokal", version: "0.3.0" });
  registerTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
  });

  await server.connect(transport);

  const session: McpSession = { transport, server, lastActivity: Date.now() };
  sessions.set(id, session);
  return { id, session };
}

// ─── Routes ─────────────────────────────────────────────────

// POST /mcp — Main MCP message handler (JSON-RPC over HTTP)
router.post("/", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const { session } = await getOrCreateSession(sessionId);
    await session.transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("MCP POST error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP transport error" });
    }
  }
});

// GET /mcp — SSE stream for server-to-client notifications
router.get("/", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Missing or invalid mcp-session-id header" });
    return;
  }
  const session = sessions.get(sessionId)!;
  session.lastActivity = Date.now();
  await session.transport.handleRequest(req, res, req.body);
});

// DELETE /mcp — Session cleanup
router.delete("/", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.transport.close?.();
    sessions.delete(sessionId);
  }
  res.status(200).json({ ok: true });
});

export default router;
