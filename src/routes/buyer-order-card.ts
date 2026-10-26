/**
 * The buyer's order card (Fase B1 of dev-request 2026-10-21-rfb-mine-ordrer-
 * ett-klikk-og-kjoperagent).
 *
 *   GET  /ordre/:id?ref=<buyer_ref>   the one order, compact and expandable
 *   POST /ordre/:id                   one buyer action (form field ref), PRG
 *
 * Auth: the buyer_ref (the buyer's capability from the cart) and nothing
 * else; no cookie. A missing or wrong ref and an unknown order give the same
 * bare 404. Every transition goes through applyBuyerOrderCommand →
 * applyOrderAction (channel "web"), the same rules as the MCP tools.
 *
 * Not behind ORDER_AGENT_ACTIONS_ENABLED: that switch holds back the MCP
 * contract change (the ChatGPT app review freeze). The card is a new page
 * like «Mine ordrer» (Fase A2, unflagged) and is rolled back by revert
 * (rollback plan of the dev-request).
 *
 * Headers: noindex (meta + X-Robots-Tag), Cache-Control: no-store and
 * Referrer-Policy: no-referrer, so the ref in the URL is not passed on.
 */

import express, { Router, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "crypto";
import { cartServiceDb, getOrderTimeline, orderPaymentMode, PAYMENT_MODE_UNKNOWN, producerContact, producerTraderStatus } from "../services/cart-service";
import { applyBuyerOrderCommand, buyerAvailableActions, getBuyerOrderRow, type BuyerOrderCommand } from "../services/buyer-order-actions";
import { CONSUMER_CANCEL_LOSS_SENTENCE } from "../services/order-receipt-service";
import { isPaymentsLifecycleActive, resolvePaymentsStripeClient } from "../services/payment-service";
import type { PaymentsStripeClient } from "../services/payment-provider";
import { formatPickupTimeOslo } from "../services/order-lifecycle";
import { PRICE_BY_AGREEMENT } from "../services/order-pricing";
import { ordersShell, esc, itemsSummary } from "./owner-orders-view";

const router = Router();

export const buyerOrderCardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: "For mange forespørsler. Prøv igjen om litt.",
});

const COMMANDS: Record<string, BuyerOrderCommand> = Object.assign(Object.create(null), {
  cancel: "cancel",
  picked_up: "picked_up",
});

function param(req: Request, name: string): string {
  const v = (req.params as Record<string, unknown>)[name];
  return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
}

function q(req: Request, name: string): string {
  const v = req.query[name];
  return Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "";
}

/** A browser form post from another site is refused (Origin present and not our host) — as owner-orders.ts. */
function crossSite(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== "string") return false;
  try { return new URL(origin).host !== String(req.headers.host || ""); } catch { return true; }
}

function cardHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function notFound(res: Response): void {
  cardHeaders(res);
  res.status(404).send(ordersShell("Ikke funnet", `<h1>Siden finnes ikke</h1>`));
}

function paymentsClientFor(req: Request): PaymentsStripeClient | null {
  return isPaymentsLifecycleActive()
    ? resolvePaymentsStripeClient(req.app.get("paymentsStripeClient") as PaymentsStripeClient | undefined)
    : null;
}

function idemFrom(body: Record<string, unknown>): string | null {
  const v = body["idem"];
  return typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v) ? `web:${v}` : null;
}

export function cardPath(orderId: string, ref: string): string {
  return `/ordre/${encodeURIComponent(orderId)}?ref=${encodeURIComponent(ref)}`;
}

function buyerStatusLabel(status: string, cancelReason: string | null, completionSource: string | null): { text: string; cls: string } {
  switch (status) {
    case "pending": return { text: "Venter på svar fra produsenten", cls: "wait" };
    case "confirmed":
    case "ready": return { text: "Bekreftet", cls: "ok" };
    case "declined": return { text: "Avslått av produsenten", cls: "end" };
    case "completed": return { text: completionSource === "auto" ? "Avsluttet automatisk" : "Hentet", cls: "ok" };
    case "cancelled":
      switch (cancelReason) {
        case "buyer_cancelled": return { text: "Avbestilt", cls: "end" };
        case "no_show": return { text: "Registrert som ikke hentet", cls: "end" };
        case "producer_cancelled": return { text: "Kansellert av produsenten", cls: "end" };
        case "producer_no_response": return { text: "Ikke besvart i tide", cls: "end" };
        case "payment_expired": return { text: "Betalingen utløp", cls: "end" };
        default: return { text: "Kansellert", cls: "end" };
      }
    default: return { text: status, cls: "end" };
  }
}

function bannerHtml(done: string, error: string): string {
  if (error === "ugyldig") return `<div class="mo-banner warn" role="alert">Handlingen er ikke mulig for bestillingens status akkurat nå.</div>`;
  if (error) return `<div class="mo-banner warn" role="alert">Kunne ikke oppdatere bestillingen. Prøv igjen.</div>`;
  if (done === "cancelled") return `<div class="mo-banner ok" role="status">Bestillingen er avbestilt. Produsenten får beskjed.</div>`;
  if (done === "completed") return `<div class="mo-banner ok" role="status">Takk! Bestillingen er registrert som hentet.</div>`;
  return "";
}

/** Shown above «Avbestill» on a confirmed order: the same rule the receipt and the MCP answer give. */
function cancelWarningText(producerName: string, traderStatus: "trader" | "non_trader" | null): string {
  if (traderStatus === "non_trader") {
    return `Bestillingen er bekreftet og bindende. ${producerName} har oppgitt at produsenten ikke selger som næringsdrivende, ` +
      `så kjøpsloven gjelder, ikke forbrukerkjøpsloven. Avtal et eventuelt oppgjør med ${producerName} direkte.`;
  }
  return `Bestillingen er bekreftet og bindende. Vil du likevel avbestille? ${CONSUMER_CANCEL_LOSS_SENTENCE}`;
}

const TIMELINE_LABEL: Record<string, string> = {
  pending: "Sendt", confirmed: "Bekreftet", ready: "Bekreftet", declined: "Avslått", completed: "Avsluttet", cancelled: "Kansellert",
};

export function renderBuyerOrderCard(orderId: string, ref: string, done: string, error: string): string | null {
  const db = cartServiceDb();
  const o = getBuyerOrderRow(orderId, ref, db);
  if (!o) return null;
  const row = db.prepare("SELECT total_nok, created_at FROM orders WHERE id = ?").get(o.id) as { total_nok: number | null; created_at: string };
  const items = db.prepare("SELECT name_snapshot, qty, line_total FROM order_items WHERE order_id = ? ORDER BY rowid").all(o.id) as
    Array<{ name_snapshot: string | null; qty: number | null; line_total: number | null }>;
  let mode: string | null;
  try { mode = orderPaymentMode(db, o.id); } catch { mode = PAYMENT_MODE_UNKNOWN; }
  const actions = buyerAvailableActions(o.status, mode);
  const contact = producerContact(o.agent_id, o.producer_name);
  const st = buyerStatusLabel(o.status, o.cancel_reason, o.completion_source);
  const pick = o.pickup_time ? `Henting ${formatPickupTimeOslo(o.pickup_time)}` : "Hentetid ikke satt ennå. Avtal med produsenten.";

  const form = (cmd: BuyerOrderCommand, label: string, cls: string) =>
    `<form method="post" action="/ordre/${esc(encodeURIComponent(o.id))}" class="mo-form">` +
    `<input type="hidden" name="ref" value="${esc(ref)}"><input type="hidden" name="action" value="${cmd}">` +
    `<input type="hidden" name="idem" value="${randomUUID()}"><button type="submit" class="mo-btn ${cls}">${esc(label)}</button></form>`;
  const parts: string[] = [];
  if (actions.includes("picked_up")) parts.push(form("picked_up", "Jeg har hentet", "mo-primary"));
  if (actions.includes("withdraw")) {
    parts.push(`<p class="mo-hint">Produsenten har ikke bekreftet ennå, så du kan avbestille gratis.</p>`);
    parts.push(form("cancel", "Avbestill", "mo-secondary"));
  }
  if (actions.includes("cancel")) {
    parts.push(`<p class="mo-hint">${esc(cancelWarningText(o.producer_name, producerTraderStatus(db, o.agent_id)))}</p>`);
    parts.push(form("cancel", "Avbestill", "mo-secondary"));
  }
  const actionsHtml = parts.length ? `<div class="mo-actions">${parts.join("")}</div>` : "";

  const itemRows = items.map((i) =>
    `<li><span>${esc(i.qty ?? "?")} × ${esc(i.name_snapshot || "Vare")}</span><span>${i.line_total != null ? `${esc(i.line_total)} kr` : esc(PRICE_BY_AGREEMENT)}</span></li>`,
  ).join("");
  const sum = row.total_nok != null ? `<p class="mo-sum">Sum: ${esc(row.total_nok)} kr</p>` : "";
  const contactHtml = [
    contact.phone ? `<div><strong>Telefon:</strong> <a href="tel:${esc(contact.phone.replace(/\s+/g, ""))}">${esc(contact.phone)}</a></div>` : "",
    contact.email ? `<div><strong>E-post:</strong> <a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a></div>` : "",
    contact.address ? `<div><strong>Adresse:</strong> ${esc(contact.address)}</div>` : "",
    `<div><a href="${esc(contact.profile_url)}" rel="noreferrer">Produsentens profil</a></div>`,
  ].filter(Boolean).join("");
  const timeline = getOrderTimeline(o.id);
  const tl = timeline.length
    ? `<div class="mo-block"><strong>Tidslinje</strong><ul class="mo-tl">${timeline.map((e) =>
        `<li>${esc(formatPickupTimeOslo(e.created_at))}: ${esc(TIMELINE_LABEL[e.to_status] || e.to_status)}</li>`).join("")}</ul></div>`
    : "";

  return ordersShell(`Bestilling ${o.id.slice(0, 8)}`, `
<h1>Bestillingen din hos ${esc(o.producer_name)}</h1>
<p class="mo-sub">Ordre ${esc(o.id.slice(0, 8))}</p>
${bannerHtml(done, error)}
<div class="mo-row">
  <div class="mo-detail" style="border-top:none">
    <p class="mo-top"><span class="mo-who">${esc(itemsSummary(items))}</span><span class="mo-badge mo-${st.cls}">${esc(st.text)}</span></p>
    <p class="mo-pick-line">${esc(pick)}</p>
    ${actionsHtml}
  </div>
  <details class="mo-row" style="border:none;margin:0">
    <summary>Vis varer og kontaktinfo</summary>
    <div class="mo-detail">
      <div class="mo-block"><strong>Varer</strong><ul class="mo-items">${itemRows}</ul>${sum}</div>
      <div class="mo-block"><strong>Kontakt ${esc(o.producer_name)}</strong>${contactHtml}</div>
      ${tl}
    </div>
  </details>
</div>
<p class="mo-hint">Lenken er personlig for denne bestillingen. Ikke del den videre.</p>`);
}

router.get("/ordre/:id", buyerOrderCardLimiter, (req: Request, res: Response) => {
  try {
    const html = renderBuyerOrderCard(param(req, "id"), q(req, "ref"), q(req, "done"), q(req, "error"));
    if (!html) return notFound(res);
    cardHeaders(res);
    return res.send(html);
  } catch (err) {
    console.error("[buyer-order-card] GET failed:", err instanceof Error ? err.message : "error");
    cardHeaders(res);
    return res.status(500).send(ordersShell("Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`));
  }
});

router.post("/ordre/:id", buyerOrderCardLimiter, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const orderId = param(req, "id");
  const body = (req.body || {}) as Record<string, unknown>;
  const ref = typeof body["ref"] === "string" ? (body["ref"] as string) : "";
  try {
    if (!getBuyerOrderRow(orderId, ref)) return notFound(res);
    if (crossSite(req)) { cardHeaders(res); return res.status(403).send(ordersShell("Ikke tillatt", `<h1>Ikke tillatt</h1>`)); }
    const back = cardPath(orderId, ref);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    const command = COMMANDS[String(body["action"] || "")];
    if (!command) return res.redirect(303, `${back}&error=ugyldig`);
    const result = await applyBuyerOrderCommand(orderId, ref, command, "web", {
      idempotencyKey: idemFrom(body), payments: paymentsClientFor(req),
    });
    if (!result.success) return res.redirect(303, `${back}&error=${result.status === 409 ? "ugyldig" : "feil"}`);
    return res.redirect(303, `${back}&done=${encodeURIComponent(result.status)}`);
  } catch (err) {
    console.error("[buyer-order-card] POST failed:", err instanceof Error ? err.message : "error");
    cardHeaders(res);
    return res.status(500).send(ordersShell("Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`));
  }
});

export default router;
