// ─── Platform Triggers — Webhook Receiver ───────────────────────
//
// Two routers exported:
//   - default        — public ingest (POST /platform/triggers/:event_type)
//   - adminTriggers  — admin queue access (GET pending/recent, POST consume)
//
// Auth model:
//   - POST /platform/triggers/:event_type requires HMAC-SHA256 signature
//     in X-Trigger-Signature header. If TRIGGER_HMAC_SECRET is not set,
//     all signatures land with signature_verified=false (dev mode).
//   - If TRIGGER_REQUIRE_SIGNATURE=true, unsigned triggers are 401.
//   - All admin endpoints require X-Admin-Key.

import { Router, Request, Response } from "express";
import {
  isAllowedEventType,
  ALLOWED_EVENT_TYPES,
} from "../types/trigger";
import {
  recordTrigger,
  verifyHmac,
  listPendingTriggers,
  consumeTrigger,
} from "../services/trigger-store";

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

// ───────────────────────────────────────────────────────────────
//  PUBLIC: POST /platform/triggers/:event_type
// ───────────────────────────────────────────────────────────────
const publicRouter = Router();

publicRouter.post("/triggers/:event_type", (req: Request, res: Response) => {
  const eventType = req.params.event_type;
  if (!isAllowedEventType(eventType)) {
    res.status(400).json({
      error: "Unknown event_type",
      reason: `must be one of: ${ALLOWED_EVENT_TYPES.join(", ")}`,
    });
    return;
  }

  const idempotencyKey = (req.headers["x-idempotency-key"] as string) || "";
  if (!idempotencyKey) {
    res.status(400).json({
      error: "Missing X-Idempotency-Key header",
      reason: "required to prevent duplicate event processing",
    });
    return;
  }
  if (idempotencyKey.length > 256) {
    res.status(400).json({ error: "X-Idempotency-Key too long (max 256)" });
    return;
  }

  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ error: "Body must be a JSON object" });
    return;
  }

  const signatureHeader = req.headers["x-trigger-signature"] as
    | string
    | undefined;
  const rawBody = JSON.stringify(req.body);
  const verified = verifyHmac(rawBody, signatureHeader);

  const requireSignature = process.env.TRIGGER_REQUIRE_SIGNATURE === "true";
  if (requireSignature && !verified) {
    res.status(401).json({
      error: "Invalid or missing X-Trigger-Signature",
      reason: "TRIGGER_REQUIRE_SIGNATURE=true rejects unsigned triggers",
    });
    return;
  }

  const source = (req.headers["x-trigger-source"] as string) || "unknown";

  try {
    const result = recordTrigger({
      event_type: eventType,
      idempotency_key: idempotencyKey,
      payload: req.body as Record<string, unknown>,
      source,
      signature_verified: verified,
    });
    res.json({
      success: true,
      trigger_id: result.trigger_id,
      event_type: eventType,
      duplicate: result.duplicate,
      signature_verified: verified,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Trigger ingest failed", detail: err.message });
  }
});

export default publicRouter;

// ───────────────────────────────────────────────────────────────
//  ADMIN: queue access
// ───────────────────────────────────────────────────────────────
const adminRouter = Router();

adminRouter.get("/triggers/pending", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const eventType = (req.query.event_type as string) || undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const maxAgeHours = req.query.max_age_hours
    ? parseInt(req.query.max_age_hours as string, 10)
    : 168;

  if (eventType && !isAllowedEventType(eventType)) {
    res.status(400).json({ error: "Unknown event_type" });
    return;
  }
  try {
    const triggers = listPendingTriggers({ event_type: eventType, limit, maxAgeHours });
    res.json({ success: true, count: triggers.length, triggers });
  } catch (err: any) {
    res.status(500).json({ error: "Pending failed", detail: err.message });
  }
});

adminRouter.get("/triggers/recent", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(req.query.limit ? parseInt(req.query.limit as string, 10) : 100, 500);
  try {
    const triggers = listPendingTriggers({ limit, maxAgeHours: 720 });
    res.json({ success: true, count: triggers.length, triggers });
  } catch (err: any) {
    res.status(500).json({ error: "Recent failed", detail: err.message });
  }
});

adminRouter.post("/triggers/:trigger_id/consume", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const triggerId = req.params.trigger_id;
  const body = req.body as { consumed_by?: string; result?: string };

  if (!body.consumed_by || typeof body.consumed_by !== "string") {
    res.status(400).json({
      error: "Missing consumed_by",
      reason: "must be the agent name or run_id that processed this trigger",
    });
    return;
  }
  try {
    const updated = consumeTrigger({
      trigger_id: triggerId,
      consumed_by: body.consumed_by,
      result: body.result,
    });
    if (!updated) {
      res.status(404).json({ error: "Trigger not found" });
      return;
    }
    res.json({ success: true, trigger_id: triggerId });
  } catch (err: any) {
    res.status(500).json({ error: "Consume failed", detail: err.message });
  }
});

export { adminRouter };
