// ─── CS på serveren, S2: svarforslag, sendejobb og godkjenningskø ──────────
// dev-request 2026-11-10-cs-paa-serveren (slookisen/A2A), skive S2.
//
// The CS routine no longer sends. It writes a PROPOSAL for a thread; the server
// decides whether that proposal may go out on its own:
//
//   • createReplyProposal — stores the proposal. The recipient is NEVER taken
//     from the caller: it is the sender of the thread's latest human inbound
//     message, so a reply can only ever go back to whoever wrote to us.
//   • evaluateProposal — every gate a reply must pass, as data (no side
//     effects): known kind, linked change requests verified (S4), no claim of
//     a change in the text without a verified change behind it, platform
//     branding, mojibake / transliterated æøå, bounce/complaint, 24 h
//     duplicate, per-recipient and per-day reply quotas (separate from the
//     outreach cap), live transport.
//   • processProposal — evaluate, take a lease, send in the SAME thread
//     (In-Reply-To), record outbox + crm_messages + action, release. A
//     transport failure is retried (PROPOSAL_MAX_ATTEMPTS); a lease that
//     expires mid-send is NOT retried (the mail may have gone out) but marked
//     failed with «ukjent utfall» so the watchdog alerts.
//   • a proposal that fails a gate is never dropped: it becomes
//     `approval_needed` with the reason, shows in admin-CRM «Godkjenningskø»
//     and in «Trenger svar», and Daniel sends / edits / rejects it there.
//   • runCsAutosend — the per-minute worker (CS_AUTOSEND_ENABLED).
//
// CS replies made here go through crm_outbox (intent resend_send) and
// crm_messages like any reply. They never call executeCompose, so they never
// reserve OUTREACH_MAX_PER_DAY, and since a proposal requires an inbound
// message on its thread, the cold-outreach triggers (which skip any thread
// with an inbound message) never log them to outreach_sent_log.

import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { crmService, isCrmVertical, CrmVertical } from "./crm-service";
import { crmFromHeader, resolveCrmIdentity, lintOutboundBodyForForeignBranding } from "./crm-platform-identity";
import { emailService } from "./email-service";
import { plainTextToEmailHtml } from "../utils/plain-text-to-html";
import { containsMojibake } from "./search-enrich";
import { recordRun } from "./run-ledger";
import { EnvelopeBuilder } from "../types/run-envelope";

export const CS_AUTOSEND_FLAG = "CS_AUTOSEND_ENABLED";
export function csAutosendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[CS_AUTOSEND_FLAG];
  return v === "1" || v === "true";
}

export const REPLY_KINDS = [
  "takk",
  "rettelse_bekreftet",
  "faq",
  "fjern_steg1",
  "fjern_beholdes",
  "fjernet",
  "eierkrav_info",
  "kontakt_kvittering",
  "annet",
] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];
export function isReplyKind(k: unknown): k is ReplyKind {
  return typeof k === "string" && (REPLY_KINDS as readonly string[]).includes(k);
}

/** Kinds the worker may send without Daniel. `annet` always goes to the approval queue. Override: CS_AUTOSEND_KINDS (comma list). */
export const DEFAULT_AUTOSEND_KINDS: readonly ReplyKind[] = REPLY_KINDS.filter((k) => k !== "annet");
export function autosendKinds(env: NodeJS.ProcessEnv = process.env): ReplyKind[] {
  const raw = (env.CS_AUTOSEND_KINDS ?? "").trim();
  if (!raw) return [...DEFAULT_AUTOSEND_KINDS];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ReplyKind => isReplyKind(s) && s !== "annet");
}

/** Kinds whose whole point is to confirm a change: they need at least one linked, verified change request. */
export const CHANGE_CONFIRMING_KINDS: readonly ReplyKind[] = ["rettelse_bekreftet", "fjernet"];

export const PROPOSAL_MAX_ATTEMPTS = 3;
export const PROPOSAL_LEASE_MS = 5 * 60_000;
export const PROPOSAL_RETRY_BASE_MS = 2 * 60_000;
export const DUPLICATE_WINDOW_HOURS = 24;

function intEnv(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const n = parseInt(String(env[name] ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
export function autosendMaxPerDay(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env, "CS_AUTOSEND_MAX_PER_DAY", 40);
}
export function autosendMaxPerRecipientPerDay(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env, "CS_AUTOSEND_MAX_PER_RECIPIENT_PER_DAY", 3);
}

export type ProposalStatus =
  | "pending" // waiting for the worker
  | "approval_needed" // stopped by a gate (or autosend off) — in the approval queue
  | "approved" // Daniel pressed Send — being sent
  | "sending" // leased by a sender
  | "sent"
  | "failed" // transport failed PROPOSAL_MAX_ATTEMPTS times, or outcome unknown
  | "rejected"
  | "superseded"; // a newer proposal or a reply already sent on the thread

export interface ProposalRow {
  id: string;
  thread_id: string;
  vertical: string;
  kind: string;
  to_email: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  in_reply_to: string | null;
  answers_message_id: string | null;
  change_request_ids: string;
  evidence: string | null;
  created_by: string;
  status: ProposalStatus;
  block_reason: string | null;
  block_detail: string | null;
  attempts: number;
  lease_until: string | null;
  next_attempt_at: string | null;
  outbox_id: string | null;
  crm_message_id: string | null;
  smtp_message_id: string | null;
  last_error: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  sent_at: string | null;
  sent_mode: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Text checks ──────────────────────────────────────────────────────

/**
 * Norwegian written without æøå («paa», «naar», «ogsaa» …). The CS SKILL's P0
 * rule forbids it in visible text; a whole-word match on these spellings is
 * unambiguous (none is a Norwegian word in its own right).
 */
const TRANSLITERATED_RE = /(?<![\p{L}\p{N}])(paa|naar|ogsaa|faar|gaar|vaar|hilsner fra oss paa|tilbakemeldingen din paa)(?![\p{L}\p{N}])/iu;

export function findEncodingProblem(...texts: Array<string | null | undefined>): string | null {
  for (const t of texts) {
    if (!t) continue;
    if (containsMojibake(t)) return "mojibake";
    const m = TRANSLITERATED_RE.exec(t);
    if (m) return `æøå mangler («${m[1]}»)`;
  }
  return null;
}

/**
 * Does the text tell the recipient a change HAS been made? Used only on the
 * automatic path: such a claim needs a verified change request behind it.
 */
const CHANGE_CLAIM_RE =
  /(?<![\p{L}])(har|er|ble|blitt)\s+(nå\s+|na\s+|no\s+)?(fjernet|slettet|oppdatert|endret|rettet|korrigert|skjult|avpublisert|lagt inn|lagt til|byttet)(?![\p{L}])/iu;
export function claimsChange(text: string | null | undefined): boolean {
  return !!text && CHANGE_CLAIM_RE.test(text);
}

/** «Re: <original subject>» without stacking prefixes, original case kept. */
export function replySubject(s: string | null | undefined): string {
  let t = (s ?? "").replace(/\s+/g, " ").trim();
  const PREFIX = /^(((re|sv|aw|vs|fw|fwd|vb|wg|tr)\s*(\[\d+\])?\s*:)|\[innkommende\])\s*/i;
  for (let i = 0; i < 10 && PREFIX.test(t); i++) t = t.replace(PREFIX, "").trim();
  t = t.replace(/\s*\(fra [^()]*\)\s*$/i, "").trim();
  return t ? `Re: ${t}` : "Re: din henvendelse";
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function parseIdList(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
  } catch {
    return [];
  }
}

// ─── Thread facts ─────────────────────────────────────────────────────

export interface LatestInbound {
  message_id: string;
  from_email: string;
  subject: string | null;
  at: string;
  rfc_message_id: string | null;
}

/** The thread's latest inbound message from a person (auto-replies and bounces skipped). */
export function latestHumanInbound(threadId: string): LatestInbound | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, from_email, subject, COALESCE(sent_at, received_at) AS at, raw_metadata
         FROM crm_messages
        WHERE thread_id = ? AND direction = 'in'
          AND NOT (COALESCE(json_valid(raw_metadata), 0) = 1 AND COALESCE(json_extract(raw_metadata, '$.automated'), 0) = 1)
        ORDER BY julianday(COALESCE(sent_at, received_at)) DESC, rowid DESC
        LIMIT 1`,
    )
    .get(threadId) as { id: string; from_email: string; subject: string | null; at: string; raw_metadata: string | null } | undefined;
  if (!row || !row.from_email) return null;
  let rfc: string | null = null;
  try {
    const meta = JSON.parse(row.raw_metadata ?? "{}");
    if (typeof meta?.rfc_message_id === "string" && meta.rfc_message_id) rfc = meta.rfc_message_id;
  } catch {
    // ignore
  }
  if (!rfc) {
    try {
      const log = db
        .prepare(
          `SELECT rfc_message_id FROM inbound_email_log
            WHERE crm_thread_id = ? AND LOWER(from_email) = LOWER(?) AND rfc_message_id IS NOT NULL
            ORDER BY received_at DESC LIMIT 1`,
        )
        .get(threadId, row.from_email) as { rfc_message_id: string } | undefined;
      if (log?.rfc_message_id) rfc = log.rfc_message_id;
    } catch {
      // inbound_email_log missing — reply still threads by subject
    }
  }
  return { message_id: row.id, from_email: row.from_email.trim().toLowerCase(), subject: row.subject, at: row.at, rfc_message_id: rfc };
}

function changeRequestStatuses(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  try {
    const db = getDb();
    const stmt = db.prepare("SELECT status FROM cs_change_requests WHERE id = ?");
    for (const id of ids) {
      const r = stmt.get(id) as { status: string } | undefined;
      if (r) out.set(id, r.status);
    }
  } catch {
    // cs_change_requests not there yet (S4 not deployed) — every id counts as unverified
  }
  return out;
}

// ─── Create ───────────────────────────────────────────────────────────

export interface CreateProposalInput {
  threadId: string;
  kind: ReplyKind;
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  changeRequestIds?: string[];
  evidence?: unknown;
  createdBy: "claude" | "daniel";
}

export type CreateProposalResult =
  | { ok: true; proposal: ProposalRow; superseded: string[] }
  | { ok: false; status: number; error: string; detail?: string };

export function createReplyProposal(input: CreateProposalInput, deps: { now?: Date; env?: NodeJS.ProcessEnv } = {}): CreateProposalResult {
  const now = deps.now ?? new Date();
  const env = deps.env ?? process.env;
  const db = getDb();
  const thread = db.prepare("SELECT id, subject, vertical_id, contact_id FROM crm_threads WHERE id = ?").get(input.threadId) as
    | { id: string; subject: string | null; vertical_id: string; contact_id: string }
    | undefined;
  if (!thread) return { ok: false, status: 404, error: "thread not found" };
  if (!isCrmVertical(thread.vertical_id)) {
    return { ok: false, status: 409, error: "thread has no valid vertical", detail: String(thread.vertical_id) };
  }
  const inbound = latestHumanInbound(thread.id);
  if (!inbound) {
    return {
      ok: false,
      status: 409,
      error: "no_inbound_message",
      detail: "a reply proposal answers a message from a person on this thread; this thread has none — use /compose for a new e-mail",
    };
  }
  const subject = (input.subject ?? "").trim() || replySubject(thread.subject ?? inbound.subject);
  const id = `rp-${randomUUID()}`;
  const ts = nowIso(now);
  const autosend = csAutosendEnabled(env);
  const status: ProposalStatus = autosend ? "pending" : "approval_needed";

  const superseded: string[] = [];
  const tx = db.transaction(() => {
    const older = db
      .prepare(`SELECT id FROM cs_reply_proposals WHERE thread_id = ? AND status IN ('pending', 'approval_needed')`)
      .all(thread.id) as Array<{ id: string }>;
    for (const o of older) {
      db.prepare(
        `UPDATE cs_reply_proposals SET status = 'superseded', block_reason = 'nyere_forslag', block_detail = ?, updated_at = ? WHERE id = ?`,
      ).run(id, ts, o.id);
      superseded.push(o.id);
    }
    db.prepare(
      `INSERT INTO cs_reply_proposals
         (id, thread_id, vertical, kind, to_email, subject, body_text, body_html, in_reply_to, answers_message_id,
          change_request_ids, evidence, created_by, status, block_reason, block_detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      thread.id,
      thread.vertical_id,
      input.kind,
      inbound.from_email,
      subject,
      input.bodyText,
      input.bodyHtml ?? null,
      inbound.rfc_message_id,
      inbound.message_id,
      JSON.stringify(Array.from(new Set(input.changeRequestIds ?? []))),
      input.evidence === undefined ? null : JSON.stringify(input.evidence),
      input.createdBy,
      status,
      autosend ? null : "autosending_av",
      autosend ? null : `${CS_AUTOSEND_FLAG} er av — forslaget venter på Daniel`,
      ts,
      ts,
    );
  });
  tx();
  crmService.logAction({
    threadId: thread.id,
    contactId: thread.contact_id,
    type: "reply_proposed",
    actor: input.createdBy,
    payload: { proposalId: id, kind: input.kind, status, superseded },
  });
  return { ok: true, proposal: getProposal(id)!, superseded };
}

export function getProposal(id: string): ProposalRow | null {
  return (getDb().prepare("SELECT * FROM cs_reply_proposals WHERE id = ?").get(id) as ProposalRow | undefined) ?? null;
}

// ─── Evaluate ─────────────────────────────────────────────────────────

export type SendMode = "auto" | "approved";

export type Evaluation =
  | { ok: true; to: string; inReplyTo: string | null }
  | { ok: false; outcome: "approval_needed" | "superseded"; reason: string; detail: string };

/**
 * Every gate, read-only. `auto` is the worker; `approved` is Daniel pressing
 * Send — that skips the gates that exist only to make Daniel look (kind,
 * change wording in the text, quotas, a newer message on the thread) but
 * keeps the hard ones (thread, recipient, linked changes verified, branding,
 * encoding, duplicate, bounce/complaint, live transport).
 */
export function evaluateProposal(p: ProposalRow, mode: SendMode, deps: { now?: Date; env?: NodeJS.ProcessEnv; liveTransport?: boolean } = {}): Evaluation {
  const now = deps.now ?? new Date();
  const env = deps.env ?? process.env;
  const db = getDb();
  const stop = (reason: string, detail: string): Evaluation => ({ ok: false, outcome: "approval_needed", reason, detail });

  const thread = db.prepare("SELECT id, vertical_id, last_outbound_at FROM crm_threads WHERE id = ?").get(p.thread_id) as
    | { id: string; vertical_id: string; last_outbound_at: string | null }
    | undefined;
  if (!thread) return stop("traad_mangler", `tråden ${p.thread_id} finnes ikke lenger`);
  if (!isCrmVertical(thread.vertical_id) || thread.vertical_id !== p.vertical) {
    return stop("feil_plattform", `trådens plattform er ${thread.vertical_id}, forslaget gjelder ${p.vertical}`);
  }

  // Someone already answered after this proposal was written.
  if (thread.last_outbound_at && Date.parse(normTs(thread.last_outbound_at)) > Date.parse(normTs(p.created_at))) {
    return { ok: false, outcome: "superseded", reason: "allerede_besvart", detail: `tråden fikk svar ${thread.last_outbound_at}` };
  }

  const inbound = latestHumanInbound(p.thread_id);
  if (!inbound) return stop("ingen_innkommende", "tråden har ingen innkommende melding fra en person");
  if (inbound.from_email !== p.to_email.trim().toLowerCase()) {
    return stop("mottaker_endret", `siste innkommende er nå fra en annen adresse enn forslaget svarer`);
  }
  if (mode === "auto" && p.answers_message_id && inbound.message_id !== p.answers_message_id) {
    return stop("ny_melding_etter_forslag", "kunden har skrevet igjen etter at forslaget ble laget");
  }

  if (mode === "auto" && !autosendKinds(env).includes(p.kind as ReplyKind)) {
    return stop("kind_krever_godkjenning", `type «${p.kind}» sendes ikke automatisk`);
  }

  const crIds = parseIdList(p.change_request_ids);
  if (CHANGE_CONFIRMING_KINDS.includes(p.kind as ReplyKind) && crIds.length === 0) {
    return stop("endring_mangler", `type «${p.kind}» bekrefter en endring, men ingen endringsforespørsel er koblet til`);
  }
  if (crIds.length > 0) {
    const st = changeRequestStatuses(crIds);
    const notVerified = crIds.filter((id) => st.get(id) !== "verified");
    if (notVerified.length > 0) {
      return stop("endring_ikke_verifisert", `endring(er) ikke verifisert som utført: ${notVerified.join(", ")}`);
    }
  } else if (mode === "auto" && claimsChange(p.body_text)) {
    return stop("endring_ikke_verifisert", "teksten sier at noe er endret, men ingen verifisert endring er koblet til");
  }

  const lint = lintOutboundBodyForForeignBranding(thread.vertical_id as CrmVertical, p.subject, p.body_text, p.body_html ?? undefined);
  if (lint.violation) return stop("feil_merkevare", `teksten nevner en annen plattform: ${lint.matches.join(", ")}`);
  const enc = findEncodingProblem(p.subject, p.body_text, p.body_html);
  if (enc) return stop("tegnsett", enc);

  const bounced = db
    .prepare(
      `SELECT bounce_type FROM email_bounces
        WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) AND bounce_type IN ('hard', 'complaint')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(p.to_email) as { bounce_type: string } | undefined;
  if (bounced && mode === "auto") {
    return stop("mottaker_avvist", bounced.bounce_type === "complaint" ? "mottakeren har klaget (spam)" : "adressen har hard bounce");
  }

  const dup = db
    .prepare(
      `SELECT id FROM crm_messages
        WHERE thread_id = ? AND direction = 'out' AND delivery_status = 'sent'
          AND TRIM(COALESCE(body_text, '')) = TRIM(?)
          AND julianday(COALESCE(sent_at, received_at)) >= julianday(?) - (? / 24.0)
        LIMIT 1`,
    )
    .get(p.thread_id, p.body_text, nowIso(now), DUPLICATE_WINDOW_HOURS) as { id: string } | undefined;
  if (dup) return stop("duplikat", `samme tekst er allerede sendt i tråden siste ${DUPLICATE_WINDOW_HOURS} t`);

  if (mode === "auto") {
    const perRecipient = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM cs_reply_proposals
            WHERE status = 'sent' AND LOWER(to_email) = LOWER(?) AND julianday(sent_at) >= julianday(?) - 1`,
        )
        .get(p.to_email, nowIso(now)) as { n: number }
    ).n;
    if (perRecipient >= autosendMaxPerRecipientPerDay(env)) {
      return stop("kvote_mottaker", `${perRecipient} automatiske svar til samme adresse siste døgn`);
    }
    const perDay = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM cs_reply_proposals WHERE status = 'sent' AND sent_mode = 'auto' AND julianday(sent_at) >= julianday(?) - 1`)
        .get(nowIso(now)) as { n: number }
    ).n;
    if (perDay >= autosendMaxPerDay(env)) return stop("kvote_dag", `${perDay} automatiske svar siste døgn`);
  }

  const live = deps.liveTransport ?? emailService.isLiveTransport();
  if (!live) return stop("transport_ikke_live", "e-posttransporten er i tørrkjøring — ingenting ville blitt sendt");

  return { ok: true, to: p.to_email, inReplyTo: p.in_reply_to };
}

function normTs(s: string): string {
  return s.includes("T") ? s : s.replace(" ", "T") + "Z";
}

// ─── Process (send) ───────────────────────────────────────────────────

export type SendRawFn = (options: Parameters<typeof emailService.sendRaw>[0]) => Promise<{ success: boolean; messageId?: string; error?: string }>;

export interface ProcessResult {
  id: string;
  outcome: "sent" | "approval_needed" | "superseded" | "retry" | "failed" | "skipped";
  reason?: string;
  detail?: string;
  smtpMessageId?: string;
}

/**
 * Evaluate and, if every gate passes, send one proposal. Safe to call
 * concurrently: the lease UPDATE only succeeds for one caller, and nothing
 * awaits between the evaluation and the lease.
 */
export async function processProposal(
  id: string,
  deps: { now?: Date; env?: NodeJS.ProcessEnv; sendRaw?: SendRawFn; liveTransport?: boolean } = {},
): Promise<ProcessResult> {
  const now = deps.now ?? new Date();
  const ts = nowIso(now);
  const db = getDb();
  const p = getProposal(id);
  if (!p) return { id, outcome: "skipped", reason: "not_found" };
  if (p.status !== "pending" && p.status !== "approved") return { id, outcome: "skipped", reason: `status_${p.status}` };
  if (p.next_attempt_at && Date.parse(p.next_attempt_at) > now.getTime()) return { id, outcome: "skipped", reason: "retry_not_due" };
  const mode: SendMode = p.status === "approved" ? "approved" : "auto";

  const ev = evaluateProposal(p, mode, { now, env: deps.env, liveTransport: deps.liveTransport });
  if (!ev.ok) {
    db.prepare(`UPDATE cs_reply_proposals SET status = ?, block_reason = ?, block_detail = ?, updated_at = ? WHERE id = ? AND status = ?`).run(
      ev.outcome,
      ev.reason,
      ev.detail,
      ts,
      id,
      p.status,
    );
    const thread = db.prepare("SELECT contact_id FROM crm_threads WHERE id = ?").get(p.thread_id) as { contact_id: string } | undefined;
    crmService.logAction({
      threadId: p.thread_id,
      contactId: thread?.contact_id ?? null,
      type: ev.outcome === "superseded" ? "proposal_superseded" : "send_blocked",
      actor: "system",
      payload: { proposalId: id, reason: ev.reason, detail: ev.detail, mode },
    });
    return { id, outcome: ev.outcome, reason: ev.reason, detail: ev.detail };
  }

  // Lease — synchronous, right after the synchronous evaluation.
  const leased = db
    .prepare(
      `UPDATE cs_reply_proposals SET status = 'sending', lease_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status = ?`,
    )
    .run(new Date(now.getTime() + PROPOSAL_LEASE_MS).toISOString(), ts, id, p.status);
  if (leased.changes !== 1) return { id, outcome: "skipped", reason: "lease_lost" };
  const attempt = p.attempts + 1;

  const thread = db.prepare("SELECT contact_id, vertical_id FROM crm_threads WHERE id = ?").get(p.thread_id) as { contact_id: string; vertical_id: CrmVertical };
  const createdBy: "claude" | "daniel" = mode === "approved" ? "daniel" : "claude";

  // Outbox + message rows: created on the first attempt, reused on a retry so
  // the thread does not collect one failed copy per attempt.
  let outboxId = p.outbox_id;
  let messageId = p.crm_message_id;
  try {
    if (!outboxId) {
      outboxId = crmService.enqueueOutbox({
        threadId: p.thread_id,
        contactId: thread.contact_id,
        vertical: thread.vertical_id,
        intent: "resend_send",
        toEmails: [p.to_email],
        subject: p.subject,
        bodyText: p.body_text,
        bodyHtml: p.body_html ?? undefined,
        replyToMessageId: p.in_reply_to,
        createdBy,
      }).id;
    }
    if (!messageId) {
      messageId = crmService.recordOutboundReply({
        threadId: p.thread_id,
        vertical: thread.vertical_id,
        toEmails: [p.to_email],
        subject: p.subject,
        bodyText: p.body_text,
        bodyHtml: p.body_html,
        deliveryStatus: "queued",
        outboxId,
        rawMetadata: { source: "cs_reply_proposal", cs_reply: true, proposal_id: id, kind: p.kind, sent_mode: mode },
      }).messageId;
    } else {
      crmService.updateMessageDeliveryStatus(messageId, "queued");
    }
    db.prepare(`UPDATE crm_outbox SET status = 'processing', error = NULL WHERE id = ?`).run(outboxId);
    db.prepare(`UPDATE cs_reply_proposals SET outbox_id = ?, crm_message_id = ? WHERE id = ?`).run(outboxId, messageId, id);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    db.prepare(
      `UPDATE cs_reply_proposals SET status = 'failed', block_reason = 'lagring_feilet', block_detail = ?, last_error = ?, lease_until = NULL, updated_at = ? WHERE id = ?`,
    ).run(msg, msg, ts, id);
    return { id, outcome: "failed", reason: "lagring_feilet", detail: msg };
  }

  const sendRaw: SendRawFn = deps.sendRaw ?? ((o) => emailService.sendRaw(o));
  let result: { success: boolean; messageId?: string; error?: string };
  try {
    const identity = resolveCrmIdentity(thread.vertical_id);
    result = await sendRaw({
      to: p.to_email,
      subject: p.subject,
      textContent: p.body_text,
      htmlContent: p.body_html ?? plainTextToEmailHtml(p.body_text),
      inReplyToMessageId: p.in_reply_to ?? undefined,
      from: crmFromHeader(thread.vertical_id),
      replyTo: identity.replyTo,
    });
  } catch (e: any) {
    result = { success: false, error: String(e?.message ?? e) };
  }
  const doneTs = nowIso(deps.now ?? new Date());

  if (result.success) {
    try {
      crmService.markOutboxResult(outboxId!, "completed", result.messageId);
      crmService.updateMessageDeliveryStatus(messageId!, "sent");
      crmService.logAction({
        threadId: p.thread_id,
        contactId: thread.contact_id,
        type: "sent",
        actor: createdBy,
        payload: { outboxId, messageId: result.messageId, channel: "resend_smtp", internalMessageId: messageId, proposalId: id, kind: p.kind, mode },
      });
    } catch (e) {
      console.error("[cs-autosend] bookkeeping after an accepted send failed:", e);
    }
    db.prepare(
      `UPDATE cs_reply_proposals
          SET status = 'sent', sent_at = ?, sent_mode = ?, smtp_message_id = ?, lease_until = NULL,
              block_reason = NULL, block_detail = NULL, last_error = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(doneTs, mode, result.messageId ?? null, doneTs, id);
    return { id, outcome: "sent", smtpMessageId: result.messageId };
  }

  const err = result.error || "send failed";
  try {
    crmService.markOutboxResult(outboxId!, "failed", undefined, err);
    crmService.updateMessageDeliveryStatus(messageId!, "failed");
  } catch (e) {
    console.error("[cs-autosend] could not record a failed send:", e);
  }
  if (attempt < PROPOSAL_MAX_ATTEMPTS) {
    const next = new Date(now.getTime() + PROPOSAL_RETRY_BASE_MS * 2 ** (attempt - 1)).toISOString();
    // Back to the state it came from; the outbox row goes back to pending for the next try.
    db.prepare(`UPDATE crm_outbox SET status = 'pending' WHERE id = ?`).run(outboxId);
    db.prepare(
      `UPDATE cs_reply_proposals SET status = ?, lease_until = NULL, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    ).run(p.status, next, err, doneTs, id);
    return { id, outcome: "retry", reason: "transport", detail: err };
  }
  db.prepare(
    `UPDATE cs_reply_proposals
        SET status = 'failed', block_reason = 'sending_feilet', block_detail = ?, last_error = ?, lease_until = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(`transporten feilet ${attempt} ganger: ${err}`, err, doneTs, id);
  crmService.logAction({
    threadId: p.thread_id,
    contactId: thread.contact_id,
    type: "send_failed",
    actor: "system",
    payload: { proposalId: id, attempts: attempt, error: err },
  });
  return { id, outcome: "failed", reason: "sending_feilet", detail: err };
}

/**
 * A lease that ran out means the process died between handing the mail to the
 * transport and recording the result. The mail may have been delivered, so it
 * is NOT re-sent: the proposal is marked failed («ukjent utfall») and alerted.
 */
export function recoverExpiredLeases(now: Date = new Date()): string[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, outbox_id, crm_message_id FROM cs_reply_proposals WHERE status = 'sending' AND lease_until IS NOT NULL AND julianday(lease_until) < julianday(?)`)
    .all(nowIso(now)) as Array<{ id: string; outbox_id: string | null; crm_message_id: string | null }>;
  for (const r of rows) {
    db.prepare(
      `UPDATE cs_reply_proposals
          SET status = 'failed', block_reason = 'ukjent_utfall',
              block_detail = 'sendingen ble avbrutt underveis — kan ha blitt levert; sjekk før du sender på nytt',
              lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending'`,
    ).run(nowIso(now), r.id);
    if (r.outbox_id) {
      db.prepare(`UPDATE crm_outbox SET status = 'failed', error = 'lease expired — outcome unknown', processed_at = datetime('now') WHERE id = ? AND status IN ('pending', 'processing')`).run(r.outbox_id);
    }
  }
  return rows.map((r) => r.id);
}

// ─── Approval queue actions ───────────────────────────────────────────

export interface ProposalEdits {
  subject?: string;
  bodyText?: string;
  bodyHtml?: string | null;
  kind?: ReplyKind;
  changeRequestIds?: string[];
}

function applyEdits(p: ProposalRow, edits: ProposalEdits, ts: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE cs_reply_proposals
        SET subject = ?, body_text = ?, body_html = ?, kind = ?, change_request_ids = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    edits.subject !== undefined ? edits.subject : p.subject,
    edits.bodyText !== undefined ? edits.bodyText : p.body_text,
    // An edited plain text makes the stored HTML stale — drop it unless a new one came with the edit.
    edits.bodyHtml !== undefined ? edits.bodyHtml : edits.bodyText !== undefined ? null : p.body_html,
    edits.kind ?? p.kind,
    edits.changeRequestIds !== undefined ? JSON.stringify(Array.from(new Set(edits.changeRequestIds))) : p.change_request_ids,
    ts,
    p.id,
  );
}

const EDITABLE: ProposalStatus[] = ["pending", "approval_needed"];

export function editProposal(id: string, edits: ProposalEdits, actor: "daniel" | "claude", now: Date = new Date()): { ok: true; proposal: ProposalRow } | { ok: false; status: number; error: string } {
  const p = getProposal(id);
  if (!p) return { ok: false, status: 404, error: "proposal not found" };
  if (!EDITABLE.includes(p.status)) return { ok: false, status: 409, error: `proposal is ${p.status}` };
  const ts = nowIso(now);
  applyEdits(p, edits, ts);
  // An edited proposal always waits for an explicit Send.
  getDb().prepare(`UPDATE cs_reply_proposals SET status = 'approval_needed', block_reason = COALESCE(block_reason, 'endret'), updated_at = ? WHERE id = ?`).run(ts, id);
  crmService.logAction({ threadId: p.thread_id, type: "proposal_edited", actor, payload: { proposalId: id, fields: Object.keys(edits) } });
  return { ok: true, proposal: getProposal(id)! };
}

/** Daniel pressed Send (optionally with edits): approve and send now. */
export async function approveProposal(
  id: string,
  opts: { edits?: ProposalEdits; note?: string | null; actor?: "daniel"; source?: "admin-crm" | "api" } = {},
  deps: { now?: Date; env?: NodeJS.ProcessEnv; sendRaw?: SendRawFn; liveTransport?: boolean } = {},
): Promise<{ ok: true; result: ProcessResult; proposal: ProposalRow } | { ok: false; status: number; error: string }> {
  const now = deps.now ?? new Date();
  const p = getProposal(id);
  if (!p) return { ok: false, status: 404, error: "proposal not found" };
  // A failed send may be retried by hand only when the outcome is known (transport said no).
  const approvable = EDITABLE.includes(p.status) || (p.status === "failed" && p.block_reason !== "ukjent_utfall");
  if (!approvable) return { ok: false, status: 409, error: `proposal is ${p.status}${p.block_reason ? ` (${p.block_reason})` : ""}` };
  const ts = nowIso(now);
  if (opts.edits && Object.keys(opts.edits).length > 0) applyEdits(p, opts.edits, ts);
  getDb()
    .prepare(
      `UPDATE cs_reply_proposals
          SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ?, attempts = 0, next_attempt_at = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .run(opts.actor ?? "daniel", ts, opts.note ?? null, ts, id);
  crmService.logAction({ threadId: p.thread_id, type: "proposal_approved", actor: opts.actor ?? "daniel", payload: { proposalId: id, source: opts.source ?? "api" } });
  const result = await processProposal(id, deps);
  return { ok: true, result, proposal: getProposal(id)! };
}

export function rejectProposal(id: string, reason: string, actor: "daniel" | "claude", now: Date = new Date()): { ok: true } | { ok: false; status: number; error: string } {
  const p = getProposal(id);
  if (!p) return { ok: false, status: 404, error: "proposal not found" };
  if (!EDITABLE.includes(p.status) && p.status !== "failed") return { ok: false, status: 409, error: `proposal is ${p.status}` };
  const ts = nowIso(now);
  getDb()
    .prepare(`UPDATE cs_reply_proposals SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?`)
    .run(actor, ts, reason, ts, id);
  crmService.logAction({ threadId: p.thread_id, type: "proposal_rejected", actor, payload: { proposalId: id, reason } });
  return { ok: true };
}

export interface ProposalListItem extends ProposalRow {
  thread_subject: string | null;
  contact_name: string | null;
  contact_id: string | null;
  contact_type: string | null;
  age_hours: number;
}

export function listProposals(opts: { status?: ProposalStatus | "open"; threadId?: string; limit?: number } = {}): ProposalListItem[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status === "open") where.push("p.status IN ('pending', 'approval_needed', 'approved', 'sending', 'failed')");
  else if (opts.status) {
    where.push("p.status = ?");
    params.push(opts.status);
  }
  if (opts.threadId) {
    where.push("p.thread_id = ?");
    params.push(opts.threadId);
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = db
    .prepare(
      `SELECT p.*, t.subject AS thread_subject, c.name AS contact_name, c.id AS contact_id, c.type AS contact_type,
              (julianday('now') - julianday(p.created_at)) * 24.0 AS age_hours
         FROM cs_reply_proposals p
         LEFT JOIN crm_threads t ON t.id = p.thread_id
         LEFT JOIN crm_contacts c ON c.id = t.contact_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY p.created_at ASC
        LIMIT ${limit}`,
    )
    .all(...params) as ProposalListItem[];
  return rows.map((r) => ({ ...r, age_hours: Math.max(0, Math.round(Number(r.age_hours) * 10) / 10) }));
}

// ─── Worker ───────────────────────────────────────────────────────────

export interface AutosendRunResult {
  run_id: string | null;
  recovered_leases: string[];
  processed: ProcessResult[];
  envelope_recorded: boolean;
}

export async function runCsAutosend(
  deps: { now?: Date; env?: NodeJS.ProcessEnv; sendRaw?: SendRawFn; liveTransport?: boolean; limit?: number; trigger?: "cron" | "manual" } = {},
): Promise<AutosendRunResult> {
  const now = deps.now ?? new Date();
  const db = getDb();
  const recovered = recoverExpiredLeases(now);
  const due = db
    .prepare(
      `SELECT id FROM cs_reply_proposals
        WHERE status IN ('pending', 'approved')
          AND (next_attempt_at IS NULL OR julianday(next_attempt_at) <= julianday(?))
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(nowIso(now), Math.min(Math.max(deps.limit ?? 20, 1), 100)) as Array<{ id: string }>;
  const processed: ProcessResult[] = [];
  for (const d of due) {
    try {
      processed.push(await processProposal(d.id, deps));
    } catch (e: any) {
      processed.push({ id: d.id, outcome: "failed", reason: "exception", detail: String(e?.message ?? e) });
    }
  }
  const acted = processed.filter((r) => r.outcome !== "skipped");
  if (acted.length === 0 && recovered.length === 0) return { run_id: null, recovered_leases: [], processed, envelope_recorded: false };

  // One run-ledger row per minute that actually did something.
  const runId = `run-${now.toISOString().slice(0, 19).replace(/[:]/g, "")}-cs-autosend`;
  const env = new EnvelopeBuilder({ run_id: runId, vertical: "rfb", agent: "cs-autosend", trigger_source: deps.trigger ?? "cron" });
  const count = (o: ProcessResult["outcome"]) => acted.filter((r) => r.outcome === o).length;
  env.claim({
    type: "custom",
    value: count("sent"),
    meta: {
      kind: "cs_autosend",
      sent: count("sent"),
      approval_needed: count("approval_needed"),
      superseded: count("superseded"),
      retry: count("retry"),
      failed: count("failed"),
      recovered_leases: recovered.length,
      items: acted.map((r) => ({ id: r.id, outcome: r.outcome, reason: r.reason ?? null })),
    },
  });
  for (const r of acted.filter((x) => x.outcome === "failed")) env.error(`proposal ${r.id} failed: ${r.reason}${r.detail ? ` — ${r.detail}` : ""}`);
  for (const id of recovered) env.error(`proposal ${id}: lease expired mid-send — outcome unknown, not re-sent`);
  env.notes(
    `sent=${count("sent")} approval_needed=${count("approval_needed")} superseded=${count("superseded")} retry=${count("retry")} failed=${count("failed")} recovered=${recovered.length}`,
  );
  const status = count("failed") > 0 || recovered.length > 0 ? "partial" : "completed";
  let recorded = false;
  try {
    recordRun(env.finish(status));
    recorded = true;
  } catch (e) {
    console.error("[cs-autosend] recordRun failed:", e);
  }
  return { run_id: runId, recovered_leases: recovered, processed, envelope_recorded: recorded };
}

/** With autosend off, nothing may sit in `pending`: move it to the approval queue. */
export function parkPendingWhenAutosendOff(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): number {
  if (csAutosendEnabled(env)) return 0;
  const r = getDb()
    .prepare(
      `UPDATE cs_reply_proposals
          SET status = 'approval_needed', block_reason = 'autosending_av', block_detail = ?, updated_at = ?
        WHERE status = 'pending'`,
    )
    .run(`${CS_AUTOSEND_FLAG} er av — forslaget venter på Daniel`, nowIso(now));
  return r.changes;
}
