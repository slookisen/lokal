/**
 * MCP / A2A / agent-card usage logging.
 *
 * dev-request 2026-07-21-analytics-tre-boetter-mcp-logging-a2a-transparens,
 * Slice B: "hvilke verktøy gir mest, og hvem bruker oss mest" — a dedicated,
 * additive `analytics_mcp_calls` table (see database/init.ts) separate from
 * the existing page-view/search tables, filled by the middlewares below.
 *
 * Hard requirement (acceptance B1): logging is purely observational and
 * MUST NEVER change or delay the actual JSON-RPC response. Every insert
 * runs off `res.on("finish")` (after the real handler has already sent its
 * response) and is wrapped in try/catch, mirroring the existing
 * trackPageView/trackSearchQuery pattern in analytics-service.ts.
 */

import { Request, Response, NextFunction } from "express";
import { getDb } from "../database/init";
import { parseUserAgent, isOwnerRequest, hashIP, type VerticalId } from "./analytics-service";

export type McpUsageProtocol = "mcp" | "a2a" | "agent_card";

interface JsonRpcLikeEntry {
  method?: unknown;
  params?: unknown;
}

interface UsageRow {
  protocol: McpUsageProtocol;
  vertical: VerticalId;
  toolName: string | null;
  clientName: string | null;
  clientVersion: string | null;
  userAgent: string;
  ipHash: string;
  durationMs: number;
  isOwner: boolean;
}

// tools/call carries the actual tool in params.name; every other JSON-RPC
// method (initialize, tools/list, message/send, tasks/get, …) is recorded
// under its own method name so "which verktøy gir mest" also surfaces
// non-tool-call traffic instead of collapsing it to null.
function toolNameFor(entry: JsonRpcLikeEntry): string | null {
  const method = typeof entry.method === "string" ? entry.method : null;
  if (!method) return null;
  if (method === "tools/call") {
    const params = entry.params as { name?: unknown } | undefined;
    return typeof params?.name === "string" ? params.name : method;
  }
  return method;
}

// clientInfo is only ever present on an MCP `initialize` call — every later
// tools/call in the same session carries no client identity of its own, so
// callers fall back to the UA-derived name (see mcpUsageLogger below).
function clientInfoFor(entry: JsonRpcLikeEntry): { name: string | null; version: string | null } {
  const params = entry.params as { clientInfo?: { name?: unknown; version?: unknown } } | undefined;
  const info = params?.clientInfo;
  return {
    name: typeof info?.name === "string" ? info.name : null,
    version: typeof info?.version === "string" ? info.version : null,
  };
}

function insertUsageRow(row: UsageRow): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO analytics_mcp_calls
        (protocol, vertical_id, tool_name, client_name, client_version, user_agent, ip_hash, duration_ms, is_owner)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.protocol,
      row.vertical,
      row.toolName,
      row.clientName,
      row.clientVersion,
      row.userAgent,
      row.ipHash,
      row.durationMs,
      row.isOwner ? 1 : 0,
    );
  } catch (err) {
    console.error("[mcp-usage-logger] Failed to log usage:", err);
  }
}

/**
 * Express middleware — mount BEFORE the MCP/A2A router for a vertical.
 * Reads the already-parsed JSON-RPC body (express.json() runs earlier in
 * the middleware stack; peeking at req.body here doesn't consume the
 * request stream, so the SDK transport / router downstream sees it
 * unchanged). Logs one row per JSON-RPC request object in the body
 * (single object, or an array for a JSON-RPC batch).
 */
export function mcpUsageLogger(protocol: "mcp" | "a2a", vertical: VerticalId) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST") return next();

    const body: unknown = req.body;
    const candidates: JsonRpcLikeEntry[] = Array.isArray(body)
      ? (body as JsonRpcLikeEntry[])
      : body && typeof body === "object"
        ? [body as JsonRpcLikeEntry]
        : [];
    const requestEntries = candidates.filter((e) => typeof e?.method === "string");
    if (requestEntries.length === 0) return next();

    const startTime = Date.now();
    res.on("finish", () => {
      try {
        const durationMs = Date.now() - startTime;
        const userAgent = req.get("user-agent") || "";
        const ipHash = hashIP(req.ip || "unknown");
        const isOwner = isOwnerRequest(req);
        const uaClientName = parseUserAgent(userAgent).clientName || null;

        for (const entry of requestEntries) {
          const initInfo = clientInfoFor(entry);
          insertUsageRow({
            protocol,
            vertical,
            toolName: toolNameFor(entry),
            clientName: initInfo.name || uaClientName,
            clientVersion: initInfo.version,
            userAgent,
            ipHash,
            durationMs,
            isOwner,
          });
        }
      } catch (err) {
        // Never let a logging bug surface as a request-handling error —
        // the response has already been sent by this point regardless.
        console.error("[mcp-usage-logger] finish handler failed:", err);
      }
    });

    next();
  };
}

/**
 * One-shot logger for GET /.well-known/agent-card.json fetches — no
 * JSON-RPC body to parse, just protocol='agent_card' + client identity.
 */
export function agentCardUsageLogger(vertical: VerticalId) {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    res.on("finish", () => {
      try {
        const userAgent = req.get("user-agent") || "";
        insertUsageRow({
          protocol: "agent_card",
          vertical,
          toolName: null,
          clientName: parseUserAgent(userAgent).clientName || null,
          clientVersion: null,
          userAgent,
          ipHash: hashIP(req.ip || "unknown"),
          durationMs: Date.now() - startTime,
          isOwner: isOwnerRequest(req),
        });
      } catch (err) {
        console.error("[mcp-usage-logger] agent-card finish handler failed:", err);
      }
    });
    next();
  };
}
