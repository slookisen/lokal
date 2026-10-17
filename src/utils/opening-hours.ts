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
 *
 * Slice I-J (FUNN rfb-apningstider-to-uleste-former) adds the two stored
 * forms I-H left unread, one producer each in live data: schema.org's
 * OpeningHoursSpecification ({dayOfWeek, opens, closes, description,
 * validFrom, validThrough}; Hovdneset Gård had no hours card) and
 * {byAppointment: true, description} (Små Vesen). See storedFormFields().
 *
 * Slice I-O (integration test round 2: SD2-01, SD2-03/AI2-07) adds two rules.
 * An entry with a season note ("Sesongåpent til ca. 20. september", "Åkerbutikk
 * i sommarsesongen") holds only in part of the year, as an entry with a period
 * does: see isSeasonalEntry(). And text in the day-and-time form ("Man-Fre
 * 07-22, Lor 08-22, Son 09-18"; "Fredag 14:00-18:00" as a list entry) is read
 * into day rows: see parseOpeningHoursText().
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
  /** Opening and closing time as text ("10:00", or "10" for a number; "HH:MM" when read from text in the day-and-time form); both are set, or neither. */
  open?: string;
  close?: string;
  /** The season the entry is limited to ("Mai–September"), as stored; for schema.org's form, its validity in Norwegian dates ("1.7.–31.10.2026"). */
  period?: string;
  /**
   * The first and last day of the period as ISO dates ("2026-07-01"), for
   * JSON-LD's validFrom/validThrough: set only for schema.org's form, when
   * both are days in the calendar and the first is not after the last. Both
   * are set, or neither.
   */
  validFrom?: string;
  validThrough?: string;
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
 * nynorsk names in live data ("Måndag", "Tysdag", "Laurdag"). Slice I-O: ø
 * written as "oe" too ("Tor-Soen 12:00-21:00", live 2026-10-17).
 */
const WEEKDAY_ALIASES: ReadonlyMap<string, Weekday> = new Map<string, Weekday>([
  ["mon", 0], ["tue", 1], ["wed", 2], ["thu", 3], ["fri", 4], ["sat", 5], ["sun", 6],
  ["monday", 0], ["tuesday", 1], ["wednesday", 2], ["thursday", 3], ["friday", 4], ["saturday", 5], ["sunday", 6],
  ["man", 0], ["tir", 1], ["ons", 2], ["tor", 3], ["tors", 3], ["fre", 4],
  ["lør", 5], ["lor", 5], ["loer", 5], ["søn", 6], ["son", 6], ["soen", 6],
  ["mandag", 0], ["tirsdag", 1], ["onsdag", 2], ["torsdag", 3], ["fredag", 4],
  ["lørdag", 5], ["lordag", 5], ["loerdag", 5], ["søndag", 6], ["sondag", 6], ["soendag", 6],
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

// ─── schema.org's form and the byAppointment form (slice I-J) ─────────

/**
 * The note of an entry with byAppointment: true. Norwegian, like "Stengt":
 * notes are shown as stored in every page language.
 */
const BY_APPOINTMENT_NOTE = "Etter avtale";

/** Text that says so already ("Åpent etter avtale — ring først"), so "Etter avtale" is not said twice. */
const SAYS_BY_APPOINTMENT = /etter avtale|by appointment/i;

/** A day as schema.org's DayOfWeek URI: "https://schema.org/Friday" (or http) is "Friday". */
const SCHEMA_ORG_URI = /^https?:\/\/schema\.org\//i;

/** dayOfWeek as day names, one or a list: a schema.org URI is its name; a value that is not text as it is. */
function dayOfWeekNames(value: unknown): unknown {
  const name = (v: unknown) => (typeof v === "string" ? v.trim().replace(SCHEMA_ORG_URI, "") : v);
  return Array.isArray(value) ? value.map(name) : name(value);
}

/** An ISO date ("2026-07-01") that is a day in the calendar, as its parts; null for anything else ("2026-02-30", "juli"). */
function isoDateParts(value: unknown): { iso: string; year: number; month: number; day: number } | null {
  if (typeof value !== "string") return null;
  const iso = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const inCalendar = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return inCalendar ? { iso, year, month, day } : null;
}

/**
 * validFrom/validThrough as the entry's period in Norwegian dates:
 * "1.7.–31.10.2026" within one year, "1.11.2026–31.3.2027" across a new
 * year, "1.7.2026" for one day, "fra 1.7.2026" or "til 31.10.2026" for one
 * end. A value that is not an ISO date is shown as written ("juli–oktober"),
 * and so are dates out of order. validFrom/validThrough are the two ISO
 * dates, set only when both are dates and in order: JSON-LD states no other
 * case (see seo.ts).
 */
function validityPeriod(from: unknown, through: unknown): { text: string; validFrom?: string; validThrough?: string } {
  const a = isoDateParts(from);
  const b = isoDateParts(through);
  const date = (p: { year: number; month: number; day: number }, withYear = true) => `${p.day}.${p.month}.${withYear ? p.year : ""}`;
  if (a && b && a.iso <= b.iso) {
    const text = a.iso === b.iso ? date(a) : `${date(a, a.year !== b.year)}–${date(b)}`;
    return { text, validFrom: a.iso, validThrough: b.iso };
  }
  const asWritten = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const fromText = a ? date(a) : asWritten(from);
  const throughText = b ? date(b) : asWritten(through);
  if (fromText && throughText) return { text: `${fromText}–${throughText}` };
  if (fromText) return { text: `fra ${fromText}` };
  return { text: throughText ? `til ${throughText}` : "" };
}

/**
 * An entry in one of the two stored forms that have keys of their own, in
 * the keys normalizeEntry reads; any other entry as it is. Their keys are
 * read only in their form, so every form read before I-J reads exactly as
 * before.
 * - schema.org's OpeningHoursSpecification, an entry with dayOfWeek
 *   (Hovdneset Gård, live 2026-10-17: {dayOfWeek: "Friday", opens: "12:00",
 *   closes: "17:00", description: "Grønnsakstor på Rena torg – …",
 *   validFrom: "2026-07-01", validThrough: "2026-10-31"}): dayOfWeek (a name
 *   or a URI, or a list of them) is the days, opens/closes the times,
 *   description the note and validFrom/validThrough the period.
 * - byAppointment: true (Små Vesen: {description: "Utsalet i bryggeriet er
 *   ope på førespurnad – …", byAppointment: true}): the note "Etter avtale"
 *   and the description, shown as {day: "by-appointment", note} is (the text,
 *   no day). "Etter avtale" is left out when the text says so already. Only
 *   the JSON value true counts.
 */
function storedFormFields(h: Record<string, unknown>): { fields: Record<string, unknown>; validFrom?: string; validThrough?: string } {
  let fields = h;
  let validity: ReturnType<typeof validityPeriod> = { text: "" };
  if (field(h, "dayOfWeek") !== undefined) {
    validity = validityPeriod(h.validFrom, h.validThrough);
    fields = { days: dayOfWeekNames(h.dayOfWeek), open: h.opens, close: h.closes, note: h.description, period: validity.text };
  }
  if (h.byAppointment === true) {
    const texts = [h.description, fields.note].filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim());
    const text = [...new Set(texts)].join("; ");
    fields = { ...fields, note: SAYS_BY_APPOINTMENT.test(text) ? text : [BY_APPOINTMENT_NOTE, text].filter(Boolean).join("; ") };
  }
  return { fields, validFrom: validity.validFrom, validThrough: validity.validThrough };
}

/** One entry (not text) in the fixed shape, or null when it says nothing usable. */
function normalizeEntry(item: unknown): OpeningHoursEntry | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const { fields: h, validFrom, validThrough } = storedFormFields(item as Record<string, unknown>);
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
  if (validFrom && validThrough) { entry.validFrom = validFrom; entry.validThrough = validThrough; }
  if (notes.length) entry.note = [...new Set(notes)].join("; ");
  return entry;
}

// ─── Text in the day-and-time form (slice I-O) ─────────────────────────

/** "Man-Fre 07-22", "Lørdag 11:00-15:00", "onsdag - søndag 11:00–17:00": a day label, a space, one time range. */
const TEXT_DAYS_HOURS = /^(.+?)\s+(\d{1,2}(?:[:.]\d{2})?)\s*[-–—]\s*(\d{1,2}(?:[:.]\d{2})?)$/;
/** "Søn stengt", "Fre-Søn stengt": a day label, a space, one word (a word for closed, see CLOSED_WORDS). */
const TEXT_DAYS_ONE_WORD = /^(.+?)\s+(\S+)$/;
/**
 * A part longer than this is not read: the longest part in the form in live
 * data 2026-10-17 has 26 characters ("Torsdag-Fredag 12:00-19:00"). It also
 * bounds the work of the two patterns above, which backtrack in quadratic
 * time on a long run of spaces (20 000 spaces took 0.4 s without it).
 */
const TEXT_PART_MAX = 64;

/**
 * Text in the day-and-time form as day rows, or null when it is not in that
 * form. Integration test round 2, SD2-03/AI2-07: Hevd Håndverksbakeri stores
 * the field as "Man-Fre 07-22, Lor 08-22, Son 09-18", Alm Østre Gård as the
 * list ["Fredag 14:00-18:00", "Lørdag 11:00-15:00"]; as text they had no day
 * rows, no "today" and no JSON-LD. The form is one or more parts separated
 * by commas, each a day label the day tables read (a day, a range or "every
 * day"; "Lor"/"Son" are Saturday/Sunday) and then either a time range
 * ("07-22", "11:00 – 15:00", "9.30-17") or a word for a closed day ("Søn
 * stengt", five producers in live data 2026-10-17). A time range is the
 * declared form's {day, open, close} with clock times as "HH:MM" ("07" is
 * "07:00"); a closed day is the note "Stengt", as {day, hours: "Stengt"} is.
 * Every part must be in the form, or the text is not read at all: it is
 * shown as text, as before, so a qualifier ("Man-Lør 12-17 (sommer)",
 * "lørdag 13:00–15:00 eller etter avtale", "Restaurant: Man-Lør 11-00") is
 * never lost, and no part is guessed.
 */
export function parseOpeningHoursText(value: string): OpeningHoursEntry[] | null {
  const entries: OpeningHoursEntry[] = [];
  for (const part of value.split(",").map((p) => p.trim())) {
    if (part.length > TEXT_PART_MAX) return null;
    const timed = TEXT_DAYS_HOURS.exec(part);
    if (timed) {
      const days = parseDayLabel(timed[1]!);
      const open = clockTime(timed[2]!);
      const close = clockTime(timed[3]!);
      if (!days || open === null || close === null) return null;
      entries.push({ days, label: timed[1]!, open, close });
      continue;
    }
    const closed = TEXT_DAYS_ONE_WORD.exec(part);
    const days = closed && isClosedWord(closed[2]!) ? parseDayLabel(closed[1]!) : null;
    if (!closed || !days) return null;
    entries.push({ days, label: closed[1]!, note: CLOSED_NOTE });
  }
  return entries;
}

/** A text (an entry, or the whole field) as entries: its day rows when it is in the day-and-time form, else one text entry; none when blank. */
function textEntriesOf(value: string): OpeningHoursEntry[] {
  const text = value.trim();
  if (!text) return [];
  return parseOpeningHoursText(text) ?? [{ days: [], label: "", note: text }];
}

/**
 * The opening hours in one shape, in stored order. A list gives one entry per
 * item that says something: both times (text, or numbers as their digits),
 * or a note or text. An item with only one time, or nothing usable, is left
 * out (it showed as "undefined" before I-G). Text, as a list item or as the
 * whole field, gives its day rows when it is in the day-and-time form ("Man–fre
 * 10–17, lør 10–14"; slice I-O, parseOpeningHoursText), else one text entry
 * ("Etter avtale"). Anything else has no entries.
 */
export function normalizeOpeningHours(value: unknown): OpeningHoursEntry[] {
  if (typeof value === "string") return textEntriesOf(value);
  if (!Array.isArray(value)) return [];
  const entries: OpeningHoursEntry[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      entries.push(...textEntriesOf(item));
      continue;
    }
    const entry = normalizeEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ─── Seasons (slice I-O) ───────────────────────────────────────────────

/**
 * The words that make a note a season note: the configuration of
 * isSeasonNote(), lower case, matched anywhere in the note in any case, so
 * Norwegian compounds count ("Sesongåpent", "sommarsesongen", "Høgsesong",
 * "Vinteråpningstid"). Integration test round 2, SD2-01: Bjørke Gård
 * ({days: "onsdag - søndag", hours: "11:00-17:00", note: "Sesongåpent til ca.
 * 20. september"}) and Hima Grønt ({day: "sat", …, note: "Åkerbutikk i
 * sommarsesongen"}) had year-round OpeningHoursSpecification in October, and
 * lokal_info left the note out. Of the 29 different notes on timed entries
 * in live data 2026-10-17 the list finds the 11 about a season (10
 * producers) and none of the others ("Selvbetjent 24/7", "Åpent året rundt
 * og døgnet rundt", "Søndag stengt", "Annankvar torsdag (partalsveker)",
 * "Utlevering skjer på avtalt tid og sted. …"). The words are the seasons
 * in bokmål, nynorsk and English, except spring: "vår" is also "our" ("vår
 * gårdsbutikk"). Months are not on the list: a month in a note can be a
 * closure ("Stengt 24.–26. desember"), not a season. Add a word here, with
 * a test, to read more notes as seasons.
 */
export const SEASON_NOTE_WORDS: readonly string[] = [
  "sesong", "season",
  "sommer", "sommar", "summer",
  "høst", "haust", "autumn",
  "vinter", "winter",
];

/** Whether a note is about a season (SEASON_NOTE_WORDS). */
export function isSeasonNote(note: string | undefined): boolean {
  const text = (note ?? "").toLowerCase();
  return !!text && SEASON_NOTE_WORDS.some((word) => text.includes(word));
}

/**
 * Whether an entry holds only in part of the year: it has a period ("Mai–
 * September", I-H), or a season note (slice I-O). Such an entry cannot say
 * whether it holds today: it counts for no "open now" claim and no "today"
 * highlight, and goes into JSON-LD only with validity dates (seo.ts).
 */
export function isSeasonalEntry(entry: OpeningHoursEntry): boolean {
  return !!entry.period || isSeasonNote(entry.note);
}

// ─── Compact text (lokal_info and the auto-reply) ──────────────────────

/**
 * One entry as text: "Man 10:00–17:00", "Man–Fre 09:00–18:00", "Tor–Fre
 * 12:00–16:00 (April)", "Man: Stengt", "Hele året: Åpent ved bestilling" or
 * the text itself. A day label that names no weekday is shown as written. A
 * note on an entry with times is left out, as lokal_info and the auto-reply
 * did before; the period is not, since the times hold only in it, and
 * neither is a season note (slice I-O: "Ons–Søn 11:00–17:00 (Sesongåpent til
 * ca. 20. september)"; it said "Ons–Søn 11:00–17:00", as if all year).
 */
export function openingHoursEntryText(entry: OpeningHoursEntry): string {
  const day = entry.days.length ? weekdaysLabel(entry.days, WEEKDAY_SHORT_NO, "/") : entry.label;
  if (entry.open !== undefined && entry.close !== undefined) {
    const qualifier = [entry.period, isSeasonNote(entry.note) ? entry.note : ""].filter(Boolean).join("; ");
    const period = qualifier ? ` (${qualifier})` : "";
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
 * two different clock times and no period or season note (isSeasonalEntry)
 * count: an entry for "Påske", "Varierer", "Mai–September" or "Sesongåpent
 * til ca. 20. september", or a text entry, cannot say whether it is
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
    if (!entry.days.length || isSeasonalEntry(entry) || entry.open === undefined || entry.close === undefined) return [];
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
