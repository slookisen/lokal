// ─── /admin/cs/change-requests — CS på serveren, S4 ───────────────────────
// dev-request 2026-11-10-cs-paa-serveren (slookisen/A2A), skive S4.
//
// The CS routine files change requests here; the server executes and verifies
// them (services/cs-change-requests.ts). POST is a DRY RUN unless apply:true.

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  approveChangeRequest,
  cancelChangeRequest,
  createChangeRequest,
  getChangeRequest,
  listChangeRequests,
  rejectChangeRequest,
} from "../services/cs-change-requests";

const router = Router();

function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  if (((req.headers["x-admin-key"] as string) || "") !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

const createSchema = z.object({
  vertical: z.enum(["rfb", "experiences"]),
  targetId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200).nullable().optional(),
  requesterEmail: z.string().email(),
  kind: z.enum(["profile_update", "removal"]),
  changes: z.record(z.string(), z.string().max(4000)).optional(),
  evidence: z.object({ messageId: z.string().max(200).nullable().optional(), quote: z.string().max(2000).nullable().optional() }).nullable().optional(),
  createdBy: z.enum(["claude", "daniel"]).default("claude"),
  apply: z.boolean().default(false),
});

router.post("/change-requests", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  const r = createChangeRequest({ ...parsed.data, threadId: parsed.data.threadId ?? null, evidence: parsed.data.evidence ?? null });
  if (!r.ok) return res.status(r.status).json({ error: r.error, detail: r.detail });
  if (r.dryRun) return res.json({ dryRun: true, plan: r.plan });
  res.status(201).json({ dryRun: false, request: r.request });
});

router.get("/change-requests", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const threadId = typeof req.query.thread_id === "string" ? req.query.thread_id : undefined;
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  res.json({ items: listChangeRequests({ status, threadId, limit }) });
});

router.get("/change-requests/:id", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const r = getChangeRequest(String(req.params.id));
  if (!r) return res.status(404).json({ error: "not_found" });
  res.json({ request: r });
});

router.post("/change-requests/:id/approve", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const r = approveChangeRequest(String(req.params.id), "daniel");
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ request: r.request, note: r.note });
});

const reasonSchema = z.object({ reason: z.string().trim().min(1).max(300) });

router.post("/change-requests/:id/reject", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const parsed = reasonSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "reason required" });
  const r = rejectChangeRequest(String(req.params.id), parsed.data.reason, "daniel");
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ request: getChangeRequest(String(req.params.id)) });
});

router.post("/change-requests/:id/cancel", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const parsed = reasonSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "reason required" });
  try {
    const r = await cancelChangeRequest(String(req.params.id), parsed.data.reason);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ request: r.request });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
