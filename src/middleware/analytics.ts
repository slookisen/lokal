/**
 * Analytics Middleware Helpers
 *
 * Optional: Use these if you want to instrument routes with decorator-like middleware
 * instead of inline code. Not required — the service can be used directly.
 */

import { Request, Response, NextFunction } from "express";
import { analyticsService } from "../services/analytics-service";

/**
 * Middleware: Track page views (for SEO routes)
 *
 * Usage in router:
 *   router.get("/", trackPageView, (req, res) => { ... });
 */
export function trackPageView(req: Request, res: Response, next: NextFunction) {
  const sessionId = analyticsService.getOrCreateSessionId(req, res);
  analyticsService.recordPageView({
    path: req.path,
    referrer: req.headers.referer,
    userAgent: analyticsService.getUserAgent(req),
    sessionId,
  });
  next();
}

/**
 * Middleware: Measure response time and track queries
 *
 * Usage in router:
 *   router.post("/api/marketplace/discover", measureQuery("api"), handler);
 *
 * The handler response is passed through unchanged.
 */
export function measureQuery(protocol: "a2a" | "mcp" | "api" | "search") {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    // Store start time in request for later use
    (req as any)._analyticsStartTime = startTime;
    (req as any)._analyticsProtocol = protocol;

    // Hook into res.json to track after response is built
    const originalJson = res.json.bind(res);
    res.json = function (data: any) {
      const responseTimeMs = Date.now() - startTime;

      // Extract query info from request body/params
      const query = req.body?.query || req.body?.q || req.query?.q || "";
      const categories = req.body?.categories || req.query?.categories;
      const city = req.body?.city || req.query?.city;
      const resultCount = Array.isArray(data) ? data.length : (data?.length || 0);

      analyticsService.recordQuery({
        protocol,
        query: String(query),
        categories: Array.isArray(categories)
          ? categories
          : typeof categories === "string"
            ? categories.split(",")
            : undefined,
        city: String(city || ""),
        resultCount,
        responseTimeMs,
        clientIp: analyticsService.getClientIp(req),
      });

      return originalJson(data);
    };

    next();
  };
}

/**
 * Middleware: Track agent views when serving producer profiles
 *
 * Usage in router (must come after you find the agent):
 *   router.get("/produsent/:slug", (req, res) => {
 *     const agent = findAgent(req.params.slug);
 *     if (agent) {
 *       trackAgentView(agent.id, agent.name, agent.city, "seo")(req, res, () => {
 *         // serve page
 *       });
 *     }
 *   });
 *
 * Or simpler: call the service directly after you find the agent
 *   analyticsService.recordAgentView({
 *     agentId: agent.id,
 *     agentName: agent.name,
 *     city: agent.city,
 *     viewSource: "seo",
 *   });
 */
export function trackAgentView(
  agentId: string,
  agentName: string,
  city: string | undefined,
  viewSource: "search" | "direct" | "discovery" | "seo" | "unknown"
) {
  return (_req: Request, _res: Response, next: NextFunction) => {
    analyticsService.recordAgentView({
      agentId,
      agentName,
      city,
      viewSource,
    });
    next();
  };
}

/**
 * Middleware: Automatic referrer source inference
 *
 * Stores inferred source in res.locals for use in templates
 *
 * Usage:
 *   router.use(inferReferrerSource);
 *   // Then in route: const source = res.locals.referrerSource;
 */
export function inferReferrerSource(req: Request, res: Response, next: NextFunction) {
  const referrer = req.headers.referer;
  let source: "organic" | "direct" | "referral" | "search" | "social" | "unknown" =
    "unknown";

  if (!referrer) {
    source = "direct";
  } else {
    try {
      const url = new URL(referrer).hostname.toLowerCase();

      if (url.includes("google") || url.includes("bing") || url.includes("duckduckgo")) {
        source = "search";
      } else if (
        url.includes("twitter") ||
        url.includes("x.com") ||
        url.includes("facebook") ||
        url.includes("linkedin") ||
        url.includes("instagram") ||
        url.includes("reddit")
      ) {
        source = "social";
      } else if (url.includes("rettfrabonden") || url.includes("lokal.fly.dev")) {
        source = "organic";
      } else {
        source = "referral";
      }
    } catch {
      source = "unknown";
    }
  }

  res.locals.referrerSource = source;
  next();
}

/**
 * Utility: Extract user info for logging
 *
 * Usage:
 *   const userInfo = extractUserInfo(req);
 *   console.log(`User from ${userInfo.city}, ${userInfo.country} via ${userInfo.source}`);
 */
export function extractUserInfo(req: Request) {
  const referrer = req.headers.referer || "";
  const userAgent = analyticsService.getUserAgent(req);
  const ip = analyticsService.getClientIp(req);

  // Try to parse city from referrer (very basic)
  let city = "unknown";
  if (referrer.includes("oslo")) city = "oslo";
  else if (referrer.includes("bergen")) city = "bergen";
  else if (referrer.includes("trondheim")) city = "trondheim";

  return {
    ip,
    userAgent,
    referrer,
    city,
  };
}
