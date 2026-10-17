/**
 * Text entries of a list-valued DB JSON field (specialties, paymentMethods,
 * certifications, labels, agent categories ...): an array gives its string
 * entries, a string gives itself as one entry, anything else gives none.
 *
 * Integration test 2026-10-17: written for the MCP handlers in slice I-A
 * (routes/mcp.ts) and moved here in slice I-F so knowledge-service.ts can use
 * the same rule — a service must not import a route, and mcp.ts imports
 * knowledge-service.ts.
 */
export function textEntries(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : [value];
  return items
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}
