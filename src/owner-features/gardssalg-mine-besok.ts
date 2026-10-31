// dev-request 2026-10-22-opplevagent-mine-valg-gardssalg, slice O3:
// «Mine besøk» for the gårdssalg owner portal — a PURE render function.
//
// Input: the provider's own booking rows (GardssalgBooking, booking-store.ts)
// plus `now`. Output: an HTML fragment with two sections, «Kommende» and
// «Tidligere», one card per request: date/time, party size, the guest's
// name/e-mail/phone/comment exactly as the producer notification e-mail shows
// them, the status in plain Norwegian, and the actions valid right now.
//
// No new transitions, routes, tokens or columns. Every action is a POST form
// to the SAME endpoint the e-mail links open, with the SAME form fields:
//   - «Bekreft» / «Foreslå annen tid» / «Avslå» → POST
//     /kategori/gardssalg/svar/:respond_token, action=bekreft|foresla|avsla
//     (+ suggested_slot for foresla) — experiences-seo.ts, svar route;
//     link built in sendProducerNotification (booking-store.ts).
//   - «Møtte» / «Ikke møtt» → POST /kategori/gardssalg/bekreft/:confirm_token,
//     action=attended|no_show — experiences-seo.ts, bekreft route.
// Both tokens are stored on the booking row, so nothing is minted here.
// Visibility uses the same predicates the routes enforce (previsitOpen,
// respondTokenState, visitTimeReached), so a button is only shown when the
// route would accept the press. A visit is never confirmed automatically:
// every state change is an explicit button press by the owner.
//
// Not wired into the live portal yet (it goes into the shared dashboard
// shell later). Copy never names the other platform.

import { escapeHtml } from "../routes/owner-portal";
import {
  osloDatetimeLocalToUtcIso,
  previsitOpen,
  respondTokenState,
  visitTimeReached,
  type GardssalgBooking,
} from "../services/booking-store";
import { formatSlotOslo } from "../services/gardssalg-booking-resolve";

export type MineBesokAction = "bekreft" | "foresla" | "avsla" | "attended" | "no_show";

/** Same path the producer e-mail's «Åpne svarsiden» link points at. */
export function svarActionPath(respondToken: string): string {
  return `/kategori/gardssalg/svar/${encodeURIComponent(respondToken)}`;
}

/** Same path the producer e-mail's attendance link points at. */
export function bekreftActionPath(confirmToken: string): string {
  return `/kategori/gardssalg/bekreft/${encodeURIComponent(confirmToken)}`;
}

/** The visit instant in epoch ms. Legacy rows carry a naked datetime-local
 *  string typed as Oslo wall time — converted the same way the svar page
 *  formats them. NaN when unparseable. */
export function visitTimeMs(booking: Pick<GardssalgBooking, "slot_at">): number {
  const raw = String(booking.slot_at ?? "");
  const iso = osloDatetimeLocalToUtcIso(raw) ?? raw;
  return new Date(iso).getTime();
}

/** Legacy rows (created before the answer loop) have no respond token and
 *  are outside the pre-visit flow entirely. */
function inAnswerLoop(b: GardssalgBooking): boolean {
  return !!b.respond_token;
}

/**
 * Actions valid for this booking at `now` — the subset the existing routes
 * would accept:
 *   bekreft  — svar route: previsit open, respond token ok, awaiting_provider
 *   foresla / avsla — svar route: previsit open, token ok,
 *              awaiting_provider | time_suggested
 *   attended / no_show — bekreft route: status reserved, visit time reached,
 *              and the visit was confirmed (provider_confirmed, or a legacy
 *              row with no answer loop). Never on an unanswered request.
 */
export function mineBesokActions(booking: GardssalgBooking, now: Date): MineBesokAction[] {
  const out: MineBesokAction[] = [];
  if (inAnswerLoop(booking) && previsitOpen(booking) && respondTokenState(booking, now) === "ok") {
    if (booking.pre_status === "awaiting_provider") out.push("bekreft");
    if (booking.pre_status === "awaiting_provider" || booking.pre_status === "time_suggested") {
      out.push("foresla", "avsla");
    }
  }
  const confirmed = !inAnswerLoop(booking) || booking.pre_status === "provider_confirmed";
  if (booking.status === "reserved" && confirmed && booking.confirm_token && visitTimeReached(booking, now)) {
    out.push("attended", "no_show");
  }
  return out;
}

/** The status in plain Norwegian, from the owner's point of view. */
export function mineBesokStatusText(booking: GardssalgBooking, now: Date): string {
  if (booking.status === "cancelled") return "Kansellert";
  if (booking.status === "confirmed_attended") return "Møtte";
  if (booking.status === "no_show") return "Ikke møtt";
  if (!inAnswerLoop(booking)) {
    return visitTimeReached(booking, now) ? "Oppmøte ikke registrert" : "Reservert";
  }
  switch (booking.pre_status) {
    case "awaiting_provider":
      return respondTokenState(booking, now) === "ok" ? "Venter på svaret ditt" : "Utløpt – ikke besvart i tide";
    case "time_suggested":
      return respondTokenState(booking, now) === "ok"
        ? "Du har foreslått en annen tid – venter på gjesten"
        : "Utløpt – ble ikke avklart i tide";
    case "provider_confirmed":
      return visitTimeReached(booking, now) ? "Bekreftet – oppmøte ikke registrert" : "Bekreftet";
    case "provider_declined":
      return "Avslått";
    case "expired":
      return "Utløpt – ble ikke avklart i tide";
    default:
      return "Ukjent status";
  }
}

/** Split around `now`: a visit whose time is after `now` is upcoming.
 *  Upcoming soonest first; past most recent first. Unparseable times are
 *  past (the attendance guard treats them as reached), listed last. */
export function splitMineBesok(
  bookings: readonly GardssalgBooking[],
  now: Date,
): { kommende: GardssalgBooking[]; tidligere: GardssalgBooking[] } {
  const nowMs = now.getTime();
  const tie = (a: GardssalgBooking, b: GardssalgBooking): number =>
    a.booking_ref < b.booking_ref ? -1 : a.booking_ref > b.booking_ref ? 1 : 0;
  const kommende: GardssalgBooking[] = [];
  const tidligere: GardssalgBooking[] = [];
  for (const b of bookings) {
    const t = visitTimeMs(b);
    if (Number.isFinite(t) && t > nowMs) kommende.push(b);
    else tidligere.push(b);
  }
  kommende.sort((a, b) => visitTimeMs(a) - visitTimeMs(b) || tie(a, b));
  tidligere.sort((a, b) => {
    const ta = visitTimeMs(a), tb = visitTimeMs(b);
    const fa = Number.isFinite(ta), fb = Number.isFinite(tb);
    if (fa !== fb) return fa ? -1 : 1;
    if (fa && tb !== ta) return tb - ta;
    return tie(a, b);
  });
  return { kommende, tidligere };
}

function slotText(slot: string | null): string {
  if (!slot) return "";
  return formatSlotOslo(slot) || slot;
}

function postForm(path: string, action: MineBesokAction, label: string, cls: string): string {
  return `<form method="POST" action="${escapeHtml(path)}" class="besok-form"><input type="hidden" name="action" value="${action}"><button type="submit" class="act-btn ${cls}" data-action="${action}">${label}</button></form>`;
}

function actionsHtml(booking: GardssalgBooking, now: Date): string {
  const acts = mineBesokActions(booking, now);
  if (acts.length === 0) return "";
  const parts: string[] = [];
  if (booking.respond_token) {
    const svar = svarActionPath(booking.respond_token);
    if (acts.includes("bekreft")) parts.push(postForm(svar, "bekreft", "Bekreft", "act-primary"));
    if (acts.includes("foresla")) {
      const id = `besok-ny-tid-${escapeHtml(booking.booking_ref)}`;
      parts.push(
        `<form method="POST" action="${escapeHtml(svar)}" class="besok-form besok-foresla">` +
          `<input type="hidden" name="action" value="foresla">` +
          `<label for="${id}">Foreslå annen tid (norsk tid)</label>` +
          `<input id="${id}" name="suggested_slot" type="datetime-local" required>` +
          `<button type="submit" class="act-btn act-secondary" data-action="foresla">Foreslå annen tid</button>` +
          `</form>`,
      );
    }
    if (acts.includes("avsla")) parts.push(postForm(svar, "avsla", "Avslå", "act-secondary"));
  }
  if (booking.confirm_token) {
    const bekreft = bekreftActionPath(booking.confirm_token);
    if (acts.includes("attended")) parts.push(postForm(bekreft, "attended", "Møtte", "act-primary"));
    if (acts.includes("no_show")) parts.push(postForm(bekreft, "no_show", "Ikke møtt", "act-secondary"));
  }
  return `<div class="besok-actions">${parts.join("")}</div>`;
}

function cardHtml(booking: GardssalgBooking, now: Date): string {
  const n = booking.party_size;
  const suggested =
    booking.pre_status === "time_suggested" && booking.suggested_slot_at
      ? `<div><strong>Foreslått tid:</strong> ${escapeHtml(slotText(booking.suggested_slot_at))}</div>`
      : "";
  return `<li class="besok-kort" data-booking-ref="${escapeHtml(booking.booking_ref)}">
<div class="besok-tid"><strong>${escapeHtml(slotText(booking.slot_at))}</strong></div>
<div class="besok-status">Status: <strong>${escapeHtml(mineBesokStatusText(booking, now))}</strong></div>
<div class="besok-detaljer">
${suggested}<div><strong>Antall:</strong> ${n} person${n > 1 ? "er" : ""}</div>
<div><strong>Gjest:</strong> ${escapeHtml(String(booking.guest_name ?? ""))}</div>
<div><strong>E-post:</strong> ${escapeHtml(String(booking.guest_email ?? ""))}</div>
${booking.guest_phone ? `<div><strong>Telefon:</strong> ${escapeHtml(booking.guest_phone)}</div>\n` : ""}${booking.notes ? `<div><strong>Kommentar fra gjesten:</strong> ${escapeHtml(booking.notes)}</div>\n` : ""}<div><strong>Referanse:</strong> ${escapeHtml(booking.booking_ref)}</div>
</div>
${actionsHtml(booking, now)}
</li>`;
}

function sectionHtml(id: string, title: string, list: GardssalgBooking[], empty: string, now: Date): string {
  const body = list.length
    ? `<ul class="besok-liste">\n${list.map((b) => cardHtml(b, now)).join("\n")}\n</ul>`
    : `<p class="besok-tom">${empty}</p>`;
  return `<section class="besok-seksjon" id="${id}" aria-labelledby="${id}-tittel">
<h3 id="${id}-tittel">${title}</h3>
${body}
</section>`;
}

/**
 * «Mine besøk» as an HTML fragment (no page shell, no styles of its own —
 * the dashboard shell owns those). Pure: reads only its arguments.
 */
export function renderGardssalgMineBesok(bookings: readonly GardssalgBooking[], now: Date): string {
  const { kommende, tidligere } = splitMineBesok(bookings, now);
  return `<div class="mine-besok" data-owner-tab="mine-besok">
<h2>Mine besøk</h2>
<p class="besok-intro">Du bekrefter, avslår eller foreslår ny tid for hver forespørsel. Ingen besøk blir bekreftet av seg selv.</p>
${sectionHtml("besok-kommende", "Kommende", kommende, "Ingen kommende besøk.", now)}
${sectionHtml("besok-tidligere", "Tidligere", tidligere, "Ingen tidligere besøk.", now)}
</div>`;
}
