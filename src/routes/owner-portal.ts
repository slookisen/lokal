import express, { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { emailService } from "../services/email-service";
import { slugify } from "../utils/slug";
import { getOwnerStats } from "../services/owner-stats-service";
import { looksLikeCodeArtifact } from "../services/description-quality";
import {
  listOwnerTranslations,
  setOwnerTranslation,
  clearOwnerTranslation,
  TRANSLATION_TARGET_LANGS,
  PROFILE_TRANSLATION_FIELDS,
  type TranslationTargetLang,
} from "../services/profile-translations";
import crypto from "crypto";
import { tokenLogLabel, emailLogLabel } from "../utils/log-label";
import { productImportOutreachEnabled } from "../services/product-import/outreach-prepare";
import { OUTREACH_RETURN_COOKIE, outreachReturnPathFor } from "../services/product-import/outreach-landing";
import { getProducerPaymentStatus } from "../services/payment-service";
import { isOverridableCsLock, csLockNote } from "../services/owner-cs-lock";
import { customerRuleSql } from "../services/customer-rule";
import { getSupplyGraphStaleDays } from "../services/supply-graph";
import { writeOrderNotificationsOptInWithAudit } from "../services/order-opt-in";
import { isSubjectAllowedForOwnerFeatures } from "../owner-features/allowlist";
import { ownerPauseEnabled, isOwnerPaused, readOwnerPauseRow } from "../services/agent-visibility";
import { isBlocked, normalizeEmail } from "../services/blocklist-service";
import { rateLimit } from "express-rate-limit";
import {
  isCrossSiteWrite, writeGuardRefusedBody, WRITE_GUARD_REFUSED_TITLE, WRITE_GUARD_CONTACT_RFB,
} from "../middleware/same-origin-write";
import { ownerOrdersEntryCardHtml } from "./owner-orders-view";
import { paymentPortalAlert, renderPaymentCard, shouldRenderPaymentCard } from "./owner-payment-card";
import {
  ownerOrderabilityPortalEnabledFor, listOwnerProductOrderability, confirmOwnerProductInStock,
  confirmAllOwnerProductsInStock, addOwnerProduct, orderabilityReasonTextNb, formatOwnerDate,
  OWNER_PRODUCT_FIELD_TEXT_NB, type OwnerOrderabilityOverview, type OwnerProductField,
} from "../services/owner-orderability";
import {
  stockCheckOn, soonExpiringItems, confirmStockCheckItems, formatStockCheckDate, type StockCheckItem,
} from "../services/stock-check-reminder";
import {
  getOwnerImportOverview, productImportEnabled, profileWebsite, OWNER_FETCH_BUSY_MESSAGE, OWNER_FETCH_DAILY_LIMIT_MESSAGE,
  OWNER_FETCH_RUNNING_MESSAGE, OWNER_IMPORT_NO_WEBSITE_MESSAGE,
} from "../services/product-import/owner-import";

const router = Router();

// ─────────────────────────────────────────────────────────────────
// OWNER PORTAL: Phase 5.4a Backend (M1)
// ─────────────────────────────────────────────────────────────────
// Endpoints for food producers to claim and manage their agent profiles.
// Auth: Magic links only (email-based, no phone or extra codes).
// Curated fields: locked from day 1. Only owner + Daniel can unlock.
//
// Features:
//   - POST /api/agents/:id/request-magic-link → Email link sent
//   - GET /magic-link-verify?token=:token → HttpOnly cookie + redirect
//   - POST /api/agents/:id/update-profile → Whitelist update + audit log
//   - GET /api/agents/:id/profile → Session-aware read (shows lock status)
//   - GET /admin/agent-audit → Daniel-only audit trail
//   - GET  /api/agents/:id/translations?lang= → owner sees their English/Swedish
//   - POST /api/agents/:id/translations → owner writes their own English/Swedish
//   - DELETE /api/agents/:id/translations → hand the field back to the pipeline

// ─────────────────────────────────────────────────────────────────
// Constants & Helpers
// ─────────────────────────────────────────────────────────────────

const MAGIC_LINK_VALID_HOURS = 7 * 24; // 7 days

// expires_at is written as an ISO-8601 string (Date#toISOString(), e.g.
// "2026-10-25T13:20:00.000Z" — see the INSERTs below and knowledge-service
// createMagicLink), while datetime('now') is SQLite's native
// "2026-10-25 16:41:17". A bare TEXT comparison of the two is wrong: on the
// expiry day 'T' (0x54) > ' ' (0x20), so an expired token stayed valid until
// the end of that UTC day. datetime(expires_at) normalises BOTH formats (the
// ISO rows and the native-format rows some tests/legacy writers use), same
// fix as the rate-limit query below. dev-request
// 2026-10-22-rfb-mine-valg-eierbrytere S1b punkt 5. Pure bug fix → unflagged.
const OWNER_TOKEN_NOT_EXPIRED_SQL = "datetime(expires_at) > datetime('now')";
const RATE_LIMIT_WINDOW_HOURS = 1;
const RATE_LIMIT_MAX_PER_WINDOW = 3;

// Whitelist of fields owners are allowed to update
const EDITABLE_FIELDS = [
  "email",
  "phone",
  "address",
  "postal_code",
  "website",
  "opening_hours",
  "description", // Maps to DB field "about"
];

// Read-only fields — never updated by owner
const READ_ONLY_FIELDS = [
  "googleRating",
  "google_rating",
  "googleReviewCount",
  "google_review_count",
  "tripadvisorRating",
  "tripadvisor_rating",
  "views_count",
  "ai_conversations_count",
];

interface SessionData {
  agentId: string;
  email: string;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────
// POST /api/agents/:id/request-magic-link
// ─────────────────────────────────────────────────────────────────
// 1. Validate email matches agent's registered email (case-insensitive)
// 2. Rate-limit: max 3 requests per hour
// 3. Generate secure token
// 4. Store in magic_links table
// 5. Send email with verify link
// 6. Return success message

router.post("/api/agents/:id/request-magic-link", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { email } = req.body;

    console.log(`[owner-portal] POST request-magic-link for agent ${id}, email: ${emailLogLabel(email)}`);

    // Validate input
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({
        success: false,
        error: "invalid_email",
        message: "Vennligst oppgi en gyldig e-postadresse.",
      });
    }

    const db = getDb();

    // 1. Check if email matches agent's registered email + load agent name
    const agentKnowledge = db
      .prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?")
      .get(id) as any;
    const agentRow = db
      .prepare("SELECT name FROM agents WHERE id = ?")
      .get(id) as any;

    if (
      !agentKnowledge ||
      !agentKnowledge.email ||
      agentKnowledge.email.toLowerCase() !== email.toLowerCase()
    ) {
      console.log(
        `[owner-portal] Email mismatch for ${id}: provided=${emailLogLabel(email)}, registered=${emailLogLabel(agentKnowledge?.email)}`
      );
      return res.status(404).json({
        success: false,
        error: "email_not_associated",
        message: "Den e-posten er ikke registrert for denne produsenten.",
      });
    }

    const agentName: string = (agentRow && agentRow.name) ? String(agentRow.name) : "din profil";

    // 2. Rate-limit check
    // created_at is stored as an ISO-8601 string (now.toISOString(), e.g.
    // "2026-08-06T13:20:00.000Z" — see the INSERT below), while
    // datetime('now', ...) produces SQLite's own native format (e.g.
    // "2026-08-06 16:41:17", space separator, no milliseconds/Z). Both
    // columns are TEXT, so comparing created_at directly against
    // datetime('now', ...) is a plain string comparison: the date prefixes
    // match but 'T' (0x54) > ' ' (0x20), so EVERY link from the current UTC
    // calendar day sorted as ">= now - 1h" regardless of actual time — the
    // rate limit degraded to "3 per UTC day" instead of "3 per rolling
    // hour". Wrapping created_at in datetime() too routes BOTH sides
    // through SQLite's own date normalization (verified empirically
    // against both the legacy ISO-with-milliseconds-and-Z format already
    // in the table and SQLite's native format — no data migration needed,
    // old rows are handled correctly as-is).
    const recentCount = db
      .prepare(
        `SELECT COUNT(*) as count FROM magic_links
         WHERE agent_id = ? AND datetime(created_at) >= datetime('now', '-' || ? || ' hours')
           AND id NOT LIKE '${OWNER_SESSION_ID_PREFIX}%' AND id NOT LIKE '${OWNER_BRIDGE_ID_PREFIX}%'`
      )
      .get(id, RATE_LIMIT_WINDOW_HOURS) as any;

    if (recentCount.count >= RATE_LIMIT_MAX_PER_WINDOW) {
      console.log(
        `[owner-portal] Rate limited for ${id}: ${recentCount.count} requests in last hour`
      );
      return res.status(429).json({
        success: false,
        error: "rate_limited",
        message: "For mange innloggingsforsøk. Prøv igjen senere.",
      });
    }

    // 3. Generate secure token
    const token = crypto.randomBytes(32).toString("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + MAGIC_LINK_VALID_HOURS * 60 * 60 * 1000);

    // 4. Insert into magic_links
    const linkId = `ml_${crypto.randomBytes(8).toString("hex")}`;
    db.prepare(
      `INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    ).run(linkId, email, token, id, now.toISOString(), expiresAt.toISOString());

    console.log(`[owner-portal] Created magic link ${linkId} for ${id}`);

    // 5. Send email — agent-name aware template per Phase 5.4a M2 spec B2
    const verifyUrl = `https://rettfrabonden.com/magic-link-verify?token=${token}`;
    const emailResult = await emailService.sendOwnerMagicLink({
      to: email,
      agentName,
      verifyUrl,
    });

    if (!emailResult.success) {
      console.error(`[owner-portal] Failed to send magic link email to ${emailLogLabel(email)}`);
      return res.status(500).json({
        success: false,
        error: "email_send_failed",
        message: "Kunne ikke sende e-post. Prøv igjen senere.",
      });
    }

    // 6. Success
    console.log(`[owner-portal] Magic link sent to ${emailLogLabel(email)}`);
    return res.json({
      success: true,
      message: "Sjekk e-posten din for innloggings-link.",
    });
  } catch (error) {
    console.error("[owner-portal] Error in request-magic-link:", error);
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: "En feil oppstod. Prøv igjen senere.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /magic-link-verify?token=:token
// ─────────────────────────────────────────────────────────────────
// 1. Validate token is valid and not expired
// 2. Mark token as used
// 3. Set HttpOnly session cookie
// 4. Redirect to edit page

router.get("/magic-link-verify", (req: Request, res: Response) => {
  try {
    const { token } = req.query;

    // Never log the token itself: it becomes the 7-day rfb_owner_session
    // cookie and is accepted as a Bearer token (T1, eierportal bølge 0).
    console.log(`[owner-portal] GET magic-link-verify, token=${tokenLogLabel(token)}`);

    if (!token || typeof token !== "string") {
      // FIX 2026-05-10: /min-profil/feil does not exist. Send user to a usable page.
      return res.redirect(302, "/?error=invalid_token");
    }

    const db = getDb();

    // 1. Validate token
    const magicLink = db
      .prepare(
        `SELECT * FROM magic_links
         WHERE token = ? AND ${OWNER_TOKEN_NOT_EXPIRED_SQL}`
      )
      .get(token) as any;

    if (!magicLink) {
      console.log(`[owner-portal] Invalid or expired token: ${tokenLogLabel(token)}`);
      // FIX 2026-05-10: /min-profil/feil does not exist; send user to a usable page.
      return res.redirect(302, "/?error=invalid_token");
    }

    const agentId = magicLink.agent_id;

    // 2. Mark as used
    db.prepare(
      `UPDATE magic_links SET used = 1, used_at = datetime('now') WHERE token = ?`
    ).run(token);

    // 3. Set HttpOnly cookie
    res.cookie("rfb_owner_session", token, {
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });

    // Skive 3b-2 (PRODUCT_IMPORT_OUTREACH_ENABLED): back to the outreach
    // landing page the owner came from (rfb_owner_return cookie), only when it
    // is exactly that page for THIS agent.
    const outreachBack = productImportOutreachEnabled()
      ? outreachReturnPathFor(req.headers.cookie as string | undefined, (req as any).cookies, String(agentId))
      : null;
    if (outreachBack) {
      res.clearCookie(OUTREACH_RETURN_COOKIE, { path: "/" });
      console.log(`[owner-portal] Magic link verified for ${agentId}, returning to the product suggestions page`);
      return res.redirect(302, outreachBack);
    }

    // 4. Redirect to authenticated portal page (per Phase 5.4a M2 spec B3)
    console.log(`[owner-portal] Magic link verified for ${agentId}, redirecting to /eier/${agentId}/portal`);
    return res.redirect(302, `/eier/${agentId}/portal`);
  } catch (error) {
    console.error("[owner-portal] Error in magic-link-verify:", error);
    // FIX 2026-05-10: /min-profil/feil does not exist; send user to a usable page.
    return res.redirect(302, "/?error=verify_failed");
  }
});

// ─────────────────────────────────────────────────────────────────
// Middleware: Verify magic link session or Bearer token
// ─────────────────────────────────────────────────────────────────

/**
 * Parse the raw `Cookie` request header into a name→value map. Used as a
 * fallback when `cookie-parser` middleware is not mounted (we deliberately
 * don't add new deps in M2). Values are decoded with `decodeURIComponent`
 * to match cookie-parser semantics.
 */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function readSessionCookie(req: Request): string | undefined {
  const fromMiddleware = (req as any).cookies?.rfb_owner_session as string | undefined;
  if (fromMiddleware) return fromMiddleware;
  const parsed = parseCookieHeader(req.headers.cookie as string | undefined);
  return parsed.rfb_owner_session;
}

export function verifyOwnerSession(req: Request): { valid: boolean; agentId?: string; token?: string } {
  // Try cookie first
  const cookieToken = readSessionCookie(req);
  if (cookieToken) {
    const db = getDb();
    const link = db
      .prepare(
        `SELECT agent_id FROM magic_links
         WHERE token = ? AND used = 1 AND ${OWNER_TOKEN_NOT_EXPIRED_SQL}`
      )
      .get(cookieToken) as any;
    if (link) {
      return { valid: true, agentId: link.agent_id, token: cookieToken };
    }
  }

  // Try Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const db = getDb();
    const link = db
      .prepare(
        `SELECT agent_id FROM magic_links
         WHERE token = ? AND used = 1 AND ${OWNER_TOKEN_NOT_EXPIRED_SQL}`
      )
      .get(token) as any;
    if (link) {
      return { valid: true, agentId: link.agent_id, token };
    }
  }

  return { valid: false };
}

// ─────────────────────────────────────────────────────────────────
// S1b punkt 5 — one owner login (dev-request 2026-10-22-rfb-mine-valg-eierbrytere)
// ─────────────────────────────────────────────────────────────────
// Two env flags, both read at call time ("1"/"true" = on), both DEFAULT OFF so
// prod behaviour is unchanged until switched on:
//
//   OWNER_VERIFIED_OWNER_GATE_ENABLED — every owner endpoint (this file,
//     owner-orders.ts, payments.ts) requires isVerifiedOwner(agentId, session).
//     Off = today's check (the session belongs to the agent).
//   OWNER_UNIFIED_SESSION_ENABLED — the /selger login (GET
//     /api/marketplace/auth/magic-verify) also opens the /eier session cookie,
//     and the /eier portal gets a «Produkter og åpningstider» button
//     (POST /eier/:id/selger) that logs the same owner into /selger without a
//     new e-mail. One login → profile, products, statistics, orders.
//
// Logout revocation and the expires_at comparison are bug fixes and unflagged.

export const OWNER_VERIFIED_OWNER_GATE_FLAG = "OWNER_VERIFIED_OWNER_GATE_ENABLED";
export const OWNER_UNIFIED_SESSION_FLAG = "OWNER_UNIFIED_SESSION_ENABLED";

function envFlagOn(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true";
}

export function ownerVerifiedOwnerGateEnabled(): boolean {
  return envFlagOn(OWNER_VERIFIED_OWNER_GATE_FLAG);
}

export function ownerUnifiedSessionEnabled(): boolean {
  return envFlagOn(OWNER_UNIFIED_SESSION_FLAG);
}

/**
 * THE ownership predicate for owner endpoints: the session is valid, belongs
 * to exactly this agent, AND the agent has a verified owner by the shared
 * customer rule (customerRuleSql: agents.claimed_at set OR a verified
 * agent_claims row). A session opened by an e-mail match alone (the /eier
 * magic link only checks agent_knowledge.email) on a profile with no verified
 * owner is NOT a verified owner. Self-registered owners (verified claim,
 * is_verified = 0) are verified owners here — the strict is_verified gate for
 * real orders is separate and unchanged.
 */
export function isVerifiedOwner(
  agentIdParam: unknown,
  session: { valid: boolean; agentId?: string } | null | undefined,
): boolean {
  const agentId = typeof agentIdParam === "string" ? agentIdParam : "";
  if (!session || !session.valid || !session.agentId || !agentId) return false;
  if (session.agentId !== agentId) return false;
  const row = getDb()
    .prepare(`SELECT ${customerRuleSql("a")} AS owned FROM agents a WHERE a.id = ?`)
    .get(agentId) as { owned?: number } | undefined;
  return !!row && row.owned === 1;
}

/**
 * Access check every owner endpoint uses after its "no session → 401/login"
 * branch. Gate on: isVerifiedOwner. Gate off: today's check (session agent ===
 * requested agent). false → the caller answers 403.
 */
export function ownerSessionAllows(
  agentIdParam: unknown,
  session: { valid: boolean; agentId?: string } | null | undefined,
): agentIdParam is string {
  const agentId = typeof agentIdParam === "string" ? agentIdParam : "";
  if (ownerVerifiedOwnerGateEnabled()) return isVerifiedOwner(agentId, session);
  return !!session && session.valid && !!session.agentId && session.agentId === agentId;
}

/** 403 body/page text when the session is valid but ownership is not verified. */
export const OWNER_NOT_VERIFIED_MESSAGE =
  "Eierskapet til profilen er ikke bekreftet. Bekreft eierskap først.";

function ownerForbiddenJson(agentId: unknown, session: { valid: boolean; agentId?: string }) {
  const sameAgent = session.agentId === agentId;
  return sameAgent
    ? { success: false, error: "ownership_not_verified", message: OWNER_NOT_VERIFIED_MESSAGE }
    : { success: false, error: "forbidden", message: "Du har ikke tilgang til denne agenten." };
}

// magic_links rows that are sessions / one-time bridges, not e-mailed links.
// Kept out of the request-magic-link rate limit (that limit counts e-mails).
const OWNER_SESSION_ID_PREFIX = "mlsess_";
const OWNER_BRIDGE_ID_PREFIX = "mlbridge_";
const OWNER_SESSION_VALID_MS = MAGIC_LINK_VALID_HOURS * 60 * 60 * 1000;
const OWNER_BRIDGE_VALID_MS = 15 * 60 * 1000; // same as knowledge-service createMagicLink

function setOwnerSessionCookie(res: Response, token: string): void {
  res.cookie("rfb_owner_session", token, {
    path: "/",
    maxAge: OWNER_SESSION_VALID_MS,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });
}

/**
 * OWNER_UNIFIED_SESSION_ENABLED: called by the /selger login after a verified
 * claimant redeemed their magic link. Opens the /eier session (a fresh
 * magic_links row, used = 1, ISO timestamps, 7 days) and sets the cookie, so
 * statistics, orders and the /eier portal need no second login. No-op (false)
 * when the flag is off or the request already carries a live session for this
 * agent.
 */
export function issueOwnerSessionForSelgerLogin(
  req: Request,
  res: Response,
  agentId: string,
  email: string,
): boolean {
  if (!ownerUnifiedSessionEnabled() || !agentId || !email) return false;
  const existing = verifyOwnerSession(req);
  if (existing.valid && existing.agentId === agentId) return false;
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OWNER_SESSION_VALID_MS);
  getDb().prepare(
    `INSERT INTO magic_links (id, email, token, agent_id, used, used_at, created_at, expires_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(`${OWNER_SESSION_ID_PREFIX}${crypto.randomBytes(8).toString("hex")}`, email, token, agentId,
    now.toISOString(), now.toISOString(), expiresAt.toISOString());
  setOwnerSessionCookie(res, token);
  console.log(`[owner-portal] unified session opened for ${agentId} from /selger login`);
  return true;
}

/**
 * Logout: make the presented session token unusable server-side (cookie AND
 * Bearer — the cookie value is the same token). Implemented as immediate
 * expiry so no schema change is needed: every reader checks expires_at
 * (verifyOwnerSession, /magic-link-verify, knowledge-service verifyMagicLink).
 */
export function revokeOwnerSessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const past = new Date(Date.now() - 1000).toISOString();
  const info = getDb()
    .prepare(`UPDATE magic_links SET expires_at = ? WHERE token = ?`)
    .run(past, token);
  return info.changes > 0;
}

function presentedOwnerTokens(req: Request): string[] {
  const out: string[] = [];
  const c = readSessionCookie(req);
  if (c) out.push(c);
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) out.push(auth.substring(7));
  return out;
}

// ── T3: lock / audit / write only the fields the owner actually changed ──
// The portal form posts all seven fields on every save, so before this a
// save that changed one field stamped curated_fields by:"owner" (and wrote an
// agent_knowledge_audit row) for all seven — freezing untouched fields
// against enrichment. Same notion of "changed" as the gårdssalg claim
// (services/gardssalg-claim.ts, G1 pkt 2): compare after CRLF→LF + trim, and
// null / "" / whitespace-only are the same "empty". opening_hours has the DB
// default '[]' (database/init.ts), which is also "empty" — never shown to the
// owner as "[]", never "changed" into "", never locked.
function normalizeOwnerProfileValue(dbField: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\r\n?/g, "\n").trim();
  if (s === "") return null;
  if (dbField === "opening_hours" && s === "[]") return null;
  return s;
}

// T0d: agent_knowledge.opening_hours is a JSON column — knowledge-service
// reads it with JSON.parse, and the strict read of its write path threw on
// the raw «Åpningstider» text this portal used to store. The portal now
// stores the owner's text as a JSON string (JSON.stringify(text)), the text
// variant knowledge-service already reads. Older rows hold the raw text;
// both read back as the same text here.
function ownerProfileStoredText(dbField: string, stored: unknown): unknown {
  if (dbField !== "opening_hours" || typeof stored !== "string") return stored;
  try {
    const parsed = JSON.parse(stored);
    return typeof parsed === "string" ? parsed : stored;
  } catch {
    return stored; // a raw-text row from before T0d
  }
}

/** The value the owner wrote, as the column stores it (opening hours as JSON text). */
function ownerProfileStoredValue(dbField: string, value: unknown): unknown {
  if (dbField !== "opening_hours") return value;
  const text = normalizeOwnerProfileValue(dbField, value);
  // Empty stays as it was posted (never locked, never shown as "[]").
  return text === null ? value : JSON.stringify(text);
}

/** The stored value as the portal input shows it ('[]' opening hours → ""). */
function ownerProfileDisplayValue(dbField: string, stored: unknown): string {
  if (stored == null) return "";
  if (dbField === "opening_hours" && normalizeOwnerProfileValue(dbField, stored) === null) return "";
  return String(ownerProfileStoredText(dbField, stored));
}

// ─────────────────────────────────────────────────────────────────
// POST /api/agents/:id/update-profile
// ─────────────────────────────────────────────────────────────────
// 1. Verify session
// 2. Whitelist update fields (strip read-only)
// 3. Check curated_fields locks
// 4. Update database + audit log
// 5. Return updated fields + skipped fields

router.post("/api/agents/:id/update-profile", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sessionData = verifyOwnerSession(req);

    console.log(`[owner-portal] POST update-profile for agent ${id}`);

    if (!sessionData.valid) {
      console.log(`[owner-portal] Session invalid for ${id}`);
      return res.status(401).json({
        success: false,
        error: "session_invalid",
        message: "Din sesjon er utløpt. Logg inn på nytt.",
      });
    }

    if (!ownerSessionAllows(id, sessionData)) {
      console.log(
        `[owner-portal] Session agent ${sessionData.agentId} not allowed for ${id}`
      );
      return res.status(403).json(ownerForbiddenJson(id, sessionData));
    }

    // T0a: same-origin write guard (before this only SameSite=Lax protected
    // it). The portal's fetch() save sends our own Origin; the /eier/:id/save
    // fallback's server-side fetch sends none — both pass.
    if (isCrossSiteWrite(req, "/api/agents/:id/update-profile")) {
      return res.status(403).json({ success: false, error: "cross_site" });
    }

    const db = getDb();

    // 2. Whitelist fields from request body
    const bodyFields: Record<string, any> = {};
    for (const field of EDITABLE_FIELDS) {
      if (field in req.body) {
        bodyFields[field] = req.body[field];
      }
    }

    // Strip any read-only fields
    for (const field of READ_ONLY_FIELDS) {
      delete (req.body as any)[field];
    }

    console.log(
      `[owner-portal] Processing update for ${id}: fields=${Object.keys(bodyFields).join(",")}`
    );

    // Read current state + curated_fields
    const knowledge = db
      .prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?")
      .get(id) as any;

    if (!knowledge) {
      return res.status(404).json({
        success: false,
        error: "agent_not_found",
        message: "Agenten ble ikke funnet.",
      });
    }

    let curatedFields: Record<string, any> = {};
    try {
      curatedFields = knowledge.curated_fields
        ? JSON.parse(knowledge.curated_fields)
        : {};
    } catch (e) {
      console.error(`[owner-portal] Corrupted curated_fields for ${id}, treating as empty:`, e);
      curatedFields = {};
    }

    // 3. Check locks and prepare updates
    const updatedFields: Record<string, any> = {};
    const skippedFields: Array<{ field: string; reason: string }> = [];
    const auditInserts: Array<any> = [];
    let curatedChanged = false;

    for (const field of EDITABLE_FIELDS) {
      if (!(field in bodyFields)) continue; // Skip if not in request

      const newValue = bodyFields[field];
      const dbField = field === "description" ? "about" : field;

      // Check curated_fields lock
      const curatedFieldInfo = curatedFields[dbField] || {};
      // S1a point 4 (OWNER_PORTAL_CS_LOCK_OVERRIDE, default off): a customer-
      // service lock does not stop the owner; the save below stamps by:"owner".
      if (
        curatedFieldInfo.by && curatedFieldInfo.by !== "owner" && curatedFieldInfo.by !== null &&
        !isOverridableCsLock(curatedFieldInfo)
      ) {
        skippedFields.push({
          field,
          reason: `locked_by_${curatedFieldInfo.by}`,
        });
        console.log(
          `[owner-portal] Skipped locked field ${field} (locked by ${curatedFieldInfo.by})`
        );
        continue;
      }

      // dev-request 2026-08-25-agent-knowledge-about-code-artifact-gap:
      // this handler writes the owner-submitted "description" field straight
      // to `agent_knowledge.about` (dbField mapping above) with no content
      // validation — another genuinely unguarded `about` write path found by
      // the repo-wide search this dev-request required. Same detector as the
      // admin-side `about`/`description` gates; skipped (not a hard 400) to
      // match this route's existing per-field skip convention (locked
      // fields above use the same skip-with-reason shape) rather than
      // failing the whole multi-field save over one bad field.
      if (dbField === "about" && typeof newValue === "string" && looksLikeCodeArtifact(newValue)) {
        skippedFields.push({
          field,
          reason: "code_artifact_rejected",
        });
        console.log(`[owner-portal] Skipped field ${field} — looks like a code/script artifact`);
        continue;
      }

      // T3: an unchanged field is a no-op — no write, no audit row, no lock;
      // its existing curated_fields entry (if any) stays exactly as it is.
      // T0d: opening hours compare as text, whether stored as JSON or raw.
      const storedText = ownerProfileStoredText(dbField, (knowledge as any)[dbField]);
      if (normalizeOwnerProfileValue(dbField, newValue) === normalizeOwnerProfileValue(dbField, storedText)) {
        continue;
      }

      const oldValue = storedText || null;
      updatedFields[dbField] = ownerProfileStoredValue(dbField, newValue);

      // Update curated_fields — never for empty opening hours ('' / '[]'):
      // the field goes back to "no hours" and an existing lock is left as is.
      if (!(dbField === "opening_hours" && normalizeOwnerProfileValue(dbField, newValue) === null)) {
        curatedFields[dbField] = {
          locked_at: new Date().toISOString(),
          by: "owner",
        };
        curatedChanged = true;
      }

      // Queue audit record
      auditInserts.push({
        agent_id: id,
        field_name: dbField,
        old_value: oldValue ? String(oldValue) : null,
        new_value: String(newValue),
        changed_by: "owner",
        changed_by_email: knowledge.email,
        changed_at: new Date().toISOString(),
        notes: null,
      });
    }

    // 4. Transaction: update knowledge + curated_fields + audit
    const transaction = db.transaction(() => {
      // Update agent_knowledge with new field values
      const updateFields = Object.keys(updatedFields)
        .map((f) => `${f} = ?`)
        .join(", ");
      const updateValues = Object.values(updatedFields);

      if (updateFields) {
        db.prepare(
          `UPDATE agent_knowledge SET ${updateFields}, updated_at = ? WHERE agent_id = ?`
        ).run(...updateValues, new Date().toISOString(), id);
      }

      // Update curated_fields JSON — only when a lock was added (T3: a save
      // with nothing changed does not touch the row at all).
      if (curatedChanged) {
        db.prepare(
          `UPDATE agent_knowledge SET curated_fields = ?, updated_at = ? WHERE agent_id = ?`
        ).run(JSON.stringify(curatedFields), new Date().toISOString(), id);
      }

      // Insert audit records
      const auditIds: string[] = [];
      for (const audit of auditInserts) {
        const auditId = `audit_${crypto.randomBytes(8).toString("hex")}`;
        db.prepare(
          `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          auditId,
          audit.agent_id,
          audit.field_name,
          audit.old_value,
          audit.new_value,
          audit.changed_by,
          audit.changed_by_email,
          audit.changed_at,
          audit.notes
        );
        auditIds.push(auditId);
      }

      return auditIds;
    });

    const auditIds = transaction();

    console.log(
      `[owner-portal] Updated ${id}: ${Object.keys(updatedFields).length} fields, ${auditIds.length} audit records`
    );

    return res.json({
      success: true,
      updated_fields: Object.keys(updatedFields),
      skipped_fields: skippedFields,
      audit_ids: auditIds,
    });
  } catch (error) {
    console.error("[owner-portal] Error in update-profile:", error);
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: "En feil oppstod. Prøv igjen senere.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/agents/:id/profile
// ─────────────────────────────────────────────────────────────────
// Return agent profile with lock status for each field.
// Only available to authenticated owner session.

router.get("/api/agents/:id/profile", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sessionData = verifyOwnerSession(req);

    console.log(`[owner-portal] GET profile for agent ${id}`);

    if (!sessionData.valid) {
      return res.status(401).json({
        success: false,
        error: "session_invalid",
        message: "Din sesjon er utløpt. Logg inn på nytt.",
      });
    }

    if (!ownerSessionAllows(id, sessionData)) {
      return res.status(403).json(ownerForbiddenJson(id, sessionData));
    }

    const db = getDb();

    const agent = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(id) as any;
    if (agent) (agent as any).slug = slugify(String(agent.name || ""));
    if (!agent) {
      return res.status(404).json({
        success: false,
        error: "agent_not_found",
        message: "Agenten ble ikke funnet.",
      });
    }

    const knowledge = db
      .prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?")
      .get(id) as any;

    if (!knowledge) {
      return res.status(404).json({
        success: false,
        error: "knowledge_not_found",
        message: "Agentens profilinformasjon ble ikke funnet.",
      });
    }

    let curatedFields: Record<string, any> = {};
    try {
      curatedFields = knowledge.curated_fields
        ? JSON.parse(knowledge.curated_fields)
        : {};
    } catch (e) {
      console.error(`[owner-portal] Corrupted curated_fields for ${id}, treating as empty:`, e);
      curatedFields = {};
    }

    // Build response with field metadata
    const fields: Record<string, any> = {};

    for (const field of EDITABLE_FIELDS) {
      const dbField = field === "description" ? "about" : field;
      const value = ownerProfileStoredText(dbField, (knowledge as any)[dbField]) || null;
      const curatedInfo = curatedFields[dbField] || {};

      const csOverride = isOverridableCsLock(curatedInfo);
      fields[field] = {
        value,
        locked_by: curatedInfo.by || null,
        editable:
          !curatedInfo.by || curatedInfo.by === "owner" || curatedInfo.by === null || csOverride,
        ...(csOverride ? { locked_note: csLockNote(curatedInfo) } : {}),
      };
    }

    // Add read-only fields
    for (const field of READ_ONLY_FIELDS) {
      const dbField = field.replace(/([A-Z])/g, "_$1").toLowerCase();
      const value = (knowledge as any)[dbField] || null;

      fields[field] = {
        value,
        locked_by: "system",
        editable: false,
      };
    }

    return res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
      },
      fields,
    });
  } catch (error) {
    console.error("[owner-portal] Error in profile:", error);
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: "En feil oppstod. Prøv igjen senere.",
    });
  }
});


// ─────────────────────────────────────────────────────────────────
// Phase 5.4a M2: server-rendered owner-portal HTML pages
// ─────────────────────────────────────────────────────────────────
// All copy is Norwegian Bokmål. Forms degrade gracefully without JS
// (POST → server-render result page), and progressive JS adds inline
// error handling. Mobile-first; min-tap-target 44px; ARIA labels on
// all form inputs. Style palette mirrors `code-updates/selger.html`
// (forest #2D5016, orange #D4A373, cream #FEFAE0, etc.).

const PORTAL_PALETTE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    background: #FEFAE0;
    color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
  }
  a { color: #2D5016; }
  .ep-shell { max-width: 720px; margin: 0 auto; padding: 24px 16px 80px; }
  .ep-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 24px; }
  .ep-logo { font-size: 1.15rem; font-weight: 700; color: #2D5016; text-decoration: none; }
  .ep-logo span { color: #D4A373; }
  .ep-card { background: #fff; border: 1px solid #e5e5e5; border-radius: 10px; padding: 24px 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  .ep-card h1 { font-size: 1.4rem; color: #2D5016; margin: 0 0 12px; }
  .ep-card h2 { font-size: 1.1rem; color: #2D5016; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid #f0f0e8; }
  .ep-card p { margin: 8px 0; }
  .ep-field { margin-bottom: 16px; }
  .ep-field label { display: block; font-size: 0.92rem; font-weight: 600; color: #404040; margin-bottom: 6px; }
  .ep-field input,
  .ep-field textarea {
    width: 100%;
    min-height: 44px;
    padding: 10px 12px;
    font-size: 1rem;
    font-family: inherit;
    color: #1a1a1a;
    background: #fff;
    border: 1px solid #d4d4d4;
    border-radius: 8px;
  }
  .ep-field textarea { min-height: 96px; resize: vertical; }
  .ep-field input:focus,
  .ep-field textarea:focus { outline: 2px solid #2D5016; outline-offset: 1px; border-color: #2D5016; }
  .ep-field input[disabled],
  .ep-field textarea[disabled] { background: #fafafa; color: #737373; cursor: not-allowed; }
  .ep-field .ep-hint { font-size: 0.78rem; color: #737373; margin-top: 4px; }
  .ep-field .ep-lock { display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem; color: #b45309; margin-top: 4px; }
  .ep-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 10px 20px;
    font-size: 1rem;
    font-weight: 600;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    text-decoration: none;
  }
  .ep-btn-primary { background: #2D5016; color: #fff; }
  .ep-btn-primary:hover, .ep-btn-primary:focus { background: #3a6b1e; }
  .ep-btn-secondary { background: #fff; color: #2D5016; border: 1px solid #2D5016; }
  .ep-btn-secondary:hover { background: #f3f7ee; }
  .ep-btn-ghost { background: transparent; color: #737373; }
  .ep-btn-ghost:hover { color: #dc2626; }
  .ep-alert { padding: 12px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 0.92rem; }
  .ep-alert-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
  .ep-alert-ok { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
  .ep-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .ep-stat { background: #FEFAE0; border: 1px solid #f0e8c8; border-radius: 8px; padding: 12px; text-align: center; }
  .ep-stat-num { font-size: 1.5rem; font-weight: 700; color: #2D5016; }
  .ep-stat-label { font-size: 0.78rem; color: #737373; }
  .ep-audit-list { list-style: none; padding: 0; margin: 0; }
  .ep-audit-item { padding: 10px 0; border-bottom: 1px solid #f0f0e8; font-size: 0.88rem; }
  .ep-audit-item:last-child { border-bottom: none; }
  .ep-audit-meta { color: #737373; font-size: 0.78rem; }
  .ep-form-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
  @media (max-width: 480px) {
    .ep-card { padding: 18px 14px; }
    .ep-card h1 { font-size: 1.25rem; }
  }
`;

/** T0a: the 403 page for a refused owner-portal write (same-origin-write.ts). */
export function portalWriteRefusedPage(backHref: string, backLabel = "Tilbake til eierportalen"): string {
  return portalShell(WRITE_GUARD_REFUSED_TITLE, `<div class="ep-card">${writeGuardRefusedBody({ contact: WRITE_GUARD_CONTACT_RFB, backHref, backLabel })}</div>`);
}

export function portalShell(title: string, body: string, opts: { headHtml?: string } = {}): string {
  return `<!DOCTYPE html>
<html lang="nb">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <link rel="icon" href="/favicon-192.png" sizes="192x192" type="image/png">
  <link rel="icon" href="/favicon-512.png" sizes="512x512" type="image/png">
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#2D5016">
  <script>if('serviceWorker' in navigator&&!/finn-tannlege\.com|opplevagent\.no/.test(location.hostname)){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}</script>
  <script defer src="/install-prompt.js"></script>
  <title>${escapeHtml(title)} — Rett fra Bonden</title>
  <style>${PORTAL_PALETTE_CSS}</style>${opts.headHtml ? `\n  ${opts.headHtml}` : ""}
</head>
<body>
  <div class="ep-shell">
    <div class="ep-topbar">
      <a href="/" class="ep-logo">Rett fra <span>Bonden</span></a>
    </div>
    ${body}
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────
// GET /eier/:agentId — unauthenticated email-entry form (request magic link)
// ─────────────────────────────────────────────────────────────────
router.get("/eier/:agentId", (req: Request, res: Response) => {
  try {
    const agentId = String((req.params as any).agentId || "");
    const db = getDb();
    const agent = db
      .prepare("SELECT id, name FROM agents WHERE id = ?")
      .get(agentId) as any;
    if (agent) (agent as any).slug = slugify(String(agent.name || ""));

    if (!agent) {
      return res.status(404).send(portalShell(
        "Fant ikke produsent",
        `<div class="ep-card">
          <h1>Fant ikke produsent</h1>
          <p>Vi finner ingen produsent med denne lenken. Gå tilbake til <a href="/">forsiden</a> og søk etter produsenten din.</p>
        </div>`
      ));
    }

    const status = String(req.query.status || "");
    const reason = String(req.query.reason || "");
    let alert = "";
    if (status === "sent") {
      alert = `<div class="ep-alert ep-alert-ok" role="status">Vi har sendt deg en innloggingslenke. Sjekk e-posten din (også søppelpost). Lenken er gyldig i 7 dager.</div>`;
    } else if (status === "error") {
      const msg = reason === "rate_limited"
        ? "For mange innloggingsforsøk. Prøv igjen om en time."
        : reason === "email_not_associated"
          ? "Den e-posten er ikke registrert for denne produsenten. Kontakt kontakt@rettfrabonden.com hvis du tror dette er feil."
          : reason === "invalid_email"
            ? "Vennligst oppgi en gyldig e-postadresse."
            : "En feil oppstod. Prøv igjen senere.";
      alert = `<div class="ep-alert ep-alert-error" role="alert">${escapeHtml(msg)}</div>`;
    }

    const slug = (agent.slug || "").toString();
    const back = slug ? `/produsent/${encodeURIComponent(slug)}` : "/";

    const body = `
      <div class="ep-card">
        <h1>Logg inn på eierportalen</h1>
        <p>Skriv inn e-postadressen som er registrert for <strong>${escapeHtml(agent.name)}</strong>. Vi sender deg en innloggingslenke.</p>
        ${alert}
        <form id="ep-magic-form" method="post" action="/eier/${encodeURIComponent(agent.id)}/request" novalidate>
          <div class="ep-field">
            <label for="ep-email">E-postadresse</label>
            <input id="ep-email" name="email" type="email" inputmode="email" autocomplete="email" required aria-required="true" aria-describedby="ep-email-hint" placeholder="post@gardenmin.no">
            <div id="ep-email-hint" class="ep-hint">Bruk e-posten som er registrert for produsenten. Lenken er gyldig i 7 dager.</div>
          </div>
          <div class="ep-form-actions">
            <button type="submit" class="ep-btn ep-btn-primary">Send tilgangslenke</button>
            <a href="${escapeHtml(back)}" class="ep-btn ep-btn-secondary">Tilbake til profilen</a>
          </div>
        </form>
      </div>
      <div class="ep-card">
        <h2>Hjelp og kontakt</h2>
        <p>Vet du ikke hvilken e-post som er registrert? Send en melding til <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a> så hjelper vi deg.</p>
      </div>
      <script>
      (function () {
        var form = document.getElementById("ep-magic-form");
        if (!form) return;
        form.addEventListener("submit", function (ev) {
          if (!window.fetch) return; // fall back to plain POST
          ev.preventDefault();
          var emailEl = document.getElementById("ep-email");
          var email = emailEl && emailEl.value ? String(emailEl.value).trim() : "";
          if (!email || email.indexOf("@") < 0) {
            window.location.href = form.action.replace("/request", "") + "?status=error&reason=invalid_email";
            return;
          }
          var btn = form.querySelector("button[type=submit]");
          if (btn) { btn.disabled = true; btn.textContent = "Sender ..."; }
          fetch("/api/agents/${encodeURIComponent(agent.id)}/request-magic-link", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email }),
          }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
            .then(function (out) {
              var base = "/eier/${encodeURIComponent(agent.id)}";
              if (out.ok && out.body && out.body.success) {
                window.location.href = base + "?status=sent";
              } else {
                var reason = (out.body && out.body.error) || "internal_error";
                window.location.href = base + "?status=error&reason=" + encodeURIComponent(reason);
              }
            }).catch(function () {
              if (btn) { btn.disabled = false; btn.textContent = "Send tilgangslenke"; }
            });
        });
      })();
      </script>
    `;

    return res.send(portalShell("Logg inn", body));
  } catch (err) {
    console.error("[owner-portal] GET /eier/:agentId error:", err);
    return res.status(500).send(portalShell(
      "Feil",
      `<div class="ep-card"><h1>Noe gikk galt</h1><p>Prøv igjen senere.</p></div>`
    ));
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /eier/:agentId/request — graceful-degradation fallback that calls
// the JSON request-magic-link endpoint and re-renders the form with
// status feedback. Lets the form work for users without JS.
// ─────────────────────────────────────────────────────────────────
router.post("/eier/:agentId/request", express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const agentId = String((req.params as any).agentId || "");
  const email = (req.body && (req.body as any).email) ? String((req.body as any).email).trim() : "";
  const base = `/eier/${encodeURIComponent(agentId)}`;
  if (!email || !email.includes("@")) {
    return res.redirect(303, `${base}?status=error&reason=invalid_email`);
  }
  try {
    const url = `${req.protocol}://${req.get("host")}/api/agents/${encodeURIComponent(agentId)}/request-magic-link`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body: any = await resp.json().catch(() => ({}));
    if (resp.ok && body && body.success) {
      return res.redirect(303, `${base}?status=sent`);
    }
    const reason = (body && body.error) || "internal_error";
    return res.redirect(303, `${base}?status=error&reason=${encodeURIComponent(reason)}`);
  } catch (err) {
    console.error("[owner-portal] POST /eier/:agentId/request error:", err);
    return res.redirect(303, `${base}?status=error&reason=internal_error`);
  }
});


// F1 (dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel):
// the «Bestillinger» card. The opt-in switch needs an owner-verified profile
// (agents.is_verified = 1): the real-order gate (cart-service
// isEligibleForRealOrder) requires it, so an unverified profile that switched
// orders on would get a switch that does nothing. Without verification the
// card explains why and links to the ownership claim instead. A profile that
// already has the opt-in on keeps its «turn off» button.
// `extraHtml` (S1b punkt 7, only non-empty with OWNER_ORDER_EMAIL_ENABLED on)
// is appended inside the card; "" keeps the card byte-identical.
export function ordersCardHtml(agent: { id: string; order_notifications_opt_in?: number; is_verified?: number }, extraHtml = ""): string {
  const optIn = agent.order_notifications_opt_in ? 1 : 0;
  const verified = agent.is_verified === 1;
  const id = encodeURIComponent(agent.id);
  if (!verified && !optIn) {
    return `<div class="ep-card" id="bestillinger">
        <h2>Bestillinger</h2>
        <p>Motta bestillinger på e-post: <strong>Av</strong></p>
        <p style="margin-bottom:12px;color:#737373;font-size:0.88rem;">Bestillinger fra kunder kan bare slås på for profiler der eierskapet er bekreftet. Bekreft først at du eier profilen, så kan du slå på bestillinger her.</p>
        <a class="ep-btn ep-btn-primary" href="/selger?agent=${id}">Bekreft eierskap av profilen</a>${extraHtml}
      </div>`;
  }
  return `<div class="ep-card" id="bestillinger">
        <h2>Bestillinger</h2>
        <p>Motta bestillinger på e-post: <strong>${optIn ? "På" : "Av"}</strong></p>
        <p style="margin-bottom:12px;color:#737373;font-size:0.88rem;">Når den er på, sender vi bestillinger fra kunder til e-postadressen din. Du kan slå den av igjen når som helst.</p>
        <form method="post" action="/eier/${id}/order-notifications" style="margin:0;">
          <input type="hidden" name="opt_in" value="${optIn ? "0" : "1"}">
          <button type="submit" class="ep-btn ep-btn-primary">${optIn ? "Slå av bestillinger på e-post" : "Slå på bestillinger på e-post"}</button>
        </form>${extraHtml}
      </div>`;
}

// ─────────────────────────────────────────────────────────────────
// S1b punkt 6 — «Pause som virker» (dev-request 2026-10-22-rfb-mine-valg-eierbrytere)
// ─────────────────────────────────────────────────────────────────
// Behind OWNER_PAUSE_ENABLED (services/agent-visibility.ts, default OFF):
// with the flag off the card is not rendered and both routes answer 404.
// Only a verified owner (isVerifiedOwner — independent of the S1b punkt 5
// gate flag) may pause or resume. A session without verified ownership sees
// the card locked with the reason. Each real change writes ONE
// agent_knowledge_audit row (field_name 'visibility.profile'); a request that
// does not change the state writes nothing. «Be om sletting» is an e-mail to
// kundeservice (kontakt@), the existing route for removal requests.

const OWNER_PAUSE_AUDIT_FIELD = "visibility.profile";
const OWNER_PAUSE_MAX_DAYS = 366;
const CS_EMAIL = "kontakt@rettfrabonden.com";

interface OwnerPauseState { paused: boolean; until: string | null }

function readOwnerPause(agentId: string): OwnerPauseState {
  const row = readOwnerPauseRow(getDb(), agentId);
  const paused = isOwnerPaused(row);
  return { paused, until: paused ? (row.owner_pause_until ?? null) : null };
}

function pauseAuditValue(state: OwnerPauseState): string {
  return state.paused ? (state.until ? `off (pause til ${state.until})` : "off (pause)") : "on";
}

/** 'YYYY-MM-DD' strictly after today (UTC) and within a year, or null when invalid. */
export function parseResumeDate(raw: unknown, now: Date = new Date()): string | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return null;
  const today = now.toISOString().slice(0, 10);
  if (v <= today) return null;
  const max = new Date(now.getTime() + OWNER_PAUSE_MAX_DAYS * 86400000).toISOString().slice(0, 10);
  if (v > max) return null;
  return v;
}

export const OWNER_PAUSE_LOCKED_MESSAGE =
  "Pause kan bare brukes når eierskapet til profilen er bekreftet. Bekreft eierskap først.";

export function applyOwnerPause(
  req: Request,
  agentId: string,
  rawPaused: unknown,
  rawUntil: unknown,
): { status: number; body: any } {
  if (!ownerPauseEnabled()) return { status: 404, body: { success: false, error: "not_found" } };
  const session = verifyOwnerSession(req);
  if (!session.valid) {
    return { status: 401, body: { success: false, error: "session_invalid", message: "Din sesjon er utløpt. Logg inn på nytt." } };
  }
  if (!isVerifiedOwner(agentId, session)) {
    return session.agentId === agentId
      ? { status: 403, body: { success: false, error: "ownership_not_verified", message: OWNER_PAUSE_LOCKED_MESSAGE } }
      : { status: 403, body: { success: false, error: "forbidden", message: "Du har ikke tilgang til denne agenten." } };
  }
  let wantPaused: boolean;
  if (rawPaused === true || rawPaused === 1 || rawPaused === "1" || rawPaused === "true") wantPaused = true;
  else if (rawPaused === false || rawPaused === 0 || rawPaused === "0" || rawPaused === "false") wantPaused = false;
  else return { status: 400, body: { success: false, error: "bad_paused", message: "paused må være true eller false." } };

  let until: string | null = null;
  const untilGiven = typeof rawUntil === "string" ? rawUntil.trim() !== "" : rawUntil != null;
  if (wantPaused && untilGiven) {
    until = parseResumeDate(rawUntil);
    if (!until) {
      return { status: 400, body: { success: false, error: "bad_until", message: "Tilbakedato må være en dato fram i tid (innen ett år), på formen ÅÅÅÅ-MM-DD." } };
    }
  }

  const db = getDb();
  const result = db.transaction(() => {
    const before = readOwnerPause(agentId);
    const after: OwnerPauseState = { paused: wantPaused, until: wantPaused ? until : null };
    if (before.paused === after.paused && before.until === after.until) {
      return { changed: false, state: after };
    }
    const now = new Date().toISOString();
    if (wantPaused) {
      db.prepare(
        `INSERT INTO owner_profile_pause (agent_id, paused_at, pause_until, set_by) VALUES (?, ?, ?, 'owner')
         ON CONFLICT(agent_id) DO UPDATE SET paused_at = excluded.paused_at, pause_until = excluded.pause_until, set_by = excluded.set_by`
      ).run(agentId, now, after.until);
    } else {
      db.prepare("DELETE FROM owner_profile_pause WHERE agent_id = ?").run(agentId);
    }
    const email = (db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?").get(agentId) as { email?: string } | undefined)?.email ?? null;
    db.prepare(
      `INSERT INTO agent_knowledge_audit
       (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `audit_${crypto.randomBytes(8).toString("hex")}`,
      agentId,
      OWNER_PAUSE_AUDIT_FIELD,
      pauseAuditValue({ paused: before.paused, until: before.until }),
      pauseAuditValue(after),
      "owner",
      email,
      now,
      wantPaused ? "owner paused profile (S1b punkt 6)" : "owner resumed profile (S1b punkt 6)",
    );
    return { changed: true, state: after };
  })();
  if (result.changed) {
    // Public list caches (registry agents/stats, sitemap) must not keep
    // serving the old state for a TTL. Lazy require: seo.ts is a big module.
    try {
      const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
      marketplaceRegistry._agentsCache = null;
      marketplaceRegistry._statsCache = null;
      marketplaceRegistry._agentsCacheTime = 0;
      marketplaceRegistry._statsCacheTime = 0;
      (require("./seo") as typeof import("./seo")).invalidateSitemapCache();
    } catch (e) {
      console.error("[owner-portal] pause cache invalidation failed:", e);
    }
  }
  console.log(`[owner-portal] owner ${wantPaused ? "paused" : "resumed"} agent ${agentId} (changed=${result.changed})`);
  return { status: 200, body: { success: true, agent_id: agentId, paused: result.state.paused, until: result.state.until, changed: result.changed } };
}

/** The «Pause og sletting» card (rendered only with OWNER_PAUSE_ENABLED on). */
export function ownerPauseCardHtml(agent: { id: string; name?: string }, verifiedOwner: boolean, state: OwnerPauseState): string {
  const id = encodeURIComponent(agent.id);
  const subject = encodeURIComponent(`Be om sletting av profil: ${agent.name || agent.id} (${agent.id})`);
  const mailBody = encodeURIComponent(`Hei,\n\nJeg ber om at profilen ${agent.name || ""} (${agent.id}) slettes fra Rett fra Bonden.\n\nHilsen`);
  const deletion = `<p style="margin-top:16px;color:#737373;font-size:0.88rem;">Vil du heller at profilen slettes for godt? Kundeservice hjelper deg.</p>
        <a class="ep-btn ep-btn-secondary" href="mailto:${CS_EMAIL}?subject=${subject}&amp;body=${mailBody}">Be om sletting</a>`;
  if (!verifiedOwner) {
    return `<div class="ep-card" id="pause">
        <h2>Pause og sletting</h2>
        <p>Profilen er synlig.</p>
        <div class="ep-lock">\u{1F512} ${escapeHtml(OWNER_PAUSE_LOCKED_MESSAGE)}</div>
        <a class="ep-btn ep-btn-primary" href="/selger?agent=${id}">Bekreft eierskap av profilen</a>
        ${deletion}
      </div>`;
  }
  if (state.paused) {
    return `<div class="ep-card" id="pause">
        <h2>Pause og sletting</h2>
        <p>Profilen er på <strong>midlertidig pause</strong>${state.until ? ` til ${escapeHtml(state.until)}` : ""}. Den vises ikke i søk, lister, AI-tjenester eller kart.</p>
        <form method="post" action="/eier/${id}/pause" style="margin:0;">
          <input type="hidden" name="paused" value="0">
          <button type="submit" class="ep-btn ep-btn-primary">Vis profilen igjen</button>
        </form>
        ${deletion}
      </div>`;
  }
  return `<div class="ep-card" id="pause">
        <h2>Pause og sletting</h2>
        <p>Profilen er synlig.</p>
        <p style="margin-bottom:12px;color:#737373;font-size:0.88rem;">Tar du pause, forsvinner profilen fra søk, lister og AI-tjenester. Profilsiden viser «Midlertidig pause». Du kan slå den på igjen når som helst, eller velge en dato da den kommer tilbake av seg selv.</p>
        <form method="post" action="/eier/${id}/pause" style="margin:0;">
          <input type="hidden" name="paused" value="1">
          <div class="ep-field">
            <label for="pause_until">Kommer tilbake (valgfritt)</label>
            <input id="pause_until" name="until" type="date" aria-label="Dato profilen kommer tilbake">
          </div>
          <button type="submit" class="ep-btn ep-btn-primary">Sett profilen på pause</button>
        </form>
        ${deletion}
      </div>`;
}

// ─────────────────────────────────────────────────────────────────
// S1b punkt 7 — «Eieren styrer ordre-e-posten» (dev-request 2026-10-22-rfb-mine-valg-eierbrytere)
// ─────────────────────────────────────────────────────────────────
// Behind OWNER_ORDER_EMAIL_ENABLED (default OFF): flag off = no card section,
// all four routes answer 404, nothing is written.
//
// Why an owner may write agents.order_notification_email at all — and why it
// stays safe. The order-notify send-guard (services/order-notify-service.ts)
// is NOT changed: its clause 3 lets an explicit order_notification_email stand
// in for the "verified contact" clause, because until now only an admin ever
// set it. This route keeps that premise:
//   1. Only a verified owner (isVerifiedOwner: session for exactly this agent
//      AND the customer rule — claimed_at or a verified agent_claims row) may
//      START a change. An e-mail-match session without verified ownership
//      gets 403.
//   2. The column is written ONLY after the confirmation link mailed to the
//      NEW address is used (POST; a GET only shows the confirm page — mail
//      scanners prefetch links). That proves control of the new address, so
//      the address is as "verified" as the contact clause demands. Until then
//      orders keep going to the old recipient.
//   3. The new address must pass isBlocked() both at request and at confirm
//      time (the notify gate's clause 4 also re-checks it at send time).
//   4. The token is bound to the requester's ownership: at request time a
//      fingerprint of the ownership basis (claimed_at/claimed_via + the ids
//      of the verified agent_claims rows) is stored; confirm requires the
//      agent to still be owned AND that fingerprint to be unchanged. An
//      admin reset-claim followed by a re-claim by someone else therefore
//      kills every link issued before it (reset-claim also supersedes
//      pending rows directly — routes/marketplace.ts).
// It never touches who gets a real order at all: cart-service's
// isEligibleForRealOrder() (cross-check, is_verified, opt-in, not blocklisted)
// is unchanged and stays stricter than the notify gate — the owner only
// chooses the DESTINATION, exactly what the admin override already was.
//
// Tokens: 32 random bytes, only the sha256 is stored, valid 48 h, single use.
// A new request supersedes every earlier pending one for the agent. Max 3
// requests per agent per rolling hour (no mail-bombing an arbitrary address).
// All times are ISO-8601 strings (toISOString) compared with ISO strings —
// never against SQLite datetime('now') (the format pitfall noted at
// OWNER_TOKEN_NOT_EXPIRED_SQL above).

export const OWNER_ORDER_EMAIL_FLAG = "OWNER_ORDER_EMAIL_ENABLED";
export const ORDER_EMAIL_CONFIRM_VALID_HOURS = 48;
const ORDER_EMAIL_MAX_REQUESTS_PER_HOUR = 3;
const ORDER_EMAIL_AUDIT_FIELD = "order_notification_email";
const ORDER_EMAIL_CONFIRM_PATH = "/eier/ordre-epost/bekreft";

export function ownerOrderEmailEnabled(): boolean {
  return envFlagOn(OWNER_ORDER_EMAIL_FLAG);
}

function hashOrderEmailToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isPlausibleOrderEmail(v: string): boolean {
  return v.length <= 254 && /^[^\s@<>"',;:()\[\]\\]+@[^\s@<>"',;:()\[\]\\]+\.[^\s@<>"',;:()\[\]\\]{2,}$/.test(v);
}

/**
 * Fingerprint of who owns the agent right now (customer rule basis). Any
 * reset-claim, re-claim, new or removed verified claim changes it. null when
 * the agent is not verified-owned at all.
 */
export function ownerBasisFingerprint(agentId: string): string | null {
  const db = getDb();
  const a = db
    .prepare(`SELECT a.claimed_at AS claimed_at, a.claimed_via AS claimed_via, ${customerRuleSql("a")} AS owned FROM agents a WHERE a.id = ?`)
    .get(agentId) as { claimed_at: string | null; claimed_via: string | null; owned: number } | undefined;
  if (!a || a.owned !== 1) return null;
  const claims = (db
    .prepare("SELECT id FROM agent_claims WHERE agent_id = ? AND status = 'verified' ORDER BY id")
    .all(agentId) as Array<{ id: string }>).map((c) => c.id);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([a.claimed_at ?? null, a.claimed_via ?? null, claims]))
    .digest("hex");
}

/** The address an order mail goes to right now — same resolution as the notify gate's clause 2. */
export function currentOrderRecipient(agentId: string): string | null {
  const row = getDb()
    .prepare("SELECT order_notification_email AS override_email, contact_email FROM agents WHERE id = ?")
    .get(agentId) as { override_email: string | null; contact_email: string | null } | undefined;
  if (!row) return null;
  return (row.override_email || "").trim() || (row.contact_email || "").trim() || null;
}

/** The newest pending (unconsumed, unexpired) change for the agent, or null. */
export function pendingOrderEmailChange(agentId: string, now: Date = new Date()): { new_email: string; expires_at: string } | null {
  const row = getDb()
    .prepare(
      `SELECT new_email, expires_at FROM owner_order_email_change
       WHERE agent_id = ? AND outcome IS NULL AND consumed_at IS NULL AND expires_at > ?
       ORDER BY requested_at DESC, rowid DESC LIMIT 1`
    )
    .get(agentId, now.toISOString()) as { new_email: string; expires_at: string } | undefined;
  return row ?? null;
}

export const OWNER_ORDER_EMAIL_LOCKED_MESSAGE =
  "Adressen for bestillinger kan bare endres når eierskapet til profilen er bekreftet. Bekreft eierskap først.";

export async function requestOwnerOrderEmailChange(
  req: Request,
  agentId: string,
  rawEmail: unknown,
): Promise<{ status: number; body: any }> {
  if (!ownerOrderEmailEnabled()) return { status: 404, body: { success: false, error: "not_found" } };
  const session = verifyOwnerSession(req);
  if (!session.valid) {
    return { status: 401, body: { success: false, error: "session_invalid", message: "Din sesjon er utløpt. Logg inn på nytt." } };
  }
  if (!isVerifiedOwner(agentId, session)) {
    return session.agentId === agentId
      ? { status: 403, body: { success: false, error: "ownership_not_verified", message: OWNER_ORDER_EMAIL_LOCKED_MESSAGE } }
      : { status: 403, body: { success: false, error: "forbidden", message: "Du har ikke tilgang til denne agenten." } };
  }
  const email = normalizeEmail(typeof rawEmail === "string" ? rawEmail : "");
  if (!email || !isPlausibleOrderEmail(email)) {
    return { status: 400, body: { success: false, error: "invalid_email", message: "Skriv inn en gyldig e-postadresse." } };
  }
  const current = currentOrderRecipient(agentId);
  if (current && normalizeEmail(current) === email) {
    return { status: 400, body: { success: false, error: "same_email", message: "Bestillinger sendes allerede til denne adressen." } };
  }
  if (isBlocked({ email }).blocked) {
    return { status: 400, body: { success: false, error: "email_blocked", message: "Vi kan ikke sende bestillinger til denne adressen. Kontakt kontakt@rettfrabonden.com." } };
  }

  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const hourAgoIso = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const recent = db
    .prepare("SELECT COUNT(*) AS n FROM owner_order_email_change WHERE agent_id = ? AND requested_at > ?")
    .get(agentId, hourAgoIso) as { n: number };
  if ((Number(recent?.n) || 0) >= ORDER_EMAIL_MAX_REQUESTS_PER_HOUR) {
    return { status: 429, body: { success: false, error: "rate_limited", message: "For mange forsøk. Prøv igjen om en time." } };
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashOrderEmailToken(token);
  const expiresAt = new Date(now.getTime() + ORDER_EMAIL_CONFIRM_VALID_HOURS * 60 * 60 * 1000).toISOString();
  let requestedBy = "owner";
  try {
    const ml = db.prepare("SELECT email FROM magic_links WHERE token = ?").get(session.token ?? "") as { email?: string } | undefined;
    if (ml?.email) requestedBy = `owner:${normalizeEmail(ml.email)}`;
  } catch { /* keep 'owner' */ }

  db.transaction(() => {
    db.prepare(
      `UPDATE owner_order_email_change SET outcome = 'superseded', consumed_at = ?
       WHERE agent_id = ? AND outcome IS NULL AND consumed_at IS NULL`
    ).run(nowIso, agentId);
    db.prepare(
      `INSERT INTO owner_order_email_change (token_hash, agent_id, new_email, requested_at, expires_at, requested_by, owner_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tokenHash, agentId, email, nowIso, expiresAt, requestedBy, ownerBasisFingerprint(agentId));
  })();

  const agentRow = db.prepare("SELECT name FROM agents WHERE id = ?").get(agentId) as { name?: string } | undefined;
  const confirmUrl = `https://rettfrabonden.com${ORDER_EMAIL_CONFIRM_PATH}/${token}`;
  let sent = false;
  try {
    const r = await emailService.sendOwnerOrderEmailConfirm({
      to: email,
      agentName: agentRow?.name ? String(agentRow.name) : "profilen din",
      confirmUrl,
      validHours: ORDER_EMAIL_CONFIRM_VALID_HOURS,
    });
    sent = !!r?.success;
  } catch (e) {
    console.error("[owner-portal] order-email confirm mail threw:", e instanceof Error ? e.message : String(e));
  }
  if (!sent) {
    db.prepare("UPDATE owner_order_email_change SET outcome = 'send_failed', consumed_at = ? WHERE token_hash = ?").run(new Date().toISOString(), tokenHash);
    return { status: 502, body: { success: false, error: "email_send_failed", message: "Klarte ikke å sende bekreftelsen. Prøv igjen senere." } };
  }
  console.log(`[owner-portal] order-email change requested for agent ${agentId} (pending confirmation)`);
  return {
    status: 200,
    body: { success: true, agent_id: agentId, order_email: current, pending_email: email, expires_at: expiresAt },
  };
}

export type OrderEmailTokenState =
  | { ok: true; agentId: string; newEmail: string; agentName: string }
  | { ok: false; reason: "invalid" | "used" | "expired" | "not_owned" | "blocked" };

/** Read-only check of a confirmation token (GET page and the first step of POST). */
export function inspectOrderEmailToken(rawToken: string, now: Date = new Date()): OrderEmailTokenState {
  if (!/^[0-9a-f]{64}$/.test(rawToken)) return { ok: false, reason: "invalid" };
  const db = getDb();
  const row = db
    .prepare("SELECT agent_id, new_email, expires_at, consumed_at, outcome, owner_basis FROM owner_order_email_change WHERE token_hash = ?")
    .get(hashOrderEmailToken(rawToken)) as
    | { agent_id: string; new_email: string; expires_at: string; consumed_at: string | null; outcome: string | null; owner_basis: string | null }
    | undefined;
  if (!row) return { ok: false, reason: "invalid" };
  if (row.outcome != null || row.consumed_at != null) return { ok: false, reason: "used" };
  if (!(row.expires_at > now.toISOString())) return { ok: false, reason: "expired" };
  const agent = db
    .prepare(`SELECT a.name AS name, ${customerRuleSql("a")} AS owned FROM agents a WHERE a.id = ?`)
    .get(row.agent_id) as { name?: string; owned?: number } | undefined;
  if (!agent || agent.owned !== 1) return { ok: false, reason: "not_owned" };
  // Bound to the requester's ownership: reject if the ownership basis
  // changed after the request (reset-claim / re-claim / other claimant).
  const basis = ownerBasisFingerprint(row.agent_id);
  if (!row.owner_basis || basis !== row.owner_basis) return { ok: false, reason: "not_owned" };
  if (isBlocked({ email: row.new_email }).blocked) return { ok: false, reason: "blocked" };
  return { ok: true, agentId: row.agent_id, newEmail: row.new_email, agentName: String(agent.name || "") };
}

/** POST confirm: writes agents.order_notification_email + one audit row, or nothing. */
export function confirmOwnerOrderEmailChange(rawToken: string): OrderEmailTokenState {
  const db = getDb();
  return db.transaction((): OrderEmailTokenState => {
    const state = inspectOrderEmailToken(rawToken);
    if (!state.ok) return state;
    const nowIso = new Date().toISOString();
    const claimed = db
      .prepare(
        `UPDATE owner_order_email_change SET consumed_at = ?, outcome = 'confirmed'
         WHERE token_hash = ? AND outcome IS NULL AND consumed_at IS NULL`
      )
      .run(nowIso, hashOrderEmailToken(rawToken));
    if (claimed.changes !== 1) return { ok: false, reason: "used" };
    const before = db
      .prepare("SELECT order_notification_email AS override_email, contact_email FROM agents WHERE id = ?")
      .get(state.agentId) as { override_email: string | null; contact_email: string | null };
    const oldOverride = (before.override_email || "").trim();
    const oldEffective = oldOverride || (before.contact_email || "").trim() || "";
    db.prepare("UPDATE agents SET order_notification_email = ? WHERE id = ?").run(state.newEmail, state.agentId);
    const ownerEmail = (db.prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?").get(state.agentId) as { email?: string } | undefined)?.email ?? null;
    db.prepare(
      `INSERT INTO agent_knowledge_audit
       (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `audit_${crypto.randomBytes(8).toString("hex")}`,
      state.agentId,
      ORDER_EMAIL_AUDIT_FIELD,
      oldEffective || null,
      state.newEmail,
      "owner",
      ownerEmail,
      nowIso,
      `owner confirmed new order e-mail from the new address (S1b punkt 7); previous recipient was ${oldOverride ? "order_notification_email" : "contact_email"}`,
    );
    console.log(`[owner-portal] order-email confirmed for agent ${state.agentId}`);
    return state;
  })();
}

/** The «Ordre sendes til» section inside the Bestillinger card (flag on, verified owner). */
export function ownerOrderEmailSectionHtml(agentId: string, current: string | null, pending: string | null): string {
  const id = encodeURIComponent(agentId);
  return `
        <div id="ordre-epost" style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e5e5;">
          <p>Ordre sendes til: <strong>${current ? escapeHtml(current) : "ingen adresse"}</strong></p>
          ${pending ? `<p class="ep-alert ep-alert-ok" role="status">Venter på bekreftelse fra <strong>${escapeHtml(pending)}</strong>. Klikk lenken vi sendte dit.</p>` : ""}
          <form method="post" action="/eier/${id}/order-email" style="margin:0;">
            <div class="ep-field">
              <label for="order_email">Ny adresse for bestillinger</label>
              <input id="order_email" name="email" type="email" required autocomplete="email">
            </div>
            <button type="submit" class="ep-btn ep-btn-secondary">Send bekreftelse til ny adresse</button>
          </form>
          <p style="margin-top:8px;color:#737373;font-size:0.88rem;">Vi sender en lenke til den nye adressen. Bestillinger går til den gamle adressen til lenken er brukt.</p>
        </div>`;
}

/**
 * S2e («Én bryter, ett sted», v2 principle 6): for a profile that has «Mine
 * valg», the «Bestillinger» card (orders on/off + the order address) and the
 * «Pause og sletting» card are replaced by this one link — the choices
 * themselves live only in «Mine valg» (orders.enabled, orders.email,
 * visibility.profile), with the same effect as the old cards.
 */
export function ownerFeaturesMovedCardHtml(agentId: string): string {
  const id = encodeURIComponent(agentId);
  return `<div class="ep-card" id="bestillinger">
        <h2>Bestillinger og pause</h2>
        <p style="margin-bottom:12px;color:#737373;font-size:0.88rem;">Om du tar imot bestillinger, hvilken adresse de sendes til, og pause av profilen, velger du nå i «Mine valg».</p>
        <a class="ep-btn ep-btn-secondary" href="/eier/${id}/valg#gruppe-orders">Gå til bestillinger i Mine valg</a>
        <a class="ep-btn ep-btn-secondary" href="/eier/${id}/valg#gruppe-visibility">Gå til pause i Mine valg</a>
      </div>`;
}

/** 403 page: valid session for this agent, but no verified owner (S1b punkt 5). */
/** S2b: the portal card that links to «Mine valg» (/eier/:id/valg). */
export function ownerFeaturesEntryCardHtml(agentId: string): string {
  const id = encodeURIComponent(agentId);
  return `<div class="ep-card" id="mine-valg">
        <h2>Mine valg</h2>
        <p style="margin-bottom:12px;color:#737373;font-size:0.88rem;">Bestem hvem som finner deg, om du tar imot bestillinger og hva vi sender deg. Alt på ett sted.</p>
        <a class="ep-btn ep-btn-primary" href="/eier/${id}/valg">Gå til Mine valg</a>
      </div>`;
}

export function ownerNotVerifiedPage(agentId: string): string {
  const id = encodeURIComponent(agentId);
  return portalShell(
    "Ingen tilgang",
    `<div class="ep-card">
          <h1>Eierskapet er ikke bekreftet</h1>
          <p>${escapeHtml(OWNER_NOT_VERIFIED_MESSAGE)}</p>
          <a class="ep-btn ep-btn-primary" href="/selger?agent=${id}">Bekreft eierskap av profilen</a>
        </div>`
  );
}

// ─────────────────────────────────────────────────────────────────
// GET /eier/:agentId/portal — authenticated edit page (requires session)
// ─────────────────────────────────────────────────────────────────
router.get("/eier/:agentId/portal", (req: Request, res: Response) => {
  try {
    const agentId = String((req.params as any).agentId || "");
    const session = verifyOwnerSession(req);

    if (!session.valid) {
      // Not logged in → bounce to email-entry form for this agent.
      return res.redirect(302, `/eier/${encodeURIComponent(agentId)}`);
    }
    if (session.agentId === agentId && !ownerSessionAllows(agentId, session)) {
      // S1b punkt 5 (OWNER_VERIFIED_OWNER_GATE_ENABLED): an e-mail match
      // without verified ownership → 403 with the way to confirm ownership.
      return res.status(403).send(ownerNotVerifiedPage(agentId));
    }
    if (session.agentId !== agentId) {
      // Logged in to a different agent → 403.
      return res.status(403).send(portalShell(
        "Ingen tilgang",
        `<div class="ep-card">
          <h1>Ingen tilgang</h1>
          <p>Sesjonen din er knyttet til en annen produsent. <a href="/eier/${encodeURIComponent(session.agentId || "")}/portal">Gå til din egen portal</a> eller <a href="/eier/${encodeURIComponent(agentId)}">logg inn på nytt</a>.</p>
        </div>`
      ));
    }

    const db = getDb();
    const agent = db
      .prepare("SELECT id, name FROM agents WHERE id = ?")
      .get(agentId) as any;
    if (agent) (agent as any).slug = slugify(String(agent.name || ""));
    if (agent) {
      // Tolerant read: a DB without the column renders as "off".
      try {
        const o = db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(agentId) as any;
        agent.order_notifications_opt_in = o && o.v === 1 ? 1 : 0;
      } catch { agent.order_notifications_opt_in = 0; }
      // F1 (dev-request 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel):
      // the opt-in switch is only offered to an owner-verified profile.
      // Tolerant read: a DB without the column renders as "not verified".
      try {
        const v = db.prepare("SELECT is_verified AS v FROM agents WHERE id = ?").get(agentId) as any;
        agent.is_verified = v && v.v === 1 ? 1 : 0;
      } catch { agent.is_verified = 0; }
    }
    if (!agent) {
      return res.status(404).send(portalShell(
        "Fant ikke produsent",
        `<div class="ep-card"><h1>Fant ikke produsent</h1><p>Produsenten du prøver å redigere finnes ikke lenger.</p></div>`
      ));
    }
    const knowledge = db
      .prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?")
      .get(agentId) as any;
    if (!knowledge) {
      return res.status(404).send(portalShell(
        "Mangler profilinformasjon",
        `<div class="ep-card"><h1>Mangler profilinformasjon</h1><p>Ingen profildata funnet for denne produsenten. Kontakt kontakt@rettfrabonden.com.</p></div>`
      ));
    }

    let curatedFields: Record<string, any> = {};
    try { curatedFields = knowledge.curated_fields ? JSON.parse(knowledge.curated_fields) : {}; }
    catch { curatedFields = {}; }

    const status = String(req.query.status || "");
    let alert = "";
    if (status === "saved") {
      alert = `<div class="ep-alert ep-alert-ok" role="status">Endringene er lagret.</div>`;
    } else if (status === "error") {
      alert = `<div class="ep-alert ep-alert-error" role="alert">Klarte ikke å lagre. Prøv igjen.</div>`;
    } else if (status === "orders_on") {
      alert = `<div class="ep-alert ep-alert-ok" role="status">Du mottar nå bestillinger på e-post.</div>`;
    } else if (status === "orders_off") {
      alert = `<div class="ep-alert ep-alert-ok" role="status">Du mottar ikke lenger bestillinger på e-post.</div>`;
    } else if (status === "paused" && ownerPauseEnabled()) {
      alert = `<div class="ep-alert ep-alert-ok" role="status">Profilen er satt på pause.</div>`;
    } else if (status === "resumed" && ownerPauseEnabled()) {
      alert = `<div class="ep-alert ep-alert-ok" role="status">Profilen er synlig igjen.</div>`;
    } else if (status === "pause_error" && ownerPauseEnabled()) {
      alert = `<div class="ep-alert ep-alert-error" role="alert">Klarte ikke å endre pausen. Sjekk datoen og prøv igjen.</div>`;
    } else if (status.startsWith("order_email_") && ownerOrderEmailEnabled() && ORDER_EMAIL_STATUS_ALERTS[status]) {
      const oa = ORDER_EMAIL_STATUS_ALERTS[status];
      alert = oa.ok
        ? `<div class="ep-alert ep-alert-ok" role="status">${escapeHtml(oa.text)}</div>`
        : `<div class="ep-alert ep-alert-error" role="alert">${escapeHtml(oa.text)}</div>`;
    } else if (ownerOrderabilityPortalEnabledFor(agentId) && ownerOrderabilityAlert(status, req.query.felt, req.query.uten_pris)) {
      const va = ownerOrderabilityAlert(status, req.query.felt, req.query.uten_pris)!;
      alert = va.ok
        ? `<div class="ep-alert ep-alert-ok" role="status">${escapeHtml(va.text)}</div>`
        : `<div class="ep-alert ep-alert-error" role="alert">${escapeHtml(va.text)}</div>`;
    } else if (paymentPortalAlert(status)) {
      const pa = paymentPortalAlert(status)!;
      alert = pa.ok
        ? `<div class="ep-alert ep-alert-ok" role="status">${escapeHtml(pa.text)}</div>`
        : `<div class="ep-alert ep-alert-error" role="alert">${escapeHtml(pa.text)}</div>`;
    }

    // Prepayment card (A2A dev-request 2026-10-09-rfb-forhandsbetaling-
    // stripe-connect): only rendered when PAYMENTS_ENABLED=1 and this
    // producer is in the pilot — otherwise the portal is byte-identical to
    // before. A read failure (e.g. a DB without the payment tables) hides it.
    let paymentCardHtml = "";
    try {
      const paymentStatus = getProducerPaymentStatus(db, agentId);
      if (shouldRenderPaymentCard(paymentStatus)) paymentCardHtml = renderPaymentCard(agentId, paymentStatus);
    } catch { paymentCardHtml = ""; }

    // S2b: «Mine valg» entry card — only for a subject in
    // OWNER_FEATURES_ALLOWED_SUBJECTS and a verified owner (empty/unset
    // allowlist = "" = the portal is byte-identical to before).
    let hasOwnerFeatures = false;
    try {
      hasOwnerFeatures = isSubjectAllowedForOwnerFeatures("rfb", agentId) && isVerifiedOwner(agentId, session);
    } catch { hasOwnerFeatures = false; }

    // S1b punkt 6: «Pause og sletting» card — only with OWNER_PAUSE_ENABLED on
    // (flag off = the portal is byte-identical to before). S2e: not for a
    // profile with «Mine valg» (the pause lives there).
    let pauseCardHtml = "";
    if (ownerPauseEnabled() && !hasOwnerFeatures) {
      try {
        pauseCardHtml = ownerPauseCardHtml(agent, isVerifiedOwner(agentId, session), readOwnerPause(agentId));
      } catch { pauseCardHtml = ""; }
    }

    // S1b punkt 7: «Ordre sendes til» + change form inside the Bestillinger
    // card — only with OWNER_ORDER_EMAIL_ENABLED on and a verified owner
    // (flag off = the portal is byte-identical to before).
    let orderEmailHtml = "";
    if (ownerOrderEmailEnabled() && !hasOwnerFeatures) {
      try {
        if (isVerifiedOwner(agentId, session)) {
          orderEmailHtml = ownerOrderEmailSectionHtml(agentId, currentOrderRecipient(agentId), pendingOrderEmailChange(agentId)?.new_email ?? null);
        }
      } catch { orderEmailHtml = ""; }
    }

    // B1: «Varer som kan bestilles» — only with OWNER_ORDERABILITY_PORTAL_ENABLED
    // on and a verified owner (flag off = the portal is byte-identical to before).
    // B1a: and only for a subject in OWNER_FEATURES_ALLOWED_SUBJECTS (off the
    // list = byte-identical to flag off; the banner lives inside the card).
    let orderabilityCardHtml = "";
    if (ownerOrderabilityPortalEnabledFor(agentId)) {
      try {
        if (isVerifiedOwner(agentId, session)) {
          // B2: the stock-check banner (products.stock_check on, an orderable
          // item expiring within 3 days) goes at the top of the card.
          let banner = "";
          try {
            if (stockCheckOn(agentId, { db })) banner = stockCheckBannerHtml(agentId, soonExpiringItems(agentId, { db }));
          } catch (e) {
            console.error("[owner-portal] stock-check banner failed:", e instanceof Error ? e.message : "error");
            banner = "";
          }
          orderabilityCardHtml = ownerOrderabilityCardHtml(agentId, listOwnerProductOrderability(agentId, db), banner);
        }
      } catch (e) {
        console.error("[owner-portal] orderability card failed:", e instanceof Error ? e.message : "error");
        orderabilityCardHtml = "";
      }
    }

    // Produktimport skive 3-2: «Hent produkter fra nettsiden min» — only with
    // PRODUCT_IMPORT_ENABLED on, a verified owner, agents.is_verified = 1 and a
    // website (flag off = the portal is byte-identical to before).
    let productImportCard = "";
    try {
      if (productImportCardVisible(agentId, session, agent.is_verified)) {
        const ia = productImportPortalAlert(status, req.query as any, productImportStockHintHtml(agentId));
        const iaHtml = ia
          ? `<div class="ep-alert ${ia.ok ? "ep-alert-ok" : "ep-alert-error"}" role="${ia.ok ? "status" : "alert"}" data-import-alert="${escapeHtml(status)}">${ia.html}</div>`
          : "";
        productImportCard = productImportCardHtml(agentId, getOwnerImportOverview(agentId), iaHtml);
      }
    } catch (e) {
      console.error("[owner-portal] product import card failed:", e instanceof Error ? e.message : "error");
      productImportCard = "";
    }

    const ownerFeaturesCardHtml = hasOwnerFeatures ? ownerFeaturesEntryCardHtml(agentId) : "";
    // S2e: with «Mine valg», the «Bestillinger» card (and its order-address
    // section) is replaced by a link there; otherwise unchanged.
    const ordersOrMovedCardHtml = hasOwnerFeatures ? ownerFeaturesMovedCardHtml(agentId) : ordersCardHtml(agent, orderEmailHtml);

    // Fase A2: number of orders waiting for an answer (tolerant: a DB without orders shows 0).
    let pendingOrderCount = 0;
    try {
      const pc = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE agent_id = ? AND status = 'pending'").get(agentId) as any;
      pendingOrderCount = Number(pc?.n) || 0;
    } catch { pendingOrderCount = 0; }

    // Editable fields with display labels (Norwegian Bokmål)
    const fieldDefs: Array<{ key: string; dbField: string; label: string; type: "text" | "textarea" | "email" | "url" }> = [
      { key: "email",        dbField: "email",         label: "E-post",            type: "email" },
      { key: "phone",        dbField: "phone",         label: "Telefon",           type: "text" },
      { key: "address",      dbField: "address",       label: "Adresse",           type: "text" },
      { key: "postal_code",  dbField: "postal_code",   label: "Postnummer",        type: "text" },
      { key: "website",      dbField: "website",       label: "Nettside",          type: "url" },
      { key: "opening_hours",dbField: "opening_hours", label: "Åpningstider", type: "text" },
      { key: "description",  dbField: "about",         label: "Om produsenten",    type: "textarea" },
    ];

    const fieldHtml = fieldDefs.map((fd) => {
      const value = ownerProfileDisplayValue(fd.dbField, (knowledge as any)[fd.dbField]);
      const lockInfo = curatedFields[fd.dbField] || {};
      const csOverride = isOverridableCsLock(lockInfo);
      const lockedByOther = lockInfo.by && lockInfo.by !== "owner" && lockInfo.by !== null && !csOverride;
      const lockedHtml = lockedByOther
        ? `<div class="ep-lock">\u{1F512} Låst — kontakt support for å endre (${escapeHtml(String(lockInfo.by))})</div>`
        : csOverride
          ? `<div class="ep-lock">${escapeHtml(csLockNote(lockInfo))}. Du kan endre dette feltet selv.</div>`
          : "";
      const inputName = `field_${fd.key}`;
      if (fd.type === "textarea") {
        return `<div class="ep-field">
          <label for="${inputName}">${escapeHtml(fd.label)}</label>
          <textarea id="${inputName}" name="${inputName}" aria-label="${escapeHtml(fd.label)}" ${lockedByOther ? "disabled" : ""}>${escapeHtml(value)}</textarea>
          ${lockedHtml}
        </div>`;
      }
      return `<div class="ep-field">
        <label for="${inputName}">${escapeHtml(fd.label)}</label>
        <input id="${inputName}" name="${inputName}" type="${fd.type}" value="${escapeHtml(value)}" aria-label="${escapeHtml(fd.label)}" ${lockedByOther ? "disabled" : ""}>
        ${lockedHtml}
      </div>`;
    }).join("\n");

    // Read-only stats section
    const stat = (label: string, val: any) => {
      const v = val == null || val === "" ? "—" : String(val);
      return `<div class="ep-stat"><div class="ep-stat-num">${escapeHtml(v)}</div><div class="ep-stat-label">${escapeHtml(label)}</div></div>`;
    };
    // «Mine valg» S2f: the card read a views count and an AI-conversations
    // count off the knowledge object, fields no table has, so it always
    // showed «—». It now shows the Statistikk tab's own numbers (GET
    // /api/agents/:id/owner-stats → getOwnerStats().year): people's page
    // views and AI search over 12 months / «siden <dato>». «—» only when the
    // read fails.
    const ownerYear = ownerPortalYearStats(db, agent.id, String(agent.name || ""));
    const statsHtml = `
      ${stat("Google-vurdering", knowledge.google_rating)}
      ${stat("Google-anmeldelser", knowledge.google_review_count)}
      ${stat("TripAdvisor", knowledge.tripadvisor_rating)}
      ${stat(ownerYear ? `Sidevisninger fra mennesker (${ownerYear.labels.nb.humanViews})` : "Sidevisninger fra mennesker", ownerYear ? ownerYear.humanViews.value : null)}
      ${stat(ownerYear ? `AI-søk (${ownerYear.labels.nb.aiViews})` : "AI-søk", ownerYear ? ownerYear.aiViews.value : null)}
    `;

    const slug = agent.slug || "";
    const backUrl = slug ? `/produsent/${encodeURIComponent(slug)}` : "/";

    const body = `
      <div class="ep-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <h1 style="margin:0;">${escapeHtml(agent.name)}</h1>
          <form method="post" action="/eier/${encodeURIComponent(agent.id)}/logout" style="margin:0;">
            <button type="submit" class="ep-btn ep-btn-ghost" aria-label="Logg ut">Logg ut</button>
          </form>
        </div>
        <p>Rediger profilinformasjonen din. Endringer logges og er synlige for support.</p>
        ${alert}
      </div>

      <div class="ep-card">
        <h2>Profilinformasjon</h2>
        <form id="ep-profile-form" method="post" action="/eier/${encodeURIComponent(agent.id)}/save" novalidate>
          ${fieldHtml}
          <div class="ep-form-actions">
            <button type="submit" class="ep-btn ep-btn-primary">Lagre alle endringer</button>
            <a href="${escapeHtml(backUrl)}" class="ep-btn ep-btn-secondary">Avbryt</a>
          </div>
        </form>
      </div>

      ${ownerFeaturesCardHtml}${ownerSelgerCardHtml(agent.id)}${productImportCard}${orderabilityCardHtml}${ownerOrdersEntryCardHtml(agent.id, pendingOrderCount)}${ordersOrMovedCardHtml}${paymentCardHtml}${pauseCardHtml}

      <div class="ep-card">
        <h2>Statistikk</h2>
        <p style="margin-bottom:12px;color:#737373;font-size:0.88rem;">Disse tallene oppdateres automatisk og kan ikke redigeres.</p>
        <div class="ep-stats">${statsHtml}</div>
      </div>

      <div class="ep-card">
        <h2>Endringslogg</h2>
        <p style="margin-bottom:12px;color:#737373;font-size:0.88rem;">Siste 20 endringer på profilen.</p>
        <ul id="ep-audit" class="ep-audit-list" aria-live="polite"><li class="ep-audit-item ep-audit-meta">Laster ...</li></ul>
      </div>

      <script>
      (function () {
        // T0c: this script sits inside a TS template literal, which drops the
        // backslash of an escaped double quote. JS strings that hold HTML
        // attributes therefore use single quotes, so the emitted script stays
        // valid (owner-pages-inline-script-syntax-t0c.test.ts compiles it).
        // Load my-audit feed
        function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
        if (window.fetch) {
          fetch("/api/agents/${encodeURIComponent(agent.id)}/my-audit?limit=20", { credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              var ul = document.getElementById("ep-audit");
              if (!ul) return;
              if (!j || !j.success || !j.audits || j.audits.length === 0) {
                ul.innerHTML = '<li class="ep-audit-item ep-audit-meta">Ingen endringer ennå.</li>';
                return;
              }
              ul.innerHTML = j.audits.map(function (a) {
                var when = new Date(a.changed_at).toLocaleString("nb-NO");
                var who = a.changed_by === "owner" ? "Du" : (a.changed_by === "admin" ? "Support" : "System");
                var oldV = a.old_value == null ? "(tomt)" : String(a.old_value);
                var newV = a.new_value == null ? "(tomt)" : String(a.new_value);
                return '<li class="ep-audit-item"><strong>' + esc(a.field_name) + '</strong> endret av ' + esc(who) +
                  '<div class="ep-audit-meta">' + esc(when) + ' · «' + esc(oldV.slice(0, 80)) + '» → «' + esc(newV.slice(0, 80)) + '»</div></li>';
              }).join("");
            })
            .catch(function () {
              var ul = document.getElementById("ep-audit");
              if (ul) ul.innerHTML = '<li class="ep-audit-item ep-audit-meta">Kunne ikke laste endringslogg.</li>';
            });
        }

        // Progressive enhancement for save. Same server logic either way:
        // POST /eier/:id/save (no JS) forwards to update-profile. If the fetch
        // itself fails (offline, non-JSON answer), fall back to the plain form
        // POST; form.submit() does not fire this handler again.
        var form = document.getElementById("ep-profile-form");
        if (form && window.fetch) {
          form.addEventListener("submit", function (ev) {
            ev.preventDefault();
            var fd = new FormData(form);
            var payload = {};
            ${JSON.stringify(fieldDefs.map(f => f.key))}.forEach(function (k) {
              var raw = fd.get("field_" + k);
              if (raw !== null) payload[k] = raw;
            });
            var btn = form.querySelector("button[type=submit]");
            if (btn) { btn.disabled = true; btn.textContent = "Lagrer ..."; }
            fetch("/api/agents/${encodeURIComponent(agent.id)}/update-profile", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify(payload),
            }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
              .then(function (out) {
                var base = window.location.pathname;
                if (out.ok && out.body && out.body.success) {
                  window.location.href = base + "?status=saved";
                } else {
                  window.location.href = base + "?status=error";
                }
              }).catch(function () {
                form.submit();
              });
          });
        }
      })();
      </script>
    `;

    return res.send(portalShell(`Eierportal · ${agent.name}`, body));
  } catch (err) {
    console.error("[owner-portal] GET /eier/:agentId/portal error:", err);
    return res.status(500).send(portalShell(
      "Feil",
      `<div class="ep-card"><h1>Noe gikk galt</h1><p>Prøv igjen senere.</p></div>`
    ));
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/agents/:id/order-notifications  { opt_in: boolean }
// POST /eier/:agentId/order-notifications   (form, no-JS fallback)
// ─────────────────────────────────────────────────────────────────
// dev-request 2026-09-16-handleliste slice 4: self-service toggle for
// «Motta bestillinger på e-post». Owner session ONLY (verifyOwnerSession,
// same as the other owner write routes): 401 without session, 403 when the
// session belongs to another agent. Writes agents.order_notifications_opt_in
// (default stays 0 — only an explicit owner action turns it on).
function applyOwnerOrderOptIn(
  req: Request,
  agentId: string,
  rawOptIn: unknown,
): { status: number; body: any } {
  const session = verifyOwnerSession(req);
  if (!session.valid) {
    return { status: 401, body: { success: false, error: "session_invalid", message: "Din sesjon er utløpt. Logg inn på nytt." } };
  }
  if (!ownerSessionAllows(agentId, session)) {
    return { status: 403, body: ownerForbiddenJson(agentId, session) };
  }
  let optIn: 0 | 1;
  if (rawOptIn === true || rawOptIn === 1 || rawOptIn === "1" || rawOptIn === "true") optIn = 1;
  else if (rawOptIn === false || rawOptIn === 0 || rawOptIn === "0" || rawOptIn === "false") optIn = 0;
  else return { status: 400, body: { success: false, error: "bad_opt_in", message: "opt_in må være true eller false." } };
  // F1: turning orders ON needs an owner-verified profile (the real-order
  // gate requires it too). Turning them OFF is always allowed.
  if (optIn === 1) {
    let verified = false;
    try {
      const v = getDb().prepare("SELECT is_verified AS v FROM agents WHERE id = ?").get(agentId) as any;
      verified = !!v && v.v === 1;
    } catch { verified = false; }
    if (!verified) {
      return { status: 409, body: { success: false, error: "ownership_not_verified", message: "Bestillinger kan bare slås på for profiler der eierskapet er bekreftet. Bekreft eierskap først." } };
    }
  }
  // S2b (N1): same UPDATE, plus the owner_feature_audit row for
  // `orders.enabled` in the same transaction when the value changes.
  if (!writeOrderNotificationsOptInWithAudit(getDb(), agentId, optIn === 1, { actor: "owner", detail: ownerSessionEmail(session.token) })) {
    return { status: 404, body: { success: false, error: "agent_not_found" } };
  }
  console.log(`[owner-portal] owner set order_notifications_opt_in=${optIn} for agent ${agentId}`);
  return { status: 200, body: { success: true, agent_id: agentId, order_notifications_opt_in: optIn === 1 } };
}

/** The e-mail the owner session was opened with (audit actor_detail). */
function ownerSessionEmail(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const row = getDb().prepare("SELECT email FROM magic_links WHERE token = ?").get(token) as { email?: string } | undefined;
    return row?.email ?? null;
  } catch {
    return null;
  }
}

router.post("/api/agents/:id/order-notifications", (req: Request, res: Response) => {
  try {
    const out = applyOwnerOrderOptIn(req, String(req.params.id || ""), req.body?.opt_in);
    return res.status(out.status).json(out.body);
  } catch (e: any) {
    console.error("[owner-portal] POST order-notifications failed:", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

router.post("/eier/:agentId/order-notifications", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const agentId = String(req.params.agentId || "");
  try {
    const out = applyOwnerOrderOptIn(req, agentId, req.body?.opt_in);
    if (out.status === 401) return res.redirect(302, `/eier/${encodeURIComponent(agentId)}`);
    if (out.status !== 200) return res.status(out.status).json(out.body);
    return res.redirect(303, `/eier/${encodeURIComponent(agentId)}/portal?status=orders_${out.body.order_notifications_opt_in ? "on" : "off"}#bestillinger`);
  } catch (e: any) {
    console.error("[owner-portal] POST /eier order-notifications failed:", e);
    return res.redirect(303, `/eier/${encodeURIComponent(agentId)}/portal?status=error`);
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/agents/:id/pause  { paused: boolean, until?: "YYYY-MM-DD" }
// POST /eier/:agentId/pause   (form, no-JS fallback)
// S1b punkt 6 — see applyOwnerPause(). Flag off → 404.
// ─────────────────────────────────────────────────────────────────
router.post("/api/agents/:id/pause", (req: Request, res: Response) => {
  try {
    const out = applyOwnerPause(req, String(req.params.id || ""), req.body?.paused, req.body?.until);
    return res.status(out.status).json(out.body);
  } catch (e: any) {
    console.error("[owner-portal] POST pause failed:", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

router.post("/eier/:agentId/pause", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const agentId = String(req.params.agentId || "");
  const base = `/eier/${encodeURIComponent(agentId)}/portal`;
  // Same Origin check as POST /eier/:id/selger: no cross-site trigger.
  if (isCrossSiteWrite(req, "/eier/:agentId/pause")) {
    return res.status(403).send(portalWriteRefusedPage(base));
  }
  try {
    const out = applyOwnerPause(req, agentId, req.body?.paused, req.body?.until);
    if (out.status === 401) return res.redirect(303, `/eier/${encodeURIComponent(agentId)}`);
    if (out.status === 400) return res.redirect(303, `${base}?status=pause_error#pause`);
    if (out.status !== 200) return res.status(out.status).json(out.body);
    return res.redirect(303, `${base}?status=${out.body.paused ? "paused" : "resumed"}#pause`);
  } catch (e: any) {
    console.error("[owner-portal] POST /eier pause failed:", e);
    return res.redirect(303, `${base}?status=pause_error#pause`);
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/agents/:id/order-email      { email }   (JSON)
// POST /eier/:agentId/order-email       (form, no-JS fallback)
// GET  /eier/ordre-epost/bekreft/:token (confirm page — changes nothing)
// POST /eier/ordre-epost/bekreft/:token (writes the new recipient)
// S1b punkt 7 — see requestOwnerOrderEmailChange() /
// confirmOwnerOrderEmailChange(). Flag off → 404.
// ─────────────────────────────────────────────────────────────────
const ORDER_EMAIL_STATUS_ALERTS: Record<string, { ok: boolean; text: string }> = {
  order_email_sent: { ok: true, text: "Vi har sendt en bekreftelse til den nye adressen. Bestillinger går til den gamle adressen til lenken er brukt." },
  order_email_invalid: { ok: false, text: "Skriv inn en gyldig e-postadresse." },
  order_email_same: { ok: false, text: "Bestillinger sendes allerede til denne adressen." },
  order_email_blocked: { ok: false, text: "Vi kan ikke sende bestillinger til denne adressen. Kontakt kontakt@rettfrabonden.com." },
  order_email_rate: { ok: false, text: "For mange forsøk. Prøv igjen om en time." },
  order_email_error: { ok: false, text: "Klarte ikke å sende bekreftelsen. Prøv igjen senere." },
};

const ORDER_EMAIL_ERROR_STATUS: Record<string, string> = {
  invalid_email: "order_email_invalid",
  same_email: "order_email_same",
  email_blocked: "order_email_blocked",
  rate_limited: "order_email_rate",
};

const orderEmailConfirmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: "For mange forsøk. Prøv igjen om litt.",
});

router.post("/api/agents/:id/order-email", async (req: Request, res: Response) => {
  try {
    const out = await requestOwnerOrderEmailChange(req, String(req.params.id || ""), req.body?.email);
    return res.status(out.status).json(out.body);
  } catch (e: any) {
    console.error("[owner-portal] POST order-email failed:", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

router.post("/eier/:agentId/order-email", express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const agentId = String(req.params.agentId || "");
  const base = `/eier/${encodeURIComponent(agentId)}/portal`;
  if (!ownerOrderEmailEnabled()) {
    return res.status(404).send(portalShell("Fant ikke siden", `<div class="ep-card"><h1>Fant ikke siden</h1></div>`));
  }
  // Same Origin check as POST /eier/:id/pause and /selger: no cross-site trigger.
  if (isCrossSiteWrite(req, "/eier/:agentId/order-email")) {
    return res.status(403).send(portalWriteRefusedPage(base));
  }
  try {
    const out = await requestOwnerOrderEmailChange(req, agentId, req.body?.email);
    if (out.status === 401) return res.redirect(303, `/eier/${encodeURIComponent(agentId)}`);
    if (out.status === 200) return res.redirect(303, `${base}?status=order_email_sent#bestillinger`);
    const mapped = ORDER_EMAIL_ERROR_STATUS[String(out.body?.error || "")];
    if (mapped) return res.redirect(303, `${base}?status=${mapped}#bestillinger`);
    if (out.status === 403 && out.body?.error === "ownership_not_verified") return res.status(403).send(ownerNotVerifiedPage(agentId));
    if (out.status === 403) {
      return res.status(403).send(portalShell("Ingen tilgang", `<div class="ep-card"><h1>Ingen tilgang</h1><p>Du har ikke tilgang til denne produsenten.</p></div>`));
    }
    return res.redirect(303, `${base}?status=order_email_error#bestillinger`);
  } catch (e: any) {
    console.error("[owner-portal] POST /eier order-email failed:", e);
    return res.redirect(303, `${base}?status=order_email_error#bestillinger`);
  }
});

function orderEmailNoStore(res: Response): void {
  // The token is in the URL: never cache the page, never leak it as Referer.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
}

const ORDER_EMAIL_TOKEN_ERRORS: Record<string, string> = {
  invalid: "Lenken er ugyldig.",
  used: "Lenken er allerede brukt, eller en nyere endring er bestilt.",
  expired: "Lenken er utløpt. Be om en ny bekreftelse fra eierportalen.",
  not_owned: "Adressen kan ikke endres for denne profilen nå.",
  blocked: "Vi kan ikke sende bestillinger til denne adressen.",
};

function orderEmailTokenErrorPage(reason: string): string {
  const text = ORDER_EMAIL_TOKEN_ERRORS[reason] || ORDER_EMAIL_TOKEN_ERRORS.invalid;
  return portalShell("Kunne ikke bekrefte", `<div class="ep-card">
        <h1>Kunne ikke bekrefte adressen</h1>
        <p>${escapeHtml(text)} Ingenting er endret, og bestillinger går fortsatt til den gamle adressen.</p>
        <p>Trenger du hjelp? Skriv til <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a>.</p>
      </div>`);
}

router.get(`${ORDER_EMAIL_CONFIRM_PATH}/:token`, orderEmailConfirmLimiter, (req: Request, res: Response) => {
  if (!ownerOrderEmailEnabled()) {
    return res.status(404).send(portalShell("Fant ikke siden", `<div class="ep-card"><h1>Fant ikke siden</h1></div>`));
  }
  orderEmailNoStore(res);
  try {
    // Read-only: shows the confirmation form, writes nothing.
    const state = inspectOrderEmailToken(String(req.params.token || ""));
    if (!state.ok) return res.status(400).send(orderEmailTokenErrorPage(state.reason));
    return res.status(200).send(portalShell("Bekreft adresse for bestillinger", `<div class="ep-card">
        <h1>Bekreft adresse for bestillinger</h1>
        <p>Bestillinger fra kunder til <strong>${escapeHtml(state.agentName || "profilen")}</strong> sendes da til <strong>${escapeHtml(state.newEmail)}</strong>.</p>
        <form method="post" action="" style="margin:0;">
          <button type="submit" class="ep-btn ep-btn-primary">Bekreft adressen</button>
        </form>
        <p style="margin-top:12px;color:#737373;font-size:0.88rem;">Kjenner du ikke til dette? Lukk siden, så endres ingenting.</p>
      </div>`));
  } catch (e: any) {
    console.error("[owner-portal] GET order-email confirm failed:", e instanceof Error ? e.message : String(e));
    return res.status(500).send(orderEmailTokenErrorPage("invalid"));
  }
});

router.post(`${ORDER_EMAIL_CONFIRM_PATH}/:token`, orderEmailConfirmLimiter, express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  if (!ownerOrderEmailEnabled()) {
    return res.status(404).send(portalShell("Fant ikke siden", `<div class="ep-card"><h1>Fant ikke siden</h1></div>`));
  }
  orderEmailNoStore(res);
  if (isCrossSiteWrite(req, `${ORDER_EMAIL_CONFIRM_PATH}/:token`)) {
    // Back to the confirmation form this POST came from (the token holder's own link).
    return res.status(403).send(portalWriteRefusedPage(`${ORDER_EMAIL_CONFIRM_PATH}/${encodeURIComponent(String(req.params.token || ""))}`));
  }
  try {
    const state = confirmOwnerOrderEmailChange(String(req.params.token || ""));
    if (!state.ok) return res.status(400).send(orderEmailTokenErrorPage(state.reason));
    return res.status(200).send(portalShell("Adressen er bekreftet", `<div class="ep-card">
        <h1>Adressen er bekreftet</h1>
        <p>Nye bestillinger til <strong>${escapeHtml(state.agentName || "profilen")}</strong> sendes nå til <strong>${escapeHtml(state.newEmail)}</strong>.</p>
        <a class="ep-btn ep-btn-primary" href="/eier/${encodeURIComponent(state.agentId)}/portal#bestillinger">Til eierportalen</a>
      </div>`));
  } catch (e: any) {
    console.error("[owner-portal] POST order-email confirm failed:", e instanceof Error ? e.message : String(e));
    return res.status(500).send(orderEmailTokenErrorPage("invalid"));
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /eier/:agentId/save — graceful-degradation save (forwards to
// JSON update-profile endpoint with cookie-bearing session). Re-renders
// the portal with status query string.
// ─────────────────────────────────────────────────────────────────
router.post("/eier/:agentId/save", express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const agentId = String((req.params as any).agentId || "");
  const session = verifyOwnerSession(req);
  const base = `/eier/${encodeURIComponent(agentId)}/portal`;
  if (!session.valid) {
    return res.redirect(303, `/eier/${encodeURIComponent(agentId)}`);
  }
  if (!ownerSessionAllows(agentId, session)) {
    return session.agentId === agentId
      ? res.status(403).send(ownerNotVerifiedPage(agentId))
      : res.redirect(303, `/eier/${encodeURIComponent(agentId)}`);
  }
  // T0a: same-origin write guard (before this only SameSite=Lax protected it).
  if (isCrossSiteWrite(req, "/eier/:agentId/save")) {
    return res.status(403).send(portalWriteRefusedPage(base));
  }
  try {
    // Build whitelisted JSON payload from form fields
    const payload: Record<string, any> = {};
    for (const key of EDITABLE_FIELDS) {
      const v = (req.body as any)[`field_${key}`];
      if (v !== undefined) payload[key] = String(v);
    }
    const url = `${req.protocol}://${req.get("host")}/api/agents/${encodeURIComponent(agentId)}/update-profile`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.token || ""}`,
      },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      return res.redirect(303, `${base}?status=saved`);
    }
    return res.redirect(303, `${base}?status=error`);
  } catch (err) {
    console.error("[owner-portal] POST /eier/:agentId/save error:", err);
    return res.redirect(303, `${base}?status=error`);
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /eier/:agentId/logout — clear session cookie + redirect to producer page
// ─────────────────────────────────────────────────────────────────
router.post("/eier/:agentId/logout", (req: Request, res: Response) => {
  const agentId = String((req.params as any).agentId || "");
  const db = getDb();
  // S1b punkt 5: revoke the token itself, not only the browser cookie — a
  // copied cookie value / Bearer token is unusable after logout.
  for (const t of presentedOwnerTokens(req)) revokeOwnerSessionToken(t);
  const agent = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(agentId) as any;
  if (agent) (agent as any).slug = slugify(String(agent.name || ""));
  // Clear cookie (matching attributes used at set time so browsers honour it)
  res.clearCookie("rfb_owner_session", {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });
  const target = agent && agent.slug ? `/produsent/${encodeURIComponent(agent.slug)}` : "/";
  return res.redirect(303, target);
});

// ─────────────────────────────────────────────────────────────────
// POST /eier/:agentId/selger — products / opening hours / availability with
// the SAME login (S1b punkt 5, OWNER_UNIFIED_SESSION_ENABLED, default off)
// ─────────────────────────────────────────────────────────────────
// The /selger editor authenticates with the verified claimant's claim token.
// Instead of a second e-mail, a logged-in verified owner gets a one-time,
// 15-minute /selger login (the same magic_links row knowledge-service
// createMagicLink writes, used = 0) and is redirected straight into the
// existing /selger?magic= auto-login. Only for the verified claimant whose
// e-mail opened this session — an e-mail-match session never receives a
// claim token. POST + SameSite=Lax cookie + Origin check: no cross-site
// trigger.
// The Origin check itself lives in src/middleware/same-origin-write.ts
// (isCrossSiteWrite); refusals render portalWriteRefusedPage().

/**
 * The verified claimant's e-mail when this session was opened by that
 * claimant's own address, else null. Rule: the session's magic-link e-mail
 * (magic_links.email for session.token, trimmed + lowercased) equals the
 * claimant_email of a status='verified' agent_claims row for this agent
 * (case/whitespace-insensitive). Stricter than isVerifiedOwner (an e-mail-match
 * session on a claimed profile is a verified owner but not the claimant).
 * Used by POST /eier/:id/selger and the B1/B2 product-write POSTs. Callers
 * check isVerifiedOwner first.
 */
export function sessionClaimantOwnerEmail(
  agentId: string,
  session: { token?: string } | null | undefined,
): string | null {
  if (!agentId || !session || !session.token) return null;
  const db = getDb();
  const link = db
    .prepare(`SELECT email FROM magic_links WHERE token = ?`)
    .get(session.token) as { email?: string } | undefined;
  const sessionEmail = String(link?.email || "").trim().toLowerCase();
  if (!sessionEmail) return null;
  const claim = db.prepare(
    `SELECT claimant_email FROM agent_claims
     WHERE agent_id = ? AND status = 'verified' AND LOWER(TRIM(claimant_email)) = ?
     ORDER BY verified_at DESC LIMIT 1`
  ).get(agentId, sessionEmail) as { claimant_email?: string } | undefined;
  return claim?.claimant_email ? claim.claimant_email : null;
}

router.post("/eier/:agentId/selger", (req: Request, res: Response) => {
  const agentId = String((req.params as any).agentId || "");
  if (!ownerUnifiedSessionEnabled()) {
    return res.status(404).send(portalShell("Fant ikke siden", `<div class="ep-card"><h1>Fant ikke siden</h1></div>`));
  }
  try {
    const session = verifyOwnerSession(req);
    if (!session.valid) return res.redirect(303, `/eier/${encodeURIComponent(agentId)}`);
    if (isCrossSiteWrite(req, "/eier/:agentId/selger")) return res.status(403).send(portalWriteRefusedPage(`/eier/${encodeURIComponent(agentId)}/portal`));
    // Always the strict predicate here (independent of the gate flag): this
    // hands out the products editor.
    if (!isVerifiedOwner(agentId, session)) {
      return session.agentId === agentId
        ? res.status(403).send(ownerNotVerifiedPage(agentId))
        : res.redirect(303, `/eier/${encodeURIComponent(agentId)}`);
    }
    const claimantEmail = sessionClaimantOwnerEmail(agentId, session);
    if (!claimantEmail) {
      // Verified owner, but this session was not opened by the claimant's
      // own address: the /selger editor needs its own login.
      return res.redirect(303, `/selger?agent=${encodeURIComponent(agentId)}`);
    }
    const db = getDb();
    const token = crypto.randomBytes(32).toString("hex");
    const now = new Date();
    db.prepare(
      `INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    ).run(`${OWNER_BRIDGE_ID_PREFIX}${crypto.randomBytes(8).toString("hex")}`, claimantEmail, token, agentId,
      now.toISOString(), new Date(now.getTime() + OWNER_BRIDGE_VALID_MS).toISOString());
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.redirect(303, `/selger?magic=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error("[owner-portal] POST /eier/:agentId/selger error:", err instanceof Error ? err.message : "error");
    return res.redirect(303, `/eier/${encodeURIComponent(agentId)}/portal?status=error`);
  }
});

/** Portal card (flag on only): products, opening hours, availability via /selger. */
export function ownerSelgerCardHtml(agentId: string): string {
  if (!ownerUnifiedSessionEnabled()) return "";
  const id = encodeURIComponent(agentId);
  return `<div class="ep-card" id="produkter">
        <h2>Produkter og åpningstider</h2>
        <p style="margin-bottom:12px;color:#737373;font-size:0.88rem;">Rediger produkter, åpningstider og tilgjengelighet. Du er allerede logget inn.</p>
        <form method="post" action="/eier/${id}/selger" style="margin:0;">
          <button type="submit" class="ep-btn ep-btn-primary">Rediger produkter og åpningstider</button>
        </form>
      </div>`;
}

// ─────────────────────────────────────────────────────────────────
// B1 (dev-request «RFB bestillinger fra start til slutt for eier»):
// «Varer som kan bestilles» card + three form POSTs, behind
// OWNER_ORDERABILITY_PORTAL_ENABLED (default off; off → no card, routes 404)
// and, B1a, the owner-features allowlist (OWNER_FEATURES_ALLOWED_SUBJECTS,
// `rfb:<id>`; off the list → the same 404, as if the flag were off).
//   POST /eier/:agentId/varer/:productId/bekreft  — «Bekreft at varen er på lager»
//   POST /eier/:agentId/varer/bekreft-alle        — «Bekreft alle på lager»
//   POST /eier/:agentId/varer/ny                  — «Legg til vare»
// Owner checks as POST /eier/:id/selger (it also hands out product editing):
// valid owner session (none → login), Origin check (cross-site → 403),
// always the strict isVerifiedOwner predicate, and (B1b-1) the session's
// magic-link e-mail must be the verified claimant's (sessionClaimantOwnerEmail,
// else 403 «logg inn med eierens e-post»). Reads (the card) stay on
// isVerifiedOwner. Writes: services/owner-orderability.ts
// (stock through supply-graph setProducerAvailabilityByProductId, the
// existing write path; parameterized SQL; agent_knowledge_audit row).
// ─────────────────────────────────────────────────────────────────

export const ORDERABILITY_ANCHOR = "bestillbare-varer";

/** status=… after a B1 POST → the portal alert. null = not a B1 status. */
export function ownerOrderabilityAlert(status: string, rawFields: unknown, rawNoPrice?: unknown): { ok: boolean; text: string } | null {
  const noPriceN = typeof rawNoPrice === "string" && /^\d{1,5}$/.test(rawNoPrice) ? Number(rawNoPrice) : 0;
  const noPrice = noPriceN > 0
    ? ` ${noPriceN} ${noPriceN === 1 ? "vare" : "varer"} uten pris ble ikke bekreftet — legg inn pris først.`
    : "";
  switch (status) {
    case "vare_bekreftet": return { ok: true, text: "Varen er bekreftet på lager." };
    case "lager_bekreftet": return { ok: true, text: "Takk! Varene er bekreftet på lager." };
    case "varer_bekreftet": return { ok: true, text: `Varene er bekreftet på lager.${noPrice}` };
    case "ingen_varer_bekreftet": return { ok: true, text: `Ingen varer å bekrefte.${noPrice}` };
    case "vare_mangler_pris": return { ok: false, text: "Varen mangler pris, så den kan ikke bekreftes her. Legg inn pris først." };
    case "vare_lagt_til": return { ok: true, text: "Varen er lagt til og bekreftet på lager." };
    case "vare_finnes": return { ok: false, text: "Du har allerede en vare med det navnet. Bekreft den i listen i stedet." };
    case "vare_kan_ikke_bekreftes": return { ok: false, text: "Denne varen kan ikke bestilles her, så den kan ikke bekreftes." };
    case "vare_feil": return { ok: false, text: "Klarte ikke å lagre. Prøv igjen." };
    case "vare_ugyldig": {
      const fields = String(typeof rawFields === "string" ? rawFields : "")
        .split(",")
        .filter((f): f is OwnerProductField => Object.prototype.hasOwnProperty.call(OWNER_PRODUCT_FIELD_TEXT_NB, f));
      const detail = fields.map((f) => OWNER_PRODUCT_FIELD_TEXT_NB[f]).join(" ");
      return { ok: false, text: `Varen ble ikke lagt til. ${detail || "Sjekk feltene og prøv igjen."}` };
    }
    default: return null;
  }
}

function formatOwnerPrice(price: number | null, unit: string | null): string {
  if (price == null) return "Ingen pris";
  const p = Number.isInteger(price) ? String(price) : price.toFixed(2).replace(".", ",");
  return `kr ${p}${unit ? ` / ${unit}` : ""}`;
}

/** The B1 card. Pure rendering of listOwnerProductOrderability(). */
export function ownerOrderabilityCardHtml(agentId: string, o: OwnerOrderabilityOverview, bannerHtml = ""): string {
  const id = encodeURIComponent(agentId);
  const total = o.products.length;
  const profileHtml = o.profile_reasons.length
    ? `<div class="ep-alert ep-alert-error" role="note" data-orderability-profile="blocked">Ingen varer kan bestilles før dette er ordnet:<ul>${o.profile_reasons.map((r) => `<li>${escapeHtml(orderabilityReasonTextNb(r))}</li>`).join("")}</ul></div>`
    : "";
  const rows = o.products.map((p) => {
    const status = p.orderable
      ? `<strong class="ep-orderable-yes">Kan bestilles</strong>${p.stock_expires_at ? ` <span class="ep-audit-meta">Lagerstatus gjelder til ${escapeHtml(formatOwnerDate(p.stock_expires_at))}</span>` : ""}`
      : `<strong class="ep-orderable-no">Kan ikke bestilles</strong><ul class="ep-orderable-reasons">${p.reasons.map((r) => `<li data-reason="${escapeHtml(r.code)}">${escapeHtml(orderabilityReasonTextNb(r))}</li>`).join("")}</ul>`;
    const noPrice = p.missing_price
      ? `<div class="ep-audit-meta" data-missing-price="1">Mangler pris — legg inn pris før du bekrefter at varen er på lager.</div>`
      : "";
    const confirm = p.confirmable
      ? `<form method="post" action="/eier/${id}/varer/${encodeURIComponent(p.id)}/bekreft" style="margin:6px 0 0;">
            <button type="submit" class="ep-btn ep-btn-secondary">Bekreft at varen er på lager</button>
          </form>`
      : "";
    return `<li class="ep-audit-item" data-product-id="${escapeHtml(p.id)}" data-orderable="${p.orderable ? "1" : "0"}">
          <div><strong>${escapeHtml(p.name)}</strong> <span class="ep-audit-meta">${escapeHtml(formatOwnerPrice(p.price_nok, p.unit))}</span></div>
          <div>${status}</div>
          ${noPrice}
          ${confirm}
        </li>`;
  }).join("");
  const list = total
    ? `<ul class="ep-audit-list">${rows}</ul>
        <form method="post" action="/eier/${id}/varer/bekreft-alle" style="margin:12px 0 0;">
          <button type="submit" class="ep-btn ep-btn-primary">Bekreft alle på lager</button>
        </form>`
    : `<p>Du har ingen varer ennå. Legg til en vare under.</p>`;
  const field = (name: string, label: string, type = "text", extra = "") =>
    `<div class="ep-field"><label for="ny_${name}">${escapeHtml(label)}</label><input id="ny_${name}" name="${name}" type="${type}" ${extra}></div>`;
  return `<div class="ep-card" id="${ORDERABILITY_ANCHOR}">
        <h2>Varer som kan bestilles</h2>
        ${bannerHtml}
        <p data-orderable-count="${o.orderable_count}">${o.orderable_count} av ${total} ${total === 1 ? "vare" : "varer"} kan bestilles nå. En bekreftelse på lager gjelder i ${getSupplyGraphStaleDays()} dager.</p>
        ${profileHtml}
        ${list}
        <h3 style="margin-top:20px;">Legg til vare</h3>
        <form method="post" action="/eier/${id}/varer/ny">
          ${field("name", "Navn", "text", 'required maxlength="120"')}
          ${field("price", "Pris (kr)", "text", 'required inputmode="decimal"')}
          ${field("unit", "Enhet (f.eks. kg, stk)", "text", 'maxlength="30"')}
          <div class="ep-field"><label for="ny_ingredients">Ingredienser (valgfritt)</label><textarea id="ny_ingredients" name="ingredients" maxlength="1500"></textarea></div>
          ${field("allergens", "Allergener (valgfritt, skill med komma)", "text")}
          ${field("net_weight", "Nettovekt (valgfritt, f.eks. 250 g)", "text", 'maxlength="20"')}
          <div class="ep-form-actions"><button type="submit" class="ep-btn ep-btn-primary">Legg til vare</button></div>
        </form>
      </div>`;
}

/** 403 page: verified owner, but this session was not opened by the claimant's own e-mail. */
export function ownerProductsNeedClaimantLoginPage(agentId: string): string {
  const id = encodeURIComponent(agentId);
  return portalShell(
    "Logg inn med eierens e-post",
    `<div class="ep-card" data-claimant-login-required="1">
          <h1>Logg inn med eierens e-postadresse</h1>
          <p>For å endre varene må du logge inn med e-postadressen til den som har bekreftet eierskapet til profilen. Du kan fortsatt se varene i portalen.</p>
          <a class="ep-btn ep-btn-primary" href="/selger?agent=${id}">Logg inn med eierens e-post</a>
        </div>`
  );
}

type OwnerOrderabilityAuth = { ok: true; agentId: string; email: string | null } | { ok: false };

/** Flag + allowlist, session, Origin and strict ownership for the B1 POSTs; answers itself on failure. */
function ownerOrderabilityAuth(req: Request, res: Response): OwnerOrderabilityAuth {
  const agentId = String((req.params as any).agentId || "");
  if (!ownerOrderabilityPortalEnabledFor(agentId)) {
    res.status(404).send(portalShell("Fant ikke siden", `<div class="ep-card"><h1>Fant ikke siden</h1></div>`));
    return { ok: false };
  }
  const session = verifyOwnerSession(req);
  if (!session.valid) {
    res.redirect(303, `/eier/${encodeURIComponent(agentId)}`);
    return { ok: false };
  }
  if (isCrossSiteWrite(req)) {
    res.status(403).send(portalWriteRefusedPage(`/eier/${encodeURIComponent(agentId)}/portal`));
    return { ok: false };
  }
  if (!isVerifiedOwner(agentId, session)) {
    if (session.agentId === agentId) res.status(403).send(ownerNotVerifiedPage(agentId));
    else res.redirect(303, `/eier/${encodeURIComponent(agentId)}`);
    return { ok: false };
  }
  // B1b-1: these POSTs make products orderable (real orders), so — as for
  // /selger — only a session opened by the verified claimant's own address may
  // write. A verified owner on another address still sees the card (GET).
  if (!sessionClaimantOwnerEmail(agentId, session)) {
    res.status(403).send(ownerProductsNeedClaimantLoginPage(agentId));
    return { ok: false };
  }
  return { ok: true, agentId, email: ownerSessionEmail(session.token) };
}

function orderabilityBack(agentId: string, status: string, extra = ""): string {
  return `/eier/${encodeURIComponent(agentId)}/portal?status=${status}${extra}#${ORDERABILITY_ANCHOR}`;
}

// B2 (products.stock_check): the banner above the list and its one POST.
//   POST /eier/:agentId/varer/bekreft-lagerpaminnelse — «Bekreft at varene
//   fortsatt er på lager» for the listed ids (hidden fields); the service
//   writes only the rows still orderable apart from the expiry and
//   confirmable under the B1 rule. Same owner checks as the B1 POSTs.

/** The B2 banner: the orderable items whose stock status expires within 3 days. "" when none. */
export function stockCheckBannerHtml(agentId: string, items: StockCheckItem[]): string {
  if (items.length === 0) return "";
  const id = encodeURIComponent(agentId);
  const lis = items.map((i) => `<li data-product-id="${escapeHtml(i.id)}">${escapeHtml(i.name)} <span class="ep-audit-meta">gjelder til ${escapeHtml(formatStockCheckDate(i.expires_at))}</span></li>`).join("");
  const hidden = items.map((i) => `<input type="hidden" name="id" value="${escapeHtml(i.id)}">`).join("");
  return `<div class="ep-alert ep-alert-error" role="note" data-stock-check-banner="1">
          <strong>Lagerstatusen går snart ut</strong>
          <p style="margin:6px 0;">Når den har gått ut, kan kundene ikke bestille ${items.length === 1 ? "varen" : "varene"} før du har bekreftet ${items.length === 1 ? "den" : "dem"} igjen.</p>
          <ul>${lis}</ul>
          <form method="post" action="/eier/${id}/varer/bekreft-lagerpaminnelse" style="margin:8px 0 0;">
            ${hidden}
            <button type="submit" class="ep-btn ep-btn-primary">Bekreft at varene fortsatt er på lager</button>
          </form>
        </div>`;
}

router.post("/eier/:agentId/varer/bekreft-lagerpaminnelse", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const auth = ownerOrderabilityAuth(req, res);
  if (!auth.ok) return;
  try {
    const raw = (req.body || {}).id;
    const ids = (Array.isArray(raw) ? raw : [raw]).filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200).slice(0, 200);
    const r = confirmStockCheckItems(auth.agentId, ids, { actorEmail: auth.email, via: "portal" });
    return res.redirect(303, orderabilityBack(auth.agentId, r.confirmed.length > 0 ? "lager_bekreftet" : "ingen_varer_bekreftet"));
  } catch (err) {
    console.error("[owner-portal] POST varer/bekreft-lagerpaminnelse error:", err instanceof Error ? err.message : "error");
    return res.redirect(303, orderabilityBack(auth.agentId, "vare_feil"));
  }
});

router.post("/eier/:agentId/varer/bekreft-alle", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const auth = ownerOrderabilityAuth(req, res);
  if (!auth.ok) return;
  try {
    const r = confirmAllOwnerProductsInStock(auth.agentId, { actorEmail: auth.email });
    const extra = r.skipped_missing_price > 0 ? `&uten_pris=${r.skipped_missing_price}` : "";
    return res.redirect(303, orderabilityBack(auth.agentId, r.confirmed > 0 ? "varer_bekreftet" : "ingen_varer_bekreftet", extra));
  } catch (err) {
    console.error("[owner-portal] POST varer/bekreft-alle error:", err instanceof Error ? err.message : "error");
    return res.redirect(303, orderabilityBack(auth.agentId, "vare_feil"));
  }
});

router.post("/eier/:agentId/varer/ny", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const auth = ownerOrderabilityAuth(req, res);
  if (!auth.ok) return;
  try {
    const b = (req.body || {}) as Record<string, unknown>;
    const r = addOwnerProduct(auth.agentId, {
      name: b.name, price: b.price, unit: b.unit, ingredients: b.ingredients, allergens: b.allergens, net_weight: b.net_weight,
    }, { actorEmail: auth.email });
    if (r.ok) return res.redirect(303, orderabilityBack(auth.agentId, "vare_lagt_til"));
    if (r.error === "exists") return res.redirect(303, orderabilityBack(auth.agentId, "vare_finnes"));
    return res.redirect(303, orderabilityBack(auth.agentId, "vare_ugyldig", `&felt=${encodeURIComponent(r.fields.join(","))}`));
  } catch (err) {
    console.error("[owner-portal] POST varer/ny error:", err instanceof Error ? err.message : "error");
    return res.redirect(303, orderabilityBack(auth.agentId, "vare_feil"));
  }
});

router.post("/eier/:agentId/varer/:productId/bekreft", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const auth = ownerOrderabilityAuth(req, res);
  if (!auth.ok) return;
  try {
    const r = confirmOwnerProductInStock(auth.agentId, String((req.params as any).productId || ""), { actorEmail: auth.email });
    if (r.ok) return res.redirect(303, orderabilityBack(auth.agentId, "vare_bekreftet"));
    if (r.error === "missing_price") return res.redirect(303, orderabilityBack(auth.agentId, "vare_mangler_pris"));
    if (r.error === "not_found") {
      return res.status(404).send(portalShell("Fant ikke varen", `<div class="ep-card"><h1>Fant ikke varen</h1><p><a href="/eier/${encodeURIComponent(auth.agentId)}/portal#${ORDERABILITY_ANCHOR}">Tilbake til varene</a></p></div>`));
    }
    return res.redirect(303, orderabilityBack(auth.agentId, "vare_kan_ikke_bekreftes"));
  } catch (err) {
    console.error("[owner-portal] POST varer/:productId/bekreft error:", err instanceof Error ? err.message : "error");
    return res.redirect(303, orderabilityBack(auth.agentId, "vare_feil"));
  }
});

// ─────────────────────────────────────────────────────────────────
// Produktimport skive 3-2 (dev-request 2026-10-21-rfb-produktimport-fra-
// egen-nettside): portal card «Hent produkter fra nettsiden min». Rendered
// only with PRODUCT_IMPORT_ENABLED on, for a verified owner (isVerifiedOwner)
// of a profile with agents.is_verified = 1 and a stored website. Hiding the
// card is not the protection: the form routes (routes/owner-product-import.ts)
// run the same checks as the JSON API on every call.
// ─────────────────────────────────────────────────────────────────

export const PRODUCT_IMPORT_ANCHOR = "produktimport";

/** The UTC "YYYY-MM-DD HH:MM:SS" run timestamp as an owner-readable date + time (Europe/Oslo). "" when unreadable. */
export function formatImportRunTime(sqlTs: string | null | undefined): string {
  if (!sqlTs) return "";
  const d = new Date(/T/.test(sqlTs) ? sqlTs : `${sqlTs.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("nb-NO", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * A fetch outcome in plain Norwegian, for the zero-result screen and the
 * card. Covers the extractor's outcome codes (ok, no_products_found,
 * robots_blocked, fetch_failed:*, js_unreadable, grounding_rejected_all) and
 * the run-level ones (timeout, failed, interrupted). null for ok / unknown.
 */
export function productImportOutcomeTextNb(outcome: string | null | undefined): string | null {
  if (!outcome || outcome === "ok") return null;
  if (outcome === "no_products_found") return "Vi leste nettsiden, men fant ingen varer med pris der.";
  if (outcome === "robots_blocked") return "Nettsiden ber roboter om ikke å lese sidene (robots.txt), så vi hentet ingenting.";
  if (outcome === "js_unreadable") return "Nettsiden bygges med JavaScript i nettleseren, så vi kunne ikke lese produktene.";
  if (outcome === "grounding_rejected_all") return "Det vi fant, sto ikke ordrett på nettsiden, så vi tok det ikke med.";
  if (outcome.startsWith("fetch_failed")) return "Vi fikk ikke kontakt med nettsiden. Sjekk at adressen i profilen er riktig.";
  if (outcome === "timeout") return "Hentingen tok for lang tid og ble stoppet.";
  if (outcome === "interrupted") return "Hentingen ble avbrutt før den var ferdig.";
  if (outcome === "failed") return "Noe gikk galt under hentingen.";
  return null;
}

/** status=produktimport_… after a form POST → the card's alert. null = not ours. */
export function productImportPortalAlert(
  status: string,
  query: { publisert?: unknown; fjernet?: unknown; avvist?: unknown },
  stockHint: string,
): { ok: boolean; html: string } | null {
  const num = (v: unknown) => (typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : 0);
  const varer = (n: number) => `${n} ${n === 1 ? "vare" : "varer"}`;
  switch (status) {
    case "produktimport_publisert": {
      const pub = num(query.publisert);
      const rem = num(query.fjernet);
      const rej = num(query.avvist);
      const parts: string[] = [];
      parts.push(`${varer(pub)} publisert`);
      if (rem > 0) parts.push(`${varer(rem)} fjernet`);
      let text = `${parts.join(" og ")}.`;
      if (rej > 0) text += ` ${varer(rej)} kunne ikke legges inn (kategorinavn, alkohol eller tjeneste).`;
      return {
        ok: true,
        html: `<span data-import-published="${pub}" data-import-removed="${rem}">${escapeHtml(text)}</span>${pub > 0 ? ` ${stockHint}` : ""}`,
      };
    }
    case "produktimport_grense": return { ok: false, html: escapeHtml(OWNER_FETCH_DAILY_LIMIT_MESSAGE) };
    case "produktimport_opptatt": return { ok: false, html: escapeHtml(OWNER_FETCH_BUSY_MESSAGE) };
    case "produktimport_pagar": return { ok: false, html: escapeHtml(`${OWNER_FETCH_RUNNING_MESSAGE} Prøv igjen om litt.`) };
    case "produktimport_ingen_nettside": return { ok: false, html: escapeHtml(OWNER_IMPORT_NO_WEBSITE_MESSAGE) };
    case "produktimport_feil": return { ok: false, html: "Noe gikk galt. Prøv igjen om litt." };
    default: return null;
  }
}

/** Where imported products are made orderable: the B1 card when it is on for this profile, else a plain sentence. */
export function productImportStockHintHtml(agentId: string): string {
  let b1 = false;
  try { b1 = ownerOrderabilityPortalEnabledFor(agentId); } catch { b1 = false; }
  const text = "Importerte varer kan ikke bestilles før du har bekreftet at de er på lager";
  return b1
    ? `<span data-stock-hint="b1">${text} under <a href="/eier/${encodeURIComponent(agentId)}/portal#${ORDERABILITY_ANCHOR}">«Varer som kan bestilles»</a>.</span>`
    : `<span data-stock-hint="text">${text}.</span>`;
}

/** Card visibility: flag on, verified owner of this profile, agents.is_verified = 1, a stored website. */
export function productImportCardVisible(agentId: string, session: { valid: boolean; agentId?: string }, agentIsVerified: number): boolean {
  if (!productImportEnabled()) return false;
  if (agentIsVerified !== 1) return false;
  if (!isVerifiedOwner(agentId, session)) return false;
  return !!profileWebsite(agentId);
}

type ImportOverview = ReturnType<typeof getOwnerImportOverview>;

/** One run's status line for the card. */
function importRunStatusText(run: ImportOverview["runs"][number]): string {
  const when = formatImportRunTime(run.created_at);
  const at = when ? ` (${when})` : "";
  if (run.status === "running") return `Henter produkter nå${at}. Siden med forslag oppdaterer seg selv.`;
  if (run.status === "completed") {
    const l = run.log;
    if (l.published_by_owner) return `Siste henting${at}: ${l.count_published} publisert, ${l.count_removed} fjernet.`;
    const found = l.count_new + l.count_changed;
    if (found === 0 && run.outcome !== "ok") {
      return `Siste henting${at}: Fant ingen produkter med pris. ${productImportOutcomeTextNb(run.outcome) ?? ""}`.trim();
    }
    return `Siste henting${at}: ${l.count_new} nye, ${l.count_changed} med endret pris eller enhet, ${l.count_not_found} ikke funnet. Ikke publisert ennå.`;
  }
  return `Siste henting${at} ble ikke fullført. ${productImportOutcomeTextNb(run.outcome) ?? ""}`.trim();
}

/** The card. Pure rendering of getOwnerImportOverview() (+ an optional alert). */
export function productImportCardHtml(agentId: string, o: ImportOverview, alertHtml = ""): string {
  const id = encodeURIComponent(agentId);
  const website = o.website ?? "";
  const websiteHtml = /^https?:\/\//i.test(website)
    ? `<a href="${escapeHtml(website)}" rel="noopener nofollow" target="_blank">${escapeHtml(website)}</a>`
    : escapeHtml(website);
  const latest = o.runs[0] ?? null;
  const running = latest?.status === "running";
  const latestHtml = latest
    ? `<p data-import-latest-status="${escapeHtml(latest.status)}"${latest.outcome ? ` data-import-latest-outcome="${escapeHtml(latest.outcome)}"` : ""}>${escapeHtml(importRunStatusText(latest))}
          <a href="/eier/${id}/produktimport/${encodeURIComponent(latest.run_id)}">${running ? "Følg hentingen" : "Se forslagene"}</a></p>`
    : `<p class="ep-audit-meta">Du har ikke hentet produkter fra nettsiden ennå.</p>`;
  const action = running
    ? ""
    : o.fetches_left_today <= 0
      ? `<p class="ep-audit-meta" data-import-limit="1">${escapeHtml(OWNER_FETCH_DAILY_LIMIT_MESSAGE)}</p>`
      : `<form method="post" action="/eier/${id}/produktimport/hent" style="margin:8px 0 0;">
            <button type="submit" class="ep-btn ep-btn-primary">Hent produkter fra nettsiden min</button>
          </form>`;
  return `<div class="ep-card" id="${PRODUCT_IMPORT_ANCHOR}" data-product-import-card="1">
        <h2>Hent produkter fra nettsiden min</h2>
        ${alertHtml}
        <p>Vi leser produktene og prisene på <strong>${websiteHtml}</strong> og viser deg forslagene før noe blir lagt inn. Ingenting publiseres før du har valgt varene og trykket «Publiser valgte».</p>
        <p class="ep-audit-meta" data-fetches-left="${o.fetches_left_today}">Du kan hente ${o.fetches_left_today} ${o.fetches_left_today === 1 ? "gang" : "ganger"} til i dag (høyst ${o.daily_limit} per døgn).</p>
        ${latestHtml}
        ${action}
      </div>`;
}

// ─────────────────────────────────────────────────────────────────
// GET /api/agents/:agentId/my-audit — owner-side audit feed (session-gated)
// ─────────────────────────────────────────────────────────────────
// Same shape as the Daniel-only /admin/agent-audit endpoint, but auth-gated
// to the owner's session cookie (NOT admin-key). Returns last N audit
// entries for *this* agent only.
router.get("/api/agents/:agentId/my-audit", (req: Request, res: Response) => {
  try {
    const agentId = String((req.params as any).agentId || "");
    const session = verifyOwnerSession(req);
    if (!session.valid) {
      return res.status(401).json({
        success: false,
        error: "session_invalid",
        message: "Din sesjon er utløpt. Logg inn på nytt.",
      });
    }
    if (!ownerSessionAllows(agentId, session)) {
      return res.status(403).json(ownerForbiddenJson(agentId, session));
    }

    const limitNum = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 200);

    const db = getDb();
    const audits = db
      .prepare(
        `SELECT id, agent_id, field_name, old_value, new_value,
                changed_by, changed_by_email, changed_at, notes
           FROM agent_knowledge_audit
          WHERE agent_id = ?
          ORDER BY changed_at DESC
          LIMIT ?`
      )
      .all(agentId, limitNum) as any[];

    return res.json({
      success: true,
      count: audits.length,
      agent_id: agentId,
      audits,
    });
  } catch (err) {
    console.error("[owner-portal] my-audit error:", err);
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: "En feil oppstod.",
    });
  }
});

/**
 * The portal card «Statistikk»'s 12-month numbers: the same getOwnerStats()
 * read as the Statistikk tab (same path derivation as the owner-stats route
 * below). null on a failed read (the card then shows «—»).
 */
export function ownerPortalYearStats(db: any, agentId: string, agentName: string): ReturnType<typeof getOwnerStats>["year"] | null {
  try {
    return getOwnerStats(db, agentId, `/produsent/${slugify(agentName)}`).year;
  } catch (err) {
    console.error("[owner-portal] portal stats card read failed:", err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// GET /api/agents/:id/owner-stats — full "Statistikk" tab data (session-gated)
// ─────────────────────────────────────────────────────────────────
// dev-request 2026-07-03-agent-profile-conversations-stats, slice 3, work
// items 5+6. Deliberately NOT the same path as the public, unauthenticated
// GET /api/agents/:id/stats in src/routes/agent-stats.ts (that route
// already exists and returns a different, smaller public payload — reusing
// its exact path here would either collide or silently change public
// behavior, neither of which is additive). This is the full owner-only
// package: views over time by source, AI-platform split, matching search
// queries, conversations per channel, contact-clicks by kind (labeled
// "kontakt-klikk" — click intent, not confirmed contact), and a
// discovered→viewed→kontakt-klikk funnel. All aggregation logic lives in
// src/services/owner-stats-service.ts (see its module doc for the exact
// is_bot/is_owner filtering applied — and honestly documented gaps — per
// table).
//
// Auth: same magic-link session mechanism as every other owner-facing
// endpoint in this file (verifyOwnerSession — rfb_owner_session cookie or
// Bearer token, backed by the magic_links table). No new auth scheme.
router.get("/api/agents/:id/owner-stats", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const session = verifyOwnerSession(req);

    if (!session.valid) {
      return res.status(401).json({
        success: false,
        error: "session_invalid",
        message: "Din sesjon er utløpt. Logg inn på nytt.",
      });
    }

    if (!ownerSessionAllows(id, session)) {
      return res.status(403).json(ownerForbiddenJson(id, session));
    }

    const db = getDb();
    const agent = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(id) as any;
    if (!agent) {
      return res.status(404).json({
        success: false,
        error: "agent_not_found",
        message: "Agenten ble ikke funnet.",
      });
    }

    // Same slug derivation as agent-stats.ts / profile-activity-service.ts's
    // caller in seo.ts — the path analytics_page_views actually recorded.
    const path = `/produsent/${slugify(String(agent.name || ""))}`;
    const stats = getOwnerStats(db, id, path);

    // Short private cache — this is session-gated, per-owner data, not a
    // public/shared response (contrast agent-stats.ts's public 5-min cache).
    res.setHeader("Cache-Control", "private, max-age=60");

    return res.json({ success: true, agentId: id, ...stats });
  } catch (error) {
    console.error("[owner-portal] owner-stats error:", error);
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: "En feil oppstod.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/agents/:id/orders — "Bestillinger" tab data (session-gated)
// ─────────────────────────────────────────────────────────────────
// dev-request 2026-07-13-produsent-dashboard-verdibevis, criterion 2
// ("order inbox"). The producer-FACING sibling of the ADMIN-only
// GET /admin/orders/inbox in src/routes/admin-orders.ts (that route's own
// comment already flagged "the producer dashboard can consume this later"
// — this is that later). Unlike the admin inbox, this is NOT filtered to
// open statuses only — a producer should see their full order history, not
// just active orders — and it is gated by the owner's own session instead
// of X-Admin-Key.
//
// Auth: identical convention to GET /api/agents/:id/owner-stats immediately
// above (verifyOwnerSession — rfb_owner_session cookie or Bearer token,
// backed by the magic_links table). Same error shape, same status codes.
router.get("/api/agents/:id/orders", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const session = verifyOwnerSession(req);

    if (!session.valid) {
      return res.status(401).json({
        success: false,
        error: "session_invalid",
        message: "Din sesjon er utløpt. Logg inn på nytt.",
      });
    }

    if (!ownerSessionAllows(id, session)) {
      return res.status(403).json(ownerForbiddenJson(id, session));
    }

    const db = getDb();
    const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(id) as any;
    if (!agent) {
      return res.status(404).json({
        success: false,
        error: "agent_not_found",
        message: "Agenten ble ikke funnet.",
      });
    }

    // All statuses (pending/confirmed/declined/ready/completed/cancelled) —
    // deliberately NOT filtered to open-only like the admin inbox, since
    // this is the producer's own order history. LIMIT 100: this is a
    // dashboard tab, not an export.
    const rows = db.prepare(`
      SELECT o.id AS order_id, o.status, o.pickup_time, o.total_nok,
             o.created_at, o.updated_at, o.cancel_reason,
             (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
      FROM orders o
      WHERE o.agent_id = ?
      ORDER BY o.created_at DESC
      LIMIT 100
    `).all(id) as Array<{
      order_id: string; status: string; pickup_time: string | null;
      total_nok: number | null; created_at: string; updated_at: string;
      cancel_reason: string | null; item_count: number;
    }>;

    const openCount = rows.filter((r) => ["pending", "confirmed", "ready"].includes(r.status)).length;

    // Short private cache — session-gated, per-owner data (same convention
    // as owner-stats).
    res.setHeader("Cache-Control", "private, max-age=60");

    return res.json({ success: true, agentId: id, orders: rows, open_count: openCount });
  } catch (error) {
    console.error("[owner-portal] orders error:", error);
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: "En feil oppstod.",
    });
  }
});

// ─────────────────────────────────────────────────────────────────
// Helper: Escape HTML
// ─────────────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  const map: { [key: string]: string } = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

// ─────────────────────────────────────────────────────────────────
// GET /api/agents/:id/translations?lang=en
// ─────────────────────────────────────────────────────────────────
// dev-request 2026-09-03-oversettelse-synk-og-eierprofiler (Daniel: "eier
// burde kunne redigere sin engelske profil"). Shows the producer, per field,
// the Norwegian source, what the page shows today, and whether the text is
// their own or the machine's. Session-gated exactly like update-profile.

const OWNER_TRANSLATABLE_FIELDS = PROFILE_TRANSLATION_FIELDS.rfb.map((f) => f.field);

function parseOwnerLang(raw: unknown): TranslationTargetLang | null {
  const l = String(raw || "en").trim();
  return (TRANSLATION_TARGET_LANGS as readonly string[]).includes(l) ? (l as TranslationTargetLang) : null;
}

router.get("/api/agents/:id/translations", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sessionData = verifyOwnerSession(req);
    if (!sessionData.valid) {
      return res.status(401).json({ success: false, error: "session_invalid", message: "Din sesjon er utløpt. Logg inn på nytt." });
    }
    if (!ownerSessionAllows(id, sessionData)) {
      return res.status(403).json(ownerForbiddenJson(id, sessionData));
    }
    const lang = parseOwnerLang(req.query.lang);
    if (!lang) return res.status(400).json({ success: false, error: "bad_lang", message: "lang må være en eller sv." });
    const rows = listOwnerTranslations(getDb(), "rfb", id, lang);
    return res.json({
      success: true,
      agent_id: id,
      lang,
      fields: rows.map((r) => ({
        field: r.field,
        source_text: r.source_text,
        current_text: r.current_text,
        written_by: r.owner_text ? "owner" : r.current_text ? "ai" : null,
        owner_text: r.owner_text,
        owner_text_at: r.owner_text_at,
        source_changed_since_owner_edit: r.source_changed_since_owner_edit,
        ai_suggestion: r.owner_text ? r.machine_text : null,
        published: r.published,
      })),
    });
  } catch (e: any) {
    console.error("[owner-portal] GET translations failed:", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/agents/:id/translations  {lang, field, text}
// ─────────────────────────────────────────────────────────────────
// The producer's own words in their own language about their own business —
// served as written, no reviewer and no verifier, exactly like the Norwegian
// text they already control. From then on the pipeline leaves the field alone.

router.post("/api/agents/:id/translations", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sessionData = verifyOwnerSession(req);
    if (!sessionData.valid) {
      return res.status(401).json({ success: false, error: "session_invalid", message: "Din sesjon er utløpt. Logg inn på nytt." });
    }
    if (!ownerSessionAllows(id, sessionData)) {
      return res.status(403).json(ownerForbiddenJson(id, sessionData));
    }
    const lang = parseOwnerLang(req.body?.lang);
    if (!lang) return res.status(400).json({ success: false, error: "bad_lang", message: "lang må være en eller sv." });
    const field = String(req.body?.field || "").trim();
    if (!OWNER_TRANSLATABLE_FIELDS.includes(field)) {
      return res.status(400).json({ success: false, error: "bad_field", message: `field må være en av ${OWNER_TRANSLATABLE_FIELDS.join(", ")}.` });
    }
    const text = String(req.body?.text ?? "");
    if (!text.trim()) return res.status(400).json({ success: false, error: "empty_text", message: "Teksten kan ikke være tom." });
    if (text.length > 8000) return res.status(400).json({ success: false, error: "too_long", message: "Teksten er for lang (maks 8000 tegn)." });
    if (looksLikeCodeArtifact(text)) {
      return res.status(400).json({ success: false, error: "looks_like_code", message: "Teksten ser ut som kode eller nettside-innhold." });
    }
    const row = setOwnerTranslation(getDb(), "rfb", {
      entityType: "agent",
      entityId: id,
      field,
      lang,
      text,
      actor: `owner:${sessionData.agentId}`,
    });
    if (!row) {
      return res.status(404).json({ success: false, error: "field_not_found", message: "Feltet finnes ikke på denne profilen ennå — fyll ut den norske teksten først." });
    }
    console.log(`[owner-portal] owner wrote ${lang} ${field} for agent ${id}`);
    return res.json({ success: true, agent_id: id, lang, field, saved_at: row.owner_text_at, published: true });
  } catch (e: any) {
    console.error("[owner-portal] POST translations failed:", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// DELETE /api/agents/:id/translations  {lang, field}
// ─────────────────────────────────────────────────────────────────
// Hands the field back to the translation pipeline. The old machine text is
// not restored silently — the field is re-translated on the next run.

router.delete("/api/agents/:id/translations", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sessionData = verifyOwnerSession(req);
    if (!sessionData.valid) {
      return res.status(401).json({ success: false, error: "session_invalid", message: "Din sesjon er utløpt. Logg inn på nytt." });
    }
    if (!ownerSessionAllows(id, sessionData)) {
      return res.status(403).json(ownerForbiddenJson(id, sessionData));
    }
    const lang = parseOwnerLang(req.body?.lang ?? req.query?.lang);
    if (!lang) return res.status(400).json({ success: false, error: "bad_lang", message: "lang må være en eller sv." });
    const field = String(req.body?.field ?? req.query?.field ?? "").trim();
    if (!OWNER_TRANSLATABLE_FIELDS.includes(field)) {
      return res.status(400).json({ success: false, error: "bad_field", message: `field må være en av ${OWNER_TRANSLATABLE_FIELDS.join(", ")}.` });
    }
    const row = clearOwnerTranslation(getDb(), "rfb", {
      entityType: "agent",
      entityId: id,
      field,
      lang,
      actor: `owner:${sessionData.agentId}`,
    });
    if (!row) return res.status(404).json({ success: false, error: "not_found" });
    return res.json({ success: true, agent_id: id, lang, field, status: row.status });
  } catch (e: any) {
    console.error("[owner-portal] DELETE translations failed:", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

export default router;
