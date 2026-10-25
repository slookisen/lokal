/**
 * «Mine ordrer» routes (Fase A2 of dev-request 2026-10-21-rfb-mine-ordrer-ett-
 * klikk-og-kjoperagent).
 *
 *   GET  /eier/:agentId/ordrer              owner session; three tabs
 *   POST /eier/:agentId/ordrer/:orderId     owner session; one action, PRG back to the row
 *   GET  /produsent/ordre/:token/kompakt    per-order e-mail token; THAT order only
 *   POST /produsent/ordre/:token/kompakt    per-order e-mail token; one action, PRG
 *
 * Auth: the existing owner session (verifyOwnerSession) is only used, never
 * changed. No session → redirect to the login page of that producer; another
 * producer's session → 403. The token path sets no cookie and reads nothing
 * but the one order the token belongs to.
 *
 * Every transition goes through applyOrderAction (Fase A1). Nothing here
 * touches payments rules, eligibility or the MCP/A2A surface.
 */

import express, { Router, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { getDb } from "../database/init";
import { verifyOwnerSession } from "./owner-portal";
import { applyOrderAction, type OrderAction } from "../services/order-actions";
import { isPaymentsLifecycleActive, resolvePaymentsStripeClient } from "../services/payment-service";
import type { PaymentsStripeClient } from "../services/payment-provider";
import {
  countOwnerOrders, listOwnerOrders, getOwnerOrder, getOwnerOrderByToken, parseTab, tabForStatus,
  renderOrdersPage, renderTokenOrderPage, ordersShell, esc, ROW_ANCHOR,
} from "./owner-orders-view";

const router = Router();

// Own limiter (a page that people reload and tap through), so this suite of
// routes does not share the 300/15 min counter of the API.
export const ownerOrdersLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: "For mange forespørsler. Prøv igjen om litt.",
});

const SELLER_ACTIONS: Record<string, OrderAction> = Object.assign(Object.create(null), {
  confirm: "confirm",
  decline: "decline",
  no_show: "no_show",
  buyer_cancelled: "buyer_cancelled",
  cannot_deliver: "cannot_deliver",
});

function paymentsClientFor(req: Request): PaymentsStripeClient | null {
  return isPaymentsLifecycleActive()
    ? resolvePaymentsStripeClient(req.app.get("paymentsStripeClient") as PaymentsStripeClient | undefined)
    : null;
}

function param(req: Request, name: string): string {
  const v = (req.params as Record<string, unknown>)[name];
  return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
}

function q(req: Request, name: string): string {
  const v = req.query[name];
  return Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "";
}

/** A browser form post from another site is refused (Origin present and not our host). */
function crossSite(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== "string") return false;
  try { return new URL(origin).host !== String(req.headers.host || ""); } catch { return true; }
}

function noStore(res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
}

function forbiddenPage(res: Response, loginHref: string): void {
  noStore(res);
  res.status(403).send(ordersShell("Ingen tilgang", `<h1>Ingen tilgang</h1><p>Sesjonen din er knyttet til en annen produsent. <a href="${esc(loginHref)}">Logg inn på nytt</a>.</p>`));
}

function notFoundPage(res: Response): void {
  noStore(res);
  res.status(404).send(ordersShell("Ordre ikke funnet", `<h1>Ordren ble ikke funnet</h1><p>Sjekk at du brukte hele lenken fra e-posten.</p>`));
}

function idemFrom(body: Record<string, unknown>): string | null {
  const v = body["idem"];
  return typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v) ? `mo:${v}` : null;
}

function pickupFrom(body: Record<string, unknown>, action: OrderAction): string | null {
  return action === "confirm" && typeof body["pickup_time"] === "string" ? (body["pickup_time"] as string) : null;
}

// ── Owner session: the list ────────────────────────────────────────────────

router.get("/eier/:agentId/ordrer", ownerOrdersLimiter, (req: Request, res: Response) => {
  const agentId = param(req, "agentId");
  try {
    const session = verifyOwnerSession(req);
    if (!session.valid) return res.redirect(302, `/eier/${encodeURIComponent(agentId)}`);
    if (session.agentId !== agentId) return forbiddenPage(res, `/eier/${encodeURIComponent(agentId)}`);

    const agent = getDb().prepare("SELECT id, name FROM agents WHERE id = ?").get(agentId) as { id: string; name: string } | undefined;
    if (!agent) return notFoundPage(res);

    const counts = countOwnerOrders(agentId);
    let tab = parseTab(req.query["tab"]);
    if (!tab) tab = counts.venter > 0 ? "venter" : "kommende";
    const orders = listOwnerOrders(agentId, tab);
    noStore(res);
    return res.send(renderOrdersPage({
      agentId, producerName: agent.name, tab, counts, orders,
      openId: q(req, "o") || null, done: q(req, "done"), error: q(req, "error"),
    }));
  } catch (err) {
    console.error("[owner-orders] GET list failed:", err instanceof Error ? err.message : "error");
    noStore(res);
    return res.status(500).send(ordersShell("Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`));
  }
});

// ── Owner session: one action ──────────────────────────────────────────────

router.post("/eier/:agentId/ordrer/:orderId", ownerOrdersLimiter, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const agentId = param(req, "agentId");
  const orderId = param(req, "orderId");
  const base = `/eier/${encodeURIComponent(agentId)}/ordrer`;
  try {
    const session = verifyOwnerSession(req);
    if (!session.valid) return res.redirect(302, `/eier/${encodeURIComponent(agentId)}`);
    if (session.agentId !== agentId) return forbiddenPage(res, `/eier/${encodeURIComponent(agentId)}`);
    if (crossSite(req)) { noStore(res); return res.status(403).send(ordersShell("Ikke tillatt", `<h1>Ikke tillatt</h1>`)); }

    const order = getOwnerOrder(agentId, orderId);
    if (!order) return notFoundPage(res);

    const body = (req.body || {}) as Record<string, unknown>;
    const action = SELLER_ACTIONS[String(body["action"] || "")];
    const back = (tab: string, extra: string) => `${base}?tab=${tab}&o=${encodeURIComponent(orderId)}${extra}#${ROW_ANCHOR(orderId)}`;
    if (!action) return res.redirect(303, back(tabForStatus(order.status), "&error=ugyldig"));

    const result = await applyOrderAction(
      orderId, action,
      { role: "seller", channel: "owner_portal", ref: `owner:${agentId.slice(0, 8)}` },
      { payments: paymentsClientFor(req), idempotencyKey: idemFrom(body), pickupTime: pickupFrom(body, action) },
    );
    if (!result.success) {
      const cur = getOwnerOrder(agentId, orderId);
      return res.redirect(303, back(tabForStatus(cur?.status ?? order.status), `&error=${result.status === 400 ? "hentetid" : "ugyldig"}`));
    }
    return res.redirect(303, back(tabForStatus(result.status), `&done=${encodeURIComponent(result.status)}`));
  } catch (err) {
    console.error("[owner-orders] POST action failed:", err instanceof Error ? err.message : "error");
    return res.redirect(303, `${base}?error=feil`);
  }
});

// ── Per-order token (e-mail link): that order only ─────────────────────────

router.get("/produsent/ordre/:token/kompakt", ownerOrdersLimiter, (req: Request, res: Response) => {
  try {
    const token = param(req, "token");
    const order = getOwnerOrderByToken(token);
    if (!order) return notFoundPage(res);
    noStore(res);
    return res.send(renderTokenOrderPage(order, `/produsent/ordre/${encodeURIComponent(token)}/kompakt`, q(req, "done"), q(req, "error")));
  } catch (err) {
    console.error("[owner-orders] GET token view failed:", err instanceof Error ? err.message : "error");
    noStore(res);
    return res.status(500).send(ordersShell("Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`));
  }
});

router.post("/produsent/ordre/:token/kompakt", ownerOrdersLimiter, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const token = param(req, "token");
  const back = `/produsent/ordre/${encodeURIComponent(token)}/kompakt`;
  try {
    const order = getOwnerOrderByToken(token);
    if (!order) return notFoundPage(res);
    if (crossSite(req)) { noStore(res); return res.status(403).send(ordersShell("Ikke tillatt", `<h1>Ikke tillatt</h1>`)); }

    const body = (req.body || {}) as Record<string, unknown>;
    const action = SELLER_ACTIONS[String(body["action"] || "")];
    if (!action) return res.redirect(303, `${back}?error=ugyldig`);

    const result = await applyOrderAction(
      order.id, action,
      { role: "seller", channel: "producer_page", ref: `token:${order.id.slice(0, 8)}` },
      { payments: paymentsClientFor(req), idempotencyKey: idemFrom(body), pickupTime: pickupFrom(body, action) },
    );
    if (!result.success) return res.redirect(303, `${back}?error=${result.status === 400 ? "hentetid" : "ugyldig"}`);
    return res.redirect(303, `${back}?done=${encodeURIComponent(result.status)}`);
  } catch (err) {
    console.error("[owner-orders] POST token action failed:", err instanceof Error ? err.message : "error");
    return res.redirect(303, `${back}?error=feil`);
  }
});

export default router;
