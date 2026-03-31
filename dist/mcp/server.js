#!/usr/bin/env node
"use strict";
// ─── Lokal MCP Server ────────────────────────────────────────
// This makes Lokal available as a tool in Claude Desktop.
//
// How it works:
//   1. Claude Desktop spawns this process via stdio
//   2. This server exposes 4 tools: search, discover, register, agent-info
//   3. When a user asks Claude "finn lokale grønnsaker i Oslo",
//      Claude calls our search tool, we hit the Lokal API,
//      and return structured results.
//
// Two modes:
//   - Local: talks to http://localhost:3000 (dev)
//   - Remote: talks to the deployed URL (production)
//
// Install: Add to claude_desktop_config.json:
//   { "mcpServers": { "lokal": { "command": "npx", "args": ["tsx", "src/mcp/server.ts"] } } }
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const API_BASE = process.env.LOKAL_API_URL || "http://localhost:3000";
// ─── Create MCP Server ──────────────────────────────────────
const server = new mcp_js_1.McpServer({
    name: "lokal",
    version: "0.3.0",
});
// ─── Tool 1: Search (Natural Language) ──────────────────────
// The most important tool. Users say things like:
//   "finn ferske grønnsaker nær Grünerløkka"
//   "økologisk honning i Oslo"
//   "hvor kan jeg kjøpe egg lokalt?"
server.tool("lokal_search", "Søk etter lokal mat i Oslo og omegn med naturlig språk. Støtter norsk og engelsk. Eksempel: 'ferske grønnsaker nær Grünerløkka', 'organic honey oslo', 'egg fra lokale bønder'.", {
    query: zod_1.z.string().describe("Naturlig språk søk etter lokal mat (norsk eller engelsk)"),
    limit: zod_1.z.number().min(1).max(50).default(10).describe("Maks antall resultater"),
}, async ({ query, limit }) => {
    try {
        const url = `${API_BASE}/api/marketplace/search?q=${encodeURIComponent(query)}&limit=${limit}`;
        const response = await fetch(url);
        const data = await response.json();
        if (!data.success) {
            return { content: [{ type: "text", text: `Søk feilet: ${data.error}` }] };
        }
        // Format results for Claude
        let text = `🥬 **Lokal mat-søk: "${query}"**\n`;
        text += `Forstått som: ${formatParsed(data.parsed)}\n`;
        text += `Fant ${data.count} resultater:\n\n`;
        for (const r of data.results) {
            const a = r.agent;
            const dist = a.location?.distanceKm ? `${a.location.distanceKm.toFixed(1)} km` : "";
            text += `**${a.name}** (score: ${(r.relevanceScore * 100).toFixed(0)}%)`;
            if (dist)
                text += ` — ${dist} unna`;
            text += `\n`;
            text += `  ${a.description.slice(0, 150)}\n`;
            if (a.categories.length)
                text += `  Kategorier: ${a.categories.join(", ")}\n`;
            if (a.tags.length)
                text += `  Tags: ${a.tags.join(", ")}\n`;
            if (r.matchReasons.length)
                text += `  Match: ${r.matchReasons.join(" · ")}\n`;
            text += `\n`;
        }
        return { content: [{ type: "text", text }] };
    }
    catch (err) {
        return { content: [{ type: "text", text: `Feil ved søk: ${err.message}. Er Lokal-serveren kjørende på ${API_BASE}?` }] };
    }
});
// ─── Tool 2: Discover (Structured Query) ────────────────────
// For when Claude needs precise filtering:
//   categories, tags, geo-location, role
server.tool("lokal_discover", "Strukturert søk i Lokal-registeret. Filtrer på kategorier (vegetables, fruit, honey, etc.), tags (organic, fresh, local), rolle (producer/logistics/quality), og avstand fra koordinater.", {
    categories: zod_1.z.array(zod_1.z.string()).optional().describe("Kategorier: vegetables, fruit, berries, dairy, eggs, meat, fish, bread, honey, herbs"),
    tags: zod_1.z.array(zod_1.z.string()).optional().describe("Tags: organic, seasonal, budget, local, fresh"),
    role: zod_1.z.enum(["producer", "consumer", "logistics", "quality", "price-intel"]).default("producer").describe("Agentrolle"),
    lat: zod_1.z.number().optional().describe("Breddegrad for avstandsfilter"),
    lng: zod_1.z.number().optional().describe("Lengdegrad for avstandsfilter"),
    maxDistanceKm: zod_1.z.number().optional().describe("Maks avstand i km"),
    limit: zod_1.z.number().min(1).max(50).default(10).describe("Maks resultater"),
}, async ({ categories, tags, role, lat, lng, maxDistanceKm, limit }) => {
    try {
        const body = { role, limit };
        if (categories?.length)
            body.categories = categories;
        if (tags?.length)
            body.tags = tags;
        if (lat && lng) {
            body.location = { lat, lng };
            body.maxDistanceKm = maxDistanceKm || 15;
        }
        const response = await fetch(`${API_BASE}/api/marketplace/discover`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await response.json();
        let text = `🔍 **Strukturert søk**\n`;
        text += `Filter: ${JSON.stringify({ categories, tags, role, maxDistanceKm })}\n`;
        text += `Fant ${data.count} agenter:\n\n`;
        for (const r of data.results) {
            const a = r.agent;
            text += `**${a.name}** — ${a.role}\n`;
            text += `  ${a.description.slice(0, 150)}\n`;
            if (a.location?.distanceKm)
                text += `  Avstand: ${a.location.distanceKm.toFixed(1)} km\n`;
            text += `  Trust: ${(a.trustScore * 100).toFixed(0)}% | Verifisert: ${a.isVerified ? "Ja" : "Nei"}\n\n`;
        }
        return { content: [{ type: "text", text }] };
    }
    catch (err) {
        return { content: [{ type: "text", text: `Feil: ${err.message}` }] };
    }
});
// ─── Tool 3: Register Agent ─────────────────────────────────
// Let producers register directly from Claude
server.tool("lokal_register", "Registrer en ny produsent/tjenesteagent i Lokal-markedsplassen. Returnerer API-nøkkel for fremtidige oppdateringer.", {
    name: zod_1.z.string().describe("Agentens navn"),
    description: zod_1.z.string().min(10).describe("Beskrivelse av hva agenten tilbyr"),
    provider: zod_1.z.string().describe("Organisasjon bak agenten"),
    contactEmail: zod_1.z.string().email().describe("Kontakt-epost"),
    url: zod_1.z.string().url().describe("Agentens URL/endepunkt"),
    role: zod_1.z.enum(["producer", "consumer", "logistics", "quality", "price-intel"]).describe("Agentrolle"),
    categories: zod_1.z.array(zod_1.z.string()).describe("Kategorier: vegetables, fruit, honey, etc."),
    tags: zod_1.z.array(zod_1.z.string()).describe("Tags: organic, local, fresh, etc."),
    city: zod_1.z.string().default("Oslo").describe("By"),
    lat: zod_1.z.number().optional().describe("Breddegrad"),
    lng: zod_1.z.number().optional().describe("Lengdegrad"),
}, async ({ name, description, provider, contactEmail, url, role, categories, tags, city, lat, lng }) => {
    try {
        const body = {
            name, description, provider, contactEmail, url, role, categories, tags,
            skills: [{ id: "default", name: name, description: description, tags: [...categories, ...tags] }],
        };
        if (lat && lng)
            body.location = { lat, lng, city };
        const response = await fetch(`${API_BASE}/api/marketplace/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await response.json();
        if (data.success) {
            return {
                content: [{
                        type: "text",
                        text: `✅ **Agent registrert!**\nID: ${data.data.id}\nAPI-nøkkel: ${data.data.apiKey}\nAgent Card: ${data.data.agentCardUrl}\n\n⚠️ Ta vare på API-nøkkelen — den trengs for å oppdatere agenten.`,
                    }],
            };
        }
        return { content: [{ type: "text", text: `❌ Registrering feilet: ${JSON.stringify(data)}` }] };
    }
    catch (err) {
        return { content: [{ type: "text", text: `Feil: ${err.message}` }] };
    }
});
// ─── Tool 4: Platform Info ──────────────────────────────────
// Quick overview of the registry
server.tool("lokal_info", "Hent statistikk og info om Lokal-plattformen: antall agenter, produsenter, byer, og helsetilstand.", {}, async () => {
    try {
        const [statsRes, healthRes] = await Promise.all([
            fetch(`${API_BASE}/api/marketplace/stats`),
            fetch(`${API_BASE}/health`),
        ]);
        const stats = await statsRes.json();
        const health = await healthRes.json();
        const s = stats.data;
        let text = `📊 **Lokal Platform Info**\n`;
        text += `Status: ${health.status} | Versjon: ${health.version} | DB: ${health.database}\n`;
        text += `Oppetid: ${Math.floor(health.uptime / 60)} min\n\n`;
        text += `Agenter: ${s.totalAgents} totalt, ${s.activeProducers} aktive produsenter\n`;
        text += `Byer: ${s.cities.join(", ")}\n`;
        text += `Listings: ${s.totalListings}\n`;
        text += `\nA2A endpoint: ${API_BASE}/a2a\n`;
        text += `Agent Card: ${API_BASE}/.well-known/agent.json\n`;
        return { content: [{ type: "text", text }] };
    }
    catch (err) {
        return { content: [{ type: "text", text: `Kan ikke nå Lokal-serveren på ${API_BASE}: ${err.message}` }] };
    }
});
// ─── Tool 5: A2A JSON-RPC (raw) ────────────────────────────
// For power users / other agent frameworks
server.tool("lokal_jsonrpc", "Send en rå JSON-RPC 2.0 forespørsel til Lokal A2A-endepunktet. For avansert bruk og agent-til-agent kommunikasjon.", {
    method: zod_1.z.string().describe("JSON-RPC metode: message/send, tasks/get, tasks/list"),
    params: zod_1.z.record(zod_1.z.any()).describe("Metode-parametere som JSON objekt"),
}, async ({ method, params }) => {
    try {
        const response = await fetch(`${API_BASE}/a2a`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Date.now().toString() }),
        });
        const data = await response.json();
        return {
            content: [{ type: "text", text: `JSON-RPC Response:\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` }],
        };
    }
    catch (err) {
        return { content: [{ type: "text", text: `JSON-RPC feil: ${err.message}` }] };
    }
});
// ─── Helper ─────────────────────────────────────────────────
function formatParsed(parsed) {
    const parts = [];
    if (parsed.categories?.length)
        parts.push(`kategorier=[${parsed.categories.join(",")}]`);
    if (parsed.tags?.length)
        parts.push(`tags=[${parsed.tags.join(",")}]`);
    if (parsed.location)
        parts.push(`lokasjon=(${parsed.location.lat.toFixed(2)}, ${parsed.location.lng.toFixed(2)})`);
    if (parsed.maxDistanceKm)
        parts.push(`maks ${parsed.maxDistanceKm}km`);
    return parts.join(", ") || "alle produsenter";
}
// ─── Connect via stdio ──────────────────────────────────────
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("🥬 Lokal MCP Server connected via stdio");
    console.error(`   API: ${API_BASE}`);
}
main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map