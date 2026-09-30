// ─── POST /webhooks/resend (owner decision 2026-09-29 «Blacklist bounces») ─
// Resend → Svix → here. Automatic intake of hard bounces + spam complaints
// into email_bounces (outreach suppression only — no agent_blocklist row,
// owner decision «1B»); all logic lives in
// services/resend-webhook.ts (see its header for the full contract).
//
// Auth is the Svix signature, NOT X-Admin-Key: Resend carries no admin key.
// Mounted in index.ts right after the global middleware stack and BEFORE
// the dental/opplevagent host gates and every admin router, so no auth or
// host-routing layer can swallow it. CSRF does not apply (no cookies/session,
// signature-authenticated machine-to-machine POST).
//
// Raw body: the global express.json() in index.ts stashes the exact request
// bytes on req.rawBody via its `verify` callback (added for the Stripe
// webhook — same reason: the HMAC is over the bytes, not a re-serialization).
// We parse THAT, never req.body (which sanitizeInput has already rewritten).
// No rawBody (non-JSON Content-Type) → 400.
//
// Fail closed: RESEND_WEBHOOK_SECRET unset/unusable → 503, nothing read,
// nothing written. Bad/missing signature or a timestamp outside ±5 min → 401,
// nothing written. Replayed svix-id → 200 no-op.
//
// Limits: 64 KiB body cap (a Resend event is ~1 KiB; the global parser's own
// 1 MB cap still applies first) and a per-IP limiter — generous enough for a
// Svix retry burst after downtime, tight enough that an unauthenticated
// flood costs one HMAC per request at most.

import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { decodeSvixSecret, processResendWebhookEvent, verifySvixSignature } from "../services/resend-webhook";

export const RESEND_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

const resendWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  // Same acknowledgement as middleware/security.ts's sharedValidate: Fly's
  // edge proxy is trusted infrastructure ("trust proxy" = true in index.ts).
  validate: { trustProxy: false },
  message: { error: "rate_limited" },
});

/** Test seam: req.app.get("resendWebhookSecret") wins over env (mirrors admin-billing). */
function resolveSecret(req: Request): string {
  const injected = req.app?.get?.("resendWebhookSecret") as string | undefined;
  if (injected !== undefined) return injected;
  return process.env.RESEND_WEBHOOK_SECRET || "";
}

/** A repeated header arrives as string[] — a genuine Svix call never repeats one. */
function singleHeader(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
}

export function handleResendWebhook(req: Request, res: Response): void {
  const key = decodeSvixSecret(resolveSecret(req));
  if (key.length === 0) {
    res.status(503).json({ error: "Webhook not configured (RESEND_WEBHOOK_SECRET unset)" });
    return;
  }
  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: "expected application/json body" });
    return;
  }
  if (rawBody.length > RESEND_WEBHOOK_MAX_BODY_BYTES) {
    res.status(413).json({ error: "payload too large" });
    return;
  }
  const svixId = singleHeader(req, "svix-id");
  const verdict = verifySvixSignature({
    key,
    id: svixId,
    timestamp: singleHeader(req, "svix-timestamp"),
    signatureHeader: singleHeader(req, "svix-signature"),
    rawBody,
  });
  if (!verdict.ok) {
    // Reason code only — no header values, no body.
    console.warn(`[resend-webhook] rejected: ${verdict.reason}`);
    res.status(401).json({ error: "invalid signature", reason: verdict.reason });
    return;
  }
  let event: any;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "invalid JSON" });
    return;
  }
  try {
    const out = processResendWebhookEvent(String(svixId).slice(0, 256), event);
    res.status(out.httpStatus).json(out.body);
  } catch (err: any) {
    // Transaction rolled back — Svix retries on non-2xx.
    console.error("[resend-webhook] processing failed:", err?.message ?? err);
    res.status(500).json({ error: "processing failed" });
  }
}

const router = Router();
router.post("/webhooks/resend", resendWebhookLimiter, handleResendWebhook);

export default router;
