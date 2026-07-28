// ─── billing-provider.ts ──────────────────────────────────────────────
// dev-request 2026-07-13-billing-skjelett-moerkt (L4, Daniel-authorized
// 2026-07-20 — daniel-responses/2026-07-20-go-billing-skjelett-moerkt.md).
//
// The Stripe SEAM. Nothing in billing-service.ts or routes/admin-billing.ts
// calls the `stripe` npm package directly — everything goes through the
// BillingStripeClient interface below, exactly the way route-corridor-
// service.ts's RouteProvider decouples corridor maths from Mapbox/OSRM, and
// the way fetch-page.ts/search-enrich.test.ts inject `fetchImpl` instead of
// touching globalThis.fetch. Production resolves a real client (below);
// tests inject a fake object implementing the same three-method surface —
// no network access, no real API key, ever.
//
// Why this matters here specifically: CI has no live or test-mode Stripe API
// key available, and there must never be one hardcoded anywhere in this
// repo. So "green in CI against Stripe test-mode" (acceptance criterion 1)
// is satisfied by exercising the REAL subscription-state-machine code in
// billing-service.ts against an INJECTED fake client — the state machine
// code path is real, only the network call is swapped out.
//
// Webhook signature verification is the one exception that needs no fake at
// all: the `stripe` package's own webhooks helper
// (`Stripe.webhooks.constructEvent` / `generateTestHeaderString`) is a pure
// local HMAC computation — zero network access — so tests use the REAL
// `stripe` package for that specific code path, with an obviously-fake test
// secret (`whsec_...`), and it still genuinely proves a tampered
// payload/signature fails and a valid one passes.
//
// Env vars this module reads (NAMES only — no values are ever set here):
//   STRIPE_SECRET_KEY   — Stripe API secret key (sk_test_... in test mode).
//   STRIPE_WEBHOOK_SECRET — the webhook endpoint's signing secret (whsec_...).
//   BILLING_LIVE        — must be "1" (in addition to org fields below)
//                         before a live-mode (sk_live_...) key is honored.
//   BILLING_ORG_NR      — placeholder "org is ready for live billing" field;
//                         must be non-empty alongside BILLING_LIVE=1.
// None of these ever have a real value committed anywhere in this repo.

import Stripe from "stripe";

// ── The seam ─────────────────────────────────────────────────────────

export interface BillingCustomer {
  id: string;
}

/** The one field billing-service.ts needs off a subscription item. */
export interface BillingSubscriptionItem {
  current_period_end: number; // unix seconds — Stripe moved this to item-level (API 2025+)
}

/** The subset of a Stripe Subscription object billing-service.ts consumes. */
export interface BillingSubscriptionLike {
  id: string;
  customer: string;
  status: string; // Stripe's subscription status vocabulary — mapped by billing-service.ts
  items: { data: BillingSubscriptionItem[] };
}

export interface BillingWebhookEvent {
  id: string;
  type: string;
  data: { object: any };
}

export interface CreateCustomerParams {
  email?: string;
  metadata?: Record<string, string>;
}

export interface CreateSubscriptionParams {
  customer: string;
  items: Array<{ price: string }>;
  metadata?: Record<string, string>;
}

export interface UpdateSubscriptionParams {
  items: Array<{ price: string }>;
}

/**
 * The injectable seam. Production gets `createRealBillingStripeClient()`
 * (below); every test injects a fake object shaped like this instead —
 * matching this file's RouteProvider precedent (route-corridor-service.ts).
 */
export interface BillingStripeClient {
  customers: {
    create(params: CreateCustomerParams): Promise<BillingCustomer>;
  };
  subscriptions: {
    create(params: CreateSubscriptionParams): Promise<BillingSubscriptionLike>;
    update(id: string, params: UpdateSubscriptionParams): Promise<BillingSubscriptionLike>;
    cancel(id: string): Promise<BillingSubscriptionLike>;
  };
  webhooks: {
    constructEvent(payload: string | Buffer, signature: string | string[], secret: string): BillingWebhookEvent;
  };
}

/**
 * Real Stripe-backed adapter. `StripeCtor` is injectable purely so a test
 * COULD swap the constructor itself; in practice tests inject a
 * BillingStripeClient directly and never call this function at all — it is
 * only ever exercised in production, where a real (test-mode) key is
 * configured via STRIPE_SECRET_KEY.
 */
export function createRealBillingStripeClient(
  secretKey: string,
  StripeCtor: typeof Stripe = Stripe,
): BillingStripeClient {
  const stripe = new StripeCtor(secretKey);
  return {
    customers: {
      async create(params) {
        const c = await stripe.customers.create(params as any);
        return { id: c.id };
      },
    },
    subscriptions: {
      async create(params) {
        const s = await stripe.subscriptions.create(params as any);
        return s as unknown as BillingSubscriptionLike;
      },
      async update(id, params) {
        const s = await stripe.subscriptions.update(id, params as any);
        return s as unknown as BillingSubscriptionLike;
      },
      async cancel(id) {
        const s = await stripe.subscriptions.cancel(id);
        return s as unknown as BillingSubscriptionLike;
      },
    },
    webhooks: {
      constructEvent(payload, signature, secret) {
        // Pure local HMAC verification — no network call. Real `stripe`
        // package code path, exercised directly (with a fake test secret)
        // in billing-provider.test.ts.
        return stripe.webhooks.constructEvent(payload, signature, secret) as unknown as BillingWebhookEvent;
      },
    },
  };
}

// ── Live-key guard ───────────────────────────────────────────────────
//
// Acceptance criterion 4: the module must refuse to initialize/register
// routes with a live-shaped key (`sk_live_...`) unless BOTH an explicit
// BILLING_LIVE=1 gate AND an org-readiness field (BILLING_ORG_NR) are set.
// A test-mode key (`sk_test_...`), an obviously-fake/placeholder key, or no
// key at all is always allowed — this whole module is dark by default
// (BILLING_ENABLED unset), so there is nothing to guard against until
// someone deliberately flips BOTH BILLING_ENABLED and configures a live key.

export interface LiveGuardResult {
  allowed: boolean;
  reason?: string;
}

/** `sk_live_` is Stripe's own live-secret-key prefix convention. */
export function isLiveStripeKey(key: string | undefined | null): boolean {
  return typeof key === "string" && key.startsWith("sk_live_");
}

export function assertBillingKeyAllowed(env: NodeJS.ProcessEnv = process.env): LiveGuardResult {
  const key = env.STRIPE_SECRET_KEY || "";
  if (!isLiveStripeKey(key)) {
    // Unset, or test-mode (sk_test_...), or any non-live-shaped placeholder.
    return { allowed: true };
  }

  const liveGateSet = env.BILLING_LIVE === "1";
  const orgNr = (env.BILLING_ORG_NR || "").trim();
  if (!liveGateSet || !orgNr) {
    return {
      allowed: false,
      reason:
        "refusing to initialize billing with a live-mode Stripe key (sk_live_...): requires BOTH " +
        `BILLING_LIVE=1 (currently ${liveGateSet ? "set" : "unset"}) AND a non-empty BILLING_ORG_NR ` +
        `(currently ${orgNr ? "set" : "unset"}). Live activation needs Daniel's own separate legal/AS ` +
        "track — see dev-request 2026-07-13-billing-skjelett-moerkt.",
    };
  }
  return { allowed: true };
}
