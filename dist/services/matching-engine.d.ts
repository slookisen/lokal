import { SearchRequest, SearchResult } from "../models";
export declare class MatchingEngine {
    /**
     * Find and rank local producers for a consumer's search.
     * This is the core A2A interaction: consumer agent asks, we match.
     */
    search(request: SearchRequest): SearchResult[];
    private passesFilters;
    private calculateMatchScore;
    private priceScore;
    private freshnessScore;
    private distanceScore;
    private compareWithChains;
    private generateMatchReasons;
    private calculateDistance;
    private toRad;
    private normalizeProductName;
    private formatChainName;
}
export declare const matchingEngine: MatchingEngine;
//# sourceMappingURL=matching-engine.d.ts.map