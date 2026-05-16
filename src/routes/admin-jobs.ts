// ─── Admin job-tracker endpoints (PR-65 Option D / Part A, 2026-05-17) ──
//
// Read-only surface over the in-memory job-tracker. Used by callers that
// fired POST /admin/<endpoint>?async=1 to poll for completion.
//
// Mounted at /admin in src/index.ts (behind adminLimiter), so the two
// endpoints below resolve to:
//   GET /admin/jobs            — recent jobs (optional ?endpoint=<filter>&limit=N)
//   GET /admin/jobs/:id        — single job state (404 if unknown/expired)
//
// Jobs are in-memory only and TTL out after 1 hour (see job-tracker.ts).
// On Fly restart the tracker is empty — callers polling a known job_id
// get 404 and can decide to re-fire as a fresh async POST.

import { Router, Request, Response } from "express";
import { getJob, listJobs } from "../services/job-tracker";

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

// ─── GET /admin/jobs ───────────────────────────────────────────────
// Optional query params:
//   ?endpoint=<name>   — filter to a specific endpoint (e.g. "hanen-scrape")
//   ?limit=N           — max 100 (default 20)
router.get("/jobs", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const endpoint = typeof req.query.endpoint === "string" && req.query.endpoint
    ? req.query.endpoint
    : undefined;
  const rawLimit = parseInt((req.query.limit as string) || "20", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 100)
    : 20;
  const jobs = listJobs({ endpoint, limit });
  res.json({ count: jobs.length, jobs });
});

// ─── GET /admin/jobs/:id ───────────────────────────────────────────
router.get("/jobs/:id", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const job = getJob(String(req.params.id));
  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }
  res.json(job);
});

export default router;
