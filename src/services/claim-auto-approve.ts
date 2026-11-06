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

import { getDb } from "../database/init";
import { claimAssessmentEnabled } from "./claim-assessment";
import { applyClaimApprove, sendClaimApprovedLoginMail } from "./claim-review-actions";
import { createClaimActionLinks, isClaimActionLinksEnabled } from "./claim-action-link";
import { emailService } from "./email-service";

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

/**
 * Approves `claimId` when `assessment` is green (the caller has checked the
 * flags and that the claim's own run settled). Resolves true when the claim
 * was approved here — the login mail and the admin notice are then sent (or
 * tried) — and false when nothing was approved, so the caller sends today's
 * queue notice. Never rejects.
 */
export async function autoApproveGreenClaim(claimId: string, assessment: unknown): Promise<boolean> {
  if (!isGreenClaimAssessment(assessment)) return false;
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
    const row = getDb().prepare(
      `SELECT c.claimant_name, a.name AS agent_name FROM agent_claims c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`
    ).get(claimId) as { claimant_name: string | null; agent_name: string | null } | undefined;
    const sent = await emailService.sendAdminClaimAutoApprovedNotification({
      agentName: row?.agent_name || approved.agentId,
      agentId: approved.agentId,
      claimId,
      claimantName: row?.claimant_name || "",
      claimantEmail: approved.email,
      loginLinkSent,
      assessment,
      revokeUrl: revokeLink(claimId),
    });
    if (!sent.success) console.error("[claim-auto-approve] admin notice failed:", sent.error);
  } catch (err: any) {
    console.error("[claim-auto-approve] admin notice error:", err?.message);
  }
  return true;
}
