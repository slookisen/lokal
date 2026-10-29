import express from "express";
import cors from "cors";
import path from "path";
import { getDb, closeDb } from "./database/init";
import { runTrafficHistoryJob, startTrafficHistoryScheduler } from "./services/traffic-history";
import { flushAiDeliveries, startAiDeliveriesFlusher } from "./services/profile-ai-deliveries";
import { runWalCheckpoints, getWalSizes } from "./services/wal-maintenance";
import { isNameFtsEnabled, syncAgentsNameFts } from "./services/name-search-fts";
import { createOffsiteBackupTick, getOffsiteBackupHealth, OFFSITE_TICK_MS } from "./services/offsite-backup";
import { getSearchConsolesHealth, startSearchConsoleScheduler } from "./services/search-console-fetch";
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
import { runProductCatalogSync } from "./services/product-catalog-sync";
import { cartRouter, adminOrderRouter, producerOrderRouter } from "./routes/marketplace-cart";
import adminOrdersRoutes from "./routes/admin-orders";
import orderActivationRoutes, { orderActivationAdminRouter } from "./routes/order-activation-link";
import dentalRoutes from "./routes/dental";
import opplevelserRoutes from "./routes/opplevelser";
import mcpRoutes from "./routes/mcp";
import { mcpIpEmergencyBrakeLimiter, mcpPrimaryLimiter, mcpCartToolLimiter } from "./middleware/mcp-rate-limit";
import { installClientIp, resolveClientIpConfig } from "./middleware/client-ip";
import seoRoutes from "./routes/seo";
import discoveryRoutes from "./routes/discovery";
import conversationUiRoutes from "./routes/conversation-ui";
import agentReadinessRoutes from "./routes/agent-readiness";
import { linkHeaders, markdownNegotiation } from "./middleware/agent-discovery";
import { trackSelgerHtmlOpen } from "./middleware/analytics";
import { langMiddleware } from "./i18n/middleware";
import { asPublicViewMiddleware } from "./middleware/as-public-view";
import { analyticsService, shouldRunAutoPrune } from "./services/analytics-service";
import { mcpUsageLogger } from "./services/mcp-usage-logger";
import { startEventLoopMonitor, requestTrackerMiddleware, trackJob, getEventLoopSummary } from "./services/event-loop-monitor";
import { startEventLoopPersistence, pruneEventLoopEvents } from "./services/event-loop-persist";
import { ensureNightIndexes } from "./services/night-indexes";
import { getPageViewHealthCounts } from "./services/health-counts";
import { computePageViewPruneLag, PRUNE_LAG_GRACE_DAYS } from "./services/health-counts-compute";
import { getRetentionWindowDays } from "./services/traffic-stats-compute";
import { getWritePathHealth } from "./services/health-write-probe";
import { getHealthCatalog, getHealthQueryCount } from "./services/health-cheap-counts";
import { MEMORY_LIMIT_MB, MEMORY_THRESHOLDS } from "./services/memory-thresholds";
import { prewarmTrafficStats } from "./services/traffic-stats";
import { AGENT_USAGE_PREWARM_INTERVAL_MS, prewarmAgentToolCalls } from "./services/agent-usage";
import { prewarmAgentStats } from "./services/agent-stats-reader";
import { sweepExpiredCartContactData } from "./services/cart-contact-sweep";
import analyticsRoutes from "./routes/analytics";
import agentStatsRoutes from "./routes/agent-stats";
import adminRunsRoutes from "./routes/admin-runs";
import adminDbTableSizesRoutes from "./routes/admin-db-table-sizes";
import adminDbBackupRoutes, { diskUsage, createBackupAgeSweepTick, BACKUP_AGE_SWEEP_TICK_MS } from "./routes/admin-db-backup";
import adminSearchConsolesRoutes from "./routes/admin-search-consoles";
import adminConversationsTrafficClassRoutes from "./routes/admin-conversations-traffic-class";
import adminCrossVerticalContactLookupRoutes from "./routes/admin-cross-vertical-contact-lookup";
import adminAgentsRoutes from "./routes/admin-agents";
import adminOutreachPoolRoutes from "./routes/admin-outreach-pool";
import adminOutreachCandidatesRoutes from "./routes/admin-outreach-candidates";
import adminOutreachMaxTouchVernRoutes from "./routes/admin-outreach-max-touch-vern";
import { rfbMarketingLaneRouter, rfbMarketingDailyRunRouter } from "./routes/admin-rfb-marketing";
import { tickRfbMarketingDaily } from "./services/rfb-marketing-daily";
import { rfbEnrichmentNightlyRouter } from "./routes/admin-rfb-enrichment-nightly";
import {
  isRfbEnrichmentNightlyEnabled,
  tickRfbEnrichmentNightly,
  RFB_ENRICHMENT_TICK_MS,
  RFB_ENRICHMENT_FIRST_TICK_MS,
} from "./services/rfb-enrichment-nightly";
import adminRunVerifierRoutes, { runVerifierTick, isVerifierWindowHour } from "./routes/admin-run-verifier";
import adminRunDentalVerifierRoutes from "./routes/admin-run-dental-verifier";
import { runDentalVerifierBatch } from "./services/dental-verifier";
import {
  shouldRunDentalVerifierScheduler,
  resolveDentalVerifierSchedulerBatchSize,
  DENTAL_VERIFIER_SCHEDULER_INTERVAL_MS,
} from "./services/dental-verifier-scheduler";
import adminSecondLineJudgePreviewRoutes from "./routes/admin-second-line-judge-preview";
import adminLoopHeartbeatRoutes from "./routes/admin-loop-heartbeat";
import adminLoopDispatchRoutes, { parseRoutines, runDispatchTick } from "./routes/admin-loop-dispatch";
import { resolveTickIntervalMin } from "./services/loop-dispatch";
import adminRunPlatformVerifierRoutes from "./routes/admin-run-platform-verifier";
import adminVerifierSweepStatusRouter from "./routes/admin-verifier-sweep-status";
import ownerPortalRoutes from "./routes/owner-portal";
import ownerFeaturesRoutes from "./routes/owner-features";
import ownerOrdersRoutes from "./routes/owner-orders";
import buyerOrderCardRoutes from "./routes/buyer-order-card";
import avmeldRoutes from "./routes/avmeld";
import gardssalgClaimRoutes, { GARDSSALG_CLAIM_PATH_PREFIXES, gardssalgClaimHostGate } from "./routes/gardssalg-claim";
import resendWebhookRoutes from "./routes/resend-webhook";
import { createAgentplatformHostGate } from "./routes/agentplatform-site";
import adminAgentAuditRoutes from "./routes/admin-agent-audit";
import adminVerifierReviewQueueRoutes from "./routes/admin-verifier-review-queue";
import adminDomainCoherenceSweepRoutes from "./routes/admin-domain-coherence";
import adminVerifierClaimCountsRoutes from "./routes/admin-verifier-claim-counts";
import adminProfileTranslationsRoutes from "./routes/admin-profile-translations";
import { startProfileTranslationsWorker, startProfileTranslationsStaleSweep } from "./services/profile-translations-worker";
import adminWrongEntityRetroSweepRoutes from "./routes/admin-wrong-entity-retro-sweep";
import adminContactWriteGuardAuditRoutes from "./routes/admin-contact-write-guard-audit";
import adminContactWriteGuardRetroSweepRoutes from "./routes/admin-contact-write-guard-retro-sweep";
import adminPhoneContextGateRetroScanRoutes from "./routes/admin-phone-context-gate-retro-scan";
import adminFieldSpotCheckRoutes from "./routes/admin-field-spot-check";
import adminAgentsContactEmailWriteRoutes from "./routes/admin-agents-contact-email-write";
import adminAgentsContactEmailDnsCheckRoutes from "./routes/admin-agents-contact-email-dns-check";
import adminAgentsUrlWriteRoutes from "./routes/admin-agents-url-write";
import adminAgentsDescriptionCodeArtifactSweepRoutes from "./routes/admin-agents-description-code-artifact-sweep";
import adminAgentsInternalNoteSweepRoutes from "./routes/admin-agents-internal-note-sweep";
import adminAgentsContentCorrectionRoutes from "./routes/admin-agents-content-correction";
import adminAgentsThemeSpamSweepRoutes from "./routes/admin-agents-theme-spam-sweep";
import adminAgentsCategoryDescriptionProvenanceAuditRoutes from "./routes/admin-agents-category-description-provenance-audit";
import adminAgentsFylkeContradictionAuditRoutes from "./routes/admin-agents-fylke-contradiction-audit";
import adminDrinkCoverageRoutes from "./routes/admin-drink-coverage";
import adminEnrichmentWritePauseRoutes from "./routes/admin-enrichment-write-pause";
import adminAgentsDuplicateMergeRoutes from "./routes/admin-agents-duplicate-merge";
import adminAgentsDeactivateRoutes from "./routes/admin-agents-deactivate";
import adminAgentsBusinessTypeRoutes from "./routes/admin-agents-business-type";
import adminTestProducerRoutes from "./routes/admin-test-producer";
import adminOwnerFeaturesInterestRoutes from "./routes/admin-owner-features-interest";
import adminOwnerFeaturesSwitchProbeRoutes from "./routes/admin-owner-features-switch-probe";
import adminAgentsClaimBackfillRoutes from "./routes/admin-agents-claim-backfill";
import adminAgentsTerminalReparkRoutes from "./routes/admin-agents-terminal-repark";
import adminAgentsDuplicateSlugsRoutes from "./routes/admin-agents-duplicate-slugs";
import adminRfbWebsiteDiscoveryRoutes from "./routes/admin-rfb-website-discovery";
import adminRfbBrregSelfSufficiencyRoutes from "./routes/admin-rfb-brreg-selfsufficiency";
import adminPoolBlockerExplainRoutes from "./routes/admin-pool-blocker-explain";
import adminHomepageProvenanceCohortRoutes from "./routes/admin-homepage-provenance-cohort";
import adminDodBulkRoutes from "./routes/admin-dod-bulk";
import adminRfbContactExtractionRoutes from "./routes/admin-rfb-contact-extraction";
import adminAgentsPendingVerifyUnparkRoutes from "./routes/admin-agents-pending-verify-unpark";
import adminCrmChimeraAgentClearRoutes from "./routes/admin-crm-chimera-agent-clear";
import adminCrmChimeraContactsDiagnoseRoutes from "./routes/admin-crm-chimera-contacts-diagnose";
import adminDentalHjemmesideCleanupRoutes from "./routes/admin-dental-hjemmeside-cleanup";
import adminDentalMarkInactiveRoutes from "./routes/admin-dental-mark-inactive";
import adminDentalHjemmesideDiscoveryRoutes from "./routes/admin-dental-hjemmeside-discovery";
import adminDentalCatalogClassRoutes from "./routes/admin-dental-catalog-class";
import adminDentalWrongEntityRetroSanitizeRoutes from "./routes/admin-dental-wrong-entity-retro-sanitize";
import adminDentalCatalogClassSonnetSampleRoutes from "./routes/admin-dental-catalog-class-sonnet-sample";
import adminDentalBrregAddressSweepRoutes from "./routes/admin-dental-brreg-address-sweep";
import adminDentalOffentligKlinikkHjemmesideKorrigeringRoutes from "./routes/admin-dental-offentlig-klinikk-hjemmeside-korrigering";
import adminDentalSchemaProbeSweepRoutes from "./routes/admin-dental-schema-probe-sweep";
import adminKnowledgeRoutes, { pruneUrlsRouter, homepageContentRefreshRouter, descriptionTruncationSweepRouter, addressNorgeSuffixSweepRouter } from "./routes/admin-knowledge";
import adminSearchEnrichRoutes from "./routes/admin-search-enrich";
import adminAffiliationsRoutes from "./routes/admin-affiliations";
import adminBmEventsRoutes from "./routes/admin-bm-events";
import adminBmReconcileRoutes from "./routes/admin-bm-reconcile";
import adminBmProducerHarvestRoutes from "./routes/admin-bm-producer-harvest";
import adminHanenRoutes, { publicRouter as publicHanenRoutes } from "./routes/admin-hanen";
import adminDebioCrossCheckRoutes from "./routes/admin-debio-cross-check";
import adminSalgskanalRoutes from "./routes/admin-salgskanal";
import adminJobsRoutes from "./routes/admin-jobs";
import adminProductImportRoutes from "./routes/admin-product-import";
import platformTriggersRoutes, { adminRouter as adminTriggersRoutes } from "./routes/platform-triggers";
import crmRoutes from "./routes/crm";
import { mountBillingRoutes } from "./routes/admin-billing";
import { mountPaymentRoutes, mountPaymentWebhook } from "./routes/payments";
import contactRouter from "./routes/contact";
import contactTrackingRoutes, { redirectRouter as contactRedirectRouter } from "./routes/contact-tracking";
import { list as blocklistList } from "./services/blocklist-service";
import { bounceService } from "./services/bounce-service";
import { seedData } from "./seed";
// Seed files moved to src/_seeds/ — only loaded if DB is empty (see below).
import { discoveryService } from "./services/discovery-service";
import { trustScoreService, TRUST_SCORE_FORMULA_VERSION } from "./services/trust-score-service";
import {
  runExclusiveBootJob, getJobLastCompletedAt, markJobCompleted, shouldSkipRecentRun,
  resolveMinIntervalHours, URL_BACKFILL_JOB, URL_BACKFILL_BOOT_DELAY_MS,
  scheduleBootTrustRecalc, TRAFFIC_PREWARM_BOOT_DELAY_MS, DENTAL_GEOCODE_BOOT_DELAY_MS,
  EXPERIENCES_GEOCODE_BOOT_DELAY_MS,
} from "./services/boot-job-gate";
import { syncDebioVerifications } from "./services/debio-verification-service";
import { syncDebioRegister, debioRegisterSyncEnabled, enforceDebioRegisterFreshness } from "./services/debio-register-sync";
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

// ─── Proxy trust + client IP (dev-request 2026-10-16-klient-ip-fra-fly-client-ip) ───
// Fly.io terminates TLS and forwards requests via its proxy, which appends
// to X-Forwarded-For. installClientIp() sets `trust proxy` = true — trust
// EVERY hop, NOT "the first hop": req.ip is the left-most X-Forwarded-For
// entry, and req.protocol/req.secure follow the proxy — and mounts
// middleware/client-ip.ts, which in mode `enforce` rewrites X-Forwarded-For
// to Fly's own Fly-Client-IP, so a client can no longer pick its own req.ip
// (and a fresh bucket on every IP-keyed limiter) by sending that header.
// Mode: CLIENT_IP_MODE (legacy | shadow | enforce), default
// CLIENT_IP_MODE_DEFAULT; always legacy, i.e. today's behaviour, off Fly.
// Mounted FIRST — before requestTrackerMiddleware, the www redirect, the host
// gates and every limiter — so everything that reads req.ip sees the
// normalized value (pinned by client-ip.test.ts). Never set `trust proxy`
// anywhere else, and never to 1, 2 or a subnet (see installClientIp).
// A CDN or another proxy in front of Fly breaks this design's premise
// (Fly-Client-IP would be the CDN's address): revise middleware/client-ip.ts
// BEFORE any such DNS switch.
installClientIp(app, resolveClientIpConfig(process.env));

// ─── Event-loop stall monitor (dev-request 2026-09-19-prod-event-loop-stall-
// mcp-unhealthy) ────────────────────────────────────────────────
// Observability only: records when the single event loop every host shares is
// blocked, together with the requests in flight and the background jobs
// running at that moment. Mounted right after installClientIp (whose
// middleware is synchronous and only reads/rewrites headers), so every request
// on every host is in the in-flight set. Details: src/services/event-loop-monitor.ts.
// Report: GET /admin/analytics/ops/event-loop. Kill switch: EVENT_LOOP_MONITOR_DISABLED=1.
startEventLoopMonitor();
// Slice 1 of 2026-10-08-serverheng…: persist stalls/slow requests/slow jobs to
// event_loop_events (buffered, flushed every 5 s; DB resolved lazily at flush).
startEventLoopPersistence({
  getDb: () => getDb(),
  gitSha: process.env.GIT_SHA || "unknown",
  bootedAt: new Date().toISOString(),
});
app.use(requestTrackerMiddleware);

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

// ─── agentplatform.no host routing (company site) ───────────────────────
// A2A dev-request 2026-10-08-agentplatform-no-paraplyside. The umbrella page
// for Agentplatform.no AS, which owns the three services. Mounted HERE —
// after security headers/CORS but BEFORE analytics, Link headers and every
// rfb/dental/experiences router — so (a) a visit is never logged as rfb
// traffic (getVerticalFromHost defaults to rfb) and the page stays cookie-
// and tracking-free as its /personvern says, and (b) nothing else answers on
// this host: no /api, /mcp, /a2a or /.well-known passes through; unknown
// paths get the site's own 404. Other hosts fall straight through.
app.use(createAgentplatformHostGate());

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

// «Vis som offentlig» (dev-request 2026-10-22-rfb-mine-valg-eierbrytere S2d-2):
// X-Admin-Key + ?as_public=1 on a public RFB surface → the hidden test fixture
// is evaluated as public (no-store, noindex). After langMiddleware so /en paths
// are matched stripped; anything else passes through untouched.
app.use(asPublicViewMiddleware);

// ─── POST /webhooks/resend (owner decision 2026-09-29 «Blacklist bounces») ──
// Svix-signed Resend events → email_bounces only (hard bounce / spam
// complaint; suppresses outreach, never ordering/registration — owner
// decision «1B», no agent_blocklist row). Mounted HERE — after express.json (needs req.rawBody) but
// BEFORE the dental/opplevagent host gates and every admin/auth router, so
// nothing can 404/403 it first. Path is unique; every other request falls
// straight through. Auth = Svix signature (RESEND_WEBHOOK_SECRET; unset → 503).
// See routes/resend-webhook.ts + services/resend-webhook.ts.
app.use("/", resendWebhookRoutes);

// ─── /avmeld/:token — working unsubscribe for cold outreach (S1a point 3,
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere). 404 unless
// OUTREACH_UNSUBSCRIBE_ENABLED. Mounted here so no host gate can swallow the
// one-click POST. See routes/avmeld.ts.
app.use("/", avmeldRoutes);

// ─── POST /webhooks/stripe-connect (prepayment, A2A dev-request
// 2026-10-09-rfb-forhandsbetaling-stripe-connect) ───────────────────────
// Stripe Connect events (accounts, payments on producers' own accounts).
// Same placement and reasoning as /webhooks/resend: after express.json
// (needs req.rawBody), before host gates and every /api limiter. Auth =
// Stripe signature (STRIPE_CONNECT_WEBHOOK_SECRET; unset → 503). Mounts
// nothing unless PAYMENTS_ENABLED=1 (routes/payments.ts).
mountPaymentWebhook(app);

// ─── Gårdssalg owner-claim host gate (dev-request 2026-10-17-
// integrasjonstest-oppfolging, I-U) ───────────────────────────────────────
// gardssalgClaimRoutes (mounted below, between the two host gates) used to
// answer on every host, ahead of every limiter: rettfrabonden.com served the
// claim pages. This gate runs first on the claim paths. They are served on
// opplevagent.no only; on any other host GET/HEAD get a 301 to the same path
// and query on https://opplevagent.no, every other method a 404, and the
// router is not reached. Mounted above the finn-tannlege.com gate, which hands
// /kategori/* to dental-seo and passes /api/* through, so that host answers
// like the others; agentplatform.no's own gate runs earlier and keeps its 404.
// Rate limiting is on the claim routes themselves (generalLimiter first on
// each, see routes/gardssalg-claim.ts), so a served claim request is counted
// once and never reaches the "/api" generalLimiter mount further down.
app.use(GARDSSALG_CLAIM_PATH_PREFIXES, gardssalgClaimHostGate);

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
    // dentalMcpRouter applies its own rate limiting: its own per-session
    // chain from middleware/mcp-rate-limit.ts, not dentalLimiter. It runs
    // after mcpUsageLogger, so its 429s are logged.
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
// src/routes/gardssalg-claim.ts's module doc), so mounting it earlier is
// still correct: it simply calls next() for every non-matching path, same as
// any other router. It still sees every host's requests, but on the claim
// paths only opplevagent.no's get past gardssalgClaimHostGate (above the
// finn-tannlege.com gate, I-U).
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
    // experiencesMcpRouter applies its own rate limiting: its own per-session
    // chain from middleware/mcp-rate-limit.ts, not the /a2a jsonRpcLimiter. It
    // runs after mcpUsageLogger, so its 429s are logged.
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
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere S2a: «Mine valg» owner API
// (GET/PUT /api/owner/:id/features). Same owner session + isVerifiedOwner;
// 404 for every subject not in OWNER_FEATURES_ALLOWED_SUBJECTS (default empty).
app.use("/", ownerFeaturesRoutes);
// dev-request 2026-10-21-rfb-mine-ordrer (Fase A2): «Mine ordrer» for owners
// (/eier/:id/ordrer, session) and the per-order e-mail view (/produsent/ordre/:token/kompakt).
app.use("/", ownerOrdersRoutes);
// Fase B1: the buyer's order card (/ordre/:id?ref=<buyer_ref>), linked from the buyer receipts.
app.use("/", buyerOrderCardRoutes);
// dev-request 2026-10-21 live-go handlevogn-pilot, skive 2: one-time activation
// link landing page (GET/POST /aktiver-bestillinger?t=…).
app.use("/", orderActivationRoutes);

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
// dev-request 2026-09-24-mcp-rate-limit-og-personvern-sannhet, C1: RFB's
// /mcp had no limiter at all (unlike dentalLimiter/jsonRpcLimiter/
// generalLimiter on its siblings) — see middleware/mcp-rate-limit.ts's file
// header for the full three-limiter design (IP emergency brake, per-
// session/key primary quota, stricter cart-tool quota).
app.use(
  "/mcp",
  mcpIpEmergencyBrakeLimiter,
  mcpPrimaryLimiter,
  mcpCartToolLimiter,
  mcpUsageLogger("mcp", "rfb"),
  mcpRoutes
);
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

// Dynamic memory limit (MEMORY_LIMIT_MB env var, then cgroup memory.max, then
// 512 MB) and the memory warning/critical thresholds, which scale with it:
// services/memory-thresholds.ts, shared with the RFB marketing job's health gate.

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
    // database.agents = all rows in `agents` with is_active=1 (no umbrella/vetted filter).
    // See dev-request 2026-08-21-rfb-produsenttall-kilde-til-sannhet for why this differs
    // from traffic.totalAgents (below) and from llms.txt's producer count.
    const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE is_active = 1").get() as any).c;
    // slice 5 (serverheng): cached SWR count, null until the first background count lands.
    const queryCount = getHealthQueryCount(db);

    // analytics_page_views totals (~1.2 M rows): cached for 60 s so /health
    // itself never blocks the shared event loop on a cold full count —
    // dev-request 2026-09-19-prod-event-loop-stall-mcp-unhealthy.
    const pvCounts = getPageViewHealthCounts(db);
    const pvCount = pvCounts.pageViews;
    const recentPv = pvCounts.lastHourPageViews;

    // Uptime
    const uptimeSec = Math.floor(process.uptime());

    // Overall status based on thresholds
    let status: "healthy" | "warning" | "critical" = "healthy";
    const warnings: string[] = [];

    if (memUsedMb > MEMORY_THRESHOLDS.criticalMb) { status = "critical"; warnings.push(`Memory critical: ${memUsedMb}MB / ${MEMORY_LIMIT_MB}MB`); }
    else if (memUsedMb > MEMORY_THRESHOLDS.warningMb) { status = "warning"; warnings.push(`Memory high: ${memUsedMb}MB / ${MEMORY_LIMIT_MB}MB`); }

    if (dbLatencyMs > 3000) { status = "critical"; warnings.push(`DB slow: ${dbLatencyMs}ms`); }
    else if (dbLatencyMs > 1000) { if (status !== "critical") status = "warning"; warnings.push(`DB latency elevated: ${dbLatencyMs}ms`); }

    // 2026-10-04: the static "DB large >400MB" / "analytics_page_views >500k rows"
    // warnings are gone — the normal 60-day-retention steady state tripped them
    // permanently, so status read 'warning' every day (noise). dbSizeMb and the row
    // counts are still reported below as plain fields; the actionable signal is the
    // daily auto-prune falling behind (see computePageViewPruneLag).
    const pruneLag = computePageViewPruneLag(db, Date.now(), getRetentionWindowDays());
    if (pruneLag.lagging) {
      if (status !== "critical") status = "warning";
      warnings.push(`Analytics auto-prune lagging: oldest page view ${pruneLag.oldestPageViewAgeDays}d old > ${pruneLag.retentionDays}d retention + ${PRUNE_LAG_GRACE_DAYS}d`);
    }

    const disk = diskUsage(path.dirname(dbPath));
    if (disk && disk.used_pct >= 95) { status = "critical"; warnings.push(`Data volume ${disk.used_pct}% full — SQLite writes will fail when it fills`); }
    else if (disk && disk.used_pct >= 85) { if (status !== "critical") status = "warning"; warnings.push(`Data volume ${disk.used_pct}% full`); }

    // Write-path probe (cached 30 s) — dev-request 2026-09-28-health-endepunkt-
    // maaler-ikke-skrivesti: a failing write path must not read as a healthy day.
    const writePath = getWritePathHealth(db);
    if (!writePath.ok) { status = "critical"; warnings.push(`DB write path failing: ${writePath.error}`); }

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
        pageViewsCachedAgeMs: pvCounts.cachedAgeMs,
        oldestPageViewAt: pruneLag.oldestPageViewAt,
        oldestPageViewAgeDays: pruneLag.oldestPageViewAgeDays,
        retentionDays: pruneLag.retentionDays,
        walBytes: getWalSizes(),
        offsiteBackup: getOffsiteBackupHealth(),
      },
      writePath,
      disk: disk && {
        totalMb: Math.round(disk.total_bytes / 1048576),
        freeMb: Math.round(disk.free_bytes / 1048576),
        usedPct: disk.used_pct,
      },
      // traffic.totalAgents = marketplaceRegistry.getStats().totalAgents = COUNT(*) FROM agents
      // filtered ONLY by the shared public-listability predicate (agent-visibility.ts: no
      // hidden test fixture, RFB vertical only) — still includes inactive + umbrella-tagged
      // rows. This is the SAME
      // underlying value as GET /api/stats' registry.totalAgents (src/routes/a2a.ts, the
      // /api/stats handler) — both call the same cached getStats(). See dev-request
      // 2026-08-21-rfb-produsenttall-kilde-til-sannhet.
      traffic: {
        lastHourPageViews: recentPv,
        totalAgents: stats.totalAgents,
        activeCities: stats.cities.length,
      },
      // ONE catalog number per vertical (services/honest-count.ts) — identical to the
      // count llms.txt, the agent card, mcp.json/server-card and /api/stats' honestCount
      // quote. Legacy fields above keep their documented meaning.
      catalog: getHealthCatalog(),
      // Numbers only here (public endpoint); per-stall request/job detail is
      // admin-only at GET /admin/analytics/ops/event-loop.
      eventLoop: getEventLoopSummary(),
      // GSC / Bing connection (A2A 2026-10-16-gsc-bing-ai-rapporter): status codes,
      // counts and check time only, read from memory — never a network call here.
      searchConsoles: getSearchConsolesHealth(),
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

// GET /admin/analytics/search-consoles — weekly GSC/Bing numbers per domain
// (A2A 2026-10-16-gsc-bing-ai-rapporter, S6c). Own router, mounted before the
// analytics router below.
app.use("/admin/analytics/search-consoles", adminLimiter, adminSearchConsolesRoutes);
// Analytics admin endpoints
app.use("/admin/analytics", analyticsRoutes);
app.use("/admin/runs", adminLimiter, adminRunsRoutes);
// a2a spam guard (2026-10-04): POST /admin/conversations/traffic-class-backfill
// (dry-run by default; {apply:true} writes; {reset:true,apply:true} reverts).
app.use("/admin/conversations", adminLimiter, adminConversationsTrafficClassRoutes);
// 2026-07-03 P1 (dev-requests/2026-06-30-platform-housekeeping-audit.md step 1):
// read-only DB table-size diagnostic — GET /admin/db/table-sizes
app.use("/admin/db", adminLimiter, adminDbTableSizesRoutes);
// 2026-09-11 (dev-requests/2026-09-11-experiences-retro-opprydding-db-backup-lever.md):
// DB backup/export lever — POST/GET /admin/db/backup
app.use("/admin/db", adminLimiter, adminDbBackupRoutes);
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
// POST /admin/agents/description-code-artifact-sweep (dev-request 2026-08-24-
// produsentbeskrivelser-skrapt-js-opprydding, Endring 4). Same ordering rule
// as the siblings above — mount BEFORE /admin/agents.
app.use(
  "/admin/agents/description-code-artifact-sweep",
  adminLimiter,
  adminAgentsDescriptionCodeArtifactSweepRoutes,
);
// POST /admin/agents/internal-note-sweep and POST /admin/agents/content-
// correction (Daniel 2026-09-03: «Interne notater skal ikke vises» / «fiks den
// byttede teksten på Epleblomsten og Nordlysmat»). Same ordering rule as the
// siblings above — mount BEFORE /admin/agents.
app.use("/admin/agents/internal-note-sweep", adminLimiter, adminAgentsInternalNoteSweepRoutes);
app.use("/admin/agents/content-correction", adminLimiter, adminAgentsContentCorrectionRoutes);
// POST /admin/agents/theme-spam-sweep (dev-request 2026-09-16-kaprede-
// produsentdomener-kasino-spam-i-beskrivelser): clears gambling copy scraped
// off hijacked/lapsed producer domains + the hijacked website itself. Same
// ordering rule as the siblings above — mount BEFORE /admin/agents.
app.use("/admin/agents/theme-spam-sweep", adminLimiter, adminAgentsThemeSpamSweepRoutes);
// GET /admin/agents/category-description-provenance-audit + POST .../route-
// boilerplate-to-reenrichment (dev-request 2026-09-09-rfb-kategori-og-
// beskrivelse-provenance-audit): NACE-default-only categories/products +
// scraped-boilerplate-description audit report, and the opt-in routing of
// confirmed boilerplate descriptions back to re-enrichment. Same ordering
// rule as the siblings above — mount BEFORE /admin/agents.
app.use(
  "/admin/agents/category-description-provenance-audit",
  adminLimiter,
  adminAgentsCategoryDescriptionProvenanceAuditRoutes,
);
// GET /admin/agents/drink-coverage (dev-request 2026-07-25-reisesok-korridor-
// discovery-og-naerhetssok, Fase 5c): read-only drink-venue coverage report
// over RFB producers, by canonical subcategory + city. Same ordering rule as
// the siblings above — mount BEFORE /admin/agents.
// GET /admin/agents/fylke-contradiction-audit (dev-request 2026-10-06-rfb-brreg-navnetreff-
// feil-adresse, Mål 1): read-only list of RFB producers whose name suffix and city point to
// different fylker. Mount BEFORE /admin/agents like the siblings above.
app.use("/admin/agents/fylke-contradiction-audit", adminLimiter, adminAgentsFylkeContradictionAuditRoutes);
app.use("/admin/agents/drink-coverage", adminLimiter, adminDrinkCoverageRoutes);
// GET/POST /admin/enrichment-write-pause (dev-request 2026-08-20-enrichment-
// write-pause-mekanisk-gjerde, P1) — the per-vertical enrichment write-pause
// state that services/enrichment-write-pause.ts enforces on every enrichment
// write surface (url-write, knowledge PUT, agents/register, contact-email-
// write). Its own top-level path, NOT under /admin/agents: the pause is a
// vertical-wide lever, not an agent-scoped one.
app.use("/admin/enrichment-write-pause", adminLimiter, adminEnrichmentWritePauseRoutes);
// POST /admin/agents/duplicate-merge — explicit-pair duplicate merge lever
// (dev-request duplicate-merge lever). Same ordering rule as the siblings
// above — mount BEFORE /admin/agents.
app.use("/admin/agents/duplicate-merge", adminLimiter, adminAgentsDuplicateMergeRoutes);
// POST /admin/agents/deactivate — standalone-row catalog-hygiene deactivate
// lever (dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype, Skive 8).
// Same ordering rule as the siblings above — mount BEFORE /admin/agents.
app.use("/admin/agents/deactivate", adminLimiter, adminAgentsDeactivateRoutes);
// POST /admin/agents/business-type + GET .../classification-dryrun — shop marker
// (dev-request 2026-10-01-rfb-butikker-i-outreach-poolen). Mount BEFORE /admin/agents.
app.use("/admin/agents/business-type", adminLimiter, adminAgentsBusinessTypeRoutes);
// POST /admin/test-producer — the ONE hidden RFB test producer for real test
// orders (dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt):
// dry-run default, arm/retire, refuses every non-fixture row.
app.use("/admin/test-producer", adminLimiter, adminTestProducerRoutes);
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere S2e: «Gi meg beskjed» counts per planned key (read-only).
app.use("/admin/owner-features/interest", adminLimiter, adminOwnerFeaturesInterestRoutes);
// S2d-3: the switch probe («bryterprobe») on the hidden test producer — behind
// OWNER_FEATURES_SWITCH_PROBE_ENABLED=1 (default off → 404), dry-run by default.
app.use("/admin/owner-features/switch-probe", adminLimiter, adminOwnerFeaturesSwitchProbeRoutes);
// POST /admin/agents/claim-backfill — one-shot claimed_at backfill for verified
// claims (dev-request 2026-10-01-rfb-eierkrav-utelates-fra-outreach). Mount BEFORE /admin/agents.
app.use("/admin/agents/claim-backfill", adminLimiter, adminAgentsClaimBackfillRoutes);
// POST /admin/agents/terminal-repark — categorical correction lever that
// flips wrongly terminal_unconfirmable rows (parked by the pre-#718
// no-data-was-treated-as-dead bug) back to pending_verify, leaving
// confirmed-dead / confirmed-non-producer rows terminal (Daniel-GO
// 2026-08-25, dev-request 2026-08-25-terminal-sweep-false-positives). Same
// ordering rule as the siblings above — mount BEFORE /admin/agents.
app.use("/admin/agents/terminal-repark", adminLimiter, adminAgentsTerminalReparkRoutes);
// GET /admin/agents/duplicate-slugs — READ-ONLY slug-collision detector that
// feeds the duplicate-merge lever above (which never detects by itself).
// Same ordering rule as the siblings above — mount BEFORE /admin/agents.
app.use("/admin/agents/duplicate-slugs", adminLimiter, adminAgentsDuplicateSlugsRoutes);
app.use("/admin/agents", adminLimiter, adminAgentsRoutes);
app.use("/admin/outreach-ready-pool", adminLimiter, adminOutreachPoolRoutes);
// orch-pr-20260614-3: suppression-gate candidates endpoint + sent-log backfill import
app.use("/admin/outreach-candidates", adminLimiter, adminOutreachCandidatesRoutes);
app.use("/admin/outreach-sent-log", adminLimiter, adminOutreachCandidatesRoutes);
// GET/POST /admin/outreach-max-touch-vern (dev-request 2026-08-29-outreach-
// max-touch-vern) — the L1 knob (enabled/threshold) behind max-touch-vern,
// read by BOTH the mode=second exclusion above (admin-outreach-candidates.ts)
// and the send-time invariant in crm.ts. Its own top-level path, matching
// /admin/enrichment-write-pause's sibling-lever mount just above rather than
// nesting under /admin/outreach-candidates: the knob is read by crm.ts too,
// not scoped to the candidates gate alone.
app.use("/admin/outreach-max-touch-vern", adminLimiter, adminOutreachMaxTouchVernRoutes);
// dev-request 2026-09-19-rfb-marketing-utsending-inn-i-plattformjobben: the
// platform-side daily RFB outreach send's two admin surfaces — the lane
// switch (GET/POST /admin/rfb-marketing-lane) and the manual/dry run
// (POST /admin/rfb-marketing-daily-run, dry run unless {apply: true}).
// services/rfb-marketing-daily.ts; the 08:10Z tick is further down.
app.use("/admin/rfb-marketing-lane", adminLimiter, rfbMarketingLaneRouter);
app.use("/admin/rfb-marketing-daily-run", adminLimiter, rfbMarketingDailyRunRouter);
// dev-request 2026-10-10-rfb-berikelse-nattjobb (R6): the nightly RFB
// enrichment job's admin surfaces — GET /preview (read-only, what each step
// would take tonight), POST /run ({apply?}, dry run by default), GET /last.
// services/rfb-enrichment-nightly.ts; the night tick is further down.
app.use("/admin/rfb-enrichment-nightly", adminLimiter, rfbEnrichmentNightlyRouter);
app.use("/admin/run-verifier", adminLimiter, adminRunVerifierRoutes);
// dev-request 2026-10-23-rfb-flere-forstehenvendelser-dommer-bevis-og-kontaktuttrekk
// (skive 1): read-only shadow preview of the second-line judge WITH own-website evidence.
app.use("/admin/second-line-judge-preview", adminLimiter, adminSecondLineJudgePreviewRoutes);
app.use("/admin/run-dental-verifier", adminLimiter, adminRunDentalVerifierRoutes);
// P1 server-migration: deterministic loop watchdog — liveness from the
// run-ledger; ?alert=1 emails when a watcher is silent.
app.use("/admin/loop-heartbeat", adminLimiter, adminLoopHeartbeatRoutes);
// P2.5: deterministic /fire dispatcher (server-migration plan). Shadow-safe — only
// POSTs the routine /fire API when a routine is configured (FIRE_ROUTINES and/or
// FIRE_ROUTINE_<AGENT>_TOKEN/_TRIG) AND mode=active.
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
// dev-request 2026-08-29-verifier-claim-kind-katalog-gap: read-only claim-kind
// count+sample endpoint so platform-verifier can verify claim kinds that were
// previously silently unverifiable (typed allowlist, see the route file).
app.use("/admin/verifier/claim-counts", adminLimiter, adminVerifierClaimCountsRoutes);
// dev-request 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent: the
// EN/SV profile-translation "rullebånd" admin surface (status/queue/preview/
// run/publish/unpublish/reject/requeue) for BOTH platforms — `platform` is a
// parameter, so the two Cloud Routines drive rfb and opplevagent through this
// one mount on rettfrabonden.com. LLM spend gated by PROFILE_TRANSLATIONS_ENABLED,
// public rendering by PROFILE_TRANSLATIONS_SERVE_ENABLED (both default off).
app.use("/admin/profile-translations", adminLimiter, adminProfileTranslationsRoutes);
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
// dev-request 2026-09-22-telefon-css-js-identifikator-falske-positiver,
// point 3: one-time retro-scan of existing agent_knowledge.phone values
// against the FIXED extractPhones() context-gate rule (services/search-
// enrich.ts) — re-fetches each row's homepage and re-extracts, flagging any
// stored phone the fixed rule would no longer extract. Dry-run by default
// (report + count, no writes, no DB mutation); dry_run:false actually blanks
// the flagged phone AND resets verification_status to 'pending_verify' so
// the verifier re-judges the row — never touching an owner-claimed agent
// (claimed_at) or a curated_fields-locked phone field.
// POST /admin/phone-context-gate-retro-scan
app.use("/admin/phone-context-gate-retro-scan", adminLimiter, adminPhoneContextGateRetroScanRoutes);
// dev-request 2026-09-22-telefon-css-js-identifikator-falske-positiver,
// point 2 fix-up (B3): thin HTTP wrapper around computeFieldSpotCheck()
// (src/agents/lokal-agent-verifier.ts) so the weekly field-verification
// SKILL (GET /admin/agents/recently-enriched's own comment: "lives in a
// separate SKILL, not here") has an actual endpoint to call — the function
// existed but had no production caller until this route.
// POST /admin/field-spot-check
app.use("/admin/field-spot-check", adminLimiter, adminFieldSpotCheckRoutes);
// dev-request 2026-07-23-crm-house-bucket-kimaere-opprydding, slice 2: the
// live-data-cleanup half of PR #405 (that PR's own commit message flagged
// this as "a separate, non-code operational step, not part of this PR").
// Clears the ONE hardcoded chimera agent_knowledge row's Bondens-Kolonial-
// contaminated fields. Dry-run by default; apply=true writes.
// POST /admin/crm-chimera-agent-clear
app.use("/admin/crm-chimera-agent-clear", adminLimiter, adminCrmChimeraAgentClearRoutes);
// dev-request 2026-07-23-crm-house-bucket-kimaere-opprydding, slice 3: the
// remaining 13-contact diagnosis half. Read-only, dry-run-only — NO apply
// mode at all, zero writes. Enumerates crm_contacts rows still on the
// chimera agent_id and proposes a classification per contact (system /
// producer-match / unknown) using the same matching tiers classifyEmail()
// (crm-service.ts) uses, reimplemented read-only.
// GET /admin/crm-chimera-contacts-diagnose
app.use("/admin/crm-chimera-contacts-diagnose", adminLimiter, adminCrmChimeraContactsDiagnoseRoutes);
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
// dev-request 2026-09-02-dental-hjemmeside-hygiene-og-brreg-gjenfinning,
// slice 2d: one-time, safely re-runnable correction pass for
// catalog_class='offentlig_klinikk' rows whose hjemmeside is actually a
// fylkeskommune/kommune directory host — discovers the clinic's own real
// site via the SAME two-tier mechanism hjemmeside-discovery-batch uses
// (discoverDentalClinicWebsite, admin-dental-hjemmeside-discovery.ts) and,
// only when verified, moves the old host into directory_url and writes the
// new one into hjemmeside. dry-run by default, dry_run:false writes.
// Mounted at its own specific path (NOT the bare "/admin/dental" prefix) —
// registered here, BEFORE the bare-prefix discovery mount below, so it never
// falls through that mount's own "register last" rate-limiter constraint.
// POST /admin/dental/offentlig-klinikk-hjemmeside-korrigering
app.use(
  "/admin/dental/offentlig-klinikk-hjemmeside-korrigering",
  adminLimiter,
  adminDentalOffentligKlinikkHjemmesideKorrigeringRoutes,
);
// dev-request 2026-07-21-dental-schema-probe-writepath-fix, follow-up: finds
// + repairs dental_agents rows already contaminated by the test/probe
// fingerprint PR #323's write-path guard now blocks going forward — clears
// only the contaminated field(s) and flags needs_review for re-enrichment.
// dry-run by default, apply:true writes. POST /admin/dental/schema-probe-sweep
app.use("/admin/dental/schema-probe-sweep", adminLimiter, adminDentalSchemaProbeSweepRoutes);
// dev-request 2026-08-15-dental-hjemmeside-brreg-navnesoek, item 3 (Brreg-
// field leg): discovers + verifies a candidate homepage from Brreg's own
// registered hjemmeside field for org_nr-known, hjemmeside-blank clinics,
// queues verified candidates (dental_website_review_queue) — never writes
// dental_agents.hjemmeside directly. Approve is a separate, explicit,
// dry-run-default call. POST /admin/dental/hjemmeside-discovery-batch,
// POST /admin/dental/hjemmeside-discovery-approve.
// Mounted at the bare "/admin/dental" prefix (this router only defines the
// two specific sub-paths above) — MUST stay registered LAST among every
// "/admin/dental/*" mount: Express falls through an unmatched prefix mount
// to the next app.use, but adminLimiter still increments on the way through,
// so registering this any earlier double-charges every later sibling's rate
// limit on every request (caught in PR #600 review — reproduced: one POST to
// schema-probe-sweep left only 498/500 remaining when this was mounted
// before it).
app.use("/admin/dental", adminLimiter, adminDentalHjemmesideDiscoveryRoutes);
// dev-request 2026-09-02-dental-catalog-class-triage (steg 0+1) and
// 2026-09-02-dental-hjemmeside-hygiene-og-brreg-gjenfinning (steg 2b):
// POST /admin/dental/catalog-class-backfill, GET /admin/dental/parking-stats,
// POST /admin/dental/brreg-address-sweep. Same X-Admin-Key gate, same limiter.
app.use("/admin/dental", adminLimiter, adminDentalCatalogClassRoutes);
// dev-request 2026-09-09-dental-non-clinic-retro-sanitize: POST
// /admin/dental/wrong-entity-retro-sanitize — one-time retroactive batch that
// parks already-`enriched` non-dental rows (NACE 86.230/86.221/32.500) via
// the existing wrong-entity parking mechanism. Same gate, same limiter.
app.use("/admin/dental", adminLimiter, adminDentalWrongEntityRetroSanitizeRoutes);
// dev-request 2026-09-02-dental-catalog-class-triage (steg 1c): POST
// /admin/dental/catalog-class-sonnet-sample — LLM second-pass judge over the
// ambiguous ukjent / company_dental_nace-klinikk cohort. Same gate, limiter.
app.use("/admin/dental", adminLimiter, adminDentalCatalogClassSonnetSampleRoutes);
app.use("/admin/dental", adminLimiter, adminDentalBrregAddressSweepRoutes);
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
// dev-request 2026-09-09-outreach-profilkvalitet: agent_knowledge.address
// trailing ", Norge"/", NORGE" suffix sweep — GET (read-only diagnostic) +
// POST (dry-run default) /admin/address-norge-suffix-sweep
app.use("/admin", adminLimiter, addressNorgeSuffixSweepRouter);
// dev-requests/2026-08-06-rfb-website-discovery-slice.md: candidate-homepage
// discovery for RFB `agents` rows with no website on file — queues verified
// proposals into agents_website_review_queue, never writes agents/
// agent_knowledge directly. POST /admin/rfb-website-discovery,
// GET /admin/rfb-website-review-queue (read-only, pending rows only).
app.use("/admin", adminLimiter, adminRfbWebsiteDiscoveryRoutes);
// dev-request 2026-08-22-rfb-website-email-selvforsyning: combined org_nr +
// website + phone-evidence self-sufficiency batch job — extended name-match
// heuristics (domain-token, personal-name-ENK) for org_nr, then Brreg's own
// registered hjemmeside/telefon/mobil as an additional website-discovery +
// evidence source, feeding the SAME org-nr-backfill and rfb-website-
// discovery machinery above (never a new write path). POST
// /admin/rfb-brreg-selfsufficiency (dry-run by default).
app.use("/admin", adminLimiter, adminRfbBrregSelfSufficiencyRoutes);
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
// scripts/dod-scorecard.py (A2A repo) has carried a `provenance + per-agent
// verification_status: MEASUREMENT-PENDING` placeholder for ~2 months: no
// bulk endpoint exposed field_provenance/verification_status per-agent, so
// the script could only sample. READ-ONLY, paginated, per-producer
// verification_status + provenance/content signals for all 8 DoD checks in
// one batch call. GET /admin/dod-bulk.
app.use("/admin/dod-bulk", adminLimiter, adminDodBulkRoutes);
// dev-requests/2026-08-07-rfb-contact-extraction.md: corroborated contact-
// email extraction from a producer's own website for RFB `agents` rows whose
// contact_email is blank or DNS-flagged-dead — writes agents.contact_email
// (fill-or-replace-if-flagged-dead), never phone, never field_provenance.
// POST /admin/rfb-contact-extraction (dry-run default).
app.use("/admin", adminLimiter, adminRfbContactExtractionRoutes);
// dev-requests/2026-09-01-rfb-pending-verify-unpark-lever.md: targeted lever
// to release individual `pending_verify` rows from 30-day parking early, once
// they've actually received new data since being parked (agent_knowledge.
// updated_at > pending_verify_parked_since) — mirrors unparkAgentsGeocode's
// pattern for the geocode worker's own parking mechanism.
// POST /admin/agents/pending-verify-unpark (dry-run default).
app.use("/admin", adminLimiter, adminAgentsPendingVerifyUnparkRoutes);
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
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 1: dry-run measurement of the
// product extractor — POST/GET /admin/product-import/dry-run[/:id]. Flag PRODUCT_IMPORT_DRYRUN_ENABLED
// (default off → 404); writes only product_import_runs/_results, never agent_knowledge/products.
app.use("/admin/product-import", adminLimiter, adminProductImportRoutes);
// PR-65 (2026-05-17): in-memory job tracker for ?async=1 admin endpoints — GET /admin/jobs[/:id]
app.use("/admin", adminLimiter, adminJobsRoutes);
// Phase 0: admin product backfill endpoint
app.use("/admin/products", adminLimiter, adminCatalogRouter);
// Phase 1: admin order lifecycle transitions
app.use("/admin/marketplace", adminLimiter, adminOrderRouter);
// dev-request 2026-07-13-pilot-ordre-loop: notification opt-in + seller order inbox
app.use("/admin/orders", adminLimiter, adminOrdersRoutes);
// skive 2: POST /admin/orders/activation-link — signed one-time link, returned to admin only.
app.use("/admin/orders", adminLimiter, orderActivationAdminRouter);

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

// dev-requests/2026-09-13-fjern-svar-kobles-ikke-paa-tvers-av-vertikaler.md:
// READ-ONLY cross-vertical contact lookup — given a contact email and the
// vertical it was just found/removed on, does that SAME exact email have an
// active entry on another vertical (rfb/dental/experiences each run their
// own DB, no shared identity layer today). Building block for the
// customer-service "fjern" flow; exact-email-match only, never fuzzy name
// matching. GET /admin/cross-vertical-contact-lookup.
app.use("/admin", adminLimiter, adminCrossVerticalContactLookupRoutes);

// Billing skeleton (Produsent-Premium, test-mode Stripe) — dev-request
// 2026-07-13-billing-skjelett-moerkt. Feature-flagged via BILLING_ENABLED
// env var; default OFF (the OPPOSITE default of CRM_ENABLED above — this is
// a dark skeleton, not a live feature: flag unset/anything-but-"1" means
// zero routes mounted, zero behavior change). The flag check (plus the
// live-Stripe-key guard) lives inside mountBillingRoutes() itself
// (routes/admin-billing.ts) so it stays unit-testable without booting the
// whole app — this call is unconditional on purpose.
mountBillingRoutes(app);

// Prepayment via Stripe Connect (producer is the seller, direct charges on
// the producer's own Stripe account) — A2A dev-request 2026-10-09-rfb-
// forhandsbetaling-stripe-connect. Default OFF: mountPaymentRoutes() checks
// PAYMENTS_ENABLED and the live-key guard itself (routes/payments.ts), so
// this call is unconditional on purpose, same as mountBillingRoutes().
mountPaymentRoutes(app);

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
// Since 2026-09-29 the live feed is POST /webhooks/resend (mounted near the
// top of this file); these routes stay the manual/backfill path.
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
  // dev-request 2026-10-02-boot-jobber-event-loop-stall-etter-deploy: runs in
  // short slices (yielding to the event loop between them) behind the shared
  // boot-job gate, so it never blocks >500 ms nor overlaps url-backfill.
  // Slice 2 of dev-request 2026-10-08-serverheng-...: starts 4 min after listen
  // (was 2 s) and is skipped when it completed within the last 24 h
  // (boot_job_state, same pattern as url-backfill). The stamp is per formula
  // version (dev-request 2026-10-16-rfb-strukturerte-data-tredjepartsrating-
  // og-places-treffvakt, S4-A1b), so the first boot after a formula change
  // recalculates every score.
  scheduleBootTrustRecalc({
    getDb: () => getDb(),
    formulaVersion: TRUST_SCORE_FORMULA_VERSION,
    recalc: trackJob("boot-trust-recalc", async () => {
      console.log("📊 Recalculating trust scores (background, chunked)...");
      const trustResult = await trustScoreService.recalculateAllChunked({ chunkSize: 20, pauseMs: 5 });
      console.log(`   ✅ Updated ${trustResult.updated} agents (avg: ${Math.round(trustResult.avgScore * 100)}%)`);
    }),
  });

  // dev-request 2026-09-19-prod-event-loop-stall-mcp-unhealthy: the homepage
  // traffic strips are computed off the main thread (offthread-stats.ts).
  // Start the first computation for all three hosts now so they show real
  // numbers as early as possible; until it lands they render zeros.
  // Slice 2: delayed ~60 s so the three full scans do not start with the boot stall.
  setTimeout(() => prewarmTrafficStats(["rfb", "dental", "experiences"]), TRAFFIC_PREWARM_BOOT_DELAY_MS);
  // agentplatform.no/partnere: the 30-day MCP tool-call count (agent-usage.ts),
  // same worker, same delay — one indexed COUNT, far lighter than the scans above.
  setTimeout(() => prewarmAgentToolCalls(), TRAFFIC_PREWARM_BOOT_DELAY_MS);
  // Only /partnere reads it, so keep it hourly-fresh without visitors too.
  setInterval(() => prewarmAgentToolCalls(), AGENT_USAGE_PREWARM_INTERVAL_MS);
  // Serverheng skive 6: start the "public" stats worker (GET /api/agents/:id/stats)
  // before the first producer page asks for it.
  setTimeout(() => prewarmAgentStats(), TRAFFIC_PREWARM_BOOT_DELAY_MS);

  // ─── PR-21 / WO-19 (2026-05-10): link-freshness backfill ────────────
  // On every boot, probe every agent currently in the outreach pool.
  // Worst case: 8s timeout × ~130 agents ≈ 17 min. Run AFTER trust-score
  // recalc + with a delay so health checks pass first. Non-blocking, so
  // a slow probe never holds up the server.
  //
  // Disable by setting RFB_DISABLE_URL_BACKFILL=1 (e.g. on dev / CI).
  if (process.env.RFB_DISABLE_URL_BACKFILL !== "1") {
    setTimeout(() => {
      // Lazy-require so a syntax error in the verifier never blocks boot.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { runUrlBackfill } = require("./agents/lokal-agent-verifier");
      const minHours = resolveMinIntervalHours(process.env.RFB_URL_BACKFILL_MIN_INTERVAL_HOURS);
      void runExclusiveBootJob(async () => {
        const last = getJobLastCompletedAt(getDb(), URL_BACKFILL_JOB);
        if (shouldSkipRecentRun({ lastCompletedAt: last, now: new Date(), minIntervalHours: minHours })) {
          console.log(
            `[enrichment-backfill] skipped — last completed run ${last!.toISOString()} is < ${minHours}h old ` +
            `(RFB_URL_BACKFILL_MIN_INTERVAL_HOURS)`
          );
          return;
        }
        console.log("[enrichment-backfill] starting URL freshness backfill (non-blocking, chunked)…");
        await trackJob("url-backfill", () => runUrlBackfill({ chunkSize: 5, chunkPauseMs: 1000 }))();
        markJobCompleted(getDb(), URL_BACKFILL_JOB);
      }).catch((err: unknown) => {
        console.error("[enrichment-backfill] failed (non-fatal):", err);
      });
    }, URL_BACKFILL_BOOT_DELAY_MS); // ≥5 min — well after boot-trust-recalc + health checks
  }

  // ─── Traffic history (dev-request 2026-10-13-statistikk-riktig-for-investorer, S3)
  // Day/week/month aggregates of page views, visits, visitors and searches,
  // computed in the stats worker while the raw rows exist and kept after the
  // 60-day prune (services/traffic-history.ts). Boot run after 6 min (after the
  // boot prewarm and trust recalc), then hourly; the nightly prune below also
  // awaits one run before deleting. Disable with TRAFFIC_HISTORY_DISABLED=1.
  startTrafficHistoryScheduler({ getDb: () => getDb(), bootDelayMs: 6 * 60_000 });

  // ─── GSC and Bing Webmaster (A2A dev-request 2026-10-16-gsc-bing-ai-rapporter, S6c)
  // Read-only connectivity check 2 min after boot (after the boot-job gate),
  // then every 24 h; the same run fetches the latest complete week into
  // search_console_weekly. Runs when GSC_SERVICE_ACCOUNT_JSON and/or
  // BING_WEBMASTER_API_KEY is set; SEARCH_CONSOLE_FETCH_ENABLED=0 turns it off.
  // Status in /health (searchConsoles), numbers at /admin/analytics/search-consoles.
  startSearchConsoleScheduler({ getDb: () => getDb() });

  // «Med i AI-svar» (dev-request 2026-10-14-med-i-ai-svar-per-profil): the
  // in-memory delivery counts are written as daily sums every minute and on
  // shutdown (below).
  startAiDeliveriesFlusher();

  // ─── PR-92 (2026-06-01): daily analytics auto-prune ───────────────
  // Keeps the DB from growing unbounded (analytics_page_views adds
  // ~7–8 MB/day). Fires once per day inside the 03:00–03:59 UTC window
  // and skips if we already ran in the last 23h.
  //
  // orch-pr-20260927-weekly-vacuum-stall: this used to ALSO run a
  // synchronous VACUUM once a week (Sundays), which blocked the process for
  // ~146s against the prod-sized DB (every host + the MCP endpoint down for
  // that whole window) — removed; see the doc comment further down (right
  // where that call used to be) for the full rationale and the fallback.
  //
  // Disable on dev / CI with RFB_DISABLE_AUTO_PRUNE=1.
  if (process.env.RFB_DISABLE_AUTO_PRUNE !== "1") {
    let lastPruneAt: Date | null = null;
    const AUTO_PRUNE_DAYS_TO_KEEP = parseInt(process.env.RFB_AUTO_PRUNE_DAYS || "60", 10);

    // dev-request 2026-10-01-prod-auto-prune-skansom: the prune is async now
    // (<=2000-row transactions, setImmediate between them); this flag stops an
    // hourly tick from starting a second pass while one is still yielding.
    let autoPruneRunning = false;

    const autoPruneTick = async () => {
      const now = new Date();
      if (autoPruneRunning) return;
      if (!shouldRunAutoPrune({ now, lastRunAt: lastPruneAt })) return;
      autoPruneRunning = true;
      try {
        // Store the traffic history of the days about to be deleted first (off
        // the main thread); the prune's own per-day safety net covers a failure.
        if (process.env.TRAFFIC_HISTORY_DISABLED !== "1") {
          try {
            const h = await runTrafficHistoryJob({ db: getDb(), requireWorker: true });
            if (h.planned > 0 || h.failed > 0) {
              console.log(`[traffic-history] before prune: planned=${h.planned} computed=${h.computed} failed=${h.failed} ms=${h.ms}`);
            }
          } catch (err) {
            console.error("[traffic-history] before prune failed (non-fatal):", err);
          }
        }
        const result = await analyticsService.runAutoPruneAsync({ daysToKeep: AUTO_PRUNE_DAYS_TO_KEEP });
        console.log(
          `[auto-prune] daysToKeep=${result.daysKept} cutoff=${result.cutoff} ` +
          `deleted=${JSON.stringify(result.deleted)} ` +
          `skippedPendingRollup=${JSON.stringify(result.skippedPendingRollup)} ` +
          `wouldDeleteIfPruned=${JSON.stringify(result.wouldDeleteIfPruned)}`
        );
        lastPruneAt = now;

        // orch-pr-20260927-weekly-vacuum-stall: this used to also run a
        // synchronous `VACUUM` on Sundays here. Measured in prod
        // 2026-09-27T03:45:15Z: against the then-~819MB DB that blocked the
        // ONE Node event loop for 145,806ms (~146s) straight — every HTTP
        // host and the MCP endpoint (polled hourly by Glama) were fully
        // unresponsive for the whole window. That VACUUM call is REMOVED,
        // not chunked/moved off-thread:
        //   - better-sqlite3 is synchronous and VACUUM is not chunkable the
        //     way the DELETE-heavy prune above is (SQLite rewrites the
        //     whole file in one pass — see runVacuumJob's doc comment in
        //     src/routes/analytics.ts for why even the existing manual/job
        //     wrapped endpoint still can't avoid blocking for VACUUM's own
        //     duration).
        //   - a worker thread can't safely run VACUUM against this DB
        //     either: VACUUM needs to rewrite/replace the whole file, and
        //     src/services/offthread-stats.ts's own doc comment already
        //     rules this out for the SAME db handle (its worker pattern is
        //     read-only, precisely because a second connection doing
        //     writes/rewrites while the main connection holds the file open
        //     is not safe here).
        //   - it isn't actually needed for the daily prune's PURPOSE
        //     (bounded DB growth): VACUUM only shrinks the file to reclaim
        //     free pages — it does not affect whether the file grows
        //     unbounded. SQLite reuses freed pages from deleted rows for new
        //     inserts via its internal freelist regardless of VACUUM/
        //     auto_vacuum, so as long as this daily prune keeps deleting
        //     rows roughly as fast as new ones come in (which is what the
        //     RFB_AUTO_PRUNE_DAYS retention window is for), the file size
        //     should reach its own equilibrium without ever running VACUUM.
        // Fallback / observability: the DB file size is logged on every
        // [auto-prune] line below (a cheap fs.statSync, not a DB read) so
        // this assumption is checked continuously against real data, not
        // just once. If it does NOT plateau over time, the fix is to run
        // `POST /admin/analytics/ops/vacuum` (src/routes/analytics.ts) by
        // hand, off-peak — that endpoint already responds 202 + a pollable
        // jobId instead of holding the request open, though the VACUUM call
        // inside it still blocks the event loop for its own duration, same
        // as this removed call did, which is exactly why it must stay a
        // deliberate, human-triggered, off-peak action and not run on an
        // unattended weekly timer in this process.
        try {
          const sizeMb = analyticsService.getDbFileSizeMb();
          console.log(`[auto-prune] db file size: ${sizeMb}MB (weekly auto-VACUUM disabled, see comment above)`);
        } catch (err) {
          console.error("[auto-prune] db size check failed (non-fatal):", err);
        }
      } catch (err) {
        console.error("[auto-prune] failed (non-fatal):", err);
      } finally {
        autoPruneRunning = false;
      }

      // dev-request 2026-09-24-mcp-rate-limit-og-personvern-sannhet, C3:
      // sweepExpiredCartContactData() (services/cart-contact-sweep.ts) was
      // written+tested but never wired to run automatically — piggybacks on
      // this SAME once-daily 03:00–03:59 UTC window rather than adding a
      // second setInterval. Own try/catch so a sweep failure can never
      // affect the analytics prune above (or vice versa).
      //
      // SAFETY: this is a REAL deletion job against production buyer
      // contact data (name/email/phone/delivery note), so it defaults to
      // dryRun=true (count-only, writes nothing) until CART_CONTACT_SWEEP_LIVE
      // is explicitly set to "true" — mirrors the CATALOG_SYNC_SCHEDULER_ENABLED
      // -style explicit-opt-in convention already used for other scheduler
      // additions in this file. Flip it once a few days of dry-run log lines
      // (below) look sane in production.
      try {
        const sweepLive = process.env.CART_CONTACT_SWEEP_LIVE === "true";
        const sweepResult = sweepExpiredCartContactData(30, now, !sweepLive);
        console.log(
          `[cart-contact-sweep] dryRun=${sweepResult.dryRun} sweptCount=${sweepResult.sweptCount} sweptOrderCount=${sweepResult.sweptOrderCount}` +
          (sweepResult.dryRun
            ? " (count-only, no rows modified — set CART_CONTACT_SWEEP_LIVE=true to enable real deletion)"
            : "")
        );
      } catch (err) {
        console.error("[cart-contact-sweep] failed (non-fatal):", err);
      }

      // Slice 1 of 2026-10-08-serverheng…: 14-day retention for event_loop_events
      // (batched DELETE ... LIMIT with a macrotask yield between batches).
      try {
        const evDeleted = await pruneEventLoopEvents(getDb());
        if (evDeleted > 0) console.log(`[event-loop-persist] pruned ${evDeleted} rows older than 14d`);
      } catch (err) {
        console.error("[event-loop-persist] prune failed (non-fatal):", err);
      }

      // Slice 4 of 2026-10-08-serverheng…: big-table indexes are built here, in
      // the 03:00 window, not at boot (services/night-indexes.ts).
      try {
        const built = ensureNightIndexes(getDb());
        if (built.length > 0) console.log(`[night-indexes] built ${built.join(", ")}`);
      } catch (err) {
        console.error("[night-indexes] failed (non-fatal):", err);
      }

      // S3 of 2026-10-09-rfb-grunnmur-wal-backup-fts-spillbok: rebuild the
      // name-search FTS index if its row count has drifted from agents
      // (services/name-search-fts.ts). Before the WAL checkpoint below, so a
      // rebuild's WAL is truncated the same night. Skipped with RFB_NAME_FTS=0
      // (boot dropped the index). Never throws.
      try {
        if (isNameFtsEnabled()) {
          const fts = syncAgentsNameFts(getDb());
          if (fts.error) console.error(`[name-fts] consistency check failed (non-fatal): ${fts.error}`);
          else if (fts.rebuilt) console.log(`[name-fts] rebuilt: agents=${fts.agents} indexed=${fts.indexed} in ${fts.ms.toFixed(1)}ms`);
        }
      } catch (err) {
        console.error("[name-fts] consistency check failed (non-fatal):", err);
      }

      // S1 of 2026-10-09-rfb-grunnmur-wal-backup-fts-spillbok: truncate the WAL
      // of every open DB in the 03:00 window (never 07–09 UTC). Never throws.
      try {
        const cp = runWalCheckpoints(new Date());
        for (const r of cp) {
          console.log(
            `[wal-checkpoint] ${r.vertical} ok=${r.ok} walBytes ${r.walBytesBefore} -> ${r.walBytesAfter}` +
            (r.error ? ` error=${r.error}` : "")
          );
        }
      } catch (err) {
        console.error("[wal-checkpoint] failed (non-fatal):", err);
      }
    };

    // Check every hour. The shouldRunAutoPrune guard handles the rest.
    setInterval(trackJob("auto-prune", autoPruneTick), 60 * 60_000);
  }
});

// ─── Grunnmur S2 (2026-10-10): nightly offsite DB backup to Fly Tigris ──
//
// Wakes every 15 min; services/offsite-backup.ts only runs in the 04–05 UTC window (after
// the 03 UTC prune + WAL checkpoint), at most once per night, plus a weekly restore test
// (Sunday). The two-hour window lets a restart or a late tick still catch up that night.
// A no-op until the five Tigris secrets are set. Persisted stamps in boot_job_state stop a
// restart inside the window from running it twice.
// Disable by setting RFB_DISABLE_OFFSITE_BACKUP=1 (e.g. on local dev / CI).
if (process.env.RFB_DISABLE_OFFSITE_BACKUP !== "1") {
  setInterval(trackJob("offsite-backup", createOffsiteBackupTick({ getStateDb: () => getDb() })), OFFSITE_TICK_MS);
}

// ─── Manual DB copies: nightly age sweep (dev-request 2026-10-12-manuelle-db-kopier-aldersgrense) ──
// Deletes on-volume copies older than 30 days (DB_BACKUP_MAX_AGE_DAYS) even when no new copy is
// taken. Runs once per UTC day in the 02 UTC hour (outside 00-01Z and 06:30-09:30Z); async unlink.
if (process.env.RFB_DISABLE_OFFSITE_BACKUP !== "1") {
  setInterval(trackJob("db-backup-age-sweep", createBackupAgeSweepTick()), BACKUP_AGE_SWEEP_TICK_MS);
}

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
  setInterval(trackJob("debio-sync", async () => {
    const now = new Date();
    // Økologi S1 (AC1.6): every hour — > 7 days without a successful register
    // sync clears register-checked statuses. No-op when the register sync
    // never ran (flag off: unchanged).
    try {
      const f = enforceDebioRegisterFreshness(getDb(), now);
      if (f.warning) console.warn(`[debio-register] ${f.warning} (cleared=${f.cleared})`);
    } catch (err) {
      console.error("[debio-register] freshness check failed:", err);
    }
    if (now.getUTCHours() !== 4) return; // fire only during 04:00 UTC window
    if (lastDebioSyncAt && (now.getTime() - lastDebioSyncAt.getTime()) < 23 * 3600_000) return;
    // Økologi S1: with RFB_DEBIO_REGISTER_SYNC on, Debio's full register is the
    // status source (finnoko only as a helper key inside it).
    if (debioRegisterSyncEnabled()) {
      try {
        const r = await syncDebioRegister(getDb(), { dryRun: false });
        console.log(
          `[debio-register] accepted=${r.accepted} rows=${r.normalized} verified=${r.verified} ` +
          `review=${r.review_candidates} reset=${r.would_reset} changes=${r.changes} errors=${r.errors.length}`,
        );
        for (const w of r.warnings) console.warn(`[debio-register] ${w}`);
        lastDebioSyncAt = now;
      } catch (err) {
        console.error("[debio-register] failed:", err);
      }
      return;
    }
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
  }), 60 * 60_000); // hourly check
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
  setInterval(trackJob("salgskanal-sync", () => {
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
  }), 60 * 60_000); // hourly check
}

// ─── dev-request 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt,
// Slice 0: daily automatic product-catalog sync ──────────────────────────
//
// Runs the SAME upsert runProductCatalogSync() (src/services/
// product-catalog-sync.ts) that POST /admin/products/backfill has always
// run — only difference is *when* it runs: once a day instead of only when
// an admin remembers to trigger it. Implementation pattern mirrors PR-95's
// debio-sync / the salgskanal-sync scheduler immediately above: hourly
// wakeup, only fires inside the target UTC hour, debounced by the 23-hour
// gap so a restart inside that hour doesn't double-run. 07:00 UTC — right
// after the 22:00-06:00 verifier window closes, so this sync's writes never
// overlap the verifier's.
//
// Never touches `availability` (see product-catalog-sync.ts's module doc
// comment for the exact guarantee that gives producer_dashboard-sourced
// rows) — this is a NEW job, so unlike RFB_DISABLE_* siblings above it is
// OPT-IN (default OFF, same posture as VERIFIER_SCHEDULER_ENABLED below):
// it ships inert in code until a human sets
// CATALOG_SYNC_SCHEDULER_ENABLED=true in fly.toml.
let lastCatalogSyncAt: Date | null = null;
if (process.env.CATALOG_SYNC_SCHEDULER_ENABLED === "true") {
  setInterval(trackJob("catalog-sync", () => {
    const now = new Date();
    if (now.getUTCHours() !== 7) return; // fire only during 07:00 UTC window
    if (lastCatalogSyncAt && (now.getTime() - lastCatalogSyncAt.getTime()) < 23 * 3600_000) return;
    try {
      const result = runProductCatalogSync();
      if (result.success) {
        console.log(
          `[catalog-sync] agents_processed=${result.agents_processed} inserted=${result.inserted} ` +
          `updated=${result.updated} skipped=${result.skipped}`,
        );
      } else {
        console.error(`[catalog-sync] failed: ${result.error}`);
      }
      lastCatalogSyncAt = now;
    } catch (err) {
      console.error("[catalog-sync] failed:", err);
    }
  }), 60 * 60_000); // hourly check
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
  setInterval(trackJob("verifier-scheduler", async () => {
    if (!isVerifierWindowHour(new Date().getUTCHours())) return;
    if (verifierTickRunning) {
      console.warn("[verifier-scheduler] tick skipped — a previous tick is still running");
      return;
    }
    verifierTickRunning = true;
    try {
      const r = await runVerifierTick({ batchSize: 30 });
      if (r.skipped) {
        console.warn(`[verifier-scheduler] tick skipped — ${r.reason}`);
      } else {
        console.log(
          `[verifier-scheduler] run_id=${r.run_id} processed=${r.processed} passed=${r.passed} ` +
          `pending_verify=${r.pending_verify} review_required=${r.review_required} pool_added=${r.pool_added}`
        );
      }
    } catch (err) {
      console.error("[verifier-scheduler] tick failed:", err);
    } finally {
      verifierTickRunning = false;
    }
  }), 60 * 60_000); // hourly check, self-gated on the 22-06 UTC window
}

// ─── dev-request 2026-09-02-dental-verifier-website-ownership: internal ──
// hourly dental-verifier scheduler ─────────────────────────────────────
//
// Drives runDentalVerifierBatch (src/services/dental-verifier.ts) on an
// hourly cadence — the SAME library call admin-run-dental-verifier.ts's
// POST / handler makes, not an HTTP self-call and not a re-implementation.
//
// Gated OFF by default — only runs when DENTAL_VERIFIER_SCHEDULER_ENABLED=1
// AND ENABLE_DENTAL=1 (the dental.db handle is only open when the dental
// vertical is enabled). The flag is turned on only by Daniel; nothing in
// this repo (fly.toml included) sets it. Batch size comes from
// DENTAL_VERIFIER_BATCH_SIZE (default 30, capped at 200).
let dentalVerifierTickRunning = false;
if (shouldRunDentalVerifierScheduler()) {
  const dentalVerifierBatchSize = resolveDentalVerifierSchedulerBatchSize();
  setInterval(trackJob("dental-verifier-scheduler", async () => {
    if (dentalVerifierTickRunning) {
      console.warn("[dental-verifier-scheduler] tick skipped — a previous tick is still running");
      return;
    }
    dentalVerifierTickRunning = true;
    try {
      const r = await runDentalVerifierBatch({ batchSize: dentalVerifierBatchSize });
      const verified = r.results.filter((x) => x.new_verification_status === "verified").length;
      const inactive = r.results.filter((x) => x.new_is_inactive === true).length;
      console.log(
        `[dental-verifier-scheduler] run_id=${r.run_id} processed=${r.results.length} ` +
        `verified=${verified} newly_inactive=${inactive} batch_size=${dentalVerifierBatchSize}`
      );
    } catch (err) {
      console.error("[dental-verifier-scheduler] tick failed:", err);
    } finally {
      dentalVerifierTickRunning = false;
    }
  }), DENTAL_VERIFIER_SCHEDULER_INTERVAL_MS); // hourly
}

// ─── dev-request 2026-09-02-flerspraklige-profiler-rfb-og-opplevagent, Daniel
// GO #1: in-process profile-translation worker (intensive until a timestamp,
// then a small hourly budget). Gated OFF by default — only runs when
// PROFILE_TRANSLATIONS_WORKER_ENABLED === "true" (fly.toml), and is a per-tick
// no-op unless PROFILE_TRANSLATIONS_ENABLED === "true" as well. Never
// publishes or serves anything; see profile-translations-worker.ts.
startProfileTranslationsWorker();
// dev-request 2026-09-03-oversettelse-synk-og-eierprofiler: keeps published
// translations in step with the Norwegian source. No LLM, default on, and it
// can only ever unpublish - see profile-translations-worker.ts.
startProfileTranslationsStaleSweep();

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
  // First tick at boot + 3 min (staggered, slice 2 of 2026-10-08-serverheng-...).
  setTimeout(trackJob("dental-geocode", async () => {
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
  }), DENTAL_GEOCODE_BOOT_DELAY_MS);

  // Subsequent ticks hourly.
  setInterval(trackJob("dental-geocode", async () => {
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
  }), 60 * 60_000);
}

// ─── dev-request 2026-10-16-indexnow-alle-verter (S2): IndexNow sitemap-diff sync ───
// Default OFF. First tick at boot + 10 min (after the geocode ticks), then hourly. The tick
// itself skips 06:30-09:30 UTC and a run younger than 30 min (boot_job_state).
if (process.env.INDEXNOW_SYNC_ENABLED === "true") {
  const indexNowSyncTick = trackJob("indexnow-sync", async () => {
    try {
      const { indexNowSyncTick: tick } = await import("./services/indexnow-sync");
      await tick();
    } catch (err) {
      console.error("[indexnow-sync] tick failed:", err);
    }
  });
  setTimeout(indexNowSyncTick, 10 * 60_000);
  setInterval(indexNowSyncTick, 60 * 60_000);
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
  // First tick at boot + 6 min (staggered, slice 2 of 2026-10-08-serverheng-...).
  setTimeout(trackJob("experiences-geocode", async () => {
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
  }), EXPERIENCES_GEOCODE_BOOT_DELAY_MS);

  // Subsequent ticks hourly.
  setInterval(trackJob("experiences-geocode", async () => {
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
  }), 60 * 60_000);
}

// ─── dev-request 2026-10-07-experiences-beskrivelser-forslagsko-steg2:
// experience description proposals job ───────────────────────────────
//
// Hourly: reads description proposal files a Cloud Routine (Max
// subscription) committed to slookisen/A2A `experiences-proposals/` and
// stores them through the same shared function as POST /admin/experiences-
// description-write. Never calls an LLM. The tick itself checks
// EXPERIENCE_PROPOSALS_JOB_ENABLED === "true" (OFF by default — flipping it
// off is the rollback), the experiences write-pause and A2A_READ_PAT, so a
// disabled job is a silent no-op tick. First tick 5 minutes after boot (not
// at boot), hourly after that; an overlapping tick is skipped.
if (process.env.ENABLE_EXPERIENCES === "1") {
  let experienceProposalsRunning = false;
  const experienceProposalsTick = trackJob("experience-proposals", async () => {
    if (experienceProposalsRunning) return;
    experienceProposalsRunning = true;
    try {
      const { tickExperienceDescriptionProposals } = await import("./services/experience-description-proposals-job");
      const r = await tickExperienceDescriptionProposals();
      if (r.skipped_reason === "disabled") return;
      console.log(
        `[experience-proposals] tick run_id=${r.run_id} skipped=${r.skipped_reason ?? "-"} ` +
          `listed=${r.files_listed} processed=${r.processed.length} written=${r.written} ` +
          `github_error=${r.github_error ? "yes" : "no"} envelope=${r.envelope_recorded}`,
      );
    } catch (err) {
      console.error("[experience-proposals] tick failed (non-fatal, retried next tick):", err);
    } finally {
      experienceProposalsRunning = false;
    }
  });
  setTimeout(() => { void experienceProposalsTick(); }, 5 * 60_000);
  setInterval(() => { void experienceProposalsTick(); }, 60 * 60_000);
}

// ─── A2A dev-request 2026-10-06-experiences-enrichment-plattformjobb-og-
// felles-serverjobbramme, tillegg 2026-10-15 «4b-forslag»: gårdssalg
// visit-text proposals — same file-queue mechanics as the description
// proposals job above (services/proposal-file-queue.ts), reading
// `gardssalg-visit-proposals/` in slookisen/A2A and storing through
// applyGardssalgVisitProposals() with the server re-fetching every source.
// Never calls an LLM. OFF by default: GARDSSALG_VISIT_PROPOSALS_JOB_ENABLED
// === "true" turns it on; flipping it back is the rollback. First tick 6
// minutes after boot, hourly after that; an overlapping tick is skipped.
if (process.env.ENABLE_EXPERIENCES === "1") {
  let gardssalgVisitProposalsRunning = false;
  const gardssalgVisitProposalsTick = trackJob("gardssalg-visit-proposals", async () => {
    if (gardssalgVisitProposalsRunning) return;
    gardssalgVisitProposalsRunning = true;
    try {
      const { tickGardssalgVisitProposals } = await import("./services/gardssalg-visit-proposals-job");
      const r = await tickGardssalgVisitProposals();
      if (r.skipped_reason === "disabled") return;
      console.log(
        `[gardssalg-visit-proposals] tick run_id=${r.run_id} skipped=${r.skipped_reason ?? "-"} ` +
          `listed=${r.files_listed} processed=${r.processed.length} written=${r.written} ` +
          `github_error=${r.github_error ? "yes" : "no"} envelope=${r.envelope_recorded}`,
      );
    } catch (err) {
      console.error("[gardssalg-visit-proposals] tick failed (non-fatal, retried next tick):", err);
    } finally {
      gardssalgVisitProposalsRunning = false;
    }
  });
  setTimeout(() => { void gardssalgVisitProposalsTick(); }, 6 * 60_000);
  setInterval(() => { void gardssalgVisitProposalsTick(); }, 60 * 60_000);
}

// ─── A2A dev-request 2026-10-06-experiences-enrichment-plattformjobb-og-
// felles-serverjobbramme, tillegg 2026-10-15 «4b-det»: the gårdssalg content
// queue (drink cohort first, then generic) drained by the platform once a
// day, exactly like gardssalg-outreach-daily below ───────────────────────
//
// Checks every 10 minutes; fires once inside the configured UTC hour
// (GARDSSALG_CONTENT_REFRESH_JOB_WINDOW_HOUR_UTC, default 03) via
// shouldRunGardssalgContentRefreshDaily. The run calls the SAME shared core
// as POST /admin/gardssalg-content-refresh with llm:false — the job never
// calls an LLM (Daniel 2026-10-08). OFF by default:
// GARDSSALG_CONTENT_REFRESH_JOB_ENABLED=true turns it on, and flipping it
// back is the rollback. The last-completed stamp is persisted
// (boot_job_state), so a deploy inside the window cannot run it twice.
// Manual/dry runs: POST /api/opplevelser/admin/gardssalg-content-refresh-job-run.
if (process.env.ENABLE_EXPERIENCES === "1") {
  let lastGardssalgCrRunAt: Date | null = null;
  let gardssalgCrRunning = false;
  const gardssalgCrDailyTick = trackJob("gardssalg-content-refresh-daily", async () => {
    if (gardssalgCrRunning) return;
    gardssalgCrRunning = true;
    const now = new Date();
    try {
      const { tickGardssalgContentRefreshDaily } = await import("./services/gardssalg-content-refresh-job");
      const t = await tickGardssalgContentRefreshDaily({ now, lastRunAt: lastGardssalgCrRunAt });
      lastGardssalgCrRunAt = t.lastRunAt;
      const r = t.report;
      if (!r) return;
      console.log(
        `[gardssalg-content-refresh-daily] run_id=${r.run_id} skipped=${r.skipped_reason ?? "-"} ` +
          `drink=${r.totals.drink_enriched} generic=${r.totals.generic_enriched} scanned=${r.totals.scanned} ` +
          `calls=${r.totals.calls} judge_required=${r.totals.judge_required_rows} envelope=${r.envelope_recorded}`,
      );
    } catch (err) {
      console.error("[gardssalg-content-refresh-daily] tick failed (non-fatal, retried next tick):", err);
    } finally {
      gardssalgCrRunning = false;
    }
  });
  setTimeout(() => { void gardssalgCrDailyTick(); }, 7 * 60_000);
  setInterval(() => { void gardssalgCrDailyTick(); }, 10 * 60_000);
}

// ─── dev-request 2026-09-03-opplevagent-sending-uten-llm-i-sendestien
// (option A, Daniel GO 2026-09-05): gårdssalg outreach is sent by the
// platform itself once a day ──────────────────────────────────────────
//
// Checks every 10 minutes; fires once inside the 08:00–08:59 UTC window
// (10:00 norsk sommertid) via shouldRunGardssalgOutreachDaily, exactly like
// the auto-prune block above. The job's own four guards (env switch, lane
// pause, fresh bounce/complaint → auto-pause, today's cap already sent) live
// in runGardssalgOutreachDaily — the DB is the memory, so a restart or a
// second tick inside the window cannot double-send. `lastRunAt` is only
// stamped after a run that did not throw, so a transient DB error at 08:00
// is retried on the next tick within the window. The stamp is also persisted
// (boot_job_state, via tickGardssalgOutreachDaily), so a deploy/restart later
// inside the window does not run the job a second time that day.
//
// Disable on dev / CI (or as a deploy-level kill-switch) with
// GARDSSALG_OUTREACH_DAILY_DISABLED=1. Manual/dry runs:
// POST /api/opplevelser/admin/gardssalg-outreach-daily-run.
if (
  process.env.ENABLE_EXPERIENCES === "1" &&
  process.env.GARDSSALG_OUTREACH_DAILY_DISABLED !== "1"
) {
  let lastGardssalgOutreachRunAt: Date | null = null;
  const gardssalgOutreachDailyTick = trackJob("gardssalg-outreach-daily", async () => {
    const now = new Date();
    try {
      const { tickGardssalgOutreachDaily } = await import("./routes/opplevelser");
      const t = await tickGardssalgOutreachDaily({ now, lastRunAt: lastGardssalgOutreachRunAt });
      lastGardssalgOutreachRunAt = t.lastRunAt;
      const r = t.report;
      if (!r) return;
      console.log(
        `[gardssalg-outreach-daily] tick run_id=${r.run_id} skipped=${r.skipped_reason ?? "-"} ` +
          `sent=${r.summary.sent} errors=${r.summary.error} budget=${r.budget} cap=${r.daily_cap} ` +
          `auto_paused=${r.auto_paused} envelope=${r.envelope_recorded}`,
      );
    } catch (err) {
      console.error("[gardssalg-outreach-daily] tick failed (non-fatal, retried next tick):", err);
    }
  });
  setTimeout(() => { void gardssalgOutreachDailyTick(); }, 90_000);
  setInterval(() => { void gardssalgOutreachDailyTick(); }, 10 * 60_000);
}

// ─── dev-request 2026-09-19-rfb-marketing-utsending-inn-i-plattformjobben
// (Daniel «GO A» 2026-09-19, reconfirmed 2026-09-22): RFB outreach is sent
// by the platform itself once a day ────────────────────────────────────
//
// Same shape as the gårdssalg block just above, in its own 08:10–08:59 UTC
// window (after gårdssalg's 08:00Z start) via shouldRunRfbMarketingDaily.
// Registered ONLY when RFB_MARKETING_PLATFORM_ENABLED=1 (default OFF — no
// tick exists at all otherwise), and the job re-checks that same switch as
// its guard G1. Its other guards (lane pause, fresh bounce/complaint →
// auto-pause, /health-equivalent red, today's budget) live in
// runRfbMarketingDaily and read the DATABASE, not this process's memory: a
// restart or a second tick inside the window can never exceed the cap or
// re-send an address (every recipient is reserved in rfb_marketing_send_ledger
// before its e-mail leaves). `lastRunAt` is only stamped after a run that did
// not throw and was not skipped for run_in_progress/health_red, so a transient
// DB error or health dip at 08:10 is retried on the next tick in the window.
// The stamp is also persisted (boot_job_state, via tickRfbMarketingDaily), so
// a deploy/restart later inside the window does not run the job twice a day.
// Statically imported (not `await import(...)`): one module instance, one
// database/init singleton. Manual/dry runs: POST /admin/rfb-marketing-daily-run.
if (process.env.RFB_MARKETING_PLATFORM_ENABLED === "1") {
  let lastRfbMarketingRunAt: Date | null = null;
  const rfbMarketingDailyTick = trackJob("rfb-marketing-daily", async () => {
    const now = new Date();
    try {
      // Not today's run — tickRfbMarketingDaily leaves the stamp alone so the
      // next tick inside the window retries: a manual run that was still in
      // flight, or a transient health_red (memory/disk "critical" at 08:10
      // must not cost the whole day) — rfbMarketingRunConsumesWindow.
      const t = await tickRfbMarketingDaily({ now, lastRunAt: lastRfbMarketingRunAt });
      lastRfbMarketingRunAt = t.lastRunAt;
      const r = t.report;
      if (!r) return;
      console.log(
        `[rfb-marketing-daily] tick run_id=${r.run_id} skipped=${r.skipped_reason ?? "-"} ` +
          `stopped=${r.stopped_reason ?? "-"} sent=${r.summary.sent} errors=${r.summary.error} ` +
          `budget=${r.budget} cap=${r.daily_cap} auto_paused=${r.auto_paused} envelope=${r.envelope_recorded}`,
      );
    } catch (err) {
      console.error("[rfb-marketing-daily] tick failed (non-fatal, retried next tick):", err);
    }
  });
  setTimeout(() => { void rfbMarketingDailyTick(); }, 120_000);
  setInterval(() => { void rfbMarketingDailyTick(); }, 10 * 60_000);
}

// ─── dev-request 2026-10-10-rfb-berikelse-nattjobb (R6; Daniel GO 2026-10-10,
// amended live 2026-10-11): the nightly RFB enrichment job ─────────────────
//
// Runs the EXISTING enrichment tools (URL probe, e-mail-domain website
// candidate → review queue, Brreg contact fields, Bondens Marked harvest over
// a rotating slug window, contact extraction, homepage content refresh) on a
// small capped batch of uncontacted RFB producers, then re-verifies the rows
// it changed with the verifier's own batch path. Never sends anything, never
// lowers a gate. Registered ONLY when RFB_ENRICHMENT_NIGHTLY_ENABLED is
// "1"/"true" (default OFF — no tick exists otherwise; the job re-checks it).
// Checks every 5 minutes; runs once per ~day inside RFB_ENRICHMENT_NIGHTLY_
// HOURS_UTC (default 00–01Z), never in 08:00–08:59Z, and only while it holds
// the verifier's own DB tick lock (so never concurrently with a verifier
// tick). Statically imported: one module instance, one DB singleton. The
// "ran today" stamp is persisted (boot_job_state). Manual/dry runs:
// POST /admin/rfb-enrichment-nightly/run, GET /admin/rfb-enrichment-nightly/preview.
if (isRfbEnrichmentNightlyEnabled()) {
  let lastRfbEnrichmentRunAt: Date | null = null;
  let rfbEnrichmentTickRunning = false;
  const rfbEnrichmentNightlyTick = trackJob("rfb-enrichment-nightly", async () => {
    if (rfbEnrichmentTickRunning) return;
    rfbEnrichmentTickRunning = true;
    try {
      const t = await tickRfbEnrichmentNightly({ now: new Date(), lastRunAt: lastRfbEnrichmentRunAt });
      lastRfbEnrichmentRunAt = t.lastRunAt;
      const r = t.report;
      if (!r) return;
      console.log(
        `[rfb-enrichment-nightly] tick run_id=${r.run_id} skipped=${r.skipped_reason ?? "-"} ` +
          `stopped=${r.stopped_reason ?? "-"} written=${r.totals.written} re_verified=${r.totals.re_verified} ` +
          `new_in_pool=${r.totals.new_in_pool} llm=${r.llm.calls}/${r.llm.cap} envelope=${r.envelope_recorded}`,
      );
    } catch (err) {
      console.error("[rfb-enrichment-nightly] tick failed (non-fatal, retried next tick):", err);
    } finally {
      rfbEnrichmentTickRunning = false;
    }
  });
  setTimeout(() => { void rfbEnrichmentNightlyTick(); }, RFB_ENRICHMENT_FIRST_TICK_MS);
  setInterval(() => { void rfbEnrichmentNightlyTick(); }, RFB_ENRICHMENT_TICK_MS);
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
// Prepayment lifecycle job (A2A dev-request 2026-10-09-rfb-forhandsbetaling-
// stripe-connect, skive 3): releases reservations the producer did not
// confirm in time, retries captures/releases that failed, and catches
// payment links whose webhook never arrived. With PAYMENTS_ENABLED=1 or
// "drain" (rollback: finishes open payments, creates no new ones);
// RFB_DISABLE_PAYMENT_MAINTENANCE=1 turns it off (dev / CI).
if ((process.env.PAYMENTS_ENABLED === "1" || process.env.PAYMENTS_ENABLED === "drain") && process.env.RFB_DISABLE_PAYMENT_MAINTENANCE !== "1") {
  setInterval(trackJob("payment-maintenance", async () => {
    try {
      const { resolvePaymentsStripeClient, runPaymentMaintenance } = await import("./services/payment-service");
      const stripe = resolvePaymentsStripeClient();
      if (!stripe) return;
      const r = await runPaymentMaintenance({ stripe });
      if (r.expired_orders || r.captured || r.released || r.sessions_expired || r.intents_synced) {
        console.log(`[payments] maintenance: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error("[payments] maintenance tick failed (non-fatal):", err);
    }
  }), 10 * 60_000);
}

// Mirrors the experiences-geocode scheduler above: gated on the experiences
// vertical being enabled (otherwise experiences.db isn't open), disable on
// dev / CI with RFB_DISABLE_BOOKING_FOLLOWUPS=1.
if (
  process.env.RFB_DISABLE_BOOKING_FOLLOWUPS !== "1" &&
  process.env.ENABLE_EXPERIENCES === "1"
) {
  setInterval(trackJob("booking-followups", async () => {
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
  }), 60 * 60_000);
}

// ─── F4 (dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel):
// order follow-ups — one re-send of a failed producer e-mail, one reminder
// (+ admin alert) after ORDER_REMINDER_HOURS (24), auto-cancel with
// producer_no_response after ORDER_AUTOCANCEL_HOURS (72) for pay-at-pickup
// orders nobody answered. Hourly; idempotent (services/order-followups.ts).
// Rollback: set the hours very high, or RFB_DISABLE_ORDER_FOLLOWUPS=1.
// Skive 1b (S3): a bare 60-min setInterval restarts its clock on every deploy
// or machine restart, so with restarts more often than hourly the job never
// ran. It now also runs once 5 min after boot; the job is idempotent, so the
// extra run is harmless.
if (process.env.RFB_DISABLE_ORDER_FOLLOWUPS !== "1") {
  const orderFollowupsTick = trackJob("order-followups", async () => {
    try {
      const { processOrderFollowups } = await import("./services/order-followups");
      const r = await processOrderFollowups();
      if (r.retried || r.reminders_sent || r.cancelled || r.auto_completed || r.errors) {
        console.log(
          `[order-followups] tick examined=${r.examined} retried=${r.retried} reminders=${r.reminders_sent} ` +
          `cancelled=${r.cancelled} auto_completed=${r.auto_completed} errors=${r.errors}`
        );
      }
    } catch (err) {
      console.error("[order-followups] tick failed:", err);
    }
  });
  setTimeout(() => {
    console.log("[order-followups] first run after boot");
    void orderFollowupsTick();
  }, 5 * 60_000);
  setInterval(orderFollowupsTick, 60 * 60_000);
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
// Skipped entirely when no routine is configured — neither FIRE_ROUTINES nor any
// FIRE_ROUTINE_<AGENT>_TOKEN/_TRIG pair maps one (nothing could fire anyway —
// also keeps dev/CI silent). Interval override: DISPATCH_TICK_INTERVAL_MIN
// (clamped to [2, 120] by resolveTickIntervalMin).
const dispatchRoutinesConfigured = Object.keys(parseRoutines().map).length > 0;
if (process.env.DISPATCH_TICK_DISABLED === "1" || !dispatchRoutinesConfigured) {
  console.log(
    "[dispatch-tick] disabled — " +
    (process.env.DISPATCH_TICK_DISABLED === "1"
      ? "DISPATCH_TICK_DISABLED=1 (kill-switch)"
      : process.env.FIRE_ROUTINES && !parseRoutines().diag.parse_ok
        ? "no routine configured (FIRE_ROUTINES is set but does not parse — see GET /admin/loop-dispatch fire_routines.parse_error)"
        : "no routine configured (FIRE_ROUTINES / FIRE_ROUTINE_<AGENT>_* unset — nothing could fire)"),
  );
} else {
  const tickIntervalMin = resolveTickIntervalMin(process.env.DISPATCH_TICK_INTERVAL_MIN);
  console.log(`[dispatch-tick] enabled — runDispatchTick("active") every ${tickIntervalMin} min`);

  const dispatchTick = trackJob("dispatch-tick", async (label: string) => {
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
  });

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
process.on("SIGTERM", () => { discoveryService.shutdown(); flushAiDeliveries(); closeDb(); process.exit(0); });
process.on("SIGINT", () => { discoveryService.shutdown(); flushAiDeliveries(); closeDb(); process.exit(0); });

export default app;
