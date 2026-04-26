import { Router, Request, Response } from "express";
import { z } from "zod";
import { crmService } from "../services/crm-service";
import { emailService } from "../services/email-service";
import { getDb } from "../database/init";

// ─── Admin auth (matches analytics pattern) ─────────────────
function requireAdminAuth(req: Request, res: Response, next: Function): void {
  const expectedKey = process.env.ANALYTICS_ADMIN_KEY || process.env.ADMIN_API_KEY || "";
  if (!expectedKey) {
    res.status(503).json({ error: "CRM not configured: ADMIN key not set" });
    return;
  }
  const apiKey = req.get("X-Admin-Key");
  if (!apiKey || apiKey !== expectedKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const router = Router();
router.use(requireAdminAuth);

// ─── Schemas ─────────────────────────────────────────────────
const messageSchema = z.object({
  messageId: z.string().min(1),
  direction: z.enum(["in", "out"]),
  fromEmail: z.string().email(),
  toEmails: z.array(z.string().email()).optional(),
  ccEmails: z.array(z.string().email()).optional(),
  subject: z.string().nullable().optional(),
  bodyText: z.string().nullable().optional(),
  bodyHtml: z.string().nullable().optional(),
  snippet: z.string().nullable().optional(),
  sentAt: z.string().nullable().optional(),
  rawMetadata: z.record(z.string(), z.any()).optional(),
});

const ingestSchema = z.object({
  threadId: z.string().min(1),
  primaryFromEmail: z.string().email(),
  subject: z.string().nullable().optional(),
  category: z.enum(["innkommende", "system", "marketing", "leverandor", "unknown"]).optional(),
  severity: z.enum(["p0", "p1", "p2", "normal"]).optional(),
  contactName: z.string().nullable().optional(),
  messages: z.array(messageSchema).min(1),
});

const sendSchema = z.object({
  intent: z.enum(["gmail_draft", "resend_send"]),
  toEmails: z.array(z.string().email()).min(1),
  ccEmails: z.array(z.string().email()).optional(),
  subject: z.string().min(1),
  bodyText: z.string().min(1),
  bodyHtml: z.string().optional(),
  replyToMessageId: z.string().nullable().optional(),
  createdBy: z.enum(["claude", "daniel"]),
});

// ─── GET /admin/crm/summary ──────────────────────────────────
router.get("/summary", (_req, res) => {
  res.json(crmService.getDashboardSummary());
});

// ─── GET /admin/crm/contacts?type=producer ───────────────────
router.get("/contacts", (req, res) => {
  const type = (req.query.type as string) || "producer";
  if (!["producer", "marketing", "vendor", "unknown"].includes(type)) {
    return res.status(400).json({ error: "invalid type" });
  }
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = parseInt(req.query.offset as string) || 0;
  const search = (req.query.search as string) || undefined;
  const contacts = crmService.listContacts(type as any, { limit, offset, search });
  res.json({ contacts, type });
});

// ─── GET /admin/crm/contacts/:id ─────────────────────────────
router.get("/contacts/:id", (req, res) => {
  const detail = crmService.getContactDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "not found" });
  res.json(detail);
});

// ─── POST /admin/crm/contacts/:id/type ───────────────────────
router.post("/contacts/:id/type", (req, res) => {
  const schema = z.object({
    type: z.enum(["producer", "marketing", "vendor", "unknown"]),
    agentId: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  crmService.setContactType(req.params.id, parsed.data.type, parsed.data.agentId);
  crmService.logAction({ contactId: req.params.id, type: "contact_reclassified", actor: "daniel", payload: parsed.data });
  res.json({ success: true });
});

// ─── POST /admin/crm/contacts/:id/status ─────────────────────
router.post("/contacts/:id/status", (req, res) => {
  const schema = z.object({ status: z.enum(["active", "blocked", "archived"]) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body" });
  crmService.setContactStatus(req.params.id, parsed.data.status);
  crmService.logAction({ contactId: req.params.id, type: "contact_status_changed", actor: "daniel", payload: parsed.data });
  res.json({ success: true });
});

// ─── POST /admin/crm/contacts/:id/notes ──────────────────────
router.post("/contacts/:id/notes", (req, res) => {
  const schema = z.object({ notes: z.string().max(8000) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body" });
  crmService.setContactNotes(req.params.id, parsed.data.notes);
  res.json({ success: true });
});

// ─── GET /admin/crm/threads/:id ──────────────────────────────
router.get("/threads/:id", (req, res) => {
  const detail = crmService.getThreadDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "not found" });
  res.json(detail);
});

// ─── POST /admin/crm/threads/:id/status ──────────────────────
router.post("/threads/:id/status", (req, res) => {
  const schema = z.object({
    status: z.enum(["new", "in_progress", "awaiting_review", "done", "archived"]),
    actor: z.enum(["claude", "daniel", "system"]).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body" });
  crmService.setThreadStatus(req.params.id, parsed.data.status, parsed.data.actor ?? "daniel");
  res.json({ success: true });
});

// ─── POST /admin/crm/threads/:id/assignee ────────────────────
router.post("/threads/:id/assignee", (req, res) => {
  const schema = z.object({
    assignedTo: z.enum(["unassigned", "claude", "daniel"]),
    actor: z.enum(["claude", "daniel", "system"]).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body" });
  crmService.setThreadAssignee(req.params.id, parsed.data.assignedTo, parsed.data.actor ?? "daniel");
  res.json({ success: true });
});

// ─── POST /admin/crm/threads/:id/notes ───────────────────────
router.post("/threads/:id/notes", (req, res) => {
  const schema = z.object({
    notes: z.string().max(8000),
    actor: z.enum(["claude", "daniel", "system"]).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body" });
  crmService.setThreadNotes(req.params.id, parsed.data.notes, parsed.data.actor ?? "daniel");
  res.json({ success: true });
});

// ─── POST /admin/crm/threads/:id/send ────────────────────────
// intent='resend_send' → sends immediately via SMTP
// intent='gmail_draft' → enqueues outbox; CS-agent picks up and creates Gmail draft
router.post("/threads/:id/send", async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  const { intent, toEmails, ccEmails, subject, bodyText, bodyHtml, replyToMessageId, createdBy } = parsed.data;
  const threadId = req.params.id;

  // Look up contact for logging
  const db = getDb();
  const thread = db.prepare("SELECT contact_id FROM crm_threads WHERE id = ?").get(threadId) as { contact_id: string } | undefined;
  if (!thread) return res.status(404).json({ error: "thread not found" });

  // Always enqueue (even for resend_send — keeps audit trail)
  const queued = crmService.enqueueOutbox({
    threadId,
    contactId: thread.contact_id,
    intent,
    toEmails,
    ccEmails,
    subject,
    bodyText,
    bodyHtml,
    replyToMessageId: replyToMessageId ?? null,
    createdBy,
  });

  if (intent === "resend_send") {
    // Process immediately via SMTP
    try {
      const result = await emailService.sendRaw({
        to: toEmails.join(", "),
        cc: ccEmails?.join(", "),
        subject,
        textContent: bodyText,
        htmlContent: bodyHtml ?? bodyText,
        inReplyToMessageId: replyToMessageId ?? undefined,
      });
      if (result.success) {
        crmService.markOutboxResult(queued.id, "completed", result.messageId);
        crmService.logAction({
          threadId,
          contactId: thread.contact_id,
          type: "sent",
          actor: createdBy,
          payload: { outboxId: queued.id, messageId: result.messageId, channel: "resend_smtp" },
        });
        return res.json({ success: true, outboxId: queued.id, messageId: result.messageId, channel: "resend_smtp" });
      } else {
        crmService.markOutboxResult(queued.id, "failed", undefined, result.error || "send failed");
        return res.status(500).json({ success: false, error: result.error || "send failed", outboxId: queued.id });
      }
    } catch (err: any) {
      crmService.markOutboxResult(queued.id, "failed", undefined, err.message ?? "exception");
      return res.status(500).json({ success: false, error: err.message ?? "exception" });
    }
  }

  // gmail_draft → wait for agent
  res.json({
    success: true,
    outboxId: queued.id,
    intent: "gmail_draft",
    note: "Queued — will appear in your Gmail Drafts after next CS-agent run.",
  });
});

// ─── POST /admin/crm/ingest ──────────────────────────────────
// Called by the CS-agent each run with new/updated threads.
router.post("/ingest", (req, res) => {
  const parsed = ingestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });

  const result = crmService.ingestThread(
    {
      threadId: parsed.data.threadId,
      subject: parsed.data.subject,
      category: parsed.data.category,
      severity: parsed.data.severity,
      messages: parsed.data.messages,
    },
    parsed.data.primaryFromEmail
  );

  // If contactName provided and contact was just created, set name
  if (parsed.data.contactName) {
    const db = getDb();
    db.prepare("UPDATE crm_contacts SET name = COALESCE(name, ?) WHERE id = ?")
      .run(parsed.data.contactName, result.contactId);
  }

  res.json(result);
});

// ─── GET /admin/crm/outbox/pending?intent=gmail_draft ────────
router.get("/outbox/pending", (req, res) => {
  const intent = req.query.intent as string | undefined;
  if (intent && !["gmail_draft", "resend_send"].includes(intent)) {
    return res.status(400).json({ error: "invalid intent" });
  }
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const items = crmService.listPendingOutbox(intent as any, limit);
  // Parse JSON fields for easy agent consumption
  const parsed = items.map((i: any) => ({
    ...i,
    to_emails: JSON.parse(i.to_emails || "[]"),
    cc_emails: JSON.parse(i.cc_emails || "[]"),
  }));
  res.json({ items: parsed });
});

// ─── POST /admin/crm/outbox/:id/result ───────────────────────
// Agent reports completion of a queued action
router.post("/outbox/:id/result", (req, res) => {
  const schema = z.object({
    status: z.enum(["completed", "failed"]),
    resultId: z.string().optional(),
    error: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body" });

  crmService.markOutboxResult(req.params.id, parsed.data.status, parsed.data.resultId, parsed.data.error);

  // Look up outbox row to log action
  const db = getDb();
  const row = db.prepare("SELECT thread_id, contact_id, intent, created_by FROM crm_outbox WHERE id = ?").get(req.params.id) as any;
  if (row) {
    crmService.logAction({
      threadId: row.thread_id,
      contactId: row.contact_id,
      type: parsed.data.status === "completed"
        ? (row.intent === "gmail_draft" ? "draft_created" : "sent")
        : "send_failed",
      actor: row.created_by,
      payload: { outboxId: req.params.id, resultId: parsed.data.resultId, error: parsed.data.error },
    });
  }
  res.json({ success: true });
});


// ─── POST /admin/crm/contacts/reclassify-unknown ─────────────
// Re-evaluate all 'unknown' contacts against current agents table.
// Useful after seeding new producers or fixing email typos.
router.post("/contacts/reclassify-unknown", (_req, res) => {
  const result = crmService.reclassifyUnknown();
  res.json(result);
});

export default router;
