export interface AgentKnowledge {
    agentId: string;
    address?: string;
    postalCode?: string;
    website?: string;
    phone?: string;
    email?: string;
    openingHours: OpeningHour[];
    products: ProductInfo[];
    about?: string;
    specialties: string[];
    certifications: string[];
    paymentMethods: string[];
    deliveryOptions: string[];
    googleRating?: number;
    googleReviewCount?: number;
    tripadvisorRating?: number;
    externalReviews: ExternalReview[];
    externalLinks: ExternalLink[];
    images: string[];
    seasonality: SeasonalProduct[];
    deliveryRadius?: number;
    minOrderValue?: number;
    dataSource: "auto" | "owner" | "hybrid";
    autoSources: string[];
    lastEnrichedAt?: string;
    ownerUpdatedAt?: string;
    preferences: Record<string, any>;
}
export interface SeasonalProduct {
    product: string;
    months: number[];
    note?: string;
}
export interface OpeningHour {
    day: string;
    open: string;
    close: string;
    note?: string;
}
export interface ProductInfo {
    name: string;
    category: string;
    seasonal: boolean;
    months?: number[];
    organic?: boolean;
    note?: string;
}
export interface ExternalReview {
    source: string;
    text: string;
    rating?: number;
    date?: string;
}
export interface ExternalLink {
    label: string;
    url: string;
    type: string;
}
export interface AgentInfoResponse {
    agent: {
        id: string;
        name: string;
        role: string;
        city?: string;
        trustScore: number;
        isVerified: boolean;
        isClaimed: boolean;
        languages: string[];
        schemaVersion: string;
        agentVersion: number;
    };
    knowledge: {
        address?: string;
        postalCode?: string;
        website?: string;
        phone?: string;
        email?: string;
        openingHours: OpeningHour[];
        products: ProductInfo[];
        about?: string;
        description?: string;
        specialties: string[];
        certifications: string[];
        paymentMethods: string[];
        deliveryOptions: string[];
        images: string[];
        seasonality: SeasonalProduct[];
        deliveryRadius?: number;
        minOrderValue?: number;
        ratings?: {
            google?: {
                score: number;
                reviews: number;
            };
            tripadvisor?: {
                score: number;
            };
        };
    };
    meta: {
        dataSource: "auto" | "owner" | "hybrid";
        autoSources: string[];
        lastUpdated: string;
        disclaimer: string;
    };
}
declare class KnowledgeService {
    getKnowledge(agentId: string): AgentKnowledge | null;
    getAgentInfo(agentId: string): AgentInfoResponse | null;
    upsertKnowledge(agentId: string, data: Partial<AgentKnowledge>): void;
    ownerUpdate(agentId: string, data: Partial<AgentKnowledge>): void;
    bulkEnrich(enrichments: Array<{
        agentId: string;
        data: Partial<AgentKnowledge>;
    }>): number;
    isAgentClaimed(agentId: string): boolean;
    requestClaim(agentId: string, opts: {
        claimantName: string;
        claimantEmail: string;
        claimantPhone?: string;
        source?: string;
    }): {
        claimId: string;
        verificationCode: string;
    };
    verifyClaim(claimId: string, code: string): {
        success: boolean;
        claimToken?: string;
        error?: string;
    };
    getClaimByToken(token: string): {
        agentId: string;
        claimantName: string;
        claimantEmail: string;
    } | null;
    resendClaimToken(agentId: string, email: string): {
        success: boolean;
        claimToken?: string;
        error?: string;
    };
    createMagicLink(email: string): {
        success: boolean;
        token?: string;
        agentId?: string;
        agentName?: string;
        error?: string;
    };
    verifyMagicLink(token: string): {
        success: boolean;
        agentId?: string;
        claimToken?: string;
        claimantName?: string;
        error?: string;
    };
    getKnowledgeStats(): {
        total: number;
        enriched: number;
        claimed: number;
        autoOnly: number;
        ownerOrHybrid: number;
    };
    private generateVerificationCode;
    private mergeKnowledge;
    private buildRatings;
    private rowToKnowledge;
}
export declare const knowledgeService: KnowledgeService;
export {};
//# sourceMappingURL=knowledge-service.d.ts.map