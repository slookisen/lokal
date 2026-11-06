// ─── Owner-claim decisions shared by the admin routes and signed links ──────
// dev-request 2026-10-30-rfb-eierkrav-automatisk-vurdering-og-ettklikk,
// slice C4. The three decisions an admin can take on an owner claim —
// approve (claim-review-approve), reject (claim-review-reject) and revoke
// (claim-revoke) — live here so the admin routes in routes/admin-agents.ts
// and the one-click links in routes/claim-action-link.ts give the same
// outcome. The DB part of each decision is synchronous (better-sqlite3), so a
// caller may run it inside its own transaction; the approval mail is a
// separate async step that runs after the state change is stored and never
// throws (a failure only means no mail).

import { getDb } from "../database/init";
import { knowledgeService } from "./knowledge-service";
import { trustScoreService } from "./trust-score-service";
import { emailService } from "./email-service";
import { recordClaimMail } from "./claim-crm-tracking";
import { createOwnerLoginLink } from "../routes/owner-portal";

export type ClaimApproveResult = ReturnType<typeof knowledgeService.approveClaimReview>;
export type ClaimRejectResult = ReturnType<typeof knowledgeService.rejectClaimReview>;
export type ClaimRevokeResult = ReturnType<typeof knowledgeService.revokeClaimOwnership>;

/** Approve a queued claim (approveClaimReview) and recalculate the trust
 *  score. The caller sends the login mail (sendClaimApprovedLoginMail). */
export function applyClaimApprove(claimId: string, email?: string): ClaimApproveResult {
  const approved = knowledgeService.approveClaimReview(claimId, email);
  if (approved.ok) trustScoreService.update(approved.agentId);
  return approved;
}

/** Reject a queued claim (rejectClaimReview); the profile is not touched. */
export function applyClaimReject(claimId: string, note?: string): ClaimRejectResult {
  return knowledgeService.rejectClaimReview(claimId, note);
}

/** Revoke a verified claim (revokeClaimOwnership) and recalculate the trust
 *  score. */
export function applyClaimRevoke(claimId: string, note?: string): ClaimRevokeResult {
  const revoked = knowledgeService.revokeClaimOwnership(claimId, note);
  if (revoked.ok) {
    trustScoreService.update(revoked.agentId);
    console.log(
      `[claim-revoke] claim ${claimId} on agent ${revoked.agentId} revoked: restored=${revoked.restored}, ownerRemains=${revoked.ownerRemains}, sessionsRevoked=${revoked.sessionsRevoked}`
    );
  }
  return revoked;
}

/**
 * K5 (dev-request 2026-11-01-rfb-kravflyt-tal-eiere-fra-e-post): a one-time,
 * 15-minute login straight into the owner portal (/eier) for the approved
 * address and this agent. The approval is already stored, so a failure here
 * only means no mail (false), never an error to retry into a 409.
 * `logPrefix` keeps each caller's own log line.
 */
export async function sendClaimApprovedLoginMail(
  claimId: string,
  approved: { agentId: string; email: string },
  logPrefix: string,
): Promise<boolean> {
  try {
    const nameRow = getDb().prepare("SELECT name FROM agents WHERE id = ?").get(approved.agentId) as { name?: string } | undefined;
    const link = createOwnerLoginLink(approved.agentId, approved.email, "claim_approval");
    const approvedAgentName = nameRow?.name || "din gård";
    const sent = await emailService.sendClaimConfirmation(approved.email, approvedAgentName, link.verifyUrl, approved.agentId);
    const loginLinkSent = sent.success && sent.messageId !== "DRY_RUN";
    recordClaimMail({ kind: "claim_approved", claimId, agentId: approved.agentId, email: approved.email, agentName: approvedAgentName, sendResult: sent });
    return loginLinkSent;
  } catch (err) {
    console.error(`${logPrefix}: login link not sent:`, err instanceof Error ? err.message : "error");
    return false;
  }
}
