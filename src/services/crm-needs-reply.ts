// ─── «Trenger svar» — CS på serveren, S1a ────────────────────────────────
// dev-request 2026-11-10-cs-paa-serveren (slookisen/A2A), skive S1 punkt 4.
//
// Until now nothing on the server could tell which customer threads were
// still unanswered: status was whatever the CS agent last set, a reply to a
// done thread did not reopen it, and a CS reply sent via /compose landed in a
// new thread, so the original never showed an outbound message. This module
// computes it from the messages themselves:
//
//   a thread needs a reply when
//     • status is not done/archived,
//     • category is not system/leverandor, and not an inbound sales pitch
//       (marketing thread whose first message is inbound) — a reply to OUR
//       outreach (marketing thread started outbound) does need an answer,
//     • its latest inbound is newer than its latest REAL outbound (sent_at),
//     • that latest inbound is not an automated mail (auto-reply/bounce),
//     • and nobody marked it «trenger ikke svar» after that inbound.
//
// Age is hours since the latest inbound; level P0 ≥ 24 h, P1 ≥ 12 h.
// Open crm_untriaged rows and failed inbound forwards are reported alongside,
// because they are inbound mail nobody has handled either.

import { failedReplyDeliveries } from "./crm-delivery-status";
import { getDb } from "../database/init";
import { crmService } from "./crm-service";
import type { Actor } from "./crm-service";

export const NEEDS_REPLY_P1_HOURS = 12;
export const NEEDS_REPLY_P0_HOURS = 24;

export type NeedsReplyLevel = "p0" | "p1" | "normal";

export function needsReplyLevel(ageHours: number): NeedsReplyLevel {
  if (ageHours >= NEEDS_REPLY_P0_HOURS) return "p0";
  if (ageHours >= NEEDS_REPLY_P1_HOURS) return "p1";
  return "normal";
}

export interface NeedsReplyThread {
  thread_id: string;
  vertical: string;
  subject: string | null;
  status: string;
  category: string | null;
  contact_email: string;
  contact_name: string | null;
  contact_id: string;
  contact_type: string | null;
  last_inbound_at: string;
  last_outbound_at: string | null;
  age_hours: number;
  level: NeedsReplyLevel;
  /** S2: the thread's latest open reply proposal, if any (status + why it stopped). */
  proposal?: { id: string; status: string; block_reason: string | null; created_at: string } | null;
}

/** S2: an outbound reply that did not get out (failed, or outcome unknown). */
export interface NeedsReplyOutboundFailed {
  proposal_id: string | null;
  outbox_id: string | null;
  thread_id: string | null;
  vertical: string | null;
  to_email: string | null;
  reason: string | null;
  at: string;
}

export interface NeedsReplyUntriaged {
  id: string;
  thread_id: string;
  from_email: string;
  subject: string | null;
  created_at: string;
  age_hours: number;
  level: NeedsReplyLevel;
}

export interface NeedsReplyReport {
  generated_at: string;
  counts: {
    threads: number;
    p0: number;
    p1: number;
    by_vertical: Record<string, number>;
    untriaged_open: number;
    forward_failed: number;
    crm_register_errors_7d: number;
    /** S2: proposals waiting for Daniel in the approval queue. */
    approval_needed: number;
    /** S2: replies that did not get out in the last 7 days (proposals + resend_send outbox rows). */
    outbound_failed_7d: number;
  };
  threads: NeedsReplyThread[];
  untriaged: NeedsReplyUntriaged[];
  outbound_failed: NeedsReplyOutboundFailed[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The «needs reply» report. `vertical` filters threads (untriaged is platform-less and always included). */
export function computeNeedsReply(opts: { vertical?: string | null; limit?: number } = {}): NeedsReplyReport {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const params: unknown[] = [];
  let verticalClause = "";
  if (opts.vertical) {
    verticalClause = "AND t.vertical_id = ?";
    params.push(opts.vertical);
  }
  // The clock starts at the latest inbound message from a PERSON. An
  // auto-reply or bounce never starts it, and never hides an earlier human
  // message that is still unanswered. Times compared with julianday (rows
  // mix SQLite and ISO formats).
  const rows = db
    .prepare(
      `WITH h AS (
         -- A sent_at julianday cannot parse falls back to received_at.
         SELECT m.thread_id, MAX(COALESCE(julianday(m.sent_at), julianday(m.received_at))) AS jd
           FROM crm_messages m
          WHERE m.direction = 'in'
            -- COALESCE: a message without the flag ('{}' / NULL metadata) is human.
            AND NOT (COALESCE(json_valid(m.raw_metadata), 0) = 1 AND COALESCE(json_extract(m.raw_metadata, '$.automated'), 0) = 1)
          GROUP BY m.thread_id
       ), oa AS (
         SELECT thread_id, MAX(julianday(sent_at)) AS jd
           FROM crm_messages
          WHERE direction = 'out' AND sent_at IS NOT NULL AND delivery_status = 'sent'
          GROUP BY thread_id
       ), o AS (
         -- S3: a reply Resend reported as bounced / complained did not reach
         -- the customer — it does not count as answered.
         SELECT m.thread_id, MAX(julianday(m.sent_at)) AS jd
           FROM crm_messages m
          WHERE m.direction = 'out' AND m.sent_at IS NOT NULL AND m.delivery_status = 'sent'
            AND NOT EXISTS (SELECT 1 FROM crm_message_delivery d WHERE d.crm_message_id = m.id AND d.status IN ('bounced', 'complained'))
          GROUP BY m.thread_id
       )
       SELECT t.id AS thread_id, t.vertical_id AS vertical, t.subject, t.status, t.category,
              c.email AS contact_email, c.name AS contact_name, c.id AS contact_id, c.type AS contact_type,
              strftime('%Y-%m-%dT%H:%M:%SZ', h.jd) AS last_inbound_at, t.last_outbound_at,
              (julianday('now') - h.jd) * 24.0 AS age_hours
         FROM crm_threads t
         JOIN crm_contacts c ON c.id = t.contact_id
         JOIN h ON h.thread_id = t.id
         LEFT JOIN o ON o.thread_id = t.id
         LEFT JOIN oa ON oa.thread_id = t.id
         LEFT JOIN crm_thread_flags f ON f.thread_id = t.id
        WHERE COALESCE(t.status, 'new') NOT IN ('done', 'archived')
          AND COALESCE(t.category, 'unknown') NOT IN ('system', 'leverandor')
          -- 'marketing' covers two kinds of thread: OUR outreach (first
          -- message outbound — a producer's reply there is exactly what CS
          -- must answer) and inbound sales pitches to us (first message
          -- inbound — no reply owed). Only the latter is excluded.
          AND NOT (
            COALESCE(t.category, 'unknown') = 'marketing'
            AND (SELECT m0.direction FROM crm_messages m0
                  WHERE m0.thread_id = t.id
                  ORDER BY COALESCE(julianday(m0.sent_at), julianday(m0.received_at)) ASC
                  LIMIT 1) = 'in'
          )
          AND h.jd IS NOT NULL
          AND (o.jd IS NULL OR h.jd > o.jd)
          -- last_outbound_at only decides for threads with no outbound message
          -- rows (legacy backfill); otherwise the messages above decide.
          AND (oa.jd IS NOT NULL OR t.last_outbound_at IS NULL OR julianday(t.last_outbound_at) IS NULL OR h.jd > julianday(t.last_outbound_at))
          AND (f.no_reply_at IS NULL OR julianday(f.no_reply_at) < h.jd)
          ${verticalClause}
        ORDER BY h.jd ASC
        LIMIT ${limit}`,
    )
    .all(...params) as Array<Omit<NeedsReplyThread, "level">>;

  const threads: NeedsReplyThread[] = rows.map((r) => {
    const age = Math.max(0, round1(Number(r.age_hours) || 0));
    return { ...r, age_hours: age, level: needsReplyLevel(age) };
  });

  const untriagedRows = db
    .prepare(
      `SELECT id, thread_id, from_email, subject, created_at,
              (julianday('now') - julianday(created_at)) * 24.0 AS age_hours
         FROM crm_untriaged
        WHERE resolved_at IS NULL
        ORDER BY created_at ASC
        LIMIT 500`,
    )
    .all() as Array<Omit<NeedsReplyUntriaged, "level">>;
  const untriaged: NeedsReplyUntriaged[] = untriagedRows.map((r) => {
    const age = Math.max(0, round1(Number(r.age_hours) || 0));
    return { ...r, age_hours: age, level: needsReplyLevel(age) };
  });

  const byVertical: Record<string, number> = {};
  for (const t of threads) byVertical[t.vertical] = (byVertical[t.vertical] ?? 0) + 1;

  let forwardFailed = 0;
  let registerErrors = 0;
  try {
    // Still being retried, plus the ones given up on in the last 7 days.
    forwardFailed = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM inbound_email_log
            WHERE forward_status = 'failed'
               OR (forward_status = 'exhausted' AND julianday(received_at) >= julianday('now') - 7)`,
        )
        .get() as { n: number }
    ).n;
    registerErrors = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM inbound_email_log WHERE crm_status = 'error' AND julianday(received_at) >= julianday('now') - 7",
        )
        .get() as { n: number }
    ).n;
  } catch {
    // inbound_email_log missing (pre-migration DB) — report zero, not a 500.
  }

  // S2: open proposals per listed thread, the approval queue, and replies that did not get out.
  let approvalNeeded = 0;
  const outboundFailed: NeedsReplyOutboundFailed[] = [];
  try {
    const open = db.prepare(
      `SELECT id, status, block_reason, created_at FROM cs_reply_proposals
        WHERE thread_id = ? AND status IN ('pending', 'approval_needed', 'approved', 'sending', 'failed')
        ORDER BY created_at DESC LIMIT 1`,
    );
    for (const t of threads) t.proposal = (open.get(t.thread_id) as NeedsReplyThread["proposal"]) ?? null;
    approvalNeeded = (db.prepare("SELECT COUNT(*) AS n FROM cs_reply_proposals WHERE status = 'approval_needed'").get() as { n: number }).n;
    const failedProposals = db
      .prepare(
        `SELECT id AS proposal_id, outbox_id, thread_id, vertical, to_email, COALESCE(block_reason, last_error) AS reason, updated_at AS at
           FROM cs_reply_proposals
          WHERE status = 'failed' AND julianday(updated_at) >= julianday('now') - 7
          ORDER BY updated_at DESC LIMIT 100`,
      )
      .all() as NeedsReplyOutboundFailed[];
    outboundFailed.push(...failedProposals);
  } catch {
    // cs_reply_proposals missing (pre-migration DB)
  }
  try {
    const seen = new Set(outboundFailed.map((o) => o.outbox_id).filter(Boolean));
    const failedOutbox = db
      .prepare(
        `SELECT NULL AS proposal_id, id AS outbox_id, thread_id, vertical_id AS vertical, to_emails AS to_email, error AS reason,
                COALESCE(processed_at, created_at) AS at
           FROM crm_outbox
          WHERE intent = 'resend_send' AND status = 'failed'
            AND julianday(COALESCE(processed_at, created_at)) >= julianday('now') - 7
          ORDER BY COALESCE(processed_at, created_at) DESC LIMIT 100`,
      )
      .all() as NeedsReplyOutboundFailed[];
    for (const o of failedOutbox) if (!seen.has(o.outbox_id)) outboundFailed.push(o);
  } catch {
    // ignore
  }
  // S3: replies Resend reported as bounced / complained.
  for (const d of failedReplyDeliveries(new Date(Date.now() - 7 * 86400_000).toISOString())) {
    outboundFailed.push({
      proposal_id: null,
      outbox_id: null,
      thread_id: d.thread_id,
      vertical: d.vertical,
      to_email: d.to_emails,
      reason: `${d.status}${d.detail ? ` (${d.detail})` : ""}`,
      at: d.updated_at,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    counts: {
      threads: threads.length,
      p0: threads.filter((t) => t.level === "p0").length + untriaged.filter((u) => u.level === "p0").length,
      p1: threads.filter((t) => t.level === "p1").length + untriaged.filter((u) => u.level === "p1").length,
      by_vertical: byVertical,
      untriaged_open: untriaged.length,
      forward_failed: forwardFailed,
      crm_register_errors_7d: registerErrors,
      approval_needed: approvalNeeded,
      outbound_failed_7d: outboundFailed.length,
    },
    threads,
    untriaged,
    outbound_failed: outboundFailed,
  };
}

export const NO_REPLY_REASON_MAX = 300;

/**
 * Mark a thread «trenger ikke svar» as of now. A later inbound makes it need
 * a reply again (the mark only covers inbound up to this moment).
 */
export function markNoReplyNeeded(threadId: string, reason: string, actor: Actor): { ok: true } | { ok: false; error: string } {
  const r = (reason ?? "").trim();
  if (!r) return { ok: false, error: "reason_required" };
  if (r.length > NO_REPLY_REASON_MAX) return { ok: false, error: "reason_too_long" };
  const db = getDb();
  const t = db.prepare("SELECT id, contact_id FROM crm_threads WHERE id = ?").get(threadId) as
    | { id: string; contact_id: string }
    | undefined;
  if (!t) return { ok: false, error: "thread_not_found" };
  // ISO with milliseconds, so a mark set in the same second as an inbound
  // (SQLite datetime has whole seconds) still compares strictly after it.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO crm_thread_flags (thread_id, no_reply_reason, no_reply_at, no_reply_by, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(thread_id) DO UPDATE SET no_reply_reason = excluded.no_reply_reason,
       no_reply_at = excluded.no_reply_at, no_reply_by = excluded.no_reply_by, updated_at = datetime('now')`,
  ).run(threadId, r, now, actor);
  crmService.logAction({ threadId, contactId: t.contact_id, type: "no_reply_needed", actor, payload: { reason: r } });
  return { ok: true };
}
