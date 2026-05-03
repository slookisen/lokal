// ─── Admin: Run Ledger Endpoints ────────────────────────────────
//
// HTTP surface for the platform run-ledger:
//   POST /admin/runs           — agents POST their RunEnvelope at end-of-run
//   GET  /admin/runs           — list recent runs (filterable)
//   GET  /admin/runs/stale     — runs claimed completed but verifier never touched
//   GET  /admin/runs/pending   — runs awaiting verifier
//   GET  /admin/runs/summary   — aggregated counts for morning rollup / dashboard
//
// All endpoints require X-Admin-Key. Reuses ADMIN_KEY env (same key used
// elsewhere — see marketplace.ts getAdminKey).
//
// Why a dedicated route file: marketplace.ts is already 1700+ lines.
// Run-ledger is its own surface and will grow (verifier dashboard,
// orchestrator triggers, etc.). Keeping it isolated makes review and
// refactor straightforward.

import { Router, Request, Response } from "express";
import {
  recordRun,
  listRecentRuns,
  listPendingVerification,
  listStaleRuns,
  summariseRuns,
  recordVerifierResult,
} from "../services/run-ledger";
import type {
  RunEnvelope,
  VerifierFinding,
  VerifierState,
} from "../types/run-envelope";

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

// ─── Lightweight envelope validator ────────────────────────────
// Not a full schema check — that's TypeScript's job at compile time.
// This catches obviously-broken POSTs from agents that drift from the
// contract. Keep it forgiving on unknown extra fields (forward-compat).
function validateEnvelope(body: unknown): { ok: true; envelope: RunEnvelope } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "body must be an object" };
  }
  const e = body as Record<string, unknown>;
  const required = [
    "run_id",
    "vertical",
    "agent",
    "trigger_source",
    "started_at",
    "finished_at",
    "status",
    "claims",
    "evidence",
  ];
  for (const k of required) {
    if (e[k] === undefined) return { ok: false, reason: `missing field: ${k}` };
  }
  if (!Array.isArray(e.claims)) return { ok: false, reason: "claims must be array" };
  if (!Array.isArray(e.evidence)) return { ok: false, reason: "evidence must be array" };
  const validTrigger = ["cron", "webhook", "signal", "manual"];
  if (!validTrigger.includes(e.trigger_source as string)) {
    return { ok: false, reason: `trigger_source must be one of ${validTrigger.join(",")}` };
  }
  const validStatus = ["completed", "failed", "partial"];
  if (!validStatus.includes(e.status as string)) {
    return { ok: false, reason: `status must be one of ${validStatus.join(",")}` };
  }
  return { ok: true, envelope: e as unknown as RunEnvelope };
}

// ─── POST /admin/runs ─────────────────────────────────────────
// Agents POST their RunEnvelope at end-of-run.
// Idempotent on run_id — re-posting the same run_id is a no-op.
router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const validation = validateEnvelope(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: "Invalid envelope", reason: validation.reason });
    return;
  }

  try {
    recordRun(validation.envelope);
    res.json({ success: true, run_id: validation.envelope.run_id });
  } catch (err: any) {
    res.status(500).json({ error: "Record failed", detail: err.message });
  }
});

// ─── GET /admin/runs ──────────────────────────────────────────
// List recent runs, filterable by vertical / agent / hours.
// Used by orchestrator's morning rollup and verifier dashboard.
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const vertical = (req.query.vertical as string) || undefined;
  const agent = (req.query.agent as string) || undefined;
  const sinceHours = req.query.since_hours
    ? parseInt(req.query.since_hours as string, 10)
    : 24;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

  try {
    const runs = listRecentRuns({ vertical, agent, sinceHours, limit });
    res.json({ success: true, count: runs.length, runs });
  } catch (err: any) {
    res.status(500).json({ error: "List failed", detail: err.message });
  }
});

// ─── GET /admin/runs/pending ──────────────────────────────────
// Verifier reads this to find runs that need probing.
router.get("/pending", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const vertical = (req.query.vertical as string) || undefined;
  const maxAgeHours = req.query.max_age_hours
    ? parseInt(req.query.max_age_hours as string, 10)
    : 48;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

  try {
    const runs = listPendingVerification({ vertical, maxAgeHours, limit });
    res.json({ success: true, count: runs.length, runs });
  } catch (err: any) {
    res.status(500).json({ error: "Pending failed", detail: err.message });
  }
});

// ─── GET /admin/runs/stale ────────────────────────────────────
// Stale-detector reads this. Returns runs claimed completed but
// verifier never touched, beyond grace period (default 30 min).
router.get("/stale", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const graceMinutes = req.query.grace_minutes
    ? parseInt(req.query.grace_minutes as string, 10)
    : 30;
  const vertical = (req.query.vertical as string) || undefined;

  try {
    const runs = listStaleRuns({ graceMinutes, vertical });
    res.json({ success: true, count: runs.length, runs });
  } catch (err: any) {
    res.status(500).json({ error: "Stale failed", detail: err.message });
  }
});

// ─── GET /admin/runs/summary ──────────────────────────────────
// Aggregated counts for morning rollup. Cheap, OK to call often.
router.get("/summary", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const vertical = (req.query.vertical as string) || undefined;
  const sinceHours = req.query.since_hours
    ? parseInt(req.query.since_hours as string, 10)
    : 24;

  try {
    const summary = summariseRuns({ vertical, sinceHours });
    res.json({ success: true, ...summary });
  } catch (err: any) {
    res.status(500).json({ error: "Summary failed", detail: err.message });
  }
});


// ─── POST /admin/runs/:run_id/verify ─────────────────────────
// Platform-verifier writes back here after probing each claim.
// Body: { state: VerifierState, findings: VerifierFinding[] }
//
// Idempotent on (run_id) — re-posting overwrites the prior verifier
// result. This is the *opposite* of POST / (which is no-op on dup);
// verifier output should always reflect latest probe.
router.post("/:run_id/verify", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const runId = req.params.run_id as string;
  const body = req.body as { state?: unknown; findings?: unknown };

  const validStates = ["pending", "verified", "failed", "skipped"];
  if (!validStates.includes(body.state as string)) {
    res.status(400).json({
      error: "Invalid state",
      reason: `state must be one of ${validStates.join(",")}`,
    });
    return;
  }

  if (!Array.isArray(body.findings)) {
    res.status(400).json({ error: "Invalid findings", reason: "must be array" });
    return;
  }

  // Light per-finding validation
  for (let i = 0; i < body.findings.length; i++) {
    const f = body.findings[i] as Record<string, unknown>;
    if (
      typeof f?.claim_idx !== "number" ||
      typeof f?.probe_kind !== "string" ||
      typeof f?.matched !== "boolean" ||
      typeof f?.reason !== "string" ||
      typeof f?.probed_at !== "string" ||
      (f.skipped !== undefined && typeof f.skipped !== "boolean")
    ) {
      res.status(400).json({
        error: "Invalid finding",
        reason: `findings[${i}] missing required fields (claim_idx, probe_kind, matched, reason, probed_at)`,
      });
      return;
    }
  }

  try {
    const { rowsAffected } = recordVerifierResult({
      run_id: runId,
      state: body.state as VerifierState,
      findings: body.findings as VerifierFinding[],
    });
    // Phase 4.10 — fail loud on run-not-found instead of silent 200. Closes
    // the verifier-write-bug where POST returned success even when run_id
    // typo'd or the run was deleted, leaving the verifier convinced it had
    // persisted findings that never landed.
    if (rowsAffected === 0) {
      res.status(404).json({
        error: "Run not found",
        reason: `no run with run_id=${runId}; UPDATE matched 0 rows`,
        run_id: runId,
      });
      return;
    }
    res.json({
      success: true,
      run_id: runId,
      state: body.state,
      findings_count: (body.findings as unknown[]).length,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Verify failed", detail: err.message });
  }
});

export default router;
