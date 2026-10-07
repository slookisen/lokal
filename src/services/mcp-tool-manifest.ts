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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CatalogVertical } from "./honest-count";

export interface McpToolEntry {
  name: string;
  description: string;
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

const _cache = new Map<CatalogVertical, McpToolEntry[]>();

/** The enabled tools the vertical's live MCP server registers, in registration order. */
export function registeredMcpTools(vertical: CatalogVertical): McpToolEntry[] {
  const hit = _cache.get(vertical);
  if (hit) return hit;
  const server = new McpServer({ name: `manifest-${vertical}`, version: "0.0.0" });
  registerFor(vertical)(server);
  const registered = (server as unknown as {
    _registeredTools: Record<string, { description?: string; enabled?: boolean }>;
  })._registeredTools;
  const out = Object.entries(registered || {})
    .filter(([, t]) => t.enabled !== false)
    .map(([name, t]) => ({ name, description: shortToolDescription(t.description || "") }));
  _cache.set(vertical, out);
  return out;
}

export function registeredMcpToolNames(vertical: CatalogVertical): string[] {
  return registeredMcpTools(vertical).map((t) => t.name);
}
