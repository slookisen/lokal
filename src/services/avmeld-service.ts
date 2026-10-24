// ─── Working unsubscribe for cold outreach ──────────────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S1a point 3.
//
// Cold RFB outreach used to offer one opt-out: reply «fjern», which DELETES the
// profile. The «/unsubscribe» link in sendClaimInvitation has no route. This
// module is the small, side-effect-free core of the replacement:
//
//   • a signed per-recipient token (HMAC-SHA256 keyed from the existing server
//     secret ADMIN_KEY, with a purpose prefix so the key is never used raw);
//   • suppressEmail(): one email_bounces row with bounce_type 'unsubscribe'.
//     email_bounces is the OUTREACH-only suppression table (see
//     resend-webhook.ts «1B»): the RFB candidate gate and the compose send
//     guard read it; ordering, order notifications and registration do not,
//     and no agent/profile row is touched — the profile stays public.
//     (agent_blocklist is deliberately NOT used: its email-keyed isBlocked()
//     is also read by ordering and registration.)
//     The row is written already `investigated` so the bounce-enrichment queue
//     does not treat an unsubscribe as a dead address to chase.
//   • the List-Unsubscribe headers for cold sends.
//
// Flag OUTREACH_UNSUBSCRIBE_ENABLED (default OFF) gates the NEW behaviour: the
// /avmeld route, and the headers on cold sends. Honouring rows already in
// email_bounces is not flagged (a suppression must never be ignored).
// The token is never logged.

import crypto from "crypto";
import { getDb } from "../database/init";

/** Env flag (read at call time, "1" or "true" = on). Default OFF. */
export const OUTREACH_UNSUBSCRIBE_FLAG = "OUTREACH_UNSUBSCRIBE_ENABLED";
export const UNSUBSCRIBE_BOUNCE_TYPE = "unsubscribe";
const KEY_PURPOSE = "avmeld-v1";

export function outreachUnsubscribeEnabled(): boolean {
  const v = process.env[OUTREACH_UNSUBSCRIBE_FLAG];
  return v === "1" || v === "true";
}

function serverSecret(): string {
  return process.env.UNSUBSCRIBE_TOKEN_SECRET || process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload: string, secret: string): string {
  const key = crypto.createHmac("sha256", secret).update(KEY_PURPOSE).digest();
  return b64url(crypto.createHmac("sha256", key).update(payload).digest());
}

export function normalizeRecipient(email: string): string {
  return String(email || "").trim().toLowerCase();
}

/** Signed token for one recipient address; null when no server secret is configured. */
export function makeUnsubscribeToken(email: string): string | null {
  const secret = serverSecret();
  const norm = normalizeRecipient(email);
  if (!secret || !norm) return null;
  const payload = b64url(Buffer.from(norm, "utf8"));
  return `${payload}.${sign(payload, secret)}`;
}

/** The recipient address the token was signed for, or null when it is not ours. */
export function verifyUnsubscribeToken(token: string): { email: string } | null {
  const secret = serverSecret();
  if (!secret || typeof token !== "string" || token.length > 600) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(payload, secret), "utf8");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const email = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return email && email === normalizeRecipient(email) ? { email } : null;
  } catch {
    return null;
  }
}

export function unsubscribeUrl(email: string): string | null {
  const token = makeUnsubscribeToken(email);
  if (!token) return null;
  return `${process.env.APP_URL || "https://rettfrabonden.com"}/avmeld/${token}`;
}

/**
 * List-Unsubscribe + List-Unsubscribe-Post headers (RFC 2369 / RFC 8058) for a
 * cold send, or null (flag off, or no server secret → no headers).
 */
export function unsubscribeHeaderValues(email: string): { listUnsubscribe: string; listUnsubscribePost: string } | null {
  if (!outreachUnsubscribeEnabled()) return null;
  const url = unsubscribeUrl(email);
  if (!url) return null;
  return { listUnsubscribe: `<${url}>`, listUnsubscribePost: "List-Unsubscribe=One-Click" };
}

/** True when this address already has an unsubscribe row. */
export function isUnsubscribed(email: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM email_bounces WHERE LOWER(TRIM(email)) = ? AND bounce_type = ? LIMIT 1`)
    .get(normalizeRecipient(email), UNSUBSCRIBE_BOUNCE_TYPE);
  return !!row;
}

/** Idempotent. Writes one email_bounces row; never touches agents/profiles. */
export function suppressEmail(email: string): { inserted: boolean } {
  const r = getDb()
    .prepare(
      `INSERT OR IGNORE INTO email_bounces
         (email, bounced_at, resend_email_id, bounce_type, reason, investigated, investigated_at, investigation_outcome)
       VALUES (?, ?, 'avmeld', ?, 'unsubscribe_link', 1, ?, 'unsubscribed')`,
    )
    .run(normalizeRecipient(email), new Date().toISOString(), UNSUBSCRIBE_BOUNCE_TYPE, new Date().toISOString());
  return { inserted: r.changes > 0 };
}
