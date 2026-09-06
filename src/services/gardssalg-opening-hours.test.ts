/**
 * gardssalg-opening-hours.test.ts — unit tests for dev-request 2026-07-14-
 * booking-flyt-v1, "Slice 1 — myk åpningstidsvalidering" (Daniel-authorized
 * 2026-07-18): services/gardssalg-opening-hours.ts.
 *
 * Sections:
 *   A. parseOpeningHoursText — weekday range + time, single weekday + time,
 *      "alle dager"/no-weekday + time (-> all 7 days), both "-" and "til" as
 *      the range separator, both ":" and "." as the time separator, en-dash
 *      vs hyphen, unparseable garbage -> null, close<=open -> null, blank/
 *      null input -> null.
 *   B. isSlotWithinOpeningHours — true/false across a real day boundary
 *      (a UTC instant whose Oslo-local weekday differs from its UTC-date
 *      weekday), the closing-time-is-exclusive edge, and an unparseable
 *      slot failing OPEN.
 *   C. bookingMaxDaysAhead / slotBoundsError — default (90d), env override,
 *      past rejected, in-window accepted, just-beyond-window rejected,
 *      injectable `now`.
 *   D. checkBookingSlotAllowed — the shared choke point all 3 booking entry
 *      points call: hard bounds wins over soft hours, soft warning shape
 *      (200, outside_hours, echoes raw text), confirm_outside_hours bypass,
 *      no-usable-hours-text passthrough.
 *   E. gardssalgOpeningHoursCoverage — read-only stats, own scratch
 *      EXPERIENCES_DB_PATH (never the real DB), fresh require of db-factory
 *      per run (mirrors crm-platform-identity.test.ts's own scratch-DB
 *      guard rationale for this exact class of function).
 *
 * Pure, deterministic, no network. Section E is the only part that touches a
 * (throwaway, own-scratch-file) DB.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runGardssalgOpeningHoursTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  const mod = require("./gardssalg-opening-hours") as typeof import("./gardssalg-opening-hours");
  const {
    parseOpeningHoursText,
    isSlotWithinOpeningHours,
    slotBoundsError,
    bookingMaxDaysAhead,
    checkBookingSlotAllowed,
  } = mod;

  // ═══════════════════════════════════════════════════════════════════
  // A. parseOpeningHoursText
  // ═══════════════════════════════════════════════════════════════════

  // a1 — weekday range (full names) + colon time.
  {
    const p = parseOpeningHoursText("Åpent mandag-fredag 10:00-18:00");
    assertTrue(p !== null, "a1: 'mandag-fredag 10:00-18:00' parses");
    if (p) {
      assertEq([...p.days].sort(), [0, 1, 2, 3, 4], "a1b: days = Monday..Friday (0..4)");
      assertEq(p.openMin, 600, "a1c: openMin = 10:00 = 600");
      assertEq(p.closeMin, 1080, "a1d: closeMin = 18:00 = 1080");
    }
  }

  // a2 — weekday range (abbreviations) + bare-hour time, en-dash separator.
  {
    const p = parseOpeningHoursText("Man–fre 10–18");
    assertTrue(p !== null, "a2: 'Man–fre 10–18' (en-dash both places) parses");
    if (p) {
      assertEq([...p.days].sort(), [0, 1, 2, 3, 4], "a2b: abbreviation range days = Mon..Fri");
      assertEq(p.openMin, 600, "a2c: bare-hour open = 10:00");
      assertEq(p.closeMin, 1080, "a2d: bare-hour close = 18:00");
    }
  }

  // a3 — "til" as the weekday-range separator.
  {
    const p = parseOpeningHoursText("Tirsdag til lørdag 09.00-15.00");
    assertTrue(p !== null, "a3: 'tirsdag til lørdag' with period-time parses");
    if (p) {
      assertEq([...p.days].sort(), [1, 2, 3, 4, 5], "a3b: days = Tuesday..Saturday (1..5)");
      assertEq(p.openMin, 540, "a3c: 09.00 = 540");
      assertEq(p.closeMin, 900, "a3d: 15.00 = 900");
    }
  }

  // a4 — single weekday only -> that ONE day.
  {
    const p = parseOpeningHoursText("Lørdag 10-14");
    assertTrue(p !== null, "a4: 'Lørdag 10-14' parses");
    if (p) {
      assertEq([...p.days], [5], "a4b: single weekday -> {Saturday} only, not every day");
      assertEq(p.openMin, 600, "a4c: open 10:00");
      assertEq(p.closeMin, 840, "a4d: close 14:00");
    }
  }

  // a5 — no weekday named at all -> every day (the safe default for a SOFT check).
  {
    const p = parseOpeningHoursText("Åpningstider: 10:00-16:00 alle dager");
    assertTrue(p !== null, "a5: 'alle dager' (no weekday token) parses");
    if (p) {
      assertEq([...p.days].sort(), [0, 1, 2, 3, 4, 5, 6], "a5b: no weekday named -> ALL 7 days");
    }
  }

  // a6 — explicit list of individual weekday names (no range separator).
  {
    const p = parseOpeningHoursText("Mandag, onsdag og fredag 12-16");
    assertTrue(p !== null, "a6: an explicit list of individual weekdays parses");
    if (p) {
      assertEq([...p.days].sort(), [0, 2, 4], "a6b: days = exactly {Monday, Wednesday, Friday}");
    }
  }

  // a7 — unparseable garbage (no time pattern at all) -> null.
  assertEq(parseOpeningHoursText("Velkommen til gården vår, ring for avtale"), null,
    "a7: no time pattern anywhere -> null (fail open, not a guess)");

  // a8 — close <= open -> null, never guessed as an overnight wrap.
  assertEq(parseOpeningHoursText("Åpent 18:00-10:00 alle dager"), null,
    "a8: close (10:00) <= open (18:00) -> null, not treated as overnight");
  assertEq(parseOpeningHoursText("Åpent 10:00-10:00"), null,
    "a8b: close === open -> null too (zero-width window is not a real range)");

  // a9 — blank / null / undefined input.
  assertEq(parseOpeningHoursText(""), null, "a9: empty string -> null");
  assertEq(parseOpeningHoursText("   "), null, "a9b: whitespace-only -> null");
  assertEq(parseOpeningHoursText(null), null, "a9c: null -> null");
  assertEq(parseOpeningHoursText(undefined), null, "a9d: undefined -> null");

  // a10 — hyphen vs en-dash both work for the TIME separator too.
  {
    const pHyphen = parseOpeningHoursText("10:00-16:00");
    const pEnDash = parseOpeningHoursText("10:00–16:00");
    assertTrue(pHyphen !== null && pEnDash !== null, "a10: both '-' and '–' work as the time-range separator");
    if (pHyphen && pEnDash) {
      assertEq([pHyphen.openMin, pHyphen.closeMin], [pEnDash.openMin, pEnDash.closeMin],
        "a10b: identical parsed range regardless of dash style");
    }
  }

  // a11 — period ('.') as the time separator, mixed with a colon on the other side.
  {
    const p = parseOpeningHoursText("Onsdag 09.30-17:00");
    assertTrue(p !== null, "a11: mixed '.' / ':' time separators on either side of the dash parse");
    if (p) {
      assertEq(p.openMin, 9 * 60 + 30, "a11b: 09.30 = 570");
      assertEq(p.closeMin, 17 * 60, "a11c: 17:00 = 1020");
    }
  }

  // a12 — first occurrence wins when multiple time-like patterns appear.
  {
    const p = parseOpeningHoursText("Man-fre 10-18 (stengt i romjula 25-31 desember)");
    assertTrue(p !== null, "a12: parses despite a second digit-dash pattern later in the text");
    if (p) {
      assertEq(p.openMin, 600, "a12b: takes the FIRST time range (10-18), not the later 25-31");
      assertEq(p.closeMin, 1080, "a12c: …close = 18:00, not 31:00 (which would be invalid anyway)");
    }
  }

  // a13 — raw is preserved verbatim (trimmed).
  {
    const p = parseOpeningHoursText("  Lørdag 10-14  ");
    assertEq(p?.raw, "Lørdag 10-14", "a13: raw is the trimmed original snippet, echoable back to the guest");
  }

  // ═══════════════════════════════════════════════════════════════════
  // B. isSlotWithinOpeningHours
  // ═══════════════════════════════════════════════════════════════════

  {
    // Man-fre 10:00-18:00, all in Oslo local time.
    const p = parseOpeningHoursText("Man-fre 10:00-18:00")!;

    // 2026-08-17 is a Monday. 12:00 Oslo (CEST, UTC+2) = 10:00Z.
    assertTrue(
      isSlotWithinOpeningHours("2026-08-17T10:00:00.000Z", p),
      "b1: Monday 12:00 Oslo-local (within Man-fre 10-18) reads as WITHIN",
    );

    // Same Monday, 20:00 Oslo-local (18:00Z) — after closing.
    assertTrue(
      !isSlotWithinOpeningHours("2026-08-17T18:00:00.000Z", p),
      "b2: Monday 20:00 Oslo-local (after 18:00 close) reads as OUTSIDE",
    );

    // Closing time itself is EXCLUSIVE: exactly 18:00 Oslo-local (16:00Z) is outside.
    assertTrue(
      !isSlotWithinOpeningHours("2026-08-17T16:00:00.000Z", p),
      "b3: exactly AT closing time (18:00 Oslo-local) reads as OUTSIDE — close is exclusive",
    );

    // Opening time itself is inclusive: exactly 10:00 Oslo-local (08:00Z).
    assertTrue(
      isSlotWithinOpeningHours("2026-08-17T08:00:00.000Z", p),
      "b4: exactly AT opening time (10:00 Oslo-local) reads as WITHIN — open is inclusive",
    );

    // 2026-08-22 is a Saturday — not in Man-fre.
    assertTrue(
      !isSlotWithinOpeningHours("2026-08-22T10:00:00.000Z", p),
      "b5: Saturday, even at a normally-open hour, reads as OUTSIDE (Man-fre excludes it)",
    );

    // ── the day-boundary case: a UTC instant whose Oslo-LOCAL weekday
    // differs from its UTC-calendar-date weekday. 2026-08-17 23:30Z is
    // Tuesday 2026-08-18 01:30 in Oslo (CEST, UTC+2) — a different weekday
    // AND a different calendar date than the UTC instant's own date.
    assertTrue(
      !isSlotWithinOpeningHours("2026-08-17T23:30:00.000Z", p),
      "b6: 23:30 UTC Monday = 01:30 Oslo-local TUESDAY, but 01:30 is before the 10:00 open, so still OUTSIDE",
    );
    // Confirm the day genuinely rolled over by picking an in-hours instant
    // on the Oslo-local Tuesday side of that same UTC-Monday-night boundary.
    assertTrue(
      isSlotWithinOpeningHours("2026-08-17T09:00:00.000Z", p), // 11:00 Oslo Monday
      "b6b: sanity check — 09:00 UTC that Monday IS 11:00 Oslo-local Monday, within hours",
    );
    assertTrue(
      isSlotWithinOpeningHours("2026-08-18T09:00:00.000Z", p), // 11:00 Oslo Tuesday
      "b6c: …and the SAME 09:00 UTC one calendar day later is 11:00 Oslo-local Tuesday, also within hours — proves the day-boundary conversion, not just the hour math, is exercised",
    );

    // Unparseable instant fails OPEN (never a second, confusing error on
    // top of whatever already-invalid slot_at produced it).
    assertTrue(
      isSlotWithinOpeningHours("not-a-date", p),
      "b7: an unparseable slotAtIso fails OPEN (returns true) — slotBoundsError() is the gate for that, not this function",
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // C. bookingMaxDaysAhead / slotBoundsError
  // ═══════════════════════════════════════════════════════════════════

  {
    const prevEnv = process.env.BOOKING_MAX_DAYS_AHEAD;
    try {
      delete process.env.BOOKING_MAX_DAYS_AHEAD;
      assertEq(bookingMaxDaysAhead(), 90, "c1: default max-days-ahead is 90 when env unset");

      process.env.BOOKING_MAX_DAYS_AHEAD = "30";
      assertEq(bookingMaxDaysAhead(), 30, "c2: env override is honored");

      process.env.BOOKING_MAX_DAYS_AHEAD = "not-a-number";
      assertEq(bookingMaxDaysAhead(), 90, "c3: unparseable env falls back to 90");

      process.env.BOOKING_MAX_DAYS_AHEAD = "-5";
      assertEq(bookingMaxDaysAhead(), 90, "c4: a non-positive env value falls back to 90");

      process.env.BOOKING_MAX_DAYS_AHEAD = "0";
      assertEq(bookingMaxDaysAhead(), 90, "c4b: zero falls back to 90 too — 0 days ahead would ban every future slot");

      delete process.env.BOOKING_MAX_DAYS_AHEAD;
      const now = new Date("2026-08-17T12:00:00.000Z");

      assertEq(slotBoundsError("2026-08-17T13:00:00.000Z", 90, now), null,
        "c5: an hour in the future, well within the window -> null (allowed)");

      assertEq(slotBoundsError("2026-08-17T11:00:00.000Z", 90, now) !== null, true,
        "c6: an hour in the PAST -> rejected with a message");

      assertEq(slotBoundsError("2026-08-17T12:00:00.000Z", 90, now), null,
        "c6b: exactly `now` itself is not treated as past — the strict-less-than check only rejects instants BEFORE now");

      const in89Days = new Date(now.getTime() + 89 * 86400_000).toISOString();
      assertEq(slotBoundsError(in89Days, 90, now), null,
        "c7: 89 days ahead, within a 90-day window -> null (allowed)");

      const in91Days = new Date(now.getTime() + 91 * 86400_000).toISOString();
      assertEq(slotBoundsError(in91Days, 90, now) !== null, true,
        "c8: 91 days ahead, beyond a 90-day window -> rejected");

      // Custom maxDaysAhead argument (not just the env-derived default).
      const in10Days = new Date(now.getTime() + 10 * 86400_000).toISOString();
      assertEq(slotBoundsError(in10Days, 7, now) !== null, true,
        "c9: a custom maxDaysAhead=7 rejects a 10-day-out slot even though the env default (90) would allow it");
      assertEq(slotBoundsError(in10Days, 14, now), null,
        "c9b: …but a custom maxDaysAhead=14 allows that same 10-day-out slot");

      assertEq(slotBoundsError("not-a-date", 90, now) !== null, true,
        "c10: an unparseable slotAtIso itself is rejected (never silently treated as 'in the future')");
    } finally {
      if (prevEnv === undefined) delete process.env.BOOKING_MAX_DAYS_AHEAD;
      else process.env.BOOKING_MAX_DAYS_AHEAD = prevEnv;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // D. checkBookingSlotAllowed — the shared choke point
  // ═══════════════════════════════════════════════════════════════════

  {
    const now = new Date("2026-08-17T08:00:00.000Z"); // Monday 10:00 Oslo-local
    const inHoursProvider = { opening_hours_text: "Man-fre 10:00-18:00" };
    const noHoursProvider = { opening_hours_text: null };

    // d1 — hard bounds wins even over a provider with usable hours text.
    const past = checkBookingSlotAllowed(inHoursProvider, { slot_at: "2026-08-16T08:00:00.000Z" }, now);
    assertEq(past.ok, false, "d1: a past slot is rejected");
    if (!past.ok) {
      assertEq(past.status, 400, "d1b: …with a 400 (hard rule, not a soft warning)");
    }

    // d2 — within hours -> ok, no booking blocked.
    const within = checkBookingSlotAllowed(inHoursProvider, { slot_at: "2026-08-17T09:00:00.000Z" }, now); // 11:00 Oslo Monday
    assertEq(within, { ok: true }, "d2: a slot within the provider's stated hours -> {ok:true}");

    // d3 — outside hours, no confirm flag -> soft 200 warning, booking NOT created.
    const outside = checkBookingSlotAllowed(inHoursProvider, { slot_at: "2026-08-22T09:00:00.000Z" }, now); // Saturday
    assertEq(outside.ok, false, "d3: an outside-hours slot without confirm_outside_hours is refused");
    if (!outside.ok) {
      assertEq(outside.status, 200, "d3b: …but as a 200, not an error status — this is a soft warning, not a failure");
      const body = outside.body as any;
      assertEq(body.outside_hours, true, "d3c: body.outside_hours is true");
      assertEq(body.opening_hours_text, "Man-fre 10:00-18:00", "d3d: body echoes the provider's raw opening_hours_text");
      assertTrue(typeof body.message === "string" && body.message.length > 0, "d3e: body carries a human-readable Norwegian message");
    }

    // d4 — outside hours, WITH confirm_outside_hours:true -> proceeds.
    const confirmed = checkBookingSlotAllowed(
      inHoursProvider,
      { slot_at: "2026-08-22T09:00:00.000Z", confirm_outside_hours: true },
      now,
    );
    assertEq(confirmed, { ok: true }, "d4: confirm_outside_hours:true bypasses the soft warning and allows creation");

    // d5 — no usable opening_hours_text at all -> always proceeds (no data is not a block).
    const noText = checkBookingSlotAllowed(noHoursProvider, { slot_at: "2026-08-22T09:00:00.000Z" }, now);
    assertEq(noText, { ok: true }, "d5: a provider with no parseable opening_hours_text is never soft-blocked");

    // d6 — null/undefined provider entirely (e.g. an unknown provider_id
    // that already failed the booking_live gate upstream) must not throw.
    let threw = false;
    try {
      checkBookingSlotAllowed(null, { slot_at: "2026-08-17T09:00:00.000Z" }, now);
      checkBookingSlotAllowed(undefined, { slot_at: "2026-08-17T09:00:00.000Z" }, now);
    } catch {
      threw = true;
    }
    assertTrue(!threw, "d6: a null/undefined provider is handled without throwing");
  }

  // ═══════════════════════════════════════════════════════════════════
  // E. gardssalgOpeningHoursCoverage — own scratch DB, never the real one.
  // ═══════════════════════════════════════════════════════════════════

  {
    const os = require("os"), fsm = require("fs"), pathm = require("path");
    const scratchDir = fsm.mkdtempSync(pathm.join(os.tmpdir(), "goh-cov-"));
    const prevExpDb = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = pathm.join(scratchDir, "experiences.db");

    // Force a FRESH, MUTUALLY CONSISTENT pair of (db-factory,
    // gardssalg-opening-hours) module instances for this section, rather
    // than trusting the `mod` required at the top of this file. Some OTHER
    // test files elsewhere in this suite (e.g. admin-agent-audit-field-
    // provenance-legacy-shape*.test.ts) delete
    // require.cache[require.resolve("../database/db-factory")] as part of
    // their OWN cleanup — that forks the module going forward: this test
    // file's `mod` (gardssalg-opening-hours.ts, loaded far earlier in the
    // overall suite by opplevelser.ts et al., BEFORE any such delete) keeps
    // whatever db-factory instance it originally closed over, while a fresh
    // require() after the delete gets a brand-new one with its own empty
    // `handles` Map. Without re-aligning both here, seeding via one instance
    // and reading via gardssalgOpeningHoursCoverage()'s internal getDb() call
    // bound to the OTHER can silently diverge — measured live as
    // coverage.total reading 0 against a database this section had just
    // populated. Deleting+re-requiring BOTH, in this order, guarantees the
    // freshly-loaded gardssalg-opening-hours module's own `import { getDb }`
    // resolves to the SAME fresh db-factory instance `dbf` below uses.
    const dbFactoryPath = require.resolve("../database/db-factory");
    const openingHoursPath = require.resolve("./gardssalg-opening-hours");
    delete require.cache[dbFactoryPath];
    delete require.cache[openingHoursPath];
    const dbf = require("../database/db-factory") as any;
    const freshMod = require("./gardssalg-opening-hours") as typeof import("./gardssalg-opening-hours");
    dbf.__resetDbFactoryForTesting?.();

    // REVIEW-style guard, mirroring crm-platform-identity.test.ts's own
    // pi16i-guard: assert the redirect actually took BEFORE writing
    // anything, so a missing env line fails loudly here instead of quietly
    // reading/seeding the production experiences.db.
    assertTrue(
      String(process.env.EXPERIENCES_DB_PATH ?? "").startsWith(scratchDir),
      `e-guard: EXPERIENCES_DB_PATH points inside the scratch dir (${process.env.EXPERIENCES_DB_PATH}) — without this, gardssalgOpeningHoursCoverage() below would read the PRODUCTION experiences database`,
    );

    try {
      const db = dbf.getDb("experiences"); // triggers initExperiencesSchema on first open
      const seedRows: Array<[string, string | null]> = [
        ["p-1", "Man-fre 10:00-18:00"], // withText + parseable
        ["p-2", "Lørdag 10-14"],        // withText + parseable
        ["p-3", "Ring for avtale"],     // withText, NOT parseable (no time pattern)
        ["p-4", null],                  // no text
        ["p-5", ""],                    // blank text (must count as "no text", not "withText")
      ];
      for (const [id, text] of seedRows) {
        db.prepare(
          "INSERT OR REPLACE INTO experience_providers (id, navn, opening_hours_text) VALUES (?, ?, ?)",
        ).run(id, id, text);
      }

      const cov = freshMod.gardssalgOpeningHoursCoverage();
      assertEq(cov.total, seedRows.length, "e1: total counts every experience_providers row");
      assertEq(cov.withText, 3, "e2: withText counts the 3 non-blank opening_hours_text rows (blank string does NOT count)");
      assertEq(cov.parseable, 2, "e3: parseable counts only the 2 that parseOpeningHoursText() can actually read");
    } finally {
      try { dbf.getDb("experiences").close(); } catch { /* already closed */ }
      if (prevExpDb === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExpDb;
      dbf.__resetDbFactoryForTesting?.();
      delete require.cache[dbFactoryPath];
      delete require.cache[openingHoursPath];
      try { fsm.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  if (log) console.log(`\n${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  runGardssalgOpeningHoursTests({ log: true }).then((s) => {
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
