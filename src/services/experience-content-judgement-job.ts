// ─── Experience content-judgement job (needs_review content judge) ───────
//
// A2A dev-request 2026-10-06-experiences-enrichment-plattformjobb-og-felles-
// serverjobbramme, «Innsnevring 2026-10-28», skive 3k med punkt b.
//
// WHY. POST /admin/experiences-content-judge-sweep (routes/opplevelser.ts)
// re-judges experience rows against their evidence_url with an LLM judge
// called by THIS server. Daniel's rule (Endring 2026-10-08): a platform job
// never calls an LLM. The judging is done by Claude Code on Daniel's
// subscription (a Cloud Routine, read-only against prod — routines never
// POST to prod): it GETs /admin/experiences-content-judge-candidates (public
// catalog fields only), opens each evidence_url itself, renders match /
// mismatch, and commits the verdicts as a JSON file to the A2A repo. This
// job is the server-side half: once an hour it reads those files from
// GitHub (the shared proposal file queue, services/proposal-file-queue.ts)
// and stores them through applyExperienceContentJudgements()
// (routes/opplevelser.ts), which re-checks every item deterministically
// before writing and writes through the SAME evaluateContentJudgePromotion()
// / writeContentJudgeVerdict() the sweep route uses — so a client verdict
// can never promote, demote or stamp a row differently than the sweep
// would. NEVER calls an LLM: its only network calls are api.github.com.
//
// FILE FORMAT (A2A `experiences-content-judgements/<UTC-date>/<run-id>.json`):
//   {"schema":"experiences-content-judgements/v1","run_id","created_at",
//    "items":[{"id","evidence_url","verdict":"match"|"mismatch","reasoning"}]}
// File-level (the whole file is recorded as an error, nothing written):
// not an object, wrong schema, missing run_id, created_at not an ISO-8601
// timestamp with a zone or in the future, items not an array of 1..50
// objects each with a non-empty string id, duplicate ids. Item-level
// (that item rejected, the rest applied): unknown verdict, missing
// evidence_url, missing/over-long (>500 chars) reasoning.
//
// SERVER RE-CHECKS per item, inside that item's own transaction, before any
// write: the experiences write-pause; the row exists; it is still eligible
// (SWEEP_ELIGIBLE_WHERE) and in scope (SWEEP_IN_SCOPE_WHERE); the item's
// evidence_url equals the row's current evidence_url (else
// `evidence_changed`); the row's admission_checked_at is not newer than the
// file's created_at (else `stale_verdict` — a newer judgement already
// exists); the row's updated_at is not newer than created_at either (else
// `content_changed` — the verdict judged content that has since changed).
// The writes mirror the sweep exactly: mismatch -> needs_review + stamp
// "mismatch: …"; match -> stamp "match: …", and the quarantine-exit
// promotion ONLY when all four existing requirements hold (was needs_review
// going in, confidence high/medium, provider brreg_active=1, verified
// source) — the client's verdict is only the "judge" requirement and never
// promotes on its own. Promotions are audited under a per-file batch_id, so
// POST /admin/experiences-admission-promotion-rollback reverts them exactly
// like a sweep batch.
//
// NOT IN THIS JOB: the sweep's boilerplate-description nulling. It needs the
// evidence page's visible text, which this job deliberately never fetches;
// it stays a sweep-only step. The sweep writes no owner-content field
// besides that nulling (verification_status + admission_verdict only), so
// there is no locked-field write here to guard.
//
// GUARDS, each a no-op tick: EXPERIENCE_CONTENT_JUDGEMENT_JOB_ENABLED ===
// "true" (OFF by default — flipping it off is the rollback); the
// experiences write-pause; A2A_READ_PAT present.
//
// BUDGET (punkt b). The candidate GET may serve up to 4 batches of 50 rows,
// so a routine run can produce up to 4 files; this queue therefore takes up
// to 4 files per tick (8 fetch attempts, twice the default, keeping the
// same failures-per-file headroom). Each file is ≤50 items with no network
// call per item, so a tick stays well inside the default time budget.

import type Database from "better-sqlite3";
import type { ExperienceContentJudgementsResult } from "../routes/opplevelser";
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

export const EXPERIENCE_CONTENT_JUDGEMENTS_SCHEMA = "experiences-content-judgements/v1";
export const EXPERIENCE_CONTENT_JUDGEMENTS_DIR = "experiences-content-judgements";
export const EXPERIENCE_CONTENT_JUDGEMENT_AGENT = "experiences-content-judgement-job";
export const EXPERIENCE_CONTENT_JUDGEMENTS_MAX_ITEMS = 50;
export const EXPERIENCE_CONTENT_JUDGEMENTS_MAX_REASONING_CHARS = 500;
export const EXPERIENCE_CONTENT_JUDGEMENT_FILES_PER_TICK = 4;
export const EXPERIENCE_CONTENT_JUDGEMENT_MAX_ATTEMPTS_PER_TICK = 8;
/** 50 items × (≤500-char reasoning, up to 2 bytes/char in Norwegian, + id
 *  and url) stays under this; the default 64 KB could reject a full file. */
export const EXPERIENCE_CONTENT_JUDGEMENT_MAX_FILE_BYTES = 128 * 1024;
export const EXPERIENCE_CONTENT_JUDGEMENT_FILES_TABLE = "experience_content_judgement_files";
export const EXPERIENCE_CONTENT_JUDGEMENT_FAILURES_TABLE = "experience_content_judgement_failures";

/** ISO-8601 with an explicit zone — no local-time ambiguity in the
 *  stale-verdict comparison. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function experienceContentJudgementJobEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EXPERIENCE_CONTENT_JUDGEMENT_JOB_ENABLED === "true";
}

/** File-level structural check. Item-level structure (objects with ids, no
 *  duplicates, 1..50) and content are the shared apply function's. */
export function validateExperienceContentJudgementFile(
  parsed: unknown,
): { items: unknown[]; context: { run_id: string; created_at: string } } | { error: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "file is not a JSON object" };
  const p = parsed as Record<string, unknown>;
  if (p.schema !== EXPERIENCE_CONTENT_JUDGEMENTS_SCHEMA) return { error: `schema must be "${EXPERIENCE_CONTENT_JUDGEMENTS_SCHEMA}"` };
  if (typeof p.run_id !== "string" || p.run_id.trim() === "") return { error: "run_id must be a non-empty string" };
  if (typeof p.created_at !== "string" || !ISO_WITH_ZONE.test(p.created_at) || !Number.isFinite(Date.parse(p.created_at))) {
    return { error: "created_at must be an ISO-8601 timestamp with a zone (e.g. 2026-11-01T10:00:00Z)" };
  }
  if (!Array.isArray(p.items)) return { error: "items must be an array" };
  return { items: p.items, context: { run_id: p.run_id.trim(), created_at: p.created_at } };
}

type ApplyFn = (
  db: Database.Database,
  rawItems: unknown,
  opts: { createdAt: unknown; runId?: unknown; now?: Date; logTag?: string },
) => Promise<ExperienceContentJudgementsResult>;

export interface ExperienceContentJudgementJobDeps extends Omit<ProposalQueueDeps, "apply" | "homepageFetchImpl"> {
  /** The shared apply function; defaults to the one in routes/opplevelser. */
  apply?: ApplyFn;
}

/** Test hook: forget that today's dropped-count line was logged. */
export function __resetExperienceContentJudgementsDroppedLogForTesting(): void {
  __resetProposalQueueDroppedLogForTesting(EXPERIENCE_CONTENT_JUDGEMENTS_DIR);
}

async function defaultApply(): Promise<ApplyFn> {
  return (await import("../routes/opplevelser")).applyExperienceContentJudgements as unknown as ApplyFn;
}

function configFor(apply: ApplyFn): ProposalQueueConfig {
  const queueApply: ProposalApplyFn = async (expDb, items, opts) =>
    (await apply(expDb, items, {
      createdAt: opts.fileContext?.created_at,
      runId: opts.fileContext?.run_id,
      now: opts.now,
      logTag: opts.logTag,
    })) as unknown as Awaited<ReturnType<ProposalApplyFn>>;
  return {
    dir: EXPERIENCE_CONTENT_JUDGEMENTS_DIR,
    agent: EXPERIENCE_CONTENT_JUDGEMENT_AGENT,
    logTag: "experience-content-judgements",
    userAgent: "lokal-experience-content-judgement-job",
    filesTable: EXPERIENCE_CONTENT_JUDGEMENT_FILES_TABLE,
    failuresTable: EXPERIENCE_CONTENT_JUDGEMENT_FAILURES_TABLE,
    enabled: experienceContentJudgementJobEnabled,
    validate: validateExperienceContentJudgementFile,
    apply: queueApply,
    filesPerTick: EXPERIENCE_CONTENT_JUDGEMENT_FILES_PER_TICK,
    maxAttemptsPerTick: EXPERIENCE_CONTENT_JUDGEMENT_MAX_ATTEMPTS_PER_TICK,
    maxFileBytes: EXPERIENCE_CONTENT_JUDGEMENT_MAX_FILE_BYTES,
    maxAgeDays: PROPOSAL_QUEUE_MAX_AGE_DAYS,
    writtenId: (r) => (r.result === "written" && typeof r.id === "string" ? r.id : null),
    claims: ({ written, processed, totals }) => [
      { type: "db_state_change", value: written, meta: { kind: "content_judgements_applied", source: "content_judgement_job" } },
      { type: "db_state_change", value: processed, meta: { kind: "content_judgements_processed" } },
      { type: "db_state_change", value: totals.promoted ?? 0, meta: { kind: "needs_review_judge_sweep_promoted", source: "content_judgement_job" } },
    ],
    extraEvidence: [{ claimIdx: 2, id: (r) => (r.result === "written" && r.promoted === true && typeof r.id === "string" ? r.id : null) }],
  };
}

/** One tick. Never throws for an expected failure — the report says what
 *  happened; index.ts still wraps it in a try/catch. */
export async function tickExperienceContentJudgements(
  deps: ExperienceContentJudgementJobDeps = {},
): Promise<ProposalQueueTickReport> {
  const { apply, ...rest } = deps;
  // The flag/pause/token guards run inside the shared tick; resolve the
  // default apply lazily so a disabled tick never loads the route module.
  const env = deps.env ?? process.env;
  const applyFn = apply ?? (experienceContentJudgementJobEnabled(env) ? await defaultApply() : (null as unknown as ApplyFn));
  // No homepage fetch seam: this lane never fetches anything but GitHub.
  // The queue's homepage seam is pinned to a function that throws, so a
  // future change that tried to fetch through it would fail loudly.
  const noFetch = (async () => {
    throw new Error("experience-content-judgement-job never fetches outside api.github.com");
  }) as unknown as typeof fetch;
  return runProposalFileQueueTick(configFor(applyFn), { ...rest, homepageFetchImpl: noFetch });
}

/** Read-only status for GET /admin/experiences-content-judgements-status. */
export function getExperienceContentJudgementsStatus(
  expDb: Database.Database,
  env: Record<string, string | undefined> = process.env,
  opts: { mainDb?: () => Database.Database; now?: Date } = {},
): {
  enabled: boolean;
  token_present: boolean;
  files: Array<{ path: string; sha: string; processed_at: string; status: string | null; error: string | null; totals: unknown }>;
} & ProposalQueueExtras {
  const enabled = experienceContentJudgementJobEnabled(env);
  const token_present = (env.A2A_READ_PAT ?? "").trim() !== "";
  return {
    enabled,
    token_present,
    ...getProposalQueueExtras(
      expDb,
      {
        filesTable: EXPERIENCE_CONTENT_JUDGEMENT_FILES_TABLE,
        failuresTable: EXPERIENCE_CONTENT_JUDGEMENT_FAILURES_TABLE,
        agent: EXPERIENCE_CONTENT_JUDGEMENT_AGENT,
        enabled,
        tokenPresent: token_present,
      },
      opts,
    ),
    files: getProposalQueueStatus(expDb, EXPERIENCE_CONTENT_JUDGEMENT_FILES_TABLE),
  };
}
