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
const seed_1 = require("./seed");
const seed_oslo_real_1 = require("./seed-oslo-real");
const seed_norway_expansion_1 = require("./seed-norway-expansion");
const seed_expansion_v2_1 = require("./seed-expansion-v2");
const seed_expansion_v3_1 = require("./seed-expansion-v3");
const seed_expansion_v4_1 = require("./seed-expansion-v4");
const seed_expansion_v5_1 = require("./seed-expansion-v5");
const seed_expansion_v6_1 = require("./seed-expansion-v6");
const seed_expansion_v7_1 = require("./seed-expansion-v7");
const seed_expansion_v8_1 = require("./seed-expansion-v8");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
// ─── Security Layer ──────────────────────────────────────────
app.use(security_1.securityHeaders);
app.use((0, cors_1.default)(security_1.corsOptions));
app.use(express_1.default.json({ limit: security_1.MAX_REQUEST_SIZE }));
app.use(security_1.sanitizeInput);
// Serve the marketplace dashboard
app.use(express_1.default.static(path_1.default.join(__dirname, "public")));
// ─── Rate-limited routes ─────────────────────────────────────
// JSON-RPC gets its own limiter (agents are chatty)
app.use("/a2a", security_1.jsonRpcLimiter);
// Registration is heavily limited (anti-spam)
app.use("/api/marketplace/register", security_1.registrationLimiter);
// Search has its own tier
app.use("/api/marketplace/search", security_1.searchLimiter);
app.use("/api/marketplace/discover", security_1.searchLimiter);
// Everything else gets the general limiter
app.use("/api", security_1.generalLimiter);
// ─── Routes ──────────────────────────────────────────────────
app.use("/api/producers", producer_1.default);
app.use("/api/producers", scan_1.default);
app.use("/api/products", scan_1.default);
app.use("/api", consumer_1.default);
app.use("/api/reservations", reservation_1.default);
app.use("/api/marketplace", marketplace_1.default);
app.use("/", a2a_1.default);
// ─── Health check ────────────────────────────────────────────
app.get("/health", (_req, res) => {
    const stats = require("./services/marketplace-registry").marketplaceRegistry.getStats();
    res.json({
        status: "ok",
        service: "lokal",
        version: "0.11.0",
        database: "sqlite",
        agents: stats.totalAgents,
        uptime: Math.floor(process.uptime()),
    });
});
// ─── Database + Seed ─────────────────────────────────────────
console.log("\n💾 Initializing SQLite database...");
(0, init_1.getDb)();
(0, seed_1.seedData)();
(0, seed_oslo_real_1.seedOsloRealData)();
(0, seed_norway_expansion_1.seedNorwayExpansion)();
(0, seed_expansion_v2_1.seedExpansionV2)();
(0, seed_expansion_v3_1.seedExpansionV3)();
(0, seed_expansion_v4_1.seedExpansionV4)();
(0, seed_expansion_v5_1.seedExpansionV5)();
(0, seed_expansion_v6_1.seedExpansionV6)();
(0, seed_expansion_v7_1.seedExpansionV7)();
(0, seed_expansion_v8_1.seedExpansionV8)();
// ─── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🥬 Lokal API v0.11.0 running at http://localhost:${PORT}`);
    console.log(`   💾 Database: SQLite (persistent)`);
    console.log(`   🔒 Security: Helmet + Rate limiting + Input sanitization`);
    console.log(`\n   ── A2A Protocol ──────────────────────────────`);
    console.log(`   JSON-RPC:      POST http://localhost:${PORT}/a2a`);
    console.log(`   Agent Card:    GET  http://localhost:${PORT}/.well-known/agent.json`);
    console.log(`\n   ── Marketplace ──────────────────────────────`);
    console.log(`   Register:      POST http://localhost:${PORT}/api/marketplace/register`);
    console.log(`   Discover:      POST http://localhost:${PORT}/api/marketplace/discover`);
    console.log(`   NL Search:     GET  http://localhost:${PORT}/api/marketplace/search?q=...`);
    console.log(`   MCP Server:    npx lokal-mcp (for Claude Desktop)\n`);
});
// ─── Graceful shutdown ───────────────────────────────────────
process.on("SIGTERM", () => { (0, init_1.closeDb)(); process.exit(0); });
process.on("SIGINT", () => { (0, init_1.closeDb)(); process.exit(0); });
exports.default = app;
//# sourceMappingURL=index.js.map