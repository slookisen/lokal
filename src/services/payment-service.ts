// ─── payment-service.ts ───────────────────────────────────────────────
// A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect (L4,
// Daniel-authorized 2026-10-09), skive 1: producer onboarding to Stripe
// Connect + the Connect webhook that tells us when a producer can take
// prepayment.
//
// Domain logic against an injected `db` handle and an injected
// PaymentsStripeClient (payment-provider.ts) — never a real Stripe client
// directly, so everything here is testable offline.
//
// Who may onboard (all must hold):
//   - PAYMENTS_ENABLED=1 (default off — nothing here runs otherwise);
//   - the producer is on the pilot list (PAYMENTS_ALLOWED_AGENT_IDS). In
//     TEST mode the list is mandatory: an empty list lets nobody in, so real
//     producers can never end up with a test-mode Stripe account. In LIVE
//     mode an empty list means every producer that passes the next clause;
//   - isEligibleForRealOrder(agentId) — prepayment rides on top of real
//     orders and never opens a way around that gate (unchanged, read-only
//     use here).
// A producer can take prepayment when, on top of that, its Stripe account
// for the current mode reports charges_enabled (account.updated webhook).

import { randomUUID } from "crypto";
import { isEligibleForRealOrder } from "./cart-service";
import { slugify } from "../utils/slug";
import {
  PRODUCER_ACCOUNT_CONTROLLER,
  assertPaymentsKeyAllowed,
  paymentsLivemode,
  type ConnectAccountLike,
  type PaymentsStripeClient,
  type PaymentsWebhookEvent,
} from "./payment-provider";

// ── Flags ────────────────────────────────────────────────────────────

export function isPaymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAYMENTS_ENABLED === "1";
}

export function paymentsAllowedAgentIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PAYMENTS_ALLOWED_AGENT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pilot list check — see the header for the test/live difference. */
export function isAgentAllowedForPayments(agentId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = paymentsAllowedAgentIds(env);
  if (list.length > 0) return list.includes(agentId);
  return paymentsLivemode(env);
}

// ── Accounts ─────────────────────────────────────────────────────────

export interface PaymentAccountRow {
  id: string;
  agent_id: string;
  livemode: number;
  stripe_account_id: string;
  charges_enabled: number;
  payouts_enabled: number;
  details_submitted: number;
  business_type: string | null;
  disabled_reason: string | null;
  charges_enabled_at: string | null;
  created_at: string;
  updated_at: string;
}

export function getPaymentAccount(db: any, agentId: string, livemode: boolean): PaymentAccountRow | null {
  const row = db
    .prepare(`SELECT * FROM payment_accounts WHERE agent_id = ? AND livemode = ?`)
    .get(agentId, livemode ? 1 : 0) as PaymentAccountRow | undefined;
  return row ?? null;
}

export type ProducerPaymentState =
  | "disabled"      // PAYMENTS_ENABLED off, or a live key the guard refuses
  | "not_allowed"   // not on the pilot list
  | "not_eligible"  // fails isEligibleForRealOrder (e.g. orders not switched on)
  | "not_started"   // no Stripe account for this mode yet
  | "onboarding"    // account exists, Stripe onboarding not finished
  | "restricted"    // Stripe has disabled charges and wants more information
  | "active";       // charges_enabled — can take prepayment

export interface ProducerPaymentStatus {
  state: ProducerPaymentState;
  livemode: boolean;
  account: PaymentAccountRow | null;
}

export function getProducerPaymentStatus(
  db: any,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): ProducerPaymentStatus {
  const livemode = paymentsLivemode(env);
  if (!isPaymentsEnabled(env) || !assertPaymentsKeyAllowed(env).allowed) {
    return { state: "disabled", livemode, account: null };
  }
  if (!isAgentAllowedForPayments(agentId, env)) return { state: "not_allowed", livemode, account: null };
  const account = getPaymentAccount(db, agentId, livemode);
  if (!isEligibleForRealOrder(agentId, db)) return { state: "not_eligible", livemode, account };
  if (!account) return { state: "not_started", livemode, account: null };
  if (account.charges_enabled === 1) return { state: "active", livemode, account };
  if (account.disabled_reason && account.details_submitted === 1) return { state: "restricted", livemode, account };
  return { state: "onboarding", livemode, account };
}

/** The one question skive 2 asks before creating a payment link. */
export function canProducerTakePrepayment(db: any, agentId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return getProducerPaymentStatus(db, agentId, env).state === "active";
}

function logPaymentEvent(
  db: any,
  e: {
    paymentId?: string | null;
    orderId?: string | null;
    agentId?: string | null;
    stripeEventId?: string | null;
    source: "webhook" | "owner" | "admin" | "system";
    type: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    detail?: string | null;
    now: string;
  },
): void {
  db.prepare(`
    INSERT INTO payment_events
      (id, payment_id, order_id, agent_id, stripe_event_id, source, type, from_status, to_status, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    e.paymentId ?? null,
    e.orderId ?? null,
    e.agentId ?? null,
    e.stripeEventId ?? null,
    e.source,
    e.type,
    e.fromStatus ?? null,
    e.toStatus ?? null,
    e.detail ?? null,
    e.now,
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

export type OnboardingResult =
  | { ok: true; url: string; stripeAccountId: string; created: boolean }
  | { ok: false; status: number; error: string };

/**
 * Creates the producer's Stripe account for the current mode if it does
 * not exist yet (reused otherwise — repeated clicks never create a second
 * account), then an Account Link to Stripe-hosted onboarding.
 */
export async function startProducerOnboarding(params: {
  db: any;
  stripe: PaymentsStripeClient;
  agentId: string;
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
}): Promise<OnboardingResult> {
  const { db, stripe, agentId } = params;
  const env = params.env ?? process.env;
  const now = params.now ?? nowIso();
  const baseUrl = params.baseUrl.replace(/\/+$/, "");

  const status = getProducerPaymentStatus(db, agentId, env);
  if (status.state === "disabled") return { ok: false, status: 404, error: "payments_disabled" };
  if (status.state === "not_allowed") return { ok: false, status: 403, error: "not_in_pilot" };
  if (status.state === "not_eligible") return { ok: false, status: 409, error: "orders_not_enabled" };

  const livemode = status.livemode;
  let account = status.account;
  let created = false;

  if (!account) {
    const agent = db.prepare(`SELECT id, name, contact_email FROM agents WHERE id = ?`).get(agentId) as
      | { id: string; name: string; contact_email: string | null }
      | undefined;
    if (!agent) return { ok: false, status: 404, error: "agent_not_found" };

    const email = (agent.contact_email || "").trim();
    const stripeAccount = await stripe.accounts.create({
      country: "NO",
      ...(email ? { email } : {}),
      business_profile: {
        name: agent.name,
        url: `${baseUrl}/produsent/${slugify(agent.name)}`,
        product_description: "Lokal mat solgt direkte fra produsenten, bestilt via Rett fra Bonden og hentet hos produsenten.",
      },
      controller: PRODUCER_ACCOUNT_CONTROLLER,
      metadata: { agent_id: agentId, platform: "rettfrabonden" },
    });

    try {
      db.prepare(`
        INSERT INTO payment_accounts (id, agent_id, livemode, stripe_account_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), agentId, livemode ? 1 : 0, stripeAccount.id, now, now);
      created = true;
      logPaymentEvent(db, {
        agentId,
        source: "owner",
        type: "account_created",
        toStatus: "onboarding",
        detail: stripeAccount.id,
        now,
      });
    } catch {
      // A concurrent click won the UNIQUE(agent_id, livemode) race. Use its
      // account; the one just created stays unused at Stripe (harmless,
      // never onboarded, no money can reach it).
    }
    account = getPaymentAccount(db, agentId, livemode);
    if (!account) return { ok: false, status: 500, error: "account_not_saved" };
  }

  const agentPath = `/eier/${encodeURIComponent(agentId)}/betaling`;
  const link = await stripe.accountLinks.create({
    account: account.stripe_account_id,
    refresh_url: `${baseUrl}${agentPath}/fornye`,
    return_url: `${baseUrl}${agentPath}/retur`,
    type: "account_onboarding",
  });
  if (!created) {
    logPaymentEvent(db, { agentId, source: "owner", type: "onboarding_link_created", detail: account.stripe_account_id, now });
  }
  return { ok: true, url: link.url, stripeAccountId: account.stripe_account_id, created };
}

/**
 * Copies Stripe's own Account flags onto our row. The only writer of
 * charges_enabled. Returns whether a row matched.
 */
export function applyAccountSnapshot(
  db: any,
  account: ConnectAccountLike,
  opts: { livemode: boolean; source: "webhook" | "admin" | "system"; stripeEventId?: string | null; now: string },
): { matched: boolean; chargesEnabled: boolean } {
  const row = db
    .prepare(`SELECT * FROM payment_accounts WHERE stripe_account_id = ?`)
    .get(account.id) as PaymentAccountRow | undefined;
  if (!row) return { matched: false, chargesEnabled: false };
  if ((row.livemode === 1) !== opts.livemode) {
    // A test event for a live row or the other way round. Never cross modes.
    return { matched: false, chargesEnabled: row.charges_enabled === 1 };
  }

  const charges = account.charges_enabled === true ? 1 : 0;
  const payouts = account.payouts_enabled === true ? 1 : 0;
  const submitted = account.details_submitted === true ? 1 : 0;
  const disabledReason = account.requirements?.disabled_reason ?? null;
  const businessType = account.business_type ?? null;

  db.prepare(`
    UPDATE payment_accounts
    SET charges_enabled = ?, payouts_enabled = ?, details_submitted = ?, business_type = ?, disabled_reason = ?,
        charges_enabled_at = CASE WHEN ? = 1 AND charges_enabled = 0 THEN ? ELSE charges_enabled_at END,
        updated_at = ?
    WHERE id = ?
  `).run(charges, payouts, submitted, businessType, disabledReason, charges, opts.now, opts.now, row.id);

  if (charges !== row.charges_enabled) {
    logPaymentEvent(db, {
      agentId: row.agent_id,
      stripeEventId: opts.stripeEventId ?? null,
      source: opts.source,
      type: "account_charges_enabled_changed",
      fromStatus: row.charges_enabled === 1 ? "active" : "inactive",
      toStatus: charges === 1 ? "active" : "inactive",
      detail: disabledReason,
      now: opts.now,
    });
  }
  return { matched: true, chargesEnabled: charges === 1 };
}

/** The producer disconnected our platform from their Stripe account. */
function applyDeauthorized(
  db: any,
  stripeAccountId: string,
  opts: { livemode: boolean; stripeEventId: string; now: string },
): boolean {
  const row = db
    .prepare(`SELECT * FROM payment_accounts WHERE stripe_account_id = ?`)
    .get(stripeAccountId) as PaymentAccountRow | undefined;
  if (!row || (row.livemode === 1) !== opts.livemode) return false;
  db.prepare(`
    UPDATE payment_accounts SET charges_enabled = 0, payouts_enabled = 0, disabled_reason = 'deauthorized', updated_at = ?
    WHERE id = ?
  `).run(opts.now, row.id);
  logPaymentEvent(db, {
    agentId: row.agent_id,
    stripeEventId: opts.stripeEventId,
    source: "webhook",
    type: "account_deauthorized",
    fromStatus: row.charges_enabled === 1 ? "active" : "inactive",
    toStatus: "inactive",
    now: opts.now,
  });
  return true;
}

export type PaymentsWebhookResult =
  | { ok: true; duplicate: boolean; eventId: string; type: string; handled: boolean }
  | { ok: false; error: string };

export async function handlePaymentsWebhook(params: {
  db: any;
  stripe: PaymentsStripeClient;
  payload: string | Buffer;
  signature: string;
  secret: string;
  now?: string;
}): Promise<PaymentsWebhookResult> {
  const { db, stripe, payload, signature, secret } = params;
  const now = params.now ?? nowIso();

  let event: PaymentsWebhookEvent;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (err: any) {
    return { ok: false, error: `signature verification failed: ${err?.message || String(err)}` };
  }

  const livemode = event.livemode === true;
  const stripeAccountId = event.account ?? null;

  let duplicate = false;
  let handled = false;
  const tx = db.transaction(() => {
    const seen = db.prepare(`SELECT 1 FROM payment_webhook_events WHERE stripe_event_id = ?`).get(event.id);
    if (seen) {
      duplicate = true;
      return;
    }
    if (event.type === "account.updated") {
      const obj = (event.data?.object || {}) as ConnectAccountLike;
      if (obj.id) handled = applyAccountSnapshot(db, obj, { livemode, source: "webhook", stripeEventId: event.id, now }).matched;
    } else if (event.type === "account.application.deauthorized" && stripeAccountId) {
      handled = applyDeauthorized(db, stripeAccountId, { livemode, stripeEventId: event.id, now });
    }
    db.prepare(`
      INSERT INTO payment_webhook_events (stripe_event_id, type, stripe_account_id, livemode, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, event.type, stripeAccountId, livemode ? 1 : 0, now);
  });

  try {
    tx();
  } catch (err: any) {
    // A concurrent delivery of the same event recorded it first (PRIMARY KEY)
    // and rolled this one back as a whole — treat as duplicate.
    const seen = db.prepare(`SELECT 1 FROM payment_webhook_events WHERE stripe_event_id = ?`).get(event.id);
    if (seen) return { ok: true, duplicate: true, eventId: event.id, type: event.type, handled: false };
    throw err;
  }
  return { ok: true, duplicate, eventId: event.id, type: event.type, handled };
}

/** Admin view: no buyer data, no secrets — Stripe ids and flags only. */
export function listPaymentAccounts(db: any): Array<PaymentAccountRow & { agent_name: string | null }> {
  return db.prepare(`
    SELECT pa.*, a.name AS agent_name
    FROM payment_accounts pa
    LEFT JOIN agents a ON a.id = pa.agent_id
    ORDER BY pa.created_at DESC
  `).all() as Array<PaymentAccountRow & { agent_name: string | null }>;
}
