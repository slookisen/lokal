/**
 * Upper bounds on MCP tool input (GHSA-46jr-4wx8-v453: one oversized request
 * could exhaust memory during validation). The SDK leaves
 * `maxToolInputElements` off by default, so every McpServer sets it explicitly.
 *
 * Largest legitimate use today: lokal_find_offers with a shopping list of a
 * dozen items; lokal_discover with at most ~11 categories. The element budget
 * counts array items AND object keys across the whole argument tree.
 *
 * The list caps (MCP_MAX_FILTER_LIST, MCP_MAX_SHOPPING_ITEMS) are checked in
 * the lokal_discover / lokal_find_offers handlers, not with `.max()` in their
 * inputSchema: `.max()` adds maxItems to tools/list, and the Rett fra Bonden
 * MCP contract is frozen while OpenAI reviews the ChatGPT app
 * (tests/fixtures/rfb-mcp-contract-freeze.json).
 */

/** Per tools/call: array items + object keys. Real calls use < 40. */
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 200;

/** `categories` / `tags` in lokal_discover (only ~11 categories / 5 tags exist). */
export const MCP_MAX_FILTER_LIST = 20;

/** `items` in lokal_find_offers (a shopping list; real lists are < 20). */
export const MCP_MAX_SHOPPING_ITEMS = 50;

/**
 * The isError result of a tool call whose list input `field` has more than
 * `max` entries (NO / EN). The handler returns it before it reads the list.
 */
export function mcpListTooLongResult(field: string, max: number, sent: number) {
  return {
    content: [{
      type: "text" as const,
      text: `\`${field}\` kan ha høyst ${max} verdier, men fikk ${sent}. / \`${field}\` takes at most ${max} values, but got ${sent}.`,
    }],
    isError: true as const,
  };
}
