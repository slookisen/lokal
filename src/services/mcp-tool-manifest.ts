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
// registeredMcpToolDefinitions() reads the same registration with the full
// description, the title and the annotations: the Claude directory packs
// (A2A dev-request 2026-10-16-merkevare-entitet-og-connector-pakker, G3-S6,
// scripts/gen-connector-packs.ts) list what the directory syncs from
// tools/list, and the description lint planned in
// 2026-10-16-mcp-beskrivelser-intensjonsord-og-lint (S6) is to reuse it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CatalogVertical } from "./honest-count";

export interface McpToolEntry {
  name: string;
  description: string;
}

/** The MCP tool annotations as a tool registers them (all optional in the spec). */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One enabled tool as tools/list serves it: full description, title and annotations. */
export interface McpToolDefinition {
  name: string;
  /** Top-level `title`; null when the tool sets none. */
  title: string | null;
  description: string;
  annotations: McpToolAnnotations;
}

type RegisteredToolRecord = {
  title?: string;
  description?: string;
  annotations?: McpToolAnnotations;
  enabled?: boolean;
};

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

/** Runs the vertical's register function on a throwaway server; the enabled tools in registration order. */
function enabledRegisteredTools(vertical: CatalogVertical): Array<[string, RegisteredToolRecord]> {
  const server = new McpServer({ name: `manifest-${vertical}`, version: "0.0.0" });
  registerFor(vertical)(server);
  const registered = (server as unknown as {
    _registeredTools: Record<string, RegisteredToolRecord>;
  })._registeredTools;
  return Object.entries(registered || {}).filter(([, t]) => t.enabled !== false);
}

const _cache = new Map<CatalogVertical, McpToolEntry[]>();

/** The enabled tools the vertical's live MCP server registers, in registration order. */
export function registeredMcpTools(vertical: CatalogVertical): McpToolEntry[] {
  const hit = _cache.get(vertical);
  if (hit) return hit;
  const out = enabledRegisteredTools(vertical)
    .map(([name, t]) => ({ name, description: shortToolDescription(t.description || "") }));
  _cache.set(vertical, out);
  return out;
}

/**
 * The enabled tools with full description, title and annotations, in
 * registration order. Not memoised: the registration reads the environment
 * (PAYMENTS_ENABLED picks lokal_cart_submit's text), so each call reflects it
 * as it is now. Callers are offline tools and tests, not request paths.
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
