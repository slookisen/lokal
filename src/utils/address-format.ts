/**
 * Display address line that never repeats a postal code the stored
 * `knowledge.address` string already carries. `agent_knowledge.address` very
 * often holds the full Brreg-style line ("Bergemoveien 42, 4886 GRIMSTAD"),
 * so blindly appending `, ${postalCode}` rendered "…, 4886 GRIMSTAD, 4886"
 * on ~40 % of profiles (svar-gjennomgang 2026-09-09; Smaken av Grimstad's
 * reply pointed at it). Postal code is appended only when the address
 * string does not already contain it as a standalone number.
 *
 * Shared by the web profile (routes/seo.ts), the MCP tool (routes/mcp.ts)
 * and the conversation service (services/conversation-service.ts) — moved
 * here (2026-09-18, dev-request 2026-09-09-dobbelt-postnummer-mcp-og-
 * samtaletjeneste) so a service module never has to import from a route file.
 */
export function formatAddressLine(address: string | null | undefined, postalCode?: string | null): string {
  const addr = (address ?? "").trim();
  const pc = (postalCode ?? "").trim();
  if (!pc) return addr;
  if (!addr) return pc;
  const escaped = pc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alreadyThere = new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`).test(addr);
  return alreadyThere ? addr : `${addr}, ${pc}`;
}
