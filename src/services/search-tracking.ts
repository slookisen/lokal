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
// a crawler following a /sok?q= link is a bot search, not a person's, and an
// AI assistant fetching the search page or API for someone (ChatGPT-User and
// the like, class 'ai_search') is counted with the AI assistants.
//
// Stored text: the free text the client typed (at most MAX_QUERY_TEXT
// characters), or the structured filters as "[key: value; …]" with only plain
// values of known-harmless keys — never a position, a consumer profile or any
// nested object (filterQueryText).
//
// Pure: no database import.

import type { ClientClass } from "./traffic-classifier";
import { classifyA2aTraffic, type A2aTrafficClass } from "./a2a-traffic-classifier";
import { PROBE_CLIENT_MARKERS } from "./agent-usage-compute";
import { isInternalTraffic, type RequestMeta } from "./internal-traffic";

export type SearchChannel = "web" | "api" | "mcp" | "a2a";

/**
 * Public search endpoints (full paths, as the app-level middleware sees them).
 * `withFilterOnly`: a listing endpoint that is only a search when the client
 * filters it (the footer links /api/tannlege/agents bare).
 */
export const API_SEARCH_ROUTES: ReadonlyArray<{ method: string; path: string; withFilterOnly?: boolean }> = [
  { method: "GET", path: "/api/marketplace/search" },
  { method: "POST", path: "/api/marketplace/discover" },
  { method: "POST", path: "/api/search" },
  { method: "GET", path: "/api/marketplace/catalog/offers" },
  { method: "GET", path: "/api/tannlege/discover" },
  { method: "GET", path: "/api/tannlege/agents", withFilterOnly: true },
  { method: "GET", path: "/api/opplevelser/discover" },
];

/** Query-string keys that page or format a result, not filter it. */
const PAGING_KEYS = new Set(["limit", "offset", "page", "side", "format", "lang", "sort"]);

export function isApiSearchRequest(method: string, path: string, query?: Record<string, unknown>): boolean {
  // Express matches routes case-insensitively, so must this.
  const p = path.replace(/\/+$/, "").toLowerCase();
  const route = API_SEARCH_ROUTES.find((r) => r.method === method && r.path === p);
  if (!route) return false;
  if (!route.withFilterOnly) return true;
  return Object.keys(query ?? {}).some((k) => !PAGING_KEYS.has(k) && !k.startsWith("utm_") && String((query as Record<string, unknown>)[k] ?? "") !== "");
}

/** Longest search text stored (a JSON body may be up to 1 MB). */
export const MAX_QUERY_TEXT = 200;

export function clampQueryText(q: unknown): string {
  return String(q ?? "").slice(0, MAX_QUERY_TEXT);
}

/** MCP tools that search a catalogue (tools/call params.name). */
export const MCP_SEARCH_TOOLS = [
  "lokal_search", "lokal_discover", "lokal_find_offers",
  "tannlege_search", "tannlege_akutt",
  "discover_experiences", "discover_gardssalg",
] as const;

/**
 * A2A JSON-RPC methods that carry a request to the registry agent: v0.3
 * message/send, the pre-0.3 alias tasks/send, and v1.0 SendMessage (a2a.ts).
 * message/stream is not implemented anywhere (it answers -32601).
 */
export const A2A_REQUEST_METHODS = ["message/send", "tasks/send", "SendMessage"] as const;

/** Client classes whose searches are not a person's or a program's use of the service. */
export const BOT_SEARCH_CLASSES: readonly ClientClass[] = ["search_engine", "seo_bot", "social", "other_bot", "scanner", "ai_crawler"];

/** An AI assistant fetching for a person (ChatGPT-User, Claude-User, …): counted with the AI assistants. */
export const ASSISTANT_SEARCH_CLASS: ClientClass = "ai_search";

/**
 * Free text marks a real query; structured filters are stored as "[k: v; …]"
 * so they are counted as searches but kept out of the top search terms.
 */
export function isFreeTextQuery(q: string | null | undefined): boolean {
  const s = String(q ?? "").trim();
  return s.length >= 2 && !s.startsWith("[");
}

/**
 * Filter keys stored in a structured search's text. Everything else is left
 * out — above all a position (location, lat/lng), a consumer profile
 * (consumerPreferences: diet, allergies) and any id: a search row is kept as a
 * count per text after the raw rows are deleted (query_text_daily, history).
 */
const STORED_FILTER_KEYS = new Set([
  "q", "query", "category", "categories", "kategori", "city", "by", "sted", "kommune", "fylke", "region", "county",
  "spesialitet", "specialty", "helfo", "akutt", "kjede", "tags", "tag", "type", "product", "products", "produkt",
  "certification", "certifications", "organic", "okologisk", "maxDistanceKm", "radius", "openNow", "delivery",
  "poststed", "acute_vakt", "chain_brand", "helfo_agreement",
]);

/** "[fylke: Oslo; spesialitet: kjeveortoped]" from structured filters; "" when there are none. */
export function filterQueryText(filters: Record<string, unknown> | null | undefined): string {
  if (!filters || typeof filters !== "object") return "";
  const parts: string[] = [];
  const plain = (x: unknown) => typeof x === "string" || typeof x === "number" || typeof x === "boolean";
  for (const key of Object.keys(filters).sort()) {
    if (!STORED_FILTER_KEYS.has(key)) continue;
    const v = (filters as Record<string, unknown>)[key];
    if (v === undefined || v === null || v === "" || v === false) continue;
    let text = "";
    if (Array.isArray(v)) {
      if (!v.every(plain)) continue;
      text = v.map(String).join(",");
    } else if (plain(v)) {
      text = String(v);
    } else {
      continue; // nested objects are never stored
    }
    if (text) parts.push(`${key}: ${text.slice(0, 60)}`);
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
      if (typeof v === "string" && v.trim()) return clampQueryText(v.trim());
    }
  }
  return filterQueryText({ ...(query ?? {}), ...b }) || "[alle]";
}

// ─── Which searches raise the counters ──────────────────────────────────
// A2A dev-request 2026-10-17-integrasjonstest-oppfolging, slice I-Z.

export interface SearchCountInput {
  /** buildRequestMeta() of the request (MCP: of the tools/call request). */
  meta: RequestMeta;
  /** The search text, or the structured query as JSON. */
  text?: string | null;
  /** MCP: initialize.clientInfo.name of the session. */
  clientName?: string | null;
  /** A structured query: the A2A rule for a JSON object typed as text is skipped. */
  structured?: boolean;
}

/**
 * Who sent a search or lookup outside A2A message/send, for the counters it
 * touches: RFB's agents.discovery_count and agent_metrics.times_discovered
 * (which trust_score reads), the public interactions feed (/api/interactions,
 * /api/live; also RFB A2A agent/info) and the conversations /sok and POST
 * /api/marketplace/discover (start_conversation) start. message/send decides
 * this with classifyA2aTraffic and its own `countable` (a2a.ts), which also
 * asks for intent and a per-IP cap.
 *
 * 'internal': our own traffic (isInternalTraffic: admin key, owner cookie,
 * internal UA markers; MCP: also the session's client name). 'probe' or
 * 'spam': what is already classified so, that is catalogue probes and
 * monitors by client name or user agent (PROBE_CLIENT_MARKERS, which AI-søk
 * and «Med i AI-svar» leave out) and the A2A spam guard's UA and text rules
 * (classifyA2aTraffic). Only 'external' counts; the caller answers the same
 * either way. The A2A rule that a JSON object typed as text is a probe holds
 * here too: such free text in lokal_search, /sok or a REST search is 'probe'
 * (a structured query sets `structured`).
 */
export function searchTrafficClass(input: SearchCountInput): A2aTrafficClass {
  const clientName = input.clientName || "";
  if (isInternalTraffic(input.meta) || isInternalTraffic({ userAgent: clientName })) return "internal";
  const ua = input.meta.userAgent || "";
  const names = `${clientName}\n${ua}`.toLowerCase();
  if (PROBE_CLIENT_MARKERS.some((m) => names.includes(m))) return "probe";
  return classifyA2aTraffic({ text: input.text, ua, hasStructuredData: input.structured });
}

/** May the search raise the counters (searchTrafficClass() is 'external')? */
export function searchCountable(input: SearchCountInput): boolean {
  return searchTrafficClass(input) === "external";
}
