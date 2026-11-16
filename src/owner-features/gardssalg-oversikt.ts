// ─── O2-3: «Oversikt» in the gårdssalg owner dashboard ──────────────────────
// dev-request 2026-11-12-opplevagent-o2-eierdashbord-for-besok, slice O2-3.
//
// A card at the top of the portal (the «Oversikt» tab) while the dashboard
// is on for the owner (routes/gardssalg-claim.ts, GET …/portal):
//   1. how many requests wait for the owner's answer, and the nearest answer
//      deadline — the «Venter på svar fra deg» rows of «Mine besøk»
//      (groupMineBesok: the owner can still press «Bekreft»);
//   2. upcoming confirmed visits — the «Kommende besøk» rows of «Mine besøk»
//      whose status is «Bekreftet» (date/time, party size, first name only);
//   3. whether the profile takes requests right now, and if not what is
//      missing. «Tar imot» is the guest booking gate itself, no new rule:
//      isBookingPaused(booking_live, catalog_hidden, is_test_provider) and
//      the owner's booking.pause (gardssalgBookingPausedByOwner) — the same
//      checks POST /api/opplevelser/book, the SSR form and book_gardssalg
//      make — plus hasBookingRequestEmail(epost), the rule the booking switch
//      and the admin lever require (a request must have somewhere to go).
//      The «Dette mangler» lines: booking_live ≠ 1 («Ta imot besøk» er av),
//      no request address (hasBookingRequestEmail), no opening_hours_text
//      (the admin readiness report's has_opening_hours). Opening hours never
//      decide «tar imot»; they are only listed when the profile is not
//      taking requests.
//
// Texts: tekstpakke OA-3 part 1.3, verbatim. Content rules for drink
// producers: only the visit (time, party size, the guest's first name) —
// no product, brand, strength, tasting or price. Every dynamic value is
// HTML-escaped; templates are filled with split/join (not String.replace
// patterns) so a value holding `$&` is shown literally.

import { escapeHtml } from "../routes/owner-portal";
import { type GardssalgBooking } from "../services/booking-store";
import { formatSlotOslo } from "../services/gardssalg-booking-resolve";
import { GARDSSALG_DASHBOARD_TEXTS, gardssalgDashboardPath } from "../owner-ui/gardssalg-dashboard";
import { GARDSSALG_VISITS_TEXTS, O2_2_EXTRA_TEXTS, groupMineBesok, mineBesokPageStatus } from "./gardssalg-mine-besok";

/** Tekstpakke OA-3 part 1.3 («Oversikt»), verbatim. */
export const GARDSSALG_OVERVIEW_TEXTS = {
  "overview.waiting.one": "1 forespørsel venter på svar fra deg",
  "overview.waiting.many": "{n} forespørsler venter på svar fra deg",
  "overview.waiting.none": "Ingen forespørsler venter på svar.",
  "overview.nextDeadline": "Nærmeste svarfrist: {frist}",
  "overview.upcoming.heading": "Kommende besøk",
  "overview.upcoming.none": "Du har ingen bekreftede besøk framover.",
  "overview.ready.yes": "Profilen din tar imot forespørsler.",
  "overview.ready.no": "Profilen din tar ikke imot forespørsler ennå.",
  "overview.missing.lead": "Dette mangler:",
  "overview.missing.switch": "«Ta imot besøk» er av.",
  "overview.missing.address": "Adressen forespørslene skal sendes til, er ikke bekreftet.",
  "overview.missing.hours": "Åpningstider er ikke lagt inn.",
  "overview.goToChoices": "Gå til «Mine valg»",
} as const;

/** How many upcoming confirmed visits the card lists (the rest are in «Mine besøk»). */
export const OVERVIEW_UPCOMING_LIMIT = 5;

export type OverviewMissing = "switch" | "address" | "hours";

/** Readiness, computed by the route from the existing gates (see the module doc). */
export interface OverviewReadiness {
  ready: boolean;
  /** Only filled when not ready; in the order switch, address, hours. */
  missing: OverviewMissing[];
}

/** The raw facts readiness is computed from (one experience_providers row + the gate results). */
export interface OverviewReadinessFacts {
  /** experience_providers.booking_live === 1 («Ta imot besøk», booking.enabled). */
  switchOn: boolean;
  /** !isBookingPaused(booking_live, catalog_hidden, is_test_provider). */
  bookingGateOpen: boolean;
  /** gardssalgBookingPausedByOwner(id) — the owner's booking.pause. */
  ownerPaused: boolean;
  /** hasBookingRequestEmail(epost). */
  hasRequestAddress: boolean;
  /** opening_hours_text is non-blank. */
  hasOpeningHours: boolean;
}

/** «Tar imot» and «Dette mangler» from the facts. Pure. */
export function overviewReadiness(f: OverviewReadinessFacts): OverviewReadiness {
  const ready = f.switchOn && f.bookingGateOpen && !f.ownerPaused && f.hasRequestAddress;
  if (ready) return { ready, missing: [] };
  const missing: OverviewMissing[] = [];
  if (!f.switchOn) missing.push("switch");
  if (!f.hasRequestAddress) missing.push("address");
  if (!f.hasOpeningHours) missing.push("hours");
  return { ready, missing };
}

export interface OverviewModel {
  waitingCount: number;
  /** respond_token_expires_at of the soonest waiting request, or null. */
  nextDeadline: string | null;
  /** Every upcoming confirmed visit, soonest first (the card shows the first OVERVIEW_UPCOMING_LIMIT). */
  upcoming: GardssalgBooking[];
}

/** The numbers, from the same grouping «Mine besøk» shows. Pure. */
export function overviewModel(bookings: readonly GardssalgBooking[], now: Date): OverviewModel {
  const { waiting, upcoming } = groupMineBesok(bookings, now);
  // groupMineBesok sorts `waiting` by deadline (soonest first, missing last).
  const nextDeadline = waiting.find((b) => !!b.respond_token_expires_at)?.respond_token_expires_at ?? null;
  return {
    waitingCount: waiting.length,
    nextDeadline,
    upcoming: upcoming.filter((b) => mineBesokPageStatus(b, now) === "confirmed"),
  };
}

/** Fill `{key}` placeholders literally (split/join, not String.replace: `$&` in a value stays `$&`). */
function fill(tpl: string, key: string, value: string): string {
  return tpl.split(`{${key}}`).join(value);
}

function slotText(slot: string | null): string {
  if (!slot) return "";
  return formatSlotOslo(slot) || slot;
}

/** The guest's first name only (minimal personal data on the overview). */
export function overviewFirstName(guestName: string | null | undefined): string | null {
  const first = String(guestName ?? "").trim().split(/\s+/)[0] ?? "";
  return first === "" ? null : first;
}

function upcomingLine(b: GardssalgBooking): string {
  const name = overviewFirstName(b.guest_name) ?? O2_2_EXTRA_TEXTS["visits.guestDeleted"];
  const n = b.party_size;
  const tpl = n === 1 ? O2_2_EXTRA_TEXTS["visits.guestLine.one"] : GARDSSALG_VISITS_TEXTS["visits.guestLine"];
  const line = fill(fill(tpl, "antall", String(n)), "gjest", name);
  return `<li class="gs-ov-besok" data-booking-ref="${escapeHtml(b.booking_ref)}"><strong>${escapeHtml(slotText(b.slot_at))}</strong> · ${escapeHtml(line)}</li>`;
}

const MISSING_TEXT: Record<OverviewMissing, keyof typeof GARDSSALG_OVERVIEW_TEXTS> = {
  switch: "overview.missing.switch",
  address: "overview.missing.address",
  hours: "overview.missing.hours",
};

/** The «Oversikt» card as an HTML fragment (no styles of its own beyond the portal's gc-card). Pure. */
export function renderGardssalgOversikt(slug: string, model: OverviewModel, readiness: OverviewReadiness): string {
  const T = GARDSSALG_OVERVIEW_TEXTS;
  const n = model.waitingCount;
  const waitingText = n === 0 ? T["overview.waiting.none"] : n === 1 ? T["overview.waiting.one"] : fill(T["overview.waiting.many"], "n", String(n));
  const deadline = n > 0 && model.nextDeadline
    ? `\n  <p class="gs-ov-frist">${escapeHtml(fill(T["overview.nextDeadline"], "frist", slotText(model.nextDeadline)))}</p>`
    : "";
  const shown = model.upcoming.slice(0, OVERVIEW_UPCOMING_LIMIT);
  const upcoming = shown.length
    ? `<ul class="gs-ov-liste">\n${shown.map(upcomingLine).join("\n")}\n</ul>`
    : `<p>${escapeHtml(T["overview.upcoming.none"])}</p>`;
  const missing = !readiness.ready && readiness.missing.length
    ? `\n  <p>${escapeHtml(T["overview.missing.lead"])}</p>\n  <ul class="gs-ov-mangler">\n${readiness.missing.map((m) => `    <li data-missing="${m}">${escapeHtml(T[MISSING_TEXT[m]])}</li>`).join("\n")}\n  </ul>`
    : "";
  return `<section class="gc-card gs-oversikt" data-gardssalg-oversikt="1" aria-labelledby="gs-ov-tittel">
  <h2 id="gs-ov-tittel">${escapeHtml(GARDSSALG_DASHBOARD_TEXTS["tab.overview"])}</h2>
  <p class="gs-ov-venter" data-waiting-count="${n}"><strong>${escapeHtml(waitingText)}</strong></p>${deadline}
  <h3>${escapeHtml(T["overview.upcoming.heading"])}</h3>
  <div data-upcoming-count="${model.upcoming.length}">${upcoming}</div>
  <p class="gs-ov-klar" data-ready="${readiness.ready ? "1" : "0"}"><strong>${escapeHtml(readiness.ready ? T["overview.ready.yes"] : T["overview.ready.no"])}</strong></p>${missing}
  <p><a href="${escapeHtml(gardssalgDashboardPath(slug, "valg"))}">${escapeHtml(T["overview.goToChoices"])}</a></p>
</section>
      `;
}
