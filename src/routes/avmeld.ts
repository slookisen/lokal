// ─── /avmeld/:token — unsubscribe from cold outreach ────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S1a point 3. Logic and
// rationale: services/avmeld-service.ts. Behind OUTREACH_UNSUBSCRIBE_ENABLED
// (default OFF → 404, as if the route did not exist).
//
//   GET  /avmeld/:token  confirmation page ONLY. Changes nothing (mail
//                        scanners and link prefetchers GET links).
//   POST /avmeld/:token  sets the email suppression. Also the RFC 8058
//                        one-click target (body List-Unsubscribe=One-Click).
//                        Never deletes or hides a profile.
//
// The token is never logged and never echoed on the pages.

import express, { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  outreachUnsubscribeEnabled,
  verifyUnsubscribeToken,
  suppressEmail,
  isUnsubscribed,
} from "../services/avmeld-service";

const router = Router();

const avmeldLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: "For mange forsøk. Prøv igjen om litt.",
});

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{margin:0;background:#FEFAE0;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6}
main{max-width:560px;margin:0 auto;padding:40px 16px}h1{color:#2D5016;font-size:1.4rem}
button{min-height:44px;padding:10px 20px;background:#2D5016;color:#fff;border:0;border-radius:8px;font-size:1rem;cursor:pointer}a{color:#2D5016}</style>
</head><body><main>${body}</main></body></html>`;
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
}

router.get("/avmeld/:token", avmeldLimiter, (req: Request, res: Response) => {
  if (!outreachUnsubscribeEnabled()) return res.status(404).send("Not found");
  noStore(res);
  const parsed = verifyUnsubscribeToken(String(req.params.token || ""));
  if (!parsed) {
    return res.status(400).send(page("Ugyldig lenke", `<h1>Ugyldig lenke</h1><p>Avmeldingslenken er ugyldig. Skriv til <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a>, så hjelper vi deg.</p>`));
  }
  // Read-only: shows the confirmation form, writes nothing.
  return res.status(200).send(page("Avmelding", `<h1>Vil du ikke høre fra oss?</h1>
<p>Bekreft, så sender vi ikke flere e-poster om Rett fra Bonden til denne adressen. Profilen din blir ikke slettet.</p>
<form method="post" action=""><button type="submit">Bekreft avmelding</button></form>`));
});

router.post("/avmeld/:token", avmeldLimiter, express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  if (!outreachUnsubscribeEnabled()) return res.status(404).send("Not found");
  noStore(res);
  const parsed = verifyUnsubscribeToken(String(req.params.token || ""));
  if (!parsed) return res.status(400).send(page("Ugyldig lenke", `<h1>Ugyldig lenke</h1><p>Avmeldingslenken er ugyldig.</p>`));
  try {
    if (!isUnsubscribed(parsed.email)) suppressEmail(parsed.email);
  } catch (err) {
    console.error("[avmeld] suppress failed:", err instanceof Error ? err.message : String(err));
    return res.status(500).send(page("Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`));
  }
  return res.status(200).send(page("Avmeldt", `<h1>Du er avmeldt</h1><p>Vi sender ikke flere e-poster om Rett fra Bonden til denne adressen. Profilen din er ikke slettet.</p>`));
});

export default router;
