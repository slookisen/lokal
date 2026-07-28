/**
 * mapbox-budget.test.ts — Daniel, 2026-07-26:
 *   «ja, bygg månedstaket.»
 *
 * Context that shapes these tests: the session told Daniel to set a spending
 * cap in the Mapbox console and he came back with «jeg fant ingen måte å sette
 * pristak under billing». There is none — Mapbox offers usage ALERTS, not a
 * ceiling. So this module IS the guarantee, and a test suite that merely
 * exercises the happy path would leave that guarantee unproven.
 *
 *   mb1-mb6    the counter itself: persistence, the month boundary, and the
 *              refusal to increment past the cap
 *   mb7-mb11   cap resolution from the environment, including the one failure
 *              mode that costs money — a malformed cap must never mean
 *              "unlimited"
 *   mb12-mb18  cappedProvider: degrade, do not fail; cache misses only; and
 *              the capped straight line is DISTINGUISHABLE from the
 *              never-configured one
 *
 * MUTATION-TESTED. An independent reviewer ran 27 mutants against the first
 * version and SEVEN survived — including three that delete the money guarantee
 * outright while all 10 443 tests stay green. mb19-mb30 exist because of that
 * sweep, not because anyone read the code again.
 *
 * ONE accepted survivor remains, recorded rather than hidden: swapping
 * monthKey's `toISOString()` for local-time date methods is behaviourally
 * IDENTICAL under the runner's TZ=UTC, so no test on this runner can
 * distinguish them. The response was to remove the hazard from the code (the
 * ISO slice has no local-time variant to drift into) rather than to write a
 * test that would only fail in some other timezone.
 *
 * Exported runMapboxBudgetTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/mapbox-budget.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runMapboxBudgetTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      actual === expected,
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const prevCap = process.env.MAPBOX_MONTHLY_CALL_CAP;
    const db = new Database(":memory:");

    const budget = require("./mapbox-budget") as typeof import("./mapbox-budget");
    const corridor = require("./route-corridor-service") as typeof import("./route-corridor-service");

    // Fixed instants. Date.now() is never consulted by the code under test —
    // `now` is a parameter — so these tests cannot drift with the wall clock,
    // and the month-boundary case below is reachable at all.
    const JULY = Date.parse("2026-07-15T12:00:00Z");
    const AUGUST = Date.parse("2026-08-01T00:00:01Z");
    // A month no test has touched, so the kill-switch assertion below can
    // observe "no row was created" rather than "the row was already there".
    const SEPTEMBER = Date.parse("2026-09-10T09:00:00Z");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      // ═══════════════════════════════════════════════════════════════
      // mb1-mb6 — the counter
      // ═══════════════════════════════════════════════════════════════
      process.env.MAPBOX_MONTHLY_CALL_CAP = "3";

      assertEq(budget.monthKey(JULY), "2026-07", "mb1: month key is the UTC calendar month");
      // REVIEW N5: under TZ=UTC a getFullYear/getMonth mutant is invisible.
      // 2026-08-01T00:30Z is still 31 July in every negative-offset zone, so
      // this instant separates the UTC property from the local one whatever
      // the runner's TZ happens to be.
      assertEq(budget.monthKey(Date.parse("2026-08-01T00:30:00Z")), "2026-08",
        "mb1b: …UTC, not local — an instant that is still July in New York must count as August");

      // REVIEW N6: `exhausted` becomes load-bearing the moment a brief reads
      // it, so pin the BOUNDARY — at exactly `used === cap` it must be true.
      // The first attempt at this asserted `remaining === cap - used`, which is
      // literally the mutant, and so proved nothing.
      {
        const st = budget.mapboxBudgetState(JULY);
        assertEq(st.exhausted, false, "mb1c: a fresh month is not exhausted");
        assertEq(st.remaining, st.cap, "mb1d: …and its whole allowance is remaining");
      }
      assertEq(budget.mapboxBudgetState(JULY).used, 0, "mb2: a fresh month starts at zero");

      assertEq(budget.tryConsumeMapboxCall(JULY), true, "mb3: the first call is granted");
      budget.tryConsumeMapboxCall(JULY);
      budget.tryConsumeMapboxCall(JULY);
      assertEq(budget.mapboxBudgetState(JULY).used, 3, "mb4: …and each grant is counted");
      assertEq(budget.tryConsumeMapboxCall(JULY), false,
        "mb5: the call that would exceed the cap is REFUSED — this is the whole point of the module");
      assertEq(budget.mapboxBudgetState(JULY).used, 3,
        "mb5b: …and refusing does not increment, so `used` stays a truthful record of requests issued");

      // The month boundary. Without this the cap would be a lifetime limit.
      assertEq(budget.tryConsumeMapboxCall(AUGUST), true,
        "mb6: a new UTC month starts a fresh allowance");
      assertEq(budget.mapboxBudgetState(JULY).used, 3,
        "mb6b: …without disturbing July's record");

      // ═══════════════════════════════════════════════════════════════
      // mb7-mb11 — cap resolution. The failure mode here is money.
      // ═══════════════════════════════════════════════════════════════
      assertEq(budget.resolveMapboxMonthlyCap({ MAPBOX_MONTHLY_CALL_CAP: "500" } as any), 500,
        "mb7: an explicit cap is honoured");
      assertEq(budget.resolveMapboxMonthlyCap({} as any), budget.MAPBOX_MONTHLY_CAP_DEFAULT,
        "mb8: an unset cap falls back to the default, not to unlimited");
      assertEq(budget.resolveMapboxMonthlyCap({ MAPBOX_MONTHLY_CALL_CAP: "  " } as any),
        budget.MAPBOX_MONTHLY_CAP_DEFAULT, "mb9: …and so does a blank one");
      assertEq(budget.resolveMapboxMonthlyCap({ MAPBOX_MONTHLY_CALL_CAP: "tolv" } as any),
        budget.MAPBOX_MONTHLY_CAP_DEFAULT,
        "mb10: a MALFORMED cap must never be read as unlimited — the one failure mode that costs money");
      assertEq(budget.resolveMapboxMonthlyCap({ MAPBOX_MONTHLY_CALL_CAP: "-5" } as any),
        budget.MAPBOX_MONTHLY_CAP_DEFAULT, "mb11: …nor a negative one");

      // A cap of exactly zero is a deliberate kill switch, not a malformed
      // value, so it is honoured: no calls at all.
      process.env.MAPBOX_MONTHLY_CALL_CAP = "0";
      assertEq(budget.tryConsumeMapboxCall(SEPTEMBER), false,
        "mb11b: cap = 0 is an honoured kill switch — routing degrades, nothing is spent");
      // The early-out is not merely redundant with `WHERE calls < 0`: it also
      // means a kill-switched deployment stops touching the database at all.
      // SEPTEMBER is used because it has no row yet — asserting against a month
      // that already had one would pass whether or not the guard exists, which
      // is exactly how the first version of this assertion let a mutant live.
      assertEq(
        (db.prepare(`SELECT COUNT(*) AS c FROM mapbox_monthly_usage WHERE month = ?`).get("2026-09") as any).c,
        0,
        "mb11c: …and with the switch off it does not even create the month's row — no work at all");

      // ═══════════════════════════════════════════════════════════════
      // mb12-mb18 — cappedProvider: degrade, never fail
      // ═══════════════════════════════════════════════════════════════
      {
        let primaryCalls = 0;
        const primary = {
          id: "mapbox",
          kind: "road" as const,
          async fetchRoute() {
            primaryCalls++;
            return {
              polyline: [{ lat: 59.9, lng: 10.7 }, { lat: 67.2, lng: 14.4 }],
              distanceKm: 1194.7,
              durationMinutes: 987,
              provider: "mapbox",
              kind: "road" as const,
            };
          },
        };

        let allowance = 2;
        const consume = () => (allowance-- > 0);
        const capped = corridor.cappedProvider(primary as any, consume);

        const a = await capped.fetchRoute({ lat: 59.9, lng: 10.7 }, { lat: 67.2, lng: 14.4 });
        assertEq(a.kind, "road", "mb12: inside the allowance the real provider answers");
        assertEq(a.provider, "mapbox", "mb12b: …and says so");
        await capped.fetchRoute({ lat: 59.9, lng: 10.7 }, { lat: 67.2, lng: 14.4 });
        assertEq(primaryCalls, 2, "mb13: …once per call");

        // Third call: allowance gone.
        const c = await capped.fetchRoute({ lat: 59.9, lng: 10.7 }, { lat: 67.2, lng: 14.4 });
        assertEq(primaryCalls, 2,
          "mb14: past the cap the metered provider is NOT called — no request, no charge");
        assertEq(c.kind, "straight_line",
          "mb15: …and the caller still gets an answer, degraded rather than failed");
        assertEq(c.provider, corridor.CAPPED_STRAIGHT_LINE_PROVIDER,
          "mb16: …tagged so 'allowance used up' is distinguishable from 'never configured'");
        assertTrue(c.polyline.length >= 2, "mb17: …with a usable polyline, so ordering still works");

        // The tag must NOT be the plain straight-line provider's id, or the
        // note cannot tell the two situations apart.
        const plain = await corridor.straightLineProvider().fetchRoute(
          { lat: 59.9, lng: 10.7 }, { lat: 67.2, lng: 14.4 });
        assertTrue(plain.provider !== corridor.CAPPED_STRAIGHT_LINE_PROVIDER,
          "mb18: the never-configured straight line carries a DIFFERENT tag");
      }

      // ═══════════════════════════════════════════════════════════════
      // mb19-mb24 — THE PRODUCTION WIRING.
      //
      // An independent reviewer found that deleting the cap from the only
      // place production ever builds a Mapbox provider —
      //     return cappedProvider(mapboxProvider(token, fetchImpl), consume)
      //  →  return mapboxProvider(token, fetchImpl)
      // passed the focused suite, the corridor suite, the reise suite AND all
      // 10 443 tests. The only assertion touching that line checked
      // `resolveRouteProvider(...).id === "mapbox"`, and cappedProvider keeps
      // `id: primary.id` on purpose — so it was structurally incapable of
      // telling the wrapped provider from the naked one.
      //
      // With MAPBOX_ACCESS_TOKEN already live in Fly, that was one refactor
      // away from running uncapped in production with CI green. These tests
      // drive the REAL factory and count REAL outbound fetches.
      // ═══════════════════════════════════════════════════════════════
      {
        process.env.MAPBOX_MONTHLY_CALL_CAP = "2";
        budget.__resetMapboxBudgetSchemaForTesting();
        const NOV = Date.parse("2026-11-05T08:00:00Z");
        db.prepare(`DELETE FROM mapbox_monthly_usage`).run();

        let outbound = 0;
        const fakeFetch = (async () => {
          outbound++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              routes: [{
                geometry: { coordinates: [[10.75, 59.91], [14.4, 67.28]] },
                distance: 1_194_700,
                duration: 59_220,
              }],
            }),
          } as unknown as Response;
        }) as unknown as typeof fetch;

        // The REAL factory, with the REAL default consume closure — no seam.
        const provider = corridor.resolveRouteProvider(
          { ROUTING_PROVIDER: "mapbox", MAPBOX_ACCESS_TOKEN: "x" } as any,
          fakeFetch,
        );
        assertTrue(provider !== null, "mb19: a configured token still selects a provider");

        const p1 = await provider!.fetchRoute({ lat: 59.91, lng: 10.75 }, { lat: 67.28, lng: 14.4 });
        const p2 = await provider!.fetchRoute({ lat: 59.91, lng: 10.75 }, { lat: 67.28, lng: 14.4 });
        assertEq(p1.provider, "mapbox", "mb20: inside the allowance the real provider answers");
        assertEq(outbound, 2, "mb21: …and each call goes out exactly once");

        const p3 = await provider!.fetchRoute({ lat: 59.91, lng: 10.75 }, { lat: 67.28, lng: 14.4 });
        assertEq(outbound, 2,
          "mb22: PAST THE CAP NOTHING GOES OUT — this is the assertion that makes deleting cappedProvider() fail CI");
        assertEq(p3.provider, corridor.CAPPED_STRAIGHT_LINE_PROVIDER,
          "mb23: …and the caller gets the tagged straight line instead");

        // The default closure really charges the DB counter — mb12-mb18 only
        // ever injected their own consume, so this wire was never exercised.
        const row = db.prepare(`SELECT calls FROM mapbox_monthly_usage`).get() as any;
        assertEq(row?.calls, 2,
          "mb24: the DEFAULT consume closure charges the real counter — replacing it with () => true would leave this at 0");
      }

      // ═══════════════════════════════════════════════════════════════
      // mb25-mb26 — the default cap, asserted against something OTHER than
      // itself. Review B3: every existing assertion compared
      // resolveMapboxMonthlyCap(...) to MAPBOX_MONTHLY_CAP_DEFAULT, so raising
      // the constant to 800 000 — a default that GUARANTEES a bill — survived.
      // ═══════════════════════════════════════════════════════════════
      assertEq(budget.MAPBOX_MONTHLY_CAP_DEFAULT, 80_000,
        "mb25: the default cap is the literal 80 000, not merely 'whatever the constant says'");
      assertTrue(budget.MAPBOX_MONTHLY_CAP_DEFAULT < budget.MAPBOX_FREE_TIER_MONTHLY,
        "mb26: …and it sits BELOW the Mapbox free tier, so the cap bites before the bill does");
      // REVIEW N-a: mb26 compares two constants, so raising MAPBOX_FREE_TIER_MONTHLY
      // to 1 000 000 kept it green — the same self-referential shape B3 was. The
      // constant encodes an EXTERNAL vendor fact, so it gets the literal pin mb25 has.
      assertEq(budget.MAPBOX_FREE_TIER_MONTHLY, 100_000,
        "mb26b: the free tier is the literal 100 000 Mapbox actually grants — not whatever makes mb26 pass");

      // mb27 — the `exhausted` BOUNDARY. `used >= cap` vs `used > cap` differ
      // only at equality, which is exactly the state a brief would report on.
      {
        process.env.MAPBOX_MONTHLY_CALL_CAP = "2";
        const DEC = Date.parse("2026-12-03T10:00:00Z");
        db.prepare(`DELETE FROM mapbox_monthly_usage`).run();
        budget.tryConsumeMapboxCall(DEC);
        budget.tryConsumeMapboxCall(DEC);
        const st = budget.mapboxBudgetState(DEC);
        assertEq(st.used, 2, "mb27: …two of two spent");
        assertEq(st.exhausted, true,
          "mb27b: exhausted is TRUE at exactly used === cap, not only past it");
        assertEq(st.remaining, 0, "mb27c: …and nothing remains");
      }

      // mb27d — REVIEW N1: the exhaustion warning must fire ONCE per month,
      // not once per refused call. The reviewer's 5000-refusal probe emitted
      // 4950 log lines; once the cap bites the degraded path is the FAST path,
      // so nothing slows the traffic down.
      {
        process.env.MAPBOX_MONTHLY_CALL_CAP = "1";
        const FEB = Date.parse("2027-02-04T10:00:00Z");
        db.prepare(`DELETE FROM mapbox_monthly_usage`).run();
        const realWarn = console.warn;
        let warns = 0;
        console.warn = () => { warns++; };
        try {
          budget.tryConsumeMapboxCall(FEB);            // granted, no warning
          for (let i = 0; i < 50; i++) budget.tryConsumeMapboxCall(FEB);
        } finally {
          console.warn = realWarn;
        }
        assertEq(warns, 1,
          "mb27d: 50 refusals produce exactly ONE warning — the transition is the signal, not every call after it");
      }

      // ═══════════════════════════════════════════════════════════════
      // mb28-mb30 — REVIEW B4: the capped fallback must NOT be cached.
      //
      // cappedProvider keeps `id: primary.id`, so a cached capped result sits
      // under the MAPBOX cache key with a 24 h TTL. A trip requested in the
      // last hours of an exhausted month would keep serving a straight line —
      // under a note promising «ekte kjørerute er tilbake ved månedsskiftet» —
      // for up to 24 h INTO the new month, when real routing is available.
      // ═══════════════════════════════════════════════════════════════
      {
        corridor.__clearRouteCacheForTesting();
        const FROM = { lat: 59.91, lng: 10.75 };
        const TO = { lat: 67.28, lng: 14.4 };
        let allowance = 1;
        const primary = {
          id: "mapbox",
          kind: "road" as const,
          async fetchRoute() {
            return {
              polyline: [FROM, TO], distanceKm: 1194.7, durationMinutes: 987,
              provider: "mapbox", kind: "road" as const,
            };
          },
        };
        const capped = corridor.cappedProvider(primary as any, () => (allowance-- > 0));
        const NOW = Date.parse("2026-12-31T23:00:00Z");

        const r1 = await corridor.getPreparedRoute(capped as any, FROM, TO, undefined, NOW);
        assertEq(r1.route.provider, "mapbox", "mb28: the first trip is a real route…");
        assertTrue(
          corridor.__peekRouteCacheForTesting().length === 1,
          "mb28b: …and a real route IS cached");

        corridor.__clearRouteCacheForTesting();
        const r2 = await corridor.getPreparedRoute(capped as any, FROM, TO, undefined, NOW);
        assertEq(r2.route.provider, corridor.CAPPED_STRAIGHT_LINE_PROVIDER,
          "mb29: past the cap the same trip degrades…");
        assertEq(corridor.__peekRouteCacheForTesting().length, 0,
          "mb30: …and the degraded answer is NOT cached, so it cannot outlive the month it belongs to");
      }

      // ═══════════════════════════════════════════════════════════════
      // mb31 — REVIEW BL-2: cappedProvider must pass `via` THROUGH.
      //
      // The re-review found that dropping the third argument —
      //     return primary.fetchRoute(from, to, via)
      //  →  return primary.fetchRoute(from, to)
      // left all 263 deterministic tests green. `via` is a live query
      // parameter (reise-api.ts), and mapboxProvider builds its URL from
      // [from, ...via, to] — so the mutant silently returns the DIRECT
      // Oslo→Trondheim road for ?via=Lillehammer. Correct-looking JSON,
      // wrong road, no note, no error. The cache key includes `via`, so the
      // direct and the via-route occupy separate entries and BOTH lie.
      //
      // This wrapper is new in this PR and sits on the only path production
      // builds a Mapbox provider — structurally the same gap as B1.
      // ═══════════════════════════════════════════════════════════════
      {
        process.env.MAPBOX_MONTHLY_CALL_CAP = "5";
        budget.__resetMapboxBudgetSchemaForTesting();
        db.prepare(`DELETE FROM mapbox_monthly_usage`).run();

        let seenUrl = "";
        const urlCapturingFetch = (async (u: any) => {
          seenUrl = String(u);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              routes: [{
                geometry: { coordinates: [[10.75, 59.91], [10.47, 61.12], [10.4, 63.43]] },
                distance: 550_000,
                duration: 30_000,
              }],
            }),
          } as unknown as Response;
        }) as unknown as typeof fetch;

        const provider = corridor.resolveRouteProvider(
          { ROUTING_PROVIDER: "mapbox", MAPBOX_ACCESS_TOKEN: "x" } as any,
          urlCapturingFetch,
        );
        await provider!.fetchRoute(
          { lat: 59.91, lng: 10.75 },
          { lat: 63.43, lng: 10.40 },
          [{ lat: 61.12, lng: 10.47 }],          // Lillehammer
        );

        // Mapbox encodes waypoints as `lng,lat;lng,lat;…`, so a from→via→to
        // request carries exactly two separators. Dropping `via` leaves one.
        const coordPart = seenUrl.split("/directions/")[1]?.split("?")[0] ?? "";
        assertEq(coordPart.split(";").length, 3,
          "mb31: `via` reaches Mapbox through the cap wrapper — dropping the third argument would send the DIRECT route under the via-route's cache key");
      }

      // ═══════════════════════════════════════════════════════════════
      // mb32-mb35 — REVIEW BL-1: the two straight-line notes must stay
      // DISTINGUISHABLE.
      //
      // The distinct capped note is this PR's stated user-visible
      // deliverable and the whole justification for the B4 cache fix — and
      // it was pinned by nothing. Both deleting the ternary and INVERTING
      // it left 263/263 green. Inverted, an exhausted month says «vi har
      // ikke ekte kjørerute her» (so Daniel re-sets a token that was never
      // the problem) while a genuinely unconfigured install promises «ekte
      // kjørerute er tilbake ved månedsskiftet» — a promise that will never
      // come true, on the one install where routing was never set up.
      //
      // mb16/mb18/mb23 assert the provider TAG. Nothing asserted the tag
      // produces a different SENTENCE. Shipping B4's fix while the sentence
      // it protects is itself unpinned would repeat the finding at one remove.
      // ═══════════════════════════════════════════════════════════════
      {
        // corridorSearch takes PLACE NAMES and geocodes them; "Oslo"/"Bodø"
        // resolve from the curated tier, so this stays offline.
        const capped = corridor.cappedProvider(
          {
            id: "mapbox",
            kind: "road" as const,
            async fetchRoute() { throw new Error("primary must not be reached past the cap"); },
          } as any,
          () => false,                            // cap already exhausted
        );

        corridor.__clearRouteCacheForTesting();
        const cappedRun = await corridor.corridorSearch({ from: "Oslo", to: "Bodø", provider: capped as any });
        const cappedNotes = cappedRun.notes.join(" ");
        assertTrue(/kvote/.test(cappedNotes),
          "mb32: an exhausted month says the QUOTA is spent…");
        assertTrue(/månedsskiftet/.test(cappedNotes),
          "mb33: …and tells the visitor when real routing returns");
        assertTrue(!/Vi har ikke ekte kjørerute her/.test(cappedNotes),
          "mb34: …and never reuses the never-configured wording — that sends the operator hunting a token that was never the problem");

        // The CONTRAST case is what kills the inverted ternary. A plain
        // straight line — no cap involved — must NOT claim a spent quota,
        // because promising «ekte kjørerute er tilbake ved månedsskiftet» on
        // an install where routing was never configured is a promise that
        // will never come true. Asserting only the capped branch would leave
        // the inversion alive: it produces «kvote» too, just on the wrong side.
        corridor.__clearRouteCacheForTesting();
        const plainRun = await corridor.corridorSearch({
          from: "Oslo", to: "Bodø",
          provider: corridor.straightLineProvider() as any,
        });
        const plainNotes = plainRun.notes.join(" ");
        assertTrue(/Vi har ikke ekte kjørerute her/.test(plainNotes),
          "mb35: an unconfigured install says exactly that…");
        assertTrue(!/kvote/.test(plainNotes) && !/månedsskiftet/.test(plainNotes),
          "mb36: …and must NOT promise a month rollover that will never fix anything — this is the assertion that makes inverting the note ternary fail CI");
      }
    } finally {
      if (prevCap === undefined) delete process.env.MAPBOX_MONTHLY_CALL_CAP;
      else process.env.MAPBOX_MONTHLY_CALL_CAP = prevCap;
      budget.__resetMapboxBudgetSchemaForTesting();
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runMapboxBudgetTests({ log: true }).then((s) => {
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
