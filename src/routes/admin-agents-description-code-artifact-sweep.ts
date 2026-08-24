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
// Deliberately NOT wired to the enrichment-write-pause gate (services/
// enrichment-write-pause.ts) that url-write's router-level handler also
// carries: the byggspec's "copy precisely, don't reinvent" pointer names
// only that sibling's lock/transaction/audit function (lines 233-273), not
// its router-level pause check, and this route's write is materially
// different from the automated-enrichment-write incident class that gate
// exists for (2026-08-20) — it deterministically blanks an already-broken
// field to '' with a fully reversible audit row, never writes fresh scraped
// content, and its only automated caller (a future scheduled-agents step,
// explicitly out of scope for this PR) only ever runs it in dry-run. A
// human operator invoking apply=true here would already be aware of any
// live incident-response pause. Left as a documented decision for review,
// not silently dropped.
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

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { looksLikeCodeArtifact } from "../services/description-quality";

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

/** Owner lock: `claimed_at` OR a verified row in agent_claims — same
 * two-source check as the url-write sibling's isOwnerLocked (that route's
 * own header documents the production gap a claimed_at-only check missed). */
function isOwnerLocked(s: LockSnapshot): boolean {
  return !!s.claimed_at || (s.verified_claims ?? 0) > 0;
}

/** True iff curated_fields locks the description field. Malformed/missing
 * JSON is treated as unlocked, same defensive parse as the url-write sibling. */
export function isDescriptionCurated(curatedFieldsJson: string | null | undefined): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    return !!(parsed as Record<string, unknown>)["description"];
  } catch {
    return false;
  }
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

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { apply?: unknown; reason?: unknown };
  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true";
  const dryRun = !apply;
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "description-code-artifact-sweep";

  const db = db_();

  // Full-catalog scan (AC1 requires quantifying the WHOLE catalog, not just
  // the batch this call will write) — read-only, no lock/claim considerations
  // apply to a scan, only to the write below.
  const allRows = db
    .prepare(`SELECT id, name, description FROM agents ORDER BY id ASC`)
    .all() as CandidateRow[];
  const scanned = allRows.length;
  const candidates = allRows.filter((r) => looksLikeCodeArtifact(r.description));
  const candidatesConsidered = candidates.length;
  const batch = candidates.slice(0, DESCRIPTION_SWEEP_MAX_ITEMS);

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

  res.json({
    success: true,
    dry_run: dryRun,
    batch_tag: batchTag,
    scanned,
    candidates_considered: candidatesConsidered,
    batch_size: batch.length,
    counts,
    results,
  });
});

export default router;
