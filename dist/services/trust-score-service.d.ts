declare class TrustScoreService {
    calculate(agentId: string): number;
    update(agentId: string): number;
    recalculateAll(): {
        updated: number;
        avgScore: number;
        distribution: Record<string, number>;
    };
    getBreakdown(agentId: string): {
        score: number;
        signals: {
            verification: {
                value: number;
                weight: number;
                detail: string;
            };
            completeness: {
                value: number;
                weight: number;
                detail: string;
            };
            freshness: {
                value: number;
                weight: number;
                detail: string;
            };
            interaction: {
                value: number;
                weight: number;
                detail: string;
            };
            community: {
                value: number;
                weight: number;
                detail: string;
            };
        };
        tips: string[];
    };
    private verificationSignal;
    private completenessSignal;
    private freshnessSignal;
    private interactionSignal;
    private communitySignal;
    private isAgentClaimed;
    private getLastActivityLabel;
    private getInteractionDetail;
}
export declare const trustScoreService: TrustScoreService;
export {};
//# sourceMappingURL=trust-score-service.d.ts.map