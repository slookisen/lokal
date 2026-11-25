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
// renderGardssalgMineBesok() itself is not wired into a page; the dashboard
// page (O2-2, below) reuses its rules with OA-3 texts and its own action
// route. Copy never names the other platform.

import { escapeHtml } from "../routes/owner-portal";
import {
  osloDatetimeLocalToUtcIso,
  previsitOpen,
  respondTokenState,
  visitTimeReached,
  type GardssalgBooking,
} from "../services/booking-store";
import { formatSlotOslo } from "../services/gardssalg-booking-resolve";
import { GARDSSALG_DASHBOARD_TEXTS } from "../owner-ui/gardssalg-dashboard";
import { ATTENDANCE_STATUS_WORD } from "../services/gardssalg-attendance-guard";

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
<div><strong>Gjest:</strong> ${booking.guest_name ? escapeHtml(String(booking.guest_name)) : "slettet"}</div>
<div><strong>E-post:</strong> ${booking.guest_email ? escapeHtml(String(booking.guest_email)) : "slettet"}</div>
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

// ─── O2-1: the «Mine besøk» tab before it is wired (empty state) ────────────
// dev-request 2026-11-12-opplevagent-o2-eierdashbord-for-besok, slice O2-1.
// The tab exists in the dashboard shell, but the list and its actions come in
// O2-2. Until then the tab shows a neutral empty state from tekstpakke OA-3:
//   "off"      «Ta imot besøk» is off               → empty.visitsOff
//   "none"     on, and the producer has no request   → empty.visits
//   "pending"  on, and requests exist (or unknown)   → no «ingen forespørsler»
//              line (it would be untrue); only the help line. The requests
//              are in the owner's e-mail until O2-2.
export type MineBesokEmptyState = "off" | "none" | "pending";

export function renderGardssalgMineBesokEmpty(state: MineBesokEmptyState): string {
  const T = GARDSSALG_DASHBOARD_TEXTS;
  const line = state === "off" ? T["empty.visitsOff"] : state === "none" ? T["empty.visits"] : null;
  return `<div class="gc-card" data-gardssalg-empty="besok" data-state="${state}">
    <h1>${escapeHtml(T["tab.visits"])}</h1>
    ${line ? `<p>${escapeHtml(line)}</p>` : ""}
  </div>`;
}

// ─── O2-2: «Mine besøk» as a page in the owner dashboard ─────────────────────
// dev-request 2026-11-12-opplevagent-o2-eierdashbord-for-besok, slice O2-2.
// The same visibility rules as above (mineBesokActions — the predicates the
// e-mail answer routes enforce), rendered with tekstpakke OA-3 part 1.2 and
// posting to the dashboard's own action route (routes/gardssalg-owner-
// features.ts, POST …/besok/handling) instead of the e-mailed token links.
// Every action is a plain <form method="post">; «Foreslå nytt tidspunkt» and
// «Avslå» open with <details> (no JavaScript). There is no «Avlys besøket»
// here: cancelling belongs to slice O1-5, which is not in this slice.
// Content rules for drink producers: only the visit — time, party size, the
// guest's own name/contact/comment and the status. No product, brand, strength
// or price.

/** Tekstpakke OA-3 part 1.2 («Mine besøk»), verbatim. The cancel keys are left out (O1-5). */
export const GARDSSALG_VISITS_TEXTS = {
  "visits.section.waiting": "Venter på svar fra deg",
  "visits.section.upcoming": "Kommende besøk",
  "visits.section.past": "Tidligere",
  "visits.deadline": "Svarfrist: {frist}",
  "visits.guestLine": "{gjest}, {antall} personer",
  "visits.noteLabel": "Kommentar fra gjesten",
  "visits.status.pending": "Venter på svar",
  "visits.status.confirmed": "Bekreftet",
  "visits.status.suggested": "Du har foreslått nytt tidspunkt",
  "visits.status.declined": "Avslått",
  "visits.status.expired": "Utløpt",
  "visits.status.attended": "Møtte",
  "visits.status.noShow": "Møtte ikke",
  "visits.action.confirm": "Bekreft",
  "visits.action.suggest": "Foreslå nytt tidspunkt",
  "visits.action.decline": "Avslå",
  "visits.action.attended": "Møtte",
  "visits.action.noShow": "Møtte ikke",
  "visits.confirm.done": "Besøket er bekreftet. Gjesten har fått e-post.",
  "visits.suggest.label": "Nytt tidspunkt",
  "visits.suggest.submit": "Send forslaget",
  "visits.suggest.done": "Forslaget er sendt. Gjesten har 48 timer på å svare.",
  "visits.decline.confirm": "Vil du avslå forespørselen? Gjesten får e-post med en gang.",
  "visits.decline.submit": "Avslå forespørselen",
  "visits.decline.done": "Forespørselen er avslått. Gjesten har fått e-post.",
  "visits.attended.done": "Oppmøtet er registrert.",
  "visits.wrongState": "Dette går ikke, fordi forespørselen er {status}.",
  "visits.expiryNote": "Svarer du ikke innen fristen, utløper forespørselen, og gjesten får beskjed.",
} as const;

/**
 * Texts this page needs that are not in OA-3 part 1.2. Each one is either
 * reused from wording already approved or live elsewhere (source noted), or
 * marked NEW — the NEW ones go to OA-3 under «Tillegg fra skive O2-2» for
 * Daniel's approval before the flag is turned on.
 */
export const O2_2_EXTRA_TEXTS = {
  /** OA-1 4.1/4.2 «Besøket er avlyst» (cancel.*.done.heading) — status of a cancelled row. */
  "visits.status.cancelled": "Besøket er avlyst",
  /** NEW — singular of visits.guestLine («1 personer» is wrong). */
  "visits.guestLine.one": "{gjest}, 1 person",
  /** The existing svar page («ugyldig_tid»), live wording. */
  "visits.suggest.invalid": "Ugyldig tidspunkt — velg et tidspunkt frem i tid.",
  /** The existing bekreft page («too_early»), live wording. */
  "visits.attended.tooEarly": "Oppmøte kan først registreres etter besøkstidspunktet.",
  /** The existing «slettet» for a guest whose contact data the sweep removed. */
  "visits.guestDeleted": "slettet",
} as const;

/**
 * {status} in visits.wrongState («… fordi forespørselen er {status}.»).
 * avslått / utløpt / ikke bekreftet ennå: OA-1 (ATTENDANCE_STATUS_WORD);
 * bekreftet: OA-3 visits.status.confirmed; avlyst: OA-1 «Besøket er avlyst».
 * suggested and attended/noShow are NEW (Tillegg fra skive O2-2).
 */
export const MINE_BESOK_STATUS_WORD: Record<MineBesokPageStatus, string> = {
  pending: ATTENDANCE_STATUS_WORD.pending,
  confirmed: "bekreftet",
  suggested: "sendt til gjesten med forslag om nytt tidspunkt",
  declined: ATTENDANCE_STATUS_WORD.declined,
  expired: ATTENDANCE_STATUS_WORD.expired,
  cancelled: "avlyst",
  attended: "avsluttet",
  noShow: "avsluttet",
};

export type MineBesokPageStatus =
  | "pending" | "confirmed" | "suggested" | "declined" | "expired" | "cancelled" | "attended" | "noShow";

/** The owner-facing status (OA-3 visits.status.*) of a row at `now`. */
export function mineBesokPageStatus(booking: GardssalgBooking, now: Date): MineBesokPageStatus {
  if (booking.status === "cancelled") return "cancelled";
  if (booking.status === "confirmed_attended") return "attended";
  if (booking.status === "no_show") return "noShow";
  if (!inAnswerLoop(booking)) return "confirmed"; // legacy row: the attendance guard treats it as confirmed
  switch (booking.pre_status) {
    case "awaiting_provider":
      return respondTokenState(booking, now) === "ok" ? "pending" : "expired";
    case "time_suggested":
      return respondTokenState(booking, now) === "ok" ? "suggested" : "expired";
    case "provider_confirmed":
      return "confirmed";
    case "provider_declined":
      return "declined";
    default:
      return "expired";
  }
}

const PAGE_STATUS_TEXT: Record<MineBesokPageStatus, string> = {
  pending: GARDSSALG_VISITS_TEXTS["visits.status.pending"],
  confirmed: GARDSSALG_VISITS_TEXTS["visits.status.confirmed"],
  suggested: GARDSSALG_VISITS_TEXTS["visits.status.suggested"],
  declined: GARDSSALG_VISITS_TEXTS["visits.status.declined"],
  expired: GARDSSALG_VISITS_TEXTS["visits.status.expired"],
  cancelled: O2_2_EXTRA_TEXTS["visits.status.cancelled"],
  attended: GARDSSALG_VISITS_TEXTS["visits.status.attended"],
  noShow: GARDSSALG_VISITS_TEXTS["visits.status.noShow"],
};

export function mineBesokPageStatusText(booking: GardssalgBooking, now: Date): string {
  return PAGE_STATUS_TEXT[mineBesokPageStatus(booking, now)];
}

/** visits.wrongState filled with this row's status (plain text). */
export function mineBesokWrongStateText(booking: GardssalgBooking, now: Date): string {
  return GARDSSALG_VISITS_TEXTS["visits.wrongState"].replace("{status}", MINE_BESOK_STATUS_WORD[mineBesokPageStatus(booking, now)]);
}

/**
 * The three lists: waiting (the owner can still confirm — soonest deadline
 * first), upcoming (a confirmed or suggested visit still ahead — soonest
 * first) and earlier (everything else — newest visit first, unparseable last).
 */
export function groupMineBesok(
  bookings: readonly GardssalgBooking[],
  now: Date,
): { waiting: GardssalgBooking[]; upcoming: GardssalgBooking[]; past: GardssalgBooking[] } {
  const waiting: GardssalgBooking[] = [];
  const rest: GardssalgBooking[] = [];
  for (const b of bookings) {
    if (mineBesokActions(b, now).includes("bekreft")) waiting.push(b);
    else rest.push(b);
  }
  const { kommende, tidligere } = splitMineBesok(rest, now);
  const upcoming: GardssalgBooking[] = [];
  const pastAhead: GardssalgBooking[] = [];
  for (const b of kommende) {
    const s = mineBesokPageStatus(b, now);
    if (s === "confirmed" || s === "suggested") upcoming.push(b);
    else pastAhead.push(b);
  }
  const deadline = (b: GardssalgBooking) => {
    const t = b.respond_token_expires_at ? new Date(b.respond_token_expires_at).getTime() : NaN;
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  };
  waiting.sort((a, b) => deadline(a) - deadline(b) || visitTimeMs(a) - visitTimeMs(b) || (a.booking_ref < b.booking_ref ? -1 : 1));
  // splitMineBesok already orders `tidligere` newest first; the declined /
  // expired / cancelled rows whose time is still ahead come before them.
  const past = [...pastAhead.reverse(), ...tidligere];
  return { waiting, upcoming, past };
}

/** The element id of a booking's card (also the PRG anchor). */
export function mineBesokCardId(bookingRef: string): string {
  return `besok-${String(bookingRef).replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export interface MineBesokPageOptions {
  /** Where every action form posts (POST …/besok/handling). */
  actionPath: string;
  /** A message after an action (PRG), shown above the lists. */
  notice?: { ok: boolean; text: string } | null;
}

function hiddenFields(booking: GardssalgBooking, action: MineBesokAction): string {
  return `<input type="hidden" name="ref" value="${escapeHtml(booking.booking_ref)}"><input type="hidden" name="action" value="${action}">`;
}

function pageButtonForm(path: string, booking: GardssalgBooking, action: MineBesokAction, label: string, cls: string): string {
  return `<form method="post" action="${escapeHtml(path)}" class="besok-form">${hiddenFields(booking, action)}<button type="submit" class="besok-btn ${cls}" data-action="${action}">${escapeHtml(label)}</button></form>`;
}

function pageActionsHtml(booking: GardssalgBooking, now: Date, path: string): string {
  const T = GARDSSALG_VISITS_TEXTS;
  const acts = mineBesokActions(booking, now);
  if (acts.length === 0) return "";
  const parts: string[] = [];
  if (acts.includes("bekreft")) parts.push(pageButtonForm(path, booking, "bekreft", T["visits.action.confirm"], "besok-btn-primary"));
  if (acts.includes("foresla")) {
    const id = `${mineBesokCardId(booking.booking_ref)}-ny-tid`;
    parts.push(
      `<details class="besok-more"><summary class="besok-btn besok-btn-secondary" data-action="foresla">${escapeHtml(T["visits.action.suggest"])}</summary>` +
        `<form method="post" action="${escapeHtml(path)}" class="besok-form besok-foresla">${hiddenFields(booking, "foresla")}` +
        `<label for="${id}">${escapeHtml(T["visits.suggest.label"])}</label>` +
        `<input id="${id}" name="suggested_slot" type="datetime-local" required>` +
        `<button type="submit" class="besok-btn besok-btn-primary">${escapeHtml(T["visits.suggest.submit"])}</button>` +
        `</form></details>`,
    );
  }
  if (acts.includes("avsla")) {
    parts.push(
      `<details class="besok-more"><summary class="besok-btn besok-btn-secondary" data-action="avsla">${escapeHtml(T["visits.action.decline"])}</summary>` +
        `<p>${escapeHtml(T["visits.decline.confirm"])}</p>` +
        `<form method="post" action="${escapeHtml(path)}" class="besok-form">${hiddenFields(booking, "avsla")}` +
        `<button type="submit" class="besok-btn besok-btn-primary">${escapeHtml(T["visits.decline.submit"])}</button>` +
        `</form></details>`,
    );
  }
  if (acts.includes("attended")) parts.push(pageButtonForm(path, booking, "attended", T["visits.action.attended"], "besok-btn-primary"));
  if (acts.includes("no_show")) parts.push(pageButtonForm(path, booking, "no_show", T["visits.action.noShow"], "besok-btn-secondary"));
  return `<div class="besok-actions">${parts.join("")}</div>`;
}

function guestLine(booking: GardssalgBooking): string {
  const name = booking.guest_name ? String(booking.guest_name) : O2_2_EXTRA_TEXTS["visits.guestDeleted"];
  const n = booking.party_size;
  const tpl = n === 1 ? O2_2_EXTRA_TEXTS["visits.guestLine.one"] : GARDSSALG_VISITS_TEXTS["visits.guestLine"];
  // Function replacer: a name holding `$&` / `$'` is shown literally (O2-3).
  return escapeHtml(tpl.replace("{antall}", String(n))).replace("{gjest}", () => escapeHtml(name));
}

function pageCardHtml(booking: GardssalgBooking, now: Date, path: string, withDeadline: boolean): string {
  const T = GARDSSALG_VISITS_TEXTS;
  const status = mineBesokPageStatus(booking, now);
  const lines: string[] = [];
  if (status === "suggested" && booking.suggested_slot_at) {
    lines.push(`<p>${escapeHtml(T["visits.suggest.label"])}: ${escapeHtml(slotText(booking.suggested_slot_at))}</p>`);
  }
  if (withDeadline && booking.respond_token_expires_at) {
    lines.push(`<p class="besok-frist">${escapeHtml(T["visits.deadline"].replace("{frist}", slotText(booking.respond_token_expires_at)))}</p>`);
  }
  lines.push(`<p class="besok-gjest">${guestLine(booking)}</p>`);
  const contact: string[] = [];
  if (booking.guest_email) contact.push(`<a href="mailto:${escapeHtml(String(booking.guest_email))}">${escapeHtml(String(booking.guest_email))}</a>`);
  if (booking.guest_phone) contact.push(`<a href="tel:${escapeHtml(booking.guest_phone.replace(/[^0-9+]/g, ""))}">${escapeHtml(booking.guest_phone)}</a>`);
  if (contact.length) lines.push(`<p class="besok-kontakt">${contact.join(" · ")}</p>`);
  if (booking.notes) lines.push(`<p class="besok-kommentar">${escapeHtml(T["visits.noteLabel"])}: ${escapeHtml(booking.notes)}</p>`);
  return `<li class="besok-kort" id="${mineBesokCardId(booking.booking_ref)}" data-booking-ref="${escapeHtml(booking.booking_ref)}" data-status="${status}">
<p class="besok-tid"><strong>${escapeHtml(slotText(booking.slot_at))}</strong></p>
<p class="besok-status"><strong>${escapeHtml(PAGE_STATUS_TEXT[status])}</strong></p>
${lines.join("\n")}
${pageActionsHtml(booking, now, path)}
</li>`;
}

function pageSectionHtml(id: string, title: string, list: GardssalgBooking[], now: Date, path: string, lead = ""): string {
  if (list.length === 0) return "";
  const waiting = id === "besok-venter";
  return `<section class="besok-seksjon" id="${id}" aria-labelledby="${id}-tittel">
<h2 id="${id}-tittel">${escapeHtml(title)}</h2>
${lead}<ul class="besok-liste">
${list.map((b) => pageCardHtml(b, now, path, waiting)).join("\n")}
</ul>
</section>`;
}

/** Minimal styles for the page (light, with a dark variant like «Mine valg»). */
export const MINE_BESOK_PAGE_CSS = `
  .mine-besok-side .besok-liste { list-style: none; padding: 0; margin: 0; }
  .mine-besok-side .besok-kort { border: 1px solid #e5e2d6; border-radius: 10px; padding: 14px; margin: 0 0 12px; background: #fff; }
  .mine-besok-side .besok-kort p { margin: 4px 0; overflow-wrap: anywhere; }
  .mine-besok-side .besok-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: flex-start; }
  .mine-besok-side .besok-form { margin: 0; }
  .mine-besok-side .besok-more { flex-basis: 100%; }
  .mine-besok-side .besok-more > summary { list-style: none; display: inline-block; }
  .mine-besok-side .besok-more > summary::-webkit-details-marker { display: none; }
  .mine-besok-side .besok-more[open] > summary { margin-bottom: 8px; }
  .mine-besok-side .besok-foresla label { display: block; font-weight: 600; margin-bottom: 4px; }
  .mine-besok-side .besok-foresla input { display: block; width: 100%; max-width: 320px; padding: 10px; margin-bottom: 8px; font-size: 1rem; box-sizing: border-box; }
  .mine-besok-side .besok-btn { cursor: pointer; padding: 10px 16px; border-radius: 8px; font-size: 1rem; font-weight: 600; min-height: 44px; }
  .mine-besok-side .besok-btn-primary { background: #0f5a50; color: #fff; border: 1px solid #0f5a50; }
  .mine-besok-side .besok-btn-secondary { background: #fff; color: #0f5a50; border: 1px solid #0f5a50; }
  .mine-besok-side .besok-melding { border-radius: 8px; padding: 10px 12px; margin: 0 0 14px; }
  .mine-besok-side .besok-melding-ok { background: #e8f4ec; border: 1px solid #bcd9c5; color: #1d5a30; }
  .mine-besok-side .besok-melding-feil { background: #fdf3e7; border: 1px solid #f0d4ae; color: #7a5218; }
`;

/**
 * «Mine besøk» for the dashboard page: the notice, then «Venter på svar fra
 * deg», «Kommende besøk» and «Tidligere» (an empty list is left out; the
 * route shows the O2-1 empty state when there is no request at all). Pure.
 */
export function renderGardssalgMineBesokPage(
  bookings: readonly GardssalgBooking[],
  now: Date,
  opts: MineBesokPageOptions,
): string {
  const T = GARDSSALG_VISITS_TEXTS;
  const { waiting, upcoming, past } = groupMineBesok(bookings, now);
  const notice = opts.notice
    ? `<p class="besok-melding ${opts.notice.ok ? "besok-melding-ok" : "besok-melding-feil"}" role="${opts.notice.ok ? "status" : "alert"}">${escapeHtml(opts.notice.text)}</p>\n`
    : "";
  return `<div class="gc-card mine-besok-side" data-owner-tab="mine-besok">
<h1>${escapeHtml(GARDSSALG_DASHBOARD_TEXTS["tab.visits"])}</h1>
${notice}${pageSectionHtml("besok-venter", T["visits.section.waiting"], waiting, now, opts.actionPath, `<p class="besok-intro">${escapeHtml(T["visits.expiryNote"])}</p>\n`)}
${pageSectionHtml("besok-kommende", T["visits.section.upcoming"], upcoming, now, opts.actionPath)}
${pageSectionHtml("besok-tidligere", T["visits.section.past"], past, now, opts.actionPath)}
</div><style>${MINE_BESOK_PAGE_CSS}</style>`;
}
