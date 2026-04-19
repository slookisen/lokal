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
const discovery_1 = __importDefault(require("./routes/discovery"));
const conversation_ui_1 = __importDefault(require("./routes/conversation-ui"));
const agent_readiness_1 = __importDefault(require("./routes/agent-readiness"));
const agent_discovery_1 = require("./middleware/agent-discovery");
const analytics_service_1 = require("./services/analytics-service");
const analytics_1 = __importDefault(require("./routes/analytics"));
const seed_1 = require("./seed");
// Seed files moved to src/_seeds/ — only loaded if DB is empty (see below).
const discovery_service_1 = require("./services/discovery-service");
const trust_score_service_1 = require("./services/trust-score-service");
// Seed-knowledge loaded dynamically — only used if DB is empty
let seedKnowledge;
try {
    seedKnowledge = require("./_seeds/seed-knowledge").seedKnowledge;
}
catch { /* ok */ }
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
// ─── Agent discovery ────────────────────────────────────────
// Link headers (RFC 8288) on every response — cheap, helps agents
// auto-discover our well-known endpoints without poking around.
app.use(agent_discovery_1.linkHeaders);
// Markdown content negotiation — when an agent sends
// `Accept: text/markdown` on a content route, return markdown
// instead of HTML. Saves tokens, improves agent comprehension.
app.use(agent_discovery_1.markdownNegotiation);
// Well-known discovery endpoints (MCP Server Card, Agent Skills,
// API Catalog, OAuth Protected Resource). Mounted BEFORE static
// so the .well-known/* paths are served dynamically, not from disk.
app.use("/", agent_readiness_1.default);
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
const BOOT_TIME = new Date().toISOString();
app.get("/health", (_req, res) => {
    const startMs = Date.now();
    try {
        const { marketplaceRegistry } = require("./services/marketplace-registry");
        const { getDb } = require("./database/init");
        const db = getDb();
        // DB responsiveness — timed simple query
        const dbStart = Date.now();
        const stats = marketplaceRegistry.getStats();
        const dbLatencyMs = Date.now() - dbStart;
        // Memory usage
        const mem = process.memoryUsage();
        const memUsedMb = Math.round(mem.rss / 1024 / 1024);
        const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
        const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
        // Database file sizes
        const fs = require("fs");
        const dbPath = process.env.DB_PATH || "./data/lokal.db";
        let dbSizeMb = 0;
        try {
            dbSizeMb = Math.round(fs.statSync(dbPath).size / 1024 / 1024 * 10) / 10;
        }
        catch { }
        // Row counts for key tables
        const agentCount = db.prepare("SELECT COUNT(*) as c FROM agents WHERE is_active = 1").get().c;
        const pvCount = db.prepare("SELECT COUNT(*) as c FROM analytics_page_views").get().c;
        const queryCount = db.prepare("SELECT COUNT(*) as c FROM analytics_queries").get().c;
        // Recent activity (last hour)
        const oneHourAgo = new Date(Date.now() - 3600000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
        const recentPv = db.prepare("SELECT COUNT(*) as c FROM analytics_page_views WHERE created_at > ?").get(oneHourAgo).c;
        // Uptime
        const uptimeSec = Math.floor(process.uptime());
        // Overall status based on thresholds
        let status = "healthy";
        const warnings = [];
        if (memUsedMb > 420) {
            status = "critical";
            warnings.push(`Memory critical: ${memUsedMb}MB / 512MB`);
        }
        else if (memUsedMb > 350) {
            status = "warning";
            warnings.push(`Memory high: ${memUsedMb}MB / 512MB`);
        }
        if (dbLatencyMs > 3000) {
            status = "critical";
            warnings.push(`DB slow: ${dbLatencyMs}ms`);
        }
        else if (dbLatencyMs > 1000) {
            if (status !== "critical")
                status = "warning";
            warnings.push(`DB latency elevated: ${dbLatencyMs}ms`);
        }
        if (dbSizeMb > 200) {
            if (status !== "critical")
                status = "warning";
            warnings.push(`DB large: ${dbSizeMb}MB`);
        }
        if (pvCount > 500000) {
            warnings.push(`analytics_page_views has ${pvCount} rows — consider pruning`);
        }
        const responseMs = Date.now() - startMs;
        res.json({
            status,
            warnings,
            service: "rettfrabonden",
            version: "1.0.0",
            uptime: uptimeSec,
            uptimeHuman: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`,
            bootedAt: BOOT_TIME,
            timestamp: new Date().toISOString(),
            memory: {
                rssMb: memUsedMb,
                heapUsedMb,
                heapTotalMb,
                limitMb: 512,
                pct: Math.round(memUsedMb / 512 * 100),
            },
            database: {
                latencyMs: dbLatencyMs,
                sizeMb: dbSizeMb,
                agents: agentCount,
                pageViews: pvCount,
                queries: queryCount,
            },
            traffic: {
                lastHourPageViews: recentPv,
                totalAgents: stats.totalAgents,
                activeCities: stats.cities.length,
            },
            responseMs,
        });
    }
    catch (err) {
        res.status(500).json({
            status: "critical",
            warnings: [`Health check failed: ${err}`],
            timestamp: new Date().toISOString(),
            responseMs: Date.now() - startMs,
        });
    }
});
// Analytics admin endpoints
app.use("/admin/analytics", analytics_1.default);
// Conversation UI — /samtaler and /samtale/:id (before SEO catch-all)
app.use("/", conversation_ui_1.default);
// SEO pages LAST — /:city is a catch-all wildcard
app.use("/", discovery_1.default); // llms.txt, MCP server-card, agents.txt, openapi.json
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
    // Dynamic require for seed files (moved to _seeds/ to keep build clean)
    try {
        const seedFns = [
            "./_seeds/seed-oslo-real", "./_seeds/seed-marketplace", "./_seeds/seed-norway-expansion",
            "./_seeds/seed-expansion-v2", "./_seeds/seed-expansion-v3", "./_seeds/seed-expansion-v4",
            "./_seeds/seed-expansion-v5", "./_seeds/seed-expansion-v6", "./_seeds/seed-expansion-v7",
            "./_seeds/seed-expansion-v8"
        ];
        for (const mod of seedFns) {
            try {
                const m = require(mod);
                const fn = Object.values(m)[0];
                if (typeof fn === "function")
                    fn();
            }
            catch { /* seed file may not exist in Docker layer — ok */ }
        }
    }
    catch { /* seed loading failed — non-fatal */ }
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
    // Deduplication removed — data is already clean after initial cleanup.
    // Keeping the seed-path dedup for fresh databases only.
    // Enrich knowledge if not already done
    if (seedKnowledge) {
        const knowledgeCount = db.prepare("SELECT COUNT(*) as c FROM agent_knowledge").get().c;
        if (knowledgeCount === 0) {
            console.log("📚 Running knowledge enrichment...");
            seedKnowledge();
        }
    }
}
// ─── Recalculate trust scores AFTER server starts ────────────
// Deferred to avoid blocking startup. Existing scores remain valid
// until recalc completes (typically a few seconds after boot).
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
    // Initialize discovery service in background (non-blocking)
    // Registry registration involves network calls that can be slow/timeout
    discovery_service_1.discoveryService.initialize(BASE_URL).then(() => {
        console.log("[Discovery] Initialization complete");
    }).catch((err) => {
        console.warn("[Discovery] Initialization failed (non-fatal):", err);
    });
    console.log("");
    // Recalculate trust scores in background (non-blocking)
    // Uses setTimeout(0) so the event loop can handle incoming requests first.
    setTimeout(() => {
        try {
            console.log("📊 Recalculating trust scores (background)...");
            const trustResult = trust_score_service_1.trustScoreService.recalculateAll();
            console.log(`   ✅ Updated ${trustResult.updated} agents (avg: ${Math.round(trustResult.avgScore * 100)}%)`);
        }
        catch (err) {
            console.error("Trust recalc failed (non-fatal):", err);
        }
    }, 2000); // 2 second delay — let health checks pass first
});
// ─── Graceful shutdown ───────────────────────────────────────
process.on("SIGTERM", () => { discovery_service_1.discoveryService.shutdown(); (0, init_1.closeDb)(); process.exit(0); });
process.on("SIGINT", () => { discovery_service_1.discoveryService.shutdown(); (0, init_1.closeDb)(); process.exit(0); });
exports.default = app;
//# sourceMappingURL=index.js.map