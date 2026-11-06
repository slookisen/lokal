// ─── Eierkrav B2b-1: green claim auto-approval ──────────────────────────────
// dev-request 2026-10-30-rfb-eierkrav-automatisk-vurdering-og-ettklikk, slice
// B2b-1. With CLAIM_AUTO_APPROVE_ENABLED === "true" AND
// CLAIM_AUTO_ASSESSMENT_ENABLED === "true" (both off by default, exact match
// only), a new queued claim whose own assessment run settled with a green
// stored result is approved through the admin path (applyClaimApprove, via
// 'auto_assessment'), the claimant gets today's approval login mail
// (sendClaimApprovedLoginMail, which writes the CRM trail), and the admin gets
// «Eierkrav godkjent automatisk» with an «Angre» (revoke) option instead of
// the «claim queued» notice. Anything else — a flag off, yellow, red, an
// unknown/NULL/unreadable value, a failed or timed-out run, a claim already
// decided, a profile that got an owner, a throw — approves nothing, and the
// caller sends today's queue notice.
//
// B2b-2: after such an approval the farm's KNOWN address — resolveFarmContactEmail
// as it was BEFORE the approval — gets «Ny eier registrert for <profil>»
// (emailService.sendClaimFarmNotice), only when that address exists, differs
// (trim + lower case) from the claimant's e-mail and is not shared
// (isSharedKnownEmail). No new flag: this path already needs both flags above.
// With CLAIM_CRM_TRACKING_ENABLED it is filed as a "farm_notice" in the
// claim's CRM thread. The admin notice says «sendt» / «ikke sendt (<grunn>)».
// A failure or throw here never undoes the approval and never stops the login
// mail or the admin notice. The address is never logged.

import { getDb } from "../database/init";
import { claimAssessmentEnabled } from "./claim-assessment";
import { applyClaimApprove, sendClaimApprovedLoginMail } from "./claim-review-actions";
import { createClaimActionLinks, isClaimActionLinksEnabled } from "./claim-action-link";
import { emailService, type ClaimFarmNoticeOutcome } from "./email-service";
import { knowledgeService } from "./knowledge-service";
import { recordClaimMail } from "./claim-crm-tracking";

export const CLAIM_AUTO_APPROVE_FLAG = "CLAIM_AUTO_APPROVE_ENABLED";

/** Both flags exactly "true" ("TRUE", "1" and the like are off). */
export function claimAutoApproveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLAIM_AUTO_APPROVE_FLAG] === "true" && claimAssessmentEnabled(env);
}

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;

/**
 * A stored assessment that is green by its own result AND by slice A's rule
 * (an own anchor, a support other than S4, no red flag, no unavailable
 * source, no possible duplicate). A value that says green but does not hold
 * up — or is anything but a well-formed object — is not green.
 */
export function isGreenClaimAssessment(assessment: unknown): boolean {
  if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) return false;
  const a = assessment as Record<string, unknown>;
  const anchors = strings(a.anchors);
  const supports = strings(a.supports);
  const redFlags = strings(a.red_flags);
  const unavailable = strings(a.unavailable_sources);
  return a.result === "green"
    && !!anchors && anchors.some((x) => x !== "A1_sibling")
    && !!supports && supports.some((x) => x !== "S4")
    && !!redFlags && redFlags.length === 0
    && !!unavailable && unavailable.length === 0
    && a.possible_duplicate === false;
}

/** The signed C4 revoke link for the notice, or undefined (flag off, no
 *  recipient, secret missing/short, a refusal or a throw). Never logged. */
function revokeLink(claimId: string): string | undefined {
  if (!isClaimActionLinksEnabled() || !process.env.ADMIN_NOTIFICATION_EMAIL) return undefined;
  try {
    const minted = createClaimActionLinks(claimId, ["revoke"]);
    if (!minted.ok) {
      console.warn("[claim-auto-approve] revoke link not minted:", minted.reason);
      return undefined;
    }
    return minted.links.find((l) => l.action === "revoke")?.url;
  } catch (err: any) {
    console.error("[claim-auto-approve] revoke link failed:", err?.message);
    return undefined;
  }
}

const normalized = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();

/** B2b-2: where the farm notice would go, read before the approval changes
 *  anything — the known address, or why there is none to use. May throw. */
type FarmNoticePlan = { address: string } | { address: null; outcome: ClaimFarmNoticeOutcome };
function planFarmNotice(claimId: string): FarmNoticePlan {
  const claim = getDb().prepare("SELECT agent_id, claimant_email FROM agent_claims WHERE id = ?").get(claimId) as
    { agent_id: string; claimant_email: string | null } | undefined;
  if (!claim) return { address: null, outcome: { sent: false, reason: "no_known_email" } };
  const known = knowledgeService.resolveFarmContactEmail(claim.agent_id);
  if (!known || !normalized(known)) return { address: null, outcome: { sent: false, reason: "no_known_email" } };
  if (normalized(known) === normalized(claim.claimant_email)) return { address: null, outcome: { sent: false, reason: "same_as_claimant" } };
  if (knowledgeService.isSharedKnownEmail(known, claim.agent_id)) return { address: null, outcome: { sent: false, reason: "shared_address" } };
  return { address: normalized(known) };
}

/** B2b-2: sends the notice per `plan` after the approval. Never rejects. */
async function sendFarmNotice(
  claimId: string,
  plan: FarmNoticePlan,
  approved: { agentId: string; email: string },
  agentName: string,
): Promise<ClaimFarmNoticeOutcome> {
  if (plan.address === null) {
    console.log(`[claim-auto-approve] farm notice for claim ${claimId} not sent: ${plan.outcome.sent ? "sent" : plan.outcome.reason}`);
    return plan.outcome;
  }
  // The approved owner address may differ from the queued one; never notify the claimant as "the farm".
  if (plan.address === normalized(approved.email)) {
    console.log(`[claim-auto-approve] farm notice for claim ${claimId} not sent: same_as_claimant`);
    return { sent: false, reason: "same_as_claimant" };
  }
  try {
    const at = new Date();
    const sent = await emailService.sendClaimFarmNotice(plan.address, agentName, at);
    recordClaimMail({ kind: "farm_notice", claimId, agentId: approved.agentId, email: plan.address, agentName, sendResult: sent, at });
    if (sent.success && sent.messageId !== "DRY_RUN") {
      console.log(`[claim-auto-approve] farm notice for claim ${claimId} sent`);
      return { sent: true };
    }
    console.error(`[claim-auto-approve] farm notice for claim ${claimId} not sent: send_failed`);
  } catch (err: any) {
    console.error(`[claim-auto-approve] farm notice for claim ${claimId} not sent: send_failed (${err?.name ?? "error"})`);
  }
  return { sent: false, reason: "send_failed" };
}

/**
 * Approves `claimId` when `assessment` is green (the caller has checked the
 * flags and that the claim's own run settled). Resolves true when the claim
 * was approved here — the login mail and the admin notice are then sent (or
 * tried) — and false when nothing was approved, so the caller sends today's
 * queue notice. Never rejects.
 */
export async function autoApproveGreenClaim(claimId: string, assessment: unknown): Promise<boolean> {
  if (!isGreenClaimAssessment(assessment)) return false;
  // B2b-2: the farm's known address as it is before the approval.
  let farmPlan: FarmNoticePlan;
  try {
    farmPlan = planFarmNotice(claimId);
  } catch (err: any) {
    console.error(`[claim-auto-approve] farm notice plan for claim ${claimId} failed: ${err?.name ?? "error"}`);
    farmPlan = { address: null, outcome: { sent: false, reason: "send_failed" } };
  }
  let approved: ReturnType<typeof applyClaimApprove>;
  try {
    approved = applyClaimApprove(claimId, undefined, "auto_assessment");
  } catch (err: any) {
    console.error(`[claim-auto-approve] claim ${claimId} not approved: ${err?.code ?? "error"}`);
    return false;
  }
  if (!approved.ok) {
    console.log(`[claim-auto-approve] claim ${claimId} not approved: ${approved.error}`);
    return false;
  }
  console.log(`[claim-auto-approve] claim ${claimId} on agent ${approved.agentId} approved (auto_assessment, isVerified=${approved.isVerified})`);

  try {
    const loginLinkSent = await sendClaimApprovedLoginMail(claimId, approved, "[claim-auto-approve]");
    let row: { claimant_name: string | null; agent_name: string | null } | undefined;
    try {
      row = getDb().prepare(
        `SELECT c.claimant_name, a.name AS agent_name FROM agent_claims c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`
      ).get(claimId) as { claimant_name: string | null; agent_name: string | null } | undefined;
    } catch (err: any) {
      console.error("[claim-auto-approve] claim row read failed:", err?.message);
    }
    const farmNotice = await sendFarmNotice(claimId, farmPlan, approved, row?.agent_name || "din gård");
    const sent = await emailService.sendAdminClaimAutoApprovedNotification({
      agentName: row?.agent_name || approved.agentId,
      agentId: approved.agentId,
      claimId,
      claimantName: row?.claimant_name || "",
      claimantEmail: approved.email,
      loginLinkSent,
      assessment,
      revokeUrl: revokeLink(claimId),
      farmNotice,
    });
    if (!sent.success) console.error("[claim-auto-approve] admin notice failed:", sent.error);
  } catch (err: any) {
    console.error("[claim-auto-approve] admin notice error:", err?.message);
  }
  return true;
}
