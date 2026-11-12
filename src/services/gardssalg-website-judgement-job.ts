// ─── Gårdssalg website-judgement job (website_discovery_candidate judge) ──
//
// A2A dev-request 2026-10-06-experiences-enrichment-plattformjobb-og-felles-
// serverjobbramme, «Innsnevring 2026-10-28», skive 3j. Same file-queue shape
// as slice 3k (services/experience-content-judgement-job.ts).
//
// WHY. POST /admin/gardssalg-website-review-judge (routes/opplevelser.ts)
// asks an LLM, called by THIS server, whether a discovered website really
// belongs to the producer. Daniel's rule (Endring 2026-10-08): a platform job
// never calls an LLM. A Cloud Routine on his subscription GETs
// /admin/gardssalg-website-judge-candidates (public catalog fields + the
// judge's source_context + the structural-backstop result), judges, and
// commits the verdicts as a JSON file to the A2A repo. This job reads those
// files from GitHub (the shared proposal file queue, services/proposal-file-
// queue.ts) and stores them through applyGardssalgWebsiteJudgements()
// (routes/opplevelser.ts), which re-checks every item deterministically and
// writes through the SAME approve path / reason-append the judge route uses.
// NEVER calls an LLM: its only network calls are api.github.com.
//
// FILE FORMAT (A2A `gardssalg-website-judgements/<UTC-date>/<run-id>.json`):
//   {"schema":"gardssalg-website-judgements/v1","run_id","created_at",
//    "items":[{"provider_id","candidate_url","verdict":"GODKJENN"|"AVVIS","reason"}]}
// File-level (whole file recorded as an error, nothing written): not an
// object, wrong schema, missing run_id, created_at not ISO-8601 with a zone
// or in the future, items not an array of 1..50 objects with a string
// provider_id, duplicate provider_ids. Item-level (that item rejected, rest
// applied): over-long provider_id, unknown verdict, missing/over-long
// candidate_url, missing/over-long (>500 chars) reason.
//
// SERVER RE-CHECKS per item, in order: the experiences write-pause (a pause
// writes nothing for the file; it is retried later); the queue row exists
// with reason website_discovery_candidate and parked_since IS NULL (else
// not_found / not_eligible); confidence inside the judge band (else
// out_of_scope); stored candidate_url equals the item's (else
// candidate_changed); the structural backstop — a defective URL is an AVVIS
// whatever the client said. GODKJENN -> the approve route in-process; AVVIS
// -> "routine judge AVVIS: <reason>" appended to the queue row's reason.
//
// GUARDS, each a no-op tick: GARDSSALG_WEBSITE_JUDGEMENT_JOB_ENABLED ===
// "true" (OFF by default — flipping it off is the rollback); the experiences
// write-pause; A2A_READ_PAT present.
//
// BUDGET. Up to 4 files per tick, at most 8 files per UTC day (≤400 rows).

import type Database from "better-sqlite3";
import type { GardssalgWebsiteJudgementsResult } from "../routes/opplevelser";
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

export const GARDSSALG_WEBSITE_JUDGEMENTS_SCHEMA = "gardssalg-website-judgements/v1";
export const GARDSSALG_WEBSITE_JUDGEMENTS_DIR = "gardssalg-website-judgements";
export const GARDSSALG_WEBSITE_JUDGEMENT_AGENT = "gardssalg-website-judgement-job";
export const GARDSSALG_WEBSITE_JUDGEMENTS_MAX_ITEMS = 50;
export const GARDSSALG_WEBSITE_JUDGEMENTS_MAX_REASON_CHARS = 500;
export const GARDSSALG_WEBSITE_JUDGEMENT_FILES_PER_TICK = 4;
export const GARDSSALG_WEBSITE_JUDGEMENT_MAX_ATTEMPTS_PER_TICK = 8;
/** Per-UTC-day cap on recorded files (≤ 8 × 50 = 400 rows a day). */
export const GARDSSALG_WEBSITE_JUDGEMENT_MAX_FILES_PER_DAY = 8;
export const GARDSSALG_WEBSITE_JUDGEMENT_MAX_ID_CHARS = 64;
export const GARDSSALG_WEBSITE_JUDGEMENT_MAX_URL_CHARS = 2048;
/** 50 items × (≤500-char reason, up to 2 bytes/char, + id and url). */
export const GARDSSALG_WEBSITE_JUDGEMENT_MAX_FILE_BYTES = 128 * 1024;
export const GARDSSALG_WEBSITE_JUDGEMENT_FILES_TABLE = "gardssalg_website_judgement_files";
export const GARDSSALG_WEBSITE_JUDGEMENT_FAILURES_TABLE = "gardssalg_website_judgement_failures";

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** A created_at further ahead of the server clock than this is rejected. */
const MAX_CLOCK_SKEW_MS = 10 * 60_000;

export function gardssalgWebsiteJudgementJobEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GARDSSALG_WEBSITE_JUDGEMENT_JOB_ENABLED === "true";
}

/** File-level structural check; item-level checks are the apply function's. */
export function validateGardssalgWebsiteJudgementFile(
  parsed: unknown,
  now: Date = new Date(),
): { items: unknown[]; context: { run_id: string; created_at: string } } | { error: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "file is not a JSON object" };
  const p = parsed as Record<string, unknown>;
  if (p.schema !== GARDSSALG_WEBSITE_JUDGEMENTS_SCHEMA) return { error: `schema must be "${GARDSSALG_WEBSITE_JUDGEMENTS_SCHEMA}"` };
  if (typeof p.run_id !== "string" || p.run_id.trim() === "") return { error: "run_id must be a non-empty string" };
  if (typeof p.created_at !== "string" || !ISO_WITH_ZONE.test(p.created_at) || !Number.isFinite(Date.parse(p.created_at))) {
    return { error: "created_at must be an ISO-8601 timestamp with a zone (e.g. 2026-11-01T10:00:00Z)" };
  }
  if (Date.parse(p.created_at) > now.getTime() + MAX_CLOCK_SKEW_MS) return { error: "created_at is in the future" };
  if (!Array.isArray(p.items)) return { error: "items must be an array" };
  return { items: p.items, context: { run_id: p.run_id.trim(), created_at: p.created_at } };
}

type ApplyFn = (
  db: Database.Database,
  rawItems: unknown,
  opts: { createdAt?: unknown; runId?: unknown; now?: Date; logTag?: string },
) => Promise<GardssalgWebsiteJudgementsResult>;

export interface GardssalgWebsiteJudgementJobDeps extends Omit<ProposalQueueDeps, "apply" | "homepageFetchImpl"> {
  /** The shared apply function; defaults to the one in routes/opplevelser. */
  apply?: ApplyFn;
}

/** Test hook: forget that today's dropped-count line was logged. */
export function __resetGardssalgWebsiteJudgementsDroppedLogForTesting(): void {
  __resetProposalQueueDroppedLogForTesting(GARDSSALG_WEBSITE_JUDGEMENTS_DIR);
}

async function defaultApply(): Promise<ApplyFn> {
  return (await import("../routes/opplevelser")).applyGardssalgWebsiteJudgements as unknown as ApplyFn;
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
    dir: GARDSSALG_WEBSITE_JUDGEMENTS_DIR,
    agent: GARDSSALG_WEBSITE_JUDGEMENT_AGENT,
    logTag: "gardssalg-website-judgements",
    userAgent: "lokal-gardssalg-website-judgement-job",
    filesTable: GARDSSALG_WEBSITE_JUDGEMENT_FILES_TABLE,
    failuresTable: GARDSSALG_WEBSITE_JUDGEMENT_FAILURES_TABLE,
    enabled: gardssalgWebsiteJudgementJobEnabled,
    validate: (parsed) => validateGardssalgWebsiteJudgementFile(parsed),
    apply: queueApply,
    filesPerTick: GARDSSALG_WEBSITE_JUDGEMENT_FILES_PER_TICK,
    maxFilesPerDay: GARDSSALG_WEBSITE_JUDGEMENT_MAX_FILES_PER_DAY,
    maxAttemptsPerTick: GARDSSALG_WEBSITE_JUDGEMENT_MAX_ATTEMPTS_PER_TICK,
    maxFileBytes: GARDSSALG_WEBSITE_JUDGEMENT_MAX_FILE_BYTES,
    maxAgeDays: PROPOSAL_QUEUE_MAX_AGE_DAYS,
    writtenId: (r) => (r.result === "written" && typeof r.provider_id === "string" ? r.provider_id : null),
    claims: ({ written, processed, totals }) => [
      { type: "db_state_change", value: written, meta: { kind: "website_judgements_applied", source: "website_judgement_job" } },
      { type: "db_state_change", value: processed, meta: { kind: "website_judgements_processed" } },
      { type: "db_state_change", value: totals.godkjenn ?? 0, meta: { kind: "website_judgements_approved", source: "website_judgement_job" } },
    ],
    extraEvidence: [{ claimIdx: 2, id: (r) => (r.result === "written" && r.verdict === "GODKJENN" && typeof r.provider_id === "string" ? r.provider_id : null) }],
  };
}

/** One tick. Never throws for an expected failure — the report says what
 *  happened; index.ts still wraps it in a try/catch. */
export async function tickGardssalgWebsiteJudgements(
  deps: GardssalgWebsiteJudgementJobDeps = {},
): Promise<ProposalQueueTickReport> {
  const { apply, ...rest } = deps;
  const env = deps.env ?? process.env;
  const applyFn = apply ?? (gardssalgWebsiteJudgementJobEnabled(env) ? await defaultApply() : (null as unknown as ApplyFn));
  // No homepage fetch seam: this lane never fetches anything but GitHub.
  const noFetch = (async () => {
    throw new Error("gardssalg-website-judgement-job never fetches outside api.github.com");
  }) as unknown as typeof fetch;
  return runProposalFileQueueTick(configFor(applyFn), { ...rest, homepageFetchImpl: noFetch });
}

/** Read-only status for GET /admin/gardssalg-website-judgements-status. */
export function getGardssalgWebsiteJudgementsStatus(
  expDb: Database.Database,
  env: Record<string, string | undefined> = process.env,
  opts: { mainDb?: () => Database.Database; now?: Date } = {},
): {
  enabled: boolean;
  token_present: boolean;
  files: Array<{ path: string; sha: string; processed_at: string; status: string | null; error: string | null; totals: unknown }>;
} & ProposalQueueExtras {
  const enabled = gardssalgWebsiteJudgementJobEnabled(env);
  const token_present = (env.A2A_READ_PAT ?? "").trim() !== "";
  return {
    enabled,
    token_present,
    ...getProposalQueueExtras(
      expDb,
      {
        filesTable: GARDSSALG_WEBSITE_JUDGEMENT_FILES_TABLE,
        failuresTable: GARDSSALG_WEBSITE_JUDGEMENT_FAILURES_TABLE,
        agent: GARDSSALG_WEBSITE_JUDGEMENT_AGENT,
        enabled,
        tokenPresent: token_present,
      },
      opts,
    ),
    files: getProposalQueueStatus(expDb, GARDSSALG_WEBSITE_JUDGEMENT_FILES_TABLE),
  };
}
