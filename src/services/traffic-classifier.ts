/**
 * traffic-classifier.ts — THE shared UA/session traffic classifier
 *
 * dev-request 2026-07-21-analytics-tre-boetter-mcp-logging-a2a-transparens,
 * slice A: before this module, THREE independently-drifting classifier lists
 * existed (parseUserAgent in analytics-service.ts, botPatterns/devPatterns/
 * scannerPatterns in routes/analytics.ts, BOT_PATTERNS/DEV_PATTERNS in
 * traffic-stats.ts). All read paths now classify through this ONE module so
 * the public strips, the admin dashboard and the summary endpoint can never
 * disagree about what a "human" is again.
 *
 * The write path (trackPageView etc.) is deliberately NOT touched — this is a
 * read-side classifier over the UA recovered from session_id, which is stored
 * as `${ipHash}:${fullRawUserAgent}` (analytics-service.ts SessionManager).
 *
 * Bucket semantics (Daniel-decided, 2026-07-21):
 *   human         real browsers (and anything not caught below)
 *   ai_search     HUMAN-INITIATED AI retrieval — a person asked ChatGPT/
 *                 Claude/Perplexity a question and the assistant fetched our
 *                 pages live. ONLY the `*-User` class of agents.
 *   ai_crawler    autonomous AI training/index crawlers (GPTBot, ClaudeBot, …)
 *   search_engine classic search-engine crawlers (Googlebot, bingbot, …)
 *   seo_bot       SEO/backlink-tooling crawlers (SemrushBot, AhrefsBot, …)
 *   social        link-preview fetchers (facebookexternalhit, Slackbot, …)
 *   dev           scripted HTTP clients (curl, python, axios, our own fleet)
 *   other_bot     generic bot/spider/crawl UAs not named above
 *   scanner       (classifySession only) vulnerability scanners — fake old
 *                 Chrome versions and/or wp-admin/.env-style probe paths
 *   scraper       (classifySession only) browser-looking session whose
 *                 request VELOCITY no human produces (isVelocityScraper)
 */

export type TrafficCategory =
  | "human"
  | "ai_search"
  | "ai_crawler"
  | "search_engine"
  | "seo_bot"
  | "social"
  | "dev"
  | "other_bot";

export type SessionCategory = TrafficCategory | "scanner" | "scraper";

// ── Pattern lists ───────────────────────────────────────────────────────────
// ORDER MATTERS: classifyUA checks these lists top-to-bottom, and ai_search
// MUST be checked before ai_crawler (Claude-User must not be swallowed by a
// generic Claude/ClaudeBot check; Perplexity-User before PerplexityBot), and
// every named list before the generic bot/spider/crawl fallback.

/** Human-initiated AI retrieval — ONLY the `*-User` class. */
export const AI_SEARCH_PATTERNS = [
  "ChatGPT-User",
  "Claude-User",
  "Claude-Web",
  "Perplexity-User",
  "DuckAssistBot",
] as const;

/**
 * Autonomous AI crawlers. Daniel explicitly: OAI-SearchBot, Amazonbot and
 * Bytespider are NOT human-initiated search — they belong here.
 */
export const AI_CRAWLER_PATTERNS = [
  "GPTBot",
  "OAI-SearchBot",
  "ClaudeBot",
  "anthropic-ai",
  "PerplexityBot",
  "Google-Extended",
  "GoogleOther",
  // NOTE: no bare "Gemini" pattern — Google's AI crawlers use Google-Extended/GoogleOther,
  // and "Gemini" appears in real human UAs (e.g. Planet Computers Gemini PDA).
  "Amazonbot",
  "Bytespider",
  "CCBot",
  "meta-externalagent",
  "meta-external",
  "Applebot-Extended",
  "cohere-ai",
  "YouBot",
  "cloud-crawler",
  "NotHumanSearch",
  // 2026-10-04 (view-stats honesty): AI/agent-index crawlers seen on prod
  // that previously fell into other_bot — or, for MCPCensus and
  // rokmcp-collector (no bot/spider/crawl substring), straight into human.
  "ExaSearchBot",
  "Reflectionbot",
  "AgentFitBot",
  "AgenstryBot",
  "MCPCensus",
  "rokmcp-collector",
  "WellknownBot",
] as const;

export const SEARCH_ENGINE_PATTERNS = [
  "Googlebot",
  "bingbot",
  "BingPreview",
  "Baiduspider",
  "YandexBot",
  "DuckDuckBot",
  "Applebot",
  "PetalBot",
  "SeekportBot",
  "MojeekBot",
] as const;

export const SEO_BOT_PATTERNS = [
  "SemrushBot",
  "AhrefsBot",
  "DataForSeoBot",
  "MJ12bot",
  "DotBot",
  "AwarioBot",
  "SERankingBacklinksBot",
  "serpstatbot",
  "BLEXBot",
  "ImagesiftBot",
  "Diffbot",
  "Dataprovider",
  "jscrawler",
  "Serpstat",
] as const;

export const SOCIAL_PATTERNS = [
  "facebookexternal",
  "Twitterbot",
  "LinkedInBot",
  "Slackbot",
  "WhatsApp",
  "TelegramBot",
] as const;

export const DEV_PATTERNS = [
  "curl/",
  "Python/",
  "Python-urllib",
  "aiohttp",
  "node-fetch",
  "axios/",
  "Go-http-client",
  "Lokal/",
  "Lokal-Enricher",
] as const;

/** Named bots with no bot/spider/crawl substring, caught by other_bot. */
export const OTHER_BOT_EXTRA_PATTERNS = ["Chiark"] as const;

/**
 * Vulnerability scanners fake plausible-but-stale Chrome versions. This is an
 * exact-version heuristic (mirrors routes/analytics.ts scannerPatterns) — a
 * real Chrome 138 UA never contains e.g. "Chrome/78.0".
 */
export const SCANNER_UA_PATTERNS = [
  "Chrome/78.0",
  "Chrome/89.0",
  "Chrome/95.0",
  "Chrome/58.0",
  "Chrome/102.0",
] as const;

/**
 * Probe paths scanners hammer. Callers with path data (routes/analytics.ts,
 * traffic-stats.ts) query these with LIKE '%pattern%' and pass the result
 * into classifySession({ scannerPaths: true }).
 */
export const SCANNER_PATH_PATTERNS = [
  "wp-admin",
  "wp-login",
  "xmlrpc",
  "wlwmanifest",
  ".env",
  ".git",
  "wp-includes",
] as const;

// ── Classification ──────────────────────────────────────────────────────────

function matchesAny(ua: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => ua.includes(p));
}

/**
 * Pure UA classification into the eight decided buckets.
 *
 * An EMPTY/missing UA is classified as other_bot, NOT human: no real browser
 * sends an empty User-Agent, so counting those as "ekte mennesker" would be
 * dishonest — exactly the kind of flattering-but-wrong number this module
 * exists to kill.
 */
export function classifyUA(userAgent: string): TrafficCategory {
  const ua = userAgent || "";
  if (!ua.trim()) return "other_bot";

  // ai_search BEFORE ai_crawler: Claude-User / Perplexity-User must not be
  // swallowed by the ClaudeBot / PerplexityBot family checks.
  if (matchesAny(ua, AI_SEARCH_PATTERNS)) return "ai_search";
  // ai_crawler BEFORE search_engine: Applebot-Extended must not fall into
  // the plain Applebot (search_engine) bucket.
  if (matchesAny(ua, AI_CRAWLER_PATTERNS)) return "ai_crawler";
  if (matchesAny(ua, SEARCH_ENGINE_PATTERNS)) return "search_engine";
  if (matchesAny(ua, SEO_BOT_PATTERNS)) return "seo_bot";
  if (matchesAny(ua, SOCIAL_PATTERNS)) return "social";
  if (matchesAny(ua, DEV_PATTERNS)) return "dev";
  // Generic fallback LAST: any bot/spider/crawl substring not caught by a
  // named list above, plus named oddballs (Chiark).
  if (
    ua.includes("bot") ||
    ua.includes("Bot") ||
    ua.includes("spider") ||
    ua.includes("crawl") ||
    matchesAny(ua, OTHER_BOT_EXTRA_PATTERNS)
  ) {
    return "other_bot";
  }
  return "human";
}

/**
 * Recover the raw UA from a session_id (`${ipHash}:${fullRawUserAgent}`).
 * UAs can themselves contain colons, so only the FIRST colon splits.
 * A session_id without a colon has no recoverable UA → "".
 */
export function uaFromSessionId(sessionId: string): string {
  return sessionId.includes(":") ? sessionId.split(":").slice(1).join(":") : "";
}

/** True if the UA matches the fake-stale-Chrome scanner heuristic. */
export function isScannerUA(userAgent: string): boolean {
  return matchesAny(userAgent || "", SCANNER_UA_PATTERNS);
}

/**
 * Vendor split of an AI UA (ai_search / ai_crawler) into the chatgpt /
 * claude / other buckets every AI-traffic breakdown reports. ONE definition,
 * shared by AnalyticsService.getSummary.agentTraffic and the per-agent
 * /api/agents/:id/stats aiBreakdown so the two can never disagree. Callers
 * must only pass UAs that already classified as AI.
 */
export function aiVendorBucket(userAgent: string): "chatgpt" | "claude" | "other" {
  const ua = userAgent || "";
  if (/GPTBot|ChatGPT|OAI-SearchBot/i.test(ua)) return "chatgpt";
  if (/Claude|anthropic/i.test(ua)) return "claude";
  return "other";
}

// ── Velocity heuristic ──────────────────────────────────────────────────────
// A browser UA proves nothing: on 2026-10-03 one session with an ordinary
// desktop-Chrome UA fetched 1,570 /produsent pages in 7.5 minutes and was
// counted as 1,570 "human" profile views. No person reads pages that fast,
// so a session above EITHER threshold is a scraper, whatever its UA says.
// Thresholds are strict (">"), and deliberately generous to real visitors.
export const SCRAPER_UNIQUE_PAGES_PER_10_MIN = 60;
export const SCRAPER_PRODUSENT_PAGES_PER_HOUR = 200;

/** Per-session request-velocity aggregates (see getSessionVelocity in analytics-service.ts). */
export interface SessionVelocity {
  /** Distinct paths the session requested within one 10-minute window. */
  uniquePagesIn10Min: number;
  /** Distinct /produsent/* paths the session requested within one 60-minute window. */
  produsentPagesInHour: number;
}

/** Pure velocity rule — usable wherever per-session aggregates exist. */
export function isVelocityScraper(v: SessionVelocity | null | undefined): boolean {
  if (!v) return false;
  return v.uniquePagesIn10Min > SCRAPER_UNIQUE_PAGES_PER_10_MIN
    || v.produsentPagesInHour > SCRAPER_PRODUSENT_PAGES_PER_HOUR;
}

/**
 * Classify a session by its session_id. Callers that know the session hit
 * scanner probe paths (SCANNER_PATH_PATTERNS) pass { scannerPaths: true } to
 * fold it into 'scanner'; callers that have the session's velocity
 * aggregates pass { velocity } to fold a scraper into 'scraper'. Mirrors
 * routes/analytics.ts's precedence: a named bot/dev UA stays in its own
 * bucket; 'scanner'/'scraper' only claim sessions that would otherwise pass
 * as human.
 */
export function classifySession(
  sessionId: string,
  opts?: { scannerPaths?: boolean; velocity?: SessionVelocity | null }
): SessionCategory {
  const ua = uaFromSessionId(sessionId);
  const category = classifyUA(ua);
  if (category === "human" && (isScannerUA(ua) || opts?.scannerPaths)) {
    return "scanner";
  }
  if (category === "human" && isVelocityScraper(opts?.velocity)) {
    return "scraper";
  }
  return category;
}
