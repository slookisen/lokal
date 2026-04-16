"use strict";
/**
 * Analytics Middleware Helpers
 *
 * Optional: Use these if you want to instrument routes with decorator-like middleware
 * instead of inline code. Not required — the service can be used directly.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackPageView = trackPageView;
exports.measureQuery = measureQuery;
exports.trackAgentView = trackAgentView;
exports.inferReferrerSource = inferReferrerSource;
exports.extractUserInfo = extractUserInfo;
const analytics_service_1 = require("../services/analytics-service");
/**
 * Middleware: Track page views (for SEO routes)
 *
 * Usage in router:
 *   router.get("/", trackPageView, (req, res) => { ... });
 */
function trackPageView(req, res, next) {
    const sessionId = analytics_service_1.analyticsService.getOrCreateSessionId(req, res);
    analytics_service_1.analyticsService.recordPageView({
        path: req.path,
        referrer: req.headers.referer,
        userAgent: analytics_service_1.analyticsService.getUserAgent(req),
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
function measureQuery(protocol) {
    return (req, res, next) => {
        const startTime = Date.now();
        // Store start time in request for later use
        req._analyticsStartTime = startTime;
        req._analyticsProtocol = protocol;
        // Hook into res.json to track after response is built
        const originalJson = res.json.bind(res);
        res.json = function (data) {
            const responseTimeMs = Date.now() - startTime;
            // Extract query info from request body/params
            const query = req.body?.query || req.body?.q || req.query?.q || "";
            const categories = req.body?.categories || req.query?.categories;
            const city = req.body?.city || req.query?.city;
            const resultCount = Array.isArray(data) ? data.length : (data?.length || 0);
            analytics_service_1.analyticsService.recordQuery({
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
                clientIp: analytics_service_1.analyticsService.getClientIp(req),
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
function trackAgentView(agentId, agentName, city, viewSource) {
    return (_req, _res, next) => {
        analytics_service_1.analyticsService.recordAgentView({
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
function inferReferrerSource(req, res, next) {
    const referrer = req.headers.referer;
    let source = "unknown";
    if (!referrer) {
        source = "direct";
    }
    else {
        try {
            const url = new URL(referrer).hostname.toLowerCase();
            if (url.includes("google") || url.includes("bing") || url.includes("duckduckgo")) {
                source = "search";
            }
            else if (url.includes("twitter") ||
                url.includes("x.com") ||
                url.includes("facebook") ||
                url.includes("linkedin") ||
                url.includes("instagram") ||
                url.includes("reddit")) {
                source = "social";
            }
            else if (url.includes("rettfrabonden") || url.includes("lokal.fly.dev")) {
                source = "organic";
            }
            else {
                source = "referral";
            }
        }
        catch {
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
function extractUserInfo(req) {
    const referrer = req.headers.referer || "";
    const userAgent = analytics_service_1.analyticsService.getUserAgent(req);
    const ip = analytics_service_1.analyticsService.getClientIp(req);
    // Try to parse city from referrer (very basic)
    let city = "unknown";
    if (referrer.includes("oslo"))
        city = "oslo";
    else if (referrer.includes("bergen"))
        city = "bergen";
    else if (referrer.includes("trondheim"))
        city = "trondheim";
    return {
        ip,
        userAgent,
        referrer,
        city,
    };
}
//# sourceMappingURL=analytics.js.map