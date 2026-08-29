// ─── Admin: GET/POST /admin/outreach-max-touch-vern ─────────────────────────
//
// dev-request 2026-08-29-outreach-max-touch-vern. The L1 knob behind
// max-touch-vern: the mode=second exclusion in admin-outreach-candidates.ts
// and the send-time invariant in crm.ts (both /threads/:id/send and
// /compose) both read this same config on every call. GET reports the
// current effective config (or the documented default when nobody has ever
// set it); POST updates it — same dry-run/apply convention as the fleet's
// existing DB-backed L1 lever this mirrors, gardssalg-outreach-size-gate
// (services/gardssalg-outreach-size-gate.ts + its admin route pair,
// GET/POST /api/opplevelser/admin/gardssalg-outreach-size-gate,
// routes/opplevelser.ts). See services/outreach-max-touch-vern.ts for why
// this is DB-backed (a lever readable/writable on the SAME running process,
// live on the very next call) rather than a repo-tracked config file (would
// need a redeploy).
//
// Unlike the size-gate, this ships enabled:true from deploy: Daniel's live
// order that produced this dev-request (99 addresses found stuck in
// repeat-send, zero reply ever) IS the on-decision — see
// services/outreach-max-touch-vern.ts for the full reasoning.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { getOutreachMaxTouchVernConfig, setOutreachMaxTouchVernConfig } from "../services/outreach-max-touch-vern";

const router = Router();

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}
function requireAdmin(req: Request, res: Response, next: () => void): void {
  const expected = getAdminKey();
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (!expected || !provided || provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }
  next();
}

// ─── GET /admin/outreach-max-touch-vern ──────────────────────────────────
router.get("/", requireAdmin, (_req: Request, res: Response) => {
  const db = getDb();
  try {
    const config = getOutreachMaxTouchVernConfig(db);
    res.json({ success: true, config });
  } catch (err) {
    console.error("[outreach-max-touch-vern] read failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /admin/outreach-max-touch-vern ─────────────────────────────────
// Body: { enabled?, threshold?, note?, apply? }. Same dry-run/apply
// convention as POST /admin/gardssalg-outreach-size-gate: without
// `apply:true` this is a preview (`would_be`), never a write.
router.post("/", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { enabled?: unknown; threshold?: unknown; note?: unknown; apply?: unknown };

  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  if (
    body.threshold !== undefined &&
    !(typeof body.threshold === "number" && Number.isInteger(body.threshold) && body.threshold > 0)
  ) {
    res.status(400).json({ error: "threshold must be a positive integer" });
    return;
  }
  if (body.enabled === undefined && body.threshold === undefined) {
    res.status(400).json({ error: "at least one of enabled/threshold must be provided" });
    return;
  }
  if (body.note !== undefined && typeof body.note !== "string" && body.note !== null) {
    res.status(400).json({ error: "note must be a string or null" });
    return;
  }

  const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim().slice(0, 1000) : null;
  const apply = body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true";

  const db = getDb();
  try {
    const current = getOutreachMaxTouchVernConfig(db);
    const wouldBe = {
      enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      threshold: typeof body.threshold === "number" ? body.threshold : current.threshold,
    };

    if (!apply) {
      res.json({ success: true, dry_run: true, current, would_be: wouldBe });
      return;
    }

    const patch: { enabled?: boolean; threshold?: number; note?: string | null } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.threshold === "number") patch.threshold = body.threshold;
    // Only touch `note` when the caller actually sent the field — omitting it
    // must leave the persisted note untouched (unlike an explicit `note: null`
    // or `note: ""`, both of which are treated as "clear it").
    if (body.note !== undefined) patch.note = note;
    const config = setOutreachMaxTouchVernConfig(db, patch, "admin");
    res.json({ success: true, dry_run: false, config });
  } catch (err) {
    console.error("[outreach-max-touch-vern] write failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
