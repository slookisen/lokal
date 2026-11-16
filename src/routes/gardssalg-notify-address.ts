import express, { Router, Request, Response } from "express";
import { generalLimiter } from "../middleware/security";
import {
  isCrossSiteWrite, writeGuardRefusedBody, WRITE_GUARD_REFUSED_TITLE, WRITE_GUARD_CONTACT_OPPLEVAGENT,
} from "../middleware/same-origin-write";
import {
  addressConfirmPath, addressText, confirmAddressToken, gardssalgNotifyAddressConfirmEnabled, lookupAddressToken,
} from "../services/gardssalg-notify-address";

// ─── O4-3: the page the address-confirmation link opens ─────────────────────
// A2A dev-request 2026-11-12-opplevagent-o4-epost-og-tekster, slice O4-3.
//
//   GET  /kategori/gardssalg/eier/adresse/:token   the page (3.3) — READ ONLY:
//                                                  shows the producer and the
//                                                  address and one button.
//   POST /kategori/gardssalg/eier/adresse/:token   the button: confirms the
//                                                  address, uses up the token.
//
// GARDSSALG_NOTIFY_ADDRESS_CONFIRM_ENABLED off → both call next('route'), so
// the URLs answer exactly as before (no route of their own). An unknown,
// used, expired or stale token → `addr.page.expired` (410), nothing written.
// The paths sit under /kategori/gardssalg/eier, so the opplevagent.no host
// gate (gardssalgClaimHostGate) applies. Every answer is no-store, noindex
// and no-referrer (the token is in the path).

type Shell = (title: string, body: string) => string;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

const flagGate = (_req: Request, _res: Response, next: (arg?: unknown) => void) =>
  (gardssalgNotifyAddressConfirmEnabled() ? next() : next("route"));

function privateHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

export function createGardssalgNotifyAddressRouter(shell: Shell): Router {
  const router = Router();
  const heading = () => addressText("addr.page.heading");
  const card = (html: string) => `<div class="gc-card">${html}</div>`;
  const expired = (res: Response) =>
    res.status(410).send(shell(heading(), card(`<h1>${esc(heading())}</h1><p data-addr-page="expired">${esc(addressText("addr.page.expired"))}</p>`)));

  router.get(
    "/kategori/gardssalg/eier/adresse/:token",
    flagGate,
    generalLimiter,
    (req: Request, res: Response) => {
    privateHeaders(res);
    try {
      const token = String((req.params as any).token || "");
      const view = lookupAddressToken(token);
      if (!view) return expired(res);
      const body = `<h1>${esc(heading())}</h1>
        <p data-addr-page="confirm">${esc(addressText("addr.page.body", { produsent: view.produsent, adresse: view.email }))}</p>
        <form method="post" action="${esc(addressConfirmPath(token))}">
          <button type="submit" class="gc-btn gc-btn-primary">${esc(addressText("addr.page.button"))}</button>
        </form>`;
      return res.send(shell(heading(), card(body)));
    } catch (e) {
      console.error("[gardssalg-notify-address] GET page failed:", e);
      return expired(res);
    }
  });

  router.post(
    "/kategori/gardssalg/eier/adresse/:token",
    flagGate,
    generalLimiter,
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
    privateHeaders(res);
    try {
      const token = String((req.params as any).token || "");
      if (isCrossSiteWrite(req)) {
        // Back to the page itself (the label is its own OA-3 heading).
        return res.status(403).send(shell(WRITE_GUARD_REFUSED_TITLE, card(writeGuardRefusedBody({
          contact: WRITE_GUARD_CONTACT_OPPLEVAGENT, backHref: addressConfirmPath(token), backLabel: heading(),
        }))));
      }
      const view = confirmAddressToken(token);
      if (!view) return expired(res);
      return res.send(shell(heading(), card(`<h1>${esc(heading())}</h1><p data-addr-page="done" role="status">${esc(addressText("addr.page.done"))}</p>`)));
    } catch (e) {
      console.error("[gardssalg-notify-address] POST confirm failed:", e);
      return expired(res);
    }
  });

  return router;
}
