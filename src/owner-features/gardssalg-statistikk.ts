// ─── O2-4: «Statistikk» in the gårdssalg owner dashboard ────────────────────
// dev-request 2026-11-12-opplevagent-o2-eierdashbord-for-besok, slice O2-4.
//
// A PURE renderer (the route, routes/gardssalg-owner-features.ts GET
// …/statistikk, reads the data): the owner's own request numbers and how
// often the profile was delivered to AI assistants.
//
// Input: the provider's own booking rows (listProviderBookings, booking-store
// — scoped by provider_id, every row, no history cap) plus `now`.
//
// Status mapping (booking-store.ts: `status` = reserved | confirmed_attended |
// no_show | cancelled, `pre_status` = awaiting_provider | provider_confirmed |
// provider_declined | time_suggested | expired). Every row but «Bekreftet»
// uses mineBesokPageStatus() — the same status «Mine besøk» shows — so the
// rows below it are disjoint:
//   stats.requests  «Forespørsler»          every row of the profile.
//   stats.confirmed «Bekreftet»             the producer confirmed it, whatever
//                                           happened after (attended, no-show,
//                                           cancelled later): pre_status
//                                           provider_confirmed, or a legacy row
//                                           outside the answer loop (no
//                                           respond_token — «Mine besøk» and the
//                                           attendance guard treat it as
//                                           confirmed) that is not cancelled.
//   stats.declined  «Avslått»               page status «declined»
//                                           (pre_status provider_declined, also
//                                           when the guest declined a suggested
//                                           time).
//   stats.expired   «Utløpt uten svar»      page status «expired»: pre_status
//                                           expired, or an open request whose
//                                           answer deadline has passed.
//   stats.cancelled «Avlyst eller trukket»  status cancelled — the guest
//                                           cancelled, the producer cancelled or
//                                           the guest withdrew a pending request
//                                           (gardssalg-cancel.ts writes all three
//                                           as status 'cancelled' + cancelled_by).
//   stats.attended  «Møtte»                 status confirmed_attended.
//   stats.noShow    «Møtte ikke»            status no_show.
// Rows the producer may still answer (pending / time suggested) are counted
// only in «Forespørsler». Test bookings (is_test) are counted, as «Mine besøk»
// lists them.
//
// stats.period «Siden {dato}»: the date of the profile's earliest booking
// request (min created_at, Europe/Oslo). Every count above covers all of the
// profile's requests, so «since the first request» is true by construction.
// The AI row has its own «Siden {dato}»: the counting start of
// profile_ai_deliveries (aiDeliveriesCountingSince), because that number
// covers the whole counting period, not the request period.
//
// stats.aiDeliveries: the same count the RFB owner portal shows («Med i
// AI-søk», computeAiDeliveries in profile-ai-deliveries-compute.ts, RFB via
// owner-stats-service.ts with vertical "rfb"), here with vertical
// "experiences" and the provider id — the number gardssalg-owner-stats-service
// already reads for gårdssalg profiles. Whole counting period (windowDays =
// null). null (read failed / no table) → the row is left out.
//
// Texts: tekstpakke OA-3 §1.4, verbatim; no other owner-facing sentence.
// Content rules for drink producers: numbers about visits only — no product,
// brand, strength, tasting or price.

import { escapeHtml } from "../routes/owner-portal";
import { type GardssalgBooking } from "../services/booking-store";
import { GARDSSALG_DASHBOARD_TEXTS } from "../owner-ui/gardssalg-dashboard";
import { mineBesokPageStatus } from "./gardssalg-mine-besok";

/** Tekstpakke OA-3 §1.4 («Statistikk»), verbatim. */
export const GARDSSALG_STATS_TEXTS = {
  "stats.heading": "Slik har det gått",
  "stats.requests": "Forespørsler",
  "stats.confirmed": "Bekreftet",
  "stats.declined": "Avslått",
  "stats.expired": "Utløpt uten svar",
  "stats.cancelled": "Avlyst eller trukket",
  "stats.attended": "Møtte",
  "stats.noShow": "Møtte ikke",
  "stats.aiDeliveries": "Ganger profilen din er vist i svar fra AI-assistenter",
  "stats.aiHelp": "Tallet viser hvor ofte en AI-assistent har hentet profilen din for å svare noen. Det sier ikke om personen så svaret eller tok kontakt.",
  "stats.period": "Siden {dato}",
} as const;

export type StatsCountKey = "requests" | "confirmed" | "declined" | "expired" | "cancelled" | "attended" | "noShow";
export const STATS_COUNT_KEYS: readonly StatsCountKey[] = ["requests", "confirmed", "declined", "expired", "cancelled", "attended", "noShow"];

export interface StatistikkModel {
  counts: Record<StatsCountKey, number>;
  /** created_at of the earliest request, or null when there is none. */
  firstRequestAt: string | null;
}

export interface StatistikkAi {
  total: number;
  /** 'YYYY-MM-DD' (UTC), the first counted day. */
  countingSince: string;
}

/** The numbers (see the mapping in the module doc). Pure. */
export function statistikkModel(bookings: readonly GardssalgBooking[], now: Date): StatistikkModel {
  const counts: Record<StatsCountKey, number> = { requests: 0, confirmed: 0, declined: 0, expired: 0, cancelled: 0, attended: 0, noShow: 0 };
  let firstRequestAt: string | null = null;
  let firstMs = Infinity;
  for (const b of bookings) {
    counts.requests++;
    const legacy = !b.respond_token;
    if (b.pre_status === "provider_confirmed" || (legacy && b.status !== "cancelled")) counts.confirmed++;
    switch (mineBesokPageStatus(b, now)) {
      case "declined": counts.declined++; break;
      case "expired": counts.expired++; break;
      case "cancelled": counts.cancelled++; break;
      case "attended": counts.attended++; break;
      case "noShow": counts.noShow++; break;
      default: break;
    }
    const ms = createdAtMs(b.created_at);
    if (Number.isFinite(ms) && ms < firstMs) {
      firstMs = ms;
      firstRequestAt = b.created_at;
    }
  }
  return { counts, firstRequestAt };
}

/** created_at is either SQLite datetime('now') («YYYY-MM-DD HH:MM:SS», UTC) or an ISO instant. */
function createdAtMs(raw: string | null | undefined): number {
  const s = String(raw ?? "").trim();
  if (!s) return NaN;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(" ", "T") + "Z" : s;
  return Date.parse(iso);
}

function dateNb(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleDateString("nb-NO", { day: "numeric", month: "long", year: "numeric", timeZone });
}

/** Fill `{key}` literally (split/join, not String.replace). */
function fill(tpl: string, key: string, value: string): string {
  return tpl.split(`{${key}}`).join(value);
}

function periodText(dateText: string): string {
  return fill(GARDSSALG_STATS_TEXTS["stats.period"], "dato", dateText);
}

/**
 * Layout of the two number tables (slice 6, dev-request 2026-11-24-
 * opplevagent-eierdashbord-lyst-tema-og-testfunn): each table fills the card,
 * the label (th) is left-aligned and may wrap, the number (td) is
 * right-aligned in a narrow column that never wraps, with a gap between them.
 * Both tables use the same columns, so the AI table lines up with the first
 * one instead of wrapping skewed. No fixed width — fits 390 px without
 * horizontal scroll. Scoped to .gs-st-tall (gårdssalg «Statistikk» only),
 * light-only like the rest of the gårdssalg pages.
 */
export const GARDSSALG_STATS_CSS = [
  ".gs-st-tall { width: 100%; max-width: 100%; border-collapse: collapse; margin: 8px 0; }",
  ".gs-st-tall th, .gs-st-tall td { padding: 8px 0; border-bottom: 1px solid #f0ede2; vertical-align: top; }",
  ".gs-st-tall th { text-align: left; font-weight: 400; padding-right: 16px; overflow-wrap: anywhere; }",
  ".gs-st-tall td { text-align: right; width: 1%; white-space: nowrap; padding-left: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }",
].join("\n");

/** The «Statistikk» card as an HTML fragment (its table CSS first). Pure. */
export function renderGardssalgStatistikk(model: StatistikkModel, ai: StatistikkAi | null): string {
  const T = GARDSSALG_STATS_TEXTS;
  const firstMs = createdAtMs(model.firstRequestAt);
  const period = Number.isFinite(firstMs)
    ? `\n    <p class="gs-st-periode" data-stats-period="requests">${escapeHtml(periodText(dateNb(firstMs, "Europe/Oslo")))}</p>`
    : "";
  const rows = STATS_COUNT_KEYS.map((k) =>
    `      <tr data-stat="${k}"><th scope="row">${escapeHtml(T[`stats.${k}`])}</th><td>${model.counts[k]}</td></tr>`,
  ).join("\n");
  let aiBlock = "";
  if (ai) {
    const sinceMs = Date.parse(ai.countingSince + "T00:00:00Z");
    const aiPeriod = Number.isFinite(sinceMs)
      ? `\n    <p class="gs-st-periode" data-stats-period="ai">${escapeHtml(periodText(dateNb(sinceMs, "UTC")))}</p>`
      : "";
    aiBlock = `
    <table class="gs-st-tall" data-stats-ai="1">
      <tr data-stat="aiDeliveries"><th scope="row">${escapeHtml(T["stats.aiDeliveries"])}</th><td>${Math.max(0, Math.floor(ai.total))}</td></tr>
    </table>
    <p class="gs-st-hjelp">${escapeHtml(T["stats.aiHelp"])}</p>${aiPeriod}`;
  }
  return `<style>${GARDSSALG_STATS_CSS}</style>
  <section class="gc-card gs-statistikk" data-gardssalg-statistikk="1" aria-labelledby="gs-st-tittel">
    <h1>${escapeHtml(GARDSSALG_DASHBOARD_TEXTS["tab.stats"])}</h1>
    <h2 id="gs-st-tittel">${escapeHtml(T["stats.heading"])}</h2>
    <table class="gs-st-tall" data-stats-requests="1">
${rows}
    </table>${period}${aiBlock}
  </section>`;
}
