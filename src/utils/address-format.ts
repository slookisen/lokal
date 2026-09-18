/**
 * Display address line that never repeats a postal code (or postal city) the
 * stored `knowledge.address` string already carries. `agent_knowledge.address`
 * very often holds the full Brreg-style line ("Bergemoveien 42, 4886
 * GRIMSTAD"), so blindly appending `, ${postalCode}` rendered "…, 4886
 * GRIMSTAD, 4886" on ~40 % of profiles (svar-gjennomgang 2026-09-09; Smaken av
 * Grimstad's reply pointed at it). Postal code / city are appended only when
 * the address string does not already contain them.
 *
 * `city` was added 2026-09-18 (dev-request 2026-09-17-rfb-adresselinje-uten-
 * poststed-i-profil-og-epost): the line previously stopped after the postal
 * code even when the postal city (`addressLocality` in the page's own
 * structured data) was known, e.g. "Kvernelandsvegen 580, 4346" instead of
 * "Kvernelandsvegen 580, 4346 Bryne".
 *
 * Shared by the web profile (routes/seo.ts), the MCP tool (routes/mcp.ts)
 * and the conversation service (services/conversation-service.ts) — moved
 * here (2026-09-18, dev-request 2026-09-09-dobbelt-postnummer-mcp-og-
 * samtaletjeneste) so a service module never has to import from a route file.
 */
export function formatAddressLine(
  address: string | null | undefined,
  postalCode?: string | null,
  city?: string | null
): string {
  const addr = (address ?? "").trim();
  const pc = (postalCode ?? "").trim();
  const cityVal = (city ?? "").trim();

  const containsWord = (haystack: string, needle: string): boolean => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^0-9A-Za-zæøåÆØÅ])${escaped}([^0-9A-Za-zæøåÆØÅ]|$)`, "i").test(haystack);
  };

  // Postal code: numeric standalone-token match (existing behavior).
  const pcAlreadyThere = pc ? containsWord(addr, pc) : false;
  // Postal city: case-insensitive whole-word match (Kartverket/Brreg both
  // upper-case it, our stored `city` usually isn't — "GRIMSTAD" vs "Grimstad").
  const cityAlreadyThere = cityVal ? containsWord(addr, cityVal) : false;

  const pcPart = pc && !pcAlreadyThere ? pc : "";
  const cityPart = cityVal && !cityAlreadyThere ? cityVal : "";
  const suffix = [pcPart, cityPart].filter(Boolean).join(" ");

  if (!addr) return suffix;
  if (!suffix) return addr;
  return `${addr}, ${suffix}`;
}
