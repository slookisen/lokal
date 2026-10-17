import type { Lang } from "../i18n/t";

/**
 * Opening hours of an RFB producer, read one way on every surface.
 *
 * Integration test 2026-10-17, slice I-H (dev-request
 * 2026-10-17-integrasjonstest-oppfolging; FUNN rfb-apningstider-alternative-
 * former and rfb-isopennow-lange-dagnavn from the lokal#1114 review).
 * agent_knowledge.opening_hours is JSON that nothing type-checks. Its declared
 * form is a list of {day, open, close} with day "mon"…"sun", but live data
 * (2026-10-17, 1563 producers) also holds {day, hours}, {day, from, to},
 * {days, open, close} with days as text or a list, {period, days, open,
 * close}, {day, note}, {note}, text entries and free text for the whole
 * field, with day labels in English and Norwegian (bokmål and nynorsk), short
 * and long, as ranges ("Man-fre", "mon-sun", "Tysdag-Onsdag") and as "every
 * day" ("Daglig", "daily"). The producer page (seo.ts), lokal_info (mcp.ts)
 * and the A2A auto-reply (conversation-service.ts) each read their own subset:
 * the page and lokal_info left these producers without hours, and the front
 * page's "open now" matched only three-letter keys, so it said "Stengt"
 * during opening hours for long day names (43 of 160 sampled producers with
 * timed hours).
 *
 * normalizeOpeningHours() reads every form into one entry shape, and the
 * helpers below give the day labels, the compact text form and the "open
 * now" status from it, so the three surfaces agree. Pure: no DB, and the
 * clock is a parameter.
 */

/** A weekday as an index: Monday = 0 … Sunday = 6 (the Norwegian week). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** One opening-hours entry in a fixed shape. */
export interface OpeningHoursEntry {
  /**
   * The weekdays the entry is for, ascending. Empty when its day label is not
   * a weekday, a range of weekdays or "every day" ("Påske", "Varierer",
   * "Lørdag (vinter)"), or when it has none (a text entry).
   */
  days: Weekday[];
  /** The day label as stored, trimmed; "" when there is none. Shown as written when `days` is empty. */
  label: string;
  /** Opening and closing time as text ("10:00", or "10" for a number); both are set, or neither. */
  open?: string;
  close?: string;
  /** The season the entry is limited to ("Mai–September"), as stored. */
  period?: string;
  /** A note ("Kun i sesong"), "Stengt" for a closed day, other text in an hours field, or the whole text of a text entry. */
  note?: string;
}

// ─── Day tables (moved here from routes/seo.ts) ────────────────────────

/** Weekday names per page language, Monday first. */
export const WEEKDAY_NAMES: Readonly<Record<Lang, readonly string[]>> = {
  no: ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag", "Søndag"],
  // Daniel 2026-09-03 (screenshot: "Mandag … Søndag", "I dag" on /en).
  en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  sv: ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"],
};

/** The short Norwegian names of lokal_info and the auto-reply ("Man 10:00–17:00"). */
const WEEKDAY_SHORT_NO: readonly string[] = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];

/**
 * Every spelling of a single weekday found in the data, lower case. A Map,
 * so a label such as "constructor" never finds an Object.prototype member.
 * English short and long keys (the declared form and the enrichment's long
 * form), the Norwegian abbreviations and names that were NO_DAY_ALIASES in
 * seo.ts (with the ASCII spellings "lor"/"son"), "tors" ("Man–tors") and the
 * nynorsk names in live data ("Måndag", "Tysdag", "Laurdag").
 */
const WEEKDAY_ALIASES: ReadonlyMap<string, Weekday> = new Map<string, Weekday>([
  ["mon", 0], ["tue", 1], ["wed", 2], ["thu", 3], ["fri", 4], ["sat", 5], ["sun", 6],
  ["monday", 0], ["tuesday", 1], ["wednesday", 2], ["thursday", 3], ["friday", 4], ["saturday", 5], ["sunday", 6],
  ["man", 0], ["tir", 1], ["ons", 2], ["tor", 3], ["tors", 3], ["fre", 4],
  ["lør", 5], ["lor", 5], ["søn", 6], ["son", 6],
  ["mandag", 0], ["tirsdag", 1], ["onsdag", 2], ["torsdag", 3], ["fredag", 4],
  ["lørdag", 5], ["lordag", 5], ["søndag", 6], ["sondag", 6],
  ["måndag", 0], ["tysdag", 1], ["laurdag", 5],
]);

/** Labels that mean every day ("Daglig 06:00–22:00", "all 00:00–23:59" in live data). */
const EVERY_DAY = new Set(["daglig", "dagleg", "daily", "all", "hver dag", "alle dager"]);

/**
 * Day values the enrichment wrote as a marker, not a day: {day: "note", open:
 * "<text>"} and {day: "by-appointment", note: "<text>"}. The text is shown;
 * the marker is not.
 */
const MARKER_LABELS = new Set(["note", "by-appointment"]);

const ALL_DAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

function weekdayOf(word: string): Weekday | undefined {
  return WEEKDAY_ALIASES.get(word.replace(/\.$/, ""));
}

/**
 * The weekdays a day label names, or null when it names none: one day
 * ("sat", "Lørdag", "saturday"), a range ("mon-fri", "Man–fre",
 * "onsdag - søndag"; "fri-mon" wraps over the weekend) or "every day".
 * A label with more than that ("Lørdag (vinter)", "Jun–aug (ons–søn)",
 * "Lørdag i sesong") names none: the qualifier would be lost.
 */
export function parseDayLabel(label: string): Weekday[] | null {
  const k = label.trim().toLowerCase().replace(/\s+/g, " ");
  if (!k) return null;
  if (EVERY_DAY.has(k)) return [...ALL_DAYS];
  const one = weekdayOf(k);
  if (one !== undefined) return [one];
  // The range rule from seo.ts's dayName: both ends must be known days.
  const range = /^([^\s–—-]+)\s*[-–—]\s*([^\s–—-]+)$/.exec(k);
  if (!range) return null;
  const a = weekdayOf(range[1]!);
  const b = weekdayOf(range[2]!);
  if (a === undefined || b === undefined) return null;
  const days: Weekday[] = [];
  for (let d: number = a; ; d = (d + 1) % 7) {
    days.push(d as Weekday);
    if (d === b) break;
  }
  return days.sort((x, y) => x - y);
}

/**
 * Weekdays as one label: a day ("Lørdag"), a run ("Mandag–Fredag"; a run over
 * the weekend keeps its order, "Fredag–Mandag"; all seven are
 * "Mandag–Søndag") or a list for days that are not one run.
 */
export function weekdaysLabel(days: readonly Weekday[], names: readonly string[], listSeparator = ", "): string {
  const set = new Set(days);
  if (set.size === 0) return "";
  if (set.size === 7) return `${names[0]}–${names[6]}`;
  const sorted = [...set].sort((x, y) => x - y);
  if (sorted.length === 1) return names[sorted[0]!]!;
  // A run has exactly one day whose previous day is not in the set.
  const starts = sorted.filter((d) => !set.has(((d + 6) % 7) as Weekday));
  if (starts.length === 1) {
    const start = starts[0]!;
    return `${names[start]}–${names[(start + set.size - 1) % 7]}`;
  }
  return sorted.map((d) => names[d]).join(listSeparator);
}

/** The day column of an entry on a page: its weekdays in the page language, or its label as stored. */
export function entryDaysLabel(entry: OpeningHoursEntry, lang: Lang): string {
  return entry.days.length ? weekdaysLabel(entry.days, WEEKDAY_NAMES[lang] ?? WEEKDAY_NAMES.no) : entry.label;
}

// ─── Times ─────────────────────────────────────────────────────────────

/** "10", "10:00" or "10.00", alone. */
const TIME = /^\s*\d{1,2}(?:[:.]\d{2})?\s*$/;
/** "10:00-17:00", "10–17", "09.00 - 15.30": one range and nothing else. */
const TIME_RANGE = /^\s*(\d{1,2}(?:[:.]\d{2})?)\s*[-–—]\s*(\d{1,2}(?:[:.]\d{2})?)\s*$/;

/**
 * Text in a time field, or the hours field, that says the day is closed. Live
 * data 2026-10-17 has {day: "sun", open: "closed", close: "closed"} (four
 * producers; it showed "closed – closed" and went into JSON-LD as a time) and
 * {day: "Mandag", hours: "Stengt"}. Both are the note "Stengt".
 */
const CLOSED_WORDS = new Set(["closed", "stengt", "stengd"]);
const CLOSED_NOTE = "Stengt";

function isClosedWord(text: string): boolean {
  return CLOSED_WORDS.has(text.trim().toLowerCase());
}

/** A time field as text: text as it is, a finite number as its digits ("10"), anything else none. */
function timeText(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** Minutes after midnight for "10", "10:30" or "10.30" (up to "24:00"); null for anything else. */
export function timeMinutes(text: string): number | null {
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*$/.exec(text);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2] ?? 0);
  return Number(m[2] ?? 0) < 60 && minutes <= 24 * 60 ? minutes : null;
}

/**
 * A clock time as "HH:MM" ("9" and "09.00" are "09:00", "24:00" stays), or
 * null when the text is not a clock time ("closed"): the form schema.org's
 * opens/closes take. The identity for text that is already "HH:MM".
 */
export function clockTime(text: string): string | null {
  const minutes = timeMinutes(text);
  if (minutes === null) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// ─── Normalizer ────────────────────────────────────────────────────────

/** The first of the keys whose value is set (not undefined or null). */
function field(h: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (h[key] !== undefined && h[key] !== null) return h[key];
  }
  return undefined;
}

/** The weekdays and label of an entry's day field (text, or a list of day names). */
function entryDays(value: unknown): { days: Weekday[]; label: string } {
  if (typeof value === "string") {
    const label = value.trim();
    if (MARKER_LABELS.has(label.toLowerCase())) return { days: [], label: "" };
    return { days: parseDayLabel(label) ?? [], label };
  }
  if (Array.isArray(value)) {
    const names = value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
    const parsed = names.map(parseDayLabel);
    const label = names.join(", ");
    if (!names.length || parsed.some((p) => p === null)) return { days: [], label };
    const days = [...new Set(parsed.flat() as Weekday[])].sort((x, y) => x - y);
    return { days, label };
  }
  return { days: [], label: "" };
}

/** One entry in the fixed shape, or null when it says nothing usable. */
function normalizeEntry(item: unknown): OpeningHoursEntry | null {
  if (typeof item === "string") {
    const text = item.trim();
    return text ? { days: [], label: "", note: text } : null;
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const h = item as Record<string, unknown>;
  const { days, label } = entryDays(field(h, "day", "days"));
  const notes: string[] = [];
  let open = timeText(field(h, "open", "from"));
  let close = timeText(field(h, "close", "to"));
  // "closed" in the time fields, and no time beside it, is a closed day.
  const given = [open, close].filter((t) => t.trim());
  if (given.length && given.every(isClosedWord)) {
    notes.push(CLOSED_NOTE);
    open = "";
    close = "";
  }
  if (!open.trim() || !close.trim()) {
    // A lone time says nothing; lone text in a time field is a note
    // ({day: "note", open: "1. juli - 31. juli: Mandag-søndag 09:00-16:00"}).
    const lone = (open.trim() ? open : close).trim();
    if (lone && !TIME.test(lone)) notes.push(lone);
    open = "";
    close = "";
    // {day, hours}: "09:00-18:00" is the two times; other text ("Stengt") is a note.
    const hours = typeof h.hours === "string" ? h.hours.trim() : "";
    const range = TIME_RANGE.exec(hours);
    if (range) {
      open = range[1]!;
      close = range[2]!;
    } else if (hours) {
      notes.push(isClosedWord(hours) ? CLOSED_NOTE : hours);
    }
  }
  if (typeof h.note === "string" && h.note.trim()) notes.push(h.note.trim());
  const period = typeof h.period === "string" ? h.period.trim() : "";
  if (!open && !notes.length) return null;
  const entry: OpeningHoursEntry = { days, label };
  if (open) { entry.open = open; entry.close = close; }
  if (period) entry.period = period;
  if (notes.length) entry.note = [...new Set(notes)].join("; ");
  return entry;
}

/**
 * The opening hours in one shape, in stored order. A list gives one entry per
 * item that says something: both times (text, or numbers as their digits),
 * or a note or text. An item with only one time, or nothing usable, is left
 * out (it showed as "undefined" before I-G). Free text for the whole field
 * ("Man–fre 10–17") is one text entry; it is not parsed into days. Anything
 * else has no entries.
 */
export function normalizeOpeningHours(value: unknown): OpeningHoursEntry[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [{ days: [], label: "", note: text }] : [];
  }
  if (!Array.isArray(value)) return [];
  const entries: OpeningHoursEntry[] = [];
  for (const item of value) {
    const entry = normalizeEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ─── Compact text (lokal_info and the auto-reply) ──────────────────────

/**
 * One entry as text: "Man 10:00–17:00", "Man–Fre 09:00–18:00", "Tor–Fre
 * 12:00–16:00 (April)", "Man: Stengt", "Hele året: Åpent ved bestilling" or
 * the text itself. A day label that names no weekday is shown as written. A
 * note on an entry with times is left out, as lokal_info and the auto-reply
 * did before; the period is not, since the times hold only in it.
 */
export function openingHoursEntryText(entry: OpeningHoursEntry): string {
  const day = entry.days.length ? weekdaysLabel(entry.days, WEEKDAY_SHORT_NO, "/") : entry.label;
  if (entry.open !== undefined && entry.close !== undefined) {
    const period = entry.period ? ` (${entry.period})` : "";
    return `${day} ${entry.open}–${entry.close}${period}`.trim();
  }
  const text = [entry.period, entry.note].filter(Boolean).join("; ");
  return day ? `${day}: ${text}` : text;
}

/**
 * The opening hours as one line of text, at most `max` entries; "" when there
 * are none. Entries are separated by ", ", or by "; " when an entry has a
 * comma of its own ("Boden (selvbetjent): uke 20-41, døgnåpen; Lør
 * 11:00–15:00"), so it is clear where each one ends.
 */
export function openingHoursText(value: unknown, max = Infinity): string {
  const texts = normalizeOpeningHours(value).slice(0, max).map(openingHoursEntryText);
  return texts.join(texts.some((t) => t.includes(",")) ? "; " : ", ");
}

// ─── Open now ──────────────────────────────────────────────────────────

const OSLO_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Oslo", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** The weekday and the minutes after midnight in Norway (Europe/Oslo) at `at`. */
export function osloWeekdayAndMinutes(at: Date): { day: Weekday; minutes: number } {
  const parts = OSLO_CLOCK.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: weekdayOf(part("weekday").toLowerCase()) ?? 0,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

/**
 * Whether the producer is open at `at` in Norway, and the entry that says so
 * (the one open now, else the first for today). Only entries with weekdays,
 * two different clock times and no period count: an entry for "Påske",
 * "Varierer" or "Mai–September", or a text entry, cannot say whether it is
 * open on a given day, and neither can equal times ("00:00–00:00" is closed
 * all day to schema.org and open all day elsewhere). null when no entry
 * counts: nothing is claimed then (the front page used to say "Stengt"). A day
 * with no entry is closed. Open from the opening time up to, not including,
 * the closing time; a closing time before the opening time is on the next day
 * (Tromsø Mikrobryggeri, mon 12:00–01:30, is open Tuesday 00:30 on Monday's
 * entry).
 */
export function openingStatusAt(
  entries: readonly OpeningHoursEntry[],
  at: Date,
): { isOpen: boolean; today?: OpeningHoursEntry } | null {
  const timed = entries.flatMap((entry) => {
    if (!entry.days.length || entry.period || entry.open === undefined || entry.close === undefined) return [];
    const open = timeMinutes(entry.open);
    const close = timeMinutes(entry.close);
    return open !== null && close !== null && open !== close ? [{ entry, open, close }] : [];
  });
  if (!timed.length) return null;
  const now = osloWeekdayAndMinutes(at);
  const yesterday = ((now.day + 6) % 7) as Weekday;
  const today = timed.filter((t) => t.entry.days.includes(now.day));
  const openNow =
    today.find((t) => now.minutes >= t.open && (t.close < t.open || now.minutes < t.close)) ??
    timed.find((t) => t.entry.days.includes(yesterday) && t.close < t.open && now.minutes < t.close);
  return { isOpen: !!openNow, today: (openNow ?? today[0])?.entry };
}
