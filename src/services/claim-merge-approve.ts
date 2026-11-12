// ─── «Slå sammen og godkjenn»: merge a sibling into a claimed profile + approve ─
// dev-request 2026-10-30-rfb-eierkrav-automatisk-vurdering-og-ettklikk,
// slice D1. Used by POST /admin/agents/claim-merge-approve.
//
// A queued owner claim (pending_review) sits on a profile that has a sibling
// (same org.nr, phone or street address + postal code — the claim
// assessment's rule, knowledge-service.ts claimSiblingsForRow). The admin
// names the duplicate explicitly (detection and merge are never the same
// operation): the duplicate is merged INTO the claimed profile (the survivor),
// then the claim is approved the same way as the admin approve route.
//
// Flag CLAIM_MERGE_APPROVE_ENABLED (off unless exactly "true"). Off → the
// route answers 503 and nothing changes.
//
// ── Merge ────────────────────────────────────────────────────────────────
// The per-pair core of POST /admin/agents/duplicate-merge (readAgentSnapshot
// → computeFillPlan → applyMergeWrites): fill-only, curated fields locked,
// field_provenance append-only, one agent_knowledge_audit row per changed
// field + one 'merge' row, duplicate is_active = 0 + merged_into. With
// `{ g8: true }` it also moves opening hours, the delivery fields and the map
// point fill-only, and re-geocodes the survivor when its address comes from
// the duplicate while it keeps its own point.
//
// claimed_at: duplicate-merge skips a pair where EITHER row has claimed_at.
// Here the survivor carries a pending claim but no owner — claimed_at is only
// stamped when a claim is granted (grantClaimOwnership), and a survivor that
// already has an owner (claimed_at or a verified claim, customer-rule.ts) is
// refused with 409 has_owner before anything else. So the survivor reaches
// the core with claimed_at NULL and is not skipped; a duplicate with an owner
// is refused with 409 duplicate_claimed.
//
// ── Atomicity ────────────────────────────────────────────────────────────
// Every check (from a fresh read), the merge writes and the approval
// (applyClaimApprove → approveClaimReview, whose own db.transaction runs as a
// SAVEPOINT inside this one) run in ONE better-sqlite3 transaction. When the
// approval refuses (ok: false) or anything throws, the whole transaction is
// rolled back: no half merge without an approval. The login mail is sent by
// the caller only after commit.
//
// ── D2: the signed link ──────────────────────────────────────────────────
// The admin notice for a queued claim carries one merge_approve link
// (services/claim-action-link.ts) per mergeable sibling
// (mergeApproveCandidates). redeemClaimMergeApproveLink runs the D1
// operation above for the link's claim + sibling, with source action_link,
// and uses the link up in the SAME transaction (conditional UPDATE … WHERE
// used_at IS NULL): a refusal or error rolls everything back and the link
// stays unused. The caller sends the login mail after commit.
//
// The claimant's address is never logged.

import { getDb } from "../database/init";
import { customerRuleSql } from "./customer-rule";
import { knowledgeService } from "./knowledge-service";
import { applyClaimApprove } from "./claim-review-actions";
import { inspectClaimActionToken, isClaimMergeApproveEnabled } from "./claim-action-link";
import {
  readAgentSnapshot,
  computeFillPlan,
  applyMergeWrites,
  MAP_POINT_FIELDS,
} from "../routes/admin-agents-duplicate-merge";

// The flag lives in claim-action-link.ts (it also gates the D2 link).
export { isClaimMergeApproveEnabled, CLAIM_MERGE_APPROVE_FLAG_ENV } from "./claim-action-link";

/** Who ran the operation: the D1 admin route or the D2 signed link. */
export type ClaimMergeApproveSource = "admin" | "action_link";

export const CLAIM_MERGE_APPROVE_NOTE_MAX = 1000;

export type ClaimMergeApproveRefusal =
  | { ok: false; status: 404; error: "claim_not_found" | "duplicate_not_found" }
  | { ok: false; status: 400; error: "duplicate_is_claim_agent" }
  | {
      ok: false;
      status: 409;
      error: "not_pending_review" | "has_owner" | "survivor_inactive" | "duplicate_inactive" | "not_a_sibling" | "duplicate_claimed";
    }
  // The merge ran but the approval refused: everything was rolled back.
  | { ok: false; status: 409; error: "approve_failed"; reason: string; rolledBack: true };

export interface ClaimMergeApproveSuccess {
  ok: true;
  dryRun: boolean;
  claimId: string;
  agentId: string;
  duplicateId: string;
  /** Survivor fields filled from the duplicate (contact + knowledge + G8). */
  filled: string[];
  /** Map-point columns moved from the duplicate (MAP_POINT_FIELDS). */
  moved: string[];
  curatedSkipped: string[];
  /** Why a map point the survivor lacks was not moved, if so. */
  mapPointSkipped?: string;
  geocodeReset: boolean;
  /** Open claims (pending_review / code_sent) left on the duplicate. */
  duplicateOpenClaims: number;
  /** Apply only: the approval result (address for the login mail). */
  approved?: { email: string; isVerified: boolean };
}

export type ClaimMergeApproveResult = ClaimMergeApproveSuccess | ClaimMergeApproveRefusal;

class ApproveRefused extends Error {
  constructor(readonly reason: string) {
    super(`approve refused: ${reason}`);
  }
}

/**
 * Checks, plans and (with `apply`) executes merge + approval in one
 * transaction. Dry-run (the default) runs the same checks and plan and writes
 * nothing. Never sends mail (the route does, after commit).
 */
export function runClaimMergeApprove(input: {
  claimId: string;
  duplicateId: string;
  note?: string;
  apply: boolean;
  /** Default "admin" (the D1 route; its audit text is unchanged). */
  source?: ClaimMergeApproveSource;
}): ClaimMergeApproveResult {
  const db = getDb();
  const { claimId, duplicateId, apply } = input;
  const note = input.note?.trim() || "";
  const via = input.source === "action_link" ? " via action_link" : "";
  const reason = `claim-merge-approve${via} claim ${claimId}${note ? `: ${note}` : ""}`;
  const batchTag = `claim-merge-approve-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  try {
    return db.transaction((): ClaimMergeApproveResult => {
      const claim = db.prepare("SELECT id, agent_id, status FROM agent_claims WHERE id = ?").get(claimId) as
        | { id: string; agent_id: string; status: string }
        | undefined;
      if (!claim) return { ok: false, status: 404, error: "claim_not_found" };
      const survivor = readAgentSnapshot(db, claim.agent_id);
      if (!survivor) return { ok: false, status: 404, error: "claim_not_found" };
      if (claim.status !== "pending_review") return { ok: false, status: 409, error: "not_pending_review" };
      const owned = (agentId: string): boolean =>
        !!(db.prepare(`SELECT ${customerRuleSql("a")} AS owned FROM agents a WHERE a.id = ?`).get(agentId) as { owned: number } | undefined)?.owned;
      if (owned(claim.agent_id)) return { ok: false, status: 409, error: "has_owner" };
      if (duplicateId === claim.agent_id) return { ok: false, status: 400, error: "duplicate_is_claim_agent" };
      if (!survivor.isActive) return { ok: false, status: 409, error: "survivor_inactive" };

      const duplicate = readAgentSnapshot(db, duplicateId);
      if (!duplicate) return { ok: false, status: 404, error: "duplicate_not_found" };
      if (!duplicate.isActive || duplicate.mergedInto !== null) return { ok: false, status: 409, error: "duplicate_inactive" };
      if (!knowledgeService.findClaimSiblingIds(claim.agent_id).includes(duplicateId)) {
        return { ok: false, status: 409, error: "not_a_sibling" };
      }
      if (owned(duplicateId)) return { ok: false, status: 409, error: "duplicate_claimed" };

      const plan = computeFillPlan(survivor, duplicate, { g8: true });
      const isMapPoint = (f: string) => (MAP_POINT_FIELDS as readonly string[]).includes(f);
      const filled = plan.fillable.filter((f) => !isMapPoint(f.field)).map((f) => f.field);
      const moved = plan.fillable.filter((f) => isMapPoint(f.field)).map((f) => f.field);
      const duplicateOpenClaims = (db.prepare(
        "SELECT COUNT(*) AS n FROM agent_claims WHERE agent_id = ? AND status IN ('pending_review', 'code_sent')",
      ).get(duplicateId) as { n: number }).n;

      const base: ClaimMergeApproveSuccess = {
        ok: true,
        dryRun: !apply,
        claimId,
        agentId: claim.agent_id,
        duplicateId,
        filled,
        moved,
        curatedSkipped: plan.curatedSkipped,
        ...(plan.mapPointSkipped ? { mapPointSkipped: plan.mapPointSkipped } : {}),
        geocodeReset: !!plan.geocodeReset,
        duplicateOpenClaims,
      };
      if (!apply) return base;

      applyMergeWrites(db, survivor, duplicate, plan, reason, batchTag);
      const approved = applyClaimApprove(claimId);
      // Throwing rolls back the merge writes above together with the approval.
      if (!approved.ok) throw new ApproveRefused(approved.error);
      return { ...base, approved: { email: approved.email, isVerified: approved.isVerified } };
    })();
  } catch (err) {
    if (err instanceof ApproveRefused) {
      return { ok: false, status: 409, error: "approve_failed", reason: err.reason, rolledBack: true };
    }
    throw err;
  }
}

// ─── D2: notice candidates + signed-link redemption ─────────────────────────

export const MERGE_APPROVE_NOTICE_MAX = 3;

/**
 * The siblings the admin notice offers «Slå sammen med <navn> og godkjenn»
 * for: read fresh with findClaimSiblingIds (the rule D1 checks), without
 * inactive / merged profiles and profiles with an owner, sorted by id, at
 * most MERGE_APPROVE_NOTICE_MAX. Read-only.
 */
export function mergeApproveCandidates(agentId: string): Array<{ id: string; name: string }> {
  const ids = knowledgeService.findClaimSiblingIds(agentId);
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = db.prepare(
    `SELECT a.id, a.name FROM agents a
      WHERE a.id IN (${ids.map(() => "?").join(", ")})
        AND a.is_active = 1 AND a.merged_into IS NULL AND NOT (${customerRuleSql("a")})`,
  ).all(...ids) as Array<{ id: string; name: string | null }>;
  return rows
    .map((r) => ({ id: r.id, name: String(r.name || "") }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MERGE_APPROVE_NOTICE_MAX);
}

export type RedeemMergeApproveLinkResult =
  | {
      ok: true;
      claimId: string;
      agentId: string;
      agentName: string;
      duplicateId: string;
      duplicateName: string;
      filled: string[];
      moved: string[];
      approved: { email: string; isVerified: boolean };
    }
  | { ok: false; error: "disabled" | "link_unavailable" | "link_invalid" | "link_used" | "link_expired" | "not_pending_review" }
  // A D1 check refused (fresh read inside the transaction): nothing written, link not used up.
  | { ok: false; error: "refused"; refusal: ClaimMergeApproveRefusal };

class LinkMergeRefused extends Error {
  constructor(readonly refusal: ClaimMergeApproveRefusal) {
    super(`merge_approve refused: ${refusal.error}`);
  }
}

/**
 * POST of a merge_approve link: one transaction that checks the link, uses it
 * up and runs runClaimMergeApprove (apply, source action_link) for the link's
 * claim + sibling (nested as a SAVEPOINT). A refusal or a throw rolls back the
 * whole transaction, so the link is only used up together with the merge and
 * the approval. Never sends mail.
 */
export function redeemClaimMergeApproveLink(token: unknown, opts: { now?: Date } = {}): RedeemMergeApproveLinkResult {
  if (!isClaimMergeApproveEnabled()) return { ok: false, error: "disabled" };
  const db = getDb();
  const now = opts.now ?? new Date();
  try {
    return db.transaction((): RedeemMergeApproveLinkResult => {
      const check = inspectClaimActionToken(token, { now, db });
      if (check.state === "unavailable") return { ok: false, error: "link_unavailable" };
      if (check.state === "invalid") return { ok: false, error: "link_invalid" };
      if (check.state === "used") return { ok: false, error: "link_used" };
      if (check.state === "expired") return { ok: false, error: "link_expired" };
      const { ctx } = check;
      if (ctx.action !== "merge_approve" || !ctx.duplicate_id) return { ok: false, error: "link_invalid" };
      if (check.state === "wrong_state") return { ok: false, error: "not_pending_review" };

      const used = db.prepare("UPDATE claim_action_links SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now.toISOString(), ctx.link_id);
      if (used.changes !== 1) return { ok: false, error: "link_used" };

      const r = runClaimMergeApprove({ claimId: ctx.claim_id, duplicateId: ctx.duplicate_id, apply: true, source: "action_link" });
      if (!r.ok) throw new LinkMergeRefused(r);
      if (!r.approved) throw new Error("merge_approve: apply returned no approval");
      db.prepare("UPDATE claim_action_links SET used_result = ? WHERE id = ?").run("merged_approved", ctx.link_id);
      return {
        ok: true,
        claimId: ctx.claim_id,
        agentId: r.agentId,
        agentName: ctx.agent_name,
        duplicateId: ctx.duplicate_id,
        duplicateName: ctx.duplicate_name,
        filled: r.filled,
        moved: r.moved,
        approved: r.approved,
      };
    })();
  } catch (err) {
    // Rolled back: the link is not used up and nothing was written.
    if (err instanceof LinkMergeRefused) return { ok: false, error: "refused", refusal: err.refusal };
    throw err;
  }
}
