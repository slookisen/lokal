import express from "express";
import cors from "cors";
import path from "path";
import { getDb, closeDb } from "./database/init";
import { loadConfigsAtBoot } from "./config/vertical-config";
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
  dentalLimiter,
} from "./middleware/security";
import producerRoutes from "./routes/producer";
import consumerRoutes from "./routes/consumer";
import scanRoutes from "./routes/scan";
import a2aRoutes from "./routes/a2a";
import reservationRoutes from "./routes/reservation";
import marketplaceRoutes from "./routes/marketplace";
import dentalRoutes from "./routes/dental";
import mcpRoutes from "./routes/mcp";
import seoRoutes from "./routes/seo";
import discoveryRoutes from "./routes/discovery";
import conversationUiRoutes from "./routes/conversation-ui";
import agentReadinessRoutes from "./routes/agent-readiness";
import { linkHeaders, markdownNegotiation } from "./middleware/agent-discovery";
import { langMiddleware } from "./i18n/middleware";
import { analyticsService, shouldRunAutoPrune } from "./services/analytics-service";
import analyticsRoutes from "./routes/analytics";
import agentStatsRoutes from "./routes/agent-stats";
import adminRunsRoutes from "./routes/admin-runs";
import adminAgentsRoutes from "./routes/admin-agents";
import adminOutreachPoolRoutes from "./routes/admin-outreach-pool";
import adminRunVerifierRoutes from "./routes/admin-run-verifier";
import adminRunPlatformVerifierRoutes from "./routes/admin-run-platform-verifier";
import adminVerifierSweepStatusRouter from "./routes/admin-verifier-sweep-status";
import ownerPortalRoutes from "./routes/owner-portal";
import adminAgentAuditRoutes from "./routes/admin-agent-audit";
import adminVerifierReviewQueueRoutes from "./routes/admin-verifier-review-queue";
import adminKnowledgeRoutes from "./routes/admin-knowledge";
import adminAffiliationsRoutes from "./routes/admin-affiliations";
import adminBmEventsRoutes from "./routes/admin-bm-events";
import adminBmReconcileRoutes from "./routes/admin-bm-reconcile";
import adminHanenRoutes, { publicRouter as publicHanenRoutes } from "./routes/admin-hanen";
import adminDebioCrossCheckRoutes from "./routes/admin-debio-cross-check";
import adminJobsRoutes from "./routes/admin-jobs";
import platformTriggersRoutes, { adminRouter as adminTriggersRoutes } from "./routes/platform-triggers";
import crmRoutes from "./routes/crm";
import { list as blocklistList } from "./services/blocklist-service";
import { bounceService } from "./services/bounce-service";
import { seedData } from "./seed";
// Seed files moved to src/_seeds/ — only loaded if DB is empty (see below).
import { discoveryService } from "./services/discovery-service";
import { trustScoreService } from "./services/trust-score-service";
import { syncDebioVerifications } from "./services/debio-verification-service";

// Seed-knowledge loaded dynamically — only used if DB is empty
let seedKnowledge: (() => void) | undefined;
try { seedKnowledge = require("./_seeds/seed-knowledge").seedKnowledge; } catch { /* ok */ }

// ─── Vertical config — Phase 4.1 ────────────────────────────
// Read verticals/<id>/config.yaml at boot. App refuses to start
// if YAML is malformed or schema validation fails. Must run before
// any service touches getConfig().
loadConfigsAtBoot();

if (process.env.ENABLE_DENTAL === "1") {
  // Lazy require so the dental module isn't pulled into the bundle
  // (and the dental.db file isn't opened) when the flag is off.
  const { getDb: getVerticalDb } = require("./database/db-factory");
  getVerticalDb("dental"); // triggers initDentalSchema(db) inside the factory
  console.log("[boot] dental vertical enabled — /app/data/dental.db ready");
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

// ─── Agent discovery ────────────────────────────────────────
// Link headers (RFC 8288) on every response — cheap, helps agents
// auto-discover our well-known endpoints without poking around.
app.use(linkHeaders);

// Markdown content negotiation — when an agent sends
// `Accept: text/markdown` on a content route, return markdown
// instead of HTML. Saves tokens, improves agent comprehension.
app.use(markdownNegotiation);

// Detect /en prefix → req.lang. Must run before any HTML route.
app.use(langMiddleware);

// ─── PR-109: finn-tannlege.com host routing ───────────────────────────
// Registered BEFORE agentReadinessRoutes, ownerPortalRoutes and
// express.static so dental-host requests never hit rfb portal pages
// or static assets (round-2 review fix: ownerPortal mounted at root
// would otherwise answer /eier/* and /magic-link-verify on dental host). Security/analytics middleware above already
// ran. API, health, and well-known paths pass through via next().
// Lazy-require so dental-seo only loads when ENABLE_DENTAL=1.
if (process.env.ENABLE_DENTAL === "1") {
  const DENTAL_HOSTS = new Set(["finn-tannlege.com", "www.finn-tannlege.com"]);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dentalSeoRouter = require("./routes/dental-seo").default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dentalA2aRouter = require("./routes/dental-a2a").default;

  app.use((req: any, res: any, next: any) => {
    const host = req.hostname;
    if (!DENTAL_HOSTS.has(host)) return next();

    // www → apex canonical redirect
    if (host === "www.finn-tannlege.com") {
      return res.redirect(301, `https://finn-tannlege.com${req.originalUrl}`);
    }

    // Pass API and health through to existing rfb routes.
    // NOTE: /.well-known/ is intentionally NOT passed through here —
    // dental has its own well-known surfaces (agent-card.json, openapi.json)
    // served by dental-seo and dental-a2a routers.
    const p = req.path;
    if (p.startsWith("/api/") || p === "/health") {
      return next();
    }

    // /mcp endpoint → dental Streamable HTTP MCP router (PR-114)
    // dentalMcpRouter applies its own rate limiting (dentalLimiter).
    if (p === "/mcp" || p.startsWith("/mcp/")) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const dentalMcpRouter = require("./routes/dental-mcp").default;
      return dentalMcpRouter(req, res, next);
    }

    // /a2a endpoint → dental A2A JSON-RPC router (mounted before dental-seo below)
    // dentalA2aRouter handles the /a2a prefix and applies its own rate limiting.
    if (p === "/a2a" || p.startsWith("/a2a/")) {
      return dentalA2aRouter(req, res, next);
    }

    // All other paths on dental hosts → dental-seo router
    return dentalSeoRouter(req, res, next);
  });
}


// Well-known discovery endpoints (MCP Server Card, Agent Skills,
// API Catalog, OAuth Protected Resource). Mounted BEFORE static
// so the .well-known/* paths are served dynamically, not from disk.
app.use("/", agentReadinessRoutes);

// ─── Owner Portal Routes (M1, Phase 5.4a) ───────────────────
// Magic-link auth + 7-field profile management for producers.
// Mounted at root because it serves both /api/agents/:id/* and /magic-link-verify.
app.use("/", ownerPortalRoutes);

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
// PR-106: dental vertical has its own per-IP quota (1000/15min) so
// 3 parallel dental-agent-enrichment workers can run without hitting
// the lower general-API limit. Must be mounted BEFORE generalLimiter
// so it's the first quota tannlege requests are accounted against.
// generalLimiter also `skip`s tannlege paths — see security.ts.
app.use("/api/tannlege", dentalLimiter);
// Everything else gets the general limiter
app.use("/api", generalLimiter);

// ─── Routes ──────────────────────────────────────────────────
app.use("/api/producers", producerRoutes);
app.use("/api/producers", scanRoutes);
app.use("/api/products", scanRoutes);
app.use("/api", consumerRoutes);
app.use("/api/reservations", reservationRoutes);
app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/tannlege", dentalRoutes);
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

// Dynamic memory limit: reads MEMORY_LIMIT_MB env var first,
// then falls back to cgroup memory.max (Fly.io/container), then 512 MB.
const MEMORY_LIMIT_MB = (() => {
  const env = Number(process.env.MEMORY_LIMIT_MB);
  if (env > 0) return env;
  try {
    const raw = require("fs").readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (raw !== "max") { const mb = Math.round(Number(raw) / 1024 / 1024); if (mb > 0) return mb; }
  } catch {}
  return 512;
})();

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

    if (memUsedMb > 420) { status = "critical"; warnings.push(`Memory critical: ${memUsedMb}MB / ${MEMORY_LIMIT_MB}MB`); }
    else if (memUsedMb > 350) { status = "warning"; warnings.push(`Memory high: ${memUsedMb}MB / ${MEMORY_LIMIT_MB}MB`); }

    if (dbLatencyMs > 3000) { status = "critical"; warnings.push(`DB slow: ${dbLatencyMs}ms`); }
    else if (dbLatencyMs > 1000) { if (status !== "critical") status = "warning"; warnings.push(`DB latency elevated: ${dbLatencyMs}ms`); }

    // PR-92 (2026-06-01): raised 200 → 400 MB. Daily auto-prune now keeps DB bounded.
    if (dbSizeMb > 400) { if (status !== "critical") status = "warning"; warnings.push(`DB large: ${dbSizeMb}MB`); }

    if (pvCount > 500000) { warnings.push(`analytics_page_views has ${pvCount} rows — consider pruning`); }

    const responseMs = Date.now() - startMs;

    res.json({
      status,
      warnings,
      service: "rettfrabonden",
      version: "1.0.0",
      git_sha: process.env.GIT_SHA || "unknown",
      uptime: uptimeSec,
      uptimeHuman: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`,
      bootedAt: BOOT_TIME,
      timestamp: new Date().toISOString(),
      memory: {
        rssMb: memUsedMb,
        heapUsedMb,
        heapTotalMb,
        limitMb: MEMORY_LIMIT_MB,
        pct: Math.round(memUsedMb / MEMORY_LIMIT_MB * 100),
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
app.use("/admin/runs", adminLimiter, adminRunsRoutes);
// PR-93: list agents by status + updated_since — unblocks verifier sweep
app.use("/admin/agents", adminLimiter, adminAgentsRoutes);
app.use("/admin/outreach-ready-pool", adminLimiter, adminOutreachPoolRoutes);
app.use("/admin/run-verifier", adminLimiter, adminRunVerifierRoutes);
// Phase 2: server-side platform-verifier (deterministic probe loop, dry_run default)
app.use("/admin/run-platform-verifier", adminLimiter, adminRunPlatformVerifierRoutes);
app.use("/admin/verifier/sweep-status", adminLimiter, adminVerifierSweepStatusRouter);
// ─── M1: Daniel-only agent audit trail (Phase 5.4a) ──────────
app.use("/admin/agent-audit", adminLimiter, adminAgentAuditRoutes);
app.use("/admin/verifier-review-queue", adminLimiter, adminVerifierReviewQueueRoutes);
// PR-24 (2026-05-11): enrichment write surface accepts field_provenance
app.use("/admin/knowledge", adminLimiter, adminKnowledgeRoutes);
// PR-58 (2026-05-16): C.1-C auto-tag enrichment — POST /admin/affiliations/auto-create
app.use("/admin/affiliations", adminLimiter, adminAffiliationsRoutes);
// PR-56 (2026-05-16): Bondens marked events scraper — POST /admin/bm-events/scrape
app.use("/admin/bm-events", adminLimiter, adminBmEventsRoutes);
// PR-123 (2026-06-06): BM canonical reconcile — GET /admin/bm-reconcile
app.use("/admin/bm-reconcile", adminLimiter, adminBmReconcileRoutes);
// Phase 5.11 C.2 (2026-05-16): Hanen member-scraping — POST /admin/hanen/scrape
app.use("/admin/hanen", adminLimiter, adminHanenRoutes);
// Phase 5.11 C.2 (2026-05-16): public Hanen members list — GET /api/marketplace/hanen/members
app.use("/api/marketplace/hanen", publicHanenRoutes);
// C.1-A (2026-05-16): Debio TRACES+Brreg cross-check — POST /admin/debio/cross-check
app.use("/admin/debio", adminLimiter, adminDebioCrossCheckRoutes);
// PR-65 (2026-05-17): in-memory job tracker for ?async=1 admin endpoints — GET /admin/jobs[/:id]
app.use("/admin", adminLimiter, adminJobsRoutes);

// Platform triggers — public webhook receiver + admin queue access.
// /platform/triggers/* uses HMAC (no admin-key); /admin/triggers/* uses admin-key.
// Same router file routes both; rate-limit applied via existing middleware below.
app.use("/platform", platformTriggersRoutes);
app.use("/admin", adminLimiter, adminTriggersRoutes);

// Serve the verifier dashboard HTML at /admin/verifier-dashboard
app.get("/admin/verifier-dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-verifier-dashboard.html"));
});

// CRM admin endpoints + page (feature-flagged via CRM_ENABLED env var; default ON)
if (process.env.CRM_ENABLED !== "0") {
  app.use("/admin/crm", crmRoutes);
  app.get("/admin/crm-dashboard", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin-crm.html"));
  });
  // Phase 4.10c — Sendt-logg: outbound message log with filters + duplicate detection
  app.get("/admin/sent-log", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin-sent-log.html"));
  });
}

// ─── GET /admin/blocklist (Phase 4.11 — work-order #3 step 4) ─────────
// Thin alias for /api/marketplace/admin/blocklist so verifier probes don't
// need to know the marketplace mount path. Adds an optional `since` filter
// (ISO8601) so verifier can ask "who got blocklisted since this run started?"
// without scanning the full table.
app.get("/admin/blocklist", adminLimiter, (req, res) => {
  const adminKey = req.headers["x-admin-key"] as string;
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) { res.status(503).json({ error: "Admin not configured" }); return; }
  if (!adminKey || adminKey !== expected) { res.status(403).json({ error: "Krever X-Admin-Key header" }); return; }
  try {
    const limit = parseInt(String(req.query.limit ?? "100"), 10) || 100;
    const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
    const sinceRaw = req.query.since ? String(req.query.since) : undefined;
    // Light validation: ISO8601 prefix
    const since = sinceRaw && /^\d{4}-\d{2}-\d{2}/.test(sinceRaw) ? sinceRaw : undefined;
    const rows = blocklistList({ limit, offset, since });
    res.json({ success: true, count: rows.length, since: since ?? null, entries: rows });
  } catch (err: any) {
    res.status(500).json({ error: "List failed", detail: err.message });
  }
});

// ─── /admin/email-bounces (Phase 4.14 / WO #6) ───────────────────────
// Mirror of Resend bounce events. ETL is intentionally minimal in this
// commit — backfill from Resend lives in a follow-up WO so the schema +
// query surface land first and marketing-comms can already exclude
// hard-bounces from candidate-pools as soon as data exists.
function requireAdmin(req: any, res: any): boolean {
  const adminKey = req.headers["x-admin-key"] as string;
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) { res.status(503).json({ error: "Admin not configured" }); return false; }
  if (!adminKey || adminKey !== expected) { res.status(403).json({ error: "Krever X-Admin-Key header" }); return false; }
  return true;
}

app.get("/admin/email-bounces", adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = parseInt(String(req.query.limit ?? "100"), 10) || 100;
    const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
    const sinceRaw = req.query.since ? String(req.query.since) : undefined;
    const since = sinceRaw && /^\d{4}-\d{2}-\d{2}/.test(sinceRaw) ? sinceRaw : undefined;
    const uninvestigatedOnly = req.query.uninvestigated === "true";
    const rows = uninvestigatedOnly
      ? bounceService.listUninvestigated({ limit, since })
      : bounceService.listAll({ limit, offset, since });
    res.json({
      success: true,
      count: rows.length,
      total: bounceService.countTotal(),
      since: since ?? null,
      entries: rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: "List failed", detail: err.message });
  }
});

app.patch("/admin/email-bounces/:id/investigated", adminLimiter, express.json(), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const outcome = String((req.body || {}).outcome || "");
  const allowed = ["alternative_found", "business_inactive", "blocklisted"] as const;
  if (!allowed.includes(outcome as any)) {
    res.status(400).json({ error: "outcome must be one of " + allowed.join(", ") });
    return;
  }
  try {
    const r = bounceService.markInvestigated({ id, outcome: outcome as any, notes: (req.body || {}).notes });
    if (!r.updated) { res.status(404).json({ error: "Bounce row not found" }); return; }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Update failed", detail: err.message });
  }
});

// Manual record endpoint — useful for the eventual webhook receiver and for
// admin-initiated entries (e.g. a known-dead address Daniel saw in Resend
// dashboard but isn't yet in our DB). Idempotent on (email, resend_email_id).
app.post("/admin/email-bounces", adminLimiter, express.json(), (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  const email = String(body.email || "").trim();
  const bouncedAt = String(body.bouncedAt || body.bounced_at || "").trim();
  if (!email || !bouncedAt) {
    res.status(400).json({ error: "email + bouncedAt required" });
    return;
  }
  try {
    const out = bounceService.record({
      email,
      bouncedAt,
      resendEmailId: body.resendEmailId || body.resend_email_id,
      bounceType: body.bounceType || body.bounce_type,
      reason: body.reason,
      agentIdAtSend: body.agentIdAtSend || body.agent_id_at_send,
      batchId: body.batchId || body.batch_id,
    });
    res.json({ success: true, ...out });
  } catch (err: any) {
    res.status(500).json({ error: "Record failed", detail: err.message });
  }
});

// Conversation UI — /samtaler and /samtale/:id (before SEO catch-all)
app.use("/", conversationUiRoutes);

// Public per-agent stats (powers visibility tiles + AI-conversation card on /produsent/<slug>)
app.use("/", agentStatsRoutes);

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

  // ─── PR-21 / WO-19 (2026-05-10): link-freshness backfill ────────────
  // On every boot, probe every agent currently in the outreach pool.
  // Worst case: 8s timeout × ~130 agents ≈ 17 min. Run AFTER trust-score
  // recalc + with a delay so health checks pass first. Non-blocking, so
  // a slow probe never holds up the server.
  //
  // Disable by setting RFB_DISABLE_URL_BACKFILL=1 (e.g. on dev / CI).
  if (process.env.RFB_DISABLE_URL_BACKFILL !== "1") {
    setTimeout(() => {
      console.log("[enrichment-backfill] starting URL freshness backfill (non-blocking)…");
      // Lazy-require so a syntax error in the verifier never blocks boot.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { runUrlBackfill } = require("./agents/lokal-agent-verifier");
      Promise.resolve()
        .then(() => runUrlBackfill())
        .catch((err: unknown) => {
          console.error("[enrichment-backfill] failed (non-fatal):", err);
        });
    }, 5000); // 5s delay — let health checks + trust recalc settle first
  }

  // ─── PR-92 (2026-06-01): daily analytics auto-prune ───────────────
  // Keeps the DB from growing unbounded (analytics_page_views adds
  // ~7–8 MB/day). Fires once per day inside the 03:00–03:59 UTC window
  // and skips if we already ran in the last 23h. Once a week (Sundays)
  // it also runs VACUUM to reclaim space SQLite can't reuse on its own.
  //
  // Disable on dev / CI with RFB_DISABLE_AUTO_PRUNE=1.
  if (process.env.RFB_DISABLE_AUTO_PRUNE !== "1") {
    let lastPruneAt: Date | null = null;
    const AUTO_PRUNE_DAYS_TO_KEEP = parseInt(process.env.RFB_AUTO_PRUNE_DAYS || "60", 10);

    const autoPruneTick = () => {
      const now = new Date();
      if (!shouldRunAutoPrune({ now, lastRunAt: lastPruneAt })) return;
      try {
        const result = analyticsService.runAutoPrune({ daysToKeep: AUTO_PRUNE_DAYS_TO_KEEP });
        console.log(
          `[auto-prune] daysToKeep=${result.daysKept} cutoff=${result.cutoff} ` +
          `deleted=${JSON.stringify(result.deleted)}`
        );
        lastPruneAt = now;

        // Weekly VACUUM — Sundays only. Briefly locks the DB.
        if (now.getUTCDay() === 0) {
          try {
            const v = analyticsService.vacuumDatabase();
            console.log(
              `[auto-prune] weekly VACUUM: ${v.sizeBeforeMb}MB → ${v.sizeAfterMb}MB ` +
              `(freed ${v.freedMb}MB)`
            );
          } catch (err) {
            console.error("[auto-prune] VACUUM failed (non-fatal):", err);
          }
        }
      } catch (err) {
        console.error("[auto-prune] failed (non-fatal):", err);
      }
    };

    // Check every hour. The shouldRunAutoPrune guard handles the rest.
    setInterval(autoPruneTick, 60 * 60_000);
  }
});

// ─── PR-95 (2026-06-01): daily Debio verification sync ──────────────
//
// Pulls https://finnoko.debio.no/api/acm/companies once per day (target:
// 04:00 UTC = 06:00 CEST) and updates agents.debio_verified for any
// producer that matches by website-domain or fuzzy-name.
//
// Implementation pattern mirrors PR-92's auto-prune scheduler: hourly
// wakeup, only fires inside the target UTC hour, debounced by the
// 23-hour gap so a server restart inside that hour doesn't double-run.
//
// Disable by setting RFB_DISABLE_DEBIO_SYNC=1 (e.g. on local dev / CI).
let lastDebioSyncAt: Date | null = null;
if (process.env.RFB_DISABLE_DEBIO_SYNC !== "1") {
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() !== 4) return; // fire only during 04:00 UTC window
    if (lastDebioSyncAt && (now.getTime() - lastDebioSyncAt.getTime()) < 23 * 3600_000) return;
    try {
      const result = await syncDebioVerifications();
      console.log(
        `[debio-sync] fetched=${result.fetched} matched=${result.matched} ` +
        `updated=${result.updated} newly=${result.newly_verified} ` +
        `still=${result.still_verified} errors=${result.errors.length}`,
      );
      if (result.errors.length > 0) {
        for (const e of result.errors) console.warn(`[debio-sync] ${e}`);
      }
      lastDebioSyncAt = now;
    } catch (err) {
      console.error("[debio-sync] failed:", err);
    }
  }, 60 * 60_000); // hourly check
}

// ─── PR-103 (2026-06-03): Backend dental geocoding worker ───────────
//
// Continuous Kartverket-based geocoding for dental_agents. First tick
// fires 30s after boot (lets the Fly volume mount + db-factory init
// settle); subsequent ticks run hourly. Each tick processes up to 50
// ungeocoded records. Zero LLM cost; replaces the Claude-based Stage A
// geocoding flow that never ran in prod due to a mode-selection bug.
//
// Disable on dev / CI with RFB_DISABLE_DENTAL_GEOCODE=1.
// Only fires when the dental vertical is actually enabled, otherwise
// the dental.db handle isn't open and we'd just be no-oping in a loop.
if (
  process.env.RFB_DISABLE_DENTAL_GEOCODE !== "1" &&
  process.env.ENABLE_DENTAL === "1"
) {
  // First tick at boot + 30s (lets the volume mount and db-factory init).
  setTimeout(async () => {
    try {
      const { geocodeTick } = await import("./services/dental-geocode-worker");
      const r = await geocodeTick(50);
      console.log(
        `[dental-geocode] boot-tick processed=${r.processed} ` +
        `high=${r.high} medium=${r.medium} low=${r.low} ` +
        `no_match=${r.no_match} errors=${r.errors} duration_ms=${r.duration_ms}`
      );
    } catch (err) {
      console.error("[dental-geocode] boot-tick failed:", err);
    }
  }, 30_000);

  // Subsequent ticks hourly.
  setInterval(async () => {
    try {
      const { geocodeTick } = await import("./services/dental-geocode-worker");
      const r = await geocodeTick(50);
      console.log(
        `[dental-geocode] tick processed=${r.processed} ` +
        `high=${r.high} medium=${r.medium} low=${r.low} ` +
        `no_match=${r.no_match} errors=${r.errors} duration_ms=${r.duration_ms}`
      );
    } catch (err) {
      console.error("[dental-geocode] tick failed:", err);
    }
  }, 60 * 60_000);
}

// ─── Graceful shutdown ───────────────────────────────────────
process.on("SIGTERM", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });
process.on("SIGINT", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });

export default app;
