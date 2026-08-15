import nodemailer, { Transporter } from 'nodemailer';
import { slugify } from "../utils/slug";
import { getConfig } from "../config/vertical-config";
// dev-request 2026-07-26-booking-test-send-guard — per-transaction test-mode
// redirect, applied at the single send boundary below so no call site can
// bypass it.
import { applyTestSendRedirect, TestSendNotConfiguredError } from "./send-guard";
import { crmFromHeader } from "./crm-platform-identity";

// Simple logger — replace with winston/pino in production
const logger = {
  info: (msg: string, meta?: any) => console.log(`[Email] ${msg}`, meta ? JSON.stringify(meta) : ""),
  warn: (msg: string, meta?: any) => console.warn(`[Email] ⚠️  ${msg}`, meta ? JSON.stringify(meta) : ""),
  error: (msg: string, meta?: any) => console.error(`[Email] ✗ ${msg}`, meta ? JSON.stringify(meta) : ""),
};

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface EmailOptions {
  to: string;
  subject: string;
  /**
   * Optional since dev-request 2026-08-15-outreach-ab-standard-vs-personlig-
   * drikke: omitted means a genuinely text-only mail (no empty text/html part
   * is ever attached) — the RFB master template's own spam-checklist calls
   * for plain text, and the "personal" outreach variant mirrors it. Every
   * pre-existing caller passes it, unchanged.
   */
  htmlContent?: string;
  textContent: string;
  replyTo?: string;
  listUnsubscribe?: string;
  attachments?: EmailAttachment[];
  /**
   * dev-request 2026-07-26-booking-test-send-guard. When true, this email
   * belongs to a transaction explicitly flagged as a test: it is redirected
   * to TEST_SEND_REDIRECT_EMAIL and visibly marked, and if that address is
   * NOT configured nothing is sent at all (fail-closed — never a fallback to
   * `to`). The flag can only originate from an admin-gated call; it is not
   * part of any public input schema. Omitted/false leaves this method's
   * behaviour bit-for-bit unchanged.
   */
  isTestSend?: boolean;
  /**
   * Full RFC 5322 From header, e.g. `"Opplevagent" <kontakt@rettfrabonden.com>`.
   *
   * Steg 3 of the CRM platform split. A reviewer measured that wiring only
   * sendRaw closed funn 2 on paths where funn 2 was never observed: the booking
   * notice Daniel screenshotted goes through THIS method, and came out as a bare
   * `kontakt@rettfrabonden.com` with no display name at all while carrying
   * Opplevagent content. Omitted keeps the previous behaviour exactly.
   */
  from?: string;
}

export class EmailService {
  private transporter!: Transporter;
  private isConfigured: boolean;

  // ─── Vertical-config accessors (Phase 4.2) ───────────────────────
  // Read display_name + entity_plural_long + support email lazily on
  // each call so different verticals can share a single EmailService
  // instance, and so the constructor doesn't depend on
  // loadConfigsAtBoot() ordering.
  private get brand(): string {
    return getConfig().display_name;
  }
  private get entityPluralLong(): string {
    return getConfig().domain_dictionary.entity_plural_long;
  }
  private get supportEmail(): string {
    return `kontakt@${getConfig().connectors.resend_domain}`;
  }
  // From-address: env override > config-derived. Lazy so loadConfigsAtBoot()
  // can run between module load (where the singleton is constructed) and
  // first sendEmail() call.
  private get fromAddress(): string {
    return process.env.SMTP_FROM || this.supportEmail;
  }

  constructor() {
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

      const subject = `${this.brand} — Vi har funnet deg og dine produkter!`;

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
        replyTo: this.supportEmail,
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
      const subject = `Din bekreftelseskode for ${agentName} på ${this.brand}`;

      const htmlContent = this.generateVerificationCodeHtml(code, agentName);
      const textContent = this.generateVerificationCodeText(code, agentName);

      return await this.sendEmail({
        to: email,
        subject,
        htmlContent,
        textContent,
        replyTo: this.supportEmail,
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
      const subject = `Gratulerer! ${agentName} er nå ditt på ${this.brand}`;

      const htmlContent = this.generateClaimConfirmationHtml(agentName, dashboardUrl);
      const textContent = this.generateClaimConfirmationText(agentName, dashboardUrl);

      return await this.sendEmail({
        to: email,
        subject,
        htmlContent,
        textContent,
        replyTo: this.supportEmail,
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
    // ── Test-send guard (dev-request 2026-07-26-booking-test-send-guard) ──
    // Applied FIRST, ahead of the dry-run short-circuit and every other
    // branch below, so there is no code path on which a test-flagged email
    // reaches its real recipient. Fail-closed: an unconfigured redirect
    // address sends nothing and reports why, rather than falling back to
    // `options.to`. Untouched when isTestSend is absent/false.
    if (options.isTestSend) {
      try {
        const redirected = applyTestSendRedirect({
          to: options.to,
          subject: options.subject,
          htmlContent: options.htmlContent,
          textContent: options.textContent,
        });
        logger.warn('Test-send redirect applied', {
          intendedRecipient: options.to,
          redirectedTo: redirected.to,
          subject: redirected.subject,
        });
        options = { ...options, ...redirected };
      } catch (err) {
        const error =
          err instanceof TestSendNotConfiguredError
            ? err.code
            : err instanceof Error
              ? err.message
              : 'test_send_redirect_failed';
        logger.error('Test-send BLOCKED — nothing sent', {
          intendedRecipient: options.to,
          subject: options.subject,
          error,
        });
        return { success: false, error };
      }
    }

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

      const mailOptions: Record<string, unknown> = {
        from: options.from || this.fromAddress,
        to: options.to,
        subject: options.subject,
        // See EmailOptions.htmlContent — absent means text-only on the wire.
        ...(options.htmlContent !== undefined ? { html: options.htmlContent } : {}),
        text: options.textContent,
        replyTo: options.replyTo,
        headers,
        // Force base64 transfer-encoding to preserve `=` in URLs (e.g. magic-link
        // ?magic=<token>). Default quoted-printable line-wraps long URLs at the
        // `=` boundary, and some receivers decode `=XX` as a single byte before
        // Gmail's plaintext extractor strips the now-invalid char. Verified
        // 2026-05-05 (rfb-supervisor claim-flow E2E test).
        textEncoding: 'base64' as const,
      };
      if (options.attachments?.length) {
        mailOptions.attachments = options.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        }));
      }

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


  /**
   * Phase 5.4a M2 — Send the owner-portal magic-link email.
   *
   * Norwegian Bokmål body that:
   *   - Greets the owner and references the agent name explicitly,
   *   - Explains in one sentence what the link does,
   *   - Includes the verify URL (https://rettfrabonden.com/magic-link-verify?token=...),
   *   - States the 7-day expiry,
   *   - Sends from kontakt@rettfrabonden.com (config-derived).
   */
  async sendOwnerMagicLink(opts: {
    to: string;
    agentName: string;
    verifyUrl: string;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const { to, agentName, verifyUrl } = opts;
    return await this.sendEmail({
      to,
      subject: `Logg inn på eierportalen for ${agentName} — Rett fra Bonden`,
      htmlContent: buildOwnerMagicLinkHtml(agentName, verifyUrl),
      textContent: buildOwnerMagicLinkText(agentName, verifyUrl),
    });
  }

  /**
   * dev-request 2026-07-21-opplevagent-claim-flyt-drikkeprodusenter — the
   * gårdssalg/opplevagent producer-claim magic-link email. REUSES the shape
   * of sendOwnerMagicLink() above (same one-button, 7-day-expiry template
   * structure) but is its OWN method with Opplevagent branding/copy and a
   * kontakt@opplevagent.no reply-to — sendOwnerMagicLink() itself is
   * untouched (still RFB-only, per this dev-request's explicit non-goal of
   * never modifying rettfrabonden.com's existing claim flow). Bypasses the
   * getConfig()-derived brand/supportEmail/fromAddress getters above
   * entirely (those default to the 'rfb' vertical and verticals/experiences/
   * config.yaml's resend_domain is still a stale 'rettfrabonden.com'
   * placeholder — confirmed by reading that file) — same hardcoded-
   * kontakt@opplevagent.no convention every other opplevagent-facing email
   * in this codebase already uses (see src/services/booking-store.ts's
   * replyTo on every gårdssalg booking email).
   */
  async sendGardssalgClaimMagicLink(opts: {
    to: string;
    providerName: string;
    verifyUrl: string;
    /** dev-request 2026-07-26-booking-test-send-guard — see EmailOptions. */
    isTestSend?: boolean;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const { to, providerName, verifyUrl, isTestSend } = opts;
    return await this.sendEmail({
      to,
      subject: `Logg inn på eierportalen for ${providerName} — Opplevagent`,
      htmlContent: buildGardssalgClaimMagicLinkHtml(providerName, verifyUrl),
      textContent: buildGardssalgClaimMagicLinkText(providerName, verifyUrl),
      replyTo: "kontakt@opplevagent.no",
      // Steg 3 / funn 2: this mail carries Opplevagent content, so it must READ
      // as Opplevagent in the inbox list. The address stays rettfrabonden.com —
      // Resend verifies one domain — so the display name is what carries it.
      from: crmFromHeader("experiences"),
      isTestSend,
    });
  }

  /**
   * dev-request 2026-08-07-outreach-pool-krav123-og-pilot, AC4 (pilot
   * send-mechanic). The cold-outreach email for a gårdssalg/opplevagent
   * producer whose profile is already outreach_ready — copy is the
   * dev-request's own "Revidert e-postutkast" (already Daniel-reviewed,
   * no design judgment left to make). Mirrors sendGardssalgClaimMagicLink()
   * just above: kontakt@opplevagent.no reply-to, crmFromHeader("experiences")
   * From (display name carries the Opplevagent brand; the address itself is
   * shared across verticals), isTestSend passed straight through to
   * sendEmail() so the existing send-guard/TEST_SEND_REDIRECT_EMAIL
   * mechanism applies unchanged.
   */
  async sendGardssalgOutreach(
    to: string,
    providerName: string,
    profileUrl: string,
    opts: { isTestSend?: boolean; template?: GardssalgOutreachTemplate } = {},
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    // dev-request 2026-08-15-outreach-ab-standard-vs-personlig-drikke:
    // opts.template selects the rendered draft ("standard" HTML template vs
    // the RFB-style plain-text "personal" variant). Omitted = "standard",
    // byte-identical to the pre-existing behaviour. Sender identity is the
    // SAME for both variants — the draft text is the experiment's only
    // variable.
    const rendered = renderGardssalgOutreachVariant(opts.template ?? "standard", providerName, profileUrl);
    return await this.sendEmail({
      to,
      subject: rendered.subject,
      ...(rendered.html !== undefined ? { htmlContent: rendered.html } : {}),
      textContent: rendered.text,
      replyTo: GARDSSALG_OUTREACH_REPLY_TO,
      from: crmFromHeader("experiences"),
      isTestSend: opts.isTestSend,
    });
  }

  async sendRaw(options: {
    to: string;
    cc?: string;
    subject: string;
    textContent: string;
    htmlContent?: string;
    inReplyToMessageId?: string;
    /**
     * Full RFC 5322 From header, e.g. `"Opplevagent" <kontakt@rettfrabonden.com>`.
     * Steg 3 of the CRM platform split: the ADDRESS is the same for every
     * platform (Resend verifies one domain), so the display name is what
     * carries the brand. Omitted keeps the previous behaviour exactly.
     */
    from?: string;
    /**
     * Where a reply lands. Per-platform, and load-bearing beyond courtesy: it
     * is what makes an inbound reply arrive through the RIGHT forwarder, which
     * is the discriminator steg 4 sorts on.
     */
    replyTo?: string;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured) {
      logger.info('DRY RUN: Would send raw email', { to: options.to, subject: options.subject });
      return { success: true, messageId: 'DRY_RUN' };
    }
    try {
      const headers: Record<string, string> = { 'X-Lokal-Agent': 'crm-system/v1' };
      if (options.inReplyToMessageId) {
        headers['In-Reply-To'] = options.inReplyToMessageId;
        headers['References'] = options.inReplyToMessageId;
      }
      const mailOptions: any = {
        from: options.from || this.fromAddress,
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
        to: options.to,
        subject: options.subject,
        text: options.textContent,
        headers,
        // See sendEmail above — base64 transfer-encoding to preserve URL `=`.
        textEncoding: 'base64',
      };
      if (options.cc) mailOptions.cc = options.cc;
      if (options.htmlContent) mailOptions.html = options.htmlContent;
      const info = await this.transporter.sendMail(mailOptions);
      logger.info('Raw email sent', { to: options.to, subject: options.subject, messageId: info.messageId as string });
      return { success: true, messageId: info.messageId as string };
    } catch (error) {
      logger.error('Failed to send raw email', { to: options.to, error: error instanceof Error ? error.message : String(error) });
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
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
      <div class="logo">🌾 ${this.brand}</div>
    </div>

    <h1>Hei ${this.escapeHtml(sellerName)}!</h1>

    <p>Vi bygger et nettverk for lokale ${this.entityPluralLong} — hvor dine produkter møter mennesker som leter etter akkurat det du har.</p>

    <p><strong>Vi har funnet deg og dine produkter på ${this.brand}, og vi ønsker at du skal eie din egen agent her.</strong></p>

    <div class="info-box">
      <strong>Vi har registrert:</strong>
      <p>${this.escapeHtml(agentName)}</p>
      <p><a href="${this.escapeHtml(agentPageUrl)}" class="agent-link">Se hva som står om deg her →</a></p>
    </div>

    <h2 style="font-size: 16px; margin-top: 25px;">Hva betyr det å "eie" din agent?</h2>
    <p>Du får kontroll over informasjonen som vises — åpningstider, produkter, kontaktdetaljer, og mer. Din agent blir også smartere: over tid lærer den mer om dine produkter og kundenes preferanser, slik at den kan hjelpe deg med å nå riktige folk.</p>

    <p style="font-weight: bold; margin-top: 20px;">Det tar mindre enn 5 minutter. Klikk her:</p>

    <a href="${this.escapeHtml(claimUrl)}" class="cta-button">Krav din agent på ${this.brand}</a>

    <p style="font-size: 14px; color: #666; margin-top: 25px;">Har du spørsmål? Svar på denne e-posten eller kontakt oss på <a href="mailto:${this.supportEmail}" class="footer-link">${this.supportEmail}</a>.</p>

    <div class="footer">
      <p>${this.brand} bygger nettverk hvor norske ${this.entityPluralLong} møter mennesker som verdsetter lokal og god mat.</p>
      <p>
        <a href="${this.escapeHtml(unsubscribeLink)}" class="footer-link">Avslutt abonnement</a>
      </p>
      <p style="margin-top: 15px; color: #999;">${this.brand} | ${getConfig().domain}</p>
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

Vi bygger et nettverk for lokale ${this.entityPluralLong} — hvor dine produkter møter mennesker som leter etter akkurat det du har.

Vi har funnet deg og dine produkter på ${this.brand}, og vi ønsker at du skal eie din egen agent her.

VI HAR REGISTRERT:
${agentName}

Se hva som står om deg her:
${agentPageUrl}

HVA BETYR DET Å "EIE" DIN AGENT?

Du får kontroll over informasjonen som vises — åpningstider, produkter, kontaktdetaljer, og mer. Din agent blir også smartere: over tid lærer den mer om dine produkter og kundenes preferanser, slik at den kan hjelpe deg med å nå riktige folk.

Det tar mindre enn 5 minutter. Klikk her:

${claimUrl}

SPØRSMÅL?

Svar på denne e-posten eller kontakt oss på ${this.supportEmail}

---
${this.brand} bygger nettverk hvor norske ${this.entityPluralLong} møter mennesker som verdsetter lokal og god mat.
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
    <div class="logo">🌾 ${this.brand}</div>
    <h1>Din bekreftelseskode</h1>
    <p>Du ba om å bekrefte at du eier <strong>${this.escapeHtml(agentName)}</strong> på ${this.brand}.</p>
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

Du ba om å bekrefte at du eier ${agentName} på ${this.brand}.

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
    <div class="logo">🌾 ${this.brand}</div>
    <h1>Gratulerer!</h1>
    <div class="success-box">
      <p><strong>${this.escapeHtml(agentName)}</strong> er nå ditt på ${this.brand}.</p>
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

${agentName} er nå ditt på ${this.brand}.

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
      const subject = `Logg inn på ${this.brand}`;

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
    <div class="logo">\u{1F33E} ${this.brand}</div>
    <h1 style="font-size: 20px;">Logg inn</h1>
    <p>Du ba om å logge inn for å administrere <strong>${this.escapeHtml(agentName)}</strong>.</p>
    <p>Klikk knappen under for å logge inn. Lenken er gyldig i 15 minutter.</p>
    <a href="${this.escapeHtml(magicUrl)}" class="cta-button">Logg inn n\u00e5</a>
    <p style="font-size: 13px; color: #666;">Eller kopier denne lenken:</p>
    <p style="font-size: 12px; color: #999; word-break: break-all;">${this.escapeHtml(magicUrl)}</p>
    <div class="footer">
      <p>Hvis du ikke ba om denne lenken, kan du trygt ignorere denne e-posten.</p>
      <p>${this.brand} | ${getConfig().domain}</p>
    </div>
  </div>
</body>
</html>`;

      const textContent = `Logg inn på ${this.brand}

Du ba om å logge inn for å administrere ${agentName}.

Klikk her for å logge inn (gyldig i 15 minutter):
${magicUrl}

Hvis du ikke ba om denne lenken, kan du trygt ignorere denne e-posten.

${this.brand} | ${getConfig().domain}`;

      return await this.sendEmail({
        to: email,
        subject,
        htmlContent,
        textContent,
        replyTo: this.supportEmail,
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
          <h2 style="color: #2d5016;">Ny verifisert produsent på ${this.brand}</h2>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Produsent:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${this.escapeHtml(agentName)}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Eier:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${this.escapeHtml(claimantName)}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">E-post:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${this.escapeHtml(claimantEmail)}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Kilde:</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${this.escapeHtml(source || 'organic')}</td></tr>
            <tr><td style="padding: 8px; font-weight: bold;">Tidspunkt:</td><td style="padding: 8px;">${new Date().toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' })}</td></tr>
          </table>
          <p><a href="${profileUrl}" style="color: #2d5016;">Se produsentprofil →</a></p>
          <p style="color: #888; font-size: 12px;">Automatisk varsling fra ${this.brand}</p>
        </div>`;

      const textContent = `Ny verifisert produsent på ${this.brand}\n\nProdusent: ${agentName}\nEier: ${claimantName}\nE-post: ${claimantEmail}\nKilde: ${source || 'organic'}\nTidspunkt: ${new Date().toISOString()}\n\nProfil: ${profileUrl}`;

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


// ─────────────────────────────────────────────────────────────────
// Phase 5.4a M2 — owner-portal magic-link templates (Norwegian Bokmål)
// ─────────────────────────────────────────────────────────────────

function epEscape(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  } as Record<string, string>)[c]!);
}

function buildOwnerMagicLinkHtml(agentName: string, verifyUrl: string): string {
  const safeName = epEscape(agentName);
  const safeUrl = epEscape(verifyUrl);
  return `<!DOCTYPE html>
<html lang="nb">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 0; }
    .container { background: #ffffff; padding: 40px 20px; }
    .header { margin-bottom: 24px; border-bottom: 3px solid #2D5016; padding-bottom: 16px; }
    .logo { font-size: 22px; font-weight: 700; color: #2D5016; }
    .logo span { color: #D4A373; }
    h1 { font-size: 20px; color: #1a1a1a; margin: 18px 0 14px 0; }
    p { margin: 12px 0; font-size: 15px; line-height: 1.7; }
    .cta-button { display: inline-block; background: #2D5016; color: #ffffff !important; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 700; margin: 18px 0; }
    .cta-button:hover { background: #3a6b1e; }
    .footer { margin-top: 36px; padding-top: 18px; border-top: 1px solid #eee; font-size: 13px; color: #666; }
    code { word-break: break-all; background: #f5f5f5; padding: 4px 6px; display: inline-block; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">Rett fra <span>Bonden</span></div>
    </div>

    <h1>Hei ${safeName}!</h1>

    <p>Klikk lenken under for å logge inn på eierportalen for <strong>${safeName}</strong>.</p>

    <p style="text-align:center;">
      <a href="${safeUrl}" class="cta-button">Logg inn på eierportalen</a>
    </p>

    <p style="font-size: 14px; color: #666;">
      Eller kopier og lim inn denne lenken i nettleseren:
      <br />
      <code>${safeUrl}</code>
    </p>

    <p>Lenken er gyldig i 7 dager.</p>

    <p>Hvis du ikke ba om denne innloggingen, kan du trygt ignorere e-posten.</p>

    <div class="footer">
      <p>Mvh,<br>Rett fra Bonden — kontakt@rettfrabonden.com<br>https://rettfrabonden.com</p>
    </div>
  </div>
</body>
</html>`;
}

function buildOwnerMagicLinkText(agentName: string, verifyUrl: string): string {
  return `Hei ${agentName}!

Klikk lenken under for å logge inn på eierportalen for ${agentName}:

${verifyUrl}

Lenken er gyldig i 7 dager.

Hvis du ikke ba om denne innloggingen, kan du trygt ignorere e-posten.

Mvh,
Rett fra Bonden
kontakt@rettfrabonden.com
https://rettfrabonden.com
`;
}

// ─── Gårdssalg/opplevagent claim magic-link templates (dev-request
// 2026-07-21-opplevagent-claim-flyt-drikkeprodusenter) — Opplevagent-branded
// siblings of buildOwnerMagicLinkHtml/Text above. See
// sendGardssalgClaimMagicLink()'s doc comment for why this is a separate
// method/template rather than a change to the RFB ones. */
function buildGardssalgClaimMagicLinkHtml(providerName: string, verifyUrl: string): string {
  const safeName = epEscape(providerName);
  const safeUrl = epEscape(verifyUrl);
  return `<!DOCTYPE html>
<html lang="nb">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 0; }
    .container { background: #ffffff; padding: 40px 20px; }
    .header { margin-bottom: 24px; border-bottom: 3px solid #0f5a50; padding-bottom: 16px; }
    .logo { font-size: 22px; font-weight: 700; color: #0f5a50; }
    h1 { font-size: 20px; color: #1a1a1a; margin: 18px 0 14px 0; }
    p { margin: 12px 0; font-size: 15px; line-height: 1.7; }
    .cta-button { display: inline-block; background: #0f5a50; color: #ffffff !important; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 700; margin: 18px 0; }
    .cta-button:hover { background: #0e3c36; }
    .footer { margin-top: 36px; padding-top: 18px; border-top: 1px solid #eee; font-size: 13px; color: #666; }
    code { word-break: break-all; background: #f5f5f5; padding: 4px 6px; display: inline-block; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">opplevagent.no</div>
    </div>

    <h1>Hei!</h1>

    <p>Klikk lenken under for å logge inn på eierportalen for <strong>${safeName}</strong> på Opplevagent.</p>

    <p style="text-align:center;">
      <a href="${safeUrl}" class="cta-button">Logg inn på eierportalen</a>
    </p>

    <p style="font-size: 14px; color: #666;">
      Eller kopier og lim inn denne lenken i nettleseren:
      <br />
      <code>${safeUrl}</code>
    </p>

    <p>Lenken er gyldig i 7 dager.</p>

    <p>Hvis du ikke ba om denne innloggingen, kan du trygt ignorere e-posten.</p>

    <div class="footer">
      <p>Mvh,<br>Opplevagent — kontakt@opplevagent.no<br>https://opplevagent.no</p>
    </div>
  </div>
</body>
</html>`;
}

function buildGardssalgClaimMagicLinkText(providerName: string, verifyUrl: string): string {
  return `Hei!

Klikk lenken under for å logge inn på eierportalen for ${providerName} på Opplevagent:

${verifyUrl}

Lenken er gyldig i 7 dager.

Hvis du ikke ba om denne innloggingen, kan du trygt ignorere e-posten.

Mvh,
Opplevagent
kontakt@opplevagent.no
https://opplevagent.no
`;
}

// ─── Gårdssalg/opplevagent cold-outreach templates (dev-request
// 2026-08-07-outreach-pool-krav123-og-pilot, AC4/AC6) — the "Revidert
// e-postutkast" from that dev-request, translated verbatim: Markdown -> HTML
// for the HTML version, plain text for the text version. [Produsentnavn] ->
// providerName, [profil-lenke] -> profileUrl. No other copy changes — the
// text itself was already reviewed/revised (statistikk-løftet + avsender-
// identitet fixes) in that dev-request, not re-derived here. See
// sendGardssalgOutreach()'s doc comment for why this is its own template
// rather than reusing buildGardssalgClaimMagicLinkHtml/Text above (different
// email entirely — cold outreach, not a magic-link login).
/** Where a producer's reply to the outreach mail lands. Exported so the CRM
 *  record of a send can name the same address the recipient actually sees. */
export const GARDSSALG_OUTREACH_REPLY_TO = "kontakt@opplevagent.no";

/**
 * The rendered gårdssalg outreach mail — subject + both body parts, exactly as
 * sendGardssalgOutreach() will put them on the wire.
 *
 * dev-request 2026-08-09-outreach-send-uten-crm-spor: the pilot-send route has
 * to file what it sent into the CRM, and a second hand-written copy of the copy
 * would drift from the real template the first time either changed. So the
 * renderer is the single source of truth and both callers go through it — the
 * sender to send it, the route to record it.
 */
export function renderGardssalgOutreach(
  providerName: string,
  profileUrl: string,
): { subject: string; text: string; html: string } {
  return {
    // Daniel, live session 2026-08-14. The previous subject was
    // «${providerName} har fått en profil på Opplevagent — vil dere se over den?»
    //
    // It ANNOUNCES something done to the recipient by a sender they have never
    // heard of, and «har fått en profil» reads to some as having been signed up
    // for something. The RFB campaign — same From address, same domain, same
    // DKIM, same Resend infrastructure — instead asks a question («Har vi info
    // riktig om X?») and got 9 replies from 64 sends over the same 14-day
    // window (14%), against Opplevagent's 1 of 24 (4%). Same plumbing, 3-4x the
    // reply rate, so the difference is the approach, not deliverability.
    //
    // This borrows that formula: a short question that asks a small favour and
    // presumes nothing. Changed as the ONLY variable on the next batch, so any
    // movement is attributable — see the copy assessment of 2026-08-14.
    subject: `Stemmer det vi har om ${providerName}?`,
    text: buildGardssalgOutreachText(providerName, profileUrl),
    html: buildGardssalgOutreachHtml(providerName, profileUrl),
  };
}

function buildGardssalgOutreachHtml(providerName: string, profileUrl: string): string {
  const safeName = epEscape(providerName);
  const safeUrl = epEscape(profileUrl);
  // Every style is INLINE, and there is deliberately no <style> block.
  // 2026-08-08: a <style>-block version of this template was observed in a
  // real inbox with the whole CSS rule-set rendered as visible body text (the
  // tags had been stripped upstream, the text content had not). Inline
  // attributes cannot fail that way — if they are dropped, the mail degrades
  // to unstyled but READABLE text, never to CSS-as-prose. Same reason the
  // signature below uses separate <p> elements rather than <br>: a stripped
  // <br> silently glues "Rett fra Bonden" onto the address on the next line.
  const P = `margin:0 0 14px;font-size:15px;line-height:1.7;color:#333`;
  return `<!DOCTYPE html>
<html lang="nb">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',sans-serif;color:#333">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px;background:#ffffff">
    <div style="margin-bottom:24px;border-bottom:3px solid #0f5a50;padding-bottom:16px">
      <span style="font-size:22px;font-weight:700;color:#0f5a50">opplevagent.no</span>
    </div>

    <p style="${P}">Hei,</p>

    <p style="${P}"><strong>${safeName}</strong> har fått en profil på Opplevagent, bygget på offentlige kilder &mdash; Brønnøysundregistrene og deres egen nettside. Jeg vil gjerne at dere ser over den: <a href="${safeUrl}" style="color:#0f5a50">${safeUrl}</a></p>

    <p style="${P}">Grunnen til at jeg tar kontakt nå: regjeringens forslag om utvidet gårdssalg av alkohol er på høring med frist 5. september. Slik forslaget er formulert, skal salget knyttes til et betalt besøk med faglig innhold &mdash; omvisning, smaking eller foredrag. Blir det vedtatt, blir det å ta imot besøk en praktisk forutsetning for salg, ikke bare et hyggelig tillegg.</p>

    <p style="${P}">Kort om meg: jeg har bygget rettfrabonden.com, en katalog over norske matprodusenter laget for at AI-assistenter som ChatGPT og Claude skal kunne hente informasjon derfra og gi den videre til folk som spør. Mange produsenter har overtatt profilen sin der og fylt den ut selv. Opplevagent er det samme for opplevelser, og jeg har begynt med drikkeprodusenter.</p>

    <p style="${P}">Tre ting dere kan gjøre &mdash; alt er gratis:</p>
    <ol style="margin:0 0 14px;padding-left:22px;font-size:15px;line-height:1.7;color:#333">
      <li style="margin:8px 0"><strong>Se over profilen.</strong> Stemmer beskrivelsen og produktene? Si fra, så retter jeg.</li>
      <li style="margin:8px 0"><strong>Overta profilen.</strong> Da styrer dere innholdet selv, og ser hvor ofte profilen blir besøkt &mdash; inkludert hvor stor del av trafikken som kommer fra AI-assistenter.</li>
      <li style="margin:8px 0"><strong>Ta imot besøk.</strong> Hver profil har et påmeldingssystem dere kan velge å skru på. Gjesten melder seg på, dere bekrefter hver påmelding selv.</li>
    </ol>

    <p style="${P}">Slik det fungerer i dag, henter AI-assistenter informasjon herfra og gir den videre til den som spør. På sikt er målet at profilen deres skal kunne svare gjestens assistent direkte. Mer om hvordan det henger sammen: <a href="https://opplevagent.no/slik-fungerer-det" style="color:#0f5a50">opplevagent.no/slik-fungerer-det</a></p>

    <p style="${P}">Dette er et prosjekt under utvikling, så ting vil endre seg underveis &mdash; jeg setter stor pris på tilbakemeldinger. Vil dere ikke stå oppført, si fra, så fjerner jeg profilen med en gang.</p>

    <div style="margin-top:36px;padding-top:18px;border-top:1px solid #eee">
      <p style="margin:0;font-size:13px;line-height:1.6;color:#666">Med vennlig hilsen</p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#666">Daniel Fredriksen</p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#666">Opplevagent</p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#666"><a href="mailto:kontakt@opplevagent.no" style="color:#0f5a50">kontakt@opplevagent.no</a></p>
    </div>
  </div>
</body>
</html>`;
}

function buildGardssalgOutreachText(providerName: string, profileUrl: string): string {
  return `Hei,

${providerName} har fått en profil på Opplevagent, bygget på offentlige kilder —
Brønnøysundregistrene og deres egen nettside. Jeg vil gjerne at dere ser over den:
${profileUrl}

Grunnen til at jeg tar kontakt nå: regjeringens forslag om utvidet gårdssalg av
alkohol er på høring med frist 5. september. Slik forslaget er formulert, skal
salget knyttes til et betalt besøk med faglig innhold — omvisning, smaking eller
foredrag. Blir det vedtatt, blir det å ta imot besøk en praktisk forutsetning for
salg, ikke bare et hyggelig tillegg.

Kort om meg: jeg har bygget rettfrabonden.com, en katalog over norske
matprodusenter laget for at AI-assistenter som ChatGPT og Claude skal kunne hente
informasjon derfra og gi den videre til folk som spør. Mange produsenter har
overtatt profilen sin der og fylt den ut selv. Opplevagent er det samme for
opplevelser, og jeg har begynt med drikkeprodusenter.

Tre ting dere kan gjøre — alt er gratis:
1. Se over profilen. Stemmer beskrivelsen og produktene? Si fra, så retter jeg.
2. Overta profilen. Da styrer dere innholdet selv, og ser hvor ofte profilen blir
   besøkt — inkludert hvor stor del av trafikken som kommer fra AI-assistenter.
3. Ta imot besøk. Hver profil har et påmeldingssystem dere kan velge å skru på.
   Gjesten melder seg på, dere bekrefter hver påmelding selv.

Slik det fungerer i dag, henter AI-assistenter informasjon herfra og gir den videre
til den som spør. På sikt er målet at profilen deres skal kunne svare gjestens
assistent direkte. Mer om hvordan det henger sammen:
https://opplevagent.no/slik-fungerer-det

Dette er et prosjekt under utvikling, så ting vil endre seg underveis — jeg setter
stor pris på tilbakemeldinger. Vil dere ikke stå oppført, si fra, så fjerner jeg
profilen med en gang.

Med vennlig hilsen
Daniel Fredriksen
Opplevagent
kontakt@opplevagent.no
`;
}

// ─── Gårdssalg outreach: template variants (dev-request 2026-08-15-outreach-
// ab-standard-vs-personlig-drikke) ───────────────────────────────────────────
//
// Daniel's A/B for the 2026-08-16 batch: 8 sends on the existing "standard"
// draft above vs. 8 on a "personal" draft that mirrors the RFB master
// template (A2A verticals/rfb/email-templates/outreach-v2.md) adapted for
// drink producers on Opplevagent. The two arms are attributable in every log
// by SUBJECT alone: standard asks «Stemmer det vi har om …?», personal asks
// «Har vi info riktig om …?» (the RFB formula).
//
// The personal variant is deliberately TEXT-ONLY (html: undefined) — the RFB
// template's spam-checklist specifies plain text, and matching its wire
// format is part of matching the draft. Signature is the PLATFORM address
// (kontakt@opplevagent.no), never the personal gmail the RFB template used
// to carry (removed 2026-08-15, Daniel live) — and never the RFB identity:
// the draft STYLE is borrowed, the platform separation is not.
export type GardssalgOutreachTemplate = "standard" | "personal";

export function renderGardssalgOutreachPersonal(
  providerName: string,
  profileUrl: string,
): { subject: string; text: string; html?: string } {
  return {
    subject: `Har vi info riktig om ${providerName}?`,
    text: `Hei,

Jeg har laget en profil for ${providerName} som del av en åpen katalog
over norske drikkeprodusenter og gårdsopplevelser. Du finner den her:

${profileUrl}

Bakgrunnen: AI-assistenter (typ ChatGPT, Claude) svarer i økende grad
direkte på spørsmål som «hvilke bryggerier kan jeg besøke i Telemark».
Norske produsenter forsvinner ofte i svarene fordi info-en deres ligger
spredt. Vi samler det på ett sted, og holder profilene oppdaterte.

Det koster ingenting og dere er ikke bundet til noe. Jeg ville bare
sjekke at info stemmer, og at dere er OK med å være synlige der.

Si fra om noe må endres — eller om dere helst fjernes. Begge deler
ordnes innen 24 timer.

Mvh,
Daniel Fredriksen
Opplevagent
kontakt@opplevagent.no

(Svar «fjern», så fjerner jeg profilen med en gang.)
`,
  };
}

/**
 * The one variant dispatcher both the send path and the CRM-filing path go
 * through (same single-source rule as renderGardssalgOutreach itself, per
 * dev-request 2026-08-09-outreach-send-uten-crm-spor): what left the wire is
 * what gets filed, for either arm.
 */
export function renderGardssalgOutreachVariant(
  template: GardssalgOutreachTemplate,
  providerName: string,
  profileUrl: string,
): { subject: string; text: string; html?: string } {
  return template === "personal"
    ? renderGardssalgOutreachPersonal(providerName, profileUrl)
    : renderGardssalgOutreach(providerName, profileUrl);
}

export const emailService = new EmailService();
