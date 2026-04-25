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

export type BlocklistEntry = {
  id: number;
  identifier_type: "website_domain" | "email_domain" | "name_normalized" | "agent_id";
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
      if (dom) checks.push(["website_domain", dom]);
    }
    if (opts.email) {
      const dom = normalizeDomain(opts.email);
      if (dom) checks.push(["email_domain", dom]);
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
    if (dom) rowsToInsert.push({ type: "website_domain", value: dom });
  }
  if (input.email) {
    const dom = normalizeDomain(input.email);
    if (dom) rowsToInsert.push({ type: "email_domain", value: dom });
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

// ─── list ──────────────────────────────────────────────────────
export function list(opts?: { limit?: number; offset?: number }): BlocklistEntry[] {
  const db = getDb();
  const limit = Math.min(500, Math.max(1, opts?.limit || 100));
  const offset = Math.max(0, opts?.offset || 0);
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
