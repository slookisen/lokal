// ─── Which MCP protocol era do we actually speak? ───────────────────
//
// dev-requests/2026-07-13-mcp-2026-spec-server-card.md, criterion 3:
// «server.json/Official MCP Registry-, Smithery- og Glama-oppføringer
//  oppdatert til å referere ny spec/remotes.»
//
// ── WHY THIS EXISTS NOW ─────────────────────────────────────────────
//
// The 2026-07-28 spec went Current on 2026-07-28 (authoritative check:
// schema/2026-07-28/schema.ts on the spec repo's main declares
// LATEST_PROTOCOL_VERSION = "2026-07-28"; the docs site's own version banner
// disagrees with its body text, so the banner is not usable as a signal).
//
// That revision removes the `initialize` handshake entirely in favour of
// per-request `_meta`, and adds a mandatory `server/discover` RPC. There is no
// fall-forward: a client built for that era cannot talk to a handshake server,
// and vice versa. Measured against our own live prod on 2026-07-29:
//
//   initialize, protocolVersion 2025-06-18   -> 200, negotiates 2025-06-18
//   initialize, protocolVersion 2026-07-28   -> 200, negotiates 2025-11-25
//   tools/list with _meta, NO handshake      -> -32000 "Server not initialized"
//   server/discover                          -> -32000 "Server not initialized"
//
// So we are a handshake-era server, and we will be until the SDK ships support
// (criterion 1, still blocked: @modelcontextprotocol/sdk latest is 1.30.0,
// published 2026-07-27T17:56Z — before the spec went Current — and its
// dist/esm/types.js is byte-identical to 1.29.0's).
//
// ── THE ACTUAL DEFECT THIS CLOSES ───────────────────────────────────
//
// None of that was DISCOVERABLE. Measured on all three live domains the same
// day: `/.well-known/mcp/server-card.json` carries **no protocolVersion field
// at all**, and `/.well-known/mcp` advertised `2025-06-18` — the FLOOR of what
// we support, not the ceiling, which is 2025-11-25.
//
// An agent reading our card therefore cannot tell which era we speak. Its only
// way to find out is to connect and receive -32000. For a platform whose whole
// claim is being the best-discoverable MCP surface in Norway, "connect and
// fail" is the wrong answer to a question the card exists to answer.
//
// ── WHY IT IS DERIVED AND NOT WRITTEN DOWN ──────────────────────────
//
// Everything here comes from the SDK's own constants. A hardcoded string is how
// `/.well-known/mcp` came to advertise 2025-06-18 long after the SDK had moved
// to 2025-11-25: it was true when someone typed it, and nothing made it false
// out loud when it stopped being true. Deriving it means the claim cannot drift
// from the code, and the day criterion 1's SDK lands, every discovery surface
// updates itself with no further edit.

import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

/**
 * The first revision of the handshake-free era: `initialize` is gone, version
 * and capabilities move into per-request `_meta`, and `server/discover` becomes
 * mandatory.
 *
 * A date literal is unavoidable here — it names an external revision, not a
 * fact about us. It is used ONLY as a comparison boundary; nothing reads it as
 * a claim about what we support.
 */
export const MCP_MODERN_ERA_FIRST_VERSION = "2026-07-28";

export type McpEra = "handshake" | "modern";

/**
 * MCP protocol versions are ISO dates, so lexicographic order IS chronological
 * order. That holds for every revision published so far and for the scheme
 * itself, which is defined as a date stamp.
 */
export function eraOf(protocolVersion: string): McpEra {
  return protocolVersion >= MCP_MODERN_ERA_FIRST_VERSION ? "modern" : "handshake";
}

export interface McpProtocolDeclaration {
  /** The newest version we negotiate — the SDK's own LATEST. */
  protocolVersion: string;
  /** Every version we accept, newest first. */
  supportedProtocolVersions: string[];
  /** Which era `protocolVersion` belongs to. */
  era: McpEra;
  /**
   * Whether we can serve a 2026-07-28-era client. DERIVED — the moment the SDK
   * supports it this flips on its own. Hardcoding it is the whole failure mode
   * this module exists to prevent, in the more dangerous direction: claiming an
   * era we cannot serve sends a modern client into a -32000 we advertised.
   */
  modernEraSupported: boolean;
  /** Plain-language, for a human or an agent reading the card. */
  note: string;
}

export function mcpProtocolDeclaration(): McpProtocolDeclaration {
  const protocolVersion = LATEST_PROTOCOL_VERSION;
  const supported = [...SUPPORTED_PROTOCOL_VERSIONS];
  const modernEraSupported = supported.some((v) => eraOf(v) === "modern");

  return {
    protocolVersion,
    supportedProtocolVersions: supported,
    era: eraOf(protocolVersion),
    modernEraSupported,
    note: modernEraSupported
      ? `Supports the ${MCP_MODERN_ERA_FIRST_VERSION} era (per-request _meta, no initialize handshake) ` +
        `as well as the older handshake transport.`
      : `Handshake transport only: send an \`initialize\` request first. This server does NOT yet ` +
        `support the ${MCP_MODERN_ERA_FIRST_VERSION} era (per-request _meta, server/discover) — a client ` +
        `built for it will receive "Server not initialized". Newest negotiable version: ${protocolVersion}.`,
  };
}
