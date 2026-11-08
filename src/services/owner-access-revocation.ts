// ─── Owner access follows ownership (RFB /eier + /selger logins) ───────────
// dev-request 2026-11-06-rfb-krav-for-portal-og-okter-ved-eierskifte, spec
// point 2: «Eierskifte, unclaim og reset-claim tilbakekaller alle
// 7-dagersøkter og åpne innloggingslenker for profilen.»
//
// RFB owner logins live in magic_links (src/database/init.ts): an unused row
// (used = 0) is an e-mailed login link, a used row is a session (the
// rfb_owner_session cookie / Bearer token, verifyOwnerSession in
// routes/owner-portal.ts) or a /selger login. Every reader checks
// `datetime(expires_at) > datetime('now')`, so a row is revoked by moving its
// expires_at into the past — the same mechanism as logout
// (revokeOwnerSessionToken) and claim-revoke (revokeClaimOwnership). Rows are
// not deleted here (audit trail); the existing hourly cleanup in
// knowledge-service verifyMagicLink removes long-expired rows as before.
//
// Only the RFB main DB's magic_links. Opplevagent/gårdssalg owner sessions
// (experiences.db) and dental are separate and untouched.
//
// Callers run this inside the same transaction as the ownership change, and
// let a failure propagate: the ownership change then rolls back too, so a
// profile never changes hands while the old owner's sessions stay live.

import { getDb } from "../database/init";
import { normalizeEmail } from "./blocklist-service";

type Db = ReturnType<typeof getDb>;

export interface RevokeOwnerAccessOptions {
  /** Addresses whose rows stay live (compared trimmed + lower-cased). */
  keepEmails?: Iterable<string | null | undefined>;
  /** Short label for the log line (never a token or an address). */
  reason?: string;
}

/**
 * Expires every live magic_links row (sessions and unused login links) for
 * `agentId`, except rows whose address is in `keepEmails`. Returns how many
 * rows were revoked. Other agents' rows are never touched.
 */
export function revokeOwnerAccessForAgent(db: Db, agentId: string, opts: RevokeOwnerAccessOptions = {}): number {
  if (!agentId) return 0;
  const keep = new Set<string>();
  for (const e of opts.keepEmails ?? []) {
    const n = normalizeEmail(e);
    if (n) keep.add(n);
  }
  const live = db.prepare(
    `SELECT id, email FROM magic_links WHERE agent_id = ? AND datetime(expires_at) > datetime('now')`
  ).all(agentId) as Array<{ id: string; email: string | null }>;
  const past = new Date(Date.now() - 1000).toISOString();
  const expire = db.prepare(`UPDATE magic_links SET expires_at = ? WHERE id = ? AND agent_id = ?`);
  let revoked = 0;
  for (const row of live) {
    if (keep.has(normalizeEmail(row.email))) continue;
    revoked += expire.run(past, row.id, agentId).changes;
  }
  if (revoked > 0) {
    console.log(`[owner-access] revoked ${revoked} owner session/login link row(s) for ${agentId} (${opts.reason || "ownership change"})`);
  }
  return revoked;
}

/** Normalized addresses of the agent's verified owners (agent_claims status 'verified'). */
export function verifiedOwnerEmails(db: Db, agentId: string): string[] {
  const rows = db.prepare(`SELECT claimant_email FROM agent_claims WHERE agent_id = ? AND status = 'verified'`)
    .all(agentId) as Array<{ claimant_email: string | null }>;
  return rows.map((r) => normalizeEmail(r.claimant_email)).filter((e) => !!e);
}

/**
 * After an ownership change: only the profile's verified owners (as they are
 * NOW, after the change) keep live login rows; everything else for the agent
 * is revoked. With no verified owner left this revokes every row.
 */
export function revokeOwnerAccessExceptVerifiedOwners(db: Db, agentId: string, reason: string): number {
  return revokeOwnerAccessForAgent(db, agentId, { keepEmails: verifiedOwnerEmails(db, agentId), reason });
}
