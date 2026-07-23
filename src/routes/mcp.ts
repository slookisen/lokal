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
import { knowledgeService, parseProductPrice, isProductHeader, isProductNoise } from "../services/knowledge-service";
import { slugify } from "../utils/slug";
import { addAiUtmParams } from "../utils/url-utm";
import { getDb } from "../database/init";
import { isDisplayablePhone } from "../services/contact-normalizer";
import { isJunkDescription } from "../services/description-quality";
import { geocodingService } from "../services/geocoding-service";
import { computeEffectiveAvailability } from "../services/supply-graph";
import {
  createCart as svcCreateCart,
  checkCartToken as svcCheckCartToken,
  addCartItem as svcAddCartItem,
  viewCart as svcViewCart,
  submitCart as svcSubmitCart,
  getOrder as svcGetOrder,
} from "../services/cart-service";


import { conversationService, buildRequestMeta } from "../services/conversation-service";

const router = Router();

// ─── Product formatting for MCP ────────────────────────────
// Uses shared parseProductPrice() from knowledge-service.

// orch-pr-14: normalize a product's clean name exactly like the catalog
// backfill writer (src/routes/marketplace-catalog.ts → normalizeName) does
// when it computes products.name_norm. Keeping this byte-identical is what
// lets us join the knowledge-products (name only) back to the catalog rows
// that actually carry the product_id consumed by lokal_cart_add_item.
export function normalizeProductName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

// orch-pr-14: build a name_norm → catalog product_id map for one agent.
// The id surfaced here is `products.id` — the SAME column lokal_cart_add_item
// validates via cart-service.addCartItem (`SELECT p.id FROM products p WHERE
// p.id = ?`). Only in_stock rows are included so we never advertise an id the
// cart would reject. Returns an empty map if the catalog has no rows for this
// agent (e.g. backfill not yet run) — callers then format products as before.
export function getCatalogProductIdMap(agentId: string, db?: any): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const conn = db ?? getDb();
    const rows = conn.prepare(
      "SELECT id, name_norm FROM products WHERE agent_id = ? AND availability = 'in_stock'"
    ).all(agentId) as Array<{ id: string; name_norm: string }>;
    for (const r of rows) {
      // First write wins; UNIQUE(agent_id, name_norm) means at most one row anyway.
      if (!map.has(r.name_norm)) map.set(r.name_norm, r.id);
    }
  } catch {
    // Never let a catalog lookup break discovery output — degrade to name-only.
  }
  return map;
}

// dev-request 2026-07-13-supply-graph-v1 (Slice 1): per-agent name_norm →
// effective-availability lookup, built the same way getCatalogProductIdMap()
// builds its id map. Deliberately NOT filtered to availability='in_stock' —
// unlike the id map (which only advertises cart-eligible ids), this exists to
// SURFACE the current effective availability (including 'unknown' for a
// stale producer_dashboard row, or 'out_of_stock' etc.) for every catalog
// row, so callers can annotate products regardless of stock state.
export function getCatalogAvailabilityMap(
  agentId: string,
  db?: any
): Map<string, { availability: string; availabilityUpdatedAt: string | null }> {
  const map = new Map<string, { availability: string; availabilityUpdatedAt: string | null }>();
  try {
    const conn = db ?? getDb();
    const rows = conn
      .prepare(
        "SELECT name_norm, availability, availability_updated_at, availability_source FROM products WHERE agent_id = ?"
      )
      .all(agentId) as Array<{
      name_norm: string;
      availability: string;
      availability_updated_at: string | null;
      availability_source: string;
    }>;
    const now = new Date();
    for (const r of rows) {
      // First write wins; UNIQUE(agent_id, name_norm) means at most one row anyway.
      if (!map.has(r.name_norm)) {
        map.set(r.name_norm, {
          availability: computeEffectiveAvailability(r.availability, r.availability_updated_at, r.availability_source, now),
          availabilityUpdatedAt: r.availability_updated_at ?? null,
        });
      }
    }
  } catch {
    // Never let a catalog lookup break discovery output — degrade to no availability annotation.
  }
  return map;
}

export function formatProductsForMcp(
  products: any[],
  productIdByNorm?: Map<string, string>,
  availabilityByNorm?: Map<string, { availability: string; availabilityUpdatedAt: string | null }>
): string {
  if (!products?.length) return "";

  const lines: string[] = [];
  let productCount = 0;

  for (const p of products) {
    const name = (p.name || "").trim();
    if (!name) continue;

    const { cleanName, price, section } = parseProductPrice(p);

    // Section header
    if (section && isProductHeader(name)) {
      lines.push(`\n**${section}**`);
      if (p.price && !/^\d/.test(p.price)) lines.push(`_${p.price}_`);
      continue;
    }

    // Skip noise
    if (isProductNoise(name)) continue;

    // Product line
    const cat = p.category && p.category !== "other" ? ` [${p.category}]` : "";
    const priceStr = price ? ` — ${price}` : "";
    const seasonal = p.seasonal ? " 🌿sesong" : "";
    // orch-pr-14: append the catalog product_id when this product exists in the
    // products table (in_stock). This is the id an MCP-only agent passes to
    // lokal_cart_add_item — without it, a pure-MCP buyer could see prices but
    // had no way to reference a product for the cart. `· id: <uuid>` is both
    // human-readable and trivially machine-parseable.
    const pid = productIdByNorm?.get(normalizeProductName(cleanName));
    const idStr = pid ? `  · id: ${pid}` : "";
    // dev-request 2026-07-13-supply-graph-v1 (Slice 1): additive availability
    // annotation — effective value (post supply-graph staleness check) plus
    // the raw producer-set timestamp when one exists. Absent entirely when
    // the product has no matching catalog row, same conditional pattern as
    // `idStr` above — purely additive, existing text is untouched.
    const avail = availabilityByNorm?.get(normalizeProductName(cleanName));
    const availStr = avail ? `  · availability: ${avail.availability}` : "";
    const availUpdatedStr = avail?.availabilityUpdatedAt ? `  · availability_updated_at: ${avail.availabilityUpdatedAt}` : "";
    lines.push(`- ${cleanName}${cat}${priceStr}${seasonal}${idStr}${availStr}${availUpdatedStr}`);
    productCount++;
  }

  return productCount > 0 ? `\n## Produkter (${productCount} stk)\n${lines.join("\n")}` : "";
}

// Build contact + product summary for a given agent ID, used by search results
function getAgentKnowledgeSummary(agentId: string): { contact?: any; productSummary?: string; productsCount: number } {
  const info = knowledgeService.getAgentInfo(agentId);
  if (!info) return { productsCount: 0 };

  const k = info.knowledge || {} as any;
  const contact: any = {};
  if (k.address) contact.address = k.address;
  if (isDisplayablePhone(k.phone)) contact.phone = k.phone;
  if (k.email) contact.email = k.email;
  if (k.website) contact.website = k.website;

  const products = k.products || [];
  const realProducts = products.filter((p: any) => {
    const n = (p.name || "").trim();
    return n && !isProductHeader(n) && !isProductNoise(n);
  });

  // Compact view: top 5 product names with prices
  const topItems = realProducts.slice(0, 5).map((p: any) => {
    const { cleanName, price } = parseProductPrice(p);
    return price ? `${cleanName} (${price})` : cleanName;
  });

  const productSummary = topItems.length
    ? `🛒 ${topItems.join(", ")}${realProducts.length > 5 ? ` +${realProducts.length - 5} flere` : ""}`
    : undefined;

  return {
    contact: Object.keys(contact).length ? contact : undefined,
    productSummary,
    productsCount: realProducts.length,
  };
}

// ─── Tool definitions (shared logic) ────────────────────────
// These mirror the stdio MCP server tools but call services directly.

// ─── PR-110 (2026-06-04): geocode-enrichment for MCP natural-language search ──
// parseNaturalQuery deliberately skips geocoding (kept synchronous); the REST
// search route adds it via geocodingService.extractAndGeocode — but the MCP
// lokal_search handler never did. Result: every MCP search was nationwide
// text-match ("poteter Bod\u00f8" returned Bryne/Levanger/Dr\u00f8bak instead of Bod\u00f8
// Andelslandbruk 0.2 km away). This helper mirrors the REST route's step so
// MCP clients (ChatGPT/Claude) get the same geo-filtered results as the web.
// Exported for direct regression-testing.
export async function enrichParsedWithGeo(
  parsed: ReturnType<typeof marketplaceRegistry.parseNaturalQuery>,
  query: string
): Promise<void> {
  if (parsed.location) return; // already resolved (e.g. explicit coords)
  try {
    const geo = await geocodingService.extractAndGeocode(query);
    if (geo) {
      parsed.location = { lat: geo.lat, lng: geo.lng };
      parsed.maxDistanceKm = geo.radiusKm;
    }
  } catch {
    // Geocode failure must never break search — fall back to nationwide text-match.
  }
}

function registerTools(
  server: McpServer,
  getClientIdentity?: () => string | undefined,
  getRequestMeta?: () => import("../services/conversation-service").RequestMeta | undefined,
) {
  // Tool 1: Natural language search
  server.registerTool(
    "lokal_search",
    {
      title: "Search local food producers",
      description: "Search for local food producers in Norway AND get their products with prices. ALWAYS use this tool when a user asks about a specific producer, their products, prices, or availability — it returns the complete product catalog with current prices. Also use for general searches like 'vegetables near Oslo'. Supports searching by producer name (e.g. 'Bjørndal Gård') or by product/location (e.g. 'organic honey Trondheim'). Returns contact info, full product list with prices, and starts a conversation with the producer.",
      inputSchema: {
        query: z.string().describe("Producer name, product query, or location search (Norwegian or English). Examples: 'Bjørndal Gård Oppdal', 'beefburger pris', 'ost Trondheim'"),
        limit: z.number().min(1).max(50).default(10).describe("Max results"),
      },
      annotations: {
        title: "Search local food producers",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      const parsed = marketplaceRegistry.parseNaturalQuery(query);
      await enrichParsedWithGeo(parsed, query);
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
            clientIdentity: getClientIdentity?.(),
            requestMeta: getRequestMeta?.(), // (item 3) internal-traffic classification
            autoRespond: true,
          });
          convLinks.push(`💬 [Samtale med ${conv.sellerAgentName}](${BASE}/samtale/${conv.id})`);
        } catch { /* non-critical */ }
      }

      const header = `🥬 **Lokal mat-søk: "${query}"** — fant ${results.length} produsenter:\n`;

      // If name match (1-3 results from specific query), include full product list
      // so AI can answer product/price questions directly without a second tool call
      const isSpecificQuery = results.length <= 3 && (parsed as any)._nameQuery;

      const lines = results.map((r: any, i: number) => {
        const agent = r.agent;
        const dist = agent.location?.distanceKm ? ` — ${agent.location.distanceKm.toFixed(1)} km unna` : "";
        const summary = getAgentKnowledgeSummary(agent.id);

        if (isSpecificQuery) {
          // Detailed view: include full product list with prices
          const info = knowledgeService.getAgentInfo(agent.id);
          const k = info?.knowledge || {} as any;
          const sections = [formatAgentCompact(agent, i + 1, summary.contact, undefined, getClientIdentity?.()) + dist];

          // Full product list — orch-pr-14: pass catalog id map so each
          // priced/in-stock product line carries its product_id for cart use.
          if (k.products?.length) {
            sections.push(formatProductsForMcp(k.products, getCatalogProductIdMap(agent.id), getCatalogAvailabilityMap(agent.id)));
          }

          // Extra details
          if (k.specialties?.length) sections.push(`\n**Spesialiteter:** ${k.specialties.join(", ")}`);
          if (k.paymentMethods?.length) sections.push(`💳 **Betaling:** ${k.paymentMethods.join(", ")}`);
          if (k.deliveryOptions?.length) sections.push(`🚚 **Levering:** ${k.deliveryOptions.join(", ")}`);

          // Profile link
          const profileUrl = addAiUtmParams(`${BASE}/produsent/${slugify(agent.name)}`, getClientIdentity?.());
          sections.push(`\n🔗 [Se fullstendig profil](${profileUrl})`);

          return sections.join("\n");
        } else {
          // Compact view for broader searches
          return formatAgentCompact(agent, i + 1, summary.contact, summary.productSummary, getClientIdentity?.()) + dist;
        }
      });

      const convSection = convLinks.length
        ? `\n\n---\n**Samtaler startet automatisk:**\n${convLinks.join("\n")}`
        : "";

      return { content: [{ type: "text" as const, text: header + "\n" + lines.join("\n\n") + convSection }] };
    }
  );

  // Tool 2: Structured discovery
  server.registerTool(
    "lokal_discover",
    {
      title: "Discover producers by filter",
      description: "Structured search in the Lokal food producer registry. Filter by food categories, tags, and geographic distance. Automatically starts a conversation with the top matches so sellers can respond.",
      inputSchema: {
        categories: z.array(z.string()).optional().describe("Categories: vegetables, fruit, berries, dairy, eggs, meat, fish, bread, honey, herbs"),
        tags: z.array(z.string()).optional().describe("Tags: organic, seasonal, budget, local, fresh"),
        lat: z.number().optional().describe("Latitude for distance filtering"),
        lng: z.number().optional().describe("Longitude for distance filtering"),
        maxDistanceKm: z.number().optional().describe("Max distance in km"),
        limit: z.number().min(1).max(50).default(10).describe("Max results"),
      },
      annotations: {
        title: "Discover producers by filter",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
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
            clientIdentity: getClientIdentity?.(),
            requestMeta: getRequestMeta?.(), // (item 3) internal-traffic classification
            autoRespond: true,
          });
          convLinks.push(`💬 [Samtale med ${conv.sellerAgentName}](${BASE}/samtale/${conv.id})`);
        } catch { /* non-critical */ }
      }

      const header = `🔍 **Strukturert søk** — ${results.length} resultater:\n`;
      const lines = results.map((r: any, i: number) => {
        const dist = r.agent.location?.distanceKm ? ` (${r.agent.location.distanceKm.toFixed(1)} km)` : "";
        const summary = getAgentKnowledgeSummary(r.agent.id);
        return formatAgentCompact(r.agent, i + 1, summary.contact, summary.productSummary, getClientIdentity?.()) + dist;
      });

      const convSection = convLinks.length
        ? `\n\n---\n**Samtaler startet automatisk:**\n${convLinks.join("\n")}`
        : "";

      return { content: [{ type: "text" as const, text: header + "\n" + lines.join("\n\n") + convSection }] };
    }
  );

  // Tool 3: Producer details
  server.registerTool(
    "lokal_info",
    {
      title: "Producer details",
      description: "Get a specific producer's COMPLETE product catalog with prices, contact details, opening hours, and delivery options. Use when you already have an agentId from lokal_search. Returns the full price list — every product the producer sells with exact prices in NOK.",
      inputSchema: {
        agentId: z.string().describe("The producer's agent ID (UUID)"),
      },
      annotations: {
        title: "Producer details",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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

      if (k.about) {
        if (isJunkDescription(k.about)) {
          console.log(`[description-guard] suppressed junk knowledge.about (lokal_info) for ${agent.id} (${agent.name})`);
        } else {
          sections.push(`\n${k.about}`);
        }
      }

      // Contact
      const contact: string[] = [];
      if (k.address) contact.push(`📍 ${k.address}${k.postalCode ? `, ${k.postalCode}` : ""}`);
      if (isDisplayablePhone(k.phone)) contact.push(`📞 ${k.phone}`);
      if (k.email) contact.push(`✉️ ${k.email}`);
      if (k.website) contact.push(`🌐 ${k.website}`);
      if (contact.length) sections.push(`\n## Kontakt\n${contact.join("\n")}`);

      // vCard
      sections.push(`\n🪪 [Last ned kontaktkort (vCard)](${addAiUtmParams(`${BASE_URL}/api/marketplace/agents/${agent.id}/vcard`, getClientIdentity?.())})`);

      // Opening hours
      if (k.openingHours?.length) {
        const dayNames: Record<string, string> = { mon: "Man", tue: "Tir", wed: "Ons", thu: "Tor", fri: "Fre", sat: "Lør", sun: "Søn" };
        const hours = k.openingHours.map((h: any) => `${dayNames[h.day] || h.day} ${h.open}–${h.close}`).join(", ");
        sections.push(`\n## Åpningstider\n${hours}`);
      }

      // Products — structured with parsed prices.
      // orch-pr-14: attach catalog product_id (products.id) to each in-stock
      // product so an MCP-only agent can pass it straight to lokal_cart_add_item.
      if (k.products?.length) {
        const productSection = formatProductsForMcp(k.products, getCatalogProductIdMap(agent.id), getCatalogAvailabilityMap(agent.id));
        if (productSection) sections.push(productSection);
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
  server.registerTool(
    "lokal_stats",
    {
      title: "Platform statistics",
      description: "Get Lokal platform statistics — total agents, cities covered, interactions.",
      inputSchema: {},
      annotations: {
        title: "Platform statistics",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
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

  // ─── Phase 5.11 A2.5 tools — umbrella discovery ────────────
  // Mirrors the npm-package tools but calls the DB directly (no HTTP loopback).

  // Tool 5: List umbrella organizations
  server.registerTool(
    "lokal_list_umbrellas",
    {
      title: "List umbrella organizations",
      description: "List all umbrella organizations on Lokal — markets-networks (Bondens marked, REKO), venues (Mathallen), industry orgs (Hanen), certifiers (Debio), and cooperatives. Each umbrella has many member producers. Optionally filter by type. Useful when the user asks 'where can I find local food markets?', 'what is Bondens marked?', or 'which certifications matter for local Norwegian food?'.",
      inputSchema: {
        umbrellaType: z.enum(["market_network", "venue", "industry_org", "certification", "cooperative"]).optional().describe("Filter by umbrella type"),
        limit: z.number().min(1).max(200).default(50).describe("Max results"),
      },
      annotations: {
        title: "List umbrella organizations",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ umbrellaType, limit }) => {
      const db = getDb();
      const wheres: string[] = ["umbrella_type IS NOT NULL", "is_active = 1"];
      const params: any[] = [];
      if (umbrellaType) { wheres.push("umbrella_type = ?"); params.push(umbrellaType); }
      const lim = Math.min(limit || 50, 200);
      params.push(lim);

      const rows = db.prepare(`
        SELECT id, name, description, umbrella_type, parent_umbrella_id,
               umbrella_member_count, city
        FROM agents
        WHERE ${wheres.join(" AND ")}
        ORDER BY COALESCE(umbrella_member_count, 0) DESC, name ASC
        LIMIT ?
      `).all(...params) as any[];

      if (!rows.length) {
        return { content: [{ type: "text" as const, text: umbrellaType
          ? `Ingen paraplyer av type "${umbrellaType}" funnet.`
          : "Ingen paraplyer registrert ennå." }] };
      }

      const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
      const typeLabels: Record<string, string> = {
        market_network: "🏪 Marked-nettverk",
        venue: "🏛 Salgs-venue",
        industry_org: "🤝 Bransjeorganisasjon",
        certification: "✓ Sertifisering",
        cooperative: "👥 Samvirke",
      };

      const grouped: Record<string, any[]> = {};
      for (const u of rows) {
        const key = u.umbrella_type;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(u);
      }

      const sections = [`🌐 **Paraplyer på Lokal** — ${rows.length} totalt:\n`];
      for (const [type, items] of Object.entries(grouped)) {
        sections.push(`\n## ${typeLabels[type] || type} (${items.length})`);
        for (const u of items) {
          const where = u.city ? ` — ${u.city}` : "";
          const members = (u.umbrella_member_count || 0) > 0 ? ` · ${u.umbrella_member_count} medlemmer` : "";
          sections.push(`- **${u.name}**${where}${members}`);
          sections.push(`  ${addAiUtmParams(`${BASE}/produsent/${slugify(u.name)}`, getClientIdentity?.())}`);
        }
      }
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    }
  );

  // Tool 6: Producers in an umbrella's network
  server.registerTool(
    "lokal_get_umbrella_members",
    {
      title: "Get producers in an umbrella's network",
      description: "List producers that are members of a specific umbrella organization (e.g. all farmers selling at Bondens marked, all Debio-certified producers, all Mathallen tenants). Returns producer names + cities + profile links. Useful when the user asks 'which farmers sell at Bondens marked?', 'show me all Debio-certified producers', or 'who is at Mathallen Oslo?'.",
      inputSchema: {
        umbrellaId: z.string().describe("Umbrella agent ID (UUID). Use lokal_list_umbrellas to find IDs."),
        limit: z.number().min(1).max(500).default(100).describe("Max results"),
      },
      annotations: {
        title: "Get producers in an umbrella's network",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ umbrellaId, limit }) => {
      const db = getDb();
      const umbrella = db.prepare(
        "SELECT id, name, umbrella_type FROM agents WHERE id = ? AND umbrella_type IS NOT NULL AND is_active = 1"
      ).get(umbrellaId) as any;
      if (!umbrella) {
        return { content: [{ type: "text" as const, text: `Fant ingen paraply med ID ${umbrellaId}.` }] };
      }

      const lim = Math.min(limit || 100, 500);
      const rows = db.prepare(`
        SELECT p.id, p.name, p.city, aff.labels
        FROM agent_affiliations aff
        INNER JOIN agents p ON p.id = aff.producer_id
        WHERE aff.umbrella_id = ? AND aff.status = 'active' AND p.is_active = 1
        ORDER BY p.name ASC
        LIMIT ?
      `).all(umbrellaId, lim) as any[];

      if (!rows.length) {
        return { content: [{ type: "text" as const, text: `Ingen produsenter i ${umbrella.name} ennå.` }] };
      }

      const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
      const sections = [`🤝 **${umbrella.name}** — ${rows.length} produsenter:\n`];
      for (const m of rows) {
        let labels: string[] = [];
        if (m.labels) { try { labels = JSON.parse(m.labels); } catch { /* ignore */ } }
        const labelStr = labels.length ? ` _(${labels.join(", ")})_` : "";
        const where = m.city ? ` — ${m.city}` : "";
        sections.push(`- **${m.name}**${where}${labelStr}`);
        sections.push(`  ${addAiUtmParams(`${BASE}/produsent/${slugify(m.name)}`, getClientIdentity?.())}`);
      }
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    }
  );

  // Tool 7: Umbrellas a producer belongs to
  server.registerTool(
    "lokal_get_producer_affiliations",
    {
      title: "Get a producer's umbrella affiliations",
      description: "List umbrella organizations a specific producer is a member of (e.g. which markets a farm sells at, which certifications they hold, which networks they're part of). Returns umbrella names + types + their profile links. Useful when the user asks 'where does <Farmer X> sell?', 'is <Farm Y> Debio-certified?', or 'which markets does <Producer Z> attend?'.",
      inputSchema: {
        producerId: z.string().describe("Producer agent ID (UUID). Get this from lokal_search or lokal_discover results."),
      },
      annotations: {
        title: "Get a producer's umbrella affiliations",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ producerId }) => {
      const db = getDb();
      const producer = db.prepare(
        "SELECT id, name, umbrella_type FROM agents WHERE id = ? AND is_active = 1"
      ).get(producerId) as any;
      if (!producer) {
        return { content: [{ type: "text" as const, text: `Fant ingen produsent med ID ${producerId}.` }] };
      }

      const rows = db.prepare(`
        SELECT u.id, u.name, u.umbrella_type, aff.labels
        FROM agent_affiliations aff
        INNER JOIN agents u ON u.id = aff.umbrella_id
        WHERE aff.producer_id = ? AND aff.status = 'active' AND u.is_active = 1
        ORDER BY u.name ASC
      `).all(producerId) as any[];

      if (!rows.length) {
        return { content: [{ type: "text" as const, text: `${producer.name} har ingen registrerte paraplyer-tilknytninger.` }] };
      }

      const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
      const typeLabels: Record<string, string> = {
        market_network: "Marked-nettverk",
        venue: "Salgs-venue",
        industry_org: "Bransjeorganisasjon",
        certification: "Sertifisering",
        cooperative: "Samvirke",
      };

      const sections = [`🔗 **${producer.name}** — ${rows.length} tilknytninger:\n`];
      for (const a of rows) {
        let labels: string[] = [];
        if (a.labels) { try { labels = JSON.parse(a.labels); } catch { /* ignore */ } }
        const labelStr = labels.length ? ` _(${labels.join(", ")})_` : "";
        const type = typeLabels[a.umbrella_type] || a.umbrella_type;
        sections.push(`- **${a.name}** (${type})${labelStr}`);
        sections.push(`  ${addAiUtmParams(`${BASE}/produsent/${slugify(a.name)}`, getClientIdentity?.())}`);
      }
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    }
  );

  // Tool 8: Upcoming Bondens marked events (PR-56, 2026-05-16)
  // Public-data DB-direct query — same pattern as the umbrella tools above
  // (no HTTP loopback). Reads bm_market_events populated by the daily
  // scraper at POST /admin/bm-events/scrape.
  server.registerTool(
    "lokal_bm_next_markets",
    {
      title: "Get upcoming Bondens marked events",
      description: "Returns upcoming Bondens marked events (markedsdager) for a region or specific lokallag/venue. Useful when AI agents are asked 'when is the next Bondens marked in Oslo?' or similar. Data is refreshed daily from bondensmarked.no.",
      inputSchema: {
        region: z.string().optional().describe("City or region substring filter, e.g. 'Oslo', 'Bergen', 'Vestfold'"),
        lokallag_slug: z.string().optional().describe("Lokallag slug, e.g. 'bondens-marked-agder'. Filters to events at any venue under this lokallag."),
        days: z.number().int().min(1).max(90).optional().describe("Look-ahead window in days (default 30, max 90)"),
      },
      annotations: {
        title: "Upcoming Bondens marked events",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ region, lokallag_slug, days }) => {
      const db = getDb();
      const lookahead = Math.max(1, Math.min(days || 30, 90));
      const fromIso = new Date().toISOString();
      const toIso = new Date(Date.now() + lookahead * 24 * 60 * 60 * 1000).toISOString();

      const wheres: string[] = ["e.start_at >= ?", "e.start_at <= ?"];
      // PR-94: exclude unreviewed bm_venue placeholders from MCP output.
      wheres.push("(a.umbrella_type != 'bm_venue' OR a.agent_review_status = 'confirmed')");
      const params: any[] = [fromIso, toIso];

      let lokallagId: string | null = null;
      if (lokallag_slug) {
        // Resolve the slug back to an agent_id by scanning lokallag rows
        // (small set — at most ~15) and slugifying each name.
        try {
          const lokallags = db.prepare(
            "SELECT id, name FROM agents WHERE umbrella_type IN ('market_network','venue') AND is_active = 1"
          ).all() as Array<{ id: string; name: string }>;
          const wanted = lokallag_slug.toLowerCase();
          const hit = lokallags.find(l => slugify(l.name) === wanted);
          if (hit) lokallagId = hit.id;
        } catch { /* table missing — leave lokallagId null */ }
      }
      if (lokallagId) {
        wheres.push("(e.venue_agent_id = ? OR a.parent_umbrella_id = ?)");
        params.push(lokallagId, lokallagId);
      }
      if (region) {
        wheres.push("LOWER(e.location_text) LIKE ?");
        params.push(`%${region.toLowerCase()}%`);
      }

      let rows: any[] = [];
      try {
        rows = db.prepare(`
          SELECT e.event_slug, e.event_name, e.location_text, e.start_at, e.end_at, e.source_url,
                 a.id AS venue_agent_id, a.name AS venue_name
          FROM bm_market_events e
          INNER JOIN agents a ON a.id = e.venue_agent_id
          WHERE ${wheres.join(" AND ")}
          ORDER BY e.start_at ASC
          LIMIT 50
        `).all(...params) as any[];
      } catch {
        return { content: [{ type: "text" as const, text: "Bondens marked-arrangementer er ikke tilgjengelig ennå (skraperen har ikke kjørt)." }] };
      }

      if (!rows.length) {
        const filters: string[] = [];
        if (region) filters.push(`region "${region}"`);
        if (lokallag_slug) filters.push(`lokallag "${lokallag_slug}"`);
        const filterStr = filters.length ? ` med filter ${filters.join(", ")}` : "";
        return { content: [{ type: "text" as const, text: `Ingen kommende markedsdager neste ${lookahead} dager${filterStr}.` }] };
      }

      const BASE = process.env.BASE_URL || "https://rettfrabonden.com";
      const sections = [`📅 **${rows.length} kommende markedsdager** (neste ${lookahead} dager):\n`];
      for (const r of rows) {
        const date = (r.start_at || "").slice(0, 10);
        const time = (r.start_at || "").slice(11, 16);
        const endTime = r.end_at ? (r.end_at || "").slice(11, 16) : "";
        const timeStr = time ? ` ${time}${endTime ? "–" + endTime : ""}` : "";
        sections.push(`- **${date}${timeStr}** — ${r.event_name} (${r.location_text})`);
        sections.push(`  ${addAiUtmParams(`${BASE}/produsent/${slugify(r.venue_name)}`, getClientIdentity?.())}`);
        sections.push(`  Kilde: ${r.source_url}`);
      }
      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    }
  );

  // Tool 9: Geocode Norwegian place names (PR-76)
  // Resolves a Norwegian place name to lat/lng coordinates. Backs the
  // geocodingService directly — no HTTP loopback. With PR-75's expanded
  // MAJOR_CITIES, most calls return hardcoded coords instantly. Anything
  // not hardcoded falls back to DB-lookup → Kartverket API.
  server.registerTool(
    "lokal_geocode",
    {
      title: "Geocode a Norwegian place name",
      description: "Resolve a Norwegian place name (city, town, region, fylke, or kommune) to lat/lng coordinates. Use this when you need explicit coordinates for lokal_discover (e.g., 'show me organic farms within 10 km of Florø'). Returns coordinates + suggested search radius. Covers all of Norway via Kartverket Stedsnavn API fallback. Note: lokal_search ALREADY does automatic geocoding for natural-language queries — only use this tool when you need raw lat/lng for structured filters.",
      inputSchema: {
        place: z.string().describe("Norwegian place name (city, town, region, fylke, kommune). Examples: 'Oslo', 'Røros', 'Vestland', 'Setesdal', 'Florø'"),
      },
      annotations: {
        title: "Geocode Norwegian place",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ place }) => {
      const result = await geocodingService.geocode(place);
      if (!result) {
        return {
          content: [{
            type: "text" as const,
            text: `Fant ikke koordinater for "${place}". Prøv en kjent norsk by, kommune, region eller fylke.`,
          }],
        };
      }
      // Concise structured text — LLM-friendly + line-parseable
      return {
        content: [{
          type: "text" as const,
          text: `📍 ${result.name}\nlat: ${result.lat}\nlng: ${result.lng}\nradius_km: ${result.radiusKm}\nsource: ${result.source}`,
        }],
      };
    }
  );

  // ─── Cart tools (Phase 1) ────────────────────────────────────
  // Tools 10-14: shopping cart ("handleliste") for local food pickup orders.
  // No payment. No seller notification. Anonymous buyer (buyer_ref token).

  // Tool 10: Create a cart
  server.registerTool(
    "lokal_cart_create",
    {
      title: "Create a shopping cart",
      description: "Create a new anonymous shopping cart ('handleliste'). Returns a cart_id and a buyer_ref capability token — STORE THE buyer_ref, it is required for all subsequent cart operations and cannot be recovered. Each cart is valid for 7 days. Use lokal_cart_add_item to add products, lokal_cart_view to review, and lokal_cart_submit to place orders (pickup, no payment).",
      inputSchema: {},
      annotations: {
        title: "Create shopping cart",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const result = svcCreateCart();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, ...result }, null, 2),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: msg }) }] };
      }
    }
  );

  // Tool 11: Add item to cart
  server.registerTool(
    "lokal_cart_add_item",
    {
      title: "Add item to shopping cart",
      description: "Add a product to the cart or update its quantity (re-adding the same product_id updates qty). Product must be in_stock and from a verified non-umbrella producer (use lokal_search / catalog feed to find eligible products and their IDs). Requires cart_id and buyer_ref from lokal_cart_create.",
      inputSchema: {
        cart_id:    z.string().describe("Cart ID from lokal_cart_create"),
        buyer_ref:  z.string().describe("Buyer capability token from lokal_cart_create"),
        product_id: z.string().describe("Product ID from the catalog (products.id)"),
        qty:        z.number().int().positive().describe("Quantity to set for this product in the cart"),
        note:       z.string().optional().describe("Optional line note for this item (e.g. 'please keep cold')"),
      },
      annotations: {
        title: "Add cart item",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ cart_id, buyer_ref, product_id, qty, note }) => {
      const check = svcCheckCartToken(cart_id, buyer_ref);
      if (!check.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: check.error }) }] };
      }
      const result = svcAddCartItem(cart_id, product_id, qty, note);
      if (!result.success) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: result.error }) }] };
      }
      const cart = svcViewCart(cart_id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, item: result.item, cart }, null, 2),
        }],
      };
    }
  );

  // Tool 12: View cart
  server.registerTool(
    "lokal_cart_view",
    {
      title: "View shopping cart",
      description: "View the current contents of a cart, grouped by producer, with subtotals and a total. Use this before submitting to review what is in the cart. Requires cart_id and buyer_ref.",
      inputSchema: {
        cart_id:   z.string().describe("Cart ID from lokal_cart_create"),
        buyer_ref: z.string().describe("Buyer capability token from lokal_cart_create"),
      },
      annotations: {
        title: "View cart",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ cart_id, buyer_ref }) => {
      const check = svcCheckCartToken(cart_id, buyer_ref);
      if (!check.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: check.error }) }] };
      }
      const cart = svcViewCart(cart_id);
      if (!cart) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Cart not found" }) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(cart, null, 2) }] };
    }
  );

  // Tool 13: Submit cart → place pickup orders
  server.registerTool(
    "lokal_cart_submit",
    {
      title: "Submit cart and place pickup orders",
      description: "Submit the cart to create pickup orders — one order per producer. Re-checks availability of every item at submit time; if any item is no longer in_stock, submit is rejected with a clear per-item message. No payment is charged. Sellers who have opted in to order notifications are notified by email and can confirm/decline the order; other sellers are not contacted. Returns a list of order IDs per producer. Use lokal_order_status to check order status.",
      inputSchema: {
        cart_id:   z.string().describe("Cart ID to submit"),
        buyer_ref: z.string().describe("Buyer capability token"),
      },
      annotations: {
        title: "Submit cart",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ cart_id, buyer_ref }) => {
      const check = svcCheckCartToken(cart_id, buyer_ref);
      if (!check.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: check.error }) }] };
      }
      const result = svcSubmitCart(cart_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Tool 14: Order status
  server.registerTool(
    "lokal_order_status",
    {
      title: "Get order status",
      description: "Fetch the status, items and status timeline of a pickup order created by lokal_cart_submit. Requires the order_id returned by submit and the buyer_ref token. Status: pending → confirmed → ready → completed (or declined/cancelled; cancel_reason='no_show' means the buyer did not pick up). The timeline array lists every status transition with timestamps.",
      inputSchema: {
        order_id:  z.string().describe("Order ID from lokal_cart_submit"),
        buyer_ref: z.string().describe("Buyer capability token (same as used for the cart)"),
      },
      annotations: {
        title: "Order status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ order_id, buyer_ref }) => {
      const result = svcGetOrder(order_id, buyer_ref);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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

function formatAgentCompact(agent: any, idx: number, contact?: any, productSummary?: string, clientIdentity?: string): string {
  const lines = [`**${idx}. ${agent.name}**`];
  if (agent.description) {
    if (isJunkDescription(agent.description)) {
      console.log(`[description-guard] suppressed junk description (lokal_search) for ${agent.id} (${agent.name})`);
    } else {
      lines.push(`   ${agent.description}`);
    }
  }

  const meta: string[] = [];
  if ((agent as any).city || agent.location?.city) meta.push(`📍 ${(agent as any).city || agent.location?.city}`);
  if (agent.categories?.length) meta.push(`🏷️ ${agent.categories.join(", ")}`);
  if (agent.trustScore) meta.push(`✅ Trust ${Math.round(agent.trustScore * 100)}%`);
  if (meta.length) lines.push(`   ${meta.join("  ·  ")}`);

  if (contact) {
    const cl: string[] = [];
    if (contact.address) cl.push(`📍 ${contact.address}`);
    if (isDisplayablePhone(contact.phone)) cl.push(`📞 ${contact.phone}`);
    if (contact.email) cl.push(`✉️ ${contact.email}`);
    if (contact.website) cl.push(`🌐 ${contact.website}`);
    if (cl.length) lines.push(`   ${cl.join("  ·  ")}`);
  }

  // Product summary: top products with "get details" hint
  if (productSummary) {
    lines.push(`   ${productSummary}`);
    lines.push(`   _Bruk lokal_info med agentId "${agent.id}" for full prisliste_`);
  }

  // Profile link
  const BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";
  lines.push(`   🔗 [Profil](${addAiUtmParams(`${BASE_URL}/produsent/${slugify(agent.name)}`, clientIdentity)})`);

  return lines.join("\n");
}

// ─── Session management ─────────────────────────────────────
// Each MCP client (ChatGPT session) gets its own transport+server pair.
// Sessions are cleaned up after 30 min of inactivity.

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  clientIdentity?: string;  // e.g. "ChatGPT", "Claude Desktop", "Cursor"
  requestMeta?: import("../services/conversation-service").RequestMeta;  // (item 3) internal-traffic classification signals
}

// ─── MCP client identity detection ─────────────────────────
// Identifies the AI platform from request headers.
function detectMcpClient(req: Request): string | undefined {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const origin = (req.headers["origin"] || "").toLowerCase();
  const referer = (req.headers["referer"] || "").toLowerCase();

  if (ua.includes("chatgpt") || ua.includes("openai") || origin.includes("openai") || origin.includes("chatgpt")) return "ChatGPT";
  if (ua.includes("claude") || origin.includes("claude.ai") || origin.includes("anthropic")) return "Claude";
  if (ua.includes("cursor")) return "Cursor";
  if (ua.includes("copilot") || origin.includes("github.com")) return "GitHub Copilot";
  if (ua.includes("windsurf")) return "Windsurf";
  if (ua.includes("cline")) return "Cline";
  if (ua.includes("continue")) return "Continue";
  if (ua.includes("python")) return "Python SDK";
  if (ua.includes("node")) return "Node SDK";
  return undefined;
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

async function getOrCreateSession(sessionId?: string, req?: Request): Promise<{ id: string; session: McpSession }> {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    // Update client identity if we detect one and didn't have one before
    if (!session.clientIdentity && req) {
      session.clientIdentity = detectMcpClient(req);
    }
    // Capture internal-traffic classification signals if not yet known (item 3)
    if (!session.requestMeta && req) {
      session.requestMeta = buildRequestMeta(req);
    }
    return { id: sessionId, session };
  }

  // Create new session — detect which AI platform is connecting
  const id = sessionId || randomUUID();
  const clientIdentity = req ? detectMcpClient(req) : undefined;
  const requestMeta = req ? buildRequestMeta(req) : undefined;

  const server = new McpServer({ name: "rett-fra-bonden", version: "0.4.0" });
  const sessionRef: { clientIdentity?: string; requestMeta?: import("../services/conversation-service").RequestMeta } = { clientIdentity, requestMeta };
  registerTools(server, () => sessionRef.clientIdentity, () => sessionRef.requestMeta);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
  });

  await server.connect(transport);

  const session: McpSession = { transport, server, lastActivity: Date.now(), clientIdentity, requestMeta };
  sessions.set(id, session);
  return { id, session };
}

// ─── Routes ─────────────────────────────────────────────────

// POST /mcp — Main MCP message handler (JSON-RPC over HTTP)
router.post("/", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const { session } = await getOrCreateSession(sessionId, req);
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
