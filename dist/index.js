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
// Dynamic import - seed-knowledge is a late addition and may not be
// present in every Docker layer during rolling deploys. Graceful
// fallback prevents the entire process from crashing.
let seedKnowledge;
try {
    seedKnowledge = require("./seed-knowledge").seedKnowledge;
}
catch {
    console.warn("seed-knowledge module not found - skipping knowledge enrichment");
}
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
// Proxy trust - Fly.io terminates TLS via reverse proxy
app.set("trust proxy", true);
// Security Layer
app.use(security_1.securityHeaders);
app.use((0, cors_1.default)(security_1.corsOptions));
app.use(express_1.default.json({ limit: security_1.MAX_REQUEST_SIZE }));
app.use(security_1.sanitizeInput);
// Serve seller dashboard at clean URL
app.get("/selger", (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, "public", "selger.html"));
});
app.use(express_1.default.static(path_1.default.join(__dirname, "public")));
// Rate-limited routes
app.use("/a2a", security_1.jsonRpcLimiter);
app.use("/api/marketplace/register", security_1.registrationLimiter);
app.use("/api/marketplace/search", security_1.searchLimiter);
app.use("/api/marketplace/discover", security_1.searchLimiter);
app.use("/api", security_1.generalLimiter);
// Routes
app.use("/api/producers", producer_1.default);
app.use("/api/producers", scan_1.default);
app.use("/api/products", scan_1.default);
app.use("/api", consumer_1.default);
app.use("/api/reservations", reservation_1.default);
app.use("/api/marketplace", marketplace_1.default);
app.use("/", a2a_1.default);
// Agent profile pages
app.get("/agent/:id", (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, "public", "agent.html"));
});
// SEO: Dynamic sitemap
app.get("/sitemap.xml", (_req, res) => {
    const { getDb: getSitemapDb } = require("./database/init");
    const sdb = getSitemapDb();
    const agents = sdb.prepare("SELECT id FROM agents WHERE is_active = 1").all();
    const baseUrl = process.env.BASE_URL || "https://lokal.fly.dev";
    const today = new Date().toISOString().split("T")[0];
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    xml += `  <url><loc>${baseUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority><lastmod>${today}</lastmod></url>\n`;
    for (const a of agents) {
        xml += `  <url><loc>${baseUrl}/agent/${a.id}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>\n`;
    }
    xml += `</urlset>`;
    res.set("Content-Type", "application/xml");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(xml);
});
// SEO: Robots.txt
app.get("/robots.txt", (_req, res) => {
    const baseUrl = process.env.BASE_URL || "https://lokal.fly.dev";
    res.set("Content-Type", "text/plain");
    res.send(`User-agent: *\nAllow: /\nAllow: /agent/\nDisallow: /api/\nDisallow: /a2a\n\nSitemap: ${baseUrl}/sitemap.xml\n`);
});
// Privacy Policy
app.get("/privacy", (_req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Lokal Privacy Policy</title></head><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px">
<h1>Privacy Policy</h1>
<p><strong>Lokal</strong> is a local food discovery platform for Norway.</p>
<p>We do not collect, store, or share any personal data from users of our API or Custom GPT integration.</p>
<p>All searches are anonymous and stateless. No cookies, no tracking, no user accounts required.</p>
<p>The API returns publicly available information about food producers in Norway.</p>
<p>Contact: da.fredriksen@gmail.com</p>
<p>Last updated: April 2026</p>
</body></html>`);
});
// OpenAPI spec
app.get("/openapi.yaml", (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, "..", "openapi.yaml"));
});
// Health check
app.get("/health", (_req, res) => {
    const stats = require("./services/marketplace-registry").marketplaceRegistry.getStats();
    res.json({
        status: "ok",
        service: "lokal",
        version: "0.4.0",
        database: "sqlite",
        agents: stats.totalAgents,
        uptime: Math.floor(process.uptime()),
    });
});
// Database + Seed (with idempotency guard)
console.log("\nInitializing SQLite database...");
const db = (0, init_1.getDb)();
const existingAgentCount = db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
if (existingAgentCount === 0) {
    console.log("Empty database detected - running initial seed...");
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
        console.log(`Removed ${dupeCount} duplicate agents after seeding`);
    }
    const finalCount = db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
    console.log(`Seeded ${finalCount} unique agents`);
}
else {
    console.log(`Database already has ${existingAgentCount} agents - skipping seed`);
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
        console.log(`Cleaned up ${dupeCount} duplicate agents from previous restarts`);
    }
    if (seedKnowledge) {
        const knowledgeCount = db.prepare("SELECT COUNT(*) as c FROM agent_knowledge").get().c;
        if (knowledgeCount === 0) {
            console.log("Running knowledge enrichment...");
            seedKnowledge();
        }
    }
}
// Recalculate trust scores on boot
console.log("Recalculating trust scores...");
const trustResult = trust_score_service_1.trustScoreService.recalculateAll();
console.log(`  Updated ${trustResult.updated} agents (avg: ${Math.round(trustResult.avgScore * 100)}%)`);
// Start
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const HOST = process.env.HOST || "0.0.0.0";
app.listen(Number(PORT), HOST, async () => {
    console.log(`\nLokal API v0.4.0 running at ${BASE_URL}`);
    console.log(`  Database: SQLite (persistent)`);
    console.log(`  Security: Helmet + Rate limiting + Input sanitization`);
    console.log(`  JSON-RPC: POST ${BASE_URL}/a2a`);
    console.log(`  Agent Card: GET ${BASE_URL}/.well-known/agent-card.json`);
    console.log(`  Register: POST ${BASE_URL}/api/marketplace/register`);
    console.log(`  Discover: POST ${BASE_URL}/api/marketplace/discover`);
    console.log(`  NL Search: GET ${BASE_URL}/api/marketplace/search?q=...`);
    await discovery_service_1.discoveryService.initialize(BASE_URL);
    console.log("");
});
// Graceful shutdown
process.on("SIGTERM", () => { discovery_service_1.discoveryService.shutdown(); (0, init_1.closeDb)(); process.exit(0); });
process.on("SIGINT", () => { discovery_service_1.discoveryService.shutdown(); (0, init_1.closeDb)(); process.exit(0); });
exports.default = app;
//# sourceMappingURL=index.js.map