import { EventEmitter } from "events";
export type InteractionType = "search" | "discover" | "register" | "view" | "message" | "transaction";
export interface InteractionEvent {
    id: string;
    type: InteractionType;
    agentId?: string;
    agentName?: string;
    query?: string;
    resultCount: number;
    matchedAgentIds: string[];
    metadata: Record<string, any>;
    durationMs?: number;
    createdAt: string;
}
declare class InteractionLogger extends EventEmitter {
    log(type: InteractionType, opts?: {
        agentId?: string;
        query?: string;
        resultCount?: number;
        matchedAgentIds?: string[];
        metadata?: Record<string, any>;
        ipAddress?: string;
        durationMs?: number;
    }): InteractionEvent;
    getRecent(limit?: number): InteractionEvent[];
    getStats(): {
        totalInteractions: number;
        todayInteractions: number;
        searchesToday: number;
        uniqueAgentsToday: number;
        topSearches: {
            query: string;
            count: number;
        }[];
    };
}
export declare const interactionLogger: InteractionLogger;
export {};
//# sourceMappingURL=interaction-logger.d.ts.map