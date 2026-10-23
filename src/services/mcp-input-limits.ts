/**
 * Upper bounds on MCP tool input (GHSA-46jr-4wx8-v453: one oversized request
 * could exhaust memory during validation). The SDK leaves
 * `maxToolInputElements` off by default, so every McpServer sets it explicitly.
 *
 * Largest legitimate use today: lokal_find_offers with a shopping list of a
 * dozen items; lokal_discover with at most ~11 categories. The element budget
 * counts array items AND object keys across the whole argument tree.
 */

/** Per tools/call: array items + object keys. Real calls use < 40. */
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 200;

/** `categories` / `tags` in lokal_discover (only ~11 categories / 5 tags exist). */
export const MCP_MAX_FILTER_LIST = 20;

/** `items` in lokal_find_offers (a shopping list; real lists are < 20). */
export const MCP_MAX_SHOPPING_ITEMS = 50;
