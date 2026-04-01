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
import { seedKnowledge } from "./seed-knowledge";
import { discoveryService } from "./services/discovery-service";

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security Layer ──────────────────────────────────────────
app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(express.json({ limit: MAX_REQUEST_SIZE }));
app.use(sanitizeInput);

// Serve the marketplace dashboard
app.use(express.static(path.join(__dirname, "public")));

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
app.use("/", a2aRoutes);

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

// ─── Database + Seed ─────────────────────────────────────────
console.log("\n💾 Initializing SQLite database...");
getDb();
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
seedKnowledge();

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
  console.log(`\n   ── Discovery ────────────────────────────────`);

  // Initialize discovery service (registers with A2A registries if public URL)
  await discoveryService.initialize(BASE_URL);
  console.log("");
});

// ─── Graceful shutdown ───────────────────────────────────────
process.on("SIGTERM", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });
process.on("SIGINT", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });

export default app;
