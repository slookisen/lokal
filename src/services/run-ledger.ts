// ─── Run Ledger Service ─────────────────────────────────────────
//
// One-stop API for writing and reading platform run-envelopes.
//
// Writers: every scheduled-agent calls `record()` at end of run.
// Readers: platform-verifier (find pending), orchestrator (find recent
// completions, decide what to spawn next), Daniel (morning rollup).
//
// SQLite backing — see src/database/init.ts for schema. JSON columns
// are stored as TEXT and parsed on read.

import Database from "better-sqlite3";
import { getDb } from "../database/init";
import type {
  RunEnvelope,
  RunRecord,
  VerifierFinding,
  VerifierState,
} from "../types/run-envelope";

interface RunRow {
  run_id: string;
  vertical: string;
  agent: string;
  trigger_source: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  claims: string;
  evidence: string;
  next_suggested: string | null;
  errors: string | null;
  notes: string | null;
  verifier_state: string;
  verifier_checked_at: string | null;
  verifier_findings: string | null;
  created_at: string;
}

function rowToRecord(row: RunRow): RunRecord {
  return {
    run_id: row.run_id,
    vertical: row.vertical,
    agent: row.agent,
    trigger_source: row.trigger_source as RunEnvelope["trigger_source"],
    started_at: row.started_at,
    finished_at: row.finished_at ?? row.started_at,
    status: row.status as RunEnvelope["status"],
    claims: JSON.parse(row.claims),
    evidence: JSON.parse(row.evidence),
    next_suggested: row.next_suggested
      ? JSON.parse(row.next_suggested)
      : undefined,
    errors: row.errors ? JSON.parse(row.errors) : undefined,
    notes: row.notes ?? undefined,
    verifier_state: (row.verifier_state || "pending") as VerifierState,
    verifier_checked_at: row.verifier_checked_at ?? undefined,
    verifier_findings: row.verifier_findings
      ? JSON.parse(row.verifier_findings)
      : undefined,
  };
}

/**
 * Write an envelope to the ledger. Idempotent on `run_id` — re-recording
 * the same run_id is a no-op (we trust the first write). This means an
 * agent that crashes mid-write and retries cannot corrupt the ledger.
 *
 * Verifier columns (verifier_state, etc.) are NOT touched here — they're
 * the platform-verifier's domain. Default state is 'pending'.
 */
export function recordRun(envelope: RunEnvelope, db?: Database.Database): void {
  const conn = db ?? getDb();
  const stmt = conn.prepare(`
    INSERT INTO runs (
      run_id, vertical, agent, trigger_source,
      started_at, finished_at, status,
      claims, evidence, next_suggested, errors, notes
    ) VALUES (
      @run_id, @vertical, @agent, @trigger_source,
      @started_at, @finished_at, @status,
      @claims, @evidence, @next_suggested, @errors, @notes
    )
    ON CONFLICT(run_id) DO NOTHING
  `);
  stmt.run({
    run_id: envelope.run_id,
    vertical: envelope.vertical,
    agent: envelope.agent,
    trigger_source: envelope.trigger_source,
    started_at: envelope.started_at,
    finished_at: envelope.finished_at,
    status: envelope.status,
    claims: JSON.stringify(envelope.claims),
    evidence: JSON.stringify(envelope.evidence),
    next_suggested: envelope.next_suggested
      ? JSON.stringify(envelope.next_suggested)
      : null,
    errors: envelope.errors ? JSON.stringify(envelope.errors) : null,
    notes: envelope.notes ?? null,
  });
}

/**
 * Read recent runs for a vertical (default: rfb). Used by orchestrator's
 * morning rollup to summarise yesterday for Daniel.
 */
export function listRecentRuns(opts: {
  vertical?: string;
  agent?: string;
  sinceHours?: number;
  limit?: number;
  db?: Database.Database;
} = {}): RunRecord[] {
  const conn = opts.db ?? getDb();
  const sinceHours = opts.sinceHours ?? 24;
  const limit = Math.min(opts.limit ?? 200, 1000);
  const sinceISO = new Date(Date.now() - sinceHours * 3600_000).toISOString();

  const where: string[] = ["started_at >= ?"];
  const params: unknown[] = [sinceISO];
  if (opts.vertical) {
    where.push("vertical = ?");
    params.push(opts.vertical);
  }
  if (opts.agent) {
    where.push("agent = ?");
    params.push(opts.agent);
  }
  const sql = `
    SELECT * FROM runs
    WHERE ${where.join(" AND ")}
    ORDER BY started_at DESC
    LIMIT ?
  `;
  params.push(limit);
  const rows = conn.prepare(sql).all(...params) as RunRow[];
  return rows.map(rowToRecord);
}

/**
 * Find runs whose verifier hasn't checked them yet. Caller is the
 * platform-verifier scheduled task.
 *
 * Why we DON'T re-include `verifier_state = 'failed'`:
 * Originally we included `failed` so the verifier could retry. In practice
 * that meant the same row got re-probed every cycle, the probe failed for
 * the same upstream reason (e.g. agent's review_queue_appended claim doesn't
 * match disk), and the row stayed `failed` forever — wasting ~3 HTTP calls
 * per cycle for a problem the verifier already reported in `next_suggested`.
 * Verifier T1216/T1311/T1412/T1512 (2026-05-03) flagged this as a persistent
 * issue. Decision: `failed` is terminal until a write op (orchestrator
 * resolves the issue, or manual review re-queues) clears it. Retrying a
 * deterministic upstream failure on a 1h cadence is just billable noise.
 */
export function listPendingVerification(opts: {
  vertical?: string;
  maxAgeHours?: number;
  limit?: number;
  db?: Database.Database;
} = {}): RunRecord[] {
  const conn = opts.db ?? getDb();
  const maxAge = opts.maxAgeHours ?? 48;
  const limit = Math.min(opts.limit ?? 50, 500);
  const cutoff = new Date(Date.now() - maxAge * 3600_000).toISOString();

  const where: string[] = [
    "verifier_state = 'pending'",
    "started_at >= ?",
  ];
  const params: unknown[] = [cutoff];
  if (opts.vertical) {
    where.push("vertical = ?");
    params.push(opts.vertical);
  }
  const sql = `
    SELECT * FROM runs
    WHERE ${where.join(" AND ")}
    ORDER BY started_at ASC
    LIMIT ?
  `;
  params.push(limit);
  const rows = conn.prepare(sql).all(...params) as RunRow[];
  return rows.map(rowToRecord);
}

/**
 * Find runs that look stale: claimed completed but verifier never touched
 * them, beyond a grace period. Caller is the stale-detector scheduled task.
 */
export function listStaleRuns(opts: {
  graceMinutes?: number;
  vertical?: string;
  db?: Database.Database;
} = {}): RunRecord[] {
  const conn = opts.db ?? getDb();
  const grace = opts.graceMinutes ?? 30;
  const cutoff = new Date(Date.now() - grace * 60_000).toISOString();

  const where: string[] = [
    "status = 'completed'",
    "verifier_state = 'pending'",
    "finished_at < ?",
  ];
  const params: unknown[] = [cutoff];
  if (opts.vertical) {
    where.push("vertical = ?");
    params.push(opts.vertical);
  }
  const sql = `
    SELECT * FROM runs
    WHERE ${where.join(" AND ")}
    ORDER BY finished_at ASC
    LIMIT 200
  `;
  const rows = conn.prepare(sql).all(...params) as RunRow[];
  return rows.map(rowToRecord);
}

/**
 * Platform-verifier writes back here after probing each claim.
 * findings cover every claim that was probed (not necessarily all claims
 * — some may be `skipped`).
 */
export function recordVerifierResult(args: {
  run_id: string;
  state: VerifierState;
  findings: VerifierFinding[];
  db?: Database.Database;
}): { rowsAffected: number } {
  const conn = args.db ?? getDb();
  const info = conn
    .prepare(
      `UPDATE runs
       SET verifier_state = ?,
           verifier_checked_at = ?,
           verifier_findings = ?
       WHERE run_id = ?`,
    )
    .run(
      args.state,
      new Date().toISOString(),
      JSON.stringify(args.findings),
      args.run_id,
    );
  // Phase 4.10: caller can detect run-not-found (silent UPDATE no-op was the
  // original verifier-write-bug — POST returned 200 success even when run_id
  // didn't match any row, so the verifier thought it had recorded findings
  // but nothing persisted).
  return { rowsAffected: info.changes };
}

/**
 * Aggregate counts for the morning rollup / verifier-dashboard.
 */
export function summariseRuns(opts: {
  vertical?: string;
  sinceHours?: number;
  db?: Database.Database;
} = {}): {
  total: number;
  by_status: Record<string, number>;
  by_verifier: Record<string, number>;
  by_agent: Record<string, number>;
} {
  const conn = opts.db ?? getDb();
  const sinceHours = opts.sinceHours ?? 24;
  const sinceISO = new Date(Date.now() - sinceHours * 3600_000).toISOString();

  const where = ["started_at >= ?"];
  const params: unknown[] = [sinceISO];
  if (opts.vertical) {
    where.push("vertical = ?");
    params.push(opts.vertical);
  }
  const whereSql = where.join(" AND ");

  const total =
    (conn
      .prepare(`SELECT COUNT(*) AS c FROM runs WHERE ${whereSql}`)
      .get(...params) as { c: number }).c;

  const aggregate = (col: string): Record<string, number> => {
    const rows = conn
      .prepare(
        `SELECT ${col} AS k, COUNT(*) AS c
         FROM runs
         WHERE ${whereSql}
         GROUP BY ${col}`,
      )
      .all(...params) as Array<{ k: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.k, r.c]));
  };

  return {
    total,
    by_status: aggregate("status"),
    by_verifier: aggregate("verifier_state"),
    by_agent: aggregate("agent"),
  };
}
