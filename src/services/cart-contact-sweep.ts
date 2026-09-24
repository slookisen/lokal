/**
 * Cart contact-data sweep — dev-request
 * 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt, Slice 1.
 *
 * Nulls the 5 buyer-contact columns Slice 1 added to `carts`
 * (buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at)
 * 30 days after the cart's orders all reach a TERMINAL status
 * (declined/completed/cancelled — same terminal set as cart-service.ts's
 * VALID_TRANSITIONS), or — for a cart that produced no real order at all
 * (every chosen producer was contact-mode / ineligible) — 30 days after the
 * cart itself was submitted, since there is no order lifecycle to wait on.
 *
 * Privacy: this module NEVER logs a buyer_name/buyer_email/buyer_phone
 * value — sweepExpiredCartContactData() returns only cart ids (not
 * personal data) and a count, for a caller to log/report on safely.
 *
 * WIRED (dev-request 2026-09-24-mcp-rate-limit-og-personvern-sannhet, C3)
 * into the existing once-daily auto-prune tick in src/index.ts, behind the
 * CART_CONTACT_SWEEP_LIVE env flag (mirrors the CATALOG_SYNC_SCHEDULER_ENABLED
 * -style explicit-opt-in convention already used there). Because this is a
 * REAL deletion job against production buyer data, the scheduler defaults
 * to calling it with `dryRun: true` (count-only, mutates nothing) until that
 * flag is explicitly set to "true" — see the `dryRun` parameter below and
 * src/index.ts's own comment at the call site for the rollout plan.
 */

import { getDb } from "../database/init";

// Module-local test-DB pin, same race-proof idiom as cart-service's
// __setCartTestDb / trust-event-service's __setTrustEventTestDb: production
// always has _sweepTestDb === null → getDb().
let _sweepTestDb: any = null;
export function __setCartContactSweepTestDb(db: any): void {
  _sweepTestDb = db;
}

export interface CartContactSweepResult {
  sweptCartIds: string[];
  sweptCount: number;
  /** True when this call only COUNTED eligible carts and modified nothing. */
  dryRun: boolean;
}

// Mirrors cart-service.ts's VALID_TRANSITIONS: these three statuses have no
// further allowed transition, i.e. terminal.
const TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set(["declined", "completed", "cancelled"]);

/**
 * Nulls buyer contact fields on every `carts` row eligible per the rule
 * above. Pure/idempotent: a cart with nothing left to null (already swept,
 * or never had contact fields — e.g. an MCP-only cart from before this
 * slice) is never selected, so re-running costs nothing. `now` is
 * injectable for tests; real callers should omit it.
 *
 * `dryRun` (default false): when true, candidates are found and returned
 * exactly as normal (same sweptCartIds/sweptCount a real run would report)
 * but NO row is written — a safe way to see what a real run WOULD delete
 * before enabling it for real. See src/index.ts's scheduler wiring, which
 * defaults to dryRun until CART_CONTACT_SWEEP_LIVE=true is set.
 */
export function sweepExpiredCartContactData(
  cutoffDays: number = 30,
  now: Date = new Date(),
  dryRun: boolean = false
): CartContactSweepResult {
  const db = _sweepTestDb ?? getDb();

  const cutoff = new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);
  // SQLite datetime('now')-style "YYYY-MM-DD HH:MM:SS" (UTC, no offset) —
  // matches every updated_at/created_at column written via datetime('now')
  // in this schema, so plain string comparison is a valid chronological
  // comparison (same convention cart-service-supply-graph.test.ts's sqlTs()
  // fixture helper documents).
  const cutoffStr = cutoff.toISOString().slice(0, 19).replace("T", " ");

  const candidates = db.prepare(`
    SELECT id, updated_at
    FROM carts
    WHERE status = 'submitted'
      AND (buyer_name IS NOT NULL OR buyer_email IS NOT NULL OR buyer_phone IS NOT NULL
           OR delivery_note IS NOT NULL OR contact_consent_at IS NOT NULL)
  `).all() as Array<{ id: string; updated_at: string }>;

  if (!candidates.length) return { sweptCartIds: [], sweptCount: 0, dryRun };

  const ordersStmt = db.prepare(`SELECT status, updated_at FROM orders WHERE cart_id = ?`);
  const nullOutStmt = db.prepare(`
    UPDATE carts
    SET buyer_name = NULL, buyer_email = NULL, buyer_phone = NULL,
        delivery_note = NULL, contact_consent_at = NULL
    WHERE id = ?
  `);

  const sweptCartIds: string[] = [];

  // Candidate detection is IDENTICAL whether or not this is a dry run — only
  // whether nullOutStmt actually runs differs, so a dry-run's sweptCartIds
  // reports exactly what a real run would sweep, before anything is written.
  const applyToEligibleCarts = () => {
    for (const cart of candidates) {
      const orders = ordersStmt.all(cart.id) as Array<{ status: string; updated_at: string }>;

      let eligible: boolean;
      if (orders.length > 0) {
        const allTerminal = orders.every((o) => TERMINAL_ORDER_STATUSES.has(o.status));
        if (!allTerminal) {
          eligible = false;
        } else {
          const latestUpdate = orders.reduce((m, o) => (o.updated_at > m ? o.updated_at : m), orders[0]!.updated_at);
          eligible = latestUpdate <= cutoffStr;
        }
      } else {
        // No orders at all: every chosen producer in this cart was
        // contact-mode or ineligible — no order lifecycle exists to wait
        // on, so the cart's own submit time is the clock.
        eligible = cart.updated_at <= cutoffStr;
      }

      if (eligible) {
        if (!dryRun) nullOutStmt.run(cart.id);
        sweptCartIds.push(cart.id);
      }
    }
  };

  if (dryRun) {
    // No mutation at all in a dry run — deliberately NOT wrapped in
    // db.transaction() (that API implies a write scope) even though
    // applyToEligibleCarts() itself never calls nullOutStmt.run() here.
    applyToEligibleCarts();
  } else {
    const tx = db.transaction(applyToEligibleCarts);
    tx();
  }

  return { sweptCartIds, sweptCount: sweptCartIds.length, dryRun };
}
