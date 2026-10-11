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

/** Pilot list check — closed by default; "*" only opens it in live mode. */
export function isAgentAllowedForPayments(agentId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = paymentsAllowedAgentIds(env);
  if (list.includes(agentId)) return true;
  return list.includes("*") && paymentsLivemode(env);
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
