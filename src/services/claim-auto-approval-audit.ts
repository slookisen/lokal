// claim-auto-approval-audit.ts — eierkrav slice E1 (2026-11-09).
//
// Read-only audit of automatic owner-claim approvals (B2b-1): for each
// agent_claims row with verification_method = 'auto_assessment' approved in
// the window, is the stored assessment there, is the claim's CRM thread
// there, is the «claim_approved» mail recorded in it, and was that mail
// delivered (email_delivery_events, written by resend-webhook) within an
// hour of the approval?
//
// Behind GET /api/marketplace/admin/claims/auto-approval-audit (admin key).
// No writes. No personal data in the result: no e-mail address, name, phone,
// subject or body — only ids, statuses and timestamps.

import type Database from "better-sqlite3";
import { parseStoredClaimAssessment } from "./knowledge-service";
import { claimCrmThreadId } from "./claim-crm-tracking";

export const AUDIT_SINCE_HOURS_DEFAULT = 48;
export const AUDIT_SINCE_HOURS_MAX = 720;
export const AUDIT_CLAIMS_MAX = 200;
export const AUDIT_DELIVERY_WINDOW_MS = 60 * 60 * 1000;

export type ClaimAuditVerdict =
  | "ok"
  | "pending"
  | "missing_assessment"
  | "missing_crm_thread"
  | "missing_approved_message"
  | "not_delivered_1h";

export const CLAIM_AUDIT_VERDICTS: readonly ClaimAuditVerdict[] = [
  "ok", "pending", "missing_assessment", "missing_crm_thread", "missing_approved_message", "not_delivered_1h",
];

/**
 * since_hours from the query string: undefined → the default (48); else an
 * integer 1–720 written as plain digits. Anything else (0, 721, "abc",
 * "1.5", "", an array) → null (the route answers 400).
 */
export function parseAuditSinceHours(raw: unknown): number | null {
  if (raw === undefined) return AUDIT_SINCE_HOURS_DEFAULT;
  if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= AUDIT_SINCE_HOURS_MAX ? n : null;
}

/** A stored timestamp as ms: SQLite "YYYY-MM-DD HH:MM:SS" is UTC; else ISO. NaN when unreadable. */
export function parseAuditTime(v: unknown): number {
  if (typeof v !== "string" || v === "") return NaN;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? Date.parse(v.replace(" ", "T") + "Z") : Date.parse(v);
}

export interface ClaimAuditFacts {
  verifiedAt: string | null;
  assessmentPresent: boolean;
  threadExists: boolean;
  approvedMessageId: string | null;
  deliveredAt: string | null;
}

/** delivered_at at most 60 minutes after verified_at (false when either is missing or unreadable). */
export function deliveredWithinHour(verifiedAt: string | null, deliveredAt: string | null): boolean {
  const v = parseAuditTime(verifiedAt);
  const d = parseAuditTime(deliveredAt);
  if (!Number.isFinite(v) || !Number.isFinite(d)) return false;
  return d - v <= AUDIT_DELIVERY_WINDOW_MS;
}

/**
 * The claim's verdict — the first missing item in this order: assessment,
 * CRM thread, approved message, delivery within 1 h. No delivery yet and the
 * approval less than 60 minutes before `now` → "pending". Pure.
 */
export function computeClaimAuditVerdict(f: ClaimAuditFacts, now: Date): ClaimAuditVerdict {
  if (!f.assessmentPresent) return "missing_assessment";
  if (!f.threadExists) return "missing_crm_thread";
  if (!f.approvedMessageId) return "missing_approved_message";
  if (f.deliveredAt && deliveredWithinHour(f.verifiedAt, f.deliveredAt)) return "ok";
  if (!f.deliveredAt) {
    const v = parseAuditTime(f.verifiedAt);
    if (Number.isFinite(v) && now.getTime() - v < AUDIT_DELIVERY_WINDOW_MS) return "pending";
  }
  return "not_delivered_1h";
}

export interface ClaimAuditEntry {
  claim_id: string;
  agent_id: string;
  status: string | null;
  verified_at: string | null;
  revoked_at: string | null;
  assessment: { present: boolean; result: string | null };
  crm: {
    thread_id: string;
    thread_exists: boolean;
    approved_message_id: string | null;
    approved_delivery_status: string | null;
  };
  delivery: { delivered_at: string | null; within_1h: boolean };
  verdict: ClaimAuditVerdict;
}

export interface ClaimAutoApprovalAudit {
  since_hours: number;
  flags: { auto_approve_enabled: boolean; crm_tracking_enabled: boolean };
  summary: Record<ClaimAuditVerdict, number> & { total: number };
  claims: ClaimAuditEntry[];
  truncated: boolean;
}

/**
 * Builds the audit from the DB (read only, parameterized queries). The
 * summary counts every matching claim; `claims` holds the newest
 * AUDIT_CLAIMS_MAX of them (`truncated` when there were more).
 */
export function buildClaimAutoApprovalAudit(
  db: Database.Database,
  opts: { sinceHours: number; now: Date; flags: { auto_approve_enabled: boolean; crm_tracking_enabled: boolean } },
): ClaimAutoApprovalAudit {
  const fromIso = new Date(opts.now.getTime() - opts.sinceHours * 3600 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT id, agent_id, status, verified_at, revoked_at, claim_assessment
      FROM agent_claims
     WHERE verification_method = 'auto_assessment'
       AND verified_at IS NOT NULL
       AND datetime(verified_at) >= datetime(?)
     ORDER BY datetime(verified_at) DESC, id DESC
  `).all(fromIso) as Array<{
    id: string; agent_id: string; status: string | null; verified_at: string | null;
    revoked_at: string | null; claim_assessment: string | null;
  }>;

  const threadQ = db.prepare("SELECT 1 FROM crm_threads WHERE id = ?");
  const outboundQ = db.prepare(`
    SELECT id, delivery_status, raw_metadata
      FROM crm_messages
     WHERE thread_id = ? AND direction = 'out'
     ORDER BY datetime(COALESCE(sent_at, received_at)) DESC, rowid DESC
  `);
  const deliveryQ = db.prepare(`
    SELECT delivered_at FROM email_delivery_events
     WHERE crm_message_id = ?
     ORDER BY delivered_at ASC, id ASC LIMIT 1
  `);

  const summary = Object.fromEntries(CLAIM_AUDIT_VERDICTS.map((v) => [v, 0])) as Record<ClaimAuditVerdict, number> & { total: number };
  summary.total = 0;
  const claims: ClaimAuditEntry[] = [];

  for (const row of rows) {
    const assessment = parseStoredClaimAssessment(row.claim_assessment);
    const threadId = claimCrmThreadId(row.id);
    const threadExists = !!threadQ.get(threadId);
    let approved: { id: string; delivery_status: string | null } | null = null;
    if (threadExists) {
      for (const m of outboundQ.all(threadId) as Array<{ id: string; delivery_status: string | null; raw_metadata: string | null }>) {
        let kind: unknown;
        try { kind = JSON.parse(m.raw_metadata || "{}")?.kind; } catch { kind = undefined; }
        if (kind === "claim_approved") { approved = { id: m.id, delivery_status: m.delivery_status }; break; }
      }
    }
    const delivered = approved ? (deliveryQ.get(approved.id) as { delivered_at: string } | undefined) : undefined;
    const deliveredAt = delivered?.delivered_at ?? null;
    const verdict = computeClaimAuditVerdict({
      verifiedAt: row.verified_at,
      assessmentPresent: !!assessment,
      threadExists,
      approvedMessageId: approved?.id ?? null,
      deliveredAt,
    }, opts.now);
    summary[verdict]++;
    summary.total++;
    if (claims.length < AUDIT_CLAIMS_MAX) {
      const result = assessment && typeof (assessment as { result?: unknown }).result === "string"
        ? (assessment as { result: string }).result
        : null;
      claims.push({
        claim_id: row.id,
        agent_id: row.agent_id,
        status: row.status,
        verified_at: row.verified_at,
        revoked_at: row.revoked_at,
        assessment: { present: !!assessment, result },
        crm: {
          thread_id: threadId,
          thread_exists: threadExists,
          approved_message_id: approved?.id ?? null,
          approved_delivery_status: approved?.delivery_status ?? null,
        },
        delivery: { delivered_at: deliveredAt, within_1h: deliveredWithinHour(row.verified_at, deliveredAt) },
        verdict,
      });
    }
  }

  return {
    since_hours: opts.sinceHours,
    flags: opts.flags,
    summary,
    claims,
    truncated: rows.length > AUDIT_CLAIMS_MAX,
  };
}
