/**
 * MCP `/mcp` rate limiting for all three verticals.
 *
 *  - RFB — dev-request 2026-09-24-mcp-rate-limit-og-personvern-sannhet,
 *    track C1. RFB's `/mcp` endpoint had NO limiter at all — unlike its
 *    siblings: dental's `dentalLimiter`, opplevagent's/`/a2a`'s
 *    `jsonRpcLimiter`, `/api`'s `generalLimiter` (all in
 *    middleware/security.ts). `lokal_cart_submit` could be called in a tight
 *    loop and send a real seller-notification email to an opt-in producer on
 *    every call.
 *  - Opplevagent + Finn-tannlege — dev-request
 *    2026-10-16-mcp-rate-limit-dental-opplevagent-per-okt, S1 + S2. Their
 *    `/mcp` routers used `jsonRpcLimiter` / `dentalLimiter`: one bucket per
 *    IP, so many users behind one outbound IP (ChatGPT/Claude
 *    infrastructure) shared it — and each of those buckets was shared with
 *    other surfaces too (`jsonRpcLimiter`: RFB `/a2a` + Opplevagent `/a2a`;
 *    `dentalLimiter`: `/api/tannlege` + dental `/a2a`).
 *
 * One factory, createMcpRateLimiters(profile), builds each vertical's chain
 * from its entry in MCP_RATE_LIMIT_PROFILES. Every chain gets its own stores,
 * so no two verticals — and no MCP and A2A/REST surface — share a bucket. A
 * new vertical or a new side-effect tool is a profile entry, not new
 * middleware. Three limiters, stacked in this order:
 *
 *  1. brake — pure IP key, high ceiling. Real ChatGPT/Claude traffic comes
 *     from a small, shared pool of outbound IPs (review S-02) — a plain
 *     per-IP quota sized like a normal per-caller quota would wrongly bucket
 *     many unrelated end-users together and rate-limit them as one. This is
 *     a defence-in-depth circuit breaker against extreme abuse from a single
 *     address, NOT the primary quota — the acceptance bar is "≥20 concurrent
 *     legitimate sessions from one shared IP are never affected by this", so
 *     its ceiling is set well above what that produces.
 *  2. primary — the actual per-caller quota, keyed by mcpPrimaryKey(): the
 *     MCP session, else the caller's recognized consumer key, else the IP. A
 *     single session's burst only exhausts ITS OWN bucket, so a brand-new
 *     session — even from the very same IP — is unaffected ("a burst on
 *     session A gets 429; a fresh session B from the same IP does not"). The
 *     ceiling is keyedMax(anonymousMax, keyedMax) — the same mechanism as
 *     jsonRpcLimiter (security.ts): `consumerIdentity` runs earlier in the
 *     chain (src/index.ts, before the host gates) and sets
 *     `req.consumerKeyId` before this ever executes.
 *  3. sideEffect (optional) — an additional, stricter, SEPARATE quota for
 *     `tools/call` on the profile's side-effect tools only: the tools that
 *     can trigger a real outbound effect (RFB: a seller-notification email
 *     on cart submit, or DB churn on create/add; Opplevagent: the producer
 *     and guest e-mails of book_gardssalg). Skipped entirely for every other
 *     JSON-RPC call (tools/list, any other tools/call name, initialize, …).
 *
 * Where the chains are mounted: RFB's in src/index.ts
 * (`app.use("/mcp", mcpIpEmergencyBrakeLimiter, mcpPrimaryLimiter,
 * mcpCartToolLimiter, …)`, before mcpUsageLogger); Opplevagent's and
 * Finn-tannlege's by their own routers (routes/experiences-mcp.ts,
 * routes/dental-mcp.ts), which index.ts's host gates run AFTER
 * mcpUsageLogger, so their 429s are logged.
 *
 * All limiters respond 429 with a JSON-RPC 2.0 error body (see
 * sendMcpRateLimited below) — a bare HTTP error page would be wrong on a
 * JSON-RPC endpoint. express-rate-limit's own `message` option always sends
 * the SAME static body regardless of the per-request JSON-RPC `id`, so every
 * limiter here overrides `handler` instead of `message`.
 *
 * Non-goals: `/a2a` and REST keep their own limiters — jsonRpcLimiter (RFB +
 * Opplevagent `/a2a`) and dentalLimiter (`/api/tannlege` + dental `/a2a`) are
 * unchanged (S3 of the 2026-10-16 dev-request, not in this change). Counters
 * live in memory, so every deploy resets them, as before.
 */

import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler, type Store } from "express-rate-limit";
import { Request, Response } from "express";
import { keyedMax } from "./security";

// trustProxy: same reason as security.ts's sharedValidate (a static check on
// `trust proxy` === true; the real guard is middleware/client-ip.ts, which
// decides what req.ip, and so every IP key below, is).
// creationStack: the Opplevagent and Finn-tannlege routers — and so their
// chains — are require()d by index.ts's host gates on the first request to
// that host, which express-rate-limit would report as "created in a request
// handler". Each chain is still created exactly once per process.
const sharedValidate = { trustProxy: false, creationStack: false } as const;

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

// ─── Keys ────────────────────────────────────────────────────────────────────
// The IP key every limiter here falls back to: express-rate-limit's own
// default (IPv6 addresses grouped per /56).
export function mcpIpKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? "");
}

// The only shape a live session id has: every server here mints its own
// with crypto.randomUUID() on `initialize` (mcp.ts, dental-mcp.ts,
// experiences-mcp.ts) and never adopts one from the client. Anything else
// in the header names no session — a made-up string, or a 10 KB header that
// would otherwise become a store key as is.
const MCP_SESSION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The primary quota's key, in priority order:
//   1. `sid:<Mcp-Session-Id>` — only for a UUID-shaped id, and, when the
//      router's own `isKnownSession` check is given, only for a session it
//      actually holds. So rotating made-up ids (also on `initialize`, which
//      mints a NEW session whatever id the client sends) never buys a fresh
//      bucket. An expired id (e.g. after a deploy) falls through too: the
//      router answers it with a 404 and the client re-initializes.
//   2. `key:<consumerKeyId>` — a consumer key consumerIdentity RECOGNIZED,
//      the same condition under which keyedMax() grants the keyed ceiling. A
//      raw `X-API-Key` header is never a key: an unknown or made-up one is
//      treated exactly like no key at all, as consumerIdentity does.
//   3. `ip:<ip>`.
// Exported so tests can exercise the exact key derivation without waiting
// out real production ceilings.
export function mcpPrimaryKey(req: Request, isKnownSession?: (sessionId: string) => boolean): string {
  const sessionIdHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
  if (sessionId && MCP_SESSION_ID_SHAPE.test(sessionId) && (!isKnownSession || isKnownSession(sessionId))) {
    return `sid:${sessionId}`;
  }

  if (req.consumerKeyId) return `key:${req.consumerKeyId}`;

  return `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

// ─── Side-effect tool calls ──────────────────────────────────────────────────
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
// a `tools/call` for one of `tools`. A batch is a rare/edge shape on these
// endpoints in practice; treating "any matching entry" as a match is a
// deliberate over-approximation (skip=false, so the limiter still
// checks/increments) — never an under-approximation that would let a
// batched side-effect call slip through unmetered.
export function isSideEffectToolCall(body: unknown, tools: ReadonlySet<string>): boolean {
  return asToolCallEntries(body).some(
    (e) =>
      e?.method === "tools/call" &&
      typeof e?.params?.name === "string" &&
      tools.has(e.params!.name as string)
  );
}

export function isCartSideEffectCall(body: unknown): boolean {
  return isSideEffectToolCall(body, CART_SIDE_EFFECT_TOOLS);
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

// ─── Profiles ────────────────────────────────────────────────────────────────
export type McpLimiterName = "brake" | "primary" | "sideEffect";

export interface McpRateLimitProfile {
  readonly brake: { readonly windowMs: number; readonly max: number };
  readonly primary: { readonly windowMs: number; readonly anonymousMax: number; readonly keyedMax: number };
  readonly sideEffect?: {
    readonly windowMs: number;
    readonly max: number;
    readonly tools: ReadonlySet<string>;
    readonly keyGenerator: (req: Request) => string;
  };
  // The router's own "do I hold this session?" check (see mcpPrimaryKey).
  // Given by the code that owns the session map, so it is never part of the
  // static MCP_RATE_LIMIT_PROFILES entries below.
  readonly isKnownSession?: (sessionId: string) => boolean;
  // A store per limiter, for when the app runs on several machines and the
  // counters must be shared (e.g. Redis). Default: express-rate-limit's
  // MemoryStore. Must return a NEW store on every call: express-rate-limit
  // refuses one store shared by two limiters.
  readonly createStore?: (limiter: McpLimiterName) => Store;
}

// Never stricter than what each `/mcp` had before it got its own chain.
export const MCP_RATE_LIMIT_PROFILES = {
  // Unchanged from RFB's first three limiters (lokal#917).
  rfb: {
    brake: { windowMs: 15 * 60 * 1000, max: 3000 },
    // Same ceiling and window as jsonRpcLimiter (security.ts).
    primary: { windowMs: 15 * 60 * 1000, anonymousMax: 200, keyedMax: 600 },
    // Same numbers as cartWishesLimiter (security.ts), the REST cart's own
    // quota for this exact class of endpoint.
    sideEffect: { windowMs: 60 * 1000, max: 20, tools: CART_SIDE_EFFECT_TOOLS, keyGenerator: mcpCartToolKey },
  },
  // Primary: what jsonRpcLimiter gave Opplevagent's /mcp per IP until now —
  // now per session.
  experiences: {
    brake: { windowMs: 15 * 60 * 1000, max: 3000 },
    primary: { windowMs: 15 * 60 * 1000, anonymousMax: 200, keyedMax: 600 },
    // book_gardssalg e-mails the producer and the guest. Keyed on the IP,
    // never on a tool argument: the tool takes no buyer_ref, and a made-up
    // one must not buy a fresh bucket.
    sideEffect: {
      windowMs: 60 * 1000,
      max: 20,
      tools: new Set(["book_gardssalg"]) as ReadonlySet<string>,
      keyGenerator: mcpIpKey,
    },
  },
  // Primary: dentalLimiter's flat 1000 per IP until now — now per session,
  // still not raised by a key (a higher keyed ceiling is a one-number change
  // here). No side-effect quota: every Finn-tannlege tool is read-only.
  dental: {
    brake: { windowMs: 15 * 60 * 1000, max: 3000 },
    primary: { windowMs: 15 * 60 * 1000, anonymousMax: 1000, keyedMax: 1000 },
  },
} satisfies Record<"rfb" | "experiences" | "dental", McpRateLimitProfile>;

// ─── Factory ─────────────────────────────────────────────────────────────────
export interface McpRateLimiters {
  brake: RateLimitRequestHandler;
  primary: RateLimitRequestHandler;
  sideEffect: RateLimitRequestHandler | undefined;
  // brake → primary → sideEffect (when the profile has one): the mount order.
  chain: RateLimitRequestHandler[];
}

export function createMcpRateLimiters(profile: McpRateLimitProfile): McpRateLimiters {
  const shared = {
    standardHeaders: true,
    legacyHeaders: false,
    validate: sharedValidate,
    handler: sendMcpRateLimited,
  } as const;
  const storeFor = (limiter: McpLimiterName) => (profile.createStore ? { store: profile.createStore(limiter) } : {});

  const brake = rateLimit({
    ...shared,
    ...storeFor("brake"),
    windowMs: profile.brake.windowMs,
    max: profile.brake.max,
    keyGenerator: mcpIpKey,
  });

  const isKnownSession = profile.isKnownSession;
  const primary = rateLimit({
    ...shared,
    ...storeFor("primary"),
    windowMs: profile.primary.windowMs,
    max: keyedMax(profile.primary.anonymousMax, profile.primary.keyedMax),
    keyGenerator: (req) => mcpPrimaryKey(req, isKnownSession),
  });

  const se = profile.sideEffect;
  const sideEffect = se
    ? rateLimit({
        ...shared,
        ...storeFor("sideEffect"),
        windowMs: se.windowMs,
        max: se.max,
        keyGenerator: se.keyGenerator,
        skip: (req) => !isSideEffectToolCall(req.body, se.tools),
      })
    : undefined;

  return { brake, primary, sideEffect, chain: sideEffect ? [brake, primary, sideEffect] : [brake, primary] };
}

// ─── RFB's chain (mounted on /mcp in src/index.ts) ───────────────────────────
// RFB's session map lives in routes/mcp.ts, which is require()d on use rather
// than imported: importing it would load the whole RFB tool surface (DB,
// services, its session-cleanup timer) into every importer of this module —
// the per-vertical tests included. Same lazy-require pattern as
// services/mcp-tool-manifest.ts. index.ts has loaded it long before the first
// request reaches this check.
function isLiveRfbMcpSession(sessionId: string): boolean {
  return (require("../routes/mcp") as typeof import("../routes/mcp")).hasMcpSession(sessionId);
}

const rfbMcpRateLimiters = createMcpRateLimiters({ ...MCP_RATE_LIMIT_PROFILES.rfb, isKnownSession: isLiveRfbMcpSession });

export const mcpIpEmergencyBrakeLimiter = rfbMcpRateLimiters.brake;
export const mcpPrimaryLimiter = rfbMcpRateLimiters.primary;
// The rfb profile always has a side-effect quota (the three cart tools).
export const mcpCartToolLimiter = rfbMcpRateLimiters.sideEffect!;
