import { Router, Request, Response } from "express";
import { z } from "zod";
import { crmService, CrmVertical, isCrmVertical, CRM_VERTICALS } from "../services/crm-service";
import { crmFromHeader, resolveCrmIdentity, lintOutboundBodyForForeignBranding } from "../services/crm-platform-identity";
import {
  planRetroTagging,
  applyRetroTagging,
  revertRetroTaggingBatch,
  listRetroBatches,
} from "../services/crm-retro-tagging";
import {
  deriveVertical,
  parkUntriaged,
  listUntriaged,
  getUntriaged,
  markUntriagedResolved,
  countOpenUntriaged,
} from "../services/crm-triage";
import { emailService } from "../services/email-service";
import { getDb } from "../database/init";
import { isOutreachPaused } from "./admin-outreach-candidates";

// ─── Admin auth (matches the fleet-wide admin-route pattern, e.g.
// admin-affiliations.ts / admin-hanen.ts: ADMIN_KEY primary,
// ANALYTICS_ADMIN_KEY legacy fallback) ─────────────────
function requireAdminAuth(req: Request, res: Response, next: Function): void {
  const expectedKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
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

// ?vertical=rfb|dental|experiences — anything else (or omitted) = all verticals.
function parseVertical(req: Request): CrmVertical | undefined {
  const v = String(req.query.vertical || "").toLowerCase();
  return v === "rfb" || v === "dental" || v === "experiences" ? (v as CrmVertical) : undefined;
}

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
  // No default, ever. Defaulting to 'rfb' here is precisely how every existing
  // CRM row ended up tagged 'rfb', Opplevagent enquiries included.
  //
  // Optional ONLY because steg 4 added `routingSignals` as the other way to
  // supply it; the .superRefine below rejects a body carrying NEITHER, so the
  // steg-1 guarantee ("a call with no vertical is refused and writes nothing")
  // is unchanged. A caller that sends `vertical` behaves exactly as before.
  vertical: z.enum(CRM_VERTICALS).optional(),
  // steg 4: what the agent literally read off the headers. The SERVER derives
  // the platform from these (crm-triage.deriveVertical) so that "I cannot tell"
  // is a real outcome rather than an LLM picking the nearest class. .strict()
  // is load-bearing: a mistyped key would otherwise silently look like "no
  // signals" and park every thread instead of erroring once, loudly.
  routingSignals: z
    .object({
      deliveredTo: z.union([z.string(), z.array(z.string())]).nullable().optional(),
      to: z.union([z.string(), z.array(z.string())]).nullable().optional(),
      cc: z.union([z.string(), z.array(z.string())]).nullable().optional(),
      xForwardedTo: z.union([z.string(), z.array(z.string())]).nullable().optional(),
      envelopeTo: z.union([z.string(), z.array(z.string())]).nullable().optional(),
      received: z.union([z.string(), z.array(z.string())]).nullable().optional(),
    })
    .strict()
    .optional(),
}).superRefine((data, ctx) => {
  if (data.vertical === undefined && data.routingSignals === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["vertical"],
      message:
        "supply either `vertical` (rfb|dental|experiences) or `routingSignals` (the recipient headers). " +
        "There is no default — an unroutable thread is parked for human triage, never filed as rfb.",
    });
  }
});

// ─── Double-send guard window (steg 1.3, dev-request
// 2026-08-09-cs-rutine-to-plattformer-og-tradhistorikk) ────────────────────
// See crmService.findRecentIdenticalOutbound() for the finding and the
// hard-reject-on-exact-duplicate rationale. 30s comfortably covers a
// double-click/double-submit (the observed incident was 4s apart) without
// being long enough to ever catch a human re-reading and re-sending later.
const DUPLICATE_SEND_WINDOW_SECONDS = 30;

// A subject that's empty (after trimming) or that trims to NOTHING but a
// reply/svar prefix ("Re:" / "Sv:", case-insensitive) is contentless — see
// the LIVE incident this guards against: an outreach thread got two
// auto-replies four seconds apart, both subject "Re:" and both missing the
// claim link the producer needed. The empty subject was the symptom of a
// reply the agent never actually composed. "Re: faktisk oppfølging" has real
// content beyond the prefix and is NOT rejected — only an exact,
// nothing-else match is.
const REPLY_PREFIX_ONLY_SUBJECT = /^(re|sv):$/i;

const sendSchema = z
  .object({
    intent: z.enum(["gmail_draft", "resend_send"]),
    toEmails: z.array(z.string().email()).min(1),
    ccEmails: z.array(z.string().email()).optional(),
    subject: z.string().min(1),
    bodyText: z.string().min(1),
    bodyHtml: z.string().optional(),
    replyToMessageId: z.string().nullable().optional(),
    createdBy: z.enum(["claude", "daniel"]),
  })
  .superRefine((data, ctx) => {
    const trimmed = data.subject.trim();
    if (trimmed.length === 0 || REPLY_PREFIX_ONLY_SUBJECT.test(trimmed)) {
      ctx.addIssue({
        code: "custom",
        path: ["subject"],
        message:
          "subject is empty or contains only a reply prefix ('Re:'/'Sv:') with no actual content — " +
          "this is the signature of a reply the agent never composed a real subject for, not a real message.",
      });
    }
  });

// ─── GET /admin/crm/summary ──────────────────────────────────
router.get("/summary", (req, res) => {
  res.json(crmService.getDashboardSummary(parseVertical(req)));
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
  const contacts = crmService.listContacts(type as any, { limit, offset, search, vertical: parseVertical(req) });
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
    // steg 6: manual link to an opplevagent-produsent (experience_providers.id).
    // Only valid on an 'experiences' contact, and mutually exclusive with
    // agentId — setContactType() enforces both and throws a readable message.
    providerId: z.string().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  try {
    crmService.setContactType(req.params.id, parsed.data.type, parsed.data.agentId, parsed.data.providerId);
  } catch (e) {
    // Vertical-mismatch / nonexistent provider / missing contact — caller
    // errors, not server faults. The message is written for a human.
    return res.status(400).json({ error: (e as Error).message });
  }
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

// ─── GET /admin/crm/threads?status=...&contact_email=... ────
// List threads filtered by status across all contacts. Used by the
// dashboard KPI badges (venter / nye / under arbeid) to show what
// needs attention without drilling into each tab. Also supports a
// per-contact lookup via ?contact_email=, which (unless an explicit
// ?status= is also given) searches across ALL statuses rather than
// defaulting to "awaiting_review" — the dashboard-badge default only
// applies when contact_email is omitted.
router.get("/threads", (req, res) => {
  const contactEmail = (req.query.contact_email as string | undefined)?.trim() || undefined;
  const explicitStatus = req.query.status as string | undefined;
  const allowed = ["new", "in_progress", "awaiting_review", "done", "archived"] as const;

  let status: string | undefined;
  if (explicitStatus) {
    if (!allowed.includes(explicitStatus as any)) {
      return res.status(400).json({ error: "invalid status", allowed });
    }
    status = explicitStatus;
  } else if (!contactEmail) {
    status = "awaiting_review";
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
  const offset = parseInt(req.query.offset as string) || 0;
  const threads = crmService.listThreadsByStatus(status as any, {
    limit,
    offset,
    vertical: parseVertical(req),
    contactEmail,
  });
  res.json({ threads, status: status || "all", count: threads.length });
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
  const thread = db.prepare("SELECT contact_id, vertical_id FROM crm_threads WHERE id = ?").get(threadId) as
    { contact_id: string; vertical_id: string } | undefined;
  if (!thread) return res.status(404).json({ error: "thread not found" });

  // The platform comes from the THREAD, never from the request body. A reply
  // belongs to the conversation it continues; letting a caller pass a vertical
  // here would allow an rfb thread to be answered as Opplevagent (and would
  // re-open exactly the mixing this whole change exists to prevent).
  if (!isCrmVertical(thread.vertical_id)) {
    return res.status(409).json({
      error: "thread has no valid vertical",
      detail: `crm_threads.vertical_id = ${JSON.stringify(thread.vertical_id)} — refusing to guess a platform for an outbound reply`,
    });
  }

  // ─── Skive E — outbound BODY lint, fail-closed ─────────────────
  // The envelope (From display-name + reply-to) is already pinned to the
  // THREAD's platform above via resolveCrmIdentity — that closed funn 2 for
  // the headers. Nothing stopped the body text itself from still saying "Rett
  // fra Bonden" or linking rettfrabonden.com on an experiences thread; that's
  // the mirror-image leak this guard closes. A hit here means neither
  // resend_send NOR gmail_draft may proceed — a wrongly-branded Gmail draft
  // is still a wrongly-branded draft a human could send.
  const brandingLint = lintOutboundBodyForForeignBranding(thread.vertical_id, subject, bodyText, bodyHtml);
  if (brandingLint.violation) {
    return res.status(409).json({
      error: "foreign_platform_branding",
      detail:
        `outbound body for a ${JSON.stringify(thread.vertical_id)} thread contains branding belonging to ` +
        `another platform (${brandingLint.matches.join(", ")}) — refusing to send or draft a reply that ` +
        `names the wrong platform in its own words`,
      matches: brandingLint.matches,
    });
  }

  // ─── Double-send guard ────────────────────────────────────────
  // Hard reject on a byte-identical subject+body sent to this same thread
  // within DUPLICATE_SEND_WINDOW_SECONDS. See
  // crmService.findRecentIdenticalOutbound() for the finding this is based
  // on and why identical-content is the line, not merely "recent".
  const duplicate = crmService.findRecentIdenticalOutbound(threadId, subject, bodyText, DUPLICATE_SEND_WINDOW_SECONDS);
  if (duplicate) {
    return res.status(409).json({
      error: "duplicate_send",
      detail:
        `identical subject+body already sent on this thread at ${duplicate.received_at} ` +
        `(crm_messages ${duplicate.id}) — refusing to send the same reply twice within ` +
        `${DUPLICATE_SEND_WINDOW_SECONDS}s. If this is genuinely a second, deliberate reply, ` +
        `change the subject or body and resend.`,
      duplicateMessageId: duplicate.id,
      duplicateAt: duplicate.received_at,
    });
  }

  // Always enqueue (even for resend_send — keeps audit trail)
  const queued = crmService.enqueueOutbox({
    threadId,
    contactId: thread.contact_id,
    vertical: thread.vertical_id,
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
    // ─── Reserve the crm_messages row BEFORE the await below ──────────────
    // Bug fix (post-review): the double-send guard above only ever saw
    // ALREADY-RECORDED sends, because recordOutboundReply() used to run
    // AFTER `await emailService.sendRaw(...)` resolved. Two genuinely
    // concurrent identical requests both pass findRecentIdenticalOutbound()
    // (neither has recorded anything yet), both await the send, and both
    // record a message — the guard never actually closed the race it exists
    // for. Confirmed via two Promise.all-fired identical resend_send
    // requests against a stubbed transport: both created a crm_messages row.
    //
    // Fix: record the reservation (delivery_status='queued', same "not yet
    // confirmed" state the gmail_draft path already uses) synchronously,
    // right here — before the first `await` in this branch. Everything from
    // the duplicate-check above through this insert runs in one synchronous
    // stretch of the event loop (better-sqlite3 calls are synchronous, and
    // nothing in between awaits), so Node cannot interleave a second
    // request's handler into the middle of it. A second, genuinely-
    // concurrent identical request therefore either fully completes its own
    // reservation before this one starts (and this one's duplicate-check
    // catches IT), or runs its duplicate-check after this reservation is
    // already committed (and it gets rejected by this one). Either way,
    // only one of the two can ever get past the check — the crm_messages
    // row is now the single source of truth for "is a send in flight",
    // closing the actual race, not just the already-recorded case.
    //
    // outboxId links this message back onto the crm_outbox row it belongs
    // to (crm_outbox.crm_message_id) so /outbox/:id/result can resolve
    // "the" message for THIS outbox item explicitly instead of guessing via
    // getLatestOutboundMessageId's "most recent for thread" heuristic —
    // see that route handler for the ambiguity this closes.
    const reserved = crmService.recordOutboundReply({
      threadId,
      vertical: thread.vertical_id,
      toEmails,
      ccEmails,
      subject,
      bodyText,
      bodyHtml,
      deliveryStatus: "queued",
      outboxId: queued.id,
    });

    // Process immediately via SMTP
    try {
      // Steg 3: brand + reply-to come from the THREAD's platform, same source of
      // truth as the outbox row. resolveCrmIdentity throws on an unconfigured
      // vertical rather than falling back on the RFB identity.
      const identity = resolveCrmIdentity(thread.vertical_id);
      const result = await emailService.sendRaw({
        to: toEmails.join(", "),
        cc: ccEmails?.join(", "),
        subject,
        textContent: bodyText,
        htmlContent: bodyHtml ?? bodyText,
        inReplyToMessageId: replyToMessageId ?? undefined,
        from: crmFromHeader(thread.vertical_id),
        replyTo: identity.replyTo,
      });
      if (result.success) {
        crmService.markOutboxResult(queued.id, "completed", result.messageId);
        // Steg 1: the reply now becomes part of the thread's own message
        // history (message_count grows, last_outbound_at moves) — this is
        // the fix. internalMessageId in the action payload mirrors the
        // compose route's convention so the Sendt-logg's actor lookup can
        // match this crm_messages row exactly, not just fall back to the
        // thread-level outbox heuristic. The row already exists (reserved
        // above) — flip it from 'queued' to the real outcome instead of
        // inserting a second row.
        crmService.updateMessageDeliveryStatus(reserved.messageId, "sent");
        crmService.logAction({
          threadId,
          contactId: thread.contact_id,
          type: "sent",
          actor: createdBy,
          payload: { outboxId: queued.id, messageId: result.messageId, channel: "resend_smtp", internalMessageId: reserved.messageId },
        });
        return res.json({ success: true, outboxId: queued.id, messageId: result.messageId, internalMessageId: reserved.messageId, channel: "resend_smtp" });
      } else {
        crmService.markOutboxResult(queued.id, "failed", undefined, result.error || "send failed");
        // Flip the reserved row to 'failed' (no sent_at) — matches
        // composeNewThread/updateMessageDeliveryStatus's existing "failed
        // sends are still visible in the thread" convention.
        crmService.updateMessageDeliveryStatus(reserved.messageId, "failed");
        return res.status(500).json({ success: false, error: result.error || "send failed", outboxId: queued.id });
      }
    } catch (err: any) {
      crmService.markOutboxResult(queued.id, "failed", undefined, err.message ?? "exception");
      crmService.updateMessageDeliveryStatus(reserved.messageId, "failed");
      return res.status(500).json({ success: false, error: err.message ?? "exception" });
    }
  }

  // gmail_draft → wait for agent. Recorded as 'queued' now (visible in the
  // thread immediately) and flipped to 'draft_in_gmail' by the existing
  // /outbox/:id/result -> updateMessageDeliveryStatus path once the CS-agent
  // reports the draft was created — same lifecycle composeNewThread's
  // gmail_draft path already uses. This whole branch is synchronous (no
  // `await` anywhere in it), so — same reasoning as the resend_send
  // reservation above — it can never interleave with a concurrent request
  // either; outboxId links it to the crm_outbox row for /outbox/:id/result.
  const recorded = crmService.recordOutboundReply({
    threadId,
    vertical: thread.vertical_id,
    toEmails,
    ccEmails,
    subject,
    bodyText,
    bodyHtml,
    deliveryStatus: "queued",
    outboxId: queued.id,
  });
  res.json({
    success: true,
    outboxId: queued.id,
    intent: "gmail_draft",
    internalMessageId: recorded.messageId,
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
  // REQUIRED, no default. z.enum rejects a missing or unknown value with a 400
  // before any write happens — the fail-closed half of the guard in
  // crm-service.assertVertical. Defaulting to 'rfb' here is precisely how every
  // existing CRM row ended up tagged 'rfb', Opplevagent enquiries included.
  vertical: z.enum(CRM_VERTICALS),
  // Phase 4.10c-2 Steg 3 — explicit override for the recipient-rate-limit guard.
  // Daniel can pass force=true on manual sends (e.g. urgency); claude-actor
  // calls are always rate-limited.
  force: z.boolean().optional(),
});

// ─── Steg C2 — server-side daily send cap ────────────────────────────
// OUTREACH_MAX_PER_DAY (default 50): max cold-outreach (resend_send,
// createdBy='claude') sends per UTC calendar day. Shared by the reserve
// guard in POST /compose and the read-back in GET /sent-log so both sides
// parse the env var identically.
function resolveDailyOutreachCap(): number {
  return Math.max(1, parseInt(String(process.env.OUTREACH_MAX_PER_DAY ?? "50"), 10) || 50);
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

router.post("/compose", async (req, res) => {
  const parsed = composeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  const { to, contactName, subject, bodyText, bodyHtml, intent, category, severity, createdBy, force, vertical } = parsed.data;
  // Steg C2: set true only when this request actually reserved a daily-cap
  // slot (i.e. the resend_send/claude/!force guard block below ran and its
  // reservation succeeded) — gates the compensating decrement on send
  // failure further down so a bypassed (force/daniel) or non-resend_send
  // call, which never reserved anything, never decrements someone else's day.
  let capReservedToday: string | null = null;

  try {
    // ─── Global outreach kill-switch (P0-2026-07-11) ────────────
    // When OUTREACH_PAUSED=true, block the automated cold-outreach channel
    // (claude-actor resend_send). Daniel's manual sends (createdBy='daniel') and
    // CS conversation replies are unaffected. Belt-and-suspenders with the gate,
    // which already returns 0 candidates when paused.
    if (isOutreachPaused() && intent === "resend_send" && createdBy === "claude") {
      return res.status(423).json({
        success: false,
        error: "outreach_paused",
        reason: "Cold outreach is paused (OUTREACH_PAUSED=true). Automated claude-actor sends are blocked until the flag is cleared.",
        override: "Pass createdBy=daniel and force=true for a manual override.",
      });
    }

    // ─── Phase 4.10c-3 — refined service-level rate-limit ───────
    // 2026-05-06 fix: original 4.10c-2 logic was too aggressive — it blocked
    // ALL outbound to a recipient if any out+sent existed in 24h. That broke
    // CS responses to legitimate inbound messages whenever marketing had
    // contacted the same address recently.
    //
    // New rule: only block COLD-OUTREACH duplicates. If the contact has
    // sent us an inbound message in the last 7 days, this compose is a
    // legitimate conversation response — do not rate-limit.
    if (intent === "resend_send" && createdBy === "claude" && !force) {
      // ─── Steg C2 — atomic daily send-cap reservation (most-general
      // guard first, matching the pause-check-first ordering above) ────
      // A pre-flight COUNT(*) against outreach_sent_log would NOT be atomic:
      // Node's event loop can interleave two /compose handlers across the
      // `await emailService.sendRaw(...)` below, so two concurrent requests
      // could each read count=49 < cap=50 before either has recorded a
      // send, letting both through and exceeding the cap. This single
      // synchronous better-sqlite3 statement (no await between the check
      // and the reservation) is what makes the cap atomic: the WHERE
      // clause on the UPDATE only lets the increment through when the
      // reservation is still under the cap, so a second concurrent caller
      // that races in gets `changes === 0` and is rejected.
      const dailyCap = resolveDailyOutreachCap();
      const today = todayUTC();
      const reservation = getDb().prepare(`
        INSERT INTO outreach_daily_send_cap (day, reserved_count) VALUES (?, 1)
        ON CONFLICT(day) DO UPDATE SET reserved_count = reserved_count + 1
          WHERE outreach_daily_send_cap.reserved_count < ?
      `).run(today, dailyCap);

      if (reservation.changes === 0) {
        return res.status(429).json({
          success: false,
          error: "daily_cap_reached",
          reason: `daily outreach cap reached: ${dailyCap} sent today (OUTREACH_MAX_PER_DAY=${dailyCap}) — try again after UTC midnight`,
          cap: dailyCap,
          override: "Pass createdBy=daniel and force=true to bypass (manual override)",
        });
      }
      capReservedToday = today;

      const lookback24h = new Date(Date.now() - 24 * 3600_000).toISOString();
      const lookback7d = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

      // Has the contact sent us anything inbound in the last 7 days?
      const hasRecentInbound = getDb().prepare(`
        SELECT 1 AS hit
        FROM crm_messages m
        JOIN crm_threads t ON t.id = m.thread_id
        JOIN crm_contacts c ON c.id = t.contact_id
        WHERE m.direction = 'in'
          AND LOWER(c.email) = LOWER(?)
          AND m.received_at >= ?
        LIMIT 1
      `).get(to, lookback7d) as { hit: number } | undefined;

      if (!hasRecentInbound) {
        // ─── Hard cooldown invariant (P0-2026-07-11) ─────────────
        // Belt-and-suspenders on the SEND path: even if a pool leak (like the
        // compose-thread bug) puts an already-contacted producer back into a
        // batch, the actual send is refused if outreach_sent_log shows we
        // emailed this address within the cooldown window. This is keyed on the
        // immutable recipient email, so it holds across agent_id churn. The pool
        // gate is the primary guard; this makes a double-send impossible even
        // when the gate is bypassed.
        //
        // NOTE: OUTREACH_COOLDOWN_DAYS must be <= the mode=second `cooldown_days`
        // the batch uses (both default 60). A legitimate second-touch is defined
        // as a send whose PRIOR contact is OUTSIDE the window, so with matched
        // windows this invariant never blocks it. If the env is set LARGER than
        // the batch window it fails safe (refuses the send, never double-sends) —
        // it can wedge a shortened second-touch campaign but cannot cause spam.
        const cooldownDays = Math.max(1, parseInt(String(process.env.OUTREACH_COOLDOWN_DAYS ?? "60"), 10) || 60);
        const cooldownCutoff = new Date(Date.now() - cooldownDays * 86400_000).toISOString();
        // steg 4, kriterium 4e: read vertical_id too. The cooldown is
        // deliberately CROSS-platform — both platforms send from the same
        // address, so to the recipient and their spam filter this is one
        // sender, and a per-vertical cooldown would let us cold-mail the same
        // human twice in a week. But that correct choice made the overlap
        // producers — gårdssalg people who are also RFB agents, i.e. the claim
        // campaign's best list — vanish behind a generic 429 that named no
        // cause. Naming the suppressing platform costs one column.
        const priorOutreach = getDb().prepare(`
          SELECT sent_at, vertical_id FROM outreach_sent_log
          WHERE recipient_email IS NOT NULL
            AND LOWER(recipient_email) = LOWER(?)
            AND sent_at >= ?
          ORDER BY sent_at DESC
          LIMIT 1
        `).get(to, cooldownCutoff) as { sent_at: string; vertical_id: string } | undefined;

        if (priorOutreach) {
          const byVertical = priorOutreach.vertical_id;
          const crossPlatform = isCrmVertical(byVertical) && byVertical !== vertical;
          return res.status(429).json({
            success: false,
            error: "cooldown_suppressed",
            reason:
              `already sent cold outreach to ${to} on ${priorOutreach.sent_at} — within the ${cooldownDays}-day ` +
              `cooldown (outreach_sent_log, email-keyed)` +
              (crossPlatform
                ? `. The suppressing send was on the ${byVertical} platform, not ${vertical} — this is the ` +
                  `cross-platform cooldown, which is intentional: both platforms send from the same address.`
                : ""),
            last_sent_at: priorOutreach.sent_at,
            suppressed_by_vertical: byVertical,
            cross_platform: crossPlatform,
            cooldown_days: cooldownDays,
            override: "Pass createdBy=daniel and force=true to bypass (manual override)",
          });
        }

        // Legacy 24h duplicate guard (kept as a fast secondary check on raw
        // crm_messages, e.g. sends not yet mirrored into outreach_sent_log).
        const recent = getDb().prepare(`
          SELECT m.id, m.thread_id, m.subject, m.sent_at
          FROM crm_messages m
          JOIN crm_threads t ON t.id = m.thread_id
          JOIN crm_contacts c ON c.id = t.contact_id
          WHERE m.direction = 'out'
            AND m.delivery_status = 'sent'
            AND LOWER(c.email) = LOWER(?)
            AND m.sent_at >= ?
          ORDER BY m.sent_at DESC
          LIMIT 5
        `).all(to, lookback24h) as Array<{ id: string; thread_id: string; subject: string; sent_at: string }>;

        if (recent.length > 0) {
          return res.status(429).json({
            success: false,
            error: "rate_limited",
            reason: `claude-actor already sent ${recent.length} cold-outreach email(s) to ${to} in the last 24h, and contact has no inbound in last 7 days`,
            last_sent_at: recent[0].sent_at,
            prior_thread_id: recent[0].thread_id,
            prior_subjects: recent.map((r) => r.subject),
            override: "Pass createdBy=daniel and force=true to bypass (manual override)",
          });
        }
      }
      // If hasRecentInbound: skip rate-limit — legitimate conversation response
    }

    // (original flow continues below)
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
      vertical,
    });

    const queued = crmService.enqueueOutbox({
      threadId,
      contactId,
      vertical,
      intent,
      toEmails: [to],
      subject,
      bodyText,
      bodyHtml,
      replyToMessageId: null,
      createdBy,
      // composeNewThread() above already created this message row — link
      // this outbox row to it explicitly so /outbox/:id/result resolves
      // THIS compose's message, not "most recent for thread" (wrong as
      // soon as a reply is queued on the same thread before this result
      // comes back). Mirrors recordOutboundReply()'s outboxId link on the
      // /threads/:id/send path.
      crmMessageId: messageId,
    });

    if (intent === "resend_send") {
      try {
        const composeIdentity = resolveCrmIdentity(vertical);
        const result = await emailService.sendRaw({
          to,
          subject,
          textContent: bodyText,
          htmlContent: bodyHtml ?? bodyText,
          from: crmFromHeader(vertical),
          replyTo: composeIdentity.replyTo,
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
        if (capReservedToday) {
          getDb().prepare(
            `UPDATE outreach_daily_send_cap SET reserved_count = MAX(0, reserved_count - 1) WHERE day = ?`
          ).run(capReservedToday);
        }
        return res.status(500).json({ success: false, error: result.error || "send failed", outboxId: queued.id, threadId });
      } catch (err: any) {
        crmService.markOutboxResult(queued.id, "failed", undefined, err.message ?? "exception");
        crmService.updateMessageDeliveryStatus(messageId, "failed");
        if (capReservedToday) {
          getDb().prepare(
            `UPDATE outreach_daily_send_cap SET reserved_count = MAX(0, reserved_count - 1) WHERE day = ?`
          ).run(capReservedToday);
        }
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

  // ─── steg 4: resolve the platform, or park ───────────────────
  //
  // Three cases, and none of them is a guess:
  //   • vertical only        → use it (pre-steg-4 behaviour, byte-identical)
  //   • signals only         → the SERVER derives it; undecidable → park
  //   • both                 → they must AGREE, otherwise park
  //
  // The both-case matters more than it looks. If a caller could send a
  // `vertical` alongside signals that say otherwise, the caller's value would
  // win — and the caller is an LLM. That would hand the decision straight back
  // to the actor this whole module exists to take it away from, through a door
  // nobody would think to test. Disagreement is a genuine triage event.
  const signals = parsed.data.routingSignals;
  let vertical: CrmVertical;

  if (signals !== undefined) {
    const outcome = deriveVertical(signals);

    const refusal: string | null = !outcome.routed
      ? outcome.reason
      : parsed.data.vertical !== undefined && parsed.data.vertical !== outcome.vertical
        ? `the caller asserted vertical=${JSON.stringify(parsed.data.vertical)} but the recipient headers ` +
          `derive ${JSON.stringify(outcome.vertical)} (${outcome.matchedAddress} in ${outcome.matchedIn}) — ` +
          `refusing to let an asserted value override the headers`
        : null;

    if (refusal !== null || !outcome.routed) {
      const first = parsed.data.messages[0];
      const parked = parkUntriaged({
        threadId: parsed.data.threadId,
        fromEmail: parsed.data.primaryFromEmail,
        subject: parsed.data.subject ?? null,
        snippet: first?.snippet ?? null,
        reason: refusal ?? "unroutable",
        signals,
        rawPayload: parsed.data,
      });
      // 202: accepted and durably recorded, but deliberately not filed. Not an
      // error — the agent did its job — and NOT 4xx, because the agent must not
      // retry it. `untriaged: true` is the field a caller branches on.
      return res.status(202).json({
        untriaged: true,
        untriagedId: parked.id,
        alreadyResolved: parked.alreadyResolved,
        reason: refusal ?? "unroutable",
        openUntriaged: countOpenUntriaged(),
      });
    }

    vertical = outcome.vertical;
  } else {
    // superRefine guarantees this branch has a vertical.
    vertical = parsed.data.vertical as CrmVertical;
  }

  let result;
  try {
    result = crmService.ingestThread(
      {
        threadId: parsed.data.threadId,
        subject: parsed.data.subject,
        category: parsed.data.category,
        severity: parsed.data.severity,
        messages: parsed.data.messages,
      },
      parsed.data.primaryFromEmail,
      vertical
    );
  } catch (err: any) {
    // Review B4: re-ingesting an existing thread under a DIFFERENT platform is
    // refused by the service. Surface it as 409 rather than letting it fall
    // through to a generic 500 — the CS agent needs to be able to tell "this
    // thread needs human triage" from "the backend is broken", and it retries
    // on 5xx. Nothing was written when this fires.
    const msg = String(err?.message ?? "ingest failed");
    if (msg.includes("already belongs to vertical")) {
      // steg 4: a conflicting thread used to fail into the agent's own log and
      // nowhere else — the dev-request flagged that gap explicitly. It now lands
      // in the same bucket as everything else undecidable, so it is countable
      // and appears in Daniel's queue. The 409 status is unchanged: the CS agent
      // retries on 5xx and must not retry this.
      const first = parsed.data.messages[0];
      const parked = parkUntriaged({
        threadId: parsed.data.threadId,
        fromEmail: parsed.data.primaryFromEmail,
        subject: parsed.data.subject ?? null,
        snippet: first?.snippet ?? null,
        reason: msg,
        signals: signals ?? { assertedVertical: vertical },
        rawPayload: parsed.data,
      });
      return res.status(409).json({
        error: "thread vertical conflict",
        detail: msg,
        untriaged: true,
        untriagedId: parked.id,
        openUntriaged: countOpenUntriaged(),
      });
    }
    return res.status(500).json({ error: msg });
  }

  // If contactName provided and contact was just created, set name
  if (parsed.data.contactName) {
    const db = getDb();
    db.prepare("UPDATE crm_contacts SET name = COALESCE(name, ?) WHERE id = ?")
      .run(parsed.data.contactName, result.contactId);
  }

  res.json(result);
});

// ─── GET /admin/crm/untriaged ────────────────────────────────
//
// Daniel's queue of mail the server refused to route. Open items only unless
// ?includeResolved=1. This is the whole point of steg 4: the undecidable case
// is a countable list somebody looks at, not a message that quietly vanished.
router.get("/untriaged", (req, res) => {
  const includeResolved = String(req.query.includeResolved ?? "") === "1";
  const limit = parseInt(String(req.query.limit ?? "100"), 10) || 100;
  const rows = listUntriaged({ includeResolved, limit });
  res.json({
    open: countOpenUntriaged(),
    items: rows.map((r) => ({
      ...r,
      signals: safeJson(r.signals),
      raw_payload: undefined, // large; fetch the single item to see it
      status: r.resolved_at === null ? "open" : r.resolved_vertical ? "assigned" : "dismissed",
    })),
  });
});

// ─── GET /admin/crm/untriaged/:id ────────────────────────────
router.get("/untriaged/:id", (req, res) => {
  const row = getUntriaged(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({
    ...row,
    signals: safeJson(row.signals),
    raw_payload: safeJson(row.raw_payload),
    status: row.resolved_at === null ? "open" : row.resolved_vertical ? "assigned" : "dismissed",
  });
});

// ─── POST /admin/crm/untriaged/:id/assign ────────────────────
//
// A human names the platform. The stored payload is then replayed through the
// ORDINARY ingest path — same crmService.ingestThread, same fail-closed guard —
// so an assigned thread is written by exactly the code that writes a thread
// that routed cleanly. There is no second, less-exercised way into the CRM.
//
// Marking resolved happens only AFTER the ingest succeeds. If the replay throws
// (a vertical conflict, say), the item stays open and Daniel sees why, rather
// than the row being closed on a write that never happened.
router.post("/untriaged/:id/assign", (req, res) => {
  const schema = z.object({
    vertical: z.enum(CRM_VERTICALS),
    resolvedBy: z.string().min(1).default("daniel"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });

  const row = getUntriaged(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  if (row.resolved_at !== null) {
    return res.status(409).json({ error: "already resolved", resolved_at: row.resolved_at, resolved_vertical: row.resolved_vertical });
  }

  const payload = safeJson(row.raw_payload) as any;
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return res.status(422).json({
      error: "stored payload is not replayable",
      detail: "raw_payload has no messages array; assign cannot reconstruct the thread",
    });
  }

  let result;
  try {
    result = crmService.ingestThread(
      {
        threadId: row.thread_id,
        subject: payload.subject ?? null,
        category: payload.category,
        severity: payload.severity,
        messages: payload.messages,
      },
      row.from_email,
      parsed.data.vertical,
    );
  } catch (err: any) {
    return res.status(409).json({ error: "replay failed — item left open", detail: String(err?.message ?? err) });
  }

  markUntriagedResolved(req.params.id, parsed.data.vertical, parsed.data.resolvedBy);
  res.json({ success: true, vertical: parsed.data.vertical, ...result, openUntriaged: countOpenUntriaged() });
});

// ─── POST /admin/crm/untriaged/:id/dismiss ───────────────────
//
// Not everything unroutable belongs in the CRM — spam, newsletters, a bounce.
// Without this the bucket only grows, and a queue that only grows is one nobody
// reads, which is the same silence by a slower route. Dismissed is
// `resolved_at IS NOT NULL AND resolved_vertical IS NULL`; nothing is deleted.
router.post("/untriaged/:id/dismiss", (req, res) => {
  const schema = z.object({
    reason: z.string().min(1),
    resolvedBy: z.string().min(1).default("daniel"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });

  const row = getUntriaged(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });

  const ok = markUntriagedResolved(req.params.id, null, `${parsed.data.resolvedBy}: ${parsed.data.reason}`);
  if (!ok) return res.status(409).json({ error: "already resolved", resolved_at: row.resolved_at });
  res.json({ success: true, dismissed: true, openUntriaged: countOpenUntriaged() });
});

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return { unparseable: s.slice(0, 500) };
  }
}

// ═══ steg 5 — retro-tagging the mis-filed history ════════════
//
// «Dry-run default … Apply krever Daniels godkjenning av tallet … Audit +
//  reverserbart per rad/batch. ALDRI en blind UPDATE på historikk.»
//
// GET is the dry-run and is the only thing that runs by default. There is no
// `?apply=true` on the read route on purpose: a destructive default one typo
// away from a read is how blind UPDATEs happen.

// ─── GET /admin/crm/retro-tagging/plan ───────────────────────
router.get("/retro-tagging/plan", (req, res) => {
  const limit = parseInt(String(req.query.limit ?? "5000"), 10) || 5000;
  const full = String(req.query.full ?? "") === "1";
  const plan = planRetroTagging({ limit });
  res.json({
    ...plan,
    // The per-row list is the point of the dry-run — Daniel has to be able to
    // spot-check the evidence — but it is capped by default so a 1,400-thread
    // scan does not return a wall. ?full=1 returns everything.
    candidates: full ? plan.candidates : plan.candidates.slice(0, 50),
    candidates_truncated: !full && plan.candidates.length > 50,
    how_to_apply:
      "POST /admin/crm/retro-tagging/apply with {approvedFingerprint, approvedCount, approvedBy}. " +
      "Both must match this plan exactly, or the apply is refused.",
  });
});

// ─── POST /admin/crm/retro-tagging/apply ─────────────────────
router.post("/retro-tagging/apply", (req, res) => {
  const schema = z.object({
    approvedFingerprint: z.string().min(1),
    approvedCount: z.number().int().min(0),
    approvedBy: z.string().min(1),
    limit: z.number().int().min(1).max(20000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });

  try {
    const result = applyRetroTagging(parsed.data);
    return res.json({ success: true, ...result });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // 409, not 500: a refused apply is the gate working, not the backend
    // failing, and the caller must not retry it unchanged.
    if (msg.includes("plan changed") || msg.includes("approved count")) {
      return res.status(409).json({ success: false, error: "approval_stale", detail: msg });
    }
    return res.status(500).json({ success: false, error: msg });
  }
});

// ─── GET /admin/crm/retro-tagging/batches ────────────────────
router.get("/retro-tagging/batches", (_req, res) => {
  res.json({ batches: listRetroBatches() });
});

// ─── POST /admin/crm/retro-tagging/batches/:id/revert ────────
router.post("/retro-tagging/batches/:id/revert", (req, res) => {
  try {
    return res.json({ success: true, batchId: req.params.id, ...revertRetroTaggingBatch(req.params.id) });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("no audit rows")) return res.status(404).json({ success: false, error: msg });
    return res.status(500).json({ success: false, error: msg });
  }
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
  //
  // ─── steg 4, kriterium 4f ────────────────────────────────────
  //
  // A measured fact about TODAY, not a future gap: steg 3 put the display name
  // and reply-to on the `resend_send` path, but `gmail_draft` is the intent the
  // CS agent actually consumes, and that path goes out through Daniel's own
  // Gmail — the code cannot set From. It could still tell the agent what the
  // reply-to should be, and it did not. So the majority of CRM replies leave
  // with no platform identity at all, and the funn-4 inbound discriminator is
  // lost on exactly the busiest path.
  //
  // The row already carries vertical_id (steg 1) — `SELECT *` returned it and
  // nobody read it. What was missing is the derived identity, so the agent does
  // not have to keep its own copy of the mapping (a second source of truth for
  // which address belongs to which platform is how they drift apart).
  //
  // resolveCrmIdentity THROWS on an unconfigured vertical. Catching per-item
  // rather than per-request is deliberate: one bad row must not blank the whole
  // queue, and `identity_error` on that row is louder than a missing field.
  const parsed = items.map((i: any) => {
    const base = {
      ...i,
      to_emails: JSON.parse(i.to_emails || "[]"),
      cc_emails: JSON.parse(i.cc_emails || "[]"),
    };
    try {
      const identity = resolveCrmIdentity(i.vertical_id);
      return {
        ...base,
        vertical_id: i.vertical_id,
        from_display_name: identity.displayName,
        from_header: crmFromHeader(i.vertical_id),
        reply_to: identity.replyTo,
      };
    } catch (err: any) {
      return { ...base, identity_error: String(err?.message ?? err) };
    }
  });
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
  const row = db.prepare("SELECT thread_id, contact_id, intent, created_by, crm_message_id FROM crm_outbox WHERE id = ?").get(req.params.id) as any;
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
    // Applies to BOTH a /compose call (which leaves a 'queued' message row)
    // AND a gmail_draft reply from POST /threads/:id/send (dev-request
    // 2026-08-09-cs-rutine-to-plattformer-og-tradhistorikk, skive 1 —
    // recordOutboundReply() now leaves the same 'queued' row for a reply,
    // where before this fix no crm_messages row existed for a reply at all
    // and this lookup was a guaranteed no-op on that path).
    //
    // Bug fix (post-review): getLatestOutboundMessageId(threadId) picks the
    // thread's most-recent outbound crm_messages row with NO link back to
    // which outbox row produced it. That was safe before this PR (only a
    // brand-new thread ever got a single 'queued' message at a time), but
    // recordOutboundReply() now also leaves 'queued' rows for replies on
    // EXISTING threads — so a thread can have several outstanding queued
    // replies at once, and "most recent" can name the WRONG one when
    // results come back out of order (confirmed: two gmail_draft replies
    // queued on the same thread, resolving outbox-item-2 first updated
    // message 1 instead, leaving message 2 stuck at 'queued' forever).
    //
    // Fix: crm_outbox.crm_message_id (populated by recordOutboundReply()
    // when it's given this outbox row's id — see POST /threads/:id/send)
    // is the explicit, unambiguous link for every row created going
    // forward. getLatestOutboundMessageId is kept ONLY as a fallback for
    // outbox rows that predate this column (e.g. rows from before this
    // migration shipped) — those still behave exactly as before.
    const msgId = row.crm_message_id ?? crmService.getLatestOutboundMessageId(row.thread_id);
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
    // Phase 4.10c-2 Steg 2 — contact_email filter for the CS-agent dual-source guard.
    // Used by the agent to check "has this recipient gotten ANY outbound from us
    // in the lookback window?" before deciding to send a confirmation.
    const contactEmail = (req.query.contact_email as string | undefined)?.trim().toLowerCase();
    if (contactEmail) {
      messages = messages.filter((m) => (m.contact_email || "").toLowerCase() === contactEmail);
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

    // Steg C3 — surface today's daily-cap reservation state alongside the
    // sent-log so the daily brief can show it without a separate endpoint.
    // Purely additive to the existing response shape.
    const dailyCap = resolveDailyOutreachCap();
    const capRow = getDb().prepare(
      `SELECT reserved_count FROM outreach_daily_send_cap WHERE day = ?`
    ).get(todayUTC()) as { reserved_count: number } | undefined;
    const sentToday = capRow?.reserved_count ?? 0;

    res.json({
      success: true,
      count: messages.length,
      messages,
      summary: { by_actor: byActor, by_channel: byChannel, by_status: byStatus },
      filters: { since_hours: sinceHours ?? "all", channel: channel ?? "all", actor: actor ?? "all", status: statusFilter ?? "all", contact_email: contactEmail ?? "all" },
      generated_at: new Date().toISOString(),
      sent_today: sentToday,
      cap: dailyCap,
      remaining_today: Math.max(0, dailyCap - sentToday),
    });
  } catch (err: any) {
    res.status(500).json({ error: "sent_log_failed", detail: err.message });
  }
});

// ─── POST /admin/crm/backfill-last-outbound (Phase 4.10c-2 Steg 0) ───
// One-shot remediation: set crm_threads.last_outbound_at on every thread
// that has at least one out-message with delivery_status='sent' but a NULL
// last_outbound_at. Idempotent — safe to re-run; only updates rows where
// NULL → MAX(sent_at). Replaced by Steg 1 trigger going forward.
//
// Origin: orchestrator work-order #2 (run-2026-05-03T1940-platform-orchestrator-rfb).
router.post("/backfill-last-outbound", (_req, res) => {
  try {
    const db = getDb();
    const beforeRow = db.prepare(`
      SELECT COUNT(*) AS n FROM crm_threads t
      WHERE t.last_outbound_at IS NULL
        AND EXISTS (
          SELECT 1 FROM crm_messages m
          WHERE m.thread_id = t.id AND m.direction = 'out' AND m.delivery_status = 'sent'
        )
    `).get() as { n: number };

    const result = db.prepare(`
      UPDATE crm_threads
      SET last_outbound_at = (
            SELECT MAX(sent_at)
            FROM crm_messages
            WHERE crm_messages.thread_id = crm_threads.id
              AND direction = 'out'
              AND delivery_status = 'sent'
          ),
          updated_at = datetime('now')
      WHERE last_outbound_at IS NULL
        AND EXISTS (
          SELECT 1 FROM crm_messages
          WHERE crm_messages.thread_id = crm_threads.id
            AND direction = 'out'
            AND delivery_status = 'sent'
        )
    `).run();

    const afterRow = db.prepare(`
      SELECT COUNT(*) AS n FROM crm_threads t
      WHERE t.last_outbound_at IS NULL
        AND EXISTS (
          SELECT 1 FROM crm_messages m
          WHERE m.thread_id = t.id AND m.direction = 'out' AND m.delivery_status = 'sent'
        )
    `).get() as { n: number };

    res.json({
      success: true,
      rows_updated: result.changes,
      threads_remaining_with_null_outbound_but_sent_messages: afterRow.n,
      threads_pre_backfill: beforeRow.n,
      acceptance_passed: afterRow.n === 0,
    });
  } catch (err: any) {
    res.status(500).json({ error: "backfill_failed", detail: err.message });
  }
});

export default router;
