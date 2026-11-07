// ─── Signed one-click links for owner claims (eierkrav, slice C4) ──────────
// dev-request 2026-10-30-rfb-eierkrav-automatisk-vurdering-og-ettklikk,
// slice C4. Token format, storage and single use: services/claim-action-link.ts.
//
//   POST /admin/agents/claim-action-links  { claimId, actions? }   (admin router)
//     X-Admin-Key (same requireAdmin shape as routes/admin-agents.ts: 503 when
//     no admin key is configured, 403 without/wrong key). 503 when
//     CLAIM_ACTION_LINKS_ENABLED is off or CLAIM_ACTION_LINK_SECRET is unset
//     (never a fallback key), 400 on a bad body, 404 unknown claim, 409 when
//     an asked-for action does not fit the claim's status (or none fits).
//     Default `actions`: those that fit the status (pending_review →
//     approve + reject; verified → revoke). Returns the URLs to admin only.
//
//   GET  /eierkrav/handling?t=<token>                               (public)
//     Confirmation page only (farm name, the action in Norwegian, a POST
//     button). Writes nothing.
//   POST /eierkrav/handling   (form: t)
//     Performs the action once (services/claim-action-link.ts
//     redeemClaimActionLink). Second use → 409; expired → 410; bad or
//     unknown token → 404 (reveals nothing); claim no longer in the state the
//     action needs → 409 and the link is not used up; secret unset → 503.
//
// Flag off → both public routes 404. No dedicated rate limiter: the same as
// the order activation link pages (routes/order-activation-link.ts); the
// admin route sits behind adminLimiter in index.ts. The token travels in the
// query string / form body, never in the path, so the path-only page-view
// and slow-request logs never store it.

import express, { Router, Request, Response } from "express";
import {
  CLAIM_ACTION_PATH,
  CLAIM_ACTION_SECRET_ENV,
  CLAIM_ACTION_FLAG_ENV,
  CLAIM_ACTION_VALID_HOURS,
  claimActionSecret,
  createClaimActionLinks,
  inspectClaimActionToken,
  isClaimAction,
  isClaimActionLinksEnabled,
  redeemClaimActionLink,
  type ClaimAction,
  type ClaimActionContext,
} from "../services/claim-action-link";
import { sendClaimApprovedLoginMail } from "../services/claim-review-actions";
import { maskEmail } from "../services/gardssalg-claim";
import { tokenLogLabel } from "../utils/log-label";

// ─── Admin ──────────────────────────────────────────────────────────────────

export const claimActionAdminRouter = Router();

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

claimActionAdminRouter.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!isClaimActionLinksEnabled()) {
      return res.status(503).json({ success: false, error: "claim_action_links_disabled", message: `${CLAIM_ACTION_FLAG_ENV} is not "true"` });
    }
    // Fail closed before anything else: no secret → 503, never a fallback key.
    if (!claimActionSecret()) {
      return res.status(503).json({ success: false, error: "claim_action_secret_missing", message: `${CLAIM_ACTION_SECRET_ENV} is not configured` });
    }
    const body = (req.body ?? {}) as { claimId?: unknown; actions?: unknown };
    const claimId = typeof body.claimId === "string" ? body.claimId.trim() : "";
    const actionsOk = body.actions === undefined ||
      (Array.isArray(body.actions) && body.actions.length <= 3 && body.actions.every((a) => isClaimAction(a)));
    if (!claimId || claimId.length > 200 || !actionsOk) {
      return res.status(400).json({ success: false, error: "Requires { claimId, actions? } (actions: approve | reject | revoke)" });
    }
    const r = createClaimActionLinks(claimId, body.actions as ClaimAction[] | undefined);
    if (!r.ok) {
      const map: Record<typeof r.reason, [number, string]> = {
        secret_missing: [503, `${CLAIM_ACTION_SECRET_ENV} is not configured`],
        claim_not_found: [404, "No claim with that id"],
        action_not_valid_for_status: [409, "An asked-for action does not fit the claim's status"],
        no_actions_for_status: [409, "No action fits the claim's status"],
      };
      const [status, message] = map[r.reason];
      return res.status(status).json({
        success: false,
        error: r.reason === "secret_missing" ? "claim_action_secret_missing" : r.reason,
        message,
        ...(r.status !== undefined ? { claimStatus: r.status } : {}),
      });
    }
    console.log(`[claim-action-link] ${r.links.length} link(s) minted for claim ${r.claim_id} (${r.links.map((l) => l.action).join(",")})`);
    return res.json({
      success: true,
      claimId: r.claim_id,
      agentId: r.agent_id,
      name: r.name,
      claimStatus: r.status,
      links: r.links,
      note: `Return to admin only. Not sent by the platform; single use, valid ${CLAIM_ACTION_VALID_HOURS} h.`,
    });
  } catch (err) {
    console.error("[claim-action-link] admin mint failed:", err instanceof Error ? err.message : "error");
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

// ─── Public pages ───────────────────────────────────────────────────────────

const router = Router();

function escapeHtml(text: unknown): string {
  return String(text ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" } as Record<string, string>
  )[c]);
}

const ACTION_LABEL: Record<ClaimAction, { verb: string; done: string; button: string }> = {
  approve: { verb: "Godkjenne eierkravet", done: "Eierkravet er godkjent", button: "Godkjenn eierkravet" },
  reject: { verb: "Avslå eierkravet", done: "Eierkravet er avslått", button: "Avslå eierkravet" },
  revoke: { verb: "Trekke tilbake eierskapet", done: "Eierskapet er trukket tilbake", button: "Trekk tilbake eierskapet" },
};

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
  <title>${escapeHtml(title)} — Rett fra Bonden</title>
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
  // The URL carries a capability token: never cache it, never leak it as a referrer.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex");
  res.status(status).type("html").send(shell(title, body));
}

function notFound(res: Response): void {
  sendPage(res, 404, "Ugyldig lenke",
    `<div class="ep-card"><h1>Ugyldig lenke</h1><p>Vi fant ikke denne lenken. Sjekk at hele lenken ble kopiert.</p></div>`);
}

function confirmFormHtml(ctx: ClaimActionContext, token: string): string {
  const label = ACTION_LABEL[ctx.action];
  return `<div class="ep-card">
      <h1>${escapeHtml(label.verb)}?</h1>
      <p>Gård: <strong>${escapeHtml(ctx.agent_name)}</strong></p>
      <p>Innsender: <strong>${escapeHtml(ctx.claimant_name)}</strong></p>
      <p>Handling: <strong>${escapeHtml(label.verb)}</strong></p>
      <p class="ep-muted">Ingenting er endret ennå. Handlingen utføres først når du trykker på knappen, og lenken kan bare brukes én gang.</p>
      <form method="post" action="${CLAIM_ACTION_PATH}">
        <input type="hidden" name="t" value="${escapeHtml(token)}">
        <button type="submit" class="ep-btn">${escapeHtml(label.button)}</button>
      </form>
    </div>`;
}

type StatusState = "unavailable" | "invalid" | "used" | "expired" | "wrong_state";

function statusPage(res: Response, state: StatusState, ctx?: ClaimActionContext): void {
  switch (state) {
    case "unavailable":
      return sendPage(res, 503, "Midlertidig utilgjengelig",
        `<div class="ep-card"><h1>Midlertidig utilgjengelig</h1><p>Lenker for eierkrav kan ikke brukes akkurat nå. Prøv igjen senere.</p></div>`);
    case "used":
      return sendPage(res, 409, "Lenken er allerede brukt",
        `<div class="ep-card"><h1>Lenken er allerede brukt</h1><p>Denne lenken kan bare brukes én gang, og den er allerede brukt. Ingenting ble endret nå.</p></div>`);
    case "expired":
      return sendPage(res, 410, "Lenken er utløpt",
        `<div class="ep-card"><h1>Lenken gjelder ikke lenger</h1><p>Lenken er utløpt. Lenker for eierkrav gjelder i ${CLAIM_ACTION_VALID_HOURS} timer. Lag en ny lenke i admin.</p></div>`);
    case "wrong_state": {
      const what = ctx ? ` (${escapeHtml(ACTION_LABEL[ctx.action].verb.toLowerCase())} for ${escapeHtml(ctx.agent_name)})` : "";
      return sendPage(res, 409, "Kan ikke utføres",
        `<div class="ep-card"><h1>Handlingen kan ikke utføres nå</h1><p>Eierkravet er ikke lenger i en tilstand der denne handlingen passer${what}. Det er sannsynligvis allerede behandlet. Ingenting ble endret, og lenken er ikke brukt opp.</p></div>`);
    }
    case "invalid":
    default:
      return notFound(res);
  }
}

router.get(CLAIM_ACTION_PATH, (req: Request, res: Response) => {
  if (!isClaimActionLinksEnabled()) return notFound(res);
  const token = typeof req.query.t === "string" ? req.query.t : "";
  try {
    const r = inspectClaimActionToken(token);
    if (r.state !== "valid") return statusPage(res, r.state, r.state === "wrong_state" ? r.ctx : undefined);
    return sendPage(res, 200, ACTION_LABEL[r.ctx.action].verb, confirmFormHtml(r.ctx, token));
  } catch (err) {
    console.error(`[claim-action-link] GET failed (token ${tokenLogLabel(token)}):`, err instanceof Error ? err.message : "error");
    return statusPage(res, "unavailable");
  }
});

router.post(CLAIM_ACTION_PATH, express.urlencoded({ extended: false, limit: "4kb" }), async (req: Request, res: Response) => {
  if (!isClaimActionLinksEnabled()) return notFound(res);
  const token = typeof req.body?.t === "string" ? req.body.t : "";
  try {
    const r = redeemClaimActionLink(token);
    if (r.state !== "done") return statusPage(res, r.state, r.state === "wrong_state" ? r.ctx : undefined);
    console.log(`[claim-action-link] ${r.action} performed on claim ${r.claim_id} (agent ${r.agent_id}, token ${tokenLogLabel(token)})`);
    let extra = "";
    if (r.approved) {
      // Same mail as claim-review-approve; the approval is already stored,
      // so a failure only means no mail, never an error page.
      const sent = await sendClaimApprovedLoginMail(r.claim_id, r.approved, "[claim-action-link] approve");
      extra = sent
        ? `<p>Eieren har fått en innloggingslenke på e-post (${escapeHtml(maskEmail(r.approved.email))}).</p>`
        : `<p>Innloggingslenken ble ikke sendt på e-post. Eieren kan logge inn med e-postadressen sin i eierportalen.</p>`;
    }
    const label = ACTION_LABEL[r.action];
    return sendPage(res, 200, label.done,
      `<div class="ep-card"><h1>${escapeHtml(label.done)}</h1><p>Gård: <strong>${escapeHtml(r.agent_name)}</strong></p>${extra}</div>`);
  } catch (err) {
    console.error(`[claim-action-link] POST failed (token ${tokenLogLabel(token)}):`, err instanceof Error ? err.message : "error");
    return statusPage(res, "unavailable");
  }
});

export default router;
