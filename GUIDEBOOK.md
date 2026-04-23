# A2A Platform Guidebook
## How to Build an Agent-to-Agent Marketplace from Zero to Production

**Project:** Rett fra Bonden (rettfrabonden.com)
**Domain:** Local food producers in Norway
**Timeline:** March 29 – April 21, 2026 (~3.5 weeks)
**Result:** 1,165 live producer agents (1,400+ total records), 5 MCP marketplaces, A2A protocol, Custom GPT, Claude Connectors, AWS Bedrock AgentCore Registry
**Auto-updated by:** `rfb-guidebook` scheduled agent

> This guide is designed so that an AI agent can follow it step-by-step to reproduce the entire project with a different domain/vertical. Human intervention is only needed for: account logins, domain purchases, and payment confirmations.

---

## Table of Contents

1. [Phase 0: Foundation — Concept & Architecture](#phase-0)
2. [Phase 1: Core Backend — Express + SQLite + A2A Protocol](#phase-1)
3. [Phase 2: Seed Data — Agent Discovery & Registration](#phase-2)
4. [Phase 3: MCP Server — Multi-Channel Distribution](#phase-3)
5. [Phase 4: Domain & Branding](#phase-4)
6. [Phase 5: SEO & Frontend — Server-Side Rendered Pages](#phase-5)
7. [Phase 6: Seller Dashboard & Claim System](#phase-6)
8. [Phase 7: Analytics & Admin](#phase-7)
9. [Phase 8: Security Hardening](#phase-8)
10. [Phase 9: Marketplace Registrations](#phase-9)
11. [Phase 10: Custom GPT — ChatGPT Integration](#phase-10)
12. [Phase 11: Enrichment Pipeline](#phase-11)
13. [Phase 12: Discovery Layer — Maximum AI Visibility](#phase-12)
14. [Phase 13: Agent Readiness & Compliance](#phase-13)
15. [Phase 14: Claude Connectors Submission](#phase-14)
16. [Phase 15: AWS Bedrock AgentCore Registry](#phase-15)
17. [Phase 16: Automated Agent Operations](#phase-16)
18. [Phase 17: Conversation System & AG-UI](#phase-17)
19. [Appendix A: Tech Stack Reference](#appendix-a)
20. [Appendix B: Deployment Checklist](#appendix-b)
21. [Appendix C: Gotchas & Lessons Learned](#appendix-c)
22. [Appendix D: Registry Status Matrix](#appendix-d)
23. [Appendix E: Agent Prompts (Copy-Paste Ready)](#appendix-e)

---

<a id="phase-0"></a>
## Phase 0: Foundation — Concept & Architecture

**Duration:** Day 1 (March 29, 2026)
**Commits:** `8ae0a7b`, `aaff20a`
**Goal:** Define the concept and set up the initial project structure.

### 0.1 The Idea

Build an **agent marketplace** — a registry where producer agents register themselves and consumer AI agents discover them. Think "DNS for agents" in a specific vertical.

**Key architectural decisions made on Day 1:**
- Discovery-only (no payment processing in v1)
- Value-based matching (not ad-based ranking)
- Agents talk to each other; humans interact via dashboard
- Data provenance always tracked (auto/owner/hybrid)
- SQLite for persistence (zero-ops, single-file, portable)
- A2A protocol (Google's Agent-to-Agent spec) as the wire format

### 0.2 Agent Prompt — Project Initialization

```
You are building an A2A (Agent-to-Agent) marketplace. The marketplace is a registry
where agents in [YOUR_VERTICAL] register and consumer AI agents discover them.

Create a TypeScript + Express backend with:
- A2A JSON-RPC 2.0 endpoint at /a2a
- Agent card at /.well-known/agent-card.json (A2A spec)
- SQLite database (better-sqlite3) for agent persistence
- REST API: GET /api/marketplace/agents, POST /api/marketplace/register
- Discovery: POST /discover (structured), GET /search?q= (natural language)
- Zod validation on all inputs
- Docker + fly.toml for Fly.io deployment

The agent card should describe the marketplace in both English and Norwegian.
Include semantic keywords for AI discovery.
```

### 0.3 Project Structure Created

```
lokal/
├── src/
│   ├── index.ts              # Express app, route mounting, middleware
│   ├── routes/
│   │   ├── a2a.ts            # JSON-RPC 2.0 A2A protocol handler
│   │   ├── marketplace.ts    # REST API (register, search, discover, CRUD)
│   │   ├── discovery.ts      # .well-known endpoints, llms.txt, agents.txt
│   │   ├── seo.ts            # SSR HTML pages for search engines
│   │   ├── mcp.ts            # MCP Streamable HTTP transport
│   │   └── ...               # Additional routes added later
│   ├── services/
│   │   └── analytics-service.ts
│   └── public/
│       ├── app.html          # SPA landing page
│       ├── selger.html       # Seller dashboard
│       └── admin-dashboard.html
├── mcp-server/
│   ├── index.js              # Standalone stdio MCP server (npm package)
│   ├── package.json
│   └── server.json           # Official MCP Registry metadata
├── data/                     # SQLite database (gitignored, Fly volume)
├── seed-data/                # JSON seed files for agents
├── Dockerfile
├── fly.toml
├── package.json
├── tsconfig.json
└── server.json               # Root-level A2A server metadata
```

### 0.4 Deploy to Fly.io

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login (HUMAN: do this manually)
fly auth login

# Create app
fly launch --name YOUR_APP_NAME --region arn

# Create persistent volume for SQLite
fly volumes create YOUR_DATA_VOL --size 1 --region arn

# Deploy
fly deploy
```

**fly.toml template:**
```toml
app = 'YOUR_APP_NAME'
primary_region = 'arn'

[build]
  dockerfile = 'Dockerfile'

[env]
  NODE_ENV = 'production'
  PORT = '3000'

[[mounts]]
  source = 'YOUR_DATA_VOL'
  destination = '/app/data'

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = 'off'
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    interval = "30s"
    timeout = "10s"
    grace_period = "15s"
    method = "GET"
    path = "/.well-known/agent-card.json"

[[vm]]
  size = 'shared-cpu-1x'
  memory = '512mb'
  cpus = 1
  memory_mb = 512
```

**Dockerfile:**
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npx tsc
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

**Cost:** ~$2.20/month (~24 NOK) for shared-cpu-1x + 512MB RAM + 1GB volume.

---

<a id="phase-1"></a>
## Phase 1: Core Backend — Express + SQLite + A2A Protocol

**Duration:** Day 1-2 (March 29-31)
**Commits:** `aaff20a` through `c236475`

### 1.1 A2A JSON-RPC Endpoint

The A2A protocol uses JSON-RPC 2.0 over HTTP POST. Create `src/routes/a2a.ts`:

**Agent Prompt:**
```
Implement an A2A JSON-RPC 2.0 endpoint at POST /a2a that handles these methods:

1. "message" — accepts { message: { parts: [{ type: "text", text: "..." }] } }
   and returns search results as agent messages
2. "discover" — returns the agent card
3. "capabilities" — returns supported methods

Follow the A2A spec: https://google.github.io/A2A/
Each response must include message.parts[] array with text parts.
Parse natural language queries to extract: location, category, product type.
Use SQLite full-text search or LIKE queries for matching.
```

**Key implementation detail:** The `message.parts[]` format is critical — many A2A clients expect this exact structure. Each part has `type: "text"` and `text: "..."`.

### 1.2 Agent Card

Serve at `/.well-known/agent-card.json`:

```json
{
  "name": "Rett fra Bonden",
  "description": "Norway's local food agent marketplace — 1,400+ producers",
  "url": "https://YOUR_DOMAIN/a2a",
  "version": "0.1.0",
  "capabilities": {
    "streaming": false,
    "pushNotifications": false
  },
  "skills": [
    {
      "id": "search-food",
      "name": "Search local food",
      "description": "Find farms, shops, producers by location or product"
    }
  ]
}
```

### 1.3 SQLite Schema

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  location TEXT,
  lat REAL,
  lng REAL,
  category TEXT,
  contactEmail TEXT NOT NULL DEFAULT '',
  contactPhone TEXT,
  website TEXT,
  products TEXT,          -- JSON array
  verified INTEGER DEFAULT 0,
  trustScore REAL DEFAULT 0.3,
  createdAt TEXT DEFAULT (datetime('now')),
  updatedAt TEXT DEFAULT (datetime('now'))
);

CREATE TABLE agent_knowledge (
  agentId TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  about TEXT,
  openingHours TEXT,      -- JSON
  externalLinks TEXT,     -- JSON array
  ratings TEXT,           -- JSON
  dataSource TEXT DEFAULT 'auto',
  updatedAt TEXT DEFAULT (datetime('now'))
);

CREATE TABLE agent_claims (
  id TEXT PRIMARY KEY,
  agentId TEXT REFERENCES agents(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token TEXT,
  verificationCode TEXT,
  verified INTEGER DEFAULT 0,
  createdAt TEXT DEFAULT (datetime('now'))
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  buyerQuery TEXT,
  agentId TEXT REFERENCES agents(id) ON DELETE CASCADE,
  messages TEXT,           -- JSON array
  status TEXT DEFAULT 'active',
  source TEXT DEFAULT 'unknown',
  createdAt TEXT DEFAULT (datetime('now'))
);
```

### 1.4 REST API (marketplace.ts)

**Core endpoints:**
```
GET    /api/marketplace/agents          — List all agents (paginated)
GET    /api/marketplace/agents/:id      — Get single agent
POST   /api/marketplace/register        — Register new agent
PUT    /api/marketplace/agents/:id      — Update agent
DELETE /api/marketplace/agents/:id      — Delete (admin-only, X-Admin-Key)
GET    /api/marketplace/search?q=&lat=&lng=  — Search with geo
POST   /api/marketplace/discover        — Structured discovery
GET    /api/stats                       — Public stats (counts, cities)
PUT    /agents/:id/knowledge            — Update knowledge layer
POST   /claim                           — Start claim flow
POST   /verify-claim                    — Verify claim code
```

**Admin authentication pattern:**
```typescript
function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

// In route handler:
const adminKey = req.headers["x-admin-key"];
if (adminKey !== getAdminKey()) {
  return res.status(401).json({ error: "Unauthorized" });
}
```

---

<a id="phase-2"></a>
## Phase 2: Seed Data — Agent Discovery & Registration

**Duration:** Day 1-3 (March 31 – April 3)
**Commits:** `41f2953`, `9dc3c6d`

### 2.1 Initial Seed Strategy

We created JSON seed files with agents discovered through web research. Each file covers a region of Norway.

**Agent Prompt:**
```
Research local food producers in [REGION], Norway. For each, create a JSON entry:
{
  "id": "kebab-case-unique-name",
  "name": "Farm Name",
  "description": "What they produce, in Norwegian",
  "location": "City, County",
  "lat": 59.xxx,
  "lng": 10.xxx,
  "category": "gårdsbutikk|marked|produsent|bakeri|...",
  "contactEmail": "",
  "website": "https://...",
  "products": ["product1", "product2"]
}

Sources to check: Google Maps, bondens-marked.no, REKO-ringer on Facebook,
ryvarden.no, gardsutsalg.no, inorge.no, lokalmat.no

Find 30-50 producers per region. Include: farms, farm shops (gårdsbutikk),
markets (bondens marked), bakeries, fisheries, cheese makers, etc.
```

### 2.2 Idempotent Seeding

**Critical fix (commit `9dc3c6d`):** The seed function must check if agents already exist before inserting. Without this, every server restart duplicates all agents.

```typescript
// In src/index.ts startup:
const count = db.prepare("SELECT COUNT(*) as c FROM agents").get() as any;
if (count.c === 0) {
  seedFromFiles();
}
// Plus: run dedup query on startup
db.exec(`
  DELETE FROM agents WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM agents GROUP BY name, location
  )
`);
```

### 2.3 Automated Discovery Agent

Created a scheduled agent (`expand-norway-agents`) that discovers new producers:

**Agent Prompt (for scheduled task):**
```
You are the Agent Discovery agent for [YOUR_PLATFORM].
Your job is to find and register new [VERTICAL] producers.

WORKFLOW:
1. Pick a region not yet fully covered
2. Web search for producers in that region
3. For each producer found:
   a. Check if already registered: GET /api/marketplace/search?q={name}
   b. If not found, enrich with web data (website, phone, email, coordinates)
   c. Register via POST /api/marketplace/register with X-Admin-Key header
4. Generate a discovery report

API: https://YOUR_DOMAIN
Admin key: [SET VIA ENV]
Target: 30-50 new agents per run
```

**Result:** Grew from 370 → 1,400+ agents over ~2 weeks of daily runs.

---

<a id="phase-3"></a>
## Phase 3: MCP Server — Multi-Channel Distribution

**Duration:** Day 3-7 (April 1-7)
**Commits:** `322fc73`, `1da7715`

### 3.1 Why MCP Matters

MCP (Model Context Protocol) lets any AI assistant (Claude, ChatGPT, Cursor, etc.) use your marketplace as a tool. One MCP server = access from every AI platform.

### 3.2 Two MCP Transports

**A) Standalone stdio server (npm package — `mcp-server/index.js`):**

This runs locally on the user's machine via `npx lokal-mcp`. Used by Claude Desktop.

```javascript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = "https://YOUR_DOMAIN";
const server = new McpServer({
  name: "your-mcp-server",
  version: "0.3.3"
});

// Tool: search
server.tool("your_search", "Search description", {
  query: z.string().describe("Natural language search query"),
  location: z.string().optional().describe("City or region"),
  category: z.string().optional()
}, async ({ query, location, category }) => {
  const params = new URLSearchParams({ q: query });
  if (location) params.set("location", location);
  if (category) params.set("category", category);
  const res = await fetch(`${API}/api/marketplace/search?${params}`);
  const data = await res.json();
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Tool: discover (structured)
server.tool("your_discover", "Discover by filters", {
  location: z.string().optional(),
  category: z.string().optional(),
  limit: z.number().optional().default(20)
}, async (args) => {
  const res = await fetch(`${API}/api/marketplace/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  const data = await res.json();
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Tool: info (single agent)
server.tool("your_info", "Get detailed info about one agent", {
  id: z.string().describe("Agent ID (slug)")
}, async ({ id }) => {
  const res = await fetch(`${API}/api/marketplace/agents/${id}`);
  const data = await res.json();
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Tool: stats
server.tool("your_stats", "Platform statistics", {}, async () => {
  const res = await fetch(`${API}/api/stats`);
  const data = await res.json();
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

**mcp-server/package.json:**
```json
{
  "name": "your-mcp-server",
  "version": "0.3.3",
  "mcpName": "io.github.YOUR_USER/your-mcp-server",
  "description": "MCP server for YOUR_PLATFORM",
  "main": "index.js",
  "bin": { "your-mcp-server": "index.js" },
  "type": "module",
  "files": ["index.js", "README.md"],
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1",
    "zod": "^3.23.8"
  }
}
```

**B) Streamable HTTP transport (embedded in main server — `src/routes/mcp.ts`):**

This runs on your server and is used by ChatGPT, Claude.ai Connectors, and any remote MCP client.

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamablehttp.js";

// Mount at POST /mcp, GET /mcp, DELETE /mcp
// Use server.registerTool() with annotations for Connectors compliance:
server.registerTool({
  title: "Search Producers",
  description: "Search by query, location, category",
  inputSchema: { /* zod schema */ },
  annotations: {
    readOnlyHint: false,    // true if no side effects
    destructiveHint: false,
    idempotentHint: false,  // true if calling twice = same result
    openWorldHint: false
  }
}, handler);
```

### 3.3 npm Publish Workflow

```bash
cd mcp-server
npm login          # HUMAN: enter credentials
npm publish        # Publishes to npmjs.com
```

**Version bump checklist:**
1. Update `mcp-server/package.json` version
2. Update `mcp-server/server.json` version
3. `npm publish`
4. Then publish to MCP Registry (see Phase 9)

### 3.4 OpenAPI Spec

Serve at `/openapi.yaml` or `/openapi.json` — used by Custom GPTs (Actions) and other REST clients:

```yaml
openapi: "3.1.0"
info:
  title: "YOUR_PLATFORM API"
  version: "1.0.0"
servers:
  - url: "https://YOUR_DOMAIN"
paths:
  /api/marketplace/search:
    get:
      operationId: "searchProducers"
      parameters:
        - name: q
          in: query
          required: true
          schema: { type: string }
```

---

<a id="phase-4"></a>
## Phase 4: Domain & Branding

**Duration:** Day 14 (April 13)
**Commits:** `c1bb279`, `5ae48aa`

### 4.1 Domain Registration

**HUMAN ACTION: Register domain on Namecheap (or your registrar).**

Choose a domain that communicates value in the target language. We chose "rettfrabonden.com" ("straight from the farmer" in Norwegian).

### 4.2 DNS Setup (Namecheap → Fly.io)

In Namecheap → Advanced DNS:

```
A     @     66.241.125.xxx    (from: fly ips list)
AAAA  @     2a09:8280:1::...  (from: fly ips list)
```

On Fly.io:
```bash
fly certs add YOUR_DOMAIN
fly certs add www.YOUR_DOMAIN
```

### 4.3 www → apex Redirect

Add middleware in `src/index.ts`:
```typescript
app.use((req, res, next) => {
  if (req.hostname?.startsWith('www.')) {
    return res.redirect(301, `https://${req.hostname.slice(4)}${req.originalUrl}`);
  }
  next();
});
```

### 4.4 Update BASE_URL

```bash
fly secrets set BASE_URL=https://YOUR_DOMAIN
```

### 4.5 Domain Verification

**CRITICAL:** If using Namecheap, you MUST click the domain verification email within 15 days or your domain gets suspended.

---

<a id="phase-5"></a>
## Phase 5: SEO & Frontend — Server-Side Rendered Pages

**Duration:** Day 15 (April 14)
**Commits:** `880040b`, `85184c1`, `795f14d`

### 5.1 Why SSR for an Agent Marketplace

Google and social media crawlers need HTML. Your agent pages need to be indexable for organic traffic. We create server-side rendered pages for:

- `/` — Homepage with stats, city links, featured agents
- `/:city` — City page listing all agents in that city (e.g., `/oslo`)
- `/produsent/:slug` — Individual producer profile page
- `/om` — About page
- `/teknologi` — Technology/how-it-works page
- `/personvern` — Privacy policy
- `/vilkar` — Terms of service

### 5.2 Agent Prompt — SEO Route

```
Create a server-side rendered Express route file (src/routes/seo.ts) that generates
full HTML pages for:

1. Homepage (/) — hero section, stats counter, city grid, featured agents
2. City pages (/:city) — list of all agents in that city with structured data
3. Producer pages (/produsent/:slug) — full profile with Schema.org JSON-LD

Include for each page:
- <title> and <meta description> in Norwegian
- Open Graph tags (og:title, og:description, og:image)
- Twitter Card tags
- Schema.org JSON-LD (LocalBusiness for producers, ItemList for city pages)
- Canonical URLs
- hreflang tags (no, en)
- Sitemap at /sitemap.xml
- robots.txt with AI bot rules

Design: clean, professional, mobile-first, Norwegian language.
Colors: earth tones (greens, browns) for food/agriculture theme.
```

### 5.3 Schema.org JSON-LD

Each producer page needs valid structured data:

```json
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": "Farm Name",
  "description": "...",
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "City",
    "addressCountry": "NO"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": 59.xxx,
    "longitude": 10.xxx
  },
  "makesOffer": [
    {
      "@type": "Offer",
      "itemOffered": {
        "@type": "Product",
        "name": "Product Name",
        "offers": {
          "@type": "Offer",
          "availability": "https://schema.org/InStock"
        }
      }
    }
  ]
}
```

**GOTCHA:** Google Rich Results requires `Product` to have an `offers` field with at least `availability`. Without this, you get "Invalid Product" errors.

### 5.4 Sitemap

Generate dynamically at `/sitemap.xml`:
```typescript
app.get("/sitemap.xml", (req, res) => {
  const agents = db.prepare("SELECT id, location, updatedAt FROM agents").all();
  const cities = [...new Set(agents.map(a => a.location?.split(",")[0]?.trim()))];
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
  // Add homepage, about, tech pages
  // Add each city page
  // Add each producer page
  xml += '</urlset>';
  
  res.type("application/xml").send(xml);
});
```

### 5.5 Per-City Context Paragraph (cheap unique content for Google)

**Problem:** A templated lede like *"N lokale matprodusenter i {city}-området"* is the same string on /oslo, /bergen, /trondheim, /stavanger, … Google has nothing unique to index between those pages, so they compete with each other for the same query rather than each ranking for its own city.

**Fix:** Inject a computed second paragraph grounded in **live registry data** — the top three categories in that city (translated to Norwegian labels) plus the verified-producer count. No per-city editorial writing required; each page now has a factually distinct block above the fold.

```typescript
// src/routes/seo.ts — inside /:city handler
const agents = marketplaceRegistry.searchByCity(city);
const categoryCounts = agents.reduce<Record<string, number>>((acc, a) => {
  const cat = a.category || "other";
  acc[cat] = (acc[cat] || 0) + 1;
  return acc;
}, {});
const topCats = Object.entries(categoryCounts)
  .sort(([, a], [, b]) => b - a)
  .slice(0, 3)
  .map(([c]) => norwegianCategoryLabel(c));
const verified = agents.filter(a => a.trustTier === "verified").length;

const contextParagraph = `
  I ${city} finner du ${agents.length} lokale matprodusenter fra
  ${topCats.join(", ")}. ${verified} av dem er verifiserte.
`;
```

**Result (commit `a56d0c2`):** /oslo, /bergen, /trondheim now each carry a unique city-grounded paragraph Google can use to disambiguate them. Cheapest SEO win available without editorial effort.

---

<a id="phase-6"></a>
## Phase 6: Seller Dashboard & Claim System

**Duration:** Day 7-16 (April 6-16)
**Commits:** `b5f0d26`, `80c04dd`, `cba2f96`

### 6.1 Claim Flow

Producers can "claim" their auto-generated agent to take ownership:

```
1. Producer visits /produsent/their-farm → sees "Er dette din gård?" button
2. Clicks → enters email → POST /claim { agentId, email }
3. Server sends verification code via email
4. Producer enters code → POST /verify-claim { agentId, code }
5. Server returns claim token → redirects to /selger?token=xxx
6. Seller dashboard loads with their agent's data
```

### 6.2 Magic Link Login

For returning sellers, we implemented passwordless login:

```
1. Seller visits /selger → enters email
2. POST /auth/magic-link { email }
3. Server sends email with login link containing one-time token
4. Seller clicks link → /selger?token=xxx → dashboard loads
```

### 6.3 Seller Dashboard Features

Static HTML (`src/public/selger.html`) with JavaScript:
- View/edit profile (name, description, products, prices)
- View analytics (who found you, how, conversion)
- Bulk product paste (copy from AI, paste all at once)
- Settings (contact info, opening hours, images)
- Trust score breakdown

**GOTCHA:** Never use inline `onclick` handlers. Use `addEventListener` instead. MetaMask's SES (Secure ECMAScript) blocks inline handlers.

### 6.4 Admin Notification on Claim Verification

When a producer successfully verifies their claim, email the admin so conversion can be tracked in real time (the analytics dashboard only shows counts, not *who* just claimed).

```typescript
// src/routes/marketplace.ts — inside POST /verify-claim, after success
if (process.env.ADMIN_NOTIFICATION_EMAIL) {
  // Non-blocking — do NOT await, and do NOT let a mail failure
  // delay the 200 OK response to the producer.
  emailService
    .sendAdminClaimNotification({
      to: process.env.ADMIN_NOTIFICATION_EMAIL,
      producerName: agent.name,
      ownerName: claim.ownerName,
      ownerEmail: claim.email,
      campaignSource: claim.source,
      verifiedAt: new Date().toISOString(),
    })
    .catch(err => console.warn("[admin-notify] failed", err));
}
```

**Design rules:**
- Fire-and-forget. A transient SMTP failure must not block the producer's verify response.
- Include campaign source (`utm_source` captured at claim time) so you can see which outreach channel converted.
- Guard behind `ADMIN_NOTIFICATION_EMAIL` env var so unconfigured deploys don't try to send mail.

Commit: `2181d9d`.

---

<a id="phase-7"></a>
## Phase 7: Analytics & Admin

**Duration:** Day 15-16 (April 14-16)
**Commits:** `1f3ebd6`, `84d1d15`, `8aaaa89`

### 7.1 Analytics System

Built-in, GDPR-compliant analytics with no cookies and no third-party services:

```sql
CREATE TABLE analytics_page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT,
  userAgent TEXT,
  referer TEXT,
  ip TEXT,
  isBot INTEGER DEFAULT 0,
  source TEXT,
  createdAt TEXT DEFAULT (datetime('now'))
);

CREATE TABLE analytics_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT,
  resultsCount INTEGER,
  source TEXT,
  createdAt TEXT DEFAULT (datetime('now'))
);

CREATE TABLE analytics_agent_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId TEXT,
  city TEXT,
  source TEXT,
  isOwner INTEGER DEFAULT 0,
  createdAt TEXT DEFAULT (datetime('now'))
);
```

### 7.2 Admin Dashboard

Serve at `/admin/dashboard` with X-Admin-Key authentication:
- Traffic overview (page views, unique visitors, bots vs humans)
- Top producers by views
- City breakdown
- Search query analysis
- Device/source breakdown
- Hourly traffic chart

### 7.3 Admin Key Management

Set via Fly.io secrets:
```bash
fly secrets set ADMIN_KEY=your-secure-key
fly secrets set ANALYTICS_ADMIN_KEY=your-secure-key
```

**GOTCHA:** Fly.io "Set secret" only stages the value. You must click "Deploy Secrets" or run `fly deploy` to activate it.

### 7.4 AI-Bot User-Agent Classifier

The `agentTraffic` summary metric (chatgpt / claude / other) is the platform's primary AI-visibility KPI. It is computed in `analytics-service.ts` and **must be derived from page views, not search queries** — AI crawlers produce GETs against your pages, they almost never hit `/search`. Two rules:

1. Store `session_id` as `ipHash:userAgent` in `analytics_page_views` so you can recover the UA later via a `LIKE` substring match.
2. `parseUserAgent()` must whitelist the full set of AI crawler UA tokens, not just the consumer chat product names. As of April 2026 the live list is:

   ```
   GPTBot, ChatGPT-User, OAI-SearchBot          → "chatgpt"
   ClaudeBot, Claude-User                       → "claude"
   PerplexityBot, Perplexity-User               → "perplexity"
   Google-Extended, Googlebot                   → "google" / "googlebot"
   CCBot, Bytespider, Applebot, YandexBot, …    → "other-ai"
   ```

   Combine this with the older `analytics_queries.agent_id` lookup (folded in for back-compat so any human-on-ChatGPT search traffic still counts).

Without this, a site that's getting 1,000+ AI-crawler hits per day will report `chatgpt: 0, claude: 0` and quietly under-sell its main growth metric.

### 7.5 Top-Pages Scanner Noise Filter

`/admin/analytics/pages` ranks paths by view count. WordPress vulnerability scanners hit hundreds of plausible-looking paths (`/wp-admin/setup-config.php`, `/wlwmanifest.xml`, `/.env`, `/.git/config`, `/phpinfo.php`, `/setup-config`) that will dominate any new site's top-20 within 48 hours. Filter them at the report level (don't drop the rows from the table — you still want them in `/traffic-classification` as `scanner` for security visibility):

```sql
WHERE path NOT LIKE '%wp-admin%'
  AND path NOT LIKE '%wp-login%'
  AND path NOT LIKE '%wp-includes%'
  AND path NOT LIKE '%wordpress%'
  AND path NOT LIKE '%wlwmanifest%'
  AND path NOT LIKE '%xmlrpc%'
  AND path NOT LIKE '%.env%'
  AND path NOT LIKE '%.git%'
  AND path NOT LIKE '%phpunit%'
  AND path NOT LIKE '%phpinfo%'
  AND path NOT LIKE '%setup-config%'
```

### 7.6 `avgTimeOnSite` from Session Spans (no beacons required)

**Problem:** The dashboard's *Average time on site* metric had been hardcoded to `0` with a `TODO` comment since analytics first shipped. Without a pagehide/unload beacon, there is no obvious way to measure dwell time.

**Solution (commit `fda2a2e`):** `session_id` is already stable per visitor (`ipHash:userAgent`), so for any multi-pageview session the span between the first and last `created_at` is a reasonable lower-bound for time on site. Aggregate across sessions for the average.

```sql
-- Exclude single-view sessions (no span signal) and bot sessions (we want human dwell time).
SELECT AVG(span_seconds) AS avg_seconds
FROM (
  SELECT
    (strftime('%s', MAX(created_at)) - strftime('%s', MIN(created_at))) AS span_seconds
  FROM analytics_page_views
  WHERE is_bot = 0
    AND created_at > datetime('now', '-30 days')
  GROUP BY session_id
  HAVING COUNT(*) > 1
);
```

**Caveats to document in the dashboard tooltip:**
- It's a **lower bound** — the user is always on the last page for *some* time after the final pageview is recorded, but we don't know how long.
- Single-view sessions are excluded from the numerator. Including them as `0` would drag the average toward zero with no actual signal about engagement.
- Bot sessions are excluded. We want *human* dwell time, and bots often fetch in bursts that compress span to milliseconds.

---

<a id="phase-8"></a>
## Phase 8: Security Hardening

**Duration:** Day 16 (April 15)
**Commits:** `306adb0`, `00e1065`, `f325ad`

### 8.1 Security Audit Checklist

```
✅ Helmet.js (CSP, X-Frame-Options, HSTS)
✅ Rate limiting (4 tiers: general, auth, admin, API)
✅ Input sanitization (XSS protection on all user inputs)
✅ SQL parameterized queries (no string concatenation)
✅ Admin key from environment (not hardcoded)
✅ Token expiry on claim/login tokens
✅ CORS configured for specific origins
✅ No inline event handlers (CSP compliance)
```

### 8.2 Rate Limiting Setup

```typescript
import rateLimit from "express-rate-limit";

// General: 100 req/15min
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Auth endpoints: 5 req/15min
app.use("/auth", rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }));

// Admin: 100 req/hour (raised for enrichment runs)
app.use("/admin", rateLimit({ windowMs: 60 * 60 * 1000, max: 100 }));
```

---

<a id="phase-9"></a>
## Phase 9: Marketplace Registrations

**Duration:** Day 14-16 (April 13-15)
**Result:** Listed on 5 MCP marketplaces + Google Search Console

This is one of the highest-leverage phases. Getting listed everywhere AI developers look for tools.

### 9.1 npm (Required First)

All other marketplaces validate that your npm package exists.

```bash
cd mcp-server
npm login       # HUMAN: enter credentials
npm publish
```

### 9.2 Smithery.ai (~5 min)

1. Go to https://smithery.ai/new
2. **HUMAN:** Log in with GitHub
3. Enter server URL: `https://YOUR_DOMAIN/mcp`
4. Smithery auto-scans your endpoint

**Result:** Listed at `smithery.ai/server/YOUR_USER/YOUR_SERVER`

### 9.3 Glama.ai (~5 min)

1. Add `glama.json` to repo root:
```json
{
  "$schema": "https://glama.ai/mcp/schemas/server.json",
  "maintainers": ["YOUR_GITHUB_USER"]
}
```
2. Push to GitHub
3. Go to https://glama.ai/mcp/servers → "Add Server"
4. Enter GitHub URL
5. **HUMAN:** Claim ownership

### 9.4 mcp.so (~10 min)

Post a comment on https://github.com/chatmcp/mcp-directory/issues/1:
```markdown
## your-mcp-server — Short description

**Repository:** https://github.com/YOUR_USER/YOUR_REPO
**npm:** https://www.npmjs.com/package/your-mcp-server
**Homepage:** https://YOUR_DOMAIN

Description of what the MCP server does.

Tools: tool1, tool2, tool3, tool4
```

### 9.5 Official MCP Registry (~10 min)

Requires `mcp-publisher` CLI:

```bash
# Download binary
curl -sL "https://github.com/modelcontextprotocol/registry/releases/download/v1.5.0/mcp-publisher_linux_amd64.tar.gz" -o /tmp/mcp-publisher.tar.gz
cd /tmp && tar xzf mcp-publisher.tar.gz

# Navigate to mcp-server directory
cd /path/to/mcp-server

# Validate
/tmp/mcp-publisher validate

# Login with GitHub PAT
/tmp/mcp-publisher login github --token "$GITHUB_PAT"

# Publish
/tmp/mcp-publisher publish
```

**server.json format (required in mcp-server/):**
```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.YOUR_USER/your-mcp-server",
  "description": "Max 100 chars description",
  "repository": {
    "url": "https://github.com/YOUR_USER/YOUR_REPO",
    "source": "github",
    "subfolder": "mcp-server"
  },
  "version": "0.3.3",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "your-mcp-server",
      "version": "0.3.3",
      "transport": { "type": "stdio" },
      "environmentVariables": []
    }
  ]
}
```

**GOTCHA:** `registryType` must be camelCase, not snake_case. And `mcpName` in package.json must match the `name` in server.json.

### 9.6 Google Search Console

1. Go to https://search.google.com/search-console
2. Add property → URL prefix → `https://YOUR_DOMAIN`
3. Verify via DNS TXT record (Namecheap: Advanced DNS → add TXT record)
4. Submit sitemap: `https://YOUR_DOMAIN/sitemap.xml`

### 9.7 A2A Registry (a2aregistry.org)

Fork + PR workflow:

```bash
gh repo fork prassanna-ravishankar/a2a-registry --clone
cd a2a-registry

# Create agents/your-agent.json
cat > agents/your-agent.json << 'EOF'
{
  "name": "Your Agent Name",
  "description": "What it does",
  "wellKnownURI": "https://YOUR_DOMAIN/.well-known/agent-card.json",
  "author": "Your Name",
  "registryTags": ["tag1", "tag2"],
  "capabilities": {
    "streaming": false,
    "pushNotifications": false
  }
}
EOF

git add agents/your-agent.json
git commit -m "Add Your Agent"
git push origin main
gh pr create --title "Add Your Agent" --body "Description..."
```

**GOTCHA:** The A2A Registry schema uses `wellKnownURI` (not `agentCardUrl`), `registryTags` (not `categories`), and `capabilities` as an object (not string array).

---

<a id="phase-10"></a>
## Phase 10: Custom GPT — ChatGPT Integration

**Duration:** Day 12-16 (April 12-16)
**Commits:** `9a6e30f`

### 10.1 Create Custom GPT

1. Go to https://chatgpt.com/gpts/editor
2. **HUMAN:** Log in
3. Configure:

**Name:** "Finn Lokal Mat i Norge" (or your equivalent)
**Description:** Short description of what the GPT does

**Instructions:**
```
You are [YOUR_BOT_NAME], an assistant for finding local food in Norway.

You have access to these tools:
- searchProducers: Search by query, location, category
- discoverProducers: Structured discovery with filters
- getProducerInfo: Get detailed info about one producer

IMPORTANT RULES:
1. Never fabricate information. Only share data from the API.
2. If no results, say so honestly.
3. Always include contact info when available.
4. Platform is free — never mention costs.
5. Link to producer profiles: https://YOUR_DOMAIN/produsent/{id}
6. Be warm, practical, and encouraging.
7. Respond in the user's language (Norwegian or English).

HARDCODED CITY COORDINATES (for geo-search):
Oslo: 59.9139, 10.7522
Bergen: 60.3913, 5.3221
Trondheim: 63.4305, 10.3951
[... add all major cities ...]
```

4. **Actions:** Import OpenAPI spec from `https://YOUR_DOMAIN/openapi.json`
5. **Authentication:** None
6. **Publish:** Public

### 10.2 Link GPT from Your Site

Add buttons on your homepage that link directly to the GPT:
```
https://chatgpt.com/g/g-YOUR_GPT_ID-your-gpt-slug
```

---

<a id="phase-11"></a>
## Phase 11: Enrichment Pipeline

**Duration:** Day 15-20 (April 15-20, ongoing daily)
**Commits:** `a689f0d`, `4dad408`, `64c2c82`

### 11.1 What Enrichment Does

Takes auto-discovered agents with minimal data and enriches them with:
- Phone numbers, emails, websites
- Opening hours
- External links (Google Maps, Facebook, Instagram, TripAdvisor)
- Google ratings
- Better descriptions (Norwegian)
- Categories and tags
- vCard generation

### 11.2 Enrichment Agent Prompt

```
You are the Enrichment Agent for [YOUR_PLATFORM].

WORKFLOW per agent:
1. GET /api/marketplace/agents/:id — read current data
2. GET /agents/:id/knowledge — read current knowledge
3. Web search for the producer (name + location)
4. Extract: phone, email, website, opening hours, social media links, ratings
5. PUT /agents/:id/knowledge with enriched data
6. PUT /api/marketplace/agents/:id to update core fields if needed
7. Track what was improved

RULES:
- Never fabricate data. Only use verified web sources.
- Rate limit: 0.4s+ delay between API calls
- Skip chains/franchises (McDonald's, Rema 1000, etc.)
- Delete truly invalid agents (no web presence, closed, not food-related)
- Generate vCard for agents with phone/email

API: https://YOUR_DOMAIN
Admin key: [FROM ENV]
Target: 50 agents per run
```

### 11.3 Trust Score Calculation

Trust score (0.0 – 1.0) based on 5 signals:
```
verification: 0.30 weight (claimed + verified by owner)
completeness: 0.25 weight (% of fields filled)
freshness:    0.20 weight (recently updated)
engagement:   0.15 weight (conversations, views)
links:        0.10 weight (external link validation)
```

### 11.4 Enrichment Tiers

- **Tier 1:** Core fields (phone, email, website, description, coordinates, Google Maps link)
- **Tier 2:** Extended fields (seasonality, delivery radius, images, opening hours, social links)
- **Tier S:** Compliance (valid agent card, all required schema fields)
- **Tier A:** AI readiness (structured data, keywords, trust score > 0.5)

### 11.5 Coverage Snapshot — Run #30 (2026-04-21)

Track these numbers between runs. They are the enrichment pipeline's primary KPIs; if any of them regresses without a schema change, the run probably silently 401'd or rate-limited.

| Field | Coverage | Target |
|---|---|---|
| Phone | 72.5% | 80%+ |
| Email | 65.0% | 70%+ |
| Website | 90.0% | 95%+ |
| Address | 97.5% | 98%+ |
| About-text | 100.0% | — |
| External Links | **100.0%** | 60%+ (exceeded) |
| Opening Hours | 27.5% | 70%+ |
| Google Rating | 2.5% | 50%+ (blocked by Google Maps scraping — use Places API) |
| Trust score (mean) | 0.429 | 0.60+ |

**Unreachable without schema work:** `seasonality` (389 values computed, 0 persisted), `deliveryRadius` (721 computed, 0 persisted), `images`, `minOrderValue`. See Appendix C.11.

### 11.6 Throughput Tuning

- Fly.io rate limit in the live `security` middleware: **300 requests / 15-minute window.** A full-registry pass over ~1,165 agents at 3 requests per agent (GET /marketplace/agents/:id + GET /agents/:id/knowledge + PUT) requires ≥8 rate-limit windows, i.e. ~2 hours wall-clock.
- Target 50 agents per enrichment run when running as a scheduled agent; a full registry pass is a weekend job, not a weekday one.

---

<a id="phase-12"></a>
## Phase 12: Discovery Layer — Maximum AI Visibility

**Duration:** Day 19 (April 19)
**Commits:** `4e053fd`

### 12.1 Endpoints Created

Make your marketplace discoverable by every type of AI agent:

| Endpoint | Standard | Purpose |
|----------|----------|---------|
| `/.well-known/agent-card.json` | A2A | Agent identity and capabilities |
| `/.well-known/mcp/server-card.json` | SEP-1649 | MCP server discovery |
| `/.well-known/mcp-server.json` | ad-hoc | **Hyphenated alias** — some directory scanners hit this path instead of the slashed form. Same payload. |
| `/.well-known/mcp.json` | SEP-1960 | MCP manifest |
| `/.well-known/ai-plugin.json` | OpenAI plugins (deprecated) | Still indexed by NotHumanSearch and historical plugin registries as a machine-readable API signal. |
| `/.well-known/agents.txt` | IETF draft | Text-based agent discovery |
| `/.well-known/agents.json` | AWP | JSON agent discovery |
| `/api`, `/api/v1`, `/api/marketplace` | ad-hoc | JSON index of available routes — gives AI indexers a "browseable API" signal. |
| `/llms.txt` | llms.txt spec | LLM-friendly site overview |
| `/llms-full.txt` | llms.txt spec | Complete data dump for LLMs |
| `/openapi.json` | OpenAPI 3.1 | REST API specification |
| `/robots.txt` | Standard | With AI bot rules |

**Serve the hyphenated alias from the same factory as the canonical endpoint** so the two can never drift:

```typescript
// src/routes/discovery.ts
const mcpServerCardHandler = (_req, res) => res.json(mcpServerCard());
router.get("/.well-known/mcp/server-card.json", mcpServerCardHandler);
router.get("/.well-known/mcp-server.json", mcpServerCardHandler); // d79032e
```

### 12.2 robots.txt for AI Bots

```
User-agent: *
Allow: /

# AI bot specific rules
User-agent: GPTBot
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: Amazonbot
Allow: /

User-agent: CCBot
Disallow: /

# Point AI bots to machine-readable endpoints
# llms.txt: https://YOUR_DOMAIN/llms.txt
# OpenAPI: https://YOUR_DOMAIN/openapi.json
# MCP: https://YOUR_DOMAIN/mcp
# A2A: https://YOUR_DOMAIN/a2a
```

### 12.3 Link Headers (RFC 8288)

Add to every HTTP response:
```typescript
app.use((req, res, next) => {
  res.setHeader("Link", [
    '</.well-known/agent-card.json>; rel="https://a2a.ai/spec/agent-card"',
    '</.well-known/mcp/server-card.json>; rel="https://modelcontextprotocol.io/server-card"',
    '</openapi.json>; rel="service-desc"'
  ].join(", "));
  next();
});
```

### 12.4 Markdown Content Negotiation

When AI agents request `Accept: text/markdown`, serve markdown instead of HTML:
```typescript
app.use((req, res, next) => {
  if (req.accepts("text/markdown") && !req.accepts("text/html")) {
    // Redirect to markdown version
  }
  next();
});
```

### 12.5 Keep Self-Described Identifiers in Sync

Your `/llms.txt`, `/agents.txt`, agent-card, and MCP registry description all advertise the **same** counts and the **same** npm/registry links. When any of those drift, every AI crawler that fetches two of the four endpoints gets conflicting data — and trust degrades silently.

Checklist for every endpoint that self-describes:
- Counts (`1165+ producers`) must be read from the live registry at request time, **not hardcoded or templated at build time**.
- Package names (e.g. `lokal-mcp`) must match the published npm name exactly. A typo like `lokal-food-mcp` in `llms.txt` sends every AI agent to a 404 — silent discoverability loss.
- Version numbers must come from `package.json`, not a string literal.

Suggested contract: a single `src/config/identity.ts` exports `{ packageName, registryCount, version }` and every self-describing route imports from there.

### 12.6 `ai-plugin.json` + `/api` Index (+35 pts on NotHumanSearch)

NotHumanSearch (and similar AI-discovery indexers) scores agentic-readiness partly on the presence of machine-readable API contracts. Two cheap additions lift the score by an estimated 35 points combined:

**1. `/.well-known/ai-plugin.json` — ChatGPT plugin manifest**

Even though OpenAI deprecated the plugin system in favor of GPTs, the file is still harvested as a "machine-readable API contract" signal (+~20 pts). It's a thin pointer to your OpenAPI spec.

```typescript
// src/routes/discovery.ts
router.get("/.well-known/ai-plugin.json", (_req, res) => {
  const stats = marketplaceRegistry.getStats();
  res.json({
    schema_version: "v1",
    name_for_human: "Rett fra Bonden",
    name_for_model: "rettfrabonden",
    description_for_human: "Finn lokalprodusert mat i Norge...",
    description_for_model:
      `Plugin for searching Norwegian local food producers. ` +
      `Access to ${stats.totalAgents || "1150+"} verified producers...`,
    auth: { type: "none" },
    api: { type: "openapi", url: `${BASE_URL}/openapi.json` },
    logo_url: `${BASE_URL}/logo.svg`,
    contact_email: "hello@rettfrabonden.com",
    legal_info_url: `${BASE_URL}/terms`,
  });
});
```

**2. `/api`, `/api/v1`, `/api/marketplace` — JSON API index** (+~15 pts)

Previously these paths 404'd even though `/api/marketplace/*` sub-routes worked — which hides the API surface from crawlers. A single JSON index lists available routes without changing any existing behavior.

```typescript
function serveApiIndex(_req, res) {
  const stats = marketplaceRegistry.getStats();
  res.json({
    name: "Rett fra Bonden API",
    version: "v1",
    description: `REST API. ${stats.totalAgents || "1150+"} agents.`,
    documentation: `${BASE_URL}/openapi.json`,
    protocols: {
      rest: `${BASE_URL}/api/marketplace`,
      mcp: `${BASE_URL}/mcp`,
      a2a: `${BASE_URL}/a2a`,
    },
  });
}
router.get("/api", serveApiIndex);
router.get("/api/v1", serveApiIndex);
router.get("/api/marketplace", serveApiIndex); // was 404 — advertised on A2A card
```

**3. Welcome NotHumanSearch + DuckDuckBot in robots.txt** (no score impact but removes ambiguity)

```
User-agent: NotHumanSearch
Allow: /

User-agent: DuckDuckBot
Allow: /
```

**4. Classify them in analytics.** Before this change NotHumanSearch alone was ~130 pageviews / 7 days that analytics was not attributing to any AI source. Add the UA tokens to `parseUserAgent()` and count them in the `other` bucket of the `agentTraffic` summary. (Commit `819577f`.)

---

<a id="phase-13"></a>
## Phase 13: Agent Readiness & Compliance

**Duration:** Day 19 (April 19)
**Commits:** `be81c67`

### 13.1 isitagentready.com Score

Test your agent compliance at: https://isitagentready.com/YOUR_DOMAIN

**Score progression:** 25/100 → ~80/100 after adding:
- `/.well-known/mcp/server-card.json`
- `/.well-known/mcp.json`
- `/.well-known/agent-skills/index.json`
- `/.well-known/api-catalog` (RFC 9727)
- `/.well-known/oauth-protected-resource` (RFC 9728)
- Link headers on all responses
- Markdown content negotiation

### 13.2 A2A v1.0 — Signed Agent Cards (incoming table-stakes)

A2A v1.0 shipped early 2026 with four changes: **Signed Agent Cards** (cryptographic signature proving domain ownership), multi-tenancy, multi-protocol bindings (JSON-RPC + gRPC), and version negotiation. Of these, **Signed Agent Cards is the one decentralized discovery actually depends on** — consuming agents will increasingly prefer signed cards and downrank unsigned ones.

**Timeline:** not yet blocking in April 2026, but ~2 quarters (Q3 2026) before unsigned cards are penalized in agent-trust scoring. Plan for:

1. Generate a domain signing key pair (keep the private key in Fly secrets: `AGENT_CARD_SIGNING_KEY`).
2. Publish the public key at `/.well-known/agent-card-public-key.pem` or as a JWK at `/.well-known/jwks.json`.
3. Emit a detached JWS over the agent-card JSON on every request to `/.well-known/agent-card.json` (header: `X-Agent-Card-Signature`) OR embed the signature as a top-level `signature` field per the A2A v1.0 spec.
4. Rotate the signing key via a scheduled task every 12 months; publish the old public key with a `validUntil` field so in-flight clients don't break.

Estimated effort: ~1 day of work once the A2A v1.0 JWS schema stabilizes. Track the A2A spec repo for the canonical signature format before implementing.

---

<a id="phase-14"></a>
## Phase 14: Claude Connectors Submission

**Duration:** Day 20 (April 20)
**Commits:** `b6ef984`, `a70350d`, `80f9a5e`, `e02d26c`, `72d6369`

### 14.1 Prerequisites

Before submitting to https://clau.de/mcp-directory-submission:

1. **Privacy policy** at `/privacy` (covers collection, usage, third-party, retention, contact)
2. **Terms of service** at `/terms`
3. **Tool annotations** on all MCP tools (`readOnlyHint`, `destructiveHint`, `idempotentHint`)
4. **Logo** (SVG + PNG 200×200 + 512×512) served from your domain
5. **Favicon** on all pages
6. **CORS** configured for `claude.ai` and `www.claude.ai` origins
7. **MCP headers** in CORS: `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Last-Event-ID`

### 14.2 Tool Annotations (Critical)

~30% of Connectors rejections are due to missing annotations:

```typescript
server.registerTool({
  title: "Search Producers",
  description: "...",
  inputSchema: { /* ... */ },
  annotations: {
    readOnlyHint: false,      // Does it modify state?
    destructiveHint: false,   // Does it delete data?
    idempotentHint: false,    // Same input = same result?
    openWorldHint: false      // Does it access external APIs?
  }
}, handler);
```

**Be honest:** If your search creates a conversation record (side effect), mark `readOnlyHint: false`.

### 14.2.1 Bilingual /terms Route Aliases

Ship the Terms of Service behind multiple slugs so both Norwegian and English
searchers land on the same page (Connectors reviewers also check the `/tos`
convention):

```typescript
// src/routes/discovery.ts
for (const slug of ["/terms", "/terms-of-service", "/tos", "/vilkar"]) {
  app.get(slug, handleTerms);
}
```

Do the same for the privacy page (`/privacy`, `/privacy-policy`, `/personvern`).

**GOTCHA:** Add each alias to the SEO catch-all exclusion list in `seo.ts`,
otherwise the catch-all renders a producer "not found" page on top of your
terms route.

### 14.3 CORS for Claude.ai

```typescript
import cors from "cors";
app.use(cors({
  origin: [
    "https://claude.ai",
    "https://www.claude.ai",
    "https://chatgpt.com",
    "https://chat.openai.com"
  ],
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type", "Authorization",
    "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"
  ],
  exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version"],
  credentials: true
}));
```

### 14.4 Submission

**HUMAN ACTION:** Fill out the form at https://clau.de/mcp-directory-submission

Review time: ~2 weeks.

---

<a id="phase-15"></a>
## Phase 15: AWS Bedrock AgentCore Registry

**Duration:** Day 19 (April 19)

### 15.1 Steps

1. **HUMAN:** Request AWS Bedrock AgentCore preview access
2. Create a registry in your preferred region (eu-west-1 for Europe)
3. Register two records:
   - MCP Server record pointing to `https://YOUR_DOMAIN/mcp`
   - A2A Agent record pointing to `https://YOUR_DOMAIN/a2a`
4. Enable auto-approval

**Result:** Your marketplace is discoverable by every AWS AgentCore customer.

### 15.2 Apicurio Agent Registry (OSS alternative)

Apicurio v3.1 (Feb 2026) is the first open-source registry with native
`AGENT_CARD` artifact support. Self-register by POSTing your existing agent
card:

```bash
curl -X POST \
  -H "X-Registry-ArtifactType: AGENT_CARD" \
  -H "X-Registry-ArtifactId: YOUR_ORG/YOUR_AGENT" \
  -H "Content-Type: application/json" \
  --data @/.well-known/agent-card.json \
  https://REGISTRY_HOST/apis/registry/v3/groups/default/artifacts
```

No review queue. Useful as a secondary registry surface and a redundancy layer
if the larger A2A registries stall on maintainer review.

### 15.3 data.norge.no — Norwegian national API catalog

For vertical-specific projects serving a Norwegian audience, submitting the
`/openapi.json` to Norway's national data portal adds a government-grade
backlink and signals "serious platform" to Norwegian B2G procurement.

**HUMAN ACTION required** — submission requires Altinn authentication.

1. Log in at `data.norge.no` via Altinn
2. Register your publishing organisation
3. Submit `/openapi.json` as a DCAT-AP-NO-compliant API resource
4. Tag with vertical (e.g. `landbruk`, `mat`) and bilingual description

---

<a id="phase-16"></a>
## Phase 16: Automated Agent Operations

**Duration:** Day 18-20 (April 18-20)

### 16.1 Agent Architecture

We run 4 daily scheduled agents:

| Agent | Schedule | Purpose |
|-------|----------|---------|
| AI Visibility Growth | 07:02 | Discover new distribution channels, monitor AI ecosystem |
| Marketing Comms | 09:10 | Email, social media, outreach content |
| Enrichment | On-demand | Enrich 50 agents per run |
| Supervisor | 12:05 | Review all reports, execute follow-ups, escalate |

### 16.2 Supervisor Agent Prompt

```
You are the Supervisor Agent for [YOUR_PLATFORM].

DAILY WORKFLOW:
1. Read today's reports from:
   - AI Visibility Growth agent (growth-reports/YYYY-MM-DD.md)
   - Marketing Comms agent (marketing reports)
   - Enrichment agent (enrichment-reports/)
2. Triage each action item:
   - CAN EXECUTE: Technical fixes, registry updates, API calls → DO IT NOW
   - NEEDS HUMAN: Account logins, payments, strategic decisions → ESCALATE
3. Execute all technical items
4. Save structured report to supervisor-reports/YYYY-MM-DD.md
5. Escalate remaining items with:
   - WHY it matters (business impact)
   - WHAT the human needs to do (specific action)
   - POTENTIAL GAIN (quantified if possible)

RULES:
- Facts only. Never fabricate metrics or claims.
- Don't reveal competitive strategy in public-facing content.
- Don't promise features that don't exist yet.
- Use git clone→push workflow for code changes.
```

### 16.3 GitHub PAT for Automated Pushes

Scheduled agents need a GitHub PAT to push code changes:

1. **HUMAN:** Create fine-grained PAT at github.com/settings/personal-access-tokens/new
2. Scope: your repo only, `Contents: Read and write`
3. Save to `.gh-pat` file in workspace (add to .gitignore)
4. Agent reads PAT → pushes → scrubs URL

---

<a id="phase-17"></a>
## Phase 17: Conversation System & AG-UI

**Duration:** Day 19 (April 19)
**Commits:** `d268cc6`, `a1ced31`, `e2ffeb1`

### 17.1 A2A Conversations

When a consumer agent searches, we auto-create a conversation between the buyer and matched producer agents:

```typescript
// In search handler:
const results = searchAgents(query);
for (const agent of results) {
  conversationService.startConversation({
    buyerQuery: query,
    agentId: agent.id,
    autoRespond: true,
    source: "mcp"  // or "a2a", "web", "gpt"
  });
}
```

### 17.2 Conversation UI

A web-based UI at `/samtale/:id` showing the A2A conversation between buyer and seller agents. Grouped by search query in an accordion layout.

### 17.3 `/samtaler` — Source Filters, Per-Source Stats, Client Identity

Once traffic is coming from A2A, MCP, the web frontend, and direct API calls all at once, a flat conversation list becomes noise. The overview page at `/samtaler` now supports:

**1. Source filter tabs.** `?kilde=a2a|mcp|web|api` narrows the list to one source. The tab bar also shows the per-source count so the distribution is visible at a glance.

**2. Stats dashboard at the top of the page.** A card per source with the total conversation count. The active filter's card is highlighted. Implemented via a new service method:

```typescript
// src/services/conversation-service.ts
getSourceStats(): Array<{ source: string; count: number }> {
  return db
    .prepare(`SELECT source, COUNT(*) AS count FROM conversations
              GROUP BY source ORDER BY count DESC`)
    .all();
}
```

**3. Display cap at 50 conversations** to keep the page fast as the corpus grows.

**4. Web-frontend search tracking.** Searches from `/sok` (the human-facing search page) now emit conversations with `source: "web"` so the same UI can show human traffic alongside agent traffic.

**5. MCP client identity detection.** Requests into `/mcp` carry client-identity hints in User-Agent or `x-mcp-client` headers. Parse them and tag each conversation so you can tell ChatGPT, Claude, and Cursor apart:

```typescript
// src/routes/mcp.ts — inside the MCP request handler
function detectMcpClient(req: Request): string | undefined {
  const ua = (req.get("user-agent") || "").toLowerCase();
  const hdr = (req.get("x-mcp-client") || "").toLowerCase();
  if (ua.includes("chatgpt") || hdr.includes("chatgpt")) return "chatgpt";
  if (ua.includes("claude")  || hdr.includes("claude"))  return "claude";
  if (ua.includes("cursor")  || hdr.includes("cursor"))  return "cursor";
  return undefined;
}
```

The client tag is rendered next to each conversation group so you can see at a glance *who* is searching through your MCP surface.

Commit: `63b0605`.

### 17.4 A2A Registry Health: `GET /a2a` Returns the Agent Card

A2A registries (e.g. `a2aregistry.org`) probe endpoints with a plain `GET` as a health check. Our endpoint only implemented the `POST` JSON-RPC path, so the registry saw a 404 and flagged us as unhealthy — even though the A2A protocol itself worked. Fix: add a `GET` handler that returns the dynamic agent card (live agent count, live stats) so registry health checks pass.

```typescript
// src/routes/a2a.ts
router.get("/", (_req, res) => {
  const stats = marketplaceRegistry.getStats();
  res.json(buildAgentCard({ agentCount: stats.totalAgents }));
});
```

This is the pattern to follow for *any* protocol endpoint: the "wrong verb" should return something useful (card, manifest, or docs), not 404. Commit: `98dd4cf`.

---

<a id="appendix-a"></a>
## Appendix A: Tech Stack Reference

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | 20 LTS |
| Language | TypeScript | 6.x |
| Framework | Express | 5.x |
| Database | SQLite (better-sqlite3) | 12.x |
| Validation | Zod | 4.x (3.x compat for MCP) |
| MCP SDK | @modelcontextprotocol/sdk | 1.29+ |
| Security | Helmet, express-rate-limit | Latest |
| Email | Nodemailer / Resend | 8.x |
| Hosting | Fly.io | Shared-cpu-1x, 512MB |
| Domain | Namecheap | - |
| CI/CD | Git push → fly deploy | Manual |

---

<a id="appendix-b"></a>
## Appendix B: Deployment Checklist

```
Pre-deploy:
□ All tests pass locally
□ TypeScript compiles without errors
□ No hardcoded secrets in code
□ Version bumped where needed

Deploy:
□ git pull origin main
□ fly deploy
□ Check fly logs for errors
□ Verify /.well-known/agent-card.json returns 200
□ Verify /mcp tools/list works
□ Verify /admin/dashboard loads

Post-deploy:
□ Check isitagentready.com score
□ Test Google Rich Results (search.google.com/test/rich-results)
□ Run quick MCP test from Claude Desktop
□ Check analytics dashboard for errors
```

---

<a id="appendix-c"></a>
## Appendix C: Gotchas & Lessons Learned

### C.1 Critical Bugs We Hit

1. **`this` context in Express middleware override** — Never use `this` inside `res.send` override. Use `const self = this`. Crashed entire production site.

2. **Inline onclick handlers** — MetaMask SES blocks them. Always use `addEventListener`.

3. **Fly.io secrets staging** — Setting a secret does NOT deploy it. Must click "Deploy Secrets" separately.

4. **npm publish from wrong directory** — Must `cd mcp-server` first. Publishing from root hits permission errors.

5. **MCP Registry duplicate version** — Cannot publish same version twice. Must bump version in both `package.json` and `server.json`.

6. **A2A Registry schema** — Uses `wellKnownURI` not `agentCardUrl`, `registryTags` not `categories`, `capabilities` as object not array.

7. **Google Product schema** — Every `Product` in JSON-LD needs `offers` with `availability`. Without it: "Invalid Product" in Rich Results.

8. **SQLite datetime format** — Use `datetime('now')` not `new Date().toISOString()` for consistency with SQLite's built-in functions.

9. **UTF-8 mojibake in agent-card.json** — Windows-authored source files read as cp1252. Always verify encoding with `file` command.

10. **OOM at 256MB with 1000+ agents** — Trust score recalculation + analytics middleware exhausted RAM. Upgraded to 512MB.

11. **Tier 2 enrichment fields silently drop** — `PUT /agents/{id}/knowledge` with `seasonality`, `images`, or `deliveryRadius` returns `200 OK` but the fields don't land in SQLite. Agents report "enriched" in their logs while the database still shows the fields empty. Root cause: the knowledge service's INSERT/UPDATE statement was never extended when these columns were added. Either extend the persistence layer or temporarily mark these fields as "not yet live" in the enrichment agent prompt so it stops wasting budget on them.

12. **Stale admin key propagates to every sub-agent** — When the admin key rotates, every scheduled agent that cached the old string in its prompt or memory file keeps 401-ing on `/admin/*` and mis-reports the dashboard as "broken." Two fixes: (a) treat the admin key as a single source of truth in a memory file the supervisor rewrites after rotation, (b) have sub-agents fail loudly on 401 rather than proceed on stale data. Symptom when this happens: multiple reports the same day claim "dashboard blocked" while `curl` with the current key returns 200.

13. **`/agents.txt` at root returns 404 unless explicitly aliased** — Agent-discovery clients inconsistently look for `/.well-known/agents.txt` vs `/agents.txt`. Serve both from the same handler:
   ```typescript
   const agentsTxt = (req, res) => res.type("text/plain").send(renderAgentsTxt());
   app.get("/.well-known/agents.txt", agentsTxt);
   app.get("/agents.txt", agentsTxt);
   ```

14. **AI-bot user-agent classifier reads from the wrong table** — `agentTraffic.chatgpt` / `agentTraffic.claude` reported 0 for weeks while `/admin/analytics/visitors` clearly showed GPTBot with 906 page views and ClaudeBot with 48. Two compounding bugs: (a) the classifier matched substring `chatgpt` against the user-agent, missing `GPTBot` entirely; (b) it aggregated from `analytics_queries` (the search-query table), but crawlers produce page views, not search queries — they almost never hit `/search`. Fix: store `session_id` as `ipHash:userAgent`, aggregate from `analytics_page_views` with `session_id LIKE '%GPTBot%'` (etc.), and whitelist the full crawler UA list (see Phase 7.4). Symptom when this happens: a "we have no AI traffic" panic that's actually a metric bug.

15. **WordPress vulnerability scanners poison `/admin/analytics/pages`** — Within 48 hours of going live, automated scanners hit `/wp-admin/setup-config.php`, `/wlwmanifest.xml` (8 path variants), `/.env`, `/.git/config`, `/phpunit/eval-stdin.php` etc. — hundreds of times. They will dominate your top-20 pages chart and obscure real content popularity. Filter them at the top-pages query, but keep the rows in the underlying `analytics_page_views` table (they show up correctly in `/traffic-classification` as `scanner` for security visibility). See Phase 7.5 for the SQL.

16. **`llms.txt` advertised the wrong npm package name** — `lokal-food-mcp` instead of `lokal-mcp`. Lived in production for ~5 days before anyone caught it. Every AI agent that followed our self-described discovery doc hit a 404 on npm. Root cause: hardcoded string in `discovery.ts` that wasn't kept in sync with the actual `mcp-server/package.json` name. See Phase 12.5 for the fix pattern (single identity module).

17. **a2a-registry doesn't accept PR submissions** — We submitted PR #102 with a clean agent-card JSON file; the maintainer closed it on 2026-04-20 with a note that registration must happen via the registry's programmatic registration endpoint, not via Pull Request. Always check a registry's preferred submission channel **before** investing in a PR. Symptom: a clean PR sitting open for days, then closed with a one-line "wrong channel" note.

18. **Tier 2 enrichment columns written but never read** — `upsertKnowledge()` correctly persisted `images`, `seasonality`, `delivery_radius`, and `min_order_value`, but `getKnowledge()` used an explicit column list that predated those fields. Reads returned `undefined`, the enrichment agent saw "empty" and re-wrote the same value on every run — silently wasting budget and producing "no change" in the eyes of any consumer. The fix is a one-line change to the SELECT, but the lesson is structural: **explicit column lists in both INSERT and SELECT must be kept in lock-step whenever the schema evolves.** A safer pattern is `SELECT *` with a typed projection at the TypeScript layer, so adding a column is additive in only one place. Commit: `3a69038`.

19. **Stale hardcoded counts drift across self-describing files** — The number `1,400+` (or `1400+`) appeared as a hardcoded literal in `README.md`, `mcp-server/server.json`, the `/teknologi` HTML template, `llms.txt` fallbacks, and agent-readiness copy — long after the registry had dropped to ~1,150 live agents. AI crawlers that fetch two of these files see conflicting claims and quietly downgrade trust. Root cause: Phase 12.5's "single identity module" rule was added *after* some of these literals had already landed. Running fix-up: keep a weekly visibility-agent sweep that greps for the last claimed count in every file, and track every file that self-describes the count in a single list. Commits: `2fe7854`, `6b2dca7`, `c9074db`.

20. **Protocol endpoints that only support one HTTP verb fail health checks** — `POST /a2a` worked fine, but registries probe with `GET /a2a` as a liveness check. Without a `GET` handler we returned 404 and got flagged as unhealthy, even though the protocol itself was up. Fix: every protocol endpoint's "wrong verb" should return something useful (the agent card, a small manifest, or docs), never 404. Commit: `98dd4cf`. See Phase 17.4.

21. **`/samtaler` shell appended the brand twice** — The page template auto-appends " — Rett fra Bonden" to the `<title>`, and the route also included the brand in its explicit title string, so the rendered title read *"Samtaler — Rett fra Bonden — Rett fra Bonden"*. Only the shell should brand the page; route titles should be the page-specific part only. Commit: `c9074db`.

### C.2 Architecture Decisions

1. **SQLite over PostgreSQL** — Zero ops, single file, perfect for solo developer. Good up to ~10K agents.

2. **No separate staging environment** — Same Fly app, two URLs (your-app.fly.dev for testing, custom domain for production).

3. **SSR over SPA** — Google indexes server-rendered pages. SPA only for dashboard/admin.

4. **No payment processing** — Discovery only in v1. Reduces complexity by 80%.

5. **Bilingual (NO/EN)** — Norwegian for producers and SEO, English for developer/agent interfaces.

---

<a id="appendix-d"></a>
## Appendix D: Registry Status Matrix

| Registry/Platform | Status | URL | Notes |
|-------------------|--------|-----|-------|
| npm | ✅ Live | npmjs.com/package/lokal-mcp | v0.3.3 |
| Smithery.ai | ✅ Live | smithery.ai/servers/slookisen/lokal-norsk-matfinner | Score 76/100 |
| Glama.ai | ✅ Live | glama.ai/mcp/servers/slookisen/lokal | v0.3.1 |
| mcp.so | ✅ Submitted | mcp.so | Manual review |
| Official MCP Registry | ✅ Published | registry.modelcontextprotocol.io | v0.3.3 |
| A2A Registry | ❌ PR Closed | github.com/prassanna-ravishankar/a2a-registry/pull/102 | Closed 2026-04-20. Maintainer requires programmatic registration via the registry endpoint, not PRs. Re-submit through `a2aregistry.org` API. |
| Google Search Console | ✅ Verified | search.google.com | 850+ URLs indexed |
| Custom GPT | ✅ Live | chatgpt.com/g/g-69dbf...finn-lokal-mat-i-norge | Public GPT Store |
| Claude Connectors | ⏳ Submitted | clau.de/mcp-directory-submission | ~2 week review (submitted 2026-04-20) |
| AWS Bedrock AgentCore | ✅ Live | eu-west-1 registry | 2 records approved |
| Apicurio Agent Registry | 📋 Backlog | apicur.io (v3.1+, Feb 2026) | First OSS registry with native AGENT_CARD artifact support. Self-register via `curl`. |
| data.norge.no API Catalog | 📋 Backlog | data.norge.no/en/catalogs/data-services | Norwegian national API catalog (DCAT-AP-NO). Altinn auth required. Government-grade backlink. |
| Perplexity Computer (enterprise) | ℹ️ Admin-install | perplexity.ai | Enterprise admins self-install MCP connectors. No public directory. Document the connect URL in README. |
| a2aagentlist.com | 📋 Backlog | a2aagentlist.com | Mirror submission of PR #102 content if the main A2A Registry goes silent. |
| AGNTCY Agent Directory (Cisco/Outshift) | 📋 Backlog | docs.agntcy.org/dir/hosted-agent-directory | **Highest-leverage new registry** — only one that accepts both an A2A card and an MCP server as one composite record. Requires `dirctl` CLI (`go install github.com/agntcy/dir/cmd/dirctl@latest`) + Sigstore-signed records. GitHub-org auth. |
| MACH Alliance MCP Registry | 📋 Backlog | machalliance.org/mach-alliance-mcp-registry | Vendor-neutral, launched late 2025, rapid enterprise uptake Q1 2026. Open to non-members, ~30-min form submission. |
| NANDA Index (MIT Media Lab) | 📋 Backlog | nanda.media.mit.edu | "Open Agentic Web" project. Uses AgentFacts decentralized verifiable credentials. Year-round open registration. NANDA Summit ran Apr 9–11, 2026. |
| PulseMCP | 📋 Backlog | pulsemcp.com | Independent MCP directory. Open submissions. |

---

<a id="appendix-e"></a>
## Appendix E: Agent Prompts (Copy-Paste Ready)

### E.1 Discovery Agent

```
You are the Discovery Agent. Find and register new [VERTICAL] producers.

WORKFLOW:
1. Pick a geographic region not yet fully covered
2. Web search: "[VERTICAL] producers in [REGION]"
3. For each producer found:
   a. Search existing registry: GET {API}/api/marketplace/search?q={name}
   b. If not found, gather: name, description, location, lat/lng, category,
      website, phone, email, products
   c. Register: POST {API}/api/marketplace/register (with X-Admin-Key header)
4. Write discovery report

API: {API_URL}
Admin Key: {ADMIN_KEY}
Rate limit: 0.5s between requests
Target: 30-50 new agents per run
Skip: chains, franchises, closed businesses, non-{VERTICAL}
```

### E.2 Enrichment Agent

```
You are the Enrichment Agent. Improve data quality for existing agents.

WORKFLOW:
1. GET {API}/api/stats to see total agent count
2. GET {API}/api/marketplace/agents?limit=50&offset={random} for a batch
3. For each agent:
   a. GET /agents/{id}/knowledge — check current completeness
   b. If missing phone/email/website: web search for the producer
   c. Extract data from: official website, Google Maps, Facebook, Instagram
   d. PUT /agents/{id}/knowledge with enriched data
   e. Generate vCard if phone or email found
4. Trust score is auto-recalculated
5. Write enrichment report with stats

API: {API_URL}
Admin Key: {ADMIN_KEY}
Rate limit: 0.4s between API calls
Target: 50 agents per run
DELETE invalid agents: no web presence, permanently closed, not {VERTICAL}
```

### E.3 AI Visibility Growth Agent

```
You are the AI Visibility Growth Agent. Maximize discoverability across AI platforms.

DAILY WORKFLOW:
1. Check current marketplace registrations status
2. Web search for new MCP/A2A marketplaces and directories
3. For each new opportunity:
   a. Assess effort vs. reach
   b. If < 30 min and high reach: prepare submission
   c. If requires human login: add to escalation list
4. Monitor existing listings for issues
5. Check AI search engines (Perplexity, ChatGPT, Claude) for our visibility
6. Write growth report with metrics and action items

API: {API_URL}
Save reports to: growth-reports/YYYY-MM-DD.md
```

### E.4 Supervisor Agent

```
You are the Supervisor Agent. Coordinate all sub-agents.

DAILY WORKFLOW (runs after all other agents):
1. Read today's reports from growth-reports/, marketing-reports/, enrichment-reports/
2. For each action item, triage:
   - EXECUTE NOW: Technical fixes, API calls, code changes
   - ESCALATE: Requires human login, payment, or strategic decision
3. Execute all "EXECUTE NOW" items
4. Write supervisor report:
   - What was executed (with results)
   - What needs human attention (with WHY and WHAT)
5. Push code changes via git if any

API: {API_URL}
Admin Key: {ADMIN_KEY}
Git: Clone → edit → push workflow
```

### E.5 Guide-book Agent

```
You are the Guide-book Agent. Maintain the reproducible project guide.

DAILY WORKFLOW:
1. Read the current GUIDEBOOK.md
2. Read today's conversation transcripts (if available)
3. Read supervisor-reports/ and growth-reports/ for today
4. Check git log for new commits since last update
5. For each new feature, fix, or registration:
   a. Identify which phase it belongs to
   b. Add step-by-step instructions to reproduce it
   c. Include exact commands, API calls, and configurations
   d. Note any gotchas or lessons learned
6. Update the guide version and "last updated" timestamp
7. Push changes

Guide location: /A2A/GUIDEBOOK.md
Git: Clone → edit → push workflow
Focus: Reproducibility. Another agent should be able to follow this guide
to build the same platform for a different vertical.
```

---

## Changelog

| Date | Phase | What Changed |
|------|-------|-------------|
| 2026-03-29 | 0 | Project concept defined |
| 2026-03-31 | 0-1 | Initial deploy to Fly.io, 370 agents |
| 2026-04-01 | 1-2 | Knowledge layer, claim system, email service, seed dedup |
| 2026-04-02 | 3 | OpenAPI spec |
| 2026-04-06 | 6 | Seller dashboard |
| 2026-04-07 | 7 | Trust score engine |
| 2026-04-13 | 4, 9 | Domain migration to rettfrabonden.com, Smithery+Glama |
| 2026-04-14 | 5, 7 | SEO v2, analytics, monetization roadmap |
| 2026-04-15 | 8, 9 | Security hardening, MCP registries (npm+Smithery+Glama+mcp.so+Official) |
| 2026-04-16 | 7, 6 | Analytics dashboard, magic link login, privacy policy |
| 2026-04-17 | 7 | Traffic widget, health endpoint, 502 fix (caching) |
| 2026-04-18 | 11 | Enrichment pipeline, geocoding, admin registration |
| 2026-04-19 | 12, 13, 15, 17 | Discovery layer, agent readiness, AWS registry, conversations |
| 2026-04-20 | 14, 16 | Claude Connectors submission, supervisor agent, Product schema fix |
| 2026-04-20 | 14, 15, C, D | Terms-of-service aliases, Apicurio + data.norge.no registries, Tier 2 enrichment & stale-admin-key gotchas, `/agents.txt` root alias |
| 2026-04-21 | 7, 11, 12, 13, C, D | Analytics: AI-bot UA classifier (7.4) + scanner-noise filter (7.5). Enrichment run #30 coverage snapshot (11.5) + throughput tuning (11.6). Discovery: keep self-described identifiers in sync (12.5). A2A v1.0 Signed Agent Cards plan (13.2). Appendix C: gotchas C.14 (UA classifier), C.15 (WP scanner noise), C.16 (llms.txt npm typo), C.17 (a2a-registry submission channel). Appendix D: AGNTCY, MACH Alliance, NANDA, PulseMCP added to backlog; a2a-registry status flipped from PR-Open to PR-Closed. |
| 2026-04-21 | 6, 17, C | Admin notification email on claim verify (6.4). `/samtaler` upgrade: source filter tabs, per-source stats, web-search tracking, MCP client identity detection (17.3). `GET /a2a` returns agent card for registry health checks (17.4). Appendix C: gotcha C.18 (Tier 2 columns written but not read — `getKnowledge()` SELECT fix), C.20 (protocol endpoints must handle both verbs). |
| 2026-04-22 | 5, 7, 12 | Per-city context paragraph grounded in live registry data (5.5). `avgTimeOnSite` computed from session spans instead of hardcoded 0 (7.6). `/.well-known/ai-plugin.json` + `/api` JSON index (+35 pts on NotHumanSearch agentic-readiness) (12.6). NotHumanSearch + DuckDuckBot classified in analytics and welcomed in robots.txt. Stale "1400+" count purged from `/teknologi` and server-card fallback. |
| 2026-04-23 | 12, C | `/.well-known/mcp-server.json` hyphenated alias added to discovery endpoints (12.1). Remaining "1,400+" literal purged from AI-facing metadata (agent-readiness copy, agent-discovery middleware, llms.txt home/about). README and MCP registry description reduced to safe under-claim ("1,100+"). `/samtaler` double-brand `<title>` fix. Appendix C: gotchas C.19 (hardcoded counts drift across self-describing files), C.21 (double-brand title). |

---

*Last updated: 2026-04-23 (14:00 CEST) by rfb-guidebook agent*
*Guide version: 1.1.0*
