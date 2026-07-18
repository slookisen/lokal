// ─── agent_blocklist service ────────────────────────────────────
// "Do not re-add" list. Discovery and registration call isBlocked()
// before INSERT; if any identifier matches, the agent is silently
// rejected and a console.log is emitted so we have an audit trail.
//
// Why a service module instead of inline queries: the same logic
// runs from /admin/register, /register, ensureAgentInDb, AND the
// daily discovery agent's auto-register path. Keeping it in one
// place means a future "block by phone number" or "block by org-no"
// is a one-line addition.

import { getDb } from "../database/init";
import { FREE_MAIL_DOMAINS } from "./cross-source-validator";

export type BlocklistEntry = {
  id: number;
  // 'email_domain' is DEPRECATED 2026-05-10 (PR-14): blocking whole domains
  // produces too many false positives for free-mail addresses (gmail.com,
  // hotmail.com, etc.). New entries use 'email' (literal address). Existing
  // 'email_domain' rows are migrated out by init.ts on next boot. Read paths
  // ignore them.
  identifier_type: "website_domain" | "email" | "email_domain" | "name_normalized" | "agent_id";
  identifier_value: string;
  reason: string | null;
  source_email: string | null;
  original_agent_id: string | null;
  original_agent_name: string | null;
  created_at: string;
};

// ─── Normalisering ──────────────────────────────────────────────
// All matching is done against lower-cased, trimmed values.
// Domain extraction is permissive: it accepts a bare domain
// ("ovre-eide.no"), a URL with scheme ("https://www.ovre-eide.no/"),
// or an email ("post@ovre-eide.no"). Always strips a leading "www."
// so "www.x.no" and "x.no" never end up as separate rows.

export function normalizeDomain(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input).trim().toLowerCase();
  if (!s) return "";
  // If it contains @, treat as email
  if (s.includes("@")) {
    const [, dom] = s.split("@");
    s = (dom || "").trim();
  }
  // Strip protocol + path
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // Strip leading www.
  s = s.replace(/^www\./, "");
  // Strip trailing port
  s = s.replace(/:\d+$/, "");
  return s;
}

// ─── Sentinel: our own domain ──────────────────────────────────
// rettfrabonden.com is the schema default for AdminRegistration.url
// when discovery doesn't know the producer's real website. Treating
// this as a real producer signal is wrong — every blocklist match on
// our own domain is a false positive. Both the read path (isBlocked)
// and the write path (add) refuse to operate on it.
const OWN_DOMAINS = new Set(["rettfrabonden.com", "lokal.fly.dev"]);

// ─── PROTECTED_DOMAINS (manual-entry guard) ────────────────────
// Free-mail/ISP hosts (FREE_MAIL_DOMAINS, cross-source-validator.ts) are
// shared by thousands of unrelated producers, so blocklisting one of them
// as a website_domain would silently suppress every producer whose site
// happens to resolve to that host — a large, unintended blast radius for
// what a human meant as "block this one bad actor". vipps.no is added on
// top for the same over-suppression reason even though it isn't a
// free-mail host: it's a shared payment-app domain that legitimately shows
// up as the "website" for many small producers who link a Vipps page
// instead of a real site, so blocklisting it would hit all of them (see
// A2A rfb-customer-service-fjern-direct-delete-addendum, which calls this
// domain out explicitly for this exact guard).
export const PROTECTED_DOMAINS = new Set<string>([...FREE_MAIL_DOMAINS, "vipps.no"]);

// Thrown by addManualEntry() for input that is well-formed enough to reach
// this module but fails a domain-specific business rule (e.g. attempting to
// blocklist a protected shared domain, or an empty identifier value). The
// route layer catches this specifically to answer 400 instead of 500.
export class BlocklistValidationError extends Error {}

// ─── normalizeEmail (PR-14) ────────────────────────────────────
// Literal email match: lowercase + trim. We do NOT extract the domain —
// that was the old policy and it caused false-positives whenever a producer
// happened to share an email-domain with a previously-deleted agent (e.g.
// every gmail.com user got blocked once anyone with a gmail address was deleted).

export function normalizeEmail(input: string | null | undefined): string {
  if (!input) return "";
  return String(input).trim().toLowerCase();
}

export function normalizeName(input: string | null | undefined): string {
  if (!input) return "";
  // Match the slugify rules so a blocked "Øvre-Eide Gård" catches
  // a re-discovered "ovre-eide gard" or "Øvre Eide Gård - Eidsvåg, Bergen".
  return String(input)
    .toLowerCase()
    .normalize("NFC")
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// ─── isBlocked ─────────────────────────────────────────────────
// True if any of name/website/email matches a row in agent_blocklist.
// Cheap: SELECT 1 LIMIT 1 against an indexed (type, value) lookup.

export function isBlocked(opts: {
  agentId?: string;
  name?: string;
  website?: string;
  email?: string;
}): { blocked: boolean; matchedBy?: BlocklistEntry["identifier_type"]; matchedValue?: string } {
  try {
    const db = getDb();
    const checks: Array<[BlocklistEntry["identifier_type"], string]> = [];
    if (opts.agentId) checks.push(["agent_id", opts.agentId.toLowerCase()]);
    if (opts.website) {
      const dom = normalizeDomain(opts.website);
      if (dom && !OWN_DOMAINS.has(dom)) checks.push(["website_domain", dom]);
    }
    if (opts.email) {
      // PR-14: literal email address only (do NOT block whole domain)
      const norm = normalizeEmail(opts.email);
      if (norm) checks.push(["email", norm]);
    }
    if (opts.name) {
      const norm = normalizeName(opts.name);
      if (norm) checks.push(["name_normalized", norm]);
    }
    for (const [type, value] of checks) {
      const hit = db.prepare(
        "SELECT identifier_type, identifier_value FROM agent_blocklist WHERE identifier_type = ? AND identifier_value = ? LIMIT 1"
      ).get(type, value) as { identifier_type: BlocklistEntry["identifier_type"]; identifier_value: string } | undefined;
      if (hit) {
        return { blocked: true, matchedBy: hit.identifier_type, matchedValue: hit.identifier_value };
      }
    }
    return { blocked: false };
  } catch (err) {
    console.error("[blocklist] isBlocked failed (allowing through):", err);
    // Fail-open: if the blocklist query itself errors, don't block
    // legitimate registrations. The error is logged for follow-up.
    return { blocked: false };
  }
}

// ─── add ───────────────────────────────────────────────────────
// Inserts one or more rows in a single transaction. Returns the
// number of rows actually inserted (UNIQUE conflicts are silently
// ignored — re-blocking the same domain twice is a no-op).
//
// Typical call from a "fjern"-reply handler:
//   add({ name, website, email, agentId, reason: 'opt-out via outreach reply', sourceEmail: 'post@ovre-eide.no' })
// → inserts 4 rows (one per non-empty identifier).

export function add(input: {
  agentId?: string;
  name?: string;
  website?: string;
  email?: string;
  reason: string;
  sourceEmail?: string;
  agentNameForAudit?: string;
}): { inserted: number; rows: BlocklistEntry[] } {
  const db = getDb();
  const now = new Date().toISOString();
  const reason = input.reason || "no reason given";
  const auditName = input.agentNameForAudit || input.name || null;

  const rowsToInsert: Array<{ type: BlocklistEntry["identifier_type"]; value: string }> = [];
  if (input.agentId) rowsToInsert.push({ type: "agent_id", value: input.agentId.toLowerCase() });
  if (input.website) {
    const dom = normalizeDomain(input.website);
    if (dom && !OWN_DOMAINS.has(dom)) rowsToInsert.push({ type: "website_domain", value: dom });
  }
  if (input.email) {
    // PR-14: store literal email address (not domain) — see normalizeEmail comment.
    const norm = normalizeEmail(input.email);
    if (norm) rowsToInsert.push({ type: "email", value: norm });
  }
  if (input.name) {
    const norm = normalizeName(input.name);
    if (norm) rowsToInsert.push({ type: "name_normalized", value: norm });
  }

  if (rowsToInsert.length === 0) {
    return { inserted: 0, rows: [] };
  }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO agent_blocklist
      (identifier_type, identifier_value, reason, source_email, original_agent_id, original_agent_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rowsToInsert) {
      const res = stmt.run(r.type, r.value, reason, input.sourceEmail || null, input.agentId || null, auditName, now);
      if (res.changes > 0) inserted++;
    }
  });
  tx();

  // Read back what's now there for the matching identifiers
  const reread = db.prepare(`
    SELECT * FROM agent_blocklist
    WHERE (identifier_type, identifier_value) IN (${rowsToInsert.map(() => "(?,?)").join(",")})
  `).all(...rowsToInsert.flatMap(r => [r.type, r.value])) as BlocklistEntry[];

  return { inserted, rows: reread };
}

// ─── addManualEntry ─────────────────────────────────────────────
// Generic single-identifier insert for POST /admin/blocklist's new
// { identifier_type, identifier_value, reason? } request shape (dev-request
// 2026-07-15-admin-blocklist-manual-entry-api). Unlike add(), this takes
// exactly one already-typed identifier rather than fanning out over
// name/website/email/agentId — the caller already knows which kind of
// value they're typing in.
//
// website_domain is guarded against PROTECTED_DOMAINS (see above) since a
// manually-typed domain has no producer record behind it to sanity-check
// against, unlike add()'s OWN_DOMAINS check which only ever guards our own
// two domains.

export function addManualEntry(input: {
  identifierType: "email" | "agent_id" | "name_normalized" | "website_domain";
  identifierValue: string;
  reason?: string;
}): { created: boolean; row: BlocklistEntry } {
  const db = getDb();
  const now = new Date().toISOString();
  const reason = input.reason || "manual entry via POST /admin/blocklist";

  let value: string;
  switch (input.identifierType) {
    case "email":
      value = normalizeEmail(input.identifierValue);
      break;
    case "website_domain":
      value = normalizeDomain(input.identifierValue);
      break;
    case "name_normalized":
      value = normalizeName(input.identifierValue);
      break;
    case "agent_id":
      value = String(input.identifierValue || "").trim().toLowerCase();
      break;
    default:
      throw new BlocklistValidationError(`Ukjent identifier_type: ${input.identifierType}`);
  }

  if (!value) {
    throw new BlocklistValidationError("identifier_value normaliserte til en tom verdi");
  }

  if (input.identifierType === "website_domain" && PROTECTED_DOMAINS.has(value)) {
    throw new BlocklistValidationError(
      `"${value}" er en delt/frimail-domene (eller vipps.no) og kan ikke blokkeres som website_domain — det ville undertrykt alle produsenter som deler dette domenet.`
    );
  }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO agent_blocklist
      (identifier_type, identifier_value, reason, source_email, original_agent_id, original_agent_name, created_at)
    VALUES (?, ?, ?, NULL, NULL, NULL, ?)
  `);
  const res = stmt.run(input.identifierType, value, reason, now);

  const row = db.prepare(
    "SELECT * FROM agent_blocklist WHERE identifier_type = ? AND identifier_value = ?"
  ).get(input.identifierType, value) as BlocklistEntry;

  return { created: res.changes > 0, row };
}

// ─── list ──────────────────────────────────────────────────────
export function list(opts?: { limit?: number; offset?: number; since?: string }): BlocklistEntry[] {
  const db = getDb();
  const limit = Math.min(500, Math.max(1, opts?.limit || 100));
  const offset = Math.max(0, opts?.offset || 0);
  if (opts?.since) {
    return db.prepare(
      "SELECT * FROM agent_blocklist WHERE created_at >= ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).all(opts.since, limit, offset) as BlocklistEntry[];
  }
  return db.prepare(
    "SELECT * FROM agent_blocklist ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).all(limit, offset) as BlocklistEntry[];
}

// ─── remove ────────────────────────────────────────────────────
// Used to undo a mistake. Pass either a row id, or a (type, value)
// pair. Returns rows actually removed.
export function remove(input: { id?: number; identifierType?: BlocklistEntry["identifier_type"]; identifierValue?: string }): number {
  const db = getDb();
  if (input.id) {
    return db.prepare("DELETE FROM agent_blocklist WHERE id = ?").run(input.id).changes;
  }
  if (input.identifierType && input.identifierValue) {
    return db.prepare("DELETE FROM agent_blocklist WHERE identifier_type = ? AND identifier_value = ?").run(input.identifierType, input.identifierValue).changes;
  }
  return 0;
}
