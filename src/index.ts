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
} from "./middleware/security";
import producerRoutes from "./routes/producer";
import consumerRoutes from "./routes/consumer";
import scanRoutes from "./routes/scan";
import a2aRoutes from "./routes/a2a";
import reservationRoutes from "./routes/reservation";
import marketplaceRoutes from "./routes/marketplace";
import mcpRoutes from "./routes/mcp";
import seoRoutes from "./routes/seo";
import { analyticsService } from "./services/analytics-service";
import analyticsRoutes from "./routes/analytics";
import { seedData } from "./seed";
import { seedOsloRealData } from "./seed-oslo-real";
import { seedMarketplace } from "./seed-marketplace";
import { seedNorwayExpansion } from "./seed-norway-expansion";
import { seedExpansionV2 } from "./seed-expansion-v2";
import { seedExpansionV3 } from "./seed-expansion-v3";
import { seedExpansionV4 } from "./seed-expansion-v4";
import { seedExpansionV5 } from "./seed-expansion-v5";
import { seedExpansionV6 } from "./seed-expansion-v6";
import { seedExpansionV7 } from "./seed-expansion-v7";
import { seedExpansionV8 } from "./seed-expansion-v8";
import { discoveryService } from "./services/discovery-service";
import { trustScoreService } from "./services/trust-score-service";

// Dynamic import — seed-knowledge is a late addition and may not be
// present in every Docker layer during rolling deploys.  Graceful
// fallback prevents the entire process from crashing.
let seedKnowledge: (() => void) | undefined;
try {
  seedKnowledge = require("./seed-knowledge").seedKnowledge;
} catch {
  console.warn("⚠️  seed-knowledge module not found — skipping knowledge enrichment (will retry next deploy)");
}

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

// ─── OpenAPI spec (for Custom GPTs and developer docs) ──────
app.get("/openapi.yaml", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "openapi.yaml"));
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
app.use("/admin/analytics", analyticsRoutes);

// SEO pages LAST — /:city is a catch-all wildcard
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
  seedOsloRealData();
  seedMarketplace();
  seedNorwayExpansion();
  seedExpansionV2();
  seedExpansionV3();
  seedExpansionV4();
  seedExpansionV5();
  seedExpansionV6();
  seedExpansionV7();
  seedExpansionV8();
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

  // Run deduplication on existing data (one-time cleanup for the 429→370 issue)
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
    console.log(`🧹 Cleaned up ${dupeCount} duplicate agents from previous restarts`);
  }

  // Enrich knowledge if not already done
  if (seedKnowledge) {
    const knowledgeCount = (db.prepare("SELECT COUNT(*) as c FROM agent_knowledge").get() as any).c;
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
const trustResult = trustScoreService.recalculateAll();
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
  await discoveryService.initialize(BASE_URL);
  console.log("");
});

// ─── Graceful shutdown ───────────────────────────────────────
process.on("SIGTERM", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });
process.on("SIGINT", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });

export default app;
