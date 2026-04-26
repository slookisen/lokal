import { randomUUID } from "crypto";
import { getDb } from "../database/init";

// ─── CRM Service ────────────────────────────────────────────
// Core inbox-CRM logic.
// Handles upsert of threads/messages from Gmail (via the CS-agent),
// contact resolution (link to producers via domain/email matching),
// and read queries for the dashboard UI.

export type ContactType = "producer" | "marketing" | "vendor" | "unknown";
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
  resolveContact(email: string, hintName?: string | null): { id: string; created: boolean } {
    const db = getDb();
    const lowerEmail = email.trim().toLowerCase();
    const domain = lowerEmail.split("@")[1] ?? "";

    const existing = db
      .prepare("SELECT id FROM crm_contacts WHERE email = ?")
      .get(lowerEmail) as { id: string } | undefined;

    if (existing) {
      db.prepare("UPDATE crm_contacts SET last_seen_at = datetime('now') WHERE id = ?").run(existing.id);
      return { id: existing.id, created: false };
    }

    // Classify
    let type: ContactType = "unknown";
    let agentId: string | null = null;

    // Try producer match: domain → agents.contact_email domain
    if (domain) {
      const producerByDomain = db
        .prepare("SELECT id FROM agents WHERE LOWER(contact_email) LIKE ? AND is_active = 1 LIMIT 1")
        .get(`%@${domain}`) as { id: string } | undefined;

      if (producerByDomain) {
        type = "producer";
        agentId = producerByDomain.id;
      } else if (VENDOR_DOMAINS.has(domain)) {
        type = "vendor";
      }
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO crm_contacts (id, type, agent_id, email, name, domain)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, type, agentId, lowerEmail, hintName ?? null, domain || null);

    return { id, created: true };
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
  listContacts(type: ContactType, opts: { limit?: number; offset?: number; search?: string } = {}): any[] {
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
      WHERE c.type = ?${searchClause}
      GROUP BY c.id
      ORDER BY MAX(t.last_message_at) DESC NULLS LAST, c.last_seen_at DESC
      LIMIT ? OFFSET ?
    `).all(...params) as any[];
  }

  countContactsByType(): Record<ContactType, number> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT type, COUNT(*) as cnt FROM crm_contacts GROUP BY type
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
   * Cross-tab summary for the dashboard header.
   */
  getDashboardSummary(): any {
    const db = getDb();
    const counts = this.countContactsByType();
    const newThreads = (db.prepare("SELECT COUNT(*) AS c FROM crm_threads WHERE status = 'new'").get() as any).c;
    const awaitingReview = (db.prepare("SELECT COUNT(*) AS c FROM crm_threads WHERE status = 'awaiting_review'").get() as any).c;
    const inProgress = (db.prepare("SELECT COUNT(*) AS c FROM crm_threads WHERE status = 'in_progress'").get() as any).c;
    const p0Open = (db.prepare("SELECT COUNT(*) AS c FROM crm_threads WHERE severity = 'p0' AND status NOT IN ('done','archived')").get() as any).c;
    const pendingOutbox = (db.prepare("SELECT COUNT(*) AS c FROM crm_outbox WHERE status = 'pending'").get() as any).c;

    return {
      contacts: counts,
      threads: { new: newThreads, in_progress: inProgress, awaiting_review: awaitingReview, p0_open: p0Open },
      outbox: { pending: pendingOutbox },
      generated_at: new Date().toISOString(),
    };
  }
}

export const crmService = new CrmService();
