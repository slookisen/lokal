// ─── resend-webhook.ts (owner decision 2026-09-29 «Blacklist bounces», narrowed by «1B») ─
// Automatic bounce/complaint intake. Before this, email_bounces was filled
// ONLY by a manual POST /admin/email-bounces, so the two platform jobs whose
// auto-pause reads it — the RFB daily send (rfb-marketing-daily.ts G3) and
// the Opplevagent lane (routes/opplevelser.ts, recent-bounce auto-pause) —
// never had anything to fire on. Resend now POSTs its own events to
// /webhooks/resend (routes/resend-webhook.ts) and this module:
//
//   1. verifySvixSignature(): Resend signs webhooks with Svix. Signed content
//      is `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256 keyed with
//      the base64 part of the `whsec_…` secret, base64-encoded; the
//      svix-signature header carries one or more space-separated `v1,<sig>`
//      entries (several during a secret rotation). Timestamp must be within
//      ±5 min of now (replay window); every candidate is compared with
//      crypto.timingSafeEqual. Pure — no DB, no env.
//   2. processResendWebhookEvent(): acts on a VERIFIED event, in ONE
//      transaction keyed on svix-id (resend_webhook_events PRIMARY KEY):
//        • email.bounced with bounce.type "Permanent" (hard) and
//          email.complained (spam complaint) → bounceService.record() into
//          email_bounces (bounce_type 'hard' / 'complaint'). That row is the
//          ONLY thing written. It suppresses OUTREACH, and only outreach:
//          every automated outreach sender reads it — the RFB outreach gate
//          (computeOutreachCandidates' is_hard_bounced), compose's
//          recipient_bounced guard (executeCompose, the RFB daily job's send
//          path), the Opplevagent gårdssalg eligibility
//          (computeGardssalgOutreachSendEligibility → pilot-send, daily-prep,
//          daily-run, candidates) and its send-time re-check
//          (sendGardssalgOutreachToEligibleProvider) — plus both auto-pauses.
//        • NO agent_blocklist row (owner decision «1B», 2026-09-29). The
//          general blocklist's email-keyed isBlocked() is ALSO read by
//          ordering (catalog-offers canOrder), order notifications
//          (order-notify-service) and registration (marketplace register /
//          claim). A hard bounce or a spam complaint about a cold email is not
//          a reason to stop a producer from being ordered from, being told
//          about an order, or registering — so it must not reach that table.
//          Never touches agents/profiles either.
//        • email.bounced with any other bounce.type (Transient/Undetermined/
//          missing) → soft: ledger row + console line, nothing recorded.
//          Mailbox-full / greylisting is not a dead address.
//        • any other event type → 200, nothing written (so subscribing to
//          more events in the Resend dashboard is harmless).
//      A failure anywhere rolls the whole event back (ledger row included),
//      the route answers 500 and Svix retries — never a half-applied event.
//
// Deliberately OUT of scope: catching up on bounces/complaints that happened
// BEFORE the webhook was configured (would need Resend API polling —
// GET /emails/{id} per sent message, or a dashboard export fed through the
// existing POST /admin/email-bounces). Svix only delivers events that occur
// after the endpoint exists.
//
// PII: the only personal datum persisted or logged is the recipient address.
// Subject/from/body/headers of the payload are never stored or logged; the
// bounce diagnostic (bounce.message — the remote MTA's text) is kept, capped,
// in email_bounces.reason only, for the enrichment agent's investigation.

import crypto from "crypto";
import { getDb } from "../database/init";
import { bounceService } from "./bounce-service";
import { normalizeEmail } from "./blocklist-service";

export const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
export const RESEND_WEBHOOK_SOURCE = "resend-webhook";
const REASON_MAX_CHARS = 300;

// ─── 1. Svix signature ──────────────────────────────────────────────────
export type SvixVerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "bad_timestamp" | "stale_timestamp" | "bad_signature" };

/** base64 key bytes of a `whsec_…` secret; empty Buffer when unusable. */
export function decodeSvixSecret(secret: string): Buffer {
  const s = String(secret || "").trim();
  const b64 = s.startsWith("whsec_") ? s.slice("whsec_".length) : s;
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return Buffer.alloc(0);
  return Buffer.from(b64, "base64");
}

/** The v1 signature Svix would send for this (id, timestamp, body). Tests sign with it too. */
export function computeSvixSignature(key: Buffer, id: string, timestamp: string, rawBody: Buffer | string): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return crypto
    .createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, "utf8"), body]))
    .digest("base64");
}

export function verifySvixSignature(input: {
  key: Buffer;
  id: string | undefined;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  rawBody: Buffer;
  nowSeconds?: number;
}): SvixVerifyResult {
  const { key, id, timestamp, signatureHeader, rawBody } = input;
  if (!id || !timestamp || !signatureHeader) return { ok: false, reason: "missing_headers" };
  // Svix timestamps are integer UNIX seconds; anything else is not theirs.
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Both directions: an old timestamp is a replay, a far-future one is a
  // pre-signed replay waiting to happen.
  if (Math.abs(now - Number(timestamp)) > SVIX_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = Buffer.from(computeSvixSignature(key, id, timestamp, rawBody), "base64");
  for (const part of signatureHeader.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "v1") continue;
    const candidate = Buffer.from(part.slice(comma + 1), "base64");
    // timingSafeEqual throws on unequal lengths — a length mismatch is simply
    // "not this one" (and leaks nothing: the expected length is public, 32).
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "bad_signature" };
}

// ─── 2. Event processing ────────────────────────────────────────────────
export type ResendWebhookOutcome =
  | "hard_bounce_recorded"
  | "complaint_recorded"
  | "soft_bounce_logged"
  | "ambiguous_recipient"
  | "ignored_event_type"
  | "duplicate";

export interface ResendWebhookResult {
  httpStatus: number;
  body: { received: true; outcome: ResendWebhookOutcome; event_type?: string; duplicate?: boolean };
}

const ACTED_EVENT_TYPES = new Set(["email.bounced", "email.complained"]);
// Mirrors the upper bound of a valid address (RFC 5321 path limit) plus a
// minimal local@domain shape. Not a validator — just "is this plausibly the
// one recipient address, and not junk we'd write into email_bounces".
const PLAUSIBLE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** Exactly one plausible recipient, normalized; null otherwise. */
function singleRecipient(data: any): string | null {
  const raw = data?.to;
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  // Multi-recipient event: Resend does not say WHICH address bounced, and
  // suppressing a co-recipient that didn't bounce would be wrong. Every send
  // path in this repo mails exactly one `to`, so this never happens for our
  // own outreach — it's logged, not acted on.
  if (list.length !== 1 || typeof list[0] !== "string") return null;
  // Resend may hand back a display-name form ("Navn <a@b.no>").
  const m = /<([^<>]+)>\s*$/.exec(list[0]);
  const addr = normalizeEmail(m ? m[1] : list[0]);
  return PLAUSIBLE_EMAIL.test(addr) && addr.length <= 320 ? addr : null;
}

function isoOrNow(v: unknown): string {
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return new Date().toISOString();
}

/**
 * Acts on an already signature-verified Resend event. `event` is the parsed
 * raw body. Idempotent on svixId. Throws only on a DB failure (caller → 500,
 * Svix retries; the transaction left nothing behind).
 */
export function processResendWebhookEvent(svixId: string, event: any): ResendWebhookResult {
  const type = typeof event?.type === "string" ? event.type : "";
  if (!ACTED_EVENT_TYPES.has(type)) {
    return { httpStatus: 200, body: { received: true, outcome: "ignored_event_type", event_type: type || undefined } };
  }
  const data = event?.data ?? {};
  const email = singleRecipient(data);
  const bounceKind: string = typeof data?.bounce?.type === "string" ? data.bounce.type : "";
  const bounceSubType: string = typeof data?.bounce?.subType === "string" ? data.bounce.subType : "";
  const isHard = type === "email.bounced" && bounceKind.toLowerCase() === "permanent";
  const isComplaint = type === "email.complained";

  let outcome: ResendWebhookOutcome;
  if (!email) outcome = "ambiguous_recipient";
  else if (isComplaint) outcome = "complaint_recorded";
  else if (isHard) outcome = "hard_bounce_recorded";
  else outcome = "soft_bounce_logged";

  const db = getDb();
  const ledger = db.prepare(
    `INSERT OR IGNORE INTO resend_webhook_events (svix_id, event_type, email, outcome) VALUES (?, ?, ?, ?)`,
  );
  let duplicate = false;
  db.transaction(() => {
    if (ledger.run(svixId, type, email, outcome).changes === 0) {
      duplicate = true;
      return;
    }
    if (outcome !== "hard_bounce_recorded" && outcome !== "complaint_recorded") return;
    const resendEmailId = typeof data?.email_id === "string" ? data.email_id.slice(0, 128) : undefined;
    const diag = typeof data?.bounce?.message === "string" ? data.bounce.message : "";
    const reason = isComplaint
      ? `${RESEND_WEBHOOK_SOURCE}: spam complaint`
      : `${RESEND_WEBHOOK_SOURCE}: ${bounceKind}${bounceSubType ? "/" + bounceSubType : ""}${diag ? " — " + diag : ""}`;
    bounceService.record({
      email: email!,
      bouncedAt: isoOrNow(event?.created_at ?? data?.created_at),
      resendEmailId,
      bounceType: isComplaint ? "complaint" : "hard",
      reason: reason.slice(0, REASON_MAX_CHARS),
    });
    // Deliberately NO blocklist add() here (owner decision «1B»): the
    // email_bounces row above is what the outreach senders read; the general
    // agent_blocklist also gates ordering / order notifications /
    // registration, which a bounce must not touch. Undo a misclassified
    // bounce by removing its email_bounces row (or the manual
    // createdBy=daniel + force=true override on compose).
  })();

  if (duplicate) {
    return { httpStatus: 200, body: { received: true, outcome: "duplicate", event_type: type, duplicate: true } };
  }
  // Address + classification only — never subject/from/body.
  console.log(
    `[resend-webhook] ${type} ${outcome}` +
      (email ? ` ${email}` : "") +
      (type === "email.bounced" ? ` bounce_type=${bounceKind || "missing"}` : ""),
  );
  return { httpStatus: 200, body: { received: true, outcome, event_type: type } };
}
