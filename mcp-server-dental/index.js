#!/usr/bin/env node

/**
 * finn-tannlege-mcp — MCP stdio server for finn-tannlege.com
 *
 * Find Norwegian dental clinics from Claude Desktop, ChatGPT, Cursor, or any
 * MCP-compatible AI assistant.
 *
 * Install / run:
 *   npx finn-tannlege-mcp
 *
 * Or add to Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "finn-tannlege": {
 *         "command": "npx",
 *         "args": ["finn-tannlege-mcp"]
 *       }
 *     }
 *   }
 *
 * Environment:
 *   FINN_TANNLEGE_URL  Override API base URL (default: https://finn-tannlege.com)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.FINN_TANNLEGE_URL || "https://finn-tannlege.com").replace(/\/$/, "");
const USER_AGENT = "finn-tannlege-mcp/0.1.0";

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
  name: "finn-tannlege",
  version: "0.1.0",
});

// Tool 1: tannlege_search
server.registerTool(
  "tannlege_search",
  {
    title: "Search Norwegian dental clinics",
    description:
      "Search the finn-tannlege.com directory of ~6,900 Norwegian dental clinics. " +
      "Supports free-text search, county (fylke) filter, specialty filter, " +
      "Helfo direct-billing filter, and emergency-duty (akuttvakt) filter. " +
      "Returns clinic name, address, contact info, Helfo status, and profile URL. " +
      "Example: 'finn kjeveortoped i Bergen med Helfo-avtale'.",
    inputSchema: {
      query: z.string().optional().describe(
        "Free-text search (name or city). Examples: 'Oslo tannklinikk', 'kjeveortoped Bergen'"
      ),
      fylke: z.string().optional().describe(
        "Norwegian county. Examples: 'Oslo', 'Vestland', 'Rogaland'"
      ),
      spesialitet: z.string().optional().describe(
        "Specialty slug. Examples: 'kjeveortopedi', 'endodonti', 'periodonti'"
      ),
      helfo: z.boolean().optional().describe(
        "If true, only return clinics with Helfo direct-billing agreement"
      ),
      akutt: z.boolean().optional().describe(
        "If true, only return clinics with emergency-duty (akuttvakt)"
      ),
      limit: z.number().min(1).max(25).default(10).describe(
        "Max results (default 10, max 25)"
      ),
    },
    annotations: {
      title: "Search Norwegian dental clinics",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, fylke, spesialitet, helfo, akutt, limit }) => {
    const params = new URLSearchParams();
    if (query) params.append("q", query);
    if (fylke) params.append("fylke", fylke);
    if (spesialitet) params.append("specialty", spesialitet);
    if (helfo === true) params.append("helfo", "true");
    if (akutt === true) params.append("acute_vakt", "1");
    params.append("limit", String(limit ?? 10));

    const data = await fetchJSON(`${BASE_URL}/api/tannlege/agents?${params}`);

    if (!Array.isArray(data) || data.length === 0) {
      return {
        content: [{ type: "text", text: `Ingen tannlegeklinikker funnet${query ? ` for "${query}"` : ""}.` }],
      };
    }

    const klinikker = data.map((a, i) => {
      const badges = [];
      if (a.helfo_agreement === "true") badges.push("Helfo-avtale");
      if (a.acute_vakt === 1) badges.push("Akuttvakt");
      if (a.verification_status === "verified") badges.push("Verifisert");
      const profil = `${BASE_URL}/klinikk/${a.slug || a.id}`;
      return [
        `**${i + 1}. ${a.navn}**`,
        a.poststed ? `   📍 ${a.poststed}${a.fylke ? `, ${a.fylke}` : ""}` : "",
        a.telefon ? `   📞 ${a.telefon}` : "",
        a.hjemmeside ? `   🌐 ${a.hjemmeside}` : "",
        badges.length ? `   🏷 ${badges.join(" · ")}` : "",
        `   🔗 ${profil}`,
      ].filter(Boolean).join("\n");
    });

    const header = `🦷 **Finn tannlege** — ${data.length} klinikker funnet:\n`;
    return { content: [{ type: "text", text: header + "\n" + klinikker.join("\n\n") }] };
  }
);

// Tool 2: tannlege_info
server.registerTool(
  "tannlege_info",
  {
    title: "Get full details for a dental clinic",
    description:
      "Fetch complete profile for a single Norwegian dental clinic by organisation number (org_nr) " +
      "or internal UUID. Returns name, address, phone, website, Helfo status, emergency duty, " +
      "specialities, chain affiliation, specialists list, treatments, opening hours, " +
      "payment options, and profile URL. " +
      "Example: org_nr '912345678'.",
    inputSchema: {
      org_nr: z.string().regex(/^\d{9}$/).optional().describe(
        "9-digit Norwegian organisation number. Example: '912345678'"
      ),
      id: z.string().optional().describe(
        "Clinic UUID (alternative to org_nr)"
      ),
    },
    annotations: {
      title: "Get dental clinic details",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ org_nr, id }) => {
    if (!org_nr && !id) {
      return { content: [{ type: "text", text: "Feil: oppgi enten org_nr (9 siffer) eller id." }] };
    }

    // Use the :id route directly — it accepts both UUID and 9-digit org_nr
    // (GET /api/tannlege/agents/:id has a /^\d{9}$/ branch → getDentalAgentByOrgnr).
    // This avoids a two-step free-text search that could match the wrong clinic
    // when org_nr appears in another field (e.g. om_oss or name).
    const lookupKey = org_nr ?? id;

    const agent = await fetchJSON(`${BASE_URL}/api/tannlege/agents/${lookupKey}`);
    // specialists endpoint requires UUID — use agent.id from the resolved agent
    const specialists = await fetchJSON(`${BASE_URL}/api/tannlege/agents/${agent.id}/specialists`).catch(() => []);

    const sections = [`# ${agent.navn}`];
    if (agent.poststed) sections.push(`📍 ${agent.adresse || ""}${agent.adresse ? ", " : ""}${agent.postnummer || ""} ${agent.poststed}${agent.fylke ? `, ${agent.fylke}` : ""}`.trim());
    if (agent.telefon) sections.push(`📞 ${agent.telefon}`);
    if (agent.hjemmeside) sections.push(`🌐 ${agent.hjemmeside}`);
    if (agent.epost) sections.push(`✉️ ${agent.epost}`);

    const badges = [];
    if (agent.helfo_agreement === "true") badges.push("✅ Helfo-direkteoppgjørsavtale");
    if (agent.acute_vakt === 1) badges.push("🚨 Akuttvakt");
    if (agent.verification_status === "verified") badges.push("✔ Verifisert");
    if (badges.length) sections.push("\n" + badges.join("  ·  "));

    if (agent.chain_brand) sections.push(`\n🏢 Kjede: ${agent.chain_brand}`);
    if (agent.available_specialties?.length) sections.push(`\n🔬 Spesialiteter: ${agent.available_specialties.join(", ")}`);
    if (agent.treatments?.length) sections.push(`\n💊 Behandlinger: ${agent.treatments.slice(0, 10).join(", ")}${agent.treatments.length > 10 ? " ..." : ""}`);
    if (agent.payment_options?.length) sections.push(`\n💳 Betalingsalternativ: ${agent.payment_options.join(", ")}`);
    if (agent.online_booking_url) sections.push(`\n📅 Online booking: ${agent.online_booking_url}`);
    if (agent.om_oss) sections.push(`\n${agent.om_oss}`);

    if (Array.isArray(specialists) && specialists.length) {
      sections.push(`\n## Spesialister (${specialists.length})`);
      for (const s of specialists) {
        sections.push(`- ${s.navn}${s.specialty_used_here ? ` — ${s.specialty_used_here}` : ""}`);
      }
    }

    sections.push(`\n🔗 ${BASE_URL}/klinikk/${agent.slug || agent.id}`);

    return { content: [{ type: "text", text: sections.join("\n") }] };
  }
);

// Tool 3: tannlege_stats
server.registerTool(
  "tannlege_stats",
  {
    title: "Norwegian dental market statistics",
    description:
      "Fetch aggregated statistics for the Norwegian dental market from finn-tannlege.com. " +
      "Returns total clinic count, per-county breakdown (per fylke), Helfo count, " +
      "chain-member count, emergency-duty (akuttvakt) count, and specialist-clinic count. " +
      "Example question: 'how many dental clinics are there in Norway?'.",
    inputSchema: {},
    annotations: {
      title: "Norwegian dental market statistics",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const stats = await fetchJSON(`${BASE_URL}/api/tannlege/stats`);
    const lines = [
      "📊 **Finn-tannlege.com — Statistikk**",
      `Totalt klinikker:        ${stats.total ?? "?"}`,
      `Med Helfo-avtale:        ${stats.helfo_count ?? "?"}`,
      `Akuttvakt:               ${stats.acute_count ?? "?"}`,
      `Kjedeklinikker:          ${stats.chain_count ?? "?"}`,
      `Spesialistklinikker:     ${stats.specialist_clinic_count ?? "?"}`,
    ];
    if (Array.isArray(stats.per_fylke) && stats.per_fylke.length) {
      lines.push("\nPer fylke:");
      for (const row of stats.per_fylke) {
        lines.push(`  ${row.fylke}: ${row.count}`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// Tool 4: tannlege_akutt
server.registerTool(
  "tannlege_akutt",
  {
    title: "Find emergency-duty dental clinics in Norway",
    description:
      "Find Norwegian dental clinics that offer emergency-duty (akuttvakt) — i.e. treatment " +
      "outside normal working hours. Optionally filter by county (fylke). " +
      "Also returns advice about the municipal dental emergency service (kommunal tannlegevakt). " +
      "Example: 'finn akutt tannlege i Oslo'.",
    inputSchema: {
      fylke: z.string().optional().describe(
        "Limit to clinics in this county. Examples: 'Oslo', 'Vestland'"
      ),
    },
    annotations: {
      title: "Find emergency-duty dental clinics",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ fylke }) => {
    const params = new URLSearchParams({ acute_vakt: "1", limit: "25" });
    if (fylke) params.append("fylke", fylke);

    const data = await fetchJSON(`${BASE_URL}/api/tannlege/agents?${params}`);

    const advice =
      "Mange kommuner har kommunal tannlegevakt på kvelder og helger — " +
      "ring klinikken direkte for å bekrefte åpningstider og tilgjengelighet.";

    if (!Array.isArray(data) || data.length === 0) {
      return {
        content: [{ type: "text", text: `Ingen akuttvakt-klinikker funnet${fylke ? ` i ${fylke}` : ""}.\n\n${advice}` }],
      };
    }

    const klinikker = data.map((a, i) => {
      return [
        `**${i + 1}. ${a.navn}**`,
        a.poststed ? `   📍 ${a.poststed}${a.fylke ? `, ${a.fylke}` : ""}` : "",
        a.telefon ? `   📞 ${a.telefon}` : "",
      ].filter(Boolean).join("\n");
    });

    const header = `🚨 **Akuttvakt-tannleger** — ${data.length} klinikker:\n`;
    return {
      content: [{ type: "text", text: header + "\n" + klinikker.join("\n\n") + "\n\n---\n" + advice }],
    };
  }
);

// Tool 5: tannlege_kjeder
server.registerTool(
  "tannlege_kjeder",
  {
    title: "List Norwegian dental chains",
    description:
      "List all Norwegian dental chains (kjeder) registered on finn-tannlege.com. " +
      "Examples of chains: 'Tannhelse Øst', 'Colosseum Tannlege', 'Nordic Dental'. " +
      "Example question: 'hvilke tannlegekjeder finnes i Norge?'.",
    inputSchema: {},
    annotations: {
      title: "List Norwegian dental chains",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const data = await fetchJSON(`${BASE_URL}/api/tannlege/chains`);

    if (!Array.isArray(data) || data.length === 0) {
      return { content: [{ type: "text", text: "Ingen tannlegekjeder registrert." }] };
    }

    const header = `🏢 **Tannlegekjeder i Norge** — ${data.length} kjeder:\n`;
    const lines = data.map((c, i) => {
      const count = c.count != null ? ` (${c.count} lokasjoner)` : "";
      const site = c.website ? `\n   🌐 ${c.website}` : "";
      return `**${i + 1}. ${c.chain_brand}**${count}${site}`;
    });

    return { content: [{ type: "text", text: header + "\n" + lines.join("\n\n") }] };
  }
);

// ── Start ──────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
