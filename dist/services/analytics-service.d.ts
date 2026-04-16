import { Request, Response, NextFunction } from "express";
export interface AnalyticsTrackingOptions {
    trackPageViews?: boolean;
    trackSearchQueries?: boolean;
    trackAgentViews?: boolean;
    skipPaths?: string[];
}
export declare class AnalyticsService {
    private options;
    constructor(options?: AnalyticsTrackingOptions);
    /**
     * Express middleware for automatic request tracking
     * Place early in middleware stack (after security/CORS but before routes)
     */
    middleware(): (req: Request, res: Response, next: NextFunction) => void;
    /**
     * Track page view for human visitors
     */
    trackPageView(req: Request): void;
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
    }): void;
    /**
     * Track when a producer/agent profile is viewed
     * Call from SEO routes when /produsent/:id is loaded
     */
    trackAgentView(agentId: string, agentName: string, city: string | undefined, source: "search" | "direct" | "discovery" | "seo"): void;
    /**
     * Track API endpoint usage with detailed metadata
     * For A2A and MCP protocol tracking
     */
    trackAPIUsage(req: Request, protocol: "a2a" | "mcp" | "api", duration: number, metadata?: Record<string, any>): void;
    /**
     * Get analytics summary for a time range
     */
    getSummary(hoursBack?: number): {
        pageViews: number;
        uniqueVisitors: number;
        avgTimeOnSite: number;
        totalQueries: number;
        topSearchTerms: Array<{
            query: string;
            count: number;
        }>;
        trafficBySource: Record<string, number>;
        agentTraffic: {
            chatgpt: number;
            claude: number;
            other: number;
        };
    };
    /**
     * Get top producers by view count
     */
    getTopProducers(limit?: number, hoursBack?: number): Array<{
        agentId: string;
        agentName: string;
        city?: string;
        viewCount: number;
        topSource: string;
    }>;
    /**
     * Get city-level analytics
     */
    getCityStats(hoursBack?: number): Array<{
        city: string;
        viewCount: number;
        searchQueries: number;
        topCategory: string | null;
    }>;
    /**
     * Export raw analytics data for external analysis
     * Returns paginated results
     */
    exportData(table: "page_views" | "queries" | "agent_views", limit?: number, offset?: number): {
        data: any[];
        total: number;
        limit: number;
        offset: number;
    };
    /**
     * Clear old analytics data (older than specified days)
     * Useful for privacy compliance and storage management
     */
    pruneOldData(olderThanDays: number): number;
}
export declare const analyticsService: AnalyticsService;
export default analyticsService;
//# sourceMappingURL=analytics-service.d.ts.map