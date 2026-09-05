// ─── Inbound CRM triage: which platform did this mail arrive on? ────
//
// dev-requests/2026-07-27-crm-plattformadskillelse-opplevagent.md, steg 4:
//
//   «CS-agentens triage utleder plattform fra videresenderens From-adresse
//    (kontakt@rettfrabonden.com → rfb, kontakt@opplevagent.no → experiences) …
//    Ukjent/tvetydig signal → egen «utriaged»-bøtte for Daniel, ALDRI en gjetning.»
//
// ── WHY THIS LIVES IN CODE AND NOT IN THE AGENT'S PROMPT ────────────
//
// The obvious reading of that line is "tell the CS agent to look at the From
// address". That reading is the bug. An LLM asked to classify will always
// produce a class — "nearest plausible" is what the machine is for — so a
// prompt-level rule turns "I cannot tell" into "probably rfb", silently, with
// no row anywhere recording that a decision was invented. That is funn 2 with
// a different actor.
//
// So the derivation is a total function over the recipient addresses, here,
// with an explicit third outcome. The agent's job is reduced to reporting what
// the headers literally said. It cannot guess, because it is never asked to.
//
// ── WHAT WE DECIDE ON ───────────────────────────────────────────────
//
// Only explicit RECIPIENT addresses: Delivered-To, To, Cc, X-Forwarded-To,
// Envelope-To. Those are strings that either contain a platform alias or do
// not — a rule small enough to be exhaustively testable.
//
// The Received chain (SES for rfb, ImprovMX for opplevagent — see steg 0) is a
// genuinely stronger infrastructure-level signal, and it IS captured in the
// evidence blob so a human can re-decide. But it is deliberately NOT part of
// the decision: Received-chain parsing is heuristic, and a heuristic that
// usually works is exactly the shape of thing that quietly starts mis-routing
// when a provider changes its banner. Evidence, not authority.
//
// ── DENTAL ──────────────────────────────────────────────────────────
//
// finn-tannlege.com has no inbound alias (steg 3 documents why), so there is no
// dental mail on this path at all — dental enquiries arrive through
// POST /api/contact, which carries an explicit platform field. If a dental
// alias is ever configured, add it to PLATFORM_ADDRESSES and nothing else
// changes.

import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { CrmVertical } from "./crm-service";

/**
 * What the CS agent read off the message. Every field optional and every field
 * accepting either a single string or a list, because Gmail hands these back in
 * both shapes depending on the header — being strict here would push the agent
 * into normalising, and a normalisation step in a prompt is another place to
 * lose a signal.
 */
export interface RoutingSignals {
  deliveredTo?: string | string[] | null;
  to?: string | string[] | null;
  cc?: string | string[] | null;
  xForwardedTo?: string | string[] | null;
  envelopeTo?: string | string[] | null;
  /** Raw Received chain. Stored as evidence, never decided on — see above. */
  received?: string | string[] | null;
}

/** Recipient headers the decision reads, in the order they are reported. */
const DECIDING_FIELDS = ["deliveredTo", "to", "cc", "xForwardedTo", "envelopeTo"] as const;
type DecidingField = (typeof DECIDING_FIELDS)[number];

/**
 * The platform aliases. Lowercase keys; lookups lowercase the input.
 *
 * NOT derived from crm-platform-identity's replyTo map, deliberately: dental's
 * replyTo is kontakt@rettfrabonden.com (it has no inbound alias), so deriving
 * this from that table would make kontakt@rettfrabonden.com map to two
 * verticals and every RFB mail permanently "ambiguous". Outbound identity and
 * inbound discriminator are different questions that happen to share strings.
 */
const PLATFORM_ADDRESSES: Readonly<Record<string, CrmVertical>> = {
  "kontakt@rettfrabonden.com": "rfb",
  "kontakt@opplevagent.no": "experiences",
};

// dev-requests/2026-08-21-crm-untriaged-kofrysning-og-lopetellerfeil.md: a
// known, permanent noise source (GitHub CI notification mail — 22 of 47 open
// rows in one untriaged-queue snapshot) that can never resolve to a platform
// alias and must not sit in Daniel's manual queue forever. Kept to exactly
// this one address on purpose — no speculative entries.
const AUTO_DISMISS_SENDERS: ReadonlySet<string> = new Set(["notifications@github.com"]);

/** Is this sender a known, permanent noise source that should never occupy the open untriaged queue? */
export function isAutoDismissedSender(fromEmail: string): boolean {
  return AUTO_DISMISS_SENDERS.has(fromEmail.trim().toLowerCase());
}

export type TriageCode =
  | "no_signals"
  | "no_platform_address"
  | "ambiguous_platform_addresses";

export type TriageOutcome =
  | {
      routed: true;
      vertical: CrmVertical;
      /** The alias that decided it, and which header carried it. */
      matchedAddress: string;
      matchedIn: DecidingField;
    }
  | {
      routed: false;
      code: TriageCode;
      /** Human-readable, ends up verbatim in crm_untriaged.reason. */
      reason: string;
      /** Every platform alias seen, so an ambiguous case names both. */
      matches: Array<{ address: string; vertical: CrmVertical; field: DecidingField }>;
    };

function toList(v: string | string[] | null | undefined): string[] {
  if (v === null || v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === "string" && s.trim() !== "");
}

/**
 * Pull bare addresses out of a header value. Handles `A <a@b.no>, C <c@d.no>`
 * and bare `a@b.no` alike.
 *
 * Note it scans for address-shaped substrings rather than splitting on commas:
 * a display name may legitimately contain a comma (`"Nordmann, Ola" <…>`), and
 * a split-based parser silently drops the second recipient in that case.
 */
export function extractAddresses(headerValue: string): string[] {
  const found = headerValue.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  return found ? found.map((a) => a.toLowerCase()) : [];
}

/**
 * Derive the platform, or refuse.
 *
 * Refusing is the whole point. There is no third parameter, no default, and no
 * "best guess" branch — the only way to get a vertical out of this function is
 * for exactly one platform alias to appear in the recipient headers.
 */
export function deriveVertical(signals: RoutingSignals | null | undefined): TriageOutcome {
  const matches: Array<{ address: string; vertical: CrmVertical; field: DecidingField }> = [];
  let sawAnySignal = false;

  for (const field of DECIDING_FIELDS) {
    for (const raw of toList(signals?.[field])) {
      sawAnySignal = true;
      for (const addr of extractAddresses(raw)) {
        const vertical = PLATFORM_ADDRESSES[addr];
        if (vertical) matches.push({ address: addr, vertical, field });
      }
    }
  }

  if (!sawAnySignal) {
    return {
      routed: false,
      code: "no_signals",
      reason:
        "no recipient headers were supplied (Delivered-To / To / Cc / X-Forwarded-To / Envelope-To all empty), " +
        "so there is nothing to derive a platform from",
      matches: [],
    };
  }

  const distinct = [...new Set(matches.map((m) => m.vertical))];

  if (distinct.length === 0) {
    return {
      routed: false,
      code: "no_platform_address",
      reason:
        "none of the recipient addresses is a known platform alias " +
        `(${Object.keys(PLATFORM_ADDRESSES).join(", ")}) — the mail reached the mailbox some other way`,
      matches: [],
    };
  }

  if (distinct.length > 1) {
    // Both aliases on one message: a sender who Cc'd both, or a forward of a
    // forward. Picking either one is a coin flip that writes a permanent row,
    // and the 409 on re-ingest (review B4, steg 1) makes a wrong pick expensive
    // to undo. A human decides.
    return {
      routed: false,
      code: "ambiguous_platform_addresses",
      reason:
        `the message names more than one platform alias (${matches
          .map((m) => `${m.address}→${m.vertical} in ${m.field}`)
          .join("; ")}) — refusing to pick one`,
      matches,
    };
  }

  const winner = matches[0];
  return {
    routed: true,
    vertical: winner.vertical,
    matchedAddress: winner.address,
    matchedIn: winner.field,
  };
}

/** Test/ops seam: the alias table as shipped, so a caller can assert on it. */
export function __platformAddressesForTesting(): Readonly<Record<string, CrmVertical>> {
  return PLATFORM_ADDRESSES;
}

// ─── The untriaged bucket ───────────────────────────────────────────
//
// Where a `routed: false` outcome goes. See the crm_untriaged comment in
// database/init.ts for why this is a table of its own and not an 'unknown'
// member of CrmVertical.

export interface ParkUntriagedInput {
  threadId: string;
  fromEmail: string;
  subject?: string | null;
  snippet?: string | null;
  /** The refusal, verbatim from deriveVertical. */
  reason: string;
  /** Everything the agent saw, decided-on or not, so a human can re-decide. */
  signals: unknown;
  /** The full ingest body, replayed verbatim on assignment. */
  rawPayload: unknown;
}

export interface UntriagedRow {
  id: string;
  thread_id: string;
  from_email: string;
  subject: string | null;
  snippet: string | null;
  reason: string;
  signals: string;
  raw_payload: string;
  created_at: string;
  resolved_at: string | null;
  resolved_vertical: string | null;
  resolved_by: string | null;
}

/**
 * Park a thread we could not route. Idempotent on thread_id: the CS agent
 * re-sends the same Gmail threadIds every run, so a permanently unroutable
 * thread must not grow one row per cron tick. Re-parking REFRESHES the reason
 * and evidence (the headers may have changed on a new reply) but keeps the
 * original id and created_at, so "how long has this been sitting here" stays
 * answerable.
 *
 * Re-parking an already-RESOLVED thread is a no-op that returns the resolved
 * row: once a human has decided, a later cron run must not reopen the decision
 * behind their back.
 */
export function parkUntriaged(input: ParkUntriagedInput): { id: string; reopened: false; alreadyResolved: boolean } {
  const db = getDb();
  const existing = db
    .prepare("SELECT id, resolved_at FROM crm_untriaged WHERE thread_id = ?")
    .get(input.threadId) as { id: string; resolved_at: string | null } | undefined;

  if (existing?.resolved_at) {
    return { id: existing.id, reopened: false, alreadyResolved: true };
  }

  const signals = JSON.stringify(input.signals ?? {});
  const rawPayload = JSON.stringify(input.rawPayload ?? {});

  if (existing) {
    db.prepare(
      `UPDATE crm_untriaged
          SET from_email = ?, subject = ?, snippet = ?, reason = ?, signals = ?, raw_payload = ?
        WHERE id = ?`,
    ).run(
      input.fromEmail,
      input.subject ?? null,
      input.snippet ?? null,
      input.reason,
      signals,
      rawPayload,
      existing.id,
    );
    return { id: existing.id, reopened: false, alreadyResolved: false };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO crm_untriaged (id, thread_id, from_email, subject, snippet, reason, signals, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.threadId, input.fromEmail, input.subject ?? null, input.snippet ?? null, input.reason, signals, rawPayload);
  return { id, reopened: false, alreadyResolved: false };
}

/** Open items oldest-first — this is a work queue, not a feed. */
export function listUntriaged(opts: { includeResolved?: boolean; limit?: number } = {}): UntriagedRow[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const sql = opts.includeResolved
    ? "SELECT * FROM crm_untriaged ORDER BY resolved_at IS NOT NULL, created_at LIMIT ?"
    : "SELECT * FROM crm_untriaged WHERE resolved_at IS NULL ORDER BY created_at LIMIT ?";
  return db.prepare(sql).all(limit) as UntriagedRow[];
}

export function countOpenUntriaged(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM crm_untriaged WHERE resolved_at IS NULL").get() as { n: number };
  return row.n;
}

/**
 * Close an item. `vertical` null means dismissed (spam, newsletter, nothing to
 * file) — `resolved_at IS NOT NULL AND resolved_vertical IS NULL` is the
 * dismissed shape, and `resolved_at IS NULL` is the only "open" shape.
 *
 * This only marks the row. Promotion into the CRM proper is the caller's job
 * and goes through the ordinary ingest path, so an assigned thread is written
 * by exactly the same code as a thread that routed cleanly the first time —
 * there is no second, less-tested write path into the CRM.
 */
export function markUntriagedResolved(
  id: string,
  vertical: CrmVertical | null,
  resolvedBy: string,
): boolean {
  const info = getDb()
    .prepare(
      `UPDATE crm_untriaged
          SET resolved_at = datetime('now'), resolved_vertical = ?, resolved_by = ?
        WHERE id = ? AND resolved_at IS NULL`,
    )
    .run(vertical, resolvedBy, id);
  return info.changes > 0;
}

export function getUntriaged(id: string): UntriagedRow | undefined {
  return getDb().prepare("SELECT * FROM crm_untriaged WHERE id = ?").get(id) as UntriagedRow | undefined;
}
