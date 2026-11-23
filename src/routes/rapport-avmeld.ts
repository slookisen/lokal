// ─── /rapport-avmeld/:token — unsubscribe from the monthly owner report ─────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-4. The token is the
// report's own signed token (services/owner-monthly-report.ts,
// purpose owner-report-unsub-v1): an /avmeld or /forhandsvis token never
// validates here. No feature flag — the link is in every report, and an
// unsubscribe link that 404s is worse than none.
//
//   GET  /rapport-avmeld/:token  confirmation page ONLY. Changes nothing (mail
//                                scanners and link prefetchers GET links).
//   POST /rapport-avmeld/:token  sets the owner feature notify.report = "off"
//                                (one owner_feature_audit row when it changed,
//                                actor system / «rapport-avmeld»), also while
//                                the entry is coming_soon. Idempotent. Also the
//                                RFC 8058 one-click target (body
//                                List-Unsubscribe=One-Click). Never deletes or
//                                hides a profile, never touches the outreach
//                                suppression (email_bounces).
//
// An invalid, forged or foreign token, an unknown agent and a missing signing
// secret all get the same neutral 404 page. The token is never logged and
// never echoed on the pages; noindex, no-store, no-referrer. Not a page view
// (/rapport-avmeld/ is in the analytics skipPaths).

import express, { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { getDb } from "../database/init";
import {
  ownerMineValgReportUrl,
  recordOwnerReportUnsubscribe,
  verifyOwnerReportUnsubToken,
} from "../services/owner-monthly-report";

const router = Router();

// Injectable DB seam (tests only), same convention as admin-owner-report-preview.ts.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
/** Test-only. Pass null to clear. */
export function __setRapportAvmeldDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

const rapportAvmeldLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: "For mange forsøk. Prøv igjen om litt.",
});

const CONTACT = "kontakt@rettfrabonden.com";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="nb"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{margin:0;background:#FEFAE0;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6}
main{max-width:560px;margin:0 auto;padding:40px 16px}h1{color:#2D5016;font-size:1.4rem}
button{min-height:44px;padding:10px 20px;background:#2D5016;color:#fff;border:0;border-radius:8px;font-size:1rem;cursor:pointer}a{color:#2D5016}</style>
</head><body><main>${body}</main></body></html>`;
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function notFound(res: Response): Response {
  return res.status(404).send(page("Fant ikke siden", `<h1>Fant ikke siden</h1>
<p>Lenken virker ikke. Skriv til <a href="mailto:${CONTACT}">${CONTACT}</a>, så hjelper vi deg.</p>`));
}

function mineValgLine(agentId: string): string {
  return `<p>Vil du ha rapporten igjen, kan du endre det i <a href="${esc(ownerMineValgReportUrl(agentId))}">«Mine valg»</a>.</p>`;
}

function agentExists(agentId: string): boolean {
  return !!resolveDb().prepare("SELECT 1 FROM agents WHERE id = ?").get(agentId);
}

router.get("/rapport-avmeld/:token", rapportAvmeldLimiter, (req: Request, res: Response) => {
  noStore(res);
  const agentId = verifyOwnerReportUnsubToken(String(req.params.token || ""));
  try {
    if (!agentId || !agentExists(agentId)) return notFound(res);
  } catch (err) {
    console.error("[rapport-avmeld] lookup failed:", err instanceof Error ? err.message : "error");
    return res.status(500).send(page("Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`));
  }
  // Read-only: shows the confirmation form, writes nothing.
  return res.status(200).send(page("Rapport om profilen", `<h1>Vil du slutte å få rapporten?</h1>
<p>Bekreft, så sender vi ikke flere rapporter om profilen din på Rett fra Bonden. Profilen din blir ikke endret eller slettet.</p>
<form method="post" action=""><button type="submit">Ikke send flere rapporter</button></form>
${mineValgLine(agentId)}`));
});

router.post("/rapport-avmeld/:token", rapportAvmeldLimiter, express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  noStore(res);
  // The form button and the RFC 8058 one-click body (List-Unsubscribe=One-Click) do the same.
  const agentId = verifyOwnerReportUnsubToken(String(req.params.token || ""));
  if (!agentId) return notFound(res);
  let result: ReturnType<typeof recordOwnerReportUnsubscribe>;
  try {
    result = recordOwnerReportUnsubscribe(resolveDb(), agentId);
  } catch (err) {
    console.error("[rapport-avmeld] write failed:", err instanceof Error ? err.message : "error");
    return res.status(500).send(page("Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`));
  }
  if (result.kind === "not_found" || result.kind === "unknown_key") return notFound(res);
  if (result.kind !== "ok") {
    // Kill switch or admin lock: say so plainly; nothing was changed.
    console.error(`[rapport-avmeld] not recorded: ${result.kind}${result.kind === "blocked" ? `/${result.block}` : ""}`);
    return res.status(409).send(page("Ikke registrert", `<h1>Vi kunne ikke registrere avmeldingen</h1>
<p>Skriv til <a href="mailto:${CONTACT}">${CONTACT}</a>, så stopper vi rapportene for deg.</p>`));
  }
  return res.status(200).send(page("Avmeldt", `<h1>Du får ikke flere rapporter</h1>
<p>Vi sender ikke flere rapporter om profilen din på Rett fra Bonden. Profilen din er ikke endret eller slettet.</p>
${mineValgLine(agentId)}`));
});

export default router;
