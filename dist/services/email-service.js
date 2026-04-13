"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailService = exports.EmailService = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
// Simple logger — replace with winston/pino in production
const logger = {
    info: (msg, meta) => console.log(`[Email] ${msg}`, meta ? JSON.stringify(meta) : ""),
    warn: (msg, meta) => console.warn(`[Email] ⚠️  ${msg}`, meta ? JSON.stringify(meta) : ""),
    error: (msg, meta) => console.error(`[Email] ✗ ${msg}`, meta ? JSON.stringify(meta) : ""),
};
class EmailService {
    transporter;
    fromAddress;
    isConfigured;
    constructor() {
        this.fromAddress = process.env.SMTP_FROM || 'hei@lokal.farm';
        this.isConfigured = this.setupTransporter();
    }
    setupTransporter() {
        const smtpHost = process.env.SMTP_HOST;
        const smtpPort = process.env.SMTP_PORT;
        const smtpUser = process.env.SMTP_USER;
        const smtpPass = process.env.SMTP_PASS;
        if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
            logger.warn('SMTP not configured. Email service in dry-run mode.');
            this.transporter = null;
            return false;
        }
        this.transporter = nodemailer_1.default.createTransport({
            host: smtpHost,
            port: parseInt(smtpPort),
            secure: parseInt(smtpPort) === 465,
            auth: {
                user: smtpUser,
                pass: smtpPass,
            },
        });
        return true;
    }
    async sendClaimInvitation(agentId, sellerEmail, sellerName, agentName, agentPageUrl) {
        try {
            const unsubscribeLink = `${process.env.APP_URL || 'https://lokal.fly.dev'}/unsubscribe?email=${encodeURIComponent(sellerEmail)}&agent=${agentId}`;
            const claimUrl = `${process.env.APP_URL || 'https://lokal.fly.dev'}/agent/${agentId}/claim`;
            const subject = `Lokal — Vi har funnet deg og dine produkter!`;
            const htmlContent = this.generateClaimInvitationHtml(sellerName, agentName, agentPageUrl, claimUrl, unsubscribeLink);
            const textContent = this.generateClaimInvitationText(sellerName, agentName, agentPageUrl, claimUrl);
            return await this.sendEmail({
                to: sellerEmail,
                subject,
                htmlContent,
                textContent,
                replyTo: 'hallo@lokal.farm',
                listUnsubscribe: `<${unsubscribeLink}>`,
            });
        }
        catch (error) {
            logger.error('Error sending claim invitation', {
                agentId,
                sellerEmail,
                error: error instanceof Error ? error.message : String(error),
            });
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
    async sendVerificationCode(email, code, agentName) {
        try {
            const subject = `Din bekreftelseskode for ${agentName} på Lokal`;
            const htmlContent = this.generateVerificationCodeHtml(code, agentName);
            const textContent = this.generateVerificationCodeText(code, agentName);
            return await this.sendEmail({
                to: email,
                subject,
                htmlContent,
                textContent,
                replyTo: 'hallo@lokal.farm',
            });
        }
        catch (error) {
            logger.error('Error sending verification code', {
                email,
                agentName,
                error: error instanceof Error ? error.message : String(error),
            });
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
    async sendClaimConfirmation(email, agentName, dashboardUrl) {
        try {
            const subject = `Gratulerer! ${agentName} er nå ditt på Lokal`;
            const htmlContent = this.generateClaimConfirmationHtml(agentName, dashboardUrl);
            const textContent = this.generateClaimConfirmationText(agentName, dashboardUrl);
            return await this.sendEmail({
                to: email,
                subject,
                htmlContent,
                textContent,
                replyTo: 'hallo@lokal.farm',
            });
        }
        catch (error) {
            logger.error('Error sending claim confirmation', {
                email,
                agentName,
                error: error instanceof Error ? error.message : String(error),
            });
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
    async sendEmail(options) {
        if (!this.isConfigured) {
            logger.info('DRY RUN: Would send email', {
                to: options.to,
                subject: options.subject,
            });
            return { success: true, messageId: 'DRY_RUN' };
        }
        try {
            const mailOptions = {
                from: this.fromAddress,
                to: options.to,
                subject: options.subject,
                html: options.htmlContent,
                text: options.textContent,
                replyTo: options.replyTo,
                headers: {
                    'List-Unsubscribe': options.listUnsubscribe,
                    'X-Lokal-Agent': 'outreach-system/v1',
                },
            };
            const info = await this.transporter.sendMail(mailOptions);
            logger.info('Email sent successfully', {
                to: options.to,
                subject: options.subject,
                messageId: info.messageId,
            });
            return { success: true, messageId: info.messageId };
        }
        catch (error) {
            logger.error('Failed to send email', {
                to: options.to,
                error: error instanceof Error ? error.message : String(error),
            });
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
    generateClaimInvitationHtml(sellerName, agentName, agentPageUrl, claimUrl, unsubscribeLink) {
        return `
<!DOCTYPE html>
<html lang="no">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 0;
    }
    .container {
      background: #ffffff;
      padding: 40px 20px;
    }
    .header {
      margin-bottom: 30px;
      border-bottom: 3px solid #2d5f2e;
      padding-bottom: 20px;
    }
    .logo {
      font-size: 24px;
      font-weight: bold;
      color: #2d5f2e;
    }
    h1 {
      font-size: 22px;
      color: #1a1a1a;
      margin: 20px 0 15px 0;
    }
    p {
      margin: 12px 0;
      font-size: 15px;
      line-height: 1.7;
    }
    .info-box {
      background: #f5f5f5;
      border-left: 4px solid #2d5f2e;
      padding: 15px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .cta-button {
      display: inline-block;
      background: #2d5f2e;
      color: white;
      padding: 14px 32px;
      text-decoration: none;
      border-radius: 6px;
      font-weight: bold;
      margin: 20px 0;
      text-align: center;
    }
    .cta-button:hover {
      background: #1e4620;
    }
    .agent-link {
      color: #2d5f2e;
      text-decoration: none;
      font-weight: 500;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #eee;
      font-size: 13px;
      color: #666;
    }
    .footer-link {
      color: #666;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">🌾 Lokal</div>
    </div>

    <h1>Hei ${this.escapeHtml(sellerName)}!</h1>

    <p>Vi bygger et nettverk for lokale matprodusenter — hvor dine produkter møter mennesker som leter etter akkurat det du har.</p>

    <p><strong>Vi har funnet deg og dine produkter på Lokal, og vi ønsker at du skal eie din egen agent her.</strong></p>

    <div class="info-box">
      <strong>Vi har registrert:</strong>
      <p>${this.escapeHtml(agentName)}</p>
      <p><a href="${this.escapeHtml(agentPageUrl)}" class="agent-link">Se hva som står om deg her →</a></p>
    </div>

    <h2 style="font-size: 16px; margin-top: 25px;">Hva betyr det å "eie" din agent?</h2>
    <p>Du får kontroll over informasjonen som vises — åpningstider, produkter, kontaktdetaljer, og mer. Din agent blir også smartere: over tid lærer den mer om dine produkter og kundenes preferanser, slik at den kan hjelpe deg med å nå riktige folk.</p>

    <p style="font-weight: bold; margin-top: 20px;">Det tar mindre enn 5 minutter. Klikk her:</p>

    <a href="${this.escapeHtml(claimUrl)}" class="cta-button">Krav din agent på Lokal</a>

    <p style="font-size: 14px; color: #666; margin-top: 25px;">Har du spørsmål? Svar på denne e-posten eller kontakt oss på <a href="mailto:hallo@lokal.farm" class="footer-link">hallo@lokal.farm</a>.</p>

    <div class="footer">
      <p>Lokal bygger nettverk hvor norske matprodusenter møter mennesker som verdsetter lokal og god mat.</p>
      <p>
        <a href="${this.escapeHtml(unsubscribeLink)}" class="footer-link">Avslutt abonnement</a>
      </p>
      <p style="margin-top: 15px; color: #999;">Lokal | Det lokale matnettet</p>
    </div>
  </div>
</body>
</html>
    `;
    }
    generateClaimInvitationText(sellerName, agentName, agentPageUrl, claimUrl) {
        return `
Hei ${sellerName}!

Vi bygger et nettverk for lokale matprodusenter — hvor dine produkter møter mennesker som leter etter akkurat det du har.

Vi har funnet deg og dine produkter på Lokal, og vi ønsker at du skal eie din egen agent her.

VI HAR REGISTRERT:
${agentName}

Se hva som står om deg her:
${agentPageUrl}

HVA BETYR DET Å "EIE" DIN AGENT?

Du får kontroll over informasjonen som vises — åpningstider, produkter, kontaktdetaljer, og mer. Din agent blir også smartere: over tid lærer den mer om dine produkter og kundenes preferanser, slik at den kan hjelpe deg med å nå riktige folk.

Det tar mindre enn 5 minutter. Klikk her:

${claimUrl}

SPØRSMÅL?

Svar på denne e-posten eller kontakt oss på hallo@lokal.farm

---
Lokal bygger nettverk hvor norske matprodusenter møter mennesker som verdsetter lokal og god mat.
    `;
    }
    generateVerificationCodeHtml(code, agentName) {
        return `
<!DOCTYPE html>
<html lang="no">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif;
      color: #333;
      max-width: 500px;
      margin: 0 auto;
    }
    .container {
      background: #ffffff;
      padding: 40px 20px;
    }
    .code-box {
      background: #f5f5f5;
      border: 2px solid #2d5f2e;
      padding: 20px;
      text-align: center;
      margin: 30px 0;
      border-radius: 6px;
    }
    .code {
      font-size: 32px;
      font-weight: bold;
      color: #2d5f2e;
      letter-spacing: 4px;
      font-family: 'Courier New', monospace;
    }
    .logo {
      font-size: 20px;
      font-weight: bold;
      color: #2d5f2e;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🌾 Lokal</div>
    <h1>Din bekreftelseskode</h1>
    <p>Du ba om å bekrefte at du eier <strong>${this.escapeHtml(agentName)}</strong> på Lokal.</p>
    <p>Din bekreftelseskode er:</p>
    <div class="code-box">
      <div class="code">${code}</div>
    </div>
    <p>Koden er gyldig i 24 timer.</p>
    <p>Hvis du ikke ba om denne koden, kan du ignorere denne e-posten.</p>
  </div>
</body>
</html>
    `;
    }
    generateVerificationCodeText(code, agentName) {
        return `
Din bekreftelseskode

Du ba om å bekrefte at du eier ${agentName} på Lokal.

Din bekreftelseskode er:

${code}

Koden er gyldig i 24 timer.

Hvis du ikke ba om denne koden, kan du ignorere denne e-posten.
    `;
    }
    generateClaimConfirmationHtml(agentName, dashboardUrl) {
        return `
<!DOCTYPE html>
<html lang="no">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
    }
    .container {
      background: #ffffff;
      padding: 40px 20px;
    }
    .success-box {
      background: #e8f5e9;
      border-left: 4px solid #2d5f2e;
      padding: 20px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .cta-button {
      display: inline-block;
      background: #2d5f2e;
      color: white;
      padding: 14px 32px;
      text-decoration: none;
      border-radius: 6px;
      font-weight: bold;
      margin: 20px 0;
    }
    .logo {
      font-size: 20px;
      font-weight: bold;
      color: #2d5f2e;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🌾 Lokal</div>
    <h1>Gratulerer!</h1>
    <div class="success-box">
      <p><strong>${this.escapeHtml(agentName)}</strong> er nå ditt på Lokal.</p>
    </div>
    <p>Din agent er klar. Du kan nå:</p>
    <ul>
      <li>Oppdatere informasjon om produkter og åpningstider</li>
      <li>Se hvor dine produkter blir funnet av kundene</li>
      <li>Følge med på interaksjoner og preferanser</li>
    </ul>
    <a href="${this.escapeHtml(dashboardUrl)}" class="cta-button">Gå til dashboarden din</a>
    <p>Lykke til!</p>
  </div>
</body>
</html>
    `;
    }
    generateClaimConfirmationText(agentName, dashboardUrl) {
        return `
Gratulerer!

${agentName} er nå ditt på Lokal.

Din agent er klar. Du kan nå:
- Oppdatere informasjon om produkter og åpningstider
- Se hvor dine produkter blir funnet av kundene
- Følge med på interaksjoner og preferanser

Gå til dashboarden din:
${dashboardUrl}

Lykke til!
    `;
    }
    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;',
        };
        return text.replace(/[&<>"']/g, (char) => map[char]);
    }
}
exports.EmailService = EmailService;
exports.emailService = new EmailService();
//# sourceMappingURL=email-service.js.map