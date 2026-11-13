// ─── Order activation link routes — RETIRED ────────────────────────────────
// dev-request 2026-11-06-rfb-aktiveringslenke-l1-pensjoneres.
//
// The «aktiveringslenke» L1 (order activation link) is retired: it created no
// proper owner claim and is superseded by the owner-claim flow. The public
// pages and the admin generate endpoint no longer do anything:
//
//   GET/POST /aktiver-bestillinger              (public router, mounted "/")
//     Always 410 with a short Norwegian page pointing producers to the owner
//     portal (/selger). No token is inspected, no cookie is set, no DB row is
//     written — regardless of token and regardless of whether
//     ORDER_ACTIVATION_LINK_SECRET is set.
//
//   POST /admin/orders/activation-link          (admin router, "/admin/orders")
//     410 JSON after the unchanged admin-key check (401/503 for missing/wrong
//     key). Never creates a link.
//
// What remains (untouched, code removal is a later case):
//   - the order_activation_links table (src/database/init.ts),
//   - the service src/services/order-activation-link.ts (still used by the
//     revocation branch in routes/marketplace.ts and its own tests),
//   - a new read-only usage endpoint for observability:
//       GET /admin/orders/activation-link/usage  (admin router)
//     returns row/claim counts; no writes.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { ORDER_ACTIVATION_PATH, ORDER_ACTIVATION_CLAIMED_VIA } from "../services/order-activation-link";

// ─── Admin ──────────────────────────────────────────────────────────────────

export const orderActivationAdminRouter = Router();

function requireAdmin401(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(401).json({ error: "Requires X-Admin-Key header" });
    return false;
  }
  return true;
}

// Read-only observability for the retired link: counts only, static SQL, no
// writes. If the table does not exist (fresh DB / migration not run), report
// zeros rather than 500.
orderActivationAdminRouter.get("/activation-link/usage", (req: Request, res: Response) => {
  if (!requireAdmin401(req, res)) return;
  try {
    const db = getDb();
    const tableExists = !!db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'order_activation_links'")
      .get();
    let activationLinks = 0;
    let redeemedLinks = 0;
    if (tableExists) {
      activationLinks = (db.prepare("SELECT COUNT(*) AS n FROM order_activation_links").get() as { n: number }).n;
      // `used_at` is the table's redeemed/used marker (a timestamp set when the
      // link was consumed, NULL otherwise).
      redeemedLinks = (db
        .prepare("SELECT COUNT(*) AS n FROM order_activation_links WHERE used_at IS NOT NULL")
        .get() as { n: number }).n;
    }
    const agentsClaimed = (db
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE claimed_via = ?")
      .get(ORDER_ACTIVATION_CLAIMED_VIA) as { n: number }).n;
    return res.json({
      success: true,
      activation_links: activationLinks,
      redeemed_links: redeemedLinks,
      agents_claimed_via_activation_link: agentsClaimed,
    });
  } catch (err) {
    console.error("[order-activation] usage query failed:", err instanceof Error ? err.message : "error");
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

orderActivationAdminRouter.post("/activation-link", (req: Request, res: Response) => {
  if (!requireAdmin401(req, res)) return;
  return res.status(410).json({
    success: false,
    error: "activation_link_retired",
    message: "Aktiveringslenker for bestillinger er pensjonert. Produsenter tar over profilen og slår på bestillinger via eierportalen.",
  });
});

// ─── Public pages ───────────────────────────────────────────────────────────

const router = Router();

const PAGE_CSS = `
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f7f7f2;color:#1f2a14;line-height:1.5}
  .ep-shell{max-width:640px;margin:0 auto;padding:16px}
  .ep-topbar{padding:8px 0 16px}
  .ep-logo{font-weight:700;font-size:1.1rem;color:#2D5016;text-decoration:none}
  .ep-logo span{color:#8a6d1e}
  .ep-card{background:#fff;border:1px solid #e5e5dc;border-radius:12px;padding:24px 20px;margin-bottom:16px}
  .ep-card h1{font-size:1.4rem;margin:0 0 12px}
  .ep-muted{color:#737373;font-size:0.9rem}
  .ep-btn{display:inline-block;background:#2D5016;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:1rem;cursor:pointer;text-decoration:none}
`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="nb">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <meta name="referrer" content="no-referrer">
  <link rel="icon" href="/favicon-192.png" sizes="192x192" type="image/png">
  <title>${title} — Rett fra Bonden</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="ep-shell">
    <div class="ep-topbar"><a href="/" class="ep-logo">Rett fra <span>Bonden</span></a></div>
    ${body}
  </div>
</body>
</html>`;
}

function sendPage(res: Response, status: number, title: string, body: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.status(status).type("html").send(shell(title, body));
}

// Both routes always answer 410 with the same retirement page. No token is
// read, no cookie is set, no DB row is written.
function retiredPage(_req: Request, res: Response): void {
  sendPage(res, 410, "Lenken er erstattet", `<div class="ep-card">
      <h1>Lenken er erstattet</h1>
      <p>Aktiveringslenker for bestillinger brukes ikke lenger.</p>
      <p>Er du produsent, kan du ta over profilen din og slå på bestillinger via eierportalen.</p>
      <p><a class="ep-btn" href="/selger">Gå til eierportalen</a></p>
    </div>`);
}

router.get(ORDER_ACTIVATION_PATH, retiredPage);
router.post(ORDER_ACTIVATION_PATH, retiredPage);

export default router;
