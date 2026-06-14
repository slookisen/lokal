// ─── Admin: outreach suppression gate + sent-log import (orch-pr-20260614-3) ─
//
// GET  /admin/outreach-candidates
//      Returns producers safe to email, enforcing ALL of:
//        1. verified + correct info: pulls from outreach_ready_pool VIEW for
//           mode=first (no sent_log rows). For mode=second, uses the same
//           underlying conditions but WITHOUT the VIEW's sent_log exclusion —
//           because the VIEW itself excludes all previously-contacted agents,
//           making mode=second impossible if we only query the VIEW.
//        2. cooldown / contacted (outreach_sent_log)
//        3. not replied (crm_contacts → crm_threads → crm_messages direction='in')
//        4. not opted-out (crm_contacts.status != 'active' OR
//                          agent_knowledge.verification_status = 'opt_out')
//        5. not a customer (agents.claimed_at IS NOT NULL)
//        6. hard-bounced (email_bounces table, Phase 4.14 / WO #6)
//
// POST /admin/outreach-sent-log/import
//      Backfill outreach_sent_log from legacy file-based contacted history.
//      Idempotent: rows with the same message_id are skipped.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

const router = Router();

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

// ── GET /admin/outreach-candidates ───────────────────────────────────────────
//
// Query params:
//   mode           'first' | 'second'   (required)
//   cooldown_days  integer, default 60
//   limit          integer, 1–500, default 100
//
// mode=first  → agent has NO row in outreach_sent_log
//              (uses outreach_ready_pool VIEW directly — VIEW enforces this)
// mode=second → agent HAS a row whose EARLIEST sent_at is older than cooldown_days
//              (uses the pool base conditions WITHOUT the VIEW's sent_log exclusion)
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();

    const mode = String(req.query.mode ?? "").toLowerCase();
    if (mode !== "first" && mode !== "second") {
      res.status(400).json({ success: false, error: "mode must be 'first' or 'second'" });
      return;
    }

    const cooldownDays = Math.max(1, parseInt(String(req.query.cooldown_days ?? "60"), 10) || 60);
    const limitRaw = parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);

    // ── Step 1: pull base pool rows ────────────────────────────────────────────
    //
    // For mode=first: use outreach_ready_pool VIEW (already excludes sent_log agents)
    // For mode=second: use the base SQL without the sent_log exclusion so we can
    //   find agents who were contacted and are now past their cooldown period.
    //
    // Both queries collect suppression metadata via CASE expressions:
    //   - has_replied: inbound crm_message linked via contact → thread → message
    //   - is_opted_out: crm blocked/archived OR verification_status=opt_out
    //   - is_customer: agents.claimed_at IS NOT NULL
    //   - is_hard_bounced: email_bounces.bounce_type IN ('hard','complaint')

    const suppressionCols = `
      CASE WHEN EXISTS (
        SELECT 1
        FROM crm_contacts cc
        JOIN crm_threads ct ON ct.contact_id = cc.id
        JOIN crm_messages cm ON cm.thread_id = ct.id
        WHERE cc.agent_id = a.id
          AND cm.direction = 'in'
      ) THEN 1 ELSE 0 END AS has_replied,
      CASE WHEN (
        EXISTS (
          SELECT 1 FROM crm_contacts cc2
          WHERE cc2.agent_id = a.id
            AND cc2.status != 'active'
        )
        OR EXISTS (
          SELECT 1 FROM agent_knowledge ak2
          WHERE ak2.agent_id = a.id
            AND ak2.verification_status = 'opt_out'
        )
      ) THEN 1 ELSE 0 END AS is_opted_out,
      CASE WHEN a.claimed_at IS NOT NULL THEN 1 ELSE 0 END AS is_customer,
      -- TODO bounce-suppression: also cross-check by agent_id for non-direct-match bounces
      CASE WHEN EXISTS (
        SELECT 1 FROM email_bounces eb
        WHERE LOWER(eb.email) = LOWER(k.email)
          AND eb.bounce_type IN ('hard', 'complaint')
      ) THEN 1 ELSE 0 END AS is_hard_bounced
    `;

    type PoolRow = {
      agent_id: string;
      name: string;
      email: string;
      outreach_eligible_at: string | null;
      has_replied: number;
      is_opted_out: number;
      is_customer: number;
      is_hard_bounced: number;
    };

    let rows: PoolRow[];

    if (mode === "first") {
      // Use the VIEW — it already excludes any agent with a sent_log entry.
      rows = db.prepare(`
        SELECT
          p.agent_id,
          p.name,
          p.email,
          p.outreach_eligible_at,
          ${suppressionCols}
        FROM outreach_ready_pool p
        INNER JOIN agents a ON a.id = p.agent_id
        INNER JOIN agent_knowledge k ON k.agent_id = p.agent_id
        ORDER BY p.outreach_eligible_at ASC NULLS LAST
      `).all() as PoolRow[];
    } else {
      // mode=second: use the underlying pool conditions WITHOUT sent_log exclusion.
      // We need agents who HAVE been contacted AND are past their cooldown.
      rows = db.prepare(`
        SELECT
          a.id AS agent_id,
          a.name,
          k.email,
          k.outreach_eligible_at,
          ${suppressionCols}
        FROM agents a
        INNER JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE
          k.email IS NOT NULL AND k.email != ''
          AND a.umbrella_type IS NULL
          AND k.verification_status = 'verified'
          AND k.enrichment_status IN ('partial', 'rich')
          AND k.url_last_status IS NOT NULL
          AND k.url_last_status >= 200
          AND k.url_last_status < 400
          AND k.url_last_probed IS NOT NULL
          AND k.url_last_probed > datetime('now', '-30 days')
        ORDER BY k.outreach_eligible_at ASC NULLS LAST
      `).all() as PoolRow[];
    }

    // ── Step 2: load outreach_sent_log data for mode-based filtering ──────────
    const sentLogMap = new Map<string, string>(); // agent_id → "sent" or "within_cooldown:<date>" or "<last_sent_at>"

    if (mode === "first") {
      // The VIEW already excluded these, but we still track them for suppression counts.
      // Actually for mode=first the VIEW guarantees no sent_log agents appear, so
      // the contactedOrCooldown count will always be 0 — which is correct.
    } else {
      // mode=second: use per-agent MAX(sent_at) (the MOST RECENT contact) to check
      // cooldown. Using MAX (not MIN) is the safety-correct semantic: an agent whose
      // latest send is within the window must stay suppressed even if an earlier send
      // (e.g. a legacy backfill row) is old. (reviewer orch-pr-20260614-3 fix)
      const cutoff = new Date(Date.now() - cooldownDays * 86400 * 1000).toISOString();
      const sentAgents = db.prepare(`
        SELECT agent_id, MAX(sent_at) AS last_sent_at
        FROM outreach_sent_log
        GROUP BY agent_id
      `).all() as Array<{ agent_id: string; last_sent_at: string }>;

      for (const r of sentAgents) {
        if (r.last_sent_at < cutoff) {
          // Most-recent send is outside cooldown → eligible for second outreach
          sentLogMap.set(r.agent_id, r.last_sent_at);
        } else {
          // Within cooldown (most-recent contact too recent)
          sentLogMap.set(r.agent_id, "within_cooldown:" + r.last_sent_at);
        }
      }
    }

    // ── Step 3: separate candidates from suppressed ───────────────────────────
    const candidates: Array<{ agent_id: string; name: string; email: string }> = [];
    let contactedOrCooldownCount = 0;
    let repliedCount = 0;
    let optedOutCount = 0;
    let customerCount = 0;
    let hardBouncedCount = 0;

    for (const row of rows) {
      let isContactedOrCooldown = false;

      if (mode === "first") {
        // The VIEW guarantees no sent_log agents; this will always be false.
        // (Kept for clarity — if VIEW is ever replaced, this guard still works.)
        isContactedOrCooldown = false;
      } else {
        // mode=second: eligible only if in sentLogMap AND outside cooldown
        const entry = sentLogMap.get(row.agent_id);
        if (!entry) {
          // Never contacted — not eligible for second outreach
          isContactedOrCooldown = true;
        } else if (entry.startsWith("within_cooldown:")) {
          // Contacted but still in cooldown
          isContactedOrCooldown = true;
        }
        // else: entry is a last_sent_at outside cooldown → eligible
      }

      const suppressedForContacted = isContactedOrCooldown;
      const suppressedForReplied = row.has_replied === 1;
      const suppressedForOptOut = row.is_opted_out === 1;
      const suppressedForCustomer = row.is_customer === 1;
      const suppressedForBounce = row.is_hard_bounced === 1;

      if (suppressedForContacted) contactedOrCooldownCount++;
      if (suppressedForReplied) repliedCount++;
      if (suppressedForOptOut) optedOutCount++;
      if (suppressedForCustomer) customerCount++;
      if (suppressedForBounce) hardBouncedCount++;

      if (
        !suppressedForContacted &&
        !suppressedForReplied &&
        !suppressedForOptOut &&
        !suppressedForCustomer &&
        !suppressedForBounce
      ) {
        candidates.push({
          agent_id: row.agent_id,
          name: row.name,
          email: row.email,
        });
      }
    }

    // Cap by limit AFTER suppression
    const cappedCandidates = candidates.slice(0, limit);

    res.json({
      success: true,
      mode,
      cooldown_days: cooldownDays,
      count: cappedCandidates.length,
      candidates: cappedCandidates,
      suppressed_counts: {
        contacted_or_cooldown: contactedOrCooldownCount,
        replied: repliedCount,
        opted_out: optedOutCount,
        customer: customerCount,
        hard_bounced: hardBouncedCount,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// ── POST /admin/outreach-sent-log/import ─────────────────────────────────────
//
// Accepts:
//   { entries: [{ email, name, sentAt, batch, messageId }] }
//
// Resolves each email → agent via agent_knowledge.email.
// Upserts a row into outreach_sent_log (idempotent: skip if same message_id exists).
// Returns: { success, inserted, skipped, unmatched_emails: [...] }
router.post("/import", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();

    const body = req.body as { entries?: unknown };
    if (!body || !Array.isArray(body.entries)) {
      res.status(400).json({ success: false, error: "Body must be { entries: [...] }" });
      return;
    }

    interface ImportEntry {
      email?: string;
      name?: string;
      sentAt?: string;
      batch?: string;
      messageId?: string;
    }

    const entries = body.entries as ImportEntry[];

    let inserted = 0;
    let skipped = 0;
    const unmatchedEmails: string[] = [];

    for (const entry of entries) {
      const email = (entry.email ?? "").toString().toLowerCase().trim();
      if (!email) {
        unmatchedEmails.push("[empty email]");
        continue;
      }

      // Idempotency: skip if this message_id already exists in outreach_sent_log
      const messageId = entry.messageId ? String(entry.messageId) : null;
      if (messageId) {
        const existing = db.prepare(
          `SELECT 1 FROM outreach_sent_log WHERE message_id = ? LIMIT 1`
        ).get(messageId);
        if (existing) {
          skipped++;
          continue;
        }
      }

      // Resolve email → agent_id via agent_knowledge.email
      const agentRow = db.prepare(
        `SELECT ak.agent_id FROM agent_knowledge ak
         WHERE LOWER(ak.email) = ?
         LIMIT 1`
      ).get(email) as { agent_id: string } | undefined;

      if (!agentRow) {
        unmatchedEmails.push(email);
        continue;
      }

      const sentAt = entry.sentAt ? String(entry.sentAt) : new Date().toISOString();
      const notes = entry.batch ? `backfill:${entry.batch}` : "backfill";

      // Idempotency for entries WITHOUT a message_id: dedupe on (agent_id, sent_at,
      // channel) so re-importing the same legacy file does not create duplicate rows
      // (duplicates would corrupt the MAX(sent_at) cooldown calc). (reviewer fix)
      if (!messageId) {
        const dup = db.prepare(
          `SELECT 1 FROM outreach_sent_log
             WHERE agent_id = ? AND sent_at = ? AND channel = 'email' AND message_id IS NULL
             LIMIT 1`
        ).get(agentRow.agent_id, sentAt);
        if (dup) { skipped++; continue; }
      }

      db.prepare(`
        INSERT INTO outreach_sent_log (agent_id, sent_at, channel, message_id, notes)
        VALUES (?, ?, 'email', ?, ?)
      `).run(agentRow.agent_id, sentAt, messageId, notes);

      inserted++;
    }

    res.json({
      success: true,
      inserted,
      skipped,
      unmatched_emails: unmatchedEmails,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
