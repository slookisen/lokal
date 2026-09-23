/**
 * Cart contact-data sweep — dev-request
 * 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt, Slice 1
 * (carts) + Slice 2 (orders + scheduler wiring).
 *
 * Nulls the 5 buyer-contact columns
 * (buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at)
 * on TWO independent clocks:
 *
 *   - `carts`: 30 days after the cart's orders ALL reach a TERMINAL status
 *     (declined/completed/cancelled — same terminal set as cart-service.ts's
 *     VALID_TRANSITIONS), or — for a cart that produced no real order at
 *     all (every chosen producer was contact-mode / ineligible) — 30 days
 *     after the cart itself was submitted, since there is no order
 *     lifecycle to wait on. Unchanged from Slice 1.
 *   - `orders` (Slice 2 — orders gained their own copy of these 5 columns,
 *     see database/init.ts): each order is swept INDEPENDENTLY, 30 days
 *     after THAT order's own status reaches TERMINAL — regardless of any
 *     sibling order in the same cart. A cart with two producers, one
 *     already `completed` 40 days ago and one still `pending`, gets its
 *     finished order's contact copy nulled now even though the cart-level
 *     fields (still gated on the "all orders terminal" rule above) do not
 *     clear yet.
 *
 * Privacy: this module NEVER logs a buyer_name/buyer_email/buyer_phone
 * value — sweepExpiredCartContactData() returns only cart/order ids (not
 * personal data) and counts, for a caller to log/report on safely.
 *
 * Scheduler wiring (Slice 2): src/index.ts calls this hourly, gated behind
 * CART_CONTACT_SWEEP_SCHEDULER_ENABLED (default OFF — same opt-in-by-
 * default posture as every other new scheduled job in this file, e.g.
 * CATALOG_SYNC_SCHEDULER_ENABLED / VERIFIER_SCHEDULER_ENABLED), firing
 * once/day inside one fixed UTC hour. See this slice's build report for
 * why this is NOT gated behind HANDLELISTE_ENABLED: that flag controls a
 * customer-facing surface (the /handleliste page, not yet built) — gating
 * a privacy-deletion sweep on a UI feature flag would mean disabling the
 * feature also stops deleting contact data already collected, which is
 * backwards. A dedicated flag keeps the two concerns independent.
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
  // Slice 2: orders swept on their OWN terminal+30d clock, independent of
  // the cart-level rule above — see this file's module doc comment.
  sweptOrderIds: string[];
  sweptOrderCount: number;
}

// Mirrors cart-service.ts's VALID_TRANSITIONS: these three statuses have no
// further allowed transition, i.e. terminal.
const TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set(["declined", "completed", "cancelled"]);

/**
 * Nulls buyer contact fields on every `carts` row AND every `orders` row
 * eligible per the rules in this file's module doc comment. Pure/idempotent:
 * a row with nothing left to null (already swept, or never had contact
 * fields — e.g. an MCP-only cart/order from before this feature) is never
 * selected, so re-running costs nothing. `now` is injectable for tests;
 * real callers should omit it.
 */
export function sweepExpiredCartContactData(
  cutoffDays: number = 30,
  now: Date = new Date()
): CartContactSweepResult {
  const db = _sweepTestDb ?? getDb();

  const cutoff = new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);
  // SQLite datetime('now')-style "YYYY-MM-DD HH:MM:SS" (UTC, no offset) —
  // matches every updated_at/created_at column written via datetime('now')
  // in this schema, so plain string comparison is a valid chronological
  // comparison (same convention cart-service-supply-graph.test.ts's sqlTs()
  // fixture helper documents).
  const cutoffStr = cutoff.toISOString().slice(0, 19).replace("T", " ");

  const cartCandidates = db.prepare(`
    SELECT id, updated_at
    FROM carts
    WHERE status = 'submitted'
      AND (buyer_name IS NOT NULL OR buyer_email IS NOT NULL OR buyer_phone IS NOT NULL
           OR delivery_note IS NOT NULL OR contact_consent_at IS NOT NULL)
  `).all() as Array<{ id: string; updated_at: string }>;

  // Slice 2: orders carry their own copy of the same 5 columns — swept
  // independently, per order, on ITS OWN terminal+30d clock (never gated on
  // sibling orders in the same cart, unlike the cart-level rule above).
  const orderCandidates = db.prepare(`
    SELECT id, status, updated_at
    FROM orders
    WHERE (buyer_name IS NOT NULL OR buyer_email IS NOT NULL OR buyer_phone IS NOT NULL
           OR delivery_note IS NOT NULL OR contact_consent_at IS NOT NULL)
  `).all() as Array<{ id: string; status: string; updated_at: string }>;

  const sweptCartIds: string[] = [];
  const sweptOrderIds: string[] = [];

  if (cartCandidates.length || orderCandidates.length) {
    const ordersByCartStmt = db.prepare(`SELECT status, updated_at FROM orders WHERE cart_id = ?`);
    const nullOutCartStmt = db.prepare(`
      UPDATE carts
      SET buyer_name = NULL, buyer_email = NULL, buyer_phone = NULL,
          delivery_note = NULL, contact_consent_at = NULL
      WHERE id = ?
    `);
    const nullOutOrderStmt = db.prepare(`
      UPDATE orders
      SET buyer_name = NULL, buyer_email = NULL, buyer_phone = NULL,
          delivery_note = NULL, contact_consent_at = NULL
      WHERE id = ?
    `);

    const tx = db.transaction(() => {
      for (const cart of cartCandidates) {
        const orders = ordersByCartStmt.all(cart.id) as Array<{ status: string; updated_at: string }>;

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
          nullOutCartStmt.run(cart.id);
          sweptCartIds.push(cart.id);
        }
      }

      for (const order of orderCandidates) {
        if (TERMINAL_ORDER_STATUSES.has(order.status) && order.updated_at <= cutoffStr) {
          nullOutOrderStmt.run(order.id);
          sweptOrderIds.push(order.id);
        }
      }
    });
    tx();
  }

  return {
    sweptCartIds,
    sweptCount: sweptCartIds.length,
    sweptOrderIds,
    sweptOrderCount: sweptOrderIds.length,
  };
}
