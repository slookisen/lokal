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
 *       {days, note}, {day: "note", open: <text>}); a lone time, wrong types
 *       and junk are left out; the declared form keeps its text.
 *   (d) the compact text of lokal_info and the auto-reply: the declared form
 *       as before ("Man 10:00–17:00", note left out), the other forms read.
 *   (e) the day and time in Norway (Europe/Oslo), across midnight and the
 *       summer-time change.
 *   (f) openingStatusAt: long and Norwegian day names and ranges are matched
 *       (Kringler Gjestegård, monday…saturday, said "Stengt" on Saturday
 *       noon); closing time is exclusive; split hours; entries that cannot say
 *       whether it is open (no weekday, a period, text, a time that is not a
 *       clock time) give no claim.
 *   (g) the producers of the review's live sample whose hours the page, or
 *       lokal_info and the auto-reply, did not show (their stored values,
 *       2026-10-17): each now has entries with its days and times or text.
 *
 * Exported runOpeningHoursTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/utils/opening-hours.test.ts
 */

import {
  normalizeOpeningHours,
  parseDayLabel,
  weekdaysLabel,
  entryDaysLabel,
  openingHoursEntryText,
  openingHoursText,
  osloWeekdayAndMinutes,
  openingStatusAt,
  timeMinutes,
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
    assertEq(n([{ day: "mon-fri", open: 10, close: 17 }, { day: "sun", open: 0, close: 24 }]), [
      { days: [0, 1, 2, 3, 4], label: "mon-fri", open: "10", close: "17" },
      { days: [6], label: "sun", open: "0", close: "24" },
    ], "c number times are their digits");
    assertEq(n(["  Lørdag 10–14 ", "", "  "]), [{ days: [], label: "", note: "Lørdag 10–14" }], "c a text entry is trimmed; blank ones are left out");
    assertEq(n("  Man–fre 10–17  "), [{ days: [], label: "", note: "Man–fre 10–17" }], "c free text for the whole field is one text entry, not parsed");
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
    assertEq(text([{ day: "mon", open: "10:00", close: "17:00" }, { day: "saturday", open: "10:00", close: "14:00", note: "Kun i sesong" }, { day: "Lørdag i sesong", open: "11:00", close: "15:00" }]),
      "Man 10:00–17:00, Lør 10:00–14:00, Lørdag i sesong 11:00–15:00",
      "d declared form as before: short day, the note left out, an unknown label as written");
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
    assertEq(text("  Man–fre 10–17  "), "Man–fre 10–17", "d free text for the whole field, trimmed");
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
      ["only text", ["Lørdag 10–14", { note: "Etter avtale" }]],
      ["only a number as day", [{ day: 5, open: "00:00", close: "24:00" }]],
      ["only times that are not clock times", [{ day: "sat", open: "<b>10</b>", close: "17:00" }]],
      ["free text for the whole field", "Man–søn 00–24"],
      ["no hours", []],
    ] as Array<[string, unknown]>) {
      assertEq(status(hours, "2026-10-17T10:00:00Z"), null, `f no claim: ${why}`);
    }
    assertEq(label(status([{ day: "Varierer", open: "00:00", close: "24:00" }, { day: "fri", open: "10:00", close: "17:00" }], "2026-10-17T10:00:00Z")),
      { isOpen: false, today: null }, "f an entry that cannot say is ignored beside one that can");
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

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/utils/opening-hours.test.ts`
if (require.main === module) {
  console.log("── opening-hours (I-H: one reading of opening hours) ──");
  const r = runOpeningHoursTests({ log: true });
  console.log(`\nopening-hours: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
