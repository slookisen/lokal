// ─── Trigger Store ──────────────────────────────────────────────
//
// Records inbound triggers, lets workers pull pending ones, and
// marks them consumed. Idempotent on idempotency_key.

import Database from "better-sqlite3";
import crypto from "crypto";
import { getDb } from "../database/init";
import {
  ALLOWED_EVENT_TYPES,
  EventType,
  TriggerRecord,
} from "../types/trigger";

interface TriggerRow {
  trigger_id: string;
  event_type: string;
  idempotency_key: string;
  payload: string;
  source: string;
  signature_verified: number;
  received_at: string;
  consumed_at: string | null;
  consumed_by: string | null;
  result: string | null;
}

function rowToRecord(row: TriggerRow): TriggerRecord {
  return {
    trigger_id: row.trigger_id,
    event_type: row.event_type,
    idempotency_key: row.idempotency_key,
    payload: JSON.parse(row.payload),
    source: row.source,
    signature_verified: row.signature_verified === 1,
    received_at: row.received_at,
    consumed_at: row.consumed_at ?? undefined,
    consumed_by: row.consumed_by ?? undefined,
    result: row.result ?? undefined,
  };
}

export function isAllowedEventType(t: string): t is EventType {
  return (ALLOWED_EVENT_TYPES as readonly string[]).includes(t);
}

/**
 * Verify the X-Trigger-Signature header against the body using
 * HMAC-SHA256. Returns true if valid, false if invalid or no secret.
 *
 * If TRIGGER_HMAC_SECRET is not set, signature_verified will be false
 * for all triggers — log a warning at startup. In production, set
 * TRIGGER_REQUIRE_SIGNATURE=true to reject unsigned triggers.
 */
export function verifyHmac(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  const secret = process.env.TRIGGER_HMAC_SECRET;
  if (!secret) return false;
  if (!signatureHeader) return false;

  // Accept either "sha256=<hex>" or just "<hex>".
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Constant-time compare.
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    return false;
  }
}

/**
 * Record a trigger. Idempotent on idempotency_key — if the key has
 * been seen before, returns the existing row instead of creating a new
 * one. (Deliberately permissive: callers can retry safely.)
 */
export function recordTrigger(args: {
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  source: string;
  signature_verified: boolean;
  db?: Database.Database;
}): { trigger_id: string; duplicate: boolean } {
  const conn = args.db ?? getDb();

  // Idempotency check
  const existing = conn
    .prepare(
      "SELECT trigger_id FROM platform_triggers WHERE idempotency_key = ?",
    )
    .get(args.idempotency_key) as { trigger_id: string } | undefined;

  if (existing) {
    return { trigger_id: existing.trigger_id, duplicate: true };
  }

  const trigger_id = crypto.randomUUID();
  conn
    .prepare(
      `INSERT INTO platform_triggers
       (trigger_id, event_type, idempotency_key, payload, source, signature_verified)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      trigger_id,
      args.event_type,
      args.idempotency_key,
      JSON.stringify(args.payload),
      args.source,
      args.signature_verified ? 1 : 0,
    );
  return { trigger_id, duplicate: false };
}

/**
 * Workers read this to find triggers they haven't processed yet.
 * Optional event_type filter so each agent pulls only what it cares
 * about. Returns oldest-first so events are processed in order.
 */
export function listPendingTriggers(opts: {
  event_type?: string;
  limit?: number;
  maxAgeHours?: number;
  db?: Database.Database;
} = {}): TriggerRecord[] {
  const conn = opts.db ?? getDb();
  const limit = Math.min(opts.limit ?? 50, 500);
  const maxAge = opts.maxAgeHours ?? 168; // 1 week
  const cutoff = new Date(Date.now() - maxAge * 3600_000).toISOString();

  const where = ["consumed_at IS NULL", "received_at >= ?"];
  const params: unknown[] = [cutoff];
  if (opts.event_type) {
    where.push("event_type = ?");
    params.push(opts.event_type);
  }
  const sql = `
    SELECT * FROM platform_triggers
    WHERE ${where.join(" AND ")}
    ORDER BY received_at ASC
    LIMIT ?
  `;
  params.push(limit);
  const rows = conn.prepare(sql).all(...params) as TriggerRow[];
  return rows.map(rowToRecord);
}

/**
 * Mark a trigger as consumed by a specific agent run. Idempotent —
 * second consume of the same trigger overwrites the result (last-writer-wins).
 */
export function consumeTrigger(args: {
  trigger_id: string;
  consumed_by: string;
  result?: string;
  db?: Database.Database;
}): boolean {
  const conn = args.db ?? getDb();
  const now = new Date().toISOString();
  const res = conn
    .prepare(
      `UPDATE platform_triggers
       SET consumed_at = ?, consumed_by = ?, result = ?
       WHERE trigger_id = ?`,
    )
    .run(now, args.consumed_by, args.result ?? null, args.trigger_id);
  return res.changes > 0;
}
