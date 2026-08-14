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
  aiCrawlerAllowlist,
  consumerKeyIssuanceLimiter,
} from "./middleware/security";
import producerRoutes from "./routes/producer";
import consumerRoutes from "./routes/consumer";
import consumerKeysRoutes from "./routes/consumer-keys";
import { consumerIdentity } from "./middleware/consumer-identity";
import scanRoutes from "./routes/scan";
import a2aRoutes from "./routes/a2a";
import reservationRoutes from "./routes/reservation";
import marketplaceRoutes from "./routes/marketplace";
import { catalogRouter as marketplaceCatalogRouter, adminCatalogRouter } from "./routes/marketplace-catalog";
import { cartRouter, adminOrderRouter, producerOrderRouter } from "./routes/marketplace-cart";
import adminOrdersRoutes from "./routes/admin-orders";
import dentalRoutes from "./routes/dental";
import opplevelserRoutes from "./routes/opplevelser";
import mcpRoutes from "./routes/mcp";
import seoRoutes from "./routes/seo";
import discoveryRoutes from "./routes/discovery";
import conversationUiRoutes from "./routes/conversation-ui";
import agentReadinessRoutes from "./routes/agent-readiness";
import { linkHeaders, markdownNegotiation } from "./middleware/agent-discovery";
import { trackSelgerHtmlOpen } from "./middleware/analytics";
import { langMiddleware } from "./i18n/middleware";
import { analyticsService, shouldRunAutoPrune } from "./services/analytics-service";
import { mcpUsageLogger } from "./services/mcp-usage-logger";
import analyticsRoutes from "./routes/analytics";
import agentStatsRoutes from "./routes/agent-stats";
import adminRunsRoutes from "./routes/admin-runs";
import adminDbTableSizesRoutes from "./routes/admin-db-table-sizes";
import adminAgentsRoutes from "./routes/admin-agents";
import adminOutreachPoolRoutes from "./routes/admin-outreach-pool";
import adminOutreachCandidatesRoutes from "./routes/admin-outreach-candidates";
import adminRunVerifierRoutes, { runVerifierTick, isVerifierWindowHour } from "./routes/admin-run-verifier";
import adminLoopHeartbeatRoutes from "./routes/admin-loop-heartbeat";
import adminLoopDispatchRoutes, { runDispatchTick } from "./routes/admin-loop-dispatch";
import { resolveTickIntervalMin } from "./services/loop-dispatch";
import adminRunPlatformVerifierRoutes from "./routes/admin-run-platform-verifier";
import adminVerifierSweepStatusRouter from "./routes/admin-verifier-sweep-status";
import ownerPortalRoutes from "./routes/owner-portal";
import gardssalgClaimRoutes from "./routes/gardssalg-claim";
import adminAgentAuditRoutes from "./routes/admin-agent-audit";
import adminVerifierReviewQueueRoutes from "./routes/admin-verifier-review-queue";
import adminDomainCoherenceSweepRoutes from "./routes/admin-domain-coherence";
import adminWrongEntityRetroSweepRoutes from "./routes/admin-wrong-entity-retro-sweep";
import adminContactWriteGuardAuditRoutes from "./routes/admin-contact-write-guard-audit";
import adminContactWriteGuardRetroSweepRoutes from "./routes/admin-contact-write-guard-retro-sweep";
import adminAgentsContactEmailWriteRoutes from "./routes/admin-agents-contact-email-write";
import adminAgentsContactEmailDnsCheckRoutes from "./routes/admin-agents-contact-email-dns-check";
import adminAgentsUrlWriteRoutes from "./routes/admin-agents-url-write";
import adminAgentsDuplicateMergeRoutes from "./routes/admin-agents-duplicate-merge";
import adminAgentsDeactivateRoutes from "./routes/admin-agents-deactivate";
import adminRfbWebsiteDiscoveryRoutes from "./routes/admin-rfb-website-discovery";
import adminPoolBlockerExplainRoutes from "./routes/admin-pool-blocker-explain";
import adminHomepageProvenanceCohortRoutes from "./routes/admin-homepage-provenance-cohort";
import adminRfbContactExtractionRoutes from "./routes/admin-rfb-contact-extraction";
import adminCrmChimeraAgentClearRoutes from "./routes/admin-crm-chimera-agent-clear";
import adminDentalHjemmesideCleanupRoutes from "./routes/admin-dental-hjemmeside-cleanup";
import adminDentalMarkInactiveRoutes from "./routes/admin-dental-mark-inactive";
import adminDentalSchemaProbeSweepRoutes from "./routes/admin-dental-schema-probe-sweep";
import adminKnowledgeRoutes, { pruneUrlsRouter, homepageContentRefreshRouter, descriptionTruncationSweepRouter } from "./routes/admin-knowledge";
import adminSearchEnrichRoutes from "./routes/admin-search-enrich";
import adminAffiliationsRoutes from "./routes/admin-affiliations";
import adminBmEventsRoutes from "./routes/admin-bm-events";
import adminBmReconcileRoutes from "./routes/admin-bm-reconcile";
import adminBmProducerHarvestRoutes from "./routes/admin-bm-producer-harvest";
import adminHanenRoutes, { publicRouter as publicHanenRoutes } from "./routes/admin-hanen";
import adminDebioCrossCheckRoutes from "./routes/admin-debio-cross-check";
import adminSalgskanalRoutes from "./routes/admin-salgskanal";
import adminJobsRoutes from "./routes/admin-jobs";
import platformTriggersRoutes, { adminRouter as adminTriggersRoutes } from "./routes/platform-triggers";
import crmRoutes from "./routes/crm";
import { mountBillingRoutes } from "./routes/admin-billing";
import contactRouter from "./routes/contact";
import contactTrackingRoutes, { redirectRouter as contactRedirectRouter } from "./routes/contact-tracking";
import { list as blocklistList } from "./services/blocklist-service";
import { bounceService } from "./services/bounce-service";
import { seedData } from "./seed";
// Seed files moved to src/_seeds/ — only loaded if DB is empty (see below).
import { discoveryService } from "./services/discovery-service";
import { trustScoreService } from "./services/trust-score-service";
import { syncDebioVerifications } from "./services/debio-verification-service";
import { runSalgskanalSweep } from "./services/salgskanal-matcher";

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

if (process.env.ENABLE_EXPERIENCES === "1") {
  const { getDb: getVerticalDb } = require("./database/db-factory");
  getVerticalDb("experiences"); // triggers initExperiencesSchema inside the factory
  console.log("[boot] experiences vertical enabled — /data/experiences.db ready");
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

// ─── trailing slash → canonical URL (301) ───────────────────
// /bergen/ and /produsent/<slug>/ used to render 200 as duplicates of the
// slashless canonical; GSC 2026-07 listed ~700 such "alternate page with
// proper canonical tag" entries. A 301 consolidates them instead of leaving
// two crawlable copies of every page.
app.use((req, res, next) => {
  if ((req.method === "GET" || req.method === "HEAD") && req.path.length > 1 && req.path.endsWith("/")) {
    const query = req.originalUrl.slice(req.path.length);
    return res.redirect(301, req.path.replace(/\/+$/, "") + query);
  }
  next();
});

// ─── Security Layer ──────────────────────────────────────────
app.use(securityHeaders);
app.use(cors(corsOptions));
// `verify` stashes the exact raw request bytes on req.rawBody alongside the
// normal parsed req.body. Added for dev-request 2026-07-13-billing-skjelett-
// moerkt: Stripe webhook signature verification (routes/admin-billing.ts)
// needs the raw bytes — its HMAC is computed over them, not over a
// re-serialization of the parsed JSON — and this is the only place in the
// request pipeline where the raw stream is still available (the billing
// router mounts much later, after this global parser has already run).
// Harmless for every other route: they only ever read req.body as before.
app.use(express.json({
  limit: MAX_REQUEST_SIZE,
  verify: (req: any, _res, buf) => { req.rawBody = buf; },
}));
app.use(sanitizeInput);

// AI-crawler allowlist — mark known AI crawler UAs on safe read-only
// paths (llms.txt, sitemap.xml, /.well-known/*) so any scrape-hardening
// layer (current or future) lets them through. Also emits X-Robots-Tag: all.
app.use(aiCrawlerAllowlist);

// ─── Consumer-identity (dev-request 2026-07-13-agent-identity-usage-ledger,
// slice 1) — voluntary, free X-API-Key recognition for AI-agent consumers.
// Mounted ONCE, globally, before the dental/experiences host-routing gates
// below and before every rate limiter and MCP/A2A/REST router, so it covers
// all three domains uniformly (same "one shared middleware" pattern as
// aiCrawlerAllowlist just above). Absent header → next() immediately, no
// other effect whatsoever — see middleware/consumer-identity.ts.
app.use(consumerIdentity);

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
    //
    // The analytics dashboard + its read API also pass through so
    // finn-tannlege.com has its own per-site stats view at /admin/dashboard.
    // The analytics routes host-lock to vertical=dental (routes/analytics.ts
    // → lockedVerticalForHost), so no rfb/experiences data is reachable here.
    const p = req.path;
    if (
      p.startsWith("/api/") ||
      p === "/health" ||
      p === "/admin/dashboard" ||
      p.startsWith("/admin/analytics")
    ) {
      return next();
    }

    // /mcp endpoint → dental Streamable HTTP MCP router (PR-114)
    // dentalMcpRouter applies its own rate limiting (dentalLimiter).
    if (p === "/mcp" || p.startsWith("/mcp/")) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const dentalMcpRouter = require("./routes/dental-mcp").default;
      return mcpUsageLogger("mcp", "dental")(req, res, () => dentalMcpRouter(req, res, next));
    }

    // /a2a endpoint → dental A2A JSON-RPC router (mounted before dental-seo below)
    // dentalA2aRouter handles the /a2a prefix and applies its own rate limiting.
    if (p === "/a2a" || p.startsWith("/a2a/")) {
      return mcpUsageLogger("a2a", "dental")(req, res, () => dentalA2aRouter(req, res, next));
    }

    // All other paths on dental hosts → dental-seo router
    return dentalSeoRouter(req, res, next);
  });
}

// ─── Gårdssalg producer owner-claim (dev-request 2026-07-21-opplevagent-
// claim-flyt-drikkeprodusenter) ───────────────────────────────────────────
// Mounted HERE — before the opplevagent.no host-gate below — not at its
// original root-mount position further down (see the ownerPortalRoutes
// block after that host-gate). The host-gate's own catch-all 404 handler
// (experiences-seo.ts's trailing `router.use(...)`) swallows every
// opplevagent.no request that doesn't match one of its explicit pass-
// throughs (api/health/mcp/a2a) BEFORE it ever reaches a root-mounted
// router registered later in this file — so mounting gardssalgClaimRoutes
// after the host-gate (as originally done) made every
// /kategori/gardssalg/eier/* and /api/opplevelser/gardssalg-claim/* request
// 404 on opplevagent.no, the only host this feature is for. Confirmed live
// (2026-07-25) via curl against the deployed claim-entry page. Its path
// prefixes are unique to the experiences vertical and never collide with
// any RFB/dental route (same reasoning as before — see
// src/routes/gardssalg-claim.ts's module doc), so mounting it earlier, on
// every host, is still correct: it simply calls next() for every non-
// matching path, same as any other router.
app.use("/", gardssalgClaimRoutes);

// ─── orchestrator-pr-19: opplevagent.no host routing (experiences) ─────
// Mirrors the PR-109 dental host-gate exactly, for the experiences vertical.
// Registered BEFORE agentReadinessRoutes, ownerPortalRoutes and
// express.static so opplevagent-host requests never hit rfb portal pages
// or static assets (and never the rfb a2a/discovery routers mounted at root
// later). Security/analytics middleware above already ran. API and health
// paths pass through via next(); every other path is served by the
// experiences routers so NO rfb/dental content can leak onto opplevagent.no.
// Lazy-require so experiences-seo/-a2a only load when ENABLE_EXPERIENCES=1.
if (process.env.ENABLE_EXPERIENCES === "1") {
  const EXPERIENCES_HOSTS = new Set(["opplevagent.no", "www.opplevagent.no"]);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const experiencesSeoRouter = require("./routes/experiences-seo").default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const experiencesA2aRouter = require("./routes/experiences-a2a").default;

  app.use((req: any, res: any, next: any) => {
    const host = req.hostname;
    if (!EXPERIENCES_HOSTS.has(host)) return next();

    // www → apex canonical redirect
    if (host === "www.opplevagent.no") {
      return res.redirect(301, `https://opplevagent.no${req.originalUrl}`);
    }

    // Pass API and health through to existing routes (incl. /api/opplevelser/*).
    // NOTE: /.well-known/ is intentionally NOT passed through here —
    // experiences has its own well-known surfaces (agent-card.json) served
    // by experiences-seo and experiences-a2a routers.
    //
    // The analytics dashboard + its read API also pass through so
    // opplevagent.no has its own per-site stats view at /admin/dashboard.
    // The analytics routes host-lock to vertical=experiences (routes/analytics.ts
    // → lockedVerticalForHost), so no rfb/dental data is reachable here.
    const p = req.path;
    if (
      p.startsWith("/api/") ||
      p === "/health" ||
      p === "/admin/dashboard" ||
      p.startsWith("/admin/analytics")
    ) {
      return next();
    }

    // /mcp endpoint → experiences Streamable HTTP MCP router (orchestrator-pr-33)
    // experiencesMcpRouter applies its own rate limiting (jsonRpcLimiter).
    // Mounted BEFORE /a2a so a dental-style host-dispatch ordering is preserved
    // and opplevagent /mcp requests never fall through to rfb's /mcp router.
    if (p === "/mcp" || p.startsWith("/mcp/")) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const experiencesMcpRouter = require("./routes/experiences-mcp").default;
      return mcpUsageLogger("mcp", "experiences")(req, res, () => experiencesMcpRouter(req, res, next));
    }

    // /a2a endpoint → experiences A2A JSON-RPC router (mounted before
    // experiences-seo below). experiencesA2aRouter handles the /a2a prefix
    // and applies its own rate limiting (jsonRpcLimiter).
    if (p === "/a2a" || p.startsWith("/a2a/")) {
      return mcpUsageLogger("a2a", "experiences")(req, res, () => experiencesA2aRouter(req, res, next));
    }

    // All other paths on opplevagent hosts → experiences-seo router
    // (landing, llms.txt, robots.txt, sitemap.xml, agents.txt,
    //  agent-card.json, openapi.json, 404).
    return experiencesSeoRouter(req, res, next);
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

// (gardssalgClaimRoutes is mounted earlier — before the opplevagent.no
// host-gate above — see the comment there for why.)

// ─── orch-pr-20260714-claim-opened-instrumentation: /selger.html open tracking ──
// Registered BEFORE express.static so this exact path is tracked before
// falling through to the real static file (trackSelgerHtmlOpen always calls
// next(), so the file is still served byte-identical to before — same
// headers/content as every other file under src/public). This captures
// req.originalUrl (with the ?agent=<id> query string) so GET
// /admin/claim-funnel can report an "opened" stage. See
// src/middleware/analytics.ts for why this is a separate function from
// trackPageView() rather than a change to it.
app.get("/selger.html", trackSelgerHtmlOpen);

// Serve the marketplace dashboard
// redirect:false — serve-static's directory redirect builds its Location from
// originalUrl, so GET /en (which langMiddleware rewrites to "/", i.e. the
// static root itself) got 301'd to /en/ … which the trailing-slash middleware
// above bounces straight back: an infinite /en ⇄ /en/ loop. public/ is flat,
// so directory redirects are never wanted here.
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], redirect: false }));

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
// dev-request 2026-07-13-agent-identity-usage-ledger, slice 1: anti-spam
// quota on self-service key ISSUANCE only (same method+exact-path pattern
// as the adminLimiter line above) — /api/keys/revoke and /api/keys/erase
// are deliberately NOT covered by this quota, only generalLimiter below.
app.post("/api/keys", consumerKeyIssuanceLimiter);
app.post("/admin/analytics/prune", adminLimiter);
// PR-106: dental vertical has its own per-IP quota (1000/15min) so
// 3 parallel dental-agent-enrichment workers can run without hitting
// the lower general-API limit. Must be mounted BEFORE generalLimiter
// so it's the first quota tannlege requests are accounted against.
// generalLimiter also `skip`s tannlege paths — see security.ts.
app.use("/api/tannlege", dentalLimiter);
// Everything else gets the general limiter
app.use("/api", generalLimiter);
// dev-request 2026-07-03-agent-profile-conversations-stats slice 1:
// /ut/:agentId/:kind lives outside /api (it's a bare redirect URL meant to
// be pasted into profile pages), so it doesn't inherit the "/api" limiter
// above — give it the same shared generalLimiter explicitly instead of a
// bespoke one. (Same store/instance as the "/api" mount, so quota is
// shared across both — intentional, this is still just "general API-ish
// traffic" from one visitor's perspective.)
app.use("/ut", generalLimiter);
// dev-request 2026-07-25-reisesok…, review B1: the SSR /reise pages (seo.ts and
// experiences-seo.ts) are the only HTML routes that can trigger two geocodes,
// an outbound Mapbox call and a route-cache insert — and they live outside
// /api, so they inherited no limiter at all. A crawler walking distinct
// ?from=X&to=Y pairs would fill the route cache to its cap and burn free-tier
// Mapbox quota, in a process that also serves finn-tannlege.com and
// opplevagent.no. Mounted before the routers below so it actually wraps them.
// Same shared instance/quota as the "/api" mount above — from a visitor's
// perspective this is the same "general API-ish" traffic, and /reise is a query
// surface, not a document.
//
// One mount covers both languages: langMiddleware (mounted at :181, well above
// this line) rewrites req.url from "/en/reise" to "/reise" before any route or
// limiter sees it, so an explicit "/en/reise" mount here would be dead code.
// Verified against i18n/middleware.ts:34-41.
app.use("/reise", generalLimiter);

// ─── Routes ──────────────────────────────────────────────────
// Public contact form — mounted first so it's available on all 3 platform hosts.
// The endpoint only creates "kontaktskjema" CRM threads (minimum privilege).
app.use("/api", contactRouter);
// dev-request 2026-07-03-agent-profile-conversations-stats slice 1:
// contact-click intent tracking (table + endpoints only — no frontend
// wiring yet). POST beacon lives under /api/track; the counting redirect
// is a short top-level path (/ut/...) so it can be dropped straight into
// a profile page as an href, same style as a URL-shortener endpoint.
app.use("/api/track", contactTrackingRoutes);
app.use("/ut", contactRedirectRouter);
app.use("/api/producers", producerRoutes);
app.use("/api/producers", scanRoutes);
app.use("/api/products", scanRoutes);
app.use("/api", consumerRoutes);
// dev-request 2026-07-13-agent-identity-usage-ledger, slice 1: self-service
// consumer API-key issuance/revoke/erase. POST /api/keys is additionally
// rate-limited by consumerKeyIssuanceLimiter (mounted above, on the exact
// method+path) — revoke/erase stay unlimited beyond the shared
// generalLimiter below.
app.use("/api", consumerKeysRoutes);
app.use("/api/reservations", reservationRoutes);
app.use("/api/marketplace", marketplaceRoutes);
// Phase 0: product catalog feed + per-agent products (public) + backfill (admin)
app.use("/api/marketplace/catalog", marketplaceCatalogRouter);
// Phase 1: cart + order REST routes
app.use("/api/marketplace", cartRouter);
// dev-request 2026-07-13-pilot-ordre-loop: tokenized producer order confirm
// page (PRG). The confirm_token arrives only in the seller-notification
// email — GET renders, POST transitions.
app.use("/produsent/ordre", producerOrderRouter);
app.use("/api/tannlege", dentalRoutes);
app.use("/api/opplevelser", opplevelserRoutes);
app.use("/mcp", mcpUsageLogger("mcp", "rfb"), mcpRoutes);
app.use("/a2a", mcpUsageLogger("a2a", "rfb"));
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
// 2026-07-03 P1 (dev-requests/2026-06-30-platform-housekeeping-audit.md step 1):
// read-only DB table-size diagnostic — GET /admin/db/table-sizes
app.use("/admin/db", adminLimiter, adminDbTableSizesRoutes);
// PR-93: list agents by status + updated_since — unblocks verifier sweep
// POST /admin/agents/contact-email-write (dev-request 2026-08-01-rfb-contact-email-skrivespak, P0).
// MUST be mounted BEFORE /admin/agents: a future "/:id"-shaped route in
// adminAgentsRoutes would otherwise swallow "contact-email-write" as an id —
// the same ordering trap opplevelser.ts documents for its own admin routes.
app.use("/admin/agents/contact-email-write", adminLimiter, adminAgentsContactEmailWriteRoutes);
// POST /admin/agents/contact-email-dns-check — diagnostic-only DNS-liveness
// stamp on agent_knowledge.field_provenance.contact_email_dns_check. Same
// ordering rule as the sibling above — mount BEFORE /admin/agents.
app.use("/admin/agents/contact-email-dns-check", adminLimiter, adminAgentsContactEmailDnsCheckRoutes);
// POST /admin/agents/url-write (dev-request 2026-08-01-rfb-agents-url-skrivespak).
// Same ordering rule as the sibling above — mount BEFORE /admin/agents.
app.use("/admin/agents/url-write", adminLimiter, adminAgentsUrlWriteRoutes);
// POST /admin/agents/duplicate-merge — explicit-pair duplicate merge lever
// (dev-request duplicate-merge lever). Same ordering rule as the siblings
// above — mount BEFORE /admin/agents.
app.use("/admin/agents/duplicate-merge", adminLimiter, adminAgentsDuplicateMergeRoutes);
// POST /admin/agents/deactivate — standalone-row catalog-hygiene deactivate
// lever (dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype, Skive 8).
// Same ordering rule as the siblings above — mount BEFORE /admin/agents.
app.use("/admin/agents/deactivate", adminLimiter, adminAgentsDeactivateRoutes);
app.use("/admin/agents", adminLimiter, adminAgentsRoutes);
app.use("/admin/outreach-ready-pool", adminLimiter, adminOutreachPoolRoutes);
// orch-pr-20260614-3: suppression-gate candidates endpoint + sent-log backfill import
app.use("/admin/outreach-candidates", adminLimiter, adminOutreachCandidatesRoutes);
app.use("/admin/outreach-sent-log", adminLimiter, adminOutreachCandidatesRoutes);
app.use("/admin/run-verifier", adminLimiter, adminRunVerifierRoutes);
// P1 server-migration: deterministic loop watchdog — liveness from the
// run-ledger; ?alert=1 emails when a watcher is silent.
app.use("/admin/loop-heartbeat", adminLimiter, adminLoopHeartbeatRoutes);
// P2.5: deterministic /fire dispatcher (server-migration plan). Shadow-safe — only
// POSTs the routine /fire API when FIRE_ROUTINES is set AND mode=active.
app.use("/admin/loop-dispatch", adminLimiter, adminLoopDispatchRoutes);
// Phase 2: server-side platform-verifier (deterministic probe loop, dry_run default)
app.use("/admin/run-platform-verifier", adminLimiter, adminRunPlatformVerifierRoutes);
app.use("/admin/verifier/sweep-status", adminLimiter, adminVerifierSweepStatusRouter);
// ─── M1: Daniel-only agent audit trail (Phase 5.4a) ──────────
app.use("/admin/agent-audit", adminLimiter, adminAgentAuditRoutes);
app.use("/admin/verifier-review-queue", adminLimiter, adminVerifierReviewQueueRoutes);
// dev-request 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction (item 3):
// domain-coherence reconciliation sweep — reuses domainCoherenceCheck to
// classify the review_required cohort into auto-fixable/manual-review/
// circular-scramble buckets; dry-run by default, apply:true writes.
app.use("/admin/verifier/domain-coherence-sweep", adminLimiter, adminDomainCoherenceSweepRoutes);
// dev-request 2026-07-16-wrong-entity-opprydding-rfb: catalog-wide retro-sweep
// for MORE wrong-entity-contamination candidates using cheap DB-only
// detectors (email-domain vs website-domain mismatch, duplicate boilerplate
// opening-hours). Read-only / dry-run only — no apply mode, zero writes.
// GET /admin/wrong-entity-retro-sweep
app.use("/admin/wrong-entity-retro-sweep", adminLimiter, adminWrongEntityRetroSweepRoutes);
// dev-request 2026-07-28-rfb-kontaktekstraksjon-orgnr-som-telefon, criterion 5:
// read-only measurement sweep over the FULL agent_knowledge table (no cohort
// filter, all verticals) reporting how many EXISTING rows violate the
// write-time contact guard's rules (phone shape / org-nr collision / date
// shape / trailing address contact-label). Zero writes — no apply mode.
// GET /admin/contact-write-guard-audit
app.use("/admin/contact-write-guard-audit", adminLimiter, adminContactWriteGuardAuditRoutes);
// dev-request 2026-07-28-rfb-kontaktekstraksjon-orgnr-som-telefon, criterion 6:
// the CORRECTION half of the audit above. Dry-run by default (count + report,
// no writes); apply=true actually blanks rule-1/2/3 violating phones to NULL
// and rewrites rule-4 violating addresses to their stripped form — never
// touching an owner-claimed agent (claimed_at) or a curated_fields-locked
// field. "Apply krever Daniels godkjenning av tallet" — apply is a real write
// path but only ever invoked by a human after reviewing a dry-run's numbers.
// POST /admin/contact-write-guard-retro-sweep
app.use("/admin/contact-write-guard-retro-sweep", adminLimiter, adminContactWriteGuardRetroSweepRoutes);
// dev-request 2026-07-23-crm-house-bucket-kimaere-opprydding, slice 2: the
// live-data-cleanup half of PR #405 (that PR's own commit message flagged
// this as "a separate, non-code operational step, not part of this PR").
// Clears the ONE hardcoded chimera agent_knowledge row's Bondens-Kolonial-
// contaminated fields. Dry-run by default; apply=true writes.
// POST /admin/crm-chimera-agent-clear
app.use("/admin/crm-chimera-agent-clear", adminLimiter, adminCrmChimeraAgentClearRoutes);
// dev-request 2026-07-18-dental-hjemmeside-directory-portal-cleanup: moves
// directory/booking-portal/industry-association URLs out of dental_agents.
// hjemmeside into the additive directory_url column — dry-run by default,
// dry_run:false writes. POST /admin/dental/hjemmeside-cleanup-sweep
app.use("/admin/dental/hjemmeside-cleanup-sweep", adminLimiter, adminDentalHjemmesideCleanupRoutes);
// dev-request 2026-07-16-dental-hjemmeside-url-vask, item 2 (nedlagt-flagging):
// permanent inactive/closed-clinic flag applied by explicit caller-supplied
// ids (no live scraper — confirmed-closed list gathered manually via
// research). dry-run by default, dry_run:false writes.
// POST /admin/dental/mark-inactive
app.use("/admin/dental/mark-inactive", adminLimiter, adminDentalMarkInactiveRoutes);
// dev-request 2026-07-21-dental-schema-probe-writepath-fix, follow-up: finds
// + repairs dental_agents rows already contaminated by the test/probe
// fingerprint PR #323's write-path guard now blocks going forward — clears
// only the contaminated field(s) and flags needs_review for re-enrichment.
// dry-run by default, apply:true writes. POST /admin/dental/schema-probe-sweep
app.use("/admin/dental/schema-probe-sweep", adminLimiter, adminDentalSchemaProbeSweepRoutes);
// PR-24 (2026-05-11): enrichment write surface accepts field_provenance
app.use("/admin/knowledge", adminLimiter, adminKnowledgeRoutes);
// orch-pr-9 (2026-06-14): dead/junk URL prune — POST /admin/prune-dead-urls
app.use("/admin", adminLimiter, pruneUrlsRouter);
// PR-24a (2026-06-16): write homepage-sourced content over google_places — POST /admin/homepage-content-refresh (dry-run default)
app.use("/admin", adminLimiter, homepageContentRefreshRouter);
// dev-request 2026-07-01-cs-corrections-profile-quality item C: catalog-wide
// agents.description truncation sweep — GET (read-only diagnostic) + POST
// (dry-run default) /admin/description-truncation-sweep
app.use("/admin", adminLimiter, descriptionTruncationSweepRouter);
// dev-requests/2026-08-06-rfb-website-discovery-slice.md: candidate-homepage
// discovery for RFB `agents` rows with no website on file — queues verified
// proposals into agents_website_review_queue, never writes agents/
// agent_knowledge directly. POST /admin/rfb-website-discovery,
// GET /admin/rfb-website-review-queue (read-only, pending rows only).
app.use("/admin", adminLimiter, adminRfbWebsiteDiscoveryRoutes);
// dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype punkt 2: READ-ONLY
// per-agent gate diagnosis — names which pool-VIEW leg and which
// homepage-provenance-batch auto-select leg blocks a given agent, with the
// same predicates production uses. GET /admin/pool-blocker-explain.
app.use("/admin/pool-blocker-explain", adminLimiter, adminPoolBlockerExplainRoutes);
// dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype, Skive 3 follow-up:
// READ-ONLY, paginated listing of the agent IDs POST /admin/homepage-
// provenance-batch's default auto-select would pick next (identical
// predicate) — the enumeration primitive Skive 3's "batches of 25 until the
// cohort is exhausted" plan needed but never had. GET /admin/homepage-provenance-cohort.
app.use("/admin/homepage-provenance-cohort", adminLimiter, adminHomepageProvenanceCohortRoutes);
// dev-requests/2026-08-07-rfb-contact-extraction.md: corroborated contact-
// email extraction from a producer's own website for RFB `agents` rows whose
// contact_email is blank or DNS-flagged-dead — writes agents.contact_email
// (fill-or-replace-if-flagged-dead), never phone, never field_provenance.
// POST /admin/rfb-contact-extraction (dry-run default).
app.use("/admin", adminLimiter, adminRfbContactExtractionRoutes);
// orch-pr-10 (2026-06-14): per-producer Brave search→crawl→confirm→email — POST /admin/search-enrich (dry-run default)
app.use("/admin/search-enrich", adminLimiter, express.json(), adminSearchEnrichRoutes);
// PR-58 (2026-05-16): C.1-C auto-tag enrichment — POST /admin/affiliations/auto-create
app.use("/admin/affiliations", adminLimiter, adminAffiliationsRoutes);
// PR-56 (2026-05-16): Bondens marked events scraper — POST /admin/bm-events/scrape
app.use("/admin/bm-events", adminLimiter, adminBmEventsRoutes);
// PR-123 (2026-06-06): BM canonical reconcile — GET /admin/bm-reconcile
app.use("/admin/bm-reconcile", adminLimiter, adminBmReconcileRoutes);
app.use("/admin/bm-producer-harvest", adminLimiter, adminBmProducerHarvestRoutes);
// Phase 5.11 C.2 (2026-05-16): Hanen member-scraping — POST /admin/hanen/scrape
app.use("/admin/hanen", adminLimiter, adminHanenRoutes);
// Phase 5.11 C.2 (2026-05-16): public Hanen members list — GET /api/marketplace/hanen/members
app.use("/api/marketplace/hanen", publicHanenRoutes);
// C.1-A (2026-05-16): Debio TRACES+Brreg cross-check — POST /admin/debio/cross-check
app.use("/admin/debio", adminLimiter, adminDebioCrossCheckRoutes);
// dev-request 2026-07-06-rfb-salgskanal-kategorier: salgskanal auto-matcher sweep — POST /admin/salgskanal/sync
app.use("/admin/salgskanal", adminLimiter, adminSalgskanalRoutes);
// PR-65 (2026-05-17): in-memory job tracker for ?async=1 admin endpoints — GET /admin/jobs[/:id]
app.use("/admin", adminLimiter, adminJobsRoutes);
// Phase 0: admin product backfill endpoint
app.use("/admin/products", adminLimiter, adminCatalogRouter);
// Phase 1: admin order lifecycle transitions
app.use("/admin/marketplace", adminLimiter, adminOrderRouter);
// dev-request 2026-07-13-pilot-ordre-loop: notification opt-in + seller order inbox
app.use("/admin/orders", adminLimiter, adminOrdersRoutes);

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

// Billing skeleton (Produsent-Premium, test-mode Stripe) — dev-request
// 2026-07-13-billing-skjelett-moerkt. Feature-flagged via BILLING_ENABLED
// env var; default OFF (the OPPOSITE default of CRM_ENABLED above — this is
// a dark skeleton, not a live feature: flag unset/anything-but-"1" means
// zero routes mounted, zero behavior change). The flag check (plus the
// live-Stripe-key guard) lives inside mountBillingRoutes() itself
// (routes/admin-billing.ts) so it stays unit-testable without booting the
// whole app — this call is unconditional on purpose.
mountBillingRoutes(app);

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

// ─── dev-request 2026-07-06-rfb-salgskanal-kategorier: daily salgskanal ──
// auto-matcher sweep (datamodel + auto-matcher slice) ────────────────────
//
// Re-scans every active producer's name/description/tags/skills against
// the 5 salgskanal categories (Selvplukk/Hjemlevering/Gårdsbutikk/
// Gårdskafé-servering/REKO-ring) and keeps agent_salgskanal current — no
// external fetch involved (pure in-DB text scan), so this is cheap enough
// to run daily. Offset one hour from the Debio sync (05:00 UTC) purely to
// avoid the two jobs' SQLite writes overlapping.
//
// Implementation pattern mirrors PR-95's debio-sync scheduler immediately
// above: hourly wakeup, only fires inside the target UTC hour, debounced
// by the 23-hour gap so a restart inside that hour doesn't double-run.
// POST /admin/salgskanal/sync (admin-salgskanal.ts) runs the same sweep
// on demand.
//
// Disable by setting RFB_DISABLE_SALGSKANAL_SYNC=1 (e.g. on local dev / CI).
let lastSalgskanalSyncAt: Date | null = null;
if (process.env.RFB_DISABLE_SALGSKANAL_SYNC !== "1") {
  setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() !== 5) return; // fire only during 05:00 UTC window
    if (lastSalgskanalSyncAt && (now.getTime() - lastSalgskanalSyncAt.getTime()) < 23 * 3600_000) return;
    try {
      const result = runSalgskanalSweep();
      console.log(
        `[salgskanal-sync] examined=${result.examined} matched_total=${result.matched_total} ` +
        `upserted=${result.upserted} refreshed=${result.refreshed} removed_stale=${result.removed_stale} ` +
        `errors=${result.errors.length}`,
      );
      if (result.errors.length > 0) {
        for (const e of result.errors) console.warn(`[salgskanal-sync] ${e}`);
      }
      lastSalgskanalSyncAt = now;
    } catch (err) {
      console.error("[salgskanal-sync] failed:", err);
    }
  }, 60 * 60_000); // hourly check
}

// ─── dev-request 2026-08-13-verifier-rutine-stub-og-kadens: internal ─────
// hourly lokal-agent-verifier scheduler ───────────────────────────────
//
// The real verifier (src/agents/lokal-agent-verifier.ts) is supposed to run
// 9x/night (22:00-06:00 UTC, hourly) via POST /admin/run-verifier, but
// nothing drove it on that cadence — it only fired ~4x/night from incidental
// calls by other routines (declared_daily_rate=9, observed_daily_rate=4.0).
// This closes that gap the same way the debio-sync / salgskanal-sync blocks
// above do: hourly wakeup, self-gated on the window, calling the SAME code
// path admin-run-verifier.ts's POST / handler uses (runVerifierTick) rather
// than re-implementing it or doing an HTTP self-call.
//
// Gated OFF by default — only runs when VERIFIER_SCHEDULER_ENABLED=1 (see
// fly.toml). Any other value, or omitting the var, is a no-op.
let verifierTickRunning = false;
if (process.env.VERIFIER_SCHEDULER_ENABLED === "1") {
  setInterval(async () => {
    if (!isVerifierWindowHour(new Date().getUTCHours())) return;
    if (verifierTickRunning) {
      console.warn("[verifier-scheduler] tick skipped — a previous tick is still running");
      return;
    }
    verifierTickRunning = true;
    try {
      const r = await runVerifierTick({ batchSize: 30 });
      console.log(
        `[verifier-scheduler] run_id=${r.run_id} processed=${r.processed} passed=${r.passed} ` +
        `pending_verify=${r.pending_verify} review_required=${r.review_required} pool_added=${r.pool_added}`
      );
    } catch (err) {
      console.error("[verifier-scheduler] tick failed:", err);
    } finally {
      verifierTickRunning = false;
    }
  }, 60 * 60_000); // hourly check, self-gated on the 22-06 UTC window
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

// ─── dev-request 2026-07-04-opplevagent-naer-meg-geosok (item 1, 2026-07-10):
// Backend experiences geocoding worker ───────────────────────────────
//
// Continuous Kartverket-based geocoding for the experiences vertical.
// Mirrors the dental-geocode block immediately above: first tick fires
// 30s after boot (lets the Fly volume mount + db-factory init settle);
// subsequent ticks run hourly. Each tick geocodes up to 50 provider
// addresses, propagates provider locations down to their experiences,
// then falls back to kommune-centroid geocoding for any experiences
// still unresolved (unmatched to a provider, or provider address
// geocoding failed/pending).
//
// Disable on dev / CI with RFB_DISABLE_EXPERIENCES_GEOCODE=1.
// Only fires when the experiences vertical is actually enabled, otherwise
// the experiences.db handle isn't open and we'd just be no-oping in a loop.
if (
  process.env.RFB_DISABLE_EXPERIENCES_GEOCODE !== "1" &&
  process.env.ENABLE_EXPERIENCES === "1"
) {
  // First tick at boot + 30s (lets the volume mount and db-factory init).
  setTimeout(async () => {
    try {
      const { experiencesGeocodeTick } = await import("./services/experiences-geocode-worker");
      const r = await experiencesGeocodeTick(50);
      console.log(
        `[experiences-geocode] boot-tick processed=${r.providers_processed} ` +
        `high=${r.providers_high} medium=${r.providers_medium} low=${r.providers_low} ` +
        `no_match=${r.providers_no_match} provider_kommune_fallback=${r.providers_kommune_fallback} ` +
        `provider_fallback_unresolved=${r.providers_fallback_unresolved} ` +
        `addr_precision=${r.experiences_address_precision} ` +
        `kommune_precision=${r.experiences_kommune_precision} unresolved=${r.experiences_unresolved} ` +
        `upgraded_to_address=${r.experiences_upgraded_to_address} ` +
        `errors=${r.errors} duration_ms=${r.duration_ms}`
      );
    } catch (err) {
      console.error("[experiences-geocode] boot-tick failed:", err);
    }
  }, 30_000);

  // Subsequent ticks hourly.
  setInterval(async () => {
    try {
      const { experiencesGeocodeTick } = await import("./services/experiences-geocode-worker");
      const r = await experiencesGeocodeTick(50);
      console.log(
        `[experiences-geocode] tick processed=${r.providers_processed} ` +
        `high=${r.providers_high} medium=${r.providers_medium} low=${r.providers_low} ` +
        `no_match=${r.providers_no_match} provider_kommune_fallback=${r.providers_kommune_fallback} ` +
        `provider_fallback_unresolved=${r.providers_fallback_unresolved} ` +
        `addr_precision=${r.experiences_address_precision} ` +
        `kommune_precision=${r.experiences_kommune_precision} unresolved=${r.experiences_unresolved} ` +
        `upgraded_to_address=${r.experiences_upgraded_to_address} ` +
        `errors=${r.errors} duration_ms=${r.duration_ms}`
      );
    } catch (err) {
      console.error("[experiences-geocode] tick failed:", err);
    }
  }, 60 * 60_000);
}

// ─── dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok
// (Fase 1a): backend RFB agents geocoding worker ─────────────────────
//
// The RFB `agents` table was the only vertical without one — coordinates came
// from seed files and 551 of 1 499 active producers (36.8 %, measured
// 2026-07-25) had none at all, making them invisible to every geo-filtered
// search. Same shape as the dental and experiences blocks above: first tick
// 30s after boot, hourly after that, up to 50 rows per tick, each row's
// attempt timestamped so the worker rotates through the whole universe instead
// of re-processing the same head of the queue.
//
// Disable on dev / CI with RFB_DISABLE_AGENTS_GEOCODE=1. No ENABLE_* gate —
// unlike dental/experiences the RFB DB is always open (it IS the main DB).
// Manual/batched runs + dry-run: POST /api/marketplace/admin/agents/geocode-batch.
//
// THROUGHPUT FOLLOW-UP (2026-07-25 evening, Daniel: «veldig mange fortsatt står
// med ukjent opphav»): the boot-setTimeout + hourly-setInterval pair that used
// to be written out here is replaced by the worker's own ADAPTIVE scheduler.
// The hourly cadence meant 1 022 pending rows ÷ 50 per tick ≈ 20 HOURS, while
// a single row resolved in 432 ms — the schedule was the bottleneck, not the
// API. startAgentsGeocodeWorker() ticks every 60 s while a backlog exists and
// decays to the same hourly heartbeat once it is drained, so there is nothing
// to turn off afterwards. Rate is bounded independently by the shared 2 req/s
// budget in services/kartverket-budget.ts; the log line moved into the worker
// so the tick's shape and its logging cannot drift apart.
if (process.env.RFB_DISABLE_AGENTS_GEOCODE !== "1") {
  void import("./services/agents-geocode-worker")
    .then((m) => { m.startAgentsGeocodeWorker(); })
    .catch((err) => console.error("[agents-geocode] scheduler failed to start:", err));
}

// ─── dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok
// (Fase 1a follow-up): postal-code backfill worker ───────────────────
//
// Daniel: «Kan du lage en fiks for å finne postnummer på de som mangler kun
// dette?» — 13.2 % of active producers (measured, n=250 uniform random) have a
// real street address but no postnummer, which is the ONLY thing keeping them
// off the geocode worker's Tier A. This resolves the four digits from
// Kartverket (conservatively — it refuses on any ambiguity rather than write a
// postnummer that would become a precise-but-wrong coordinate); the geocode
// worker above then places them at address precision on its next pass.
//
// Same shape as the geocode block: first tick shortly after boot, hourly
// after that, up to 50 rows per tick, every attempt timestamped so the worker
// rotates through the whole queue instead of re-processing its head. The boot
// tick is deliberately offset to 45 s — 15 s behind the geocode worker's — so
// the two do not open their first burst of Kartverket requests simultaneously.
// The queue is ~200 rows total and shrinks as it succeeds, so this worker goes
// quiet on its own.
//
// Disable on dev / CI with RFB_DISABLE_POSTAL_BACKFILL=1.
// Manual/batched runs + dry-run: POST /api/marketplace/admin/agents/postal-backfill.
//
// Same adaptive scheduler as the geocode worker above (2 min while there are
// never-attempted rows, hourly otherwise). The boot delay stays at 45 s — 15 s
// behind the geocode worker — but that offset is now decoration rather than
// protection: both workers draw from ONE 2 req/s budget
// (services/kartverket-budget.ts), so overlapping is bounded by construction
// instead of by hoping two timers stay out of phase.
if (process.env.RFB_DISABLE_POSTAL_BACKFILL !== "1") {
  void import("./services/agents-postal-backfill")
    .then((m) => { m.startPostalBackfillWorker(); })
    .catch((err) => console.error("[postal-backfill] scheduler failed to start:", err));
}

// ─── booking-flyt-v1 slice 2 (dev-request 2026-07-14-booking-flyt-v1):
// pre-visit booking followups — producer reminder + auto-expiry ───────
//
// Hourly pass over gardssalg_bookings rows still awaiting a producer answer:
// one reminder after BOOKING_PREVISIT_REMINDER_HOURS (default 24) and
// automatic expiry + guest notification after BOOKING_PREVISIT_EXPIRE_HOURS
// (default 60, clamped 48–72) — a request must never die silently. The pass
// is idempotent (see processBookingFollowups()), so the hourly cadence is
// just "check often enough"; POST /api/opplevelser/admin/booking-followups
// runs the same function on demand. Producer emails inside go through the
// same dispatch gates as every other producer send (suppressed → logged).
//
// Mirrors the experiences-geocode scheduler above: gated on the experiences
// vertical being enabled (otherwise experiences.db isn't open), disable on
// dev / CI with RFB_DISABLE_BOOKING_FOLLOWUPS=1.
if (
  process.env.RFB_DISABLE_BOOKING_FOLLOWUPS !== "1" &&
  process.env.ENABLE_EXPERIENCES === "1"
) {
  setInterval(async () => {
    try {
      const { processBookingFollowups } = await import("./services/booking-store");
      const r = await processBookingFollowups();
      if (
        r.reminders_sent || r.reminders_suppressed ||
        r.expired || r.expired_guests_notified || r.errors
      ) {
        console.log(
          `[booking-followups] tick examined=${r.examined} reminders=${r.reminders_sent} ` +
          `suppressed=${r.reminders_suppressed} expired=${r.expired} ` +
          `guests_notified=${r.expired_guests_notified} errors=${r.errors}`
        );
      }
    } catch (err) {
      console.error("[booking-followups] tick failed:", err);
    }
  }, 60 * 60_000);
}

// ─── dev-request 2026-07-09-loop-dispatch-self-tick: dispatcher self-tick ───
//
// Ticks runDispatchTick("active") every ~10 min so the fleet's self-continue
// loop actually loops. Root cause (verified against the run-ledger 2026-07-09):
// a `next_suggested` envelope is only a wake candidate for 12 minutes
// (computeWakeList windowMin), but NOTHING ever POSTed /admin/loop-dispatch
// periodically — the "thin Fly Machine cron" promised in admin-loop-dispatch.ts's
// header was never built, so the only dispatches were event-wakes (~4/day) and
// every self-continue expired unfired. This closes that gap in-process, the
// same pattern as the 4 background jobs above (auto-prune / debio-sync /
// salgskanal-sync / dental-geocode).
//
// Self-stopping + quiet: an empty queue plans no wakes → the tick is a pure
// no-op (no envelope, no log — envelope is only recorded when something fired).
// Dedup/pacing reuse existing guards: fire-marker (#179), 25-min cooldown,
// maxWakes 4/tick, allowlist — all untouched.
//
// Kill-switch: DISPATCH_TICK_DISABLED=1 (env-only rollback, no deploy).
// Skipped entirely when FIRE_ROUTINES is unset (nothing could fire anyway —
// also keeps dev/CI silent). Interval override: DISPATCH_TICK_INTERVAL_MIN
// (clamped to [2, 120] by resolveTickIntervalMin).
if (process.env.DISPATCH_TICK_DISABLED === "1" || !process.env.FIRE_ROUTINES) {
  console.log(
    "[dispatch-tick] disabled — " +
    (process.env.DISPATCH_TICK_DISABLED === "1"
      ? "DISPATCH_TICK_DISABLED=1 (kill-switch)"
      : "FIRE_ROUTINES unset (nothing could fire)"),
  );
} else {
  const tickIntervalMin = resolveTickIntervalMin(process.env.DISPATCH_TICK_INTERVAL_MIN);
  console.log(`[dispatch-tick] enabled — runDispatchTick("active") every ${tickIntervalMin} min`);

  const dispatchTick = async (label: string) => {
    try {
      const r = await runDispatchTick("active");
      // Log only when the tick actually did something — a no-op tick every
      // ~10 min must not spam the logs (mirrors the envelope-only-on-fire rule).
      if (r.fired.length > 0 || r.deferred.length > 0) {
        console.log(
          `[dispatch-tick] ${label} candidates=${r.candidates} wake=${r.wake.length} ` +
          `fired_ok=${r.fired.filter((f) => f.ok).length} deferred=${r.deferred.length} ` +
          `envelope=${r.fired.length > 0 ? r.envelope_run_id : "none"}`,
        );
      }
    } catch (err) {
      console.error(`[dispatch-tick] ${label} failed (non-fatal):`, err);
    }
  };

  // dev-requests/2026-07-09-self-continue-cooldown-carveout.md: every deploy swaps
  // the Fly machine and resets the interval phase, so a next_suggested envelope
  // posted just before a deploy can go stale (past the 12-min freshness window)
  // before the first post-deploy interval tick. A boot-tick at +2min (after the
  // volume mount / db-factory settle, mirroring the dental-geocode boot-tick
  // pattern above) closes that gap without shortening the steady-state interval.
  setTimeout(() => { void dispatchTick("boot"); }, 2 * 60_000);

  setInterval(() => { void dispatchTick("interval"); }, tickIntervalMin * 60_000);
}

// ─── Graceful shutdown ───────────────────────────────────────
process.on("SIGTERM", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });
process.on("SIGINT", () => { discoveryService.shutdown(); closeDb(); process.exit(0); });

export default app;
