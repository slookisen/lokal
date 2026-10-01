// ─── POST /webhooks/inbound-email handler ────────────────────────────────
// dev-request 2026-10-01-rfb-eierkrav-utelates-fra-outreach (spec item 5).
// Resend posts here when someone mails *@rettfrabonden.com; we forward it to
// the admin inbox. Incident 2026-10-01: one reply was forwarded 3 times
// because the handler fetched the body from Resend (no timeout) and forwarded
// BEFORE answering 200, so Resend re-delivered the webhook.
//
// Now: (1) email_id is claimed in inbound_email_seen (PRIMARY KEY) — a repeat
// id answers 200 and forwards nothing; (2) the 200 is sent as soon as the id is
// claimed, fetch + forward happen afterwards; (3) the Resend fetch has a
// timeout. A payload without an email_id cannot be deduped and is still
// forwarded (fail-open: better a duplicate than a lost customer e-mail).

import type { Request, Response } from "express";
import { getDb } from "../database/init";
import { emailService } from "./email-service";

export const INBOUND_FETCH_TIMEOUT_MS = 8000;

export interface InboundEmailDeps {
  fetchImpl?: typeof fetch;
  sendEmail?: (opts: Parameters<typeof emailService.sendEmail>[0]) => Promise<unknown>;
  timeoutMs?: number;
}

/** True when this email_id was already seen (and records it otherwise). */
export function claimInboundEmailId(emailId: string): "new" | "duplicate" {
  const r = getDb()
    .prepare("INSERT OR IGNORE INTO inbound_email_seen (email_id) VALUES (?)")
    .run(emailId);
  return r.changes === 1 ? "new" : "duplicate";
}

/** Express handler; the returned promise resolves after forwarding (tests await it). */
export async function handleInboundEmailWebhook(req: Request, res: Response, deps: InboundEmailDeps = {}): Promise<void> {
  let responded = false;
  const respond = () => {
    if (!responded) {
      responded = true;
      res.status(200).json({ received: true });
    }
  };
  try {
    const payload = req.body || {};
    console.log(`[Inbound] Raw payload: ${JSON.stringify(payload).substring(0, 2000)}`);

    const data = payload.data || payload; // fallback for direct test calls
    const from = data.from || payload.from || "unknown";
    const to = data.to || payload.to || [];
    const subject = data.subject || payload.subject || "(ingen emne)";
    const emailId = data.email_id || payload.email_id;

    console.log(`[Inbound] Event: ${payload.type || "unknown"}, email_id: ${emailId}, from: ${from}, subject: "${subject}"`);

    if (typeof emailId === "string" && emailId) {
      let verdict: "new" | "duplicate";
      try {
        verdict = claimInboundEmailId(emailId);
      } catch (dedupeErr) {
        console.warn("[Inbound] dedupe check failed, forwarding anyway:", dedupeErr);
        verdict = "new";
      }
      if (verdict === "duplicate") {
        console.log(`[Inbound] Duplicate email_id ${emailId} — not forwarding again`);
        respond();
        return;
      }
    }

    // Answer Resend now; the slow work follows.
    respond();

    let html = "";
    let text = "";
    const resendKey = process.env.RESEND_API_KEY;
    const fetchImpl = deps.fetchImpl ?? fetch;

    if (emailId && resendKey) {
      try {
        const emailRes = await fetchImpl(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: { Authorization: `Bearer ${resendKey}` },
          signal: AbortSignal.timeout(deps.timeoutMs ?? INBOUND_FETCH_TIMEOUT_MS),
        });
        if (emailRes.ok) {
          const emailData = (await emailRes.json()) as { html?: string; text?: string };
          html = emailData.html || "";
          text = emailData.text || "";
          console.log(`[Inbound] Fetched body for ${emailId} (${html.length} chars HTML, ${text.length} chars text)`);
        } else {
          console.warn(`[Inbound] Could not fetch email body: ${emailRes.status} ${emailRes.statusText}`);
        }
      } catch (fetchErr) {
        console.warn(`[Inbound] Error fetching email body:`, fetchErr);
      }
    } else if (!resendKey) {
      console.warn(`[Inbound] RESEND_API_KEY not set — cannot fetch email body`);
    }

    // Sender email for reply-to (format: "Name <email@domain.com>")
    const senderEmail = typeof from === "string" ? (from.match(/<([^>]+)>/)?.[1] || from) : undefined;

    const forwardTo = process.env.ADMIN_EMAIL || "da.fredriksen@gmail.com";
    const bodyHtml = html || (text ? `<pre>${text}</pre>` : `<p><em>Ingen innhold i eposten.</em></p>`);
    const bodyText = text || "(ingen tekstinnhold)";

    const send = deps.sendEmail ?? ((o) => emailService.sendEmail(o));
    const forwarded = await send({
      to: forwardTo,
      subject: `[Innkommende] ${subject} (fra ${from})`,
      htmlContent: `
        <div style="border-bottom:1px solid #ccc;padding-bottom:8px;margin-bottom:16px;color:#666;font-size:13px;">
          <strong>Fra:</strong> ${from}<br>
          <strong>Til:</strong> ${Array.isArray(to) ? to.join(", ") : to}<br>
          <strong>Emne:</strong> ${subject}
        </div>
        ${bodyHtml}
      `,
      textContent: `Videresent fra: ${from}\nTil: ${Array.isArray(to) ? to.join(", ") : to}\nEmne: ${subject}\n\n${bodyText}`,
      replyTo: senderEmail,
    });

    if (forwarded) {
      console.log(`[Inbound] Forwarded to ${forwardTo}`);
    } else {
      console.warn(`[Inbound] Forward failed — email service not configured or send failed`);
    }
  } catch (err) {
    console.error("[Inbound] Webhook error:", err);
  } finally {
    respond(); // always 200 so Resend doesn't retry
  }
}
