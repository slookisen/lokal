// ─── Owner beta: opt-in / opt-out / register-interest (POST only) ───────────
// A2A dev-request 2026-11-09-rfb-eierverktoy-beta-for-alle, slice S3.
//
//   POST /eier/:agentId/beta/pa         opt in (requires the terms checkbox)
//   POST /eier/:agentId/beta/interesse  register interest (cap reached)
//   POST /eier/:agentId/beta/av         opt out (allowed in any mode)
//
// Every handler, like the other owner forms:
//   1. valid owner session (else → the login page), AND
//   2. isVerifiedOwner of THIS agent (else 403) — only the owner's own row, AND
//   3. the shared same-origin write guard (checkSameOriginWrite — it handles
//      the browser-form `Origin: null` case; see middleware/same-origin-write.ts).
// Opt-in and interest are then refused (`beta_not_offered`, no row) for an
// agent whose own agents.vertical_id is not rfb (betaJoinAllowed — the
// S2 write only checks its `vertical` argument, which is always the constant
// `rfb`) and for a pilot owner (who already has the tools; a pilot row would
// take a cap slot). Then it calls the S2 write (beta-enrollment.ts) — which
// enforces mode `offer` for opt-in/interest (opt-out any mode), the cap, and
// the single owner_feature_audit row — and redirects (PRG) back to the portal
// with a status message. Nothing is e-mailed. Mode ≠ offer → opt-in/interest is
// rejected by beta-enrollment (`not_offered`); opt-out still works.
//
// With OWNER_BETA_MODE unset/off these are harmless: opt-in/interest answer
// `not_offered`, and the card that links here is never rendered (beta-card.ts).

import { Router, Request, Response } from "express";
import express from "express";
import { getDb } from "../database/init";
import {
  verifyOwnerSession, isVerifiedOwner, portalShell, ownerNotVerifiedPage, portalWriteRefusedPage,
} from "./owner-portal";
import { isCrossSiteWrite } from "../middleware/same-origin-write";
import { optIn, optOut, registerInterest, OWNER_BETA_VERTICAL, type BetaWriteResult } from "../owner-features/beta-enrollment";
import { betaJoinAllowed } from "../owner-features/beta-card";
import { BETA_TERMS_VERSION } from "../owner-features/beta-texts";

const router = Router();

function sessionEmail(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const row = getDb().prepare("SELECT email FROM magic_links WHERE token = ?").get(token) as { email?: string } | undefined;
    return row?.email ?? null;
  } catch {
    return null;
  }
}

type Gate = { ok: true; agentId: string; token?: string } | { ok: false; send: (res: Response) => Response };

function betaGate(req: Request): Gate {
  const agentId = String((req.params as any).agentId || "");
  const session = verifyOwnerSession(req);
  if (!session.valid) {
    return { ok: false, send: (res) => { res.redirect(302, `/eier/${encodeURIComponent(agentId)}`); return res; } };
  }
  if (!isVerifiedOwner(agentId, session)) {
    if (session.agentId === agentId) return { ok: false, send: (res) => res.status(403).send(ownerNotVerifiedPage(agentId)) };
    return {
      ok: false,
      send: (res) => res.status(403).send(portalShell("Ingen tilgang", `<div class="ep-card"><h1>Ingen tilgang</h1><p>Du har ikke tilgang til denne produsenten.</p></div>`)),
    };
  }
  return { ok: true, agentId, token: session.token };
}

/**
 * Opt-in / interest only for a non-pilot Rett fra Bonden agent (the same rule
 * as the card: betaJoinAllowed). Fail closed: a DB error throws to the
 * handler's catch → beta_error, no row.
 */
function joinRefused(agentId: string): boolean {
  return !betaJoinAllowed(agentId, process.env);
}

function back(res: Response, agentId: string, status: string): Response {
  res.redirect(303, `/eier/${encodeURIComponent(agentId)}/portal?status=${encodeURIComponent(status)}`);
  return res;
}

/** The same-origin write guard (browser-form Origin: null safe); refused → the portal refusal page. */
function guard(req: Request, res: Response, agentId: string, routePattern: string): Response | null {
  if (isCrossSiteWrite(req, routePattern)) {
    return res.status(403).send(portalWriteRefusedPage(`/eier/${encodeURIComponent(agentId)}/portal`));
  }
  return null;
}

router.post("/eier/:agentId/beta/pa", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  try {
    const g = betaGate(req);
    if (!g.ok) return g.send(res);
    const refused = guard(req, res, g.agentId, "/eier/:agentId/beta/pa");
    if (refused) return refused;
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const accepted = body.vilkar === "1" || body.vilkar === "on" || body.vilkar === "true";
    if (joinRefused(g.agentId)) return back(res, g.agentId, "beta_not_offered");
    if (!accepted) return back(res, g.agentId, "beta_terms");
    const out: BetaWriteResult = optIn(OWNER_BETA_VERTICAL, g.agentId, BETA_TERMS_VERSION, { actor: "owner", actorDetail: sessionEmail(g.token) });
    if (out.kind === "not_offered") return back(res, g.agentId, "beta_not_offered");
    if (out.kind !== "ok") return back(res, g.agentId, "beta_error");
    if (out.status === "interested") return back(res, g.agentId, out.changed ? "beta_capped" : "beta_no_change");
    return back(res, g.agentId, out.changed ? "beta_on" : "beta_no_change");
  } catch (e) {
    console.error("[owner-beta] POST beta/pa failed:", e instanceof Error ? e.message : "error");
    return back(res, String((req.params as any).agentId || ""), "beta_error");
  }
});

router.post("/eier/:agentId/beta/interesse", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  try {
    const g = betaGate(req);
    if (!g.ok) return g.send(res);
    const refused = guard(req, res, g.agentId, "/eier/:agentId/beta/interesse");
    if (refused) return refused;
    if (joinRefused(g.agentId)) return back(res, g.agentId, "beta_not_offered");
    const out: BetaWriteResult = registerInterest(OWNER_BETA_VERTICAL, g.agentId, { actor: "owner", actorDetail: sessionEmail(g.token) });
    if (out.kind === "not_offered") return back(res, g.agentId, "beta_not_offered");
    if (out.kind !== "ok") return back(res, g.agentId, "beta_error");
    return back(res, g.agentId, out.changed ? "beta_interest" : "beta_interest_exists");
  } catch (e) {
    console.error("[owner-beta] POST beta/interesse failed:", e instanceof Error ? e.message : "error");
    return back(res, String((req.params as any).agentId || ""), "beta_error");
  }
});

router.post("/eier/:agentId/beta/av", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  try {
    const g = betaGate(req);
    if (!g.ok) return g.send(res);
    const refused = guard(req, res, g.agentId, "/eier/:agentId/beta/av");
    if (refused) return refused;
    const out: BetaWriteResult = optOut(OWNER_BETA_VERTICAL, g.agentId, { actor: "owner", actorDetail: sessionEmail(g.token) });
    if (out.kind !== "ok") return back(res, g.agentId, "beta_error");
    return back(res, g.agentId, out.changed ? "beta_off" : "beta_no_change");
  } catch (e) {
    console.error("[owner-beta] POST beta/av failed:", e instanceof Error ? e.message : "error");
    return back(res, String((req.params as any).agentId || ""), "beta_error");
  }
});

export default router;
