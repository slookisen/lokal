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
//   POST /admin/payments/maintenance       X-Admin-Key: run the lifecycle job now
//   POST /admin/payments/:paymentId/refund X-Admin-Key: full/partial refund (support)
//   POST /admin/payments/release-all       X-Admin-Key: rollback — release every open link/reservation
//   GET  /betaling/takk, /betaling/avbrutt  buyer return pages after Stripe Checkout
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
import { verifyOwnerSession, ownerSessionAllows } from "./owner-portal";
import { shell } from "./seo";
import {
  assertPaymentsKeyAllowed,
  paymentsLivemode,
  type PaymentsStripeClient,
} from "../services/payment-provider";
import {
  handlePaymentsWebhook,
  isPaymentsEnabled,
  isPaymentsLifecycleActive,
  listPaymentAccounts,
  paymentsAllowedAgentIds,
  startProducerOnboarding,
  getPaymentAccount,
  syncProducerAccounts,
  retireProducerAccount,
  recordProducerTermsAcceptance,
  hasAcceptedCurrentProducerTerms,
  isTraderStatus,
  getProducerPaymentStatus,
  resolvePaymentsStripeClient,
  checkoutMinutes,
  runPaymentMaintenance,
  refundPayment,
  releaseAllOpenPayments,
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
  return resolvePaymentsStripeClient(req.app.get("paymentsStripeClient") as PaymentsStripeClient | undefined);
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
  if (!ownerSessionAllows(agentId, session)) {
    res.status(403).json({ success: false, error: session.agentId === agentId ? "ownership_not_verified" : "forbidden" });
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
  // Prerequisites 4 + 5: the form carries the terms checkbox and the trader
  // declaration the first time (and after a terms version bump).
  const db0 = getDb();
  const st = getProducerPaymentStatus(db0, agentId);
  if (st.state !== "disabled" && st.state !== "not_allowed" && st.state !== "not_eligible" && !hasAcceptedCurrentProducerTerms(db0, agentId)) {
    const trader = req.body?.trader_status;
    if (req.body?.terms_accepted !== "1" || !isTraderStatus(trader)) {
      return res.redirect(303, portalUrl(agentId, "payments_terms_required"));
    }
    recordProducerTermsAcceptance(db0, agentId, trader);
  }
  try {
    const out = await startProducerOnboarding({ db: getDb(), stripe, agentId, baseUrl: baseUrl() });
    if (!out.ok) {
      if (out.error === "already_active") return res.redirect(303, `/eier/${encodeURIComponent(agentId)}/portal#forhandsbetaling`);
      const status = out.error === "orders_not_enabled" ? "payments_orders_off"
        : out.error === "terms_required" ? "payments_terms_required" : "payments_unavailable";
      return res.redirect(303, portalUrl(agentId, status));
    }
    return res.redirect(303, out.url);
  } catch (err: any) {
    console.error(`[payments] onboarding start failed agent=${agentId}: ${String(err?.message || err)}`);
    return res.redirect(303, portalUrl(agentId, "payments_error"));
  }
});

// Change the trader declaration later (prerequisite 5), or accept a new
// terms version without a new Stripe step (an active producer after a
// PRODUSENTVILKAR_VERSION bump gets no payment links until then). Records a
// new acceptance row; the terms checkbox is required unless the current
// version is already accepted.
router.post("/eier/:agentId/betaling/erklaering", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const agentId = String(req.params.agentId || "");
  if (!requireOwner(req, res, agentId)) return;
  const db = getDb();
  const st = getProducerPaymentStatus(db, agentId);
  if (st.state === "disabled" || st.state === "not_allowed" || st.state === "not_eligible") return res.redirect(303, portalUrl(agentId, "payments_unavailable"));
  const trader = req.body?.trader_status;
  if (!isTraderStatus(trader) || (!hasAcceptedCurrentProducerTerms(db, agentId) && req.body?.terms_accepted !== "1")) {
    return res.redirect(303, portalUrl(agentId, "payments_terms_required"));
  }
  recordProducerTermsAcceptance(db, agentId, trader);
  return res.redirect(303, portalUrl(agentId, "payments_declared"));
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

// ── Buyer return pages after Stripe Checkout (skive 2) ───────────────
// Stripe sends the buyer here after paying or cancelling. The redirect is
// NOT proof of payment (the webhook is), so the copy never claims a status
// and never shows order details — the order id in the URL is not a buyer
// capability.

const RETURN_CSS = `.pay-wrap{max-width:640px;margin:48px auto;padding:0 16px;} .pay-wrap h1{font-size:1.6rem;margin-bottom:12px;} .pay-wrap p{margin:10px 0;line-height:1.55;}`;

router.get("/betaling/takk", (_req: Request, res: Response) => {
  const body = `<main class="pay-wrap">
    <h1>Takk for betalingen</h1>
    <p>Når Stripe har bekreftet betalingen, får produsenten bestillingen din.</p>
    <p>Beløpet er reservert og trekkes først når produsenten bekrefter bestillingen. Avslår produsenten, frigjøres reservasjonen.</p>
    <p>Produsenten er selger og mottar betalingen direkte. Les mer i <a href="/kjopsvilkar">kjøpsvilkårene</a>.</p>
  </main>`;
  res.set("Cache-Control", "no-store");
  res.send(shell("Takk for betalingen", "Betalingen er registrert hos Stripe.", body, { robots: "noindex, nofollow", extraCss: RETURN_CSS }));
});

router.get("/betaling/avbrutt", (_req: Request, res: Response) => {
  const body = `<main class="pay-wrap">
    <h1>Betalingen ble ikke fullført</h1>
    <p>Du kan betale med lenken du fikk så lenge den gjelder (${checkoutMinutes()} minutter fra du sendte bestillingen).</p>
    <p>Betaler du ikke innen fristen, sendes bestillingen til produsenten med betaling ved henting.</p>
    <p>Vil du ikke ha varene likevel, kontakter du produsenten. Les mer i <a href="/kjopsvilkar">kjøpsvilkårene</a>.</p>
  </main>`;
  res.set("Cache-Control", "no-store");
  res.send(shell("Betalingen ble ikke fullført", "Betalingen ble ikke fullført.", body, { robots: "noindex, nofollow", extraCss: RETURN_CSS }));
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
    payments_mode: process.env.PAYMENTS_ENABLED === "1" ? "on" : process.env.PAYMENTS_ENABLED === "drain" ? "drain" : "off",
    open_payments: (getDb().prepare(`SELECT COUNT(*) AS n FROM payments WHERE status IN ('requires_payment','authorized')`).get() as { n: number }).n,
    // Money the producer may lose (lost reservation after confirmation,
    // capture that keeps failing) — the verifier/daily brief reads this.
    alerts_7d: getDb().prepare(`
      SELECT type, order_id, created_at AS at FROM payment_events
      WHERE type IN ('authorization_lost_after_confirm','capture_stuck','buyer_cancel_kept') AND created_at >= ?
      ORDER BY created_at DESC LIMIT 20
    `).all(new Date(Date.now() - 7 * 86400000).toISOString()),
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

// Lifecycle support (skive 3). Producers refund in their own Stripe
// Dashboard; these exist for support and rollback.
router.post("/admin/payments/maintenance", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const stripe = resolveStripeClient(req);
  if (!stripe) {
    res.status(503).json({ error: "Payments not configured" });
    return;
  }
  res.json({ success: true, result: await runPaymentMaintenance({ db: getDb(), stripe }) });
});

router.post("/admin/payments/:paymentId/refund", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const stripe = resolveStripeClient(req);
  if (!stripe) {
    res.status(503).json({ error: "Payments not configured" });
    return;
  }
  const raw = req.body?.amount_ore;
  const amountOre = raw === undefined || raw === null ? undefined : Number(raw);
  try {
    const out = await refundPayment(getDb(), stripe, String(req.params.paymentId || ""), {
      amountOre, reason: String(req.body?.reason || "admin_refund").slice(0, 60), source: "admin",
    });
    res.status(out.ok ? 200 : 409).json(out.ok ? { success: true, refunded_ore: out.refundedOre } : { success: false, error: out.error });
  } catch (err: any) {
    res.status(502).json({ error: "refund failed", detail: String(err?.message || err) });
  }
});

router.post("/admin/payments/release-all", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const stripe = resolveStripeClient(req);
  if (!stripe) {
    res.status(503).json({ error: "Payments not configured" });
    return;
  }
  res.json({ success: true, ...(await releaseAllOpenPayments(getDb(), stripe)) });
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
  // "drain" keeps the routes (webhook, admin, return pages) so open links and
  // reservations can be finished; owner onboarding refuses on its own (the
  // producer state is "disabled" unless PAYMENTS_ENABLED=1).
  if (!isPaymentsLifecycleActive(env)) return false;
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
