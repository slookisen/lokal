import { AgentRegistration, RegisteredAgent, DiscoveryQuery, DiscoveryResult } from "../models/marketplace";
declare class MarketplaceRegistry {
    register(registration: AgentRegistration): RegisteredAgent;
    discover(query: DiscoveryQuery): DiscoveryResult[];
    parseNaturalQuery(query: string): Partial<DiscoveryQuery>;
    getAgentCard(agentId: string): object | null;
    getRegistryCard(baseUrl: string): object;
    getAgent(id: string): RegisteredAgent | undefined;
    getAgentByApiKey(apiKey: string): RegisteredAgent | undefined;
    updateAgent(id: string, updates: Partial<RegisteredAgent>): RegisteredAgent | undefined;
    heartbeat(id: string): void;
    deactivate(id: string): boolean;
    getAllAgents(): RegisteredAgent[];
    getActiveAgents(): RegisteredAgent[];
    getStats(): {
        totalAgents: number;
        activeProducers: number;
        cities: string[];
        totalListings: number;
    };
    createTask(method: string, params: any, consumerAgentId?: string): any;
    updateTask(id: string, status: string, result?: any, error?: string): any;
    getTask(id: string): any;
    listTasks(consumerAgentId?: string, status?: string): any[];
    addListing(agentId: string, listing: any): any;
    getListingsByAgent(agentId: string): any[];
    getAgentByName(name: string): RegisteredAgent | undefined;
    private generateApiKey;
    private incrementDiscovery;
    private rowToAgent;
    private calculateRelevance;
}
export declare const marketplaceRegistry: MarketplaceRegistry;
export {};
//# sourceMappingURL=marketplace-registry.d.ts.map