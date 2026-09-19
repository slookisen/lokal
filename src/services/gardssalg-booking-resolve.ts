// ─── One-utterance gårdssalg booking helpers ────────────────────────────────
// dev-request 2026-09-16-opplevagent-en-setning-booking-via-ai (Daniel, live
// session 2026-09-16): «man skal i realiteten kunne si "book et møte hos X
// fredag den 20. okt klokken 10.00", og dette vil gjennomføre hele booking-
// prosessen fra å legge inn og sende til produsent».
//
// Before this module, an AI assistant holding that sentence had NO path to a
// booking: discover_gardssalg could not look a producer up by name and did
// not even return the provider id book_gardssalg requires. This module is the
// small, shared, pure-ish layer every booking entry point (MCP book_gardssalg,
// POST /api/opplevelser/book, and through it the npm stdio server) calls
// BEFORE the unchanged BookingInputSchema → isBookingPaused() →
// checkBookingSlotAllowed() → createBooking() chain:
//
//   1. resolveGardssalgProviderByQuery() — «hos X» → exactly one provider
//      row, or an honest "none" / "ambiguous (pick one of these)" answer.
//      Never guesses between several plausible producers, never surfaces a
//      catalog_hidden row (searchGardssalgProviders' base WHERE excludes it).
//   2. checkRequestedWeekday() — «fredag den 20. okt»: 20 October 2026 is a
//      TUESDAY. When the caller states the weekday it heard, the slot's real
//      Oslo weekday is checked against it and a mismatch is returned WITH the
//      nearest dates that actually fall on the stated weekday, instead of
//      quietly booking the wrong day.
//   3. formatSlotOslo() — the resolved slot rendered in plain Norwegian
//      («tirsdag 20. oktober 2026 kl. 10:00») so the assistant can read the
//      exact date/time back to the human before and after submitting.
//
// Nothing here writes to the database, sends email, or touches the dispatch
// gates — those stay exactly where they are (booking-store.ts,
// gardssalg-opening-hours.ts). No new booking path is introduced.

import {
  searchGardssalgProviders,
  gardssalgQueryTerms,
  gardssalgQueryRank,
  type GardssalgProviderRow,
} from "./experience-store";
import { isBookingPaused } from "./booking-store";

const APP_URL = process.env.APP_URL || "https://opplevagent.no";

/** Public profile URL for a gårdssalg provider row (null when it has no slug). */
export function gardssalgProfileUrl(slug: string | null | undefined): string | null {
  return slug ? `${APP_URL}/kategori/gardssalg/produsent/${slug}` : null;
}

// ─── 1. Provider resolution by name ──────────────────────────────────────────

/** Max candidates returned on an ambiguous match (kept short: the assistant
 *  is expected to ask the human to pick, not to scroll). */
export const PROVIDER_QUERY_MAX_CANDIDATES = 8;
/** Max provider_query length honoured everywhere (mirrors the MCP schema). */
export const PROVIDER_QUERY_MAX_LENGTH = 200;

export type ProviderCandidate = {
  provider_id: string;
  navn: string;
  fylke: string | null;
  kommune: string | null;
  poststed: string | null;
  producer_type: string | null;
  booking: { live: boolean; mode: "request" | "paused" };
  profile_url: string | null;
};

export type ProviderResolution =
  | { kind: "one"; provider: GardssalgProviderRow; candidates_considered: number }
  | { kind: "none"; query: string }
  | { kind: "ambiguous"; query: string; candidates: ProviderCandidate[] };

/** Same compact, PII-free shape discover_gardssalg rows use for the fields an
 *  assistant needs to disambiguate (never epost/telefon). */
export function toProviderCandidate(row: GardssalgProviderRow): ProviderCandidate {
  // Public callers never see catalog_hidden=1 rows (searchGardssalgProviders'
  // default exclusion), so this is the plain gate — same as discover_gardssalg.
  // The admin test-send route CAN resolve a hidden row (includeHidden), and
  // for that row the hidden carve-out in isBookingPaused() is what decides.
  const live = !isBookingPaused(row.booking_live, row.catalog_hidden ?? null);
  return {
    provider_id: row.id,
    navn: row.navn,
    fylke: row.fylke ?? null,
    kommune: row.kommune ?? null,
    poststed: row.poststed ?? null,
    producer_type: row.producer_type ?? null,
    booking: { live, mode: live ? "request" : "paused" },
    profile_url: gardssalgProfileUrl(row.slug),
  };
}

/**
 * «hos X» → the one provider the human obviously means, or an honest
 * non-answer. Optional kommune/fylke narrow the search when the sentence
 * carried a place («Egge gård i Steinkjer»).
 *
 * Decision rule (deliberately conservative — a booking request reaches a
 * real producer's inbox, so never guess):
 *   - 0 rows                          → none
 *   - 1 row                           → one
 *   - several, exactly ONE of which is an exact whole-name match → one
 *   - otherwise                       → ambiguous, with ≤8 candidates for the
 *                                       assistant to put to the human
 */
export function resolveGardssalgProviderByQuery(
  query: string,
  // includeHidden: ADMIN-ONLY (POST /admin/booking-test-send) — lets the
  // hidden, email-pinned test producer be resolved by name. Never set from a
  // public entry point; see GardssalgSearchFilter.include_hidden.
  opts: { kommune?: string; fylke?: string; includeHidden?: boolean } = {},
): ProviderResolution {
  // Same 200-char cap as the MCP input schema, applied here too so the REST
  // path (and any other caller) can never hand the store an unbounded query.
  const q = String(query ?? "").trim().slice(0, PROVIDER_QUERY_MAX_LENGTH);
  const terms = gardssalgQueryTerms(q);
  if (terms.length === 0) return { kind: "none", query: q };

  const filter: { q: string; kommune?: string; fylke?: string; include_hidden?: boolean } = { q };
  if (opts.kommune && opts.kommune.trim()) filter.kommune = opts.kommune.trim();
  if (opts.fylke && opts.fylke.trim()) filter.fylke = opts.fylke.trim();
  if (opts.includeHidden === true) filter.include_hidden = true;

  const rows = searchGardssalgProviders(filter, PROVIDER_QUERY_MAX_CANDIDATES + 1);
  if (rows.length === 0) return { kind: "none", query: q };
  if (rows.length === 1) return { kind: "one", provider: rows[0]!, candidates_considered: 1 };

  const exact = rows.filter((r) => gardssalgQueryRank(r, terms) === 0);
  if (exact.length === 1) return { kind: "one", provider: exact[0]!, candidates_considered: rows.length };

  return {
    kind: "ambiguous",
    query: q,
    candidates: rows.slice(0, PROVIDER_QUERY_MAX_CANDIDATES).map(toProviderCandidate),
  };
}

// ─── 2. Requested-weekday guard ──────────────────────────────────────────────

/** 0 = Monday … 6 = Sunday — the same convention gardssalg-opening-hours.ts
 *  uses (never Sunday-first). */
export const WEEKDAY_NB: readonly string[] = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];

const WEEKDAY_ALIASES: Record<string, number> = {
  // bokmål / nynorsk / common abbreviations
  mandag: 0, måndag: 0, man: 0, ma: 0,
  tirsdag: 1, tysdag: 1, tirs: 1, tir: 1, ti: 1,
  onsdag: 2, ons: 2, on: 2,
  torsdag: 3, tors: 3, tor: 3, to: 3,
  fredag: 4, fre: 4, fr: 4,
  lørdag: 5, laurdag: 5, lør: 5, lau: 5, lø: 5,
  søndag: 6, sundag: 6, søn: 6, sun: 6, sø: 6,
  // english
  monday: 0, mon: 0,
  tuesday: 1, tue: 1, tues: 1,
  wednesday: 2, wed: 2,
  thursday: 3, thu: 3, thur: 3, thurs: 3,
  friday: 4, fri: 4,
  saturday: 5, sat: 5,
  sunday: 6,
};

/** Parse a stated weekday («fredag», «Fre.», «Friday») → 0..6, or null when
 *  it is not a weekday name this module knows. */
export function parseWeekday(input: string | null | undefined): number | null {
  const key = String(input ?? "")
    .trim()
    .toLocaleLowerCase("nb-NO")
    .replace(/[.,:;]+$/g, "")
    .replace(/^på\s+/, "");
  if (!key) return null;
  const idx = WEEKDAY_ALIASES[key];
  return typeof idx === "number" ? idx : null;
}

export interface OsloSlotParts {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
}

const NAKED_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function weekdayMondayFirstFromUtcDate(y: number, mo: number, d: number): number {
  // getUTCDay(): 0 = Sunday … 6 = Saturday → rotate to 0 = Monday.
  return (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * Break a booking slot into Europe/Oslo wall-clock parts. A naked
 * datetime-local string («2026-10-20T10:00», what the web form and the MCP
 * tool send) IS Oslo wall time and is read straight off the string; a
 * zone-carrying instant (Z / ±hh:mm, what API callers may send) is converted
 * with Intl — same approach booking-store.ts uses for display. Returns null
 * for anything unparseable (the hard bounds check downstream owns that error).
 */
export function osloSlotParts(slotAtRaw: string): OsloSlotParts | null {
  const raw = String(slotAtRaw ?? "").trim();
  const m = NAKED_LOCAL_RE.exec(raw);
  if (m) {
    const y = +m[1]!, mo = +m[2]!, d = +m[3]!, h = +m[4]!, mi = +m[5]!;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    // Reject impossible calendar dates (e.g. 31 Feb) — Date.UTC would roll
    // them over silently.
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
    return { y, mo, d, h, mi, weekday: weekdayMondayFirstFromUtcDate(y, mo, d) };
  }
  const t = new Date(raw);
  if (isNaN(t.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(t);
  const get = (type: string): number => +(parts.find((p) => p.type === type)?.value ?? "NaN");
  const y = get("year"), mo = get("month"), d = get("day"), h = get("hour"), mi = get("minute");
  if ([y, mo, d, h, mi].some((n) => !Number.isFinite(n))) return null;
  return { y, mo, d, h, mi, weekday: weekdayMondayFirstFromUtcDate(y, mo, d) };
}

const MONTH_NB: readonly string[] = [
  "januar", "februar", "mars", "april", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "desember",
];
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** «tirsdag 20. oktober 2026 kl. 10:00» — deterministic (no ICU locale data
 *  needed), Oslo wall time. Empty string when the slot is unparseable. */
export function formatSlotOslo(slotAtRaw: string): string {
  const p = osloSlotParts(slotAtRaw);
  if (!p) return "";
  return `${WEEKDAY_NB[p.weekday]} ${p.d}. ${MONTH_NB[p.mo - 1]} ${p.y} kl. ${pad2(p.h)}:${pad2(p.mi)}`;
}

/** The naked datetime-local form («YYYY-MM-DDTHH:mm») of Oslo parts. */
export function toDatetimeLocal(p: { y: number; mo: number; d: number; h: number; mi: number }): string {
  return `${String(p.y).padStart(4, "0")}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}`;
}

function shiftDays(p: OsloSlotParts, days: number): OsloSlotParts {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + days));
  const y = t.getUTCFullYear(), mo = t.getUTCMonth() + 1, d = t.getUTCDate();
  return { y, mo, d, h: p.h, mi: p.mi, weekday: weekdayMondayFirstFromUtcDate(y, mo, d) };
}

export interface WeekdayMismatch {
  requested_weekday: string;
  actual_weekday: string;
  slot_at: string;
  slot_at_local: string;
  /** Nearest dates before/after the slot that DO fall on the stated weekday,
   *  same time of day, never in the past (relative to `now`, Oslo). */
  suggestions: Array<{ slot_at: string; slot_at_local: string }>;
}

export type RequestedWeekdayCheck =
  | { ok: true; actual_weekday?: string }
  | { ok: false; reason: "unknown_weekday"; requested_weekday: string }
  | { ok: false; reason: "weekday_mismatch"; mismatch: WeekdayMismatch };

/**
 * When the caller states the weekday the human said («fredag») alongside the
 * concrete slot, verify they agree in Oslo time. Omitted/blank
 * requested_weekday → ok (nothing to check). An unparseable slot → ok here
 * too (slotBoundsError() downstream is the single owner of that error).
 */
export function checkRequestedWeekday(
  slotAtRaw: string,
  requestedWeekday: string | null | undefined,
  now: Date = new Date(),
): RequestedWeekdayCheck {
  const stated = String(requestedWeekday ?? "").trim();
  if (!stated) return { ok: true };
  const wanted = parseWeekday(stated);
  if (wanted === null) return { ok: false, reason: "unknown_weekday", requested_weekday: stated };
  const p = osloSlotParts(slotAtRaw);
  if (!p) return { ok: true };
  if (p.weekday === wanted) return { ok: true, actual_weekday: WEEKDAY_NB[p.weekday]! };

  // Nearest earlier + nearest later date on the wanted weekday, same time.
  const back = (p.weekday - wanted + 7) % 7 || 7;
  const fwd = (wanted - p.weekday + 7) % 7 || 7;
  const todayOslo = osloSlotParts(now.toISOString());
  const notPast = (c: OsloSlotParts): boolean => {
    if (!todayOslo) return true;
    const a = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi);
    const b = Date.UTC(todayOslo.y, todayOslo.mo - 1, todayOslo.d, todayOslo.h, todayOslo.mi);
    return a > b;
  };
  const suggestions = [shiftDays(p, -back), shiftDays(p, fwd)]
    .filter(notPast)
    .map((c) => {
      const s = toDatetimeLocal(c);
      return { slot_at: s, slot_at_local: formatSlotOslo(s) };
    });

  return {
    ok: false,
    reason: "weekday_mismatch",
    mismatch: {
      requested_weekday: WEEKDAY_NB[wanted]!,
      actual_weekday: WEEKDAY_NB[p.weekday]!,
      slot_at: String(slotAtRaw).trim(),
      slot_at_local: formatSlotOslo(slotAtRaw),
      suggestions,
    },
  };
}

// ─── 3. Shared response payloads (identical on MCP and REST) ────────────────
// Both entry points render the SAME objects so an assistant sees one contract
// whichever transport it came in through (the npm stdio server proxies REST).

export function providerNotFoundPayload(query: string): Record<string, unknown> {
  return {
    success: false,
    pending: false,
    rejected: true,
    reason: "provider_not_found",
    provider_query: query,
    message:
      `Fant ingen gårdssalg-produsent som matcher «${query}». Sjekk stavemåten, eller søk med ` +
      `discover_gardssalg (fylke/kommune) og bruk provider_id derfra. / ` +
      `No gårdssalg producer matches "${query}". Check the spelling, or search with discover_gardssalg ` +
      `(fylke/kommune) and pass its provider_id.`,
  };
}

export function providerAmbiguousPayload(query: string, candidates: ProviderCandidate[]): Record<string, unknown> {
  const names = candidates.map((c) => `${c.navn}${c.kommune ? ` (${c.kommune})` : ""}`).join("; ");
  return {
    success: false,
    pending: false,
    ambiguous: true,
    reason: "provider_ambiguous",
    provider_query: query,
    candidates,
    message:
      `Flere produsenter matcher «${query}»: ${names}. Spør gjesten hvilken som menes, og send inn på nytt ` +
      `med provider_id for den valgte (ingen booking er opprettet). / ` +
      `Several producers match "${query}": ${names}. Ask the guest which one they mean and resubmit with ` +
      `that provider_id (no booking was created).`,
  };
}

export function providerQueryMissingPayload(): Record<string, unknown> {
  return {
    success: false,
    pending: false,
    error: "invalid_input",
    message:
      "Oppgi enten provider_id (fra discover_gardssalg) eller provider_query (produsentens navn). / " +
      "Provide either provider_id (from discover_gardssalg) or provider_query (the producer's name).",
  };
}

export function unknownWeekdayPayload(stated: string): Record<string, unknown> {
  return {
    success: false,
    pending: false,
    error: "invalid_input",
    message:
      `Ukjent ukedag «${stated}» i requested_weekday — bruk mandag…søndag (eller Monday…Sunday), eller utelat feltet. / ` +
      `Unknown weekday "${stated}" in requested_weekday — use mandag…søndag (or Monday…Sunday), or omit the field.`,
  };
}

export function weekdayMismatchPayload(m: WeekdayMismatch): Record<string, unknown> {
  const alt = m.suggestions.map((s) => s.slot_at_local).join(" eller ");
  return {
    success: false,
    pending: false,
    weekday_mismatch: true,
    reason: "weekday_mismatch",
    requested_weekday: m.requested_weekday,
    actual_weekday: m.actual_weekday,
    slot_at: m.slot_at,
    slot_at_local: m.slot_at_local,
    suggestions: m.suggestions,
    message:
      `Datoen ${m.slot_at_local} er en ${m.actual_weekday}, ikke ${m.requested_weekday}. ` +
      (alt ? `Mente gjesten ${alt}? ` : "") +
      `Avklar med gjesten og send inn på nytt (ingen booking er opprettet). / ` +
      `${m.slot_at_local} is a ${m.actual_weekday}, not a ${m.requested_weekday}. ` +
      (alt ? `Did the guest mean ${alt}? ` : "") +
      `Clarify with the guest and resubmit (no booking was created).`,
  };
}
