/**
 * contact-form-only.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-D1
 * («Kontaktskjema som valg per profil», Daniel's choice), rettfrabonden.com.
 *
 * A producer who does not want their e-mail address shown can ask us; an
 * admin then sets agents.contact_form_only = 1 (POST
 * /admin/agents/:id/contact-form-only, record only, no mail). With the switch
 * CONTACT_FORM_RFB on, that profile's page /produsent/:slug shows a contact
 * form instead of the e-mail (and instead of «Vis e-post»), JSON-LD has no
 * `email`, and POST /produsent/:slug/kontakt (routes/seo.ts — named like the
 * «Vis e-post» endpoint GET /produsent/:slug/epost) forwards the visitor's
 * message to the stored address through the existing mail path
 * (emailService.sendEmail), with Reply-To = the visitor's address. The
 * producer's address is never in an HTTP answer or a log line.
 *
 * Switch: CONTACT_FORM_RFB, default OFF; on for "on", "1" or "true" (trimmed,
 * any case — the same convention as EMAIL_REVEAL_GUARD_RFB). Read per call.
 * Off → the flag is not even read: every page is byte-identical to main and
 * the POST path falls through to the app's ordinary 404.
 *
 * Abuse limits on the POST: a hidden honeypot field (filled → answered like a
 * success, nothing sent, nothing counted) and at most
 * CONTACT_FORM_PER_IP_PER_HOUR (5) forwarded messages per client IP per
 * sliding hour, keyed like the e-mail reveal guard (req.ip, salted hash via
 * createStatsKey, IPv6 per /56; in memory, per process — with N machines a
 * client can send up to 5 × N). Over the limit → 429 with Retry-After.
 *
 * Logs: one JSON line per outcome with the host, the profile id and a short
 * hashed client id — never an e-mail address, never an IP, never the text.
 *
 * S-D2 (RFB REST + A2A, not MCP): with the switch on, a flagged profile's
 * e-mail is also left out of the public API answers, exactly as for a
 * producer without one (no new field): the contact blocks of /search and
 * /discover, /agents/:id/card, /info and /vcard, contact_handoffs of cart
 * submit, the offers of /catalog/offers and the /handleliste pre-selection,
 * the per-producer A2A card (x-knowledge) and A2A agent/info, and the seller auto-reply's ✉️
 * line in the public conversation answers (conversation-email-guard.ts).
 * contactFormOnlyIds / rfbEmailHiddenIds below; a flagged profile spends no
 * e-mail reveal budget. The buyer's own order (orders[].producer_contact,
 * order status, receipts) keeps the seller's e-mail. Switch off → the flag is
 * not read and every answer is as before.
 *
 * Not yet (later slices): the RFB MCP answers (contract freeze), and the
 * dental + experiences hosts (S-D3). Operational step before the first flag
 * is set: check that the privacy policy text covers forwarding of
 * contact-form messages.
 */

import crypto from "crypto";
import type Database from "better-sqlite3";
import type { Request, Response } from "express";
import { createStatsKey } from "../middleware/client-ip";
import { emailService, type EmailOptions } from "./email-service";
import { emailWithheldIds } from "./email-reveal-guard";
import { getDb } from "../database/init";

export type ContactFormHost = "rfb" | "dental";

/**
 * S-D3a adds finn-tannlege.com ("dental", CONTACT_FORM_DENTAL; the flag is
 * dental_agents.contact_form_only, services/dental-contact-form-only.ts).
 * Each host has its own switch and its own per-IP limit store.
 */
export const CONTACT_FORM_SWITCH_ENV: Readonly<Record<ContactFormHost, string>> = {
  rfb: "CONTACT_FORM_RFB",
  dental: "CONTACT_FORM_DENTAL",
};

/** Forwarded messages per client IP per sliding hour. */
export const CONTACT_FORM_PER_IP_PER_HOUR = 5;
export const CONTACT_FORM_WINDOW_MS = 60 * 60_000;
/** Clients kept before the least recently seen is evicted. */
export const CONTACT_FORM_MAX_CLIENTS = 20_000;

export const CONTACT_FORM_NAME_MAX = 100;
export const CONTACT_FORM_EMAIL_MAX = 254;
export const CONTACT_FORM_MESSAGE_MAX = 2000;
export const CONTACT_FORM_MESSAGE_MIN = 2;
/** The honeypot field's name (the same name as the /kontakt form's). */
export const CONTACT_FORM_HONEYPOT_FIELD = "_honey";

type Env = Record<string, string | undefined>;

/** Whether the contact-form option is on for `host` (default off). */
export function contactFormEnabled(host: ContactFormHost = "rfb", env: Env = process.env): boolean {
  const raw = (env[CONTACT_FORM_SWITCH_ENV[host]] ?? "").trim().toLowerCase();
  return raw === "on" || raw === "1" || raw === "true";
}

/** Whether an RFB agent has the contact-form-only flag. Missing row / column → false. */
export function isContactFormOnly(db: Database.Database, agentId: string): boolean {
  try {
    const row = db.prepare("SELECT contact_form_only FROM agents WHERE id = ?").get(agentId) as { contact_form_only?: number } | undefined;
    return Number(row?.contact_form_only ?? 0) === 1;
  } catch {
    return false;
  }
}

/** Ids per IN (…) query, well below SQLite's bound-parameter limit. */
const FLAG_QUERY_CHUNK = 500;

/**
 * S-D2: the ids among `agentIds` that have the contact-form-only flag. null
 * when the switch for `host` is off: the flag is not read and the caller
 * changes nothing. Duplicates / empty ids are ignored; a failed read (no
 * column) counts as unflagged, like isContactFormOnly.
 */
export function contactFormOnlyIds(db: Database.Database, agentIds: readonly string[], host: ContactFormHost = "rfb", env: Env = process.env): ReadonlySet<string> | null {
  if (!contactFormEnabled(host, env)) return null;
  const ids = Array.from(new Set(agentIds.filter((id) => typeof id === "string" && id !== "")));
  const flagged = new Set<string>();
  for (let i = 0; i < ids.length; i += FLAG_QUERY_CHUNK) {
    const chunk = ids.slice(i, i + FLAG_QUERY_CHUNK);
    try {
      const rows = db.prepare(`SELECT id FROM agents WHERE contact_form_only = 1 AND id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<{ id: string }>;
      for (const r of rows) flagged.add(r.id);
    } catch { /* no column: nothing flagged */ }
  }
  return flagged;
}

/**
 * S-D2, for an RFB API answer: the ids among `idsWithEmail` (each a profile
 * that HAS an e-mail in this answer) whose e-mail this answer leaves out —
 * the flagged profiles (switch CONTACT_FORM_RFB on) plus what the per-IP
 * e-mail guard withholds (emailWithheldIds, EMAIL_REVEAL_GUARD_RFB). A
 * flagged profile is not passed to the guard, so it spends no budget. Both
 * switches off → null, as emailWithheldIds; the contact-form switch off →
 * exactly emailWithheldIds (headers included).
 */
export function rfbEmailHiddenIds(req: Request, res: Response, idsWithEmail: readonly string[], db?: Database.Database): ReadonlySet<string> | null {
  const flagged = contactFormEnabled("rfb") && idsWithEmail.length > 0
    ? contactFormOnlyIds(db ?? getDb(), idsWithEmail)
    : null;
  if (!flagged || flagged.size === 0) return emailWithheldIds(req, res, "rfb", idsWithEmail);
  const withheld = emailWithheldIds(req, res, "rfb", idsWithEmail.filter((id) => !flagged.has(id)));
  return new Set([...(withheld ?? []), ...flagged]);
}

/**
 * S-D2, for offer-shaped items (catalog-offers.ts Offer / CategoryMatch:
 * `producer.email`): `items` with producer.email null for a flagged producer,
 * as for a producer without one. Switch off, or no flagged producer with an
 * e-mail among them → `items` itself (the flag is not read with the switch
 * off). Applied at the REST / page layer only; findOffers is shared with MCP.
 */
export function withContactFormOnlyProducerEmailNull<T extends { producer?: { agent_id: string; email: string | null } | null }>(items: T[], db?: Database.Database): T[] {
  if (!contactFormEnabled("rfb") || !Array.isArray(items)) return items;
  const ids = items.filter((o) => !!o?.producer?.email).map((o) => o.producer!.agent_id);
  if (ids.length === 0) return items;
  const flagged = contactFormOnlyIds(db ?? getDb(), ids);
  if (!flagged || flagged.size === 0) return items;
  return items.map((o) => (o?.producer?.email && flagged.has(o.producer.agent_id) ? { ...o, producer: { ...o.producer, email: null } } : o));
}

/**
 * Sets the flag (admin). Returns the stored value, or null for an unknown id.
 * The only DB write of S-D; never touches the e-mail address.
 */
export function setContactFormOnly(db: Database.Database, agentId: string, enabled: boolean): { id: string; contact_form_only: boolean } | null {
  const row = db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId) as { id: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE agents SET contact_form_only = ? WHERE id = ?").run(enabled ? 1 : 0, agentId);
  return { id: row.id, contact_form_only: isContactFormOnly(db, agentId) };
}

// ─── Input ───────────────────────────────────────────────────────────────

// C0 + DEL + C1 controls and the Unicode line/paragraph separators.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// Bidi embedding/override/isolate marks.
const BIDI_CHARS_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Controls a multi-line message may not carry (tab, LF, CR are allowed).
const MESSAGE_BAD_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]{2,}$/;

/** One line of plain text: controls → space, bidi marks gone, whitespace collapsed. */
export function contactFormOneLine(s: string): string {
  return oneLine(s);
}

function oneLine(s: string): string {
  return s.replace(CONTROL_CHARS_RE, " ").replace(BIDI_CHARS_RE, "").replace(/\s+/g, " ").trim();
}

export interface ContactFormInput {
  name: string;
  replyEmail: string;
  message: string;
}

export type ContactFormField = "name" | "reply_email" | "message";

/** Whether the honeypot field carries anything (a bot filled it). */
export function contactFormHoneypotFilled(body: unknown): boolean {
  const v = (body as Record<string, unknown> | null | undefined)?.[CONTACT_FORM_HONEYPOT_FIELD];
  return typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null && v !== "";
}

/** Validates the posted fields (name, reply_email, message). */
export function validateContactFormInput(body: unknown): { ok: true; value: ContactFormInput } | { ok: false; errors: ContactFormField[] } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const name = oneLine(str(b.name));
  const replyEmail = str(b.reply_email).trim();
  const message = str(b.message).replace(/\r\n?/g, "\n").replace(MESSAGE_BAD_CHARS_RE, "").replace(BIDI_CHARS_RE, "").trim();
  const errors: ContactFormField[] = [];
  if (name.length < 1 || Array.from(name).length > CONTACT_FORM_NAME_MAX) errors.push("name");
  if (replyEmail.length > CONTACT_FORM_EMAIL_MAX || !EMAIL_RE.test(replyEmail)) errors.push("reply_email");
  const msgLen = Array.from(message).length;
  if (msgLen < CONTACT_FORM_MESSAGE_MIN || msgLen > CONTACT_FORM_MESSAGE_MAX) errors.push("message");
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { name, replyEmail, message } };
}

// ─── The forwarded mail ─────────────────────────────────────────────────

const SUBJECT_MAX = 150;

/** The forwarded mail (text only). The producer's address is only `to`. */
export function buildContactFormMail(opts: { producerName: string; profileUrl: string; input: ContactFormInput; to: string }): EmailOptions {
  const subjectRaw = `Melding via Rett fra Bonden: ${opts.input.name}`;
  const chars = Array.from(subjectRaw);
  const subject = chars.length <= SUBJECT_MAX ? subjectRaw : chars.slice(0, SUBJECT_MAX - 1).join("").trimEnd() + "…";
  const textContent = [
    `Hei ${oneLine(opts.producerName)}!`,
    "",
    `Du har fått en melding gjennom kontaktskjemaet på profilen din på Rett fra Bonden (${opts.profileUrl}).`,
    "",
    `Fra: ${opts.input.name}`,
    `Svar-adresse: ${opts.input.replyEmail}`,
    "",
    opts.input.message,
    "",
    "—",
    "Denne meldingen ble videresendt av Rett fra Bonden-plattformen. Avsenderen har ikke sett e-postadressen din.",
    "Svarer du på denne e-posten, går svaret direkte til avsenderen, som da ser adressen du svarer fra.",
    "Vi har ikke kontrollert innholdet i meldingen. Ser den ut som svindel eller reklame, kan du se bort fra den.",
  ].join("\n");
  return {
    to: opts.to,
    subject,
    textContent,
    replyTo: opts.input.replyEmail,
    // Not outreach, and the mail carries a visitor's address and free text:
    // keep the recipient and the subject out of the send log.
    omitAgentHeader: true,
    redactRecipientInLogs: true,
    logSubjectAs: "[Kontaktskjema · produsent]",
  };
}

export type ContactFormSender = (opts: EmailOptions) => Promise<{ success: boolean; messageId?: string; error?: string }>;

let sender: ContactFormSender = (opts) => emailService.sendEmail(opts);

/** Sends one forwarded message through the platform's mail path. */
export function sendContactFormMail(opts: EmailOptions): ReturnType<ContactFormSender> {
  return sender(opts);
}

// ─── Per-IP limit ───────────────────────────────────────────────────────

export interface ContactFormRateStoreOptions {
  now?: () => number;
  windowMs?: number;
  limit?: number;
  maxClients?: number;
  salt?: Buffer;
}

export class ContactFormRateStore {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly maxClients: number;
  private readonly keyOf: (ip: string) => string;
  /** hashed client key → send times in the window (Map order = least recently seen first). */
  private readonly clients = new Map<string, number[]>();

  constructor(opts: ContactFormRateStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.windowMs = opts.windowMs ?? CONTACT_FORM_WINDOW_MS;
    this.limit = opts.limit ?? CONTACT_FORM_PER_IP_PER_HOUR;
    this.maxClients = Math.max(1, opts.maxClients ?? CONTACT_FORM_MAX_CLIENTS);
    this.keyOf = createStatsKey(opts.salt ?? crypto.randomBytes(16));
  }

  clientKey(ip: string): string {
    return this.keyOf(ip);
  }

  /** Seconds until this client may send again; 0 = it may send now. */
  retryAfterSeconds(key: string): number {
    const times = this.live(key);
    if (times.length < this.limit) return 0;
    return Math.max(1, Math.ceil((times[0]! + this.windowMs - this.now()) / 1000));
  }

  /** Counts one send for this client. */
  record(key: string): void {
    const times = this.live(key);
    this.clients.delete(key);
    while (this.clients.size >= this.maxClients) this.clients.delete(this.clients.keys().next().value as string);
    times.push(this.now());
    this.clients.set(key, times);
  }

  size(): number {
    return this.clients.size;
  }

  private live(key: string): number[] {
    const now = this.now();
    const times = (this.clients.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (times.length === 0) this.clients.delete(key);
    return times;
  }
}

// One limit store per host (S-D3a): a message to a clinic does not spend an
// RFB budget, nor the other way round.
let rateStores: Record<ContactFormHost, ContactFormRateStore> = { rfb: new ContactFormRateStore(), dental: new ContactFormRateStore() };
let logLine: (line: string) => void = (line) => console.log(line);

/** The short hashed client id used in log lines (never the IP). */
function logClientId(key: string): string {
  return Buffer.from(key, "base64url").toString("hex", 0, 6);
}

/**
 * The limit check for one request. "no_ip" (no usable req.ip) fails closed
 * like the e-mail reveal guard. `ok` carries the key to record after a send.
 */
export function contactFormRateCheck(req: Request, host: ContactFormHost = "rfb"): { ok: true; key: string; client: string } | { ok: false; reason: "limit" | "no_ip"; retryAfter: number; client?: string } {
  if (typeof req.ip !== "string" || req.ip.trim() === "") return { ok: false, reason: "no_ip", retryAfter: 3600 };
  const rateStore = rateStores[host];
  const key = rateStore.clientKey(req.ip);
  const client = logClientId(key);
  const wait = rateStore.retryAfterSeconds(key);
  if (wait > 0) return { ok: false, reason: "limit", retryAfter: wait, client };
  return { ok: true, key, client };
}

export function contactFormRecordSend(key: string, host: ContactFormHost = "rfb"): void {
  rateStores[host].record(key);
}

/** One JSON log line: profile id, outcome, hashed client — never an address, an IP or the text. */
export function logContactFormEvent(fields: { outcome: string; profile_id?: string; client?: string; host?: ContactFormHost; [k: string]: unknown }): void {
  logLine(JSON.stringify({ evt: "contact_form", host: fields.host ?? "rfb", ...fields }));
}

/** Test-only: a fresh limit store (optionally with a clock), log sink and sender. */
export function __resetContactFormForTesting(opts: ContactFormRateStoreOptions & { log?: (line: string) => void; sender?: ContactFormSender } = {}): void {
  rateStores = { rfb: new ContactFormRateStore(opts), dental: new ContactFormRateStore(opts) };
  logLine = opts.log ?? ((line) => console.log(line));
  sender = opts.sender ?? ((o) => emailService.sendEmail(o));
}
