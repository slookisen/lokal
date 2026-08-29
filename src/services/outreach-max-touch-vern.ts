// ─── Outreach max-touch-vern — L1 knob + pure classifier + address lookup ───
//
// dev-request 2026-08-29-outreach-max-touch-vern. Daniel, live, after a CRM
// audit found 99 addresses stuck in repeat-send with zero inbound reply ever:
// never send new cold outreach to an address that has already received
// >= threshold outreach emails (across ALL verticals — outreach_sent_log is
// email-keyed and cross-vertical by design, same reasoning as the P0-2026-07-
// 11 cooldown invariant this module sits next to) with no reply EVER. This
// module owns three things, mirroring services/gardssalg-outreach-size-gate.ts
// (the fleet's existing template for an admin-togglable, no-deploy L1 lever):
//
//   1. computeMaxTouchSuppressed — a pure classifier over
//      (sendCount, hasInboundEver, config). An address with a reply is NEVER
//      suppressed, no matter how many times it was sent to — the rule is
//      explicitly "no reply", not "too many sends" alone. Disabled config
//      (enabled:false) never suppresses, same as the size-gate's off switch.
//
//   2. getOutreachMaxTouchVernConfig / setOutreachMaxTouchVernConfig — the L1
//      threshold + on/off knob, DB-backed (same "outreach-max-touch-vern.
//      outreach_max_touch_vern_config" singleton-row shape as the size-gate's
//      own config table) so Daniel can move the threshold without a deploy.
//      Unlike the size-gate, this ships enabled:true from deploy — Daniel's
//      order that triggered this dev-request IS the on-decision (99 addresses
//      were already found stuck), so a default-off knob would silently not
//      do the one thing it was built for.
//
//   3. getMaxTouchStatusForEmail — the address-keyed lookup (COUNT of prior
//      outreach_sent_log rows for the email, any vertical, AND whether the
//      email has EVER sent an inbound crm_messages row) that both the
//      candidate-selection gate (admin-outreach-candidates.ts, mode=second)
//      and the send-time invariant (routes/crm.ts, both send surfaces) call.
//      Deliberately ADDRESS-based, not mode-based or intent-based: the same
//      function answers "is this email max-touch-suppressed right now" for
//      any caller, so a future touch-N selection mode reusing the same
//      address needs no new suppression logic of its own. Read-only — it
//      NEVER deletes or resets outreach_sent_log rows; an inbound reply lifts
//      suppression without touching the send-count history (Part B of the
//      dev-request: "must NOT reset/delete the send-count log itself").
//
// Single-row config table (id='singleton', database/init.ts, same file as
// outreach_sent_log itself — both are cross-vertical and live on the MAIN db,
// not the per-vertical experiences db the size-gate's config lives on).
// Absence of a row (fresh DB, never configured) is NOT an error — it falls
// back to the documented default (enabled:true, threshold:3) rather than
// requiring a seed migration.
import type Database from "better-sqlite3";

export const OUTREACH_MAX_TOUCH_VERN_DEFAULT_THRESHOLD = 3;
export const OUTREACH_MAX_TOUCH_VERN_DEFAULT_ENABLED = true;

export interface OutreachMaxTouchVernConfig {
  enabled: boolean;
  threshold: number;
  updated_at: string | null;
  updated_by: string | null;
  note: string | null;
  // true when no row has ever been written (the fixed default is in
  // effect) — surfaced so the admin GET can tell Daniel "nobody has moved
  // this yet" apart from "someone deliberately set it to the default".
  is_default: boolean;
}

type MaxTouchVernConfigRow = {
  enabled: number;
  threshold: number;
  updated_at: string | null;
  updated_by: string | null;
  note: string | null;
};

/**
 * Pure classifier: an address is max-touch-suppressed iff the gate is
 * enabled, it has NEVER sent an inbound message, AND its prior-send count
 * meets or exceeds the threshold. A reply (hasInboundEver) always wins —
 * checked FIRST, before the count, so it reads as the override it is: "no
 * reply" is the rule, not "too many sends" alone (dev-request 2026-08-29,
 * boundary case: 3 sends + 1 inbound reply -> NOT suppressed).
 */
export function computeMaxTouchSuppressed(
  sendCount: number,
  hasInboundEver: boolean,
  config: { enabled: boolean; threshold: number },
): boolean {
  if (!config.enabled) return false;
  if (hasInboundEver) return false;
  return sendCount >= config.threshold;
}

/**
 * Always a fresh SELECT — deliberately NOT cached in-process, so a write from
 * any admin call (this instance or another) is visible to the very next
 * read, including one already in flight on a different route. This is what
 * makes the knob genuinely live: no restart, no redeploy, no process-local
 * cache to go stale. Same discipline as getGardssalgSizeGateConfig.
 */
export function getOutreachMaxTouchVernConfig(db: Database.Database): OutreachMaxTouchVernConfig {
  const row = db
    .prepare(
      `SELECT enabled, threshold, updated_at, updated_by, note
         FROM outreach_max_touch_vern_config WHERE id = 'singleton'`,
    )
    .get() as MaxTouchVernConfigRow | undefined;
  if (!row) {
    return {
      enabled: OUTREACH_MAX_TOUCH_VERN_DEFAULT_ENABLED,
      threshold: OUTREACH_MAX_TOUCH_VERN_DEFAULT_THRESHOLD,
      updated_at: null,
      updated_by: null,
      note: null,
      is_default: true,
    };
  }
  return {
    enabled: row.enabled === 1,
    threshold: row.threshold,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    note: row.note,
    is_default: false,
  };
}

/**
 * Upsert the singleton row. Only the fields present in `patch` change — same
 * PATCH-like discipline as setGardssalgSizeGateConfig. Returns the config as
 * it reads back immediately after the write (never trusts the caller's patch
 * blindly — same "re-read after write" discipline as the size-gate).
 */
export function setOutreachMaxTouchVernConfig(
  db: Database.Database,
  patch: { enabled?: boolean; threshold?: number; note?: string | null },
  updatedBy: string,
): OutreachMaxTouchVernConfig {
  const current = getOutreachMaxTouchVernConfig(db);
  const next = {
    enabled: patch.enabled ?? current.enabled,
    threshold: patch.threshold ?? current.threshold,
    note: patch.note !== undefined ? patch.note : current.note,
  };
  db
    .prepare(
      `INSERT INTO outreach_max_touch_vern_config (id, enabled, threshold, updated_at, updated_by, note)
       VALUES ('singleton', @enabled, @threshold, datetime('now'), @updated_by, @note)
       ON CONFLICT(id) DO UPDATE SET
         enabled = excluded.enabled,
         threshold = excluded.threshold,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by,
         note = excluded.note`,
    )
    .run({
      enabled: next.enabled ? 1 : 0,
      threshold: next.threshold,
      updated_by: updatedBy,
      note: next.note ?? null,
    });
  return getOutreachMaxTouchVernConfig(db);
}

export interface MaxTouchStatus {
  send_count: number;
  last_sent_at: string | null;
  has_inbound_ever: boolean;
  suppressed: boolean;
  threshold: number;
  enabled: boolean;
}

/**
 * Address-keyed lookup: how many outreach_sent_log rows exist for this email
 * (ANY vertical — outreach_sent_log.recipient_email is the cross-vertical
 * ledger, same one the P0-2026-07-11 cooldown invariant reads), and has this
 * email EVER sent an inbound crm_messages row (no time window — "no reply"
 * means no reply ever, not no reply recently). Both queries are read-only and
 * intentionally unbounded in time — this is a lifetime count/flag, not a
 * cooldown window. Mirrors the inbound-check JOIN shape already used by the
 * hard cooldown invariant in routes/crm.ts (crm_messages -> crm_threads ->
 * crm_contacts, direction='in', matched by LOWER(email)).
 */
export function getMaxTouchStatusForEmail(
  db: Database.Database,
  email: string,
  config: OutreachMaxTouchVernConfig,
): MaxTouchStatus {
  const normalized = email.trim().toLowerCase();
  const sentRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt, MAX(sent_at) AS last_sent_at
         FROM outreach_sent_log
        WHERE recipient_email IS NOT NULL AND LOWER(recipient_email) = ?`,
    )
    .get(normalized) as { cnt: number; last_sent_at: string | null };
  const inboundRow = db
    .prepare(
      `SELECT 1 AS hit
         FROM crm_messages m
         JOIN crm_threads t ON t.id = m.thread_id
         JOIN crm_contacts c ON c.id = t.contact_id
        WHERE m.direction = 'in'
          AND LOWER(c.email) = ?
        LIMIT 1`,
    )
    .get(normalized) as { hit: number } | undefined;

  const sendCount = sentRow?.cnt ?? 0;
  const hasInboundEver = !!inboundRow;
  return {
    send_count: sendCount,
    last_sent_at: sentRow?.last_sent_at ?? null,
    has_inbound_ever: hasInboundEver,
    suppressed: computeMaxTouchSuppressed(sendCount, hasInboundEver, config),
    threshold: config.threshold,
    enabled: config.enabled,
  };
}
