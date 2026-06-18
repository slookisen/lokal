#!/usr/bin/env node

/**
 * opplevagent-mcp — MCP stdio server for opplevagent.no
 *
 * Find Norwegian experiences and activities from Claude Desktop, ChatGPT,
 * Cursor, or any MCP-compatible AI assistant.
 *
 * Install / run:
 *   npx opplevagent-mcp
 *
 * Or add to Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "opplevagent": {
 *         "command": "npx",
 *         "args": ["opplevagent-mcp"]
 *       }
 *     }
 *   }
 *
 * Environment:
 *   OPPLEVAGENT_URL  Override API base URL (default: https://opplevagent.no)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.OPPLEVAGENT_URL || "https://opplevagent.no").replace(/\/$/, "");
const USER_AGENT = "opplevagent-mcp/0.1.0";

// ── Helpers ───────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// ── MCP Server ────────────────────────────────────────────────

const server = new McpServer({
  name: "opplevagent",
  version: "0.1.0",
});

// Tool 1: discover_experiences
server.registerTool(
  "discover_experiences",
  {
    title: "Discover Norwegian experiences",
    description:
      "Search the opplevagent.no curated marketplace of Norwegian experiences and activities. " +
      "Filtrer på fylke (county), kategori, vær, sesong, innendørs/utendørs, gruppestørrelse, " +
      "pris og varighet. / Filter by county, category, weather, season, indoor/outdoor, group size, " +
      "price, and duration. " +
      "Returns title, category, location (fylke/kommune), description, and booking URL if available. " +
      "Only verified experiences from active providers (Brreg-checked) are returned. " +
      "Examples: 'hva kan vi finne på i Troms om vinteren?', 'outdoor activities in Oslo for 4 people'.",
    inputSchema: {
      fylke: z.string().optional().describe(
        "Norwegian county (fylke). Examples: 'Oslo', 'Vestland', 'Troms', 'Rogaland'"
      ),
      kommune: z.string().optional().describe(
        "Norwegian municipality (kommune). Examples: 'Tromsø', 'Bergen', 'Stavanger'"
      ),
      category: z.string().optional().describe(
        "Experience category slug. Examples: 'natur_friluft', 'dyreliv_safari', 'mat_drikke', 'vinter'"
      ),
      weather: z.enum(["rain", "snow", "clear", "any"]).optional().describe(
        "Weather suitability filter. 'rain'/'snow' prefers indoor + weather-independent experiences. Examples: 'rain', 'clear'"
      ),
      season: z.string().optional().describe(
        "Season filter. Examples: 'summer', 'winter', 'spring', 'autumn'"
      ),
      indoor_outdoor: z.enum(["indoor", "outdoor", "both"]).optional().describe(
        "Indoor/outdoor preference. Examples: 'indoor', 'outdoor', 'both'"
      ),
      group_size: z.number().int().positive().optional().describe(
        "Number of people in the group. Used to filter experiences by min/max group capacity. Example: 4"
      ),
      age: z.number().int().nonnegative().optional().describe(
        "Age of the youngest participant. Filters out experiences with a minimum-age requirement above this. Example: 8"
      ),
      max_price: z.number().int().positive().optional().describe(
        "Maximum price per person in Norwegian kroner (NOK). Example: 500"
      ),
      duration_max: z.number().int().positive().optional().describe(
        "Maximum duration in minutes. Example: 120 (2 hours)"
      ),
      language: z.string().optional().describe(
        "Required language for the experience. Examples: 'no', 'en'"
      ),
      limit: z.number().min(1).max(50).default(20).describe(
        "Max results (default 20, max 50)"
      ),
    },
    annotations: {
      title: "Discover Norwegian experiences",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ fylke, kommune, category, weather, season, indoor_outdoor, group_size, age, max_price, duration_max, language, limit }) => {
    const params = new URLSearchParams();
    if (fylke) params.append("fylke", fylke);
    if (kommune) params.append("kommune", kommune);
    if (category) params.append("category", category);
    if (weather) params.append("weather", weather);
    if (season) params.append("season", season);
    if (indoor_outdoor) params.append("indoor_outdoor", indoor_outdoor);
    if (typeof group_size === "number") params.append("group_size", String(group_size));
    if (typeof age === "number") params.append("age", String(age));
    if (typeof max_price === "number") params.append("max_price", String(max_price));
    if (typeof duration_max === "number") params.append("duration_max", String(duration_max));
    if (language) params.append("language", language);
    params.append("limit", String(limit ?? 20));

    const data = await fetchJSON(`${BASE_URL}/api/opplevelser/discover?${params}`);

    if (!data || (Array.isArray(data.results) && data.results.length === 0)) {
      return {
        content: [{ type: "text", text: `Ingen opplevelser funnet med de angitte filtrene. / No experiences found matching the given filters.` }],
      };
    }

    const results = Array.isArray(data.results) ? data.results : [];
    const summary = `Fant ${data.count ?? results.length} opplevelse(r). / Found ${data.count ?? results.length} experience(s).`;

    const formatted = results.map((e, i) => {
      const parts = [`**${i + 1}. ${e.title}**`];
      if (e.category) parts.push(`   🏷 ${e.category}`);
      const location = [e.kommune, e.fylke].filter(Boolean).join(", ");
      if (location) parts.push(`   📍 ${location}`);
      if (e.indoor_outdoor) parts.push(`   🏠 ${e.indoor_outdoor}`);
      if (e.price_from != null) parts.push(`   💰 fra ${e.price_from} kr`);
      else if (e.price_band) parts.push(`   💰 ${e.price_band}`);
      if (e.duration_min != null) parts.push(`   ⏱ ${e.duration_min} min`);
      if (e.booking_url) parts.push(`   🔗 ${e.booking_url}`);
      parts.push(`   🆔 id: ${e.id}`);
      return parts.filter(Boolean).join("\n");
    });

    const header = `🎯 **Opplevagent.no** — ${summary}\n`;
    return { content: [{ type: "text", text: header + "\n" + formatted.join("\n\n") }] };
  }
);

// Tool 2: list_experience_categories
server.registerTool(
  "list_experience_categories",
  {
    title: "List Norwegian experience categories",
    description:
      "List all experience categories available on opplevagent.no, " +
      "along with the number of verified experiences in each category. " +
      "Henter alle kategorier med antall verifiserte opplevelser. " +
      "Use this to understand what kinds of experiences are available before " +
      "calling discover_experiences with a specific category filter. " +
      "Example question: 'hvilke typer opplevelser finnes i Norge?', 'what categories are available?'.",
    inputSchema: {},
    annotations: {
      title: "List experience categories",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const data = await fetchJSON(`${BASE_URL}/api/opplevelser/categories`);

    const categories = Array.isArray(data.categories) ? data.categories : [];

    if (categories.length === 0) {
      return {
        content: [{ type: "text", text: "Ingen kategorier tilgjengelig for øyeblikket. / No category data available at this time." }],
      };
    }

    const header = `📂 **Opplevagent.no kategorier** — ${categories.length} kategorier:\n`;
    const lines = categories.map((c, i) => {
      const count = c.count != null ? ` (${c.count} opplevelser)` : "";
      return `**${i + 1}. ${c.category ?? c.name ?? c.slug ?? c}**${count}`;
    });

    return { content: [{ type: "text", text: header + "\n" + lines.join("\n") }] };
  }
);

// Tool 3: get_experience
server.registerTool(
  "get_experience",
  {
    title: "Get full details for a Norwegian experience",
    description:
      "Fetch complete details for a single experience from opplevagent.no by its UUID. " +
      "Henter fullstendig informasjon om en opplevelse via UUID. " +
      "Returns title, full description, category, location (fylke/kommune/meeting point), " +
      "indoor/outdoor, season, weather suitability, group size limits, age suitability, " +
      "price, duration, languages, booking URL, and booking type. " +
      "Obtain the UUID from discover_experiences results. " +
      "Example: id 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'.",
    inputSchema: {
      id: z.string().uuid().describe(
        "UUID of the experience to fetch. Example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'"
      ),
    },
    annotations: {
      title: "Get experience details",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ id }) => {
    const data = await fetchJSON(`${BASE_URL}/api/opplevelser/${encodeURIComponent(id)}`);

    const experience = data.experience ?? data;

    if (!experience || !experience.id) {
      return {
        content: [{ type: "text", text: `Ingen opplevelse funnet med id ${id}. / No experience found with id ${id}.` }],
        isError: true,
      };
    }

    const sections = [`# ${experience.title}`];

    const location = [experience.meeting_point, experience.kommune, experience.fylke].filter(Boolean).join(", ");
    if (location) sections.push(`📍 ${location}`);

    if (experience.category) sections.push(`\n🏷 Kategori: ${experience.category}${experience.subcategory ? ` / ${experience.subcategory}` : ""}`);
    if (experience.indoor_outdoor) sections.push(`🏠 Innendørs/utendørs: ${experience.indoor_outdoor}`);
    if (Array.isArray(experience.season) && experience.season.length) sections.push(`🗓 Sesong: ${experience.season.join(", ")}`);
    if (experience.weather_dependent != null) sections.push(`☁️ Væravhengig: ${experience.weather_dependent ? "ja" : "nei"}`);

    const duration = [
      experience.duration_min != null ? `min ${experience.duration_min} min` : null,
      experience.duration_max != null ? `maks ${experience.duration_max} min` : null,
    ].filter(Boolean).join(" – ");
    if (duration) sections.push(`\n⏱ Varighet: ${duration}`);

    const group = [
      experience.group_min != null ? `min ${experience.group_min}` : null,
      experience.group_max != null ? `maks ${experience.group_max}` : null,
    ].filter(Boolean).join(" – ");
    if (group) sections.push(`👥 Gruppestørrelse: ${group}`);

    if (experience.min_age != null) sections.push(`🔞 Minimumsalder: ${experience.min_age} år`);
    if (experience.age_suitability) sections.push(`👶 Aldersgruppe: ${experience.age_suitability}`);

    if (experience.price_from != null) sections.push(`\n💰 Pris fra: ${experience.price_from} kr${experience.price_unit ? ` per ${experience.price_unit}` : ""}`);
    else if (experience.price_band) sections.push(`\n💰 Priskategori: ${experience.price_band}`);

    if (Array.isArray(experience.languages) && experience.languages.length) sections.push(`🌐 Språk: ${experience.languages.join(", ")}`);
    if (Array.isArray(experience.accessibility) && experience.accessibility.length) sections.push(`♿ Tilgjengelighet: ${experience.accessibility.join(", ")}`);

    if (experience.description) sections.push(`\n${experience.description}`);

    if (experience.booking_url) sections.push(`\n📅 Bestill: ${experience.booking_url}${experience.booking_type ? ` (${experience.booking_type})` : ""}`);

    if (experience.verification_status) sections.push(`\n✔ Status: ${experience.verification_status}`);

    return { content: [{ type: "text", text: sections.join("\n") }] };
  }
);

// ── Start ──────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
