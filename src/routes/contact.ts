/**
 * contact.ts — Public "Kontakt oss" API endpoint
 *
 * POST /api/contact
 *
 * Accepts contact form submissions from all 3 platforms:
 *   rettfrabonden.com   → platform "rfb"
 *   opplevagent.no      → platform "experiences"
 *   finn-tannlege.com   → platform "dental"
 *
 * Spam controls:
 *   1. Honeypot field (_honey) — silent drop
 *   2. Cloudflare Turnstile CAPTCHA verification
 *   3. In-memory per-IP rate limit (3 submissions / hour)
 *   4. Field size caps (name ≤100, email ≤254, message ≤2000, subject ≤200)
 *
 * On success: creates a CRM thread (category "innkommende", subject
 * prefixed with "[Kontaktskjema]") via direct DB write — minimum privilege,
 * no reads, no admin routes.
 *
 * NEVER exposes internal errors to the caller.
 */

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";

const router = Router();

// ─── Types ──────────────────────────────────────────────────

type Platform = "rfb" | "experiences" | "dental";

// ─── Per-IP rate limiter (in-memory) ────────────────────────

const ipHits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || entry.resetAt < now) {
    ipHits.set(ip, { count: 1, resetAt: now + 3_600_000 });
    return true; // allowed
  }
  if (entry.count >= 3) return false; // blocked
  entry.count++;
  return true;
}

// Periodically prune stale entries so the map doesn't grow unbounded.
// 10-minute sweep is cheap and safe in a long-running process.
setInterval(
  () => {
    const now = Date.now();
    for (const [key, val] of ipHits) {
      if (val.resetAt < now) ipHits.delete(key);
    }
  },
  10 * 60 * 1000,
).unref();

// ─── Helpers ─────────────────────────────────────────────────

/** Infer platform from request Host header. */
function inferPlatform(req: Request): Platform {
  const host = (req.hostname || "").toLowerCase();
  if (host.includes("opplevagent.no")) return "experiences";
  if (host.includes("finn-tannlege.com")) return "dental";
  return "rfb";
}

/** Extract the real client IP, respecting X-Forwarded-For (Fly.io). */
function clientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = (Array.isArray(xff) ? xff[0] : xff).split(",")[0].trim();
    if (first) return first;
  }
  return req.ip || "unknown";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Turnstile verification ──────────────────────────────────

async function verifyTurnstile(token: string): Promise<boolean> {
  // Skip in test / local-dev environments
  if (
    process.env.NODE_ENV === "test" ||
    process.env.SKIP_TURNSTILE === "true"
  ) {
    return true;
  }

  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  if (!secret) {
    // If the secret isn't configured we fail closed (don't let submissions through).
    console.error("[contact] TURNSTILE_SECRET_KEY not set — rejecting submission");
    return false;
  }

  try {
    const body = new URLSearchParams({ secret, response: token });
    const resp = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!resp.ok) return false;
    const data = (await resp.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error("[contact] Turnstile verification error:", err);
    return false;
  }
}

// ─── CRM thread creation (minimum privilege) ─────────────────
// Writes ONLY to crm_contacts + crm_threads + crm_messages.
// No reads from other tables. No admin routes called.

function createContactThread(params: {
  name: string;
  email: string;
  subject: string;
  message: string;
  platform: Platform;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  const lowerEmail = params.email.trim().toLowerCase();

  // Resolve or create contact
  const existing = db
    .prepare("SELECT id FROM crm_contacts WHERE email = ?")
    .get(lowerEmail) as { id: string } | undefined;

  let contactId: string;
  if (existing) {
    contactId = existing.id;
    db.prepare(
      "UPDATE crm_contacts SET last_seen_at = datetime('now') WHERE id = ?",
    ).run(contactId);
  } else {
    contactId = randomUUID();
    const domain = lowerEmail.split("@")[1] ?? null;
    db.prepare(
      `INSERT INTO crm_contacts (id, type, agent_id, email, name, domain, vertical_id)
       VALUES (?, 'unknown', NULL, ?, ?, ?, ?)`,
    ).run(contactId, lowerEmail, params.name || null, domain, params.platform);
  }

  // Create the CRM thread
  const threadId = `kontakt-${randomUUID()}`;
  const subjectLine = `[Kontaktskjema] ${params.subject || "Kontaktskjema " + params.platform}`;
  const bodyText = `Navn: ${params.name}\nE-post: ${params.email}\n\n${params.message}`;

  db.prepare(
    `INSERT INTO crm_threads
       (id, contact_id, subject, category, severity, status, assigned_to,
        message_count, last_message_at, last_inbound_at, updated_at, vertical_id)
     VALUES (?, ?, ?, 'innkommende', 'normal', 'new', 'unassigned',
             1, ?, ?, datetime('now'), ?)`,
  ).run(threadId, contactId, subjectLine, now, now, params.platform);

  // Insert the inbound message
  const messageId = `msg-${randomUUID()}`;
  db.prepare(
    `INSERT INTO crm_messages
       (id, thread_id, direction, from_email, to_emails, cc_emails,
        subject, body_text, body_html, snippet, sent_at, raw_metadata, delivery_status)
     VALUES (?, ?, 'in', ?, '[]', '[]', ?, ?, NULL, ?, ?, ?, 'sent')`,
  ).run(
    messageId,
    threadId,
    lowerEmail,
    subjectLine,
    bodyText,
    bodyText.slice(0, 200),
    now,
    JSON.stringify({ source: "kontaktskjema", platform: params.platform }),
  );

  // Log action
  const actionId = randomUUID();
  db.prepare(
    `INSERT INTO crm_actions (id, thread_id, contact_id, type, actor, payload)
     VALUES (?, ?, ?, 'imported', 'system', ?)`,
  ).run(
    actionId,
    threadId,
    contactId,
    JSON.stringify({
      source: "kontaktskjema",
      platform: params.platform,
      name: params.name,
    }),
  );
}

// ─── POST /contact ───────────────────────────────────────────

router.post("/contact", async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as Record<string, unknown>;

    // 1. Honeypot check
    const honey = String(body._honey ?? "");
    if (honey.length > 0) {
      res.status(400).json({ success: false, error: "invalid" });
      return;
    }

    // 2. Field size limits
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim();
    const message = String(body.message ?? "").trim();
    const subject = String(body.subject ?? "").trim();

    if (name.length > 100 || email.length > 254 || message.length > 2000 || subject.length > 200) {
      res.status(422).json({ success: false, error: "field_too_long" });
      return;
    }
    if (!name || !email || !message) {
      res.status(422).json({ success: false, error: "missing_required_fields" });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      res.status(422).json({ success: false, error: "invalid_email" });
      return;
    }

    // 3. Platform validation
    const rawPlatform = String(body.platform ?? "").toLowerCase();
    const VALID_PLATFORMS: Platform[] = ["rfb", "experiences", "dental"];
    const platform: Platform = VALID_PLATFORMS.includes(rawPlatform as Platform)
      ? (rawPlatform as Platform)
      : inferPlatform(req);

    // 4. Turnstile verification
    const cfToken = String(body.cfTurnstileResponse ?? "");
    const turnstileOk = await verifyTurnstile(cfToken);
    if (!turnstileOk) {
      res.status(403).json({ success: false, error: "captcha_failed" });
      return;
    }

    // 5. Rate limit
    const ip = clientIp(req);
    if (!checkRateLimit(ip)) {
      res.status(429).json({ success: false, error: "rate_limit_exceeded" });
      return;
    }

    // 6. Create CRM thread
    createContactThread({ name, email, subject, message, platform });

    // 7. Success
    res.status(200).json({
      success: true,
      message: "Takk! Vi svarer så snart vi kan.",
    });
  } catch (err) {
    console.error("[contact] Unhandled error:", err);
    res.status(500).json({ success: false, error: "internal_error" });
  }
});

export default router;
