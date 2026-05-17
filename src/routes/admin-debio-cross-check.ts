// ─── Admin: Debio TRACES+Brreg cross-check (Phase 5.11 C.1-A, 2026-05-16) ──
//
// POST /admin/debio/cross-check
//   Synchronously runs the Debio cross-check pipeline. Pulls Debio-issued
//   organic operators from EU TRACES NT, reverse-looks-up the Norwegian
//   orgnumber via Brreg, matches to our existing producer agents, and
//   upserts pending-confirmation affiliations.
//
//   Returns:
//     {
//       success: boolean,
//       traces_fetched,
//       traces_filtered,
//       brreg_resolved,
//       agents_matched,
//       affiliations_upserted,
//       unmatched_persisted,
//       errors: string[],
//       since,
//       duration_ms,
//       traces_pages_processed: { start, end }    // PR-65
//     }
//
//   Query params:
//     since=YYYY-MM-DD       — only process TRACES records issued on/after this
//                              date. Defaults to 2026-01-01 (incremental).
//     start_traces_page=N    — (PR-65) 0-based offset into TRACES pages.
//                              Default 0. Use with max_traces_pages to chunk.
//     max_traces_pages=N     — (PR-65) max TRACES pages this call may fetch.
//                              Default 1200 (backward-compat).
//     async=1                — (PR-65) fire-and-forget; returns 202 + job_id.
//                              Poll GET /admin/jobs/<job_id> for progress.
//     source=finnoko|traces|auto
//                            — (PR-70) which upstream to query. Default
//                              "auto" = finnoko first, TRACES on error.
//                              "finnoko" = skip TRACES entirely.
//                              "traces" = skip finnoko (legacy behaviour).
//
// Auth: X-Admin-Key header (same key as other /admin/* endpoints).
//
// Run-time budget: a full historical run (1200 pages × 1.1s polite delay
// ≈ 22 min) WILL exceed Fly's 120s proxy timeout — use ?async=1 or
// chunk via start_traces_page/max_traces_pages.

import { Router, Request, Response } from "express";
import { runDebioCrossCheck, DEFAULT_SINCE_ISO, DebioSource } from "../services/debio-cross-check";
import { startJob } from "../services/job-tracker";

const router = Router();

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

// Validate `since` query param. Accepts YYYY-MM-DD or full ISO timestamp.
function parseSince(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_SINCE_ISO;
  const v = raw.trim();
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return DEFAULT_SINCE_ISO;
  return v;
}

// PR-65: parse the optional 0-based start_traces_page query param.
function parseStartTracesPage(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim().length === 0) return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// PR-65: parse the optional max_traces_pages query param. Default 1200
// preserves the prior "global sweep" behaviour for callers who omit it.
function parseMaxTracesPages(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim().length === 0) return 1200;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 1200;
  return Math.floor(n);
}

// PR-70: parse the optional source query param. Default "auto" (try
// finnoko first, fall back to TRACES on error). Accepts only the three
// canonical values — anything else falls through to "auto".
function parseSource(raw: unknown): DebioSource {
  if (typeof raw !== "string") return "auto";
  const v = raw.trim().toLowerCase();
  if (v === "finnoko" || v === "traces" || v === "auto") return v;
  return "auto";
}

router.post("/cross-check", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const since = parseSince(req.query.since);
  // PR-65: pagination offset + per-call cap (TRACES-only knobs).
  const startTracesPage = parseStartTracesPage(req.query.start_traces_page);
  const maxTracesPages = parseMaxTracesPages(req.query.max_traces_pages);
  // PR-70: which data source to query — defaults to "auto".
  const source = parseSource(req.query.source);
  const wantAsync = req.query.async === "1" || req.query.async === "true";

  const opts = { since, startTracesPage, maxTracesPages, source };

  if (wantAsync) {
    const dedupeKey = `src=${source}:since=${since}:s=${startTracesPage}:m=${maxTracesPages}`;
    const job = startJob("debio-cross-check", async () => {
      return await runDebioCrossCheck(opts);
    }, { dedupeKey });
    return res.status(202).json({
      job_id: job.job_id,
      status: job.status,
      started_at: job.started_at,
      endpoint: job.endpoint,
      since,
      source,
      traces_pages_processed: {
        start: startTracesPage,
        end: startTracesPage + maxTracesPages - 1,
      },
      poll_url: `/admin/jobs/${job.job_id}`,
    });
  }

  try {
    const result = await runDebioCrossCheck(opts);
    res.json({
      success: true,
      ...result,
      hint: "For full sweeps, use ?async=1 or chunk via start_traces_page/max_traces_pages (each chunk fits in <120s).",
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: "Debio cross-check failed",
      detail: err?.message || String(err),
    });
  }
});

export default router;
