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
  isAutoDismissedSender,
} from "../services/crm-triage";
import { emailService, GARDSSALG_OUTREACH_FROM_NAME } from "../services/email-service";
import { plainTextToEmailHtml } from "../utils/plain-text-to-html";
import { getDb } from "../database/init";
import { isOutreachPaused } from "./admin-outreach-candidates";
import { unsubscribeHeaderValues } from "../services/avmeld-service";
import { getOutreachMaxTouchVernConfig, getMaxTouchStatusForEmail } from "../services/outreach-max-touch-vern";
import {
  classifyAutomated,
  classifyForwardCopy,
  csInboundServerIngestEnabled,
  forwardCopyMarker,
  inboundLogAutomatedKind,
  inboundLogExists,
  isOurPlatformAddress,
  readInboundHeaders,
  recordThreadAlias,
  resolveThreadAlias,
  serverThreadForMarker,
  stripForwardSubject,
} from "../services/cs-inbound";
import { computeNeedsReply, markNoReplyNeeded } from "../services/crm-needs-reply";
import { buildDailyDigest, csDailyDigestEnabled, csWatchdogEnabled, INBOUND_LOG_RETENTION_DAYS } from "../services/cs-watchdog";
import { csChangeRequestsEnabled } from "../services/cs-change-requests";
import { contactReceiptEnabled } from "../services/contact-form-cs";
import {
  REPLY_KINDS,
  csAutosendEnabled,
  approveProposal,
  createReplyProposal,
  editProposal,
  getProposal,
  listProposals,
  rejectProposal,
  type ProposalStatus,
} from "../services/cs-reply-proposals";

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

// CS på serveren, S1a: a Gmail thread id the CS agent ingested as a copy of a
// server-registered e-mail is an ALIAS of the server thread
// (crm_thread_aliases). Every /threads/:id route resolves it, so the agent can
// keep using the id it knows. Ids without an alias pass through unchanged.
router.param("id", (req, _res, next, id) => {
  // Never throw here: a throw would skip the route entirely. req.path is a
  // getter on real Express requests but may be absent on hand-built ones.
  try {
    const p = typeof (req as any).path === "string" ? (req as any).path : String((req as any).url ?? "");
    if (p.startsWith("/threads/") && typeof id === "string" && id) {
      req.params.id = resolveThreadAlias(id);
    }
  } catch {
    // leave the id as given
  }
  next();
});

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

// ─── Max-touch-vern send-time invariant (dev-request 2026-08-29-outreach-
// max-touch-vern) ────────────────────────────────────────────────────────
// "Can't cause spam" — same philosophy as the branding lint above and the
// Hard cooldown invariant below, checked UNCONDITIONALLY on every send
// through this file, regardless of intent (resend_send/gmail_draft),
// createdBy (claude/daniel), or force. This is deliberately NOT scoped the
// way the hard-cooldown/daily-cap checks further down are (resend_send +
// claude-only + !force): force=true and createdBy='daniel' bypass the
// COOLDOWN (a human overriding a heuristic timer), but max-touch-vern is a
// hard fact about the address — >= threshold sends, zero replies, ever —
// that no caller-supplied flag changes. There is no override.
//
// Address-based (services/outreach-max-touch-vern.ts): reads
// outreach_sent_log (any vertical, cross-platform by design — same reasoning
// as the cooldown invariant) and crm_messages for an inbound EVER, not
// windowed. A reply lifts suppression without touching the send-count log —
// getMaxTouchStatusForEmail() never writes anything, only reads.
//
// Returns the refusal payload (caller sends it as-is with res.status(429))
// or null when the address is clear to send to.
function checkMaxTouchVern(db: ReturnType<typeof getDb>, toEmail: string): Record<string, unknown> | null {
  const config = getOutreachMaxTouchVernConfig(db);
  const status = getMaxTouchStatusForEmail(db, toEmail, config);
  if (!status.suppressed) return null;
  return {
    success: false,
    error: "max_touch_suppressed",
    reason:
      `refusing to send to ${toEmail}: ${status.send_count} prior outreach_sent_log send(s) ` +
      `(any vertical) with ZERO inbound reply ever, meeting or exceeding the max-touch-vern ` +
      `threshold (${status.threshold}). This is a hard invariant, not a bypassable cooldown — ` +
      `force/createdBy do not override it. An inbound reply from this address lifts the ` +
      `suppression (the send-count log itself is never reset).`,
    to: toEmail,
    send_count: status.send_count,
    threshold: status.threshold,
    last_sent_at: status.last_sent_at,
  };
}

// ─── From display-name override on POST /threads/:id/send ───────────────────
// A reply (e.g. a thank-you) on a thread that STARTED with a cold outreach mail
// must carry the same sender name as that outreach, or the producer sees the
// conversation switch from "Daniel Fredriksen" to "Opplevagent" mid-thread.
// Allow-listed, exact match: only the name(s) the cold outreach is actually
// sent as (GARDSSALG_OUTREACH_FROM_NAME is used by both the gårdssalg and the
// RFB outreach lanes). Anything else — including the empty string — is a 400,
// so this cannot be used to send as an arbitrary display name. Only the
// display name changes; the address and reply-to stay the thread platform's.
const SEND_FROM_DISPLAY_NAME_ALLOW_LIST: readonly string[] = [GARDSSALG_OUTREACH_FROM_NAME];

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
    fromDisplayName: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.fromDisplayName !== undefined && !SEND_FROM_DISPLAY_NAME_ALLOW_LIST.includes(data.fromDisplayName)) {
      ctx.addIssue({
        code: "custom",
        path: ["fromDisplayName"],
        message:
          `fromDisplayName ${JSON.stringify(data.fromDisplayName)} is not allowed — only the outreach sender ` +
          `name(s) ${JSON.stringify(SEND_FROM_DISPLAY_NAME_ALLOW_LIST)} may be used (exact match; omit the field ` +
          `to send with the thread platform's own display name).`,
      });
    }
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
  const allowed = ["new", "in_progress", "awaiting_review", "awaiting_confirmation", "awaiting_grace", "done", "archived"] as const;

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
    // awaiting_confirmation/awaiting_grace: the two B3 opt-out steps
    // (scheduled-agents/rfb-customer-service.md line 664/670) — added
    // 2026-09-16, dev-request 2026-09-14-crm-thread-status-enum-mangler-
    // b3-opt-out-verdier. Until then the SKILL prescribed these two values
    // but this endpoint 400'd on both, so B3 always fell back to
    // awaiting_review.
    status: z.enum(["new", "in_progress", "awaiting_review", "awaiting_confirmation", "awaiting_grace", "done", "archived"]),
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
// fromDisplayName (optional, allow-listed) only affects resend_send: crm_outbox has no
// From column, so the override is not carried to a gmail_draft (no schema change here).
router.post("/threads/:id/send", async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  const { intent, toEmails, ccEmails, subject, bodyText, bodyHtml, replyToMessageId, createdBy, fromDisplayName } = parsed.data;
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

  // ─── Max-touch-vern (dev-request 2026-08-29-outreach-max-touch-vern) ────
  // Unconditional — see checkMaxTouchVern() above. Checked against EVERY
  // recipient in toEmails; the first suppressed address refuses the whole
  // send (a reply on this thread is not, by itself, proof the OTHER
  // recipients on a multi-recipient send have ever replied).
  for (const addr of toEmails) {
    const maxTouchRefusal = checkMaxTouchVern(db, addr);
    if (maxTouchRefusal) {
      return res.status(429).json(maxTouchRefusal);
    }
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
        htmlContent: bodyHtml ?? plainTextToEmailHtml(bodyText),
        inReplyToMessageId: replyToMessageId ?? undefined,
        // fromDisplayName is already allow-listed by sendSchema; undefined
        // keeps the platform display name. Address + reply-to unchanged.
        from: crmFromHeader(thread.vertical_id, fromDisplayName),
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
          payload: {
            outboxId: queued.id, messageId: result.messageId, channel: "resend_smtp", internalMessageId: reserved.messageId,
            ...(fromDisplayName !== undefined ? { fromDisplayName } : {}),
          },
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
// parse the env var identically. Exported (dev-request 2026-09-19-rfb-
// marketing-utsending-inn-i-plattformjobben) so the platform-side daily RFB
// send reads the SAME cap when it sizes its own budget.
export function resolveDailyOutreachCap(): number {
  return Math.max(1, parseInt(String(process.env.OUTREACH_MAX_PER_DAY ?? "50"), 10) || 50);
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── executeCompose — the POST /compose guard chain + send, as a function ───
//
// dev-request 2026-09-19-rfb-marketing-utsending-inn-i-plattformjobben: the
// body of POST /compose, extracted verbatim so the platform-side daily RFB
// send (services/rfb-marketing-daily.ts) goes through the EXACT guard chain
// the marketing routine's compose calls went through — max-touch-vern, the
// OUTREACH_PAUSED kill-switch, the OUTREACH_MAX_PER_DAY reservation, the
// inbound/untriaged exemption, the email-keyed cooldown, the 24h raw-send
// guard, the queued crm_messages row written before the send, the outbox row,
// the platform identity (From/Reply-To), and the queued→sent flip whose
// trigger records outreach_sent_log. One implementation, not a copy.
//
// `rawBody` is validated by composeSchema exactly as the route did (a 400
// outcome on failure). `httpStatus` + `body` are what the route answers with,
// byte-identical to the pre-extraction handler. `delivery` /
// `transportAttempted` / `postSendError` are NOT part of the HTTP response —
// they tell a non-HTTP caller what actually happened on the wire, which the
// status code alone cannot: a transport-accepted email whose post-send
// bookkeeping write then threw still answers 500 here (unchanged route
// behaviour), but it WAS sent, and a caller that must never re-send has to
// know that.
function coldUnsubscribeOptions(to: string): { listUnsubscribe?: string; listUnsubscribePost?: string } {
  const h = unsubscribeHeaderValues(to);
  return h ? { listUnsubscribe: h.listUnsubscribe, listUnsubscribePost: h.listUnsubscribePost } : {};
}

export type ComposeRequest = z.infer<typeof composeSchema>;

export type ComposeSendRaw = (
  options: Parameters<typeof emailService.sendRaw>[0],
) => ReturnType<typeof emailService.sendRaw>;

export interface ComposeDeps {
  /** Transport seam — defaults to emailService.sendRaw (the route always uses the default). */
  sendRaw?: ComposeSendRaw;
  /**
   * Display name for From (address and Reply-To unchanged). Only a trusted
   * in-process caller can set it — it is deliberately NOT part of composeSchema,
   * so the HTTP route cannot. dev-request 2026-10-22-rfb-utsending-v4.
   */
  fromDisplayName?: string;
  /** Message-ID of the first mail: sent as In-Reply-To/References so the follow-up threads. */
  inReplyToMessageId?: string;
  /** Extra raw_metadata on the CRM message row (template, subject_arm, …). */
  messageMetadata?: Record<string, unknown>;
}

export interface ComposeOutcome {
  /** HTTP status POST /admin/crm/compose answers with. */
  httpStatus: number;
  /** JSON body POST /admin/crm/compose answers with. */
  body: Record<string, unknown>;
  /**
   * "sent": the transport accepted the email (even if a later bookkeeping
   * write threw — see postSendError). "not_sent": refused by a guard, failed
   * before the transport, or the transport reported failure — and in that
   * last case (`transportAttempted: true`) delivery is NOT known to have
   * failed: the server may have accepted the message before the connection
   * dropped, so an at-most-once caller must treat it as possibly delivered.
   * "draft_queued": gmail_draft intent — queued for the CS-agent, nothing sent.
   */
  delivery: "sent" | "not_sent" | "draft_queued";
  /** True once the transport was actually invoked for this request. */
  transportAttempted: boolean;
  /** Set when the transport accepted the email and a write AFTER that threw. */
  postSendError?: string;
}

//
// Synchronous where the route was synchronous: every outcome decided before
// the resend_send branch — the 400, each guard refusal, a failed write of the
// queued message/outbox rows, and the whole gmail_draft path — is RETURNED
// synchronously (a plain ComposeOutcome, not a Promise), so the route answers
// those in the same tick exactly as the handler did before the extraction.
// Only the resend_send branch returns a Promise (the await on the transport).
// Callers that do not care simply `await` the result either way.
export function executeCompose(rawBody: unknown, deps: ComposeDeps = {}): ComposeOutcome | Promise<ComposeOutcome> {
  const sendRaw: ComposeSendRaw = deps.sendRaw ?? ((options) => emailService.sendRaw(options));
  // Tracks what reached the wire, for ComposeOutcome.delivery — see above.
  let transportAttempted = false;
  let transportAccepted = false;
  const notSent = (httpStatus: number, body: Record<string, unknown>): ComposeOutcome => ({
    httpStatus,
    body,
    delivery: "not_sent",
    transportAttempted,
  });
  // The handler's outer catch (500 "compose failed"), shared by the
  // synchronous part and the send continuation below.
  const outerFailure = (err: any): ComposeOutcome => {
    const body = { success: false, error: err.message ?? "compose failed" };
    if (transportAccepted) {
      return { httpStatus: 500, body, delivery: "sent", transportAttempted, postSendError: String(err?.message ?? err) };
    }
    return notSent(500, body);
  };

  const parsed = composeSchema.safeParse(rawBody);
  if (!parsed.success) return notSent(400, { error: "invalid body", details: parsed.error.issues });
  const { to, contactName, subject, bodyText, bodyHtml, intent, category, severity, createdBy, force, vertical } = parsed.data;
  // Steg C2: set true only when this request actually reserved a daily-cap
  // slot (i.e. the resend_send/claude/!force guard block below ran and its
  // reservation succeeded) — gates the compensating decrement on send
  // failure further down so a bypassed (force/daniel) or non-resend_send
  // call, which never reserved anything, never decrements someone else's day.
  let capReservedToday: string | null = null;

  try {
    // ─── Max-touch-vern (dev-request 2026-08-29-outreach-max-touch-vern) ────
    // Unconditional — checked BEFORE the kill-switch/rate-limit/daily-cap
    // blocks below, and deliberately outside the `intent === 'resend_send' &&
    // createdBy === 'claude' && !force` guard those use: this is a hard fact
    // about the address (>= threshold sends, zero replies, ever), not a
    // bypassable cooldown — force/daniel do not override it. See
    // checkMaxTouchVern() above for the full rationale.
    const maxTouchRefusal = checkMaxTouchVern(getDb(), to);
    if (maxTouchRefusal) {
      return notSent(429, maxTouchRefusal);
    }

    // ─── Bounce/complaint suppression (owner decision 2026-09-29 «Blacklist
    // bounces») ─────────────────────────────────────────────────────────
    // Send-path twin of the outreach gate's is_hard_bounced: an address with a
    // hard bounce or spam complaint in email_bounces (fed automatically by
    // POST /webhooks/resend since this change) is never handed to Resend
    // again. Scoped to resend_send — the only intent that reaches the wire
    // from here (gmail_draft is a human-reviewed draft). Not scoped to claude:
    // a hard bounce is a fact about the address, like max-touch-vern above.
    // The one override is the explicit manual one (createdBy=daniel +
    // force=true) — kept because a misclassified bounce otherwise has no
    // escape hatch short of editing the table; Resend's own suppression list
    // may still drop it.
    if (intent === "resend_send" && !(createdBy === "daniel" && force)) {
      const bounced = getDb().prepare(`
        SELECT bounce_type, bounced_at FROM email_bounces
        WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) AND bounce_type IN ('hard', 'complaint', 'unsubscribe')
        ORDER BY id DESC LIMIT 1
      `).get(to) as { bounce_type: string; bounced_at: string } | undefined;
      if (bounced) {
        return notSent(409, {
          success: false,
          error: "recipient_bounced",
          reason:
            `refusing to send to ${to}: email_bounces has ${bounced.bounce_type === "complaint" ? "a spam complaint" : bounced.bounce_type === "unsubscribe" ? "an unsubscribe" : "a hard bounce"} ` +
            `for this address (${bounced.bounced_at}). Mailing it again hurts sender reputation for every platform.`,
          to,
          bounce_type: bounced.bounce_type,
          bounced_at: bounced.bounced_at,
          override: "Pass createdBy=daniel and force=true for a manual override.",
        });
      }
    }

    // ─── Global outreach kill-switch (P0-2026-07-11) ────────────
    // When OUTREACH_PAUSED=true, block the automated cold-outreach channel
    // (claude-actor resend_send). Daniel's manual sends (createdBy='daniel') and
    // CS conversation replies are unaffected. Belt-and-suspenders with the gate,
    // which already returns 0 candidates when paused.
    if (isOutreachPaused() && intent === "resend_send" && createdBy === "claude") {
      return notSent(423, {
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
        return notSent(429, {
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
      //
      // datetime(...) wrap: same fix as crm-service.ts's listSentMessages
      // since_hours filter (root cause: crm_messages.received_at is ALWAYS
      // written in SQLite's own "YYYY-MM-DD HH:MM:SS" format, but
      // `lookback7d` is a JS ISO-8601 string — a raw `>=` between the two
      // formats silently misjudges rows whose date falls on the same
      // calendar day as the cutoff).
      const hasRecentInbound = getDb().prepare(`
        SELECT 1 AS hit
        FROM crm_messages m
        JOIN crm_threads t ON t.id = m.thread_id
        JOIN crm_contacts c ON c.id = t.contact_id
        WHERE m.direction = 'in'
          AND LOWER(c.email) = LOWER(?)
          AND datetime(m.received_at) >= datetime(?)
        LIMIT 1
      `).get(to, lookback7d) as { hit: number } | undefined;

      // ─── crm_untriaged fallback (dev-request 2026-09-07-compose-cooldown-
      // suppressed-blokkerer-cs-svar-outreach — Kollerud incident) ──────────
      // Root cause: a reply delivered directly to Daniel's personal inbox
      // (not via a recognized platform alias — e.g. forwarded, or answered
      // from an address the recipient typed by hand instead of hitting
      // Reply) fails deriveVertical()'s header match in POST /ingest and is
      // parked into crm_untriaged by parkUntriaged() *instead of* being
      // written through crmService.ingestThread(). parkUntriaged() only
      // inserts into crm_untriaged — it never touches crm_messages /
      // crm_threads / crm_contacts (see database/init.ts's crm_untriaged
      // comment). hasRecentInbound above reads crm_messages exclusively, so
      // it is structurally blind to a genuine reply that landed here: no
      // amount of retuning its join or window closes this, because the row
      // it would need to see was never written. This is exactly what
      // happened live on 2026-09-07: elinkollerud@hotmail.com replied to the
      // platform's own outreach thread at 09:06Z (forwarded straight to
      // Daniel's inbox), POST /ingest parked it 202 untriaged, and the
      // subsequent /compose reply attempt was wrongly rejected
      // cooldown_suppressed even though the contact had unmistakably been in
      // touch since the last outbound.
      //
      // crm_untriaged.from_email is the same raw address the mail came
      // from, so a recent (same 7-day window, same case-insensitive email
      // match) untriaged row for this recipient is exactly as strong a
      // signal of "this contact is mid-conversation with us" as a routed
      // crm_messages row — it just has not been triaged to a thread yet.
      // Purely additive: this can only ever turn a false 429 into a correct
      // 200 (Acceptance Criterion 1). It never suppresses the cooldown
      // check below — a contact with NEITHER a crm_messages inbound NOR a
      // crm_untriaged row (a genuine, unsolicited repeat cold-send) still
      // falls through to it unchanged (Acceptance Criterion 2, non-goal).
      //
      // resolved_at/resolved_vertical filter: crm_untriaged rows are never
      // deleted (see database/init.ts's crm_untriaged comment — "Rows leave
      // only by an explicit human assignment"), and markUntriagedResolved()
      // (crm-triage.ts) can close a row two ways: promoted to a real
      // vertical (resolved_vertical set) or DISMISSED as not a genuine
      // reply — spam/autoreply/junk — which sets resolved_at but leaves
      // resolved_vertical NULL. A dismissed row is a human's explicit
      // verdict that this was never a reply at all, so it must NOT count as
      // "mid-conversation" evidence forever after. Only an open row
      // (resolved_at IS NULL, not yet reviewed) or one resolved BY
      // PROMOTION (resolved_vertical IS NOT NULL, i.e. confirmed as a real
      // reply) counts as a positive signal here.
      const hasRecentUntriagedInbound = hasRecentInbound
        ? undefined
        : (getDb().prepare(`
            SELECT 1 AS hit
            FROM crm_untriaged
            WHERE LOWER(from_email) = LOWER(?)
              AND datetime(created_at) >= datetime(?)
              AND (resolved_at IS NULL OR resolved_vertical IS NOT NULL)
            LIMIT 1
          `).get(to, lookback7d) as { hit: number } | undefined);

      if (!hasRecentInbound && !hasRecentUntriagedInbound) {
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
          return notSent(429, {
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
        //
        // datetime(...) wrap: same fix as above / crm-service.ts's
        // listSentMessages since_hours filter — crm_messages.sent_at is
        // written in BOTH SQLite's own format (updateMessageDeliveryStatus's
        // `datetime('now')`) and JS ISO format (recordOutboundReply's
        // `new Date().toISOString()`), and a raw `>=` against `lookback24h`
        // (JS ISO) silently misjudges the SQLite-format rows.
        const recent = getDb().prepare(`
          SELECT m.id, m.thread_id, m.subject, m.sent_at
          FROM crm_messages m
          JOIN crm_threads t ON t.id = m.thread_id
          JOIN crm_contacts c ON c.id = t.contact_id
          WHERE m.direction = 'out'
            AND m.delivery_status = 'sent'
            AND LOWER(c.email) = LOWER(?)
            AND datetime(m.sent_at) >= datetime(?)
          ORDER BY m.sent_at DESC
          LIMIT 5
        `).all(to, lookback24h) as Array<{ id: string; thread_id: string; subject: string; sent_at: string }>;

        if (recent.length > 0) {
          return notSent(429, {
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
      // If hasRecentInbound or hasRecentUntriagedInbound: skip rate-limit —
      // legitimate conversation response
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
      ...(deps.messageMetadata ? { extraMetadata: deps.messageMetadata } : {}),
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
      // The one await in the whole chain. Everything above ran synchronously in
      // the caller's tick, exactly as it did inside the route handler; this
      // continuation keeps the handler's inner try/catch AND its outer catch.
      return (async (): Promise<ComposeOutcome> => {
        try {
          try {
            const composeIdentity = resolveCrmIdentity(vertical);
            const sendOptions = {
              to,
              subject,
              textContent: bodyText,
              htmlContent: bodyHtml ?? plainTextToEmailHtml(bodyText),
              from: crmFromHeader(vertical, deps.fromDisplayName),
              replyTo: composeIdentity.replyTo,
              ...(deps.inReplyToMessageId ? { inReplyToMessageId: deps.inReplyToMessageId } : {}),
              // S1a point 3 (OUTREACH_UNSUBSCRIBE_ENABLED, default off): cold RFB
              // outreach carries List-Unsubscribe + One-Click. Spread, so the
              // options are identical to before when off / not cold outreach.
              ...(vertical === "rfb" && category === "marketing" && createdBy === "claude"
                ? coldUnsubscribeOptions(to)
                : {}),
            };
            transportAttempted = true;
            const result = await sendRaw(sendOptions);
            if (result.success) {
              transportAccepted = true;
              crmService.markOutboxResult(queued.id, "completed", result.messageId);
              crmService.updateMessageDeliveryStatus(messageId, "sent");
              crmService.logAction({
                threadId,
                contactId,
                type: "sent",
                actor: createdBy,
                payload: { outboxId: queued.id, messageId: result.messageId, channel: "resend_smtp", composedNew: true, internalMessageId: messageId },
              });
              return {
                httpStatus: 200,
                body: {
                  success: true,
                  threadId,
                  contactId,
                  outboxId: queued.id,
                  messageId: result.messageId,
                  channel: "resend_smtp",
                },
                delivery: "sent",
                transportAttempted,
              };
            }
            crmService.markOutboxResult(queued.id, "failed", undefined, result.error || "send failed");
            crmService.updateMessageDeliveryStatus(messageId, "failed");
            if (capReservedToday) {
              getDb().prepare(
                `UPDATE outreach_daily_send_cap SET reserved_count = MAX(0, reserved_count - 1) WHERE day = ?`
              ).run(capReservedToday);
            }
            return notSent(500, { success: false, error: result.error || "send failed", outboxId: queued.id, threadId });
          } catch (err: any) {
            // Unchanged route behaviour below, including when the transport had
            // already accepted the email and a post-send write threw — the
            // outcome's `delivery`/`postSendError` carry that fact to non-HTTP
            // callers (see the ComposeOutcome doc comment above).
            const sentThenFailed = transportAccepted;
            crmService.markOutboxResult(queued.id, "failed", undefined, err.message ?? "exception");
            crmService.updateMessageDeliveryStatus(messageId, "failed");
            if (capReservedToday) {
              getDb().prepare(
                `UPDATE outreach_daily_send_cap SET reserved_count = MAX(0, reserved_count - 1) WHERE day = ?`
              ).run(capReservedToday);
            }
            const body = { success: false, error: err.message ?? "exception", threadId };
            if (sentThenFailed) {
              return { httpStatus: 500, body, delivery: "sent", transportAttempted, postSendError: String(err?.message ?? err) };
            }
            return notSent(500, body);
          }
        } catch (err: any) {
          return outerFailure(err);
        }
      })();
    }

    // gmail_draft path: leave delivery_status as 'queued' here.
    // It transitions to 'draft_in_gmail' once the CS-agent picks up the
    // outbox item and reports back via /outbox/:id/result.

    return {
      httpStatus: 200,
      body: {
        success: true,
        threadId,
        contactId,
        outboxId: queued.id,
        intent: "gmail_draft",
        note: "Queued — will appear in your Gmail Drafts after next CS-agent run.",
      },
      delivery: "draft_queued",
      transportAttempted,
    };
  } catch (err: any) {
    return outerFailure(err);
  }
}

router.post("/compose", async (req, res) => {
  const result = executeCompose(req.body);
  // Answered in the same tick when no send is involved (see executeCompose).
  const outcome = result instanceof Promise ? await result : result;
  return res.status(outcome.httpStatus).json(outcome.body);
});

/**
 * dev-request 2026-09-16-crm-ingest-alias-gate-autoroute (FUNN
 * crm-ingest-alias-gate-blokkerer-ekte-eierrettelser): a reply from a sender
 * already on file as a known contact of exactly ONE vertical is not the same
 * kind of "cannot tell" as a message with no recognizable recipient at all —
 * it just arrived somewhere other than a platform alias (forwarded, replied
 * to Daniel's personal inbox, cc-only, etc). classifyEmail() already has the
 * exact/domain matching this needs, dispatched per vertical (dental has no
 * entity table and is deliberately not tried). Returns the single vertical to
 * auto-route to, or null if neither/both verticals produced a producer match
 * — the same "a coin flip is not a decision" discipline
 * ambiguous_platform_addresses already applies to header conflicts.
 */
function autoRouteByKnownContact(fromEmail: string): CrmVertical | null {
  const rfbHit = crmService.classifyEmail(fromEmail, "rfb").type === "producer";
  const experiencesHit = crmService.classifyEmail(fromEmail, "experiences").type === "producer";
  if (rfbHit === experiencesHit) return null; // neither, or both — stay parked, don't guess
  return rfbHit ? "rfb" : "experiences";
}

// ─── POST /admin/crm/ingest ──────────────────────────────────
// Called by the CS-agent each run with new/updated threads.
router.post("/ingest", (req, res) => {
  const parsed = ingestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });

  // ─── CS på serveren, S1a: the Gmail copy of a server-registered e-mail ──
  // The server already registered the original (cs-inbound). Its forwarded
  // Gmail copy is an inbound message with subject «[Innkommende] …» whose own,
  // UNQUOTED text carries "Inbound-ID: inb-…" (forwardCopyMarker). That copy is
  // NOT filed again: when it is the FIRST message of the Gmail thread, the
  // Gmail thread id becomes an alias of the server thread and the other
  // messages (Daniel's Gmail reply, the customer's answer to it) are filed
  // there. A Gmail thread id that is already an alias goes straight to its
  // server thread. A quoted marker (a reply), a «Fwd:» of the copy, or a copy
  // that is not the thread's first message never creates an alias. Routing is
  // skipped only on this path — the server decided the platform when it
  // registered the original.
  {
    let canonical: { threadId: string; vertical: string; contactId: string } | null = null;
    let parkedLogId: string | null = null;
    // Strict: a failed lookup answers 500 (the caller retries) instead of
    // filing the messages on the Gmail thread id.
    let aliasTarget: string;
    try {
      aliasTarget = resolveThreadAlias(parsed.data.threadId, { strict: true });
    } catch (err: any) {
      return res.status(500).json({ error: `alias lookup failed: ${String(err?.message ?? err)}` });
    }
    if (aliasTarget !== parsed.data.threadId) {
      const t = getDb().prepare("SELECT id, vertical_id, contact_id FROM crm_threads WHERE id = ?").get(aliasTarget) as
        | { id: string; vertical_id: string; contact_id: string }
        | undefined;
      if (t) canonical = { threadId: t.id, vertical: t.vertical_id, contactId: t.contact_id };
    }
    // The thread's first message: the earliest by sentAt when every message
    // carries one, otherwise the first in the payload (Gmail's own order).
    // Only this message can make the Gmail thread id a new alias.
    const msgs = parsed.data.messages;
    const times = msgs.map((m) => (m.sentAt ? Date.parse(m.sentAt) : NaN));
    const first = times.every((t) => Number.isFinite(t)) ? msgs[times.indexOf(Math.min(...times))] : msgs[0];
    // The Gmail thread subject may stand in for a missing per-message subject
    // only for a message SENT FROM one of our own platform addresses (the
    // forward is) — never for a customer's reply, which may carry an old
    // marker unquoted in its history. Decided per message, so a re-sent
    // aliased thread recognises its subject-less copy too.
    const copyIdOf = (m: (typeof parsed.data.messages)[number]): string | null =>
      forwardCopyMarker(m, isOurPlatformAddress(m.fromEmail) ? parsed.data.subject : undefined);
    const firstCopyId = copyIdOf(first);
    if (!canonical) {
      const logId = firstCopyId;
      if (logId) {
        const hit = serverThreadForMarker(logId);
        if (hit?.kind === "thread") canonical = { threadId: hit.threadId, vertical: hit.vertical, contactId: hit.contactId };
        else if (hit?.kind === "untriaged") parkedLogId = logId;
      }
    }
    // A copy is kept (filed here) only when its log row says the server did
    // NOT file that e-mail (flag off, registration error) — then it is the
    // only record. A copy the server filed (thread or parked) is left out, and
    // so is one whose log row was purged after 90 days (it was handled then;
    // filing it now would be a duplicate). The subject fallback in copyIdOf
    // applies only to a message sent from one of our own addresses, so a
    // customer's plain-text reply carrying the marker unquoted is still filed.
    // A missing log row means "purged after the retention window" ONLY when
    // the copy itself is that old. A recent copy with no row (restored backup,
    // a log insert that failed) is filed — a duplicate beats a lost e-mail.
    const purgedLongAgo = (m: (typeof parsed.data.messages)[number]): boolean => {
      const t = m.sentAt ? Date.parse(m.sentAt) : NaN;
      return Number.isFinite(t) && Date.now() - t > (INBOUND_LOG_RETENTION_DAYS - 7) * 86400_000;
    };
    const serverFiled = (m: (typeof parsed.data.messages)[number]): boolean => {
      const id = copyIdOf(m);
      if (id === null) return false;
      if (!inboundLogExists(id)) return purgedLongAgo(m);
      return serverThreadForMarker(id) !== null;
    };
    if (canonical) {
      const target = canonical;
      // Reads first (a DB error here throws before anything is written).
      const rest = parsed.data.messages.filter((m) => !serverFiled(m));
      let newMessages = 0;
      // The alias, the messages and the reopen are one transaction: a DB error
      // anywhere answers 500 with nothing written, and the retry does it all.
      try {
        getDb().transaction(() => {
          recordThreadAlias(parsed.data.threadId, target.threadId, "cs_gmail_copy");
          if (rest.length === 0) return;
          const existed = new Set(
            (getDb()
              .prepare(`SELECT id FROM crm_messages WHERE id IN (${rest.map(() => "?").join(",")})`)
              .all(...rest.map((m) => m.messageId)) as Array<{ id: string }>).map((r) => r.id),
          );
          // The contact is the server thread's own — never whatever primaryFromEmail
          // the caller sent (on a forwarded copy that is often our own address).
          const contact = getDb().prepare("SELECT email FROM crm_contacts WHERE id = ?").get(target.contactId) as { email: string } | undefined;
          // A NEW inbound message from a person (e.g. the customer answering
          // Daniel's Gmail reply directly) reopens a done/archived thread, as on
          // the server path. Never Daniel's own reply, never an already-filed
          // message, never an auto-reply or bounce.
          const newHumanIn = rest.some((m) => {
            if (existed.has(m.messageId) || m.direction !== "in" || m.rawMetadata?.automated === true) return false;
            const headers = readInboundHeaders(m.rawMetadata ?? {});
            const cid = copyIdOf(m);
            if (!cid) return classifyAutomated({ subject: stripForwardSubject(m.subject ?? null), fromEmail: m.fromEmail, headers }).kind === null;
            // A kept copy of an e-mail the server logged: its own classification counts.
            if (inboundLogAutomatedKind(cid)) return false;
            return classifyForwardCopy({ subject: m.subject ?? parsed.data.subject ?? null, fromEmail: m.fromEmail, headers }).kind === null;
          });
          newMessages = crmService.ingestThread(
            { threadId: target.threadId, messages: rest },
            contact?.email || parsed.data.primaryFromEmail,
            target.vertical as CrmVertical,
          ).newMessages;
          if (newMessages > 0 && newHumanIn) {
            const st = getDb().prepare("SELECT status FROM crm_threads WHERE id = ?").get(target.threadId) as { status: string } | undefined;
            if (st && (st.status === "done" || st.status === "archived")) {
              crmService.setThreadStatus(target.threadId, "new", "system");
              crmService.logAction({
                threadId: target.threadId,
                contactId: target.contactId,
                type: "reopened_by_inbound",
                actor: "system",
                payload: { previousStatus: st.status, via: "cs_gmail_ingest" },
              });
            }
          }
        })();
      } catch (err: any) {
        return res.status(500).json({ error: String(err?.message ?? "ingest failed") });
      }
      return res.json({
        threadId: canonical.threadId,
        contactId: canonical.contactId,
        newMessages,
        serverRegistered: true,
        gmailThreadId: parsed.data.threadId,
      });
    }
    // The server parked the original as untriaged. The copy alone adds nothing
    // (filing it would open a second item for the same e-mail); if the Gmail
    // thread holds more than the copy, fall through so nothing is lost.
    if (parkedLogId && parsed.data.messages.every((m) => serverFiled(m))) {
      // Same contract as a parked ingest (202 + untriaged: true): the caller
      // must not compose against this thread.
      const parkedRow = getDb()
        .prepare("SELECT id, reason FROM crm_untriaged WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(`inbound-${parkedLogId}`) as { id: string; reason: string } | undefined;
      return res.status(202).json({
        untriaged: true,
        untriagedId: parkedRow?.id ?? null,
        reason: parkedRow?.reason ?? null,
        openUntriaged: countOpenUntriaged(),
        threadId: null,
        newMessages: 0,
        serverRegistered: true,
        parkedUntriaged: true,
        untriagedThreadId: `inbound-${parkedLogId}`,
        gmailThreadId: parsed.data.threadId,
      });
    }
    // Falling through to normal routing: copies the server already filed
    // (parked or on its own thread) are left out, so the e-mail is not filed twice.
    const unfiled = parsed.data.messages.filter((m) => !serverFiled(m));
    if (unfiled.length < parsed.data.messages.length) {
      if (unfiled.length === 0) {
        // Only copies of e-mails already handled by the server (or purged from
        // its log after 90 days): nothing new to file.
        return res.json({ threadId: null, newMessages: 0, serverRegistered: true, alreadyHandled: true, gmailThreadId: parsed.data.threadId });
      }
      parsed.data.messages = unfiled;
    }
  }

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

    // Contact-match fallback — ONLY for the specific "no recipient header names
    // a platform alias" refusal, never for no_signals, ambiguous_platform_addresses,
    // or the asserted-vertical-mismatch refusal above: those three are genuinely
    // undecidable and must keep parking exactly as before. This one case is
    // different — a known contact's own address is unambiguous evidence of
    // which vertical they belong to, even though it didn't arrive at an alias.
    const autoRoutedVertical =
      !outcome.routed && outcome.code === "no_platform_address"
        ? autoRouteByKnownContact(parsed.data.primaryFromEmail)
        : null;

    if (autoRoutedVertical !== null) {
      // Distinct from a header-derived route so a human can tell them apart
      // later (contactId is unknown here — the contact/thread rows are
      // created below by ingestThread — so this logs against neither, same
      // as classifyEmail's own null-contactId convention for a not-yet-
      // existing row).
      crmService.logAction({
        type: "crm_ingest_auto_routed_by_contact_match",
        actor: "system",
        payload: {
          threadId: parsed.data.threadId,
          fromEmail: parsed.data.primaryFromEmail,
          vertical: autoRoutedVertical,
          refusalReason: refusal,
        },
      });
      vertical = autoRoutedVertical;
    } else if (refusal !== null || !outcome.routed) {
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

      // dev-requests/2026-08-21-crm-untriaged-kofrysning-og-lopetellerfeil.md:
      // a known, permanent noise source (GitHub CI notification mail) can
      // never resolve to a platform alias, so it would otherwise sit in
      // Daniel's manual queue forever. Still parked first — same durable
      // audit-trail invariant as every other unroutable thread, "accepted and
      // durably recorded, but deliberately not filed" — but then immediately
      // resolved as dismissed so it never occupies the OPEN queue.
      if (isAutoDismissedSender(parsed.data.primaryFromEmail)) {
        markUntriagedResolved(parked.id, null, "auto:ci_notification_filter");
        return res.status(202).json({
          untriaged: false,
          dismissed: true,
          dismissedId: parked.id,
          alreadyDismissed: parked.alreadyResolved,
          reason: "auto_dismissed_ci_notification",
          openUntriaged: countOpenUntriaged(),
        });
      }

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
    } else {
      vertical = outcome.vertical;
    }
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

// ─── GET /admin/crm/needs-reply ──────────────────────────────
// CS på serveren, S1a: every customer thread whose latest (human) inbound is
// newer than its latest real outbound, with age and level (P1 ≥ 12 h, P0 ≥
// 24 h), plus open untriaged rows and inbound mail whose forward failed.
// ?vertical=rfb|dental|experiences filters threads.
router.get("/needs-reply", (req, res) => {
  try {
    const limitRaw = parseInt(String(req.query.limit ?? ""), 10);
    // server_mode (S6): which server parts are switched on, so the CS routine
    // moves each duty to the server only when the server actually does it.
    res.json({
      ...computeNeedsReply({ vertical: parseVertical(req) ?? null, limit: Number.isFinite(limitRaw) ? limitRaw : undefined }),
      server_mode: {
        inbound_ingest: csInboundServerIngestEnabled(),
        autosend: csAutosendEnabled(),
        change_requests: csChangeRequestsEnabled(),
        watchdog: csWatchdogEnabled(),
        daily_digest: csDailyDigestEnabled(),
        contact_receipt: contactReceiptEnabled(),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? "needs-reply failed") });
  }
});

// ─── GET /admin/crm/daily-digest/preview ─────────────────────
// CS på serveren, S1b: the exact digest the 07:00 job would e-mail now —
// read-only, sends nothing (for checking and for the morning report).
router.get("/daily-digest/preview", (_req, res) => {
  try {
    const d = buildDailyDigest(new Date());
    res.json({ subject: d.subject, text: d.text, counts: d.counts });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? "digest failed") });
  }
});

// ─── POST /admin/crm/threads/:id/no-reply-needed ─────────────
// Mark «trenger ikke svar» (reason required). A later inbound makes the
// thread need a reply again.
router.post("/threads/:id/no-reply-needed", (req, res) => {
  const schema = z.object({
    reason: z.string().min(1).max(300),
    actor: z.enum(["claude", "daniel", "system"]).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  const r = markNoReplyNeeded(req.params.id, parsed.data.reason, parsed.data.actor ?? "daniel");
  if (!r.ok) return res.status(r.error === "thread_not_found" ? 404 : 400).json({ error: r.error });
  res.json({ success: true });
});

// ─── CS på serveren, S2: reply proposals + approval queue ────────────
// dev-request 2026-11-10-cs-paa-serveren, skive S2. The CS routine proposes;
// the server sends (cs-autosend) or parks the proposal here with the reason.
// The recipient is never a parameter: it is the sender of the thread's latest
// human inbound message.
const proposalSchema = z.object({
  kind: z.enum(REPLY_KINDS),
  subject: z.string().max(500).nullable().optional(),
  bodyText: z.string().min(1).max(50000),
  bodyHtml: z.string().max(100000).nullable().optional(),
  changeRequestIds: z.array(z.string().min(1).max(120)).max(20).optional(),
  evidence: z.unknown().optional(),
  createdBy: z.enum(["claude", "daniel"]).default("claude"),
});

router.post("/threads/:id/reply-proposals", (req, res) => {
  const parsed = proposalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  const r = createReplyProposal({ threadId: req.params.id, ...parsed.data, evidence: parsed.data.evidence });
  if (!r.ok) return res.status(r.status).json({ error: r.error, detail: r.detail });
  res.status(201).json({ proposal: r.proposal, superseded: r.superseded });
});

router.get("/threads/:id/reply-proposals", (req, res) => {
  res.json({ items: listProposals({ threadId: req.params.id, limit: 100 }) });
});

const PROPOSAL_STATUSES: ReadonlyArray<ProposalStatus | "open"> = [
  "open", "pending", "approval_needed", "approved", "sending", "sent", "failed", "rejected", "superseded",
];

router.get("/reply-proposals", (req, res) => {
  const status = (req.query.status as string | undefined) ?? "approval_needed";
  if (!PROPOSAL_STATUSES.includes(status as any)) return res.status(400).json({ error: "invalid status" });
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  res.json({ items: listProposals({ status: status as any, limit }) });
});

router.get("/reply-proposals/:pid", (req, res) => {
  const p = getProposal(req.params.pid);
  if (!p) return res.status(404).json({ error: "proposal not found" });
  res.json({ proposal: p });
});

const proposalEditSchema = z.object({
  subject: z.string().min(1).max(500).optional(),
  bodyText: z.string().min(1).max(50000).optional(),
  bodyHtml: z.string().max(100000).nullable().optional(),
  kind: z.enum(REPLY_KINDS).optional(),
  changeRequestIds: z.array(z.string().min(1).max(120)).max(20).optional(),
  note: z.string().max(300).optional(),
  /** Daniel saw the customer's newer message and still sends this reply. */
  acknowledgeNewerInbound: z.boolean().optional(),
});

/** Where an approval came from — the admin page marks its own calls. Audit only (the admin key is shared). */
function approvalSource(req: Request): "admin-crm" | "api" {
  return req.get("X-Admin-Client") === "admin-crm" ? "admin-crm" : "api";
}

router.post("/reply-proposals/:pid/approve", async (req, res) => {
  const parsed = proposalEditSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  const { note, acknowledgeNewerInbound, ...edits } = parsed.data;
  try {
    const r = await approveProposal(req.params.pid, { edits, note: note ?? null, actor: "daniel", source: approvalSource(req), acknowledgeNewerInbound: acknowledgeNewerInbound === true });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const sent = r.result.outcome === "sent";
    res.status(sent ? 200 : 409).json({ sent, result: r.result, proposal: r.proposal });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

router.post("/reply-proposals/:pid/edit", (req, res) => {
  const parsed = proposalEditSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  const { note: _note, acknowledgeNewerInbound: _ack, ...edits } = parsed.data;
  const r = editProposal(req.params.pid, edits, "daniel");
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ proposal: r.proposal });
});

router.post("/reply-proposals/:pid/reject", (req, res) => {
  const parsed = z.object({ reason: z.string().trim().min(1).max(300), actor: z.enum(["daniel", "claude"]).default("daniel") }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "invalid body", details: parsed.error.issues });
  const r = rejectProposal(req.params.pid, parsed.data.reason, parsed.data.actor);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ success: true, proposal: getProposal(req.params.pid) });
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
    // 'superseded' (dev-request 2026-08-25-cs-outbox-result-mangler-superseded-
    // status): the case this row was queued for closed via a DIFFERENT channel
    // than the row itself represents (e.g. a gmail_draft row superseded by a
    // resend_send that actually resolved the thread) — distinct from
    // 'completed', which means THIS row's own send/draft is what did it.
    status: z.enum(["completed", "failed", "superseded"]),
    resultId: z.string().optional(),
    error: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body" });

  // CS på serveren, S2.5: a result is only accepted for a row that is still
  // waiting (pending / processing). An unknown id is 404; a repeat of the SAME
  // outcome is an idempotent 200; anything else (e.g. "completed" on a row the
  // server already marked failed) is 409 — it used to overwrite silently.
  const current = getDb().prepare("SELECT status FROM crm_outbox WHERE id = ?").get(req.params.id) as { status: string } | undefined;
  if (!current) return res.status(404).json({ error: "outbox item not found" });
  if (current.status === parsed.data.status) {
    // Same outcome again. A new resultId (e.g. a re-created Gmail draft) is
    // recorded rather than silently dropped.
    if (parsed.data.resultId) {
      getDb().prepare("UPDATE crm_outbox SET result_id = ? WHERE id = ? AND COALESCE(result_id, '') != ?").run(parsed.data.resultId, req.params.id, parsed.data.resultId);
    }
    return res.json({ success: true, unchanged: true });
  }
  if (current.status !== "pending" && current.status !== "processing") {
    return res.status(409).json({ error: "outbox_not_pending", status: current.status });
  }

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
        : parsed.data.status === "superseded"
        ? "superseded"
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
    // 'superseded' deliberately skips this sync: it means THIS row's own
    // send/draft never happened (something else resolved the case), so there
    // is no "sent"/"draft_in_gmail"/"failed" delivery outcome to record for
    // whatever message getLatestOutboundMessageId would otherwise guess at.
    const msgId = row.crm_message_id ?? crmService.getLatestOutboundMessageId(row.thread_id);
    if (msgId && parsed.data.status !== "superseded") {
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
    // Phase 4.10c-2 Steg 2 — contact_email filter for the CS-agent dual-source guard.
    // Used by the agent to check "has this recipient gotten ANY outbound from us
    // in the lookback window?" before deciding to send a confirmation.
    // Applied in SQL by listSentMessages(), BEFORE its LIMIT. It used to filter
    // in memory AFTER it — i.e. only the newest `limit` outbound rows
    // platform-wide — and returned count 0 for older confirmations (incident
    // 2026-09-28, five producers re-mailed; see crm-service.ts).
    const contactEmail = (req.query.contact_email as string | undefined)?.trim().toLowerCase();

    let messages = crmService.listSentMessages({
      sinceHours,
      limit,
      deliveryStatus: (statusFilter && statusFilter !== "all"
        ? (statusFilter as "sent" | "queued" | "draft_in_gmail" | "failed")
        : undefined),
      contactEmail,
    });

    // Optional in-memory filters
    // NB: channel/actor are computed (COALESCE subqueries + JS fallback), so they still filter AFTER the SQL LIMIT.
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
