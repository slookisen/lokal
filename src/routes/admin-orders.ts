// ─── Admin: order-notification opt-in + seller order inbox ──────────────────
//
// dev-request 2026-07-13-pilot-ordre-loop. Mounted at /admin/orders.
//
//   POST /admin/orders/notification-optin   { agent_id, opt_in, email? }
//     Sets agents.order_notifications_opt_in (0/1) and optionally the
//     admin-set recipient override agents.order_notification_email. The
//     override both wins over contact_email AND satisfies the
//     verified-contact clause of the send gate (an admin explicitly chose
//     it) — this is how Daniel points a test agent at his own inbox
//     (da.fredriksen@gmail.com) without the agent being 'verified'.
//     Passing email: null (or "") clears the override.
//
//   GET /admin/orders/inbox?agent_id=<id>
//     Lists OPEN orders (pending/confirmed/ready) with items + timeline
//     counts — per producer when agent_id is given, across all producers
//     otherwise. Read-only; the producer dashboard can consume this later.
//
// Auth follows the same convention as admin-runs.ts / admin-db-table-sizes:
// X-Admin-Key header checked against ADMIN_KEY (ANALYTICS_ADMIN_KEY fallback).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

const router = Router();

// Module-local test-DB pin (same race-proof idiom as cart-service).
let _adminOrdersTestDb: any = null;
export function __setAdminOrdersTestDb(db: any): void { _adminOrdersTestDb = db; }

function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Requires X-Admin-Key header" });
    return false;
  }
  return true;
}

// Minimal syntactic email sanity check — the real protection on the send
// path is the gate in order-notify-service (opt-in + suppression), this just
// rejects obvious typos at write time.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ─── POST /notification-optin ───────────────────────────────────────────────
router.post("/notification-optin", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = req.body || {};
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  if (!agentId) {
    res.status(400).json({ success: false, error: "agent_id is required" });
    return;
  }
  if (typeof body.opt_in !== "boolean" && body.opt_in !== 0 && body.opt_in !== 1) {
    res.status(400).json({ success: false, error: "opt_in must be a boolean (or 0/1)" });
    return;
  }
  const optIn = body.opt_in === true || body.opt_in === 1 ? 1 : 0;

  // email semantics: omitted → leave override unchanged; null/"" → clear;
  // a string → validate + set.
  let emailProvided = Object.prototype.hasOwnProperty.call(body, "email");
  let email: string | null = null;
  if (emailProvided) {
    if (body.email === null || body.email === "") {
      email = null;
    } else if (typeof body.email === "string" && EMAIL_RE.test(body.email.trim())) {
      email = body.email.trim();
    } else {
      res.status(400).json({ success: false, error: "email must be a valid email address, null, or omitted" });
      return;
    }
  }

  try {
    const db = _adminOrdersTestDb ?? getDb();
    const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId);
    if (!agent) {
      res.status(404).json({ success: false, error: "Agent not found" });
      return;
    }

    if (emailProvided) {
      db.prepare(
        "UPDATE agents SET order_notifications_opt_in = ?, order_notification_email = ? WHERE id = ?"
      ).run(optIn, email, agentId);
    } else {
      db.prepare(
        "UPDATE agents SET order_notifications_opt_in = ? WHERE id = ?"
      ).run(optIn, agentId);
    }

    const row = db.prepare(
      "SELECT order_notifications_opt_in AS opt_in, order_notification_email AS email FROM agents WHERE id = ?"
    ).get(agentId) as { opt_in: number; email: string | null };

    console.log(
      `[order-notify] opt-in updated agent=${agentId} opt_in=${row.opt_in} override_email=${row.email ? "set" : "none"}`
    );
    res.json({ success: true, agent_id: agentId, opt_in: row.opt_in === 1, order_notification_email: row.email });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

// ─── GET /inbox?agent_id= ───────────────────────────────────────────────────
router.get("/inbox", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const qp = req.query["agent_id"];
  const agentId = typeof qp === "string" && qp.trim() ? qp.trim() : null;

  try {
    const db = _adminOrdersTestDb ?? getDb();
    const where = agentId ? "WHERE o.status IN ('pending','confirmed','ready') AND o.agent_id = ?" : "WHERE o.status IN ('pending','confirmed','ready')";
    const params = agentId ? [agentId] : [];
    const rows = db.prepare(`
      SELECT o.id AS order_id, o.agent_id, a.name AS producer_name, o.status,
             o.pickup_time, o.total_nok, o.created_at, o.updated_at,
             (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
      FROM orders o
      INNER JOIN agents a ON a.id = o.agent_id
      ${where}
      ORDER BY o.agent_id, o.created_at DESC
      LIMIT 500
    `).all(...params) as Array<{
      order_id: string; agent_id: string; producer_name: string; status: string;
      pickup_time: string | null; total_nok: number | null; created_at: string;
      updated_at: string; item_count: number;
    }>;

    res.json({ success: true, agent_id: agentId, open_orders: rows.length, orders: rows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;
