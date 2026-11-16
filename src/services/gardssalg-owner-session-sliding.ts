/**
 * gardssalg-owner-session-sliding.ts — the gårdssalg (Opplevagent) owner
 * session that is renewed by use (A2A dev-request 2026-11-12-opplevagent-o3-
 * eierkrav-og-innlogging, O3-3). Same design as RFB's
 * services/owner-session-sliding.ts, kept in its own module on purpose: the
 * gårdssalg session is a gardssalg_claims row in experiences.db, and the two
 * logins are not merged.
 *
 *   GARDSSALG_OWNER_SESSION_SLIDING_ENABLED : «1»/«true» = on; default off; read per call.
 *   GARDSSALG_OWNER_SESSION_IDLE_DAYS       : days without use before the session ends (default 30).
 *   GARDSSALG_OWNER_SESSION_MAX_DAYS        : hard cap in days after the session started (default 90).
 *
 * Flag off: nothing here writes; the session keeps the claim link's own
 * expires_at (7 days from when the link was issued) and the 7-day cookie.
 * Flag on: a claim link that becomes a session gets expires_at = now +
 * min(idle, cap); a session verifyGardssalgOwnerSessionToken() has just
 * accepted is moved to min(now + idle, start + cap), start = used_at (the
 * moment the link became a session; fallback created_at), but only when that
 * is more than 24 hours past the stored expiry (at most one write per session
 * per day), plus the single final step onto the cap. The UPDATE carries
 * `datetime(expires_at) > datetime('now')` and `revoked_at IS NULL`, so a row
 * that is expired, logged out or revoked is never revived.
 */

import type { getDb } from "../database/db-factory";
import { parseOwnerSessionTime } from "./owner-session-sliding";

type Db = ReturnType<typeof getDb>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The cookie lifetime with the flag off (unchanged: 7 days). */
export const GARDSSALG_OWNER_SESSION_FIXED_MS = 7 * DAY_MS;

/** A renewal is written only when it moves the expiry more than this. */
export const GARDSSALG_OWNER_SESSION_RENEW_MIN_STEP_MS = DAY_MS;

export function isGardssalgOwnerSessionSlidingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.GARDSSALG_OWNER_SESSION_SLIDING_ENABLED;
  return v === "1" || v === "true";
}

function positiveIntEnv(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function gardssalgOwnerSessionIdleDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env.GARDSSALG_OWNER_SESSION_IDLE_DAYS, 30);
}

export function gardssalgOwnerSessionMaxDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env.GARDSSALG_OWNER_SESSION_MAX_DAYS, 90);
}

/** Lifetime of a session opened now with the flag on: idle days, capped by the max. */
export function gardssalgNewOwnerSessionLifetimeMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(gardssalgOwnerSessionIdleDays(env), gardssalgOwnerSessionMaxDays(env)) * DAY_MS;
}

export interface GardssalgOwnerSessionRow {
  token?: unknown;
  used_at?: unknown;
  created_at?: unknown;
  expires_at?: unknown;
}

/**
 * Renews a used, live gardssalg_claims session row. Returns the new expiry
 * (ms) when a write happened, else null (flag off, step under 24 hours,
 * unreadable timestamps, or the row expired / was revoked in the meantime).
 */
export function renewGardssalgOwnerSessionOnUse(db: Db, row: GardssalgOwnerSessionRow, nowMs: number = Date.now()): number | null {
  if (!isGardssalgOwnerSessionSlidingEnabled()) return null;
  const token = typeof row.token === "string" ? row.token : "";
  if (!token) return null;
  const stored = parseOwnerSessionTime(row.expires_at);
  if (!Number.isFinite(stored) || stored <= nowMs) return null;
  let start = parseOwnerSessionTime(row.used_at);
  if (!Number.isFinite(start)) start = parseOwnerSessionTime(row.created_at);
  if (!Number.isFinite(start)) return null;
  const capMs = start + gardssalgOwnerSessionMaxDays() * DAY_MS;
  const next = Math.min(nowMs + gardssalgOwnerSessionIdleDays() * DAY_MS, capMs);
  // The one exception to the 24-hour step: the final step onto the cap.
  const reachesCap = next === capMs && next > stored;
  if (!(next > stored + GARDSSALG_OWNER_SESSION_RENEW_MIN_STEP_MS) && !reachesCap) return null;
  // Compare-and-set on the value just read, plus the live guards: a logout,
  // revocation or ownership change that landed first wins.
  const info = db.prepare(
    `UPDATE gardssalg_claims SET expires_at = ?
      WHERE token = ? AND used = 1 AND expires_at = ? AND revoked_at IS NULL
        AND COALESCE(draft_mode, 0) = 0 AND datetime(expires_at) > datetime('now')`,
  ).run(new Date(next).toISOString(), token, row.expires_at);
  return info.changes > 0 ? next : null;
}

/**
 * Cookie maxAge for a session just granted. Flag off: the fixed 7 days, as
 * before. Flag on: the time left to the row's stored expiry.
 */
export function gardssalgOwnerSessionCookieMaxAgeMs(db: Db, token: string, nowMs: number = Date.now()): number {
  if (!isGardssalgOwnerSessionSlidingEnabled()) return GARDSSALG_OWNER_SESSION_FIXED_MS;
  const row = db.prepare(`SELECT expires_at FROM gardssalg_claims WHERE token = ?`).get(token) as { expires_at?: string } | undefined;
  const left = parseOwnerSessionTime(row?.expires_at) - nowMs;
  return left > 0 ? left : gardssalgNewOwnerSessionLifetimeMs();
}

/**
 * Ownership change (O3-3 AK2): a claim for `providerId` has just been used by
 * `email`. Every other used, unrevoked session row of the same provider
 * that belongs to a different address is revoked, so the previous owner's
 * sessions stop verifying. The new owner's own rows (same address,
 * compared trimmed + lower-cased) are kept. Runs inside the caller's
 * transaction; returns the number of rows revoked. Not flag-gated.
 */
export function revokeOtherOwnersGardssalgSessions(db: Db, providerId: string, keepClaimId: string, email: string): number {
  const keep = String(email || "").trim().toLowerCase();
  const others = db.prepare(
    `SELECT id FROM gardssalg_claims
      WHERE provider_id = ? AND id != ? AND used = 1 AND revoked_at IS NULL
        AND LOWER(TRIM(email)) != ?`,
  ).all(providerId, keepClaimId, keep) as Array<{ id: string }>;
  let n = 0;
  for (const o of others) {
    const r = db.prepare(`UPDATE gardssalg_claims SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`).run(o.id);
    if (r.changes === 0) continue;
    n++;
    db.prepare(
      `INSERT INTO gardssalg_content_audit (id, provider_id, field_name, old_value, new_value, changed_by)
       VALUES (?, ?, 'gardssalg_claim_revoked', ?, 'revoked', 'ownership_change')`,
    ).run(`gca_${keepClaimId}_${o.id}`, providerId, o.id);
  }
  return n;
}
