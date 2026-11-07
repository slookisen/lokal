/**
 * conversation-email-guard.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-A5 for the
 * public RFB conversation answers.
 *
 * The seller's auto-reply (conversation-service generateSellerResponse) holds
 * a contact block with the line «✉️ <producer e-mail>». The public
 * conversation answers (REST /api/conversations*, the /api/live and AG-UI
 * streams, the /samtale/:id page) follow the rfb per-IP counter of
 * services/email-reveal-guard.ts — the counter the profile page and the
 * REST/A2A answers of S-A5 share (switch EMAIL_REVEAL_GUARD_RFB, default
 * off). The producer is the conversation's seller agent; each seller whose
 * message carries an e-mail counts once, in list order, and a seller already
 * counted is free. Over the limit, for CCBot or without an IP the ✉️ line is
 * left out (nothing else in the text changes; a «Kontakt oss:» header left
 * with no contact line under it goes too, with the blank line before it, so
 * the text reads as the auto-reply of a producer without an e-mail), and the
 * same e-mail is taken out of the message metadata. Stored rows are never
 * changed. Switch off: every function returns its input as given.
 *
 * Shared pages that are the same for every visitor (the /samtaler list and
 * the front page showcase, both cached as finished HTML) cannot follow a
 * per-IP counter: with the switch on their reply previews never show the ✉️
 * line and spend no budget (withoutSellerEmailAlways).
 *
 * Nothing here logs; the guard logs ids and counts only.
 */

import type { Request, Response } from "express";
import { emailRevealGuardEnabled, emailWithheldIds, revealEmailFor } from "./email-reveal-guard";
import { knowledgeService } from "./knowledge-service";
import { getDb } from "../database/init";

/** A «✉️ …» line of the seller's contact block (with or without the emoji variation selector). */
const EMAIL_LINE_RE = /^\s*✉/u;
const CONTACT_HEADER = "Kontakt oss:";
/** The other contact lines generateSellerResponse writes under the header: 📍 📞 🌐. */
const CONTACT_LINE_RE = /^\s*(\u{1F4CD}|\u{1F4DE}|\u{1F310})/u;

type MsgLike = { senderRole?: string; senderAgentId?: string | null; content?: unknown; metadata?: unknown };
type ConvLike = { sellerAgentId?: string | null; messages?: MsgLike[] };

/** Whether a text has a «✉️ …» line. */
export function hasEmailLine(content: unknown): boolean {
  return typeof content === "string" && content.split("\n").some((l) => EMAIL_LINE_RE.test(l));
}

/** The e-mail addresses written on the «✉️ …» lines of a text. */
function emailsOnLines(content: string): string[] {
  return content.split("\n").filter((l) => EMAIL_LINE_RE.test(l))
    .map((l) => l.replace(/^\s*✉️?\s*/u, "").trim()).filter((e) => e.length > 0);
}

/**
 * The text without its «✉️ …» lines. A «Kontakt oss:» header then left with
 * no 📍/📞/🌐 line under it is dropped too, with the blank line before it (the
 * auto-reply of a producer with no contact line has no header at all). A text
 * without a ✉️ line is returned as given.
 */
export function withoutEmailLines(content: string): string {
  const lines = content.split("\n");
  if (!lines.some((l) => EMAIL_LINE_RE.test(l))) return content;
  const kept = lines.filter((l) => !EMAIL_LINE_RE.test(l));
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i]!;
    if (line.trim() === CONTACT_HEADER && !CONTACT_LINE_RE.test(kept[i + 1] ?? "")) {
      if (out.length > 0 && out[out.length - 1] === "") out.pop();
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `value` with every (case-insensitive) occurrence of `emails` taken out of its strings; the same object when none occurs. */
function scrubEmails(value: unknown, emails: string[]): unknown {
  if (emails.length === 0) return value;
  const json = JSON.stringify(value);
  if (typeof json !== "string") return value;
  const lower = json.toLowerCase();
  if (!emails.some((e) => lower.includes(e.toLowerCase()))) return value;
  const re = new RegExp(emails.map(escapeRe).join("|"), "gi");
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(re, "");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return walk(value);
}

/** The producer's stored e-mail (cached per call), or null. */
function storedEmailOf(sellerId: string | null | undefined, cache: Map<string, string | null>): string | null {
  if (!sellerId) return null;
  if (!cache.has(sellerId)) {
    let email: string | null = null;
    try {
      const e = knowledgeService.getAgentInfo(sellerId)?.knowledge?.email;
      email = typeof e === "string" && e.trim() !== "" ? e.trim() : null;
    } catch { /* no knowledge row: nothing to look for */ }
    cache.set(sellerId, email);
  }
  return cache.get(sellerId) ?? null;
}

/** The seller's e-mails in a seller-role message (its ✉️ lines; the stored e-mail when it is in the metadata); [] for any other message. */
function sellerEmailsIn(msg: MsgLike, sellerId: string | null | undefined, cache: Map<string, string | null>): string[] {
  if (!msg || msg.senderRole !== "seller") return [];
  const content = typeof msg.content === "string" ? msg.content : "";
  const emails = emailsOnLines(content);
  const stored = storedEmailOf(sellerId, cache);
  if (stored && !emails.some((e) => e.toLowerCase() === stored.toLowerCase())) emails.push(stored);
  if (hasEmailLine(content)) return emails;
  // No ✉️ line: only an e-mail that is in the metadata counts.
  return scrubEmails(msg.metadata, emails) !== msg.metadata ? emails : [];
}

/** A seller-role message without the seller's e-mail (✉️ line out of the text, the address out of the metadata). */
function messageWithoutEmail<M extends MsgLike>(msg: M, emails: string[]): M {
  const out: M = { ...msg };
  if (typeof msg.content === "string") (out as MsgLike).content = withoutEmailLines(msg.content);
  if (msg.metadata !== undefined) (out as MsgLike).metadata = scrubEmails(msg.metadata, emails);
  return out;
}

/** The producer a conversation's seller messages belong to: its seller agent (else a seller message's sender). */
function producerOf(conv: ConvLike): string | null {
  if (conv.sellerAgentId) return conv.sellerAgentId;
  const m = (conv.messages ?? []).find((x) => x && x.senderRole === "seller" && x.senderAgentId);
  return m?.senderAgentId ?? null;
}

/** The conversation's seller messages without the seller's e-mail. */
function conversationWithoutEmail<C extends ConvLike>(conv: C, cache: Map<string, string | null>): C {
  if (!Array.isArray(conv.messages)) return conv;
  const seller = producerOf(conv);
  let changed = false;
  const messages = conv.messages.map((m) => {
    const emails = sellerEmailsIn(m, seller, cache);
    if (emails.length === 0) return m;
    changed = true;
    return messageWithoutEmail(m, emails);
  });
  return changed ? { ...conv, messages } : conv;
}

function carriesEmail(conv: ConvLike, cache: Map<string, string | null>): boolean {
  if (!conv || !Array.isArray(conv.messages)) return false;
  const seller = producerOf(conv);
  return conv.messages.some((m) => sellerEmailsIn(m, seller, cache).length > 0);
}

/**
 * For a public conversation answer: the conversations with the seller's
 * e-mail left out where this request may not get it (rfb counter, sellers
 * counted in list order). Switch on: Cache-Control: private (also with no
 * e-mail in the answer). Switch off: `convs` as given, headers untouched.
 */
export function guardConversationEmails<C extends ConvLike>(req: Request, res: Response, convs: C[]): C[] {
  if (!emailRevealGuardEnabled("rfb")) return convs;
  const cache = new Map<string, string | null>();
  const carrying = convs.map((c) => carriesEmail(c, cache));
  const ids: string[] = [];
  convs.forEach((c, i) => { const p = producerOf(c); if (carrying[i] && p) ids.push(p); });
  const withheld = emailWithheldIds(req, res, "rfb", ids);
  if (withheld === null) return convs;
  return convs.map((c, i) => {
    if (!carrying[i]) return c;
    const p = producerOf(c);
    // A seller message with no producer id cannot be counted: left out.
    return !p || withheld.has(p) ? conversationWithoutEmail(c, cache) : c;
  });
}

/** The seller agent of a stored conversation (the /api/live and AG-UI streams get bare messages). */
function storedSellerOf(conversationId: unknown): string | null {
  if (typeof conversationId !== "string") return null;
  try {
    const row = getDb().prepare("SELECT seller_agent_id FROM conversations WHERE id = ?").get(conversationId) as { seller_agent_id?: string | null } | undefined;
    return row?.seller_agent_id ?? null;
  } catch { return null; }
}

/**
 * A message broadcast on a live stream, as one listener may get it: with the
 * switch on, a seller message carrying an e-mail follows that listener's rfb
 * counter (`req` = the listener's own stream request). Switch off, or a
 * message without the seller's e-mail: `msg` as given.
 */
export function messageForListener<M extends MsgLike & { conversationId?: string }>(req: Request, msg: M, cache: Map<string, string | null> = new Map()): M {
  if (!emailRevealGuardEnabled("rfb") || !msg || msg.senderRole !== "seller") return msg;
  const seller = storedSellerOf(msg.conversationId) ?? msg.senderAgentId ?? null;
  const emails = sellerEmailsIn(msg, seller, cache);
  if (emails.length === 0) return msg;
  if (seller) {
    const allowed = revealEmailFor(req, "rfb", [seller]);
    if (allowed === null || allowed.has(seller)) return msg;
  }
  return messageWithoutEmail(msg, emails);
}

/**
 * With the switch on: the conversations with every seller e-mail left out,
 * no budget spent — for HTML that is the same for every visitor (/samtaler,
 * the front page showcase). Switch off: `convs` as given.
 */
export function withoutSellerEmailAlways<C extends ConvLike>(convs: C[]): C[] {
  if (!emailRevealGuardEnabled("rfb")) return convs;
  const cache = new Map<string, string | null>();
  return convs.map((c) => conversationWithoutEmail(c, cache));
}

/** Cache-Control for a live stream: "no-cache" as before; switch on: also private. */
export function liveStreamCacheControl(): string {
  return emailRevealGuardEnabled("rfb") ? "no-cache, private" : "no-cache";
}
