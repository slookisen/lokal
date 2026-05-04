// ─── bounce-service.ts (Phase 4.14 / WO #6) ───────────────────
// Mirror of Resend bounce events. Supports idempotent inserts (UNIQUE on
// email + resend_email_id), filtered listings for /admin endpoints, and
// the marketing-comms guard query (hard + complaint bounces are excluded
// from candidate pools).

import { getDb } from "../database/init";

export interface BounceRecord {
  email: string;
  bouncedAt: string;
  resendEmailId?: string;
  bounceType?: "hard" | "soft" | "complaint" | "unknown";
  reason?: string;
  agentIdAtSend?: string;
  batchId?: string;
}

export const bounceService = {
  record(input: BounceRecord): { inserted: boolean; existing: boolean } {
    const db = getDb();
    const email = input.email.toLowerCase().trim();
    const result = db.prepare(`
      INSERT OR IGNORE INTO email_bounces
        (email, bounced_at, resend_email_id, bounce_type, reason, agent_id_at_send, batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      email,
      input.bouncedAt,
      input.resendEmailId || null,
      input.bounceType || "unknown",
      input.reason || null,
      input.agentIdAtSend || null,
      input.batchId || null,
    );
    return { inserted: result.changes > 0, existing: result.changes === 0 };
  },

  listAll(opts?: { limit?: number; offset?: number; since?: string }): any[] {
    const db = getDb();
    const limit = Math.min(500, Math.max(1, opts?.limit ?? 100));
    const offset = Math.max(0, opts?.offset ?? 0);
    if (opts?.since) {
      return db.prepare(`
        SELECT * FROM email_bounces WHERE bounced_at >= ?
        ORDER BY bounced_at DESC LIMIT ? OFFSET ?
      `).all(opts.since, limit, offset) as any[];
    }
    return db.prepare(`
      SELECT * FROM email_bounces
      ORDER BY bounced_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];
  },

  listUninvestigated(opts?: { limit?: number; since?: string }): any[] {
    const db = getDb();
    const limit = Math.min(500, Math.max(1, opts?.limit ?? 100));
    if (opts?.since) {
      return db.prepare(`
        SELECT * FROM email_bounces WHERE investigated = 0 AND bounced_at >= ?
        ORDER BY bounced_at DESC LIMIT ?
      `).all(opts.since, limit) as any[];
    }
    return db.prepare(`
      SELECT * FROM email_bounces WHERE investigated = 0
      ORDER BY bounced_at DESC LIMIT ?
    `).all(limit) as any[];
  },

  markInvestigated(input: {
    id: number;
    outcome: "alternative_found" | "business_inactive" | "blocklisted";
    notes?: string;
  }): { updated: boolean } {
    const db = getDb();
    const r = db.prepare(`
      UPDATE email_bounces
      SET investigated = 1, investigated_at = datetime('now'), investigation_outcome = ?
      WHERE id = ?
    `).run(input.outcome, input.id);
    return { updated: r.changes > 0 };
  },

  countTotal(): number {
    const db = getDb();
    return (db.prepare(`SELECT COUNT(*) as c FROM email_bounces`).get() as any).c;
  },

  // Used by marketing-comms / agent-discovery to guard against contacting bounced addrs.
  hardBouncedEmails(): Set<string> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT DISTINCT email FROM email_bounces
      WHERE bounce_type IN ('hard', 'complaint')
    `).all() as any[];
    return new Set(rows.map(r => String(r.email).toLowerCase()));
  },
};
