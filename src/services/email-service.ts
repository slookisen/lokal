import nodemailer, { Transporter } from 'nodemailer';
import { slugify } from "../utils/slug";

// Simple logger — replace with winston/pino in production
const logger = {
  info: (msg: string, meta?: any) => console.log(`[Email] ${msg}`, meta ? JSON.stringify(meta) : ""),
  warn: (msg: string, meta?: any) => console.warn(`[Email] ⚠️  ${msg}`, meta ? JSON.stringify(meta) : ""),
  error: (msg: string, meta?: any) => console.error(`[Email] ✗ ${msg}`, meta ? JSON.stringify(meta) : ""),
};

export interface EmailOptions {
  to: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  replyTo?: string;
  listUnsubscribe?: string;
}

export class EmailService {
  private transporter!: Transporter;
  private fromAddress: string;
  private isConfigured: boolean;

  constructor() {
    this.fromAddress = process.env.SMTP_FROM || 'kontakt@rettfrabonden.com';
    this.isConfigured = this.setupTransporter();
  }

  private setupTransporter(): boolean {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
      logger.warn('SMTP not configured. Email service in dry-run mode.');
      this.transporter = null as any;
      return false;
    }

    this.transporter = nodemailer.createTransport({
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

  async sendClaimInvitation(
    agentId: string,
    sellerEmail: string,
    sellerName: string,
    agentName: string,
    agentPageUrl: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const unsubscribeLink = `${process.env.APP_URL || 'https://rettfrabonden.com'}/unsubscribe?email=${encodeURIComponent(sellerEmail)}&agent=${agentId}`;
      const claimUrl = `${process.env.APP_URL || 'https://rettfrabonden.com'}/agent/${agentId}/claim`;

      const subject = `Rett fra Bonden — Vi har funnet deg og dine produkter!`;

      const htmlContent = this.generateClaimInvitationHtml(
        sellerName,
        agentName,
        agentPageUrl,
        claimUrl,
        unsubscribeLink
      );

      const textContent = this.generateClaimInvitationText(
        sellerName,
        agentName,
        agentPageUrl,
        claimUrl
      );

      return await this.sendEmail({
        to: sellerEmail,
        subject,
        htmlContent,
        textContent,
        replyTo: 'kontakt@rettfrabonden.com',
        listUnsubscribe: `<${unsubscribeLink}>`,
      });
    } catch (error) {
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

  async sendVerificationCode(
    email: string,
    code: string,
    agentName: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const subject = `Din bekreftelseskode for ${agentName} på Rett fra Bonden`;

      const htmlContent = this.generateVerificationCodeHtml(code, agentName);
      const textContent = this.generateVerificationCodeText(code, agentName);

      return await this.sendEmail({
        to: email,
        subject,
        htmlContent,
        textContent,
        replyTo: 'kontakt@rettfrabonden.com',
      });
    } catch (error) {
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

  async sendClaimConfirmation(
    email: string,
    agentName: string,
    dashboardUrl: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const subject = `Gratulerer! ${agentName} er nå ditt på Rett fra Bonden`;

      const htmlContent = this.generateClaimConfirmationHtml(agentName, dashboardUrl);
      const textContent = this.generateClaimConfirmationText(agentName, dashboardUrl);

      return await this.sendEmail({
        to: email,
        subject,
        htmlContent,
        textContent,
        replyTo: 'kontakt@rettfrabonden.com',
      });
    } catch (error) {
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

  async sendEmail(options: EmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured) {
      logger.info('DRY RUN: Would send email', {
        to: options.to,
        subject: options.subject,
      });
      return { success: true, messageId: 'DRY_RUN' };
    }

    try {
      const headers: Record<string, string> = {
        'X-Lokal-Agent': 'outreach-system/v1',
      };
      if (options.listUnsubscribe) {
        headers['List-Unsubscribe'] = options.listUnsubscribe;
      }

      const mailOptions = {
        from: this.fromAddress,
        to: options.to,
        subject: options.subject,
        html: options.htmlContent,
        text: options.textContent,
        replyTo: options.replyTo,
        headers,
      };

      const info = await this.transporter.sendMail(mailOptions);

      logger.info('Email sent successfully', {
        to: options.to,
        subject: options.subject,
        messageId: info.messageId as string,
      });

      return { success: true, messageId: info.messageId as string };
    } catch (error) {
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

  private generateClaimInvitationHtml(
    sellerName: string,
    agentName: string,
    agentPageUrl: string,
    claimUrl: string,
    unsubscribeLink: string
  ): string {
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
      <div class="logo">🌾 Rett fra Bonden</div>
    </div>

    <h1>Hei ${this.escapeHtml(sellerName)}!</h1>

    <p>Vi bygger et nettverk for lokale matprodusenter — hvor dine produkter møter mennesker som leter etter akkurat det du har.</p>

    <p><strong>Vi har funnet deg og dine produkter på Rett fra Bonden, og vi ønsker at du skal eie din egen agent her.</strong></p>

    <div class="info-box">
      <strong>Vi har registrert:</strong>
      <p>${this.escapeHtml(agentName)}</p>
      <p><a href="${this.escapeHtml(agentPageUrl)}" class="agent-link">Se hva som står om deg her →</a></p>
    </div>

    <h2 style="font-size: 16px; margin-top: 25px;">Hva betyr det å "eie" din agent?</h2>
    <p>Du får kontroll over informasjonen som vises — åpningstider, produkter, kontaktdetaljer, og mer. Din agent blir også smartere: over tid lærer den mer om dine produkter og kundenes preferanser, slik at den kan hjelpe deg med å nå riktige folk.</p>

    <p style="font-weight: bold; margin-top: 20px;">Det tar mindre enn 5 minutter. Klikk her:</p>

    <a href="${this.escapeHtml(claimUrl)}" class="cta-button">Krav din agent på Rett fra Bonden</a>

    <p style="font-size: 14px; color: #666; margin-top: 25px;">Har du spørsmål? Svar på denne e-posten eller kontakt oss på <a href="mailto:kontakt@rettfrabonden.com" class="footer-link">kontakt@rettfrabonden.com</a>.</p>

    <div class="footer">
      <p>Rett fra Bonden bygger nettverk hvor norske matprodusenter møter mennesker som verdsetter lokal og god mat.</p>
      <p>
        <a href="${this.escapeHtml(unsubscribeLink)}" class="footer-link">Avslutt abonnement</a>
      </p>
      <p style="margin-top: 15px; color: #999;">Rett fra Bonden | rettfrabonden.com</p>
    </div>
  </div>
</body>
</html>
    `;
  }

  private generateClaimInvitationText(
    sellerName: string,
    agentName: string,
    agentPageUrl: string,
    claimUrl: string
  ): string {
    return `
Hei ${sellerName}!

Vi bygger et nettverk for lokale matprodusenter — hvor dine produkter møter mennesker som leter etter akkurat det du har.

Vi har funnet deg og dine produkter på Rett fra Bonden, og vi ønsker at du skal eie din egen agent her.

VI HAR REGISTRERT:
${agentName}

Se hva som står om deg her:
${agentPageUrl}

HVA BETYR DET Å "EIE" DIN AGENT?

Du får kontroll over informasjonen som vises — åpningstider, produkter, kontaktdetaljer, og mer. Din agent blir også smartere: over tid lærer den mer om dine produkter og kundenes preferanser, slik at den kan hjelpe deg med å nå riktige folk.

Det tar mindre enn 5 minutter. Klikk her:

${claimUrl}

SPØRSMÅL?

Svar på denne e-posten eller kontakt oss på kontakt@rettfrabonden.com

---
Rett fra Bonden bygger nettverk hvor norske matprodusenter møter mennesker som verdsetter lokal og god mat.
    `;
  }

  private generateVerificationCodeHtml(code: string, agentName: string): string {
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
    <div class="logo">🌾 Rett fra Bonden</div>
    <h1>Din bekreftelseskode</h1>
    <p>Du ba om å bekrefte at du eier <strong>${this.escapeHtml(agentName)}</strong> på Rett fra Bonden.</p>
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

  private generateVerificationCodeText(code: string, agentName: string): string {
    return `
Din bekreftelseskode

Du ba om å bekrefte at du eier ${agentName} på Rett fra Bonden.

Din bekreftelseskode er:

${code}

Koden er gyldig i 24 timer.

Hvis du ikke ba om denne koden, kan du ignorere denne e-posten.
    `;
  }

  private generateClaimConfirmationHtml(agentName: string, dashboardUrl: string): string {
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
    <div class="logo">🌾 Rett fra Bonden</div>
    <h1>Gratulerer!</h1>
    <div class="success-box">
      <p><strong>${this.escapeHtml(agentName)}</strong> er nå ditt på Rett fra Bonden.</p>
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

  private generateClaimConfirmationText(agentName: string, dashboardUrl: string): string {
    return `
Gratulerer!

${agentName} er nå ditt på Rett fra Bonden.

Din agent er klar. Du kan nå:
- Oppdatere informasjon om produkter og åpningstider
- Se hvor dine produkter blir funnet av kundene
- Følge med på interaksjoner og preferanser

Gå til dashboarden din:
${dashboardUrl}

Lykke til!
    `;
  }

  async sendMagicLink(
    email: string,
    magicUrl: string,
    agentName: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const subject = `Logg inn på Rett fra Bonden`;

      const htmlContent = `
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
    .logo {
      font-size: 20px;
      font-weight: bold;
      color: #2d5f2e;
      margin-bottom: 20px;
    }
    .cta-button {
      display: inline-block;
      background: #2d5f2e;
      color: white;
      padding: 14px 32px;
      text-decoration: none;
      border-radius: 6px;
      font-weight: bold;
      margin: 25px 0;
      text-align: center;
    }
    .footer {
      margin-top: 30px;
      padding-top: 15px;
      border-top: 1px solid #eee;
      font-size: 13px;
      color: #999;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">\u{1F33E} Rett fra Bonden</div>
    <h1 style="font-size: 20px;">Logg inn</h1>
    <p>Du ba om å logge inn for å administrere <strong>${this.escapeHtml(agentName)}</strong>.</p>
    <p>Klikk knappen under for å logge inn. Lenken er gyldig i 15 minutter.</p>
    <a href="${this.escapeHtml(magicUrl)}" class="cta-button">Logg inn n\u00e5</a>
    <p style="font-size: 13px; color: #666;">Eller kopier denne lenken:</p>
    <p style="font-size: 12px; color: #999; word-break: break-all;">${this.escapeHtml(magicUrl)}</p>
    <div class="footer">
      <p>Hvis du ikke ba om denne lenken, kan du trygt ignorere denne e-posten.</p>
      <p>Rett fra Bonden | rettfrabonden.com</p>
    </div>
  </div>
</body>
</html>`;

      const textContent = `Logg inn på Rett fra Bonden

Du ba om å logge inn for å administrere ${agentName}.

Klikk her for å logge inn (gyldig i 15 minutter):
${magicUrl}

Hvis du ikke ba om denne lenken, kan du trygt ignorere denne e-posten.

Rett fra Bonden | rettfrabonden.com`;

      return await this.sendEmail({
        to: email,
        subject,
        htmlContent,
        textContent,
        replyTo: 'kontakt@rettfrabonden.com',
      });
    } catch (error) {
      logger.error('Error sending magic link', {
        email,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async sendAdminClaimNotification(
    agentName: string,
    agentId: string,
    claimantName: string,
    claimantEmail: string,
    source: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
    if (!adminEmail) {
      logger.info('ADMIN_NOTIFICATION_EMAIL not set — skipping claim notification');
      return { success: true, messageId: 'NO_ADMIN_EMAIL' };
    }

    try {
      // Use canonical name-slug, not UUID — UUID URLs 404. agentName
      // is the producer's display name; slugify matches the seo.ts handler.
      const profileUrl = `https://rettfrabonden.com/produsent/${slugify(agentName)}`;
      const dashboardUrl = `https://rettfrabonden.com/admin/dashboard`;
      const subject = `Ny verifisert bruker: ${claimantName} — ${agentName}`;

      const htmlContent = `
        <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #2d5016;">Ny verifisert produsent på Rett fra Bonden</h2>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Produsent:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${this.escapeHtml(agentName)}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Eier:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${this.escapeHtml(claimantName)}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">E-post:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${this.escapeHtml(claimantEmail)}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Kilde:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${this.escapeHtml(source || 'organic')}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold;">Tidspunkt:</td><td style="padding: 8px;">${new Date().toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' })}</td></tr>
          </table>
          <p><a href="${profileUrl}" style="color: #2d5016;">Se produsentprofil →</a></p>
          <p style="color: #888; font-size: 12px;">Automatisk varsling fra Rett fra Bonden</p>
        </div>`;

      const textContent = `Ny verifisert produsent på Rett fra Bonden\n\nProdusent: ${agentName}\nEier: ${claimantName}\nE-post: ${claimantEmail}\nKilde: ${source || 'organic'}\nTidspunkt: ${new Date().toISOString()}\n\nProfil: ${profileUrl}`;

      return await this.sendEmail({
        to: adminEmail,
        subject,
        htmlContent,
        textContent,
      });
    } catch (error) {
      logger.error('Error sending admin claim notification', {
        agentName, claimantEmail,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (char) => map[char]);
  }
}

export const emailService = new EmailService();
