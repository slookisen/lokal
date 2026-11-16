/**
 * mcp-stale-id-recovery.ts — F1-3 (A2A dev-request
 * 2026-11-12-f1-felles-for-ai-kanalene): a request that carries an
 * `mcp-session-id` this process does not know is answered, not rejected,
 * when every message in it is a stateless request.
 *
 * Why: the MCP session maps in src/routes/mcp.ts, dental-mcp.ts and
 * experiences-mcp.ts live in memory, so every Fly deploy forgets every id.
 * The spec tells a client to re-run `initialize` after a 404, but the
 * TypeScript SDK client (1.32.1, client/streamableHttp.js `send()`) throws
 * `StreamableHTTPError(404)` and keeps the stale id, and several hosts are
 * reported not to re-initialize either. The assistant then shows the user an
 * error after each deploy.
 *
 * What: for `tools/list`, `tools/call`, `ping` and the read-only
 * resources/prompts listings, the router builds a fresh McpServer with the
 * same tools and serves the request through a transport with session
 * management off (`sessionIdGenerator: undefined`). Nothing is stored in the
 * session map, no `Mcp-Session-Id` header is sent back, and the client's id is
 * never adopted. Every other message with an unknown id (notifications,
 * subscriptions, GET streams) still gets the existing 404 from
 * mcp-session-protocol.ts, and `initialize` still mints the server's own id.
 *
 * An id this process ended itself (DELETE by the client, or the 30-minute
 * idle sweep) is remembered in `TerminatedMcpIds` and keeps its 404, as the
 * spec requires for a terminated session. Only an id this process never
 * issued, which after a deploy means one issued by the previous machine, is
 * answered without a session.
 *
 * The tools on these three servers keep no per-session state (carts and
 * bookings are keyed by their own ids in the database), so a request served
 * this way gives the same answer a live session would.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";

/** The JSON-RPC methods that need no state from `initialize` or an earlier call. */
export const MCP_STATELESS_METHODS: ReadonlySet<string> = new Set([
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
]);

/** True if the body is a request, or a non-empty batch of requests, using only stateless methods. */
export function isMcpStatelessRequestBody(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return false;
  return messages.every((m) => isJSONRPCRequest(m) && MCP_STATELESS_METHODS.has(m.method));
}

/**
 * The ids this process ended (DELETE or idle sweep), kept so a later request
 * with one of them still gets the 404. Bounded: at most `maxEntries` ids, each
 * kept for `keepMs`; the oldest is dropped first.
 */
export class TerminatedMcpIds {
  private readonly ids = new Map<string, number>();

  constructor(
    private readonly maxEntries = 20_000,
    private readonly keepMs = 24 * 60 * 60 * 1000,
  ) {}

  add(id: string, now: number = Date.now()): void {
    this.ids.delete(id);
    this.ids.set(id, now);
    while (this.ids.size > this.maxEntries) {
      const oldest = this.ids.keys().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }

  has(id: string, now: number = Date.now()): boolean {
    const at = this.ids.get(id);
    if (at === undefined) return false;
    if (now - at > this.keepMs) {
      this.ids.delete(id);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.ids.size;
  }
}

/**
 * True when the router should answer without a session: an id was sent, this
 * process neither holds it nor ended it, and the body is stateless. A request
 * with no id at all is left to the existing handling.
 */
export function shouldServeUnknownMcpIdStateless(
  sessionId: string | undefined,
  isKnownToThisProcess: (id: string) => boolean,
  body: unknown,
): boolean {
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  if (isKnownToThisProcess(sessionId)) return false;
  return isMcpStatelessRequestBody(body);
}

/**
 * Serves one request on `server` through a transport with session management
 * off, then closes both when the response ends. `server` must be a new
 * instance; it is used for this one request only.
 */
export async function serveMcpRequestWithoutSession(
  server: McpServer,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void server.close().catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
