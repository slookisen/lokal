/**
 * mcp-session-protocol.ts — shared, side-effect-free helpers for MCP
 * Streamable-HTTP session handling, used by BOTH src/routes/mcp.ts (rfb) and
 * src/routes/dental-mcp.ts. The two routers each keep their own in-memory
 * session Map and their own McpServer/transport wiring (different tool sets,
 * different session-metadata shapes) — only the small pieces of logic that
 * must behave IDENTICALLY in both places live here.
 *
 * Bug context: an unknown/expired `mcp-session-id` on a non-`initialize`
 * request was silently upgraded into a brand-new, uninitialized session
 * under the client's own id (`const id = sessionId || randomUUID()`),
 * instead of the 404 the MCP spec requires. The new, never-initialized
 * transport instance then rejects the very call that triggered its creation
 * with a misleading `400 "Server not initialized"` — surfaced in production
 * as a Glama false-positive "unhealthy" report right after a Fly deploy
 * wiped the in-memory session map.
 *
 * `MCP_SESSION_NOT_FOUND_BODY` mirrors, byte-for-byte, the JSON-RPC error
 * body the MCP SDK's own transport produces for this exact case
 * (`WebStandardStreamableHTTPServerTransport.validateSession()`:
 * `createJsonErrorResponse(404, -32001, "Session not found")` in
 * `@modelcontextprotocol/sdk/dist/cjs/server/webStandardStreamableHttp.js`)
 * — it is reproduced here rather than reached naturally because our own
 * session-map lookup short-circuits BEFORE the request ever reaches a
 * transport that would otherwise produce it itself.
 */

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * True if the parsed JSON-RPC request body — a single message, or (per the
 * spec) a batch array — is, or contains, an `initialize` request. Mirrors
 * the SDK's own `isInitializationRequest` check
 * (`messages.some(isInitializeRequest)`) so the two routers classify a
 * request as "initialize" exactly the way the transport underneath them
 * eventually would.
 */
export function isMcpInitializeRequestBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((m) => isInitializeRequest(m));
  }
  return isInitializeRequest(body);
}

/**
 * The JSON-RPC error body for "unknown/expired mcp-session-id" — same
 * shape (and `-32001` code) as the MCP SDK's own transport-level "Session
 * not found" 404. Frozen so neither router can accidentally mutate the
 * shared literal.
 */
export const MCP_SESSION_NOT_FOUND_BODY = Object.freeze({
  jsonrpc: "2.0" as const,
  error: Object.freeze({ code: -32001, message: "Session not found" }),
  id: null as null,
});

/**
 * Minimal shape both Express's Response and the test doubles in this
 * repo's route tests satisfy — avoids pulling the full express.Response
 * type into this protocol-only module.
 */
export interface McpSessionErrorResponder {
  status(code: number): { json(body: unknown): unknown };
}

/**
 * Sends the 404 "unknown/expired mcp-session-id" JSON-RPC error response.
 * The caller is responsible for NOT inserting anything into its session
 * map when it takes this branch — this helper only sends the response.
 */
export function sendMcpSessionNotFound(res: McpSessionErrorResponder): void {
  res.status(404).json(MCP_SESSION_NOT_FOUND_BODY);
}
