import { Router, Request, Response } from "express";
import path from "path";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { analyticsService, VerticalId } from "../services/analytics-service";

// SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" (space-separated).
// JS .toISOString() uses "T" separator which breaks SQLite string comparison.
function sqliteDatetime(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

// Reusable SQL fragment: exclude owner traffic from analytics
const NOT_OWNER = "(is_owner IS NULL OR is_owner = 0)";

// ─── Host-locked vertical (site isolation) ──────────────────────
// The analytics dashboard is also served on the secondary vertical hosts
// (opplevagent.no → experiences, finn-tannlege.com → dental) so each site has
// its own per-site stats view. On those hosts we hard-scope every analytics
// read to that vertical regardless of ?vertical=, so an admin-key holder on
// opplevagent.no can never read rfb/dental data, and vice versa. The central
// admin host (rettfrabonden.com / lokal.fly.dev / localhost) is NOT locked —
// that's where the dashboard switches freely between all verticals.
function lockedVerticalForHost(req: Request): VerticalId | undefined {
  const h = (req.hostname || "").toLowerCase();
  if (h.includes("finn-tannlege")) return "dental";
  if (h.includes("opplevagent")) return "experiences";
  return undefined;
}

// ─── Vertical filter (?vertical=rfb|dental|experiences) ─────────
// All three verticals (rettfrabonden.com + finn-tannlege.com + opplevagent.no)
// run on the same app and write to the same analytics tables, separated by
// vertical_id. Endpoints accept ?vertical=rfb|dental|experiences to split
// traffic per site; anything else (or omitted) = all traffic combined.
// A host lock (see above) always overrides the query param for isolation.
function parseVertical(req: Request): VerticalId | undefined {
  const locked = lockedVerticalForHost(req);
  if (locked) return locked;
  const v = String(req.query.vertical || "").toLowerCase();
  return v === "rfb" || v === "dental" || v === "experiences" ? (v as VerticalId) : undefined;
}
function verticalFilter(req: Request): { sql: string; params: string[] } {
  const v = parseVertical(req);
  return v ? { sql: " AND vertical_id = ?", params: [v] } : { sql: "", params: [] };
}

/**
 * Analytics Admin Routes
 *
 * Endpoints for viewing aggregated analytics data.
 * These are intended for internal dashboards and monitoring.
 *
 * GET /admin/analytics/summary     — High-level stats (last 24h)
 * GET /admin/analytics/summary/:hours — Stats for last N hours
 * GET /admin/analytics/producers  — Top producers by views
 * GET /admin/analytics/cities     — City-level breakdowns
 * GET /admin/analytics/export/:table — Raw data export
 * POST /admin/analytics/prune     — Delete old data
 */

const router = Router();

// ─── Simple auth check ──────────────────────────────────────────
// In production, replace with proper JWT or session auth
function requireAdminAuth(req: Request, res: Response, next: Function): void {
  const expectedKey = process.env.ANALYTICS_ADMIN_KEY || process.env.ADMIN_API_KEY || "";
  if (!expectedKey) {
    res.status(503).json({ error: "Analytics not configured: ANALYTICS_ADMIN_KEY not set" });
    return;
  }

  const apiKey = req.get("X-Admin-Key");
  if (!apiKey || apiKey !== expectedKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

// ─── Owner cookie (set before auth middleware) ─────────────────
// Visit /admin/analytics/mark-owner?key=ADMIN_KEY to tag your browser.
// All subsequent page views and searches will be marked as owner traffic.
router.get("/mark-owner", (req: Request, res: Response) => {
  const expectedKey = process.env.ANALYTICS_ADMIN_KEY || process.env.ADMIN_API_KEY || "";
  const key = req.query.key as string;
  if (!expectedKey || key !== expectedKey) {
    res.status(401).json({ error: "Ugyldig nøkkel" });
    return;
  }

  const remove = req.query.remove === "1";
  if (remove) {
    res.setHeader("Set-Cookie", "_rfb_owner=0; Path=/; Max-Age=0; SameSite=Lax");
    res.json({ success: true, message: "Eier-cookie fjernet. Trafikken din telles som vanlig nå." });
  } else {
    // Cookie lasts 1 year
    res.setHeader("Set-Cookie", "_rfb_owner=1; Path=/; Max-Age=31536000; SameSite=Lax");
    res.json({ success: true, message: "Eier-cookie satt. All din trafikk merkes nå som 'eier' i analytics." });
  }
});

// Apply auth to all analytics routes
router.use(requireAdminAuth);

/**
 * POST /admin/analytics/tag-owner
 * Retroactively tag historical traffic as owner based on known fingerprints.
 * Body: { userAgentHashes: string[], ipHashes: string[], dryRun?: boolean }
 */
router.post("/tag-owner", (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { userAgentHashes = [], ipHashes = [], dryRun = false } = req.body;

    if (userAgentHashes.length === 0 && ipHashes.length === 0) {
      res.status(400).json({ error: "Oppgi userAgentHashes og/eller ipHashes" });
      return;
    }

    const results: Record<string, number> = {};

    // Tag page views by user_agent_hash
    if (userAgentHashes.length > 0) {
      const placeholders = userAgentHashes.map(() => "?").join(",");

      if (dryRun) {
        const count = db.prepare(
          `SELECT COUNT(*) as count FROM analytics_page_views WHERE user_agent_hash IN (${placeholders}) AND (is_owner IS NULL OR is_owner = 0)`
        ).get(...userAgentHashes) as any;
        results.pageViewsByUAHash = count.count;
      } else {
        const r = db.prepare(
          `UPDATE analytics_page_views SET is_owner = 1 WHERE user_agent_hash IN (${placeholders}) AND (is_owner IS NULL OR is_owner = 0)`
        ).run(...userAgentHashes);
        results.pageViewsByUAHash = r.changes;
      }
    }

    // Tag page views by session IP (session_id starts with ip_hash:)
    if (ipHashes.length > 0) {
      let pvByIp = 0;
      for (const ip of ipHashes) {
        if (dryRun) {
          const count = db.prepare(
            `SELECT COUNT(*) as count FROM analytics_page_views WHERE session_id LIKE ? AND (is_owner IS NULL OR is_owner = 0)`
          ).get(ip + ":%") as any;
          pvByIp += count.count;
        } else {
          const r = db.prepare(
            `UPDATE analytics_page_views SET is_owner = 1 WHERE session_id LIKE ? AND (is_owner IS NULL OR is_owner = 0)`
          ).run(ip + ":%");
          pvByIp += r.changes;
        }
      }
      results.pageViewsByIP = pvByIp;

      // Tag queries by client_ip_hash
      const qPlaceholders = ipHashes.map(() => "?").join(",");
      if (dryRun) {
        const count = db.prepare(
          `SELECT COUNT(*) as count FROM analytics_queries WHERE client_ip_hash IN (${qPlaceholders}) AND (is_owner IS NULL OR is_owner = 0)`
        ).get(...ipHashes) as any;
        results.queriesByIP = count.count;
      } else {
        const r = db.prepare(
          `UPDATE analytics_queries SET is_owner = 1 WHERE client_ip_hash IN (${qPlaceholders}) AND (is_owner IS NULL OR is_owner = 0)`
        ).run(...ipHashes);
        results.queriesByIP = r.changes;
      }
    }

    res.json({
      success: true,
      dryRun,
      tagged: results,
      message: dryRun ? "Tørkjøring — ingen data endret" : "Historisk trafikk tagget som eier",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/analytics/summary
 * High-level analytics for the last 24 hours
 */
router.get("/summary", (req: Request, res: Response) => {
  const vertical = parseVertical(req);
  const summary = analyticsService.getSummary(24, vertical);
  res.json({
    timeframe: "last 24 hours",
    vertical: vertical || "all",
    timestamp: new Date().toISOString(),
    ...summary,
  });
});

/**
 * GET /admin/analytics/summary/:hours
 * High-level analytics for the last N hours
 */
router.get("/summary/:hours", (req: Request, res: Response) => {
  const hoursParam = req.params.hours as string;
  const hours = Math.max(1, Math.min(87600, parseInt(hoursParam) || 24));
  const vertical = parseVertical(req);
  const summary = analyticsService.getSummary(hours, vertical);
  res.json({
    timeframe: `last ${hours} hours`,
    vertical: vertical || "all",
    timestamp: new Date().toISOString(),
    ...summary,
  });
});

/**
 * GET /admin/analytics/producers
 * Top producers by view count
 * Query params:
 *   limit=20 (default)
 *   hours=24 (default)
 */
router.get("/producers", (req: Request, res: Response) => {
  const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
  const hours = Math.max(1, Math.min(87600, parseInt(req.query.hours as string) || 24));

  const producers = analyticsService.getTopProducers(limit, hours, parseVertical(req));
  res.json({
    timeframe: `last ${hours} hours`,
    count: producers.length,
    limit,
    timestamp: new Date().toISOString(),
    producers,
  });
});

/**
 * GET /admin/analytics/cities
 * City-level analytics
 * Query params:
 *   hours=24 (default)
 */
router.get("/cities", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(87600, parseInt(req.query.hours as string) || 24));

  const cities = analyticsService.getCityStats(hours, parseVertical(req));
  res.json({
    timeframe: `last ${hours} hours`,
    count: cities.length,
    timestamp: new Date().toISOString(),
    cities,
  });
});

/**
 * GET /admin/analytics/export/:table
 * Export raw analytics data
 * Params:
 *   table = "page_views" | "queries" | "agent_views"
 * Query params:
 *   limit=1000 (default)
 *   offset=0 (default)
 */
router.get("/export/:table", (req: Request, res: Response) => {
  const table = req.params.table as "page_views" | "queries" | "agent_views";

  if (!["page_views", "queries", "agent_views"].includes(table)) {
    res.status(400).json({ error: "Invalid table. Must be one of: page_views, queries, agent_views" });
    return;
  }

  const limit = Math.min(10000, parseInt(req.query.limit as string) || 1000);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

  // On an isolation-locked host, scope the raw export to that vertical too so
  // a per-site dashboard can never dump another vertical's rows.
  const result = analyticsService.exportData(table, limit, offset, lockedVerticalForHost(req));
  res.json({
    table,
    timestamp: new Date().toISOString(),
    ...result,
  });
});

/**
 * POST /admin/analytics/prune
 * Delete analytics data older than specified days
 * Body:
 *   {
 *     "olderThanDays": 90
 *   }
 */
router.post("/prune", (req: Request, res: Response) => {
  const olderThanDays = req.body.olderThanDays || 90;

  if (olderThanDays < 7) {
    res.status(400).json({ error: "Cannot prune data newer than 7 days (privacy/audit trail)" });
    return;
  }

  const pruned = analyticsService.pruneOldData(olderThanDays);
  res.json({
    success: true,
    message: `Pruned ${pruned} old analytics records`,
    olderThanDays,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /admin/analytics/health
 * Simple health check for analytics system
 */
router.get("/health", (_req: Request, res: Response) => {
  try {
    // Try to get a summary — if it succeeds, the DB is working
    const summary = analyticsService.getSummary(1);
    res.json({
      status: "healthy",
      analytics_tables: ["analytics_page_views", "analytics_queries", "analytics_agent_views"],
      records_24h: summary.pageViews + summary.totalQueries,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: String(err),
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /admin/analytics/visitors
 * Detailed visitor list with session info
 */
router.get("/visitors", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(87600, parseInt(req.query.hours as string) || 24));
  const limit = Math.min(200, parseInt(req.query.limit as string) || 50);

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    const visitors = db.prepare(`
      SELECT
        session_id as ipHash,
        COUNT(*) as pageViews,
        COUNT(DISTINCT path) as uniquePages,
        MIN(created_at) as firstSeen,
        MAX(created_at) as lastSeen,
        source,
        CASE
          WHEN session_id LIKE '%mobile%' OR session_id LIKE '%iphone%' THEN 'mobile'
          WHEN session_id LIKE '%tablet%' OR session_id LIKE '%ipad%' THEN 'tablet'
          ELSE 'desktop'
        END as device
      FROM analytics_page_views
      WHERE created_at > ? AND ${NOT_OWNER}${verticalFilter(req).sql}
      GROUP BY session_id
      ORDER BY pageViews DESC
      LIMIT ?
    `).all(cutoff, ...verticalFilter(req).params, limit) as any[];

    res.json({ visitors });
  } catch (err) {
    console.error("[analytics] visitors error:", err);
    res.json({ visitors: [] });
  }
});

/**
 * GET /admin/analytics/hourly
 * Hourly traffic breakdown for chart
 */
router.get("/hourly", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(168, parseInt(req.query.hours as string) || 24));

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    const hourly = db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00', created_at) as hour,
        COUNT(*) as views,
        COUNT(DISTINCT session_id) as visitors
      FROM analytics_page_views
      WHERE created_at > ? AND ${NOT_OWNER}${verticalFilter(req).sql}
      GROUP BY hour
      ORDER BY hour ASC
    `).all(cutoff, ...verticalFilter(req).params) as any[];

    res.json({ hourly });
  } catch (err) {
    console.error("[analytics] hourly error:", err);
    res.json({ hourly: [] });
  }
});

/**
 * GET /admin/analytics/pages
 * Top pages by view count
 */
router.get("/pages", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(87600, parseInt(req.query.hours as string) || 24));
  const limit = Math.min(100, parseInt(req.query.limit as string) || 20);

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    // Exclude automated vulnerability-scanner paths. These paths are hit by
    // bots looking for vulnerable WordPress/PHP installs and aren't signal for
    // what real users or AI agents are reading. They were previously polluting
    // the top-20 (103 views on /wordpress/wp-admin/setup-config.php, etc).
    const SCANNER_PATTERNS = [
      "%wp-admin%", "%wp-login%", "%wp-includes%", "%wordpress%",
      "%wlwmanifest%", "%xmlrpc%", "%/.env%", "%/.git%",
      "%phpunit%", "%phpinfo%", "%setup-config%",
    ];
    const scannerExclusion = SCANNER_PATTERNS.map(() => "path NOT LIKE ?").join(" AND ");

    const pages = db.prepare(`
      SELECT
        path,
        COUNT(*) as views,
        COUNT(DISTINCT session_id) as visitors
      FROM analytics_page_views
      WHERE created_at > ? AND ${NOT_OWNER}${verticalFilter(req).sql}
        AND (${scannerExclusion})
      GROUP BY path
      ORDER BY views DESC
      LIMIT ?
    `).all(cutoff, ...verticalFilter(req).params, ...SCANNER_PATTERNS, limit) as any[];

    res.json({ pages });
  } catch (err) {
    console.error("[analytics] pages error:", err);
    res.json({ pages: [] });
  }
});

/**
 * GET /admin/analytics/devices
 * Device type breakdown
 */
router.get("/devices", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(87600, parseInt(req.query.hours as string) || 24));

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    // Proper device breakdown from the User-Agent embedded in session_id
    // (format: "ipHash:userAgent"). Previously this endpoint grouped by the
    // `source` column (direct/search/social/referral), which is *referrer*,
    // not device — meaning Trafikkilder and Enheter showed identical data.
    //
    // Filter out bots/scanners so the Enheter widget reflects human visitors
    // only. Bot traffic has its own widget (Bot-fordeling).
    const rows = db.prepare(`
      SELECT session_id, COUNT(*) as count
      FROM analytics_page_views
      WHERE created_at > ? AND ${NOT_OWNER}
        AND session_id NOT LIKE '%Bot%'
        AND session_id NOT LIKE '%bot%'
        AND session_id NOT LIKE '%spider%'
        AND session_id NOT LIKE '%crawl%'
        AND session_id NOT LIKE '%curl/%'
        AND session_id NOT LIKE '%Python/%'
        AND session_id NOT LIKE '%aiohttp%'
        AND session_id NOT LIKE '%Lokal/%'
        AND session_id NOT LIKE '%node-fetch%'
        AND session_id NOT LIKE '%axios/%'${verticalFilter(req).sql}
      GROUP BY session_id
    `).all(cutoff, ...verticalFilter(req).params) as any[];

    const buckets: Record<string, { count: number; visitors: number }> = {
      desktop: { count: 0, visitors: 0 },
      mobile: { count: 0, visitors: 0 },
      tablet: { count: 0, visitors: 0 },
      unknown: { count: 0, visitors: 0 },
    };

    for (const r of rows) {
      const ua = r.session_id.includes(':') ? r.session_id.split(':').slice(1).join(':') : '';
      const lower = ua.toLowerCase();
      let device: 'desktop' | 'mobile' | 'tablet' | 'unknown';
      // Order matters — tablet check first because iPads include "Mobile" too.
      if (lower.includes('ipad') || lower.includes('tablet')) {
        device = 'tablet';
      } else if (lower.includes('mobile') || lower.includes('iphone') || lower.includes('android')) {
        device = 'mobile';
      } else if (lower.includes('mozilla') || lower.includes('chrome') || lower.includes('safari') || lower.includes('firefox') || lower.includes('edg/')) {
        device = 'desktop';
      } else {
        device = 'unknown';
      }
      buckets[device].count += r.count;
      buckets[device].visitors += 1;
    }

    const devices = Object.entries(buckets)
      .map(([device, v]) => ({ device, count: v.count, visitors: v.visitors }))
      .filter(d => d.count > 0)
      .sort((a, b) => b.count - a.count);

    res.json({ devices });
  } catch (err) {
    console.error("[analytics] devices error:", err);
    res.json({ devices: [] });
  }
});

/**
 * GET /admin/analytics/conversations
 * Samtaler (business-level agent-to-agent conversations) totals and per-source.
 * Separate signal from HTTP page-views; see conversation-service.
 */
router.get("/conversations", (_req: Request, res: Response) => {
  try {
    // Lazy import to avoid circular init at module load.
    const { conversationService } = require("../services/conversation-service");
    const sourceStats = conversationService.getSourceStats() as Array<{ source: string; count: number; lastActivity: string }>;
    const total = sourceStats.reduce((s, r) => s + r.count, 0);
    const bySource: Record<string, number> = { mcp: 0, a2a: 0, web: 0, api: 0 };
    for (const r of sourceStats) {
      bySource[r.source] = r.count;
    }
    res.json({
      timestamp: new Date().toISOString(),
      total,
      bySource,
      sourceStats,
    });
  } catch (err) {
    console.error("[analytics] conversations error:", err);
    res.json({ total: 0, bySource: {}, sourceStats: [] });
  }
});

/**
 * GET /admin/analytics/traffic-classification
 * Classifies visitors into: human, bot, dev, scanner
 * This is the key endpoint for understanding real vs artificial traffic
 */
router.get("/traffic-classification", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(87600, parseInt(req.query.hours as string) || 24));

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    const visitors = db.prepare(`
      SELECT
        session_id,
        COUNT(*) as views,
        COUNT(DISTINCT path) as unique_pages,
        MIN(created_at) as first_seen,
        MAX(created_at) as last_seen
      FROM analytics_page_views
      WHERE created_at > ? AND ${NOT_OWNER}${verticalFilter(req).sql}
      GROUP BY session_id
    `).all(cutoff, ...verticalFilter(req).params) as any[];

    // Classification patterns
    // Bot detection: UA contains "bot"/"spider"/"crawl" as whole-ish word (not
    // substring of something like "bot_name_lookalike"), OR a known named bot
    // that doesn't itself contain "bot" (e.g. Bytespider, facebookexternalhit).
    // The whole-word rule avoids false positives where a browser UA happens to
    // include "robot" or similar incidentally.
    const botPatterns = ['bot', 'Bot', 'spider', 'crawl', 'serpstat', 'GPTBot', 'ClaudeBot', 'Chiark', 'Go-http-client', 'Dataprovider', 'NotHumanSearch', 'DuckDuck', 'Googlebot', 'GoogleOther', 'Bytespider', 'Applebot', 'YandexBot', 'BingPreview', 'facebookexternal', 'Twitterbot', 'Amazonbot', 'meta-external', 'PetalBot', 'SemrushBot', 'AhrefsBot', 'DotBot', 'BLEXBot', 'MojeekBot', 'SeekportBot', 'CCBot', 'anthropic-ai', 'cohere-ai', 'ImagesiftBot', 'Diffbot', 'LinkedInBot', 'Slackbot', 'WhatsApp', 'TelegramBot'];
    const devPatterns = ['curl/', 'Python/', 'aiohttp', 'Lokal/', 'Lokal-Enricher', 'Claude-User', 'Python-urllib', 'node-fetch', 'axios/'];
    const scannerPatterns = ['Chrome/78.0', 'Chrome/89.0', 'Chrome/95.0', 'Chrome/58.0', 'Chrome/102.0'];
    const scannerPaths = ['wp-admin', 'wp-login', 'xmlrpc', 'wlwmanifest', '.env', '.git', 'wp-includes'];

    // Dynamic bot-name extractor. Tries (in order):
    //   1. Exact token ending in Bot/Crawler/Spider/bot (case-insensitive) —
    //      catches AhrefsBot, SemrushBot, PetalBot, etc. without us having
    //      to hardcode every crawler in existence.
    //   2. First identifier before a "/" (UA convention "Name/version ...") —
    //      catches "facebookexternalhit/1.1" → "facebookexternalhit",
    //      "meta-externalagent/1.1" → "meta-externalagent".
    //   3. First alphanumeric token — last-resort bucket ("UA looks weird").
    // Returns { name, otherSample } where otherSample is the raw UA (truncated)
    // for UAs that fell through to #3, so Daniel can see what's hiding in "other".
    function extractBotName(ua: string): string {
      // 1. Known-good substring match first (preserves existing labels)
      const known = ua.match(/(ClaudeBot|GPTBot|MJ12bot|serpstatbot|Googlebot|GoogleOther|DuckDuckBot|Applebot|Chiark|Dataprovider|NotHumanSearch|BingPreview|facebookexternalhit|facebookexternal|Twitterbot|YandexBot|Bytespider|Amazonbot|PetalBot|SemrushBot|AhrefsBot|DotBot|BLEXBot|MojeekBot|SeekportBot|CCBot|meta-externalagent|anthropic-ai|LinkedInBot|Slackbot|TelegramBot|ImagesiftBot|Diffbot)/i);
      if (known) return known[1];
      // 2. Generic "*Bot/*Crawler/*Spider" token (e.g. "HostBot", "MyCrawler")
      const generic = ua.match(/([A-Za-z][A-Za-z0-9_-]*(?:Bot|Crawler|Spider|bot|crawler|spider))/);
      if (generic) return generic[1];
      // 3. First "Name/version" tuple (e.g. "Go-http-client/1.1")
      const slash = ua.match(/^([A-Za-z][A-Za-z0-9_.-]+)\//);
      if (slash) return slash[1];
      // 4. Fallback: first word-like token
      const word = ua.match(/([A-Za-z][A-Za-z0-9_-]{2,})/);
      return word ? word[1] : 'other';
    }

    // Also get scanner paths
    const scannerHits = db.prepare(`
      SELECT session_id FROM analytics_page_views
      WHERE created_at > ? AND ${NOT_OWNER}${verticalFilter(req).sql} AND (${scannerPaths.map(() => 'path LIKE ?').join(' OR ')})
      GROUP BY session_id
    `).all(cutoff, ...verticalFilter(req).params, ...scannerPaths.map(p => `%${p}%`)) as any[];
    const scannerSessionIds = new Set(scannerHits.map((r: any) => r.session_id));

    const classification = { human: { views: 0, sessions: 0 }, bot: { views: 0, sessions: 0 }, dev: { views: 0, sessions: 0 }, scanner: { views: 0, sessions: 0 } };
    const botDetails: Record<string, { name: string; views: number; sampleUa?: string }> = {};
    const humanSessions: any[] = [];
    // Sample raw UAs that fell into "other" so the dashboard can show them.
    // We keep at most one sample per unique UA prefix to stay under ~30 samples.
    const otherSamples: Array<{ ua: string; views: number }> = [];

    for (const v of visitors) {
      const ua = v.session_id.includes(':') ? v.session_id.split(':').slice(1).join(':') : '';
      const isBot = botPatterns.some(p => ua.includes(p));
      const isDev = devPatterns.some(p => ua.includes(p));
      const isScanner = scannerPatterns.some(p => ua.includes(p)) || scannerSessionIds.has(v.session_id);

      let type: string;
      if (isBot) {
        type = 'bot';
        const botName = extractBotName(ua);
        if (!botDetails[botName]) botDetails[botName] = { name: botName, views: 0, sampleUa: ua.slice(0, 120) };
        botDetails[botName].views += v.views;
        // If we fell back to the last-resort token, preserve the raw UA so we
        // can surface it in the dashboard's "other" drill-down.
        if (botName === 'other' || /^(Mozilla|compatible)$/i.test(botName)) {
          otherSamples.push({ ua: ua.slice(0, 160), views: v.views });
        }
      } else if (isDev) {
        type = 'dev';
      } else if (isScanner) {
        type = 'scanner';
      } else {
        type = 'human';
        humanSessions.push({
          ua: ua.substring(0, 80),
          views: v.views,
          uniquePages: v.unique_pages,
          firstSeen: v.first_seen,
          lastSeen: v.last_seen,
        });
      }

      (classification as any)[type].views += v.views;
      (classification as any)[type].sessions += 1;
    }

    // Sort human sessions by views
    humanSessions.sort((a, b) => b.views - a.views);

    // Bot breakdown sorted by views
    const bots = Object.values(botDetails).sort((a, b) => b.views - a.views);

    // Dedupe "other" UA samples by first 40 chars, keep top 20 by views.
    const sampleMap = new Map<string, { ua: string; views: number }>();
    for (const s of otherSamples) {
      const key = s.ua.slice(0, 40);
      const existing = sampleMap.get(key);
      if (existing) existing.views += s.views;
      else sampleMap.set(key, { ua: s.ua, views: s.views });
    }
    const otherUaSamples = [...sampleMap.values()]
      .sort((a, b) => b.views - a.views)
      .slice(0, 20);

    res.json({
      timeframe: `last ${hours} hours`,
      timestamp: new Date().toISOString(),
      totalViews: visitors.reduce((s, v) => s + v.views, 0),
      totalSessions: visitors.length,
      classification,
      bots,
      // Raw UA samples for the "other"/long-tail bucket, so the dashboard can
      // expose "who is hiding here" instead of an opaque number.
      otherUaSamples,
      humanSessions: humanSessions.slice(0, 30),
    });
  } catch (err) {
    console.error("[analytics] traffic-classification error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /admin/analytics/referrers
 * Shows actual referrer URLs for non-direct traffic
 */
router.get("/referrers", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(87600, parseInt(req.query.hours as string) || 24));

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    const referrers = db.prepare(`
      SELECT
        referrer,
        source,
        COUNT(*) as visits,
        COUNT(DISTINCT session_id) as unique_visitors,
        GROUP_CONCAT(DISTINCT path) as paths
      FROM analytics_page_views
      WHERE created_at > ? AND ${NOT_OWNER}${verticalFilter(req).sql} AND referrer IS NOT NULL AND referrer != ''
      GROUP BY referrer
      ORDER BY visits DESC
      LIMIT 30
    `).all(cutoff, ...verticalFilter(req).params) as any[];

    res.json({
      timeframe: `last ${hours} hours`,
      timestamp: new Date().toISOString(),
      referrers,
    });
  } catch (err) {
    console.error("[analytics] referrers error:", err);
    res.json({ referrers: [] });
  }
});

// ═══════════════════════════════════════════════════════════════
// OPS AGENT ENDPOINTS — automated remediation actions
// These are called by the rfb-ops-agent scheduled task when
// issues are detected. All require X-Admin-Key auth.
// ═══════════════════════════════════════════════════════════════

/**
 * POST /admin/analytics/ops/clear-cache
 * Clears all in-memory caches (marketplace, analytics, traffic stats).
 * Use when: memory is high, or data seems stale.
 */
router.post("/ops/clear-cache", (_req: Request, res: Response) => {
  try {
    const { marketplaceRegistry } = require("../services/marketplace-registry");
    // Invalidate marketplace cache
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;

    // Invalidate analytics summary cache
    if (analyticsService._summaryCache) {
      analyticsService._summaryCache.clear();
    }

    // Force garbage collection if available
    if (global.gc) global.gc();

    const mem = process.memoryUsage();
    res.json({
      success: true,
      action: "clear-cache",
      message: "All caches cleared",
      memoryAfter: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * POST /admin/analytics/ops/prune
 * Delete analytics data older than N days. Default: 30 days.
 * Use when: DB size is large, or analytics tables have too many rows.
 * Body: { daysToKeep?: number }
 */
router.post("/ops/prune", (req: Request, res: Response) => {
  try {
    const db = getDb();
    const daysToKeep = Math.max(7, parseInt(req.body.daysToKeep) || 30);
    const cutoff = sqliteDatetime(new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000));

    const pvBefore = (db.prepare("SELECT COUNT(*) as c FROM analytics_page_views").get() as any).c;
    const qBefore = (db.prepare("SELECT COUNT(*) as c FROM analytics_queries").get() as any).c;
    const avBefore = (db.prepare("SELECT COUNT(*) as c FROM analytics_agent_views").get() as any).c;

    db.prepare("DELETE FROM analytics_page_views WHERE created_at < ?").run(cutoff);
    db.prepare("DELETE FROM analytics_queries WHERE created_at < ?").run(cutoff);
    db.prepare("DELETE FROM analytics_agent_views WHERE created_at < ?").run(cutoff);

    const pvAfter = (db.prepare("SELECT COUNT(*) as c FROM analytics_page_views").get() as any).c;
    const qAfter = (db.prepare("SELECT COUNT(*) as c FROM analytics_queries").get() as any).c;
    const avAfter = (db.prepare("SELECT COUNT(*) as c FROM analytics_agent_views").get() as any).c;

    // Reclaim disk space
    db.pragma("wal_checkpoint(TRUNCATE)");

    res.json({
      success: true,
      action: "prune",
      daysKept: daysToKeep,
      cutoff,
      deleted: {
        pageViews: pvBefore - pvAfter,
        queries: qBefore - qAfter,
        agentViews: avBefore - avAfter,
      },
      remaining: {
        pageViews: pvAfter,
        queries: qAfter,
        agentViews: avAfter,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ─── Background maintenance jobs (tasks-prune / vacuum) ─────────────────────
// Incident (2026-07-04): a single-transaction DELETE over ~4093 `tasks` rows
// (with sizeable params/result/error BLOB columns) immediately followed by
// `wal_checkpoint(TRUNCATE)` blocked the single-threaded Node event loop for
// ~12 minutes in production, because better-sqlite3 is a SYNCHRONOUS API —
// every call blocks the JS thread for its full duration with zero yielding.
// The fix: run the delete (and VACUUM) as background jobs, chunked in small
// transactions with an explicit yield (setImmediate) between chunks so
// concurrent HTTP requests keep getting served while the job runs, and let
// callers poll GET /ops/jobs/:jobId instead of holding a request open.
//
// In-memory only — jobs don't need to survive a process restart, and a
// process-wide lock (activeJobId) ensures only one maintenance job (prune OR
// vacuum) runs at a time, since two concurrent runs of this class of job is
// what made the original incident worse.
type MaintenanceJobType = "tasks-prune" | "vacuum";
type MaintenanceJobStatus = "running" | "done" | "failed";

interface MaintenanceJob {
  jobId: string;
  type: MaintenanceJobType;
  status: MaintenanceJobStatus;
  rowsDeleted: number;
  rowsRemaining: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  // vacuum-only, populated on completion
  sizeBeforeMb?: number;
  sizeAfterMb?: number;
  freedMb?: number;
}

const jobRegistry = new Map<string, MaintenanceJob>();
let activeJobId: string | null = null;

const PRUNE_CHUNK_SIZE = 200;
// Passive checkpoint every N chunks (=N*PRUNE_CHUNK_SIZE rows) during a prune
// job. PASSIVE never blocks on concurrent readers/writers (unlike TRUNCATE),
// so it's safe to run mid-job.
const PRUNE_CHECKPOINT_EVERY_N_CHUNKS = 10;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Tables with a foreign key referencing tasks(id) that do NOT have
 * ON DELETE CASCADE, so their rows for a chunk's task IDs must be deleted
 * BEFORE that chunk's `tasks` rows — otherwise the parent DELETE fails with
 * a SQLite "FOREIGN KEY constraint failed" error (prod incident 2026-07-07:
 * jobId e0cd7421, 4300 eligible rows, failed immediately with rowsDeleted:
 * 0). Verified against src/database/init.ts (grepped every CREATE TABLE
 * block for `REFERENCES tasks` / a plausible `task_id` column) — as of this
 * fix the ONLY such table is `conversations` (column `task_id`).
 * `messages.conversation_id` already has `ON DELETE CASCADE` onto
 * conversations(id), so deleting a conversation row here cascades its
 * messages automatically — no separate messages delete is needed.
 *
 * If a future migration adds another table with a FK to tasks(id), add its
 * scoped delete here too (see dev-request
 * 2026-07-07-tasks-prune-fk-cascade-fix.md for the re-audit method).
 */
function deleteChunkChildRows(db: ReturnType<typeof getDb>, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM conversations WHERE task_id IN (${placeholders})`).run(...ids);
}

/**
 * Chunked background delete for /ops/tasks-prune {dryRun:false}.
 * Deletes at most PRUNE_CHUNK_SIZE rows per transaction, yielding to the
 * event loop between chunks. Idempotent/resumable: the WHERE filter
 * (status IN (...) AND created_at < cutoff) naturally skips already-deleted
 * rows, so re-running (or a job that dies mid-way) is always safe — no
 * separate resume-state is needed beyond the activeJobId lock.
 *
 * Delete order within each chunk (2026-07-07 FK fix): child rows in tables
 * that reference tasks(id) — see deleteChunkChildRows above — are deleted
 * FIRST, scoped to that exact chunk's task IDs, then the chunk's `tasks`
 * rows are deleted, all inside the same per-chunk transaction. Selecting the
 * chunk's IDs up front (instead of the old rowid-scoped correlated
 * sub-DELETE) is what makes scoping the child-table deletes to "just this
 * chunk" possible.
 */
async function runTasksPruneJob(jobId: string, cutoff: string): Promise<void> {
  const job = jobRegistry.get(jobId);
  if (!job) return;
  try {
    const db = getDb();
    const selectChunkIds = db.prepare(
      "SELECT id FROM tasks WHERE status IN ('completed','failed','canceled') AND created_at < ? LIMIT ?"
    );
    const deleteTasksByIds = (ids: readonly string[]) => {
      const placeholders = ids.map(() => "?").join(",");
      return db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids).changes;
    };
    // One transaction per chunk: child rows first, then the parent tasks
    // rows, so a chunk either fully deletes (parent + children) or fully
    // rolls back — never leaves an FK-violating half-state.
    const deleteChunkTxn = db.transaction((ids: readonly string[]) => {
      deleteChunkChildRows(db, ids);
      return deleteTasksByIds(ids);
    });

    let chunkCount = 0;
    for (;;) {
      const ids = (selectChunkIds.all(cutoff, PRUNE_CHUNK_SIZE) as Array<{ id: string }>).map((r) => r.id);
      if (ids.length === 0) break; // nothing left eligible

      const changes = deleteChunkTxn(ids);
      chunkCount++;
      job.rowsDeleted += changes;
      job.rowsRemaining = Math.max(0, job.rowsRemaining - changes);

      if (chunkCount % PRUNE_CHECKPOINT_EVERY_N_CHUNKS === 0) {
        // PASSIVE only — never TRUNCATE while the job is actively deleting.
        db.pragma("wal_checkpoint(PASSIVE)");
      }

      // Yield control back to the event loop so queued HTTP requests get a
      // turn before we start the next chunk's transaction.
      await yieldToEventLoop();
    }

    // Final passive checkpoint now that deletes are done. TRUNCATE is
    // reserved for the dedicated vacuum job — running it here (as the old
    // synchronous code did right after the delete) is exactly the pattern
    // that stalled prod, since TRUNCATE requires no concurrent readers or
    // writers holding the WAL.
    db.pragma("wal_checkpoint(PASSIVE)");

    job.status = "done";
    job.finishedAt = new Date().toISOString();
  } catch (err) {
    job.status = "failed";
    job.error = String(err);
    job.finishedAt = new Date().toISOString();
  } finally {
    if (activeJobId === jobId) activeJobId = null;
  }
}

/**
 * Background job wrapper for /ops/vacuum. Responds 202 immediately; the
 * actual work (checkpoint + VACUUM) runs here.
 *
 * IMPORTANT: db.exec("VACUUM") itself is a single, synchronous,
 * un-chunkable better-sqlite3 call — SQLite rewrites the entire database
 * file in one pass and there is no API to break that into yieldable steps.
 * This job therefore STILL briefly blocks the Node event loop for VACUUM's
 * duration (proportional to DB size) — that is a SQLite/better-sqlite3
 * constraint, not something this chunking can fix. What this DOES fix: the
 * HTTP response is no longer held open for that duration (caller gets 202 +
 * jobId immediately and can poll GET /ops/jobs/:jobId instead of blocking a
 * TCP connection), and the initial wal_checkpoint(PASSIVE) + yield below
 * moves as much work as possible out of the blocking section. Schedule
 * vacuum runs off-peak regardless.
 */
async function runVacuumJob(jobId: string): Promise<void> {
  const job = jobRegistry.get(jobId);
  if (!job) return;
  try {
    const db = getDb();
    const fs = require("fs");
    const dbPath = process.env.DB_PATH || "./data/lokal.db";

    let sizeBefore = 0;
    try { sizeBefore = fs.statSync(dbPath).size; } catch {}

    // Passive checkpoint first — never blocks on concurrent readers/writers.
    db.pragma("wal_checkpoint(PASSIVE)");
    await yieldToEventLoop();

    // Terminal step — unavoidably blocking, see doc comment above.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");

    let sizeAfter = 0;
    try { sizeAfter = fs.statSync(dbPath).size; } catch {}

    job.sizeBeforeMb = Number((sizeBefore / 1024 / 1024).toFixed(1));
    job.sizeAfterMb = Number((sizeAfter / 1024 / 1024).toFixed(1));
    job.freedMb = Number(((sizeBefore - sizeAfter) / 1024 / 1024).toFixed(1));
    job.status = "done";
    job.finishedAt = new Date().toISOString();
  } catch (err) {
    job.status = "failed";
    job.error = String(err);
    job.finishedAt = new Date().toISOString();
  } finally {
    if (activeJobId === jobId) activeJobId = null;
  }
}

/**
 * GET /admin/analytics/ops/jobs/:jobId
 * Poll status/progress of a background maintenance job (tasks-prune or
 * vacuum) started via the endpoints below.
 */
router.get("/ops/jobs/:jobId", (req: Request, res: Response) => {
  const job = jobRegistry.get(String(req.params.jobId));
  if (!job) {
    res.status(404).json({ success: false, error: "job_not_found" });
    return;
  }
  res.json({ success: true, ...job });
});

/**
 * POST /admin/analytics/ops/vacuum
 * Run SQLite VACUUM to reclaim disk space and defragment.
 * Use when: DB size seems large relative to row counts (fragmentation).
 * WARNING: VACUUM itself still briefly locks/blocks the process (see the
 * doc comment on runVacuumJob above) — this endpoint no longer holds the
 * HTTP response open for it, but you should still schedule runs off-peak.
 *
 * Responds 202 {jobId} immediately; poll GET /ops/jobs/:jobId for status.
 * Only one maintenance job (this or tasks-prune) may run at a time — a
 * second POST while one is active gets 409 {error:"job_in_progress"}.
 */
router.post("/ops/vacuum", (_req: Request, res: Response) => {
  try {
    if (activeJobId) {
      const active = jobRegistry.get(activeJobId);
      res.status(409).json({ success: false, error: "job_in_progress", activeJobId, activeJobType: active?.type });
      return;
    }

    const jobId = randomUUID();
    const job: MaintenanceJob = {
      jobId,
      type: "vacuum",
      status: "running",
      rowsDeleted: 0,
      rowsRemaining: 0,
      startedAt: new Date().toISOString(),
    };
    jobRegistry.set(jobId, job);
    activeJobId = jobId;

    // Fire-and-forget: the job updates its own registry entry as it runs.
    runVacuumJob(jobId).catch((err) => {
      const j = jobRegistry.get(jobId);
      if (j) {
        j.status = "failed";
        j.error = String(err);
        j.finishedAt = new Date().toISOString();
      }
      if (activeJobId === jobId) activeJobId = null;
    });

    res.status(202).json({ success: true, jobId, action: "vacuum" });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * POST /admin/analytics/ops/tasks-prune
 * Delete terminal A2A tasks (completed/failed/canceled) older than N days.
 * Tasks in-flight (submitted/working/input-required) are never touched.
 * Body: { dryRun?: boolean (default true), daysToKeep?: number (default 30) }
 *
 * dryRun:true (default) — UNCHANGED: synchronous, fast, read-only, same
 * response shape as before (PR #137).
 *
 * dryRun:false — runs as a background job (see runTasksPruneJob above):
 * responds 202 {jobId} immediately instead of blocking until the delete
 * finishes. Poll GET /ops/jobs/:jobId for progress. Only one maintenance
 * job (this or vacuum) may run at a time — a second POST while one is
 * active gets 409 {error:"job_in_progress"}.
 */
router.post("/ops/tasks-prune", (req: Request, res: Response) => {
  try {
    const db = getDb();
    const dryRun = req.body.dryRun !== false; // default true — safe by default
    const daysToKeep = Math.max(7, parseInt(req.body.daysToKeep) || 30);
    const cutoff = sqliteDatetime(new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000));

    if (dryRun) {
      const eligible = db.prepare(
        "SELECT COUNT(*) as c, SUM(LENGTH(COALESCE(params,'')) + LENGTH(COALESCE(result,'')) + LENGTH(COALESCE(error,''))) as bytes " +
        "FROM tasks WHERE status IN ('completed','failed','canceled') AND created_at < ?"
      ).get(cutoff) as any;
      const totalRows = (db.prepare("SELECT COUNT(*) as c FROM tasks").get() as any).c;
      return res.json({
        success: true,
        action: "tasks-prune-dry-run",
        daysToKeep,
        cutoff,
        eligibleRows: eligible.c ?? 0,
        eligibleMb: Number(((eligible.bytes ?? 0) / 1024 / 1024).toFixed(1)),
        totalRows,
        note: "Pass dryRun:false to execute the delete.",
      });
    }

    if (activeJobId) {
      const active = jobRegistry.get(activeJobId);
      res.status(409).json({ success: false, error: "job_in_progress", activeJobId, activeJobType: active?.type });
      return;
    }

    const eligible = (db.prepare(
      "SELECT COUNT(*) as c FROM tasks WHERE status IN ('completed','failed','canceled') AND created_at < ?"
    ).get(cutoff) as any).c ?? 0;

    const jobId = randomUUID();
    const job: MaintenanceJob = {
      jobId,
      type: "tasks-prune",
      status: "running",
      rowsDeleted: 0,
      rowsRemaining: eligible,
      startedAt: new Date().toISOString(),
    };
    jobRegistry.set(jobId, job);
    activeJobId = jobId;

    // Fire-and-forget: the job updates its own registry entry as it runs.
    runTasksPruneJob(jobId, cutoff).catch((err) => {
      const j = jobRegistry.get(jobId);
      if (j) {
        j.status = "failed";
        j.error = String(err);
        j.finishedAt = new Date().toISOString();
      }
      if (activeJobId === jobId) activeJobId = null;
    });

    res.status(202).json({ success: true, jobId, action: "tasks-prune", daysToKeep, cutoff, eligibleRows: eligible });
    return;
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
    return;
  }
});

/**
 * GET /admin/analytics/ops/diagnostics
 * Comprehensive system diagnostics for the ops agent.
 * Returns everything needed to make remediation decisions.
 */
router.get("/ops/diagnostics", (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const fs = require("fs");
    const dbPath = process.env.DB_PATH || "./data/lokal.db";

    const mem = process.memoryUsage();

    // Table row counts
    const pvCount = (db.prepare("SELECT COUNT(*) as c FROM analytics_page_views").get() as any).c;
    const qCount = (db.prepare("SELECT COUNT(*) as c FROM analytics_queries").get() as any).c;
    const avCount = (db.prepare("SELECT COUNT(*) as c FROM analytics_agent_views").get() as any).c;
    const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE is_active = 1").get() as any).c;

    // Oldest analytics record
    const oldestPv = (db.prepare("SELECT MIN(created_at) as d FROM analytics_page_views").get() as any)?.d;
    const oldestQ = (db.prepare("SELECT MIN(created_at) as d FROM analytics_queries").get() as any)?.d;

    // DB file size
    let dbSizeMb = 0;
    try { dbSizeMb = Math.round(fs.statSync(dbPath).size / 1024 / 1024 * 10) / 10; } catch {}

    // Recent error rate (requests in last hour with high latency or errors)
    const oneHourAgo = sqliteDatetime(new Date(Date.now() - 3600000));
    const recentPv = (db.prepare("SELECT COUNT(*) as c FROM analytics_page_views WHERE created_at > ?").get(oneHourAgo) as any).c;

    // Bot ratio last hour
    const sessions = db.prepare(`
      SELECT session_id, COUNT(*) as views
      FROM analytics_page_views
      WHERE created_at > ? AND ${NOT_OWNER}
      GROUP BY session_id
    `).all(oneHourAgo) as any[];

    const botPatterns = ['bot', 'Bot', 'spider', 'crawl', 'GPTBot', 'ClaudeBot', 'Googlebot', 'Bytespider', 'Applebot', 'YandexBot', 'BingPreview', 'Go-http-client', 'Python/', 'curl/'];
    let botViews = 0;
    let humanViews = 0;
    for (const s of sessions) {
      const ua = s.session_id.includes(':') ? s.session_id.split(':').slice(1).join(':') : '';
      if (botPatterns.some(p => ua.includes(p))) {
        botViews += s.views;
      } else {
        humanViews += s.views;
      }
    }

    res.json({
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        pct: Math.round(mem.rss / 1024 / 1024 / 512 * 100),
      },
      database: {
        sizeMb: dbSizeMb,
        tables: {
          pageViews: pvCount,
          queries: qCount,
          agentViews: avCount,
          agents: agentCount,
        },
        oldest: {
          pageView: oldestPv,
          query: oldestQ,
        },
      },
      lastHour: {
        totalViews: recentPv,
        botViews,
        humanViews,
        botRatio: recentPv > 0 ? Math.round(botViews / (botViews + humanViews) * 100) : 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /admin/analytics/producer-outcomes ─────────────────────
// Per-day breakdown of /produsent/<slug> hits by AI-bot class and
// HTTP status. Built specifically to measure whether the
// fuzzy-redirect fix (commit 78c025d) is actually catching dead
// AI traffic — i.e. fewer 404s and a growing 301 count from
// Perplexity/GPTBot/ClaudeBot.
//
// Query params:
//   days=30          — lookback window (default 30, max 90)
//
// Response shape:
//   {
//     window: { from: ISO, to: ISO, days: 30 },
//     totals: { Perplexity: { 200: N, 301: N, 404: N }, ... },
//     byDay:  [{ day: "2026-04-25", bot: "Perplexity", status: 301, hits: 7 }, ...],
//   }
router.get("/producer-outcomes", requireAdminAuth, (req: Request, res: Response) => {
  try {
    // rfb-only content (/produsent/*). Never expose on a locked secondary host.
    if (lockedVerticalForHost(req)) {
      res.json({ window: { from: null, to: null, days: 0 }, totals: {}, byDay: [] });
      return;
    }
    const db = getDb();
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || "30"), 10) || 30));

    // Bucket by UA token in session_id. session_id = `${ipHash}:${userAgent}`
    // so substring match works (see SessionManager.getOrCreate).
    const botCase = `
      CASE
        WHEN session_id LIKE '%Perplexity%' THEN 'Perplexity'
        WHEN session_id LIKE '%GPTBot%' OR session_id LIKE '%ChatGPT%' OR session_id LIKE '%OAI-SearchBot%' THEN 'OpenAI'
        WHEN session_id LIKE '%ClaudeBot%' OR session_id LIKE '%Claude-User%' OR session_id LIKE '%Anthropic%' THEN 'Anthropic'
        WHEN session_id LIKE '%Googlebot%' OR session_id LIKE '%Google-Extended%' THEN 'Google'
        WHEN session_id LIKE '%Gemini%' THEN 'Gemini'
        WHEN session_id LIKE '%Bytespider%' OR session_id LIKE '%CCBot%' OR session_id LIKE '%Applebot%' OR session_id LIKE '%YandexBot%' OR session_id LIKE '%bingbot%' THEN 'OtherBot'
        WHEN session_id LIKE '%Mozilla%' OR session_id LIKE '%Chrome%' OR session_id LIKE '%Safari%' THEN 'Human'
        ELSE 'Unknown'
      END
    `;

    const rows = db.prepare(`
      SELECT
        substr(created_at, 1, 10) AS day,
        ${botCase} AS bot,
        COALESCE(status_code, 0) AS status,
        COUNT(*) AS hits
      FROM analytics_page_views
      WHERE path LIKE '/produsent/%'
        AND created_at > datetime('now', '-' || ? || ' days')
        AND (is_owner IS NULL OR is_owner = 0)
      GROUP BY day, bot, status
      ORDER BY day DESC, bot, status
    `).all(days) as Array<{ day: string; bot: string; status: number; hits: number }>;

    // Roll up totals per bot
    const totals: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      const key = String(r.status || "unknown");
      totals[r.bot] = totals[r.bot] || {};
      totals[r.bot][key] = (totals[r.bot][key] || 0) + r.hits;
    }

    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 3600 * 1000);

    res.json({
      window: { from: from.toISOString(), to: now.toISOString(), days },
      totals,
      byDay: rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Query failed", detail: err.message });
  }
});



// ─── GET /admin/analytics/umbrella-traffic ──────────────────────
// Per-umbrella (markedsnettverk) traffic breakdown.
// For each umbrella agent (umbrella_type IS NOT NULL), returns:
//   - pageViews_via_profile: hits on the umbrella's own /produsent/<slug>
//   - pageViews_via_members: hits on member producers' /produsent/<slug>
//   - ai_bot_pageviews:      either-channel hits whose session_id matches
//                            a known AI / search-bot UA token
//   - search_referrals:      either-channel hits whose source = 'search'
//   - active_members:        count of agent_affiliations rows where
//                            status='active' for this umbrella
//
// Members are joined via agent_affiliations (status='active'). Slug
// matching uses the same rules as src/utils/slug.ts so the path lookup
// stays consistent with /produsent/<slug>.
//
// Query params:
//   since_hours=24 (default, min 1, max 87600 = 10y)
//
// Response shape — see PR-74 spec in repo notes.
router.get("/umbrella-traffic", (req: Request, res: Response) => {
  // Markedsnettverk (umbrellas) are an rfb-only concept. Never expose on a
  // locked secondary host even though the dashboard hides the panel there.
  if (lockedVerticalForHost(req)) {
    res.json({ success: true, since_hours: 0, umbrellas: [] });
    return;
  }

  // ── Param validation ────────────────────────────────────────
  // Reject malformed values explicitly (vs. silent fallback) so the
  // dashboard can't accidentally show "24h" when the user typed "abc".
  const rawHours = req.query.since_hours;
  if (rawHours !== undefined) {
    const s = String(rawHours);
    if (!/^\d+$/.test(s)) {
      res.status(400).json({ error: "Invalid since_hours — must be a positive integer" });
      return;
    }
  }
  const sinceHours = Math.max(1, Math.min(87600, parseInt(String(rawHours || "24"), 10) || 24));

  try {
    const db = getDb();

    // Slugify mirror of src/utils/slug.ts. Inline here because SQLite
    // can't call into TS — we slugify each umbrella + member name in
    // JS and then query with the resulting paths. The path column is
    // indexed (idx_analytics_page_views_path).
    const slugify = (text: string): string =>
      (text || "")
        .normalize("NFC")
        .toLowerCase()
        .replace(/æ/g, "ae")
        .replace(/ø/g, "o")
        .replace(/å/g, "a")
        .replace(/ä/g, "a")
        .replace(/ö/g, "o")
        .replace(/ü/g, "u")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

    // ── 1. List umbrellas ─────────────────────────────────────
    const umbrellas = db.prepare(`
      SELECT id, name, umbrella_type
      FROM agents
      WHERE umbrella_type IS NOT NULL
        AND (is_active IS NULL OR is_active = 1)
      ORDER BY name
    `).all() as Array<{ id: string; name: string; umbrella_type: string }>;

    if (umbrellas.length === 0) {
      res.json({ success: true, since_hours: sinceHours, umbrellas: [] });
      return;
    }

    // ── 2. For each umbrella, gather members + counts ─────────
    // We intentionally run one round-trip per umbrella. There are
    // typically <30 umbrellas across the whole platform and the
    // per-umbrella query is bounded by the size of its membership
    // list, so a single batched IN-clause would be a wash on cost
    // and significantly less readable.
    const cutoff = sqliteDatetime(new Date(Date.now() - sinceHours * 3600 * 1000));

    // AI / bot UA tokens — match the bucket used elsewhere in this
    // file (producer-outcomes) so the meaning of "AI bot view" is
    // consistent across widgets.
    const AI_TOKENS = [
      "GPTBot", "ChatGPT", "OAI-SearchBot",
      "ClaudeBot", "Claude-User", "Anthropic",
      "Googlebot", "Google-Extended", "Gemini",
      "PerplexityBot", "Perplexity-User",
      "Bytespider", "CCBot", "Applebot", "YandexBot", "bingbot",
    ];
    const aiClause = AI_TOKENS.map(() => "session_id LIKE ?").join(" OR ");
    const aiParams = AI_TOKENS.map(t => `%${t}%`);

    const memberCountStmt = db.prepare(`
      SELECT COUNT(*) as c FROM agent_affiliations
      WHERE umbrella_id = ? AND status = 'active'
    `);
    const memberNamesStmt = db.prepare(`
      SELECT a.name FROM agent_affiliations af
      JOIN agents a ON a.id = af.producer_id
      WHERE af.umbrella_id = ? AND af.status = 'active'
    `);

    type Bucket = {
      id: string;
      name: string;
      umbrella_type: string;
      active_members: number;
      pageViews_total: number;
      pageViews_via_profile: number;
      pageViews_via_members: number;
      ai_bot_pageviews: number;
      search_referrals: number;
    };

    const out: Bucket[] = [];

    for (const u of umbrellas) {
      const activeMembers = (memberCountStmt.get(u.id) as { c: number }).c;
      const memberNames = memberNamesStmt.all(u.id) as Array<{ name: string }>;

      const umbrellaPath = `/produsent/${slugify(u.name)}`;
      const memberPaths = memberNames
        .map(m => `/produsent/${slugify(m.name)}`)
        .filter(p => p !== "/produsent/"); // skip blank-name members

      // pageViews_via_profile — hits on umbrella's own /produsent/<slug>
      const profileRow = db.prepare(`
        SELECT COUNT(*) as c FROM analytics_page_views
        WHERE path = ?
          AND created_at > ?
          AND (is_owner IS NULL OR is_owner = 0)
      `).get(umbrellaPath, cutoff) as { c: number };
      const pageViews_via_profile = profileRow.c;

      // pageViews_via_members — hits on any member's /produsent/<slug>
      let pageViews_via_members = 0;
      if (memberPaths.length > 0) {
        const placeholders = memberPaths.map(() => "?").join(",");
        const memberRow = db.prepare(`
          SELECT COUNT(*) as c FROM analytics_page_views
          WHERE path IN (${placeholders})
            AND created_at > ?
            AND (is_owner IS NULL OR is_owner = 0)
        `).get(...memberPaths, cutoff) as { c: number };
        pageViews_via_members = memberRow.c;
      }

      // ai_bot_pageviews — either channel, UA matches known bot token
      const allPaths = [umbrellaPath, ...memberPaths];
      const pathPlaceholders = allPaths.map(() => "?").join(",");
      const aiRow = db.prepare(`
        SELECT COUNT(*) as c FROM analytics_page_views
        WHERE path IN (${pathPlaceholders})
          AND created_at > ?
          AND (is_owner IS NULL OR is_owner = 0)
          AND (${aiClause})
      `).get(...allPaths, cutoff, ...aiParams) as { c: number };
      const ai_bot_pageviews = aiRow.c;

      // search_referrals — either channel, source = 'search'
      const searchRow = db.prepare(`
        SELECT COUNT(*) as c FROM analytics_page_views
        WHERE path IN (${pathPlaceholders})
          AND created_at > ?
          AND (is_owner IS NULL OR is_owner = 0)
          AND source = 'search'
      `).get(...allPaths, cutoff) as { c: number };
      const search_referrals = searchRow.c;

      out.push({
        id: u.id,
        name: u.name,
        umbrella_type: u.umbrella_type,
        active_members: activeMembers,
        pageViews_total: pageViews_via_profile + pageViews_via_members,
        pageViews_via_profile,
        pageViews_via_members,
        ai_bot_pageviews,
        search_referrals,
      });
    }

    // Sorted by total pageViews descending — most-trafficked first
    out.sort((a, b) => b.pageViews_total - a.pageViews_total);

    res.json({
      success: true,
      since_hours: sinceHours,
      umbrellas: out,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Query failed", detail: err.message });
  }
});


/**
 * POST /admin/analytics/ops/retention-rollup
 * Full retention pass: roll up + prune raw page_views older than windowDays
 * into page_view_daily, prune run-ledger older than runLedgerKeepDays into
 * runs_daily_summary, optionally run VACUUM.
 * Feature-flag: RETENTION_JOB_ENABLED env var must be "true" (or dryRun=true).
 * Body: { windowDays?: number, runLedgerKeepDays?: number, vacuum?: boolean, dryRun?: boolean }
 * dryRun is also accepted as ?dryRun=true — dry-run wins on conflict (either
 * signal true ⇒ dry): a sharp run requires explicit absence of both (mirrors
 * the strict-false convention from POST /admin/experiences-dedup-unmerge, #215).
 * Manual-only: there is no scheduler wired to this endpoint (grep confirms no
 * cron/job calls it) — a periodic trigger is a separate future decision.
 */
router.post("/ops/retention-rollup", (req: Request, res: Response) => {
  // req.body is `undefined` (not `{}`) when a request has no Content-Type
  // header at all — express.json() then skips parsing entirely. The naive
  // `req.body.dryRun` below used to throw on exactly that shape of request
  // (a plain `POST` with no body), which is how the real-pass 500 was first
  // found: dev-request 2026-07-11-retention-rollup-500-rootcause.
  const body = (req.body ?? {}) as { dryRun?: unknown; windowDays?: unknown; runLedgerKeepDays?: unknown; vacuum?: unknown };
  // A repeated ?dryRun=true&dryRun=true parses as an array in Express — treat
  // any element being "true" as a dry-run signal rather than silently falling
  // through to a real run (dry-run must win on every shape of the signal).
  const queryDryRun = Array.isArray(req.query.dryRun) ? req.query.dryRun.includes("true") : req.query.dryRun === "true";
  const dryRun = body.dryRun === true || queryDryRun;
  const enabled = process.env.RETENTION_JOB_ENABLED === "true";

  if (!dryRun && !enabled) {
    res.status(503).json({
      error: "Retention job is disabled. Set RETENTION_JOB_ENABLED=true to enable, or pass dryRun:true to preview.",
    });
    return;
  }

  try {
    const { runRetentionPass } = require("../services/retention-service");
    const windowDays = Math.max(30, Math.min(365, parseInt(body.windowDays as string) || 90));
    const runLedgerKeepDays = Math.max(14, Math.min(90, parseInt(body.runLedgerKeepDays as string) || 30));
    const vacuum = body.vacuum !== false; // default true

    const result = runRetentionPass({ windowDays, runLedgerKeepDays, vacuum, dryRun });

    console.log(`[retention] ${dryRun ? "DRY RUN" : "DONE"}: rolled up ${result.rollup.rowsRolledUp} page views, deleted ${result.rollup.rowsDeleted}, run-ledger pruned ${result.runLedger.runsDeleted}, vacuum freed ${result.vacuum.freedMb}MB`);

    res.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[retention] retention-rollup error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
