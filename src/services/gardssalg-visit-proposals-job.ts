// ─── Gårdssalg visit-text proposals job («4b-forslag») ───────────────────
//
// A2A dev-request 2026-10-06-experiences-enrichment-plattformjobb-og-felles-
// serverjobbramme, tillegg 2026-10-15 (Daniel live: «bygg 4b-forslag nå»).
// The subscription-side half of drink-producer visit texts:
//
//   1. GET /admin/gardssalg-visit-candidates (lokal, read-only): verified
//      drink producers still blank on visit_text, with the SAME crawled
//      page text the server will later check against.
//   2. Claude Code on Daniel's Max subscription (the experiences-enrichment
//      routine): a generator sub-agent writes 1–3 sentences from that text
//      only, an INDEPENDENT judge sub-agent verifies against the same text,
//      and the result is committed to slookisen/A2A as
//      `gardssalg-visit-proposals/<UTC-date>/<run-id>.json`. The routine
//      never POSTs to prod.
//   3. THIS JOB (hourly, no LLM): reads those files and stores them through
//      applyGardssalgVisitProposals() (routes/opplevelser.ts) — the very
//      same function POST /admin/gardssalg-visit-proposals-write runs — so a
//      proposal passes exactly the same deterministic gates: row still
//      eligible, source host = stored homepage host, the server RE-FETCHES
//      the homepage itself and requires every evidence snippet verbatim in
//      it plus ≥ 60 % word overlap, length/format rules, judge.approved,
//      and the existing per-field owner lock inside
//      applyGardssalgProviderContent.
//
// Everything about files, the once-per-file ledger, failure caps, the
// 14-day window and the envelope is services/proposal-file-queue.ts (shared
// with the description proposals job). This module is only the
// configuration of that queue for visit texts.
//
// Guards: GARDSSALG_VISIT_PROPOSALS_JOB_ENABLED === "true" (OFF by default
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

export const GARDSSALG_VISIT_PROPOSALS_SCHEMA = "gardssalg-visit-proposals/v1";
export const GARDSSALG_VISIT_PROPOSALS_DIR = "gardssalg-visit-proposals";
export const GARDSSALG_VISIT_PROPOSALS_AGENT = "gardssalg-visit-proposals-job";
export const GARDSSALG_VISIT_PROPOSALS_FILES_TABLE = "gardssalg_visit_proposal_files";
export const GARDSSALG_VISIT_PROPOSALS_FAILURES_TABLE = "gardssalg_visit_proposal_failures";

export type GardssalgVisitProposalsJobDeps = ProposalQueueDeps;
export type GardssalgVisitProposalsTickReport = ProposalQueueTickReport;

export function gardssalgVisitProposalsJobEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GARDSSALG_VISIT_PROPOSALS_JOB_ENABLED === "true";
}

/** Structural check of a parsed proposal file. Item-level validation is the
 *  shared apply function's (same limits as the write endpoint). */
export function validateGardssalgVisitProposalFile(parsed: unknown): { items: unknown[] } | { error: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "file is not a JSON object" };
  const p = parsed as Record<string, unknown>;
  if (p.schema !== GARDSSALG_VISIT_PROPOSALS_SCHEMA) return { error: `schema must be "${GARDSSALG_VISIT_PROPOSALS_SCHEMA}"` };
  if (!Array.isArray(p.items)) return { error: "items must be an array" };
  return { items: p.items };
}

/** Test hook: forget that today's dropped-count line was logged. */
export function __resetGardssalgVisitProposalsDroppedLogForTesting(): void {
  __resetProposalQueueDroppedLogForTesting(GARDSSALG_VISIT_PROPOSALS_DIR);
}

async function defaultApply(): Promise<ProposalApplyFn> {
  const mod = await import("../routes/opplevelser");
  return ((_expDb, items, opts) => mod.applyGardssalgVisitProposals(items, { dryRun: opts.dryRun, homepageFetchImpl: opts.homepageFetchImpl, logTag: opts.logTag })) as ProposalApplyFn;
}

function configFor(apply: ProposalApplyFn): ProposalQueueConfig {
  return {
    dir: GARDSSALG_VISIT_PROPOSALS_DIR,
    agent: GARDSSALG_VISIT_PROPOSALS_AGENT,
    logTag: "gardssalg-visit-proposals",
    filesTable: GARDSSALG_VISIT_PROPOSALS_FILES_TABLE,
    failuresTable: GARDSSALG_VISIT_PROPOSALS_FAILURES_TABLE,
    enabled: gardssalgVisitProposalsJobEnabled,
    validate: validateGardssalgVisitProposalFile,
    apply,
    writtenId: (r) => (r.result === "written" && typeof r.provider_id === "string" ? r.provider_id : null),
    // The SAME claim kind the drink lane has always used for a written drink
    // row (Grep 1), so the charter/brief/verifier readers keep working;
    // `source` tells the proposals lane apart from the deterministic job.
    claims: ({ written, processed }) => [
      { type: "db_state_change", value: written, meta: { kind: "gardssalg_drink_cohort_enriched", source: "visit_proposals_job", llm: false } },
      { type: "db_state_change", value: processed, meta: { kind: "visit_proposals_processed" } },
    ],
  };
}

/** One tick. Never throws for an expected failure — the report says what
 *  happened; index.ts still wraps it in a try/catch. */
export async function tickGardssalgVisitProposals(
  deps: GardssalgVisitProposalsJobDeps = {},
): Promise<GardssalgVisitProposalsTickReport> {
  const env = deps.env ?? process.env;
  const apply = deps.apply ?? (gardssalgVisitProposalsJobEnabled(env) ? await defaultApply() : (null as unknown as ProposalApplyFn));
  const { apply: _ignored, ...rest } = deps;
  return runProposalFileQueueTick(configFor(apply), rest);
}

/** Read-only status for GET /admin/gardssalg-visit-proposals-status. */
export function getGardssalgVisitProposalsStatus(
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
  const enabled = gardssalgVisitProposalsJobEnabled(env);
  const token_present = (env.A2A_READ_PAT ?? "").trim() !== "";
  return {
    enabled,
    token_present,
    ...getProposalQueueExtras(expDb, { filesTable: GARDSSALG_VISIT_PROPOSALS_FILES_TABLE, failuresTable: GARDSSALG_VISIT_PROPOSALS_FAILURES_TABLE, agent: GARDSSALG_VISIT_PROPOSALS_AGENT, enabled, tokenPresent: token_present }, opts),
    schema: GARDSSALG_VISIT_PROPOSALS_SCHEMA,
    dir: GARDSSALG_VISIT_PROPOSALS_DIR,
    files: getProposalQueueStatus(expDb, GARDSSALG_VISIT_PROPOSALS_FILES_TABLE),
  };
}
