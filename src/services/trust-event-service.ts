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
  /**
   * Fase A1 (dev-request 2026-10-21-rfb-mine-ordrer-ett-klikk-og-kjoperagent):
   * for order_completed, who closed the order ('auto' | 'buyer' | 'seller' |
   * 'admin'). 'auto' is counted apart (completedAuto) and does not score.
   */
  completionSource?: string | null;
}): boolean {
  try {
    if (!input.agentId || !VALID_EVENT_TYPES.has(input.eventType)) {
      console.error(
        `[trust-events] REJECTED invalid event agent=${input.agentId} type=${input.eventType}`
      );
      return false;
    }
    const db = _trustTestDb ?? getDb();
    const source = input.eventType === "order_completed" ? (input.completionSource ?? null) : null;
    if (source) {
      db.prepare(`
        INSERT INTO trust_events (id, agent_id, event_type, ref, completion_source, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(randomUUID(), input.agentId, input.eventType, input.ref ?? null, source);
    } else {
      db.prepare(`
        INSERT INTO trust_events (id, agent_id, event_type, ref, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(randomUUID(), input.agentId, input.eventType, input.ref ?? null);
    }
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
  completed: number; // order_completed (confirmed by buyer/seller/admin, or pre-Fase-A1) + booking_attended
  /** Fase A1: order_completed closed automatically (completion_source='auto') — counted apart, never in `completed`. */
  completedAuto: number;
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
    const rows = readTrustEventRows(db, agentId);
    const counts: TrustEventCounts = { completed: 0, completedAuto: 0, noShows: 0, declined: 0, total: 0 };
    for (const r of rows) {
      if (r.event_type === "order_completed" && r.auto === 1) counts.completedAuto += r.c;
      else if (r.event_type === "order_completed" || r.event_type === "booking_attended") counts.completed += r.c;
      else if (r.event_type === "order_no_show" || r.event_type === "booking_no_show") counts.noShows += r.c;
      else if (r.event_type === "order_declined") counts.declined += r.c;
      counts.total += r.c;
    }
    return counts;
  } catch {
    return { completed: 0, completedAuto: 0, noShows: 0, declined: 0, total: 0 };
  }
}

/** Counts per (event_type, auto); a DB without the Fase A1 column reads every row as non-auto. */
function readTrustEventRows(db: any, agentId: string): Array<{ event_type: string; auto: number; c: number }> {
  try {
    return db.prepare(`
      SELECT event_type, CASE WHEN completion_source = 'auto' THEN 1 ELSE 0 END AS auto, COUNT(*) AS c
      FROM trust_events WHERE agent_id = ? GROUP BY event_type, auto
    `).all(agentId) as Array<{ event_type: string; auto: number; c: number }>;
  } catch (err) {
    if (!/no such column/i.test(String((err as any)?.message || err))) throw err;
    return (db.prepare(
      "SELECT event_type, 0 AS auto, COUNT(*) AS c FROM trust_events WHERE agent_id = ? GROUP BY event_type"
    ).all(agentId) as Array<{ event_type: string; auto: number; c: number }>);
  }
}
