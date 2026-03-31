export type ConversationStatus = "open" | "negotiating" | "accepted" | "completed" | "expired" | "cancelled";
export type MessageType = "text" | "offer" | "accept" | "reject" | "info";
export type SenderRole = "buyer" | "seller" | "system";
export interface Conversation {
    id: string;
    buyerAgentId?: string;
    buyerAgentName?: string;
    sellerAgentId: string;
    sellerAgentName?: string;
    status: ConversationStatus;
    queryText?: string;
    taskId?: string;
    messages: ConversationMessage[];
    createdAt: string;
    updatedAt: string;
}
export interface ConversationMessage {
    id: string;
    conversationId: string;
    senderRole: SenderRole;
    senderAgentId?: string;
    senderAgentName?: string;
    content: string;
    messageType: MessageType;
    metadata: Record<string, any>;
    createdAt: string;
}
declare class ConversationService {
    startConversation(opts: {
        buyerAgentId?: string;
        sellerAgentId: string;
        queryText?: string;
        taskId?: string;
    }): Conversation;
    addMessage(opts: {
        conversationId: string;
        senderRole: SenderRole;
        senderAgentId?: string;
        content: string;
        messageType?: MessageType;
        metadata?: Record<string, any>;
    }): ConversationMessage;
    completeTransaction(conversationId: string, opts?: {
        totalAmountNok?: number;
        products?: string[];
    }): Conversation;
    getConversation(id: string): Conversation | null;
    listConversations(opts?: {
        limit?: number;
        status?: string;
        agentId?: string;
    }): Conversation[];
    getAgentMetrics(agentId: string): any;
    getLeaderboard(limit?: number): any[];
    private getMessages;
    private getMessage;
    private incrementMetric;
    private addRevenue;
}
export declare const conversationService: ConversationService;
export {};
//# sourceMappingURL=conversation-service.d.ts.map