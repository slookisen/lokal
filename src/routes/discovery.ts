/**
 * Discovery Routes — All agent/AI/LLM discovery endpoints
 *
 * These routes make rettfrabonden.com discoverable by:
 *   1. LLMs (ChatGPT, Claude, Perplexity) via /llms.txt and /llms-full.txt
 *   2. MCP clients via /.well-known/mcp/server-card.json
 *   3. Future IETF agents via /.well-known/agents.txt
 *   4. OpenAPI/Swagger consumers via /openapi.json
 *
 * Why a separate file? seo.ts handles human-facing HTML pages.
 * This file handles machine-facing discovery documents.
 */

import { Router, Request, Response } from "express";
import { marketplaceRegistry } from "../services/marketplace-registry";
import { knowledgeService } from "../services/knowledge-service";

const router = Router();
const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";

// Helper: slugify (same as seo.ts)
function slugify(str: string): string {
  return str.toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ═══════════════════════════════════════════════════════════════
// 1. GET /llms.txt — LLM-friendly site overview (Markdown)
//
// When ChatGPT, Claude, or Perplexity encounter our domain,
// they check /llms.txt for a structured summary of what we are.
// This is the single highest-impact discovery file we can add.
// ═══════════════════════════════════════════════════════════════

router.get("/llms.txt", (_req: Request, res: Response) => {
  try {
    const agents = marketplaceRegistry.getActiveAgents();
    const stats = marketplaceRegistry.getStats();

    // Count categories and cities
    const cities = new Map<string, number>();
    const categories = new Map<string, number>();
    for (const a of agents) {
      const city = (a as any).city || a.location?.city;
      if (city) cities.set(city, (cities.get(city) || 0) + 1);
      const cats = Array.isArray(a.categories) ? a.categories : (typeof a.categories === "string" ? JSON.parse(a.categories || "[]") : []);
      for (const c of cats) categories.set(c, (categories.get(c) || 0) + 1);
    }

    const topCities = [...cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    const topCats = [...categories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

    res.header("Content-Type", "text/plain; charset=utf-8");
    res.header("Cache-Control", "public, max-age=3600");
    res.send(`# Rett fra Bonden — Lokal mat i Norge

> Norges første agent-til-agent (A2A) markedsplass for lokal mat. Vi kobler forbrukere direkte med ${agents.length}+ lokale matprodusenter — gårder, bondensmarkeder, REKO-ringer, gårdsbutikker og kooperativer over hele Norge. Ingen mellomledd, ingen reklame, bare ekte mat rett fra bonden.

> Norway's first agent-to-agent (A2A) marketplace for local food. We connect consumers directly with ${agents.length}+ local food producers — farms, farmers' markets, REKO rings, farm shops, and cooperatives across Norway.

## Hva er dette?

Rett fra Bonden er en åpen plattform som lar AI-agenter finne, sammenligne og kontakte lokale matprodusenter i Norge. Plattformen støtter tre protokoller: A2A (agent-til-agent), MCP (Model Context Protocol), og REST API.

## Nøkkeltall

- ${agents.length} registrerte produsenter
- ${topCities.length} byer dekket
- ${topCats.length}+ matkategorier
- Oppdateres daglig med nye produsenter og data

## Byer med produsenter

${topCities.map(([city, count]) => `- [${city} (${count} produsenter)](${BASE_URL}/${slugify(city)})`).join("\n")}

## Matkategorier

${topCats.map(([cat, count]) => `- ${cat} (${count} produsenter)`).join("\n")}

## For AI-agenter

- [A2A Agent Card (JSON)](${BASE_URL}/.well-known/agent-card.json): Maskinlesbar beskrivelse av plattformen
- [MCP Endpoint](${BASE_URL}/mcp): Model Context Protocol for ChatGPT, Claude, Cursor
- [MCP Server Card](${BASE_URL}/.well-known/mcp/server-card.json): MCP server discovery metadata
- [REST API](${BASE_URL}/api/marketplace/agents): Alle produsenter som JSON
- [Søk API](${BASE_URL}/api/marketplace/search?q=): Fritekst-søk
- [OpenAPI Spec](${BASE_URL}/openapi.json): Fullstendig API-dokumentasjon

## For mennesker

- [Forsiden](${BASE_URL}/): Søk og utforsk lokale matprodusenter
- [Om oss](${BASE_URL}/om): Historien bak plattformen
- [Teknologi](${BASE_URL}/teknologi): Hvordan A2A-teknologien fungerer
- [Personvern](${BASE_URL}/personvern): Ingen cookies, ingen sporing

## Kontakt

- Nettside: ${BASE_URL}
- GitHub: https://github.com/slookisen/lokal
- npm: https://www.npmjs.com/package/lokal-food-mcp

## Lisens

Åpen kildekode. All produsentdata er offentlig tilgjengelig og fri å bruke for søk og sitering.
`);
  } catch (err) {
    console.error("llms.txt error:", err);
    res.status(500).send("Error generating llms.txt");
  }
});

// ═══════════════════════════════════════════════════════════════
// 6. GET /llms-full.txt — Complete producer dump for LLMs
//
// Full markdown with every producer's name, city, categories,
// and contact info. An LLM that reads this can answer questions
// like "where can I buy organic honey near Bergen?"
// ═══════════════════════════════════════════════════════════════

router.get("/llms-full.txt", (_req: Request, res: Response) => {
  try {
    const agents = marketplaceRegistry.getActiveAgents();
    const lines: string[] = [
      `# Rett fra Bonden — Komplett produsentoversikt`,
      ``,
      `> ${agents.length} lokale matprodusenter i Norge. Oppdatert ${new Date().toISOString().split("T")[0]}.`,
      ``,
      `## Alle produsenter`,
      ``,
    ];

    // Group by city
    const byCity = new Map<string, any[]>();
    for (const a of agents) {
      const city = (a as any).city || a.location?.city || "Ukjent";
      if (!byCity.has(city)) byCity.set(city, []);
      byCity.get(city)!.push(a);
    }

    // Sort cities by count
    const sortedCities = [...byCity.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [city, cityAgents] of sortedCities) {
      lines.push(`### ${city} (${cityAgents.length} produsenter)`);
      lines.push(``);
      for (const a of cityAgents) {
        const cats = Array.isArray(a.categories) ? a.categories : (typeof a.categories === "string" ? JSON.parse(a.categories || "[]") : []);
        const k = knowledgeService.getKnowledge(a.id);
        const parts: string[] = [`- **${a.name}**`];
        if (cats.length) parts.push(`Kategorier: ${cats.join(", ")}`);
        if (k?.phone) parts.push(`Tlf: ${k.phone}`);
        if (k?.website) parts.push(`Web: ${k.website}`);
        if (k?.about) parts.push(k.about.substring(0, 120));
        lines.push(parts.join(" | "));
      }
      lines.push(``);
    }

    lines.push(`## Lenker`);
    lines.push(``);
    lines.push(`- [Søk etter produsenter](${BASE_URL}/sok)`);
    lines.push(`- [A2A Agent Card](${BASE_URL}/.well-known/agent-card.json)`);
    lines.push(`- [MCP Endpoint](${BASE_URL}/mcp)`);
    lines.push(`- [API](${BASE_URL}/api/marketplace/agents)`);

    res.header("Content-Type", "text/plain; charset=utf-8");
    res.header("Cache-Control", "public, max-age=7200"); // 2h cache — data changes slowly
    res.send(lines.join("\n"));
  } catch (err) {
    console.error("llms-full.txt error:", err);
    res.status(500).send("Error generating llms-full.txt");
  }
});

// ═══════════════════════════════════════════════════════════════
// 2. GET /.well-known/mcp/server-card.json — MCP Server Discovery
//
// SEP-1649: lets MCP clients auto-discover our capabilities
// before connecting. Cursor, Claude Desktop, ChatGPT can find
// us by just hitting this URL.
// ═══════════════════════════════════════════════════════════════

router.get("/.well-known/mcp/server-card.json", (_req: Request, res: Response) => {
  const stats = marketplaceRegistry.getStats();
  res.header("Content-Type", "application/json");
  res.header("Cache-Control", "public, max-age=3600");
  res.header("X-Content-Type-Options", "nosniff");
  res.json({
    "$schema": "https://modelcontextprotocol.io/schemas/server-card/v1.0",
    version: "1.0",
    protocolVersion: "2025-06-18",
    serverInfo: {
      name: "Rett fra Bonden — Lokal Mat MCP",
      version: "1.0.0",
      description: "MCP server for local food in Norway. Search and discover " +
        `${stats.totalAgents || "1400+"}` +
        " local food producers — farms, markets, REKO rings. " +
        "Supports natural language search in Norwegian and English.",
      homepage: BASE_URL,
      documentation: `${BASE_URL}/teknologi`,
      repository: "https://github.com/slookisen/lokal",
    },
    transport: {
      type: "streamable-http",
      url: `${BASE_URL}/mcp`,
    },
    capabilities: {
      tools: true,
      resources: true,
      prompts: false,
    },
    tools: [
      {
        name: "lokal_search",
        description: "Search for local food producers using natural language (Norwegian or English)",
      },
      {
        name: "lokal_discover",
        description: "Discover producers by category, city, tags, and location with structured filters",
      },
      {
        name: "lokal_info",
        description: "Get detailed info about a specific producer — address, products, hours, ratings",
      },
      {
        name: "lokal_register",
        description: "Register a new food producer in the marketplace",
      },
    ],
    security: {
      authentication: "none",
      note: "Read operations are open. Write operations require an API key.",
    },
  });
});

// SEP-1960: /.well-known/mcp manifest (endpoint enumeration)
router.get("/.well-known/mcp", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json");
  res.header("Cache-Control", "public, max-age=3600");
  res.header("X-Content-Type-Options", "nosniff");
  res.json({
    mcp_version: "2025-06-18",
    endpoints: [
      {
        url: `${BASE_URL}/mcp`,
        transport: "streamable-http",
        capabilities: ["tools", "resources"],
        description: "Primary MCP endpoint for local food search in Norway",
      },
    ],
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. GET /.well-known/agents.txt — IETF Agent Discovery
//
// Emerging standard (expired draft, but still parsed by tools).
// Declares what AI agents can do on our site.
// ═══════════════════════════════════════════════════════════════

function serveAgentsTxt(_req: Request, res: Response) {
  const agents = marketplaceRegistry.getActiveAgents();
  res.header("Content-Type", "text/plain; charset=utf-8");
  res.header("Cache-Control", "public, max-age=3600");
  res.send(`# agents.txt — rettfrabonden.com
# AI Agent Discovery File
# See: https://github.com/dennj/agents.txt

User-agent: *
Allow-actions: search, read, discover, compare
Disallow-actions: modify, delete, register-without-key

# Agent endpoints
Agent-card: ${BASE_URL}/.well-known/agent-card.json
MCP-endpoint: ${BASE_URL}/mcp
A2A-endpoint: ${BASE_URL}/a2a
API-base: ${BASE_URL}/api/marketplace

# Capabilities
Name: Rett fra Bonden
Description: Local food marketplace with ${agents.length}+ producers in Norway
Languages: no, en
Categories: food, marketplace, local-commerce, organic, farm-direct
Region: NO

# Rate limits
Rate-limit: 300 requests per 15 minutes (general)
Rate-limit: 500 requests per hour (admin)

# Contact
Contact: https://github.com/slookisen/lokal/issues
`);
}

router.get("/.well-known/agents.txt", serveAgentsTxt);
// Root alias — some agent-discovery conventions look at /agents.txt directly
// rather than /.well-known/agents.txt. Serve both so we don't miss crawlers.
router.get("/agents.txt", serveAgentsTxt);

// Also serve agents.json (AWP format)
router.get("/.well-known/agents.json", (_req: Request, res: Response) => {
  const agents = marketplaceRegistry.getActiveAgents();
  res.header("Content-Type", "application/json");
  res.header("Cache-Control", "public, max-age=3600");
  res.json({
    schema_version: "1.0",
    name: "Rett fra Bonden",
    description: `Local food marketplace with ${agents.length}+ producers in Norway`,
    url: BASE_URL,
    capabilities: {
      search: { endpoint: `${BASE_URL}/api/marketplace/search`, method: "GET" },
      discover: { endpoint: `${BASE_URL}/api/marketplace/discover`, method: "POST" },
      agent_card: { endpoint: `${BASE_URL}/.well-known/agent-card.json`, method: "GET" },
      mcp: { endpoint: `${BASE_URL}/mcp`, transport: "streamable-http" },
      a2a: { endpoint: `${BASE_URL}/a2a`, transport: "json-rpc" },
    },
    authentication: {
      read: "none",
      write: "api-key",
    },
    rate_limits: {
      general: "300/15min",
      admin: "500/hr",
    },
    languages: ["no", "en"],
    region: "NO",
    categories: ["food", "marketplace", "local-commerce"],
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. GET /openapi.json — OpenAPI 3.1 specification
//
// Lets any API client (Postman, Swagger UI, AI agents) understand
// our REST API structure. This is the gold standard for API docs.
// ═══════════════════════════════════════════════════════════════

router.get("/openapi.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json");
  res.header("Cache-Control", "public, max-age=86400");
  res.json({
    openapi: "3.1.0",
    info: {
      title: "Rett fra Bonden — Local Food API",
      version: "1.0.0",
      description: "REST API for discovering local food producers in Norway. " +
        "Supports search, discovery, registration, and agent-to-agent communication.",
      contact: { url: "https://github.com/slookisen/lokal" },
      license: { name: "MIT", url: "https://github.com/slookisen/lokal/blob/main/LICENSE" },
    },
    servers: [{ url: BASE_URL, description: "Production" }],
    paths: {
      "/api/marketplace/search": {
        get: {
          summary: "Search producers by natural language query",
          operationId: "searchProducers",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" }, description: "Search query (Norwegian or English)" },
            { name: "limit", in: "query", schema: { type: "integer", default: 20 }, description: "Max results" },
          ],
          responses: { "200": { description: "Search results with ranked producers" } },
        },
      },
      "/api/marketplace/agents": {
        get: {
          summary: "List all active producers",
          operationId: "listProducers",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { "200": { description: "Array of producer agents" } },
        },
      },
      "/api/marketplace/agents/{id}": {
        get: {
          summary: "Get a specific producer by ID",
          operationId: "getProducer",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Producer details with knowledge" },
            "404": { description: "Producer not found" },
          },
        },
      },
      "/api/marketplace/discover": {
        post: {
          summary: "Discover producers with structured filters",
          operationId: "discoverProducers",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    categories: { type: "array", items: { type: "string" } },
                    tags: { type: "array", items: { type: "string" } },
                    location: {
                      type: "object",
                      properties: { lat: { type: "number" }, lng: { type: "number" } },
                    },
                    maxDistanceKm: { type: "number" },
                    limit: { type: "integer", default: 20 },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Matched producers with relevance scores" } },
        },
      },
      "/api/marketplace/register": {
        post: {
          summary: "Register a new food producer",
          operationId: "registerProducer",
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    role: { type: "string", enum: ["producer", "consumer", "logistics"] },
                    categories: { type: "array", items: { type: "string" } },
                    location: {
                      type: "object",
                      properties: { lat: { type: "number" }, lng: { type: "number" }, city: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Registered agent with API key" },
          },
        },
      },
      "/a2a": {
        post: {
          summary: "A2A JSON-RPC 2.0 endpoint",
          operationId: "a2aJsonRpc",
          description: "Agent-to-agent communication. Supports methods: message/send, tasks/get, tasks/list, agent/info",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["jsonrpc", "method", "id"],
                  properties: {
                    jsonrpc: { type: "string", const: "2.0" },
                    method: { type: "string", enum: ["message/send", "tasks/get", "tasks/list", "agent/info"] },
                    params: { type: "object" },
                    id: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "JSON-RPC response" } },
        },
      },
      "/mcp": {
        post: {
          summary: "MCP Streamable HTTP endpoint",
          operationId: "mcpEndpoint",
          description: "Model Context Protocol endpoint for AI assistants (ChatGPT, Claude, Cursor)",
          responses: { "200": { description: "MCP response" } },
        },
      },
      "/.well-known/agent-card.json": {
        get: {
          summary: "A2A Agent Card",
          operationId: "getAgentCard",
          description: "Machine-readable description of this marketplace's capabilities",
          responses: { "200": { description: "A2A Agent Card JSON" } },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "X-Admin-Key",
        },
      },
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. GET /privacy — Privacy policy (bilingual NO/EN)
//
// Required for listing in the Anthropic Claude Connectors Directory
// and similar AI marketplaces that verify data-handling practices.
// Kept minimal + factual: only describes what we actually do.
// ═══════════════════════════════════════════════════════════════

router.get(["/privacy", "/privacy-policy", "/personvern"], (_req: Request, res: Response) => {
  res.header("Content-Type", "text/html; charset=utf-8");
  res.header("Cache-Control", "public, max-age=3600");
  res.send(`<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="utf-8">
<title>Personvern / Privacy — Rett fra Bonden</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Privacy policy for Rett fra Bonden (rettfrabonden.com) — A2A marketplace for local food in Norway.">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.6; }
  h1 { border-bottom: 2px solid #2d5016; padding-bottom: 0.3rem; }
  h2 { color: #2d5016; margin-top: 2rem; }
  code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
  .lang-switch { text-align: right; margin-bottom: 1rem; font-size: 0.9rem; }
  .lang-switch a { color: #2d5016; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ddd; font-size: 0.85rem; color: #666; }
</style>
</head>
<body>
<div class="lang-switch"><a href="#en">English</a></div>

<h1>Personvern</h1>
<p><strong>Sist oppdatert:</strong> 20. april 2026</p>

<p>Rett fra Bonden (rettfrabonden.com) er en agent-til-agent-markedsplass som hjelper AI-agenter
med å finne lokale matprodusenter i Norge. Vi respekterer personvernet til produsenter, brukere
og AI-agenter som samhandler med plattformen.</p>

<h2>Hva vi samler inn</h2>
<ul>
  <li><strong>Produsentdata:</strong> Navn, adresse, kontaktinformasjon, produkter og åpningstider.
    Dette er offentlig tilgjengelig informasjon som produsentene selv har publisert, eller som er
    samlet fra offentlige kilder (nettsider, Brønnøysundregistrene, HANEN, Visit Norway, Google Maps
    med flere).</li>
  <li><strong>Agent-forespørsler:</strong> Vi logger hvilke agenter (ChatGPT, Claude, Perplexity m.fl.)
    som gjør søk, hvilke søkeord som brukes, og hvilke produsenter som blir vist — i aggregert form,
    uten IP-adresser eller personlige identifikatorer.</li>
  <li><strong>Eier-henvendelser:</strong> Hvis en produsent tar kontakt for å "claim" sin egen agentprofil,
    lagrer vi e-postadresse og verifikasjonskode så lenge det er nødvendig for å bekrefte eierskap.</li>
</ul>

<h2>Hva vi IKKE samler inn</h2>
<ul>
  <li>Vi setter ingen sporingscookies.</li>
  <li>Vi bruker ingen tredjeparts analyseverktøy (Google Analytics, Meta, osv.).</li>
  <li>Vi behandler ingen betalinger og lagrer ingen betalingskortopplysninger.</li>
  <li>Vi selger ikke data til tredjepart.</li>
</ul>

<h2>Lagringstid</h2>
<p>Aggregerte analytikkdata lagres i opptil 180 dager. Produsentdata som kommer fra offentlige kilder
lagres så lenge produsenten er aktiv. Produsenter kan når som helst be om å bli fjernet (se under).</p>

<h2>Rettighetene dine</h2>
<p>Er du produsent og ønsker å bli fjernet fra katalogen, eller ønsker å korrigere informasjon om
deg selv? Send en e-post til <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a>.
Vi svarer innen rimelig tid og fjerner/oppdaterer oppføringen.</p>

<h2>Kontakt</h2>
<p>E-post: <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a><br>
Operatør: Daniel Fredriksen, Norge.</p>

<hr>

<h1 id="en">Privacy Policy</h1>
<p><strong>Last updated:</strong> 20 April 2026</p>

<p>Rett fra Bonden (rettfrabonden.com) is an agent-to-agent marketplace that helps AI agents find
local food producers in Norway. We respect the privacy of producers, end-users, and AI agents that
interact with the platform.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Producer data:</strong> Name, address, contact details, products, and opening hours.
    This is publicly available information either self-published by the producer or gathered from
    public sources (websites, the Norwegian business registry, HANEN, Visit Norway, Google Maps,
    and similar directories).</li>
  <li><strong>Agent requests:</strong> We log which agents (ChatGPT, Claude, Perplexity, etc.) perform
    searches, which search terms are used, and which producers are shown — in aggregated form,
    without IP addresses or personal identifiers.</li>
  <li><strong>Ownership claims:</strong> When a producer contacts us to claim their own agent profile
    we store their email address and a verification code for as long as necessary to confirm ownership.</li>
</ul>

<h2>What we do NOT collect</h2>
<ul>
  <li>No tracking cookies.</li>
  <li>No third-party analytics (Google Analytics, Meta, etc.).</li>
  <li>No payment processing or card data.</li>
  <li>We do not sell data to third parties.</li>
</ul>

<h2>Retention</h2>
<p>Aggregated analytics data is retained for up to 180 days. Producer data sourced from public
records is retained while the producer is active. Producers may request removal at any time.</p>

<h2>Your rights</h2>
<p>Are you a producer who wants to be removed from the directory or correct information about you?
Email <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a>. We respond promptly
and remove or update the entry.</p>

<h2>Contact</h2>
<p>Email: <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a><br>
Operator: Daniel Fredriksen, Norway.</p>

<footer>
  Rett fra Bonden · <a href="/">rettfrabonden.com</a> ·
  <a href="/.well-known/agent-card.json">Agent Card</a> ·
  <a href="https://github.com/slookisen/lokal">Source</a>
</footer>
</body>
</html>`);
});

export default router;
