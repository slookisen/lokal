/**
 * Discovery Routes — All agent/AI/LLM discovery endpoints
 *
 * These routes make rettfrabonden.com discoverable by:
 *   1. LLMs (ChatGPT, Claude, Perplexity) via /llms.txt and /llms-full.txt
 *   2. MCP clients via /.well-known/mcp/server-card.json
 *   3. Future IETF agents via /.well-known/agents.txt
 *   4. OpenAPI/Swagger consumers via /openapi.json
 *
 * Why a separate file? seo.ts handles human-facing HTML pages.
 * This file handles machine-facing discovery documents.
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=discovery.d.ts.map