// ─── Search counts per channel, on an explicit DB handle ────────────────
// dev-request 2026-10-13-statistikk-riktig-for-investorer (A2A), S2/S3.
// Moved out of admin-stats-compute.ts (which re-exports it) so the stored
// traffic history (traffic-history-compute.ts) can count searches without an
// import cycle. Pure: no database/init import; runs in the stats workers.

import type Database from "better-sqlite3";
import type { VerticalId } from "./analytics-service";
import { A2A_REQUEST_METHODS, ASSISTANT_SEARCH_CLASS, BOT_SEARCH_CLASSES, isFreeTextQuery, MCP_SEARCH_TOOLS } from "./search-tracking";
import { PROBE_CLIENT_MARKERS } from "./agent-usage-compute";

type Db = Database.Database;

// SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" (space, no T/Z).
function cutoffFor(nowMs: number, hoursBack: number): string {
  return new Date(nowMs - hoursBack * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export interface QueryStats {
  /** web + api + mcp + a2a + ai, owner and bots excluded. */
  totalQueries: number;
  ownerQueries: number;
  /** Free-text queries from the web and API channels, owner and bots excluded. */
  topSearchTerms: Array<{ query: string; count: number }>;
  /**
   * web/api: a person or a program on the search page or the API; mcp/a2a:
   * AI assistants' search tools and A2A requests; ai: an AI assistant
   * fetching the search page or API for someone (client class ai_search).
   */
  byChannel?: { web: number; api: number; mcp: number; a2a: number; ai: number };
  botQueries?: number;
  /** AI agents' lookups over MCP data tools and countable A2A requests (computeAiLookups, S7). */
  aiLookups?: AiLookups;
}

function tableExists(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnExists(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

/**
 * `AND`-able predicate leaving robots' searches out of analytics_queries rows
 * (the same rule as computeQueryStats' bot bucket); "" on a schema without
 * client_class. `alias` qualifies the columns.
 */
export function notBotSearchSql(db: Db, alias?: string): string {
  if (!columnExists(db, "analytics_queries", "client_class")) return "";
  const c = (col: string) => (alias ? `${alias}.${col}` : col);
  const cls = `COALESCE(${c("client_class")}, '')`;
  const proto = columnExists(db, "analytics_queries", "protocol") ? c("protocol") : "'api'";
  return ` AND ${cls} NOT IN (${BOT_SEARCH_CLASSES.map((x) => `'${x}'`).join(", ")}) AND NOT (${proto} = 'web' AND ${cls} = 'dev')`;
}

export interface QueryStatsOptions {
  /** A fixed range [fromMs, toMs) instead of the trailing hours (traffic-history-compute.ts). */
  fromMs?: number;
  toMs?: number;
  /** Length of topSearchTerms (default 10). */
  topTerms?: number;
}

export function computeQueryStats(
  db: Db, hoursBack: number, vertical: VerticalId | undefined, nowMs: number, opts: QueryStatsOptions = {},
): QueryStats {
  const ranged = opts.fromMs !== undefined && opts.toMs !== undefined;
  const timeSql = ranged ? "created_at >= ? AND created_at < ?" : "created_at > ?";
  const tp: string[] = ranged
    ? [cutoffFor(opts.fromMs!, 0), cutoffFor(opts.toMs!, 0)]
    : [cutoffFor(nowMs, hoursBack)];
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];
  // COALESCE: rows written before S2 have no class; without it `NULL IN (…)`
  // is NULL and `NOT (…)` would drop those rows instead of keeping them.
  const cls = columnExists(db, "analytics_queries", "client_class") ? "COALESCE(client_class, '')" : "''";
  // Minimal schemas (older test fixtures) lack protocol: every row is then an API search.
  const proto = columnExists(db, "analytics_queries", "protocol") ? "protocol" : "'api'";
  const botClasses = BOT_SEARCH_CLASSES.map((c) => `'${c}'`).join(", ");
  // A bot search: a bot class (AI crawlers included) on any channel, or a
  // script on the web page.
  const isBot = `(${cls} IN (${botClasses}) OR (${proto} = 'web' AND ${cls} = 'dev'))`;
  const isAssistant = `(${cls} = '${ASSISTANT_SEARCH_CLASS}')`;

  const byChannel = { web: 0, api: 0, mcp: 0, a2a: 0, ai: 0 };
  let botQueries = 0;
  let ownerQueries = 0;
  const rows = db.prepare(`
    SELECT ${proto} AS protocol, is_owner, ${isBot} AS bot, ${isAssistant} AS assistant, COUNT(*) AS n FROM analytics_queries
    WHERE ${timeSql}${V}
    GROUP BY 1, is_owner, bot, assistant
  `).all(...tp, ...vp) as Array<{ protocol: string; is_owner: number | null; bot: number; assistant: number; n: number }>;
  for (const r of rows) {
    if (r.is_owner === 1) { ownerQueries += r.n; continue; }
    if (r.bot) { botQueries += r.n; continue; }
    if (r.assistant) { byChannel.ai += r.n; continue; }
    // Legacy protocol values ('search') and anything unknown are API calls.
    const ch = r.protocol === "web" || r.protocol === "mcp" || r.protocol === "a2a" ? r.protocol : "api";
    byChannel[ch] += r.n;
  }

  // AI assistants: search tool calls and A2A requests, already logged per call.
  if (tableExists(db, "analytics_mcp_calls")) {
    const tools = [...MCP_SEARCH_TOOLS];
    const methods = [...A2A_REQUEST_METHODS];
    // A call answered 4xx/5xx (a rate limiter's 429, a bad request) is not a
    // search; rows written before the status was stored count as they are.
    const okStatus = columnExists(db, "analytics_mcp_calls", "status_code") ? " AND (status_code IS NULL OR status_code < 400)" : "";
    // An A2A request counts only with countable = 1 (S7: it asked something,
    // an external caller, data back, under the per-IP cap); rows written
    // before the verdict was stored cannot be told from spam.
    const a2aCountable = columnExists(db, "analytics_mcp_calls", "countable") ? " AND countable = 1" : "";
    const mcp = db.prepare(`
      SELECT protocol, COUNT(*) AS n FROM analytics_mcp_calls
      WHERE ${timeSql} AND (is_owner IS NULL OR is_owner = 0)${okStatus}${V}
        AND ((protocol = 'mcp' AND tool_name IN (${tools.map(() => "?").join(", ")}))
          OR (protocol = 'a2a' AND tool_name IN (${methods.map(() => "?").join(", ")})${a2aCountable}))
      GROUP BY protocol
    `).all(...tp, ...vp, ...tools, ...methods) as Array<{ protocol: string; n: number }>;
    for (const r of mcp) {
      if (r.protocol === "mcp") byChannel.mcp += r.n;
      else if (r.protocol === "a2a") byChannel.a2a += r.n;
    }
  }

  // Top free-text terms from people, programs and AI assistants on the web and
  // API channels. Case is folded in JS: SQLite's lower() folds ASCII only, so
  // «Økologisk» and «økologisk» would be two terms.
  const terms = new Map<string, number>();
  for (const r of db.prepare(`
    SELECT trim(query) AS query, COUNT(*) AS count FROM analytics_queries
    WHERE ${timeSql}${V}
      AND (is_owner IS NULL OR is_owner = 0)
      AND NOT ${isBot}
      AND query IS NOT NULL AND LENGTH(TRIM(query)) >= 2 AND TRIM(query) NOT LIKE '[%'
    GROUP BY trim(query)
  `).all(...tp, ...vp) as Array<{ query: string; count: number }>) {
    const k = r.query.toLocaleLowerCase("nb-NO");
    terms.set(k, (terms.get(k) ?? 0) + r.count);
  }
  const topSearchTerms = [...terms.entries()]
    .filter(([q]) => isFreeTextQuery(q))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, opts.topTerms ?? 10)
    .map(([query, count]) => ({ query, count }));

  return {
    totalQueries: byChannel.web + byChannel.api + byChannel.mcp + byChannel.a2a + byChannel.ai,
    ownerQueries,
    topSearchTerms,
    byChannel,
    botQueries,
    aiLookups: computeAiLookups(db, hoursBack, vertical, nowMs, opts),
  };
}

// ─── AI lookups over MCP and A2A ─────────────────────────────────────────
// dev-request 2026-10-13-statistikk-riktig-for-investorer, S7 (Daniel
// 2026-10-14: «Ta med MCP/A2A i AI-søk»). An AI agent fetching information
// from the platform through its tools rather than a web page:
//   - MCP: a call to one of the vertical's information tools (exact,
//     case-sensitive names below), or a resources/read of rettfrabonden's
//     lokal:// data resources. Handshakes and health checks (initialize,
//     tools/list, notifications/…, ping, server/discover …), unknown tool
//     names, actions (shopping cart, order status, gårdssalg booking) and the
//     geocode helper are not lookups.
//   - A2A: a request (message/send, tasks/send, SendMessage) logged with
//     countable = 1: it asked something, external, answered with data, under
//     the per-IP cap (a2a.ts; a2a-traffic-classifier.ts a2aLookupCountable).
// Catalogue probes and monitors are left out on both protocols by client name
// or user agent (the same markers as agent-usage-compute.ts).
// Our own traffic (is_owner) and calls answered 4xx/5xx are left out. A tool
// call answered with a JSON-RPC or tool error over HTTP 200 still counts: the
// logger does not see the result.

/** MCP tools that hand the caller platform information, per vertical (the registered tools minus actions and helpers). */
export const AI_LOOKUP_MCP_TOOLS = {
  rfb: [
    "lokal_search", "lokal_discover", "lokal_find_offers", "lokal_info", "lokal_stats",
    "lokal_bm_next_markets", "lokal_list_umbrellas", "lokal_get_umbrella_members", "lokal_get_producer_affiliations",
  ],
  dental: ["tannlege_search", "tannlege_info", "tannlege_akutt", "tannlege_kjeder", "tannlege_stats"],
  experiences: ["discover_experiences", "get_experience", "list_experience_categories", "discover_gardssalg"],
} as const;

/** Registered MCP tools that act or help rather than hand out information (not lookups). */
export const NON_LOOKUP_MCP_TOOLS = {
  rfb: ["lokal_cart_create", "lokal_cart_add_item", "lokal_cart_view", "lokal_cart_submit", "lokal_order_status", "lokal_geocode"],
  dental: [],
  experiences: ["book_gardssalg"],
} as const;

/** Client-name / user-agent markers of catalogue probes and monitors: the agentplatform.no tool-call count's list. */
export const AI_LOOKUP_PROBE_MARKERS = PROBE_CLIENT_MARKERS;

export interface AiLookups {
  mcp: number;
  a2a: number;
  total: number;
}

/**
 * The one definition of "a counted AI lookup" on analytics_mcp_calls: a WHERE
 * clause (no leading WHERE) plus its parameters. computeAiLookups and
 * computeAiLookupBreakdown both read through it, so the breakdown can never
 * drift from the headline number.
 */
function aiLookupWhere(
  db: Db, hoursBack: number, vertical: VerticalId | undefined, nowMs: number, opts: QueryStatsOptions,
): { sql: string; params: string[] } {
  const ranged = opts.fromMs !== undefined && opts.toMs !== undefined;
  const timeSql = ranged ? "created_at >= ? AND created_at < ?" : "created_at > ?";
  const tp: string[] = ranged ? [cutoffFor(opts.fromMs!, 0), cutoffFor(opts.toMs!, 0)] : [cutoffFor(nowMs, hoursBack)];
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];
  const okStatus = columnExists(db, "analytics_mcp_calls", "status_code") ? " AND (status_code IS NULL OR status_code < 400)" : "";
  // Each vertical's own tools: a dental tool name called on rfb's server is an unknown tool there.
  const verticals = Object.keys(AI_LOOKUP_MCP_TOOLS) as Array<keyof typeof AI_LOOKUP_MCP_TOOLS>;
  const toolSql = verticals
    .map((v) => `(vertical_id = ? AND tool_name IN (${AI_LOOKUP_MCP_TOOLS[v].map(() => "?").join(", ")}))`)
    .join(" OR ");
  const toolParams = verticals.flatMap((v) => [v, ...AI_LOOKUP_MCP_TOOLS[v]]);
  const ua = columnExists(db, "analytics_mcp_calls", "user_agent") ? "lower(coalesce(user_agent, ''))" : "''";
  const probe = AI_LOOKUP_PROBE_MARKERS.map(() => `(lower(coalesce(client_name, '')) LIKE ? OR ${ua} LIKE ?)`).join(" OR ");
  const probeParams = AI_LOOKUP_PROBE_MARKERS.flatMap((m) => [`%${m}%`, `%${m}%`]);
  const a2a = columnExists(db, "analytics_mcp_calls", "countable")
    ? `(protocol = 'a2a' AND tool_name IN (${A2A_REQUEST_METHODS.map(() => "?").join(", ")}) AND countable = 1)`
    : "0";
  // Own traffic is stamped is_owner = 1 when it is logged (mcp-usage-logger.ts:
  // admin key, owner cookie, internal UA / client-name markers such as "rfb-").
  return {
    sql: `${timeSql} AND (is_owner IS NULL OR is_owner = 0)${okStatus}${V}
      AND ((protocol = 'mcp' AND (${toolSql} OR (tool_name = 'resources/read' AND vertical_id = 'rfb')))
        OR ${a2a})
      AND NOT (${probe})`,
    params: [...tp, ...vp, ...toolParams, ...(a2a === "0" ? [] : A2A_REQUEST_METHODS), ...probeParams],
  };
}

export function computeAiLookups(
  db: Db, hoursBack: number, vertical: VerticalId | undefined, nowMs: number, opts: QueryStatsOptions = {},
): AiLookups {
  if (!tableExists(db, "analytics_mcp_calls")) return { mcp: 0, a2a: 0, total: 0 };
  const w = aiLookupWhere(db, hoursBack, vertical, nowMs, opts);
  const rows = db.prepare(`
    SELECT protocol, COUNT(*) AS n FROM analytics_mcp_calls
    WHERE ${w.sql}
    GROUP BY protocol
  `).all(...w.params) as Array<{ protocol: string; n: number }>;
  let mcp = 0;
  let a2aN = 0;
  for (const r of rows) {
    if (r.protocol === "mcp") mcp += r.n;
    else if (r.protocol === "a2a") a2aN += r.n;
  }
  return { mcp, a2a: a2aN, total: mcp + a2aN };
}

export interface AiLookupBreakdownRow {
  vertical: string;
  protocol: "mcp" | "a2a";
  clientName: string;
  tool: string;
  calls: number;
  distinctIpHashes: number;
  distinctDays: number;
  firstSeen: string;
  lastSeen: string;
}

export interface AiLookupConcentration {
  vertical: string;
  /** "all" = MCP and A2A together (the AI-søk number). */
  protocol: "all" | "mcp" | "a2a";
  calls: number;
  distinctIpHashes: number;
  /** Share (0–1) of the calls from the single largest ip_hash. */
  top1Share: number;
  /** Share (0–1) of the calls from the five largest ip_hashes. */
  top5Share: number;
}

export interface AiLookupBreakdown {
  /** Sum of rows[].calls; equals computeAiLookups(...).total for the same window and vertical. */
  total: number;
  rows: AiLookupBreakdownRow[];
  concentration: AiLookupConcentration[];
}

const share = (n: number, total: number): number => (total > 0 ? Math.round((n / total) * 10000) / 10000 : 0);

/**
 * Who makes the AI lookups: the rows computeAiLookups counts, split per
 * vertical x client_name x tool (A2A: tool = the JSON-RPC method), plus how
 * concentrated each vertical is on its largest ip_hashes (hashes only, never
 * raw IPs; a missing hash is one "unknown" bucket).
 */
export function computeAiLookupBreakdown(
  db: Db, hoursBack: number, vertical: VerticalId | undefined, nowMs: number, opts: QueryStatsOptions = {},
): AiLookupBreakdown {
  if (!tableExists(db, "analytics_mcp_calls")) return { total: 0, rows: [], concentration: [] };
  const w = aiLookupWhere(db, hoursBack, vertical, nowMs, opts);
  const rows = (db.prepare(`
    SELECT vertical_id AS vertical, protocol, COALESCE(client_name, 'unknown') AS clientName, tool_name AS tool,
           COUNT(*) AS calls, COUNT(DISTINCT COALESCE(ip_hash, 'unknown')) AS distinctIpHashes,
           COUNT(DISTINCT date(created_at)) AS distinctDays, MIN(created_at) AS firstSeen, MAX(created_at) AS lastSeen
    FROM analytics_mcp_calls
    WHERE ${w.sql}
    GROUP BY vertical_id, protocol, COALESCE(client_name, 'unknown'), tool_name
    ORDER BY calls DESC, vertical_id, clientName, tool_name
  `).all(...w.params) as AiLookupBreakdownRow[]);
  const perIp = db.prepare(`
    SELECT vertical_id AS vertical, protocol, COALESCE(ip_hash, 'unknown') AS ip, COUNT(*) AS n
    FROM analytics_mcp_calls
    WHERE ${w.sql}
    GROUP BY vertical_id, protocol, COALESCE(ip_hash, 'unknown')
  `).all(...w.params) as Array<{ vertical: string; protocol: "mcp" | "a2a"; ip: string; n: number }>;

  const buckets = new Map<string, Map<string, number>>(); // "vertical|protocol" -> ip -> n
  const add = (key: string, ip: string, n: number) => {
    const m = buckets.get(key) ?? new Map<string, number>();
    m.set(ip, (m.get(ip) ?? 0) + n);
    buckets.set(key, m);
  };
  for (const r of perIp) {
    add(`${r.vertical}|${r.protocol}`, r.ip, r.n);
    add(`${r.vertical}|all`, r.ip, r.n);
  }
  const concentration: AiLookupConcentration[] = [...buckets.entries()].map(([key, m]) => {
    const [v, protocol] = key.split("|");
    const counts = [...m.values()].sort((a, b) => b - a);
    const calls = counts.reduce((a, b) => a + b, 0);
    return {
      vertical: v,
      protocol: protocol as AiLookupConcentration["protocol"],
      calls,
      distinctIpHashes: counts.length,
      top1Share: share(counts[0] ?? 0, calls),
      top5Share: share(counts.slice(0, 5).reduce((a, b) => a + b, 0), calls),
    };
  }).sort((a, b) => a.vertical.localeCompare(b.vertical) || a.protocol.localeCompare(b.protocol));

  return { total: rows.reduce((a, r) => a + r.calls, 0), rows, concentration };
}
