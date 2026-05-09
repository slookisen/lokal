import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { emailService } from "../services/email-service";
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

    // 1. Check if email matches agent's registered email
    const agentKnowledge = db
      .prepare("SELECT email FROM agent_knowledge WHERE agent_id = ?")
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

    // 5. Send email
    const verifyUrl = `https://rettfrabonden.com/magic-link-verify?token=${token}`;
    const emailResult = await emailService.sendEmail({
      to: email,
      subject: "Logg inn på din profil — Rett fra Bonden",
      htmlContent: buildMagicLinkHtml(verifyUrl),
      textContent: buildMagicLinkText(verifyUrl),
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
      return res.redirect(302, "/min-profil/feil?reason=invalid_token");
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
      return res.redirect(302, "/min-profil/feil?reason=invalid_token");
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

    // 4. Get agent slug for redirect
    const agent = db.prepare("SELECT slug FROM agents WHERE id = ?").get(agentId) as any;
    const slug = agent?.slug || agentId;

    console.log(`[owner-portal] Magic link verified, redirecting to /produsent/${slug}/edit`);
    return res.redirect(302, `/produsent/${slug}/edit`);
  } catch (error) {
    console.error("[owner-portal] Error in magic-link-verify:", error);
    return res.redirect(302, "/min-profil/feil?reason=error");
  }
});

// ─────────────────────────────────────────────────────────────────
// Middleware: Verify magic link session or Bearer token
// ─────────────────────────────────────────────────────────────────

function verifyOwnerSession(req: Request): { valid: boolean; agentId?: string; token?: string } {
  // Try cookie first
  const cookieToken = (req.cookies as any)?.rfb_owner_session;
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

    const agent = db.prepare("SELECT id, name, slug FROM agents WHERE id = ?").get(id) as any;
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
// Helper: Build magic link email HTML
// ─────────────────────────────────────────────────────────────────

function buildMagicLinkHtml(verifyUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="no">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 0;
    }
    .container {
      background: #ffffff;
      padding: 40px 20px;
    }
    .header {
      margin-bottom: 30px;
      border-bottom: 3px solid #2d5f2e;
      padding-bottom: 20px;
    }
    .logo {
      font-size: 24px;
      font-weight: bold;
      color: #2d5f2e;
    }
    h1 {
      font-size: 20px;
      color: #1a1a1a;
      margin: 20px 0 15px 0;
    }
    p {
      margin: 12px 0;
      font-size: 15px;
      line-height: 1.7;
    }
    .cta-button {
      display: inline-block;
      background: #2d5f2e;
      color: white;
      padding: 14px 32px;
      text-decoration: none;
      border-radius: 6px;
      font-weight: bold;
      margin: 20px 0;
      text-align: center;
    }
    .cta-button:hover {
      background: #1e4620;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #eee;
      font-size: 13px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">🌾 Rett fra Bonden</div>
    </div>

    <h1>Logg inn på din profil</h1>

    <p>Klikk lenken under for å redigere profilen din på Rett fra Bonden:</p>

    <a href="${escapeHtml(verifyUrl)}" class="cta-button">Logg inn</a>

    <p style="font-size: 14px; color: #666;">
      Eller kopier og lim inn denne lenken i nettleseren:
      <br />
      <code style="word-break: break-all; background: #f5f5f5; padding: 5px; display: inline-block;">
        ${escapeHtml(verifyUrl)}
      </code>
    </p>

    <p>Lenken er gyldig i 7 dager.</p>

    <p>Hvis du ikke ba om dette, kan du ignorere denne e-posten.</p>

    <div class="footer">
      <p>Rett fra Bonden | rettfrabonden.com</p>
    </div>
  </div>
</body>
</html>
  `;
}

// ─────────────────────────────────────────────────────────────────
// Helper: Build magic link email text
// ─────────────────────────────────────────────────────────────────

function buildMagicLinkText(verifyUrl: string): string {
  return `
Hei,

Klikk lenken under for å redigere profilen din på Rett fra Bonden:

${verifyUrl}

Lenken er gyldig i 7 dager.

Hvis du ikke ba om dette, kan du ignorere denne e-posten.

Mvh,
Rett fra Bonden
  `;
}

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
