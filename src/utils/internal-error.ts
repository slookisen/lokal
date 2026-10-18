/**
 * The answer to a request that failed inside a handler, shared by the A2A
 * and MCP surfaces of the three platforms: Rett fra Bonden, Opplevagent and
 * Finn-tannlege.
 *
 * dev-request 2026-10-17-integrasjonstest-oppfolging: the error's own
 * message, SQLite's for one, went to the caller. RFB MCP stopped that first
 * (AI-1, guardToolHandler in routes/mcp.ts), then Finn-tannlege A2A (slice
 * I-Y2), then the rest (slice I-Y3, FUNN a2a-mcp-intern-feiltekst-rest): RFB
 * and Opplevagent A2A, Opplevagent and Finn-tannlege MCP. The caller now
 * gets a generic answer, and the detail is logged with the step that failed,
 * never with the request: MCP tools carry buyer contact details. Each
 * handler binds its own log scope (and, for MCP, its platform's text).
 */

/** Logs a failure inside a handler: «[scope] where failed:» and the error's stack, without the request. */
export function logInternalError(scope: string, where: string, err: unknown): void {
  console.error(`[${scope}] ${where} failed:`, err instanceof Error ? err.stack || err.message : String(err));
}

/** JSON-RPC's generic -32603 "Internal error", with no `data`. The detail is logged (logInternalError). */
export function rpcInternalErrorReply(scope: string, id: unknown, where: string, err: unknown) {
  logInternalError(scope, where, err);
  return { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id };
}

/** The whole text of a failed MCP tool's result, in Norwegian and English, naming the platform. */
export function mcpInternalErrorText(platform: string): string {
  return `Beklager, det oppstod en intern feil hos ${platform}, og forespørselen kunne ikke fullføres. Prøv igjen senere. / ` +
    `Sorry, an internal error at ${platform} stopped this request. Please try again later.`;
}

/** A failed MCP tool's isError result with `text`. The detail is logged with the tool's name, not its arguments. */
export function mcpToolInternalErrorResult(scope: string, text: string, tool: string, err: unknown) {
  logInternalError(scope, tool, err);
  return { content: [{ type: "text" as const, text }], isError: true };
}
