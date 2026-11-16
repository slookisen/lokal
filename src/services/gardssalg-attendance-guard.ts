// ─── Gårdssalg: attendance only on confirmed visits, suggestion deadline,
// guest data behind the guest's token (O1-4) ────────────────────────────────
//
// A2A dev-request 2026-11-12-opplevagent-o1-trygg-aa-aapne, slice O1-4
// (audit findings R6, R7, R8). No flag: rollback is a revert.
//
//   R6 — «Møtte» / «Ikke møtt» (status confirmed_attended / no_show, and with
//        it `billable`) may only be recorded for a visit the PRODUCER HAS
//        CONFIRMED. "Confirmed" uses the same rule as «Mine besøk»
//        (owner-features/gardssalg-mine-besok.ts): pre_status
//        'provider_confirmed' (the producer pressed «Bekreft», or the guest
//        accepted the producer's suggested time), or a legacy row created
//        before the answer loop existed (respond_token IS NULL), which has no
//        pre-visit state at all. Declined, expired, awaiting_provider and
//        time_suggested rows are refused and `billable` is never touched.
//   R7 — «Foreslå nytt tidspunkt» extends the answer deadline
//        (respond_token_expires_at) to at least 48 hours after the
//        suggestion. It never shortens a later deadline.
//   R8 — the guest confirmation page and the .ics download are reachable
//        with the booking reference alone (QR on arrival, duplicate answers
//        from O1-3). Without the guest's own token (guest_status_token, the
//        same credential as the status page) they show no guest name, e-mail
//        or note.
//
// Texts: verbatim from the approved text package OA-1 §3 (A2A
// marketing-drafts/2026-11-12-opplevagent-tekstpakke-oa-1.md, approved by
// Daniel 2026-11-15). Do not reword here.

import crypto from "crypto";
import type { GardssalgBooking } from "./booking-store";

// ─── Text package OA-1 §3 (verbatim) ────────────────────────────────────────
export const OA1_ATTENDANCE_TEXTS = {
  "attendance.notConfirmed": {
    nb: "Oppmøte kan bare føres på besøk du har bekreftet. Denne forespørselen er {status}.",
  },
  "suggest.deadlineNote": {
    nb: "Gjesten får 48 timer på å svare på forslaget. Svarer ikke gjesten, utløper forespørselen.",
  },
  "page.guestDataHidden": {
    nb: "Åpne lenken i e-posten du fikk for å se detaljene.",
    en: "Open the link in the email we sent you to see the details.",
  },
} as const;

/**
 * {status} in attendance.notConfirmed, in words that fit «Denne forespørselen
 * er {status}.». Taken from wording already in use: «Avslått» / «Utløpt»
 * (status labels on the svar page) and «ikke bekreftet ennå»
 * (OA-1 receipt.lead).
 */
export const ATTENDANCE_STATUS_WORD: Record<"declined" | "expired" | "pending", string> = {
  declined: "avslått",
  expired: "utløpt",
  pending: "ikke bekreftet ennå",
};

// ─── R6: attendance only on confirmed visits ────────────────────────────────

type AttendanceRow = Pick<GardssalgBooking, "pre_status" | "respond_token">;

/**
 * True when the producer has confirmed the visit (see the header). The
 * post-visit status ('cancelled' is terminal) is checked by resolveBooking().
 */
export function visitConfirmedByProducer(booking: AttendanceRow): boolean {
  if (!booking.respond_token) return true; // legacy row: outside the answer loop
  return booking.pre_status === "provider_confirmed";
}

/**
 * null when attendance may be recorded; otherwise why not, as the {status}
 * key. Does not look at the visit time (visitTimeReached() stays the
 * separate time guard).
 */
export function attendanceRefusal(booking: AttendanceRow): keyof typeof ATTENDANCE_STATUS_WORD | null {
  if (visitConfirmedByProducer(booking)) return null;
  if (booking.pre_status === "provider_declined") return "declined";
  if (booking.pre_status === "expired") return "expired";
  return "pending";
}

/** attendance.notConfirmed filled for this booking ("" when attendance is allowed). Plain text. */
export function attendanceNotConfirmedText(booking: AttendanceRow): string {
  const why = attendanceRefusal(booking);
  if (!why) return "";
  return OA1_ATTENDANCE_TEXTS["attendance.notConfirmed"].nb.replace("{status}", ATTENDANCE_STATUS_WORD[why]);
}

/**
 * SQL fragment with the same rule as visitConfirmedByProducer(), for the
 * guarded UPDATE in resolveBooking().
 */
export const CONFIRMED_VISIT_SQL = "(respond_token IS NULL OR pre_status = 'provider_confirmed')";

// ─── R7: a suggestion gives the guest 48 hours ──────────────────────────────

export const SUGGESTION_ANSWER_HOURS = 48;

/**
 * The answer deadline after a suggestion made at `now`: 48 hours from the
 * suggestion, or the current deadline if that is later (never shortened).
 */
export function deadlineAfterSuggestion(currentIso: string | null, now: Date): string {
  const extended = now.getTime() + SUGGESTION_ANSWER_HOURS * 3600_000;
  const current = currentIso ? new Date(currentIso).getTime() : NaN;
  return new Date(Number.isFinite(current) && current > extended ? current : extended).toISOString();
}

// ─── R8: guest data only with the guest's token ─────────────────────────────

/** Query parameter that carries the guest's token on the confirm page and the .ics download. */
export const GUEST_TOKEN_PARAM = "t";

/** Constant-time check of a supplied token against the booking's guest_status_token. */
export function guestTokenMatches(
  booking: Pick<GardssalgBooking, "guest_status_token">,
  supplied: unknown,
): boolean {
  const expected = booking.guest_status_token;
  if (!expected || typeof supplied !== "string" || !supplied) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** "?t=<token>" for a booking with a guest token, else "". */
export function guestTokenQuery(booking: Pick<GardssalgBooking, "guest_status_token">): string {
  return booking.guest_status_token
    ? `?${GUEST_TOKEN_PARAM}=${encodeURIComponent(booking.guest_status_token)}`
    : "";
}
