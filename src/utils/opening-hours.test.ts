/**
 * opening-hours.test.ts — dev-request 2026-10-17-integrasjonstest-oppfolging,
 * slice I-H (FUNN rfb-apningstider-alternative-former and
 * rfb-isopennow-lange-dagnavn from the lokal#1114 review).
 *
 * Pure tests of utils/opening-hours.ts, the one reading of
 * agent_knowledge.opening_hours that the producer page, the front page's
 * "open now", lokal_info and the A2A auto-reply share:
 *   (a) parseDayLabel: English and Norwegian (bokmål, nynorsk, ASCII) day
 *       names, short and long, any case; ranges with -, – or — and spaces,
 *       wrapping over the weekend; "every day"; labels with a qualifier,
 *       half-known ranges and Object.prototype names name no weekday.
 *   (b) weekdaysLabel: a day, a run (also over the weekend), all seven, a list.
 *   (c) normalizeOpeningHours: every stored form the spec names, and the
 *       others found in live data 2026-10-17 ({note}, {days, hours, note},
 *       {days, note}, {day: "note", open: <text>}); "closed"/"stengt" in a
 *       time field is a closed day ("Stengt"); a lone time, wrong types and
 *       junk are left out; the declared form keeps its text.
 *   (d) the compact text of lokal_info and the auto-reply: the declared form
 *       as before ("Man 10:00–17:00", note left out), the other forms read;
 *       "; " between entries when one has a comma of its own.
 *   (e) the day and time in Norway (Europe/Oslo), across midnight and the
 *       summer-time change; clock times as minutes and as "HH:MM".
 *   (f) openingStatusAt: long and Norwegian day names and ranges are matched
 *       (Kringler Gjestegård, monday…saturday, said "Stengt" on Saturday
 *       noon); closing time is exclusive; split hours; hours past midnight
 *       (Tromsø and Trondhjem Mikrobryggeri, 12:00–01:30) count on the next
 *       day; entries that cannot say whether it is open (no weekday, a period,
 *       text, a time that is not a clock time, equal times) give no claim.
 *   (g) the producers of the review's live sample whose hours the page, or
 *       lokal_info and the auto-reply, did not show (their stored values,
 *       2026-10-17): each now has entries with its days and times or text.
 *   (h) slice I-J (FUNN rfb-apningstider-to-uleste-former): schema.org's
 *       form ({dayOfWeek, opens, closes, description, validFrom,
 *       validThrough}; Hovdneset Gård) and {byAppointment: true,
 *       description} (Små Vesen), with their live values: dayOfWeek as a
 *       name, a URI or a list; validity as Norwegian dates, ISO dates kept
 *       only when both are dates in order; "Etter avtale" not said twice;
 *       neither gives an "open now" claim. Their keys are read only in their
 *       form: outside it an entry reads as before I-J.
 *   (i) slice I-O (integration test round 2: SD2-01, SD2-03/AI2-07): text in
 *       the day-and-time form ("Man-Fre 07-22, Lor 08-22, Son 09-18", Hevd;
 *       ["Fredag 14:00-18:00", "Lørdag 11:00-15:00"], Alm Østre) is read
 *       into day rows with "HH:MM" times, a closed day too ("Søn stengt");
 *       any part outside the form keeps the whole text as text. A season
 *       note (SEASON_NOTE_WORDS: Bjørke Gård, Hima Grønt and the other live
 *       notes) makes an entry seasonal like a period: no "open now" claim,
 *       and the note is in the compact text; other notes are not.
 *
 * Exported runOpeningHoursTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/utils/opening-hours.test.ts
 */

import {
  normalizeOpeningHours,
  parseOpeningHoursText,
  parseDayLabel,
  weekdaysLabel,
  entryDaysLabel,
  openingHoursEntryText,
  openingHoursText,
  osloWeekdayAndMinutes,
  openingStatusAt,
  isSeasonNote,
  isSeasonalEntry,
  SEASON_NOTE_WORDS,
  timeMinutes,
  clockTime,
  WEEKDAY_NAMES,
  type OpeningHoursEntry,
} from "./opening-hours";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runOpeningHoursTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
      if (log) console.log(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }
  const WEEK = [0, 1, 2, 3, 4, 5, 6];

  // ══ (a) parseDayLabel ════════════════════════════════════════════════
  {
    const one: Array<[string, number]> = [
      ["mon", 0], ["sat", 5], ["sun", 6], ["monday", 0], ["Saturday", 5], ["SUNDAY", 6], ["  friday ", 4],
      ["man", 0], ["tir", 1], ["ons", 2], ["tor", 3], ["tors", 3], ["fre", 4], ["lør", 5], ["lor", 5], ["søn", 6], ["son", 6],
      ["Mandag", 0], ["tirsdag", 1], ["Onsdag", 2], ["Torsdag", 3], ["Fredag", 4], ["Lørdag", 5], ["lordag", 5], ["Søndag", 6], ["sondag", 6],
      ["Måndag", 0], ["Tysdag", 1], ["Laurdag", 5], ["man.", 0],
    ];
    for (const [label, day] of one) assertEq(parseDayLabel(label), [day], `a day: ${JSON.stringify(label)} is weekday ${day}`);
    const ranges: Array<[string, number[]]> = [
      ["mon-fri", [0, 1, 2, 3, 4]], ["mon-sun", WEEK], ["sat-sun", [5, 6]], ["mon-sat", [0, 1, 2, 3, 4, 5]],
      ["Man-fre", [0, 1, 2, 3, 4]], ["Man–tors", [0, 1, 2, 3]], ["Man-lør", [0, 1, 2, 3, 4, 5]],
      ["Mandag-Fredag", [0, 1, 2, 3, 4]], ["Mandag–fredag", [0, 1, 2, 3, 4]], ["Tysdag-Onsdag", [1, 2]],
      ["Fredag-Laurdag", [4, 5]], ["Måndag–Laurdag", [0, 1, 2, 3, 4, 5]], ["Torsdag–Fredag", [3, 4]],
      ["onsdag - søndag", [2, 3, 4, 5, 6]], ["Fre — Man", [0, 4, 5, 6]], ["tue-mon", WEEK], ["sat-sat", [5]],
    ];
    for (const [label, days] of ranges) assertEq(parseDayLabel(label), days, `a range: ${JSON.stringify(label)}`);
    for (const label of ["Daglig", "dagleg", "daily", "all", "Hver dag", "alle dager"]) {
      assertEq(parseDayLabel(label), WEEK, `a every day: ${JSON.stringify(label)}`);
    }
    for (const label of ["", "   ", "Varierer", "Påske", "summer", "Hele året", "Lørdag (vinter)", "Man–fre (vinter)",
      "Dagleg (sommar)", "Jun–aug (ons–søn)", "Fre–lør (sesong)", "Lørdag i sesong", "Juli-august", "mon-xyz", "xyz-fri",
      "mon-fri-sun", "1", "note", "constructor", "toString", "__proto__", "hasOwnProperty-valueOf"]) {
      assertEq(parseDayLabel(label), null, `a none: ${JSON.stringify(label)} names no weekday`);
    }
  }

  // ══ (b) weekdaysLabel ════════════════════════════════════════════════
  {
    const no = WEEKDAY_NAMES.no;
    assertEq(weekdaysLabel([5], no), "Lørdag", "b label: one day");
    assertEq(weekdaysLabel([0, 1, 2, 3, 4], no), "Mandag–Fredag", "b label: a run");
    assertEq(weekdaysLabel([5, 6], WEEKDAY_NAMES.en), "Saturday–Sunday", "b label: a run, English");
    assertEq(weekdaysLabel([0, 4, 5, 6], no), "Fredag–Mandag", "b label: a run over the weekend keeps its order");
    assertEq(weekdaysLabel([6, 0], WEEKDAY_NAMES.sv), "Söndag–Måndag", "b label: Sunday–Monday, Swedish");
    assertEq(weekdaysLabel(WEEK as any, no), "Mandag–Søndag", "b label: all seven days");
    assertEq(weekdaysLabel([0, 2, 4], no), "Mandag, Onsdag, Fredag", "b label: days that are not one run are a list");
    assertEq(weekdaysLabel([0, 2], ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"], "/"), "Man/Ons", "b label: list separator");
    assertEq(weekdaysLabel([], no), "", "b label: no days");
  }

  // ══ (c) normalizeOpeningHours ════════════════════════════════════════
  {
    const n = normalizeOpeningHours;
    assertEq(n([{ day: "mon", open: "10:00", close: "17:00" }, { day: "sat", open: "10:00", close: "14:00", note: "Kun i sesong" }]), [
      { days: [0], label: "mon", open: "10:00", close: "17:00" },
      { days: [5], label: "sat", open: "10:00", close: "14:00", note: "Kun i sesong" },
    ], "c declared form: {day, open, close} and a note keep their text");
    assertEq(n([{ day: "monday", open: "10:00", close: "17:00" }, { day: "Lørdag", open: "10:00", close: "15:00" }]), [
      { days: [0], label: "monday", open: "10:00", close: "17:00" },
      { days: [5], label: "Lørdag", open: "10:00", close: "15:00" },
    ], "c day names: long English and Norwegian are weekdays");
    assertEq(n([{ day: "Fredag", hours: "11:00-16:00" }, { day: "Mandag", hours: "Stengt" }, { day: "Søndag", hours: " 12.00 – 18.00 " }]), [
      { days: [4], label: "Fredag", open: "11:00", close: "16:00" },
      { days: [0], label: "Mandag", note: "Stengt" },
      { days: [6], label: "Søndag", open: "12.00", close: "18.00" },
    ], "c {day, hours}: a time range is the two times; other text is a note");
    assertEq(n([{ day: "Lørdag", hours: "10:00-12:00, 14:00-16:00" }]), [{ days: [5], label: "Lørdag", note: "10:00-12:00, 14:00-16:00" }],
      "c {day, hours}: more than one range is kept as text, not guessed");
    assertEq(n([{ day: "Man–tors", from: "09:00", to: "16:30" }]), [{ days: [0, 1, 2, 3], label: "Man–tors", open: "09:00", close: "16:30" }],
      "c {day, from, to}: from and to are the times");
    assertEq(n([{ period: "Mai–September", days: "Måndag–Laurdag", open: "12:00", close: "16:00" }]),
      [{ days: [0, 1, 2, 3, 4, 5], label: "Måndag–Laurdag", open: "12:00", close: "16:00", period: "Mai–September" }],
      "c {period, days, open, close}: days as text, the period kept");
    assertEq(n([{ days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "08:00", close: "18:00" }, { days: ["Saturday"], open: "09:00", close: "18:00" }]), [
      { days: [0, 1, 2, 3, 4], label: "Monday, Tuesday, Wednesday, Thursday, Friday", open: "08:00", close: "18:00" },
      { days: [5], label: "Saturday", open: "09:00", close: "18:00" },
    ], "c {days, open, close}: days as a list of names");
    assertEq(n([{ days: ["Monday", "Påske"], open: "08:00", close: "18:00" }]), [{ days: [], label: "Monday, Påske", open: "08:00", close: "18:00" }],
      "c {days: [...]}: a list with a name that is no weekday names none (shown as written)");
    assertEq(n([{ days: "Torsdag", open: "13:00", close: "18:00" }]), [{ days: [3], label: "Torsdag", open: "13:00", close: "18:00" }],
      "c {days, open, close}: days as one day");
    assertEq(n([{ day: "Hele året", note: "Åpent ved bestilling og annonserte kafédager" }]),
      [{ days: [], label: "Hele året", note: "Åpent ved bestilling og annonserte kafédager" }], "c {day, note}: a label that is no weekday stays");
    assertEq(n([{ day: "by-appointment", note: "Åpent etter avtale — ring eller send SMS" }]),
      [{ days: [], label: "", note: "Åpent etter avtale — ring eller send SMS" }], "c {day: by-appointment, note}: the marker is not a label");
    assertEq(n([{ day: "note", open: "1. juli - 31. juli: Mandag-søndag 09:00-16:00" }]),
      [{ days: [], label: "", note: "1. juli - 31. juli: Mandag-søndag 09:00-16:00" }], "c {day: note, open: <text>}: text in a time field is a note");
    assertEq(n([{ note: "Selvbetjent gardsbutikk, åpen hele året (Vipps-betaling)" }]),
      [{ days: [], label: "", note: "Selvbetjent gardsbutikk, åpen hele året (Vipps-betaling)" }], "c {note}: a note alone is a text entry");
    assertEq(n([{ days: "onsdag - søndag", hours: "11:00-17:00", note: "Sesongåpent til ca. 20. september" }]),
      [{ days: [2, 3, 4, 5, 6], label: "onsdag - søndag", open: "11:00", close: "17:00", note: "Sesongåpent til ca. 20. september" }],
      "c {days, hours, note}");
    assertEq(n([{ days: "Torsdag–Fredag", note: "Ferskt kjøtt til salgs i gårdsbutikken" }]),
      [{ days: [3, 4], label: "Torsdag–Fredag", note: "Ferskt kjøtt til salgs i gårdsbutikken" }], "c {days, note}");
    assertEq(n([{ day: "Varierer", open: "16:00", close: "17:00", note: "Utlevering skjer på avtalt tid og sted." }]),
      [{ days: [], label: "Varierer", open: "16:00", close: "17:00", note: "Utlevering skjer på avtalt tid og sted." }],
      "c a label that is no weekday keeps its times");
    // "closed" in the time fields (Aarsland Gårdsutsalg, Havens Kolonial, The ODD Bakery, Haugli Bakeri, live 2026-10-17).
    assertEq(n([{ day: "sun", open: "closed", close: "closed" }, { day: "mon", open: " Closed ", close: "closed" }]), [
      { days: [6], label: "sun", note: "Stengt" },
      { days: [0], label: "mon", note: "Stengt" },
    ], "c closed: \"closed\" as both times is a closed day, the note \"Stengt\" (main: \"closed – closed\")");
    assertEq(n([{ day: "tue", open: "stengt" }, { day: "wed", close: "Stengd" }, { day: "Mandag", hours: "stengt" }, { day: "sun", open: "closed", close: "closed", note: "Stengt" }]), [
      { days: [1], label: "tue", note: "Stengt" },
      { days: [2], label: "wed", note: "Stengt" },
      { days: [0], label: "Mandag", note: "Stengt" },
      { days: [6], label: "sun", note: "Stengt" },
    ], "c closed: \"stengt\"/\"stengd\" alone in a time or hours field too; the note is not repeated");
    assertEq(n([{ day: "thu", open: "10:00", close: "closed" }]), [{ days: [3], label: "thu", open: "10:00", close: "closed" }],
      "c closed: beside a time it is not read as a closed day (kept as written, not guessed)");
    assertEq(n([{ day: "mon-fri", open: 10, close: 17 }, { day: "sun", open: 0, close: 24 }]), [
      { days: [0, 1, 2, 3, 4], label: "mon-fri", open: "10", close: "17" },
      { days: [6], label: "sun", open: "0", close: "24" },
    ], "c number times are their digits");
    assertEq(n(["  Lørdag etter avtale ", "", "  "]), [{ days: [], label: "", note: "Lørdag etter avtale" }], "c a text entry is trimmed; blank ones are left out");
    // I-O: text in the day-and-time form is read into day rows (section i);
    // other text is still one text entry.
    assertEq(n("  Man–fre 10–17, lør etter avtale  "), [{ days: [], label: "", note: "Man–fre 10–17, lør etter avtale" }],
      "c free text for the whole field that is not all in the day-and-time form is one text entry, not parsed");
    assertEq(n([
      { day: "sat", open: "10:00" }, { day: "sat", close: "14:00" }, { day: "sat", open: 10 },
      { day: "wed", open: { h: 10 }, close: "17:00" }, { day: "thu", open: "10:00", close: [17] },
      { day: "fri", open: " ", close: "17:00" }, { day: "mon", open: Infinity, close: "17:00" },
      { day: "tue", closed: true }, { day: "sun", open: "", close: "" }, { day: "mon" }, { day: "mon", hours: "  " },
      { period: "April" }, { note: "   " }, { note: 5 }, { hours: { open: "10" } },
      null, undefined, 5, true, "", [{ day: "mon", open: "10:00", close: "17:00" }],
    ]), [], "c a lone time, wrong types and junk say nothing and are left out");
    assertEq(n([{ day: 3, open: "10:00", close: "17:00", note: { x: 1 } }, { day: { d: "mon" }, hours: "10-12" }]), [
      { days: [], label: "", open: "10:00", close: "17:00" },
      { days: [], label: "", open: "10", close: "12" },
    ], "c a day or note that is not text counts as none; the times stay");
    for (const v of [null, undefined, 42, true, { mon: "10-17" }, "", "   "]) {
      assertEq(n(v), [], `c ${JSON.stringify(v) ?? "undefined"} has no entries`);
    }
    // A JSON object's own keys only: names of Object.prototype members are never read as a field.
    const parsed = JSON.parse('[{"day":"constructor","open":"08:00","close":"09:00"},{"__proto__":{"open":"10:00","close":"11:00"},"day":"mon"}]');
    assertEq(n(parsed), [{ days: [], label: "constructor", open: "08:00", close: "09:00" }],
      "c a day named like an Object.prototype member is a label; a __proto__ key gives no times");
  }

  // ══ (d) compact text: lokal_info and the auto-reply ══════════════════
  {
    const text = (v: unknown) => openingHoursText(v);
    assertEq(text([{ day: "mon", open: "10:00", close: "17:00" }, { day: "saturday", open: "10:00", close: "14:00", note: "Kun selvbetjening" }, { day: "Lørdag i sesong", open: "11:00", close: "15:00" }]),
      "Man 10:00–17:00, Lør 10:00–14:00, Lørdag i sesong 11:00–15:00",
      "d declared form as before: short day, the note left out, an unknown label as written");
    assertEq(text([{ day: "mon", open: "10:00", close: "17:00" }, { day: "saturday", open: "10:00", close: "14:00", note: "Kun i sesong" }]),
      "Man 10:00–17:00, Lør 10:00–14:00 (Kun i sesong)",
      "d I-O: a season note is shown with the times it limits (main: \"Lør 10:00–14:00\", as if all year)");
    assertEq(text([{ day: "Mandag-Fredag", hours: "10:00-19:00" }, { day: "Lørdag", hours: "11:00-18:00" }, { day: "Mandag", hours: "Stengt" }]),
      "Man–Fre 10:00–19:00, Lør 11:00–18:00, Man: Stengt", "d {day, hours}: a range of days, a day, a closed day");
    assertEq(text([{ period: "April", days: "Torsdag–Fredag", open: "12:00", close: "16:00" }]), "Tor–Fre 12:00–16:00 (April)",
      "d a period is shown with the times it limits");
    assertEq(text([{ days: ["Monday", "Wednesday"], open: "08:00", close: "18:00" }]), "Man/Ons 08:00–18:00", "d days that are not one run");
    assertEq(text([{ day: "daily", open: "09:00", close: "21:00", note: "Sjølvbetent" }]), "Man–Søn 09:00–21:00", "d every day");
    assertEq(text([{ day: "Hele året", note: "Åpent ved bestilling" }, { day: "by-appointment", note: "Ring først" }, { note: "Etter avtale" }, " Lør etter avtale "]),
      "Hele året: Åpent ved bestilling, Ring først, Etter avtale, Lør etter avtale", "d notes and text entries");
    assertEq(text([{ days: "Torsdag", period: "Sommer", note: "Kun bestilling" }]), "Tor: Sommer; Kun bestilling", "d a period and a note without times");
    assertEq(text([{ open: "09:00", close: "12:00" }, { day: 1, open: 10, close: 17 }]), "09:00–12:00, 10–17", "d no day: just the times");
    assertEq(text("  Man–fre 10–17 (sommer)  "), "Man–fre 10–17 (sommer)", "d free text for the whole field that is not in the day-and-time form, trimmed");
    assertEq(text("  Man–fre 10–17  "), "Man–Fre 10:00–17:00", "d I-O: free text in the day-and-time form is its days and times (main: \"Man–fre 10–17\")");
    assertEq(text([{ day: "sun", open: "closed", close: "closed" }, { day: "mon", open: "10:00", close: "17:00" }]), "Søn: Stengt, Man 10:00–17:00",
      "d a closed day is \"Stengt\" (main: \"Søn closed–closed\")");
    // Ål Markedshage (live 2026-10-17): its notes have commas of their own.
    assertEq(text([{ note: "Boden (selvbetjent): uke 20-41, døgnåpen" }, { day: "Lørdag", open: "11:00", close: "15:00", note: "Stabbursbutikken i sesong" }, { note: "Julebutikk: fra uke 42, lør 11-15, tor 17-20" }]),
      "Boden (selvbetjent): uke 20-41, døgnåpen; Lør 11:00–15:00 (Stabbursbutikken i sesong); Julebutikk: fra uke 42, lør 11-15, tor 17-20",
      "d an entry with a comma of its own: \"; \" between the entries, so each one's end is clear (I-O: the season note with its times)");
    assertEq(text([{ day: "Lørdag", hours: "10:00-12:00, 14:00-16:00" }, { day: "sun", open: "12:00", close: "15:00" }]), "Lør: 10:00-12:00, 14:00-16:00; Søn 12:00–15:00",
      "d two ranges kept as text in one entry: \"; \" between the entries");
    assertEq([text(null), text([]), text({}), text(7), text([null, {}, "  "])], ["", "", "", "", ""], "d nothing usable gives no text");
    const nine = Array.from({ length: 9 }, (_, i) => ({ day: "mon", open: `0${i}:00`, close: "17:00" }));
    assertEq(openingHoursText([null, ...nine], 7).split(", ").length, 7, "d max: at most that many entries; unusable ones take no slot");
    const entry: OpeningHoursEntry = { days: [], label: "constructor", open: "08:00", close: "09:00" };
    assertEq(openingHoursEntryText(entry), "constructor 08:00–09:00", "d an Object.prototype name as label is shown as written");
    assertEq(entryDaysLabel({ days: [5], label: "Lørdag" }, "en"), "Saturday", "d page label: a Norwegian day in English");
    assertEq(entryDaysLabel({ days: [], label: "Påske" }, "en"), "Påske", "d page label: no weekday, as written");
  }

  // ══ (e) the day and time in Norway ═══════════════════════════════════
  {
    const at = (iso: string) => osloWeekdayAndMinutes(new Date(iso));
    assertEq(at("2026-10-17T10:00:00Z"), { day: 5, minutes: 12 * 60 }, "e summer time: Saturday 10:00Z is 12:00 in Oslo");
    assertEq(at("2026-10-17T22:30:00Z"), { day: 6, minutes: 30 }, "e summer time: Saturday 22:30Z is already Sunday 00:30 in Oslo");
    assertEq(at("2026-10-25T23:30:00Z"), { day: 0, minutes: 30 }, "e winter time after the change: Sunday 23:30Z is Monday 00:30");
    assertEq(at("2026-01-06T22:59:00Z"), { day: 1, minutes: 23 * 60 + 59 }, "e winter time: Tuesday 22:59Z is 23:59 in Oslo");
    assertEq(at("2026-01-06T23:00:00Z"), { day: 2, minutes: 0 }, "e winter time: midnight is 0 minutes, not 24:00");
    assertEq([timeMinutes("10"), timeMinutes("10:30"), timeMinutes("10.30"), timeMinutes(" 9:05 "), timeMinutes("24:00"), timeMinutes("0")],
      [600, 630, 630, 545, 1440, 0], "e clock times");
    assertEq([timeMinutes("24:01"), timeMinutes("25"), timeMinutes("10:60"), timeMinutes("<b>10</b>"), timeMinutes("10am"), timeMinutes("")],
      [null, null, null, null, null, null], "e text that is not a clock time");
    assertEq(["09:30", "9", "9:05", "12.00", " 10 ", "0", "24:00", "00:00", "17:30"].map(clockTime),
      ["09:30", "09:00", "09:05", "12:00", "10:00", "00:00", "24:00", "00:00", "17:30"], "e clockTime: \"HH:MM\"; the identity for \"HH:MM\"");
    assertEq(["closed", "Stengt", "10am", "25:00", "10:60", "", "<b>10</b>", "12.00 – 18.00"].map(clockTime),
      [null, null, null, null, null, null, null, null], "e clockTime: none for text that is not a clock time");
  }

  // ══ (f) openingStatusAt ══════════════════════════════════════════════
  {
    const status = (hours: unknown, iso: string) => openingStatusAt(normalizeOpeningHours(hours), new Date(iso));
    const label = (s: ReturnType<typeof status>) => s && { isOpen: s.isOpen, today: s.today ? `${s.today.open}–${s.today.close}` : null };
    // Kringler Gjestegård — Gårdsutsalg, live 2026-10-17 (featured on the front page).
    const kringler = [
      { day: "monday", open: "10:00", close: "17:00" }, { day: "tuesday", open: "10:00", close: "17:00" },
      { day: "wednesday", open: "10:00", close: "17:00" }, { day: "thursday", open: "10:00", close: "17:00" },
      { day: "friday", open: "10:00", close: "17:00" }, { day: "saturday", open: "10:00", close: "15:00" },
    ];
    assertEq(label(status(kringler, "2026-10-17T10:00:00Z")), { isOpen: true, today: "10:00–15:00" },
      "f Kringler: Saturday 12:00 in Oslo is open (main: \"Stengt\", \"saturday\" never matched \"sat\")");
    assertEq(label(status(kringler, "2026-10-14T08:00:00Z")), { isOpen: true, today: "10:00–17:00" }, "f Kringler: Wednesday 10:00 is open");
    assertEq(label(status(kringler, "2026-10-17T13:00:00Z")), { isOpen: false, today: "10:00–15:00" }, "f closing time is exclusive: Saturday 15:00 is closed");
    assertEq(label(status(kringler, "2026-10-17T07:59:00Z")), { isOpen: false, today: "10:00–15:00" }, "f before opening: Saturday 09:59 is closed");
    assertEq(label(status(kringler, "2026-10-18T10:00:00Z")), { isOpen: false, today: null }, "f a day with no entry is closed (Sunday)");
    assertEq(label(status(kringler, "2026-10-17T22:30:00Z")), { isOpen: false, today: null },
      "f the day is Oslo's: Saturday 22:30Z is Sunday in Norway (no entry), not Saturday");
    assertEq(label(status([{ day: "Mandag-Fredag", hours: "09:00-18:00" }, { day: "Lørdag", hours: "09:00-16:00" }], "2026-10-15T13:00:00Z")),
      { isOpen: true, today: "09:00–18:00" }, "f Norwegian range from {day, hours}: Thursday 15:00 is open");
    assertEq(label(status([{ day: "Mandag", hours: "Stengt" }, { day: "Tysdag-Onsdag", hours: "10:00-16:00" }], "2026-10-12T10:00:00Z")),
      { isOpen: false, today: null }, "f a day marked \"Stengt\" (no times) is closed");
    assertEq(label(status([{ day: "mon-sun", open: "00:00", close: "24:00" }], "2026-10-12T21:59:00Z")), { isOpen: true, today: "00:00–24:00" },
      "f mon-sun 00:00–24:00 is open at 23:59");
    assertEq(label(status([{ day: "Daglig", open: "06:00", close: "22:00" }], "2026-10-18T19:00:00Z")), { isOpen: true, today: "06:00–22:00" },
      "f every day: Sunday 21:00 is open");
    const split = [{ day: "sat", open: "10:00", close: "12:00" }, { day: "Lørdag", open: "14:00", close: "16:00" }];
    assertEq(label(status(split, "2026-10-17T13:00:00Z")), { isOpen: true, today: "14:00–16:00" }, "f split hours: open in the second interval, which is shown");
    assertEq(label(status(split, "2026-10-17T11:00:00Z")), { isOpen: false, today: "10:00–12:00" }, "f split hours: closed between them, the first shown");
    assertEq(label(status([{ day: "sat", open: 10, close: 15 }], "2026-10-17T10:00:00Z")), { isOpen: true, today: "10–15" }, "f number times are on the hour");
    for (const [why, hours] of [
      ["only a label that is no weekday", [{ day: "Varierer", open: "16:00", close: "17:00" }]],
      ["only a period", [{ period: "Mai–September", days: "Måndag–Laurdag", open: "00:00", close: "24:00" }]],
      ["only text", ["Lørdag etter avtale", { note: "Etter avtale" }]],
      ["only a number as day", [{ day: 5, open: "00:00", close: "24:00" }]],
      ["only times that are not clock times", [{ day: "sat", open: "<b>10</b>", close: "17:00" }]],
      ["free text for the whole field", "Man–søn 00–24 (sommer)"],
      ["no hours", []],
    ] as Array<[string, unknown]>) {
      assertEq(status(hours, "2026-10-17T10:00:00Z"), null, `f no claim: ${why}`);
    }
    assertEq(label(status([{ day: "Varierer", open: "00:00", close: "24:00" }, { day: "fri", open: "10:00", close: "17:00" }], "2026-10-17T10:00:00Z")),
      { isOpen: false, today: null }, "f an entry that cannot say is ignored beside one that can");

    // Hours past midnight: the closing time is on the next day. Tromsø and
    // Trondhjem Mikrobryggeri, live 2026-10-17 (the review measured "Stengt"
    // at 186 of 476 instants they were open). 2026-10-12 is a Monday; Oslo is
    // UTC+2 until 2026-10-25.
    const tromso = [
      ...["mon", "tue", "wed", "thu"].map((day) => ({ day, open: "12:00", close: "01:30" })),
      { day: "fri", open: "12:00", close: "03:00" }, { day: "sat", open: "12:00", close: "03:00" }, { day: "sun", open: "18:00", close: "01:30" },
    ];
    const trondhjem = [
      { day: "mon", open: "16:00", close: "23:00" }, { day: "tue", open: "16:00", close: "23:00" }, { day: "wed", open: "15:00", close: "23:00" },
      { day: "thu", open: "15:00", close: "23:00" }, { day: "fri", open: "14:00", close: "01:00" }, { day: "sat", open: "12:00", close: "01:00" },
    ];
    for (const [why, hours, iso, expected] of [
      ["Tromsø Monday 19:30 is open (head before: \"Stengt 12:00–01:30\")", tromso, "2026-10-12T17:30:00Z", { isOpen: true, today: "12:00–01:30" }],
      ["Tromsø Monday 12:00, the opening time, is open", tromso, "2026-10-12T10:00:00Z", { isOpen: true, today: "12:00–01:30" }],
      ["Tromsø Monday 11:59 is closed", tromso, "2026-10-12T09:59:00Z", { isOpen: false, today: "12:00–01:30" }],
      ["Tromsø Tuesday 00:30 is open on Monday's entry", tromso, "2026-10-12T22:30:00Z", { isOpen: true, today: "12:00–01:30" }],
      ["Tromsø Tuesday 01:29 is still open", tromso, "2026-10-12T23:29:00Z", { isOpen: true, today: "12:00–01:30" }],
      ["Tromsø Tuesday 01:30 is closed (the closing time is exclusive); today's entry is shown", tromso, "2026-10-12T23:30:00Z", { isOpen: false, today: "12:00–01:30" }],
      ["Tromsø Tuesday 02:00 is closed", tromso, "2026-10-13T00:00:00Z", { isOpen: false, today: "12:00–01:30" }],
      ["Tromsø Friday 21:00 is open", tromso, "2026-10-16T19:00:00Z", { isOpen: true, today: "12:00–03:00" }],
      ["Tromsø Saturday 02:59 is open on Friday's 12:00–03:00", tromso, "2026-10-17T00:59:00Z", { isOpen: true, today: "12:00–03:00" }],
      ["Tromsø Saturday 03:00 is closed", tromso, "2026-10-17T01:00:00Z", { isOpen: false, today: "12:00–03:00" }],
      ["Tromsø Sunday 17:00 is closed (Sunday opens 18:00)", tromso, "2026-10-18T15:00:00Z", { isOpen: false, today: "18:00–01:30" }],
      ["Tromsø Monday 01:00 is open on Sunday's 18:00–01:30 (over the week's end)", tromso, "2026-10-11T23:00:00Z", { isOpen: true, today: "18:00–01:30" }],
      ["Tromsø Tuesday 00:30 in winter time (UTC+1)", tromso, "2026-10-26T23:30:00Z", { isOpen: true, today: "12:00–01:30" }],
      ["Trondhjem Friday 21:00 is open (head before: \"Stengt 14:00–01:00\")", trondhjem, "2026-10-16T19:00:00Z", { isOpen: true, today: "14:00–01:00" }],
      ["Trondhjem Saturday 00:30 is open on Friday's entry", trondhjem, "2026-10-16T22:30:00Z", { isOpen: true, today: "14:00–01:00" }],
      ["Trondhjem Sunday 00:30 is open on Saturday's entry (no Sunday entry)", trondhjem, "2026-10-17T22:30:00Z", { isOpen: true, today: "12:00–01:00" }],
      ["Trondhjem Sunday 01:00 is closed, no entry today", trondhjem, "2026-10-17T23:00:00Z", { isOpen: false, today: null }],
      ["Trondhjem Monday 00:30 is closed: Sunday has no entry to run past midnight", trondhjem, "2026-10-18T22:30:00Z", { isOpen: false, today: "16:00–23:00" }],
      ["Trondhjem Tuesday 00:30 is closed: Monday closes 23:00", trondhjem, "2026-10-19T22:30:00Z", { isOpen: false, today: "16:00–23:00" }],
      ["a range past midnight: Fre–lør 20:00–02:00, Sunday 01:00 is open on Saturday's", [{ day: "Fre–lør", open: "20:00", close: "02:00" }], "2026-10-17T23:00:00Z", { isOpen: true, today: "20:00–02:00" }],
      ["a range past midnight: Friday 01:00 is closed (Thursday is not in it)", [{ day: "Fre–lør", open: "20:00", close: "02:00" }], "2026-10-15T23:00:00Z", { isOpen: false, today: "20:00–02:00" }],
      ["18:00–00:00 is open at 23:59", [{ day: "sat", open: "18:00", close: "00:00" }], "2026-10-17T21:59:00Z", { isOpen: true, today: "18:00–00:00" }],
      ["18:00–00:00 is closed at midnight", [{ day: "sat", open: "18:00", close: "00:00" }], "2026-10-17T22:00:00Z", { isOpen: false, today: null }],
    ] as Array<[string, unknown, string, unknown]>) {
      assertEq(label(status(hours, iso)), expected, `f past midnight: ${why}`);
    }
    // Equal times: "00:00–00:00" is closed all day to schema.org and open all
    // day elsewhere, so such an entry cannot say.
    assertEq(status([{ day: "sat", open: "00:00", close: "00:00" }], "2026-10-17T10:00:00Z"), null, "f no claim: only equal times (00:00–00:00)");
    assertEq(label(status([{ day: "sat", open: "10:00", close: "10:00" }, { day: "fri", open: "10:00", close: "17:00" }], "2026-10-17T10:00:00Z")),
      { isOpen: false, today: null }, "f equal times are ignored beside an entry that can say");
    assertEq(status([{ day: "sun", open: "closed", close: "closed" }], "2026-10-18T10:00:00Z"), null,
      "f no claim: only a closed day (\"closed\" in the time fields gives no times)");
    assertEq(label(status([{ day: "sun", open: "closed", close: "closed" }, { day: "mon", open: "10:00", close: "17:00" }], "2026-10-18T10:00:00Z")),
      { isOpen: false, today: null }, "f a closed day beside timed days is closed");
  }

  // ══ (g) the review's live sample: these producers now show their hours ══
  {
    // Stored values from GET /api/marketplace/agents/:id/card, 2026-10-17.
    const sample: Array<[string, unknown, string]> = [
      ["Røtter Frogner {day, hours}", [{ day: "Mandag-Fredag", hours: "10:00-19:00" }, { day: "Lørdag", hours: "11:00-18:00" }, { day: "Søndag", hours: "11:00-17:00" }],
        "Man–Fre 10:00–19:00, Lør 11:00–18:00, Søn 11:00–17:00"],
      ["Sognasmak {day, hours} with Stengt", [{ day: "Mandag", hours: "Stengt" }, { day: "Tysdag-Onsdag", hours: "10:00-16:00" }, { day: "Torsdag", hours: "10:00-17:00" }, { day: "Fredag-Laurdag", hours: "10:00-16:00" }, { day: "Søndag", hours: "12:00-18:00" }],
        "Man: Stengt, Tir–Ons 10:00–16:00, Tor 10:00–17:00, Fre–Lør 10:00–16:00, Søn 12:00–18:00"],
      ["Wiig Gartneri {day, hours}", [{ day: "Mandag-Fredag", hours: "09:00-18:00" }, { day: "Lørdag", hours: "09:00-16:00" }, { day: "Søndag", hours: "12:00-16:00" }],
        "Man–Fre 09:00–18:00, Lør 09:00–16:00, Søn 12:00–16:00"],
      ["Vilteksperten {day, hours}", [{ day: "Mandag-Fredag", hours: "07:00-15:30" }], "Man–Fre 07:00–15:30"],
      ["Tysnes Gårdsysteri {day, from, to}", [{ day: "Påske", from: "12:00", to: "18:00" }, { day: "Jun–aug (ons–søn)", from: "12:00", to: "18:00" }, { day: "Fre–lør (sesong)", from: "12:00", to: "20:00" }],
        "Påske 12:00–18:00, Jun–aug (ons–søn) 12:00–18:00, Fre–lør (sesong) 12:00–20:00"],
      ["Rånås Gård {day: by-appointment, note}", [{ day: "by-appointment", note: "Åpent etter avtale — ring eller send SMS" }], "Åpent etter avtale — ring eller send SMS"],
      ["Engøy Gjestegård {day: note, open}", [{ day: "note", open: "1. juli - 31. juli: Mandag-søndag 09:00-16:00" }], "1. juli - 31. juli: Mandag-søndag 09:00-16:00"],
      ["Ciderhuset Balestrand {period, days, open, close}", [{ period: "April", days: "Torsdag–Fredag", open: "12:00", close: "16:00" }, { period: "Mai–September", days: "Måndag–Laurdag", open: "12:00", close: "16:00" }, { period: "August", days: "Måndag–Laurdag", open: "12:00", close: "18:00" }],
        "Tor–Fre 12:00–16:00 (April), Man–Lør 12:00–16:00 (Mai–September), Man–Lør 12:00–18:00 (August)"],
      ["BesteFarHuset {days, open, close}", [{ days: "Torsdag", open: "13:00", close: "18:00" }, { days: "Søndag", open: "13:00", close: "18:00" }], "Tor 13:00–18:00, Søn 13:00–18:00"],
      ["Velure Gard {days: [...], open, close}", [{ days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "08:00", close: "18:00" }, { days: ["Saturday"], open: "09:00", close: "18:00" }],
        "Man–Fre 08:00–18:00, Lør 09:00–18:00"],
    ];
    for (const [name, hours, expected] of sample) {
      const entries = normalizeOpeningHours(hours);
      assertEq(entries.length, (hours as unknown[]).length, `g ${name}: every stored entry is read`);
      assertEq(openingHoursText(hours), expected, `g ${name}: its hours as text`);
    }
  }

  // ══ (h) I-J: schema.org's form and the byAppointment form ════════════
  {
    const n = normalizeOpeningHours;
    // Stored values from GET /api/marketplace/agents/:id/card, 2026-10-17
    // (main: no entries for either, so no hours card, no lokal_info line).
    const hovdneset = [{ dayOfWeek: "Friday", opens: "12:00", closes: "17:00", description: "Grønnsakstor på Rena torg – sesongutsalg, juli–oktober", validFrom: "2026-07-01", validThrough: "2026-10-31" }];
    const smaVesen = [{ description: "Utsalet i bryggeriet er ope på førespurnad – ring 476 82 708. Elles når det er annonsert på Facebook. Sjølvbetening frå kjøleskåp utanfor døra (alkoholfri drikke og ølglas), betal med Vipps.", byAppointment: true }];
    assertEq(n(hovdneset), [{
      days: [4], label: "Friday", open: "12:00", close: "17:00", period: "1.7.–31.10.2026",
      validFrom: "2026-07-01", validThrough: "2026-10-31", note: "Grønnsakstor på Rena torg – sesongutsalg, juli–oktober",
    }], "h Hovdneset Gård: Friday 12:00–17:00, the description as note, the validity as period and ISO dates (main: no entry)");
    // I-O: its note is about a season ("sesongutsalg"), so it is shown with the period (FUNN rfb-apningstider-sted-i-beskrivelse).
    assertEq(openingHoursText(hovdneset), "Fre 12:00–17:00 (1.7.–31.10.2026; Grønnsakstor på Rena torg – sesongutsalg, juli–oktober)",
      "h Hovdneset Gård as text: the period and the season note with the times (I-J: the note was left out)");
    const hovEntry = n(hovdneset)[0];
    assertEq(hovEntry && [entryDaysLabel(hovEntry, "no"), entryDaysLabel(hovEntry, "en")], ["Fredag", "Friday"],
      "h Hovdneset Gård: the day column is \"Fredag\", \"Friday\" on /en");
    assertEq(n(smaVesen), [{ days: [], label: "", note: `Etter avtale; ${smaVesen[0]!.description}` }],
      "h Små Vesen: one note-only entry, \"Etter avtale\" and the description (main: no entry)");
    assertEq(openingHoursText(smaVesen), `Etter avtale; ${smaVesen[0]!.description}`, "h Små Vesen as text");

    // dayOfWeek: a name in any case, schema.org's URI (https or http), a list; the same day tables as every other form.
    const day = (dayOfWeek: unknown) => n([{ dayOfWeek, opens: "10:00", closes: "14:00" }]).map((e) => [e.days, e.label]);
    assertEq(day("https://schema.org/Saturday"), [[[5], "Saturday"]], "h dayOfWeek: schema.org's URI is the day (the label is its name)");
    assertEq(day(" http://schema.org/Sunday "), [[[6], "Sunday"]], "h dayOfWeek: the http URI, trimmed");
    assertEq(day("HTTPS://SCHEMA.ORG/monday"), [[[0], "monday"]], "h dayOfWeek: the URI in any case");
    assertEq(day("friday"), [[[4], "friday"]], "h dayOfWeek: a name in lower case");
    assertEq(day("Fredag"), [[[4], "Fredag"]], "h dayOfWeek: a Norwegian name, as the other forms read it");
    assertEq(day(["Monday", "https://schema.org/Tuesday", "Wednesday"]), [[[0, 1, 2], "Monday, Tuesday, Wednesday"]], "h dayOfWeek: a list of names and URIs");
    assertEq(day("https://schema.org/PublicHolidays"), [[[], "PublicHolidays"]], "h dayOfWeek: a DayOfWeek that is no weekday is a label, shown as written");
    assertEq(day(["Monday", "https://schema.org/PublicHolidays"]), [[[], "Monday, PublicHolidays"]], "h dayOfWeek: a list with a name that is no weekday names none, as {days: [...]}");
    assertEq(day("https://example.org/Friday"), [[[], "https://example.org/Friday"]], "h dayOfWeek: another site's URI is no weekday");
    assertEq([day(5), day({ "@id": "https://schema.org/Friday" }), day([5, null])], [[[[], ""]], [[[], ""]], [[[], ""]]],
      "h dayOfWeek that is not text: no day, the times stay (as a day that is not text)");

    // opens/closes are the times by the rules of the other forms.
    assertEq(n([{ dayOfWeek: "Saturday", opens: 10, closes: 15 }]), [{ days: [5], label: "Saturday", open: "10", close: "15" }], "h opens/closes: numbers are their digits");
    assertEq(n([{ dayOfWeek: "Sunday", opens: "closed", closes: "closed" }]), [{ days: [6], label: "Sunday", note: "Stengt" }], "h opens/closes: \"closed\" is a closed day");
    assertEq(n([{ dayOfWeek: "Friday", opens: "12:00" }, { dayOfWeek: "Friday", closes: "17:00", validFrom: "2026-07-01", validThrough: "2026-10-31" }]), [],
      "h a lone time says nothing, and a period alone neither: left out, as {period}");
    assertEq(n([{ dayOfWeek: "Friday", description: "  Kun etter bestilling  " }]), [{ days: [4], label: "Friday", note: "Kun etter bestilling" }],
      "h description without times is a note-only entry for its day, trimmed");
    assertEq(n([{ dayOfWeek: "Friday", opens: "12:00", closes: "17:00", description: "   " }, { dayOfWeek: "Friday", opens: "12:00", closes: "17:00", description: 7 }]), [
      { days: [4], label: "Friday", open: "12:00", close: "17:00" }, { days: [4], label: "Friday", open: "12:00", close: "17:00" },
    ], "h a blank description, or one that is not text, is no note");
    assertEq(n([{ dayOfWeek: "Friday", opens: "12:00", closes: "17:00", open: "08:00", close: "09:00", note: "x", period: "April", hours: "01-02", day: "mon" }]),
      [{ days: [4], label: "Friday", open: "12:00", close: "17:00" }],
      "h an entry with dayOfWeek reads schema.org's keys only (not mixed with the generic ones)");

    // validFrom/validThrough as the period.
    const validity = (validFrom: unknown, validThrough: unknown) => {
      const e = n([{ dayOfWeek: "Friday", opens: "12:00", closes: "17:00", validFrom, validThrough }])[0];
      return e ? [e.period ?? null, e.validFrom ?? null, e.validThrough ?? null] : "no entry";
    };
    assertEq(validity("2026-07-01", "2026-10-31"), ["1.7.–31.10.2026", "2026-07-01", "2026-10-31"], "h validity: within one year, \"1.7.–31.10.2026\"");
    assertEq(validity("2026-11-01", "2027-03-31"), ["1.11.2026–31.3.2027", "2026-11-01", "2027-03-31"], "h validity: across a new year, both years");
    assertEq(validity("2026-12-24", "2026-12-24"), ["24.12.2026", "2026-12-24", "2026-12-24"], "h validity: one day");
    assertEq(validity(" 2026-07-01 ", "2026-10-31"), ["1.7.–31.10.2026", "2026-07-01", "2026-10-31"], "h validity: an ISO date is trimmed");
    assertEq(validity("2026-07-01", undefined), ["fra 1.7.2026", null, null], "h validity: only the first day, \"fra\"; no ISO dates (JSON-LD needs both)");
    assertEq(validity(null, "2026-10-31"), ["til 31.10.2026", null, null], "h validity: only the last day, \"til\"");
    assertEq(validity("juli", "oktober"), ["juli–oktober", null, null], "h validity: text that is no ISO date is shown as written");
    assertEq(validity("2026-07-01", "oktober"), ["1.7.2026–oktober", null, null], "h validity: one ISO date and one text");
    assertEq(validity("2026-02-30", "2026-10-31"), ["2026-02-30–31.10.2026", null, null], "h validity: a date that is not in the calendar is not an ISO date");
    assertEq(validity("2026-10-31", "2026-07-01"), ["31.10.2026–1.7.2026", null, null], "h validity: dates out of order are shown as written, with no ISO dates");
    assertEq([validity("2026-7-1", "2026-10-31"), validity("2026-07-01T00:00:00Z", "2026-10-31"), validity("0050-01-01", "2026-10-31")],
      [["2026-7-1–31.10.2026", null, null], ["2026-07-01T00:00:00Z–31.10.2026", null, null], ["0050-01-01–31.10.2026", null, null]],
      "h validity: only \"YYYY-MM-DD\" is an ISO date (no short form, no time; year 0050 is not read as 1950)");
    assertEq([validity(undefined, undefined), validity("", "  "), validity(20260701, { d: 1 })], [[null, null, null], [null, null, null], [null, null, null]],
      "h validity: none, blank or not text is no period");

    // byAppointment: true.
    assertEq(n([{ byAppointment: true }]), [{ days: [], label: "", note: "Etter avtale" }], "h byAppointment alone is \"Etter avtale\"");
    assertEq(n([{ byAppointment: true, description: "Åpent etter avtale — ring først" }, { byAppointment: true, description: "By appointment only" }]), [
      { days: [], label: "", note: "Åpent etter avtale — ring først" }, { days: [], label: "", note: "By appointment only" },
    ], "h byAppointment: a description that says so already is not prefixed (\"Etter avtale\" not said twice)");
    assertEq(n([{ byAppointment: true, description: "Ring først", note: "Vipps" }]), [{ days: [], label: "", note: "Etter avtale; Ring først; Vipps" }],
      "h byAppointment: the description, then a note");
    assertEq(n([{ byAppointment: true, dayOfWeek: "https://schema.org/Saturday", description: "Ring først" }]), [{ days: [5], label: "Saturday", note: "Etter avtale; Ring først" }],
      "h byAppointment in schema.org's form: by appointment on its day; the description once");
    assertEq(n([{ byAppointment: true, day: "by-appointment", note: "Ring eller send SMS" }]), [{ days: [], label: "", note: "Etter avtale; Ring eller send SMS" }],
      "h byAppointment with the by-appointment marker: the marker is not shown");
    for (const flag of [false, "true", 1, null, "yes"]) {
      assertEq(n([{ byAppointment: flag, description: "Ring først" }]), [], `h byAppointment ${JSON.stringify(flag)} is not the form: left out, as before I-J`);
    }

    // Parity: outside their forms, their keys are not read, so every form read before I-J reads as before.
    const declared = [{ day: "mon", open: "10:00", close: "17:00" }];
    assertEq(n([{ ...declared[0], description: "Grønnsakstor", validFrom: "2026-07-01", validThrough: "2026-10-31", opens: "08:00", closes: "09:00", byAppointment: false }]),
      n(declared), "h parity: {day, open, close} with description, validFrom/validThrough, opens/closes and byAppointment: false reads as {day, open, close}");
    assertEq(n([{ day: "by-appointment", note: "Åpent etter avtale — ring eller send SMS" }]), [{ days: [], label: "", note: "Åpent etter avtale — ring eller send SMS" }],
      "h parity: {day: by-appointment, note} is unchanged (no \"Etter avtale\" added)");
    assertEq(n([{ day: "sat", opens: "10:00", closes: "14:00" }, { description: "Selvbetjent" }, { validFrom: "2026-07-01", validThrough: "2026-10-31" }, { dayOfWeek: null, opens: "10:00", closes: "14:00" }]), [],
      "h parity: opens/closes, description or validity without dayOfWeek (or with dayOfWeek null) say nothing, as before I-J");

    // Neither form gives an "open now" claim: the period may not hold, and a note says no times.
    assertEq(openingStatusAt(n(hovdneset), new Date("2026-07-03T11:00:00Z")), null,
      "h open now: Hovdneset on a Friday at 13:00 in its season gives no claim (an entry with a period counts for none, as I-H)");
    assertEq(openingStatusAt(n(smaVesen), new Date("2026-07-03T11:00:00Z")), null, "h open now: Små Vesen gives no claim");
    assertEq(openingStatusAt(n([{ dayOfWeek: "Friday", opens: "12:00", closes: "17:00" }]), new Date("2026-07-03T11:00:00Z"))?.isOpen, true,
      "h open now: schema.org's form without validity counts as any timed entry (Friday 13:00 is open)");
  }

  // ══ (i) I-O: text in the day-and-time form, and season notes ═════════
  {
    const n = normalizeOpeningHours;
    const p = parseOpeningHoursText;
    const MF = [0, 1, 2, 3, 4];
    // Stored values from GET /api/marketplace/agents/:id/card, 2026-10-17.
    const hevd = "Man-Fre 07-22, Lor 08-22, Son 09-18";
    const almOstre = ["Fredag 14:00-18:00", "Lørdag 11:00-15:00"];
    assertEq(n(hevd), [
      { days: MF, label: "Man-Fre", open: "07:00", close: "22:00" },
      { days: [5], label: "Lor", open: "08:00", close: "22:00" },
      { days: [6], label: "Son", open: "09:00", close: "18:00" },
    ], "i Hevd: the whole field as text is three day rows, \"Lor\"/\"Son\" are Saturday/Sunday, times \"HH:MM\" (main: one text entry)");
    assertEq(n(almOstre), [
      { days: [4], label: "Fredag", open: "14:00", close: "18:00" },
      { days: [5], label: "Lørdag", open: "11:00", close: "15:00" },
    ], "i Alm Østre: each text entry of the list is a day row (main: two text entries)");
    assertEq(openingHoursText(hevd), "Man–Fre 07:00–22:00, Lør 08:00–22:00, Søn 09:00–18:00", "i Hevd as text: days and times (main: \"Man-Fre 07-22, Lor 08-22, Son 09-18\")");
    assertEq(openingHoursText(almOstre), "Fre 14:00–18:00, Lør 11:00–15:00", "i Alm Østre as text");

    // The form: any dash, spaces around it, dotted times, English and nynorsk days, every day, ø as "oe".
    const rows = (v: string) => (p(v) ?? []).map((e) => [e.days, e.label, e.open ?? null, e.close ?? null, e.note ?? null]);
    assertEq(rows("Mandag–fredag 10:00–20:00"), [[MF, "Mandag–fredag", "10:00", "20:00", null]], "i form: en dash in the days and the times (Tomtermais)");
    assertEq(rows("onsdag - søndag 11:00 — 17:00"), [[[2, 3, 4, 5, 6], "onsdag - søndag", "11:00", "17:00", null]], "i form: spaces around the dashes, an em dash");
    assertEq(rows("Lør 9.30-15"), [[[5], "Lør", "09:30", "15:00", null]], "i form: a dotted time and a bare hour are \"HH:MM\"");
    assertEq(rows("Mon-Thu 17:00-19:00"), [[[0, 1, 2, 3], "Mon-Thu", "17:00", "19:00", null]], "i form: English day names (Stanger Gård)");
    assertEq(rows("Daglig 06:00-22:00"), [[[0, 1, 2, 3, 4, 5, 6], "Daglig", "06:00", "22:00", null]], "i form: every day");
    assertEq(rows("Hver dag 10-17"), [[[0, 1, 2, 3, 4, 5, 6], "Hver dag", "10:00", "17:00", null]], "i form: a two-word day label");
    assertEq(rows("Man-Ons 11:00-15:00, Tor-Soen 12:00-21:00"), [[[0, 1, 2], "Man-Ons", "11:00", "15:00", null], [[3, 4, 5, 6], "Tor-Soen", "12:00", "21:00", null]],
      "i form: ø written as \"oe\" (\"Soen\", Kvarstad Sjokolade)");
    assertEq([parseDayLabel("Loer"), parseDayLabel("soendag"), parseDayLabel("Loerdag")], [[5], [6], [5]], "i day tables: \"loer\", \"soen\", \"loerdag\", \"soendag\"");
    assertEq(rows("Man-Søn 07:30-00:00"), [[[0, 1, 2, 3, 4, 5, 6], "Man-Søn", "07:30", "00:00", null]], "i form: closing at midnight is \"00:00\" (past midnight, as for every form)");
    assertEq(rows("Søn 00-24"), [[[6], "Søn", "00:00", "24:00", null]], "i form: 00–24");
    // A closed day ("Søn stengt", five producers in live data 2026-10-17).
    assertEq(rows("Man-Tor 09:00-15:30, Fre-Søn stengt"), [[[0, 1, 2, 3], "Man-Tor", "09:00", "15:30", null], [[4, 5, 6], "Fre-Søn", null, null, "Stengt"]],
      "i form: \"<days> stengt\" is a closed day, the note \"Stengt\" (Fagernes Kjøtt)");
    assertEq([rows("Søndag Stengt"), rows("Man closed"), rows("Lør stengd")], [[[[6], "Søndag", null, null, "Stengt"]], [[[0], "Man", null, null, "Stengt"]], [[[5], "Lør", null, null, "Stengt"]]],
      "i form: \"stengt\", \"closed\" and \"stengd\" in any case");
    assertEq(rows("  Man-Fre 09-17 ,  Lør 10-14  "), [[MF, "Man-Fre", "09:00", "17:00", null], [[5], "Lør", "10:00", "14:00", null]], "i form: spaces around the parts are trimmed");

    // Not the form: the whole text stays text, no part is guessed.
    for (const text of [
      "Man-Lør 12-17 (sommer)", "Fredag 15:00–18:00, lørdag 13:00–15:00 eller etter avtale", "Restaurant: Man-Lør 11-00. Marked: Man-Fre 10-17",
      "Gårdsbutikk: daglig 11-17", "Lørdager 10:00-14:00", "Tirsdag og Torsdag 15:00-18:00", "Juli-august: man-lør 12:00-16:00",
      "April: Torsdag-Fredag 10:00-16:00, Lørdag 10:00-15:00", "Man-Fre 09-17.", "Man-Fre 09-17,", "Man-Fre 09-17,, Lør 10-14", "Man 25-30",
      "Man 10:60-12", "Man-Fre 10-12-14", "Man-Fre 10-12, 14-16", "Påske 12-18", "constructor 10-12", "Varierer 16:00-17:00",
      "Man-Fre 10-17 og Lør 10-14", "Man stengt nå", "Stengt", "Man", "10-17", "Etter avtale", "Dognopent (00:00-23:59)",
      "Sommerkafé: søndager juni-september 11:00-17:00", "Lørdag 10–14 stengt", "", "   ", ",",
    ]) {
      assertEq(p(text), null, `i not the form: ${JSON.stringify(text)} is not read`);
    }
    assertEq(n("Man-Lør 12-17 (sommer)"), [{ days: [], label: "", note: "Man-Lør 12-17 (sommer)" }], "i not the form: the whole field stays one text entry, as before");
    // A part longer than 64 characters is not read (the longest in the form in live data has 26), and long text costs no time.
    assertEq([p(`Man-Fre${" ".repeat(52)}10-17`) !== null, p(`Man-Fre${" ".repeat(53)}10-17`)], [true, null], "i length: a part of 64 characters is read, one of 65 is not");
    {
      const t0 = Date.now();
      for (const v of [`a${" ".repeat(200_000)}x`, `a${" ".repeat(200_000)}1-`, `Man ${"1-".repeat(100_000)}`, `${"Man 10-17, ".repeat(20_000)}x`]) { p(v); n(v); }
      assertTrue(Date.now() - t0 < 1000, `i length: 200 000 characters of text are rejected fast (${Date.now() - t0} ms; without the limit a run of spaces backtracks in quadratic time)`);
    }
    assertEq(n(["Mandag–fredag 10:00–20:00", "Lørdag–søndag 10:00–17:00 (heile året)", "  ", { day: "sun", open: "12:00", close: "15:00" }]), [
      { days: MF, label: "Mandag–fredag", open: "10:00", close: "20:00" },
      { days: [], label: "", note: "Lørdag–søndag 10:00–17:00 (heile året)" },
      { days: [6], label: "sun", open: "12:00", close: "15:00" },
    ], "i a list: each text entry is read on its own (Tomtermais: the one with a qualifier stays text), in order with the other forms");
    assertEq(n(["Man-Fre 10-17, Lør 10-14"]), [
      { days: MF, label: "Man-Fre", open: "10:00", close: "17:00" }, { days: [5], label: "Lør", open: "10:00", close: "14:00" },
    ], "i a list: a text entry with commas gives a row per part");
    // "Open now" from text, at fixed clocks (2026-10-17 is a Saturday; Oslo is UTC+2).
    const status = (v: unknown, iso: string) => {
      const s = openingStatusAt(n(v), new Date(iso));
      return s && { isOpen: s.isOpen, today: s.today ? `${s.today.open}–${s.today.close}` : null };
    };
    assertEq(status(hevd, "2026-10-17T10:00:00Z"), { isOpen: true, today: "08:00–22:00" }, "i open now: Hevd on Saturday 12:00 is open (main: no claim)");
    assertEq(status(hevd, "2026-10-18T06:30:00Z"), { isOpen: false, today: "09:00–18:00" }, "i open now: Hevd on Sunday 08:30 is closed until 09:00");
    assertEq(status(almOstre, "2026-10-16T13:00:00Z"), { isOpen: true, today: "14:00–18:00" }, "i open now: Alm Østre on Friday 15:00 is open");
    assertEq(status("Man-Tor 09:00-15:30, Fre-Søn stengt", "2026-10-17T10:00:00Z"), { isOpen: false, today: null }, "i open now: a closed day from text is closed");

    // Season notes: the spec's examples and every season note in live data 2026-10-17 …
    for (const note of [
      "Sesongåpent til ca. 20. september", "Åkerbutikk i sommarsesongen", "Kun i sesong", "Stabbursbutikken i sesong",
      "Høgsesong juni til midten av august", "Sommersesong juni-august", "Sesongbasert — vanligvis mai til oktober. Sjekk lokale oppdateringer.",
      "Gårdsutsalg i sesong 16. september–22. desember", "Grønnsakstor på Rena torg – sesongutsalg, juli–oktober", "Vinteråpningstid. Ring for besøk utenom.",
      "Sommer. Jan-mars etter avtale", "Vintertid", "SESONG", "In season only", "Summer hours", "Winter hours", "Høstsalg", "Haustope", "Autumn only",
    ]) {
      assertTrue(isSeasonNote(note), `i season note: ${JSON.stringify(note)}`);
    }
    // … and none of the other notes there.
    for (const note of [
      "Selvbetjent 24/7", "Åpent året rundt og døgnet rundt", "Søndag stengt", "Annankvar torsdag (partalsveker)", "Kun selvbetjening",
      "Døgnåpen selvbetjent", "Utlevering skjer på avtalt tid og sted. Bestill via Facebook-gruppen.", "Ølutsalg i Bøgrend", "Selvbetjent Ostebua",
      "Lørdag og søndag stengt – men ring, så kommer vi hvis vi kan", "Døgnåpen nettbutikk — bestill når som helst", "Stengt", "Etter avtale",
      "Velkommen til vår gårdsbutikk", "Stengt 24.–26. desember", "Closed in July", "", "   ",
    ]) {
      assertTrue(!isSeasonNote(note), `i not a season note: ${JSON.stringify(note)}`);
    }
    assertTrue(!isSeasonNote(undefined), "i not a season note: none");
    assertTrue(SEASON_NOTE_WORDS.length > 0 && SEASON_NOTE_WORDS.every((w) => w === w.toLowerCase() && w.trim() === w && w.length >= 4),
      "i SEASON_NOTE_WORDS: lower case, trimmed, no short word that would match inside other words");
    assertTrue(!SEASON_NOTE_WORDS.includes("vår"), "i SEASON_NOTE_WORDS: not \"vår\" (also \"our\")");

    const bjorke = [{ days: "onsdag - søndag", hours: "11:00-17:00", note: "Sesongåpent til ca. 20. september" }];
    const hima = [{ day: "sat", open: "10:00", close: "14:00", note: "Åkerbutikk i sommarsesongen" }];
    const e = (v: unknown) => n(v)[0]!;
    assertEq([isSeasonalEntry(e(bjorke)), isSeasonalEntry(e(hima)), isSeasonalEntry(e([{ period: "April", day: "fri", open: "10:00", close: "12:00" }]))], [true, true, true],
      "i seasonal: a season note (Bjørke Gård, Hima Grønt) or a period");
    assertEq([isSeasonalEntry(e([{ day: "sat", open: "10:00", close: "14:00" }])), isSeasonalEntry(e([{ day: "sat", open: "10:00", close: "14:00", note: "Selvbetjent 24/7" }]))], [false, false],
      "i seasonal: not without a period or a season note");
    assertEq(n(bjorke), [{ days: [2, 3, 4, 5, 6], label: "onsdag - søndag", open: "11:00", close: "17:00", note: "Sesongåpent til ca. 20. september" }],
      "i seasonal: the entry itself is as before (no new field)");
    assertEq(openingHoursText(bjorke), "Ons–Søn 11:00–17:00 (Sesongåpent til ca. 20. september)", "i Bjørke Gård as text: the season note with the times (main: \"Ons–Søn 11:00–17:00\")");
    assertEq(openingHoursText(hima), "Lør 10:00–14:00 (Åkerbutikk i sommarsesongen)", "i Hima Grønt as text: the season note with the times (main: \"Lør 10:00–14:00\")");
    assertEq(openingHoursText([{ day: "sat", open: "10:00", close: "14:00", note: "Selvbetjent 24/7" }]), "Lør 10:00–14:00", "i text: another note on a timed entry is still left out, as before");
    assertEq(openingHoursText([{ days: "Torsdag", period: "Sommer", note: "Sesongvarer" }]), "Tor: Sommer; Sesongvarer", "i text: an entry without times shows its period and note, as before");
    assertEq(openingHoursText([{ period: "Mai–September", day: "sat", open: "10:00", close: "14:00", note: "Sommersalg" }]), "Lør 10:00–14:00 (Mai–September; Sommersalg)",
      "i text: a period and a season note, in that order");
    // No "open now" claim from a seasonal entry, also within the stated season (Wednesday 2026-09-16 13:00 in Oslo).
    assertEq(status(bjorke, "2026-09-16T11:00:00Z"), null, "i open now: Bjørke Gård gives no claim (main: \"Åpent nå\" on a Wednesday in October too)");
    assertEq(status(hima, "2026-10-17T10:00:00Z"), null, "i open now: Hima Grønt gives no claim on a Saturday (main: \"Åpent nå\")");
    assertEq(status([...hima, { day: "fri", open: "10:00", close: "17:00" }], "2026-10-17T10:00:00Z"), { isOpen: false, today: null },
      "i open now: beside a year-round entry only that one counts (Saturday: no entry, closed)");
    assertEq(status([{ day: "sat", open: "10:00", close: "14:00", note: "Selvbetjent" }], "2026-10-17T10:00:00Z"), { isOpen: true, today: "10:00–14:00" },
      "i open now: an entry with another note counts, as before");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/utils/opening-hours.test.ts`
if (require.main === module) {
  console.log("── opening-hours (I-H, I-J, I-O: one reading of opening hours) ──");
  const r = runOpeningHoursTests({ log: true });
  console.log(`\nopening-hours: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
