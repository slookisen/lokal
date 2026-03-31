export interface AgentCard {
    name: string;
    description: string;
    url: string;
    version: string;
    capabilities: {
        streaming: boolean;
        pushNotifications: boolean;
        stateTransitionHistory: boolean;
    };
    skills: AgentSkill[];
    "x-lokal": {
        type: "producer";
        producerId: string;
        producerType: string;
        location: {
            lat: number;
            lng: number;
            city: string;
            district?: string;
        };
        categories: string[];
        tags: string[];
        certifications: string[];
        deliveryOptions: string[];
        trustScore: number;
        isOpen: boolean;
        currentProductCount: number;
        priceLevel: "budget" | "moderate" | "premium";
    };
}
interface AgentSkill {
    id: string;
    name: string;
    description: string;
    inputModes: string[];
    outputModes: string[];
}
export declare class AgentCardService {
    /**
     * Generate an A2A-compatible Agent Card for a producer.
     * Consumer agents read this to decide: "Should I ask this producer?"
     */
    generateCard(producerId: string, baseUrl: string): AgentCard | null;
    /**
     * Generate cards for ALL active producers — the "registry".
     * Consumer agents query this to discover who's available.
     */
    generateRegistry(baseUrl: string): AgentCard[];
    private generateDescription;
    private generateSkills;
    private isCurrentlyOpen;
    private estimatePriceLevel;
}
export declare const agentCardService: AgentCardService;
export {};
//# sourceMappingURL=agent-card.d.ts.map