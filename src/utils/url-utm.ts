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

// ─── Outbound partner links on finn-tannlege.com and opplevagent.no ───
// dev-request 2026-10-16-utgaende-lenker-utm-eller-referrer-policy (S1).
// The sites keep Referrer-Policy: no-referrer (Daniel, beslutning 3=A), so a
// clinic or provider can only see in its own analytics that a visit came from
// us through UTM on the link itself, the way the RFB producer links already
// work. One row per vertical and link type; the page hands it to the unchanged
// addUtmParams:
//   addUtmParams(url, row.source, "referral", row.campaign)
// A new vertical or link type is one row here. Only links to the partner's own
// website use these rows: never booking URLs (a booking engine's signed URL
// can break), directory or «Kilde:» links, JSON-LD, or MCP/A2A/REST payloads.
export interface OutboundUtmRow {
  readonly source: string;
  readonly campaign: string;
}

export const OUTBOUND_UTM = {
  dental: {
    // «Hjemmeside» on /klinikk/<slug>
    clinic_profile: { source: "finn-tannlege", campaign: "clinic_profile" },
  },
  opplevagent: {
    // /opplevelse/<slug> and /tilbyder/<slug>
    provider_profile: { source: "opplevagent", campaign: "provider_profile" },
    // /kategori/gardssalg/produsent/<slug>
    gardssalg_profile: { source: "opplevagent", campaign: "gardssalg_profile" },
  },
} as const satisfies Record<string, Record<string, OutboundUtmRow>>;

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
  "Perplexity": "perplexity",
};

export function aiSourceFromClient(clientIdentity?: string): string {
  if (!clientIdentity) return "ai_assistant";
  return AI_CLIENT_TO_UTM_SOURCE[clientIdentity] ?? "ai_assistant";
}

/** The transport a link travelled through to the AI client (utm_medium). */
export type AiUtmMedium = "mcp" | "a2a" | "api";

// Tag a URL emitted by MCP/A2A/REST responses to AI clients with AI-source UTM params.
// utm_medium = "mcp" | "a2a" | "api" (the protocol the URL travelled through to the user)
// utm_campaign = "ai_search" (the funnel category)
// Falls back to "ai_assistant" if the client wasn't identified.
// Honors addUtmParams' rule of not squatting on producer-set utm_source.
export function addAiUtmParams(url: string, clientIdentity?: string, medium: AiUtmMedium = "mcp"): string {
  return addUtmParams(url, aiSourceFromClient(clientIdentity), medium, "ai_search");
}

/**
 * Which AI client sent a request, from its User-Agent and Origin (the
 * detectMcpClient rules of routes/mcp.ts, which calls this). Returns a key of
 * AI_CLIENT_TO_UTM_SOURCE, or undefined.
 */
export function detectAiClient(userAgent?: string | null, origin?: string | null): string | undefined {
  const ua = String(userAgent || "").toLowerCase();
  const o = String(origin || "").toLowerCase();
  if (ua.includes("chatgpt") || ua.includes("openai") || o.includes("openai") || o.includes("chatgpt")) return "ChatGPT";
  if (ua.includes("claude") || o.includes("claude.ai") || o.includes("anthropic")) return "Claude";
  if (ua.includes("cursor")) return "Cursor";
  if (ua.includes("copilot") || o.includes("github.com")) return "GitHub Copilot";
  if (ua.includes("windsurf")) return "Windsurf";
  if (ua.includes("cline")) return "Cline";
  if (ua.includes("continue")) return "Continue";
  if (ua.includes("python")) return "Python SDK";
  if (ua.includes("node")) return "Node SDK";
  return undefined;
}

/**
 * The AI client of a request from its headers (User-Agent, Origin) and, for
 * MCP, the client name it sent in `initialize`. Perplexity-User is known too.
 */
export function aiClientFromHeaders(
  headers?: Record<string, string | string[] | undefined>,
  clientName?: string | null,
): string | undefined {
  const h = (k: string) => { const v = headers?.[k]; return Array.isArray(v) ? v[0] : v; };
  const ua = h("user-agent");
  return detectAiClient(ua, h("origin"))
    ?? (/perplexity/i.test(ua || "") ? "Perplexity" : undefined)
    ?? (clientName ? detectAiClient(clientName) : undefined);
}

// ─── AI tagging of profile links in responses to AI clients ─────
// dev-request 2026-10-14-klikk-fra-ai-svar-per-profil, slice 3 («Merking»).
// Used ONLY at the transport boundary (MCP tool results, A2A answers, REST
// answers to ai_search clients — middleware/ai-profile-links.ts), never in the
// shared link builders (clinicProfileUrl, producerContact, findOffers, …),
// which also feed canonical, JSON-LD, sitemaps, e-mails and pages.

const OWN_PROFILE_HOSTS = ["rettfrabonden.com", "finn-tannlege.com", "opplevagent.no"];
// A profile page on one of the three sites, with an optional language prefix.
// Sub-pages (/produsent/<slug>/vcard …) are not profile pages.
const PROFILE_PATH_RE = /^(?:\/(?:en|sv))?\/(?:produsent\/[^/]+|klinikk\/(?:id\/)?[^/]+|opplevelse\/[^/]+|tilbyder\/[^/]+|kategori\/gardssalg\/produsent\/[^/]+)\/?$/;

function ownProfileHosts(): string[] {
  const hosts = [...OWN_PROFILE_HOSTS];
  for (const v of [process.env.BASE_URL, process.env.DENTAL_BASE_URL, process.env.APP_URL]) {
    if (!v) continue;
    try { hosts.push(new URL(v).hostname.toLowerCase()); } catch { /* not a URL */ }
  }
  return hosts;
}

/** True when `url` is a profile page on one of our own sites (a link we may tag for AI). */
export function isOwnProfileUrl(url: string, hosts: string[] = ownProfileHosts()): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  return PROFILE_PATH_RE.test(parsed.pathname);
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>()[\]{}\\`|^]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?*_~]+$/;

function tagProfileLinksInString(s: string, clientIdentity: string | undefined, medium: AiUtmMedium, hosts: string[]): string {
  if (!s.includes("http")) return s;
  return s.replace(URL_IN_TEXT_RE, (match) => {
    const tail = TRAILING_PUNCT_RE.exec(match)?.[0] ?? "";
    const url = tail ? match.slice(0, -tail.length) : match;
    if (!isOwnProfileUrl(url, hosts)) return match;
    return addAiUtmParams(url, clientIdentity, medium) + tail;
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Every link to one of our profile pages in `value` (a string, or a JSON-like
 * object/array walked deeply: text parts, profile_url fields, markdown) gets
 * addAiUtmParams(url, clientIdentity, medium). Returns a new value; the input
 * is not changed. Links that already carry utm_source are left alone, as are
 * other URLs (Stripe, producer websites, terms, vCard …), `canonical*` fields
 * and JSON-LD objects (`@context`).
 */
export function tagAiProfileLinks<T>(value: T, clientIdentity: string | undefined, medium: AiUtmMedium): T {
  const hosts = ownProfileHosts();
  // Each object/array is copied once (memo): shared references and cycles cost
  // linear time, and a cycle in the input becomes the same cycle in the copy.
  const copies = new Map<object, unknown>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return tagProfileLinksInString(v, clientIdentity, medium, hosts);
    if (depth > 40 || v === null || typeof v !== "object") return v;
    if (copies.has(v)) return copies.get(v);
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      copies.set(v, out);
      for (const x of v) out.push(walk(x, depth + 1));
      return out;
    }
    if (isPlainObject(v)) {
      if ("@context" in v) return v;
      const out: Record<string, unknown> = {};
      copies.set(v, out);
      for (const [k, x] of Object.entries(v)) {
        out[k] = /canonical/i.test(k) || k === "@id" ? x : walk(x, depth + 1);
      }
      return out;
    }
    return v;
  };
  return walk(value, 0) as T;
}

/**
 * `path` with the request's own query string kept (a 301 from an old or
 * renamed profile URL must not drop utm_* marks). Only for a same-origin
 * path we built ourselves ("/x", never "//x"); the query is taken as sent.
 */
export function withRequestQuery(path: string, originalUrl: string | undefined): string {
  if (!/^\/(?![/\\])/.test(path) || path.includes("?")) return path;
  const i = (originalUrl || "").indexOf("?");
  if (i < 0) return path;
  const query = (originalUrl || "").slice(i + 1).split("#")[0];
  return query ? `${path}?${query}` : path;
}
