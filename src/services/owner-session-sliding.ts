/**
 * owner-session-sliding.ts — the RFB owner session that is renewed by use
 * (A2A dev-request 2026-11-09-rfb-eierokt-fornyes-ved-bruk). One place for the
 * switch, the numbers and the renewal, so the /eier login paths, the session
 * check, the privacy page and the login e-mail (tekstpakke C punkt 5) never
 * carry their own copy of the constant.
 *
 *   OWNER_SESSION_SLIDING_ENABLED : «1»/«true» = on; default off; read per call.
 *   OWNER_SESSION_IDLE_DAYS       : days without use before the session ends (default 30).
 *   OWNER_SESSION_MAX_DAYS        : the hard cap in days after the session started (default 90).
 *
 * Flag off: every session is the fixed 7 days it always was, and nothing is
 * renewed. Flag on: a new session lasts min(idle, cap) days; a session that
 * verifyOwnerSession() has just accepted is moved to
 * min(now + idle, start + cap), start = used_at (fallback created_at), but
 * only when that is more than 24 hours later than the stored expiry (at most
 * one write per session per day), plus the single final step onto the cap. The UPDATE carries
 * `datetime(expires_at) > datetime('now')`, so a row that is expired, logged
 * out or revoked (expires_at in the past) is never revived, and a logout that
 * lands first always wins.
 *
 * Only the RFB main DB's magic_links. Opplevagent/gårdssalg sessions and
 * dental are untouched.
 */

import type { getDb } from "../database/init";

type Db = ReturnType<typeof getDb>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The fixed session lifetime with the flag off (unchanged since M2: 7 days). */
export const OWNER_SESSION_FIXED_MS = 7 * DAY_MS;

/** A renewal is written only when it moves the expiry more than this. */
export const OWNER_SESSION_RENEW_MIN_STEP_MS = DAY_MS;

/**
 * ALLOWLIST of magic_links id prefixes that are genuine /eier owner sessions,
 * the only rows that ever slide (security review of 8c920ba, B1):
 *   "ml_"     — the e-mailed /eier login link whose token becomes the session
 *               (routes/owner-portal.ts createOwnerLoginLink, kind "request");
 *   "mlsess_" — a session row opened by openOwnerSession (routes/owner-portal.ts)
 *               and by the order-activation service.
 * Everything else keeps today's fixed expiry: the /selger e-mail login rows
 * (uuid id, 15 minutes, knowledge-service createMagicLink), the "mlbridge_"
 * hand-off rows (15 minutes) and the "mlclaim_" claim-approval links.
 */
const SLIDING_OWNER_SESSION_ID_PREFIXES = ["ml_", "mlsess_"] as const;

export function isSlidingOwnerSessionRowId(id: unknown): boolean {
  const s = typeof id === "string" ? id : "";
  return SLIDING_OWNER_SESSION_ID_PREFIXES.some((p) => s.startsWith(p));
}

let warnedCapBelowIdle = false;
/** Logs once per process when OWNER_SESSION_MAX_DAYS < OWNER_SESSION_IDLE_DAYS (the cap then rules). */
function warnIfCapBelowIdle(env: NodeJS.ProcessEnv): void {
  if (warnedCapBelowIdle || ownerSessionMaxDays(env) >= ownerSessionIdleDays(env)) return;
  warnedCapBelowIdle = true;
  console.warn(`[owner-session] OWNER_SESSION_MAX_DAYS (${ownerSessionMaxDays(env)}) is below OWNER_SESSION_IDLE_DAYS (${ownerSessionIdleDays(env)}); the cap rules`);
}

export function isOwnerSessionSlidingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OWNER_SESSION_SLIDING_ENABLED === "1" || env.OWNER_SESSION_SLIDING_ENABLED === "true";
}

export function ownerSessionMaxDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OWNER_SESSION_MAX_DAYS);
  return Number.isInteger(n) && n > 0 ? n : 90;
}

export function ownerSessionIdleDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OWNER_SESSION_IDLE_DAYS);
  return Number.isInteger(n) && n > 0 ? n : 30;
}

/**
 * Lifetime of a session opened now (expires_at = now + this; the cookie's
 * maxAge = this). Flag off: 7 days. Flag on: idle days, capped by the max.
 */
export function newOwnerSessionLifetimeMs(env: NodeJS.ProcessEnv = process.env): number {
  if (!isOwnerSessionSlidingEnabled(env)) return OWNER_SESSION_FIXED_MS;
  warnIfCapBelowIdle(env);
  return Math.min(ownerSessionIdleDays(env), ownerSessionMaxDays(env)) * DAY_MS;
}

/**
 * Parses a magic_links timestamp: ISO-8601 (toISOString) or SQLite's native
 * "YYYY-MM-DD HH:MM:SS" (datetime('now'), UTC). NaN when unreadable.
 */
export function parseOwnerSessionTime(v: unknown): number {
  if (typeof v !== "string" || !v) return NaN;
  const native = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(v.trim());
  return Date.parse(native ? `${native[1]}T${native[2]}Z` : v);
}

/** The sliding expiry for a session that started at `startMs`, used at `nowMs`. */
export function slidingOwnerSessionExpiryMs(startMs: number, nowMs: number, env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(nowMs + ownerSessionIdleDays(env) * DAY_MS, startMs + ownerSessionMaxDays(env) * DAY_MS);
}

export interface OwnerSessionRow {
  id?: unknown;
  token?: unknown;
  used_at?: unknown;
  created_at?: unknown;
  expires_at?: unknown;
}

/**
 * Renews the session row verifyOwnerSession() has just accepted (used, not
 * expired, not a claim-approval link — the caller's checks). Returns the new
 * expiry (ms) when a write happened, else null (flag off, a row outside the
 * "ml_"/"mlsess_" allowlist — /selger uuid rows, bridge rows — step
 * under 24 hours, unreadable timestamps, or the row expired / was revoked in
 * the meantime).
 */
export function renewOwnerSessionOnUse(db: Db, row: OwnerSessionRow, nowMs: number = Date.now()): number | null {
  if (!isOwnerSessionSlidingEnabled()) return null;
  const token = typeof row.token === "string" ? row.token : "";
  if (!token) return null;
  if (!isSlidingOwnerSessionRowId(row.id)) return null;
  const stored = parseOwnerSessionTime(row.expires_at);
  if (!Number.isFinite(stored) || stored <= nowMs) return null;
  let start = parseOwnerSessionTime(row.used_at);
  if (!Number.isFinite(start)) start = parseOwnerSessionTime(row.created_at);
  if (!Number.isFinite(start)) return null;
  const next = slidingOwnerSessionExpiryMs(start, nowMs);
  // The one exception to the 24-hour step: the final step onto the cap
  // (start + max days). Without it an owner who uses the portal every day at
  // the same hour would be logged out up to a day before the cap. Once the
  // expiry sits on the cap nothing is written again, so this adds at most one
  // write per session.
  const capMs = start + ownerSessionMaxDays() * DAY_MS;
  const reachesCap = next === capMs && next > stored;
  if (!(next > stored + OWNER_SESSION_RENEW_MIN_STEP_MS) && !reachesCap) return null;
  // Compare-and-set on the value just read, plus the not-expired guard: a
  // logout / revocation / admin shortening that happened first wins.
  const info = db.prepare(
    `UPDATE magic_links SET expires_at = ?
      WHERE token = ? AND used = 1 AND expires_at = ? AND datetime(expires_at) > datetime('now')`
  ).run(new Date(next).toISOString(), token, row.expires_at);
  return info.changes > 0 ? next : null;
}
