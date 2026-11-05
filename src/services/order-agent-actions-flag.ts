/**
 * ORDER_AGENT_ACTIONS_ENABLED — the switch for the buyer's agent actions on
 * a pickup order (dev-request 2026-10-21-rfb-mine-ordrer-ett-klikk-og-
 * kjoperagent): Fase B1/B2 MCP tools and the Fase B3 A2A order task. Default
 * off. PURE (zero imports), so pure modules such as marketplace-registry.ts
 * can read it; buyer-order-actions.ts re-exports it unchanged.
 */

/** Default off. On: the MCP tools are listed and callable, and lokal_order_status carries the B1 fields. */
export const ORDER_AGENT_ACTIONS_FLAG = "ORDER_AGENT_ACTIONS_ENABLED";

export function isOrderAgentActionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[ORDER_AGENT_ACTIONS_FLAG];
  return v === "1" || v === "true";
}
