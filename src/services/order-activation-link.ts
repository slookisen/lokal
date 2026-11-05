// ─── Order activation link (RFB «aktiveringslenke») ─────────────────────────
// dev-request 2026-10-21 live-go handlevogn-pilot og første handel, skive 2
// (AC8: «Aktiveringslenken virker én gang. Andre gang gir en forklarende side,
// og en utløpt lenke gir 410. Bruk setter eierskap, opt-in og en
// innloggingsøkt.»).
//
// Admin generates a signed one-time link per producer
// (POST /admin/orders/activation-link). The producer opens it, ticks «Jeg
// representerer …» and submits once; that sets ownership (fill-only), turns on
// order notifications and opens an owner-portal session. The fleet never sends
// the link — it is only returned to admin.
//
// Token:  v1.<payload>.<sig>
//   payload = base64url(JSON {a: agent_id, e: email binding, x: expiry (unix s),
//             n: 16 random bytes base64url})
//   sig     = base64url(HMAC-SHA256(secret, "rfb-order-activation:v1:" + payload))
//   e       = base64url(HMAC-SHA256(secret, "rfb-order-activation:email:v1:" +
//             lower(trim(agent_knowledge.email)))) — the registered address at
//             generation time. Keyed, so the link does not carry a guessable
//             hash of the address.
// Secret: ORDER_ACTIVATION_LINK_SECRET (min. 32 chars). No fallback key: when
// unset, generation fails closed (503) and every link reads as unavailable.
// Rotating the secret invalidates every outstanding link (rollback lever).
//
// Server side: order_activation_links row keyed by sha256(nonce). A link is
// valid only while that row exists, is unused, the expiry has not passed and
// the agent's CURRENT registered address still matches the binding. Use is
// a conditional UPDATE … WHERE used_at IS NULL inside one transaction with
// the ownership/opt-in/session writes, so a double submit succeeds once.
//
// Session: the existing owner-portal mechanism — a magic_links row with
// used = 1 (the shape verifyOwnerSession() in routes/owner-portal.ts reads)
// and the rfb_owner_session cookie set by the route. main has no exported
// session-issuing helper, so the row is written here in the same shape as
// /magic-link-verify leaves it; the id prefix "mlsess_" matches the session
// rows of the unified-login work so they stay out of the e-mail rate limit.

import crypto from "crypto";
import { getDb } from "../database/init";

export const ORDER_ACTIVATION_SECRET_ENV = "ORDER_ACTIVATION_LINK_SECRET";
export const ORDER_ACTIVATION_SECRET_MIN_LENGTH = 32;
export const ORDER_ACTIVATION_VALID_DAYS = 14;
export const ORDER_ACTIVATION_PATH = "/aktiver-bestillinger";
export const ORDER_ACTIVATION_BASE_URL = "https://rettfrabonden.com";
export const ORDER_ACTIVATION_CLAIMED_VIA = "activation_link";
/** Same lifetime as an e-mailed owner magic link (owner-portal MAGIC_LINK_VALID_HOURS). */
export const OWNER_SESSION_VALID_MS = 7 * 24 * 60 * 60 * 1000;
const OWNER_SESSION_ID_PREFIX = "mlsess_";

const TOKEN_VERSION = "v1";
const SIG_CONTEXT = "rfb-order-activation:v1:";
const EMAIL_CONTEXT = "rfb-order-activation:email:v1:";
const IP_CONTEXT = "rfb-order-activation:ip:v1:";
const MAX_TOKEN_LENGTH = 1024;

type Db = ReturnType<typeof getDb>;

/** The signing secret, or null when unset/too short (callers fail closed). */
export function activationSecret(): string | null {
  const s = process.env[ORDER_ACTIVATION_SECRET_ENV];
  if (!s || s.length < ORDER_ACTIVATION_SECRET_MIN_LENGTH) return null;
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmac(secret: string, data: string): Buffer {
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest();
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailBinding(secret: string, email: string): string {
  return b64url(hmac(secret, EMAIL_CONTEXT + normaliseEmail(email)));
}

function nonceId(nonce: string): string {
  return crypto.createHash("sha256").update(nonce, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

interface TokenPayload { a: string; e: string; x: number; n: string }

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
    if (typeof p.a !== "string" || !p.a) return null;
    if (typeof p.e !== "string" || !p.e) return null;
    if (typeof p.x !== "number" || !Number.isFinite(p.x)) return null;
    if (typeof p.n !== "string" || p.n.length < 16) return null;
    return { a: p.a, e: p.e, x: p.x, n: p.n };
  } catch {
    return null;
  }
}

/** Short, non-reversible label for logs (never the token itself). Lives in
 *  src/utils/log-label.ts; re-exported here so existing imports keep working. */
export { tokenLogLabel } from "../utils/log-label";

// ─── Generation (admin) ─────────────────────────────────────────────────────

export type CreateActivationLinkResult =
  | { ok: true; url: string; token: string; link_id: string; agent_id: string; name: string; address: string; expires_at: string }
  | { ok: false; reason: "secret_missing" | "agent_not_found" | "no_registered_email" | "self_registered_profile" };

export function createActivationLink(
  agentId: string,
  opts: { now?: Date; db?: Db } = {},
): CreateActivationLinkResult {
  const secret = activationSecret();
  if (!secret) return { ok: false, reason: "secret_missing" };
  const db = opts.db ?? getDb();
  const agent = db.prepare("SELECT id, name, origin FROM agents WHERE id = ?").get(agentId) as
    { id: string; name: string; origin: string | null } | undefined;
  if (!agent) return { ok: false, reason: "agent_not_found" };
  // Quarantine gate 2 (dev-request 2026-08-03-mikhailo-quarantine-gates): a
  // self-registered row's address was chosen by the registrant, so a link to
  // it is no ownership evidence. Fail closed; such profiles go through review.
  if (agent.origin === "self_registered") return { ok: false, reason: "self_registered_profile" };
  const k = db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?").get(agentId) as
    { email: string | null } | undefined;
  const address = (k?.email || "").trim();
  if (!address || !address.includes("@")) return { ok: false, reason: "no_registered_email" };

  const now = opts.now ?? new Date();
  const expiresMs = now.getTime() + ORDER_ACTIVATION_VALID_DAYS * 24 * 60 * 60 * 1000;
  const nonce = b64url(crypto.randomBytes(16));
  const e = emailBinding(secret, address);
  const payloadB64 = b64url(Buffer.from(JSON.stringify({ a: agent.id, e, x: Math.floor(expiresMs / 1000), n: nonce }), "utf8"));
  const token = `${TOKEN_VERSION}.${payloadB64}.${b64url(hmac(secret, SIG_CONTEXT + payloadB64))}`;
  const linkId = nonceId(nonce);
  const expiresAt = new Date(Math.floor(expiresMs / 1000) * 1000).toISOString();
  db.prepare(
    `INSERT INTO order_activation_links (id, agent_id, email_hash, created_at, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'admin')`
  ).run(linkId, agent.id, e, now.toISOString(), expiresAt);
  return {
    ok: true,
    url: `${ORDER_ACTIVATION_BASE_URL}${ORDER_ACTIVATION_PATH}?t=${encodeURIComponent(token)}`,
    token,
    link_id: linkId,
    agent_id: agent.id,
    name: String(agent.name || ""),
    address,
    expires_at: expiresAt,
  };
}

// ─── Inspection (landing page) ──────────────────────────────────────────────

export interface ActivationContext {
  link_id: string;
  agent_id: string;
  name: string;
  address: string;
  is_verified: boolean;
}

export type InspectResult =
  | { state: "valid"; ctx: ActivationContext }
  | { state: "unavailable" }          // no secret configured
  | { state: "invalid" }              // bad/forged/unknown — reveals nothing
  | { state: "used"; agent_id: string }
  | { state: "expired" }
  | { state: "address_changed" };

export function inspectActivationToken(token: unknown, opts: { now?: Date; db?: Db } = {}): InspectResult {
  const secret = activationSecret();
  if (!secret) return { state: "unavailable" };
  const p = parseToken(secret, token);
  if (!p) return { state: "invalid" };
  const db = opts.db ?? getDb();
  const linkId = nonceId(p.n);
  const row = db.prepare(
    "SELECT id, agent_id, email_hash, used_at FROM order_activation_links WHERE id = ?"
  ).get(linkId) as { id: string; agent_id: string; email_hash: string; used_at: string | null } | undefined;
  if (!row || row.agent_id !== p.a || !safeEqual(row.email_hash, p.e)) return { state: "invalid" };
  if (row.used_at) return { state: "used", agent_id: row.agent_id };
  const now = opts.now ?? new Date();
  if (now.getTime() >= p.x * 1000) return { state: "expired" };
  const agent = db.prepare("SELECT id, name, is_verified FROM agents WHERE id = ?").get(p.a) as
    { id: string; name: string; is_verified: number | null } | undefined;
  if (!agent) return { state: "invalid" };
  const k = db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?").get(p.a) as
    { email: string | null } | undefined;
  const address = (k?.email || "").trim();
  if (!address || !safeEqual(emailBinding(secret, address), p.e)) return { state: "address_changed" };
  return {
    state: "valid",
    ctx: { link_id: linkId, agent_id: agent.id, name: String(agent.name || ""), address, is_verified: agent.is_verified === 1 },
  };
}

// ─── Redemption (one click) ─────────────────────────────────────────────────

export type RedeemResult =
  | { state: "redeemed"; agent_id: string; session_token: string; outcome: "claimed" | "opt_in_only" }
  | Exclude<InspectResult, { state: "valid" }>;

export function redeemActivationLink(
  token: unknown,
  meta: { ip?: string; userAgent?: string } = {},
  opts: { now?: Date; db?: Db } = {},
): RedeemResult {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date();
  const run = db.transaction((): RedeemResult => {
    const check = inspectActivationToken(token, { now, db });
    if (check.state !== "valid") return check;
    const { ctx } = check;
    const secret = activationSecret() as string; // valid ⇒ set
    const nowIso = now.toISOString();
    const ipHash = meta.ip ? b64url(hmac(secret, IP_CONTEXT + meta.ip)).slice(0, 16) : null;
    const ua = meta.userAgent ? String(meta.userAgent).slice(0, 200) : null;

    // Single-use guard: only the first conditional UPDATE wins.
    const claim = db.prepare(
      `UPDATE order_activation_links
          SET used_at = ?, used_ip_hash = ?, used_user_agent = ?
        WHERE id = ? AND used_at IS NULL`
    ).run(nowIso, ipHash, ua, ctx.link_id);
    if (claim.changes !== 1) return { state: "used", agent_id: ctx.agent_id };

    const before = db.prepare(
      "SELECT is_verified, claimed_at, claimed_via, order_notifications_opt_in FROM agents WHERE id = ?"
    ).get(ctx.agent_id) as { is_verified: number | null; claimed_at: string | null; claimed_via: string | null; order_notifications_opt_in: number | null };

    let outcome: "claimed" | "opt_in_only";
    if (before.is_verified === 1) {
      // Segment A: ownership already set — only the opt-in changes.
      outcome = "opt_in_only";
      db.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = ?").run(ctx.agent_id);
    } else {
      outcome = "claimed";
      // Fill-only: an existing claimed_at/claimed_via is never overwritten
      // (SET expressions see the OLD row values).
      db.prepare(
        `UPDATE agents
            SET is_verified = 1,
                claimed_at = COALESCE(claimed_at, ?),
                claimed_via = CASE WHEN claimed_at IS NULL THEN COALESCE(claimed_via, ?) ELSE claimed_via END,
                order_notifications_opt_in = 1
          WHERE id = ?`
      ).run(nowIso, ORDER_ACTIVATION_CLAIMED_VIA, ctx.agent_id);
    }
    const after = db.prepare(
      "SELECT is_verified, claimed_at, claimed_via, order_notifications_opt_in FROM agents WHERE id = ?"
    ).get(ctx.agent_id) as typeof before;

    // Audit: one agent_knowledge_audit row per field that actually changed.
    const audit = db.prepare(
      `INSERT INTO agent_knowledge_audit (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, ?, ?, ?, 'owner', ?, ?, ?)`
    );
    const note = `order-activation-link:${ctx.link_id.slice(0, 16)} (${outcome})`;
    for (const f of ["is_verified", "claimed_at", "claimed_via", "order_notifications_opt_in"] as const) {
      const o = before[f] === null || before[f] === undefined ? null : String(before[f]);
      const n = after[f] === null || after[f] === undefined ? null : String(after[f]);
      if (o !== n) audit.run(`aud_${crypto.randomBytes(8).toString("hex")}`, ctx.agent_id, f, o, n, ctx.address, nowIso, note);
    }

    // Owner-portal session: the magic_links shape verifyOwnerSession() reads.
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const sessionId = `${OWNER_SESSION_ID_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
    db.prepare(
      `INSERT INTO magic_links (id, email, token, agent_id, used, used_at, created_at, expires_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(sessionId, ctx.address, sessionToken, ctx.agent_id, nowIso, nowIso,
      new Date(now.getTime() + OWNER_SESSION_VALID_MS).toISOString());

    db.prepare(
      "UPDATE order_activation_links SET used_outcome = ?, session_link_id = ? WHERE id = ?"
    ).run(outcome, sessionId, ctx.link_id);

    return { state: "redeemed", agent_id: ctx.agent_id, session_token: sessionToken, outcome };
  });
  return run();
}
