// ─── «Be om mer bekreftelse» on a queued owner claim (eierkrav B3a) ─────────
// dev-request 2026-10-30-rfb-eierkrav-automatisk-vurdering-og-ettklikk,
// slice B3a. A third choice next to approve / reject for a claim in the admin
// queue: the person who submitted it gets ONE mail asking for a bit more
// proof (texts: claim-request-more-texts.ts), the claim stays pending_review.
// Shared by the signed link (POST /eierkrav/handling, action request_more) and
// the admin route (POST /admin/agents/claim-request-more).
//
// Flag CLAIM_REQUEST_MORE_ENABLED (off unless exactly "true"; checked in
// claim-action-link.ts). Off → nothing is sent or written, a link is not used
// up.
//
// Audit + rate limit live on the claim row itself, next to where approve /
// reject / revoke record theirs (agent_claims; additive columns in
// database/init.ts):
//   request_more_at   ISO time of the last request that was SENT
//   request_more_via  'action_link' | 'admin'
//   request_more_note the admin's optional note (never mailed)
// At most one request per claim per 24 h (REQUEST_MORE_MIN_INTERVAL_HOURS),
// for both callers: a second attempt within the window → already_requested,
// no mail.
//
// Order: (1) one transaction checks status + window, uses up the link (link
// path) and stamps request_more_at — so two concurrent attempts cannot both
// pass; (2) the mail is sent; (3) on a failed send (error, or DRY_RUN — it
// reached nobody) the stamp is put back to its previous value and the link is
// made unused again, so a failure never counts as a request and can be
// retried. The CRM copy (kind request_more, claim-crm-tracking.ts, its own
// flag) is filed after the send like the other claim mails, with the
// delivery status of the send.
//
// The claimant's address is never logged.

import { getDb } from "../database/init";
import { emailService } from "./email-service";
import { recordClaimMail } from "./claim-crm-tracking";
import { inspectClaimActionToken, isClaimRequestMoreEnabled } from "./claim-action-link";

export { isClaimRequestMoreEnabled, CLAIM_REQUEST_MORE_FLAG_ENV } from "./claim-action-link";

export const REQUEST_MORE_MIN_INTERVAL_HOURS = 24;
export const REQUEST_MORE_NOTE_MAX = 1000;

export type RequestMoreSource = "action_link" | "admin";

type Db = ReturnType<typeof getDb>;

export type RequestMoreResult =
  | { ok: true; claimId: string; agentId: string; agentName: string; emailSent: true }
  | { ok: false; error: "disabled" | "not_found" | "not_pending_review" | "already_requested" }
  | { ok: false; error: "email_failed"; claimId: string; agentId: string; agentName: string }
  // Link path only: the token's own state (see inspectClaimActionToken).
  | { ok: false; error: "link_unavailable" | "link_invalid" | "link_used" | "link_expired" };

interface Reserved {
  claimId: string;
  agentId: string;
  agentName: string;
  email: string;
  stamp: string;
  prev: { at: string | null; via: string | null; note: string | null };
  linkId: string | null;
}

function withinWindow(prevAt: string | null, now: Date): boolean {
  if (!prevAt) return false;
  const t = Date.parse(prevAt);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < REQUEST_MORE_MIN_INTERVAL_HOURS * 60 * 60 * 1000;
}

/** Step 1 — synchronous, one transaction. */
function reserve(
  db: Db,
  now: Date,
  target: { claimId: string } | { token: string },
  source: RequestMoreSource,
  note: string | null,
): Reserved | Exclude<RequestMoreResult, { ok: true } | { error: "email_failed" }> {
  return db.transaction(() => {
    let claimId: string;
    let linkId: string | null = null;
    if ("token" in target) {
      const check = inspectClaimActionToken(target.token, { now, db });
      if (check.state === "unavailable") return { ok: false as const, error: "link_unavailable" as const };
      if (check.state === "invalid") return { ok: false as const, error: "link_invalid" as const };
      if (check.state === "used") return { ok: false as const, error: "link_used" as const };
      if (check.state === "expired") return { ok: false as const, error: "link_expired" as const };
      if (check.ctx.action !== "request_more") return { ok: false as const, error: "link_invalid" as const };
      if (check.state === "wrong_state") return { ok: false as const, error: "not_pending_review" as const };
      claimId = check.ctx.claim_id;
      linkId = check.ctx.link_id;
    } else {
      claimId = target.claimId;
    }

    const claim = db.prepare(
      `SELECT c.id, c.agent_id, c.status, c.claimant_email, c.request_more_at, c.request_more_via, c.request_more_note, a.name
         FROM agent_claims c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`
    ).get(claimId) as {
      id: string; agent_id: string; status: string; claimant_email: string | null;
      request_more_at: string | null; request_more_via: string | null; request_more_note: string | null; name: string | null;
    } | undefined;
    if (!claim) return { ok: false as const, error: "not_found" as const };
    if (claim.status !== "pending_review") return { ok: false as const, error: "not_pending_review" as const };
    if (withinWindow(claim.request_more_at, now)) return { ok: false as const, error: "already_requested" as const };

    if (linkId) {
      const used = db.prepare("UPDATE claim_action_links SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now.toISOString(), linkId);
      if (used.changes !== 1) return { ok: false as const, error: "link_used" as const };
    }
    const stamp = now.toISOString();
    db.prepare(
      `UPDATE agent_claims SET request_more_at = ?, request_more_via = ?, request_more_note = ?
        WHERE id = ? AND status = 'pending_review'`
    ).run(stamp, source, note, claim.id);
    return {
      claimId: claim.id,
      agentId: claim.agent_id,
      agentName: String(claim.name || ""),
      email: String(claim.claimant_email || ""),
      stamp,
      prev: { at: claim.request_more_at, via: claim.request_more_via, note: claim.request_more_note },
      linkId,
    };
  })();
}

/** Step 3 on a failed send: the request did not happen. */
function release(db: Db, r: Reserved): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE agent_claims SET request_more_at = ?, request_more_via = ?, request_more_note = ?
        WHERE id = ? AND request_more_at = ?`
    ).run(r.prev.at, r.prev.via, r.prev.note, r.claimId, r.stamp);
    if (r.linkId) {
      db.prepare("UPDATE claim_action_links SET used_at = NULL WHERE id = ? AND used_at = ? AND used_result IS NULL").run(r.linkId, r.stamp);
    }
  })();
}

/**
 * Asks the claimant of a queued claim for more proof. `target` is the claim
 * id (admin) or a signed request_more link token (link POST). Never throws on
 * a mail failure (→ email_failed, nothing recorded as a request).
 */
export async function requestMoreConfirmation(
  target: { claimId: string } | { token: string },
  source: RequestMoreSource,
  opts: { note?: string; now?: Date; db?: Db } = {},
): Promise<RequestMoreResult> {
  if (!isClaimRequestMoreEnabled()) return { ok: false, error: "disabled" };
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date();
  const note = typeof opts.note === "string" && opts.note.trim() ? opts.note.trim().slice(0, REQUEST_MORE_NOTE_MAX) : null;

  const r = reserve(db, now, target, source, note);
  if (!("stamp" in r)) return r;

  let sendResult: { success: boolean; messageId?: string; error?: string } | null = null;
  try {
    sendResult = await emailService.sendClaimRequestMore(r.email, r.agentName);
  } catch {
    sendResult = { success: false, error: "send_threw" };
  }
  // DRY_RUN reached nobody — treated as not sent, like the other claim mails.
  const sent = sendResult?.success === true && !!sendResult.messageId && sendResult.messageId !== "DRY_RUN";

  recordClaimMail({ kind: "request_more", claimId: r.claimId, agentId: r.agentId, email: r.email, agentName: r.agentName, sendResult });

  if (!sent) {
    try {
      release(db, r);
    } catch (err) {
      console.error(`[claim-request-more] claim ${r.claimId}: could not undo the reservation:`, err instanceof Error ? err.message : "error");
    }
    console.warn(`[claim-request-more] claim ${r.claimId} (${source}): mail not sent; nothing recorded`);
    return { ok: false, error: "email_failed", claimId: r.claimId, agentId: r.agentId, agentName: r.agentName };
  }
  if (r.linkId) {
    db.prepare("UPDATE claim_action_links SET used_result = 'requested_more' WHERE id = ?").run(r.linkId);
  }
  console.log(`[claim-request-more] claim ${r.claimId} on agent ${r.agentId}: more confirmation requested (${source})`);
  return { ok: true, claimId: r.claimId, agentId: r.agentId, agentName: r.agentName, emailSent: true };
}
