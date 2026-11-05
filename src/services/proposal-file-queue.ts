// ─── Proposal file queue — the shared server-side half of every
// «Claude Code on the subscription writes + judges, a file in A2A carries
// it, a job in lokal stores it without an LLM» lane ───────────────────────
//
// Extracted VERBATIM (mechanics unchanged) from services/experience-
// description-proposals-job.ts (dev-request 2026-10-07-experiences-
// beskrivelser-forslagsko-steg2, part B) when the second such lane arrived:
// gårdssalg visit-text proposals (A2A dev-request 2026-10-06-experiences-
// enrichment-plattformjobb-og-felles-serverjobbramme, tillegg 2026-10-15
// «4b-forslag»). One implementation, two callers — each caller supplies
// what differs (directory, schema check, ledger tables, agent name, the
// apply function and the envelope's claims) and nothing else.
//
// WHAT A TICK DOES (unchanged from the original job, see its header for the
// full reasoning): guards (enabled flag, the experiences write-pause,
// A2A_READ_PAT); root listing of `config.dir` on slookisen/A2A via the
// GitHub contents API; candidate files = every unrecorded .json in date
// directories from the last `maxAgeDays` UTC days, oldest dir first, names
// ascending; at most `filesPerTick` evaluated files and `maxAttemptsPerTick`
// fetch attempts per tick; each file processed AT MOST ONCE (the files
// table, keyed by path — a changed sha is logged and ignored); a GitHub
// error on one file bumps that path's fail_count instead of blocking the
// queue, and at `maxFailures` the file is recorded as a permanent error; a
// file over `maxFileBytes` is a permanent error without being fetched; one
// run-ledger envelope per tick that evaluated or failed something, and at
// most one `failed` envelope per UTC day when every GitHub call failed.
// NEVER calls an LLM: its only network calls are api.github.com and
// whatever the caller's apply function fetches (kildetro homepages).

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb as getExpDbDefault } from "../database/db-factory";
import { getDb as getMainDbDefault } from "../database/init";
import { enrichmentWritePauseBlock } from "./enrichment-write-pause";
import { listRecentRuns, recordRun } from "./run-ledger";

export const PROPOSAL_QUEUE_REPO = "slookisen/A2A";
export const PROPOSAL_QUEUE_MAX_AGE_DAYS = 14;
export const PROPOSAL_QUEUE_FILES_PER_TICK = 2;
export const PROPOSAL_QUEUE_REQUEST_TIMEOUT_MS = 20_000;
export const PROPOSAL_QUEUE_MAX_FILE_BYTES = 64 * 1024;
export const PROPOSAL_QUEUE_MAX_FAILURES = 3;
/** Fetch attempts per tick (successes + per-file failures) — bounds the
 *  tick's runtime when several files fail in a row. */
export const PROPOSAL_QUEUE_MAX_ATTEMPTS_PER_TICK = 4;
/** How many of the most recent date dirs that fell OUT of the window are
 *  inspected (read-only) to log how many unprocessed files they hold. */
const PROPOSAL_QUEUE_STALE_DIRS_INSPECTED = 3;
const GITHUB_API = "https://api.github.com";

/** The caller's apply function: stores one file's items through the SAME
 *  shared function its HTTP write endpoint uses. */
export type ProposalApplyResult =
  | { ok: false; error: string }
  | { ok: true; totals: Record<string, number> & { written: number }; results: Array<Record<string, unknown>> };

export type ProposalApplyFn = (
  expDb: Database.Database,
  items: unknown[],
  opts: {
    dryRun: false;
    homepageFetchImpl: typeof fetch;
    logTag: string;
    // Additive (content-judgement lane, skive 3k): the tick's clock and
    // whatever file-level fields the caller's `validate` passed through as
    // `context`. Existing callers ignore both.
    now?: Date;
    fileContext?: Record<string, unknown>;
  },
) => Promise<ProposalApplyResult>;

export interface ProposalQueueConfig {
  /** Directory under the A2A repo root, e.g. "experiences-proposals". */
  dir: string;
  /** Agent name on the run-ledger envelope. */
  agent: string;
  /** Prefix of every console line, e.g. "experience-proposals". */
  logTag: string;
  /** Ledger tables (created in init-experiences.ts). */
  filesTable: string;
  failuresTable: string;
  /** Flag check — the caller's own env switch. */
  enabled: (env: Record<string, string | undefined>) => boolean;
  /** Structural check of a parsed file; item-level validation is apply's.
   *  `context` (optional) is handed to apply as `opts.fileContext`. */
  validate: (parsed: unknown) => { items: unknown[]; context?: Record<string, unknown> } | { error: string };
  apply: ProposalApplyFn;
  /** The id of a written row in an apply result row (for the evidence list). */
  writtenId: (result: Record<string, unknown>) => string | null;
  /** The envelope's claims for a tick — `written` and `processed` are the
   *  tick's totals, `totals` the per-key sum of every applied file's totals;
   *  the caller names the claim kinds. */
  claims: (totals: { written: number; processed: number; totals: Record<string, number> }) => Array<{ type: "db_state_change"; value: number; meta: Record<string, unknown> }>;
  /** Optional evidence for claims past index 1 (indexes 0/1 are always the
   *  written ids and the processed paths). */
  extraEvidence?: Array<{ claimIdx: number; id: (result: Record<string, unknown>) => string | null }>;
  maxAgeDays?: number;
  filesPerTick?: number;
  /** Optional per-UTC-day cap on recorded files (rows of `filesTable`
   *  whose processed_at falls on the tick's UTC day, errors included).
   *  Unset = no daily cap (the original behaviour). */
  maxFilesPerDay?: number;
  maxAttemptsPerTick?: number;
  maxFileBytes?: number;
  maxFailures?: number;
  userAgent?: string;
}

export interface ProposalQueueDeps {
  /** GitHub contents-API fetch seam (tests). */
  fetchImpl?: typeof fetch;
  /** kildetro homepage fetch seam, passed to the shared apply function. */
  homepageFetchImpl?: typeof fetch;
  now?: Date;
  env?: Record<string, string | undefined>;
  expDb?: Database.Database;
  /** MAIN db thunk — write-pause row + run ledger live there. */
  mainDb?: () => Database.Database;
  /** Override the config's apply (tests). */
  apply?: ProposalApplyFn;
  timeoutMs?: number;
}

export type ProposalFileOutcome = {
  path: string;
  sha: string;
  status: "applied" | "error";
  error?: string;
  totals?: Record<string, number> & { written: number };
};

export interface ProposalQueueTickReport {
  run_id: string;
  skipped_reason: "disabled" | "paused" | "no_token" | "github_error" | null;
  github_error: string | null;
  files_listed: number;
  processed: ProposalFileOutcome[];
  /** Per-file failures this tick (GitHub error/timeout, or an exception in
   *  apply) — not recorded as processed unless fail_count reached the cap. */
  failures: Array<{ path: string; fail_count: number; error: string }>;
  written: number;
  /** True when `maxFilesPerDay` stopped this tick from evaluating further
   *  files (the rest wait for the next UTC day). Always false without a cap. */
  daily_cap_reached: boolean;
  envelope_recorded: boolean;
}

/** UTC date dirs (YYYY-MM-DD) within the last `maxAgeDays` days, today
 *  included; anything else (non-date names, older, malformed) is ignored. */
export function proposalDateIsRecent(name: string, now: Date, maxAgeDays = PROPOSAL_QUEUE_MAX_AGE_DAYS): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return false;
  const t = Date.parse(`${name}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = Math.round((today - t) / 86_400_000);
  return ageDays >= 0 && ageDays < maxAgeDays;
}

export class GithubFetchError extends Error {}

/** Per-tick GitHub context: counts calls and failed calls so a tick in which
 *  EVERY GitHub call failed can be told apart (review N5). */
type GhCtx = { fetchImpl: typeof fetch; token: string; timeoutMs: number; calls: number; failures: number; userAgent: string };

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
        "User-Agent": ctx.userAgent,
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
  return `${GITHUB_API}/repos/${PROPOSAL_QUEUE_REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
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

/** UTC day the "dropped by the window" line was last logged, per queue — at
 *  most one such line (and its read-only stale-dir listings) per day per
 *  process per queue. */
const droppedLogDayByQueue = new Map<string, string>();
/** Test hook: forget that today's dropped-count line was logged. */
export function __resetProposalQueueDroppedLogForTesting(dir?: string): void {
  if (dir) droppedLogDayByQueue.delete(dir);
  else droppedLogDayByQueue.clear();
}

/** The file's text from the contents API's inline base64 `content` only —
 *  no download_url fallback (a proposal over 1 MB is never valid). Returns
 *  TOO_LARGE when the encoded or decoded content exceeds the byte cap. */
async function fetchFileText(ctx: GhCtx, path: string, maxFileBytes: number): Promise<string | typeof TOO_LARGE> {
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
  if (body.content.length > Math.ceil(maxFileBytes * 1.4) + 1024) return TOO_LARGE;
  const buf = Buffer.from(body.content.replace(/\s+/g, ""), "base64");
  if (buf.length > maxFileBytes) return TOO_LARGE;
  return buf.toString("utf8");
}

/** One tick of one queue. Never throws for an expected failure — the report
 *  says what happened; index.ts still wraps it in a try/catch. */
export async function runProposalFileQueueTick(
  config: ProposalQueueConfig,
  deps: ProposalQueueDeps = {},
): Promise<ProposalQueueTickReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const startedAt = now.toISOString();
  const today = startedAt.slice(0, 10);
  const maxAgeDays = config.maxAgeDays ?? PROPOSAL_QUEUE_MAX_AGE_DAYS;
  const filesPerTick = config.filesPerTick ?? PROPOSAL_QUEUE_FILES_PER_TICK;
  const maxAttemptsPerTick = config.maxAttemptsPerTick ?? PROPOSAL_QUEUE_MAX_ATTEMPTS_PER_TICK;
  const maxFileBytes = config.maxFileBytes ?? PROPOSAL_QUEUE_MAX_FILE_BYTES;
  const maxFailures = config.maxFailures ?? PROPOSAL_QUEUE_MAX_FAILURES;
  const tag = config.logTag;
  // run-YYYY-MM-DD-<agent>-<seq>-<vertical>; seq = HHMMSSmmm + a short random
  // suffix, because recordRun() is ON CONFLICT(run_id) DO NOTHING and two
  // ticks must never share an id.
  const runId =
    `run-${today}-${config.agent}-` +
    `${startedAt.replace(/[^0-9]/g, "").slice(8, 17)}${randomUUID().slice(0, 6)}-experiences`;
  const report: ProposalQueueTickReport = {
    run_id: runId,
    skipped_reason: null,
    github_error: null,
    files_listed: 0,
    processed: [],
    failures: [],
    written: 0,
    daily_cap_reached: false,
    envelope_recorded: false,
  };

  if (!config.enabled(env)) {
    report.skipped_reason = "disabled";
    return report;
  }
  const mainDb = deps.mainDb ?? getMainDbDefault;
  if (enrichmentWritePauseBlock(mainDb, "experiences")) {
    console.log(`[${tag}] experiences write-pause is active — tick skipped, nothing fetched`);
    report.skipped_reason = "paused";
    return report;
  }
  const token = (env.A2A_READ_PAT ?? "").trim();
  if (!token) {
    console.log(`[${tag}] A2A_READ_PAT is not set — tick skipped, nothing fetched`);
    report.skipped_reason = "no_token";
    return report;
  }

  const ctx: GhCtx = {
    fetchImpl: deps.fetchImpl ?? fetch,
    token,
    timeoutMs: deps.timeoutMs ?? PROPOSAL_QUEUE_REQUEST_TIMEOUT_MS,
    calls: 0,
    failures: 0,
    userAgent: config.userAgent ?? `lokal-${tag}`,
  };
  const homepageFetchImpl = deps.homepageFetchImpl ?? fetch;
  const expDb = deps.expDb ?? (getExpDbDefault("experiences") as unknown as Database.Database);
  const apply: ProposalApplyFn = deps.apply ?? config.apply;

  const processedSha = (path: string): string | undefined =>
    (expDb.prepare(`SELECT sha FROM ${config.filesTable} WHERE path = ?`).get(path) as { sha: string } | undefined)?.sha;
  const recordFileStmt = expDb.prepare(
    `INSERT INTO ${config.filesTable} (path, sha, processed_at, result_json)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(path) DO NOTHING`,
  );
  const clearFailure = expDb.prepare(`DELETE FROM ${config.failuresTable} WHERE path = ?`);
  const bumpFailure = expDb.prepare(
    `INSERT INTO ${config.failuresTable} (path, fail_count, last_error, last_failed_at)
     VALUES (?, 1, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET
       fail_count = fail_count + 1, last_error = excluded.last_error, last_failed_at = excluded.last_failed_at`,
  );
  const maxFilesPerDay = config.maxFilesPerDay;
  // processed_at is SQLite datetime('now') ("YYYY-MM-DD HH:MM:SS", UTC);
  // the day compared is the tick's own UTC day.
  const filesRecordedToday = (): number =>
    (expDb.prepare(`SELECT COUNT(*) AS n FROM ${config.filesTable} WHERE substr(processed_at, 1, 10) = ?`).get(today) as { n: number }).n;
  const failCountOf = (path: string): number =>
    (expDb.prepare(`SELECT fail_count FROM ${config.failuresTable} WHERE path = ?`).get(path) as { fail_count: number } | undefined)?.fail_count ?? 0;
  const writtenIds: string[] = [];
  const extraEvidenceIds: string[][] = (config.extraEvidence ?? []).map(() => []);
  const summedTotals: Record<string, number> = {};

  const recordFile = (f: ContentsEntry, outcome: ProposalFileOutcome, resultJson: unknown): void => {
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
    console.log(`[${tag}] ${f.path} failed (${n}/${maxFailures}): ${error}`);
    if (n >= maxFailures) {
      recordError(f, `failed ${n} times; last error: ${error}`.slice(0, 500));
    }
  };

  // Root listing succeeded but EVERY date-dir listing failed: nothing was
  // processed, yet the tick is not healthy — gets a `partial` envelope.
  let allDateDirListingsFailed = false;

  // 1. Root listing — a failure here aborts the tick (nothing to iterate).
  let root: ContentsEntry[] | null;
  try {
    root = await listContents(ctx, config.dir);
  } catch (err) {
    if (!(err instanceof GithubFetchError)) throw err;
    report.github_error = err.message;
    report.skipped_reason = "github_error";
    console.log(`[${tag}] GitHub error on the proposals listing — tick aborted, retried next tick: ${err.message}`);
    root = null;
  }

  if (!report.skipped_reason) {
    const dateEntries = (root ?? []).filter((e) => e.type === "dir" && /^\d{4}-\d{2}-\d{2}$/.test(e.name));
    const dateDirs = dateEntries
      .filter((e) => proposalDateIsRecent(e.name, now, maxAgeDays))
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
        console.log(`[${tag}] GitHub error listing ${dir.path} — skipped this tick: ${err.message}`);
        continue;
      }
      for (const f of files) {
        report.files_listed++;
        const seenSha = processedSha(f.path);
        if (seenSha !== undefined) {
          if (seenSha !== f.sha) {
            console.log(`[${tag}] ${f.path} changed after it was processed (sha ${seenSha.slice(0, 7)} -> ${f.sha.slice(0, 7)}) — ignored; a changed proposal must use a new file name`);
          }
          continue;
        }
        candidates.push(f);
      }
    }

    // N6: one line on how many unprocessed files the window dropped
    // (bounded: only the most recent few out-of-window dirs are listed), at
    // most once per UTC day.
    const staleDirs = dateEntries
      .filter((e) => !proposalDateIsRecent(e.name, now, maxAgeDays) && e.name < today)
      .sort((a, b) => b.name.localeCompare(a.name));
    allDateDirListingsFailed = dateDirs.length > 0 && dateDirListFailures === dateDirs.length;
    if (staleDirs.length > 0 && droppedLogDayByQueue.get(config.dir) !== today) {
      droppedLogDayByQueue.set(config.dir, today);
      let dropped = 0;
      for (const dir of staleDirs.slice(0, PROPOSAL_QUEUE_STALE_DIRS_INSPECTED)) {
        try {
          const files = ((await listContents(ctx, dir.path)) ?? []).filter((e) => e.type === "file" && e.name.endsWith(".json"));
          dropped += files.filter((f) => processedSha(f.path) === undefined).length;
        } catch {
          /* best-effort count only */
        }
      }
      if (dropped > 0) {
        const more = staleDirs.length - Math.min(staleDirs.length, PROPOSAL_QUEUE_STALE_DIRS_INSPECTED);
        console.log(
          `[${tag}] ${dropped} unprocessed proposal file(s) dropped by the ${maxAgeDays}-day window` +
            (more > 0 ? ` (plus ${more} older dir(s) not inspected)` : ""),
        );
      }
    }

    // 3. Process: up to filesPerTick evaluated files, at most
    //    maxAttemptsPerTick fetch attempts; a per-file failure never
    //    blocks the files behind it.
    let evaluated = 0;
    let attempts = 0;
    for (const f of candidates) {
      if (evaluated >= filesPerTick || attempts >= maxAttemptsPerTick) break;
      if (maxFilesPerDay !== undefined && filesRecordedToday() >= maxFilesPerDay) {
        report.daily_cap_reached = true;
        console.log(`[${tag}] daily cap of ${maxFilesPerDay} file(s) reached for ${today} — remaining files left for the next UTC day`);
        break;
      }
      if (enrichmentWritePauseBlock(mainDb, "experiences")) {
        console.log(`[${tag}] write-pause became active mid-tick — remaining files left for a later tick`);
        break;
      }
      // Too large by the listing's own size: permanent error, never fetched.
      if (f.size > maxFileBytes) {
        recordError(f, "file too large");
        continue;
      }
      attempts++;
      let text: string | typeof TOO_LARGE;
      try {
        text = await fetchFileText(ctx, f.path, maxFileBytes);
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
      const v = parseError ? { error: parseError } : config.validate(parsed);
      if ("error" in v) {
        recordError(f, v.error);
        evaluated++;
        continue;
      }
      let out: ProposalApplyResult;
      try {
        out = await apply(expDb, v.items, { dryRun: false, homepageFetchImpl, logTag: tag, now, fileContext: v.context });
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
        for (const r of out.results) {
          const id = config.writtenId(r);
          if (id) writtenIds.push(id);
          (config.extraEvidence ?? []).forEach((x, i) => {
            const extraId = x.id(r);
            if (extraId) extraEvidenceIds[i].push(extraId);
          });
        }
        for (const [k, n] of Object.entries(out.totals)) {
          if (typeof n === "number" && Number.isFinite(n)) summedTotals[k] = (summedTotals[k] ?? 0) + n;
        }
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
  const claims = config.claims({ written: report.written, processed: report.processed.length, totals: summedTotals });
  try {
    if (allGithubFailed) {
      // At most ONE `failed` envelope per UTC day: a fixed run_id per day,
      // and recordRun() ignores a repeat.
      recordRun(
        {
          run_id: `run-${today}-${config.agent}-github-failed-experiences`,
          vertical: "experiences",
          agent: config.agent,
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
          agent: config.agent,
          trigger_source: "cron",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          status: errorsOut.length > 0 ? "partial" : "completed",
          claims,
          evidence: [
            { claim_idx: 0, ids: writtenIds },
            { claim_idx: 1, ids: report.processed.map((p) => p.path) },
            ...(config.extraEvidence ?? []).map((x, i) => ({ claim_idx: x.claimIdx, ids: extraEvidenceIds[i] })),
          ],
          notes: [
            ...report.processed.map((p) => `${p.path}: ${p.status}${p.totals ? ` written=${p.totals.written} rejected=${p.totals.rejected ?? 0} skipped=${p.totals.skipped_recorded ?? 0}` : ` (${p.error})`}`),
            ...report.failures.map((x) => `${x.path}: failure ${x.fail_count}/${maxFailures}`),
          ].join("; ").slice(0, 490),
          ...(errorsOut.length > 0 ? { errors: errorsOut } : {}),
        },
        mainDb(),
      );
      report.envelope_recorded = true;
    }
  } catch (err) {
    console.error(`[${tag}] run-ledger envelope failed (non-fatal):`, err);
  }
  return report;
}

/** Read-only status of one queue (the last 20 processed files). */
export function getProposalQueueStatus(
  expDb: Database.Database,
  filesTable: string,
): Array<{ path: string; sha: string; processed_at: string; status: string | null; error: string | null; totals: unknown }> {
  const rows = expDb
    .prepare(`SELECT path, sha, processed_at, result_json FROM ${filesTable} ORDER BY processed_at DESC, path DESC LIMIT 20`)
    .all() as Array<{ path: string; sha: string; processed_at: string; result_json: string | null }>;
  return rows.map((r) => {
    let parsed: any = null;
    try { parsed = r.result_json ? JSON.parse(r.result_json) : null; } catch { parsed = null; }
    return { path: r.path, sha: r.sha, processed_at: r.processed_at, status: parsed?.status ?? null, error: parsed?.error ?? null, totals: parsed?.totals ?? null };
  });
}

export const PROPOSAL_QUEUE_STALL_HOURS = 48;
const STATUS_ERROR_MAX_CHARS = 200;
const STATUS_RUN_LOOKBACK_HOURS = 24 * 30;

export type ProposalQueueHealth = "disabled" | "no_token" | "github_error" | "file_errors" | "ok";

export interface ProposalQueueExtras {
  last_tick: {
    run_id: string;
    started_at: string;
    finished_at: string;
    status: string;
    skipped_reason?: string;
    error?: string;
  } | null;
  last_applied_at: string | null;
  failures: Array<{ path: string; fail_count: number; last_error: string | null; last_failed_at: string | null }>;
  health: ProposalQueueHealth;
  stalled: boolean;
}

const truncStatus = (v: unknown): string => String(v ?? "").slice(0, STATUS_ERROR_MAX_CHARS);

/**
 * Additive observability for one queue (dev-request 2026-10-25-forslagsko-
 * status-eksponerer-github-feil). Read-only. Never includes a token: the only
 * free text surfaced is the ledger's first error message / a failures row's
 * last_error, both truncated to 200 chars (GithubFetchError messages are
 * `GET <path> -> HTTP <status>` and carry no credentials).
 */
export function getProposalQueueExtras(
  expDb: Database.Database,
  cfg: { filesTable: string; failuresTable: string; agent: string; enabled: boolean; tokenPresent: boolean },
  opts: { mainDb?: () => Database.Database; now?: Date } = {},
): ProposalQueueExtras {
  const now = opts.now ?? new Date();

  let last_tick: ProposalQueueExtras["last_tick"] = null;
  let tickErrorHasNonFilePath = false;
  try {
    const db = (opts.mainDb ?? getMainDbDefault)();
    const rec = listRecentRuns({ agent: cfg.agent, limit: 1, sinceHours: STATUS_RUN_LOOKBACK_HOURS, db })[0];
    if (rec) {
      const firstErr = rec.errors?.[0];
      last_tick = {
        run_id: rec.run_id,
        started_at: rec.started_at,
        finished_at: rec.finished_at,
        status: rec.status,
        ...(rec.status === "failed" ? { skipped_reason: "github_error" } : {}),
        ...(firstErr ? { error: truncStatus(firstErr.message) } : {}),
      };
      // A github-level error entry is the one pushed without a path in meta.
      tickErrorHasNonFilePath = (rec.errors ?? []).some((e) => !(e.meta && (e.meta as any).path));
    }
  } catch { last_tick = null; }

  const fileRows = expDb
    .prepare(`SELECT processed_at, result_json FROM ${cfg.filesTable} ORDER BY processed_at DESC`)
    .all() as Array<{ processed_at: string; result_json: string | null }>;
  let last_applied_at: string | null = null;
  for (const r of fileRows) {
    let parsed: any = null;
    try { parsed = r.result_json ? JSON.parse(r.result_json) : null; } catch { parsed = null; }
    if (parsed?.status === "applied") { last_applied_at = r.processed_at; break; }
  }
  const newestProcessedAt = fileRows[0]?.processed_at ?? null;

  const failures = (expDb
    .prepare(`SELECT path, fail_count, last_error, last_failed_at FROM ${cfg.failuresTable} ORDER BY last_failed_at DESC, path ASC LIMIT 20`)
    .all() as Array<{ path: string; fail_count: number; last_error: string | null; last_failed_at: string | null }>)
    .map((f) => ({ path: f.path, fail_count: f.fail_count, last_error: f.last_error == null ? null : truncStatus(f.last_error), last_failed_at: f.last_failed_at }));

  // A github failure is only current when no file was processed after it
  // (a later successful tick that processed something proves recovery).
  const tickIsGithubFailure =
    !!last_tick &&
    (last_tick.status === "failed" || (last_tick.status === "partial" && tickErrorHasNonFilePath)) &&
    !(newestProcessedAt && newestProcessedAt > last_tick.finished_at);

  let health: ProposalQueueHealth;
  if (!cfg.enabled) health = "disabled";
  else if (!cfg.tokenPresent) health = "no_token";
  else if (tickIsGithubFailure) health = "github_error";
  else if (failures.length > 0) health = "file_errors";
  else health = "ok";

  const appliedMs = last_applied_at ? Date.parse(last_applied_at) : NaN;
  const old = Number.isNaN(appliedMs) || now.getTime() - appliedMs > PROPOSAL_QUEUE_STALL_HOURS * 3600_000;
  const stalled = cfg.enabled && cfg.tokenPresent && health !== "ok" && old;

  return { last_tick, last_applied_at, failures, health, stalled };
}
