// ─── payment-provider.ts ──────────────────────────────────────────────
// A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect (L4,
// Daniel-authorized 2026-10-09 — daniel-responses/2026-10-09-live-go-
// betaling-stripe-connect.md), skive 1.
//
// The Stripe Connect SEAM for paying producers for goods. Same pattern as
// billing-provider.ts (the dark subscription skeleton): nothing in
// payment-service.ts or routes/payments.ts calls the `stripe` npm package
// directly — everything goes through PaymentsStripeClient below, so tests
// inject a fake object and CI never needs a Stripe key. Webhook signature
// verification is the one exception: the `stripe` package's own
// constructEvent() is a pure local HMAC, so tests run the real code path
// with an obviously fake secret.
//
// Subscriptions (billing-provider.ts) and payment for goods (this file) stay
// separate on purpose: separate tables, separate webhook route, separate
// webhook secret, separate live gate.
//
// Stripe setup (binding, see the dev-request «Valgt Stripe-oppsett»):
// direct charges on the PRODUCER's own Stripe account. The account is
// created with the controller properties of a Standard account —
// fees.payer=account (Stripe bills the producer), losses.payments=stripe
// (Stripe, not the platform, carries negative balances),
// requirement_collection=stripe, stripe_dashboard.type=full. The platform's
// own Stripe balance never receives payment for goods.
//
// Env vars this module reads (NAMES only — no value is ever committed):
//   STRIPE_SECRET_KEY              — shared with billing-provider.ts
//                                    (sk_test_… in test mode). A live key
//                                    (sk_live_… or a restricted rk_live_…)
//                                    is only honored by assertPaymentsKeyAllowed().
//   STRIPE_CONNECT_WEBHOOK_SECRET  — signing secret of the CONNECT webhook
//                                    endpoint (events on connected accounts).
//                                    Deliberately not STRIPE_WEBHOOK_SECRET,
//                                    which belongs to the billing skeleton.
//   PAYMENTS_LIVE                  — must be "1" before a live key is honored.
//   PAYMENTS_ORG_NR                — must equal the company's org.nr
//                                    (COMPANY_INFO.orgNr) before a live key
//                                    is honored.

import Stripe from "stripe";
import { COMPANY_INFO } from "../config/company-info";
import { KJOPSVILKAR_PREPAYMENT_LIVE } from "../config/payments-terms";

// ── The seam ─────────────────────────────────────────────────────────

/** The subset of a Stripe Account object payment-service.ts consumes. */
export interface ConnectAccountLike {
  id: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  business_type?: string | null;
  requirements?: {
    disabled_reason?: string | null;
    currently_due?: string[] | null;
    past_due?: string[] | null;
    pending_verification?: string[] | null;
  } | null;
}

export interface ConnectAccountLinkLike {
  url: string;
  expires_at?: number;
}

export interface PaymentsWebhookEvent {
  id: string;
  type: string;
  /** Unix seconds — used to ignore an account snapshot older than the last one applied. */
  created?: number;
  livemode?: boolean;
  /** Set on events that happened on a connected account (Connect endpoint). */
  account?: string | null;
  data: { object: any };
}

export interface CreateConnectAccountParams {
  country: "NO";
  email?: string;
  business_profile?: { name?: string; url?: string; product_description?: string };
  controller: {
    fees: { payer: "account" };
    losses: { payments: "stripe" };
    requirement_collection: "stripe";
    stripe_dashboard: { type: "full" };
  };
  metadata?: Record<string, string>;
}

export interface CreateAccountLinkParams {
  account: string;
  refresh_url: string;
  return_url: string;
  type: "account_onboarding";
}

/**
 * The injectable seam. Production gets createRealPaymentsStripeClient();
 * every test injects a fake object shaped like this instead.
 */
export interface PaymentsStripeClient {
  accounts: {
    create(params: CreateConnectAccountParams, opts?: { idempotencyKey?: string }): Promise<ConnectAccountLike>;
    retrieve(id: string): Promise<ConnectAccountLike>;
  };
  accountLinks: {
    create(params: CreateAccountLinkParams): Promise<ConnectAccountLinkLike>;
  };
  webhooks: {
    constructEvent(payload: string | Buffer, signature: string | string[], secret: string): PaymentsWebhookEvent;
  };
}

/** The controller properties every producer account is created with. */
export const PRODUCER_ACCOUNT_CONTROLLER: CreateConnectAccountParams["controller"] = Object.freeze({
  fees: Object.freeze({ payer: "account" as const }),
  losses: Object.freeze({ payments: "stripe" as const }),
  requirement_collection: "stripe" as const,
  stripe_dashboard: Object.freeze({ type: "full" as const }),
}) as CreateConnectAccountParams["controller"];

/**
 * Real Stripe-backed adapter. Only ever constructed in production, with the
 * key from STRIPE_SECRET_KEY, after assertPaymentsKeyAllowed() said yes.
 */
export function createRealPaymentsStripeClient(
  secretKey: string,
  StripeCtor: typeof Stripe = Stripe,
): PaymentsStripeClient {
  const stripe = new StripeCtor(secretKey);
  return {
    accounts: {
      async create(params, opts) {
        const a = await stripe.accounts.create(params, opts);
        return a as unknown as ConnectAccountLike;
      },
      async retrieve(id) {
        const a = await stripe.accounts.retrieve(id);
        return a as unknown as ConnectAccountLike;
      },
    },
    accountLinks: {
      async create(params) {
        const l = await stripe.accountLinks.create(params);
        return { url: l.url, expires_at: l.expires_at };
      },
    },
    webhooks: {
      constructEvent(payload, signature, secret) {
        return stripe.webhooks.constructEvent(payload, signature, secret) as unknown as PaymentsWebhookEvent;
      },
    },
  };
}

// ── Mode + live-key guard ────────────────────────────────────────────

/**
 * Live-mode secret keys: `sk_live_…` and restricted `rk_live_…`. The
 * billing guard only knows sk_live_; payments must also catch the
 * restricted key Daniel creates at go-live.
 */
export function isLivePaymentsKey(key: string | undefined | null): boolean {
  return typeof key === "string" && (key.startsWith("sk_live_") || key.startsWith("rk_live_"));
}

/** Which Stripe mode the configured key talks to. Test mode unless live-shaped. */
export function paymentsLivemode(env: NodeJS.ProcessEnv = process.env): boolean {
  return isLivePaymentsKey(env.STRIPE_SECRET_KEY);
}

export interface PaymentsGuardResult {
  allowed: boolean;
  reason?: string;
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/**
 * A live key is honored only when ALL of these hold:
 *   - PAYMENTS_LIVE=1 (Daniel's own flip);
 *   - PAYMENTS_ORG_NR equals the company's org.nr (COMPANY_INFO.orgNr);
 *   - KJOPSVILKAR_PREPAYMENT_LIVE is true — the terms of purchase
 *     (/kjopsvilkar §4) have been rewritten from «under innføring» to the
 *     live wording. This makes it impossible to take real prepayments
 *     under terms that still say prepayment is not available.
 * A test key, a placeholder or no key is always allowed (test mode).
 */
export function assertPaymentsKeyAllowed(
  env: NodeJS.ProcessEnv = process.env,
  termsLive: boolean = KJOPSVILKAR_PREPAYMENT_LIVE,
): PaymentsGuardResult {
  const key = env.STRIPE_SECRET_KEY || "";
  if (!isLivePaymentsKey(key)) return { allowed: true };

  const liveGateSet = env.PAYMENTS_LIVE === "1";
  const orgNr = digitsOnly(env.PAYMENTS_ORG_NR || "");
  const orgOk = orgNr !== "" && orgNr === COMPANY_INFO.orgNr;
  if (!liveGateSet || !orgOk || !termsLive) {
    return {
      allowed: false,
      reason:
        "refusing a live-mode Stripe key for payments: requires PAYMENTS_LIVE=1 " +
        `(currently ${liveGateSet ? "set" : "unset"}), PAYMENTS_ORG_NR equal to the company org.nr ` +
        `(currently ${orgNr ? (orgOk ? "matching" : "not matching") : "unset"}) and live wording in ` +
        `/kjopsvilkar §4 (KJOPSVILKAR_PREPAYMENT_LIVE is ${termsLive}). ` +
        "See A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect.",
    };
  }
  return { allowed: true };
}
