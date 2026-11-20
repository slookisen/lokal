/**
 * O5-8 «trakt og kilde» (dev-request
 * 2026-11-12-opplevagent-o5-besok-i-chatgpt-og-assistenter).
 *
 * Every discover_gardssalg call (outcome `search`) and every book_gardssalg
 * call (one of the codes below) writes one row to gardssalg_mcp_funnel_events:
 * the time, the outcome code and the assistant's source_client label
 * (SOURCE_CLIENT_LABELS, NULL when unknown). Nothing about the guest, no
 * booking_ref/guest_ref and no provider_id: a provider id plus a timestamp
 * would point at one booking row and so at one guest.
 *
 * Writing never throws and never changes a tool result. Rows older than
 * GARDSSALG_FUNNEL_RETENTION_DAYS are pruned by the writer, at most once an
 * hour.
 *
 * getGardssalgBookingFunnel() is the read side for
 * GET /api/opplevelser/admin/gardssalg/booking-funnel: counts only.
 */

import type Database from "better-sqlite3";
import { getDb } from "../database/db-factory";
import { isSourceClientLabel } from "../utils/url-utm";

/**
 * The closed list of outcome codes. `search` is discover_gardssalg; every other
 * code is a book_gardssalg return branch in routes/experiences-mcp.ts.
 */
export const GARDSSALG_FUNNEL_OUTCOMES = [
  "search",
  "created",
  "duplicate",
  "preview",
  "invalid_input",
  "provider_not_found",
  "provider_ambiguous",
  "weekday_mismatch",
  "not_live",
  "owner_paused",
  "outside_hours",
  "slot_bounds",
  "cap_reached",
  "as_public_read_only",
  "internal_error",
  "other",
] as const;
export type GardssalgFunnelOutcome = (typeof GARDSSALG_FUNNEL_OUTCOMES)[number];

export const GARDSSALG_FUNNEL_RETENTION_DAYS = 90;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** book_gardssalg `reason` values that are their own outcome code. */
const REASON_OUTCOMES: ReadonlySet<string> = new Set([
  "provider_not_found",
  "provider_ambiguous",
  "weekday_mismatch",
  "not_live",
  "owner_paused",
  "slot_bounds",
  "cap_reached",
  "as_public_read_only",
]);

function isOutcome(v: unknown): v is GardssalgFunnelOutcome {
  return typeof v === "string" && (GARDSSALG_FUNNEL_OUTCOMES as readonly string[]).includes(v);
}

type ToolResultLike = { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null | undefined;

/** The outcome code of a book_gardssalg tool result (read from its JSON text). */
export function classifyBookGardssalgResult(result: ToolResultLike): GardssalgFunnelOutcome {
  let p: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(String(result?.content?.[0]?.text ?? ""));
    if (parsed && typeof parsed === "object") p = parsed as Record<string, unknown>;
  } catch { /* the internal-error text is not JSON */ }
  if (!p) return result?.isError ? "internal_error" : "other";
  if (p.preview === true) return "preview";
  if (p.duplicate === true) return "duplicate";
  if (p.success === true && typeof p.booking_ref === "string") return "created";
  if (typeof p.reason === "string" && REASON_OUTCOMES.has(p.reason)) return p.reason as GardssalgFunnelOutcome;
  if (p.outside_hours === true) return "outside_hours";
  if (p.error === "invalid_input") return "invalid_input";
  if (p.error === "internal_error") return "internal_error";
  return "other";
}

let lastPruneMs = 0;

/** Test hook: the next write prunes again. */
export function __resetGardssalgFunnelPruneForTesting(): void {
  lastPruneMs = 0;
}

/** One row for one MCP call. Fail-open: never throws. */
export function recordGardssalgFunnelEvent(outcome: GardssalgFunnelOutcome, sourceClient: string | null | undefined, nowMs: number = Date.now()): void {
  try {
    if (!isOutcome(outcome)) return;
    const db = getDb("experiences");
    db.prepare("INSERT INTO gardssalg_mcp_funnel_events (created_at, outcome, source_client) VALUES (?, ?, ?)")
      .run(new Date(nowMs).toISOString(), outcome, isSourceClientLabel(sourceClient) ? sourceClient : null);
    if (nowMs - lastPruneMs >= PRUNE_EVERY_MS) {
      lastPruneMs = nowMs;
      db.prepare("DELETE FROM gardssalg_mcp_funnel_events WHERE created_at < ?")
        .run(new Date(nowMs - GARDSSALG_FUNNEL_RETENTION_DAYS * DAY_MS).toISOString());
    }
  } catch { /* fail-open: a log failure never affects the tool result */ }
}

export interface GardssalgFunnelCounts {
  search: number;
  /** Every book_gardssalg call except `preview` and `as_public_read_only` (the admin's read-only view). */
  attempt: number;
  created: number;
  /** gardssalg_bookings (source 'mcp') created in the window, by where each stands now. */
  pending: number;
  confirmed: number;
  declined: number;
  expired: number;
  cancelled: number;
  outcomes: Record<GardssalgFunnelOutcome, number>;
}

function emptyCounts(): GardssalgFunnelCounts {
  const outcomes = Object.fromEntries(GARDSSALG_FUNNEL_OUTCOMES.map((o) => [o, 0])) as Record<GardssalgFunnelOutcome, number>;
  return { search: 0, attempt: 0, created: 0, pending: 0, confirmed: 0, declined: 0, expired: 0, cancelled: 0, outcomes };
}

export const GARDSSALG_FUNNEL_UNKNOWN_CLIENT = "unknown";
type BookingStage = "pending" | "confirmed" | "declined" | "expired" | "cancelled";

/**
 * The funnel over the last `days` days, per source_client (NULL → "unknown")
 * and in total. Counts only.
 *
 * Booking stages come from gardssalg_bookings rows with source 'mcp' (not
 * test rows) created in the window, each in exactly one stage:
 *   cancelled  status 'cancelled'
 *   confirmed  pre_status 'provider_confirmed', or status confirmed_attended / no_show
 *   declined   pre_status 'provider_declined' (producer declined, or the guest
 *              turned down a suggested time)
 *   expired    pre_status 'expired'
 *   pending    the rest (awaiting_provider, time_suggested)
 */
export function getGardssalgBookingFunnel(db: Database.Database, days: number, nowMs: number = Date.now()): {
  since: string;
  by_client: Record<string, GardssalgFunnelCounts>;
  total: GardssalgFunnelCounts;
} {
  const since = new Date(nowMs - days * DAY_MS).toISOString();
  const byClient: Record<string, GardssalgFunnelCounts> = {};
  const total = emptyCounts();
  const bucket = (client: string | null): GardssalgFunnelCounts => {
    const key = client ?? GARDSSALG_FUNNEL_UNKNOWN_CLIENT;
    return (byClient[key] ??= emptyCounts());
  };

  const events = db.prepare(
    `SELECT source_client, outcome, COUNT(*) AS n
       FROM gardssalg_mcp_funnel_events
      WHERE created_at >= ?
      GROUP BY source_client, outcome`,
  ).all(since) as Array<{ source_client: string | null; outcome: string; n: number }>;
  for (const row of events) {
    const outcome: GardssalgFunnelOutcome = isOutcome(row.outcome) ? row.outcome : "other";
    for (const c of [bucket(row.source_client), total]) {
      c.outcomes[outcome] += row.n;
      if (outcome === "search") c.search += row.n;
      else if (outcome !== "preview" && outcome !== "as_public_read_only") c.attempt += row.n;
      if (outcome === "created") c.created += row.n;
    }
  }

  const bookings = db.prepare(
    `SELECT source_client,
            CASE
              WHEN status = 'cancelled' THEN 'cancelled'
              WHEN pre_status = 'provider_confirmed' OR status IN ('confirmed_attended', 'no_show') THEN 'confirmed'
              WHEN pre_status = 'provider_declined' THEN 'declined'
              WHEN pre_status = 'expired' THEN 'expired'
              ELSE 'pending'
            END AS stage,
            COUNT(*) AS n
       FROM gardssalg_bookings
      WHERE source = 'mcp' AND is_test = 0
        AND julianday(created_at) >= julianday(?)
      GROUP BY source_client, stage`,
  ).all(since) as Array<{ source_client: string | null; stage: BookingStage; n: number }>;
  for (const row of bookings) {
    for (const c of [bucket(row.source_client), total]) c[row.stage] += row.n;
  }

  return { since, by_client: byClient, total };
}
