// ─── Prepayment via Stripe Connect — routes ─────────────────────────────
// A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect (L4,
// Daniel-authorized 2026-10-09), skive 1.
//
// Nothing here is reachable unless PAYMENTS_ENABLED=1: mountPaymentRoutes()
// is called unconditionally from src/index.ts and checks the flag (and the
// live-key guard) itself, same as mountBillingRoutes().
//
//   POST /eier/:agentId/betaling/start   owner session → Stripe-hosted onboarding
//   GET  /eier/:agentId/betaling/retur   Stripe sends the owner back here
//   GET  /eier/:agentId/betaling/fornye  expired onboarding link → a fresh one
//   POST /webhooks/stripe-connect        Connect webhook (signature = auth),
//                                        mounted early (mountPaymentWebhook)
//   GET  /admin/payments/status          X-Admin-Key: mode, flags, guard
//   GET  /admin/payments/accounts        X-Admin-Key: producer accounts
//   POST /admin/payments/accounts/:agentId/sync    X-Admin-Key: re-read from Stripe
//   POST /admin/payments/accounts/:agentId/retire  X-Admin-Key: retire the current account
//
// The return page never trusts the redirect: it only sends the owner back
// to the portal, which shows the state the webhook wrote.
//
// Env vars (NAMES only): PAYMENTS_ENABLED, PAYMENTS_ALLOWED_AGENT_IDS,
// STRIPE_SECRET_KEY, STRIPE_CONNECT_WEBHOOK_SECRET, PAYMENTS_LIVE,
// PAYMENTS_ORG_NR — see payment-provider.ts and payment-service.ts.

import express, { Router, Request, Response } from "express";
import type { Application } from "express";
import { getDb } from "../database/init";
import { verifyOwnerSession } from "./owner-portal";
import {
  assertPaymentsKeyAllowed,
  createRealPaymentsStripeClient,
  paymentsLivemode,
  type PaymentsStripeClient,
} from "../services/payment-provider";
import {
  handlePaymentsWebhook,
  isPaymentsEnabled,
  listPaymentAccounts,
  paymentsAllowedAgentIds,
  startProducerOnboarding,
  getPaymentAccount,
  syncProducerAccounts,
  retireProducerAccount,
} from "../services/payment-service";

const router = Router();
const webhookRouter = Router();

/** Connect webhook path — what Daniel registers in Stripe (events on connected accounts). */
export const PAYMENTS_WEBHOOK_PATH = "/webhooks/stripe-connect";

function baseUrl(): string {
  return process.env.BASE_URL || "https://rettfrabonden.com";
}

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

/**
 * Tests inject a fake client with app.set("paymentsStripeClient", fake).
 * Otherwise the live-key guard is re-checked on EVERY request (the key can
 * change under a running process), then a real client is built.
 */
function resolveStripeClient(req: Request): PaymentsStripeClient | null {
  const injected = req.app.get("paymentsStripeClient") as PaymentsStripeClient | undefined;
  if (injected) return injected;
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) return null;
  if (!assertPaymentsKeyAllowed().allowed) return null;
  return createRealPaymentsStripeClient(key);
}

function resolveWebhookSecret(req: Request): string {
  const injected = req.app.get("paymentsWebhookSecret") as string | undefined;
  if (injected) return injected;
  return process.env.STRIPE_CONNECT_WEBHOOK_SECRET || "";
}

function portalUrl(agentId: string, status: string): string {
  return `/eier/${encodeURIComponent(agentId)}/portal?status=${status}#forhandsbetaling`;
}

/** Owner session for exactly this agent, else redirect to login / 403. */
function requireOwner(req: Request, res: Response, agentId: string): boolean {
  const session = verifyOwnerSession(req);
  if (!session.valid) {
    res.redirect(302, `/eier/${encodeURIComponent(agentId)}`);
    return false;
  }
  if (session.agentId !== agentId) {
    res.status(403).json({ success: false, error: "forbidden" });
    return false;
  }
  return true;
}

// ── Owner onboarding ─────────────────────────────────────────────────

router.post("/eier/:agentId/betaling/start", express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const agentId = String(req.params.agentId || "");
  if (!requireOwner(req, res, agentId)) return;
  const stripe = resolveStripeClient(req);
  if (!stripe) return res.redirect(303, portalUrl(agentId, "payments_unavailable"));
  try {
    const out = await startProducerOnboarding({ db: getDb(), stripe, agentId, baseUrl: baseUrl() });
    if (!out.ok) {
      if (out.error === "already_active") return res.redirect(303, `/eier/${encodeURIComponent(agentId)}/portal#forhandsbetaling`);
      const status = out.error === "orders_not_enabled" ? "payments_orders_off" : "payments_unavailable";
      return res.redirect(303, portalUrl(agentId, status));
    }
    return res.redirect(303, out.url);
  } catch (err: any) {
    console.error(`[payments] onboarding start failed agent=${agentId}: ${String(err?.message || err)}`);
    return res.redirect(303, portalUrl(agentId, "payments_error"));
  }
});

router.get("/eier/:agentId/betaling/retur", (req: Request, res: Response) => {
  const agentId = String(req.params.agentId || "");
  if (!requireOwner(req, res, agentId)) return;
  return res.redirect(303, portalUrl(agentId, "payments_return"));
});

router.get("/eier/:agentId/betaling/fornye", async (req: Request, res: Response) => {
  const agentId = String(req.params.agentId || "");
  if (!requireOwner(req, res, agentId)) return;
  const db = getDb();
  if (!getPaymentAccount(db, agentId, paymentsLivemode())) {
    return res.redirect(303, portalUrl(agentId, "payments_unavailable"));
  }
  const stripe = resolveStripeClient(req);
  if (!stripe) return res.redirect(303, portalUrl(agentId, "payments_unavailable"));
  try {
    const out = await startProducerOnboarding({ db, stripe, agentId, baseUrl: baseUrl() });
    if (!out.ok) return res.redirect(303, portalUrl(agentId, "payments_unavailable"));
    return res.redirect(303, out.url);
  } catch (err: any) {
    console.error(`[payments] onboarding refresh failed agent=${agentId}: ${String(err?.message || err)}`);
    return res.redirect(303, portalUrl(agentId, "payments_error"));
  }
});

// ── Connect webhook ──────────────────────────────────────────────────
// Raw body: src/index.ts's global express.json() keeps the exact request
// bytes on req.rawBody — Stripe's HMAC is over those bytes. Mounted early
// (next to /webhooks/resend), outside /api, so the general /api rate limit
// can never 429 Stripe's deliveries.

webhookRouter.post(PAYMENTS_WEBHOOK_PATH, async (req: Request, res: Response) => {
  const secret = resolveWebhookSecret(req);
  if (!secret) {
    res.status(503).json({ error: "Webhook not configured (STRIPE_CONNECT_WEBHOOK_SECRET unset)" });
    return;
  }
  const stripe = resolveStripeClient(req);
  if (!stripe) {
    res.status(503).json({ error: "Payments not configured" });
    return;
  }
  const signature = req.headers["stripe-signature"] as string | undefined;
  if (!signature) {
    res.status(400).json({ error: "missing stripe-signature header" });
    return;
  }
  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!rawBody) {
    res.status(400).json({ error: "missing raw body" });
    return;
  }
  try {
    const result = await handlePaymentsWebhook({ db: getDb(), stripe, payload: rawBody, signature, secret });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ received: true, duplicate: result.duplicate, handled: result.handled, event_id: result.eventId, type: result.type });
  } catch (err: any) {
    // 500 makes Stripe retry; the event was not recorded, so the retry applies it.
    console.error(`[payments] webhook processing failed: ${String(err?.message || err)}`);
    res.status(500).json({ error: "webhook processing failed" });
  }
});

// ── Admin visibility ─────────────────────────────────────────────────

router.get("/admin/payments/status", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const guard = assertPaymentsKeyAllowed();
  res.json({
    success: true,
    payments_enabled: isPaymentsEnabled(),
    livemode: paymentsLivemode(),
    stripe_key_configured: !!process.env.STRIPE_SECRET_KEY,
    connect_webhook_secret_configured: !!process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
    live_guard: guard,
    pilot_agent_count: paymentsAllowedAgentIds().length,
  });
});

router.get("/admin/payments/accounts", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json({ success: true, accounts: listPaymentAccounts(getDb()) });
});

router.post("/admin/payments/accounts/:agentId/retire", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const retired = retireProducerAccount(getDb(), String(req.params.agentId || ""));
  res.status(retired ? 200 : 404).json({ success: retired });
});

router.post("/admin/payments/accounts/:agentId/sync", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const stripe = resolveStripeClient(req);
  if (!stripe) {
    res.status(503).json({ error: "Payments not configured" });
    return;
  }
  try {
    const synced = await syncProducerAccounts(getDb(), stripe, String(req.params.agentId || ""));
    res.json({ success: true, synced });
  } catch (err: any) {
    res.status(502).json({ error: "sync failed", detail: String(err?.message || err) });
  }
});

// ── Mounting ─────────────────────────────────────────────────────────

function paymentsMountable(env: NodeJS.ProcessEnv): boolean {
  if (!isPaymentsEnabled(env)) return false;
  const guard = assertPaymentsKeyAllowed(env);
  if (!guard.allowed) {
    console.error(`payments: ${guard.reason}`);
    return false;
  }
  return true;
}

/**
 * Called unconditionally from src/index.ts (late, after the owner portal).
 * Mounts nothing unless PAYMENTS_ENABLED=1, and nothing with a live key the
 * guard refuses.
 */
export function mountPaymentRoutes(app: Application, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!paymentsMountable(env)) return false;
  app.use(router);
  return true;
}

/** Called unconditionally from src/index.ts right after /webhooks/resend. Same gates. */
export function mountPaymentWebhook(app: Application, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!paymentsMountable(env)) return false;
  app.use(webhookRouter);
  return true;
}

export default router;
export { webhookRouter as paymentsWebhookRouter };
