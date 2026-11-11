// ─── POST /admin/dental/agents/:id/contact-form-only ─────────────────────────
// dev-request 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting,
// S-D3a («Kontaktskjema som valg per profil», finn-tannlege.com). The dental
// counterpart of POST /admin/agents/:id/contact-form-only (S-D1, RFB).
//
// Sets dental_agents.contact_form_only when a clinic asks that its e-mail is
// not shown (services/dental-contact-form-only.ts). Body: { enabled: true|false }.
// Record only: no mail is sent, the e-mail address is not touched, nothing is
// echoed but the id and the flag. Works whatever CONTACT_FORM_DENTAL is (the
// flag is only read while the switch is on), so a flag can be set before the
// switch is turned on. 400 for a non-boolean `enabled`, 404 for an unknown id.
//
// Requires the X-Admin-Key header (the same requireAdmin pattern as the other
// /admin/dental/* route files, e.g. admin-dental-mark-inactive.ts).

import { Router, Request, Response } from "express";
import { getDb } from "../database/db-factory";
import { setDentalContactFormOnly } from "../services/dental-contact-form-only";

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
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

const router = Router();

router.post("/:id/contact-form-only", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const id = String(req.params.id);
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled (boolean) is required" });
    return;
  }
  try {
    const result = setDentalContactFormOnly(getDb("dental"), id, enabled);
    if (!result) {
      res.status(404).json({ error: "Clinic not found", agent_id: id });
      return;
    }
    console.log(JSON.stringify({ evt: "contact_form_only_set", host: "dental", profile_id: result.id, contact_form_only: result.contact_form_only }));
    res.json(result);
  } catch {
    res.status(500).json({ error: "contact-form-only write failed" });
  }
});

export default router;
