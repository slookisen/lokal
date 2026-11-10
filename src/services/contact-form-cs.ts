// ─── CS på serveren, S5: kontaktskjema ───────────────────────────────────
// dev-request 2026-11-10-cs-paa-serveren (slookisen/A2A), skive S5.
//
//   • countContactRejection — a rejected submission (honeypot, Turnstile,
//     rate limit) is counted per day / platform / reason. No personal data.
//   • sendContactReceipt — an automatic receipt from a FIXED template, at most
//     one per address per 24 h (CS_CONTACT_RECEIPT_ENABLED). The visitor's
//     name and text are never echoed: the form is public, and a receipt that
//     repeated arbitrary input would turn it into a relay for spam to any
//     address someone types in.
//   • A form thread (id `kontakt-…`) is its own source. The address in the
//     form is unverified: a reply may go there (S2), but a change, ownership
//     claim or removal is never executed on the strength of the form alone
//     (S4 sends such requests to the approval queue).

import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { emailService } from "./email-service";
import { crmFromHeader, resolveCrmIdentity } from "./crm-platform-identity";
import { plainTextToEmailHtml } from "../utils/plain-text-to-html";

export type ContactPlatform = "rfb" | "experiences" | "dental";
export type ContactRejectionReason = "honeypot" | "captcha_failed" | "rate_limit" | "invalid_input";

export const CS_CONTACT_RECEIPT_FLAG = "CS_CONTACT_RECEIPT_ENABLED";
export function contactReceiptEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[CS_CONTACT_RECEIPT_FLAG];
  return v === "1" || v === "true";
}

/** True for a thread created by the public contact form. */
export function isContactFormThread(threadId: string | null | undefined): boolean {
  return typeof threadId === "string" && threadId.startsWith("kontakt-");
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function countContactRejection(platform: ContactPlatform, reason: ContactRejectionReason, now: Date = new Date()): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO contact_form_rejections (day, platform, reason, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(day, platform, reason) DO UPDATE SET count = count + 1`,
      )
      .run(utcDay(now), platform, reason);
  } catch (e) {
    // Counting must never break the form.
    console.error("[contact] could not count a rejected submission:", e);
  }
}

export function contactRejectionsSince(sinceIso: string): Array<{ platform: string; reason: string; n: number }> {
  try {
    return getDb()
      .prepare(
        `SELECT platform, reason, SUM(count) AS n FROM contact_form_rejections
          WHERE day >= ? GROUP BY platform, reason ORDER BY platform, reason`,
      )
      .all(sinceIso.slice(0, 10)) as Array<{ platform: string; reason: string; n: number }>;
  } catch {
    return [];
  }
}

const PLATFORM_NAME: Record<ContactPlatform, string> = {
  rfb: "Rett fra Bonden",
  experiences: "Opplevagent",
  dental: "Finn tannlege",
};

export function receiptTemplate(platform: ContactPlatform): { subject: string; text: string } {
  const name = PLATFORM_NAME[platform];
  return {
    subject: `Vi har mottatt henvendelsen din – ${name}`,
    text:
      `Hei,\n\n` +
      `takk for at du tok kontakt med ${name}. Vi har mottatt meldingen din og svarer deg så snart vi kan, ` +
      `vanligvis innen én virkedag.\n\n` +
      `Dette er en automatisk bekreftelse. Du trenger ikke svare på den.\n\n` +
      `Vennlig hilsen\n${name}`,
  };
}

export type ReceiptOutcome = "sent" | "disabled" | "already_sent_24h" | "dry_run" | "failed";

/**
 * Send the receipt for one form submission. Never throws. Records the
 * outcome (contact_form_receipts + a crm_actions row on the thread) — the
 * receipt is NOT a crm_messages row, so it never makes the thread look
 * answered in «trenger svar».
 */
export async function sendContactReceipt(
  input: { email: string; platform: ContactPlatform; threadId: string; contactId?: string | null },
  deps: { env?: NodeJS.ProcessEnv; now?: Date; sendRaw?: (o: Parameters<typeof emailService.sendRaw>[0]) => Promise<{ success: boolean; messageId?: string; error?: string }>; liveTransport?: boolean } = {},
): Promise<ReceiptOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  if (!contactReceiptEnabled(env)) return "disabled";
  const db = getDb();
  let outcome: ReceiptOutcome;
  let detail: string | null = null;
  try {
    const recent = db
      .prepare(
        `SELECT 1 FROM contact_form_receipts
          WHERE email = ? AND outcome = 'sent' AND julianday(sent_at) >= julianday(?) - 1 LIMIT 1`,
      )
      .get(email, now.toISOString());
    if (recent) {
      outcome = "already_sent_24h";
    } else if (!(deps.liveTransport ?? emailService.isLiveTransport())) {
      outcome = "dry_run";
    } else {
      const t = receiptTemplate(input.platform);
      const identity = resolveCrmIdentity(input.platform);
      const send = deps.sendRaw ?? ((o) => emailService.sendRaw(o));
      const r = await send({
        to: email,
        subject: t.subject,
        textContent: t.text,
        htmlContent: plainTextToEmailHtml(t.text),
        from: crmFromHeader(input.platform),
        replyTo: identity.replyTo,
      });
      outcome = r.success ? "sent" : "failed";
      if (!r.success) detail = r.error ?? "send failed";
    }
  } catch (e: any) {
    outcome = "failed";
    detail = String(e?.message ?? e);
  }
  try {
    db.prepare(`INSERT INTO contact_form_receipts (email, platform, thread_id, outcome, sent_at) VALUES (?, ?, ?, ?, ?)`).run(
      email,
      input.platform,
      input.threadId,
      outcome,
      now.toISOString(),
    );
    db.prepare(`INSERT INTO crm_actions (id, thread_id, contact_id, type, actor, payload) VALUES (?, ?, ?, ?, 'system', ?)`).run(
      randomUUID(),
      input.threadId,
      input.contactId ?? null,
      outcome === "sent" ? "receipt_sent" : "receipt_not_sent",
      JSON.stringify({ outcome, detail }),
    );
  } catch (e) {
    console.error("[contact] could not record the receipt outcome:", e);
  }
  if (outcome === "failed") console.error(`[contact] receipt for thread ${input.threadId} failed: ${detail}`);
  return outcome;
}
