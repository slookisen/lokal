// ─── Platform Verifier (server-side port) ───────────────────────
//
// Phase 2 of OPTIMIZATION-PLAN.md (protocols/phase2-platform-verifier-to-fly-plan.md).
//
// This is the in-app, deterministic port of the Cowork `platform-verifier`
// agent (skill: platform-verifier/SKILL.md). It reads the run-ledger for
// unverified runs, probes each claim against reality, and decides a
// matched / skipped / failed verdict per claim — then a verifier_state per
// run. When run live (dry_run=false) it writes findings back to the ledger
// exactly like the Cowork agent's POST /admin/runs/:id/verify does.
//
// IMPORTANT DESIGN INVARIANT — FAIL-SAFE:
//   A false `matched` is the dangerous failure (it tells the platform a
//   broken claim is fine). Therefore: ANY probe error, ambiguity, missing
//   credential, unknown kind, or unreachable evidence URL → `skipped`,
//   NEVER `matched`. `failed` is reserved for the case where a probe ran
//   cleanly and reality DISAGREED with the claim. `skipped` means "we don't
//   know" and is treated as neutral by the run-state rollup.
//
// IN-PROCESS, NOT A SEPARATE MACHINE:
//   Runs against the app's existing DB handle (getDb()) — same process that
//   owns the volume-mounted SQLite. This avoids the DA-0d "volume not shared
//   between machines" trap that an out-of-process verifier hit.

import type { Database } from "better-sqlite3";
import { getDb } from "../database/init";
import {
  listPendingVerification,
  recordVerifierResult,
} from "./run-ledger";
import type {
  Claim,
  Evidence,
  RunRecord,
  VerifierFinding,
  VerifierState,
} from "../types/run-envelope";
import type { FetchLike } from "../agents/lokal-agent-verifier";

// ─── Per-claim verdict ──────────────────────────────────────────
export type ClaimVerdict = "matched" | "skipped" | "failed";

export interface PlatformVerifierOptions {
  /** Inject a DB handle (tests). Production passes none → getDb(). */
  db?: Database;
  /** Only probe runs whose started_at is within this many hours. Default 48. */
  maxAgeHours?: number;
  /** Cap on runs probed this cycle. Default 20 (mirrors SKILL cap). */
  limit?: number;
  /** When true (DEFAULT), compute verdicts but do NOT write the ledger. */
  dryRun?: boolean;
  /** Restrict to a vertical (default: all). */
  vertical?: string;
  /** Injectable fetch for HTTP probes (tests). Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable clock (tests). Defaults to Date.now(). */
  now?: () => number;
  /** Per-HTTP-probe timeout. Default 8000ms. */
  timeoutMs?: number;
}

export interface ClaimVerdictRow {
  run_id: string;
  claim_idx: number;
  type: string;
  probe_kind: string;
  verdict: ClaimVerdict;
  matched: boolean;
  skipped: boolean;
  reason: string;
}

export interface PlatformVerifierResult {
  processed: number; // number of runs probed
  matched: number; // per-claim verdict tallies
  skipped: number;
  failed: number;
  dry_run: boolean;
  verdicts: ClaimVerdictRow[];
  /** Per-run verifier_state that was (or would be) written. */
  runs: Array<{ run_id: string; state: VerifierState; written: boolean }>;
  /** Compact JSONL line for the shadow-parity comparator (see writer below). */
  parityLine: string;
}

// ─── HTTP probe (fail-safe) ─────────────────────────────────────
// Returns a numeric HTTP status, or 0 on network error / timeout / abort.
// Mirrors the verifier agent's probeAgentUrl HEAD→GET fallback but kept
// local so this service has no behavioural coupling to the agent's retry
// policy (we want a stable, auditable probe for parity diffing).
async function httpStatus(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<number> {
  async function attempt(method: "HEAD" | "GET"): Promise<number> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (method === "GET") headers["Range"] = "bytes=0-1023";
      const r = await fetchImpl(url, {
        method,
        signal: ctrl.signal,
        redirect: "follow",
        headers,
      });
      return r.status;
    } catch {
      return 0; // network error / abort → treat as unreachable
    } finally {
      clearTimeout(t);
    }
  }
  let s = await attempt("HEAD");
  if (s === 405 || s === 0) s = await attempt("GET");
  return s;
}

function ts(now: () => number): string {
  return new Date(now()).toISOString();
}

// Normalise a claim.value into a URL string if it looks like one.
function asUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  // file_deployed values are sometimes bare paths/hosts; only probe explicit URLs.
  return null;
}

// Convert a GitHub blob URL to its raw form so a HEAD/GET actually returns
// the file bytes (blob URLs return the HTML viewer, which 200s even for a
// missing file in some cases). Mirrors SKILL "GitHub blob → raw".
function githubBlobToRaw(url: string): string {
  // https://github.com/<owner>/<repo>/blob/<ref>/<path>
  //   → https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
  const m = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/,
  );
  if (!m) return url;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
}

// ─── Single-claim probe ─────────────────────────────────────────
// Pure-ish: depends only on the claim, its matching evidence rows, and the
// injected fetch. Returns a finding. FAIL-SAFE: every uncertain path → skipped.
export async function probeClaim(args: {
  claim: Claim;
  claimIdx: number;
  evidence: Evidence[];
  fetchImpl: FetchLike;
  timeoutMs: number;
  now: () => number;
}): Promise<VerifierFinding> {
  const { claim, claimIdx, evidence, fetchImpl, timeoutMs, now } = args;
  const probedAt = ts(now);
  const skip = (probe_kind: string, reason: string): VerifierFinding => ({
    claim_idx: claimIdx,
    probe_kind,
    matched: false,
    skipped: true,
    reason,
    probed_at: probedAt,
  });
  const matched = (probe_kind: string, reason: string): VerifierFinding => ({
    claim_idx: claimIdx,
    probe_kind,
    matched: true,
    reason,
    probed_at: probedAt,
  });
  const failed = (probe_kind: string, reason: string): VerifierFinding => ({
    claim_idx: claimIdx,
    probe_kind,
    matched: false,
    skipped: false,
    reason,
    probed_at: probedAt,
  });

  // Evidence rows that point at THIS claim, carrying a probeable URL.
  const evUrls = evidence
    .filter((e) => e.claim_idx === claimIdx && typeof e.url === "string")
    .map((e) => e.url as string);

  try {
    switch (claim.type) {
      // ── file_deployed → the file must be live (200). GitHub blob→raw. ──
      case "file_deployed": {
        const raw = asUrl(claim.value);
        if (!raw) {
          return skip(
            "file_deployed",
            "claim.value is not an absolute URL — cannot probe in-process",
          );
        }
        const url = githubBlobToRaw(raw);
        const status = await httpStatus(url, fetchImpl, timeoutMs);
        if (status === 200) return matched("file_deployed", `GET ${url} → 200`);
        if (status === 404)
          return failed("file_deployed", `GET ${url} → 404 (file not live)`);
        if (status === 0)
          return skip("file_deployed", `GET ${url} → network error/timeout`);
        // Any other status (3xx/4xx/5xx) is ambiguous → skip, never matched.
        return skip("file_deployed", `GET ${url} → ${status} (ambiguous)`);
      }

      // ── http_endpoint → status must equal expected (default 200). ──
      case "http_endpoint": {
        const url = asUrl(claim.value);
        if (!url)
          return skip("http_endpoint", "claim.value is not an absolute URL");
        const expected =
          typeof claim.meta?.expected_status === "number"
            ? (claim.meta.expected_status as number)
            : 200;
        const status = await httpStatus(url, fetchImpl, timeoutMs);
        if (status === 0)
          return skip("http_endpoint", `GET ${url} → network error/timeout`);
        if (status === expected)
          return matched("http_endpoint", `GET ${url} → ${status} (expected ${expected})`);
        return failed(
          "http_endpoint",
          `GET ${url} → ${status}, expected ${expected}`,
        );
      }

      // ── commit → cannot read prod git_sha in-process without a self ──
      // ── HTTP call; the deterministic source-of-truth (SKILL) fetches  ──
      // ── /health. We bias to skipped unless an evidence URL resolves.   ──
      case "commit": {
        // Fall through to the evidence-URL fallback below.
        break;
      }

      // ── db_state_change → SKILL keys off meta.kind. The trivially-     ──
      // ── verifiable rules are deterministic and need no external call.  ──
      case "db_state_change": {
        const kind = (claim.meta?.kind as string | undefined) ?? "";
        // Trivially-verifiable (SKILL "Trivially-verifiable" block):
        if (kind === "alerts_drafted" && Number(claim.value) === 0)
          return matched("db_state_change", "kind=alerts_drafted value=0 (trivially true)");
        if (claim.meta?.alert_level === "none")
          return matched("db_state_change", "alert_level=none (trivially true)");
        if (kind === "compose_send_skipped")
          return matched("db_state_change", "kind=compose_send_skipped (no DB row to check, trivially accepted)");
        // Everything else cross-source (counts, outreach_log, knowledge_put,
        // blocklist, curated_fields, decision_*) requires an admin endpoint
        // we do NOT call from inside this loop (no self-HTTP, fail-safe).
        // Defer to evidence-URL fallback; if none, skip with the rule name.
        if (evUrls.length === 0) {
          return skip(
            "db_state_change",
            kind
              ? `kind=${kind}: no in-process cross-source probe; backend-pending`
              : "db_state_change without meta.kind — no rule, skipped",
          );
        }
        break; // try evidence-URL fallback
      }

      // ── emails_sent → cross-source count needs CRM endpoint; defer. ──
      case "emails_sent": {
        if (evUrls.length === 0)
          return skip("emails_sent", "cross-source CRM count not probed in-process");
        break;
      }

      // ── external_api_call → only verifiable with credentials. ──
      case "external_api_call": {
        if (evUrls.length === 0)
          return skip("external_api_call", "no credentials/probe available");
        break;
      }

      // ── custom → SKILL: if meta.probe is a URL treat as http; if shell ──
      // ── snippet, do NOT execute (security) → skipped.                  ──
      case "custom": {
        const probe = claim.meta?.probe;
        const purl = asUrl(probe);
        if (purl) {
          const status = await httpStatus(purl, fetchImpl, timeoutMs);
          if (status === 0)
            return skip("custom", `probe URL ${purl} → network error/timeout`);
          if (status === 200) return matched("custom", `probe URL ${purl} → 200`);
          return skip("custom", `probe URL ${purl} → ${status} (ambiguous)`);
        }
        return skip("custom", "custom probe is not a URL (shell snippets are never executed)");
      }

      default: {
        return skip("unknown", `unknown claim.type=${String(claim.type)}`);
      }
    }

    // ── Evidence-URL fallback (SKILL): probe the first evidence URL for ──
    // ── this claim. 200 → matched; 4xx/5xx/network → skipped (never     ──
    // ── failed — an unreachable evidence URL is "we don't know").        ──
    if (evUrls.length > 0) {
      const url = githubBlobToRaw(evUrls[0]);
      const status = await httpStatus(url, fetchImpl, timeoutMs);
      if (status === 200)
        return matched(`${claim.type}:evidence_url`, `evidence ${url} → 200`);
      if (status === 0)
        return skip(`${claim.type}:evidence_url`, `evidence ${url} → network error/timeout`);
      return skip(
        `${claim.type}:evidence_url`,
        `evidence ${url} → ${status} (unreachable/ambiguous)`,
      );
    }

    return skip(String(claim.type), "no applicable probe — skipped (fail-safe)");
  } catch (err: any) {
    // Absolute backstop: ANY thrown error → skipped, NEVER matched/failed.
    return skip(
      String(claim.type),
      `probe threw: ${String(err?.message || err)} — skipped (fail-safe)`,
    );
  }
}

// ─── Roll a run's findings up into a verifier_state ─────────────
// SKILL rule: any matched=false-and-not-skipped → failed; else if every
// finding skipped → skipped; else verified.
export function rollUpRunState(findings: VerifierFinding[]): VerifierState {
  if (findings.length === 0) return "skipped";
  const anyFailed = findings.some((f) => f.matched === false && !f.skipped);
  if (anyFailed) return "failed";
  const allSkipped = findings.every((f) => f.skipped === true);
  if (allSkipped) return "skipped";
  return "verified";
}

function verdictOf(f: VerifierFinding): ClaimVerdict {
  if (f.skipped) return "skipped";
  return f.matched ? "matched" : "failed";
}

// ─── Main loop ──────────────────────────────────────────────────
export async function runPlatformVerifier(
  opts: PlatformVerifierOptions = {},
): Promise<PlatformVerifierResult> {
  const db = opts.db ?? getDb();
  const dryRun = opts.dryRun ?? true; // DEFAULT TRUE — see locked design
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const maxAgeHours = opts.maxAgeHours ?? 48;
  const fetchImpl: FetchLike =
    opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 8000;

  const pending: RunRecord[] = listPendingVerification({
    db,
    vertical: opts.vertical,
    maxAgeHours,
    limit,
  });

  const verdicts: ClaimVerdictRow[] = [];
  const runs: PlatformVerifierResult["runs"] = [];
  let matched = 0;
  let skipped = 0;
  let failed = 0;

  for (const run of pending) {
    const claims = Array.isArray(run.claims) ? run.claims : [];
    const evidence = Array.isArray(run.evidence) ? run.evidence : [];
    const findings: VerifierFinding[] = [];

    for (let i = 0; i < claims.length; i++) {
      const finding = await probeClaim({
        claim: claims[i],
        claimIdx: i,
        evidence,
        fetchImpl,
        timeoutMs,
        now,
      });
      findings.push(finding);
      const v = verdictOf(finding);
      if (v === "matched") matched++;
      else if (v === "failed") failed++;
      else skipped++;
      verdicts.push({
        run_id: run.run_id,
        claim_idx: i,
        type: String(claims[i]?.type ?? "unknown"),
        probe_kind: finding.probe_kind,
        verdict: v,
        matched: finding.matched,
        skipped: finding.skipped === true,
        reason: finding.reason,
      });
    }

    const state = rollUpRunState(findings);

    let written = false;
    if (!dryRun) {
      // Live write — persist findings exactly like the Cowork agent does.
      try {
        const { rowsAffected } = recordVerifierResult({
          run_id: run.run_id,
          state,
          findings,
          db,
        });
        written = rowsAffected > 0;
      } catch (e: any) {
        // A write error must NOT corrupt the verdict tally; record not-written.
        written = false;
      }
    }
    runs.push({ run_id: run.run_id, state, written });
  }

  const result: PlatformVerifierResult = {
    processed: pending.length,
    matched,
    skipped,
    failed,
    dry_run: dryRun,
    verdicts,
    runs,
    parityLine: "",
  };
  result.parityLine = buildParityLine(result, now);
  return result;
}

// ─── Parity-log line ────────────────────────────────────────────
// A compact single JSONL line the shadow-parity comparator can diff against
// the Cowork-live verifier output (protocols plan step 2/3). Includes a
// timestamp, the run/claim counts, and a per-claim {run_id, claim_id, type,
// verdict} list so the comparator can match on (run_id, claim_idx).
export function buildParityLine(
  r: PlatformVerifierResult,
  now: () => number = Date.now,
): string {
  return JSON.stringify({
    ts: new Date(now()).toISOString(),
    source: "fly-shadow",
    dry_run: r.dry_run,
    processed: r.processed,
    matched: r.matched,
    skipped: r.skipped,
    failed: r.failed,
    claims: r.verdicts.map((v) => ({
      run_id: v.run_id,
      claim_id: v.claim_idx,
      type: v.type,
      verdict: v.verdict,
    })),
  });
}
