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
// as invalid); a GitHub error/timeout records nothing, so it is retried on
// the next tick. Re-applying after a crash between apply and record is safe:
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

async function githubGet(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
      },
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new GithubFetchError(`request failed for ${url}: ${String((err as Error)?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }
}

type ContentsEntry = { name: string; path: string; type: string; sha: string };

async function listContents(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  timeoutMs: number,
): Promise<ContentsEntry[] | null> {
  const url = `${GITHUB_API}/repos/${EXPERIENCE_PROPOSALS_REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const res = await githubGet(fetchImpl, token, url, timeoutMs);
  if (res.status === 404) return null; // directory not created yet — nothing to do
  if (!res.ok) throw new GithubFetchError(`GET ${path} -> HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new GithubFetchError(`GET ${path} -> unparseable JSON`);
  }
  if (!Array.isArray(body)) throw new GithubFetchError(`GET ${path} -> not a directory listing`);
  return (body as Array<Record<string, unknown>>)
    .filter((e) => typeof e?.name === "string" && typeof e?.path === "string" && typeof e?.type === "string" && typeof e?.sha === "string")
    .map((e) => ({ name: e.name as string, path: e.path as string, type: e.type as string, sha: e.sha as string }));
}

async function fetchFileText(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  timeoutMs: number,
): Promise<string> {
  const url = `${GITHUB_API}/repos/${EXPERIENCE_PROPOSALS_REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const res = await githubGet(fetchImpl, token, url, timeoutMs);
  if (!res.ok) throw new GithubFetchError(`GET ${path} -> HTTP ${res.status}`);
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new GithubFetchError(`GET ${path} -> unparseable JSON`);
  }
  if (body && body.encoding === "base64" && typeof body.content === "string" && body.content !== "") {
    return Buffer.from(body.content.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  // Files over 1 MB come back without inline content — fall back to the raw
  // download URL (same token, same timeout).
  if (body && typeof body.download_url === "string" && body.download_url) {
    const raw = await githubGet(fetchImpl, token, body.download_url, timeoutMs);
    if (!raw.ok) throw new GithubFetchError(`GET raw ${path} -> HTTP ${raw.status}`);
    return await raw.text();
  }
  throw new GithubFetchError(`GET ${path} -> no content`);
}

/** One tick. Never throws for an expected failure — the report says what
 *  happened; index.ts still wraps it in a try/catch. */
export async function tickExperienceDescriptionProposals(
  deps: ExperienceProposalsJobDeps = {},
): Promise<ExperienceProposalsTickReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const startedAt = now.toISOString();
  // run-YYYY-MM-DD-<agent>-<seq>-<vertical>; seq = HHMMSSmmm + a short random
  // suffix, because recordRun() is ON CONFLICT(run_id) DO NOTHING and two
  // ticks must never share an id.
  const runId =
    `run-${startedAt.slice(0, 10)}-${EXPERIENCE_PROPOSALS_AGENT}-` +
    `${startedAt.replace(/[^0-9]/g, "").slice(8, 17)}${randomUUID().slice(0, 6)}-experiences`;
  const report: ExperienceProposalsTickReport = {
    run_id: runId,
    skipped_reason: null,
    github_error: null,
    files_listed: 0,
    processed: [],
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

  const fetchImpl = deps.fetchImpl ?? fetch;
  const homepageFetchImpl = deps.homepageFetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? EXPERIENCE_PROPOSALS_REQUEST_TIMEOUT_MS;
  const expDb = deps.expDb ?? (getExpDbDefault("experiences") as unknown as Database.Database);
  const apply: ApplyFn =
    deps.apply ?? ((await import("../routes/opplevelser")).applyPrewrittenExperienceDescriptions as unknown as ApplyFn);

  const processedSha = (path: string): string | undefined =>
    (expDb.prepare("SELECT sha FROM experience_description_proposal_files WHERE path = ?").get(path) as { sha: string } | undefined)?.sha;
  const recordFile = expDb.prepare(
    `INSERT INTO experience_description_proposal_files (path, sha, processed_at, result_json)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(path) DO NOTHING`,
  );

  try {
    // 1. Pick up to N unprocessed files, oldest date dir first.
    const root = await listContents(fetchImpl, token, EXPERIENCE_PROPOSALS_DIR, timeoutMs);
    const dateDirs = (root ?? [])
      .filter((e) => e.type === "dir" && experienceProposalsDateIsRecent(e.name, now))
      .sort((a, b) => a.name.localeCompare(b.name));
    const todo: ContentsEntry[] = [];
    for (const dir of dateDirs) {
      if (todo.length >= EXPERIENCE_PROPOSALS_FILES_PER_TICK) break;
      const files = ((await listContents(fetchImpl, token, dir.path, timeoutMs)) ?? [])
        .filter((e) => e.type === "file" && e.name.endsWith(".json"))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const f of files) {
        report.files_listed++;
        const seenSha = processedSha(f.path);
        if (seenSha !== undefined) {
          if (seenSha !== f.sha) {
            console.log(`[experience-proposals] ${f.path} changed after it was processed (sha ${seenSha.slice(0, 7)} -> ${f.sha.slice(0, 7)}) — ignored; a changed proposal must use a new file name`);
          }
          continue;
        }
        if (todo.length < EXPERIENCE_PROPOSALS_FILES_PER_TICK) todo.push(f);
      }
    }

    // 2. Process them, one at a time (sequential kildetro fetches inside).
    for (const f of todo) {
      if (enrichmentWritePauseBlock(mainDb, "experiences")) {
        console.log("[experience-proposals] write-pause became active mid-tick — remaining files left for a later tick");
        break;
      }
      const text = await fetchFileText(fetchImpl, token, f.path, timeoutMs); // throws -> not recorded, retried
      let outcome: ExperienceProposalFileOutcome;
      let resultJson: unknown;
      let parsed: unknown;
      let parseError: string | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parseError = "file is not valid JSON";
      }
      const v = parseError ? { error: parseError } : validateExperienceProposalFile(parsed);
      if ("error" in v) {
        outcome = { path: f.path, sha: f.sha, status: "error", error: v.error };
        resultJson = { status: "error", error: v.error };
      } else {
        const out = await apply(expDb, v.items, { dryRun: false, homepageFetchImpl, logTag: "experience-proposals" });
        if (!out.ok) {
          outcome = { path: f.path, sha: f.sha, status: "error", error: out.error };
          resultJson = { status: "error", error: out.error };
        } else {
          outcome = { path: f.path, sha: f.sha, status: "applied", totals: out.totals };
          resultJson = { status: "applied", totals: out.totals, results: out.results };
          report.written += out.totals.written;
        }
      }
      recordFile.run(f.path, f.sha, JSON.stringify(resultJson));
      report.processed.push(outcome);
    }
  } catch (err) {
    if (!(err instanceof GithubFetchError)) throw err;
    report.github_error = err.message;
    if (report.processed.length === 0) report.skipped_reason = "github_error";
    console.log(`[experience-proposals] GitHub error — nothing recorded for the failing file, retried next tick: ${err.message}`);
  }

  // 3. Run-ledger envelope for a tick that did work.
  if (report.processed.length > 0) {
    const errors = report.processed.filter((p) => p.status === "error");
    try {
      recordRun(
        {
          run_id: runId,
          vertical: "experiences",
          agent: EXPERIENCE_PROPOSALS_AGENT,
          trigger_source: "cron",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          status: errors.length > 0 || report.github_error ? "partial" : "completed",
          claims: [
            { type: "db_state_change", value: report.written, meta: { kind: "experiences_content_enriched", source: "proposals_job" } },
            { type: "db_state_change", value: report.processed.length, meta: { kind: "proposals_processed" } },
          ],
          evidence: [{ claim_idx: 1, ids: report.processed.map((p) => p.path) }],
          notes: report.processed
            .map((p) => `${p.path}: ${p.status}${p.totals ? ` written=${p.totals.written} rejected=${p.totals.rejected} skipped=${p.totals.skipped_recorded}` : ` (${p.error})`}`)
            .join("; ")
            .slice(0, 490),
          ...(errors.length > 0 || report.github_error
            ? {
                errors: [
                  ...errors.map((p) => ({ message: p.error ?? "error", meta: { path: p.path } })),
                  ...(report.github_error ? [{ message: report.github_error, meta: {} }] : []),
                ],
              }
            : {}),
        },
        mainDb(),
      );
      report.envelope_recorded = true;
    } catch (err) {
      console.error("[experience-proposals] run-ledger envelope failed (non-fatal):", err);
    }
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
