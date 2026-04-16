/**
 * Analytics Middleware Helpers
 *
 * Optional: Use these if you want to instrument routes with decorator-like middleware
 * instead of inline code. Not required — the service can be used directly.
 */
import { Request, Response, NextFunction } from "express";
/**
 * Middleware: Track page views (for SEO routes)
 *
 * Usage in router:
 *   router.get("/", trackPageView, (req, res) => { ... });
 */
export declare function trackPageView(req: Request, res: Response, next: NextFunction): void;
/**
 * Middleware: Measure response time and track queries
 *
 * Usage in router:
 *   router.post("/api/marketplace/discover", measureQuery("api"), handler);
 *
 * The handler response is passed through unchanged.
 */
export declare function measureQuery(protocol: "a2a" | "mcp" | "api" | "search"): (req: Request, res: Response, next: NextFunction) => void;
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
export declare function trackAgentView(agentId: string, agentName: string, city: string | undefined, viewSource: "search" | "direct" | "discovery" | "seo" | "unknown"): (_req: Request, _res: Response, next: NextFunction) => void;
/**
 * Middleware: Automatic referrer source inference
 *
 * Stores inferred source in res.locals for use in templates
 *
 * Usage:
 *   router.use(inferReferrerSource);
 *   // Then in route: const source = res.locals.referrerSource;
 */
export declare function inferReferrerSource(req: Request, res: Response, next: NextFunction): void;
/**
 * Utility: Extract user info for logging
 *
 * Usage:
 *   const userInfo = extractUserInfo(req);
 *   console.log(`User from ${userInfo.city}, ${userInfo.country} via ${userInfo.source}`);
 */
export declare function extractUserInfo(req: Request): {
    ip: string;
    userAgent: string;
    referrer: string;
    city: string;
};
//# sourceMappingURL=analytics.d.ts.map