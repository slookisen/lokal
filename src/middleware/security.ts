import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { Request, Response, NextFunction } from "express";

// ─── CORS ────────────────────────────────────────────────────
export const corsOptions = {
  origin: true, // reflect request origin
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
};

// ─── Security headers (Helmet) ───────────────────────────────
export const securityHeaders = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
});

// ─── Max request body size ───────────────────────────────────
export const MAX_REQUEST_SIZE = "1mb";

// ─── Input sanitization ──────────────────────────────────────
export function sanitizeInput(req: Request, _res: Response, next: NextFunction) {
  // Basic XSS prevention: strip HTML tags from string values
  if (req.body && typeof req.body === "object") {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === "string") {
        req.body[key] = req.body[key].replace(/<[^>]*>/g, "");
      }
    }
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
