import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { Request, Response, NextFunction } from "express";

// ─── CORS ────────────────────────────────────────────────────
// Fix #8: Restrict to known origins instead of reflecting all
export const corsOptions = {
  origin: [
    "https://rettfrabonden.com",
    "https://www.rettfrabonden.com",
    "https://lokal.fly.dev",
    ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "X-Admin-Key", "X-Claim-Token"],
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

// ─── Rate Limiters ───────────────────────────────────────────

// General API limiter
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  message: { success: false, error: "For mange forespørsler. Prøv igjen senere." },
});

// JSON-RPC limiter (agents are chatty, so more generous)
export const jsonRpcLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
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
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: sharedValidate,
  message: { success: false, error: "Admin rate limit nådd. Maks 10 admin-operasjoner per time." },
});
