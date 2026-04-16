/**
 * Lokal Seller Agent SDK
 *
 * Gjør det enkelt for selgere å koble seg til Lokal-nettverket.
 * Agenten registrerer seg, lytter etter forespørsler fra kjøpere,
 * og svarer automatisk basert på produktkatalog og regler.
 *
 * Bruk: npx tsx seller-agent-sdk.ts (se eksempel nederst)
 */
interface Product {
    name: string;
    category: string;
    description?: string;
    pricePerUnit: number;
    unit: string;
    available: number;
    organic?: boolean;
    seasonal?: boolean;
    deliveryOptions?: string[];
    keywords?: string[];
}
interface SellerConfig {
    name: string;
    city: string;
    region?: string;
    lat?: number;
    lng?: number;
    description: string;
    categories: string[];
    tags?: string[];
    contactEmail?: string;
    phone?: string;
    website?: string;
    address?: string;
    openingHours?: string;
    products: Product[];
    existingAgentId?: string;
    existingApiKey?: string;
    autoRespond?: boolean;
    responseDelayMs?: number;
    pollingIntervalMs?: number;
    maxConcurrentConversations?: number;
    onQuery?: (query: string, matchedProducts: Product[], conversation: any) => string | Promise<string>;
}
export declare class SellerAgent {
    private config;
    private agentId;
    private apiKey;
    private isRunning;
    private activeConversations;
    private respondedConversations;
    private pollTimer;
    constructor(config: SellerConfig);
    /**
     * Start agenten: registrer → lytt etter forespørsler → svar automatisk
     */
    start(): Promise<void>;
    /**
     * Stopp agenten
     */
    stop(): void;
    /**
     * Oppdater produkttilgjengelighet i sanntid
     */
    updateProduct(productName: string, updates: Partial<Product>): void;
    /**
     * Marker et produkt som utsolgt
     */
    markSoldOut(productName: string): void;
    /**
     * Hent agentens nåværende metrikker
     */
    getMetrics(): Promise<any>;
    private register;
    private findExistingAgent;
    private syncInventory;
    private heartbeat;
    private startPolling;
    private pollViaTasks;
    private handleConversation;
    private handleTask;
    /**
     * Manuelt svar på en samtale (for manuell modus)
     */
    respondToConversation(conversationId: string, message: string, type?: string): Promise<void>;
    private findMatchingProducts;
    private generateResponse;
    private extractQuery;
    private sendMessage;
}
export {};
//# sourceMappingURL=seller-agent-sdk.d.ts.map