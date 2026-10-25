/**
 * internal-traffic.ts — is a request our own traffic?
 *
 * Moved here from conversation-service.ts (A2A dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-Z) so analytics-service.ts
 * can apply the same rules to page views and searches: conversation-service
 * imports the registry graph, which imports analytics-service back.
 * conversation-service.ts re-exports everything here, so its importers are
 * unchanged. Import-free.
 */

// ─── Internal-traffic classification (rfb-samtaler item 3) ───────────────────
// Public /samtaler counters must report EXTERNAL traffic only. A conversation
// is "internal" when it originates from OUR OWN tooling talking to itself:
// verifier probes, loop-dispatcher / fleet runs, health checks, and owner /
// admin / CI requests. We classify CONSERVATIVELY on purpose — a FALSE POSITIVE
// (flagging real external traffic as internal) HIDES real traffic, the exact
// opposite of this feature's goal — so we only flag on signals no third party
// could plausibly emit, and err toward NOT flagging when unsure.
//
// The EXACT rules (all evaluated at write-time from the live HTTP request):
//   1. hasValidAdminKey — the request carried an `X-Admin-Key` header whose
//      value equals our secret ADMIN_KEY / ANALYTICS_ADMIN_KEY. The key is a
//      secret, so a match is definitively our own CI / admin / fleet tooling.
//   2. ownerCookie — the `_rfb_owner=1` cookie our own owner/dev browser sets
//      (the same marker analytics-service uses to strip owner traffic).
//   3. Own-only User-Agent markers — UA substrings only OUR scheduled probes
//      emit: RFB-* (e.g. RFB-ContactVerifier, RFB-HealthCheck), Lokal-* tools,
//      and explicit verifier / loop-dispatcher / fleet / health-check tokens.
//
// DELIBERATELY NOT treated as internal: generic HTTP-client UAs (curl/,
// node-fetch, axios/, python-requests, bare "node" / "python"). External
// A2A / MCP / API agents legitimately use those clients, so flagging them would
// hide large amounts of REAL external traffic. (analytics-service treats those
// as "owner" for its dashboard, but here the cost of a false positive is higher
// — it undermines the trust the page exists to build — so we exclude them and
// accept the resulting false-negatives, which are the safe direction.)
const INTERNAL_UA_MARKERS_LC = [
  "rfb-",                 // RFB-ContactVerifier, RFB-HealthCheck, other RFB-* probes
  "lokal-enricher",
  "lokal-verifier",
  "lokal-agent-verifier",
  "loop-dispatcher",
  "loop-dispatch",
  "fleet-agent",
  "fleet-runner",
  "health-check",
  "healthcheck",
  // The session lane's read-only verification probes, «session-lane-verify/1.0
  // (read-only)» (slice I-Z). Without it their A2A checks of Finn-tannlege on
  // 2026-10-17 were counted as AI lookups.
  "session-lane-verify",
];

export interface RequestMeta {
  userAgent?: string;
  hasValidAdminKey?: boolean;
  ownerCookie?: boolean;
}

function expectedAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

// Extract the classification-relevant signals from an Express-style request.
// Kept structural (no express import) so it is trivially unit-testable and can
// be reused by both the conversation-creation callers and the /samtaler
// admin-view gate. Never throws on a malformed/absent request.
export function buildRequestMeta(
  req: { headers?: Record<string, any> } | undefined | null
): RequestMeta {
  if (!req || !req.headers) return {};
  const headers = req.headers;
  const userAgent = typeof headers["user-agent"] === "string" ? headers["user-agent"] : undefined;
  const expected = expectedAdminKey();
  const provided = typeof headers["x-admin-key"] === "string" ? headers["x-admin-key"] : "";
  const hasValidAdminKey = !!expected && provided === expected;
  const cookie = typeof headers["cookie"] === "string" ? headers["cookie"] : "";
  const ownerCookie = cookie.split(";").some((c: string) => c.trim() === "_rfb_owner=1");
  return { userAgent, hasValidAdminKey, ownerCookie };
}

// Conservative internal-traffic classifier. Returns true ONLY when confident.
export function isInternalTraffic(meta?: RequestMeta | null): boolean {
  if (!meta) return false;
  if (meta.hasValidAdminKey) return true;   // secret key matched → definitely us
  if (meta.ownerCookie) return true;        // owner / dev browser
  const ua = (meta.userAgent || "").toLowerCase();
  if (ua && INTERNAL_UA_MARKERS_LC.some(m => ua.includes(m))) return true;
  return false;
}
