// ─── Admin: Trigger the platform-verifier from inside the main app ──
//
// Phase 2 (protocols/phase2-platform-verifier-to-fly-plan.md): port the
// Cowork `platform-verifier` agent's deterministic probe loop server-side
// so it stops consuming the Cowork sandbox and runs even when the PC is off.
//
// POST /admin/run-platform-verifier  (requireAdmin, X-Admin-Key)
//   Body/query: { max_age_hours?, limit?, dry_run? }
//     - dry_run DEFAULTS TO TRUE: compute verdicts but DO NOT write the
//       ledger (shadow / parallel-run phase). Set dry_run=false to persist.
//   Returns: { processed, matched, skipped, failed, dry_run, verdicts: [...] }
//
// Runs IN-PROCESS against the app's existing DB handle (same volume the app
// owns) — avoids the DA-0d "volume not shared between machines" trap.
//
// On every invocation it also appends one compact JSONL line to
//   <data>/verifier-parity/<YYYY-MM-DD>.jsonl
// which the shadow-parity comparator diffs against the Cowork-live verifier.

import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { runPlatformVerifier } from "../services/platform-verifier";

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

// Resolve the parity-log directory off the same data dir the DB uses, so it
// lands on the persistent Fly volume (/app/data).
function parityLogPath(now: Date): string {
  const dbPath =
    process.env.DB_PATH || path.join(__dirname, "../../data/lokal.db");
  const dataDir = path.dirname(dbPath);
  const dir = path.join(dataDir, "verifier-parity");
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(dir, `${day}.jsonl`);
}

function appendParityLine(line: string): { written: boolean; path?: string; error?: string } {
  try {
    const logPath = parityLogPath(new Date());
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line + "\n", "utf8");
    return { written: true, path: logPath };
  } catch (e: any) {
    // Parity logging is best-effort — never fail the request because the log
    // could not be written (e.g. read-only FS in some test envs).
    return { written: false, error: String(e?.message || e) };
  }
}

function parseBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === true || v === "true" || v === "1" || v === 1) return true;
  if (v === false || v === "false" || v === "0" || v === 0) return false;
  return undefined;
}

function parseIntOr(v: unknown, fallback: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

// POST /admin/run-platform-verifier
router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body || {}) as Record<string, unknown>;

  // dry_run DEFAULTS TO TRUE. Only an explicit false (body or query) goes live.
  const dryRunParsed =
    parseBool(body.dry_run) ?? parseBool(req.query.dry_run);
  const dryRun = dryRunParsed === undefined ? true : dryRunParsed;

  const maxAgeHours = parseIntOr(
    body.max_age_hours ?? req.query.max_age_hours,
    48,
  );
  const limit = Math.min(
    Math.max(parseIntOr(body.limit ?? req.query.limit, 20), 1),
    100,
  );

  try {
    const result = await runPlatformVerifier({
      dryRun,
      maxAgeHours,
      limit,
    });

    // Parity-log writer (best-effort) + server log line for flyctl logs.
    const parity = appendParityLine(result.parityLine);
    console.log(
      `[platform-verifier] processed=${result.processed} matched=${result.matched} skipped=${result.skipped} failed=${result.failed} dry_run=${result.dry_run} parity_logged=${parity.written}`,
    );

    res.json({
      processed: result.processed,
      matched: result.matched,
      skipped: result.skipped,
      failed: result.failed,
      dry_run: result.dry_run,
      verdicts: result.verdicts,
      runs: result.runs,
      parity_logged: parity.written,
      parity_line: result.parityLine,
    });
  } catch (err: any) {
    res.status(500).json({
      error: "platform_verifier_failed",
      detail: String(err?.message || err),
    });
  }
});

// GET /admin/run-platform-verifier — sanity check the endpoint is wired up
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    success: true,
    endpoint: "POST /admin/run-platform-verifier",
    defaults: { dry_run: true, max_age_hours: 48, limit: 20 },
  });
});

export default router;
