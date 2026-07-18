// ─── Admin: POST /admin/verifier/domain-coherence-sweep ──────────────────────
//
// dev-request 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction (item 3).
//
// Background (enrichment-2026-07-05.md in slookisen/A2A, lines ~103-140 /
// ~211-221): of a 101-agent review_required cohort, 46 were blocked by
// domain_coherence failures (agents.url and agent_knowledge.website/email
// point at different, incompatible hosts). A manual orchestrator pass fixed
// 19 by correcting knowledge.website to match agents.url, and separately
// found 5 agents whose agents.url values had been circularly scrambled
// (agent A's URL was actually agent B's, etc.) — those 5 were hand-PATCHed.
// The remaining ~27 (now regrown to a chunk of the current ~83-84
// review_required cohort) were never systematized, so the daily verifier
// sweep (PR-27's pickReviewQueueBatch, "PR-97" in dev-request comments)
// re-processes the same cohort every day for 0 state changes.
//
// This endpoint reuses the EXISTING domain-coherence CHECK
// (domainCoherenceCheck in cross-source-validator.ts) — it does not
// reimplement host/equivalence logic — and classifies each review_required,
// non-umbrella agent into one of:
//
//   - coherent (not this sweep's problem — something else put it in
//     review_required; never touched)
//   - auto_fixable: reason is a knowledge.website-host mismatch. agents.url
//     is this codebase's trusted identity anchor for domain-coherence
//     (everything else is checked against it), so the fix is to correct
//     knowledge.website to the agents.url host. Dry-run reports the
//     proposal; apply:true writes it (re-verifying the mismatch still
//     holds immediately before the UPDATE, since the row may have changed
//     between an earlier dry-run read and this call).
//   - manual_review_needed: reason is a knowledge.email-host mismatch.
//     Email is a weaker signal (per domainCoherenceCheck's own comments) —
//     a mismatch here doesn't tell you which URL, if either, is wrong.
//     Report-only, never written.
//   - circular_scramble_candidates: a host-OVERLAP cross-reference within
//     the incoherent set of this cohort — flags an agent whenever its
//     agents.url host equals a DIFFERENT agent's knowledge.website host
//     (checked in both directions, not requiring a strict reciprocal pair —
//     a longer N-agent scrambled chain only overlaps one-directionally at
//     each link). Mirrors the 5-agent scramble found manually on 07-05.
//     Report-only (a human/future slice should confirm before swapping two
//     live agents' URLs); agents.url is NEVER written by this endpoint.
//
// Apply mode (apply:true in body) writes ONLY the auto_fixable bucket.
// Every other agent this sweep looked at (coherent, manual_review_needed,
// circular_scramble_candidate) gets a parking marker
// (domain_reconciliation_checked_at/_outcome/_reason_snapshot) so the daily
// verifier sweep's pickReviewQueueBatch stops re-processing it for 30 days
// unless verification_review_reason changes in the meantime. Rollback:
// DOMAIN_RECONCILIATION_PARKING_DISABLED=true removes the exclusion
// (env read at request time, no restart needed) — mirrors PR #248's
// HOMEPAGE_PARKING_DISABLED idiom in marketplace.ts.
//
// Never touched: agents outside review_required, umbrella agents, anything
// requiring a live HTTP fetch (no crawling in this slice — everything here
// is derivable from data already in the DB). No email sends, no deletes.
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route in this codebase).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { domainCoherenceCheck, type ProvenanceRecord } from "../services/cross-source-validator";

// Parse field_provenance (may be a JSON string from SQLite, already an
// object, or null/missing) into the shape domainCoherenceCheck's opts
// expect — mirrors the equivalent parsing in lokal-agent-verifier.ts so both
// call sites treat the column identically.
function parseFieldProvenance(
  raw: string | null | undefined
): Record<string, ProvenanceRecord[] | ProvenanceRecord | unknown> {
  if (!raw) return {};
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Builds the domainCoherenceCheck 4th-arg opts object from a row/fresh-read
// that carries phone/address/field_provenance alongside website/email.
function coherenceOpts(row: {
  phone: string | null;
  address: string | null;
  field_provenance: string | null;
}) {
  return {
    fieldProvenance: parseFieldProvenance(row.field_provenance),
    knowledgePhone: row.phone,
    knowledgeAddress: row.address,
  };
}

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

interface CohortRow {
  agent_id: string;
  name: string;
  agent_url: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  field_provenance: string | null;
  verification_review_reason: string;
}

interface AutoFixable {
  agent_id: string;
  name: string;
  current_website: string | null;
  proposed_website: string;
  reason: string;
}

interface ManualReview {
  agent_id: string;
  name: string;
  reason: string;
  agent_url: string | null;
  current_website: string | null;
  current_email: string | null;
}

interface ScrambleCandidate {
  agent_id: string;
  name: string;
  agent_url: string | null;
  current_website: string | null;
  paired_agent_id: string;
  paired_agent_name: string;
}

// Reads the DOMAIN_RECONCILIATION_PARKING_DISABLED rollback flag at call
// time (not module load) so it takes effect without a restart — same idiom
// as HOMEPAGE_PARKING_DISABLED in marketplace.ts.
function parkingExclusionClause(): string {
  if (process.env.DOMAIN_RECONCILIATION_PARKING_DISABLED === "true") return "";
  return `AND (
      k.domain_reconciliation_checked_at IS NULL
      OR k.domain_reconciliation_checked_at <= datetime('now','-30 days')
      OR k.verification_review_reason != COALESCE(k.domain_reconciliation_reason_snapshot, '')
    )`;
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const apply = req.body && (req.body.apply === true || req.body.apply === "true");

  try {
    const db = getDb();

    const rows = db
      .prepare(
        `SELECT a.id AS agent_id, a.name, a.url AS agent_url,
                k.website, k.email, k.phone, k.address, k.field_provenance,
                k.verification_review_reason
           FROM agents a
     INNER JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE k.verification_status = 'review_required'
            AND a.umbrella_type IS NULL
            ${parkingExclusionClause()}`
      )
      .all() as CohortRow[];

    const cohort_size = rows.length;
    let coherent_skipped = 0;

    // Preliminary classification. Circular-scramble detection runs AFTER
    // this pass over the incoherent set, and can pull an agent OUT of
    // auto_fixable/manual_review_needed into circular_scramble_candidates.
    const incoherent: Array<{
      row: CohortRow;
      bucket: "auto_fixable" | "manual_review_needed";
      reason: string;
      agentHost?: string;
      websiteHost?: string;
    }> = [];

    for (const row of rows) {
      const result = domainCoherenceCheck(row.agent_url, row.website, row.email, coherenceOpts(row));
      if (result.coherent) {
        coherent_skipped++;
        if (apply) {
          stampParking(db, row.agent_id, "no_action_needed", row.verification_review_reason);
        }
        continue;
      }
      const reason = result.reason || "";
      if (reason.startsWith("knowledge.website host")) {
        incoherent.push({ row, bucket: "auto_fixable", reason, agentHost: result.agentHost, websiteHost: result.knowledgeWebsiteHost });
      } else {
        // knowledge.email host mismatch (the only other reason shape
        // domainCoherenceCheck returns) — weaker signal, never auto-fixed.
        incoherent.push({ row, bucket: "manual_review_needed", reason, agentHost: result.agentHost, websiteHost: result.knowledgeWebsiteHost });
      }
    }

    // Cross-reference within the incoherent set for host OVERLAP, not just
    // strict reciprocal pairs. A strict-reciprocal check (A's agents.url ==
    // B's website AND B's agents.url == A's website) only catches clean
    // 2-agent swaps — it misses longer scrambled chains (3+ agents whose
    // agents.url/website values got shuffled around a cycle), which is
    // exactly the shape of the 2026-07-05 incident's "5 agents circularly
    // scrambled" finding: re-probing prod after this endpoint shipped found
    // Solheim Kjøtt (agents.url=bi1.no, website=solheimkjott.no — its website
    // is ALREADY correct) whose agents.url collides with Bi 1 Bigård's
    // website (bi1.no) — a ONE-DIRECTIONAL overlap the strict-reciprocal
    // check missed, because Bi 1 Bigård's own agents.url (arvolanes.com)
    // does not equal Solheim's website. Auto-"fixing" Solheim under the old
    // logic would have overwritten its already-correct website with the
    // wrong (still-scrambled) host from agents.url — actively re-corrupting
    // good data. Any host that appears as one agent's agents.url AND
    // another (different) agent's knowledge.website anywhere in this
    // cohort is contested — neither side is auto-fixed.
    const scrambledIds = new Set<string>();
    const circular_scramble_candidates: ScrambleCandidate[] = [];
    const pairedWith = new Map<string, { id: string; name: string }>();
    for (let i = 0; i < incoherent.length; i++) {
      for (let j = 0; j < incoherent.length; j++) {
        if (i === j) continue;
        const a = incoherent[i]!;
        const b = incoherent[j]!;
        // a's stored website host is contested if it equals a DIFFERENT
        // agent's real (agents.url) host — i.e. a's website may actually
        // belong to b.
        if (a.websiteHost && b.agentHost && a.websiteHost === b.agentHost) {
          scrambledIds.add(a.row.agent_id);
          scrambledIds.add(b.row.agent_id);
          if (!pairedWith.has(a.row.agent_id)) pairedWith.set(a.row.agent_id, { id: b.row.agent_id, name: b.row.name });
          if (!pairedWith.has(b.row.agent_id)) pairedWith.set(b.row.agent_id, { id: a.row.agent_id, name: a.row.name });
        }
      }
    }
    for (const entry of incoherent) {
      if (!scrambledIds.has(entry.row.agent_id)) continue;
      const paired = pairedWith.get(entry.row.agent_id)!;
      circular_scramble_candidates.push({
        agent_id: entry.row.agent_id,
        name: entry.row.name,
        agent_url: entry.row.agent_url,
        current_website: entry.row.website,
        paired_agent_id: paired.id,
        paired_agent_name: paired.name,
      });
    }

    const auto_fixable: AutoFixable[] = [];
    const manual_review_needed: ManualReview[] = [];

    for (const entry of incoherent) {
      if (scrambledIds.has(entry.row.agent_id)) {
        if (apply) {
          stampParking(db, entry.row.agent_id, "circular_scramble_candidate", entry.row.verification_review_reason);
        }
        continue;
      }
      if (entry.bucket === "auto_fixable" && entry.agentHost) {
        auto_fixable.push({
          agent_id: entry.row.agent_id,
          name: entry.row.name,
          current_website: entry.row.website,
          proposed_website: `https://${entry.agentHost}`,
          reason: entry.reason,
        });
      } else {
        manual_review_needed.push({
          agent_id: entry.row.agent_id,
          name: entry.row.name,
          reason: entry.reason,
          agent_url: entry.row.agent_url,
          current_website: entry.row.website,
          current_email: entry.row.email,
        });
        if (apply) {
          stampParking(db, entry.row.agent_id, "manual_review_needed", entry.row.verification_review_reason);
        }
      }
    }

    const would_write = auto_fixable.length;
    let written = 0;

    if (apply) {
      const updateStmt = db.prepare(
        `UPDATE agent_knowledge SET website = ? WHERE agent_id = ?`
      );
      const freshStmt = db.prepare(
        `SELECT a.url AS agent_url, k.website, k.email, k.phone, k.address, k.field_provenance
           FROM agents a INNER JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.id = ?`
      );
      for (const fix of auto_fixable) {
        // Re-verify immediately before writing: the row may have changed
        // between the classification read above and this write (or between
        // an earlier dry-run call and this apply call).
        const fresh = freshStmt.get(fix.agent_id) as
          | {
              agent_url: string | null;
              website: string | null;
              email: string | null;
              phone: string | null;
              address: string | null;
              field_provenance: string | null;
            }
          | undefined;
        if (!fresh) continue;
        const recheck = domainCoherenceCheck(fresh.agent_url, fresh.website, fresh.email, coherenceOpts(fresh));
        if (recheck.coherent || !(recheck.reason || "").startsWith("knowledge.website host") || !recheck.agentHost) {
          // No longer the mismatch we classified — skip the write.
          continue;
        }
        // Write the host from THIS fresh re-check, not fix.proposed_website
        // (computed from the earlier classification read) — if agents.url
        // changed between the cohort SELECT and this write, the stale
        // proposed value would reintroduce a mismatch while reporting success.
        updateStmt.run(`https://${recheck.agentHost}`, fix.agent_id);
        written++;
      }
    }

    res.json({
      success: true,
      apply: !!apply,
      cohort_size,
      coherent_skipped,
      auto_fixable,
      manual_review_needed,
      circular_scramble_candidates,
      would_write,
      ...(apply ? { written } : {}),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: String(err?.message || err),
    });
  }
});

// Stamps the parking marker on an agent this sweep looked at but did not
// auto-fix, so pickReviewQueueBatch (the daily verifier's review-queue
// drain) stops re-selecting it for 30 days unless verification_review_reason
// changes in the meantime (the snapshot comparison lives in the picker).
function stampParking(db: any, agentId: string, outcome: string, reviewReasonSnapshot: string): void {
  // Stamp via SQLite's own datetime('now') rather than JS Date#toISOString():
  // the backoff comparison in pickReviewQueueBatch/parkingExclusionClause
  // also uses datetime('now','-30 days'), which emits space-separated
  // "YYYY-MM-DD HH:MM:SS" (no 'T', no ms, no 'Z'). Mixing formats made the
  // 30-day window effectively ~31 days (lexicographic comparison: 'T' > ' '
  // keeps same-day timestamps ordered "after" the cutoff until the calendar
  // date itself rolls over) — using the same format on both sides of the
  // comparison keeps the window exact.
  db.prepare(
    `UPDATE agent_knowledge
        SET domain_reconciliation_checked_at = datetime('now'),
            domain_reconciliation_outcome = ?,
            domain_reconciliation_reason_snapshot = ?
      WHERE agent_id = ?`
  ).run(outcome, reviewReasonSnapshot, agentId);
}

export default router;
