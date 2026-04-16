/**
 * MCP Streamable HTTP Transport — Remote MCP endpoint for ChatGPT & other AI platforms
 *
 * This adds a /mcp endpoint to the Express server that speaks the MCP protocol
 * over Streamable HTTP (the transport ChatGPT, OpenAI Agents SDK, and other
 * remote clients use). Unlike the stdio MCP server (npm package), this runs
 * server-side and calls internal services directly — no HTTP round-trip.
 *
 * Endpoint: POST https://rettfrabonden.com/mcp
 *           GET  https://rettfrabonden.com/mcp  (SSE stream for notifications)
 *           DELETE https://rettfrabonden.com/mcp (session cleanup)
 *
 * ChatGPT Developer Mode: paste https://rettfrabonden.com/mcp as the MCP URL.
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=mcp.d.ts.map