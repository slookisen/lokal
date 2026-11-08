// ─── Experience catalogue facts proposals job (S3b) ──────────────────────
//
// A2A dev-request 2026-10-16-opplevagent-katalogfakta-alder-og-title-no,
// slice S3b. The third user of the proposal-file queue, and the server-side
// half of the catalogue facts lane whose write path shipped in S3a:
//
//   1. GET /admin/experience-facts-candidates (lokal, read-only, S3a): the
//      published in-scope experiences with ≥1 empty fact field, plus the
//      page text the server will later check against.
//   2. A Cloud Routine on Daniel's subscription (not part of this slice)
//      proposes values with a VERBATIM excerpt per (experience, field) and
//      commits them to slookisen/A2A as
//      `experiences-facts-proposals/<UTC-date>/<run-id>.json`. The routine
//      never POSTs to prod.
//   3. THIS JOB (hourly, no LLM): reads those files and stores them through
//      applyExperienceFactsProposals() (routes/opplevelser.ts) — the very
//      same function POST /admin/experience-facts-write runs — so every
//      item passes exactly the same deterministic S3a gates unchanged:
//      field registry (FACT_VALIDATORS), row in scope + published (re-
//      checked per item and again inside the write transaction), owner
//      locks, fill-only, excerpt length + per-field validator, verified
//      non-shared hjemmeside, source_url on that host, the server's own
//      SSRF-guarded fetch with the excerpt required verbatim in the page.
//
// Everything about files, the once-per-file ledger, failure caps, the
// 14-day window, the 64 KB file cap and the envelope is
// services/proposal-file-queue.ts (shared with the description and
// gårdssalg visit proposals jobs). This module is only the configuration
// of that queue for catalogue facts.
//
// Guards: EXPERIENCE_FACTS_PROPOSALS_JOB_ENABLED === "true" (OFF by default
// — the rollback), the experiences write-pause, A2A_READ_PAT.

import type Database from "better-sqlite3";
import {
  __resetProposalQueueDroppedLogForTesting,
  getProposalQueueStatus,
  getProposalQueueExtras,
  type ProposalQueueExtras,
  runProposalFileQueueTick,
  type ProposalApplyFn,
  type ProposalQueueConfig,
  type ProposalQueueDeps,
  type ProposalQueueTickReport,
} from "./proposal-file-queue";

export const EXPERIENCE_FACTS_PROPOSALS_SCHEMA = "experiences-facts-proposals/v1";
export const EXPERIENCE_FACTS_PROPOSALS_DIR = "experiences-facts-proposals";
export const EXPERIENCE_FACTS_PROPOSALS_AGENT = "experience-facts-proposals-job";
export const EXPERIENCE_FACTS_PROPOSALS_FILES_TABLE = "experience_facts_proposal_files";
export const EXPERIENCE_FACTS_PROPOSALS_FAILURES_TABLE = "experience_facts_proposal_failures";

export type ExperienceFactsProposalsJobDeps = ProposalQueueDeps;
export type ExperienceFactsProposalsTickReport = ProposalQueueTickReport;

export function experienceFactsProposalsJobEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EXPERIENCE_FACTS_PROPOSALS_JOB_ENABLED === "true";
}

/** Structural check of a parsed proposal file. Item-level validation is the
 *  shared apply function's (same limits as the write endpoint, including
 *  its 1..25 items cap). */
export function validateExperienceFactsProposalFile(parsed: unknown): { items: unknown[] } | { error: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "file is not a JSON object" };
  const p = parsed as Record<string, unknown>;
  if (p.schema !== EXPERIENCE_FACTS_PROPOSALS_SCHEMA) return { error: `schema must be "${EXPERIENCE_FACTS_PROPOSALS_SCHEMA}"` };
  if (!Array.isArray(p.items)) return { error: "items must be an array" };
  return { items: p.items };
}

/** Test hook: forget that today's dropped-count line was logged. */
export function __resetExperienceFactsProposalsDroppedLogForTesting(): void {
  __resetProposalQueueDroppedLogForTesting(EXPERIENCE_FACTS_PROPOSALS_DIR);
}

async function defaultApply(): Promise<ProposalApplyFn> {
  const mod = await import("../routes/opplevelser");
  return ((_expDb, items, opts) => mod.applyExperienceFactsProposals(items, { dryRun: opts.dryRun, fetchImpl: opts.homepageFetchImpl, logTag: opts.logTag })) as ProposalApplyFn;
}

function configFor(apply: ProposalApplyFn): ProposalQueueConfig {
  return {
    dir: EXPERIENCE_FACTS_PROPOSALS_DIR,
    agent: EXPERIENCE_FACTS_PROPOSALS_AGENT,
    logTag: "experience-facts-proposals",
    filesTable: EXPERIENCE_FACTS_PROPOSALS_FILES_TABLE,
    failuresTable: EXPERIENCE_FACTS_PROPOSALS_FAILURES_TABLE,
    enabled: experienceFactsProposalsJobEnabled,
    validate: validateExperienceFactsProposalFile,
    apply,
    writtenId: (r) => (r.result === "written" && typeof r.id === "string" ? r.id : null),
    claims: ({ written, processed }) => [
      { type: "db_state_change", value: written, meta: { kind: "published_profile_fact_filled", source: "facts_proposals_job", llm: false } },
      { type: "db_state_change", value: processed, meta: { kind: "facts_proposals_processed" } },
    ],
  };
}

/** One tick. Never throws for an expected failure — the report says what
 *  happened; index.ts still wraps it in a try/catch. */
export async function tickExperienceFactsProposals(
  deps: ExperienceFactsProposalsJobDeps = {},
): Promise<ExperienceFactsProposalsTickReport> {
  const env = deps.env ?? process.env;
  const apply = deps.apply ?? (experienceFactsProposalsJobEnabled(env) ? await defaultApply() : (null as unknown as ProposalApplyFn));
  const { apply: _ignored, ...rest } = deps;
  return runProposalFileQueueTick(configFor(apply), rest);
}

/** Read-only status for GET /admin/experience-facts-proposals-status. */
export function getExperienceFactsProposalsStatus(
  expDb: Database.Database,
  env: Record<string, string | undefined> = process.env,
  opts: { mainDb?: () => Database.Database; now?: Date } = {},
): {
  enabled: boolean;
  token_present: boolean;
  schema: string;
  dir: string;
  files: Array<{ path: string; sha: string; processed_at: string; status: string | null; error: string | null; totals: unknown }>;
} & ProposalQueueExtras {
  const enabled = experienceFactsProposalsJobEnabled(env);
  const token_present = (env.A2A_READ_PAT ?? "").trim() !== "";
  return {
    enabled,
    token_present,
    ...getProposalQueueExtras(expDb, { filesTable: EXPERIENCE_FACTS_PROPOSALS_FILES_TABLE, failuresTable: EXPERIENCE_FACTS_PROPOSALS_FAILURES_TABLE, agent: EXPERIENCE_FACTS_PROPOSALS_AGENT, enabled, tokenPresent: token_present }, opts),
    schema: EXPERIENCE_FACTS_PROPOSALS_SCHEMA,
    dir: EXPERIENCE_FACTS_PROPOSALS_DIR,
    files: getProposalQueueStatus(expDb, EXPERIENCE_FACTS_PROPOSALS_FILES_TABLE),
  };
}
