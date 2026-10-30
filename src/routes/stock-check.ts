// ─── /lagerstatus/:token — the stock-check reminder's confirm link (B2) ─────
// dev-request 2026-10-28-rfb-bestillinger-fra-start-til-slutt-for-eier, B2.
// Logic: services/stock-check-reminder.ts. Behind STOCK_CHECK_EMAIL_ENABLED
// (default OFF → 404, as if the route did not exist) — the links only exist
// in e-mails that flag sends. B1a: a valid token for a producer off the
// owner-features allowlist (OWNER_FEATURES_ALLOWED_SUBJECTS) is the same 404.
//
//   GET  /lagerstatus/:token  shows which items would be confirmed. Changes
//                             NOTHING (mail scanners and link prefetchers GET
//                             links).
//   POST /lagerstatus/:token  confirms them: 'in_stock', source
//                             producer_dashboard, through the existing write
//                             path — only rows still orderable apart from the
//                             expiry and confirmable under B1's rule.
//
// The token is the authority (signed, expiring, one producer, one notice row);
// no session is needed or set. A wrong or expired token never writes. POST
// refuses a cross-site Origin (403), like the owner portal's form POSTs. The
// token is never logged and never echoed on the pages.

import express, { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  isStockCheckEmailEnabled,
  stockCheckAllowlisted,
  verifyStockCheckToken,
  stockCheckConfirmableItems,
  confirmStockCheckItems,
  markStockCheckConfirmed,
  formatStockCheckDate,
  STOCK_CHECK_PATH,
  type StockCheckItem,
} from "../services/stock-check-reminder";
import { getSupplyGraphStaleDays } from "../services/supply-graph";
import { portalShell, escapeHtml, crossSiteRequest } from "./owner-portal";

const router = Router();

const stockCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: "For mange forsøk. Prøv igjen om litt.",
});

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function card(inner: string): string {
  return `<div class="ep-card">${inner}</div>`;
}

const INVALID_HTML = card(`<h1>Ugyldig lenke</h1><p>Lenken er ugyldig. Logg inn på eiersiden for å bekrefte varene dine, eller skriv til <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a>.</p>`);
const EXPIRED_HTML = card(`<h1>Lenken har gått ut</h1><p>Lenken i e-posten gjelder ikke lenger. Logg inn på eiersiden for å bekrefte varene dine.</p>`);

function itemList(items: StockCheckItem[], expiredLabel: boolean, now: Date): string {
  return `<ul class="ep-audit-list">${items.map((i) => {
    const gone = Date.parse(i.expires_at) <= now.getTime();
    const when = formatStockCheckDate(i.expires_at);
    const meta = expiredLabel ? (gone ? `utgikk ${when}` : `gjelder til ${when}`) : "";
    return `<li class="ep-audit-item" data-product-id="${escapeHtml(i.id)}"><strong>${escapeHtml(i.name)}</strong>${meta ? ` <span class="ep-audit-meta">${escapeHtml(meta)}</span>` : ""}</li>`;
  }).join("")}</ul>`;
}

function portalLink(agentId: string): string {
  return `<p><a href="/eier/${encodeURIComponent(agentId)}/portal">Gå til eiersiden</a> (krever innlogging)</p>`;
}

router.get(`${STOCK_CHECK_PATH}/:token`, stockCheckLimiter, (req: Request, res: Response) => {
  if (!isStockCheckEmailEnabled()) return res.status(404).send("Not found");
  noStore(res);
  const v = verifyStockCheckToken(String(req.params.token || ""));
  if (v.state === "invalid") return res.status(400).send(portalShell("Ugyldig lenke", INVALID_HTML));
  if (v.state === "expired") return res.status(410).send(portalShell("Lenken har gått ut", EXPIRED_HTML));
  if (!stockCheckAllowlisted(v.agent_id)) return res.status(404).send("Not found");
  // Read-only: lists what a POST would write, writes nothing.
  const now = new Date();
  const items = stockCheckConfirmableItems(v.agent_id, v.product_ids, { now });
  if (items.length === 0) {
    return res.status(200).send(portalShell("Ingen varer å bekrefte", card(
      `<h1>Ingen varer å bekrefte</h1><p>Varene i e-posten er allerede bekreftet, eller de kan ikke bekreftes herfra lenger.</p>${portalLink(v.agent_id)}`,
    )));
  }
  const days = getSupplyGraphStaleDays();
  return res.status(200).send(portalShell("Bekreft lagerstatus", card(
    `<h1>Bekreft at varene fortsatt er på lager</h1>
<p>${escapeHtml(v.producer_name)}: når du trykker «Bekreft», står ${items.length === 1 ? "denne varen" : `disse ${items.length} varene`} som på lager i ${days} nye dager, og kundene kan bestille ${items.length === 1 ? "den" : "dem"}.</p>
${itemList(items, true, now)}
<form method="post" action=""><button type="submit" class="ep-btn ep-btn-primary">Bekreft</button></form>
<p class="ep-audit-meta">Har du ikke varen lenger? Ikke trykk her. Logg inn og endre varene dine i stedet.</p>
${portalLink(v.agent_id)}`,
  )));
});

router.post(`${STOCK_CHECK_PATH}/:token`, stockCheckLimiter, express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  if (!isStockCheckEmailEnabled()) return res.status(404).send("Not found");
  noStore(res);
  if (crossSiteRequest(req)) return res.status(403).send(portalShell("Ingen tilgang", card(`<h1>Ingen tilgang</h1>`)));
  const v = verifyStockCheckToken(String(req.params.token || ""));
  if (v.state === "invalid") return res.status(400).send(portalShell("Ugyldig lenke", INVALID_HTML));
  if (v.state === "expired") return res.status(410).send(portalShell("Lenken har gått ut", EXPIRED_HTML));
  if (!stockCheckAllowlisted(v.agent_id)) return res.status(404).send("Not found");
  try {
    const now = new Date();
    const r = confirmStockCheckItems(v.agent_id, v.product_ids, { now, via: "link" });
    if (r.confirmed.length > 0) markStockCheckConfirmed(v.notice_id, r.confirmed.length, { now });
    if (r.confirmed.length === 0) {
      return res.status(200).send(portalShell("Ingen varer å bekrefte", card(
        `<h1>Ingen varer å bekrefte</h1><p>Varene i e-posten er allerede bekreftet, eller de kan ikke bekreftes herfra lenger.</p>${portalLink(v.agent_id)}`,
      )));
    }
    const until = formatStockCheckDate(new Date(now.getTime() + getSupplyGraphStaleDays() * 86_400_000).toISOString());
    return res.status(200).send(portalShell("Varene er bekreftet", card(
      `<h1>Takk! Varene er bekreftet på lager</h1>
<p>${r.confirmed.length === 1 ? "Denne varen" : `Disse ${r.confirmed.length} varene`} kan bestilles til ${escapeHtml(until)}:</p>
${itemList(r.confirmed, false, now)}
${portalLink(v.agent_id)}`,
    )));
  } catch (err) {
    console.error("[stock-check] confirm failed:", err instanceof Error ? err.message : "error");
    return res.status(500).send(portalShell("Noe gikk galt", card(`<h1>Noe gikk galt</h1><p>Ingenting ble lagret. Prøv igjen senere.</p>`)));
  }
});

export default router;
