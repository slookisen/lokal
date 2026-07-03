import { randomUUID } from "crypto";
import { getDb } from "../database/init";

// ─── CRM Service ────────────────────────────────────────────
// Core inbox-CRM logic.
// Handles upsert of threads/messages from Gmail (via the CS-agent),
// contact resolution (link to producers via domain/email matching),
// and read queries for the dashboard UI.

export type ContactType = "producer" | "marketing" | "vendor" | "unknown";
// Vertical split: rfb = rettfrabonden.com, dental = finn-tannlege.com,
// experiences = opplevagent.no. All CRM tables carry vertical_id (default
// 'rfb'). The closed union below is interpolated directly into SQL fragments
// — never raw user input.
export type CrmVertical = "rfb" | "dental" | "experiences";
function vSql(column: string, vertical?: CrmVertical): string {
  return vertical ? ` AND ${column} = '${vertical}'` : "";
}
export type ThreadStatus = "new" | "in_progress" | "awaiting_review" | "done" | "archived";
export type ThreadCategory = "innkommende" | "system" | "marketing" | "leverandor" | "unknown";
export type AssignedTo = "unassigned" | "claude" | "daniel";
export type Severity = "p0" | "p1" | "p2" | "normal";
export type Direction = "in" | "out";
export type Actor = "claude" | "daniel" | "system";
export type OutboxIntent = "gmail_draft" | "resend_send";
export type OutboxStatus = "pending" | "processing" | "completed" | "failed";

export interface IngestThreadInput {
  threadId: string;                  // Gmail threadId — canonical
  subject?: string | null;
  category?: ThreadCategory;
  severity?: Severity;
  messages: IngestMessageInput[];
}

export interface IngestMessageInput {
  messageId: string;                 // Gmail messageId — canonical
  direction: Direction;
  fromEmail: string;
  toEmails?: string[];
  ccEmails?: string[];
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  snippet?: string | null;
  sentAt?: string | null;            // ISO 8601
  rawMetadata?: Record<string, any>;
}

const VENDOR_DOMAINS = new Set([
  "fly.io", "namecheap.com", "google.com", "googlemail.com", "cloudflare.com",
  "github.com", "stripe.com", "vercel.com", "resend.com", "anthropic.com",
  "claude.com", "openai.com", "mailchimp.com", "aws.amazon.com",
  "amazon.com", "amazonaws.com", "render.com", "smithery.ai", "glama.ai",
  "supabase.com", "neon.tech", "doppler.com", "sentry.io", "datadog.com",
  "intercom.com", "linear.app", "notion.so", "atlassian.com",
]);

class CrmService {
  // ─── Contacts ───────────────────────────────────────────────

  /**
   * Look up or create a contact by email. Auto-classifies type:
   *  - If email's domain matches a producer's contact_email or knowledge.website host → 'producer'
   *  - If domain ∈ VENDOR_DOMAINS → 'vendor'
   *  - Else 'unknown' (Daniel can re-classify later)
   */

  private matchesVendorDomain(domain: string): boolean {
    if (!domain) return false;
    if (VENDOR_DOMAINS.has(domain)) return true;
    // Check if any vendor domain is a suffix (e.g. accounts.google.com → google.com)
    for (const v of VENDOR_DOMAINS) {
      if (domain.endsWith("." + v)) return true;
    }
    return false;
  }

  /**
   * Classify an email against the agents table. Used both at create-time
   * and to re-evaluate existing 'unknown' contacts after agents are added/edited.
   *
   * Priority:
   *   1. Exact match on agents.contact_email (highest confidence)
   *   2. Domain match on agents.contact_email
   *   3. Vendor allowlist
   *   4. unknown
   */
  classifyEmail(email: string): { type: ContactType; agentId: string | null } {
    const db = getDb();
    const lowerEmail = email.trim().toLowerCase();
    const domain = lowerEmail.split("@")[1] ?? "";

    // 1. Exact match
    const exact = db
      .prepare("SELECT id FROM agents WHERE LOWER(contact_email) = ? AND is_active = 1 LIMIT 1")
      .get(lowerEmail) as { id: string } | undefined;
    if (exact) return { type: "producer", agentId: exact.id };

    // 1b. Exact match on agent_knowledge.email — this is the address marketing
    // actually sends outreach to, and it's often different from agents.contact_email
    // (e.g. a personal Gmail). Without this tier the contact never gets an agent_id,
    // and the outreach_sent_log auto-record trigger (PR-38) silently no-ops on its
    // agent_id IS NOT NULL guard, so the producer keeps reappearing in the pool.
    const exactKnowledge = db
      .prepare(
        "SELECT a.id FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id WHERE LOWER(k.email) = ? AND a.is_active = 1 LIMIT 1"
      )
      .get(lowerEmail) as { id: string } | undefined;
    if (exactKnowledge) return { type: "producer", agentId: exactKnowledge.id };

    // 2. Domain match (skip generic freemail domains so we don't false-positive)
    const FREEMAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "live.com", "icloud.com", "online.no", "broadpark.no"]);
    if (domain && !FREEMAIL.has(domain)) {
      const byDomain = db
        .prepare("SELECT id FROM agents WHERE LOWER(contact_email) LIKE ? AND is_active = 1 LIMIT 1")
        .get(`%@${domain}`) as { id: string } | undefined;
      if (byDomain) return { type: "producer", agentId: byDomain.id };
    }

    // 3. Vendor allowlist (exact OR subdomain match)
    if (this.matchesVendorDomain(domain)) return { type: "vendor", agentId: null };

    return { type: "unknown", agentId: null };
  }

  resolveContact(email: string, hintName?: string | null): { id: string; created: boolean } {
    const db = getDb();
    const lowerEmail = email.trim().toLowerCase();
    const domain = lowerEmail.split("@")[1] ?? "";

    const existing = db
      .prepare("SELECT id, type, agent_id FROM crm_contacts WHERE email = ?")
      .get(lowerEmail) as { id: string; type: ContactType; agent_id: string | null } | undefined;

    if (existing) {
      // Re-evaluate type if currently 'unknown' (cheap, one indexed lookup)
      if (existing.type === "unknown") {
        const c = this.classifyEmail(lowerEmail);
        if (c.type !== "unknown") {
          db.prepare("UPDATE crm_contacts SET type = ?, agent_id = ?, last_seen_at = datetime('now') WHERE id = ?")
            .run(c.type, c.agentId, existing.id);
          return { id: existing.id, created: false };
        }
      }
      db.prepare("UPDATE crm_contacts SET last_seen_at = datetime('now') WHERE id = ?").run(existing.id);
      return { id: existing.id, created: false };
    }

    const c = this.classifyEmail(lowerEmail);
    const id = randomUUID();
    db.prepare(`
      INSERT INTO crm_contacts (id, type, agent_id, email, name, domain)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, c.type, c.agentId, lowerEmail, hintName ?? null, domain || null);

    return { id, created: true };
  }

  /**
   * Bulk re-classify all 'unknown' contacts. Used after seeding new agents
   * or when admin notices misclassifications.
   */
  reclassifyUnknown(): { evaluated: number; reclassified: number } {
    const db = getDb();
    const rows = db.prepare("SELECT id, email FROM crm_contacts WHERE type = 'unknown'").all() as Array<{ id: string; email: string }>;
    let reclassified = 0;
    for (const r of rows) {
      const c = this.classifyEmail(r.email);
      if (c.type !== "unknown") {
        db.prepare("UPDATE crm_contacts SET type = ?, agent_id = ? WHERE id = ?").run(c.type, c.agentId, r.id);
        reclassified++;
      }
    }
    return { evaluated: rows.length, reclassified };
  }

  setContactType(contactId: string, type: ContactType, agentId?: string | null): void {
    const db = getDb();
    db.prepare("UPDATE crm_contacts SET type = ?, agent_id = ? WHERE id = ?")
      .run(type, agentId ?? null, contactId);
  }

  setContactStatus(contactId: string, status: "active" | "blocked" | "archived"): void {
    const db = getDb();
    db.prepare("UPDATE crm_contacts SET status = ? WHERE id = ?").run(status, contactId);
  }

  setContactNotes(contactId: string, notes: string): void {
    const db = getDb();
    db.prepare("UPDATE crm_contacts SET notes = ? WHERE id = ?").run(notes, contactId);
  }

  // ─── Threads ────────────────────────────────────────────────

  /**
   * Idempotent ingestion: upserts a thread + its messages.
   * Called by the CS-agent each run with whatever new/updated threads it found.
   */
  ingestThread(input: IngestThreadInput, primaryFromEmail: string): { threadId: string; contactId: string; newMessages: number } {
    const db = getDb();
    const contact = this.resolveContact(primaryFromEmail);
    const contactId = contact.id;
    const threadId = input.threadId;

    // Upsert thread
    const existing = db.prepare("SELECT id FROM crm_threads WHERE id = ?").get(threadId);
    if (!existing) {
      db.prepare(`
        INSERT INTO crm_threads (id, contact_id, subject, category, severity)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        threadId,
        contactId,
        input.subject ?? null,
        input.category ?? "unknown",
        input.severity ?? "normal"
      );
    } else if (input.subject || input.category || input.severity) {
      // Update fields if provided
      const updates: string[] = [];
      const params: any[] = [];
      if (input.subject) { updates.push("subject = ?"); params.push(input.subject); }
      if (input.category) { updates.push("category = ?"); params.push(input.category); }
      if (input.severity) { updates.push("severity = ?"); params.push(input.severity); }
      updates.push("updated_at = datetime('now')");
      params.push(threadId);
      db.prepare(`UPDATE crm_threads SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    }

    // Upsert messages
    let newMessages = 0;
    const insertMsg = db.prepare(`
      INSERT OR IGNORE INTO crm_messages
        (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, body_html, snippet, sent_at, raw_metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const m of input.messages) {
      const result = insertMsg.run(
        m.messageId,
        threadId,
        m.direction,
        m.fromEmail.toLowerCase(),
        JSON.stringify(m.toEmails ?? []),
        JSON.stringify(m.ccEmails ?? []),
        m.subject ?? null,
        m.bodyText ?? null,
        m.bodyHtml ?? null,
        m.snippet ?? null,
        m.sentAt ?? null,
        JSON.stringify(m.rawMetadata ?? {})
      );
      if (result.changes > 0) newMessages++;
    }

    // Recompute denormalized fields
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS cnt,
        MAX(sent_at) AS last_msg,
        MAX(CASE WHEN direction = 'in' THEN sent_at END) AS last_in,
        MAX(CASE WHEN direction = 'out' THEN sent_at END) AS last_out
      FROM crm_messages WHERE thread_id = ?
    `).get(threadId) as any;

    db.prepare(`
      UPDATE crm_threads
      SET message_count = ?, last_message_at = ?, last_inbound_at = ?, last_outbound_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(stats.cnt ?? 0, stats.last_msg, stats.last_in, stats.last_out, threadId);

    // Log ingest
    if (newMessages > 0) {
      this.logAction({
        threadId,
        contactId,
        type: "imported",
        actor: "system",
        payload: { newMessages, totalMessages: stats.cnt },
      });
    }

    return { threadId, contactId, newMessages };
  }

  // ─── Compose a brand-new outbound thread ──────────────────
  // Used by the CRM "Ny epost" UI. Creates the contact (if missing),
  // a fresh thread, and one outbound message — then the route layer
  // sends via Resend or enqueues a Gmail draft. Mirrors ingestThread's
  // bookkeeping (denormalized counters, action log) so the new thread
  // appears in the dashboard the same as inbound ones.
  composeNewThread(input: {
    toEmail: string;
    contactName?: string | null;
    subject: string;
    bodyText: string;
    bodyHtml?: string | null;
    category?: "innkommende" | "marketing" | "leverandor" | "system" | "unknown";
    severity?: "p0" | "p1" | "p2" | "normal";
    createdBy: "claude" | "daniel";
    /**
     * Initial delivery state for the outbound message we record.  Use 'queued'
     * when the actual send hasn't happened yet — caller must update via
     * updateMessageDeliveryStatus once Resend/Gmail has confirmed.  Default
     * 'sent' is for back-compat callers that genuinely send synchronously.
     */
    deliveryStatus?: "sent" | "queued" | "draft_in_gmail" | "failed";
  }): { threadId: string; contactId: string; messageId: string } {
    const db = getDb();
    const lowerTo = input.toEmail.trim().toLowerCase();
    const contact = this.resolveContact(lowerTo, input.contactName ?? null);
    const contactId = contact.id;

    if (input.contactName && contact.created) {
      db.prepare("UPDATE crm_contacts SET name = COALESCE(name, ?) WHERE id = ?")
        .run(input.contactName, contactId);
    }

    const threadId = `compose-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO crm_threads (id, contact_id, subject, category, severity, assigned_to, status, last_message_at, last_outbound_at, message_count, updated_at)
      VALUES (?, ?, ?, ?, ?, 'daniel', 'in_progress', ?, ?, 1, datetime('now'))
    `).run(
      threadId,
      contactId,
      input.subject,
      input.category ?? "innkommende",
      input.severity ?? "normal",
      now,
      now,
    );

    const deliveryStatus = input.deliveryStatus ?? "sent";
    // For non-confirmed states, leave sent_at NULL so dashboards can render
    // an "ikke sendt"-banner instead of falsely showing a sent timestamp.
    const recordedSentAt = deliveryStatus === "sent" ? now : null;

    db.prepare(`
      INSERT INTO crm_messages
        (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, body_html, snippet, sent_at, raw_metadata, delivery_status)
      VALUES (?, ?, 'out', 'kontakt@rettfrabonden.com', ?, '[]', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      threadId,
      JSON.stringify([lowerTo]),
      input.subject,
      input.bodyText,
      input.bodyHtml ?? null,
      (input.bodyText || "").slice(0, 200),
      recordedSentAt,
      JSON.stringify({ source: "crm-compose", createdBy: input.createdBy }),
      deliveryStatus,
    );

    this.logAction({
      threadId,
      contactId,
      type: "composed",
      actor: input.createdBy === "daniel" ? "daniel" : "claude",
      payload: { messageId, to: lowerTo, subject: input.subject, source: "crm-compose-ui" },
    });

    return { threadId, contactId, messageId };
  }

  /**
   * Update an outbound message's delivery_status after the actual send
   * outcome is known.  Sets sent_at to NOW only when transitioning to
   * 'sent' and sent_at was previously NULL — preserves audit accuracy.
   */
  updateMessageDeliveryStatus(messageId: string, status: "sent" | "queued" | "draft_in_gmail" | "failed"): void {
    const db = getDb();
    if (status === "sent") {
      db.prepare(`UPDATE crm_messages SET delivery_status = ?, sent_at = COALESCE(sent_at, datetime('now')) WHERE id = ?`).run(status, messageId);
    } else {
      db.prepare(`UPDATE crm_messages SET delivery_status = ? WHERE id = ?`).run(status, messageId);
    }
  }

  /**
   * Find the most recent outbound crm_messages id for a thread, for use
   * when the caller has only the threadId (e.g. /outbox/:id/result).
   */
  getLatestOutboundMessageId(threadId: string): string | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT id FROM crm_messages
      WHERE thread_id = ? AND direction = 'out'
      ORDER BY received_at DESC LIMIT 1
    `).get(threadId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  setThreadStatus(threadId: string, status: ThreadStatus, actor: Actor): void {
    const db = getDb();
    const prev = db.prepare("SELECT status FROM crm_threads WHERE id = ?").get(threadId) as { status: string } | undefined;
    if (!prev) return;
    db.prepare("UPDATE crm_threads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, threadId);
    this.logAction({
      threadId,
      type: "status_changed",
      actor,
      payload: { from: prev.status, to: status },
    });
  }

  setThreadAssignee(threadId: string, assignedTo: AssignedTo, actor: Actor): void {
    const db = getDb();
    db.prepare("UPDATE crm_threads SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?").run(assignedTo, threadId);
    this.logAction({ threadId, type: "assignee_changed", actor, payload: { to: assignedTo } });
  }

  setThreadNotes(threadId: string, notes: string, actor: Actor): void {
    const db = getDb();
    db.prepare("UPDATE crm_threads SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(notes, threadId);
    this.logAction({ threadId, type: "note_added", actor, payload: { length: notes.length } });
  }

  // ─── Actions log ────────────────────────────────────────────

  logAction(params: {
    threadId?: string | null;
    contactId?: string | null;
    type: string;
    actor: Actor;
    payload?: Record<string, any>;
  }): string {
    const db = getDb();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO crm_actions (id, thread_id, contact_id, type, actor, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.threadId ?? null,
      params.contactId ?? null,
      params.type,
      params.actor,
      JSON.stringify(params.payload ?? {})
    );
    return id;
  }

  // ─── Outbox (queued sends) ──────────────────────────────────

  enqueueOutbox(params: {
    threadId?: string | null;
    contactId?: string | null;
    intent: OutboxIntent;
    toEmails: string[];
    ccEmails?: string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    replyToMessageId?: string | null;
    createdBy: "claude" | "daniel";
  }): { id: string } {
    const db = getDb();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO crm_outbox
        (id, thread_id, contact_id, intent, to_emails, cc_emails, subject, body_text, body_html, reply_to_message_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.threadId ?? null,
      params.contactId ?? null,
      params.intent,
      JSON.stringify(params.toEmails),
      JSON.stringify(params.ccEmails ?? []),
      params.subject,
      params.bodyText,
      params.bodyHtml ?? null,
      params.replyToMessageId ?? null,
      params.createdBy
    );
    this.logAction({
      threadId: params.threadId,
      contactId: params.contactId,
      type: params.intent === "gmail_draft" ? "draft_queued" : "send_queued",
      actor: params.createdBy,
      payload: { outboxId: id, to: params.toEmails, subject: params.subject },
    });
    return { id };
  }

  listPendingOutbox(intent?: OutboxIntent, limit = 50): any[] {
    const db = getDb();
    const sql = intent
      ? "SELECT * FROM crm_outbox WHERE status = 'pending' AND intent = ? ORDER BY created_at LIMIT ?"
      : "SELECT * FROM crm_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?";
    return intent ? db.prepare(sql).all(intent, limit) as any[] : db.prepare(sql).all(limit) as any[];
  }

  markOutboxResult(id: string, status: OutboxStatus, resultId?: string, error?: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE crm_outbox
      SET status = ?, result_id = ?, error = ?, processed_at = datetime('now')
      WHERE id = ?
    `).run(status, resultId ?? null, error ?? null, id);
  }

  // ─── Read queries (UI) ──────────────────────────────────────

  /**
   * List contacts grouped by type with thread counts.
   * Used for the three-tab landing page.
   */
  listContacts(type: ContactType, opts: { limit?: number; offset?: number; search?: string; vertical?: CrmVertical } = {}): any[] {
    const db = getDb();
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const searchClause = opts.search ? " AND (c.email LIKE ? OR c.name LIKE ?)" : "";
    const params: any[] = [type];
    if (opts.search) {
      const like = `%${opts.search}%`;
      params.push(like, like);
    }
    params.push(limit, offset);

    return db.prepare(`
      SELECT
        c.id, c.email, c.name, c.domain, c.organization, c.status, c.notes,
        c.first_seen_at, c.last_seen_at, c.agent_id,
        a.name AS agent_name,
        COUNT(DISTINCT t.id) AS thread_count,
        SUM(CASE WHEN t.status = 'new' THEN 1 ELSE 0 END) AS new_count,
        SUM(CASE WHEN t.status = 'awaiting_review' THEN 1 ELSE 0 END) AS awaiting_count,
        MAX(t.last_message_at) AS last_message_at,
        SUM(t.message_count) AS total_messages
      FROM crm_contacts c
      LEFT JOIN crm_threads t ON t.contact_id = c.id
      LEFT JOIN agents a ON a.id = c.agent_id
      WHERE c.type = ?${searchClause}${vSql("c.vertical_id", opts.vertical)}
      GROUP BY c.id
      ORDER BY MAX(t.last_message_at) DESC NULLS LAST, c.last_seen_at DESC
      LIMIT ? OFFSET ?
    `).all(...params) as any[];
  }

  countContactsByType(vertical?: CrmVertical): Record<ContactType, number> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT type, COUNT(*) as cnt FROM crm_contacts WHERE 1=1${vSql("vertical_id", vertical)} GROUP BY type
    `).all() as { type: ContactType; cnt: number }[];
    const result: Record<ContactType, number> = { producer: 0, marketing: 0, vendor: 0, unknown: 0 };
    for (const r of rows) result[r.type] = r.cnt;
    return result;
  }

  getContactDetail(contactId: string): any {
    const db = getDb();
    const contact = db.prepare(`
      SELECT c.*, a.name AS agent_name, a.city AS agent_city
      FROM crm_contacts c
      LEFT JOIN agents a ON a.id = c.agent_id
      WHERE c.id = ?
    `).get(contactId);
    if (!contact) return null;

    const threads = db.prepare(`
      SELECT * FROM crm_threads
      WHERE contact_id = ?
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC
    `).all(contactId);

    const actions = db.prepare(`
      SELECT * FROM crm_actions
      WHERE contact_id = ? OR thread_id IN (SELECT id FROM crm_threads WHERE contact_id = ?)
      ORDER BY created_at DESC
      LIMIT 50
    `).all(contactId, contactId);

    return { contact, threads, actions };
  }

  getThreadDetail(threadId: string): any {
    const db = getDb();
    const thread = db.prepare(`
      SELECT t.*, c.email AS contact_email, c.name AS contact_name, c.type AS contact_type, c.agent_id
      FROM crm_threads t
      JOIN crm_contacts c ON c.id = t.contact_id
      WHERE t.id = ?
    `).get(threadId);
    if (!thread) return null;

    const messages = db.prepare(`
      SELECT * FROM crm_messages
      WHERE thread_id = ?
      ORDER BY sent_at ASC NULLS LAST, received_at ASC
    `).all(threadId);

    const actions = db.prepare(`
      SELECT * FROM crm_actions
      WHERE thread_id = ?
      ORDER BY created_at DESC
    `).all(threadId);

    return { thread, messages, actions };
  }

  /**
   * List threads filtered by status across all contacts.
   * Used by the dashboard "venter" / "nye" KPI badges to show what
   * needs attention without drilling into each contact tab.
   *
   * Returned rows are joined with contact info (email, name, type, agent_name)
   * + a snippet of the latest inbound message for quick context.
   *
   * `status` is optional (omit to search across all statuses) and `opts.contactEmail`
   * filters to a single contact (case-insensitive) regardless of status — used by the
   * per-contact thread lookup (`GET /admin/crm/threads?contact_email=`).
   */
  listThreadsByStatus(
    status: ThreadStatus | undefined,
    opts: { limit?: number; offset?: number; vertical?: CrmVertical; contactEmail?: string } = {}
  ): any[] {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 200, 500);
    const offset = opts.offset ?? 0;

    const conditions: string[] = [];
    const params: any[] = [];
    if (status) {
      conditions.push("t.status = ?");
      params.push(status);
    }
    if (opts.contactEmail) {
      conditions.push("LOWER(c.email) = LOWER(?)");
      params.push(opts.contactEmail);
    }
    if (opts.vertical) {
      conditions.push("t.vertical_id = ?");
      params.push(opts.vertical);
    }
    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    return db.prepare(`
      SELECT
        t.id,
        t.subject,
        t.status,
        t.severity,
        t.category,
        t.assigned_to,
        t.message_count,
        t.last_message_at,
        t.created_at,
        c.id          AS contact_id,
        c.email       AS contact_email,
        c.name        AS contact_name,
        c.organization AS contact_organization,
        c.type        AS contact_type,
        c.agent_id,
        a.name        AS agent_name,
        (
          SELECT m.snippet
          FROM crm_messages m
          WHERE m.thread_id = t.id AND m.direction = 'in'
          ORDER BY m.sent_at DESC NULLS LAST, m.received_at DESC
          LIMIT 1
        ) AS last_inbound_snippet,
        (
          SELECT m.from_email
          FROM crm_messages m
          WHERE m.thread_id = t.id AND m.direction = 'in'
          ORDER BY m.sent_at DESC NULLS LAST, m.received_at DESC
          LIMIT 1
        ) AS last_inbound_from
      FROM crm_threads t
      JOIN crm_contacts c ON c.id = t.contact_id
      LEFT JOIN agents a ON a.id = c.agent_id
      ${whereSql}
      ORDER BY t.last_message_at DESC NULLS LAST, t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params);
  }

  /**
   * Phase 4.10c — list outbound messages with thread + contact context for the
   * "Sendt-logg"-page. Used by the admin /admin/crm/sent-log dashboard so
   * Daniel can see every email leaving kontakt@rettfrabonden.com (autonomous
   * via Claude or manual via Daniel) on a single sortable page.
   *
   * NB: only returns messages with direction='out'. Filters by sent_at when
   * `since_hours` is given; otherwise all-time. Always orders newest first.
   */
  listSentMessages(opts: {
    sinceHours?: number;
    limit?: number;
    deliveryStatus?: "sent" | "queued" | "draft_in_gmail" | "failed";
  } = {}): Array<{
    message_id: string;
    thread_id: string;
    sent_at: string | null;
    received_at: string;
    delivery_status: string;
    from_email: string;
    to_emails: string;
    subject: string | null;
    actor: string | null;
    channel: string | null;
    contact_email: string | null;
    contact_name: string | null;
    contact_organization: string | null;
    thread_subject: string | null;
    thread_status: string | null;
    thread_origin: "compose" | "inbound";
  }> {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 500, 2000);
    const where: string[] = ["m.direction = 'out'"];
    const params: unknown[] = [];

    if (opts.sinceHours) {
      const cutoff = new Date(Date.now() - opts.sinceHours * 3600_000).toISOString();
      where.push("(m.sent_at >= ? OR m.received_at >= ?)");
      params.push(cutoff, cutoff);
    }
    if (opts.deliveryStatus) {
      where.push("m.delivery_status = ?");
      params.push(opts.deliveryStatus);
    }

    const sql = `
      SELECT
        m.id              AS message_id,
        m.thread_id,
        m.sent_at,
        m.received_at,
        m.delivery_status,
        m.from_email,
        m.to_emails,
        m.subject,
        m.raw_metadata,
        t.subject         AS thread_subject,
        t.status          AS thread_status,
        c.email           AS contact_email,
        c.name            AS contact_name,
        c.organization    AS contact_organization,
        COALESCE(
          -- (1) Primary: the per-message action that carries this exact id.
          -- The compose route logs type='sent' with internalMessageId; back-compat
          -- callers that skip the route log type='composed' with messageId only.
          -- Prefer 'sent' when both exist (ORDER BY CASE ensures it ranks first).
          (
            SELECT a.actor
            FROM crm_actions a
            WHERE a.thread_id = m.thread_id
              AND a.type IN ('sent', 'composed')
              AND (
                json_extract(a.payload, '$.internalMessageId') = m.id
                OR json_extract(a.payload, '$.messageId') = m.id
              )
            ORDER BY
              CASE a.type WHEN 'sent' THEN 0 ELSE 1 END ASC,
              a.created_at DESC
            LIMIT 1
          ),
          -- (2) PR-B3 fix: rows ingested from Gmail by ingestThread() are keyed by
          -- the Gmail messageId, so no 'sent'/'composed' action's payload id ever
          -- equals m.id (the route logs the EXTERNAL Resend id, never the Gmail id).
          -- These dominate the sent-log, which is why actor was null platform-wide
          -- and PR-21-v2's compose-only repair never reached them. Bridge via the
          -- outbox, which records the authoritative actor (created_by) at send time.
          -- (2a) Precise: an outbox row whose result_id == this message id.
          (
            SELECT o.created_by FROM crm_outbox o
            WHERE o.thread_id = m.thread_id AND o.result_id = m.id
              AND o.created_by IS NOT NULL
            ORDER BY o.processed_at DESC LIMIT 1
          ),
          -- (2b) Thread-level: most recent completed outbox send on this thread.
          -- Outbound on a CRM thread is single-identity (kontakt@), and created_by
          -- distinguishes claude vs daniel, so thread-level attribution is sound
          -- when no precise id match exists.
          (
            SELECT o.created_by FROM crm_outbox o
            WHERE o.thread_id = m.thread_id AND o.status = 'completed'
              AND o.created_by IS NOT NULL
            ORDER BY o.processed_at DESC, o.created_at DESC LIMIT 1
          )
        ) AS sent_actor,
        COALESCE(
          -- Channel: prefer action payload's $.channel (set by sent-path).
          (
            SELECT json_extract(a.payload, '$.channel')
            FROM crm_actions a
            WHERE a.thread_id = m.thread_id
              AND a.type IN ('sent', 'composed')
              AND (
                json_extract(a.payload, '$.internalMessageId') = m.id
                OR json_extract(a.payload, '$.messageId') = m.id
              )
            ORDER BY
              CASE a.type WHEN 'sent' THEN 0 ELSE 1 END ASC,
              a.created_at DESC
            LIMIT 1
          ),
          -- PR-B3: derive channel from the bridging outbox row (see actor above).
          -- resend_send -> resend_smtp, gmail_draft -> gmail.
          (
            SELECT CASE o.intent WHEN 'resend_send' THEN 'resend_smtp' WHEN 'gmail_draft' THEN 'gmail' END
            FROM crm_outbox o
            WHERE o.thread_id = m.thread_id AND o.result_id = m.id
            ORDER BY o.processed_at DESC LIMIT 1
          ),
          (
            SELECT CASE o.intent WHEN 'resend_send' THEN 'resend_smtp' WHEN 'gmail_draft' THEN 'gmail' END
            FROM crm_outbox o
            WHERE o.thread_id = m.thread_id AND o.status = 'completed'
            ORDER BY o.processed_at DESC, o.created_at DESC LIMIT 1
          ),
          -- For compose-origin messages (thread_id starts with 'compose-') that
          -- reached delivery_status='sent' but have no channel anywhere,
          -- fall back to 'resend_smtp' — these go out exclusively via Resend.
          CASE
            WHEN m.delivery_status = 'sent'
              AND m.thread_id LIKE 'compose-%'
            THEN 'resend_smtp'
            ELSE NULL
          END
        ) AS sent_channel
      FROM crm_messages m
      JOIN crm_threads t ON t.id = m.thread_id
      JOIN crm_contacts c ON c.id = t.contact_id
      WHERE ${where.join(" AND ")}
      ORDER BY datetime(COALESCE(m.sent_at, m.received_at)) DESC
      LIMIT ?
    `;
    params.push(limit);
    const rows = db.prepare(sql).all(...params) as any[];

    return rows.map((r: any) => {
      let actor: string | null = r.sent_actor ?? null;
      // Fallback: parse from raw_metadata.createdBy if no action found for actor
      if (!actor && r.raw_metadata) {
        try {
          const meta = JSON.parse(r.raw_metadata);
          actor = meta?.createdBy ?? null;
        } catch { /* ignore */ }
      }
      // channel: SQL subquery handles the primary lookup + compose-origin fallback.
      // TypeScript-level safety net: if subquery returned null for a compose-origin
      // sent message (e.g. very old row before action logging was added), fall back.
      let channel: string | null = r.sent_channel ?? null;
      if (!channel && r.delivery_status === 'sent' && String(r.thread_id).startsWith('compose-')) {
        channel = 'resend_smtp';
      }
      return {
        message_id: r.message_id,
        thread_id: r.thread_id,
        sent_at: r.sent_at,
        received_at: r.received_at,
        delivery_status: r.delivery_status,
        from_email: r.from_email,
        to_emails: r.to_emails,
        subject: r.subject,
        actor,
        channel,
        contact_email: r.contact_email,
        contact_name: r.contact_name,
        contact_organization: r.contact_organization,
        thread_subject: r.thread_subject,
        thread_status: r.thread_status,
        thread_origin: String(r.thread_id).startsWith("compose-") ? "compose" : "inbound",
      };
    });
  }

  /**
   * Cross-tab summary for the dashboard header.
   */
  getDashboardSummary(vertical?: CrmVertical): any {
    const db = getDb();
    const V = vSql("vertical_id", vertical);
    const counts = this.countContactsByType(vertical);
    const newThreads = (db.prepare(`SELECT COUNT(*) AS c FROM crm_threads WHERE status = 'new'${V}`).get() as any).c;
    const awaitingReview = (db.prepare(`SELECT COUNT(*) AS c FROM crm_threads WHERE status = 'awaiting_review'${V}`).get() as any).c;
    const inProgress = (db.prepare(`SELECT COUNT(*) AS c FROM crm_threads WHERE status = 'in_progress'${V}`).get() as any).c;
    const p0Open = (db.prepare(`SELECT COUNT(*) AS c FROM crm_threads WHERE severity = 'p0' AND status NOT IN ('done','archived')${V}`).get() as any).c;
    const pendingOutbox = (db.prepare(`SELECT COUNT(*) AS c FROM crm_outbox WHERE status = 'pending'${V}`).get() as any).c;

    return {
      contacts: counts,
      threads: { new: newThreads, in_progress: inProgress, awaiting_review: awaitingReview, p0_open: p0Open },
      outbox: { pending: pendingOutbox },
      vertical: vertical || "all",
      generated_at: new Date().toISOString(),
    };
  }
}

export const crmService = new CrmService();
