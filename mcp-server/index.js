#!/usr/bin/env node

/**
 * Lokal MCP Server — Find local food in Norway via Claude Desktop
 *
 * Install:
 *   npx lokal-mcp
 *
 * Or add to Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "lokal": {
 *         "command": "npx",
 *         "args": ["lokal-mcp"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.LOKAL_URL || "https://rettfrabonden.com";

// ── Helpers ──────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "lokal-mcp/0.2.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "lokal-mcp/0.2.0",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

function absoluteUrl(pathOrUrl) {
  if (!pathOrUrl) return undefined;
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) return pathOrUrl;
  return `${BASE_URL}${pathOrUrl}`;
}

// Format a single agent for chat output, including action-handles
// (tel:, mailto:, vCard) when the server has contact data for it.
function formatAgent(agent, idx, contact) {
  const lines = [`**${idx}. ${agent.name}**`];
  if (agent.description) lines.push(`   ${agent.description}`);

  const meta = [];
  if (agent.location?.city) meta.push(`📍 ${agent.location.city}`);
  if (agent.categories?.length) meta.push(`🏷️ ${agent.categories.join(", ")}`);
  if (agent.trustScore) meta.push(`✅ Trust ${Math.round(agent.trustScore * 100)}%`);
  if (agent.isVerified) meta.push("✔ Verifisert");
  if (meta.length) lines.push(`   ${meta.join("  ·  ")}`);

  if (contact) {
    const contactLines = [];
    if (contact.address) {
      const postal = contact.postalCode ? `, ${contact.postalCode}` : "";
      contactLines.push(`📍 ${contact.address}${postal}`);
    }
    if (contact.phone) contactLines.push(`📞 [${contact.phone}](tel:${contact.phone.replace(/\s+/g, "")})`);
    if (contact.email) contactLines.push(`✉️ [${contact.email}](mailto:${contact.email})`);
    if (contact.website) contactLines.push(`🌐 ${contact.website}`);
    if (contact.paymentMethods?.length) contactLines.push(`💳 ${contact.paymentMethods.join(", ")}`);
    if (contact.deliveryOptions?.length) contactLines.push(`🚚 ${contact.deliveryOptions.join(", ")}`);
    if (contact.vcardUrl) contactLines.push(`🪪 [Legg til i kontakter](${absoluteUrl(contact.vcardUrl)})`);
    if (contactLines.length) {
      lines.push("");
      lines.push(...contactLines.map(l => `   ${l}`));
    }
  }

  return lines.join("\n");
}

function formatOpeningHours(hours) {
  if (!hours?.length) return null;
  const dayNames = { mon: "Man", tue: "Tir", wed: "Ons", thu: "Tor", fri: "Fre", sat: "Lør", sun: "Søn" };
  return hours.map(h => `${dayNames[h.day] || h.day} ${h.open}–${h.close}`).join(", ");
}

// ── MCP Server ───────────────────────────────────────────────

const server = new McpServer({
  name: "lokal",
  version: "0.2.0",
});

// Tool 1: Natural language search
server.tool(
  "lokal_search",
  "Search for local food producers in Norway using natural language. Supports Norwegian and English. Returns ranked producers with contact info and a vCard link so the user can add them to their contacts. Examples: 'fresh vegetables near Grünerløkka', 'organic honey Oslo', 'ost Trondheim'.",
  {
    query: z.string().describe("Natural language search query (Norwegian or English)"),
    limit: z.number().min(1).max(50).default(10).describe("Max results"),
  },
  async ({ query, limit }) => {
    const params = new URLSearchParams({ q: query, limit: String(limit || 10) });
    const data = await fetchJSON(`${BASE_URL}/api/marketplace/search?${params}`);

    if (!data.results?.length) {
      return { content: [{ type: "text", text: `Ingen resultater for "${query}". Prøv et bredere søk.` }] };
    }

    const header = `🥬 **Lokal mat-søk: "${query}"** — fant ${data.count} produsenter:\n`;
    const results = data.results.map((r, i) => {
      const dist = r.distanceKm ? ` — ${r.distanceKm.toFixed(1)} km unna` : "";
      return formatAgent(r.agent, i + 1, r.contact) + dist;
    }).join("\n\n");

    return { content: [{ type: "text", text: header + "\n" + results }] };
  }
);

// Tool 2: Structured discovery
server.tool(
  "lokal_discover",
  "Structured search in the Lokal food producer registry. Filter by food categories, tags, and geographic distance. Returns ranked producers with contact info and vCard links.",
  {
    categories: z.array(z.string()).optional().describe("Categories: vegetables, fruit, berries, dairy, eggs, meat, fish, bread, honey, herbs"),
    tags: z.array(z.string()).optional().describe("Tags: organic, seasonal, budget, local, fresh"),
    lat: z.number().optional().describe("Latitude for distance filtering"),
    lng: z.number().optional().describe("Longitude for distance filtering"),
    maxDistanceKm: z.number().optional().describe("Max distance in km"),
    limit: z.number().min(1).max(50).default(10).describe("Max results"),
  },
  async ({ categories, tags, lat, lng, maxDistanceKm, limit }) => {
    const body = { categories, tags, lat, lng, maxDistanceKm, limit: limit || 10, role: "producer" };
    const data = await postJSON(`${BASE_URL}/api/marketplace/discover`, body);

    if (!data.results?.length) {
      return { content: [{ type: "text", text: "Ingen produsenter funnet med disse filtrene." }] };
    }

    const header = `🔍 **Strukturert søk** — ${data.count} resultater:\n`;
    const results = data.results.map((r, i) => {
      const dist = r.distanceKm ? ` (${r.distanceKm.toFixed(1)} km)` : "";
      return formatAgent(r.agent, i + 1, r.contact) + dist;
    }).join("\n\n");

    return { content: [{ type: "text", text: header + "\n" + results }] };
  }
);

// Tool 3: Producer details — structured markdown, not raw JSON
server.tool(
  "lokal_info",
  "Get detailed information about a specific Lokal producer — address, products, opening hours, certifications, and a vCard link the user can add to their contacts.",
  {
    agentId: z.string().describe("The producer's agent ID (UUID)"),
  },
  async ({ agentId }) => {
    const data = await fetchJSON(`${BASE_URL}/api/marketplace/agents/${agentId}/info`);
    const info = data.data || data;
    const { agent, knowledge: k = {}, meta = {} } = info;

    const sections = [`# ${agent.name}`];
    if (agent.city) sections.push(`📍 ${agent.city}${agent.trustScore ? `  ·  Trust ${Math.round(agent.trustScore * 100)}%` : ""}${agent.isVerified ? "  ·  ✔ Verifisert" : ""}${agent.isClaimed ? "  ·  🪪 Eid av produsent" : ""}`);

    if (k.about) sections.push(`\n${k.about}`);

    // Contact
    const contact = [];
    if (k.address) contact.push(`📍 ${k.address}${k.postalCode ? `, ${k.postalCode}` : ""}`);
    if (k.phone) contact.push(`📞 [${k.phone}](tel:${k.phone.replace(/\s+/g, "")})`);
    if (k.email) contact.push(`✉️ [${k.email}](mailto:${k.email})`);
    if (k.website) contact.push(`🌐 ${k.website}`);
    if (contact.length) sections.push(`\n## Kontakt\n${contact.join("\n")}`);

    // vCard link — always present
    sections.push(`\n🪪 [Legg til i kontakter (vCard)](${BASE_URL}/api/marketplace/agents/${agent.id}/vcard)`);

    // Opening hours
    const hours = formatOpeningHours(k.openingHours);
    if (hours) sections.push(`\n## Åpningstider\n${hours}`);

    // Products
    if (k.products?.length) {
      const productLines = k.products.map(p => {
        const seasonal = p.seasonal && p.months?.length ? ` _(sesong: mnd ${p.months.join(", ")})_` : "";
        return `- ${p.name}${p.category ? ` — ${p.category}` : ""}${seasonal}`;
      });
      sections.push(`\n## Produkter\n${productLines.join("\n")}`);
    }

    // Specialties / certifications
    if (k.specialties?.length) sections.push(`\n## Spesialiteter\n${k.specialties.map(s => `- ${s}`).join("\n")}`);
    if (k.certifications?.length) sections.push(`\n## Sertifiseringer\n${k.certifications.map(c => `- ${c}`).join("\n")}`);

    // Payment & delivery
    if (k.paymentMethods?.length) sections.push(`\n💳 **Betaling:** ${k.paymentMethods.join(", ")}`);
    if (k.deliveryOptions?.length) sections.push(`🚚 **Levering:** ${k.deliveryOptions.join(", ")}`);

    // Disclaimer / data source
    if (meta.disclaimer) {
      const src = meta.autoSources?.length ? ` (kilder: ${meta.autoSources.join(", ")})` : "";
      sections.push(`\n---\n_${meta.disclaimer}${src}_`);
    }

    return { content: [{ type: "text", text: sections.join("\n") }] };
  }
);

// Tool 4: Platform stats
server.tool(
  "lokal_stats",
  "Get Lokal platform statistics — total agents, cities covered, interactions.",
  {},
  async () => {
    const data = await fetchJSON(`${BASE_URL}/api/stats`);
    const s = data.data || data;
    const text = [
      "📊 **Lokal — Plattformstatistikk**",
      `Totalt agenter: ${s.totalAgents || s.registry?.totalAgents || "?"}`,
      `Byer: ${s.totalCities || s.registry?.cities || "?"}`,
      `Interaksjoner: ${s.totalInteractions || "?"}`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ── Start ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
