import express, { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { emailService } from "../services/email-service";
import { slugify } from "../utils/slug";
import { getOwnerStats } from "../services/owner-stats-service";
import crypto from "crypto";

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

// ─────────────────────────────────────────────────────────────────
// Constants & Helpers
// ─────────────────────────────────────────────────────────────────

const MAGIC_LINK_VALID_HOURS = 7 * 24; // 7 days
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

    console.log(`[owner-portal] POST request-magic-link for agent ${id}, email: ${email}`);

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
        `[owner-portal] Email mismatch for ${id}: provided=${email}, registered=${agentKnowledge?.email || "none"}`
      );
      return res.status(404).json({
        success: false,
        error: "email_not_associated",
        message: "Den e-posten er ikke registrert for denne produsenten.",
      });
    }

    const agentName: string = (agentRow && agentRow.name) ? String(agentRow.name) : "din profil";

    // 2. Rate-limit check
    const recentCount = db
      .prepare(
        `SELECT COUNT(*) as count FROM magic_links
         WHERE agent_id = ? AND created_at >= datetime('now', '-' || ? || ' hours')`
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
      console.error(`[owner-portal] Failed to send magic link email to ${email}`);
      return res.status(500).json({
        success: false,
        error: "email_send_failed",
        message: "Kunne ikke sende e-post. Prøv igjen senere.",
      });
    }

    // 6. Success
    console.log(`[owner-portal] Magic link sent to ${email}`);
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

    console.log(`[owner-portal] GET magic-link-verify, token=${token}`);

    if (!token || typeof token !== "string") {
      // FIX 2026-05-10: /min-profil/feil does not exist. Send user to a usable page.
      return res.redirect(302, "/?error=invalid_token");
    }

    const db = getDb();

    // 1. Validate token
    const magicLink = db
      .prepare(
        `SELECT * FROM magic_links
         WHERE token = ? AND expires_at > datetime('now')`
      )
      .get(token) as any;

    if (!magicLink) {
      console.log(`[owner-portal] Invalid or expired token: ${token}`);
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

function verifyOwnerSession(req: Request): { valid: boolean; agentId?: string; token?: string } {
  // Try cookie first
  const cookieToken = readSessionCookie(req);
  if (cookieToken) {
    const db = getDb();
    const link = db
      .prepare(
        `SELECT agent_id FROM magic_links
         WHERE token = ? AND used = 1 AND expires_at > datetime('now')`
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
         WHERE token = ? AND used = 1 AND expires_at > datetime('now')`
      )
      .get(token) as any;
    if (link) {
      return { valid: true, agentId: link.agent_id, token };
    }
  }

  return { valid: false };
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

    if (sessionData.agentId !== id) {
      console.log(
        `[owner-portal] Session agent ${sessionData.agentId} != requested ${id}`
      );
      return res.status(403).json({
        success: false,
        error: "forbidden",
        message: "Du har ikke tilgang til denne agenten.",
      });
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

    for (const field of EDITABLE_FIELDS) {
      if (!(field in bodyFields)) continue; // Skip if not in request

      const newValue = bodyFields[field];
      const dbField = field === "description" ? "about" : field;

      // Check curated_fields lock
      const curatedFieldInfo = curatedFields[dbField] || {};
      if (curatedFieldInfo.by && curatedFieldInfo.by !== "owner" && curatedFieldInfo.by !== null) {
        skippedFields.push({
          field,
          reason: `locked_by_${curatedFieldInfo.by}`,
        });
        console.log(
          `[owner-portal] Skipped locked field ${field} (locked by ${curatedFieldInfo.by})`
        );
        continue;
      }

      const oldValue = (knowledge as any)[dbField] || null;
      updatedFields[dbField] = newValue;

      // Update curated_fields
      curatedFields[dbField] = {
        locked_at: new Date().toISOString(),
        by: "owner",
      };

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

      // Update curated_fields JSON
      db.prepare(
        `UPDATE agent_knowledge SET curated_fields = ?, updated_at = ? WHERE agent_id = ?`
      ).run(JSON.stringify(curatedFields), new Date().toISOString(), id);

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

    if (sessionData.agentId !== id) {
      return res.status(403).json({
        success: false,
        error: "forbidden",
        message: "Du har ikke tilgang til denne agenten.",
      });
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
      const value = (knowledge as any)[dbField] || null;
      const curatedInfo = curatedFields[dbField] || {};

      fields[field] = {
        value,
        locked_by: curatedInfo.by || null,
        editable:
          !curatedInfo.by || curatedInfo.by === "owner" || curatedInfo.by === null,
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

function portalShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="nb">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#2D5016">
  <title>${escapeHtml(title)} — Rett fra Bonden</title>
  <style>${PORTAL_PALETTE_CSS}</style>
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
    }

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
      const value = (knowledge as any)[fd.dbField] != null ? String((knowledge as any)[fd.dbField]) : "";
      const lockInfo = curatedFields[fd.dbField] || {};
      const lockedByOther = lockInfo.by && lockInfo.by !== "owner" && lockInfo.by !== null;
      const lockedHtml = lockedByOther
        ? `<div class="ep-lock">\u{1F512} Låst — kontakt support for å endre (${escapeHtml(String(lockInfo.by))})</div>`
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
    const statsHtml = `
      ${stat("Google-vurdering", knowledge.google_rating)}
      ${stat("Google-anmeldelser", knowledge.google_review_count)}
      ${stat("TripAdvisor", knowledge.tripadvisor_rating)}
      ${stat("Sidevisninger", knowledge.views_count)}
      ${stat("AI-samtaler", knowledge.ai_conversations_count)}
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
        // Load my-audit feed
        if (window.fetch) {
          fetch("/api/agents/${encodeURIComponent(agent.id)}/my-audit?limit=20", { credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              var ul = document.getElementById("ep-audit");
              if (!ul) return;
              if (!j || !j.success || !j.audits || j.audits.length === 0) {
                ul.innerHTML = "<li class=\"ep-audit-item ep-audit-meta\">Ingen endringer ennå.</li>";
                return;
              }
              ul.innerHTML = j.audits.map(function (a) {
                var when = new Date(a.changed_at).toLocaleString("nb-NO");
                var who = a.changed_by === "owner" ? "Du" : (a.changed_by === "admin" ? "Support" : "System");
                var oldV = a.old_value == null ? "(tomt)" : a.old_value;
                var newV = a.new_value == null ? "(tomt)" : a.new_value;
                function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
                return "<li class=\"ep-audit-item\"><strong>" + esc(a.field_name) + "</strong> endret av " + esc(who) + "<div class=\"ep-audit-meta\">" + esc(when) + " · \"" + esc(oldV).slice(0, 80) + "\" → \"" + esc(newV).slice(0, 80) + "\"</div></li>";
              }).join("");
            })
            .catch(function () {
              var ul = document.getElementById("ep-audit");
              if (ul) ul.innerHTML = "<li class=\"ep-audit-item ep-audit-meta\">Kunne ikke laste endringslogg.</li>";
            });
        }

        // Progressive enhancement for save
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
                if (btn) { btn.disabled = false; btn.textContent = "Lagre alle endringer"; }
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
// POST /eier/:agentId/save — graceful-degradation save (forwards to
// JSON update-profile endpoint with cookie-bearing session). Re-renders
// the portal with status query string.
// ─────────────────────────────────────────────────────────────────
router.post("/eier/:agentId/save", express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const agentId = String((req.params as any).agentId || "");
  const session = verifyOwnerSession(req);
  const base = `/eier/${encodeURIComponent(agentId)}/portal`;
  if (!session.valid || session.agentId !== agentId) {
    return res.redirect(303, `/eier/${encodeURIComponent(agentId)}`);
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
    if (session.agentId !== agentId) {
      return res.status(403).json({
        success: false,
        error: "forbidden",
        message: "Du har ikke tilgang til denne agenten.",
      });
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

    if (session.agentId !== id) {
      return res.status(403).json({
        success: false,
        error: "forbidden",
        message: "Du har ikke tilgang til denne agenten.",
      });
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
// Helper: Escape HTML
// ─────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  const map: { [key: string]: string } = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

export default router;
