// ─── Experience description proposals job ────────────────────────────────
//
// dev-request 2026-10-07-experiences-beskrivelser-forslagsko-steg2, part B.
//
// WHY. Descriptions for opplevagent experiences are written by a Cloud
// Routine running on Daniel's Max subscription (no API credit): the routine
// GETs the candidate queue, has a generator subagent write the text and an
// independent judge subagent review it, and commits the result as a
// PROPOSAL FILE to the A2A repo — it never POSTs to prod (routines do not
// own recurring prod writes; CLAUDE.md). This job is the server-side half:
// once an hour it reads those files from GitHub and stores them through
// applyPrewrittenExperienceDescriptions() (routes/opplevelser.ts) — the very
// same function POST /admin/experiences-description-write runs, so a
// proposal passes exactly the same gates and is rejected for exactly the
// same reasons. This job NEVER calls an LLM; its only network calls are
// api.github.com (contents API) and, inside the shared function, the
// kildetro homepage fetch.
//
// FILE FORMAT (A2A `experiences-proposals/<UTC-date>/<run-id>.json`):
//   {"schema":"experiences-description-proposals/v1","run_id","created_at",
//    "items":[ …the write endpoint's item shape… ]}
// max 25 items, max 10 kildetro write items (enforced by the shared
// function's own structural validation).
//
// GUARDS, in order, each a no-op tick (nothing fetched, nothing recorded):
//   1. EXPERIENCE_PROPOSALS_JOB_ENABLED === "true" (OFF by default — the
//      rollback is flipping it off).
//   2. The experiences enrichment write-pause (same fence as the endpoint).
//   3. A2A_READ_PAT present (read-only token; missing -> one log line).
//
// ONCE PER FILE. experience_description_proposal_files (init-experiences.ts)
// records every processed path; a recorded path is skipped forever, even if
// its sha changed (logged — a changed proposal must use a new name). A file
// is recorded only AFTER it was fetched and evaluated (applied, or rejected
// as invalid); a GitHub error/timeout on ONE file records nothing final —
// it bumps that path's fail_count (experience_description_proposal_failures)
// and the tick moves on to the next file, so one broken file never blocks
// the queue (review B2). After EXPERIENCE_PROPOSALS_MAX_FAILURES (3) the
// file is recorded as a permanent error. An exception from the apply step
// counts the same way. A failing ROOT listing aborts the tick (nothing to
// iterate); when every GitHub call of a tick failed, one `failed` envelope
// is written per UTC day.
//
// SIZE. Proposal files are tiny (≤25 short items). A file whose listed
// `size` — or decoded content — exceeds EXPERIENCE_PROPOSALS_MAX_FILE_BYTES
// (64 KB) is recorded as a permanent error WITHOUT being fetched/parsed;
// there is no raw download_url fallback (review B1). Re-applying after a crash between apply and record is safe:
// a written row is no longer a candidate (rejected not_candidate), and a
// skip item just refreshes its attempt row.
//
// BUDGET. At most EXPERIENCE_PROPOSALS_FILES_PER_TICK (2) unprocessed files
// per tick, oldest date directory first, file names ascending within a
// date; only date directories from the last 14 UTC days are listed.

import type Database from "better-sqlite3";
import type { PrewrittenExperienceDescriptionsResult } from "../routes/opplevelser";
import {
  PROPOSAL_QUEUE_FILES_PER_TICK,
  PROPOSAL_QUEUE_MAX_AGE_DAYS,
  PROPOSAL_QUEUE_MAX_ATTEMPTS_PER_TICK,
  PROPOSAL_QUEUE_MAX_FAILURES,
  PROPOSAL_QUEUE_MAX_FILE_BYTES,
  PROPOSAL_QUEUE_REPO,
  PROPOSAL_QUEUE_REQUEST_TIMEOUT_MS,
  __resetProposalQueueDroppedLogForTesting,
  getProposalQueueStatus,
  getProposalQueueExtras,
  type ProposalQueueExtras,
  proposalDateIsRecent,
  runProposalFileQueueTick,
  type ProposalApplyFn,
  type ProposalFileOutcome,
  type ProposalQueueConfig,
  type ProposalQueueDeps,
  type ProposalQueueTickReport,
} from "./proposal-file-queue";

// MECHANICS (listing, once-per-file ledger, failure cap, size cap, window,
// envelope) now live in services/proposal-file-queue.ts — extracted verbatim
// when the gårdssalg visit-text proposals lane (tillegg 2026-10-15
// «4b-forslag») became the second caller. This module keeps what is specific
// to description proposals: the directory, the schema, the ledger tables,
// the agent name, the apply function and the envelope's claim kinds.

export const EXPERIENCE_PROPOSALS_SCHEMA = "experiences-description-proposals/v1";
export const EXPERIENCE_PROPOSALS_REPO = PROPOSAL_QUEUE_REPO;
export const EXPERIENCE_PROPOSALS_DIR = "experiences-proposals";
export const EXPERIENCE_PROPOSALS_MAX_AGE_DAYS = PROPOSAL_QUEUE_MAX_AGE_DAYS;
export const EXPERIENCE_PROPOSALS_FILES_PER_TICK = PROPOSAL_QUEUE_FILES_PER_TICK;
export const EXPERIENCE_PROPOSALS_REQUEST_TIMEOUT_MS = PROPOSAL_QUEUE_REQUEST_TIMEOUT_MS;
export const EXPERIENCE_PROPOSALS_AGENT = "experience-proposals-job";
export const EXPERIENCE_PROPOSALS_MAX_FILE_BYTES = PROPOSAL_QUEUE_MAX_FILE_BYTES;
export const EXPERIENCE_PROPOSALS_MAX_FAILURES = PROPOSAL_QUEUE_MAX_FAILURES;
/** Fetch attempts per tick (successes + per-file failures) — bounds the
 *  tick's runtime when several files fail in a row. */
export const EXPERIENCE_PROPOSALS_MAX_ATTEMPTS_PER_TICK = PROPOSAL_QUEUE_MAX_ATTEMPTS_PER_TICK;

type ApplyFn = (
  db: Database.Database,
  rawItems: unknown,
  opts: { dryRun: boolean; homepageFetchImpl: typeof fetch; logTag?: string },
) => Promise<PrewrittenExperienceDescriptionsResult>;

export interface ExperienceProposalsJobDeps extends Omit<ProposalQueueDeps, "apply"> {
  /** The shared apply function; defaults to the one in routes/opplevelser. */
  apply?: ApplyFn;
}

export type ExperienceProposalFileOutcome = ProposalFileOutcome;
export type ExperienceProposalsTickReport = ProposalQueueTickReport;

export function experienceProposalsJobEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EXPERIENCE_PROPOSALS_JOB_ENABLED === "true";
}

/** UTC date dirs (YYYY-MM-DD) within the last `maxAgeDays` days, today
 *  included; anything else (non-date names, older, malformed) is ignored. */
export function experienceProposalsDateIsRecent(name: string, now: Date, maxAgeDays = EXPERIENCE_PROPOSALS_MAX_AGE_DAYS): boolean {
  return proposalDateIsRecent(name, now, maxAgeDays);
}

/** Structural check of a parsed proposal file. Item-level validation is the
 *  shared apply function's (same limits as the endpoint). */
export function validateExperienceProposalFile(parsed: unknown): { items: unknown[] } | { error: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "file is not a JSON object" };
  const p = parsed as Record<string, unknown>;
  if (p.schema !== EXPERIENCE_PROPOSALS_SCHEMA) return { error: `schema must be "${EXPERIENCE_PROPOSALS_SCHEMA}"` };
  if (!Array.isArray(p.items)) return { error: "items must be an array" };
  return { items: p.items };
}

/** Test hook: forget that today's dropped-count line was logged. */
export function __resetExperienceProposalsDroppedLogForTesting(): void {
  __resetProposalQueueDroppedLogForTesting(EXPERIENCE_PROPOSALS_DIR);
}

async function defaultApply(): Promise<ApplyFn> {
  return (await import("../routes/opplevelser")).applyPrewrittenExperienceDescriptions as unknown as ApplyFn;
}

function configFor(apply: ApplyFn): ProposalQueueConfig {
  return {
    dir: EXPERIENCE_PROPOSALS_DIR,
    agent: EXPERIENCE_PROPOSALS_AGENT,
    logTag: "experience-proposals",
    userAgent: "lokal-experience-proposals-job",
    filesTable: "experience_description_proposal_files",
    failuresTable: "experience_description_proposal_failures",
    enabled: experienceProposalsJobEnabled,
    validate: validateExperienceProposalFile,
    apply: apply as unknown as ProposalApplyFn,
    writtenId: (r) => (r.result === "written" && typeof r.id === "string" ? r.id : null),
    claims: ({ written, processed }) => [
      { type: "db_state_change", value: written, meta: { kind: "experiences_content_enriched", source: "proposals_job" } },
      { type: "db_state_change", value: processed, meta: { kind: "proposals_processed" } },
    ],
  };
}

/** One tick. Never throws for an expected failure — the report says what
 *  happened; index.ts still wraps it in a try/catch. */
export async function tickExperienceDescriptionProposals(
  deps: ExperienceProposalsJobDeps = {},
): Promise<ExperienceProposalsTickReport> {
  const { apply, ...rest } = deps;
  // The flag/pause/token guards run inside the shared tick; resolve the
  // default apply lazily so a disabled tick never loads the route module.
  const env = deps.env ?? process.env;
  const applyFn = apply ?? (experienceProposalsJobEnabled(env) ? await defaultApply() : (null as unknown as ApplyFn));
  return runProposalFileQueueTick(configFor(applyFn), rest);
}

/** Read-only status for GET /admin/experiences-description-proposals-status. */
export function getExperienceDescriptionProposalsStatus(
  expDb: Database.Database,
  env: Record<string, string | undefined> = process.env,
  opts: { mainDb?: () => Database.Database; now?: Date } = {},
): {
  enabled: boolean;
  token_present: boolean;
  files: Array<{ path: string; sha: string; processed_at: string; status: string | null; error: string | null; totals: unknown }>;
} & ProposalQueueExtras {
  const enabled = experienceProposalsJobEnabled(env);
  const token_present = (env.A2A_READ_PAT ?? "").trim() !== "";
  return {
    enabled,
    token_present,
    ...getProposalQueueExtras(expDb, { filesTable: "experience_description_proposal_files", failuresTable: "experience_description_proposal_failures", agent: EXPERIENCE_PROPOSALS_AGENT, enabled, tokenPresent: token_present }, opts),
    files: getProposalQueueStatus(expDb, "experience_description_proposal_files"),
  };
}
