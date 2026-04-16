"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const init_1 = require("./database/init");
const security_1 = require("./middleware/security");
const producer_1 = __importDefault(require("./routes/producer"));
const consumer_1 = __importDefault(require("./routes/consumer"));
const scan_1 = __importDefault(require("./routes/scan"));
const a2a_1 = __importDefault(require("./routes/a2a"));
const reservation_1 = __importDefault(require("./routes/reservation"));
const marketplace_1 = __importDefault(require("./routes/marketplace"));
const mcp_1 = __importDefault(require("./routes/mcp"));
const seo_1 = __importDefault(require("./routes/seo"));
const analytics_service_1 = require("./services/analytics-service");
const analytics_1 = __importDefault(require("./routes/analytics"));
const seed_1 = require("./seed");
const seed_oslo_real_1 = require("./seed-oslo-real");
const seed_marketplace_1 = require("./seed-marketplace");
const seed_norway_expansion_1 = require("./seed-norway-expansion");
const seed_expansion_v2_1 = require("./seed-expansion-v2");
const seed_expansion_v3_1 = require("./seed-expansion-v3");
const seed_expansion_v4_1 = require("./seed-expansion-v4");
const seed_expansion_v5_1 = require("./seed-expansion-v5");
const seed_expansion_v6_1 = require("./seed-expansion-v6");
const seed_expansion_v7_1 = require("./seed-expansion-v7");
const seed_expansion_v8_1 = require("./seed-expansion-v8");
const discovery_service_1 = require("./services/discovery-service");
const trust_score_service_1 = require("./services/trust-score-service");
// Dynamic import — seed-knowledge is a late addition and may not be
// present in every Docker layer during rolling deploys.  Graceful
// fallback prevents the entire process from crashing.
let seedKnowledge;
try {
    seedKnowledge = require("./seed-knowledge").seedKnowledge;
}
catch {
    console.warn("⚠️  seed-knowledge module not found — skipping knowledge enrichment (will retry next deploy)");
}
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
// ─── Proxy trust ─────────────────────────────────────────────
// Fly.io (and most PaaS) terminates TLS and forwards requests
// via a reverse proxy that sets X-Forwarded-For.  Without this
// setting Express ignores that header, which:
//   1. Breaks express-rate-limit (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR)
//   2. Makes req.ip return the internal proxy IP, not the client
//   3. Breaks req.protocol (always "http" instead of "https")
// "true" = trust the first proxy hop, which is Fly's edge.
app.set("trust proxy", true);
// ─── www → apex redirect ────────────────────────────────────
// Canonical domain is rettfrabonden.com (no www).
// Redirect early, before any other processing.
app.use((req, res, next) => {
    if (req.hostname === "www.rettfrabonden.com") {
        return res.redirect(301, `https://rettfrabonden.com${req.originalUrl}`);
    }
    next();
});
// ─── Security Layer ──────────────────────────────────────────
app.use(security_1.securityHeaders);
app.use((0, cors_1.default)(security_1.corsOptions));
app.use(express_1.default.json({ limit: security_1.MAX_REQUEST_SIZE }));
app.use(security_1.sanitizeInput);
// Analytics middleware (before routes, after security)
app.use(analytics_service_1.analyticsService.middleware());
// Serve the marketplace dashboard
app.use(express_1.default.static(path_1.default.join(__dirname, "public"), { extensions: ["html"] }));
// ─── Rate-limited routes ─────────────────────────────────────
// JSON-RPC gets its own limiter (agents are chatty)
app.use("/a2a", security_1.jsonRpcLimiter);
// Registration is heavily limited (anti-spam)
app.use("/api/marketplace/register", security_1.registrationLimiter);
// Search has its own tier
app.use("/api/marketplace/search", security_1.searchLimiter);
app.use("/api/marketplace/discover", security_1.searchLimiter);
// Admin/destructive endpoints get a strict limiter (10/hour)
app.use("/api/marketplace/admin", security_1.adminLimiter);
app.delete("/api/marketplace/agents/:id", security_1.adminLimiter);
app.post("/admin/analytics/prune", security_1.adminLimiter);
// Everything else gets the general limiter
app.use("/api", security_1.generalLimiter);
// ─── Routes ──────────────────────────────────────────────────
app.use("/api/producers", producer_1.default);
app.use("/api/producers", scan_1.default);
app.use("/api/products", scan_1.default);
app.use("/api", consumer_1.default);
app.use("/api/reservations", reservation_1.default);
app.use("/api/marketplace", marketplace_1.default);
app.use("/mcp", mcp_1.default);
app.use("/", a2a_1.default);
// ─── SPA dashboard (renamed from index.html to let SEO routes handle /) ──
app.get("/app", (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, "public", "app.html"));
});
// ─── Analytics dashboard ────────────────────────────────────
app.get("/admin/dashboard", (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, "public", "admin-dashboard.html"));
});
// ─── OpenAPI spec (for Custom GPTs and developer docs) ──────
app.get("/openapi.yaml", (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, "..", "openapi.yaml"));
});
// ─── Health check ────────────────────────────────────────────
app.get("/health", (_req, res) => {
    const stats = require("./services/marketplace-registry").marketplaceRegistry.getStats();
    res.json({
        status: "ok",
        service: "lokal",
        version: "0.3.0",
        database: "sqlite",
        agents: stats.totalAgents,
        uptime: Math.floor(process.uptime()),
    });
});
// Analytics admin endpoints
app.use("/admin/analytics", analytics_1.default);
// SEO pages LAST — /:city is a catch-all wildcard
app.use("/", seo_1.default);
// ─── Database + Seed (with idempotency guard) ───────────────
// FIX: Seeds were running on every restart, causing duplicate agents.
// Fly.io restarts the app on deploy, autoscale, and idle-wakeup.
// Each restart re-ran all 11 seed functions, adding duplicates with
// new UUIDs but identical names/cities.
//
// Solution: Check if agents already exist before seeding.
// If the DB already has agents, skip seeding entirely.
// Seeds are only for initial population — not for every boot.
console.log("\n💾 Initializing SQLite database...");
const db = (0, init_1.getDb)();
const existingAgentCount = db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
if (existingAgentCount === 0) {
    console.log("🌱 Empty database detected — running initial seed...");
    (0, seed_1.seedData)();
    (0, seed_oslo_real_1.seedOsloRealData)();
    (0, seed_marketplace_1.seedMarketplace)();
    (0, seed_norway_expansion_1.seedNorwayExpansion)();
    (0, seed_expansion_v2_1.seedExpansionV2)();
    (0, seed_expansion_v3_1.seedExpansionV3)();
    (0, seed_expansion_v4_1.seedExpansionV4)();
    (0, seed_expansion_v5_1.seedExpansionV5)();
    (0, seed_expansion_v6_1.seedExpansionV6)();
    (0, seed_expansion_v7_1.seedExpansionV7)();
    (0, seed_expansion_v8_1.seedExpansionV8)();
    if (seedKnowledge)
        seedKnowledge();
    // Deduplicate: remove duplicate agents (keep oldest by created_at)
    const dupeCount = db.prepare(`
    SELECT COUNT(*) as c FROM agents WHERE id NOT IN (
      SELECT MIN(id) FROM agents GROUP BY name, city
    )
  `).get().c;
    if (dupeCount > 0) {
        db.prepare(`
      DELETE FROM agents WHERE id NOT IN (
        SELECT MIN(id) FROM agents GROUP BY name, city
      )
    `).run();
        console.log(`🧹 Removed ${dupeCount} duplicate agents after seeding`);
    }
    const finalCount = db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
    console.log(`✅ Seeded ${finalCount} unique agents`);
}
else {
    console.log(`✅ Database already has ${existingAgentCount} agents — skipping seed`);
    // Run deduplication on existing data (one-time cleanup for the 429→370 issue)
    const dupeCount = db.prepare(`
    SELECT COUNT(*) as c FROM agents WHERE id NOT IN (
      SELECT MIN(id) FROM agents GROUP BY name, city
    )
  `).get().c;
    if (dupeCount > 0) {
        db.prepare(`
      DELETE FROM agents WHERE id NOT IN (
        SELECT MIN(id) FROM agents GROUP BY name, city
      )
    `).run();
        console.log(`🧹 Cleaned up ${dupeCount} duplicate agents from previous restarts`);
    }
    // Enrich knowledge if not already done
    if (seedKnowledge) {
        const knowledgeCount = db.prepare("SELECT COUNT(*) as c FROM agent_knowledge").get().c;
        if (knowledgeCount === 0) {
            console.log("📚 Running knowledge enrichment...");
            seedKnowledge();
        }
    }
}
// ─── Recalculate trust scores on boot ────────────────────────
// Every deploy gets fresh scores reflecting current data.
// This replaces the static 0.5 default with real calculations.
console.log("📊 Recalculating trust scores...");
const trustResult = trust_score_service_1.trustScoreService.recalculateAll();
console.log(`   ✅ Updated ${trustResult.updated} agents (avg: ${Math.round(trustResult.avgScore * 100)}%)`);
// ─── Start ───────────────────────────────────────────────────
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
// Bind to 0.0.0.0 — required for Docker/Fly.io (localhost won't work in containers)
const HOST = process.env.HOST || "0.0.0.0";
app.listen(Number(PORT), HOST, async () => {
    console.log(`\n🥬 Lokal API v0.11.0 running at ${BASE_URL}`);
    console.log(`   💾 Database: SQLite (persistent)`);
    console.log(`   🔒 Security: Helmet + Rate limiting + Input sanitization`);
    console.log(`\n   ── A2A Protocol ──────────────────────────────`);
    console.log(`   JSON-RPC:      POST ${BASE_URL}/a2a`);
    console.log(`   Agent Card:    GET  ${BASE_URL}/.well-known/agent-card.json`);
    console.log(`\n   ── Marketplace ──────────────────────────────`);
    console.log(`   Register:      POST ${BASE_URL}/api/marketplace/register`);
    console.log(`   Discover:      POST ${BASE_URL}/api/marketplace/discover`);
    console.log(`   NL Search:     GET  ${BASE_URL}/api/marketplace/search?q=...`);
    console.log(`   MCP Server:    npx lokal-mcp (for Claude Desktop)`);
    console.log(`   MCP HTTP:      POST ${BASE_URL}/mcp (for ChatGPT & remote clients)`);
    console.log(`\n   ── Discovery ────────────────────────────────`);
    // Initialize discovery service (registers with A2A registries if public URL)
    await discovery_service_1.discoveryService.initialize(BASE_URL);
    console.log("");
});
// ─── Graceful shutdown ───────────────────────────────────────
process.on("SIGTERM", () => { discovery_service_1.discoveryService.shutdown(); (0, init_1.closeDb)(); process.exit(0); });
process.on("SIGINT", () => { discovery_service_1.discoveryService.shutdown(); (0, init_1.closeDb)(); process.exit(0); });
exports.default = app;
//# sourceMappingURL=index.js.map