"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminLimiter = exports.searchLimiter = exports.registrationLimiter = exports.jsonRpcLimiter = exports.generalLimiter = exports.MAX_REQUEST_SIZE = exports.securityHeaders = exports.corsOptions = void 0;
exports.sanitizeInput = sanitizeInput;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const helmet_1 = __importDefault(require("helmet"));
// ─── CORS ────────────────────────────────────────────────────
// Fix #8: Restrict to known origins instead of reflecting all.
// Allowed origins include our own surfaces PLUS the AI platforms that
// connect to /mcp over Streamable HTTP from a browser context
// (Claude.ai, ChatGPT). Without these, browser-initiated MCP
// connections fail CORS preflight.
exports.corsOptions = {
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
exports.securityHeaders = (0, helmet_1.default)({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"], // needed for SEO inline scripts
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://rettfrabonden.com"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
        },
    },
    crossOriginEmbedderPolicy: false, // needed for cross-origin images
    crossOriginResourcePolicy: { policy: "cross-origin" }, // needed for MCP/A2A API access
});
// ─── Max request body size ───────────────────────────────────
exports.MAX_REQUEST_SIZE = "1mb";
// ─── Input sanitization ──────────────────────────────────────
// Fix #10: Deep sanitization of nested objects/arrays
function sanitizeValue(value) {
    if (typeof value === "string") {
        return value
            .replace(/<[^>]*>/g, "") // strip HTML tags
            .replace(/&#\d+;/g, "") // strip numeric HTML entities
            .replace(/&#x[0-9a-fA-F]+;/g, "") // strip hex HTML entities
            .replace(/javascript:/gi, "") // strip javascript: URIs
            .replace(/on\w+\s*=/gi, ""); // strip inline event handlers
    }
    if (Array.isArray(value)) {
        return value.map(sanitizeValue);
    }
    if (value && typeof value === "object") {
        const sanitized = {};
        for (const key of Object.keys(value)) {
            sanitized[key] = sanitizeValue(value[key]);
        }
        return sanitized;
    }
    return value;
}
function sanitizeInput(req, _res, next) {
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
const sharedValidate = { trustProxy: false };
// ─── Rate Limiters ───────────────────────────────────────────
// General API limiter — raised to 300/15min for enrichment runs (200 agents × ~2 req each)
exports.generalLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    validate: sharedValidate,
    message: { success: false, error: "For mange forespørsler. Prøv igjen senere." },
});
// JSON-RPC limiter (agents are chatty, so more generous)
exports.jsonRpcLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    validate: sharedValidate,
    message: { success: false, error: "For mange A2A-forespørsler. Prøv igjen senere." },
});
// Registration limiter — allows 50 per hour for scheduled agent discovery
// Previously 5/hour → 20/hour → now 50/hour for batch onboarding runs
exports.registrationLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    validate: sharedValidate,
    message: { success: false, error: "Registreringsgrense nådd. Maks 50 registreringer per time." },
});
// Search limiter
exports.searchLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 150,
    standardHeaders: true,
    legacyHeaders: false,
    validate: sharedValidate,
    message: { success: false, error: "For mange søk. Prøv igjen senere." },
});
// Fix #6: Strict rate limiter for destructive admin endpoints
exports.adminLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 500, // Raised from 100 — admin endpoints require X-Admin-Key anyway, need room for 200-agent enrichment runs
    standardHeaders: true,
    legacyHeaders: false,
    validate: sharedValidate,
    message: { success: false, error: "Admin rate limit nådd. Maks 100 admin-operasjoner per time." },
});
//# sourceMappingURL=security.js.map