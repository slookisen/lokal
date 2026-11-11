// ─── POST /webhooks/inbound-email handler ────────────────────────────────
// dev-request 2026-10-01-rfb-eierkrav-utelates-fra-outreach (spec item 5).
// Resend posts here when someone mails one of our domains; we forward it to
// the admin inbox. Incident 2026-10-01: one reply was forwarded 3 times
// because the handler fetched the body from Resend (no timeout) and forwarded
// BEFORE answering 200, so Resend re-delivered the webhook.
//
// Now: (1) email_id is claimed in inbound_email_seen (PRIMARY KEY) — a repeat
// id answers 200 and forwards nothing; (2) the 200 is sent as soon as the id is
// claimed, fetch + forward happen afterwards; (3) the Resend fetch has a
// timeout. A payload without an email_id cannot be deduped and is still
// forwarded (fail-open: better a duplicate than a lost customer e-mail).
//
// CS på serveren, S1a (dev-request 2026-11-10-cs-paa-serveren):
//   • Every accepted e-mail gets an inbound_email_log row (from/to/subject,
//     platform, CRM outcome, forward outcome).
//   • BUG FIX: the forward result is an object {success,…}; the old
//     `if (forwarded)` was always true, so a failed forward was logged as
//     success and — the id already claimed — never retried. Now a failed
//     forward is recorded (forward_status 'failed' + the mail kept in
//     forward_payload) for the retry job and the watchdog.
//   • The forward carries an "Inbound-ID: inb-…" marker so the CS agent's
//     Gmail copy is recognised by /admin/crm/ingest (no duplicate thread).
//   • With CS_INBOUND_SERVER_INGEST_ENABLED on, the e-mail is registered in
//     the CRM by the server itself (cs-inbound.registerInboundInCrm), on the
//     platform its recipient domain names. Off = log + forward only.
//
// Pilot inbox (pilot@rettfrabonden.com, a hidden test producer's contact
// address): mail to it — also the platform's own magic-link mails — still
// gets a log row and reaches ADMIN_EMAIL, but is NEVER registered in the CRM
// (crm_status 'pilot_skipped') and is forwarded as «[Pilot] <subject>» with
// NO Inbound-ID marker, so the CS pipeline (FORWARD_SUBJECT_RE / marker
// ingest) cannot recognise or process it.

import type { Request, Response } from "express";
import { getDb } from "../database/init";
import { emailService } from "./email-service";
import {
  addressesOf,
  classifyAutomated,
  csInboundServerIngestEnabled,
  deriveInboundVertical,
  htmlToPlainText,
  inboundMarkerLine,
  insertInboundLog,
  isOurPlatformAddress,
  newInboundLogId,
  readInboundHeaders,
  registerInboundInCrm,
  updateInboundLog,
} from "./cs-inbound";

export const INBOUND_FETCH_TIMEOUT_MS = 8000;

/** Inbox addresses whose mail bypasses the CRM and the CS pipeline. */
export const PILOT_INBOX_ADDRESSES: readonly string[] = ["pilot@rettfrabonden.com"];

/** Bare, lowercased address of a recipient entry ("Name <a@b>" or "a@b"). */
function normalizeRecipient(v: string): string {
  return (v.match(/<([^>]+)>/)?.[1] ?? v).trim().toLowerCase();
}

/** True when any To or Cc recipient is a pilot inbox (case-insensitive, bare address). */
export function isPilotInboundMail(toEmails: readonly string[], ccEmails: readonly string[]): boolean {
  const pilot = new Set(PILOT_INBOX_ADDRESSES.map(normalizeRecipient));
  return [...toEmails, ...ccEmails].some((a) => typeof a === "string" && pilot.has(normalizeRecipient(a)));
}

const PILOT_FORWARD_SUBJECT_RE = /^\s*\[Pilot\]/i;
const REPLY_FORWARD_PREFIX_RE = /^\s*(?:(?:re|sv|aw|fw|fwd|vs|vb)\s*:\s*)+/i;

/** True when `email` is the address our forwards are sent from (a platform domain, or SMTP_FROM). */
function isOurForwardSender(email: string | null | undefined): boolean {
  if (typeof email !== "string" || !email.trim()) return false;
  if (isOurPlatformAddress(email)) return true;
  const smtpFrom = process.env.SMTP_FROM;
  return !!smtpFrom && normalizeRecipient(smtpFrom) === normalizeRecipient(email);
}

/**
 * True when `m` is a «[Pilot] …» forward copy (it may hold a magic-link token)
 * as the CS routine sees it in Gmail: sent from one of our own addresses, with
 * a subject — after any Re:/SV:/Fwd:/VS: prefixes — starting with «[Pilot]».
 * The Gmail thread subject stands in only when the message carries none.
 * /admin/crm/ingest drops such messages before anything is written.
 */
export function isPilotForwardCopy(
  m: { fromEmail?: string | null; subject?: string | null },
  threadSubject?: string | null,
): boolean {
  if (!isOurForwardSender(m.fromEmail)) return false;
  const subject = m.subject ?? threadSubject ?? "";
  return PILOT_FORWARD_SUBJECT_RE.test(subject.replace(REPLY_FORWARD_PREFIX_RE, ""));
}

export interface InboundEmailDeps {
  fetchImpl?: typeof fetch;
  sendEmail?: (opts: Parameters<typeof emailService.sendEmail>[0]) => Promise<unknown>;
  timeoutMs?: number;
  /** Test seam: overrides CS_INBOUND_SERVER_INGEST_ENABLED. */
  serverIngest?: boolean;
}

/** True when this email_id was already seen (and records it otherwise). */
export function claimInboundEmailId(emailId: string): "new" | "duplicate" {
  const r = getDb()
    .prepare("INSERT OR IGNORE INTO inbound_email_seen (email_id) VALUES (?)")
    .run(emailId);
  return r.changes === 1 ? "new" : "duplicate";
}

/** A send result counts as delivered to the relay only when it says success: true. */
export function forwardSucceeded(result: unknown): boolean {
  return !!result && typeof result === "object" && (result as { success?: unknown }).success === true;
}

function bareAddress(from: unknown): string {
  if (typeof from !== "string") return "unknown";
  return (from.match(/<([^>]+)>/)?.[1] || from).trim();
}

function displayName(from: unknown): string | null {
  if (typeof from !== "string") return null;
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  const n = m?.[1]?.trim();
  return n ? n : null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  let logId: string | null = null;
  try {
    const payload = req.body || {};
    console.log(`[Inbound] Raw payload: ${JSON.stringify(payload).substring(0, 2000)}`);

    const data = payload.data || payload; // fallback for direct test calls
    const from = data.from || payload.from || "unknown";
    const to = data.to || payload.to || [];
    const cc = data.cc || payload.cc || [];
    const subject = data.subject || payload.subject || "(ingen emne)";
    const emailId = data.email_id || payload.email_id;
    const createdAt: string | null =
      typeof data.created_at === "string" ? data.created_at : typeof payload.created_at === "string" ? payload.created_at : null;

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

    const fromEmail = bareAddress(from).toLowerCase();
    const toEmails = addressesOf(to);
    const ccEmails = addressesOf(cc);
    const pilot = isPilotInboundMail(toEmails, ccEmails);

    // Log row first (synchronous): from here on the e-mail cannot vanish
    // without a trace, whatever fails below.
    try {
      const id = newInboundLogId();
      insertInboundLog({
        id,
        emailId: typeof emailId === "string" && emailId ? emailId : null,
        fromEmail,
        toEmails,
        ccEmails,
        subject: typeof subject === "string" ? subject : null,
      });
      logId = id;
    } catch (logErr) {
      console.error("[Inbound] could not write inbound_email_log:", logErr);
    }

    // Answer Resend now; the slow work follows.
    respond();

    let html = "";
    let text = "";
    let fetched: unknown = null;
    let bodyFetch: "ok" | "failed" | "skipped" = "skipped";
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
          fetched = emailData;
          html = emailData.html || "";
          text = emailData.text || "";
          bodyFetch = "ok";
          console.log(`[Inbound] Fetched body for ${emailId} (${html.length} chars HTML, ${text.length} chars text)`);
        } else {
          bodyFetch = "failed";
          console.warn(`[Inbound] Could not fetch email body: ${emailRes.status} ${emailRes.statusText}`);
        }
      } catch (fetchErr) {
        bodyFetch = "failed";
        console.warn(`[Inbound] Error fetching email body:`, fetchErr);
      }
    } else if (!resendKey) {
      console.warn(`[Inbound] RESEND_API_KEY not set — cannot fetch email body`);
    }

    // ── CRM registration (S1a) ──────────────────────────────────────
    const headers = readInboundHeaders(data, fetched);
    const automated = classifyAutomated({ subject, fromEmail, headers });
    const routing = deriveInboundVertical([...toEmails, ...ccEmails]);
    if (logId) {
      try {
        updateInboundLog(logId, {
          rfc_message_id: headers.messageId,
          in_reply_to: headers.inReplyTo.length ? headers.inReplyTo.join(" ") : null,
          vertical: routing.vertical,
          automated_kind: automated.kind,
          body_fetch: bodyFetch,
        });
      } catch (e) {
        console.error("[Inbound] log update failed:", e);
      }
      const serverIngest = deps.serverIngest ?? csInboundServerIngestEnabled();
      if (pilot) {
        try { updateInboundLog(logId, { crm_status: "pilot_skipped" }); } catch { /* logged above */ }
        console.log(`[Inbound] Pilot inbox mail — not registered in CRM`);
      } else if (!serverIngest) {
        try { updateInboundLog(logId, { crm_status: "disabled" }); } catch { /* logged above */ }
      } else {
        try {
          const reg = registerInboundInCrm({
            logId,
            emailId: typeof emailId === "string" && emailId ? emailId : null,
            fromEmail,
            fromName: displayName(from),
            toEmails,
            ccEmails,
            subject: typeof subject === "string" ? subject : null,
            bodyText: text || (html ? htmlToPlainText(html) : null),
            bodyHtml: html || null,
            sentAt: createdAt,
            headers,
          });
          if (reg.status === "registered") {
            updateInboundLog(logId, { crm_status: "registered", crm_thread_id: reg.threadId, crm_linked_by: reg.linkedBy });
            console.log(
              `[Inbound] Registered in CRM: thread ${reg.threadId} (${reg.vertical}, linkedBy=${reg.linkedBy ?? "new"}, ` +
                `reopened=${reg.reopened}, automated=${reg.automated ?? "no"})`,
            );
          } else {
            updateInboundLog(logId, { crm_status: "untriaged", crm_error: reg.reason });
            console.log(`[Inbound] Parked as untriaged ${reg.untriagedId}: ${reg.reason}`);
          }
        } catch (regErr: any) {
          console.error("[Inbound] CRM registration failed:", regErr);
          try { updateInboundLog(logId, { crm_status: "error", crm_error: String(regErr?.message ?? regErr).slice(0, 500) }); } catch { /* nothing more to do */ }
        }
      }
    }

    // ── Forward to the admin inbox ─────────────────────────────────
    // Sender email for reply-to (format: "Name <email@domain.com>")
    const senderEmail = typeof from === "string" ? (from.match(/<([^>]+)>/)?.[1] || from) : undefined;

    const forwardTo = process.env.ADMIN_EMAIL || "da.fredriksen@gmail.com";
    const bodyHtml = html || (text ? `<pre>${escapeHtml(text)}</pre>` : `<p><em>Ingen innhold i eposten.</em></p>`);
    const bodyText = text || "(ingen tekstinnhold)";
    // Pilot mail: no marker anywhere, so no CS path can claim the copy.
    const markerId = pilot ? null : logId;
    const markerText = markerId ? `\n\n--\n${inboundMarkerLine(markerId)}` : "";
    const markerHtml = markerId
      ? `<p style="color:#999;font-size:11px;margin-top:24px;">${escapeHtml(inboundMarkerLine(markerId))}</p>`
      : "";

    // The marker also goes in the header block at the TOP, so a copy whose
    // text the reader truncates, or whose HTML ends inside the customer's own
    // quoted history, still carries it on an unquoted line.
    const markerTopHtml = markerId ? `<br><span style="color:#999">${escapeHtml(inboundMarkerLine(markerId))}</span>` : "";
    const markerTopText = markerId ? `\n${inboundMarkerLine(markerId)}` : "";
    const forwardOptions = {
      to: forwardTo,
      subject: pilot ? `[Pilot] ${subject}` : `[Innkommende] ${subject} (fra ${from})`,
      htmlContent: `
        <div style="border-bottom:1px solid #ccc;padding-bottom:8px;margin-bottom:16px;color:#666;font-size:13px;">
          <strong>Fra:</strong> ${from}<br>
          <strong>Til:</strong> ${Array.isArray(to) ? to.join(", ") : to}<br>
          <strong>Emne:</strong> ${subject}${markerTopHtml}
        </div>
        ${bodyHtml}
        ${markerHtml}
      `,
      textContent: `Videresent fra: ${from}\nTil: ${Array.isArray(to) ? to.join(", ") : to}\nEmne: ${subject}${markerTopText}\n\n${bodyText}${markerText}`,
      replyTo: senderEmail,
    };

    const send = deps.sendEmail ?? ((o) => emailService.sendEmail(o));
    let forwarded: unknown;
    let forwardError: string | null = null;
    try {
      forwarded = await send(forwardOptions);
    } catch (sendErr: any) {
      forwardError = String(sendErr?.message ?? sendErr);
    }

    if (forwardSucceeded(forwarded)) {
      console.log(`[Inbound] Forwarded to ${forwardTo}`);
      if (logId) {
        try {
          updateInboundLog(logId, { forward_status: "ok", forward_attempts: 1, forwarded_at: new Date().toISOString(), forward_payload: null, forward_error: null });
        } catch (e) { console.error("[Inbound] log update failed:", e); }
      }
    } else {
      const err = forwardError ?? (forwarded && typeof forwarded === "object" ? String((forwarded as any).error ?? "send failed") : "send failed");
      console.warn(`[Inbound] Forward FAILED (${err}) — kept for retry`);
      if (logId) {
        try {
          updateInboundLog(logId, {
            forward_status: "failed",
            forward_attempts: 1,
            forward_error: err.slice(0, 500),
            forward_payload: JSON.stringify(forwardOptions),
          });
        } catch (e) { console.error("[Inbound] log update failed:", e); }
      }
    }
  } catch (err) {
    console.error("[Inbound] Webhook error:", err);
    if (logId) {
      try { updateInboundLog(logId, { crm_error: String((err as any)?.message ?? err).slice(0, 500) }); } catch { /* nothing more */ }
    }
  } finally {
    respond(); // always 200 so Resend doesn't retry
  }
}
