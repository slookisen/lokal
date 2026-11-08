// ─── Signed one-click links for owner claims («eierkrav», slice C4) ─────────
// dev-request 2026-10-30-rfb-eierkrav-automatisk-vurdering-og-ettklikk,
// slice C4 (spec §C, first point).
//
// Admin mints one signed one-time link per decision on an owner claim
// (POST /admin/agents/claim-action-links). GET on the link only shows a
// confirmation page; a POST of that page performs the decision once. The
// decisions are the admin routes' own (services/claim-review-actions.ts):
//   approve → claim-review-approve (approveClaimReview + trust score + login mail)
//   reject  → claim-review-reject  (rejectClaimReview)
//   revoke  → claim-revoke         (revokeClaimOwnership + trust score)
// Nothing here sends the links anywhere; they are only returned to admin.
//
// Token:  v1.<payload>.<sig>   (same shape as services/order-activation-link.ts)
//   payload = base64url(JSON {c: claim id, a: action, x: expiry (unix s),
//             n: 16 random bytes base64url})
//   sig     = base64url(HMAC-SHA256(secret, "rfb-claim-action:v1:" + payload))
// Secret: CLAIM_ACTION_LINK_SECRET (min. 32 chars). No fallback key: when
// unset, minting fails closed (503) and every link reads as unavailable.
// Rotating the secret invalidates every outstanding link.
// Flag: CLAIM_ACTION_LINKS_ENABLED (off unless exactly "true") — checked by
// the routes: off → public pages 404, admin mint 503.
//
// Server side: claim_action_links row keyed by nonce_hash = sha256(nonce). A
// link is valid only while that row exists for the same claim and action, is
// unused and the expiry has not passed. Use is a conditional
// UPDATE … WHERE used_at IS NULL inside one transaction with the decision, so
// a double submit succeeds once. When the claim is no longer in the state the
// action needs (approve after reject, …) nothing is written and the link is
// not used up.
//
// Eierkrav B3a: a fourth action, request_more («Be om mer bekreftelse», claim
// stays pending_review, one mail to the claimant), behind
// CLAIM_REQUEST_MORE_ENABLED (off unless exactly "true"). Flag off → it is
// never minted (not by default, not when asked for) and an existing link
// executes nothing. It sends a mail, so it is not redeemed here but by
// services/claim-request-more.ts (the link POST dispatches to it);
// redeemClaimActionLink refuses it without using the link up.
//
// Eierkrav D2: a fifth action, merge_approve («Slå sammen med <søsken> og
// godkjenn»), behind CLAIM_MERGE_APPROVE_ENABLED (the D1 flag). It is bound
// to the claim AND one sibling profile: the sibling id is in the signed
// payload (`d`) and in claim_action_links.duplicate_id, and both must agree
// (every other action has neither). It is never part of a default set and is
// only minted with a duplicate id. Like request_more it is not redeemed here
// but by services/claim-merge-approve.ts (redeemClaimMergeApproveLink), in one
// transaction with the merge + approval.

import crypto from "crypto";
import { getDb } from "../database/init";
import { applyClaimApprove, applyClaimReject, applyClaimRevoke } from "./claim-review-actions";

export const CLAIM_ACTION_SECRET_ENV = "CLAIM_ACTION_LINK_SECRET";
export const CLAIM_ACTION_SECRET_MIN_LENGTH = 32;
export const CLAIM_ACTION_FLAG_ENV = "CLAIM_ACTION_LINKS_ENABLED";
export const CLAIM_ACTION_VALID_HOURS = 72;
export const CLAIM_ACTION_PATH = "/eierkrav/handling";
export const CLAIM_ACTION_BASE_URL = "https://rettfrabonden.com";

export const CLAIM_ACTIONS = ["approve", "reject", "revoke", "request_more", "merge_approve"] as const;
export type ClaimAction = (typeof CLAIM_ACTIONS)[number];

const TOKEN_VERSION = "v1";
const SIG_CONTEXT = "rfb-claim-action:v1:";
const MAX_TOKEN_LENGTH = 1024;
const MAX_CLAIM_ID_LENGTH = 200;
const MAX_DUPLICATE_ID_LENGTH = 200;

type Db = ReturnType<typeof getDb>;

/** CLAIM_ACTION_LINKS_ENABLED — off unless exactly "true". */
export function isClaimActionLinksEnabled(): boolean {
  return process.env[CLAIM_ACTION_FLAG_ENV] === "true";
}

/** Eierkrav B3a: CLAIM_REQUEST_MORE_ENABLED — off unless exactly "true". */
export const CLAIM_REQUEST_MORE_FLAG_ENV = "CLAIM_REQUEST_MORE_ENABLED";
export function isClaimRequestMoreEnabled(): boolean {
  return process.env[CLAIM_REQUEST_MORE_FLAG_ENV] === "true";
}

/** Eierkrav D1/D2: CLAIM_MERGE_APPROVE_ENABLED — off unless exactly "true".
 *  Gates the D1 admin route and the D2 merge_approve link. */
export const CLAIM_MERGE_APPROVE_FLAG_ENV = "CLAIM_MERGE_APPROVE_ENABLED";
export function isClaimMergeApproveEnabled(): boolean {
  return process.env[CLAIM_MERGE_APPROVE_FLAG_ENV] === "true";
}

/** The signing secret, or null when unset/too short (callers fail closed). */
export function claimActionSecret(): string | null {
  const s = process.env[CLAIM_ACTION_SECRET_ENV];
  if (!s || s.length < CLAIM_ACTION_SECRET_MIN_LENGTH) return null;
  return s;
}

export function isClaimAction(v: unknown): v is ClaimAction {
  return typeof v === "string" && (CLAIM_ACTIONS as readonly string[]).includes(v);
}

/** The claim status each action needs. */
const REQUIRED_STATUS: Record<ClaimAction, string> = {
  approve: "pending_review",
  reject: "pending_review",
  revoke: "verified",
  request_more: "pending_review",
  merge_approve: "pending_review",
};

/** Whether an action may be minted / executed at all right now (B3a:
 *  request_more depends on its flag; D2: merge_approve on the D1 flag). */
function isActionEnabled(a: ClaimAction): boolean {
  if (a === "request_more") return isClaimRequestMoreEnabled();
  if (a === "merge_approve") return isClaimMergeApproveEnabled();
  return true;
}

/** The actions that fit a claim's current status (the mint default).
 *  request_more only with CLAIM_REQUEST_MORE_ENABLED, so with the flag off
 *  the default is exactly what it was before B3a. merge_approve is never a
 *  default (D2: it needs a sibling id). */
export function actionsForStatus(status: string): ClaimAction[] {
  return CLAIM_ACTIONS.filter((a) => a !== "merge_approve" && REQUIRED_STATUS[a] === status && isActionEnabled(a));
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmac(secret: string, data: string): Buffer {
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest();
}

function nonceHash(nonce: string): string {
  return crypto.createHash("sha256").update(nonce, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

interface TokenPayload { c: string; a: ClaimAction; x: number; n: string; d?: string }

/** Verify the signature and shape; null on anything wrong. Never throws. */
function parseToken(secret: string, token: unknown): TokenPayload | null {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, payloadB64, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const expected = b64url(hmac(secret, SIG_CONTEXT + payloadB64));
  if (!safeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
    if (!p || typeof p !== "object") return null;
    if (typeof p.c !== "string" || !p.c || p.c.length > MAX_CLAIM_ID_LENGTH) return null;
    if (!isClaimAction(p.a)) return null;
    if (typeof p.x !== "number" || !Number.isFinite(p.x)) return null;
    if (typeof p.n !== "string" || p.n.length < 16) return null;
    // D2: a duplicate id exactly on merge_approve, never on another action.
    if (p.a === "merge_approve") {
      if (typeof p.d !== "string" || !p.d || p.d.length > MAX_DUPLICATE_ID_LENGTH) return null;
      return { c: p.c, a: p.a, x: p.x, n: p.n, d: p.d };
    }
    if (p.d !== undefined) return null;
    return { c: p.c, a: p.a, x: p.x, n: p.n };
  } catch {
    return null;
  }
}

// ─── Minting (admin) ────────────────────────────────────────────────────────

export interface MintedClaimActionLink { action: ClaimAction; url: string; expires_at: string }

export type CreateClaimActionLinksResult =
  | { ok: true; claim_id: string; agent_id: string; name: string; status: string; links: MintedClaimActionLink[] }
  | { ok: false; reason: "secret_missing" | "action_disabled" | "duplicate_required" | "claim_not_found" | "action_not_valid_for_status" | "no_actions_for_status"; status?: string };

/** D2: `duplicateId` is required for (and only used by) merge_approve, which
 *  is then the only action minted in that call. */
export function createClaimActionLinks(
  claimId: string,
  actions: ClaimAction[] | undefined,
  opts: { now?: Date; db?: Db; duplicateId?: string } = {},
): CreateClaimActionLinksResult {
  const secret = claimActionSecret();
  if (!secret) return { ok: false, reason: "secret_missing" };
  if (actions && actions.some((a) => !isActionEnabled(a))) return { ok: false, reason: "action_disabled" };
  const merge = !!actions && actions.includes("merge_approve");
  const duplicateId = opts.duplicateId;
  if (merge !== (duplicateId !== undefined)) return { ok: false, reason: "duplicate_required" };
  if (merge && (actions!.length !== 1 || !duplicateId || duplicateId.length > MAX_DUPLICATE_ID_LENGTH)) {
    return { ok: false, reason: "duplicate_required" };
  }
  const db = opts.db ?? getDb();
  const claim = db.prepare(
    `SELECT c.id, c.agent_id, c.status, a.name FROM agent_claims c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`
  ).get(claimId) as { id: string; agent_id: string; status: string; name: string | null } | undefined;
  if (!claim) return { ok: false, reason: "claim_not_found" };
  const status = String(claim.status || "");
  const fitting = actionsForStatus(status);
  let wanted: ClaimAction[];
  if (actions && actions.length > 0) {
    wanted = CLAIM_ACTIONS.filter((a) => actions.includes(a));
    // Every asked-for action is enabled (checked above), so this is the
    // status fit actionsForStatus applies (merge_approve included).
    if (wanted.some((a) => REQUIRED_STATUS[a] !== status)) return { ok: false, reason: "action_not_valid_for_status", status };
  } else {
    wanted = fitting;
    if (wanted.length === 0) return { ok: false, reason: "no_actions_for_status", status };
  }

  const now = opts.now ?? new Date();
  const expiresS = Math.floor((now.getTime() + CLAIM_ACTION_VALID_HOURS * 60 * 60 * 1000) / 1000);
  const expiresAt = new Date(expiresS * 1000).toISOString();
  const insert = db.prepare(
    `INSERT INTO claim_action_links (id, nonce_hash, claim_id, action, created_at, expires_at, created_by, duplicate_id)
     VALUES (?, ?, ?, ?, ?, ?, 'admin', ?)`
  );
  const links: MintedClaimActionLink[] = [];
  db.transaction(() => {
    for (const action of wanted) {
      const nonce = b64url(crypto.randomBytes(16));
      const d = action === "merge_approve" ? duplicateId! : null;
      const payload = d === null ? { c: claim.id, a: action, x: expiresS, n: nonce } : { c: claim.id, a: action, x: expiresS, n: nonce, d };
      const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
      const token = `${TOKEN_VERSION}.${payloadB64}.${b64url(hmac(secret, SIG_CONTEXT + payloadB64))}`;
      insert.run(`cal_${crypto.randomBytes(12).toString("hex")}`, nonceHash(nonce), claim.id, action, now.toISOString(), expiresAt, d);
      links.push({ action, url: `${CLAIM_ACTION_BASE_URL}${CLAIM_ACTION_PATH}?t=${encodeURIComponent(token)}`, expires_at: expiresAt });
    }
  })();
  return { ok: true, claim_id: claim.id, agent_id: claim.agent_id, name: String(claim.name || ""), status, links };
}

// ─── Inspection (confirmation page; read-only) ──────────────────────────────

export interface ClaimActionContext {
  link_id: string;
  claim_id: string;
  action: ClaimAction;
  agent_id: string;
  agent_name: string;
  claimant_name: string;
  claim_status: string;
  expires_at: string;
  /** D2: the sibling profile a merge_approve link is bound to (else null). */
  duplicate_id: string | null;
  /** D2: that sibling's name ("" when none / unknown). */
  duplicate_name: string;
}

export type InspectClaimActionResult =
  | { state: "valid"; ctx: ClaimActionContext }
  | { state: "unavailable" }          // no secret configured
  | { state: "invalid" }              // bad/forged/unknown — reveals nothing
  | { state: "used"; action: ClaimAction }
  | { state: "expired" }
  | { state: "wrong_state"; ctx: ClaimActionContext }; // claim no longer fits the action

/** Reads only — never writes. */
export function inspectClaimActionToken(token: unknown, opts: { now?: Date; db?: Db } = {}): InspectClaimActionResult {
  const secret = claimActionSecret();
  if (!secret) return { state: "unavailable" };
  const p = parseToken(secret, token);
  if (!p) return { state: "invalid" };
  const db = opts.db ?? getDb();
  const linkHash = nonceHash(p.n);
  const row = db.prepare(
    "SELECT id, claim_id, action, expires_at, used_at, duplicate_id FROM claim_action_links WHERE nonce_hash = ?"
  ).get(linkHash) as { id: string; claim_id: string; action: string; expires_at: string; used_at: string | null; duplicate_id: string | null } | undefined;
  if (!row || row.claim_id !== p.c || row.action !== p.a) return { state: "invalid" };
  // D2: the signed sibling id and the stored one must agree (both absent
  // for every action but merge_approve).
  const duplicateId = p.d ?? null;
  if ((row.duplicate_id ?? null) !== duplicateId) return { state: "invalid" };
  if (row.used_at) return { state: "used", action: p.a };
  const now = opts.now ?? new Date();
  if (now.getTime() >= p.x * 1000) return { state: "expired" };
  const claim = db.prepare(
    `SELECT c.id, c.agent_id, c.status, c.claimant_name, a.name FROM agent_claims c JOIN agents a ON a.id = c.agent_id WHERE c.id = ?`
  ).get(p.c) as { id: string; agent_id: string; status: string; claimant_name: string | null; name: string | null } | undefined;
  if (!claim) return { state: "invalid" };
  const duplicateName = duplicateId === null ? "" : String(
    (db.prepare("SELECT name FROM agents WHERE id = ?").get(duplicateId) as { name: string | null } | undefined)?.name || "",
  );
  const ctx: ClaimActionContext = {
    link_id: row.id,
    claim_id: claim.id,
    action: p.a,
    agent_id: claim.agent_id,
    agent_name: String(claim.name || ""),
    claimant_name: String(claim.claimant_name || ""),
    claim_status: String(claim.status || ""),
    expires_at: row.expires_at,
    duplicate_id: duplicateId,
    duplicate_name: duplicateName,
  };
  if (claim.status !== REQUIRED_STATUS[p.a]) return { state: "wrong_state", ctx };
  return { state: "valid", ctx };
}

// ─── Redemption (one click) ─────────────────────────────────────────────────

export type RedeemClaimActionResult =
  | {
      state: "done";
      action: ClaimAction;
      claim_id: string;
      agent_id: string;
      agent_name: string;
      /** Set for approve: the caller sends the login mail to this address. */
      approved?: { agentId: string; email: string; isVerified: boolean };
    }
  | Exclude<InspectClaimActionResult, { state: "valid" }>;

class DecisionRefused extends Error {}

export function redeemClaimActionLink(token: unknown, opts: { now?: Date; db?: Db } = {}): RedeemClaimActionResult {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date();
  let refusedCtx: ClaimActionContext | null = null;
  const run = db.transaction((): RedeemClaimActionResult => {
    const check = inspectClaimActionToken(token, { now, db });
    if (check.state !== "valid") return check;
    const { ctx } = check;
    // B3a: request_more sends a mail and is redeemed by
    // services/claim-request-more.ts; never here, and the link is not used up.
    // D2: merge_approve likewise (services/claim-merge-approve.ts).
    if (ctx.action === "request_more" || ctx.action === "merge_approve") return { state: "wrong_state", ctx };

    // Single-use guard: only the first conditional UPDATE wins.
    const claimed = db.prepare(
      "UPDATE claim_action_links SET used_at = ? WHERE id = ? AND used_at IS NULL"
    ).run(now.toISOString(), ctx.link_id);
    if (claimed.changes !== 1) return { state: "used", action: ctx.action };

    let result: string;
    let approved: { agentId: string; email: string; isVerified: boolean } | undefined;
    if (ctx.action === "approve") {
      const r = applyClaimApprove(ctx.claim_id);
      if (!r.ok) { refusedCtx = ctx; throw new DecisionRefused(r.error); }
      approved = { agentId: r.agentId, email: r.email, isVerified: r.isVerified };
      result = "approved";
    } else if (ctx.action === "reject") {
      const r = applyClaimReject(ctx.claim_id);
      if (!r.ok) { refusedCtx = ctx; throw new DecisionRefused(r.error); }
      result = "rejected";
    } else {
      const r = applyClaimRevoke(ctx.claim_id);
      if (!r.ok) { refusedCtx = ctx; throw new DecisionRefused(r.error); }
      result = `revoked:${r.restored}`;
    }
    db.prepare("UPDATE claim_action_links SET used_result = ? WHERE id = ?").run(result, ctx.link_id);
    return { state: "done", action: ctx.action, claim_id: ctx.claim_id, agent_id: ctx.agent_id, agent_name: ctx.agent_name, approved };
  });
  try {
    return run();
  } catch (err) {
    // The decision refused after the link row was marked: the transaction
    // rolled back, so the link is not used up and nothing was written.
    if (err instanceof DecisionRefused && refusedCtx) return { state: "wrong_state", ctx: refusedCtx };
    throw err;
  }
}
