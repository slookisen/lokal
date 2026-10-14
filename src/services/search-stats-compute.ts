// ─── Search counts per channel, on an explicit DB handle ────────────────
// dev-request 2026-10-13-statistikk-riktig-for-investorer (A2A), S2/S3.
// Moved out of admin-stats-compute.ts (which re-exports it) so the stored
// traffic history (traffic-history-compute.ts) can count searches without an
// import cycle. Pure: no database/init import; runs in the stats workers.

import type Database from "better-sqlite3";
import type { VerticalId } from "./analytics-service";
import { A2A_REQUEST_METHODS, ASSISTANT_SEARCH_CLASS, BOT_SEARCH_CLASSES, isFreeTextQuery, MCP_SEARCH_TOOLS } from "./search-tracking";

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
    // An A2A request counts only when the spam guard let it through (S7);
    // rows written before the verdict was stored cannot be told from spam.
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
//   - MCP: a call to one of our data tools (lokal_*, tannlege_*, the
//     experience and gårdssalg tools) or a resources/read. Handshakes and
//     catalogue health checks (initialize, tools/list, notifications/…,
//     ping, server/discover …) fetch nothing and are not counted.
//   - A2A: a request (message/send, tasks/send, SendMessage) the spam guard
//     let through (countable = 1: external, with intent, under the cap).
// Our own traffic (is_owner) and calls answered 4xx/5xx are left out.

/** MCP tools outside the lokal_/tannlege_ prefixes that fetch or act on platform data. */
export const AI_LOOKUP_MCP_TOOLS = [
  "discover_experiences", "get_experience", "list_experience_categories",
  "discover_gardssalg", "book_gardssalg", "resources/read",
] as const;

export interface AiLookups {
  mcp: number;
  a2a: number;
  total: number;
}

export function computeAiLookups(
  db: Db, hoursBack: number, vertical: VerticalId | undefined, nowMs: number, opts: QueryStatsOptions = {},
): AiLookups {
  if (!tableExists(db, "analytics_mcp_calls")) return { mcp: 0, a2a: 0, total: 0 };
  const ranged = opts.fromMs !== undefined && opts.toMs !== undefined;
  const timeSql = ranged ? "created_at >= ? AND created_at < ?" : "created_at > ?";
  const tp: string[] = ranged ? [cutoffFor(opts.fromMs!, 0), cutoffFor(opts.toMs!, 0)] : [cutoffFor(nowMs, hoursBack)];
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];
  const okStatus = columnExists(db, "analytics_mcp_calls", "status_code") ? " AND (status_code IS NULL OR status_code < 400)" : "";
  const a2a = columnExists(db, "analytics_mcp_calls", "countable")
    ? `(protocol = 'a2a' AND tool_name IN (${A2A_REQUEST_METHODS.map(() => "?").join(", ")}) AND countable = 1)`
    : "0";
  const rows = db.prepare(`
    SELECT protocol, COUNT(*) AS n FROM analytics_mcp_calls
    WHERE ${timeSql} AND (is_owner IS NULL OR is_owner = 0)${okStatus}${V}
      AND ((protocol = 'mcp' AND (tool_name LIKE 'lokal\\_%' ESCAPE '\\' OR tool_name LIKE 'tannlege\\_%' ESCAPE '\\'
             OR tool_name IN (${AI_LOOKUP_MCP_TOOLS.map(() => "?").join(", ")})))
        OR ${a2a})
    GROUP BY protocol
  `).all(...tp, ...vp, ...AI_LOOKUP_MCP_TOOLS, ...(a2a === "0" ? [] : A2A_REQUEST_METHODS)) as Array<{ protocol: string; n: number }>;
  let mcp = 0;
  let a2aN = 0;
  for (const r of rows) {
    if (r.protocol === "mcp") mcp += r.n;
    else if (r.protocol === "a2a") a2aN += r.n;
  }
  return { mcp, a2a: a2aN, total: mcp + a2aN };
}
