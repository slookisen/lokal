// ─── Admin: POST /admin/agents/description-code-artifact-sweep ─────────────
//
// dev-request 2026-08-24-produsentbeskrivelser-skrapt-js-opprydding, Endring
// 4. One-time cleanup lever for EXISTING `agents.description` rows that
// already contain scraped JS/CMS-bootstrap code (the class this dev-request's
// root-cause analysis traced to PATCH /api/marketplace/agents/:id having no
// validation before this dev-request — see description-quality.ts's
// looksLikeCodeArtifact doc comment and marketplace.ts's PATCH handler for
// the write-time half of this fix). This route cleans up rows already
// written before that gate existed.
//
// Modeled PRECISELY on admin-agents-url-write.ts's write discipline (same
// dry-run/apply, owner-lock + curated_fields-lock re-read FRESH inside each
// row's own transaction, one agent_knowledge_audit row per change carrying
// the OLD value, per-row transaction so one failure never aborts the batch)
// — copied, not reinvented, per the byggspec's own pointer at that sibling's
// applyUrl function specifically (admin-agents-url-write.ts:233-273). One
// deliberate difference from that sibling, because this route's shape is
// different (a full-catalog SCAN, not a client-supplied {agent_id, value}
// list): the candidate set is *scanned* here (every `agents` row run through
// looksLikeCodeArtifact(description)), not supplied by the caller. AC1 of
// the dev-request requires quantifying the FULL catalog regardless of the
// per-call write cap, so the scan always covers every row;
// `candidates_considered` in the response is that full pre-cap count, and
// only the first DESCRIPTION_SWEEP_MAX_ITEMS (200) of them are actually
// processed/written in one call.
//
// ── Wired to the enrichment-write-pause gate (round-2 review finding 3) ────
// The first pass left this route OUT of the enrichment-write-pause gate
// (services/enrichment-write-pause.ts) that url-write's router-level handler
// also carries, reasoning that the byggspec's "copy precisely, don't
// reinvent" pointer named only that sibling's lock/transaction/audit
// function (lines 233-273 below), not its router-level pause check. An
// independent reviewer flagged this as a real gap, not a settled call: this
// route writes producer CONTENT (`agents.description`) — the exact thing the
// pause exists to stop mid-incident — and the "it deterministically blanks
// to '' with a full audit trail" distinction does not actually matter to the
// pause's own purpose (stop ANY producer-content write while a vertical is
// paused, no exceptions argued case-by-case at each call site — that
// case-by-case erosion is precisely how the 2026-08-20 incident happened).
// So this route is now wired in, the SAME way and at the SAME point as the
// url-write sibling (admin-agents-url-write.ts:276-301): fails CLOSED, blocks
// the WHOLE request (never a per-item outcome), and runs unconditionally
// regardless of apply/dry-run. See the router.post handler below for the one
// unavoidable structural difference: url-write's target ids come straight
// off the caller's body, so its gate runs before touching the DB at all;
// this route's target ids only exist after the full-catalog scan (there is
// no caller-supplied list to gate on), so the gate runs immediately after
// that read-only scan instead — still strictly before the FIRST write.
//
// ── Value rule ───────────────────────────────────────────────────────────
// `agents.description` is TEXT NOT NULL (database/init.ts) — the cleaned
// value is the EMPTY STRING, same constraint-handling pattern as the
// url-write sibling's `url: null -> ''`. This slice deliberately does NOT
// generate a replacement description (dev-request Non-goals: "ingen generell
// omskriving av alle beskrivelser") — the field is left empty for the next
// ordinary enrichment run (search-enrich.ts, which produces clean
// descriptions BY CONSTRUCTION per this dev-request's root-cause section) to
// refill.
//
// ── `agent_knowledge.about` (dev-request 2026-08-25-agent-knowledge-about-
//    code-artifact-gap) ──────────────────────────────────────────────────
// Second, parallel scan+clean pass added by that dev-request: `about` is
// `description`'s sibling field (same "producer description" role) but was
// never covered by this sweep — #706's own scan only ever touched
// `agents.description`, and the real live Helios Trondheim defect turned
// out to live in `agent_knowledge.about`, not `description`. Same
// dry-run/apply/per-row-transaction/audit discipline as the description
// pass above, kept as a clearly-separated SECOND scan within this same
// handler (not merged into the description candidate set) so the existing
// `scanned`/`candidates_considered`/`batch_size`/`counts`/`results`
// response keys stay byte-for-byte unchanged for `description` — the new
// `about_*`-prefixed keys carry the about pass's own counts/results.
// ONE constraint difference from `description`: `agent_knowledge.about` is
// NULLABLE (unlike `agents.description`'s TEXT NOT NULL), so the cleaned
// value here is SQL NULL, not `''`.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { looksLikeCodeArtifact } from "../services/description-quality";
import {
  enrichmentWritePauseBlockForAgents,
  ENRICHMENT_WRITE_PAUSE_HTTP_STATUS,
} from "../services/enrichment-write-pause";

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

/** Hard cap per call — mirrors the url-write sibling's per-call cap. */
export const DESCRIPTION_SWEEP_MAX_ITEMS = 200;

/**
 * DB seam — same rationale as admin-agents-url-write.ts's own: a test points
 * ITS OWN calls at an in-memory database without pinning the shared getDb()
 * singleton (pinning it races any concurrently-running block that reads it
 * across an await). Production never calls the setter.
 */
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
export function __setDescriptionSweepDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function db_(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

/** Truncated preview only — never the full old value, since this is
 * admin-endpoint-output that can land in logs. The full value stays safely
 * in the agent_knowledge_audit row (AC4). */
export function previewValue(s: string | null | undefined, maxLen = 80): string {
  const v = s ?? "";
  if (v.length <= maxLen) return v;
  return v.slice(0, maxLen) + "…";
}

type ItemOutcome =
  | "would_write"
  | "written"
  | "skipped_claimed"
  | "skipped_curated"
  | "skipped_unchanged"
  | "not_found"
  | "error";

interface ResultItem {
  agent_id: string;
  name: string;
  outcome: ItemOutcome;
  old_value_preview?: string;
  detail?: string;
}

interface CandidateRow {
  id: string;
  name: string;
  description: string;
}

interface LockSnapshot {
  claimed_at: string | null;
  description: string;
  curated_fields: string | null;
  verified_claims: number;
}

const LOCK_SNAPSHOT_SQL = `
  SELECT a.claimed_at   AS claimed_at,
         a.description  AS description,
         k.curated_fields AS curated_fields,
         (SELECT COUNT(*) FROM agent_claims c
           WHERE c.agent_id = a.id AND c.status = 'verified') AS verified_claims
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
   WHERE a.id = ?`;

// ─── `agent_knowledge.about` pass (dev-request 2026-08-25-agent-knowledge-
//     about-code-artifact-gap) — same shape as the description types/SQL
//     above, mirrored onto the sibling column. ────────────────────────────
interface AboutCandidateRow {
  id: string;
  name: string;
  about: string | null;
}

interface AboutLockSnapshot {
  claimed_at: string | null;
  about: string | null;
  curated_fields: string | null;
  verified_claims: number;
}

const ABOUT_LOCK_SNAPSHOT_SQL = `
  SELECT a.claimed_at   AS claimed_at,
         k.about        AS about,
         k.curated_fields AS curated_fields,
         (SELECT COUNT(*) FROM agent_claims c
           WHERE c.agent_id = a.id AND c.status = 'verified') AS verified_claims
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
   WHERE a.id = ?`;

/** Owner lock: `claimed_at` OR a verified row in agent_claims — same
 * two-source check as the url-write sibling's isOwnerLocked (that route's
 * own header documents the production gap a claimed_at-only check missed).
 * Structural param type — shared by BOTH the description and about
 * LockSnapshot shapes above, which both carry these two fields. */
function isOwnerLocked(s: { claimed_at: string | null; verified_claims: number }): boolean {
  return !!s.claimed_at || (s.verified_claims ?? 0) > 0;
}

/** True iff curated_fields locks the given field name (`description` or
 * `about`). Malformed/missing JSON is treated as unlocked, same defensive
 * parse as the url-write sibling. */
export function isFieldCurated(
  curatedFieldsJson: string | null | undefined,
  fieldName: "description" | "about",
): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    return !!(parsed as Record<string, unknown>)[fieldName];
  } catch {
    return false;
  }
}

/** Thin `description`-specific wrapper over isFieldCurated — kept as its own
 * named export since existing call sites/tests already reference this name. */
export function isDescriptionCurated(curatedFieldsJson: string | null | undefined): boolean {
  return isFieldCurated(curatedFieldsJson, "description");
}

/**
 * Clean ONE agent's description. Re-reads both locks and the current value
 * from a FRESH snapshot immediately before writing, inside its own
 * transaction, and writes an agent_knowledge_audit row carrying the OLD
 * value — same discipline as admin-agents-url-write.ts's applyUrl.
 */
function applyDescriptionSweep(
  agentId: string,
  reason: string,
  batchTag: string,
): { outcome: ItemOutcome; oldValue?: string; detail?: string } {
  const db = db_();
  try {
    const tx = db.transaction((): { outcome: ItemOutcome; oldValue?: string; detail?: string } => {
      const cur = db.prepare(LOCK_SNAPSHOT_SQL).get(agentId) as LockSnapshot | undefined;
      if (!cur) return { outcome: "not_found" };
      if (isOwnerLocked(cur)) return { outcome: "skipped_claimed", oldValue: cur.description };
      if (isDescriptionCurated(cur.curated_fields)) return { outcome: "skipped_curated", oldValue: cur.description };
      // Re-check the detector against the FRESH value too — a concurrent
      // writer could have already cleaned/replaced it between scan and
      // write; never blindly clobber a description that is no longer junk.
      if (!looksLikeCodeArtifact(cur.description)) {
        return { outcome: "skipped_unchanged", oldValue: cur.description };
      }

      db.prepare(`UPDATE agents SET description = '' WHERE id = ?`).run(agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'description', ?, '', 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.description, `${batchTag}: ${reason}`);

      return { outcome: "written", oldValue: cur.description };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

/**
 * Clean ONE agent's `about` (agent_knowledge.about) — same discipline as
 * applyDescriptionSweep above (fresh re-read of both locks + the current
 * value, inside its own transaction, one agent_knowledge_audit row per
 * change), with the ONE value-rule difference this dev-request calls out:
 * `about` is nullable, so the cleaned value is SQL NULL, not `''`.
 */
function applyAboutSweep(
  agentId: string,
  reason: string,
  batchTag: string,
): { outcome: ItemOutcome; oldValue?: string | null; detail?: string } {
  const db = db_();
  try {
    const tx = db.transaction((): { outcome: ItemOutcome; oldValue?: string | null; detail?: string } => {
      const cur = db.prepare(ABOUT_LOCK_SNAPSHOT_SQL).get(agentId) as AboutLockSnapshot | undefined;
      if (!cur) return { outcome: "not_found" };
      if (isOwnerLocked(cur)) return { outcome: "skipped_claimed", oldValue: cur.about };
      if (isFieldCurated(cur.curated_fields, "about")) return { outcome: "skipped_curated", oldValue: cur.about };
      // Re-check the detector against the FRESH value too — same rationale
      // as applyDescriptionSweep's own re-check comment above.
      if (!looksLikeCodeArtifact(cur.about)) {
        return { outcome: "skipped_unchanged", oldValue: cur.about };
      }

      db.prepare(`UPDATE agent_knowledge SET about = NULL WHERE agent_id = ?`).run(agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'about', ?, NULL, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.about, `${batchTag}: ${reason}`);

      return { outcome: "written", oldValue: cur.about };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const db = db_();

  // Full-catalog scan (AC1 requires quantifying the WHOLE catalog, not just
  // the batch this call will write) — read-only, no lock/claim considerations
  // apply to a scan, only to the write below. Done BEFORE the pause gate for
  // a purely structural reason (see this route's own header comment): unlike
  // url-write, whose target ids come straight off the caller's body, this
  // route has no caller-supplied id list — the gate needs to know which ids
  // it would touch, and that set only exists after this read.
  const allRows = db
    .prepare(`SELECT id, name, description FROM agents ORDER BY id ASC`)
    .all() as CandidateRow[];
  const scanned = allRows.length;
  const candidates = allRows.filter((r) => looksLikeCodeArtifact(r.description));
  const candidatesConsidered = candidates.length;
  const batch = candidates.slice(0, DESCRIPTION_SWEEP_MAX_ITEMS);

  // ── Second scan: `agent_knowledge.about` (dev-request 2026-08-25-agent-
  // knowledge-about-code-artifact-gap) — same full-catalog-scan discipline,
  // mirrored onto the sibling column, kept as its own separate candidate set
  // (see this file's header comment for why the response keys stay split
  // rather than merged into the description counts above). LEFT JOIN means
  // an agent with no agent_knowledge row at all naturally scans as
  // `about: null`, which looksLikeCodeArtifact() already treats as
  // non-junk — no special-casing needed here.
  const allAboutRows = db
    .prepare(
      `SELECT a.id AS id, a.name AS name, k.about AS about
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        ORDER BY a.id ASC`,
    )
    .all() as AboutCandidateRow[];
  const aboutScanned = allAboutRows.length;
  const aboutCandidates = allAboutRows.filter((r) => looksLikeCodeArtifact(r.about));
  const aboutCandidatesConsidered = aboutCandidates.length;
  const aboutBatch = aboutCandidates.slice(0, DESCRIPTION_SWEEP_MAX_ITEMS);

  // ── Enrichment write-pause gate (dev-request 2026-08-20-enrichment-write-
  // pause-mekanisk-gjerde; wired in here per round-2 review finding 3) ──────
  // Same discipline as the url-write sibling's own gate
  // (admin-agents-url-write.ts:276-301): fails CLOSED, blocks the WHOLE
  // request (never a per-item outcome) so a paused catalog performs ZERO
  // writes, and runs unconditionally — BEFORE the apply/dry-run branch below
  // — same as the sibling gates regardless of dry-run. Scoped to the UNION of
  // both candidate batches (description AND about — both are producer-
  // content writes this pause exists to stop mid-incident); candidates
  // beyond either per-call cap can never be written by THIS call, so they
  // can't need to gate it. An empty batch still resolves to the default
  // vertical ('rfb'), same as an empty `items` array does on the url-write
  // sibling.
  {
    const pauseBlock = enrichmentWritePauseBlockForAgents(
      db_,
      [...batch.map((c) => c.id), ...aboutBatch.map((c) => c.id)],
    );
    if (pauseBlock) {
      res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
      return;
    }
  }

  const body = (req.body ?? {}) as { apply?: unknown; reason?: unknown };
  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true";
  const dryRun = !apply;
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "description-code-artifact-sweep";

  const batchTag = `desc-code-artifact-sweep-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const results: ResultItem[] = [];
  if (dryRun) {
    for (const c of batch) {
      results.push({
        agent_id: c.id,
        name: c.name,
        outcome: "would_write",
        old_value_preview: previewValue(c.description),
      });
    }
  } else {
    for (const c of batch) {
      const w = applyDescriptionSweep(c.id, reason, batchTag);
      results.push({
        agent_id: c.id,
        name: c.name,
        outcome: w.outcome,
        old_value_preview: previewValue(w.oldValue ?? c.description),
        ...(w.detail ? { detail: w.detail } : {}),
      });
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  // ── `about` apply/dry-run pass — same batchTag/reason, own result set ────
  const aboutResults: ResultItem[] = [];
  if (dryRun) {
    for (const c of aboutBatch) {
      aboutResults.push({
        agent_id: c.id,
        name: c.name,
        outcome: "would_write",
        old_value_preview: previewValue(c.about),
      });
    }
  } else {
    for (const c of aboutBatch) {
      const w = applyAboutSweep(c.id, reason, batchTag);
      aboutResults.push({
        agent_id: c.id,
        name: c.name,
        outcome: w.outcome,
        old_value_preview: previewValue(w.oldValue ?? c.about),
        ...(w.detail ? { detail: w.detail } : {}),
      });
    }
  }

  const aboutCounts = aboutResults.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    dry_run: dryRun,
    batch_tag: batchTag,
    scanned,
    candidates_considered: candidatesConsidered,
    batch_size: batch.length,
    counts,
    results,
    // dev-request 2026-08-25-agent-knowledge-about-code-artifact-gap: the
    // `about` pass's own counts/results, deliberately NOT merged into the
    // keys above (see this file's header comment) so the description-only
    // response shape existing callers/tests already rely on stays
    // byte-for-byte unchanged.
    about_scanned: aboutScanned,
    about_candidates_considered: aboutCandidatesConsidered,
    about_batch_size: aboutBatch.length,
    about_counts: aboutCounts,
    about_results: aboutResults,
  });
});

export default router;
