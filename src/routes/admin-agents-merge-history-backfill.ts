// ─── Admin: POST /admin/agents/merge-history-backfill ───────────────────────
//
// dev-request 2026-11-22-rfb-dubletter-samme-nettsted-sammenslaaing-og-
// utsending, point 3: merges done BEFORE the duplicate-merge core carried the
// contact / outreach history (lokal#1623) left that history on the merged
// (deactivated) profile, so the surviving profile still looks "never
// contacted / never replied" to the outreach gates. This lever moves it.
//
// It finds every profile with `agents.merged_into` set that still owns rows in
//   crm_contacts.agent_id, outreach_sent_log.agent_id,
//   rfb_marketing_send_ledger.agent_id (when the table exists)
// resolves its merge chain (A→B→C ends at the first profile with no
// merged_into), and re-points the rows onto that final survivor with the SAME
// helper and audit rows the merge core writes (moveAgentHistory: one
// agent_knowledge_audit row `merge_moved:<table>` per moved table on the
// merged profile's id, old_value = merged id, new_value = survivor id, notes =
// JSON with the moved ids → rollback by UPDATE … WHERE id IN (notes.ids)).
// crm_threads have no agent column; they follow their contact and are counted.
//
//   * dry_run is the DEFAULT. Only an explicit false (false, 0, "0",
//     "false" in the body or ?dry_run=0|false) applies.
//   * Apply runs in ONE transaction over every source profile.
//   * A chain that ends in an inactive or missing profile, loops (cycle), or
//     is deeper than MERGE_CHAIN_MAX_DEPTH is SKIPPED and reported, never
//     moved.
//   * Idempotent: after an apply no row points at a merged profile any more,
//     so a second run finds nothing and moves 0.
//   * Optional `limit` caps the number of source (merged) profiles handled.
//
// Auth: X-Admin-Key, same as the sibling duplicate-merge route.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  moveAgentHistory,
  readDuplicateHistory,
  type HistoryMoveCounts,
} from "./admin-agents-duplicate-merge";

const router = Router();

let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setMergeHistoryBackfillDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

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

/** Longest merged_into chain followed before giving up. */
export const MERGE_CHAIN_MAX_DEPTH = 10;
/** Sample rows returned per response. */
export const BACKFILL_SAMPLE_MAX = 50;
export const BACKFILL_REASON = "merge-history-backfill (old merge, history left on merged profile)";

export type ChainOutcome =
  | { ok: true; survivorId: string; depth: number }
  | { ok: false; reason: "cycle" | "target_missing" | "target_inactive" | "depth_exceeded"; lastId: string };

/**
 * Follows agents.merged_into from `startId` (itself merged) to the first
 * profile with no merged_into. That profile must exist and be active.
 */
export function resolveMergeChain(db: ReturnType<typeof getDb>, startId: string): ChainOutcome {
  const get = db.prepare(`SELECT id, is_active, merged_into FROM agents WHERE id = ?`);
  const seen = new Set<string>([startId]);
  let row = get.get(startId) as { id: string; is_active: number | null; merged_into: string | null } | undefined;
  if (!row) return { ok: false, reason: "target_missing", lastId: startId };
  let depth = 0;
  while (row.merged_into !== null && row.merged_into !== "") {
    const next: string = row.merged_into;
    if (seen.has(next)) return { ok: false, reason: "cycle", lastId: next };
    if (++depth > MERGE_CHAIN_MAX_DEPTH) return { ok: false, reason: "depth_exceeded", lastId: row.id };
    seen.add(next);
    const nextRow = get.get(next) as typeof row | undefined;
    if (!nextRow) return { ok: false, reason: "target_missing", lastId: next };
    row = nextRow;
  }
  if (depth === 0) return { ok: false, reason: "target_missing", lastId: startId }; // not merged at all
  if (row.is_active !== null && Number(row.is_active) !== 1) {
    return { ok: false, reason: "target_inactive", lastId: row.id };
  }
  return { ok: true, survivorId: row.id, depth };
}

function tableExists(db: ReturnType<typeof getDb>, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/** Merged profiles that still own history rows, sorted by id. */
function findSources(db: ReturnType<typeof getDb>): string[] {
  const parts = [
    `SELECT c.agent_id AS id FROM crm_contacts c JOIN agents a ON a.id = c.agent_id WHERE a.merged_into IS NOT NULL AND a.merged_into <> ''`,
    `SELECT o.agent_id AS id FROM outreach_sent_log o JOIN agents a ON a.id = o.agent_id WHERE a.merged_into IS NOT NULL AND a.merged_into <> ''`,
  ];
  if (tableExists(db, "rfb_marketing_send_ledger")) {
    parts.push(
      `SELECT l.agent_id AS id FROM rfb_marketing_send_ledger l JOIN agents a ON a.id = l.agent_id WHERE a.merged_into IS NOT NULL AND a.merged_into <> ''`,
    );
  }
  return (db.prepare(`SELECT DISTINCT id FROM (${parts.join(" UNION ")}) ORDER BY id`).all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

const zero = (): HistoryMoveCounts => ({ crm_contacts: 0, crm_threads: 0, outreach_sent_log: 0, rfb_marketing_send_ledger: 0 });

function addCounts(into: HistoryMoveCounts, c: HistoryMoveCounts): void {
  into.crm_contacts += c.crm_contacts;
  into.crm_threads += c.crm_threads;
  into.outreach_sent_log += c.outreach_sent_log;
  into.rfb_marketing_send_ledger += c.rfb_marketing_send_ledger;
}

export interface BackfillSampleRow {
  table: "crm_contacts" | "outreach_sent_log" | "rfb_marketing_send_ledger";
  row_id: string | number;
  from: string;
  to: string;
}

export interface BackfillSkip {
  from: string;
  reason: "cycle" | "target_missing" | "target_inactive" | "depth_exceeded";
  last_id: string;
  rows: HistoryMoveCounts;
}

export interface BackfillResult {
  dry_run: boolean;
  batch_tag: string;
  sources_total: number;
  sources_handled: number;
  sources_moved: number;
  /** dry-run: rows that would move; apply: rows that moved. */
  counts: HistoryMoveCounts;
  skipped: BackfillSkip[];
  skipped_counts: HistoryMoveCounts;
  sample: BackfillSampleRow[];
}

/**
 * Plans (dryRun) or performs the backfill. Apply runs in one transaction; any
 * error rolls everything back and is thrown to the caller.
 */
export function runMergeHistoryBackfill(
  db: ReturnType<typeof getDb>,
  opts: { dryRun: boolean; limit?: number; batchTag?: string },
): BackfillResult {
  const batchTag =
    opts.batchTag ?? `merge-history-backfill-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const run = (): BackfillResult => {
    const all = findSources(db);
    const sources = opts.limit !== undefined ? all.slice(0, opts.limit) : all;
    const counts = zero();
    const skippedCounts = zero();
    const skipped: BackfillSkip[] = [];
    const sample: BackfillSampleRow[] = [];
    let moved = 0;

    for (const from of sources) {
      const rows = readDuplicateHistory(db, from);
      const rowCounts: HistoryMoveCounts = {
        crm_contacts: rows.crm_contacts.length,
        crm_threads: rows.crm_threads.length,
        outreach_sent_log: rows.outreach_sent_log.length,
        rfb_marketing_send_ledger: rows.rfb_marketing_send_ledger.length,
      };
      const chain = resolveMergeChain(db, from);
      if (!chain.ok) {
        skipped.push({ from, reason: chain.reason, last_id: chain.lastId, rows: rowCounts });
        addCounts(skippedCounts, rowCounts);
        continue;
      }
      const to = chain.survivorId;
      for (const table of ["crm_contacts", "outreach_sent_log", "rfb_marketing_send_ledger"] as const) {
        for (const id of rows[table] as Array<string | number>) {
          if (sample.length >= BACKFILL_SAMPLE_MAX) break;
          sample.push({ table, row_id: id, from, to });
        }
      }
      if (opts.dryRun) {
        addCounts(counts, rowCounts);
      } else {
        addCounts(counts, moveAgentHistory(db, to, from, BACKFILL_REASON, batchTag));
      }
      moved++;
    }

    return {
      dry_run: opts.dryRun,
      batch_tag: batchTag,
      sources_total: all.length,
      sources_handled: sources.length,
      sources_moved: moved,
      counts,
      skipped,
      skipped_counts: skippedCounts,
      sample,
    };
  };

  return opts.dryRun ? run() : db.transaction(run)();
}

/** Dry-run by default: only an explicit false form applies. */
export function isExplicitNoDryRun(bodyValue: unknown, queryValue?: unknown): boolean {
  return (
    bodyValue === false ||
    bodyValue === 0 ||
    bodyValue === "0" ||
    bodyValue === "false" ||
    queryValue === "0" ||
    queryValue === "false"
  );
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body ?? {}) as { dry_run?: unknown; limit?: unknown };
  const dryRun = !isExplicitNoDryRun(body.dry_run, req.query?.dry_run);

  let limit: number | undefined;
  const rawLimit = body.limit ?? req.query?.limit;
  if (rawLimit !== undefined) {
    const n = typeof rawLimit === "number" ? rawLimit : typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(n) || n < 1) {
      res.status(400).json({ error: "limit must be a positive integer" });
      return;
    }
    limit = n;
  }

  try {
    const result = runMergeHistoryBackfill(resolveDb(), { dryRun, limit });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: "merge-history-backfill failed (rolled back)", detail: String(err?.message || err) });
  }
});

export default router;
