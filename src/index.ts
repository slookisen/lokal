import express from "express";
import cors from "cors";
import path from "path";
import { getDb, closeDb } from "./database/init";
import {
  securityHeaders,
  generalLimiter,
  jsonRpcLimiter,
  registrationLimiter,
  searchLimiter,
  sanitizeInput,
  corsOptions,
  MAX_REQUEST_SIZE,
  adminLimiter,
} from "./middleware/security";
import producerRoutes from "./routes/producer";
import consumerRoutes from "./routes/consumer";
import scanRoutes from "./routes/scan";
import a2aRoutes from "./routes/a2a";
import reservationRoutes from "./routes/reservation";
import marketplaceRoutes from "./routes/marketplace";
import mcpRoutes from "./routes/mcp";
import seoRoutes from "./routes/seo";
import discoveryRoutes from "./routes/discovery";
import conversationUiRoutes from "./routes/conversation-ui";
import agentReadinessRoutes from "./routes/agent-readiness";
import { linkHeaders, markdownNegotiation } from "./middleware/agent-discovery";
import { analyticsService } from "./services/analytics-service";
import analyticsRoutes from "./routes/analytics";
import crmRoutes from "./routes/crm";
import { seedData } from "./seed";
// Seed files moved to src/_seeds/ — only loaded if DB is empty (see below).
import { discoveryService } from "./services/discovery-service";
import { trustScoreService } from "./services/trust-score-service";

// Seed-knowledge loaded dynamically — only used if DB is empty
let seedKnowledge: (() => void) | undefined;
try { seedKnowledge = require("./_seeds/seed-knowledge").seedKnowledge; } catch { /* ok */ }

const app = express();
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
app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(express.json({ limit: MAX_REQUEST_SIZE }));
app.use(sanitizeInput);

// Analytics middleware (before routes, after security)
app.use(analyticsService.middleware());

// ─── Agent discovery ────────────────────────────────────────
// Link headers (RFC 8288) on every response — cheap, helps agents
// auto-discover our well-known endpoints without poking around.
app.use(linkHeaders);

// Markdown content negotiation — when an agent sends
// `Accept: text/markdown` on a content route, return markdown
// instead of HTML. Saves tokens, improves agent comprehension.
app.use(markdownNegotiation);

// Well-known discovery endpoints (MCP Server Card, Agent Skills,
// API Catalog, OAuth Protected Resource). Mounted BEFORE static
// so the .well-known/* paths are served dynamically, not from disk.
app.use("/", agentReadinessRoutes);

// Serve the marketplace dashboard
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// ─── Rate-limited routes ─────────────────────────────────────
// JSON-RPC gets its own limiter (agents are chatty)
app.use("/a2a", jsonRpcLimiter);
// Registration is heavily limited (anti-spam)
app.use("/api/marketplace/register", registrationLimiter);
// Search has its own tier
app.use("/api/marketplace/search", searchLimiter);
app.use("/api/marketplace/discover", searchLimiter);
// Admin/destructive endpoints get a strict limiter (10/hour)
app.use("/api/marketplace/admin", adminLimiter);
app.delete("/api/marketplace/agents/:id", adminLimiter);
app.post("/admin/analytics/prune", adminLimiter);
// Everything else gets the general limiter
app.use("/api", generalLimiter);

// ─── Routes ──────────────────────────────────────────────────
app.use("/api/producers", producerRoutes);
app.use("/api/producers", scanRoutes);
app.use("/api/products", scanRoutes);
app.use("/api", consumerRoutes);
app.use("/api/reservations", reservationRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/mcp", mcpRoutes);
app.use("/", a2aRoutes);

// ─── SPA dashboard (renamed from index.html to let SEO routes handle /) ──
app.get("/app", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

// ─── Analytics dashboard ────────────────────────────────────
app.get("/admin/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-dashboard.html"));
});

// ─── OpenAPI spec (for Custom GPTs and developer docs) ──────
app.get("/openapi.yaml", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "openapi.yaml"));
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
    try { dbSizeMb = Math.round(fs.statSync(dbPath).size / 1024 / 1024 * 10) / 10; } catch {}

    // Row counts for key tables
    const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE is_active = 1").get() as any).c;
    const pvCount = (db.prepare("SELECT COUNT(*) as c FROM analytics_page_views").get() as any).c;
    const queryCount = (db.prepare("SELECT COUNT(*) as c FROM analytics_queries").get() as any).c;

    // Recent activity (last hour)
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    const recentPv = (db.prepare("SELECT COUNT(*) as c FROM analytics_page_views WHERE created_at > ?").get(oneHourAgo) as any).c;

    // Uptime
    const uptimeSec = Math.floor(process.uptime());

    // Overall status based on thresholds
    let status: "healthy" | "warning" | "critical" = "healthy";
    const warnings: string[] = [];

    if (memUsedMb > 420) { status = "critical"; warnings.push(`Memory critical: ${memUsedMb}MB / 512MB`); }
    else if (memUsedMb > 350) { status = "warning"; warnings.push(`Memory high: ${memUsedMb}MB / 512MB`); }

    if (dbLatencyMs > 3000) { status = "critical"; warnings.push(`DB slow: ${dbLatencyMs}ms`); }
    else if (dbLatencyMs > 1000) { if (status !== "critical") status = "warning"; warnings.push(`DB latency elevated: ${dbLatencyMs}ms`); }

    if (dbSizeMb > 200) { if (status !== "critical") status = "warning"; warnings.push(`DB large: ${dbSizeMb}MB`); }

    if (pvCount > 500000) { warnings.push(`analytics_page_views has ${pvCount} rows — consider pruning`); }

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
  } catch (err) {
    res.status(500).json({
      status: "critical",
      warnings: [`Health check failed: ${err}`],
      timestamp: new Date().toISOString(),
      responseMs: Date.now() - startMs,
    });
  }
});

// Analytics admin endpoints
app.use("/admin/analytics", analyticsRoutes);

// CRM admin endpoints + page (feature-flagged via CRM_ENABLED env var; default ON)
if (process.env.CRM_ENABLED !== "0") {
  app.use("/admin/crm", crmRoutes);
  app.get("/admin/crm-dashboard", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin-crm.html"));
  });
}

// Conversation UI — /samtaler and /samtale/:id (before SEO catch-all)
app.use("/", conversationUiRoutes);

// SEO pages LAST — /:city is a catch-all wildcard
app.use("/", discoveryRoutes);  // llms.txt, MCP server-card, agents.txt, openapi.json
app.use("/", seoRoutes);

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
const db = getDb();

const existingAgentCount = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;

if (existingAgentCount === 0) {
  console.log("🌱 Empty database detected — running initial seed...");
  seedData();
  // Dynamic require for seed files (moved to _seeds/ to keep build clean)
  try {
    const seedFns = [
      "./_seeds/seed-oslo-real", "./_seeds/seed-marketplace", "./_seeds/seed-norway-expansion",
      "./_seeds/seed-expansion-v2", "./_seeds/seed-expansion-v3", "./_seeds/seed-expansion-v4",
      "./_seeds/seed-expansion-v5", "./_seeds/seed-expansion-v6", "./_seeds/seed-expansion-v7",
      "./_seeds/seed-expansion-v8"
    ];
    for (const mod of seedFns) {
      try { const m = require(mod); const fn = Object.values(m)[0] as Function; if (typeof fn === "function") fn(); }
      catch { /* seed file may not exist in Docker layer — ok */ }
    }
  } catch { /* seed loading failed — non-fatal */ }
  if (seedKnowledge) seedKnowledge();

  // Deduplicate: remove duplicate agents (keep oldest by created_at)
  const dupeCount = (db.prepare(`
    SELECT COUNT(*) as c FROM agents WHERE id NOT IN (
      SELECT MIN(id) FROM agents GROUP BY name, city
    )
  `).get() as any).c;

  if (dupeCount > 0) {
    db.prepare(`
      DELETE FROM agents WHERE id NOT IN (
        SELECT MIN(id) FROM agents GROUP BY name, city
      )
    `).run();
    console.log(`🧹 Removed ${dupeCount} duplicate agents after seeding`);
  }

  const finalCount = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
  console.log(`✅ Seeded ${finalCount} unique agents`);
} else {
  console.log(`✅ Database already has ${existingAgentCount} agents — skipping seed`);

  // Deduplication removed — data is already clean after initial cleanup.
  // Keeping the seed-path dedup for fresh databases only.

  // Enrich knowledge if not already done
  if (seedKnowledge) {
    const knowledgeCount = (db.prepare("SELECT COUNT(*) as c FROM agent_knowledge").get() as any).c;
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
  discoveryService.initialize(BASE_URL).then(() => {
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
      const trustResult = trustScoreService.recalculateAll();
      console.log(`   ✅ Updated ${trustResult.updated} agents (avg: ${Math.round(trustResult.avgScore * 100)}%)`);
    } catch (err) {
      console.error("Trust recalc failed (non-fatal):", err);
    }
  }, 2000); // 2 second delay — let health checks pass first
});

// ─── Graceful shutdown ───────────────────────────────────────
process.on("SIGTERM", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });
process.on("SIGINT", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });

export default app;
