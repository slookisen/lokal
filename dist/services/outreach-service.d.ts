export interface OutreachStats {
    totalAgents: number;
    claimedAgents: number;
    unclaimedAgents: number;
    agentsWithEmail: number;
    alreadyContacted: number;
    readyForOutreach: number;
}
export interface OutreachResult {
    totalAgentsToContact: number;
    emailsSent: number;
    emailsFailed: number;
    failedAgents: Array<{
        id: string;
        name: string;
        error: string;
    }>;
    duration: number;
}
export interface OutreachOptions {
    dryRun?: boolean;
    maxPerHour?: number;
    batchSize?: number;
    filterByCity?: string;
    onlyUnclaimed?: boolean;
}
declare class OutreachService {
    private readonly DEFAULT_MAX_PER_HOUR;
    private readonly DEFAULT_BATCH_SIZE;
    ensureSchema(): void;
    getOutreachStats(): OutreachStats;
    preview(options?: OutreachOptions): Array<{
        id: string;
        name: string;
        email: string;
        city: string;
    }>;
    sendOutreach(options?: OutreachOptions): Promise<OutreachResult>;
    private fetchAgentsForOutreach;
    private markAsContacted;
    private extractFriendlyName;
    private createBatches;
    private calculateDelayBetweenBatches;
    private delay;
}
export declare const outreachService: OutreachService;
export {};
//# sourceMappingURL=outreach-service.d.ts.map