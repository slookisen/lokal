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
//   - the producer is on the pilot list (PAYMENTS_ALLOWED_AGENT_IDS).
//     Closed by default in BOTH modes: an empty list lets nobody in. "*"
//     opens it to every producer that passes the next clause, but only in
//     LIVE mode — in test mode only explicit ids count, so real producers
//     can never end up with a test-mode Stripe account;
//   - isEligibleForRealOrder(agentId) — prepayment rides on top of real
//     orders and never opens a way around that gate (unchanged, read-only
//     use here).
// A producer can take prepayment when, on top of that, its Stripe account
// for the current mode reports charges_enabled (account.updated webhook).

import { createHash, randomUUID } from "crypto";
import {
  isEligibleForRealOrder,
  submitCart,
  transitionOrder,
  buildOrderNotificationInput,
  type SubmitContactInput,
  type SubmitResult,
  type OrderSummary,
} from "./cart-service";
import { sendOrderNotificationForOrder } from "./order-notify-service";
import { sendBuyerOrderReceipt } from "./order-receipt-service";
import { getDb } from "../database/init";
import { slugify } from "../utils/slug";
import { PRODUSENTVILKAR_VERSION } from "../config/producer-terms";
import {
  PRODUCER_ACCOUNT_CONTROLLER,
  assertPaymentsKeyAllowed,
  createRealPaymentsStripeClient,
  paymentsLivemode,
  type CheckoutSessionLike,
  type ConnectAccountLike,
  type CreateCheckoutSessionParams,
  type PaymentIntentLike,
  type PaymentsStripeClient,
  type PaymentsWebhookEvent,
} from "./payment-provider";

// ── Flags ────────────────────────────────────────────────────────────

/**
 * PAYMENTS_ENABLED:
 *   "1"     — on: onboarding, new payment links, and the lifecycle below.
 *   "drain" — rollback mode: NO new payment links and no onboarding, but
 *             the lifecycle keeps running (webhook, capture on confirm,
 *             release, refund, maintenance job, admin routes) so every open
 *             link and reservation is finished properly. Roll back with
 *             "drain" → (optionally POST /admin/payments/release-all) →
 *             wait until GET /admin/payments/status shows no open payments
 *             → unset.
 *   unset   — off: nothing payment-related runs.
 */
export function isPaymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAYMENTS_ENABLED === "1";
}

/** Webhook, capture/release/refund, maintenance and admin routes: "1" or "drain". */
export function isPaymentsLifecycleActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAYMENTS_ENABLED === "1" || env.PAYMENTS_ENABLED === "drain";
}

export function paymentsAllowedAgentIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PAYMENTS_ALLOWED_AGENT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pilot list check — closed by default; "*" only opens it in live mode. */
export function isAgentAllowedForPayments(agentId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = paymentsAllowedAgentIds(env);
  if (list.includes(agentId)) return true;
  return list.includes("*") && paymentsLivemode(env);
}

// ── Producer terms + trader declaration (prerequisites 4 + 5) ─────────

export type TraderStatus = "trader" | "non_trader";

export interface ProducerTermsAcceptance {
  terms_version: string;
  trader_status: TraderStatus;
  accepted_at: string;
}

export function getProducerTermsAcceptance(db: any, agentId: string): ProducerTermsAcceptance | null {
  try {
    return (db.prepare(`
      SELECT terms_version, trader_status, accepted_at FROM producer_terms_acceptances
      WHERE agent_id = ? ORDER BY accepted_at DESC, rowid DESC LIMIT 1
    `).get(agentId) as ProducerTermsAcceptance | undefined) ?? null;
  } catch {
    return null;
  }
}

export function hasAcceptedCurrentProducerTerms(db: any, agentId: string): boolean {
  return getProducerTermsAcceptance(db, agentId)?.terms_version === PRODUSENTVILKAR_VERSION;
}

export function isTraderStatus(v: unknown): v is TraderStatus {
  return v === "trader" || v === "non_trader";
}

/** Owner accepted the current terms and/or (re)declared trader status. */
export function recordProducerTermsAcceptance(db: any, agentId: string, traderStatus: TraderStatus, now: string = nowIso()): void {
  db.transaction(() => {
    db.prepare(`
      INSERT INTO producer_terms_acceptances (id, agent_id, terms_version, trader_status, accepted_at, source)
      VALUES (?, ?, ?, ?, ?, 'owner')
    `).run(randomUUID(), agentId, PRODUSENTVILKAR_VERSION, traderStatus, now);
    logPaymentEvent(db, { agentId, source: "owner", type: "producer_terms_accepted", detail: `${PRODUSENTVILKAR_VERSION} ${traderStatus}`, now });
  })();
}

/** What buyers are told about the seller (angrerettloven § 9 a). */
export function sellerTraderStatus(db: any, agentId: string): TraderStatus | null {
  return getProducerTermsAcceptance(db, agentId)?.trader_status ?? null;
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
  requirements_due: number;
  pending_verification: number;
  charges_enabled_at: string | null;
  deauthorized_at: string | null;
  last_event_created: number | null;
  created_at: string;
  updated_at: string;
}

/** The producer's current (not disconnected) account for this mode. */
export function getPaymentAccount(db: any, agentId: string, livemode: boolean): PaymentAccountRow | null {
  const row = db
    .prepare(`SELECT * FROM payment_accounts WHERE agent_id = ? AND livemode = ? AND deauthorized_at IS NULL`)
    .get(agentId, livemode ? 1 : 0) as PaymentAccountRow | undefined;
  return row ?? null;
}

function getLatestDeauthorizedAccount(db: any, agentId: string, livemode: boolean): PaymentAccountRow | null {
  const row = db
    .prepare(`SELECT * FROM payment_accounts WHERE agent_id = ? AND livemode = ? AND deauthorized_at IS NOT NULL
              ORDER BY deauthorized_at DESC LIMIT 1`)
    .get(agentId, livemode ? 1 : 0) as PaymentAccountRow | undefined;
  return row ?? null;
}

export type ProducerPaymentState =
  | "disabled"      // PAYMENTS_ENABLED off, or a live key the guard refuses
  | "not_allowed"   // not on the pilot list
  | "not_eligible"  // fails isEligibleForRealOrder (e.g. orders not switched on)
  | "not_started"   // no Stripe account for this mode yet
  | "deauthorized"  // the last account was disconnected — a new one can be connected
  | "onboarding"    // account exists, Stripe onboarding not finished
  | "restricted"    // Stripe needs more information from the producer
  | "rejected"      // Stripe rejected or paused the account — nothing the button can fix
  | "pending"       // submitted, Stripe is reviewing — nothing to do
  | "active";       // charges_enabled — can take prepayment

export interface ProducerPaymentStatus {
  state: ProducerPaymentState;
  livemode: boolean;
  account: PaymentAccountRow | null;
  /** Prerequisites 4 + 5 — filled in by getProducerPaymentStatus(). */
  termsAccepted?: boolean;
  traderStatus?: TraderStatus | null;
}

export function getProducerPaymentStatus(
  db: any,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): ProducerPaymentStatus {
  const base = getProducerPaymentStatusBase(db, agentId, env);
  if (base.state === "disabled" || base.state === "not_allowed") return base;
  return { ...base, termsAccepted: hasAcceptedCurrentProducerTerms(db, agentId), traderStatus: sellerTraderStatus(db, agentId) };
}

function getProducerPaymentStatusBase(
  db: any,
  agentId: string,
  env: NodeJS.ProcessEnv,
): ProducerPaymentStatus {
  const livemode = paymentsLivemode(env);
  if (!isPaymentsEnabled(env) || !assertPaymentsKeyAllowed(env).allowed) {
    return { state: "disabled", livemode, account: null };
  }
  if (!isAgentAllowedForPayments(agentId, env)) return { state: "not_allowed", livemode, account: null };
  const account = getPaymentAccount(db, agentId, livemode);
  if (!isEligibleForRealOrder(agentId, db)) return { state: "not_eligible", livemode, account };
  if (!account) {
    const gone = getLatestDeauthorizedAccount(db, agentId, livemode);
    return gone ? { state: "deauthorized", livemode, account: gone } : { state: "not_started", livemode, account: null };
  }
  if (account.charges_enabled === 1) return { state: "active", livemode, account };
  const reason = account.disabled_reason || "";
  if (reason.startsWith("rejected.") || reason === "platform_paused") return { state: "rejected", livemode, account };
  if (account.details_submitted !== 1) return { state: "onboarding", livemode, account };
  if (account.requirements_due > 0) return { state: "restricted", livemode, account };
  return { state: "pending", livemode, account };
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

function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code || "";
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/** One onboarding at a time per agent in this process (prod runs one machine). */
const onboardingInFlight = new Map<string, Promise<OnboardingResult>>();

/**
 * Creates the producer's Stripe account for the current mode if there is
 * no usable one (reused otherwise), then an Account Link to Stripe-hosted
 * onboarding. Concurrent clicks share one in-flight call, and Stripe's own
 * idempotency key covers a retry of the same creation.
 */
export function startProducerOnboarding(params: {
  db: any;
  stripe: PaymentsStripeClient;
  agentId: string;
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
}): Promise<OnboardingResult> {
  const existing = onboardingInFlight.get(params.agentId);
  if (existing) return existing;
  const run = startProducerOnboardingUnlocked(params).finally(() => onboardingInFlight.delete(params.agentId));
  onboardingInFlight.set(params.agentId, run);
  return run;
}

async function createProducerAccount(db: any, stripe: PaymentsStripeClient, agentId: string, livemode: boolean, baseUrl: string, now: string): Promise<PaymentAccountRow | null> {
  const agent = db.prepare(`SELECT id, name, contact_email FROM agents WHERE id = ?`).get(agentId) as
    | { id: string; name: string; contact_email: string | null }
    | undefined;
  if (!agent) return null;

  // Idempotency key: generation (accounts this producer had in this mode
  // before, so a NEW account after a disconnection gets a new key) + a hash
  // of the parameters + a 10-minute window. Stripe replays the first
  // response for a key — errors included — so a failed or changed request
  // must not stay locked for Stripe's 24 hours.
  const generation = (db.prepare(`SELECT COUNT(*) AS n FROM payment_accounts WHERE agent_id = ? AND livemode = ?`)
    .get(agentId, livemode ? 1 : 0) as { n: number }).n;
  const email = (agent.contact_email || "").trim();
  const createParams = {
    country: "NO" as const,
    ...(email ? { email } : {}),
    business_profile: {
      name: agent.name,
      url: `${baseUrl}/produsent/${slugify(agent.name)}`,
      product_description: "Lokal mat solgt direkte fra produsenten, bestilt via Rett fra Bonden og hentet hos produsenten.",
    },
    controller: PRODUCER_ACCOUNT_CONTROLLER,
    metadata: { agent_id: agentId, platform: "rettfrabonden" },
  };
  const paramsHash = createHash("sha256").update(JSON.stringify(createParams)).digest("hex").slice(0, 12);
  const window10m = Math.floor(Date.parse(now) / 600_000);
  const stripeAccount = await stripe.accounts.create(createParams, {
    idempotencyKey: `rfb-acct:${agentId}:${livemode ? "live" : "test"}:${generation}:${paramsHash}:${window10m}`,
  });

  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO payment_accounts (id, agent_id, livemode, stripe_account_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), agentId, livemode ? 1 : 0, stripeAccount.id, now, now);
      logPaymentEvent(db, { agentId, source: "owner", type: "account_created", toStatus: "onboarding", detail: stripeAccount.id, now });
    })();
  } catch (err) {
    // Only a lost race against another process is expected here (the
    // partial unique index): use the winner's account. Anything else is real.
    if (!isUniqueConstraintError(err)) throw err;
  }
  return getPaymentAccount(db, agentId, livemode);
}

function markDeauthorized(
  db: any,
  row: PaymentAccountRow,
  opts: { source: "webhook" | "owner" | "admin" | "system"; reason: string; stripeEventId?: string | null; now: string },
): boolean {
  const upd = db.prepare(`
    UPDATE payment_accounts
    SET charges_enabled = 0, payouts_enabled = 0, disabled_reason = ?, deauthorized_at = ?, updated_at = ?
    WHERE id = ? AND deauthorized_at IS NULL
  `).run(opts.reason, opts.now, opts.now, row.id);
  if (upd.changes !== 1) return false;
  logPaymentEvent(db, {
    agentId: row.agent_id,
    stripeEventId: opts.stripeEventId ?? null,
    source: opts.source,
    type: "account_deauthorized",
    fromStatus: row.charges_enabled === 1 ? "active" : "inactive",
    toStatus: "deauthorized",
    detail: `${row.stripe_account_id} ${opts.reason}`,
    now: opts.now,
  });
  return true;
}

async function startProducerOnboardingUnlocked(params: {
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
  if (status.state === "active") return { ok: false, status: 409, error: "already_active" };
  if (!hasAcceptedCurrentProducerTerms(db, agentId)) return { ok: false, status: 409, error: "terms_required" };

  const livemode = status.livemode;
  const agentPath = `/eier/${encodeURIComponent(agentId)}/betaling`;

  let account = getPaymentAccount(db, agentId, livemode);
  let created = false;
  if (!account) {
    account = await createProducerAccount(db, stripe, agentId, livemode, baseUrl, now);
    if (!account) return { ok: false, status: 404, error: "agent_not_found" };
    created = true;
  }
  // Any Stripe error propagates (the owner sees «prøv igjen»). A stored
  // account is NEVER retired here on a guess: a 403 can just as well be a
  // restricted key missing a permission. Retiring is Stripe's own
  // account.application.deauthorized event, or an explicit admin action.
  const link = await stripe.accountLinks.create({
    account: account.stripe_account_id,
    refresh_url: `${baseUrl}${agentPath}/fornye`,
    return_url: `${baseUrl}${agentPath}/retur`,
    type: "account_onboarding",
  });
  if (!created) logPaymentEvent(db, { agentId, source: "owner", type: "onboarding_link_created", detail: account.stripe_account_id, now });
  return { ok: true, url: link.url, stripeAccountId: account.stripe_account_id, created };
}

/**
 * Admin: retire a producer's current account for this mode (e.g. the test
 * key moved to another sandbox, so the stored account id no longer exists
 * there). The owner can then connect a new account.
 */
export function retireProducerAccount(db: any, agentId: string, env: NodeJS.ProcessEnv = process.env, now: string = nowIso()): boolean {
  const row = getPaymentAccount(db, agentId, paymentsLivemode(env));
  if (!row) return false;
  let done = false;
  db.transaction(() => { done = markDeauthorized(db, row, { source: "admin", reason: "retired_by_admin", now }); })();
  return done;
}

/**
 * Copies Stripe's own Account flags onto our row. The only writer of
 * charges_enabled. A disconnected row is never re-enabled, and a snapshot
 * from an event older than the last one applied is ignored.
 */
export function applyAccountSnapshot(
  db: any,
  account: ConnectAccountLike,
  opts: { livemode: boolean; source: "webhook" | "admin" | "system"; stripeEventId?: string | null; eventCreated?: number | null; now: string },
): { matched: boolean; chargesEnabled: boolean } {
  const row = db
    .prepare(`SELECT * FROM payment_accounts WHERE stripe_account_id = ?`)
    .get(account.id) as PaymentAccountRow | undefined;
  if (!row) return { matched: false, chargesEnabled: false };
  if ((row.livemode === 1) !== opts.livemode) {
    // A test event for a live row or the other way round. Never cross modes.
    return { matched: false, chargesEnabled: row.charges_enabled === 1 };
  }
  if (row.deauthorized_at) return { matched: true, chargesEnabled: false };
  const eventCreated = opts.eventCreated ?? null;
  if (eventCreated != null && row.last_event_created != null && eventCreated < row.last_event_created) {
    return { matched: true, chargesEnabled: row.charges_enabled === 1 };
  }

  const req = account.requirements || {};
  const charges = account.charges_enabled === true ? 1 : 0;
  const payouts = account.payouts_enabled === true ? 1 : 0;
  const submitted = account.details_submitted === true ? 1 : 0;
  const disabledReason = req.disabled_reason ?? null;
  const due = (req.currently_due?.length ?? 0) + (req.past_due?.length ?? 0);
  const pendingVerification = (req.pending_verification?.length ?? 0) > 0 ? 1 : 0;
  const businessType = account.business_type ?? null;

  db.prepare(`
    UPDATE payment_accounts
    SET charges_enabled = ?, payouts_enabled = ?, details_submitted = ?, business_type = ?, disabled_reason = ?,
        requirements_due = ?, pending_verification = ?,
        charges_enabled_at = CASE WHEN ? = 1 AND charges_enabled = 0 THEN ? ELSE charges_enabled_at END,
        last_event_created = COALESCE(?, last_event_created),
        updated_at = ?
    WHERE id = ?
  `).run(charges, payouts, submitted, businessType, disabledReason, due, pendingVerification,
    charges, opts.now, eventCreated, opts.now, row.id);

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

function findAccountRow(db: any, stripeAccountId: string, livemode: boolean): PaymentAccountRow | null {
  const row = db.prepare(`SELECT * FROM payment_accounts WHERE stripe_account_id = ?`).get(stripeAccountId) as PaymentAccountRow | undefined;
  if (!row || (row.livemode === 1) !== livemode) return null;
  return row;
}

/**
 * Re-reads the account from Stripe (the webhook is only the trigger) and
 * applies it.
 */
async function fetchAndApplyAccount(
  db: any,
  stripe: PaymentsStripeClient,
  row: PaymentAccountRow,
  opts: { livemode: boolean; source: "webhook" | "admin" | "system"; stripeEventId?: string | null; eventCreated?: number | null; now: string },
): Promise<{ apply: () => boolean }> {
  // Every error propagates: the webhook answers 500 and Stripe retries, the
  // admin sync answers 502. Nothing is written on a guess.
  const fresh = await stripe.accounts.retrieve(row.stripe_account_id);
  return { apply: () => applyAccountSnapshot(db, fresh, opts).matched };
}

/** Admin resync (e.g. after webhooks were off): re-read every account of an agent from Stripe. */
export async function syncProducerAccounts(db: any, stripe: PaymentsStripeClient, agentId: string, now: string = nowIso(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  // Only the configured key's mode: a test key cannot read live accounts.
  const rows = db.prepare(`SELECT * FROM payment_accounts WHERE agent_id = ? AND livemode = ? AND deauthorized_at IS NULL`)
    .all(agentId, paymentsLivemode(env) ? 1 : 0) as PaymentAccountRow[];
  let n = 0;
  for (const row of rows) {
    const { apply } = await fetchAndApplyAccount(db, stripe, row, { livemode: row.livemode === 1, source: "admin", now });
    db.transaction(() => { if (apply()) n++; })();
  }
  return n;
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
  env?: NodeJS.ProcessEnv;
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
  const eventCreated = typeof event.created === "number" ? event.created : null;

  if (db.prepare(`SELECT 1 FROM payment_webhook_events WHERE stripe_event_id = ?`).get(event.id)) {
    return { ok: true, duplicate: true, eventId: event.id, type: event.type, handled: false };
  }

  // An event from the other Stripe mode than the configured key (e.g. a
  // live event while the server runs a test key) cannot be acted on with
  // this key: record it and acknowledge it, never retry it forever.
  const modeMatches = livemode === paymentsLivemode(params.env ?? process.env);

  // account.updated: the payload is only a trigger. Stripe does not order
  // events and retries for days, so the CURRENT account is re-read from
  // Stripe before anything is written (outside the transaction — network).
  let accountApply: (() => boolean) | null = null;
  if (modeMatches && event.type === "account.updated") {
    const accountId = (event.data?.object as ConnectAccountLike | undefined)?.id || stripeAccountId || "";
    const row = accountId ? findAccountRow(db, accountId, livemode) : null;
    if (row && !row.deauthorized_at) {
      accountApply = (await fetchAndApplyAccount(db, stripe, row, { livemode, source: "webhook", stripeEventId: event.id, eventCreated, now })).apply;
    }
  }

  let duplicate = false;
  let handled = false;
  const after: AfterCommit[] = [];
  const tx = db.transaction(() => {
    const seen = db.prepare(`SELECT 1 FROM payment_webhook_events WHERE stripe_event_id = ?`).get(event.id);
    if (seen) {
      duplicate = true;
      return;
    }
    if (event.type === "account.application.deauthorized" && stripeAccountId) {
      // Signed and authoritative, no Stripe call needed: recorded whatever
      // mode the configured key is in (findAccountRow matches the row's mode
      // against the event's).
      const row = findAccountRow(db, stripeAccountId, livemode);
      if (row) {
        markDeauthorized(db, row, { source: "webhook", reason: "deauthorized", stripeEventId: event.id, now });
        handled = true;
      }
    } else if (!modeMatches) {
      handled = false;
    } else if (event.type === "account.updated") {
      if (accountApply) handled = accountApply();
    } else if (stripeAccountId && PAYMENT_EVENT_TYPES.has(event.type)) {
      const ctx = { db, stripeAccountId, livemode, stripeEventId: event.id, now, env: params.env ?? process.env, after };
      handled = applyPaymentEvent(event.type, event.data?.object || {}, ctx);
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
  // Side effects only AFTER the state change committed (e-mails, Stripe
  // calls), and without holding Stripe's request open: the 200 goes back
  // at once. Each action is self-contained and never throws; whatever
  // fails is picked up by runPaymentMaintenance().
  if (after.length) void runAfterCommit(after, { db, stripe, now }).catch(() => undefined);
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

// ══ Skive 2 — payment link at submit, authorization, expiry ═══════════════

/** Stripe's minimum charge in NOK is 3.00 kr. */
export const PAYMENT_MIN_ORE = 300;

function intEnv(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number, max: number): number {
  const n = Number.parseInt(String(env[name] ?? ""), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** How long the buyer's payment link lives. Stripe allows 30 min – 24 h. */
export function checkoutMinutes(env: NodeJS.ProcessEnv = process.env): number {
  // Stripe's minimum is 30 minutes from creation; 31 leaves room for clock skew.
  return intEnv(env, "PAYMENT_CHECKOUT_MINUTES", 60, 31, 1440);
}

/**
 * How long the producer has to confirm an authorized payment before the
 * reservation is released (skive 3 job). Card authorizations last about
 * 7 days online, so the cap stays well inside that.
 */
export function confirmHours(env: NodeJS.ProcessEnv = process.env): number {
  // Capped at 72 h so the deadline stays well inside the ~7-day card
  // authorization window even if the authorization webhook arrives late.
  return intEnv(env, "PAYMENT_CONFIRM_HOURS", 48, 1, 72);
}

/** A 10-minute window in idempotency keys: a retry right away replays, a later retry is a new attempt. */
function idemWindow(nowIsoStr: string): number {
  return Math.floor(Date.parse(nowIsoStr) / 600_000);
}

/**
 * Platform fee (application_fee_amount). Supported, but 0 in the pilot:
 * PLATFORM_FEE_BPS (basis points) and PLATFORM_FEE_FIXED_ORE both default to
 * 0. Pricing is Daniel's decision (L4).
 */
export function platformFeeOre(amountOre: number, env: NodeJS.ProcessEnv = process.env): number {
  const bps = intEnv(env, "PLATFORM_FEE_BPS", 0, 0, 10000);
  const fixed = intEnv(env, "PLATFORM_FEE_FIXED_ORE", 0, 0, 1_000_000);
  const fee = Math.round((amountOre * bps) / 10000) + fixed;
  return Math.max(0, Math.min(fee, amountOre - 1));
}

export function isPlatformFeeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return platformFeeOre(1_000_000, env) > 0;
}

/** Integer øre per line, or null when any line has no usable price. */
export function priceLinesOre(
  lines: Array<{ unit_price_snapshot: number | null; qty: number }>,
): { totalOre: number; units: number[] } | null {
  const units: number[] = [];
  let total = 0;
  for (const l of lines) {
    if (l.unit_price_snapshot == null || !Number.isFinite(l.unit_price_snapshot) || l.unit_price_snapshot <= 0) return null;
    if (!Number.isInteger(l.qty) || l.qty <= 0) return null;
    const unit = Math.round(l.unit_price_snapshot * 100);
    if (unit <= 0) return null;
    units.push(unit);
    total += unit * l.qty;
  }
  return lines.length ? { totalOre: total, units } : null;
}

/**
 * submitCart()'s prepay hook: prepay when the buyer did not ask to pay at
 * pickup, the producer can take prepayment, every line has a price and the
 * total is at least Stripe's minimum.
 */
export function makePrepayPredicate(
  db: any,
  env: NodeJS.ProcessEnv,
  contact?: SubmitContactInput,
): (agentId: string, lines: Array<{ unit_price_snapshot: number | null; qty: number }>) => boolean {
  return (agentId, lines) => {
    if (contact?.pay_at_pickup === true) return false;
    if (!canProducerTakePrepayment(db, agentId, env)) return false;
    const priced = priceLinesOre(lines);
    return !!priced && priced.totalOre >= PAYMENT_MIN_ORE;
  };
}

/** One entry of `payments[]` in the submit response (REST + lokal_cart_submit). */
export interface OrderPaymentLink {
  order_id: string;
  payment_id: string;
  seller: string;
  /** The producer's own declaration (angrerettloven § 9 a); null if none. */
  seller_trader_status: TraderStatus | null;
  amount_nok: number;
  currency: "NOK";
  fees: { stripe_fee_payer: "producer"; platform_fee_nok: number };
  checkout_url: string;
  expires_at: string;
  status: "requires_payment";
  capture: "on_producer_confirmation";
}

export type SubmitWithPaymentsResult =
  | (Extract<SubmitResult, { success: true }> & {
      orders: Array<OrderSummary & { payment_mode?: "prepay" | "at_pickup" }>;
      payments?: OrderPaymentLink[];
      payment_note?: string;
    })
  | Extract<SubmitResult, { success: false }>;

let _testStripeClient: PaymentsStripeClient | null = null;
/** Test pin for callers that have no Express app to inject through (MCP). */
export function __setPaymentsStripeClientForTesting(c: PaymentsStripeClient | null): void {
  _testStripeClient = c;
}

/**
 * The Stripe client for payment calls: an injected/test client, else a real
 * one — but only with a key the live guard accepts (re-checked per call).
 */
export function resolvePaymentsStripeClient(
  injected?: PaymentsStripeClient | null,
  env: NodeJS.ProcessEnv = process.env,
): PaymentsStripeClient | null {
  if (injected) return injected;
  if (_testStripeClient) return _testStripeClient;
  const key = env.STRIPE_SECRET_KEY || "";
  if (!key || !assertPaymentsKeyAllowed(env).allowed) return null;
  return createRealPaymentsStripeClient(key);
}

function addMinutesIso(nowIsoStr: string, minutes: number): string {
  return new Date(Date.parse(nowIsoStr) + minutes * 60_000).toISOString();
}

/** «13. oktober kl. 14:30» in Oslo time, for e-mails. */
export function formatOsloDateTime(iso: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "numeric", month: "long" }).format(d);
  const time = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${date} kl. ${time.replace(".", ":")}`;
}

/**
 * Creates the Stripe Checkout Session for one prepay order — a DIRECT
 * charge on the producer's account (Stripe-Account), manual capture — and
 * records the payments row. Throws on any Stripe/DB failure; the caller
 * falls back to pay-at-pickup.
 */
export async function createCheckoutForOrder(params: {
  db: any;
  stripe: PaymentsStripeClient;
  orderId: string;
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
}): Promise<OrderPaymentLink> {
  const { db, stripe, orderId } = params;
  const env = params.env ?? process.env;
  const now = params.now ?? nowIso();
  const baseUrl = params.baseUrl.replace(/\/+$/, "");

  const order = db.prepare(`
    SELECT o.id, o.cart_id, o.agent_id, o.status, o.payment_mode, a.name AS producer_name
    FROM orders o INNER JOIN agents a ON a.id = o.agent_id WHERE o.id = ?
  `).get(orderId) as
    | { id: string; cart_id: string | null; agent_id: string; status: string; payment_mode: string | null; producer_name: string }
    | undefined;
  if (!order || order.payment_mode !== "prepay" || order.status !== "pending") throw new Error("order not payable");

  const items = db.prepare(`
    SELECT name_snapshot, qty, unit_price_snapshot FROM order_items WHERE order_id = ? ORDER BY rowid
  `).all(orderId) as Array<{ name_snapshot: string | null; qty: number; unit_price_snapshot: number | null }>;
  const priced = priceLinesOre(items);
  if (!priced || priced.totalOre < PAYMENT_MIN_ORE) throw new Error("order not priced");

  const livemode = paymentsLivemode(env);
  const account = getPaymentAccount(db, order.agent_id, livemode);
  if (!account || account.charges_enabled !== 1) throw new Error("producer cannot take prepayment");

  const paymentId = randomUUID();
  const feeOre = platformFeeOre(priced.totalOre, env);
  const minutes = checkoutMinutes(env);
  const expiresAtIso = addMinutesIso(now, minutes);
  const metadata = { order_id: order.id, cart_id: order.cart_id ?? "", agent_id: order.agent_id, payment_id: paymentId, platform: "rettfrabonden" };

  // Stripe allows 100 line items; beyond that one summary line with the total.
  const lineItems: CreateCheckoutSessionParams["line_items"] =
    items.length <= 100
      ? items.map((it, idx) => ({
          quantity: it.qty,
          price_data: { currency: "nok", unit_amount: priced.units[idx]!, product_data: { name: (it.name_snapshot || "Vare").slice(0, 250) } },
        }))
      : [{ quantity: 1, price_data: { currency: "nok", unit_amount: priced.totalOre, product_data: { name: `Bestilling hos ${order.producer_name}`.slice(0, 250) } } }];

  const session: CheckoutSessionLike = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: lineItems,
      payment_intent_data: {
        capture_method: "manual",
        ...(feeOre > 0 ? { application_fee_amount: feeOre } : {}),
        description: `Henteordre ${order.id.slice(0, 8)} via Rett fra Bonden`,
        metadata,
      },
      metadata,
      client_reference_id: order.id,
      success_url: `${baseUrl}/betaling/takk?ordre=${encodeURIComponent(order.id)}`,
      cancel_url: `${baseUrl}/betaling/avbrutt?ordre=${encodeURIComponent(order.id)}`,
      expires_at: Math.floor(Date.parse(expiresAtIso) / 1000),
      locale: "nb",
    },
    { stripeAccount: account.stripe_account_id, idempotencyKey: `rfb-checkout-${paymentId}` },
  );
  if (!session.url) throw new Error("checkout session has no url");

  db.prepare(`
    INSERT INTO payments
      (id, order_id, agent_id, stripe_account_id, livemode, amount_ore, currency, application_fee_ore,
       status, checkout_session_id, checkout_url, checkout_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'nok', ?, 'requires_payment', ?, ?, ?, ?, ?)
  `).run(paymentId, order.id, order.agent_id, account.stripe_account_id, livemode ? 1 : 0, priced.totalOre, feeOre,
    session.id, session.url, expiresAtIso, now, now);
  logPaymentEvent(db, { paymentId, orderId: order.id, agentId: order.agent_id, source: "system", type: "checkout_created", toStatus: "requires_payment", now });

  return {
    order_id: order.id,
    payment_id: paymentId,
    seller: order.producer_name,
    seller_trader_status: sellerTraderStatus(db, order.agent_id),
    amount_nok: priced.totalOre / 100,
    currency: "NOK",
    fees: { stripe_fee_payer: "producer", platform_fee_nok: feeOre / 100 },
    checkout_url: session.url,
    expires_at: expiresAtIso,
    status: "requires_payment",
    capture: "on_producer_confirmation",
  };
}

/**
 * A prepay order that will not be prepaid (link creation failed, or the
 * link expired unpaid) continues as an ordinary pay-at-pickup order: the
 * producer is notified now, so it never becomes a «dead» order nobody saw.
 * Returns whether the order was switched (only from 'prepay' while pending).
 */
function switchToPayAtPickup(db: any, orderId: string): boolean {
  const upd = db.prepare(`
    UPDATE orders SET payment_mode = 'at_pickup', updated_at = datetime('now')
    WHERE id = ? AND payment_mode = 'prepay' AND status = 'pending'
  `).run(orderId);
  return upd.changes === 1;
}

/**
 * A prepay order whose payment will not happen (link failed/expired,
 * amount mismatch, rollback) continues as pay at pickup — and the producer,
 * who has not been told about it yet, gets the order now. No-op unless the
 * order is still pending with payment_mode='prepay' (so never twice).
 */
function fallbackToPayAtPickup(db: any, orderId: string, notice: "not_prepaid" | "none"): boolean {
  if (!switchToPayAtPickup(db, orderId)) return false;
  notifyProducer(orderId, notice === "not_prepaid" ? { status: "not_prepaid" } : undefined);
  return true;
}

function notifyProducer(orderId: string, payment?: Parameters<typeof sendOrderNotificationForOrder>[0]["payment"]): void {
  const input = buildOrderNotificationInput(orderId);
  if (!input) return;
  void sendOrderNotificationForOrder(payment ? { ...input, payment } : input).catch((err) => {
    console.error(`[payments] notify rejection order=${orderId}:`, err);
  });
}

export function buyerPaymentNote(env: NodeJS.ProcessEnv = process.env): string {
  return (
    `Betal innen ${checkoutMinutes(env)} minutter. Beløpet reserveres og trekkes først når produsenten bekrefter bestillingen; ` +
    `avslår produsenten, eller bekrefter ikke innen ${confirmHours(env)} timer, frigjøres reservasjonen og bestillingen kanselleres. ` +
    "Betaler du ikke innen fristen, sendes bestillingen til produsenten med betaling ved henting. " +
    "Produsenten er selger og mottar betalingen direkte via Stripe."
  );
}

/**
 * submit + prepayment. With PAYMENTS_ENABLED off (or no usable Stripe
 * client) this IS submitCart(), response unchanged. Otherwise orders for
 * producers that take prepayment get a Stripe payment link in `payments[]`
 * and every order carries `payment_mode`.
 */
export async function submitCartWithPayments(params: {
  cartId: string;
  contact?: SubmitContactInput;
  stripe: PaymentsStripeClient | null;
  baseUrl: string;
  db?: any;
  env?: NodeJS.ProcessEnv;
  now?: string;
}): Promise<SubmitWithPaymentsResult> {
  const env = params.env ?? process.env;
  if (!isPaymentsEnabled(env) || !params.stripe || !assertPaymentsKeyAllowed(env).allowed) {
    return submitCart(params.cartId, params.contact);
  }
  const db = params.db ?? getDb();
  const result = submitCart(params.cartId, params.contact, { prepay: makePrepayPredicate(db, env, params.contact) });
  if (!result.success) return result;

  const payments: OrderPaymentLink[] = [];
  const modeOf = (orderId: string) =>
    ((db.prepare(`SELECT payment_mode FROM orders WHERE id = ?`).get(orderId) as any)?.payment_mode ?? null) as string | null;

  for (const o of result.orders) {
    if (modeOf(o.order_id) !== "prepay") continue;
    try {
      payments.push(await createCheckoutForOrder({ db, stripe: params.stripe, orderId: o.order_id, baseUrl: params.baseUrl, env, now: params.now }));
    } catch (err: any) {
      const now = params.now ?? nowIso();
      if (switchToPayAtPickup(db, o.order_id)) {
        logPaymentEvent(db, { orderId: o.order_id, agentId: o.agent_id, source: "system", type: "checkout_create_failed", toStatus: "at_pickup", detail: String(err?.message || err).slice(0, 200), now });
        notifyProducer(o.order_id);
      }
      console.error(`[payments] checkout creation failed order=${o.order_id}: ${String(err?.message || err)}`);
    }
  }

  const orders = result.orders.map((o) => ({ ...o, payment_mode: (modeOf(o.order_id) === "prepay" ? "prepay" : "at_pickup") as "prepay" | "at_pickup" }));
  return {
    ...result,
    orders,
    payments,
    ...(payments.length ? { payment_note: buyerPaymentNote(env) } : {}),
  };
}

// ── Webhook: payment events (on the producer's connected account) ────────

const PAYMENT_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "payment_intent.amount_capturable_updated",
  "payment_intent.succeeded",
  "payment_intent.canceled",
  "charge.refunded",
  "charge.dispute.created",
]);

type AfterCommit =
  | { kind: "notify_authorized"; orderId: string; amountOre: number; confirmByIso: string }
  | { kind: "notify_not_prepaid"; orderId: string }
  | { kind: "notify_released"; orderId: string }
  | { kind: "sync_intent"; paymentId: string }
  | { kind: "cancel_intent"; paymentId: string; reason: string };

interface PaymentEventCtx {
  db: any;
  stripeAccountId: string;
  livemode: boolean;
  stripeEventId: string;
  now: string;
  env: NodeJS.ProcessEnv;
  after: AfterCommit[];
}

export interface PaymentRow {
  id: string;
  order_id: string;
  agent_id: string;
  stripe_account_id: string;
  livemode: number;
  amount_ore: number;
  application_fee_ore: number;
  stripe_fee_ore: number | null;
  refunded_ore: number;
  status: string;
  checkout_session_id: string | null;
  checkout_url: string | null;
  checkout_expires_at: string | null;
  payment_intent_id: string | null;
  capture_deadline_at: string | null;
  failure_reason: string | null;
  authorized_at: string | null;
  captured_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Only rows that live on THIS connected account and mode — never cross accounts. */
function findPayment(db: any, where: { id?: string; sessionId?: string; intentId?: string }, ctx: { stripeAccountId: string; livemode: boolean }): PaymentRow | null {
  let row: PaymentRow | undefined;
  if (where.id) row = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(where.id);
  if (!row && where.intentId) row = db.prepare(`SELECT * FROM payments WHERE payment_intent_id = ?`).get(where.intentId);
  if (!row && where.sessionId) row = db.prepare(`SELECT * FROM payments WHERE checkout_session_id = ?`).get(where.sessionId);
  if (!row) return null;
  if (row.stripe_account_id !== ctx.stripeAccountId || (row.livemode === 1) !== ctx.livemode) return null;
  return row;
}

function setPaymentStatus(db: any, p: PaymentRow, to: string, extra: Record<string, string | number | null>, e: { source: "webhook" | "system" | "admin" | "owner"; type: string; stripeEventId?: string | null; detail?: string | null; now: string }): boolean {
  const cols = Object.keys(extra);
  const sets = ["status = ?", "updated_at = ?", ...cols.map((c) => `${c} = ?`)].join(", ");
  const upd = db.prepare(`UPDATE payments SET ${sets} WHERE id = ? AND status = ?`).run(to, e.now, ...cols.map((c) => extra[c]), p.id, p.status);
  if (upd.changes !== 1) return false;
  logPaymentEvent(db, { paymentId: p.id, orderId: p.order_id, agentId: p.agent_id, stripeEventId: e.stripeEventId ?? null, source: e.source, type: e.type, fromStatus: p.status, toStatus: to, detail: e.detail ?? null, now: e.now });
  return true;
}

function intentIdOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as any).id === "string") return (v as any).id;
  return null;
}

/** requires_payment → authorized, from Stripe's PaymentIntent. Idempotent. */
function applyAuthorization(db: any, p: PaymentRow, pi: PaymentIntentLike, ctx: { now: string; env: NodeJS.ProcessEnv; stripeEventId?: string | null; source: "webhook" | "system"; after: AfterCommit[] }): boolean {
  if (p.status !== "requires_payment") return false;
  if (pi.status !== "requires_capture") return false;
  if (typeof pi.amount === "number" && pi.amount !== p.amount_ore) {
    // Never authorize an amount we did not ask for.
    logPaymentEvent(db, { paymentId: p.id, orderId: p.order_id, agentId: p.agent_id, stripeEventId: ctx.stripeEventId ?? null, source: ctx.source, type: "amount_mismatch", detail: `${pi.amount} != ${p.amount_ore}`, now: ctx.now });
    db.prepare(`UPDATE payments SET payment_intent_id = COALESCE(payment_intent_id, ?), updated_at = ? WHERE id = ?`).run(pi.id, ctx.now, p.id);
    ctx.after.push({ kind: "cancel_intent", paymentId: p.id, reason: "amount_mismatch" });
    return true;
  }
  const deadline = addMinutesIso(ctx.now, confirmHours(ctx.env) * 60);
  const ok = setPaymentStatus(db, p, "authorized", { payment_intent_id: pi.id, authorized_at: ctx.now, capture_deadline_at: deadline }, { source: ctx.source, type: "payment_authorized", stripeEventId: ctx.stripeEventId, now: ctx.now });
  if (!ok) return false;
  const order = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(p.order_id) as { status: string } | undefined;
  if (order?.status === "pending") {
    ctx.after.push({ kind: "notify_authorized", orderId: p.order_id, amountOre: p.amount_ore, confirmByIso: deadline });
  } else {
    // The order was closed while the buyer paid — release the money at once.
    ctx.after.push({ kind: "cancel_intent", paymentId: p.id, reason: `order_${order?.status ?? "missing"}` });
  }
  return true;
}

function applyPaymentEvent(type: string, obj: any, ctx: PaymentEventCtx): boolean {
  const { db, now } = ctx;
  if (type === "checkout.session.completed") {
    const p = findPayment(db, { id: obj?.metadata?.payment_id, sessionId: obj?.id }, ctx);
    if (!p) return false;
    const intentId = intentIdOf(obj?.payment_intent);
    if (intentId && !p.payment_intent_id) {
      db.prepare(`UPDATE payments SET payment_intent_id = ?, updated_at = ? WHERE id = ?`).run(intentId, now, p.id);
    }
    logPaymentEvent(db, { paymentId: p.id, orderId: p.order_id, agentId: p.agent_id, stripeEventId: ctx.stripeEventId, source: "webhook", type: "checkout_completed", now });
    // Belt and braces: confirm the authorization from the PaymentIntent too,
    // in case payment_intent.amount_capturable_updated is delayed or lost.
    if (p.status === "requires_payment" && intentId) ctx.after.push({ kind: "sync_intent", paymentId: p.id });
    return true;
  }
  if (type === "payment_intent.amount_capturable_updated") {
    const pi = obj as PaymentIntentLike;
    const p = findPayment(db, { id: pi?.metadata?.payment_id, intentId: pi?.id }, ctx);
    if (!p) return false;
    applyAuthorization(db, p, pi, { now, env: ctx.env, stripeEventId: ctx.stripeEventId, source: "webhook", after: ctx.after });
    return true;
  }
  if (type === "checkout.session.expired") {
    const p = findPayment(db, { id: obj?.metadata?.payment_id, sessionId: obj?.id }, ctx);
    if (!p) return false;
    applySessionExpired(db, p, { source: "webhook", stripeEventId: ctx.stripeEventId, now, after: ctx.after });
    return true;
  }
  if (type === "payment_intent.succeeded") {
    // Captured outside our own capture call (e.g. from the producer's Stripe Dashboard).
    const pi = obj as PaymentIntentLike;
    const p = findPayment(db, { id: pi?.metadata?.payment_id, intentId: pi?.id }, ctx);
    if (!p) return false;
    if (p.status === "authorized") {
      setPaymentStatus(db, p, "captured", { captured_at: now, payment_intent_id: pi.id }, { source: "webhook", type: "payment_captured", stripeEventId: ctx.stripeEventId, now });
    }
    return true;
  }
  if (type === "payment_intent.canceled") {
    const pi = obj as PaymentIntentLike & { cancellation_reason?: string | null };
    const p = findPayment(db, { id: pi?.metadata?.payment_id, intentId: pi?.id }, ctx);
    if (!p) return false;
    if (p.status === "authorized" || p.status === "requires_payment") {
      const reason = pi.cancellation_reason || "canceled_at_stripe";
      if (setPaymentStatus(db, p, "canceled", { canceled_at: now, failure_reason: reason }, { source: "webhook", type: "payment_canceled", stripeEventId: ctx.stripeEventId, detail: reason, now })) {
        const o = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(p.order_id) as { status: string } | undefined;
        if (o && (o.status === "confirmed" || o.status === "ready" || o.status === "completed")) {
          // The producer confirmed and was told the money would be captured.
          console.error(`[payments] ALERT authorization lost after confirmation order=${p.order_id} payment=${p.id} reason=${reason}`);
          logPaymentEvent(db, { paymentId: p.id, orderId: p.order_id, agentId: p.agent_id, stripeEventId: ctx.stripeEventId, source: "webhook", type: "authorization_lost_after_confirm", detail: reason, now });
        }
        // The reservation is gone: whatever happens next is paid at pickup.
        db.prepare(`UPDATE orders SET payment_mode = 'at_pickup', updated_at = datetime('now') WHERE id = ? AND payment_mode = 'prepay'`).run(p.order_id);
        // An unpaid link (the producer has not heard about the order yet) →
        // the held-back order mail as pay at pickup; a reservation the
        // producer was told about → the correction.
        if (o?.status === "pending" || o?.status === "confirmed" || o?.status === "ready") {
          ctx.after.push(p.status === "requires_payment"
            ? { kind: "notify_not_prepaid", orderId: p.order_id }
            : { kind: "notify_released", orderId: p.order_id });
        }
      }
    }
    return true;
  }
  if (type === "charge.refunded") {
    const intentId = intentIdOf(obj?.payment_intent);
    const p = findPayment(db, { intentId: intentId ?? undefined }, ctx);
    if (!p) return false;
    const refunded = Math.max(p.refunded_ore, Number(obj?.amount_refunded) || 0);
    if (refunded !== p.refunded_ore) applyRefundTotal(db, p, refunded, { source: "webhook", stripeEventId: ctx.stripeEventId, now });
    return true;
  }
  if (type === "charge.dispute.created") {
    const intentId = intentIdOf(obj?.payment_intent);
    const p = findPayment(db, { intentId: intentId ?? undefined }, ctx);
    if (!p) return false;
    logPaymentEvent(db, { paymentId: p.id, orderId: p.order_id, agentId: p.agent_id, stripeEventId: ctx.stripeEventId, source: "webhook", type: "dispute_opened", detail: String(obj?.reason || "").slice(0, 80), now });
    return true;
  }
  return false;
}

/** requires_payment → expired; the order falls back to pay at pickup. */
function applySessionExpired(db: any, p: PaymentRow, e: { source: "webhook" | "system"; stripeEventId?: string | null; now: string; after: AfterCommit[] }): void {
  // Only an unpaid link expires: a link we expired ourselves (decline,
  // rollback) is already 'canceled' and keeps that history.
  if (p.status !== "requires_payment") return;
  if (setPaymentStatus(db, p, "expired", {}, { source: e.source, type: "checkout_expired", stripeEventId: e.stripeEventId ?? null, now: e.now })) {
    if (switchToPayAtPickup(db, p.order_id)) e.after.push({ kind: "notify_not_prepaid", orderId: p.order_id });
  }
}

function applyRefundTotal(db: any, p: PaymentRow, refundedOre: number, e: { source: "webhook" | "system" | "admin" | "owner"; stripeEventId?: string | null; now: string }): void {
  const full = refundedOre >= p.amount_ore;
  if (full && p.status !== "refunded") {
    setPaymentStatus(db, p, "refunded", { refunded_ore: refundedOre }, { source: e.source, type: "payment_refunded", stripeEventId: e.stripeEventId ?? null, detail: String(refundedOre), now: e.now });
  } else {
    db.prepare(`UPDATE payments SET refunded_ore = ?, updated_at = ? WHERE id = ?`).run(refundedOre, e.now, p.id);
    logPaymentEvent(db, { paymentId: p.id, orderId: p.order_id, agentId: p.agent_id, stripeEventId: e.stripeEventId ?? null, source: e.source, type: "payment_partially_refunded", detail: String(refundedOre), now: e.now });
  }
}

async function runAfterCommit(actions: AfterCommit[], deps: { db: any; stripe: PaymentsStripeClient; now: string }): Promise<void> {
  for (const a of actions) {
    try {
      if (a.kind === "notify_authorized") {
        notifyProducer(a.orderId, { status: "authorized", amount_nok: a.amountOre / 100, confirm_by: formatOsloDateTime(a.confirmByIso) });
      } else if (a.kind === "notify_not_prepaid") {
        notifyProducer(a.orderId, { status: "not_prepaid" });
      } else if (a.kind === "notify_released") {
        notifyProducer(a.orderId, { status: "payment_released" });
      } else if (a.kind === "sync_intent") {
        await syncPaymentIntent(deps.db, deps.stripe, a.paymentId, deps.now);
      } else if (a.kind === "cancel_intent") {
        await cancelPaymentIntent(deps.db, deps.stripe, a.paymentId, a.reason, deps.now);
      }
    } catch (err: any) {
      console.error(`[payments] after-commit ${a.kind} failed: ${String(err?.message || err)}`);
    }
  }
}

/** Reads the PaymentIntent from the producer's account and applies an authorization. */
export async function syncPaymentIntent(db: any, stripe: PaymentsStripeClient, paymentId: string, now: string = nowIso(), env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const p = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(paymentId) as PaymentRow | undefined;
  if (!p || !p.payment_intent_id || p.status !== "requires_payment") return false;
  const pi = await stripe.paymentIntents.retrieve(p.payment_intent_id, { stripeAccount: p.stripe_account_id });
  const after: AfterCommit[] = [];
  let applied = false;
  db.transaction(() => {
    const fresh = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(paymentId) as PaymentRow;
    applied = applyAuthorization(db, fresh, pi, { now, env, source: "system", after });
  })();
  await runAfterCommit(after, { db, stripe, now });
  return applied;
}

/** Releases a reservation on the producer's account (authorized → canceled). */
export async function cancelPaymentIntent(db: any, stripe: PaymentsStripeClient, paymentId: string, reason: string, now: string = nowIso()): Promise<boolean> {
  const p = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(paymentId) as PaymentRow | undefined;
  if (!p || !p.payment_intent_id) return false;
  if (p.status !== "authorized" && p.status !== "requires_payment") return false;
  await stripe.paymentIntents.cancel(p.payment_intent_id, { stripeAccount: p.stripe_account_id, idempotencyKey: `rfb-cancel-${p.id}-${idemWindow(now)}` });
  const done = setPaymentStatus(db, p, "canceled", { canceled_at: now, failure_reason: reason }, { source: "system", type: "payment_canceled", detail: reason, now });
  // Released while the order is still pending and never announced (amount
  // mismatch, rollback of an unpaid link): it becomes pay at pickup now.
  if (done && p.status === "requires_payment") fallbackToPayAtPickup(db, p.order_id, "not_prepaid");
  return done;
}

// ══ Skive 3 — lifecycle: capture on confirm, release, refund, maintenance ══

export function getPaymentForOrder(db: any, orderId: string): PaymentRow | null {
  return (db.prepare(`SELECT * FROM payments WHERE order_id = ?`).get(orderId) as PaymentRow | undefined) ?? null;
}

/** Stripe's processing fee incl. VAT on it (not the platform fee) from the charge's balance transaction. */
export function stripeFeeOreFrom(pi: PaymentIntentLike): number | null {
  const ch = pi.latest_charge;
  const bt = ch && typeof ch === "object" ? ch.balance_transaction : null;
  if (!bt || typeof bt !== "object") return null;
  if (Array.isArray(bt.fee_details) && bt.fee_details.length) {
    return bt.fee_details.filter((f) => f.type === "stripe_fee" || f.type === "tax").reduce((sum, f) => sum + (f.amount || 0), 0);
  }
  return typeof bt.fee === "number" ? bt.fee : null;
}

export type CaptureOutcome = "captured" | "not_authorized" | "authorization_gone" | "retry_later";

/**
 * authorized → captured, on the producer's account. On a definitive
 * failure (the authorization is gone) the payment becomes 'expired' and
 * the order is paid at pickup; on anything else it stays 'authorized' and
 * runPaymentMaintenance() retries.
 */
export async function capturePayment(db: any, stripe: PaymentsStripeClient, paymentId: string, now: string = nowIso()): Promise<CaptureOutcome> {
  const p = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(paymentId) as PaymentRow | undefined;
  if (!p || p.status !== "authorized" || !p.payment_intent_id) return "not_authorized";
  const opts = { stripeAccount: p.stripe_account_id };
  let pi: PaymentIntentLike;
  try {
    pi = await stripe.paymentIntents.capture(p.payment_intent_id, { ...opts, idempotencyKey: `rfb-capture-${p.id}-${idemWindow(now)}` });
  } catch (err: any) {
    let current: PaymentIntentLike | null = null;
    try { current = await stripe.paymentIntents.retrieve(p.payment_intent_id, opts); } catch { current = null; }
    if (current?.status === "succeeded") {
      pi = current;
    } else if (current?.status === "canceled") {
      db.transaction(() => {
        if (setPaymentStatus(db, p, "expired", { failure_reason: "authorization_expired" }, { source: "system", type: "capture_failed", detail: "authorization_expired", now })) {
          db.prepare(`UPDATE orders SET payment_mode = 'at_pickup', updated_at = datetime('now') WHERE id = ? AND payment_mode = 'prepay'`).run(p.order_id);
        }
      })();
      return "authorization_gone";
    } else {
      logPaymentEvent(db, { paymentId: p.id, orderId: p.order_id, agentId: p.agent_id, source: "system", type: "capture_retry_pending", detail: String(err?.code || err?.type || "error").slice(0, 80), now });
      return "retry_later";
    }
  }
  if (pi.status !== "succeeded") return "retry_later";
  const fee = stripeFeeOreFrom(pi);
  if (!setPaymentStatus(db, p, "captured", { captured_at: now, stripe_fee_ore: fee }, { source: "system", type: "payment_captured", now })) {
    // payment_intent.succeeded got there first: keep the fee anyway.
    if (fee != null) db.prepare(`UPDATE payments SET stripe_fee_ore = ?, updated_at = ? WHERE id = ? AND stripe_fee_ore IS NULL`).run(fee, now, p.id);
  }
  return "captured";
}

/** Releases an unpaid link or a reservation (requires_payment/authorized → canceled). */
export async function releasePayment(db: any, stripe: PaymentsStripeClient, paymentId: string, reason: string, now: string = nowIso()): Promise<boolean> {
  const p = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(paymentId) as PaymentRow | undefined;
  if (!p) return false;
  if (p.status === "authorized") return cancelPaymentIntent(db, stripe, p.id, reason, now);
  if (p.status === "requires_payment" && p.checkout_session_id) {
    try {
      await stripe.checkout.sessions.expire(p.checkout_session_id, { stripeAccount: p.stripe_account_id, idempotencyKey: `rfb-expire-${p.id}-${idemWindow(now)}` });
    } catch (err) {
      // Already completed in the meantime: re-read the intent so the
      // reservation is found and released on the next maintenance run.
      const cs = await stripe.checkout.sessions.retrieve(p.checkout_session_id, { stripeAccount: p.stripe_account_id }).catch(() => null);
      const intentId = intentIdOf(cs?.payment_intent);
      if (intentId) db.prepare(`UPDATE payments SET payment_intent_id = COALESCE(payment_intent_id, ?), updated_at = ? WHERE id = ?`).run(intentId, now, p.id);
      return false;
    }
    const done = setPaymentStatus(db, p, "canceled", { canceled_at: now, failure_reason: reason }, { source: "system", type: "payment_canceled", detail: reason, now });
    if (done) fallbackToPayAtPickup(db, p.order_id, "not_prepaid");
    return done;
  }
  return false;
}

/** Full or partial refund of a captured payment, on the producer's account. */
export async function refundPayment(
  db: any,
  stripe: PaymentsStripeClient,
  paymentId: string,
  opts: { amountOre?: number; reason: string; source: "admin" | "owner" | "system"; now?: string },
): Promise<{ ok: true; refundedOre: number } | { ok: false; error: string }> {
  const now = opts.now ?? nowIso();
  const p = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(paymentId) as PaymentRow | undefined;
  if (!p || !p.payment_intent_id) return { ok: false, error: "payment_not_found" };
  if (p.status !== "captured") return { ok: false, error: `not_refundable_in_status_${p.status}` };
  const remaining = p.amount_ore - p.refunded_ore;
  const amount = opts.amountOre ?? remaining;
  if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) return { ok: false, error: "invalid_amount" };
  const refund = await stripe.refunds.create(
    { payment_intent: p.payment_intent_id, ...(amount < p.amount_ore || p.refunded_ore > 0 ? { amount } : {}), metadata: { payment_id: p.id, order_id: p.order_id, reason: opts.reason } },
    // A manual (admin/owner) refund keeps one key per (refunded so far,
    // amount), so a retry after a timeout in which Stripe DID refund is
    // deduplicated instead of refunding a partial amount twice. The system's
    // full refunds use 10-minute buckets so the maintenance retry is not stuck
    // on a cached Stripe error for 24 h; a duplicate full refund is refused by
    // Stripe anyway (nothing left to refund).
    { stripeAccount: p.stripe_account_id, idempotencyKey: opts.source === "system"
      ? `rfb-refund-${p.id}-${p.refunded_ore}-${amount}-${idemWindow(now)}`
      : `rfb-refund-${p.id}-${p.refunded_ore}-${amount}` },
  );
  const total = p.refunded_ore + (refund.amount || amount);
  db.transaction(() => {
    const fresh = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(p.id) as PaymentRow;
    applyRefundTotal(db, fresh, Math.max(fresh.refunded_ore, total), { source: opts.source, now });
  })();
  return { ok: true, refundedOre: total };
}

export type OrderPaymentEffect = "none" | "captured" | "capture_failed" | "capture_pending" | "released" | "refunded" | "kept";

/**
 * Called by the producer page and the admin lifecycle routes AFTER a
 * successful order transition. The order transition never waits for, and
 * is never undone by, the payment step; a failed Stripe call is retried by
 * runPaymentMaintenance().
 *   confirmed                 → capture the reservation
 *   declined                  → release (link or reservation)
 *   cancelled no_show         → kept: the producer keeps a captured payment (terms §7)
 *   cancelled buyer_cancelled → release a reservation; a captured payment is
 *                               NOT refunded automatically — the producer
 *                               refunds in full or in part in Stripe
 *                               (forbrukerkjøpsloven § 41: the seller may
 *                               claim documented loss)
 *   cancelled other           → release a reservation, refund a captured payment
 */
export async function onOrderTransitioned(params: {
  db: any;
  stripe: PaymentsStripeClient | null;
  orderId: string;
  toStatus: string;
  cancelReason?: string | null;
  now?: string;
}): Promise<OrderPaymentEffect> {
  const { db, stripe, orderId, toStatus } = params;
  const now = params.now ?? nowIso();
  const p = getPaymentForOrder(db, orderId);
  if (!p || !stripe) return "none";
  try {
    if (toStatus === "confirmed") {
      if (p.status !== "authorized") return "none";
      const out = await capturePayment(db, stripe, p.id, now);
      return out === "captured" ? "captured" : out === "authorization_gone" ? "capture_failed" : "capture_pending";
    }
    if (toStatus === "declined") {
      return (await releasePayment(db, stripe, p.id, "order_declined", now)) ? "released" : "none";
    }
    if (toStatus === "cancelled") {
      if (params.cancelReason === "no_show") {
        // Terms §7: the producer keeps the payment on a no-show — a payment
        // still only reserved (capture queued) is captured, not released.
        if (p.status === "captured") return "kept";
        if (p.status === "authorized") {
          const out = await capturePayment(db, stripe, p.id, now);
          return out === "captured" ? "kept" : out === "authorization_gone" ? "capture_failed" : "capture_pending";
        }
        return "none";
      }
      if (params.cancelReason === "buyer_cancelled") {
        // Terms §6 / forbrukerkjøpsloven § 41: after confirmation the buyer's
        // cancellation is settled by the producer in Stripe (refund minus
        // documented loss) — we keep a captured payment; a reservation that
        // was never captured is simply released.
        if (p.status === "captured") return "kept";
        return (await releasePayment(db, stripe, p.id, "buyer_cancelled", now)) ? "released" : "none";
      }
      if (p.status === "captured") {
        const r = await refundPayment(db, stripe, p.id, { reason: params.cancelReason || "order_cancelled", source: "system", now });
        return r.ok ? "refunded" : "none";
      }
      return (await releasePayment(db, stripe, p.id, params.cancelReason || "order_cancelled", now)) ? "released" : "none";
    }
  } catch (err: any) {
    console.error(`[payments] order ${orderId} → ${toStatus}: payment step failed: ${String(err?.message || err)}`);
    logPaymentEvent(db, { paymentId: p.id, orderId, agentId: p.agent_id, source: "system", type: "lifecycle_step_failed", detail: `${toStatus}: ${String(err?.code || err?.type || "error")}`.slice(0, 120), now });
    return toStatus === "confirmed" ? "capture_pending" : "none";
  }
  return "none";
}

export interface MaintenanceResult {
  expired_orders: number;
  captured: number;
  released: number;
  refunded: number;
  sessions_expired: number;
  intents_synced: number;
  orphans_notified: number;
}

/** Hook for the buyer receipt (skive 4) without an import cycle. */
let onOrderExpired: ((orderId: string) => void) | null = null;
export function setOnOrderExpiredHook(fn: ((orderId: string) => void) | null): void { onOrderExpired = fn; }

/**
 * Every few minutes (src/index.ts, PAYMENTS_ENABLED only) and on demand
 * (admin). Covers lost webhooks and failed Stripe calls:
 *   1. a reservation the producer did not confirm before capture_deadline_at
 *      → order cancelled (payment_expired) + reservation released;
 *   2. confirmed/ready/completed orders whose payment is still only
 *      authorized → capture again;
 *   3. declined/cancelled orders whose payment is still reserved → release;
 *   4. payment links past their expiry with no webhook → re-read the
 *      Checkout Session: expired → pay at pickup; completed → authorize.
 */
export async function runPaymentMaintenance(params: { db?: any; stripe: PaymentsStripeClient; now?: string; env?: NodeJS.ProcessEnv }): Promise<MaintenanceResult> {
  const db = params.db ?? getDb();
  const now = params.now ?? nowIso();
  const env = params.env ?? process.env;
  const out: MaintenanceResult = { expired_orders: 0, captured: 0, released: 0, refunded: 0, sessions_expired: 0, intents_synced: 0, orphans_notified: 0 };
  const step = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (err: any) { console.error(`[payments] maintenance ${label} failed: ${String(err?.message || err)}`); }
  };

  const overdue = db.prepare(`
    SELECT p.id, p.order_id FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.status = 'authorized' AND p.capture_deadline_at IS NOT NULL AND p.capture_deadline_at <= ? AND o.status = 'pending'
  `).all(now) as Array<{ id: string; order_id: string }>;
  for (const r of overdue) {
    await step(`deadline ${r.order_id}`, async () => {
      // transitionOrder refuses payment_expired unless the order is STILL
      // pending — a producer who confirmed meanwhile wins, and only then is
      // the (re-read, still authorized) reservation released.
      const t = transitionOrder(r.order_id, "cancelled", { actor: "system", cancelReason: "payment_expired" });
      if (!t.success) return;
      out.expired_orders++;
      const fresh = db.prepare(`SELECT status FROM payments WHERE id = ?`).get(r.id) as { status: string } | undefined;
      if (fresh?.status === "authorized" && (await releasePayment(db, params.stripe, r.id, "payment_expired", now))) out.released++;
      void sendBuyerOrderReceipt(r.order_id, "cancelled");
      if (onOrderExpired) onOrderExpired(r.order_id);
    });
  }

  // Orders the producer confirmed (or that ended as a no-show — terms §7,
  // the producer keeps the payment) whose payment is still only reserved.
  const toCapture = db.prepare(`
    SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.status = 'authorized'
      AND (o.status IN ('confirmed','ready','completed') OR (o.status = 'cancelled' AND o.cancel_reason = 'no_show'))
  `).all() as Array<{ id: string }>;
  for (const r of toCapture) {
    await step(`capture ${r.id}`, async () => { if ((await capturePayment(db, params.stripe, r.id, now)) === "captured") out.captured++; });
  }

  const toRelease = db.prepare(`
    SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.status = 'authorized'
      AND (o.status = 'declined' OR (o.status = 'cancelled' AND COALESCE(o.cancel_reason, '') <> 'no_show'))
  `).all() as Array<{ id: string }>;
  for (const r of toRelease) {
    await step(`release ${r.id}`, async () => { if (await releasePayment(db, params.stripe, r.id, "order_closed", now)) out.released++; });
  }

  // A captured payment on an order the producer could not deliver (or that
  // was declined/expired) that was never refunded — e.g. the refund call
  // failed after the cancellation. Buyer-cancelled and no-show orders are
  // left to the producer (terms §5/§7).
  const toRefund = db.prepare(`
    SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.status = 'captured' AND p.refunded_ore = 0
      AND (o.status = 'declined' OR (o.status = 'cancelled' AND o.cancel_reason IN ('producer_cancelled','payment_expired')))
  `).all() as Array<{ id: string }>;
  for (const r of toRefund) {
    await step(`refund ${r.id}`, async () => {
      const res = await refundPayment(db, params.stripe, r.id, { reason: "order_not_delivered", source: "system", now });
      if (res.ok) out.refunded++;
    });
  }

  // Prepay orders nobody was told about: the process died between the
  // submit commit and the payment link (no payments row after 10 minutes),
  // or the payment ended without the order switching to pay at pickup.
  const orphans = db.prepare(`
    SELECT o.id, p.status AS pay_status FROM orders o LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.status = 'pending' AND o.payment_mode = 'prepay'
      AND ((p.id IS NULL AND o.created_at <= datetime(?)) OR p.status IN ('canceled','expired','failed'))
  `).all(addMinutesIso(now, -10)) as Array<{ id: string; pay_status: string | null }>;
  for (const o of orphans) {
    await step(`orphan ${o.id}`, async () => {
      if (fallbackToPayAtPickup(db, o.id, o.pay_status ? "not_prepaid" : "none")) out.orphans_notified++;
    });
  }

  // A capture that keeps failing would leave a producer who confirmed
  // without the money — say so loudly (once per payment).
  const stuck = db.prepare(`
    SELECT p.id, p.order_id, p.agent_id FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.status = 'authorized' AND o.status IN ('confirmed','ready','completed')
      AND (SELECT COUNT(*) FROM payment_events e WHERE e.payment_id = p.id AND e.type = 'capture_retry_pending') >= 3
      AND NOT EXISTS (SELECT 1 FROM payment_events e WHERE e.payment_id = p.id AND e.type = 'capture_stuck')
  `).all() as Array<{ id: string; order_id: string; agent_id: string }>;
  for (const r of stuck) {
    console.error(`[payments] ALERT capture keeps failing order=${r.order_id} payment=${r.id}`);
    logPaymentEvent(db, { paymentId: r.id, orderId: r.order_id, agentId: r.agent_id, source: "system", type: "capture_stuck", now });
  }

  const staleLinks = db.prepare(`
    SELECT * FROM payments WHERE status = 'requires_payment' AND checkout_expires_at IS NOT NULL AND checkout_expires_at <= ?
  `).all(addMinutesIso(now, -10)) as PaymentRow[];
  for (const p of staleLinks) {
    await step(`session ${p.id}`, async () => {
      if (!p.checkout_session_id) return;
      const cs = await params.stripe.checkout.sessions.retrieve(p.checkout_session_id, { stripeAccount: p.stripe_account_id });
      if (cs.status === "expired") {
        const after: AfterCommit[] = [];
        db.transaction(() => applySessionExpired(db, p, { source: "system", now, after }))();
        await runAfterCommit(after, { db, stripe: params.stripe, now });
        out.sessions_expired++;
      } else if (cs.status === "complete") {
        const intentId = intentIdOf(cs.payment_intent);
        if (intentId) {
          db.prepare(`UPDATE payments SET payment_intent_id = COALESCE(payment_intent_id, ?), updated_at = ? WHERE id = ?`).run(intentId, now, p.id);
          if (await syncPaymentIntent(db, params.stripe, p.id, now, env)) out.intents_synced++;
        }
      }
    });
  }
  return out;
}

/**
 * Rollback helper (PAYMENTS_ENABLED=drain, then off): release every unpaid
 * link and every reservation the producer has NOT confirmed. A reservation on
 * an order the producer confirmed (or that ended as a no-show) is left for
 * the capture step — releasing it would take money the producer is owed for
 * goods already promised or handed over. In "drain" the maintenance job
 * captures those; /admin/payments/status shows when nothing is open.
 */
export async function releaseAllOpenPayments(db: any, stripe: PaymentsStripeClient, now: string = nowIso()): Promise<{ released: number; left_for_capture: number }> {
  const rows = db.prepare(`
    SELECT p.id, p.order_id, p.status, o.status AS order_status, o.cancel_reason
    FROM payments p LEFT JOIN orders o ON o.id = p.order_id
    WHERE p.status IN ('requires_payment','authorized')
  `).all() as Array<{ id: string; order_id: string; status: string; order_status: string | null; cancel_reason: string | null }>;
  let released = 0;
  let leftForCapture = 0;
  for (const r of rows) {
    const owed = r.status === "authorized" && (
      r.order_status === "confirmed" || r.order_status === "ready" || r.order_status === "completed" ||
      (r.order_status === "cancelled" && r.cancel_reason === "no_show"));
    if (owed) { leftForCapture++; continue; }
    try {
      if (!(await releasePayment(db, stripe, r.id, "rollback", now))) continue;
      released++;
      // An unpaid link: releasePayment already switched the order to pay at
      // pickup and announced it. A reservation on a still-pending order the
      // producer was told about: tell them it will NOT be captured.
      if (r.status === "authorized") {
        const upd = db.prepare(`
          UPDATE orders SET payment_mode = 'at_pickup', updated_at = datetime('now')
          WHERE id = ? AND payment_mode = 'prepay' AND status = 'pending'
        `).run(r.order_id);
        if (upd.changes === 1) notifyProducer(r.order_id, { status: "payment_released" });
      }
    } catch (err: any) {
      console.error(`[payments] rollback release ${r.id} failed: ${String(err?.message || err)}`);
    }
  }
  return { released, left_for_capture: leftForCapture };
}
