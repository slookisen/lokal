// ─── What counts as a search, and through which channel ─────────────────
// dev-request 2026-10-13-statistikk-riktig-for-investorer (A2A), S2.
//
// Until now only GET /api/marketplace/search?q= was logged: 3 searches a day,
// all the footer's «mat» link, while /sok on the three sites had 650+ views a
// day and AI assistants ran ~260 search tool calls. Searches are now logged
// in analytics_queries from every channel that takes one:
//
//   web  the search page (/sok) on rettfrabonden.com, finn-tannlege.com and
//        opplevagent.no — first result page only, so paging is not a search;
//   api  the public search/discover endpoints (API_SEARCH_ROUTES);
//   mcp / a2a
//        AI assistants' search tools, counted from analytics_mcp_calls
//        (MCP_SEARCH_TOOLS, A2A_REQUEST_METHODS), which already logs every
//        call, so they are not written twice.
//
// Each row stores the client class of the full user agent (client_class), so
// a crawler following a /sok?q= link is a bot search, not a person's.
//
// Pure: no database import.

import type { ClientClass } from "./traffic-classifier";

export type SearchChannel = "web" | "api" | "mcp" | "a2a";

/** Public search endpoints (full paths, as the app-level middleware sees them). */
export const API_SEARCH_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/api/marketplace/search" },
  { method: "POST", path: "/api/marketplace/discover" },
  { method: "POST", path: "/api/search" },
  { method: "GET", path: "/api/tannlege/discover" },
  { method: "GET", path: "/api/opplevelser/discover" },
];

export function isApiSearchRequest(method: string, path: string): boolean {
  const p = path.replace(/\/+$/, "");
  return API_SEARCH_ROUTES.some((r) => r.method === method && r.path === p);
}

/** MCP tools that search a catalogue (tools/call params.name). */
export const MCP_SEARCH_TOOLS = [
  "lokal_search", "lokal_discover", "lokal_find_offers",
  "tannlege_search", "tannlege_akutt",
  "discover_experiences", "discover_gardssalg",
] as const;

/** A2A JSON-RPC methods that carry a request to the registry agent. */
export const A2A_REQUEST_METHODS = ["message/send", "message/stream", "tasks/send"] as const;

/** Client classes whose searches are not a person's or a program's use of the service. */
export const BOT_SEARCH_CLASSES: readonly ClientClass[] = ["search_engine", "seo_bot", "social", "other_bot", "scanner"];

/**
 * Free text marks a real query; structured filters are stored as "[k: v; …]"
 * so they are counted as searches but kept out of the top search terms.
 */
export function isFreeTextQuery(q: string | null | undefined): boolean {
  const s = String(q ?? "").trim();
  return s.length >= 2 && !s.startsWith("[");
}

const IGNORED_FILTER_KEYS = new Set([
  "limit", "offset", "page", "side", "format", "lang", "lat", "lng", "radius", "sort", "utm_source", "utm_medium", "utm_campaign",
]);

/** "[fylke: Oslo; spesialitet: kjeveortoped]" from structured filters; "" when there are none. */
export function filterQueryText(filters: Record<string, unknown> | null | undefined): string {
  if (!filters || typeof filters !== "object") return "";
  const parts: string[] = [];
  for (const key of Object.keys(filters).sort()) {
    if (IGNORED_FILTER_KEYS.has(key)) continue;
    const v = (filters as Record<string, unknown>)[key];
    if (v === undefined || v === null || v === "" || v === false) continue;
    const text = Array.isArray(v) ? v.join(",") : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (text) parts.push(`${key}: ${text}`);
  }
  return parts.length ? `[${parts.join("; ")}]`.slice(0, 160) : "";
}

/**
 * The text stored for an API search: the free-text field when the client sent
 * one (q / query, from the query string or a JSON body), else the filters.
 */
export function apiSearchQueryText(query: Record<string, unknown> | undefined, body: unknown): string {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  for (const src of [query ?? {}, b]) {
    for (const k of ["q", "query"]) {
      const v = (src as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return filterQueryText({ ...(query ?? {}), ...b }) || "[alle]";
}
