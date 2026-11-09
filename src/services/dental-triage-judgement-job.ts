// ─── Dental-triage judgement job (needs_review judgement decisions) ──────
//
// dev-request 2026-09-02-dental-permanent-triage-needs-review-drain, slice
// 3c-2. Same file-queue shape as the gårdssalg website-judgement job
// (services/gardssalg-website-judgement-job.ts, slice 3j).
//
// WHY. Slice 3c-1 (services/dental-triage.ts) drains only what can be decided
// deterministically from the dental needs_review state; everything else stays
// "undecided". The rest needs judgement: should the row leave the catalogue
// (rejected + a dental_exclusions row) or is its catalog_class wrong? A
// platform job never calls an LLM. A Cloud Routine GETs
// /admin/dental/triage/judge-candidates (public catalog fields + the latest
// 3c-1 outcome), judges, and commits the decisions as a JSON file to the A2A
// repo. This job reads those files from GitHub (the shared proposal file
// queue, services/proposal-file-queue.ts) and stores each decision only after
// deterministic re-checks. NEVER calls an LLM, sends nothing: its only
// network calls are api.github.com.
//
// FILE FORMAT (A2A `dental-triage-judgements/<UTC-date>/<run-id>.json`):
//   {"schema":"dental-triage-judgements/v1","run_id","created_at",
//    "items":[{"agent_id","decision":"AVVIS"|"KATALOGKLASSE","catalog_class"?,"reason"}]}
// File-level (whole file recorded as an error, nothing written): not an
// object, wrong schema, run_id not 1..80 chars of [A-Za-z0-9._:-],
// created_at not ISO-8601 with a zone or in the future, items not an array of
// 1..50 objects with a non-empty string agent_id, duplicate agent_ids.
// Item-level (that item rejected, rest applied): over-long agent_id, unknown
// decision, missing/over-long (>500 chars) reason, KATALOGKLASSE without a
// catalog_class from DENTAL_CATALOG_CLASSES (invalid_catalog_class).
//
// SERVER RE-CHECKS per item, in one transaction per row with a re-read: the
// dental enrichment write-pause (a pause THROWS before any write for the
// file — the queue records a per-file failure and retries it later; items
// already stored are then not_eligible, so a retry is idempotent); the row
// exists (else not_found); it is in the 3c triage state — verification_status
// 'needs_review', review_reason in DENTAL_TRIAGE_REVIEW_REASONS, not
// is_inactive, not a synthetic probe (else not_eligible). Whether 3c-1 could
// decide the row itself is not this path's concern.
//
//   AVVIS          -> verification_status='rejected', review_reason/
//                     review_since cleared (the row leaves needs_review, as
//                     3c-1 clears them when it moves a row out), plus one
//                     dental_exclusions row through recordExclusion()
//                     (dental-store.ts): reason 'manual_review' (a judged
//                     decision, not a rule), evidence = the judge's reason,
//                     excluded_by/notes = 'dental-triage-judgement:<run_id>'.
//                     org_nr is excluded; hjemmeside only when it is NOT a
//                     directory/catalog URL (classifyHjemmeside), so a shared
//                     catalog page can never block other clinics.
//   KATALOGKLASSE  -> catalog_class=<class>, catalog_class_source=
//                     'dental_triage_judgement:<run_id>', catalog_class_at=now
//                     (the same three columns every catalog_class writer
//                     sets). 3c-1 defines no catalog_class decision, so the
//                     review state is LEFT UNCHANGED: the row stays
//                     needs_review, and 3c-1's next pass re-evaluates it with
//                     the corrected class (e.g. klinikk -> may meet the
//                     Verified rule; a non-clinic class stays undecided and
//                     may later get an AVVIS). Same class as stored ->
//                     rejected 'unchanged', nothing written.
//
// AUDIT: one dental_verifier_findings row (check_type
// 'dental_triage_judgement') per item outcome whose agent row exists (the
// table has a FK to dental_agents, so not_found/invalid_agent_id items are
// only in the file's result_json): status 'avvis' | 'katalogklasse' for a
// written item, else the rejection reason; evidence carries run_id,
// decision, the judge's reason and the row's prior state.
//
// GUARDS, each a no-op tick: DENTAL_TRIAGE_JUDGEMENT_JOB_ENABLED === "true"
// (OFF by default — flipping it off is the rollback); the dental enrichment
// write-pause; A2A_READ_PAT present.
//
// BUDGET. Up to 4 files per tick, at most 8 files per UTC day (≤400 rows).

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb as getDentalDbFactory } from "../database/db-factory";
import { getDb as getMainDbDefault } from "../database/init";
import { DENTAL_CATALOG_CLASSES } from "./dental-catalog-class";
import { classifyHjemmeside } from "./dental-hjemmeside-classifier";
import { recordExclusion } from "./dental-store";
import {
  DENTAL_TRIAGE_CANDIDATE_STATE_SQL,
  DENTAL_TRIAGE_CHECK_TYPE,
  DENTAL_TRIAGE_REVIEW_REASONS,
  DENTAL_TRIAGE_UNDECIDED_RECHECK_DAYS,
  clampDentalTriageLimit,
} from "./dental-triage";
import {
  EnrichmentWritePausedError,
  enrichmentWritePauseBlock,
  type EnrichmentWritePausedBody,
} from "./enrichment-write-pause";
import {
  PROPOSAL_QUEUE_MAX_AGE_DAYS,
  __resetProposalQueueDroppedLogForTesting,
  getProposalQueueExtras,
  getProposalQueueStatus,
  runProposalFileQueueTick,
  type ProposalApplyFn,
  type ProposalQueueConfig,
  type ProposalQueueDeps,
  type ProposalQueueExtras,
  type ProposalQueueTickReport,
} from "./proposal-file-queue";

export const DENTAL_TRIAGE_JUDGEMENTS_SCHEMA = "dental-triage-judgements/v1";
export const DENTAL_TRIAGE_JUDGEMENTS_DIR = "dental-triage-judgements";
export const DENTAL_TRIAGE_JUDGEMENT_AGENT = "dental-triage-judgement-job";
export const DENTAL_TRIAGE_JUDGEMENT_CHECK_TYPE = "dental_triage_judgement";
export const DENTAL_TRIAGE_JUDGEMENT_SOURCE_PREFIX = "dental_triage_judgement:";
export const DENTAL_TRIAGE_JUDGEMENT_EXCLUDED_BY_PREFIX = "dental-triage-judgement:";
export const DENTAL_TRIAGE_JUDGEMENTS_MAX_ITEMS = 50;
export const DENTAL_TRIAGE_JUDGEMENTS_MAX_REASON_CHARS = 500;
export const DENTAL_TRIAGE_JUDGEMENT_FILES_PER_TICK = 4;
export const DENTAL_TRIAGE_JUDGEMENT_MAX_ATTEMPTS_PER_TICK = 8;
/** Per-UTC-day cap on recorded files (≤ 8 × 50 = 400 rows a day). */
export const DENTAL_TRIAGE_JUDGEMENT_MAX_FILES_PER_DAY = 8;
export const DENTAL_TRIAGE_JUDGEMENT_MAX_ID_CHARS = 64;
export const DENTAL_TRIAGE_JUDGEMENT_MAX_RUN_ID_CHARS = 80;
/** 50 items × (≤500-char reason, up to 2 bytes/char, + id and class). */
export const DENTAL_TRIAGE_JUDGEMENT_MAX_FILE_BYTES = 128 * 1024;
export const DENTAL_TRIAGE_JUDGEMENT_FILES_TABLE = "dental_triage_judgement_files";
export const DENTAL_TRIAGE_JUDGEMENT_FAILURES_TABLE = "dental_triage_judgement_failures";
export const DENTAL_TRIAGE_JUDGE_CANDIDATES_DEFAULT_LIMIT = 25;
/** A row with an applied judgement inside this window is not offered again. */
export const DENTAL_TRIAGE_JUDGEMENT_RECHECK_DAYS = DENTAL_TRIAGE_UNDECIDED_RECHECK_DAYS;

export type DentalTriageJudgementDecision = "AVVIS" | "KATALOGKLASSE";

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const RUN_ID_RE = /^[A-Za-z0-9._:\-]{1,80}$/;
/** A created_at further ahead of the server clock than this is rejected. */
const MAX_CLOCK_SKEW_MS = 10 * 60_000;
const ALLOWED_CLASSES = new Set<string>(DENTAL_CATALOG_CLASSES);

export function dentalTriageJudgementJobEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DENTAL_TRIAGE_JUDGEMENT_JOB_ENABLED === "true";
}

function logSafe(v: unknown, max: number): string {
  return String(v ?? "-").replace(/[^A-Za-z0-9._:\-]/g, "").slice(0, max);
}

/** Structural item checks shared by the file validator and apply (both
 *  reject the whole file on these). null = OK. */
function fileLevelItemsError(rawItems: unknown): string | null {
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > DENTAL_TRIAGE_JUDGEMENTS_MAX_ITEMS) {
    return `items must be an array of 1..${DENTAL_TRIAGE_JUDGEMENTS_MAX_ITEMS} items`;
  }
  const seen = new Set<string>();
  for (let i = 0; i < rawItems.length; i++) {
    const r = rawItems[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) return `items[${i}] must be an object`;
    const id = (r as Record<string, unknown>).agent_id;
    if (typeof id !== "string" || id.trim() === "") return `items[${i}].agent_id must be a non-empty string`;
    const t = id.trim();
    if (t.length > DENTAL_TRIAGE_JUDGEMENT_MAX_ID_CHARS) continue; // item-level invalid_agent_id
    if (seen.has(t)) return `duplicate agent_id in items: ${logSafe(t, DENTAL_TRIAGE_JUDGEMENT_MAX_ID_CHARS)}`;
    seen.add(t);
  }
  return null;
}

/** File-level structural check; item-level checks are the apply function's. */
export function validateDentalTriageJudgementFile(
  parsed: unknown,
  now: Date = new Date(),
): { items: unknown[]; context: { run_id: string; created_at: string } } | { error: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "file is not a JSON object" };
  const p = parsed as Record<string, unknown>;
  if (p.schema !== DENTAL_TRIAGE_JUDGEMENTS_SCHEMA) return { error: `schema must be "${DENTAL_TRIAGE_JUDGEMENTS_SCHEMA}"` };
  if (typeof p.run_id !== "string" || !RUN_ID_RE.test(p.run_id.trim())) {
    return { error: `run_id must be 1..${DENTAL_TRIAGE_JUDGEMENT_MAX_RUN_ID_CHARS} characters of [A-Za-z0-9._:-]` };
  }
  if (typeof p.created_at !== "string" || !ISO_WITH_ZONE.test(p.created_at) || !Number.isFinite(Date.parse(p.created_at))) {
    return { error: "created_at must be an ISO-8601 timestamp with a zone (e.g. 2026-11-01T10:00:00Z)" };
  }
  if (Date.parse(p.created_at) > now.getTime() + MAX_CLOCK_SKEW_MS) return { error: "created_at is in the future" };
  const itemsError = fileLevelItemsError(p.items);
  if (itemsError) return { error: itemsError };
  return { items: p.items as unknown[], context: { run_id: p.run_id.trim(), created_at: p.created_at } };
}

// ── Apply (the no-LLM store step) ────────────────────────────────────────

export type DentalTriageJudgementItemResult = {
  agent_id: string;
  result: "written" | "rejected";
  reason?: string;
  decision?: DentalTriageJudgementDecision;
  catalog_class?: string;
};

export type DentalTriageJudgementsResult =
  | { ok: false; error: string }
  | {
      ok: true;
      totals: { written: number; rejected: number; avvis: number; katalogklasse: number };
      results: DentalTriageJudgementItemResult[];
    };

export interface DentalTriageJudgementApplyOpts {
  runId?: unknown;
  createdAt?: unknown;
  now?: Date;
  logTag?: string;
  /** Write-pause check; defaults to the dental enrichment write-pause on the main DB. */
  pauseBlock?: () => EnrichmentWritePausedBody | null;
}

type CurrentRow = {
  id: string;
  org_nr: string | null;
  hjemmeside: string | null;
  catalog_class: string | null;
  verification_status: string | null;
  review_reason: string | null;
  review_since: string | null;
  is_inactive: number | null;
  eligible: number;
};

/**
 * Stores one judgement file's items. NEVER calls an LLM, never fetches.
 * File-level problems -> {ok:false}; a malformed item rejects only itself.
 * A live write-pause THROWS (EnrichmentWritePausedError) before any write,
 * so the queue records a per-file failure and retries the file later.
 */
export function applyDentalTriageJudgements(
  db: Database.Database,
  rawItems: unknown,
  opts: DentalTriageJudgementApplyOpts = {},
): DentalTriageJudgementsResult {
  const itemsError = fileLevelItemsError(rawItems);
  if (itemsError) return { ok: false, error: itemsError };
  const runId = typeof opts.runId === "string" && RUN_ID_RE.test(opts.runId.trim()) ? opts.runId.trim() : null;
  if (!runId) return { ok: false, error: "run_id missing or invalid" };

  const pauseFn = opts.pauseBlock ?? (() => enrichmentWritePauseBlock(getMainDbDefault, "dental"));
  const assertNotPaused = (): void => {
    const block = pauseFn();
    if (block) throw new EnrichmentWritePausedError(block);
  };
  // Whole-file gate: a paused vertical writes nothing at all.
  assertNotPaused();

  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const checkedAt = nowIso.replace("T", " ").slice(0, 19); // datetime('now') text form, as 3c-1 writes it
  const source = `${DENTAL_TRIAGE_JUDGEMENT_SOURCE_PREFIX}${runId}`;
  const excludedBy = `${DENTAL_TRIAGE_JUDGEMENT_EXCLUDED_BY_PREFIX}${runId}`;

  const readStmt = db.prepare(
    `SELECT id, org_nr, hjemmeside, catalog_class, verification_status, review_reason, review_since, is_inactive,
            CASE WHEN ${DENTAL_TRIAGE_CANDIDATE_STATE_SQL} THEN 1 ELSE 0 END AS eligible
       FROM dental_agents WHERE id = ?`,
  );
  const readRow = (id: string): CurrentRow | undefined =>
    readStmt.get(...DENTAL_TRIAGE_REVIEW_REASONS, id) as CurrentRow | undefined;
  const insertFinding = db.prepare(
    `INSERT INTO dental_verifier_findings (id, agent_id, check_type, status, evidence, notes, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const rejectStmt = db.prepare(
    `UPDATE dental_agents
        SET verification_status = 'rejected', review_reason = NULL, review_since = NULL, updated_at = datetime('now')
      WHERE id = ?`,
  );
  const classStmt = db.prepare(
    `UPDATE dental_agents
        SET catalog_class = ?, catalog_class_source = ?, catalog_class_at = ?, updated_at = datetime('now')
      WHERE id = ?`,
  );

  const results: DentalTriageJudgementItemResult[] = [];
  const audit = (
    row: CurrentRow,
    status: string,
    notes: string,
    extra: Record<string, unknown>,
  ): void => {
    insertFinding.run(
      randomUUID(),
      row.id,
      DENTAL_TRIAGE_JUDGEMENT_CHECK_TYPE,
      status,
      JSON.stringify({
        run_id: runId,
        created_at: typeof opts.createdAt === "string" ? opts.createdAt : null,
        prior: {
          verification_status: row.verification_status,
          review_reason: row.review_reason,
          review_since: row.review_since,
          catalog_class: row.catalog_class,
        },
        ...extra,
      }),
      notes.slice(0, DENTAL_TRIAGE_JUDGEMENTS_MAX_REASON_CHARS),
      checkedAt,
    );
  };

  for (const raw of rawItems as Array<Record<string, unknown>>) {
    const agentId = String(raw.agent_id).trim();
    if (agentId.length > DENTAL_TRIAGE_JUDGEMENT_MAX_ID_CHARS) {
      results.push({ agent_id: logSafe(agentId, DENTAL_TRIAGE_JUDGEMENT_MAX_ID_CHARS), result: "rejected", reason: "invalid_agent_id" });
      continue;
    }
    const decision = raw.decision === "AVVIS" || raw.decision === "KATALOGKLASSE" ? (raw.decision as DentalTriageJudgementDecision) : null;
    const reasoning = typeof raw.reason === "string" ? raw.reason.replace(/\s+/g, " ").trim() : "";
    const catalogClass = typeof raw.catalog_class === "string" ? raw.catalog_class.trim() : null;

    let itemError: string | null = null;
    if (!decision) itemError = "invalid_decision";
    else if (reasoning === "" || reasoning.length > DENTAL_TRIAGE_JUDGEMENTS_MAX_REASON_CHARS) itemError = "invalid_reason";
    else if (decision === "KATALOGKLASSE" && (!catalogClass || !ALLOWED_CLASSES.has(catalogClass))) itemError = "invalid_catalog_class";

    assertNotPaused();
    let outcome: DentalTriageJudgementItemResult | null = null;
    const tx = db.transaction(() => {
      const row = readRow(agentId);
      if (!row) {
        outcome = { agent_id: agentId, result: "rejected", reason: itemError ?? "not_found" };
        return;
      }
      const auditExtra = {
        decision: decision ?? logSafe(raw.decision, 32),
        ...(decision === "KATALOGKLASSE" ? { catalog_class: catalogClass ? logSafe(catalogClass, 32) : null } : {}),
        judge_reason: reasoning.slice(0, DENTAL_TRIAGE_JUDGEMENTS_MAX_REASON_CHARS),
      };
      const rejectWith = (reason: string): void => {
        outcome = { agent_id: agentId, result: "rejected", reason, ...(decision ? { decision } : {}) };
        audit(row, reason, reason, auditExtra);
      };
      if (itemError) { rejectWith(itemError); return; }
      if (row.eligible !== 1) { rejectWith("not_eligible"); return; }

      if (decision === "AVVIS") {
        const hjemmeside = row.hjemmeside && row.hjemmeside.trim() !== "" ? row.hjemmeside.trim() : null;
        const hjemmesideExcludable = hjemmeside !== null && !classifyHjemmeside(hjemmeside).isBad;
        rejectStmt.run(row.id);
        const exclusionId = recordExclusion(
          {
            orgnr: row.org_nr && row.org_nr.trim() !== "" ? row.org_nr.trim() : null,
            hjemmesideUrl: hjemmesideExcludable ? hjemmeside : null,
            reason: "manual_review",
            evidence: reasoning,
            notes: excludedBy,
            excludedBy,
          },
          db,
        );
        audit(row, "avvis", reasoning, { ...auditExtra, exclusion_id: exclusionId });
        outcome = { agent_id: agentId, result: "written", decision };
        return;
      }

      // KATALOGKLASSE
      if (row.catalog_class === catalogClass) { rejectWith("unchanged"); return; }
      classStmt.run(catalogClass, source, nowIso, row.id);
      audit(row, "katalogklasse", reasoning, auditExtra);
      outcome = { agent_id: agentId, result: "written", decision: "KATALOGKLASSE", catalog_class: catalogClass as string };
    });
    tx();
    results.push(outcome as unknown as DentalTriageJudgementItemResult);
  }

  const totals = { written: 0, rejected: 0, avvis: 0, katalogklasse: 0 };
  for (const r of results) {
    totals[r.result]++;
    if (r.result === "written" && r.decision === "AVVIS") totals.avvis++;
    if (r.result === "written" && r.decision === "KATALOGKLASSE") totals.katalogklasse++;
  }
  console.log(
    `[${opts.logTag ?? "dental-triage-judgements"}] run_id=${logSafe(runId, DENTAL_TRIAGE_JUDGEMENT_MAX_RUN_ID_CHARS)} ` +
      results
        .map((r) => `${logSafe(r.agent_id, DENTAL_TRIAGE_JUDGEMENT_MAX_ID_CHARS)}=${r.result}${r.reason ? ":" + r.reason : ""}${r.decision ? ":" + r.decision : ""}`)
        .join(" "),
  );
  return { ok: true, totals, results };
}

// ── The job tick on the shared file queue ───────────────────────────────

export interface DentalTriageJudgementJobDeps extends Omit<ProposalQueueDeps, "apply" | "homepageFetchImpl" | "expDb"> {
  /** The dental DB (the rows + the queue's ledger tables). */
  db?: Database.Database;
  /** Override the write-pause check inside apply (tests). Defaults to the
   *  dental pause on `mainDb` (or the main DB). */
  pauseBlock?: () => EnrichmentWritePausedBody | null;
}

/** Test hook: forget that today's dropped-count line was logged. */
export function __resetDentalTriageJudgementsDroppedLogForTesting(): void {
  __resetProposalQueueDroppedLogForTesting(DENTAL_TRIAGE_JUDGEMENTS_DIR);
}

function configFor(pauseBlock: () => EnrichmentWritePausedBody | null): ProposalQueueConfig {
  const queueApply: ProposalApplyFn = async (dentalDb, items, opts) =>
    applyDentalTriageJudgements(dentalDb, items, {
      createdAt: opts.fileContext?.created_at,
      runId: opts.fileContext?.run_id,
      now: opts.now,
      logTag: opts.logTag,
      pauseBlock,
    }) as unknown as Awaited<ReturnType<ProposalApplyFn>>;
  return {
    dir: DENTAL_TRIAGE_JUDGEMENTS_DIR,
    agent: DENTAL_TRIAGE_JUDGEMENT_AGENT,
    logTag: "dental-triage-judgements",
    userAgent: "lokal-dental-triage-judgement-job",
    filesTable: DENTAL_TRIAGE_JUDGEMENT_FILES_TABLE,
    failuresTable: DENTAL_TRIAGE_JUDGEMENT_FAILURES_TABLE,
    enabled: dentalTriageJudgementJobEnabled,
    validate: (parsed) => validateDentalTriageJudgementFile(parsed),
    apply: queueApply,
    filesPerTick: DENTAL_TRIAGE_JUDGEMENT_FILES_PER_TICK,
    maxFilesPerDay: DENTAL_TRIAGE_JUDGEMENT_MAX_FILES_PER_DAY,
    maxAttemptsPerTick: DENTAL_TRIAGE_JUDGEMENT_MAX_ATTEMPTS_PER_TICK,
    maxFileBytes: DENTAL_TRIAGE_JUDGEMENT_MAX_FILE_BYTES,
    maxAgeDays: PROPOSAL_QUEUE_MAX_AGE_DAYS,
    pauseVertical: "dental",
    ledgerVertical: "dental",
    writtenId: (r) => (r.result === "written" && typeof r.agent_id === "string" ? r.agent_id : null),
    claims: ({ written, processed, totals }) => [
      { type: "db_state_change", value: written, meta: { kind: "dental_triage_judgements_applied", source: "dental_triage_judgement_job" } },
      { type: "db_state_change", value: processed, meta: { kind: "dental_triage_judgements_processed" } },
      { type: "db_state_change", value: totals.avvis ?? 0, meta: { kind: "dental_triage_judgements_rejected_rows", source: "dental_triage_judgement_job" } },
    ],
    extraEvidence: [{ claimIdx: 2, id: (r) => (r.result === "written" && r.decision === "AVVIS" && typeof r.agent_id === "string" ? r.agent_id : null) }],
  };
}

/** One tick. Never throws for an expected failure — the report says what
 *  happened; index.ts still wraps it in a try/catch. */
export async function tickDentalTriageJudgements(
  deps: DentalTriageJudgementJobDeps = {},
): Promise<ProposalQueueTickReport> {
  const { db, pauseBlock, ...rest } = deps;
  const env = deps.env ?? process.env;
  const mainDb = deps.mainDb ?? getMainDbDefault;
  const pause = pauseBlock ?? (() => enrichmentWritePauseBlock(mainDb, "dental"));
  // The flag is checked by the queue before any DB is touched; only resolve
  // the dental DB when the tick can do something.
  const dentalDb = db ?? (dentalTriageJudgementJobEnabled(env) ? (getDentalDbFactory("dental") as unknown as Database.Database) : undefined);
  // No homepage fetch seam: this lane never fetches anything but GitHub.
  const noFetch = (async () => {
    throw new Error("dental-triage-judgement-job never fetches outside api.github.com");
  }) as unknown as typeof fetch;
  return runProposalFileQueueTick(configFor(pause), { ...rest, expDb: dentalDb, homepageFetchImpl: noFetch });
}

/** Read-only status for GET /admin/dental/triage/judgement-status. */
export function getDentalTriageJudgementsStatus(
  db: Database.Database,
  env: Record<string, string | undefined> = process.env,
  opts: { mainDb?: () => Database.Database; now?: Date } = {},
): {
  enabled: boolean;
  token_present: boolean;
  files: Array<{ path: string; sha: string; processed_at: string; status: string | null; error: string | null; totals: unknown }>;
} & ProposalQueueExtras {
  const enabled = dentalTriageJudgementJobEnabled(env);
  const token_present = (env.A2A_READ_PAT ?? "").trim() !== "";
  return {
    enabled,
    token_present,
    ...getProposalQueueExtras(
      db,
      {
        filesTable: DENTAL_TRIAGE_JUDGEMENT_FILES_TABLE,
        failuresTable: DENTAL_TRIAGE_JUDGEMENT_FAILURES_TABLE,
        agent: DENTAL_TRIAGE_JUDGEMENT_AGENT,
        enabled,
        tokenPresent: token_present,
      },
      opts,
    ),
    files: getProposalQueueStatus(db, DENTAL_TRIAGE_JUDGEMENT_FILES_TABLE),
  };
}

// ── Candidates (read-only) ──────────────────────────────────────────────

export interface DentalTriageJudgeCandidate {
  id: string;
  name: string;
  poststed: string | null;
  postnummer: string | null;
  homepage: string | null;
  directory_url: string | null;
  org_nr: string | null;
  catalog_class: string | null;
  review_reason: string | null;
  review_since: string | null;
  /** Latest slice 3c-1 audit outcome for the row, if any. */
  triage_last: { status: string; reason: string | null; checked_at: string | null } | null;
}

/**
 * Rows in the 3c triage state, those 3c-1 left 'undecided' first, then
 * oldest review_since. A row with an applied judgement (avvis/katalogklasse)
 * inside DENTAL_TRIAGE_JUDGEMENT_RECHECK_DAYS is left out, so a corrected
 * class is not re-offered before 3c-1 has had a pass at it. Read-only;
 * `limit` clamped to 1..50.
 */
export function selectDentalTriageJudgeCandidates(db: Database.Database, rawLimit: unknown): { limit: number; rows: DentalTriageJudgeCandidate[] } {
  const limit = clampDentalTriageLimit(rawLimit, DENTAL_TRIAGE_JUDGE_CANDIDATES_DEFAULT_LIMIT);
  const rows = db
    .prepare(
      `SELECT id, navn, poststed, postnummer, hjemmeside, directory_url, org_nr, catalog_class, review_reason, review_since,
              t.status AS triage_status, t.notes AS triage_reason, t.checked_at AS triage_checked_at
         FROM dental_agents
         LEFT JOIN (
               SELECT agent_id, status, notes, checked_at,
                      ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY checked_at DESC, rowid DESC) AS rn
                 FROM dental_verifier_findings
                WHERE check_type = ?
              ) t ON t.agent_id = dental_agents.id AND t.rn = 1
        WHERE ${DENTAL_TRIAGE_CANDIDATE_STATE_SQL}
          AND NOT EXISTS (
                SELECT 1 FROM dental_verifier_findings j
                 WHERE j.agent_id = dental_agents.id
                   AND j.check_type = ?
                   AND j.status IN ('avvis', 'katalogklasse')
                   AND j.checked_at > datetime('now', ?))
        ORDER BY CASE WHEN t.status = 'undecided' THEN 0 ELSE 1 END ASC,
                 COALESCE(review_since, '9999') ASC, id ASC
        LIMIT ?`,
    )
    .all(
      DENTAL_TRIAGE_CHECK_TYPE,
      ...DENTAL_TRIAGE_REVIEW_REASONS,
      DENTAL_TRIAGE_JUDGEMENT_CHECK_TYPE,
      `-${DENTAL_TRIAGE_JUDGEMENT_RECHECK_DAYS} days`,
      limit,
    ) as Array<{
      id: string; navn: string; poststed: string | null; postnummer: string | null; hjemmeside: string | null;
      directory_url: string | null; org_nr: string | null; catalog_class: string | null;
      review_reason: string | null; review_since: string | null;
      triage_status: string | null; triage_reason: string | null; triage_checked_at: string | null;
    }>;
  return {
    limit,
    rows: rows.map((r) => ({
      id: r.id,
      name: r.navn,
      poststed: r.poststed,
      postnummer: r.postnummer,
      homepage: r.hjemmeside,
      directory_url: r.directory_url,
      org_nr: r.org_nr,
      catalog_class: r.catalog_class,
      review_reason: r.review_reason,
      review_since: r.review_since,
      triage_last: r.triage_status ? { status: r.triage_status, reason: r.triage_reason, checked_at: r.triage_checked_at } : null,
    })),
  };
}
