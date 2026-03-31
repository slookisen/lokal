import { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

// ─── Security Middleware ─────────────────────────────────────
// Why this matters: The moment we go public, bots will find us.
// An unprotected API is a liability — not just for us, but for
// every producer whose data we host.
//
// Layers:
//   1. Helmet — HTTP security headers (XSS, clickjacking, etc.)
//   2. Rate limiting — per IP, per endpoint class
//   3. Input sanitization — prevent SQL injection (SQLite) and XSS
//   4. Request size limiting — prevent memory exhaustion
//   5. API key validation middleware — for authenticated endpoints

// ─── 1. Helmet (HTTP security headers) ──────────────────────

export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Dashboard needs inline JS
      styleSrc: ["'self'", "'unsafe-inline'"],   // Dashboard inline styles
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow embedding for agent interop
});

// ─── 2. Rate Limiting ───────────────────────────────────────

// General API: 100 requests per minute per IP
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "For mange forespørsler. Prøv igjen om litt.",
    retryAfterMs: 60000,
  },
});

// Registration: 5 per hour per IP (prevent spam registrations)
export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: "Registreringsgrense nådd. Maks 5 registreringer per time.",
  },
});

// JSON-RPC: 200 per minute (agents may be chatty)
export const jsonRpcLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Rate limit exceeded" },
    id: null,
  },
});

// Search: 60 per minute (prevent scraping)
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: {
    success: false,
    error: "Søkegrense nådd. Maks 60 søk per minutt.",
  },
});

// ─── 3. Input Sanitization ──────────────────────────────────
// Strips dangerous characters from string inputs.
// SQLite parameterized queries already prevent injection,
// but defense in depth is important.

export function sanitizeInput(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === "object") {
    req.body = deepSanitize(req.body);
  }
  next();
}

function deepSanitize(obj: any): any {
  if (typeof obj === "string") {
    // Remove null bytes (SQLite injection vector)
    let clean = obj.replace(/\0/g, "");
    // Strip HTML tags (XSS prevention) — but preserve normal text
    clean = clean.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
    // Limit string length to prevent memory abuse
    return clean.slice(0, 10000);
  }
  if (Array.isArray(obj)) {
    return obj.slice(0, 100).map(deepSanitize); // Max 100 array items
  }
  if (obj && typeof obj === "object") {
    const sanitized: any = {};
    const keys = Object.keys(obj).slice(0, 50); // Max 50 keys per object
    for (const key of keys) {
      sanitized[key] = deepSanitize(obj[key]);
    }
    return sanitized;
  }
  return obj;
}

// ─── 4. Request Size Limiting ───────────────────────────────
// Express default is 100kb, but we want explicit control.
// Registration payloads with skills can be ~5kb.
// We set 50kb as generous but safe.

export const MAX_REQUEST_SIZE = "50kb";

// ─── 5. API Key Validation Middleware ───────────────────────
// Used on endpoints that require authentication (update, heartbeat)

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers["x-api-key"] as string;
  if (!apiKey) {
    res.status(401).json({
      success: false,
      error: "Mangler X-API-Key header",
      hint: "Send API-nøkkelen du fikk ved registrering i X-API-Key headeren",
    });
    return;
  }

  // Basic format validation (prevents scanning with garbage keys)
  if (!apiKey.startsWith("lok_") || apiKey.length < 40) {
    res.status(401).json({
      success: false,
      error: "Ugyldig API-nøkkel format",
    });
    return;
  }

  next();
}

// ─── 6. CORS configuration ─────────────────────────────────
// In production: restrict to known agent domains.
// For now: permissive (agents can come from anywhere).

export const corsOptions = {
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST", "PUT"],
  allowedHeaders: ["Content-Type", "X-API-Key", "Authorization"],
  maxAge: 86400, // Cache preflight for 24h
};
