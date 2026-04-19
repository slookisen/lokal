/**
 * Agent Readiness endpoints
 * ─────────────────────────
 * Implements the emerging set of "well-known" discovery standards that
 * AI agents use to find and understand a site's capabilities:
 *
 *   /.well-known/mcp/server-card.json       (SEP-1649)   — MCP server discovery
 *   /.well-known/mcp.json                   (legacy)
 *   /.well-known/agent-skills/index.json    (v0.2.0)     — Agent Skills index
 *   /.well-known/skills/index.json          (legacy path)
 *   /.well-known/api-catalog                (RFC 9727)   — API catalog linkset
 *   /.well-known/oauth-protected-resource   (RFC 9728)   — declares apiKey auth
 *
 * These are all pure JSON read-only endpoints — no state, no mutations.
 * We keep them in one file so there's a single place to update when any
 * spec moves forward.
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=agent-readiness.d.ts.map