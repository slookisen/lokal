/**
 * Agent Readiness endpoints
 * ─────────────────────────
 * Implements the emerging set of "well-known" discovery standards that
 * AI agents use to find and understand a site's capabilities:
 *
 *   /.well-known/mcp/server-card.json       (SEP-1649)   — MCP server discovery
 *   /.well-known/mcp.json                   (legacy)
 *   /.well-known/agent-skills/index.json    (v0.2.0)     — Agent Skills index
 *   /.well-known/skills/index.json          (legacy path)
 *   /.well-known/api-catalog                (RFC 9727)   — API catalog linkset
 *   /.well-known/oauth-protected-resource   (RFC 9728)   — declares apiKey auth
 *
 * These are all pure JSON read-only endpoints — no state, no mutations.
 * We keep them in one file so there's a single place to update when any
 * spec moves forward.
 */

import { Router, Request, Response } from "express";
import { marketplaceRegistry } from "../services/marketplace-registry";

const router = Router();

const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";

// ═══════════════════════════════════════════════════════════════
// MCP Server Card (SEP-1649)
// ═══════════════════════════════════════════════════════════════
// We already run an MCP HTTP server at /mcp. This card lets agents
// discover it without hitting the endpoint first.
function mcpServerCard() {
  const stats = marketplaceRegistry.getStats();

  return {
    $schema: "https://modelcontextprotocol.io/schemas/2025-11/server-card.schema.json",
    schemaVersion: "2025-11",
    name: "lokal",
    title: "Lokal — A2A marketplace for local food in Norway",
    version: "1.0.0",
    description:
      `Discover and negotiate with ${stats.totalAgents || "1,180+"} verified Norwegian food producers. ` +
      "Search by category, region, certification, and trust score. Supports " +
      "natural-language queries in Norwegian and English.",
    homepage: BASE_URL,
    repository: {
      type: "git",
      url: "https://github.com/slookisen/lokal",
    },
    documentation: `${BASE_URL}/teknologi`,
    icon: `${BASE_URL}/favicon.ico`,
    vendor: {
      name: "Lokal",
      url: BASE_URL,
    },
    license: "MIT",
    endpoints: [
      {
        protocol: "https+mcp",
        url: `${BASE_URL}/mcp`,
        description: "Remote MCP HTTP transport. Compatible with ChatGPT connectors and remote Claude.",
      },
    ],
    transports: ["http", "streamable-http"],
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false },
    },
    tools: [
      { name: "search_producers", description: "Natural-language search across all producers." },
      { name: "discover_by_category", description: "Find producers by category and region." },
      { name: "get_producer", description: "Fetch full details for a specific producer." },
      { name: "register_producer", description: "Register a new food producer agent." },
      { name: "start_negotiation", description: "Open a buyer–seller negotiation channel." },
    ],
    authentication: {
      schemes: ["apiKey"],
      header: "X-API-Key",
      description:
        "Read-only calls (search, discover, get) are open. Write operations require an API key.",
    },
    keywords: [
      "local food",
      "a2a",
      "agent-to-agent",
      "marketplace",
      "norway",
      "norge",
      "organic",
      "farm-direct",
      "kortreist",
    ],
    contact: {
      url: `${BASE_URL}/om`,
    },
    "x-lokal": {
      region: "Norway",
      totalProducers: stats.totalAgents,
      languages: ["no", "en"],
    },
  };
}

router.get("/.well-known/mcp/server-card.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json(mcpServerCard());
});

// Legacy / alternate paths the scanner also checks
router.get("/.well-known/mcp.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json(mcpServerCard());
});

// Hyphenated alias — probed by some MCP directory scanners
// (e.g. NotHumanSearch-style crawlers) as `/.well-known/mcp-server.json`.
router.get("/.well-known/mcp-server.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json(mcpServerCard());
});

router.get("/.well-known/mcp/server-cards.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  // Array wrapper form — some aggregators expect an array of cards.
  res.json([mcpServerCard()]);
});

// ═══════════════════════════════════════════════════════════════
// Agent Skills index
// ═══════════════════════════════════════════════════════════════
// Defines the 4 high-level agent-facing skills our marketplace exposes.
// Used by agent runtimes (Claude, ChatGPT, Cursor, etc.) to populate
// skill pickers and action menus.
function agentSkillsIndex() {
  const stats = marketplaceRegistry.getStats();
  const count = stats.totalAgents || "1,180+";
  return {
    $schema: "https://agentskills.io/schemas/v0.2.0/index.schema.json",
    version: "0.2.0",
    provider: {
      name: "Lokal",
      url: BASE_URL,
      description: "A2A marketplace for local Norwegian food producers.",
    },
    skills: [
      {
        id: "discover-local-food-agents",
        name: "Discover Local Food Agents",
        description:
          `Search ${count} verified Norwegian producers. Filter by category, region, certification, and trust score.`,
        url: `${BASE_URL}/.well-known/agent-skills/discover-local-food-agents`,
        tags: ["search", "discovery", "local-food", "norway"],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json"],
        invocation: {
          mcp: { server: `${BASE_URL}/mcp`, tool: "search_producers" },
          a2a: { endpoint: `${BASE_URL}/a2a`, method: "message/send" },
          rest: { endpoint: `${BASE_URL}/api/marketplace/search`, method: "GET" },
        },
      },
      {
        id: "register-food-agent",
        name: "Register Food Producer Agent",
        description:
          "Onboard a new farm, shop, or cooperative. Once registered, the producer gets an A2A Agent Card and becomes discoverable.",
        url: `${BASE_URL}/.well-known/agent-skills/register-food-agent`,
        tags: ["registration", "onboarding", "producer"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        invocation: {
          a2a: { endpoint: `${BASE_URL}/a2a`, method: "message/send" },
          rest: { endpoint: `${BASE_URL}/api/marketplace/register`, method: "POST" },
        },
      },
      {
        id: "search-compare-food",
        name: "Search & Compare Local Food",
        description:
          "Natural-language search across producers. Compare prices, delivery options, organic certifications, availability.",
        url: `${BASE_URL}/.well-known/agent-skills/search-compare-food`,
        tags: ["search", "compare", "price", "delivery"],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["application/json"],
        invocation: {
          mcp: { server: `${BASE_URL}/mcp`, tool: "discover_by_category" },
          rest: { endpoint: `${BASE_URL}/api/marketplace/search`, method: "GET" },
        },
      },
      {
        id: "agent-conversation",
        name: "Start Agent Negotiation",
        description:
          "Initiate a buyer-seller conversation. Offer / accept / reject flow with full transaction tracking.",
        url: `${BASE_URL}/.well-known/agent-skills/agent-conversation`,
        tags: ["negotiate", "conversation", "order", "transaction"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        invocation: {
          a2a: { endpoint: `${BASE_URL}/a2a`, method: "message/send" },
        },
      },
    ],
  };
}

router.get("/.well-known/agent-skills/index.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json(agentSkillsIndex());
});

// Legacy path
router.get("/.well-known/skills/index.json", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json(agentSkillsIndex());
});

// Individual skill stubs — minimal but valid so the index links don't 404.
const SKILL_DETAILS: Record<string, { id: string; title: string; mcpTool?: string; rest?: string }> = {
  "discover-local-food-agents": {
    id: "discover-local-food-agents",
    title: "Discover Local Food Agents",
    mcpTool: "search_producers",
    rest: "/api/marketplace/search",
  },
  "register-food-agent": {
    id: "register-food-agent",
    title: "Register Food Producer Agent",
    rest: "/api/marketplace/register",
  },
  "search-compare-food": {
    id: "search-compare-food",
    title: "Search & Compare Local Food",
    mcpTool: "discover_by_category",
    rest: "/api/marketplace/search",
  },
  "agent-conversation": {
    id: "agent-conversation",
    title: "Start Agent Negotiation",
    rest: "/api/marketplace/conversations",
  },
};

router.get("/.well-known/agent-skills/:id", (req: Request, res: Response) => {
  const detail = SKILL_DETAILS[req.params.id as string];
  if (!detail) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }
  res.header("Content-Type", "application/json; charset=utf-8");
  res.json({
    version: "0.2.0",
    ...detail,
    homepage: BASE_URL,
    documentation: `${BASE_URL}/teknologi`,
  });
});

// ═══════════════════════════════════════════════════════════════
// API Catalog (RFC 9727)
// ═══════════════════════════════════════════════════════════════
// Linkset+json format. Points agents at our OpenAPI spec and the
// A2A / MCP entrypoints so they can auto-wire themselves.
router.get("/.well-known/api-catalog", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/linkset+json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json({
    linkset: [
      {
        anchor: `${BASE_URL}/`,
        "service-desc": [
          {
            href: `${BASE_URL}/openapi.yaml`,
            type: "application/yaml",
            title: "Lokal REST API — OpenAPI 3.0 specification",
          },
        ],
        "service-doc": [
          {
            href: `${BASE_URL}/teknologi`,
            type: "text/html",
            title: "Developer documentation",
          },
        ],
        "service-meta": [
          {
            href: `${BASE_URL}/.well-known/agent-card.json`,
            type: "application/json",
            title: "A2A Agent Card (v1.0.0)",
          },
          {
            href: `${BASE_URL}/.well-known/mcp/server-card.json`,
            type: "application/json",
            title: "MCP Server Card (SEP-1649)",
          },
          {
            href: `${BASE_URL}/.well-known/agent-skills/index.json`,
            type: "application/json",
            title: "Agent Skills index",
          },
        ],
      },
      {
        anchor: `${BASE_URL}/a2a`,
        "service-desc": [
          {
            href: `${BASE_URL}/.well-known/agent-card.json`,
            type: "application/json",
            title: "A2A JSON-RPC endpoint card",
          },
        ],
      },
      {
        anchor: `${BASE_URL}/mcp`,
        "service-desc": [
          {
            href: `${BASE_URL}/.well-known/mcp/server-card.json`,
            type: "application/json",
            title: "MCP server card",
          },
        ],
      },
    ],
  });
});

// ═══════════════════════════════════════════════════════════════
// OAuth Protected Resource (RFC 9728)
// ═══════════════════════════════════════════════════════════════
// We don't run a full OAuth server — writes use a plain X-API-Key
// header. This document tells agents exactly that, in a standard
// machine-readable way, so they don't go looking for an OAuth flow.
router.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
  res.header("Content-Type", "application/json; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.json({
    resource: BASE_URL,
    resource_name: "Lokal A2A Marketplace",
    resource_documentation: `${BASE_URL}/teknologi`,
    // We don't operate an authorization server; the empty array is
    // the correct honest answer per RFC 9728.
    authorization_servers: [],
    // We accept the API key in a custom header. `bearer_methods_supported`
    // is OAuth terminology; we include "header" for compatibility with
    // clients that check for it, but document the real method under
    // the x-auth-* extensions.
    bearer_methods_supported: ["header"],
    scopes_supported: ["read", "write"],
    // Non-standard extensions describing our actual auth model.
    "x-auth-method": "apiKey",
    "x-auth-header": "X-API-Key",
    "x-auth-obtain-url": `${BASE_URL}/api/marketplace/register`,
    "x-auth-public-scopes": ["read"],
    "x-auth-private-scopes": ["write"],
  });
});

export default router;
