// GET /admin/gardssalg/guest-contact-sweep/dry-run — read-only count of
// gardssalg_bookings rows the guest-contact sweep would clear now.
// dev-request 2026-10-23-opplevagent-besoksforesporsler-automatisk-sletting.
// Never returns ids or personal data. Same X-Admin-Key check as sibling admin routes.

import { Router, Request, Response } from "express";
import { sweepExpiredGardssalgGuestContact, GARDSSALG_SWEEP_CUTOFF_DAYS } from "../services/gardssalg-guest-contact-sweep";

const router = Router();

function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

router.get("/dry-run", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const r = sweepExpiredGardssalgGuestContact(GARDSSALG_SWEEP_CUTOFF_DAYS, new Date(), true);
    return res.json({
      eligible: r.sweptCount,
      cutoffDays: GARDSSALG_SWEEP_CUTOFF_DAYS,
      live: process.env.GARDSSALG_GUEST_CONTACT_SWEEP_LIVE === "true",
    });
  } catch {
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
