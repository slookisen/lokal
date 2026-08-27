// ─── Admin: POST /admin/agents/terminal-repark ────────────────────────────
//
// One-time (well — safely re-runnable) CATEGORICAL correction lever, not a
// per-row human-curated list like admin-agents-deactivate.ts. Background:
//
//   PR #718 ("terminal sweep") auto-classifies producer rows as
//   verification_status = 'terminal_unconfirmable' when the verifier can't
//   find evidence about them. A measured audit found the OLD (pre-#718)
//   version of that sweep had a bug: it also terminal-classified rows that
//   simply had NO DATA (empty city/website/email/phone), not just
//   genuinely-dead businesses — 7 of 10 sampled rows were live, active
//   producers wrongly parked as terminal. PR #718 fixed the sweep going
//   FORWARD so it never does this again, but ~183 rows already carry the
//   WRONG terminal classification from before the fix and are stuck,
//   invisible to normal enrichment.
//
//   Daniel (product owner) explicitly approved reversing this
//   ("GO for masseparkering", daniel-responses/2026-08-25-go-masseparkering-
//   terminal.md, dev-request 2026-08-25-terminal-sweep-false-positives):
//   flip those wrongly-terminal rows back to 'pending_verify' so the normal
//   enrichment/verification pipeline can reprocess them — EXCEPT rows that
//   really are confirmed dead or confirmed non-producers, which must stay
//   terminal.
//
// Unlike admin-agents-deactivate.ts (which NEVER scans — it only executes a
// caller-supplied per-row decision), this route does its OWN internal scan:
// this is one policy decision applied categorically to a cohort the server
// itself identifies, not a curated list.
//
//   * dry-run by DEFAULT. `apply` must be an explicit truthy form (mirrors
//     admin-agents-deactivate.ts's apply parsing exactly).
//   * Scan: every agent_knowledge row with verification_status =
//     'terminal_unconfirmable', joined to agents for the name. No artificial
//     row limit on the SELECT itself, but capped at TERMINAL_REPARK_MAX_SCAN
//     (1000) — well above the current ~183-row cohort — as a blast-radius
//     guardrail: if the cohort has grown unexpectedly large since this was
//     written, that is itself a signal something is wrong and needs human
//     investigation before a blind batch-apply. Dry-run STILL works above
//     the cap (stays inspectable); only apply=true is refused.
//   * Classification (classifyTerminalRow — used identically by the dry-run
//     preview AND the apply-time re-check immediately before each write, so
//     the two paths can never disagree, same discipline as decideOutcome in
//     admin-agents-deactivate.ts):
//       - verification_review_reason.terminal_reason === 'brreg_konkurs'
//         -> skipped_confirmed_dead (confirmed bankrupt via Brreg — stays
//            terminal)
//       - verification_review_reason.terminal_reason === 'brreg_inactive'
//         -> skipped_confirmed_dead (confirmed inactive via Brreg — stays
//            terminal)
//       - verification_review_reason.terminal_reason === 'non_producer_entity'
//         -> skipped_non_producer (confirmed not a producer — stays terminal)
//       - anything else (absent/malformed JSON/any other value, including
//         the legacy pre-#718 'zero_identity_sources') -> would_repark /
//         eligible for the write. This is exactly the wrongly-parked cohort:
//         no genuine death/non-producer evidence was ever recorded for them.
//     Also re-checked at write time: if verification_status is no longer
//     'terminal_unconfirmable' by the time of the fresh re-read (e.g. the
//     verifier already reprocessed the row since the outer scan), outcome
//     is skipped_no_longer_terminal — never overwrite a status change that
//     happened in between.
//   * Write (apply path only, per eligible row, own transaction):
//       UPDATE agent_knowledge SET verification_status = 'pending_verify'
//         WHERE agent_id = ?
//     plus one agent_knowledge_audit row: field_name = 'verification_status',
//     old_value = 'terminal_unconfirmable', new_value = 'pending_verify',
//     changed_by = 'system', changed_by_email = NULL, notes citing the
//     batch_tag, the Daniel-GO reference, and the row's terminal_reason (or
//     "none").
//   * Every row processed in its OWN transaction — one row's failure never
//     aborts the batch (caught, marked outcome 'error', batch continues).
//   * Full auditability: every scanned row appears in the response
//     `results` array (cohort is small — full visibility matters more here
//     than payload size).

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";

const router = Router();

// ── Injectable DB seam (tests only) ─────────────────────────────────────────
// Same seam convention as admin-agents-deactivate.ts
// (__setAgentDeactivateDbForTesting) — production code never calls the setter.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setTerminalReparkDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

// Copied (not shared) — same convention as every sibling admin-agents-*
// write route (deactivate, duplicate-merge, contact-email-write, url-write)
// each keep their own copy of getAdminKey/requireAdmin rather than importing
// a shared util; there is no shared util for this in the codebase.
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

/**
 * Blast-radius guardrail sized for a full-table categorical sweep (as
 * opposed to AGENT_DEACTIVATE_MAX_ITEMS, which caps a caller-curated list).
 * The current cohort is ~183 rows; 1000 gives ample headroom while still
 * refusing a blind batch-apply if the cohort has grown unexpectedly large.
 * Dry-run always works regardless of this cap — only apply=true is refused
 * above it.
 */
export const TERMINAL_REPARK_MAX_SCAN = 1000;

const CONFIRMED_DEAD_REASONS = new Set(["brreg_konkurs", "brreg_inactive"]);

type RowOutcome =
  | "would_repark"
  | "reparked"
  | "skipped_confirmed_dead"
  | "skipped_non_producer"
  | "skipped_no_longer_terminal"
  | "error";

interface ClassifyResult {
  outcome: RowOutcome;
  terminalReason: string | null;
}

/**
 * Parse verification_review_reason JSON and extract .terminal_reason,
 * tolerating malformed/missing JSON as {} (same defensive convention as
 * admin-agents-deactivate.ts's hasAnyCuratedField and
 * admin-verifier-review-queue.ts's review_reason parsing).
 */
export function parseTerminalReason(reviewReasonJson: string | null | undefined): string | null {
  if (!reviewReasonJson) return null;
  try {
    const parsed = JSON.parse(reviewReasonJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).terminal_reason;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Shared classification, given a FRESH verification_status +
 * verification_review_reason pair. Used identically by both the dry-run
 * preview and the apply-time re-check immediately before writing, so the
 * two paths can never disagree about what would happen (same discipline as
 * decideOutcome in admin-agents-deactivate.ts).
 */
export function classifyTerminalRow(
  verificationStatus: string | null | undefined,
  reviewReasonJson: string | null | undefined,
): ClassifyResult {
  const terminalReason = parseTerminalReason(reviewReasonJson);

  if (verificationStatus !== "terminal_unconfirmable") {
    return { outcome: "skipped_no_longer_terminal", terminalReason };
  }
  if (terminalReason === "non_producer_entity") {
    return { outcome: "skipped_non_producer", terminalReason };
  }
  if (terminalReason !== null && CONFIRMED_DEAD_REASONS.has(terminalReason)) {
    return { outcome: "skipped_confirmed_dead", terminalReason };
  }
  // Absent, malformed, or any other/legacy value (e.g. pre-#718
  // 'zero_identity_sources') -> no genuine death/non-producer evidence was
  // ever recorded. This is exactly the wrongly-parked cohort.
  return { outcome: "would_repark", terminalReason };
}

interface ScanRow {
  agent_id: string;
  name: string | null;
  verification_review_reason: string | null;
}

function scanTerminalRows(db: ReturnType<typeof getDb>): ScanRow[] {
  return db
    .prepare(
      `SELECT a.id AS agent_id, a.name AS name, k.verification_review_reason AS verification_review_reason
         FROM agents a
         INNER JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE k.verification_status = 'terminal_unconfirmable'`,
    )
    .all() as ScanRow[];
}

/**
 * Re-read verification_status + verification_review_reason fresh for one
 * agent_id, immediately before a write. Returns null if the row has
 * disappeared entirely (defensive — should not happen mid-batch, but never
 * assumed).
 */
function readFreshStatus(
  db: ReturnType<typeof getDb>,
  agentId: string,
): { verification_status: string | null; verification_review_reason: string | null } | null {
  const row = db
    .prepare(
      `SELECT verification_status AS verification_status, verification_review_reason AS verification_review_reason
         FROM agent_knowledge WHERE agent_id = ?`,
    )
    .get(agentId) as { verification_status: string | null; verification_review_reason: string | null } | undefined;
  return row ?? null;
}

/**
 * Apply one row inside its own transaction: re-reads verification_status +
 * verification_review_reason fresh for this agent_id, re-classifies via the
 * SAME classifyTerminalRow function used by the outer dry-run scan, and
 * only writes if still 'would_repark' — a row that changed status between
 * the outer scan and this write (e.g. the verifier already reprocessed it)
 * is left alone. One row's failure (caught below) never aborts the batch.
 */
function applyRepark(
  db: ReturnType<typeof getDb>,
  agentId: string,
  batchTag: string,
): ClassifyResult {
  try {
    const tx = db.transaction((): ClassifyResult => {
      const fresh = readFreshStatus(db, agentId);
      const decision = classifyTerminalRow(
        fresh?.verification_status ?? null,
        fresh?.verification_review_reason ?? null,
      );
      if (decision.outcome !== "would_repark") {
        return decision;
      }

      db.prepare(
        `UPDATE agent_knowledge SET verification_status = 'pending_verify' WHERE agent_id = ?`,
      ).run(agentId);

      const reasonLabel = decision.terminalReason ?? "none";
      const notes =
        `${batchTag}: masse-reparkering per Daniel-GO 2026-08-25 (dev-request ` +
        `2026-08-25-terminal-sweep-false-positives, daniel-responses/2026-08-25-` +
        `go-masseparkering-terminal.md) | terminal_reason=${reasonLabel}`;

      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'verification_status', 'terminal_unconfirmable', 'pending_verify', 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, notes);

      return { outcome: "reparked", terminalReason: decision.terminalReason };
    });
    return tx();
  } catch (e: any) {
    // The response's results shape (agent_id/name/terminal_reason/outcome)
    // has no field for a message, so the caught error is logged here for
    // operator visibility rather than dropped silently — the row itself is
    // still marked 'error' and the batch continues.
    console.error(`[terminal-repark] failed to repark agent ${agentId}:`, e?.message ?? e);
    return { outcome: "error", terminalReason: null };
  }
}

interface ResultItem {
  agent_id: string;
  name: string | null;
  terminal_reason: string | null;
  outcome: RowOutcome;
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  const db = resolveDb();
  const scanned = scanTerminalRows(db);

  if (apply && scanned.length > TERMINAL_REPARK_MAX_SCAN) {
    res.status(400).json({
      error:
        `Terminal-unconfirmable cohort has grown to ${scanned.length} rows, ` +
        `above the TERMINAL_REPARK_MAX_SCAN guardrail (${TERMINAL_REPARK_MAX_SCAN}). ` +
        `This is larger than expected for the known pre-#718 backlog and needs ` +
        `human investigation before a blind batch-apply. Dry-run remains available.`,
    });
    return;
  }

  const batchTag = `repark-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const results: ResultItem[] = [];

  for (const row of scanned) {
    if (dryRun) {
      const decision = classifyTerminalRow("terminal_unconfirmable", row.verification_review_reason);
      results.push({
        agent_id: row.agent_id,
        name: row.name,
        terminal_reason: decision.terminalReason,
        outcome: decision.outcome,
      });
      continue;
    }

    // Outer scan already filtered to would-be-eligible rows only in the
    // classification sense, but we re-classify from the OUTER snapshot here
    // too (cheap, and keeps the loop body uniform) before deciding whether
    // this row is even worth attempting the write transaction for.
    const outerDecision = classifyTerminalRow("terminal_unconfirmable", row.verification_review_reason);
    if (outerDecision.outcome !== "would_repark") {
      results.push({
        agent_id: row.agent_id,
        name: row.name,
        terminal_reason: outerDecision.terminalReason,
        outcome: outerDecision.outcome,
      });
      continue;
    }

    const applied = applyRepark(db, row.agent_id, batchTag);
    results.push({
      agent_id: row.agent_id,
      name: row.name,
      terminal_reason: applied.terminalReason ?? outerDecision.terminalReason,
      outcome: applied.outcome,
    });
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    dry_run: dryRun,
    batch_tag: batchTag,
    scanned: scanned.length,
    counts,
    results,
  });
});

export default router;
