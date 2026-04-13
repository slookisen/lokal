export interface EmailOptions {
    to: string;
    subject: string;
    htmlContent: string;
    textContent: string;
    replyTo?: string;
    listUnsubscribe?: string;
}
export declare class EmailService {
    private transporter;
    private fromAddress;
    private isConfigured;
    constructor();
    private setupTransporter;
    sendClaimInvitation(agentId: string, sellerEmail: string, sellerName: string, agentName: string, agentPageUrl: string): Promise<{
        success: boolean;
        messageId?: string;
        error?: string;
    }>;
    sendVerificationCode(email: string, code: string, agentName: string): Promise<{
        success: boolean;
        messageId?: string;
        error?: string;
    }>;
    sendClaimConfirmation(email: string, agentName: string, dashboardUrl: string): Promise<{
        success: boolean;
        messageId?: string;
        error?: string;
    }>;
    private sendEmail;
    private generateClaimInvitationHtml;
    private generateClaimInvitationText;
    private generateVerificationCodeHtml;
    private generateVerificationCodeText;
    private generateClaimConfirmationHtml;
    private generateClaimConfirmationText;
    private escapeHtml;
}
export declare const emailService: EmailService;
//# sourceMappingURL=email-service.d.ts.map