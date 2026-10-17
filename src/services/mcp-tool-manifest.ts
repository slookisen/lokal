// ─── MCP tool manifest: discovery files generated from the REGISTERED tools ──
// dev-request 2026-09-08-discovery-paritet-og-ett-katalogtall (item 7) /
// 2026-08-24-rfb-mcp-verktoybeskrivelser-vs-virkelighet regression.
//
// mcp.json / server-card.json used to hard-code tool names ("search_producers",
// "start_negotiation", ...) that no MCP server ever registered. This module
// builds a throwaway McpServer, runs the SAME register function the live /mcp
// endpoint runs, and reads the registered (enabled) tools back out — so what the
// discovery files list can only be what tools/list serves. No transport, no
// network, no self-call at startup: the registration is pure in-process and the
// result is memoised for the process lifetime.
//
// Route modules are require()d lazily to avoid import cycles with the discovery
// routers that call this.
//
// registeredMcpToolDefinitions() reads the same registration with full
// description, title and annotations, for scripts/gen-connector-packs.ts
// (A2A dev-request 2026-10-16-merkevare-entitet-og-connector-pakker, G3-S6).
//
// registeredMcpCapabilities() reads the capabilities that registration gives
// the server, which `initialize` sends, for the server card (A2A dev-request
// 2026-10-17-dental-d3-rettelser, D3a).

import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerCapabilities, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { CatalogVertical } from "./honest-count";

export interface McpToolEntry {
  name: string;
  description: string;
}

/** One enabled tool as tools/list serves it; `title` is null when the tool sets none. */
export interface McpToolDefinition {
  name: string;
  title: string | null;
  description: string;
  annotations: ToolAnnotations;
}

type RegisterFn = (server: McpServer) => void;

function registerFor(vertical: CatalogVertical): RegisterFn {
  switch (vertical) {
    case "dental":
      return (require("../routes/dental-mcp") as typeof import("../routes/dental-mcp")).registerDentalTools;
    case "experiences":
      return (require("../routes/experiences-mcp") as typeof import("../routes/experiences-mcp")).registerExperienceTools;
    default:
      return (require("../routes/mcp") as typeof import("../routes/mcp")).registerTools;
  }
}

/** First sentence of a tool description, capped, for compact discovery files. */
export function shortToolDescription(text: string, max = 220): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  const first = m ? m[1] : flat;
  return first.length <= max ? first : first.slice(0, max - 1).trimEnd() + "…";
}

/** A throwaway server with the vertical's register function run on it; no transport. */
function registeredServer(vertical: CatalogVertical): McpServer {
  const server = new McpServer({ name: `manifest-${vertical}`, version: "0.0.0" });
  registerFor(vertical)(server);
  return server;
}

/** Runs the vertical's register function on a throwaway server; the enabled tools in registration order. */
function enabledRegisteredTools(vertical: CatalogVertical): Array<[string, RegisteredTool]> {
  const server = registeredServer(vertical);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  return Object.entries(registered || {}).filter(([, t]) => t.enabled !== false);
}

const _cache = new Map<CatalogVertical, McpToolEntry[]>();

/** The enabled tools the vertical's live MCP server registers, in registration order. */
export function registeredMcpTools(vertical: CatalogVertical): McpToolEntry[] {
  const hit = _cache.get(vertical);
  if (hit) return hit;
  const out = enabledRegisteredTools(vertical).map(([name, t]) => ({ name, description: shortToolDescription(t.description || "") }));
  _cache.set(vertical, out);
  return out;
}

/**
 * The enabled tools with full description, title and annotations, in registration order. Not memoised:
 * the registration reads PAYMENTS_ENABLED (lokal_cart_submit's text). For offline tools and tests.
 */
export function registeredMcpToolDefinitions(vertical: CatalogVertical): McpToolDefinition[] {
  return enabledRegisteredTools(vertical).map(([name, t]) => ({
    name,
    title: t.title ?? null,
    description: String(t.description || ""),
    annotations: { ...(t.annotations || {}) },
  }));
}

export function registeredMcpToolNames(vertical: CatalogVertical): string[] {
  return registeredMcpTools(vertical).map((t) => t.name);
}

const _capabilitiesCache = new Map<CatalogVertical, ServerCapabilities>();

/**
 * The capabilities `initialize` sends for the vertical's live MCP server: what the SDK registers along with the
 * tools (`tools.listChanged`), so a discovery file cannot claim resources or prompts the server does not serve.
 * The live servers set no `capabilities` option of their own. Memoised, as registeredMcpTools.
 */
export function registeredMcpCapabilities(vertical: CatalogVertical): ServerCapabilities {
  const hit = _capabilitiesCache.get(vertical);
  if (hit) return hit;
  const server = registeredServer(vertical);
  const out = (server.server as unknown as { getCapabilities(): ServerCapabilities }).getCapabilities();
  _capabilitiesCache.set(vertical, out);
  return out;
}
