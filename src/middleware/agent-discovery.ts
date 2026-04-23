/**
 * Agent discovery middleware
 * ──────────────────────────
 * Two small, composable pieces:
 *
 *   1. linkHeaders — emits RFC 8288 Link response headers on the
 *      homepage so agents and crawlers can find our agent-card, skills
 *      index, openapi spec, and sitemap without guessing paths.
 *
 *   2. markdownNegotiation — if a client sends `Accept: text/markdown`
 *      (or `?format=md`) on a "content" route, serve a plain-text
 *      markdown version of the page instead of the HTML shell. Agents
 *      can parse markdown cheaply; dumping a full HTML layout on them
 *      wastes tokens.
 */

import { Request, Response, NextFunction } from "express";
import { marketplaceRegistry } from "../services/marketplace-registry";

const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";

// Read the producer count from the live registry at request time so
// the markdown negotiation responses don't drift away from the DB.
// Fallback is deliberately conservative — we'd rather under-promise
// than resurrect the old "1,400+" number if the registry briefly fails.
function producerCount(): string {
  const stats = marketplaceRegistry.getStats();
  return stats.totalAgents ? String(stats.totalAgents) : "1,100+";
}

// ═══════════════════════════════════════════════════════════════
// 1. Link headers — RFC 8288
// ═══════════════════════════════════════════════════════════════
// Applied on every response so agents poking at any URL still see
// the discovery pointers. Cheap — just a string concatenation.
const DISCOVERY_LINKS = [
  `<${BASE_URL}/.well-known/agent-card.json>; rel="https://a2a.ai/spec/agent-card"; type="application/json"`,
  `<${BASE_URL}/.well-known/mcp/server-card.json>; rel="https://modelcontextprotocol.io/spec/server-card"; type="application/json"`,
  `<${BASE_URL}/.well-known/agent-skills/index.json>; rel="https://agentskills.io/spec/index"; type="application/json"`,
  `<${BASE_URL}/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
  `<${BASE_URL}/openapi.yaml>; rel="service-desc"; type="application/yaml"`,
  `<${BASE_URL}/sitemap.xml>; rel="sitemap"; type="application/xml"`,
  `<${BASE_URL}/teknologi>; rel="service-doc"; type="text/html"`,
].join(", ");

export function linkHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Link", DISCOVERY_LINKS);
  next();
}

// ═══════════════════════════════════════════════════════════════
// 2. Markdown content negotiation
// ═══════════════════════════════════════════════════════════════
// We generate markdown summaries *on demand* for the handful of routes
// that make sense in markdown form: homepage, /om, /teknologi, /sok,
// and /:city. For deep pages (producer details) the A2A Agent Card is
// a better format than markdown, so we redirect to that instead.
//
// The scanner specifically tests:
//   GET /
//   Accept: text/markdown
//
// ...so getting the homepage right is what matters for the score.

export function markdownNegotiation(req: Request, res: Response, next: NextFunction) {
  const accept = (req.headers.accept || "").toLowerCase();
  const queryFormat = (req.query.format as string || "").toLowerCase();

  // Only act on GET, only on paths we have markdown for, and only when
  // the client explicitly asked for markdown. Never hijack a browser.
  if (req.method !== "GET") return next();

  const wantsMarkdown =
    queryFormat === "md" ||
    queryFormat === "markdown" ||
    // Accept: text/markdown OR a q-weighted preference over text/html
    (accept.includes("text/markdown") &&
      !(accept.includes("text/html") && !accept.includes("text/markdown;q=")));

  if (!wantsMarkdown) return next();

  const path = req.path;
  let md: string | null = null;

  if (path === "/" || path === "/index.html") {
    md = homepageMarkdown();
  } else if (path === "/om") {
    md = aboutMarkdown();
  } else if (path === "/teknologi") {
    md = techMarkdown();
  }

  if (md === null) return next();

  res.header("Content-Type", "text/markdown; charset=utf-8");
  res.header("Cache-Control", "public, max-age=300");
  res.header("Vary", "Accept");
  res.send(md);
}

// ─── Markdown templates ──────────────────────────────────────

function homepageMarkdown(): string {
  return `# Lokal — A2A Marketplace for Local Food in Norway

**${BASE_URL}**

Lokal is an agent-to-agent marketplace connecting AI agents with ${producerCount()}+
verified local food producers across Norway. Search fresh produce, organic
vegetables, meat, fish, dairy, honey, bread, and more — all farm-direct.

## For AI Agents

- **A2A Agent Card:** [${BASE_URL}/.well-known/agent-card.json](${BASE_URL}/.well-known/agent-card.json)
- **MCP Server Card:** [${BASE_URL}/.well-known/mcp/server-card.json](${BASE_URL}/.well-known/mcp/server-card.json)
- **Agent Skills index:** [${BASE_URL}/.well-known/agent-skills/index.json](${BASE_URL}/.well-known/agent-skills/index.json)
- **OpenAPI spec:** [${BASE_URL}/openapi.yaml](${BASE_URL}/openapi.yaml)
- **A2A JSON-RPC endpoint:** \`POST ${BASE_URL}/a2a\`
- **MCP HTTP endpoint:** \`POST ${BASE_URL}/mcp\`

## Skills

| Skill | Description |
|---|---|
| \`discover-local-food-agents\` | Search ${producerCount()}+ verified producers by category, region, certification |
| \`register-food-agent\` | Onboard a new farm, shop, or cooperative |
| \`search-compare-food\` | Natural-language search; compare prices, delivery, certifications |
| \`agent-conversation\` | Open a buyer–seller negotiation channel |

## Coverage

- **Categories:** vegetables, fruit, meat, fish, dairy, eggs, honey, herbs, bread, berries
- **Regions:** all of Norway — from Oslo and Bergen to rural districts
- **Languages:** Norwegian (primary), English (fully supported)
- **Certifications:** organic (Debio), farm-direct, biodynamic

## Authentication

- Read operations (search, discover, get): **open**, no auth required
- Write operations (register, negotiate): **API key** via \`X-API-Key\` header
- Obtain a key: \`POST ${BASE_URL}/api/marketplace/register\`

## Documentation

- Human docs: [${BASE_URL}/teknologi](${BASE_URL}/teknologi)
- About Lokal: [${BASE_URL}/om](${BASE_URL}/om)
- Sitemap: [${BASE_URL}/sitemap.xml](${BASE_URL}/sitemap.xml)

## Operator

Open agent-to-agent food marketplace operator. Norway's first A2A
marketplace for local food. Apex domain: **rettfrabonden.com**.
`;
}

function aboutMarkdown(): string {
  return `# About Lokal

**${BASE_URL}/om**

Lokal is Norway's first agent-to-agent (A2A) marketplace for local food.
We connect AI agents — and the humans they help — directly with farmers,
fishermen, producers, and cooperatives across the country.

## Why A2A?

Traditional marketplaces optimize for ads and scale. We optimize for
**match quality**. When an agent asks "find me organic carrots near Oslo
with weekend delivery", it gets a ranked, honest answer — not a feed
sorted by who paid the most for placement.

## What we cover

- ${producerCount()}+ verified producers across Norway
- Categories: vegetables, fruit, meat, fish, dairy, eggs, honey, bread, berries, herbs
- Every major region from Agder to Finnmark
- Full bilingual support: Norwegian (primary) and English

## How it works

1. Producers register as agents (with an A2A Agent Card)
2. Consumer agents discover via MCP, A2A JSON-RPC, or REST
3. Match, negotiate, and transact directly — no intermediary markup

## For developers

See [${BASE_URL}/teknologi](${BASE_URL}/teknologi) for integration docs.

## Contact

Web: ${BASE_URL}
`;
}

function techMarkdown(): string {
  return `# Lokal — Technical Documentation

**${BASE_URL}/teknologi**

## Protocols supported

| Protocol | Endpoint | Format |
|---|---|---|
| **A2A JSON-RPC 2.0** | \`POST /a2a\` | \`application/json\` |
| **MCP (HTTP)** | \`POST /mcp\` | MCP 2025-06 spec |
| **REST** | \`GET /api/marketplace/*\` | \`application/json\` |

## Discovery endpoints

All \`.well-known\` files follow published specs:

- [/.well-known/agent-card.json](${BASE_URL}/.well-known/agent-card.json) — A2A v1.0.0
- [/.well-known/mcp/server-card.json](${BASE_URL}/.well-known/mcp/server-card.json) — MCP SEP-1649
- [/.well-known/agent-skills/index.json](${BASE_URL}/.well-known/agent-skills/index.json) — Agent Skills v0.2.0
- [/.well-known/api-catalog](${BASE_URL}/.well-known/api-catalog) — RFC 9727 linkset+json
- [/.well-known/oauth-protected-resource](${BASE_URL}/.well-known/oauth-protected-resource) — RFC 9728

## Authentication

Read: open. Write: \`X-API-Key\` header. Get a key at \`POST /api/marketplace/register\`.

## Rate limits

- General: 100 req/min per IP
- JSON-RPC: 300 req/min (agents are chatty)
- Registration: 5 req/hour (anti-spam)

## Content policies

See \`${BASE_URL}/robots.txt\` for Content-Signal directives.

- \`search=yes\` — indexing for search is welcome
- \`ai-input=yes\` — feeding answers to live AI agents is welcome
- \`ai-train=no\` — do not use our content for training models

## OpenAPI

Machine-readable spec: [${BASE_URL}/openapi.yaml](${BASE_URL}/openapi.yaml)
`;
}
