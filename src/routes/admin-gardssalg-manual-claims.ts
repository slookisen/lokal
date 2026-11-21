// ─── /admin/gardssalg-manual-claims — O3-5 (A2A dev-request 2026-11-12-
// opplevagent-o3-eierkrav-og-innlogging): the manual gårdssalg claim queue
// (services/gardssalg-manual-claims.ts). X-Admin-Key (shared requireAdmin).
//   GET  /             pending queue, oldest first, age + age_alarm + domain rule per row
//   POST /:id/approve  { apply?: true, override_reason?, note? }
//   POST /:id/reject   { apply?: true, note? }
// Only apply === true writes; anything else is a dry run. An applied approve
// mails the claimant the existing claim login link (never logged or returned);
// its first click sends the O3-4 welcome mail (OA-4 part 3, its own flag). An
// applied reject sends the OA-4 part 4 rejection mail (receipt flag).

import { Router, Request, Response } from "express";
import { requireAdmin } from "./admin-pool-blocker-explain";
import { decideManualClaim, isManualClaimReceiptEnabled, listManualClaimQueue, sendManualClaimMail } from "../services/gardssalg-manual-claims";
import { emailService } from "../services/email-service";
import { maskEmail } from "../services/gardssalg-claim";

const router = Router();
const OPPLEVAGENT_BASE_URL = process.env.OPPLEVAGENT_BASE_URL || "https://opplevagent.no";

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json(listManualClaimQueue());
});

function decide(decision: "approve" | "reject") {
  return (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = String((req.params as any).id || "").trim();
    const str = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 1000) : undefined);
    const result = decideManualClaim(id, decision, {
      apply: body.apply === true,
      overrideReason: decision === "approve" ? str(body.override_reason) : undefined,
      note: str(body.note),
    });
    if (!result.ok) {
      const status = result.error === "not_found" || result.error === "provider_not_found" ? 404 : result.error === "grant_failed" ? 400 : 409;
      return res.status(status).json({ success: false, error: result.error, domain_rule: result.domain_rule });
    }
    const { loginLink, ...out } = result;
    if (decision === "reject" && !out.dry_run && isManualClaimReceiptEnabled()) sendManualClaimMail("reject", id, out.claimant_email, out.provider_name || "din profil");
    if (loginLink) {
      const verifyUrl = `${OPPLEVAGENT_BASE_URL}/kategori/gardssalg/eier/magic-link-verify?token=${loginLink.token}`;
      emailService
        .sendGardssalgClaimMagicLink({ to: loginLink.email, providerName: result.provider_name || "din profil", verifyUrl, isTestSend: false })
        .then((r) => { if (!r.success) console.error(`[gardssalg-manual-claims] login link for ${result.provider_id} was not sent`); })
        .catch((e) => console.error("[gardssalg-manual-claims] send error:", e instanceof Error ? e.message : "error"));
    }
    return res.json({ success: true, ...out, claimant_email: maskEmail(out.claimant_email), ...(loginLink ? { login_link_queued: true } : {}) });
  };
}

router.post("/:id/approve", decide("approve"));
router.post("/:id/reject", decide("reject"));

export default router;
