import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { Request, Response, NextFunction } from "express";

// ─── CORS ────────────────────────────────────────────────────
// Fix #8: Restrict to known origins instead of reflecting all.
// Allowed origins include our own surfaces PLUS the AI platforms that
// connect to /mcp over Streamable HTTP from a browser context
// (Claude.ai, ChatGPT). Without these, browser-initiated MCP
// connections fail CORS preflight.
export const corsOptions = {
  origin: [
    "https://rettfrabonden.com",
    "https://www.rettfrabonden.com",
    "https://lokal.fly.dev",
    "https://claude.ai",
    "https://www.claude.ai",
    "https://chatgpt.com",
    "https://chat.openai.com",
    ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-API-Key",
    "X-Admin-Key",
    "X-Claim-Token",
    // MCP Streamable HTTP (spec 2025-06-18) — session + version headers
    "Mcp-Session-Id",
    "Mcp-Protocol-Version",
    // SSE resumption for Streamable HTTP long-lived responses
    "Last-Event-ID",
  ],
  // Expose MCP headers so browser clients can read them from responses
  exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version"],
};

// ─── Security headers (Helmet) ───────────────────────────────
// Fix #9: Enable CSP with sensible defaults
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // needed for SEO inline scripts
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://rettfrabonden.com"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,  // needed for cross-origin images
  crossOriginResourcePolicy: { policy: "cross-origin" },  // needed for MCP/A2A API access
});

// ─── Max request body size ───────────────────────────────────
export const MAX_REQUEST_SIZE = "1mb";

// ─── Input sanitization ──────────────────────────────────────
// Fix #10: Deep sanitization of nested objects/arrays
function sanitizeValue(value: any): any {
  if (typeof value === "string") {
    return value
      .replace(/<[^>]*>/g, "")          // strip HTML tags
      .replace(/&#\d+;/g, "")           // strip numeric HTML entities
      .replace(/&#x[0-9a-fA-F]+;/g, "") // strip hex HTML entities
      .replace(/javascript:/gi, "")      // strip javascript: URIs
      .replace(/on\w+\s*=/gi, "");       // strip inline event handlers
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    const sanitized: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      sanitized[key] = sanitizeValue(value[key]);
    }
    return sanitized;
  }
  return value;
}

export function sanitizeInput(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === "object") {
    req.body = sanitizeValue(req.body);
  }
  next();
}

// ─── Rate Limiter shared config ─────────────────────────────
// Fly.io sits behind a reverse proxy, so we use `trust proxy: true`
// in Express.  express-rate-limit v7+ throws ERR_ERL_PERMISSIVE_TRUST_PROXY
// unless we explicitly acknowledge this.  We disable that specific
// validation — Fly's edge proxy is trusted infrastructure.
const sharedValidate = { trustProxy: false } as const;

// ─── Consumer-key rate-limit differentiation ────────────────
// dev-request 2026-07-13-agent-identity-usage-ledger, slice 1 (L4,
// Daniel-authorized 2026-07-20). middleware/consumer-identity.ts attaches
// `req.consumerKeyId` when a request presents a valid, active, voluntary
// X-API-Key; a caller WITHOUT one leaves it undefined. express-rate-limit
// v8's `max` accepts a per-request function (installed version: 8.3.2,
// confirmed via package.json), which is the simplest correct mechanism here
// — no second limiter instance/store needed.
//
// Regression-critical: for a request with no consumerKeyId, this function
// returns EXACTLY `anonymousMax` — the same static number the limiter used
// before this change existed. Nothing about the anonymous path's rate-limit
// behavior changes; a keyed caller simply gets a materially higher ceiling.
export function keyedMax(anonymousMax: number, keyedMax: number) {
  return (req: Request): number => (req.consumerKeyId ? keyedMax : anonymousMax);
}

// ─── Rate Limiters ───────────────────────────────────────────

// General API limiter — raised to 300/15min for enrichment runs (200 agents × ~2 req each)
//
// PR-106: `/api/tannlege/*` is excluded via the `skip` callback below.
// The dental vertical has its own dedicated `dentalLimiter` (1000/15min)
// to support 3 parallel dental-agent-enrichment workers (~36 PUTs/min
// sustained). Without this skip, the lower general limit would still
// gate tannlege requests because both limiters would chain.
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // dev-request 2026-07-13-agent-identity-usage-ledger: a caller presenting
  // a valid, voluntary X-API-Key gets 3x the anonymous ceiling (900 vs 300).
  // Anonymous callers (no consumerKeyId) still get exactly 300 — unchanged.
  max: keyedMax(300, 900),
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  skip: (req) => {
    const fullPath = (req.baseUrl || "") + (req.path || "");
    return fullPath.startsWith("/api/tannlege");
  },
  message: { success: false, error: "For mange forespørsler. Prøv igjen senere." },
});

// PR-106: Dedicated limiter for /api/tannlege/* (dental vertical).
// Sized to fit 3 parallel dental-agent-enrichment workers doing the
// per-field-PUT model (~12-15 PUTs/min each = ~36-45/min combined),
// plus headroom for the verifier, orchestrator, and manual probes.
// 1000 per 15 minutes ≈ 66/min sustained.
//
// The dental admin endpoints already require an `X-Admin-Key` header,
// so the limiter exists only as a defence-in-depth quota, not as the
// primary auth boundary. Increasing it does not weaken auth.
export const dentalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  message: { success: false, error: "For mange forespørsler mot tannlege-API. Prøv igjen senere." },
});

// JSON-RPC limiter (agents are chatty, so more generous)
export const jsonRpcLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // dev-request 2026-07-13-agent-identity-usage-ledger: same keyed/anonymous
  // differentiation as generalLimiter above — 600 vs 200 for A2A/MCP traffic.
  max: keyedMax(200, 600),
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  message: { success: false, error: "For mange A2A-forespørsler. Prøv igjen senere." },
});

// Registration limiter — allows 50 per hour for scheduled agent discovery
// Previously 5/hour → 20/hour → now 50/hour for batch onboarding runs
export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  message: { success: false, error: "Registreringsgrense nådd. Maks 50 registreringer per time." },
});

// Consumer API-key issuance limiter — dev-request
// 2026-07-13-agent-identity-usage-ledger, slice 1. Same generous shape as
// registrationLimiter above (anti-spam on a free, self-service, unauthenticated
// POST endpoint), not the anonymous data-path — see routes/consumer-keys.ts.
export const consumerKeyIssuanceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  message: { success: false, error: "For mange nøkkel-utstedelser. Maks 50 per time." },
});

// Search limiter
export const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  message: { success: false, error: "For mange søk. Prøv igjen senere." },
});

// Fix #6: Strict rate limiter for destructive admin endpoints
export const adminLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 500, // Raised from 100 — admin endpoints require X-Admin-Key anyway, need room for 200-agent enrichment runs
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  message: { success: false, error: "Admin rate limit nådd. Maks 100 admin-operasjoner per time." },
});

// ─── AI-crawler allowlist ─────────────────────────────────────
// Cloudflare WAF rules may block unknown bots on finn-tannlege.com and
// other domains. This middleware runs before any rate-limiter and marks
// requests from known AI crawlers so downstream scrape-hardening can
// let them through. We only allow the safe, read-only paths:
// llms.txt, sitemap.xml, robots.txt, /.well-known/*, and the public
// SSR pages (GET with no sensitive parameters).
//
// PII-redaction and abusive-scraper blocking (anything NOT in this UA
// list) are unaffected — this is an explicit allowlist, not "allow all".

const AI_CRAWLER_UAS = [
  "gptbot",
  "oai-searchbot",
  "chatgpt-user",
  "perplexitybot",
  "claudebot",
  "anthropic-ai",
  "google-extended",
  "googlebot",
  "bingbot",
  "applebot",
];

// Paths that AI crawlers are always permitted to reach.
const AI_SAFE_PATHS = [
  "/llms.txt",
  "/llms-full.txt",
  "/sitemap.xml",
  "/robots.txt",
];

function isAiCrawler(ua: string): boolean {
  const lower = ua.toLowerCase();
  return AI_CRAWLER_UAS.some((bot) => lower.includes(bot));
}

function isAiSafePath(path: string): boolean {
  if (AI_SAFE_PATHS.includes(path)) return true;
  if (path.startsWith("/.well-known/")) return true;
  return false;
}

export function aiCrawlerAllowlist(req: Request, res: Response, next: NextFunction) {
  const ua = req.headers["user-agent"] || "";
  if (req.method === "GET" && isAiCrawler(ua) && isAiSafePath(req.path)) {
    // Signal to any downstream middleware / rate-limiter that this is a
    // trusted AI crawler on a read-only path — skip blocking.
    (req as any).isAiCrawler = true;
    res.setHeader("X-Robots-Tag", "all");
  }
  next();
}
