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
//
// S5-5: the same pattern for the milestone e-mail (services/
// owner-milestone-email.ts, purpose owner-milestone-unsub-v1):
//   GET  /milepael-avmeld/:token  confirmation page only.
//   POST /milepael-avmeld/:token  sets notify.milestones = false (one audit
//                                 row, actor system / «milepael-avmeld»), also
//                                 while coming_soon; idempotent; RFC 8058.
// A report token never validates on /milepael-avmeld and vice versa.
//
// S5-6: the same pattern for the daily change digest (services/
// owner-changes-digest.ts, purpose owner-changes-unsub-v1):
//   GET  /endring-avmeld/:token  confirmation page only.
//   POST /endring-avmeld/:token  sets notify.changes = false (one audit row,
//                                actor system / «endring-avmeld»), also while
//                                coming_soon; idempotent; RFC 8058.
// No token of the three routes validates on another.

import express, { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { getDb } from "../database/init";
import {
  ownerMineValgReportUrl,
  recordOwnerReportUnsubscribe,
  verifyOwnerReportUnsubToken,
} from "../services/owner-monthly-report";
import {
  ownerMineValgMilestonesUrl,
  recordOwnerMilestoneUnsubscribe,
  verifyOwnerMilestoneUnsubToken,
} from "../services/owner-milestone-email";
import {
  ownerMineValgChangesUrl,
  recordOwnerChangesUnsubscribe,
  verifyOwnerChangesUnsubToken,
} from "../services/owner-changes-digest";
import type { SetOwnerFeatureResult } from "../owner-features/resolve";

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

// One bucket per unsubscribe route (S5-6): 60 requests a minute per client on
// each of /rapport-avmeld, /milepael-avmeld and /endring-avmeld, so one owner
// e-mail's links never use up another's allowance.
function makeAvmeldLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    message: "For mange forsøk. Prøv igjen om litt.",
  });
}

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

function agentExists(agentId: string): boolean {
  return !!resolveDb().prepare("SELECT 1 FROM agents WHERE id = ?").get(agentId);
}

/** One owner e-mail's unsubscribe: its path, token check, write and wording. */
interface UnsubKind {
  path: string;
  log: string;
  verify: (token: string) => string | null;
  record: (db: ReturnType<typeof getDb>, agentId: string) => SetOwnerFeatureResult;
  mineValgUrl: (agentId: string) => string;
  title: string;
  question: string;
  confirm: string;
  button: string;
  doneTitle: string;
  done: string;
  again: string;
  conflict: string;
}

const REPORT: UnsubKind = {
  path: "/rapport-avmeld/:token",
  log: "rapport-avmeld",
  verify: verifyOwnerReportUnsubToken,
  record: recordOwnerReportUnsubscribe,
  mineValgUrl: ownerMineValgReportUrl,
  title: "Rapport om profilen",
  question: "Vil du slutte å få rapporten?",
  confirm: "Bekreft, så sender vi ikke flere rapporter om profilen din på Rett fra Bonden.",
  button: "Ikke send flere rapporter",
  doneTitle: "Du får ikke flere rapporter",
  done: "Vi sender ikke flere rapporter om profilen din på Rett fra Bonden.",
  again: "Vil du ha rapporten igjen",
  conflict: "så stopper vi rapportene for deg",
};

// S5-5: the milestone e-mail (notify.milestones = false).
const MILESTONES: UnsubKind = {
  path: "/milepael-avmeld/:token",
  log: "milepael-avmeld",
  verify: verifyOwnerMilestoneUnsubToken,
  record: recordOwnerMilestoneUnsubscribe,
  mineValgUrl: ownerMineValgMilestonesUrl,
  title: "E-post om milepæler",
  question: "Vil du slutte å få e-post om milepæler?",
  confirm: "Bekreft, så sender vi ikke flere e-poster om milepæler for profilen din på Rett fra Bonden.",
  button: "Ikke send flere e-poster om milepæler",
  doneTitle: "Du får ikke flere e-poster om milepæler",
  done: "Vi sender ikke flere e-poster om milepæler for profilen din på Rett fra Bonden.",
  again: "Vil du ha e-post om milepæler igjen",
  conflict: "så stopper vi e-postene om milepæler for deg",
};

// S5-6: the daily change digest (notify.changes = false).
const CHANGES: UnsubKind = {
  path: "/endring-avmeld/:token",
  log: "endring-avmeld",
  verify: verifyOwnerChangesUnsubToken,
  record: recordOwnerChangesUnsubscribe,
  mineValgUrl: ownerMineValgChangesUrl,
  title: "E-post om endringer",
  question: "Vil du slutte å få e-post om endringer på profilen?",
  confirm: "Bekreft, så sender vi ikke flere e-poster om endringer på profilen din på Rett fra Bonden.",
  button: "Ikke send flere e-poster om endringer",
  doneTitle: "Du får ikke flere e-poster om endringer",
  done: "Vi sender ikke flere e-poster om endringer på profilen din på Rett fra Bonden.",
  again: "Vil du ha e-post om endringer igjen",
  conflict: "så stopper vi e-postene om endringer for deg",
};

function mountUnsubscribe(k: UnsubKind): void {
  const rapportAvmeldLimiter = makeAvmeldLimiter();
  const mineValgLine = (agentId: string) =>
    `<p>${esc(k.again)}, kan du endre det i <a href="${esc(k.mineValgUrl(agentId))}">«Mine valg»</a>.</p>`;

  router.get(k.path, rapportAvmeldLimiter, (req: Request, res: Response) => {
    noStore(res);
    const agentId = k.verify(String(req.params.token || ""));
    try {
      if (!agentId || !agentExists(agentId)) return notFound(res);
    } catch (err) {
      console.error(`[${k.log}] lookup failed:`, err instanceof Error ? err.message : "error");
      return res.status(500).send(page("Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`));
    }
    // Read-only: shows the confirmation form, writes nothing.
    return res.status(200).send(page(k.title, `<h1>${esc(k.question)}</h1>
<p>${esc(k.confirm)} Profilen din blir ikke endret eller slettet.</p>
<form method="post" action=""><button type="submit">${esc(k.button)}</button></form>
${mineValgLine(agentId)}`));
  });

  router.post(k.path, rapportAvmeldLimiter, express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    noStore(res);
    // The form button and the RFC 8058 one-click body (List-Unsubscribe=One-Click) do the same.
    const agentId = k.verify(String(req.params.token || ""));
    if (!agentId) return notFound(res);
    let result: SetOwnerFeatureResult;
    try {
      result = k.record(resolveDb(), agentId);
    } catch (err) {
      console.error(`[${k.log}] write failed:`, err instanceof Error ? err.message : "error");
      return res.status(500).send(page("Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`));
    }
    if (result.kind === "not_found" || result.kind === "unknown_key") return notFound(res);
    if (result.kind !== "ok") {
      // Kill switch or admin lock: say so plainly; nothing was changed.
      console.error(`[${k.log}] not recorded: ${result.kind}${result.kind === "blocked" ? `/${result.block}` : ""}`);
      return res.status(409).send(page("Ikke registrert", `<h1>Vi kunne ikke registrere avmeldingen</h1>
<p>Skriv til <a href="mailto:${CONTACT}">${CONTACT}</a>, ${esc(k.conflict)}.</p>`));
    }
    return res.status(200).send(page("Avmeldt", `<h1>${esc(k.doneTitle)}</h1>
<p>${esc(k.done)} Profilen din er ikke endret eller slettet.</p>
${mineValgLine(agentId)}`));
  });
}

mountUnsubscribe(REPORT);
mountUnsubscribe(MILESTONES);
mountUnsubscribe(CHANGES);

export default router;
