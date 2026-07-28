// ─── billing-service.ts ───────────────────────────────────────────────
// dev-request 2026-07-13-billing-skjelett-moerkt (L4, Daniel-authorized
// 2026-07-20 — daniel-responses/2026-07-20-go-billing-skjelett-moerkt.md).
//
// The subscription state machine + entitlement mechanism. Pure domain logic
// against an injected `db` handle (better-sqlite3, same convention as every
// other service in this repo — see route-corridor-service.ts's `rfbDb`/
// `experiencesDb` params) and an injected BillingStripeClient (see
// billing-provider.ts) — never touches `getDb()` or a real Stripe client
// directly, so it is fully testable offline.
//
// Tables (src/database/init.ts, additive, CREATE TABLE IF NOT EXISTS only):
//   billing_subscriptions  — one row per subscription (agent_id, plan,
//                            status, stripe ids, current_period_end).
//   billing_entitlements   — (agent_id, feature_key) -> granted, the
//                            entitlement-check MECHANISM. Wired ONLY to the
//                            two demo/stub feature keys below — NOT to any
//                            of today's real dashboard features (stats,
//                            product catalog, etc. stay free). Which real
//                            features eventually become premium is a
//                            separate future decision/request.
//   billing_webhook_events — stripe_event_id PRIMARY KEY idempotency ledger:
//                            a duplicate webhook delivery is a no-op.
//
// This module is never imported/mounted unless BILLING_ENABLED=1 (see
// routes/admin-billing.ts's mountBillingRoutes() + src/index.ts) — flag off
// means this code never runs, full stop.

import { randomUUID } from "crypto";
import type { BillingStripeClient, BillingSubscriptionLike, BillingWebhookEvent } from "./billing-provider";

// ── Plan catalog ─────────────────────────────────────────────────────
//
// "Produsent-Premium" 199/499 kr/mnd — placeholders per the dev-request
// ("final pricing decisions beyond the 199/499 placeholders" is an explicit
// non-goal). Each plan's Stripe Price id is read from its own env var NAME
// at call time (never hardcoded, never a real id in this repo); when unset
// (always true in CI / today) a placeholder id is used instead — fine,
// because the injected fake Stripe client in tests never actually validates
// a Price id against a real Stripe account.

export type BillingPlan = "produsent_premium_199" | "produsent_premium_499";

export const BILLING_PLANS: Record<
  BillingPlan,
  { label: string; priceNokPerMonth: number; stripePriceEnvVar: string }
> = {
  produsent_premium_199: {
    label: "Produsent-Premium",
    priceNokPerMonth: 199,
    stripePriceEnvVar: "STRIPE_PRICE_PRODUSENT_PREMIUM_199",
  },
  produsent_premium_499: {
    label: "Produsent-Premium Pluss",
    priceNokPerMonth: 499,
    stripePriceEnvVar: "STRIPE_PRICE_PRODUSENT_PREMIUM_499",
  },
};

export function isBillingPlan(value: unknown): value is BillingPlan {
  return value === "produsent_premium_199" || value === "produsent_premium_499";
}

function resolvePriceId(plan: BillingPlan, env: NodeJS.ProcessEnv = process.env): string {
  return env[BILLING_PLANS[plan].stripePriceEnvVar] || `price_placeholder_${plan}`;
}

// ── The entitlement-check mechanism ──────────────────────────────────
//
// Acceptance criterion 2: the subscription -> entitlement -> gate chain,
// proven end-to-end against >=2 placeholder/stub gates. These feature keys
// are demo-only and are NEVER read by any real dashboard route.
export const DEMO_ENTITLEMENT_FEATURES = ["demo_premium_widget", "demo_premium_export"] as const;
export type DemoEntitlementFeature = (typeof DEMO_ENTITLEMENT_FEATURES)[number];

export type BillingSubscriptionStatus = "incomplete" | "active" | "past_due" | "canceled";

export interface BillingSubscriptionRow {
  id: string;
  agent_id: string;
  plan: BillingPlan;
  status: BillingSubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingEntitlementRow {
  agent_id: string;
  feature_key: string;
  granted: number;
  source: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Stripe's subscription-status vocabulary, mapped onto our narrower one. */
export function mapStripeStatus(stripeStatus: string): BillingSubscriptionStatus {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      // "incomplete" and anything Stripe adds in the future that we don't
      // yet recognize — treated as not-yet-entitled rather than guessing.
      return "incomplete";
  }
}

function periodEndFromStripeSub(sub: BillingSubscriptionLike): string | null {
  const item = sub.items?.data?.[0];
  if (!item || typeof item.current_period_end !== "number") return null;
  return new Date(item.current_period_end * 1000).toISOString();
}

/**
 * Grants/revokes the demo entitlement gates for one agent based on
 * subscription status. `active` -> granted; anything else (incomplete,
 * past_due, canceled) -> revoked. Idempotent upsert, one row per
 * (agent_id, feature_key) — a re-sync is a no-op if nothing changed.
 */
export function syncEntitlementsForStatus(
  db: any,
  agentId: string,
  status: BillingSubscriptionStatus,
  ts: string = nowIso(),
): void {
  const granted = status === "active" ? 1 : 0;
  const stmt = db.prepare(
    `INSERT INTO billing_entitlements (agent_id, feature_key, granted, source, updated_at)
     VALUES (?, ?, ?, 'subscription', ?)
     ON CONFLICT(agent_id, feature_key) DO UPDATE SET
       granted = excluded.granted,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  );
  for (const feature of DEMO_ENTITLEMENT_FEATURES) {
    stmt.run(agentId, feature, granted, ts);
  }
}

/** THE entitlement check. Reads billing_entitlements only — nothing else. */
export function checkEntitlement(db: any, agentId: string, featureKey: string): boolean {
  const row = db
    .prepare(`SELECT granted FROM billing_entitlements WHERE agent_id = ? AND feature_key = ?`)
    .get(agentId, featureKey) as { granted: number } | undefined;
  return !!row && row.granted === 1;
}

export function listEntitlements(db: any, agentId: string): BillingEntitlementRow[] {
  return db
    .prepare(`SELECT agent_id, feature_key, granted, source, updated_at FROM billing_entitlements WHERE agent_id = ? ORDER BY feature_key`)
    .all(agentId) as BillingEntitlementRow[];
}

export function getSubscriptionById(db: any, id: string): BillingSubscriptionRow | undefined {
  return db.prepare(`SELECT * FROM billing_subscriptions WHERE id = ?`).get(id) as BillingSubscriptionRow | undefined;
}

export function listSubscriptionsForAgent(db: any, agentId: string): BillingSubscriptionRow[] {
  return db
    .prepare(`SELECT * FROM billing_subscriptions WHERE agent_id = ? ORDER BY created_at DESC`)
    .all(agentId) as BillingSubscriptionRow[];
}

// ── Lifecycle: create ────────────────────────────────────────────────

export interface CreateSubscriptionParams {
  db: any;
  stripe: BillingStripeClient;
  agentId: string;
  plan: BillingPlan;
  email?: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
}

export async function createSubscription(params: CreateSubscriptionParams): Promise<BillingSubscriptionRow> {
  const { db, stripe, agentId, plan, email } = params;
  const env = params.env ?? process.env;
  const ts = params.now ?? nowIso();

  const customer = await stripe.customers.create({ email, metadata: { agent_id: agentId } });
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: resolvePriceId(plan, env) }],
    metadata: { agent_id: agentId, plan },
  });

  const id = randomUUID();
  const status = mapStripeStatus(sub.status);
  const periodEnd = periodEndFromStripeSub(sub);

  db.prepare(
    `INSERT INTO billing_subscriptions
       (id, agent_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, agentId, plan, status, customer.id, sub.id, periodEnd, ts, ts);

  syncEntitlementsForStatus(db, agentId, status, ts);

  return getSubscriptionById(db, id)!;
}

// ── Lifecycle: upgrade (also used for downgrade — same operation) ───

export interface ChangeSubscriptionPlanParams {
  db: any;
  stripe: BillingStripeClient;
  id: string;
  plan: BillingPlan;
  env?: NodeJS.ProcessEnv;
  now?: string;
}

export async function upgradeSubscription(params: ChangeSubscriptionPlanParams): Promise<BillingSubscriptionRow> {
  const { db, stripe, id, plan } = params;
  const env = params.env ?? process.env;
  const ts = params.now ?? nowIso();

  const row = getSubscriptionById(db, id);
  if (!row) throw new Error(`billing subscription not found: ${id}`);
  if (!row.stripe_subscription_id) throw new Error(`billing subscription ${id} has no stripe_subscription_id`);

  const sub = await stripe.subscriptions.update(row.stripe_subscription_id, {
    items: [{ price: resolvePriceId(plan, env) }],
  });

  const status = mapStripeStatus(sub.status);
  const periodEnd = periodEndFromStripeSub(sub);

  db.prepare(
    `UPDATE billing_subscriptions SET plan = ?, status = ?, current_period_end = ?, updated_at = ? WHERE id = ?`,
  ).run(plan, status, periodEnd, ts, id);

  syncEntitlementsForStatus(db, row.agent_id, status, ts);

  return getSubscriptionById(db, id)!;
}

// ── Lifecycle: cancel ────────────────────────────────────────────────

export interface CancelSubscriptionParams {
  db: any;
  stripe: BillingStripeClient;
  id: string;
  now?: string;
}

export async function cancelSubscription(params: CancelSubscriptionParams): Promise<BillingSubscriptionRow> {
  const { db, stripe, id } = params;
  const ts = params.now ?? nowIso();

  const row = getSubscriptionById(db, id);
  if (!row) throw new Error(`billing subscription not found: ${id}`);
  if (!row.stripe_subscription_id) throw new Error(`billing subscription ${id} has no stripe_subscription_id`);

  const sub = await stripe.subscriptions.cancel(row.stripe_subscription_id);
  // Stripe returns status "canceled" on a successful cancel call; map
  // defensively through mapStripeStatus() rather than hardcoding, in case a
  // fake test client (or a future real response) reports something else.
  const status = mapStripeStatus(sub.status);

  db.prepare(`UPDATE billing_subscriptions SET status = ?, updated_at = ? WHERE id = ?`).run(status, ts, id);
  syncEntitlementsForStatus(db, row.agent_id, status, ts);

  return getSubscriptionById(db, id)!;
}

// ── Webhooks — idempotent ────────────────────────────────────────────
//
// Acceptance criterion 4 (webhooks verified with signature check) +
// db-idempotency requirement: a duplicate stripe_event_id is a no-op, not a
// double-apply. `billing_webhook_events.stripe_event_id` is the PRIMARY KEY
// enforcing this at the schema level too (belt-and-braces with the explicit
// pre-check below, which lets us report `duplicate: true` distinctly from a
// fresh apply rather than relying on a caught constraint-violation).

export type HandleWebhookResult =
  | { ok: true; duplicate: boolean; eventId: string; type: string }
  | { ok: false; error: string };

export interface HandleWebhookParams {
  db: any;
  stripe: BillingStripeClient;
  payload: string | Buffer;
  signature: string | string[];
  secret: string;
  now?: string;
}

export async function handleBillingWebhook(params: HandleWebhookParams): Promise<HandleWebhookResult> {
  const { db, stripe, payload, signature, secret } = params;
  const ts = params.now ?? nowIso();

  let event: BillingWebhookEvent;
  try {
    // Real `stripe` package signature verification (see billing-provider.ts)
    // — a tampered payload or wrong secret throws here.
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (err: any) {
    return { ok: false, error: `signature verification failed: ${err?.message || String(err)}` };
  }

  const existing = db.prepare(`SELECT 1 FROM billing_webhook_events WHERE stripe_event_id = ?`).get(event.id);
  if (existing) {
    return { ok: true, duplicate: true, eventId: event.id, type: event.type };
  }

  const obj = event.data?.object || {};
  const stripeSubId: string | undefined = obj.id;
  if (stripeSubId && event.type.startsWith("customer.subscription.")) {
    const row = db
      .prepare(`SELECT * FROM billing_subscriptions WHERE stripe_subscription_id = ?`)
      .get(stripeSubId) as BillingSubscriptionRow | undefined;
    if (row) {
      const status: BillingSubscriptionStatus =
        event.type === "customer.subscription.deleted" ? "canceled" : mapStripeStatus(obj.status || row.status);
      db.prepare(`UPDATE billing_subscriptions SET status = ?, updated_at = ? WHERE id = ?`).run(status, ts, row.id);
      syncEntitlementsForStatus(db, row.agent_id, status, ts);
    }
  }

  // Recorded LAST: if anything above throws, the event is not marked
  // processed, so a legitimate retry from Stripe can still apply it. The
  // PRIMARY KEY on stripe_event_id also means a genuine race (two deliveries
  // landing concurrently) fails the second INSERT rather than double-applying.
  try {
    db.prepare(`INSERT INTO billing_webhook_events (stripe_event_id, type, received_at) VALUES (?, ?, ?)`).run(
      event.id,
      event.type,
      ts,
    );
  } catch {
    // Lost the race against a concurrent delivery of the same event — the
    // other delivery already recorded it and (if applicable) applied the
    // subscription update. Treat as duplicate, not an error.
    return { ok: true, duplicate: true, eventId: event.id, type: event.type };
  }

  return { ok: true, duplicate: false, eventId: event.id, type: event.type };
}
