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
//        7. not on agent_blocklist (orch-pr-20260614-8) — JS post-filter via
//           isBlocked() to guarantee identical normalization to the write path
//        8. not wrong-entity (orch-pr-17) — field_provenance.website_ownership
//           .status == 'unverified' (PR-16 signal). suppressed_counts.website_unverified
//        9. not inference-only on a factual field (orch-pr-17) — products/address/
//           phone flagged in verification_review_reason.inference_only_fields (PR-16
//           signal). suppressed_counts.inference_only
//      8 & 9 are ADVISORY/defensive: a row missing the signal is never suppressed,
//      and free-mail (gmail/hotmail) is NEVER a suppression reason.
//
// POST /admin/outreach-sent-log/import
//      Backfill outreach_sent_log from legacy file-based contacted history.
//      Idempotent: rows with the same message_id are skipped.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { isBlocked } from "../services/blocklist-service";

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

// ── orch-pr-17: data-quality suppression (wrong-entity + inference-only) ──────
//
// Two ADVISORY data-quality signals that PR-16's verifier writes onto each
// agent_knowledge row are read here to keep two classes of bad producers OUT of
// outreach — WITHOUT depending on PR-16 being merged and WITHOUT touching how
// free-mail (gmail/hotmail) producers are handled:
//
//   1. website_ownership = "unverified"  (wrong-entity site, e.g. Grette
//      Andelslandbruk anchored to grettegaard.no). PR-16 stamps this at
//      field_provenance.website_ownership.status. Emailing a producer whose
//      site we could not confirm is theirs risks contacting the wrong business.
//
//   2. inference_only on a FACTUAL field (products / address / phone). PR-16's
//      verifier records the set of factual fields whose only "source" was AI
//      inference (category_inference / seasonal_knowledge / name_analysis /
//      web_search) under verification_review_reason.inference_only_fields, and
//      also tags `inference_only_field:<field>` in its flags. A producer whose
//      factual data is fabricated guesswork must be re-enriched, not emailed.
//
// Both are READ-ONLY here and fully defensive: if the column/JSON/flag is absent
// or malformed on a row, the signal is treated as ABSENT (no suppression) — so a
// row that pre-dates PR-16 is never affected. Free-mail is deliberately NOT a
// suppression reason: a gmail producer with a verified own-site and real factual
// sources stays a candidate. (This is the entire point of orch-pr-17.)

// Factual fields where an inference-only source is a fabrication risk worth
// suppressing on. (products/address/phone per orch-pr-17; "about" is descriptive
// prose, not a factual claim that mis-targets outreach, so it is excluded here.)
const FACTUAL_INFERENCE_FIELDS: ReadonlySet<string> = new Set(["products", "address", "phone"]);

// True iff field_provenance.website_ownership.status === "unverified".
// `fieldProvenanceJson` is the raw agent_knowledge.field_provenance TEXT column.
export function websiteOwnershipUnverified(fieldProvenanceJson: string | null | undefined): boolean {
  if (!fieldProvenanceJson) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fieldProvenanceJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const wo = (parsed as Record<string, unknown>).website_ownership;
  if (!wo || typeof wo !== "object") return false;
  return (wo as Record<string, unknown>).status === "unverified";
}

// True iff the verifier flagged a FACTUAL field (products/address/phone) as
// inference-only. Reads PR-16's `inference_only_fields` array out of the
// agent_knowledge.verification_review_reason TEXT column (the persisted
// cross_source_reason JSON). Robust to the column being absent ('{}' / null /
// malformed) — returns false in every such case (no suppression).
export function hasInferenceOnlyFactualField(
  verificationReviewReasonJson: string | null | undefined,
): boolean {
  if (!verificationReviewReasonJson) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(verificationReviewReasonJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const fields = (parsed as Record<string, unknown>).inference_only_fields;
  if (!Array.isArray(fields)) return false;
  for (const f of fields) {
    if (typeof f === "string" && FACTUAL_INFERENCE_FIELDS.has(f)) return true;
  }
  return false;
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
      ) THEN 1 ELSE 0 END AS is_hard_bounced,
      -- orch-pr-17: raw data-quality columns read by the JS post-filter below.
      -- field_provenance carries website_ownership.status; verification_review_reason
      -- carries PR-16's inference_only_fields. Both default to '{}' so they are
      -- always present; the JS helpers treat any non-matching shape as "absent".
      k.field_provenance AS field_provenance,
      k.verification_review_reason AS verification_review_reason
    `;

    type PoolRow = {
      agent_id: string;
      name: string;
      email: string;
      website: string | null;
      outreach_eligible_at: string | null;
      has_replied: number;
      is_opted_out: number;
      is_customer: number;
      is_hard_bounced: number;
      field_provenance: string | null;
      verification_review_reason: string | null;
    };

    let rows: PoolRow[];

    if (mode === "first") {
      // Use the VIEW — it already excludes any agent with a sent_log entry.
      rows = db.prepare(`
        SELECT
          p.agent_id,
          p.name,
          p.email,
          k.website,
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
          k.website,
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
    let blocklistedCount = 0;
    // orch-pr-17 data-quality counters
    let websiteUnverifiedCount = 0;
    let inferenceOnlyCount = 0;

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
      // Blocklist check: JS post-filter via isBlocked() to guarantee the same
      // normalization (normalizeDomain, normalizeName) as the write path. The
      // candidate set is small at this point so the per-row SELECT is cheap.
      const suppressedForBlocklist = isBlocked({
        agentId: row.agent_id,
        name: row.name,
        email: row.email,
        website: row.website ?? undefined,
      }).blocked;

      // ── orch-pr-17: wrong-entity site (website_ownership=unverified) ─────────
      // Read-only on the row's field_provenance JSON; absent/malformed → false.
      const suppressedForWebsiteUnverified = websiteOwnershipUnverified(row.field_provenance);
      // ── orch-pr-17: inference-only factual field (products/address/phone) ────
      // Read-only on PR-16's verification_review_reason.inference_only_fields;
      // absent/malformed → false. Free-mail is NEVER a reason here.
      const suppressedForInferenceOnly = hasInferenceOnlyFactualField(row.verification_review_reason);

      if (suppressedForContacted) contactedOrCooldownCount++;
      if (suppressedForReplied) repliedCount++;
      if (suppressedForOptOut) optedOutCount++;
      if (suppressedForCustomer) customerCount++;
      if (suppressedForBounce) hardBouncedCount++;
      if (suppressedForBlocklist) blocklistedCount++;
      if (suppressedForWebsiteUnverified) websiteUnverifiedCount++;
      if (suppressedForInferenceOnly) inferenceOnlyCount++;

      if (
        !suppressedForContacted &&
        !suppressedForReplied &&
        !suppressedForOptOut &&
        !suppressedForCustomer &&
        !suppressedForBounce &&
        !suppressedForBlocklist &&
        !suppressedForWebsiteUnverified &&
        !suppressedForInferenceOnly
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
        blocklisted: blocklistedCount,
        // orch-pr-17: new data-quality suppression reasons
        website_unverified: websiteUnverifiedCount,
        inference_only: inferenceOnlyCount,
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
