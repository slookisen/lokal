// ─── Order activation link routes (RFB «aktiveringslenke», skive 2) ────────
// dev-request 2026-10-21 live-go handlevogn-pilot og første handel, skive 2.
// Token format, storage and session: services/order-activation-link.ts.
//
//   POST /admin/orders/activation-link   { agent_id }      (admin router)
//     X-Admin-Key (401 without/wrong key, 503 when no admin key configured,
//     same as GET /admin/orders/pilot-status). 503 when
//     ORDER_ACTIVATION_LINK_SECRET is unset — never a fallback key. Returns
//     the URL to admin only; nothing is sent from here.
//
//   GET  /aktiver-bestillinger?t=<token>                   (public router)
//     Landing page: profile name, the address orders go to, how ordering
//     works, link to /kjopsvilkar, and the «Jeg representerer …» checkbox.
//   POST /aktiver-bestillinger   (form: t, bekreft=1)
//     One click: ownership (fill-only) + opt-in + owner-portal session, then
//     303 → /eier/<id>/portal#bestillinger. The valid token in the body is the
//     CSRF guard; the checkbox is required.
//
// The token travels in the query string / form body, never in the path, so
// the page-view and slow-request logs (both path-only) never store it.
// Status pages: used → 409, expired / address changed → 410, bad or unknown
// token → 404 (reveals nothing), secret unset → 503.

import express, { Router, Request, Response } from "express";
import {
  activationSecret,
  createActivationLink,
  inspectActivationToken,
  redeemActivationLink,
  tokenLogLabel,
  ORDER_ACTIVATION_PATH,
  ORDER_ACTIVATION_SECRET_ENV,
  OWNER_SESSION_VALID_MS,
  type ActivationContext,
} from "../services/order-activation-link";

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

orderActivationAdminRouter.post("/activation-link", (req: Request, res: Response) => {
  if (!requireAdmin401(req, res)) return;
  const agentId = typeof req.body?.agent_id === "string" ? req.body.agent_id.trim() : "";
  try {
    // Fail closed before anything else: no secret → 503, never a fallback key.
    if (!activationSecret()) {
      return res.status(503).json({ success: false, error: "activation_secret_missing", message: `${ORDER_ACTIVATION_SECRET_ENV} is not configured` });
    }
    if (!agentId) return res.status(400).json({ success: false, error: "agent_id_required" });
    const r = createActivationLink(agentId);
    if (!r.ok) {
      const map: Record<typeof r.reason, [number, string]> = {
        secret_missing: [503, `${ORDER_ACTIVATION_SECRET_ENV} is not configured`],
        agent_not_found: [404, "No agent with that id"],
        no_registered_email: [409, "The agent has no registered address (agent_knowledge.email)"],
        self_registered_profile: [409, "Self-registered profiles cannot be activated by link; use the claim review"],
      };
      const [status, message] = map[r.reason];
      return res.status(status).json({ success: false, error: r.reason === "secret_missing" ? "activation_secret_missing" : r.reason, message });
    }
    console.log(`[order-activation] link generated for agent ${r.agent_id} (link ${r.link_id.slice(0, 10)}, expires ${r.expires_at})`);
    return res.json({
      success: true,
      agent_id: r.agent_id,
      name: r.name,
      address: r.address,
      url: r.url,
      expires_at: r.expires_at,
      note: "Return to admin only. Not sent by the platform; single use, bound to the address above.",
    });
  } catch (err) {
    console.error("[order-activation] admin generate failed:", err instanceof Error ? err.message : "error");
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

const PAGE_CSS = `
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f7f7f2;color:#1f2a14;line-height:1.5}
  .ep-shell{max-width:640px;margin:0 auto;padding:16px}
  .ep-topbar{padding:8px 0 16px}
  .ep-logo{font-weight:700;font-size:1.1rem;color:#2D5016;text-decoration:none}
  .ep-logo span{color:#8a6d1e}
  .ep-card{background:#fff;border:1px solid #e5e5dc;border-radius:12px;padding:24px 20px;margin-bottom:16px}
  .ep-card h1{font-size:1.4rem;margin:0 0 12px}
  .ep-card h2{font-size:1.05rem;margin:16px 0 8px}
  .ep-muted{color:#737373;font-size:0.9rem}
  .ep-error{background:#fdecea;border:1px solid #f5c2bd;color:#8a1f11;border-radius:8px;padding:10px 12px;margin-bottom:12px}
  .ep-check{display:flex;gap:10px;align-items:flex-start;margin:16px 0}
  .ep-check input{margin-top:4px;width:18px;height:18px}
  .ep-btn{display:inline-block;background:#2D5016;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:1rem;cursor:pointer;text-decoration:none}
  ol{padding-left:20px}
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
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.status(status).type("html").send(shell(title, body));
}

function activationFormHtml(ctx: ActivationContext, token: string, error?: string): string {
  const name = escapeHtml(ctx.name);
  return `<div class="ep-card">
      <h1>Ta imot bestillinger for ${name}</h1>
      ${error ? `<div class="ep-error" role="alert">${escapeHtml(error)}</div>` : ""}
      <p>Profil: <strong>${name}</strong></p>
      <p>Bestillinger sendes til: <strong>${escapeHtml(ctx.address)}</strong></p>
      <h2>Slik fungerer bestilling</h2>
      <ol>
        <li>En kunde sender en bestillingsforespørsel via Rett fra Bonden.</li>
        <li>Du får forespørselen på e-post og bekrefter (eller avslår) den.</li>
        <li>Kunden henter varene og betaler deg direkte ved henting.</li>
      </ol>
      <p class="ep-muted">Du er selger og mottar betalingen selv. Les mer i <a href="/kjopsvilkar">kjøpsvilkårene</a>. Du kan slå av bestillinger igjen når som helst i eierportalen.</p>
      <form method="post" action="${ORDER_ACTIVATION_PATH}">
        <input type="hidden" name="t" value="${escapeHtml(token)}">
        <label class="ep-check">
          <input type="checkbox" name="bekreft" value="1" required>
          <span>Jeg representerer ${name} og vil ta imot bestillinger</span>
        </label>
        <button type="submit" class="ep-btn">Bekreft og gå til eierportalen</button>
      </form>
    </div>`;
}

function statusPage(res: Response, state: "unavailable" | "invalid" | "used" | "expired" | "address_changed", agentId?: string): void {
  switch (state) {
    case "unavailable":
      return sendPage(res, 503, "Midlertidig utilgjengelig",
        `<div class="ep-card"><h1>Midlertidig utilgjengelig</h1><p>Aktiveringslenker kan ikke brukes akkurat nå. Prøv igjen senere, eller kontakt Rett fra Bonden.</p></div>`);
    case "used": {
      const login = agentId ? `/eier/${encodeURIComponent(agentId)}` : "/";
      return sendPage(res, 409, "Lenken er allerede brukt",
        `<div class="ep-card"><h1>Lenken er allerede brukt</h1><p>Denne aktiveringslenken kan bare brukes én gang, og den er allerede brukt.</p><p>Du kan logge inn i eierportalen med e-postadressen din for å se bestillinger eller endre innstillingene.</p><p><a class="ep-btn" href="${escapeHtml(login)}">Gå til innlogging</a></p></div>`);
    }
    case "expired":
    case "address_changed":
      return sendPage(res, 410, "Lenken er utløpt",
        `<div class="ep-card"><h1>Lenken gjelder ikke lenger</h1><p>Aktiveringslenken er utløpt eller ikke lenger gyldig. Lenker gjelder i 14 dager og bare for e-postadressen som var registrert da lenken ble laget.</p><p>Kontakt Rett fra Bonden for å få en ny lenke.</p></div>`);
    case "invalid":
    default:
      return sendPage(res, 404, "Ugyldig lenke",
        `<div class="ep-card"><h1>Ugyldig lenke</h1><p>Vi fant ikke denne lenken. Sjekk at hele lenken ble kopiert, eller kontakt Rett fra Bonden.</p></div>`);
  }
}

router.get(ORDER_ACTIVATION_PATH, (req: Request, res: Response) => {
  const token = typeof req.query.t === "string" ? req.query.t : "";
  try {
    const r = inspectActivationToken(token);
    if (r.state !== "valid") return statusPage(res, r.state, r.state === "used" ? r.agent_id : undefined);
    return sendPage(res, 200, "Ta imot bestillinger", activationFormHtml(r.ctx, token));
  } catch (err) {
    console.error(`[order-activation] GET failed (token ${tokenLogLabel(token)}):`, err instanceof Error ? err.message : "error");
    return statusPage(res, "unavailable");
  }
});

router.post(ORDER_ACTIVATION_PATH, express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const token = typeof req.body?.t === "string" ? req.body.t : "";
  try {
    const check = inspectActivationToken(token);
    if (check.state !== "valid") return statusPage(res, check.state, check.state === "used" ? check.agent_id : undefined);
    if (req.body?.bekreft !== "1") {
      return sendPage(res, 400, "Ta imot bestillinger",
        activationFormHtml(check.ctx, token, "Kryss av for at du representerer produsenten før du fortsetter."));
    }
    const r = redeemActivationLink(token, { ip: req.ip, userAgent: req.get("user-agent") || undefined });
    if (r.state !== "redeemed") return statusPage(res, r.state, r.state === "used" ? r.agent_id : undefined);
    // Same cookie as /magic-link-verify (routes/owner-portal.ts) — the
    // session row behind it is read by verifyOwnerSession().
    res.cookie("rfb_owner_session", r.session_token, {
      path: "/",
      maxAge: OWNER_SESSION_VALID_MS,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
    console.log(`[order-activation] link used for agent ${r.agent_id} (${r.outcome}, token ${tokenLogLabel(token)})`);
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(303, `/eier/${encodeURIComponent(r.agent_id)}/portal#bestillinger`);
  } catch (err) {
    console.error(`[order-activation] POST failed (token ${tokenLogLabel(token)}):`, err instanceof Error ? err.message : "error");
    return statusPage(res, "unavailable");
  }
});

export default router;
