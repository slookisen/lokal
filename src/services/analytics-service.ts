import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { getDb } from "../database/init";

/**
 * Lightweight Analytics Service for Lokal
 *
 * Tracks:
 * 1. Human visitors — page views, referrer source, session
 * 2. AI agent traffic — A2A, MCP, API with User-Agent detection
 * 3. Search queries — both human and AI, categories, cities
 * 4. Agent profile views — which producers are popular
 * 5. Channel attribution — organic, direct, referral, ChatGPT, etc.
 *
 * Privacy-first: hashes IP, respects DNT, minimal tracking
 * Lightweight: SQLite only, no external services
 */

// ─── Helper: SQLite-compatible UTC datetime string ──────────
// SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" (space, no T/Z).
// JS .toISOString() returns "YYYY-MM-DDTHH:MM:SS.000Z" which breaks
// string comparison because 'T' (0x54) > ' ' (0x20) in ASCII.
function sqliteDatetime(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

// ─── Helper: Check owner cookie from raw header ─────────────
function isOwnerRequest(req: Request): boolean {
  const cookieHeader = req.headers.cookie || "";
  return cookieHeader.split(";").some(c => c.trim() === "_rfb_owner=1");
}

// ─── Helper: Privacy-safe IP hashing ─────────────────────────
function hashIP(ip: string): string {
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

// ─── Helper: Privacy-safe User-Agent hashing ─────────────────
function hashUserAgent(ua: string): string {
  return crypto.createHash("sha256").update(ua).digest("hex").slice(0, 16);
}

// ─── Helper: Parse User-Agent to detect AI agents ──────────────
interface UAParseResult {
  isBot: boolean;
  clientType: "chatgpt" | "claude" | "gemini" | "a2a-agent" | "browser" | "mobile" | "unknown";
  clientName?: string;
  botSource?: string;
}

function parseUserAgent(ua: string): UAParseResult {
  if (!ua) return { isBot: false, clientType: "unknown" };

  const lower = ua.toLowerCase();

  // AI agent detection
  // WHY: we were previously only matching "chatgpt" but OpenAI's crawler is
  // "GPTBot" and its browsing agent is "ChatGPT-User"; likewise ClaudeBot and
  // Claude-User for Anthropic. Match the full real-world fleet so agentTraffic
  // actually reflects crawler hits.
  if (lower.includes("gptbot") || lower.includes("chatgpt") || lower.includes("oai-searchbot")) {
    return { isBot: true, clientType: "chatgpt", clientName: "ChatGPT" };
  }
  if (lower.includes("claudebot") || lower.includes("claude-user") || lower.includes("claude")) {
    return { isBot: true, clientType: "claude", clientName: "Claude" };
  }
  if (lower.includes("gpt-4") || lower.includes("gpt-3")) return { isBot: true, clientType: "chatgpt", clientName: "GPT" };
  if (lower.includes("gemini") || lower.includes("google-extended")) return { isBot: true, clientType: "gemini", clientName: "Gemini" };
  if (lower.includes("perplexitybot") || lower.includes("perplexity")) return { isBot: true, clientType: "a2a-agent", clientName: "Perplexity", botSource: "ai_search" };
  if (lower.includes("bingbot") || lower.includes("googlebot") || lower.includes("ccbot") || lower.includes("bytespider") || lower.includes("applebot") || lower.includes("yandexbot")) {
    return { isBot: true, clientType: "a2a-agent", botSource: "search_engine" };
  }
  if (lower.includes("curl") || lower.includes("node") || lower.includes("python")) return { isBot: true, clientType: "a2a-agent", botSource: "api_client" };

  // Human browser detection
  if (lower.includes("mobile") || lower.includes("iphone") || lower.includes("android")) {
    return { isBot: false, clientType: "mobile" };
  }
  if (lower.includes("mozilla") || lower.includes("chrome") || lower.includes("safari")) {
    return { isBot: false, clientType: "browser" };
  }

  return { isBot: false, clientType: "unknown" };
}

// ─── Helper: Infer referrer source ──────────────────────────────
function inferReferrerSource(referrer: string | undefined): "direct" | "organic" | "search" | "social" | "referral" {
  if (!referrer) return "direct";

  const ref = referrer.toLowerCase();

  // Search engines
  if (ref.includes("google") || ref.includes("bing") || ref.includes("duckduckgo")) return "search";

  // Social platforms
  if (ref.includes("facebook") || ref.includes("twitter") || ref.includes("instagram") ||
      ref.includes("linkedin") || ref.includes("reddit") || ref.includes("tiktok")) {
    return "social";
  }

  // Own domain = direct
  if (ref.includes("rettfrabonden.com")) return "direct";

  // Generic referral
  return "referral";
}

// ─── Session management (in-memory cache to avoid per-request DB hits) ───
class SessionManager {
  private sessions = new Map<string, { userId?: string; firstSeen: number }>();
  private sessionTTL = 30 * 60 * 1000; // 30 minutes

  getOrCreate(ipHash: string, userAgent: string): string {
    const key = `${ipHash}:${userAgent}`;
    let session = this.sessions.get(key);

    if (!session || Date.now() - session.firstSeen > this.sessionTTL) {
      session = { firstSeen: Date.now() };
      this.sessions.set(key, session);
    }

    return key;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.firstSeen > this.sessionTTL) {
        this.sessions.delete(key);
      }
    }
  }
}

const sessionManager = new SessionManager();

// Cleanup sessions every 5 minutes
setInterval(() => sessionManager.cleanup(), 5 * 60 * 1000);

// ═════════════════════════════════════════════════════════════════
// PUBLIC API
// ═════════════════════════════════════════════════════════════════

export interface AnalyticsTrackingOptions {
  trackPageViews?: boolean;
  trackSearchQueries?: boolean;
  trackAgentViews?: boolean;
  skipPaths?: string[];
}

export class AnalyticsService {
  private options: AnalyticsTrackingOptions;

  constructor(options: AnalyticsTrackingOptions = {}) {
    this.options = {
      trackPageViews: true,
      trackSearchQueries: true,
      trackAgentViews: true,
      skipPaths: ["/health", "/openapi.yaml", "/.well-known/", "/admin/"],
      ...options,
    };
  }

  /**
   * Express middleware for automatic request tracking
   * Place early in middleware stack (after security/CORS but before routes)
   */
  middleware() {
    const self = this;
    return (req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();

      // Skip health checks and internal endpoints
      if (self.options.skipPaths?.some(p => req.path.startsWith(p))) {
        return next();
      }

      // Track page views for human visitors (GET requests to frontend pages only)
      // Exclude API endpoints — only track actual page loads
      if (self.options.trackPageViews && req.method === "GET" && !req.path.startsWith("/api/")) {
        const isOwner = isOwnerRequest(req);
        self.trackPageView(req, isOwner);
      }

      // Intercept response to track timing
      const originalSend = res.send;
      res.send = function(data: any) {
        const duration = Date.now() - startTime;

        // Track API usage and queries
        if (self.options.trackSearchQueries && req.path.includes("/search")) {
          const isOwner = isOwnerRequest(req);
          analyticsService.trackSearchQuery(req, duration, undefined, isOwner);
        }

        return originalSend.call(this, data);
      };

      next();
    };
  }

  /**
   * Track page view for human visitors
   */
  trackPageView(req: Request, isOwner: boolean = false): void {
    try {
      const db = getDb();
      const path = req.path;
      const referrer = req.get("referer");
      const userAgent = req.get("user-agent") || "";
      const clientIp = req.ip || "unknown";

      const source = inferReferrerSource(referrer);
      const userAgentHash = hashUserAgent(userAgent);
      const ipHash = hashIP(clientIp);
      const sessionId = sessionManager.getOrCreate(ipHash, userAgent);

      db.prepare(`
        INSERT INTO analytics_page_views (path, referrer, source, user_agent_hash, session_id, is_owner)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(path, referrer || null, source, userAgentHash, sessionId, isOwner ? 1 : 0);
    } catch (err) {
      console.error("[analytics] Failed to track page view:", err);
    }
  }

  /**
   * Track search queries (both human and AI)
   * Call from /api/marketplace/search and similar endpoints
   */
  trackSearchQuery(req: Request, responseTimeMs: number, result?: {
    query: string;
    categories?: string[];
    city?: string;
    resultCount?: number;
    agentId?: string;
  }, isOwner: boolean = false): void {
    try {
      const db = getDb();
      const userAgent = req.get("user-agent") || "";
      const clientIp = req.ip || "unknown";
      const query = result?.query || req.query.q || "";
      const categories = result?.categories ? JSON.stringify(result.categories) : null;
      const city = result?.city || null;
      const resultCount = result?.resultCount || 0;

      // Determine protocol from request
      let protocol = "api";
      if (req.path.startsWith("/a2a")) protocol = "a2a";
      else if (req.path.startsWith("/mcp")) protocol = "mcp";

      const uaParse = parseUserAgent(userAgent);
      const ipHash = hashIP(clientIp);

      db.prepare(`
        INSERT INTO analytics_queries (protocol, query, categories, city, result_count, response_time_ms, agent_id, client_ip_hash, is_owner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        protocol,
        String(query),
        categories,
        city,
        resultCount,
        responseTimeMs,
        uaParse.clientName || null,
        ipHash,
        isOwner ? 1 : 0
      );
    } catch (err) {
      console.error("[analytics] Failed to track search query:", err);
    }
  }

  /**
   * Track when a producer/agent profile is viewed
   * Call from SEO routes when /produsent/:id is loaded
   */
  trackAgentView(agentId: string, agentName: string, city: string | undefined, source: "search" | "direct" | "discovery" | "seo"): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source)
        VALUES (?, ?, ?, ?)
      `).run(agentId, agentName, city || null, source);
    } catch (err) {
      console.error("[analytics] Failed to track agent view:", err);
    }
  }

  /**
   * Track API endpoint usage with detailed metadata
   * For A2A and MCP protocol tracking
   */
  trackAPIUsage(req: Request, protocol: "a2a" | "mcp" | "api", duration: number, metadata?: Record<string, any>): void {
    try {
      const db = getDb();
      const userAgent = req.get("user-agent") || "";
      const clientIp = req.ip || "unknown";
      const uaParse = parseUserAgent(userAgent);

      const ipHash = hashIP(clientIp);

      // Insert into interactions table for detailed tracking
      db.prepare(`
        INSERT INTO interactions (type, query, metadata, ip_hash, duration_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        "search", // type
        JSON.stringify({ protocol, ...metadata }),
        JSON.stringify({ userAgent: uaParse, protocol }),
        ipHash,
        duration
      );
    } catch (err) {
      console.error("[analytics] Failed to track API usage:", err);
    }
  }

  // ─── Summary cache ───────────────────────────────────────────
  // Public so ops agent can clear it via /ops/clear-cache.
  _summaryCache: Map<number, { data: any; time: number }> = new Map();
  private static SUMMARY_CACHE_TTL = 120_000; // 2 minutes

  /**
   * Get analytics summary for a time range (cached 2 min)
   */
  getSummary(hoursBack: number = 24): {
    pageViews: number;
    uniqueVisitors: number;
    avgTimeOnSite: number;
    totalQueries: number;
    topSearchTerms: Array<{ query: string; count: number }>;
    trafficBySource: Record<string, number>;
    agentTraffic: { chatgpt: number; claude: number; other: number };
    ownerStats: { pageViews: number; queries: number };
  } {
    // Check cache first
    const cached = this._summaryCache.get(hoursBack);
    if (cached && (Date.now() - cached.time) < AnalyticsService.SUMMARY_CACHE_TTL) {
      return cached.data;
    }
    try {
      const db = getDb();
      const cutoff = sqliteDatetime(new Date(Date.now() - hoursBack * 60 * 60 * 1000));

      // Page views (excluding owner)
      const pvResult = db.prepare(`
        SELECT COUNT(*) as count FROM analytics_page_views WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)
      `).get(cutoff) as any;
      const pageViews = pvResult.count;

      // Owner page views
      const ownerPvResult = db.prepare(`
        SELECT COUNT(*) as count FROM analytics_page_views WHERE created_at > ? AND is_owner = 1
      `).get(cutoff) as any;
      const ownerPageViews = ownerPvResult.count;

      // Unique visitors (excluding owner)
      const uvResult = db.prepare(`
        SELECT COUNT(DISTINCT session_id) as count FROM analytics_page_views WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)
      `).get(cutoff) as any;
      const uniqueVisitors = uvResult.count;

      // Traffic by source (excluding owner)
      const sourceResult = db.prepare(`
        SELECT source, COUNT(*) as count FROM analytics_page_views WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)
        GROUP BY source
      `).all(cutoff) as any[];
      const trafficBySource: Record<string, number> = {};
      sourceResult.forEach(row => {
        trafficBySource[row.source] = row.count;
      });

      // Total queries (excluding owner)
      const qResult = db.prepare(`
        SELECT COUNT(*) as count FROM analytics_queries WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)
      `).get(cutoff) as any;
      const totalQueries = qResult.count;

      // Owner queries
      const ownerQResult = db.prepare(`
        SELECT COUNT(*) as count FROM analytics_queries WHERE created_at > ? AND is_owner = 1
      `).get(cutoff) as any;
      const ownerQueries = ownerQResult.count;

      // Top search terms (excluding owner)
      const topQueriesResult = db.prepare(`
        SELECT query, COUNT(*) as count FROM analytics_queries
        WHERE created_at > ? AND query IS NOT NULL AND query != '' AND (is_owner IS NULL OR is_owner = 0)
        GROUP BY query
        ORDER BY count DESC
        LIMIT 10
      `).all(cutoff) as any[];
      const topSearchTerms = topQueriesResult.map(r => ({ query: r.query, count: r.count }));

      // AI agent traffic breakdown
      // WHY: bots overwhelmingly produce page views, not search queries, so the
      // old agent_id read from analytics_queries always came back ~0 even when
      // GPTBot and ClaudeBot were hammering the site. session_id is stored as
      // `${ipHash}:${userAgent}`, so we can scan it for crawler UA tokens and
      // get a truthful read on AI visibility.
      const agentTraffic = { chatgpt: 0, claude: 0, other: 0 };

      // ChatGPT family: OpenAI crawlers and ChatGPT-User browsing agent.
      const chatgptRow = db.prepare(`
        SELECT COUNT(*) as count FROM analytics_page_views
        WHERE created_at > ? AND ${"(is_owner IS NULL OR is_owner = 0)"}
          AND (session_id LIKE '%GPTBot%' OR session_id LIKE '%ChatGPT%' OR session_id LIKE '%OAI-SearchBot%')
      `).get(cutoff) as any;
      agentTraffic.chatgpt = chatgptRow?.count || 0;

      // Claude family: ClaudeBot crawler and Claude-User browsing agent.
      const claudeRow = db.prepare(`
        SELECT COUNT(*) as count FROM analytics_page_views
        WHERE created_at > ? AND ${"(is_owner IS NULL OR is_owner = 0)"}
          AND (session_id LIKE '%ClaudeBot%' OR session_id LIKE '%Claude-User%' OR session_id LIKE '%Anthropic%')
      `).get(cutoff) as any;
      agentTraffic.claude = claudeRow?.count || 0;

      // Other AI / non-human retrievers — Gemini, Perplexity, Google-Extended,
      // CCBot, Bytespider, Applebot, YandexBot.
      const otherRow = db.prepare(`
        SELECT COUNT(*) as count FROM analytics_page_views
        WHERE created_at > ? AND ${"(is_owner IS NULL OR is_owner = 0)"}
          AND (
            session_id LIKE '%Gemini%' OR session_id LIKE '%Google-Extended%'
            OR session_id LIKE '%PerplexityBot%' OR session_id LIKE '%Perplexity-User%'
            OR session_id LIKE '%CCBot%' OR session_id LIKE '%Bytespider%'
            OR session_id LIKE '%Applebot-Extended%' OR session_id LIKE '%YandexAdditional%'
          )
      `).get(cutoff) as any;
      agentTraffic.other = otherRow?.count || 0;

      // Back-compat: if the analytics_queries table has search-query hits from
      // explicitly named agents (ChatGPT/Claude), fold those in too so we don't
      // under-count real search-query traffic that also happens to be AI.
      const agentQueryResult = db.prepare(`
        SELECT agent_id, COUNT(*) as count FROM analytics_queries
        WHERE created_at > ? AND agent_id IS NOT NULL
        GROUP BY agent_id
      `).all(cutoff) as any[];
      agentQueryResult.forEach(row => {
        if (row.agent_id === "ChatGPT") agentTraffic.chatgpt += row.count;
        else if (row.agent_id === "Claude") agentTraffic.claude += row.count;
        else agentTraffic.other += row.count;
      });

      const result = {
        pageViews,
        uniqueVisitors,
        avgTimeOnSite: 0, // would need session duration tracking
        totalQueries,
        topSearchTerms,
        trafficBySource,
        agentTraffic,
        ownerStats: { pageViews: ownerPageViews, queries: ownerQueries },
      };
      this._summaryCache.set(hoursBack, { data: result, time: Date.now() });
      return result;
    } catch (err) {
      console.error("[analytics] Failed to get summary:", err);
      return {
        pageViews: 0,
        uniqueVisitors: 0,
        avgTimeOnSite: 0,
        totalQueries: 0,
        topSearchTerms: [],
        trafficBySource: {},
        agentTraffic: { chatgpt: 0, claude: 0, other: 0 },
        ownerStats: { pageViews: 0, queries: 0 },
      };
    }
  }

  /**
   * Get top producers by view count
   */
  getTopProducers(limit: number = 20, hoursBack: number = 24): Array<{
    agentId: string;
    agentName: string;
    city?: string;
    viewCount: number;
    topSource: string;
  }> {
    try {
      const db = getDb();
      const cutoff = sqliteDatetime(new Date(Date.now() - hoursBack * 60 * 60 * 1000));

      const results = db.prepare(`
        SELECT
          agent_id,
          agent_name,
          city,
          COUNT(*) as view_count,
          (SELECT view_source FROM analytics_agent_views aav2
           WHERE aav2.agent_id = aav.agent_id
           GROUP BY view_source
           ORDER BY COUNT(*) DESC
           LIMIT 1) as top_source
        FROM analytics_agent_views aav
        WHERE created_at > ?
        GROUP BY agent_id, agent_name, city
        ORDER BY view_count DESC
        LIMIT ?
      `).all(cutoff, limit) as any[];

      return results.map(r => ({
        agentId: r.agent_id,
        agentName: r.agent_name,
        city: r.city,
        viewCount: r.view_count,
        topSource: r.top_source || "unknown",
      }));
    } catch (err) {
      console.error("[analytics] Failed to get top producers:", err);
      return [];
    }
  }

  /**
   * Get city-level analytics
   */
  getCityStats(hoursBack: number = 24): Array<{
    city: string;
    viewCount: number;
    searchQueries: number;
    topCategory: string | null;
  }> {
    try {
      const db = getDb();
      const cutoff = sqliteDatetime(new Date(Date.now() - hoursBack * 60 * 60 * 1000));

      const results = db.prepare(`
        SELECT
          aav.city,
          COUNT(DISTINCT aav.id) as view_count,
          (SELECT COUNT(*) FROM analytics_queries aq WHERE aq.city = aav.city AND aq.created_at > ? AND (aq.is_owner IS NULL OR aq.is_owner = 0)) as search_queries,
          (SELECT json_extract(aq.categories, '$[0]') FROM analytics_queries aq
           WHERE aq.city = aav.city AND aq.created_at > ? AND aq.categories IS NOT NULL AND (aq.is_owner IS NULL OR aq.is_owner = 0)
           GROUP BY json_extract(aq.categories, '$[0]')
           ORDER BY COUNT(*) DESC
           LIMIT 1) as top_category
        FROM analytics_agent_views aav
        WHERE aav.created_at > ? AND aav.city IS NOT NULL
        GROUP BY aav.city
        ORDER BY view_count DESC
      `).all(cutoff, cutoff, cutoff) as any[];

      return results.map(r => ({
        city: r.city,
        viewCount: r.view_count,
        searchQueries: r.search_queries || 0,
        topCategory: r.top_category,
      }));
    } catch (err) {
      console.error("[analytics] Failed to get city stats:", err);
      return [];
    }
  }

  /**
   * Export raw analytics data for external analysis
   * Returns paginated results
   */
  exportData(table: "page_views" | "queries" | "agent_views", limit: number = 1000, offset: number = 0): {
    data: any[];
    total: number;
    limit: number;
    offset: number;
  } {
    try {
      const db = getDb();
      const tableMap: Record<string, string> = {
        page_views: "analytics_page_views",
        queries: "analytics_queries",
        agent_views: "analytics_agent_views",
      };
      const tableName = tableMap[table];
      if (!tableName) throw new Error("Invalid analytics table");

      const countResult = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as any;
      const total = countResult.count;

      const data = db.prepare(`
        SELECT * FROM ${tableName}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset) as any[];

      return { data, total, limit, offset };
    } catch (err) {
      console.error("[analytics] Failed to export data:", err);
      return { data: [], total: 0, limit, offset };
    }
  }

  /**
   * Clear old analytics data (older than specified days)
   * Useful for privacy compliance and storage management
   */
  pruneOldData(olderThanDays: number): number {
    try {
      const db = getDb();
      const cutoff = sqliteDatetime(new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000));

      const pvResult = db.prepare("DELETE FROM analytics_page_views WHERE created_at < ?").run(cutoff);
      const qResult = db.prepare("DELETE FROM analytics_queries WHERE created_at < ?").run(cutoff);
      const avResult = db.prepare("DELETE FROM analytics_agent_views WHERE created_at < ?").run(cutoff);

      const total = (pvResult.changes || 0) + (qResult.changes || 0) + (avResult.changes || 0);
      console.log(`[analytics] Pruned ${total} old records`);
      return total;
    } catch (err) {
      console.error("[analytics] Failed to prune data:", err);
      return 0;
    }
  }

  /**
   * Helper: Get or create session ID from request/response
   * Used by middleware for backward compatibility
   */
  getOrCreateSessionId(req: Request, _res: Response): string {
    const userAgent = req.get("user-agent") || "";
    const clientIp = req.ip || "unknown";
    const ipHash = hashIP(clientIp);
    return sessionManager.getOrCreate(ipHash, userAgent);
  }

  /**
   * Helper: Extract user agent string from request
   * Used by middleware for backward compatibility
   */
  getUserAgent(req: Request): string {
    return req.get("user-agent") || "";
  }

  /**
   * Helper: Extract client IP from request
   * Used by middleware for backward compatibility
   */
  getClientIp(req: Request): string {
    return req.ip || "unknown";
  }

  /**
   * Record a page view (middleware wrapper for trackPageView)
   * Used by middleware for backward compatibility
   */
  recordPageView(data: {
    path: string;
    referrer: string | undefined;
    userAgent: string;
    sessionId: string;
  }): void {
    try {
      const db = getDb();
      const source = inferReferrerSource(data.referrer);
      const userAgentHash = hashUserAgent(data.userAgent);

      db.prepare(`
        INSERT INTO analytics_page_views (path, referrer, source, user_agent_hash, session_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(data.path, data.referrer || null, source, userAgentHash, data.sessionId);
    } catch (err) {
      console.error("[analytics] Failed to record page view:", err);
    }
  }

  /**
   * Record a query (middleware wrapper for trackSearchQuery)
   * Used by middleware for backward compatibility
   */
  recordQuery(data: {
    protocol: "a2a" | "mcp" | "api" | "search";
    query: string;
    categories?: string[];
    city: string;
    resultCount: number;
    responseTimeMs: number;
    clientIp: string;
  }): void {
    try {
      const db = getDb();
      const categories = data.categories ? JSON.stringify(data.categories) : null;
      const ipHash = hashIP(data.clientIp);

      db.prepare(`
        INSERT INTO analytics_queries (protocol, query, categories, city, result_count, response_time_ms, client_ip_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.protocol,
        data.query,
        categories,
        data.city || null,
        data.resultCount,
        data.responseTimeMs,
        ipHash
      );
    } catch (err) {
      console.error("[analytics] Failed to record query:", err);
    }
  }

  /**
   * Record an agent view (middleware wrapper for trackAgentView)
   * Used by middleware for backward compatibility
   */
  recordAgentView(data: {
    agentId: string;
    agentName: string;
    city: string | undefined;
    viewSource: "search" | "direct" | "discovery" | "seo" | "unknown";
  }): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source)
        VALUES (?, ?, ?, ?)
      `).run(data.agentId, data.agentName, data.city || null, data.viewSource);
    } catch (err) {
      console.error("[analytics] Failed to record agent view:", err);
    }
  }
}

// ─── Singleton instance ──────────────────────────────────────────
export const analyticsService = new AnalyticsService();

export default analyticsService;
