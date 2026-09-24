/**
 * MCP `/mcp` (RFB) rate limiting — dev-request
 * 2026-09-24-mcp-rate-limit-og-personvern-sannhet, track C1.
 *
 * RFB's `/mcp` endpoint had NO limiter at all — unlike its siblings: dental's
 * `dentalLimiter`, opplevagent's/`/a2a`'s `jsonRpcLimiter`, `/api`'s
 * `generalLimiter` (all in middleware/security.ts). `lokal_cart_submit`
 * could be called in a tight loop and send a real seller-notification email
 * to an opt-in producer on every call.
 *
 * Three limiters, stacked (mounted together on `/mcp` in src/index.ts, in
 * this order):
 *
 *  1. mcpIpEmergencyBrakeLimiter — pure IP key, high ceiling. Real ChatGPT/
 *     Claude traffic comes from a small, shared pool of outbound IPs (review
 *     S-02) — a plain per-IP quota sized like a normal per-caller quota would
 *     wrongly bucket many unrelated end-users together and rate-limit them
 *     as one. This is a defence-in-depth circuit breaker against extreme
 *     abuse from a single address, NOT the primary quota — the acceptance
 *     bar is "≥20 concurrent legitimate sessions from one shared IP are
 *     never affected by this", so its ceiling is set well above what that
 *     produces.
 *  2. mcpPrimaryLimiter — the actual per-caller quota. Keyed in priority
 *     order: `Mcp-Session-Id` header -> `X-API-Key` header -> IP
 *     (mcpPrimaryKey below). A single session's burst only exhausts ITS OWN
 *     bucket, so a brand-new session — even from the very same IP — is
 *     unaffected, which is exactly the acceptance-criteria shape ("a burst
 *     on session A gets 429; a fresh session B from the same IP does not").
 *     Same keyed/anonymous ceiling and window as the sibling jsonRpcLimiter
 *     (security.ts): a caller presenting a recognized `X-API-Key` gets 600
 *     vs 200 per 15 minutes for one with none — `consumerIdentity`
 *     middleware runs earlier in the chain (src/index.ts) and sets
 *     `req.consumerKeyId` before this ever executes, so `keyedMax()` here
 *     is the exact same mechanism, just applied to a differently-keyed
 *     bucket.
 *  3. mcpCartToolLimiter — an additional, stricter, SEPARATE quota for
 *     `tools/call` on `lokal_cart_create` / `lokal_cart_add_item` /
 *     `lokal_cart_submit` specifically — the three tools that can trigger a
 *     real outbound side effect (a seller-notification email on submit, or
 *     simply churn through the DB on create/add). Same numbers as
 *     `cartWishesLimiter` (security.ts), the REST cart's own existing
 *     abuse-shape defense for this exact class of endpoint, reused here
 *     rather than inventing new numbers. Skipped entirely for every other
 *     JSON-RPC call (tools/list, any other tools/call name, initialize, …)
 *     — it never touches `lokal_search`/`lokal_cart_view`/etc traffic.
 *
 * All three respond 429 with a JSON-RPC 2.0 error body (see
 * sendMcpRateLimited below) — a bare HTTP error page would be wrong on a
 * JSON-RPC endpoint. express-rate-limit's own `message` option always sends
 * the SAME static body regardless of the per-request JSON-RPC `id`, so every
 * limiter here overrides `handler` instead of `message`.
 *
 * Non-goals (see the dev-request): dentalLimiter and jsonRpcLimiter
 * (dental/opplevagent/`/a2a`) are untouched here — they are today purely
 * IP-keyed (well, IP-vs-consumer-key via keyedMax(), but never
 * session-keyed), which is the same "shared outbound IP" risk this file
 * fixes for RFB. Flagged as a candidate follow-up in the PR description,
 * not changed in this PR (different verticals, out of scope, would grow
 * this diff unnecessarily).
 */

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { Request, Response } from "express";
import { keyedMax } from "./security";

const sharedValidate = { trustProxy: false } as const;

// ─── JSON-RPC 2.0 error body for "rate limited" ─────────────────────────────
// -32000 is the first code in the "reserved for implementation-defined
// server errors" range (-32000 to -32099) the JSON-RPC 2.0 spec sets aside
// for exactly this kind of transport-level condition — the same range
// services/mcp-session-protocol.ts's -32001 ("Session not found") comes
// from, just a different code for a different condition. Echoes the
// caller's own `id` when the body is a single, non-batch JSON-RPC object
// carrying one (string|number) — `null` otherwise (batch request, or no id
// at all), the same "null when we can't say which request this was" the
// JSON-RPC spec itself uses for a top-level parse error.
export function jsonRpcIdFromBody(body: unknown): string | number | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const id = (body as Record<string, unknown>).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

export function sendMcpRateLimited(req: Request, res: Response): void {
  res.status(429).json({
    jsonrpc: "2.0" as const,
    error: { code: -32000, message: "Rate limit exceeded" },
    id: jsonRpcIdFromBody(req.body),
  });
}

// ─── 1. IP emergency brake ───────────────────────────────────────────────────
// Pure IP key, always — never session/consumer-key aware. High ceiling on
// purpose (see file header): this must not trip under ordinary concurrent
// multi-session traffic sharing one outbound IP, only under extreme abuse.
export const mcpIpEmergencyBrakeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
  handler: sendMcpRateLimited,
});

// ─── 2. Primary per-caller quota ─────────────────────────────────────────────
// Mcp-Session-Id -> X-API-Key -> IP, in that priority order — whichever
// identity the request actually carries wins the bucket. Exported so tests
// can exercise the exact key-derivation logic without waiting out the real
// 200/600-per-15-minutes ceilings.
export function mcpPrimaryKey(req: Request): string {
  const sessionIdHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
  if (sessionId) return `sid:${sessionId}`;

  const apiKey = req.header("X-API-Key");
  if (apiKey) return `key:${apiKey}`;

  return `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

export const mcpPrimaryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes — same window as jsonRpcLimiter
  max: keyedMax(200, 600), // same ceiling as jsonRpcLimiter (security.ts)
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  keyGenerator: mcpPrimaryKey,
  handler: sendMcpRateLimited,
});

// ─── 3. Stricter cart-tool quota ──────────────────────────────────────────────
export const CART_SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  "lokal_cart_create",
  "lokal_cart_add_item",
  "lokal_cart_submit",
]);

interface JsonRpcToolCallLike {
  method?: unknown;
  params?: { name?: unknown; arguments?: { buyer_ref?: unknown } };
}

function asToolCallEntries(body: unknown): JsonRpcToolCallLike[] {
  if (Array.isArray(body)) return body as JsonRpcToolCallLike[];
  if (body && typeof body === "object") return [body as JsonRpcToolCallLike];
  return [];
}

// True if this request's JSON-RPC body IS, or (for a batch array) CONTAINS,
// a `tools/call` for one of the three cart-side-effect tools above. A batch
// is a rare/edge shape on this endpoint in practice; treating "any matching
// entry" as a match is a deliberate over-approximation (skip=false, so the
// limiter still checks/increments) — never an under-approximation that
// would let a batched cart call slip through unmetered.
export function isCartSideEffectCall(body: unknown): boolean {
  return asToolCallEntries(body).some(
    (e) =>
      e?.method === "tools/call" &&
      typeof e?.params?.name === "string" &&
      CART_SIDE_EFFECT_TOOLS.has(e.params!.name as string)
  );
}

// ip + buyer_ref — same shape as security.ts's cartBuyerRefKey, but the
// buyer_ref lives in the JSON-RPC tool's `arguments` here, not a header or
// top-level body field. `lokal_cart_create` has no buyer_ref yet (it's the
// call that MINTS one), so that one tool falls back to IP alone — the same
// "open, unauthenticated create endpoint" shape registrationLimiter /
// consumerKeyIssuanceLimiter already defend on their own endpoints.
export function mcpCartToolKey(req: Request): string {
  const ip = ipKeyGenerator(req.ip ?? "");
  const entries = asToolCallEntries(req.body);
  const entry = entries.find((e) => e?.method === "tools/call");
  const buyerRef = entry?.params?.arguments?.buyer_ref;
  return typeof buyerRef === "string" && buyerRef ? `${ip}:${buyerRef}` : ip;
}

export const mcpCartToolLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute — same window as cartWishesLimiter
  max: 20, // same ceiling as cartWishesLimiter (security.ts)
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  keyGenerator: mcpCartToolKey,
  skip: (req) => !isCartSideEffectCall(req.body),
  handler: sendMcpRateLimited,
});
