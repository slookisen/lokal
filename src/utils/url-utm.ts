// ─── UTM tagging for outbound producer links ───────────────────
// Single source of truth for attaching UTM query params to producer
// websites we render off-domain. Used by the producer profile page
// and the search API's contact.website field so the producer can see
// — in their own analytics — how much traffic Rett fra Bonden sends
// them. This is a key argument when asking producers to "claim" their
// profile or update their data.
//
// Behavior contract (covered by tests in tests/test.ts):
//   - Append UTM as query params, preserving existing ones
//   - http vs https preserved
//   - Trailing slash preserved on the path
//   - Invalid / unparseable input → return the original string unchanged
//     (never throw, never produce a partial URL)
//   - We never overwrite UTM params the producer already set — if their
//     website link already has utm_source, we leave the entire URL alone
//     (their attribution wins; we don't squat on it)
//
// Why a util and not inline string concat: search.ts and seo.ts both
// emit producer websites, and we want exactly one place that knows
// how to do this. Future call-sites (e.g. CSV exports, agent cards)
// can opt in by importing this.
//
// addAiUtmParams (below) is the inbound-flavored sibling: it tags
// OUR-domain URLs that travel through AI tool responses (MCP/A2A) so
// when ChatGPT/Claude/Cursor surface a producer profile link and the
// user clicks, our analytics knows which AI assistant sourced the visit.
// addUtmParams defaults remain dedicated to outbound producer-website
// tagging.

const DEFAULT_SOURCE = "rettfrabonden";
const DEFAULT_MEDIUM = "referral";
const DEFAULT_CAMPAIGN = "producer_profile";

export function addUtmParams(
  url: string,
  source: string = DEFAULT_SOURCE,
  medium: string = DEFAULT_MEDIUM,
  campaign: string = DEFAULT_CAMPAIGN,
): string {
  if (!url || typeof url !== "string") return url;

  // Require an http(s) prefix — we won't tag mailto:, tel:, javascript:, etc.
  // URL() would otherwise happily parse those and silently change behavior.
  if (!/^https?:\/\//i.test(url)) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url; // malformed — return as-is
  }

  // If the producer already has UTM tags, respect them and don't squat.
  if (parsed.searchParams.has("utm_source")) return url;

  parsed.searchParams.set("utm_source", source);
  parsed.searchParams.set("utm_medium", medium);
  parsed.searchParams.set("utm_campaign", campaign);

  return parsed.toString();
}

// ─── AI-source UTM tagging (PR-83) ─────────────────────────────
// Mapping from detectMcpClient() return values to UTM source slugs.
// Snake_case lower for analytics-friendliness.
const AI_CLIENT_TO_UTM_SOURCE: Record<string, string> = {
  "ChatGPT": "chatgpt",
  "Claude": "claude",
  "Cursor": "cursor",
  "GitHub Copilot": "github_copilot",
  "Windsurf": "windsurf",
  "Cline": "cline",
  "Continue": "continue_dev",
  "Python SDK": "python_sdk",
  "Node SDK": "node_sdk",
};

export function aiSourceFromClient(clientIdentity?: string): string {
  if (!clientIdentity) return "ai_assistant";
  return AI_CLIENT_TO_UTM_SOURCE[clientIdentity] ?? "ai_assistant";
}

// Tag a URL emitted by MCP/A2A tool responses with AI-source UTM params.
// utm_medium = "mcp" (the protocol the URL travelled through to the user)
// utm_campaign = "ai_search" (the funnel category)
// Falls back to "ai_assistant" if the client wasn't identified.
// Honors addUtmParams' rule of not squatting on producer-set utm_source.
export function addAiUtmParams(url: string, clientIdentity?: string): string {
  return addUtmParams(url, aiSourceFromClient(clientIdentity), "mcp", "ai_search");
}
