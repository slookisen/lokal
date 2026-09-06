// ─── Gårdssalg opening-hours soft validation (dev-request 2026-07-14-
// booking-flyt-v1, "Slice 1 — myk åpningstidsvalidering", Daniel-authorized
// 2026-07-18) ────────────────────────────────────────────────────────────
//
// Pure, best-effort parsing of the free-text `experience_providers.
// opening_hours_text` snippet (most producers have nothing usable there —
// this is a SOFT guide, never a hard gate on its own) plus the two
// unconditional HARD bounds every booking slot must satisfy (not in the
// past, not absurdly far in the future). No DB access except the read-only
// coverage report at the bottom.
//
// Text shape: as of dev-request 2026-08-18-apningstider-llm-dommer,
// opening_hours_text is written by an LLM judge (generateGardssalg
// OpeningHoursFromSource() in routes/opplevelser.ts) constrained to a clean,
// short Norwegian snippet like "Man-fre 10-18", "Åpningstider: 10:00-16:00
// alle dager", or "Lørdag 10-14" — extractOpeningHours() (services/
// search-enrich.ts) is merely the free trigger that decides whether that LLM
// call is worth making, never the written value. Most rows are still blank
// or sparse (few producers have stated hours at all) — parseOpeningHoursText
// FAILS OPEN (returns null) on anything it cannot confidently read, which is
// the correct behaviour for a soft check: no data must never be treated as
// "always closed".
//
// Known limitations (explicitly out of scope for this slice — see the
// dev-request's own non-goals):
//   - Exactly ONE time range per snippet. A snippet stating different hours
//     for different days ("Hverdager 10-18, lørdag 10-14") only yields the
//     FIRST range found, applied to whichever day-set is detected — a real
//     multi-range snippet will parse (or not) inconsistently, never crash.
//   - No overnight ranges: a close time at or before the open time
//     (`closeMin <= openMin`) is treated as unparseable rather than guessed
//     as wrapping past midnight — farm-shop visiting hours never do, and
//     guessing wrong would be worse than saying "no data".
//   - Norwegian weekday names/abbreviations only (not e.g. "weekends",
//     "hverdager" is NOT recognised as a weekday-range synonym today).

import { getDb } from "../database/db-factory";

const VERTICAL = "experiences";

// Day convention used EVERYWHERE in this module: 0 = Monday … 6 = Sunday
// (ISO-ish, but zero-based — chosen so `(i + 1) % 7` walks the week forward
// without a special case for Sunday). Every function in this file and its
// test file uses this same convention — never Sunday-first.
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ParsedOpeningHours {
  /** Which weekdays (0=Monday..6=Sunday) this time range applies to. */
  days: Set<Weekday>;
  /** Opening time, minutes since midnight (Europe/Oslo local). */
  openMin: number;
  /** Closing time, minutes since midnight (Europe/Oslo local). Always > openMin. */
  closeMin: number;
  /** The raw snippet this was parsed from (trimmed), for logging/echoing back. */
  raw: string;
}

// ─── Weekday vocabulary ─────────────────────────────────────────────────
// Index i in both arrays names day i under the 0=Monday convention above.
// Every token here starts and ends with a plain ASCII letter (mandag,
// tirsdag, … lørdag ends in "g", søndag ends in "g", "lør"/"søn" end in "r"/
// "n") so a \b anchor is safe on both sides — unlike a token that itself
// STARTS with æ/ø/å, where JS's ASCII-only \w definition would silently fail
// to find a boundary after a preceding space (see the equivalent caution in
// extractOpeningHours()'s own comment, services/search-enrich.ts).
const WEEKDAY_FULL: readonly string[] = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
const WEEKDAY_ABBR: readonly string[] = ["man", "tir", "ons", "tor", "fre", "lør", "søn"];

function weekdayIndexOf(token: string): Weekday | -1 {
  const t = token.toLowerCase();
  const full = WEEKDAY_FULL.indexOf(t);
  if (full !== -1) return full as Weekday;
  const abbr = WEEKDAY_ABBR.indexOf(t);
  return abbr !== -1 ? (abbr as Weekday) : -1;
}

// Full names listed BEFORE abbreviations in the alternation so "mandag"
// matches whole at a given position rather than the engine ever having a
// reason to prefer the 3-letter prefix (moot here since both are anchored
// with \b and full names strictly contain the abbreviation as a prefix, but
// keeping the longer alternative first is the standard safe ordering).
const WEEKDAY_TOKEN_PATTERN = [...WEEKDAY_FULL, ...WEEKDAY_ABBR].join("|");
const WEEKDAY_RANGE_RE = new RegExp(
  `\\b(${WEEKDAY_TOKEN_PATTERN})\\b\\s*(?:-|–|til)\\s*\\b(${WEEKDAY_TOKEN_PATTERN})\\b`,
  "i",
);
const WEEKDAY_SINGLE_RE = new RegExp(`\\b(${WEEKDAY_TOKEN_PATTERN})\\b`, "gi");

// ─── Time-range vocabulary ──────────────────────────────────────────────
// First alternative (colon/period, e.g. "10:00-16:00" / "10.00-16.00") is
// listed before the bare-hour alternative ("10-18") so that at any given
// starting index the more specific form wins — JS tries alternatives in
// source order at each position, so "10:00-16:00" is never partially
// swallowed by the bare-hour branch. The bare branch's `(?!\d)` stops a
// trailing digit (e.g. a "2026" nearby) from being absorbed into the close
// hour.
const TIME_RANGE_RE =
  /(\d{1,2})[:.](\d{2})\s*[-–]\s*(\d{1,2})[:.](\d{2})|(\d{1,2})\s*[-–]\s*(\d{1,2})(?!\d)/;

/**
 * Best-effort parse of a free-text opening-hours snippet into ONE time range
 * + the weekdays it applies to. Returns null (fail OPEN — no data is not an
 * error) whenever:
 *   - the text is blank/missing,
 *   - no time-range pattern is found at all, or
 *   - a time range IS found but is nonsensical (close <= open, or an
 *     out-of-range hour/minute) — never guessed at.
 *
 * When a time range parses but NO weekday is named anywhere in the snippet,
 * the range is applied to ALL 7 days — the safe default for what is only
 * ever used as a SOFT check (see isSlotWithinOpeningHours): a producer who
 * wrote "Åpningstider: 10-18" without naming days almost certainly means
 * every day, and even if that guess is wrong the guest can always resend
 * with `confirm_outside_hours: true`.
 */
export function parseOpeningHoursText(text: string | null | undefined): ParsedOpeningHours | null {
  if (!text) return null;
  const raw = text.trim();
  if (!raw) return null;

  const timeMatch = TIME_RANGE_RE.exec(raw);
  if (!timeMatch) return null;

  let openH: number, openM: number, closeH: number, closeM: number;
  if (timeMatch[1] !== undefined) {
    openH = Number(timeMatch[1]);
    openM = Number(timeMatch[2]);
    closeH = Number(timeMatch[3]);
    closeM = Number(timeMatch[4]);
  } else {
    openH = Number(timeMatch[5]);
    openM = 0;
    closeH = Number(timeMatch[6]);
    closeM = 0;
  }
  if (
    !Number.isFinite(openH) || !Number.isFinite(closeH) ||
    openH < 0 || openH > 23 || closeH < 0 || closeH > 23 ||
    openM < 0 || openM > 59 || closeM < 0 || closeM > 59
  ) {
    return null;
  }
  const openMin = openH * 60 + openM;
  const closeMin = closeH * 60 + closeM;
  // Never guess an overnight wrap — see the module doc comment.
  if (closeMin <= openMin) return null;

  let days: Set<Weekday>;
  const rangeMatch = WEEKDAY_RANGE_RE.exec(raw);
  if (rangeMatch) {
    const startIdx = weekdayIndexOf(rangeMatch[1]!);
    const endIdx = weekdayIndexOf(rangeMatch[2]!);
    days = new Set<Weekday>();
    if (startIdx !== -1 && endIdx !== -1) {
      let i: Weekday = startIdx;
      // At most 7 steps around the week — walks forward from start to end,
      // wrapping past Sunday->Monday if the range is stated backwards
      // (e.g. a hypothetical "fredag-mandag").
      for (let step = 0; step < 7; step++) {
        days.add(i);
        if (i === endIdx) break;
        i = ((i + 1) % 7) as Weekday;
      }
    }
  } else {
    const found = new Set<Weekday>();
    WEEKDAY_SINGLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WEEKDAY_SINGLE_RE.exec(raw))) {
      const idx = weekdayIndexOf(m[1]!);
      if (idx !== -1) found.add(idx);
    }
    // No weekday named at all -> every day (see doc comment above).
    days = found.size > 0 ? found : new Set<Weekday>([0, 1, 2, 3, 4, 5, 6]);
  }

  return { days, openMin, closeMin, raw };
}

// English weekday name -> our 0=Monday..6=Sunday convention, keyed off
// Intl's `weekday: "long"` output for the "en-US" locale (stable, ASCII,
// unambiguous — unlike asking Intl for Norwegian weekday names, which would
// hand back the exact same accented strings this module has to parse and
// buys nothing).
const EN_WEEKDAY_TO_IDX: Record<string, Weekday> = {
  Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6,
};

/**
 * Whether a booking slot (a UTC ISO instant, same shape as
 * `gardssalg_bookings.slot_at`) falls within the given parsed opening
 * hours, evaluated in EUROPE/OSLO local time (the only timezone a Norwegian
 * farm-shop's stated hours could mean) — same Intl-based
 * instant->Oslo-wall-clock approach booking-store.ts's own
 * defaultBookingSlotAtDatetimeLocal()/osloDatetimeLocalToUtcIso() use,
 * deliberately not reinvented here. Close time is EXCLUSIVE (a slot AT
 * closing time is treated as outside — a farm visit starting exactly when
 * the gate closes isn't really "within hours").
 *
 * An unparseable slotAtIso fails OPEN (returns true) — this is a SOFT check
 * layered on top of the hard slotBoundsError() gate below, which already
 * rejects a genuinely broken/missing instant; this function must never be
 * the thing that turns an already-invalid slot into a confusing second
 * error.
 */
export function isSlotWithinOpeningHours(slotAtIso: string, parsed: ParsedOpeningHours): boolean {
  const d = new Date(slotAtIso);
  if (isNaN(d.getTime())) return true;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";

  const dayIdx = EN_WEEKDAY_TO_IDX[get("weekday")];
  if (dayIdx === undefined) return true;
  if (!parsed.days.has(dayIdx)) return false;

  const minutesSinceMidnight = Number(get("hour")) * 60 + Number(get("minute"));
  return minutesSinceMidnight >= parsed.openMin && minutesSinceMidnight < parsed.closeMin;
}

// ─── Hard bounds (unconditional — every booking entry point) ───────────

/**
 * How many days ahead a booking slot may be requested. Reads
 * `BOOKING_MAX_DAYS_AHEAD`, falling back to 90 when unset/invalid — same
 * parseFloat + Number.isFinite guard style as previsitReminderHours()/
 * previsitExpireHours() in services/booking-store.ts.
 */
export function bookingMaxDaysAhead(): number {
  const n = parseFloat(process.env.BOOKING_MAX_DAYS_AHEAD || "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90;
}

/**
 * HARD rule, independent of opening hours entirely: a slot must be in the
 * future and no more than `maxDaysAhead` days out. Returns a short
 * Norwegian error string when violated, else null. `now` is injectable for
 * deterministic tests — never call `new Date()` anywhere else in this
 * function.
 */
export function slotBoundsError(
  slotAtIso: string,
  maxDaysAhead: number = bookingMaxDaysAhead(),
  now: Date = new Date(),
): string | null {
  const slot = new Date(slotAtIso);
  if (isNaN(slot.getTime())) {
    return "Ugyldig tidspunkt oppgitt for besøket.";
  }
  if (slot.getTime() < now.getTime()) {
    return "Det valgte tidspunktet er allerede passert. Velg et fremtidig tidspunkt.";
  }
  const maxMs = maxDaysAhead * 24 * 3600 * 1000;
  if (slot.getTime() - now.getTime() > maxMs) {
    return `Det valgte tidspunktet er for langt frem i tid — velg et tidspunkt innen ${maxDaysAhead} dager.`;
  }
  return null;
}

// ─── Shared choke point for all 3 booking entry points ─────────────────
// POST /api/opplevelser/book (opplevelser.ts), the no-JS SSR fallback
// (experiences-seo.ts) and the book_gardssalg MCP tool (experiences-mcp.ts)
// all call this ONE function instead of triplicating the bounds + opening-
// hours logic — see the dev-request's own instruction to prefer a shared
// choke point over copy-pasting the check three times.

export interface BookingSlotProviderLike {
  opening_hours_text?: string | null;
}

export interface BookingSlotCheckInput {
  slot_at: string;
  confirm_outside_hours?: boolean;
}

export type BookingSlotCheckResult =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Runs, in order:
 *   1. The HARD bounds check (past / too-far-ahead) — 400, always enforced,
 *      never bypassable by confirm_outside_hours.
 *   2. The SOFT opening-hours check — only when opening_hours_text parses
 *      AND the slot falls outside it AND the caller has not already set
 *      confirm_outside_hours:true. This is a 200, not an error: the booking
 *      is simply not created yet, and the caller is expected to resend with
 *      confirmation if they still want that time.
 * Any other case (no usable hours text, or the slot IS within hours, or
 * confirm_outside_hours was set) returns {ok:true} — proceed exactly as
 * before this slice.
 */
export function checkBookingSlotAllowed(
  provider: BookingSlotProviderLike | null | undefined,
  input: BookingSlotCheckInput,
  now: Date = new Date(),
): BookingSlotCheckResult {
  const boundsErr = slotBoundsError(input.slot_at, bookingMaxDaysAhead(), now);
  if (boundsErr) {
    return { ok: false, status: 400, body: { error: boundsErr } };
  }

  const rawHours = provider?.opening_hours_text ?? null;
  const parsed = parseOpeningHoursText(rawHours);
  if (parsed && input.confirm_outside_hours !== true && !isSlotWithinOpeningHours(input.slot_at, parsed)) {
    return {
      ok: false,
      status: 200,
      body: {
        success: false,
        outside_hours: true,
        opening_hours_text: rawHours,
        message:
          `Det valgte tidspunktet ser ut til å ligge utenfor produsentens oppgitte åpningstider ` +
          `(${rawHours}). Send forespørselen på nytt med confirm_outside_hours: true dersom du ` +
          `likevel ønsker dette tidspunktet.`,
      },
    };
  }

  return { ok: true };
}

// ─── Coverage report (read-only) ────────────────────────────────────────

export interface GardssalgOpeningHoursCoverage {
  total: number;
  withText: number;
  parseable: number;
}

/**
 * Read-only stats over ALL experience_providers rows (no visibility/
 * catalog_hidden filter — this reports on the raw data quality of the
 * field, not on what's publicly bookable), mirroring
 * getExperiencesMarketplaceStats()'s own plain `getDb(VERTICAL)` + one
 * query convention rather than taking an injectable db handle.
 */
export function gardssalgOpeningHoursCoverage(): GardssalgOpeningHoursCoverage {
  const db = getDb(VERTICAL);
  const rows = db
    .prepare("SELECT opening_hours_text FROM experience_providers")
    .all() as Array<{ opening_hours_text: string | null }>;

  let withText = 0;
  let parseable = 0;
  for (const row of rows) {
    const text = row.opening_hours_text;
    if (text && text.trim()) {
      withText++;
      if (parseOpeningHoursText(text)) parseable++;
    }
  }
  return { total: rows.length, withText, parseable };
}
