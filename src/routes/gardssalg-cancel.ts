// ─── Gårdssalg cancellation pages (O1-5) ────────────────────────────────────
//
// A2A dev-request 2026-11-12-opplevagent-o1-trygg-aa-aapne, slice O1-5. All
// logic and texts live in services/gardssalg-cancel.ts; this file is the
// pages and the plain HTML form POSTs (no JavaScript needed).
//
//   GET/POST /kategori/gardssalg/status/:bookingRef/:guestToken/avlys
//            guest: withdraw a request or cancel a confirmed visit. The guest
//            token is checked in constant time; the reference alone is never
//            enough (wrong token → the same 404 as an unknown page).
//   GET/POST /kategori/gardssalg/svar/:respondToken/avlys
//            producer: cancel a confirmed visit (reason required).
//
// GARDSSALG_CANCEL_ENABLED off → every route here calls next(), i.e. the
// site's ordinary 404, and the helpers used by experiences-seo.ts return
// null, so the status and svar pages are byte-identical to before.
//
// POSTs go through the shared same-origin write guard, which accepts the
// `Origin: null` a browser sends on a plain form post under
// `Referrer-Policy: no-referrer` (the RFB bug of 2026-10-30).

import express, { Router, Request, Response, NextFunction } from "express";
import {
  getBookingByRef,
  getBookingByRespondToken,
  osloDatetimeLocalToUtcIso,
  type GardssalgBooking,
} from "../services/booking-store";
import { guestTokenMatches } from "../services/gardssalg-attendance-guard";
import { fillOa1, formatOsloInstant, loadReceiptProvider } from "../services/gardssalg-honest-receipt";
import {
  gardssalgCancelEnabled,
  guestCancelMode,
  producerMayCancel,
  guestCancel,
  producerCancel,
  getCancelInfo,
  cancelledStatusLabel,
  cancelText,
  sendGuestCancelToProducer,
  sendProducerCancelToGuest,
  CANCEL_REASON_MAX,
} from "../services/gardssalg-cancel";
import {
  isCrossSiteWrite,
  writeGuardRefusedBody,
  WRITE_GUARD_REFUSED_TITLE,
  WRITE_GUARD_CONTACT_OPPLEVAGENT,
} from "../middleware/same-origin-write";

export type PageShell = (title: string, inner: string) => string;

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function guestStatusPath(booking: Pick<GardssalgBooking, "booking_ref">, guestToken: string): string {
  return `/kategori/gardssalg/status/${encodeURIComponent(booking.booking_ref)}/${encodeURIComponent(guestToken)}`;
}

export function svarPath(respondToken: string): string {
  return `/kategori/gardssalg/svar/${encodeURIComponent(respondToken)}`;
}

function producerName(booking: GardssalgBooking): string {
  return loadReceiptProvider(booking.provider_id).navn || "Produsenten";
}

function slotWords(booking: GardssalgBooking): string {
  return formatOsloInstant(osloDatetimeLocalToUtcIso(booking.slot_at) ?? booking.slot_at, "nb");
}

const TEXTAREA_STYLE =
  "width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:.95rem;background:var(--surface);color:var(--ink);font-family:inherit";
const BACK_LINK_STYLE = "display:block;text-align:center;text-decoration:none";

function gotoButton(href: string, label: string, cls: string): string {
  return `<form method="GET" action="${esc(href)}"><button type="submit" class="act-btn ${cls}">${esc(label)}</button></form>`;
}

// ─── Blocks for the existing status and svar pages ─────────────────────────

export interface CancelPageView {
  /** Replaces the status word (null: keep the page's own). */
  label: string | null;
  /** Replaces the status page's own note (null: keep it). */
  extra: string | null;
  /** Appended after the recap / actions ("" for nothing). */
  actions: string;
}

/** The guest status page's cancellation block; null when the flag is off. */
export function guestStatusCancelView(booking: GardssalgBooking, guestToken: string, done: string): CancelPageView | null {
  if (!gardssalgCancelEnabled()) return null;
  if (booking.status === "cancelled") {
    const info = getCancelInfo(booking.booking_id);
    const label = cancelledStatusLabel(booking, info);
    if (!label) return null;
    const pending = booking.pre_status !== "provider_confirmed";
    const extra = done === "avlyst" && info?.cancelled_by === "guest"
      ? `<div class="bekreft-banner ok" role="status"><strong>${esc(cancelText(pending ? "cancel.guest.done.headingPending" : "cancel.guest.done.heading"))}</strong><br>${esc(fillOa1(cancelText("cancel.guest.done.body"), { produsent: producerName(booking), ref: booking.booking_ref }))}</div>`
      : "";
    return { label, extra, actions: "" };
  }
  const mode = guestCancelMode(booking);
  if (!mode) return { label: null, extra: null, actions: "" };
  return {
    label: null,
    extra: null,
    actions: `\n    ${gotoButton(`${guestStatusPath(booking, guestToken)}/avlys`, cancelText(mode === "withdraw" ? "cancel.guest.buttonPending" : "cancel.guest.button"), "act-secondary")}`,
  };
}

/** The producer svar page's cancellation block; null when the flag is off. */
export function svarCancelView(booking: GardssalgBooking, respondToken: string, done: string): CancelPageView | null {
  if (!gardssalgCancelEnabled()) return null;
  if (booking.status === "cancelled") {
    const info = getCancelInfo(booking.booking_id);
    const label = cancelledStatusLabel(booking, info);
    if (!label) return null;
    const extra = done === "avlyst" && info?.cancelled_by === "producer"
      ? `<div class="bekreft-banner ok" role="status"><strong>${esc(cancelText("cancel.producer.done.heading"))}</strong><br>${esc(fillOa1(cancelText("cancel.producer.done.body"), { gjest: booking.guest_name, ref: booking.booking_ref }))}</div>`
      : "";
    return { label, extra, actions: "" };
  }
  if (!producerMayCancel(booking)) return { label: null, extra: null, actions: "" };
  return {
    label: null,
    extra: null,
    actions: `\n    ${gotoButton(`${svarPath(respondToken)}/avlys`, cancelText("cancel.producer.button"), "act-secondary")}`,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

function sendPage(res: Response, page: PageShell, title: string, inner: string, status = 200): void {
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(page(title, inner));
}

function refuseCrossSite(req: Request, res: Response, page: PageShell, backHref: string): boolean {
  if (!isCrossSiteWrite(req)) return false;
  sendPage(res, page, WRITE_GUARD_REFUSED_TITLE, writeGuardRefusedBody({
    contact: WRITE_GUARD_CONTACT_OPPLEVAGENT,
    backHref,
    backLabel: cancelText("cancel.back"),
  }), 403);
  return true;
}

function loadGuestBooking(req: Request): { booking: GardssalgBooking; token: string } | null {
  const ref = String(req.params.bookingRef || "");
  const token = String(req.params.guestToken || "");
  if (!ref || !token) return null;
  let booking: GardssalgBooking | null = null;
  try {
    booking = getBookingByRef(ref);
  } catch {
    booking = null;
  }
  if (!booking || !guestTokenMatches(booking, token)) return null;
  return { booking, token };
}

function loadProducerBooking(req: Request): { booking: GardssalgBooking; token: string } | null {
  const token = String(req.params.respondToken || "");
  if (!token) return null;
  let booking: GardssalgBooking | null = null;
  try {
    booking = getBookingByRespondToken(token);
  } catch {
    booking = null;
  }
  return booking ? { booking, token } : null;
}

export function createGardssalgCancelRouter(page: PageShell): Router {
  const router = Router();
  const GUEST_PATH = "/kategori/gardssalg/status/:bookingRef/:guestToken/avlys";
  const PRODUCER_PATH = "/kategori/gardssalg/svar/:respondToken/avlys";

  router.get(GUEST_PATH, (req: Request, res: Response, next: NextFunction) => {
    if (!gardssalgCancelEnabled()) return next();
    const found = loadGuestBooking(req);
    if (!found) return next();
    const { booking, token } = found;
    const statusUrl = guestStatusPath(booking, token);
    const mode = guestCancelMode(booking);
    if (!mode) {
      res.redirect(303, statusUrl);
      return;
    }
    const pending = mode === "withdraw";
    const heading = cancelText(pending ? "cancel.guest.headingPending" : "cancel.guest.heading");
    const intro = fillOa1(cancelText(pending ? "cancel.guest.introPending" : "cancel.guest.intro"), { produsent: producerName(booking) });
    const inner = `    <h1>${esc(heading)}</h1>
    <div class="ref">${esc(booking.booking_ref)}</div>
    <p class="status-line">${esc(intro)}</p>
    <form method="POST" action="${esc(statusUrl)}/avlys" class="suggest-box">
      <label for="cancel_reason">${esc(cancelText("cancel.reasonLabel"))}</label>
      <textarea id="cancel_reason" name="reason" rows="3" maxlength="${CANCEL_REASON_MAX}" style="${TEXTAREA_STYLE}"></textarea>
      <button type="submit" class="act-btn act-primary">${esc(cancelText(pending ? "cancel.guest.submitPending" : "cancel.guest.submit"))}</button>
    </form>
    <a class="act-btn act-secondary" style="${BACK_LINK_STYLE}" href="${esc(statusUrl)}">${esc(cancelText("cancel.back"))}</a>`;
    sendPage(res, page, `${heading} — ${booking.booking_ref}`, inner);
  });

  router.post(GUEST_PATH, express.urlencoded({ extended: false }), (req: Request, res: Response, next: NextFunction) => {
    if (!gardssalgCancelEnabled()) return next();
    const found = loadGuestBooking(req);
    if (!found) return next();
    const { booking, token } = found;
    const statusUrl = guestStatusPath(booking, token);
    if (refuseCrossSite(req, res, page, statusUrl)) return;
    const outcome = guestCancel(booking, ((req.body || {}) as Record<string, unknown>).reason);
    if (!outcome.ok) {
      // Already cancelled, answered, expired or past: nothing written, no e-mail.
      res.redirect(303, statusUrl);
      return;
    }
    sendGuestCancelToProducer(outcome.booking, outcome.mode).catch((e) =>
      console.error("[booking-cancel] producer cancel notice failed", outcome.booking.booking_ref, e),
    );
    res.redirect(303, `${statusUrl}?done=avlyst`);
  });

  router.get(PRODUCER_PATH, (req: Request, res: Response, next: NextFunction) => {
    if (!gardssalgCancelEnabled()) return next();
    const found = loadProducerBooking(req);
    if (!found) return next();
    const { booking, token } = found;
    const backTo = svarPath(token);
    if (!producerMayCancel(booking)) {
      res.redirect(303, backTo);
      return;
    }
    const heading = fillOa1(cancelText("cancel.producer.heading"), { tid: slotWords(booking) });
    const missing = String(req.query.error || "") === "grunn"
      ? `\n    <div class="bekreft-banner warn" role="alert">${esc(cancelText("cancel.producer.reasonMissing"))}</div>`
      : "";
    const inner = `    <h1>${esc(heading)}</h1>
    <div class="ref">${esc(booking.booking_ref)}</div>${missing}
    <p class="status-line">${esc(cancelText("cancel.producer.intro"))}</p>
    <form method="POST" action="${esc(backTo)}/avlys" class="suggest-box">
      <label for="cancel_reason">${esc(cancelText("cancel.producer.reasonLabel"))}</label>
      <textarea id="cancel_reason" name="reason" rows="3" maxlength="${CANCEL_REASON_MAX}" required style="${TEXTAREA_STYLE}"></textarea>
      <button type="submit" class="act-btn act-primary">${esc(cancelText("cancel.producer.submit"))}</button>
    </form>
    <a class="act-btn act-secondary" style="${BACK_LINK_STYLE}" href="${esc(backTo)}">${esc(cancelText("cancel.back"))}</a>`;
    sendPage(res, page, `${cancelText("cancel.producer.button")} — ${booking.booking_ref}`, inner);
  });

  router.post(PRODUCER_PATH, express.urlencoded({ extended: false }), (req: Request, res: Response, next: NextFunction) => {
    if (!gardssalgCancelEnabled()) return next();
    const found = loadProducerBooking(req);
    if (!found) return next();
    const { booking, token } = found;
    const backTo = svarPath(token);
    if (refuseCrossSite(req, res, page, backTo)) return;
    const outcome = producerCancel(booking, ((req.body || {}) as Record<string, unknown>).reason);
    if (!outcome.ok) {
      res.redirect(303, outcome.reason === "reason_missing" ? `${backTo}/avlys?error=grunn` : backTo);
      return;
    }
    sendProducerCancelToGuest(outcome.booking).catch((e) =>
      console.error("[booking-cancel] guest cancel notice failed", outcome.booking.booking_ref, e),
    );
    res.redirect(303, `${backTo}?done=avlyst`);
  });

  return router;
}
