// ─── CS på serveren, S1a: inbound registration + thread linking ──────────
// dev-request 2026-11-10-cs-paa-serveren (slookisen/A2A), skive S1.
//
// Until now the CRM only learned about an inbound e-mail when the
// rfb-customer-service LLM routine read Gmail and POSTed /admin/crm/ingest.
// If the routine stopped, nothing was registered and nothing noticed. This
// module lets the server register what the Resend inbound webhook receives,
// directly, on the right platform:
//
//   • Platform from the recipient DOMAIN (Resend only receives for our own
//     domains): rettfrabonden.com → rfb, opplevagent.no → experiences,
//     finn-tannlege.com → dental. Two platforms on one mail, or none → parked
//     in crm_untriaged (never a guess). This is deliberately separate from
//     crm-triage's exact alias table, which decides the CS agent's GMAIL
//     copies (whose recipient is Daniel's inbox, not ours).
//   • Thread: In-Reply-To / References against the SMTP Message-ID of every
//     mail we sent (crm_outbox.result_id) and every inbound we registered;
//     otherwise «same contact + same normalized subject» within 180 days;
//     otherwise a new thread `inbound-<logId>`. Replies to threads the
//     platform started (compose-*, kontakt-*, outreach) now land in them.
//   • Automated mail (auto-replies, bounces) is registered but flagged, and
//     never reopens a thread or counts as «needs reply».
//   • A new human inbound on a done/archived thread reopens it (status new).
//
// The Gmail copy the CS agent still ingests carries an "Inbound-ID: inb-…"
// marker (added by the forward). /admin/crm/ingest recognises it, records the
// Gmail thread id as an ALIAS of the server thread and files only the other
// messages (e.g. Daniel's Gmail reply) there — no duplicate thread.
//
// Flag CS_INBOUND_SERVER_INGEST_ENABLED ("1"/"true"; default off): off = the
// webhook only logs + forwards, exactly as before (plus the log row).

import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { crmService, CrmVertical } from "./crm-service";
import { extractAddresses, parkUntriaged } from "./crm-triage";

export const CS_INBOUND_SERVER_INGEST_FLAG = "CS_INBOUND_SERVER_INGEST_ENABLED";

export function csInboundServerIngestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[CS_INBOUND_SERVER_INGEST_FLAG];
  return v === "1" || v === "true";
}

// ─── Marker ───────────────────────────────────────────────────────────

export const INBOUND_MARKER_LABEL = "Inbound-ID";
const MARKER_RE = /Inbound-ID:\s*(inb-[A-Za-z0-9-]{8,64})/;

export function newInboundLogId(): string {
  return `inb-${randomUUID()}`;
}

export function inboundMarkerLine(logId: string): string {
  return `${INBOUND_MARKER_LABEL}: ${logId}`;
}

/** The inbound log id anywhere in the texts (quoted or not), or null. Diagnostics only — see forwardCopyMarker. */
export function findInboundMarker(...texts: Array<string | null | undefined>): string | null {
  for (const t of texts) {
    if (typeof t !== "string" || !t) continue;
    const m = t.match(MARKER_RE);
    if (m) return m[1];
  }
  return null;
}

// The marker as the forward writes it: alone on its own, UNQUOTED line. A
// Gmail reply quotes the forward («> Inbound-ID: …» in text, a blockquote /
// gmail_quote in HTML) — that is a different message which must still be
// filed, so a quoted marker never counts.
const MARKER_LINE_RE = /^[ \t]*Inbound-ID:[ \t]*(inb-[A-Za-z0-9-]{8,64})[ \t]*$/gm;

/** Longest HTML we strip — longer bodies are cut first (bounded regex work). */
const HTML_SCAN_MAX = 200_000;

function htmlWithoutQuotes(html: string): string {
  let s = html.length > HTML_SCAN_MAX ? html.slice(0, HTML_SCAN_MAX) : html;
  // Gmail puts the quoted history in a gmail_quote container that runs to the
  // end. Tag patterns use [^<>] so an unterminated "<" cannot make them
  // backtrack over the whole body (quadratic on hostile input).
  s = s.replace(/<div[^<>]*class="[^"<>]*gmail_quote[\s\S]*$/i, " ");
  for (let i = 0; i < 5 && /<blockquote/i.test(s); i++) s = s.replace(/<blockquote[^<>]*>(?:(?!<blockquote)[\s\S])*?<\/blockquote>/gi, " ");
  s = s.replace(/<blockquote[\s\S]*$/i, " ");
  s = s
    .replace(/<br[^<>]*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|pre)>/gi, "\n")
    .replace(/<[^<>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
  return s;
}

/** The LAST unquoted marker line (an older forward's history may sit above it unquoted, Outlook-style). */
function lastMarkerLine(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(MARKER_LINE_RE)) last = m[1];
  return last;
}

/** The log id when the marker stands on an unquoted line of the text (or of the HTML with its quotes removed). */
export function findUnquotedInboundMarker(bodyText: string | null | undefined, bodyHtml?: string | null): string | null {
  if (typeof bodyText === "string" && bodyText) {
    // The forward's own header block (before the first blank line) carries the
    // marker first; it wins over anything further down (a truncated body may
    // end inside unquoted older history).
    const header = bodyText.split(/\r?\n[ \t]*\r?\n/, 1)[0];
    const h = lastMarkerLine(header);
    if (h) return h;
    const m = lastMarkerLine(bodyText);
    if (m) return m;
  }
  if (typeof bodyHtml === "string" && bodyHtml) {
    const m = lastMarkerLine(htmlWithoutQuotes(bodyHtml));
    if (m) return m;
  }
  return null;
}

/** Plain text from untrusted HTML without quadratic regex work. */
export function htmlToPlainText(html: string): string {
  const s = html.length > HTML_SCAN_MAX ? html.slice(0, HTML_SCAN_MAX) : html;
  return s.replace(/<[^<>]*>/g, " ").replace(/\s+/g, " ").trim();
}

const FORWARD_SUBJECT_RE = /^\s*\[Innkommende\]/i;

/**
 * The log id if `m` IS the server's forwarded copy: an inbound message whose
 * subject starts with «[Innkommende]» (a «Fwd:»/«Re:» of it does not) and
 * whose own, unquoted text carries the marker. Anything else returns null.
 */
export function forwardCopyMarker(
  m: {
    direction?: string | null;
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
  },
  /** The Gmail thread's subject, used when the message itself carries none. */
  fallbackSubject?: string | null,
): string | null {
  if (m.direction !== "in") return null;
  const subject = m.subject ?? fallbackSubject ?? "";
  if (!FORWARD_SUBJECT_RE.test(subject)) return null;
  return findUnquotedInboundMarker(m.bodyText, m.bodyHtml);
}

// ─── Platform from recipient domain ──────────────────────────────────

export const INBOUND_DOMAIN_VERTICALS: Readonly<Record<string, CrmVertical>> = {
  "rettfrabonden.com": "rfb",
  "opplevagent.no": "experiences",
  "finn-tannlege.com": "dental",
};

export type InboundVerticalOutcome =
  | { vertical: CrmVertical; matchedAddress: string }
  | { vertical: null; reason: string; matches: Array<{ address: string; vertical: CrmVertical }> };

function toStringList(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x) => toStringList(x));
  if (typeof v === "string") return v.trim() ? [v] : [];
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Resend may give {email, name} objects.
    if (typeof o.email === "string") return [o.email];
    if (typeof o.address === "string") return [o.address];
  }
  return [];
}

/** All bare addresses in a to/cc value (string, array, or {email} objects). */
export function addressesOf(v: unknown): string[] {
  return toStringList(v).flatMap((s) => extractAddresses(s));
}

export function deriveInboundVertical(recipients: string[]): InboundVerticalOutcome {
  const matches: Array<{ address: string; vertical: CrmVertical }> = [];
  for (const addr of recipients) {
    const domain = addr.split("@")[1]?.toLowerCase() ?? "";
    const vertical = INBOUND_DOMAIN_VERTICALS[domain];
    if (vertical) matches.push({ address: addr, vertical });
  }
  const distinct = [...new Set(matches.map((m) => m.vertical))];
  if (distinct.length === 1) return { vertical: distinct[0], matchedAddress: matches[0].address };
  if (distinct.length === 0) {
    return {
      vertical: null,
      reason:
        `no recipient is on a platform domain (${Object.keys(INBOUND_DOMAIN_VERTICALS).join(", ")}) — ` +
        `recipients: ${recipients.join(", ") || "(none)"}`,
      matches,
    };
  }
  return {
    vertical: null,
    reason: `the mail names more than one platform (${matches.map((m) => `${m.address}→${m.vertical}`).join("; ")}) — refusing to pick one`,
    matches,
  };
}

// ─── Headers ──────────────────────────────────────────────────────────

export interface InboundHeaders {
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
  autoSubmitted: string | null;
  precedence: string | null;
  xAutoreply: boolean;
}

/** "<Abc@Host>" → "abc@host" (the form every lookup compares on). */
export function normalizeMessageId(s: string): string {
  return s.trim().replace(/^<+/, "").replace(/>+$/, "").trim().toLowerCase();
}

/** Message-ids in a References / In-Reply-To value. */
export function parseMessageIdList(v: string | null | undefined): string[] {
  if (typeof v !== "string" || !v.trim()) return [];
  const bracketed = v.match(/<[^<>\s]+>/g);
  const raw = bracketed && bracketed.length > 0 ? bracketed : v.split(/[\s,]+/);
  const out: string[] = [];
  for (const r of raw) {
    const n = normalizeMessageId(r);
    if (n && n.includes("@") && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Collect header values by (case-insensitive) name from the shapes Resend may use. */
function headerValues(source: unknown, name: string): string[] {
  if (!source || typeof source !== "object") return [];
  const lname = name.toLowerCase();
  const out: string[] = [];
  const s = source as Record<string, unknown>;
  const containers: unknown[] = [s.headers];
  for (const c of containers) {
    if (Array.isArray(c)) {
      for (const h of c) {
        if (h && typeof h === "object") {
          const hn = (h as any).name ?? (h as any).key;
          const hv = (h as any).value;
          if (typeof hn === "string" && hn.toLowerCase() === lname && typeof hv === "string") out.push(hv);
        }
      }
    } else if (c && typeof c === "object") {
      for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
        if (k.toLowerCase() !== lname) continue;
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
      }
    }
  }
  // Top-level snake/camel fields (e.g. data.message_id).
  const snake = lname.replace(/-/g, "_");
  const camel = snake.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  for (const k of [snake, camel]) {
    const v = s[k];
    if (typeof v === "string") out.push(v);
  }
  return out;
}

/** Read the threading/automation headers from the webhook data and/or the fetched email. */
export function readInboundHeaders(...sources: unknown[]): InboundHeaders {
  const first = (name: string): string | null => {
    for (const src of sources) {
      const v = headerValues(src, name).find((x) => x.trim() !== "");
      if (v) return v;
    }
    return null;
  };
  const all = (name: string): string[] => sources.flatMap((src) => headerValues(src, name));
  const mid = first("message-id");
  const inReplyTo = [...new Set(all("in-reply-to").flatMap((v) => parseMessageIdList(v)))];
  const references = [...new Set(all("references").flatMap((v) => parseMessageIdList(v)))];
  const xa = first("x-autoreply") ?? first("x-autorespond");
  return {
    messageId: mid ? normalizeMessageId(mid) || null : null,
    inReplyTo,
    references,
    autoSubmitted: first("auto-submitted"),
    precedence: first("precedence"),
    xAutoreply: !!(xa && xa.trim()),
  };
}

// ─── Automated mail ───────────────────────────────────────────────────

export type AutomatedKind = "auto_reply" | "bounce" | null;

const BOUNCE_FROM_RE = /^(mailer-daemon|postmaster|mail-daemon|bounce[s]?)@/i;
const BOUNCE_SUBJECT_RE =
  /(undeliverable|undelivered mail|delivery status notification|mail delivery (failed|failure|subsystem)|returned mail|delivery has failed|failure notice|ikke levert|kunne ikke leveres|levering mislyktes|leveringsfeil|meldingen ble ikke levert)/i;
// Conservative on purpose: a customer subject must never be mistaken for an
// auto-reply (it would then not count as «needs reply»). Each phrase must be
// followed by end, whitespace or punctuation — JS \b treats æøå as non-word,
// so "\b" alone would let e.g. "Fraværendeå…" through.
const AUTOREPLY_SUBJECT_RE =
  /^(automatisk svar|autosvar|autoreply|auto-reply|automatic reply|out of office|abwesend|fraværende|frånvarande|ikke på kontoret|not in the office|away from the office)(?=$|[\s:;,.!\-–—()])|^auto:/i;

export function classifyAutomated(input: { subject: string | null | undefined; fromEmail: string; headers: InboundHeaders }): {
  kind: AutomatedKind;
  reason: string | null;
} {
  const subj = (input.subject ?? "").trim();
  if (BOUNCE_FROM_RE.test(input.fromEmail.trim())) return { kind: "bounce", reason: `sender ${input.fromEmail}` };
  if (BOUNCE_SUBJECT_RE.test(subj)) return { kind: "bounce", reason: "bounce subject" };
  const as = input.headers.autoSubmitted?.trim().toLowerCase();
  if (as && as !== "no") return { kind: "auto_reply", reason: `Auto-Submitted: ${as}` };
  if (input.headers.xAutoreply) return { kind: "auto_reply", reason: "X-Autoreply header" };
  const prec = input.headers.precedence?.trim().toLowerCase();
  if (prec === "auto_reply" || prec === "auto-reply") return { kind: "auto_reply", reason: `Precedence: ${prec}` };
  // Strip a leading "Re:/SV:" before testing the auto-reply subject.
  const bare = subj.replace(/^((re|sv|aw)\s*:\s*)+/i, "");
  if (AUTOREPLY_SUBJECT_RE.test(bare)) return { kind: "auto_reply", reason: "auto-reply subject" };
  return { kind: null, reason: null };
}

// ─── Subject ──────────────────────────────────────────────────────────

/** Lowercased subject without Re:/SV:/Fwd: prefixes, [Innkommende] and extra spaces. */
export function normalizeSubject(s: string | null | undefined): string {
  let t = (s ?? "").replace(/\s+/g, " ").trim();
  // Reply/forward prefixes and the forward's own «[Innkommende]» tag, in any
  // order («Re: [Innkommende] X (fra …)» is Daniel's Gmail reply to a forward).
  const PREFIX = /^(((re|sv|aw|vs|fw|fwd|vb|videresend|videresendt|wg|tr)\s*(\[\d+\])?\s*:)|\[innkommende\])\s*/i;
  for (let i = 0; i < 10 && PREFIX.test(t); i++) t = t.replace(PREFIX, "").trim();
  // The forward appends « (fra <sender>)»; a reply to the forward keeps it.
  t = t.replace(/\s*\(fra [^()]*\)\s*$/i, "").trim();
  return t.toLowerCase();
}

// ─── Thread lookup ────────────────────────────────────────────────────

export type LinkedBy = "header" | "subject" | null;

export function findThreadForInbound(input: {
  vertical: CrmVertical;
  fromEmail: string;
  subject: string | null | undefined;
  refIds: string[];
}): { threadId: string; linkedBy: Exclude<LinkedBy, null> } | null {
  const db = getDb();
  const threadOk = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const t = db.prepare("SELECT id, vertical_id FROM crm_threads WHERE id = ?").get(id) as
      | { id: string; vertical_id: string }
      | undefined;
    return t && t.vertical_id === input.vertical ? t.id : null;
  };

  // 1) Header match, newest reference first (References lists oldest→newest).
  const ids = [...input.refIds].reverse();
  const byOutbox = db.prepare(
    "SELECT thread_id FROM crm_outbox WHERE result_id IS NOT NULL AND LOWER(REPLACE(REPLACE(result_id,'<',''),'>','')) = ? AND thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  );
  const byInbound = db.prepare(
    "SELECT crm_thread_id FROM inbound_email_log WHERE rfc_message_id = ? AND crm_thread_id IS NOT NULL ORDER BY received_at DESC LIMIT 1",
  );
  for (const id of ids) {
    const o = byOutbox.get(id) as { thread_id: string } | undefined;
    const t1 = threadOk(o?.thread_id);
    if (t1) return { threadId: t1, linkedBy: "header" };
    const i = byInbound.get(id) as { crm_thread_id: string } | undefined;
    const t2 = threadOk(i?.crm_thread_id);
    if (t2) return { threadId: t2, linkedBy: "header" };
  }

  // 2) Same contact + same normalized subject, within 180 days.
  const norm = normalizeSubject(input.subject);
  if (norm.length >= 6) {
    const rows = db
      .prepare(
        `SELECT t.id, t.subject FROM crm_threads t
           JOIN crm_contacts c ON c.id = t.contact_id
          WHERE t.vertical_id = ?
            AND LOWER(c.email) = ?
            AND julianday(COALESCE(t.last_message_at, t.created_at)) >= julianday('now') - 180
          ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
          LIMIT 50`,
      )
      .all(input.vertical, input.fromEmail.trim().toLowerCase()) as Array<{ id: string; subject: string | null }>;
    for (const r of rows) {
      if (normalizeSubject(r.subject) === norm) return { threadId: r.id, linkedBy: "subject" };
    }
  }
  return null;
}

// ─── Aliases (Gmail thread id → server thread id) ─────────────────────

export function resolveThreadAlias(id: string): string {
  try {
    const r = getDb().prepare("SELECT thread_id FROM crm_thread_aliases WHERE alias_id = ?").get(id) as
      | { thread_id: string }
      | undefined;
    return r?.thread_id ?? id;
  } catch {
    return id;
  }
}

/**
 * Record `aliasId` → `threadId`. Never for an id that is itself a real thread:
 * the alias would silently redirect every /threads/<id> route of that thread.
 */
export function recordThreadAlias(aliasId: string, threadId: string, source: string): boolean {
  if (!aliasId || aliasId === threadId) return false;
  const db = getDb();
  if (db.prepare("SELECT 1 FROM crm_threads WHERE id = ?").get(aliasId)) return false;
  const r = db
    .prepare("INSERT OR IGNORE INTO crm_thread_aliases (alias_id, thread_id, source) VALUES (?, ?, ?)")
    .run(aliasId, threadId, source);
  return r.changes > 0;
}

/** Does the inbound log still hold this row? (Rows are purged after 90 days.) A DB error throws — never read as «gone». */
export function inboundLogExists(logId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM inbound_email_log WHERE id = ?").get(logId);
}

/** The automated classification the server stored for this e-mail (auto_reply / bounce), or null. */
export function inboundLogAutomatedKind(logId: string): string | null {
  const r = getDb().prepare("SELECT automated_kind FROM inbound_email_log WHERE id = ?").get(logId) as { automated_kind: string | null } | undefined;
  return r?.automated_kind ?? null;
}

/** Is this one of our own platform addresses (any subdomain)? */
export function isOurPlatformAddress(email: string | null | undefined): boolean {
  const d = (email ?? "").trim().toLowerCase().split("@")[1] ?? "";
  if (!d) return false;
  return Object.keys(INBOUND_DOMAIN_VERTICALS).some((o) => d === o || d.endsWith("." + o));
}

/** «[Innkommende] X (fra …)» → «X»: the forward's own decoration off a subject before classifying it. */
export function stripForwardSubject(subject: string | null): string | null {
  if (!subject) return subject;
  return subject.replace(/^\s*\[Innkommende\]\s*/i, "").replace(/\s*\(fra [^()]*\)\s*$/i, "");
}

export type MarkerTarget =
  | { kind: "thread"; threadId: string; vertical: string; contactId: string }
  | { kind: "untriaged"; logId: string };

/**
 * Where the server filed the e-mail a forwarded copy belongs to: its CRM
 * thread (also after an untriaged item was assigned — the assign replays it
 * as thread `inbound-<logId>`), or still parked as untriaged. Null when the
 * server did not file it (flag off, error, unknown id).
 */
export function serverThreadForMarker(logId: string): MarkerTarget | null {
  const db = getDb();
  const row = db.prepare("SELECT crm_thread_id, crm_status FROM inbound_email_log WHERE id = ?").get(logId) as
    | { crm_thread_id: string | null; crm_status: string | null }
    | undefined;
  if (!row) return null;
  const threadId = row.crm_thread_id ?? (row.crm_status === "untriaged" ? `inbound-${logId}` : null);
  if (threadId) {
    const t = db.prepare("SELECT id, vertical_id, contact_id FROM crm_threads WHERE id = ?").get(threadId) as
      | { id: string; vertical_id: string; contact_id: string }
      | undefined;
    if (t) return { kind: "thread", threadId: t.id, vertical: t.vertical_id, contactId: t.contact_id };
  }
  if (row.crm_status === "untriaged") return { kind: "untriaged", logId };
  return null;
}

// ─── Inbound log ──────────────────────────────────────────────────────

export interface InboundLogInsert {
  id: string;
  emailId: string | null;
  fromEmail: string;
  toEmails: string[];
  ccEmails: string[];
  subject: string | null;
}

export function insertInboundLog(row: InboundLogInsert): void {
  getDb()
    .prepare(
      `INSERT INTO inbound_email_log (id, email_id, from_email, to_emails, cc_emails, subject)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.emailId, row.fromEmail, JSON.stringify(row.toEmails), JSON.stringify(row.ccEmails), row.subject);
}

export function updateInboundLog(id: string, fields: Record<string, string | number | null>): void {
  const allowed = new Set([
    "rfc_message_id", "in_reply_to", "vertical", "automated_kind", "body_fetch", "crm_status", "crm_thread_id",
    "crm_linked_by", "crm_error", "forward_status", "forward_attempts", "forward_error", "forwarded_at", "forward_payload",
  ]);
  const keys = Object.keys(fields).filter((k) => allowed.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  getDb()
    .prepare(`UPDATE inbound_email_log SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

// ─── Registration ─────────────────────────────────────────────────────

export interface RegisterInboundInput {
  logId: string;
  emailId: string | null;
  fromEmail: string;
  fromName?: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  sentAt: string | null;
  headers: InboundHeaders;
}

export type RegisterInboundResult =
  | {
      status: "registered";
      threadId: string;
      contactId: string;
      vertical: CrmVertical;
      newMessages: number;
      linkedBy: LinkedBy;
      reopened: boolean;
      automated: AutomatedKind;
    }
  | { status: "untriaged"; untriagedId: string; reason: string };

/**
 * Register one inbound e-mail in the CRM (or park it). Synchronous and
 * idempotent: the message id is derived from the log id, so a repeat call for
 * the same log row adds nothing.
 */
export function registerInboundInCrm(input: RegisterInboundInput): RegisterInboundResult {
  const recipients = [...input.toEmails, ...input.ccEmails];
  const routing = deriveInboundVertical(recipients);
  const automated = classifyAutomated({ subject: input.subject, fromEmail: input.fromEmail, headers: input.headers });
  const snippet = (input.bodyText ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null;

  if (routing.vertical === null) {
    const parked = parkUntriaged({
      threadId: `inbound-${input.logId}`,
      fromEmail: input.fromEmail,
      subject: input.subject,
      snippet,
      reason: routing.reason,
      signals: { source: "resend_inbound", to: input.toEmails, cc: input.ccEmails, matches: routing.matches },
      rawPayload: {
        threadId: `inbound-${input.logId}`,
        primaryFromEmail: input.fromEmail,
        subject: input.subject,
        messages: [
          {
            messageId: `rsnd-${input.emailId ?? input.logId}`,
            direction: "in",
            fromEmail: input.fromEmail,
            toEmails: input.toEmails,
            ccEmails: input.ccEmails,
            subject: input.subject,
            bodyText: input.bodyText,
            snippet,
            sentAt: input.sentAt,
          },
        ],
      },
    });
    return { status: "untriaged", untriagedId: parked.id, reason: routing.reason };
  }

  const vertical = routing.vertical;
  const refIds = [...input.headers.references, ...input.headers.inReplyTo];
  const found = findThreadForInbound({ vertical, fromEmail: input.fromEmail, subject: input.subject, refIds });
  const threadId = found?.threadId ?? `inbound-${input.logId}`;

  const result = crmService.ingestThread(
    {
      threadId,
      // Never overwrite an existing thread's subject/category from a reply.
      subject: found ? undefined : input.subject,
      category: found ? undefined : "innkommende",
      messages: [
        {
          messageId: `rsnd-${input.emailId ?? input.logId}`,
          direction: "in",
          fromEmail: input.fromEmail,
          toEmails: input.toEmails,
          ccEmails: input.ccEmails,
          subject: input.subject,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml,
          snippet,
          sentAt: input.sentAt,
          rawMetadata: {
            source: "resend_inbound",
            inbound_log_id: input.logId,
            email_id: input.emailId,
            rfc_message_id: input.headers.messageId,
            in_reply_to: input.headers.inReplyTo,
            linked_by: found?.linkedBy ?? null,
            automated: automated.kind !== null,
            automated_kind: automated.kind,
            automated_reason: automated.reason,
          },
        },
      ],
    },
    input.fromEmail,
    vertical,
  );

  if (input.fromName) {
    getDb().prepare("UPDATE crm_contacts SET name = COALESCE(name, ?) WHERE id = ?").run(input.fromName, result.contactId);
  }

  let reopened = false;
  if (result.newMessages > 0 && automated.kind === null) {
    const t = getDb().prepare("SELECT status FROM crm_threads WHERE id = ?").get(threadId) as { status: string } | undefined;
    if (t && (t.status === "done" || t.status === "archived")) {
      crmService.setThreadStatus(threadId, "new", "system");
      crmService.logAction({
        threadId,
        contactId: result.contactId,
        type: "reopened_by_inbound",
        actor: "system",
        payload: { previousStatus: t.status, inboundLogId: input.logId },
      });
      reopened = true;
    }
  }

  return {
    status: "registered",
    threadId,
    contactId: result.contactId,
    vertical,
    newMessages: result.newMessages,
    linkedBy: found?.linkedBy ?? null,
    reopened,
    automated: automated.kind,
  };
}
