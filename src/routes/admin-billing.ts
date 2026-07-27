// ─── Billing skeleton — Produsent-Premium (test-mode Stripe) ────────────
// dev-request 2026-07-13-billing-skjelett-moerkt (L4, Daniel-authorized
// 2026-07-20 — daniel-responses/2026-07-20-go-billing-skjelett-moerkt.md).
//
// A DARK skeleton: nothing here is reachable unless BILLING_ENABLED=1 (see
// mountBillingRoutes() below, called unconditionally from src/index.ts —
// the flag check lives here so router-mounting is unit-testable without
// booting the whole app). Zero live billing, zero Vipps, zero invoicing UI,
// zero real dashboard feature gated — see the two demo/* stub routes below,
// which prove the subscription -> entitlement -> gate MECHANISM works
// without touching anything currently free (stats, product catalog, etc.).
//
// Auth: this entire surface (except the Stripe webhook receiver, which is
// authenticated by signature verification instead) is X-Admin-Key gated,
// admin-key-gated end to end — reasonable for a dark/skeleton surface with
// no real subscriber-facing UI yet. requireAdmin() below is a deliberate
// COPY of admin-agents.ts's requireAdmin(), not an import: hard constraint 2
// of the dev-request requires this surface to stay standalone and never
// import from/touch owner-portal.ts, the magic-link flow, or any
// session/cookie auth code — replicating the same X-Admin-Key convention
// keeps this file self-contained instead of reaching into another route
// module for it.
//
// Env vars (NAMES only — no real value is ever set in this repo):
//   BILLING_ENABLED           "1" to mount this router at all. Any other
//                              value (including unset) = zero routes.
//   STRIPE_SECRET_KEY         Stripe API secret key (sk_test_... in test
//                              mode). See billing-provider.ts's live-guard.
//   STRIPE_WEBHOOK_SECRET     the webhook endpoint's signing secret.
//   BILLING_LIVE / BILLING_ORG_NR  live-mode guard, see billing-provider.ts.
//   STRIPE_PRICE_PRODUSENT_PREMIUM_199 / _499  Stripe Price ids, see
//                              billing-service.ts's BILLING_PLANS.

import { Router, Request, Response } from "express";
import type { Application } from "express";
import { getDb } from "../database/init";
import {
  createRealBillingStripeClient,
  assertBillingKeyAllowed,
  type BillingStripeClient,
} from "../services/billing-provider";
import {
  createSubscription,
  upgradeSubscription,
  cancelSubscription,
  handleBillingWebhook,
  checkEntitlement,
  listEntitlements,
  listSubscriptionsForAgent,
  isBillingPlan,
  BILLING_PLANS,
  DEMO_ENTITLEMENT_FEATURES,
} from "../services/billing-service";

const router = Router();

// ── Admin auth (copy of admin-agents.ts's requireAdmin — see file header) ──
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

// ── Injectable Stripe client seam ────────────────────────────────────
// Mirrors the app.set()/app.get() test seam already used elsewhere in this
// repo (see tests/test.ts's "SHARED GLOBAL STATE" note re:
// titleNoBackfillFetchImpl) rather than a module-level global: tests inject
// a fake BillingStripeClient via `app.set("billingStripeClient", fake)` on
// their own throwaway Express app/router, so nothing here ever needs
// globalThis mutation or a real network-touching Stripe client to be
// exercised.
//
// Live-key guard, REQUEST path: mountBillingRoutes() below only runs the
// assertBillingKeyAllowed() guard once, at server-boot time — that alone is
// not enough, because STRIPE_SECRET_KEY can change out from under an
// already-running process (secrets-manager push, ops typo, an env-only
// redeploy that never restarts the process). Every request handler below
// resolves its Stripe client through this one function, so the guard is
// re-checked here, on every request that would otherwise construct a real
// (non-injected) Stripe client — not just at the moment the process booted.
// A test-injected client (`billingStripeClient` on req.app) bypasses this by
// design: it is never a real network-touching Stripe client, so there is
// nothing for the live-guard to protect against there.
//
// Sends the 503 response itself (same pattern as requireAdmin() above) so
// every call site collapses to `const stripe = resolveStripeClient(req,
// res); if (!stripe) return;` — the "not configured" and "live key blocked"
// cases both fail the same 503-shaped way, never an unhandled exception.
function resolveStripeClient(req: Request, res: Response): BillingStripeClient | null {
  const injected = req.app.get("billingStripeClient") as BillingStripeClient | undefined;
  if (injected) return injected;
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) {
    res.status(503).json({ error: "Billing not configured (STRIPE_SECRET_KEY unset)" });
    return null;
  }
  const guard = assertBillingKeyAllowed();
  if (!guard.allowed) {
    res.status(503).json({ error: "Billing not configured (live-mode Stripe key blocked)", detail: guard.reason });
    return null;
  }
  return createRealBillingStripeClient(key);
}

function resolveWebhookSecret(req: Request): string {
  const injected = req.app.get("billingWebhookSecret") as string | undefined;
  if (injected) return injected;
  return process.env.STRIPE_WEBHOOK_SECRET || "";
}

// ── Plans (admin-visible, for the dark control surface only) ────────────
router.get("/plans", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json({ success: true, plans: BILLING_PLANS, demo_entitlement_features: DEMO_ENTITLEMENT_FEATURES });
});

// ── Subscription lifecycle ───────────────────────────────────────────

router.post("/subscriptions", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const agentId = String(req.body?.agent_id || "").trim();
  const plan = req.body?.plan;
  const email = req.body?.email ? String(req.body.email) : undefined;

  if (!agentId) {
    res.status(400).json({ error: "agent_id required" });
    return;
  }
  if (!isBillingPlan(plan)) {
    res.status(400).json({ error: "invalid plan", detail: `plan must be one of: ${Object.keys(BILLING_PLANS).join(", ")}` });
    return;
  }
  const stripe = resolveStripeClient(req, res);
  if (!stripe) return;

  try {
    const subscription = await createSubscription({ db: getDb(), stripe, agentId, plan, email });
    res.status(201).json({ success: true, subscription });
  } catch (err: any) {
    res.status(500).json({ error: "failed to create subscription", detail: String(err?.message || err) });
  }
});

router.post("/subscriptions/:id/upgrade", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const plan = req.body?.plan;
  if (!isBillingPlan(plan)) {
    res.status(400).json({ error: "invalid plan", detail: `plan must be one of: ${Object.keys(BILLING_PLANS).join(", ")}` });
    return;
  }
  const stripe = resolveStripeClient(req, res);
  if (!stripe) return;
  try {
    const subscription = await upgradeSubscription({ db: getDb(), stripe, id: String(req.params.id), plan });
    res.json({ success: true, subscription });
  } catch (err: any) {
    res.status(404).json({ error: "subscription not found or upgrade failed", detail: String(err?.message || err) });
  }
});

router.post("/subscriptions/:id/cancel", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const stripe = resolveStripeClient(req, res);
  if (!stripe) return;
  try {
    const subscription = await cancelSubscription({ db: getDb(), stripe, id: String(req.params.id) });
    res.json({ success: true, subscription });
  } catch (err: any) {
    res.status(404).json({ error: "subscription not found or cancel failed", detail: String(err?.message || err) });
  }
});

router.get("/subscriptions/agent/:agentId", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json({ success: true, subscriptions: listSubscriptionsForAgent(getDb(), String(req.params.agentId)) });
});

router.get("/entitlements/:agentId", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json({ success: true, entitlements: listEntitlements(getDb(), String(req.params.agentId)) });
});

// ── Stripe webhook receiver ──────────────────────────────────────────
// Not X-Admin-Key gated — a real Stripe webhook call carries no admin key,
// only the `stripe-signature` header. Signature verification (via the
// injected/real Stripe client — see resolveStripeClient()) IS the auth.
//
// Raw-body note: src/index.ts's global express.json() middleware captures
// the exact raw request bytes into `req.rawBody` via a `verify` callback
// (added for this dev-request) specifically so Stripe's HMAC — computed
// over the raw bytes, not a re-serialization of the parsed body — can be
// verified correctly here. Falls back to JSON.stringify(req.body) only if
// rawBody somehow wasn't captured (defensive; should not happen given the
// global middleware).
router.post("/webhook", async (req: Request, res: Response) => {
  const stripe = resolveStripeClient(req, res);
  if (!stripe) return;
  const secret = resolveWebhookSecret(req);
  if (!secret) {
    res.status(503).json({ error: "Webhook not configured (STRIPE_WEBHOOK_SECRET unset)" });
    return;
  }
  const signature = req.headers["stripe-signature"] as string | undefined;
  if (!signature) {
    res.status(400).json({ error: "missing stripe-signature header" });
    return;
  }
  const rawBody = (req as any).rawBody as Buffer | undefined;
  const payload = rawBody ?? JSON.stringify(req.body ?? {});

  const result = await handleBillingWebhook({ db: getDb(), stripe, payload, signature, secret });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ received: true, duplicate: result.duplicate, event_id: result.eventId, type: result.type });
});

// ── Demo/stub premium gates (acceptance criterion 2) ─────────────────
// Deliberately NOT any real dashboard function — stats, product catalog,
// etc. stay free (they're deliberately free right now to drive claim-rate).
// These two isolated, admin-key-gated demo endpoints exist ONLY to prove
// the subscription -> entitlement -> gate chain end to end. Which real
// features eventually become premium is a separate future decision/request.
function requireDemoEntitlement(featureKey: string, req: Request, res: Response): boolean {
  const agentId = String(req.query.agent_id || req.headers["x-agent-id"] || "").trim();
  if (!agentId) {
    res.status(400).json({ error: "agent_id required (?agent_id= query param or X-Agent-Id header)" });
    return false;
  }
  if (!checkEntitlement(getDb(), agentId, featureKey)) {
    res.status(402).json({ error: "not entitled", feature_key: featureKey, agent_id: agentId });
    return false;
  }
  return true;
}

router.get("/demo/premium-widget", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  if (!requireDemoEntitlement("demo_premium_widget", req, res)) return;
  res.json({
    success: true,
    feature_key: "demo_premium_widget",
    widget: { stub: true, message: "Demo-widget bak entitlement-sjekken. Ingen ekte dashboard-funksjon." },
  });
});

router.get("/demo/premium-export", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  if (!requireDemoEntitlement("demo_premium_export", req, res)) return;
  res.json({
    success: true,
    feature_key: "demo_premium_export",
    export: { stub: true, rows: [] },
  });
});

// ── Router-mounting logic (acceptance criterion 3 + 4) ───────────────
export function isBillingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BILLING_ENABLED === "1";
}

/**
 * Called UNCONDITIONALLY from src/index.ts (same call site/comment style as
 * the CRM_ENABLED block) — the flag + live-key-guard checks live in here so
 * they are testable without booting the whole app: a test can build a bare
 * `express()` app, call this, and assert `app.router.stack.length === 0`
 * when BILLING_ENABLED is unset (acceptance criterion 3), or that it stays
 * 0 even with BILLING_ENABLED=1 if a live-shaped key lacks the live-guard
 * (acceptance criterion 4).
 */
export function mountBillingRoutes(app: Application, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isBillingEnabled(env)) return false;
  const guard = assertBillingKeyAllowed(env);
  if (!guard.allowed) {
    console.error(`billing: ${guard.reason}`);
    return false;
  }
  app.use("/admin/billing", router);
  return true;
}

export default router;
