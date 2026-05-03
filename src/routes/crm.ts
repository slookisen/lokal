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

// ─── GET /admin/crm/threads?status=... ──────────────────────
// List threads filtered by status across all contacts. Used by the
// dashboard KPI badges (venter / nye / under arbeid) to show what
// needs attention without drilling into each tab.
router.get("/threads", (req, res) => {
  const status = (req.query.status as string) || "awaiting_review";
  const allowed = ["new", "in_progress", "awaiting_review", "done", "archived"] as const;
  if (!allowed.includes(status as any)) {
    return res.status(400).json({ error: "invalid status", allowed });
  }
  const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
  const offset = parseInt(req.query.offset as string) || 0;
  const threads = crmService.listThreadsByStatus(status as any, { limit, offset });
  res.json({ threads, status, count: threads.length });
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

// ─── POST /admin/crm/compose ─────────────────────────────────
// New free-form email — creates a new thread + contact (if needed),
// inserts an outbound message, then either sends immediately via Resend
// or queues a Gmail draft for the CS-agent.
//
// Use case: Daniel needs to email a producer/partner for whom no inbound
// thread yet exists (e.g. re-issuing a verification link after the Erga
// dedup incident). Reply-to is kontakt@rettfrabonden.com so future replies
// land in the inbox and get ingested by the CS-agent on next run.
const composeSchema = z.object({
  to: z.string().email(),
  contactName: z.string().max(200).optional(),
  subject: z.string().min(1).max(500),
  bodyText: z.string().min(1).max(50000),
  bodyHtml: z.string().max(100000).optional(),
  intent: z.enum(["gmail_draft", "resend_send"]),
  category: z.enum(["innkommende", "marketing", "leverandor", "system", "unknown"]).optional(),
  severity: z.enum(["p0", "p1", "p2", "normal"]).optional(),
  createdBy: z.enum(["claude", "daniel"]),
});

router.post("/compose", async (req, res) => {
  const parsed = composeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  const { to, contactName, subject, bodyText, bodyHtml, intent, category, severity, createdBy } = parsed.data;

  try {
    // We always start in 'queued' state — the message row gets updated
    // to 'sent' / 'failed' / 'draft_in_gmail' only after the actual send
    // outcome is known.  This prevents the dashboard from showing emails
    // as sent when they're really sitting in a Gmail Drafts folder.
    const { threadId, contactId, messageId } = crmService.composeNewThread({
      toEmail: to,
      contactName,
      subject,
      bodyText,
      bodyHtml,
      category: category ?? "innkommende",
      severity: severity ?? "normal",
      createdBy,
      deliveryStatus: "queued",
    });

    const queued = crmService.enqueueOutbox({
      threadId,
      contactId,
      intent,
      toEmails: [to],
      subject,
      bodyText,
      bodyHtml,
      replyToMessageId: null,
      createdBy,
    });

    if (intent === "resend_send") {
      try {
        const result = await emailService.sendRaw({
          to,
          subject,
          textContent: bodyText,
          htmlContent: bodyHtml ?? bodyText,
        });
        if (result.success) {
          crmService.markOutboxResult(queued.id, "completed", result.messageId);
          crmService.updateMessageDeliveryStatus(messageId, "sent");
          crmService.logAction({
            threadId,
            contactId,
            type: "sent",
            actor: createdBy,
            payload: { outboxId: queued.id, messageId: result.messageId, channel: "resend_smtp", composedNew: true, internalMessageId: messageId },
          });
          return res.json({
            success: true,
            threadId,
            contactId,
            outboxId: queued.id,
            messageId: result.messageId,
            channel: "resend_smtp",
          });
        }
        crmService.markOutboxResult(queued.id, "failed", undefined, result.error || "send failed");
        crmService.updateMessageDeliveryStatus(messageId, "failed");
        return res.status(500).json({ success: false, error: result.error || "send failed", outboxId: queued.id, threadId });
      } catch (err: any) {
        crmService.markOutboxResult(queued.id, "failed", undefined, err.message ?? "exception");
        crmService.updateMessageDeliveryStatus(messageId, "failed");
        return res.status(500).json({ success: false, error: err.message ?? "exception", threadId });
      }
    }

    // gmail_draft path: leave delivery_status as 'queued' here.
    // It transitions to 'draft_in_gmail' once the CS-agent picks up the
    // outbox item and reports back via /outbox/:id/result.

    res.json({
      success: true,
      threadId,
      contactId,
      outboxId: queued.id,
      intent: "gmail_draft",
      note: "Queued — will appear in your Gmail Drafts after next CS-agent run.",
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message ?? "compose failed" });
  }
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

    // Bring crm_messages.delivery_status in sync with the actual outcome.
    // Only applies when this outbox item was created from a /compose call
    // (which leaves a 'queued' message row).  Reply-from-thread sends don't
    // create crm_messages, so this no-ops in that case.
    const msgId = crmService.getLatestOutboundMessageId(row.thread_id);
    if (msgId) {
      const newStatus = parsed.data.status === "completed"
        ? (row.intent === "gmail_draft" ? "draft_in_gmail" : "sent")
        : "failed";
      crmService.updateMessageDeliveryStatus(msgId, newStatus);
    }
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

// ─── POST /admin/crm/marketing/dedupe-legacy-threads ─────────
// One-off (idempotent) cleanup for the e16/e17 dual-ingest bug
// where marketing-agent produced both `marketing-e<N>-<id>` (wrong)
// AND `marketing-batch-e<N>-<id>` (correct) thread-IDs for the same
// producer.  This deletes the wrong-pattern thread, keeping the one
// that batch-report can read.
//
// Cascade-deletes the message rows via FK ON DELETE CASCADE.
router.post("/marketing/dedupe-legacy-threads", (_req, res) => {
  try {
    const db = getDb();
    // Find legacy-pattern threads where a correct-pattern twin exists.
    const legacy = db.prepare(`
      SELECT t1.id AS legacy_id, t2.id AS correct_id, t1.contact_id
      FROM crm_threads t1
      JOIN crm_threads t2 ON t1.contact_id = t2.contact_id
        AND t2.id LIKE 'marketing-batch-' || SUBSTR(t1.id, 11)
      WHERE t1.id LIKE 'marketing-e1%-%'
        AND t1.id NOT LIKE 'marketing-batch-%'
    `).all() as Array<{ legacy_id: string; correct_id: string; contact_id: string }>;

    let deleted = 0;
    const stmt = db.prepare("DELETE FROM crm_threads WHERE id = ?");
    for (const row of legacy) {
      const r = stmt.run(row.legacy_id);
      if (r.changes > 0) {
        deleted++;
      }
    }

    res.json({
      ok: true,
      legacy_threads_found: legacy.length,
      legacy_threads_deleted: deleted,
      sample_pairs: legacy.slice(0, 3),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /admin/crm/marketing/batch-report ───────────────────
// Per-batch outreach metrics: how many sent, how many replied, how
// many added themselves to the blocklist (= unsubscribed).  Drives
// the v1-vs-v2 template comparison and the daily marketing summary.
//
// Thread IDs follow the pattern `marketing-batch-e<N>-<producerId>`,
// e.g. `marketing-batch-e15-1247`.
router.get("/marketing/batch-report", (_req, res) => {
  try {
    const db = getDb();
    const sql = `
      WITH parsed AS (
        SELECT
          t.id AS thread_id,
          SUBSTR(t.id, LENGTH('marketing-batch-')+1,
                 INSTR(SUBSTR(t.id, LENGTH('marketing-batch-')+1), '-')-1) AS batch,
          c.email AS to_email,
          (CASE WHEN t.last_inbound_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
          (CASE WHEN EXISTS (
              SELECT 1 FROM agent_blocklist b
              WHERE b.identifier_type = 'email'
                AND LOWER(b.identifier_value) = LOWER(c.email)
            ) THEN 1 ELSE 0 END) AS unsubscribed
        FROM crm_threads t
        JOIN crm_contacts c ON c.id = t.contact_id
        WHERE t.id LIKE 'marketing-batch-e%'
      )
      SELECT
        batch,
        COUNT(*) AS sent,
        SUM(replied) AS replied,
        SUM(unsubscribed) AS unsubscribed,
        ROUND(100.0 * SUM(replied) / NULLIF(COUNT(*), 0), 1) AS reply_rate_pct,
        ROUND(100.0 * SUM(unsubscribed) / NULLIF(COUNT(*), 0), 1) AS unsub_rate_pct
      FROM parsed
      WHERE batch != ''
      GROUP BY batch
      ORDER BY batch DESC
    `;
    const rows = db.prepare(sql).all();
    res.json({
      batches: rows,
      generated_at: new Date().toISOString(),
      note: "v1 = e1..e15.  v2 starts at e16 (verifiserings-frame + personal_observation).",
    });
  } catch (err: any) {
    res.status(500).json({ error: "batch_report_failed", detail: err.message });
  }
});

// ─── GET /admin/crm/sent-log ─────────────────────────────────
// Phase 4.10c — list outbound messages for the Sendt-logg dashboard.
// Filters: ?since_hours=24|168|720|all, ?channel=resend_smtp|gmail_draft|all,
// ?actor=claude|daniel|all, ?status=sent|queued|draft_in_gmail|failed|all
router.get("/sent-log", (req, res) => {
  try {
    const sinceHoursRaw = (req.query.since_hours as string) || "168";
    const sinceHours = sinceHoursRaw === "all" ? undefined : Math.max(1, parseInt(sinceHoursRaw, 10) || 168);
    const limit = Math.min(parseInt((req.query.limit as string) || "500", 10) || 500, 2000);
    const statusFilter = req.query.status as string | undefined;

    let messages = crmService.listSentMessages({
      sinceHours,
      limit,
      deliveryStatus: (statusFilter && statusFilter !== "all"
        ? (statusFilter as "sent" | "queued" | "draft_in_gmail" | "failed")
        : undefined),
    });

    // Optional in-memory filters
    const channel = req.query.channel as string | undefined;
    if (channel && channel !== "all") {
      messages = messages.filter((m) => m.channel === channel || (channel === "resend_smtp" && m.channel?.includes("resend")));
    }
    const actor = req.query.actor as string | undefined;
    if (actor && actor !== "all") {
      messages = messages.filter((m) => m.actor === actor);
    }

    // Quick aggregates so the dashboard can show counters at the top
    const byActor: Record<string, number> = {};
    const byChannel: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const m of messages) {
      byActor[m.actor || "unknown"] = (byActor[m.actor || "unknown"] || 0) + 1;
      byChannel[m.channel || "unknown"] = (byChannel[m.channel || "unknown"] || 0) + 1;
      byStatus[m.delivery_status || "unknown"] = (byStatus[m.delivery_status || "unknown"] || 0) + 1;
    }

    res.json({
      success: true,
      count: messages.length,
      messages,
      summary: { by_actor: byActor, by_channel: byChannel, by_status: byStatus },
      filters: { since_hours: sinceHours ?? "all", channel: channel ?? "all", actor: actor ?? "all", status: statusFilter ?? "all" },
      generated_at: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: "sent_log_failed", detail: err.message });
  }
});

export default router;
