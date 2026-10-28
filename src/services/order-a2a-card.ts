/**
 * The agent-card side of Fase B3 (dev-request 2026-10-21-rfb-mine-ordrer-
 * ett-klikk-og-kjoperagent): the "manage-pickup-order" skill and the JSON-RPC
 * method list of RFB's two A2A cards (GET /a2a in routes/a2a.ts and
 * marketplaceRegistry.getRegistryCard). Only while ORDER_AGENT_ACTIONS_ENABLED
 * is on; off, both cards are byte-identical to before.
 *
 * PURE apart from the env switch (its only import is the zero-import flag
 * module), so marketplace-registry.ts keeps its rfb-vertical isolation rule.
 */

import { isOrderAgentActionsEnabled } from "./order-agent-actions-flag";

export { isOrderAgentActionsEnabled };

/** The agent-card skill for the order task (both RFB cards, only while the switch is on). */
export function managePickupOrderSkill(): Record<string, unknown> {
  return {
    id: "manage-pickup-order",
    name: "Manage a pickup order / Følg og avbestill en henteordre",
    description: "Follow and cancel a pickup order placed with the MCP tool lokal_cart_submit, as an A2A task. " +
      "tasks/get with id 'order:<order_id>' and metadata {buyer_ref} returns the order as a Task: " +
      "pending → submitted, confirmed/ready → working, completed → completed, declined/cancelled → canceled, " +
      "with stateTransitionHistory and the order detail as a data artifact. " +
      "tasks/cancel on the same id withdraws a pending order at no cost; once the producer has confirmed it, " +
      "cancelling is a binding cancellation under the Norwegian Consumer Purchases Act § 41 (metadata.cancellation.consumer_law_note says what applies). " +
      "Only cancel on the user's explicit instruction; pass the action you showed the user as metadata.expected_action ('withdraw' or 'cancel'). " +
      "Wrong buyer_ref or unknown order: error -32001. No push notifications. " +
      "Følg og avbestill en henteordre som A2A-task.",
    tags: ["order", "pickup", "cancel", "task status", "bestilling", "henting", "avbestill"],
    inputModes: ["application/json"],
    outputModes: ["application/json"],
    examples: [
      "tasks/get {id: \"order:<order_id>\", metadata: {buyer_ref: \"<buyer_ref>\"}}",
      "tasks/cancel {id: \"order:<order_id>\", metadata: {buyer_ref: \"<buyer_ref>\", expected_action: \"withdraw\"}}",
    ],
  };
}

/** The JSON-RPC methods both RFB cards list; tasks/cancel only while the switch is on. */
export function rfbJsonRpcMethods(env: NodeJS.ProcessEnv = process.env): string[] {
  return isOrderAgentActionsEnabled(env)
    ? ["message/send", "tasks/get", "tasks/list", "tasks/cancel", "agent/authenticatedExtendedCard"]
    : ["message/send", "tasks/get", "tasks/list", "agent/authenticatedExtendedCard"];
}
