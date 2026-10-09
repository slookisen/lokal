// ─── Tool calls from AI agents (public, honest count) ───────────────────────
// A2A dev-request 2026-10-09-agentplatform-partnerside. agentplatform.no shows
// how much the three services are actually USED by AI agents. analytics_mcp_calls
// logs every MCP/A2A/agent-card request (mcp-usage-logger.ts), but most rows are
// connection plumbing: initialize, tools/list, notifications/*, ping and the
// registries' server/discover probes. Those say nothing about use.
//
// A "tool call" here is an MCP row whose tool_name is a real tool (tools/call
// records params.name, e.g. "lokal_search"; every JSON-RPC method keeps its own
// name, and all of those contain "/" except initialize and ping), not from our
// own scheduled agents (is_owner), and not from a client that identifies itself
// as a registry/monitoring probe. A2A and agent-card fetches are not counted.
//
// Pure SQL over the passed connection: runs on the off-thread stats worker in
// production (agent-usage.ts), synchronously only for in-memory DBs.

import type Database from "better-sqlite3";

export const AGENT_TOOL_CALL_WINDOW_DAYS = 30;

/** Client names (lower-cased substrings) of registries and uptime monitors that call tools to test servers. */
export const PROBE_CLIENT_MARKERS = ["probe", "mcpbeat", "glama", "smithery", "monitor", "uptime", "healthcheck", "inspector"];

export interface AgentToolCallStats {
  toolCalls: number;
  windowDays: number;
}

function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function computeAgentToolCalls(
  db: Database.Database,
  nowMs: number,
  windowDays: number = AGENT_TOOL_CALL_WINDOW_DAYS,
): AgentToolCallStats {
  const cutoff = sqliteUtc(nowMs - windowDays * 24 * 60 * 60 * 1000);
  const probeSql = PROBE_CLIENT_MARKERS.map(() => "lower(coalesce(client_name, '')) LIKE ?").join(" OR ");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM analytics_mcp_calls
        WHERE protocol = 'mcp'
          AND created_at > ?
          AND (is_owner IS NULL OR is_owner = 0)
          AND tool_name IS NOT NULL
          AND tool_name NOT LIKE '%/%'
          AND tool_name NOT IN ('initialize', 'ping')
          AND NOT (${probeSql})`,
    )
    .get(cutoff, ...PROBE_CLIENT_MARKERS.map((m) => `%${m}%`)) as { n: number } | undefined;
  return { toolCalls: row?.n ?? 0, windowDays };
}
