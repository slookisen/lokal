/**
 * Trust-event service — the transaction trust-ledger write/read path.
 * dev-request 2026-07-13-pilot-ordre-loop.
 *
 * One row per terminal transaction outcome. Writers today:
 *   - cart-service.transitionOrder(): order_completed / order_no_show /
 *     order_declined at the corresponding terminal order state.
 * Reserved (NOT wired yet — by design, see the dev-request):
 *   - booking-resolve (opplevagent) will call recordTrustEvent() with
 *     booking_attended / booking_no_show when that loop is connected.
 *
 * Read by trust-score-service's interaction signal (getTrustEventCounts).
 */

import { randomUUID } from "crypto";
import { getDb } from "../database/init";

// Module-local test-DB pin, same race-proof idiom as cart-service's
// __setCartTestDb: production always has _trustTestDb === null → getDb().
let _trustTestDb: any = null;
export function __setTrustEventTestDb(db: any): void { _trustTestDb = db; }

export type TrustEventType =
  | "order_completed"
  | "order_no_show"
  | "order_declined"
  | "booking_attended"
  | "booking_no_show";

const VALID_EVENT_TYPES: ReadonlySet<string> = new Set([
  "order_completed",
  "order_no_show",
  "order_declined",
  "booking_attended",
  "booking_no_show",
]);

/**
 * Append one trust-ledger event. Never throws — a ledger-write failure must
 * never take down the transaction that triggered it (same posture as the
 * fire-and-forget notification path). Failures are logged loudly instead.
 * Returns true iff the row was written.
 */
export function recordTrustEvent(input: {
  agentId: string;
  eventType: TrustEventType;
  ref?: string | null;
}): boolean {
  try {
    if (!input.agentId || !VALID_EVENT_TYPES.has(input.eventType)) {
      console.error(
        `[trust-events] REJECTED invalid event agent=${input.agentId} type=${input.eventType}`
      );
      return false;
    }
    const db = _trustTestDb ?? getDb();
    db.prepare(`
      INSERT INTO trust_events (id, agent_id, event_type, ref, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(randomUUID(), input.agentId, input.eventType, input.ref ?? null);
    return true;
  } catch (err) {
    console.error(
      `[trust-events] write FAILED agent=${input.agentId} type=${input.eventType}:`,
      err
    );
    return false;
  }
}

export interface TrustEventCounts {
  completed: number; // order_completed + booking_attended
  noShows: number;   // order_no_show + booking_no_show
  declined: number;  // order_declined
  total: number;
}

/**
 * Aggregate counts for the trust-score interaction signal. Defensive: if the
 * table is missing (e.g. a minimal test schema), returns all-zero counts so
 * scores behave exactly as before this ledger existed.
 */
export function getTrustEventCounts(agentId: string): TrustEventCounts {
  try {
    const db = _trustTestDb ?? getDb();
    const rows = db.prepare(
      "SELECT event_type, COUNT(*) AS c FROM trust_events WHERE agent_id = ? GROUP BY event_type"
    ).all(agentId) as Array<{ event_type: string; c: number }>;
    const counts: TrustEventCounts = { completed: 0, noShows: 0, declined: 0, total: 0 };
    for (const r of rows) {
      if (r.event_type === "order_completed" || r.event_type === "booking_attended") counts.completed += r.c;
      else if (r.event_type === "order_no_show" || r.event_type === "booking_no_show") counts.noShows += r.c;
      else if (r.event_type === "order_declined") counts.declined += r.c;
      counts.total += r.c;
    }
    return counts;
  } catch {
    return { completed: 0, noShows: 0, declined: 0, total: 0 };
  }
}
