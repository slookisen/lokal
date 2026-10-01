// ─── Shared "is customer" rule for RFB agents ────────────────────────────────
// dev-request 2026-10-01-rfb-eierkrav-utelates-fra-outreach.
//
// An RFB producer is a CUSTOMER (never cold-mailed, owner-locked) when EITHER
//   * agents.claimed_at is set, OR
//   * a verified agent_claims row exists for the agent.
// Before this rule, computeOutreachCandidates only looked at claimed_at, which
// verifyClaim never set — so a verified owner (Solvang Gård, 2026-07-22) was
// cold-mailed on 2026-10-01. Keep ONE definition here; do not re-inline it.

/** Boolean SQL expression (no CASE). `alias` is the agents table alias. */
export function customerRuleSql(alias = "a"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("invalid SQL alias");
  return `(${alias}.claimed_at IS NOT NULL OR EXISTS (SELECT 1 FROM agent_claims cr_c WHERE cr_c.agent_id = ${alias}.id AND cr_c.status = 'verified'))`;
}

/** Same rule for an already-loaded snapshot (claimed_at + verified-claim count). */
export function isCustomerSnapshot(s: { claimed_at: string | null; verified_claims: number }): boolean {
  return !!s.claimed_at || (s.verified_claims ?? 0) > 0;
}
