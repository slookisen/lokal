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

// Dynamic import - seed-knowledge is a late addition and may not be
// present in every Docker layer during rolling deploys. Graceful
// fallback prevents the entire process from crashing.
let seedKnowledge: (() => void) | undefined;
try {
  seedKnowledge = require("./seed-knowledge").seedKnowledge;
} catch {
  console.warn("seed-knowledge module not found - skipping knowledge enrichment");
}

const app = express();
const PORT = process.env.PORT || 3000;

// Proxy trust - Fly.io terminates TLS via reverse proxy
app.set("trust proxy", true);

// Security Layer
app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(express.json({ limit: MAX_REQUEST_SIZE }));
app.use(sanitizeInput);

// Serve the marketplace dashboard
app.use(express.static(path.join(__dirname, "public")));

// Rate-limited routes
app.use("/a2a", jsonRpcLimiter);
app.use("/api/marketplace/register", registrationLimiter);
app.use("/api/marketplace/search", searchLimiter);
app.use("/api/marketplace/discover", searchLimiter);
app.use("/api", generalLimiter);

// Routes
app.use("/api/producers", producerRoutes);
app.use("/api/producers", scanRoutes);
app.use("/api/products", scanRoutes);
app.use("/api", consumerRoutes);
app.use("/api/reservations", reservationRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/", a2aRoutes);

// --- OpenAPI spec ---
app.get("/openapi.yaml", (_req, res) => {
  res.sendFile(path.join(__dirname, "..\", "openapi.yaml"));
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
// FIX: Seeds were running on every restart, causing duplicate agents.
// Fly.io restarts the app on deploy, autoscale, and idle-wakeup.
// Solution: Check if agents already exist before seeding.

console.log("\nInitializing SQLite database...");
const db = getDb();

const existingAgentCount = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;

if (existingAgentCount === 0) {
  console.log("Empty database detected - running initial seed...");
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
    console.log(`Removed ${dupeCount} duplicate agents after seeding`);
  }

  const finalCount = (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
  console.log(`Seeded ${finalCount} unique agents`);
} else {
  console.log(`Database already has ${existingAgentCount} agents - skipping seed`);

  // Run deduplication on existing data (one-time cleanup)
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
    console.log(`Cleaned up ${dupeCount} duplicate agents from previous restarts`);
  }

  // Enrich knowledge if not already done
  if (seedKnowledge) {
    const knowledgeCount = (db.prepare("SELECT COUNT(*) as c FROM agent_knowledge").get() as any).c;
    if (knowledgeCount === 0) {
      console.log("Running knowledge enrichment...");
      seedKnowledge();
    }
  }
}

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

  await discoveryService.initialize(BASE_URL);
  console.log("");
});

// Graceful shutdown
process.on("SIGTERM", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });
process.on("SIGINT", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });

export default app;
