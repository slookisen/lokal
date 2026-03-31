declare class DiscoveryService {
    private baseUrl;
    private heartbeatInterval;
    constructor();
    initialize(baseUrl: string): Promise<void>;
    registerWithAllRegistries(): Promise<void>;
    private registerWithRegistry;
    private startHeartbeat;
    getDiscoveryMetadata(): object;
    getRegistryStatus(): object[];
    shutdown(): void;
    private isPublicUrl;
}
export declare const discoveryService: DiscoveryService;
export {};
//# sourceMappingURL=discovery-service.d.ts.map