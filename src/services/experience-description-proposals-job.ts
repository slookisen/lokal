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

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb as getExpDbDefault } from "../database/db-factory";
import { getDb as getMainDbDefault } from "../database/init";
import { enrichmentWritePauseBlock } from "./enrichment-write-pause";
import { recordRun } from "./run-ledger";
import type { PrewrittenExperienceDescriptionsResult } from "../routes/opplevelser";

export const EXPERIENCE_PROPOSALS_SCHEMA = "experiences-description-proposals/v1";
export const EXPERIENCE_PROPOSALS_REPO = "slookisen/A2A";
export const EXPERIENCE_PROPOSALS_DIR = "experiences-proposals";
export const EXPERIENCE_PROPOSALS_MAX_AGE_DAYS = 14;
export const EXPERIENCE_PROPOSALS_FILES_PER_TICK = 2;
export const EXPERIENCE_PROPOSALS_REQUEST_TIMEOUT_MS = 20_000;
export const EXPERIENCE_PROPOSALS_AGENT = "experience-proposals-job";
export const EXPERIENCE_PROPOSALS_MAX_FILE_BYTES = 64 * 1024;
export const EXPERIENCE_PROPOSALS_MAX_FAILURES = 3;
/** Fetch attempts per tick (successes + per-file failures) — bounds the
 *  tick's runtime when several files fail in a row. */
export const EXPERIENCE_PROPOSALS_MAX_ATTEMPTS_PER_TICK = 4;
/** How many of the most recent date dirs that fell OUT of the 14-day window
 *  are inspected (read-only) to log how many unprocessed files they hold. */
const EXPERIENCE_PROPOSALS_STALE_DIRS_INSPECTED = 3;
const USER_AGENT = "lokal-experience-proposals-job";
const GITHUB_API = "https://api.github.com";

type ApplyFn = (
  db: Database.Database,
  rawItems: unknown,
  opts: { dryRun: boolean; homepageFetchImpl: typeof fetch; logTag?: string },
) => Promise<PrewrittenExperienceDescriptionsResult>;

export interface ExperienceProposalsJobDeps {
  /** GitHub contents-API fetch seam (tests). */
  fetchImpl?: typeof fetch;
  /** kildetro homepage fetch seam, passed to the shared apply function. */
  homepageFetchImpl?: typeof fetch;
  now?: Date;
  env?: Record<string, string | undefined>;
  expDb?: Database.Database;
  /** MAIN db thunk — write-pause row + run ledger live there. */
  mainDb?: () => Database.Database;
  /** The shared apply function; defaults to the one in routes/opplevelser. */
  apply?: ApplyFn;
  timeoutMs?: number;
}

export type ExperienceProposalFileOutcome = {
  path: string;
  sha: string;
  status: "applied" | "error";
  error?: string;
  totals?: Extract<PrewrittenExperienceDescriptionsResult, { ok: true }>["totals"];
};

export interface ExperienceProposalsTickReport {
  run_id: string;
  skipped_reason: "disabled" | "paused" | "no_token" | "github_error" | null;
  github_error: string | null;
  files_listed: number;
  processed: ExperienceProposalFileOutcome[];
  /** Per-file failures this tick (GitHub error/timeout, or an exception in
   *  apply) — not recorded as processed unless fail_count reached the cap. */
  failures: Array<{ path: string; fail_count: number; error: string }>;
  written: number;
  envelope_recorded: boolean;
}

export function experienceProposalsJobEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EXPERIENCE_PROPOSALS_JOB_ENABLED === "true";
}

/** UTC date dirs (YYYY-MM-DD) within the last `maxAgeDays` days, today
 *  included; anything else (non-date names, older, malformed) is ignored. */
export function experienceProposalsDateIsRecent(name: string, now: Date, maxAgeDays = EXPERIENCE_PROPOSALS_MAX_AGE_DAYS): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return false;
  const t = Date.parse(`${name}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = Math.round((today - t) / 86_400_000);
  return ageDays >= 0 && ageDays < maxAgeDays;
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

class GithubFetchError extends Error {}

/** Per-tick GitHub context: counts calls and failed calls so a tick in which
 *  EVERY GitHub call failed can be told apart (review N5). */
type GhCtx = { fetchImpl: typeof fetch; token: string; timeoutMs: number; calls: number; failures: number };

/** Error-message form of a URL: never the query string (review N1). */
function safeUrl(url: string): string {
  return url.split("?")[0].split("#")[0];
}

async function githubGet(ctx: GhCtx, url: string): Promise<Response> {
  ctx.calls++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ctx.timeoutMs);
  try {
    return await ctx.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
      },
      signal: ctrl.signal,
    });
  } catch (err) {
    ctx.failures++;
    throw new GithubFetchError(`request failed for ${safeUrl(url)}: ${String((err as Error)?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }
}

type ContentsEntry = { name: string; path: string; type: string; sha: string; size: number };

function contentsUrl(path: string): string {
  return `${GITHUB_API}/repos/${EXPERIENCE_PROPOSALS_REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function listContents(ctx: GhCtx, path: string): Promise<ContentsEntry[] | null> {
  const res = await githubGet(ctx, contentsUrl(path));
  if (res.status === 404) return null; // directory not created yet — nothing to do
  if (!res.ok) {
    ctx.failures++;
    throw new GithubFetchError(`GET ${path} -> HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    ctx.failures++;
    throw new GithubFetchError(`GET ${path} -> unparseable JSON`);
  }
  if (!Array.isArray(body)) {
    ctx.failures++;
    throw new GithubFetchError(`GET ${path} -> not a directory listing`);
  }
  return (body as Array<Record<string, unknown>>)
    .filter((e) => typeof e?.name === "string" && typeof e?.path === "string" && typeof e?.type === "string" && typeof e?.sha === "string")
    .map((e) => ({
      name: e.name as string,
      path: e.path as string,
      type: e.type as string,
      sha: e.sha as string,
      size: typeof e.size === "number" && Number.isFinite(e.size) ? e.size : 0,
    }));
}

const TOO_LARGE = Symbol("too_large");

/** UTC day the N6 "dropped by the window" line was last logged — at most one
 *  such line (and its read-only stale-dir listings) per day per process. */
let droppedLogDay: string | null = null;
/** Test hook: forget that today's dropped-count line was logged. */
export function __resetExperienceProposalsDroppedLogForTesting(): void {
  droppedLogDay = null;
}

/** The file's text from the contents API's inline base64 `content` only —
 *  no download_url fallback (a proposal over 1 MB is never valid). Returns
 *  TOO_LARGE when the encoded or decoded content exceeds the byte cap. */
async function fetchFileText(ctx: GhCtx, path: string): Promise<string | typeof TOO_LARGE> {
  const res = await githubGet(ctx, contentsUrl(path));
  if (!res.ok) {
    ctx.failures++;
    throw new GithubFetchError(`GET ${path} -> HTTP ${res.status}`);
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    ctx.failures++;
    throw new GithubFetchError(`GET ${path} -> unparseable JSON`);
  }
  if (!body || body.encoding !== "base64" || typeof body.content !== "string" || body.content === "") {
    ctx.failures++;
    throw new GithubFetchError(`GET ${path} -> no inline base64 content`);
  }
  // base64 is 4/3 of the payload (+ line breaks) — reject before decoding.
  if (body.content.length > Math.ceil(EXPERIENCE_PROPOSALS_MAX_FILE_BYTES * 1.4) + 1024) return TOO_LARGE;
  const buf = Buffer.from(body.content.replace(/\s+/g, ""), "base64");
  if (buf.length > EXPERIENCE_PROPOSALS_MAX_FILE_BYTES) return TOO_LARGE;
  return buf.toString("utf8");
}

/** One tick. Never throws for an expected failure — the report says what
 *  happened; index.ts still wraps it in a try/catch. */
export async function tickExperienceDescriptionProposals(
  deps: ExperienceProposalsJobDeps = {},
): Promise<ExperienceProposalsTickReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const startedAt = now.toISOString();
  const today = startedAt.slice(0, 10);
  // run-YYYY-MM-DD-<agent>-<seq>-<vertical>; seq = HHMMSSmmm + a short random
  // suffix, because recordRun() is ON CONFLICT(run_id) DO NOTHING and two
  // ticks must never share an id.
  const runId =
    `run-${today}-${EXPERIENCE_PROPOSALS_AGENT}-` +
    `${startedAt.replace(/[^0-9]/g, "").slice(8, 17)}${randomUUID().slice(0, 6)}-experiences`;
  const report: ExperienceProposalsTickReport = {
    run_id: runId,
    skipped_reason: null,
    github_error: null,
    files_listed: 0,
    processed: [],
    failures: [],
    written: 0,
    envelope_recorded: false,
  };

  if (!experienceProposalsJobEnabled(env)) {
    report.skipped_reason = "disabled";
    return report;
  }
  const mainDb = deps.mainDb ?? getMainDbDefault;
  if (enrichmentWritePauseBlock(mainDb, "experiences")) {
    console.log("[experience-proposals] experiences write-pause is active — tick skipped, nothing fetched");
    report.skipped_reason = "paused";
    return report;
  }
  const token = (env.A2A_READ_PAT ?? "").trim();
  if (!token) {
    console.log("[experience-proposals] A2A_READ_PAT is not set — tick skipped, nothing fetched");
    report.skipped_reason = "no_token";
    return report;
  }

  const ctx: GhCtx = {
    fetchImpl: deps.fetchImpl ?? fetch,
    token,
    timeoutMs: deps.timeoutMs ?? EXPERIENCE_PROPOSALS_REQUEST_TIMEOUT_MS,
    calls: 0,
    failures: 0,
  };
  const homepageFetchImpl = deps.homepageFetchImpl ?? fetch;
  const expDb = deps.expDb ?? (getExpDbDefault("experiences") as unknown as Database.Database);
  const apply: ApplyFn =
    deps.apply ?? ((await import("../routes/opplevelser")).applyPrewrittenExperienceDescriptions as unknown as ApplyFn);

  const processedSha = (path: string): string | undefined =>
    (expDb.prepare("SELECT sha FROM experience_description_proposal_files WHERE path = ?").get(path) as { sha: string } | undefined)?.sha;
  const recordFileStmt = expDb.prepare(
    `INSERT INTO experience_description_proposal_files (path, sha, processed_at, result_json)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(path) DO NOTHING`,
  );
  const clearFailure = expDb.prepare("DELETE FROM experience_description_proposal_failures WHERE path = ?");
  const bumpFailure = expDb.prepare(
    `INSERT INTO experience_description_proposal_failures (path, fail_count, last_error, last_failed_at)
     VALUES (?, 1, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET
       fail_count = fail_count + 1, last_error = excluded.last_error, last_failed_at = excluded.last_failed_at`,
  );
  const failCountOf = (path: string): number =>
    (expDb.prepare("SELECT fail_count FROM experience_description_proposal_failures WHERE path = ?").get(path) as { fail_count: number } | undefined)?.fail_count ?? 0;
  const writtenIds: string[] = [];

  const recordFile = (f: ContentsEntry, outcome: ExperienceProposalFileOutcome, resultJson: unknown): void => {
    recordFileStmt.run(f.path, f.sha, JSON.stringify(resultJson));
    clearFailure.run(f.path);
    report.processed.push(outcome);
  };
  const recordError = (f: ContentsEntry, error: string): void =>
    recordFile(f, { path: f.path, sha: f.sha, status: "error", error }, { status: "error", error });
  /** One failure for this path; at the cap the file becomes a permanent error. */
  const registerFailure = (f: ContentsEntry, error: string): void => {
    bumpFailure.run(f.path, error.slice(0, 500));
    const n = failCountOf(f.path);
    report.failures.push({ path: f.path, fail_count: n, error });
    console.log(`[experience-proposals] ${f.path} failed (${n}/${EXPERIENCE_PROPOSALS_MAX_FAILURES}): ${error}`);
    if (n >= EXPERIENCE_PROPOSALS_MAX_FAILURES) {
      recordError(f, `failed ${n} times; last error: ${error}`.slice(0, 500));
    }
  };

  // Root listing succeeded but EVERY date-dir listing failed: nothing was
  // processed, yet the tick is not healthy — gets a `partial` envelope.
  let allDateDirListingsFailed = false;

  // 1. Root listing — a failure here aborts the tick (nothing to iterate).
  let root: ContentsEntry[] | null;
  try {
    root = await listContents(ctx, EXPERIENCE_PROPOSALS_DIR);
  } catch (err) {
    if (!(err instanceof GithubFetchError)) throw err;
    report.github_error = err.message;
    report.skipped_reason = "github_error";
    console.log(`[experience-proposals] GitHub error on the proposals listing — tick aborted, retried next tick: ${err.message}`);
    root = null;
  }

  if (!report.skipped_reason) {
    const dateEntries = (root ?? []).filter((e) => e.type === "dir" && /^\d{4}-\d{2}-\d{2}$/.test(e.name));
    const dateDirs = dateEntries
      .filter((e) => experienceProposalsDateIsRecent(e.name, now))
      .sort((a, b) => a.name.localeCompare(b.name));

    // 2. Candidates: every unrecorded .json file in the recent dirs, oldest
    //    dir first, names ascending. A failing date-dir listing is skipped
    //    (noted), the other dirs still count.
    const candidates: ContentsEntry[] = [];
    let dateDirListFailures = 0;
    for (const dir of dateDirs) {
      let files: ContentsEntry[];
      try {
        files = ((await listContents(ctx, dir.path)) ?? [])
          .filter((e) => e.type === "file" && e.name.endsWith(".json"))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (err) {
        if (!(err instanceof GithubFetchError)) throw err;
        report.github_error = err.message;
        dateDirListFailures++;
        console.log(`[experience-proposals] GitHub error listing ${dir.path} — skipped this tick: ${err.message}`);
        continue;
      }
      for (const f of files) {
        report.files_listed++;
        const seenSha = processedSha(f.path);
        if (seenSha !== undefined) {
          if (seenSha !== f.sha) {
            console.log(`[experience-proposals] ${f.path} changed after it was processed (sha ${seenSha.slice(0, 7)} -> ${f.sha.slice(0, 7)}) — ignored; a changed proposal must use a new file name`);
          }
          continue;
        }
        candidates.push(f);
      }
    }

    // N6: one line on how many unprocessed files the 14-day window dropped
    // (bounded: only the most recent few out-of-window dirs are listed), at
    // most once per UTC day.
    const staleDirs = dateEntries
      .filter((e) => !experienceProposalsDateIsRecent(e.name, now) && e.name < today)
      .sort((a, b) => b.name.localeCompare(a.name));
    allDateDirListingsFailed = dateDirs.length > 0 && dateDirListFailures === dateDirs.length;
    if (staleDirs.length > 0 && droppedLogDay !== today) {
      droppedLogDay = today;
      let dropped = 0;
      for (const dir of staleDirs.slice(0, EXPERIENCE_PROPOSALS_STALE_DIRS_INSPECTED)) {
        try {
          const files = ((await listContents(ctx, dir.path)) ?? []).filter((e) => e.type === "file" && e.name.endsWith(".json"));
          dropped += files.filter((f) => processedSha(f.path) === undefined).length;
        } catch {
          /* best-effort count only */
        }
      }
      if (dropped > 0) {
        const more = staleDirs.length - Math.min(staleDirs.length, EXPERIENCE_PROPOSALS_STALE_DIRS_INSPECTED);
        console.log(
          `[experience-proposals] ${dropped} unprocessed proposal file(s) dropped by the ${EXPERIENCE_PROPOSALS_MAX_AGE_DAYS}-day window` +
            (more > 0 ? ` (plus ${more} older dir(s) not inspected)` : ""),
        );
      }
    }

    // 3. Process: up to FILES_PER_TICK evaluated files, at most
    //    MAX_ATTEMPTS_PER_TICK fetch attempts; a per-file failure never
    //    blocks the files behind it.
    let evaluated = 0;
    let attempts = 0;
    for (const f of candidates) {
      if (evaluated >= EXPERIENCE_PROPOSALS_FILES_PER_TICK || attempts >= EXPERIENCE_PROPOSALS_MAX_ATTEMPTS_PER_TICK) break;
      if (enrichmentWritePauseBlock(mainDb, "experiences")) {
        console.log("[experience-proposals] write-pause became active mid-tick — remaining files left for a later tick");
        break;
      }
      // Too large by the listing's own size: permanent error, never fetched.
      if (f.size > EXPERIENCE_PROPOSALS_MAX_FILE_BYTES) {
        recordError(f, "file too large");
        continue;
      }
      attempts++;
      let text: string | typeof TOO_LARGE;
      try {
        text = await fetchFileText(ctx, f.path);
      } catch (err) {
        if (!(err instanceof GithubFetchError)) throw err;
        report.github_error = err.message;
        registerFailure(f, err.message);
        continue;
      }
      if (text === TOO_LARGE) {
        recordError(f, "file too large");
        evaluated++;
        continue;
      }
      let parsed: unknown;
      let parseError: string | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parseError = "file is not valid JSON";
      }
      const v = parseError ? { error: parseError } : validateExperienceProposalFile(parsed);
      if ("error" in v) {
        recordError(f, v.error);
        evaluated++;
        continue;
      }
      let out: PrewrittenExperienceDescriptionsResult;
      try {
        out = await apply(expDb, v.items, { dryRun: false, homepageFetchImpl, logTag: "experience-proposals" });
      } catch (err) {
        // review N2: an unexpected exception in the apply step is a per-file
        // failure (same cap), never a tick-killer.
        registerFailure(f, `apply failed: ${String((err as Error)?.message ?? err)}`);
        continue;
      }
      if (!out.ok) {
        recordError(f, out.error);
      } else {
        recordFile(f, { path: f.path, sha: f.sha, status: "applied", totals: out.totals }, { status: "applied", totals: out.totals, results: out.results });
        report.written += out.totals.written;
        for (const r of out.results) if (r.result === "written") writtenIds.push(r.id);
      }
      evaluated++;
    }
  }

  // 4. Run-ledger envelope.
  const allGithubFailed = ctx.calls > 0 && ctx.failures >= ctx.calls && report.processed.length === 0;
  const errorsOut = [
    ...report.processed.filter((p) => p.status === "error").map((p) => ({ message: p.error ?? "error", meta: { path: p.path } })),
    ...report.failures.map((x) => ({ message: x.error, meta: { path: x.path, fail_count: x.fail_count } })),
    ...(report.github_error ? [{ message: report.github_error, meta: {} }] : []),
  ];
  const claims = [
    { type: "db_state_change" as const, value: report.written, meta: { kind: "experiences_content_enriched", source: "proposals_job" } },
    { type: "db_state_change" as const, value: report.processed.length, meta: { kind: "proposals_processed" } },
  ];
  try {
    if (allGithubFailed) {
      // At most ONE `failed` envelope per UTC day: a fixed run_id per day,
      // and recordRun() ignores a repeat.
      recordRun(
        {
          run_id: `run-${today}-${EXPERIENCE_PROPOSALS_AGENT}-github-failed-experiences`,
          vertical: "experiences",
          agent: EXPERIENCE_PROPOSALS_AGENT,
          trigger_source: "cron",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          status: "failed",
          claims,
          evidence: [],
          notes: `every GitHub call of the tick failed (${ctx.failures}/${ctx.calls}); first failing tick of the day`.slice(0, 490),
          errors: errorsOut,
        },
        mainDb(),
      );
      report.envelope_recorded = true;
    } else if (report.processed.length > 0 || report.failures.length > 0 || allDateDirListingsFailed) {
      recordRun(
        {
          run_id: runId,
          vertical: "experiences",
          agent: EXPERIENCE_PROPOSALS_AGENT,
          trigger_source: "cron",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          status: errorsOut.length > 0 ? "partial" : "completed",
          claims,
          evidence: [
            { claim_idx: 0, ids: writtenIds },
            { claim_idx: 1, ids: report.processed.map((p) => p.path) },
          ],
          notes: [
            ...report.processed.map((p) => `${p.path}: ${p.status}${p.totals ? ` written=${p.totals.written} rejected=${p.totals.rejected} skipped=${p.totals.skipped_recorded}` : ` (${p.error})`}`),
            ...report.failures.map((x) => `${x.path}: failure ${x.fail_count}/${EXPERIENCE_PROPOSALS_MAX_FAILURES}`),
          ].join("; ").slice(0, 490),
          ...(errorsOut.length > 0 ? { errors: errorsOut } : {}),
        },
        mainDb(),
      );
      report.envelope_recorded = true;
    }
  } catch (err) {
    console.error("[experience-proposals] run-ledger envelope failed (non-fatal):", err);
  }
  return report;
}

/** Read-only status for GET /admin/experiences-description-proposals-status. */
export function getExperienceDescriptionProposalsStatus(
  expDb: Database.Database,
  env: Record<string, string | undefined> = process.env,
): {
  enabled: boolean;
  token_present: boolean;
  files: Array<{ path: string; sha: string; processed_at: string; status: string | null; error: string | null; totals: unknown }>;
} {
  const rows = expDb
    .prepare(
      `SELECT path, sha, processed_at, result_json FROM experience_description_proposal_files
        ORDER BY processed_at DESC, path DESC LIMIT 20`,
    )
    .all() as Array<{ path: string; sha: string; processed_at: string; result_json: string | null }>;
  return {
    enabled: experienceProposalsJobEnabled(env),
    token_present: (env.A2A_READ_PAT ?? "").trim() !== "",
    files: rows.map((r) => {
      let parsed: any = null;
      try { parsed = r.result_json ? JSON.parse(r.result_json) : null; } catch { parsed = null; }
      return {
        path: r.path,
        sha: r.sha,
        processed_at: r.processed_at,
        status: parsed?.status ?? null,
        error: parsed?.error ?? null,
        totals: parsed?.totals ?? null,
      };
    }),
  };
}
