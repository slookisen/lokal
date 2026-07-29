// ─── Admin: POST /admin/contact-write-guard-retro-sweep ─────────────────────
//
// dev-request 2026-07-28-rfb-kontaktekstraksjon-orgnr-som-telefon (slookisen/
// A2A), criterion 6. PR #409 added the WRITE-time contact guard
// (classifyPhoneForWrite / stripTrailingContactLabel, contact-normalizer.ts)
// so no NEW write can ever persist an org-nr/date-shaped phone or an address
// with a leaked "Telefon"/"Adresse"/... label. PR #411 added a READ-ONLY
// measurement of how many EXISTING rows already violate those same rules
// (admin-contact-write-guard-audit.ts). This route is the CORRECTION half:
// it can actually fix the rows the audit measured.
//
// ── dry-run by default, apply is a real write path ──────────────────────────
// dry_run (the default — no `apply` truthy form present) never writes
// anything. Its `violations_found`/`skipped_claimed`/`skipped_curated` counts
// match what an `apply` call would find, but NOT `written` — a dry-run's
// `written` is always 0 by construction (nothing was written yet), so a
// dry-run's `written: 0` means "not attempted", not "nothing to fix"; read
// `violations_found` for that. apply=true (see the exact truthy-form list
// below) performs the actual
// writes. Per the dev-request's own instruction ("Apply krever Daniels
// godkjenning av tallet") apply is never invoked automatically by any
// upstream automation in this repo — a human decides to flip it after
// reading a dry-run's numbers. This route itself does not enforce that (it
// has no way to know who is calling it) — the discipline lives in WHO calls
// it with apply=true, not in this handler.
//
// ── What gets written, per rule (dev-request's own spec) ────────────────────
//   Rules 1-3 (phone shape / org_nr_collision / date_shape): a violating
//     row's `phone` is BLANKED to NULL. "En avvist verdi skal la feltet stå
//     BLANKT ... Fail closed" — a rejected value is never partially kept or
//     guessed-at, only ever cleared.
//   Rule 4 (address_trailing_label): a violating row's `address` is
//     REWRITTEN to stripTrailingContactLabel(address) — a well-defined, safe
//     transformation, not a rejection, so the field is repaired, not blanked.
//
// Reuses classifyPhoneForWrite / stripTrailingContactLabel directly
// (services/contact-normalizer.ts) — this file does not reimplement any rule.
//
// ── Lock-respect (hard requirement, named explicitly in the dev-request:
// "samme lås-respekt som retro-scan i #380: claimed_at og curated_fields skal
// aldri overskrives") ─────────────────────────────────────────────────────
//   - `agents.claimed_at IS NOT NULL` -> ROW-level lock. An owner-claimed
//     agent is never written to by this sweep at all (neither phone nor
//     address), mirroring applyAgentOrgNr's / applyRfbRetroScanNull's own
//     `claimed_at` refusal (admin-agents.ts) — the owner controls their own
//     data from the moment they claim it.
//   - `agent_knowledge.curated_fields` -> PER-FIELD lock (JSON object keyed
//     by field name, e.g. {"phone": {...}}) — see the schema comment in
//     database/init.ts near "Phase 4.9a — agent_knowledge.curated_fields".
//     Checked independently for "phone" and "address": a phone lock does NOT
//     block an address fix on the same row, and vice versa (locks are
//     per-field, not per-row).
//   - Both checks are re-read from a FRESH row snapshot immediately before
//     each actual write, inside that write's own db.transaction() — mirrors
//     applyRfbRetroScanNull's / brreg-description-fallback's re-check-
//     before-write convention (admin-agents.ts) exactly. A row locked or
//     curated between the initial scan and the write is left alone.
//   - Every write is scoped to ONE row/field and wrapped in its own
//     transaction — a failure on one row never aborts the sweep or leaves
//     another row half-written (mirrors the brreg sweep's per-row atomic-
//     write pattern).
//
// Scope: full `agent_knowledge` table joined to `agents`, no cohort filter,
// all verticals — same scope as the audit route (admin-contact-write-guard-
// audit.ts) it corrects, so the numbers are directly comparable.
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route in this codebase).

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { classifyPhoneForWrite, stripTrailingContactLabel, PhoneWriteRule } from "../services/contact-normalizer";

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

interface KnowledgeRow {
  agent_id: string;
  org_nr: string | null;
  phone: string | null;
  address: string | null;
  claimed_at: string | null;
  curated_fields: string | null;
}

type WriteOutcome = "written" | "skipped_claimed" | "skipped_curated" | "error";

// A violation's fate for THIS call, before any write is attempted:
//   "pending"         — not locked, dry-run: nothing written yet, would be
//                        written under apply. Counted only in violations_found.
//   "skipped_claimed" — row-level lock (agents.claimed_at IS NOT NULL).
//   "skipped_curated" — per-field lock (agent_knowledge.curated_fields).
// Under apply mode, "pending" always resolves to an actual write attempt,
// whose real WriteOutcome ("written"/"skipped_claimed"/"skipped_curated"/
// "error" from the re-check-immediately-before-write) is what gets recorded.
type PreWriteState = "pending" | "skipped_claimed" | "skipped_curated";

function classifyPreWriteState(claimedAt: string | null, curatedFieldsJson: string | null, field: "phone" | "address"): PreWriteState {
  if (claimedAt) return "skipped_claimed";
  if (isContactFieldCurated(curatedFieldsJson, field)) return "skipped_curated";
  return "pending";
}

interface RuleBucket {
  violations_found: number;
  written: number;
  skipped_claimed: number;
  skipped_curated: number;
  agent_ids: {
    violations: string[];
    written: string[];
    skipped_claimed: string[];
    skipped_curated: string[];
  };
}

function makeBucket(): RuleBucket {
  return {
    violations_found: 0,
    written: 0,
    skipped_claimed: 0,
    skipped_curated: 0,
    agent_ids: { violations: [], written: [], skipped_claimed: [], skipped_curated: [] },
  };
}

/**
 * True iff the parsed curated_fields JSON locks `field`. Tolerates
 * malformed/missing JSON (treated as "not locked") — same defensive-parse
 * convention as isDescriptionCurated / isRfbFieldCurated (admin-agents.ts).
 */
function isContactFieldCurated(curatedFieldsJson: string | null | undefined, field: "phone" | "address"): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    return !!(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>)[field]);
  } catch {
    return false;
  }
}

/**
 * Blank ONE agent's `phone` to NULL — the fix for rules 1-3 (shape /
 * org_nr_collision / date_shape). Re-reads claimed_at + curated_fields from a
 * FRESH row snapshot immediately before writing, inside its own transaction
 * (mirrors applyRfbRetroScanNull's re-check-before-write convention,
 * admin-agents.ts). Writes an agent_knowledge_audit row on success (same
 * insert shape every other write path in this codebase uses).
 */
function applyPhoneBlank(
  db: ReturnType<typeof getDb>,
  agentId: string,
  rule: PhoneWriteRule,
): { ok: boolean; reason?: string } {
  try {
    const tx = db.transaction((): { ok: boolean; reason?: string } => {
      const cur = db
        .prepare(
          `SELECT a.claimed_at AS claimed_at, k.curated_fields AS curated_fields, k.phone AS phone
             FROM agents a JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`,
        )
        .get(agentId) as { claimed_at: string | null; curated_fields: string | null; phone: string | null } | undefined;
      if (!cur) return { ok: false, reason: "agent_not_found" };
      if (cur.claimed_at) return { ok: false, reason: "claimed_at_locked" };
      if (isContactFieldCurated(cur.curated_fields, "phone")) return { ok: false, reason: "curated_locked" };
      if (!cur.phone || cur.phone.trim() === "") return { ok: true }; // already blank — nothing to do, idempotent

      db.prepare(`UPDATE agent_knowledge SET phone = NULL WHERE agent_id = ?`).run(agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'phone', ?, NULL, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.phone, `contact-write-guard-retro-sweep: rejected by rule "${rule}"`);
      return { ok: true };
    });
    return tx();
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

/**
 * Rewrite ONE agent's `address` to its stripTrailingContactLabel()'d form —
 * the fix for rule 4 (address_trailing_label). Same re-check-immediately-
 * before-write discipline as applyPhoneBlank above.
 */
function applyAddressStrip(
  db: ReturnType<typeof getDb>,
  agentId: string,
): { ok: boolean; reason?: string } {
  try {
    const tx = db.transaction((): { ok: boolean; reason?: string } => {
      const cur = db
        .prepare(
          `SELECT a.claimed_at AS claimed_at, k.curated_fields AS curated_fields, k.address AS address
             FROM agents a JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`,
        )
        .get(agentId) as { claimed_at: string | null; curated_fields: string | null; address: string | null } | undefined;
      if (!cur) return { ok: false, reason: "agent_not_found" };
      if (cur.claimed_at) return { ok: false, reason: "claimed_at_locked" };
      if (isContactFieldCurated(cur.curated_fields, "address")) return { ok: false, reason: "curated_locked" };
      if (!cur.address || cur.address.trim() === "") return { ok: true }; // already blank — nothing to do

      // Re-derive the stripped form from the FRESH value rather than trusting
      // the scan-time-computed one, in case the address changed between scan
      // and write. If the fresh value no longer violates the rule (someone
      // else already fixed/changed it), there is nothing left to do here.
      const freshStripped = stripTrailingContactLabel(cur.address);
      if (freshStripped === cur.address) return { ok: true };

      db.prepare(`UPDATE agent_knowledge SET address = ? WHERE agent_id = ?`).run(freshStripped, agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'address', ?, ?, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.address, freshStripped, "contact-write-guard-retro-sweep: stripped trailing contact label");
      return { ok: true };
    });
    return tx();
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

function outcomeFromWriteResult(result: { ok: boolean; reason?: string }): WriteOutcome {
  if (result.ok) return "written";
  if (result.reason === "claimed_at_locked") return "skipped_claimed";
  if (result.reason === "curated_locked") return "skipped_curated";
  return "error";
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { apply?: unknown };
  // apply: dry-run by default. Truthy only via the EXACT forms below — same
  // convention as every sibling dry-run/apply route in this codebase (see
  // POST /admin/agents/brreg-description-fallback, admin-agents.ts).
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  try {
    const db = getDb();

    const total_rows_scanned = (
      db.prepare(`SELECT COUNT(*) AS c FROM agent_knowledge`).get() as { c: number }
    ).c;

    // Full-table scan, no cohort filter — same scope as the audit route this
    // sweep corrects. claimed_at/curated_fields are pulled here too (unlike
    // the audit route) so violations on locked rows/fields can still be
    // REPORTED (never silently dropped) even though they are never WRITTEN.
    const rows = db
      .prepare(
        `SELECT k.agent_id AS agent_id,
                a.org_nr AS org_nr,
                a.claimed_at AS claimed_at,
                k.phone AS phone,
                k.address AS address,
                k.curated_fields AS curated_fields
           FROM agent_knowledge k
           JOIN agents a ON a.id = k.agent_id
       ORDER BY k.agent_id`,
      )
      .all() as KnowledgeRow[];

    const phoneBuckets: Record<PhoneWriteRule, RuleBucket> = {
      shape: makeBucket(),
      org_nr_collision: makeBucket(),
      date_shape: makeBucket(),
    };
    const addressBucket = makeBucket();
    const errors: Array<{ agent_id: string; field: "phone" | "address"; error: string }> = [];

    for (const row of rows) {
      // ── Phone rules (1-3): blank on violation ─────────────────────────
      if (row.phone && row.phone.trim() !== "") {
        const { failedRules } = classifyPhoneForWrite(row.phone, row.org_nr);
        if (failedRules.length > 0) {
          const preState = classifyPreWriteState(row.claimed_at, row.curated_fields, "phone");

          // "pending" + apply mode -> attempt the actual write (with its own
          // fresh re-check right before the UPDATE); every other combination
          // is a foregone conclusion (locked) or a no-op (dry-run preview).
          let writeOutcome: WriteOutcome | null = null;
          if (preState === "pending" && !dryRun) {
            const result = applyPhoneBlank(db, row.agent_id, failedRules[0]);
            writeOutcome = outcomeFromWriteResult(result);
            if (writeOutcome === "error") {
              errors.push({ agent_id: row.agent_id, field: "phone", error: result.reason ?? "unknown" });
            }
          }

          for (const rule of failedRules) {
            const bucket = phoneBuckets[rule];
            bucket.violations_found += 1;
            bucket.agent_ids.violations.push(row.agent_id);
            if (preState === "skipped_claimed") {
              bucket.skipped_claimed += 1;
              bucket.agent_ids.skipped_claimed.push(row.agent_id);
            } else if (preState === "skipped_curated") {
              bucket.skipped_curated += 1;
              bucket.agent_ids.skipped_curated.push(row.agent_id);
            } else if (writeOutcome === "written") {
              bucket.written += 1;
              bucket.agent_ids.written.push(row.agent_id);
            } else if (writeOutcome === "skipped_claimed") {
              bucket.skipped_claimed += 1;
              bucket.agent_ids.skipped_claimed.push(row.agent_id);
            } else if (writeOutcome === "skipped_curated") {
              bucket.skipped_curated += 1;
              bucket.agent_ids.skipped_curated.push(row.agent_id);
            }
            // preState === "pending" && dryRun (no writeOutcome computed), or
            // writeOutcome === "error": counted only in violations_found —
            // never in written/skipped_claimed/skipped_curated.
          }
        }
      }

      // ── Address rule (4): rewrite (strip) on violation ─────────────────
      if (row.address && row.address.trim() !== "") {
        const stripped = stripTrailingContactLabel(row.address);
        if (stripped !== row.address) {
          const preState = classifyPreWriteState(row.claimed_at, row.curated_fields, "address");

          let writeOutcome: WriteOutcome | null = null;
          if (preState === "pending" && !dryRun) {
            const result = applyAddressStrip(db, row.agent_id);
            writeOutcome = outcomeFromWriteResult(result);
            if (writeOutcome === "error") {
              errors.push({ agent_id: row.agent_id, field: "address", error: result.reason ?? "unknown" });
            }
          }

          addressBucket.violations_found += 1;
          addressBucket.agent_ids.violations.push(row.agent_id);
          if (preState === "skipped_claimed") {
            addressBucket.skipped_claimed += 1;
            addressBucket.agent_ids.skipped_claimed.push(row.agent_id);
          } else if (preState === "skipped_curated") {
            addressBucket.skipped_curated += 1;
            addressBucket.agent_ids.skipped_curated.push(row.agent_id);
          } else if (writeOutcome === "written") {
            addressBucket.written += 1;
            addressBucket.agent_ids.written.push(row.agent_id);
          } else if (writeOutcome === "skipped_claimed") {
            addressBucket.skipped_claimed += 1;
            addressBucket.agent_ids.skipped_claimed.push(row.agent_id);
          } else if (writeOutcome === "skipped_curated") {
            addressBucket.skipped_curated += 1;
            addressBucket.agent_ids.skipped_curated.push(row.agent_id);
          }
        }
      }
    }

    function toResponse(bucket: RuleBucket) {
      return {
        violations_found: bucket.violations_found,
        written: bucket.written,
        skipped_claimed: bucket.skipped_claimed,
        skipped_curated: bucket.skipped_curated,
        agent_ids: bucket.agent_ids,
      };
    }

    res.json({
      success: true,
      dry_run: dryRun,
      total_rows_scanned,
      phone_shape_violations: toResponse(phoneBuckets.shape),
      phone_org_nr_collision: toResponse(phoneBuckets.org_nr_collision),
      phone_date_shape: toResponse(phoneBuckets.date_shape),
      address_trailing_label: toResponse(addressBucket),
      errors,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: String(err?.message || err),
    });
  }
});

export default router;
