// ─── search-enrich-sweep.ts — full-cohort background search-enrich (orch-pr-12) ─
//
// Problem: POST /admin/search-enrich processes at most HARD_CAP=50 agents per
// HTTP request (paced ≥1.1s for Brave's free tier → ~1 min for 50). The whole
// missing-email cohort is ~700 agents → ~13+ min, which would time out the
// Fly/client HTTP response. This module runs the ENTIRE cohort in one
// fire-and-forget background job (mirrors verifier-sweep.ts).
//
// SAFETY MODEL (the whole point of this PR):
//   - Dry-run by DEFAULT (apply=false): writes NOTHING to agent contact data.
//     Every per-agent finding is upserted to `search_enrich_findings` for
//     review/audit. Operators inspect the full would-write list first.
//   - apply=true: in addition to recording findings, writes ONLY the
//     strong-confirmed `write`-tier rows via applyEnrichWrite (fill-empty-only,
//     never overwrites). Weaker rows are recorded but never written.
//   - A separate admin endpoint (apply-findings) replays write-tier findings
//     from the table — the Daniel-gated apply step, decoupled from the sweep.
//
// Like verifier-sweep this is an in-memory singleton job; a process restart
// loses the job state but never corrupts data (findings already persisted,
// writes already committed). Re-running is safe (findings upsert by agent_id;
// applyEnrichWrite is fill-empty-only → idempotent).

import { getDb } from "../database/init";
import { mergeFieldProvenance } from "../routes/admin-knowledge";
import {
  braveSearch,
  buildPageEvidence,
  registrableHostFromUrl,
  enrichOneAgent,
  type EnrichDeps,
  type EnrichRow,
  type StoredProducer,
} from "./search-enrich";

// ─── Cohort SQL (MUST stay identical to the route's target selection) ──────────
//
// email missing/null AND phone present; exclude opt-out / claimed / CRM-blocked.
// NO LIMIT — the sweep processes the whole cohort.
export const COHORT_SELECT_COLS = `
    a.id   AS agent_id,
    a.name AS name,
    a.city AS city,
    a.url  AS url,
    k.phone   AS phone,
    k.website AS website,
    k.email   AS email,
    k.postal_code AS postcode,
    k.address AS address
`;

export const COHORT_WHERE = `
    FROM agents a
    INNER JOIN agent_knowledge k ON k.agent_id = a.id
    WHERE (k.email IS NULL OR trim(k.email) = '')
      AND k.phone IS NOT NULL AND trim(k.phone) != ''
      AND (k.verification_status IS NULL OR k.verification_status != 'opt_out')
      AND a.claimed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM crm_contacts cc
        WHERE cc.agent_id = a.id AND cc.status != 'active'
      )
`;

export interface CohortAgent {
  agent_id: string;
  name: string;
  city: string | null;
  url: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  postcode: string | null;
  address: string | null;
}

/** Select the WHOLE missing-email cohort (no limit). */
export function selectCohort(db: any): CohortAgent[] {
  return db
    .prepare(`SELECT ${COHORT_SELECT_COLS} ${COHORT_WHERE} ORDER BY a.created_at ASC`)
    .all() as CohortAgent[];
}

// ─── Findings table (durable, auditable) ───────────────────────────────────────
//
// One row PER AGENT (PRIMARY KEY agent_id) — the latest sweep replaces. This is
// both the review record AND the source of truth for apply-findings.
export function ensureFindingsTable(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_enrich_findings (
      agent_id          TEXT PRIMARY KEY,
      name              TEXT,
      query             TEXT,
      tier              TEXT,
      candidate_email   TEXT,
      source_url        TEXT,
      confirm_strength  TEXT,
      signals           TEXT,
      email_reason      TEXT,
      run_id            TEXT,
      created_at        TEXT
    )
  `);
}

/** Upsert a finding (latest run replaces by agent_id). */
export function upsertFinding(
  db: any,
  row: EnrichRow,
  runId: string,
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO search_enrich_findings
       (agent_id, name, query, tier, candidate_email, source_url,
        confirm_strength, signals, email_reason, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       name=excluded.name,
       query=excluded.query,
       tier=excluded.tier,
       candidate_email=excluded.candidate_email,
       source_url=excluded.source_url,
       confirm_strength=excluded.confirm_strength,
       signals=excluded.signals,
       email_reason=excluded.email_reason,
       run_id=excluded.run_id,
       created_at=excluded.created_at`,
  ).run(
    row.agent_id,
    row.name,
    row.query,
    row.tier,
    row.candidate_email,
    row.chosen_url,
    row.confirm.strength,
    JSON.stringify(row.confirm.signals),
    row.email_reason,
    runId,
    nowIso,
  );
}

// ─── Shared write path (fill-empty-only + provenance) ──────────────────────────
//
// SHARED by the route (POST /admin/search-enrich apply=1), the sweep (apply=true),
// and apply-findings. NEVER overwrites a non-empty value. source_type =
// `web_search:<email-domain>`. Returns whether the email column was actually
// written (false → fields were already non-empty: a fill-empty-only skip).
export function applyEnrichWrite(
  db: any,
  agentId: string,
  email: string,
  chosenUrl: string | null,
  nowIso: string,
): { emailWritten: boolean } {
  let emailWritten = false;
  const tx = db.transaction(() => {
    // Ensure a knowledge row exists.
    const exists = db
      .prepare("SELECT email, website FROM agent_knowledge WHERE agent_id = ?")
      .get(agentId) as { email: string | null; website: string | null } | undefined;

    if (!exists) {
      db.prepare(
        "INSERT INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, '{}', ?)",
      ).run(agentId, nowIso);
    }

    const curEmail = exists?.email ?? null;
    const curWebsite = exists?.website ?? null;

    const emailDomain = (email.split("@")[1] ?? "").toLowerCase();
    const sourceType = `web_search:${emailDomain}`;

    // Column writes — only fill empties (never overwrite non-empty).
    const colSets: string[] = [];
    const colVals: unknown[] = [];
    if (!curEmail || !curEmail.trim()) {
      colSets.push("email = ?");
      colVals.push(email);
      emailWritten = true;
    }
    if (chosenUrl && (!curWebsite || !curWebsite.trim())) {
      colSets.push("website = ?");
      colVals.push(chosenUrl);
    }
    if (colSets.length > 0) {
      colVals.push(nowIso, agentId);
      db.prepare(
        `UPDATE agent_knowledge SET ${colSets.join(", ")}, updated_at = ? WHERE agent_id = ?`,
      ).run(...colVals);
    }

    // Provenance merge — append an email source ONLY when we actually wrote the
    // email (so a fill-empty-only skip is a true no-op; keeps apply-findings
    // idempotent on re-run).
    if (emailWritten) {
      const provRow = db
        .prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?")
        .get(agentId) as { field_provenance?: string } | undefined;
      let existingProv: Record<string, unknown> = {};
      if (provRow?.field_provenance) {
        try {
          const parsed = JSON.parse(provRow.field_provenance);
          if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
        } catch {
          existingProv = {};
        }
      }
      const merged = mergeFieldProvenance(existingProv, {
        email: {
          sources: [
            {
              source_type: sourceType,
              value: email,
              fetched_at: nowIso,
              source_url: chosenUrl ?? undefined,
            },
          ],
        },
      });
      db.prepare(
        "UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?",
      ).run(JSON.stringify(merged), nowIso, agentId);
    }
  });
  tx();
  return { emailWritten };
}

// ─── apply-findings (Daniel-gated apply step) ──────────────────────────────────
//
// Replay write-tier findings from the table. Writes ONLY tier='write',
// fill-empty-only, with provenance, never overwriting. Idempotent: re-running
// writes nothing new because the fields are now non-empty.
export interface ApplyFindingsResult {
  applied: number;
  skipped_nonempty: number;
  total_write_findings: number;
}

export function applyFindings(db: any, nowIso = new Date().toISOString()): ApplyFindingsResult {
  ensureFindingsTable(db);
  const rows = db
    .prepare(
      `SELECT agent_id, candidate_email, source_url
         FROM search_enrich_findings
        WHERE tier = 'write' AND candidate_email IS NOT NULL AND trim(candidate_email) != ''`,
    )
    .all() as Array<{ agent_id: string; candidate_email: string; source_url: string | null }>;

  let applied = 0;
  let skipped = 0;
  for (const r of rows) {
    try {
      const { emailWritten } = applyEnrichWrite(
        db,
        r.agent_id,
        r.candidate_email,
        r.source_url,
        nowIso,
      );
      if (emailWritten) applied++;
      else skipped++;
    } catch {
      // A single bad row must not abort the apply — count it as skipped.
      skipped++;
    }
  }
  return { applied, skipped_nonempty: skipped, total_write_findings: rows.length };
}

// ─── In-memory job state (singleton, mirrors verifier-sweep) ───────────────────

export type SearchEnrichSweepStatus = "idle" | "running" | "done" | "error";

export interface SearchEnrichSweepJob {
  run_id: string | null;
  status: SearchEnrichSweepStatus;
  apply: boolean;
  total: number;
  processed: number;
  counts: { write: number; queue: number; none: number; error: number };
  applied_writes: number; // when apply=true: emails actually written by the sweep
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
}

let _job: SearchEnrichSweepJob = {
  run_id: null,
  status: "idle",
  apply: false,
  total: 0,
  processed: 0,
  counts: { write: 0, queue: 0, none: 0, error: 0 },
  applied_writes: 0,
  started_at: null,
  finished_at: null,
  last_error: null,
};

export function getSearchEnrichSweepJob(): Readonly<SearchEnrichSweepJob> {
  return { ..._job, counts: { ..._job.counts } };
}

function makeRunId(): string {
  return `se-sweep-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── startSearchEnrichSweep ────────────────────────────────────────────────────

export interface StartSearchEnrichSweepOpts {
  apply: boolean;
  /** Injectable deps — defaults to real Brave search + buildPageEvidence. */
  deps?: EnrichDeps;
  /** Injectable sleep — pass () => Promise.resolve() in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Pace between agents (Brave free tier ≥1.1s). Default 1100ms. */
  paceMs?: number;
  /** Injectable DB — defaults to getDb(). */
  db?: any;
}

export type StartSearchEnrichSweepResult =
  | { started: true; run_id: string; total: number; status: "running" }
  | { started: false; reason: "already_running" | "no_brave_key" };

const PACE_MS_DEFAULT = 1_100; // ~1.1s between agents → respect Brave's ~1 req/sec
const BRAVE_429_BACKOFF_MS = 2_000;

/**
 * Launch a background sweep over the WHOLE missing-email cohort.
 *
 * Returns immediately ({started:true, run_id, total}) while the loop runs in the
 * background (NOT awaited). If a sweep is already running → {started:false,
 * reason:'already_running'}. If no Brave key is configured AND no deps are
 * injected → {started:false, reason:'no_brave_key'} (so the route can 503).
 */
export function startSearchEnrichSweep(
  opts: StartSearchEnrichSweepOpts,
): StartSearchEnrichSweepResult {
  if (_job.status === "running") {
    return { started: false, reason: "already_running" };
  }

  const apply = !!opts.apply;
  const db = opts.db ?? getDb();
  const sleepFn = opts.sleep ?? defaultSleep;
  const paceMs = opts.paceMs ?? PACE_MS_DEFAULT;

  // Resolve deps. If none injected, build real deps from the env Brave key;
  // refuse (no_brave_key) when the key is missing so the route 503s.
  let deps: EnrichDeps;
  if (opts.deps) {
    deps = opts.deps;
  } else {
    const braveKey = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || "";
    if (!braveKey) {
      return { started: false, reason: "no_brave_key" };
    }
    deps = {
      search: (q) => braveSearch(q, braveKey, 5),
      crawl: (url) => buildPageEvidence(url),
    };
  }

  ensureFindingsTable(db);

  const runId = makeRunId();
  const startedAt = new Date().toISOString();

  // Select the whole cohort up front so `total` is fixed for the run.
  const cohort = selectCohort(db);

  _job = {
    run_id: runId,
    status: "running",
    apply,
    total: cohort.length,
    processed: 0,
    counts: { write: 0, queue: 0, none: 0, error: 0 },
    applied_writes: 0,
    started_at: startedAt,
    finished_at: null,
    last_error: null,
  };

  // ── Background loop (fire-and-forget; NOT awaited) ──────────────────────────
  (async () => {
    try {
      for (let i = 0; i < cohort.length; i++) {
        const t = cohort[i]!;
        const nowIso = new Date().toISOString();

        try {
          // Pace between agents (skip the wait before the first one).
          if (i > 0) await sleepFn(paceMs);

          const geo = (t.city ?? "").trim();
          const query = `"${t.name}" ${geo}`.trim();
          const siteRoot = t.website ? registrableHostFromUrl(t.website) : null;
          const stored: StoredProducer & { agent_id: string; name: string; query: string } = {
            agent_id: t.agent_id,
            name: t.name,
            query,
            phone: t.phone,
            postcode: t.postcode,
            street: t.address,
            orgnr: null,
            siteRoot,
          };

          // Run the shared per-agent processing, retrying once on a Brave 429.
          let row: EnrichRow;
          try {
            row = await enrichOneAgent(stored, deps);
          } catch (err: any) {
            const msg = err?.message ?? String(err);
            if (/HTTP 429/.test(msg)) {
              // Brave rate-limit — back off and retry once.
              await sleepFn(BRAVE_429_BACKOFF_MS);
              row = await enrichOneAgent(stored, deps);
            } else {
              throw err;
            }
          }

          // Persist the finding (dry-run still records EVERYTHING).
          upsertFinding(db, row, runId, nowIso);

          // Apply ONLY write-tier when apply=true (fill-empty-only).
          if (apply && row.tier === "write" && row.candidate_email) {
            try {
              const { emailWritten } = applyEnrichWrite(
                db,
                row.agent_id,
                row.candidate_email,
                row.chosen_url,
                nowIso,
              );
              if (emailWritten) _job.applied_writes++;
            } catch (writeErr: any) {
              // Write failure doesn't abort the sweep; finding is still recorded.
              _job.last_error = `write_failed:${writeErr?.message ?? String(writeErr)}`;
            }
          }

          _job.counts[row.tier]++;
        } catch (agentErr: any) {
          // One agent's failure must NEVER abort the sweep.
          _job.counts.error++;
          _job.last_error = agentErr?.message ?? String(agentErr);
          // Record an error finding so the audit table reflects the attempt.
          try {
            upsertFinding(
              db,
              {
                agent_id: t.agent_id,
                name: t.name,
                query: `"${t.name}" ${(t.city ?? "").trim()}`.trim(),
                chosen_url: null,
                confirm: { confirmed: false, strength: "none", signals: [] },
                candidate_email: null,
                email_reason: `error:${agentErr?.message ?? String(agentErr)}`,
                tier: "none",
                content_signals: null,
              },
              runId,
              nowIso,
            );
          } catch {
            /* best-effort audit row */
          }
        } finally {
          _job.processed++;
        }
      }

      _job.status = "done";
      _job.finished_at = new Date().toISOString();
      console.log(
        `[search-enrich-sweep] ${runId}: COMPLETE — processed=${_job.processed}/${_job.total} ` +
          `write=${_job.counts.write} queue=${_job.counts.queue} none=${_job.counts.none} ` +
          `errors=${_job.counts.error} applied_writes=${_job.applied_writes} apply=${apply}`,
      );
    } catch (outerErr: any) {
      _job.status = "error";
      _job.finished_at = new Date().toISOString();
      _job.last_error = outerErr?.message ?? String(outerErr);
      console.error(`[search-enrich-sweep] ${runId}: unexpected outer error:`, _job.last_error);
    }
  })(); // fire-and-forget

  return { started: true, run_id: runId, total: cohort.length, status: "running" };
}

/** TEST-ONLY: reset the singleton job so independent tests don't bleed state. */
export function __resetSearchEnrichSweepJobForTesting(): void {
  _job = {
    run_id: null,
    status: "idle",
    apply: false,
    total: 0,
    processed: 0,
    counts: { write: 0, queue: 0, none: 0, error: 0 },
    applied_writes: 0,
    started_at: null,
    finished_at: null,
    last_error: null,
  };
}
